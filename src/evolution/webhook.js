import { Router } from 'express';
import { normalizePhone } from '../utils/phone.js';
import { handleIncomingMessage } from '../conversation/manager.js';
import { sendText as quepasaSendText, getTokenForWid, downloadMedia, resolveWhatsAppId } from '../quepasa/client.js';
import { transcribeAudio } from '../audio/transcribe.js';
import { analyzeImage } from '../ai/claude.js';
import { config } from '../config.js';
import {
  findOrCreateContact,
  findOrCreateConversation,
  getInboxForPhone,
  sendMessage as chatwootSendMessage,
  sendOutgoingMessage as chatwootSendOutgoing,
} from '../chatwoot/client.js';
import { trackBridgeActivity, trackBridgeError } from '../bridge-health.js';
import { handleGroupMessage, FINANCEIRO_GROUP_JID } from '../expense/tracker.js';
import { handleCoachingMessage, COACHING_GROUP_JID } from '../coaching/protocol.js';
import { handleAdmGroupMessage, ADM_GROUP_JID } from '../agenda/manager.js';
import { db } from '../db/client.js';
import { handleIncomingDispatchReply } from '../dispatch/reply-detector.js';

export const webhookRouter = Router();
// === SMART CIRCUIT BREAKER ===
// Protects against reconnection floods while allowing legitimate ad leads through.
// 4 layers: system filter, sync filter, flood detection, lead filter.
const circuitBreaker = {
  windowMs: 30 * 1000,       // 30s sliding window
  maxNoAdsInWindow: 10,      // max 10 non-ads messages per window
  noAdsTimestamps: [],       // timestamps of non-ads messages
  paused: false,
  pauseUntil: 0,
  pauseDurationMs: 120 * 1000, // 2 min pause if triggered

  // Returns true if message should be BLOCKED
  check(hasAds) {
    const now = Date.now();

    // If paused, block non-ads messages
    if (this.paused && now < this.pauseUntil) {
      if (hasAds) return false; // Ads leads always pass
      console.log("[CircuitBreaker] PAUSED - blocking non-ads message");
      return true;
    }
    if (this.paused && now >= this.pauseUntil) {
      this.paused = false;
      console.log("[CircuitBreaker] Pause expired, resuming");
    }

    // Ads messages always pass, no counting
    if (hasAds) return false;

    // Slide window: remove old timestamps
    this.noAdsTimestamps = this.noAdsTimestamps.filter(t => (now - t) < this.windowMs);
    this.noAdsTimestamps.push(now);

    // Trip breaker if too many non-ads messages
    if (this.noAdsTimestamps.length > this.maxNoAdsInWindow) {
      this.paused = true;
      this.pauseUntil = now + this.pauseDurationMs;
      console.error("[CircuitBreaker] TRIPPED! " + this.noAdsTimestamps.length + " non-ads msgs in 30s. Pausing 2min.");
      return true;
    }
    return false;
  }
};

function isSyncMessage(msg, text, pushName) {
  if (msg.type === "system") return true;
  // Text is exactly the pushName or chat title = contact sync, not a real message
  if (text && pushName && text.trim() === pushName.trim()) return true;
  const chatTitle = msg.chat?.title || "";
  if (text && chatTitle && text.trim() === chatTitle.trim()) return true;
  return false;
}


/**
 * Check if a phone number is in the blocklist (personal contacts).
 * Returns true if the number is BLOCKED.
 */
