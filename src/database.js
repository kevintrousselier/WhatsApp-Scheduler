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
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

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
  return { ...row, groups: JSON.parse(row.groups_json), attachments: JSON.parse(row.attachments_json || '[]') };
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
  return { ...row, attachments: JSON.parse(row.attachments_json || '[]') };
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

  getUserById(id) {
    return getOne('SELECT * FROM users WHERE id = ?', [id]);
  },

  deleteUser(id) {
    const before = getOne('SELECT COUNT(*) as c FROM users WHERE id = ?', [id]);
    runQuery('DELETE FROM users WHERE id = ?', [id]);
    return { changes: before && before.c > 0 ? 1 : 0 };
  },

  // --- Messages ---
  createMessage(userId, { groups, content, attachments = [], scheduled_at, status = 'pending' }) {
    const id = runInsert(
      `INSERT INTO messages (user_id, groups_json, content, attachments_json, scheduled_at, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, JSON.stringify(groups), content, JSON.stringify(attachments), scheduled_at || null, status]
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

  getAllDueMessages(now) {
    return getAll(
      "SELECT * FROM messages WHERE status = 'pending' AND scheduled_at <= ?",
      [now]
    ).map(parseMessage);
  },

  updateMessage(id, userId, { groups, content, attachments, scheduled_at }) {
    runQuery(
      `UPDATE messages SET groups_json = ?, content = ?, attachments_json = ?, scheduled_at = ?
       WHERE id = ? AND user_id = ? AND status = 'pending'`,
      [JSON.stringify(groups), content, JSON.stringify(attachments || []), scheduled_at, id, userId]
    );
    return this.getMessageById(id);
  },

  updateMessageStatus(id, status, error_log = null) {
    const sent_at = (status === 'sent' || status === 'error') ? localNow() : null;
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

  // --- Send log ---
  logSend({ user_id, message_id, group_id, group_name, status, error = null }) {
    runQuery(
      'INSERT INTO send_log (user_id, message_id, group_id, group_name, status, error) VALUES (?, ?, ?, ?, ?, ?)',
      [user_id, message_id, group_id, group_name, status, error]
    );
  },

  getHistory(userId, filters = {}) {
    let sql = `SELECT sl.*, m.content, m.attachments_json FROM send_log sl
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
