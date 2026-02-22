-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Store conversation embeddings for similarity search
CREATE TABLE IF NOT EXISTS conversation_embeddings (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  phase INTEGER,
  embedding vector(1536), -- OpenAI text-embedding-3-small dimension
  content_summary TEXT,
  outcome VARCHAR(50), -- 'purchased', 'opted_out', 'abandoned', 'progressed'
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for similarity search (cosine distance)
CREATE INDEX IF NOT EXISTS idx_embeddings_vector ON conversation_embeddings
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);
CREATE INDEX IF NOT EXISTS idx_embeddings_phase ON conversation_embeddings(phase);
CREATE INDEX IF NOT EXISTS idx_embeddings_outcome ON conversation_embeddings(outcome);
CREATE INDEX IF NOT EXISTS idx_embeddings_conversation ON conversation_embeddings(conversation_id);
