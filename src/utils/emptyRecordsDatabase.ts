import { pool } from "./duplicateRadarDatabase";
import { logger } from "./logger";
import {
  classifyDeal,
  classifyAccount,
  classifyContact,
  testKeywordLikePatterns,
  isProtectedDealStage,
  isJunkOrTestName,
  isTestOrPlaceholderName,
} from "./emptyRecordsDetection";

export interface EmptyRecordRow {
  zohoId: string;
  name: string;
  owner: string | null;
  reason: "orphaned" | "empty" | "test" | "junk";
  deleteEligible: boolean;
  linkEligible?: boolean;
  extra?: Record<string, any>;
}

const CAP = 500;
const LIKES = testKeywordLikePatterns();
const EMPTY_DELETE_TAG = process.env.EMPTY_DELETE_TAG || "Empty-Delete";

// Delete tags that mean "this record is already queued for the Zoho admin to
// delete" — showing them in the cleanup list is double work (Ahmad 2026-06-26).
// EMPTY_DELETE_TAG (Empty-Delete) is set by this tab; Duplicate-Delete is set by
// the duplicate-resolution flow. Extend without code via env EMPTY_DELETE_EXCLUDE_TAGS.
const DELETE_TAGS = [
  EMPTY_DELETE_TAG,
  "Duplicate-Delete",
  ...String(process.env.EMPTY_DELETE_EXCLUDE_TAGS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
];

// SQL fragment shared by all three queries: drop any record the operator has
// already tagged for deletion — via the in-platform ledger (immediate effect)
// OR whose freshly-synced Zoho Tag array already carries a delete tag
// (Empty-Delete / Duplicate-Delete). Either way a tagged record never shows.
//
// The last clause closes the STALE-MIRROR gap (Ahmad 2026-06-27): a record just
// tagged Duplicate-Delete by the merge/resolution flow won't have its synced Tag
// updated until the next full sync, so the Tag check above can't see it. But the
// merge flow writes the duplicate's Zoho id to duplicate_resolution_ledger at
// apply time (sync-independent), so we also exclude anything listed there. This
// removes Duplicate-Delete accounts/deals/contacts from the cleansing list the
// moment they're merged, not a sync later.
const NOT_ALREADY_TAGGED = `
  AND %ALIAS%zoho_record_id NOT IN (SELECT zoho_record_id FROM empty_delete_ledger)
  AND %ALIAS%zoho_record_id NOT IN (SELECT zoho_record_id FROM empty_records_dismissed)
  AND %ALIAS%zoho_record_id NOT IN (
    SELECT dz FROM duplicate_resolution_ledger drl
    CROSS JOIN LATERAL jsonb_array_elements_text(drl.duplicate_zoho_ids) AS dz
    WHERE dz IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(%ALIAS%raw_data->'Tag') = 'array'
           THEN %ALIAS%raw_data->'Tag' ELSE '[]'::jsonb END
    ) AS _dt
    WHERE _dt->>'name' = ANY($2::text[])
  )`;
const excl = (alias: string) => NOT_ALREADY_TAGGED.replace(/%ALIAS%/g, alias);

/** Dismiss flagged records as "reviewed — keep" (false positives, e.g. a deal
 * that actually has data). They drop off the cleanup list and never reappear.
 * Idempotent. */
export async function markEmptyRecordsDismissed(
  module: string,
  zohoIds: string[],
  by: string | null,
): Promise<void> {
  const ids = (zohoIds || []).map((s) => String(s)).filter(Boolean);
  if (!ids.length) return;
  await pool.query(
    `INSERT INTO empty_records_dismissed (zoho_record_id, module, dismissed_by)
       SELECT UNNEST($1::text[]), $2, $3
       ON CONFLICT (zoho_record_id) DO NOTHING`,
    [ids, module, by],
  );
}

/** Undo a dismissal (the record returns to the cleanup list on next load). */
export async function undismissEmptyRecords(zohoIds: string[]): Promise<void> {
  const ids = (zohoIds || []).map((s) => String(s)).filter(Boolean);
  if (!ids.length) return;
  await pool.query(
    `DELETE FROM empty_records_dismissed WHERE zoho_record_id = ANY($1::text[])`,
    [ids],
  );
}

/** Mark records as Empty-Delete-tagged locally so the cleanup list drops them
 * immediately (before the slow full sync catches up). Idempotent. */
export async function markEmptyDeleteTagged(
  module: string,
  zohoIds: string[],
  by: string | null,
): Promise<void> {
  const ids = (zohoIds || []).map((s) => String(s)).filter(Boolean);
  if (!ids.length) return;
  await pool.query(
    `INSERT INTO empty_delete_ledger (zoho_record_id, module, tagged_by, status)
       SELECT UNNEST($1::text[]), $2, $3, 'pending_delete'
       ON CONFLICT (zoho_record_id) DO UPDATE SET status='pending_delete', deleted_at=NULL`,
    [ids, module, by],
  );
}

/** Undo the local mark (operator removed the Empty-Delete tag). */
export async function unmarkEmptyDeleteTagged(zohoIds: string[]): Promise<void> {
  const ids = (zohoIds || []).map((s) => String(s)).filter(Boolean);
  if (!ids.length) return;
  await pool.query(
    `DELETE FROM empty_delete_ledger WHERE zoho_record_id = ANY($1::text[])`,
    [ids],
  );
}

/** Zoho signals a record is already gone via a not-found, an INVALID_DATA code,
 * or the "related id given seems to be invalid" message on a by-id/attachments
 * fetch. Any of those means the record was deleted in Zoho → it's a ghost in our
 * mirror and should be pruned, not surfaced as a red error. */
export function isZohoGhostError(x: unknown): boolean {
  const s = (x instanceof Error ? x.message : String(x ?? "")).toLowerCase();
  return (
    s.includes("record not found") ||
    s.includes("invalid_data") ||
    s.includes("the related id given seems to be invalid")
  );
}

/** Remove ghost records (deleted in Zoho) from the local mirror + the
 * Empty-Delete ledger so they disappear from every Radar view. The platform
 * never deletes in Zoho — this only cleans up our copy of already-gone records. */
export async function pruneGhostRecords(zohoIds: string[]): Promise<void> {
  const ids = (zohoIds || []).map(String).filter(Boolean);
  if (!ids.length) return;
  await pool.query(
    `DELETE FROM duplicate_records WHERE zoho_record_id = ANY($1::text[])`,
    [ids],
  );
  await pool.query(
    `DELETE FROM empty_delete_ledger WHERE zoho_record_id = ANY($1::text[])`,
    [ids],
  );
}

// Deals: orphaned (no Account) OR a coarse test-name match. JS classifier refines.
export async function getEmptyDeals(): Promise<EmptyRecordRow[]> {
  const q = await pool.query(
    `SELECT zoho_record_id, record_name, owner_name,
            COALESCE(deal_value, 0) AS amount,
            raw_data->'Account_Name'->>'id' AS account_id,
            raw_data->'Contact_Name'->>'id' AS contact_id,
            COALESCE(NULLIF(stage,''), raw_data->>'Stage') AS stage,
            created_date AS created
       FROM duplicate_records
      WHERE record_type='deal'
        AND ( COALESCE(NULLIF(raw_data->'Account_Name'->>'id',''), NULL) IS NULL
              OR record_name ILIKE ANY($1::text[]) )
        ${excl("")}
        -- Active-merchant deals are NOT empty cleanup candidates — keep them out
        -- (Ahmad 2026-06-30). These two stages mean a live merchant relationship.
        -- NB: this is the ONLY marketplace-related exclusion — the broad layout
        -- hide was reverted so the rest of the deals stay reviewable.
        AND LOWER(COALESCE(NULLIF(stage,''), raw_data->>'Stage', '')) NOT IN ('partner active', 'welcome communication email')
      ORDER BY modified_date DESC NULLS LAST
      LIMIT 4000`,
    [LIKES, DELETE_TAGS],
  );
  const out: EmptyRecordRow[] = [];
  for (const r of q.rows) {
    const c = classifyDeal({
      hasAccount: !!(r.account_id && String(r.account_id).trim()),
      hasContact: !!(r.contact_id && String(r.contact_id).trim()),
      amount: Number(r.amount) || 0,
      name: r.record_name || "",
      hasAttachments: false,
      stage: r.stage || null,
    });
    if (!c.reason) continue;
    // Operator decision (Ahmad 2026-06-26): a deal that has REAL data but is just
    // missing its Account ("orphaned"/linkEligible) belongs in Account Hints,
    // which already infers the right account. Only TRULY empty (no account, no
    // contact, no amount) and TEST deals stay on the cleanup tab.
    if (c.reason === "orphaned") continue;
    out.push({
      zohoId: r.zoho_record_id,
      name: r.record_name || "",
      owner: r.owner_name || null,
      reason: c.reason,
      // Like Accounts: a test-named deal is delete-ready immediately; a merely
      // "empty" deal must pass the per-row "Check documents" live verification
      // (no account/contact/docs) before its checkbox enables.
      deleteEligible: c.reason === "test",
      linkEligible: c.linkEligible,
      extra: {
        amount: Number(r.amount) || 0,
        hasContact: !!r.contact_id,
        stage: r.stage ? String(r.stage) : "",
        created: r.created ? new Date(r.created).toISOString() : "",
      },
    });
    if (out.length >= CAP) break;
  }
  return out;
}

// Accounts: structurally empty (no deal/contact references it) OR test-name.
export async function getEmptyAccounts(): Promise<EmptyRecordRow[]> {
  const q = await pool.query(
    `WITH linked AS (
        SELECT DISTINCT raw_data->'Account_Name'->>'id' AS aid
          FROM duplicate_records
         WHERE record_type IN ('deal','contact')
           AND raw_data->'Account_Name'->>'id' IS NOT NULL
           AND raw_data->'Account_Name'->>'id' <> ''
     )
     SELECT a.zoho_record_id, a.record_name, a.account_name, a.owner_name,
            (a.zoho_record_id NOT IN (SELECT aid FROM linked)) AS structurally_empty,
            COALESCE(NULLIF(a.email,''), a.raw_data->>'Email') AS email
       FROM duplicate_records a
      WHERE a.record_type='account'
        AND ( a.zoho_record_id NOT IN (SELECT aid FROM linked)
              OR a.record_name ILIKE ANY($1::text[])
              OR a.account_name ILIKE ANY($1::text[]) )
        ${excl("a.")}
      ORDER BY a.modified_date DESC NULLS LAST
      LIMIT 4000`,
    [LIKES, DELETE_TAGS],
  );
  const out: EmptyRecordRow[] = [];
  for (const r of q.rows) {
    const name = r.record_name || r.account_name || "";
    const c = classifyAccount({
      hasDeals: !r.structurally_empty, // structurally_empty=false → it HAS a link
      hasContacts: !r.structurally_empty,
      name,
      hasEmail: !!(r.email && String(r.email).trim()),
      hasAttachments: false,
    });
    if (!c.reason) continue;
    out.push({
      zohoId: r.zoho_record_id,
      name,
      owner: r.owner_name || null,
      reason: c.reason,
      // Structurally-empty accounts need the lazy attachment check before delete;
      // test-named accounts are delete-eligible directly.
      deleteEligible: c.reason === "test",
      extra: { structurallyEmpty: c.structurallyEmpty, needsAttachmentCheck: c.reason === "empty" },
    });
    if (out.length >= CAP) break;
  }
  return out;
}

/**
 * SINGLE SOURCE OF TRUTH for "is this live Zoho record actually empty?". Returns
 * a non-null reason when the record has REAL data (so it must NOT be tagged), or
 * null when it is genuinely empty. Both `aiApplyEmptyDelete` (the bulk tagger) and
 * `verifyEmptyCandidates` (the per-page CRM verifier) call this, so their safety
 * gate can never drift. May THROW on a Zoho API error (incl. ghost) — callers
 * decide whether to prune (ghost) or fail-safe-skip (other).
 *
 * `data` is the already-fetched live record body (`fetchZohoRecordById(...).data`).
 * Reasons: "contact_info" | "deals" | "contacts" | "email" | "account" |
 * "documents".  NOTE: a Deal's protected-stage check is intentionally NOT here —
 * it is a "skip" but not a "has data" signal; callers handle it separately.
 */
async function liveDataReason(
  module: "Deals" | "Accounts" | "Contacts",
  id: string,
  data: any,
): Promise<string | null> {
  const { fetchZohoRelatedRecords, fetchRecordAttachments } = await import("./zohoCRM");
  const d: any = data || {};
  if (module === "Contacts") {
    if (
      d.Email ||
      d.Secondary_Email ||
      d.Phone ||
      d.Mobile ||
      (d.Account_Name && d.Account_Name.id)
    )
      return "contact_info";
    // A contact linked to ANY deal (including a partner/marketplace deal, or one
    // linked via Contact Roles rather than the deal's Contact_Name) is NOT empty.
    const cDeals = await fetchZohoRelatedRecords("Contacts", id, "Deals", { perPage: 1 });
    if (Array.isArray(cDeals) && cDeals.length > 0) return "deals";
    return null;
  }
  if (module === "Deals") {
    if (d.Account_Name && d.Account_Name.id) return "account";
    if (d.Contact_Name && d.Contact_Name.id) return "contacts";
    const atts = await fetchRecordAttachments("Deals", id);
    if (Array.isArray(atts) && atts.length > 0) return "documents";
    return null;
  }
  // Accounts
  if (d.Email || d.email) return "email";
  // The decisive check: does Zoho show ANY live deal or contact on this account
  // right now? Catches the "account has deals inside" false positive the synced
  // mirror missed (Ahmad 2026-06-26/27).
  const aDeals = await fetchZohoRelatedRecords("Accounts", id, "Deals", { perPage: 1 });
  if (Array.isArray(aDeals) && aDeals.length > 0) return "deals";
  const aContacts = await fetchZohoRelatedRecords("Accounts", id, "Contacts", { perPage: 1 });
  if (Array.isArray(aContacts) && aContacts.length > 0) return "contacts";
  const atts = await fetchRecordAttachments("Accounts", id);
  if (Array.isArray(atts) && atts.length > 0) return "documents";
  return null;
}

/**
 * AI-Apply: for each genuinely-empty candidate in the given module, verify it
 * is still live in Zoho, prune any already-deleted ghosts from the local
 * mirror, skip records holding attachments or in protected Deal stages, then
 * bulk-tag survivors with the Empty-Delete tag and record them in the ledger.
 *
 * The platform NEVER deletes in Zoho — it only tags; the admin is the final gate.
 */
export async function aiApplyEmptyDelete(
  module: "Deals" | "Accounts" | "Contacts",
  opts: { limit?: number; by: string | null },
): Promise<{
  tagged: number;
  prunedGhosts: number;
  dismissed: number;
  skippedWithDocs: number;
  skippedHasData: number;
  skippedAlreadyTagged: number;
  remaining: number;
}> {
  const { fetchZohoRecordById, addZohoTags } = await import("./zohoCRM");

  // 1. Pull candidates and keep only delete-eligible non-orphaned records.
  let allCandidates: EmptyRecordRow[];
  if (module === "Deals") allCandidates = await getEmptyDeals();
  else if (module === "Accounts") allCandidates = await getEmptyAccounts();
  else allCandidates = await getEmptyContacts();

  // orphaned = belongs in Account Hints, not delete queue
  const eligible = allCandidates.filter((r) => r.reason !== "orphaned");

  const batchSize = opts.limit ?? (Number(process.env.EMPTY_AI_APPLY_BATCH) || 150);
  const slice = eligible.slice(0, batchSize);
  const remaining = Math.max(0, eligible.length - slice.length);

  let prunedGhosts = 0;
  let skippedWithDocs = 0;
  let skippedHasData = 0;
  let skippedAlreadyTagged = 0;
  const toTag: string[] = [];
  // Records confirmed (live) to be NOT empty — has data / documents / a protected
  // stage / a merge-flow tag. We auto-Dismiss them so they drop off the cleanup
  // list and don't get re-processed on the next batch (this is what lets the
  // operator run AI-Apply batch-after-batch — or the one-click loop — to the end
  // instead of the same not-empty rows clogging the front of the queue).
  const toDismiss: string[] = [];

  // 2. Per-candidate bounded sequential loop (live Zoho calls — pace them).
  for (const candidate of slice) {
    const id = candidate.zohoId;

    // Verify the record still exists in Zoho + read its live Tag (and Stage).
    let liveRec: Awaited<ReturnType<typeof fetchZohoRecordById>> | null = null;
    try {
      liveRec = await fetchZohoRecordById(module, id);
    } catch (e) {
      if (isZohoGhostError(e)) {
        await pruneGhostRecords([id]);
        prunedGhosts++;
        continue;
      }
      logger.warn(`[aiApplyEmptyDelete] ${module} fetch error for ${id}, skipping`, e);
      continue;
    }
    if (!liveRec) {
      // null = 404/204 — ghost
      await pruneGhostRecords([id]);
      prunedGhosts++;
      continue;
    }

    const ld: any = liveRec.data || {};
    const liveTags: string[] = ((ld.Tag as any[]) || []).map(
      (t: any) => String(t?.name || ""),
    );
    if (liveTags.includes(EMPTY_DELETE_TAG)) {
      await markEmptyDeleteTagged(module, [id], opts.by);
      skippedAlreadyTagged++;
      continue; // already tagged — ledger excludes it; no dismiss needed
    }
    if (liveTags.includes("Duplicate-Delete")) {
      skippedAlreadyTagged++;
      toDismiss.push(id); // merge-flow record — not an empty; drop it off this list
      continue;
    }

    // Deals: a protected existing-client stage is a skip (not a has-data signal).
    if (module === "Deals" && isProtectedDealStage(ld.Stage || null)) {
      skippedAlreadyTagged++;
      toDismiss.push(id); // existing-client deal — never empty; drop it off
      continue;
    }

    // Shared live-emptiness gate (the SAME gate verifyEmptyCandidates uses).
    let reason: string | null;
    try {
      reason = await liveDataReason(module, id, ld);
    } catch (e) {
      if (isZohoGhostError(e)) {
        await pruneGhostRecords([id]);
        prunedGhosts++;
        continue;
      }
      // Inconclusive → fail safe: do NOT tag (leave it for a later pass).
      logger.warn(`[aiApplyEmptyDelete] ${module} live-emptiness check failed for ${id}, skipping`, e);
      continue;
    }
    if (reason === "documents") {
      skippedWithDocs++;
      toDismiss.push(id); // has documents → not empty
      continue;
    }
    if (reason) {
      skippedHasData++;
      toDismiss.push(id); // has deals/contacts/email → not empty
      continue;
    }

    toTag.push(id);
  }

  // Drop the confirmed-not-empty records off the cleanup list (durable Dismiss;
  // Zoho is never modified — un-dismiss restores them).
  if (toDismiss.length) await markEmptyRecordsDismissed(module, toDismiss, opts.by);

  // 3. Batch-tag survivors in chunks of ≤100.
  const taggedOk: string[] = [];
  const CHUNK = 100;
  for (let i = 0; i < toTag.length; i += CHUNK) {
    const chunk = toTag.slice(i, i + CHUNK);
    let result: any;
    try {
      result = await addZohoTags(module, chunk, [EMPTY_DELETE_TAG]);
    } catch (e) {
      if (isZohoGhostError(e)) {
        // Batch failed with a ghost-like error — prune the whole chunk conservatively.
        await pruneGhostRecords(chunk);
        prunedGhosts += chunk.length;
        continue;
      }
      logger.error(`[aiApplyEmptyDelete] addZohoTags failed for ${module} chunk`, e);
      continue;
    }

    // Zoho v2 add_tags returns HTTP 200 even when a record is REJECTED —
    // the truth is in each element's code/status field.
    const perRecord: any[] = Array.isArray(result) ? result : [];
    for (const rec of perRecord) {
      const recId: string = String(rec?.details?.id || rec?.id || "");
      const code: string = String(rec?.code || "").toUpperCase();
      const status: string = String(rec?.status || "").toLowerCase();
      if (!recId) continue;
      if (code === "SUCCESS" || status === "success") {
        taggedOk.push(recId);
      } else if (
        /record not found|the related id given seems to be invalid|id given seems to be invalid/i.test(
          String(rec?.message || ""),
        )
      ) {
        // Ghost detected during tag — the record was deleted in Zoho between our
        // live-verify and this tag call. Prune the local mirror. NOTE: we gate on
        // the MESSAGE, not a bare INVALID_DATA code — Zoho returns INVALID_DATA for
        // ordinary validation failures too, and pruning a just-verified-live record
        // on a non-deletion error would wrongly drop its mirror row.
        await pruneGhostRecords([recId]);
        prunedGhosts++;
      } else {
        logger.warn(`[aiApplyEmptyDelete] per-record tag rejected for ${recId}: code=${code}`, rec);
      }
    }

    // If Zoho returned no per-record array (empty/ambiguous response), do NOT
    // optimistically assume success — that would write the ledger for records
    // that may never have been tagged, dropping them off the list forever.
    // Leave them on the list; this self-heals on the next AI-Apply run: if the
    // tag DID apply, the live-tag check sees Empty-Delete and records it
    // idempotently; if it didn't, they get re-tagged. (Zoho add_tags reliably
    // returns one SUCCESS element per valid id, so empty is genuinely unusual.)
    if (perRecord.length === 0) {
      logger.warn(`[aiApplyEmptyDelete] addZohoTags returned no per-record results for ${module} chunk of ${chunk.length}; leaving on list for next run`);
    }
  }

  // 4. Record tagged ids in the ledger (idempotent).
  if (taggedOk.length > 0) {
    await markEmptyDeleteTagged(module, taggedOk, opts.by);
  }

  return {
    tagged: taggedOk.length,
    prunedGhosts,
    dismissed: toDismiss.length,
    skippedWithDocs,
    skippedHasData,
    skippedAlreadyTagged,
    remaining,
  };
}

/**
 * Live-verify a SET of candidate ids (the rows the operator currently sees on a
 * page) against Zoho — WITHOUT tagging anything. For each id it asks Zoho the same
 * question `aiApplyEmptyDelete` asks before tagging (via the shared `liveDataReason`
 * gate) and sorts the id into one of:
 *   - `empty`  — genuinely empty (confirmed: stays a delete candidate)
 *   - `keep`   — has real data (deals/contacts/email/docs) → auto-Dismissed so it
 *                drops off the cleanup list and never returns
 *   - `ghost`  — already deleted in Zoho → pruned from the local mirror
 *   - `tagged` — already carries Empty-Delete / Duplicate-Delete → dropped
 * Bounded by the caller (one visible page, ≤ a few dozen ids). The platform never
 * deletes in Zoho; "keep" only writes a local Dismiss, "ghost" only prunes our copy.
 */
export async function verifyEmptyCandidates(
  module: "Deals" | "Accounts" | "Contacts",
  zohoIds: string[],
  by: string | null,
): Promise<{
  empty: string[];
  keep: Array<{ id: string; reason: string }>;
  ghosts: string[];
  tagged: string[];
}> {
  const { fetchZohoRecordById } = await import("./zohoCRM");
  const ids = (zohoIds || []).map(String).filter(Boolean);
  const empty: string[] = [];
  const keep: Array<{ id: string; reason: string }> = [];
  const ghosts: string[] = [];
  const tagged: string[] = [];
  const emptyAlreadyTagged: string[] = []; // live Empty-Delete → move to ledger/tagged-pending
  const dupAlreadyTagged: string[] = []; // live Duplicate-Delete → merge flow owns it → dismiss

  for (const id of ids) {
    let liveRec: Awaited<ReturnType<typeof fetchZohoRecordById>> | null = null;
    try {
      liveRec = await fetchZohoRecordById(module, id);
    } catch (e) {
      if (isZohoGhostError(e)) {
        ghosts.push(id);
        continue;
      }
      logger.warn(`[verifyEmptyCandidates] ${module} fetch error for ${id}, leaving as-is`, e);
      continue;
    }
    if (!liveRec) {
      ghosts.push(id);
      continue;
    }
    const ld: any = liveRec.data || {};
    const liveTags: string[] = ((ld.Tag as any[]) || []).map((t: any) => String(t?.name || ""));
    if (liveTags.includes(EMPTY_DELETE_TAG)) {
      emptyAlreadyTagged.push(id);
      tagged.push(id);
      continue;
    }
    if (liveTags.includes("Duplicate-Delete")) {
      dupAlreadyTagged.push(id);
      tagged.push(id);
      continue;
    }
    if (module === "Deals" && isProtectedDealStage(ld.Stage || null)) {
      keep.push({ id, reason: "protected_stage" });
      continue;
    }
    let reason: string | null;
    try {
      reason = await liveDataReason(module, id, ld);
    } catch (e) {
      if (isZohoGhostError(e)) {
        ghosts.push(id);
        continue;
      }
      logger.warn(`[verifyEmptyCandidates] ${module} live-emptiness check failed for ${id}, leaving as-is`, e);
      continue;
    }
    if (reason) keep.push({ id, reason });
    else empty.push(id);
  }

  // Persist the verdicts on our side (Zoho is never modified here):
  //  - ghosts → prune from the mirror so they vanish everywhere
  //  - keep   → Dismiss ("reviewed — not empty") so they don't reappear
  if (ghosts.length) await pruneGhostRecords(ghosts);
  if (keep.length) {
    await markEmptyRecordsDismissed(module, keep.map((k) => k.id), by);
  }
  // Records already carrying Empty-Delete in LIVE Zoho (the synced mirror was
  // stale, so they slipped into the active list): record them in the ledger so
  // they MOVE to "Tagged · pending delete" and drop off this cleanup list —
  // instead of lingering here as "already tagged — keep" (Ahmad 2026-06-30).
  if (emptyAlreadyTagged.length) await markEmptyDeleteTagged(module, emptyAlreadyTagged, by);
  // Already Duplicate-Delete = the merge flow owns them → just dismiss off this list.
  if (dupAlreadyTagged.length) await markEmptyRecordsDismissed(module, dupAlreadyTagged, by);
  return { empty, keep, ghosts, tagged };
}

/**
 * Read-only single-record live emptiness check, used by the per-row
 * "Check documents" button (Accounts + Deals) — the same gate AI-Apply uses,
 * via the shared `liveDataReason`. Makes NO changes (no tag, no dismiss, no
 * prune); the caller decides what to do with the verdict.
 *   - ghost  → the record is deleted in Zoho (caller prunes the row)
 *   - tagged → already carries Empty-Delete / Duplicate-Delete
 *   - empty:true  → genuinely empty (caller marks it delete-eligible)
 *   - empty:false + reason → has data / documents / a protected stage
 */
export async function checkRecordEmptiness(
  module: "Deals" | "Accounts" | "Contacts",
  id: string,
): Promise<{ empty: boolean; reason: string | null; ghost: boolean; tagged: boolean }> {
  const { fetchZohoRecordById } = await import("./zohoCRM");
  let liveRec: Awaited<ReturnType<typeof fetchZohoRecordById>> | null = null;
  try {
    liveRec = await fetchZohoRecordById(module, id);
  } catch (e) {
    if (isZohoGhostError(e)) return { empty: false, reason: null, ghost: true, tagged: false };
    throw e;
  }
  if (!liveRec) return { empty: false, reason: null, ghost: true, tagged: false };
  const ld: any = liveRec.data || {};
  const liveTags: string[] = ((ld.Tag as any[]) || []).map((t: any) => String(t?.name || ""));
  if (liveTags.includes(EMPTY_DELETE_TAG) || liveTags.includes("Duplicate-Delete")) {
    return { empty: false, reason: "tagged", ghost: false, tagged: true };
  }
  if (module === "Deals" && isProtectedDealStage(ld.Stage || null)) {
    return { empty: false, reason: "protected_stage", ghost: false, tagged: false };
  }
  let reason: string | null;
  try {
    reason = await liveDataReason(module, id, ld);
  } catch (e) {
    if (isZohoGhostError(e)) return { empty: false, reason: null, ghost: true, tagged: false };
    throw e;
  }
  return { empty: !reason, reason: reason || null, ghost: false, tagged: false };
}

/**
 * READ-ONLY batch emptiness check — used to auto-verify a whole page of empty
 * records in ONE request (so the operator doesn't click "Check documents" per row,
 * and we don't trip the per-request rate limit by firing 50 separate calls).
 * Runs checkRecordEmptiness for each id with small concurrency. Makes NO changes
 * (no tag, dismiss, prune) — the caller updates the UI; tagging still live-verifies.
 */
export async function getEmptinessBatch(
  module: "Deals" | "Accounts" | "Contacts",
  zohoIds: string[],
): Promise<Array<{ id: string; empty: boolean; reason: string | null; ghost: boolean; tagged: boolean }>> {
  const ids = (zohoIds || []).map(String).filter(Boolean).slice(0, 60);
  const out: Array<{ id: string; empty: boolean; reason: string | null; ghost: boolean; tagged: boolean }> = [];
  const CONCURRENCY = 4;
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const chunk = ids.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (id) => {
        try {
          const r = await checkRecordEmptiness(module, id);
          return { id, ...r };
        } catch (e) {
          // Inconclusive → report as not-empty so it's never auto-marked deletable.
          logger.warn(`[getEmptinessBatch] ${module} ${id} failed`, e);
          return { id, empty: false, reason: "error", ghost: false, tagged: false };
        }
      }),
    );
    out.push(...results);
  }
  return out;
}

