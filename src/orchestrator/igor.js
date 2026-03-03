/**
 * Igor — Orquestrador de Vendas (Hormozi Framework)
 *
 * Monitora em tempo real TODAS as conversas ativas do Augusto e Paulo.
 * Detecta e corrige problemas automaticamente.
 *
 * Schedule:
 *   every 2min (business hours) — Monitor ativo de conversas
 *   every 10min (fora do horário) — Monitor leve
 *
 * O que Igor faz:
 *   1. Monitora qualidade das conversas em tempo real
 *   2. Detecta erros: msgs longas, produto errado, lead abandonado, pressa
 *   3. Corrige automaticamente: ajusta fase, produto, estado da conversa
 *   4. Coordena handoffs Augusto → Paulo (só pós-diagnóstico)
 *   5. Garante regras Hormozi: Dor + Capacidade + Decisão + Urgência
 *   6. Nunca permite 2 agentes no mesmo lead ao mesmo tempo
 *   7. Gera relatório de supervisão a cada ciclo
 *
 * Framework Hormozi:
 *   Volume × Conversão × Preço = Receita
 *   Escalar intensidade: texto > áudio > prova social > ligação
 *   Todo lead tem: dono, status, próxima ação, data
 */

import { db } from '../db/client.js';
import { config, isBusinessHours } from '../config.js';
import { postToOpsInbox } from '../chatwoot/ops-inbox.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const MONITOR_INTERVAL_BIZ = 2 * 60 * 1000;    // 2 min em horário comercial
const MONITOR_INTERVAL_OFF = 10 * 60 * 1000;   // 10 min fora do horário

// Limites de qualidade
const MAX_MSG_LENGTH = 200;         // chars — mensagens maiores = problema
const MAX_QUESTIONS_PER_MSG = 1;    // apenas 1 pergunta por mensagem
const MIN_RESPONSE_DELAY_S = 5;     // segundos — abaixo disso parece robô
const MAX_PHASE_WITHOUT_DIAG = 3;   // não pode chegar fase 3+ sem recomendar diagnóstico
const MAX_MSGS_WITHOUT_LINK = 8;    // se já qualificou e não mandou link, problema
const STALE_CONVERSATION_MIN = 30;  // minutos sem resposta = potencial abandono

// ─── State ────────────────────────────────────────────────────────────────────

let monitorInterval = null;
let cycleCount = 0;
let lastCycleStats = { checked: 0, issues: 0, fixes: 0 };

// ─── Main Scheduler ──────────────────────────────────────────────────────────

export function startIgorScheduler() {
  console.log('[Igor] Orquestrador iniciado — monitoramento em tempo real ativo');

  // Primeiro ciclo após 30s de startup
  setTimeout(() => runMonitorCycle(), 30 * 1000);

  // Ciclos regulares
  monitorInterval = setInterval(() => {
    runMonitorCycle().catch(err => {
      console.error('[Igor] Erro no ciclo de monitoramento:', err.message);
    });
  }, isBusinessHours() ? MONITOR_INTERVAL_BIZ : MONITOR_INTERVAL_OFF);

  // Ajusta intervalo baseado em horário comercial (verifica a cada 30 min)
  setInterval(() => {
    const newInterval = isBusinessHours() ? MONITOR_INTERVAL_BIZ : MONITOR_INTERVAL_OFF;
    if (monitorInterval?._idleTimeout !== newInterval) {
      clearInterval(monitorInterval);
      monitorInterval = setInterval(() => {
        runMonitorCycle().catch(err => {
          console.error('[Igor] Erro no ciclo:', err.message);
        });
      }, newInterval);
    }
  }, 30 * 60 * 1000);
}

// ─── Monitor Cycle ───────────────────────────────────────────────────────────

