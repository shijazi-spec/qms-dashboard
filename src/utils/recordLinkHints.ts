import { pool } from "./duplicateRadarDatabase";
import { realDomainRoot } from "./preflightStructuredPush";
import { logger } from "./logger";
import { updateZohoRecord } from "./zohoCRM";

// Placeholder / non-real account labels (mirror accountInference.ts).
export const PLACEHOLDER_ACCOUNTS = new Set(["", "-", "n/a", "na", "none", "null", "unknown", "test"]);

const linkVal = (obj: any): { id?: string; name?: string } | null =>
  obj && typeof obj === "object" ? obj : null;

/** A Contact needs an Account when it has no Account_Name, or a placeholder one. */
export function contactNeedsAccount(raw: any): boolean {
  const acc = linkVal(raw?.Account_Name);
  if (!acc) return true;
  if (acc.id) return false;                       // a real linked account
  const nm = String(acc.name || "").trim().toLowerCase();
  return !nm || PLACEHOLDER_ACCOUNTS.has(nm);
}

/** A Deal needs a Contact when it has no Contact_Name (no primary contact role). */
export function dealNeedsContact(raw: any): boolean {
  const c = linkVal(raw?.Contact_Name);
  return !(c && c.id);
}

/** Confidence = base 40 + evidence, capped 100. Matches Account Hints. */
export function scoreLinkConfidence(a: { agreeing: number; explicitDomain: boolean; relatedRecords: number }): number {
  let s = 40;
  s += a.agreeing >= 2 ? 25 : a.agreeing === 1 ? 10 : 0;
  s += a.explicitDomain ? 25 : 0;
  s += a.relatedRecords > 0 ? 10 : 0;
  return Math.min(100, s);
}

export function pickAccountForContact(domain: string, cands: Array<{ id: string; domain?: string; name?: string }>) {
  const d = String(domain || "").trim().toLowerCase();
  if (!d) return null;
  return cands.find(c => String(c.domain || "").toLowerCase() === d) || null;
}
export function pickContactForDeal(domain: string, cands: Array<{ id: string; domain?: string; name?: string }>) {
  if (cands.length === 1) return cands[0];
  const d = String(domain || "").trim().toLowerCase();
  if (!d) return null;
  // Only a UNIQUE domain match is a safe auto-suggestion. If several contacts
  // share the deal's domain, the pick would be arbitrary (and could reach the
  // ≥70% auto-resolve gate and write the WRONG person to the Deal's
  // Contact_Name) — so leave it with no hint for a human to resolve.
  const matches = cands.filter(c => String(c.domain || "").toLowerCase() === d);
  return matches.length === 1 ? matches[0] : null;
}

export type LinkHint = {
  sourceRecordId: number; sourceZohoId: string; sourceModule: "Contacts" | "Deals";
  linkField: "Account_Name" | "Contact_Name";
  targetRecordId: number | null; targetZohoId: string; targetName: string; domain: string;
  evidenceRecordId: number | null; evidenceDetail: string; confidence: number;
};

interface DuplicateRecordRow {
  id: number;
  zoho_record_id: string | null;
  record_name: string | null;
  company_name: string | null;
  email: string | null;
  domain: string | null;
  account_name: string | null;
  contact_name: string | null;
  raw_data: any;
  cluster_id: number | null;
}

/**
 * Best candidate Account for a corporate domain (mirrors
 * accountInference.findBestAccountForDomain). Preference: explicit `domain`
 * column match first, tie-broken by number of related records in the same
 * cluster.
 */
