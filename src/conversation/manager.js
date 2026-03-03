import { db } from '../db/client.js';
import { cache } from '../db/redis.js';
import { sendMessages, sendMedia } from '../quepasa/client.js';
import { findOrCreateContact, findOrCreateConversation, getInboxForPhone, sendOutgoingMessage, updateContactAttributes, setConversationLabels, buildLeadAttributes, buildPhaseLabels } from '../chatwoot/client.js';
import { getAgentResponse } from '../ai/claude.js';
import { applyMetadataUpdates } from './state.js';
import { getMediaForPhase, getProductAudios, getFollowupAudio, getProvaSocial, getDiagnosticoVideo } from '../media/assets.js';
import { sendMediaBase64 } from '../quepasa/client.js';
import { fixSiteLinks, cleanForWhatsApp } from '../ai/output-filter.js';
import { createCheckout } from '../payment/mercadopago.js';
import { config } from '../config.js';
import { resolvePersona } from '../sdr/persona.js';
import { captureError } from '../monitoring/sentry.js';
import { assignVariants, getPromptOverride } from '../ab/manager.js';
import crypto from 'crypto';
import { syncLeadToKrayin, syncPhaseChange, syncDealLost } from '../crm/sync.js';

import { handleVoiceCallTrigger } from '../voice/call-handler.js';
import { generateManagerReport } from '../manager/luan.js';
import { sendAlexReportNow } from '../devops/alex.js';

// === PAYMENT LINK: Generate personalized MP checkout link ===
const PRODUCT_PRICES = { diagnostico: 97, limpa_nome: 497, rating: 997 };

async function generatePaymentLink(conversation, metadata) {
  try {
    const product = metadata.recommended_product || conversation.recommended_product;
    if (!product || !PRODUCT_PRICES[product]) {
      console.log('[PaymentLink] No valid product for checkout:', product);
      return null;
    }

    const price = PRODUCT_PRICES[product];
    const name = conversation.name || conversation.user_profile?.nome || '';
    const phone = conversation.phone || '';
    const cpf = conversation.user_profile?.cpf || '';
    const email = conversation.user_profile?.email || '';

    const checkout = await createCheckout({
      cpf: cpf || phone,
      name,
      email,
      service: product,
      price,
    });

    if (checkout?.initPoint) {
      console.log(`[PaymentLink] Generated MP link for ${phone}: ${product} R$${price}`);
      return checkout.initPoint;
    }
    return null;
  } catch (err) {
    console.error('[PaymentLink] Failed to generate checkout:', err.message);
    return null;
  }
}

function replaceSiteUrlWithPaymentLink(text, paymentUrl, siteUrl) {
  if (!paymentUrl || !text) return text;
  const escaped = siteUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(escaped, 'gi');
  if (regex.test(text)) {
    return text.replace(regex, paymentUrl);
  }
  return text + '\n\n' + paymentUrl;
}

// In-memory map: phone → botTokenForReply (for follow-ups and debounced messages)
const phoneTokenMap = new Map();
// In-memory map: phone → persona (detected from bot token at webhook time)
const phonePersonaMap = new Map();
// In-memory map: phone → nudge timer (auto-cleared on response or fire)
const nudgeTimers = new Map();

// Varied captions for prova social (rotated by conversation id or attempt)
const PROVA_SOCIAL_CAPTIONS = [
  'Olha o resultado de um cliente nosso',
  'Esse aqui conseguiu destravar o crédito em 60 dias',
  'Mais um cliente que saiu da negação',
  'Resultado real de quem fez o diagnóstico',
  'Isso aqui é o que acontece quando você entende o que os bancos veem',
];

function getProvaSocialCaption(seed = 0) {
  return PROVA_SOCIAL_CAPTIONS[seed % PROVA_SOCIAL_CAPTIONS.length];
}

/**
 * Handle an incoming WhatsApp message.
 * Uses debounce to group consecutive messages before processing.
 *
 * @param {string} phone - Normalized phone number (for DB key)
 * @param {string} remoteJid - Raw JID from webhook (for sending back via Evolution)
 * @param {string} text - Message content
 * @param {string} pushName - WhatsApp display name
 * @param {string|null} botTokenForReply - Bot token to use for replies (multi-number support)
 * @param {string} botPhone - Bot phone number that received the message (for persona detection)
 */
export async function handleIncomingMessage(phone, remoteJid, text, pushName, botTokenForReply = null, botPhone = '') {
  // Store token mapping for this phone (for use in debounced processing)
  if (botTokenForReply) {
    phoneTokenMap.set(phone, botTokenForReply);
  }

  // Detect and store persona based on which bot number received the message
  if (botPhone) {
    const persona = resolvePersona(botPhone);
    phonePersonaMap.set(phone, persona);
  }

  // ANTI-SPAM: Check hourly message limit BEFORE even buffering
  const hourlyCount = await cache.getHourlyMessageCount(phone);
  const maxPerHour = config.limits.maxAgentMessagesPerHour || 3;
  if (hourlyCount >= maxPerHour) {
    console.log(`[Manager] HOURLY LIMIT reached for ${phone} (${hourlyCount}/${maxPerHour}). Skipping.`);
    return;
  }

  // DEBOUNCE: Buffer the message and wait for more
  const debounceSeconds = config.limits.debounceSeconds || 7;
  await cache.appendToDebounceBuffer(phone, text, debounceSeconds + 10);

  const isFirst = await cache.setDebounceTimer(phone, debounceSeconds);
  if (!isFirst) {
    console.log(`[Manager] Debounce: buffering message from ${phone}: "${text.substring(0, 50)}"`);
    return; // Timer already running, message buffered, will be processed when timer fires
  }

  console.log(`[Manager] Debounce: first message from ${phone}, waiting ${debounceSeconds}s for more...`);

  // Wait for debounce window to collect consecutive messages
  setTimeout(async () => {
    try {
      await processBufferedMessages(phone, remoteJid, pushName);
    } catch (err) {
      console.error(`[Manager] Error processing buffered messages for ${phone}:`, err);
      captureError(err, { phone, module: 'manager', action: 'processBufferedMessages' });
    }
  }, debounceSeconds * 1000);
}

