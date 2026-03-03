/**
 * Vapi.ai Voice Call Client
 *
 * Manages voice calls via Vapi.ai API.
 * Supports Web Calls (browser link) and outbound phone calls.
 * Uses direct HTTP calls (fetch) instead of SDK to avoid adding heavy dependencies.
 *
 * Fernando Dev - CredPositivo
 */

import { config } from '../config.js';

const VAPI_BASE_URL = 'https://api.vapi.ai';

/**
 * Get default headers for Vapi API requests (private key).
 */
function getHeaders() {
  if (!config.vapi.privateKey) {
    throw new Error('[Vapi] VAPI_PRIVATE_KEY not configured');
  }
  return {
    'Authorization': `Bearer ${config.vapi.privateKey}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Get headers for Web Call API requests (public key).
 * Web calls use the public key, not the private key.
 */
function getWebCallHeaders() {
  if (!config.vapi.publicKey) {
    throw new Error('[Vapi] VAPI_PUBLIC_KEY not configured');
  }
  return {
    'Authorization': `Bearer ${config.vapi.publicKey}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Create a web call via Vapi.ai.
 * Returns a URL that the lead can open in their browser to talk to the assistant.
 *
 * Uses POST /call/web with the PUBLIC key (not private).
 *
 * @param {Object} options - Call options
 * @param {string} options.assistantId - Override default assistant
 * @param {Object} options.assistantOverrides - Override assistant config for this call
 * @param {Object} options.metadata - Custom metadata to attach to the call
 * @returns {Object} Vapi web call object with webCallUrl
 */
export async function createWebCall(options = {}) {
  const {
    assistantId = config.vapi.assistantId,
    assistantOverrides = null,
    metadata = {},
  } = options;

  if (!assistantId) {
    throw new Error('[Vapi] No assistantId configured. Set VAPI_ASSISTANT_ID or pass it in options.');
  }

  const body = {
    assistantId,
  };

  // Add assistant overrides if provided (e.g. custom first message per call)
  if (assistantOverrides) {
    body.assistantOverrides = assistantOverrides;
  }

  // Add metadata for tracking
  if (metadata && Object.keys(metadata).length > 0) {
    body.metadata = metadata;
  }

  console.log(`[Vapi] Creating web call (assistant: ${assistantId})`);

  const response = await fetch(`${VAPI_BASE_URL}/call/web`, {
    method: 'POST',
    headers: getWebCallHeaders(),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`[Vapi] Create web call failed (${response.status}): ${errorText}`);
  }

  const call = await response.json();
  console.log(`[Vapi] Web call created: id=${call.id}, url=${call.webCallUrl}, status=${call.status}`);
  return call;
}

/**
 * Create an outbound phone call via Vapi.ai.
 *
 * @param {string} phoneNumber - Customer phone in E.164 format (e.g. +5571999999999)
 * @param {Object} options - Optional overrides
 * @param {string} options.assistantId - Override default assistant
 * @param {string} options.phoneNumberId - Override default phone number
 * @param {Object} options.assistantOverrides - Override assistant config for this call
 * @param {Object} options.metadata - Custom metadata to attach to the call
 * @returns {Object} Vapi call object
 */
export async function createOutboundCall(phoneNumber, options = {}) {
  const {
    assistantId = config.vapi.assistantId,
    phoneNumberId = config.vapi.phoneNumberId,
    assistantOverrides = null,
    metadata = {},
  } = options;

  if (!assistantId) {
    throw new Error('[Vapi] No assistantId configured. Set VAPI_ASSISTANT_ID or pass it in options.');
  }

  if (!phoneNumberId) {
    throw new Error('[Vapi] No phoneNumberId configured. Set VAPI_PHONE_NUMBER_ID or pass it in options.');
  }

  // Ensure phone is in E.164 format
  const formattedPhone = formatPhoneE164(phoneNumber);

  const body = {
    assistantId,
    phoneNumberId,
    customer: {
      number: formattedPhone,
    },
  };

  // Add assistant overrides if provided (e.g. custom first message per call)
  if (assistantOverrides) {
    body.assistantOverrides = assistantOverrides;
  }

  // Add metadata for tracking
  if (metadata && Object.keys(metadata).length > 0) {
    body.metadata = metadata;
  }

  // Note: server URL is configured in Vapi dashboard, not per-call

  // Add max duration
  if (config.vapi.maxCallDurationSeconds) {
    body.maxDurationSeconds = config.vapi.maxCallDurationSeconds;
  }

  console.log(`[Vapi] Creating outbound call to ${formattedPhone} (assistant: ${assistantId})`);

  const response = await fetch(`${VAPI_BASE_URL}/call`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`[Vapi] Create call failed (${response.status}): ${errorText}`);
  }

  const call = await response.json();
  console.log(`[Vapi] Call created: id=${call.id}, status=${call.status}`);
  return call;
}

/**
 * Get call details by ID.
 *
 * @param {string} callId - Vapi call ID
 * @returns {Object} Call object with status, duration, transcript, etc.
 */
export async function getCall(callId) {
  const response = await fetch(`${VAPI_BASE_URL}/call/${callId}`, {
    method: 'GET',
    headers: getHeaders(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`[Vapi] Get call failed (${response.status}): ${errorText}`);
  }

  return response.json();
}

/**
 * List recent calls with optional filters.
 *
 * @param {Object} params - Query parameters
 * @param {number} params.limit - Max results (default 10)
 * @returns {Array} Array of call objects
 */
export async function listCalls(params = {}) {
  const query = new URLSearchParams();
  if (params.limit) query.set('limit', params.limit.toString());

  const response = await fetch(`${VAPI_BASE_URL}/call?${query}`, {
    method: 'GET',
    headers: getHeaders(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`[Vapi] List calls failed (${response.status}): ${errorText}`);
  }

  return response.json();
}

/**
 * Create or update the CredPositivo voice assistant in Vapi.
 * This is a setup function -- run once to create the assistant, then store the ID.
 *
 * @param {Object} overrides - Override default assistant config
 * @returns {Object} Created assistant object (save the .id)
 */
export async function createAssistant(overrides = {}) {
  const body = {
    name: 'Paulo - CredPositivo',
    firstMessage: 'Oi! Aqui e o Paulo, a inteligencia artificial do Grupo CredPositivo. Tudo bem? Estou te ligando porque vi que voce tem interesse em resolver sua situacao de credito. Posso falar com voce agora?',
    model: {
      provider: 'openai',
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: buildVoiceSystemPrompt(),
        },
      ],
      temperature: 0.7,
      maxTokens: 200,
    },
    voice: {
      provider: 'openai',
      voiceId: 'onyx',
    },
    transcriber: {
      provider: 'deepgram',
      model: 'nova-2',
      language: 'pt-BR',
    },
    firstMessageMode: 'assistant-speaks-first',
    silenceTimeoutSeconds: 30,
    maxDurationSeconds: config.vapi.maxCallDurationSeconds || 300,
    endCallMessage: 'Foi um prazer conversar com voce. Qualquer duvida, me chama no WhatsApp. Ate mais!',
    ...overrides,
  };

  if (config.vapi.serverUrl) {
    body.serverUrl = config.vapi.serverUrl;
  }

  console.log('[Vapi] Creating assistant...');

  const response = await fetch(`${VAPI_BASE_URL}/assistant`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`[Vapi] Create assistant failed (${response.status}): ${errorText}`);
  }

  const assistant = await response.json();
  console.log(`[Vapi] Assistant created: id=${assistant.id}, name=${assistant.name}`);
  return assistant;
}

