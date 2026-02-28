import { Router } from 'express';
import { db } from '../db/client.js';
import { invalidateTestsCache } from '../ab/manager.js';

export const abTestsRouter = Router();

/**
 * GET /api/admin/ab-tests — List all A/B tests.
 */
abTestsRouter.get('/api/admin/ab-tests', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM ab_tests ORDER BY created_at DESC'
    );
    res.json({ tests: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/ab-tests — Create a new A/B test.
 *
 * Body: { name, description?, target, persona?, variants: [{name, weight, prompt_override}] }
 */
abTestsRouter.post('/api/admin/ab-tests', async (req, res) => {
  try {
    const { name, description, target, persona, variants } = req.body;

    if (!name || !target || !variants || variants.length < 2) {
      return res.status(400).json({
        error: 'Required: name, target, variants (min 2)',
        valid_targets: ['greeting', 'investigation', 'education', 'closing', 'sdr_greeting', 'sdr_objection'],
      });
    }

    const { rows } = await db.query(
      `INSERT INTO ab_tests (name, description, target, persona, variants)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name, description || null, target, persona || 'augusto', JSON.stringify(variants)]
    );

    invalidateTestsCache();
    res.json({ test: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/admin/ab-tests/:id — Update a test (activate/deactivate, change variants).
 */
abTestsRouter.put('/api/admin/ab-tests/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { active, name, description, variants, ended_at } = req.body;

    const fields = [];
    const values = [];
    let idx = 1;

    if (active !== undefined) { fields.push(`active = $${idx}`); values.push(active); idx++; }
    if (name !== undefined) { fields.push(`name = $${idx}`); values.push(name); idx++; }
    if (description !== undefined) { fields.push(`description = $${idx}`); values.push(description); idx++; }
    if (variants !== undefined) { fields.push(`variants = $${idx}`); values.push(JSON.stringify(variants)); idx++; }
    if (ended_at !== undefined) { fields.push(`ended_at = $${idx}`); values.push(ended_at); idx++; }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    values.push(id);
    const { rows } = await db.query(
      `UPDATE ab_tests SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Test not found' });
    }

    invalidateTestsCache();
    res.json({ test: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/ab-tests/:id/results — Get results for a specific test.
 * Shows per-variant conversion metrics.
 */
abTestsRouter.get('/api/admin/ab-tests/:id/results', async (req, res) => {
  try {
    const { id } = req.params;

    // Get the test
    const { rows: testRows } = await db.query('SELECT * FROM ab_tests WHERE id = $1', [id]);
    if (testRows.length === 0) {
      return res.status(404).json({ error: 'Test not found' });
    }

    const test = testRows[0];

    // Get per-variant metrics
    const { rows } = await db.query(`
      SELECT
        a.variant,
        COUNT(*) as total_conversations,
        COUNT(*) FILTER (WHERE c.phase >= 2) as reached_investigation,
        COUNT(*) FILTER (WHERE c.phase >= 3) as reached_education,
        COUNT(*) FILTER (WHERE c.phase >= 4) as reached_site,
        COUNT(*) FILTER (WHERE c.recommended_product IS NOT NULL) as got_product_rec,
        COUNT(*) FILTER (WHERE c.opted_out = true) as opted_out,
        ROUND(AVG(c.phase)::numeric, 2) as avg_phase,
        ROUND(AVG(EXTRACT(EPOCH FROM (c.updated_at - c.created_at)) / 60)::numeric, 1) as avg_duration_min,
        COUNT(DISTINCT m_count.conversation_id) FILTER (WHERE m_count.msg_count > 3) as engaged_conversations
      FROM ab_assignments a
      JOIN conversations c ON c.id = a.conversation_id
      LEFT JOIN (
        SELECT conversation_id, COUNT(*) as msg_count
        FROM messages
        WHERE role = 'user'
        GROUP BY conversation_id
      ) m_count ON m_count.conversation_id = c.id
      WHERE a.test_id = $1
      GROUP BY a.variant
      ORDER BY a.variant
    `, [id]);

    // Calculate conversion rates
    const results = rows.map(r => {
      const total = parseInt(r.total_conversations);
      return {
        variant: r.variant,
        total_conversations: total,
        reached_investigation: parseInt(r.reached_investigation),
        reached_education: parseInt(r.reached_education),
        reached_site: parseInt(r.reached_site),
        got_product_rec: parseInt(r.got_product_rec),
        opted_out: parseInt(r.opted_out),
        avg_phase: parseFloat(r.avg_phase),
        avg_duration_min: parseFloat(r.avg_duration_min),
        engaged_conversations: parseInt(r.engaged_conversations || 0),
        conversion_rate_investigation: total > 0 ? Math.round((parseInt(r.reached_investigation) / total) * 100) : 0,
        conversion_rate_site: total > 0 ? Math.round((parseInt(r.reached_site) / total) * 100) : 0,
        opt_out_rate: total > 0 ? Math.round((parseInt(r.opted_out) / total) * 100) : 0,
      };
    });

    res.json({ test, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/admin/ab-tests/:id — Delete a test and its assignments.
 */
abTestsRouter.delete('/api/admin/ab-tests/:id', async (req, res) => {
  try {
    const { id } = req.params;

    await db.query('DELETE FROM ab_assignments WHERE test_id = $1', [id]);
    const { rowCount } = await db.query('DELETE FROM ab_tests WHERE id = $1', [id]);

    if (rowCount === 0) {
      return res.status(404).json({ error: 'Test not found' });
    }

    invalidateTestsCache();
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
