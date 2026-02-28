/**
 * Voice Call Handler (Dual Mode: Web Call + Outbound PSTN)
 *
 * Decides WHEN and HOW to initiate voice calls via Vapi.ai.
 * Supports two modes:
 * - "web": Generates a browser link and sends it to the lead via WhatsApp
 * - "outbound": Makes a real PSTN phone call (phone rings directly)
 *
 * Supported triggers:
 * 1. purchase_abandoned (Rating R$997) -- high-value lead abandoned checkout
 * 2. diagnosis_completed (complex result) -- result too complex for text
 * 3. followup_hot_lead (phase 3-4) -- follow-up call for hot leads
 * 4. manual_test -- admin test call (skips business hours)
 *
 * Fernando Dev - CredPositivo
 */

import { config } from '../config.js';
import { db } from '../db/client.js';
import { cache } from '../db/redis.js';
import { createWebCall, createOutboundCall, isVapiEnabled, isVapiOutboundEnabled } from './vapi-client.js';
import { sendText } from '../quepasa/client.js';
import { logCallToChatwoot } from "../chatwoot/client.js";

/**
 * Attempt to initiate a voice call for a specific event.
 *
 * @param {string} phone - Lead phone number (Brazilian format, e.g. 5571999999999)
 * @param {string} eventType - Event that triggered the call (purchase_abandoned, diagnosis_completed, manual_test)
 * @param {Object} eventData - Additional event data (produto, valor, etc.)
 * @param {string|null} mode - Call mode: null=auto, "outbound"=PSTN, "web"=browser link
 * @returns {Object|null} Call result or null if skipped
 */
export async function handleVoiceCallTrigger(phone, eventType, eventData = {}, mode = null) {
  // 1. Check if Vapi is enabled
  if (!isVapiEnabled()) {
    console.log(`[VoiceCall] Vapi not enabled, skipping call for ${phone} (${eventType})`);
    return null;
  }

  // 2. Check if this event type qualifies for a call
  if (!shouldCallForEvent(eventType, eventData)) {
    console.log(`[VoiceCall] Event ${eventType} does not qualify for call (${phone})`);
    return null;
  }

  // 3. Check rate limit (max calls per lead per day) — skip for manual_test
  if (eventType !== 'manual_test' && eventType !== 'followup_hot_lead') {
    const rateLimitOk = await checkCallRateLimit(phone);
    if (!rateLimitOk) {
      console.log(`[VoiceCall] Rate limit reached for ${phone}, skipping call`);
      return null;
    }
  }

  // 4. Check business hours — skip for manual_test
  if (eventType !== 'manual_test' && !isBusinessHours()) {
    console.log(`[VoiceCall] Outside business hours, scheduling delayed call for ${phone}`);
    await scheduleDelayedCall(phone, eventType, eventData);
    return { scheduled: true, phone, eventType };
  }

  // 5. Check if lead opted out — skip for manual_test
  if (eventType !== 'manual_test') {
    const conversation = await db.getConversation(phone);
    if (conversation?.opted_out) {
      console.log(`[VoiceCall] Lead ${phone} opted out, skipping call`);
      return null;
    }
  }

  // 6. Resolve call mode
  const resolvedMode = resolveCallMode(mode);
  console.log(`[VoiceCall] Resolved mode: ${resolvedMode} (requested: ${mode || 'auto'})`);

  // 7. Initiate call based on mode
  try {
    const conversation = await db.getConversation(phone);

    if (resolvedMode === 'outbound') {
      const callResult = await initiateOutboundCall(phone, eventType, eventData, conversation);
      return callResult;
    } else {
      const callResult = await initiateWebCall(phone, eventType, eventData, conversation);
      return callResult;
    }
  } catch (err) {
    const callMode = resolvedMode === 'outbound' ? 'outbound' : 'web';
    console.error(`[VoiceCall] Failed to initiate ${callMode} call for ${phone}:`, err.message);
    await logCallAttempt(phone, eventType, 'failed', null, err.message, null, 'vapi', callMode);
    return null;
  }
}