/**
 * Process all buffered messages after debounce window expires.
 * Groups consecutive messages into a single Claude call.
 */
async function processBufferedMessages(phone, remoteJid, pushName) {
  // Retrieve the stored token and persona for this phone
  const botTokenForReply = phoneTokenMap.get(phone) || null;
  const persona = phonePersonaMap.get(phone) || 'augusto';

  // Cooldown removed — debounce (3s) + OpenAI latency (~3-5s) already prevent
  // rapid-fire responses. Cooldown was causing messages to be silently dropped.

  // Re-check hourly limit
  const hourlyCount = await cache.getHourlyMessageCount(phone);
  const maxPerHour = config.limits.maxAgentMessagesPerHour || 3;
  if (hourlyCount >= maxPerHour) {
    console.log(`[Manager] HOURLY LIMIT reached for ${phone}. Discarding buffered messages.`);
    await cache.flushDebounceBuffer(phone);
    return;
  }

  // Flush buffer — get all accumulated messages
  const bufferedTexts = await cache.flushDebounceBuffer(phone);
  if (bufferedTexts.length === 0) {
    console.log(`[Manager] Empty debounce buffer for ${phone}, nothing to process`);
    return;
  }

  // Combine messages into a single text
  const combinedText = bufferedTexts.join('\n');

  // Luan manager command: admin phones can send #luan, #gerente, or #relatorio
  const ADMIN_PHONES = ['5511932145806', '557191234115', '557187700120'];
  const isAdmin = ADMIN_PHONES.some(p => phone.includes(p) || p.includes(phone));
  if (isAdmin && combinedText.trim().match(/^#(luan|gerente|relatorio)/i)) {
    console.log('[Manager] Luan command from admin ' + phone);
    try {
      const { whatsappMessages } = await generateManagerReport({ reportType: 'on_demand', days: 7 });
      for (const msg of whatsappMessages) {
        await sendMessages(remoteJid, [msg], botTokenForReply);
      }
    } catch (err) {
      console.error('[Manager] Luan command error:', err.message);
      await sendMessages(remoteJid, ['Erro ao gerar relatorio: ' + err.message], botTokenForReply);
    }
    await cache.releaseProcessingLock(phone);
    return;
  }

  // Alex DevOps command: admin phones can send #alex or #devops
  if (isAdmin && combinedText.trim().match(/^#(alex|devops?)/i)) {
    console.log('[Manager] Alex command from admin ' + phone);
    try {
      const alexResult = await sendAlexReportNow();
      if (!alexResult.success) {
        await sendMessages(remoteJid, ['Erro ao gerar relatorio Alex: ' + (alexResult.error || 'desconhecido')], botTokenForReply);
      }
    } catch (err) {
      console.error('[Manager] Alex command error:', err.message);
      await sendMessages(remoteJid, ['Erro ao gerar relatorio DevOps: ' + err.message], botTokenForReply);
    }
    await cache.releaseProcessingLock(phone);
    return;
  }
  console.log(`[Manager] Debounce: processing ${bufferedTexts.length} message(s) from ${phone}`);

  // BOT-LOOP PROTECTION: Duplicate message detection
  const normalizedMsg = combinedText.toLowerCase().trim().replace(/\s+/g, ' ');
  const msgHash = crypto.createHash('md5').update(normalizedMsg).digest('hex');
  const duplicateCount = await cache.trackMessageHash(phone, msgHash);
  if (duplicateCount >= 3) {
    console.warn(`[Manager] BOT-LOOP DETECTED for ${phone}: same message received ${duplicateCount}x in a row. Ignoring. Hash: ${msgHash}, msg: "${combinedText.substring(0, 80)}"`);
    return;
  }

  // Acquire processing lock
  const locked = await cache.setProcessingLock(phone);
  if (!locked) {
    console.log(`[Manager] Skipping duplicate processing from ${phone}`);
    return;
  }

  try {
    // 1. Load or create conversation
    let conversation = await cache.getConversation(phone);
    if (!conversation) {
      conversation = await db.getConversation(phone);
    }

    if (!conversation) {
      const botPhone = Object.entries(config.sdr.phoneToPersona).find(([, p]) => p === persona)?.[0] || '';
      conversation = await db.createConversation(phone, pushName || null, persona, botPhone);
      console.log(`[Manager] New conversation created for ${phone} (persona: ${persona})`);
      // CRM: Sync new lead to Krayin (non-blocking)
      syncLeadToKrayin(conversation, pushName, persona).catch(err => {
        console.error('[CRM] Failed to sync new lead:', err.message);
      });
    } else if (pushName && !conversation.name) {
      await db.updateConversation(conversation.id, { name: pushName });
      conversation.name = pushName;
    }

    // Auto-reset opt-out: if lead sends a new message, they want to talk again
    if (conversation.opted_out) {
      console.log(`[Manager] Lead ${phone} was opted out but sent new message. Resetting opt-out.`);
      await db.updateConversation(conversation.id, { opted_out: false });
      conversation.opted_out = false;
    }

    // Store remoteJid for future follow-ups
    if (remoteJid && conversation.remote_jid !== remoteJid) {
      await db.updateConversation(conversation.id, { remote_jid: remoteJid });
      conversation.remote_jid = remoteJid;
    }

    // Cancel any pending followups since user responded
    await db.cancelFollowups(conversation.id);

    // Cancel any pending nudge timer since user responded
    if (nudgeTimers.has(phone)) {
      clearTimeout(nudgeTimers.get(phone));
      nudgeTimers.delete(phone);
      console.log(`[Manager] Nudge cancelled for ${phone} (lead responded)`);
    }

    // 2. Save incoming message (combined)
    await db.addMessage(conversation.id, 'user', combinedText, conversation.phase);

    // 3. Load message history (last 12 messages — saves ~40% tokens vs 20)
    const messages = await db.getMessages(conversation.id, 12);
    const totalMessages = await db.getMessageCount(conversation.id);

    // BOT-LOOP PROTECTION: Max messages per conversation
    const maxConversationMessages = config.limits.maxConversationMessages || 200;
    if (totalMessages > maxConversationMessages) {
      console.warn(`[Manager] CONVERSATION LIMIT reached for ${phone}: ${totalMessages}/${maxConversationMessages} messages. Auto-pausing (not responding).`);
      return;
    }

    // If history was trimmed, prepend context note
    if (totalMessages > messages.length && messages.length > 0) {
      const trimmed = totalMessages - messages.length;
      messages.unshift({
        role: 'user',
        content: `[SISTEMA: Esta conversa tem ${totalMessages} mensagens. Mostrando as últimas ${messages.length}. ${trimmed} mensagens anteriores foram omitidas. Continue naturalmente a partir do contexto visível.]`,
      });
    }

    // 4. Build state for Claude
    const state = {
      phase: conversation.phase,
      price_counter: conversation.price_counter,
      link_counter: conversation.link_counter,
      ebook_sent: conversation.ebook_sent,
      name: conversation.name || pushName || null,
      user_profile: conversation.user_profile || {},
      recommended_product: conversation.recommended_product,
    };

    // 4.5. A/B test variant assignment
    const activePersona = conversation.persona || persona;
    let abOverrides = {};
    try {
      const assignments = await assignVariants(conversation.id, activePersona);
      // Resolve prompt overrides for assigned variants
      for (const target of Object.keys(assignments)) {
        const override = await getPromptOverride(assignments, target);
        if (override) abOverrides[target] = override;
      }
    } catch (err) {
      // A/B tests are non-critical — don't block conversation
      console.warn('[Manager] A/B test assignment failed (non-critical):', err.message);
    }

    // 5. Get AI response (use persona from conversation or detected from bot token)
    const { text: responseText, metadata } = await getAgentResponse(state, messages, combinedText, activePersona, abOverrides);

    // DEBUG: Phase transition and metadata tracking
    console.log(`[Manager] Phase transition: ${conversation.phase} → ${metadata.phase ?? 'no change'} | metadata keys: ${Object.keys(metadata).join(',')}`);

    if (!responseText) {
      console.error(`[Manager] Empty response from Claude for ${phone}`);
      return;
    }

    // 6. Check if lead wants to opt out — validate before trusting GPT
    if (metadata.escalation_flag === 'opt_out') {
      const optOutPhrases = [
        'nao quero mais', 'não quero mais',
        'para de me', 'pare de me', 'para com isso',
        'nao me mande', 'não me mande', 'nao manda mais', 'não manda mais',
        'pode parar', 'quero parar',
        'sai fora', 'saia daqui', 'me tira daqui',
        'cancelar tudo', 'cancela tudo',
        'me bloqueia', 'me bloqueie',
        'nao tenho interesse', 'não tenho interesse',
        'para de mandar', 'pare de mandar',
        'stop',
      ];
      const normalizedMsg = combinedText.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const isRealOptOut = optOutPhrases.some(phrase => normalizedMsg.includes(phrase));

      if (isRealOptOut) {
        await db.updateConversation(conversation.id, { opted_out: true });
        await db.cancelFollowups(conversation.id);
        console.log(`[Manager] Lead ${phone} opted out (confirmed by keyword match). Follow-ups cancelled.`);
        // CRM: Mark lead as lost
        syncDealLost(phone, 'opt_out').catch(() => {});
      } else {
        console.warn(`[Manager] GPT flagged opt_out for ${phone} but message "${combinedText.substring(0, 80)}" has no opt-out keyword. IGNORING flag.`);
      }
    }

    // 7. Send ebook if flagged
    if (metadata.should_send_ebook && !conversation.ebook_sent && config.site.ebookUrl) {
      await sendDocument(
        remoteJid,
        config.site.ebookUrl,
        'Guia Completo do Mercado de Crédito no Brasil',
        'guia-credito-brasil.pdf'
      );
    }

    // 7.5 Send phase-specific media (before text response)
    const newPhase = metadata.phase ?? conversation.phase;
    if (config.media.enabled) {
      const media = getMediaForPhase(newPhase, { previousPhase: conversation.phase });
      if (media && media.url) {
        try {
          await sendMedia(remoteJid, media.url, media.caption || '', botTokenForReply);
          console.log(`[Manager] Sent phase media for phase ${newPhase}: ${media.url}`);
        } catch (err) {
          console.error(`[Manager] Failed to send phase media:`, err.message);
        }
      }
    }

    // 7.8 Send product explanation audios ONLY when AI decides (via metadata flag)
    console.log('[Manager] Audio check: should_send_product_audios=' + metadata.should_send_product_audios + ', media.enabled=' + config.media.enabled + ', responseText has [AUDIO]=' + responseText.includes('[AUDIO]'));
    if (metadata.should_send_product_audios && config.media.enabled) {
      const productAudios = getProductAudios();
      if (productAudios) {
        try {
          for (let i = 0; i < productAudios.length; i++) {
            await sendMediaBase64(remoteJid, productAudios[i].base64, '', productAudios[i].fileName, botTokenForReply);
            console.log(`[Manager] Sent product audio ${productAudios[i].fileName} to ${phone}`);
            if (i < productAudios.length - 1) {
              await new Promise(r => setTimeout(r, 2000));
            }
          }
        } catch (err) {
          console.error(`[Manager] Failed to send product audios:`, err.message);
        }
      }
    }

    // 7.85 Strip [AUDIO] tag from text and fallback: if AI wrote [AUDIO] but metadata missed the flag, send audios
    const hasAudioTag = responseText.includes('[AUDIO]');
    const cleanedResponseText = responseText.replace(/\[AUDIO\]/g, '').trim();

    if (hasAudioTag && !metadata.should_send_product_audios && config.media.enabled) {
      console.log('[Manager] AI wrote [AUDIO] tag but metadata missed should_send_product_audios. Sending audios as fallback.');
      const fallbackAudios = getProductAudios();
      if (fallbackAudios) {
        try {
          for (let i = 0; i < fallbackAudios.length; i++) {
            await sendMediaBase64(remoteJid, fallbackAudios[i].base64, '', fallbackAudios[i].fileName, botTokenForReply);
            console.log('[Manager] Sent fallback product audio ' + fallbackAudios[i].fileName + ' to ' + phone);
            if (i < fallbackAudios.length - 1) {
              await new Promise(r => setTimeout(r, 2000));
            }
          }
        } catch (err) {
          console.error('[Manager] Failed to send fallback product audios:', err.message);
        }
      }
    }

    // 7.9 Fix any incorrect/shortened site links before sending
    // 7.9 Fix links + generate payment link if applicable
    let fixedResponseText = cleanForWhatsApp(fixSiteLinks(cleanedResponseText));
    if (metadata.should_send_link && newPhase >= 3) {
      const paymentUrl = await generatePaymentLink(conversation, metadata);
      if (paymentUrl) {
        fixedResponseText = replaceSiteUrlWithPaymentLink(fixedResponseText, paymentUrl, config.site.url);
        console.log(`[Manager] Replaced site URL with MP payment link for ${phone}`);
      }
    }

    // 7.95 Pre-send validation: sanitize response
    const validatedText = validateAgentResponse(fixedResponseText, phone);

    // 8. Human-like delay: wait 8-15s before sending (avoids robotic feel)
    const minDelay = 8000;
    const maxDelay = 15000;
    const humanDelay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
    console.log(`[Manager] Human delay: ${(humanDelay / 1000).toFixed(1)}s before sending to ${phone}`);
    await new Promise(r => setTimeout(r, humanDelay));

    // 8.1 Send response via WhatsApp — split by \n\n into separate bubbles
    const messageParts = validatedText.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 0);
    let messageIds = [];
    if (messageParts.length > 1) {
      console.log(`[Manager] Splitting response into ${messageParts.length} bubbles for ${phone}`);
      for (let i = 0; i < messageParts.length; i++) {
        const ids = await sendMessages(remoteJid, messageParts[i], botTokenForReply);
        messageIds.push(...ids);
        if (i < messageParts.length - 1) {
          // 2-4s typing delay between bubbles
          const bubbleDelay = 2000 + Math.floor(Math.random() * 2000);
          await new Promise(r => setTimeout(r, bubbleDelay));
        }
      }
    } else {
      messageIds = await sendMessages(remoteJid, validatedText, botTokenForReply);
    }

    // 8.5 Send diagnostico video AFTER text when entering phase 3
    if (newPhase >= 3 && conversation.phase < 3 && config.media.enabled) {
      try {
        const diagVideo = getDiagnosticoVideo();
        if (diagVideo) {
          await new Promise(r => setTimeout(r, 2000));
          await sendMediaBase64(remoteJid, diagVideo.base64, '', diagVideo.fileName, botTokenForReply);
          console.log(`[Manager] Diagnostico video sent to ${phone} (phase ${conversation.phase}->3 transition)`);
        }
      } catch (err) {
        console.error(`[Manager] Failed to send diagnostico video:`, err.message);
      }

      // 8.6 Send prova social AFTER video (30s delay)
      try {
        const provaSocial = getProvaSocial('augusto', conversation.id);
        if (provaSocial) {
          await new Promise(r => setTimeout(r, 30000));
          await sendMediaBase64(remoteJid, provaSocial.base64, '', provaSocial.fileName, botTokenForReply);
          console.log(`[Manager] Prova social sent to ${phone} (phase 3 transition): ${provaSocial.fileName}`);
        }
      } catch (err) {
        console.error(`[Manager] Failed to send prova social:`, err.message);
      }

      // 8.7 Schedule nudge if lead doesn't react to video (1.5-2 min)
      const nudgeDelay = 90000 + Math.floor(Math.random() * 30000); // 90-120s
      if (nudgeTimers.has(phone)) {
        clearTimeout(nudgeTimers.get(phone));
      }
      const nudgeTimer = setTimeout(async () => {
        try {
          nudgeTimers.delete(phone);
          // Check if lead responded since the video
          const recentMsgs = await db.getMessages(conversation.id, 2);
          const lastMsg = recentMsgs[recentMsgs.length - 1];
          if (lastMsg && lastMsg.role === 'agent') {
            // Lead hasn't responded, send nudge
            const nudgeText = 'Conseguiu ver?';
            await sendMessages(remoteJid, nudgeText, botTokenForReply);
            await db.addMessage(conversation.id, 'agent', nudgeText, newPhase);
            await cache.incrementHourlyMessageCount(phone);
            console.log(`[Manager] Nudge sent to ${phone} after ${nudgeDelay/1000}s (no response after video)`);
          } else {
            console.log(`[Manager] Nudge skipped for ${phone} (lead already responded)`);
          }
        } catch (err) {
          console.error(`[Manager] Nudge failed for ${phone}:`, err.message);
        }
      }, nudgeDelay);
      nudgeTimers.set(phone, nudgeTimer);
      console.log(`[Manager] Nudge scheduled for ${phone} in ${nudgeDelay/1000}s`);
    }

    // 9. Save agent message
    await db.addMessage(
      conversation.id,
      'agent',
      fixedResponseText,
      newPhase,
      messageIds
    );

    // 9.5 Forward agent response to Chatwoot (route to correct inbox based on persona)
    try {
      const cwBotPhone = conversation.bot_phone || '';
      const cwInboxId = getInboxForPhone(cwBotPhone);
      const cwContact = await findOrCreateContact(phone, pushName, cwInboxId);
      const cwContactId = cwContact.id || cwContact.payload?.contact?.id;
      if (cwContactId) {
        const cwConv = await findOrCreateConversation(cwContactId, `whatsapp_${phone}`, cwInboxId);
        if (cwConv.id) {
          await sendOutgoingMessage(cwConv.id, fixedResponseText);
          console.log(`[Bridge] Agent response forwarded to Chatwoot conversation ${cwConv.id} (inbox ${cwInboxId})`);

          // Sync lead qualification to Chatwoot
          const effectivePhase = metadata.phase ?? conversation.phase;
          const effectiveProfile = metadata.user_profile_update
            ? { ...conversation.user_profile, ...metadata.user_profile_update }
            : conversation.user_profile;
          const attrs = buildLeadAttributes({
            ...conversation,
            phase: effectivePhase,
            user_profile: effectiveProfile,
            recommended_product: metadata.recommended_product || conversation.recommended_product,
          });
          await updateContactAttributes(cwContactId, attrs);
          await setConversationLabels(cwConv.id, buildPhaseLabels(effectivePhase, conversation.persona || 'augusto'));
        }
      }
    } catch (err) {
      console.error("[Bridge] Failed to forward agent response to Chatwoot:", err.message);
    }

    // 10. Apply state updates
    const updates = applyMetadataUpdates(state, metadata);
    if (Object.keys(updates).length > 0) {
      await db.updateConversation(conversation.id, updates);
      Object.assign(conversation, updates);
    }

    // 10.5 TRANSFER TO PAULO: If Augusto flagged transfer, change persona to paulo
    if (metadata.transfer_to_paulo && (conversation.persona || 'augusto') === 'augusto') {
      console.log(`[Manager] TRANSFER TO PAULO triggered for ${phone} (product: ${metadata.recommended_product || conversation.recommended_product})`);
      await db.updateConversation(conversation.id, { persona: 'paulo' });
      conversation.persona = 'paulo';
      // Clear persona cache so next message uses Paulo's prompt
      phonePersonaMap.set(phone, 'paulo');
      // Update cache immediately
      await cache.setConversation(phone, conversation);

      // Chatwoot: Update labels to reflect Paulo as owner
      try {
        const cwBotPhone = conversation.bot_phone || '';
        const cwInboxId = getInboxForPhone(cwBotPhone);
        const cwContact = await findOrCreateContact(phone, conversation.name, cwInboxId);
        const cwContactId = cwContact.id || cwContact.payload?.contact?.id;
        if (cwContactId) {
          const cwConv = await findOrCreateConversation(cwContactId, `whatsapp_${phone}`, cwInboxId);
          if (cwConv.id) {
            const transferLabels = buildPhaseLabels(metadata.phase ?? conversation.phase, 'paulo');
            transferLabels.push('transfer_to_paulo');
            await setConversationLabels(cwConv.id, transferLabels);
          }
        }
      } catch (err) {
        console.error('[Manager] Failed to update Chatwoot labels for Paulo transfer:', err.message);
      }
    }

    // 10.6 CRM: Sync phase change to Krayin (non-blocking)
    if (metadata.phase !== undefined && metadata.phase !== conversation.phase) {
      syncPhaseChange(phone, metadata.phase, {
        recommended_product: metadata.recommended_product || conversation.recommended_product,
      }).catch(err => {
        console.error('[CRM] Failed to sync phase change:', err.message);
      });
    }

    // 11. Cache updated conversation
    await cache.setConversation(phone, conversation);

    // 12. Set cooldown
    await cache.setLastResponseTime(phone);

    // 13. Increment hourly counter
    const newHourlyCount = await cache.incrementHourlyMessageCount(phone);
    console.log(`[Manager] Hourly count for ${phone}: ${newHourlyCount}/${maxPerHour}`);

    // 14. Check escalation
    if (metadata.escalation_flag && metadata.escalation_flag !== 'opt_out') {
      console.warn(`[ESCALATION] ${metadata.escalation_flag} flagged for ${phone}`);
    }

    console.log(`[Manager] Response sent to ${remoteJid} (phase: ${newPhase})`);
  } finally {
    await cache.releaseProcessingLock(phone);
  }
}

/**
 * Handle a follow-up trigger (timeout, webhook).
 * Generates a contextual follow-up message via Claude.
 * Blocks follow-up if the last message was already from the agent (no double messaging).
 */
export async function handleFollowup(conversation, eventType, usePreRecordedAudio = false, attempt = 1) {
  const messages = await db.getMessages(conversation.id);

  // Guard: check if last message is from agent (need 24h+ gap)
  if (messages.length > 0) {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role === 'agent') {
      const hoursSinceLastAgent = (Date.now() - new Date(lastMsg.created_at).getTime()) / (1000 * 60 * 60);
      if (hoursSinceLastAgent < 24) {
        console.log(`[Followup] BLOCKED ${eventType} for ${conversation.phone} — last agent msg was ${hoursSinceLastAgent.toFixed(1)}h ago (need 24h+). Waiting.`);
        return;
      }
    }
  }

  const persona = conversation.persona || 'augusto';
  const target = conversation.remote_jid || `${conversation.phone}@s.whatsapp.net`;
  const token = phoneTokenMap.get(conversation.phone) || null;

  // Determine follow-up format
  const { getFollowupFormat } = await import('./followup.js');
  const format = getFollowupFormat(persona, attempt, conversation.phase || 0);

  console.log(`[Followup] Sending ${eventType} attempt ${attempt} to ${target} (persona: ${persona}, format: ${format.type}, phase: ${conversation.phase})`);

  // ── PRE-RECORDED AUDIO + TEXT (attempt 1) ──
  if (format.type === 'pre_recorded_audio') {
    try {
      const audioData = getFollowupAudio(persona);
      if (audioData) {
        await sendMediaBase64(target, audioData.base64, '', audioData.fileName, token);
        await db.addMessage(conversation.id, 'agent', `[Audio follow-up 24h - ${persona}]`, conversation.phase);
        console.log(`[Followup] Pre-recorded audio sent for ${persona} to ${conversation.phone}`);
        // Send complementary text after audio (3s delay)
        await new Promise(r => setTimeout(r, 3000));
        const produto = conversation.user_profile?.produto || 'cr\u00e9dito';
        const banco = conversation.user_profile?.tentou_banco || '';
        const bancoRef = banco ? ` no ${banco}` : '';
        const fuText = `Mandei esse \u00e1udio pra te explicar melhor. Sobre a nega\u00e7\u00e3o${bancoRef} \u2014 o diagn\u00f3stico mostra exatamente o que t\u00e1 travando seu ${produto}. D\u00e1 uma olhada: ${config.site.url}`;
        await sendMessages(target, fuText, token);
        await db.addMessage(conversation.id, 'agent', fuText, conversation.phase);
        console.log(`[Followup] Audio + text sent to ${conversation.phone}`);
        return;
      }
    } catch (err) {
      console.error(`[Followup] Pre-recorded audio failed:`, err.message);
    }
  }

  // ── VAPI OUTBOUND CALL (hot leads phase 3-4) ──
  if (format.type === 'vapi_outbound_call') {
    try {
      console.log(`[Followup] Initiating VAPI OUTBOUND call for ${conversation.phone} (phase ${conversation.phase})`);
      const callResult = await handleVoiceCallTrigger(
        conversation.phone,
        'followup_hot_lead',
        {
          produto: conversation.recommended_product || '',
          phase: conversation.phase,
          attempt: attempt,
          persona: persona,
        },
        'outbound'
      );
      if (callResult) {
        await db.addMessage(conversation.id, 'agent', `[Ligacao outbound - follow-up ${attempt} - ${persona}]`, conversation.phase);
        console.log(`[Followup] VAPI call initiated for ${conversation.phone}: ${JSON.stringify(callResult)}`);
        return;
      } else {
        console.warn(`[Followup] VAPI call skipped/failed for ${conversation.phone}. Falling back to prova social.`);
        // Fall through to social proof
        const provaSocial = getProvaSocial(persona, conversation.id);
        if (provaSocial) {
          const caption = getProvaSocialCaption(conversation.id + 10);
          await sendMediaBase64(target, provaSocial.base64, caption, provaSocial.fileName, token);
          await db.addMessage(conversation.id, 'agent', `[Prova social - ${provaSocial.fileName}] ${caption}`, conversation.phase);
          return;
        }
      }
    } catch (err) {
      console.error(`[Followup] VAPI outbound call error:`, err.message);
      // Fall through to text
    }
  }

  // ── SOCIAL PROOF MEDIA + CONTEXTUAL TEXT ──
  if (format.type === 'social_proof_media') {
    try {
      const provaSocial = getProvaSocial(persona, conversation.id + attempt);
      if (provaSocial) {
        const caption = getProvaSocialCaption(conversation.id + attempt);
        await sendMediaBase64(target, provaSocial.base64, caption, provaSocial.fileName, token);
        await db.addMessage(conversation.id, 'agent', `[Prova social - ${provaSocial.fileName}] ${caption}`, conversation.phase);
        console.log(`[Followup] Prova social sent: ${provaSocial.fileName} to ${conversation.phone}`);
        // Send contextual follow-up text after media (3s delay)
        await new Promise(r => setTimeout(r, 3000));
        const name = conversation.name || 'amigo';
        const socialTexts = [
          `${name}, esse cliente tava na mesma situa\u00e7\u00e3o que voc\u00ea. Fez o diagn\u00f3stico e em 2 meses conseguiu destravar. Se quiser ver como funciona: ${config.site.url}`,
          `${name}, resultados assim s\u00e3o comuns pra quem entende o que os bancos realmente veem. Quer fazer o seu? ${config.site.url}`,
        ];
        const socialText = socialTexts[(conversation.id + attempt) % socialTexts.length];
        await sendMessages(target, socialText, token);
        await db.addMessage(conversation.id, 'agent', socialText, conversation.phase);
        return;
      }
    } catch (err) {
      console.error(`[Followup] Prova social failed:`, err.message);
    }
  }

  // ── TEXT-BASED FOLLOW-UPS ──
  const state = {
    phase: conversation.phase,
    price_counter: conversation.price_counter,
    link_counter: conversation.link_counter,
    ebook_sent: conversation.ebook_sent,
    name: conversation.name,
    user_profile: conversation.user_profile || {},
    recommended_product: conversation.recommended_product,
  };

  const followupPrompt = buildFollowupPrompt(eventType, conversation, attempt, persona);

  const { text: responseText, metadata } = await getAgentResponse(
    state,
    messages,
    followupPrompt,
    persona
  );

  if (!responseText) return;

  const fixedText = cleanForWhatsApp(fixSiteLinks(responseText));

  // Legacy TTS audio for specific events
  const legacyAudioEvents = ['purchase_completed', 'purchase_followup', 'reengagement'];
  if (legacyAudioEvents.includes(eventType) && config.tts.enabled) {
    try {
      const { sendAudioMessage } = await import('../audio/tts.js');
      const audioText = getAudioScript(eventType, conversation);
      await sendAudioMessage(target, audioText, token);
      await new Promise(r => setTimeout(r, 3000));
    } catch (err) {
      console.error(`[Followup] TTS audio failed:`, err.message);
    }
  }

  await sendMessages(target, fixedText, token);
  await db.addMessage(conversation.id, 'agent', fixedText, conversation.phase);

  const updates = applyMetadataUpdates(state, metadata);
  if (Object.keys(updates).length > 0) {
    await db.updateConversation(conversation.id, updates);
  }

  console.log(`[Followup] ${eventType} attempt ${attempt} (${format.type}) sent to ${target}`);
}





