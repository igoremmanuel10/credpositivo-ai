-- Expense tracker for Financeiro | Grupo (CredPositivo)
-- Tracks partner expenses posted in WhatsApp group 120363407635437895@g.us

CREATE TABLE IF NOT EXISTS expenses (
  id              SERIAL PRIMARY KEY,
  group_jid       VARCHAR(100) NOT NULL,           -- WhatsApp group JID, e.g. 120363407635437895@g.us
  partner_name    VARCHAR(100) NOT NULL,           -- 'Igor Emmanuel', 'Igor Arcanjo', 'Raimundo'
  partner_phone   VARCHAR(30),                     -- normalized phone that sent the message
  amount          DECIMAL(12, 2) NOT NULL,         -- expense amount in BRL
  description     TEXT NOT NULL,                   -- what was purchased / paid for
  category        VARCHAR(80),                     -- e.g. 'marketing', 'infra', 'ferramenta', 'outro'
  receipt_url     TEXT,                            -- URL or base64 reference of comprovante image
  message_id      VARCHAR(255),                    -- Quepasa message ID (for deduplication)
  raw_text        TEXT,                            -- original message text for audit
  extraction_confidence VARCHAR(10) DEFAULT 'high', -- 'high' | 'medium' | 'low'
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  expense_date    DATE DEFAULT CURRENT_DATE        -- date the expense actually occurred
);

-- Prevent duplicate processing of the same WhatsApp message
CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_message_id
  ON expenses (message_id)
  WHERE message_id IS NOT NULL;

-- Fast lookups for summaries
CREATE INDEX IF NOT EXISTS idx_expenses_group_jid   ON expenses (group_jid);
CREATE INDEX IF NOT EXISTS idx_expenses_partner      ON expenses (partner_name);
CREATE INDEX IF NOT EXISTS idx_expenses_date         ON expenses (expense_date);
CREATE INDEX IF NOT EXISTS idx_expenses_created_at   ON expenses (created_at);