async function isBlockedPhone(phone) {
  try {
    const { rows } = await db.query(
      'SELECT phone FROM phone_blocklist WHERE phone = $1 LIMIT 1',
      [phone]
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Detect MIME type from Quepasa message attachment or type field.
 */
function detectMimeType(msg) {
  const mime = msg.attachment?.mime || msg.mimetype || '';
  if (mime) return mime;
  // Fallback based on type
  const type = msg.type || '';
  if (type === 'image') return 'image/jpeg';
  if (type === 'video') return 'video/mp4';
  return 'application/octet-stream';
}

// ============================================
// QUEPASA DISPATCH WEBHOOK — isolado pro 2º número do disparador (Igor).
// Só detecta resposta/opt-out pra marcar o lead no banco.
// NÃO marca como lida, NÃO chama Augusto, NÃO faz nada mais.
// ============================================
webhookRouter.post('/webhook/quepasa-dispatch', async (req, res) => {
  res.status(200).json({ status: 'received' });
  try {
    const msg = req.body || {};
    const isFromMe = msg.fromMe || msg.from_me || msg.fromme;
    if (isFromMe) return;
    const chatId = msg.chat?.id || msg.chatId || msg.source || '';
    if (!chatId || chatId.endsWith('@g.us')) return;
    const rawPhone = msg.chat?.phone?.replace(/^\+/, '') || chatId.replace(/@.*$/, '');
    const phone = normalizePhone(rawPhone);
    if (!phone) return;
    const text = msg.text || msg.body || msg.message?.text || msg.message?.conversation || '';
    console.log(`[Dispatch Webhook] Reply from ${phone}: ${String(text).substring(0, 100)}`);

    // Undo Quepasa auto-read (READUPDATE=true at server level) by marking
    // chat back as unread. So the operator sees the unread badge on the phone.
    const token = process.env.DISPATCH_QUEPASA_TOKEN || '';
    const qpUrl = process.env.QUEPASA_API_URL || 'http://quepasa:31000';
    if (token) {
      fetch(`${qpUrl}/chat/markunread`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-QUEPASA-TOKEN': token,
        },
        body: JSON.stringify({ chatid: chatId }),
      }).catch((err) => console.warn('[Dispatch Webhook] markunread failed:', err.message));
    }

    handleIncomingDispatchReply(phone, text).catch(() => {});
  } catch (err) {
    console.warn('[Dispatch Webhook] error:', err.message);
  }
});

// ============================================
// QUEPASA WEBHOOK - WhatsApp messages arrive here
// ============================================
webhookRouter.post('/webhook/quepasa', async (req, res) => {
  res.status(200).json({ status: 'received' });

  try {
    const msg = req.body;
    console.log('[Quepasa Webhook]', JSON.stringify(msg).substring(0, 500));

    // Extract message type early (needed for fromme bug workaround)
    const msgType = msg.type || '';

    // Ignore messages from bot itself
    // WORKAROUND: Quepasa has a bug where incoming audio from users is marked as fromme:true.
    // For audio messages, we skip the fromme check and use trackId to filter our own TTS audio.
    const isFromMe = msg.fromMe || msg.from_me || msg.fromme;
    if (isFromMe && msgType !== 'audio' && msgType !== 'ptt') return;

    // For audio: skip if it's our own TTS audio (has trackId or filename starting with audio_)
    if (isFromMe && (msgType === 'audio' || msgType === 'ptt')) {
      const trackId = msg.trackId || msg.track_id || '';
      const fileName = msg.attachment?.filename || '';
      if (trackId.startsWith('agent-') || fileName.startsWith('audio_')) {
        return; // This is our own TTS audio, ignore
      }
      console.log('[Quepasa] Audio with fromme:true but no agent trackId — treating as incoming user audio');
    }

    // ── GROUP MESSAGE ROUTING ──────────────────────────────────────────────
    // Detect WhatsApp group messages (@g.us suffix on chat ID).
    // Route Financeiro group to expense tracker; drop all other group messages
    // so they never reach the AI conversation manager or Chatwoot bridge.
    const incomingChatId = msg.chat?.id || msg.chatId || msg.source || '';
    if (incomingChatId.endsWith('@g.us')) {
      if (incomingChatId === FINANCEIRO_GROUP_JID) {
        handleGroupMessage(msg).catch(err => {
          console.error('[ExpenseTracker] Unhandled error in handleGroupMessage:', err);
        });
      } else if (COACHING_GROUP_JID && incomingChatId === COACHING_GROUP_JID) {
        handleCoachingMessage(msg).catch(err => {
          console.error('[Coaching] Unhandled error in handleCoachingMessage:', err);
        });
      } else if (ADM_GROUP_JID && incomingChatId === ADM_GROUP_JID) {
        handleAdmGroupMessage(msg).catch(err => {
          console.error('[Agenda] Unhandled error in handleAdmGroupMessage:', err);
        });
      } else {
        console.log(`[Quepasa Webhook] Group message from ${incomingChatId} ignored`);
      }
      // Either way, do NOT continue to individual-chat processing
      return;
    }
    // ── END GROUP ROUTING ──────────────────────────────────────────────────

    // Extract message text or transcribe audio
    let text = msg.text || msg.body || msg.message?.text || msg.message?.conversation || '';

    // --- AUDIO: transcribe via Whisper ---
    if (!text && (msgType === 'audio' || msgType === 'ptt') && msg.id) {
      try {
        const audioWid = msg.wid || '';
        const audioToken = getTokenForWid(audioWid);
        console.log(`[Quepasa] Audio message received, transcribing ${msg.id} (wid: ${audioWid.substring(0, 15)})...`);
        text = await transcribeAudio(msg.id, audioToken);
        if (!text) {
          console.log('[Quepasa] Audio transcription returned empty');
          return;
        }
        console.log(`[Quepasa] Audio transcribed: ${text.substring(0, 200)}`);
      } catch (err) {
        console.error('[Quepasa] Audio transcription failed:', err.message);
        return;
      }
    }

    // --- IMAGE: analyze via GPT-4o Vision ---
    if (!text && msgType === 'image' && msg.id && config.media.enabled) {
      try {
        console.log(`[Quepasa] Image message received, analyzing ${msg.id}...`);
        const mediaBuffer = await downloadMedia(msg.id);
        const base64 = mediaBuffer.toString('base64');
        const mime = detectMimeType(msg);
        const description = await analyzeImage(base64, mime);
        if (description) {
          text = `[Lead enviou uma foto: ${description}]`;
          console.log(`[Quepasa] Image analyzed: ${description.substring(0, 200)}`);
        } else {
          text = '[Lead enviou uma foto que não foi possível analisar]';
        }
      } catch (err) {
        console.error('[Quepasa] Image analysis failed:', err.message);
        text = '[Lead enviou uma foto, mas houve erro ao analisar]';
      }
    }

    // --- VIDEO: analyze thumbnail via GPT-4o Vision ---
    if (!text && msgType === 'video' && config.media.enabled) {
      try {
        console.log(`[Quepasa] Video message received from ${msg.id || 'unknown'}...`);
        // Try to use thumbnail from attachment (Quepasa provides it)
        const thumbnail = msg.attachment?.thumbnail || msg.message?.imageMessage?.jpegThumbnail || '';
        if (thumbnail) {
          const description = await analyzeImage(thumbnail, 'image/jpeg');
          if (description) {
            text = `[Lead enviou um vídeo: ${description}]`;
            console.log(`[Quepasa] Video thumbnail analyzed: ${description.substring(0, 200)}`);
          } else {
            text = '[Lead enviou um vídeo]';
          }
        } else if (msg.id) {
          // No thumbnail available, try downloading the video and extracting a frame
          // For now, just acknowledge the video
          text = '[Lead enviou um vídeo]';
          console.log('[Quepasa] Video received but no thumbnail available');
        }
      } catch (err) {
        console.error('[Quepasa] Video analysis failed:', err.message);
        text = '[Lead enviou um vídeo, mas houve erro ao analisar]';
      }
    }

    if (!text) return;

    // Extract sender info
    const chatId = msg.chat?.id || msg.chatId || msg.source || '';
    if (!chatId) return;

    // Use chat.phone if available (for LID contacts), fallback to chatId
    const rawPhone = msg.chat?.phone?.replace(/^\+/, '') || chatId.replace(/@.*$/, '');
    const phone = normalizePhone(rawPhone);
    if (!phone) return;

    const pushName = msg.chat?.title || msg.senderName || msg.pushName || '';

    // Resolve which bot token should be used for replies (multi-number support)
    const wid = msg.wid || '';
    const botTokenForReply = getTokenForWid(wid);

    console.log(`[Quepasa] Message from ${phone} (${pushName}) via wid ${wid ? wid.substring(0, 15) : 'unknown'}: ${text.substring(0, 100)}`);

    // Dispatch reply detector — if this phone is in a dispatched quiz_lead, mark status
    handleIncomingDispatchReply(phone, text).catch(() => {});

    // LAYER 1: System messages (logout, reconnect, etc.) — never process
    if (msg.type === 'system') {
      console.log('[Filter:L1] System message ignored: ' + (msg.text || '').substring(0, 80));
      return;
    }

    // LAYER 2: Sync messages (text = contact name) — never process
    if (isSyncMessage(msg, text, pushName)) {
      console.log('[Filter:L2] Sync message ignored from ' + phone);
      return;
    }

    // LAYER 3: Circuit breaker — ads leads always pass, non-ads rate limited
    const hasAds = !!(msg.ads && msg.ads.id);
    if (circuitBreaker.check(hasAds)) {
      console.log('[Filter:L3] Circuit breaker blocked ' + phone);
      return;
    }

    // LAYER 4: Blocklist — block personal contacts, allow everyone else
    if (await isBlockedPhone(phone)) {
      console.log('[Filter:L4] Blocked personal contact: ' + phone);
      return;
    }

    // Track if this was an audio message (for TTS response)
    const isAudioMessage = msgType === 'audio' || msgType === 'ptt';
    const isImageMessage = msgType === 'image' || msgType === 'video';

    // 1. Forward to Chatwoot (route to correct inbox based on which bot number received it)
    const botPhone = wid ? wid.split(':')[0] : '';
    const chatwootInboxId = getInboxForPhone(botPhone);
    try {
      const contact = await findOrCreateContact(phone, pushName, chatwootInboxId);
      const contactId = contact.id || contact.payload?.contact?.id;
      if (contactId) {
        const conversation = await findOrCreateConversation(contactId, `whatsapp_${phone}`, chatwootInboxId);
        const convId = conversation.id;
        if (convId) {
          let label = text;
          if (msgType === 'audio' || msgType === 'ptt') label = `[Audio] ${text}`;
          else if (msgType === 'image') label = `[Foto] ${text}`;
          else if (msgType === 'video') label = `[Vídeo] ${text}`;
          await chatwootSendMessage(convId, label, 'incoming');
          console.log(`[Bridge] Message forwarded to Chatwoot conversation ${convId} (inbox ${chatwootInboxId})`);
          trackBridgeActivity('quepasa-to-chatwoot');
        }
      }
    } catch (err) {
      console.error('[Bridge] Failed to forward to Chatwoot:', err.message);
      trackBridgeError(err);
    }

    // 2. Process with AI agent (pass botTokenForReply + botPhone for multi-number/persona support)
    handleIncomingMessage(phone, chatId, text, pushName, botTokenForReply, botPhone, isAudioMessage, isImageMessage).catch(err => {
      console.error(`[Quepasa Webhook] Error processing message from ${phone}:`, err);
    });

  } catch (err) {
    console.error('[Quepasa Webhook] Error:', err);
  }
});

// ============================================
// CHATWOOT WEBHOOK - Human agent replies + Instagram DM auto-reply
// ============================================
const IG_INBOX_ID = '4'; // Instagram - CredPositivo inbox
const IG_REPLY_ENABLED = process.env.IG_REPLY_ENABLED === 'true';
const IG_DM_ENABLED = process.env.IG_DM_ENABLED === 'true';
const IG_MAX_REPLIES_HOUR = parseInt(process.env.IG_MAX_REPLIES_HOUR || '30');
let igReplyCount = 0;
let igReplyWindowStart = Date.now();

webhookRouter.post('/webhook/chatwoot', async (req, res) => {
  res.status(200).json({ status: 'received' });

  try {
    const data = req.body;
    const event = data.event;

    console.log(`[Chatwoot Webhook] Event: ${event}`);

    if (event !== 'message_created') return;

    const message = data.message || data;
    const conversation = data.conversation || {};
    const inboxId = String(conversation.inbox_id || '');

    // ── INSTAGRAM DM AUTO-REPLY ──────────────────────────────────────────
    // Incoming messages from Instagram inbox → process with AI → reply via Chatwoot
    if (inboxId === IG_INBOX_ID && message.message_type === 'incoming' && IG_DM_ENABLED) {
      await handleInstagramDM(data, message, conversation).catch(err => {
        console.error('[Instagram DM] Error:', err.message);
      });
      return;
    }

    // Ignore incoming messages (from contacts) and bot messages
    if (message.message_type !== 'outgoing') return;
    if (message.private) return;

    // Ignore messages from the bot itself (marked with external_created)
    if (message.content_attributes?.external_created) return;

    // Ignore if sender is the bot/agent
    const sender = message.sender || {};
    if (!sender.id || sender.type === 'agent_bot') return;

    // Chatwoot webhook uses sender.type (lowercase), not message.sender_type
    const senderType = (message.sender_type || sender.type || '').toLowerCase();
    if (!senderType || senderType === 'contact' || senderType === 'agent_bot') return;

    // Try multiple paths to find the contact phone
    const contact = conversation.contact || data.contact || {};
    let phone = contact.phone_number?.replace(/^\+/, '') || '';

    // Fallback: extract from conversation meta or sender
    if (!phone) {
      const meta = conversation.meta || {};
      const sender = meta.sender || {};
      phone = sender.phone_number?.replace(/^\+/, '') || '';
    }

    // Fallback: extract from conversation additional_attributes or custom_attributes
    if (!phone) {
      const customAttrs = conversation.custom_attributes || contact.custom_attributes || {};
      phone = (customAttrs.phone || customAttrs.telefone || '').replace(/^\+/, '').replace(/\D/g, '');
    }

    // Fallback: try to extract from source_id (format: whatsapp_5571999999999)
    if (!phone && conversation.identifier) {
      const match = conversation.identifier.match(/whatsapp_(\d+)/);
      if (match) phone = match[1];
    }

    if (!phone) {
      console.log(`[Chatwoot Webhook] No phone found. Contact: ${JSON.stringify({ id: contact.id, phone: contact.phone_number, name: contact.name }).substring(0, 200)}`);
      return;
    }

    const content = message.content || '';
    if (!content) return;

    // Determine which bot token to use based on inbox
    let botTokenForSend = null;
    // Reverse-lookup: find which bot phone maps to this inbox, then get its token
    for (const [botPhone, mappedInbox] of Object.entries(config.chatwoot.inboxMapping)) {
      if (mappedInbox === inboxId) {
        botTokenForSend = getTokenForWid(`${botPhone}:`);
        console.log(`[Chatwoot -> Quepasa] Using bot ${botPhone} for inbox ${inboxId}`);
        break;
      }
    }

    // Resolve WhatsApp JID (handles LID issue for contacts who never messaged the bot)
    let chatId = phone;
    const resolvedJid = await resolveWhatsAppId(phone, botTokenForSend);
    if (resolvedJid) {
      chatId = resolvedJid;
    }

    console.log(`[Chatwoot -> Quepasa] Sending to ${chatId}: ${content.substring(0, 100)}`);

    await quepasaSendText(chatId, content, botTokenForSend);
    console.log(`[Bridge] Message sent to WhatsApp via Quepasa: ${chatId}`);
    trackBridgeActivity('chatwoot-to-quepasa');

  } catch (err) {
    console.error('[Chatwoot Webhook] Error:', err);
    trackBridgeError(err);
  }
});

// ============================================
// INSTAGRAM DM HANDLER — AI auto-reply via Chatwoot
// ============================================
import { getPromptOverride } from '../os/api/admin-routes.js';
import Anthropic from '@anthropic-ai/sdk';

const igAnthropic = new Anthropic({ apiKey: config.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY });

const IG_DEFAULT_PROMPT = `Você é Augusto, consultor financeiro da CredPositivo. Está respondendo uma DM no Instagram.

SOBRE A CREDPOSITIVO:
- Hub de serviços financeiros: Diagnóstico de Rating (R$67), Limpa Nome, Rating Bancário
- Objetivo: ajudar pessoas a destravar crédito e limpar o nome
- Site: credpositivo.com

REGRAS PARA INSTAGRAM DM:
- Respostas curtas e diretas (máximo 3 frases)
- Tom amigável e acessível
- NÃO mencione preços proativamente (exceto Diagnóstico R$67 quando perguntarem)
- Sempre direcione para o WhatsApp para atendimento completo: "Me chama no WhatsApp que te explico tudo certinho: wa.me/5571936180654"
- Se perguntarem sobre serviço específico, dê uma explicação breve e direcione pro WhatsApp
- Sem emojis excessivos (máximo 1-2 por mensagem)
- Português brasileiro informal mas profissional`;

async function handleInstagramDM(data, message, conversation) {
  if (!IG_REPLY_ENABLED) return;

  // Rate limit
  const now = Date.now();
  if (now - igReplyWindowStart > 3600000) {
    igReplyCount = 0;
    igReplyWindowStart = now;
  }
  if (igReplyCount >= IG_MAX_REPLIES_HOUR) {
    console.log('[Instagram DM] Rate limit reached, skipping');
    return;
  }

  const content = message.content || '';
  if (!content || content.length < 2) return;

  // Skip system messages, story mentions, shared posts without text
  if (content === 'Shared a story' || content === 'Shared post' || content.startsWith('[')) return;

  const conversationId = conversation.id || data.conversation_id;
  const contact = conversation.meta?.sender || conversation.contact || data.contact || {};
  const contactName = contact.name || 'amigo';

  console.log(`[Instagram DM] From ${contactName}: ${content.substring(0, 100)}`);

  // Get conversation history from Chatwoot for context
  let history = [];
  try {
    const histRes = await fetch(
      `${config.chatwoot.apiUrl}/api/v1/accounts/${config.chatwoot.accountId}/conversations/${conversationId}/messages`,
      { headers: { 'api_access_token': config.chatwoot.apiToken } }
    );
    const histData = await histRes.json();
    const msgs = (histData.payload || []).slice(-10); // last 10 messages
    history = msgs.map(m => ({
      role: m.message_type === 'incoming' ? 'user' : 'assistant',
      content: m.content || '',
    })).filter(m => m.content);
  } catch (e) {
    console.error('[Instagram DM] Failed to get history:', e.message);
    history = [{ role: 'user', content }];
  }

  // Ensure last message is user's
  if (history.length === 0 || history[history.length - 1].role !== 'user') {
    history.push({ role: 'user', content });
  }

  // Get prompt (admin override or default)
  const systemPrompt = await getPromptOverride('instagram') || IG_DEFAULT_PROMPT;

  try {
    const response = await igAnthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: systemPrompt,
      messages: history,
    });

    const reply = response.content[0].text.trim();
    if (!reply) return;

    // Send reply via Chatwoot (which delivers to Instagram)
    await chatwootSendOutgoing(conversationId, reply);
    igReplyCount++;

    console.log(`[Instagram DM] Replied to ${contactName}: ${reply.substring(0, 100)}`);

    // Emit event for AI OS
    try {
      const { emit } = await import('../os/emitter.js');
      await emit('bia.ig_dm_replied', 'bia', { contact: contactName, platform: 'instagram_dm' });
    } catch {}

  } catch (err) {
    console.error('[Instagram DM] AI error:', err.message);
  }
}

