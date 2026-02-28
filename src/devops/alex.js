/**
 * Alex — Autonomous DevOps/SRE Agent for CredPositivo.
 *
 * Runs every 10 minutes:
 *   1. Health check all services
 *   2. Collect recent errors
 *   3. Apply safe auto-fixes
 *   4. AI diagnosis if errors or unhealthy
 *   5. Critical alert via WhatsApp (30min cooldown)
 *   6. Log everything to alex_logs
 *
 * Daily report at 23h BRT (02:00 UTC).
 */

import cron from 'node-cron';
import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { sendText } from '../quepasa/client.js';
import { checkAllServices } from './health-checker.js';
import { getRecentErrors, getErrorPatterns, clearErrorBuffer } from './error-interceptor.js';
import { runAutoFixes } from './auto-fixer.js';
import { ALEX_SYSTEM_PROMPT } from './system-prompt.js';
import { formatDailyReport, formatCriticalAlert, formatCycleJSON } from './formatter.js';

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

// Admin phones for alerts and reports
const REPORT_PHONES = ['5511932145806', '557191234115', '557187700120'];

// Alert cooldown: service → last alert timestamp
const alertCooldown = new Map();
const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

// Store last cycle result for API access
let lastCycleResult = null;

/**
 * Main check cycle — runs every 10 minutes.
 */
export async function runAlexCheckCycle() {
  const cycleId = crypto.randomUUID();
  console.log(`[Alex] Starting check cycle ${cycleId}`);

  try {
    // Step 1: Health check
    const health = await checkAllServices();

    // Step 2: Collect errors
    const errors = getRecentErrors(10);
    const patterns = getErrorPatterns();

    // Step 3: Auto-fixes
    let fixes = [];
    if (errors.length > 0 || health.overall !== 'OK') {
      fixes = await runAutoFixes(health, errors);
    }

    // Step 4: AI diagnosis (only if errors or unhealthy)
    let aiDiagnosis = null;
    if (errors.length > 0 || health.overall !== 'OK') {
      aiDiagnosis = await generateAIDiagnosis(health, errors, patterns, fixes);
    }

    // Step 5: Critical alert
    if (health.overall === 'CRITICO') {
      const downServices = health.services.filter(s => s.status === 'down');
      for (const svc of downServices) {
        await sendCriticalAlert(svc.service, svc.error, aiDiagnosis);
      }
    }

    // Step 6: Log to database
    await logCycle(cycleId, health, errors, fixes, aiDiagnosis);

    // Cache result
    lastCycleResult = formatCycleJSON(health, errors, fixes, aiDiagnosis);

    const fixCount = fixes.reduce((s, f) => s + f.fixed, 0);
    console.log(`[Alex] Cycle ${cycleId} done: ${health.overall} | ${errors.length} errors | ${fixCount} fixes`);

    return lastCycleResult;
  } catch (err) {
    console.error('[Alex] Cycle error:', err.message);
    return { error: err.message, cycleId };
  }
}

/**
 * Generate AI-powered diagnosis using Claude.
 */
