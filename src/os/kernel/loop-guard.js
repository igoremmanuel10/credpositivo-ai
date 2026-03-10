/**
 * @file loop-guard.js
 * @description Prevents infinite loops in agent execution by tracking recent
 * tool calls per agent in Redis.
 *
 * Detection strategy:
 *   1. Identical calls: same (toolName + params hash) repeated > MAX_IDENTICAL times
 *   2. Cycle depth: total calls in the current cycle exceeds MAX_TOTAL_CALLS
 *
 * State is stored in a Redis list `os:loopguard:{agentId}` capped at
 * HISTORY_SIZE entries. Each entry is a JSON record of the call.
 *
 * A "cycle" is reset either explicitly via reset(agentId) or when the agent
 * completes a full response turn (caller responsibility).
 */

import Redis from 'ioredis';
import { createHash } from 'crypto';
import 'dotenv/config';

const HISTORY_SIZE = 50;
const MAX_IDENTICAL = 5;
const MAX_TOTAL_CALLS = 30;

/** Redis key for the per-agent call history list */
const guardKey = (agentId) => `os:loopguard:${agentId}`;

/** @type {Redis | null} */
let redisClient = null;

/**
 * Get (or lazily create) the loop-guard Redis connection.
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
      console.error('[LoopGuard] Redis error:', err.message);
    });
  }
  return redisClient;
}

/**
 * Compute a short hash of tool call identity (toolName + serialized params).
 *
 * @param {string} toolName
 * @param {Object|string} params
 * @returns {string} 8-char hex hash
 */
function callHash(toolName, params) {
  const raw = toolName + ':' + JSON.stringify(params ?? {});
  return createHash('sha256').update(raw).digest('hex').slice(0, 8);
}

/**
 * Validate that an agent is not entering a loop before executing a tool call.
 *
 * Appends the call to the history ring buffer, then checks both loop conditions.
 * Returns an object describing whether the call is allowed and why it was blocked
 * (if applicable).
 *
 * @param {string}        agentId  - Agent identifier
 * @param {string}        toolName - Name of the tool being called
 * @param {Object|string} params   - Tool call parameters
 * @returns {Promise<{
 *   allowed: boolean,
 *   reason: string | null,
 *   totalCalls: number,
 *   identicalCalls: number
 * }>}
 */
export async function checkCall(agentId, toolName, params) {
  const r = getRedis();
  const key = guardKey(agentId);
  const hash = callHash(toolName, params);
  const now = Date.now();

  const entry = JSON.stringify({ toolName, hash, ts: now });

  // Push new call and trim to history size (list acts as a ring buffer)
  const pipeline = r.pipeline();
  pipeline.rpush(key, entry);
  pipeline.ltrim(key, -HISTORY_SIZE, -1);
  pipeline.lrange(key, 0, -1);
  pipeline.expire(key, 3600); // 1 hour TTL on idle
  const results = await pipeline.exec();

  const rawHistory = results[2][1]; // lrange result
  const history = rawHistory.map((item) => {
    try {
      return JSON.parse(item);
    } catch {
      return null;
    }
  }).filter(Boolean);

  const totalCalls = history.length;

  // Count identical calls in the current history
  const identicalCalls = history.filter((c) => c.hash === hash).length;

  if (totalCalls > MAX_TOTAL_CALLS) {
    return {
      allowed: false,
      reason: `Cycle depth exceeded: ${totalCalls} total calls (max ${MAX_TOTAL_CALLS})`,
      totalCalls,
      identicalCalls,
    };
  }

  if (identicalCalls > MAX_IDENTICAL) {
    return {
      allowed: false,
      reason: `Identical call loop detected: "${toolName}" called ${identicalCalls} times (max ${MAX_IDENTICAL})`,
      totalCalls,
      identicalCalls,
    };
  }

  return { allowed: true, reason: null, totalCalls, identicalCalls };
}

/**
 * Reset the call history for an agent, starting a fresh cycle.
 * Call this at the end of each agent response turn.
 *
 * @param {string} agentId
 * @returns {Promise<void>}
 */
export async function reset(agentId) {
  const r = getRedis();
  await r.del(guardKey(agentId));
}

/**
 * Get the current call history for an agent (for diagnostics).
 *
 * @param {string} agentId
 * @returns {Promise<{ toolName: string, hash: string, ts: number }[]>}
 */
export async function getHistory(agentId) {
  const r = getRedis();
  const raw = await r.lrange(guardKey(agentId), 0, -1);
  return raw.map((item) => {
    try {
      return JSON.parse(item);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

/**
 * Close the loop-guard Redis connection.
 * @returns {Promise<void>}
 */
export async function closeLoopGuard() {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}
