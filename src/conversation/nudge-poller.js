/**
 * Nudge Poller — checks Redis for pending nudges and sends them.
 *
 * Nudges are scheduled by media-rules.js after sending educational material.
 * If the lead doesn't respond within the nudge delay, we send a follow-up text.
 */

import { cache } from '../db/redis.js';
import { shouldSendNudge } from '../flow/media-rules.js';
import { sendMessages } from '../quepasa/client.js';

const POLL_INTERVAL_MS = 10000; // Check every 10 seconds

/**
 * Start the nudge polling loop.
 */
export function startNudgePoller() {
  console.log(`[NudgePoller] ATIVADO — checking every ${POLL_INTERVAL_MS / 1000}s`);

  setInterval(async () => {
    try {
      const nudgeKeys = await cache.getNudgeKeys();
      if (!nudgeKeys || nudgeKeys.length === 0) return;

      for (const key of nudgeKeys) {
        const phone = key.replace('nudge:', '');
        const nudgeData = await shouldSendNudge(phone);

        if (nudgeData && nudgeData.nudgeText) {
          const target = nudgeData.remoteJid || `${phone}@s.whatsapp.net`;
          const token = nudgeData.botToken || null;

          try {
            await sendMessages(target, nudgeData.nudgeText, token);
            console.log(`[NudgePoller] Nudge sent to ${phone}: "${nudgeData.nudgeText.substring(0, 50)}"`);
          } catch (err) {
            console.error(`[NudgePoller] Failed to send nudge to ${phone}:`, err.message);
          }
        }
      }
    } catch (err) {
      console.error('[NudgePoller] Error in poll cycle:', err.message);
    }
  }, POLL_INTERVAL_MS);
}
