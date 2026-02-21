import { Router } from 'express';
import multer from "multer";
import path from "path";
import fs from "fs";
import { db } from '../db/client.js';
import { triggerSdrOutreach } from '../sdr/outreach.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import * as otplib from 'otplib';
import QRCode from 'qrcode';

export const usersRouter = Router();

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-dev-secret-change-me';
const JWT_EXPIRES_IN = '24h';
// 2FA is required for all managers

// ============================================
// POST /api/register — Register new client
// ============================================
usersRouter.post('/api/register', async (req, res) => {
  try {
    const { nome, cpf, email, telefone, senha } = req.body;

    if (!nome || !cpf || !email || !senha) {
      return res.status(400).json({ success: false, error: 'Campos obrigatorios: nome, cpf, email, senha' });
    }

    // Check if CPF or email already exists
    const { rows: existing } = await db.query(
      'SELECT id FROM users WHERE cpf = $1 OR email = $2',
      [cpf, email]
    );

    if (existing.length > 0) {
      return res.status(409).json({ success: false, error: 'CPF ou E-mail ja cadastrados!' });
    }

    const { rows } = await db.query(
      `INSERT INTO users (nome, cpf, email, telefone, senha)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, nome, cpf, email, telefone, tipo, status, created_at`,
      [nome, cpf, email, telefone || null, senha]
    );

    res.json({ success: true, user: rows[0] });

    // Trigger SDR outreach (Paulo) if phone present — async, does not block response
    if (telefone) {
      triggerSdrOutreach(telefone, nome, email).catch(err => {
        console.error("[SDR] Outreach trigger error:", err.message);
      });
    }
  } catch (err) {
    console.error('[API] Register error:', err.message);
    if (err.code === '23505') {
      return res.status(409).json({ success: false, error: 'CPF ou E-mail ja cadastrados!' });
    }
    res.status(500).json({ success: false, error: 'Erro interno no servidor' });
  }
});

// ============================================
// POST /api/login — Client login
// ============================================
usersRouter.post('/api/login', async (req, res) => {
  try {
    const { email, senha } = req.body;

    if (!email || !senha) {
      return res.status(400).json({ success: false, error: 'Email e senha obrigatorios' });
    }

    // Allow login by email or CPF
    const { rows } = await db.query(
      `SELECT id, nome, cpf, email, telefone, tipo, status, created_at
       FROM users
       WHERE (email = $1 OR cpf = $1) AND senha = $2 AND ativo = true`,
      [email, senha]
    );

    if (rows.length === 0) {
      return res.status(401).json({ success: false, error: 'CPF/Email ou senha invalidos' });
    }

    res.json({ success: true, user: rows[0] });

  } catch (err) {
    console.error('[API] Login error:', err.message);
    res.status(500).json({ success: false, error: 'Erro interno no servidor' });
  }
});

// ============================================
// POST /api/admin/login — Admin/manager login (JWT + bcrypt + 2FA)
// ============================================
usersRouter.post('/api/admin/login', async (req, res) => {
  try {
    const { email, senha } = req.body;

    if (!email || !senha) {
      return res.status(400).json({ success: false, error: 'Email e senha obrigatorios' });
    }

    const { rows } = await db.query(
      `SELECT id, nome, email, senha, tipo, permissoes, ativo, totp_secret, totp_enabled
       FROM managers
       WHERE email = $1 AND ativo = true`,
      [email]
    );

    if (rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Credenciais invalidas' });
    }

    const manager = rows[0];

    // Compare with bcrypt
    const passwordMatch = await bcrypt.compare(senha, manager.senha);
    if (!passwordMatch) {
      return res.status(401).json({ success: false, error: 'Credenciais invalidas' });
    }

    // Map tipo to role for frontend RBAC compatibility
    const tipoToRole = {
      'Admin Master': 'SUPER_ADMIN',
      'Superusuario': 'SUPER_ADMIN',
      'Superusuário': 'SUPER_ADMIN',
      'Administrador': 'ADMIN',
      'Operacional': 'OPERATIONAL',
      'Admin': 'ADMIN',
      'Gerente': 'GERENTE',
      'Gerente Operacional': 'OPERATIONAL'
    };

    const role = tipoToRole[manager.tipo] || null;

    // 2FA check
    if (!manager.totp_enabled && !manager.totp_secret) {
      // 2FA not configured — skip, issue final token directly
      const finalToken = jwt.sign(
        { id: manager.id, email: manager.email, role: role },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
      );
      const session = {
        id: manager.id, nome: manager.nome, email: manager.email,
        tipo: manager.tipo, role: role, permissoes: manager.permissoes,
        isMaster: manager.tipo === 'Admin Master' || manager.tipo === 'Superusuario' || manager.tipo === 'Superusuário',
        loggedIn: true
      };
      return res.json({ success: true, token: finalToken, session });
    } else if (!manager.totp_enabled) {
      // Has secret but not enabled — needs to complete 2FA setup
      const tempToken = jwt.sign(
        { id: manager.id, email: manager.email, role: role, purpose: '2fa-setup' },
        JWT_SECRET,
        { expiresIn: '10m' }
      );
      return res.json({ success: true, requiresSetup: true, tempToken });
    } else {
      // 2FA enabled — needs to verify code
      const tempToken = jwt.sign(
        { id: manager.id, email: manager.email, role: role, purpose: '2fa-verify' },
        JWT_SECRET,
        { expiresIn: '5m' }
      );
      return res.json({ success: true, requires2FA: true, tempToken });
    }
  } catch (err) {
    console.error('[API] Admin login error:', err.message);
    res.status(500).json({ success: false, error: 'Erro interno no servidor' });
  }
});

