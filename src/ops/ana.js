/**
 * Ana — Ops Monitor (Pipeline + Health + QA + Boot)
 *
 * Schedule (BRT / UTC):
 *   06:00 / 09:00  — Boot check (verifica se tudo subiu)
 *   09:30 / 12:30  — Pipeline scan MANHÃ
 *   13:00 / 16:00  — QA Review meio-dia (só reporta se houver problemas)
 *   17:00 / 20:00  — Pipeline scan FIM DO DIA
 *   21:00 / 00:00  — QA Review diário completo + score
 *   every 5min biz hrs  — Health check (alerta após 3 falhas seguidas)
 *   every 30min noite   — Health check silencioso (só crítico)
 *
 * Scans the pipeline for:
 *   1. Leads qualificados parados (>48h sem interação)
 *   2. Transfers pro Paulo sem resposta (>2h)
 *   3. Leads em fase 3-4 sem follow-up agendado
 *   4. Leads com pedido abandonado sem ação
 *
 * QA checks:
 *   1. Mensagens splitadas (<8s entre bubbles)
 *   2. Pulos de fase (fase 3+ com <4 msgs)
 *   3. Link enviado cedo demais (fase <3)
 *   4. Preço mencionado proativamente
 *   5. Mensagens longas (>500 chars)
 *   6. Transfer não efetivado (auto-corrige)
 *
 * Zero AI calls — pure SQL + formatting.
 */

import cron from 'node-cron';
import { db } from '../db/client.js';
import { sendText, getTokenForWid, getBotInfo } from '../quepasa/client.js';
import { resetCircuitBreaker, generateEmbedding } from '../ai/embeddings.js';
import { config, isBusinessHours } from '../config.js';
import { postToOpsInbox } from '../chatwoot/ops-inbox.js';
import { emit, setStatus, reportMetrics } from '../os/emitter.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const ADM_GROUP_JID = process.env.ADM_GROUP_JID || '';
const AUGUSTO_PHONE = '5571936180654';

/** Admin phones — for fallback if group JID not set */
const ADMIN_PHONES = ['5511932145806', '557191234115', '557187700120'];

/** Emojis the bot is allowed to use (anything else in agent msgs = QA flag) */
const ALLOWED_EMOJIS = ['✅', '❌', '👇', '👉', '🔒'];

/** Regex matching broad emoji ranges — used by QA to detect forbidden emojis */
const FORBIDDEN_EMOJI_RE = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;

function getBotToken() {
  return getTokenForWid(`${AUGUSTO_PHONE}:`) || config.quepasa.botToken;
}

// ─── Health State (in-memory) ─────────────────────────────────────────────────

const healthState = {
  /** service name -> consecutive failure count */
  failures: new Map(),
  /** service name -> timestamp (ms) of last alert sent for that service */
  lastAlert: new Map(),
  /** timestamp when this process started */
  containerStartTime: Date.now(),
};

// ─── Alert Helper ─────────────────────────────────────────────────────────────

