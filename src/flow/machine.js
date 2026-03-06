/**
 * Deterministic State Machine for CredPositivo conversation flow.
 *
 * Replaces LLM-driven phase transitions with regex-based, deterministic logic.
 * The LLM generates conversational text only — all flow decisions happen here.
 */

import { config } from '../config.js';

// ============================================================
// PHASE DEFINITIONS
// ============================================================

const PHASES = {
  0: {
    name: 'greeting',
    canMentionPrice: false,
    canSendLink: false,
    maxMessages: config.limits.maxMessagesPerPhase[0] || 2,
    allowedMedia: ['audio_apresentacao'],
  },
  1: {
    name: 'qualify',
    canMentionPrice: false,
    canSendLink: false,
    maxMessages: config.limits.maxMessagesPerPhase[1] || 2,
    allowedMedia: [],
  },
  2: {
    name: 'educate',
    canMentionPrice: false,
    canSendLink: false,
    maxMessages: config.limits.maxMessagesPerPhase[2] || 8,
    allowedMedia: ['audio_diagnostico', 'rating_info_image', 'tutorial_video'],
  },
  3: {
    name: 'offer',
    canMentionPrice: true,
    canSendLink: true,
    maxMessages: config.limits.maxMessagesPerPhase[3] || 4,
    allowedMedia: ['prova_social'],
  },
  4: {
    name: 'post_sale',
    canMentionPrice: false,
    canSendLink: false,
    maxMessages: config.limits.maxMessagesPerPhase[4] || 3,
    allowedMedia: [],
  },
  5: {
    name: 'maintenance',
    canMentionPrice: false,
    canSendLink: false,
    maxMessages: Infinity,
    allowedMedia: [],
  },
};

// Valid transitions: only sequential forward (never skip, never regress)
const VALID_TRANSITIONS = {
  0: 1,
  1: 2,
  2: 3,
  3: 4,
  4: 5,
};

// ============================================================
// QUALIFICATION PATTERNS (Phase 1 → 2)
// ============================================================

const QUALIFICATION_PATTERNS = {
  onde_negativado: /serasa|spc|boa\s*vista|negativad|sujo|devendo|d[ií]vida|nome\s*sujo/i,
  tempo_situacao: /\d+\s*(ano|mes|mês|dia|semana)|faz\s*(muito\s*)?tempo|muito\s*tempo|h[aá]\s*\d+/i,
  tentou_banco: /banco|nega(?:ram|do|ção|ndo)|tentei|recus|ita[uú]|bradesco|santander|nubank|inter|caixa|bb\b|financiamento|empr[eé]stimo|cart[aã]o\s*(?:de\s*cr[eé]dito|negado)/i,
};

const REQUIRED_QUALIFICATION_POINTS = 2;

// ============================================================
// INTENT DETECTION PATTERNS
// ============================================================

const INTENT_PATTERNS = [
  // Priority 1: Opt-out (highest — must be respected immediately)
  {
    type: 'opt_out',
    pattern: /n[aã]o\s*quero\s*mais|para\s*de\s*me|pode\s*parar|sai\s*fora|me\s*bloqueia|stop|cancelar?\s*tudo|n[aã]o\s*me\s*mand/i,
  },
  // Priority 2: Numeric menu choice (exact match "1", "2", "3", "4")
  {
    type: 'menu_choice',
    pattern: /^[1-4]$/,
  },
  // Priority 3: Objections (before interest — "quero" in "não quero" would misfire)
  {
    type: 'objection_trust',
    pattern: /golpe|mentira|confi[ao]|funciona\s*mesmo|engana|fraude|falso|pir[aâ]mide|roub/i,
  },
  {
    type: 'objection_price',
    pattern: /caro|n[aã]o\s*tenho\s*(?:dinheiro|grana|condi)|barato|desconto|parcel/i,
  },
  // Priority 4: Interest (before keyword menu — "quero fazer o diagnóstico" = interest, not menu)
  {
    type: 'interest',
    pattern: /quero|vou\s*fazer|como\s*fa[cç]o|manda\s*(?:o\s*)?link|bora|fecha|vamos|pode\s*mandar|aceito|me\s*manda/i,
  },
  // Priority 5: Keyword-based menu choice (standalone product name without action verb)
  {
    type: 'menu_choice',
    pattern: /diagn[oó]stico|limpa\s*nome|rating|atendimento/i,
  },
  // Priority 6: Question (lowest intent priority)
  {
    type: 'question',
    pattern: /\?|como\s+(?:funciona|faz)|o\s+que\s+[eé]|qual|quanto|por\s*qu[eê]|quando|onde|quem/i,
  },
];

// ============================================================
// EXPORTED FUNCTIONS
// ============================================================

