/**
 * @file event-bus.js
 * @description Redis pub/sub event bus with ring buffer for the AI OS kernel.
 *
 * Architecture:
 *   - Publisher uses a single Redis connection for PUBLISH + sorted set writes.
 *   - Each subscriber gets its own dedicated Redis connection (required by ioredis
 *     once a connection enters subscribe mode it cannot issue other commands).
 *   - Ring buffer is stored in sorted set `os:events:history` scored by Unix ms
 *     timestamp, capped at RING_BUFFER_SIZE entries.
 */

import Redis from 'ioredis';
import 'dotenv/config';

const CHANNEL = 'os:events';
const HISTORY_KEY = 'os:events:history';
const RING_BUFFER_SIZE = 1000;

/** @type {Redis} Shared publisher / command connection */
let pub = null;

/** @type {Redis | null} Shared subscriber connection for subscribeAll() */
let globalSub = null;

/** @type {Map<string, Redis>} Per-agent subscriber connections */
const agentSubs = new Map();

/** @type {Set<Function>} Listeners registered via subscribeAll() */
const globalListeners = new Set();

/** @type {Map<string, Set<Function>>} Per-agent pattern listeners */
const patternListeners = new Map();

/**
 * Create a fresh ioredis connection using the same URL pattern as src/db/redis.js.
 * @returns {Redis}
 */
function createRedisConnection() {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  const conn = new Redis(url, {
    maxRetriesPerRequest: 3,
    enableOfflineQueue: true,
    lazyConnect: false,
  });

  conn.on('error', (err) => {
    console.error('[EventBus] Redis connection error:', err.message);
  });

  return conn;
}

/**
 * Get (or lazily create) the publisher connection.
 * @returns {Redis}
 */
function getPublisher() {
  if (!pub) {
    pub = createRedisConnection();
  }
  return pub;
}

/**
 * Publish an event to the OS event bus.
 *
 * Stores the event in the ring buffer sorted set and broadcasts it on both
 * the global channel and the per-agent channel (if event.agentId is set).
 *
 * @param {Object} event
 * @param {string} event.type         - Event type, e.g. "agent.started"
 * @param {string} [event.agentId]    - Originating agent ID
 * @param {Object} [event.payload]    - Arbitrary event payload
 * @returns {Promise<void>}
 */
export async function publish(event) {
  const normalized = {
    type: event.type || 'unknown',
    agentId: event.agentId || null,
    payload: event.payload || {},
    ts: Date.now(),
  };

  const serialized = JSON.stringify(normalized);
  const r = getPublisher();

  try {
    const pipeline = r.pipeline();

    // Store in ring buffer
    pipeline.zadd(HISTORY_KEY, normalized.ts, serialized);
    // Trim to last RING_BUFFER_SIZE entries (remove oldest by rank)
    pipeline.zremrangebyrank(HISTORY_KEY, 0, -(RING_BUFFER_SIZE + 1));
    // Broadcast on global channel
    pipeline.publish(CHANNEL, serialized);

    // Broadcast on per-agent channel if agentId is present
    if (normalized.agentId) {
      pipeline.publish(`${CHANNEL}:${normalized.agentId}`, serialized);
    }

    await pipeline.exec();
  } catch (err) {
    console.error('[EventBus] publish error:', err.message);
    throw err;
  }
}

/**
 * Subscribe an agent to events matching one or more patterns.
 *
 * Pattern matching is done client-side against the event `type` field using
 * simple glob-style wildcards (* matches any segment).
 *
 * @param {string}   agentId  - Unique agent identifier
 * @param {string[]} patterns - Array of glob patterns, e.g. ["agent.*", "task.done"]
 * @param {Function} handler  - Callback: (event: Object) => void
 * @returns {Promise<void>}
 */
export async function subscribe(agentId, patterns, handler) {
  if (!agentSubs.has(agentId)) {
    const conn = createRedisConnection();

    // Subscribe to both global channel and per-agent channel
    await conn.subscribe(CHANNEL, `${CHANNEL}:${agentId}`);

    conn.on('message', (_channel, message) => {
      try {
        const event = JSON.parse(message);
        const listeners = patternListeners.get(agentId);
        if (!listeners) return;

        listeners.forEach(({ patterns: pts, fn }) => {
          if (matchesAny(event.type, pts)) {
            fn(event);
          }
        });
      } catch (err) {
        console.error(`[EventBus] message parse error for agent ${agentId}:`, err.message);
      }
    });

    agentSubs.set(agentId, conn);
  }

  if (!patternListeners.has(agentId)) {
    patternListeners.set(agentId, new Set());
  }

  patternListeners.get(agentId).add({ patterns, fn: handler });
}

/**
 * Subscribe to ALL events on the bus (no filtering).
 *
 * @param {Function} handler - Callback: (event: Object) => void
 * @returns {Promise<void>}
 */
export async function subscribeAll(handler) {
  if (!globalSub) {
    globalSub = createRedisConnection();
    await globalSub.subscribe(CHANNEL);

    globalSub.on('message', (_channel, message) => {
      try {
        const event = JSON.parse(message);
        globalListeners.forEach((fn) => fn(event));
      } catch (err) {
        console.error('[EventBus] subscribeAll parse error:', err.message);
      }
    });
  }

  globalListeners.add(handler);

  // Return unsubscribe function
  return () => globalListeners.delete(handler);
}

/**
 * Retrieve the last N events from the ring buffer, newest first.
 *
 * @param {number} [limit=50] - Number of events to return (max 1000)
 * @returns {Promise<Object[]>}
 */
export async function getHistory(limit = 50) {
  const cap = Math.min(limit, RING_BUFFER_SIZE);
  const r = getPublisher();

  try {
    // zrevrange returns highest score (most recent) first
    const raw = await r.zrevrange(HISTORY_KEY, 0, cap - 1);
    return raw.map((item) => {
      try {
        return JSON.parse(item);
      } catch {
        return { raw: item };
      }
    });
  } catch (err) {
    console.error('[EventBus] getHistory error:', err.message);
    return [];
  }
}

/**
 * Remove a specific agent's subscriber connection and listeners.
 *
 * @param {string} agentId
 * @returns {Promise<void>}
 */
export async function unsubscribe(agentId) {
  const conn = agentSubs.get(agentId);
  if (conn) {
    await conn.quit();
    agentSubs.delete(agentId);
  }
  patternListeners.delete(agentId);
}

/**
 * Gracefully close all EventBus connections.
 * @returns {Promise<void>}
 */
export async function closeEventBus() {
  const tasks = [];

  if (pub) tasks.push(pub.quit());
  if (globalSub) tasks.push(globalSub.quit());
  for (const conn of agentSubs.values()) tasks.push(conn.quit());

  await Promise.allSettled(tasks);

  pub = null;
  globalSub = null;
  agentSubs.clear();
  globalListeners.clear();
  patternListeners.clear();
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Test whether an event type matches any of the provided glob patterns.
 * Supports * as a wildcard segment separator.
 *
 * @param {string}   type     - e.g. "agent.started"
 * @param {string[]} patterns - e.g. ["agent.*", "task.done"]
 * @returns {boolean}
 */
function matchesAny(type, patterns) {
  return patterns.some((pattern) => matchGlob(type, pattern));
}

/**
 * Simple glob matching: * matches any sequence of non-dot characters.
 *
 * @param {string} str
 * @param {string} pattern
 * @returns {boolean}
 */
function matchGlob(str, pattern) {
  if (pattern === '*') return true;
  const regexStr = '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '[^.]*') + '$';
  return new RegExp(regexStr).test(str);
}
