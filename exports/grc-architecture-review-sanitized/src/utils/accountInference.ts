/**
 * Account Inference Hints — surface "this deal probably belongs to Account X"
 * suggestions for sales to act on.
 *
 * Problem
 * -------
 * Many Zoho Deals come in with no Account_Name (placeholder text, blank, or
 * the synthetic "_placeholder.cluster" quarantine bucket). The dashboard
 * surfaces them as a junk cluster but doesn't help sales actually fix the
 * underlying Zoho record.
 *
 * Approach
 * --------
 * For each "needs help" deal we walk:
 *
 *   Deal.raw_data.Contact_Name  →  the linked contact (in duplicate_records)
 *                              →  contact.email
 *                              →  corporate domain (free-mail filtered out)
 *                              →  Account whose domain or email-derived
 *                                 domain matches
 *
 * The strongest signal is a contact email on a real corporate domain that
 * also appears on an existing Account record. That Account is the likely
 * Account_Name for the deal.
 *
 * Output
 * ------
 * Hints stored in `account_inference_hints` keyed by (deal_record_id,
 * suggested_account_record_id). The scan is idempotent — re-running updates
 * existing rows rather than fanning out. Sales work the list from the
 * "Account Hints" tab in Duplicate Radar; clicking a row opens the Deal in
 * Zoho where they fix Account_Name. We do not write back to Zoho — the
 * dashboard remains read-only.
 */

import { pool } from "./duplicateRadarDatabase";
import {
  extractDomain,
  isPlaceholderName,
} from "./duplicateRadarDatabase";
import { updateZohoRecord } from "./zohoCRM";
import { logger } from "./logger";

const PLACEHOLDER_CLUSTER_DOMAIN = "_placeholder.cluster";

export interface AccountInferenceHint {
  id?: number;
  deal_record_id: number;
  suggested_account_record_id: number | null;
  suggested_account_name: string | null;
  suggested_domain: string | null;
  evidence_contact_record_id: number | null;
  evidence_contact_email: string | null;
  confidence: number;
  status: "pending" | "dismissed" | "applied";
  created_at?: Date;
  updated_at?: Date;
}

interface DealRow {
  id: number;
  zoho_record_id: string | null;
  account_name: string | null;
  company_name: string | null;
  domain: string | null;
  raw_data: any;
  cluster_id: number | null;
  cluster_domain: string | null;
}

interface CandidateAccount {
  id: number;
  zoho_record_id: string | null;
  account_name: string | null;
  company_name: string | null;
  domain: string | null;
  email: string | null;
  has_explicit_domain: boolean;
  related_record_count: number;
}

interface ContactRow {
  id: number;
  zoho_record_id: string | null;
  email: string | null;
  domain: string | null;
}

/**
 * Does this deal need account inference help?
 * True when there's no useful Account_Name AND the cluster key isn't a real
 * corporate domain (so we can't already trust the cluster grouping).
 */
function dealNeedsHelp(d: DealRow): boolean {
  const accountIsPlaceholder = isPlaceholderName(d.account_name);
  const accountIsEmpty = !d.account_name || d.account_name.trim().length === 0;
  if (!accountIsPlaceholder && !accountIsEmpty) {
    return false; // already has a real account name
  }
  // If the cluster has a real domain (no .cluster suffix), we trust that
  // domain identifies the company even without an explicit account_name.
  if (
    d.cluster_domain &&
    !d.cluster_domain.endsWith(".cluster") &&
    d.cluster_domain !== PLACEHOLDER_CLUSTER_DOMAIN
  ) {
    return false;
  }
  return true;
}

/**
 * Pull the Zoho contact id(s) referenced from a Deal's raw_data.
 * Zoho stores Contact_Name as either { id, name } or null.
 */
function extractLinkedContactZohoIds(rawData: any): string[] {
  if (!rawData || typeof rawData !== "object") return [];
  const out: string[] = [];
  const c = rawData.Contact_Name;
  if (c && typeof c === "object" && typeof c.id === "string") {
    out.push(c.id);
  }
  // Some Zoho layouts also surface secondary contacts under different keys —
  // walk anything that looks like { id, name } at the top level of raw_data.
  for (const [key, val] of Object.entries(rawData)) {
    if (key === "Contact_Name") continue;
    if (val && typeof val === "object" && (val as any).id && (val as any).name) {
      const lk = key.toLowerCase();
      if (lk.includes("contact")) out.push((val as any).id);
    }
  }
  return Array.from(new Set(out));
}