/**
 * Get audio script for TTS-based follow-up.
 * Uses persona-specific scripts inspired by proven sales audio frameworks.
 */
function getAudioScript(eventType, conversation) {
  const name = conversation.name || 'amigo';
  const persona = conversation.persona || 'augusto';
  const personaName = persona === 'paulo' ? 'Paulo' : 'Augusto';
  const product = conversation.recommended_product;

  const scripts = {
    // FOLLOW-UP: Lead esfriou (24h+)
    consultation_timeout: {
      augusto: `Oi ${name}, tudo bem? Aqui é o ${personaName} da CredPositivo. Tô te mandando esse áudio rapidinho porque sei que o dia a dia é corrido. Só queria saber se você tá bem e se ainda precisa daquela ajuda com sua situação de crédito. A nossa análise é gratuita e sem compromisso nenhum. Quando puder, me dá um retorno que eu tô aqui pra te ajudar, beleza?`,
      paulo: `Fala ${name}, tudo certo? Aqui é o ${personaName} da CredPositivo. Gravei esse áudio só pra saber como você tá. Sei que a gente tava conversando sobre sua situação financeira e quero te dizer que continuo aqui disponível. Sem pressão nenhuma, viu? Quando tiver um minutinho, me chama que a gente resolve isso juntos.`,
    },
    // REATIVAÇÃO: Lead sumiu (+7 dias)
    reengagement: {
      augusto: `Oi ${name}, aqui é o ${personaName} da CredPositivo de novo. Faz uns dias que a gente conversou e quero te dizer que tá tudo bem, sem pressão. Só tô te mandando esse áudio porque realmente acredito que posso te ajudar. A gente já ajudou muita gente na mesma situação. Quando você tiver um tempinho, me chama aqui que a gente retoma de onde parou, tá bom?`,
      paulo: `E aí ${name}, tudo certo contigo? Aqui é o ${personaName} da CredPositivo. Faz um tempinho que a gente conversou e eu queria saber se mudou alguma coisa na sua situação. Se ainda precisar de ajuda, saiba que tô aqui. Sem compromisso, é só me chamar.`,
    },
    // PÓS-COMPRA
    purchase_completed: {
      augusto: `${name}, aqui é o ${personaName} da CredPositivo. Parabéns pela sua decisão! Quero que saiba que nossa equipe já tá trabalhando no seu caso. Se tiver qualquer dúvida, qualquer coisa mesmo, pode me chamar aqui que eu te ajudo na hora, combinado?`,
      paulo: `Fala ${name}, ${personaName} aqui. Passando pra te dar parabéns pela decisão. A equipe já tá cuidando de tudo pra você. Qualquer dúvida, é só chamar que eu tô aqui!`,
    },
    // PROVA SOCIAL: Lead na fase de educação
    social_proof: {
      augusto: `${name}, deixa eu te contar uma coisa rápida. Essa semana mesmo a gente ajudou um cliente que tava com o nome sujo há 3 anos. Em menos de 15 dias ele já tava com o score subindo e as dívidas negociadas. O processo é simples e eu te guio em tudo. Posso te explicar como funciona?`,
      paulo: `${name}, deixa eu compartilhar contigo. Só no último mês a gente ajudou dezenas de pessoas a limpar o nome e melhorar o score. Tem cliente nosso que já conseguiu até financiamento depois do processo. Isso é real e pode ser sua história também. Vamos conversar?`,
    },
    // URGÊNCIA: Lead quente que não converteu
    urgency: {
      augusto: `${name}, olha só, tô te mandando esse áudio porque surgiu uma condição especial essa semana pra negociação de dívidas. Os descontos tão muito bons e não sei até quando vai durar. Se você tiver interesse, me responde aqui que eu já puxo tudo pra você aproveitar, beleza?`,
      paulo: `${name}, ${personaName} aqui. Preciso te falar uma coisa importante: tô vendo aqui umas condições de negociação muito boas que apareceram agora. Descontos que raramente acontecem. Se você tem dívidas pra resolver, esse é o momento. Me responde aqui que eu te passo tudo certinho.`,
    },
    // CHECKOUT ABANDONADO
    purchase_abandoned: {
      augusto: `Oi ${name}, percebi que você começou o processo mas não finalizou. Pode ter sido algum problema técnico, acontece bastante. Se precisar de alguma ajuda pra concluir ou se ficou alguma dúvida, me fala que eu resolvo rapidinho pra você.`,
      paulo: `Fala ${name}, ${personaName} aqui. Vi que você começou a cadastrar mas parou. Sem problema nenhum! Se teve alguma dificuldade ou dúvida, me chama que eu te guio passo a passo.`,
    },
    purchase_followup: {
      augusto: `${name}, ${personaName} da CredPositivo aqui. Como tá indo o seu processo? Queria saber se tá tudo certo e se precisa de alguma coisa. Estamos aqui pra te acompanhar em cada etapa, viu?`,
      paulo: `E aí ${name}, ${personaName} aqui. Passando pra saber como tá indo. Qualquer novidade ou dúvida, pode mandar que eu tô acompanhando seu caso de perto.`,
    },
  };

  const eventScripts = scripts[eventType] || scripts.consultation_timeout;
  return eventScripts[persona] || eventScripts.augusto;
}