async function runMonitorCycle() {
  cycleCount++;
  const stats = { checked: 0, issues: [], fixes: 0 };

  try {
    // 1. Buscar conversas ativas (última msg nas últimas 2h)
    const activeConvs = await getActiveConversations();
    stats.checked = activeConvs.length;

    for (const conv of activeConvs) {
      const issues = await analyzeConversation(conv);
      if (issues.length > 0) {
        stats.issues.push(...issues);
        const fixCount = await applyCorrections(conv, issues);
        stats.fixes += fixCount;
      }
    }

    // 2. Verificar leads abandonados (nenhuma msg nas últimas 2-24h)
    const abandonedIssues = await checkAbandonedLeads();
    stats.issues.push(...abandonedIssues);

    // 3. Verificar conflitos de agentes (2 agentes no mesmo lead)
    const conflictIssues = await checkAgentConflicts();
    stats.issues.push(...conflictIssues);

    // 4. Log do ciclo
    lastCycleStats = { checked: stats.checked, issues: stats.issues.length, fixes: stats.fixes };

    if (stats.issues.length > 0) {
      console.log(`[Igor] Ciclo #${cycleCount}: ${stats.checked} conversas, ${stats.issues.length} problemas, ${stats.fixes} correcoes`);

      // Relatório apenas se muitos problemas (evita spam)
      if (stats.issues.length >= 3 && cycleCount % 5 === 0) {
        await sendIgorReport(stats);
      }
    }

  } catch (err) {
    console.error(`[Igor] Ciclo #${cycleCount} falhou:`, err.message);
  }
}

// ─── Conversation Analysis ───────────────────────────────────────────────────

async function analyzeConversation(conv) {
  const issues = [];
  const messages = conv.messages || [];
  if (messages.length === 0) return issues;

  const agentMsgs = messages.filter(m => m.role === 'agent');
  const userMsgs = messages.filter(m => m.role === 'user');
  const lastMsg = messages[messages.length - 1];

  // === REGRA 1: Mensagens longas demais ===
  for (const msg of agentMsgs) {
    if (msg.content && msg.content.length > MAX_MSG_LENGTH) {
      issues.push({
        type: 'msg_longa',
        severity: 'media',
        conv_id: conv.id,
        name: conv.name,
        detail: `Msg com ${msg.content.length} chars (max ${MAX_MSG_LENGTH})`,
        auto_fix: false,
      });
    }
  }

  // === REGRA 2: Produto errado (não é diagnóstico na fase inicial) ===
  if (conv.phase <= 3 && conv.recommended_product && conv.recommended_product !== 'diagnostico') {
    issues.push({
      type: 'produto_errado',
      severity: 'alta',
      conv_id: conv.id,
      name: conv.name,
      detail: `Fase ${conv.phase} com produto "${conv.recommended_product}" — deveria ser "diagnostico"`,
      auto_fix: true,
      fix_action: 'set_product_diagnostico',
    });
  }

  // === REGRA 3: Transfer pro Paulo antes do diagnóstico ===
  if (conv.persona === 'paulo' && !conv.conversion_event_at) {
    // Paulo ativo sem o lead ter comprado nada
    const pauloMsgs = agentMsgs.filter(m =>
      m.content && (m.content.includes('Augusto me passou') || m.content.includes('Paulo'))
    );
    if (pauloMsgs.length > 0 && !conv.sale_value) {
      issues.push({
        type: 'transfer_prematuro',
        severity: 'alta',
        conv_id: conv.id,
        name: conv.name,
        detail: 'Paulo ativo sem lead ter comprado diagnóstico',
        auto_fix: true,
        fix_action: 'revert_to_augusto',
      });
    }
  }

  // === REGRA 4: Respostas rápidas demais (parece robô) ===
  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1];
    const curr = messages[i];
    if (prev.role === 'user' && curr.role === 'agent') {
      const delay = (new Date(curr.created_at) - new Date(prev.created_at)) / 1000;
      if (delay < MIN_RESPONSE_DELAY_S) {
        issues.push({
          type: 'resposta_rapida',
          severity: 'baixa',
          conv_id: conv.id,
          name: conv.name,
          detail: `Resposta em ${delay.toFixed(1)}s (min ${MIN_RESPONSE_DELAY_S}s)`,
          auto_fix: false,
        });
      }
    }
  }

  // === REGRA 5: Mencionou Paulo no texto (Augusto fazendo) ===
  if (conv.persona === 'augusto') {
    const pauloMentions = agentMsgs.filter(m =>
      m.content && /paulo|closer|especialista em limpar/i.test(m.content)
    );
    if (pauloMentions.length > 0) {
      issues.push({
        type: 'mencao_paulo',
        severity: 'media',
        conv_id: conv.id,
        name: conv.name,
        detail: `Augusto mencionou Paulo ${pauloMentions.length}x`,
        auto_fix: false,
      });
    }
  }

  // === REGRA 6: Preço mencionado proativamente ===
  const priceMentions = agentMsgs.filter(m =>
    m.content && /R\$\s*\d+/i.test(m.content)
  );
  if (priceMentions.length > 0) {
    // Verificar se o user pediu preço antes
    const userAskedPrice = userMsgs.some(m =>
      m.content && /quanto|valor|pre[cç]o|custa/i.test(m.content)
    );
    if (!userAskedPrice) {
      issues.push({
        type: 'preco_proativo',
        severity: 'alta',
        conv_id: conv.id,
        name: conv.name,
        detail: `Mencionou preço sem lead perguntar (${priceMentions.length}x)`,
        auto_fix: false,
      });
    }
  }

  // === REGRA 7: Muitas perguntas sem avançar ===
  if (conv.phase <= 2 && agentMsgs.length > 6 && !conv.recommended_product) {
    issues.push({
      type: 'qualificacao_lenta',
      severity: 'media',
      conv_id: conv.id,
      name: conv.name,
      detail: `${agentMsgs.length} msgs do bot na fase ${conv.phase} sem produto definido`,
      auto_fix: false,
    });
  }

  return issues;
}

