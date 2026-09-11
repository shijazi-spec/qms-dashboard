/**
 * blurbEraPurge — remove the mapping artefacts derived from PLACEHOLDER projections.
 *
 * WHY THIS EXISTS
 * ---------------
 * Before the placeholder rule landed, every controlled document in the register
 * was projected into qms_uploaded_documents carrying a stand-in body:
 *
 *     "Controlled document (WP-...) — pending file upload."
 *
 * ~169 characters. Stage 1 (semantic retrieval) and Stage 2 (the LLM evidence
 * judge) both ran correctly against that text, so the links and findings they
 * produced describe blurb-matching, not the documents themselves. Marking those
 * rows extraction_status='placeholder' stopped NEW work being done on them, but
 * a forward fix never reaches rows already written — this is that backfill.
 *
 * THE TWO SILENT SKIP-GATES (why this deletes more than the links)
 * ---------------------------------------------------------------
 * MAP_ALL_CANDIDATE_SQL in policyMappingBridge.ts skips a (document, framework)
 * pair when EITHER:
 *
 *   1. a row exists in document_framework_scans       → "already scanned"
 *   2. a link already exists in obligation_documents  → "already mapped"
 *
 * Clearing only the findings, or only the links, would leave one gate shut: the
 * re-map would appear to run and quietly map nothing. Both are cleared here.
 *
 * WHAT IS NEVER DELETED
 * ---------------------
 * Links whose provenance is not demonstrably the AI. A person's deliberate
 * mapping is not reproducible by re-running the AI, so it is counted and
 * reported instead — and the report says plainly that each survivor keeps
 * gate 2 shut for its document × framework pair.
 *
 * WHAT THE LIVE DATA TURNED OUT TO BE (2026-09-11 → 09-12)
 * -------------------------------------------------------
 * The first dry run reported links=0, kept=1042, which read as "all of it is
 * human work". It was not. `link_provenance` showed the real distribution:
 *
 *     bulk_confirmed      1010    s.hijazi@walaplus.com
 *     citation_confirmed    32    s.hijazi@walaplus.com
 *
 * Both are post-review states, and confirming does not change who MADE a link.
 * Only the two automatic mappers ever set awaiting_review = TRUE, so every one
 * of those 1042 was machine-generated; 'bulk_confirmed' then came from the
 * confirm-all override that the code itself describes as bypassing the
 * audit-grade filter. Worse, that UPDATE overwrites `linked_by` with the
 * confirmer's email — destroying the 'ai-semantic' marker that was the only
 * remaining evidence of machine origin. Hence AI_LINK matches the confirmed
 * variants too: the human email in the row is an artefact of the confirm, not
 * a record of authorship.
 *
 * `link_provenance` stays in the report regardless. A count alone could not
 * have distinguished these two cases, and the difference decided whether to
 * delete 1042 rows or protect them.
 *
 * SELF-HEALING AFTERWARDS — nothing else needs running
 * ----------------------------------------------------
 *   • the projection re-runs when a policy's fingerprint changes, so a
 *     placeholder turns back into 'extracted' by itself once the file is attached
 *   • backfillDocumentChunks re-chunks any document whose doc_hash no longer
 *     matches its text
 *   • "Map all frameworks" then sees the pair as unscanned and unmapped
 */
import { sharedPool as pool } from "./sharedPool";
import { logger } from "./logger";

/**
 * The scope, defined once. Everything below joins against this — a second
 * definition of "which documents are blurbs" is exactly how a purge goes wrong.
 */
const PLACEHOLDER_DOCS = `
  SELECT id FROM qms_uploaded_documents
   WHERE COALESCE(extraction_status, '') = 'placeholder'`;

/**
 * AI provenance, matched two ways on purpose. `link_method` was added after the
 * feature shipped and DEFAULTs to 'manual', so any AI link written before that
 * column existed is mislabelled — `linked_by` is the older, reliable signal.
 */
