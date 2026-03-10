/**
 * @file src/os/emitter.js
 * @description Lightweight OS event emitter for existing agents.
 * Import { emit, setStatus, reportMetrics } and call — zero config, non-fatal.
 */

let _publish = null;
let _updateStatus = null;
let _initDone = false;

async function lazyInit() {
  if (_initDone) return;
  _initDone = true;
  try {
    const bus = await import('./kernel/event-bus.js');
    _publish = bus.publish;
    const reg = await import('./kernel/registry.js');
    _updateStatus = reg.updateStatus;
  } catch {
    // OS kernel not loaded — all calls become no-ops
  }
}

/**
 * Emit an event to the AI OS EventBus.
 * Safe to call even if OS is not initialized.
 *
 * @param {string} type   - e.g. 'ana.cycle_complete', 'alex.health_check'
 * @param {string} agentId - e.g. 'ana', 'alex', 'igor'
 * @param {object} [payload={}]
 */
export async function emit(type, agentId, payload = {}) {
  await lazyInit();
  if (!_publish) return;
  try {
    await _publish({ type, agentId, payload });
  } catch { /* non-fatal */ }
}

/**
 * Update agent status in the OS registry.
 *
 * @param {string} agentId
 * @param {'online'|'busy'|'idle'|'offline'|'error'} status
 * @param {object} [metadata={}]
 */
export async function setStatus(agentId, status, metadata = {}) {
  await lazyInit();
  if (!_updateStatus) return;
  try {
    await _updateStatus(agentId, status, metadata);
  } catch { /* non-fatal */ }
}

/**
 * Report metrics for an agent. Emits agent.metrics event
 * so the dashboard and SSE clients receive live updates.
 *
 * @param {string} agentId
 * @param {object} metrics - arbitrary key/value pairs
 */
export async function reportMetrics(agentId, metrics = {}) {
  await lazyInit();
  if (!_publish) return;
  try {
    await _publish({
      type: 'agent.metrics',
      agentId,
      payload: metrics,
    });
  } catch { /* non-fatal */ }
}
