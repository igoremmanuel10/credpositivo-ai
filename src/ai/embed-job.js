import { db } from '../db/client.js';
import { storeConversationEmbedding } from './embeddings.js';

// Minimum messages required before embedding a conversation
const MIN_MESSAGES = 5;

// Max messages to include in the embedding summary
const MAX_SUMMARY_MESSAGES = 10;

// Days of inactivity to consider a conversation "abandoned"
const ABANDONED_DAYS = 7;

// Max conversations to process per job run (prevent long-running jobs)
const BATCH_SIZE = 20;

/**
 * Determine the outcome of a conversation based on its state.
 *
 * @param {object} conversation - conversation row from DB
 * @returns {string} 'purchased' | 'opted_out' | 'abandoned' | 'progressed'
 */
function determineOutcome(conversation) {
  // Lead opted out explicitly
  if (conversation.opted_out) {
    return 'opted_out';
  }

  // Lead purchased (has a recommended product AND reached phase 4+)
  if (conversation.recommended_product && conversation.phase >= 4) {
    return 'purchased';
  }

  // Abandoned: no messages in 7+ days
  if (conversation.last_message_at) {
    const lastMessageDate = new Date(conversation.last_message_at);
    const daysSinceLastMessage = (Date.now() - lastMessageDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceLastMessage >= ABANDONED_DAYS) {
      return 'abandoned';
    }
  }

  // Progressed: reached at least phase 2
  if (conversation.phase >= 2) {
    return 'progressed';
  }

  // Default: progressed (even if early phase, they have 5+ messages)
  return 'progressed';
}

/**
 * Build a summary text from recent messages for embedding.
 * Concatenates up to MAX_SUMMARY_MESSAGES messages with role labels.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @returns {string}
 */
function buildSummaryFromMessages(messages) {
  return messages
    .map(m => {
      const role = m.role === 'agent' ? 'Agente' : 'Lead';
      // Truncate individual messages that are too long
      const content = m.content.length > 500 ? m.content.substring(0, 500) + '...' : m.content;
      return `${role}: ${content}`;
    })
    .join('\n');
}

/**
 * Process conversations that have enough messages but no embeddings yet.
 * Designed to run as a periodic cron job.
 *
 * @returns {{ processed: number, errors: number, skipped: number }}
 */
export async function processUnembeddedConversations() {
  const stats = { processed: 0, errors: 0, skipped: 0 };

  try {
    // Find conversations with 5+ messages that have no embeddings yet
    const { rows: conversations } = await db.query(
      `SELECT c.*
       FROM conversations c
       WHERE (
         SELECT COUNT(*)::int FROM messages m WHERE m.conversation_id = c.id
       ) >= $1
       AND NOT EXISTS (
         SELECT 1 FROM conversation_embeddings ce WHERE ce.conversation_id = c.id
       )
       ORDER BY c.last_message_at DESC NULLS LAST
       LIMIT $2`,
      [MIN_MESSAGES, BATCH_SIZE]
    );

    if (conversations.length === 0) {
      console.log('[EmbedJob] No unembedded conversations found');
      return stats;
    }

    console.log(`[EmbedJob] Found ${conversations.length} conversations to embed`);

    for (const conv of conversations) {
      try {
        // Get the last MAX_SUMMARY_MESSAGES messages
        const { rows: messages } = await db.query(
          `SELECT role, content, phase, created_at FROM (
             SELECT role, content, phase, created_at
             FROM messages
             WHERE conversation_id = $1
             ORDER BY created_at DESC
             LIMIT $2
           ) sub ORDER BY created_at ASC`,
          [conv.id, MAX_SUMMARY_MESSAGES]
        );

        if (messages.length < MIN_MESSAGES) {
          stats.skipped++;
          continue;
        }

        // Build summary text
        const summary = buildSummaryFromMessages(messages);
        if (!summary || summary.trim().length === 0) {
          stats.skipped++;
          continue;
        }

        // Determine outcome
        const outcome = determineOutcome(conv);

        // Build metadata
        const metadata = {
          recommended_product: conv.recommended_product || null,
          persona: conv.persona || 'augusto',
          total_messages: messages.length,
          phone_prefix: conv.phone ? conv.phone.substring(0, 4) + '***' : null,
        };

        // Store embedding
        const embeddingId = await storeConversationEmbedding(
          conv.id,
          conv.phase,
          summary,
          outcome,
          metadata
        );

        if (embeddingId) {
          stats.processed++;
          console.log(`[EmbedJob] Embedded conversation ${conv.id} → #${embeddingId} (outcome: ${outcome}, phase: ${conv.phase})`);
        } else {
          stats.errors++;
        }

        // Small delay between API calls to avoid rate limits
        await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        console.error(`[EmbedJob] Error processing conversation ${conv.id}:`, err.message);
        stats.errors++;
      }
    }

    console.log(`[EmbedJob] Completed: ${stats.processed} processed, ${stats.errors} errors, ${stats.skipped} skipped`);
  } catch (err) {
    console.error('[EmbedJob] Job failed:', err.message);
  }

  return stats;
}

