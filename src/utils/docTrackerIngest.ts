/**
 * docTrackerIngest — merge a collector snapshot into the tracker.
 *
 * CONTRACT
 *   - The collector owns FACTS (existence, code, hash, refs, issues).
 *   - The platform owns JUDGEMENT (review state, assignee, note, approval).
 *   Ingest writes collector columns by name and never touches the judgement
 *   columns. A scan that clobbers human review state is the classic way a
 *   tracker like this rots.
 *
 * FOUR SAFETY PROPERTIES, each with a matching acceptance test:
 *
 *   1. IDEMPOTENT. `snapshotHash` is recomputed SERVER-SIDE over document facts
 *      only — never over scan timestamps. Replaying an unchanged scan returns
 *      {status:'duplicate'} and writes nothing, so a 15-minute watcher cadence
 *      does not generate 300 audit rows an hour.
 *
 *   2. SERIALISED. A Postgres advisory lock wraps the merge. Two concurrent
 *      ingests without it can interleave so the second one's delete sweep
 *      removes rows the first just inserted — intermittent, data-losing, and
 *      very hard to reproduce afterwards.
 *
 *   3. SOFT DELETE + MASS-DELETION GUARD. Documents absent from the payload are
 *      marked deleted, never removed. The sweep is REFUSED outright when the
 *      payload is empty or collapses the active set by more than half: an
 *      unmounted network share or a renamed root folder would otherwise wipe
 *      every review decision on the board in a single push.
 *
 *   4. AUDIT ONLY REAL CHANGES. Both sides of the comparison go through one
 *      normaliser, because BIGINT-as-string vs number and Date vs ISO string
 *      otherwise report "everything changed" on every push forever.
 *
 * Ingest NEVER creates a `policies` row. Codes with no register entry surface as
 * orphans for a human to promote.
 */

import { createHash } from "crypto";
import { sharedPool as pool } from "./sharedPool";
import { logger } from "./logger";
import {
  initDocTrackerTables,
  countActiveDocuments,
  lastAcceptedSnapshotHash,
  recordSnapshot,
  touchCollector,
  TERMINAL_REVIEW_STATES,
  type SnapshotStatus,
} from "./docTrackerDatabase";
import {
  canonicalRegisterCode,
  normaliseLang,
  baseCodeOf,
  docFamilyOf,
  isWellFormedCode,
} from "./docTrackerCodes";

/** Advisory-lock key. Arbitrary but must stay stable across deploys. */
const INGEST_LOCK_KEY = 874_112_501;

/** Refuse the delete sweep below this fraction of the previously-active set. */
const DELETE_GUARD_RATIO = (() => {
  const raw = Number(process.env.DOC_TRACKER_DELETE_GUARD_RATIO);
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.5;
})();

/** Below this many active rows the ratio guard is not meaningful. */
const DELETE_GUARD_MIN_ACTIVE = 20;

export const MAX_DOCUMENTS_PER_SNAPSHOT = 2000;
export const MAX_REFS_PER_SNAPSHOT = 20000;

export interface IncomingDocument {
  code?: string | null;
  lang?: string | null;
  title?: string | null;
  file?: string | null;
  folder?: string | null;
  sizeKB?: number | null;
  modifiedAt?: string | null;
  contentHash?: string | null;
  codeOk?: boolean | null;
  issues?: string[] | null;
  refs?: string[] | null;
}

export interface IngestPayload {
  collectorId?: string | null;
  collectorVersion?: string | null;
  libraryRoot?: string | null;
  mode?: string | null;
  allowMassDelete?: boolean;
  documents?: IncomingDocument[];
}

export interface IngestResult {
  status: SnapshotStatus;
  snapshotId: number | null;
  snapshotHash: string;
  counts: {
    documents_in: number;
    inserted: number;
    updated: number;
    unchanged: number;
    soft_deleted: number;
    orphans: number;
    uncoded: number;
  };
  warnings: string[];
}

/**
 * The collector-owned fact tuple for one document, normalised.
 *
 * EVERYTHING that decides "did this change?" flows through here, and BOTH sides
 * (incoming payload and stored row) are normalised by the same function. Without
 * that, `size_kb` coming back from Postgres NUMERIC as the string "249.20" never
 * equals the payload's number 249.2, and every push reports every document as
 * changed.
 */
