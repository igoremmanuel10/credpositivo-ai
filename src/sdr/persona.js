import { config } from '../config.js';

/**
 * Resolve persona from a bot phone number.
 * Uses phoneToPersona mapping from config.
 *
 * @param {string} botPhone - Bot phone number (e.g. '5521971364221')
 * @returns {string} Persona name ('augusto' or 'paulo')
 */
export function resolvePersona(botPhone) {
  if (!botPhone) return 'augusto';
  const clean = botPhone.replace(/\D/g, '');
  return config.sdr.phoneToPersona[clean] || 'augusto';
}
