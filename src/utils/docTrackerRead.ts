/**
 * docTrackerRead — read side of the Documentation Live Tracker.
 *
 * THE THREE LINK STATES (conflating the last two makes the coverage matrix lie):
 *
 *   orphan       policy_id IS NULL
 *                → the file exists on disk but is not on the master list.
 *                  Surfaces in the promote panel. Ingest never auto-creates.
 *
 *   unprojected   register row exists, but nothing has been projected into the
 *                 mapping pool for it — true today for most of the 154 seeded
 *                 entries, which were inserted with file_path = NULL.
 *                 MUST render as "not analysed", NOT as "no coverage".
 *
 *   linked        both resolve; coverage figures are meaningful.
 *
 * An `unprojected` document shown as 0% coverage makes a correctly-registered
 * document look like a compliance gap and manufactures false audit findings.
 * `link_status` is therefore returned explicitly — the front-end must never
 * infer it from a zero count.
 *
 * Coverage is DERIVED from the platform's own verified mapping tables, never
 * from anything the collector sends:
 *
 *   doc_tracker_documents.policy_id
 *     → qms_uploaded_documents.source_policy_id
 *       → obligation_documents → obligations → regulations
 *
 * The obligations filter is `status = 'applicable'` to match
 * getFrameworkCoverage exactly. If those denominators ever drift, the tracker
 * and the compliance dashboard report different numbers for the same documents
 * and neither is trusted.
 */

import { sharedPool as pool } from "./sharedPool";
import { initDocTrackerTables, TERMINAL_REVIEW_STATES } from "./docTrackerDatabase";

/** SQL fragment computing link_status live rather than trusting a cached column. */
const LINK_STATUS_SQL = `
  CASE
    WHEN d.policy_id IS NULL THEN 'orphan'
    WHEN q.id IS NULL        THEN 'unprojected'
    ELSE 'linked'
  END`;

/** SQL fragment: a settled review whose document has changed underneath it. */
const STALE_SQL = `
  (d.review_state = ANY($STALE_STATES$)
   AND d.hash_at_review IS NOT NULL
   AND d.hash_at_review IS DISTINCT FROM d.content_hash)`;

function staleSql(paramIndex: number): string {
  return STALE_SQL.replace("$STALE_STATES$", `$${paramIndex}::text[]`);
}

export interface TrackerOverview {
  documents: {
    total: number;
    orphan: number;
    unprojected: number;
    linked: number;
    deleted: number;
    stale_since_review: number;
    code_issues: number;
    dangling_refs: number;
  };
  by_review_state: Record<string, number>;
  by_family: Record<string, number>;
  by_lang: Record<string, number>;
  last_snapshot: {
    id: number;
    status: string;
    created_at: string;
    documents_in: number;
    inserted: number;
    updated: number;
    soft_deleted: number;
    reject_reason: string | null;
  } | null;
  collectors: Array<{
    collector_id: string;
    health_state: string;
    last_snapshot_at: string | null;
    last_heartbeat_at: string | null;
    snapshot_age_seconds: number | null;
    heartbeat_age_seconds: number | null;
    enabled: boolean;
  }>;
}

