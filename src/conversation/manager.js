import { db } from '../db/client.js';
import { cache } from '../db/redis.js';
import { sendMessages, sendMedia } from '../quepasa/client.js';
import { findOrCreateContact, findOrCreateConversation, getInboxForPhone, sendOutgoingMessage, updateContactAttributes, setConversationLabels, buildLeadAttributes, buildPhaseLabels } from '../chatwoot/client.js';
import { getAgentResponse } from '../ai/claude.js';
import { applyMetadataUpdates } from './state.js';
import { getAudioApresentacao, getAudioDiagnostico, getTutorialVideo, getRatingInfoImage, getProvaSocialNew, getProvaSocial, getFollowupAudio } from '../media/assets.js';
import { sendMediaBase64 } from '../quepasa/client.js';
import { fixSiteLinks, sanitizeForWhatsApp } from '../ai/output-filter.js';
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

// === STATE MACHINE & MEDIA RULES (deterministic flow control) ===
import { evaluateTransition, detectQualificationPoints, detectIntent, validateTransition, getPhaseConfig } from '../flow/machine.js';
import { getPhase0AudioAction, getEducationalAction, getProvaSocialAction, recordProvaSocialSent, getPaymentLinkAction, scheduleNudge, cancelNudge, MEDIA_CONFIG } from '../flow/media-rules.js';

// === PAYMENT LINK: Generate personalized MP checkout link ===
const PRODUCT_PRICES = { diagnostico: 67, limpa_nome: 497, rating: 997 };

