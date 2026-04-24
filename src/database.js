const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

function localNow() {
  return new Date().toLocaleString('sv-SE', { timeZone: process.env.TZ || 'Europe/Paris' }).replace(' ', 'T');
}

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'scheduler.db');
let db = null;

async function init() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON');

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      timezone TEXT DEFAULT 'Europe/Paris',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  try {
    const cols = getAll("PRAGMA table_info('users')");
    if (!cols.some(c => c.name === 'timezone')) {
      db.run("ALTER TABLE users ADD COLUMN timezone TEXT DEFAULT 'Europe/Paris'");
      console.log('[Database] Migrated users: added timezone column');
    }
  } catch (err) {
    console.error('[Database] users TZ migration error:', err.message);
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      groups_json TEXT NOT NULL,
      content TEXT NOT NULL,
      attachments_json TEXT DEFAULT '[]',
      scheduled_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      sent_at TEXT,
      error_log TEXT,
      notes TEXT DEFAULT '',
      tags_json TEXT DEFAULT '[]',
      timezone TEXT DEFAULT 'Europe/Paris',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Migration: add notes + tags_json + timezone columns to existing messages table
  try {
    const cols = getAll("PRAGMA table_info('messages')");
    if (!cols.some(c => c.name === 'notes')) {
      db.run("ALTER TABLE messages ADD COLUMN notes TEXT DEFAULT ''");
      console.log('[Database] Migrated messages: added notes column');
    }
    if (!cols.some(c => c.name === 'tags_json')) {
      db.run("ALTER TABLE messages ADD COLUMN tags_json TEXT DEFAULT '[]'");
      console.log('[Database] Migrated messages: added tags_json column');
    }
    if (!cols.some(c => c.name === 'timezone')) {
      db.run("ALTER TABLE messages ADD COLUMN timezone TEXT DEFAULT 'Europe/Paris'");
      console.log('[Database] Migrated messages: added timezone column');
    }
    if (!cols.some(c => c.name === 'type')) {
      db.run("ALTER TABLE messages ADD COLUMN type TEXT DEFAULT 'text'");
      console.log('[Database] Migrated messages: added type column');
    }
    if (!cols.some(c => c.name === 'poll_json')) {
      db.run("ALTER TABLE messages ADD COLUMN poll_json TEXT");
      console.log('[Database] Migrated messages: added poll_json');
    }
    if (!cols.some(c => c.name === 'location_json')) {
      db.run("ALTER TABLE messages ADD COLUMN location_json TEXT");
      console.log('[Database] Migrated messages: added location_json');
    }
    if (!cols.some(c => c.name === 'recurrence_json')) {
      db.run("ALTER TABLE messages ADD COLUMN recurrence_json TEXT");
      console.log('[Database] Migrated messages: added recurrence_json');
    }
    if (!cols.some(c => c.name === 'batch_group_id')) {
      db.run("ALTER TABLE messages ADD COLUMN batch_group_id TEXT");
      console.log('[Database] Migrated messages: added batch_group_id');
    }
  } catch (err) {
    console.error('[Database] Messages migration error:', err.message);
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      variables_json TEXT DEFAULT '[]',
      attachments_json TEXT DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Migration: add attachments_json column to existing templates table
  try {
    const cols = getAll("PRAGMA table_info('templates')");
    if (!cols.some(c => c.name === 'attachments_json')) {
      db.run("ALTER TABLE templates ADD COLUMN attachments_json TEXT DEFAULT '[]'");
      console.log('[Database] Migrated templates: added attachments_json column');
    }
  } catch (err) {
    console.error('[Database] Migration error:', err.message);
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, name),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Migration: add mentions_json to messages
  try {
    const cols = getAll("PRAGMA table_info('messages')");
    if (!cols.some(c => c.name === 'mentions_json')) {
      db.run("ALTER TABLE messages ADD COLUMN mentions_json TEXT DEFAULT '[]'");
      console.log('[Database] Migrated messages: added mentions_json column');
    }
  } catch (err) {
    console.error('[Database] mentions migration error:', err.message);
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS send_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      group_id TEXT NOT NULL,
      group_name TEXT NOT NULL,
      status TEXT NOT NULL,
      sent_at TEXT NOT NULL DEFAULT (datetime('now')),
      error TEXT,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  save();
  console.log('[Database] Initialized');
}

function save() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

function runQuery(sql, params = []) {
  db.run(sql, params);
  save();
}

function runInsert(sql, params = []) {
  db.run(sql, params);
  const stmt = db.prepare('SELECT last_insert_rowid() as id');
  stmt.step();
  const id = stmt.getAsObject().id;
  stmt.free();
  save();
  return id;
}

function getAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function getOne(sql, params = []) {
  const rows = getAll(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

function parseMessage(row) {
  if (!row) return null;
  return {
    ...row,
    groups: JSON.parse(row.groups_json),
    attachments: JSON.parse(row.attachments_json || '[]'),
    tags: JSON.parse(row.tags_json || '[]'),
    mentions: JSON.parse(row.mentions_json || '[]'),
    notes: row.notes || '',
    timezone: row.timezone || 'Europe/Paris',
    type: row.type || 'text',
    poll: row.poll_json ? JSON.parse(row.poll_json) : null,
    location: row.location_json ? JSON.parse(row.location_json) : null,
    recurrence: row.recurrence_json ? JSON.parse(row.recurrence_json) : null,
    batch_group_id: row.batch_group_id || null,
  };
}

function parseTemplate(row) {
  if (!row) return null;
  return {
    ...row,
    variables: JSON.parse(row.variables_json || '[]'),
    attachments: JSON.parse(row.attachments_json || '[]'),
  };
}

function parseHistoryRow(row) {
  if (!row) return null;
  return {
    ...row,
    attachments: JSON.parse(row.attachments_json || '[]'),
    tags: JSON.parse(row.tags_json || '[]'),
    mentions: JSON.parse(row.mentions_json || '[]'),
    notes: row.notes || '',
    timezone: row.timezone || 'Europe/Paris',
    type: row.type || 'text',
    poll: row.poll_json ? JSON.parse(row.poll_json) : null,
    location: row.location_json ? JSON.parse(row.location_json) : null,
  };
}

module.exports = {
  init,

  // --- Users ---
  createUser(name) {
    const id = runInsert('INSERT INTO users (name) VALUES (?)', [name]);
    return this.getUserById(id);
  },

  getAllUsers() {
    return getAll('SELECT * FROM users ORDER BY name ASC');
  },

  setUserTimezone(id, timezone) {
    runQuery('UPDATE users SET timezone = ? WHERE id = ?', [timezone, id]);
    return this.getUserById(id);
  },

  getUserById(id) {
    return getOne('SELECT * FROM users WHERE id = ?', [id]);
  },

  deleteUser(id) {
    const before = getOne('SELECT COUNT(*) as c FROM users WHERE id = ?', [id]);
    runQuery('DELETE FROM users WHERE id = ?', [id]);
    return { changes: before && before.c > 0 ? 1 : 0 };
  },

  // --- Messages ---
  createMessage(userId, { groups, content, attachments = [], scheduled_at, status = 'pending', notes = '', tags = [], mentions = [], timezone = 'Europe/Paris', type = 'text', poll = null, location = null, recurrence = null, batch_group_id = null }) {
    const id = runInsert(
      `INSERT INTO messages (user_id, groups_json, content, attachments_json, scheduled_at, status, notes, tags_json, mentions_json, timezone, type, poll_json, location_json, recurrence_json, batch_group_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId, JSON.stringify(groups), content, JSON.stringify(attachments),
        scheduled_at || null, status, notes || '',
        JSON.stringify(tags || []), JSON.stringify(mentions || []),
        timezone || 'Europe/Paris',
        type || 'text',
        poll ? JSON.stringify(poll) : null,
        location ? JSON.stringify(location) : null,
        recurrence ? JSON.stringify(recurrence) : null,
        batch_group_id || null,
      ]
    );
    return this.getMessageById(id);
  },

  getMessageById(id) {
    return parseMessage(getOne('SELECT * FROM messages WHERE id = ?', [id]));
  },

  getPendingMessages(userId) {
    return getAll(
      "SELECT * FROM messages WHERE user_id = ? AND status = 'pending' ORDER BY scheduled_at ASC",
      [userId]
    ).map(parseMessage);
  },

  getDrafts(userId) {
    return getAll(
      "SELECT * FROM messages WHERE user_id = ? AND status = 'draft' ORDER BY created_at DESC",
      [userId]
    ).map(parseMessage);
  },

  updateDraft(id, userId, { groups, content, attachments, notes = '', tags = [], mentions = [] }) {
    runQuery(
      `UPDATE messages SET groups_json = ?, content = ?, attachments_json = ?, notes = ?, tags_json = ?, mentions_json = ?
       WHERE id = ? AND user_id = ? AND status = 'draft'`,
      [JSON.stringify(groups || []), content || '', JSON.stringify(attachments || []), notes || '', JSON.stringify(tags || []), JSON.stringify(mentions || []), id, userId]
    );
    return this.getMessageById(id);
  },

  deleteDraft(id, userId) {
    const before = getOne("SELECT COUNT(*) as c FROM messages WHERE id = ? AND user_id = ? AND status = 'draft'", [id, userId]);
    runQuery("DELETE FROM messages WHERE id = ? AND user_id = ? AND status = 'draft'", [id, userId]);
    return { changes: before && before.c > 0 ? 1 : 0 };
  },

  // Promote a draft to pending (schedule or send now)
  promoteDraft(id, userId, scheduled_at) {
    runQuery(
      "UPDATE messages SET status = 'pending', scheduled_at = ? WHERE id = ? AND user_id = ? AND status = 'draft'",
      [scheduled_at, id, userId]
    );
    return this.getMessageById(id);
  },

  getAllDueMessages(now) {
    return getAll(
      "SELECT * FROM messages WHERE status = 'pending' AND scheduled_at <= ?",
      [now]
    ).map(parseMessage);
  },

  getAllPendingMessages() {
    return getAll("SELECT * FROM messages WHERE status = 'pending'").map(parseMessage);
  },

  updateMessage(id, userId, { groups, content, attachments, scheduled_at, notes = '', tags = [], mentions = [], timezone, type, poll, location, recurrence }) {
    const existing = this.getMessageById(id);
    const tz = timezone || (existing && existing.timezone) || 'Europe/Paris';
    const t = type || (existing && existing.type) || 'text';
    const p = poll !== undefined ? (poll ? JSON.stringify(poll) : null) : (existing && existing.poll ? JSON.stringify(existing.poll) : null);
    const l = location !== undefined ? (location ? JSON.stringify(location) : null) : (existing && existing.location ? JSON.stringify(existing.location) : null);
    const r = recurrence !== undefined ? (recurrence ? JSON.stringify(recurrence) : null) : (existing && existing.recurrence ? JSON.stringify(existing.recurrence) : null);
    runQuery(
      `UPDATE messages SET groups_json = ?, content = ?, attachments_json = ?, scheduled_at = ?, notes = ?, tags_json = ?, mentions_json = ?, timezone = ?, type = ?, poll_json = ?, location_json = ?, recurrence_json = ?
       WHERE id = ? AND user_id = ? AND status IN ('pending', 'draft')`,
      [JSON.stringify(groups), content, JSON.stringify(attachments || []), scheduled_at, notes || '', JSON.stringify(tags || []), JSON.stringify(mentions || []), tz, t, p, l, r, id, userId]
    );
    return this.getMessageById(id);
  },

  updateMessageStatus(id, status, error_log = null) {
    let sent_at = null;
    if (status === 'sent' || status === 'error') {
      // Use the message's own timezone so sent_at is comparable to scheduled_at
      const existing = this.getMessageById(id);
      const tz = (existing && existing.timezone) || process.env.TZ || 'Europe/Paris';
      sent_at = new Date().toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T');
    }
    runQuery('UPDATE messages SET status = ?, sent_at = ?, error_log = ? WHERE id = ?', [status, sent_at, error_log, id]);
  },

  deleteMessage(id, userId) {
    const before = getOne("SELECT COUNT(*) as c FROM messages WHERE id = ? AND user_id = ? AND status = 'pending'", [id, userId]);
    runQuery("DELETE FROM messages WHERE id = ? AND user_id = ? AND status = 'pending'", [id, userId]);
    return { changes: before && before.c > 0 ? 1 : 0 };
  },

  // --- Templates ---
  createTemplate(userId, { title, content, variables = [], attachments = [] }) {
    const id = runInsert(
      'INSERT INTO templates (user_id, title, content, variables_json, attachments_json) VALUES (?, ?, ?, ?, ?)',
      [userId, title, content, JSON.stringify(variables), JSON.stringify(attachments)]
    );
    return this.getTemplateById(id);
  },

  getAllTemplates(userId) {
    return getAll('SELECT * FROM templates WHERE user_id = ? ORDER BY updated_at DESC', [userId]).map(parseTemplate);
  },

  getTemplateById(id) {
    return parseTemplate(getOne('SELECT * FROM templates WHERE id = ?', [id]));
  },

  updateTemplate(id, userId, { title, content, variables = [], attachments = [] }) {
    runQuery(
      "UPDATE templates SET title = ?, content = ?, variables_json = ?, attachments_json = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?",
      [title, content, JSON.stringify(variables), JSON.stringify(attachments), id, userId]
    );
    return this.getTemplateById(id);
  },

  deleteTemplate(id, userId) {
    const before = getOne('SELECT COUNT(*) as c FROM templates WHERE id = ? AND user_id = ?', [id, userId]);
    runQuery('DELETE FROM templates WHERE id = ? AND user_id = ?', [id, userId]);
    return { changes: before && before.c > 0 ? 1 : 0 };
  },

  // --- Tags ---
  createTag(userId, name) {
    try {
      const id = runInsert('INSERT INTO tags (user_id, name) VALUES (?, ?)', [userId, name]);
      return this.getTagById(id);
    } catch (err) {
      if (err.message.includes('UNIQUE')) {
        const existing = getOne('SELECT * FROM tags WHERE user_id = ? AND name = ?', [userId, name]);
        return existing;
      }
      throw err;
    }
  },

  getTagById(id) {
    return getOne('SELECT * FROM tags WHERE id = ?', [id]);
  },

  getAllTags(userId) {
    return getAll('SELECT * FROM tags WHERE user_id = ? ORDER BY name ASC', [userId]);
  },

  renameTag(id, userId, newName) {
    runQuery('UPDATE tags SET name = ? WHERE id = ? AND user_id = ?', [newName, id, userId]);
    return this.getTagById(id);
  },

  deleteTag(id, userId) {
    const tag = getOne('SELECT * FROM tags WHERE id = ? AND user_id = ?', [id, userId]);
    if (!tag) return { changes: 0 };
    runQuery('DELETE FROM tags WHERE id = ? AND user_id = ?', [id, userId]);
    // Also strip this tag name from all messages
    const msgs = getAll("SELECT id, tags_json FROM messages WHERE user_id = ?", [userId]);
    for (const m of msgs) {
      try {
        const names = JSON.parse(m.tags_json || '[]');
        if (Array.isArray(names) && names.includes(tag.name)) {
          const filtered = names.filter(n => n !== tag.name);
          db.run('UPDATE messages SET tags_json = ? WHERE id = ?', [JSON.stringify(filtered), m.id]);
        }
      } catch (_) {}
    }
    save();
    return { changes: 1 };
  },

  // Auto-migrate free-form tags from existing messages into the tags table
  ensureTagsMigrated(userId) {
    try {
      const msgs = getAll("SELECT tags_json FROM messages WHERE user_id = ?", [userId]);
      const existingTags = new Set(this.getAllTags(userId).map(t => t.name));
      const allNames = new Set();
      for (const m of msgs) {
        try {
          const arr = JSON.parse(m.tags_json || '[]');
          if (Array.isArray(arr)) arr.forEach(n => { if (n && typeof n === 'string') allNames.add(n); });
        } catch (_) {}
      }
      let added = 0;
      for (const name of allNames) {
        if (!existingTags.has(name)) {
          try {
            runQuery('INSERT OR IGNORE INTO tags (user_id, name) VALUES (?, ?)', [userId, name]);
            added++;
          } catch (_) {}
        }
      }
      if (added > 0) console.log(`[Database] Auto-imported ${added} tag(s) for user ${userId}`);
    } catch (err) {
      console.error('[Database] ensureTagsMigrated error:', err.message);
    }
  },

  // --- Send log ---
  logSend({ user_id, message_id, group_id, group_name, status, error = null, timezone = 'Europe/Paris' }) {
    const sent_at = new Date().toLocaleString('sv-SE', { timeZone: timezone }).replace(' ', 'T');
    runQuery(
      'INSERT INTO send_log (user_id, message_id, group_id, group_name, status, sent_at, error) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [user_id, message_id, group_id, group_name, status, sent_at, error]
    );
  },

  getHistory(userId, filters = {}) {
    let sql = `SELECT sl.*, m.content, m.attachments_json, m.notes, m.tags_json, m.mentions_json, m.timezone, m.type, m.poll_json, m.location_json FROM send_log sl
               JOIN messages m ON sl.message_id = m.id WHERE sl.user_id = ?`;
    const params = [userId];

    if (filters.status) { sql += ' AND sl.status = ?'; params.push(filters.status); }
    if (filters.group_name) { sql += " AND sl.group_name LIKE '%' || ? || '%'"; params.push(filters.group_name); }
    if (filters.date_from) { sql += ' AND sl.sent_at >= ?'; params.push(filters.date_from); }
    if (filters.date_to) { sql += ' AND sl.sent_at <= ?'; params.push(filters.date_to); }

    sql += ' ORDER BY sl.sent_at DESC';
    return getAll(sql, params).map(parseHistoryRow);
  },
};
