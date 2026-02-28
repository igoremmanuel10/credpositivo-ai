import { db } from '../db/client.js';
import { config } from '../config.js';

// Pricing per 1M tokens (USD) — updated Feb 2025
const PRICING = {
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
  'claude-sonnet-4-5-20250514': { input: 3.00, output: 15.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4o': { input: 2.50, output: 10.00 },
  'tts-1-hd': { perChar: 0.000030 },  // $30 per 1M chars
  'tts-1': { perChar: 0.000015 },
  'whisper-1': { perMinute: 0.006 },
};

// Daily cost alert threshold (USD)
const DAILY_ALERT_THRESHOLD = parseFloat(process.env.COST_ALERT_THRESHOLD || '5.00');

/**
 * Log an API call's token usage and estimated cost.
 */
export async function trackApiCost({
  provider,     // 'anthropic' | 'openai'
  model,        // model name
  inputTokens,  // number
  outputTokens, // number
  endpoint,     // 'chat' | 'vision' | 'tts' | 'transcribe'
  phone,        // lead phone (optional)
  durationMs,   // call duration in ms (optional)
}) {
  const pricing = PRICING[model] || PRICING['gpt-4o-mini'];
  let costUsd = 0;

  if (endpoint === 'tts' && pricing.perChar) {
    costUsd = (inputTokens || 0) * pricing.perChar; // inputTokens = char count for TTS
  } else if (endpoint === 'transcribe' && pricing.perMinute) {
    costUsd = ((durationMs || 0) / 60000) * pricing.perMinute;
  } else {
    costUsd = ((inputTokens || 0) / 1_000_000) * (pricing.input || 0)
            + ((outputTokens || 0) / 1_000_000) * (pricing.output || 0);
  }

  try {
    await db.query(
      `INSERT INTO api_costs (provider, model, endpoint, input_tokens, output_tokens, cost_usd, phone, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [provider, model, endpoint, inputTokens || 0, outputTokens || 0, costUsd, phone || null, durationMs || null]
    );
  } catch (err) {
    // Don't let cost tracking break the main flow
    console.error('[CostTracker] Failed to log cost:', err.message);
  }

  // Check daily threshold
  try {
    const { rows } = await db.query(
      `SELECT COALESCE(SUM(cost_usd), 0) as daily_total
       FROM api_costs
       WHERE created_at >= CURRENT_DATE`
    );
    const dailyTotal = parseFloat(rows[0].daily_total);

    if (dailyTotal > DAILY_ALERT_THRESHOLD) {
      console.warn(`[CostTracker] ALERT: Daily cost $${dailyTotal.toFixed(4)} exceeds threshold $${DAILY_ALERT_THRESHOLD}`);
    }
  } catch (err) {
    // Silently ignore threshold check errors
  }

  return costUsd;
}

/**
 * Get cost summary for a time period.
 */
export async function getCostSummary(days = 7) {
  try {
    const { rows } = await db.query(
      `SELECT
        DATE(created_at) as date,
        provider,
        model,
        endpoint,
        COUNT(*) as calls,
        SUM(input_tokens) as total_input,
        SUM(output_tokens) as total_output,
        SUM(cost_usd) as total_cost
       FROM api_costs
       WHERE created_at >= NOW() - INTERVAL '${days} days'
       GROUP BY DATE(created_at), provider, model, endpoint
       ORDER BY date DESC, total_cost DESC`
    );
    return rows;
  } catch (err) {
    console.error('[CostTracker] Failed to get summary:', err.message);
    return [];
  }
}
