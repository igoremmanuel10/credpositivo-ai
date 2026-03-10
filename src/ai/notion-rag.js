import { Client } from '@notionhq/client';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { generateEmbedding } from './embeddings.js';
import { trackApiCost } from '../monitoring/cost-tracker.js';

// ─── Constants ────────────────────────────────────────────────────────────────
const KNOWLEDGE_BASE_ID = '9a391df2-6203-4a98-8fdb-35c2e504b9a8';
const BATCH_SIZE = 10;           // Pages per batch (Notion rate limit: 3 req/s)
const BATCH_DELAY_MS = 1000;     // Delay between batches
const EMBEDDING_DELAY_MS = 200;  // Delay between embedding API calls
const MIN_SIMILARITY = 0.72;     // Minimum similarity threshold for search results

// Notion client
const notion = new Client({ auth: config.notion?.apiKey || process.env.NOTION_API_KEY });

// ─── Circuit Breaker (shared pattern with embeddings.js) ──────────────────────
const circuitBreaker = {
  failures: 0,
  maxFailures: 5,
  disabledUntil: 0,
  cooldownMs: 60 * 60 * 1000, // 1 hour
};

function isCircuitOpen() {
  if (circuitBreaker.failures < circuitBreaker.maxFailures) return false;
  if (Date.now() > circuitBreaker.disabledUntil) {
    circuitBreaker.failures = 0;
    console.log('[NotionRAG] Circuit breaker reset after cooldown');
    return false;
  }
  return true;
}

function recordFailure() {
  circuitBreaker.failures++;
  if (circuitBreaker.failures >= circuitBreaker.maxFailures) {
    circuitBreaker.disabledUntil = Date.now() + circuitBreaker.cooldownMs;
    console.warn(`[NotionRAG] Circuit breaker OPEN — ${circuitBreaker.maxFailures} failures. Disabled for 1h.`);
  }
}

function recordSuccess() {
  circuitBreaker.failures = 0;
}

// ─── Notion Page Fetching ─────────────────────────────────────────────────────

/**
 * Fetch all pages from the Knowledge Base database in Notion.
 * Returns basic page info (id, title, last_edited_time, category).
 *
 * @returns {Array<{id: string, title: string, category: string|null, lastEdited: string}>}
 */
async function fetchKnowledgeBasePages() {
  const pages = [];
  let cursor = undefined;

  try {
    do {
      const response = await notion.databases.query({
        database_id: KNOWLEDGE_BASE_ID,
        start_cursor: cursor,
        page_size: 100,
      });

      for (const page of response.results) {
        const title = extractPageTitle(page);
        const category = extractPageCategory(page);
        const lastEdited = page.last_edited_time;

        pages.push({
          id: page.id,
          title,
          category,
          lastEdited,
        });
      }

      cursor = response.has_more ? response.next_cursor : undefined;

      // Respect rate limits between paginated requests
      if (cursor) {
        await new Promise(r => setTimeout(r, 350));
      }
    } while (cursor);

    console.log(`[NotionRAG] Fetched ${pages.length} pages from Knowledge Base`);
    return pages;
  } catch (err) {
    console.error('[NotionRAG] Failed to fetch Knowledge Base pages:', err.message);
    throw err;
  }
}

/**
 * Extract page title from Notion page properties.
 * Tries common title property names.
 *
 * @param {object} page - Notion page object
 * @returns {string}
 */
function extractPageTitle(page) {
  const props = page.properties || {};

  // Try known title property names
  for (const key of ['Name', 'Título', 'Title', 'Nome']) {
    const prop = props[key];
    if (prop?.type === 'title' && prop.title?.length > 0) {
      return prop.title.map(t => t.plain_text).join('');
    }
  }

  // Fallback: find any title-type property
  for (const prop of Object.values(props)) {
    if (prop?.type === 'title' && prop.title?.length > 0) {
      return prop.title.map(t => t.plain_text).join('');
    }
  }

  return 'Sem título';
}

/**
 * Extract category from Notion page properties.
 * Looks for select/multi-select properties named Categoria, Category, etc.
 *
 * @param {object} page - Notion page object
 * @returns {string|null}
 */
function extractPageCategory(page) {
  const props = page.properties || {};

  for (const key of ['Categoria', 'Category', 'Tipo', 'Type', 'Tag']) {
    const prop = props[key];
    if (prop?.type === 'select' && prop.select?.name) {
      return prop.select.name;
    }
    if (prop?.type === 'multi_select' && prop.multi_select?.length > 0) {
      return prop.multi_select.map(s => s.name).join(', ');
    }
  }

  return null;
}

/**
 * Fetch all text content blocks from a Notion page.
 * Recursively fetches children to handle nested blocks.
 *
 * @param {string} pageId - Notion page ID
 * @returns {string} Concatenated text content
 */
