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
      extracted_hash  VARCHAR(64),
      -- Precomputed search vector for the Mapping Console's clause -> document
      -- search. This was an EXPRESSION index on to_tsvector(...) instead, and
      -- Replit's deploy schema-diff could not round-trip it: it read the
      -- expression back out of the dev database and emitted
      --   USING gin (to_tsvector('english'::regconfig, COALESCE(...)):: tsvector_ops);
      -- with unbalanced parens and the operator class written as a cast, which
      -- failed migration validation and blocked the whole publish. A generated
      -- column with a plain column index expresses the same thing in a form any
      -- differ can round-trip.
      --
      -- STORED (not VIRTUAL) because GIN must index materialised values, and
      -- the expression is IMMUTABLE only because the 'english' config is named
      -- explicitly — to_tsvector(text) without a config depends on a session
      -- GUC and Postgres will refuse it here.
      extracted_tsv   TSVECTOR GENERATED ALWAYS AS
                        (to_tsvector('english', COALESCE(extracted_text, ''))) STORED
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

  // Idempotent ALTER for databases created before extracted_tsv existed.
  // Mirrored in the CREATE TABLE above (see the note there on why this is a
  // generated column rather than an expression index).
  await pool.query(
    `ALTER TABLE qms_uploaded_documents
       ADD COLUMN IF NOT EXISTS extracted_tsv TSVECTOR
       GENERATED ALWAYS AS (to_tsvector('english', COALESCE(extracted_text, ''))) STORED`,
  );

  // Drop the previous EXPRESSION index first. It is the one whose definition
  // Replit's deploy schema-diff could not round-trip, so leaving it in place
  // would fail migration validation again no matter what we add alongside it.
  // Dropping an index destroys no data - it is derived, and the CREATE below
  // replaces it - so this is safe to run unconditionally on every boot.
  //
  // It also has to go before the CREATE rather than after: the old index owns
  // this exact name, and CREATE INDEX IF NOT EXISTS would find the name taken,
  // skip silently, and leave the search running unindexed with nothing logged.
  await pool.query(
    `DROP INDEX IF EXISTS idx_qms_uploaded_documents_fts`,
  );
  // Full-text search over the WHOLE extracted body, for the Mapping Console's
  // clause -> document search. Before this, that search read only the first
  // 1500 chars of the 25 most recently uploaded documents, so it could not see
  // what a document actually says further down — which is exactly the question
  // it is asked. 'english' gives stemming (processing -> process); Arabic text
  // is still tokenised and exact-matchable, just unstemmed, which is why the
  // Console also keeps a literal-substring pass.
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_qms_uploaded_documents_tsv
       ON qms_uploaded_documents USING GIN (extracted_tsv)`,
  );

  initialized = true;
  logger.info("✅ [QmsDocsDB] qms_uploaded_documents table ready");
}

// Every column EXCEPT extracted_tsv. That column is a STORED generated tsvector
// of the whole body, so `SELECT *` would ship a large blob per row on the
// Documents Library list queries to no purpose - nothing outside the search
// predicate ever reads it. Listing the columns explicitly keeps those responses
// exactly the size they were before the column existed.
//
// (Note: extracted_text - up to 50k chars - IS still returned by these list
// queries. That predates the tsvector column and is left as-is here rather than
// changed silently under an unrelated fix.)
const DOC_COLUMNS = `id, category, title, file_path, file_name, file_size,
    mime_type, notes, regulation_codes, uploaded_by, uploaded_at,
    source_policy_id, extracted_text, extraction_status, extracted_at,
    extracted_hash`;

/**
 * Phase 2.1 — list documents that still need text extraction. Used by
 * the Inngest backfill cron and by tests.
 */

export async function listDocumentsPendingExtraction(
  limit: number = 25,
): Promise<QmsUploadedDocument[]> {
  await initQmsDocsTable();
  const result = await pool.query(
    `SELECT ${DOC_COLUMNS} FROM qms_uploaded_documents
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
        `SELECT ${DOC_COLUMNS} FROM qms_uploaded_documents WHERE category = $1
         ORDER BY uploaded_at DESC`,
        [category],
      )
    : await pool.query(
        `SELECT ${DOC_COLUMNS} FROM qms_uploaded_documents ORDER BY uploaded_at DESC`,
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
    `SELECT ${DOC_COLUMNS} FROM qms_uploaded_documents WHERE id = $1 LIMIT 1`,
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
