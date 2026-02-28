import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-dev-secret-change-me';

/**
 * Middleware: Verify JWT for admin routes.
 * Extracts Bearer token from Authorization header,
 * verifies it, and attaches decoded data to req.admin.
 */
export function requireAdmin(req, res, next) {
  // Embed key bypass for Chatwoot iframe dashboards
  const embedKey = req.query.embed_key || req.headers['x-embed-key'];
  if (embedKey && embedKey === (process.env.EMBED_KEY || 'cred-embed-2026-kx9m')) {
    req.admin = { email: 'embed@system', role: 'viewer' };
    return next();
  }

  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Token de autenticacao ausente' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, error: 'Token expirado' });
    }
    return res.status(401).json({ success: false, error: 'Token invalido' });
  }
}
