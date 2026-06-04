const { Client, LocalAuth, MessageMedia, Poll, Location } = require('whatsapp-web.js');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

class WhatsAppClient extends EventEmitter {
  constructor(userId) {
    super();
    this.userId = userId;
    this.client = null;
    this.status = 'disconnected';
    this.qrCode = null;
    this.groups = [];
    this.contacts = [];
    this.contactsLoaded = false;
    this.contactsLoading = false;
    this.destroyed = false;
    this.lastActivityAt = Date.now();
    this._readyResolvers = [];
  }

  touchActivity() {
    this.lastActivityAt = Date.now();
  }

  isIdle(maxIdleMs) {
    return (Date.now() - this.lastActivityAt) > maxIdleMs;
  }

  // Wait until status is qr|ready|disconnected (with reason!=destroyed) or timeout
  waitUntilStable(timeoutMs = 30000) {
    return new Promise((resolve) => {
      if (this.destroyed) return resolve(this.status);
      if (this.status === 'qr' || this.status === 'ready' || this.status === 'disconnected') {
        return resolve(this.status);
      }
      const timer = setTimeout(() => {
        this._readyResolvers = this._readyResolvers.filter(r => r !== resolveOnce);
        resolve(this.status);
      }, timeoutMs);
      const resolveOnce = (s) => {
        clearTimeout(timer);
        resolve(s);
      };
      this._readyResolvers.push(resolveOnce);
    });
  }

  _resolveWaiters() {
    const waiters = this._readyResolvers;
    this._readyResolvers = [];
    waiters.forEach(r => r(this.status));
  }

