/**
 * Funnel Watcher — vigilância ativa do funil a cada 5 minutos.
 *
 * Detecta e corrige automaticamente os erros recorrentes:
 *   1. Bot-loop: conversas com >20 msgs de bots em sequência → opted_out
 *   2. Follow-up spam: >3 follow-ups pendentes na mesma conversa → cancela excesso
 *   3. Leads mortos: fase 0, sem resposta do user há >5 dias → opted_out
 *   4. Chatwoot degradado persistente: alerta se >3 ciclos seguidos degradado
 *
 * Alertas via WhatsApp apenas para problemas críticos (cooldown 30min por tipo).
 */

import cron from 'node-cron';
import { db } from '../db/client.js';
import { sendText } from '../quepasa/client.js';
import { isBusinessHours } from '../config.js';
import { postToOpsInbox } from '../chatwoot/ops-inbox.js';

const ADMIN_PHONES = ['5511932145806', '557191234115', '557187700120'];

// Cooldown por tipo de alerta (30 min)
const alertCooldown = new Map();
const ALERT_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2h — resiste a restarts ocasionais

// Contador de ciclos com Chatwoot degradado consecutivos
let chatwootDegradedCount = 0;

/**
 * Roda um ciclo completo de vigilância do funil.
 */
export async function runFunnelWatcherCycle() {
  const fixes = [];
  const alerts = [];

  try {
    // 1. Detectar e matar bot-loops
    const botLoopFix = await fixBotLoops();
    if (botLoopFix.fixed > 0) fixes.push(botLoopFix);

    // 2. Detectar e limpar spam de follow-up
    const spamFix = await fixFollowupSpam();
    if (spamFix.fixed > 0) fixes.push(spamFix);

    // 3. Marcar leads mortos como opted_out
    const deadFix = await fixDeadLeads();
    if (deadFix.fixed > 0) fixes.push(deadFix);

    // 4. Detectar travamento crítico de follow-up
    const fuAlert = await detectFollowupStall();
    if (fuAlert) alerts.push(fuAlert);

    // Logar resumo
    const totalFixed = fixes.reduce((s, f) => s + f.fixed, 0);
    if (totalFixed > 0 || alerts.length > 0) {
      console.log(`[FunnelWatcher] Ciclo: ${totalFixed} correções, ${alerts.length} alertas`);
      fixes.forEach(f => console.log(`  ✓ ${f.type}: ${f.fixed} corrigidos`));
    }

    // Enviar alertas críticos (com cooldown)
    for (const alert of alerts) {
      await sendAlertIfCooldownOk(alert.type, alert.message);
    }

    return { fixes, alerts };
  } catch (err) {
    console.error('[FunnelWatcher] Erro no ciclo:', err.message);
    return { fixes, alerts, error: err.message };
  }
}

/**
 * 1. Detecta conversas em bot-loop (bot externo respondendo ao agente)
 *    Padrão: última mensagem do 'user' contém texto típico de bot, repetido.
 *    Ação: marca opted_out = true e cancela follow-ups.
 */
async function fixBotLoops() {
  let fixed = 0;
  try {
    // Busca conversas onde as últimas 5 msgs do user têm padrão de bot externo
    const { rows } = await db.query(`
      SELECT DISTINCT c.id, c.phone, c.persona
      FROM conversations c
      WHERE c.opted_out = false
        AND c.last_message_at > NOW() - INTERVAL '7 days'
        AND (
          -- Padrão 1: mensagem do bot da Capitania / bots com template de menu
          EXISTS (
            SELECT 1 FROM messages m
            WHERE m.conversation_id = c.id
              AND m.role = 'user'
              AND (
                m.content ILIKE '%assistente virtual%'
                OR m.content ILIKE '%Para continuar o atendimento%'
                OR m.content ILIKE '%Digite o número%'
                OR m.content ILIKE '%atendimento virtual%'
                OR m.content ILIKE '%Bot%atendimento%'
                OR m.content ILIKE '%estou aqui para ajudar%conquistar sua moto%'
              )
          )
          OR
          -- Padrão 2: user mandou a mesma mensagem >5x (loop)
          EXISTS (
            SELECT content, COUNT(*) as cnt
            FROM messages m2
            WHERE m2.conversation_id = c.id AND m2.role = 'user'
            GROUP BY content
            HAVING COUNT(*) >= 5
          )
        )
    `);

    for (const conv of rows) {
      // Marca opted_out
      await db.query(
        `UPDATE conversations SET opted_out = true, updated_at = NOW() WHERE id = $1`,
        [conv.id]
      );
      // Cancela todos os follow-ups pendentes
      await db.query(
        `UPDATE followups SET sent = true WHERE conversation_id = $1 AND sent = false`,
        [conv.id]
      );
      console.log(`[FunnelWatcher] Bot-loop detectado e encerrado: conv #${conv.id} (${conv.phone})`);
      fixed++;
    }
  } catch (err) {
    console.error('[FunnelWatcher] fixBotLoops erro:', err.message);
  }
  return { type: 'fix_bot_loops', fixed };
}

/**
 * 2. Detecta spam de follow-up: conversas com >3 follow-ups pendentes na fila.
 *    Mantém apenas o mais antigo (próximo a ser enviado) e cancela o resto.
 */