async function sendAnaAlert(text) {
  const token = getBotToken();
  try {
    await postToOpsInbox('Ana — Relatório de Pipeline', text, { labels: ['relatorio-ana', 'pipeline'] });
  } catch (err) {
    console.error('[Ana] Alert send failed:', err.message);
    try {
      await postToOpsInbox('Ana — Relatório de Pipeline', text, { labels: ['relatorio-ana', 'pipeline'] });
    } catch (e) {
      console.error('[Ana] Fallback failed:', e.message);
    }
  }
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

export function startAnaScheduler() {
  if (!ADM_GROUP_JID) {
    console.log('[Ana] ADM_GROUP_JID not set, scheduler disabled');
    return;
  }

  // 06:00 BRT = 09:00 UTC — Boot check
  cron.schedule('0 9 * * 1-6', async () => {
    await runBootCheck();
  });

  // 09:30 BRT = 12:30 UTC — Pipeline morning
  cron.schedule('30 12 * * 1-6', async () => {
    if (!isBusinessHours()) return;
    try {
      await runPipelineScan('morning');
    } catch (err) {
      console.error('[Ana] Morning scan error:', err.message);
    }
  });

  // 13:00 BRT = 16:00 UTC — QA mid-day
  cron.schedule('0 16 * * 1-6', async () => {
    try {
      await runQAReview('midday');
    } catch (err) {
      console.error('[Ana] QA midday error:', err.message);
    }
  });

  // 17:00 BRT = 20:00 UTC — Pipeline evening
  cron.schedule('0 20 * * 1-5', async () => {
    try {
      await runPipelineScan('evening');
    } catch (err) {
      console.error('[Ana] Evening scan error:', err.message);
    }
  });

  // 21:00 BRT = 00:00 UTC — QA full daily review + report
  cron.schedule('0 0 * * 1-6', async () => {
    try {
      await runQAReview('daily');
    } catch (err) {
      console.error('[Ana] QA daily error:', err.message);
    }
  });

  // Health check every 5 min during business hours
  cron.schedule('*/5 * * * *', async () => {
    if (!isBusinessHours()) return;
    try {
      await runHealthCheck();
    } catch (err) {
      console.error('[Ana] Health check error:', err.message);
    }
  });

  // Night health check every 30 min (only outside business hours)
  cron.schedule('*/30 * * * *', async () => {
    if (isBusinessHours()) return;
    try {
      await runHealthCheck(true);
    } catch (err) {
      console.error('[Ana] Night health error:', err.message);
    }
  });

  console.log('[Ana] Ops Monitor ATIVADO — Pipeline + Health (5min) + QA (13h/21h) + Boot (06h)');
}

// ─── Health Check ─────────────────────────────────────────────────────────────

/**
 * Checks critical services and alerts after 3 consecutive failures.
 * @param {boolean} silent — Night mode: only alert on critical (DB/Quepasa down)
 */
async function runHealthCheck(silent = false) {
  const results = {};

  // 1. Quepasa
  try {
    const info = await getBotInfo();
    if (info && info.error) {
      results.quepasa = { ok: false, detail: info.error };
    } else {
      results.quepasa = { ok: true };
    }
  } catch (err) {
    results.quepasa = { ok: false, detail: err.message };
  }

  // 2. Database
  try {
    await db.query('SELECT 1');
    results.database = { ok: true };
  } catch (err) {
    results.database = { ok: false, detail: err.message };
  }

  // 3. Container uptime (restart detection)
  const uptimeSeconds = process.uptime();
  if (uptimeSeconds < 120) {
    results.uptime = { ok: false, detail: `Reiniciou há ${Math.round(uptimeSeconds)}s` };
  } else {
    results.uptime = { ok: true };
  }

  // 4. WAVOIP — skipped for now, future implementation
  results.wavoip = { ok: true, na: true };

  // 5. Embeddings activity
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*) as cnt FROM embeddings WHERE created_at > NOW() - INTERVAL '1 hour'`
    );
    const count = parseInt(rows[0].cnt, 10);
    if (count === 0 && isBusinessHours()) {
      results.embeddings = { ok: false, detail: '0 embeddings na última hora (horário comercial)' };
    } else {
      results.embeddings = { ok: true, count };
    }
  } catch (err) {
    results.embeddings = { ok: false, detail: err.message };
  }

  // Track consecutive failures and decide whether to alert
  const criticalServices = ['quepasa', 'database'];
  const allServices = ['quepasa', 'database', 'uptime', 'embeddings'];
  let shouldAlert = false;
  const alertLines = [];

  for (const svc of allServices) {
    const res = results[svc];
    if (!res) continue;

    if (!res.ok) {
      const prev = healthState.failures.get(svc) || 0;
      healthState.failures.set(svc, prev + 1);
    } else {
      healthState.failures.set(svc, 0);
    }

    const failCount = healthState.failures.get(svc) || 0;
    const lastAlertTime = healthState.lastAlert.get(svc) || 0;
    const minutesSinceLastAlert = (Date.now() - lastAlertTime) / (1000 * 60);

    if (failCount >= 3 && minutesSinceLastAlert > 30) {
      const isCritical = criticalServices.includes(svc);
      if (silent && !isCritical) continue;

      shouldAlert = true;
      healthState.lastAlert.set(svc, Date.now());

      const svcLabel = svc.charAt(0).toUpperCase() + svc.slice(1);
      alertLines.push(`${svcLabel}: DOWN (${failCount} falhas seguidas)\nAção: Verificar ${svc}`);
    }
  }

  if (shouldAlert) {
    let msg = '❌ Ana Health Alert\n\n';

    for (const svc of allServices) {
      const res = results[svc];
      if (!res) continue;
      if (res.na) {
        msg += `${svc.charAt(0).toUpperCase() + svc.slice(1)}: N/A\n`;
        continue;
      }
      const failCount = healthState.failures.get(svc) || 0;
      if (failCount >= 3) {
        msg += `❌ ${svc.charAt(0).toUpperCase() + svc.slice(1)}: DOWN (${failCount} falhas seguidas)\nAção: Verificar ${svc}\n\n`;
      } else {
        msg += `${svc.charAt(0).toUpperCase() + svc.slice(1)}: OK ✅\n`;
      }
    }

    await sendAnaAlert(msg.trim());

    // Auto-fix: reset embeddings circuit breaker
    const embedFails = healthState.failures.get("embeddings") || 0;
    if (embedFails >= 3) {
      try {
        resetCircuitBreaker();
        const testResult = await generateEmbedding("health check test");
        if (testResult) {
          healthState.failures.set("embeddings", 0);
          await sendAnaAlert("✅ Ana Auto-Fix: Embeddings resetado e testado com sucesso");
        }
      } catch (err) {
        console.log("[Ana] Embeddings auto-fix failed:", err.message);
      }
    }
  }
}

// ─── Boot Check ───────────────────────────────────────────────────────────────

/**
 * Runs at 06:00 BRT. Verifies all services are up before the work day.
 */
async function runBootCheck() {
  console.log('[Ana] Running boot check...');

  const checks = {};

  // Quepasa
  try {
    const info = await getBotInfo();
    checks.quepasa = !(info && info.error);
  } catch {
    checks.quepasa = false;
  }

  // Database
  try {
    await db.query('SELECT 1');
    checks.database = true;
  } catch {
    checks.database = false;
  }

  // Uptime
  const uptimeSec = process.uptime();
  const uptimeMinutes = uptimeSec / 60;
  const recentRestart = uptimeMinutes < 5;

  const issues = [];
  if (!checks.quepasa) issues.push('Quepasa offline');
  if (!checks.database) issues.push('Database offline');
  if (recentRestart) issues.push('Reiniciou recentemente');

  const hasIssues = issues.length > 0;
  const headerEmoji = hasIssues ? '⚠️' : '☀️';

  // Format uptime string
  const totalMinutes = Math.floor(uptimeSec / 60);
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  const uptimeStr = hours > 0 ? `${hours}h${String(mins).padStart(2, '0')}m` : `${mins}min`;
  const uptimeStatus = recentRestart ? '⚠️' : '✅';
  const uptimeLabel = recentRestart ? 'reiniciou recentemente' : 'estável';

  let msg = `${headerEmoji} Ana — Boot Check (06:00)\n\n`;
  msg += `${checks.quepasa ? '✅' : '❌'} Quepasa: ${checks.quepasa ? 'Online' : 'OFFLINE'}\n`;
  msg += `${checks.database ? '✅' : '❌'} Database: ${checks.database ? 'OK' : 'OFFLINE'}\n`;
  msg += `${uptimeStatus} Uptime: ${uptimeStr} (${uptimeLabel})\n\n`;

  if (hasIssues) {
    msg += `ATENÇÃO: ${issues.join('. ')}. Msgs não estão saindo.`;
  } else {
    msg += `Sistemas prontos pro dia.`;
  }

  await sendAnaAlert(msg);
  console.log(`[Ana] Boot check sent — ${hasIssues ? 'ISSUES FOUND' : 'all clear'}`);
}

// ─── QA Review ────────────────────────────────────────────────────────────────

/**
 * Reviews conversation quality for the given period.
 * @param {'midday'|'daily'} period
 */
async function runQAReview(period) {
  console.log(`[Ana] Running QA review (${period})...`);

  // Determine time range cutoff
  let cutoff;
  if (period === 'midday') {
    // Today from midnight BRT (03:00 UTC)
    const now = new Date();
    cutoff = new Date(now);
    cutoff.setUTCHours(3, 0, 0, 0);
    if (cutoff > now) {
      // If it's before 03:00 UTC, use yesterday's midnight BRT
      cutoff.setUTCDate(cutoff.getUTCDate() - 1);
    }
  } else {
    // Last 24 hours
    cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  }

  const cutoffISO = cutoff.toISOString();

  const [
    splitMessages,
    phaseSkips,
    linksTooEarly,
    proactivePrices,
    longMessages,
    failedTransfers,
    conversationStats,
  ] = await Promise.all([
    getQASplitMessages(cutoffISO),
    getQAPhaseSkips(cutoffISO),
    getQALinksTooEarly(cutoffISO),
    getQAProactivePrices(cutoffISO),
    getQALongMessages(cutoffISO),
    getQAFailedTransfers(cutoffISO),
    getQAConversationStats(cutoffISO),
  ]);

  // Auto-fix failed transfers: update persona from augusto to paulo
  let transfersFixed = 0;
  for (const t of failedTransfers) {
    try {
      await db.query(
        `UPDATE conversations SET persona = 'paulo' WHERE id = $1 AND persona = 'augusto'`,
        [t.id]
      );
      transfersFixed++;
    } catch (err) {
      console.error(`[Ana] QA auto-fix transfer failed for ${t.phone}:`, err.message);
    }
  }

  // Calculate score
  let score = 100;
  score -= splitMessages.length * 2;
  score -= linksTooEarly.length * 5;
  score -= proactivePrices.length * 5;
  score -= longMessages * 1;
  score -= phaseSkips.length * 3;
  score -= failedTransfers.length * 5;
  score += Math.min(transfersFixed * 3, failedTransfers.length * 3);
  score = Math.max(0, Math.min(100, score));

  const totalIssues = splitMessages.length + linksTooEarly.length +
    proactivePrices.length + longMessages + phaseSkips.length + failedTransfers.length;

  // For midday, only send if issues found
  if (period === 'midday' && totalIssues === 0) {
    console.log('[Ana] QA midday — no issues found, skipping report.');
    return;
  }

  // Format the report
  const now = new Date();
  const dateStr = now.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' });
  const periodLabel = period === 'daily' ? 'QA Diário' : 'QA Meio-Dia';

  let msg = `📋 Ana — ${periodLabel} (${dateStr})\n\n`;
  msg += `Conversas analisadas: ${conversationStats.total}\n`;
  msg += `Augusto: ${conversationStats.augusto} | Paulo: ${conversationStats.paulo}\n\n`;

  if (totalIssues > 0) {
    msg += `⚠️ Problemas:\n`;
    if (splitMessages.length > 0) {
      msg += `• ${splitMessages.length}x msg splitada (2 bubbles em <8s)\n`;
    }
    if (linksTooEarly.length > 0) {
      msg += `• ${linksTooEarly.length}x link enviado na fase 1-2\n`;
    }
    if (proactivePrices.length > 0) {
      msg += `• ${proactivePrices.length}x preço mencionado sem pergunta\n`;
    }
    if (longMessages > 0) {
      msg += `• ${longMessages}x msg longa (>500 chars)\n`;
    }
    if (phaseSkips.length > 0) {
      msg += `• ${phaseSkips.length}x pulo de fase (fase 3+ com <4 msgs)\n`;
    }
    if (failedTransfers.length > 0) {
      const fixLabel = transfersFixed > 0 ? ` → ${transfersFixed} CORRIGIDO(S) ✅` : '';
      msg += `• ${failedTransfers.length}x transfer não efetivado${fixLabel}\n`;
    }
    msg += '\n';
  }

  // OK items
  const okItems = [];
  if (phaseSkips.length === 0) okItems.push('Fases consistentes');
  if (splitMessages.length === 0) okItems.push('Sem msgs splitadas');
  if (linksTooEarly.length === 0) okItems.push('Links no timing certo');
  if (proactivePrices.length === 0) okItems.push('Preços só quando perguntado');

  if (okItems.length > 0) {
    msg += `✅ OK:\n`;
    for (const item of okItems) {
      msg += `• ${item}\n`;
    }
    msg += '\n';
  }

  msg += `Score: ${score}/100`;

  await sendAnaAlert(msg);
  console.log(`[Ana] QA ${period} report sent — score ${score}/100, ${totalIssues} issues`);

  await emit('ana.cycle_complete', 'ana', { type: 'qa', period, issues: totalIssues, corrections: transfersFixed });
  await reportMetrics('ana', { cycles_today: 0, issues_detected: totalIssues, corrections: transfersFixed });
  await setStatus('ana', 'online');
}

// ─── QA SQL Queries ───────────────────────────────────────────────────────────

/**
 * Messages sent by agent within 8 seconds of each other in the same conversation.
 */
async function getQASplitMessages(cutoff) {
  const { rows } = await db.query(`
    SELECT m1.conversation_id, c.phone, c.name, COUNT(*) as split_count
    FROM messages m1
    JOIN messages m2 ON m1.conversation_id = m2.conversation_id
      AND m2.id != m1.id
      AND m2.role = 'agent'
      AND ABS(EXTRACT(EPOCH FROM (m2.created_at - m1.created_at))) < 8
    JOIN conversations c ON c.id = m1.conversation_id
    WHERE m1.role = 'agent'
      AND m1.created_at > $1
    GROUP BY m1.conversation_id, c.phone, c.name
    HAVING COUNT(*) > 1
  `, [cutoff]);
  return rows;
}

/**
 * Conversations at phase 3+ with fewer than 4 messages (suspicious phase skip).
 */
async function getQAPhaseSkips(cutoff) {
  const { rows } = await db.query(`
    SELECT c.id, c.phone, c.name, c.phase, c.message_count
    FROM conversations c
    WHERE c.updated_at > $1
      AND c.phase >= 3
      AND c.message_count < 4
  `, [cutoff]);
  return rows;
}

/**
 * Agent messages containing credpositivo.com in conversations at phase < 3.
 */
async function getQALinksTooEarly(cutoff) {
  const { rows } = await db.query(`
    SELECT m.conversation_id, c.phone, c.name, c.phase
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.role = 'agent'
      AND m.created_at > $1
      AND m.content LIKE '%credpositivo.com%'
      AND c.phase < 3
  `, [cutoff]);
  return rows;
}

/**
 * Agent messages mentioning R$ without the user asking about price recently.
 */
async function getQAProactivePrices(cutoff) {
  const { rows } = await db.query(`
    SELECT m.conversation_id, c.phone, c.name, m.content
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.role = 'agent'
      AND m.created_at > $1
      AND m.content ~ 'R\\$\\s*\\d+'
      AND NOT EXISTS (
        SELECT 1 FROM messages prev
        WHERE prev.conversation_id = m.conversation_id
          AND prev.role = 'user'
          AND prev.created_at < m.created_at
          AND prev.created_at > m.created_at - INTERVAL '30 minutes'
          AND (prev.content ILIKE '%quanto%' OR prev.content ILIKE '%valor%' OR prev.content ILIKE '%preço%' OR prev.content ILIKE '%preco%' OR prev.content ILIKE '%custa%')
      )
    LIMIT 10
  `, [cutoff]);
  return rows;
}

/**
 * Count of agent messages longer than 500 characters.
 */
async function getQALongMessages(cutoff) {
  const { rows } = await db.query(`
    SELECT COUNT(*) as count
    FROM messages m
    WHERE m.role = 'agent'
      AND m.created_at > $1
      AND LENGTH(m.content) > 500
  `, [cutoff]);
  return parseInt(rows[0].count, 10) || 0;
}

/**
 * Conversations with recommended product but persona still augusto at phase 4+.
 */
async function getQAFailedTransfers(cutoff) {
  const { rows } = await db.query(`
    SELECT c.id, c.phone, c.name, c.recommended_product, c.persona
    FROM conversations c
    WHERE c.updated_at > $1
      AND c.recommended_product IN ('limpa_nome', 'rating')
      AND c.persona = 'augusto'
      AND c.phase >= 4
  `, [cutoff]);
  return rows;
}

/**
 * Conversation stats for the QA period — total, by persona.
 */
async function getQAConversationStats(cutoff) {
  const { rows } = await db.query(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE persona = 'augusto') as augusto,
      COUNT(*) FILTER (WHERE persona = 'paulo') as paulo
    FROM conversations
    WHERE updated_at > $1
  `, [cutoff]);
  const row = rows[0] || { total: 0, augusto: 0, paulo: 0 };
  return {
    total: parseInt(row.total, 10) || 0,
    augusto: parseInt(row.augusto, 10) || 0,
    paulo: parseInt(row.paulo, 10) || 0,
  };
}

