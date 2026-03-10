/**
 * @file agent-control.js
 * @description Real scheduler control for the AI OS.
 *
 * Maps agent IDs to their start/stop scheduler functions and tracks
 * which cron tasks belong to each agent.
 *
 * Strategy for stop:
 *   node-cron v3 stores every scheduled task in global.scheduledTasks (a Map
 *   keyed by UUID).  We snapshot that map before and after calling a start
 *   function, then own the diff — those are the tasks for that agent.  This
 *   lets us call .stop()/.start() without modifying any scheduler file.
 *
 *   Igor uses setInterval internally and exports getIgorStatus().running, so
 *   we handle him separately: we call startIgorScheduler() and trust that
 *   Igor manages his own interval.  For stop we set a flag and log a warning
 *   (Igor does not export a stop function).
 *
 * Usage:
 *   import { controlAgent, getControlState } from './agent-control.js';
 *   await controlAgent('ana', 'start');   // 'start' | 'stop' | 'restart'
 */

import cron from 'node-cron';

import { startAnaScheduler }        from '../ops/ana.js';
import { startAlexScheduler }       from '../devops/alex.js';
import { startIgorScheduler }       from '../orchestrator/igor.js';
import { startFollowupScheduler }   from '../conversation/followup.js';
import { startNudgePoller }         from '../conversation/nudge-poller.js';
import { startReportScheduler }     from '../reports/scheduler.js';
import { startAdsScheduler }        from '../ads/manager.js';
import { startInstagramScheduler }  from '../social/instagram.js';
import { startFunnelWatcher }       from '../manager/funnel-watcher.js';
import { startUnansweredMonitor }   from '../monitoring/unanswered-monitor.js';
import { startCoachingScheduler }   from '../coaching/protocol.js';
import { startAgendaScheduler }     from '../agenda/manager.js';
import { startEventDetector }       from '../conversation/event-detector.js';
import { startExpenseScheduler }    from '../expense/tracker.js';

// ─── Internal State ───────────────────────────────────────────────────────────

/**
 * Per-agent runtime state.
 * @type {Map<string, { running: boolean, tasks: import('node-cron').ScheduledTask[], startedAt: Date|null, stoppedAt: Date|null }>}
 */
const agentState = new Map();

/**
 * Agent definition table.
 *
 * id          - canonical ID (matches OS registry agent IDs)
 * label       - human-readable name for logs
 * startFn     - async/sync function that registers cron tasks (or intervals)
 * hasOwnStop  - true when the agent manages its own stop logic
 */
const AGENT_DEFS = [
  { id: 'ana',        label: 'Ana (Ops)',         startFn: startAnaScheduler },
  { id: 'alex',       label: 'Alex (DevOps)',      startFn: startAlexScheduler },
  { id: 'igor',       label: 'Igor (Orchestrator)', startFn: startIgorScheduler, hasOwnStop: true },
  // Augusto has no dedicated scheduler — he is event-driven (webhook).
  // Paulo SDR is driven by followup + nudge.
  { id: 'paulo',      label: 'Paulo (Followup)',   startFn: startFollowupScheduler },
  { id: 'nudge',      label: 'Nudge Poller',       startFn: startNudgePoller },
  { id: 'reports',    label: 'Reports',            startFn: startReportScheduler },
  { id: 'ads',        label: 'Ads Manager',        startFn: startAdsScheduler },
  { id: 'instagram',  label: 'Instagram',          startFn: startInstagramScheduler },
  { id: 'funnel',     label: 'Funnel Watcher',     startFn: startFunnelWatcher },
  { id: 'unanswered', label: 'Unanswered Monitor', startFn: startUnansweredMonitor },
  { id: 'coaching',   label: 'Coaching',           startFn: startCoachingScheduler },
  { id: 'agenda',     label: 'Agenda',             startFn: startAgendaScheduler },
  { id: 'events',     label: 'Event Detector',     startFn: startEventDetector },
  { id: 'expense',    label: 'Expense Tracker',    startFn: startExpenseScheduler },
];

// Convenience lookup
const AGENT_BY_ID = new Map(AGENT_DEFS.map(d => [d.id, d]));

