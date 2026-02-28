/**
 * Bridge health tracker - monitors Chatwoot <-> WhatsApp bridge activity.
 * Tracks last successful message in each direction.
 */

const state = {
  lastQuepasaToChatwoot: null,  // WhatsApp -> Chatwoot
  lastChatwootToQuepasa: null,  // Chatwoot -> WhatsApp
  lastError: null,
  errorCount: 0,
  alertSent: false,             // Prevent repeated alerts
};

export function trackBridgeActivity(direction) {
  const now = new Date().toISOString();
  if (direction === 'quepasa-to-chatwoot') {
    state.lastQuepasaToChatwoot = now;
  } else if (direction === 'chatwoot-to-quepasa') {
    state.lastChatwootToQuepasa = now;
  }
  state.errorCount = 0;
  state.alertSent = false;
}

export function trackBridgeError(error) {
  state.lastError = {
    message: error.message || String(error),
    timestamp: new Date().toISOString(),
  };
  state.errorCount++;
}

export function getBridgeHealth() {
  return { ...state };
}

export function markAlertSent() {
  state.alertSent = true;
}

export function isAlertSent() {
  return state.alertSent;
}