// ============================================
// INSTAGRAM COMMENT AUTO-REPLY — via Meta Graph API
// ============================================
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const IG_COMMENT_REPLY_PROMPT = `Você é Augusto, da CredPositivo. Responda um comentário no Instagram de forma curta (1-2 frases máximo).
Seja simpático, engajante. Direcione pro link na bio ou DM. Sem preços. Sem emojis excessivos.`;

webhookRouter.get('/webhook/instagram', (req, res) => {
  // Meta webhook verification
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const VERIFY_TOKEN = process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN || 'credpositivo-ig-verify';

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[Instagram Webhook] Verification OK');
    return res.status(200).send(challenge);
  }
  res.status(403).send('Forbidden');
});

webhookRouter.post('/webhook/instagram', async (req, res) => {
  res.status(200).send('EVENT_RECEIVED');

  if (!IG_REPLY_ENABLED || !META_ACCESS_TOKEN) return;

  try {
    const body = req.body;
    const entries = body.entry || [];

    for (const entry of entries) {
      // Handle comments
      const changes = entry.changes || [];
      for (const change of changes) {
        if (change.field === 'comments') {
          const comment = change.value;
          if (!comment || !comment.id || !comment.text) continue;
          // Don't reply to our own comments
          if (comment.from?.id === process.env.INSTAGRAM_ACCOUNT_ID) continue;

          await handleInstagramComment(comment).catch(err => {
            console.error('[Instagram Comment] Error:', err.message);
          });
        }
      }

      // Handle DMs via Instagram Messaging API directly
      const messaging = entry.messaging || [];
      for (const msg of messaging) {
        if (msg.message && !msg.message.is_echo) {
          const senderId = msg.sender?.id;
          const msgText = msg.message?.text || '';
          if (!senderId || !msgText || msgText.length < 2) continue;
          // Skip our own messages
          if (senderId === process.env.INSTAGRAM_ACCOUNT_ID) continue;

          console.log(`[Instagram DM] From ${senderId}: ${msgText.substring(0, 100)}`);

          await handleInstagramDMDirect(senderId, msgText).catch(err => {
            console.error('[Instagram DM] Error:', err.message);
          });
        }
      }
    }
  } catch (err) {
    console.error('[Instagram Webhook] Error:', err.message);
  }
});