// ============================================
// POST /api/admin/2fa/setup — Generate TOTP secret + QR code
// (requires tempToken with purpose='2fa-setup')
// ============================================
usersRouter.post('/api/admin/2fa/setup', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Token ausente' });
    }

    const token = authHeader.split(' ')[1];
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ success: false, error: 'Token invalido ou expirado' });
    }

    if (decoded.purpose !== '2fa-setup') {
      return res.status(403).json({ success: false, error: 'Token nao autorizado para esta operacao' });
    }

    const secret = otplib.generateSecret();
    const otpAuthUrl = otplib.generateURI({ secret, issuer: 'CredPositivo Admin', label: decoded.email, type: 'totp' });
    const qrCode = await QRCode.toDataURL(otpAuthUrl);

    // Save secret (but don't enable yet — user must verify first)
    await db.query(
      'UPDATE managers SET totp_secret = $1 WHERE id = $2',
      [secret, decoded.id]
    );

    res.json({ success: true, qrCode, secret });
  } catch (err) {
    console.error('[API] 2FA setup error:', err.message);
    res.status(500).json({ success: false, error: 'Erro ao configurar 2FA' });
  }
});

// ============================================
// POST /api/admin/2fa/verify — Verify TOTP code and return final JWT
// (requires tempToken with purpose='2fa-setup' or '2fa-verify')
// ============================================
usersRouter.post('/api/admin/2fa/verify', async (req, res) => {
  try {
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({ success: false, error: 'Codigo obrigatorio' });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Token ausente' });
    }

    const token = authHeader.split(' ')[1];
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ success: false, error: 'Token invalido ou expirado' });
    }

    if (decoded.purpose !== '2fa-setup' && decoded.purpose !== '2fa-verify') {
      return res.status(403).json({ success: false, error: 'Token nao autorizado' });
    }

    // Get the stored secret
    const { rows } = await db.query(
      'SELECT id, nome, email, tipo, permissoes, totp_secret, totp_enabled FROM managers WHERE id = $1',
      [decoded.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Gerente nao encontrado' });
    }

    const manager = rows[0];

    if (!manager.totp_secret) {
      return res.status(400).json({ success: false, error: 'Configure o autenticador primeiro' });
    }

    const result = otplib.verifySync({ token: code, secret: manager.totp_secret });
    const isValid = result && result.valid;

    if (!isValid) {
      return res.status(401).json({ success: false, error: 'Codigo invalido' });
    }

    // If this was setup, enable TOTP
    if (decoded.purpose === '2fa-setup') {
      await db.query(
        'UPDATE managers SET totp_enabled = true WHERE id = $1',
        [decoded.id]
      );
    }

    // Map tipo to role
    const tipoToRole = {
      'Admin Master': 'SUPER_ADMIN',
      'Superusuario': 'SUPER_ADMIN',
      'Superusuário': 'SUPER_ADMIN',
      'Administrador': 'ADMIN',
      'Operacional': 'OPERATIONAL',
      'Admin': 'ADMIN',
      'Gerente': 'GERENTE',
      'Gerente Operacional': 'OPERATIONAL'
    };

    const role = tipoToRole[manager.tipo] || null;

    // Generate final JWT (24h)
    const finalToken = jwt.sign(
      { id: manager.id, email: manager.email, role: role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    const session = {
      id: manager.id,
      nome: manager.nome,
      email: manager.email,
      tipo: manager.tipo,
      role: role,
      permissoes: manager.permissoes,
      isMaster: manager.tipo === 'Admin Master' || manager.tipo === 'Superusuario' || manager.tipo === 'Superusuário',
      loggedIn: true
    };

    res.json({ success: true, token: finalToken, session });
  } catch (err) {
    console.error('[API] 2FA verify error:', err.message);
    res.status(500).json({ success: false, error: 'Erro ao verificar codigo' });
  }
});

