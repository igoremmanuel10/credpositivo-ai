-- Migration 002: Delivery tracking
-- Adds remoteJid storage, Evolution message ID tracking, and ACK persistence

-- Store the raw remoteJid so we never reconstruct it
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS remote_jid VARCHAR(100);

-- Store Evolution message IDs on agent messages for ACK correlation
ALTER TABLE messages ADD COLUMN IF NOT EXISTS evolution_ids JSONB;

-- ACK tracking table — one row per sent message, updated by messages.update webhook
CREATE TABLE IF NOT EXISTS message_acks (
  id SERIAL PRIMARY KEY,
  evolution_msg_id VARCHAR(100) UNIQUE NOT NULL,
  remote_jid VARCHAR(100) NOT NULL,
  ack INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ACK values:
--   0 = ERROR / PENDING
--   1 = SERVER_ACK (sent to WhatsApp server)
--   2 = DELIVERY_ACK (delivered to device)
--   3 = READ (read by recipient)
--   4 = PLAYED (audio messages)

CREATE INDEX IF NOT EXISTS idx_message_acks_evolution_id ON message_acks(evolution_msg_id);
CREATE INDEX IF NOT EXISTS idx_message_acks_pending ON message_acks(ack) WHERE ack < 2;
