-- Payment integration: orders + diagnosticos

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  cpf VARCHAR(14) NOT NULL,
  customer_name VARCHAR(255),
  customer_email VARCHAR(255),
  service VARCHAR(100) NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  status VARCHAR(50) DEFAULT 'pending',
  mp_preference_id VARCHAR(255),
  mp_payment_id VARCHAR(255),
  mp_status VARCHAR(50),
  diagnostico_id INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS diagnosticos (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id),
  cpf VARCHAR(14) NOT NULL,
  apiful_response JSONB,
  pdf_path VARCHAR(500),
  status VARCHAR(50) DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_cpf ON orders(cpf);
CREATE INDEX IF NOT EXISTS idx_orders_mp_preference ON orders(mp_preference_id);
CREATE INDEX IF NOT EXISTS idx_orders_mp_payment ON orders(mp_payment_id);
CREATE INDEX IF NOT EXISTS idx_diagnosticos_order ON diagnosticos(order_id);
CREATE INDEX IF NOT EXISTS idx_diagnosticos_cpf ON diagnosticos(cpf);
