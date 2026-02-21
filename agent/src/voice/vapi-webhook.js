/**
 * Vapi.ai Webhook Receiver
 *
 * Receives call status events from Vapi.ai and updates our database.
 * Events: status-update, end-of-call-report, hang
 *
 * Fernando Dev - CredPositivo
 */

import { Router } from 'express';
import { config } from '../config.js';
import { updateCallStatus } from './call-handler.js';

export const vapiWebhookRouter = Router();

/**
 * POST /api/vapi/webhook -- Main Vapi webhook endpoint.
 * Vapi sends all server events here.
 *
 * Event structure: { message: { type, call, ... } }
 */
vapiWebhookRouter.post('/api/vapi/webhook', async (req, res) => {
  const { message } = req.body || {};

  if (!message || !message.type) {
    console.warn('[Vapi Webhook] Received invalid payload (no message.type)');
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const { type, call } = message;
  const callId = call?.id || 'unknown';

  console.log(`[Vapi Webhook] Event: ${type} (call: ${callId})`);

  // Always respond 200 quickly to avoid Vapi retries
  res.status(200).json({ ok: true });

  try {
    switch (type) {
      case 'status-update':
        await handleStatusUpdate(message);
        break;

      case 'end-of-call-report':
        await handleEndOfCallReport(message);
        break;

      case 'hang':
        await handleHang(message);
        break;

      case 'transcript':
        // Live transcript -- log for debugging, no DB update needed
        handleTranscript(message);
        break;

      case 'speech-update':
        // Speech activity -- ignore silently
        break;

      case 'assistant-request':
        // Not expected for outbound calls with fixed assistant
        console.warn('[Vapi Webhook] Unexpected assistant-request received');
        break;

      case 'tool-calls':
        // No tools configured yet -- log for future use
        console.log(`[Vapi Webhook] Tool call received: ${JSON.stringify(message.toolCallList || [])}`);
        break;

      default:
        console.log(`[Vapi Webhook] Unhandled event type: ${type}`);
    }
  } catch (err) {
    console.error(`[Vapi Webhook] Error handling ${type}:`, err.message);
  }
});

/**
 * Handle status-update events.
 * Statuses: scheduled, queued, ringing, in-progress, forwarding, ended
 */
async function handleStatusUpdate(message) {
  const { call, status } = message;
  if (!call?.id) return;

  console.log(`[Vapi Webhook] Call ${call.id} status: ${status}`);

  // Map Vapi status to our status
  const statusMap = {
    'scheduled': 'scheduled',
    'queued': 'queued',
    'ringing': 'ringing',
    'in-progress': 'in_progress',
    'forwarding': 'forwarding',
    'ended': 'ended',
  };

  const mappedStatus = statusMap[status] || status;
  await updateCallStatus(call.id, mappedStatus);
}

/**
 * Handle end-of-call-report events.
 * Contains full call details: duration, transcript, reason, cost, etc.
 */
async function handleEndOfCallReport(message) {
  const { call, endedReason, artifact } = message;
  if (!call?.id) return;

  const duration = call.endedAt && call.startedAt
    ? Math.round((new Date(call.endedAt) - new Date(call.startedAt)) / 1000)
    : null;

  // Extract transcript as plain text
  let transcript = '';
  if (artifact?.messages) {
    transcript = artifact.messages
      .filter(m => m.role && m.message)
      .map(m => `${m.role === 'assistant' ? 'Augusto' : 'Lead'}: ${m.message}`)
      .join('\n');
  } else if (artifact?.transcript) {
    transcript = artifact.transcript;
  }

  // Build a brief summary from the transcript
  let summary = '';
  if (transcript) {
    const lines = transcript.split('\n').filter(Boolean);
    summary = lines.length > 4
      ? lines.slice(0, 4).join(' | ') + '...'
      : lines.join(' | ');
    // Cap summary at 500 chars
    if (summary.length > 500) summary = summary.substring(0, 497) + '...';
  }

  const cost = call.cost || null;

  console.log(`[Vapi Webhook] Call ${call.id} ended: reason=${endedReason}, duration=${duration}s, cost=${cost}`);

  await updateCallStatus(call.id, 'ended', {
    duration,
    endedReason: endedReason || 'unknown',
    transcript: transcript || null,
    summary: summary || null,
    cost,
  });

  // Log notable outcomes
  if (endedReason === 'customer-did-not-answer' || endedReason === 'customer-busy') {
    const phone = call.customer?.number || call.metadata?.phone || 'unknown';
    console.log(`[Vapi Webhook] Lead ${phone} did not answer. Consider WhatsApp follow-up.`);
  }
}

/**
 * Handle hang events (call quality issues).
 */
async function handleHang(message) {
  const { call } = message;
  if (!call?.id) return;
  console.warn(`[Vapi Webhook] Hang detected on call ${call.id}`);
}

/**
 * Handle live transcript events (for logging/debugging).
 */
function handleTranscript(message) {
  const { role, transcript, transcriptType } = message;
  if (transcriptType === 'final') {
    console.log(`[Vapi Transcript] ${role}: ${transcript}`);
  }
}

/**
 * GET /api/vapi/status -- Check Vapi integration status.
 */
vapiWebhookRouter.get('/api/vapi/status', (req, res) => {
  res.json({
    enabled: config.vapi?.enabled || false,
    hasPrivateKey: !!config.vapi?.privateKey,
    hasPhoneNumberId: !!config.vapi?.phoneNumberId,
    hasAssistantId: !!config.vapi?.assistantId,
    serverUrl: config.vapi?.serverUrl || 'not configured',
  });
});
