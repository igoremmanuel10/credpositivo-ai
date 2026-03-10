/**
 * @file registry.js
 * @description Agent registry — manages registration, status, and metrics for
 * all AI OS agents. State is persisted in Redis hashes `os:agents:{id}`.
 *
 * On startup, manifests are loaded from src/os/manifests/*.yaml and each agent
 * is upserted into the registry. Runtime status updates (online/busy/offline)
 * flow through updateStatus().
 */

import Redis from 'ioredis';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFESTS_DIR = join(__dirname, '..', 'manifests');

/** Redis key prefix for agent hashes */
const AGENT_KEY = (id) => `os:agents:${id}`;

/** Redis key for the sorted set of all agent IDs (scored by registration time) */
const AGENTS_INDEX_KEY = 'os:agents:index';

/** @type {Redis | null} */
let redisClient = null;

/**
 * Get (or lazily create) the registry Redis connection.
 * @returns {Redis}
 */
function getRedis() {
  if (!redisClient) {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    redisClient = new Redis(url, {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: true,
    });
    redisClient.on('error', (err) => {
      console.error('[Registry] Redis error:', err.message);
    });
  }
  return redisClient;
}

/**
 * Register an agent from a parsed YAML manifest object.
 * Idempotent — calling again with the same id updates the manifest fields
 * without overwriting live runtime fields (status, lastActivity, metrics).
 *
 * @param {Object} manifest - Parsed manifest (see src/os/manifests/*.yaml)
 * @returns {Promise<Object>} The stored agent record
 */
export async function registerAgent(manifest) {
  if (!manifest || !manifest.id) {
    throw new Error('[Registry] registerAgent: manifest must have an id');
  }

  const r = getRedis();
  const key = AGENT_KEY(manifest.id);

  // Preserve live fields if the agent is already registered
  const existing = await r.hgetall(key);

  const record = {
    id: manifest.id,
    name: manifest.name || manifest.id,
    role: manifest.role || '',
    goal: manifest.goal || '',
    color: manifest.color || '#64748B',
    icon: manifest.icon || 'robot',
    statusType: manifest.status_type || 'online',
    schedule: JSON.stringify(manifest.schedule || {}),
    capabilities: JSON.stringify(manifest.capabilities || {}),
    llm: JSON.stringify(manifest.llm || {}),
    metricsConfig: JSON.stringify(manifest.metrics || []),
    pixel: JSON.stringify(manifest.pixel || {}),
    // Runtime fields — keep existing values if present
    status: existing.status || 'offline',
    lastActivity: existing.lastActivity || new Date().toISOString(),
    metrics: existing.metrics || JSON.stringify({}),
    registeredAt: existing.registeredAt || new Date().toISOString(),
  };

  const pipeline = r.pipeline();
  pipeline.hset(key, record);
  // Add to index scored by registration timestamp for ordered listing
  pipeline.zadd(AGENTS_INDEX_KEY, Date.now(), manifest.id);
  await pipeline.exec();

  console.log(`[Registry] Agent registered: ${manifest.id} (${manifest.name})`);
  return deserializeAgent(record);
}

/**
 * Retrieve a single agent record by ID.
 *
 * @param {string} id
 * @returns {Promise<Object | null>}
 */
export async function getAgent(id) {
  const r = getRedis();
  const raw = await r.hgetall(AGENT_KEY(id));
  if (!raw || !raw.id) return null;
  return deserializeAgent(raw);
}

/**
 * List all registered agents in registration order.
 *
 * @returns {Promise<Object[]>}
 */
export async function getAllAgents() {
  const r = getRedis();
  const ids = await r.zrange(AGENTS_INDEX_KEY, 0, -1);

  if (!ids.length) return [];

  const pipeline = r.pipeline();
  ids.forEach((id) => pipeline.hgetall(AGENT_KEY(id)));
  const results = await pipeline.exec();

  return results
    .map(([err, raw]) => (err || !raw || !raw.id ? null : deserializeAgent(raw)))
    .filter(Boolean);
}

/**
 * Update an agent's runtime status and optional metadata.
 *
 * @param {string} id       - Agent ID
 * @param {string} status   - One of: "online" | "busy" | "idle" | "offline" | "error"
 * @param {Object} [metadata] - Additional fields to merge into the record
 * @returns {Promise<void>}
 */