function buildFollowupPrompt(eventType, conversation, attempt = 1, persona = 'augusto') {
  const name = conversation.name || 'amigo';

  if (['consultation_timeout', 'social_proof', 'urgency'].includes(eventType)) {
    const produto = conversation.user_profile?.produto || 'cr\u00e9dito';
    const banco = conversation.user_profile?.tentou_banco || '';
    const bancoRef = banco ? ` a nega\u00e7\u00e3o do ${banco}` : ' a situa\u00e7\u00e3o do seu cr\u00e9dito';
    const siteUrl = '${config.site.url}';

    const augustoPrompts = {
      2: `[SISTEMA: Follow-up #2 (48h). ${name} nao respondeu. Mande UMA mensagem referenciando o CASO DELE: ele quer ${produto} e teve${bancoRef}. Aborde de angulo diferente: "Tava pensando no seu caso..." ou "Sabe o que mais trava ${produto}?". INCLUA o link ${siteUrl} no final. NAO mencione preco. Maximo 3 linhas.]`,
      3: `[SISTEMA: Follow-up #3 (72h). Uma prova social foi enviada ANTES desta mensagem. Conecte o resultado do cliente com a situacao de ${name}. Exemplo: "Esse cliente tava na mesma que voce e resolveu." INCLUA o link ${siteUrl}. Maximo 2 linhas.]`,
      4: `[SISTEMA: Follow-up #4 (5 dias). Urgencia REAL (nao falsa). Fale que cada mes sem resolver, os bancos acumulam mais dados negativos sobre ${name}. Pergunte se quer resolver ou se mudou de ideia. INCLUA o link ${siteUrl}. Maximo 3 linhas.]`,
      5: `[SISTEMA: Follow-up #5 FINAL (7 dias). Encerramento. Diga que nao vai mais mandar mensagem. MAS deixe o link como ultimo recurso: "${name}, nao vou mais te mandar mensagem. Se um dia quiser entender por que os bancos tao negando, o link ta aqui: ${siteUrl}. Valeu!" Maximo 2 linhas.]`,
    };

    const pauloPrompts = {
      2: `[SISTEMA: Follow-up #2 (48h). ${name} nao respondeu. Pergunte se teve dificuldade tecnica ou se ficou alguma duvida sobre o diagnostico. INCLUA o link ${siteUrl}. Maximo 2 linhas.]`,
      3: `[SISTEMA: Follow-up #3 (72h). Urgencia real: condicoes de negociacao mudam. Mencione que ${name} pode estar perdendo oportunidade. INCLUA link ${siteUrl}. Maximo 2 linhas.]`,
      4: `[SISTEMA: Follow-up #4 (5 dias). Uma prova social foi enviada antes desta msg. Conecte com a situacao de ${name}. INCLUA link ${siteUrl}. Maximo 2 linhas.]`,
      5: `[SISTEMA: Follow-up #5 FINAL. Encerramento. Nao vai mais mandar msg. Deixe link como ultimo recurso: ${siteUrl}. Maximo 2 linhas.]`,
    };

    const prompts = persona === 'paulo' ? pauloPrompts : augustoPrompts;
    if (prompts[attempt]) return prompts[attempt];
  }

  const legacyPrompts = {
    signup_completed:
      `[SISTEMA: O lead criou conta no site mas ainda nao comprou. Pergunte se teve alguma duvida ou dificuldade. NAO pressione para comprar. Uma mensagem so.]`,
    purchase_completed:
      `[SISTEMA: O lead comprou ${conversation.recommended_product || 'um produto'}. Parabenize e pergunte se precisa de ajuda com algo. Seja breve.]`,
    purchase_abandoned:
      `[SISTEMA: O lead iniciou checkout mas nao finalizou. Pergunte se teve alguma dificuldade tecnica. NAO pressione. Uma mensagem so.]`,
    link_sent_no_action:
      `[SISTEMA: O link foi enviado ha 24h+ mas o lead nao acessou. Pergunte se ficou alguma duvida. NAO reenvie o link. Uma mensagem so.]`,
    reengagement:
      `[SISTEMA: O lead ficou inativo ha mais de 24h. Mande UMA mensagem curta, pessoal e genuina. Mostre que se importa. NAO mencione preco.]`,
    purchase_followup:
      `[SISTEMA: Acompanhamento pos-compra. O lead comprou ${conversation.recommended_product || 'um produto'}. Pergunte como esta o processo. Seja breve.]`,
  };

  return legacyPrompts[eventType] || `[SISTEMA: Follow-up necessario para ${eventType}. Attempt ${attempt}. Seja breve e humano.]`;
}

