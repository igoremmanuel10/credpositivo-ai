import { Router } from 'express';
import { createReadStream, existsSync } from 'fs';
import { db } from '../db/client.js';
import { createCheckout, getPayment } from './mercadopago.js';
import { handleFollowup } from '../conversation/manager.js';
import { handleVoiceCallTrigger } from '../voice/call-handler.js';
import { normalizePhone } from '../utils/phone.js';

export const paymentRouter = Router();

// ============================================
// POST /api/checkout — Create MP checkout
// ============================================
paymentRouter.post('/api/checkout', async (req, res) => {
  try {
    const { cpf, name, email, phone, service, price, user_id, coupon_code, original_price } = req.body;

    if (!cpf || !service || !price) {
      return res.status(400).json({ error: 'cpf, service and price are required' });
    }

    const cleanCpf = cpf.replace(/[^0-9]/g, '');
    let finalPrice = parseFloat(price);
    let couponId = null;
    let discountAmount = 0;
    let origPrice = original_price ? parseFloat(original_price) : finalPrice;

    // Validate and apply coupon if provided
    if (coupon_code) {
      const couponResult = await db.query(
        "SELECT * FROM coupons WHERE UPPER(TRIM(code)) = $1 AND active = true",
        [coupon_code.trim().toUpperCase()]
      );
      const coupon = couponResult.rows[0];
      if (coupon) {
        const expired = coupon.expires_at && new Date(coupon.expires_at) <= new Date();
        const limitReached = coupon.max_uses > 0 && coupon.current_uses >= coupon.max_uses;
        if (!expired && !limitReached) {
          couponId = coupon.id;
          discountAmount = parseFloat(((origPrice * coupon.discount_percent) / 100).toFixed(2));
          finalPrice = parseFloat((origPrice - discountAmount).toFixed(2));
          if (finalPrice < 0) finalPrice = 0;
          console.log(`[Checkout] Coupon ${coupon.code} applied: ${coupon.discount_percent}% off, R${origPrice} -> R${finalPrice}`);
        } else {
          console.log(`[Checkout] Coupon ${coupon_code} invalid (expired=${expired}, limitReached=${limitReached})`);
        }
      }
    }

    const existing = await db.query(
      `SELECT * FROM orders WHERE cpf = $1 AND service = $2 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
      [cleanCpf, service]
    );

    let order;

    if (existing.rows.length > 0 && !couponId) {
      order = existing.rows[0];
      console.log(`[Checkout] Reusing existing order #${order.id} for CPF ${cleanCpf.substring(0, 3)}*** — ${service}`);
    } else {
      const { rows } = await db.query(
        `INSERT INTO orders (cpf, customer_name, customer_email, customer_phone, service, price, status, user_id, coupon_id, discount_amount, original_price)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9, $10)
         RETURNING *`,
        [cleanCpf, name || '', email || '', phone || '', service, finalPrice, user_id || null, couponId, discountAmount, origPrice]
      );
      order = rows[0];
      console.log(`[Checkout] New order #${order.id} for CPF ${cleanCpf.substring(0, 3)}*** — ${service} R${finalPrice}${couponId ? ' (coupon applied)' : ''}`);
    }

    const checkout = await createCheckout({ cpf: cleanCpf, name, email, service, price: finalPrice });

    await db.query(
      `UPDATE orders SET mp_preference_id = $1, checkout_url = $2, customer_name = COALESCE(NULLIF($3, ''), customer_name), customer_email = COALESCE(NULLIF($4, ''), customer_email), customer_phone = COALESCE(NULLIF($5, ''), customer_phone), user_id = COALESCE($6, user_id), updated_at = NOW() WHERE id = $7`,
      [checkout.preferenceId, checkout.initPoint, name || '', email || '', phone || '', user_id || null, order.id]
    );

    // Record coupon usage
    if (couponId) {
      await db.query("UPDATE coupons SET current_uses = current_uses + 1, updated_at = NOW() WHERE id = $1", [couponId]);
      await db.query(
        "INSERT INTO coupon_uses (coupon_id, order_id, user_cpf, original_price, discount_amount, final_price) VALUES ($1, $2, $3, $4, $5, $6)",
        [couponId, order.id, cleanCpf, origPrice, discountAmount, finalPrice]
      );
    }

    res.json({
      orderId: order.id,
      checkoutUrl: checkout.initPoint,
      preferenceId: checkout.preferenceId,
    });
  } catch (err) {
    console.error('[Checkout] Error:', err);
    res.status(500).json({ error: 'Failed to create checkout: ' + err.message });
  }
});

