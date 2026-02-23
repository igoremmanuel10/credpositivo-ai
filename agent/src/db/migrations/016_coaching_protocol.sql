-- Coaching Protocol tracking for "Igor Emmanuel - Mudanca de Vida" group
-- Tracks MC (morning), NC (night), RS (weekly review), RM (monthly review)

CREATE TABLE IF NOT EXISTS coaching_entries (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL,
  type VARCHAR(4) NOT NULL CHECK (type IN ('mc', 'nc', 'rs', 'rm')),
  sent_at TIMESTAMPTZ,
  responded_at TIMESTAMPTZ,
  response_text TEXT,
  agent_reply TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (date, type)
);

-- Index for quick lookups by date and type
CREATE INDEX IF NOT EXISTS idx_coaching_date_type ON coaching_entries (date, type);

-- Track recurring night patterns (question 3) — one per day
CREATE TABLE IF NOT EXISTS coaching_patterns (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL UNIQUE,
  pattern_text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
