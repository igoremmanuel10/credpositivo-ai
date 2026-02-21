import cron from 'node-cron';
import { db } from '../db/client.js';
import { handleFollowup } from './manager.js';
import { config, isBusinessHours, msUntilNextBusinessHour } from '../config.js';
import { cache } from '../db/redis.js';

/**
 * Start the follow-up scheduler.
 * Runs every 5 minutes to check for:
 * 1. Conversations that timed out (no response in 48h)
 * 2. Pending scheduled follow-ups
 *
 * Respects business hours: 8h-20h BRT (Mon-Fri), 8h-14h (Sat), off Sunday.
 * Controlled by config.followupEnabled.
 */
export function startFollowupScheduler() {
  if (!config.followupEnabled) {
    console.log('[Followup Scheduler] DESATIVADO (config.followupEnabled = false). Nenhum follow-up será enviado.');
    return;
  }

  // Check every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    // Respect business hours for automated messages
    if (!isBusinessHours()) {
      return; // Silent skip outside business hours
    }

    try {
      await processTimeouts();
      await processPendingFollowups();
    } catch (err) {
      console.error('[Followup Scheduler] Error:', err);
    }
  });

  console.log('[Followup Scheduler] ATIVADO (every 5 minutes, business hours only: 8h-20h BRT)');
}

/**
 * Find conversations that timed out and schedule follow-ups.
 */
async function processTimeouts() {
  const timedOut = await db.getTimedOutConversations(config.limits.conversationTimeoutMinutes);

  for (const conv of timedOut) {
    // Skip opted-out leads
    if (conv.opted_out) continue;

    console.log(`[Followup] Scheduling timeout follow-up for ${conv.phone}`);
    await db.scheduleFollowup(conv.id, 'consultation_timeout', 0); // immediate
  }
}

/**
 * Process pending follow-ups that are due.
 */
async function processPendingFollowups() {
  const pending = await db.getPendingFollowups();

  for (const followup of pending) {
    try {
      // OPT-OUT: Check if lead opted out — cancel all follow-ups
      const conv = await db.getConversation(followup.phone);
      if (conv && conv.opted_out) {
        console.log(`[Followup] BLOCKED ${followup.event_type} for ${followup.phone} — lead opted out.`);
        await db.cancelFollowups(followup.conversation_id);
        continue;
      }

      // ANTI-SPAM: Check if last message is already from agent before sending follow-up
      const recentMessages = await db.getMessages(followup.conversation_id);
      if (recentMessages.length > 0) {
        const lastMsg = recentMessages[recentMessages.length - 1];
        if (lastMsg.role === 'agent') {
          console.log(`[Followup] BLOCKED ${followup.event_type} for ${followup.phone} — last message is already from agent. Skipping.`);
          await db.markFollowupSent(followup.id);
          continue;
        }
      }

      // DAILY LIMIT: Max 1 follow-up per lead per day
      const todayCount = await cache.getDailyFollowupCount(followup.phone);
      if (todayCount >= config.limits.maxFollowupsPerDay) {
        console.log(`[Followup] BLOCKED ${followup.event_type} for ${followup.phone} — daily limit reached (${todayCount}).`);
        continue; // Don't mark as sent — retry tomorrow
      }

      // Determine if this follow-up should include audio
      const useAudio = shouldUseAudio(followup.event_type, followup.attempt);

      console.log(`[Followup] Processing ${followup.event_type} (attempt ${followup.attempt}) for ${followup.phone} [audio: ${useAudio}]`);

      await handleFollowup(
        {
          id: followup.conversation_id,
          phone: followup.phone,
          remote_jid: followup.remote_jid,
          name: followup.name,
          phase: followup.phase,
          user_profile: followup.user_profile,
          persona: followup.persona || 'augusto',
          price_counter: 0,
          link_counter: 0,
          ebook_sent: false,
          recommended_product: followup.recommended_product || null,
        },
        followup.event_type,
        useAudio
      );

      await db.markFollowupSent(followup.id);
      await cache.incrementDailyFollowupCount(followup.phone);

      // Schedule next follow-up with increasing delay
      const nextDelay = getNextDelay(followup.attempt);
      if (nextDelay) {
        await db.scheduleFollowup(
          followup.conversation_id,
          followup.event_type,
          nextDelay
        );
      }
    } catch (err) {
      console.error(`[Followup] Error processing followup ${followup.id}:`, err);
    }
  }
}

/**
 * Determine if a follow-up should use audio based on type and attempt.
 *
 * Rules from flows document:
 * - Follow-up 1 (any): TEXT
 * - Follow-up 2 (24h+): AUDIO (humanizes)
 * - Follow-up 3 (7d+): TEXT (last touch, light)
 * - purchase_completed: AUDIO always
 * - diagnosis_completed: AUDIO + TEXT
 * - limpa_completed: AUDIO
 * - signup_completed: TEXT
 * - purchase_abandoned: TEXT
 * - link_sent_no_action: TEXT
 */
function shouldUseAudio(eventType, attempt) {
  if (!config.tts.enabled) return false;

  // Event-specific audio (always audio regardless of attempt)
  const audioEvents = ['purchase_completed', 'diagnosis_completed', 'limpa_completed', 'rating_completed', 'affiliate_invite'];
  if (audioEvents.includes(eventType)) return true;

  // Timeout follow-ups: only attempt 2 gets audio
  if (eventType === 'consultation_timeout' && attempt === 2) return true;

  return false;
}

/**
 * Get next follow-up delay based on attempt number.
 * Sequence: 48h → 7 days → 14 days → stop
 */
function getNextDelay(attempt) {
  const delays = config.limits.followupDelays;
  if (attempt <= delays.length) {
    return delays[attempt - 1];
  }
  return null;
}
