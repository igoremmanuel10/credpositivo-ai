/**
 * Auto-Fixer — safe, idempotent corrections that Alex can apply without human intervention.
 * Max 10 fixes per cycle. Every fix is wrapped in try/catch.
 */

import { db } from '../db/client.js';
import { config } from '../config.js';
import Redis from 'ioredis';

const MAX_FIXES_PER_CYCLE = 10;

/**
 * Run all applicable auto-fixes based on health and error data.
 * Returns array of fix results.
 */
export async function runAutoFixes(health, errors) {
  const fixes = [];

  // 1. Clear stuck Redis processing locks (>10 min)
  try {
    const lockFix = await clearStuckLocks();
    if (lockFix.fixed > 0) fixes.push(lockFix);
  } catch (err) {
    console.error('[Alex] Auto-fix clearStuckLocks error:', err.message);
  }

  // 2. Reset stuck conversations (phase 0, no activity >48h)
  if (fixes.length < MAX_FIXES_PER_CYCLE) {
    try {
      const convFix = await resetStuckConversations();
      if (convFix.fixed > 0) fixes.push(convFix);
    } catch (err) {
      console.error('[Alex] Auto-fix resetStuckConversations error:', err.message);
    }
  }

  // 3. Cancel orphaned follow-ups
  if (fixes.length < MAX_FIXES_PER_CYCLE) {
    try {
      const fupFix = await cancelOrphanedFollowups();
      if (fupFix.fixed > 0) fixes.push(fupFix);
    } catch (err) {
      console.error('[Alex] Auto-fix cancelOrphanedFollowups error:', err.message);
    }
  }

  // 4. Clear stuck debounce buffers (>5 min old)
  if (fixes.length < MAX_FIXES_PER_CYCLE) {
    try {
      const debounceFix = await clearStuckDebounceBuffers();
      if (debounceFix.fixed > 0) fixes.push(debounceFix);
    } catch (err) {
      console.error('[Alex] Auto-fix clearStuckDebounceBuffers error:', err.message);
    }
  }

  return fixes;
}

/**
 * Get a temporary Redis client for key scanning.
 */
function getTempRedis() {
  return new Redis(config.redis.url);
}

/**
 * Clear Redis processing locks older than 10 minutes.
 */
async function clearStuckLocks() {
  const redis = getTempRedis();
  try {
    const keys = await redis.keys('lock:*');
    let fixed = 0;

    for (const key of keys) {
      const ttl = await redis.ttl(key);
      if (ttl === -1 || ttl > 600) {
        await redis.del(key);
        fixed++;
        console.log('[Alex] Cleared stuck lock: ' + key + ' (ttl was ' + ttl + ')');
      }
    }

    return { type: 'clear_stuck_locks', fixed, details: `${keys.length} locks checked` };
  } catch (err) {
    return { type: 'clear_stuck_locks', fixed: 0, error: err.message };
  } finally {
    await redis.quit();
  }
}

/**
 * Reset conversations stuck in phase 0 with no activity for >48 hours.
 */
async function resetStuckConversations() {
  try {
    const result = await db.query(`
      UPDATE conversations
      SET last_message_at = NOW()
      WHERE phase = 0
        AND last_message_at < NOW() - INTERVAL '48 hours'
        AND status != 'closed'
      RETURNING id
    `);

    const fixed = result.rowCount || 0;
    if (fixed > 0) {
      console.log('[Alex] Reset ' + fixed + ' stuck phase-0 conversations');
    }
    return { type: 'reset_stuck_conversations', fixed };
  } catch (err) {
    return { type: 'reset_stuck_conversations', fixed: 0, error: err.message };
  }
}

/**
 * Cancel follow-ups that reference non-existent conversations.
 */
async function cancelOrphanedFollowups() {
  try {
    const result = await db.query(`
      UPDATE followups
      SET status = 'cancelled'
      WHERE status = 'pending'
        AND conversation_id NOT IN (SELECT id FROM conversations)
      RETURNING id
    `);

    const fixed = result.rowCount || 0;
    if (fixed > 0) {
      console.log('[Alex] Cancelled ' + fixed + ' orphaned follow-ups');
    }
    return { type: 'cancel_orphaned_followups', fixed };
  } catch (err) {
    return { type: 'cancel_orphaned_followups', fixed: 0, error: err.message };
  }
}

/**
 * Clear debounce buffers stuck for >5 minutes.
 */
async function clearStuckDebounceBuffers() {
  const redis = getTempRedis();
  try {
    const keys = await redis.keys('debounce_buf:*');
    let fixed = 0;

    for (const key of keys) {
      const ttl = await redis.ttl(key);
      if (ttl === -1 || ttl > 300) {
        await redis.del(key);
        fixed++;
        console.log('[Alex] Cleared stuck debounce buffer: ' + key + ' (ttl=' + ttl + ')');
      }
    }

    return { type: 'clear_stuck_debounce', fixed, details: `${keys.length} buffers checked` };
  } catch (err) {
    return { type: 'clear_stuck_debounce', fixed: 0, error: err.message };
  } finally {
    await redis.quit();
  }
}
