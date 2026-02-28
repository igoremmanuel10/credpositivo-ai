/**
 * Performance Analytics API
 *
 * Advanced metrics for agent performance analysis:
 * - Agent comparison (Augusto vs Paulo)
 * - Response time heatmap by hour
 * - Lead health scoring
 * - Cooling leads alerts
 * - Engagement by message type
 */

import { Router } from 'express';
import { db } from '../db/client.js';
import { sendMediaBase64, sendText, resolveWhatsAppId } from '../quepasa/client.js';
import { getFollowupAudio } from '../media/assets.js';

export const performanceRouter = Router();

/**
 * GET /api/admin/analytics/agent-performance
 * Side-by-side comparison of Augusto vs Paulo across all key metrics.
 */
performanceRouter.get('/api/admin/analytics/agent-performance', async (req, res) => {
  try {
    const days = parseInt(req.query.days || '30');

    const { rows } = await db.query(`
      WITH agent_stats AS (
        SELECT
          c.persona,
          COUNT(DISTINCT c.id) as total_conversations,
          COUNT(DISTINCT c.id) FILTER (WHERE c.phase >= 2) as reached_investigation,
          COUNT(DISTINCT c.id) FILTER (WHERE c.phase >= 3) as reached_education,
          COUNT(DISTINCT c.id) FILTER (WHERE c.phase >= 4) as reached_site,
          COUNT(DISTINCT c.id) FILTER (WHERE c.phase >= 5) as reached_followup,
          COUNT(DISTINCT c.id) FILTER (WHERE c.opted_out = true) as opted_out,
          COUNT(DISTINCT c.id) FILTER (WHERE c.recommended_product IS NOT NULL) as with_product,
          ROUND(AVG(c.phase)::numeric, 2) as avg_phase,
          ROUND(AVG(EXTRACT(EPOCH FROM (c.updated_at - c.created_at)) / 3600)::numeric, 1) as avg_duration_hours
        FROM conversations c
        WHERE c.created_at >= NOW() - INTERVAL '1 day' * $1
        GROUP BY c.persona
      ),
      agent_messages AS (
        SELECT
          c.persona,
          COUNT(*) FILTER (WHERE m.role = 'user') as user_messages,
          COUNT(*) FILTER (WHERE m.role = 'agent') as agent_messages,
          ROUND(AVG(m.response_time_seconds) FILTER (WHERE m.role = 'agent' AND m.response_time_seconds IS NOT NULL AND m.response_time_seconds > 0)::numeric, 1) as avg_response_time_sec,
          ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY m.response_time_seconds) FILTER (WHERE m.role = 'agent' AND m.response_time_seconds IS NOT NULL AND m.response_time_seconds > 0)::numeric, 1) as median_response_time_sec
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE m.created_at >= NOW() - INTERVAL '1 day' * $1
        GROUP BY c.persona
      ),
      agent_engagement AS (
        SELECT
          c.persona,
          COUNT(DISTINCT c.id) FILTER (WHERE user_msg_count >= 3) as engaged_leads,
          ROUND(AVG(user_msg_count)::numeric, 1) as avg_user_messages_per_conv
        FROM conversations c
        LEFT JOIN (
          SELECT conversation_id, COUNT(*) as user_msg_count
          FROM messages WHERE role = 'user'
          GROUP BY conversation_id
        ) mc ON mc.conversation_id = c.id
        WHERE c.created_at >= NOW() - INTERVAL '1 day' * $1
        GROUP BY c.persona
      )
      SELECT
        s.*,
        m.user_messages, m.agent_messages,
        m.avg_response_time_sec, m.median_response_time_sec,
        e.engaged_leads, e.avg_user_messages_per_conv,
        CASE WHEN s.total_conversations > 0
          THEN ROUND((s.reached_site::numeric / s.total_conversations) * 100, 1)
          ELSE 0 END as conversion_rate_site,
        CASE WHEN s.total_conversations > 0
          THEN ROUND((s.opted_out::numeric / s.total_conversations) * 100, 1)
          ELSE 0 END as opt_out_rate,
        CASE WHEN s.total_conversations > 0
          THEN ROUND((e.engaged_leads::numeric / s.total_conversations) * 100, 1)
          ELSE 0 END as engagement_rate
      FROM agent_stats s
      LEFT JOIN agent_messages m ON m.persona = s.persona
      LEFT JOIN agent_engagement e ON e.persona = s.persona
      ORDER BY s.persona
    `, [days]);

    // Phase-by-phase breakdown per agent
    const { rows: phaseBreakdown } = await db.query(`
      SELECT
        c.persona,
        c.phase,
        COUNT(*) as count,
        COUNT(*) FILTER (WHERE c.opted_out = true) as dropped
      FROM conversations c
      WHERE c.created_at >= NOW() - INTERVAL '1 day' * $1
      GROUP BY c.persona, c.phase
      ORDER BY c.persona, c.phase
    `, [days]);

    // Daily trend per agent
    const { rows: dailyTrend } = await db.query(`
      SELECT
        DATE(c.created_at) as date,
        c.persona,
        COUNT(*) as new_conversations,
        COUNT(*) FILTER (WHERE c.phase >= 4) as converted
      FROM conversations c
      WHERE c.created_at >= NOW() - INTERVAL '1 day' * $1
      GROUP BY DATE(c.created_at), c.persona
      ORDER BY date
    `, [days]);

    res.json({
      period_days: days,
      agents: rows,
      phase_breakdown: phaseBreakdown,
      daily_trend: dailyTrend,
    });
  } catch (err) {
    console.error('[Analytics] Agent performance error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/analytics/response-heatmap
 * Heatmap of when leads respond most, grouped by hour and day of week.
 */
performanceRouter.get('/api/admin/analytics/response-heatmap', async (req, res) => {
  try {
    const days = parseInt(req.query.days || '30');

    // User messages by hour and day of week (Brasilia timezone)
    const { rows: heatmap } = await db.query(`
      SELECT
        EXTRACT(DOW FROM m.created_at AT TIME ZONE 'America/Sao_Paulo') as day_of_week,
        EXTRACT(HOUR FROM m.created_at AT TIME ZONE 'America/Sao_Paulo') as hour,
        COUNT(*) as message_count,
        COUNT(DISTINCT m.conversation_id) as unique_conversations
      FROM messages m
      WHERE m.role = 'user'
        AND m.created_at >= NOW() - INTERVAL '1 day' * $1
      GROUP BY
        EXTRACT(DOW FROM m.created_at AT TIME ZONE 'America/Sao_Paulo'),
        EXTRACT(HOUR FROM m.created_at AT TIME ZONE 'America/Sao_Paulo')
      ORDER BY day_of_week, hour
    `, [days]);

    // Best and worst hours
    const { rows: bestHours } = await db.query(`
      SELECT
        EXTRACT(HOUR FROM m.created_at AT TIME ZONE 'America/Sao_Paulo') as hour,
        COUNT(*) as message_count,
        COUNT(DISTINCT m.conversation_id) as unique_leads
      FROM messages m
      WHERE m.role = 'user'
        AND m.created_at >= NOW() - INTERVAL '1 day' * $1
      GROUP BY EXTRACT(HOUR FROM m.created_at AT TIME ZONE 'America/Sao_Paulo')
      ORDER BY message_count DESC
    `, [days]);

    // Response rate by hour (% of agent messages that got a user reply within 1 hour)
    const { rows: responseRateByHour } = await db.query(`
      SELECT
        EXTRACT(HOUR FROM m.created_at AT TIME ZONE 'America/Sao_Paulo') as hour,
        COUNT(*) as agent_messages,
        COUNT(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM messages m2
          WHERE m2.conversation_id = m.conversation_id
            AND m2.role = 'user'
            AND m2.created_at > m.created_at
            AND m2.created_at < m.created_at + INTERVAL '1 hour'
        )) as got_reply_within_1h,
        ROUND(
          COUNT(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM messages m2
            WHERE m2.conversation_id = m.conversation_id
              AND m2.role = 'user'
              AND m2.created_at > m.created_at
              AND m2.created_at < m.created_at + INTERVAL '1 hour'
          ))::numeric / NULLIF(COUNT(*), 0) * 100, 1
        ) as reply_rate_pct
      FROM messages m
      WHERE m.role = 'agent'
        AND m.created_at >= NOW() - INTERVAL '1 day' * $1
      GROUP BY EXTRACT(HOUR FROM m.created_at AT TIME ZONE 'America/Sao_Paulo')
      ORDER BY hour
    `, [days]);

    res.json({
      period_days: days,
      heatmap,
      hours_ranked: bestHours,
      response_rate_by_hour: responseRateByHour,
    });
  } catch (err) {
    console.error('[Analytics] Heatmap error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/analytics/lead-health
 * Lead health scores with recommendations.
 * Score 0-100 based on: recency, engagement, phase progression, response speed.
 */
performanceRouter.get('/api/admin/analytics/lead-health', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50'), 200);
    const filter = req.query.filter || 'all'; // all, hot, warm, cold, dead

    const { rows } = await db.query(`
      WITH lead_metrics AS (
        SELECT
          c.id, c.phone, c.name, c.phase, c.persona, c.opted_out,
          c.recommended_product, c.created_at, c.last_message_at,
          -- Recency: hours since last message
          EXTRACT(EPOCH FROM (NOW() - c.last_message_at)) / 3600 as hours_since_last,
          -- Message counts
          (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user') as user_msg_count,
          (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'agent') as agent_msg_count,
          -- Avg response time from user (how fast they reply to agent)
          (SELECT ROUND(AVG(
            EXTRACT(EPOCH FROM (m2.created_at - (
              SELECT MAX(m3.created_at) FROM messages m3
              WHERE m3.conversation_id = c.id AND m3.role = 'agent' AND m3.created_at < m2.created_at
            )))
          )::numeric, 0)
          FROM messages m2
          WHERE m2.conversation_id = c.id AND m2.role = 'user'
            AND EXISTS (SELECT 1 FROM messages m3 WHERE m3.conversation_id = c.id AND m3.role = 'agent' AND m3.created_at < m2.created_at)
          ) as avg_user_response_sec
        FROM conversations c
        WHERE c.opted_out IS NOT TRUE
          AND c.last_message_at IS NOT NULL
      ),
      scored AS (
        SELECT *,
          -- Health Score Calculation (0-100):
          -- Recency (40 points): Full if < 1h, 0 if > 72h
          GREATEST(0, LEAST(40, 40 - (hours_since_last / 72.0 * 40)))::INTEGER as recency_score,
          -- Engagement (25 points): Based on user message count
          LEAST(25, (user_msg_count * 5))::INTEGER as engagement_score,
          -- Phase Progression (20 points): Higher phase = more points
          LEAST(20, (phase * 4))::INTEGER as phase_score,
          -- Response Speed (15 points): Fast responders get more
          CASE
            WHEN avg_user_response_sec IS NULL THEN 5
            WHEN avg_user_response_sec < 300 THEN 15  -- < 5 min
            WHEN avg_user_response_sec < 1800 THEN 12  -- < 30 min
            WHEN avg_user_response_sec < 3600 THEN 8   -- < 1 hour
            WHEN avg_user_response_sec < 86400 THEN 4  -- < 1 day
            ELSE 0
          END as speed_score
        FROM lead_metrics
      )
      SELECT *,
        (recency_score + engagement_score + phase_score + speed_score) as health_score,
        CASE
          WHEN (recency_score + engagement_score + phase_score + speed_score) >= 70 THEN 'hot'
          WHEN (recency_score + engagement_score + phase_score + speed_score) >= 40 THEN 'warm'
          WHEN (recency_score + engagement_score + phase_score + speed_score) >= 20 THEN 'cold'
          ELSE 'dead'
        END as health_status
      FROM scored
      ${filter !== 'all' ? `WHERE CASE
        WHEN (recency_score + engagement_score + phase_score + speed_score) >= 70 THEN 'hot'
        WHEN (recency_score + engagement_score + phase_score + speed_score) >= 40 THEN 'warm'
        WHEN (recency_score + engagement_score + phase_score + speed_score) >= 20 THEN 'cold'
        ELSE 'dead'
      END = '${filter}'` : ''}
      ORDER BY (recency_score + engagement_score + phase_score + speed_score) DESC
      LIMIT $1
    `, [limit]);

    // Summary counts
    const { rows: summary } = await db.query(`
      WITH scored AS (
        SELECT c.id,
          GREATEST(0, LEAST(40, 40 - (EXTRACT(EPOCH FROM (NOW() - c.last_message_at)) / 3600 / 72.0 * 40)))::INTEGER
          + LEAST(25, ((SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user') * 5))::INTEGER
          + LEAST(20, (c.phase * 4))::INTEGER
          + 5 as score
        FROM conversations c
        WHERE c.opted_out IS NOT TRUE AND c.last_message_at IS NOT NULL
      )
      SELECT
        COUNT(*) FILTER (WHERE score >= 70) as hot,
        COUNT(*) FILTER (WHERE score >= 40 AND score < 70) as warm,
        COUNT(*) FILTER (WHERE score >= 20 AND score < 40) as cold,
        COUNT(*) FILTER (WHERE score < 20) as dead,
        ROUND(AVG(score)::numeric, 1) as avg_score
      FROM scored
    `);

    res.json({
      summary: summary[0],
      leads: rows,
    });
  } catch (err) {
    console.error('[Analytics] Lead health error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/analytics/cooling-leads
 * Leads that are going cold — need immediate attention.
 * Shows leads with decreasing engagement that haven't opted out.
 */
performanceRouter.get('/api/admin/analytics/cooling-leads', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        c.id, c.phone, c.name, c.phase, c.persona,
        c.recommended_product, c.last_message_at,
        EXTRACT(EPOCH FROM (NOW() - c.last_message_at)) / 3600 as hours_silent,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user') as user_msgs,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'agent') as agent_msgs,
        (SELECT m.role FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) as last_message_role,
        CASE
          WHEN EXTRACT(EPOCH FROM (NOW() - c.last_message_at)) / 3600 > 48 THEN 'critical'
          WHEN EXTRACT(EPOCH FROM (NOW() - c.last_message_at)) / 3600 > 24 THEN 'warning'
          WHEN EXTRACT(EPOCH FROM (NOW() - c.last_message_at)) / 3600 > 6 THEN 'attention'
          ELSE 'ok'
        END as urgency,
        CASE
          WHEN c.phase <= 1 AND EXTRACT(EPOCH FROM (NOW() - c.last_message_at)) / 3600 > 6 THEN 'Enviar audio de apresentacao'
          WHEN c.phase = 2 AND EXTRACT(EPOCH FROM (NOW() - c.last_message_at)) / 3600 > 12 THEN 'Enviar prova social'
          WHEN c.phase = 3 AND EXTRACT(EPOCH FROM (NOW() - c.last_message_at)) / 3600 > 24 THEN 'Enviar audio de urgencia'
          WHEN EXTRACT(EPOCH FROM (NOW() - c.last_message_at)) / 3600 > 48 THEN 'Enviar audio de reativacao'
          WHEN EXTRACT(EPOCH FROM (NOW() - c.last_message_at)) / 3600 > 24 THEN 'Enviar follow-up personalizado'
          WHEN EXTRACT(EPOCH FROM (NOW() - c.last_message_at)) / 3600 > 6 THEN 'Aguardar mais um pouco'
          ELSE 'Lead ativo'
        END as recommended_action
      FROM conversations c
      WHERE c.opted_out IS NOT TRUE
        AND c.phase BETWEEN 0 AND 4
        AND c.last_message_at < NOW() - INTERVAL '4 hours'
        AND (SELECT m.role FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) = 'agent'
      ORDER BY
        CASE
          WHEN EXTRACT(EPOCH FROM (NOW() - c.last_message_at)) / 3600 > 48 THEN 1
          WHEN EXTRACT(EPOCH FROM (NOW() - c.last_message_at)) / 3600 > 24 THEN 2
          WHEN EXTRACT(EPOCH FROM (NOW() - c.last_message_at)) / 3600 > 6 THEN 3
          ELSE 4
        END,
        c.phase DESC,
        c.last_message_at ASC
      LIMIT 100
    `);

    // Summary
    const critical = rows.filter(r => r.urgency === 'critical').length;
    const warning = rows.filter(r => r.urgency === 'warning').length;
    const attention = rows.filter(r => r.urgency === 'attention').length;

    res.json({
      summary: { critical, warning, attention, total: rows.length },
      leads: rows,
    });
  } catch (err) {
    console.error('[Analytics] Cooling leads error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/analytics/engagement-by-type
 * Engagement metrics broken down by message type.
 * Shows which types of content (text, audio, video, social proof) perform best.
 */
performanceRouter.get('/api/admin/analytics/engagement-by-type', async (req, res) => {
  try {
    const days = parseInt(req.query.days || '30');

    // Message type distribution
    const { rows: typeDistribution } = await db.query(`
      SELECT
        COALESCE(m.message_type, 'text') as message_type,
        m.role,
        COUNT(*) as count
      FROM messages m
      WHERE m.created_at >= NOW() - INTERVAL '1 day' * $1
      GROUP BY m.message_type, m.role
      ORDER BY count DESC
    `, [days]);

    // Engagement after agent message by type
    // (did the user reply within 1 hour after receiving a message of this type?)
    const { rows: engagementByType } = await db.query(`
      SELECT
        COALESCE(m.message_type, 'text') as message_type,
        COUNT(*) as total_sent,
        COUNT(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM messages m2
          WHERE m2.conversation_id = m.conversation_id
            AND m2.role = 'user'
            AND m2.created_at > m.created_at
            AND m2.created_at < m.created_at + INTERVAL '1 hour'
        )) as got_reply_1h,
        COUNT(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM messages m2
          WHERE m2.conversation_id = m.conversation_id
            AND m2.role = 'user'
            AND m2.created_at > m.created_at
            AND m2.created_at < m.created_at + INTERVAL '24 hours'
        )) as got_reply_24h,
        ROUND(
          COUNT(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM messages m2
            WHERE m2.conversation_id = m.conversation_id
              AND m2.role = 'user'
              AND m2.created_at > m.created_at
              AND m2.created_at < m.created_at + INTERVAL '1 hour'
          ))::numeric / NULLIF(COUNT(*), 0) * 100, 1
        ) as reply_rate_1h_pct,
        ROUND(
          COUNT(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM messages m2
            WHERE m2.conversation_id = m.conversation_id
              AND m2.role = 'user'
              AND m2.created_at > m.created_at
              AND m2.created_at < m.created_at + INTERVAL '24 hours'
          ))::numeric / NULLIF(COUNT(*), 0) * 100, 1
        ) as reply_rate_24h_pct
      FROM messages m
      WHERE m.role = 'agent'
        AND m.created_at >= NOW() - INTERVAL '1 day' * $1
      GROUP BY m.message_type
      ORDER BY reply_rate_1h_pct DESC NULLS LAST
    `, [days]);

    // Messages per conversation: ratio agent:user
    const { rows: ratioData } = await db.query(`
      SELECT
        c.persona,
        ROUND(AVG(agent_count)::numeric, 1) as avg_agent_msgs,
        ROUND(AVG(user_count)::numeric, 1) as avg_user_msgs,
        ROUND(AVG(agent_count::numeric / NULLIF(user_count, 0))::numeric, 2) as agent_user_ratio
      FROM conversations c
      LEFT JOIN (
        SELECT conversation_id,
          COUNT(*) FILTER (WHERE role = 'agent') as agent_count,
          COUNT(*) FILTER (WHERE role = 'user') as user_count
        FROM messages GROUP BY conversation_id
      ) mc ON mc.conversation_id = c.id
      WHERE c.created_at >= NOW() - INTERVAL '1 day' * $1
      GROUP BY c.persona
    `, [days]);

    res.json({
      period_days: days,
      type_distribution: typeDistribution,
      engagement_by_type: engagementByType,
      message_ratio: ratioData,
    });
  } catch (err) {
    console.error('[Analytics] Engagement by type error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/analytics/ab-overview
 * Quick overview of all A/B tests with summary results.
 */
performanceRouter.get('/api/admin/analytics/ab-overview', async (req, res) => {
  try {
    const { rows: tests } = await db.query(`
      SELECT
        t.*,
        (SELECT COUNT(DISTINCT conversation_id) FROM ab_assignments WHERE test_id = t.id) as total_assigned
      FROM ab_tests t
      ORDER BY t.active DESC, t.created_at DESC
    `);

    // For each active test, get quick results
    const results = [];
    for (const test of tests) {
      const { rows: variantResults } = await db.query(`
        SELECT
          a.variant,
          COUNT(*) as conversations,
          COUNT(*) FILTER (WHERE c.phase >= 4) as conversions,
          COUNT(*) FILTER (WHERE c.opted_out = true) as opt_outs,
          ROUND(AVG(c.phase)::numeric, 2) as avg_phase
        FROM ab_assignments a
        JOIN conversations c ON c.id = a.conversation_id
        WHERE a.test_id = $1
        GROUP BY a.variant
      `, [test.id]);

      results.push({
        ...test,
        variant_results: variantResults,
      });
    }

    res.json({ tests: results });
  } catch (err) {
    console.error('[Analytics] A/B overview error:', err);
    res.status(500).json({ error: err.message });
  }
});


/**
 * POST /api/admin/analytics/reactivate
 * Trigger a manual reactivation for a cooling lead.
 * Body: { conversation_id, action_type }
 */
performanceRouter.post('/api/admin/analytics/reactivate', async (req, res) => {
  try {
    const { conversation_id, action_type } = req.body;
    if (!conversation_id) {
      return res.status(400).json({ success: false, error: 'conversation_id required' });
    }

    // Get conversation details
    const { rows } = await db.query(
      'SELECT id, phone, name, persona, phase, recommended_product FROM conversations WHERE id = $1',
      [conversation_id]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, error: 'Conversation not found' });
    }

    const conv = rows[0];
    const persona = conv.persona || 'augusto';
    let sent = false;
    let method = 'text';

    // Try to send audio first
    if (action_type && action_type.includes('audio')) {
      const audio = getFollowupAudio(persona);
      if (audio && audio.base64) {
        try {
          const wid = await resolveWhatsAppId(conv.phone);
          if (wid) {
            await sendMediaBase64(wid, audio.base64, '', audio.fileName);
            sent = true;
            method = 'audio';
            console.log('[Reactivation] Audio sent to', conv.phone, '(' + conv.name + ')');
          }
        } catch (err) {
          console.error('[Reactivation] Audio send failed:', err.message);
        }
      }
    }

    // Fallback: send text message
    if (!sent) {
      const name = conv.name ? conv.name.split(' ')[0] : '';
      const greet = name ? name + ', ' : 'Oi, ';
      const messages = [
        greet + 'tudo bem? Vi que a gente estava conversando sobre o seu caso e queria saber se posso te ajudar com mais alguma coisa.',
        greet + 'passando aqui rapidinho! Sei que voce esta ocupado(a), mas queria lembrar que estou aqui caso precise de qualquer orientacao.',
        greet + 'oi! Notei que faz um tempinho que a gente nao conversa. Se ainda tiver interesse, posso te explicar os proximos passos.'
      ];
      const text = messages[Math.floor(Math.random() * messages.length)];

      try {
        const wid = await resolveWhatsAppId(conv.phone);
        if (wid) {
          await sendText(wid, text);
          sent = true;
          method = 'text';
          console.log('[Reactivation] Text sent to', conv.phone, '(' + conv.name + ')');
        }
      } catch (err) {
        console.error('[Reactivation] Text send failed:', err.message);
        return res.status(500).json({ success: false, error: 'Failed to send: ' + err.message });
      }
    }

    if (sent) {
      // Update last_message_at so the lead doesn't show as cooling anymore
      await db.query(
        'UPDATE conversations SET last_message_at = NOW() WHERE id = $1',
        [conversation_id]
      );

      res.json({
        success: true,
        method,
        phone: conv.phone,
        name: conv.name,
        message: 'Reativacao enviada via ' + method
      });
    } else {
      res.status(500).json({ success: false, error: 'Could not resolve WhatsApp ID for ' + conv.phone });
    }
  } catch (err) {
    console.error('[Reactivation] Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

