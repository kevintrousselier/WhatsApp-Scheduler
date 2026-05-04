// Export all messages (sent + pending + drafts) for a given user as JSON.
// Usage on GCP: sudo docker compose exec whatsapp-scheduler node scripts/backup-user.js "kevin pro"
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const userNameArg = process.argv[2] || 'kevin pro';

(async () => {
  const SQL = await initSqlJs();
  const dbPath = path.join(__dirname, '..', 'data', 'scheduler.db');
  if (!fs.existsSync(dbPath)) {
    console.error('Database file not found at', dbPath);
    process.exit(1);
  }
  const buffer = fs.readFileSync(dbPath);
  const db = new SQL.Database(buffer);

  function all(sql, params = []) {
    const stmt = db.prepare(sql);
    if (params.length) stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  // Find user (case-insensitive)
  const users = all('SELECT * FROM users WHERE LOWER(name) = LOWER(?)', [userNameArg]);
  if (users.length === 0) {
    console.error(`User not found: "${userNameArg}"`);
    console.error('Available users:');
    all('SELECT id, name FROM users').forEach(u => console.error(`  ${u.id}: ${u.name}`));
    process.exit(1);
  }
  const user = users[0];
  console.error(`Found user #${user.id}: ${user.name}`);

  // Pending messages (programmed, not sent yet)
  const pending = all(
    "SELECT * FROM messages WHERE user_id = ? AND status = 'pending' ORDER BY scheduled_at ASC",
    [user.id]
  ).map(m => ({
    id: m.id,
    type: m.type || 'text',
    scheduled_at: m.scheduled_at,
    timezone: m.timezone || 'Europe/Paris',
    content: m.content,
    notes: m.notes,
    tags: JSON.parse(m.tags_json || '[]'),
    groups: JSON.parse(m.groups_json || '[]'),
    attachments: JSON.parse(m.attachments_json || '[]'),
    poll: m.poll_json ? JSON.parse(m.poll_json) : null,
    location: m.location_json ? JSON.parse(m.location_json) : null,
    recurrence: m.recurrence_json ? JSON.parse(m.recurrence_json) : null,
    created_at: m.created_at,
  }));

  // Drafts
  const drafts = all(
    "SELECT * FROM messages WHERE user_id = ? AND status = 'draft' ORDER BY created_at DESC",
    [user.id]
  ).map(m => ({
    id: m.id,
    type: m.type || 'text',
    timezone: m.timezone || 'Europe/Paris',
    content: m.content,
    notes: m.notes,
    tags: JSON.parse(m.tags_json || '[]'),
    groups: JSON.parse(m.groups_json || '[]'),
    attachments: JSON.parse(m.attachments_json || '[]'),
    poll: m.poll_json ? JSON.parse(m.poll_json) : null,
    location: m.location_json ? JSON.parse(m.location_json) : null,
    created_at: m.created_at,
  }));

  // Send history (sent + errors)
  const history = all(
    `SELECT sl.*, m.content, m.type, m.poll_json, m.location_json, m.notes, m.tags_json
     FROM send_log sl
     LEFT JOIN messages m ON sl.message_id = m.id
     WHERE sl.user_id = ?
     ORDER BY sl.sent_at DESC`,
    [user.id]
  ).map(r => ({
    id: r.id,
    sent_at: r.sent_at,
    timezone: r.timezone || 'Europe/Paris',
    group_name: r.group_name,
    group_id: r.group_id,
    status: r.status,
    error: r.error,
    type: r.type || 'text',
    content: r.content,
    notes: r.notes,
    tags: JSON.parse(r.tags_json || '[]'),
    poll: r.poll_json ? JSON.parse(r.poll_json) : null,
    location: r.location_json ? JSON.parse(r.location_json) : null,
  }));

  // Templates
  const templates = all(
    "SELECT * FROM templates WHERE user_id = ?",
    [user.id]
  ).map(t => ({
    id: t.id,
    title: t.title,
    type: t.type || 'text',
    content: t.content,
    notes: t.notes,
    tags: JSON.parse(t.tags_json || '[]'),
    attachments: JSON.parse(t.attachments_json || '[]'),
    poll: t.poll_json ? JSON.parse(t.poll_json) : null,
    location: t.location_json ? JSON.parse(t.location_json) : null,
  }));

  // Tags
  const tags = all('SELECT * FROM tags WHERE user_id = ?', [user.id]);

  const out = {
    exportedAt: new Date().toISOString(),
    user: { id: user.id, name: user.name, timezone: user.timezone },
    counts: {
      pending: pending.length,
      drafts: drafts.length,
      history: history.length,
      templates: templates.length,
      tags: tags.length,
    },
    pending,
    drafts,
    history,
    templates,
    tags,
  };

  console.log(JSON.stringify(out, null, 2));
  console.error(`\n=== SUMMARY ===`);
  console.error(`Pending: ${pending.length}, Drafts: ${drafts.length}, History: ${history.length}, Templates: ${templates.length}, Tags: ${tags.length}`);
})().catch(err => {
  console.error('Export failed:', err);
  process.exit(1);
});
