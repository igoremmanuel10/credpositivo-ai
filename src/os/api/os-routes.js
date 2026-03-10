/**
 * @file os-routes.js
 * @description Express router exposing the AI OS kernel over HTTP and SSE.
 *
 * Mount with:
 *   import { osRouter } from './src/os/api/os-routes.js';
 *   app.use('/api/os', osRouter);
 *
 * Endpoints:
 *   GET  /api/os/status           Overall OS status
 *   GET  /api/os/agents           All agents with current status
 *   GET  /api/os/agents/:id       Single agent details + stats
 *   POST /api/os/agents/:id/control  Start / stop / restart agent
 *   GET  /api/os/events           Recent events (ring buffer)
 *   GET  /api/os/events/stream    SSE — real-time event stream
 *   GET  /api/os/metrics          System-wide metrics aggregation
 *   GET  /api/os/pixel-state      Pixel dashboard payload
 */

import { Router } from 'express';
import {
  getAllAgents,
  getAgent,
  updateStatus,
  getAgentStats,
} from '../kernel/registry.js';
import {
  getHistory as getEventHistory,
  subscribeAll,
  publish,
} from '../kernel/event-bus.js';
import { listJobs, getUsage } from '../kernel/scheduler.js';
import { getMetricsCache } from '../bridge.js';

export const osRouter = Router();

// ─── GET /status ─────────────────────────────────────────────────────────────

/**
 * Overall OS health — agent counts, uptime, kernel component status.
 */