// ─── Auto-Corrections ────────────────────────────────────────────────────────

async function applyCorrections(conv, issues) {
  let fixes = 0;

  for (const issue of issues) {
    if (!issue.auto_fix) continue;

    try {
      switch (issue.fix_action) {
        case 'set_product_diagnostico':
          await db.updateConversation(conv.id, { recommended_product: 'diagnostico' });
          console.log(`[Igor] FIX: Conv #${conv.id} (${conv.name}) — produto corrigido para "diagnostico"`);
          fixes++;
          break;

        case 'revert_to_augusto':
          await db.updateConversation(conv.id, { persona: 'augusto' });
          console.log(`[Igor] FIX: Conv #${conv.id} (${conv.name}) — revertido de Paulo para Augusto`);
          fixes++;
          break;
      }
    } catch (err) {
      console.error(`[Igor] Falha ao corrigir conv #${conv.id}:`, err.message);
    }
  }

  return fixes;
}

// ─── Abandoned Leads Check ───────────────────────────────────────────────────

async function checkAbandonedLeads() {
  const issues = [];

  try {
    const result = await db.query(`
      SELECT c.id, c.name, c.phone, c.phase, c.persona, c.recommended_product,
             c.last_message_at,
             EXTRACT(EPOCH FROM (NOW() - c.last_message_at))/60 as minutes_silent
      FROM conversations c
      WHERE c.opted_out = false
        AND c.phase BETWEEN 2 AND 4
        AND c.last_message_at < NOW() - INTERVAL '${STALE_CONVERSATION_MIN} minutes'
        AND c.last_message_at > NOW() - INTERVAL '24 hours'
      ORDER BY c.last_message_at ASC
      LIMIT 20
    `);

    for (const row of result.rows) {
      // Verificar se última msg é do user (bot não respondeu)
      const lastMsgResult = await db.query(`
        SELECT role FROM messages
        WHERE conversation_id = $1
        ORDER BY created_at DESC LIMIT 1
      `, [row.id]);

      if (lastMsgResult.rows[0]?.role === 'user') {
        issues.push({
          type: 'lead_abandonado',
          severity: 'critica',
          conv_id: row.id,
          name: row.name,
          detail: `Lead sem resposta há ${Math.round(row.minutes_silent)} min (fase ${row.phase})`,
          auto_fix: false,
        });
      }
    }
  } catch (err) {
    console.error('[Igor] Erro ao verificar leads abandonados:', err.message);
  }

  return issues;
}

