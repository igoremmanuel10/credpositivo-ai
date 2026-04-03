CREATE TABLE IF NOT EXISTS quiz_leads (
  id          SERIAL PRIMARY KEY,
  nome        TEXT NOT NULL,
  whatsapp    TEXT NOT NULL,
  email       TEXT NOT NULL,
  cpf         TEXT,
  score       INTEGER,
  level       TEXT,
  nivel       TEXT,
  variant     TEXT,
  situacao    TEXT,
  valor       TEXT,
  onde        JSONB    DEFAULT '[]',
  urgencia    TEXT,
  tentativa   TEXT,
  source      TEXT     DEFAULT 'quiz_credpositivo',
  utm         JSONB    DEFAULT '{}',
  url         TEXT,
  funnel_enqueued BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quiz_leads_email      ON quiz_leads(email);
CREATE INDEX IF NOT EXISTS idx_quiz_leads_whatsapp   ON quiz_leads(whatsapp);
CREATE INDEX IF NOT EXISTS idx_quiz_leads_created_at ON quiz_leads(created_at);