/**
 * Resolve the effective call mode.
 * null/auto = outbound if configured, otherwise web.
 */
function resolveCallMode(mode) {
  if (mode === 'outbound') {
    if (!isVapiOutboundEnabled()) {
      console.warn('[VoiceCall] Outbound requested but not configured, falling back to web');
      return 'web';
    }
    return 'outbound';
  }
  if (mode === 'web') return 'web';

  // Auto: prefer outbound if fully configured
  return isVapiOutboundEnabled() ? 'outbound' : 'web';
}

/**
 * Determine if an event type qualifies for a voice call.
 */
function shouldCallForEvent(eventType, eventData = {}) {
  switch (eventType) {
    case 'purchase_abandoned':
      // Only call for high-value product (Rating R$997)
      const produto = (eventData.produto || '').toLowerCase();
      // Call for rating OR if no product specified (assume high-value)
      return produto.includes('rating') || produto.includes('reconstrucao') || !eventData.produto;

    case 'diagnosis_completed':
      // Call when result is complex (multiple issues found)
      return eventData.complex === true || eventData.issues_count > 3;

    case 'followup_hot_lead':
      // Call for hot leads (phase 3-4) during follow-up sequence
      return eventData.phase >= 3;

    case 'manual_test':
      // Always allow manual test calls
      return true;

    default:
      return false;
  }
}

/**
 * Check if we haven't exceeded max calls per lead per day.
 * Uses Redis counter with 24h TTL.
 */
async function checkCallRateLimit(phone) {
  const current = await cache.getVapiCallCount(phone);
  return current < config.vapi.maxCallsPerLeadPerDay;
}

/**
 * Increment the call counter for rate limiting.
 */
async function incrementCallCounter(phone) {
  return cache.incrementVapiCallCount(phone);
}

/**
 * Check if current time is within business hours.
 * Business hours: 8:00 - 20:00 BRT (UTC-3)
 */
function isBusinessHours() {
  const now = new Date();
  // Convert to BRT (UTC-3)
  const brtHour = (now.getUTCHours() - 3 + 24) % 24;
  return brtHour >= 8 && brtHour < 20;
}

/**
 * Schedule a delayed call for next business hours window.
 * Stores in Redis with TTL, checked by a periodic job.
 */
async function scheduleDelayedCall(phone, eventType, eventData) {
  await cache.scheduleVapiCall(phone, {
    phone,
    eventType,
    eventData,
    scheduledAt: new Date().toISOString(),
  });
  console.log(`[VoiceCall] Scheduled delayed call for ${phone} (${eventType})`);
}

/**
 * Initiate an outbound PSTN call via Vapi.
 * The phone rings directly — no WhatsApp message needed.
 */
async function initiateOutboundCall(phone, eventType, eventData, conversation) {
  const leadName = conversation?.name || 'amigo';
  const produto = eventData.produto || conversation?.recommended_product || '';

  const overrides = buildCallOverrides(eventType, leadName, produto, eventData);

  console.log(`[VoiceCall] Creating outbound PSTN call for ${phone} (${eventType}, lead: ${leadName})`);

  const call = await createOutboundCall(phone, {
    assistantOverrides: overrides,
    metadata: {
      eventType,
      phone,
      leadName,
      produto,
      conversationId: conversation?.id?.toString() || '',
    },
  });

  // Increment rate limit counter
  await incrementCallCounter(phone);

  // Log to database
  await logCallAttempt(phone, eventType, 'initiated', call.id, null, null, 'vapi', 'outbound');

  // Register call in Chatwoot dashboard
  logCallToChatwoot(phone, "vapi", eventType).catch(err => {
    console.error("[VoiceCall] Chatwoot call log failed:", err.message);
  });

  return { callId: call.id, phone, eventType, status: 'initiated', mode: 'outbound' };
}

/**
 * Create a Vapi web call and send the link to the lead via WhatsApp.
 */
