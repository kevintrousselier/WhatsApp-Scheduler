const cron = require('node-cron');
const db = require('./database');
const waManager = require('./whatsapp');
const path = require('path');

const ANTI_SPAM_DELAY = parseInt(process.env.ANTI_SPAM_DELAY || '15', 10) * 1000;
const MAX_RETRIES = 3;
const RETRY_DELAY = 30000;

function localNow() {
  return new Date().toLocaleString('sv-SE', { timeZone: process.env.TZ || 'Europe/Paris' }).replace(' ', 'T');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendMessageToGroup(waClient, message, group, attempt = 1) {
  try {
    if (message.content) {
      await waClient.sendMessage(group.id, message.content);
    }

    if (message.attachments && message.attachments.length > 0) {
      for (const attachment of message.attachments) {
        const filePath = path.join(__dirname, '..', 'data', 'uploads', String(message.user_id), attachment.filename);
        await waClient.sendMedia(group.id, filePath, '');
        await sleep(2000);
      }
    }

    db.logSend({
      user_id: message.user_id,
      message_id: message.id,
      group_id: group.id,
      group_name: group.name,
      status: 'sent',
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
    });

    return false;
  }
}

async function processDueMessages() {
  const now = localNow();
  const dueMessages = db.getAllDueMessages(now);

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
  }
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

  console.log('[Scheduler] Started — checking messages every 30s, refreshing contacts every 12h');
}

module.exports = { start, processDueMessages, refreshAllContactsAndGroups };
