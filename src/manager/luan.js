import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { LUAN_SYSTEM_PROMPT } from './system-prompt.js';
import {
  getPipelineData, getFunnelData, getRevenueData,
  getTeamPerformance, getFollowupData, getStaleLeadsData,
  getCallData, getPreviousReport,
} from './data-collector.js';
import {
  calculateConversionRates, assessPipelineHealth,
  detectBottlenecks, forecastRevenue, evaluateTeam,
  determinePriority, calculateTrends,
} from './metrics.js';
import { formatWhatsAppReport, formatAPIResponse } from './formatter.js';

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

/**
 * Generate a complete manager performance report.
 * Main entry point — called by scheduler, API, or WhatsApp command.
 *
 * @param {object} options
 * @param {string} options.reportType - 'daily' | 'weekly' | 'on_demand'
 * @param {number} options.days - Period to analyze (default: 7)
 * @returns {object} { whatsappMessages, jsonData, metrics }
 */
export async function generateManagerReport(options = {}) {
  const { reportType = 'daily', days = 7 } = options;

  console.log(`[Luan] Generating ${reportType} report (${days} days)...`);

  // Step 1: Collect all data in parallel
  const [pipeline, funnel, revenue, team, followups, stale, calls, previousReport] =
    await Promise.all([
      getPipelineData(days),
      getFunnelData(days),
      getRevenueData(days),
      getTeamPerformance(days),
      getFollowupData(days),
      getStaleLeadsData(),
      getCallData(days),
      getPreviousReport(reportType),
    ]);

  // Step 2: Calculate metrics (pure functions)
  const conversions = calculateConversionRates(funnel, revenue);
  const health = assessPipelineHealth({ conversions, stale, pipeline, revenue });
  const bottlenecks = detectBottlenecks(funnel, conversions, stale, revenue);
  const forecast = forecastRevenue(pipeline, conversions, revenue, previousReport);
  const teamEval = evaluateTeam(team);
  const priority = determinePriority({ conversions, stale, pipeline, funnel });
  const trends = previousReport?.metrics
    ? calculateTrends({ conversions, revenue, pipeline }, previousReport.metrics)
    : null;

  // Step 3: All metrics in one object
  const metrics = {
    pipeline, funnel, revenue, team, followups, stale, calls,
    conversions, health, bottlenecks, forecast, teamEval, priority, trends,
  };

  // Step 4: AI-powered recommendations
  const aiRecommendations = await generateAIRecommendations(metrics);

  // Step 5: Format output
  const whatsappMessages = formatWhatsAppReport(metrics, aiRecommendations, reportType);
  const jsonData = formatAPIResponse(metrics, aiRecommendations);

  // Step 6: Save to database
  await saveReport(reportType, days, metrics, aiRecommendations, whatsappMessages.join('\n---\n'), health, priority);

  const totalChars = whatsappMessages.reduce((s, m) => s + m.length, 0);
  console.log(`[Luan] Report generated (${totalChars} chars, ${whatsappMessages.length} message(s))`);

  return { whatsappMessages, jsonData, metrics };
}

/**
 * Call Claude to interpret data and generate strategic recommendations.
 */
async function generateAIRecommendations(metrics) {
  const dataContext = buildDataContext(metrics);

  try {
    const response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 500,
      temperature: 0.3,
      system: LUAN_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Analise estes dados do pipeline e gere as secoes GARGALOS, RECOMENDACOES e TENDENCIA.\n\nDADOS DO PERIODO:\n${dataContext}`,
      }],
    });

    // Track cost
    try {
      const inputTokens = response.usage?.input_tokens || 0;
      const outputTokens = response.usage?.output_tokens || 0;
      const costPerInputToken = 0.0000008;
      const costPerOutputToken = 0.000004;
      const cost = (inputTokens * costPerInputToken) + (outputTokens * costPerOutputToken);

      await db.query(
        `INSERT INTO api_costs (provider, model, endpoint, input_tokens, output_tokens, cost_usd)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['anthropic', config.anthropic.model, 'manager_luan', inputTokens, outputTokens, cost]
      );
    } catch (_) {}

    return response.content[0]?.text?.trim() || '';
  } catch (err) {
    console.error('[Luan] AI recommendation error:', err.message);
    return 'Recomendacoes indisponiveis (erro na geracao AI)';
  }
}

