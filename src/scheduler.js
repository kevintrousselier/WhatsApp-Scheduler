const cron = require('node-cron');
const db = require('./database');
const waManager = require('./whatsapp');
const path = require('path');

const ANTI_SPAM_DELAY = parseInt(process.env.ANTI_SPAM_DELAY || '15', 10) * 1000;
const MAX_RETRIES = 3;
const RETRY_DELAY = 30000;

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
  const now = new Date().toISOString();
  const dueMessages = db.getAllDueMessages(now);

  if (dueMessages.length === 0) return;

  console.log(`[Scheduler] Processing ${dueMessages.length} due message(s)`);

  for (const message of dueMessages) {
    const waClient = waManager.getClient(message.user_id);
    if (!waClient || waClient.getStatus().status !== 'ready') {
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

function start() {
  cron.schedule('*/30 * * * * *', () => {
    processDueMessages().catch((err) =>
      console.error('[Scheduler] Error processing messages:', err.message)
    );
  });
  console.log('[Scheduler] Started — checking every 30s');
}

module.exports = { start, processDueMessages };
