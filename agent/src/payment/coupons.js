import { Router } from 'express';
import { db } from '../db/client.js';

export const couponRouter = Router();

// ============================================================
// ADMIN ENDPOINTS — Coupon Management
// ============================================================

/**
 * POST /api/admin/coupons — Create a new coupon.
 *
 * Body: { code, discount_percent, max_uses?, applicable_services?, expires_at? }
 *
 * - code: required, will be uppercased and trimmed
 * - discount_percent: required, integer 1-100
 * - max_uses: optional, defaults to 0 (unlimited)
 * - applicable_services: optional array of service slugs, defaults to [] (all services)
 * - expires_at: optional ISO date string
 */
couponRouter.post('/api/admin/coupons', async (req, res) => {
  try {
    const {
      code,
      discount_percent,
      max_uses = 0,
      applicable_services = [],
      expires_at = null,
    } = req.body;

    // --- Validation ---
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Campo "code" é obrigatório.' });
    }

    if (
      discount_percent === undefined ||
      discount_percent === null ||
      discount_percent < 1 ||
      discount_percent > 100
    ) {
      return res
        .status(400)
        .json({ error: 'Campo "discount_percent" é obrigatório (1-100).' });
    }

    const cleanCode = code.trim().toUpperCase();

    const { rows } = await db.query(
      `INSERT INTO coupons (code, discount_percent, max_uses, applicable_services, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING *`,
      [
        cleanCode,
        discount_percent,
        max_uses,
        JSON.stringify(applicable_services),
        expires_at,
      ]
    );

    console.log(`[Coupons] Created coupon: ${cleanCode} (${discount_percent}%)`);
    return res.status(201).json(rows[0]);
  } catch (err) {
    // Handle unique constraint violation on code
    if (err.code === '23505') {
      return res
        .status(409)
        .json({ error: 'Já existe um cupom com esse código.' });
    }
    console.error('[Coupons] Error creating coupon:', err);
    return res.status(500).json({ error: 'Erro interno ao criar cupom.' });
  }
});

/**
 * GET /api/admin/coupons — List all coupons.
 *
 * Returns: { coupons: [...] } ordered by created_at DESC.
 */
couponRouter.get('/api/admin/coupons', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM coupons ORDER BY created_at DESC'
    );

    return res.json({ coupons: rows });
  } catch (err) {
    console.error('[Coupons] Error listing coupons:', err);
    return res.status(500).json({ error: 'Erro interno ao listar cupons.' });
  }
});

/**
 * PUT /api/admin/coupons/:id — Update an existing coupon.
 *
 * Accepts partial updates: { code?, discount_percent?, max_uses?, applicable_services?, active?, expires_at? }
 * Builds a dynamic UPDATE query from the provided fields.
 */