export async function getOverview(): Promise<TrackerOverview> {
  await initDocTrackerTables();
  const states = TERMINAL_REVIEW_STATES;

  const agg = await pool.query(
    `SELECT
        COUNT(*) FILTER (WHERE d.deleted = FALSE)::int  AS total,
        COUNT(*) FILTER (WHERE d.deleted = TRUE)::int   AS deleted,
        COUNT(*) FILTER (WHERE d.deleted = FALSE AND d.policy_id IS NULL)::int AS orphan,
        COUNT(*) FILTER (WHERE d.deleted = FALSE AND d.policy_id IS NOT NULL AND q.id IS NULL)::int AS unprojected,
        COUNT(*) FILTER (WHERE d.deleted = FALSE AND d.policy_id IS NOT NULL AND q.id IS NOT NULL)::int AS linked,
        COUNT(*) FILTER (WHERE d.deleted = FALSE AND ${staleSql(1)})::int AS stale_since_review,
        COUNT(*) FILTER (WHERE d.deleted = FALSE AND d.code_ok = FALSE)::int AS code_issues,
        COALESCE(SUM(d.dangling_count) FILTER (WHERE d.deleted = FALSE), 0)::int AS dangling_refs
       FROM doc_tracker_documents d
       LEFT JOIN qms_uploaded_documents q ON q.source_policy_id = d.policy_id`,
    [states],
  );

  const byState = await pool.query(
    `SELECT review_state, COUNT(*)::int AS n
       FROM doc_tracker_documents WHERE deleted = FALSE
      GROUP BY review_state`,
  );
  const byFamily = await pool.query(
    `SELECT COALESCE(doc_family,'—') AS k, COUNT(*)::int AS n
       FROM doc_tracker_documents WHERE deleted = FALSE GROUP BY 1`,
  );
  const byLang = await pool.query(
    `SELECT COALESCE(lang,'EN') AS k, COUNT(*)::int AS n
       FROM doc_tracker_documents WHERE deleted = FALSE GROUP BY 1`,
  );

  const snap = await pool.query(
    `SELECT id, status, created_at, documents_in, inserted, updated,
            soft_deleted, reject_reason
       FROM doc_tracker_snapshots ORDER BY created_at DESC, id DESC LIMIT 1`,
  );

  // Ages are computed in SQL against DB time so a skewed app clock cannot make
  // a dead collector look fresh.
  const collectors = await pool.query(
    `SELECT collector_id, health_state, enabled,
            last_snapshot_at, last_heartbeat_at,
            EXTRACT(EPOCH FROM (NOW() - last_snapshot_at))::int  AS snapshot_age_seconds,
            EXTRACT(EPOCH FROM (NOW() - last_heartbeat_at))::int AS heartbeat_age_seconds
       FROM doc_tracker_collectors ORDER BY collector_id`,
  );

  const toMap = (rows: any[], key: string) => {
    const out: Record<string, number> = {};
    for (const r of rows) out[String(r[key])] = r.n;
    return out;
  };

  return {
    documents: agg.rows[0],
    by_review_state: toMap(byState.rows, "review_state"),
    by_family: toMap(byFamily.rows, "k"),
    by_lang: toMap(byLang.rows, "k"),
    last_snapshot: snap.rows[0] ?? null,
    collectors: collectors.rows,
  };
}

export interface DocumentFilters {
  state?: string;
  family?: string;
  lang?: string;
  linkStatus?: string;
  stale?: boolean;
  q?: string;
  includeDeleted?: boolean;
  page?: number;
  pageSize?: number;
}