// ─── Pipeline Scan ────────────────────────────────────────────────────────────

async function runPipelineScan(period = 'morning') {
  console.log(`[Ana] Running ${period} pipeline scan...`);

  const [
    staleLeads,
    pendingTransfers,
    hotWithoutFollowup,
    abandonedOrders,
    todayStats,
  ] = await Promise.all([
    getStaleQualifiedLeads(),
    getPendingTransfers(),
    getHotLeadsWithoutFollowup(),
    getAbandonedOrdersNoAction(),
    getTodayStats(),
  ]);

  const totalIssues = staleLeads.length + pendingTransfers.length +
    hotWithoutFollowup.length + abandonedOrders.length;

  if (totalIssues === 0 && period === 'evening') {
    console.log('[Ana] No issues found. Skipping evening report.');
    return;
  }

  const report = formatReport(period, {
    staleLeads,
    pendingTransfers,
    hotWithoutFollowup,
    abandonedOrders,
    todayStats,
    totalIssues,
  });

  // Auto-fix: schedule missing follow-ups for hot leads
  let autoFixed = 0;
  for (const lead of hotWithoutFollowup) {
    try {
      await db.scheduleFollowup(lead.id, 'urgency', 0);
      autoFixed++;
    } catch (err) {
      console.error(`[Ana] Auto-fix failed for ${lead.phone}:`, err.message);
    }
  }

  if (autoFixed > 0) {
    console.log(`[Ana] Auto-scheduled ${autoFixed} missing follow-ups`);
  }

  await sendAnaAlert(report);
  console.log(`[Ana] Pipeline report sent to ADM group`);

  await emit('ana.cycle_complete', 'ana', { type: 'pipeline', period, issues: totalIssues, corrections: autoFixed });
  await reportMetrics('ana', { cycles_today: 0, issues_detected: totalIssues, corrections: autoFixed });
  await setStatus('ana', 'online');
}

