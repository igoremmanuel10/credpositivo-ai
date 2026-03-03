import { db } from '../db/client.js';

const PRODUCT_VALUES = { diagnostico: 67, limpa_nome: 497, rating: 997 };

/**
 * Get pipeline summary: leads by phase with counts and values.
 */
export async function getPipelineData(days = 7) {
  try {
    const { rows } = await db.query(`
      SELECT
        phase,
        COUNT(*)::int as count,
        COUNT(*) FILTER (WHERE recommended_product IS NOT NULL)::int as with_product,
        COUNT(*) FILTER (WHERE opted_out = true)::int as opted_out,
        COALESCE(recommended_product, 'none') as product
      FROM conversations
      WHERE created_at >= NOW() - INTERVAL '${Math.floor(days)} days'
      GROUP BY phase, recommended_product
      ORDER BY phase
    `);

    const byPhase = {};
    let totalLeads = 0;
    let totalValue = 0;

    for (const row of rows) {
      const phase = row.phase;
      if (!byPhase[phase]) {
        byPhase[phase] = { phase, count: 0, with_product: 0, opted_out: 0, value: 0 };
      }
      byPhase[phase].count += row.count;
      byPhase[phase].with_product += row.with_product;
      byPhase[phase].opted_out += row.opted_out;

      const productValue = PRODUCT_VALUES[row.product] || 0;
      byPhase[phase].value += row.count * productValue;

      totalLeads += row.count;
      totalValue += row.count * productValue;
    }

    return {
      phases: Object.values(byPhase),
      totalLeads,
      totalValue,
    };
  } catch (err) {
    console.error('[DataCollector] getPipelineData error:', err.message);
    return { phases: [], totalLeads: 0, totalValue: 0 };
  }
}

/**
 * Get funnel conversion data between phases.
 */
export async function getFunnelData(days = 7) {
  try {
    const { rows } = await db.query(`
      SELECT
        phase,
        COUNT(*)::int as count,
        COUNT(*) FILTER (WHERE opted_out = true)::int as dropped_out
      FROM conversations
      WHERE created_at >= NOW() - INTERVAL '${Math.floor(days)} days'
      GROUP BY phase
      ORDER BY phase
    `);

    const total = rows.reduce((sum, r) => sum + r.count, 0);

    const phases = rows.map((r, i) => {
      const prevCount = i > 0 ? rows[i - 1].count : total;
      const conversionRate = prevCount > 0 ? Math.round((r.count / prevCount) * 1000) / 10 : 0;
      const dropoffRate = prevCount > 0 ? Math.round(((prevCount - r.count) / prevCount) * 1000) / 10 : 0;
      return {
        phase: r.phase,
        count: r.count,
        dropped_out: r.dropped_out,
        conversion_rate: conversionRate,
        dropoff_rate: dropoffRate,
      };
    });

    const overallRate = total > 0 && rows.length > 0
      ? Math.round((rows[rows.length - 1].count / total) * 1000) / 10
      : 0;

    return { phases, total, overallRate };
  } catch (err) {
    console.error('[DataCollector] getFunnelData error:', err.message);
    return { phases: [], total: 0, overallRate: 0 };
  }
}

/**
 * Get orders and revenue data.
 */
export async function getRevenueData(days = 7) {
  try {
    const [ordersRes, serviceRes, todayRes] = await Promise.all([
      db.query(`
        SELECT
          COUNT(*)::int as total_orders,
          COUNT(*) FILTER (WHERE status = 'paid')::int as paid_orders,
          COUNT(*) FILTER (WHERE status = 'pending')::int as pending_orders,
          COALESCE(SUM(price) FILTER (WHERE status = 'paid'), 0)::numeric as revenue,
          COALESCE(AVG(price) FILTER (WHERE status = 'paid'), 0)::numeric as avg_ticket
        FROM orders
        WHERE created_at >= NOW() - INTERVAL '${Math.floor(days)} days'
      `),
      db.query(`
        SELECT
          service,
          COUNT(*)::int as count,
          COALESCE(SUM(price), 0)::numeric as revenue
        FROM orders
        WHERE status = 'paid' AND created_at >= NOW() - INTERVAL '${Math.floor(days)} days'
        GROUP BY service
        ORDER BY count DESC
      `),
      db.query(`
        SELECT
          COUNT(*)::int as paid_today,
          COALESCE(SUM(price), 0)::numeric as revenue_today
        FROM orders
        WHERE status = 'paid' AND created_at >= CURRENT_DATE
      `),
    ]);

    const orders = ordersRes.rows[0];
    return {
      totalOrders: parseInt(orders.total_orders) || 0,
      paidOrders: parseInt(orders.paid_orders) || 0,
      pendingOrders: parseInt(orders.pending_orders) || 0,
      revenue: parseFloat(orders.revenue) || 0,
      avgTicket: parseFloat(orders.avg_ticket) || 0,
      paidToday: parseInt(todayRes.rows[0]?.paid_today) || 0,
      revenueToday: parseFloat(todayRes.rows[0]?.revenue_today) || 0,
      byService: serviceRes.rows.map(s => ({
        service: s.service,
        count: s.count,
        revenue: parseFloat(s.revenue) || 0,
      })),
    };
  } catch (err) {
    console.error('[DataCollector] getRevenueData error:', err.message);
    return {
      totalOrders: 0, paidOrders: 0, pendingOrders: 0,
      revenue: 0, avgTicket: 0, paidToday: 0, revenueToday: 0, byService: [],
    };
  }
}

/**
 * Get team performance by persona.
 */
