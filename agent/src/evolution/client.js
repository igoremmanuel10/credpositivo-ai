import { config } from '../config.js';

const { apiUrl, apiKey, instance } = config.evolution;

// --- Connection state cache ---
let lastConnectionCheck = 0;
let lastConnectionState = null;
const CONNECTION_CHECK_TTL = 30_000; // 30s

/**
 * Extract plain phone number from JID.
 * "5511932145806@s.whatsapp.net" → "5511932145806"
 * "5511932145806" → "5511932145806"
 */
function extractNumber(jidOrNumber) {
  return jidOrNumber.replace(/@.*$/, '');
}

/**
 * Check if the Evolution instance is connected.
 * Caches result for 30s to avoid hammering the API.
 * Returns { connected: boolean, state: string }
 */
export async function checkConnection() {
  const now = Date.now();
  if (lastConnectionState && now - lastConnectionCheck < CONNECTION_CHECK_TTL) {
    return lastConnectionState;
  }

  const url = `${apiUrl}/instance/connectionState/${instance}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { apikey: apiKey },
    });

    const body = await res.json();
    const state = (body?.state || body?.instance?.state || '').toLowerCase();
    const connected = state === 'open' || state === 'connected';

    lastConnectionState = { connected, state, raw: body };
    lastConnectionCheck = now;

    if (!connected) {
      console.error(`[Evolution] Instance "${instance}" NOT connected. State: ${state}`, JSON.stringify(body));
    } else {
      console.log(`[Evolution] Instance "${instance}" connected (state: ${state})`);
    }

    return lastConnectionState;
  } catch (err) {
    console.error(`[Evolution] Connection check failed:`, err.message);
    lastConnectionState = { connected: false, state: 'error', raw: err.message };
    lastConnectionCheck = now;
    return lastConnectionState;
  }
}

/**
 * Invalidate connection cache (call after reconnect events).
 */
export function invalidateConnectionCache() {
  lastConnectionCheck = 0;
  lastConnectionState = null;
}

/**
 * Core HTTP request to Evolution API with detailed logging.
 */
async function request(method, path, body = null) {
  const url = `${apiUrl}${path}`;
  const reqId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  console.log(`[Evolution][${reqId}] ${method} ${url}`);
  if (body) {
    const logBody = { ...body };
    if (logBody.text && logBody.text.length > 200) {
      logBody.text = logBody.text.substring(0, 200) + '...[truncated]';
    }
    console.log(`[Evolution][${reqId}] Payload:`, JSON.stringify(logBody));
  }

  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      apikey: apiKey,
    },
  };
  if (body) options.body = JSON.stringify(body);

  const startMs = Date.now();
  let res;
  try {
    res = await fetch(url, options);
  } catch (err) {
    console.error(`[Evolution][${reqId}] Network error after ${Date.now() - startMs}ms:`, err.message);
    throw err;
  }

  const elapsed = Date.now() - startMs;
  const responseText = await res.text();

  console.log(`[Evolution][${reqId}] Response ${res.status} (${elapsed}ms): ${responseText.substring(0, 500)}`);

  if (!res.ok) {
    throw new Error(`Evolution API ${res.status}: ${responseText}`);
  }

  try {
    return JSON.parse(responseText);
  } catch {
    return { raw: responseText };
  }
}

/**
 * Send a text message via WhatsApp.
 * @param {string} remoteJid - Full JID from webhook (e.g. "5571999999999@s.whatsapp.net")
 * @param {string} text - Message content
 * @returns {Object} Evolution API response (contains key.id = message ID)
 */
export async function sendText(remoteJid, text) {
  const conn = await checkConnection();
  if (!conn.connected) {
    console.error(`[Evolution] BLOCKED sendText to ${remoteJid} — instance not connected (${conn.state})`);
    throw new Error(`Cannot send: instance "${instance}" is ${conn.state}`);
  }

  // Use plain number — sending with @s.whatsapp.net causes error 463
  // on newer WhatsApp protocol versions (LID migration)
  const number = extractNumber(remoteJid);

  const payload = {
    number,
    options: {
      delay: 1200,
      presence: 'composing',
      linkPreview: false,
    },
    text,
  };

  const result = await request('POST', `/message/sendText/${instance}`, payload);

  if (result?.key?.id) {
    console.log(`[Evolution] Message sent OK. key.id=${result.key.id} → ${number}`);
  }

  return result;
}

/**
 * Send a document (PDF) via WhatsApp.
 * @param {string} remoteJid - Full JID from webhook
 */
export async function sendDocument(remoteJid, mediaUrl, caption, fileName) {
  const conn = await checkConnection();
  if (!conn.connected) {
    console.error(`[Evolution] BLOCKED sendDocument to ${remoteJid} — instance not connected (${conn.state})`);
    throw new Error(`Cannot send: instance "${instance}" is ${conn.state}`);
  }

  const number = extractNumber(remoteJid);

  const payload = {
    number,
    mediatype: 'document',
    media: mediaUrl,
    caption,
    fileName: fileName || 'documento.pdf',
  };

  const result = await request('POST', `/message/sendMedia/${instance}`, payload);

  if (result?.key?.id) {
    console.log(`[Evolution] Document sent OK. key.id=${result.key.id} → ${number}`);
  }

  return result;
}

/**
 * Show "typing..." indicator.
 */
export async function setTyping(remoteJid) {
  return; // desliga por enquanto
}

/**
 * Send multiple messages with delays between them (WhatsApp style).
 * Splits on double newline to create separate bubbles.
 * @param {string} remoteJid - Full JID (e.g. "5571999999999@s.whatsapp.net")
 * @param {string} fullText - Full response text
 * @returns {string[]} Array of message key IDs for ACK tracking
 */
export async function sendMessages(remoteJid, fullText) {
  const bubbles = fullText
    .split(/\n\n+/)
    .map(b => b.trim())
    .filter(Boolean);

  const messageIds = [];

  for (let i = 0; i < bubbles.length; i++) {
    if (i > 0) {
      await setTyping(remoteJid);
      const delay = Math.min(Math.max(bubbles[i].length * 30, 1000), 3000);
      await new Promise(r => setTimeout(r, delay));
    }
    const result = await sendText(remoteJid, bubbles[i]);
    if (result?.key?.id) {
      messageIds.push(result.key.id);
    }
  }

  console.log(`[Evolution] Sent ${bubbles.length} bubbles to ${remoteJid}. IDs: [${messageIds.join(', ')}]`);
  return messageIds;
}
