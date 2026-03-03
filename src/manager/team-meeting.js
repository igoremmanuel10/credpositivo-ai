/**
 * team-meeting.js — Reunião semanal do time de vendas.
 *
 * Fluxo:
 * 1. Luan coleta dados (data-collector.js)
 * 2. Cada agente analisa pela sua perspectiva (Claude AI em paralelo)
 * 3. Igor consolida num relatório único com plano de ação
 * 4. Posta no Ops Inbox (Chatwoot)
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { db } from '../db/client.js';
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

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey, dangerouslyAllowBrowser: true });
const AI_MODEL = 'claude-haiku-4-5-20251001';

// ─── Agent Prompts ───────────────────────────────────────────

const AGENT_PROMPTS = {
  luan: `Voce e Luan, gerente de performance da CredPositivo.
Analise os dados do funil e identifique:
1. O PRINCIPAL gargalo (1 so, com severidade)
2. Taxa de conversao fase a fase — onde o funil quebra
3. Comparacao com periodo anterior se disponivel
4. Previsao de receita baseada no pipeline atual

Formato: maximo 8 linhas. Sem emoji. Fatos e numeros. Linguagem direta.`,

  augusto: `Voce e Augusto, SDR da CredPositivo. Sua funcao e qualificar leads no WhatsApp.
Analise os dados da sua perspectiva de SDR:
1. Quantos leads entraram e quantos voce conseguiu qualificar (taxa)
2. Problema principal na qualificacao (por que leads somem no phase 0?)
3. Media de mensagens suas vs mensagens do lead — voce esta respondendo rapido o suficiente?
4. Auto-avaliacao: o que voce esta fazendo errado e o que precisa mudar

Formato: maximo 8 linhas. Autocritica real, nao desculpas. Numeros concretos.`,

  paulo: `Voce e Paulo, Closer da CredPositivo. Sua funcao e fechar vendas (R$67, R$497, R$997).
Analise os dados da sua perspectiva de fechamento:
1. Quantos leads chegaram ao fechamento e quantos voce converteu (taxa)
2. Problema principal no fechamento (por que 0 vendas?)
3. Objecoes mais comuns que voce nao esta resolvendo
4. O que precisa mudar: link de pagamento, abordagem, scripts

Formato: maximo 8 linhas. Autocritica real. Numeros concretos.`,

  ana: `Voce e Ana, Ops da CredPositivo. Sua funcao e garantir que todo lead tem status, responsavel, proxima acao.
Analise os dados da sua perspectiva de pipeline:
1. Saude do pipeline: quantos leads sem proxima acao, quantos abandonados
2. Leads HOT abandonados (phase 3-4 parados >48h) — listar quantidade
3. Follow-up: esta funcionando ou esta spammando a base?
4. O que precisa mudar imediatamente no pipeline

Formato: maximo 8 linhas. Classificar saude como CRITICO/ATENCAO/SAUDAVEL. Numeros.`,

  alex: `Voce e Alex, DevOps/SRE da CredPositivo. Sua funcao e garantir que o sistema funciona corretamente.
Analise os dados da perspectiva tecnica:
1. Bugs criticos: o agente esta respondendo? Webhook funciona? Mensagens estao chegando?
2. AI esta alucinando? (fabricando status, mentindo sobre diagnostico)
3. Follow-up automatico: esta causando mais dano que beneficio?
4. O que precisa ser corrigido no codigo para destravar vendas

Formato: maximo 8 linhas. Foco em bugs que impedem receita. Numeros.`,
};

const IGOR_PROMPT = `Voce e Igor, orquestrador do time de vendas da CredPositivo.

Voce acabou de receber 5 analises de agentes diferentes sobre o MESMO funil de vendas:
- Luan (Manager): visao de metricas e gargalos
- Augusto (SDR): visao de qualificacao
- Paulo (Closer): visao de fechamento
- Ana (Ops): visao de pipeline
- Alex (DevOps): visao tecnica

Seu trabalho e consolidar tudo num UNICO relatorio executivo.

FORMATO OBRIGATORIO:

STATUS DO SISTEMA: [CRITICO | ATENCAO | OPERACIONAL]

FUNIL (numeros reais):
- Phase 0 → Phase 1 → Phase 2 → Phase 3 → Phase 4 → Pagamento
(com taxas de conversao entre fases)

GARGALOS (max 3, priorizados por impacto na receita):
1. [descricao] — Severidade: [CRITICA/ALTA/MEDIA] — Dono: [agente]
2. ...
3. ...

PLANO DE ACAO (max 3 acoes, sequenciadas):
ACAO 1 — [HOJE/ESTA SEMANA/PROXIMA SEMANA]
- O que: [acao especifica]
- Dono: [agente]
- Impacto estimado: [R$ ou %]

PERFORMANCE POR AGENTE:
- Augusto (SDR): [score /10] — [1 linha]
- Paulo (Closer): [score /10] — [1 linha]
- Ana (Ops): [score /10] — [1 linha]
- Alex (DevOps): [score /10] — [1 linha]
- Luan (Manager): [score /10] — [1 linha]

RECEITA PROJETADA: R$ [valor] /mes (pos-correcoes)

REGRAS:
- Sem emoji. Sem jargao motivacional. Fatos e numeros.
- Portugues BR. Linguagem direta.
- Se os agentes discordam, voce decide com base nos dados.
- Cada acao TEM dono e impacto estimado.
- Maximo 40 linhas no total.`;

// ─── Data Context Builder ────────────────────────────────────

function buildDataContext(metrics) {
  const { conversions, revenue, pipeline, stale, bottlenecks, forecast, teamEval, followups, calls, trends, funnel } = metrics;
  const lines = [];

  lines.push(`=== DADOS DO FUNIL (periodo: ${metrics._days || 7} dias) ===`);
  lines.push(`Leads totais: ${conversions?.total || 0}`);

  if (funnel?.phases) {
    for (const p of funnel.phases) {
      lines.push(`Phase ${p.phase}: ${p.count} leads (conversao: ${p.conversion_rate}%, dropoff: ${p.dropoff_rate}%)`);
    }
  }

  lines.push(`Qualificados (phase 2+): ${conversions?.qualified || 0} (${conversions?.qualificationRate || 0}%)`);
  lines.push(`Chegaram ao site (phase 4+): ${conversions?.reachedSite || 0} (${conversions?.siteRate || 0}%)`);
  lines.push(`Vendas pagas: ${conversions?.paidOrders || 0}`);
  lines.push(`Taxa conversao geral: ${conversions?.overallRate || 0}%`);
  lines.push(`Receita: R$${(revenue?.revenue || 0).toFixed(2)}`);
  lines.push(`Ticket medio: R$${(revenue?.avgTicket || 0).toFixed(2)}`);
  lines.push(`Valor no pipeline: R$${(pipeline?.totalValue || 0).toFixed(2)}`);
  lines.push(`Leads esfriando (>24h): ${stale?.total || 0} (criticos >72h: ${stale?.critical || 0})`);

  if (followups) {
    lines.push(`Follow-ups: ${followups.sent}/${followups.total} enviados (${followups.sendRate}%)`);
  }
  if (calls?.total > 0) {
    lines.push(`Ligacoes: ${calls.completed}/${calls.total} completadas (${calls.completionRate}%)`);
  }

  // Team data
  if (teamEval) {
    for (const [key, ev] of Object.entries(teamEval)) {
      if (ev.name || key) {
        lines.push(`${ev.name || key}: ${ev.notes || `${ev.totalConversations || 0} conversas, qual ${ev.qualificationRate || 0}%`}`);
      }
    }
  }

  if (bottlenecks?.length > 0) {
    lines.push(`Gargalos auto-detectados: ${bottlenecks.map(b => b.description).join('; ')}`);
  }

  if (trends) {
    const parts = [];
    if (trends.leads) parts.push(`leads ${trends.leads.direction} (${trends.leads.change > 0 ? '+' : ''}${trends.leads.change}%)`);
    if (trends.revenue) parts.push(`receita ${trends.revenue.direction} (${trends.revenue.change > 0 ? '+' : ''}${trends.revenue.change}%)`);
    if (parts.length) lines.push(`Tendencias vs anterior: ${parts.join(', ')}`);
  }

  return lines.join('\n');
}

// ─── AI Call Helper ──────────────────────────────────────────

async function callAgent(systemPrompt, dataContext, agentName) {
  try {
    const response = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 600,
      temperature: 0.3,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: `Analise estes dados reais do funil da CredPositivo e de sua avaliacao:\n\n${dataContext}`,
      }],
    });

    // Track cost
    try {
      const inputTokens = response.usage?.input_tokens || 0;
      const outputTokens = response.usage?.output_tokens || 0;
      const cost = (inputTokens * 0.0000008) + (outputTokens * 0.000004);
      await db.query(
        `INSERT INTO api_costs (provider, model, endpoint, input_tokens, output_tokens, cost_usd)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['anthropic', AI_MODEL, `team_meeting_${agentName}`, inputTokens, outputTokens, cost]
      );
    } catch (_) {}

    return response.content[0]?.text?.trim() || `[${agentName}] Sem resposta`;
  } catch (err) {
    console.error(`[TeamMeeting] ${agentName} error:`, err.message);
    return `[${agentName}] Erro na analise: ${err.message}`;
  }
}

// ─── Main Entry Point ────────────────────────────────────────

/**
 * Run the full team meeting: collect data, run 5 agents in parallel, Igor consolidates.
 *
 * @param {object} options
 * @param {number} options.days - Period to analyze (default: 7)
 * @param {string} options.reportType - 'weekly' | 'on_demand'
 * @returns {object} { report, agentReports, metrics }
 */
