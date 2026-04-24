const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
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
    this.destroyed = false;
    this.lastActivityAt = Date.now();
  }

  touchActivity() {
    this.lastActivityAt = Date.now();
  }

  isIdle(maxIdleMs) {
    return (Date.now() - this.lastActivityAt) > maxIdleMs;
  }

  async initialize() {
    this.status = 'connecting';

    const sessionPath = path.join(__dirname, '..', 'data', 'whatsapp-sessions', String(this.userId));
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    // Clean up Chromium lock files recursively to prevent "profile in use" errors
    this._cleanLocks(sessionPath);

    const puppeteerOpts = {
      headless: true,
      protocolTimeout: 180000,
      timeout: 120000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-software-rasterizer',
        '--shm-size=512mb',
      ],
    };
    // Use system Chromium if set (Docker)
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      puppeteerOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    this.client = new Client({
      authStrategy: new LocalAuth({ clientId: `user-${this.userId}`, dataPath: sessionPath }),
      puppeteer: puppeteerOpts,
      webVersionCache: { type: 'none' },
    });

    this.client.on('qr', (qr) => {
      this.status = 'qr';
      this.qrCode = qr;
      this.emit('qr', { userId: this.userId, qrCode: qr });
      console.log(`[WhatsApp:${this.userId}] QR code received`);
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
      await this.loadGroups();
      await this.loadContacts();
      this.emit('ready', { userId: this.userId });
    });

    this.client.on('disconnected', (reason) => {
      this.status = 'disconnected';
      console.log(`[WhatsApp:${this.userId}] Disconnected:`, reason);
      this.emit('disconnected', { userId: this.userId, reason });
      // Don't auto-reconnect if we manually destroyed the client
      if (this.destroyed) return;
      setTimeout(() => {
        if (this.destroyed) return;
        console.log(`[WhatsApp:${this.userId}] Attempting reconnection...`);
        this.initialize().catch((err) =>
          console.error(`[WhatsApp:${this.userId}] Reconnection failed:`, err.message)
        );
      }, 5000);
    });

    this.client.on('auth_failure', (msg) => {
      this.status = 'disconnected';
      console.error(`[WhatsApp:${this.userId}] Auth failure:`, msg);
      this.emit('auth_failure', { userId: this.userId, msg });
    });

    // Instant sync: groups and contacts changes
    const onGroupsChanged = () => {
      this.loadGroups().then(() => this.emit('groups_updated', { userId: this.userId })).catch(() => {});
    };
    const onContactsChanged = () => {
      this.loadContacts().then(() => this.emit('contacts_updated', { userId: this.userId })).catch(() => {});
    };

    this.client.on('group_join', onGroupsChanged);
    this.client.on('group_leave', onGroupsChanged);
    this.client.on('group_update', onGroupsChanged);
    this.client.on('contact_changed', onContactsChanged);

    await this.client.initialize();
  }

  async loadGroups() {
    try {
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
    } catch (err) {
      console.error(`[WhatsApp:${this.userId}] Failed to load groups:`, err.message);
    }
  }

  async loadContacts() {
    try {
      this.touchActivity();
      const contacts = await this.client.getContacts();
      this.contacts = contacts
        .filter((c) => c.isMyContact && !c.isGroup && !c.isMe && c.id._serialized.endsWith('@c.us'))
        .map((c) => ({ id: c.id._serialized, name: c.name || c.pushname || c.number, number: c.number }));
      console.log(`[WhatsApp:${this.userId}] Loaded ${this.contacts.length} contacts`);
    } catch (err) {
      console.error(`[WhatsApp:${this.userId}] Failed to load contacts:`, err.message);
    }
  }

  getGroups() { return this.groups; }
  getContacts() { return this.contacts; }
  getStatus() { return { status: this.status, qrCode: this.qrCode }; }

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

  _cleanLocks(dir) {
    const LOCK_NAMES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie', '.org.chromium.Chromium.*'];
    try {
      if (!fs.existsSync(dir)) return;
      const walk = (d) => {
        const entries = fs.readdirSync(d, { withFileTypes: true });
        for (const e of entries) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) {
            walk(full);
          } else if (e.isSymbolicLink() || LOCK_NAMES.some(n => n.includes('*') ? e.name.startsWith('.org.chromium') : e.name === n)) {
            try { fs.unlinkSync(full); console.log(`[WhatsApp:${this.userId}] Removed lock ${e.name}`); } catch (_) {}
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
    try {
      if (this.client) await this.client.destroy();
    } catch (err) {
      console.error(`[WhatsApp:${this.userId}] Destroy error:`, err.message);
    }
    this.status = 'disconnected';
    this.client = null;
  }

  // Delete all session data from disk
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

  async getOrCreateClient(userId) {
    if (this.clients.has(userId)) {
      return this.clients.get(userId);
    }

    const client = new WhatsAppClient(userId);

    // Forward events with userId
    client.on('qr', (data) => this.emit('qr', data));
    client.on('authenticated', (data) => this.emit('authenticated', data));
    client.on('ready', (data) => this.emit('ready', data));
    client.on('disconnected', (data) => this.emit('disconnected', data));
    client.on('auth_failure', (data) => this.emit('auth_failure', data));
    client.on('groups_updated', (data) => this.emit('groups_updated', data));
    client.on('contacts_updated', (data) => this.emit('contacts_updated', data));

    this.clients.set(userId, client);

    // Initialize in background
    client.initialize().catch((err) =>
      console.error(`[WhatsAppManager] Failed to init client for user ${userId}:`, err.message)
    );

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
      // No active client but session data may exist on disk
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
      // Wait for Chromium to fully release the profile
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    // Re-create without deleting session data (allows auto-reconnect)
    return this.getOrCreateClient(userId);
  }

  // Initialize all existing users' clients on startup
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

  async killIdleClients(maxIdleMs) {
    let killed = 0;
    for (const [userId, client] of this.clients) {
      if (client.isIdle(maxIdleMs)) {
        console.log(`[WhatsAppManager] Killing idle client for user ${userId} (inactive > ${Math.round(maxIdleMs / 60000)}min)`);
        try { await client.destroy(); } catch (_) {}
        this.clients.delete(userId);
        killed++;
      }
    }
    return killed;
  }
}

module.exports = new WhatsAppManager();