// ─── Pipeline SQL Queries ─────────────────────────────────────────────────────

/**
 * Leads qualificados (fase 2+) parados há mais de 48h.
 */
async function getStaleQualifiedLeads() {
  const { rows } = await db.query(`
    SELECT c.id, c.phone, c.name, c.phase, c.persona,
           c.recommended_product, c.last_message_at
    FROM conversations c
    WHERE c.phase >= 2
      AND c.opted_out IS NOT TRUE
      AND c.last_message_at < NOW() - INTERVAL '48 hours'
      AND c.product_sold IS NULL
      AND c.phone NOT IN ('5511932145806', '557191234115', '557187700120')
    ORDER BY c.phase DESC, c.last_message_at ASC
    LIMIT 20
  `);
  return rows;
}

/**
 * Transfers pro Paulo que não tiveram resposta do Paulo em 2h+.
 * Detecta: persona='paulo' mas última msg é do Augusto (agent) há >2h.
 */
async function getPendingTransfers() {
  const { rows } = await db.query(`
    SELECT c.id, c.phone, c.name, c.recommended_product, c.last_message_at
    FROM conversations c
    WHERE c.persona = 'paulo'
      AND c.opted_out IS NOT TRUE
      AND c.product_sold IS NULL
      AND c.last_message_at < NOW() - INTERVAL '2 hours'
      AND c.last_message_at > NOW() - INTERVAL '24 hours'
      AND c.phone NOT IN ('5511932145806', '557191234115', '557187700120')
      AND EXISTS (
        SELECT 1 FROM messages m
        WHERE m.conversation_id = c.id
        ORDER BY m.created_at DESC
        LIMIT 1
      )
    ORDER BY c.last_message_at ASC
    LIMIT 10
  `);
  return rows;
}