// ============================================
// POST /webhook/mercadopago — MP payment webhook
// ============================================
paymentRouter.post('/webhook/mercadopago', async (req, res) => {
  res.status(200).json({ status: 'received' });

  try {
    const { type, data, action } = req.body;
    console.log('[MP Webhook]', JSON.stringify(req.body).substring(0, 500));

    if (type !== 'payment' && action !== 'payment.created' && action !== 'payment.updated') {
      return;
    }

    const paymentId = data?.id;
    if (!paymentId) return;

    const payment = await getPayment(paymentId);
    const mpStatus = payment.status;
    const externalRef = payment.external_reference;
    const prefId = payment.preference_id;

    console.log(`[MP Webhook] Payment ${paymentId} status=${mpStatus} ref=${externalRef}`);

    let order;
    if (prefId) {
      const { rows } = await db.query(
        'SELECT * FROM orders WHERE mp_preference_id = $1',
        [prefId]
      );
      order = rows[0];
    }

    if (!order && externalRef) {
      const { rows } = await db.query(
        `SELECT * FROM orders WHERE cpf = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
        [externalRef.replace(/[^0-9]/g, '')]
      );
      order = rows[0];
    }

    if (!order) {
      console.log('[MP Webhook] No matching order found');
      return;
    }

    // Skip if this order already has a different payment linked (prevent duplicate matching)
    if (order.mp_payment_id && order.mp_payment_id !== String(paymentId)) {
      console.log(`[MP Webhook] Order #${order.id} already has payment ${order.mp_payment_id}, skipping`);
      return;
    }

    await db.query(
      `UPDATE orders SET mp_payment_id = $1, mp_status = $2, status = $3, updated_at = NOW() WHERE id = $4`,
      [String(paymentId), mpStatus, mpStatus === 'approved' ? 'paid' : mpStatus, order.id]
    );

    console.log(`[MP Webhook] Order #${order.id} updated to ${mpStatus}`);

    // If approved, handle credit top-ups automatically
    if (mpStatus === 'approved') {

      // === AUTO-TRIGGER: Notify WhatsApp about purchase ===
      if (order.customer_phone) {
        const phone = normalizePhone(order.customer_phone);
        if (phone) {
          try {
            const conv = await db.getConversation(phone);
            if (conv) {
              if (order.service) {
                await db.updateConversation(conv.id, { recommended_product: order.service });
                conv.recommended_product = order.service;
              }
              // Send audio confirmation via WhatsApp
              handleFollowup(conv, 'purchase_completed', true).catch(err => {
                console.error('[MP Webhook] purchase_completed trigger error:', err.message);
              });
              console.log('[MP Webhook] purchase_completed triggered for ' + phone);
            }
          } catch (err) {
            console.error('[MP Webhook] Failed to trigger purchase_completed:', err.message);
          }
        }
      }
      // === AFFILIATE COMMISSION HOOK ===
      try {
        const { processAffiliateCommission } = await import("../affiliate/routes.js");
        await processAffiliateCommission(order.id, order.cpf, order.service, parseFloat(order.price));
      } catch (affErr) {
        console.error("[MP Webhook] Affiliate commission error:", affErr.message);
      }

      // === OURO SUBSCRIPTION ACTIVATION ===
      if (order.service && order.service.includes("Ouro Afiliado")) {
        try {
          const { rows: affOuro } = await db.query(
            "SELECT id FROM affiliates WHERE user_id = (SELECT id FROM users WHERE cpf = $1)",
            [order.cpf]
          );
          if (affOuro[0]) {
            await db.query(
              "UPDATE affiliates SET ouro_ativo = true, tier = 'ouro', ouro_ativo_ate = NOW() + INTERVAL '30 days' WHERE id = $1",
              [affOuro[0].id]
            );
            console.log("[MP Webhook] Ouro activated for affiliate " + affOuro[0].id);
          }
        } catch (ouroErr) {
          console.error("[MP Webhook] Ouro activation error:", ouroErr.message);
        }
      }

      const serviceLower = order.service.toLowerCase();

      if (serviceLower === 'crédito' || serviceLower === 'credito') {
        try {
          await db.query(
            `UPDATE users SET saldo = COALESCE(saldo, 0) + $1, updated_at = NOW() WHERE cpf = $2`,
            [parseFloat(order.price), order.cpf]
          );
          await db.query(
            `UPDATE orders SET status = 'completed', updated_at = NOW() WHERE id = $1`,
            [order.id]
          );
          console.log(`[Credit] Added R$${order.price} to CPF ${order.cpf.substring(0, 3)}***`);
        } catch (creditErr) {
          console.error(`[Credit] Error for order #${order.id}:`, creditErr);
        }
      }
      // Diagnostico: do NOT auto-process. Wait for client to provide target CPF via /api/process-diagnostico
    }

    // If payment failed/rejected, trigger purchase_abandoned voice call
    if (['rejected', 'cancelled'].includes(mpStatus) && order.customer_phone) {
      const abanPhone = normalizePhone(order.customer_phone);
      if (abanPhone) {
        try {
          const abanConv = await db.getConversation(abanPhone);
          if (abanConv) {
            handleFollowup(abanConv, 'purchase_abandoned').catch(err => {
              console.error('[MP Webhook] purchase_abandoned trigger error:', err.message);
            });
            // Voice call after 30min
            setTimeout(() => {
              handleVoiceCallTrigger(abanPhone, 'purchase_abandoned', {
                produto: order.service || '',
                source: 'mercadopago_rejected',
              }, 'outbound').catch(err => {
                console.error('[MP Webhook] Voice call trigger error:', err.message);
              });
            }, 30 * 60 * 1000);
            console.log('[MP Webhook] purchase_abandoned + voice call scheduled for ' + abanPhone);
          }
        } catch (err) {
          console.error('[MP Webhook] purchase_abandoned trigger error:', err.message);
        }
      }
    }
  } catch (err) {
    console.error('[MP Webhook] Error:', err);
  }
});

// ============================================
// POST /api/process-diagnostico — Client provides CPF, creates pending diagnostico for admin
// ============================================
paymentRouter.post('/api/process-diagnostico', async (req, res) => {
  try {
    const { order_id, cpf } = req.body;

    if (!order_id || !cpf) {
      return res.status(400).json({ error: 'order_id and cpf are required' });
    }

    const cleanCpf = cpf.replace(/[^0-9]/g, '');
    if (cleanCpf.length !== 11) {
      return res.status(400).json({ error: 'CPF invalido' });
    }

    const { rows: orderRows } = await db.query('SELECT * FROM orders WHERE id = $1', [order_id]);
    const order = orderRows[0];

    if (!order) {
      return res.status(404).json({ error: 'Pedido nao encontrado' });
    }

    if (order.status !== 'paid' && order.status !== 'completed') {
      return res.status(400).json({ error: 'Pagamento ainda nao confirmado' });
    }

    // Check if already has a completed diagnostico
    if (order.diagnostico_id) {
      const { rows: diagRows } = await db.query('SELECT * FROM diagnosticos WHERE id = $1', [order.diagnostico_id]);
      if (diagRows[0] && diagRows[0].status === 'completed') {
        return res.json({ status: 'already_completed', diagnostico_id: order.diagnostico_id });
      }
      if (diagRows[0] && diagRows[0].status === 'awaiting_upload') {
        return res.json({ status: 'awaiting_upload', diagnostico_id: order.diagnostico_id, message: 'Diagnostico aguardando processamento pela equipe.' });
      }
      if (diagRows[0]) {
        await db.query('DELETE FROM diagnosticos WHERE id = $1', [order.diagnostico_id]);
      }
    }

    // Create diagnostico record - awaiting admin upload
    const { rows } = await db.query(
      `INSERT INTO diagnosticos (order_id, cpf, status) VALUES ($1, $2, 'awaiting_upload') RETURNING *`,
      [order.id, cleanCpf]
    );
    const diagnostico = rows[0];

    await db.query(
      'UPDATE orders SET diagnostico_id = $1, status = $2, updated_at = NOW() WHERE id = $3',
      [diagnostico.id, 'processing', order.id]
    );

    console.log(`[Diagnostico] Order #${order.id} CPF ${cleanCpf.substring(0, 3)}*** - awaiting admin upload`);

    res.json({ status: 'awaiting_upload', diagnostico_id: diagnostico.id, message: 'Diagnostico solicitado! Nossa equipe ira processar em breve.' });
  } catch (err) {
    console.error('[Process Diagnostico] Error:', err);
    res.status(500).json({ error: 'Erro ao processar diagnostico' });
  }
});

// ============================================
// GET /api/diagnostico-status/:id — Check diagnostico processing status
// ============================================
paymentRouter.get('/api/diagnostico-status/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid ID' });

    const { rows } = await db.query(
      'SELECT id, status, order_id FROM diagnosticos WHERE id = $1',
      [id]
    );

    if (!rows[0]) {
      return res.status(404).json({ error: 'Not found' });
    }

    res.json({ id: rows[0].id, status: rows[0].status });
  } catch (err) {
    res.status(500).json({ error: 'Failed to check status' });
  }
});

