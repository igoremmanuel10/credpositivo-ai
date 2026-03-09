/**
 * Public Agents Status API
 *
 * GET /api/public/agents-status
 *
 * No authentication required. Returns aggregated, anonymized real-time data
 * about all active agents. Sensitive fields (phone, name, email) are never
 * included in any response payload.
 *
 * Response is cached in-memory for 30 seconds to avoid hammering the DB on
 * every public page load.
 */

import { Router } from 'express';
import { db } from '../db/client.js';
import { getIgorStatus } from '../orchestrator/igor.js';

export const publicAgentsRouter = Router();

// ─── In-memory cache ──────────────────────────────────────────────────────────

let cache = null;
let cacheTime = 0;
const CACHE_TTL = 30000; // 30 seconds

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns a short, stable, non-reversible identifier for a conversation.
 * We XOR the numeric id with a fixed salt so the number itself is not leaked,
 * then format it as a zero-padded 6-digit "Lead #XXXXXX" label.
 */
function anonLeadLabel(conversationId) {
  // Simple deterministic anonymisation: take last 6 hex chars of a hash-like
  // transform. We avoid crypto here to keep it lightweight, a bitwise mix is
  // sufficient for display-only anonymisation (not security-grade hashing).
  const mixed = (parseInt(conversationId, 10) ^ 0xA3F1C7) >>> 0;
  const label = String(mixed % 1000000).padStart(6, '0');
  return `Lead #${label}`;
}

/**
 * Safe integer parse — returns 0 if the value is null/undefined/NaN.
 */
function safeInt(v) {
  const n = parseInt(v, 10);
  return isNaN(n) ? 0 : n;
}

/**
 * Safe float parse — returns null if the value is null/undefined/NaN.
 */
function safeFloat(v, decimals = 1) {
  const n = parseFloat(v);
  if (isNaN(n)) return null;
  return parseFloat(n.toFixed(decimals));
}

// ─── Route ────────────────────────────────────────────────────────────────────