osRouter.get('/status', async (req, res) => {
  try {
    const agents = await getAllAgents();
    const online = agents.filter((a) => a.status === 'online' || a.status === 'busy').length;
    const offline = agents.filter((a) => a.status === 'offline').length;
    const error = agents.filter((a) => a.status === 'error').length;
    const jobs = listJobs();

    res.json({
      ok: true,
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      agents: {
        total: agents.length,
        online,
        offline,
        error,
      },
      scheduler: {
        jobs: jobs.length,
      },
      kernel: {
        eventBus: 'running',
        registry: 'running',
        scheduler: 'running',
        loopGuard: 'running',
      },
    });
  } catch (err) {
    console.error('[OS API] /status error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /agents ──────────────────────────────────────────────────────────────

/**
 * List all agents with their current runtime status and metrics config.
 * Real KPIs from PostgreSQL are merged in from the bridge metrics cache.
 */
osRouter.get('/agents', async (req, res) => {
  try {
    const agents = await getAllAgents();
    const cache = getMetricsCache();
    const enriched = agents.map((agent) => mergeRealMetrics(agent, cache));
    res.json({ ok: true, agents: enriched });
  } catch (err) {
    console.error('[OS API] /agents error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /agents/:id ──────────────────────────────────────────────────────────

/**
 * Single agent: full manifest + runtime stats + current quota usage.
 * Real KPIs from PostgreSQL are merged in from the bridge metrics cache.
 */
osRouter.get('/agents/:id', async (req, res) => {
  try {
    const agent = await getAgent(req.params.id);
    if (!agent) {
      return res.status(404).json({ ok: false, error: `Agent "${req.params.id}" not found` });
    }

    const [stats, quota] = await Promise.all([
      getAgentStats(req.params.id),
      getUsage(req.params.id),
    ]);

    const cache = getMetricsCache();
    const enrichedAgent = mergeRealMetrics(agent, cache);

    res.json({ ok: true, agent: enrichedAgent, stats, quota });
  } catch (err) {
    console.error('[OS API] /agents/:id error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /agents/:id/control ─────────────────────────────────────────────────

/**
 * Control an agent lifecycle.
 *
 * Body: { "action": "start" | "stop" | "restart" }
 */
osRouter.post('/agents/:id/control', async (req, res) => {
  const { id } = req.params;
  const { action } = req.body || {};

  const validActions = new Set(['start', 'stop', 'restart']);
  if (!validActions.has(action)) {
    return res.status(400).json({
      ok: false,
      error: `Invalid action "${action}". Must be one of: start, stop, restart`,
    });
  }

  try {
    const agent = await getAgent(id);
    if (!agent) {
      return res.status(404).json({ ok: false, error: `Agent "${id}" not found` });
    }

    let newStatus;
    if (action === 'start' || action === 'restart') {
      newStatus = 'online';
    } else {
      newStatus = 'offline';
    }

    await updateStatus(id, newStatus, { controlledBy: 'api', controlAction: action });

    // Publish lifecycle event to the bus
    await publish({
      type: `agent.${action}`,
      agentId: id,
      payload: { action, previousStatus: agent.status, newStatus },
    });

    res.json({
      ok: true,
      agentId: id,
      action,
      status: newStatus,
      ts: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`[OS API] /agents/${id}/control error:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /events ──────────────────────────────────────────────────────────────

/**
 * Retrieve recent events from the ring buffer.
 * Query params:
 *   ?limit=50   Number of events to return (max 1000, default 50)
 */
osRouter.get('/events', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 1000);
    const events = await getEventHistory(limit);
    res.json({ ok: true, count: events.length, events });
  } catch (err) {
    console.error('[OS API] /events error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /events/stream (SSE) ─────────────────────────────────────────────────

/**
 * Server-Sent Events endpoint — streams events in real time to the client.
 *
 * Clients connect and receive a continuous stream of newline-delimited
 * `data: <JSON>\n\n` frames. The last 10 events from the ring buffer are
 * replayed immediately on connect for context.
 */
osRouter.get('/events/stream', async (req, res) => {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();

  /**
   * Write a single SSE frame.
   * @param {string} event - SSE event name
   * @param {Object} data  - JSON-serializable payload
   */
  const sendEvent = (event, data) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      // Client disconnected mid-write — ignore
    }
  };

  // Send a heartbeat comment every 25s to keep connection alive through proxies
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 25000);

  // Replay the last 10 events for immediate context
  try {
    const recent = await getEventHistory(10);
    recent.reverse().forEach((evt) => sendEvent('event', evt));
  } catch {
    // Non-fatal — just skip replay
  }

  // Subscribe to all future events
  let unsubscribe;
  try {
    unsubscribe = await subscribeAll((event) => sendEvent('event', event));
  } catch (err) {
    console.error('[OS API] SSE subscribeAll error:', err.message);
    sendEvent('error', { message: 'Failed to subscribe to event bus' });
    res.end();
    clearInterval(heartbeat);
    return;
  }

  sendEvent('connected', {
    message: 'Connected to OS event stream',
    ts: new Date().toISOString(),
  });

  // Clean up when client disconnects
  req.on('close', () => {
    clearInterval(heartbeat);
    if (typeof unsubscribe === 'function') unsubscribe();
    console.log('[OS API] SSE client disconnected');
  });
});

// ─── GET /metrics ─────────────────────────────────────────────────────────────

/**
 * Aggregate system-wide metrics across all agents.
 */
osRouter.get('/metrics', async (req, res) => {
  try {
    const agents = await getAllAgents();

    const aggregated = {
      totalAgents: agents.length,
      byStatus: {},
      quotaUsage: [],
    };

    // Count agents by status
    for (const agent of agents) {
      const s = agent.status || 'unknown';
      aggregated.byStatus[s] = (aggregated.byStatus[s] || 0) + 1;
    }

    // Collect quota usage for each agent
    const quotaPromises = agents.map((a) =>
      getUsage(a.id).then((q) => ({ agentId: a.id, ...q })).catch(() => null)
    );
    const quotas = await Promise.all(quotaPromises);
    aggregated.quotaUsage = quotas.filter(Boolean);

    const totalTokensUsed = aggregated.quotaUsage.reduce((sum, q) => sum + q.used, 0);
    aggregated.totalTokensUsedThisHour = totalTokensUsed;

    res.json({ ok: true, ts: new Date().toISOString(), metrics: aggregated });
  } catch (err) {
    console.error('[OS API] /metrics error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /pixel-state ─────────────────────────────────────────────────────────

/**
 * Pixel dashboard optimized payload.
 *
 * Returns each agent's visual state (animation, position, chat bubble, metrics)
 * plus a minimal office context object. Real KPIs from PostgreSQL are merged
 * into every agent's metrics field via the bridge cache.
 */
osRouter.get('/pixel-state', async (req, res) => {
  try {
    const agents = await getAllAgents();
    const cache = getMetricsCache();

    const pixelAgents = agents.map((agent) => {
      const enriched = mergeRealMetrics(agent, cache);
      const pixel = enriched.pixel || {};
      const metrics = enriched.metrics || {};

      // Pick animation based on current status
      let animation;
      switch (enriched.status) {
        case 'busy':
          animation = pixel.active_animation || 'active';
          break;
        case 'idle':
          animation = pixel.break_animation || 'idle';
          break;
        case 'offline':
        case 'error':
          animation = 'offline';
          break;
        default:
          animation = pixel.idle_animation || 'idle';
      }

      // Pick a random bubble template based on status
      const bubbleTemplates = pixel.bubble_templates || [];
      const bubble =
        enriched.status === 'busy' && bubbleTemplates.length > 0
          ? bubbleTemplates[Math.floor(Math.random() * bubbleTemplates.length)]
          : null;

      // Map desk_position to a pixel coordinate (40px grid, 2 columns)
      const pos = pixel.desk_position || 1;
      const col = (pos - 1) % 2;
      const row = Math.floor((pos - 1) / 2);
      const position = { x: 120 + col * 240, y: 100 + row * 180 };

      return {
        id: enriched.id,
        name: enriched.name,
        role: enriched.role,
        color: enriched.color,
        icon: enriched.icon,
        status: enriched.status,
        animation,
        position,
        bubble,
        lastActivity: enriched.lastActivity,
        metrics,
      };
    });

    // Simple time-of-day calculation (America/Sao_Paulo UTC-3)
    const hourUTC = new Date().getUTCHours();
    const hourLocal = (hourUTC - 3 + 24) % 24;
    const timeOfDay = hourLocal >= 6 && hourLocal < 18 ? 'day' : 'night';

    res.json({
      ok: true,
      ts: new Date().toISOString(),
      metricsLastUpdated: cache.lastUpdated,
      agents: pixelAgents,
      office: {
        time: timeOfDay,
        weather: 'sunny',
        activeCount: pixelAgents.filter((a) => a.status === 'busy' || a.status === 'online').length,
      },
    });
  } catch (err) {
    console.error('[OS API] /pixel-state error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Merge real database metrics from the bridge cache into an agent record.
 *
 * The bridge stores KPIs inside the agent's Redis hash under individual fields
 * (conversations_today, etc.), but the registry deserialises the `metrics`
 * field as a plain object blob.  This helper promotes the bridge KPI fields
 * that are known for each agent into the `metrics` object so they appear in
 * every API response automatically.
 *
 * The function is non-mutating — it returns a shallow clone with a new
 * `metrics` object; the original agent record is untouched.
 *
 * @param {Object} agent  - Deserialized agent record from the registry
 * @param {import('../bridge.js').metricsCache} cache - Bridge metrics snapshot
 * @returns {Object} Agent record with real metrics overlaid
 */
function mergeRealMetrics(agent, cache) {
  const existing = typeof agent.metrics === 'object' && agent.metrics !== null
    ? agent.metrics
    : {};

  let realMetrics = {};

  if (agent.id === 'augusto') {
    realMetrics = {
      conversations_today:  cache.augusto.conversations,
      messages_today:       cache.augusto.messages,
      conversion_rate:      Number(cache.augusto.conversion.toFixed(1)),
      reached_offer:        cache.augusto.reached_offer,
      avg_session_duration: Math.round(cache.augusto.avg_session_duration),
      avg_response_time:    Number(cache.system.avgResponseTime.toFixed(1)),
    };
  } else if (agent.id === 'paulo') {
    realMetrics = {
      conversations_today: cache.paulo.conversations,
      qualified_today:     cache.paulo.qualified,
      followups_today:     cache.paulo.followups,
    };
  }

  return {
    ...agent,
    metrics: { ...existing, ...realMetrics },
  };
}
