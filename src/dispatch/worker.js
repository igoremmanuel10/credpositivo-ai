import { db } from '../db/client.js';
import { sendText, resolveWhatsAppId } from '../quepasa/client.js';
import { dispatchConfig, isWithinWindow, randomDelayMs } from './config.js';
import { buildDispatchMessage } from './message.js';

let running = false;
let sentToday = 0;
let lastResetDay = null;

function todayKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: dispatchConfig.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function resetCounterIfNewDay() {
  const today = todayKey();
  if (lastResetDay !== today) {
    lastResetDay = today;
    sentToday = 0;
  }
}

async function pickNextLead() {
  const r = await db.query(
    `SELECT id, nome, whatsapp, nivel
       FROM quiz_leads
      WHERE wa_dispatch_status = 'novo'
        AND whatsapp IS NOT NULL
        AND length(regexp_replace(whatsapp,'\\D','','g')) >= 10
        AND created_at >= NOW() - ($1 || ' days')::interval
      ORDER BY created_at DESC
      LIMIT 1`,
    [String(dispatchConfig.maxLeadAgeDays)]
  );
  return r.rows[0] || null;
}

async function markStatus(id, status, extra = {}) {
  const sets = [`wa_dispatch_status = $2`];
  const values = [id, status];
  if (extra.incrementCount) {
    sets.push(`wa_dispatch_count = COALESCE(wa_dispatch_count,0) + 1`);
    sets.push(`wa_dispatch_last_at = NOW()`);
  }
  if (extra.error !== undefined) {
    values.push(extra.error);
    sets.push(`wa_dispatch_error = $${values.length}`);
  }
  await db.query(`UPDATE quiz_leads SET ${sets.join(', ')} WHERE id = $1`, values);
}

async function dispatchOne() {
  const lead = await pickNextLead();
  if (!lead) return { status: 'empty' };

  // Mark as in-progress immediately to avoid double-pick on concurrent ticks
  await markStatus(lead.id, 'enviando');

  const rawPhone = String(lead.whatsapp || '').replace(/\D/g, '');
  const phone = rawPhone.startsWith('55') ? rawPhone : `55${rawPhone}`;

  try {
    const jid = await resolveWhatsAppId(phone, dispatchConfig.token);
    if (!jid) {
      await markStatus(lead.id, 'invalido', { error: 'not_on_whatsapp' });
      return { status: 'invalid', leadId: lead.id };
    }

    const text = buildDispatchMessage(lead);
    await sendText(jid, text, dispatchConfig.token);

    await markStatus(lead.id, 'enviado', { incrementCount: true });
    sentToday++;
    console.log(`[Dispatch] Sent to lead ${lead.id} (${phone}). Today: ${sentToday}/${dispatchConfig.dailyCap}`);
    return { status: 'sent', leadId: lead.id };
  } catch (err) {
    await markStatus(lead.id, 'erro', { error: String(err.message || err).slice(0, 500) });
    console.warn(`[Dispatch] Send error lead ${lead.id}:`, err.message);
    return { status: 'error', leadId: lead.id };
  }
}

async function tick() {
  if (running) return;
  if (!dispatchConfig.enabled) return;
  if (!dispatchConfig.token) {
    console.warn('[Dispatch] No DISPATCH_QUEPASA_TOKEN configured, skipping tick');
    return;
  }
  resetCounterIfNewDay();
  if (!isWithinWindow()) return;
  if (sentToday >= dispatchConfig.dailyCap) return;

  running = true;
  try {
    const result = await dispatchOne();
    if (result.status === 'empty') return;

    // Wait random delay before next send (bounded by remaining window check next tick)
    const delay = randomDelayMs();
    console.log(`[Dispatch] Next send in ~${Math.round(delay / 1000)}s`);
    await new Promise((r) => setTimeout(r, delay));
  } catch (err) {
    console.error('[Dispatch] Tick error:', err.message);
  } finally {
    running = false;
  }
}

export function startDispatchWorker() {
  if (!dispatchConfig.enabled) {
    console.log('[Dispatch] Worker DISABLED (set DISPATCH_ENABLED=true to activate)');
    return;
  }
  if (!dispatchConfig.token) {
    console.warn('[Dispatch] DISPATCH_QUEPASA_TOKEN not set — worker will idle');
  }
  console.log(
    `[Dispatch] Worker ON | cap=${dispatchConfig.dailyCap}/day | window=${dispatchConfig.windowStartHour}-${dispatchConfig.windowEndHour} ${dispatchConfig.timezone} | delay=${Math.round(dispatchConfig.delayMinMs/1000)}-${Math.round(dispatchConfig.delayMaxMs/1000)}s`
  );
  setInterval(() => {
    tick().catch((err) => console.error('[Dispatch] Unhandled:', err.message));
  }, 15000);
}

export function getDispatchStatus() {
  return {
    enabled: dispatchConfig.enabled,
    running,
    sentToday,
    dailyCap: dispatchConfig.dailyCap,
    window: `${dispatchConfig.windowStartHour}-${dispatchConfig.windowEndHour} ${dispatchConfig.timezone}`,
    withinWindow: isWithinWindow(),
  };
}
