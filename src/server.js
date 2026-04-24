require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./database');
const waManager = require('./whatsapp');
const scheduler = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

function localNow(tz) {
  const zone = tz || process.env.TZ || 'Europe/Paris';
  return new Date().toLocaleString('sv-SE', { timeZone: zone }).replace(' ', 'T');
}

const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Multer — dynamic destination per user
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const userId = req.headers['x-user-id'];
      const dir = path.join(UPLOADS_DIR, String(userId));
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}-${file.originalname}`);
    },
  }),
  limits: { fileSize: 16 * 1024 * 1024 },
});

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// Middleware to extract userId (for /api/ routes except /api/users)
function requireUser(req, res, next) {
  const userId = parseInt(req.headers['x-user-id']);
  if (!userId) return res.status(400).json({ error: 'x-user-id header required' });
  const user = db.getUserById(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  req.userId = userId;
  next();
}

// --- SSE ---
const sseClients = new Map(); // userId -> Set<res>

app.get('/api/events', (req, res) => {
  const userId = parseInt(req.query.userId);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (userId) {
    if (!sseClients.has(userId)) sseClients.set(userId, new Set());
    sseClients.get(userId).add(res);
    req.on('close', () => sseClients.get(userId)?.delete(res));

    // Send current status
    const status = waManager.getClientStatus(userId);
    res.write(`data: ${JSON.stringify({ type: 'status', ...status })}\n\n`);
  }
});

function broadcastToUser(userId, data) {
  const clients = sseClients.get(userId);
  if (!clients) return;
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(msg);
  }
}

// Forward WhatsApp events to the right user
waManager.on('qr', ({ userId, qrCode }) => {
  broadcastToUser(userId, { type: 'qr', qrCode });
  broadcastToUser(userId, { type: 'status', status: 'qr', qrCode });
});
waManager.on('authenticated', ({ userId }) => {
  broadcastToUser(userId, { type: 'status', status: 'connecting', qrCode: null });
});
waManager.on('ready', ({ userId }) => {
  broadcastToUser(userId, { type: 'status', status: 'ready', qrCode: null });
});
waManager.on('disconnected', ({ userId }) => {
  broadcastToUser(userId, { type: 'status', status: 'disconnected', qrCode: null });
});
waManager.on('groups_updated', ({ userId }) => {
  broadcastToUser(userId, { type: 'groups_updated' });
});
waManager.on('contacts_updated', ({ userId }) => {
  broadcastToUser(userId, { type: 'contacts_updated' });
});

// --- Users ---
app.get('/api/users', (req, res) => {
  const users = db.getAllUsers();
  // Add WhatsApp status for each user
  const result = users.map((u) => ({
    ...u,
    waStatus: waManager.getClientStatus(u.id).status,
  }));
  res.json(result);
});

app.post('/api/users', (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
    const user = db.createUser(name.trim());
    // Initialize WhatsApp client for new user
    waManager.getOrCreateClient(user.id);
    res.status(201).json(user);
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Ce nom existe deja' });
    }
    res.status(500).json({ error: err.message });
  }
});

// App config (exposes non-secret config values like Maps API key)
app.get('/api/config', (req, res) => {
  res.json({
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
  });
});

// Return current user details (including timezone)
app.get('/api/users/me', requireUser, (req, res) => {
  const user = db.getUserById(req.userId);
  res.json(user);
});

app.put('/api/users/:id/timezone', requireUser, (req, res) => {
  const id = parseInt(req.params.id);
  if (id !== req.userId) return res.status(403).json({ error: 'Forbidden' });
  const { timezone } = req.body;
  if (!timezone) return res.status(400).json({ error: 'timezone required' });
  try {
    const user = db.setUserTimezone(id, timezone);
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/users/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  // Destroy WhatsApp client + session data
  await waManager.destroyClient(id);
  // Delete user uploads
  const userUploadsDir = path.join(UPLOADS_DIR, String(id));
  if (fs.existsSync(userUploadsDir)) {
    fs.rmSync(userUploadsDir, { recursive: true, force: true });
    console.log(`[Server] Deleted uploads for user ${id}`);
  }
  // Delete user from DB (cascades to messages, templates, send_log)
  const result = db.deleteUser(id);
  if (result.changes === 0) return res.status(404).json({ error: 'User not found' });
  res.json({ success: true });
});

// --- WhatsApp status (per user) ---
app.get('/api/status', requireUser, (req, res) => {
  res.json(waManager.getClientStatus(req.userId));
});

app.post('/api/connect', requireUser, async (req, res) => {
  try {
    await waManager.getOrCreateClient(req.userId);
    res.json({ success: true, message: 'Client initializing' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reconnect', requireUser, async (req, res) => {
  try {
    // Restart client without deleting session (allows auto-reconnect)
    await waManager.restartClient(req.userId);
    res.json({ success: true, message: 'Reconnecting...' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Groups & Contacts
app.get('/api/groups', requireUser, (req, res) => {
  const client = waManager.getClient(req.userId);
  res.json(client ? client.getGroups() : []);
});

app.get('/api/contacts', requireUser, (req, res) => {
  const client = waManager.getClient(req.userId);
  res.json(client ? client.getContacts() : []);
});

// Group participants (for @mentions)
app.get('/api/groups/:groupId/participants', requireUser, async (req, res) => {
  const client = waManager.getClient(req.userId);
  if (!client || client.getStatus().status !== 'ready') {
    return res.status(400).json({ error: 'WhatsApp client not ready' });
  }
  try {
    const participants = await client.getGroupParticipants(req.params.groupId);
    res.json(participants);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Tags ---
app.get('/api/tags', requireUser, (req, res) => {
  db.ensureTagsMigrated(req.userId);
  res.json(db.getAllTags(req.userId));
});

app.post('/api/tags', requireUser, (req, res) => {
  try {
    const { name, event_date } = req.body;
    const clean = (name || '').trim().replace(/^#/, '');
    if (!clean) return res.status(400).json({ error: 'Tag name required' });
    const tag = db.createTag(req.userId, clean, event_date || null);
    res.status(201).json(tag);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/tags/:id', requireUser, (req, res) => {
  try {
    const { name, event_date } = req.body;
    const patch = {};
    if (name !== undefined) patch.name = (name || '').trim().replace(/^#/, '');
    if (event_date !== undefined) patch.event_date = event_date || null;
    const tag = db.updateTag(parseInt(req.params.id), req.userId, patch);
    if (!tag) return res.status(404).json({ error: 'Tag not found' });
    res.json(tag);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/tags/:id', requireUser, (req, res) => {
  const r = db.deleteTag(parseInt(req.params.id), req.userId);
  if (r.changes === 0) return res.status(404).json({ error: 'Tag not found' });
  res.json({ success: true });
});

// Force refresh of groups and contacts from WhatsApp
app.post('/api/refresh', requireUser, async (req, res) => {
  const client = waManager.getClient(req.userId);
  if (!client || client.getStatus().status !== 'ready') {
    return res.status(400).json({ error: 'WhatsApp client not ready' });
  }
  try {
    await client.loadGroups();
    await client.loadContacts();
    res.json({
      success: true,
      groups: client.getGroups().length,
      contacts: client.getContacts().length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Messages ---
app.post('/api/messages', requireUser, (req, res) => {
  try {
    const { groups, content, attachments, scheduled_at, send_now, notes, tags, mentions, timezone, type, poll, location, recurrence } = req.body;
    if (!groups || !groups.length) return res.status(400).json({ error: 'At least one recipient required' });

    // Validate based on type
    const msgType = type || 'text';
    if (msgType === 'poll') {
      if (!poll || !poll.question || !Array.isArray(poll.options) || poll.options.length < 2) {
        return res.status(400).json({ error: 'Poll requires question and at least 2 options' });
      }
    } else if (msgType === 'location') {
      if (!location || typeof location.latitude !== 'number' || typeof location.longitude !== 'number') {
        return res.status(400).json({ error: 'Location requires latitude and longitude' });
      }
    } else {
      if (!content && (!attachments || !attachments.length)) return res.status(400).json({ error: 'Content or attachments required' });
    }

    const user = db.getUserById(req.userId);
    const tz = timezone || (user && user.timezone) || 'Europe/Paris';

    const message = db.createMessage(req.userId, {
      groups, content: content || '', attachments: attachments || [],
      scheduled_at: send_now ? localNow(tz) : scheduled_at,
      status: 'pending',
      notes: notes || '',
      tags: tags || [],
      mentions: mentions || [],
      timezone: tz,
      type: msgType,
      poll: poll || null,
      location: location || null,
      recurrence: recurrence || null,
    });

    if (send_now) {
      scheduler.processDueMessages().catch(console.error);
    }
    res.status(201).json(message);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/messages', requireUser, (req, res) => {
  res.json(db.getPendingMessages(req.userId));
});

// --- Batch messages (J-7, J-3, J-1, Day J, etc.) ---
app.post('/api/messages/batch', requireUser, (req, res) => {
  try {
    const { groups, content, attachments, notes, tags, mentions, timezone, type, poll, location, recurrence, referenceDate, offsets } = req.body;
    if (!groups || !groups.length) return res.status(400).json({ error: 'At least one recipient required' });
    if (!referenceDate) return res.status(400).json({ error: 'referenceDate required' });
    if (!Array.isArray(offsets) || offsets.length === 0) return res.status(400).json({ error: 'offsets array required' });

    const user = db.getUserById(req.userId);
    const tz = timezone || (user && user.timezone) || 'Europe/Paris';
    const batchId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const created = [];

    // referenceDate expected as YYYY-MM-DDTHH:MM (local time in tz)
    const m = String(referenceDate).match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
    if (!m) return res.status(400).json({ error: 'Invalid referenceDate format (expected YYYY-MM-DDTHH:MM)' });
    const refY = parseInt(m[1]), refMo = parseInt(m[2]) - 1, refD = parseInt(m[3]);
    const refH = m[4], refMi = m[5];

    for (const off of offsets) {
      const daysOffset = parseInt(off.days || 0);
      const customTime = off.time; // "HH:MM" optional, else use reference time
      const dt = new Date(Date.UTC(refY, refMo, refD));
      dt.setUTCDate(dt.getUTCDate() + daysOffset);
      const y = dt.getUTCFullYear(), mo = String(dt.getUTCMonth() + 1).padStart(2, '0'), d = String(dt.getUTCDate()).padStart(2, '0');
      const t = customTime || `${refH}:${refMi}`;
      const scheduled = `${y}-${mo}-${d}T${t}`;

      const msg = db.createMessage(req.userId, {
        groups,
        content: content || '',
        attachments: attachments || [],
        scheduled_at: scheduled,
        status: 'pending',
        notes: notes || '',
        tags: tags || [],
        mentions: mentions || [],
        timezone: tz,
        type: type || 'text',
        poll: poll || null,
        location: location || null,
        recurrence: recurrence || null,
        batch_group_id: batchId,
      });
      created.push(msg);
    }

    res.status(201).json({ batch_group_id: batchId, count: created.length, messages: created });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Retry a failed message from history ---
app.post('/api/history/:sendLogId/retry', requireUser, async (req, res) => {
  try {
    const logId = parseInt(req.params.sendLogId);
    const history = db.getHistory(req.userId);
    const entry = history.find(h => h.id === logId);
    if (!entry) return res.status(404).json({ error: 'Entry not found' });

    const user = db.getUserById(req.userId);
    const tz = entry.timezone || (user && user.timezone) || 'Europe/Paris';

    const msg = db.createMessage(req.userId, {
      groups: [{ id: entry.group_id, name: entry.group_name }],
      content: entry.content || '',
      attachments: entry.attachments || [],
      scheduled_at: localNow(tz),
      status: 'pending',
      notes: entry.notes || '',
      tags: entry.tags || [],
      timezone: tz,
      type: entry.type || 'text',
      poll: entry.poll || null,
      location: entry.location || null,
    });
    scheduler.processDueMessages().catch(console.error);
    res.json({ success: true, message: msg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Drafts ---
app.get('/api/drafts', requireUser, (req, res) => {
  res.json(db.getDrafts(req.userId));
});

app.post('/api/drafts', requireUser, (req, res) => {
  try {
    const { groups, content, attachments, notes, tags, mentions, timezone, type, poll, location, recurrence } = req.body;
    const user = db.getUserById(req.userId);
    const tz = timezone || (user && user.timezone) || 'Europe/Paris';
    const msg = db.createMessage(req.userId, {
      groups: groups || [],
      content: content || '',
      attachments: attachments || [],
      scheduled_at: null,
      status: 'draft',
      notes: notes || '',
      tags: tags || [],
      mentions: mentions || [],
      timezone: tz,
      type: type || 'text',
      poll: poll || null,
      location: location || null,
      recurrence: recurrence || null,
    });
    res.status(201).json(msg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/drafts/:id', requireUser, (req, res) => {
  try {
    const { groups, content, attachments, notes, tags, mentions, timezone, type, poll, location, recurrence } = req.body;
    // Reuse updateMessage which handles both draft and pending statuses now
    const msg = db.updateMessage(parseInt(req.params.id), req.userId, { groups, content, attachments, scheduled_at: null, notes, tags, mentions, timezone, type, poll, location, recurrence });
    if (!msg) return res.status(404).json({ error: 'Draft not found' });
    res.json(msg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/drafts/:id', requireUser, (req, res) => {
  const r = db.deleteDraft(parseInt(req.params.id), req.userId);
  if (r.changes === 0) return res.status(404).json({ error: 'Draft not found' });
  res.json({ success: true });
});

// Promote a draft to pending (schedule or immediate)
app.post('/api/drafts/:id/promote', requireUser, (req, res) => {
  try {
    const { scheduled_at, send_now } = req.body;
    const draft = db.getMessageById(parseInt(req.params.id));
    const tz = (draft && draft.timezone) || 'Europe/Paris';
    const when = send_now ? localNow(tz) : scheduled_at;
    if (!when) return res.status(400).json({ error: 'scheduled_at or send_now required' });
    const msg = db.promoteDraft(parseInt(req.params.id), req.userId, when);
    if (!msg) return res.status(404).json({ error: 'Draft not found' });
    if (send_now) scheduler.processDueMessages().catch(console.error);
    res.json(msg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/messages/:id', requireUser, (req, res) => {
  const message = db.getMessageById(parseInt(req.params.id));
  if (!message || message.user_id !== req.userId) return res.status(404).json({ error: 'Message not found' });
  res.json(message);
});

app.put('/api/messages/:id', requireUser, (req, res) => {
  try {
    const { groups, content, attachments, scheduled_at, notes, tags, mentions, timezone, type, poll, location, recurrence } = req.body;
    const message = db.updateMessage(parseInt(req.params.id), req.userId, { groups, content, attachments, scheduled_at, notes, tags, mentions, timezone, type, poll, location, recurrence });
    if (!message) return res.status(404).json({ error: 'Message not found or already sent' });
    res.json(message);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/messages/:id', requireUser, (req, res) => {
  const result = db.deleteMessage(parseInt(req.params.id), req.userId);
  if (result.changes === 0) return res.status(404).json({ error: 'Message not found or already sent' });
  res.json({ success: true });
});

app.post('/api/messages/:id/send', requireUser, async (req, res) => {
  try {
    const message = db.getMessageById(parseInt(req.params.id));
    if (!message || message.user_id !== req.userId) return res.status(404).json({ error: 'Message not found' });
    if (message.status !== 'pending') return res.status(400).json({ error: 'Message already processed' });
    db.updateMessage(message.id, req.userId, {
      groups: message.groups, content: message.content,
      attachments: message.attachments, scheduled_at: localNow(message.timezone),
      notes: message.notes, tags: message.tags, mentions: message.mentions, timezone: message.timezone,
    });
    scheduler.processDueMessages().catch(console.error);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Templates ---
app.get('/api/templates', requireUser, (req, res) => {
  res.json(db.getAllTemplates(req.userId));
});

app.post('/api/templates', requireUser, (req, res) => {
  try {
    const { title, content, variables, attachments, mentions, tags, notes, timezone, type, poll, location, recurrence } = req.body;
    if (!title) return res.status(400).json({ error: 'Title required' });
    const template = db.createTemplate(req.userId, { title, content: content || '', variables, attachments, mentions, tags, notes, timezone, type, poll, location, recurrence });
    res.status(201).json(template);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/templates/:id', requireUser, (req, res) => {
  try {
    const { title, content, variables, attachments, mentions, tags, notes, timezone, type, poll, location, recurrence } = req.body;
    const template = db.updateTemplate(parseInt(req.params.id), req.userId, { title, content, variables, attachments, mentions, tags, notes, timezone, type, poll, location, recurrence });
    if (!template) return res.status(404).json({ error: 'Template not found' });
    res.json(template);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/templates/:id', requireUser, (req, res) => {
  const result = db.deleteTemplate(parseInt(req.params.id), req.userId);
  if (result.changes === 0) return res.status(404).json({ error: 'Template not found' });
  res.json({ success: true });
});

// --- History ---
app.get('/api/history', requireUser, (req, res) => {
  const { status, group_name, date_from, date_to } = req.query;
  res.json(db.getHistory(req.userId, { status, group_name, date_from, date_to }));
});

app.get('/api/history/export', (req, res) => {
  // Support both header and query param for userId (export opens in new tab)
  const userId = parseInt(req.headers['x-user-id'] || req.query._userId);
  if (!userId) return res.status(400).json({ error: 'User ID required' });
  req.userId = userId;
  const { status, group_name, date_from, date_to } = req.query;
  const rows = db.getHistory(req.userId, { status, group_name, date_from, date_to });
  const csvHeader = 'Date,Fuseau,Groupe,Message,Statut,Erreur\n';
  const csvRows = rows.map((r) => {
    const content = (r.content || '').replace(/"/g, '""').substring(0, 200);
    const error = (r.error || '').replace(/"/g, '""');
    const tz = r.timezone || 'Europe/Paris';
    return `"${r.sent_at}","${tz}","${r.group_name}","${content}","${r.status}","${error}"`;
  }).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=historique-envois.csv');
  res.send('\uFEFF' + csvHeader + csvRows);
});

// --- File upload ---
app.post('/api/upload', requireUser, upload.array('files', 10), (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });
  const files = req.files.map((f) => ({
    filename: f.filename, originalname: f.originalname, size: f.size, mimetype: f.mimetype,
  }));
  res.json(files);
});

// Upload + convert audio to ogg/opus for WhatsApp voice message
const { exec } = require('child_process');
app.post('/api/upload-audio', requireUser, upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file' });
  const userDir = path.join(UPLOADS_DIR, String(req.userId));
  const inputPath = req.file.path;
  const outputName = `${Date.now()}-voice.ogg`;
  const outputPath = path.join(userDir, outputName);
  // Convert to ogg/opus mono 48kHz (WhatsApp voice format)
  const cmd = `ffmpeg -y -i "${inputPath}" -c:a libopus -b:a 64k -ac 1 -ar 48000 "${outputPath}"`;
  exec(cmd, { timeout: 60000 }, (err) => {
    try { fs.unlinkSync(inputPath); } catch (_) {}
    if (err) {
      console.error('[Audio] ffmpeg error:', err.message);
      return res.status(500).json({ error: 'Audio conversion failed' });
    }
    const stat = fs.statSync(outputPath);
    res.json({
      filename: outputName,
      originalname: 'voice-message.ogg',
      size: stat.size,
      mimetype: 'audio/ogg',
      voice: true,
    });
  });
});

// --- Start ---
async function start() {
  await db.init();
  console.log('[Server] Database ready');

  // Don't initialize all WhatsApp clients at startup — too resource heavy.
  // Clients are initialized on-demand when a user connects via /api/connect.

  scheduler.start();

  app.listen(PORT, () => {
    console.log(`[Server] Running at http://localhost:${PORT}`);
  });
}

start();