export function factTuple(d: {
  title?: any;
  file_name?: any;
  folder?: any;
  size_kb?: any;
  modified_at?: any;
  content_hash?: any;
  code_ok?: any;
  issues?: any;
}): string {
  const num = (v: any) => {
    const n = Number(v);
    return Number.isFinite(n) ? n.toFixed(2) : "";
  };
  const ts = (v: any) => {
    if (!v) return "";
    const t = v instanceof Date ? v : new Date(String(v));
    return Number.isNaN(t.getTime()) ? "" : t.toISOString();
  };
  const issues = Array.isArray(d.issues)
    ? d.issues.map((x: any) => String(x)).sort()
    : [];
  return JSON.stringify([
    String(d.title ?? ""),
    String(d.file_name ?? ""),
    String(d.folder ?? ""),
    num(d.size_kb),
    ts(d.modified_at),
    String(d.content_hash ?? ""),
    d.code_ok === false ? 0 : 1,
    issues,
  ]);
}

/**
 * Recompute the snapshot hash from document facts alone.
 *
 * Deliberately EXCLUDES collectorId, mode, scan timestamps and payload order —
 * a hash that moves every scan makes the idempotency check useless and is the
 * single easiest way to fail the zero-audit-on-replay guarantee.
 */
export function computeSnapshotHash(documents: IncomingDocument[]): string {
  const rows = documents
    .map((d) => {
      const rc = canonicalRegisterCode(d.code, d.lang) ?? `~uncoded:${d.file ?? ""}`;
      const refs = Array.isArray(d.refs) ? d.refs.map(String).sort() : [];
      return (
        rc +
        "|" +
        factTuple({
          title: d.title,
          file_name: d.file,
          folder: d.folder,
          size_kb: d.sizeKB,
          modified_at: d.modifiedAt,
          content_hash: d.contentHash,
          code_ok: d.codeOk,
          issues: d.issues,
        }) +
        "|" +
        JSON.stringify(refs)
      );
    })
    .sort();
  return createHash("sha256").update(rows.join("\n")).digest("hex");
}