async function findAccountCandidatesForDomain(
  domain: string,
): Promise<Array<{ id: number; zoho_record_id: string | null; account_name: string | null; company_name: string | null; domain: string | null; has_explicit_domain: boolean; related_record_count: number }>> {
  const norm = domain.toLowerCase().trim();
  if (!norm) return [];
  const res = await pool.query(
    `SELECT a.id,
            a.zoho_record_id,
            a.account_name,
            a.company_name,
            a.domain,
            (a.domain IS NOT NULL AND LOWER(a.domain) = $1) AS has_explicit_domain,
            (SELECT COUNT(*) FROM duplicate_records r2
              WHERE r2.cluster_id = a.cluster_id AND r2.id <> a.id) AS related_record_count
       FROM duplicate_records a
      WHERE a.record_type = 'account'
        AND (
          LOWER(a.domain) = $1
          OR LOWER(SPLIT_PART(a.email, '@', 2)) = $1
        )
      ORDER BY has_explicit_domain DESC, related_record_count DESC`,
    [norm],
  );
  return res.rows.map((row: any) => ({
    id: row.id,
    zoho_record_id: row.zoho_record_id,
    account_name: row.account_name,
    company_name: row.company_name,
    domain: row.domain,
    has_explicit_domain: !!row.has_explicit_domain,
    related_record_count: Number(row.related_record_count) || 0,
  }));
}

/**
 * Walk a Contact record → its own domain (or email-derived real domain) →
 * candidate Account rows sharing that domain. Returns a LinkHint or null
 * when the contact doesn't need help, has no usable domain, or no Account
 * candidate matches.
 */
export async function inferAccountForContact(
  contact: DuplicateRecordRow,
): Promise<LinkHint | null> {
  if (!contactNeedsAccount(contact.raw_data)) return null;

  // realDomainRoot filters out free-mail/placeholder domains (gmail, hotmail,
  // "#n", …) — use it as the FIRST resolver, not a fallback, so a contact whose
  // domain column is literally "gmail.com" can't be linked to a bogus account.
  const domain =
    realDomainRoot(contact.domain) ||
    (contact.email ? realDomainRoot(contact.email) : null);
  const normDomain = String(domain || "").trim().toLowerCase();
  if (!normDomain) return null;

  const candidates = await findAccountCandidatesForDomain(normDomain);
  if (candidates.length === 0) return null;

  const cands = candidates.map(c => ({ id: String(c.id), domain: c.domain || undefined, name: c.account_name || c.company_name || undefined }));
  const picked = pickAccountForContact(normDomain, cands);
  if (!picked) return null;
  const best = candidates.find(c => String(c.id) === picked.id)!;

  // agreeing = how many of the contact's own signals (domain column,
  // company_name) point at this same account/domain.
  let agreeing = 0;
  if (contact.domain && contact.domain.trim().toLowerCase() === normDomain) agreeing++;
  if (
    contact.company_name &&
    (best.account_name || best.company_name) &&
    contact.company_name.trim().toLowerCase() ===
      String(best.account_name || best.company_name).trim().toLowerCase()
  ) {
    agreeing++;
  }

  const relatedRes = await pool.query(
    `SELECT COUNT(*)::int AS n FROM duplicate_records WHERE cluster_id = $1 AND id <> $2`,
    [contact.cluster_id, contact.id],
  );
  const relatedRecords = contact.cluster_id ? Number(relatedRes.rows[0]?.n || 0) : 0;

  const confidence = scoreLinkConfidence({
    agreeing,
    explicitDomain: best.has_explicit_domain,
    relatedRecords,
  });

  return {
    sourceRecordId: contact.id,
    sourceZohoId: contact.zoho_record_id || "",
    sourceModule: "Contacts",
    linkField: "Account_Name",
    targetRecordId: best.id,
    targetZohoId: best.zoho_record_id || "",
    targetName: best.account_name || best.company_name || "",
    domain: normDomain,
    evidenceRecordId: contact.id,
    evidenceDetail: `domain ${normDomain}`,
    confidence,
  };
}

/**
 * Candidate Contact rows "under" a Deal's account — matched by the deal's
 * own account_name (contact.company_name) or domain.
 */
