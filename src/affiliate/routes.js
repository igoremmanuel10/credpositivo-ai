import { Router } from 'express';
import { db } from '../db/client.js';
import { createCheckout } from '../payment/mercadopago.js';

export const affiliateRouter = Router();

// ============================================
// TIER CONFIG — percentuais de comissao por tier
// ============================================
const TIER_CONFIG = {
  starter:  { n1_vendas: 10, n2_vendas: 0,  n1_recorrente: 5,  n2_recorrente: 0, min_faturamento: 0 },
  bronze:   { n1_vendas: 15, n2_vendas: 0,  n1_recorrente: 10, n2_recorrente: 0, min_faturamento: 500 },
  prata:    { n1_vendas: 30, n2_vendas: 0,  n1_recorrente: 12, n2_recorrente: 0, min_faturamento: 5000 },
  ouro:     { n1_vendas: 40, n2_vendas: 5,  n1_recorrente: 20, n2_recorrente: 3, min_faturamento: 0 },
};

const BADGES = [
  { type: 'primeira_venda',    label: 'Primeira Venda',    icon: '🌱', check: (a) => a.total_vendas_n1 >= 1 },
  { type: 'mil_faturados',     label: 'R$ 1.000 Faturados', icon: '🔥', check: (a) => a.faturamento_acumulado >= 1000 },
  { type: 'cinco_mil',         label: 'R$ 5.000 Faturados', icon: '⭐', check: (a) => a.faturamento_acumulado >= 5000 },
  { type: 'dez_mil',           label: 'R$ 10.000 Faturados', icon: '💎', check: (a) => a.faturamento_acumulado >= 10000 },
  { type: 'cinquenta_mil',     label: 'R$ 50.000 Faturados', icon: '🏆', check: (a) => a.faturamento_acumulado >= 50000 },
  { type: 'construtor_rede',   label: 'Construtor de Rede', icon: '👥', check: async (a) => {
    const { rows } = await db.query('SELECT COUNT(*)::int as cnt FROM affiliates WHERE upline_id = $1', [a.id]);
    return rows[0].cnt >= 10;
  }},
];

// Helper: gerar ref_code unico
async function generateRefCode(nome) {
  const base = nome.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z]/g, '').substring(0, 6).toUpperCase();
  let code;
  let exists = true;
  while (exists) {
    const rand = Math.floor(1000 + Math.random() * 9000);
    code = base + rand;
    const { rows } = await db.query('SELECT id FROM affiliates WHERE ref_code = $1', [code]);
    exists = rows.length > 0;
  }
  return code;
}

// Helper: calcular tier por merito
function calculateMeritTier(faturamento) {
  if (faturamento >= 5000) return 'prata';
  if (faturamento >= 500) return 'bronze';
  return 'starter';
}

// Helper: atualizar badges
async function checkAndGrantBadges(affiliateId) {
  const { rows } = await db.query('SELECT * FROM affiliates WHERE id = $1', [affiliateId]);
  if (!rows[0]) return;
  const aff = rows[0];

  for (const badge of BADGES) {
    const { rows: existing } = await db.query(
      'SELECT id FROM affiliate_badges WHERE affiliate_id = $1 AND badge_type = $2',
      [affiliateId, badge.type]
    );
    if (existing.length > 0) continue;

    let earned = false;
    if (typeof badge.check === 'function') {
      const result = badge.check(aff);
      earned = result instanceof Promise ? await result : result;
    }
    if (earned) {
      await db.query(
        'INSERT INTO affiliate_badges (affiliate_id, badge_type) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [affiliateId, badge.type]
      );
    }
  }
}

// ============================================
// POST /api/affiliate/register — Ativar como afiliado
// ============================================
affiliateRouter.post('/api/affiliate/register', async (req, res) => {
  try {
    const { user_id, ref_code_indicador } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id obrigatorio' });

    // Checar se ja e afiliado
    const { rows: existing } = await db.query('SELECT id FROM affiliates WHERE user_id = $1', [user_id]);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Voce ja e afiliado', affiliate_id: existing[0].id });
    }

    // Buscar nome do usuario
    const { rows: userRows } = await db.query('SELECT nome FROM users WHERE id = $1', [user_id]);
    if (!userRows[0]) return res.status(404).json({ error: 'Usuario nao encontrado' });

    const refCode = await generateRefCode(userRows[0].nome);

    // Buscar upline se indicador fornecido
    let uplineId = null;
    if (ref_code_indicador) {
      const { rows: uplineRows } = await db.query('SELECT id FROM affiliates WHERE ref_code = $1', [ref_code_indicador]);
      if (uplineRows[0]) uplineId = uplineRows[0].id;
    }

    const { rows } = await db.query(
      `INSERT INTO affiliates (user_id, ref_code, tier, upline_id)
       VALUES ($1, $2, 'starter', $3)
       RETURNING *`,
      [user_id, refCode, uplineId]
    );

    // Salvar ref code no usuario que indicou
    if (ref_code_indicador) {
      await db.query('UPDATE users SET referred_by_code = $1, updated_at = NOW() WHERE id = $2', [ref_code_indicador, user_id]);
    }

    console.log(`[Affiliate] New affiliate registered: ${refCode} (user ${user_id}), upline: ${uplineId || 'organic'}`);
    res.json({ success: true, affiliate: rows[0] });
  } catch (err) {
    console.error('[Affiliate Register] Error:', err);
    res.status(500).json({ error: 'Erro ao registrar afiliado' });
  }
});