/** Merge a snapshot. Serialised, idempotent, soft-delete only. */
export async function ingestSnapshot(payload: IngestPayload): Promise<IngestResult> {
  await initDocTrackerTables();

  const collectorId = String(payload.collectorId || "default").slice(0, 120);
  const documents = Array.isArray(payload.documents) ? payload.documents : [];
  const warnings: string[] = [];

  const snapshotHash = computeSnapshotHash(documents);
  const counts = {
    documents_in: documents.length,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    soft_deleted: 0,
    orphans: 0,
    uncoded: 0,
  };

  // Duplicate check BEFORE taking the lock — the common case on a watcher
  // cadence is "nothing changed", and that path must be cheap.
  const previousHash = await lastAcceptedSnapshotHash(collectorId);
  if (previousHash && previousHash === snapshotHash) {
    await touchCollector({
      collector_id: collectorId,
      collector_version: payload.collectorVersion,
      library_root: payload.libraryRoot,
      snapshot: true,
    });
    const snapshotId = await recordSnapshot({
      collector_id: collectorId,
      snapshot_hash: snapshotHash,
      mode: payload.mode ?? null,
      status: "duplicate",
      documents_in: documents.length,
    });
    return { status: "duplicate", snapshotId, snapshotHash, counts, warnings };
  }

  const client = await pool.connect();
  let status: SnapshotStatus = "applied";
  let rejectReason: string | null = null;

  try {
    // Serialise merges. Blocking (not try-lock) so a concurrent push waits
    // rather than silently skipping.
    await client.query("SELECT pg_advisory_lock($1)", [INGEST_LOCK_KEY]);

    const activeBefore = await countActiveDocuments(collectorId);

    // Load existing rows once; comparing in memory avoids a round trip per
    // document and lets one normaliser judge both sides.
    const existingRes = await client.query(
      `SELECT register_code, title, file_name, folder, size_kb, modified_at,
              content_hash, code_ok, issues, review_state, hash_at_review, deleted
         FROM doc_tracker_documents`,
    );
    const existing = new Map<string, any>();
    for (const row of existingRes.rows) existing.set(row.register_code, row);

    const seen: string[] = [];
    const changedCodes: string[] = [];

    for (const d of documents) {
      const registerCode = canonicalRegisterCode(d.code, d.lang);
      if (!registerCode) {
        // An uncoded file is a finding, not something to invent a code for.
        counts.uncoded++;
        continue;
      }
      seen.push(registerCode);

      const lang = normaliseLang(d.lang);
      const incoming = {
        title: d.title ?? null,
        file_name: d.file ?? null,
        folder: d.folder ?? null,
        size_kb: d.sizeKB ?? null,
        modified_at: d.modifiedAt ?? null,
        content_hash: d.contentHash ?? null,
        code_ok:
          d.codeOk === undefined || d.codeOk === null
            ? isWellFormedCode(d.code)
            : !!d.codeOk,
        issues: Array.isArray(d.issues) ? d.issues : [],
      };

      const prev = existing.get(registerCode);
      const refs = Array.isArray(d.refs) ? d.refs.map(String) : [];

      if (!prev) {
        await client.query(
          `INSERT INTO doc_tracker_documents
             (register_code, base_code, lang, doc_family, title, file_name, folder,
              size_kb, modified_at, content_hash, code_ok, issues,
              ref_count, collector_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14)
           ON CONFLICT (register_code) DO NOTHING`,
          [
            registerCode,
            baseCodeOf(registerCode),
            lang,
            docFamilyOf(d.code ?? registerCode),
            incoming.title,
            incoming.file_name,
            incoming.folder,
            incoming.size_kb,
            incoming.modified_at,
            incoming.content_hash,
            incoming.code_ok,
            JSON.stringify(incoming.issues),
            refs.length,
            collectorId,
          ],
        );
        counts.inserted++;
        changedCodes.push(registerCode);
        continue;
      }

      // Unchanged? Touch nothing — not even updated_at, so the board does not
      // shimmer on every watcher tick.
      if (factTuple(prev) === factTuple(incoming) && prev.deleted === false) {
        counts.unchanged++;
        continue;
      }

      // A document edited after it was reviewed is no longer reviewed. This is
      // the control that keeps the tracker honest: a row that says "approved"
      // while its bytes have changed underneath looks complete and is not.
      const nowStale =
        TERMINAL_REVIEW_STATES.includes(prev.review_state) &&
        !!prev.hash_at_review &&
        prev.hash_at_review !== incoming.content_hash;

      await client.query(
        `UPDATE doc_tracker_documents
            SET base_code = $2, lang = $3, doc_family = $4, title = $5,
                file_name = $6, folder = $7, size_kb = $8, modified_at = $9,
                content_hash = $10, code_ok = $11, issues = $12::jsonb,
                ref_count = $13, collector_id = $14,
                deleted = FALSE, deleted_at = NULL,
                updated_at = CURRENT_TIMESTAMP
          WHERE register_code = $1`,
        [
          registerCode,
          baseCodeOf(registerCode),
          lang,
          docFamilyOf(d.code ?? registerCode),
          incoming.title,
          incoming.file_name,
          incoming.folder,
          incoming.size_kb,
          incoming.modified_at,
          incoming.content_hash,
          incoming.code_ok,
          JSON.stringify(incoming.issues),
          refs.length,
          collectorId,
        ],
      );
      counts.updated++;
      changedCodes.push(registerCode);
      if (nowStale) warnings.push(`stale_since_review:${registerCode}`);
    }

    // ── Cross-references ────────────────────────────────────────────────
    // Rebuilt wholesale: they are pure collector facts with no human layer,
    // and the set is small.
    const allRefs: Array<[string, string]> = [];
    for (const d of documents) {
      const from = canonicalRegisterCode(d.code, d.lang);
      if (!from || !Array.isArray(d.refs)) continue;
      for (const to of d.refs.slice(0, 200)) {
        const target = String(to || "").trim().toUpperCase();
        if (target) allRefs.push([from, target]);
      }
    }
    if (allRefs.length <= MAX_REFS_PER_SNAPSHOT) {
      const seenSet = new Set(seen.map((s) => baseCodeOf(s)));
      await client.query(`DELETE FROM doc_tracker_refs`);
      for (const [from, to] of allRefs) {
        await client.query(
          `INSERT INTO doc_tracker_refs (from_code, to_code, resolved)
           VALUES ($1,$2,$3)
           ON CONFLICT (from_code, to_code) DO UPDATE SET resolved = EXCLUDED.resolved`,
          [from, to, seenSet.has(baseCodeOf(to))],
        );
      }
      await client.query(
        `UPDATE doc_tracker_documents d
            SET dangling_count = COALESCE((
                  SELECT COUNT(*) FROM doc_tracker_refs r
                   WHERE r.from_code = d.register_code AND r.resolved = FALSE
                ), 0)`,
      );
    } else {
      warnings.push("refs_skipped_too_many");
    }

    // ── Absent documents: soft delete, behind the guard ──────────────────
    const guardTripped =
      documents.length === 0 ||
      (activeBefore >= DELETE_GUARD_MIN_ACTIVE &&
        seen.length < DELETE_GUARD_RATIO * activeBefore);

    if (guardTripped && payload.allowMassDelete !== true) {
      status = "partial";
      rejectReason = "mass_deletion_guard";
      warnings.push(
        `mass_deletion_guard: payload had ${seen.length} coded document(s) vs ${activeBefore} active — sweep skipped`,
      );
      logger.warn(
        `⚠️ [DocTracker] mass-deletion guard tripped (in=${seen.length}, active=${activeBefore}) — inserts/updates applied, sweep skipped`,
      );
    } else if (seen.length > 0) {
      const del = await client.query(
        `UPDATE doc_tracker_documents
            SET deleted = TRUE, deleted_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
          WHERE deleted = FALSE
            AND collector_id = $1
            AND register_code <> ALL($2::text[])
          RETURNING register_code`,
        [collectorId, seen],
      );
      counts.soft_deleted = del.rowCount || 0;
      for (const r of del.rows) changedCodes.push(r.register_code);
    }

    // ── Orphans: coded documents with no register entry ──────────────────
    if (seen.length > 0) {
      const orph = await client.query(
        `SELECT COUNT(*)::int AS n
           FROM doc_tracker_documents d
          WHERE d.deleted = FALSE
            AND d.policy_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM policies p WHERE p.policy_number = d.register_code
            )`,
      );
      counts.orphans = orph.rows[0]?.n || 0;

      // Resolve newly-matched register entries. Ingest never CREATES a policy —
      // it only links to one that already exists.
      await client.query(
        `UPDATE doc_tracker_documents d
            SET policy_id = p.id
           FROM policies p
          WHERE p.policy_number = d.register_code
            AND d.policy_id IS DISTINCT FROM p.id`,
      );
    }

    const snapshotId = await recordSnapshot({
      collector_id: collectorId,
      snapshot_hash: snapshotHash,
      mode: payload.mode ?? null,
      status,
      reject_reason: rejectReason,
      documents_in: documents.length,
      inserted: counts.inserted,
      updated: counts.updated,
      soft_deleted: counts.soft_deleted,
      orphans: counts.orphans,
      stats: { activeBefore, seen: seen.length, uncoded: counts.uncoded },
    });

    await touchCollector({
      collector_id: collectorId,
      collector_version: payload.collectorVersion,
      library_root: payload.libraryRoot,
      snapshot: true,
    });

    // One audit entry per ingest that actually changed something. Per-document
    // events would mean 300 rows per push; the snapshot row carries the detail.
    if (changedCodes.length > 0) {
      try {
        const { logEvent } = await import("./eventLogsDatabase");
        await logEvent({
          actionType: "UPDATE",
          entityType: "SYSTEM",
          entityName: "doc_tracker_documents",
          description:
            `Documentation tracker snapshot ${status}: ` +
            `${counts.inserted} new, ${counts.updated} updated, ` +
            `${counts.soft_deleted} removed (collector ${collectorId})`,
          module: "compliance",
          severity: status === "partial" ? "WARNING" : "INFO",
          userEmail: `collector:${collectorId}`,
        });
      } catch {
        /* never block ingest on audit */
      }
    }

    return { status, snapshotId, snapshotHash, counts, warnings };
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [INGEST_LOCK_KEY]);
    } catch {
      /* connection is being released anyway */
    }
    client.release();
  }
}