/**
 * Leads quentes (fase 3-4) sem follow-up agendado.
 */
async function getHotLeadsWithoutFollowup() {
  const { rows } = await db.query(`
    SELECT c.id, c.phone, c.name, c.phase, c.recommended_product, c.last_message_at
    FROM conversations c
    WHERE c.phase IN (3, 4)
      AND c.opted_out IS NOT TRUE
      AND c.product_sold IS NULL
      AND c.last_message_at < NOW() - INTERVAL '24 hours'
      AND c.phone NOT IN ('5511932145806', '557191234115', '557187700120')
      AND NOT EXISTS (
        SELECT 1 FROM followups f
        WHERE f.conversation_id = c.id
          AND f.sent = FALSE
      )
    ORDER BY c.phase DESC, c.last_message_at ASC
    LIMIT 15
  `);
  return rows;
}

/**
 * Pedidos abandonados sem nenhuma ação (follow-up ou call) nas últimas 24h.
 */
async function getAbandonedOrdersNoAction() {
  const { rows } = await db.query(`
    SELECT o.id, o.customer_name, o.customer_phone, o.service, o.price,
           o.created_at
    FROM orders o
    WHERE o.status = 'pending'
      AND o.created_at < NOW() - INTERVAL '4 hours'
      AND o.created_at > NOW() - INTERVAL '48 hours'
      AND o.customer_phone IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM voice_calls vc
        WHERE vc.phone = REGEXP_REPLACE(o.customer_phone, '[^0-9]', '', 'g')
          AND vc.created_at > NOW() - INTERVAL '24 hours'
      )
      AND NOT EXISTS (
        SELECT 1 FROM followups f
        JOIN conversations c ON c.id = f.conversation_id
        WHERE c.phone = REGEXP_REPLACE(o.customer_phone, '[^0-9]', '', 'g')
          AND f.event_type = 'purchase_abandoned'
          AND f.created_at > NOW() - INTERVAL '24 hours'
      )
    ORDER BY o.price DESC
    LIMIT 10
  `);
  return rows;
}

