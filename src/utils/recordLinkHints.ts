import { pool } from "./duplicateRadarDatabase";
import { extractDomain } from "./duplicateRadarDatabase";
import { realDomainRoot } from "./preflightStructuredPush";
import { logger } from "./logger";

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
  return cands.find(c => String(c.domain || "").toLowerCase() === d) || null;
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

  const domain =
    (contact.domain && contact.domain.trim()) ||
    realDomainRoot(contact.domain) ||
    (contact.email ? extractDomain(contact.email) : null) ||
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
        )`,
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

  const contactsRes = await pool.query(
    `SELECT id, zoho_record_id, record_name, company_name, email, domain,
            account_name, contact_name, raw_data, cluster_id
       FROM duplicate_records
      WHERE record_type = 'contact'`,
  );

  for (const row of contactsRes.rows) {
    const contact: DuplicateRecordRow = row;
    if (!contactNeedsAccount(contact.raw_data)) continue;
    const hint = await inferAccountForContact(contact);
    if (!hint || !hint.targetRecordId) continue;
    await upsertLinkHint(hint);
  }

  const dealsRes = await pool.query(
    `SELECT id, zoho_record_id, record_name, company_name, email, domain,
            account_name, contact_name, raw_data, cluster_id
       FROM duplicate_records
      WHERE record_type = 'deal'`,
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
