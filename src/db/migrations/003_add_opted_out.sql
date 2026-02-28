-- Add opted_out flag to conversations
-- Allows leads to opt out of all automated messages

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS opted_out BOOLEAN DEFAULT FALSE;

-- Add remote_jid column if not exists (used for follow-ups)
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS remote_jid VARCHAR(100);