async function lookupContactsByZohoIds(
  zohoIds: string[],
): Promise<ContactRow[]> {
  if (zohoIds.length === 0) return [];
  const res = await pool.query(
    `SELECT id, zoho_record_id, email, domain
       FROM duplicate_records
      WHERE zoho_record_id = ANY($1::text[])
        AND record_type = 'contact'`,
    [zohoIds],
  );
  return res.rows;
}

/**
 * Best candidate account for a corporate domain. Preference order:
 *   1. Account with explicit `domain` column matching
 *   2. Account whose email's corporate domain matches
 *   3. Account with the most related records (tie-breaker)
 */
async function findBestAccountForDomain(
  domain: string,
): Promise<CandidateAccount | null> {
  const norm = domain.toLowerCase().trim();
  if (!norm) return null;
  const res = await pool.query(
    `SELECT a.id,
            a.zoho_record_id,
            a.account_name,
            a.company_name,
            a.domain,
            a.email,
            (a.domain IS NOT NULL AND LOWER(a.domain) = $1) AS has_explicit_domain,
            (SELECT COUNT(*) FROM duplicate_records r2
              WHERE r2.cluster_id = a.cluster_id AND r2.id <> a.id) AS related_record_count
       FROM duplicate_records a
      WHERE a.record_type = 'account'
        AND (
          LOWER(a.domain) = $1
          OR LOWER(SPLIT_PART(a.email, '@', 2)) = $1
        )
      ORDER BY has_explicit_domain DESC, related_record_count DESC
      LIMIT 1`,
    [norm],
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return {
    id: row.id,
    zoho_record_id: row.zoho_record_id,
    account_name: row.account_name,
    company_name: row.company_name,
    domain: row.domain,
    email: row.email,
    has_explicit_domain: !!row.has_explicit_domain,
    related_record_count: Number(row.related_record_count) || 0,
  };
}

interface InferenceResult {
  account: CandidateAccount;
  evidence_contact_id: number;
  evidence_contact_email: string;
  domain: string;
  confidence: number;
}

function scoreConfidence(args: {
  agreeingContacts: number;
  hasExplicitDomain: boolean;
  relatedRecordCount: number;
}): number {
  // Start at 40 for any single match, climb based on corroboration.
  let c = 40;
  if (args.agreeingContacts >= 2) c += 25;
  else if (args.agreeingContacts >= 1) c += 10;
  if (args.hasExplicitDomain) c += 25;
  if (args.relatedRecordCount > 0) c += 10;
  return Math.min(100, c);
}

/**
 * Walk one deal → contacts → domains → accounts and return the best hint
 * (or null when no candidate domain produced a match).
 */
export async function inferAccountForDeal(
  deal: DealRow,
): Promise<InferenceResult | null> {
  const zohoContactIds = extractLinkedContactZohoIds(deal.raw_data);
  if (zohoContactIds.length === 0) return null;

  const contacts = await lookupContactsByZohoIds(zohoContactIds);
  if (contacts.length === 0) return null;

  // domain → list of evidence contacts that agreed on that domain.
  const domainEvidence = new Map<string, ContactRow[]>();
  for (const ct of contacts) {
    const d = ct.email ? extractDomain(ct.email) : null;
    if (!d) continue;
    if (!domainEvidence.has(d)) domainEvidence.set(d, []);
    domainEvidence.get(d)!.push(ct);
  }
  if (domainEvidence.size === 0) return null;

  let best: InferenceResult | null = null;
  for (const [d, evContacts] of domainEvidence) {
    const candidate = await findBestAccountForDomain(d);
    if (!candidate) continue;
    const conf = scoreConfidence({
      agreeingContacts: evContacts.length,
      hasExplicitDomain: candidate.has_explicit_domain,
      relatedRecordCount: candidate.related_record_count,
    });
    if (!best || conf > best.confidence) {
      const primary = evContacts[0];
      best = {
        account: candidate,
        evidence_contact_id: primary.id,
        evidence_contact_email: primary.email || "",
        domain: d,
        confidence: conf,
      };
    }
  }
  return best;
}

export interface InferenceScanResult {
  scanned: number;
  hinted: number;
  inserted: number;
  updated: number;
  no_contact: number;
  no_match: number;
  duration_ms: number;
}

/**
 * Run inference across every deal that needs help. Idempotent — upserts on
 * (deal_record_id, suggested_account_record_id). Existing dismissed hints
 * for the same (deal, account) pair are NOT resurrected; their status is
 * left alone.
 */
export async function scanDealsForAccountHints(): Promise<InferenceScanResult> {
  const t0 = Date.now();
  const res: InferenceScanResult = {
    scanned: 0,
    hinted: 0,
    inserted: 0,
    updated: 0,
    no_contact: 0,
    no_match: 0,
    duration_ms: 0,
  };

  const deals = await pool.query(
    `SELECT r.id, r.zoho_record_id, r.account_name, r.company_name,
            r.domain, r.raw_data, r.cluster_id,
            c.domain AS cluster_domain
       FROM duplicate_records r
       LEFT JOIN duplicate_clusters c ON c.id = r.cluster_id
      WHERE r.record_type = 'deal'
        AND r.zoho_module = 'Deals'`,
  );

  for (const row of deals.rows) {
    const deal: DealRow = {
      id: row.id,
      zoho_record_id: row.zoho_record_id,
      account_name: row.account_name,
      company_name: row.company_name,
      domain: row.domain,
      raw_data: row.raw_data,
      cluster_id: row.cluster_id,
      cluster_domain: row.cluster_domain,
    };
    if (!dealNeedsHelp(deal)) continue;
    res.scanned++;

    const hint = await inferAccountForDeal(deal);
    if (!hint) {
      const linkedContacts = extractLinkedContactZohoIds(deal.raw_data);
      if (linkedContacts.length === 0) res.no_contact++;
      else res.no_match++;
      continue;
    }

    res.hinted++;

    // Upsert by (deal_id, account_id). If the row exists and status is
    // 'pending', refresh confidence + evidence; if 'dismissed' or
    // 'applied', leave it alone (sales already decided).
    const upsert = await pool.query(
      `INSERT INTO account_inference_hints
         (deal_record_id, suggested_account_record_id, suggested_account_name,
          suggested_domain, evidence_contact_record_id, evidence_contact_email,
          confidence, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
       ON CONFLICT (deal_record_id, suggested_account_record_id) DO UPDATE
         SET suggested_account_name = EXCLUDED.suggested_account_name,
             suggested_domain        = EXCLUDED.suggested_domain,
             evidence_contact_record_id = EXCLUDED.evidence_contact_record_id,
             evidence_contact_email     = EXCLUDED.evidence_contact_email,
             confidence              = EXCLUDED.confidence,
             updated_at              = CURRENT_TIMESTAMP
       WHERE account_inference_hints.status = 'pending'
       RETURNING (xmax = 0) AS inserted`,
      [
        deal.id,
        hint.account.id,
        hint.account.account_name || hint.account.company_name,
        hint.domain,
        hint.evidence_contact_id,
        hint.evidence_contact_email,
        hint.confidence,
      ],
    );
    if (upsert.rows.length > 0) {
      if (upsert.rows[0].inserted) res.inserted++;
      else res.updated++;
    }
  }

  res.duration_ms = Date.now() - t0;
  logger.info("[accountInference] scan complete", res);
  return res;
}

export interface HintRow {
  id: number;
  deal_record_id: number;
  deal_zoho_id: string | null;
  deal_account_name: string | null;
  deal_company_name: string | null;
  suggested_account_record_id: number | null;
  suggested_account_zoho_id: string | null;
  suggested_account_name: string | null;
  suggested_domain: string | null;
  evidence_contact_record_id: number | null;
  evidence_contact_zoho_id: string | null;
  evidence_contact_email: string | null;
  confidence: number;
  status: string;
  created_at: Date;
  updated_at: Date;
}

export async function listAccountInferenceHints(opts: {
  status?: string;
  limit?: number;
  segment?: string;
}): Promise<{
  hints: HintRow[];
  summary: { pending: number; dismissed: number; applied: number };
}> {
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 2000));
  const status = opts.status && ["pending", "dismissed", "applied"].includes(opts.status)
    ? opts.status
    : "pending";
  // Segment chip (Sample User 2026-07-15): filter hints to the source DEAL's Zoho
  // Layout (aliased `d` here), same predicate as every tab. buildSegmentPredicate
  // emits an `r.` alias — swap it to `d.`. $1=status, segment binds start at $2,
  // LIMIT is the last placeholder.
  const params: any[] = [status];
  let segCond = "";
  if (opts.segment && opts.segment !== "all") {
    const { buildSegmentPredicate } = await import("./duplicateRadarDatabase");
    const seg = buildSegmentPredicate(opts.segment as any, params.length + 1);
    if (seg.condition) {
      segCond = ` AND ${seg.condition.replace(/\br\./g, "d.")}`;
      params.push(...seg.params);
    }
  }
  params.push(limit);
  const limitPh = `$${params.length}`;
  const rows = await pool.query(
    `SELECT h.id,
            h.deal_record_id,
            d.zoho_record_id AS deal_zoho_id,
            d.account_name   AS deal_account_name,
            d.company_name   AS deal_company_name,
            h.suggested_account_record_id,
            a.zoho_record_id AS suggested_account_zoho_id,
            h.suggested_account_name,
            h.suggested_domain,
            h.evidence_contact_record_id,
            ct.zoho_record_id AS evidence_contact_zoho_id,
            h.evidence_contact_email,
            h.confidence,
            h.status,
            h.created_at,
            h.updated_at
       FROM account_inference_hints h
       LEFT JOIN duplicate_records d  ON d.id  = h.deal_record_id
       LEFT JOIN duplicate_records a  ON a.id  = h.suggested_account_record_id
       LEFT JOIN duplicate_records ct ON ct.id = h.evidence_contact_record_id
      WHERE h.status = $1
        -- Empty/Junk exclusion (Task 3), Account-Hints exception: hide the
        -- deal if it's been classified empty/test/junk/tagged cleanup, but
        -- KEEP 'orphaned' deals — Account Hints is their intended home for
        -- linking to the right Account. d may be NULL if the source deal
        -- record was since removed, so don't drop those rows here.
        AND (d.cleanup_class IS NULL OR d.cleanup_class = 'orphaned')${segCond}
      ORDER BY h.confidence DESC, h.updated_at DESC
      LIMIT ${limitPh}`,
    params,
  );
  const summaryRes = await pool.query(
    `SELECT status, COUNT(*)::int AS n
       FROM account_inference_hints
      GROUP BY status`,
  );
  const summary = { pending: 0, dismissed: 0, applied: 0 };
  for (const s of summaryRes.rows) {
    if (s.status === "pending") summary.pending = s.n;
    else if (s.status === "dismissed") summary.dismissed = s.n;
    else if (s.status === "applied") summary.applied = s.n;
  }
  return { hints: rows.rows, summary };
}

