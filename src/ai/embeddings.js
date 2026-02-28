import OpenAI from 'openai';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { trackApiCost } from '../monitoring/cost-tracker.js';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSION = 1536;

// Cost: $0.02 per 1M tokens for text-embedding-3-small
const COST_PER_1M_TOKENS = 0.02;

// OpenAI client for embeddings
const openai = new OpenAI({ apiKey: config.openai.apiKey });

// ─── Circuit Breaker ──────────────────────────────────────────────────────────
const circuitBreaker = {
  failures: 0,
  maxFailures: 5,
  disabledUntil: 0,       // timestamp when circuit breaker resets
  cooldownMs: 60 * 60 * 1000, // 1 hour cooldown after tripping
};

function isCircuitOpen() {
  if (circuitBreaker.failures < circuitBreaker.maxFailures) return false;
  if (Date.now() > circuitBreaker.disabledUntil) {
    // Reset after cooldown
    circuitBreaker.failures = 0;
    console.log('[Embeddings] Circuit breaker reset after cooldown');
    return false;
  }
  return true;
}

function recordFailure() {
  circuitBreaker.failures++;
  if (circuitBreaker.failures >= circuitBreaker.maxFailures) {
    circuitBreaker.disabledUntil = Date.now() + circuitBreaker.cooldownMs;
    console.warn(`[Embeddings] Circuit breaker OPEN — ${circuitBreaker.maxFailures} failures. Disabled for 1h.`);
  }
}

function recordSuccess() {
  circuitBreaker.failures = 0;
}

/**
 * Generate an embedding vector for the given text.
 * Uses OpenAI's text-embedding-3-small (1536 dimensions).
 * Circuit breaker: disables for 1h after 5 consecutive failures.
 *
 * @param {string} text - Text to embed
 * @returns {number[]|null} Float array of 1536 dimensions, or null on error
 */
export async function generateEmbedding(text) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    console.warn('[Embeddings] Empty text provided, skipping embedding generation');
    return null;
  }

  // Circuit breaker check
  if (isCircuitOpen()) {
    return null;
  }

  // Truncate very long texts to stay within token limits (~8191 tokens max)
  // Rough estimate: 1 token ~ 4 chars for Portuguese
  const maxChars = 30000;
  const truncatedText = text.length > maxChars ? text.substring(0, maxChars) : text;

  try {
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: truncatedText,
    });

    const embedding = response.data[0]?.embedding;
    if (!embedding || embedding.length !== EMBEDDING_DIMENSION) {
      console.error(`[Embeddings] Unexpected embedding dimension: ${embedding?.length}`);
      return null;
    }

    // Track cost (non-blocking)
    const totalTokens = response.usage?.total_tokens || 0;
    trackApiCost({
      provider: 'openai',
      model: EMBEDDING_MODEL,
      inputTokens: totalTokens,
      outputTokens: 0,
      endpoint: 'embedding',
    }).catch(() => {});

    recordSuccess();
    return embedding;
  } catch (err) {
    console.error('[Embeddings] Failed to generate embedding:', err.message);
    recordFailure();
    return null;
  }
}

/**
 * Store an embedding for a conversation at a specific phase.
 *
 * @param {number} conversationId - conversation DB id
 * @param {number} phase - conversation phase (0-5)
 * @param {string} contentSummary - human-readable summary of conversation content
 * @param {string} outcome - 'purchased' | 'opted_out' | 'abandoned' | 'progressed'
 * @param {object} metadata - optional JSON metadata (e.g. product, score, persona)
 * @returns {number|null} id of the created row, or null on error
 */