/**
 * Build the system prompt for the voice assistant.
 * Adapted from the text-based prompt for voice interactions (Paulo).
 */
function buildVoiceSystemPrompt() {
  return `Voce e o Paulo, a inteligencia artificial do Grupo CredPositivo. Voce esta em uma chamada de voz. Seu nome e Paulo, NUNCA diga Augusto.

REGRAS DE VOZ:
- Fale de forma natural e conversacional, como uma pessoa real ao telefone
- Frases curtas (max 2 frases por vez). Espere a pessoa responder.
- Use linguagem simples e acessivel. Nada de termos tecnicos.
- Seja empatetico e acolhedor. A pessoa pode estar em situacao dificil.
- NUNCA prometa aprovacao de credito ou aumento de score
- NUNCA invente dados sobre a situacao do lead
- Chame pelo nome quando souber

OBJETIVO DA CHAMADA:
- Se for checkout abandonado: Entender por que nao finalizou. Ajudar com duvidas. Reforcar o valor.
- Se for diagnostico complexo: Explicar resultado de forma simples. Recomendar proximo passo.

PRODUTOS (mencione apenas se relevante):
- Diagnostico de Credito: 67 reais (analise completa do perfil)
- Limpa Nome: 397 reais (negociacao de dividas, ate 15 dias uteis)
- Rating Bancario: 997 reais (inclui limpa nome + reconstrucao de perfil, ate 20 dias uteis)

COMO CONDUZIR:
1. Se apresente brevemente como Paulo, a IA do Grupo CredPositivo
2. Confirme se pode falar agora
3. Va direto ao ponto (razao da chamada)
4. Escute mais do que fale
5. Responda duvidas com clareza
6. Direcione para o site para finalizar (www.credpositivo.com)
7. Encerre educadamente

Se a pessoa disser que nao pode falar, agradeca e diga que vai mandar mensagem no WhatsApp.
Se a pessoa pedir para parar, encerre educadamente.`;
}

/**
 * Format Brazilian phone number to E.164 format for Vapi.
 * Input: 5571999999999 or 71999999999 or +5571999999999
 * Output: +5571999999999
 */
function formatPhoneE164(phone) {
  let clean = phone.replace(/\D/g, '');

  // If starts with 55, add +
  if (clean.startsWith('55') && clean.length >= 12) {
    return `+${clean}`;
  }

  // If doesn't start with country code, add +55
  if (!clean.startsWith('55')) {
    clean = `55${clean}`;
  }

  return `+${clean}`;
}

/**
 * Check if Vapi is properly configured and enabled for web calls.
 * Web calls require publicKey + assistantId (no phoneNumberId needed).
 */
export function isVapiEnabled() {
  return !!(
    config.vapi.enabled &&
    config.vapi.publicKey &&
    config.vapi.assistantId
  );
}

/**
 * Check if Vapi is configured for outbound PSTN calls.
 * Outbound calls require privateKey + assistantId + phoneNumberId.
 */
export function isVapiOutboundEnabled() {
  return !!(
    config.vapi.enabled &&
    config.vapi.privateKey &&
    config.vapi.assistantId &&
    config.vapi.phoneNumberId
  );
}