// ============================================
// GET /api/affiliate/profile/:userId — Dados completos
// ============================================
affiliateRouter.get('/api/affiliate/profile/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const { rows } = await db.query(
      `SELECT a.*, u.nome, u.email, u.cpf, u.telefone
       FROM affiliates a
       JOIN users u ON u.id = a.user_id
       WHERE a.user_id = $1`,
      [userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Afiliado nao encontrado' });

    const affiliate = rows[0];
    const tierConfig = TIER_CONFIG[affiliate.tier] || TIER_CONFIG.starter;

    // Buscar badges
    const { rows: badges } = await db.query(
      'SELECT badge_type, unlocked_at FROM affiliate_badges WHERE affiliate_id = $1 ORDER BY unlocked_at',
      [affiliate.id]
    );

    // Calcular tier por merito (caso nao seja ouro)
    const meritTier = calculateMeritTier(parseFloat(affiliate.faturamento_acumulado));

    res.json({
      ...affiliate,
      tier_config: tierConfig,
      merit_tier: meritTier,
      badges,
    });
  } catch (err) {
    console.error('[Affiliate Profile] Error:', err);
    res.status(500).json({ error: 'Erro ao buscar perfil' });
  }
});

// ============================================
// GET /api/affiliate/dashboard/:userId — Dashboard data
// ============================================
affiliateRouter.get('/api/affiliate/dashboard/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const { rows: affRows } = await db.query(
      `SELECT a.*, u.nome FROM affiliates a JOIN users u ON u.id = a.user_id WHERE a.user_id = $1`,
      [userId]
    );
    if (!affRows[0]) return res.status(404).json({ error: 'Afiliado nao encontrado' });

    const aff = affRows[0];
    const affiliateId = aff.id;

    // Comissoes resumo
    const { rows: comSummary } = await db.query(`
      SELECT
        COALESCE(SUM(CASE WHEN nivel = 1 THEN valor_comissao ELSE 0 END), 0) as total_n1,
        COALESCE(SUM(CASE WHEN nivel = 2 THEN valor_comissao ELSE 0 END), 0) as total_n2,
        COALESCE(SUM(valor_comissao), 0) as total_geral
      FROM affiliate_commissions WHERE affiliate_id = $1
    `, [affiliateId]);

    // Comissoes do mes
    const { rows: comMes } = await db.query(`
      SELECT
        COALESCE(SUM(CASE WHEN nivel = 1 THEN valor_comissao ELSE 0 END), 0) as n1_mes,
        COALESCE(SUM(CASE WHEN nivel = 2 THEN valor_comissao ELSE 0 END), 0) as n2_mes,
        COALESCE(SUM(valor_comissao), 0) as total_mes,
        COUNT(*)::int as vendas_mes
      FROM affiliate_commissions
      WHERE affiliate_id = $1
        AND created_at >= date_trunc('month', NOW())
    `, [affiliateId]);

    // Ultimas comissoes
    const { rows: recentCommissions } = await db.query(`
      SELECT * FROM affiliate_commissions
      WHERE affiliate_id = $1
      ORDER BY created_at DESC LIMIT 10
    `, [affiliateId]);

    // Badges
    const { rows: badges } = await db.query(
      'SELECT badge_type, unlocked_at FROM affiliate_badges WHERE affiliate_id = $1',
      [affiliateId]
    );

    // Indicados diretos (N1)
    const { rows: networkCount } = await db.query(
      'SELECT COUNT(*)::int as total FROM affiliates WHERE upline_id = $1',
      [affiliateId]
    );

    // Grafico 30 dias
    const { rows: chart30d } = await db.query(`
      SELECT
        date_trunc('day', created_at)::date as dia,
        COALESCE(SUM(valor_comissao), 0) as valor,
        COUNT(*)::int as vendas
      FROM affiliate_commissions
      WHERE affiliate_id = $1
        AND created_at >= NOW() - INTERVAL '30 days'
      GROUP BY date_trunc('day', created_at)
      ORDER BY dia
    `, [affiliateId]);

    // Tier config
    const tierConfig = TIER_CONFIG[aff.tier] || TIER_CONFIG.starter;
    const meritTier = calculateMeritTier(parseFloat(aff.faturamento_acumulado));

    // Proximo tier por merito
    let nextTier = null;
    let nextTierProgress = 0;
    const fat = parseFloat(aff.faturamento_acumulado);
    if (meritTier === 'starter') {
      nextTier = { name: 'Bronze', target: 500 };
      nextTierProgress = Math.min(100, (fat / 500) * 100);
    } else if (meritTier === 'bronze') {
      nextTier = { name: 'Prata', target: 5000 };
      nextTierProgress = Math.min(100, (fat / 5000) * 100);
    }

    res.json({
      affiliate: aff,
      tier_config: tierConfig,
      merit_tier: meritTier,
      next_tier: nextTier,
      next_tier_progress: Math.round(nextTierProgress),
      summary: comSummary[0],
      mes: comMes[0],
      recent_commissions: recentCommissions,
      badges,
      network_count: networkCount[0].total,
      chart_30d: chart30d,
    });
  } catch (err) {
    console.error('[Affiliate Dashboard] Error:', err);
    res.status(500).json({ error: 'Erro ao carregar dashboard' });
  }
});