async function fetchPageContent(pageId) {
  const textParts = [];

  try {
    let cursor = undefined;

    do {
      const response = await notion.blocks.children.list({
        block_id: pageId,
        start_cursor: cursor,
        page_size: 100,
      });

      for (const block of response.results) {
        const text = extractBlockText(block);
        if (text) {
          textParts.push(text);
        }

        // Fetch children for blocks that have them (toggle, callout, etc.)
        if (block.has_children) {
          const childText = await fetchPageContent(block.id);
          if (childText) {
            textParts.push(childText);
          }
          await new Promise(r => setTimeout(r, 150));
        }
      }

      cursor = response.has_more ? response.next_cursor : undefined;

      if (cursor) {
        await new Promise(r => setTimeout(r, 350));
      }
    } while (cursor);
  } catch (err) {
    console.error(`[NotionRAG] Failed to fetch content for page ${pageId}:`, err.message);
  }

  return textParts.join('\n');
}

/**
 * Extract plain text from a single Notion block.
 *
 * @param {object} block - Notion block object
 * @returns {string|null}
 */
function extractBlockText(block) {
  const type = block.type;

  // All text-bearing block types
  const textBlocks = [
    'paragraph', 'heading_1', 'heading_2', 'heading_3',
    'bulleted_list_item', 'numbered_list_item', 'to_do',
    'toggle', 'callout', 'quote',
  ];

  if (textBlocks.includes(type)) {
    const richText = block[type]?.rich_text || [];
    const text = richText.map(t => t.plain_text).join('');
    if (!text) return null;

    // Add prefix for headings
    if (type === 'heading_1') return `# ${text}`;
    if (type === 'heading_2') return `## ${text}`;
    if (type === 'heading_3') return `### ${text}`;
    if (type === 'to_do') {
      const checked = block.to_do?.checked ? '[x]' : '[ ]';
      return `${checked} ${text}`;
    }
    if (type === 'bulleted_list_item') return `- ${text}`;
    if (type === 'numbered_list_item') return `* ${text}`;

    return text;
  }

  // Code blocks
  if (type === 'code') {
    const code = block.code?.rich_text?.map(t => t.plain_text).join('') || '';
    const lang = block.code?.language || '';
    return code ? `\`\`\`${lang}\n${code}\n\`\`\`` : null;
  }

  // Table rows
  if (type === 'table_row') {
    const cells = block.table_row?.cells || [];
    return cells.map(cell => cell.map(t => t.plain_text).join('')).join(' | ');
  }

  return null;
}

// ─── Sync Pipeline ────────────────────────────────────────────────────────────

/**
 * Sync all Knowledge Base pages from Notion to pgvector embeddings.
 * Skips pages that haven't changed since last sync (by last_edited_time).
 * Designed for cron job use.
 *
 * @returns {{ total: number, synced: number, skipped: number, errors: number }}
 */
export async function syncNotionKnowledgeBase() {
  const stats = { total: 0, synced: 0, skipped: 0, errors: 0 };

  if (isCircuitOpen()) {
    console.warn('[NotionRAG] Circuit breaker open, skipping sync');
    return stats;
  }

  try {
    // 1. Fetch all pages from Notion
    const pages = await fetchKnowledgeBasePages();
    stats.total = pages.length;

    if (pages.length === 0) {
      console.log('[NotionRAG] No pages found in Knowledge Base');
      return stats;
    }

    // 2. Get existing sync state from DB
    const { rows: existing } = await db.query(
      `SELECT notion_page_id, notion_last_edited FROM knowledge_embeddings`
    );
    const syncedMap = new Map(existing.map(r => [r.notion_page_id, r.notion_last_edited]));

    // 3. Process pages in batches
    for (let i = 0; i < pages.length; i += BATCH_SIZE) {
      const batch = pages.slice(i, i + BATCH_SIZE);

      for (const page of batch) {
        try {
          // Check if page has changed since last sync
          const lastSynced = syncedMap.get(page.id);
          if (lastSynced) {
            const syncedDate = new Date(lastSynced).getTime();
            const editedDate = new Date(page.lastEdited).getTime();
            if (editedDate <= syncedDate) {
              stats.skipped++;
              continue;
            }
          }

          // Fetch full page content
          const content = await fetchPageContent(page.id);
          if (!content || content.trim().length === 0) {
            console.warn(`[NotionRAG] Page "${page.title}" has no text content, skipping`);
            stats.skipped++;
            continue;
          }

          // Build text for embedding: title + content
          const embeddingText = `${page.title}\n\n${content}`;

          // Generate embedding
          const embedding = await generateEmbedding(embeddingText);
          if (!embedding) {
            console.warn(`[NotionRAG] Failed to generate embedding for "${page.title}"`);
            stats.errors++;
            continue;
          }

          const vectorStr = `[${embedding.join(',')}]`;
          const metadata = {
            category: page.category,
            contentLength: content.length,
            syncedBy: 'notion-rag',
          };

          // Upsert into knowledge_embeddings
          await db.query(
            `INSERT INTO knowledge_embeddings
               (notion_page_id, title, category, content_text, embedding, metadata, synced_at, notion_last_edited)
             VALUES ($1, $2, $3, $4, $5::vector, $6, NOW(), $7)
             ON CONFLICT (notion_page_id)
             DO UPDATE SET
               title = EXCLUDED.title,
               category = EXCLUDED.category,
               content_text = EXCLUDED.content_text,
               embedding = EXCLUDED.embedding,
               metadata = EXCLUDED.metadata,
               synced_at = NOW(),
               notion_last_edited = EXCLUDED.notion_last_edited`,
            [page.id, page.title, page.category, content, vectorStr, JSON.stringify(metadata), page.lastEdited]
          );

          stats.synced++;
          recordSuccess();
          console.log(`[NotionRAG] Synced page "${page.title}" (${page.id})`);

          // Delay between embedding API calls
          await new Promise(r => setTimeout(r, EMBEDDING_DELAY_MS));
        } catch (err) {
          console.error(`[NotionRAG] Error syncing page "${page.title}" (${page.id}):`, err.message);
          recordFailure();
          stats.errors++;
        }
      }

      // Delay between batches
      if (i + BATCH_SIZE < pages.length) {
        await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
      }
    }

    console.log(`[NotionRAG] Sync completed: ${stats.synced} synced, ${stats.skipped} skipped, ${stats.errors} errors (${stats.total} total)`);
  } catch (err) {
    console.error('[NotionRAG] Sync job failed:', err.message);
    recordFailure();
  }

  return stats;
}

