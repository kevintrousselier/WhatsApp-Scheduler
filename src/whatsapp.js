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
  }

  async initialize() {
    this.status = 'connecting';

    const sessionPath = path.join(__dirname, '..', 'data', 'whatsapp-sessions', String(this.userId));
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    const puppeteerOpts = {
      headless: true,
      protocolTimeout: 120000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-software-rasterizer',
        '--single-process',
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
      setTimeout(() => {
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

    await this.client.initialize();
  }

  async loadGroups() {
    try {
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

  async sendMessage(recipientId, text) {
    if (this.status !== 'ready') throw new Error('WhatsApp client is not ready');
    return this.client.sendMessage(recipientId, text);
  }

  async sendMedia(recipientId, filePath, caption = '') {
    if (this.status !== 'ready') throw new Error('WhatsApp client is not ready');
    const absolutePath = path.resolve(filePath);
    if (!fs.existsSync(absolutePath)) throw new Error(`File not found: ${absolutePath}`);
    const media = MessageMedia.fromFilePath(absolutePath);
    return this.client.sendMessage(recipientId, media, { caption });
  }

  async destroy() {
    try {
      if (this.client) await this.client.destroy();
    } catch (err) {
      console.error(`[WhatsApp:${this.userId}] Destroy error:`, err.message);
    }
    this.status = 'disconnected';
    this.client = null;
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
      this.clients.delete(userId);
    }
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
}

module.exports = new WhatsAppManager();