// ============================================
// GET /api/affiliate/commissions/:userId — Lista paginada
// ============================================
affiliateRouter.get('/api/affiliate/commissions/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const { rows: affRows } = await db.query('SELECT id FROM affiliates WHERE user_id = $1', [userId]);
    if (!affRows[0]) return res.status(404).json({ error: 'Afiliado nao encontrado' });
    const affiliateId = affRows[0].id;

    const { rows: total } = await db.query('SELECT COUNT(*)::int as cnt FROM affiliate_commissions WHERE affiliate_id = $1', [affiliateId]);
    const { rows } = await db.query(
      `SELECT * FROM affiliate_commissions WHERE affiliate_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [affiliateId, limit, offset]
    );

    res.json({ commissions: rows, total: total[0].cnt, page, limit });
  } catch (err) {
    console.error('[Affiliate Commissions] Error:', err);
    res.status(500).json({ error: 'Erro ao buscar comissoes' });
  }
});

// ============================================
// GET /api/affiliate/network/:userId — Rede N1
// ============================================
affiliateRouter.get('/api/affiliate/network/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const { rows: affRows } = await db.query('SELECT id, tier FROM affiliates WHERE user_id = $1', [userId]);
    if (!affRows[0]) return res.status(404).json({ error: 'Afiliado nao encontrado' });
    const affiliateId = affRows[0].id;
    const isOuro = affRows[0].tier === 'ouro';

    // N1 — indicados diretos
    const { rows: n1 } = await db.query(`
      SELECT a.id, a.ref_code, a.tier, a.faturamento_acumulado, a.total_vendas_n1, a.created_at,
             u.nome, u.email,
             COALESCE(SUM(c.valor_comissao) FILTER (WHERE c.affiliate_id = $1 AND c.nivel = 2), 0) as comissao_n2_gerada
      FROM affiliates a
      JOIN users u ON u.id = a.user_id
      LEFT JOIN affiliate_commissions c ON c.order_id IN (
        SELECT ac2.order_id FROM affiliate_commissions ac2 WHERE ac2.affiliate_id = a.id AND ac2.nivel = 1
      ) AND c.affiliate_id = $1 AND c.nivel = 2
      WHERE a.upline_id = $1
      GROUP BY a.id, a.ref_code, a.tier, a.faturamento_acumulado, a.total_vendas_n1, a.created_at, u.nome, u.email
      ORDER BY a.created_at DESC
    `, [affiliateId]);

    let n2 = [];
    if (isOuro) {
      // N2 — indicados dos indicados
      const { rows: n2Data } = await db.query(`
        SELECT a2.id, a2.ref_code, a2.tier, a2.faturamento_acumulado, a2.total_vendas_n1, a2.created_at,
               u2.nome, u2.email,
               a1.ref_code as via_ref_code, u1.nome as via_nome
        FROM affiliates a2
        JOIN users u2 ON u2.id = a2.user_id
        JOIN affiliates a1 ON a1.id = a2.upline_id
        JOIN users u1 ON u1.id = a1.user_id
        WHERE a1.upline_id = $1
        ORDER BY a2.created_at DESC
      `, [affiliateId]);
      n2 = n2Data;
    }

    res.json({ n1, n2, is_ouro: isOuro });
  } catch (err) {
    console.error('[Affiliate Network] Error:', err);
    res.status(500).json({ error: 'Erro ao buscar rede' });
  }
});

// ============================================
// POST /api/affiliate/withdraw — Solicitar saque
// ============================================
affiliateRouter.post('/api/affiliate/withdraw', async (req, res) => {
  try {
    const { user_id, valor } = req.body;
    if (!user_id || !valor) return res.status(400).json({ error: 'user_id e valor obrigatorios' });

    const amount = parseFloat(valor);
    if (amount < 50) return res.status(400).json({ error: 'Saque minimo R$ 50,00' });

    const { rows } = await db.query(
      'SELECT * FROM affiliates WHERE user_id = $1',
      [user_id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Afiliado nao encontrado' });

    const aff = rows[0];
    if (parseFloat(aff.saldo_disponivel) < amount) {
      return res.status(400).json({ error: 'Saldo insuficiente', saldo: parseFloat(aff.saldo_disponivel) });
    }

    if (!aff.tipo_pix || !aff.chave_pix) {
      return res.status(400).json({ error: 'Configure sua chave Pix antes de solicitar saque' });
    }

    // Criar saque e debitar saldo
    await db.query('BEGIN');
    try {
      await db.query(
        'UPDATE affiliates SET saldo_disponivel = saldo_disponivel - $1, updated_at = NOW() WHERE id = $2',
        [amount, aff.id]
      );
      const { rows: withdrawRows } = await db.query(
        `INSERT INTO affiliate_withdrawals (affiliate_id, valor, tipo_pix, chave_pix)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [aff.id, amount, aff.tipo_pix, aff.chave_pix]
      );
      await db.query('COMMIT');

      console.log(`[Affiliate] Withdrawal requested: R$ ${amount} for affiliate ${aff.ref_code}`);
      res.json({ success: true, withdrawal: withdrawRows[0] });
    } catch (txErr) {
      await db.query('ROLLBACK');
      throw txErr;
    }
  } catch (err) {
    console.error('[Affiliate Withdraw] Error:', err);
    res.status(500).json({ error: 'Erro ao solicitar saque' });
  }
});

