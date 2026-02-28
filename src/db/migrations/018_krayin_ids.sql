-- Add Krayin CRM IDs to conversations table
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS krayin_person_id INTEGER;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS krayin_lead_id INTEGER;