// ─── Pre-Send Validation ──────────────────────────────────────────────────────

const ALLOWED_EMOJIS = ['✅', '❌', '👇', '👉', '🔒'];
const EMOJI_RE = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}]/gu;

/**
 * Validates and sanitizes the agent response before sending to WhatsApp.
 * - Removes forbidden emojis
 * - Collapses double newlines (anti-split safety net)
 * - Truncates excessively long messages
 * - Logs violations for Ana QA to pick up
 */
function validateAgentResponse(text, phone) {
  let cleaned = text;
  let violations = [];

  // 1. Remove forbidden emojis (keep only allowed ones)
  const emojiMatches = cleaned.match(EMOJI_RE) || [];
  const forbidden = emojiMatches.filter(e => !ALLOWED_EMOJIS.includes(e));
  if (forbidden.length > 0) {
    for (const emoji of forbidden) {
      cleaned = cleaned.replaceAll(emoji, '');
    }
    violations.push(`emoji_forbidden:${forbidden.join(',')}`);
  }

  // 2. Preserve \n\n for bubble splitting (manager line ~442 splits by \n\n)
  // Previously collapsed \n\n into \n which DESTROYED bubble separation.
  // Only collapse 3+ newlines into exactly 2 (preserves intentional splits).
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  // 3. Truncate if too long (max 1000 chars for WhatsApp readability)
  if (cleaned.length > 1000) {
    cleaned = cleaned.substring(0, 997) + '...';
    violations.push(`msg_truncated:${text.length}chars`);
  }

  // 4. Remove any residual [METADATA] blocks that leaked into response
  cleaned = cleaned.replace(/\[METADATA\][\s\S]*?\[\/METADATA\]/g, '').trim();

  // 5. Clean up extra whitespace
  cleaned = cleaned.replace(/  +/g, ' ').trim();

  if (violations.length > 0) {
    console.log(`[Validator] ${phone}: ${violations.join(' | ')}`);
  }

  return cleaned;
}