// ============================================
// NOTE: All routes below are protected by global
// requireAdmin middleware in index.js
// ============================================

// GET /api/admin/users — List all users
usersRouter.get('/api/admin/users', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, nome, cpf, email, telefone, tipo, status, ativo, created_at
       FROM users
       ORDER BY created_at DESC`
    );
    res.json({ success: true, users: rows });
  } catch (err) {
    console.error('[API] List users error:', err.message);
    res.status(500).json({ success: false, error: 'Erro ao buscar usuarios' });
  }
});

// GET /api/admin/orders — List all orders
usersRouter.get('/api/admin/orders', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT o.*, u.nome as user_nome, u.cpf as user_cpf, u.email as user_email,
             d.cpf as diag_cpf, d.status as diagnostico_status, d.pdf_path as diag_pdf_path
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       LEFT JOIN diagnosticos d ON d.id = o.diagnostico_id
       ORDER BY o.created_at DESC`
    );
    res.json({ success: true, orders: rows });
  } catch (err) {
    console.error('[API] List orders error:', err.message);
    res.status(500).json({ success: false, error: 'Erro ao buscar pedidos' });
  }
});

// POST /api/admin/orders — Create order
usersRouter.post('/api/admin/orders', async (req, res) => {
  try {
    const { user_id, service, price, status } = req.body;

    if (!user_id || !service) {
      return res.status(400).json({ success: false, error: 'user_id e service obrigatorios' });
    }

    const { rows: userRows } = await db.query('SELECT cpf, nome, email FROM users WHERE id = $1', [user_id]);
    const user = userRows[0];

    if (!user) {
      return res.status(404).json({ success: false, error: 'Usuario nao encontrado' });
    }

    const orderPrice = price || (service === 'Limpa Nome' ? 147 : service === 'Rating Bancario' ? 97 : 47);
    const orderStatus = status || 'Aguardando Pagamento';

    const { rows } = await db.query(
      `INSERT INTO orders (cpf, customer_name, customer_email, service, price, status, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [user.cpf, user.nome, user.email, service, orderPrice, orderStatus, user_id]
    );

    res.json({ success: true, order: rows[0] });
  } catch (err) {
    console.error('[API] Create order error:', err.message);
    res.status(500).json({ success: false, error: 'Erro ao criar pedido' });
  }
});

// PUT /api/admin/orders/:id — Update order status
usersRouter.put('/api/admin/orders/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, observacoes, doc_tipo, doc_numero, nome_fantasia } = req.body;

    const sets = [];
    const vals = [];
    let idx = 1;

    if (status) { sets.push('status = $' + idx); vals.push(status); idx++; }
    if (observacoes !== undefined) { sets.push('observacoes = $' + idx); vals.push(observacoes); idx++; }
    if (doc_tipo !== undefined) { sets.push('doc_tipo = $' + idx); vals.push(doc_tipo); idx++; }
    if (doc_numero !== undefined) { sets.push('doc_numero = $' + idx); vals.push(doc_numero); idx++; }
    if (nome_fantasia !== undefined) { sets.push('nome_fantasia = $' + idx); vals.push(nome_fantasia); idx++; }

    if (sets.length === 0) {
      return res.status(400).json({ success: false, error: 'Nenhum campo para atualizar' });
    }

    sets.push('updated_at = NOW()');
    vals.push(id);

    const { rows } = await db.query(
      'UPDATE orders SET ' + sets.join(', ') + ' WHERE id = $' + idx + ' RETURNING *',
      vals
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Pedido nao encontrado' });
    }

    res.json({ success: true, order: rows[0] });
  } catch (err) {
    console.error('[API] Update order error:', err.message);
    res.status(500).json({ success: false, error: 'Erro ao atualizar pedido' });
  }
});

// DELETE /api/admin/orders/:id — Delete order
usersRouter.delete('/api/admin/orders/:id', async (req, res) => {
  try {
    const { id } = req.params;

    await db.query('DELETE FROM diagnosticos WHERE order_id = $1', [id]);

    const { rowCount } = await db.query('DELETE FROM orders WHERE id = $1', [id]);

    if (rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Pedido nao encontrado' });
    }

    res.json({ success: true, message: 'Pedido excluido' });
  } catch (err) {
    console.error('[API] Delete order error:', err.message);
    res.status(500).json({ success: false, error: 'Erro ao excluir pedido' });
  }
});

// ============================================
// POST /api/orders/:id/document - Client submits CPF/CNPJ info
// ============================================
usersRouter.post('/api/orders/:id/document', async (req, res) => {
  try {
    const { id } = req.params;
    const { doc_tipo, doc_numero, nome_fantasia } = req.body;

    if (!doc_tipo || !doc_numero) {
      return res.status(400).json({ success: false, error: 'doc_tipo e doc_numero obrigatorios' });
    }

    if (doc_tipo !== 'cpf' && doc_tipo !== 'cnpj') {
      return res.status(400).json({ success: false, error: 'doc_tipo deve ser cpf ou cnpj' });
    }

    const clean = doc_numero.replace(/[^0-9]/g, '');
    if (doc_tipo === 'cpf' && clean.length !== 11) {
      return res.status(400).json({ success: false, error: 'CPF invalido' });
    }
    if (doc_tipo === 'cnpj' && clean.length !== 14) {
      return res.status(400).json({ success: false, error: 'CNPJ invalido' });
    }

    let query, vals;
    if (nome_fantasia) {
      query = 'UPDATE orders SET doc_tipo = $1, doc_numero = $2, nome_fantasia = $3, updated_at = NOW() WHERE id = $4 RETURNING *';
      vals = [doc_tipo, clean, nome_fantasia, id];
    } else {
      query = 'UPDATE orders SET doc_tipo = $1, doc_numero = $2, updated_at = NOW() WHERE id = $3 RETURNING *';
      vals = [doc_tipo, clean, id];
    }

    const { rows } = await db.query(query, vals);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Pedido nao encontrado' });
    }

    res.json({ success: true, order: rows[0] });
  } catch (err) {
    console.error('[API] Document submit error:', err.message);
    res.status(500).json({ success: false, error: 'Erro ao salvar documento' });
  }
});

// GET /api/admin/extrato - Financial statement
usersRouter.get('/api/admin/extrato', async (req, res) => {
  try {
    const { rows: orders } = await db.query(
      `SELECT o.id, o.service, o.price, o.status, o.created_at, o.customer_name, o.cpf,
              o.mp_payment_id, o.mp_status
       FROM orders o
       WHERE o.status IN ('completed', 'paid', 'processing')
       ORDER BY o.created_at DESC`
    );

    const { rows: balanceRows } = await db.query(
      'SELECT COALESCE(SUM(saldo), 0) as total_saldo FROM users'
    );

    const { rows: stats } = await db.query(
      `SELECT
        COUNT(*) FILTER (WHERE status IN ('completed', 'paid', 'processing')) as total_pedidos,
        COALESCE(SUM(price) FILTER (WHERE status IN ('completed', 'paid', 'processing')), 0) as receita_total,
        COALESCE(SUM(price) FILTER (WHERE status = 'completed'), 0) as receita_concluida,
        COALESCE(SUM(price) FILTER (WHERE status IN ('paid', 'processing')), 0) as receita_pendente,
        COUNT(*) FILTER (WHERE status = 'pending') as pedidos_pendentes,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days' AND status IN ('completed', 'paid', 'processing')) as pedidos_mes
      FROM orders`
    );

    res.json({
      success: true,
      stats: stats[0],
      saldo_clientes: parseFloat(balanceRows[0].total_saldo),
      orders: orders
    });
  } catch (err) {
    console.error('[API] Extrato error:', err.message);
    res.status(500).json({ success: false, error: 'Erro ao gerar extrato' });
  }
});

// GET /api/admin/managers — List managers
usersRouter.get('/api/admin/managers', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, nome, email, tipo, permissoes, ativo, totp_enabled, created_at
       FROM managers
       ORDER BY created_at DESC`
    );
    res.json({ success: true, managers: rows });
  } catch (err) {
    console.error('[API] List managers error:', err.message);
    res.status(500).json({ success: false, error: 'Erro ao buscar gerentes' });
  }
});

