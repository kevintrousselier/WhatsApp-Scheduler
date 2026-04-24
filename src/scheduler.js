const cron = require('node-cron');
const db = require('./database');
const waManager = require('./whatsapp');
const path = require('path');

const ANTI_SPAM_DELAY = parseInt(process.env.ANTI_SPAM_DELAY || '15', 10) * 1000;
const MAX_RETRIES = 3;
const RETRY_DELAY = 30000;

function localNow(tz) {
  const zone = tz || process.env.TZ || 'Europe/Paris';
  return new Date().toLocaleString('sv-SE', { timeZone: zone }).replace(' ', 'T');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendMessageToGroup(waClient, message, group, attempt = 1) {
  try {
    const hasAttachments = message.attachments && message.attachments.length > 0;
    const content = message.content || '';
    const isGroup = (group.id || '').endsWith('@g.us');
    const mentionsOpt = (isGroup && Array.isArray(message.mentions) && message.mentions.length > 0)
      ? { mentions: message.mentions }
      : {};

    const type = message.type || 'text';

    if (type === 'poll' && message.poll) {
      // If there is also text, send text FIRST then poll
      if (content) await waClient.sendMessage(group.id, content, mentionsOpt);
      await waClient.sendPoll(group.id, message.poll);
    } else if (type === 'location' && message.location) {
      await waClient.sendLocation(group.id, message.location);
      if (content) await waClient.sendMessage(group.id, content, mentionsOpt);
    } else if (message.poll && (hasAttachments || content)) {
      // Text/attachments + poll as add-on: send text/attachments first, then poll
      if (hasAttachments) {
        for (let i = 0; i < message.attachments.length; i++) {
          const attachment = message.attachments[i];
          const filePath = path.join(__dirname, '..', 'data', 'uploads', String(message.user_id), attachment.filename);
          const isAudioVoice = attachment.voice === true;
          if (isAudioVoice) {
            await waClient.sendAudio(group.id, filePath, true);
          } else {
            const caption = i === 0 ? content : '';
            const opts = i === 0 ? mentionsOpt : {};
            await waClient.sendMedia(group.id, filePath, caption, opts);
          }
          if (i < message.attachments.length - 1) await sleep(2000);
        }
      } else if (content) {
        await waClient.sendMessage(group.id, content, mentionsOpt);
      }
      await sleep(1500);
      await waClient.sendPoll(group.id, message.poll);
    } else if (hasAttachments) {
      for (let i = 0; i < message.attachments.length; i++) {
        const attachment = message.attachments[i];
        const filePath = path.join(__dirname, '..', 'data', 'uploads', String(message.user_id), attachment.filename);
        const isAudioVoice = attachment.voice === true;
        if (isAudioVoice) {
          await waClient.sendAudio(group.id, filePath, true);
        } else {
          const caption = i === 0 ? content : '';
          const opts = i === 0 ? mentionsOpt : {};
          await waClient.sendMedia(group.id, filePath, caption, opts);
        }
        if (i < message.attachments.length - 1) await sleep(2000);
      }
    } else if (content) {
      await waClient.sendMessage(group.id, content, mentionsOpt);
    }

    db.logSend({
      user_id: message.user_id,
      message_id: message.id,
      group_id: group.id,
      group_name: group.name,
      status: 'sent',
      timezone: message.timezone,
    });

    console.log(`[Scheduler] Sent message #${message.id} to "${group.name}" (user ${message.user_id})`);
    return true;
  } catch (err) {
    console.error(`[Scheduler] Failed #${message.id} to "${group.name}" (attempt ${attempt}):`, err.message);

    if (attempt < MAX_RETRIES) {
      console.log(`[Scheduler] Retrying in ${RETRY_DELAY / 1000}s...`);
      await sleep(RETRY_DELAY);
      return sendMessageToGroup(waClient, message, group, attempt + 1);
    }

    db.logSend({
      user_id: message.user_id,
      message_id: message.id,
      group_id: group.id,
      group_name: group.name,
      status: 'error',
      error: err.message,
      timezone: message.timezone,
    });

    return false;
  }
}

async function processDueMessages() {
  // Get all pending messages, filter by each message's own timezone.
  // scheduled_at is stored as local time string for its timezone.
  const allPending = db.getAllPendingMessages();
  const dueMessages = allPending.filter((m) => {
    if (!m.scheduled_at) return false;
    const tz = m.timezone || 'Europe/Paris';
    return m.scheduled_at <= localNow(tz);
  });

  if (dueMessages.length === 0) return;

  console.log(`[Scheduler] Processing ${dueMessages.length} due message(s)`);

  for (const message of dueMessages) {
    // Try to get existing client, or initialize one on-demand
    let waClient = waManager.getClient(message.user_id);
    if (!waClient) {
      console.log(`[Scheduler] Initializing client for user ${message.user_id} on-demand...`);
      waClient = await waManager.getOrCreateClient(message.user_id);
      // Wait up to 90s for client to be ready
      for (let w = 0; w < 30; w++) {
        if (waClient.getStatus().status === 'ready') break;
        await sleep(3000);
      }
    }
    if (waClient.getStatus().status !== 'ready') {
      console.log(`[Scheduler] Skipping message #${message.id} — user ${message.user_id} client not ready`);
      continue;
    }

    db.updateMessageStatus(message.id, 'sending');

    let allSent = true;
    for (let i = 0; i < message.groups.length; i++) {
      const group = message.groups[i];
      const success = await sendMessageToGroup(waClient, message, group);
      if (!success) allSent = false;
      if (i < message.groups.length - 1) await sleep(ANTI_SPAM_DELAY);
    }

    db.updateMessageStatus(
      message.id,
      allSent ? 'sent' : 'error',
      allSent ? null : 'Some recipients failed — check send_log'
    );

    // If message has recurrence and was sent OK, schedule the next occurrence
    if (allSent && message.recurrence) {
      try {
        const next = computeNextOccurrence(message.scheduled_at, message.recurrence);
        if (next) {
          db.createMessage(message.user_id, {
            groups: message.groups,
            content: message.content,
            attachments: message.attachments,
            scheduled_at: next,
            status: 'pending',
            notes: message.notes,
            tags: message.tags,
            mentions: message.mentions,
            timezone: message.timezone,
            type: message.type,
            poll: message.poll,
            location: message.location,
            recurrence: message.recurrence,
            batch_group_id: message.batch_group_id,
          });
          console.log(`[Scheduler] Created recurring next occurrence at ${next}`);
        }
      } catch (err) {
        console.error('[Scheduler] Recurrence scheduling error:', err.message);
      }
    }
  }
}

// Compute next occurrence for a recurrence pattern
// recurrence = { frequency: 'daily'|'weekly'|'monthly', interval: number, endDate?: 'YYYY-MM-DD' }
function computeNextOccurrence(currentLocalStr, recurrence) {
  if (!recurrence || !currentLocalStr) return null;
  const interval = Math.max(1, parseInt(recurrence.interval || 1));
  // Parse local string manually (no TZ shift)
  const m = String(currentLocalStr).match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return null;
  let [_, Y, Mo, D, H, Mi] = m;
  let year = parseInt(Y), month = parseInt(Mo) - 1, day = parseInt(D);
  const hour = parseInt(H), minute = parseInt(Mi);

  if (recurrence.frequency === 'daily') {
    const dt = new Date(Date.UTC(year, month, day));
    dt.setUTCDate(dt.getUTCDate() + interval);
    year = dt.getUTCFullYear(); month = dt.getUTCMonth(); day = dt.getUTCDate();
  } else if (recurrence.frequency === 'weekly') {
    const dt = new Date(Date.UTC(year, month, day));
    dt.setUTCDate(dt.getUTCDate() + 7 * interval);
    year = dt.getUTCFullYear(); month = dt.getUTCMonth(); day = dt.getUTCDate();
  } else if (recurrence.frequency === 'monthly') {
    month += interval;
    while (month > 11) { month -= 12; year++; }
  } else {
    return null;
  }

  const next = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  // Check end date
  if (recurrence.endDate && next.slice(0, 10) > recurrence.endDate) return null;
  return next;
}

async function refreshAllContactsAndGroups() {
  const clients = waManager.getAllClients ? waManager.getAllClients() : [];
  let refreshed = 0;
  for (const client of clients) {
    if (client.getStatus().status !== 'ready') continue;
    try {
      await client.loadGroups();
      await client.loadContacts();
      refreshed++;
    } catch (err) {
      console.error(`[Scheduler] Refresh failed for user ${client.userId}:`, err.message);
    }
  }
  if (refreshed > 0) console.log(`[Scheduler] Refreshed groups/contacts for ${refreshed} client(s)`);
}

// Kill clients idle for more than IDLE_MAX_MS (default 2h)
const IDLE_MAX_MS = parseInt(process.env.IDLE_MAX_MS || (2 * 60 * 60 * 1000), 10);

async function killIdleClientsJob() {
  if (!waManager.killIdleClients) return;
  try {
    const killed = await waManager.killIdleClients(IDLE_MAX_MS);
    if (killed > 0) console.log(`[Scheduler] Killed ${killed} idle client(s)`);
  } catch (err) {
    console.error('[Scheduler] killIdleClients error:', err.message);
  }
}

function start() {
  // Process scheduled messages every 30s
  cron.schedule('*/30 * * * * *', () => {
    processDueMessages().catch((err) =>
      console.error('[Scheduler] Error processing messages:', err.message)
    );
  });

  // Refresh groups and contacts every 12 hours (at 06:00 and 18:00)
  cron.schedule('0 6,18 * * *', () => {
    refreshAllContactsAndGroups().catch((err) =>
      console.error('[Scheduler] Error refreshing contacts:', err.message)
    );
  });

  // Kill idle WhatsApp clients every 15 min to save memory
  cron.schedule('*/15 * * * *', killIdleClientsJob);

  console.log('[Scheduler] Started — messages every 30s, refresh 12h, idle-kill every 15min');
}

module.exports = { start, processDueMessages, refreshAllContactsAndGroups, killIdleClientsJob };