async function findContactCandidatesForDeal(
  deal: DuplicateRecordRow,
): Promise<Array<{ id: number; zoho_record_id: string | null; record_name: string | null; company_name: string | null; domain: string | null }>> {
  const domain =
    (deal.domain && deal.domain.trim().toLowerCase()) ||
    realDomainRoot(deal.domain) ||
    null;
  const accountName = deal.account_name && deal.account_name.trim();

  if (!domain && !accountName) return [];

  const res = await pool.query(
    `SELECT id, zoho_record_id, record_name, company_name, domain
       FROM duplicate_records
      WHERE record_type = 'contact'
        AND (
          ($1::text IS NOT NULL AND LOWER(domain) = $1)
          OR ($2::text IS NOT NULL AND LOWER(company_name) = LOWER($2))
        )
      ORDER BY id`,
    [domain, accountName],
  );
  return res.rows;
}

/**
 * Walk a Deal record → candidate Contacts sharing its account/domain.
 * Single unambiguous candidate is the strongest signal; multiple candidates
 * are only accepted when one agrees on domain.
 */
export async function inferContactForDeal(
  deal: DuplicateRecordRow,
): Promise<LinkHint | null> {
  if (!dealNeedsContact(deal.raw_data)) return null;

  const dealDomain =
    (deal.domain && deal.domain.trim().toLowerCase()) ||
    realDomainRoot(deal.domain) ||
    "";

  const candidateRows = await findContactCandidatesForDeal(deal);
  if (candidateRows.length === 0) return null;

  const cands = candidateRows.map(c => ({ id: String(c.id), domain: c.domain || undefined, name: c.record_name || undefined }));
  const picked = pickContactForDeal(dealDomain, cands);
  if (!picked) return null;
  const best = candidateRows.find(c => String(c.id) === picked.id)!;

  const agreeing = candidateRows.length === 1 ? 2 : 1;

  const relatedRes = await pool.query(
    `SELECT COUNT(*)::int AS n FROM duplicate_records WHERE cluster_id = $1 AND id <> $2`,
    [deal.cluster_id, deal.id],
  );
  const relatedRecords = deal.cluster_id ? Number(relatedRes.rows[0]?.n || 0) : 0;

  const explicitDomain = !!(best.domain && dealDomain && best.domain.trim().toLowerCase() === dealDomain);

  const confidence = scoreLinkConfidence({
    agreeing,
    explicitDomain,
    relatedRecords,
  });

  return {
    sourceRecordId: deal.id,
    sourceZohoId: deal.zoho_record_id || "",
    sourceModule: "Deals",
    linkField: "Contact_Name",
    targetRecordId: best.id,
    targetZohoId: best.zoho_record_id || "",
    targetName: best.record_name || best.company_name || "",
    domain: dealDomain,
    evidenceRecordId: deal.id,
    evidenceDetail: candidateRows.length === 1 ? "single contact under account" : `domain ${dealDomain}`,
    confidence,
  };
}

/**
 * Run inference across every Contact needing an Account and every Deal
 * needing a Contact, and UPSERT non-null hints into `record_link_hints`.
 * Mirrors scanDealsForAccountHints: idempotent, preserves existing
 * 'dismissed'/'applied' status (only 'pending' rows are refreshed).
 * Returns the count of pending hints per link type.
 */
