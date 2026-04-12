ALTER TABLE quiz_leads
  ADD COLUMN IF NOT EXISTS wa_dispatch_status  TEXT        DEFAULT 'novo',
  ADD COLUMN IF NOT EXISTS wa_dispatch_last_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS wa_dispatch_count   INTEGER     DEFAULT 0,
  ADD COLUMN IF NOT EXISTS wa_dispatch_error   TEXT;

CREATE INDEX IF NOT EXISTS idx_quiz_leads_wa_dispatch_status
  ON quiz_leads(wa_dispatch_status);
