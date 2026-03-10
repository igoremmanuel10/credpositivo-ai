/**
 * ceo/musk.js — Agente CEO (Musk)
 *
 * Camada executiva acima do Igor.
 * Recebe relatorio consolidado do time, aplica 80/20, emite diretivas.
 *
 * Fluxo:
 * 1. Recebe output do team-meeting (Igor consolidado)
 * 2. Analisa pela lente Pareto (80/20)
 * 3. Emite diretiva executiva com acao, dono, prazo
 * 4. Salva no DB + posta no Ops Inbox
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { postToOpsInbox } from '../chatwoot/ops-inbox.js';
import { MUSK_SYSTEM_PROMPT, MUSK_REVIEW_PROMPT } from './system-prompt.js';
import { generateTeamMeeting } from '../manager/team-meeting.js';
import { emit, setStatus } from '../os/emitter.js';

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey, dangerouslyAllowBrowser: true });
const AI_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Run Musk CEO analysis on top of a team meeting report.
 *
 * @param {object} options
 * @param {string} options.igorReport - Igor's consolidated report (from team meeting)
 * @param {object} options.metrics - Raw metrics from team meeting
 * @param {object} options.agentReports - Individual agent reports
 * @param {number} options.days - Period analyzed
 * @returns {object} { directive, fullReport }
 */
export async function generateCeoDirective({ igorReport, metrics, agentReports, days = 7 }) {
  console.log('[Musk] Generating CEO directive...');
  const startTime = Date.now();

  // Build context for Musk
  const context = [
    `RELATORIO DO ORQUESTRADOR (Igor):`,
    igorReport,
    ``,
    `DADOS BRUTOS:`,
    `- Leads totais: ${metrics?.conversions?.total || 0}`,
    `- Qualificados: ${metrics?.conversions?.qualified || 0} (${metrics?.conversions?.qualificationRate || 0}%)`,
    `- Chegaram ao site: ${metrics?.conversions?.reachedSite || 0} (${metrics?.conversions?.siteRate || 0}%)`,
    `- Vendas pagas: ${metrics?.conversions?.paidOrders || 0}`,
    `- Receita: R$${(metrics?.revenue?.revenue || 0).toFixed(2)}`,
    `- Ticket medio: R$${(metrics?.revenue?.avgTicket || 0).toFixed(2)}`,
    `- Pipeline: R$${(metrics?.pipeline?.totalValue || 0).toFixed(2)}`,
    `- Leads esfriando: ${metrics?.stale?.total || 0} (criticos: ${metrics?.stale?.critical || 0})`,
    `- Saude pipeline: ${metrics?.health || 'desconhecido'}`,
    `- Periodo: ${days} dias`,
  ].join('\n');

  // Get previous CEO directive for comparison
  let previousDirective = null;
  try {
    const prev = await db.query(
      `SELECT directive_text, created_at FROM ceo_directives ORDER BY created_at DESC LIMIT 1`
    );
    if (prev.rows.length > 0) {
      previousDirective = prev.rows[0];
    }
  } catch (_) {
    // Table might not exist yet
  }

  if (previousDirective) {
    context.concat([
      ``,
      `DIRETIVA ANTERIOR (${new Date(previousDirective.created_at).toLocaleDateString('pt-BR')}):`,
      previousDirective.directive_text,
    ].join('\n'));
  }

  // Call Musk AI
  try {
    const response = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 800,
      temperature: 0.2,
      system: MUSK_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `${MUSK_REVIEW_PROMPT}\n\n${context}`,
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
        ['anthropic', AI_MODEL, 'ceo_directive', inputTokens, outputTokens, cost]
      );
    } catch (_) {}

    const directive = response.content[0]?.text?.trim() || '[Musk] Sem diretiva gerada';
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    // Save directive to DB
    try {
      await db.query(
        `INSERT INTO ceo_directives (period_days, directive_text, igor_report, metrics_snapshot)
         VALUES ($1, $2, $3, $4)`,
        [days, directive, igorReport, JSON.stringify({
          total_leads: metrics?.conversions?.total || 0,
          qualified: metrics?.conversions?.qualified || 0,
          paid: metrics?.conversions?.paidOrders || 0,
          revenue: metrics?.revenue?.revenue || 0,
          pipeline_value: metrics?.pipeline?.totalValue || 0,
          health: metrics?.health || 'unknown',
        })]
      );
    } catch (err) {
      console.error('[Musk] Failed to save directive:', err.message);
    }

    console.log(`[Musk] Directive generated (${elapsed}s)`);

    return {
      directive,
      elapsed,
    };
  } catch (err) {
    console.error('[Musk] AI error:', err.message);
    return {
      directive: `[Musk] Erro na analise: ${err.message}`,
      elapsed: Math.round((Date.now() - startTime) / 1000),
    };
  }
}

/**
 * Full CEO cycle: team meeting + Musk directive.
 * This is the main entry point for the CEO report.
 *
 * @param {object} options
 * @param {number} options.days - Period to analyze
 * @param {boolean} options.postToOps - Whether to post to Ops Inbox
 * @returns {object} { directive, teamReport, metrics }
 */
export async function runCeoCycle(options = {}) {
  const { days = 7, postToOps = true } = options;

  console.log(`[Musk] Starting CEO cycle (${days} days)...`);

  // Step 1: Run full team meeting
  const teamResult = await generateTeamMeeting({ days, reportType: 'ceo_review' });

  // Step 2: Musk reviews and issues directive
  const ceoResult = await generateCeoDirective({
    igorReport: teamResult.igorReport,
    metrics: teamResult.metrics,
    agentReports: teamResult.agentReports,
    days,
  });

  // Step 3: Build full CEO report
  const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const fullReport = [
    `========================================`,
    `DIRETIVA CEO — MUSK`,
    `${now} | Periodo: ${days} dias`,
    `========================================`,
    ``,
    ceoResult.directive,
    ``,
    `========================================`,
    `RELATORIO DO TIME (Igor)`,
    `========================================`,
    ``,
    teamResult.igorReport,
    ``,
    `========================================`,
    `Gerado pelo sistema CEO CredPositivo`,
  ].join('\n');

  // Step 4: Post to Ops Inbox
  if (postToOps) {
    try {
      await postToOpsInbox(fullReport, 'ceo_directive');
    } catch (err) {
      console.error('[Musk] Failed to post to Ops:', err.message);
    }
  }

  console.log(`[Musk] CEO cycle complete`);

  await emit('musk.directive', 'musk', { type: 'ceo_directive' });
  await setStatus('musk', 'online');

  return {
    directive: ceoResult.directive,
    teamReport: teamResult.report,
    igorReport: teamResult.igorReport,
    metrics: teamResult.metrics,
    fullReport,
  };
}
