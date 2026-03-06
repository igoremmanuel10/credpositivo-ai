/**
 * Deterministic Media Rules for CredPositivo conversation flow.
 *
 * Controls educational staging, prova social, payment links, and nudge scheduling.
 * All decisions are code-driven — the LLM never decides when to send media.
 */

import { redis } from '../db/redis.js';
import { config } from '../config.js';

// ============================================================
// CENTRALIZED MEDIA CONFIGURATION
// ============================================================

export const MEDIA_CONFIG = {
  educational: {
    stages: [
      { asset: 'audio_diagnostico', nudgeText: 'Conseguiu ouvir o áudio? Se tiver qualquer dúvida é só me chamar!', nudgeDelay: 300000 },
      { asset: 'rating_info_image', nudgeText: 'Conseguiu ver a imagem? Qualquer dúvida estou aqui!', nudgeDelay: 300000 },
      { asset: 'tutorial_video', nudgeText: 'Conseguiu assistir o vídeo? Me conta o que achou!', nudgeDelay: 300000 },
    ],
    delayAfterText: 3000, // 3s between text and material
  },
  provaSocial: {
    maxPerConversation: 2,
    cooldownMs: 86400000, // 1 per day (24h)
    nudgeText: 'Conseguiu ver o depoimento? Esse cliente tinha uma situação parecida com a sua.',
    nudgeDelay: [300000, 480000], // 5-8 min (random pick)
  },
  paymentLink: {
    maxPerConversation: 3,
  },
};

// Product prices (mirrors PRODUCT_PRICES in manager.js)
const PRODUCT_PRICES = {
  diagnostico: 67,
  limpa_nome: 497,
  rating: 997,
};

// ============================================================
// EDUCATIONAL STAGING (Phase 2)
// ============================================================

/**
 * Determine if educational material should be sent and which one.
 * Progresses through 3 stages: audio → image → video.
 *
 * @param {object} conversation - { phase, user_profile: { educational_stage } }
 * @returns {{ shouldSend: boolean, asset: string, newStage: number, nudgeText: string, nudgeDelay: number, delayAfterText: number } | null}
 */
export function getEducationalAction(conversation) {
  if (!config.media.enabled) return null;

  const phase = conversation.phase || 0;
  const userProfile = conversation.user_profile || {};
  const eduStage = userProfile.educational_stage || 0;

  // Only active in phase >= 2 and when there's material left
  if (phase < 2 || eduStage >= MEDIA_CONFIG.educational.stages.length) {
    return null;
  }

  const stage = MEDIA_CONFIG.educational.stages[eduStage];
  if (!stage) return null;

  return {
    shouldSend: true,
    asset: stage.asset,
    newStage: eduStage + 1,
    nudgeText: stage.nudgeText,
    nudgeDelay: stage.nudgeDelay,
    delayAfterText: MEDIA_CONFIG.educational.delayAfterText,
  };
}

// ============================================================
// PROVA SOCIAL (Phase 3+)
// ============================================================

/**
 * Determine if a prova social video should be sent.
 * Only triggers on trust objections, in phase 3+, with per-conversation and daily limits.
 *
 * @param {object} conversation - { phase, user_profile: { prova_social_count }, phone }
 * @param {string} intentType - Intent type from detectIntent() (e.g., 'objection_trust')
 * @returns {Promise<{ shouldSend: boolean, assetIndex: number, nudgeText: string, nudgeDelay: number } | null>}
 */
export async function getProvaSocialAction(conversation, intentType) {
  if (!config.media.enabled) return null;

  const phase = conversation.phase || 0;

  // Only in phase >= 3
  if (phase < 3) return null;

  // Only on trust objections
  if (intentType !== 'objection_trust') return null;

  // Per-conversation limit
  const provaSocialCount = conversation.user_profile?.prova_social_count || 0;
  if (provaSocialCount >= MEDIA_CONFIG.provaSocial.maxPerConversation) {
    return null;
  }

  // Daily cooldown via Redis
  const phone = conversation.phone;
  if (phone) {
    const dailyKey = `prova_social_daily:${phone}`;
    const dailyCount = await redis.get(dailyKey);
    if (dailyCount && parseInt(dailyCount, 10) >= 1) {
      return null; // Already sent 1 today
    }
  }

  // Rotate through 3 prova social videos
  const assetIndex = provaSocialCount % 3;

  // Random nudge delay between 5-8 min
  const [minDelay, maxDelay] = MEDIA_CONFIG.provaSocial.nudgeDelay;
  const nudgeDelay = minDelay + Math.floor(Math.random() * (maxDelay - minDelay));

  return {
    shouldSend: true,
    assetIndex,
    nudgeText: MEDIA_CONFIG.provaSocial.nudgeText,
    nudgeDelay,
  };
}

/**
 * Record that a prova social was sent (call after actually sending).
 *
 * @param {string} phone
 */