async function handleInstagramComment(comment) {
  // Rate limit check
  const now = Date.now();
  if (now - igReplyWindowStart > 3600000) {
    igReplyCount = 0;
    igReplyWindowStart = now;
  }
  if (igReplyCount >= IG_MAX_REPLIES_HOUR) {
    console.log('[Instagram Comment] Rate limit reached');
    return;
  }

  const text = comment.text || '';
  const userName = comment.from?.username || 'amigo';
  console.log(`[Instagram Comment] @${userName}: ${text.substring(0, 100)}`);

  // Skip very short or spammy comments
  if (text.length < 3) return;

  // Generate reply with AI
  const systemPrompt = await getPromptOverride('instagram_comments') || IG_COMMENT_REPLY_PROMPT;

  const response = await igAnthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 150,
    system: systemPrompt,
    messages: [{ role: 'user', content: `Comentário de @${userName}: "${text}"\n\nResponda de forma breve e engajante.` }],
  });

  const reply = response.content[0].text.trim();
  if (!reply) return;

  // Reply to the comment via Meta Graph API
  const replyRes = await fetch(`https://graph.facebook.com/v21.0/${comment.id}/replies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: reply,
      access_token: META_ACCESS_TOKEN,
    }),
  });

  const result = await replyRes.json();
  if (result.error) {
    console.error(`[Instagram Comment] Reply failed: ${result.error.message}`);
    return;
  }

  igReplyCount++;
  console.log(`[Instagram Comment] Replied to @${userName}: ${reply.substring(0, 80)}`);

  // Send follow-up DM to the commenter
  await sendInstagramDM(comment.from?.id, userName, text).catch(err => {
    console.error(`[Instagram Comment→DM] Failed for @${userName}: ${err.message}`);
  });

  // Emit event
  try {
    const { emit } = await import('../os/emitter.js');
    await emit('bia.ig_comment_replied', 'bia', { user: userName, platform: 'instagram_feed' });
  } catch {}
}

// ============================================
// INSTAGRAM DM AFTER COMMENT — Send private message to commenter
// ============================================
const IG_DM_AFTER_COMMENT_PROMPT = `Você é Augusto, consultor da CredPositivo. Alguém comentou num post do Instagram e você quer puxar conversa no privado.

REGRAS:
- Mensagem curta e natural (máximo 2 frases)
- Referencie o comentário da pessoa de forma sutil
- Seja acolhedor, não vendedor
- Pergunte qual a situação dela com crédito
- NÃO mencione preços
- Tom: amigo que entende do assunto`;

const igDmSentRecently = new Set(); // Track who we DMed to avoid spam

async function sendInstagramDM(userId, userName, commentText) {
  if (!IG_DM_ENABLED || !META_ACCESS_TOKEN || !userId) return;

  // Don't DM ourselves
  if (userId === process.env.INSTAGRAM_ACCOUNT_ID) return;

  // Don't DM the same person twice in 24h
  const dmKey = `ig_dm_${userId}`;
  if (igDmSentRecently.has(dmKey)) {
    console.log(`[Instagram Comment→DM] Already DMed @${userName} recently, skipping`);
    return;
  }

  // Generate personalized DM
  const systemPrompt = await getPromptOverride('instagram_dm_after_comment') || IG_DM_AFTER_COMMENT_PROMPT;

  const response = await igAnthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 150,
    system: systemPrompt,
    messages: [{ role: 'user', content: `@${userName} comentou no post: "${commentText}"\n\nEscreva a DM para enviar.` }],
  });

  const dmText = response.content[0].text.trim();
  if (!dmText) return;

  // Send DM via Instagram Messaging API
  const dmRes = await fetch(`https://graph.facebook.com/v21.0/${process.env.INSTAGRAM_ACCOUNT_ID}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: userId },
      message: { text: dmText },
      access_token: META_ACCESS_TOKEN,
    }),
  });

  const dmResult = await dmRes.json();
  if (dmResult.error) {
    console.error(`[Instagram Comment→DM] API error: ${dmResult.error.message}`);
    return;
  }

  // Mark as sent (expires after 24h)
  igDmSentRecently.add(dmKey);
  setTimeout(() => igDmSentRecently.delete(dmKey), 24 * 60 * 60 * 1000);

  console.log(`[Instagram Comment→DM] Sent DM to @${userName}: ${dmText.substring(0, 80)}`);

  try {
    const { emit } = await import('../os/emitter.js');
    await emit('bia.ig_comment_dm_sent', 'bia', { user: userName, platform: 'instagram' });
  } catch {}
}

