/**
 * docTrackerAttach — draft → approved replacement, and orphan promotion.
 *
 * WHY THIS IS THE PHASE THAT MATTERS
 * `controlledDocumentRegistry` seeds 154 WP-* register entries with
 * file_path = NULL, so their projection into the mapping pool carries only the
 * register's own blurb ("Controlled document (WP-…) — pending file upload") and
 * is marked extraction_status='placeholder'. Everything downstream is therefore
 * meaningless: "Suggest Documents" had nothing to rank, coverage percentages
 * were computed from empty files, and the AI findings judged boilerplate.
 *
 * Attaching the approved file is what fixes all of it at once:
 *
 *   save under the 'policies' module
 *     → updatePolicy(file_path, file_name, file_size, file_mime_type, version)
 *       → policy_versions row written automatically when the version changes,
 *         so the draft→approved replacement carries a continuous audit trail
 *         with NO new bookkeeping (policyDatabase.ts)
 *     → syncPolicyToMapping(semantic:false)
 *       → real text extracted, projection flips off 'placeholder',
 *         citation-based clause mapping runs (deterministic and free)
 *
 * The document keeps its WP code and identity throughout — same register row,
 * new version. Nothing is superseded or duplicated.
 *
 * LLM semantic mapping deliberately stays OFF here: it is on-demand via
 * "Map all frameworks" so a bulk sync cannot silently spend tokens across
 * hundreds of documents × eight frameworks.
 */

import { sharedPool as pool } from "./sharedPool";
import { logger } from "./logger";
import { initDocTrackerTables } from "./docTrackerDatabase";
import {
  baseCodeOf,
  docFamilyOf,
  policyDocumentTypeFor,
  type DocFamily,
} from "./docTrackerCodes";

export interface AttachResult {
  register_code: string;
  policy_id: number;
  projected_document_id: number | null;
  version: string | null;
  status: "attached" | "unchanged" | "orphan" | "error";
  reason?: string;
}

/** Next version string for a draft→approved replacement. 1.0 → 1.1 → 1.2 … */
export function nextVersion(current?: string | null): string {
  const raw = String(current ?? "").trim();
  const m = /^(\d+)\.(\d+)$/.exec(raw);
  if (!m) return "1.1";
  return `${m[1]}.${parseInt(m[2], 10) + 1}`;
}

/**
 * Attach an approved file to the register entry behind a tracker row.
 *
 * Returns `orphan` (without writing) when the register entry does not exist —
 * this path NEVER creates a policy. Promotion is a separate, explicit,
 * human-initiated act (`promoteOrphan` below).
 */