export async function updateStatus(id, status, metadata = {}) {
  const r = getRedis();
  const key = AGENT_KEY(id);

  const validStatuses = new Set(['online', 'busy', 'idle', 'offline', 'error']);
  if (!validStatuses.has(status)) {
    throw new Error(`[Registry] Invalid status "${status}" for agent ${id}`);
  }

  const updates = {
    status,
    lastActivity: new Date().toISOString(),
  };

  // Merge string/primitive metadata fields directly; objects are serialized
  for (const [k, v] of Object.entries(metadata)) {
    updates[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
  }

  await r.hset(key, updates);
}

/**
 * Retrieve runtime metrics for an agent.
 *
 * Metrics are stored as a JSON blob in the `metrics` field of the agent hash.
 * Individual counters can also be stored in dedicated Redis keys for atomic
 * increments; this method merges both sources.
 *
 * @param {string} id
 * @returns {Promise<Object>}
 */
export async function getAgentStats(id) {
  const r = getRedis();
  const raw = await r.hgetall(AGENT_KEY(id));

  if (!raw || !raw.id) {
    return { error: `Agent ${id} not found` };
  }

  let metrics = {};
  try {
    metrics = JSON.parse(raw.metrics || '{}');
  } catch {
    metrics = {};
  }

  return {
    id,
    status: raw.status,
    lastActivity: raw.lastActivity,
    metrics,
  };
}

/**
 * Increment a numeric metric counter for an agent.
 *
 * @param {string} id     - Agent ID
 * @param {string} field  - Metric field name
 * @param {number} [by=1] - Increment amount
 * @returns {Promise<void>}
 */
export async function incrementMetric(id, field, by = 1) {
  const r = getRedis();
  const key = AGENT_KEY(id);
  const raw = await r.hget(key, 'metrics');

  let metrics = {};
  try {
    metrics = JSON.parse(raw || '{}');
  } catch {
    metrics = {};
  }

  metrics[field] = (metrics[field] || 0) + by;
  await r.hset(key, 'metrics', JSON.stringify(metrics));
}

/**
 * Load all YAML manifests from the manifests directory and register them.
 * Called once during OS initialization.
 *
 * @returns {Promise<string[]>} Array of registered agent IDs
 */
export async function loadManifests() {
  let files;
  try {
    files = readdirSync(MANIFESTS_DIR).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  } catch (err) {
    console.error('[Registry] Could not read manifests directory:', err.message);
    return [];
  }

  const registered = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(MANIFESTS_DIR, file), 'utf8');
      const manifest = yaml.load(content);
      await registerAgent(manifest);
      registered.push(manifest.id);
    } catch (err) {
      console.error(`[Registry] Failed to load manifest ${file}:`, err.message);
    }
  }

  console.log(`[Registry] Loaded ${registered.length} agent manifests: ${registered.join(', ')}`);
  return registered;
}

/**
 * Close the registry Redis connection.
 * @returns {Promise<void>}
 */
export async function closeRegistry() {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Deserialize raw Redis hash fields back into typed JavaScript values.
 *
 * @param {Object} raw - Raw hash from Redis (all string values)
 * @returns {Object}
 */
function deserializeAgent(raw) {
  return {
    id: raw.id,
    name: raw.name,
    role: raw.role,
    goal: raw.goal,
    color: raw.color,
    icon: raw.icon,
    statusType: raw.statusType,
    status: raw.status,
    lastActivity: raw.lastActivity,
    registeredAt: raw.registeredAt,
    schedule: tryParse(raw.schedule, {}),
    capabilities: tryParse(raw.capabilities, {}),
    llm: tryParse(raw.llm, {}),
    metricsConfig: tryParse(raw.metricsConfig, []),
    pixel: tryParse(raw.pixel, {}),
    metrics: tryParse(raw.metrics, {}),
  };
}

/**
 * @param {string} str
 * @param {*} fallback
 * @returns {*}
 */
function tryParse(str, fallback) {
  try {
    return JSON.parse(str || 'null') ?? fallback;
  } catch {
    return fallback;
  }
}
