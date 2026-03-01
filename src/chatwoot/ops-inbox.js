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
      console.error('[OpsInbox] Não foi possível obter contato sistema');
      return null;
    }

    // Criar conversa no inbox Operações
    const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
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
    const conversationId = conv.id;

    if (!conversationId) {
      console.error('[OpsInbox] Falha ao criar conversa:', JSON.stringify(conv).slice(0, 200));
      return null;
    }

    // Postar o relatório como mensagem de saída privada
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
    // Nunca quebra o fluxo principal
    console.error('[OpsInbox] Erro ao postar relatório:', err.message);
    return null;
  }
}
