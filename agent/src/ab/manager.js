/**
 * A/B Test Manager
 *
 * Handles variant assignment and retrieval for prompt experiments.
 * Each conversation is assigned to one variant per active test.
 * Assignment is persistent (same lead always gets same variant).
 *
 * Targets: sections of the system prompt that can be overridden.
 * - greeting (phase 0-1)
 * - investigation (phase 2)
 * - education (phase 3)
 * - closing (phase 4+)
 * - sdr_greeting (Paulo phase 1)
 * - sdr_objection (Paulo phase 3)
 */

import { db } from '../db/client.js';

/**
 * Get all active A/B tests for a given persona.
 * Cached in memory for 60 seconds to avoid DB hits on every message.
 */
let activeTestsCache = null;
let activeTestsCacheTime = 0;
const CACHE_TTL_MS = 60_000;

async function getActiveTests() {
  const now = Date.now();
  if (activeTestsCache && now - activeTestsCacheTime < CACHE_TTL_MS) {
    return activeTestsCache;
  }

  try {
    const { rows } = await db.query(
      'SELECT * FROM ab_tests WHERE active = true ORDER BY id'
    );
    activeTestsCache = rows;
    activeTestsCacheTime = now;
    return rows;
  } catch (err) {
    // If table doesn't exist yet, return empty
    if (err.message.includes('ab_tests')) return [];
    throw err;
  }
}

/**
 * Invalidate the active tests cache (after creating/updating tests).
 */
export function invalidateTestsCache() {
  activeTestsCache = null;
  activeTestsCacheTime = 0;
}

/**
 * Assign a conversation to variants for all active tests.
 * Uses weighted random selection. Assignment is idempotent.
 *
 * @param {number} conversationId
 * @param {string} persona - 'augusto' or 'paulo'
 * @returns {Object} Map of target → variant name
 */
export async function assignVariants(conversationId, persona = 'augusto') {
  const tests = await getActiveTests();
  if (tests.length === 0) return {};

  const assignments = {};

  for (const test of tests) {
    // Skip if test doesn't apply to this persona
    if (test.persona !== 'both' && test.persona !== persona) continue;

    // Check if already assigned
    try {
      const { rows: existing } = await db.query(
        'SELECT variant FROM ab_assignments WHERE conversation_id = $1 AND test_id = $2',
        [conversationId, test.id]
      );

      if (existing.length > 0) {
        assignments[test.target] = existing[0].variant;
        continue;
      }
    } catch {
      continue;
    }

    // Assign new variant (weighted random)
    const variants = test.variants || [];
    if (variants.length === 0) continue;

    const chosen = weightedRandom(variants);

    try {
      await db.query(
        'INSERT INTO ab_assignments (conversation_id, test_id, variant) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [conversationId, test.id, chosen.name]
      );
      assignments[test.target] = chosen.name;
    } catch {
      // Ignore insert errors (race condition)
    }
  }

  return assignments;
}

/**
 * Get prompt override for a specific target, given the conversation's assignments.
 *
 * @param {Object} assignments - Map from assignVariants()
 * @param {string} target - Prompt section name
 * @returns {string|null} Override prompt text, or null if no override (use default)
 */
export async function getPromptOverride(assignments, target) {
  if (!assignments[target]) return null;

  const tests = await getActiveTests();
  const test = tests.find(t => t.target === target && t.active);
  if (!test) return null;

  const variant = (test.variants || []).find(v => v.name === assignments[target]);
  if (!variant || !variant.prompt_override) return null;

  return variant.prompt_override;
}

/**
 * Weighted random selection from variants array.
 * Each variant has { name, weight, prompt_override }.
 */
function weightedRandom(variants) {
  const totalWeight = variants.reduce((sum, v) => sum + (v.weight || 1), 0);
  let random = Math.random() * totalWeight;

  for (const variant of variants) {
    random -= (variant.weight || 1);
    if (random <= 0) return variant;
  }

  return variants[variants.length - 1];
}
