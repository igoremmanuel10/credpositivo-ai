import express from 'express';
import { db } from '../db/client.js';

const router = express.Router();

router.get('/api/admin/agent-feed', async (req, res) => {
  try {
    // 1. Recent agent messages
    const messagesQ = await db.query(
      `SELECT m.created_at, m.role, m.phase, m.message_type,
              c.name as lead_name, c.persona as agent, c.phone
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE m.created_at > NOW() - INTERVAL '1 hour'
         AND m.role = 'agent'
       ORDER BY m.created_at DESC LIMIT 50`
    );

    // 2. Phase transitions
    const transitionsQ = await db.query(
      `SELECT m2.created_at, c.name as lead_name, c.persona as agent,
              m1.phase as from_phase, m2.phase as to_phase
       FROM messages m2
       JOIN conversations c ON c.id = m2.conversation_id
       JOIN LATERAL (
         SELECT phase FROM messages
         WHERE conversation_id = m2.conversation_id
           AND created_at < m2.created_at
         ORDER BY created_at DESC LIMIT 1
       ) m1 ON true
       WHERE m2.created_at > NOW() - INTERVAL '1 hour'
         AND m2.role = 'agent'
         AND m1.phase IS NOT NULL AND m2.phase IS NOT NULL
         AND m1.phase != m2.phase
       ORDER BY m2.created_at DESC LIMIT 20`
    );

    // 3. Follow-ups
    const followupsQ = await db.query(
      `SELECT f.created_at, f.event_type, f.attempt, f.sent,
              c.name as lead_name, c.persona as agent
       FROM followups f
       JOIN conversations c ON c.id = f.conversation_id
       WHERE f.created_at > NOW() - INTERVAL '24 hours'
       ORDER BY f.created_at DESC LIMIT 20`
    );

    // 4. Voice calls
    const callsQ = await db.query(
      `SELECT created_at, event_type, status, duration_seconds, call_mode, provider
       FROM voice_calls
       WHERE created_at > NOW() - INTERVAL '24 hours'
       ORDER BY created_at DESC LIMIT 10`
    );

    // 5. Orders
    const ordersQ = await db.query(
      `SELECT created_at, customer_name, service, price, status
       FROM orders
       WHERE created_at > NOW() - INTERVAL '7 days'
       ORDER BY created_at DESC LIMIT 10`
    );

    // 6. Alex logs
    const alexQ = await db.query(
      `SELECT created_at, event_type, severity, category,
              SUBSTRING(description, 1, 200) as description
       FROM alex_logs
       WHERE created_at > NOW() - INTERVAL '6 hours'
       ORDER BY created_at DESC LIMIT 10`
    );

    // 7. Summary stats
    const statsQ = await db.query(
      `SELECT
        (SELECT COUNT(*) FROM conversations WHERE created_at > NOW() - INTERVAL '24 hours') as leads_today,
        (SELECT COUNT(*) FROM conversations WHERE phase >= 3 AND updated_at > NOW() - INTERVAL '24 hours') as qualified_today,
        (SELECT COUNT(*) FROM orders WHERE created_at > NOW() - INTERVAL '24 hours') as orders_today,
        (SELECT COALESCE(SUM(price), 0) FROM orders WHERE created_at > NOW() - INTERVAL '24 hours' AND status != 'cancelled') as revenue_today,
        (SELECT COUNT(*) FROM messages WHERE role = 'agent' AND created_at > NOW() - INTERVAL '24 hours') as messages_sent_today,
        (SELECT COUNT(*) FROM followups WHERE created_at > NOW() - INTERVAL '24 hours') as followups_today,
        (SELECT COUNT(*) FROM voice_calls WHERE created_at > NOW() - INTERVAL '24 hours') as calls_today,
        (SELECT COUNT(DISTINCT conversation_id) FROM messages WHERE created_at > NOW() - INTERVAL '1 hour') as active_conversations`
    );

    // 8. Agent-specific stats
    const agentStatsQ = await db.query(
      `SELECT c.persona as agent,
              COUNT(DISTINCT c.id) as conversations,
              COUNT(m.id) as messages_sent,
              MAX(m.created_at) as last_active
       FROM conversations c
       JOIN messages m ON m.conversation_id = c.id AND m.role = 'agent'
       WHERE m.created_at > NOW() - INTERVAL '24 hours'
       GROUP BY c.persona`
    );

    const phaseNames = { 0: 'Boas-vindas', 1: 'Qualificacao', 2: 'Educacao', 3: 'Oferta', 4: 'Pos-venda', 5: 'Encerrado' };
    const feed = [];

    for (const msg of messagesQ.rows) {
      const agentName = (msg.agent || 'augusto').charAt(0).toUpperCase() + (msg.agent || 'augusto').slice(1);
      feed.push({
        time: msg.created_at, agent: agentName, type: 'message',
        action: `Enviou ${msg.message_type || 'mensagem'} para ${msg.lead_name || 'lead'} [${phaseNames[msg.phase] || 'Fase ' + msg.phase}]`,
        dept: 'vendas'
      });
    }

    for (const t of transitionsQ.rows) {
      const agentName = (t.agent || 'augusto').charAt(0).toUpperCase() + (t.agent || 'augusto').slice(1);
      feed.push({
        time: t.created_at, agent: agentName, type: 'transition',
        action: `Avancou ${t.lead_name || 'lead'} de ${phaseNames[t.from_phase]} para ${phaseNames[t.to_phase]}`,
        dept: 'vendas'
      });
    }

    for (const f of followupsQ.rows) {
      feed.push({
        time: f.created_at, agent: 'Augusto', type: 'followup',
        action: `Follow-up ${f.event_type} (#${f.attempt}) para ${f.lead_name || 'lead'} — ${f.sent ? 'enviado' : 'agendado'}`,
        dept: 'vendas'
      });
    }

    for (const c of callsQ.rows) {
      feed.push({
        time: c.created_at, agent: 'Paulo', type: 'call',
        action: `Ligacao ${c.call_mode || c.event_type} — ${c.status}${c.duration_seconds ? ' (' + c.duration_seconds + 's)' : ''}`,
        dept: 'vendas'
      });
    }

    for (const o of ordersQ.rows) {
      feed.push({
        time: o.created_at, agent: 'Ana', type: 'order',
        action: `Pedido ${o.service} R$${o.price} — ${o.customer_name} — ${o.status}`,
        dept: 'operacao'
      });
    }

    for (const a of alexQ.rows) {
      feed.push({
        time: a.created_at, agent: 'Alex', type: 'system',
        action: `[${(a.severity || 'info').toUpperCase()}] ${a.event_type}: ${(a.description || '').split('\n')[0].substring(0, 120)}`,
        dept: 'tecnologia'
      });
    }

    feed.sort((a, b) => new Date(b.time) - new Date(a.time));

    res.json({
      success: true,
      stats: statsQ.rows[0],
      agentStats: agentStatsQ.rows,
      feed: feed.slice(0, 100),
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('[agent-feed] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