async function generateAIDiagnosis(health, errors, patterns, fixes) {
  try {
    const context = buildDiagnosisContext(health, errors, patterns, fixes);

    const response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 300,
      temperature: 0.1,
      system: ALEX_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Analise o snapshot de saude e erros abaixo:\n\n${context}`,
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
        ['anthropic', config.anthropic.model, 'devops_alex', inputTokens, outputTokens, cost]
      );
    } catch (_) {}

    return response.content[0]?.text?.trim() || '';
  } catch (err) {
    console.error('[Alex] AI diagnosis error:', err.message);
    return 'Diagnostico AI indisponivel: ' + err.message;
  }
}

/**
 * Build context string for AI diagnosis.
 */
function buildDiagnosisContext(health, errors, patterns, fixes) {
  const lines = [];

  lines.push('STATUS GERAL: ' + health.overall);
  lines.push('');

  lines.push('SERVICOS:');
  for (const svc of health.services) {
    const time = svc.responseTimeMs ? ` (${svc.responseTimeMs}ms)` : '';
    const err = svc.error ? ` - ERRO: ${svc.error}` : '';
    lines.push(`- ${svc.service}: ${svc.status}${time}${err}`);
  }
  lines.push('');

  if (errors.length > 0) {
    lines.push('ERROS RECENTES (ultimos 10min): ' + errors.length);
    for (const err of errors.slice(0, 10)) {
      lines.push(`- [${err.category}] ${err.message.substring(0, 150)} (${err.count}x)`);
    }
    lines.push('');
  }

  if (Object.keys(patterns).length > 0) {
    lines.push('PADROES 24H:');
    for (const [cat, data] of Object.entries(patterns)) {
      lines.push(`- ${cat}: ${data.count} erros`);
    }
    lines.push('');
  }

  if (fixes.length > 0) {
    lines.push('AUTO-FIXES APLICADOS:');
    for (const fix of fixes) {
      lines.push(`- ${fix.type}: ${fix.fixed} corrigido(s)`);
    }
  }

  return lines.join('\n');
}

/**
 * Send critical alert via WhatsApp (with cooldown).
 */
async function sendCriticalAlert(service, error, aiDiagnosis) {
  const now = Date.now();
  const lastAlert = alertCooldown.get(service) || 0;

  if (now - lastAlert < ALERT_COOLDOWN_MS) {
    console.log(`[Alex] Skipping alert for ${service} (cooldown active)`);
    return;
  }

  const recommendation = aiDiagnosis
    ? aiDiagnosis.split('\n').find(l => l.includes('[MANUAL]'))?.replace(/.*\[MANUAL\]\s*/, '') || 'Verificar manualmente'
    : 'Verificar servico imediatamente';

  const alertText = formatCriticalAlert(service, error, recommendation);

  for (const phone of REPORT_PHONES) {
    try {
      await sendText(phone, alertText);
      console.log('[Alex] Critical alert sent to ' + phone);
    } catch (err) {
      console.error('[Alex] Failed to send alert to ' + phone + ':', err.message);
    }
  }

  alertCooldown.set(service, now);
}

/**
 * Generate and send the daily DevOps report (23h BRT).
 */
export async function sendAlexReportNow() {
  console.log('[Alex] Generating daily DevOps report...');

  try {
    // Current health
    const health = await checkAllServices();

    // Errors from last 24h
    const errors24h = getRecentErrors(24 * 60);
    const patterns = getErrorPatterns();

    // Fixes from last 24h (from DB)
    let fixes24h = [];
    try {
      const fixResult = await db.query(`
        SELECT details FROM alex_logs
        WHERE event_type = 'auto_fix' AND auto_fixed = true
          AND created_at >= NOW() - INTERVAL '24 hours'
      `);
      fixes24h = fixResult.rows.map(r => r.details).filter(Boolean);
    } catch (_) {}

    // Costs
    let costs = null;
    const costService = health.services?.find(s => s.service === 'api_costs');
    if (costService?.details) {
      costs = costService.details;
    }

    // AI diagnosis
    let aiDiagnosis = null;
    if (errors24h.length > 0 || health.overall !== 'OK') {
      aiDiagnosis = await generateAIDiagnosis(health, errors24h, patterns, []);
    } else {
      aiDiagnosis = 'Sistema operando normalmente.';
    }

    // Format report
    const reportText = formatDailyReport(health, errors24h, fixes24h, costs, aiDiagnosis);

    // Send to admin phones
    const results = [];
    for (const phone of REPORT_PHONES) {
      try {
        await sendText(phone, reportText);
        results.push({ phone, status: 'sent' });
        console.log('[Alex] Daily report sent to ' + phone);
      } catch (err) {
        results.push({ phone, status: 'failed', error: err.message });
        console.error('[Alex] Report failed for ' + phone + ':', err.message);
      }
    }

    // Clear error buffer after daily report
    clearErrorBuffer();

    const sentCount = results.filter(r => r.status === 'sent').length;
    return {
      success: sentCount > 0,
      report: reportText,
      results,
      sentCount,
      totalPhones: REPORT_PHONES.length,
    };
  } catch (err) {
    console.error('[Alex] Daily report error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Log cycle data to alex_logs table.
 */
async function logCycle(cycleId, health, errors, fixes, aiDiagnosis) {
  try {
    // Log health check
    await db.query(
      `INSERT INTO alex_logs (cycle_id, event_type, severity, category, description, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [cycleId, 'health_check',
        health.overall === 'CRITICO' ? 'critical' : health.overall === 'DEGRADADO' ? 'warning' : 'info',
        'system', 'Health check: ' + health.overall,
        JSON.stringify({ services: health.services.map(s => ({ service: s.service, status: s.status })) })]
    );

    // Log errors
    if (errors.length > 0) {
      await db.query(
        `INSERT INTO alex_logs (cycle_id, event_type, severity, category, description, details)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [cycleId, 'error_detected', 'warning', 'application',
          `${errors.length} errors detected`,
          JSON.stringify(errors.slice(0, 20).map(e => ({ category: e.category, message: e.message.substring(0, 200), count: e.count })))]
      );
    }

    // Log fixes
    for (const fix of fixes) {
      if (fix.fixed > 0) {
        await db.query(
          `INSERT INTO alex_logs (cycle_id, event_type, severity, category, description, details, auto_fixed, fix_result)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [cycleId, 'auto_fix', 'info', 'system',
            `${fix.type}: ${fix.fixed} fixed`, JSON.stringify(fix), true, 'success']
        );
      }
    }

    // Log AI diagnosis
    if (aiDiagnosis) {
      await db.query(
        `INSERT INTO alex_logs (cycle_id, event_type, severity, category, description)
         VALUES ($1, $2, $3, $4, $5)`,
        [cycleId, 'ai_diagnosis', 'info', 'system', aiDiagnosis.substring(0, 2000)]
      );
    }
  } catch (err) {
    console.error('[Alex] Failed to log cycle:', err.message);
  }
}

/**
 * Get last cycle result (for API).
 */
export function getLastCycleResult() {
  return lastCycleResult;
}

/**
 * Start Alex scheduler.
 */
export function startAlexScheduler() {
  console.log('[Alex] DevOps agent scheduler starting...');

  // Health check every 10 minutes
  cron.schedule('*/10 * * * *', async () => {
    console.log('[Alex] Cron: 10-min health check cycle');
    await runAlexCheckCycle();
  });

  // Daily report at 23h BRT = 02:00 UTC
  cron.schedule('0 2 * * *', async () => {
    console.log('[Alex] Cron: daily DevOps report (23h BRT)');
    await sendAlexReportNow();
  });

  console.log('[Alex] Scheduler started: health check */10min + daily report 23h BRT');

  // Run initial check after 1 minute startup delay
  setTimeout(() => {
    console.log('[Alex] Running initial health check...');
    runAlexCheckCycle().catch(err => console.error('[Alex] Initial check error:', err.message));
  }, 60 * 1000);
}
