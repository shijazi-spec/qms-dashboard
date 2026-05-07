import { createRedactedPool } from "./redactedPool";
import { logger } from "./logger";

const pool = createRedactedPool({ connectionString: process.env.DATABASE_URL });

export interface ObligationDocumentLink {
  id: number;
  obligation_id: number;
  document_id: number;
  linked_by: string;
  linked_at: string;
}

export interface ObligationDocumentRow {
  id: number;
  obligation_id: number;
  document_id: number;
  linked_by: string;
  linked_at: string;
  title: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  category: string;
  notes: string | null;
}

let initialized = false;

export async function initObligationDocumentsTable(): Promise<void> {
  if (initialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS obligation_documents (
      id              SERIAL PRIMARY KEY,
      obligation_id   INTEGER       NOT NULL REFERENCES obligations(id) ON DELETE CASCADE,
      document_id     INTEGER       NOT NULL REFERENCES qms_uploaded_documents(id) ON DELETE CASCADE,
      linked_by       VARCHAR(255)  NOT NULL,
      linked_at       TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(obligation_id, document_id)
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_obligation_documents_obligation
      ON obligation_documents (obligation_id);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_obligation_documents_document
      ON obligation_documents (document_id);
  `);
  initialized = true;
  logger.info("✅ [ObligationDocsDB] obligation_documents table ready");
}

export async function listDocumentsForObligation(
  obligationId: number,
): Promise<ObligationDocumentRow[]> {
  await initObligationDocumentsTable();
  const result = await pool.query(
    `SELECT od.id, od.obligation_id, od.document_id, od.linked_by, od.linked_at,
            d.title, d.file_name, d.file_size, d.mime_type, d.category, d.notes
       FROM obligation_documents od
       JOIN qms_uploaded_documents d ON d.id = od.document_id
      WHERE od.obligation_id = $1
      ORDER BY od.linked_at DESC`,
    [obligationId],
  );
  return result.rows as ObligationDocumentRow[];
}

export async function countDocumentsByObligation(
  regulationId?: number,
): Promise<Record<number, number>> {
  await initObligationDocumentsTable();
  const result = regulationId
    ? await pool.query(
        `SELECT od.obligation_id, COUNT(*)::int AS n
           FROM obligation_documents od
           JOIN obligations o ON o.id = od.obligation_id
          WHERE o.regulation_id = $1
          GROUP BY od.obligation_id`,
        [regulationId],
      )
    : await pool.query(
        `SELECT obligation_id, COUNT(*)::int AS n
           FROM obligation_documents
           GROUP BY obligation_id`,
      );
  const out: Record<number, number> = {};
  for (const row of result.rows) {
    out[Number(row.obligation_id)] = Number(row.n) || 0;
  }
  return out;
}

export async function linkDocumentToObligation(input: {
  obligation_id: number;
  document_id: number;
  linked_by: string;
}): Promise<ObligationDocumentLink | null> {
  await initObligationDocumentsTable();
  const result = await pool.query(
    `INSERT INTO obligation_documents (obligation_id, document_id, linked_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (obligation_id, document_id) DO NOTHING
     RETURNING *`,
    [input.obligation_id, input.document_id, input.linked_by],
  );
  return (result.rows[0] as ObligationDocumentLink) || null;
}

export async function unlinkDocumentFromObligation(
  obligationId: number,
  documentId: number,
): Promise<boolean> {
  await initObligationDocumentsTable();
  const result = await pool.query(
    `DELETE FROM obligation_documents
      WHERE obligation_id = $1 AND document_id = $2`,
    [obligationId, documentId],
  );
  return (result.rowCount ?? 0) > 0;
}
