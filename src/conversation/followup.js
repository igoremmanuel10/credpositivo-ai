import cron from 'node-cron';
import { db } from '../db/client.js';
import { handleFollowup } from './manager.js';
import { config, isBusinessHours, msUntilNextBusinessHour } from '../config.js';
import { cache } from '../db/redis.js';

/**
 * Start the follow-up scheduler.
 * Runs every 5 minutes to check for:
 * 1. Conversations that timed out (no response in 24h)
 * 2. Pending scheduled follow-ups
 *
 * 5-step follow-up sequence (differentiated per persona):
 *
 * AUGUSTO (atendimento incoming):
 *   FU1 (24h): Audio pre-gravado
 *   FU2 (48h): Texto - novo angulo
 *   FU3 (72h): LIGACAO VAPI (fase 3-4) OU Prova social (fase 0-2)
 *   FU4 (5d):  Prova social (fase 3-4) OU Texto escassez (fase 0-2)
 *   FU5 (7d):  Texto - encerramento gentil
 *
 * PAULO SDR (outbound):
 *   FU1 (24h): Audio pre-gravado
 *   FU2 (48h): Texto - dificuldade tecnica
 *   FU3 (72h): Texto - escassez/urgencia
 *   FU4 (5d):  LIGACAO VAPI (fase 3-4) OU Prova social (fase 0-2)
 *   FU5 (7d):  Texto - encerramento gentil
 *
 * Respects business hours: 8h-20h BRT (Mon-Fri), 8h-14h (Sat), off Sunday.
 */
export function startFollowupScheduler() {
  if (!config.followupEnabled) {
    console.log('[Followup Scheduler] DESATIVADO (config.followupEnabled = false). Nenhum follow-up sera enviado.');
    return;
  }

  // Check every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    // Respect business hours for automated messages
    if (!isBusinessHours()) {
      return; // Silent skip outside business hours
    }

    try {
      await processTimeouts();
      await processPendingFollowups();
    } catch (err) {
      console.error('[Followup Scheduler] Error:', err);
    }
  });

  console.log('[Followup Scheduler] ATIVADO (every 5 minutes, business hours only: 8h-20h BRT)');
  console.log('[Followup Scheduler] Sequencia: 5 follow-ups (24h, 48h, 72h, 5d, 7d) com audio pre-gravado no FU1');
}

/**
 * Find conversations that timed out and schedule follow-ups.
 */
async function processTimeouts() {
  const timedOut = await db.getTimedOutConversations(config.limits.conversationTimeoutMinutes);

  // Admin/personal phones — NEVER send automated messages to these
  const ADMIN_PHONES = ['5511932145806', '557191234115', '557187700120'];

  for (const conv of timedOut) {
    // Skip opted-out leads
    if (conv.opted_out) continue;

    // Skip admin/personal phones
    if (ADMIN_PHONES.some(p => conv.phone?.includes(p) || p.includes(conv.phone))) continue;

    // Determine follow-up type based on phase
    let eventType = 'consultation_timeout';
    if (conv.phase >= 3 && conv.phase <= 4) {
      eventType = 'urgency';  // Lead was close to converting
    } else if (conv.phase === 2) {
      eventType = 'social_proof';  // Lead in education phase
    }

    console.log(`[Followup] Scheduling ${eventType} follow-up for ${conv.phone} (phase ${conv.phase}, persona ${conv.persona || 'augusto'})`);
    await db.scheduleFollowup(conv.id, eventType, 0); // immediate
  }
}

/**
 * Process pending follow-ups that are due.
 */
async function processPendingFollowups() {
  const pending = await db.getPendingFollowups();

  const ADMIN_PHONES_FU = ['5511932145806', '557191234115', '557187700120'];

  for (const followup of pending) {
    try {
      // Skip admin/personal phones
      if (ADMIN_PHONES_FU.some(p => followup.phone?.includes(p) || p.includes(followup.phone))) {
        console.log(`[Followup] BLOCKED ${followup.event_type} for ${followup.phone} — admin phone. Skipping.`);
        await db.markFollowupSent(followup.id);
        continue;
      }

      // OPT-OUT: Check if lead opted out
      const conv = await db.getConversation(followup.phone);
      if (conv && conv.opted_out) {
        console.log(`[Followup] BLOCKED ${followup.event_type} for ${followup.phone} — lead opted out.`);
        await db.cancelFollowups(followup.conversation_id);
        continue;
      }

      // ANTI-SPAM: Check if last message is already from agent before sending follow-up
      const recentMessages = await db.getMessages(followup.conversation_id);
      if (recentMessages.length > 0) {
        const lastMsg = recentMessages[recentMessages.length - 1];
        if (lastMsg.role === 'agent') {
          console.log(`[Followup] BLOCKED ${followup.event_type} for ${followup.phone} — last message is already from agent. Skipping.`);
          await db.markFollowupSent(followup.id);
          continue;
        }
      }

      // DAILY LIMIT: Max 1 follow-up per lead per day
      const todayCount = await cache.getDailyFollowupCount(followup.phone);
      if (todayCount >= config.limits.maxFollowupsPerDay) {
        console.log(`[Followup] BLOCKED ${followup.event_type} for ${followup.phone} — daily limit reached (${todayCount}).`);
        continue; // Don't mark as sent — retry tomorrow
      }

      // Determine follow-up format based on persona, attempt, and phase
      const persona = followup.persona || 'augusto';
      const format = getFollowupFormat(persona, followup.attempt, followup.phase || 0);

      console.log(`[Followup] Processing ${followup.event_type} (attempt ${followup.attempt}, format: ${format.type}) for ${followup.phone} [persona: ${persona}]`);

      await handleFollowup(
        {
          id: followup.conversation_id,
          phone: followup.phone,
          remote_jid: followup.remote_jid,
          name: followup.name,
          phase: followup.phase,
          user_profile: followup.user_profile,
          persona: persona,
          price_counter: 0,
          link_counter: 0,
          ebook_sent: false,
          recommended_product: followup.recommended_product || null,
        },
        followup.event_type,
        format.type === 'pre_recorded_audio', // useAudio
        followup.attempt // pass attempt number
      );

      await db.markFollowupSent(followup.id);
      await cache.incrementDailyFollowupCount(followup.phone);

      // Schedule next follow-up with increasing delay
      const nextDelay = getNextDelay(followup.attempt);
      if (nextDelay) {
        await db.scheduleFollowup(
          followup.conversation_id,
          followup.event_type,
          nextDelay
        );
      }
    } catch (err) {
      console.error(`[Followup] Error processing followup ${followup.id}:`, err);
    }
  }
}

