/**
 * Unanswered Message Monitor v2
 * 
 * Checks every 5 minutes for conversations where the last message is from a user
 * and the agent hasn't replied within 10 minutes. Attempts to reprocess with AI
 * and send the response. Alerts Ops Inbox for persistent failures.
 */
import cron from 'node-cron';
import { db } from '../db/client.js';
import { cache } from '../db/redis.js';
import { getAgentResponse } from '../ai/claude.js';
import { sendMessages, getTokenForWid, resolveWhatsAppId } from '../quepasa/client.js';
import { fixSiteLinks, cleanForWhatsApp } from '../ai/output-filter.js';
import { applyMetadataUpdates } from '../conversation/state.js';
import { findOrCreateContact, findOrCreateConversation, getInboxForPhone, sendOutgoingMessage } from '../chatwoot/client.js';
import { postToOpsInbox } from '../chatwoot/ops-inbox.js';
import { config } from '../config.js';

const MONITOR_INTERVAL = '*/5 * * * *'; // every 5 minutes
const UNANSWERED_THRESHOLD_MINUTES = 10; // consider unanswered after 10 min
const MAX_RETRIES = 2; // max retry attempts per conversation
const RETRY_COOLDOWN_HOURS = 4; // don't retry same conversation within 4h
const MAX_FIXES_PER_RUN = 5; // max conversations to fix per run
const MIN_MSG_LENGTH = 1; // allow "Ok", "Sim", "Não" — only skip pure emoji

// Track retries in memory (resets on restart — acceptable)
const retryTracker = new Map(); // phone -> { count, lastAttempt }

/**
 * Find conversations where user sent a message but agent hasn't replied.
 */
async function findUnansweredConversations() {
  const query = `
    SELECT 
      c.id, c.phone, c.name, c.phase, c.remote_jid, c.bot_phone, c.persona,
      c.price_counter, c.link_counter, c.ebook_sent, c.user_profile, c.recommended_product,
      c.opted_out,
      (SELECT m.content FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user' ORDER BY m.created_at DESC LIMIT 1) as last_user_msg,
      (SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user' ORDER BY m.created_at DESC LIMIT 1) as last_user_msg_at,
      (SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id AND m.role = 'agent' ORDER BY m.created_at DESC LIMIT 1) as last_agent_msg_at,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as total_messages
    FROM conversations c
    WHERE c.opted_out = false
      AND EXISTS (
        SELECT 1 FROM messages m 
        WHERE m.conversation_id = c.id 
          AND m.role = 'user'
          AND m.created_at > NOW() - INTERVAL '24 hours'
          AND m.created_at < NOW() - INTERVAL '${UNANSWERED_THRESHOLD_MINUTES} minutes'
      )
      AND (
        NOT EXISTS (
          SELECT 1 FROM messages m 
          WHERE m.conversation_id = c.id AND m.role = 'agent'
        )
        OR (
          SELECT MAX(m.created_at) FROM messages m 
          WHERE m.conversation_id = c.id AND m.role = 'user'
        ) > (
          SELECT MAX(m.created_at) FROM messages m 
          WHERE m.conversation_id = c.id AND m.role = 'agent'
        )
      )
    ORDER BY last_user_msg_at ASC
    LIMIT ${MAX_FIXES_PER_RUN + 5}
  `;

  try {
    const { rows } = await db.query(query);
    return rows;
  } catch (err) {
    console.error('[UnansweredMonitor] Query failed:', err.message);
    return [];
  }
}

/**
 * Attempt to reprocess a conversation with AI and send response.
 */
