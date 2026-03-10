/**
 * @file src/os/index.js
 * @description AI OS kernel — main initialization entry point.
 *
 * Call `initOS(app)` once from src/index.js after Express is configured.
 * It will:
 *   1. Load all agent manifests from src/os/manifests/*.yaml
 *   2. Initialize the EventBus, Registry, and Scheduler
 *   3. Mount the OS API routes on the Express app
 *   4. Start the agent health monitoring loop
 *
 * Usage:
 *   import { initOS } from './os/index.js';
 *   await initOS(app);
 */

import { loadManifests, getAllAgents, updateStatus } from './kernel/registry.js';
import { publish, closeEventBus } from './kernel/event-bus.js';
import { scheduleJob, closeScheduler } from './kernel/scheduler.js';
import { closeLoopGuard } from './kernel/loop-guard.js';
import { osRouter } from './api/os-routes.js';
import { startBridge, stopBridge } from './bridge.js';
import { startWorkflows, stopWorkflows } from './engine/workflows.js';

// Health check interval in milliseconds (default: every 60 seconds)
const HEALTH_CHECK_INTERVAL_MS = parseInt(
  process.env.OS_HEALTH_CHECK_INTERVAL || '60000',
  10
);

/** @type {NodeJS.Timeout | null} */
let healthCheckTimer = null;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Full OS initialization pipeline.
 * Must be called with a configured Express `app` instance.
 *
 * @param {import('express').Application} app
 * @returns {Promise<void>}
 */
export async function initOS(app) {
  console.log('[OS] Initializing AI OS kernel...');

  try {
    await loadManifests();
    console.log('[OS] Manifests loaded.');
  } catch (err) {
    console.error('[OS] Failed to load manifests:', err.message);
    // Non-fatal — continue with empty registry
  }

  try {
    await initKernel();
    console.log('[OS] Kernel initialized.');
  } catch (err) {
    console.error('[OS] Kernel init error:', err.message);
    throw err; // Kernel failure is fatal
  }

  initApi(app);
  console.log('[OS] API routes mounted at /api/os');

  startAgentMonitoring();
  console.log(`[OS] Agent health monitoring started (interval: ${HEALTH_CHECK_INTERVAL_MS}ms)`);

  await startWorkflows();

  try {
    await startBridge();
    console.log('[OS] Bridge to existing agents started');
  } catch (err) {
    console.warn('[OS] Bridge init failed (non-fatal):', err.message);
  }

  // Emit boot event
  await publish({
    type: 'os.boot',
    agentId: null,
    payload: { ts: new Date().toISOString(), version: '1.0.0' },
  }).catch((err) => console.warn('[OS] Could not publish boot event:', err.message));

  console.log('[OS] AI OS kernel ready.');
}

/**
 * Initialize EventBus, Registry, and background-agent Schedulers.
 *
 * Agents with `schedule.type === "cron"` get a node-cron job registered here.
 * Event-driven agents (type === "always") are started immediately as "online".
 *
 * @returns {Promise<void>}
 */
export async function initKernel() {
  const agents = await getAllAgents();

  for (const agent of agents) {
    const schedule = agent.schedule || {};

    if (schedule.type === 'cron' && schedule.expression) {
      scheduleJob(
        agent.id,
        schedule.expression,
        schedule.timezone || 'America/Sao_Paulo',
        () => agentCronTick(agent.id)
      );
      // Mark cron agents as online immediately
      await updateStatus(agent.id, 'online').catch(() => {});
    } else if (schedule.type === 'always') {
      // Event-driven agents start online and wait for incoming messages
      await updateStatus(agent.id, 'online').catch(() => {});
    }
  }
}

/**
 * Mount OS API routes on the given Express app.
 *
 * @param {import('express').Application} app
 */
export function initApi(app) {
  app.use('/api/os', osRouter);
}

/**
 * Start the periodic agent health monitor.
 *
 * Every HEALTH_CHECK_INTERVAL_MS milliseconds, all agents are inspected.
 * Agents that have not had activity in more than 5 minutes and are marked
 * "busy" are automatically reverted to "online" (stall recovery).
 */
export function startAgentMonitoring() {
  if (healthCheckTimer) return; // Already running

  healthCheckTimer = setInterval(async () => {
    try {
      await runHealthCheck();
    } catch (err) {
      console.error('[OS Monitor] Health check error:', err.message);
    }
  }, HEALTH_CHECK_INTERVAL_MS);

  // Allow the process to exit even if this timer is pending
  if (healthCheckTimer.unref) healthCheckTimer.unref();
}

/**
 * Stop agent monitoring.
 */
export function stopAgentMonitoring() {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

/**
 * Gracefully shut down the OS kernel — close all Redis connections,
 * cancel all scheduled jobs, and stop monitoring.
 *
 * @returns {Promise<void>}
 */
export async function shutdownOS() {
  console.log('[OS] Shutting down AI OS kernel...');
  stopAgentMonitoring();

  await Promise.allSettled([
    stopBridge(),
    stopWorkflows(),
    closeEventBus(),
    closeScheduler(),
    closeLoopGuard(),
  ]);

  console.log('[OS] Kernel shut down cleanly.');
}

// ─── Internal ────────────────────────────────────────────────────────────────

/**
 * Handler called by node-cron for each background agent tick.
 * Publishes a `agent.tick` event; the actual agent logic should subscribe
 * to this event via the EventBus.
 *
 * @param {string} agentId
 * @returns {Promise<void>}
 */
async function agentCronTick(agentId) {
  try {
    await updateStatus(agentId, 'busy');
    await publish({
      type: 'agent.tick',
      agentId,
      payload: { ts: new Date().toISOString() },
    });
    // Revert to online after tick (actual agent logic sets its own status)
    await updateStatus(agentId, 'online');
  } catch (err) {
    console.error(`[OS] Cron tick error for ${agentId}:`, err.message);
    await updateStatus(agentId, 'error').catch(() => {});
  }
}

/**
 * Perform a single health check pass over all registered agents.
 * Recovers stalled agents (busy for > 5 min without activity).
 *
 * @returns {Promise<void>}
 */
async function runHealthCheck() {
  const agents = await getAllAgents();
  const now = Date.now();
  const STALL_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

  for (const agent of agents) {
    if (agent.status !== 'busy') continue;

    const lastActivity = agent.lastActivity ? new Date(agent.lastActivity).getTime() : 0;
    const age = now - lastActivity;

    if (age > STALL_THRESHOLD_MS) {
      console.warn(
        `[OS Monitor] Agent "${agent.id}" has been busy for ${Math.round(age / 1000)}s — recovering to online`
      );
      await updateStatus(agent.id, 'online', { recoveredFromStall: true }).catch(() => {});
      await publish({
        type: 'agent.stall_recovered',
        agentId: agent.id,
        payload: { stalledMs: age },
      }).catch(() => {});
    }
  }
}
