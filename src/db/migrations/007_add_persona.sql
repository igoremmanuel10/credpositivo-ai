-- Add persona support for multi-agent (Augusto + Paulo SDR)
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS persona VARCHAR(50) DEFAULT 'augusto';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS bot_phone VARCHAR(20);

CREATE INDEX IF NOT EXISTS idx_conversations_persona ON conversations(persona);
