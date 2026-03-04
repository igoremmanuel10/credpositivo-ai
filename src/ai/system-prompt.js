import { config } from '../config.js';
import { buildSdrPrompt } from './sdr-prompt.js';
import { getCorePrompt } from './prompts/core.js';
import { getPhase01 } from './prompts/phase-0-1.js';
import { getPhase2 } from './prompts/phase-2.js';
import { getPhase3 } from './prompts/phase-3.js';
import { getPhase4 } from './prompts/phase-4.js';
import { getObjections } from './prompts/objections.js';
import { getFooter } from './prompts/footer.js';

/**
 * Build system prompt based on persona.
 * @param {Object} state - Conversation state
 * @param {string} persona - 'augusto' (default) or 'paulo'
 * @param {Object} abOverrides - A/B test overrides { target: promptText }
 */
export function buildSystemPrompt(state, persona = 'augusto', abOverrides = {}) {
  if (persona === 'paulo') {
    return buildSdrPrompt(state, abOverrides);
  }
  return buildAugustoPrompt(state, abOverrides);
}

/**
 * System prompt do Augusto — v2 HORMOZI (modularizado).
 * Orquestra os módulos em src/ai/prompts/ para montar o prompt final.
 */
function buildAugustoPrompt(state, abOverrides = {}) {
  const siteUrl = config.site.url;
  const phase = state.phase || 0;
  const isReturning = (state.message_count || 0) > 0 && phase >= 1;

  const core = getCorePrompt(state);

  const phaseTarget = phase <= 1 ? 'greeting' : phase === 2 ? 'investigation' : phase === 3 ? 'education' : 'closing';
  const phaseInstructions = abOverrides[phaseTarget] || getPhaseInstructions(phase, siteUrl, isReturning, state);

  const objections = getObjections(phase, siteUrl);
  const footer = getFooter(siteUrl);

  return `${core}\n\n${phaseInstructions}\n\n${objections}\n\n${footer}`;
}

/**
 * Route to the correct phase module.
 */
function getPhaseInstructions(phase, siteUrl, isReturning, state) {
  if (phase <= 1) return getPhase01(siteUrl, isReturning);
  if (phase === 2) return getPhase2(state);
  if (phase === 3) return getPhase3(siteUrl);
  return getPhase4(siteUrl);
}