export async function attachApprovedFile(opts: {
  registerCode: string;
  buffer: Buffer;
  originalName: string;
  mimeType: string;
  uploadedBy: string;
  /** Skip the write when the stored content hash already matches. */
  contentHash?: string | null;
}): Promise<AttachResult> {
  await initDocTrackerTables();
  const registerCode = opts.registerCode.toUpperCase();

  const trk = await pool.query(
    `SELECT d.id, d.policy_id, d.content_hash, p.version, p.file_path
       FROM doc_tracker_documents d
       LEFT JOIN policies p ON p.id = d.policy_id
      WHERE d.register_code = $1`,
    [registerCode],
  );
  if (trk.rows.length === 0) {
    return {
      register_code: registerCode,
      policy_id: 0,
      projected_document_id: null,
      version: null,
      status: "error",
      reason: "unknown_register_code",
    };
  }
  const row = trk.rows[0];
  if (!row.policy_id) {
    return {
      register_code: registerCode,
      policy_id: 0,
      projected_document_id: null,
      version: null,
      status: "orphan",
      reason: "not_on_master_list",
    };
  }

  const { validateFile, saveUploadedFile } = await import("./fileUpload");
  const validation = validateFile(
    opts.originalName,
    opts.buffer.length,
    opts.mimeType,
    opts.buffer,
  );
  if (!validation.valid) {
    return {
      register_code: registerCode,
      policy_id: row.policy_id,
      projected_document_id: null,
      version: row.version ?? null,
      status: "error",
      reason: validation.error || "invalid_file",
    };
  }

  // Stored under the 'policies' module so /api/policies/:id/download and
  // /view resolve the same blob as the rest of the register.
  const fileInfo = await saveUploadedFile(
    opts.buffer,
    opts.originalName,
    opts.mimeType,
    "policies",
  );

  const version = nextVersion(row.version);
  const { updatePolicy } = await import("./policyDatabase");
  await updatePolicy(
    row.policy_id,
    {
      file_path: fileInfo.filePath,
      file_name: fileInfo.fileName,
      file_size: fileInfo.fileSize,
      file_mime_type: fileInfo.mimeType,
      // Bumping the version is what makes policyDatabase write the
      // policy_versions row — the audit trail for the replacement.
      version,
    } as any,
    opts.uploadedBy,
  );

  // Re-project: extracts the real text, clears 'placeholder', runs the
  // deterministic citation pass. Best-effort — the file is attached either way.
  let projectedId: number | null = null;
  try {
    const { syncPolicyToMapping } = await import("./policyMappingBridge");
    const res = await syncPolicyToMapping(row.policy_id, { semantic: false });
    projectedId = res.projected_document_id ?? null;
  } catch (err) {
    logger.warn(
      `[docTrackerAttach] projection failed for ${registerCode}: ${(err as Error).message}`,
    );
  }

  await pool.query(
    `UPDATE doc_tracker_documents
        SET projected_document_id = $2, updated_at = CURRENT_TIMESTAMP
      WHERE register_code = $1`,
    [registerCode, projectedId],
  );

  try {
    const { logEvent } = await import("./eventLogsDatabase");
    await logEvent({
      actionType: "UPDATE",
      entityType: "DOCUMENT",
      entityId: String(row.policy_id),
      entityName: registerCode,
      description: `Approved file attached to ${registerCode} (version ${version}) — draft replaced`,
      module: "compliance",
      severity: "INFO",
      userEmail: opts.uploadedBy,
    });
  } catch {
    /* never block on audit */
  }

  return {
    register_code: registerCode,
    policy_id: row.policy_id,
    projected_document_id: projectedId,
    version,
    status: "attached",
  };
}

export interface PromoteResult {
  register_code: string;
  status: "promoted" | "already_linked" | "not_found" | "failed";
  policy_id?: number;
  reason?: string;
}

/**
 * Add an orphan to the controlled-document register.
 *
 * Day-one reality: the seeded set has 154 bare codes and zero "-AR" variants,
 * so every Arabic file is an orphan on the first snapshot (~150 rows). The
 * EN-sibling inheritance below is what makes that a one-click bulk action
 * instead of 150 manual form fills — without it someone would "temporarily"
 * make ingest auto-create register rows, which would destroy the property that
 * the master list is human-controlled.
 */