couponRouter.put('/api/admin/coupons/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const allowedFields = [
      'code',
      'discount_percent',
      'max_uses',
      'applicable_services',
      'active',
      'expires_at',
    ];

    const setClauses = [];
    const values = [];
    let paramIndex = 1;

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        let value = req.body[field];

        // Uppercase and trim code
        if (field === 'code' && typeof value === 'string') {
          value = value.trim().toUpperCase();
        }

        // Serialize applicable_services as JSONB
        if (field === 'applicable_services') {
          setClauses.push(`${field} = $${paramIndex}::jsonb`);
          values.push(JSON.stringify(value));
        } else {
          setClauses.push(`${field} = $${paramIndex}`);
          values.push(value);
        }

        paramIndex++;
      }
    }

    if (setClauses.length === 0) {
      return res
        .status(400)
        .json({ error: 'Nenhum campo válido para atualizar.' });
    }

    // Always update the updated_at timestamp
    setClauses.push(`updated_at = NOW()`);

    // Add the coupon ID as the last parameter
    values.push(id);

    const { rows } = await db.query(
      `UPDATE coupons SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Cupom não encontrado.' });
    }

    console.log(`[Coupons] Updated coupon id=${id}`);
    return res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res
        .status(409)
        .json({ error: 'Já existe um cupom com esse código.' });
    }
    console.error('[Coupons] Error updating coupon:', err);
    return res.status(500).json({ error: 'Erro interno ao atualizar cupom.' });
  }
});

/**
 * DELETE /api/admin/coupons/:id — Deactivate a coupon (soft delete).
 *
 * Sets active = false instead of removing the row.
 */
couponRouter.delete('/api/admin/coupons/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { rowCount } = await db.query(
      'DELETE FROM coupons WHERE id = $1',
      [id]
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: 'Cupom não encontrado.' });
    }

    console.log(`[Coupons] Deleted coupon id=${id}`);
    return res.json({ success: true });
  } catch (err) {
    console.error('[Coupons] Error deleting coupon:', err);
    return res.status(500).json({ error: 'Erro interno ao excluir cupom.' });
  }
});

// ============================================================
// PUBLIC ENDPOINT — Coupon Validation at Checkout
// ============================================================

/**
 * POST /api/coupons/validate — Validate a coupon at checkout.
 *
 * Body: { code, service_slug, price }
 *
 * Checks:
 *  1. Coupon exists (case-insensitive lookup)
 *  2. Coupon is active
 *  3. Coupon is not expired
 *  4. Usage limit not reached (max_uses = 0 means unlimited)
 *  5. Coupon applies to the given service (empty applicable_services = all)
 *
 * Returns on success:
 *   { valid: true, coupon: { code, discount_percent }, original_price, discount_amount, final_price }
 *
 * Returns on failure:
 *   { valid: false, reason: "..." }
 */
couponRouter.post('/api/coupons/validate', async (req, res) => {
  try {
    const { code, service_slug, price } = req.body;

    // --- Input validation ---
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ valid: false, reason: 'Código do cupom é obrigatório.' });
    }

    if (price === undefined || price === null || price <= 0) {
      return res.status(400).json({ valid: false, reason: 'Preço inválido.' });
    }

    const cleanCode = code.trim().toUpperCase();

    // --- Find coupon (case-insensitive) ---
    const { rows } = await db.query(
      'SELECT * FROM coupons WHERE UPPER(TRIM(code)) = $1',
      [cleanCode]
    );

    if (rows.length === 0) {
      return res.json({ valid: false, reason: 'Cupom não encontrado.' });
    }

    const coupon = rows[0];

    // --- Check: active ---
    if (!coupon.active) {
      return res.json({ valid: false, reason: 'Este cupom está desativado.' });
    }

    // --- Check: not expired ---
    if (coupon.expires_at && new Date(coupon.expires_at) <= new Date()) {
      return res.json({ valid: false, reason: 'Este cupom expirou.' });
    }

    // --- Check: usage limit ---
    if (coupon.max_uses > 0 && coupon.current_uses >= coupon.max_uses) {
      return res.json({
        valid: false,
        reason: 'Este cupom atingiu o limite de usos.',
      });
    }

    // --- Check: applicable to service ---
    const services = coupon.applicable_services || [];
    if (services.length > 0 && service_slug) {
      if (!services.includes(service_slug)) {
        return res.json({
          valid: false,
          reason: 'Este cupom não é válido para este serviço.',
        });
      }
    }

    // --- Calculate discount ---
    const originalPrice = parseFloat(price);
    const discountAmount = parseFloat(
      ((originalPrice * coupon.discount_percent) / 100).toFixed(2)
    );
    const finalPrice = parseFloat((originalPrice - discountAmount).toFixed(2));

    return res.json({
      valid: true,
      coupon: {
        code: coupon.code,
        discount_percent: coupon.discount_percent,
      },
      original_price: originalPrice,
      discount_amount: discountAmount,
      final_price: finalPrice,
    });
  } catch (err) {
    console.error('[Coupons] Error validating coupon:', err);
    return res.status(500).json({ valid: false, reason: 'Erro interno ao validar cupom.' });
  }
});

// ============================================================
// ADMIN ENDPOINT — Coupon Usage History
// ============================================================

/**
 * GET /api/admin/coupons/:id/uses — List usage history for a coupon.
 *
 * JOINs coupon_uses with orders to show who used the coupon and when.
 * Returns: { uses: [...] }
 */
couponRouter.get('/api/admin/coupons/:id/uses', async (req, res) => {
  try {
    const { id } = req.params;

    // Verify coupon exists
    const couponResult = await db.query(
      'SELECT id FROM coupons WHERE id = $1',
      [id]
    );

    if (couponResult.rows.length === 0) {
      return res.status(404).json({ error: 'Cupom não encontrado.' });
    }

    // Fetch usage history joined with orders
    const { rows } = await db.query(
      `SELECT
         cu.id AS use_id,
         cu.coupon_id,
         cu.order_id,
         cu.user_cpf,
         cu.original_price,
         cu.discount_amount,
         cu.final_price,
         cu.created_at AS used_at,
         o.service,
         o.status AS order_status,
         o.customer_name
       FROM coupon_uses cu
       LEFT JOIN orders o ON o.id = cu.order_id
       WHERE cu.coupon_id = $1
       ORDER BY cu.created_at DESC`,
      [id]
    );

    return res.json({ uses: rows });
  } catch (err) {
    console.error('[Coupons] Error fetching coupon uses:', err);
    return res.status(500).json({ error: 'Erro interno ao buscar usos do cupom.' });
  }
});
