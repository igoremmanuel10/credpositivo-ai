-- Voice Calls table for Vapi.ai integration
-- Tracks all outbound voice call attempts, statuses, and outcomes.
-- Fernando Dev - CredPositivo

CREATE TABLE IF NOT EXISTS voice_calls (
  id SERIAL PRIMARY KEY,
  phone VARCHAR(20) NOT NULL,
  event_type VARCHAR(50) NOT NULL,              -- purchase_abandoned, diagnosis_completed
  status VARCHAR(30) DEFAULT 'initiated',       -- initiated, queued, ringing, in_progress, ended, failed
  vapi_call_id VARCHAR(100),                    -- Vapi.ai call ID
  duration_seconds INTEGER,                     -- Call duration in seconds
  ended_reason VARCHAR(100),                    -- Why the call ended (customer-did-not-answer, etc)
  transcript TEXT,                              -- Full call transcript
  call_summary VARCHAR(500),                    -- Brief summary of the call
  cost DECIMAL(10, 4),                          -- Call cost in USD
  error_message TEXT,                           -- Error message if call failed
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_voice_calls_phone ON voice_calls(phone);
CREATE INDEX IF NOT EXISTS idx_voice_calls_vapi_id ON voice_calls(vapi_call_id);
CREATE INDEX IF NOT EXISTS idx_voice_calls_status ON voice_calls(status);
CREATE INDEX IF NOT EXISTS idx_voice_calls_created ON voice_calls(created_at);