export async function promoteOrphan(
  registerCode: string,
  promotedBy: string,
): Promise<PromoteResult> {
  await initDocTrackerTables();
  const code = registerCode.toUpperCase();

  const trk = await pool.query(
    `SELECT d.register_code, d.base_code, d.lang, d.doc_family, d.title,
            d.policy_id,
            en.title       AS en_title,
            en.category    AS en_category,
            en.owner_name  AS en_owner,
            en.owner_department AS en_dept
       FROM doc_tracker_documents d
       LEFT JOIN policies en ON en.policy_number = d.base_code
      WHERE d.register_code = $1`,
    [code],
  );
  if (trk.rows.length === 0) return { register_code: code, status: "not_found" };
  const d = trk.rows[0];
  if (d.policy_id) {
    return { register_code: code, status: "already_linked", policy_id: d.policy_id };
  }

  const family: DocFamily | null = d.doc_family || docFamilyOf(code);
  const isArabic = String(d.lang || "EN").toUpperCase() === "AR";
  const title =
    (isArabic && d.en_title ? `${d.en_title} (Arabic)` : d.title || d.en_title) ||
    `${code} — pending title`;

  try {
    const ins = await pool.query(
      `INSERT INTO policies
         (policy_number, title, description, category, version, status,
          owner_name, owner_department, document_type, document_number, created_by)
       VALUES ($1,$2,$3,$4,'1.0','draft',$5,$6,$7,$1,$8)
       ON CONFLICT (policy_number) DO NOTHING
       RETURNING id`,
      [
        code,
        String(title).slice(0, 500),
        `Promoted to the controlled-document register from the Documentation Tracker by ${promotedBy}. Discovered on the file server as ${d.register_code}.`,
        d.en_category || "compliance",
        d.en_owner || null,
        d.en_dept || null,
        policyDocumentTypeFor(family),
        promotedBy,
      ],
    );

    // Someone may have promoted concurrently — re-select and proceed
    // idempotently rather than failing.
    let policyId: number | undefined = ins.rows[0]?.id;
    if (!policyId) {
      const again = await pool.query(
        `SELECT id FROM policies WHERE policy_number = $1`,
        [code],
      );
      policyId = again.rows[0]?.id;
    }
    if (!policyId) return { register_code: code, status: "failed", reason: "insert_failed" };

    let projectedId: number | null = null;
    try {
      const { syncPolicyToMapping } = await import("./policyMappingBridge");
      const res = await syncPolicyToMapping(policyId, { semantic: false });
      projectedId = res.projected_document_id ?? null;
    } catch {
      /* projection is best-effort; the register row exists either way */
    }

    await pool.query(
      `UPDATE doc_tracker_documents
          SET policy_id = $2, projected_document_id = $3,
              promoted_from_orphan = TRUE, promoted_at = CURRENT_TIMESTAMP,
              promoted_by = $4, updated_at = CURRENT_TIMESTAMP
        WHERE register_code = $1`,
      [code, policyId, projectedId, promotedBy],
    );

    return { register_code: code, status: "promoted", policy_id: policyId };
  } catch (err) {
    logger.error(`[docTrackerAttach] promote failed for ${code}:`, err);
    return { register_code: code, status: "failed", reason: (err as Error).message };
  }
}

export const MAX_BULK_PROMOTE = 200;

/**
 * Promote many orphans at once. Emits ONE summary audit event rather than 200 —
 * a per-row event storm buries the signal it is meant to provide.
 */
export async function promoteOrphansBulk(
  registerCodes: string[],
  promotedBy: string,
): Promise<{ results: PromoteResult[]; promoted: number }> {
  const codes = registerCodes.slice(0, MAX_BULK_PROMOTE);
  const results: PromoteResult[] = [];
  for (const code of codes) {
    results.push(await promoteOrphan(code, promotedBy));
  }
  const promoted = results.filter((r) => r.status === "promoted").length;

  if (promoted > 0) {
    try {
      const { logEvent } = await import("./eventLogsDatabase");
      await logEvent({
        actionType: "CREATE",
        entityType: "SYSTEM",
        entityName: "doc_tracker_promote_bulk",
        description: `Promoted ${promoted} document(s) to the controlled-document register from the Documentation Tracker`,
        module: "compliance",
        severity: "INFO",
        userEmail: promotedBy,
      });
    } catch {
      /* never block on audit */
    }
  }
  return { results, promoted };
}

/**
 * Re-run the projection for a document whose register entry exists but which was
 * never projected into the mapping pool ('unprojected'). Cheap and safe: with
 * semantic:false and no text the bridge returns before any LLM call.
 */