// ============================================
// GET /api/affiliate/withdrawals/:userId — Historico de saques
// ============================================
affiliateRouter.get('/api/affiliate/withdrawals/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const { rows: affRows } = await db.query('SELECT id FROM affiliates WHERE user_id = $1', [userId]);
    if (!affRows[0]) return res.status(404).json({ error: 'Afiliado nao encontrado' });

    const { rows } = await db.query(
      'SELECT * FROM affiliate_withdrawals WHERE affiliate_id = $1 ORDER BY created_at DESC',
      [affRows[0].id]
    );

    const { rows: totals } = await db.query(`
      SELECT
        COALESCE(SUM(valor) FILTER (WHERE status = 'pago'), 0) as total_sacado,
        COALESCE(SUM(valor) FILTER (WHERE status IN ('pendente', 'processando')), 0) as em_processamento
      FROM affiliate_withdrawals WHERE affiliate_id = $1
    `, [affRows[0].id]);

    res.json({ withdrawals: rows, totals: totals[0] });
  } catch (err) {
    console.error('[Affiliate Withdrawals] Error:', err);
    res.status(500).json({ error: 'Erro ao buscar saques' });
  }
});

// ============================================
// PUT /api/affiliate/bank-info/:userId — Atualizar Pix
// ============================================
affiliateRouter.put('/api/affiliate/bank-info/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const { tipo_pix, chave_pix } = req.body;
    if (!tipo_pix || !chave_pix) return res.status(400).json({ error: 'tipo_pix e chave_pix obrigatorios' });

    const { rows } = await db.query(
      `UPDATE affiliates SET tipo_pix = $1, chave_pix = $2, updated_at = NOW()
       WHERE user_id = $3 RETURNING id, tipo_pix, chave_pix`,
      [tipo_pix, chave_pix, userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Afiliado nao encontrado' });

    res.json({ success: true, bank_info: rows[0] });
  } catch (err) {
    console.error('[Affiliate Bank Info] Error:', err);
    res.status(500).json({ error: 'Erro ao atualizar dados bancarios' });
  }
});

// ============================================
// PUT /api/affiliate/settings/:userId — Atualizar config
// ============================================
affiliateRouter.put('/api/affiliate/settings/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const { tipo_pix, chave_pix } = req.body;

    const fields = [];
    const values = [];
    let idx = 1;

    if (tipo_pix !== undefined) { fields.push(`tipo_pix = $${idx}`); values.push(tipo_pix); idx++; }
    if (chave_pix !== undefined) { fields.push(`chave_pix = $${idx}`); values.push(chave_pix); idx++; }

    if (fields.length === 0) return res.status(400).json({ error: 'Nenhum campo para atualizar' });

    fields.push('updated_at = NOW()');
    values.push(userId);

    const { rows } = await db.query(
      `UPDATE affiliates SET ${fields.join(', ')} WHERE user_id = $${idx} RETURNING *`,
      values
    );
    if (!rows[0]) return res.status(404).json({ error: 'Afiliado nao encontrado' });

    res.json({ success: true, affiliate: rows[0] });
  } catch (err) {
    console.error('[Affiliate Settings] Error:', err);
    res.status(500).json({ error: 'Erro ao atualizar configuracoes' });
  }
});

