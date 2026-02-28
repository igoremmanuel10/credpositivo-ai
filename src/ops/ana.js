/**
 * Ana — Ops Monitor (Pipeline Watchdog)
 *
 * Runs 2x/day (09:30 + 17:00 BRT) during business hours.
 * Scans the pipeline for:
 *   1. Leads qualificados parados (>48h sem interação)
 *   2. Transfers pro Paulo sem resposta (>2h)
 *   3. Leads em fase 3-4 sem follow-up agendado
 *   4. Leads com pedido abandonado sem ação
 *
 * Sends a formatted summary to the ADM WhatsApp group.
 * Auto-schedules missing follow-ups when appropriate.
 *
 * Zero AI calls — pure SQL + formatting.
 */

import cron from 'node-cron';
import { db } from '../db/client.js';
import { sendText, getTokenForWid } from '../quepasa/client.js';
import { config, isBusinessHours } from '../config.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const ADM_GROUP_JID = process.env.ADM_GROUP_JID || '';
const AUGUSTO_PHONE = '5571936180654';

/** Admin phones — for fallback if group JID not set */
const ADMIN_PHONES = ['5511932145806', '557191234115', '557187700120'];

function getBotToken() {
  return getTokenForWid(`${AUGUSTO_PHONE}:`) || config.quepasa.botToken;
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

export function startAnaScheduler() {
  if (!ADM_GROUP_JID) {
    console.log('[Ana] ADM_GROUP_JID not set, scheduler disabled');
    return;
  }

  // 09:30 BRT = 12:30 UTC (after Luan's 09:00 report)
  cron.schedule('30 12 * * 1-6', async () => {
    if (!isBusinessHours()) return;
    try {
      await runPipelineScan('morning');
    } catch (err) {
      console.error('[Ana] Morning scan error:', err.message);
    }
  });

  // 17:00 BRT = 20:00 UTC (end of day check)
  cron.schedule('0 20 * * 1-5', async () => {
    try {
      await runPipelineScan('evening');
    } catch (err) {
      console.error('[Ana] Evening scan error:', err.message);
    }
  });

  console.log('[Ana] Pipeline monitor ATIVADO (09:30 + 17:00 BRT, seg-sáb)');
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

  // Send to ADM group
  const token = getBotToken();
  try {
    await sendText(ADM_GROUP_JID, report, token);
    console.log(`[Ana] Pipeline report sent to ADM group`);
  } catch (err) {
    console.error('[Ana] Failed to send to group:', err.message);
    // Fallback: send to first admin phone
    try {
      await sendText(ADMIN_PHONES[0], report, token);
    } catch (err2) {
      console.error('[Ana] Fallback also failed:', err2.message);
    }
  }
}

// ─── SQL Queries ──────────────────────────────────────────────────────────────

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

  const emoji = totalIssues === 0 ? '✅' : totalIssues <= 3 ? '👆' : '❌';
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
    report += `👆 TRANSFERS SEM RESPOSTA DO PAULO (${pendingTransfers.length}):\n`;
    for (const t of pendingTransfers.slice(0, 5)) {
      const hours = Math.round((Date.now() - new Date(t.last_message_at).getTime()) / (1000 * 60 * 60));
      report += `- ${t.name || t.phone} | ${t.recommended_product} | ${hours}h esperando\n`;
    }
    report += '\n';
  }

  // Leads quentes sem follow-up
  if (hotWithoutFollowup.length > 0) {
    report += `👇 LEADS QUENTES SEM FOLLOW-UP (${hotWithoutFollowup.length}):\n`;
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
