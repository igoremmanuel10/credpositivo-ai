/**
 * @file scheduler.js
 * @description Cron scheduler and token quota manager for the AI OS kernel.
 *
 * Concerns are intentionally separated:
 *   - Scheduling: node-cron tasks keyed by agentId
 *   - Quota: Redis counters per (agentId, hour) with configurable token limits
 *
 * Quota keys use the format `os:quota:{agentId}:{YYYY-MM-DDTHH}` (UTC hour
 * bucket) so they naturally expire after the hour window passes.
 */

import cron from 'node-cron';
import Redis from 'ioredis';
import 'dotenv/config';

/** Max tokens per agent per hour before the quota blocks execution */
const DEFAULT_HOURLY_QUOTA = parseInt(process.env.OS_HOURLY_QUOTA || '100000', 10);

/** Redis key for hourly quota counter */
const quotaKey = (agentId) => {
  const hour = new Date().toISOString().slice(0, 13); // "2026-03-10T14"
  return `os:quota:${agentId}:${hour}`;
};

/** @type {Map<string, cron.ScheduledTask>} */
const jobs = new Map();

/** @type {Redis | null} */
let redisClient = null;

/**
 * Get (or lazily create) the scheduler Redis connection.
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
      console.error('[Scheduler] Redis error:', err.message);
    });
  }
  return redisClient;
}

/**
 * Schedule a recurring cron job for an agent.
 * Cancels any existing job for the same agentId before registering the new one.
 *
 * @param {string}   agentId   - Unique agent identifier
 * @param {string}   cronExpr  - Cron expression, e.g. "0 * * * *"
 * @param {string}   timezone  - IANA timezone, e.g. "America/Sao_Paulo"
 * @param {Function} handler   - Async function to execute on each tick
 * @returns {cron.ScheduledTask}
 */
export function scheduleJob(agentId, cronExpr, timezone, handler) {
  // Cancel existing job if any
  cancelJob(agentId);

  if (!cron.validate(cronExpr)) {
    throw new Error(`[Scheduler] Invalid cron expression for ${agentId}: "${cronExpr}"`);
  }

  const task = cron.schedule(
    cronExpr,
    async () => {
      console.log(`[Scheduler] Tick: ${agentId} | ${new Date().toISOString()}`);
      try {
        await handler();
      } catch (err) {
        console.error(`[Scheduler] Job error for ${agentId}:`, err.message);
      }
    },
    {
      scheduled: true,
      timezone: timezone || 'America/Sao_Paulo',
    }
  );

  jobs.set(agentId, task);
  console.log(`[Scheduler] Job scheduled: ${agentId} | ${cronExpr} | tz=${timezone}`);
  return task;
}

/**
 * Cancel and remove the scheduled job for an agent.
 *
 * @param {string} agentId
 * @returns {boolean} true if a job was found and cancelled
 */
export function cancelJob(agentId) {
  const task = jobs.get(agentId);
  if (!task) return false;

  task.stop();
  jobs.delete(agentId);
  console.log(`[Scheduler] Job cancelled: ${agentId}`);
  return true;
}

/**
 * Check whether an agent has sufficient token quota remaining for this hour.
 *
 * @param {string} agentId - Agent identifier
 * @param {number} cost    - Estimated token cost of the planned operation
 * @param {number} [limit] - Override the default hourly quota
 * @returns {Promise<{ allowed: boolean, used: number, remaining: number, limit: number }>}
 */
export async function checkQuota(agentId, cost, limit = DEFAULT_HOURLY_QUOTA) {
  const r = getRedis();
  const key = quotaKey(agentId);

  const raw = await r.get(key);
  const used = raw ? parseInt(raw, 10) : 0;
  const remaining = limit - used;
  const allowed = remaining >= cost;

  return { allowed, used, remaining, limit };
}

/**
 * Record token usage for an agent in the current hour bucket.
 * The Redis key automatically expires at the next hour boundary (TTL = 3600s).
 *
 * @param {string} agentId - Agent identifier
 * @param {number} tokens  - Number of tokens consumed
 * @returns {Promise<number>} New total usage for the current hour
 */
export async function recordUsage(agentId, tokens) {
  const r = getRedis();
  const key = quotaKey(agentId);

  const pipeline = r.pipeline();
  pipeline.incrby(key, tokens);
  // Set TTL on first write — expire at 2 hours out to cover boundary edge cases
  pipeline.expire(key, 7200, 'NX');
  const results = await pipeline.exec();

  return results[0][1]; // New value after INCRBY
}

/**
 * Get current usage statistics for an agent.
 *
 * @param {string} agentId
 * @param {number} [limit] - Override the default hourly quota
 * @returns {Promise<{ agentId: string, used: number, remaining: number, limit: number, resetAt: string }>}
 */
export async function getUsage(agentId, limit = DEFAULT_HOURLY_QUOTA) {
  const r = getRedis();
  const key = quotaKey(agentId);

  const raw = await r.get(key);
  const used = raw ? parseInt(raw, 10) : 0;

  // Calculate the timestamp of the next hour boundary
  const now = new Date();
  const resetAt = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours() + 1, 0, 0)
  ).toISOString();

  return {
    agentId,
    used,
    remaining: Math.max(0, limit - used),
    limit,
    resetAt,
  };
}

/**
 * List all currently active scheduled jobs.
 *
 * @returns {{ agentId: string, running: boolean }[]}
 */
export function listJobs() {
  return Array.from(jobs.entries()).map(([agentId, task]) => ({
    agentId,
    running: task !== null,
  }));
}

/**
 * Stop all scheduled jobs and close the Redis connection.
 * @returns {Promise<void>}
 */
export async function closeScheduler() {
  for (const [agentId, task] of jobs.entries()) {
    task.stop();
    console.log(`[Scheduler] Stopped job: ${agentId}`);
  }
  jobs.clear();

  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}