/**
 * Build concise text summary for Claude's context.
 */
function buildDataContext(metrics) {
  const { conversions, revenue, pipeline, stale, bottlenecks, forecast, teamEval, followups, calls, trends } = metrics;

  const lines = [];

  lines.push(`Leads totais: ${conversions.total}`);
  lines.push(`Qualificados: ${conversions.qualified} (${conversions.qualificationRate}%)`);
  lines.push(`Chegaram ao site: ${conversions.reachedSite} (${conversions.siteRate}%)`);
  lines.push(`Vendas pagas: ${conversions.paidOrders}`);
  lines.push(`Taxa conversao geral: ${conversions.overallRate}%`);
  lines.push(`Receita: R$${(revenue?.revenue || 0).toFixed(2)}`);
  lines.push(`Ticket medio: R$${(revenue?.avgTicket || 0).toFixed(2)}`);
  lines.push(`Valor no pipeline: R$${(pipeline?.totalValue || 0).toFixed(2)}`);
  lines.push(`Leads esfriando (sem contato >24h): ${stale?.total || 0} (criticos >72h: ${stale?.critical || 0})`);

  if (revenue?.byService?.length > 0) {
    lines.push(`Vendas por servico: ${revenue.byService.map(s => s.service + ':' + s.count).join(', ')}`);
  }

  if (followups) {
    lines.push(`Follow-ups: ${followups.sent}/${followups.total} enviados (${followups.sendRate}%)`);
  }

  if (calls?.total > 0) {
    lines.push(`Ligacoes: ${calls.completed}/${calls.total} completadas (${calls.completionRate}%)`);
  }

  // Team data
  if (teamEval.augusto) {
    const a = teamEval.augusto;
    lines.push(`Augusto (SDR): ${a.conversations} conversas, qualificacao ${a.qualificationRate}%, score: ${a.score}`);
  }
  if (teamEval.paulo) {
    const p = teamEval.paulo;
    lines.push(`Paulo (Closer): ${p.conversations} conversas, site ${p.siteRate}%, score: ${p.score}`);
  }

  // Bottlenecks already detected
  if (bottlenecks.length > 0) {
    lines.push(`Gargalos detectados automaticamente: ${bottlenecks.map(b => b.description).join('; ')}`);
  }

  // Trends
  if (trends) {
    const trendParts = [];
    if (trends.leads) trendParts.push(`leads ${trends.leads.direction} (${trends.leads.change > 0 ? '+' : ''}${trends.leads.change}%)`);
    if (trends.revenue) trendParts.push(`receita ${trends.revenue.direction} (${trends.revenue.change > 0 ? '+' : ''}${trends.revenue.change}%)`);
    if (trendParts.length > 0) lines.push(`Tendencias vs anterior: ${trendParts.join(', ')}`);
  }

  return lines.join('\n');
}

/**
 * Save report to database for trend analysis.
 */
async function saveReport(reportType, days, metrics, recommendations, reportText, health, priority) {
  try {
    // Serialize only essential metrics (avoid circular refs / huge payloads)
    const metricsSnapshot = {
      conversions: metrics.conversions,
      revenue: {
        revenue: metrics.revenue?.revenue,
        paidOrders: metrics.revenue?.paidOrders,
        avgTicket: metrics.revenue?.avgTicket,
      },
      pipeline: {
        totalLeads: metrics.pipeline?.totalLeads,
        totalValue: metrics.pipeline?.totalValue,
      },
      stale: metrics.stale,
      forecast: metrics.forecast,
    };

    await db.query(
      `INSERT INTO manager_reports (report_type, period_days, metrics, recommendations, report_text, pipeline_health, priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [reportType, days, JSON.stringify(metricsSnapshot), recommendations, reportText, health, priority]
    );
  } catch (err) {
    console.error('[Luan] Failed to save report:', err.message);
  }
}