// ============================================
// GET /api/affiliate/materials/:userId — Materiais por tier
// ============================================
affiliateRouter.get('/api/affiliate/materials/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const { rows: affRows } = await db.query('SELECT tier FROM affiliates WHERE user_id = $1', [userId]);
    if (!affRows[0]) return res.status(404).json({ error: 'Afiliado nao encontrado' });

    const tierOrder = { starter: 0, bronze: 1, prata: 2, ouro: 3 };
    const userTierLevel = tierOrder[affRows[0].tier] || 0;

    const { rows } = await db.query('SELECT * FROM affiliate_materials ORDER BY created_at DESC');

    const materials = rows.map(m => ({
      ...m,
      locked: tierOrder[m.min_tier] > userTierLevel,
    }));

    res.json({ materials, tier: affRows[0].tier });
  } catch (err) {
    console.error('[Affiliate Materials] Error:', err);
    res.status(500).json({ error: 'Erro ao buscar materiais' });
  }
});

// ============================================
// GET /api/affiliate/course/:userId — Curso + progresso
// ============================================
affiliateRouter.get('/api/affiliate/course/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const { rows: affRows } = await db.query('SELECT id, tier FROM affiliates WHERE user_id = $1', [userId]);
    if (!affRows[0]) return res.status(404).json({ error: 'Afiliado nao encontrado' });

    const { rows: progress } = await db.query(
      'SELECT module_id, completed_at FROM affiliate_course_progress WHERE affiliate_id = $1',
      [affRows[0].id]
    );

    const modules = [
      { id: 1, title: 'Entendendo o Credito', min_tier: 'starter', description: 'Fundamentos do mercado de credito e como funciona o score.' },
      { id: 2, title: 'Conhecendo os Produtos', min_tier: 'starter', description: 'Diagnostico, Limpa Nome e Rating Bancario — o que cada um faz.' },
      { id: 3, title: 'Tecnicas de Indicacao', min_tier: 'bronze', description: 'Como indicar de forma eficiente e converter mais.' },
      { id: 4, title: 'Marketing Digital Basico', min_tier: 'prata', description: 'Redes sociais, copy e funis simples para vender online.' },
      { id: 5, title: 'Escalando Vendas', min_tier: 'ouro', description: 'Estrategias avancadas, automacao e construcao de rede.' },
    ];

    const tierOrder = { starter: 0, bronze: 1, prata: 2, ouro: 3 };
    const userTierLevel = tierOrder[affRows[0].tier] || 0;
    const completedIds = progress.map(p => p.module_id);

    const enriched = modules.map(m => ({
      ...m,
      locked: tierOrder[m.min_tier] > userTierLevel,
      completed: completedIds.includes(m.id),
      completed_at: progress.find(p => p.module_id === m.id)?.completed_at || null,
    }));

    res.json({
      modules: enriched,
      completed_count: completedIds.length,
      total_modules: modules.length,
    });
  } catch (err) {
    console.error('[Affiliate Course] Error:', err);
    res.status(500).json({ error: 'Erro ao buscar curso' });
  }
});

// ============================================
// POST /api/affiliate/course/:userId/complete — Marcar modulo completo
// ============================================
affiliateRouter.post('/api/affiliate/course/:userId/complete', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const { module_id } = req.body;
    if (!module_id) return res.status(400).json({ error: 'module_id obrigatorio' });

    const { rows: affRows } = await db.query('SELECT id FROM affiliates WHERE user_id = $1', [userId]);
    if (!affRows[0]) return res.status(404).json({ error: 'Afiliado nao encontrado' });

    await db.query(
      'INSERT INTO affiliate_course_progress (affiliate_id, module_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [affRows[0].id, module_id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('[Affiliate Course Complete] Error:', err);
    res.status(500).json({ error: 'Erro ao completar modulo' });
  }
});

