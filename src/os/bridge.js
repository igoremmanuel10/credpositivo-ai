/**
 * @file src/os/bridge.js
 * @description Read-only bridge that connects the AI OS kernel to live data
 * from the existing CredPositivo system (PostgreSQL + Redis).
 *
 * The bridge runs two independent polling loops:
 *   - pollAgentMetrics()  — every 30 seconds, queries PostgreSQL for KPIs and
 *     pushes the results into the OS registry via updateStatus().
 *   - detectActivity()    — every 10 seconds, scans Redis lock keys to determine
 *     whether Augusto is currently processing a lead and updates status / emits
 *     events accordingly.
 *
 * IMPORTANT: This module is strictly READ-ONLY.
 * It never writes to any existing table or modifies any existing Redis key.
 * All writes go through the OS registry (os:agents:*) and the OS event bus
 * (os:events), which are isolated namespaces owned by the AI OS layer.
 *
 * Usage:
 *   import { startBridge, stopBridge } from './os/bridge.js';
 *   await startBridge();   // inside initOS()
 *   await stopBridge();    // inside shutdownOS()
 */

import Redis from 'ioredis';
import { publish } from './kernel/event-bus.js';
import { updateStatus, getAgent } from './kernel/registry.js';
import { db } from '../db/client.js';

// ─── Intervals ────────────────────────────────────────────────────────────────

const METRICS_POLL_MS = parseInt(process.env.BRIDGE_METRICS_INTERVAL || '30000', 10);
const ACTIVITY_POLL_MS = parseInt(process.env.BRIDGE_ACTIVITY_INTERVAL || '10000', 10);

/** @type {NodeJS.Timeout | null} */
let metricsTimer = null;

/** @type {NodeJS.Timeout | null} */
let activityTimer = null;

// ─── Redis connection (bridge-owned, read-only usage) ─────────────────────────

/** @type {Redis | null} */
let redis = null;

/**
 * Get (or lazily create) the bridge Redis connection.
 * This is a separate connection from the OS registry and event bus connections
 * so that lock-scanning does not interfere with those pipelines.
 *
 * @returns {Redis}
 */
function getBridgeRedis() {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: false,
      lazyConnect: false,
    });
    redis.on('error', (err) => {
      console.error('[Bridge] Redis error:', err.message);
    });
  }
  return redis;
}

// ─── Metrics cache ────────────────────────────────────────────────────────────

/**
 * Module-level cache for the most recent database metrics snapshot.
 * Consumed by getMetricsCache() which is called from os-routes.js.
 *
 * @type {{
 *   augusto: { conversations: number, reached_offer: number, messages: number, conversion: number, avg_session_duration: number },
 *   paulo:   { conversations: number, qualified: number, followups: number },
 *   system:  { totalMessages: number, userMessages: number, apiCost: number, tokens: number, avgResponseTime: number },
 *   lastUpdated: string | null
 * }}
 */
const metricsCache = {
  augusto: {
    conversations: 0,
    reached_offer: 0,
    messages: 0,
    conversion: 0,
    avg_session_duration: 0,
  },
  paulo: {
    conversations: 0,
    qualified: 0,
    followups: 0,
  },
  system: {
    totalMessages: 0,
    userMessages: 0,
    apiCost: 0,
    tokens: 0,
    avgResponseTime: 0,
  },
  lastUpdated: null,
};

// ─── SQL queries ──────────────────────────────────────────────────────────────

