-- Migration 005: Users and Managers tables for web platform
-- Replaces localStorage-based auth with PostgreSQL

-- Users table (clients)
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(255) NOT NULL,
    cpf VARCHAR(20) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    telefone VARCHAR(30),
    senha VARCHAR(255) NOT NULL,
    tipo VARCHAR(50) DEFAULT 'cliente',
    status VARCHAR(50) DEFAULT 'ativo',
    ativo BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Managers table (admin gerentes)
CREATE TABLE IF NOT EXISTS managers (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    senha VARCHAR(255) NOT NULL,
    tipo VARCHAR(50) DEFAULT 'Operacional',
    permissoes JSONB DEFAULT '{}',
    ativo BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add user_id FK to orders (nullable for backward compatibility with WhatsApp orders)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_cpf ON users(cpf);
CREATE INDEX IF NOT EXISTS idx_managers_email ON managers(email);
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
