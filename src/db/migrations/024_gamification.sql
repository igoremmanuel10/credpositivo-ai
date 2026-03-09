CREATE TABLE IF NOT EXISTS user_gamification (
  id SERIAL PRIMARY KEY,
  cpf VARCHAR(14) UNIQUE NOT NULL,
  cp_total INTEGER DEFAULT 0,
  rating VARCHAR(10),
  score_estimado INTEGER,
  dividas_total INTEGER DEFAULT 0,
  dividas_quitadas INTEGER DEFAULT 0,
  nivel VARCHAR(50) DEFAULT 'Endividado',
  tarefas_completas JSONB DEFAULT '[]'::jsonb,
  diagnostico_completo BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_gamification_cpf ON user_gamification(cpf);
