import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export interface KnowledgeDocument {
  id?: number;
  title: string;
  description?: string;
  document_type: 'regulation' | 'standard' | 'sop' | 'policy' | 'guideline' | 'other';
  source?: string;
  file_type: string;
  file_size?: number;
  uploaded_by?: string;
  tags?: string[];
  is_active?: boolean;
  created_at?: Date;
}

export interface KnowledgeChunk {
  id?: number;
  document_id: number;
  chunk_index: number;
  content: string;
  section_title?: string;
  page_number?: number;
  metadata?: any;
  search_vector?: any;
  created_at?: Date;
}

export async function initKnowledgeTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS knowledge_documents (
      id SERIAL PRIMARY KEY,
      title VARCHAR(500) NOT NULL,
      description TEXT,
      document_type VARCHAR(30) NOT NULL DEFAULT 'other',
      source VARCHAR(500),
      file_type VARCHAR(20) NOT NULL,
      file_size INTEGER DEFAULT 0,
      uploaded_by VARCHAR(255),
      tags TEXT[] DEFAULT '{}',
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id SERIAL PRIMARY KEY,
      document_id INTEGER REFERENCES knowledge_documents(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      section_title VARCHAR(500),
      page_number INTEGER,
      metadata JSONB DEFAULT '{}'::jsonb,
      search_vector TSVECTOR,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_doc ON knowledge_chunks(document_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_fts ON knowledge_chunks USING GIN(search_vector)`);

  await pool.query(`
    CREATE OR REPLACE FUNCTION update_knowledge_search_vector() RETURNS trigger AS $$
    BEGIN
      NEW.search_vector := to_tsvector('english', COALESCE(NEW.section_title, '') || ' ' || NEW.content);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);

  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_knowledge_search_vector') THEN
        CREATE TRIGGER trg_knowledge_search_vector
        BEFORE INSERT OR UPDATE ON knowledge_chunks
        FOR EACH ROW EXECUTE FUNCTION update_knowledge_search_vector();
      END IF;
    END $$
  `);

  console.log('[KnowledgeDB] Tables initialized');
}

function chunkText(text: string, chunkSize: number = 1500, overlap: number = 200): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start + chunkSize;
    if (end < text.length) {
      const lastPeriod = text.lastIndexOf('.', end);
      const lastNewline = text.lastIndexOf('\n', end);
      const breakAt = Math.max(lastPeriod, lastNewline);
      if (breakAt > start + chunkSize / 2) {
        end = breakAt + 1;
      }
    }
    chunks.push(text.slice(start, end).trim());
    start = end - overlap;
    if (start >= text.length) break;
  }
  return chunks.filter(c => c.length > 20);
}

function extractSections(text: string): { title: string; content: string; pageHint?: number }[] {
  const lines = text.split('\n');
  const sections: { title: string; content: string; pageHint?: number }[] = [];
  let currentTitle = 'Introduction';
  let currentContent: string[] = [];
  let pageHint = 1;

  for (const line of lines) {
    const headerMatch = line.match(/^#{1,4}\s+(.+)/) || line.match(/^(\d+\.[\d.]*\s+.+)/) || line.match(/^([A-Z][A-Z\s]{5,})$/);
    if (headerMatch) {
      if (currentContent.length > 0) {
        sections.push({ title: currentTitle, content: currentContent.join('\n'), pageHint });
      }
      currentTitle = headerMatch[1].trim();
      currentContent = [];
    } else {
      currentContent.push(line);
    }
    if (line.match(/page\s+\d+/i)) {
      const m = line.match(/page\s+(\d+)/i);
      if (m) pageHint = parseInt(m[1]);
    }
  }
  if (currentContent.length > 0) {
    sections.push({ title: currentTitle, content: currentContent.join('\n'), pageHint });
  }

  return sections;
}

export async function ingestDocument(doc: Omit<KnowledgeDocument, 'id' | 'created_at'>, rawText: string): Promise<{ document: KnowledgeDocument; chunkCount: number }> {
  const docResult = await pool.query(
    `INSERT INTO knowledge_documents (title, description, document_type, source, file_type, file_size, uploaded_by, tags)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [doc.title, doc.description || null, doc.document_type, doc.source || null,
     doc.file_type, doc.file_size || rawText.length, doc.uploaded_by || 'admin', doc.tags || []]
  );
  const document = docResult.rows[0];

  const sections = extractSections(rawText);
  let chunkIndex = 0;

  for (const section of sections) {
    const chunks = chunkText(section.content);
    for (const chunk of chunks) {
      await pool.query(
        `INSERT INTO knowledge_chunks (document_id, chunk_index, content, section_title, page_number, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [document.id, chunkIndex++, chunk, section.title, section.pageHint || null,
         JSON.stringify({ section: section.title })]
      );
    }
  }

  if (chunkIndex === 0) {
    const chunks = chunkText(rawText);
    for (const chunk of chunks) {
      await pool.query(
        `INSERT INTO knowledge_chunks (document_id, chunk_index, content, section_title, page_number)
         VALUES ($1, $2, $3, $4, $5)`,
        [document.id, chunkIndex++, chunk, null, null]
      );
    }
  }

  return { document, chunkCount: chunkIndex };
}

export async function searchKnowledge(query: string, options?: { documentId?: number; documentType?: string; limit?: number }): Promise<{ chunk: KnowledgeChunk; document_title: string; rank: number }[]> {
  const tsQuery = query.split(/\s+/).filter(w => w.length > 2).map(w => w + ':*').join(' & ');
  if (!tsQuery) return [];

  const conditions: string[] = [`kc.search_vector @@ to_tsquery('english', $1)`];
  const params: any[] = [tsQuery];
  let idx = 2;

  conditions.push(`kd.is_active = true`);

  if (options?.documentId) {
    conditions.push(`kc.document_id = $${idx++}`);
    params.push(options.documentId);
  }
  if (options?.documentType) {
    conditions.push(`kd.document_type = $${idx++}`);
    params.push(options.documentType);
  }

  const limit = options?.limit || 10;
  params.push(limit);

  const result = await pool.query(
    `SELECT kc.*, kd.title as document_title,
            ts_rank(kc.search_vector, to_tsquery('english', $1)) as rank
     FROM knowledge_chunks kc
     JOIN knowledge_documents kd ON kc.document_id = kd.id
     WHERE ${conditions.join(' AND ')}
     ORDER BY rank DESC
     LIMIT $${idx}`,
    params
  );

  return result.rows.map((r: any) => ({
    chunk: { id: r.id, document_id: r.document_id, chunk_index: r.chunk_index, content: r.content, section_title: r.section_title, page_number: r.page_number, metadata: r.metadata },
    document_title: r.document_title,
    rank: parseFloat(r.rank),
  }));
}

export async function getDocuments(filters?: { document_type?: string; is_active?: boolean }): Promise<KnowledgeDocument[]> {
  const conditions: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (filters?.document_type) { conditions.push(`document_type = $${idx++}`); params.push(filters.document_type); }
  if (filters?.is_active !== undefined) { conditions.push(`is_active = $${idx++}`); params.push(filters.is_active); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await pool.query(
    `SELECT kd.*, (SELECT COUNT(*)::int FROM knowledge_chunks WHERE document_id = kd.id) as chunk_count
     FROM knowledge_documents kd ${where} ORDER BY created_at DESC`,
    params
  );
  return result.rows;
}

export async function deleteDocument(id: number): Promise<boolean> {
  const result = await pool.query(`DELETE FROM knowledge_documents WHERE id = $1 RETURNING id`, [id]);
  return result.rows.length > 0;
}

export async function getDocumentById(id: number): Promise<KnowledgeDocument | null> {
  const result = await pool.query(`SELECT * FROM knowledge_documents WHERE id = $1`, [id]);
  return result.rows[0] || null;
}
