-- Migration 009: TTS audio support + enhanced follow-up tracking
-- Adds columns for tracking audio sends and follow-up metadata

BEGIN;

-- Add recommended_product to conversations (if not exists — some rows may already have it from code)
-- Already exists from 001_init.sql, just ensuring index
CREATE INDEX IF NOT EXISTS idx_conversations_recommended_product ON conversations(recommended_product) WHERE recommended_product IS NOT NULL;

-- Add index for follow-up scheduling efficiency
CREATE INDEX IF NOT EXISTS idx_followups_conversation_event ON followups(conversation_id, event_type) WHERE sent = FALSE;

-- Add attempt tracking to followups (already has attempt column from 001_init.sql)
-- Just ensure it has a reasonable default
ALTER TABLE followups ALTER COLUMN attempt SET DEFAULT 1;

COMMIT;
