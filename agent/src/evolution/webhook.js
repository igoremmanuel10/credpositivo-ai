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

export const webhookRouter = Router();

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
    if (isFromMe && msgType !== 'audio') return;

    // For audio: skip if it's our own TTS audio (has trackId or filename starting with audio_)
    if (isFromMe && msgType === 'audio') {
      const trackId = msg.trackId || msg.track_id || '';
      const fileName = msg.attachment?.filename || '';
      if (trackId.startsWith('agent-') || fileName.startsWith('audio_')) {
        return; // This is our own TTS audio, ignore
      }
      console.log('[Quepasa] Audio with fromme:true but no agent trackId — treating as incoming user audio');
    }

    // Extract message text or transcribe audio
    let text = msg.text || msg.body || msg.message?.text || msg.message?.conversation || '';

    // --- AUDIO: transcribe via Whisper ---
    if (!text && msgType === 'audio' && msg.id) {
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
          if (msgType === 'audio') label = `[Audio] ${text}`;
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
    handleIncomingMessage(phone, chatId, text, pushName, botTokenForReply, botPhone).catch(err => {
      console.error(`[Quepasa Webhook] Error processing message from ${phone}:`, err);
    });

  } catch (err) {
    console.error('[Quepasa Webhook] Error:', err);
  }
});

// ============================================
// CHATWOOT WEBHOOK - Human agent replies here
// ============================================
webhookRouter.post('/webhook/chatwoot', async (req, res) => {
  res.status(200).json({ status: 'received' });

  try {
    const data = req.body;
    const event = data.event;

    console.log(`[Chatwoot Webhook] Event: ${event}`);

    // Only handle outgoing messages from human agents
    if (event !== 'message_created') return;

    const message = data.message || data;

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
    const conversation = data.conversation || {};
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
    const inboxId = String(conversation.inbox_id || '');
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
// Legacy Evolution webhook (keep for compat)
// ============================================
webhookRouter.post(['/webhook', '/webhook/evolution'], async (req, res) => {
  res.status(200).json({ status: 'received' });
});

export function getQrState() {
  return { qrCode: null, timestamp: null, connectionState: 'use-quepasa-ui' };
}