/**
 * Determine the format for a follow-up based on persona and attempt.
 *
 * AUGUSTO sequence:
 *   1 → pre_recorded_audio (24h)
 *   2 → text (48h, new angle)
 *   3 → vapi_outbound_call IF phase>=3, ELSE social_proof_media (72h)
 *   4 → social_proof_media IF phase>=3, ELSE text_urgency (5d)
 *   5 → text_close (7d, encerramento)
 *
 * PAULO sequence:
 *   1 → pre_recorded_audio (24h)
 *   2 → text (48h, dificuldade tecnica)
 *   3 → text_urgency (72h, escassez)
 *   4 → vapi_outbound_call IF phase>=3, ELSE social_proof_media (5d)
 *   5 → text_close (7d, encerramento)
 */
function getFollowupFormat(persona, attempt, phase = 0) {
  const isHotLead = phase >= 3;

  const augustoSequence = [
    { type: 'pre_recorded_audio', label: 'audio pre-gravado' },
    { type: 'text', label: 'texto novo angulo' },
    isHotLead
      ? { type: 'vapi_outbound_call', label: 'LIGACAO outbound (lead quente)' }
      : { type: 'social_proof_media', label: 'prova social (video/imagem)' },
    isHotLead
      ? { type: 'social_proof_media', label: 'prova social (video/imagem)' }
      : { type: 'text_urgency', label: 'texto escassez' },
    { type: 'text_close', label: 'encerramento gentil' },
  ];

  const pauloSequence = [
    { type: 'pre_recorded_audio', label: 'audio pre-gravado' },
    { type: 'text', label: 'texto dificuldade tecnica' },
    { type: 'text_urgency', label: 'texto escassez' },
    isHotLead
      ? { type: 'vapi_outbound_call', label: 'LIGACAO outbound (lead quente)' }
      : { type: 'social_proof_media', label: 'prova social (video/imagem)' },
    { type: 'text_close', label: 'encerramento gentil' },
  ];

  const sequence = persona === 'paulo' ? pauloSequence : augustoSequence;
  const idx = Math.min(attempt - 1, sequence.length - 1);
  return sequence[idx] || { type: 'text', label: 'texto' };
}

/**
 * Determine if a follow-up should use TTS audio (legacy).
 * Now mostly replaced by pre_recorded_audio format for attempt 1.
 * Kept for backward compatibility with event-specific audio triggers.
 */
function shouldUseAudio(eventType, attempt) {
  if (!config.tts.enabled) return false;

  // Event-specific audio (always audio regardless of attempt)
  const audioEvents = [
    'purchase_completed', 'diagnosis_completed', 'limpa_completed',
    'rating_completed', 'affiliate_invite',
  ];
  if (audioEvents.includes(eventType)) return true;

  // Re-engagement: always audio
  if (eventType === 'reengagement') return true;

  // Purchase follow-up: audio
  if (eventType === 'purchase_followup') return true;

  return false;
}

/**
 * Get next follow-up delay based on attempt number.
 *
 * New sequence (5 attempts):
 *   After attempt 1 → wait 24h  (delays[0])
 *   After attempt 2 → wait 24h  (delays[1]) → total 48h
 *   After attempt 3 → wait 48h  (delays[2]) → total ~5d
 *   After attempt 4 → wait 48h  (delays[3]) → total ~7d
 *   After attempt 5 → stop (null)
 */
function getNextDelay(attempt) {
  const delays = config.limits.followupDelays;
  if (attempt <= delays.length) {
    return delays[attempt - 1];
  }
  return null;
}

export { getFollowupFormat };