export async function scanRecordLinkHints(): Promise<{ contact_account: number; deal_contact: number }> {
  const t0 = Date.now();

  // Pre-filter needs-help in SQL (mirrors contactNeedsAccount) so the scan
  // loads only contacts missing an account, not the whole table. The JS
  // predicate below stays as the authority for any edge the SQL misses.
  const contactsRes = await pool.query(
    `SELECT id, zoho_record_id, record_name, company_name, email, domain,
            account_name, contact_name, raw_data, cluster_id
       FROM duplicate_records
      WHERE record_type = 'contact'
        AND (
          raw_data->'Account_Name' IS NULL
          OR (
            raw_data->'Account_Name'->>'id' IS NULL
            AND LOWER(TRIM(COALESCE(raw_data->'Account_Name'->>'name', '')))
                IN ('', '-', 'n/a', 'na', 'none', 'null', 'unknown', 'test')
          )
        )`,
  );

  for (const row of contactsRes.rows) {
    const contact: DuplicateRecordRow = row;
    if (!contactNeedsAccount(contact.raw_data)) continue;
    const hint = await inferAccountForContact(contact);
    if (!hint || !hint.targetRecordId) continue;
    await upsertLinkHint(hint);
  }

  // Pre-filter to deals with no primary contact (mirrors dealNeedsContact).
  const dealsRes = await pool.query(
    `SELECT id, zoho_record_id, record_name, company_name, email, domain,
            account_name, contact_name, raw_data, cluster_id
       FROM duplicate_records
      WHERE record_type = 'deal'
        AND raw_data->'Contact_Name'->>'id' IS NULL`,
  );

  for (const row of dealsRes.rows) {
    const deal: DuplicateRecordRow = row;
    if (!dealNeedsContact(deal.raw_data)) continue;
    const hint = await inferContactForDeal(deal);
    if (!hint || !hint.targetRecordId) continue;
    await upsertLinkHint(hint);
  }

  const summaryRes = await pool.query(
    `SELECT link_field, COUNT(*)::int AS n
       FROM record_link_hints
      WHERE status = 'pending'
      GROUP BY link_field`,
  );
  const summary = { contact_account: 0, deal_contact: 0 };
  for (const s of summaryRes.rows) {
    if (s.link_field === "Account_Name") summary.contact_account = s.n;
    else if (s.link_field === "Contact_Name") summary.deal_contact = s.n;
  }

  logger.info("[recordLinkHints] scan complete", {
    ...summary,
    duration_ms: Date.now() - t0,
  });
  return summary;
}

/**
 * UPSERT one LinkHint into record_link_hints, keyed on
 * (source_record_id, link_field, suggested_target_record_id). Existing
 * rows already 'dismissed' or 'applied' are left untouched — only 'pending'
 * rows are refreshed with the latest evidence/confidence.
 */
async function upsertLinkHint(hint: LinkHint): Promise<void> {
  await pool.query(
    `INSERT INTO record_link_hints
       (source_record_id, source_type, link_field, suggested_target_record_id,
        suggested_target_zoho_id, suggested_target_name, suggested_domain,
        evidence_record_id, evidence_detail, confidence, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
     ON CONFLICT (source_record_id, link_field, suggested_target_record_id) DO UPDATE
       SET suggested_target_zoho_id = EXCLUDED.suggested_target_zoho_id,
           suggested_target_name    = EXCLUDED.suggested_target_name,
           suggested_domain         = EXCLUDED.suggested_domain,
           evidence_record_id       = EXCLUDED.evidence_record_id,
           evidence_detail          = EXCLUDED.evidence_detail,
           confidence               = EXCLUDED.confidence,
           updated_at               = CURRENT_TIMESTAMP
     WHERE record_link_hints.status = 'pending'`,
    [
      hint.sourceRecordId,
      hint.sourceModule === "Contacts" ? "contact" : "deal",
      hint.linkField,
      hint.targetRecordId,
      hint.targetZohoId,
      hint.targetName,
      hint.domain,
      hint.evidenceRecordId,
      hint.evidenceDetail,
      hint.confidence,
    ],
  );
}

export type RecordLinkHintType = "contact_account" | "deal_contact";

const LINK_TYPE_TO_FIELD: Record<RecordLinkHintType, "Account_Name" | "Contact_Name"> = {
  contact_account: "Account_Name",
  deal_contact: "Contact_Name",
};

export interface RecordLinkHintRow {
  id: number;
  source_record_id: number;
  source_type: string;
  source_zoho_id: string | null;
  source_record_name: string | null;
  link_field: string;
  current_value: string | null;
  suggested_target_record_id: number | null;
  suggested_target_zoho_id: string | null;
  suggested_target_name: string | null;
  suggested_domain: string | null;
  evidence_record_id: number | null;
  evidence_detail: string | null;
  confidence: number;
  status: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * List record_link_hints rows for the dashboard, mirroring
 * listAccountInferenceHints's join-for-display + status/limit filtering.
 * `type` maps to the hint's link_field (contact_account -> Account_Name,
 * deal_contact -> Contact_Name); omit it to return both kinds together.
 */
