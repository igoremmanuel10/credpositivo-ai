-- API cost tracking table
CREATE TABLE IF NOT EXISTS api_costs (
  id SERIAL PRIMARY KEY,
  provider VARCHAR(20) NOT NULL,          -- 'anthropic', 'openai'
  model VARCHAR(50) NOT NULL,             -- 'claude-haiku-4-5-20251001', 'gpt-4o-mini', etc.
  endpoint VARCHAR(20) NOT NULL,          -- 'chat', 'vision', 'tts', 'transcribe'
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_usd NUMERIC(10, 6) DEFAULT 0,
  phone VARCHAR(20),                      -- lead phone (nullable)
  duration_ms INTEGER,                    -- for audio calls
  created_at TIMESTAMP DEFAULT NOW()
);

-- Index for daily cost queries
CREATE INDEX IF NOT EXISTS idx_api_costs_date ON api_costs (created_at);
CREATE INDEX IF NOT EXISTS idx_api_costs_provider ON api_costs (provider, model);