const AI_LINK = `(
     COALESCE(od.link_method, '') IN (
       -- written by the two automatic mappers
       'citation_auto', 'llm_semantic',
       -- ...and the same links after review. Confirming does not change who
       -- MADE the link, only that someone waved it through: 'bulk_confirmed'
       -- comes from the confirm-all override, which the code itself describes
       -- as bypassing the audit-grade filter, and its UPDATE overwrites
       -- linked_by with the confirmer's email - erasing the 'ai-semantic'
       -- marker that was the only remaining evidence of machine origin.
       'bulk_confirmed', 'citation_confirmed', 'ai_confirmed',
       -- AI proposed, a person accepted it one at a time (see apply-mapping)
       'ai_suggested'
     )
  OR COALESCE(od.linked_by, '')   IN ('ai-citation', 'ai-semantic')
)`;

interface Target {
  key: keyof PurgeCounts;
  label: string;
  selectSql: string;
  deleteSql: string;
}

const TARGETS: Target[] = [
  {
    key: "findings",
    label: "AI judge findings (obligation_evidence_quality)",
    selectSql: `SELECT q.* FROM obligation_evidence_quality q
                 WHERE q.document_id IN (${PLACEHOLDER_DOCS})`,
    deleteSql: `DELETE FROM obligation_evidence_quality q
                 WHERE q.document_id IN (${PLACEHOLDER_DOCS})`,
  },
  {
    key: "links",
    label: "AI clause links (obligation_documents)",
    selectSql: `SELECT od.* FROM obligation_documents od
                 WHERE od.document_id IN (${PLACEHOLDER_DOCS}) AND ${AI_LINK}`,
    deleteSql: `DELETE FROM obligation_documents od
                 WHERE od.document_id IN (${PLACEHOLDER_DOCS}) AND ${AI_LINK}`,
  },
  {
    key: "citations",
    label: "Blurb-derived citations (document_clause_citations)",
    selectSql: `SELECT c.* FROM document_clause_citations c
                 WHERE c.document_id IN (${PLACEHOLDER_DOCS})`,
    deleteSql: `DELETE FROM document_clause_citations c
                 WHERE c.document_id IN (${PLACEHOLDER_DOCS})`,
  },
  {
    key: "scans",
    label: "Scan ledger — skip-gate 1 (document_framework_scans)",
    selectSql: `SELECT s.* FROM document_framework_scans s
                 WHERE s.document_id IN (${PLACEHOLDER_DOCS})`,
    deleteSql: `DELETE FROM document_framework_scans s
                 WHERE s.document_id IN (${PLACEHOLDER_DOCS})`,
  },
  {
    key: "chunks",
    label: "Blurb chunk embeddings (document_chunk_embeddings)",
    // chunk_text/embedding are large and regenerate from the text, so the
    // backup keeps identity only — a 169-char blurb's vector is worth nothing.
    selectSql: `SELECT c.id, c.document_id, c.chunk_index
                  FROM document_chunk_embeddings c
                 WHERE c.document_id IN (${PLACEHOLDER_DOCS})`,
    deleteSql: `DELETE FROM document_chunk_embeddings c
                 WHERE c.document_id IN (${PLACEHOLDER_DOCS})`,
  },
];

export interface PurgeCounts {
  findings: number;
  links: number;
  citations: number;
  scans: number;
  chunks: number;
}

export interface PurgeScope {
  documents_total: number;
  documents_placeholder: number;
  documents_with_real_text: number;
  links_total: number;
  findings_total: number;
  database: string;
}

export interface PurgeReport {
  dry_run: boolean;
  scope: PurgeScope;
  /** Rows removed (apply) or that would be removed (dry run). */
  counts: PurgeCounts;
  total: number;
  labels: Record<string, string>;
  /** Human-made links inside the placeholder set — kept, never deleted. */
  preserved_manual_links: any[];
  /**
   * Every link to a placeholder document, grouped by how it was written.
   * Read this before any delete: `linked_by` alone is not authorship, because
   * confirming a link overwrites it with the confirmer's email.
   */
  link_provenance: any[];
  /** Only populated when `includeRows` is set (the CLI's backup file). */
  rows?: Record<string, any[]>;
}

export const PURGE_LABELS: Record<string, string> = Object.fromEntries(
  TARGETS.map((t) => [t.key, t.label]),
);

