import OpenAI from 'openai';
import { config } from '../config.js';
import { sendMediaBase64 } from '../quepasa/client.js';
import { trackApiCost } from '../monitoring/cost-tracker.js';

let openaiClient = null;

function getOpenAI() {
  if (!openaiClient) {
    if (!config.openai.apiKey) {
      throw new Error('OPENAI_API_KEY not configured');
    }
    openaiClient = new OpenAI({ apiKey: config.openai.apiKey });
  }
  return openaiClient;
}

/**
 * Generate audio from text using OpenAI TTS.
 * Returns base64-encoded MP3 data.
 *
 * @param {string} text - Text to convert to speech (max ~4096 chars)
 * @param {string} voice - Voice to use (default: config.tts.voice)
 * @returns {string} Base64-encoded MP3 audio
 */
export async function generateAudio(text, voice = null) {
  const openai = getOpenAI();
  const useVoice = voice || config.tts.voice;
  const model = config.tts.model;

  console.log(`[TTS] Generating audio: voice=${useVoice}, model=${model}, text="${text.substring(0, 80)}..."`);

  const response = await openai.audio.speech.create({
    model,
    voice: useVoice,
    input: text,
    response_format: 'mp3',
  });

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const base64 = buffer.toString('base64');

  console.log(`[TTS] Generated ${buffer.length} bytes (${(buffer.length / 1024).toFixed(1)} KB)`);

  trackApiCost({
    provider: 'openai',
    model,
    inputTokens: text.length,  // char count for TTS pricing
    outputTokens: 0,
    endpoint: 'tts',
  }).catch(() => {});

  return base64;
}

/**
 * Generate audio and send it via WhatsApp (Quepasa).
 *
 * @param {string} chatId - WhatsApp chat ID (phone@s.whatsapp.net or phone number)
 * @param {string} text - Text to convert to audio
 * @param {string|null} token - Bot token override
 * @param {string} caption - Optional caption (shown below the audio)
 * @returns {Object} Quepasa send result
 */
export async function sendAudioMessage(chatId, text, token = null, caption = '') {
  if (!config.tts.enabled) {
    console.log('[TTS] Disabled. Skipping audio generation.');
    return null;
  }

  try {
    const base64Audio = await generateAudio(text);

    const result = await sendMediaBase64(
      chatId,
      base64Audio,
      caption,
      `audio_${Date.now()}.mp3`,
      token
    );

    console.log(`[TTS] Audio sent to ${chatId}`);
    return result;
  } catch (err) {
    console.error(`[TTS] Failed to send audio to ${chatId}:`, err.message);
    return null;
  }
}