async function initiateWebCall(phone, eventType, eventData, conversation) {
  const leadName = conversation?.name || 'amigo';
  const produto = eventData.produto || conversation?.recommended_product || '';

  // Build context-specific first message and overrides
  const overrides = buildCallOverrides(eventType, leadName, produto, eventData);

  console.log(`[VoiceCall] Creating web call for ${phone} (${eventType}, lead: ${leadName})`);

  // Create the web call via Vapi API
  const call = await createWebCall({
    assistantOverrides: overrides,
    metadata: {
      eventType,
      phone,
      leadName,
      produto,
      conversationId: conversation?.id?.toString() || '',
    },
  });

  const webCallUrl = call.webCallUrl;
  if (!webCallUrl) {
    throw new Error('Vapi did not return a webCallUrl');
  }

  // Build the WhatsApp message with the call link
  const whatsappMessage = buildWhatsAppMessage(eventType, leadName, produto, webCallUrl);

  // Send the link via WhatsApp
  const chatId = formatChatId(phone);
  await sendText(chatId, whatsappMessage);
  console.log(`[VoiceCall] Web call link sent to ${phone} via WhatsApp: ${webCallUrl}`);

  // Increment rate limit counter
  await incrementCallCounter(phone);

  // Log to database
  await logCallAttempt(phone, eventType, 'link_sent', call.id, null, webCallUrl, 'vapi', 'web');

  // Register call in Chatwoot dashboard
  logCallToChatwoot(phone, "vapi", eventType).catch(err => {
    console.error("[VoiceCall] Chatwoot call log failed:", err.message);
  });

  return { callId: call.id, phone, eventType, webCallUrl, status: 'link_sent', mode: 'web' };
}

/**
 * Build the WhatsApp message with the web call link.
 */
function buildWhatsAppMessage(eventType, leadName, produto, webCallUrl) {
  const nome = leadName !== 'amigo' ? leadName : '';

  switch (eventType) {
    case 'purchase_abandoned': {
      const produtoNome = formatProductName(produto);
      return [
        `Oi${nome ? ' ' + nome : ''}! Aqui e o Paulo, a inteligencia artificial do Grupo CredPositivo.`,
        '',
        `Vi que voce estava dando uma olhada no nosso servico${produtoNome ? ' de ' + produtoNome : ''} e queria te ajudar com qualquer duvida.`,
        '',
        `Preparei uma chamada rapida pra gente conversar. E so clicar no link abaixo e falar comigo pelo navegador (nao precisa instalar nada):`,
        '',
        webCallUrl,
        '',
        `Fico te esperando! A chamada dura no maximo 5 minutos.`,
      ].join('\n');
    }

    case 'diagnosis_completed': {
      return [
        `Oi${nome ? ' ' + nome : ''}! Aqui e o Paulo, a inteligencia artificial do Grupo CredPositivo.`,
        '',
        `Seu diagnostico de credito ficou pronto e tem algumas coisas importantes que quero te explicar pessoalmente.`,
        '',
        `Preparei uma chamada rapida pra gente conversar. E so clicar no link abaixo e falar comigo pelo navegador (nao precisa instalar nada):`,
        '',
        webCallUrl,
        '',
        `Te espero la! A chamada dura no maximo 5 minutos.`,
      ].join('\n');
    }

    default: {
      return [
        `Oi${nome ? ' ' + nome : ''}! Aqui e o Paulo, a inteligencia artificial do Grupo CredPositivo.`,
        '',
        `Quero conversar com voce sobre sua situacao de credito. E so clicar no link abaixo e falar comigo pelo navegador:`,
        '',
        webCallUrl,
        '',
        `Te espero!`,
      ].join('\n');
    }
  }
}

/**
 * Format phone number as WhatsApp chat ID.
 * Input: 5571999999999 or +5571999999999
 * Output: 5571999999999@s.whatsapp.net
 */
function formatChatId(phone) {
  const clean = phone.replace(/\D/g, '');
  // Ensure starts with 55
  const normalized = clean.startsWith('55') ? clean : `55${clean}`;
  return `${normalized}@s.whatsapp.net`;
}

