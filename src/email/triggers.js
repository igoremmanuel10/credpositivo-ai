/**
 * Email Triggers — connects system events to Brevo emails.
 * Each function is called from webhooks.js or users.js when an event fires.
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

// ── Transactional Triggers ──────────────────────────────────────────────────

/** POST /api/register — new user registered */
export async function onRegister({ email, nome }) {
  if (!email) return;
  // Sync contact to Brevo
  await upsertContact(email, { FIRSTNAME: nome || "" }, [2]); // list 2 = all users
  await safeSend("WELCOME", email, nome, {});
}

/** POST /api/forgot-password */
export async function onForgotPassword({ email, nome, resetLink }) {
  if (!email) return;
  await safeSend("PASSWORD_RESET", email, nome, { resetLink });
}

/** POST /api/events/purchase-completed */
export async function onPurchaseCompleted({ email, nome, produto, valor }) {
  if (!email) return;
  await safeSend("PURCHASE_CONFIRMED", email, nome, { produto, valor });
}

/** POST /api/events/purchase-abandoned */
export async function onPurchaseAbandoned({ email, nome, produto }) {
  if (!email) return;
  await safeSend("CART_ABANDONED", email, nome, { produto });
}

/** Mercado Pago webhook — pix created */
export async function onPixGenerated({ email, nome, valor, pixCode, expiration }) {
  if (!email) return;
  await safeSend("PIX_GENERATED", email, nome, { valor, pixCode, expiration });
}

/** Mercado Pago webhook — pix expired/cancelled */
export async function onPixExpired({ email, nome, valor }) {
  if (!email) return;
  await safeSend("PIX_EXPIRED", email, nome, { valor });
}

/** POST /api/events/signup-completed — signed up but didn't buy */
export async function onSignupCompleted({ email, nome }) {
  if (!email) return;
  await safeSend("FOLLOWUP", email, nome, {});
}

/** POST /api/events/diagnosis-completed */
export async function onDiagnosisCompleted({ email, nome, resultado, score }) {
  if (!email) return;
  await safeSend("DIAGNOSIS_COMPLETED", email, nome, { resultado, score });
}

/** POST /api/events/limpa-completed or rating-completed — upsell */
export async function onServiceCompleted({ email, nome, servico }) {
  if (!email) return;
  await safeSend("SERVICE_COMPLETED", email, nome, { servico });
  // Send upsell after 2 hours
  setTimeout(() => {
    safeSend("UPSELL", email, nome, { servicoConcluido: servico });
  }, 2 * 60 * 60 * 1000);
}

// ── Educativo Triggers ──────────────────────────────────────────────────────

export async function onJourneyInvite({ email, nome }) {
  if (!email) return;
  await safeSend("JOURNEY_INVITE", email, nome, {});
}

export async function onModuleAvailable({ email, nome, moduloNome, moduloDesc }) {
  if (!email) return;
  await safeSend("MODULE_AVAILABLE", email, nome, { moduloNome, moduloDesc });
}

export async function onModuleReminder({ email, nome, moduloNome }) {
  if (!email) return;
  await safeSend("MODULE_REMINDER", email, nome, { moduloNome });
}

export async function onPhaseAdvance({ email, nome, faseAnterior, novaFase, cpGanhos }) {
  if (!email) return;
  await safeSend("PHASE_ADVANCE", email, nome, { faseAnterior, novaFase, cpGanhos });
}

export async function onCreditTip({ email, nome, dicaNumero, dicaTitulo, dicaIntro, dicaConteudo, dicaPratica }) {
  if (!email) return;
  await safeSend("CREDIT_TIP", email, nome, { dicaNumero, dicaTitulo, dicaIntro, dicaConteudo, dicaPratica });
}
