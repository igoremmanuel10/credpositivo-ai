import { Router } from 'express';
import { db } from '../db/client.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

export const ratingFormRouter = Router();

// File upload config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = `/data/uploads/rating/${req.params.orderId}`;
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const fieldName = file.fieldname || 'file';
    cb(null, fieldName + '_' + Date.now() + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png', '.doc', '.docx', '.xls', '.xlsx'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Tipo de arquivo nao permitido'));
  }
});

// GET /api/rating-form/:orderId - Load form data
ratingFormRouter.get('/api/rating-form/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;

    // Check order exists and is Rating Bancario
    const { rows: orderRows } = await db.query(
      'SELECT id, service, status, user_id FROM orders WHERE id = $1',
      [orderId]
    );

    if (!orderRows[0]) {
      return res.status(404).json({ success: false, error: 'Pedido nao encontrado' });
    }

    // Get or create form
    let { rows } = await db.query(
      'SELECT * FROM rating_forms WHERE order_id = $1',
      [orderId]
    );

    if (rows.length === 0) {
      // Create new form
      const { rows: newRows } = await db.query(
        'INSERT INTO rating_forms (order_id, user_id) VALUES ($1, $2) RETURNING *',
        [orderId, orderRows[0].user_id]
      );
      rows = newRows;
    }

    res.json({ success: true, form: rows[0] });
  } catch (err) {
    console.error('[RatingForm] Load error:', err.message);
    res.status(500).json({ success: false, error: 'Erro ao carregar formulario' });
  }
});

// PUT /api/rating-form/:orderId/step/:step - Save step data
ratingFormRouter.put('/api/rating-form/:orderId/step/:step', async (req, res) => {
  try {
    const { orderId, step } = req.params;
    const stepNum = parseInt(step);
    const stepData = req.body;

    if (stepNum < 1 || stepNum > 7) {
      return res.status(400).json({ success: false, error: 'Etapa invalida' });
    }

    // Get current form
    let { rows } = await db.query(
      'SELECT * FROM rating_forms WHERE order_id = $1',
      [orderId]
    );

    if (rows.length === 0) {
      // Auto-create
      const { rows: orderRows } = await db.query('SELECT user_id FROM orders WHERE id = $1', [orderId]);
      const { rows: newRows } = await db.query(
        'INSERT INTO rating_forms (order_id, user_id) VALUES ($1, $2) RETURNING *',
        [orderId, orderRows[0]?.user_id]
      );
      rows = newRows;
    }

    const currentData = rows[0].data || {};
    const stepKey = 'step' + stepNum;
    currentData[stepKey] = stepData;

    // Determine new current_step (max of current and submitted+1)
    const newStep = Math.min(Math.max(rows[0].current_step, stepNum + 1), 8);
    const isCompleted = stepNum === 7;

    const { rows: updated } = await db.query(
      `UPDATE rating_forms
       SET data = $1, current_step = $2, completed = $3, updated_at = NOW()
       WHERE order_id = $4
       RETURNING *`,
      [JSON.stringify(currentData), newStep, isCompleted, orderId]
    );

    res.json({ success: true, form: updated[0] });
  } catch (err) {
    console.error('[RatingForm] Save error:', err.message);
    res.status(500).json({ success: false, error: 'Erro ao salvar etapa' });
  }
});

// POST /api/rating-form/:orderId/upload - Upload file
ratingFormRouter.post('/api/rating-form/:orderId/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Nenhum arquivo enviado' });
    }

    const { orderId } = req.params;
    const fieldName = req.body.field_name || 'file';
    const filePath = `/uploads/rating/${orderId}/${req.file.filename}`;

    // Save file reference in form data
    const { rows } = await db.query(
      'SELECT data FROM rating_forms WHERE order_id = $1',
      [orderId]
    );

    if (rows.length > 0) {
      const currentData = rows[0].data || {};
      if (!currentData.files) currentData.files = {};
      currentData.files[fieldName] = {
        path: filePath,
        originalName: req.file.originalname,
        size: req.file.size,
        uploadedAt: new Date().toISOString()
      };

      await db.query(
        'UPDATE rating_forms SET data = $1, updated_at = NOW() WHERE order_id = $2',
        [JSON.stringify(currentData), orderId]
      );
    }

    res.json({
      success: true,
      file: {
        path: filePath,
        originalName: req.file.originalname,
        size: req.file.size
      }
    });
  } catch (err) {
    console.error('[RatingForm] Upload error:', err.message);
    res.status(500).json({ success: false, error: 'Erro ao fazer upload' });
  }
});

// Serve uploaded files
ratingFormRouter.get('/uploads/rating/:orderId/:filename', (req, res) => {
  const filePath = `/data/uploads/rating/${req.params.orderId}/${req.params.filename}`;
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'Arquivo nao encontrado' });
  }
});
