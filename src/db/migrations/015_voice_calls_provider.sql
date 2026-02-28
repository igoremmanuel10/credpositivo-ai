-- Add provider and call_mode columns to voice_calls table
-- Supports Vapi (PSTN/web) and Wavoip (WhatsApp) providers

ALTER TABLE voice_calls ADD COLUMN IF NOT EXISTS provider VARCHAR(20) DEFAULT 'vapi';
ALTER TABLE voice_calls ADD COLUMN IF NOT EXISTS call_mode VARCHAR(20) DEFAULT 'web';
ALTER TABLE voice_calls ADD COLUMN IF NOT EXISTS web_call_url TEXT;

CREATE INDEX IF NOT EXISTS idx_voice_calls_provider ON voice_calls(provider);
