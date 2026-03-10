/**
 * @file src/os/api/admin-routes.js
 * @description REST endpoints for the AI OS admin panel.
 *
 * Mount with:
 *   import { adminRouter } from './api/admin-routes.js';
 *   app.use('/api/os/admin', requireAdmin, adminRouter);
 *
 * All routes are protected upstream by the requireAdmin JWT middleware.
 * An additional role check (`req.admin.role !== 'viewer'`) blocks write
 * operations for embed-key sessions.
 *
 * Endpoint surface
 * ──────────────────────────────────────────────────────────────────────────────
 * Prompts
 *   GET  /prompts                  List all agent prompt overrides
 *   GET  /prompts/:agentId         Get one agent's active prompt override
 *   PUT  /prompts/:agentId         Set / update a prompt override (Redis-backed)
 *   DELETE /prompts/:agentId       Remove override (falls back to compiled code)
 *
 * Workflows
 *   GET  /workflows                List all rules (static + dynamic) with stats
 *   POST /workflows                Create a new dynamic rule
 *   PUT  /workflows/:ruleId        Update a dynamic rule
 *   DELETE /workflows/:ruleId      Delete a dynamic rule
 *   POST /workflows/:ruleId/test   Test-fire a rule with a mock event payload
 *
 * Schedules
 *   GET  /schedules                List agent schedules (manifest + overrides)
 *   PUT  /schedules/:agentId       Override agent's cron expression
 *   DELETE /schedules/:agentId     Remove override (restores manifest default)
 *
 * Logs / Event History
 *   GET  /logs                     Paginated, filterable event history
 *   GET  /logs/:agentId            Events for a single agent
 *
 * Config
 *   GET  /config                   Current OS configuration
 *   PUT  /config                   Update OS configuration
 *
 * Notifications
 *   GET  /notifications            Notification settings
 *   PUT  /notifications            Update notification settings
 */

import { Router } from 'express';
import Redis from 'ioredis';
import cron from 'node-cron';
import 'dotenv/config';

import { getAllAgents, getAgent } from '../kernel/registry.js';
import { getHistory as getEventHistory } from '../kernel/event-bus.js';
import { listJobs, scheduleJob } from '../kernel/scheduler.js';
import {
  getRules,
  addRule,
  updateRule,
  removeRule,
} from '../engine/workflows.js';
import {
  getNotificationSettings,
  updateNotificationSettings,
} from '../notifications/telegram.js';

export const adminRouter = Router();

// ─── Redis ────────────────────────────────────────────────────────────────────

/** @type {Redis | null} */
let redisClient = null;

function getRedis() {
  if (!redisClient) {
    redisClient = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: true,
    });
    redisClient.on('error', (err) => {
      console.error('[Admin API] Redis error:', err.message);
    });
  }
  return redisClient;
}

// ─── Redis key helpers ────────────────────────────────────────────────────────

const PROMPT_KEY = (agentId) => `os:prompts:${agentId}`;
const SCHEDULE_KEY = (agentId) => `os:schedules:${agentId}`;
const CONFIG_KEY = 'os:config';
const NOTIFICATIONS_KEY = 'os:notifications';

// ─── Guard: reject viewer-role writes ────────────────────────────────────────

/**
 * Middleware applied to all mutating endpoints.
 * The embed-key session gets role='viewer' from requireAdmin — it is
 * read-only and must not be able to change prompts, rules, etc.
 */
function requireWriteAccess(req, res, next) {
  if (req.admin?.role === 'viewer') {
    return res.status(403).json({
      ok: false,
      error: 'Viewer sessions do not have write access to admin endpoints',
    });
  }
  next();
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  healthCheckIntervalMs: 60000,
  bridgePollIntervalMs: 30000,
  defaultHourlyQuota: 100000,
  agentQuotas: {},
  loopGuardMaxDepth: 5,
  loopGuardWindowMs: 60000,
  maintenanceMode: false,
};

