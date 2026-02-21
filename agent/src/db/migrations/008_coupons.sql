-- Migration 008: Coupon system
-- Creates coupons and coupon_uses tables, and adds coupon columns to orders

BEGIN;

-- =============================================================================
-- 1. Coupons table
-- =============================================================================
CREATE TABLE IF NOT EXISTS coupons (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) NOT NULL UNIQUE,
    discount_percent NUMERIC(5,2) NOT NULL CHECK (discount_percent > 0 AND discount_percent <= 100),
    max_uses INTEGER NOT NULL DEFAULT 0, -- 0 = unlimited
    current_uses INTEGER NOT NULL DEFAULT 0,
    applicable_services JSONB DEFAULT '[]', -- empty array = all services
    active BOOLEAN NOT NULL DEFAULT true,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- 2. Coupon uses table
-- =============================================================================
CREATE TABLE IF NOT EXISTS coupon_uses (
    id SERIAL PRIMARY KEY,
    coupon_id INTEGER NOT NULL REFERENCES coupons(id),
    order_id INTEGER REFERENCES orders(id),
    user_cpf VARCHAR(20),
    original_price NUMERIC(10,2),
    discount_amount NUMERIC(10,2),
    final_price NUMERIC(10,2),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- 3. Indexes
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_coupons_code ON coupons(code);
CREATE INDEX IF NOT EXISTS idx_coupon_uses_coupon_id ON coupon_uses(coupon_id);

-- =============================================================================
-- 4. Add coupon columns to orders table
-- =============================================================================
ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_id INTEGER REFERENCES coupons(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10,2) DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS original_price NUMERIC(10,2);

COMMIT;
