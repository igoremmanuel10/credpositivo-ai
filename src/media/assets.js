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
 *   3 = Recommendation / Consulta Gratuita
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

  // Phase 2 → Diagnostic explanation image
  diagnostico: () => config.media.diagnosticoImageUrl ? {
    url: config.media.diagnosticoImageUrl,
    caption: '',
    type: 'image',
  } : null,
};

// ============================================================
// DIAGNOSTICO VIDEO (Phase 3 — sent when offering free consultation)
// ============================================================
const DIAGNOSTICO_VIDEO_PATH = resolve(process.cwd(), 'media', 'diagnostico.mp4');

let _diagnosticoVideoCache = null;

function loadDiagnosticoVideo() {
  if (_diagnosticoVideoCache) return _diagnosticoVideoCache;

  try {
    const base64 = readFileSync(DIAGNOSTICO_VIDEO_PATH).toString('base64');
    _diagnosticoVideoCache = { base64, fileName: 'diagnostico.mp4', type: 'video', mimetype: 'video/mp4' };
    console.log('[Media] Diagnostico video loaded');
    return _diagnosticoVideoCache;
  } catch (err) {
    console.error('[Media] Failed to load diagnostico video:', err.message);
    return null;
  }
}

/**
 * Get diagnostico video for Phase 3.
 * Returns { base64, fileName, type, mimetype } or null.
 */
export function getDiagnosticoVideo() {
  if (!config.media.enabled) return null;
  return loadDiagnosticoVideo();
}

/**
 * Product explanation audios (pre-recorded).
 * Sent when lead asks "como funciona" or about products (phase 0 → 2 transition).
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

// ============================================================
// FOLLOW-UP AUDIOS (pre-recorded per persona)
// ============================================================
const FOLLOWUP_AUDIOS_DIR = resolve(process.cwd(), 'media', 'followup');

let _followupAudiosCache = {};

function loadFollowupAudio(persona) {
  if (_followupAudiosCache[persona]) return _followupAudiosCache[persona];

  const fileMap = {
    augusto: 'augusto_followup_24h.mp3',
    paulo: 'paulo_followup_24h.mp3',
  };

  const fileName = fileMap[persona];
  if (!fileName) return null;

  try {
    const filePath = resolve(FOLLOWUP_AUDIOS_DIR, fileName);
    const base64 = readFileSync(filePath).toString('base64');
    _followupAudiosCache[persona] = { base64, fileName };
    console.log(`[Media] Follow-up audio loaded for ${persona}: ${fileName}`);
    return _followupAudiosCache[persona];
  } catch (err) {
    console.error(`[Media] Failed to load follow-up audio for ${persona}:`, err.message);
    return null;
  }
}

/**
 * Get pre-recorded follow-up audio for a persona.
 * Returns { base64, fileName } or null if not available.
 */
export function getFollowupAudio(persona) {
  // Pre-recorded follow-up audios removed — TTS handles this now
  return null;
}

// ============================================================
// EDUCATIONAL VIDEOS (advogado) — placeholders for Phase 3
// ============================================================
const educationalVideos = {
  augusto: {
    url: '',
    caption: '',
    type: 'video',
    title: 'Acao Judicial por Negativacao Indevida',
  },
  paulo: {
    url: '',
    caption: '',
    type: 'video',
    title: 'Requisitos da Negativacao Indevida',
  },
};

export function getEducationalVideo(persona) {
  if (!config.media.enabled) return null;
  const video = educationalVideos[persona] || educationalVideos.augusto;
  if (!video.url) {
    console.log(`[Media] Educational video for ${persona} not yet available (URL empty)`);
    return null;
  }
  return video;
}

// ============================================================
// PROVA SOCIAL — Videos (2) + Imagens (3)
// ============================================================
const PROVA_SOCIAL_DIR = resolve(process.cwd(), 'media', 'prova-social');

let _provaSocialCache = null;

function loadProvaSocial() {
  if (_provaSocialCache) return _provaSocialCache;

  const files = [
    { file: 'prova_social_01.mp4', type: 'video', mimetype: 'video/mp4' },
    { file: 'prova_social_02.mp4', type: 'video', mimetype: 'video/mp4' },
    { file: 'social_01.jpeg', type: 'image', mimetype: 'image/jpeg' },
    { file: 'social_02.jpeg', type: 'image', mimetype: 'image/jpeg' },
    { file: 'social_03.jpeg', type: 'image', mimetype: 'image/jpeg' },
  ];

  _provaSocialCache = [];

  for (const f of files) {
    try {
      const filePath = resolve(PROVA_SOCIAL_DIR, f.file);
      const base64 = readFileSync(filePath).toString('base64');
      _provaSocialCache.push({ base64, fileName: f.file, type: f.type, mimetype: f.mimetype });
      console.log(`[Media] Prova social loaded: ${f.file} (${f.type})`);
    } catch (err) {
      console.error(`[Media] Failed to load prova social ${f.file}:`, err.message);
    }
  }

  console.log(`[Media] Prova social: ${_provaSocialCache.length} files loaded`);
  return _provaSocialCache;
}

/**
 * Get a prova social media item for a follow-up.
 * Uses conversation ID to rotate through available proofs.
 *
 * @param {string} persona - 'augusto' or 'paulo'
 * @param {number|string} conversationId - used as seed for rotation
 * @returns {{ base64, fileName, type, mimetype } | null}
 */
export function getProvaSocial(persona, conversationId) {
  if (!config.media.enabled) return null;
  const items = loadProvaSocial();
  if (!items || items.length === 0) return null;

  const seed = typeof conversationId === 'number'
    ? conversationId
    : parseInt(String(conversationId).replace(/\D/g, '').slice(-6) || '0', 10);

  const offset = persona === 'paulo' ? 2 : 0;
  const idx = (seed + offset) % items.length;

  return items[idx];
}
