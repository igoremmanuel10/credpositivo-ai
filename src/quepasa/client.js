import { config } from '../config.js';

const { apiUrl, botToken } = config.quepasa;

const MESSAGE_DELAY_MS = 4000; // 4 seconds between bubbles

// Cache: maps wid prefix (phone number) to bot token
const widTokenMap = new Map();

/**
 * Initialize the wid-to-token mapping by querying each bot's info.
 */
export async function initTokenMapping() {
  for (const token of config.quepasa.botTokens) {
    try {
      const res = await fetch(`${apiUrl}/v3/bot/${token}`, {
        headers: { 'Accept': 'application/json' },
      });
      const data = await res.json();
      if (data.success && data.server?.wid) {
        const phone = data.server.wid.split(':')[0];
        widTokenMap.set(phone, token);
        console.log(`[Quepasa] Token mapped: ${phone} → ${token.substring(0, 8)}...`);
      }
    } catch (err) {
      console.error(`[Quepasa] Failed to map token ${token.substring(0, 8)}:`, err.message);
    }
  }
}

/**
 * Get the bot token for a given wid (WhatsApp ID).
 * Falls back to default botToken if not found.
 */
export function getTokenForWid(wid) {
  if (!wid) return botToken;
  const phone = wid.split(':')[0];
  return widTokenMap.get(phone) || botToken;
}

/**
 * Get all available bot tokens except the given one.
 */
function getAlternativeTokens(excludeToken) {
  return (config.quepasa.botTokens || []).filter(t => t !== excludeToken);
}

/**
 * Strip markdown formatting (asterisks) from text for WhatsApp.
 */
function stripMarkdown(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')  // **bold** → bold
    .replace(/\*(.+?)\*/g, '$1')       // *italic* → italic
    .replace(/__(.+?)__/g, '$1')       // __underline__ → underline
    .replace(/_(.+?)_/g, '$1');        // _italic_ → italic
}

/**
 * Send composing (typing) presence to a chat.
 */
async function sendPresence(chatId, token = null) {
  const useToken = token || botToken;
  try {
    const url = `${apiUrl}/chat/presence`;
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-QUEPASA-TOKEN': useToken,
      },
      body: JSON.stringify({ chatId, state: 'composing' }),
    });
  } catch (err) {
    console.warn('[Quepasa] Presence error (non-fatal):', err.message);
  }
}

/**
 * Internal send — no fallback, just sends.
 */
async function sendTextRaw(chatId, text, token) {
  const url = `${apiUrl}/send`;
  const cleanText = stripMarkdown(text);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-QUEPASA-TOKEN': token,
      'X-QUEPASA-CHATID': chatId,
      'X-QUEPASA-TRACKID': `agent-${Date.now()}`,
    },
    body: JSON.stringify({ text: cleanText }),
  });

  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

/**
 * Send a text message via Quepasa/WhatsApp.
 * Automatically falls back to alternative tokens on error 463.
 */
export async function sendText(chatId, text, token = null) {
  const useToken = token || botToken;

  const result = await sendTextRaw(chatId, text, useToken);
  console.log(`[Quepasa] sendText to ${chatId}: ${result.status} - ${result.body.substring(0, 200)}`);

  if (!result.ok) {
    // On error 463 (encryption session issue), try alternative tokens
    if (result.body.includes('error 463')) {
      const alternatives = getAlternativeTokens(useToken);
      for (const altToken of alternatives) {
        console.warn(`[Quepasa] Error 463 on primary token, trying fallback token ${altToken.substring(0, 8)}...`);
        try {
          const altResult = await sendTextRaw(chatId, text, altToken);
          console.log(`[Quepasa] Fallback sendText to ${chatId}: ${altResult.status} - ${altResult.body.substring(0, 200)}`);
          if (altResult.ok) {
            try { return JSON.parse(altResult.body); } catch { return { raw: altResult.body }; }
          }
        } catch (fallbackErr) {
          console.error(`[Quepasa] Fallback token also failed:`, fallbackErr.message);
        }
      }
    }
    throw new Error(`Quepasa send failed ${result.status}: ${result.body}`);
  }

  try {
    return JSON.parse(result.body);
  } catch {
    return { raw: result.body };
  }
}

