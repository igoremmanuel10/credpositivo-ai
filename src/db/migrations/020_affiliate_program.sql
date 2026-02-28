-- Migration 020: Programa de Afiliados CredPositivo
-- Tabelas para sistema completo de afiliados com tiers, comissoes N1/N2, saques e badges

-- 1. Tabela principal de afiliados
CREATE TABLE IF NOT EXISTS affiliates (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ref_code VARCHAR(20) UNIQUE NOT NULL,
  tier VARCHAR(20) DEFAULT 'starter' CHECK (tier IN ('starter', 'bronze', 'prata', 'ouro')),
  upline_id INTEGER REFERENCES affiliates(id) ON DELETE SET NULL,
  faturamento_acumulado NUMERIC(12,2) DEFAULT 0,
  saldo_disponivel NUMERIC(12,2) DEFAULT 0,
  saldo_pendente NUMERIC(12,2) DEFAULT 0,
  total_vendas_n1 INTEGER DEFAULT 0,
  total_vendas_n2 INTEGER DEFAULT 0,
  creditos_agente INTEGER DEFAULT 0,
  creditos_reset_dia INTEGER DEFAULT 1,
  tipo_pix VARCHAR(20),
  chave_pix VARCHAR(255),
  ouro_ativo BOOLEAN DEFAULT false,
  ouro_ativo_ate TIMESTAMPTZ,
  ouro_subscription_id VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_affiliates_user_id ON affiliates(user_id);
CREATE INDEX IF NOT EXISTS idx_affiliates_ref_code ON affiliates(ref_code);
CREATE INDEX IF NOT EXISTS idx_affiliates_upline ON affiliates(upline_id);
CREATE INDEX IF NOT EXISTS idx_affiliates_tier ON affiliates(tier);

-- 2. Comissoes geradas
CREATE TABLE IF NOT EXISTS affiliate_commissions (
  id SERIAL PRIMARY KEY,
  affiliate_id INTEGER NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  nivel INTEGER NOT NULL CHECK (nivel IN (1, 2)),
  tipo VARCHAR(30) NOT NULL CHECK (tipo IN ('venda', 'mensalidade', 'recarga')),
  order_id INTEGER,
  produto VARCHAR(255),
  valor_venda NUMERIC(12,2) NOT NULL,
  comissao_percent NUMERIC(5,2) NOT NULL,
  valor_comissao NUMERIC(12,2) NOT NULL,
  status VARCHAR(20) DEFAULT 'pendente' CHECK (status IN ('pendente', 'disponivel', 'sacado')),
  disponivel_em TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aff_commissions_affiliate ON affiliate_commissions(affiliate_id);
CREATE INDEX IF NOT EXISTS idx_aff_commissions_status ON affiliate_commissions(status);
CREATE INDEX IF NOT EXISTS idx_aff_commissions_disponivel ON affiliate_commissions(disponivel_em);

-- 3. Saques
CREATE TABLE IF NOT EXISTS affiliate_withdrawals (
  id SERIAL PRIMARY KEY,
  affiliate_id INTEGER NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  valor NUMERIC(12,2) NOT NULL,
  tipo_pix VARCHAR(20),
  chave_pix VARCHAR(255),
  status VARCHAR(20) DEFAULT 'pendente' CHECK (status IN ('pendente', 'processando', 'pago', 'recusado')),
  pago_em TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aff_withdrawals_affiliate ON affiliate_withdrawals(affiliate_id);
CREATE INDEX IF NOT EXISTS idx_aff_withdrawals_status ON affiliate_withdrawals(status);

-- 4. Badges/Plaquinhas
CREATE TABLE IF NOT EXISTS affiliate_badges (
  id SERIAL PRIMARY KEY,
  affiliate_id INTEGER NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  badge_type VARCHAR(50) NOT NULL,
  unlocked_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_aff_badges_unique ON affiliate_badges(affiliate_id, badge_type);

-- 5. Progresso do curso
CREATE TABLE IF NOT EXISTS affiliate_course_progress (
  id SERIAL PRIMARY KEY,
  affiliate_id INTEGER NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  module_id INTEGER NOT NULL,
  completed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_aff_course_unique ON affiliate_course_progress(affiliate_id, module_id);

-- 6. Materiais
CREATE TABLE IF NOT EXISTS affiliate_materials (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  file_url VARCHAR(500),
  category VARCHAR(50) DEFAULT 'geral',
  min_tier VARCHAR(20) DEFAULT 'starter' CHECK (min_tier IN ('starter', 'bronze', 'prata', 'ouro')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Recargas de creditos do agente IA
CREATE TABLE IF NOT EXISTS affiliate_credit_recharges (
  id SERIAL PRIMARY KEY,
  affiliate_id INTEGER NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  pacote VARCHAR(20) NOT NULL,
  creditos INTEGER NOT NULL,
  valor NUMERIC(12,2) NOT NULL,
  order_id INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aff_recharges_affiliate ON affiliate_credit_recharges(affiliate_id);

-- Adicionar campo referral na tabela users para rastrear quem indicou
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by_code VARCHAR(20);
CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by_code);