export async function listRecordLinkHints(opts: {
  type?: RecordLinkHintType;
  status?: string;
  limit?: number;
}): Promise<{
  hints: RecordLinkHintRow[];
  summary: { pending: number; dismissed: number; applied: number };
}> {
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 2000));
  const status = opts.status && ["pending", "dismissed", "applied"].includes(opts.status)
    ? opts.status
    : "pending";
  const linkField = opts.type ? LINK_TYPE_TO_FIELD[opts.type] : null;

  const params: any[] = [status];
  let linkFieldClause = "";
  if (linkField) {
    params.push(linkField);
    linkFieldClause = `AND h.link_field = $${params.length}`;
  }
  params.push(limit);
  const limitParam = `$${params.length}`;

  const rows = await pool.query(
    `SELECT h.id,
            h.source_record_id,
            h.source_type,
            s.zoho_record_id  AS source_zoho_id,
            s.record_name     AS source_record_name,
            h.link_field,
            CASE WHEN h.link_field = 'Account_Name' THEN s.account_name
                 ELSE s.contact_name END AS current_value,
            h.suggested_target_record_id,
            h.suggested_target_zoho_id,
            h.suggested_target_name,
            h.suggested_domain,
            h.evidence_record_id,
            h.evidence_detail,
            h.confidence,
            h.status,
            h.created_at,
            h.updated_at
       FROM record_link_hints h
       LEFT JOIN duplicate_records s ON s.id = h.source_record_id
      WHERE h.status = $1
        ${linkFieldClause}
      ORDER BY h.confidence DESC, h.updated_at DESC
      LIMIT ${limitParam}`,
    params,
  );

  const summaryRes = await pool.query(
    `SELECT status, COUNT(*)::int AS n
       FROM record_link_hints
      ${linkField ? "WHERE link_field = $1" : ""}
      GROUP BY status`,
    linkField ? [linkField] : [],
  );
  const summary = { pending: 0, dismissed: 0, applied: 0 };
  for (const s of summaryRes.rows) {
    if (s.status === "pending") summary.pending = s.n;
    else if (s.status === "dismissed") summary.dismissed = s.n;
    else if (s.status === "applied") summary.applied = s.n;
  }
  return { hints: rows.rows, summary };
}

/**
 * AI-resolve a single Record-Link-Hint row: write the suggested target
 * directly onto the Zoho source record's link field, then mark the hint
 * applied. Generic over module/field — both come from the hint row itself
 * (source_type -> module, link_field -> the field to write), unlike
 * aiResolveAccountHint which is hard-coded to Deals/Account_Name. Refuses to
 * act when confidence is below the threshold (default 70%).
 */