async function fixFollowupSpam() {
  let fixed = 0;
  try {
    // Busca conversas com excesso de follow-ups pendentes
    const { rows } = await db.query(`
      SELECT conversation_id, COUNT(*) as pending_count,
             MIN(id) as oldest_id
      FROM followups
      WHERE sent = false
        AND scheduled_at <= NOW() + INTERVAL '10 minutes'
      GROUP BY conversation_id
      HAVING COUNT(*) > 3
    `);

    for (const row of rows) {
      // Cancela todos exceto o mais antigo
      const result = await db.query(
        `UPDATE followups
         SET sent = true
         WHERE conversation_id = $1
           AND sent = false
           AND id != $2
           AND scheduled_at <= NOW() + INTERVAL '10 minutes'`,
        [row.conversation_id, row.oldest_id]
      );
      const cancelled = result.rowCount || 0;
      if (cancelled > 0) {
        console.log(`[FunnelWatcher] Follow-up spam: conv #${row.conversation_id} — cancelei ${cancelled} de ${row.pending_count} pendentes`);
        fixed += cancelled;
      }
    }
  } catch (err) {
    console.error('[FunnelWatcher] fixFollowupSpam erro:', err.message);
  }
  return { type: 'fix_followup_spam', fixed };
}

/**
 * 3. Marca leads mortos como opted_out para parar de desperdiçar follow-ups.
 *    Critério: fase 0, nunca responderam (todas msgs são do bot), criados há >5 dias.
 */
async function fixDeadLeads() {
  let fixed = 0;
  try {
    const { rows } = await db.query(`
      SELECT c.id, c.phone
      FROM conversations c
      WHERE c.opted_out = false
        AND c.phase = 0
        AND c.created_at < NOW() - INTERVAL '5 days'
        AND c.last_message_at < NOW() - INTERVAL '3 days'
        AND NOT EXISTS (
          -- Nunca houve mensagem real do user (só nome/nada ou ausente)
          SELECT 1 FROM messages m
          WHERE m.conversation_id = c.id
            AND m.role = 'user'
            AND LENGTH(TRIM(COALESCE(m.content, ''))) > 10
            AND m.content NOT SIMILAR TO '%[A-Z][a-z]+ [A-Z][a-z]+%'
        )
      LIMIT 200
    `);

    if (rows.length > 0) {
      const ids = rows.map(r => r.id);
      await db.query(
        `UPDATE conversations SET opted_out = true, updated_at = NOW()
         WHERE id = ANY($1::int[])`,
        [ids]
      );
      // Cancela follow-ups pendentes desses leads
      await db.query(
        `UPDATE followups SET sent = true
         WHERE conversation_id = ANY($1::int[]) AND sent = false`,
        [ids]
      );
      fixed = rows.length;
      console.log(`[FunnelWatcher] ${fixed} leads mortos marcados como opted_out`);
    }
  } catch (err) {
    console.error('[FunnelWatcher] fixDeadLeads erro:', err.message);
  }
  return { type: 'fix_dead_leads', fixed };
}

/**
 * 4. Detecta travamento crítico de follow-up:
 *    Há >50 follow-ups pendentes há mais de 2h sem nenhum enviado nas últimas 2h.
 */
async function detectFollowupStall() {
  // Fora do horário comercial: fila parada é esperado — não é erro
  if (!isBusinessHours()) return null;

  try {
    const { rows: pending } = await db.query(`
      SELECT COUNT(*) as total
      FROM followups
      WHERE sent = false AND scheduled_at < NOW() - INTERVAL '2 hours'
    `);

    const { rows: recentSent } = await db.query(`
      SELECT COUNT(*) as total
      FROM followups
      WHERE sent = true AND created_at > NOW() - INTERVAL '2 hours'
    `);

    const pendingStale = parseInt(pending[0]?.total || 0);
    const recentSentCount = parseInt(recentSent[0]?.total || 0);

    if (pendingStale > 50 && recentSentCount === 0) {
      return {
        type: 'followup_stall',
        message: `⚠️ ALERTA: ${pendingStale} follow-ups travados há >2h sem nenhum enviado durante horário comercial. Verifique o scheduler.`,
      };
    }
  } catch (err) {
    console.error('[FunnelWatcher] detectFollowupStall erro:', err.message);
  }
  return null;
}

/**
 * Envia alerta via WhatsApp com cooldown por tipo.
 */
async function sendAlertIfCooldownOk(type, message) {
  const now = Date.now();
  const last = alertCooldown.get(type) || 0;
  if (now - last < ALERT_COOLDOWN_MS) return;

  // Post to Chatwoot Operações inbox
  await postToOpsInbox('FunnelWatcher — Alerta', alertText, { labels: ['funnel-watcher', 'alerta'] }).catch(() => {});

  for (const phone of ADMIN_PHONES) {
    try {
      await sendText(phone, message);
    } catch (err) {
      console.error(`[FunnelWatcher] Falha ao enviar alerta para ${phone}:`, err.message);
    }
  }
  alertCooldown.set(type, now);
  console.log(`[FunnelWatcher] Alerta enviado: ${type}`);
}

/**
 * Inicia o scheduler do FunnelWatcher — roda a cada 5 minutos, 24/7.
 * (Não depende de horário comercial — erros acontecem qualquer hora.)
 */
export function startFunnelWatcher() {
  console.log('[FunnelWatcher] Iniciando — vigilância a cada 5 minutos (24/7)...');

  cron.schedule('*/5 * * * *', async () => {
    await runFunnelWatcherCycle();
  });

  // Roda uma vez imediatamente no startup
  setTimeout(() => {
    console.log('[FunnelWatcher] Rodando ciclo inicial...');
    runFunnelWatcherCycle().catch(err =>
      console.error('[FunnelWatcher] Erro no ciclo inicial:', err.message)
    );
  }, 30 * 1000); // 30s após startup

  console.log('[FunnelWatcher] ATIVO — bot-loops, spam de follow-up e leads mortos sendo monitorados');
}