/**
 * Send a media file via URL through Quepasa/WhatsApp.
 */
export async function sendMedia(chatId, mediaUrl, caption = '', token = null) {
  const useToken = token || botToken;
  const url = `${apiUrl}/send`;

  const payload = { url: mediaUrl };
  if (caption) payload.text = stripMarkdown(caption);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-QUEPASA-TOKEN': useToken,
      'X-QUEPASA-CHATID': chatId,
      'X-QUEPASA-TRACKID': `agent-media-${Date.now()}`,
    },
    body: JSON.stringify(payload),
  });

  const body = await res.text();
  console.log(`[Quepasa] sendMedia to ${chatId}: ${res.status} - ${body.substring(0, 200)}`);

  if (!res.ok) {
    throw new Error(`Quepasa sendMedia failed ${res.status}: ${body}`);
  }

  try {
    return JSON.parse(body);
  } catch {
    return { raw: body };
  }
}

/**
 * Send a media file via base64 content through Quepasa/WhatsApp.
 */
export async function sendMediaBase64(chatId, base64Content, caption = '', fileName = 'file', token = null) {
  const useToken = token || botToken;
  const url = `${apiUrl}/send`;

  const payload = { content: base64Content, fileName };
  if (caption) payload.text = stripMarkdown(caption);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-QUEPASA-TOKEN': useToken,
      'X-QUEPASA-CHATID': chatId,
      'X-QUEPASA-TRACKID': `agent-media-${Date.now()}`,
    },
    body: JSON.stringify(payload),
  });

  const body = await res.text();
  console.log(`[Quepasa] sendMediaBase64 to ${chatId}: ${res.status} - ${body.substring(0, 200)}`);

  if (!res.ok) {
    throw new Error(`Quepasa sendMediaBase64 failed ${res.status}: ${body}`);
  }

  try {
    return JSON.parse(body);
  } catch {
    return { raw: body };
  }
}

/**
 * Download media from Quepasa by message ID.
 */
export async function downloadMedia(messageId, token = null) {
  const useToken = token || botToken;
  const url = `${apiUrl}/v3/bot/${useToken}/download/${messageId}`;

  const res = await fetch(url, {
    headers: { 'X-QUEPASA-TOKEN': useToken },
  });

  if (!res.ok) {
    throw new Error(`Download failed ${res.status}: ${await res.text()}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Send a single message with typing indicator.
 * No longer splits by \n\n — sends everything as ONE bubble.
 */
export async function sendMessages(chatId, fullText, token = null) {
  const cleanText = stripMarkdown(fullText)
    .replace(/\n{3,}/g, '\n\n')  // collapse excessive newlines
    .trim();

  if (!cleanText) return [];

  // Send typing indicator
  await sendPresence(chatId, token);
  await new Promise(r => setTimeout(r, 1500));

  const result = await sendText(chatId, cleanText, token);
  console.log(`[Quepasa] Sent 1 message to ${chatId} (no split)`);
  return [result];
}

/**
 * Resolve a phone number to its WhatsApp JID via Quepasa's /isonwhatsapp.
 */
export async function resolveWhatsAppId(phone, token = null) {
  const useToken = token || botToken;
  try {
    const res = await fetch(`${apiUrl}/isonwhatsapp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-QUEPASA-TOKEN': useToken,
      },
      body: JSON.stringify([phone]),
    });
    const data = await res.json();
    if (data.success && data.registered && data.registered.length > 0) {
      console.log(`[Quepasa] Resolved ${phone} → ${data.registered[0]}`);
      return data.registered[0];
    }
    console.log(`[Quepasa] Phone ${phone} not found on WhatsApp`);
    return null;
  } catch (err) {
    console.error(`[Quepasa] resolveWhatsAppId error for ${phone}:`, err.message);
    return null;
  }
}

/**
 * Get bot info/status.
 */
export async function getBotInfo() {
  const res = await fetch(`${apiUrl}/info`, {
    headers: {
      'Accept': 'application/json',
      'X-QUEPASA-TOKEN': botToken,
    },
  });
  return res.json();
}
