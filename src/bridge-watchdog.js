/**
 * Bridge Watchdog - monitors bridge health and sends WhatsApp alerts
 * when the Chatwoot <-> WhatsApp bridge stops working.
 *
 * Checks every 5 minutes. If no bridge activity for 30 minutes during
 * business hours (8h-20h BRT), sends alert to admin phones.
 */

import { getBridgeHealth, isAlertSent, markAlertSent } from './bridge-health.js';
import { sendText } from './quepasa/client.js';

const ALERT_PHONES = ['5511932145806', '557191234115', '557187700120'];
const CHECK_INTERVAL_MS = 5 * 60 * 1000;     // 5 minutes
const STALE_THRESHOLD_MS = 30 * 60 * 1000;   // 30 minutes

function isBusinessHours() {
  const now = new Date();
  const brt = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const hour = brt.getHours();
  return hour >= 8 && hour < 20;
}

async function sendAlert(message) {
  for (const phone of ALERT_PHONES) {
    try {
      await sendText(phone, message);
      console.log(`[Bridge Watchdog] Alert sent to ${phone}`);
    } catch (err) {
      console.error(`[Bridge Watchdog] Failed to alert ${phone}:`, err.message);
    }
  }
}

function checkBridgeHealth() {
  if (!isBusinessHours()) return;

  const health = getBridgeHealth();

  // Don't alert if we already sent one (resets when bridge recovers)
  if (isAlertSent()) return;

  const now = Date.now();

  // Check Quepasa -> Chatwoot direction
  if (health.lastQuepasaToChatwoot) {
    const lastActivity = new Date(health.lastQuepasaToChatwoot).getTime();
    const age = now - lastActivity;
    if (age > STALE_THRESHOLD_MS) {
      const mins = Math.round(age / 60000);
      sendAlert(
        `ALERTA BRIDGE: Nenhuma mensagem do WhatsApp chegou no Chatwoot nos ultimos ${mins} minutos. Verifique o sistema.`
      );
      markAlertSent();
      return;
    }
  }

  // Check for repeated errors
  if (health.errorCount >= 5) {
    const lastErr = health.lastError ? health.lastError.message : 'desconhecido';
    sendAlert(
      `ALERTA BRIDGE: ${health.errorCount} erros consecutivos no bridge. Ultimo erro: ${lastErr}`
    );
    markAlertSent();
  }
}

export function startBridgeWatchdog() {
  const checkMins = CHECK_INTERVAL_MS / 60000;
  const staleMins = STALE_THRESHOLD_MS / 60000;
  console.log(`[Bridge Watchdog] Started (check every ${checkMins} min, alert after ${staleMins} min stale)`);
  setInterval(checkBridgeHealth, CHECK_INTERVAL_MS);
}