export async function storeConversationEmbedding(conversationId, phase, contentSummary, outcome, metadata = {}) {
  try {
    const embedding = await generateEmbedding(contentSummary);
    if (!embedding) {
      console.warn(`[Embeddings] No embedding generated for conversation ${conversationId}, skipping store`);
      return null;
    }

    // Format as pgvector string: [0.1, 0.2, ...]
    const vectorStr = `[${embedding.join(',')}]`;

    const { rows } = await db.query(
      `INSERT INTO conversation_embeddings
         (conversation_id, phase, embedding, content_summary, outcome, metadata)
       VALUES ($1, $2, $3::vector, $4, $5, $6)
       RETURNING id`,
      [conversationId, phase, vectorStr, contentSummary, outcome, JSON.stringify(metadata)]
    );

    const id = rows[0]?.id;
    console.log(`[Embeddings] Stored embedding #${id} for conversation ${conversationId} (phase ${phase}, outcome: ${outcome})`);
    return id;
  } catch (err) {
    console.error(`[Embeddings] Failed to store embedding for conversation ${conversationId}:`, err.message);
    return null;
  }
}

/**
 * Find conversations similar to the given query text.
 * Uses pgvector cosine distance for similarity search.
 *
 * @param {string} query - text to find similar conversations for
 * @param {number|null} phase - optional phase filter (null = all phases)
 * @param {number} limit - max results to return (default 3)
 * @returns {Array<{id: number, conversation_id: number, phase: number, content_summary: string, outcome: string, metadata: object, similarity: number}>}
 */
export async function findSimilarConversations(query, phase = null, limit = 3) {
  try {
    const embedding = await generateEmbedding(query);
    if (!embedding) {
      return [];
    }

    const vectorStr = `[${embedding.join(',')}]`;

    let sql;
    let params;

    if (phase !== null && phase !== undefined) {
      sql = `
        SELECT
          id,
          conversation_id,
          phase,
          content_summary,
          outcome,
          metadata,
          1 - (embedding <=> $1::vector) AS similarity
        FROM conversation_embeddings
        WHERE phase = $2
        ORDER BY embedding <=> $1::vector
        LIMIT $3
      `;
      params = [vectorStr, phase, limit];
    } else {
      sql = `
        SELECT
          id,
          conversation_id,
          phase,
          content_summary,
          outcome,
          metadata,
          1 - (embedding <=> $1::vector) AS similarity
        FROM conversation_embeddings
        ORDER BY embedding <=> $1::vector
        LIMIT $2
      `;
      params = [vectorStr, limit];
    }

    const { rows } = await db.query(sql, params);
    return rows;
  } catch (err) {
    console.error('[Embeddings] Similarity search failed:', err.message);
    return [];
  }
}

/**
 * Build a context string from similar past conversations.
 * Designed to be injected into the system prompt for RAG-like enhancement.
 *
 * @param {string} query - current conversation text to match against
 * @param {number|null} phase - optional phase filter
 * @returns {string} formatted context string, or empty string if no matches
 */
export async function buildContextFromSimilar(query, phase = null) {
  try {
    const similar = await findSimilarConversations(query, phase, 3);

    if (!similar || similar.length === 0) {
      return '';
    }

    // Only include results above a minimum similarity threshold
    const MIN_SIMILARITY = 0.75;
    const relevant = similar.filter(s => s.similarity >= MIN_SIMILARITY);

    if (relevant.length === 0) {
      return '';
    }

    const contextParts = relevant.map((s, i) => {
      const outcomeLabel = {
        purchased: 'COMPROU',
        opted_out: 'DESISTIU',
        abandoned: 'ABANDONOU',
        progressed: 'AVANCOU',
      }[s.outcome] || s.outcome;

      const product = s.metadata?.recommended_product || '';
      const productInfo = product ? ` | Produto: ${product}` : '';

      return `[Padrão ${i + 1}] Fase ${s.phase} | Resultado: ${outcomeLabel}${productInfo} | Similaridade: ${(s.similarity * 100).toFixed(0)}%\n${s.content_summary}`;
    });

    return `\n--- PADRÕES DE CONVERSAS SIMILARES (referência interna, NÃO mencionar ao lead) ---\n${contextParts.join('\n\n')}\n--- FIM DOS PADRÕES ---\n`;
  } catch (err) {
    console.error('[Embeddings] Failed to build context from similar conversations:', err.message);
    return '';
  }
}


export function resetCircuitBreaker() {
  circuitBreaker.failures = 0;
  circuitBreaker.disabledUntil = 0;
  console.log('[Embeddings] Circuit breaker RESET by Ana');
  return true;
}