async function countOf(sql: string): Promise<number> {
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM (${sql}) t`);
  return r.rows[0]?.n || 0;
}

async function readScope(): Promise<PurgeScope> {
  const r = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM qms_uploaded_documents)                  AS documents_total,
      (SELECT COUNT(*)::int FROM (${PLACEHOLDER_DOCS}) p)                 AS documents_placeholder,
      (SELECT COUNT(*)::int FROM qms_uploaded_documents
        WHERE COALESCE(extraction_status, '') = 'extracted'
          AND COALESCE(length(extracted_text), 0) >= 50)                  AS documents_with_real_text,
      (SELECT COUNT(*)::int FROM obligation_documents)                    AS links_total,
      (SELECT COUNT(*)::int FROM obligation_evidence_quality)             AS findings_total,
      current_database()                                                  AS database
  `);
  return r.rows[0] as PurgeScope;
}

/**
 * Count, and optionally delete, every blurb-era mapping artefact.
 *
 * Dry run is the DEFAULT: a caller that forgets the flag counts rather than
 * deletes. The apply path runs all five deletes inside one transaction, so a
 * failure part-way through cannot leave the links cleared but the scan ledger
 * intact — which is the one state that would silently suppress the re-map.
 */
export async function purgeBlurbEraMappings(
  opts: { dryRun?: boolean; includeRows?: boolean } = {},
): Promise<PurgeReport> {
  const dryRun = opts.dryRun !== false;
  const scope = await readScope();

  const counts = {} as PurgeCounts;
  for (const t of TARGETS) counts[t.key] = await countOf(t.selectSql);

  const manual = await pool.query(
    `SELECT od.id, od.obligation_id, od.document_id, od.linked_by, od.link_method
       FROM obligation_documents od
      WHERE od.document_id IN (${PLACEHOLDER_DOCS}) AND NOT ${AI_LINK}
      ORDER BY od.id`,
  );

  // Who actually made these links, aggregated — NOT a sample.
  //
  // The first live dry run returned links=0 / kept=1042: every link to a
  // placeholder document carries a person's email and no link_method marker,
  // so the AI_LINK predicate matched none of them. That is because
  // /apply-mapping writes `linked_by = <the user's email>` and lets
  // link_method default to 'manual' — an AI suggestion accepted in bulk is
  // indistinguishable in the row from one made by hand.
  //
  // Deleting 1042 links attributed to a named colleague is not a decision to
  // take on a guess about which of those two happened, so the preview reports
  // the distribution and a human decides. `awaiting_review` is carried because
  // a TRUE there is the one surviving fingerprint of an automated write.
  const provenance = await pool.query(
    `SELECT COALESCE(od.link_method, '(null)')      AS link_method,
            COALESCE(od.linked_by, '(null)')        AS linked_by,
            COALESCE(od.awaiting_review, FALSE)     AS awaiting_review,
            COUNT(*)::int                           AS links,
            MIN(od.linked_at)                       AS first_linked,
            MAX(od.linked_at)                       AS last_linked
       FROM obligation_documents od
      WHERE od.document_id IN (${PLACEHOLDER_DOCS})
      GROUP BY 1, 2, 3
      ORDER BY links DESC`,
  );

  const report: PurgeReport = {
    dry_run: dryRun,
    scope,
    counts,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    labels: PURGE_LABELS,
    preserved_manual_links: manual.rows,
    link_provenance: provenance.rows,
  };

  if (opts.includeRows) {
    const rows: Record<string, any[]> = {};
    for (const t of TARGETS) {
      rows[t.key] = (await pool.query(t.selectSql)).rows;
    }
    rows.preserved_manual_links = manual.rows;
    report.rows = rows;
  }

  if (dryRun || report.total === 0) return report;

  const client = await pool.connect();
  const deleted = {} as PurgeCounts;
  try {
    await client.query("BEGIN");
    for (const t of TARGETS) {
      const r = await client.query(t.deleteSql);
      deleted[t.key] = r.rowCount || 0;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    logger.error(
      `[blurbEraPurge] rolled back, nothing deleted: ${(err as Error).message}`,
    );
    throw err;
  } finally {
    client.release();
  }

  report.counts = deleted;
  report.total = Object.values(deleted).reduce((a, b) => a + b, 0);
  logger.info(`[blurbEraPurge] purged ${JSON.stringify(deleted)}`);
  return report;
}