export async function generateTeamMeeting(options = {}) {
  const { days = 7, reportType = 'weekly' } = options;

  console.log(`[TeamMeeting] Starting team meeting (${days} days, ${reportType})...`);
  const startTime = Date.now();

  // Step 1: Luan collects all data
  console.log('[TeamMeeting] Step 1/3: Luan collecting data...');
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

  const conversions = calculateConversionRates(funnel, revenue);
  const health = assessPipelineHealth({ conversions, stale, pipeline, revenue });
  const bottlenecks = detectBottlenecks(funnel, conversions, stale, revenue);
  const forecast = forecastRevenue(pipeline, conversions, revenue, previousReport);
  const teamEval = evaluateTeam(team);
  const priority = determinePriority({ conversions, stale, pipeline, funnel });
  const trends = previousReport?.metrics
    ? calculateTrends({ conversions, revenue, pipeline }, previousReport.metrics)
    : null;

  const metrics = {
    pipeline, funnel, revenue, team, followups, stale, calls,
    conversions, health, bottlenecks, forecast, teamEval, priority, trends,
    _days: days,
  };

  const dataContext = buildDataContext(metrics);
  console.log(`[TeamMeeting] Data collected (${dataContext.length} chars)`);

  // Step 2: All 5 agents analyze in parallel
  console.log('[TeamMeeting] Step 2/3: 5 agents analyzing in parallel...');
  const [luanReport, augustoReport, pauloReport, anaReport, alexReport] = await Promise.all([
    callAgent(AGENT_PROMPTS.luan, dataContext, 'luan'),
    callAgent(AGENT_PROMPTS.augusto, dataContext, 'augusto'),
    callAgent(AGENT_PROMPTS.paulo, dataContext, 'paulo'),
    callAgent(AGENT_PROMPTS.ana, dataContext, 'ana'),
    callAgent(AGENT_PROMPTS.alex, dataContext, 'alex'),
  ]);

  const agentReports = { luan: luanReport, augusto: augustoReport, paulo: pauloReport, ana: anaReport, alex: alexReport };
  console.log('[TeamMeeting] All 5 agents done');

  // Step 3: Igor consolidates
  console.log('[TeamMeeting] Step 3/3: Igor consolidating...');
  const igorContext = `DADOS DO FUNIL:\n${dataContext}\n\n` +
    `--- ANALISE DO LUAN (Manager) ---\n${luanReport}\n\n` +
    `--- ANALISE DO AUGUSTO (SDR) ---\n${augustoReport}\n\n` +
    `--- ANALISE DO PAULO (Closer) ---\n${pauloReport}\n\n` +
    `--- ANALISE DA ANA (Ops) ---\n${anaReport}\n\n` +
    `--- ANALISE DO ALEX (DevOps) ---\n${alexReport}`;

  const igorReport = await callAgent(IGOR_PROMPT, igorContext, 'igor');

  // Build final formatted report
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  const finalReport = [
    `REUNIAO DE TIME — ANALISE DE FUNIL`,
    `${now}`,
    `Periodo: ${days} dias | Duracao: ${elapsed}s`,
    `================================`,
    ``,
    igorReport,
    ``,
    `================================`,
    `ANALISES INDIVIDUAIS`,
    `================================`,
    ``,
    `-- LUAN (Manager) --`,
    luanReport,
    ``,
    `-- AUGUSTO (SDR) --`,
    augustoReport,
    ``,
    `-- PAULO (Closer) --`,
    pauloReport,
    ``,
    `-- ANA (Ops) --`,
    anaReport,
    ``,
    `-- ALEX (DevOps) --`,
    alexReport,
    ``,
    `================================`,
    `Gerado automaticamente pelo sistema de reuniao de time CredPositivo`,
  ].join('\n');

  // Save to DB
  try {
    const metricsSnapshot = {
      conversions: metrics.conversions,
      revenue: { revenue: metrics.revenue?.revenue, paidOrders: metrics.revenue?.paidOrders, avgTicket: metrics.revenue?.avgTicket },
      pipeline: { totalLeads: metrics.pipeline?.totalLeads, totalValue: metrics.pipeline?.totalValue },
      stale: metrics.stale,
      forecast: metrics.forecast,
    };
    await db.query(
      `INSERT INTO manager_reports (report_type, period_days, metrics, recommendations, report_text, pipeline_health, priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [`team_${reportType}`, days, JSON.stringify(metricsSnapshot), igorReport, finalReport, health, priority]
    );
  } catch (err) {
    console.error('[TeamMeeting] Failed to save report:', err.message);
  }

  console.log(`[TeamMeeting] Done (${elapsed}s, ${finalReport.length} chars)`);

  return { report: finalReport, igorReport, agentReports, metrics };
}
