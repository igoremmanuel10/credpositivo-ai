/**
 * @file src/os/engine/workflows.js
 * @description Event-driven workflow engine for AI OS.
 * Listens to EventBus events and triggers automated responses.
 */

import { subscribeAll, publish } from '../kernel/event-bus.js';
import { updateStatus } from '../kernel/registry.js';

// Built-in workflow rules
const RULES = [
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
      // Track Augusto activity for metrics
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

let unsubscribe = null;
let ruleStats = {};

/**
 * Start the workflow engine.
 * Subscribes to all EventBus events and evaluates rules.
 */
export async function startWorkflows() {
  if (unsubscribe) return; // Already running

  // Initialize stats
  for (const rule of RULES) {
    ruleStats[rule.id] = { triggered: 0, lastTriggered: null };
  }

  unsubscribe = await subscribeAll(async (event) => {
    for (const rule of RULES) {
      try {
        // Match trigger type (supports wildcards later)
        if (rule.trigger.type && rule.trigger.type !== event.type) continue;

        // Evaluate condition
        if (rule.condition && !rule.condition(event)) continue;

        // Execute action
        await rule.action(event);
        ruleStats[rule.id].triggered++;
        ruleStats[rule.id].lastTriggered = new Date().toISOString();
      } catch (err) {
        console.error(`[Workflow] Rule "${rule.id}" error:`, err.message);
      }
    }
  });

  console.log(`[Workflow] Engine started with ${RULES.length} rules`);
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

/**
 * Get workflow stats.
 * @returns {object} Rule execution stats
 */
export function getWorkflowStats() {
  return {
    running: !!unsubscribe,
    rules: RULES.map((r) => ({
      id: r.id,
      name: r.name,
      triggerType: r.trigger.type,
      ...ruleStats[r.id],
    })),
  };
}
