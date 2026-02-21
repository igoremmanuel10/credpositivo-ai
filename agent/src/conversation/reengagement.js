import cron from 'node-cron';
import { db } from '../db/client.js';
import { cache } from '../db/redis.js';
import { handleFollowup } from './manager.js';
import { config, isBusinessHours } from '../config.js';

const BATCH_SIZE = 15; // contacts per hour
const DELAY_BETWEEN_MS = 4 * 60 * 1000; // ~4 min between each (15/hour)

/**
 * Re-engagement scheduler.
 * Contacts ~15 inactive leads per hour during business hours.
 * Sends personalized follow-up based on conversation context.
 */
export function startReengagementScheduler() {
  if (!config.followupEnabled) {
    console.log('[Reengagement] DISABLED (followupEnabled = false)');
    return;
  }

  // Run every hour at minute 5 (e.g. 8:05, 9:05, etc.)
  cron.schedule('5 * * * *', async () => {
    if (!isBusinessHours()) return;

    try {
      await processReengagementBatch();
    } catch (err) {
      console.error('[Reengagement] Error:', err);
    }
  });

  console.log(`[Reengagement] ACTIVE — ${BATCH_SIZE} contacts/hour during business hours`);
}

/**
 * Get inactive contacts eligible for re-engagement.
 * Criteria:
 * - Last message > 24h ago
 * - Not opted out
 * - Not already re-engaged today
 * - Has a phone number
 * - Not in active follow-up queue
 */
async function getReengagementCandidates(limit) {
  const query = `
    SELECT c.*
    FROM conversations c
    WHERE c.last_message_at < NOW() - INTERVAL '24 hours'
      AND c.opted_out IS NOT TRUE
      AND c.phone IS NOT NULL
      AND c.phone != ''
      -- Not already in pending follow-up queue
      AND NOT EXISTS (
        SELECT 1 FROM followups f
        WHERE f.conversation_id = c.id
          AND f.sent = FALSE
      )
      -- Not re-engaged in last 24h
      AND NOT EXISTS (
        SELECT 1 FROM followups f
        WHERE f.conversation_id = c.id
          AND f.event_type = 'reengagement'
          AND f.sent = TRUE
          AND f.created_at > NOW() - INTERVAL '24 hours'
      )
    ORDER BY c.last_message_at DESC
    LIMIT $1
  `;

  const { rows } = await db.pool.query(query, [limit]);
  return rows;
}

/**
 * Process a batch of re-engagement messages.
 * Sends ~15 messages staggered over the hour.
 */
async function processReengagementBatch() {
  const candidates = await getReengagementCandidates(BATCH_SIZE);

  if (candidates.length === 0) {
    console.log('[Reengagement] No candidates found this hour.');
    return;
  }

  console.log(`[Reengagement] Processing ${candidates.length} contacts this hour.`);

  for (let i = 0; i < candidates.length; i++) {
    const conv = candidates[i];

    try {
      // Check Redis daily limit
      const todayCount = await cache.getDailyFollowupCount(conv.phone);
      if (todayCount >= config.limits.maxFollowupsPerDay) {
        console.log(`[Reengagement] SKIP ${conv.phone} — daily limit (${todayCount})`);
        continue;
      }

      // Determine event type based on conversation state
      const eventType = getReengagementType(conv);

      console.log(`[Reengagement] [${i + 1}/${candidates.length}] Sending ${eventType} to ${conv.phone} (phase ${conv.phase}, last: ${conv.last_message_at})`);

      // Send the follow-up (text only for re-engagement, save audio for important events)
      await handleFollowup(
        {
          id: conv.id,
          phone: conv.phone,
          remote_jid: conv.remote_jid,
          name: conv.name,
          phase: conv.phase,
          user_profile: conv.user_profile || {},
          persona: conv.persona || 'augusto',
          price_counter: 0,
          link_counter: 0,
          ebook_sent: false,
          recommended_product: conv.recommended_product || null,
          bot_phone: conv.bot_phone,
        },
        eventType,
        false // text only for re-engagement
      );

      // Record in followups table
      await db.pool.query(
        `INSERT INTO followups (conversation_id, event_type, scheduled_at, sent)
         VALUES ($1, 'reengagement', NOW(), TRUE)`,
        [conv.id]
      );

      await cache.incrementDailyFollowupCount(conv.phone);

      // Stagger messages: wait between sends (except last one)
      if (i < candidates.length - 1) {
        const jitter = Math.random() * 60000; // 0-60s random jitter
        const waitMs = DELAY_BETWEEN_MS + jitter;
        console.log(`[Reengagement] Next send in ${Math.round(waitMs / 1000)}s`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    } catch (err) {
      console.error(`[Reengagement] Error for ${conv.phone}:`, err.message);
    }
  }

  console.log('[Reengagement] Batch complete.');
}

/**
 * Determine the re-engagement event type based on conversation context.
 */
function getReengagementType(conv) {
  // Post-purchase follow-up
  if (conv.phase === 5 && conv.recommended_product) {
    return 'purchase_followup';
  }

  // Was interested but didn't buy (phase 3-4)
  if (conv.phase >= 3) {
    return 'consultation_timeout';
  }

  // Early stage (phase 1-2) — generic re-engagement
  return 'reengagement';
}