// --- Instagram DM handler (direct via Graph API, no Chatwoot) ---
const igDmHistory = new Map(); // userId -> [{role, content}]

async function handleInstagramDMDirect(senderId, text) {
  if (!IG_DM_ENABLED || !META_ACCESS_TOKEN) return;

  // Rate limit
  const now = Date.now();
  if (now - igReplyWindowStart > 3600000) {
    igReplyCount = 0;
    igReplyWindowStart = now;
  }
  if (igReplyCount >= IG_MAX_REPLIES_HOUR) {
    console.log('[Instagram DM] Rate limit reached, skipping');
    return;
  }

  // Skip story mentions, shared posts
  if (text === 'Shared a story' || text === 'Shared post' || text.startsWith('[')) return;

  // Build conversation history (in-memory, last 10 messages)
  if (!igDmHistory.has(senderId)) igDmHistory.set(senderId, []);
  const history = igDmHistory.get(senderId);
  history.push({ role: 'user', content: text });
  // Keep only last 10 messages
  while (history.length > 10) history.shift();

  const systemPrompt = await getPromptOverride('instagram') || IG_DEFAULT_PROMPT;

  try {
    const response = await igAnthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: systemPrompt,
      messages: history,
    });

    const reply = response.content[0].text.trim();
    if (!reply) return;

    // Send reply via Instagram Messaging API
    const dmRes = await fetch(`https://graph.facebook.com/v21.0/${process.env.INSTAGRAM_ACCOUNT_ID}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: senderId },
        message: { text: reply },
        access_token: META_ACCESS_TOKEN,
      }),
    });

    const dmResult = await dmRes.json();
    if (dmResult.error) {
      console.error(`[Instagram DM] Send error: ${dmResult.error.message}`);
      return;
    }

    // Add AI reply to history
    history.push({ role: 'assistant', content: reply });
    igReplyCount++;

    console.log(`[Instagram DM] Replied to ${senderId}: ${reply.substring(0, 100)}`);

    try {
      await emit('bia.ig_dm_replied', 'bia', { contact: senderId, platform: 'instagram_dm' });
    } catch {}

  } catch (err) {
    console.error('[Instagram DM] AI error:', err.message);
  }
}

export function getQrState() {
  return { qrCode: null, timestamp: null, connectionState: 'use-quepasa-ui' };
}
