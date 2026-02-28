-- Migration 021: Manager reports history (Luan)
CREATE TABLE IF NOT EXISTS manager_reports (
  id SERIAL PRIMARY KEY,
  report_type VARCHAR(20) NOT NULL,
  period_days INTEGER DEFAULT 7,
  metrics JSONB NOT NULL,
  recommendations TEXT,
  report_text TEXT NOT NULL,
  pipeline_health VARCHAR(20),
  priority VARCHAR(30),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_manager_reports_type ON manager_reports(report_type);
CREATE INDEX IF NOT EXISTS idx_manager_reports_created ON manager_reports(created_at);