async function generatePaymentLink(conversation, product) {
  try {
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
 *
 * Pipeline:
 * 1. Load conversation, save incoming message
 * 2. STATE MACHINE: detect intent, evaluate qualification, determine phase transition
 * 3. LLM: generate conversational text (phase/media decisions already made)
 * 4. MEDIA RULES: send educational material, prova social, payment links
 * 5. Save, forward to Chatwoot, update state, sync CRM
 */
async function processBufferedMessages(phone, remoteJid, pushName) {
  // Retrieve the stored token and persona for this phone
  const botTokenForReply = phoneTokenMap.get(phone) || null;
  const persona = phonePersonaMap.get(phone) || 'augusto';

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
    // ════════════════════════════════════════════════════════════════
    // STEP 1: Load or create conversation
    // ════════════════════════════════════════════════════════════════
    let conversation = await cache.getConversation(phone);
    if (!conversation) {
      conversation = await db.getConversation(phone);
    }

    // Validate cached conversation still exists in DB (FK constraint protection)
    if (conversation) {
      const dbConv = await db.getConversation(phone);
      if (!dbConv || dbConv.id !== conversation.id) {
        console.warn(`[Manager] Cached conversation ${conversation.id} for ${phone} not found in DB. Invalidating cache.`);
        await cache.deleteConversation(phone);
        conversation = dbConv || null; // use DB version if it exists under different id, otherwise null
      }
    }

    if (!conversation) {
      const botPhone = Object.entries(config.sdr.phoneToPersona).find(([, p]) => p === persona)?.[0] || '';
      conversation = await db.createConversation(phone, pushName || null, persona, botPhone);
      console.log(`[Manager] New conversation created for ${phone} (persona: ${persona})`);
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

    // Cancel any pending nudge (Redis-persisted) since user responded
    await cancelNudge(phone);

    // Save incoming message
    await db.addMessage(conversation.id, 'user', combinedText, conversation.phase);
    conversation.message_count = (conversation.message_count || 0) + 1;

    // Load message history (last 12 messages — saves ~40% tokens vs 20)
    const messages = await db.getMessages(conversation.id, 12);
    const totalMessages = await db.getMessageCount(conversation.id);

    // BOT-LOOP PROTECTION: Max messages per conversation
    const maxConversationMessages = config.limits.maxConversationMessages || 200;
    if (totalMessages > maxConversationMessages) {
      console.warn(`[Manager] CONVERSATION LIMIT reached for ${phone}: ${totalMessages}/${maxConversationMessages} messages. Auto-pausing.`);
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

    // ════════════════════════════════════════════════════════════════
    // STEP 2: STATE MACHINE — Deterministic flow decisions BEFORE LLM
    // ════════════════════════════════════════════════════════════════
    const intent = detectIntent(combinedText);
    const qualification = detectQualificationPoints(combinedText, conversation.user_profile || {});
    const transition = evaluateTransition(conversation, combinedText);
    const phaseConfig = getPhaseConfig(conversation.phase);

    console.log(`[Machine] phone=${phone} phase=${conversation.phase} intent=${intent.type} qual=${qualification.points}/3 advance=${transition.shouldAdvance}→${transition.nextPhase} reason=${transition.reason}`);

    // Apply phase transition BEFORE calling LLM (so LLM gets correct phase context)
    let effectivePhase = conversation.phase;
    if (transition.shouldAdvance) {
      effectivePhase = transition.nextPhase;
      console.log(`[Machine] Phase transition: ${conversation.phase} → ${effectivePhase} (${transition.reason})`);
    }

    // Enrich user_profile with qualification data detected by regex
    const profileUpdatesFromMachine = {};
    if (qualification.detected.onde_negativado && !conversation.user_profile?.onde_negativado) {
      profileUpdatesFromMachine.onde_negativado = true;
    }
    if (qualification.detected.tempo_situacao && !conversation.user_profile?.tempo_situacao) {
      profileUpdatesFromMachine.tempo_situacao = true;
    }
    if (qualification.detected.tentou_banco && !conversation.user_profile?.tentou_banco) {
      profileUpdatesFromMachine.tentou_banco = true;
    }

    // Determine media actions BEFORE LLM (so we can inform LLM what's about to happen)
    const phase0AudioAction = getPhase0AudioAction({ ...conversation, phase: effectivePhase });
    const eduAction = getEducationalAction({ ...conversation, phase: effectivePhase });
    const provaSocialAction = await getProvaSocialAction({ ...conversation, phase: effectivePhase }, intent.type);
    const paymentLinkAction = getPaymentLinkAction({ ...conversation, phase: effectivePhase }, intent.type);

    // ════════════════════════════════════════════════════════════════
    // STEP 3: Build state for LLM and get conversational response
    // ════════════════════════════════════════════════════════════════
    const state = {
      phase: effectivePhase, // LLM sees the phase AFTER machine transition
      price_counter: conversation.price_counter,
      link_counter: conversation.link_counter,
      ebook_sent: conversation.ebook_sent,
      name: conversation.name || pushName || null,
      user_profile: { ...(conversation.user_profile || {}), ...profileUpdatesFromMachine },
      recommended_product: conversation.recommended_product,
      message_count: conversation.message_count || 0,
    };

    // A/B test variant assignment
    const activePersona = conversation.persona || persona;
    let abOverrides = {};
    try {
      const assignments = await assignVariants(conversation.id, activePersona);
      for (const target of Object.keys(assignments)) {
        const override = await getPromptOverride(assignments, target);
        if (override) abOverrides[target] = override;
      }
    } catch (err) {
      console.warn('[Manager] A/B test assignment failed (non-critical):', err.message);
    }

    // Get AI response — LLM generates ONLY conversational text
    let responseText, metadata;
    try {
      ({ text: responseText, metadata } = await getAgentResponse(state, messages, combinedText, activePersona, abOverrides));
    } catch (aiErr) {
      console.error(`[Manager] AI completely failed for ${phone} (${aiErr.status || aiErr.message}). Sending emergency response.`);
      const emergencyResponses = {
        0: 'Opa, tudo bem? Aqui e o Augusto da CredPositivo. Me conta, o que voce ta buscando resolver?',
        1: 'Desculpa a demora! Me conta mais sobre a sua situacao pra eu te ajudar melhor.',
        2: 'Opa, desculpa a demora! Estava verificando aqui. Me conta, o que mais te preocupa na sua situacao?',
        3: 'Desculpa a demora! Estou aqui pra te ajudar. Ficou alguma duvida sobre o diagnostico?',
      };
      responseText = emergencyResponses[effectivePhase] || emergencyResponses[0];
      metadata = {};
      captureError(aiErr, { module: 'manager', action: 'emergency_response', extra: { phone, phase: effectivePhase } });
    }

    // FORCE MENU: If phase 0, first interaction, and AI didn't send the menu (Augusto only)
    const currentPersona = conversation.persona || 'augusto';
    if (currentPersona === 'augusto' && effectivePhase === 0 && (conversation.message_count || 0) <= 1) {
      const MENU_TEXT = 'E ai! Aqui e o Augusto, da CredPositivo. Bora resolver sua situacao.\n\nMe diz, o que ta te travando?\n1 - Meu nome ta sujo e quero limpar\n2 - Nome limpo mas banco nega tudo\n3 - Quero mais limite/credito\n4 - Ja to em atendimento';
      const normalized = (responseText || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      if (!normalized.includes('o que ta te travando') && !normalized.includes('1 -')) {
        console.warn(`[Manager] AI skipped menu for ${phone}. Forcing menu text.`);
        responseText = MENU_TEXT;
        metadata = {};
      }
    }

    // DEFAULT METADATA: If AI forgot metadata, provide defaults
    if (!metadata || Object.keys(metadata).length === 0) {
      metadata = {};
    }

    if (!responseText) {
      console.error(`[Manager] Empty response from Claude for ${phone}`);
      return;
    }

    // ════════════════════════════════════════════════════════════════
    // STEP 4: Validate opt-out (keyword match, not LLM opinion)
    // ════════════════════════════════════════════════════════════════
    const isOptOut = intent.type === 'opt_out' || metadata.escalation_flag === 'opt_out';
    if (isOptOut) {
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
      const normalizedOptOut = combinedText.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const isRealOptOut = optOutPhrases.some(phrase => normalizedOptOut.includes(phrase));

      if (isRealOptOut) {
        await db.updateConversation(conversation.id, { opted_out: true });
        await db.cancelFollowups(conversation.id);
        console.log(`[Manager] Lead ${phone} opted out (confirmed by keyword match). Follow-ups cancelled.`);
        syncDealLost(phone, 'opt_out').catch(() => {});
      } else {
        console.warn(`[Manager] opt_out flagged for ${phone} but message "${combinedText.substring(0, 80)}" has no opt-out keyword. IGNORING.`);
      }
    }

    // ════════════════════════════════════════════════════════════════
    // STEP 5: Clean response text and apply human delay
    // ════════════════════════════════════════════════════════════════
    // Strip [AUDIO] tag (legacy cleanup)
    const cleanedResponseText = responseText.replace(/\[AUDIO\]/g, '').trim();
    let fixedResponseText = sanitizeForWhatsApp(fixSiteLinks(cleanedResponseText), phone);

    // Human-like delay: wait 8-15s before sending (avoids robotic feel)
    const minDelay = 8000;
    const maxDelay = 15000;
    const humanDelay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
    console.log(`[Manager] Human delay: ${(humanDelay / 1000).toFixed(1)}s before sending to ${phone}`);
    await new Promise(r => setTimeout(r, humanDelay));

    // ════════════════════════════════════════════════════════════════
    // STEP 6: Send text response via WhatsApp
    // ════════════════════════════════════════════════════════════════
    let messageIds = await sendMessages(remoteJid, fixedResponseText, botTokenForReply);

    // ════════════════════════════════════════════════════════════════
    // STEP 7: MEDIA RULES — Deterministic media dispatch
    // ════════════════════════════════════════════════════════════════

    // 7a. Phase 0 audio (audio_apresentacao — boas-vindas, sent after first text)
    if (phase0AudioAction) {
      try {
        await new Promise(r => setTimeout(r, phase0AudioAction.delayAfterText)); // 3s gap after text
        const audioAsset = getAudioApresentacao();
        if (audioAsset) {
          await sendMediaBase64(remoteJid, audioAsset.base64, '', audioAsset.fileName, botTokenForReply, audioAsset.mimetype);
          console.log(`[Manager] Phase 0 audio_apresentacao sent to ${phone}`);

          // Mark as sent to avoid duplicate
          const updatedProfile = {
            ...(conversation.user_profile || {}),
            ...profileUpdatesFromMachine,
            phase0_audio_sent: true,
          };
          await db.updateConversation(conversation.id, { user_profile: updatedProfile });
          conversation.user_profile = updatedProfile;
        }
      } catch (err) {
        console.error(`[Manager] Failed to send phase 0 audio:`, err.message);
      }
    }

    // 7b. Educational material (phase 1+ for Paulo, phase 2+ for Augusto)
    if (eduAction) {
      try {
        await new Promise(r => setTimeout(r, eduAction.delayAfterText)); // 3s gap after text
        let mediaAsset = null;
        const newStage = eduAction.newStage;

        if (eduAction.asset === 'audio_diagnostico') {
          mediaAsset = getAudioDiagnostico();
        } else if (eduAction.asset === 'rating_info_image') {
          mediaAsset = getRatingInfoImage();
        } else if (eduAction.asset === 'tutorial_video') {
          mediaAsset = getTutorialVideo();
        }

        if (mediaAsset) {
          await sendMediaBase64(remoteJid, mediaAsset.base64, '', mediaAsset.fileName, botTokenForReply, mediaAsset.mimetype);
          console.log(`[Manager] Edu stage ${eduAction.newStage - 1}→${newStage}: ${eduAction.asset} sent to ${phone}`);
        }

        // Update educational_stage in user_profile
        const updatedProfile = {
          ...(conversation.user_profile || {}),
          ...profileUpdatesFromMachine,
          educational_stage: newStage,
          educational_material_sent: newStage >= 3,
        };
        await db.updateConversation(conversation.id, { user_profile: updatedProfile });
        conversation.user_profile = updatedProfile;
        console.log(`[Manager] Educational stage updated: ${eduAction.newStage - 1}→${newStage} for ${phone}`);

        // Schedule nudge via Redis (survives restarts, unlike setTimeout)
        await scheduleNudge(phone, 'educational', eduAction.nudgeDelay, {
          conversationId: conversation.id,
          nudgeText: eduAction.nudgeText,
          remoteJid,
          botToken: botTokenForReply,
          phase: effectivePhase,
        });
        console.log(`[Manager] Edu nudge scheduled for ${phone} in ${eduAction.nudgeDelay / 1000}s`);
      } catch (err) {
        console.error(`[Manager] Failed to send educational material:`, err.message);
      }
    }

    // 7c. Prova social (phase 3+, on trust objection)
    if (provaSocialAction) {
      try {
        const provaSocial = getProvaSocialNew(provaSocialAction.assetIndex);
        if (provaSocial) {
          await new Promise(r => setTimeout(r, 2000));
          await sendMediaBase64(remoteJid, provaSocial.base64, '', provaSocial.fileName, botTokenForReply, provaSocial.mimetype);
          console.log(`[Manager] Prova social ${provaSocialAction.assetIndex + 1} sent to ${phone}`);

          // Track prova social count + daily cooldown
          const provaSocialCount = (conversation.user_profile?.prova_social_count || 0) + 1;
          const updatedProfile = { ...(conversation.user_profile || {}), ...profileUpdatesFromMachine, prova_social_count: provaSocialCount };
          await db.updateConversation(conversation.id, { user_profile: updatedProfile });
          conversation.user_profile = updatedProfile;
          await recordProvaSocialSent(phone);

          // Schedule nudge via Redis
          await scheduleNudge(phone, 'prova_social', provaSocialAction.nudgeDelay, {
            conversationId: conversation.id,
            nudgeText: provaSocialAction.nudgeText,
            remoteJid,
            botToken: botTokenForReply,
            phase: effectivePhase,
          });
          console.log(`[Manager] Prova social nudge scheduled for ${phone} in ${provaSocialAction.nudgeDelay / 1000}s`);
        }
      } catch (err) {
        console.error(`[Manager] Failed to send prova social:`, err.message);
      }
    }

    // 7d. Payment link (phase 3, on interest intent)
    if (paymentLinkAction) {
      try {
        const paymentUrl = await generatePaymentLink(conversation, paymentLinkAction.product);
        if (paymentUrl) {
          await new Promise(r => setTimeout(r, 2000));
          await sendMessages(remoteJid, paymentUrl, botTokenForReply);
          console.log(`[Manager] Payment link sent to ${phone}: ${paymentLinkAction.product} R$${paymentLinkAction.price}`);
          // Save as agent message
          await db.addMessage(conversation.id, 'agent', paymentUrl, effectivePhase);
        }
      } catch (err) {
        console.error(`[Manager] Failed to send payment link:`, err.message);
      }
    }

    // ════════════════════════════════════════════════════════════════
    // STEP 8: Save agent message
    // ════════════════════════════════════════════════════════════════
    await db.addMessage(conversation.id, 'agent', fixedResponseText, effectivePhase, messageIds);
    conversation.message_count = (conversation.message_count || 0) + 1;

    // ════════════════════════════════════════════════════════════════
    // STEP 9: Forward to Chatwoot
    // ════════════════════════════════════════════════════════════════
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

    // ════════════════════════════════════════════════════════════════
    // STEP 10: Apply state updates (machine + LLM metadata)
    // ════════════════════════════════════════════════════════════════

    // Build safe metadata: ONLY accept user_profile_update, recommended_product,
    // price_mentioned, escalation_flag from LLM. Phase comes from the state machine.
    const safeMetadata = {
      phase: effectivePhase,  // from state machine, NOT from LLM
      price_mentioned: metadata.price_mentioned || false,
      recommended_product: metadata.recommended_product || null,
      user_profile_update: {
        ...(metadata.user_profile_update || {}),
        ...profileUpdatesFromMachine,
      },
    };

    // Apply payment link counter increment from media rules
    if (paymentLinkAction) {
      safeMetadata.should_send_link = true;
    }

    const updates = applyMetadataUpdates(
      {
        phase: conversation.phase,
        price_counter: conversation.price_counter,
        link_counter: conversation.link_counter,
        ebook_sent: conversation.ebook_sent,
        user_profile: conversation.user_profile || {},
        recommended_product: conversation.recommended_product,
      },
      safeMetadata,
    );
    if (Object.keys(updates).length > 0) {
      await db.updateConversation(conversation.id, updates);
      Object.assign(conversation, updates);
    }

    // Transfer to Paulo (if LLM flags it — kept as manual override)
    if (metadata.transfer_to_paulo && (conversation.persona || 'augusto') === 'augusto') {
      console.log(`[Manager] TRANSFER TO PAULO triggered for ${phone} (product: ${metadata.recommended_product || conversation.recommended_product})`);
      await db.updateConversation(conversation.id, { persona: 'paulo' });
      conversation.persona = 'paulo';
      phonePersonaMap.set(phone, 'paulo');
      await cache.setConversation(phone, conversation);

      try {
        const cwBotPhone = conversation.bot_phone || '';
        const cwInboxId = getInboxForPhone(cwBotPhone);
        const cwContact = await findOrCreateContact(phone, conversation.name, cwInboxId);
        const cwContactId = cwContact.id || cwContact.payload?.contact?.id;
        if (cwContactId) {
          const cwConv = await findOrCreateConversation(cwContactId, `whatsapp_${phone}`, cwInboxId);
          if (cwConv.id) {
            const transferLabels = buildPhaseLabels(effectivePhase, 'paulo');
            transferLabels.push('transfer_to_paulo');
            await setConversationLabels(cwConv.id, transferLabels);
          }
        }
      } catch (err) {
        console.error('[Manager] Failed to update Chatwoot labels for Paulo transfer:', err.message);
      }
    }

    // CRM: Sync phase change to Krayin
    if (transition.shouldAdvance) {
      syncPhaseChange(phone, effectivePhase, {
        recommended_product: metadata.recommended_product || conversation.recommended_product,
      }).catch(err => {
        console.error('[CRM] Failed to sync phase change:', err.message);
      });
    }

    // Cache updated conversation
    await cache.setConversation(phone, conversation);

    // Set cooldown
    await cache.setLastResponseTime(phone);

    // Increment hourly counter
    const newHourlyCount = await cache.incrementHourlyMessageCount(phone);
    console.log(`[Manager] Hourly count for ${phone}: ${newHourlyCount}/${maxPerHour}`);

    // Check escalation
    if (metadata.escalation_flag && metadata.escalation_flag !== 'opt_out') {
      console.warn(`[ESCALATION] ${metadata.escalation_flag} flagged for ${phone}`);
    }

    console.log(`[Manager] Response sent to ${remoteJid} (phase: ${effectivePhase}, intent: ${intent.type}, transition: ${transition.reason})`);
  } finally {
    await cache.releaseProcessingLock(phone);
  }
}

// ════════════════════════════════════════════════════════════════
// FOLLOW-UP HANDLER
// ════════════════════════════════════════════════════════════════

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
        await sendMediaBase64(target, audioData.base64, '', audioData.fileName, token, audioData.mimetype);
        await db.addMessage(conversation.id, 'agent', `[Audio follow-up 24h - ${persona}]`, conversation.phase);
        console.log(`[Followup] Pre-recorded audio sent for ${persona} to ${conversation.phone}`);
        await new Promise(r => setTimeout(r, 3000));
        const produto = conversation.user_profile?.produto || 'crédito';
        const banco = conversation.user_profile?.tentou_banco || '';
        const bancoRef = banco ? ` no ${banco}` : '';
        const fuText = `Mandei esse áudio pra te explicar melhor. Sobre a negação${bancoRef} — o diagnóstico mostra exatamente o que tá travando seu ${produto}. Dá uma olhada: ${config.site.url}`;
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
        const provaSocial = getProvaSocial(persona, conversation.id);
        if (provaSocial) {
          const caption = getProvaSocialCaption(conversation.id + 10);
          await sendMediaBase64(target, provaSocial.base64, caption, provaSocial.fileName, token, provaSocial.mimetype);
          await db.addMessage(conversation.id, 'agent', `[Prova social - ${provaSocial.fileName}] ${caption}`, conversation.phase);
          return;
        }
      }
    } catch (err) {
      console.error(`[Followup] VAPI outbound call error:`, err.message);
    }
  }

  // ── SOCIAL PROOF MEDIA + CONTEXTUAL TEXT ──
  if (format.type === 'social_proof_media') {
    try {
      const provaSocial = getProvaSocial(persona, conversation.id + attempt);
      if (provaSocial) {
        const caption = getProvaSocialCaption(conversation.id + attempt);
        await sendMediaBase64(target, provaSocial.base64, caption, provaSocial.fileName, token, provaSocial.mimetype);
        await db.addMessage(conversation.id, 'agent', `[Prova social - ${provaSocial.fileName}] ${caption}`, conversation.phase);
        console.log(`[Followup] Prova social sent: ${provaSocial.fileName} to ${conversation.phone}`);
        await new Promise(r => setTimeout(r, 3000));
        const name = conversation.name || 'amigo';
        const socialTexts = [
          `${name}, esse cliente tava na mesma situação que você. Fez o diagnóstico e em 2 meses conseguiu destravar. Se quiser ver como funciona: ${config.site.url}`,
          `${name}, resultados assim são comuns pra quem entende o que os bancos realmente veem. Quer fazer o seu? ${config.site.url}`,
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

  const fixedText = sanitizeForWhatsApp(fixSiteLinks(responseText));

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

  // Only accept safe metadata from follow-up LLM responses
  const safeFollowupMetadata = {
    phase: conversation.phase, // never change phase from follow-up
    price_mentioned: metadata.price_mentioned || false,
    recommended_product: metadata.recommended_product || null,
    user_profile_update: metadata.user_profile_update || {},
  };
  const followupUpdates = applyMetadataUpdates(state, safeFollowupMetadata);
  if (Object.keys(followupUpdates).length > 0) {
    await db.updateConversation(conversation.id, followupUpdates);
  }

  console.log(`[Followup] ${eventType} attempt ${attempt} (${format.type}) sent to ${target}`);
}

// ════════════════════════════════════════════════════════════════
// FOLLOW-UP PROMPTS & AUDIO SCRIPTS
// ════════════════════════════════════════════════════════════════

function getAudioScript(eventType, conversation) {
  const name = conversation.name || 'amigo';
  const persona = conversation.persona || 'augusto';
  const personaName = persona === 'paulo' ? 'Paulo' : 'Augusto';

  const scripts = {
    consultation_timeout: {
      augusto: `Oi ${name}, tudo bem? Aqui é o ${personaName} da CredPositivo. Tô te mandando esse áudio rapidinho porque sei que o dia a dia é corrido. Só queria saber se você tá bem e se ainda precisa daquela ajuda com sua situação de crédito. A nossa análise é gratuita e sem compromisso nenhum. Quando puder, me dá um retorno que eu tô aqui pra te ajudar, beleza?`,
      paulo: `Fala ${name}, tudo certo? Aqui é o ${personaName} da CredPositivo. Gravei esse áudio só pra saber como você tá. Sei que a gente tava conversando sobre sua situação financeira e quero te dizer que continuo aqui disponível. Sem pressão nenhuma, viu? Quando tiver um minutinho, me chama que a gente resolve isso juntos.`,
    },
    reengagement: {
      augusto: `Oi ${name}, aqui é o ${personaName} da CredPositivo de novo. Faz uns dias que a gente conversou e quero te dizer que tá tudo bem, sem pressão. Só tô te mandando esse áudio porque realmente acredito que posso te ajudar. A gente já ajudou muita gente na mesma situação. Quando você tiver um tempinho, me chama aqui que a gente retoma de onde parou, tá bom?`,
      paulo: `E aí ${name}, tudo certo contigo? Aqui é o ${personaName} da CredPositivo. Faz um tempinho que a gente conversou e eu queria saber se mudou alguma coisa na sua situação. Se ainda precisar de ajuda, saiba que tô aqui. Sem compromisso, é só me chamar.`,
    },
    purchase_completed: {
      augusto: `${name}, aqui é o ${personaName} da CredPositivo. Parabéns pela sua decisão! Quero que saiba que nossa equipe já tá trabalhando no seu caso. Se tiver qualquer dúvida, qualquer coisa mesmo, pode me chamar aqui que eu te ajudo na hora, combinado?`,
      paulo: `Fala ${name}, ${personaName} aqui. Passando pra te dar parabéns pela decisão. A equipe já tá cuidando de tudo pra você. Qualquer dúvida, é só chamar que eu tô aqui!`,
    },
    social_proof: {
      augusto: `${name}, deixa eu te contar uma coisa rápida. Essa semana mesmo a gente ajudou um cliente que tava com o nome sujo há 3 anos. Em menos de 15 dias ele já tava com o score subindo e as dívidas negociadas. O processo é simples e eu te guio em tudo. Posso te explicar como funciona?`,
      paulo: `${name}, deixa eu compartilhar contigo. Só no último mês a gente ajudou dezenas de pessoas a limpar o nome e melhorar o score. Tem cliente nosso que já conseguiu até financiamento depois do processo. Isso é real e pode ser sua história também. Vamos conversar?`,
    },
    urgency: {
      augusto: `${name}, olha só, tô te mandando esse áudio porque surgiu uma condição especial essa semana pra negociação de dívidas. Os descontos tão muito bons e não sei até quando vai durar. Se você tiver interesse, me responde aqui que eu já puxo tudo pra você aproveitar, beleza?`,
      paulo: `${name}, ${personaName} aqui. Preciso te falar uma coisa importante: tô vendo aqui umas condições de negociação muito boas que apareceram agora. Descontos que raramente acontecem. Se você tem dívidas pra resolver, esse é o momento. Me responde aqui que eu te passo tudo certinho.`,
    },
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
    const produto = conversation.user_profile?.produto || 'crédito';
    const banco = conversation.user_profile?.tentou_banco || '';
    const bancoRef = banco ? ` a negação do ${banco}` : ' a situação do seu crédito';
    const siteUrl = config.site.url;

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
