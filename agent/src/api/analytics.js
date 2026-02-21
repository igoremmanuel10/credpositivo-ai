import { Router } from 'express';
import { db } from '../db/client.js';

export const analyticsRouter = Router();

/**
 * GET /api/admin/analytics/overview
 * General metrics: total conversations, messages, costs, conversions.
 */
analyticsRouter.get('/api/admin/analytics/overview', async (req, res) => {
  try {
    const days = parseInt(req.query.days || '30');

    const [convos, msgs, costs, phases] = await Promise.all([
      db.query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '${days} days') as recent,
          COUNT(*) FILTER (WHERE persona = 'augusto') as augusto,
          COUNT(*) FILTER (WHERE persona = 'paulo') as paulo,
          COUNT(*) FILTER (WHERE opted_out = true) as opted_out
        FROM conversations
      `),
      db.query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE role = 'user') as from_users,
          COUNT(*) FILTER (WHERE role = 'agent') as from_agent,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '${days} days') as recent
        FROM messages
      `),
      db.query(`
        SELECT
          COALESCE(SUM(cost_usd), 0) as total_cost,
          COALESCE(SUM(input_tokens), 0) as total_input_tokens,
          COALESCE(SUM(output_tokens), 0) as total_output_tokens,
          COUNT(*) as total_calls
        FROM api_costs
        WHERE created_at >= NOW() - INTERVAL '${days} days'
      `),
      db.query(`
        SELECT phase, COUNT(*) as count
        FROM conversations
        GROUP BY phase
        ORDER BY phase
      `),
    ]);

    res.json({
      period_days: days,
      conversations: convos.rows[0],
      messages: msgs.rows[0],
      costs: costs.rows[0],
      funnel: phases.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/analytics/funnel
 * Conversion funnel: how many leads at each phase.
 */
analyticsRouter.get('/api/admin/analytics/funnel', async (req, res) => {
  try {
    const days = parseInt(req.query.days || '30');

    const { rows } = await db.query(`
      SELECT
        phase,
        COUNT(*) as count,
        COUNT(*) FILTER (WHERE recommended_product IS NOT NULL) as with_product,
        COUNT(*) FILTER (WHERE opted_out = true) as dropped_out,
        ROUND(AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 60)::numeric, 1) as avg_duration_min
      FROM conversations
      WHERE created_at >= NOW() - INTERVAL '${days} days'
      GROUP BY phase
      ORDER BY phase
    `);

    const total = rows.reduce((sum, r) => sum + parseInt(r.count), 0);

    res.json({
      period_days: days,
      total_conversations: total,
      phases: rows.map(r => ({
        ...r,
        pct: total > 0 ? Math.round((parseInt(r.count) / total) * 100) : 0,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/analytics/daily
 * Daily conversation and message counts.
 */
analyticsRouter.get('/api/admin/analytics/daily', async (req, res) => {
  try {
    const days = parseInt(req.query.days || '14');

    const { rows } = await db.query(`
      SELECT
        DATE(created_at) as date,
        COUNT(DISTINCT conversation_id) as active_conversations,
        COUNT(*) FILTER (WHERE role = 'user') as user_messages,
        COUNT(*) FILTER (WHERE role = 'agent') as agent_messages
      FROM messages
      WHERE created_at >= NOW() - INTERVAL '${days} days'
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `);

    res.json({ period_days: days, daily: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/analytics/products
 * Product recommendation distribution.
 */
analyticsRouter.get('/api/admin/analytics/products', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        COALESCE(recommended_product, 'none') as product,
        COUNT(*) as count,
        COUNT(*) FILTER (WHERE phase >= 4) as reached_site,
        COUNT(*) FILTER (WHERE opted_out = true) as dropped
      FROM conversations
      GROUP BY recommended_product
      ORDER BY count DESC
    `);

    res.json({ products: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/analytics/conversations
 * Recent conversations with details.
 */
analyticsRouter.get('/api/admin/analytics/conversations', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50'), 100);
    const offset = parseInt(req.query.offset || '0');
    const phase = req.query.phase;

    let where = '';
    const params = [];
    let idx = 1;

    if (phase !== undefined && phase !== '') {
      where = `WHERE c.phase = $${idx}`;
      params.push(parseInt(phase));
      idx++;
    }

    params.push(limit, offset);

    const { rows } = await db.query(`
      SELECT
        c.id, c.phone, c.name, c.phase, c.persona,
        c.recommended_product, c.opted_out,
        c.created_at, c.updated_at, c.last_message_at,
        (SELECT COUNT(*)::int FROM messages m WHERE m.conversation_id = c.id) as message_count
      FROM conversations c
      ${where}
      ORDER BY c.last_message_at DESC NULLS LAST
      LIMIT $${idx} OFFSET $${idx + 1}
    `, params);

    const { rows: countRows } = await db.query(
      `SELECT COUNT(*)::int as total FROM conversations c ${where}`,
      phase !== undefined && phase !== '' ? [parseInt(phase)] : []
    );

    res.json({
      total: countRows[0]?.total || 0,
      limit,
      offset,
      conversations: rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/analytics/costs-daily
 * Daily API cost breakdown.
 */
analyticsRouter.get('/api/admin/analytics/costs-daily', async (req, res) => {
  try {
    const days = parseInt(req.query.days || '14');

    const { rows } = await db.query(`
      SELECT
        DATE(created_at) as date,
        provider,
        model,
        COUNT(*) as calls,
        COALESCE(SUM(cost_usd), 0)::numeric(10,4) as cost_usd,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens
      FROM api_costs
      WHERE created_at >= NOW() - INTERVAL '${days} days'
      GROUP BY DATE(created_at), provider, model
      ORDER BY date DESC, cost_usd DESC
    `);

    res.json({ period_days: days, daily_costs: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
