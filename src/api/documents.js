import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { join, extname } from 'path';
import { unlink } from 'fs/promises';
import { db } from '../db/client.js';

const router = Router();

const UPLOAD_DIR = '/data/uploads/';

// Multer config
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = extname(file.originalname);
    cb(null, `${randomUUID()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'image/jpeg', 'image/png', 'image/webp',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo de arquivo não permitido. Use PDF, JPG, PNG ou DOC.'));
    }
  }
});

// Upload document
router.post('/api/documents', upload.single('file'), async (req, res) => {
  try {
    const { user_id, tipo, nome } = req.body;
    if (!user_id || !req.file) {
      return res.status(400).json({ error: 'user_id e arquivo são obrigatórios' });
    }

    const result = await db.query(
      `INSERT INTO documents (user_id, nome, tipo, filename, original_name, size, mime_type, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'upload')
       RETURNING *`,
      [
        user_id,
        nome || req.file.originalname,
        tipo || 'outro',
        req.file.filename,
        req.file.originalname,
        req.file.size,
        req.file.mimetype
      ]
    );

    res.json({ success: true, document: result.rows[0] });
  } catch (err) {
    console.error('[Documents] Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// List user documents
router.get('/api/documents', async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id é obrigatório' });

    const result = await db.query(
      `SELECT id, nome, tipo, original_name, size, mime_type, source, order_id, created_at
       FROM documents
       WHERE user_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC`,
      [user_id]
    );

    res.json({ documents: result.rows });
  } catch (err) {
    console.error('[Documents] List error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete document (soft delete + remove file)
router.delete('/api/documents/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id é obrigatório' });

    const doc = await db.query(
      'SELECT * FROM documents WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
      [id, user_id]
    );

    if (doc.rows.length === 0) {
      return res.status(404).json({ error: 'Documento não encontrado' });
    }

    await db.query('UPDATE documents SET deleted_at = NOW() WHERE id = $1', [id]);

    try {
      await unlink(join(UPLOAD_DIR, doc.rows[0].filename));
    } catch (e) { /* file may be gone */ }

    res.json({ success: true });
  } catch (err) {
    console.error('[Documents] Delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Serve document file
router.get('/api/documents/:id/file', async (req, res) => {
  try {
    const { id } = req.params;
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id é obrigatório' });

    const doc = await db.query(
      'SELECT * FROM documents WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
      [id, user_id]
    );

    if (doc.rows.length === 0) {
      return res.status(404).json({ error: 'Documento não encontrado' });
    }

    const filePath = join(UPLOAD_DIR, doc.rows[0].filename);
    const disposition = req.query.download ? 'attachment' : 'inline';
    const safeName = String(doc.rows[0].original_name).replace(/"/g, '');
    res.setHeader('Content-Type', doc.rows[0].mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `${disposition}; filename="${safeName}"`);
    res.sendFile(filePath);
  } catch (err) {
    console.error('[Documents] Serve error:', err);
    res.status(500).json({ error: err.message });
  }
});

export const documentsRouter = router;