async function retryConversation(conv) {
  const { phone, remote_jid, bot_phone, persona } = conv;
  const lastMsg = (conv.last_user_msg || '').trim();

  // Skip very short messages (emoji, single char, etc.)
  // Strip emoji surrogates and check remaining length
  const cleanMsg = lastMsg.replace(/[\u{1F600}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{200D}\u{20E3}\u{FE0F}\u{E0020}-\u{E007F}\u{1F1E0}-\u{1F1FF}]/gu, '').trim();
  if (cleanMsg.length < MIN_MSG_LENGTH && lastMsg.length < 10) {
    console.log(`[UnansweredMonitor] Skipping ${phone}: message too short/emoji-only ("${lastMsg.substring(0, 20)}")`);
    return { success: false, reason: 'too_short' };
  }

  // Check retry limits
  const tracker = retryTracker.get(phone) || { count: 0, lastAttempt: 0 };
  if (tracker.count >= MAX_RETRIES) {
    const hoursSince = (Date.now() - tracker.lastAttempt) / (1000 * 60 * 60);
    if (hoursSince < RETRY_COOLDOWN_HOURS) {
      console.log(`[UnansweredMonitor] Skipping ${phone}: max retries (${MAX_RETRIES}) reached, cooldown ${RETRY_COOLDOWN_HOURS}h`);
      return { success: false, reason: 'max_retries' };
    }
    // Reset after cooldown
    tracker.count = 0;
  }

  // Check hourly rate limit
  const hourlyCount = await cache.getHourlyMessageCount(phone);
  const maxPerHour = config.limits.maxAgentMessagesPerHour || 3;
  if (hourlyCount >= maxPerHour) {
    console.log(`[UnansweredMonitor] Skipping ${phone}: hourly limit (${hourlyCount}/${maxPerHour})`);
    return { success: false, reason: 'hourly_limit' };
  }

  // Check total message limit
  const maxMessages = config.limits.maxConversationMessages || 200;
  if (parseInt(conv.total_messages) > maxMessages) {
    console.log(`[UnansweredMonitor] Skipping ${phone}: message limit (${conv.total_messages}/${maxMessages})`);
    return { success: false, reason: 'message_limit' };
  }

  if (!remote_jid) {
    console.log(`[UnansweredMonitor] Skipping ${phone}: no remote_jid`);
    return { success: false, reason: 'no_remote_jid' };
  }

  console.log(`[UnansweredMonitor] Retrying response for ${phone} (${conv.name || 'unknown'}) — last user msg: "${lastMsg.substring(0, 80)}"`);

  try {
    // Acquire processing lock
    const locked = await cache.setProcessingLock(phone);
    if (!locked) {
      console.log(`[UnansweredMonitor] Skipping ${phone}: processing lock held (another process handling)`);
      return { success: false, reason: 'locked' };
    }

    try {
      // Load message history
      const messages = await db.getMessages(conv.id, 12);

      // Build state for Claude
      const state = {
        phase: conv.phase,
        price_counter: conv.price_counter || 0,
        link_counter: conv.link_counter || 0,
        ebook_sent: conv.ebook_sent || false,
        name: conv.name || null,
        user_profile: conv.user_profile || {},
        recommended_product: conv.recommended_product,
      };

      // Get AI response
      const activePersona = conv.persona || 'augusto';
      const { text: responseText, metadata } = await getAgentResponse(
        state, messages, lastMsg, activePersona
      );

      if (!responseText) {
        console.log(`[UnansweredMonitor] Empty AI response for ${phone} — AI chose not to respond (msg: "${lastMsg.substring(0, 50)}")`);
        // Mark as handled — AI intentionally didn't respond
        retryTracker.set(phone, { count: MAX_RETRIES, lastAttempt: Date.now() });
        return { success: false, reason: 'empty_response_intentional' };
      }

      // Clean response
      let fixedResponse = cleanForWhatsApp(fixSiteLinks(responseText.replace(/\[AUDIO\]/g, '').trim()));

      // Resolve bot token
      const botToken = bot_phone ? getTokenForWid(`${bot_phone}:`) : null;

      // Try to resolve WhatsApp JID if needed (handles LID contacts)
      let chatId = remote_jid;
      try {
        const resolved = await resolveWhatsAppId(phone, botToken);
        if (resolved && resolved !== phone) {
          chatId = resolved;
          // Update stored remote_jid if resolved to something different
          if (chatId !== remote_jid) {
            await db.updateConversation(conv.id, { remote_jid: chatId });
            console.log(`[UnansweredMonitor] Updated remote_jid for ${phone}: ${remote_jid} -> ${chatId}`);
          }
        }
      } catch (resolveErr) {
        console.log(`[UnansweredMonitor] JID resolve failed for ${phone}, using stored: ${remote_jid}`);
      }

      // Send via WhatsApp
      const messageIds = await sendMessages(chatId, fixedResponse, botToken);
      console.log(`[UnansweredMonitor] Response sent to ${phone}: "${fixedResponse.substring(0, 100)}..."`);

      // Save agent message to DB
      const newPhase = metadata.phase ?? conv.phase;
      await db.addMessage(conv.id, 'agent', fixedResponse, newPhase, messageIds);

      // Apply state updates
      const updates = applyMetadataUpdates(state, metadata);
      if (Object.keys(updates).length > 0) {
        await db.updateConversation(conv.id, updates);
      }

      // Forward to Chatwoot
      try {
        const cwInboxId = getInboxForPhone(bot_phone || '');
        const cwContact = await findOrCreateContact(phone, conv.name, cwInboxId);
        const cwContactId = cwContact.id || cwContact.payload?.contact?.id;
        if (cwContactId) {
          const cwConv = await findOrCreateConversation(cwContactId, `whatsapp_${phone}`, cwInboxId);
          if (cwConv.id) {
            await sendOutgoingMessage(cwConv.id, fixedResponse);
          }
        }
      } catch (err) {
        console.error(`[UnansweredMonitor] Chatwoot sync failed for ${phone}:`, err.message);
      }

      // Increment hourly counter
      await cache.incrementHourlyMessageCount(phone);

      // Update retry tracker
      retryTracker.set(phone, { count: tracker.count + 1, lastAttempt: Date.now() });

      return { success: true };
    } finally {
      await cache.releaseProcessingLock(phone);
    }
  } catch (err) {
    console.error(`[UnansweredMonitor] Retry failed for ${phone}:`, err.message);
    retryTracker.set(phone, { count: tracker.count + 1, lastAttempt: Date.now() });
    return { success: false, reason: err.message };
  }
}