export async function setHintStatus(
  hintId: number,
  status: "dismissed" | "applied",
): Promise<boolean> {
  const res = await pool.query(
    `UPDATE account_inference_hints
        SET status = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING id`,
    [hintId, status],
  );
  return res.rows.length > 0;
}

/**
 * AI-resolve a single Account-Hint row: write the suggested Account_Name
 * directly onto the Zoho Deal, then mark the hint applied. Refuses to act
 * when confidence is below the threshold (default 70%) so low-signal hints
 * still go through the human Applied / Dismiss flow. Returns a structured
 * report the route surfaces back to the dashboard.
 *
 * Attribution mirrors the autonomous resolver — "GRQ Assistant (on behalf
 * of …)" — so the activity log treats this as agent work.
 */
export async function aiResolveAccountHint(
  hintId: number,
  performedBy: string,
  opts: { minConfidence?: number } = {},
): Promise<{
  success: boolean;
  hintId: number;
  dealZohoId?: string | null;
  accountZohoId?: string | null;
  confidence?: number;
  error?: string;
  reason?: string;
}> {
  const minConfidence = opts.minConfidence ?? 70;

  // Read the hint with its current join state so we have the latest deal +
  // suggested account ids (listAccountInferenceHints joins; we do the same
  // here to keep the surface narrow).
  const res = await pool.query(
    `SELECT h.id, h.status, h.confidence,
            d.zoho_record_id AS deal_zoho_id,
            a.zoho_record_id AS suggested_account_zoho_id,
            a.record_name    AS suggested_account_name
       FROM account_inference_hints h
       JOIN duplicate_records d ON d.id = h.deal_record_id
       JOIN duplicate_records a ON a.id = h.suggested_account_record_id
      WHERE h.id = $1
      LIMIT 1`,
    [hintId],
  );
  const row = res.rows[0];
  if (!row) {
    return { success: false, hintId, error: "Hint not found" };
  }
  if (row.status !== "pending") {
    return {
      success: false,
      hintId,
      reason: `Hint is already '${row.status}' — nothing to do.`,
    };
  }
  const confidence = Number(row.confidence || 0);
  if (confidence < minConfidence) {
    return {
      success: false,
      hintId,
      confidence,
      reason: `Confidence ${confidence}% is below the auto-apply threshold (${minConfidence}%). Review and use Applied / Dismiss manually.`,
    };
  }
  const dealZohoId = row.deal_zoho_id as string | null;
  const accountZohoId = row.suggested_account_zoho_id as string | null;
  if (!dealZohoId || !accountZohoId) {
    return {
      success: false,
      hintId,
      dealZohoId,
      accountZohoId,
      error:
        "Missing deal_zoho_id or suggested_account_zoho_id — sync likely incomplete; retry after the next scan.",
    };
  }

  try {
    await updateZohoRecord("Deals", dealZohoId, {
      Account_Name: { id: accountZohoId },
    });
  } catch (e: any) {
    return {
      success: false,
      hintId,
      dealZohoId,
      accountZohoId,
      confidence,
      error: e?.message || String(e),
    };
  }

  // Mark the row applied so the chip count moves immediately; the next
  // scan will retire the row entirely once Zoho propagates the Account_Name.
  await pool.query(
    `UPDATE account_inference_hints
        SET status = 'applied',
            updated_at = CURRENT_TIMESTAMP
      WHERE id = $1`,
    [hintId],
  );
  logger.info(
    `[accountInference] AI-resolved hint #${hintId}: Deal ${dealZohoId} → Account ${accountZohoId} (${row.suggested_account_name}; confidence ${confidence}%; by ${performedBy})`,
  );
  return {
    success: true,
    hintId,
    dealZohoId,
    accountZohoId,
    confidence,
  };
}

