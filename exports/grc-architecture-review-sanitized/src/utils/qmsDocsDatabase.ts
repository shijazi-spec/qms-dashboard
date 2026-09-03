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

export type QmsDocExtractionStatus =
  | "pending"
  | "extracted"
  | "failed"
  | "unsupported"
  | "skipped";

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
  // Set when the row is a projection of an Integrated QMS policy (incl. every
  // Documents Library upload, which is now stored as a policy). NULL for plain
  // legacy library rows. Drives download-module + delete provenance.
  source_policy_id?: number | null;
  // Phase 2.1 — text extraction columns (added via ALTER on init)
  extracted_text?: string | null;
  extraction_status?: QmsDocExtractionStatus | null;
  extracted_at?: string | null;
  extracted_hash?: string | null;
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
      uploaded_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      -- Set when this row is a projection of an Integrated QMS document
      -- (policies.id) created by the Document-Mapping bridge. NULL for
      -- regular GRC uploads. Declared here (not only via the runtime ALTER
      -- in policyMappingBridge.ts) so the canonical schema matches prod and
      -- the deploy schema-diff never proposes to DROP it.
      source_policy_id INTEGER,
      -- Phase 2.1 text-extraction columns. Declared here too (they are also
      -- added via the idempotent ALTERs below for pre-existing DBs) so the
      -- canonical schema matches prod and the deploy schema-diff never
      -- proposes to DROP them — these hold every uploaded document's
      -- extracted text and would be catastrophic to lose.
      extracted_text  TEXT,
      extraction_status VARCHAR(20) DEFAULT 'pending',
      extracted_at    TIMESTAMP,
      extracted_hash  VARCHAR(64)
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_qms_uploaded_documents_category
      ON qms_uploaded_documents (category);
  `);

  // Phase 2.1 — text-extraction columns (idempotent ALTERs).
  // extracted_text is truncated to 50k chars at write time. extracted_hash
  // stores SHA-256 of the full file so we know whether to re-extract on
  // file replacement without storing the entire raw blob in the DB.
  await pool.query(
    `ALTER TABLE qms_uploaded_documents ADD COLUMN IF NOT EXISTS extracted_text TEXT`,
  );
  await pool.query(
    `ALTER TABLE qms_uploaded_documents ADD COLUMN IF NOT EXISTS extraction_status VARCHAR(20) DEFAULT 'pending'`,
  );
  await pool.query(
    `ALTER TABLE qms_uploaded_documents ADD COLUMN IF NOT EXISTS extracted_at TIMESTAMP`,
  );
  await pool.query(
    `ALTER TABLE qms_uploaded_documents ADD COLUMN IF NOT EXISTS extracted_hash VARCHAR(64)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_qms_uploaded_documents_extraction_status
       ON qms_uploaded_documents (extraction_status)`,
  );

  initialized = true;
  logger.info("✅ [QmsDocsDB] qms_uploaded_documents table ready");
}

/**
 * Phase 2.1 — list documents that still need text extraction. Used by
 * the Inngest backfill cron and by tests.
 */
export async function listDocumentsPendingExtraction(
  limit: number = 25,
): Promise<QmsUploadedDocument[]> {
  await initQmsDocsTable();
  const result = await pool.query(
    `SELECT * FROM qms_uploaded_documents
      WHERE extraction_status = 'pending' OR extraction_status IS NULL
      ORDER BY uploaded_at ASC
      LIMIT $1`,
    [limit],
  );
  return result.rows as QmsUploadedDocument[];
}

/**
 * Phase 2.1 — persist extraction result for a document.
 */
export async function setDocumentExtractionResult(
  id: number,
  status: QmsDocExtractionStatus,
  text: string | null,
  hash: string | null,
): Promise<void> {
  await initQmsDocsTable();
  // Truncate to 50k chars to keep row size bounded.
  const safeText = text == null ? null : text.slice(0, 50_000);
  await pool.query(
    `UPDATE qms_uploaded_documents
        SET extracted_text   = $2,
            extraction_status = $3,
            extracted_at      = CURRENT_TIMESTAMP,
            extracted_hash    = $4
      WHERE id = $1`,
    [id, safeText, status, hash],
  );
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