// ─── Agent Conflict Check ────────────────────────────────────────────────────

async function checkAgentConflicts() {
  const issues = [];

  try {
    // Buscar leads onde persona=paulo mas sem compra (transfer prematuro)
    const result = await db.query(`
      SELECT c.id, c.name, c.phone, c.phase, c.persona,
             c.recommended_product, c.sale_value, c.conversion_event_at
      FROM conversations c
      WHERE c.persona = 'paulo'
        AND c.conversion_event_at IS NULL
        AND c.sale_value IS NULL
        AND c.opted_out = false
        AND c.last_message_at > NOW() - INTERVAL '48 hours'
      LIMIT 10
    `);

    for (const row of result.rows) {
      issues.push({
        type: 'conflito_agente',
        severity: 'alta',
        conv_id: row.id,
        name: row.name,
        detail: `Paulo ativo sem compra prévia (fase ${row.phase}, produto: ${row.recommended_product || 'nenhum'})`,
        auto_fix: true,
        fix_action: 'revert_to_augusto',
      });
    }
  } catch (err) {
    console.error('[Igor] Erro ao verificar conflitos:', err.message);
  }

  return issues;
}

// ─── Data Fetching ───────────────────────────────────────────────────────────

async function getActiveConversations() {
  try {
    const result = await db.query(`
      SELECT c.id, c.name, c.phone, c.phase, c.persona,
             c.recommended_product, c.last_message_at, c.opted_out,
             c.sale_value, c.conversion_event_at,
             c.link_counter, c.price_counter
      FROM conversations c
      WHERE c.last_message_at > NOW() - INTERVAL '2 hours'
        AND c.opted_out = false
      ORDER BY c.last_message_at DESC
      LIMIT 50
    `);

    // Buscar últimas mensagens de cada conversa
    const conversations = [];
    for (const row of result.rows) {
      const msgsResult = await db.query(`
        SELECT role, content, created_at
        FROM messages
        WHERE conversation_id = $1
        ORDER BY created_at DESC
        LIMIT 10
      `, [row.id]);

      conversations.push({
        ...row,
        messages: msgsResult.rows.reverse(), // cronológico
      });
    }

    return conversations;
  } catch (err) {
    console.error('[Igor] Erro ao buscar conversas ativas:', err.message);
    return [];
  }
}

// ─── Reporting ───────────────────────────────────────────────────────────────

async function sendIgorReport(stats) {
  const issuesByType = {};
  for (const issue of stats.issues) {
    issuesByType[issue.type] = (issuesByType[issue.type] || 0) + 1;
  }

  const criticalIssues = stats.issues.filter(i => i.severity === 'critica' || i.severity === 'alta');

  let report = `CICLO #${cycleCount}\n`;
  report += `Conversas analisadas: ${stats.checked}\n`;
  report += `Problemas encontrados: ${stats.issues.length}\n`;
  report += `Correcoes automaticas: ${stats.fixes}\n\n`;

  report += `RESUMO POR TIPO:\n`;
  for (const [type, count] of Object.entries(issuesByType)) {
    report += `  ${type}: ${count}\n`;
  }

  if (criticalIssues.length > 0) {
    report += `\nPROBLEMAS CRITICOS:\n`;
    for (const issue of criticalIssues.slice(0, 5)) {
      report += `  [${issue.severity.toUpperCase()}] Conv #${issue.conv_id} (${issue.name}): ${issue.detail}\n`;
    }
  }

  try {
    await postToOpsInbox('Igor — Monitoramento de Vendas', report, {
      labels: ['relatorio-igor', 'vendas'],
    });
  } catch (err) {
    console.error('[Igor] Falha ao enviar relatório:', err.message);
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function getIgorStatus() {
  return {
    cycleCount,
    lastCycle: lastCycleStats,
    running: !!monitorInterval,
  };
}

export async function runIgorCycleNow() {
  return runMonitorCycle();
}