/**
 * Bulk AI-resolve every pending hint at-or-above the confidence threshold.
 * Sequential to keep Zoho call rate under the per-account ceiling. Caps
 * the run at `limit` (default 200) so a runaway is recoverable; the user
 * re-clicks the button to continue. Each per-row result lands in the
 * report so the UI can surface partial-success + per-deal errors.
 */
export async function aiResolveAllAccountHints(
  performedBy: string,
  opts: { minConfidence?: number; limit?: number } = {},
): Promise<{
  inspected: number;
  resolved: number;
  refused: number;
  errors: number;
  perHint: Array<{
    hintId: number;
    status: "resolved" | "refused" | "error";
    dealZohoId?: string | null;
    accountZohoId?: string | null;
    reason?: string;
    error?: string;
  }>;
}> {
  const minConfidence = opts.minConfidence ?? 70;
  const limit = Math.max(1, Math.min(opts.limit || 200, 1000));

  const candidates = await pool.query(
    `SELECT id FROM account_inference_hints
      WHERE status = 'pending' AND confidence >= $1
      ORDER BY confidence DESC, id ASC
      LIMIT $2`,
    [minConfidence, limit],
  );

  const report = {
    inspected: candidates.rows.length,
    resolved: 0,
    refused: 0,
    errors: 0,
    perHint: [] as Array<{
      hintId: number;
      status: "resolved" | "refused" | "error";
      dealZohoId?: string | null;
      accountZohoId?: string | null;
      reason?: string;
      error?: string;
    }>,
  };

  for (const c of candidates.rows) {
    try {
      const r = await aiResolveAccountHint(c.id, performedBy, {
        minConfidence,
      });
      if (r.success) {
        report.resolved++;
        report.perHint.push({
          hintId: r.hintId,
          status: "resolved",
          dealZohoId: r.dealZohoId,
          accountZohoId: r.accountZohoId,
        });
      } else if (r.error) {
        report.errors++;
        report.perHint.push({
          hintId: r.hintId,
          status: "error",
          dealZohoId: r.dealZohoId,
          accountZohoId: r.accountZohoId,
          error: r.error,
        });
      } else {
        report.refused++;
        report.perHint.push({
          hintId: r.hintId,
          status: "refused",
          reason: r.reason,
        });
      }
    } catch (e: any) {
      report.errors++;
      report.perHint.push({
        hintId: c.id,
        status: "error",
        error: e?.message || String(e),
      });
    }
  }

  logger.info(
    `[accountInference] Bulk AI-resolve: inspected=${report.inspected} resolved=${report.resolved} refused=${report.refused} errors=${report.errors} (by ${performedBy})`,
  );
  return report;
}
