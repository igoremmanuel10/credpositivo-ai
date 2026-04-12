import { db } from '../db/client.js';
import { isOptOut } from './message.js';

export async function handleIncomingDispatchReply(phone, text) {
  if (!phone) return;
  try {
    const last4 = phone.slice(-8);
    const newStatus = isOptOut(text) ? 'optout' : 'respondeu';
    const r = await db.query(
      `UPDATE quiz_leads
          SET wa_dispatch_status = $1
        WHERE wa_dispatch_status IN ('enviado','novo')
          AND regexp_replace(whatsapp,'\\D','','g') LIKE '%' || $2
        RETURNING id, wa_dispatch_status`,
      [newStatus, last4]
    );
    if (r.rowCount > 0) {
      console.log(`[Dispatch] Reply detected for phone ${phone} → ${newStatus} (${r.rowCount} row)`);
    }
  } catch (err) {
    console.warn('[Dispatch] handleIncomingDispatchReply error:', err.message);
  }
}