// ─── Search & RAG ─────────────────────────────────────────────────────────────

/**
 * Search the Knowledge Base by semantic similarity.
 *
 * @param {string} query - Search query text
 * @param {string|null} category - Optional category filter
 * @param {number} limit - Max results (default 5)
 * @returns {Array<{id: number, title: string, category: string, content_text: string, metadata: object, similarity: number}>}
 */
export async function searchKnowledge(query, category = null, limit = 5) {
  try {
    const embedding = await generateEmbedding(query);
    if (!embedding) {
      return [];
    }

    const vectorStr = `[${embedding.join(',')}]`;

    let sql;
    let params;

    if (category) {
      sql = `
        SELECT
          id,
          notion_page_id,
          title,
          category,
          content_text,
          metadata,
          1 - (embedding <=> $1::vector) AS similarity
        FROM knowledge_embeddings
        WHERE category = $2
        ORDER BY embedding <=> $1::vector
        LIMIT $3
      `;
      params = [vectorStr, category, limit];
    } else {
      sql = `
        SELECT
          id,
          notion_page_id,
          title,
          category,
          content_text,
          metadata,
          1 - (embedding <=> $1::vector) AS similarity
        FROM knowledge_embeddings
        ORDER BY embedding <=> $1::vector
        LIMIT $2
      `;
      params = [vectorStr, limit];
    }

    const { rows } = await db.query(sql, params);
    return rows;
  } catch (err) {
    console.error('[NotionRAG] Knowledge search failed:', err.message);
    return [];
  }
}

/**
 * Build a formatted knowledge context string for injection into the system prompt.
 * Similar to buildContextFromSimilar in embeddings.js.
 *
 * @param {string} query - Current conversation text to match against
 * @param {string|null} category - Optional category filter
 * @returns {string} Formatted context string, or empty string if no matches
 */
export async function buildKnowledgeContext(query, category = null) {
  try {
    const results = await searchKnowledge(query, category, 5);

    if (!results || results.length === 0) {
      return '';
    }

    // Only include results above minimum similarity threshold
    const relevant = results.filter(r => r.similarity >= MIN_SIMILARITY);

    if (relevant.length === 0) {
      return '';
    }

    const contextParts = relevant.map((r, i) => {
      const categoryLabel = r.category ? ` | Categoria: ${r.category}` : '';
      // Truncate content for prompt injection (max 1500 chars per article)
      const content = r.content_text.length > 1500
        ? r.content_text.substring(0, 1500) + '...'
        : r.content_text;

      return `[Artigo ${i + 1}] ${r.title}${categoryLabel} | Relevância: ${(r.similarity * 100).toFixed(0)}%\n${content}`;
    });

    return `\n--- BASE DE CONHECIMENTO (referência interna, NÃO copiar texto literalmente ao lead) ---\n${contextParts.join('\n\n')}\n--- FIM DA BASE DE CONHECIMENTO ---\n`;
  } catch (err) {
    console.error('[NotionRAG] Failed to build knowledge context:', err.message);
    return '';
  }
}
