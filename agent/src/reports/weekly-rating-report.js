import { db } from '../db/client.js';

const CUSTO_FORNECEDOR = 200; // R$ 200 por rating completo (Moises)

function formatBRL(value) {
  const num = parseFloat(value) || 0;
  return 'R$ ' + num.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function getWeekRange() {
  const now = new Date();
  const brt = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));

  // End = today (Monday)
  const end = new Date(brt);
  end.setHours(23, 59, 59, 999);

  // Start = last Monday (7 days ago)
  const start = new Date(brt);
  start.setDate(start.getDate() - 7);
  start.setHours(0, 0, 0, 0);

  const fmt = (d) => {
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return dd + '/' + mm;
  };

  const fmtFull = (d) => {
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = d.getFullYear();
    return dd + '/' + mm + '/' + yy;
  };

  return {
    start,
    end,
    label: fmt(start) + ' a ' + fmtFull(end),
    // ISO strings for SQL queries (UTC)
    startISO: start.toISOString(),
    endISO: end.toISOString(),
  };
}

async function getWeeklyRatingSales(startISO, endISO) {
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int as total_sold
       FROM orders
       WHERE service ILIKE '%rating%'
         AND status = 'paid'
         AND created_at >= $1
         AND created_at <= $2`,
      [startISO, endISO]
    );
    return rows[0];
  } catch (err) {
    console.error('[WeeklyRating] Error getWeeklyRatingSales:', err.message);
    return { total_sold: 0 };
  }
}

async function getWeeklyFormStats(startISO, endISO) {
  try {
    const initiatedRes = await db.query(
      `SELECT COUNT(*)::int as count FROM rating_forms
       WHERE created_at >= $1 AND created_at <= $2`,
      [startISO, endISO]
    );
    const completedRes = await db.query(
      `SELECT COUNT(*)::int as count FROM rating_forms
       WHERE completed = true
         AND updated_at >= $1 AND updated_at <= $2`,
      [startISO, endISO]
    );
    const inProgressRes = await db.query(
      `SELECT COUNT(*)::int as count FROM rating_forms
       WHERE completed = false
         AND created_at >= $1 AND created_at <= $2`,
      [startISO, endISO]
    );

    const initiated = initiatedRes.rows[0].count;
    const completed = completedRes.rows[0].count;
    const inProgress = inProgressRes.rows[0].count;
    const rate = initiated > 0 ? Math.round((completed / initiated) * 100) : 0;

    return { initiated, completed, inProgress, rate };
  } catch (err) {
    console.error('[WeeklyRating] Error getWeeklyFormStats:', err.message);
    return { initiated: 0, completed: 0, inProgress: 0, rate: 0 };
  }
}

export async function generateWeeklyRatingReport() {
  console.log('[WeeklyRating] Generating weekly rating report...');

  const week = getWeekRange();

  const [sales, forms] = await Promise.all([
    getWeeklyRatingSales(week.startISO, week.endISO),
    getWeeklyFormStats(week.startISO, week.endISO),
  ]);

  const weeklySupplierCost = forms.completed * CUSTO_FORNECEDOR;

  const report = [
    'RESUMO SEMANAL — RATING BANCARIO',
    'Semana: ' + week.label,
    '',
    'VENDAS',
    '- Ratings vendidos na semana: ' + sales.total_sold,
    '',
    'FORMULARIOS',
    '- Formularios iniciados: ' + forms.initiated,
    '- Formularios completos (enviados): ' + forms.completed,
    '- Em andamento: ' + forms.inProgress,
    '',
    'FINANCEIRO (MOISES)',
    '- Custo unitario: ' + formatBRL(CUSTO_FORNECEDOR),
    '- Total a pagar: ' + formatBRL(weeklySupplierCost),
    '- Forma: PIX (Pix: 79991320624)',
  ].join('\n');

  console.log('[WeeklyRating] Report generated (' + report.length + ' chars)');
  return report;
}