// ============================================
// GET /api/orders/:cpf — List orders by CPF
// ============================================
paymentRouter.get('/api/orders/:cpf', async (req, res) => {
  try {
    const cpf = req.params.cpf.replace(/[^0-9]/g, '');
    if (!cpf || cpf.length !== 11) {
      return res.status(400).json({ error: 'Invalid CPF' });
    }

    const { rows } = await db.query(
      `SELECT o.id, o.service, o.price, o.status, o.created_at, o.diagnostico_id, o.doc_tipo, o.doc_numero, o.nome_fantasia, o.observacoes, o.customer_name, o.cpf, o.customer_phone,
              d.status as diagnostico_status, d.pdf_path
       FROM orders o
       LEFT JOIN diagnosticos d ON d.id = o.diagnostico_id
       WHERE o.cpf = $1
       ORDER BY o.created_at DESC`,
      [cpf]
    );

    res.json({ orders: rows });
  } catch (err) {
    console.error('[Orders] Error:', err);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// ============================================
// GET /api/diagnostico/:id — Download PDF
// ============================================
paymentRouter.get('/api/diagnostico/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid ID' });

    const { rows } = await db.query(
      `SELECT * FROM diagnosticos WHERE id = $1 AND status = 'completed'`,
      [id]
    );

    if (!rows[0] || !rows[0].pdf_path) {
      return res.status(404).json({ error: 'Diagnostic not found or not ready' });
    }

    const pdfPath = rows[0].pdf_path;
    if (!existsSync(pdfPath)) {
      return res.status(404).json({ error: 'PDF file not found' });
    }

    const cpf = rows[0].cpf;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="diagnostico-${cpf.substring(0, 3)}xxx-${id}.pdf"`);
    createReadStream(pdfPath).pipe(res);
  } catch (err) {
    console.error('[Diagnostico Download] Error:', err);
    res.status(500).json({ error: 'Failed to download diagnostic' });
  }
});

// ============================================
// GET /api/balance/:cpf — Get user credit balance
// ============================================
paymentRouter.get("/api/balance/:cpf", async (req, res) => {
  try {
    const cpf = req.params.cpf.replace(/[^0-9]/g, "");
    if (!cpf || cpf.length !== 11) {
      return res.status(400).json({ error: "Invalid CPF" });
    }
    const { rows } = await db.query("SELECT saldo FROM users WHERE cpf = $1", [cpf]);
    if (!rows[0]) {
      return res.json({ saldo: 0 });
    }
    res.json({ saldo: parseFloat(rows[0].saldo) || 0 });
  } catch (err) {
    console.error("[Balance] Error:", err);
    res.status(500).json({ error: "Failed to fetch balance" });
  }
});

// ============================================
// GET /api/services — List active services (public)
// ============================================
paymentRouter.get("/api/services", async (req, res) => {
  try {
    const { rows } = await db.query(
      "SELECT id, slug, name, description, price, icon, color, required_fields, sort_order FROM services WHERE active = true ORDER BY sort_order"
    );
    res.json({ services: rows });
  } catch (err) {
    console.error("[Services] Error:", err);
    res.status(500).json({ error: "Failed to fetch services" });
  }
});

// ============================================
// PUT /api/admin/services — Update service prices (admin)
// ============================================
paymentRouter.put("/api/admin/services", async (req, res) => {
  try {
    const { services } = req.body;
    if (!services || !Array.isArray(services)) {
      return res.status(400).json({ error: "services array is required" });
    }

    const updated = [];
    for (const s of services) {
      if (!s.slug && !s.id) continue;
      const fields = [];
      const values = [];
      let idx = 1;

      if (s.price !== undefined) { fields.push("price = $" + idx); values.push(parseFloat(s.price)); idx++; }
      if (s.name !== undefined) { fields.push("name = $" + idx); values.push(s.name); idx++; }
      if (s.description !== undefined) { fields.push("description = $" + idx); values.push(s.description); idx++; }
      if (s.active !== undefined) { fields.push("active = $" + idx); values.push(s.active); idx++; }
      if (s.icon !== undefined) { fields.push("icon = $" + idx); values.push(s.icon); idx++; }
      if (s.required_fields !== undefined) { fields.push("required_fields = $" + idx); values.push(typeof s.required_fields === 'string' ? s.required_fields : JSON.stringify(s.required_fields)); idx++; }

      if (fields.length === 0) continue;
      fields.push("updated_at = NOW()");

      const where = s.id ? "id = $" + idx : "slug = $" + idx;
      values.push(s.id || s.slug);

      const { rows } = await db.query(
        "UPDATE services SET " + fields.join(", ") + " WHERE " + where + " RETURNING *",
        values
      );
      if (rows[0]) updated.push(rows[0]);
    }

    res.json({ updated });
  } catch (err) {
    console.error("[Admin Services] Error:", err);
    res.status(500).json({ error: "Failed to update services" });
  }
});

// ============================================
// POST /api/pay-with-credits — Pay for service using credit balance
// ============================================
paymentRouter.post("/api/pay-with-credits", async (req, res) => {
  try {
    const { cpf, service, price, user_id } = req.body;

    if (!cpf || !service || !price) {
      return res.status(400).json({ error: "cpf, service and price are required" });
    }

    const cleanCpf = cpf.replace(/[^0-9]/g, "");
    const amount = parseFloat(price);

    // Check user balance
    const { rows: userRows } = await db.query("SELECT id, saldo FROM users WHERE cpf = $1", [cleanCpf]);
    if (!userRows[0]) {
      return res.status(404).json({ error: "Usuário não encontrado" });
    }

    const currentBalance = parseFloat(userRows[0].saldo || 0);
    if (currentBalance < amount) {
      return res.status(400).json({ error: "Saldo insuficiente", saldo: currentBalance, required: amount });
    }

    // Deduct balance
    await db.query(
      "UPDATE users SET saldo = saldo - $1, updated_at = NOW() WHERE cpf = $2",
      [amount, cleanCpf]
    );

    // Create order as paid
    const { rows: orderRows } = await db.query(
      `INSERT INTO orders (cpf, customer_name, customer_email, service, price, status, user_id, mp_status)
       VALUES ($1, $2, $3, $4, $5, 'paid', $6, 'credit')
       RETURNING *`,
      [cleanCpf, req.body.name || "", req.body.email || "", service, amount, user_id || userRows[0].id]
    );

    const order = orderRows[0];
    console.log("[Credits] Order #" + order.id + " paid with credits R$" + amount + " for CPF " + cleanCpf.substring(0, 3) + "***");

    res.json({
      success: true,
      orderId: order.id,
      newBalance: currentBalance - amount,
      message: "Pagamento com créditos realizado com sucesso!"
    });
  } catch (err) {
    console.error("[Pay Credits] Error:", err);
    res.status(500).json({ error: "Erro ao processar pagamento com créditos" });
  }
});

// ============================================
// POST /api/retry-order/:id — Retry a failed order
// ============================================
paymentRouter.post('/api/retry-order/:id', async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    if (!orderId) return res.status(400).json({ error: 'Invalid order ID' });

    const { rows: orderRows } = await db.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    const order = orderRows[0];

    if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });
    if (order.status !== 'error') return res.status(400).json({ error: 'Pedido não está em estado de erro' });

    // Check retry count
    const retryCount = parseInt(order.retry_count || 0);
    if (retryCount >= 2) {
      const lastRetry = order.last_retry_at ? new Date(order.last_retry_at) : null;
      const now = new Date();
      if (lastRetry && (now - lastRetry) < 5 * 60 * 1000) {
        const waitMs = 5 * 60 * 1000 - (now - lastRetry);
        const waitMin = Math.ceil(waitMs / 60000);
        return res.status(429).json({
          error: 'Limite de tentativas atingido',
          message: 'Aguarde ' + waitMin + ' minuto(s) antes de tentar novamente.',
          wait_minutes: waitMin
        });
      }
      // Reset retry count after cooldown
      await db.query('UPDATE orders SET retry_count = 0 WHERE id = $1', [orderId]);
    }

    // Clean up old diagnostico if exists
    if (order.diagnostico_id) {
      await db.query('DELETE FROM diagnosticos WHERE id = $1 AND status = \'error\'', [order.diagnostico_id]);
    }

    // Reset order status to paid
    await db.query(
      'UPDATE orders SET status = \'paid\', diagnostico_id = NULL, retry_count = COALESCE(retry_count, 0) + 1, last_retry_at = NOW(), updated_at = NOW() WHERE id = $1',
      [orderId]
    );

    // Create new diagnostico
    const cpf = order.cpf;
    const { rows } = await db.query(
      'INSERT INTO diagnosticos (order_id, cpf, status) VALUES ($1, $2, \'processing\') RETURNING *',
      [orderId, cpf]
    );
    const diagnostico = rows[0];

    await db.query('UPDATE orders SET diagnostico_id = $1, updated_at = NOW() WHERE id = $2', [diagnostico.id, orderId]);

    console.log('[Retry] Order #' + orderId + ' retry attempt ' + (retryCount + 1) + ' for CPF ' + cpf.substring(0, 3) + '***');

    // Respond immediately
    res.json({ success: true, status: 'processing', diagnostico_id: diagnostico.id, retry_count: retryCount + 1 });

        // Set as awaiting admin upload (no auto-processing)
    console.log('[Retry] Order #' + orderId + ' reset to awaiting_upload');
  } catch (err) {
    console.error('[Retry] Error:', err);
    res.status(500).json({ error: 'Erro ao reprocessar pedido' });
  }
});


// ============================================
// Admin: Upload PDF for diagnostico
// ============================================
import multer from 'multer';
import { existsSync as fsExists, mkdirSync } from 'fs';

const DIAG_DIR = '/data/diagnosticos';
if (!fsExists(DIAG_DIR)) mkdirSync(DIAG_DIR, { recursive: true });

const diagUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, DIAG_DIR),
    filename: (req, file, cb) => {
      const ext = file.originalname.split('.').pop() || 'pdf';
      cb(null, `diagnostico-${req.params.id}-${Date.now()}.${ext}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Apenas arquivos PDF'));
  }
});

