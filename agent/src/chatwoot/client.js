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