/**
 * Re-embed conversations whose outcome may have changed.
 * Updates embeddings for conversations that:
 * - Have an existing embedding with 'progressed' outcome
 * - But now qualify as 'purchased', 'opted_out', or 'abandoned'
 *
 * Designed to run less frequently (e.g., once daily).
 *
 * @returns {{ updated: number, errors: number }}
 */
export async function refreshStaleEmbeddings() {
  const stats = { updated: 0, errors: 0 };

  try {
    // Find conversations with 'progressed' embeddings that might have a new outcome
    const { rows: candidates } = await db.query(
      `SELECT DISTINCT c.*
       FROM conversations c
       JOIN conversation_embeddings ce ON ce.conversation_id = c.id
       WHERE ce.outcome = 'progressed'
         AND (
           c.opted_out = TRUE
           OR (c.recommended_product IS NOT NULL AND c.phase >= 4)
           OR c.last_message_at < NOW() - INTERVAL '${ABANDONED_DAYS} days'
         )
       LIMIT $1`,
      [BATCH_SIZE]
    );

    if (candidates.length === 0) {
      return stats;
    }

    console.log(`[EmbedJob] Found ${candidates.length} stale embeddings to refresh`);

    for (const conv of candidates) {
      try {
        const newOutcome = determineOutcome(conv);
        if (newOutcome === 'progressed') continue; // No change

        // Delete old embeddings for this conversation
        await db.query(
          'DELETE FROM conversation_embeddings WHERE conversation_id = $1',
          [conv.id]
        );

        // Get fresh messages
        const { rows: messages } = await db.query(
          `SELECT role, content, phase, created_at FROM (
             SELECT role, content, phase, created_at
             FROM messages
             WHERE conversation_id = $1
             ORDER BY created_at DESC
             LIMIT $2
           ) sub ORDER BY created_at ASC`,
          [conv.id, MAX_SUMMARY_MESSAGES]
        );

        const summary = buildSummaryFromMessages(messages);
        if (!summary) continue;

        const metadata = {
          recommended_product: conv.recommended_product || null,
          persona: conv.persona || 'augusto',
          total_messages: messages.length,
          refreshed: true,
        };

        const embeddingId = await storeConversationEmbedding(
          conv.id,
          conv.phase,
          summary,
          newOutcome,
          metadata
        );

        if (embeddingId) {
          stats.updated++;
          console.log(`[EmbedJob] Refreshed embedding for conversation ${conv.id}: progressed → ${newOutcome}`);
        } else {
          stats.errors++;
        }

        await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        console.error(`[EmbedJob] Error refreshing conversation ${conv.id}:`, err.message);
        stats.errors++;
      }
    }

    console.log(`[EmbedJob] Refresh completed: ${stats.updated} updated, ${stats.errors} errors`);
  } catch (err) {
    console.error('[EmbedJob] Refresh job failed:', err.message);
  }

  return stats;
}
