/**
 * Email Hook — integrates email triggers with webhook events.
 * Called from webhooks.js after each event is processed.
 * All calls are fire-and-forget (never blocks the main flow).
 */

import { db } from "../db/client.js";
import {
  onPurchaseCompleted,
  onPurchaseAbandoned,
  onSignupCompleted,
  onDiagnosisCompleted,
  onServiceCompleted,
} from "./triggers.js";

/**
 * Look up email from phone number via conversation or user record.
 */
async function getEmailByPhone(phone) {
  try {
    // Try conversation metadata first
    const conv = await db.getConversation(phone);
    if (conv?.email) return { email: conv.email, nome: conv.name || conv.nome || "" };

    // Try users table
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
    // If email is already in data, use it directly
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
      case "signup_completed":
        await onSignupCompleted({ email, nome });
        break;

      case "purchase_completed":
        await onPurchaseCompleted({ email, nome, produto: data.produto, valor: data.valor });
        break;

      case "purchase_abandoned":
        await onPurchaseAbandoned({ email, nome, produto: data.produto });
        break;

      case "diagnosis_completed":
        await onDiagnosisCompleted({ email, nome, resultado: data.resultado, score: data.score });
        break;

      case "limpa_completed":
        await onServiceCompleted({ email, nome, servico: "Limpa Nome" });
        break;

      case "rating_completed":
        await onServiceCompleted({ email, nome, servico: "Rating Bancário" });
        break;

      default:
        console.log(`[email-hook] No email trigger for event: ${event}`);
    }
  } catch (err) {
    console.error(`[email-hook] Error firing ${event} for ${phone}:`, err.message);
  }
}
