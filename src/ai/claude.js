import OpenAI from 'openai';
import { config } from '../config.js';
import { buildSystemPrompt } from './system-prompt.js';
import { filterOutput, buildCorrectionInstruction } from './output-filter.js';
import { trackApiCost } from '../monitoring/cost-tracker.js';
import { captureError } from '../monitoring/sentry.js';
import { buildContextFromSimilar } from './embeddings.js';
import { buildKnowledgeContext } from './notion-rag.js';

// OpenRouter client — unified gateway for chat, fallback, vision
const openrouter = new OpenAI({
  apiKey: config.openrouter.apiKey,
  baseURL: config.openrouter.baseUrl,
});

// OpenAI client kept for TTS only
const openaiClient = new OpenAI({ apiKey: config.openai.apiKey });

/**
 * Get AI response for a conversation turn.
 * Uses Grok 4.1 Fast via OpenRouter for chat responses.
 */
export async function getAgentResponse(conversationState, messageHistory, userMessage, persona = 'augusto', abOverrides = {}) {
  let systemPrompt = buildSystemPrompt(conversationState, persona, abOverrides);

  // Inject knowledge base context (Notion RAG) — always available
  try {
    const knowledgeContext = await buildKnowledgeContext(userMessage);
    if (knowledgeContext) {
      systemPrompt += knowledgeContext;
    }
  } catch (err) {
    // Knowledge base is optional — don't block the response
  }

  // Inject similar conversation patterns via pgvector (RAG)
  // Only for phases 2+ (investigation onwards) where context matters most.
  // Phases 0-1 are simple greetings — no need for extra tokens.
  if (conversationState.phase >= 2) {
    try {
      const embeddingsContext = await buildContextFromSimilar(userMessage, conversationState.phase);
      if (embeddingsContext) {
        systemPrompt += embeddingsContext;
      }
    } catch (err) {
      // Embeddings are optional — don't block the response
    }
  }

  const messages = [];

  for (const msg of messageHistory) {
    messages.push({
      role: msg.role === 'agent' ? 'assistant' : 'user',
      content: msg.content,
    });
  }

  messages.push({ role: 'user', content: userMessage });

  let response = await callOpenRouter(systemPrompt, messages);

  // Skip compliance filter for phase 0 — menu is hardcoded text, no need to filter
  const filterResult = conversationState.phase === 0
    ? { clean: true, violations: [] }
    : filterOutput(response.text, conversationState.phase);
  if (!filterResult.clean) {
    console.warn(`[AI] Compliance violation detected: ${filterResult.violations.join(', ')}`);

    messages.push({ role: 'assistant', content: response.text });
    messages.push({
      role: 'user',
      content: buildCorrectionInstruction(filterResult.violations),
    });

    response = await callOpenRouter(systemPrompt, messages);

    const retryFilter = filterOutput(response.text, conversationState.phase);
    if (!retryFilter.clean) {
      console.error(`[AI] Still non-compliant after retry: ${retryFilter.violations.join(', ')}`);
    }
  }

  return response;
}

/**
 * Call primary model (Grok 4.1 Fast) via OpenRouter.
 * Retries up to 4 times with backoff on 429/529.
 * Falls back to Gemini 2.5 Flash Lite if all retries fail.
 */
async function callOpenRouter(systemPrompt, messages, attempt = 1) {
  const MAX_RETRIES = 4;
  const model = config.openrouter.model;

  try {
    const response = await openrouter.chat.completions.create({
      model,
      max_tokens: 500,
      temperature: 0.7,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
    });

    const text = response.choices[0]?.message?.content || '';
    const metadata = extractMetadata(text);
    console.log(`[AI] Metadata extracted: ${JSON.stringify(metadata.data)}`);

    const inputTokens = response.usage?.prompt_tokens || 0;
    const outputTokens = response.usage?.completion_tokens || 0;
    console.log(`[AI] Model: ${model} | Tokens: ${inputTokens}in/${outputTokens}out`);

    trackApiCost({
      provider: 'openrouter',
      model,
      inputTokens,
      outputTokens,
      endpoint: 'chat',
    }).catch(() => {});

    return {
      text: metadata.cleanText,
      metadata: metadata.data,
    };
  } catch (err) {
    const status = err.status || err.code;

    // Retry on rate limit (429) or overloaded (529)
    if ((status === 429 || status === 529) && attempt <= MAX_RETRIES) {
      const retryAfter = err.headers?.['retry-after'];
      const backoffMs = retryAfter
        ? parseInt(retryAfter) * 1000
        : status === 529
          ? [3000, 8000, 20000, 45000][attempt - 1] || 45000
          : 1000 * Math.pow(2, attempt - 1);
      const waitMs = Math.min(backoffMs + Math.random() * 1000, 60000);

      console.warn(`[AI] Rate limit/overloaded (${status}, attempt ${attempt}/${MAX_RETRIES}). Retrying in ${Math.round(waitMs)}ms...`);
      await new Promise(r => setTimeout(r, waitMs));
      return callOpenRouter(systemPrompt, messages, attempt + 1);
    }

    // All retries exhausted — try fallback model
    if (status === 429 || status === 529) {
      console.warn(`[AI] All ${MAX_RETRIES} retries failed (${status}). Falling back to ${config.openrouter.fallbackModel}...`);
      try {
        return await callFallback(systemPrompt, messages);
      } catch (fbErr) {
        console.error(`[AI Fallback] Also failed: ${fbErr.message}`);
        captureError(err, { module: 'ai', action: 'callOpenRouter', extra: { status, attempt, fallback: 'failed' } });
        throw err;
      }
    }

    captureError(err, { module: 'ai', action: 'callOpenRouter', extra: { status, attempt } });
    throw err;
  }
}

