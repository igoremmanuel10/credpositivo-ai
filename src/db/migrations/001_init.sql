-- CredPositivo Agent Database Schema

CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  phone VARCHAR(20) UNIQUE NOT NULL,
  name VARCHAR(255),
  phase INTEGER DEFAULT 0,
  price_counter INTEGER DEFAULT 0,
  link_counter INTEGER DEFAULT 0,
  ebook_sent BOOLEAN DEFAULT FALSE,
  user_profile JSONB DEFAULT '{}',
  recommended_product VARCHAR(50),
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  role VARCHAR(10) NOT NULL CHECK (role IN ('user', 'agent')),
  content TEXT NOT NULL,
  phase INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS followups (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  event_type VARCHAR(50) NOT NULL,
  attempt INTEGER DEFAULT 1,
  scheduled_at TIMESTAMPTZ NOT NULL,
  sent BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversations_phone ON conversations(phone);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_followups_pending ON followups(sent, scheduled_at) WHERE sent = FALSE;

-- Also create the evolution database if it doesn't exist
-- (handled by docker-compose postgres init)