export async function aiResolveRecordLinkHint(
  id: number,
  minConfidence = 70,
): Promise<{ applied: boolean; confidence: number; reason?: string }> {
  const res = await pool.query(
    `SELECT h.id, h.status, h.confidence, h.link_field, h.source_type,
            s.zoho_record_id AS source_zoho_id,
            h.suggested_target_zoho_id
       FROM record_link_hints h
       JOIN duplicate_records s ON s.id = h.source_record_id
      WHERE h.id = $1
      LIMIT 1`,
    [id],
  );
  const row = res.rows[0];
  if (!row) {
    return { applied: false, confidence: 0, reason: "not_found" };
  }
  if (row.status !== "pending") {
    return {
      applied: false,
      confidence: Number(row.confidence || 0),
      reason: `already_${row.status}`,
    };
  }
  const confidence = Number(row.confidence || 0);
  if (confidence < minConfidence) {
    return { applied: false, confidence, reason: "below_threshold" };
  }

  const sourceModule = row.source_type === "contact" ? "Contacts" : "Deals";
  const linkField = row.link_field as "Account_Name" | "Contact_Name";
  const sourceZohoId = row.source_zoho_id as string | null;
  const targetZohoId = row.suggested_target_zoho_id as string | null;
  if (!sourceZohoId || !targetZohoId) {
    return { applied: false, confidence, reason: "missing_zoho_ids" };
  }

  try {
    await updateZohoRecord(sourceModule, sourceZohoId, {
      [linkField]: { id: targetZohoId },
    });
  } catch (e: any) {
    return { applied: false, confidence, reason: e?.message || String(e) };
  }

  await pool.query(
    `UPDATE record_link_hints
        SET status = 'applied',
            updated_at = CURRENT_TIMESTAMP
      WHERE id = $1`,
    [id],
  );
  logger.info(
    `[recordLinkHints] AI-resolved hint #${id}: ${sourceModule} ${sourceZohoId} → ${linkField} ${targetZohoId} (confidence ${confidence}%)`,
  );
  return { applied: true, confidence };
}

/**
 * Bulk AI-resolve every pending record_link_hints row at-or-above the
 * confidence threshold, optionally scoped to one link type. Sequential to
 * keep Zoho call rate under the per-account ceiling, mirroring
 * aiResolveAllAccountHints.
 */
export async function aiResolveAllRecordLinkHints(opts: {
  type?: RecordLinkHintType;
  minConfidence?: number;
  limit?: number;
} = {}): Promise<{ applied: number; skipped: number }> {
  const minConfidence = opts.minConfidence ?? 70;
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
  const linkField = opts.type ? LINK_TYPE_TO_FIELD[opts.type] : null;

  const params: any[] = [minConfidence];
  let linkFieldClause = "";
  if (linkField) {
    params.push(linkField);
    linkFieldClause = `AND link_field = $${params.length}`;
  }
  params.push(limit);
  const limitParam = `$${params.length}`;

  const candidates = await pool.query(
    `SELECT id FROM record_link_hints
      WHERE status = 'pending' AND confidence >= $1
        ${linkFieldClause}
      ORDER BY confidence DESC, id ASC
      LIMIT ${limitParam}`,
    params,
  );

  let applied = 0;
  let skipped = 0;
  for (const c of candidates.rows) {
    try {
      const r = await aiResolveRecordLinkHint(c.id, minConfidence);
      if (r.applied) applied++;
      else skipped++;
    } catch {
      skipped++;
    }
  }

  logger.info(
    `[recordLinkHints] Bulk AI-resolve: applied=${applied} skipped=${skipped} (type=${opts.type || "all"})`,
  );
  return { applied, skipped };
}

// ---------------------------------------------------------------------------
// Unaccounted / stalled deals — disposition hints (Record Hint section 4).
// A deal parked in a stalled stage (e.g. "Unaccounted") is compared against its
// company's deal picture: if the company already has a live signed/paid deal
// this stalled one is redundant → suggest CLOSE; otherwise there's no live deal
// to protect → suggest RE-ENGAGE (move it forward). Read-only computation from
// the synced mirror; the apply (Zoho write) is a separate HITL step.
// ---------------------------------------------------------------------------
const STALE_DEAL_STAGES = (process.env.RECORD_HINT_STALE_STAGES || "Unaccounted")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const SIGNED_DEAL_STAGES = (process.env.PREFLIGHT_SIGNED_STAGES || "Agreement Signed,Paid")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

export type StaleDealHint = {
  dealZohoId: string;
  dealName: string;
  stage: string;
  accountZohoId: string | null;
  accountName: string | null;
  disposition: "close" | "reengage" | "review";
  reason: string;
};

/** Scan the synced mirror for deals in a stalled stage and suggest a
 * disposition per company deal-picture. Read-only — no Zoho calls, no writes. */
