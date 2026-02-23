import { db } from '../db/client.js';
import { cache } from '../db/redis.js';
import { sendMessages, sendMedia } from '../quepasa/client.js';
import { findOrCreateContact, findOrCreateConversation, getInboxForPhone, sendOutgoingMessage, updateContactAttributes, setConversationLabels, buildLeadAttributes, buildPhaseLabels } from '../chatwoot/client.js';
import { getAgentResponse } from '../ai/claude.js';
import { applyMetadataUpdates } from './state.js';
import { getMediaForPhase, getProductAudios } from '../media/assets.js';
import { sendMediaBase64 } from '../quepasa/client.js';
import { fixSiteLinks } from '../ai/output-filter.js';
import { config } from '../config.js';
import { resolvePersona } from '../sdr/persona.js';
import { captureError } from '../monitoring/sentry.js';
import { assignVariants, getPromptOverride } from '../ab/manager.js';
import crypto from 'crypto';

// In-memory map: phone → botTokenForReply (for follow-ups and debounced messages)
const phoneTokenMap = new Map();
// In-memory map: phone → persona (detected from bot token at webhook time)
const phonePersonaMap = new Map();

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
    const fixedResponseText = fixSiteLinks(cleanedResponseText);

    // 8. Send response via WhatsApp (with correct bot token for multi-number support)
    const messageIds = await sendMessages(remoteJid, fixedResponseText, botTokenForReply);

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
export async function handleFollowup(conversation, eventType) {
  const messages = await db.getMessages(conversation.id);

  // Guard: don't send follow-up if last message is already from the agent
  if (messages.length > 0) {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role === 'agent') {
      console.log(`[Followup] BLOCKED ${eventType} for ${conversation.phone} — last message is already from agent. Waiting for lead to respond.`);
      return;
    }
  }

  const state = {
    phase: conversation.phase,
    price_counter: conversation.price_counter,
    link_counter: conversation.link_counter,
    ebook_sent: conversation.ebook_sent,
    name: conversation.name,
    user_profile: conversation.user_profile || {},
    recommended_product: conversation.recommended_product,
  };

  const followupPrompt = buildFollowupPrompt(eventType, conversation);

  const followupPersona = conversation.persona || 'augusto';
  const { text: responseText, metadata } = await getAgentResponse(
    state,
    messages,
    followupPrompt,
    followupPersona
  );

  if (!responseText) return;

  // Fix any incorrect/shortened site links
  const fixedText = fixSiteLinks(responseText);

  // Use stored remoteJid, fallback to reconstructed JID
  const target = conversation.remote_jid || `${conversation.phone}@s.whatsapp.net`;
  console.log(`[Followup] Sending ${eventType} to ${target} (stored jid: ${!!conversation.remote_jid})`);

  // Use stored token for follow-ups if available
  const token = phoneTokenMap.get(conversation.phone) || null;
  await sendMessages(target, fixedText, token);
  await db.addMessage(conversation.id, 'agent', fixedText, conversation.phase);

  const updates = applyMetadataUpdates(state, metadata);
  if (Object.keys(updates).length > 0) {
    await db.updateConversation(conversation.id, updates);
  }

  console.log(`[Followup] ${eventType} message sent to ${target}`);
}

function buildFollowupPrompt(eventType, conversation) {
  const prompts = {
    consultation_timeout:
      `[SISTEMA: O lead não respondeu há mais de 48h. Mande UMA mensagem curta e genuína perguntando se está tudo bem. NÃO mencione produtos, site ou compra. Apenas mostre que se importa. Se não responder a este follow-up, NÃO insista mais.]`,
    signup_completed:
      `[SISTEMA: O lead criou conta no site mas ainda não comprou. Pergunte se teve alguma dúvida ou dificuldade. NÃO pressione para comprar. Uma mensagem só.]`,
    purchase_completed:
      `[SISTEMA: O lead comprou ${conversation.recommended_product || 'um produto'}. Parabenize e pergunte se precisa de ajuda com algo. Seja breve.]`,
    purchase_abandoned:
      `[SISTEMA: O lead iniciou checkout mas não finalizou. Pergunte se teve alguma dificuldade técnica. NÃO pressione. Se não responder, respeite o silêncio.]`,
    link_sent_no_action:
      `[SISTEMA: O link foi enviado há 24h+ mas o lead não acessou. Pergunte se ficou alguma dúvida. NÃO reenvie o link. NÃO insista. Uma mensagem só.]`,
  };

  return prompts[eventType] || `[SISTEMA: Follow-up necessário para ${eventType}.]`;
}
