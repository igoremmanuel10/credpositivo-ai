-- Knowledge Base embeddings from Notion (RAG)
CREATE TABLE IF NOT EXISTS knowledge_embeddings (
  id SERIAL PRIMARY KEY,
  notion_page_id VARCHAR(64) NOT NULL,
  title TEXT NOT NULL,
  category VARCHAR(100),
  content_text TEXT NOT NULL,
  embedding vector(1536), -- OpenAI text-embedding-3-small dimension
  metadata JSONB DEFAULT '{}',
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  notion_last_edited TIMESTAMPTZ NOT NULL
);

-- Unique constraint: one embedding per Notion page
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_notion_page
  ON knowledge_embeddings(notion_page_id);

-- Index for similarity search (cosine distance)
CREATE INDEX IF NOT EXISTS idx_knowledge_vector
  ON knowledge_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);

-- Index for category filtering
CREATE INDEX IF NOT EXISTS idx_knowledge_category
  ON knowledge_embeddings(category);
