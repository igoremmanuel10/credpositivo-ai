/**
 * @file src/os/engine/workflows.js
 * @description Event-driven workflow engine for AI OS.
 * Listens to EventBus events and triggers automated responses.
 *
 * Rules come from two sources:
 *   1. STATIC_RULES — hardcoded in this file, always present.
 *   2. Dynamic rules — stored in Redis at key `os:workflows:rules` (JSON array).
 *      Managed at runtime via addRule / updateRule / removeRule.
 *
 * Dynamic rule schema:
 *   {
 *     id:          string   — unique, slug-style
 *     name:        string   — human label
 *     triggerType: string   — event type to match (exact, no wildcards yet)
 *     conditionJs: string   — JS expression evaluated with `event` in scope;
 *                            must return a boolean. "true" means always.
 *     actionType:  string   — "publish" | "log"
 *     actionPayload: object — payload forwarded to publish() or logged
 *     enabled:     boolean  — if false the rule is loaded but never fires
 *     createdAt:   string   — ISO timestamp
 *     updatedAt:   string   — ISO timestamp
 *   }
 *
 * SECURITY NOTE: conditionJs is evaluated with `new Function()`. Only admins
 * with a valid JWT can write dynamic rules. Never expose this endpoint publicly.
 */

import Redis from 'ioredis';
import { subscribeAll, publish } from '../kernel/event-bus.js';
import { updateStatus } from '../kernel/registry.js';
import 'dotenv/config';

// ─── Redis ────────────────────────────────────────────────────────────────────

const DYNAMIC_RULES_KEY = 'os:workflows:rules';

/** @type {Redis | null} */
let redisClient = null;

function getRedis() {
  if (!redisClient) {
    redisClient = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: true,
    });
    redisClient.on('error', (err) => {
      console.error('[Workflow] Redis error:', err.message);
    });
  }
  return redisClient;
}

// ─── Static (built-in) rules ──────────────────────────────────────────────────

const STATIC_RULES = [
  {
    id: 'ana-critical-alert',
    name: 'Ana Critical → Alert Musk',
    trigger: { type: 'ana.cycle_complete' },
    condition: (event) => (event.payload?.issues || 0) >= 5,
    action: async (event) => {
      await publish({
        type: 'workflow.alert',
        agentId: 'musk',
        payload: {
          source: 'ana',
          severity: 'critical',
          message: `Ana detectou ${event.payload.issues} problemas no ciclo`,
          originalEvent: event.type,
        },
      });
    },
  },
  {
    id: 'alex-error-escalate',
    name: 'Alex Error → Escalate',
    trigger: { type: 'alex.health_check' },
    condition: (event) => event.payload?.overall === 'CRITICO',
    action: async (event) => {
      await publish({
        type: 'workflow.escalation',
        agentId: 'igor',
        payload: {
          source: 'alex',
          severity: 'critical',
          message: 'Infraestrutura em estado CRITICO',
          errors: event.payload?.errors || 0,
        },
      });
    },
  },
  {
    id: 'igor-high-corrections',
    name: 'Igor High Corrections → Report',
    trigger: { type: 'igor.cycle_complete' },
    condition: (event) => (event.payload?.corrections || 0) >= 3,
    action: async (event) => {
      await publish({
        type: 'workflow.report',
        agentId: 'luan',
        payload: {
          source: 'igor',
          message: `Igor fez ${event.payload.corrections} correções em ${event.payload.conversations} conversas`,
        },
      });
    },
  },
  {
    id: 'agent-error-recovery',
    name: 'Agent Error → Auto-restart',
    trigger: { type: 'agent.stall_recovered' },
    condition: () => true,
    action: async (event) => {
      await publish({
        type: 'workflow.recovery',
        agentId: event.agentId,
        payload: {
          message: `Agente ${event.agentId} recuperado de stall (${Math.round(event.payload?.stalledMs / 1000)}s)`,
        },
      });
    },
  },
  {
    id: 'augusto-busy-long',
    name: 'Augusto Busy → Track',
    trigger: { type: 'agent.activity' },
    condition: (event) => event.agentId === 'augusto' && event.payload?.action,
    action: async (event) => {
      await updateStatus('augusto', 'busy', {
        currentAction: event.payload.action,
      }).catch(() => {});
    },
  },
  {
    id: 'os-boot-notify',
    name: 'OS Boot → Initialize agents',
    trigger: { type: 'os.boot' },
    condition: () => true,
    action: async () => {
      await publish({
        type: 'workflow.notification',
        agentId: null,
        payload: {
          message: 'AI OS inicializado — todos os agentes ativos',
          severity: 'info',
        },
      });
    },
  },
];