/** The board. Paginated; pageSize capped so a wide-open query cannot be issued. */
export async function listDocuments(f: DocumentFilters = {}): Promise<{
  rows: any[];
  total: number;
  page: number;
  pageSize: number;
}> {
  await initDocTrackerTables();
  const page = Math.max(0, f.page ?? 0);
  const pageSize = Math.min(500, Math.max(1, f.pageSize ?? 100));

  const params: any[] = [TERMINAL_REVIEW_STATES];
  const where: string[] = [];
  if (!f.includeDeleted) where.push("d.deleted = FALSE");
  if (f.state) {
    params.push(f.state);
    where.push(`d.review_state = $${params.length}`);
  }
  if (f.family) {
    params.push(f.family);
    where.push(`d.doc_family = $${params.length}`);
  }
  if (f.lang) {
    params.push(String(f.lang).toUpperCase());
    where.push(`d.lang = $${params.length}`);
  }
  if (f.q) {
    params.push(`%${f.q.toLowerCase()}%`);
    where.push(
      `(LOWER(d.register_code) LIKE $${params.length} OR LOWER(COALESCE(d.title,'')) LIKE $${params.length} OR LOWER(COALESCE(d.file_name,'')) LIKE $${params.length})`,
    );
  }
  if (f.stale === true) where.push(staleSql(1));
  if (f.linkStatus) {
    if (f.linkStatus === "orphan") where.push("d.policy_id IS NULL");
    else if (f.linkStatus === "unprojected")
      where.push("d.policy_id IS NOT NULL AND q.id IS NULL");
    else if (f.linkStatus === "linked")
      where.push("d.policy_id IS NOT NULL AND q.id IS NOT NULL");
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM doc_tracker_documents d
       LEFT JOIN qms_uploaded_documents q ON q.source_policy_id = d.policy_id
       ${whereSql}`,
    params,
  );

  params.push(pageSize, page * pageSize);
  const rows = await pool.query(
    `SELECT d.id, d.register_code, d.base_code, d.lang, d.doc_family, d.title,
            d.file_name, d.folder, d.size_kb, d.modified_at, d.content_hash,
            d.code_ok, d.issues, d.ref_count, d.dangling_count,
            d.review_state, d.assignee_email, d.note, d.reviewed_at, d.reviewed_by,
            d.hash_at_review, d.deleted, d.updated_at,
            d.policy_id, q.id AS projected_document_id,
            p.title AS register_title, p.status AS register_status, p.version,
            ${LINK_STATUS_SQL} AS link_status,
            ${staleSql(1)} AS stale_since_review
       FROM doc_tracker_documents d
       LEFT JOIN qms_uploaded_documents q ON q.source_policy_id = d.policy_id
       LEFT JOIN policies p ON p.id = d.policy_id
       ${whereSql}
   ORDER BY d.register_code
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return { rows: rows.rows, total: countRes.rows[0]?.n || 0, page, pageSize };
}

/**
 * Derived framework coverage per tracker document.
 *
 * One query for the whole board rather than N+1. Returns a row per
 * (register_code, regulation_code) with confirmed/pending counts; callers pivot.
 * Documents that are orphan or unprojected simply produce no coverage rows —
 * which is why `link_status` must travel alongside, so the UI can distinguish
 * "analysed, nothing found" from "never analysed".
 */
export async function getCoverage(regulationId?: number): Promise<any[]> {
  await initDocTrackerTables();
  const params: any[] = [];
  let regFilter = "";
  if (regulationId) {
    params.push(regulationId);
    regFilter = ` AND o.regulation_id = $${params.length}`;
  }
  const r = await pool.query(
    `SELECT d.register_code,
            reg.regulation_code,
            COUNT(od.id) FILTER (WHERE od.awaiting_review IS NOT TRUE)::int AS confirmed,
            COUNT(od.id) FILTER (WHERE od.awaiting_review IS TRUE)::int     AS pending
       FROM doc_tracker_documents d
       JOIN qms_uploaded_documents q ON q.source_policy_id = d.policy_id
       JOIN obligation_documents od  ON od.document_id = q.id
       JOIN obligations o            ON o.id = od.obligation_id
                                    AND o.status = 'applicable'${regFilter}
       JOIN regulations reg          ON reg.id = o.regulation_id
                                    AND reg.status = 'active'
      WHERE d.deleted = FALSE
   GROUP BY d.register_code, reg.regulation_code
   ORDER BY d.register_code, reg.regulation_code`,
    params,
  );
  return r.rows;
}

/** One document with its refs (both directions) and its clause-level coverage. */
export async function getDocumentDetail(registerCode: string): Promise<any | null> {
  await initDocTrackerTables();
  const r = await pool.query(
    `SELECT d.*, q.id AS projected_document_id,
            p.title AS register_title, p.status AS register_status, p.version,
            ${LINK_STATUS_SQL} AS link_status,
            ${staleSql(2)} AS stale_since_review
       FROM doc_tracker_documents d
       LEFT JOIN qms_uploaded_documents q ON q.source_policy_id = d.policy_id
       LEFT JOIN policies p ON p.id = d.policy_id
      WHERE d.register_code = $1`,
    [registerCode, TERMINAL_REVIEW_STATES],
  );
  if (r.rows.length === 0) return null;
  const doc = r.rows[0];

  const outbound = await pool.query(
    `SELECT to_code, resolved FROM doc_tracker_refs WHERE from_code = $1 ORDER BY to_code`,
    [registerCode],
  );
  // Inbound refs are the inverted graph — "who depends on this document",
  // which is what makes a proposed change reviewable.
  const inbound = await pool.query(
    `SELECT from_code FROM doc_tracker_refs WHERE to_code = $1 ORDER BY from_code`,
    [registerCode],
  );

  let clauses: any[] = [];
  if (doc.projected_document_id) {
    const cl = await pool.query(
      `SELECT reg.regulation_code, o.obligation_code, o.title AS clause_title,
              od.awaiting_review, od.link_method, od.linked_by, od.linked_at
         FROM obligation_documents od
         JOIN obligations o   ON o.id = od.obligation_id AND o.status = 'applicable'
         JOIN regulations reg ON reg.id = o.regulation_id AND reg.status = 'active'
        WHERE od.document_id = $1
     ORDER BY reg.regulation_code, o.section_order NULLS LAST,
              o.clause_sort_key NULLS LAST, o.obligation_code`,
      [doc.projected_document_id],
    );
    clauses = cl.rows;
  }

  return {
    ...doc,
    outbound_refs: outbound.rows,
    inbound_refs: inbound.rows.map((x: any) => x.from_code),
    clauses,
  };
}

/**
 * Orphans in both directions.
 *
 * missingFromMaster — on disk, not on the master list. Each is enriched with its
 *   EN sibling so the ~150 Arabic files landing on day one can be promoted in
 *   bulk rather than one at a time.
 * missingFromDisk  — on the master list, not on disk. A controlled document that
 *   has vanished from the file server is a WORSE finding than an orphan, and it
 *   falls out of the same data for free.
 */
export async function getOrphans(): Promise<{
  missingFromMaster: any[];
  missingFromDisk: any[];
}> {
  await initDocTrackerTables();

  const missingFromMaster = await pool.query(
    `SELECT d.register_code, d.base_code, d.lang, d.doc_family, d.title,
            d.file_name, d.folder,
            en.id    AS en_sibling_policy_id,
            en.title AS en_sibling_title,
            en.category AS en_sibling_category,
            en.owner_name AS en_sibling_owner
       FROM doc_tracker_documents d
       LEFT JOIN policies en ON en.policy_number = d.base_code
      WHERE d.deleted = FALSE
        AND d.policy_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM policies p WHERE p.policy_number = d.register_code
        )
   ORDER BY d.register_code`,
  );

  const missingFromDisk = await pool.query(
    `SELECT p.id AS policy_id, p.policy_number, p.title, p.status, p.owner_name
       FROM policies p
      WHERE p.policy_number LIKE 'WP-%'
        AND NOT EXISTS (
          SELECT 1 FROM doc_tracker_documents d
           WHERE d.register_code = p.policy_number AND d.deleted = FALSE
        )
   ORDER BY p.policy_number`,
  );

  return {
    missingFromMaster: missingFromMaster.rows,
    missingFromDisk: missingFromDisk.rows,
  };
}

/** Cross-reference graph for the whole library. */
export async function getRefGraph(): Promise<{ nodes: any[]; edges: any[] }> {
  await initDocTrackerTables();
  const nodes = await pool.query(
    `SELECT register_code, doc_family, lang, title, dangling_count
       FROM doc_tracker_documents WHERE deleted = FALSE ORDER BY register_code`,
  );
  const edges = await pool.query(
    `SELECT from_code, to_code, resolved FROM doc_tracker_refs ORDER BY from_code, to_code`,
  );
  return { nodes: nodes.rows, edges: edges.rows };
}

/** Ingest history — the audit trail of what the collector pushed and when. */
export async function listSnapshots(limit = 50): Promise<any[]> {
  await initDocTrackerTables();
  const r = await pool.query(
    `SELECT id, collector_id, snapshot_hash, mode, status, reject_reason,
            documents_in, inserted, updated, soft_deleted, orphans, stats, created_at
       FROM doc_tracker_snapshots
   ORDER BY created_at DESC, id DESC
      LIMIT $1`,
    [Math.min(200, Math.max(1, limit))],
  );
  return r.rows;
}
