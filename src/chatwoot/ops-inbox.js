/**
 * ops-inbox.js — Utilitário para postar relatórios no inbox "Operações" do Chatwoot.
 *
 * Substitui todos os envios de relatórios para grupos de WhatsApp.
 * Cada chamada a postToOpsInbox() cria uma nova conversa no inbox Operações
 * com o título e conteúdo do relatório.
 */

import { config } from '../config.js';

const { apiUrl, apiToken, accountId } = config.chatwoot;
const OPS_INBOX_ID = parseInt(process.env.CHATWOOT_OPS_INBOX_ID || '3');
const baseUrl = `${apiUrl}/api/v1/accounts/${accountId}`;

const SYSTEM_CONTACT_EMAIL = 'sistema@credpositivo.com';
const SYSTEM_CONTACT_NAME = 'Sistema CredPositivo';

let _systemContactId = null; // cache em memória
let _lastErrorLog = 0; // throttle error logs (max 1 per 10 min)
const ERROR_LOG_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Ensure the contact has a contact_inbox association for OPS_INBOX_ID.
 */
async function ensureContactInbox(contactId) {
  try {
    // List existing contact_inboxes
    const listRes = await fetch(`${baseUrl}/contacts/${contactId}/contact_inboxes`, {
      headers: { 'api_access_token': apiToken },
    });
    if (listRes.ok) {
      const data = await listRes.json();
      const inboxes = data.payload || data;
      const hasInbox = Array.isArray(inboxes) && inboxes.some(ci => ci.inbox?.id === OPS_INBOX_ID || ci.inbox_id === OPS_INBOX_ID);
      if (hasInbox) return true;
    }

    // Create the association
    const createRes = await fetch(`${baseUrl}/contacts/${contactId}/contact_inboxes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api_access_token': apiToken,
      },
      body: JSON.stringify({ inbox_id: OPS_INBOX_ID }),
    });
    if (createRes.ok) {
      console.log(`[OpsInbox] Contact_inbox association created for contact ${contactId} → inbox ${OPS_INBOX_ID}`);
      return true;
    }
    // 422 usually means it already exists — that's fine
    if (createRes.status === 422) return true;

    const errBody = await createRes.text();
    console.warn(`[OpsInbox] Failed to create contact_inbox (HTTP ${createRes.status}): ${errBody.slice(0, 200)}`);
    return false;
  } catch (err) {
    console.warn(`[OpsInbox] ensureContactInbox error: ${err.message}`);
    return false;
  }
}

/**
 * Retorna o ID do contato "Sistema CredPositivo", criando-o se não existir.
 */
async function getSystemContactId() {
  if (_systemContactId) return _systemContactId;

  // Buscar por email
  const searchRes = await fetch(
    `${baseUrl}/contacts/search?q=${encodeURIComponent(SYSTEM_CONTACT_EMAIL)}&include_contacts=true`,
    { headers: { 'api_access_token': apiToken } }
  );
  const searchData = await searchRes.json();
  const existing = searchData.payload?.find(c => c.email === SYSTEM_CONTACT_EMAIL);

  if (existing) {
    _systemContactId = existing.id;
    // Ensure contact_inbox association exists
    await ensureContactInbox(_systemContactId);
    return _systemContactId;
  }

  // Criar contato sistema
  const createRes = await fetch(`${baseUrl}/contacts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api_access_token': apiToken,
    },
    body: JSON.stringify({
      name: SYSTEM_CONTACT_NAME,
      email: SYSTEM_CONTACT_EMAIL,
      inbox_id: OPS_INBOX_ID,
    }),
  });
  const created = await createRes.json();
  _systemContactId = created.payload?.contact?.id || created.id;
  console.log(`[OpsInbox] Contato sistema criado: id=${_systemContactId}`);
  return _systemContactId;
}

/**
 * Throttled error logger — avoids spamming logs every 10 minutes.
 */
function logErrorThrottled(message, detail) {
  const now = Date.now();
  if (now - _lastErrorLog < ERROR_LOG_INTERVAL_MS) return;
  _lastErrorLog = now;
  console.error(message, detail || '');
}

/**
 * Posta um relatório no inbox "Operações" do Chatwoot.
 *
 * Cria uma nova conversa com o título do relatório e envia o conteúdo como mensagem.
 *
 * @param {string} title - Título do relatório (ex: "Luan — Relatório Diário")
 * @param {string} content - Conteúdo do relatório (texto markdown ou plain text)
 * @param {Object} [options]
 * @param {string[]} [options.labels] - Labels para adicionar à conversa
 * @returns {Promise<{conversationId: number}|null>}
 */
export async function postToOpsInbox(title, content, options = {}) {
  try {
    const contactId = await getSystemContactId();
    if (!contactId) {
      logErrorThrottled('[OpsInbox] Não foi possível obter contato sistema');
      return null;
    }

    // Create conversation, with retry on "Resource could not be found"
    const conversationId = await createConversationWithRetry(contactId, title);

    if (!conversationId) {
      logErrorThrottled('[OpsInbox] Falha ao criar conversa após retry');
      return null;
    }

    // Postar o relatório como mensagem de saída privada
    const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const fullContent = `📋 *${title}*\n⏰ ${now}\n\n${content}`;
    await fetch(`${baseUrl}/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api_access_token': apiToken,
      },
      body: JSON.stringify({
        content: fullContent,
        message_type: 'outgoing',
        private: false,
        content_type: 'text',
      }),
    });

    // Adicionar labels se fornecidas
    if (options.labels?.length) {
      await fetch(`${baseUrl}/conversations/${conversationId}/labels`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api_access_token': apiToken,
        },
        body: JSON.stringify({ labels: options.labels }),
      });
    }

    console.log(`[OpsInbox] Relatório postado: "${title}" → conversa #${conversationId}`);
    return { conversationId };
  } catch (err) {
    // Nunca quebra o fluxo principal — throttle error logs
    logErrorThrottled('[OpsInbox] Erro ao postar relatório:', err.message);
    return null;
  }
}

/**
 * Attempts to create a conversation. If it fails with "Resource could not be found",
 * clears the cached contact ID, re-fetches/re-creates the contact, ensures
 * contact_inbox association, and retries once.
 */
async function createConversationWithRetry(contactId, title) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const convRes = await fetch(`${baseUrl}/conversations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api_access_token': apiToken,
      },
      body: JSON.stringify({
        contact_id: contactId,
        inbox_id: OPS_INBOX_ID,
        source_id: `ops_${Date.now()}`,
        status: 'open',
        additional_attributes: { title },
      }),
    });
    const conv = await convRes.json();

    if (conv.id) return conv.id;

    // Check if it's a "Resource could not be found" error
    const errStr = JSON.stringify(conv);
    if (attempt === 0 && errStr.includes('could not be found')) {
      console.warn(`[OpsInbox] Resource not found on attempt 1. Clearing cache and retrying...`);
      // Clear cached contact, re-resolve
      _systemContactId = null;
      const newContactId = await getSystemContactId();
      if (!newContactId) return null;
      // Ensure association before retry
      await ensureContactInbox(newContactId);
      contactId = newContactId;
      continue;
    }

    logErrorThrottled('[OpsInbox] Falha ao criar conversa:', errStr.slice(0, 200));
    return null;
  }
  return null;
}