  async initialize() {
    this.status = 'connecting';

    const sessionPath = path.join(__dirname, '..', 'data', 'whatsapp-sessions', String(this.userId));
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    this._cleanLocks(sessionPath);

    const puppeteerOpts = {
      headless: true,
      protocolTimeout: 360000,
      timeout: 180000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-software-rasterizer',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
      ],
    };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      puppeteerOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    this.client = new Client({
      authStrategy: new LocalAuth({ clientId: `user-${this.userId}`, dataPath: sessionPath }),
      puppeteer: puppeteerOpts,
      // Use whatsapp-web.js's known-good WhatsApp Web version (avoids breakage when WA updates their JS)
      webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1027172658-alpha.html',
      },
    });

    this.client.on('qr', (qr) => {
      this.status = 'qr';
      this.qrCode = qr;
      this.emit('qr', { userId: this.userId, qrCode: qr });
      console.log(`[WhatsApp:${this.userId}] QR code received`);
      this._resolveWaiters();
    });

    this.client.on('authenticated', () => {
      this.status = 'connecting';
      this.qrCode = null;
      this.emit('authenticated', { userId: this.userId });
      console.log(`[WhatsApp:${this.userId}] Authenticated`);
    });

    this.client.on('ready', async () => {
      this.status = 'ready';
      this.qrCode = null;
      console.log(`[WhatsApp:${this.userId}] Client ready`);
      // Load groups (fast). Contacts are LAZY (loaded on demand).
      try {
        await this.loadGroups();
      } catch (e) {
        console.warn(`[WhatsApp:${this.userId}] loadGroups error (non-blocking):`, e.message);
      }
      this.emit('ready', { userId: this.userId });
      this._resolveWaiters();
    });

    this.client.on('disconnected', (reason) => {
      this.status = 'disconnected';
      console.log(`[WhatsApp:${this.userId}] Disconnected:`, reason);
      this.emit('disconnected', { userId: this.userId, reason });
      this._resolveWaiters();
      // No more auto-reconnect — let user trigger reconnection explicitly via /api/reconnect
      // This avoids race with scheduler retries
    });

    this.client.on('auth_failure', (msg) => {
      this.status = 'disconnected';
      console.error(`[WhatsApp:${this.userId}] Auth failure:`, msg);
      this.emit('auth_failure', { userId: this.userId, msg });
      this._resolveWaiters();
    });

    // Instant sync via WhatsApp events (only groups; contacts are lazy)
    const onGroupsChanged = () => {
      this.loadGroups().then(() => this.emit('groups_updated', { userId: this.userId })).catch(() => {});
    };
    this.client.on('group_join', onGroupsChanged);
    this.client.on('group_leave', onGroupsChanged);
    this.client.on('group_update', onGroupsChanged);

    // Initialize with timeout protection
    const initPromise = this.client.initialize();
    return Promise.race([
      initPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('initialize() timeout 180s')), 180000)),
    ]).catch((err) => {
      console.error(`[WhatsApp:${this.userId}] initialize failed:`, err.message);
      this.status = 'disconnected';
      this._resolveWaiters();
      throw err;
    });
  }

  async loadGroups() {
    this.touchActivity();
    const chats = await this.client.getChats();
    this.groups = chats
      .filter((chat) => chat.isGroup)
      .map((chat) => ({
        id: chat.id._serialized,
        name: chat.name,
        participants: chat.groupMetadata?.participants?.length || 0,
      }));
    console.log(`[WhatsApp:${this.userId}] Loaded ${this.groups.length} groups`);
  }

  // Lazy contact load — called only on demand
  async loadContacts(force = false) {
    if (this.contactsLoading) {
      // Another caller is already loading — wait for it
      while (this.contactsLoading) await new Promise(r => setTimeout(r, 200));
      return;
    }
    if (this.contactsLoaded && !force) return;
    this.contactsLoading = true;
    try {
      this.touchActivity();
      console.log(`[WhatsApp:${this.userId}] Loading contacts (this can take a while)...`);
      const contacts = await this.client.getContacts();
      this.contacts = contacts
        .filter((c) => {
          if (!c.id || !c.id._serialized) return false;
          if (!c.id._serialized.endsWith('@c.us')) return false;
          if (c.isGroup) return false;
          if (c.isMe) return false;
          return !!(c.name || c.pushname || c.number);
        })
        .map((c) => ({
          id: c.id._serialized,
          name: c.name || c.pushname || c.number || c.id.user,
          number: c.number || c.id.user,
        }));
      this.contacts.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      this.contactsLoaded = true;
      console.log(`[WhatsApp:${this.userId}] Loaded ${this.contacts.length} contacts (raw: ${contacts.length})`);
      this.emit('contacts_updated', { userId: this.userId });
    } catch (err) {
      console.error(`[WhatsApp:${this.userId}] Failed to load contacts:`, err.message);
      throw err;
    } finally {
      this.contactsLoading = false;
    }
  }

  getGroups() { return this.groups; }
  getContacts() { return this.contacts; }
  getStatus() { return { status: this.status, qrCode: this.qrCode, contactsLoaded: this.contactsLoaded }; }

  async getGroupParticipants(groupId) {
    if (this.status !== 'ready') throw new Error('WhatsApp client is not ready');
    this.touchActivity();
    try {
      const chat = await this.client.getChatById(groupId);
      if (!chat.isGroup) return [];
      const participants = chat.groupMetadata?.participants || [];
      const results = [];
      for (const p of participants) {
        let name = '';
        try {
          const contact = await this.client.getContactById(p.id._serialized);
          name = contact.name || contact.pushname || contact.number || '';
        } catch (_) {}
        results.push({
          id: p.id._serialized,
          number: p.id.user,
          name: name || p.id.user,
          isAdmin: !!p.isAdmin,
        });
      }
      return results;
    } catch (err) {
      console.error(`[WhatsApp:${this.userId}] getGroupParticipants error:`, err.message);
      return [];
    }
  }

  async sendMessage(recipientId, text, options = {}) {
    if (this.status !== 'ready') throw new Error('WhatsApp client is not ready');
    this.touchActivity();
    return this.client.sendMessage(recipientId, text, options);
  }

  async sendMedia(recipientId, filePath, caption = '', options = {}) {
    if (this.status !== 'ready') throw new Error('WhatsApp client is not ready');
    this.touchActivity();
    const absolutePath = path.resolve(filePath);
    if (!fs.existsSync(absolutePath)) throw new Error(`File not found: ${absolutePath}`);
    const media = MessageMedia.fromFilePath(absolutePath);
    return this.client.sendMessage(recipientId, media, { caption, ...options });
  }

  async sendAudio(recipientId, filePath, asVoice = true) {
    if (this.status !== 'ready') throw new Error('WhatsApp client is not ready');
    this.touchActivity();
    const absolutePath = path.resolve(filePath);
    if (!fs.existsSync(absolutePath)) throw new Error(`File not found: ${absolutePath}`);
    const media = MessageMedia.fromFilePath(absolutePath);
    return this.client.sendMessage(recipientId, media, { sendAudioAsVoice: asVoice });
  }

  async sendPoll(recipientId, { question, options, allowMultipleAnswers }) {
    if (this.status !== 'ready') throw new Error('WhatsApp client is not ready');
    this.touchActivity();
    const poll = new Poll(question, options, { allowMultipleAnswers: !!allowMultipleAnswers });
    return this.client.sendMessage(recipientId, poll);
  }

  async sendLocation(recipientId, { latitude, longitude, description }) {
    if (this.status !== 'ready') throw new Error('WhatsApp client is not ready');
    this.touchActivity();
    const lat = Number(latitude);
    const lng = Number(longitude);
    if (isNaN(lat) || isNaN(lng)) throw new Error(`Invalid coordinates: ${latitude}, ${longitude}`);
    const name = (description || '').trim() || 'Localisation';
    const loc = new Location(lat, lng, { name, address: name });
    return this.client.sendMessage(recipientId, loc);
  }

  _cleanLocks(dir) {
    const LOCK_NAMES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
    try {
      if (!fs.existsSync(dir)) return;
      const walk = (d) => {
        const entries = fs.readdirSync(d, { withFileTypes: true });
        for (const e of entries) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) {
            walk(full);
          } else if (e.isSymbolicLink() || LOCK_NAMES.includes(e.name) || e.name.startsWith('.org.chromium')) {
            try { fs.unlinkSync(full); } catch (_) {}
          }
        }
      };
      walk(dir);
    } catch (err) {
      console.error(`[WhatsApp:${this.userId}] cleanLocks error:`, err.message);
    }
  }

  async destroy() {
    this.destroyed = true;
    this._resolveWaiters();
    try {
      if (this.client) await this.client.destroy();
    } catch (err) {
      console.error(`[WhatsApp:${this.userId}] Destroy error:`, err.message);
    }
    this.status = 'disconnected';
    this.client = null;
  }

  deleteSessionData() {
    const sessionPath = path.join(__dirname, '..', 'data', 'whatsapp-sessions', String(this.userId));
    try {
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
        console.log(`[WhatsApp:${this.userId}] Session data deleted`);
      }
    } catch (err) {
      console.error(`[WhatsApp:${this.userId}] Failed to delete session data:`, err.message);
    }
  }
}

