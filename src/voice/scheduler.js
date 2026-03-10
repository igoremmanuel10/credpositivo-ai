/**
 * Vapi Voice Call Scheduler
 *
 * Periodically processes scheduled calls that were delayed
 * due to being triggered outside business hours.
 *
 * Runs every 15 minutes during business hours.
 *
 * Fernando Dev - CredPositivo
 */

import cron from 'node-cron';
import { config } from '../config.js';
import { processScheduledCalls } from './call-handler.js';
import { isVapiEnabled } from './vapi-client.js';
import { emit, setStatus } from '../os/emitter.js';

/**
 * Start the Vapi scheduled calls processor.
 * Only runs if Vapi is enabled.
 */
export function startVapiScheduler() {
  if (!isVapiEnabled()) {
    console.log('[Vapi Scheduler] Vapi not enabled, scheduler not started');
    return;
  }

  // Run every 15 minutes (at :00, :15, :30, :45)
  cron.schedule('*/15 * * * *', async () => {
    try {
      const result = await processScheduledCalls();
      const count = result?.processed ?? result?.count ?? 1;
      await emit('vapi.call_scheduled', 'vapi', { count });
      await setStatus('vapi', 'online');
    } catch (err) {
      console.error('[Vapi Scheduler] Error:', err.message);
    }
  });

  console.log('[Vapi Scheduler] Started (every 15 min during business hours)');
}
