import { config } from '../config.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const MEDIA_DIR = resolve(process.cwd(), 'media');

// ============================================================
// GENERIC LOADER
// ============================================================
const _cache = {};

function loadFile(key, fileName, type, mimetype) {
  if (_cache[key]) return _cache[key];
  try {
    const filePath = resolve(MEDIA_DIR, fileName);
    const base64 = readFileSync(filePath).toString('base64');
    _cache[key] = { base64, fileName, type, mimetype };
    console.log(`[Media] Loaded: ${fileName}`);
    return _cache[key];
  } catch (err) {
    console.error(`[Media] Failed to load ${fileName}:`, err.message);
    return null;
  }
}

// ============================================================
// PHASE 0 — Audio de apresentacao (boas-vindas do Augusto)
// ============================================================
export function getAudioApresentacao() {
  if (!config.media.enabled) return null;
  return loadFile('audio_apresentacao', 'audio_apresentacao.ogg', 'audio', 'audio/ogg');
}

// ============================================================
// PHASE 2 — Audio explicando o diagnostico
// ============================================================
export function getAudioDiagnostico() {
  if (!config.media.enabled) return null;
  return loadFile('audio_diagnostico', 'audio_diagnostico.ogg', 'audio', 'audio/ogg');
}

// ============================================================
// PHASE 2 — Video tutorial (na pratica)
// ============================================================
export function getTutorialVideo() {
  if (!config.media.enabled) return null;
  return loadFile('tutorial_na_pratica', 'tutorial_na_pratica.mov', 'video', 'video/quicktime');
}

// ============================================================
// PHASE 2 — Imagem rating info (apos explicar diagnostico)
// ============================================================
export function getRatingInfoImage() {
  if (!config.media.enabled) return null;
  return loadFile('diagnostico_rating_info', 'diagnostico_rating_info.png', 'image', 'image/png');
}

// ============================================================
// PHASE 3 — Provas Sociais (3 videos, enviados em objecao)
// ============================================================
export function getProvaSocialNew(index) {
  if (!config.media.enabled) return null;
  const files = [
    { key: 'prova_social_1', file: 'prova_social_1.mp4', mimetype: 'video/mp4' },
    { key: 'prova_social_2', file: 'prova_social_2.mp4', mimetype: 'video/mp4' },
    { key: 'prova_social_3', file: 'prova_social_3_cliente.mp4', mimetype: 'video/mp4' },
  ];
  const f = files[index] || files[0];
  return loadFile(f.key, f.file, 'video', f.mimetype);
}

// ============================================================
// LEGACY — kept for backwards compatibility with existing code
// ============================================================

const DIAGNOSTICO_VIDEO_PATH = resolve(MEDIA_DIR, 'diagnostico.mp4');
let _diagnosticoVideoCache = null;

function loadDiagnosticoVideo() {
  if (_diagnosticoVideoCache) return _diagnosticoVideoCache;
  try {
    const base64 = readFileSync(DIAGNOSTICO_VIDEO_PATH).toString('base64');
    _diagnosticoVideoCache = { base64, fileName: 'diagnostico.mp4', type: 'video', mimetype: 'video/mp4' };
    console.log('[Media] Diagnostico video loaded (legacy)');
    return _diagnosticoVideoCache;
  } catch (err) {
    console.error('[Media] Failed to load diagnostico video:', err.message);
    return null;
  }
}

export function getDiagnosticoVideo() {
  if (!config.media.enabled) return null;
  return loadDiagnosticoVideo();
}

export function getProductAudios() {
  if (!config.media.enabled) return null;
  // Legacy product audios replaced by new flow audios
  return null;
}

export function getMediaForPhase(currentPhase, context = {}) {
  // Legacy phase media — no longer used (new flow handles media in manager.js)
  return null;
}

export function getFollowupAudio(persona) {
  return null;
}

export function getEducationalVideo(persona) {
  return null;
}

// Legacy prova social (old files in prova-social/ dir)
const PROVA_SOCIAL_DIR = resolve(MEDIA_DIR, 'prova-social');
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
    } catch (err) {
      // Silently skip missing legacy files
    }
  }
  return _provaSocialCache;
}

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