// ============================================
// GET /api/affiliate/journey/:userId — Jornada do afiliado
// ============================================
affiliateRouter.get('/api/affiliate/journey/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const { rows: affRows } = await db.query('SELECT * FROM affiliates WHERE user_id = $1', [userId]);
    if (!affRows[0]) return res.status(404).json({ error: 'Afiliado nao encontrado' });

    const fat = parseFloat(affRows[0].faturamento_acumulado);

    const stages = [
      { id: 'semente',  label: 'Semente',  icon: '🌱', target: 1,     description: 'Realize sua primeira venda', unit: 'venda' },
      { id: 'broto',    label: 'Broto',    icon: '🌿', target: 500,   description: 'R$ 500 em vendas acumuladas (Bronze)', unit: 'reais' },
      { id: 'arvore',   label: 'Arvore',   icon: '🌳', target: 5000,  description: 'R$ 5.000 em vendas acumuladas (Prata)', unit: 'reais' },
      { id: 'floresta', label: 'Floresta', icon: '🏔️', target: 10000, description: 'R$ 10.000+ em vendas acumuladas', unit: 'reais' },
    ];

    const vendas = affRows[0].total_vendas_n1;
    const enriched = stages.map(s => {
      const current = s.unit === 'venda' ? vendas : fat;
      return {
        ...s,
        current,
        progress: Math.min(100, Math.round((current / s.target) * 100)),
        completed: current >= s.target,
      };
    });

    // Estagio atual
    let currentStage = 'semente';
    if (fat >= 10000) currentStage = 'floresta';
    else if (fat >= 5000) currentStage = 'arvore';
    else if (fat >= 500) currentStage = 'broto';
    else if (vendas >= 1) currentStage = 'semente';

    res.json({ stages: enriched, current_stage: currentStage });
  } catch (err) {
    console.error('[Affiliate Journey] Error:', err);
    res.status(500).json({ error: 'Erro ao buscar jornada' });
  }
});

// ============================================
// GET /api/affiliate/report/:userId — Relatorio de vendas
// ============================================
affiliateRouter.get('/api/affiliate/report/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const { rows: affRows } = await db.query('SELECT id, tier, faturamento_acumulado FROM affiliates WHERE user_id = $1', [userId]);
    if (!affRows[0]) return res.status(404).json({ error: 'Afiliado nao encontrado' });
    const affiliateId = affRows[0].id;

    // Top produtos por receita de comissao
    const { rows: topProdutos } = await db.query(`
      SELECT
        produto,
        COUNT(*)::int as total_vendas,
        COALESCE(SUM(valor_venda), 0) as total_valor_vendas,
        COALESCE(SUM(valor_comissao), 0) as total_comissao,
        ROUND(AVG(comissao_percent)::numeric, 1) as media_percent
      FROM affiliate_commissions
      WHERE affiliate_id = $1
      GROUP BY produto
      ORDER BY total_comissao DESC
      LIMIT 5
    `, [affiliateId]);

    // Resumo mensal (ultimos 6 meses)
    const { rows: mensal } = await db.query(`
      SELECT
        to_char(date_trunc('month', created_at), 'YYYY-MM') as mes,
        to_char(date_trunc('month', created_at), 'Mon/YY') as mes_label,
        COUNT(*)::int as vendas,
        COALESCE(SUM(valor_venda), 0) as total_valor_vendas,
        COALESCE(SUM(valor_comissao), 0) as total_comissao,
        COALESCE(SUM(CASE WHEN nivel = 1 THEN valor_comissao ELSE 0 END), 0) as comissao_n1,
        COALESCE(SUM(CASE WHEN nivel = 2 THEN valor_comissao ELSE 0 END), 0) as comissao_n2
      FROM affiliate_commissions
      WHERE affiliate_id = $1
        AND created_at >= NOW() - INTERVAL '6 months'
      GROUP BY date_trunc('month', created_at)
      ORDER BY mes DESC
    `, [affiliateId]);

    // Dados diarios para grafico (ultimos 30 dias)
    const { rows: diario } = await db.query(`
      SELECT
        date_trunc('day', created_at)::date as dia,
        COUNT(*)::int as vendas,
        COALESCE(SUM(valor_venda), 0) as total_valor_vendas,
        COALESCE(SUM(valor_comissao), 0) as total_comissao
      FROM affiliate_commissions
      WHERE affiliate_id = $1
        AND created_at >= NOW() - INTERVAL '30 days'
      GROUP BY date_trunc('day', created_at)
      ORDER BY dia
    `, [affiliateId]);

    // Totais gerais
    const { rows: totais } = await db.query(`
      SELECT
        COUNT(*)::int as total_vendas,
        COALESCE(SUM(valor_venda), 0) as total_valor_vendas,
        COALESCE(SUM(valor_comissao), 0) as total_comissao,
        COALESCE(SUM(valor_comissao) FILTER (WHERE status = 'pendente'), 0) as comissao_pendente,
        COALESCE(SUM(valor_comissao) FILTER (WHERE status = 'disponivel'), 0) as comissao_disponivel,
        COALESCE(SUM(valor_comissao) FILTER (WHERE status = 'sacado'), 0) as comissao_sacada
      FROM affiliate_commissions
      WHERE affiliate_id = $1
    `, [affiliateId]);

    // Status breakdown
    const { rows: statusBreak } = await db.query(`
      SELECT
        status,
        COUNT(*)::int as qtd,
        COALESCE(SUM(valor_comissao), 0) as valor
      FROM affiliate_commissions
      WHERE affiliate_id = $1
      GROUP BY status
    `, [affiliateId]);

    res.json({
      top_produtos: topProdutos,
      mensal,
      diario,
      totais: totais[0],
      status_breakdown: statusBreak,
      tier: affRows[0].tier,
      faturamento_acumulado: affRows[0].faturamento_acumulado,
    });
  } catch (err) {
    console.error('[Affiliate Report] Error:', err);
    res.status(500).json({ error: 'Erro ao gerar relatorio' });
  }
});

