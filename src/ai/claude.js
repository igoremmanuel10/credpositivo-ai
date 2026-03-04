import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { config } from '../config.js';
import { buildSystemPrompt } from './system-prompt.js';
import { filterOutput, buildCorrectionInstruction } from './output-filter.js';
import { trackApiCost } from '../monitoring/cost-tracker.js';
import { captureError } from '../monitoring/sentry.js';
import { buildContextFromSimilar } from './embeddings.js';

// Anthropic client for chat (Haiku 4.5)
const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

// OpenAI client kept for Vision and TTS only
const openaiClient = new OpenAI({ apiKey: config.openai.apiKey });

/**
 * Get AI response for a conversation turn.
 * Uses Claude Haiku 4.5 for chat responses.
 */
export async function getAgentResponse(conversationState, messageHistory, userMessage, persona = 'augusto', abOverrides = {}) {
  let systemPrompt = buildSystemPrompt(conversationState, persona, abOverrides);

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

  let response = await callClaude(systemPrompt, messages);

  // Skip compliance filter for phase 0 — menu is hardcoded text, no need to filter
  const filterResult = conversationState.phase === 0
    ? { clean: true, violations: [] }
    : filterOutput(response.text, conversationState.phase);
  if (!filterResult.clean) {
    console.warn(`[Claude] Compliance violation detected: ${filterResult.violations.join(', ')}`);

    messages.push({ role: 'assistant', content: response.text });
    messages.push({
      role: 'user',
      content: buildCorrectionInstruction(filterResult.violations),
    });

    response = await callClaude(systemPrompt, messages);

    const retryFilter = filterOutput(response.text, conversationState.phase);
    if (!retryFilter.clean) {
      console.error(`[Claude] Still non-compliant after retry: ${retryFilter.violations.join(', ')}`);
    }
  }

  return response;
}

/**
 * Call Claude Haiku with automatic retry on rate limit (429) / overloaded (529).
 * Retries up to 4 times with aggressive backoff for 529.
 * Falls back to GPT-4o-mini if all Claude retries fail.
 */
async function callClaude(systemPrompt, messages, attempt = 1) {
  const MAX_RETRIES = 4;

  try {
    const response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 500,
      temperature: 0.7,
      system: systemPrompt,
      messages: messages,
    });

    const text = response.content[0]?.text || '';
    const metadata = extractMetadata(text);
    console.log(`[AI] Metadata extracted: ${JSON.stringify(metadata.data)}`);

    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;
    console.log(`[AI] Model: ${config.anthropic.model} | Tokens: ${inputTokens}in/${outputTokens}out`);

    trackApiCost({
      provider: 'anthropic',
      model: config.anthropic.model,
      inputTokens,
      outputTokens,
      endpoint: 'chat',
    }).catch(() => {});

    return {
      text: metadata.cleanText,
      metadata: metadata.data,
    };
  } catch (err) {
    // Retry on rate limit (429) or overloaded (529)
    if ((err.status === 429 || err.status === 529) && attempt <= MAX_RETRIES) {
      // Aggressive backoff for 529: 3s, 8s, 20s, 45s
      const retryAfter = err.headers?.['retry-after'];
      const backoffMs = retryAfter
        ? parseInt(retryAfter) * 1000
        : err.status === 529
          ? [3000, 8000, 20000, 45000][attempt - 1] || 45000
          : 1000 * Math.pow(2, attempt - 1);
      const waitMs = Math.min(backoffMs + Math.random() * 1000, 60000);

      console.warn(`[Claude] Rate limit/overloaded (${err.status}, attempt ${attempt}/${MAX_RETRIES}). Retrying in ${Math.round(waitMs)}ms...`);
      await new Promise(r => setTimeout(r, waitMs));
      return callClaude(systemPrompt, messages, attempt + 1);
    }

    // All Claude retries exhausted — try GPT-4o-mini as fallback
    if (err.status === 429 || err.status === 529) {
      console.warn(`[Claude] All ${MAX_RETRIES} retries failed (${err.status}). Falling back to GPT-4o-mini...`);
      try {
        return await callGptFallback(systemPrompt, messages);
      } catch (gptErr) {
        console.error(`[GPT Fallback] Also failed: ${gptErr.message}`);
        captureError(err, { module: 'claude', action: 'callClaude', extra: { status: err.status, attempt, fallback: 'gpt-failed' } });
        throw err;
      }
    }

    captureError(err, { module: 'claude', action: 'callClaude', extra: { status: err.status, attempt } });
    throw err;
  }
}

/**
 * GPT-4o-mini fallback when Claude is overloaded.
 * Uses the same system prompt and messages format.
 */
async function callGptFallback(systemPrompt, messages) {
  const gptMessages = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];

  const response = await openaiClient.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 500,
    temperature: 0.7,
    messages: gptMessages,
  });

  const text = response.choices[0]?.message?.content || '';
  const metadata = extractMetadata(text);
  console.log(`[AI] GPT Fallback | Metadata: ${JSON.stringify(metadata.data)}`);
  console.log(`[AI] Model: gpt-4o-mini (fallback) | Tokens: ${response.usage?.prompt_tokens || 0}in/${response.usage?.completion_tokens || 0}out`);

  trackApiCost({
    provider: 'openai',
    model: 'gpt-4o-mini',
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
 * Analyze an image using GPT-4o Vision (stays on OpenAI).
 */
export async function analyzeImage(base64Image, mimeType = 'image/jpeg') {
  const MAX_RETRIES = 2;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      const response = await openaiClient.chat.completions.create({
        model: config.openai.visionModel,
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
        provider: 'openai',
        model: config.openai.visionModel,
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