/**
 * Build assistant overrides based on the call context.
 * Customizes first message and system prompt additions per event type.
 */
function buildCallOverrides(eventType, leadName, produto, eventData) {
  const overrides = {};

  switch (eventType) {
    case 'purchase_abandoned': {
      overrides.firstMessage = `Oi${leadName !== 'amigo' ? ', ' + leadName : ''}! Aqui e o Paulo, a inteligencia artificial do Grupo CredPositivo. Que bom que voce entrou na chamada! Vi que voce estava dando uma olhada no nosso servico${produto ? ' de ' + formatProductName(produto) : ''}. Posso te ajudar com alguma duvida?`;

      overrides.model = {
        messages: [
          {
            role: 'system',
            content: `CONTEXTO DESTA CHAMADA: O lead ${leadName} abandonou o checkout${produto ? ' do produto ' + produto : ''}. Seu objetivo e entender o motivo (duvida? problema tecnico? preco?) e ajudar. NAO pressione. Se o lead disser que nao tem interesse, agradeca e encerre. Se tiver duvidas, responda e direcione para o site. Valor do Rating: R$997 (inclui Limpa Nome + reconstrucao de perfil bancario).`,
          },
        ],
      };
      break;
    }

    case 'diagnosis_completed': {
      overrides.firstMessage = `Oi${leadName !== 'amigo' ? ', ' + leadName : ''}! Aqui e o Paulo, a inteligencia artificial do Grupo CredPositivo. Que bom que voce entrou na chamada! Seu diagnostico de credito ficou pronto e tem algumas coisas importantes que quero te explicar. Pode falar agora?`;

      overrides.model = {
        messages: [
          {
            role: 'system',
            content: `CONTEXTO DESTA CHAMADA: O lead ${leadName} fez o Diagnostico de Credito (R$97) e o resultado mostrou situacao complexa${eventData.summary ? ': ' + eventData.summary : ''}. Explique o resultado de forma simples e acessivel. Se fizer sentido, mencione que o servico Limpa Nome (R$397) pode ajudar a resolver as pendencias encontradas. NAO force venda. Seja genuinamente util.`,
          },
        ],
      };
      break;
    }

    case 'followup_hot_lead': {
      const personaName = eventData?.persona === 'paulo' ? 'Paulo' : 'Augusto';
      overrides.firstMessage = `Oi${leadName !== 'amigo' ? ', ' + leadName : ''}! Aqui e o ${personaName}, a inteligencia artificial do Grupo CredPositivo. Estou ligando porque a gente conversou antes sobre sua situacao de credito e queria saber se posso te ajudar com alguma duvida.`;

      overrides.model = {
        messages: [
          {
            role: 'system',
            content: `CONTEXTO DESTA CHAMADA: Follow-up de lead quente (fase ${eventData?.phase || 3}). O lead ${leadName} ja conversou no WhatsApp e mostrou interesse${produto ? ' em ' + formatProductName(produto) : ''}. Esta e uma ligacao de follow-up (tentativa ${eventData?.attempt || 1}). Seu objetivo e retomar o contato de forma amigavel, entender o que faltou pra ele decidir, e responder duvidas. NAO pressione. Se nao tiver interesse, agradeca e encerre gentilmente. Se tiver duvidas sobre preco: Diagnostico R$97, Limpa Nome R$397, Rating R$997.`,
          },
        ],
      };
      break;
    }

    case 'manual_test': {
      overrides.firstMessage = `Oi! Aqui e o Paulo, a inteligencia artificial do Grupo CredPositivo. Essa e uma chamada de teste. Como posso te ajudar?`;
      break;
    }
  }

  return overrides;
}

/**
 * Format product name for natural speech.
 */
function formatProductName(produto) {
  const names = {
    'diagnostico': 'Diagnostico de Credito',
    'limpa_nome': 'Limpa Nome',
    'rating': 'Rating Bancario',
    'reconstrucao': 'Reconstrucao de Perfil',
  };
  return names[produto?.toLowerCase()] || produto || '';
}

