import OpenAI from 'openai';
import { config } from '../config.js';
import { downloadMedia, getTokenForWid } from '../quepasa/client.js';
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
 * Transcribe an audio message from Quepasa using OpenAI Whisper.
 * @param {string} messageId - Quepasa message ID
 * @param {string} [botToken] - Optional bot token for downloading from the correct number
 * @returns {string} Transcribed text
 */
export async function transcribeAudio(messageId, botToken = null) {
  console.log(`[Transcribe] Downloading audio ${messageId}...`);
  const audioBuffer = await downloadMedia(messageId, botToken);
  console.log(`[Transcribe] Downloaded ${audioBuffer.length} bytes`);

  const openai = getOpenAI();

  // Create a File object from the buffer for the Whisper API
  const file = new File([audioBuffer], 'audio.ogg', { type: 'audio/ogg' });

  console.log('[Transcribe] Sending to Whisper...');
  const transcription = await openai.audio.transcriptions.create({
    model: 'whisper-1',
    file: file,
    language: 'pt',
  });

  const text = transcription.text?.trim() || '';
  console.log(`[Transcribe] Result: ${text.substring(0, 200)}`);

  trackApiCost({
    provider: 'openai',
    model: 'whisper-1',
    inputTokens: 0,
    outputTokens: 0,
    endpoint: 'transcribe',
    durationMs: transcription.duration ? transcription.duration * 1000 : audioBuffer.length / 16,  // rough estimate
  }).catch(() => {});

  return text;
}
