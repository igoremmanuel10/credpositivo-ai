/**
 * Email Hook — integrates email triggers with webhook events.
 * Called from webhooks.js after each event is processed.
 * All calls are fire-and-forget (never blocks the main flow).
 */

import { db } from "../db/client.js";
import {
  onPurchaseCompleted,
  onPurchaseAbandoned,
  onPixGenerated,
} from "./triggers.js";

/**
 * Look up email from phone number via conversation or user record.
 */
async function getEmailByPhone(phone) {
  try {
    const conv = await db.getConversation(phone);
    if (conv?.email) return { email: conv.email, nome: conv.name || conv.nome || "" };

    const result = await db.query(
      "SELECT email, nome FROM users WHERE telefone = $1 LIMIT 1",
      [phone]
    );
    if (result.rows?.[0]) {
      return { email: result.rows[0].email, nome: result.rows[0].nome || "" };
    }

    return null;
  } catch (err) {
    console.error(`[email-hook] getEmailByPhone error for ${phone}:`, err.message);
    return null;
  }
}

/**
 * Fire email for a given event. Called after the main webhook logic.
 * @param {string} event - Event name (e.g., "purchase_completed")
 * @param {string} phone - Normalized phone number
 * @param {object} data - Extra event data (produto, valor, etc.)
 */
export async function fireEmailForEvent(event, phone, data = {}) {
  try {
    let email = data.email;
    let nome = data.nome || "";

    if (!email) {
      const lookup = await getEmailByPhone(phone);
      if (!lookup?.email) {
        console.log(`[email-hook] No email found for ${phone}, skipping ${event}`);
        return;
      }
      email = lookup.email;
      nome = nome || lookup.nome;
    }

    console.log(`[email-hook] Firing ${event} email to ${email}`);

    switch (event) {
      case "purchase_completed":
        await onPurchaseCompleted({ email, nome, produto: data.produto, valor: data.valor });
        break;

      case "purchase_abandoned":
        await onPurchaseAbandoned({ email, nome, produto: data.produto });
        break;

      case "pix_generated":
        await onPixGenerated({ email, nome, valor: data.valor, pixCode: data.pixCode, expiration: data.expiration });
        break;

      default:
        console.log(`[email-hook] No email trigger for event: ${event}`);
    }
  } catch (err) {
    console.error(`[email-hook] Error firing ${event} for ${phone}:`, err.message);
  }
}