const DEFAULT_NOTIFICATIONS = {
  enabled: true,
  whatsappAdminPhone: process.env.ADMIN_PHONE || '',
  triggerEvents: [
    'agent.stall_recovered',
    'workflow.alert',
    'workflow.escalation',
    'os.boot',
    'os.shutdown',
  ],
  muteUntil: null,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse a JSON string coming from Redis; return fallback if invalid.
 * @param {string|null} raw
 * @param {*} fallback
 */
function tryParse(raw, fallback) {
  try {
    return JSON.parse(raw || 'null') ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Validate a cron expression string.
 * @param {string} expr
 * @returns {boolean}
 */
function isValidCron(expr) {
  return cron.validate(expr);
}

/**
 * Convert a ?page / ?limit query string pair into {skip, limit}.
 * @param {object} query
 */
function pagination(query) {
  const limit = Math.min(Math.max(parseInt(query.limit || '50', 10), 1), 1000);
  const page  = Math.max(parseInt(query.page  || '1',  10), 1);
  const skip  = (page - 1) * limit;
  return { page, limit, skip };
}

// ─────────────────────────────────────────────────────────────────────────────
//  PROMPTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/os/admin/prompts
 *
 * Returns all agents with information about whether a prompt override exists
 * in Redis.  The actual override text is included for each agent that has one.
 *
 * Response 200:
 *   {
 *     ok: true,
 *     prompts: [
 *       {
 *         agentId:       "augusto",
 *         agentName:     "Augusto",
 *         hasOverride:   true,
 *         overrideText:  "...",
 *         overrideSetAt: "2026-03-10T12:00:00.000Z",
 *         note:          "Augusto's prompt is built dynamically from modular files in src/ai/prompts/."
 *       },
 *       ...
 *     ]
 *   }
 */
adminRouter.get('/prompts', async (req, res) => {
  try {
    const agents = await getAllAgents();
    const r = getRedis();

    const results = await Promise.all(
      agents.map(async (agent) => {
        const raw = await r.get(PROMPT_KEY(agent.id));
        const stored = tryParse(raw, null);

        return {
          agentId:       agent.id,
          agentName:     agent.name,
          role:          agent.role,
          hasOverride:   stored !== null,
          overrideText:  stored?.text  ?? null,
          overrideSetAt: stored?.setAt ?? null,
          note:          promptNote(agent.id),
        };
      })
    );

    res.json({ ok: true, prompts: results });
  } catch (err) {
    console.error('[Admin API] GET /prompts error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/os/admin/prompts/:agentId
 *
 * Returns the active prompt override for a single agent.
 *
 * Response 200:
 *   { ok: true, agentId, hasOverride, overrideText, overrideSetAt, note }
 * Response 404:
 *   { ok: false, error: "Agent not found" }
 */
adminRouter.get('/prompts/:agentId', async (req, res) => {
  try {
    const { agentId } = req.params;
    const agent = await getAgent(agentId);
    if (!agent) {
      return res.status(404).json({ ok: false, error: `Agent "${agentId}" not found` });
    }

    const raw = await getRedis().get(PROMPT_KEY(agentId));
    const stored = tryParse(raw, null);

    res.json({
      ok: true,
      agentId,
      agentName:     agent.name,
      hasOverride:   stored !== null,
      overrideText:  stored?.text  ?? null,
      overrideSetAt: stored?.setAt ?? null,
      note:          promptNote(agentId),
    });
  } catch (err) {
    console.error('[Admin API] GET /prompts/:agentId error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * PUT /api/os/admin/prompts/:agentId
 *
 * Create or replace the prompt override for an agent.
 * The agent code must call getPromptOverride(agentId) to pick up the override
 * at runtime — no restart needed (hot reload via Redis).
 *
 * Body:
 *   { "text": "You are Augusto..." }
 *
 * Response 200:
 *   { ok: true, agentId, overrideSetAt }
 */
adminRouter.put('/prompts/:agentId', requireWriteAccess, async (req, res) => {
  try {
    const { agentId } = req.params;
    const { text } = req.body || {};

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({ ok: false, error: '"text" must be a non-empty string' });
    }
    if (text.length > 32_000) {
      return res.status(400).json({ ok: false, error: 'Prompt text exceeds maximum of 32,000 characters' });
    }

    const agent = await getAgent(agentId);
    if (!agent) {
      return res.status(404).json({ ok: false, error: `Agent "${agentId}" not found` });
    }

    const setAt = new Date().toISOString();
    await getRedis().set(
      PROMPT_KEY(agentId),
      JSON.stringify({ text: text.trim(), setAt, setBy: req.admin?.email || 'unknown' })
    );

    console.log(`[Admin API] Prompt override set for agent "${agentId}" by ${req.admin?.email}`);

    res.json({ ok: true, agentId, overrideSetAt: setAt });
  } catch (err) {
    console.error('[Admin API] PUT /prompts/:agentId error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * DELETE /api/os/admin/prompts/:agentId
 *
 * Remove the prompt override for an agent.
 * The agent will fall back to its compiled default prompt on the next invocation.
 *
 * Response 200:
 *   { ok: true, agentId, message: "Override removed" }
 */
adminRouter.delete('/prompts/:agentId', requireWriteAccess, async (req, res) => {
  try {
    const { agentId } = req.params;
    const agent = await getAgent(agentId);
    if (!agent) {
      return res.status(404).json({ ok: false, error: `Agent "${agentId}" not found` });
    }

    const deleted = await getRedis().del(PROMPT_KEY(agentId));

    res.json({
      ok: true,
      agentId,
      message: deleted ? 'Override removed — agent will use its default prompt' : 'No override was set',
    });
  } catch (err) {
    console.error('[Admin API] DELETE /prompts/:agentId error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  WORKFLOWS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/os/admin/workflows
 *
 * List all workflow rules — static (built-in) and dynamic (stored in Redis) —
 * with execution statistics.
 *
 * Response 200:
 *   {
 *     ok: true,
 *     running: true,
 *     staticCount: 6,
 *     dynamicCount: 2,
 *     rules: [...]
 *   }
 */
adminRouter.get('/workflows', async (req, res) => {
  try {
    const stats = await getRules();
    res.json({ ok: true, ...stats });
  } catch (err) {
    console.error('[Admin API] GET /workflows error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/os/admin/workflows
 *
 * Create a new dynamic workflow rule.
 *
 * Body:
 *   {
 *     "id":           "my-custom-rule",
 *     "name":         "My Custom Rule",
 *     "triggerType":  "agent.tick",
 *     "conditionJs":  "event.agentId === 'paulo'",
 *     "actionType":   "publish",
 *     "actionPayload": {
 *       "type": "workflow.custom",
 *       "agentId": "luan",
 *       "payload": { "message": "Paulo ticked" }
 *     },
 *     "enabled": true
 *   }
 *
 * Response 201:
 *   { ok: true, rule: { ...newRule } }
 */
adminRouter.post('/workflows', requireWriteAccess, async (req, res) => {
  try {
    const rule = req.body;
    if (!rule || typeof rule !== 'object') {
      return res.status(400).json({ ok: false, error: 'Request body must be a JSON object' });
    }

    const created = await addRule(rule);
    res.status(201).json({ ok: true, rule: created });
  } catch (err) {
    const status = err.message.includes('already exists') ? 409 : 400;
    console.error('[Admin API] POST /workflows error:', err.message);
    res.status(status).json({ ok: false, error: err.message });
  }
});

/**
 * PUT /api/os/admin/workflows/:ruleId
 *
 * Update a dynamic rule. Static built-in rules cannot be modified.
 *
 * Body: Partial dynamic rule fields (id, createdAt are ignored).
 *
 * Response 200:
 *   { ok: true, rule: { ...updatedRule } }
 */
adminRouter.put('/workflows/:ruleId', requireWriteAccess, async (req, res) => {
  try {
    const { ruleId } = req.params;
    const updates = req.body;

    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({ ok: false, error: 'Request body must be a JSON object' });
    }

    const updated = await updateRule(ruleId, updates);
    res.json({ ok: true, rule: updated });
  } catch (err) {
    const status = err.message.includes('not found') ? 404
                 : err.message.includes('static') ? 403
                 : 400;
    console.error('[Admin API] PUT /workflows/:ruleId error:', err.message);
    res.status(status).json({ ok: false, error: err.message });
  }
});

/**
 * DELETE /api/os/admin/workflows/:ruleId
 *
 * Delete a dynamic rule. Static built-in rules cannot be deleted.
 *
 * Response 200:
 *   { ok: true, ruleId, message: "Rule deleted" }
 */
adminRouter.delete('/workflows/:ruleId', requireWriteAccess, async (req, res) => {
  try {
    const { ruleId } = req.params;
    await removeRule(ruleId);
    res.json({ ok: true, ruleId, message: 'Rule deleted' });
  } catch (err) {
    const status = err.message.includes('not found') ? 404
                 : err.message.includes('static') ? 403
                 : 400;
    console.error('[Admin API] DELETE /workflows/:ruleId error:', err.message);
    res.status(status).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/os/admin/workflows/:ruleId/test
 *
 * Test a rule by evaluating its condition against a mock event and (optionally)
 * running its action in dry-run mode.
 *
 * Body:
 *   {
 *     "mockEvent": {
 *       "type": "agent.tick",
 *       "agentId": "paulo",
 *       "payload": { "foo": "bar" }
 *     },
 *     "dryRun": true   — if false, the action will actually fire (default: true)
 *   }
 *
 * Response 200:
 *   {
 *     ok: true,
 *     ruleId,
 *     conditionResult: true,
 *     wouldFire: true,
 *     actionFired: false,
 *     dryRun: true
 *   }
 */
adminRouter.post('/workflows/:ruleId/test', requireWriteAccess, async (req, res) => {
  try {
    const { ruleId } = req.params;
    const { mockEvent, dryRun = true } = req.body || {};

    if (!mockEvent || typeof mockEvent !== 'object') {
      return res.status(400).json({ ok: false, error: '"mockEvent" must be a JSON object' });
    }

    const event = {
      type: mockEvent.type || 'test.event',
      agentId: mockEvent.agentId || null,
      payload: mockEvent.payload || {},
      ts: Date.now(),
    };

    // Locate the rule — search both static and dynamic sets
    const { rules } = await getRules();
    const ruleMeta = rules.find((r) => r.id === ruleId);
    if (!ruleMeta) {
      return res.status(404).json({ ok: false, error: `Rule "${ruleId}" not found` });
    }

    // Evaluate trigger type match
    const triggerMatches = ruleMeta.triggerType === event.type;

    // Evaluate condition for dynamic rules (static conditions are JS functions — not serialized)
    let conditionResult = null;
    if (ruleMeta.source === 'dynamic' && ruleMeta.conditionJs) {
      try {
        // eslint-disable-next-line no-new-func
        conditionResult = !!(new Function('event', `return !!(${ruleMeta.conditionJs})`)(event));
      } catch (err) {
        return res.status(422).json({
          ok: false,
          error: `conditionJs evaluation failed: ${err.message}`,
        });
      }
    } else {
      // Static rules — we can only report whether the trigger type matches
      conditionResult = triggerMatches ? '(static — evaluated at runtime)' : false;
    }

    const wouldFire = triggerMatches && conditionResult !== false;
    let actionFired = false;
    let actionError = null;

    if (wouldFire && !dryRun && ruleMeta.source === 'dynamic') {
      try {
        // Re-import publish here to avoid circular reference issues at module level
        const { publish } = await import('../kernel/event-bus.js');
        const { actionType, actionPayload } = ruleMeta;

        if (actionType === 'publish') {
          await publish({
            type: actionPayload?.type || 'workflow.dynamic',
            agentId: actionPayload?.agentId || null,
            payload: { ...(actionPayload?.payload || {}), _test: true, _ruleId: ruleId },
          });
        }
        actionFired = true;
      } catch (err) {
        actionError = err.message;
      }
    }

    res.json({
      ok: true,
      ruleId,
      triggerMatches,
      conditionResult,
      wouldFire,
      actionFired,
      actionError,
      dryRun,
    });
  } catch (err) {
    console.error('[Admin API] POST /workflows/:ruleId/test error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  SCHEDULES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/os/admin/schedules
 *
 * List all agent schedules: manifest default + any Redis override + whether a
 * node-cron job is currently active.
 *
 * Response 200:
 *   {
 *     ok: true,
 *     schedules: [
 *       {
 *         agentId:          "alex",
 *         agentName:        "Alex",
 *         defaultExpression: "* /10 * * * *",
 *         defaultTimezone:  "America/Sao_Paulo",
 *         scheduleType:     "cron",
 *         override:         null,
 *         active:           true
 *       },
 *       ...
 *     ]
 *   }
 */
adminRouter.get('/schedules', async (req, res) => {
  try {
    const agents = await getAllAgents();
    const r = getRedis();
    const activeJobs = new Set(listJobs().map((j) => j.agentId));

    const schedules = await Promise.all(
      agents.map(async (agent) => {
        const raw = await r.get(SCHEDULE_KEY(agent.id));
        const override = tryParse(raw, null);
        const sched = agent.schedule || {};

        return {
          agentId:          agent.id,
          agentName:        agent.name,
          scheduleType:     sched.type || 'none',
          defaultExpression: sched.expression || null,
          defaultTimezone:  sched.timezone  || 'America/Sao_Paulo',
          override: override
            ? {
                expression: override.expression,
                timezone:   override.timezone || sched.timezone || 'America/Sao_Paulo',
                setAt:      override.setAt,
                setBy:      override.setBy,
              }
            : null,
          activeExpression: override?.expression ?? sched.expression ?? null,
          active: activeJobs.has(agent.id),
        };
      })
    );

    res.json({ ok: true, schedules });
  } catch (err) {
    console.error('[Admin API] GET /schedules error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * PUT /api/os/admin/schedules/:agentId
 *
 * Override an agent's cron expression and restart its scheduler job.
 * The override is persisted in Redis so it survives restarts.
 * If the OS does not have a running job for the agent (e.g. event-driven agents),
 * the override is stored but no job is started — a note is returned.
 *
 * Body:
 *   {
 *     "expression": "0 * /2 * * *",
 *     "timezone": "America/Sao_Paulo"   — optional
 *   }
 *
 * Response 200:
 *   { ok: true, agentId, expression, timezone, jobRestarted, note? }
 */
adminRouter.put('/schedules/:agentId', requireWriteAccess, async (req, res) => {
  try {
    const { agentId } = req.params;
    const { expression, timezone } = req.body || {};

    if (!expression || typeof expression !== 'string') {
      return res.status(400).json({ ok: false, error: '"expression" must be a non-empty cron string' });
    }
    if (!isValidCron(expression)) {
      return res.status(400).json({ ok: false, error: `Invalid cron expression: "${expression}"` });
    }

    const agent = await getAgent(agentId);
    if (!agent) {
      return res.status(404).json({ ok: false, error: `Agent "${agentId}" not found` });
    }

    const tz = timezone || agent.schedule?.timezone || 'America/Sao_Paulo';
    const setAt = new Date().toISOString();

    // Persist override
    await getRedis().set(
      SCHEDULE_KEY(agentId),
      JSON.stringify({ expression, timezone: tz, setAt, setBy: req.admin?.email || 'unknown' })
    );

    // Attempt to reschedule the running cron job
    const activeJobs = listJobs();
    const hadJob = activeJobs.some((j) => j.agentId === agentId);
    let jobRestarted = false;
    let note = null;

    if (hadJob || (agent.schedule?.type === 'cron')) {
      try {
        scheduleJob(agentId, expression, tz, async () => {
          const { publish } = await import('../kernel/event-bus.js');
          const { updateStatus: us } = await import('../kernel/registry.js');
          await us(agentId, 'busy');
          await publish({ type: 'agent.tick', agentId, payload: { ts: new Date().toISOString() } });
          await us(agentId, 'online');
        });
        jobRestarted = true;
      } catch (err) {
        note = `Override saved but job restart failed: ${err.message}`;
      }
    } else {
      note = `Agent "${agentId}" does not run as a cron job (type=${agent.schedule?.type || 'none'}). Override stored; apply at next OS start.`;
    }

    console.log(`[Admin API] Schedule override set for "${agentId}" (${expression}) by ${req.admin?.email}`);

    res.json({ ok: true, agentId, expression, timezone: tz, setAt, jobRestarted, ...(note ? { note } : {}) });
  } catch (err) {
    console.error('[Admin API] PUT /schedules/:agentId error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * DELETE /api/os/admin/schedules/:agentId
 *
 * Remove a schedule override and restore the manifest default.
 *
 * Response 200:
 *   { ok: true, agentId, message, jobRestarted }
 */
adminRouter.delete('/schedules/:agentId', requireWriteAccess, async (req, res) => {
  try {
    const { agentId } = req.params;
    const agent = await getAgent(agentId);
    if (!agent) {
      return res.status(404).json({ ok: false, error: `Agent "${agentId}" not found` });
    }

    await getRedis().del(SCHEDULE_KEY(agentId));

    // Restore default schedule if one exists in the manifest
    let jobRestarted = false;
    const sched = agent.schedule || {};
    if (sched.type === 'cron' && sched.expression) {
      try {
        scheduleJob(agentId, sched.expression, sched.timezone || 'America/Sao_Paulo', async () => {
          const { publish } = await import('../kernel/event-bus.js');
          const { updateStatus: us } = await import('../kernel/registry.js');
          await us(agentId, 'busy');
          await publish({ type: 'agent.tick', agentId, payload: { ts: new Date().toISOString() } });
          await us(agentId, 'online');
        });
        jobRestarted = true;
      } catch (err) {
        // Non-fatal — override was removed successfully
        console.warn(`[Admin API] Could not restart default job for ${agentId}:`, err.message);
      }
    }

    res.json({
      ok: true,
      agentId,
      message: `Override removed — agent will use manifest default (${sched.expression || 'none'})`,
      jobRestarted,
    });
  } catch (err) {
    console.error('[Admin API] DELETE /schedules/:agentId error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  LOGS / EVENT HISTORY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/os/admin/logs
 *
 * Retrieve recent events from the ring buffer with optional filters.
 *
 * Query params:
 *   ?limit=50        Max events to return (1–1000, default 50)
 *   ?page=1          Page number (default 1)
 *   ?type=agent.*    Filter by exact event type (no wildcards here)
 *   ?agentId=paulo   Filter by agent ID
 *   ?since=<ms>      Only events with ts >= since (Unix ms)
 *
 * Response 200:
 *   { ok: true, page, limit, count, total, events: [...] }
 */
adminRouter.get('/logs', async (req, res) => {
  try {
    const { page, limit, skip } = pagination(req.query);
    const typeFilter    = req.query.type    || null;
    const agentFilter   = req.query.agentId || null;
    const sinceFilter   = req.query.since   ? parseInt(req.query.since, 10) : null;

    // Fetch from the ring buffer — always pull the maximum so we can filter
    const allEvents = await getEventHistory(1000);

    let filtered = allEvents;
    if (typeFilter)  filtered = filtered.filter((e) => e.type === typeFilter);
    if (agentFilter) filtered = filtered.filter((e) => e.agentId === agentFilter);
    if (sinceFilter) filtered = filtered.filter((e) => e.ts >= sinceFilter);

    const total  = filtered.length;
    const events = filtered.slice(skip, skip + limit);

    res.json({ ok: true, page, limit, count: events.length, total, events });
  } catch (err) {
    console.error('[Admin API] GET /logs error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/os/admin/logs/:agentId
 *
 * Events emitted by (or targeting) a specific agent.
 *
 * Query params:
 *   ?limit=50    Max events (1–500, default 50)
 *   ?page=1
 *
 * Response 200:
 *   { ok: true, agentId, page, limit, count, total, events: [...] }
 */
adminRouter.get('/logs/:agentId', async (req, res) => {
  try {
    const { agentId } = req.params;
    const agent = await getAgent(agentId);
    if (!agent) {
      return res.status(404).json({ ok: false, error: `Agent "${agentId}" not found` });
    }

    const { page, limit, skip } = pagination({ ...req.query, limit: Math.min(parseInt(req.query.limit || '50', 10), 500) });

    const allEvents = await getEventHistory(1000);
    const filtered  = allEvents.filter((e) => e.agentId === agentId);
    const total     = filtered.length;
    const events    = filtered.slice(skip, skip + limit);

    res.json({ ok: true, agentId, page, limit, count: events.length, total, events });
  } catch (err) {
    console.error('[Admin API] GET /logs/:agentId error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/os/admin/config
 *
 * Return the current OS runtime configuration.
 * Merges DEFAULT_CONFIG with any overrides stored in Redis.
 *
 * Response 200:
 *   { ok: true, config: { ... }, source: "redis" | "default" }
 */
adminRouter.get('/config', async (req, res) => {
  try {
    const raw = await getRedis().get(CONFIG_KEY);
    const stored = tryParse(raw, null);

    const config  = { ...DEFAULT_CONFIG, ...(stored?.values || {}) };
    const source  = stored ? 'redis' : 'default';
    const updatedAt = stored?.updatedAt ?? null;

    res.json({ ok: true, config, source, updatedAt });
  } catch (err) {
    console.error('[Admin API] GET /config error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * PUT /api/os/admin/config
 *
 * Merge-update the OS configuration.
 * Only known top-level keys are accepted; unknown keys are rejected.
 *
 * Body (partial — only include keys you want to change):
 *   {
 *     "healthCheckIntervalMs": 30000,
 *     "defaultHourlyQuota": 80000,
 *     "agentQuotas": { "augusto": 50000 },
 *     "maintenanceMode": false
 *   }
 *
 * Response 200:
 *   { ok: true, config: { ...merged }, updatedAt }
 *
 * NOTE: Config changes are written to Redis and will take effect on next OS
 * component read; some settings (e.g. healthCheckIntervalMs) require a full
 * restart to apply.
 */
adminRouter.put('/config', requireWriteAccess, async (req, res) => {
  try {
    const updates = req.body;
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      return res.status(400).json({ ok: false, error: 'Request body must be a JSON object' });
    }

    const allowedKeys = new Set(Object.keys(DEFAULT_CONFIG));
    const unknownKeys = Object.keys(updates).filter((k) => !allowedKeys.has(k));
    if (unknownKeys.length > 0) {
      return res.status(400).json({
        ok: false,
        error: `Unknown config keys: ${unknownKeys.join(', ')}. Allowed: ${[...allowedKeys].join(', ')}`,
      });
    }

    // Validate numeric fields
    const numericFields = ['healthCheckIntervalMs', 'bridgePollIntervalMs', 'defaultHourlyQuota', 'loopGuardMaxDepth', 'loopGuardWindowMs'];
    for (const field of numericFields) {
      if (field in updates && (typeof updates[field] !== 'number' || updates[field] <= 0)) {
        return res.status(400).json({ ok: false, error: `"${field}" must be a positive number` });
      }
    }

    // Load current stored values and merge
    const raw     = await getRedis().get(CONFIG_KEY);
    const stored  = tryParse(raw, { values: {} });
    const current = { ...DEFAULT_CONFIG, ...(stored.values || {}) };
    const merged  = { ...current, ...updates };

    const updatedAt = new Date().toISOString();
    await getRedis().set(CONFIG_KEY, JSON.stringify({ values: merged, updatedAt, updatedBy: req.admin?.email || 'unknown' }));

    console.log(`[Admin API] Config updated by ${req.admin?.email}:`, Object.keys(updates));

    res.json({ ok: true, config: merged, updatedAt });
  } catch (err) {
    console.error('[Admin API] PUT /config error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  NOTIFICATIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/os/admin/notifications
 *
 * Return current Telegram notification settings.
 * Delegates to getNotificationSettings() from the telegram module, which reads
 * from Redis key `os:notifications:settings` and deep-merges with defaults.
 *
 * Response 200:
 *   {
 *     ok: true,
 *     notifications: {
 *       enabled: true,
 *       chatIds: ["123456789"],
 *       quietHoursStart: "23:00",
 *       quietHoursEnd: "07:00",
 *       timezone: "America/Sao_Paulo",
 *       events: { "workflow.alert": true, ... }
 *     },
 *     source: "redis" | "default"
 *   }
 */
adminRouter.get('/notifications', async (req, res) => {
  try {
    // Check raw Redis to detect whether settings have been persisted yet
    const raw = await getRedis().get('os:notifications:settings');
    const source = raw ? 'redis' : 'default';

    const notifications = await getNotificationSettings();

    res.json({ ok: true, notifications, source });
  } catch (err) {
    console.error('[Admin API] GET /notifications error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * PUT /api/os/admin/notifications
 *
 * Merge-update Telegram notification settings.
 * Delegates to updateNotificationSettings() from the telegram module.
 * The module performs a deep merge so partial updates are safe.
 *
 * Body (all fields optional — only include what you want to change):
 *   {
 *     "enabled": true,
 *     "chatIds": ["123456789", "-1001234567890"],
 *     "quietHoursStart": "22:00",
 *     "quietHoursEnd": "08:00",
 *     "timezone": "America/Sao_Paulo",
 *     "events": {
 *       "workflow.alert": true,
 *       "os.boot": false
 *     }
 *   }
 *
 * Response 200:
 *   { ok: true, notifications: { ... }, updatedAt }
 */
adminRouter.put('/notifications', requireWriteAccess, async (req, res) => {
  try {
    const updates = req.body;
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      return res.status(400).json({ ok: false, error: 'Request body must be a JSON object' });
    }

    // Field-level validation
    if ('enabled' in updates && typeof updates.enabled !== 'boolean') {
      return res.status(400).json({ ok: false, error: '"enabled" must be a boolean' });
    }
    if ('chatIds' in updates) {
      if (!Array.isArray(updates.chatIds) || updates.chatIds.some((id) => typeof id !== 'string')) {
        return res.status(400).json({ ok: false, error: '"chatIds" must be an array of strings' });
      }
    }
    if ('quietHoursStart' in updates) {
      if (typeof updates.quietHoursStart !== 'string' || !/^\d{2}:\d{2}$/.test(updates.quietHoursStart)) {
        return res.status(400).json({ ok: false, error: '"quietHoursStart" must be a "HH:MM" string' });
      }
    }
    if ('quietHoursEnd' in updates) {
      if (typeof updates.quietHoursEnd !== 'string' || !/^\d{2}:\d{2}$/.test(updates.quietHoursEnd)) {
        return res.status(400).json({ ok: false, error: '"quietHoursEnd" must be a "HH:MM" string' });
      }
    }
    if ('timezone' in updates && typeof updates.timezone !== 'string') {
      return res.status(400).json({ ok: false, error: '"timezone" must be an IANA timezone string' });
    }
    if ('events' in updates) {
      if (typeof updates.events !== 'object' || Array.isArray(updates.events)) {
        return res.status(400).json({ ok: false, error: '"events" must be a plain object of boolean toggles' });
      }
      const invalidEntry = Object.entries(updates.events).find(([, v]) => typeof v !== 'boolean');
      if (invalidEntry) {
        return res.status(400).json({
          ok: false,
          error: `Event toggle "${invalidEntry[0]}" must be a boolean`,
        });
      }
    }

    const merged = await updateNotificationSettings(updates);
    const updatedAt = new Date().toISOString();

    console.log(`[Admin API] Telegram notifications updated by ${req.admin?.email}`);

    res.json({ ok: true, notifications: merged, updatedAt });
  } catch (err) {
    console.error('[Admin API] PUT /notifications error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Exported helper — used by agent code for hot-reload prompt override
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check Redis for a prompt override for the given agent.
 * Intended to be called by each agent's system-prompt builder.
 *
 * Usage in src/ai/system-prompt.js:
 *   import { getPromptOverride } from '../os/api/admin-routes.js';
 *   const override = await getPromptOverride('augusto');
 *   if (override) return override;
 *
 * @param {string} agentId
 * @returns {Promise<string | null>} Override text, or null if no override exists
 */
export async function getPromptOverride(agentId) {
  try {
    const raw = await getRedis().get(PROMPT_KEY(agentId));
    if (!raw) return null;
    const stored = JSON.parse(raw);
    return stored?.text ?? null;
  } catch {
    return null;
  }
}

/**
 * Check Redis for a schedule override for the given agent.
 * Intended to be called by the OS kernel during schedule initialization.
 *
 * @param {string} agentId
 * @returns {Promise<{ expression: string, timezone: string } | null>}
 */
export async function getScheduleOverride(agentId) {
  try {
    const raw = await getRedis().get(SCHEDULE_KEY(agentId));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Return a human-readable note explaining the prompt architecture for a
 * given agent so the admin panel can show useful context.
 *
 * @param {string} agentId
 * @returns {string}
 */
function promptNote(agentId) {
  const notes = {
    augusto: 'Augusto\'s prompt is assembled dynamically from src/ai/prompts/ modules (core, phases, objections, footer). Set an override to replace the entire assembled prompt.',
    paulo:   'Paulo SDR prompt is built by src/ai/sdr-prompt.js. Set an override to replace the compiled output.',
  };
  return notes[agentId] ?? 'This agent\'s prompt is defined in its source module. Set an override here to replace it at runtime without a code deploy.';
}