// Initialise state entries
for (const def of AGENT_DEFS) {
  agentState.set(def.id, { running: false, tasks: [], startedAt: null, stoppedAt: null });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Return a snapshot of all task UUIDs currently registered in node-cron's
 * global store.
 *
 * @returns {Set<string>}
 */
function taskKeySnapshot() {
  const map = cron.getTasks();
  return new Set(map.keys());
}

/**
 * Collect tasks added since a previous snapshot.
 *
 * @param {Set<string>} before - Snapshot taken before calling startFn
 * @returns {import('node-cron').ScheduledTask[]}
 */
function newTasksSince(before) {
  const map = cron.getTasks();
  const tasks = [];
  for (const [key, task] of map.entries()) {
    if (!before.has(key)) {
      tasks.push(task);
    }
  }
  return tasks;
}

// ─── Core Control Logic ───────────────────────────────────────────────────────

/**
 * Start an agent's scheduler.
 *
 * If the agent is already running, this is a no-op (call restart to cycle it).
 *
 * @param {string} agentId
 * @returns {{ ok: boolean, agentId: string, tasksRegistered: number, warning?: string }}
 */
async function startAgent(agentId) {
  const def = AGENT_BY_ID.get(agentId);
  if (!def) {
    return { ok: false, agentId, error: `Unknown agent "${agentId}"` };
  }

  const state = agentState.get(agentId);

  if (state.running) {
    return { ok: true, agentId, already: true, tasksRegistered: state.tasks.length };
  }

  // Snapshot before
  const before = taskKeySnapshot();

  try {
    await def.startFn();
  } catch (err) {
    console.error(`[AgentControl] Failed to start ${def.label}:`, err.message);
    return { ok: false, agentId, error: err.message };
  }

  // Capture new tasks
  const newTasks = newTasksSince(before);

  state.running = true;
  state.tasks = newTasks;
  state.startedAt = new Date();
  state.stoppedAt = null;

  const result = { ok: true, agentId, tasksRegistered: newTasks.length };

  if (def.hasOwnStop) {
    result.warning = `${def.label} uses setInterval internally — stop will log a warning only. Restart the process to fully stop.`;
  }

  if (newTasks.length === 0 && !def.hasOwnStop) {
    result.warning = `${def.label} started but registered 0 cron tasks (may have been disabled by env/config).`;
  }

  console.log(`[AgentControl] Started ${def.label} — ${newTasks.length} cron task(s) captured`);
  return result;
}

/**
 * Stop an agent's scheduler.
 *
 * Calls .stop() on every captured cron task.  For agents that use
 * setInterval internally (hasOwnStop), we log a warning — a process
 * restart is required to fully clear those intervals.
 *
 * @param {string} agentId
 * @returns {{ ok: boolean, agentId: string, tasksStopped: number, warning?: string }}
 */
async function stopAgent(agentId) {
  const def = AGENT_BY_ID.get(agentId);
  if (!def) {
    return { ok: false, agentId, error: `Unknown agent "${agentId}"` };
  }

  const state = agentState.get(agentId);

  if (!state.running) {
    return { ok: true, agentId, already: true, tasksStopped: 0 };
  }

  let stopped = 0;
  const warnings = [];

  // Stop captured cron tasks
  for (const task of state.tasks) {
    try {
      task.stop();
      stopped++;
    } catch (err) {
      warnings.push(`task.stop() failed: ${err.message}`);
    }
  }

  if (def.hasOwnStop) {
    warnings.push(
      `${def.label} uses setInterval — cron tasks stopped but internal interval cannot be cleared without a restart.`
    );
    console.warn(`[AgentControl] WARN: ${def.label} setInterval not clearable. Cron tasks stopped: ${stopped}.`);
  }

  state.running = false;
  state.tasks = [];
  state.stoppedAt = new Date();

  console.log(`[AgentControl] Stopped ${def.label} — ${stopped} cron task(s) halted`);

  const result = { ok: true, agentId, tasksStopped: stopped };
  if (warnings.length) result.warnings = warnings;
  return result;
}

/**
 * Restart an agent: stop then start.
 *
 * @param {string} agentId
 * @returns {{ ok: boolean, agentId: string, stop: object, start: object }}
 */
async function restartAgent(agentId) {
  const stopResult = await stopAgent(agentId);
  // Brief gap so any in-flight callbacks can settle
  await new Promise(r => setTimeout(r, 250));
  const startResult = await startAgent(agentId);
  return {
    ok: stopResult.ok && startResult.ok,
    agentId,
    stop: stopResult,
    start: startResult,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Control an agent's lifecycle.
 *
 * @param {string} agentId
 * @param {'start'|'stop'|'restart'} action
 * @returns {Promise<object>} Result object with ok, agentId, and action-specific fields
 */
export async function controlAgent(agentId, action) {
  switch (action) {
    case 'start':
      return startAgent(agentId);
    case 'stop':
      return stopAgent(agentId);
    case 'restart':
      return restartAgent(agentId);
    default:
      return { ok: false, agentId, error: `Unknown action "${action}"` };
  }
}

/**
 * Return the full control state for all registered agents (or one agent).
 *
 * @param {string} [agentId] - If omitted, returns all agents.
 * @returns {object|Map}
 */
export function getControlState(agentId) {
  if (agentId) {
    const state = agentState.get(agentId);
    if (!state) return null;
    return {
      agentId,
      running: state.running,
      taskCount: state.tasks.length,
      startedAt: state.startedAt,
      stoppedAt: state.stoppedAt,
    };
  }

  const result = {};
  for (const [id, state] of agentState.entries()) {
    result[id] = {
      running: state.running,
      taskCount: state.tasks.length,
      startedAt: state.startedAt,
      stoppedAt: state.stoppedAt,
    };
  }
  return result;
}

/**
 * List all known agent IDs that this module can control.
 *
 * @returns {string[]}
 */
export function listControllableAgents() {
  return AGENT_DEFS.map(d => ({ id: d.id, label: d.label, hasOwnStop: !!d.hasOwnStop }));
}