export async function scanStaleDeals(opts: { limit?: number } = {}): Promise<StaleDealHint[]> {
  const limit = Math.min(3000, Math.max(1, Math.floor(opts.limit ?? 500)));
  const dealsRes = await pool.query<{
    zoho_record_id: string; record_name: string | null; stage: string | null;
    account_zoho_id: string | null; account_name: string | null;
  }>(
    `SELECT zoho_record_id, record_name,
            COALESCE(NULLIF(stage,''), raw_data->>'Stage') AS stage,
            raw_data->'Account_Name'->>'id' AS account_zoho_id,
            account_name
       FROM duplicate_records
      WHERE record_type = 'deal'
        AND LOWER(COALESCE(NULLIF(stage,''), raw_data->>'Stage', '')) = ANY($1::text[])
      ORDER BY id
      LIMIT $2`,
    [STALE_DEAL_STAGES, limit],
  );
  if (dealsRes.rows.length === 0) return [];

  const acctIds = Array.from(new Set(dealsRes.rows.map(r => r.account_zoho_id).filter(Boolean) as string[]));
  const signedAccts = new Set<string>();
  if (acctIds.length > 0) {
    const sr = await pool.query<{ acc: string }>(
      `SELECT DISTINCT raw_data->'Account_Name'->>'id' AS acc
         FROM duplicate_records
        WHERE record_type = 'deal'
          AND raw_data->'Account_Name'->>'id' = ANY($1::text[])
          AND LOWER(COALESCE(NULLIF(stage,''), raw_data->>'Stage', '')) = ANY($2::text[])`,
      [acctIds, SIGNED_DEAL_STAGES],
    );
    for (const r of sr.rows) if (r.acc) signedAccts.add(r.acc);
  }

  return dealsRes.rows.map((r) => {
    let disposition: "close" | "reengage" | "review";
    let reason: string;
    if (!r.account_zoho_id) {
      disposition = "review";
      reason = "No account linked — decide manually.";
    } else if (signedAccts.has(r.account_zoho_id)) {
      disposition = "close";
      reason = "This company already has a signed/paid deal — the stalled deal is redundant.";
    } else {
      disposition = "reengage";
      reason = "No live signed/paid deal for this company — move this deal forward.";
    }
    return {
      dealZohoId: r.zoho_record_id,
      dealName: r.record_name || "(deal)",
      stage: r.stage || "",
      accountZohoId: r.account_zoho_id || null,
      accountName: r.account_name || null,
      disposition,
      reason,
    };
  });
}

const CLOSE_STAGE = process.env.RECORD_HINT_CLOSE_STAGE || "Closed Lost";
const REENGAGE_STAGE = process.env.RECORD_HINT_REENGAGE_STAGE || "New Deal";

/** HITL apply for a stalled deal. close → set Stage = Closed Lost; reengage →
 * move the Stage to an active working stage. A Zoho write (updateZohoRecord) —
 * never deletes. Also updates the mirror's stage so the deal drops off the
 * stale-deals scan before the next sync. Stages are env-configurable. */
export async function applyStaleDealDisposition(
  dealZohoId: string,
  action: "close" | "reengage",
): Promise<{ applied: boolean; stage: string; reason?: string }> {
  const id = String(dealZohoId || "").trim();
  if (!id) return { applied: false, stage: "", reason: "missing_deal_id" };
  const stage = action === "close" ? CLOSE_STAGE : REENGAGE_STAGE;
  try {
    await updateZohoRecord("Deals", id, { Stage: stage });
  } catch (e: any) {
    return { applied: false, stage, reason: e?.message || String(e) };
  }
  try {
    await pool.query(
      `UPDATE duplicate_records SET stage = $2 WHERE zoho_record_id = $1 AND record_type = 'deal'`,
      [id, stage],
    );
  } catch { /* best-effort mirror refresh */ }
  logger.info(`[recordLinkHints] stale-deal ${action} → ${id} Stage=${stage}`);
  return { applied: true, stage };
}
