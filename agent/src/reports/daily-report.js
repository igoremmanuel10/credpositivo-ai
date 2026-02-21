import { db } from '../db/client.js';

const DIAS_SEMANA = ['Domingo', 'Segunda-feira', 'Terca-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sabado'];

function formatBRL(value) {
  const num = parseFloat(value) || 0;
  return 'R$ ' + num.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function formatDate() {
  const now = new Date();
  const brt = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const day = String(brt.getDate()).padStart(2, '0');
  const month = String(brt.getMonth() + 1).padStart(2, '0');
  const year = brt.getFullYear();
  const dow = DIAS_SEMANA[brt.getDay()];
  return day + '/' + month + '/' + year + ' - ' + dow;
}

async function getMessageStats() {
  try {
    const { rows } = await db.query(
      "SELECT role, COUNT(*)::int as count FROM messages WHERE created_at >= CURRENT_DATE GROUP BY role"
    );
    let received = 0;
    let sent = 0;
    for (const row of rows) {
      if (row.role === 'user') received = row.count;
      if (row.role === 'agent') sent = row.count;
    }
    return { received, sent, total: received + sent };
  } catch (err) {
    console.error('[DailyReport] Error getMessageStats:', err.message);
    return { received: 0, sent: 0, total: 0 };
  }
}

async function getMessagesByPersona() {
  try {
    const { rows } = await db.query(
      `SELECT COALESCE(c.persona, 'augusto') as persona,
              COUNT(m.id)::int as msg_count,
              COUNT(DISTINCT m.conversation_id)::int as conv_count
       FROM messages m
       JOIN conversations c ON m.conversation_id = c.id
       WHERE m.created_at >= CURRENT_DATE AND m.role = 'agent'
       GROUP BY c.persona`
    );
    return rows;
  } catch (err) {
    console.error('[DailyReport] Error getMessagesByPersona:', err.message);
    return [];
  }
}

async function getFunnelStats() {
  try {
    const totalRes = await db.query('SELECT COUNT(*)::int as count FROM conversations');
    const engagedRes = await db.query('SELECT COUNT(*)::int as count FROM conversations WHERE phase > 0');
    const recommendedRes = await db.query('SELECT COUNT(*)::int as count FROM conversations WHERE recommended_product IS NOT NULL');
    const ordersRes = await db.query('SELECT COUNT(*)::int as count FROM orders');
    const paidRes = await db.query("SELECT COUNT(*)::int as count FROM orders WHERE status = 'paid'");
    const paidRevenueRes = await db.query("SELECT COALESCE(SUM(price), 0)::numeric as total FROM orders WHERE status = 'paid'");

    return {
      totalContacts: totalRes.rows[0].count,
      engaged: engagedRes.rows[0].count,
      recommended: recommendedRes.rows[0].count,
      ordersCreated: ordersRes.rows[0].count,
      ordersPaid: paidRes.rows[0].count,
      paidRevenue: parseFloat(paidRevenueRes.rows[0].total),
    };
  } catch (err) {
    console.error('[DailyReport] Error getFunnelStats:', err.message);
    return { totalContacts: 0, engaged: 0, recommended: 0, ordersCreated: 0, ordersPaid: 0, paidRevenue: 0 };
  }
}

async function getSignupStats() {
  try {
    const totalRes = await db.query('SELECT COUNT(*)::int as count FROM users');
    const todayRes = await db.query('SELECT COUNT(*)::int as count FROM users WHERE created_at >= CURRENT_DATE');
    return { total: totalRes.rows[0].count, today: todayRes.rows[0].count };
  } catch (err) {
    console.error('[DailyReport] Error getSignupStats:', err.message);
    return { total: 0, today: 0 };
  }
}

async function getPaymentStats() {
  try {
    const totalPaidRes = await db.query("SELECT COUNT(*)::int as count FROM orders WHERE status = 'paid'");
    const todayPaidRes = await db.query("SELECT COUNT(*)::int as count FROM orders WHERE status = 'paid' AND created_at >= CURRENT_DATE");
    const totalRevenueRes = await db.query("SELECT COALESCE(SUM(price), 0)::numeric as total FROM orders WHERE status = 'paid'");
    const todayRevenueRes = await db.query("SELECT COALESCE(SUM(price), 0)::numeric as total FROM orders WHERE status = 'paid' AND created_at >= CURRENT_DATE");

    const totalPaid = totalPaidRes.rows[0].count;
    const totalRevenue = parseFloat(totalRevenueRes.rows[0].total);
    const avgTicket = totalPaid > 0 ? totalRevenue / totalPaid : 0;

    return {
      totalPaid,
      todayPaid: todayPaidRes.rows[0].count,
      totalRevenue,
      todayRevenue: parseFloat(todayRevenueRes.rows[0].total),
      avgTicket,
    };
  } catch (err) {
    console.error('[DailyReport] Error getPaymentStats:', err.message);
    return { totalPaid: 0, todayPaid: 0, totalRevenue: 0, todayRevenue: 0, avgTicket: 0 };
  }
}

async function getServiceStats() {
  try {
    const { rows } = await db.query(
      "SELECT service, COUNT(*)::int as count, COALESCE(SUM(price), 0)::numeric as revenue FROM orders WHERE status = 'paid' GROUP BY service ORDER BY count DESC"
    );
    return rows;
  } catch (err) {
    console.error('[DailyReport] Error getServiceStats:', err.message);
    return [];
  }
}

async function getFollowupStats() {
  try {
    const sentRes = await db.query('SELECT COUNT(*)::int as count FROM followups WHERE sent = true AND created_at >= CURRENT_DATE');
    const scheduledRes = await db.query('SELECT COUNT(*)::int as count FROM followups WHERE sent = false AND scheduled_at >= CURRENT_DATE');
    return { sent: sentRes.rows[0].count, scheduled: scheduledRes.rows[0].count };
  } catch (err) {
    console.error('[DailyReport] Error getFollowupStats:', err.message);
    return { sent: 0, scheduled: 0 };
  }
}

async function getSystemHealth() {
  try {
    let monitorData = {};
    try {
      const monitorRes = await fetch('http://localhost:3001/monitor');
      monitorData = await monitorRes.json();
    } catch (e) {
      console.warn('[DailyReport] Monitor endpoint unavailable:', e.message);
    }

    let bridgeData = {};
    try {
      const bridgeRes = await fetch('http://localhost:3001/bridge-health');
      bridgeData = await bridgeRes.json();
    } catch (e) {
      console.warn('[DailyReport] Bridge health endpoint unavailable:', e.message);
    }

    const bridgeOk = !bridgeData.alertSent && (bridgeData.errorCount || 0) < 5;

    return {
      status: monitorData.status || 'healthy',
      uptime: monitorData.uptime || 'N/A',
      errors24h: monitorData.errors_24h || 0,
      bridgeStatus: bridgeOk ? 'OK' : 'FALHA',
      disk: monitorData.disk_usage || 'N/A',
      ramFree: monitorData.ram_free || 'N/A',
    };
  } catch (err) {
    console.error('[DailyReport] Error getSystemHealth:', err.message);
    return {
      status: 'unknown',
      uptime: 'N/A',
      errors24h: 0,
      bridgeStatus: 'N/A',
      disk: 'N/A',
      ramFree: 'N/A',
    };
  }
}

export async function generateDailyReport() {
  console.log('[DailyReport] Generating daily report...');

  const [msgs, personas, funnel, signups, payments, services, followups, system] = await Promise.all([
    getMessageStats(),
    getMessagesByPersona(),
    getFunnelStats(),
    getSignupStats(),
    getPaymentStats(),
    getServiceStats(),
    getFollowupStats(),
    getSystemHealth(),
  ]);

  const alerts = [];
  if (system.bridgeStatus === 'FALHA') alerts.push('Bridge Chatwoot com falha');
  if (system.status === 'degraded') alerts.push('Sistema em modo degradado');
  if (msgs.total === 0) alerts.push('Nenhuma mensagem hoje');

  let personaLines = '';
  if (personas.length === 0) {
    personaLines = '- Nenhuma mensagem enviada hoje';
  } else {
    const personaNames = { augusto: 'Augusto', paulo_sdr: 'Paulo SDR', paulo: 'Paulo SDR' };
    for (const p of personas) {
      const name = personaNames[p.persona] || p.persona;
      personaLines += '- ' + name + ': ' + p.msg_count + ' msgs (' + p.conv_count + ' conversas)\n';
    }
    personaLines = personaLines.trimEnd();
  }

  let serviceLines = '';
  if (services.length === 0) {
    serviceLines = '- Nenhuma venda registrada';
  } else {
    const serviceNames = {
      diagnostico: 'Diagnostico',
      limpa_nome: 'Limpa Nome',
      rating: 'Rating',
      consulta_cpf: 'Consulta CPF',
    };
    for (const s of services) {
      const name = serviceNames[s.service] || s.service;
      serviceLines += '- ' + name + ': ' + s.count + ' vendas (' + formatBRL(s.revenue) + ')\n';
    }
    serviceLines = serviceLines.trimEnd();
  }

  let alertLines = '';
  if (alerts.length === 0) {
    alertLines = '- Nenhum alerta';
  } else {
    for (const a of alerts) {
      alertLines += '- ' + a + '\n';
    }
    alertLines = alertLines.trimEnd();
  }

  const report = [
    'RELATORIO DIARIO CREDPOSITIVO',
    formatDate(),
    '================================',
    '',
    'MENSAGENS HOJE',
    '- Recebidas: ' + msgs.received,
    '- Enviadas: ' + msgs.sent,
    '- Total: ' + msgs.total,
    '',
    'POR ATENDENTE',
    personaLines,
    '',
    'FUNIL DE CONVERSAO',
    '- Contatos totais: ' + funnel.totalContacts,
    '- Engajados (phase > 0): ' + funnel.engaged,
    '- Produto recomendado: ' + funnel.recommended,
    '- Pedidos criados: ' + funnel.ordersCreated,
    '- Pedidos pagos: ' + funnel.ordersPaid + ' (' + formatBRL(funnel.paidRevenue) + ')',
    '',
    'CADASTROS E PAGAMENTOS',
    '- Cadastros totais: ' + signups.total + ' (hoje: ' + signups.today + ')',
    '- Pagamentos totais: ' + payments.totalPaid + ' (hoje: ' + payments.todayPaid + ')',
    '- Receita total: ' + formatBRL(payments.totalRevenue) + ' (hoje: ' + formatBRL(payments.todayRevenue) + ')',
    '- Ticket medio: ' + formatBRL(payments.avgTicket),
    '',
    'SERVICOS MAIS VENDIDOS',
    serviceLines,
    '',
    'SISTEMA',
    '- Status: ' + system.status,
    '- Uptime: ' + system.uptime,
    '- Erros 24h: ' + system.errors24h,
    '- Bridge Chatwoot: ' + system.bridgeStatus,
    '- Disco: ' + system.disk + ' | RAM livre: ' + system.ramFree,
    '',
    'FOLLOW-UPS HOJE',
    '- Enviados: ' + followups.sent,
    '- Agendados: ' + followups.scheduled,
    '',
    'ALERTAS',
    alertLines,
    '================================',
  ].join('\n');

  console.log('[DailyReport] Report generated (' + report.length + ' chars)');
  return report;
}