/** Return every row in the empty_delete_ledger (optionally filtered by module)
 * plus aggregate counts. Used by the "Tagged · pending delete" sub-section. */
export async function getTaggedStatus(module?: string): Promise<{
  rows: Array<{
    zohoId: string;
    module: string;
    status: string;
    taggedBy: string | null;
    createdAt: string;
    deletedAt: string | null;
  }>;
  counts: { tagged: number; deleted: number; pending: number; dismissed: number };
}> {
  const mod = module || null;
  const [rowsRes, countsRes] = await Promise.all([
    pool.query<{
      zoho_record_id: string;
      module: string;
      status: string;
      tagged_by: string | null;
      created_at: Date | null;
      deleted_at: Date | null;
    }>(
      `SELECT zoho_record_id, module, status, tagged_by, created_at, deleted_at
         FROM empty_delete_ledger
        WHERE ($1::text IS NULL OR module = $1)
        ORDER BY created_at DESC
        LIMIT 1000`,
      [mod],
    ),
    pool.query<{ total: string; deleted: string; pending: string; dismissed: string }>(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE status = 'deleted') AS deleted,
         COUNT(*) FILTER (WHERE status = 'pending_delete') AS pending,
         COUNT(*) FILTER (WHERE status = 'dismissed') AS dismissed
       FROM empty_delete_ledger
       WHERE ($1::text IS NULL OR module = $1)`,
      [mod],
    ),
  ]);

  const rows = rowsRes.rows.map((r) => ({
    zohoId: r.zoho_record_id,
    module: r.module,
    status: r.status,
    taggedBy: r.tagged_by ?? null,
    createdAt: r.created_at ? r.created_at.toISOString() : "",
    deletedAt: r.deleted_at ? r.deleted_at.toISOString() : null,
  }));

  const c = countsRes.rows[0];
  const counts = {
    tagged: Number(c?.total ?? 0),
    deleted: Number(c?.deleted ?? 0),
    pending: Number(c?.pending ?? 0),
    dismissed: Number(c?.dismissed ?? 0),
  };

  return { rows, counts };
}

/** Manually move ONE tagged record from the pending-delete queue to 'dismissed'
 * — a local ledger disposition only; it does NOT touch the Zoho tag. Used by the
 * per-row Dismiss button so the operator can drop a record off the pending list
 * without a Zoho round-trip. Only affects a row that is currently pending. */
export async function dismissTaggedRecord(zohoId: string): Promise<void> {
  const id = String(zohoId || "").trim();
  if (!id) return;
  await pool.query(
    `UPDATE empty_delete_ledger
        SET status = 'dismissed', last_checked_at = NOW(), deleted_at = NULL
      WHERE zoho_record_id = $1 AND status = 'pending_delete'`,
    [id],
  );
}

/** Bulk variant of dismissTaggedRecord — move MANY pending records to
 * 'dismissed' in ONE query. Used by the "Dismiss selected" button so the
 * operator can clear a whole page at once instead of firing one request per
 * row (which trips the API rate limiter → the 429 "Too many requests" error).
 * Returns how many rows actually moved (only pending_delete rows change). */
export async function dismissTaggedRecords(zohoIds: string[]): Promise<number> {
  const ids = Array.from(
    new Set((zohoIds || []).map((x) => String(x || "").trim()).filter(Boolean)),
  );
  if (ids.length === 0) return 0;
  const res = await pool.query(
    `UPDATE empty_delete_ledger
        SET status = 'dismissed', last_checked_at = NOW(), deleted_at = NULL
      WHERE zoho_record_id = ANY($1::text[]) AND status = 'pending_delete'`,
    [ids],
  );
  return res.rowCount || 0;
}

/** Check up to 300 pending_delete ledger rows against live Zoho.
 * Records no longer found → stamp as 'deleted' in the ledger + prune from
 * the local duplicate_records mirror.  Records still present → update
 * last_checked_at.  Individual errors are swallowed (best-effort).
 *
 * NOTE: The ledger row is KEPT even when the record is gone (so the
 * "Deleted ✓" badge stays visible in the UI).  Only the mirror row in
 * duplicate_records is pruned.  We do NOT call pruneGhostRecords() here
 * because that also deletes from empty_delete_ledger. */
export async function reconcileEmptyDeleteDeletions(
  module?: string,
): Promise<{ checked: number; nowDeleted: number; nowDismissed: number }> {
  const { fetchZohoRecordById } = await import("./zohoCRM");
  const mod = module || null;

  const pending = await pool.query<{ zoho_record_id: string; module: string }>(
    `SELECT zoho_record_id, module
       FROM empty_delete_ledger
      WHERE status = 'pending_delete'
        AND ($1::text IS NULL OR module = $1)
      ORDER BY last_checked_at ASC NULLS FIRST
      LIMIT 300`,
    [mod],
  );

  let checked = 0;
  let nowDeleted = 0;
  let nowDismissed = 0;

  for (const row of pending.rows) {
    const id = row.zoho_record_id;
    const rowModule = row.module;
    try {
      let rec: Awaited<ReturnType<typeof fetchZohoRecordById>>;
      try {
        rec = await fetchZohoRecordById(rowModule, id);
      } catch (e) {
        if (isZohoGhostError(e)) {
          // Ghost error → record is gone
          await pool.query(
            `UPDATE empty_delete_ledger
                SET status = 'deleted', deleted_at = NOW(), last_checked_at = NOW()
              WHERE zoho_record_id = $1`,
            [id],
          );
          // Mirror-only delete — keep the ledger row (do NOT call pruneGhostRecords)
          await pool.query(
            `DELETE FROM duplicate_records WHERE zoho_record_id = ANY(ARRAY[$1::text])`,
            [id],
          );
          nowDeleted++;
          checked++;
          continue;
        }
        // Non-ghost error: swallow, best-effort
        logger.warn(
          `[reconcileEmptyDeleteDeletions] fetch error for ${rowModule}/${id}, skipping`,
          e,
        );
        checked++;
        continue;
      }

      if (!rec) {
        // null = 404/204 — record is gone from Zoho
        await pool.query(
          `UPDATE empty_delete_ledger
              SET status = 'deleted', deleted_at = NOW(), last_checked_at = NOW()
            WHERE zoho_record_id = $1`,
          [id],
        );
        // Mirror-only delete — keep the ledger row (do NOT call pruneGhostRecords)
        await pool.query(
          `DELETE FROM duplicate_records WHERE zoho_record_id = ANY(ARRAY[$1::text])`,
          [id],
        );
        nowDeleted++;
      } else {
        // Still present in Zoho. Did the operator REMOVE the delete tag there?
        // If the record no longer carries ANY delete tag, the admin will never
        // delete it → move it OUT of pending into 'dismissed' (drops off the
        // pending queue; the ledger row is kept so it still excludes the record
        // from the cleanup list and shows under the Dismissed bucket).
        const liveTags: string[] = (((rec as any)?.data?.Tag as any[]) || []).map(
          (t: any) => String(t?.name || ""),
        );
        const stillTaggedForDelete = liveTags.some((t) => DELETE_TAGS.includes(t));
        if (!stillTaggedForDelete) {
          await pool.query(
            `UPDATE empty_delete_ledger
                SET status = 'dismissed', last_checked_at = NOW(), deleted_at = NULL
              WHERE zoho_record_id = $1`,
            [id],
          );
          nowDismissed++;
        } else {
          // Still tagged — just refresh last_checked_at
          await pool.query(
            `UPDATE empty_delete_ledger SET last_checked_at = NOW() WHERE zoho_record_id = $1`,
            [id],
          );
        }
      }
      checked++;
    } catch (e) {
      // Outer safety net — swallow anything unexpected
      logger.warn(
        `[reconcileEmptyDeleteDeletions] unexpected error for ${rowModule}/${id}, skipping`,
        e,
      );
      checked++;
    }
  }

  return { checked, nowDeleted, nowDismissed };
}

/** General deletion-reconcile: verify a ROTATING batch of duplicate_records
 * against LIVE Zoho and PRUNE the ones that are gone (deleted or merged in the
 * CRM). Incremental sync (If-Modified-Since) never reports deletions, so without
 * this a record deleted in Zoho lingers in the mirror and keeps its cluster
 * showing on every tab. Rotates by last_verified_at so repeated runs sweep the
 * whole table; bounded batch + small concurrency to stay polite with Zoho.
 * Best-effort: individual fetch errors are swallowed. */
export async function reconcileDeletedRecords(
  opts: {
    module?: string;
    limit?: number;
    activeClustersOnly?: boolean;
    clusterIds?: number[];
  } = {},
): Promise<{ checked: number; pruned: number; converted: number }> {
  const { fetchZohoRecordById } = await import("./zohoCRM");
  const mod = opts.module || null;
  const limit = Math.min(2000, Math.max(1, Math.floor(opts.limit ?? 300)));

  // activeClustersOnly (Sarah 2026-07-13): restrict the live-verify to records
  // that belong to an OPEN cluster still shown on the tabs (a few thousand),
  // instead of rotating across all ~160k records. Ghosts in VISIBLE clusters —
  // the ones users actually open and hit a 404 on — then self-prune within a
  // sync or two, oldest-verified first. Used by the post-sync auto sweep.
  const activeOnly = opts.activeClustersOnly === true;
  // clusterIds (Sarah 2026-07-15): scope the verify to SPECIFIC clusters — the
  // ones the operator is looking at right now — so the "Verify & prune deleted"
  // button gives an IMMEDIATE, observable result on the visible rows instead of
  // a rotating slice of all 160k. Params: $1=module, $2=limit, $3=clusterIds[].
  const cids = Array.isArray(opts.clusterIds)
    ? opts.clusterIds.map(Number).filter((n) => Number.isFinite(n))
    : null;
  const batch = await pool.query<{ zoho_record_id: string; record_type: string | null; zoho_module: string | null }>(
    `SELECT dr.zoho_record_id, dr.record_type, dr.zoho_module
       FROM duplicate_records dr
       ${activeOnly ? "JOIN duplicate_clusters dc ON dc.id = dr.cluster_id" : ""}
      WHERE dr.zoho_record_id IS NOT NULL AND dr.zoho_record_id <> ''
        AND ($1::text IS NULL OR dr.record_type = $1)
        ${cids && cids.length ? "AND dr.cluster_id = ANY($3::int[])" : ""}
        ${activeOnly ? "AND COALESCE(dc.status, 'active') NOT IN ('resolved', 'ignored', 'dismissed') AND dc.total_records > 1" : ""}
      ORDER BY dr.last_verified_at ASC NULLS FIRST
      LIMIT $2`,
    cids && cids.length ? [mod, limit, cids] : [mod, limit],
  );

  const moduleOf = (rt: string | null | undefined, zm: string | null | undefined): string => {
    if (zm) return zm;
    const t = (rt || "").toLowerCase();
    if (t === "deal") return "Deals";
    if (t === "contact") return "Contacts";
    if (t === "account") return "Accounts";
    return "Leads";
  };

  let checked = 0;
  let pruned = 0;
  let converted = 0;
  const CONCURRENCY = 4;
  for (let i = 0; i < batch.rows.length; i += CONCURRENCY) {
    const chunk = batch.rows.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(async (row) => {
      const id = row.zoho_record_id;
      const module = moduleOf(row.record_type, row.zoho_module);
      try {
        let rec: Awaited<ReturnType<typeof fetchZohoRecordById>> = null;
        try {
          rec = await fetchZohoRecordById(module, id);
        } catch (e) {
          if (isZohoGhostError(e)) {
            await pruneGhostRecords([id]);
            pruned++; checked++;
            return;
          }
          checked++; // transient/non-ghost error → leave it for the next pass
          return;
        }
        if (!rec) {
          await pruneGhostRecords([id]); // 204/404 — gone from Zoho
          pruned++;
        } else if (
          module === "Leads" &&
          rec.data &&
          ((rec.data as any).$converted === true ||
            (rec.data as any).$converted === "true")
        ) {
          // Converted lead (Sarah 2026-07-13): it has ALREADY become an
          // Account / Contact / Deal, so it is NOT a live "redundant lead to
          // close" — yet our mirror still shows its old Lead_Status (e.g. "New
          // Lead"), so it kept surfacing on Lead↔Active-Deal / cross-module.
          // Mark it Converted locally so isActiveLead and the cross-module
          // has_active_lead (which reads raw_data->>'Lead_Status') both drop it
          // and the cluster stops showing. jsonb_set patches the stored raw_data
          // too so the aggregation query sees it without waiting for a re-sync.
          await pool.query(
            `UPDATE duplicate_records
                SET status = 'Converted',
                    raw_data = jsonb_set(COALESCE(raw_data, '{}'::jsonb), '{Lead_Status}', '"Converted"'::jsonb, true),
                    last_verified_at = NOW()
              WHERE zoho_record_id = $1`,
            [id],
          );
          converted++;
        } else {
          await pool.query(
            `UPDATE duplicate_records SET last_verified_at = NOW() WHERE zoho_record_id = $1`,
            [id],
          );
        }
        checked++;
      } catch {
        checked++;
      }
    }));
  }

  // Pruning can leave a cluster below 2 records — drop those singleton clusters
  // so a formerly-duplicate cluster stops showing once its dups are gone.
  if (pruned > 0) {
    try {
      const db: any = await import("./duplicateRadarDatabase");
      if (typeof db.cleanupSingletonClusters === "function") await db.cleanupSingletonClusters();
    } catch { /* best-effort */ }
  }

  return { checked, pruned, converted };
}

/**
 * COMPREHENSIVE deletion sweep (Sarah 2026-07-13): purge EVERYTHING deleted in
 * Zoho — any module, any type — so the WEEKLY automatic-audit / Slack brief
 * reflects clean data. Runs once, right before postWeeklyExecBrief (Sunday),
 * not just monthly. Two passes:
 *   1) Zoho's /deleted feed for every module over a WIDE window (default 180
 *      days, RADAR_WEEKLY_DELETION_LOOKBACK_DAYS) — bulk-paginated and cheap;
 *      catches everything still in the recycle bin regardless of which 6h sync
 *      missed it. removeRecordsByZohoIds is idempotent.
 *   2) A large live-verify of active-cluster records across all modules — the
 *      only signal for records HARD-purged from the recycle bin (gone from the
 *      /deleted feed), which the bounded per-sync sweep may not have reached.
 * The platform NEVER deletes in Zoho — it only prunes its own mirror of
 * already-gone records. Env: RADAR_WEEKLY_DELETION_LOOKBACK_DAYS (180),
 * RADAR_WEEKLY_GHOST_VERIFY (5000); either =0 disables that pass.
 */
export async function runComprehensiveDeletionSweep(
  opts: { verifyLimit?: number } = {},
): Promise<{
  feedRemoved: number;
  verified: number;
  verifiedPruned: number;
  verifiedConverted: number;
  idsetPruned: number;
  perModuleFeed: Record<string, number>;
}> {
  const { fetchDeletedZohoRecords } = await import("./zohoCRM");
  const { removeRecordsByZohoIds, cleanupSingletonClusters } = await import(
    "./duplicateRadarDatabase"
  );
  const modules = ["Leads", "Deals", "Contacts", "Accounts"];
  const lookbackDays = parseInt(
    process.env.RADAR_WEEKLY_DELETION_LOOKBACK_DAYS || "180",
    10,
  );
  const since =
    lookbackDays > 0
      ? new Date(Date.now() - lookbackDays * 86400000).toISOString()
      : undefined;

  const perModuleFeed: Record<string, number> = {};
  let feedRemoved = 0;
  for (const m of modules) {
    try {
      const deleted = await fetchDeletedZohoRecords(m, {
        type: "all",
        modifiedSince: since,
      });
      const ids = deleted.map((d: any) => d.id).filter(Boolean);
      if (ids.length) {
        const { removedCount } = await removeRecordsByZohoIds(ids, {
          module: m,
        });
        perModuleFeed[m] = removedCount;
        feedRemoved += removedCount;
      } else {
        perModuleFeed[m] = 0;
      }
    } catch (e: any) {
      logger.warn(
        `[comprehensive-deletion-sweep] ${m} /deleted feed failed (non-fatal): ${e?.message || e}`,
      );
      perModuleFeed[m] = 0;
    }
  }

  // Pass 2: live-verify active-cluster records to catch hard-purged ghosts
  // (pruned) AND converted leads (marked dead so they drop off the tabs).
  let verified = 0;
  let verifiedPruned = 0;
  let verifiedConverted = 0;
  try {
    const verifyLimit =
      opts.verifyLimit ??
      parseInt(process.env.RADAR_WEEKLY_GHOST_VERIFY || "5000", 10);
    if (verifyLimit > 0) {
      const r = await reconcileDeletedRecords({
        limit: verifyLimit,
        activeClustersOnly: true,
      });
      verified = r.checked;
      verifiedPruned = r.pruned;
      verifiedConverted = r.converted;
    }
  } catch (e: any) {
    logger.warn(
      `[comprehensive-deletion-sweep] live-verify failed (non-fatal): ${e?.message || e}`,
    );
  }

  // Feed-removed records can leave singleton clusters behind (pass 2 only
  // cleans singletons when IT pruned) — clean up once here if anything went.
  if (feedRemoved > 0) {
    try {
      if (typeof cleanupSingletonClusters === "function")
        await cleanupSingletonClusters();
    } catch {
      /* best-effort */
    }
  }

  // THE definitive layer (Sarah 2026-07-15): full id-set reconciliation. The
  // /deleted feed above misses HARD-deleted records (recycle bin emptied) and
  // deletions older than its window; per-record live-verify only rotates a slice.
  // This diffs our whole mirror against Zoho's LIVE id set and prunes anything
  // absent — the ONLY method that catches every deletion deterministically.
  let idsetPruned = 0;
  try {
    const idset = await reconcileAllDeletedByIdSet();
    idsetPruned = Object.values(idset).reduce((a, r) => a + (r.pruned || 0), 0);
  } catch (e: any) {
    logger.warn(
      `[comprehensive-deletion-sweep] id-set reconcile failed (non-fatal): ${e?.message || e}`,
    );
  }

  logger.info(
    `🧹 [comprehensive-deletion-sweep] feed-removed ${feedRemoved}, live-verified ${verified} (pruned ${verifiedPruned}, converted-leads ${verifiedConverted}), id-set-pruned ${idsetPruned}`,
  );
  return {
    feedRemoved,
    verified,
    verifiedPruned,
    verifiedConverted,
    idsetPruned,
    perModuleFeed,
  };
}

/**
 * DEFINITIVE deletion detector (Sarah 2026-07-15). Incremental sync never
 * returns deletions, the /deleted feed can't see HARD-deleted or long-ago
 * deletions, and per-record verify only rotates a slice — so ghosts survive.
 * This fetches Zoho's COMPLETE live id set for a module (id-only, cheap) and
 * prunes every record in our mirror whose id is NOT in it. Catches deletions,
 * merges, and converted leads (converted leads leave the Leads list) in one
 * deterministic pass, regardless of when/how they left Zoho.
 *
 * SAFETY (critical): pruning-by-absence is only safe when the live fetch is
 * COMPLETE. A partial/rate-limited/failed fetch would otherwise nuke live
 * records. Guards: (1) a thrown fetch → abort; (2) an EMPTY live set → abort;
 * (3) if the diff would prune more than RADAR_IDSET_MAX_PRUNE_FRAC (default 40%)
 * of our records for that module → abort + error-log (a legit mass-delete that
 * large is rare; a truncated fetch is the likely cause). Matches our rows by
 * zoho_module OR (null zoho_module AND record_type) so legacy rows are covered.
 */
export async function reconcileDeletedByIdSet(
  module: "Leads" | "Deals" | "Contacts" | "Accounts",
): Promise<{ liveIds: number; ourIds: number; pruned: number; aborted: boolean }> {
  const { fetchAllZohoRecords } = await import("./zohoCRM");
  let live: Array<{ id?: string }>;
  try {
    live = (await fetchAllZohoRecords(module, { fields: ["id"] })) as any[];
  } catch (e: any) {
    logger.warn(
      `[id-set-reconcile] ${module} live id fetch FAILED — abort (no prune): ${e?.message || e}`,
    );
    return { liveIds: 0, ourIds: 0, pruned: 0, aborted: true };
  }
  const liveSet = new Set(
    (live || []).map((r) => String(r?.id ?? "")).filter(Boolean),
  );
  if (liveSet.size === 0) {
    logger.warn(
      `[id-set-reconcile] ${module}: 0 live ids returned — ABORT (never prune a whole module on an empty fetch).`,
    );
    return { liveIds: 0, ourIds: 0, pruned: 0, aborted: true };
  }
  const rt =
    module === "Leads"
      ? "lead"
      : module === "Deals"
        ? "deal"
        : module === "Contacts"
          ? "contact"
          : "account";
  const ours = await pool.query<{ zoho_record_id: string }>(
    `SELECT zoho_record_id FROM duplicate_records
      WHERE zoho_record_id IS NOT NULL AND btrim(zoho_record_id) <> ''
        AND (zoho_module = $1 OR (zoho_module IS NULL AND record_type = $2))`,
    [module, rt],
  );
  const ghosts = ours.rows
    .map((r) => String(r.zoho_record_id))
    .filter((id) => !liveSet.has(id));
  const maxFrac = parseFloat(process.env.RADAR_IDSET_MAX_PRUNE_FRAC || "0.4");
  if (ours.rows.length > 200 && ghosts.length > ours.rows.length * maxFrac) {
    logger.error(
      `[id-set-reconcile] ${module}: would prune ${ghosts.length}/${ours.rows.length} (> ${Math.round(maxFrac * 100)}%) — ABORT as a likely incomplete Zoho fetch (live=${liveSet.size}). Override with RADAR_IDSET_MAX_PRUNE_FRAC.`,
    );
    return {
      liveIds: liveSet.size,
      ourIds: ours.rows.length,
      pruned: 0,
      aborted: true,
    };
  }
  let pruned = 0;
  const CHUNK = 500;
  for (let i = 0; i < ghosts.length; i += CHUNK) {
    await pruneGhostRecords(ghosts.slice(i, i + CHUNK));
    pruned += Math.min(CHUNK, ghosts.length - i);
  }
  if (pruned > 0) {
    try {
      const db: any = await import("./duplicateRadarDatabase");
      if (typeof db.cleanupSingletonClusters === "function")
        await db.cleanupSingletonClusters();
    } catch {
      /* best-effort */
    }
  }
  logger.info(
    `🧹 [id-set-reconcile] ${module}: live=${liveSet.size}, ours=${ours.rows.length}, pruned=${pruned}`,
  );
  return { liveIds: liveSet.size, ourIds: ours.rows.length, pruned, aborted: false };
}

/** Run the id-set reconcile across all four modules (sequential — one heavy
 * Zoho id-fetch at a time). Returns per-module { ourIds, pruned, aborted }. */
export async function reconcileAllDeletedByIdSet(): Promise<
  Record<string, { ourIds: number; pruned: number; aborted: boolean }>
> {
  const out: Record<string, { ourIds: number; pruned: number; aborted: boolean }> = {};
  for (const m of ["Leads", "Deals", "Contacts", "Accounts"] as const) {
    try {
      const r = await reconcileDeletedByIdSet(m);
      out[m] = { ourIds: r.ourIds, pruned: r.pruned, aborted: r.aborted };
    } catch (e: any) {
      out[m] = { ourIds: 0, pruned: 0, aborted: true };
      logger.warn(`[id-set-reconcile] ${m} failed: ${e?.message || e}`);
    }
  }
  logger.info(
    `🧹 [id-set-reconcile] ALL modules done: ${Object.entries(out)
      .map(([m, r]) => `${m}=${r.aborted ? "ABORT" : r.pruned}`)
      .join(", ")}`,
  );
  return out;
}

// Contacts: name-only (no email/phone/account/deal) OR test-name.
export async function getEmptyContacts(): Promise<EmptyRecordRow[]> {
  const q = await pool.query(
    `WITH deal_contacts AS (
        SELECT DISTINCT raw_data->'Contact_Name'->>'id' AS cid
          FROM duplicate_records
         WHERE record_type='deal'
           AND raw_data->'Contact_Name'->>'id' IS NOT NULL
           AND raw_data->'Contact_Name'->>'id' <> ''
     )
     SELECT c.zoho_record_id, c.record_name, c.owner_name,
            (c.email IS NOT NULL AND c.email <> '') AS has_email,
            ((c.phone_normalized IS NOT NULL AND c.phone_normalized <> '')
             OR (c.mobile_normalized IS NOT NULL AND c.mobile_normalized <> '')) AS has_phone,
            (c.raw_data->'Account_Name'->>'id' IS NOT NULL AND c.raw_data->'Account_Name'->>'id' <> '') AS has_account,
            (c.zoho_record_id IN (SELECT cid FROM deal_contacts)) AS has_deals
       FROM duplicate_records c
      WHERE c.record_type='contact'
        AND ( ( (c.email IS NULL OR c.email='')
                AND (c.phone_normalized IS NULL OR c.phone_normalized='')
                AND (c.mobile_normalized IS NULL OR c.mobile_normalized='')
                AND (c.raw_data->'Account_Name'->>'id' IS NULL OR c.raw_data->'Account_Name'->>'id'='')
                AND c.zoho_record_id NOT IN (SELECT cid FROM deal_contacts) )
              OR c.record_name ILIKE ANY($1::text[]) )
        ${excl("c.")}
      ORDER BY c.modified_date DESC NULLS LAST
      LIMIT 4000`,
    [LIKES, DELETE_TAGS],
  );
  const out: EmptyRecordRow[] = [];
  for (const r of q.rows) {
    const c = classifyContact({
      hasEmail: !!r.has_email,
      hasPhone: !!r.has_phone,
      hasAccount: !!r.has_account,
      hasDeals: !!r.has_deals,
      name: r.record_name || "",
    });
    if (!c.reason) continue;
    out.push({
      zohoId: r.zoho_record_id,
      name: r.record_name || "",
      owner: r.owner_name || null,
      reason: c.reason,
      deleteEligible: c.deleteEligible,
    });
    if (out.length >= CAP) break;
  }
  return out;
}

// --- Post-scan cleanup_class persistence (Sarah 2026-07-01) ---------------
//
// Recomputes `duplicate_records.cleanup_class` for every deal/account/contact
// row from the SYNCED SNAPSHOT ONLY (no live Zoho calls — this runs on every
// scan and must stay cheap even at 100k+ records). Values:
//   'tagged'   — already queued for the Zoho admin to delete (ledger or a
//                synced Empty-Delete/Duplicate-Delete tag)
//   'empty'    — structurally empty (reuses the exact WHERE shape
//                getEmptyDeals/getEmptyAccounts/getEmptyContacts use)
//   'test'     — structurally empty AND a test/placeholder/walaplus name
//   'junk'     — structurally empty AND a junk/gibberish name
//   'orphaned' — deal with real data but no Account link (Account Hints owns
//                these — never hidden there)
//   NULL       — real data; never a cleanup class, even with a junk-looking
//                name (same safety gate as classifyDeal/Account/Contact)
//
// Precedence (first match wins, enforced by only ever writing into rows that
// are still NULL after each pass): tagged > test/junk > orphaned > empty.
// Structural signals are pure SQL (fast, set-based); name-based test/junk
// needs the JS classifier (isJunkOrTestName/isTestOrPlaceholderName aren't
// expressible in SQL), so that part runs as a targeted id+name pass over just
// the already-empty candidates, batched back with UPDATE ... WHERE id = ANY(...).
export async function classifyCleanupRecords(): Promise<number> {
  // 0. Reset — every scan recomputes from scratch so stale classes (e.g. a
  // record that got real data since the last scan) don't linger.
  await pool.query(
    `UPDATE duplicate_records SET cleanup_class = NULL WHERE cleanup_class IS NOT NULL`,
  );

  // 1. tagged — highest precedence. Reuses the exact ledger + synced-tag check
  // the empty-records queries use (empty_delete_ledger OR synced Empty-Delete
  // /Duplicate-Delete tag). Scoped to deal/account/contact (leads have no
  // empty-records concept in this feature).
  await pool.query(
    `UPDATE duplicate_records dr
        SET cleanup_class = 'tagged'
      WHERE dr.record_type IN ('deal','account','contact')
        AND ( dr.zoho_record_id IN (SELECT zoho_record_id FROM empty_delete_ledger)
              OR EXISTS (
                SELECT 1 FROM jsonb_array_elements(
                  CASE WHEN jsonb_typeof(dr.raw_data->'Tag') = 'array'
                       THEN dr.raw_data->'Tag' ELSE '[]'::jsonb END
                ) AS _dt
                WHERE _dt->>'name' = ANY($1::text[])
              ) )`,
    [DELETE_TAGS],
  );

  // 2. Structural empty/orphaned — set-based, mirrors the WHERE shapes of
  // getEmptyDeals/getEmptyAccounts/getEmptyContacts (excluding rows already
  // classified 'tagged' above).

  // Deals: empty = no Account AND no Contact (no attachment signal available
  // snapshot-only — matches the deleteEligible='empty' path's DB-only shape;
  // the live "Check documents" gate still applies before an operator deletes).
  // orphaned = has data (account/contact link) but no Account — Account Hints
  // territory, not a delete candidate.
  await pool.query(
    `UPDATE duplicate_records dr
        SET cleanup_class = CASE
              WHEN COALESCE(NULLIF(dr.raw_data->'Account_Name'->>'id',''), NULL) IS NULL
                   AND COALESCE(NULLIF(dr.raw_data->'Contact_Name'->>'id',''), NULL) IS NULL
                THEN 'empty'
              ELSE 'orphaned'
            END
      WHERE dr.record_type = 'deal'
        AND dr.cleanup_class IS NULL
        AND COALESCE(NULLIF(dr.raw_data->'Account_Name'->>'id',''), NULL) IS NULL
        AND LOWER(COALESCE(NULLIF(dr.stage,''), dr.raw_data->>'Stage', '')) NOT IN ('agreement signed', 'paid')`,
  );

  // Accounts: structurally empty = no deal/contact anywhere in the snapshot
  // references this account id (mirrors the `linked` CTE in getEmptyAccounts).
  await pool.query(
    `WITH linked AS (
        SELECT DISTINCT raw_data->'Account_Name'->>'id' AS aid
          FROM duplicate_records
         WHERE record_type IN ('deal','contact')
           AND raw_data->'Account_Name'->>'id' IS NOT NULL
           AND raw_data->'Account_Name'->>'id' <> ''
     )
     UPDATE duplicate_records a
        SET cleanup_class = 'empty'
      WHERE a.record_type = 'account'
        AND a.cleanup_class IS NULL
        AND a.zoho_record_id NOT IN (SELECT aid FROM linked)
        AND COALESCE(NULLIF(a.email,''), a.raw_data->>'Email') IS NULL`,
  );

  // Contacts: name-only = no email/phone/account link AND not referenced as a
  // deal's Contact_Name anywhere in the snapshot (mirrors the `deal_contacts`
  // CTE in getEmptyContacts).
  await pool.query(
    `WITH deal_contacts AS (
        SELECT DISTINCT raw_data->'Contact_Name'->>'id' AS cid
          FROM duplicate_records
         WHERE record_type='deal'
           AND raw_data->'Contact_Name'->>'id' IS NOT NULL
           AND raw_data->'Contact_Name'->>'id' <> ''
     )
     UPDATE duplicate_records c
        SET cleanup_class = 'empty'
      WHERE c.record_type = 'contact'
        AND c.cleanup_class IS NULL
        AND (c.email IS NULL OR c.email = '')
        AND (c.phone_normalized IS NULL OR c.phone_normalized = '')
        AND (c.mobile_normalized IS NULL OR c.mobile_normalized = '')
        AND (c.raw_data->'Account_Name'->>'id' IS NULL OR c.raw_data->'Account_Name'->>'id' = '')
        AND c.zoho_record_id NOT IN (SELECT cid FROM deal_contacts)`,
  );

  // 3. Name-based test/junk refinement — JS-only classifiers, so pull just the
  // rows currently marked 'empty' (small subset — already filtered to
  // structurally-empty by step 2) plus the coarse ILIKE-name candidates step 2
  // wouldn't catch (a record WITH an account/contact link never gets here —
  // gate stays "only if structurally empty", same as the live classifiers).
  const nameCandidates = await pool.query<{ id: number; record_name: string | null }>(
    `SELECT id, record_name FROM duplicate_records
      WHERE record_type IN ('deal','account','contact')
        AND cleanup_class = 'empty'`,
  );
  const testIds: number[] = [];
  const junkIds: number[] = [];
  for (const row of nameCandidates.rows) {
    const name = row.record_name || "";
    const jt = isJunkOrTestName(name);
    if (jt.junk) junkIds.push(row.id);
    else if (jt.test || isTestOrPlaceholderName(name)) testIds.push(row.id);
  }
  const BATCH = 1000;
  for (let i = 0; i < junkIds.length; i += BATCH) {
    await pool.query(
      `UPDATE duplicate_records SET cleanup_class = 'junk' WHERE id = ANY($1::int[])`,
      [junkIds.slice(i, i + BATCH)],
    );
  }
  for (let i = 0; i < testIds.length; i += BATCH) {
    await pool.query(
      `UPDATE duplicate_records SET cleanup_class = 'test' WHERE id = ANY($1::int[])`,
      [testIds.slice(i, i + BATCH)],
    );
  }

  const countRes = await pool.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM duplicate_records WHERE cleanup_class IS NOT NULL`,
  );
  return Number(countRes.rows[0]?.n ?? 0);
}
