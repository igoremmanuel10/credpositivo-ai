import OpenAI from 'openai';
import { downloadMedia } from '../quepasa/client.js';
import { trackApiCost } from '../monitoring/cost-tracker.js';

let transcribeClient = null;
let useGroq = false;

function getTranscribeClient() {
  if (!transcribeClient) {
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey) {
      transcribeClient = new OpenAI({
        apiKey: groqKey,
        baseURL: 'https://api.groq.com/openai/v1',
      });
      useGroq = true;
      console.log('[Transcribe] Using Groq Whisper');
    } else {
      const openaiKey = process.env.OPENAI_API_KEY;
      if (!openaiKey) throw new Error('No transcription API key (GROQ_API_KEY or OPENAI_API_KEY)');
      transcribeClient = new OpenAI({ apiKey: openaiKey });
      useGroq = false;
      console.log('[Transcribe] Using OpenAI Whisper');
    }
  }
  return transcribeClient;
}

export async function transcribeAudio(messageId, botToken = null) {
  console.log(`[Transcribe] Downloading audio ${messageId}...`);
  const audioBuffer = await downloadMedia(messageId, botToken);
  console.log(`[Transcribe] Downloaded ${audioBuffer.length} bytes`);

  const client = getTranscribeClient();
  const model = useGroq ? 'whisper-large-v3-turbo' : 'whisper-1';
  const file = new File([audioBuffer], 'audio.ogg', { type: 'audio/ogg' });

  console.log(`[Transcribe] Sending to ${useGroq ? 'Groq' : 'OpenAI'} Whisper (${model})...`);
  const transcription = await client.audio.transcriptions.create({
    model,
    file,
    language: 'pt',
  });

  const text = transcription.text?.trim() || '';
  console.log(`[Transcribe] Result: ${text.substring(0, 200)}`);

  trackApiCost({
    provider: useGroq ? 'groq' : 'openai',
    model,
    inputTokens: 0,
    outputTokens: 0,
    endpoint: 'transcribe',
    durationMs: audioBuffer.length / 16,
  }).catch(() => {});

  return text;
}
