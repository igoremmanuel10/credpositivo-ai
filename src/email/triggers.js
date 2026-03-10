/**
 * Email Triggers — connects system events to Brevo emails.
 * Each function is called when an event fires.
 * Emails are sent async (fire-and-forget) so they never block the main flow.
 */

import { sendTemplate, upsertContact } from "./brevo-client.js";
import { TEMPLATE_IDS, buildParams } from "./templates.js";

/**
 * Helper: send email and log result. Never throws.
 */
async function safeSend(templateKey, email, nome, data) {
  try {
    const templateId = TEMPLATE_IDS[templateKey];
    if (!templateId) {
      console.warn(`[email-trigger] Unknown template key: ${templateKey}`);
      return;
    }
    const params = buildParams(templateKey, { nome, ...data });
    const result = await sendTemplate(templateId, email, nome, params);
    if (result.ok) {
      console.log(`[email-trigger] ${templateKey} sent to ${email}`);
    } else {
      console.error(`[email-trigger] ${templateKey} failed for ${email}:`, result.data);
    }
  } catch (err) {
    console.error(`[email-trigger] ${templateKey} error for ${email}:`, err.message);
  }
}

/** New user registered */
export async function onRegister({ email, nome }) {
  if (!email) return;
  await upsertContact(email, { FIRSTNAME: nome || "" }, [2]);
  await safeSend("WELCOME", email, nome, {});
}

/** Password reset requested */
export async function onForgotPassword({ email, nome, resetLink }) {
  if (!email) return;
  await safeSend("PASSWORD_RESET", email, nome, { resetLink });
}

/** Purchase confirmed */
export async function onPurchaseCompleted({ email, nome, produto, valor }) {
  if (!email) return;
  await safeSend("PURCHASE_CONFIRMED", email, nome, { produto, valor });
}

/** Pix payment generated */
export async function onPixGenerated({ email, nome, valor, pixCode, expiration }) {
  if (!email) return;
  await safeSend("PIX_GENERATED", email, nome, { valor, pixCode, expiration });
}

/** Purchase abandoned / pending */
export async function onPurchaseAbandoned({ email, nome, produto }) {
  if (!email) return;
  await safeSend("CART_ABANDONED", email, nome, { produto });
}
