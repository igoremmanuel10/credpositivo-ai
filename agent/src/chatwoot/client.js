import { config } from '../config.js';

const { apiUrl, apiToken, accountId, inboxId: defaultInboxId } = config.chatwoot;
const baseUrl = `${apiUrl}/api/v1/accounts/${accountId}`;

/**
 * Resolve the Chatwoot inbox ID for a given bot phone number.
 * Uses inboxMapping from config, falls back to default inbox.
 *
 * @param {string} botPhone - Bot phone number (from wid)
 * @returns {string} Inbox ID
 */
export function getInboxForPhone(botPhone) {
  if (botPhone && config.chatwoot.inboxMapping[botPhone]) {
    return config.chatwoot.inboxMapping[botPhone];
  }
  return defaultInboxId;
}

/**
 * Find or create a Chatwoot contact by phone number.
 *
 * @param {string} phone - Contact phone number
 * @param {string} name - Contact display name
 * @param {string|null} targetInboxId - Inbox ID override (for multi-number routing)
 */
export async function findOrCreateContact(phone, name, targetInboxId = null) {
  const useInboxId = targetInboxId || defaultInboxId;

  // Search existing contact
  const searchRes = await fetch(`${baseUrl}/contacts/search?q=${phone}&include_contacts=true`, {
    headers: { 'api_access_token': apiToken },
  });
  const searchData = await searchRes.json();

  if (searchData.payload?.length > 0) {
    return searchData.payload[0];
  }

  // Create new contact
  const createRes = await fetch(`${baseUrl}/contacts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api_access_token': apiToken,
    },
    body: JSON.stringify({
      name: name || phone,
      phone_number: `+${phone}`,
      inbox_id: parseInt(useInboxId),
    }),
  });
  const contact = await createRes.json();
  console.log(`[Chatwoot] Created contact: ${phone} (id: ${contact.payload?.contact?.id}) inbox: ${useInboxId}`);
  return contact.payload?.contact || contact;
}

/**
 * Find open conversation or create a new one for a contact.
 *
 * @param {number} contactId - Chatwoot contact ID
 * @param {string} sourceId - Source identifier
 * @param {string|null} targetInboxId - Inbox ID override (for multi-number routing)
 */
export async function findOrCreateConversation(contactId, sourceId, targetInboxId = null) {
  const useInboxId = targetInboxId || defaultInboxId;

  // Search open conversations for this contact
  const convRes = await fetch(`${baseUrl}/contacts/${contactId}/conversations`, {
    headers: { 'api_access_token': apiToken },
  });
  const convData = await convRes.json();

  // Find an open conversation in the target inbox
  const openConv = convData.payload?.find(
    c => c.inbox_id === parseInt(useInboxId) && (c.status === 'open' || c.status === 'pending')
  );
  if (openConv) return openConv;

  // Create new conversation
  const createRes = await fetch(`${baseUrl}/conversations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api_access_token': apiToken,
    },
    body: JSON.stringify({
      contact_id: contactId,
      inbox_id: parseInt(useInboxId),
      source_id: sourceId || `whatsapp_${contactId}`,
      status: 'open',
    }),
  });
  const conv = await createRes.json();
  console.log(`[Chatwoot] Created conversation: ${conv.id} for contact ${contactId} inbox: ${useInboxId}`);
  return conv;
}

/**
 * Send a message to a Chatwoot conversation.
 */
export async function sendMessage(conversationId, content, messageType = 'incoming') {
  const body = {
    content,
    message_type: messageType,
    private: false,
  };
  // Mark bot-sent outgoing messages so the webhook can distinguish from human-typed
  if (messageType === 'outgoing') {
    body.content_attributes = { external_created: true };
  }
  const res = await fetch(`${baseUrl}/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api_access_token': apiToken,
    },
    body: JSON.stringify(body),
  });
  const msg = await res.json();
  return msg;
}

/**
 * Send an outgoing message (from bot/agent) to a Chatwoot conversation.
 */
export async function sendOutgoingMessage(conversationId, content) {
  return sendMessage(conversationId, content, 'outgoing');
}

/**
 * Update custom attributes on a Chatwoot contact.
 */
export async function updateContactAttributes(contactId, customAttributes) {
  const res = await fetch(`${baseUrl}/contacts/${contactId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'api_access_token': apiToken,
    },
    body: JSON.stringify({ custom_attributes: customAttributes }),
  });
  if (!res.ok) {
    console.error(`[Chatwoot] Failed to update contact ${contactId} attributes: ${res.status}`);
  }
}

/**
 * Set labels on a Chatwoot conversation (replaces existing labels).
 */
export async function setConversationLabels(conversationId, labels) {
  const res = await fetch(`${baseUrl}/conversations/${conversationId}/labels`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api_access_token': apiToken,
    },
    body: JSON.stringify({ labels }),
  });
  if (!res.ok) {
    console.error(`[Chatwoot] Failed to set labels on conversation ${conversationId}: ${res.status}`);
  }
}

const PHASE_NAMES = {
  0: 'novo-lead',
  1: 'apresentacao',
  2: 'investigacao',
  3: 'diagnostico',
  4: 'fechamento',
  5: 'pos-compra',
};

/**
 * Build custom_attributes object for a Chatwoot contact from conversation state.
 */
export function buildLeadAttributes(conversation) {
  const phase = conversation.phase ?? 0;
  const profile = conversation.user_profile || {};
  return {
    fase: phase,
    fase_nome: PHASE_NAMES[phase] || `fase-${phase}`,
    persona: conversation.persona || 'augusto',
    produto_recomendado: conversation.recommended_product || null,
    objetivo_credito: profile.objetivo || profile.credit_goal || null,
    email: profile.email || null,
  };
}

/**
 * Build labels array for a Chatwoot conversation from phase and persona.
 */
export function buildPhaseLabels(phase, persona) {
  const phaseName = PHASE_NAMES[phase] || `fase-${phase}`;
  return [`fase-${phase}`, phaseName, persona || 'augusto'];
}
