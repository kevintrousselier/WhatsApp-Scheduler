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

function localNow() {
  return new Date().toLocaleString('sv-SE', { timeZone: process.env.TZ || 'Europe/Paris' }).replace(' ', 'T');
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
    const { name } = req.body;
    const clean = (name || '').trim().replace(/^#/, '');
    if (!clean) return res.status(400).json({ error: 'Tag name required' });
    const tag = db.createTag(req.userId, clean);
    res.status(201).json(tag);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/tags/:id', requireUser, (req, res) => {
  try {
    const { name } = req.body;
    const clean = (name || '').trim().replace(/^#/, '');
    if (!clean) return res.status(400).json({ error: 'Tag name required' });
    const tag = db.renameTag(parseInt(req.params.id), req.userId, clean);
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
    const { groups, content, attachments, scheduled_at, send_now, notes, tags, mentions } = req.body;
    if (!groups || !groups.length) return res.status(400).json({ error: 'At least one recipient required' });
    if (!content && (!attachments || !attachments.length)) return res.status(400).json({ error: 'Content or attachments required' });

    const message = db.createMessage(req.userId, {
      groups, content: content || '', attachments: attachments || [],
      scheduled_at: send_now ? localNow() : scheduled_at,
      status: 'pending',
      notes: notes || '',
      tags: tags || [],
      mentions: mentions || [],
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

app.get('/api/messages/:id', requireUser, (req, res) => {
  const message = db.getMessageById(parseInt(req.params.id));
  if (!message || message.user_id !== req.userId) return res.status(404).json({ error: 'Message not found' });
  res.json(message);
});

app.put('/api/messages/:id', requireUser, (req, res) => {
  try {
    const { groups, content, attachments, scheduled_at, notes, tags, mentions } = req.body;
    const message = db.updateMessage(parseInt(req.params.id), req.userId, { groups, content, attachments, scheduled_at, notes, tags, mentions });
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
      attachments: message.attachments, scheduled_at: localNow(),
      notes: message.notes, tags: message.tags, mentions: message.mentions,
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
    const { title, content, variables, attachments } = req.body;
    if (!title || !content) return res.status(400).json({ error: 'Title and content required' });
    const template = db.createTemplate(req.userId, { title, content, variables, attachments });
    res.status(201).json(template);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/templates/:id', requireUser, (req, res) => {
  try {
    const { title, content, variables, attachments } = req.body;
    const template = db.updateTemplate(parseInt(req.params.id), req.userId, { title, content, variables, attachments });
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
  const csvHeader = 'Date,Groupe,Message,Statut,Erreur\n';
  const csvRows = rows.map((r) => {
    const content = (r.content || '').replace(/"/g, '""').substring(0, 200);
    const error = (r.error || '').replace(/"/g, '""');
    return `"${r.sent_at}","${r.group_name}","${content}","${r.status}","${error}"`;
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
