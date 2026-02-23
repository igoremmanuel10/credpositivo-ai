-- 017_agenda.sql - Group events / agenda system for ADM group

CREATE TABLE IF NOT EXISTS group_events (
  id SERIAL PRIMARY KEY,
  group_jid VARCHAR(100) NOT NULL,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  scheduled_at TIMESTAMPTZ NOT NULL,
  created_by_name VARCHAR(255),
  created_by_phone VARCHAR(50),
  attendees JSONB DEFAULT '[]',
  reminder_sent BOOLEAN DEFAULT FALSE,
  daily_notified BOOLEAN DEFAULT FALSE,
  cancelled BOOLEAN DEFAULT FALSE,
  message_id VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_group_events_scheduled
  ON group_events (group_jid, scheduled_at)
  WHERE cancelled = FALSE;

CREATE INDEX IF NOT EXISTS idx_group_events_reminder
  ON group_events (scheduled_at, reminder_sent)
  WHERE cancelled = FALSE AND reminder_sent = FALSE;
