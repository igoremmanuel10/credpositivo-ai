import { db } from '../db/client.js';
import { cache } from '../db/redis.js';
import { sendMessages, resolveWhatsAppId } from '../quepasa/client.js';
import { findOrCreateContact, findOrCreateConversation, getInboxForPhone, sendOutgoingMessage, updateContactAttributes, setConversationLabels, buildLeadAttributes, buildPhaseLabels } from '../chatwoot/client.js';
import { getAgentResponse } from '../ai/claude.js';
import { config } from '../config.js';
import { normalizePhone } from '../utils/phone.js';

/**
 * Trigger proactive SDR outreach from Paulo to a new signup.
 * Called async from POST /api/register — does NOT block the response.
 *
 * @param {string} phone - Lead's phone number (raw, will be normalized)
 * @param {string} name - Lead's name
 * @param {string} email - Lead's email (for context)
 */
export async function triggerSdrOutreach(phone, name, email) {
  if (!config.sdr.enabled) {
    console.log('[SDR] SDR disabled, skipping outreach');
    return;
  }

  if (!config.sdr.botToken) {
    console.log('[SDR] No SDR bot token configured, skipping outreach');
    return;
  }

  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) {
    console.log(`[SDR] Invalid phone number: ${phone}`);
    return;
  }

  console.log(`[SDR] Triggering Paulo outreach for ${normalizedPhone} (${name})`);

  try {
    // Check if conversation already exists (don't bother leads already talking to Augusto)
    let conversation = await cache.getConversation(normalizedPhone);
    if (!conversation) {
      conversation = await db.getConversation(normalizedPhone);
    }

    if (conversation) {
      console.log(`[SDR] Conversation already exists for ${normalizedPhone} (persona: ${conversation.persona || 'augusto'}). Skipping outreach.`);
      return;
    }

    // Create new conversation with persona=paulo
    conversation = await db.createConversation(
      normalizedPhone,
      name || null,
      'paulo',
      config.sdr.botPhone
    );
    console.log(`[SDR] Created Paulo conversation for ${normalizedPhone} (id: ${conversation.id})`);

    // Build state for AI
    const state = {
      phase: 1,
      price_counter: 0,
      link_counter: 0,
      ebook_sent: false,
      name: name || null,
      user_profile: email ? { email } : {},
      recommended_product: null,
    };

    // System instruction for the outreach message
    const outreachInstruction = `[SISTEMA: Novo cadastro no site. Nome: ${name || 'lead'}${email ? `, Email: ${email}` : ''}. Se apresente como Paulo da CredPositivo. Diga que viu que a pessoa se cadastrou e pergunte se precisa de ajuda para finalizar o pedido ou se tem alguma dúvida. Seja breve e direto. UMA mensagem só.]`;

    // Generate AI response with Paulo persona
    const { text: responseText, metadata } = await getAgentResponse(
      state,
      [], // No history yet
      outreachInstruction,
      'paulo'
    );

    if (!responseText) {
      console.error(`[SDR] Empty response from AI for outreach to ${normalizedPhone}`);
      return;
    }

    // Resolve WhatsApp JID before sending (required for proactive messages to new contacts)
    const resolvedJid = await resolveWhatsAppId(normalizedPhone, config.sdr.botToken);
    if (!resolvedJid) {
      console.log(`[SDR] Phone ${normalizedPhone} not on WhatsApp. Skipping outreach.`);
      return;
    }

    // Store resolved JID for future follow-ups
    await db.updateConversation(conversation.id, { remote_jid: resolvedJid });
    conversation.remote_jid = resolvedJid;

    // Send via WhatsApp using Paulo's bot token (RJ number)
    const chatId = resolvedJid;
    await sendMessages(chatId, responseText, config.sdr.botToken);
    console.log(`[SDR] Outreach message sent to ${normalizedPhone} (jid: ${resolvedJid})`);

    // Save agent message in DB
    const newPhase = metadata.phase ?? 1;
    await db.addMessage(conversation.id, 'agent', responseText, newPhase);

    // Update conversation state
    const updates = { phase: newPhase };
    if (metadata.user_profile_update) {
      updates.user_profile = { ...state.user_profile, ...metadata.user_profile_update };
    }
    await db.updateConversation(conversation.id, updates);

    // Forward to Chatwoot (inbox 2 = RJ)
    try {
      const cwInboxId = getInboxForPhone(config.sdr.botPhone);
      const cwContact = await findOrCreateContact(normalizedPhone, name, cwInboxId);
      const cwContactId = cwContact.id || cwContact.payload?.contact?.id;
      if (cwContactId) {
        const cwConv = await findOrCreateConversation(cwContactId, `whatsapp_${normalizedPhone}`, cwInboxId);
        if (cwConv.id) {
          await sendOutgoingMessage(cwConv.id, responseText);
          console.log(`[SDR] Outreach forwarded to Chatwoot conversation ${cwConv.id} (inbox ${cwInboxId})`);

          // Sync lead qualification to Chatwoot
          const attrs = buildLeadAttributes({
            phase: newPhase,
            persona: 'paulo',
            name,
            user_profile: state.user_profile,
            recommended_product: null,
          });
          await updateContactAttributes(cwContactId, attrs);
          await setConversationLabels(cwConv.id, buildPhaseLabels(newPhase, 'paulo'));
        }
      }
    } catch (err) {
      console.error('[SDR] Failed to forward outreach to Chatwoot:', err.message);
    }

    // Cache conversation
    await cache.setConversation(normalizedPhone, conversation);

    console.log(`[SDR] Outreach complete for ${normalizedPhone}`);

  } catch (err) {
    console.error(`[SDR] Outreach failed for ${normalizedPhone}:`, err);
  }
}
