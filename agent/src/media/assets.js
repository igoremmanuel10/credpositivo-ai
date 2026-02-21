import { config } from '../config.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Media assets mapped to conversation phases.
 *
 * Phase mapping:
 *   0 = Antiban (save contact)
 *   1 = Investigation
 *   2 = Education / Diagnosis
 *   3 = Recommendation / Product
 *   4 = Closing (send to site)
 *   5 = Post-purchase / Upsell
 */
const phaseMedia = {
  // Phase 0 → Welcome video (when entering phase 1 for first time)
  welcome: () => config.media.welcomeVideoUrl ? {
    url: config.media.welcomeVideoUrl,
    caption: '',
    type: 'video',
  } : null,

  // Phase 2 → Diagnostic image (explaining credit analysis)
  diagnostico: () => config.media.diagnosticoImageUrl ? {
    url: config.media.diagnosticoImageUrl,
    caption: '',
    type: 'image',
  } : null,
};

/**
 * Product explanation audios (pre-recorded).
 * Sent when lead asks "como funciona" or about products (phase 0 → 2 transition).
 * 01.opus = Product explanation part 1
 * 02.opus = Product explanation part 2
 * 03.opus = CTA — asks which product they identify with
 */
const PRODUCT_AUDIOS_DIR = resolve(process.cwd(), 'media');

let _productAudiosCache = null;

function loadProductAudios() {
  if (_productAudiosCache) return _productAudiosCache;

  try {
    _productAudiosCache = [
      { file: '01.opus', base64: readFileSync(resolve(PRODUCT_AUDIOS_DIR, '01.opus')).toString('base64') },
      { file: '02.opus', base64: readFileSync(resolve(PRODUCT_AUDIOS_DIR, '02.opus')).toString('base64') },
      { file: '03.opus', base64: readFileSync(resolve(PRODUCT_AUDIOS_DIR, '03.opus')).toString('base64') },
    ];
    console.log(`[Media] Product audios loaded (${_productAudiosCache.length} files)`);
    return _productAudiosCache;
  } catch (err) {
    console.error('[Media] Failed to load product audios:', err.message);
    return null;
  }
}

/**
 * Get the pre-recorded product explanation audios.
 * Returns array of { base64, fileName } or null if not available.
 */
export function getProductAudios() {
  if (!config.media.enabled) return null;
  const audios = loadProductAudios();
  if (!audios) return null;
  return audios.map(a => ({ base64: a.base64, fileName: a.file }));
}

/**
 * Get media to send for a given phase transition.
 * Only returns media when transitioning INTO a new phase (not when already in it).
 *
 * @param {number} currentPhase - The phase being entered
 * @param {Object} context - Additional context
 * @param {number} context.previousPhase - The phase we're coming from
 * @returns {Object|null} { url, caption, type } or null if no media for this transition
 */
export function getMediaForPhase(currentPhase, context = {}) {
  if (!config.media.enabled) return null;

  const { previousPhase } = context;

  // Only send media on phase transitions
  if (previousPhase === currentPhase) return null;

  // Phase 0 → 1: Welcome video
  if (previousPhase === 0 && currentPhase === 1) {
    return phaseMedia.welcome();
  }

  // Phase 1 → 2: Diagnostic explanation image
  if (previousPhase === 1 && currentPhase === 2) {
    return phaseMedia.diagnostico();
  }

  return null;
}