/**
 * Main check function — find unanswered conversations and fix them.
 */
export async function checkAndFixUnanswered() {
  console.log('[UnansweredMonitor] Running check...');

  try {
    const unanswered = await findUnansweredConversations();

    if (unanswered.length === 0) {
      console.log('[UnansweredMonitor] All conversations answered. OK.');
      return { checked: 0, fixed: 0, failed: 0 };
    }

    console.log(`[UnansweredMonitor] Found ${unanswered.length} unanswered conversation(s)`);

    let fixed = 0;
    let failed = 0;
    let skipped = 0;
    const failures = [];

    for (const conv of unanswered.slice(0, MAX_FIXES_PER_RUN)) {
      const result = await retryConversation(conv);
      if (result.success) {
        fixed++;
      } else if (result.reason === 'too_short' || result.reason === 'empty_response_intentional') {
        skipped++;
      } else {
        failed++;
        failures.push({ phone: conv.phone, name: conv.name, reason: result.reason });
      }

      // Small delay between retries to avoid overwhelming the system
      if (conv !== unanswered[unanswered.length - 1]) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    // Alert Ops Inbox if there are persistent send failures
    if (failures.length > 0) {
      const criticalFailures = failures.filter(f => 
        !['locked', 'hourly_limit', 'max_retries', 'message_limit'].includes(f.reason)
      );

      if (criticalFailures.length > 0) {
        const alertMsg = criticalFailures.map(f => 
          `- ${f.phone} (${f.name || '?'}): ${f.reason}`
        ).join('\n');

        await postToOpsInbox(
          `[ALERTA] ${criticalFailures.length} msg sem resposta - retry falhou`,
          `O monitor detectou mensagens nao respondidas e o retry falhou:\n\n${alertMsg}\n\nVerifique manualmente.`,
          { labels: ['alerta', 'unanswered', 'monitor'] }
        ).catch(err => {
          console.error('[UnansweredMonitor] Failed to post alert:', err.message);
        });
      }
    }

    console.log(`[UnansweredMonitor] Done. Fixed: ${fixed}, Skipped: ${skipped}, Failed: ${failed}, Total: ${unanswered.length}`);
    return { checked: unanswered.length, fixed, failed, skipped };
  } catch (err) {
    console.error('[UnansweredMonitor] Check failed:', err.message);
    return { checked: 0, fixed: 0, failed: 0, error: err.message };
  }
}

/**
 * Start the unanswered message monitor cron.
 */
export function startUnansweredMonitor() {
  cron.schedule(MONITOR_INTERVAL, () => {
    checkAndFixUnanswered().catch(err => {
      console.error('[UnansweredMonitor] Cron error:', err.message);
    });
  });
  console.log('[UnansweredMonitor] Started — checking every 5 minutes');
}