/**
 * Detect qualification points from text and existing user profile.
 *
 * @param {string} text - Current user message
 * @param {object} userProfile - Existing user_profile from conversation state
 * @returns {{ points: number, detected: { onde_negativado: boolean, tempo_situacao: boolean, tentou_banco: boolean } }}
 */
export function detectQualificationPoints(text, userProfile = {}) {
  const detected = {
    onde_negativado: false,
    tempo_situacao: false,
    tentou_banco: false,
  };

  for (const [key, pattern] of Object.entries(QUALIFICATION_PATTERNS)) {
    // Check current message text
    if (pattern.test(text)) {
      detected[key] = true;
      continue;
    }
    // Check user_profile (LLM may have extracted data in previous turns)
    if (userProfile[key]) {
      detected[key] = true;
    }
  }

  const points = Object.values(detected).filter(Boolean).length;
  return { points, detected };
}

/**
 * Detect user intent from message text using regex patterns.
 * Returns the first matching intent (patterns are ordered by priority).
 *
 * @param {string} text - User message text
 * @returns {{ type: string, value: string }}
 */
export function detectIntent(text) {
  if (!text || typeof text !== 'string') {
    return { type: 'general', value: '' };
  }

  const trimmed = text.trim();

  for (const { type, pattern } of INTENT_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      return { type, value: match[0] };
    }
  }

  return { type: 'general', value: '' };
}

/**
 * Validate whether a transition from currentPhase to targetPhase is allowed.
 * Only sequential forward transitions are valid (0→1, 1→2, 2→3, 3→4, 4→5).
 *
 * @param {number} currentPhase
 * @param {number} targetPhase
 * @returns {boolean}
 */
export function validateTransition(currentPhase, targetPhase) {
  if (currentPhase === targetPhase) return false; // no-op
  return VALID_TRANSITIONS[currentPhase] === targetPhase;
}

/**
 * Get configuration for a given phase.
 *
 * @param {number} phase
 * @returns {{ name: string, canMentionPrice: boolean, canSendLink: boolean, maxMessages: number, allowedMedia: string[] }}
 */
export function getPhaseConfig(phase) {
  return PHASES[phase] || PHASES[5]; // default to maintenance for unknown phases
}

/**
 * Evaluate whether the conversation should advance to the next phase.
 * Checks deterministic conditions — NEVER skips phases, NEVER regresses.
 *
 * @param {object} conversation - Full conversation object (phase, user_profile, message_count, payment_confirmed, etc.)
 * @param {string} userMessage - Current incoming message text
 * @returns {{ shouldAdvance: boolean, nextPhase: number, reason: string }}
 */
export function evaluateTransition(conversation, userMessage) {
  const currentPhase = conversation.phase || 0;
  const userProfile = conversation.user_profile || {};
  const noAdvance = { shouldAdvance: false, nextPhase: currentPhase, reason: 'no_condition_met' };

  // Phase 5 is terminal
  if (currentPhase >= 5) {
    return { shouldAdvance: false, nextPhase: 5, reason: 'terminal_phase' };
  }

  const nextPhase = VALID_TRANSITIONS[currentPhase];
  if (nextPhase === undefined) {
    return noAdvance;
  }

  switch (currentPhase) {
    // ── Phase 0 → 1: Menu respondido ──
    case 0: {
      // Any non-empty response after greeting = menu responded
      const messageCount = conversation.message_count || 0;
      if (messageCount >= 1 && userMessage && userMessage.trim().length > 0) {
        return { shouldAdvance: true, nextPhase: 1, reason: 'menu_responded' };
      }
      return noAdvance;
    }

    // ── Phase 1 → 2: Qualification complete (2 of 3 points) ──
    case 1: {
      const { points } = detectQualificationPoints(userMessage, userProfile);
      if (points >= REQUIRED_QUALIFICATION_POINTS) {
        return { shouldAdvance: true, nextPhase: 2, reason: 'qualification_complete' };
      }
      return noAdvance;
    }

    // ── Phase 2 → 3: All educational material consumed ──
    case 2: {
      const eduStage = userProfile.educational_stage || 0;
      if (eduStage >= 3) {
        return { shouldAdvance: true, nextPhase: 3, reason: 'education_complete' };
      }
      return noAdvance;
    }

    // ── Phase 3 → 4: Payment confirmed ──
    case 3: {
      if (conversation.payment_confirmed === true) {
        return { shouldAdvance: true, nextPhase: 4, reason: 'payment_confirmed' };
      }
      return noAdvance;
    }

    // ── Phase 4 → 5: Post-sale complete (manual or auto) ──
    case 4: {
      // Phase 4→5 is rarely automatic; usually the conversation just goes quiet.
      // Can be triggered manually or by a specific condition in the future.
      return noAdvance;
    }

    default:
      return noAdvance;
  }
}