// ============================================
// POST /api/affiliate/release-commissions — Liberar comissoes pendentes (cron/manual)
// ============================================
affiliateRouter.post('/api/affiliate/release-commissions', async (req, res) => {
  try {
    const { rows } = await db.query(`
      UPDATE affiliate_commissions
      SET status = 'disponivel'
      WHERE status = 'pendente' AND disponivel_em <= NOW()
      RETURNING *
    `);

    // Atualizar saldos
    for (const com of rows) {
      await db.query(
        `UPDATE affiliates
         SET saldo_disponivel = saldo_disponivel + $1,
             saldo_pendente = GREATEST(saldo_pendente - $1, 0),
             updated_at = NOW()
         WHERE id = $2`,
        [parseFloat(com.valor_comissao), com.affiliate_id]
      );
    }

    console.log(`[Affiliate] Released ${rows.length} commissions`);
    res.json({ success: true, released: rows.length });
  } catch (err) {
    console.error('[Affiliate Release] Error:', err);
    res.status(500).json({ error: 'Erro ao liberar comissoes' });
  }
});

// ============================================
// COMMISSION ENGINE — Funcao para ser chamada pelo webhook do MercadoPago
// ============================================
export async function processAffiliateCommission(orderId, cpf, service, price) {
  try {
    // Buscar usuario
    const { rows: userRows } = await db.query('SELECT id, referred_by_code FROM users WHERE cpf = $1', [cpf]);
    if (!userRows[0] || !userRows[0].referred_by_code) return; // Sem referral

    // Buscar afiliado N1 (quem indicou)
    const { rows: n1Rows } = await db.query(
      'SELECT * FROM affiliates WHERE ref_code = $1',
      [userRows[0].referred_by_code]
    );
    if (!n1Rows[0]) return;

    const n1 = n1Rows[0];
    const tierConfig = TIER_CONFIG[n1.tier] || TIER_CONFIG.starter;
    const comissaoN1Percent = tierConfig.n1_vendas;
    const valorComissaoN1 = parseFloat(((price * comissaoN1Percent) / 100).toFixed(2));

    // Inserir comissao N1
    await db.query(
      `INSERT INTO affiliate_commissions (affiliate_id, nivel, tipo, order_id, produto, valor_venda, comissao_percent, valor_comissao, status, disponivel_em)
       VALUES ($1, 1, 'venda', $2, $3, $4, $5, $6, 'pendente', NOW() + INTERVAL '7 days')`,
      [n1.id, orderId, service, price, comissaoN1Percent, valorComissaoN1]
    );

    // Atualizar faturamento e contagem N1
    await db.query(
      `UPDATE affiliates SET
        faturamento_acumulado = faturamento_acumulado + $1,
        saldo_pendente = saldo_pendente + $2,
        total_vendas_n1 = total_vendas_n1 + 1,
        updated_at = NOW()
       WHERE id = $3`,
      [price, valorComissaoN1, n1.id]
    );

    // Check tier upgrade por merito (se nao for ouro pago)
    if (n1.tier !== 'ouro') {
      const newFat = parseFloat(n1.faturamento_acumulado) + price;
      const newTier = calculateMeritTier(newFat);
      if (newTier !== n1.tier) {
        await db.query('UPDATE affiliates SET tier = $1, updated_at = NOW() WHERE id = $2', [newTier, n1.id]);
        console.log(`[Affiliate] ${n1.ref_code} upgraded to ${newTier}!`);
      }
    }

    // Check badges
    await checkAndGrantBadges(n1.id);

    console.log(`[Affiliate] N1 commission: ${n1.ref_code} earns R$ ${valorComissaoN1} (${comissaoN1Percent}%) on ${service}`);

    // N2 — somente se upline for OURO
    if (n1.upline_id) {
      const { rows: n2Rows } = await db.query('SELECT * FROM affiliates WHERE id = $1', [n1.upline_id]);
      if (n2Rows[0] && n2Rows[0].tier === 'ouro' && n2Rows[0].ouro_ativo) {
        const n2 = n2Rows[0];
        const n2Percent = TIER_CONFIG.ouro.n2_vendas;
        const valorComissaoN2 = parseFloat(((price * n2Percent) / 100).toFixed(2));

        await db.query(
          `INSERT INTO affiliate_commissions (affiliate_id, nivel, tipo, order_id, produto, valor_venda, comissao_percent, valor_comissao, status, disponivel_em)
           VALUES ($1, 2, 'venda', $2, $3, $4, $5, $6, 'pendente', NOW() + INTERVAL '7 days')`,
          [n2.id, orderId, service, price, n2Percent, valorComissaoN2]
        );

        await db.query(
          `UPDATE affiliates SET
            saldo_pendente = saldo_pendente + $1,
            total_vendas_n2 = total_vendas_n2 + 1,
            updated_at = NOW()
           WHERE id = $2`,
          [valorComissaoN2, n2.id]
        );

        await checkAndGrantBadges(n2.id);

        console.log(`[Affiliate] N2 commission: ${n2.ref_code} earns R$ ${valorComissaoN2} (${n2Percent}%) on ${service} via ${n1.ref_code}`);
      }
    }
  } catch (err) {
    console.error('[Affiliate Commission Engine] Error:', err);
  }
}