/**
 * Log a call attempt to the database.
 *
 * @param {string} phone
 * @param {string} eventType
 * @param {string} status
 * @param {string|null} vapiCallId
 * @param {string|null} errorMessage
 * @param {string|null} webCallUrl
 * @param {string} provider - 'vapi' or 'wavoip'
 * @param {string} callMode - 'web', 'outbound', or 'whatsapp'
 */
export async function logCallAttempt(phone, eventType, status, vapiCallId = null, errorMessage = null, webCallUrl = null, provider = 'vapi', callMode = 'web') {
  try {
    await db.query(
      `INSERT INTO voice_calls (phone, event_type, status, vapi_call_id, error_message, web_call_url, provider, call_mode, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [phone, eventType, status, vapiCallId, errorMessage, webCallUrl, provider, callMode]
    );
  } catch (err) {
    // Fallback: if new columns don't exist yet (migration not run), try without them
    if (err.message.includes('provider') || err.message.includes('call_mode') || err.message.includes('web_call_url')) {
      try {
        await db.query(
          `INSERT INTO voice_calls (phone, event_type, status, vapi_call_id, error_message, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())`,
          [phone, eventType, status, vapiCallId, errorMessage]
        );
      } catch (innerErr) {
        console.error(`[VoiceCall] Failed to log call attempt:`, innerErr.message);
      }
    } else {
      console.error(`[VoiceCall] Failed to log call attempt:`, err.message);
    }
  }
}

/**
 * Update call status in the database (called from webhook handler).
 *
 * @param {string} vapiCallId - Vapi call ID
 * @param {string} status - New status (ringing, in-progress, ended, failed)
 * @param {Object} details - Additional details (duration, endedReason, transcript)
 */
export async function updateCallStatus(vapiCallId, status, details = {}) {
  try {
    const updates = [`status = $2`, `updated_at = NOW()`];
    const values = [vapiCallId, status];
    let idx = 3;

    if (details.duration !== undefined) {
      updates.push(`duration_seconds = $${idx}`);
      values.push(details.duration);
      idx++;
    }

    if (details.endedReason) {
      updates.push(`ended_reason = $${idx}`);
      values.push(details.endedReason);
      idx++;
    }

    if (details.transcript) {
      updates.push(`transcript = $${idx}`);
      values.push(details.transcript);
      idx++;
    }

    if (details.summary) {
      updates.push(`call_summary = $${idx}`);
      values.push(details.summary);
      idx++;
    }

    if (details.cost !== undefined) {
      updates.push(`cost = $${idx}`);
      values.push(details.cost);
      idx++;
    }

    await db.query(
      `UPDATE voice_calls SET ${updates.join(', ')} WHERE vapi_call_id = $1`,
      values
    );

    console.log(`[VoiceCall] Updated call ${vapiCallId}: status=${status}`);
  } catch (err) {
    console.error(`[VoiceCall] Failed to update call status:`, err.message);
  }
}

/**
 * Process scheduled calls that were delayed due to business hours.
 * Should be called periodically (e.g. every 15 min during business hours).
 */
export async function processScheduledCalls() {
  if (!isVapiEnabled() || !isBusinessHours()) return;

  try {
    // Scan for scheduled calls in Redis
    const keys = await cache.getScheduledVapiCallKeys();
    if (!keys || keys.length === 0) return;

    console.log(`[VoiceCall] Processing ${keys.length} scheduled call(s)`);

    for (const key of keys) {
      // Extract phone from key (format: vapi_scheduled:5571999999999)
      const phone = key.replace('vapi_scheduled:', '');
      const data = await cache.getScheduledVapiCall(phone);
      if (!data) continue;

      // Attempt the call
      await handleVoiceCallTrigger(data.phone, data.eventType, data.eventData);
    }
  } catch (err) {
    console.error('[VoiceCall] Error processing scheduled calls:', err.message);
  }
}