/**
 * Fallback model (Gemini 2.5 Flash Lite) via OpenRouter.
 */
async function callFallback(systemPrompt, messages) {
  const model = config.openrouter.fallbackModel;

  const response = await openrouter.chat.completions.create({
    model,
    max_tokens: 500,
    temperature: 0.7,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages,
    ],
  });

  const text = response.choices[0]?.message?.content || '';
  const metadata = extractMetadata(text);
  console.log(`[AI] Fallback | Metadata: ${JSON.stringify(metadata.data)}`);
  console.log(`[AI] Model: ${model} (fallback) | Tokens: ${response.usage?.prompt_tokens || 0}in/${response.usage?.completion_tokens || 0}out`);

  trackApiCost({
    provider: 'openrouter',
    model,
    inputTokens: response.usage?.prompt_tokens || 0,
    outputTokens: response.usage?.completion_tokens || 0,
    endpoint: 'chat-fallback',
  }).catch(() => {});

  return {
    text: metadata.cleanText,
    metadata: metadata.data,
  };
}

/**
 * Analyze an image using Gemini 2.5 Flash via OpenRouter.
 */
export async function analyzeImage(base64Image, mimeType = 'image/jpeg') {
  const MAX_RETRIES = 2;
  const model = config.openrouter.visionModel;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      const response = await openrouter.chat.completions.create({
        model,
        max_tokens: 150,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Descreva brevemente o que aparece nesta imagem, em portugues, em 1-2 frases.',
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mimeType};base64,${base64Image}`,
                  detail: 'low',
                },
              },
            ],
          },
        ],
      });

      const description = response.choices[0]?.message?.content?.trim() || '';
      console.log(`[Vision] Image analysis: ${description.substring(0, 200)}`);

      trackApiCost({
        provider: 'openrouter',
        model,
        inputTokens: response.usage?.prompt_tokens || 0,
        outputTokens: response.usage?.completion_tokens || 0,
        endpoint: 'vision',
      }).catch(() => {});

      return description;
    } catch (err) {
      if (err.status === 429 && attempt <= MAX_RETRIES) {
        const waitMs = 1000 * Math.pow(2, attempt - 1) + Math.random() * 500;
        console.warn(`[Vision] Rate limit hit (attempt ${attempt}). Retrying in ${Math.round(waitMs)}ms...`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Extract structured metadata from response.
 */
function extractMetadata(text) {
  let metadataMatch = text.match(/\[METADATA\]([\s\S]*?)\[\/METADATA\]/);
  let cleanText;

  if (metadataMatch) {
    cleanText = text.replace(/\[METADATA\][\s\S]*?\[\/METADATA\]/, '').trim();
  } else {
    metadataMatch = text.match(/\[METADATA\]([\s\S]*)$/);
    if (metadataMatch) {
      cleanText = text.replace(/\[METADATA\][\s\S]*$/, '').trim();
    }
  }

  if (!metadataMatch) {
    cleanText = text.replace(/\[METADATA\][\s\S]*/g, '').trim();
    return { cleanText, data: {} };
  }

  try {
    const data = JSON.parse(metadataMatch[1].trim());
    return { cleanText, data };
  } catch {
    return { cleanText, data: {} };
  }
}

// Re-export openaiClient for TTS usage in other modules
export { openaiClient };