// ============================================
// POST /api/affiliate/upgrade-ouro — Create Ouro subscription checkout
// ============================================
affiliateRouter.post("/api/affiliate/upgrade-ouro", async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: "user_id obrigatório" });

    const { rows: affRows } = await db.query(
      "SELECT a.*, u.cpf, u.nome, u.email FROM affiliates a JOIN users u ON u.id = a.user_id WHERE a.user_id = $1",
      [user_id]
    );
    const aff = affRows[0];
    if (!aff) return res.status(404).json({ error: "Afiliado não encontrado" });
    if (aff.ouro_ativo) return res.status(400).json({ error: "Você já possui Ouro ativo!" });

    const checkout = await createCheckout({
      cpf: aff.cpf,
      name: aff.nome,
      email: aff.email,
      service: "Assinatura Ouro Afiliado",
      price: 29.90
    });

    console.log(`[Affiliate] Ouro checkout created for user ${user_id} — ${checkout.initPoint}`);
    res.json({ success: true, checkoutUrl: checkout.initPoint });
  } catch (err) {
    console.error("[Affiliate] upgrade-ouro error:", err);
    res.status(500).json({ error: "Erro ao criar checkout Ouro" });
  }
});

// ============================================
// Commission release cron (runs every hour)
// ============================================
setInterval(async () => {
  try {
    const { rows } = await db.query(
      "UPDATE affiliate_commissions SET status = 'disponivel' WHERE status = 'pendente' AND disponivel_em <= NOW() RETURNING id, affiliate_id, valor_comissao"
    );
    if (rows.length > 0) {
      for (const row of rows) {
        await db.query(
          "UPDATE affiliates SET saldo_disponivel = saldo_disponivel + $1, saldo_pendente = saldo_pendente - $1 WHERE id = $2",
          [row.valor_comissao, row.affiliate_id]
        );
      }
      console.log(`[Affiliate Cron] Released ${rows.length} commissions`);
    }
  } catch (err) {
    console.error("[Affiliate Cron] Error:", err.message);
  }
}, 60 * 60 * 1000); // every hour

// Ouro expiration check (runs every 6 hours)
setInterval(async () => {
  try {
    const { rows } = await db.query(
      "UPDATE affiliates SET ouro_ativo = false WHERE ouro_ativo = true AND ouro_ativo_ate IS NOT NULL AND ouro_ativo_ate <= NOW() RETURNING id, user_id"
    );
    if (rows.length > 0) {
      for (const row of rows) {
        const { rows: affRows } = await db.query("SELECT faturamento_acumulado FROM affiliates WHERE id = $1", [row.id]);
        const fat = parseFloat(affRows[0]?.faturamento_acumulado || 0);
        let newTier = "starter";
        if (fat >= 5000) newTier = "prata";
        else if (fat >= 500) newTier = "bronze";
        await db.query("UPDATE affiliates SET tier = $1 WHERE id = $2", [newTier, row.id]);
      }
      console.log(`[Affiliate Cron] Expired ${rows.length} Ouro subscriptions`);
    }
  } catch (err) {
    console.error("[Affiliate Cron] Ouro expiration error:", err.message);
  }
}, 6 * 60 * 60 * 1000); // every 6 hours