export async function projectDocument(
  registerCode: string,
): Promise<{ register_code: string; projected_document_id: number | null; status: string }> {
  await initDocTrackerTables();
  const code = registerCode.toUpperCase();
  const r = await pool.query(
    `SELECT policy_id FROM doc_tracker_documents WHERE register_code = $1`,
    [code],
  );
  const policyId = r.rows[0]?.policy_id;
  if (!policyId) {
    return { register_code: code, projected_document_id: null, status: "orphan" };
  }
  const { syncPolicyToMapping } = await import("./policyMappingBridge");
  const res = await syncPolicyToMapping(policyId, { semantic: false });
  const projectedId = res.projected_document_id ?? null;
  await pool.query(
    `UPDATE doc_tracker_documents
        SET projected_document_id = $2, updated_at = CURRENT_TIMESTAMP
      WHERE register_code = $1`,
    [code, projectedId],
  );
  return { register_code: code, projected_document_id: projectedId, status: res.status };
}

/** Set review state. Platform-owned — ingest never touches these columns. */
export async function setReviewState(opts: {
  registerCode: string;
  reviewState: string;
  assigneeEmail?: string | null;
  note?: string | null;
  reviewedBy: string;
}): Promise<{ ok: boolean; reason?: string; row?: any }> {
  await initDocTrackerTables();
  const { DOC_REVIEW_STATES, TERMINAL_REVIEW_STATES } = await import(
    "./docTrackerDatabase"
  );
  const code = opts.registerCode.toUpperCase();
  const state = String(opts.reviewState || "").toLowerCase();
  if (!(DOC_REVIEW_STATES as string[]).includes(state)) {
    return { ok: false, reason: "invalid_review_state" };
  }

  const before = await pool.query(
    `SELECT review_state, content_hash, hash_at_review
       FROM doc_tracker_documents WHERE register_code = $1`,
    [code],
  );
  if (before.rows.length === 0) return { ok: false, reason: "not_found" };
  const prev = before.rows[0];

  // Settling on a terminal state stamps the hash the judgement was made
  // against — that is what lets a later edit flip the row to stale. Returning
  // to 'unreviewed' clears it, which clears the stale flag with it.
  const isTerminal = (TERMINAL_REVIEW_STATES as string[]).includes(state);
  const hashAtReview = isTerminal
    ? prev.content_hash
    : state === "unreviewed"
      ? null
      : prev.hash_at_review;

  const upd = await pool.query(
    `UPDATE doc_tracker_documents
        SET review_state   = $2,
            assignee_email = COALESCE($3, assignee_email),
            note           = COALESCE($4, note),
            hash_at_review = $5,
            reviewed_at    = CASE WHEN $6 THEN CURRENT_TIMESTAMP ELSE reviewed_at END,
            reviewed_by    = CASE WHEN $6 THEN $7 ELSE reviewed_by END,
            updated_at     = CURRENT_TIMESTAMP
      WHERE register_code = $1
  RETURNING *`,
    [
      code,
      state,
      opts.assigneeEmail ?? null,
      opts.note ?? null,
      hashAtReview,
      isTerminal,
      opts.reviewedBy,
    ],
  );

  // Real human judgement — every change belongs in the audit trail with both
  // sides recorded.
  try {
    const { logEvent } = await import("./eventLogsDatabase");
    await logEvent({
      actionType: "STATUS_CHANGE",
      entityType: "DOCUMENT",
      entityName: code,
      description: `Documentation tracker review: ${prev.review_state} → ${state}`,
      oldValue: prev.review_state,
      newValue: state,
      module: "compliance",
      severity: "INFO",
      userEmail: opts.reviewedBy,
    });
  } catch {
    /* never block on audit */
  }

  // Push the single changed row to any open board so a second reviewer sees the
  // state move without waiting for their poll.
  try {
    const { broadcast } = await import("./docTrackerStream");
    broadcast("document", { register_code: code, review_state: state });
  } catch {
    /* fan-out is best-effort */
  }

  return { ok: true, row: upd.rows[0] };
}
