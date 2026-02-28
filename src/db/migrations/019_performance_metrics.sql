-- Migration 019: Performance metrics for agent analysis
-- Adds message_type tracking, response time calculation, and lead health scoring

-- Track message types (text, audio, video, image, document, social_proof)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_type VARCHAR(20) DEFAULT 'text';

-- Track response time in seconds (for agent messages: time since last user message)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS response_time_seconds INTEGER;

-- Lead health score (0-100, calculated periodically)
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS lead_health_score INTEGER DEFAULT 50;

-- Last health score update
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS health_score_updated_at TIMESTAMPTZ;

-- Index for performance queries
CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(message_type);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_conversations_health ON conversations(lead_health_score);
CREATE INDEX IF NOT EXISTS idx_conversations_last_message ON conversations(last_message_at);
CREATE INDEX IF NOT EXISTS idx_messages_role_conv ON messages(conversation_id, role, created_at);

-- Backfill response_time_seconds for existing agent messages
UPDATE messages m_agent
SET response_time_seconds = EXTRACT(EPOCH FROM (m_agent.created_at - prev_user.last_user_at))::INTEGER
FROM (
  SELECT m.id as agent_msg_id,
    (SELECT MAX(m2.created_at) FROM messages m2
     WHERE m2.conversation_id = m.conversation_id
       AND m2.role = 'user'
       AND m2.created_at < m.created_at) as last_user_at
  FROM messages m
  WHERE m.role = 'agent' AND m.response_time_seconds IS NULL
) prev_user
WHERE m_agent.id = prev_user.agent_msg_id
  AND prev_user.last_user_at IS NOT NULL;

-- Backfill message_type based on content patterns
UPDATE messages SET message_type = 'audio'
WHERE message_type = 'text'
  AND (content ILIKE '%[audio]%' OR content ILIKE '%audio enviado%' OR content ILIKE '%gravei esse audio%');