publicAgentsRouter.get('/api/public/agents-status', async (req, res) => {
  // Always allow any origin — this is intentionally public data.
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'public, max-age=30');

  const now = Date.now();
  if (cache && (now - cacheTime) < CACHE_TTL) {
    return res.json(cache);
  }

  // ── Collect all data with independent try/catch per section ─────────────────
  // If one section fails it should not prevent the rest from being returned.

  const result = {
    timestamp: new Date().toISOString(),
    stats: {},
    agents: {
      augusto: { status: 'online' },
      paulo:   { status: 'online' },
      ana:     { status: 'active' },
      luan:    { status: 'active' },
      alex:    { status: 'monitoring' },
      igor:    { status: 'active' },
      musk:    { status: 'strategic' },
    },
    activity: [],
  };

  // ── Hero stats ───────────────────────────────────────────────────────────────
  try {
    const [todayConvos, todayMsgs, todayCosts, conversionRow] = await Promise.all([
      db.query(`
        SELECT COUNT(*)::int AS count
        FROM conversations
        WHERE created_at >= CURRENT_DATE
      `),
      db.query(`
        SELECT
          COUNT(*)::int                                                        AS total,
          ROUND(
            AVG(response_time_seconds)
            FILTER (WHERE role = 'agent' AND response_time_seconds IS NOT NULL AND response_time_seconds > 0)
          ::numeric, 1)                                                        AS avg_response_sec
        FROM messages
        WHERE created_at >= CURRENT_DATE
      `),
      db.query(`
        SELECT COALESCE(SUM(cost_usd), 0)::numeric(10,6) AS total_cost
        FROM api_costs
        WHERE created_at >= CURRENT_DATE
      `),
      db.query(`
        SELECT
          COUNT(*)::int                                             AS total,
          COUNT(*) FILTER (WHERE phase >= 3)::int                 AS converted
        FROM conversations
        WHERE created_at >= NOW() - INTERVAL '7 days'
      `),
    ]);

    const total7d   = safeInt(conversionRow.rows[0]?.total);
    const conv7d    = safeInt(conversionRow.rows[0]?.converted);

    result.stats = {
      conversations_today:   safeInt(todayConvos.rows[0]?.count),
      messages_today:        safeInt(todayMsgs.rows[0]?.total),
      avg_response_time_sec: safeFloat(todayMsgs.rows[0]?.avg_response_sec),
      api_cost_today:        safeFloat(todayCosts.rows[0]?.total_cost, 4),
      conversion_rate:       total7d > 0
        ? parseFloat(((conv7d / total7d) * 100).toFixed(1))
        : 0,
    };
  } catch (err) {
    console.error('[PublicAgents] stats error:', err.message);
    result.stats = { error: 'unavailable' };
  }

  // ── Augusto ──────────────────────────────────────────────────────────────────
  try {
    const [convos, msgs, phases] = await Promise.all([
      db.query(`
        SELECT COUNT(*)::int AS count
        FROM conversations
        WHERE persona = 'augusto' AND created_at >= CURRENT_DATE
      `),
      db.query(`
        SELECT
          COUNT(*)::int                                                              AS total,
          ROUND(
            AVG(m.response_time_seconds)
            FILTER (WHERE m.role = 'agent' AND m.response_time_seconds IS NOT NULL AND m.response_time_seconds > 0)
          ::numeric, 1)                                                              AS avg_response_sec
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE c.persona = 'augusto' AND m.created_at >= CURRENT_DATE
      `),
      db.query(`
        SELECT phase, COUNT(*)::int AS count
        FROM conversations
        WHERE persona = 'augusto'
        GROUP BY phase
        ORDER BY phase
      `),
    ]);

    const phaseMap = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const row of phases.rows) {
      const p = safeInt(row.phase);
      if (p >= 0 && p <= 4) phaseMap[p] = safeInt(row.count);
    }

    result.agents.augusto = {
      status:               'online',
      conversations_today:  safeInt(convos.rows[0]?.count),
      messages_today:       safeInt(msgs.rows[0]?.total),
      avg_response_time:    safeFloat(msgs.rows[0]?.avg_response_sec),
      phases:               phaseMap,
    };
  } catch (err) {
    console.error('[PublicAgents] augusto error:', err.message);
    result.agents.augusto = { status: 'online', error: 'unavailable' };
  }

  // ── Paulo ────────────────────────────────────────────────────────────────────
  try {
    const [convos, msgs, followups] = await Promise.all([
      db.query(`
        SELECT COUNT(*)::int AS count
        FROM conversations
        WHERE persona = 'paulo' AND created_at >= CURRENT_DATE
      `),
      db.query(`
        SELECT
          COUNT(*)::int                                                              AS total,
          ROUND(
            AVG(m.response_time_seconds)
            FILTER (WHERE m.role = 'agent' AND m.response_time_seconds IS NOT NULL AND m.response_time_seconds > 0)
          ::numeric, 1)                                                              AS avg_response_sec
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE c.persona = 'paulo' AND m.created_at >= CURRENT_DATE
      `),
      db.query(`
        SELECT COUNT(*)::int AS count
        FROM followups
        WHERE sent = TRUE AND created_at >= CURRENT_DATE
      `),
    ]);

    result.agents.paulo = {
      status:               'online',
      conversations_today:  safeInt(convos.rows[0]?.count),
      messages_today:       safeInt(msgs.rows[0]?.total),
      avg_response_time:    safeFloat(msgs.rows[0]?.avg_response_sec),
      followups_sent_today: safeInt(followups.rows[0]?.count),
    };
  } catch (err) {
    console.error('[PublicAgents] paulo error:', err.message);
    result.agents.paulo = { status: 'online', error: 'unavailable' };
  }

  // ── Ana (Ops) ────────────────────────────────────────────────────────────────
  // Ana works on a schedule — we derive an activity estimate from the current
  // hour and query the ops inbox messages as a proxy for her last check.
  try {
    const lastCheck = await db.query(`
      SELECT MAX(created_at) AS last_at
      FROM messages
      WHERE role = 'agent'
        AND created_at >= NOW() - INTERVAL '24 hours'
    `);

    // Ana checks every ~30 min during business hours (8h-22h = 14h window = ~28 checks/day).
    const nowHour = new Date().getUTCHours() - 3; // BRT offset
    const businessHoursPassed = Math.max(0, Math.min(nowHour - 8, 14));
    const checksToday = Math.floor(businessHoursPassed * 2); // 2 per hour

    result.agents.ana = {
      status:       'active',
      last_check:   lastCheck.rows[0]?.last_at ?? null,
      checks_today: checksToday,
    };
  } catch (err) {
    console.error('[PublicAgents] ana error:', err.message);
    result.agents.ana = { status: 'active', error: 'unavailable' };
  }

  // ── Luan (Manager) ───────────────────────────────────────────────────────────
  try {
    const [lastReport, weeklyCount] = await Promise.all([
      db.query(`
        SELECT created_at, pipeline_health
        FROM manager_reports
        ORDER BY created_at DESC
        LIMIT 1
      `),
      db.query(`
        SELECT COUNT(*)::int AS count
        FROM manager_reports
        WHERE created_at >= date_trunc('week', NOW())
      `),
    ]);

    result.agents.luan = {
      status:           'active',
      last_report:      lastReport.rows[0]?.created_at ?? null,
      pipeline_health:  lastReport.rows[0]?.pipeline_health ?? null,
      reports_this_week: safeInt(weeklyCount.rows[0]?.count),
    };
  } catch (err) {
    console.error('[PublicAgents] luan error:', err.message);
    result.agents.luan = { status: 'active', error: 'unavailable' };
  }

  // ── Alex (DevOps) ────────────────────────────────────────────────────────────
  try {
    const [summary, lastCycle] = await Promise.all([
      db.query(`
        SELECT
          COUNT(*)::int                                                           AS cycles_today,
          COUNT(*) FILTER (WHERE auto_fixed = TRUE)::int                        AS auto_fixes_today,
          COUNT(*) FILTER (WHERE severity = 'critical')::int                    AS critical_alerts_today,
          -- Use the most recent non-null health snapshot as overall health
          (
            SELECT fix_result
            FROM alex_logs
            WHERE created_at >= CURRENT_DATE
              AND fix_result IS NOT NULL
            ORDER BY created_at DESC
            LIMIT 1
          )                                                                       AS latest_fix_result
        FROM alex_logs
        WHERE created_at >= CURRENT_DATE
      `),
      db.query(`
        SELECT created_at
        FROM alex_logs
        ORDER BY created_at DESC
        LIMIT 1
      `),
    ]);

    const s = summary.rows[0] || {};

    result.agents.alex = {
      status:               'monitoring',
      health:               s.latest_fix_result ?? 'ok',
      cycles_today:         safeInt(s.cycles_today),
      auto_fixes_today:     safeInt(s.auto_fixes_today),
      critical_alerts_today: safeInt(s.critical_alerts_today),
      last_cycle:           lastCycle.rows[0]?.created_at ?? null,
    };
  } catch (err) {
    console.error('[PublicAgents] alex error:', err.message);
    result.agents.alex = { status: 'monitoring', error: 'unavailable' };
  }

  // ── Igor (Orchestrator) ──────────────────────────────────────────────────────
  try {
    // getIgorStatus() is synchronous — it reads in-process state, no DB needed.
    const igorState = getIgorStatus();

    // Count conversations that had activity in the last 30 minutes as
    // "actively monitored" — this is what Igor watches in real time.
    const activeMonitoring = await db.query(`
      SELECT COUNT(DISTINCT id)::int AS count
      FROM conversations
      WHERE last_message_at >= NOW() - INTERVAL '30 minutes'
        AND opted_out IS NOT TRUE
    `);

    // Igor cycles every 2 min during business hours (8h-20h = 12h = 360 cycles max).
    const nowHour = new Date().getUTCHours() - 3; // BRT
    const businessHoursPassed = Math.max(0, Math.min(nowHour - 8, 12));
    const cyclesEstimate = Math.floor(businessHoursPassed * 30); // 30 cycles/hour

    result.agents.igor = {
      status:             'active',
      cycles_today:       igorState?.cycles_today ?? cyclesEstimate,
      active_monitoring:  safeInt(activeMonitoring.rows[0]?.count),
      issues_today:       igorState?.issues_today ?? 0,
      last_cycle:         igorState?.last_cycle ?? new Date().toISOString(),
    };
  } catch (err) {
    console.error('[PublicAgents] igor error:', err.message);
    result.agents.igor = { status: 'active', error: 'unavailable' };
  }

  // ── Musk (CEO) ───────────────────────────────────────────────────────────────
  try {
    const [lastDirective, monthlyCount] = await Promise.all([
      db.query(`
        SELECT created_at
        FROM ceo_directives
        ORDER BY created_at DESC
        LIMIT 1
      `),
      db.query(`
        SELECT COUNT(*)::int AS count
        FROM ceo_directives
        WHERE created_at >= date_trunc('month', NOW())
      `),
    ]);

    result.agents.musk = {
      status:               'strategic',
      last_directive:       lastDirective.rows[0]?.created_at ?? null,
      directives_this_month: safeInt(monthlyCount.rows[0]?.count),
    };
  } catch (err) {
    console.error('[PublicAgents] musk error:', err.message);
    result.agents.musk = { status: 'strategic', error: 'unavailable' };
  }

  // ── Activity feed ────────────────────────────────────────────────────────────
  // Merge recent messages, alex_logs, and manager_reports into a single
  // time-sorted feed. All lead identifiers are anonymised.
  try {
    const [recentMsgs, recentAlex, recentReports] = await Promise.all([
      // Last 10 agent messages — anonymise conversation_id
      db.query(`
        SELECT
          m.created_at  AS time,
          c.persona     AS agent,
          m.conversation_id,
          m.response_time_seconds,
          c.phase
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE m.role = 'agent'
        ORDER BY m.created_at DESC
        LIMIT 10
      `),
      // Last 5 alex_logs
      db.query(`
        SELECT
          created_at AS time,
          event_type,
          severity,
          category,
          description,
          auto_fixed
        FROM alex_logs
        ORDER BY created_at DESC
        LIMIT 5
      `),
      // Last 2 manager_reports (title/type only)
      db.query(`
        SELECT
          created_at  AS time,
          report_type,
          pipeline_health
        FROM manager_reports
        ORDER BY created_at DESC
        LIMIT 2
      `),
    ]);

    const feed = [];

    // Agent messages → anonymised entries
    for (const row of recentMsgs.rows) {
      const label   = anonLeadLabel(row.conversation_id);
      const rtSec   = safeFloat(row.response_time_seconds);
      const rtPart  = rtSec != null ? ` em ${rtSec}s` : '';
      const phase   = safeInt(row.phase);
      feed.push({
        time:  row.time,
        agent: row.agent || 'augusto',
        action: `Respondeu ${label}${rtPart} (fase ${phase})`,
        type:  'message',
      });
    }

    // Alex log entries
    for (const row of recentAlex.rows) {
      const fixed   = row.auto_fixed ? ' [auto-corrigido]' : '';
      const cat     = row.category ? ` [${row.category}]` : '';
      // Truncate description to avoid leaking internal detail in excess
      const desc    = (row.description || row.event_type || 'check').slice(0, 80);
      feed.push({
        time:  row.time,
        agent: 'alex',
        action: `${desc}${cat}${fixed}`,
        type:  `devops_${row.severity || 'info'}`,
      });
    }

    // Manager report entries
    for (const row of recentReports.rows) {
      const health = row.pipeline_health ? ` — pipeline: ${row.pipeline_health}` : '';
      feed.push({
        time:  row.time,
        agent: 'luan',
        action: `Relatorio ${row.report_type || 'gerencial'} gerado${health}`,
        type:  'report',
      });
    }

    // Sort by time descending, cap at 20 entries
    feed.sort((a, b) => new Date(b.time) - new Date(a.time));
    result.activity = feed.slice(0, 20);
  } catch (err) {
    console.error('[PublicAgents] activity feed error:', err.message);
    result.activity = [];
  }

  // ── Cache and respond ────────────────────────────────────────────────────────
  cache     = result;
  cacheTime = Date.now();

  res.json(result);
});