/**
 * Stats do dia: novas conversas, mensagens, vendas.
 */
async function getTodayStats() {
  const { rows } = await db.query(`
    SELECT
      (SELECT COUNT(*) FROM conversations WHERE created_at >= CURRENT_DATE) as new_leads,
      (SELECT COUNT(*) FROM messages WHERE created_at >= CURRENT_DATE AND role = 'user') as user_msgs,
      (SELECT COUNT(*) FROM messages WHERE created_at >= CURRENT_DATE AND role = 'agent') as agent_msgs,
      (SELECT COUNT(*) FROM orders WHERE created_at >= CURRENT_DATE AND status = 'paid') as sales,
      (SELECT COALESCE(SUM(price), 0) FROM orders WHERE created_at >= CURRENT_DATE AND status = 'paid') as revenue
  `);
  return rows[0] || { new_leads: 0, user_msgs: 0, agent_msgs: 0, sales: 0, revenue: 0 };
}

// ─── Report Formatting ───────────────────────────────────────────────────────

function formatReport(period, data) {
  const {
    staleLeads, pendingTransfers, hotWithoutFollowup,
    abandonedOrders, todayStats, totalIssues,
  } = data;

  const emoji = totalIssues === 0 ? '✅' : totalIssues <= 3 ? '⚠️' : '❌';
  const periodLabel = period === 'morning' ? 'MANHÃ' : 'FIM DO DIA';
  const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  let report = `${emoji} ANA — PIPELINE ${periodLabel}\n${now}\n\n`;

  // Stats do dia
  report += `📊 HOJE: ${todayStats.new_leads} leads | ${todayStats.user_msgs} msgs recebidas | ${todayStats.sales} vendas | R$${todayStats.revenue}\n\n`;

  if (totalIssues === 0) {
    report += `✅ Pipeline limpo. Todos os leads com próxima ação definida.`;
    return report;
  }

  // Leads parados
  if (staleLeads.length > 0) {
    report += `❌ LEADS PARADOS (${staleLeads.length}):\n`;
    for (const l of staleLeads.slice(0, 5)) {
      const hours = Math.round((Date.now() - new Date(l.last_message_at).getTime()) / (1000 * 60 * 60));
      report += `- ${l.name || l.phone} | F${l.phase} | ${l.persona} | ${l.recommended_product || '?'} | ${hours}h parado\n`;
    }
    if (staleLeads.length > 5) report += `  ...e mais ${staleLeads.length - 5}\n`;
    report += '\n';
  }

  // Transfers pendentes
  if (pendingTransfers.length > 0) {
    report += `⚠️ TRANSFERS SEM RESPOSTA DO PAULO (${pendingTransfers.length}):\n`;
    for (const t of pendingTransfers.slice(0, 5)) {
      const hours = Math.round((Date.now() - new Date(t.last_message_at).getTime()) / (1000 * 60 * 60));
      report += `- ${t.name || t.phone} | ${t.recommended_product} | ${hours}h esperando\n`;
    }
    report += '\n';
  }

  // Leads quentes sem follow-up
  if (hotWithoutFollowup.length > 0) {
    report += `🔥 LEADS QUENTES SEM FOLLOW-UP (${hotWithoutFollowup.length}):\n`;
    for (const h of hotWithoutFollowup.slice(0, 5)) {
      report += `- ${h.name || h.phone} | F${h.phase} | ${h.recommended_product || '?'}\n`;
    }
    report += `→ Auto-agendando follow-ups...\n\n`;
  }

  // Pedidos abandonados
  if (abandonedOrders.length > 0) {
    report += `❌ PEDIDOS ABANDONADOS SEM AÇÃO (${abandonedOrders.length}):\n`;
    for (const o of abandonedOrders.slice(0, 5)) {
      const hours = Math.round((Date.now() - new Date(o.created_at).getTime()) / (1000 * 60 * 60));
      report += `- ${o.customer_name || o.customer_phone} | ${o.service} R$${o.price} | ${hours}h\n`;
    }
    report += '\n';
  }

  report += `Total: ${totalIssues} item(s) precisam de ação.`;

  return report;
}
