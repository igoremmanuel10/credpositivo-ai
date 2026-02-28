-- Alex DevOps agent audit logs
CREATE TABLE IF NOT EXISTS alex_logs (
  id SERIAL PRIMARY KEY,
  cycle_id UUID NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) DEFAULT 'info',
  category VARCHAR(50),
  description TEXT NOT NULL,
  details JSONB,
  auto_fixed BOOLEAN DEFAULT false,
  fix_result TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alex_logs_cycle ON alex_logs(cycle_id);
CREATE INDEX IF NOT EXISTS idx_alex_logs_created ON alex_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_alex_logs_severity ON alex_logs(severity);
