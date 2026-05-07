import { createRedactedPool } from "./redactedPool";
import { logger } from "./logger";

const pool = createRedactedPool({ connectionString: process.env.DATABASE_URL });

export type QmsDocCategory =
  | "documents"
  | "policies"
  | "forms"
  | "security_controls"
  | "sops";

export const QMS_DOC_CATEGORIES: readonly QmsDocCategory[] = [
  "documents",
  "policies",
  "forms",
  "security_controls",
  "sops",
];

export interface QmsUploadedDocument {
  id: number;
  category: QmsDocCategory;
  title: string;
  file_path: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  notes: string | null;
  regulation_codes: string[] | null;
  uploaded_by: string;
  uploaded_at: string;
}

let initialized = false;

/**
 * Idempotent table init. Stores per-file metadata for the GRC → QMS upload
 * library. The `regulation_codes` text[] is the seam for the future
 * compliance-mapping work (each uploaded doc can be tagged with one or more
 * regulation_code values from the `regulations` table — PDPL, ISO-27001,
 * PCI-DSS, …) without needing a schema migration when the mapping UI lands.
 */
export async function initQmsDocsTable(): Promise<void> {
  if (initialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS qms_uploaded_documents (
      id              SERIAL PRIMARY KEY,
      category        VARCHAR(64)   NOT NULL,
      title           VARCHAR(512)  NOT NULL,
      file_path       VARCHAR(1024) NOT NULL,
      file_name       VARCHAR(512)  NOT NULL,
      file_size       INTEGER       NOT NULL,
      mime_type       VARCHAR(128)  NOT NULL,
      notes           TEXT,
      regulation_codes TEXT[],
      uploaded_by     VARCHAR(255)  NOT NULL,
      uploaded_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_qms_uploaded_documents_category
      ON qms_uploaded_documents (category);
  `);
  initialized = true;
  logger.info("✅ [QmsDocsDB] qms_uploaded_documents table ready");
}

export function isValidCategory(c: string): c is QmsDocCategory {
  return (QMS_DOC_CATEGORIES as readonly string[]).includes(c);
}

export async function listDocumentsByCategory(
  category?: QmsDocCategory,
): Promise<QmsUploadedDocument[]> {
  await initQmsDocsTable();
  const result = category
    ? await pool.query(
        `SELECT * FROM qms_uploaded_documents WHERE category = $1
         ORDER BY uploaded_at DESC`,
        [category],
      )
    : await pool.query(
        `SELECT * FROM qms_uploaded_documents ORDER BY uploaded_at DESC`,
      );
  return result.rows as QmsUploadedDocument[];
}

export async function countDocumentsByCategory(): Promise<Record<QmsDocCategory, number>> {
  await initQmsDocsTable();
  const result = await pool.query(
    `SELECT category, COUNT(*)::int AS n FROM qms_uploaded_documents GROUP BY category`,
  );
  const out: Record<string, number> = {};
  for (const cat of QMS_DOC_CATEGORIES) out[cat] = 0;
  for (const row of result.rows) out[row.category] = Number(row.n) || 0;
  return out as Record<QmsDocCategory, number>;
}

export async function createDocument(input: {
  category: QmsDocCategory;
  title: string;
  file_path: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  notes?: string | null;
  regulation_codes?: string[] | null;
  uploaded_by: string;
}): Promise<QmsUploadedDocument> {
  await initQmsDocsTable();
  const result = await pool.query(
    `INSERT INTO qms_uploaded_documents
       (category, title, file_path, file_name, file_size, mime_type,
        notes, regulation_codes, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      input.category,
      input.title,
      input.file_path,
      input.file_name,
      input.file_size,
      input.mime_type,
      input.notes ?? null,
      input.regulation_codes ?? null,
      input.uploaded_by,
    ],
  );
  return result.rows[0] as QmsUploadedDocument;
}

export async function setDocumentExtractionResult(
  _id: number,
  _status: string,
  _text: string | null,
  _hash: string | null,
): Promise<void> {
  logger.warn(
    "[qmsDocsDatabase] setDocumentExtractionResult stub — extraction columns not yet present in qms_uploaded_documents",
  );
}

export async function listDocumentsPendingExtraction(
  _batchSize: number,
): Promise<QmsUploadedDocument[]> {
  return [];
}

export async function getDocumentById(id: number): Promise<QmsUploadedDocument | null> {
  await initQmsDocsTable();
  const result = await pool.query(
    `SELECT * FROM qms_uploaded_documents WHERE id = $1 LIMIT 1`,
    [id],
  );
  return (result.rows[0] as QmsUploadedDocument) || null;
}

export async function deleteDocument(id: number): Promise<QmsUploadedDocument | null> {
  await initQmsDocsTable();
  const result = await pool.query(
    `DELETE FROM qms_uploaded_documents WHERE id = $1 RETURNING *`,
    [id],
  );
  return (result.rows[0] as QmsUploadedDocument) || null;
}