export async function getTeamPerformance(days = 7) {
  try {
    const { rows } = await db.query(`
      SELECT
        COALESCE(c.persona, 'augusto') as persona,
        COUNT(DISTINCT c.id)::int as total_conversations,
        COUNT(DISTINCT c.id) FILTER (WHERE c.phase >= 2)::int as qualified,
        COUNT(DISTINCT c.id) FILTER (WHERE c.phase >= 4)::int as reached_site,
        COUNT(DISTINCT c.id) FILTER (WHERE c.opted_out = true)::int as lost,
        COUNT(m.id) FILTER (WHERE m.role = 'agent')::int as messages_sent,
        COUNT(m.id) FILTER (WHERE m.role = 'user')::int as messages_received
      FROM conversations c
      LEFT JOIN messages m ON m.conversation_id = c.id
        AND m.created_at >= NOW() - INTERVAL '${Math.floor(days)} days'
      WHERE c.created_at >= NOW() - INTERVAL '${Math.floor(days)} days'
      GROUP BY c.persona
    `);

    const result = {};
    for (const row of rows) {
      const name = row.persona;
      const qualRate = row.total_conversations > 0
        ? Math.round((row.qualified / row.total_conversations) * 1000) / 10
        : 0;
      const siteRate = row.total_conversations > 0
        ? Math.round((row.reached_site / row.total_conversations) * 1000) / 10
        : 0;
      const lossRate = row.total_conversations > 0
        ? Math.round((row.lost / row.total_conversations) * 1000) / 10
        : 0;

      result[name] = {
        persona: name,
        totalConversations: row.total_conversations,
        qualified: row.qualified,
        reachedSite: row.reached_site,
        lost: row.lost,
        messagesSent: row.messages_sent,
        messagesReceived: row.messages_received,
        qualificationRate: qualRate,
        siteRate,
        lossRate,
      };
    }

    return result;
  } catch (err) {
    console.error('[DataCollector] getTeamPerformance error:', err.message);
    return {};
  }
}

/**
 * Get follow-up effectiveness.
 */
export async function getFollowupData(days = 7) {
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*)::int as total,
        COUNT(*) FILTER (WHERE sent = true)::int as sent,
        COUNT(*) FILTER (WHERE sent = false)::int as pending,
        event_type
      FROM followups
      WHERE created_at >= NOW() - INTERVAL '${Math.floor(days)} days'
      GROUP BY event_type
    `);

    const total = rows.reduce((s, r) => s + r.total, 0);
    const sent = rows.reduce((s, r) => s + r.sent, 0);

    return {
      total,
      sent,
      pending: total - sent,
      sendRate: total > 0 ? Math.round((sent / total) * 1000) / 10 : 0,
      byType: rows,
    };
  } catch (err) {
    console.error('[DataCollector] getFollowupData error:', err.message);
    return { total: 0, sent: 0, pending: 0, sendRate: 0, byType: [] };
  }
}

/**
 * Get stale/cooling leads (no contact >48h in active phases).
 */
export async function getStaleLeadsData() {
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE last_message_at < NOW() - INTERVAL '72 hours')::int as critical,
        COUNT(*) FILTER (WHERE last_message_at BETWEEN NOW() - INTERVAL '72 hours' AND NOW() - INTERVAL '48 hours')::int as warning,
        COUNT(*) FILTER (WHERE last_message_at BETWEEN NOW() - INTERVAL '48 hours' AND NOW() - INTERVAL '24 hours')::int as attention,
        COUNT(*)::int as total
      FROM conversations
      WHERE phase BETWEEN 1 AND 3
        AND (opted_out IS NULL OR opted_out = false)
        AND last_message_at < NOW() - INTERVAL '24 hours'
    `);

    return rows[0] || { critical: 0, warning: 0, attention: 0, total: 0 };
  } catch (err) {
    console.error('[DataCollector] getStaleLeadsData error:', err.message);
    return { critical: 0, warning: 0, attention: 0, total: 0 };
  }
}

/**
 * Get voice call statistics.
 */
export async function getCallData(days = 7) {
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*)::int as total,
        COUNT(*) FILTER (WHERE status = 'completed')::int as completed,
        COUNT(*) FILTER (WHERE status = 'failed' OR status = 'error')::int as failed,
        COALESCE(ROUND(AVG(duration_seconds) FILTER (WHERE status = 'completed')), 0)::int as avg_duration,
        COALESCE(SUM(cost), 0)::numeric as total_cost
      FROM voice_calls
      WHERE created_at >= NOW() - INTERVAL '${Math.floor(days)} days'
    `);

    const data = rows[0] || {};
    return {
      total: parseInt(data.total) || 0,
      completed: parseInt(data.completed) || 0,
      failed: parseInt(data.failed) || 0,
      avgDuration: parseInt(data.avg_duration) || 0,
      totalCost: parseFloat(data.total_cost) || 0,
      completionRate: data.total > 0
        ? Math.round((data.completed / data.total) * 1000) / 10
        : 0,
    };
  } catch (err) {
    console.error('[DataCollector] getCallData error:', err.message);
    return { total: 0, completed: 0, failed: 0, avgDuration: 0, totalCost: 0, completionRate: 0 };
  }
}

/**
 * Get the most recent previous report for trend comparison.
 */
export async function getPreviousReport(reportType = 'daily') {
  try {
    const { rows } = await db.query(
      `SELECT metrics, pipeline_health, created_at
       FROM manager_reports
       WHERE report_type = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [reportType]
    );
    return rows[0] || null;
  } catch (err) {
    console.error('[DataCollector] getPreviousReport error:', err.message);
    return null;
  }
}
