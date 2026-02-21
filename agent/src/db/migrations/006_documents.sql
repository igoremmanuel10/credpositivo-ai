-- Migration 006: Documents table for user file uploads
CREATE TABLE IF NOT EXISTS documents (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nome VARCHAR(255) NOT NULL,
  tipo VARCHAR(50) NOT NULL DEFAULT 'outro',
  filename VARCHAR(255) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  mime_type VARCHAR(100),
  source VARCHAR(20) NOT NULL DEFAULT 'upload',
  order_id INTEGER,
  created_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_documents_user_id ON documents(user_id);
CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source);
