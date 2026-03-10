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
        WHERE created_at >= NOW() - INTERVAL '${days} days'
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

    // Calculate phase-to-phase conversion rates
    const phasesData = rows.map((r, i) => {
      const count = parseInt(r.count, 10) || 0;
      const prevCount = i > 0 ? (parseInt(rows[i-1].count, 10) || 0) : total;
      const conversionRate = prevCount > 0 ? Math.round((count / prevCount) * 100 * 10) / 10 : 0;
      const dropoffRate = prevCount > 0 ? Math.round(((prevCount - count) / prevCount) * 100 * 10) / 10 : 0;
      return {
        ...r,
        pct: total > 0 ? Math.round((count / total) * 100) : 0,
        conversion_rate: conversionRate,
        dropoff_rate: dropoffRate,
        prev_phase_count: prevCount,
      };
    });

    res.json({
      period_days: days,
      total_conversations: total,
      phases: phasesData,
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
    const days = parseInt(req.query.days || '30');
    const { rows } = await db.query(`
      SELECT
        COALESCE(recommended_product, 'none') as product,
        COUNT(*) as count,
        COUNT(*) FILTER (WHERE phase >= 4) as reached_site,
        COUNT(*) FILTER (WHERE opted_out = true) as dropped,
        ROUND((COUNT(*) FILTER (WHERE phase >= 4))::numeric / NULLIF(COUNT(*), 0) * 100, 1) as conv_rate
      FROM conversations
      WHERE created_at >= NOW() - INTERVAL '${days} days'
      GROUP BY recommended_product
      ORDER BY count DESC
    `);

    // Normalize product names to group variants
    var grouped = {};
    rows.forEach(function(r) {
      var lower = (r.product || "none").toLowerCase().trim();
      var key;
      if (lower === "null" || lower === "" || lower === "none") key = "none";
      else if (lower.indexOf("diagnostico") >= 0) key = "diagnostico";
      else if (lower.indexOf("limpa") >= 0) key = "limpa_nome";
      else if (lower.indexOf("rating") >= 0) key = "rating";
      else key = lower;
      if (!grouped[key]) grouped[key] = { product: key, count: 0, reached_site: 0, dropped: 0 };
      grouped[key].count += parseInt(r.count) || 0;
      grouped[key].reached_site += parseInt(r.reached_site) || 0;
      grouped[key].dropped += parseInt(r.dropped) || 0;
    });

    var normalizedRows = Object.values(grouped).map(function(r) {
      return Object.assign({}, r, {
        conv_rate: r.count > 0 ? Math.round(r.reached_site / r.count * 1000) / 10 : 0
      });
    });

    normalizedRows.sort(function(a, b) {
      if (a.product === "none") return 1;
      if (b.product === "none") return -1;
      return b.count - a.count;
    });

    var total = normalizedRows.reduce(function(s, r) { return s + r.count; }, 0);
    res.json({
      period_days: days,
      total_conversations: total,
      products: normalizedRows.map(function(r) {
        return Object.assign({}, r, {
          pct_of_total: total > 0 ? Math.round((r.count / total) * 100 * 10) / 10 : 0
        });
      })
    });
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
        (SELECT COUNT(*)::int FROM messages m WHERE m.conversation_id = c.id) as message_count,
        (SELECT COUNT(*)::int FROM voice_calls vc WHERE vc.phone = c.phone) as call_count
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
 * GET /api/admin/analytics/pipeline
 * CRM pipeline: leads grouped by sales stage with value calculation.
 */
analyticsRouter.get('/api/admin/analytics/pipeline', async (req, res) => {
  try {
    const days = parseInt(req.query.days || '30');
    const PRODUCT_VALUES = { diagnostico: 67, limpa_nome: 497, rating: 997 };

    // Aligned with conversation phases 0-4 + follow-up + opted-out
    const STAGE_DEFS = [
      { id: 0, name: 'Antiban (Fase 0)',         phases: [0],    filter: null },
      { id: 1, name: 'Abordagem (Fase 1)',       phases: [1],    filter: null },
      { id: 2, name: 'Investigacao (Fase 2)',     phases: [2],    filter: null },
      { id: 3, name: 'Educacao (Fase 3)',         phases: [3],    filter: null },
      { id: 4, name: 'Dir. ao Site (Fase 4)',     phases: [4],    filter: 'opted_out = false OR opted_out IS NULL' },
      { id: 5, name: 'Perdeu (Opt-out)',          phases: null,   filter: 'opted_out = true' },
    ];

    const stageResults = await Promise.all(
      STAGE_DEFS.map(async (stage) => {
        let where = '';
        const params = [];

        if (stage.phases) {
          const placeholders = stage.phases.map(function(_, i) { return '$' + (i + 1); }).join(', ');
          where = `WHERE c.phase IN (${placeholders}) AND c.created_at >= NOW() - INTERVAL '${days} days'`;
          params.push(...stage.phases);
          if (stage.filter) {
            where += ` AND (${stage.filter})`;
          }
        } else if (stage.filter) {
          where = `WHERE ${stage.filter} AND c.created_at >= NOW() - INTERVAL '${days} days'`;
        }

        const { rows } = await db.query(`
          SELECT c.id, c.phone, c.name, c.phase, c.persona,
            c.recommended_product, c.opted_out, c.created_at, c.updated_at,
            (SELECT COUNT(*)::int FROM messages m WHERE m.conversation_id = c.id) as message_count,
            (SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = c.id) as last_message_at
          FROM conversations c
          ${where}
          ORDER BY c.updated_at DESC NULLS LAST
          LIMIT 20
        `, params);

        const { rows: countRows } = await db.query(`
          SELECT COUNT(*)::int as count FROM conversations c ${where}
        `, params);

        const count = countRows[0]?.count || 0;
        const leads = rows.map(r => ({
          ...r,
          value: PRODUCT_VALUES[r.recommended_product] || 0,
        }));

        const stageValue = leads.reduce((sum, l) => sum + l.value, 0);

        return {
          id: stage.id,
          name: stage.name,
          leads,
          count,
          value: stageValue,
        };
      })
    );

    const totalValue = stageResults.reduce((sum, s) => sum + s.value, 0);
    const totalLeads = stageResults.reduce((sum, s) => sum + s.count, 0);

    res.json({
      stages: stageResults,
      total_value: totalValue,
      total_leads: totalLeads,
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

/**
 * GET /api/admin/analytics/sales-attribution
 * Sales attribution: bot vs human agents performance.
 */
analyticsRouter.get('/api/admin/analytics/sales-attribution', async (req, res) => {
  try {
    const days = parseInt(req.query.days || '30');

    const [summary, agents, daily] = await Promise.all([
      // Overall attribution summary
      db.query(`
        SELECT
          COALESCE(sale_attribution, 'sem_conversao') as attribution,
          COUNT(*) as count,
          COALESCE(SUM(sale_value), 0)::numeric(12,2) as total_value
        FROM conversations
        WHERE created_at >= NOW() - INTERVAL '${days} days'
        GROUP BY sale_attribution
        ORDER BY count DESC
      `),
      // Per-agent performance
      db.query(`
        SELECT
          ha.id as agent_id,
          ha.name as agent_name,
          ha.email as agent_email,
          COUNT(DISTINCT m.conversation_id) as conversas_participadas,
          COUNT(DISTINCT m.conversation_id) FILTER (
            WHERE c.sale_attribution IN ('human_assisted', 'human_closed')
          ) as vendas,
          COALESCE(SUM(DISTINCT c.sale_value) FILTER (
            WHERE c.sale_attribution IN ('human_assisted', 'human_closed')
          ), 0)::numeric(12,2) as valor_total,
          COUNT(m.id) as total_mensagens,
          ROUND(AVG(m.response_time_seconds)) as tempo_medio_resposta
        FROM human_agents ha
        LEFT JOIN messages m ON m.human_agent_id = ha.id AND m.sender_type = 'human'
          AND m.created_at >= NOW() - INTERVAL '${days} days'
        LEFT JOIN conversations c ON m.conversation_id = c.id
        WHERE ha.is_active = TRUE
        GROUP BY ha.id, ha.name, ha.email
        ORDER BY vendas DESC, valor_total DESC
      `),
      // Daily attribution breakdown
      db.query(`
        SELECT
          DATE(conversion_event_at) as date,
          COUNT(*) FILTER (WHERE sale_attribution = 'bot_only') as bot_sales,
          COUNT(*) FILTER (WHERE sale_attribution = 'human_assisted') as human_assisted,
          COUNT(*) FILTER (WHERE sale_attribution = 'human_closed') as human_closed,
          COALESCE(SUM(sale_value) FILTER (WHERE sale_attribution = 'bot_only'), 0)::numeric(12,2) as bot_value,
          COALESCE(SUM(sale_value) FILTER (WHERE sale_attribution IN ('human_assisted','human_closed')), 0)::numeric(12,2) as human_value
        FROM conversations
        WHERE conversion_event_at IS NOT NULL
          AND conversion_event_at >= NOW() - INTERVAL '${days} days'
        GROUP BY DATE(conversion_event_at)
        ORDER BY date DESC
      `)
    ]);

    res.json({
      period_days: days,
      attribution_summary: summary.rows,
      agent_performance: agents.rows,
      daily_attribution: daily.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


/**
 * GET /api/admin/analytics/calls
 * Voice call statistics summary.
 */
analyticsRouter.get('/api/admin/analytics/calls', async (req, res) => {
  try {
    const days = parseInt(req.query.days || '30');

    const { rows } = await db.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'completed') as completed,
        COUNT(*) FILTER (WHERE status = 'failed' OR status = 'error') as failed,
        COUNT(*) FILTER (WHERE provider = 'wavoip') as wavoip_count,
        COUNT(*) FILTER (WHERE provider = 'vapi') as vapi_count,
        COALESCE(ROUND(AVG(duration_seconds) FILTER (WHERE status = 'completed')), 0) as avg_duration,
        COALESCE(SUM(duration_seconds) FILTER (WHERE status = 'completed'), 0) as total_duration,
        COALESCE(SUM(cost), 0) as total_cost
      FROM voice_calls
      WHERE created_at >= NOW() - INTERVAL '${days} days'
    `);

    // Daily breakdown
    const daily = await db.query(`
      SELECT
        DATE(created_at) as day,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'completed') as completed,
        COUNT(*) FILTER (WHERE provider = 'wavoip') as wavoip,
        COUNT(*) FILTER (WHERE provider = 'vapi') as vapi
      FROM voice_calls
      WHERE created_at >= NOW() - INTERVAL '${days} days'
      GROUP BY DATE(created_at)
      ORDER BY day DESC
      LIMIT 30
    `);

    res.json({
      success: true,
      data: {
        summary: rows[0],
        daily: daily.rows
      }
    });
  } catch (err) {
    console.error('[API] Call stats error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});


/**
 * GET /api/admin/analytics/insights
 * AI-powered insights and recommendations based on data.
 */
analyticsRouter.get('/api/admin/analytics/insights', async (req, res) => {
  try {
    const days = parseInt(req.query.days || '30');

    // Gather key metrics for insights
    const [funnel, optouts, products, stale, topPhases] = await Promise.all([
      db.query(`
        SELECT phase, COUNT(*) as count
        FROM conversations
        WHERE created_at >= NOW() - INTERVAL '${days} days'
        GROUP BY phase ORDER BY phase
      `),
      db.query(`
        SELECT COUNT(*) as total,
          COUNT(*) FILTER (WHERE opted_out = true) as opted_out
        FROM conversations
        WHERE created_at >= NOW() - INTERVAL '${days} days'
      `),
      db.query(`
        SELECT recommended_product, COUNT(*) as cnt,
          COUNT(*) FILTER (WHERE phase >= 4) as converted
        FROM conversations
        WHERE created_at >= NOW() - INTERVAL '${days} days' AND recommended_product IS NOT NULL
        GROUP BY recommended_product ORDER BY cnt DESC
      `),
      db.query(`
        SELECT COUNT(*) as stale_leads
        FROM conversations
        WHERE last_message_at < NOW() - INTERVAL '48 hours'
          AND phase BETWEEN 1 AND 3
          AND (opted_out IS NULL OR opted_out = false)
          AND created_at >= NOW() - INTERVAL '${days} days'
      `),
      db.query(`
        SELECT phase,
          COUNT(*) as count,
          COUNT(*) FILTER (WHERE opted_out = true) as dropouts
        FROM conversations
        WHERE created_at >= NOW() - INTERVAL '${days} days'
        GROUP BY phase ORDER BY phase
      `)
    ]);

    const insights = [];
    const phases = funnel.rows;
    const total = parseInt(optouts.rows[0]?.total) || 0;
    const optoutCount = parseInt(optouts.rows[0]?.opted_out) || 0;
    const optoutRate = total > 0 ? ((optoutCount / total) * 100).toFixed(1) : 0;
    const staleCount = parseInt(stale.rows[0]?.stale_leads) || 0;

    // Insight: Opt-out rate
    if (optoutRate > 15) {
      insights.push({
        type: 'warning',
        icon: 'exclamation',
        title: 'Taxa de opt-out alta (' + optoutRate + '%)',
        description: optoutCount + ' leads optaram por sair. Revise a abordagem inicial e considere mensagens menos agressivas na Fase 0-1.',
        action: 'Revisar scripts de abordagem',
        priority: 'alta'
      });
    } else if (optoutRate > 5) {
      insights.push({
        type: 'info',
        icon: 'info',
        title: 'Taxa de opt-out moderada (' + optoutRate + '%)',
        description: 'A taxa esta dentro de parametros aceitaveis, mas pode melhorar com personalizacao.',
        action: 'Testar variantes de mensagem A/B',
        priority: 'media'
      });
    }

    // Insight: Funnel bottlenecks
    for (let i = 1; i < phases.length; i++) {
      const prevCount = parseInt(phases[i-1]?.count) || 0;
      const currCount = parseInt(phases[i]?.count) || 0;
      if (prevCount > 0) {
        const convRate = (currCount / prevCount * 100).toFixed(1);
        if (convRate < 15 && prevCount > 10) {
          const phaseNames = {
            0: 'Antiban', 1: 'Abordagem', 2: 'Investigacao',
            3: 'Educacao', 4: 'Direcao ao Site', 5: 'Follow-up'
          };
          insights.push({
            type: 'warning',
            icon: 'funnel',
            title: 'Gargalo: Fase ' + phases[i-1].phase + ' -> ' + phases[i].phase + ' (' + convRate + '%)',
            description: 'Apenas ' + convRate + '% dos leads passaram de ' + (phaseNames[phases[i-1].phase] || 'Fase ' + phases[i-1].phase) + ' para ' + (phaseNames[phases[i].phase] || 'Fase ' + phases[i].phase) + '. Existem ' + prevCount + ' leads na fase anterior e apenas ' + currCount + ' na seguinte.',
            action: 'Melhorar conteudo/script da fase ' + phases[i-1].phase,
            priority: 'alta'
          });
        }
      }
    }

    // Insight: Stale leads
    if (staleCount > 5) {
      insights.push({
        type: 'action',
        icon: 'clock',
        title: staleCount + ' leads esfriando (sem contato > 48h)',
        description: 'Leads nas fases 1-3 que nao recebem mensagem ha mais de 48 horas. Eles tem alta chance de desistir se nao forem reativados.',
        action: 'Ativar reativacao no Performance',
        priority: 'alta'
      });
    }

    // Insight: Product conversion comparison
    const prodRows = products.rows;
    if (prodRows.length > 1) {
      const best = prodRows.reduce((a, b) => {
        const aRate = parseInt(a.cnt) > 0 ? parseInt(a.converted) / parseInt(a.cnt) : 0;
        const bRate = parseInt(b.cnt) > 0 ? parseInt(b.converted) / parseInt(b.cnt) : 0;
        return aRate > bRate ? a : b;
      });
      const worst = prodRows.reduce((a, b) => {
        const aRate = parseInt(a.cnt) > 0 ? parseInt(a.converted) / parseInt(a.cnt) : 1;
        const bRate = parseInt(b.cnt) > 0 ? parseInt(b.converted) / parseInt(b.cnt) : 1;
        return aRate < bRate ? a : b;
      });
      if (best.recommended_product !== worst.recommended_product) {
        const bestRate = parseInt(best.cnt) > 0 ? ((parseInt(best.converted) / parseInt(best.cnt)) * 100).toFixed(1) : 0;
        const worstRate = parseInt(worst.cnt) > 0 ? ((parseInt(worst.converted) / parseInt(worst.cnt)) * 100).toFixed(1) : 0;
        insights.push({
          type: 'info',
          icon: 'product',
          title: 'Melhor produto: ' + (best.recommended_product || 'nenhum') + ' (' + bestRate + '% conversao)',
          description: 'O produto ' + (best.recommended_product || 'nenhum') + ' tem a melhor taxa de conversao (' + bestRate + '%), enquanto ' + (worst.recommended_product || 'nenhum') + ' tem ' + worstRate + '%. Considere direcionar mais leads para produtos com melhor performance.',
          action: 'Ajustar recomendacao de produto',
          priority: 'media'
        });
      }
    }

    // Insight: Volume trend (general)
    if (total > 0) {
      const phase0 = phases.find(p => p.phase === 0);
      const phase0Count = parseInt(phase0?.count) || 0;
      const phase0Pct = ((phase0Count / total) * 100).toFixed(0);
      if (phase0Pct > 80) {
        insights.push({
          type: 'info',
          icon: 'chart',
          title: phase0Pct + '% dos leads ainda na Fase 0 (Antiban)',
          description: 'A grande maioria dos leads (' + phase0Count + ' de ' + total + ') ainda nao passou da fase inicial. Isso pode indicar que o bot precisa de ajustes na mensagem de abertura ou que muitos numeros sao invalidos.',
          action: 'Verificar qualidade da base de leads',
          priority: 'media'
        });
      }
    }

    res.json({
      period_days: days,
      total_insights: insights.length,
      insights: insights.sort((a, b) => {
        const prio = { alta: 0, media: 1, baixa: 2 };
        return (prio[a.priority] || 2) - (prio[b.priority] || 2);
      })
    });
  } catch (err) {
    console.error('[API] Insights error:', err);
    res.status(500).json({ error: err.message });
  }
});


/**
 * GET /api/admin/analytics/rag-stats
 * Knowledge base RAG statistics: articles, categories, sync status, conversation embeddings.
 */
analyticsRouter.get('/api/admin/analytics/rag-stats', async (req, res) => {
  try {
    const [totalArticles, categories, recentArticles, convEmbeddings] = await Promise.all([
      db.query(`
        SELECT
          COUNT(*) as total,
          MAX(synced_at) as last_sync
        FROM knowledge_embeddings
      `),
      db.query(`
        SELECT
          COALESCE(category, 'sem_categoria') as category,
          COUNT(*) as count
        FROM knowledge_embeddings
        GROUP BY category
        ORDER BY count DESC
      `),
      db.query(`
        SELECT
          id, title, category, notion_page_id,
          synced_at, notion_last_edited
        FROM knowledge_embeddings
        ORDER BY synced_at DESC
        LIMIT 20
      `),
      db.query(`
        SELECT
          COUNT(*) as total,
          COUNT(DISTINCT conversation_id) as unique_conversations,
          MAX(created_at) as last_embedded
        FROM conversation_embeddings
      `),
    ]);

    res.json({
      knowledge_articles: {
        total: parseInt(totalArticles.rows[0]?.total) || 0,
        last_sync: totalArticles.rows[0]?.last_sync || null,
      },
      categories: categories.rows,
      recent_articles: recentArticles.rows,
      conversation_embeddings: {
        total: parseInt(convEmbeddings.rows[0]?.total) || 0,
        unique_conversations: parseInt(convEmbeddings.rows[0]?.unique_conversations) || 0,
        last_embedded: convEmbeddings.rows[0]?.last_embedded || null,
      },
    });
  } catch (err) {
    console.error('[API] RAG stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/analytics/system-reports
 * Returns recent manager reports and alex health logs for the dashboard.
 */
analyticsRouter.get('/api/admin/analytics/system-reports', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '20'), 50);

    const managerReports = await db.query(
      'SELECT id, report_type, period_days, report_text, recommendations, pipeline_health, priority, created_at FROM manager_reports ORDER BY created_at DESC LIMIT $1',
      [limit]
    );

    const alexSummary = await db.query(
      "SELECT COUNT(*) as total_checks, COUNT(*) FILTER (WHERE severity = 'critical') as critical, COUNT(*) FILTER (WHERE severity = 'warning') as warnings, COUNT(*) FILTER (WHERE auto_fixed = true) as auto_fixed, MAX(created_at) as last_check FROM alex_logs WHERE created_at >= NOW() - INTERVAL '24 hours'"
    );

    const alexLogs = await db.query(
      "SELECT id, cycle_id, event_type, severity, category, description, auto_fixed, fix_result, created_at FROM alex_logs WHERE severity IN ('critical', 'warning', 'info') ORDER BY created_at DESC LIMIT $1",
      [limit]
    );

    res.json({
      manager_reports: managerReports.rows,
      alex: {
        summary_24h: alexSummary.rows[0] || {},
        recent_logs: alexLogs.rows,
      },
    });
  } catch (err) {
    console.error('[API] System reports error:', err);
    res.status(500).json({ error: err.message });
  }
});
