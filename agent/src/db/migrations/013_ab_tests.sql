-- A/B Testing tables for prompt variant experiments

CREATE TABLE IF NOT EXISTS ab_tests (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  target VARCHAR(50) NOT NULL,  -- prompt section: greeting, investigation, education, closing, sdr_greeting, sdr_objection
  persona VARCHAR(20) DEFAULT 'augusto',  -- augusto, paulo, both
  variants JSONB NOT NULL DEFAULT '[]',  -- [{"name":"control","weight":50,"prompt_override":"..."}, {"name":"treatment","weight":50,"prompt_override":"..."}]
  active BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  ended_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ab_assignments (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  test_id INTEGER NOT NULL REFERENCES ab_tests(id),
  variant VARCHAR(100) NOT NULL,
  assigned_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(conversation_id, test_id)
);

CREATE INDEX IF NOT EXISTS idx_ab_assignments_test ON ab_assignments(test_id);
CREATE INDEX IF NOT EXISTS idx_ab_assignments_conv ON ab_assignments(conversation_id);
CREATE INDEX IF NOT EXISTS idx_ab_tests_active ON ab_tests(active) WHERE active = true;