// ─── Runtime state ────────────────────────────────────────────────────────────

let unsubscribe = null;

/**
 * Per-rule execution statistics.
 * Keyed by rule id; populated at startWorkflows() time and updated on each
 * successful rule firing. Dynamic rules get an entry when they are added.
 * @type {Record<string, { triggered: number, lastTriggered: string | null, errors: number }>}
 */
let ruleStats = {};

// ─── Dynamic rule storage helpers ────────────────────────────────────────────

/**
 * Load all dynamic rules from Redis.
 * @returns {Promise<DynamicRule[]>}
 */
async function loadDynamicRules() {
  try {
    const raw = await getRedis().get(DYNAMIC_RULES_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch (err) {
    console.error('[Workflow] Failed to load dynamic rules:', err.message);
    return [];
  }
}

/**
 * Persist the full dynamic rules array to Redis.
 * @param {DynamicRule[]} rules
 */
async function saveDynamicRules(rules) {
  await getRedis().set(DYNAMIC_RULES_KEY, JSON.stringify(rules));
}

/**
 * Convert a dynamic rule record (plain object from Redis) into an internal
 * rule object that the engine can process — i.e. attach real `condition` and
 * `action` functions built from the stored configuration.
 *
 * @param {DynamicRule} dr
 * @returns {InternalRule | null}
 */
function hydrateDynamicRule(dr) {
  if (!dr.enabled) return null;

  let condition;
  try {
    // conditionJs must evaluate to a boolean given `event`
    // eslint-disable-next-line no-new-func
    const fn = new Function('event', `return !!(${dr.conditionJs || 'true'})`);
    condition = (event) => {
      try {
        return fn(event);
      } catch {
        return false;
      }
    };
  } catch (err) {
    console.error(`[Workflow] Dynamic rule "${dr.id}" has invalid conditionJs:`, err.message);
    return null;
  }

  const action = async (event) => {
    if (dr.actionType === 'publish') {
      await publish({
        type: dr.actionPayload?.type || 'workflow.dynamic',
        agentId: dr.actionPayload?.agentId || null,
        payload: {
          ...(dr.actionPayload?.payload || {}),
          _ruleId: dr.id,
          _triggerEvent: event.type,
        },
      });
    } else {
      // Default: log to console
      console.log(`[Workflow] Dynamic rule "${dr.id}" fired:`, {
        event: event.type,
        payload: dr.actionPayload,
      });
    }
  };

  return {
    id: dr.id,
    name: dr.name,
    trigger: { type: dr.triggerType },
    condition,
    action,
    _dynamic: true,
  };
}

// ─── Engine control ───────────────────────────────────────────────────────────

/**
 * Start the workflow engine.
 * Subscribes to all EventBus events and evaluates both static and dynamic rules.
 */
export async function startWorkflows() {
  if (unsubscribe) return; // Already running

  // Seed stats for static rules
  for (const rule of STATIC_RULES) {
    if (!ruleStats[rule.id]) {
      ruleStats[rule.id] = { triggered: 0, lastTriggered: null, errors: 0 };
    }
  }

  // Pre-load dynamic rules to seed their stats
  const dynamicRules = await loadDynamicRules();
  for (const dr of dynamicRules) {
    if (!ruleStats[dr.id]) {
      ruleStats[dr.id] = { triggered: 0, lastTriggered: null, errors: 0 };
    }
  }

  unsubscribe = await subscribeAll(async (event) => {
    // Re-load dynamic rules on every event dispatch so edits take effect without restart.
    // The overhead is a single Redis GET per event — acceptable for a background engine.
    const dynamic = await loadDynamicRules();
    const allRules = [
      ...STATIC_RULES,
      ...dynamic.map(hydrateDynamicRule).filter(Boolean),
    ];

    for (const rule of allRules) {
      try {
        if (rule.trigger.type && rule.trigger.type !== event.type) continue;
        if (rule.condition && !rule.condition(event)) continue;

        await rule.action(event);

        if (!ruleStats[rule.id]) {
          ruleStats[rule.id] = { triggered: 0, lastTriggered: null, errors: 0 };
        }
        ruleStats[rule.id].triggered++;
        ruleStats[rule.id].lastTriggered = new Date().toISOString();
      } catch (err) {
        console.error(`[Workflow] Rule "${rule.id}" error:`, err.message);
        if (ruleStats[rule.id]) {
          ruleStats[rule.id].errors = (ruleStats[rule.id].errors || 0) + 1;
        }
      }
    }
  });

  const total = STATIC_RULES.length + dynamicRules.length;
  console.log(
    `[Workflow] Engine started with ${STATIC_RULES.length} static + ${dynamicRules.length} dynamic rules (${total} total)`
  );
}

/**
 * Stop the workflow engine.
 */
export function stopWorkflows() {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}

// ─── Read API ─────────────────────────────────────────────────────────────────

/**
 * Return all rules (static + dynamic) with their current execution stats.
 * This is the full representation used by the admin panel.
 *
 * @returns {Promise<{ running: boolean, staticCount: number, dynamicCount: number, rules: RuleSummary[] }>}
 */
export async function getRules() {
  const dynamicRules = await loadDynamicRules();

  const staticSummaries = STATIC_RULES.map((r) => ({
    id: r.id,
    name: r.name,
    triggerType: r.trigger.type,
    source: 'static',
    enabled: true,
    ...(ruleStats[r.id] || { triggered: 0, lastTriggered: null, errors: 0 }),
  }));

  const dynamicSummaries = dynamicRules.map((dr) => ({
    id: dr.id,
    name: dr.name,
    triggerType: dr.triggerType,
    conditionJs: dr.conditionJs,
    actionType: dr.actionType,
    actionPayload: dr.actionPayload,
    source: 'dynamic',
    enabled: dr.enabled,
    createdAt: dr.createdAt,
    updatedAt: dr.updatedAt,
    ...(ruleStats[dr.id] || { triggered: 0, lastTriggered: null, errors: 0 }),
  }));

  return {
    running: !!unsubscribe,
    staticCount: STATIC_RULES.length,
    dynamicCount: dynamicRules.length,
    rules: [...staticSummaries, ...dynamicSummaries],
  };
}

/**
 * Lightweight stats object — kept for backward compatibility with os-routes.js.
 * @returns {object}
 */
export function getWorkflowStats() {
  return {
    running: !!unsubscribe,
    rules: STATIC_RULES.map((r) => ({
      id: r.id,
      name: r.name,
      triggerType: r.trigger.type,
      ...(ruleStats[r.id] || { triggered: 0, lastTriggered: null }),
    })),
  };
}

// ─── Dynamic rule CRUD ────────────────────────────────────────────────────────

/**
 * Add a new dynamic workflow rule.
 *
 * @param {Omit<DynamicRule, 'createdAt' | 'updatedAt'>} rule
 * @returns {Promise<DynamicRule>}
 * @throws {Error} if a rule with the same id already exists
 */
export async function addRule(rule) {
  validateDynamicRule(rule);

  const rules = await loadDynamicRules();
  if (rules.some((r) => r.id === rule.id)) {
    throw new Error(`Rule with id "${rule.id}" already exists`);
  }

  const now = new Date().toISOString();
  const newRule = {
    id: rule.id,
    name: rule.name,
    triggerType: rule.triggerType,
    conditionJs: rule.conditionJs ?? 'true',
    actionType: rule.actionType ?? 'publish',
    actionPayload: rule.actionPayload ?? {},
    enabled: rule.enabled !== false,
    createdAt: now,
    updatedAt: now,
  };

  rules.push(newRule);
  await saveDynamicRules(rules);

  // Seed stats entry
  ruleStats[newRule.id] = { triggered: 0, lastTriggered: null, errors: 0 };

  console.log(`[Workflow] Dynamic rule added: ${newRule.id}`);
  return newRule;
}

/**
 * Update an existing dynamic rule.
 * Static rules cannot be updated via this function.
 *
 * @param {string} ruleId
 * @param {Partial<DynamicRule>} updates
 * @returns {Promise<DynamicRule>}
 * @throws {Error} if the rule is not found or is static
 */
export async function updateRule(ruleId, updates) {
  if (STATIC_RULES.some((r) => r.id === ruleId)) {
    throw new Error(`Rule "${ruleId}" is a static built-in rule and cannot be modified via API`);
  }

  const rules = await loadDynamicRules();
  const idx = rules.findIndex((r) => r.id === ruleId);
  if (idx === -1) {
    throw new Error(`Dynamic rule "${ruleId}" not found`);
  }

  // Prevent changing the id
  const { id: _ignored, createdAt: _also, ...safeUpdates } = updates;

  const updated = {
    ...rules[idx],
    ...safeUpdates,
    updatedAt: new Date().toISOString(),
  };

  // Re-validate merged result
  validateDynamicRule(updated);

  rules[idx] = updated;
  await saveDynamicRules(rules);

  console.log(`[Workflow] Dynamic rule updated: ${ruleId}`);
  return updated;
}

/**
 * Remove a dynamic rule by id.
 * Static rules cannot be removed.
 *
 * @param {string} ruleId
 * @returns {Promise<void>}
 * @throws {Error} if the rule is static or not found
 */
export async function removeRule(ruleId) {
  if (STATIC_RULES.some((r) => r.id === ruleId)) {
    throw new Error(`Rule "${ruleId}" is a static built-in rule and cannot be deleted`);
  }

  const rules = await loadDynamicRules();
  const idx = rules.findIndex((r) => r.id === ruleId);
  if (idx === -1) {
    throw new Error(`Dynamic rule "${ruleId}" not found`);
  }

  rules.splice(idx, 1);
  await saveDynamicRules(rules);
  delete ruleStats[ruleId];

  console.log(`[Workflow] Dynamic rule removed: ${ruleId}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Validate a dynamic rule object before persisting.
 * Throws on any violation.
 *
 * @param {Partial<DynamicRule>} rule
 */
function validateDynamicRule(rule) {
  if (!rule.id || typeof rule.id !== 'string') {
    throw new Error('Rule id must be a non-empty string');
  }
  if (!/^[a-z0-9-_]+$/.test(rule.id)) {
    throw new Error('Rule id must be slug-style (lowercase letters, digits, hyphens, underscores)');
  }
  if (!rule.name || typeof rule.name !== 'string') {
    throw new Error('Rule name must be a non-empty string');
  }
  if (!rule.triggerType || typeof rule.triggerType !== 'string') {
    throw new Error('Rule triggerType must be a non-empty string');
  }
  if (rule.conditionJs !== undefined && typeof rule.conditionJs !== 'string') {
    throw new Error('Rule conditionJs must be a string');
  }
  if (rule.actionType && !['publish', 'log'].includes(rule.actionType)) {
    throw new Error('Rule actionType must be "publish" or "log"');
  }

  // Dry-run compile conditionJs to catch syntax errors early
  if (rule.conditionJs && rule.conditionJs !== 'true') {
    try {
      // eslint-disable-next-line no-new-func
      new Function('event', `return !!(${rule.conditionJs})`);
    } catch (err) {
      throw new Error(`Rule conditionJs is invalid JavaScript: ${err.message}`);
    }
  }
}

/**
 * @typedef {Object} DynamicRule
 * @property {string} id
 * @property {string} name
 * @property {string} triggerType
 * @property {string} [conditionJs]
 * @property {'publish'|'log'} [actionType]
 * @property {object} [actionPayload]
 * @property {boolean} enabled
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} InternalRule
 * @property {string} id
 * @property {string} name
 * @property {{ type: string }} trigger
 * @property {(event: object) => boolean} condition
 * @property {(event: object) => Promise<void>} action
 * @property {boolean} [_dynamic]
 */