// POST /api/admin/managers — Create manager (hash password with bcrypt)
usersRouter.post('/api/admin/managers', async (req, res) => {
  try {
    const { nome, email, senha, tipo, permissoes } = req.body;

    if (!nome || !email || !senha) {
      return res.status(400).json({ success: false, error: 'nome, email e senha obrigatorios' });
    }

    const hashedPassword = await bcrypt.hash(senha, 10);

    const { rows } = await db.query(
      `INSERT INTO managers (nome, email, senha, tipo, permissoes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, nome, email, tipo, permissoes, ativo, created_at`,
      [nome, email, hashedPassword, tipo || 'Operacional', JSON.stringify(permissoes || {})]
    );

    res.json({ success: true, manager: rows[0] });
  } catch (err) {
    console.error('[API] Create manager error:', err.message);
    if (err.code === '23505') {
      return res.status(409).json({ success: false, error: 'Email ja cadastrado' });
    }
    res.status(500).json({ success: false, error: 'Erro ao criar gerente' });
  }
});

// PUT /api/admin/managers/:id — Update manager (hash password if changed)
usersRouter.put('/api/admin/managers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { nome, email, senha, tipo, permissoes, ativo } = req.body;

    const fields = [];
    const values = [];
    let idx = 1;

    if (nome !== undefined) { fields.push(`nome = $${idx}`); values.push(nome); idx++; }
    if (email !== undefined) { fields.push(`email = $${idx}`); values.push(email); idx++; }
    if (senha !== undefined) {
      const hashedPassword = await bcrypt.hash(senha, 10);
      fields.push(`senha = $${idx}`);
      values.push(hashedPassword);
      idx++;
    }
    if (tipo !== undefined) { fields.push(`tipo = $${idx}`); values.push(tipo); idx++; }
    if (permissoes !== undefined) { fields.push(`permissoes = $${idx}`); values.push(JSON.stringify(permissoes)); idx++; }
    if (ativo !== undefined) { fields.push(`ativo = $${idx}`); values.push(ativo); idx++; }

    if (fields.length === 0) {
      return res.status(400).json({ success: false, error: 'Nenhum campo para atualizar' });
    }

    values.push(id);
    const { rows } = await db.query(
      `UPDATE managers SET ${fields.join(', ')} WHERE id = $${idx} RETURNING id, nome, email, tipo, permissoes, ativo, created_at`,
      values
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Gerente nao encontrado' });
    }

    res.json({ success: true, manager: rows[0] });
  } catch (err) {
    console.error('[API] Update manager error:', err.message);
    res.status(500).json({ success: false, error: 'Erro ao atualizar gerente' });
  }
});