paymentRouter.post('/api/admin/upload-diagnostico/:id', diagUpload.single('pdf'), async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    if (!orderId) return res.status(400).json({ error: 'ID invalido' });

    if (!req.file) return res.status(400).json({ error: 'Arquivo PDF obrigatorio' });

    const { rows: orderRows } = await db.query(
      'SELECT o.*, d.id as diag_id, d.status as diag_status FROM orders o LEFT JOIN diagnosticos d ON d.id = o.diagnostico_id WHERE o.id = $1',
      [orderId]
    );
    const order = orderRows[0];
    if (!order) return res.status(404).json({ error: 'Pedido nao encontrado' });

    const pdfPath = req.file.path;
    let diagId = order.diag_id;

    if (diagId) {
      // Update existing diagnostico
      await db.query(
        "UPDATE diagnosticos SET pdf_path = $1, status = 'completed' WHERE id = $2",
        [pdfPath, diagId]
      );
    } else {
      // Create new diagnostico
      const { rows } = await db.query(
        "INSERT INTO diagnosticos (order_id, cpf, status, pdf_path) VALUES ($1, $2, 'completed', $3) RETURNING *",
        [orderId, order.cpf, pdfPath]
      );
      diagId = rows[0].id;
      await db.query('UPDATE orders SET diagnostico_id = $1 WHERE id = $2', [diagId, orderId]);
    }

    await db.query("UPDATE orders SET status = 'completed', updated_at = NOW() WHERE id = $1", [orderId]);

    console.log('[Admin Upload] PDF uploaded for order #' + orderId + ' -> ' + pdfPath);

    // === AUTO-TRIGGER: Notify WhatsApp about diagnosis completion ===
    if (order.customer_phone) {
      const diagPhone = normalizePhone(order.customer_phone);
      if (diagPhone) {
        try {
          const diagConv = await db.getConversation(diagPhone);
          if (diagConv) {
            handleFollowup(diagConv, 'diagnosis_completed', true).catch(err => {
              console.error('[Admin Upload] diagnosis_completed trigger error:', err.message);
            });
            console.log('[Admin Upload] diagnosis_completed triggered for ' + diagPhone);

            // Trigger outbound voice call for diagnosis (30min delay)
            setTimeout(() => {
              handleVoiceCallTrigger(diagPhone, 'diagnosis_completed', {
                complex: true,
                issues_count: 5,
                summary: 'Diagnostico de credito finalizado — resultado requer atencao',
              }, 'outbound').catch(err => {
                console.error('[Admin Upload] Voice call trigger error:', err.message);
              });
            }, 30 * 60 * 1000); // 30 min delay
            console.log('[Admin Upload] Voice call scheduled (30min) for ' + diagPhone);
          }
        } catch (err) {
          console.error('[Admin Upload] Failed to trigger diagnosis_completed:', err.message);
        }
      }
    }

    res.json({ success: true, diagnostico_id: diagId, message: 'PDF enviado com sucesso!' });
  } catch (err) {
    console.error('[Admin Upload] Error:', err);
    res.status(500).json({ error: 'Erro ao fazer upload' });
  }
});

// GET /api/admin/pending-diagnosticos — List orders awaiting PDF upload
paymentRouter.get('/api/admin/pending-diagnosticos', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT o.id, o.cpf, o.customer_name, o.service, o.price, o.status, o.created_at,
             d.id as diagnostico_id, d.status as diagnostico_status, d.cpf as diag_cpf
      FROM orders o
      LEFT JOIN diagnosticos d ON d.id = o.diagnostico_id
      WHERE (o.status = 'processing' OR o.status = 'error')
        AND o.service ILIKE '%diagn%'
      ORDER BY o.created_at DESC
    `);
    res.json({ success: true, orders: rows });
  } catch (err) {
    console.error('[Pending Diagnosticos] Error:', err);
    res.status(500).json({ error: 'Erro ao buscar diagnosticos pendentes' });
  }
});