// --- Manager : pool de clients ---
class WhatsAppManager extends EventEmitter {
  constructor() {
    super();
    this.clients = new Map();
  }

  // Now waits until QR/ready/disconnected (max 30s). Returns the client.
  async getOrCreateClient(userId, waitTimeoutMs = 30000) {
    let client = this.clients.get(userId);
    if (client) {
      // Already exists — if not stable, wait a bit
      if (client.status === 'connecting') {
        await client.waitUntilStable(waitTimeoutMs);
      }
      return client;
    }

    client = new WhatsAppClient(userId);
    client.on('qr', (data) => this.emit('qr', data));
    client.on('authenticated', (data) => this.emit('authenticated', data));
    client.on('ready', (data) => this.emit('ready', data));
    client.on('disconnected', (data) => this.emit('disconnected', data));
    client.on('auth_failure', (data) => this.emit('auth_failure', data));
    client.on('groups_updated', (data) => this.emit('groups_updated', data));
    client.on('contacts_updated', (data) => this.emit('contacts_updated', data));

    this.clients.set(userId, client);

    // Fire and forget initialize, but ALSO wait for status to stabilize
    client.initialize().catch((err) => {
      console.error(`[WhatsAppManager] init failed for user ${userId}:`, err.message);
    });

    await client.waitUntilStable(waitTimeoutMs);
    return client;
  }

  getClient(userId) {
    return this.clients.get(userId) || null;
  }

  getClientStatus(userId) {
    const client = this.clients.get(userId);
    if (!client) return { status: 'disconnected', qrCode: null };
    return client.getStatus();
  }

  async destroyClient(userId) {
    const client = this.clients.get(userId);
    if (client) {
      await client.destroy();
      client.deleteSessionData();
      this.clients.delete(userId);
    } else {
      const sessionPath = path.join(__dirname, '..', 'data', 'whatsapp-sessions', String(userId));
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
        console.log(`[WhatsAppManager] Cleaned session data for user ${userId}`);
      }
    }
  }

  async restartClient(userId) {
    const client = this.clients.get(userId);
    if (client) {
      await client.destroy();
      this.clients.delete(userId);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return this.getOrCreateClient(userId);
  }

  async initializeAll(userIds) {
    console.log(`[WhatsAppManager] Initializing ${userIds.length} client(s)...`);
    for (const userId of userIds) {
      await this.getOrCreateClient(userId);
    }
  }

  getAllClientStatuses() {
    const statuses = {};
    for (const [userId, client] of this.clients) {
      statuses[userId] = client.getStatus();
    }
    return statuses;
  }

  getAllClients() {
    return Array.from(this.clients.values());
  }

  // Smart idle-kill: skip clients that have pending messages or recent activity
  async killIdleClients(maxIdleMs, protectedUserIds = []) {
    const protectedSet = new Set(protectedUserIds);
    let killed = 0;
    for (const [userId, client] of this.clients) {
      if (protectedSet.has(userId)) continue;
      if (client.status === 'connecting') continue; // mid-init, don't kill
      if (client.isIdle(maxIdleMs)) {
        console.log(`[WhatsAppManager] Killing idle client for user ${userId}`);
        try { await client.destroy(); } catch (_) {}
        this.clients.delete(userId);
        killed++;
      }
    }
    return killed;
  }
}

module.exports = new WhatsAppManager();