// DELETE /api/admin/managers/:id — Delete manager
usersRouter.delete('/api/admin/managers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rowCount } = await db.query('DELETE FROM managers WHERE id = $1', [id]);

    if (rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Gerente nao encontrado' });
    }

    res.json({ success: true, message: 'Gerente excluido' });
  } catch (err) {
    console.error('[API] Delete manager error:', err.message);
    res.status(500).json({ success: false, error: 'Erro ao excluir gerente' });
  }
});

// GET /api/admin/stats — Dashboard stats
usersRouter.get('/api/admin/stats', async (req, res) => {
  try {
    const [usersCount, ordersStats] = await Promise.all([
      db.query('SELECT COUNT(*) as total FROM users WHERE ativo = true'),
      db.query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'Aguardando Pagamento' OR status = 'pending') as aguardando,
          COUNT(*) FILTER (WHERE status = 'Em Analise' OR status = 'Em Análise') as em_analise,
          COUNT(*) FILTER (WHERE status = 'Concluido' OR status = 'Concluído' OR status = 'approved') as concluido,
          COALESCE(SUM(price), 0) as receita_total
        FROM orders
      `)
    ]);

    res.json({
      success: true,
      stats: {
        total_clientes: parseInt(usersCount.rows[0].total),
        total_pedidos: parseInt(ordersStats.rows[0].total),
        aguardando_pagamento: parseInt(ordersStats.rows[0].aguardando),
        em_analise: parseInt(ordersStats.rows[0].em_analise),
        concluido: parseInt(ordersStats.rows[0].concluido),
        processos_ativos: parseInt(ordersStats.rows[0].total) - parseInt(ordersStats.rows[0].concluido),
        receita_total: parseFloat(ordersStats.rows[0].receita_total)
      }
    });
  } catch (err) {
    console.error('[API] Stats error:', err.message);
    res.status(500).json({ success: false, error: 'Erro ao buscar estatisticas' });
  }
});

// GET /api/profile/:cpf — Get user profile (public)
usersRouter.get('/api/profile/:cpf', async (req, res) => {
  try {
    const cpf = req.params.cpf.replace(/[^0-9]/g, '');
    if (!cpf || cpf.length !== 11) {
      return res.status(400).json({ error: 'CPF inválido' });
    }
    const { rows } = await db.query(
      'SELECT id, nome, cpf, email, telefone, saldo FROM users WHERE cpf = $1 AND ativo = true',
      [cpf]
    );
    if (!rows[0]) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    res.json({ user: rows[0] });
  } catch (err) {
    console.error('[Profile] Error:', err);
    res.status(500).json({ error: 'Erro ao buscar perfil' });
  }
});

// ============================================
// Admin Diagnostico Endpoints
// ============================================

const DIAG_DIR = "/data/diagnosticos/";

const diagStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.mkdirSync(DIAG_DIR, { recursive: true });
    cb(null, DIAG_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, "diag_" + req.params.orderId + "_" + Date.now() + ext);
  }
});

const diagUpload = multer({
  storage: diagStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Apenas arquivos PDF sao permitidos"));
  }
});

// POST /api/admin/diagnosticos/:orderId/upload — Upload diagnostico PDF
usersRouter.post("/api/admin/diagnosticos/:orderId/upload", diagUpload.single("file"), async (req, res) => {
  try {
    const { orderId } = req.params;
    if (!req.file) {
      return res.status(400).json({ success: false, error: "Arquivo PDF obrigatorio" });
    }

    const pdfPath = "/data/diagnosticos/" + req.file.filename;

    // Check if order exists
    const { rows: orderRows } = await db.query("SELECT id, cpf, user_id FROM orders WHERE id = $1", [orderId]);
    if (!orderRows[0]) {
      return res.status(404).json({ success: false, error: "Pedido nao encontrado" });
    }

    const cpf = orderRows[0].cpf;

    // Check if diagnostico already exists for this order
    const { rows: existing } = await db.query("SELECT id FROM diagnosticos WHERE order_id = $1", [orderId]);

    let diag;
    if (existing.length > 0) {
      const { rows } = await db.query(
        "UPDATE diagnosticos SET pdf_path = $1, status = $2 WHERE order_id = $3 RETURNING *",
        [pdfPath, "completed", orderId]
      );
      diag = rows[0];
    } else {
      const { rows } = await db.query(
        "INSERT INTO diagnosticos (order_id, cpf, pdf_path, status) VALUES ($1, $2, $3, $4) RETURNING *",
        [orderId, cpf, pdfPath, "completed"]
      );
      diag = rows[0];
    }

    res.json({ success: true, diagnostico: diag });
  } catch (err) {
    console.error("[API] Diagnostico upload error:", err.message);
    res.status(500).json({ success: false, error: "Erro ao fazer upload do diagnostico" });
  }
});

// GET /api/admin/diagnosticos/:orderId — Get diagnostico data for an order
usersRouter.get("/api/admin/diagnosticos/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;
    const { rows } = await db.query(
      "SELECT * FROM diagnosticos WHERE order_id = $1",
      [orderId]
    );

    if (rows.length === 0) {
      return res.json({ success: true, diagnostico: null });
    }

    res.json({ success: true, diagnostico: rows[0] });
  } catch (err) {
    console.error("[API] Diagnostico get error:", err.message);
    res.status(500).json({ success: false, error: "Erro ao buscar diagnostico" });
  }
});

// GET /api/admin/diagnosticos/:id/pdf — Serve diagnostico PDF (admin, no status restriction)
usersRouter.get("/api/admin/diagnosticos/:id/pdf", async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await db.query("SELECT pdf_path FROM diagnosticos WHERE id = $1", [id]);

    if (!rows[0] || !rows[0].pdf_path) {
      return res.status(404).json({ success: false, error: "PDF nao encontrado" });
    }

    const filePath = rows[0].pdf_path;
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: "Arquivo nao encontrado no servidor" });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "inline; filename=diagnostico_" + id + ".pdf");
    res.sendFile(filePath);
  } catch (err) {
    console.error("[API] Diagnostico PDF error:", err.message);
    res.status(500).json({ success: false, error: "Erro ao servir PDF" });
  }
});