export async function recordProvaSocialSent(phone) {
  if (!phone) return;
  const dailyKey = `prova_social_daily:${phone}`;
  await redis.incr(dailyKey);
  const ttl = await redis.ttl(dailyKey);
  if (ttl < 0) {
    await redis.expire(dailyKey, 86400); // 24h TTL
  }
}

// ============================================================
// PAYMENT LINK (Phase 3)
// ============================================================

/**
 * Determine if a payment link should be sent.
 * Only in phase 3, on interest intent, with per-conversation limit.
 *
 * @param {object} conversation - { phase, link_counter, recommended_product, user_profile: { menu_choice } }
 * @param {string} intentType - Intent type from detectIntent()
 * @returns {{ shouldSend: boolean, product: string, price: number } | null}
 */
export function getPaymentLinkAction(conversation, intentType) {
  const phase = conversation.phase || 0;

  // Only in phase 3
  if (phase !== 3) return null;

  // Only on interest signals
  if (intentType !== 'interest') return null;

  // Per-conversation limit
  const linkCounter = conversation.link_counter || 0;
  if (linkCounter >= MEDIA_CONFIG.paymentLink.maxPerConversation) {
    return null;
  }

  // Determine product
  const product = conversation.recommended_product
    || conversation.user_profile?.menu_choice
    || 'diagnostico'; // default fallback

  const price = PRODUCT_PRICES[product];
  if (!price) return null;

  return {
    shouldSend: true,
    product,
    price,
  };
}

// ============================================================
// NUDGE SCHEDULING (Redis-persistido)
// ============================================================

/**
 * Schedule a nudge message for a lead.
 * Uses Redis with TTL instead of setTimeout (survives restarts).
 *
 * @param {string} phone - Lead phone number
 * @param {string} type - Nudge type: 'educational' | 'prova_social'
 * @param {number} delayMs - Delay in milliseconds before nudge fires
 * @param {object} [extra] - Extra data (e.g., { conversationId, nudgeText })
 */
export async function scheduleNudge(phone, type, delayMs, extra = {}) {
  if (!phone) return;
  const key = `nudge:${phone}`;
  const data = {
    type,
    scheduledAt: Date.now() + delayMs,
    ...extra,
  };
  const ttlSeconds = Math.ceil(delayMs / 1000);
  await redis.set(key, JSON.stringify(data), 'EX', ttlSeconds);
}

/**
 * Check if a nudge is pending and ready to fire.
 * Returns the nudge data if the key still exists (hasn't expired and lead hasn't responded).
 *
 * @param {string} phone
 * @returns {Promise<{ type: string, scheduledAt: number, nudgeText?: string, conversationId?: number } | null>}
 */
export async function shouldSendNudge(phone) {
  if (!phone) return null;
  const key = `nudge:${phone}`;
  const data = await redis.get(key);
  if (!data) return null;

  try {
    const parsed = JSON.parse(data);
    // Nudge is ready if scheduledAt has passed
    if (Date.now() >= parsed.scheduledAt) {
      await redis.del(key); // consume the nudge
      return parsed;
    }
    return null; // not ready yet
  } catch {
    await redis.del(key);
    return null;
  }
}

/**
 * Cancel a pending nudge for a lead (called when lead responds).
 *
 * @param {string} phone
 */
export async function cancelNudge(phone) {
  if (!phone) return;
  await redis.del(`nudge:${phone}`);
}

// ============================================================
// FOLLOW-UP MEDIA ACTION (centralized from followup.js)
// ============================================================

/**
 * Determine the media action for a follow-up attempt.
 * Same logic as getFollowupFormat() in followup.js but returns a clearer media rule.
 *
 * @param {string} persona - 'augusto' | 'paulo'
 * @param {number} attempt - Follow-up attempt number (1-based)
 * @param {number} phase - Current conversation phase
 * @returns {{ type: string, asset?: string }}
 */
export function getFollowupMediaAction(persona, attempt, phase) {
  const isHotLead = phase >= 3;

  const augustoSequence = [
    { type: 'pre_recorded_audio', asset: 'audio_apresentacao' },
    { type: 'text_only' },
    isHotLead
      ? { type: 'vapi_call' }
      : { type: 'prova_social', asset: 'prova_social' },
    isHotLead
      ? { type: 'prova_social', asset: 'prova_social' }
      : { type: 'text_only' },
    { type: 'text_only' },
  ];

  const pauloSequence = [
    { type: 'pre_recorded_audio', asset: 'audio_apresentacao' },
    { type: 'text_only' },
    { type: 'text_only' },
    isHotLead
      ? { type: 'vapi_call' }
      : { type: 'prova_social', asset: 'prova_social' },
    { type: 'text_only' },
  ];

  const sequence = persona === 'paulo' ? pauloSequence : augustoSequence;
  const idx = Math.min(attempt - 1, sequence.length - 1);
  return sequence[idx] || { type: 'text_only' };
}