const SQL = {
  augustoMetrics: `
    SELECT
      COUNT(*)::int                                              AS conversations_today,
      COUNT(*) FILTER (WHERE phase >= 3)::int                   AS reached_offer,
      COALESCE(AVG(
        EXTRACT(EPOCH FROM (updated_at - created_at))
      ), 0)::float                                              AS avg_session_duration
    FROM conversations
    WHERE persona = 'augusto'
      AND DATE(created_at) = CURRENT_DATE
  `,

  pauloMetrics: `
    SELECT
      COUNT(*)::int                               AS conversations_today,
      COUNT(*) FILTER (WHERE phase >= 2)::int     AS qualified
    FROM conversations
    WHERE persona = 'paulo'
      AND DATE(created_at) = CURRENT_DATE
  `,

  messageMetrics: `
    SELECT
      COUNT(*) FILTER (WHERE role = 'agent')::int AS agent_messages_today,
      COUNT(*) FILTER (WHERE role = 'user')::int  AS user_messages_today
    FROM messages
    WHERE DATE(created_at) = CURRENT_DATE
  `,

  apiCostMetrics: `
    SELECT
      COALESCE(SUM(cost_usd), 0)::float                          AS total_cost,
      COALESCE(SUM(input_tokens + output_tokens), 0)::int        AS total_tokens
    FROM api_costs
    WHERE DATE(created_at) = CURRENT_DATE
  `,

  avgResponseTime: `
    SELECT COALESCE(AVG(response_time_sec), 0)::float AS avg_response_time
    FROM (
      SELECT EXTRACT(EPOCH FROM (
        (
          SELECT MIN(m2.created_at)
          FROM messages m2
          WHERE m2.conversation_id = m.conversation_id
            AND m2.role = 'agent'
            AND m2.created_at > m.created_at
        ) - m.created_at
      )) AS response_time_sec
      FROM messages m
      WHERE m.role = 'user'
        AND DATE(m.created_at) = CURRENT_DATE
      LIMIT 100
    ) sub
    WHERE response_time_sec IS NOT NULL
      AND response_time_sec > 0
      AND response_time_sec < 300
  `,

  conversionRate: `
    SELECT
      COALESCE(
        COUNT(*) FILTER (WHERE phase >= 3) * 100.0 / NULLIF(COUNT(*), 0),
        0
      )::float AS conversion_rate
    FROM conversations
    WHERE DATE(created_at) = CURRENT_DATE
  `,

  followupsToday: `
    SELECT COUNT(*)::int AS followups_today
    FROM followups
    WHERE sent = TRUE
      AND DATE(scheduled_at) = CURRENT_DATE
  `,
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Return the current cached metrics snapshot.
 * Called from os-routes.js to overlay real data onto pixel-state responses.
 *
 * @returns {typeof metricsCache}
 */
export function getMetricsCache() {
  return metricsCache;
}

/**
 * Start both polling loops.
 * Safe to call multiple times — subsequent calls are no-ops if already running.
 *
 * @returns {Promise<void>}
 */
export async function startBridge() {
  if (metricsTimer && activityTimer) {
    console.warn('[Bridge] Already running — startBridge() called again, skipping');
    return;
  }

  // Run an immediate pass so the dashboard is not blank on first load
  await Promise.allSettled([pollAgentMetrics(), detectActivity()]);

  if (!metricsTimer) {
    metricsTimer = setInterval(async () => {
      try {
        await pollAgentMetrics();
      } catch (err) {
        console.error('[Bridge] pollAgentMetrics error:', err.message);
      }
    }, METRICS_POLL_MS);

    if (metricsTimer.unref) metricsTimer.unref();
  }

  if (!activityTimer) {
    activityTimer = setInterval(async () => {
      try {
        await detectActivity();
      } catch (err) {
        console.error('[Bridge] detectActivity error:', err.message);
      }
    }, ACTIVITY_POLL_MS);

    if (activityTimer.unref) activityTimer.unref();
  }

  console.log(
    `[Bridge] Polling started — metrics every ${METRICS_POLL_MS / 1000}s, activity every ${ACTIVITY_POLL_MS / 1000}s`
  );
}

/**
 * Stop all polling loops and close the bridge Redis connection.
 * Called during graceful OS shutdown.
 *
 * @returns {Promise<void>}
 */
export async function stopBridge() {
  if (metricsTimer) {
    clearInterval(metricsTimer);
    metricsTimer = null;
  }

  if (activityTimer) {
    clearInterval(activityTimer);
    activityTimer = null;
  }

  if (redis) {
    try {
      await redis.quit();
    } catch (err) {
      console.warn('[Bridge] Redis quit error (non-fatal):', err.message);
    }
    redis = null;
  }

  console.log('[Bridge] Stopped.');
}

// ─── Internal polling functions ───────────────────────────────────────────────

/**
 * Query PostgreSQL for real-time KPIs and update the OS registry.
 * Runs every METRICS_POLL_MS milliseconds.
 *
 * All queries run in parallel. Individual query failures are caught and logged
 * without interrupting the rest of the poll cycle.
 *
 * @returns {Promise<void>}
 */
export async function pollAgentMetrics() {
  const results = await Promise.allSettled([
    db.query(SQL.augustoMetrics),
    db.query(SQL.pauloMetrics),
    db.query(SQL.messageMetrics),
    db.query(SQL.apiCostMetrics),
    db.query(SQL.avgResponseTime),
    db.query(SQL.conversionRate),
    db.query(SQL.followupsToday),
  ]);

  // Destructure result slots — each is either { status:'fulfilled', value } or { status:'rejected' }
  const [
    augustoResult,
    pauloResult,
    messageResult,
    costResult,
    responseTimeResult,
    conversionResult,
    followupsResult,
  ] = results;

  // ── Augusto ──────────────────────────────────────────────────────────────
  if (augustoResult.status === 'fulfilled') {
    const row = augustoResult.value.rows[0] || {};
    metricsCache.augusto.conversations     = row.conversations_today   ?? 0;
    metricsCache.augusto.reached_offer     = row.reached_offer         ?? 0;
    metricsCache.augusto.avg_session_duration = row.avg_session_duration ?? 0;
  } else {
    console.error('[Bridge] augusto query failed:', augustoResult.reason?.message);
  }

  // ── Paulo ─────────────────────────────────────────────────────────────────
  if (pauloResult.status === 'fulfilled') {
    const row = pauloResult.value.rows[0] || {};
    metricsCache.paulo.conversations = row.conversations_today ?? 0;
    metricsCache.paulo.qualified     = row.qualified           ?? 0;
  } else {
    console.error('[Bridge] paulo query failed:', pauloResult.reason?.message);
  }

  // ── Messages ──────────────────────────────────────────────────────────────
  if (messageResult.status === 'fulfilled') {
    const row = messageResult.value.rows[0] || {};
    metricsCache.system.totalMessages = (row.agent_messages_today ?? 0) + (row.user_messages_today ?? 0);
    metricsCache.system.userMessages  = row.user_messages_today ?? 0;
    metricsCache.augusto.messages     = row.agent_messages_today ?? 0;
  } else {
    console.error('[Bridge] messages query failed:', messageResult.reason?.message);
  }

  // ── API costs ─────────────────────────────────────────────────────────────
  if (costResult.status === 'fulfilled') {
    const row = costResult.value.rows[0] || {};
    metricsCache.system.apiCost = row.total_cost   ?? 0;
    metricsCache.system.tokens  = row.total_tokens ?? 0;
  } else {
    console.error('[Bridge] api_costs query failed:', costResult.reason?.message);
  }

  // ── Response time ─────────────────────────────────────────────────────────
  if (responseTimeResult.status === 'fulfilled') {
    const row = responseTimeResult.value.rows[0] || {};
    metricsCache.system.avgResponseTime = row.avg_response_time ?? 0;
  } else {
    console.error('[Bridge] response_time query failed:', responseTimeResult.reason?.message);
  }

  // ── Conversion rate ───────────────────────────────────────────────────────
  if (conversionResult.status === 'fulfilled') {
    const row = conversionResult.value.rows[0] || {};
    metricsCache.augusto.conversion = row.conversion_rate ?? 0;
  } else {
    console.error('[Bridge] conversion_rate query failed:', conversionResult.reason?.message);
  }

  // ── Follow-ups ────────────────────────────────────────────────────────────
  if (followupsResult.status === 'fulfilled') {
    const row = followupsResult.value.rows[0] || {};
    metricsCache.paulo.followups = row.followups_today ?? 0;
  } else {
    console.error('[Bridge] followups query failed:', followupsResult.reason?.message);
  }

  metricsCache.lastUpdated = new Date().toISOString();

  // ── Push into OS registry ─────────────────────────────────────────────────
  await Promise.allSettled([
    updateStatus('augusto', 'online', {
      conversations_today:   metricsCache.augusto.conversations,
      messages_today:        metricsCache.augusto.messages,
      conversion_rate:       metricsCache.augusto.conversion,
      reached_offer:         metricsCache.augusto.reached_offer,
      avg_session_duration:  metricsCache.augusto.avg_session_duration,
    }),
    updateStatus('paulo', 'online', {
      conversations_today: metricsCache.paulo.conversations,
      qualified_today:     metricsCache.paulo.qualified,
      followups_today:     metricsCache.paulo.followups,
    }),
  ]);
}

/**
 * Scan Redis for active processing locks and emit activity events.
 * Runs every ACTIVITY_POLL_MS milliseconds.
 *
 * Key patterns observed (read-only):
 *   lock:{phone}         — set while Augusto is generating a reply for a lead
 *   conv:{phone}         — conversation context cache
 *   hourly_msgs:{phone}  — rate-limit counter
 *
 * @returns {Promise<void>}
 */
export async function detectActivity() {
  const r = getBridgeRedis();

  try {
    // KEYS is acceptable here because the lock:* keyspace is small and bounded.
    // In a high-cardinality scenario, replace with SCAN cursor iteration.
    const locks = await r.keys('lock:*');

    if (locks.length > 0) {
      // Augusto is actively processing one or more leads
      await updateStatus('augusto', 'busy');
      await publish({
        type: 'agent.activity',
        agentId: 'augusto',
        payload: {
          action: 'Respondendo lead...',
          activeLocks: locks.length,
          ts: new Date().toISOString(),
        },
      });
    } else {
      // No active locks — if Augusto was previously marked busy by the bridge,
      // revert to online so the dashboard does not show a stale busy state.
      const current = await getAgent('augusto');
      if (current?.status === 'busy') {
        await updateStatus('augusto', 'online');
        await publish({
          type: 'agent.activity',
          agentId: 'augusto',
          payload: {
            action: 'Aguardando mensagem...',
            activeLocks: 0,
            ts: new Date().toISOString(),
          },
        });
      }
    }
  } catch (err) {
    console.error('[Bridge] detectActivity error:', err.message);
  }
}
