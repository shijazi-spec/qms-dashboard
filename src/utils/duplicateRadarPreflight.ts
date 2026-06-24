/**
 * Duplicate Radar — Preflight check for marketing import batches.
 *
 * Marketing pushes lead/deal lists from third-party generation tools. Before
 * the data hits CRM, run it through this preflight to surface:
 *
 *   - BLOCK     — domain already an active Customer Success customer
 *   - REVIEW    — domain churned within sector cool-off window
 *   - WARN      — domain churned past cool-off (Sales may re-engage, notify CS)
 *   - DUPLICATE — domain already has Leads/Deals (no active CS overlap)
 *   - PASS      — genuinely new
 *
 * Single batched SQL — handles thousands of rows in one round trip. No LLM
 * calls. No external dependencies beyond the existing Duplicate Radar tables.
 */

import { pool } from "./duplicateRadarDatabase";
import {
  extractDomain,
  normalizeDomain,
  normalizePhone,
  normalizeCompanyName,
  isPlaceholderName,
} from "./duplicateRadarDatabase";
import { logger } from "./logger";

/**
 * Marketplace / merchant Zoho layout names — the ONLY records the Duplicate
 * Radar treats as OUT OF SCOPE (Sarah / Ahmad 2026-06-17, confirmed against
 * the live layout distribution).
 *
 *   - Leads & Deals  → marketplace motion lives on the "Marketplace" layout.
 *   - Accounts       → merchants live on "Marketplace" OR "Partner Accounts".
 *   - Contacts       → almost all sit on Zoho's "Standard" layout, which gives
 *                      NO B2B-vs-merchant signal, so contacts are never used as
 *                      out-of-scope evidence (see has_corporate_records below).
 *
 * SCOPE IS INVERTED ON PURPOSE: a record is corporate (in-scope) UNLESS it
 * carries one of these explicit merchant markers. The old logic keyed on a
 * single corporate layout string ("Corporate Sales (WalaPlus Layout)") and so
 * silently dropped Accounts ("Corporate-Accounts") and every legacy
 * marker-less record — the root cause of corporate dupes leaking through
 * Preflight as false PASSes. Keep this list as the single source of truth;
 * compare case-insensitively so a casing change in Zoho can't break it.
 */
export const MERCHANT_LAYOUT_NAMES = ["Marketplace", "Partner Accounts"] as const;
/** Pre-built lowercased SQL IN-list, e.g. `'marketplace', 'partner accounts'`. */
const MERCHANT_LAYOUTS_SQL = MERCHANT_LAYOUT_NAMES.map(
  (n) => `'${n.toLowerCase().replace(/'/g, "''")}'`,
).join(", ");

export type PreflightVerdict =
  | "block"
  | "review"
  | "warn"
  | "duplicate"
  | "no_contact"
  | "pass";

/**
 * Preflight rule mode (Ahmad 2026-06-18).
 *
 *   "basic" (default) — only the two foundational rules run:
 *     RULE 1  contact duplicate — the row's email OR phone already exists
 *             on any CRM record → REJECT (verdict "duplicate").
 *     RULE 2  existing customer — only if RULE 1 found nothing, the
 *             company domain has a deal in Agreement Signed / Paid (or the
 *             equivalent customer stages) WITH NO churn date → REJECT
 *             (verdict "block"). Everything else PASSES.
 *
 *   "full" — the rich verdict ladder (active leads, active deals, closed-
 *     lost link, churn cool-off review/warn, known-company link, signal-
 *     strength downgrades, fuzzy / company-name paths). ARCHIVED for now —
 *     kept intact behind this flag so we can re-enable it later without a
 *     rewrite. Set env PREFLIGHT_RULE_MODE=full to switch back.
 */
export const PREFLIGHT_RULE_MODE: "basic" | "full" =
  (process.env.PREFLIGHT_RULE_MODE || "").toLowerCase() === "full"
    ? "full"
    : "basic";

/**
 * Customer stages for RULE 2 — a deal in either of these (with NO churn date)
 * means the company is a live customer. Ahmad 2026-06-18: STRICTLY these two
 * (Agreement Signed / Paid) — no Closed Won / Client Activated / Transferred-
 * to-CS equivalents. "Paid" == "Agreement Signed" per the established GRQ
 * business rule. Compared lowercased.
 */
export const PF_BASIC_CUSTOMER_STAGES: ReadonlyArray<string> = [
  "agreement signed",
  "paid",
];

export interface PreflightInputRow {
  domain?: string | null;
  email?: string | null;
  company_name?: string | null;
  phone?: string | null;
  /** Person name — when present with NO email AND NO phone, the row is REJECTED
   *  (verdict no_contact) since the contact can't be reached. */
  contact_name?: string | null;
  /** Free-form row identifier echoed back in the response (defaults to array index). */
  ref?: string | null;
}

export interface PreflightResultRow {
  row_index: number;
  ref?: string | null;
  input: {
    domain: string | null;
    company_name?: string | null;
  };
  verdict: PreflightVerdict;
  cluster_id: number | null;
  lifecycle_state:
    | "onboarding"
    | "adoption"
    | "renewal"
    | "termination_recent"
    | "termination_old"
    | null;
  sector: "private" | "government" | null;
  arr_exposure: number | null;
  owners: string[];
  reason: string;
  suggested_action: string;
  /**
   * Per-module record counts on the matched cluster — null on PASS rows
   * (no cluster) and on tenants where the cluster aggregation hasn't
   * populated the counts yet. Surfaces in the dashboard as a compact
   * "Leads N · Deals N · Contacts N · Accounts N" column so the operator
   * can scan multi-module exposure without opening every row.
   */
  module_counts: {
    leads: number;
    deals: number;
    contacts: number;
    accounts: number;
    total: number;
  } | null;
  /**
   * How the row's cluster was found. Added 2026-06-11 when Preflight
   * grew phone + company-name fallback lookups:
   *   "domain"       — domain or email-domain match (the original path)
   *   "email"        — exact contact email matched a CRM record (Tier 2, strong)
   *   "phone"        — normalized phone hit a duplicate_records row
   *   "company_name" — normalized company name fuzzy-matched a cluster
   *   null           — no match (PASS rows) or no fallback path
   */
  matched_via: "domain" | "email" | "phone" | "company_name" | null;
  /**
   * Business-language recommendation for this row — what a Head of Sales
   * needs to read in one line. Derived deterministically from verdict +
   * lifecycle_state + owners; engineer-language reason/code stays in
   * `reason`/`suggested_action` so existing integrations don't break.
   *
   * Examples:
   *   "Existing customer in Onboarding — do not pursue. Route to CS (Sara)."
   *   "Active open Sales deal — coordinate with owner Ahmed before contacting."
   *   "Already a duplicate in pipeline (3 records). Assign to existing
   *    owner Mohammed; do not create a new lead."
   *   "Safe to import."
   */
  executive_action: string;
  /** info | low | medium | high | critical — drives row colouring. */
  executive_severity: "info" | "low" | "medium" | "high" | "critical";
  /**
   * Latest Churn_Date observed on the matched cluster's Deal records
   * (ISO date string). Surfaces in the Excel "Churn date" column + the
   * executive_action body. Null on PASS rows and clusters without a
   * terminated Deal.
   */
  churn_date?: string | null;
  /** Days since the latest churn. Null when churn_date is null. */
  churn_days?: number | null;
  /**
   * CS owner name when the cluster has a CS-side Deal (Paid /
   * Agreement Signed / Termination). Empty string when the cluster's
   * deals are all sales-side. Lets the email say "coordinate with CS
   * owner X" instead of guessing from the generic owner list.
   */
  cs_owner?: string | null;
  /** Raw CS Lifecycle phase verbatim (New Deal / Onboarding / Adoption /
   *  Renewal / Termination) for the export's CS Phase column. */
  cs_phase?: string | null;
  /**
   * Sarah 2026-06-17 — clickable Zoho links for the EXISTING records
   * the rejection points at. The Excel report exposes each one in its
   * own column so the operator clicks straight to the live Lead /
   * Deal / Account in Zoho without re-querying the radar. Up to four
   * fields are populated depending on what the matched cluster
   * contains. Empty / null on PASS rows.
   */
  crm_links?: {
    active_lead?: { url: string; label: string } | null;
    active_deal?: { url: string; label: string } | null;
    client_deal?: { url: string; label: string } | null;
    account?: { url: string; label: string } | null;
  } | null;
}

export interface PreflightSummary {
  block: number;
  review: number;
  warn: number;
  duplicate: number;
  no_contact: number;
  pass: number;
}

export interface PreflightTopReason {
  /** Business-language label, ready for the email body. */
  label: string;
  count: number;
  /** Percent of EXAMINED rows. */
  pct: number;
}

export interface PreflightResponse {
  total_rows: number;
  examined: number;
  skipped: number;
  summary: PreflightSummary;
  total_arr_exposure_blocked: number;
  rows: PreflightResultRow[];
  /**
   * Top reasons rows hit duplicate verdicts, ranked. Email-ready
   * "12 leads matched existing customers" style labels — caller can
   * drop straight into a paragraph without further string work.
   */
  top_reasons: PreflightTopReason[];
  /**
   * Generated at — UTC ISO. Lets the Excel cover sheet stamp
   * "Preflight check — generated 2026-06-16 12:00 UTC".
   */
  generated_at: string;
  /** Share of examined rows that returned a non-pass verdict (0–100). */
  pct_actionable: number;
}

/**
 * Map verdict + lifecycle + owners to executive-language recommendation.
 * Pure function so it stays testable and the email body never sees the
 * engineering codes (block / review / warn / duplicate / pass).
 */
export function buildExecutiveAction(input: {
  verdict: PreflightVerdict;
  lifecycle_state?: PreflightResultRow["lifecycle_state"];
  module_counts?: PreflightResultRow["module_counts"];
  owners?: string[];
  arr_exposure?: number | null;
  sector?: PreflightResultRow["sector"];
  /**
   * True iff the matched cluster has a Deal whose Stage is NOT in
   * {Closed Lost, Lost, Dropped, Cancelled}. When undefined, falls back
   * to "any deal counts" (legacy behaviour). Without this flag, a
   * company whose only deal is Closed Lost was falsely reported as
   * "Active deal already in pipeline" — the wording that misled Sales.
   */
  has_active_deal?: boolean;
  /**
   * True iff the matched cluster has at least one Lead whose
   * Lead_Status is NOT in {Junk Lead, Bogus Lead, Lost Lead, Not
   * Qualified, Disqualified, Converted}. Sarah 2026-06-17 — a
   * vendor row that hits an active Lead must be REJECTED outright
   * (severity HIGH, wording "DO NOT re-import"). When undefined,
   * the active-lead branch is skipped and the function falls
   * through to the closed/known-company branches.
   */
  has_active_lead?: boolean;
  /** Latest Churn_Date on the cluster (ISO yyyy-mm-dd). */
  churn_date?: string | null;
  /** Days since the latest churn. */
  churn_days?: number | null;
  /** CS owner name (when the cluster has CS-side deals). */
  cs_owner?: string | null;
  /** Name of the existing canonical Account/cluster the new lead should
   *  be linked to when re-engaged. Used by the Closed-Lost-only and
   *  no-deal-but-known branches so the email tells Sales exactly which
   *  Account to set Account_Name to instead of "the existing one". */
  account_name?: string | null;
}): { text: string; severity: PreflightResultRow["executive_severity"] } {
  const ownerStr =
    Array.isArray(input.owners) && input.owners.length > 0
      ? input.owners.slice(0, 2).join(", ") +
        (input.owners.length > 2 ? ` +${input.owners.length - 2}` : "")
      : null;
  const ownerSuffix = ownerStr ? ` (current owner: ${ownerStr})` : "";
  const csOwnerSuffix = input.cs_owner
    ? ` (CS owner: ${input.cs_owner})`
    : ownerSuffix;
  const sectorLabel =
    input.sector === "government" ? "Government" : "Private";
  const cooloffDays = input.sector === "government" ? 365 : 180;
  const churnDate = (input.churn_date || "").trim();

  if (input.verdict === "block") {
    const phase =
      input.lifecycle_state === "onboarding"
        ? "in Onboarding"
        : input.lifecycle_state === "adoption"
          ? "in Adoption"
          : input.lifecycle_state === "renewal"
            ? "in Renewal"
            : "active";
    return {
      text: `EXISTING ${sectorLabel} CUSTOMER — ${phase}. DO NOT pursue, do NOT load as a new lead. Route to Customer Success${csOwnerSuffix}.`,
      severity: "critical",
    };
  }
  if (input.verdict === "review") {
    // Within the sector cool-off window — CS-side action required.
    const daysPart = input.churn_days != null && input.churn_days >= 0
      ? `${input.churn_days} day${input.churn_days === 1 ? "" : "s"} ago`
      : null;
    const datePart = churnDate ? `on ${churnDate}` : null;
    const churnSentence = daysPart || datePart
      ? `Churned ${[daysPart, datePart].filter(Boolean).join(" ")} — within the ${cooloffDays}-day ${sectorLabel} cool-off (${cooloffDays - (input.churn_days ?? 0)} day${cooloffDays - (input.churn_days ?? 0) === 1 ? "" : "s"} remaining).`
      : `Within the ${cooloffDays}-day ${sectorLabel} cool-off.`;
    return {
      text: `RECENT CS TERMINATION — ${churnSentence} CS must sign off before any outreach${csOwnerSuffix}.`,
      severity: "high",
    };
  }
  if (input.verdict === "warn") {
    // Past cool-off — Sales MAY re-engage, but must notify CS owner and
    // tag the row so the briefing carries the historical context.
    const daysPart = input.churn_days != null && input.churn_days >= 0
      ? `${input.churn_days} day${input.churn_days === 1 ? "" : "s"} ago`
      : null;
    const datePart = churnDate ? `on ${churnDate}` : null;
    const churnSentence = daysPart || datePart
      ? `Already churned ${[daysPart, datePart].filter(Boolean).join(" ")} — past the ${cooloffDays}-day ${sectorLabel} cool-off.`
      : `Past the ${cooloffDays}-day ${sectorLabel} cool-off.`;
    return {
      text: `PRIOR CS CUSTOMER — Sales MAY re-engage. ${churnSentence} Notify ${input.cs_owner ? `CS owner ${input.cs_owner}` : "the CS owner"} first; carry the churn history into the conversation.`,
      severity: "medium",
    };
  }
  if (input.verdict === "duplicate") {
    const recs = input.module_counts?.total || 0;
    const dealsN = input.module_counts?.deals || 0;
    const leadsN = input.module_counts?.leads || 0;
    const contactsN = input.module_counts?.contacts || 0;
    const accountsN = input.module_counts?.accounts || 0;
    const modBreakdown = [
      leadsN ? `${leadsN} lead${leadsN === 1 ? "" : "s"}` : null,
      dealsN ? `${dealsN} deal${dealsN === 1 ? "" : "s"}` : null,
      contactsN ? `${contactsN} contact${contactsN === 1 ? "" : "s"}` : null,
      accountsN ? `${accountsN} account${accountsN === 1 ? "" : "s"}` : null,
    ].filter(Boolean).join(", ");
    // Only claim "Active deal in pipeline" when the cluster actually
    // contains a Deal in a live Stage. has_active_deal === undefined
    // = legacy caller without the enrichment; fall back to "any deal"
    // so the line still appears, just less precisely.
    const hasActiveDeal =
      input.has_active_deal === undefined
        ? dealsN > 0
        : input.has_active_deal === true;
    if (hasActiveDeal) {
      return {
        text: `ACTIVE SALES DEAL IN PIPELINE — ${modBreakdown} on file (${recs} total record${recs === 1 ? "" : "s"}). Assign to existing owner${ownerSuffix.replace("current ", "")}; do NOT create a new lead, it will become a duplicate.`,
        severity: "high",
      };
    }
    // Sarah 2026-06-17 — active-lead REJECT rule. If the cluster has at
    // least one Lead that's still being worked (Lead_Status not in
    // junk/lost/bogus/disqualified/converted), the vendor row would
    // create a parallel-lead duplicate and must be flat-out rejected.
    // SDR is already on it — pushing this in causes double-touch and
    // the routing-call mess Sarah described.
    if (input.has_active_lead === true) {
      const accountSuffix = input.account_name
        ? ` (existing Account "${input.account_name}")`
        : "";
      return {
        text: `REJECT — ACTIVE LEAD ALREADY IN PIPELINE${accountSuffix}: ${modBreakdown} on file (${recs} total record${recs === 1 ? "" : "s"}). SDR is already working this lead — do NOT re-import. Pass any new contact info to the existing Lead owner${ownerSuffix.replace("current ", "")}.`,
        severity: "high",
      };
    }
    // Sarah 2026-06-17 — Closed-Lost-only clusters are NOT a hard block:
    // the prior deal didn't close, the company is known, and Sales MAY
    // re-engage. Drop the verdict from "DUPLICATE / medium" to a softer
    // "PRIOR LOST OPPORTUNITY / low" and tell Sales the right next step:
    // link the new lead to the existing Account (don't spawn a parallel
    // record). Surfaces the actual Account name so the cell carries the
    // routing target without the operator opening the cluster.
    if (dealsN > 0) {
      const accountTarget = input.account_name
        ? `the existing Account "${input.account_name}"`
        : "the existing Account on this domain";
      const churnNote = churnDate
        ? ` Last activity ${churnDate}${input.churn_days ? ` (${input.churn_days}d ago)` : ""}.`
        : "";
      return {
        text: `PRIOR LOST OPPORTUNITY — ${dealsN} closed/lost deal${dealsN === 1 ? "" : "s"} on file (${modBreakdown}; ${recs} total record${recs === 1 ? "" : "s"}). Sales MAY re-engage.${churnNote} Link the new lead to ${accountTarget} (set Account_Name) instead of creating a parallel record${ownerSuffix}.`,
        severity: "low",
      };
    }
    // Known company, no deal at all — Contact or Account on file but
    // never a Sales motion. Same prescription: link, don't fork.
    const accountTarget = input.account_name
      ? `the existing Account "${input.account_name}"`
      : "the existing Account on this domain";
    return {
      text: `KNOWN COMPANY — ${modBreakdown || `${recs} record${recs === 1 ? "" : "s"}`} on file but no prior Sales deal. Link the new lead to ${accountTarget} (set Account_Name)${ownerSuffix}; do NOT create a parallel record.`,
      severity: "low",
    };
  }
  return { text: "Safe to import.", severity: "info" };
}

const VERDICT_REASONS: Record<PreflightVerdict, string> = {
  block: "active_cs_customer",
  review: "cs_termination_within_cooloff",
  warn: "cs_termination_past_cooloff",
  duplicate: "existing_record_no_cs_overlap",
  no_contact: "no_email_or_phone",
  pass: "no_match",
};

const SUGGESTED_ACTIONS: Record<PreflightVerdict, string> = {
  block:
    "Do not push as new lead. Loop in CS owner before any outreach.",
  review:
    "Within Customer Success cool-off window. Coordinate with CS before contacting.",
  warn:
    "Past cool-off — Sales may re-engage. Notify CS owner first.",
  duplicate:
    "Already present in Leads/Deals as a duplicate. Resolve in radar before importing.",
  no_contact:
    "No email and no phone — this contact cannot be reached. Do not import.",
  pass: "No overlap detected. Safe to import.",
};

/**
 * Extract a normalized domain from a row using whichever signal is present
 * (explicit domain first, then domain part of an email).
 *
 * The "domain" column in operator-pasted CSVs is frequently NOT a real
 * domain — it's a slug, ref, or company shorthand (e.g. `mitsui`,
 * `saso`, `kfshrc`) because the source spreadsheet treats it as an
 * internal id. If the explicit value has no dot OR contains whitespace,
 * it cannot be a real domain — we fall through to the email's domain
 * instead. Without this fallback PATH 1 misses on almost every row of
 * a real marketing list, and the request gets pushed into the slower
 * PATH 2/3 paths until the Replit gateway 504s.
 */
export function resolveDomain(row: PreflightInputRow): string | null {
  const explicit = (row.domain ?? "").trim().toLowerCase();
  const looksLikeDomain =
    explicit.length > 0 &&
    explicit.includes(".") &&
    !/\s/.test(explicit);
  if (looksLikeDomain) return normalizeDomain(explicit);
  const fromEmail = extractDomain(row.email ?? "");
  if (fromEmail) return normalizeDomain(fromEmail);
  // Last resort: an explicit non-empty value that didn't pass the
  // looksLikeDomain check still gets normalised — better to attempt the
  // lookup (it just won't hit) than drop the row's signal entirely.
  return explicit ? normalizeDomain(explicit) : null;
}

/**
 * Normalized phone (≥7 digits) for the phone-match fallback path. Mirrors
 * findOrCreateClusterByCompany — anything shorter than 7 digits is too
 * generic to use as identity and is dropped silently.
 */
export function resolvePhone(row: PreflightInputRow): string | null {
  const raw = (row.phone ?? "").trim();
  if (!raw) return null;
  const normalized = normalizePhone(raw);
  return normalized && normalized.length >= 7 ? normalized : null;
}

/**
 * Normalized company name for the fuzzy-match fallback path.
 *
 * Sarah 2026-06-17 — char floor lowered from 5 to 3 so well-known
 * short brand names ("STC", "PIF", "NDMC", "SDB") attempt a match
 * instead of silently falling through to PASS. The trigram threshold
 * is also lowered (PATH 3 SQL drops from 0.6 to 0.55) so 3-character
 * names actually find their cluster. Empty / 1-2 char garbage is
 * still dropped.
 */
/**
 * Generic / placeholder company names that must NEVER be used for fuzzy
 * matching — they collide unrelated companies into one cluster (the
 * "Confidential" catch-all that produced false rejects). Compared against the
 * normalised name. 2026-06-17 per the Preflight Rejection Rules spec §1/§4.
 */
const GENERIC_COMPANY_NAMES = new Set([
  "confidential",
  "confidencial",
  "na",
  "n a",
  "nan",
  "unknown",
  "none",
  "null",
  "test",
  "company",
  "tbd",
  "private",
]);

export function resolveCompany(row: PreflightInputRow): string | null {
  const raw = (row.company_name ?? "").trim();
  if (!raw) return null;
  const normalized = normalizeCompanyName(raw);
  if (!normalized || normalized.length < 3) return null;
  if (GENERIC_COMPANY_NAMES.has(normalized)) return null; // placeholder → no match
  return normalized;
}

/**
 * Free-mail / public email domains. Rows whose email is in this set
 * never make a usable PATH 1 (domain) lookup — domain points to the
 * email provider, not the company. Sarah 2026-06-17 — even if every
 * lookup path misses, these rows must NOT auto-PASS: the operator
 * must verify by company name or phone before importing. The list is
 * a superset of what's commonly seen on Saudi vendor lists; kept here
 * (not env-tunable) so the rule travels with the code.
 */
/**
 * Sarah 2026-06-17 — the WalaPlus Zoho org id, used to build clickable
 * record URLs in the rejected-row briefing. Same id used across the
 * rest of the dashboard (calls.html, ai-approvals.html etc.); kept
 * hardcoded here so the helper is dependency-free.
 */
const ZOHO_ORG_ID = "org766568398";

/**
 * Build a clickable Zoho CRM URL for one record. Zoho's URL tab names
 * differ from the module names — Deals use the "Potentials" tab path.
 */
export function buildZohoRecordUrl(
  module: "Leads" | "Deals" | "Contacts" | "Accounts",
  zohoRecordId: string,
): string {
  const tab =
    module === "Deals" ? "Potentials"
    : module === "Leads" ? "Leads"
    : module === "Contacts" ? "Contacts"
    : "Accounts";
  return `https://crm.zoho.com/crm/${ZOHO_ORG_ID}/tab/${tab}/${encodeURIComponent(
    zohoRecordId,
  )}`;
}

/**
 * Build the per-row crm_links payload from a matched cluster. Each
 * sub-field is null when the cluster doesn't carry a record of that
 * type (or when the record has no Zoho id). The Excel export reads
 * this directly to populate hyperlink cells.
 */
function _buildCrmLinks(c: any): PreflightResultRow["crm_links"] {
  const mk = (mod: "Leads" | "Deals" | "Accounts", zid?: string | null, name?: string | null) =>
    zid
      ? { url: buildZohoRecordUrl(mod, zid), label: (name || "").trim() || zid }
      : null;
  return {
    active_lead:  mk("Leads",    c?.active_lead_zoho_id,  c?.active_lead_name),
    active_deal:  mk("Deals",    c?.active_deal_zoho_id,  c?.active_deal_name),
    client_deal:  mk("Deals",    c?.client_deal_zoho_id,  c?.client_deal_name),
    account:      mk("Accounts", c?.account_zoho_id_link, c?.account_name_link),
  };
}

const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "yahoo.com",
  "ymail.com",
  "rocketmail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "protonmail.com",
  "proton.me",
  "mail.ru",
  "yandex.com",
  "yandex.ru",
  "msn.com",
  "qq.com",
  "163.com",
  "126.com",
]);

/**
 * Strategic-domain suffixes (Saudi government and education). Sarah
 * 2026-06-17 — even when no CRM cluster matches, any vendor row whose
 * resolved domain ends in one of these gets a REVIEW verdict so it
 * routes through the Head of Sales before SDR touches it. These
 * accounts are too strategic to silently auto-import.
 */
const STRATEGIC_TLD_SUFFIXES: ReadonlyArray<string> = [
  ".gov.sa",
  ".edu.sa",
];

/** True iff the input row's email domain is a free-mail provider. */
export function isFreeMailRow(row: PreflightInputRow): boolean {
  const e = (row.email ?? "").trim().toLowerCase();
  if (!e || !e.includes("@")) return false;
  const dom = e.split("@").pop() || "";
  return FREE_MAIL_DOMAINS.has(dom);
}

/** True iff the resolved domain ends in a strategic-account suffix. */
export function isStrategicDomain(domain: string | null | undefined): boolean {
  if (!domain) return false;
  const d = String(domain).trim().toLowerCase();
  if (!d) return false;
  return STRATEGIC_TLD_SUFFIXES.some((s) => d.endsWith(s));
}

export interface PreflightClusterRow {
  id: number;
  domain: string;
  company_name?: string | null;
  cs_overlap_verdict: string | null;
  pipeline_lifecycle_state: string | null;
  client_sector: string | null;
  arr_exposure: string | number | null;
  owners_involved?: unknown;
  total_leads?: number;
  total_deals?: number;
  total_contacts?: number;
  total_accounts?: number;
  /**
   * True when the matched cluster contains at least one Deal whose Stage
   * is NOT in {Closed Lost, Lost, Dropped, Cancelled}. Drives the
   * "Active deal in pipeline" line in buildExecutiveAction so the HoS
   * email never claims an active deal exists when the only deal is dead.
   * Populated by the cluster-enrichment block after the 3 lookup paths
   * complete — runs once over the matched cluster id set.
   */
  has_active_deal?: boolean;
  /**
   * True when the matched cluster has at least one Lead whose
   * Lead_Status is NOT in {Junk Lead, Bogus Lead, Lost Lead, Not
   * Qualified, Disqualified, Converted}. Sarah 2026-06-17 — a vendor
   * row that hits an ACTIVE LEAD must be REJECTED outright: SDR is
   * already working it; importing a parallel record creates a real
   * duplicate. Severity goes to HIGH and the action is "DO NOT
   * re-import".
   */
  has_active_lead?: boolean;
  /**
   * True when the cluster contains at least one corporate Lead/Deal/Account
   * — i.e. a record NOT on a merchant layout (see MERCHANT_LAYOUT_NAMES:
   * "Marketplace" / "Partner Accounts"). Scope is INVERTED: everything is
   * corporate unless explicitly merchant, so Corporate-Accounts, Standard-
   * layout records and legacy marker-less rows all count. Contacts are
   * deliberately NOT counted here (Standard layout = no B2B/merchant
   * signal). When a cluster has zero corporate Lead/Deal/Account the
   * Preflight treats the match as out-of-scope (PASS) so the vendor list
   * isn't graded against marketplace rules.
   */
  has_corporate_records?: boolean;
  /**
   * Per-module counts RESTRICTED to corporate records. Used by the
   * executive_action wording so the briefing only ever mentions the
   * portion of the cluster that's in-scope.
   */
  corporate_leads?: number;
  corporate_deals?: number;
  corporate_contacts?: number;
  corporate_accounts?: number;
  /**
   * Sarah 2026-06-17 — representative Zoho record per type so the
   * briefing artifacts (Excel report rows, copy-email body) can carry
   * a CLICKABLE link straight to the existing Lead / Deal / Account
   * on every rejected row. Pick rule per type: prefer ACTIVE over
   * closed/lost; for the "client deal" link use a Paid / Agreement
   * Signed / Closed Won / Awaiting PO / Client Activated / Transferred
   * to CS / Agreement Sent deal. Used by buildZohoRecordUrl + the
   * Excel export's hyperlink columns.
   */
  active_lead_zoho_id?: string | null;
  active_lead_name?: string | null;
  active_deal_zoho_id?: string | null;
  active_deal_name?: string | null;
  client_deal_zoho_id?: string | null;
  client_deal_name?: string | null;
  account_zoho_id_link?: string | null;
  account_name_link?: string | null;
  /**
   * The latest Churn_Date observed across the cluster's Deal records
   * (ISO date string, e.g. "2024-11-03"). Surfaces in the WARN /
   * REVIEW executive_action so the operator sees the actual date the
   * customer churned — not just "past cool-off". When the verdict is
   * BLOCK the date is still shown if present (gives context for the
   * "existing customer" call). Null when no Deal has a Churn_Date.
   */
  churn_date?: string | null;
  /**
   * Days since the latest churn (today − churn_date). Computed only
   * when churn_date is present. Used by buildExecutiveAction to say
   * "churned 412 days ago — past 365-day Government cool-off" without
   * the operator doing the arithmetic.
   */
  churn_days?: number | null;
  /**
   * The CS owner's name (if the cluster has a CS-side Deal). Surfaces
   * in BLOCK / REVIEW actions so the email tells the HoS WHO in CS to
   * coordinate with — currently was relying on the generic
   * `owners_involved` array which mixes Sales reps with CS owners.
   */
  cs_owner?: string | null;
}

/**
 * How the cluster for a single row was found. Drives the matched_via
 * field on the result row + lets the classifier stay pure (no DB).
 */
export interface PreflightRowMatch {
  cluster: PreflightClusterRow;
  matched_via: "domain" | "email" | "phone" | "company_name";
}

/**
 * One CRM record pulled for the all-records (Tier-1 / Tier-2) fallback — the
 * fix for companies that ARE in the CRM but have no formed duplicate-cluster
 * (the false-pass gap). Aggregated by `buildClusterFromRecords` into a
 * synthetic PreflightClusterRow so the existing verdict ladder applies.
 */
export interface PreflightRecordRow {
  cluster_id: number | null;
  domain: string | null;
  record_type: string | null;
  stage: string | null;
  status: string | null;
  lead_status: string | null;
  churn_date: string | null;
  gov_type: string | null;
  owner_name: string | null;
  record_name: string | null;
  company_name: string | null;
  zoho_record_id: string | null;
  layout_name: string | null;
  account_type: string | null;
  lead_type: string | null;
}

// Tier-1 stage vocabulary (Preflight Rejection Rules spec §2).
const PF_CUSTOMER_STAGES = new Set([
  "paid",
  "agreement signed",
  "closed won",
  "client activated",
  "transferred to cs",
]);
const PF_DEAD_STAGE_RE = /lost|dropped|cancel/;
// Lead statuses that do NOT count as an "active lead" — a matching new contact
// is therefore pursuable, not a hard reject. 2026-06-18 (Ahmad): added "new" and
// "attempted to contact" — those are cold (no real engagement yet), so a company
// whose only leads are New/Attempted should not block a new contact. Genuinely
// worked statuses (Contacted / Working / Qualified / …) still count as active.
const PF_DEAD_LEAD_STATUS = new Set([
  "junk lead",
  "bogus lead",
  "lost lead",
  "not qualified",
  "disqualified",
  "converted",
  "new",
  "attempted to contact",
]);

/** A record is corporate UNLESS it sits on an explicit merchant layout. */
function _recordIsCorporate(r: PreflightRecordRow): boolean {
  if ((r.record_type || "").toLowerCase() === "contact") return true; // Standard layout = no signal
  const layout = (r.layout_name || "").toLowerCase();
  const merchant = MERCHANT_LAYOUT_NAMES.map((n) => n.toLowerCase());
  if (!merchant.includes(layout)) return true;
  if ((r.account_type || "").toLowerCase() === "customer") return true;
  if ((r.lead_type || "").toLowerCase() === "customer") return true;
  return false;
}

/**
 * PURE — aggregate the CRM records sharing one domain into a synthetic
 * PreflightClusterRow and apply the Tier-1 rules (current customer / churned
 * cool-off / active pipeline / closed-lost). Returns null when the company is
 * entirely marketplace/merchant (out of scope). Unit-tested without a DB.
 */
export function buildClusterFromRecords(
  domain: string,
  records: PreflightRecordRow[],
  todayMs: number,
): PreflightClusterRow | null {
  const corp = records.filter(_recordIsCorporate);
  const isLDA = (r: PreflightRecordRow) =>
    ["lead", "deal", "account"].includes((r.record_type || "").toLowerCase());
  if (!corp.some(isLDA)) return null; // no corporate Lead/Deal/Account → out of scope

  const ofType = (t: string) =>
    corp.filter((r) => (r.record_type || "").toLowerCase() === t);
  const deals = ofType("deal");
  const leads = ofType("lead");
  const stageOf = (r: PreflightRecordRow) => (r.stage || "").toLowerCase().trim();

  const customerDeals = deals.filter((d) => PF_CUSTOMER_STAGES.has(stageOf(d)));
  const activeDeals = deals.filter((d) => {
    const s = stageOf(d);
    return s !== "" && !PF_CUSTOMER_STAGES.has(s) && !PF_DEAD_STAGE_RE.test(s);
  });
  const hasActiveDeal = activeDeals.length > 0;
  const hasActiveLead = leads.some(
    (l) => !PF_DEAD_LEAD_STATUS.has((l.lead_status || l.status || "").toLowerCase()),
  );

  const churnDates = deals
    .map((d) => (d.churn_date || "").trim())
    .filter((s) => s !== "")
    .sort();
  const churnDate = churnDates.length ? churnDates[churnDates.length - 1]! : null;
  let churnDays: number | null = null;
  if (churnDate) {
    const t = Date.parse(churnDate);
    if (Number.isFinite(t)) churnDays = Math.max(0, Math.floor((todayMs - t) / 86400000));
  }
  const isGov = records.some((r) => (r.gov_type || "").trim() !== "");
  const coolOff = isGov ? 365 : 180;

  // Tier-1 cs_overlap_verdict: current customer / churned-in-cool-off / past.
  let cs: string | null = null;
  if (customerDeals.length > 0) {
    if (churnDate) cs = churnDays != null && churnDays <= coolOff ? "review" : "warn";
    else cs = "block";
  }

  const pick = (
    rs: PreflightRecordRow[],
    field: "zoho_record_id" | "record_name",
  ) => rs.map((r) => r[field]).find((v) => v != null && v !== "") ?? null;
  const owners = Array.from(
    new Set(corp.map((r) => (r.owner_name || "").trim()).filter(Boolean)),
  );
  const repId = (records.find((r) => r.cluster_id != null)?.cluster_id) ?? 0;
  const companyName =
    corp.map((r) => (r.company_name || r.record_name || "").trim()).find(Boolean) || null;

  return {
    id: repId,
    domain,
    company_name: companyName,
    cs_overlap_verdict: cs,
    pipeline_lifecycle_state: null,
    client_sector: isGov ? "government" : "private",
    arr_exposure: null,
    owners_involved: owners,
    total_leads: leads.length,
    total_deals: deals.length,
    total_contacts: ofType("contact").length,
    total_accounts: ofType("account").length,
    has_active_deal: hasActiveDeal,
    has_active_lead: hasActiveLead,
    has_corporate_records: true,
    corporate_leads: leads.length,
    corporate_deals: deals.length,
    corporate_contacts: ofType("contact").length,
    corporate_accounts: ofType("account").length,
    active_lead_zoho_id: pick(
      leads.filter((l) => !PF_DEAD_LEAD_STATUS.has((l.lead_status || l.status || "").toLowerCase())),
      "zoho_record_id",
    ),
    active_lead_name: pick(leads, "record_name"),
    active_deal_zoho_id: pick(activeDeals, "zoho_record_id"),
    active_deal_name: pick(activeDeals, "record_name"),
    client_deal_zoho_id: pick(customerDeals, "zoho_record_id"),
    client_deal_name: pick(customerDeals, "record_name"),
    account_zoho_id_link: pick(ofType("account"), "zoho_record_id"),
    account_name_link: pick(ofType("account"), "record_name"),
    churn_date: churnDate,
    churn_days: churnDays,
    cs_owner: pick(customerDeals, "record_name") ? owners[0] ?? null : null,
  };
}

/**
 * Pure classifier — given a batch of input rows AND a pre-fetched per-row
 * map of matched clusters, produce the full preflight response. The wrapper
 * (`runPreflight`) is responsible for actually querying the DB and building
 * the per-row map; this function stays DB-free so unit tests can exercise
 * the verdict ladder without mocks.
 *
 * Back-compat: `clustersByDomain` still accepted as a fallback. New callers
 * should pass `matchByRow`.
 */
export function classifyPreflightRows(input: {
  rows: PreflightInputRow[];
  /** Per-row matches (preferred). Index = row index in `rows`. */
  matchByRow?: Map<number, PreflightRowMatch>;
  /** Legacy fallback when only domain matching was wired up. */
  clustersByDomain?: Map<string, PreflightClusterRow>;
  max_check?: number;
}): PreflightResponse {
  const cap = Math.max(1, Math.min(input.max_check ?? 5000, 10000));
  const rows = input.rows ?? [];
  const examineCount = Math.min(rows.length, cap);
  const skipped = Math.max(0, rows.length - cap);

  const summary: PreflightSummary = {
    block: 0,
    review: 0,
    warn: 0,
    duplicate: 0,
    no_contact: 0,
    pass: 0,
  };
  const out: PreflightResultRow[] = [];
  let arrBlocked = 0;

  for (let i = 0; i < examineCount; i++) {
    const row = rows[i]!;
    const ref = row.ref ?? null;
    const domain = resolveDomain(row);

    // Pull the row's matched cluster + how it matched. Prefer the new
    // per-row map; fall back to the legacy domain map when only that
    // was provided.
    let matched: PreflightRowMatch | null = null;
    if (input.matchByRow && input.matchByRow.has(i)) {
      matched = input.matchByRow.get(i)!;
    } else if (input.clustersByDomain && domain) {
      const c = input.clustersByDomain.get(domain);
      if (c) matched = { cluster: c, matched_via: "domain" };
    }

    // Sarah 2026-06-17 corporate-scope rule — a cluster whose
    // members are entirely marketplace / merchant (no corporate
    // record at all) is OUT OF SCOPE for the Duplicate Radar. Treat
    // it the same as no match: PASS with an explicit reason so the
    // operator can see WHY we let a domain-matched row through.
    const isOutOfScope =
      !!matched &&
      matched.cluster.has_corporate_records === false;

    if (!matched || isOutOfScope) {
      // Sarah 2026-06-17 safety shields — before letting a row PASS,
      // check whether it falls into one of two "verify-by-hand" buckets:
      //
      // (1) Free-mail email rows (gmail / hotmail / yahoo / etc.). Even
      //     if no CRM cluster matched, an @gmail.com row whose Company
      //     Name reads "STC" or "Al Rajhi Bank" almost certainly belongs
      //     to an existing customer — the lookup just failed because the
      //     company's records don't have THIS mobile number indexed.
      //     Pushes the verdict to REVIEW so the HoS / SDR pair check it
      //     by company / phone before importing.
      //
      // (2) Strategic Saudi domains (.gov.sa, .edu.sa). These are
      //     ministries, universities, sovereign-funded institutions —
      //     even if not in CRM yet, they're too strategic to silently
      //     auto-import. REVIEW + route through Head of Sales first.
      //
      // Out-of-scope (marketplace/merchant) still PASSes — those rules
      // aren't ours to enforce.
      const inputDomain = domain;
      const isFreeMail = !isOutOfScope && isFreeMailRow(row);
      const isStrategic = !isOutOfScope && isStrategicDomain(inputDomain);
      if (isFreeMail) {
        const co = (row.company_name || "").trim();
        const coPart = co ? ` Company on the row: "${co}".` : "";
        out.push({
          row_index: i,
          ref,
          input: { domain: inputDomain, company_name: row.company_name ?? null },
          verdict: "review",
          cluster_id: null,
          lifecycle_state: null,
          sector: null,
          arr_exposure: null,
          owners: [],
          reason: "free_mail_email_unverified",
          suggested_action:
            "Free-mail email (gmail/hotmail/yahoo/…). Cannot match by domain. Verify the company in CRM by name and phone before importing — likely belongs to an existing customer / lead.",
          executive_action:
            `REVIEW — free-mail email; cannot match by domain.${coPart} Check CRM by company name and phone before SDR contact (existing customer / active lead very likely).`,
          executive_severity: "medium",
          module_counts: null,
          matched_via: null,
        });
        summary.review++;
        continue;
      }
      if (isStrategic) {
        out.push({
          row_index: i,
          ref,
          input: { domain: inputDomain, company_name: row.company_name ?? null },
          verdict: "review",
          cluster_id: null,
          lifecycle_state: null,
          sector: null,
          arr_exposure: null,
          owners: [],
          reason: "strategic_account_no_match",
          suggested_action:
            "Strategic Saudi Government / Education entity (.gov.sa / .edu.sa). Route through Head of Sales before any SDR contact.",
          executive_action:
            "REVIEW — STRATEGIC Government / Education entity. No CRM cluster matched yet but these accounts are too strategic to auto-import. Route to Head of Sales for go/no-go before SDR contact.",
          executive_severity: "high",
          module_counts: null,
          matched_via: null,
        });
        summary.review++;
        continue;
      }
      out.push({
        row_index: i,
        ref,
        input: { domain, company_name: row.company_name ?? null },
        verdict: "pass",
        cluster_id: isOutOfScope ? matched!.cluster.id : null,
        lifecycle_state: null,
        sector: null,
        arr_exposure: null,
        owners: [],
        reason: isOutOfScope
          ? "out_of_scope_non_corporate"
          : (domain ? VERDICT_REASONS.pass : "no_domain_resolved"),
        suggested_action: isOutOfScope
          ? "Matched a non-corporate record (marketplace / merchant). Out of Duplicate Radar scope — safe to import."
          : SUGGESTED_ACTIONS.pass,
        executive_action: isOutOfScope
          ? "Out of scope — matched a non-corporate record (Marketplace / Merchant). Safe to import."
          : "Safe to import.",
        executive_severity: "info",
        module_counts: null,
        matched_via: null,
      });
      summary.pass++;
      continue;
    }
    const c = matched.cluster;

    // ── Sarah / Ahmad 2026-06-17 — unreliable non-domain match guard ──
    // The "wrong churn date" bug: a lead whose only identity is a free-mail
    // or missing domain (gmail / hotmail / #N/A) matched a CRM cluster ONLY
    // by phone (or fuzzy company name), then inherited that cluster's churn
    // date / CS verdict — data that belongs to whatever record the phone
    // happened to hit, not to this lead. Two unrelated companies both
    // matching one 1,300-contact catch-all cluster is the signature.
    // Such a match is NOT trustworthy enough to assert a confident
    // BLOCK / WARN / DUPLICATE. Downgrade to REVIEW (verify by hand) and do
    // NOT surface the matched cluster's churn date as if it were this lead's.
    const _num = (v: unknown): number => {
      const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
      return Number.isFinite(n) ? n : 0;
    };
    const _clusterSize =
      _num(c.total_leads) + _num(c.total_deals) +
      _num(c.total_contacts) + _num(c.total_accounts);
    // A non-domain match (phone / company-name) is unreliable when it lands
    // in a CATCH-ALL cluster (the signature of the wrong-churn-date rows:
    // two unrelated companies both matching one 1,300-contact cluster), or
    // when an UNVERIFIED lead (free-mail / missing domain) lands in a
    // non-trivial cluster. Tight, small-cluster phone matches are kept as-is.
    const CATCHALL_CLUSTER_SIZE = 75;
    const UNVERIFIED_NONTRIVIAL_SIZE = 20;
    const _rowHasRealDomain =
      !!domain && domain.includes(".") && !isFreeMailRow(row);
    // Domain and exact-email are STRONG signals (never downgraded). Phone and
    // company-name are weak — unreliable into a catch-all, or from an
    // unverified lead into a non-trivial cluster.
    const _strongSignal =
      matched.matched_via === "domain" || matched.matched_via === "email";
    const _unreliableMatch =
      !_strongSignal &&
      (_clusterSize > CATCHALL_CLUSTER_SIZE ||
        (!_rowHasRealDomain && _clusterSize > UNVERIFIED_NONTRIVIAL_SIZE));
    if (_unreliableMatch) {
      const co = (row.company_name || "").trim();
      const via =
        matched.matched_via === "phone" ? "phone number" : "company-name similarity";
      out.push({
        row_index: i,
        ref,
        input: { domain, company_name: row.company_name ?? null },
        verdict: "review",
        cluster_id: c.id,
        lifecycle_state: null,
        sector: null,
        arr_exposure: null,
        owners: [],
        reason: "weak_match_verify_by_hand",
        suggested_action:
          "Matched an existing CRM record by " +
          via +
          " into a large / ambiguous cluster (" +
          _clusterSize +
          " records). Likely a false grouping — verify the company by name and phone in CRM before importing. Any churn / CS history shown may belong to a DIFFERENT company.",
        executive_action:
          "REVIEW — weak match (" +
          via +
          " into a " +
          _clusterSize +
          "-record cluster" +
          (_rowHasRealDomain ? "" : ", no verified domain") +
          (co ? `; row company "${co}"` : "") +
          "). Likely a false match into an unrelated / catch-all record — verify by hand. Churn / CS data intentionally NOT shown (it may belong to a different company).",
        executive_severity: "medium",
        module_counts: null,
        matched_via: matched.matched_via,
      });
      summary.review++;
      continue;
    }

    let verdict: PreflightVerdict;
    if (c.cs_overlap_verdict === "block") verdict = "block";
    else if (c.cs_overlap_verdict === "review") verdict = "review";
    else if (c.cs_overlap_verdict === "warn") verdict = "warn";
    else verdict = "duplicate";

    const arr =
      c.arr_exposure == null
        ? null
        : typeof c.arr_exposure === "number"
          ? c.arr_exposure
          : Number.parseFloat(String(c.arr_exposure)) || 0;
    if (verdict === "block" && arr) arrBlocked += arr;

    // 2026-06-08 — surface per-module counts so the dashboard can show
    // "Leads(N) · Deals(N) · Contacts(N) · Accounts(N)" in a single
    // column. Counts come straight from duplicate_clusters via the
    // already-existing SELECT in runPreflight; we just pass them
    // through. Defensive parseInt for tenants where the columns store
    // numeric strings instead of integers (Postgres BIGINT path).
    const _n = (v: unknown): number => {
      if (v === null || v === undefined) return 0;
      const parsed = typeof v === "number" ? v : parseInt(String(v), 10);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    // Sarah 2026-06-17 — when corporate-only counts are available
    // use them (the briefing must only reflect in-scope records);
    // fall through to the cluster's total_* legacy fields when the
    // enrichment didn't populate corporate counts (cluster has no
    // record rows yet, etc.).
    const cAnyForCounts = c as any;
    const useCorporate = c.has_corporate_records === true;
    const leadsN    = useCorporate ? _n(cAnyForCounts.corporate_leads)    : _n(c.total_leads);
    const dealsN    = useCorporate ? _n(cAnyForCounts.corporate_deals)    : _n(c.total_deals);
    const contactsN = useCorporate ? _n(cAnyForCounts.corporate_contacts) : _n(c.total_contacts);
    const accountsN = useCorporate ? _n(cAnyForCounts.corporate_accounts) : _n(c.total_accounts);

    summary[verdict]++;
    // Reason — for non-domain matches, prefix so the operator knows
    // WHY this row hit a cluster (phone match vs company-name match
    // vs the obvious domain match).
    const matchedViaPrefix =
      matched.matched_via === "phone"
        ? "phone_match__"
        : matched.matched_via === "company_name"
          ? "company_fuzzy_match__"
          : matched.matched_via === "email"
            ? "email_match__"
            : "";
    const owners = extractOwners(c.owners_involved);
    const moduleCounts = {
      leads: leadsN,
      deals: dealsN,
      contacts: contactsN,
      accounts: accountsN,
      total: leadsN + dealsN + contactsN + accountsN,
    };
    const lifecycle =
      (c.pipeline_lifecycle_state as PreflightResultRow["lifecycle_state"]) ??
      null;
    const sectorVal = (c.client_sector as PreflightResultRow["sector"]) ?? null;
    const cAny = c as any;
    const execAction = buildExecutiveAction({
      verdict,
      lifecycle_state: lifecycle,
      module_counts: moduleCounts,
      owners,
      arr_exposure: arr,
      sector: sectorVal,
      has_active_deal: cAny.has_active_deal === true ? true
        : cAny.has_active_deal === false ? false
        : undefined,
      has_active_lead: cAny.has_active_lead === true ? true
        : cAny.has_active_lead === false ? false
        : undefined,
      churn_date: cAny.churn_date ?? null,
      churn_days: cAny.churn_days ?? null,
      cs_owner: cAny.cs_owner ?? null,
      account_name: (c.company_name || '').trim() || null,
    });
    out.push({
      row_index: i,
      ref,
      input: { domain, company_name: row.company_name ?? null },
      verdict,
      cluster_id: c.id,
      lifecycle_state: lifecycle,
      sector: sectorVal,
      arr_exposure: arr,
      owners,
      reason: matchedViaPrefix + VERDICT_REASONS[verdict],
      suggested_action: SUGGESTED_ACTIONS[verdict],
      module_counts: moduleCounts,
      matched_via: matched.matched_via,
      executive_action: execAction.text,
      executive_severity: execAction.severity,
      churn_date: cAny.churn_date ?? null,
      churn_days: cAny.churn_days ?? null,
      cs_owner: cAny.cs_owner ?? null,
      crm_links: _buildCrmLinks(cAny),
    });
  }

  // Email-ready top reasons — group every non-pass row by a stable,
  // business-language label so the cover sheet / email body can drop in
  // "12 leads matched existing customers (do not pursue)" without the
  // caller doing string work.
  const reasonBuckets = new Map<string, number>();
  for (const r of out) {
    if (r.verdict === "pass") continue;
    let label: string;
    if (r.verdict === "block") {
      label = "Existing active customer — do not pursue";
    } else if (r.verdict === "review") {
      label = "Recent CS termination — within cool-off window";
    } else if (r.verdict === "warn") {
      label = "Past CS cool-off — Sales may re-engage with CS sign-off";
    } else if (r.verdict === "duplicate") {
      // Key off the per-row executive_action text so the summary bucket
      // matches exactly what the row says — active LEAD rejects and active
      // DEAL warnings are distinct motions and must not collapse into one
      // "active deal" label (they did before, mislabeling lead rejects).
      const ea = (r.executive_action || "").toUpperCase();
      if (ea.startsWith("REJECT — ACTIVE LEAD") || ea.includes("ACTIVE LEAD ALREADY IN PIPELINE")) {
        label = "Active lead already in pipeline — SDR working it, do NOT re-import";
      } else if (ea.includes("ACTIVE SALES DEAL")) {
        label = "Active deal already in pipeline — assign to existing owner";
      } else if (ea.includes("PRIOR LOST OPPORTUNITY")) {
        label = "Prior lost opportunity — Sales may re-engage; link to existing Account";
      } else {
        label = "Existing company in CRM — coordinate with current owner";
      }
    } else {
      label = "Other";
    }
    reasonBuckets.set(label, (reasonBuckets.get(label) ?? 0) + 1);
  }
  const topReasons: PreflightTopReason[] = Array.from(reasonBuckets.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([label, count]) => ({
      label,
      count,
      pct: examineCount > 0 ? Math.round((count / examineCount) * 1000) / 10 : 0,
    }));

  const actionable =
    summary.block + summary.review + summary.warn + summary.duplicate;
  const pctActionable =
    examineCount > 0 ? Math.round((actionable / examineCount) * 1000) / 10 : 0;

  return {
    total_rows: rows.length,
    examined: examineCount,
    skipped,
    summary,
    total_arr_exposure_blocked: arrBlocked,
    rows: out,
    top_reasons: topReasons,
    generated_at: new Date().toISOString(),
    pct_actionable: pctActionable,
  };
}

/**
 * Run the preflight against a batch of input rows. Performs a single SQL
 * lookup against `duplicate_clusters` for the resolved domains, then runs
 * the pure `classifyPreflightRows` to produce verdicts.
 *
 * @param input.rows      Up to `input.max_check` rows (defaults 5000).
 * @param input.max_check Hard cap on examined rows; extras reported as `skipped`.
 */
/**
 * R5 — Decision policy for the inbound preflight webhook.
 *
 * Verdict → `should_create` mapping used by external integrations
 * (Zoho workflows, web forms, marketing tools) that want a simple
 * yes/no answer for "should I create this record in CRM?":
 *
 *   BLOCK     → false  (domain is an active Customer Success customer)
 *   REVIEW    → false  (within sector cool-off — CS must confirm first)
 *   WARN      → true   (past cool-off; sales may re-engage)
 *   DUPLICATE → true   (existing records but no active CS overlap)
 *   PASS      → true   (genuinely new)
 *
 * Conservative default for any unrecognised verdict: false. The webhook
 * caller can always override based on its own policy (e.g. a marketing
 * tool may want to log REVIEW and DUPLICATE alongside; that's its choice).
 */
export function shouldCreateForVerdict(
  verdict: PreflightVerdict | string | null | undefined,
): boolean {
  return verdict === "warn" || verdict === "duplicate" || verdict === "pass";
}

/** SELECT list reused by every cluster lookup so the result rows are shape-stable. */
const CLUSTER_SELECT_COLS = `id, domain,
              company_name,
              cs_overlap_verdict,
              pipeline_lifecycle_state,
              client_sector,
              arr_exposure,
              owners_involved,
              total_leads, total_deals, total_contacts, total_accounts`;

/**
 * Per-query statement timeout (ms). Each preflight DB call runs inside a
 * dedicated pooled connection with this timeout set — if any one path
 * hangs (missing index, stale stats, table lock), it errors out fast and
 * the next path still runs. Total request stays well inside the Replit
 * ~60s gateway window even in the worst case.
 *
 * 12s is generous for the indexed PATH 1/2 calls (sub-second on healthy
 * indexes) and enough for PATH 3 fuzzy lookups on a few hundred names.
 * The frontend additionally chunks 1.6k-row batches into 250-row pieces
 * (concurrency 4) so even pathological data can't reach this cap.
 */
const PREFLIGHT_QUERY_TIMEOUT_MS = 12000;
/**
 * The CS-client directory build scans the full Deal corpus (~30k rows, each a
 * ~150-field raw_data JSONB). Warm it runs in <2s, but on a COLD buffer cache
 * the first scan can exceed the 12s per-query cap — which silently returned
 * null and COLLAPSED the directory to empty (every real client then leaked
 * into PASS). The build is cached 60s and off the per-row hot path, so it gets
 * a much larger ceiling. Override with PREFLIGHT_DIR_TIMEOUT_MS.
 */
const PREFLIGHT_DIR_TIMEOUT_MS = Number.parseInt(
  process.env.PREFLIGHT_DIR_TIMEOUT_MS ?? "60000",
  10,
);

/**
 * Run a single SQL on a dedicated client with `SET LOCAL statement_timeout`
 * so a slow query can't drag the whole preflight under the gateway window.
 * Returns `null` rows on timeout instead of throwing — the caller falls
 * back gracefully (PATH 3 has its per-row fallback; PATHs 1/2 just won't
 * find a match for that batch).
 */
async function queryWithTimeout<T = any>(
  sql: string,
  params: any[],
  setup?: string[],
  timeoutMs?: number,
): Promise<{ rows: T[] } | null> {
  const client = await (pool as any).connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SET LOCAL statement_timeout = ${Math.max(1000, timeoutMs ?? PREFLIGHT_QUERY_TIMEOUT_MS)}`,
    );
    if (Array.isArray(setup)) {
      for (const s of setup) await client.query(s);
    }
    const r = (await client.query(sql, params)) as { rows: T[] };
    await client.query("COMMIT");
    return r;
  } catch {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    return null;
  } finally {
    client.release();
  }
}

/**
 * Pure verdict for BASIC mode — the two foundational rules, in order.
 * RULE 1 (contact duplicate) takes precedence over RULE 2 (existing
 * customer). Kept pure + exported so the unit tests can pin the wording.
 */
export function basicPreflightVerdict(input: {
  /** Set when the row's email/phone hit an existing CRM record. */
  contactVia: "email" | "phone" | null;
  /** True iff the row's domain has a signed/paid deal with no churn date. */
  isCustomerDomain: boolean;
}): {
  verdict: PreflightVerdict;
  reason: string;
  suggested_action: string;
  executive_action: string;
  executive_severity: PreflightResultRow["executive_severity"];
} {
  if (input.contactVia) {
    const via = input.contactVia === "email" ? "email address" : "phone number";
    return {
      verdict: "duplicate",
      reason: "contact_duplicate_" + input.contactVia,
      suggested_action:
        "This contact's " +
        via +
        " already exists on a CRM record. Do not import — it is a duplicate.",
      executive_action:
        "REJECT — duplicate contact: this " +
        via +
        " is already in the CRM. Do not re-import.",
      executive_severity: "high",
    };
  }
  if (input.isCustomerDomain) {
    return {
      verdict: "block",
      reason: "existing_customer_signed_or_paid",
      suggested_action:
        "This company's domain already has a deal in Agreement Signed / Paid with no churn date — it is an existing customer. Do not import; route to Customer Success.",
      executive_action:
        "REJECT — existing customer: this company already has a signed / paid deal (no churn). Do not re-import; coordinate with CS.",
      executive_severity: "critical",
    };
  }
  return {
    verdict: "pass",
    reason: "safe_to_import",
    suggested_action:
      "No duplicate contact (email / phone) and not an existing customer — safe to import.",
    executive_action: "Safe to import.",
    executive_severity: "info",
  };
}

/**
 * RULE 2 (v2) — existing-client verdict (Ahmad 2026-06-22).
 *
 * Runs ONLY when Rule 1 (email/phone) found no contact duplicate. Given the
 * `cs_overlap_verdict` that `buildClusterFromRecords` derived for the company
 * the inbound row matched (by domain → strict company name → fuzzy company
 * name), decide whether the contact may be imported:
 *
 *   cs = "block"  (active client — customer-stage deal, no churn)
 *        · matched by domain / strict name → BLOCK  (existing client, do not
 *          cold-contact; route to the Account / CS owner)
 *        · matched by FUZZY name only      → REVIEW (possible existing client —
 *          name resemblance only, verify identity before any outreach)
 *   cs = "review" (churned, still inside the sector cool-off — 180d Private /
 *                  365d Government) → REVIEW (CS sign-off before re-engaging)
 *   cs = "warn"   (churned, cool-off elapsed) → PASS (Sales may re-engage)
 *   cs = null     (not a client)             → PASS
 *
 * The cool-off window and sector come from the matched company's records, so
 * Government clients get the longer 365-day hold automatically.
 */
export function csClientPreflightVerdict(input: {
  cs: "block" | "review" | "warn" | null;
  matchVia: "domain" | "strict_name" | "fuzzy_name";
  churnDays: number | null;
  coolOff: number;
  sector: "private" | "government" | null;
  csOwner: string | null;
  companyName: string | null;
}): {
  verdict: PreflightVerdict;
  reason: string;
  suggested_action: string;
  executive_action: string;
  executive_severity: PreflightResultRow["executive_severity"];
  lifecycle_state: PreflightResultRow["lifecycle_state"];
} {
  const co = input.companyName ? '"' + input.companyName + '"' : "this company";
  const sectorLabel = input.sector === "government" ? "Government" : "Private";
  const ownerSuffix = input.csOwner ? " Current Account / CS owner: " + input.csOwner + "." : "";
  const matchLabel =
    input.matchVia === "domain"
      ? "email domain"
      : input.matchVia === "strict_name"
        ? "company name"
        : "a close company-name match";

  // Active client (customer-stage deal, no churn date).
  if (input.cs === "block") {
    if (input.matchVia === "fuzzy_name") {
      // Name resemblance only — soften to REVIEW so a human verifies identity
      // before we treat a new contact as an existing client.
      return {
        verdict: "review",
        reason: "possible_existing_client_fuzzy_name",
        suggested_action:
          co +
          " closely matches an EXISTING active client by company name (no domain / exact-name match). Verify it is the same company; if so do NOT cold-contact — route to the Account / CS owner.",
        executive_action:
          "VERIFY — possible existing client (name match only): " +
          co +
          " resembles a current client. Confirm identity before any outreach; if confirmed, hand to the Account / CS owner." +
          ownerSuffix,
        executive_severity: "high",
        lifecycle_state: null,
      };
    }
    return {
      verdict: "block",
      reason: "existing_active_client",
      suggested_action:
        co +
        " is an EXISTING active client (matched by " +
        matchLabel +
        "). Do NOT cold-contact or re-import — route to the Account / CS owner.",
      executive_action:
        "REJECT — existing client: " +
        co +
        " is a current client (matched by " +
        matchLabel +
        "). Do not cold-contact; route to the Account / CS owner." +
        ownerSuffix,
      executive_severity: "critical",
      lifecycle_state: null,
    };
  }

  // Churned, still inside the sector cool-off window.
  if (input.cs === "review") {
    const days = input.churnDays != null ? input.churnDays + "d ago" : "recently";
    return {
      verdict: "review",
      reason: "recently_churned_within_cooloff",
      suggested_action:
        co +
        " is a RECENTLY churned client (terminated " +
        days +
        "; the " +
        sectorLabel +
        " cool-off of " +
        input.coolOff +
        " days has not elapsed). CS sign-off is required before re-engaging — do NOT cold-contact yet.",
      executive_action:
        "HOLD — recently churned: " +
        co +
        " terminated " +
        days +
        " (within the " +
        input.coolOff +
        "-day " +
        sectorLabel +
        " cool-off). Get CS sign-off before any outreach." +
        ownerSuffix,
      executive_severity: "high",
      lifecycle_state: "termination_recent",
    };
  }

  // cs === "warn" (past cool-off) or null (not a client) → safe to import.
  if (input.cs === "warn") {
    return {
      verdict: "pass",
      reason: "past_cooloff_may_reengage",
      suggested_action:
        co +
        " is a PAST client whose " +
        sectorLabel +
        " cool-off has elapsed — Sales may re-engage. Safe to import (coordinate with the Account owner as a courtesy).",
      executive_action:
        "Safe to import — past client, " +
        sectorLabel +
        " cool-off elapsed; Sales may re-engage." +
        ownerSuffix,
      executive_severity: "info",
      lifecycle_state: "termination_old",
    };
  }
  return {
    verdict: "pass",
    reason: "safe_to_import",
    suggested_action:
      "No duplicate contact (email / phone) and not an existing client — safe to import.",
    executive_action: "Safe to import.",
    executive_severity: "info",
    lifecycle_state: null,
  };
}

/** Map a raw Zoho Phase value onto the CS lifecycle vocabulary. */
function _csPhaseToActiveState(
  phase: string | null | undefined,
): "onboarding" | "adoption" | "renewal" | null {
  const p = (phase || "").toLowerCase();
  if (!p) return null;
  // Order matters: "renewal" CONTAINS "new", so match renew first, and match
  // "new deal" as the exact phrase (not the bare substring "new").
  if (p.includes("renew")) return "renewal";
  if (p.includes("adopt")) return "adoption";
  if (p.includes("onboard") || p.includes("new deal")) return "onboarding";
  return null;
}

/**
 * RULE 2 v2 — resolve the precise CS lifecycle phase for the matched client so
 * the export's "CS Phase" column reads the real phase, and termination rows
 * carry the churn date. A churn date wins (the deal has terminated regardless
 * of a stale Phase field); otherwise we read the actual Phase field off the
 * company's customer-stage deals.
 */
function deriveCsLifecycleState(
  records: PreflightRecordRow[],
  churnDate: string | null,
  churnDays: number | null,
  coolOff: number,
): PreflightResultRow["lifecycle_state"] {
  if (churnDate) {
    return churnDays != null && churnDays <= coolOff
      ? "termination_recent"
      : "termination_old";
  }
  const customerDeals = records.filter(
    (r) =>
      (r.record_type || "").toLowerCase() === "deal" &&
      PF_CUSTOMER_STAGES.has((r.stage || "").toLowerCase().trim()),
  );
  for (const d of customerDeals) {
    const st = _csPhaseToActiveState((d as any).cs_phase);
    if (st) return st;
  }
  return null;
}

// ── RULE 2 v3 — CS-CLIENT DIRECTORY (Ahmad 2026-06-23) ───────────────────────
// The cluster-based matcher (v2) only found clients that happened to have a
// DUPLICATE cluster — clean, non-duplicated clients (SATORP, Aramco, Mozn,
// SAMREF, Diriyah, SIDF…) have no cluster, so they slipped through to PASS and
// the sales team would have cold-called live customers. v3 builds a directory
// of EVERY CS-tracked / customer deal straight from duplicate_records (the
// source of truth for "who is a client"), keyed by normalized company name AND
// domain, and matches the inbound company against it by domain → exact name →
// name-containment → fuzzy. It is independent of clustering, so it catches
// every client regardless of whether their records were duplicated.

/** The CS standing of one client company, for the verdict + export columns. */
interface CsClientStatus {
  active: boolean; // current client (block) vs churned
  churnDate: string | null;
  churnDays: number | null;
  sector: "private" | "government" | null;
  csOwner: string | null;
  companyName: string | null;
  phase: string | null;
  lifecycleState: PreflightResultRow["lifecycle_state"];
}

interface CsClientDirectory {
  byName: Map<string, CsClientStatus>;
  byDomain: Map<string, CsClientStatus>;
  /** token → set of client normalized-names that contain it (for containment). */
  tokenIndex: Map<string, Set<string>>;
  builtAt: number;
}

// Generic tokens that don't make a company name distinctive — never used alone
// to gather containment candidates (full-token-subset is still verified after).
// A NAME match must rest on a DISTINCTIVE (brand) token, never a shared industry
// / sector / legal word. Two companies that merely share "Pharmaceuticals",
// "Energy", "Construction", "Motors" or "Holding" are NOT the same client
// (Sarah 2026-06-24: SAJA≠Hekma, Kasab≠Tarsheed, Rawabi Offshore≠Rawabi Holding,
// Alesayi Motors≠Yanbu Cement, "Confidential …" is no company at all).
const CS_DIR_STOP = new Set([
  // ── geography / legal form / connectors
  "saudi", "arabia", "arabian", "ksa", "uae", "emirates", "qatar", "kuwait",
  "bahrain", "oman", "egypt", "gulf", "middle", "east", "mena", "global",
  "world", "worldwide", "company", "co", "ltd", "inc", "corp", "corporation",
  "group", "holding", "holdings", "est", "establishment", "enterprise",
  "enterprises", "for", "and", "the", "of", "al", "general", "national",
  "international", "intl", "united", "sa",
  // ── sector / industry words (EN) — generic, never identity-bearing alone
  "services", "service", "trading", "trade", "development", "developments",
  "pharmaceuticals", "pharmaceutical", "pharma", "energy", "power", "utilities",
  // NB: "motors" / "cement" / "automotive" are deliberately NOT stop words —
  // they're distinctive parts of real names ("Lucid Motors", "Yanbu Cement").
  // Stopping them collapsed "Alesayi Motors" → bare "alesayi", which then
  // collided with an unrelated single-token client entry (Sarah 2026-06-24).
  "construction", "constructions",
  "contracting", "contractors", "contractor", "industrial", "industries",
  "industry", "factory", "factories", "manufacturing", "technologies",
  "technology", "tech", "systems", "system", "solutions", "solution",
  "consulting", "consultancy", "insurance", "logistics", "transport",
  "transportation", "food", "foods", "catering", "agriculture", "agricultural",
  "estate", "properties", "property", "projects", "project", "university",
  "college", "school", "schools", "academy", "institute", "education",
  "educational", "hospital", "hospitals", "medical", "clinic", "clinics",
  "pharmacy", "healthcare", "health", "financial", "finance", "investment",
  "investments", "capital", "offshore", "marine", "oil", "gas", "petroleum",
  "petrochemical", "chemicals", "chemical", "steel", "metals", "plastics",
  "electric", "electrical", "electronics", "telecom", "telecommunications",
  "communications", "communication", "digital", "media", "advertising",
  "marketing", "retail", "commercial", "engineering", "consultants",
  "confidential", "centre", "center",
  // ── sector words (AR) that survive normalizeCompanyName's boilerplate strip
  "الدوائية", "الدوائيه", "للأدوية", "الادوية", "الأدوية", "الطاقة", "للطاقة",
  "السيارات", "للسيارات", "الاسمنت", "الإسمنت", "للأسمنت", "الإنشاءات",
  "للإنشاءات", "الانشاءات", "الصناعية", "الصناعات", "للصناعة", "الصناعة",
  "التقنية", "للتقنية", "العقارية", "للعقارات", "العقاري", "الطبية", "الطبي",
  "للتأمين", "التأمين", "النفط", "للنفط", "الكيميائية", "الرقمية", "الوطنية",
  "العالمية", "كفاءة", "خدمات", "للخدمات", "الخدمات", "التعليمية", "للتعليم",
]);

const _csTokens = (norm: string): string[] =>
  norm.split(/\s+/).map((t) => t.trim()).filter((t) => t.length >= 2);

// A token is DISTINCTIVE (brand-bearing) when it's not a generic stop word and
// long enough to carry identity. Arabic tokens count at length ≥ 2 (Arabic
// words pack more meaning per character); Latin tokens at length ≥ 3.
const _isDistinctiveTok = (t: string): boolean => {
  if (CS_DIR_STOP.has(t)) return false;
  const isArabic = /[؀-ۿ]/.test(t);
  return t.length >= (isArabic ? 2 : 3);
};

const _csDistinctiveTokens = (norm: string): string[] =>
  _csTokens(norm).filter(_isDistinctiveTok);

/** Derive a client's CS standing from a deal's phase + churn date. */
function _csStatusFromDeal(input: {
  phase: string | null;
  churnDate: string | null;
  govType: string | null;
  owner: string | null;
  companyName: string | null;
  todayMs: number;
}): CsClientStatus {
  const isGov = (input.govType || "").trim() !== "";
  const coolOff = isGov ? 365 : 180;
  const p = (input.phase || "").toLowerCase();
  const churned = !!input.churnDate || p.includes("terminat") || p.includes("churn");
  let churnDays: number | null = null;
  if (input.churnDate) {
    const t = Date.parse(input.churnDate);
    if (Number.isFinite(t)) churnDays = Math.max(0, Math.floor((input.todayMs - t) / 86400000));
  }
  let lifecycleState: PreflightResultRow["lifecycle_state"] = null;
  if (churned) {
    lifecycleState = churnDays != null && churnDays <= coolOff ? "termination_recent" : "termination_old";
  } else {
    lifecycleState = _csPhaseToActiveState(input.phase);
  }
  return {
    active: !churned,
    churnDate: input.churnDate || null,
    churnDays,
    sector: isGov ? "government" : "private",
    csOwner: (input.owner || "").trim() || null,
    companyName: (input.companyName || "").trim() || null,
    phase: (input.phase || "").trim() || null,
    lifecycleState,
  };
}

/** Merge a newly-seen client status for a company — ACTIVE always wins; among
 *  churned keep the most recent (smallest churnDays). */
function _csMergeStatus(prev: CsClientStatus | undefined, next: CsClientStatus): CsClientStatus {
  if (!prev) return next;
  if (prev.active && !next.active) return prev;
  if (!prev.active && next.active) return next;
  if (!prev.active && !next.active) {
    const a = prev.churnDays ?? Number.MAX_SAFE_INTEGER;
    const b = next.churnDays ?? Number.MAX_SAFE_INTEGER;
    return b < a ? next : prev;
  }
  // both active — keep whichever has more info (owner/phase)
  return prev.csOwner || prev.phase ? prev : next;
}

let _csDirCache: CsClientDirectory | null = null;
const CS_DIR_TTL_MS = 60_000;

/**
 * Drop the cached CS-client directory so the very next preflight rebuilds it
 * from fresh duplicate_records. Called after a targeted CRM re-sync (the
 * per-row "↻ Re-check from CRM" button / resyncCorrectedDeals script) so a
 * company the operator just corrected in Zoho stops blocking immediately
 * instead of waiting out the 60s TTL.
 */
export function invalidateCsDirectoryCache(): void {
  _csDirCache = null;
}

/**
 * Split a raw company name into the variants worth indexing separately. Saudi
 * CRM names are routinely BILINGUAL — "Abdul Latif Jameel United Finance | عبد
 * اللطيف جميل للتمويل" — so the normalized blob holds BOTH languages and an
 * inbound that carries only the English (or only the Arabic) never matches.
 * Split on the bilingual separators (| / \ – —) and pull parenthetical
 * abbreviations out ("Saudi Kuwaiti Finance House (SKFH)" → the long name + the
 * short code), then index each part on its own. Returns the whole name too.
 */
function _nameSegments(raw: string): string[] {
  const whole = (raw || "").replace(/\s+/g, " ").trim();
  if (!whole) return [];
  const out = new Set<string>([whole]);
  for (const part of whole.split(/[|/\\–—]/)) {
    const p = part.trim();
    if (p.length >= 3) out.add(p);
  }
  // Parenthetical abbreviation/alias: keep BOTH the inside and the outside.
  const parens = whole.match(/\(([^)]+)\)/g);
  if (parens) {
    for (const m of parens) {
      const inner = m.replace(/[()]/g, "").trim();
      if (inner.length >= 2) out.add(inner);
    }
    const outside = whole.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
    if (outside.length >= 3) out.add(outside);
  }
  return Array.from(out);
}

/**
 * Build (and briefly cache) the CS-client directory from ALL CS-tracked /
 * customer-stage deals + accounts in duplicate_records. Cached for 60s so the
 * frontend's chunked 250-row batches of one upload share a single build.
 */
async function getCsClientDirectory(todayMs: number): Promise<CsClientDirectory> {
  if (_csDirCache && todayMs - _csDirCache.builtAt < CS_DIR_TTL_MS) return _csDirCache;

  const byName = new Map<string, CsClientStatus>();
  const byDomain = new Map<string, CsClientStatus>();
  const tokenIndex = new Map<string, Set<string>>();
  const addToken = (tok: string, name: string) => {
    let s = tokenIndex.get(tok);
    if (!s) tokenIndex.set(tok, (s = new Set()));
    s.add(name);
  };
  const indexName = (norm: string) => {
    for (const t of _csTokens(norm)) if (!CS_DIR_STOP.has(t)) addToken(t, norm);
  };
  // Register a client under a normalized name and/or domain. A name with NO
  // distinctive token (e.g. a deal anonymized as "Confidential") must never
  // become a byName/token key — otherwise an inbound that shares only that
  // generic word resolves to it. Its DOMAIN is still indexed (reliable signal).
  const addClient = (norm: string, dom: string | null, status: CsClientStatus) => {
    if (norm && norm.length >= 3 && _csDistinctiveTokens(norm).length > 0) {
      byName.set(norm, _csMergeStatus(byName.get(norm), status));
      indexName(norm);
    }
    const d = (dom || "").toString().trim().toLowerCase();
    if (d) byDomain.set(d, _csMergeStatus(byDomain.get(d), status));
  };

  // Accounts indexed by Zoho id (+ kept for name-based linkage). A CS deal can
  // then inherit its Account's DOMAIN and (often English) NAME even when the
  // deal itself carries an Arabic-only company name and no Company_Domain — the
  // exact Riyad Bank / Bank Albilad case the CS Lifecycle tab warns about.
  const accountById = new Map<string, { domain: string | null; norm: string | null }>();
  const acctRows =
    (
      await queryWithTimeout<any>(
        `SELECT zoho_record_id, LOWER(domain) AS domain, record_name, company_name
           FROM duplicate_records
          WHERE record_type = 'account'
          LIMIT 200000`,
        [],
        undefined,
        PREFLIGHT_DIR_TIMEOUT_MS,
      )
    )?.rows ?? [];
  for (const a of acctRows) {
    const zid = (a.zoho_record_id || "").toString().trim();
    if (!zid) continue;
    const norm = normalizeCompanyName(a.record_name || a.company_name || "");
    const dom = (a.domain || "").toString().trim().toLowerCase() || null;
    accountById.set(zid, { domain: dom, norm: norm || null });
  }

  // 1) Every CLIENT deal — a deal with a CS phase OR a customer Stage. Extract
  //    everything in SQL (FAST — filtered set, no full raw_data per row, which
  //    timed out and collapsed the directory). The phase / company-domain
  //    COALESCE includes the env-override field name(s) so a custom Zoho API
  //    name (e.g. the one the CS Lifecycle resolves for Riyad Bank) is caught.
  const customerStages = new Set(Array.from(PF_CUSTOMER_STAGES));
  const _ident = (s: string) => (/^[A-Za-z0-9_ ]+$/.test(s) ? s.trim() : null);
  const _envFields = (envVar: string, defaults: string[]) =>
    Array.from(
      new Set(
        [...defaults, ...((process.env[envVar] || "").split(","))]
          .map((s) => _ident(s))
          .filter((s): s is string => !!s),
      ),
    );
  const phaseCoalesce = _envFields("DUPLICATE_RADAR_FIELD_PHASE", [
    "Phase",
    "CS_Phase",
    "Customer_Phase",
  ])
    .map((f) => `NULLIF(raw_data->>'${f}','')`)
    .join(", ");
  const domainCoalesce = _envFields("DUPLICATE_RADAR_FIELD_COMPANY_DOMAIN", [
    "Company_Domain",
  ])
    .map((f) => `NULLIF(raw_data->>'${f}','')`)
    .join(", ");
  const churnCoalesce = _envFields("DUPLICATE_RADAR_FIELD_CHURN_DATE", [
    "Churn_Date",
    "ChurnDate",
  ])
    .map((f) => `NULLIF(raw_data->>'${f}','')`)
    .join(", ");
  // CS OWNER — the "CS Owner Name" field in the Deal's Customer Success section,
  // NOT the deal owner (Sarah 2026-06-24). It's a user-lookup, so it can be an
  // object {name,id} OR a plain string; try both per candidate key. Mirrors the
  // CS Lifecycle extractor's key list so preflight and the CS tab agree.
  const csOwnerCoalesce = _envFields("DUPLICATE_RADAR_FIELD_CS_OWNER", [
    "CS_Owner_Name",
    "cs_owner_name",
    "CS Owner Name",
    "CS_Owner1",
    "CS_Owner",
  ])
    .flatMap((f) => [
      `NULLIF(raw_data->'${f}'->>'name','')`,
      `NULLIF(raw_data->>'${f}','')`,
    ])
    .join(", ");
  // NON-CORPORATE layouts whose deals must NOT make a company a CS client —
  // WalaPlus Sales MAY contact merchant / app accounts (Sarah 2026-06-24).
  // Comparison is space/punctuation-insensitive (lowercased, non-alphanumerics
  // stripped) so "Wala One" / "WalaOne" / "wala-one" all match — but "WalaPlus"
  // (the corporate layout) never does. Extend with DUPLICATE_RADAR_CS_EXCLUDE_LAYOUTS.
  const _normLayout = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const csExcludeLayouts = Array.from(
    new Set(
      [
        "Marketplace",
        "Doam Marketplace",
        "Partner Accounts",
        "WalaOne",
        ...((process.env.DUPLICATE_RADAR_CS_EXCLUDE_LAYOUTS || "").split(",")),
      ]
        .map((s) => _normLayout(s.trim()))
        .filter(Boolean),
    ),
  );
  const csExcludeSql = csExcludeLayouts
    .map((s) => `'${s.replace(/'/g, "''")}'`)
    .join(", ");
  const layoutNormExpr =
    "LOWER(REGEXP_REPLACE(COALESCE(layout_name, raw_data->'Layout'->>'name', ''), '[^a-zA-Z0-9]', '', 'g'))";
  // Use the dedicated, indexed `stage` COLUMN for the stage filter (the giant
  // raw_data JSONB only needs parsing for the phase/domain/churn fields, and
  // only for the matched rows). ~2.3x faster than parsing raw_data->>'Stage'
  // across all 30k rows. Falls back to raw_data->>'Stage' when the column is
  // blank so legacy rows synced before the column was populated still match.
  const dealsQ = await queryWithTimeout<any>(
    `SELECT account_name, company_name, LOWER(domain) AS domain, gov_type, owner_name,
            COALESCE(${phaseCoalesce}) AS phase,
            LOWER(COALESCE(${domainCoalesce})) AS cs_domain,
            COALESCE(${churnCoalesce}) AS churn_date,
            COALESCE(${csOwnerCoalesce}) AS cs_owner,
            raw_data->'Account_Name'->>'id' AS account_id,
            LOWER(COALESCE(NULLIF(stage,''), raw_data->>'Stage','')) AS stage
       FROM duplicate_records
      WHERE record_type = 'deal'
        -- SCOPE (Sarah 2026-06-24): Marketplace / WalaOne / merchant deals are NOT
        -- corporate clients — WalaPlus Sales MAY contact them. Exclude those
        -- layouts here (e.g. "ATOM", "ToYou", "Chalhoub", "Tree" must NOT block).
        -- Space/punctuation-insensitive so name variants are caught; "WalaPlus"
        -- (corporate) is kept. A company that ALSO has a corporate deal still
        -- blocks via that corporate deal.
        AND ${layoutNormExpr} NOT LIKE '%marketplace%'
        AND ${layoutNormExpr} NOT IN (${csExcludeSql})
        AND (
          COALESCE(${phaseCoalesce}) IS NOT NULL
          OR LOWER(COALESCE(NULLIF(stage,''), raw_data->>'Stage','')) = ANY($1::text[])
        )
      LIMIT 200000`,
    [Array.from(PF_CUSTOMER_STAGES)],
    undefined,
    PREFLIGHT_DIR_TIMEOUT_MS,
  );
  for (const d of (dealsQ?.rows ?? [])) {
    const phase = (d.phase || "").toString().trim();
    const isClient = phase !== "" || customerStages.has((d.stage || "").trim());
    if (!isClient) continue;
    const status = _csStatusFromDeal({
      phase: phase || null,
      churnDate: (d.churn_date || "").toString().trim() || null,
      govType: (d.gov_type || "").toString().trim() || null,
      // Prefer the CS Owner Name; fall back to the deal owner only if it's blank.
      owner:
        (d.cs_owner || "").toString().trim() ||
        (d.owner_name || "").toString().trim() ||
        null,
      companyName: (d.account_name || d.company_name || "").toString().trim(),
      todayMs,
    });
    // Index by the deal's company-name variants (Account_Name, Deal company),
    // splitting bilingual "English | Arabic" names so each language matches.
    for (const raw of [d.account_name, d.company_name]) {
      const rawName = (raw || "").toString().trim();
      if (!rawName || isPlaceholderName(rawName)) continue;
      for (const seg of _nameSegments(rawName)) {
        if (!isPlaceholderName(seg)) addClient(normalizeCompanyName(seg), null, status);
      }
    }
    // Index by domain — the Deal's own domain + the CS Company_Domain field.
    for (const dm of [d.domain, d.cs_domain]) addClient("", dm, status);
    // Inherit the linked ACCOUNT's domain + (English) name by Zoho id — closes
    // the gap when the deal has an Arabic-only name and no Company_Domain but
    // its Account has riyadbank.com / "Riyad Bank".
    const acctId = (d.account_id || "").toString().trim();
    if (acctId && accountById.has(acctId)) {
      const acc = accountById.get(acctId)!;
      addClient(acc.norm || "", acc.domain, status);
    }
  }

  // Account cross-linking, BOTH directions (covers accounts not referenced by a
  // deal's Account_Name id):
  //   (1) name → domain: an account whose NAME is a known client adds its domain.
  for (const a of acctRows) {
    const dom = (a.domain || "").toString().trim().toLowerCase();
    if (!dom || byDomain.has(dom)) continue;
    const norm = normalizeCompanyName(a.record_name || a.company_name || "");
    const status = norm ? byName.get(norm) : undefined;
    if (status) byDomain.set(dom, status);
  }
  //   (2) domain → name: an account sitting on a KNOWN-CLIENT domain IS that
  //   client, even under a different name variant (e.g. the English "Riyad Bank"
  //   account on riyadbank.com when the active CS deal carries the Arabic name
  //   بنك الرياض). Without this, an inbound English company name leaked to PASS
  //   while the Arabic one blocked. Runs after (1) so byDomain is fully built.
  for (const a of acctRows) {
    const dom = (a.domain || "").toString().trim().toLowerCase();
    if (!dom || !byDomain.has(dom)) continue;
    const status = byDomain.get(dom)!;
    for (const seg of _nameSegments(a.record_name || a.company_name || "")) {
      const norm = normalizeCompanyName(seg);
      if (norm && norm.length >= 3 && !byName.has(norm)) {
        byName.set(norm, status);
        indexName(norm);
      }
    }
  }

  // (3) Durable name indexing (Sarah 2026-06-24): a client is often known only by
  // DOMAIN (its deal carries the domain) but NOT by name, so an inbound contact on
  // a personal email — no domain — leaks (the Mawsool "Aramco on a Gmail" case).
  // Pull the COMPANY NAME from EVERY CRM record (contact / lead / account / deal)
  // sitting on a KNOWN-CLIENT domain and index it → byName, so the client resolves
  // by name even with no inbound domain. Uses company_name / account_name only —
  // NOT record_name, which on a contact/lead is the PERSON, not the company.
  // Bounded by the client-domain set (a few hundred), filtered to that set in SQL,
  // so it's a cheap indexed lookup; freemail domains are excluded defensively.
  const clientDomains = Array.from(byDomain.keys()).filter(
    (d) => d && d.includes(".") && !FREE_MAIL_DOMAINS.has(d),
  );
  if (clientDomains.length > 0) {
    const nameRows =
      (
        await queryWithTimeout<any>(
          `SELECT DISTINCT LOWER(domain) AS domain, company_name, account_name
             FROM duplicate_records
            WHERE LOWER(domain) = ANY($1::text[])
              AND COALESCE(company_name, account_name) IS NOT NULL`,
          [clientDomains],
          undefined,
          PREFLIGHT_DIR_TIMEOUT_MS,
        )
      )?.rows ?? [];
    for (const nr of nameRows) {
      const dom = (nr.domain || "").toString().trim().toLowerCase();
      const status = byDomain.get(dom);
      if (!status) continue;
      for (const raw of [nr.company_name, nr.account_name]) {
        const rawName = (raw || "").toString().trim();
        if (!rawName || isPlaceholderName(rawName)) continue;
        for (const seg of _nameSegments(rawName)) {
          if (isPlaceholderName(seg)) continue;
          const nm = normalizeCompanyName(seg);
          if (nm && nm.length >= 3 && !byName.has(nm)) {
            byName.set(nm, status);
            indexName(nm);
          }
        }
      }
    }
  }

  _csDirCache = { byName, byDomain, tokenIndex, builtAt: todayMs };
  return _csDirCache;
}

/**
 * COMPREHENSIVE COVERAGE AUDIT — proves the whole approach. Enumerates every
 * ACTIVE client (the source of truth: a non-merchant deal with a CS phase or a
 * customer Stage, NOT churned) and checks whether the directory can catch it by
 * DOMAIN and/or by NAME (exact / containment / fuzzy, bilingual-aware). Surfaces:
 *   - `uncovered`     — active clients catchable by NEITHER name nor domain →
 *                       they ALWAYS leak (the worst class). Should be 0.
 *   - `domainOnly`    — catchable only by domain → leak if an inbound row for
 *                       them has no domain (the ALJ `#n` class). Lists samples.
 *   - `nameOnly`      — clients with no domain anywhere; `nameOnlyUncovered` of
 *                       them the name path still misses.
 * Run once after any directory change to confirm there's no remaining leak class.
 */
export async function auditDirectoryCoverage(): Promise<{
  stats: { names: number; domains: number };
  activeClients: number;
  coveredByDomain: number;
  coveredByName: number;
  domainOnly: number;
  uncoveredCount: number;
  uncovered: Array<{ name: string; domain: string; layout: string; phase: string; stage: string }>;
  domainOnlySamples: Array<{ name: string; domain: string; phase: string; stage: string }>;
  nameOnly: number;
  nameOnlyUncovered: number;
}> {
  _csDirCache = null;
  const dir = await getCsClientDirectory(Date.now());
  const customerStages = new Set(Array.from(PF_CUSTOMER_STAGES));
  const isMerchant = (l: string) =>
    !!l && (l.includes("marketplace") || l === "walaone" || l === "partneraccounts");
  const q = await queryWithTimeout<any>(
    `SELECT account_name, company_name, LOWER(domain) AS domain,
            LOWER(COALESCE(NULLIF(raw_data->>'Company_Domain',''),'')) AS cs_domain,
            NULLIF(raw_data->>'Phase','') AS phase,
            LOWER(COALESCE(NULLIF(stage,''), raw_data->>'Stage','')) AS stage,
            NULLIF(raw_data->>'Churn_Date','') AS churn_date,
            LOWER(REGEXP_REPLACE(COALESCE(layout_name, raw_data->'Layout'->>'name',''),'[^a-zA-Z0-9]','','g')) AS layout_norm
       FROM duplicate_records
      WHERE record_type='deal'
      LIMIT 200000`,
    [],
    undefined,
    PREFLIGHT_DIR_TIMEOUT_MS,
  );
  let activeClients = 0, coveredByDomain = 0, coveredByName = 0, domainOnly = 0, nameOnly = 0, nameOnlyUncovered = 0;
  const uncovered: any[] = [];
  const domainOnlySamples: any[] = [];
  for (const d of (q?.rows ?? [])) {
    if (isMerchant((d.layout_norm || "").trim())) continue;
    const phase = (d.phase || "").toString().trim();
    const stage = (d.stage || "").toString().trim();
    if (!(phase !== "" || customerStages.has(stage))) continue;
    if (!!d.churn_date || phase.toLowerCase().includes("terminat")) continue; // active only
    activeClients++;
    const domains = [d.domain, d.cs_domain]
      .map((x: any) => (x || "").toString().trim().toLowerCase())
      .filter(Boolean);
    const hasDomain = domains.some((dm) => dir.byDomain.has(dm));
    let hasName = false;
    for (const raw of [d.account_name, d.company_name]) {
      const rn = (raw || "").toString().trim();
      if (!rn || isPlaceholderName(rn)) continue;
      for (const seg of _nameSegments(rn)) {
        const nm = normalizeCompanyName(seg);
        if (nm && (dir.byName.has(nm) || _csContainmentMatch(nm, dir) || _csFuzzyMatch(nm, dir))) {
          hasName = true;
          break;
        }
      }
      if (hasName) break;
    }
    if (hasDomain) coveredByDomain++;
    if (hasName) coveredByName++;
    if (hasDomain && !hasName) {
      domainOnly++;
      if (domainOnlySamples.length < 30)
        domainOnlySamples.push({ name: String(d.account_name || d.company_name || "").slice(0, 44), domain: domains[0] || "-", phase: phase || "-", stage: stage || "-" });
    }
    if (domains.length === 0) {
      nameOnly++;
      if (!hasName) nameOnlyUncovered++;
    }
    if (!hasDomain && !hasName && uncovered.length < 60) {
      uncovered.push({ name: String(d.account_name || d.company_name || "").slice(0, 44), domain: domains[0] || "-", layout: d.layout_norm || "-", phase: phase || "-", stage: stage || "-" });
    }
  }
  return {
    stats: { names: dir.byName.size, domains: dir.byDomain.size },
    activeClients,
    coveredByDomain,
    coveredByName,
    domainOnly,
    uncoveredCount: uncovered.length,
    uncovered,
    domainOnlySamples,
    nameOnly,
    nameOnlyUncovered,
  };
}

/**
 * Observability hook — returns the current size of the CS-client directory so
 * silent degradation (an empty/stale Deals sync collapsing the directory) is
 * VISIBLE without anyone re-running an export. `active` / `churned` count how
 * many indexed names resolve to a live vs. terminated client. Forces a fresh
 * build (bypasses the 60s cache) so the numbers reflect the database right now.
 */
/**
 * Debug a single inbound company name against the live directory — shows the
 * normalized form, whether it hits exact / containment / fuzzy, and the byName +
 * byDomain keys that look related, so we can see WHY a known client isn't
 * resolving. Forces a fresh build.
 */
export async function debugDirectoryMatch(
  companyName: string,
  domain?: string,
): Promise<{
  inbound: string;
  inboundDomain: string | null;
  normalized: string;
  distinctiveTokens: string[];
  byNameSize: number;
  domainHit: { key: string; client: string | null } | null;
  exact: boolean;
  contained: string | null;
  fuzzy: string | null;
  // The verdict the live cascade (domain → exact → contained → fuzzy) would
  // reach, and the client it resolves to — so a mismatch shows its exact path.
  resolvedVia: "domain" | "strict_name" | "fuzzy_name" | null;
  resolvedClient: string | null;
  resolvedActive: boolean | null;
  relatedNameKeys: string[];
  relatedDomainKeys: string[];
}> {
  _csDirCache = null;
  const dir = await getCsClientDirectory(Date.now());
  const nm = normalizeCompanyName(companyName);
  const toks = nm.split(/\s+/).filter(Boolean);
  const dom = (domain || "").toString().trim().toLowerCase() || null;

  const domStatus = dom ? dir.byDomain.get(dom) : undefined;
  const domainHit = dom && domStatus
    ? { key: dom, client: domStatus.companyName ?? null }
    : null;

  const contained = _csContainmentMatch(nm, dir);
  const fuzzy = _csFuzzyMatch(nm, dir);
  const exact = dir.byName.has(nm);

  // Mirror the runPreflightBasic cascade so the resolved client is exact.
  let resolvedVia: "domain" | "strict_name" | "fuzzy_name" | null = null;
  let resolved: CsClientStatus | null = null;
  if (dom && domStatus) {
    resolvedVia = "domain";
    resolved = domStatus;
  } else if (exact) {
    resolvedVia = "strict_name";
    resolved = dir.byName.get(nm)!;
  } else if (contained) {
    resolvedVia = "strict_name";
    resolved = dir.byName.get(contained)!;
  } else if (fuzzy) {
    resolvedVia = "fuzzy_name";
    resolved = dir.byName.get(fuzzy)!;
  }

  const related = Array.from(dir.byName.keys()).filter((k) =>
    toks.some((t) => t.length >= 4 && k.includes(t)),
  );
  const relDom = dom
    ? Array.from(dir.byDomain.keys()).filter((d) => {
        const root = dom.split(".")[0];
        return root.length >= 3 && d.includes(root);
      })
    : [];
  return {
    inbound: companyName,
    inboundDomain: dom,
    normalized: nm,
    distinctiveTokens: _csDistinctiveTokens(nm),
    byNameSize: dir.byName.size,
    domainHit,
    exact,
    contained,
    fuzzy,
    resolvedVia,
    resolvedClient: resolved?.companyName ?? (resolvedVia ? "(matched)" : null),
    resolvedActive: resolved ? resolved.active : null,
    relatedNameKeys: related.slice(0, 40),
    relatedDomainKeys: relDom.slice(0, 20),
  };
}

export async function getCsClientDirectoryStats(): Promise<{
  names: number;
  domains: number;
  tokens: number;
  active: number;
  churned: number;
  built_at_iso: string;
}> {
  _csDirCache = null; // force a fresh build so stats reflect the DB right now
  const dir = await getCsClientDirectory(Date.now());
  let active = 0;
  let churned = 0;
  for (const st of dir.byName.values()) {
    if (st?.active) active++;
    else churned++;
  }
  return {
    names: dir.byName.size,
    domains: dir.byDomain.size,
    tokens: dir.tokenIndex.size,
    active,
    churned,
    built_at_iso: new Date(dir.builtAt).toISOString(),
  };
}

/**
 * Match an inbound normalized company name to a client by NAME CONTAINMENT —
 * every token of a client's name appears in the inbound name (e.g. client
 * "samref" ⊆ inbound "samref saudi aramco mobil refinery"). Returns the matched
 * client normalized-name, or null. Errs toward catching clients (the cost of a
 * false PASS — cold-calling a live customer — is far higher than a false flag).
 */
function _csContainmentMatch(inboundNorm: string, dir: CsClientDirectory): string | null {
  const inboundToks = new Set(_csTokens(inboundNorm));
  if (inboundToks.size === 0) return null;
  const inboundDistinct = _csDistinctiveTokens(inboundNorm);
  // Inbound with no distinctive token (e.g. "Confidential Construction" — both
  // are generic) can't anchor a name match.
  if (inboundDistinct.length === 0) return null;
  const candidates = new Set<string>();
  for (const t of inboundToks) {
    if (CS_DIR_STOP.has(t)) continue;
    const names = dir.tokenIndex.get(t);
    if (names) for (const n of names) candidates.add(n);
  }
  let best: string | null = null;
  let bestLen = 0;
  for (const cand of candidates) {
    const candToks = _csTokens(cand);
    if (candToks.length === 0) continue;
    const candDistinct = candToks.filter(_isDistinctiveTok);
    // Require ≥1 distinctive (non-stop) token and ALL client tokens present.
    if (candDistinct.length === 0) continue;
    if (!candToks.every((t) => inboundToks.has(t))) continue;
    // A SINGLE shared distinctive token (e.g. "Rawabi") is only a containment
    // when the inbound is essentially that same name — i.e. it brings NO other
    // brand word of its own. "Rawabi Holding" must NOT swallow "Rawabi Vallianz
    // Offshore Services" (vallianz/offshore are extra brands → different
    // company). Multi-distinctive-token clients are specific enough to keep the
    // looser rule.
    if (candDistinct.length < 2) {
      const onlyTok = candDistinct[0];
      const extra = inboundDistinct.filter((t) => t !== onlyTok);
      if (extra.length > 0) continue;
    }
    const len = cand.length;
    if (len > bestLen) {
      bestLen = len;
      best = cand;
    }
  }
  return best;
}

/** Dice bigram similarity (0..1) for the last-resort fuzzy tier. */
function _diceSim(a: string, b: string): number {
  const bigrams = (s: string) => {
    const out = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
  };
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  let total = 0;
  for (const v of A.values()) total += v;
  for (const [g, v] of B) {
    total += v;
    inter += Math.min(v, A.get(g) || 0);
  }
  return total === 0 ? 0 : (2 * inter) / total;
}

/**
 * Fuzzy name match (Dice ≥ 0.82) against client names that share a DISTINCTIVE
 * token. Candidates are gathered only via brand tokens (generic industry words
 * are stop-listed), so "SAJA Pharmaceuticals" no longer reaches "Hekma
 * Pharmaceuticals" — they share only the generic "pharmaceuticals". The shared
 * brand token must also be present on BOTH sides, so a high Dice driven purely
 * by a long shared generic word can't sneak a match through.
 */
function _csFuzzyMatch(inboundNorm: string, dir: CsClientDirectory): string | null {
  const inboundDistinct = _csDistinctiveTokens(inboundNorm);
  if (inboundDistinct.length === 0) return null;
  const inboundDistinctSet = new Set(inboundDistinct);
  const candidates = new Set<string>();
  for (const t of inboundDistinct) {
    const names = dir.tokenIndex.get(t);
    if (names) for (const n of names) candidates.add(n);
  }
  let best: string | null = null;
  let bestSim = 0.82;
  for (const cand of candidates) {
    // The match must rest on a shared BRAND token, not just overall string
    // similarity inflated by a common generic word.
    const candDistinct = _csDistinctiveTokens(cand);
    if (!candDistinct.some((t) => inboundDistinctSet.has(t))) continue;
    const sim = _diceSim(inboundNorm, cand);
    if (sim >= bestSim) {
      bestSim = sim;
      best = cand;
    }
  }
  return best;
}

/**
 * BASIC mode runner (Ahmad 2026-06-18) — see PREFLIGHT_RULE_MODE. Two SQL
 * passes over duplicate_records (corporate-scope only, marketplace excluded):
 *   1) contact-identity match by email OR phone (any record type) → duplicate;
 *   2) RULE 2 v3 (Ahmad 2026-06-23) — existing-CLIENT match against the
 *      CS-client DIRECTORY built from every CS-tracked / customer deal (not
 *      clusters), by domain → exact name → name-containment → fuzzy. Active
 *      client → BLOCK; fuzzy-only → REVIEW; churned-in-cool-off → REVIEW;
 *      past cool-off / not a client → PASS.
 * The archived "full" ladder is left untouched below.
 */
async function runPreflightBasic(input: {
  rows: PreflightInputRow[];
  max_check?: number;
}): Promise<PreflightResponse> {
  const cap = Math.max(1, Math.min(input.max_check ?? 5000, 10000));
  const rows = input.rows ?? [];
  const examineCount = Math.min(rows.length, cap);

  const emailByRow = new Map<number, string>();
  const phoneByRow = new Map<number, string>();
  const domainByRow = new Map<number, string>();
  const nameByRow = new Map<number, string>();
  const emailSet = new Set<string>();
  const phoneSet = new Set<string>();
  const domainSet = new Set<string>();
  const nameSet = new Set<string>();
  for (let i = 0; i < examineCount; i++) {
    const r = rows[i]!;
    const email = (r.email || "").trim().toLowerCase();
    if (email && email.includes("@")) {
      emailByRow.set(i, email);
      emailSet.add(email);
    }
    const p = resolvePhone(r);
    if (p) {
      phoneByRow.set(i, p);
      phoneSet.add(p);
    }
    const d = resolveDomain(r);
    if (d) {
      domainByRow.set(i, d);
      domainSet.add(d);
    }
    // RULE 2 v2 — normalise the inbound company name with the SAME normaliser
    // the sync uses for duplicate_clusters.company_name_normalized, so a strict
    // match is an exact string compare and the fuzzy tier shares one trigram
    // space with the indexed cluster names.
    // Only match by NAME when it's a real, substantial name: skip placeholders
    // (N/A, Test, Confidential, Unknown…) and short/generic fragments (< 4
    // normalised chars) so we never fuse unrelated companies that merely share
    // a placeholder or a boilerplate word. The DOMAIN tier is unaffected, so a
    // short-named client that has a website is still caught there.
    const rawCompany = r.company_name || "";
    const nm = normalizeCompanyName(rawCompany);
    // Only match by NAME when a DISTINCTIVE (brand) token survives — a name made
    // up entirely of generic / sector words ("Confidential Construction",
    // "National Trading Services") carries no identity and must never fuse onto
    // an unrelated client. The DOMAIN tier is unaffected.
    if (
      nm &&
      nm.length >= 4 &&
      !isPlaceholderName(rawCompany) &&
      _csDistinctiveTokens(nm).length > 0
    ) {
      nameByRow.set(i, nm);
      nameSet.add(nm);
    }
  }

  const CORPORATE_SQL =
    "(record_type = 'contact' " +
    `OR LOWER(COALESCE(layout_name, '')) NOT IN (${MERCHANT_LAYOUTS_SQL}) ` +
    "OR LOWER(COALESCE(account_type, '')) = 'customer' " +
    "OR LOWER(COALESCE(lead_type, '')) = 'customer')";

  // RULE 1 — contact duplicate by email OR phone.
  const matchedEmails = new Map<string, any>();
  const matchedPhones = new Map<string, any>();
  if (emailSet.size > 0 || phoneSet.size > 0) {
    const q = await queryWithTimeout<any>(
      `SELECT LOWER(email) AS email, phone_normalized, mobile_normalized,
              record_type, owner_name, record_name, company_name, zoho_record_id
         FROM duplicate_records
        WHERE ${CORPORATE_SQL}
          AND (
            (email IS NOT NULL AND LOWER(email) = ANY($1::text[]))
            OR phone_normalized  = ANY($2::text[])
            OR mobile_normalized = ANY($2::text[])
          )
        LIMIT 20000`,
      [Array.from(emailSet), Array.from(phoneSet)],
    );
    for (const r of (q?.rows ?? [])) {
      const em = (r.email || "").trim().toLowerCase();
      if (em && !matchedEmails.has(em)) matchedEmails.set(em, r);
      const pn = (r.phone_normalized || "").trim();
      if (pn && !matchedPhones.has(pn)) matchedPhones.set(pn, r);
      const mn = (r.mobile_normalized || "").trim();
      if (mn && !matchedPhones.has(mn)) matchedPhones.set(mn, r);
    }
  }

  // ── RULE 2 v3 — existing-CLIENT directory match (Ahmad 2026-06-23). Build
  // the CS-client directory ONCE (cached 60s) from every CS-tracked / customer
  // deal — NOT clusters — so clean, non-duplicated clients are caught too. The
  // per-row match below looks the inbound company up by domain → exact name →
  // name-containment → fuzzy (see the CsClientDirectory helpers above).
  const todayMs = Date.now();
  const csDir = await getCsClientDirectory(todayMs);

  const moduleOf = (rt: string | null | undefined): "Leads" | "Deals" | "Contacts" | "Accounts" => {
    const t = (rt || "").toLowerCase();
    if (t === "lead") return "Leads";
    if (t === "deal") return "Deals";
    if (t === "account") return "Accounts";
    return "Contacts";
  };

  const out: PreflightResultRow[] = [];
  const summary: PreflightSummary = { block: 0, review: 0, warn: 0, duplicate: 0, no_contact: 0, pass: 0 };
  let skipped = 0;
  // Intra-batch client memory: normalized company name → the client status any
  // row in THIS upload resolved to. A bulk list often carries the same company
  // twice — once on a work email (caught by domain) and once on a personal /
  // blank email (would leak) — so a sibling row's match is propagated below.
  const batchClientByName = new Map<string, CsClientStatus>();

  for (let i = 0; i < examineCount; i++) {
    const r = rows[i]!;
    const email = emailByRow.get(i) ?? null;
    const phone = phoneByRow.get(i) ?? null;
    const domain = domainByRow.get(i) ?? null;

    // REJECT a named contact with no way to reach them — has a person name but
    // NO email AND NO phone (Sarah 2026-06-24). Such a row can't be contacted, so
    // it must never land in the safe-to-import list. A company-only screening row
    // (no contact_name) is unaffected. Takes precedence over the domain screen.
    const contactName = (r.contact_name || "").toString().trim();
    if (contactName && !email && !phone) {
      summary.no_contact++;
      out.push({
        row_index: i,
        ref: r.ref ?? null,
        input: { domain, company_name: r.company_name ?? null },
        verdict: "no_contact",
        cluster_id: null,
        lifecycle_state: null,
        sector: null,
        arr_exposure: null,
        owners: [],
        reason: "no_email_or_phone",
        suggested_action:
          "No email and no phone — this contact cannot be reached. Do not import.",
        module_counts: null,
        matched_via: null,
        executive_action:
          "REJECT — no email and no phone on this contact; they cannot be reached, do not import.",
        executive_severity: "medium",
        churn_date: null,
        churn_days: null,
        cs_owner: null,
        cs_phase: null,
        crm_links: null,
      });
      continue;
    }

    // No resolvable identity at all → can't screen it.
    if (!email && !phone && !domain) {
      skipped++;
      continue;
    }

    const contactRec =
      (email && matchedEmails.get(email)) ||
      (phone && matchedPhones.get(phone)) ||
      null;
    const contactVia: "email" | "phone" | null = contactRec
      ? email && matchedEmails.has(email)
        ? "email"
        : "phone"
      : null;

    // RULE 1 (email/phone duplicate) always wins. Only when it clears do we
    // run RULE 2 v2 (existing-client check) for this row.
    let v: ReturnType<typeof basicPreflightVerdict> & {
      lifecycle_state?: PreflightResultRow["lifecycle_state"];
    };
    let csStatus: CsClientStatus | null = null;
    let csMatchVia: "domain" | "strict_name" | "fuzzy_name" | null = null;
    if (contactVia) {
      v = basicPreflightVerdict({ contactVia, isCustomerDomain: false });
    } else {
      const nm = nameByRow.get(i);
      // CS-client directory match: domain → exact name → containment → fuzzy.
      if (domain && csDir.byDomain.has(domain)) {
        csStatus = csDir.byDomain.get(domain)!;
        csMatchVia = "domain";
      } else if (nm && csDir.byName.has(nm)) {
        csStatus = csDir.byName.get(nm)!;
        csMatchVia = "strict_name";
      } else if (nm) {
        const contained = _csContainmentMatch(nm, csDir);
        if (contained) {
          csStatus = csDir.byName.get(contained)!;
          // Containment of a full client name inside the inbound name is strong.
          csMatchVia = "strict_name";
        } else {
          const fz = _csFuzzyMatch(nm, csDir);
          if (fz) {
            csStatus = csDir.byName.get(fz)!;
            csMatchVia = "fuzzy_name";
          }
        }
      }
      if (csStatus && csMatchVia) {
        const coolOff = csStatus.sector === "government" ? 365 : 180;
        const cs: "block" | "review" | "warn" = csStatus.active
          ? "block"
          : csStatus.churnDays != null && csStatus.churnDays <= coolOff
            ? "review"
            : "warn";
        v = csClientPreflightVerdict({
          cs,
          matchVia: csMatchVia,
          churnDays: csStatus.churnDays,
          coolOff,
          sector: csStatus.sector,
          csOwner: csStatus.csOwner,
          companyName: csStatus.companyName,
        });
      } else {
        v = basicPreflightVerdict({ contactVia: null, isCustomerDomain: false });
        csStatus = null;
        csMatchVia = null;
      }
    }
    summary[v.verdict]++;

    const owners: string[] = [];
    let crmLinks: PreflightResultRow["crm_links"] = null;
    let matchedViaOut: PreflightResultRow["matched_via"] = null;
    let clusterIdOut: number | null = null;
    let sectorOut: PreflightResultRow["sector"] = null;
    let csOwnerOut: string | null = null;
    let churnDateOut: string | null = null;
    let churnDaysOut: number | null = null;
    let csPhaseOut: string | null = null;
    let moduleCountsOut: PreflightResultRow["module_counts"] = null;
    let lifecycleOut: PreflightResultRow["lifecycle_state"] = v.lifecycle_state ?? null;

    if (contactVia && contactRec) {
      // RULE 1 duplicate — surface the existing owner + a CRM link.
      if (contactRec.owner_name) owners.push(contactRec.owner_name);
      matchedViaOut = contactVia;
      const mod = moduleOf(contactRec.record_type);
      if (contactRec.zoho_record_id && mod !== "Contacts") {
        const link = {
          url: buildZohoRecordUrl(mod, contactRec.zoho_record_id),
          label: (contactRec.record_name || "").trim() || contactRec.zoho_record_id,
        };
        crmLinks = {
          active_lead: mod === "Leads" ? link : null,
          active_deal: mod === "Deals" ? link : null,
          client_deal: null,
          account: mod === "Accounts" ? link : null,
        };
      }
    } else if (csStatus && csMatchVia) {
      // RULE 2 v3 — surface the matched client's CS owner, sector, churn date +
      // precise lifecycle phase so the export's CS columns are populated.
      if (csStatus.csOwner) owners.push(csStatus.csOwner);
      matchedViaOut = csMatchVia === "domain" ? "domain" : "company_name";
      sectorOut = csStatus.sector;
      csOwnerOut = csStatus.csOwner;
      churnDateOut = csStatus.churnDate;
      churnDaysOut = csStatus.churnDays;
      csPhaseOut = csStatus.phase;
      if (csStatus.lifecycleState) lifecycleOut = csStatus.lifecycleState;
    }

    // Remember any client this row resolved to, keyed by its company name, so a
    // sibling PASS row of the same company (personal/blank email) can inherit it.
    if (csStatus) {
      const rowNm = nameByRow.get(i);
      if (rowNm) {
        const prev = batchClientByName.get(rowNm);
        // Prefer an ACTIVE (block) status over a churned one.
        if (!prev || (csStatus.active && !prev.active)) {
          batchClientByName.set(rowNm, csStatus);
        }
      }
    }

    out.push({
      row_index: i,
      ref: r.ref ?? null,
      input: { domain, company_name: r.company_name ?? null },
      verdict: v.verdict,
      cluster_id: clusterIdOut,
      lifecycle_state: lifecycleOut,
      sector: sectorOut,
      arr_exposure: null,
      owners,
      reason: v.reason,
      suggested_action: v.suggested_action,
      module_counts: moduleCountsOut,
      matched_via: matchedViaOut,
      executive_action: v.executive_action,
      executive_severity: v.executive_severity,
      churn_date: churnDateOut,
      churn_days: churnDaysOut,
      cs_owner: csOwnerOut,
      cs_phase: csPhaseOut,
      crm_links: crmLinks,
    });
  }

  // ── Intra-batch propagation ──────────────────────────────────────────────
  // A bulk upload routinely lists the SAME company many times — some contacts on
  // a work email (caught by domain) and some on a personal / blank email that
  // leaves only the company name. If ANY row resolved to a CS client, upgrade
  // every PASS row with the SAME normalized company name to that client's verdict
  // (block for active, review for churned-in-cool-off), so a known client can't
  // slip into the import list just because one of its contacts used a Gmail. Only
  // fires on substantial names (the nameByRow filter already drops placeholders
  // like "Confidential …"), so generic labels never propagate.
  if (batchClientByName.size > 0) {
    for (let i = 0; i < out.length; i++) {
      const row = out[i]!;
      if (row.verdict !== "pass") continue;
      const nm = nameByRow.get(row.row_index);
      if (!nm) continue;
      const st = batchClientByName.get(nm);
      if (!st) continue;
      const coolOff = st.sector === "government" ? 365 : 180;
      const cs: "block" | "review" | "warn" = st.active
        ? "block"
        : st.churnDays != null && st.churnDays <= coolOff
          ? "review"
          : "warn";
      if (cs === "warn") continue; // churned past cool-off → still importable
      const vv = csClientPreflightVerdict({
        cs,
        matchVia: "strict_name",
        churnDays: st.churnDays,
        coolOff,
        sector: st.sector,
        csOwner: st.csOwner,
        companyName: st.companyName,
      });
      summary[row.verdict]--;
      summary[vv.verdict]++;
      out[i] = {
        ...row,
        verdict: vv.verdict,
        reason: vv.reason + "_same_company_in_upload",
        suggested_action:
          vv.suggested_action +
          " (Another contact for this company in the same upload is an existing client.)",
        executive_action: vv.executive_action,
        executive_severity: vv.executive_severity,
        matched_via: "company_name",
        sector: st.sector,
        cs_owner: st.csOwner,
        owners: st.csOwner ? [st.csOwner] : row.owners,
        churn_date: st.churnDate,
        churn_days: st.churnDays,
        cs_phase: st.phase,
        lifecycle_state: st.lifecycleState ?? row.lifecycle_state,
      };
    }
  }

  const reasonBuckets = new Map<string, number>();
  const bump = (label: string) =>
    reasonBuckets.set(label, (reasonBuckets.get(label) ?? 0) + 1);
  for (const r of out) {
    if (r.verdict === "duplicate") {
      bump("Duplicate contact (email / phone) already in CRM");
    } else if (r.verdict === "block") {
      bump("Existing active client — do not cold-contact, route to owner");
    } else if (r.verdict === "review") {
      bump(
        r.reason === "possible_existing_client_fuzzy_name"
          ? "Possible existing client (name match) — verify before contacting"
          : "Recently churned client — CS sign-off before re-engaging",
      );
    } else if (r.verdict === "warn") {
      bump("Past CS cool-off — Sales may re-engage with CS sign-off");
    } else if (r.verdict === "no_contact") {
      bump("No email or phone — contact cannot be reached, do not import");
    }
  }
  const topReasons: PreflightTopReason[] = Array.from(reasonBuckets.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([label, count]) => ({
      label,
      count,
      pct: examineCount > 0 ? Math.round((count / examineCount) * 1000) / 10 : 0,
    }));

  const actionable = summary.block + summary.duplicate + summary.no_contact;
  const pctActionable =
    examineCount > 0 ? Math.round((actionable / examineCount) * 1000) / 10 : 0;

  return {
    total_rows: rows.length,
    examined: examineCount,
    skipped,
    summary,
    total_arr_exposure_blocked: 0,
    rows: out,
    top_reasons: topReasons,
    generated_at: new Date().toISOString(),
    pct_actionable: pctActionable,
  };
}

export async function runPreflight(input: {
  rows: PreflightInputRow[];
  max_check?: number;
  /**
   * When true, re-run the cluster-level CS overlap scan on every matched
   * cluster BEFORE classifying — guarantees the verdict reflects the
   * latest Zoho CS section (Phase / Churn_Date / Renewal_Date) instead
   * of yesterday's cron. Adds one DB write + Zoho-free recompute per
   * unique cluster; only opt into this when staleness matters (e.g. an
   * intake form that runs minutes after the CS team flipped a phase).
   */
  refresh_overlap?: boolean;
}): Promise<PreflightResponse> {
  // BASIC mode (default) — only the two foundational rules. The rich ladder
  // below is archived behind PREFLIGHT_RULE_MODE=full.
  if (PREFLIGHT_RULE_MODE === "basic") {
    return runPreflightBasic({ rows: input.rows, max_check: input.max_check });
  }

  const cap = Math.max(1, Math.min(input.max_check ?? 5000, 10000));
  const rows = input.rows ?? [];
  const examineCount = Math.min(rows.length, cap);

  // Pre-resolve the three identity signals per row so the batch queries
  // below run once each on the union of all keys.
  const domainByRow = new Map<number, string>();
  const phoneByRow = new Map<number, string>();
  const companyByRow = new Map<number, string>();
  const domainSet = new Set<string>();
  const phoneSet = new Set<string>();
  for (let i = 0; i < examineCount; i++) {
    const r = rows[i]!;
    const d = resolveDomain(r);
    if (d) {
      domainByRow.set(i, d);
      domainSet.add(d);
    }
    const p = resolvePhone(r);
    if (p) {
      phoneByRow.set(i, p);
      phoneSet.add(p);
    }
    const c = resolveCompany(r);
    if (c) companyByRow.set(i, c);
  }

  // PATH 1 — Batch lookup by domain (the dominant case).
  //
  // Sarah 2026-06-17 — status filter widened from `= 'active'` to
  // `IN ('active','resolved')`. `'resolved'` in our radar means the
  // duplicate cluster was already worked: the survivor record STAYS in
  // CRM. A new submission for the same company is still a real duplicate
  // and must surface — the old `'active'`-only filter was returning 0
  // rows for cleaned-up companies and we incorrectly stamped them PASS.
  // That's the root of the "vendor list looked clean but Sales found
  // dupes" pattern. `'ignored'` (operator-dismissed false positives) is
  // still excluded — those clusters are legitimately "not the same
  // company" and shouldn't trigger.
  const clustersByDomain = new Map<string, PreflightClusterRow>();
  if (domainSet.size > 0) {
    const q = await queryWithTimeout<PreflightClusterRow>(
      `SELECT ${CLUSTER_SELECT_COLS}
         FROM duplicate_clusters
        WHERE domain = ANY($1::text[])
          AND status IN ('active','resolved')`,
      [Array.from(domainSet)],
    );
    for (const row of (q?.rows ?? [])) {
      const existing = clustersByDomain.get(row.domain);
      if (
        !existing ||
        severity(row.cs_overlap_verdict) > severity(existing.cs_overlap_verdict)
      ) {
        clustersByDomain.set(row.domain, row);
      }
    }
  }

  // PATH 1B — Sarah 2026-06-17 — Domain fuzzy fallback. The exact-
  // domain lookup misses on variants like alrajhi-capital.sa vs
  // alrajhi.com.sa, www.foo.com vs foo.com, sdb.gov.sa vs sdb-bank.com.sa.
  // For every row that didn't hit PATH 1 exact, do a single batched
  // pg_trgm lookup at similarity ≥ 0.7 against duplicate_clusters.domain
  // (GIN index already exists on company_name_normalized, but the
  // similarity operator still works without a dedicated index — it's
  // bounded by the small per-batch domain set, so a seq scan is fine).
  // The match is treated as `matched_via = "domain"` downstream so the
  // verdict ladder behaves identically to an exact hit.
  const clustersByDomainFuzzy = new Map<number, PreflightClusterRow>();
  const fuzzyDomainsNeeded: Array<{ idx: number; domain: string }> = [];
  for (const [i, d] of domainByRow) {
    if (clustersByDomain.has(d)) continue;
    fuzzyDomainsNeeded.push({ idx: i, domain: d });
  }
  if (fuzzyDomainsNeeded.length > 0) {
    const names = fuzzyDomainsNeeded.map((x) => x.domain);
    const q = await queryWithTimeout<
      PreflightClusterRow & { _input_idx: number }
    >(
      `SELECT v.ord AS _input_idx,
              dc.id, dc.domain,
              dc.company_name,
              dc.cs_overlap_verdict,
              dc.pipeline_lifecycle_state,
              dc.client_sector,
              dc.arr_exposure,
              dc.owners_involved,
              dc.total_leads, dc.total_deals, dc.total_contacts, dc.total_accounts
         FROM unnest($1::text[]) WITH ORDINALITY AS v(d, ord)
         LEFT JOIN LATERAL (
           SELECT ${CLUSTER_SELECT_COLS}
             FROM duplicate_clusters
            WHERE status IN ('active','resolved')
              AND domain IS NOT NULL
              AND domain <> ''
              AND domain % v.d
            ORDER BY similarity(domain, v.d) DESC
            LIMIT 1
         ) dc ON true
        WHERE dc.id IS NOT NULL`,
      [names],
      [`SELECT set_limit(0.7)`],
    );
    if (q && Array.isArray(q.rows)) {
      for (const row of q.rows) {
        const inputIdx = Number(row._input_idx) - 1;
        const original = fuzzyDomainsNeeded[inputIdx];
        if (!original) continue;
        const { _input_idx, ...cluster } = row;
        clustersByDomainFuzzy.set(original.idx, cluster as PreflightClusterRow);
      }
    }
  }

  // PATH 2 — Batch lookup by phone for the rows that didn't hit on domain.
  // Joins through duplicate_records → duplicate_clusters because the phone
  // lives on the record row, not the cluster row.
  const phonesNeeded = new Set<string>();
  for (const [i, p] of phoneByRow) {
    const d = domainByRow.get(i);
    if (d && clustersByDomain.has(d)) continue;
    // Sarah 2026-06-17 — also skip rows that already matched via the
    // PATH 1B domain-fuzzy fallback so we don't pay the PATH 2 cost
    // unnecessarily.
    if (clustersByDomainFuzzy.has(i)) continue;
    phonesNeeded.add(p);
  }
  const clustersByPhone = new Map<string, PreflightClusterRow>();
  if (phonesNeeded.size > 0) {
    const q = await queryWithTimeout<PreflightClusterRow & { matched_phone: string }>(
      `SELECT DISTINCT ON (dr.phone_normalized)
              dr.phone_normalized AS matched_phone,
              dc.id, dc.domain,
              dc.cs_overlap_verdict,
              dc.pipeline_lifecycle_state,
              dc.client_sector,
              dc.arr_exposure,
              dc.owners_involved,
              dc.total_leads, dc.total_deals, dc.total_contacts, dc.total_accounts
         FROM duplicate_records dr
         JOIN duplicate_clusters dc ON dc.id = dr.cluster_id
        WHERE dr.phone_normalized = ANY($1::text[])
          AND dc.status IN ('active','resolved')
        ORDER BY dr.phone_normalized,
                 CASE dc.cs_overlap_verdict
                   WHEN 'block'  THEN 4
                   WHEN 'review' THEN 3
                   WHEN 'warn'   THEN 2
                   ELSE 1
                 END DESC`,
      [Array.from(phonesNeeded)],
    );
    for (const row of (q?.rows ?? [])) {
      const { matched_phone, ...cluster } = row;
      clustersByPhone.set(matched_phone, cluster as PreflightClusterRow);
    }
  }

  // PATH 3 — Fuzzy company-name lookup (pg_trgm similarity ≥ 0.6).
  // Only for rows that didn't match by domain OR by phone.
  //
  // Pre-fix: this ran one SELECT per row. For 1,668 rows that was 1,668
  // sequential round-trips against duplicate_clusters; even at 50ms per
  // query the operator hit a 504 Gateway Timeout (~83s wall-clock).
  //
  // Post-fix: ONE round-trip. Pass every company name in as an array and
  // do the fuzzy match via LATERAL JOIN — Postgres scans
  // duplicate_clusters once and returns the best cluster per name. With
  // a trigram GIN index on company_name_normalized (created idempotently
  // below) the LATERAL stays milliseconds per name. Without the index
  // it's still ONE plan, not N, so the speedup is ~20× even on a cold
  // table.
  //
  // Best-effort: pg_trgm + GIN index may not exist in every env. If
  // either is missing we fall back to a per-row loop with a hard cap
  // (NEEDS_FUZZY_FALLBACK_MAX) so a misconfigured DB cannot blow past
  // the gateway timeout again.
  const companyMatchByRow = new Map<number, PreflightClusterRow>();
  const namesNeeded: Array<{ idx: number; name: string }> = [];
  for (const [i, cname] of companyByRow) {
    const d = domainByRow.get(i);
    if (d && clustersByDomain.has(d)) continue;
    // Sarah 2026-06-17 — skip rows already matched by PATH 1B
    // (domain fuzzy) so PATH 3 doesn't double-resolve.
    if (clustersByDomainFuzzy.has(i)) continue;
    const p = phoneByRow.get(i);
    if (p && clustersByPhone.has(p)) continue;
    namesNeeded.push({ idx: i, name: cname });
  }

  if (namesNeeded.length > 0) {
    // Idempotent extension + index check. CREATE EXTENSION IF NOT EXISTS
    // is a no-op once installed; CREATE INDEX IF NOT EXISTS likewise.
    // Wrap both in their own try/catch — neither failure should kill
    // the preflight.
    try {
      await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    } catch {
      /* extension may need superuser in some envs — fine, fall through */
    }
    try {
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_dup_clusters_name_norm_trgm
           ON duplicate_clusters USING GIN (company_name_normalized gin_trgm_ops)`,
      );
    } catch {
      /* index may already exist with a different name — fine */
    }

    // Single batched query. `unnest(... WITH ORDINALITY)` numbers the
    // input names so we can map results back to the row index. LATERAL
    // gives us the top-1 match per name without an explosion.
    //
    // PERF — using the `%` operator with `set_limit(0.6)` is what lets
    // Postgres actually USE the GIN trigram index. The older
    // `similarity(col, name) >= 0.6` form is correct but the planner
    // often can't push it down into the LATERAL subquery; on a 1.6k-row
    // batch that turned into a sequential rescan per name and dominated
    // the 504. `% v.name` with the threshold pinned to 0.6 via the
    // session function gets the same answer in one indexed pass.
    const names = namesNeeded.map((n) => n.name);
    let batchSucceeded = false;
    const q = await queryWithTimeout<
      PreflightClusterRow & { _input_idx: number }
    >(
      `SELECT v.ord AS _input_idx,
              dc.id, dc.domain,
              dc.cs_overlap_verdict,
              dc.pipeline_lifecycle_state,
              dc.client_sector,
              dc.arr_exposure,
              dc.owners_involved,
              dc.total_leads, dc.total_deals, dc.total_contacts, dc.total_accounts
         FROM unnest($1::text[]) WITH ORDINALITY AS v(name, ord)
         LEFT JOIN LATERAL (
           SELECT ${CLUSTER_SELECT_COLS}
             FROM duplicate_clusters
            WHERE status IN ('active','resolved')
              AND company_name_normalized IS NOT NULL
              AND company_name_normalized != ''
              AND company_name_normalized % v.name
            ORDER BY similarity(company_name_normalized, v.name) DESC
            LIMIT 1
         ) dc ON true
        WHERE dc.id IS NOT NULL`,
      [names],
      [`SELECT set_limit(0.55)`],
    );
    if (q && Array.isArray(q.rows)) {
      for (const row of q.rows) {
        const inputIdx = Number(row._input_idx) - 1; // ordinality is 1-based
        const original = namesNeeded[inputIdx];
        if (!original) continue;
        const { _input_idx, ...cluster } = row;
        companyMatchByRow.set(original.idx, cluster as PreflightClusterRow);
      }
      batchSucceeded = true;
    }

    if (!batchSucceeded) {
      // Defence in depth — hard cap the number of per-row fuzzy queries
      // so a missing index cannot let an 80-second hang come back. 200
      // rows × 50ms ≈ 10s, well inside any gateway timeout.
      const NEEDS_FUZZY_FALLBACK_MAX = 200;
      const slice = namesNeeded.slice(0, NEEDS_FUZZY_FALLBACK_MAX);
      for (const { idx, name } of slice) {
        try {
          const q = await pool.query<PreflightClusterRow>(
            `SELECT ${CLUSTER_SELECT_COLS}
               FROM duplicate_clusters
              WHERE status IN ('active','resolved')
                AND company_name_normalized IS NOT NULL
                AND company_name_normalized != ''
                AND similarity(company_name_normalized, $1) >= 0.55
              ORDER BY similarity(company_name_normalized, $1) DESC
              LIMIT 1`,
            [name],
          );
          if (q.rows[0]) companyMatchByRow.set(idx, q.rows[0]);
        } catch {
          /* pg_trgm extension missing — silently skip this row */
        }
      }
    }
  }

  // Enrich every matched cluster with:
  //   • has_active_deal — drives the honest "active deal" wording
  //   • churn_date     — the latest Churn_Date observed on any Deal in
  //                      the cluster (raw_data->>'Churn_Date'). Lets
  //                      WARN/REVIEW verdicts say "churned on 2024-09-15"
  //                      instead of vague "past cool-off".
  //   • cs_owner       — Deal Owner of the CS-side deal (Paid /
  //                      Agreement Signed / Termination phase). Better
  //                      routing than the generic owners_involved blob.
  // One batched query covers all three over the matched cluster id set.
  {
    const ids = new Set<number>();
    for (const c of clustersByDomain.values()) ids.add(c.id);
    // 2026-06-17 — fuzzy-domain (PATH 1B) matches MUST be enriched too,
    // otherwise a row matched only via the fuzzy fallback gets
    // has_corporate_records=false and is silently scoped-out to PASS
    // (the verdict gate treats missing enrichment as out-of-scope).
    for (const c of clustersByDomainFuzzy.values()) ids.add(c.id);
    for (const c of clustersByPhone.values()) ids.add(c.id);
    for (const c of companyMatchByRow.values()) ids.add(c.id);
    if (ids.size > 0) {
      const flagsQ = await queryWithTimeout<{
        cluster_id: number;
        has_active_deal: boolean;
        has_active_lead: boolean;
        has_corporate_records: boolean;
        corporate_leads: string;
        corporate_deals: string;
        corporate_contacts: string;
        corporate_accounts: string;
        churn_date: string | null;
        cs_owner: string | null;
        active_lead_zoho_id: string | null;
        active_lead_name: string | null;
        active_deal_zoho_id: string | null;
        active_deal_name: string | null;
        client_deal_zoho_id: string | null;
        client_deal_name: string | null;
        account_zoho_id_link: string | null;
        account_name_link: string | null;
      }>(
        // Sarah 2026-06-17 — three things this query does:
        // (1) Corporate-scope filter (INVERTED 2026-06-17) — a record is
        //     corporate UNLESS it is on a merchant layout
        //     (MERCHANT_LAYOUT_NAMES: "Marketplace" / "Partner Accounts").
        //     So Corporate-Accounts, Corporate Sales, Standard-layout and
        //     legacy marker-less records all count; only explicit merchant
        //     Leads/Deals/Accounts are OUT OF SCOPE. has_corporate_records
        //     ignores contacts (Standard layout = no merchant signal).
        // (2) has_active_deal — widened to NOT fire on any "lost" /
        //     "won" / "closed*" / "dropped" / "cancel" stage variant
        //     plus the CS handoff stages. Empty Stage = conservative
        //     assume-active (raw_data gap).
        // (3) has_active_lead — NEW. The vendor row REJECT rule:
        //     if a matched cluster has any Lead whose Lead_Status is
        //     NOT junk/lost/bogus/disqualified/converted, the new
        //     vendor lead is an outright duplicate of an actively
        //     worked Lead and must NOT be imported.
        `SELECT cluster_id,
                -- In-scope decision: a cluster is corporate if it has any
                -- corporate Lead/Deal/Account. Contacts are deliberately
                -- excluded — they all sit on the Standard layout and would
                -- otherwise pull a pure-merchant cluster into scope.
                BOOL_OR(_is_corporate AND record_type IN ('lead','deal','account')) AS has_corporate_records,
                COUNT(*) FILTER (WHERE _is_corporate AND record_type = 'lead')::text    AS corporate_leads,
                COUNT(*) FILTER (WHERE _is_corporate AND record_type = 'deal')::text    AS corporate_deals,
                COUNT(*) FILTER (WHERE _is_corporate AND record_type = 'contact')::text AS corporate_contacts,
                COUNT(*) FILTER (WHERE _is_corporate AND record_type = 'account')::text AS corporate_accounts,
                BOOL_OR(
                  _is_corporate
                  AND record_type = 'deal'
                  AND COALESCE(LOWER(raw_data->>'Stage'), '') NOT LIKE '%lost%'
                  AND COALESCE(LOWER(raw_data->>'Stage'), '') NOT LIKE '%won%'
                  AND COALESCE(LOWER(raw_data->>'Stage'), '') NOT LIKE 'closed%'
                  AND COALESCE(LOWER(raw_data->>'Stage'), '') NOT LIKE '%dropped%'
                  AND COALESCE(LOWER(raw_data->>'Stage'), '') NOT LIKE '%cancel%'
                  AND COALESCE(LOWER(raw_data->>'Stage'), '') NOT IN
                      ('paid','agreement signed','client activated','transferred to cs','awaiting po')
                ) AS has_active_deal,
                BOOL_OR(
                  _is_corporate
                  AND record_type = 'lead'
                  AND COALESCE(LOWER(raw_data->>'Lead_Status'), LOWER(status), '')
                      NOT IN ('junk lead','bogus lead','lost lead','not qualified','disqualified','converted','new','attempted to contact')
                ) AS has_active_lead,
                MAX(NULLIF(raw_data->>'Churn_Date','')) AS churn_date,
                (
                  ARRAY_AGG(owner_name)
                    FILTER (WHERE record_type = 'deal'
                            AND LOWER(COALESCE(raw_data->>'Stage','')) IN
                                ('paid','agreement signed','closed won','agreement sent',
                                 'awaiting po','client activated','transferred to cs',
                                 'termination')
                            AND owner_name IS NOT NULL
                            AND owner_name <> '')
                )[1] AS cs_owner,
                -- Sarah 2026-06-17 — representative Zoho ids for the
                -- briefing's clickable CRM links. Prefer ACTIVE Lead
                -- and ACTIVE Deal over closed/lost; the "client_deal"
                -- pick covers Paid / Agreement Signed / Closed Won /
                -- handoff variants so the email tells Sales where the
                -- customer relationship actually lives.
                MAX(CASE WHEN _is_corporate AND record_type = 'lead'
                          AND COALESCE(LOWER(raw_data->>'Lead_Status'), LOWER(status), '')
                              NOT IN ('junk lead','bogus lead','lost lead','not qualified','disqualified','converted','new','attempted to contact')
                          AND zoho_record_id IS NOT NULL
                         THEN zoho_record_id END) AS active_lead_zoho_id,
                MAX(CASE WHEN _is_corporate AND record_type = 'lead'
                          AND COALESCE(LOWER(raw_data->>'Lead_Status'), LOWER(status), '')
                              NOT IN ('junk lead','bogus lead','lost lead','not qualified','disqualified','converted','new','attempted to contact')
                          AND record_name IS NOT NULL
                         THEN record_name END) AS active_lead_name,
                MAX(CASE WHEN _is_corporate AND record_type = 'deal'
                          AND COALESCE(LOWER(raw_data->>'Stage'), '') NOT LIKE '%lost%'
                          AND COALESCE(LOWER(raw_data->>'Stage'), '') NOT LIKE '%won%'
                          AND COALESCE(LOWER(raw_data->>'Stage'), '') NOT LIKE 'closed%'
                          AND COALESCE(LOWER(raw_data->>'Stage'), '') NOT LIKE '%dropped%'
                          AND COALESCE(LOWER(raw_data->>'Stage'), '') NOT LIKE '%cancel%'
                          AND COALESCE(LOWER(raw_data->>'Stage'), '') NOT IN
                              ('paid','agreement signed','client activated','transferred to cs','awaiting po')
                          AND zoho_record_id IS NOT NULL
                         THEN zoho_record_id END) AS active_deal_zoho_id,
                MAX(CASE WHEN _is_corporate AND record_type = 'deal'
                          AND COALESCE(LOWER(raw_data->>'Stage'), '') NOT LIKE '%lost%'
                          AND COALESCE(LOWER(raw_data->>'Stage'), '') NOT LIKE '%won%'
                          AND COALESCE(LOWER(raw_data->>'Stage'), '') NOT LIKE 'closed%'
                          AND COALESCE(LOWER(raw_data->>'Stage'), '') NOT LIKE '%dropped%'
                          AND COALESCE(LOWER(raw_data->>'Stage'), '') NOT LIKE '%cancel%'
                          AND COALESCE(LOWER(raw_data->>'Stage'), '') NOT IN
                              ('paid','agreement signed','client activated','transferred to cs','awaiting po')
                          AND record_name IS NOT NULL
                         THEN record_name END) AS active_deal_name,
                MAX(CASE WHEN _is_corporate AND record_type = 'deal'
                          AND LOWER(COALESCE(raw_data->>'Stage','')) IN
                              ('paid','agreement signed','closed won','agreement sent',
                               'awaiting po','client activated','transferred to cs')
                          AND zoho_record_id IS NOT NULL
                         THEN zoho_record_id END) AS client_deal_zoho_id,
                MAX(CASE WHEN _is_corporate AND record_type = 'deal'
                          AND LOWER(COALESCE(raw_data->>'Stage','')) IN
                              ('paid','agreement signed','closed won','agreement sent',
                               'awaiting po','client activated','transferred to cs')
                          AND record_name IS NOT NULL
                         THEN record_name END) AS client_deal_name,
                MAX(CASE WHEN _is_corporate AND record_type = 'account'
                          AND zoho_record_id IS NOT NULL
                         THEN zoho_record_id END) AS account_zoho_id_link,
                MAX(CASE WHEN _is_corporate AND record_type = 'account'
                          AND record_name IS NOT NULL
                         THEN record_name END) AS account_name_link
           FROM (
             SELECT *,
                    (
                      -- Sarah / Ahmad 2026-06-17 — INVERTED scope rule.
                      -- A record is corporate (in-scope) UNLESS it
                      -- carries an explicit marketplace / merchant
                      -- layout marker. The previous logic required the
                      -- ONE corporate layout string and so dropped
                      -- Accounts ("Corporate-Accounts"), Standard-layout
                      -- Contacts, and every legacy marker-less record —
                      -- the root cause of corporate dupes leaking
                      -- through Preflight as false PASSes.
                      --   • Contacts sit on Zoho "Standard" (no signal)
                      --     → always corporate for counting; excluded
                      --     from has_corporate_records (see below).
                      --   • An explicit Customer account/lead type still
                      --     forces corporate even on an odd layout.
                      record_type = 'contact'
                      OR LOWER(COALESCE(layout_name, '')) NOT IN (${MERCHANT_LAYOUTS_SQL})
                      OR LOWER(COALESCE(account_type, '')) = 'customer'
                      OR LOWER(COALESCE(lead_type, '')) = 'customer'
                    ) AS _is_corporate
               FROM duplicate_records
              WHERE cluster_id = ANY($1::int[])
           ) dr
          GROUP BY cluster_id`,
        [Array.from(ids)],
      );
      const byId = new Map<number, {
        has_active_deal: boolean;
        has_active_lead: boolean;
        has_corporate_records: boolean;
        corporate_leads: number;
        corporate_deals: number;
        corporate_contacts: number;
        corporate_accounts: number;
        churn_date: string | null;
        cs_owner: string | null;
        active_lead_zoho_id: string | null;
        active_lead_name: string | null;
        active_deal_zoho_id: string | null;
        active_deal_name: string | null;
        client_deal_zoho_id: string | null;
        client_deal_name: string | null;
        account_zoho_id_link: string | null;
        account_name_link: string | null;
      }>();
      if (flagsQ && Array.isArray(flagsQ.rows)) {
        for (const r of flagsQ.rows) {
          byId.set(Number(r.cluster_id), {
            has_active_deal: !!r.has_active_deal,
            has_active_lead: !!r.has_active_lead,
            has_corporate_records: !!r.has_corporate_records,
            corporate_leads:    Number(r.corporate_leads    ?? 0),
            corporate_deals:    Number(r.corporate_deals    ?? 0),
            corporate_contacts: Number(r.corporate_contacts ?? 0),
            corporate_accounts: Number(r.corporate_accounts ?? 0),
            churn_date: r.churn_date || null,
            cs_owner: r.cs_owner || null,
            active_lead_zoho_id:  r.active_lead_zoho_id  || null,
            active_lead_name:     r.active_lead_name     || null,
            active_deal_zoho_id:  r.active_deal_zoho_id  || null,
            active_deal_name:     r.active_deal_name     || null,
            client_deal_zoho_id:  r.client_deal_zoho_id  || null,
            client_deal_name:     r.client_deal_name     || null,
            account_zoho_id_link: r.account_zoho_id_link || null,
            account_name_link:    r.account_name_link    || null,
          });
        }
      }
      const todayMs = Date.now();
      const apply = (c: PreflightClusterRow) => {
        const v = byId.get(c.id);
        c.has_active_deal = v?.has_active_deal === true;
        c.has_active_lead = v?.has_active_lead === true;
        c.has_corporate_records = v?.has_corporate_records === true;
        c.corporate_leads    = v?.corporate_leads    ?? 0;
        c.corporate_deals    = v?.corporate_deals    ?? 0;
        c.corporate_contacts = v?.corporate_contacts ?? 0;
        c.corporate_accounts = v?.corporate_accounts ?? 0;
        c.active_lead_zoho_id  = v?.active_lead_zoho_id  ?? null;
        c.active_lead_name     = v?.active_lead_name     ?? null;
        c.active_deal_zoho_id  = v?.active_deal_zoho_id  ?? null;
        c.active_deal_name     = v?.active_deal_name     ?? null;
        c.client_deal_zoho_id  = v?.client_deal_zoho_id  ?? null;
        c.client_deal_name     = v?.client_deal_name     ?? null;
        c.account_zoho_id_link = v?.account_zoho_id_link ?? null;
        c.account_name_link    = v?.account_name_link    ?? null;
        // Normalise the churn date to yyyy-mm-dd (Zoho can return
        // datetimes). Compute churn_days off whatever parses.
        const raw = v?.churn_date ?? null;
        const iso = raw ? String(raw).slice(0, 10) : null;
        c.churn_date = iso;
        if (iso) {
          const t = Date.parse(iso);
          if (Number.isFinite(t)) {
            c.churn_days = Math.max(0, Math.floor((todayMs - t) / 86400000));
          } else {
            c.churn_days = null;
          }
        } else {
          c.churn_days = null;
        }
        c.cs_owner = v?.cs_owner ?? null;
      };
      for (const c of clustersByDomain.values()) apply(c);
      for (const c of clustersByDomainFuzzy.values()) apply(c);
      for (const c of clustersByPhone.values()) apply(c);
      for (const c of companyMatchByRow.values()) apply(c);
    }
  }

  // Build the per-row match map by walking the fallback chain in priority
  // order: domain exact → domain fuzzy → phone → company.
  const matchByRow = new Map<number, PreflightRowMatch>();
  for (let i = 0; i < examineCount; i++) {
    const d = domainByRow.get(i);
    if (d) {
      const c = clustersByDomain.get(d);
      if (c) {
        matchByRow.set(i, { cluster: c, matched_via: "domain" });
        continue;
      }
    }
    // PATH 1B fuzzy domain — same matched_via as exact so downstream
    // reads / verdict ladder behave identically.
    const fuzzy = clustersByDomainFuzzy.get(i);
    if (fuzzy) {
      matchByRow.set(i, { cluster: fuzzy, matched_via: "domain" });
      continue;
    }
    const p = phoneByRow.get(i);
    if (p) {
      const c = clustersByPhone.get(p);
      if (c) {
        matchByRow.set(i, { cluster: c, matched_via: "phone" });
        continue;
      }
    }
    const c = companyMatchByRow.get(i);
    if (c) {
      matchByRow.set(i, { cluster: c, matched_via: "company_name" });
    }
  }

  // ── PATH 4 — all-records fallback (Tier 1 + Tier 2) ─────────────────────
  // Rows still unmatched after the cluster paths: match against the FULL
  // duplicate_records set (NOT just formed duplicate_clusters) by domain,
  // exact contact email, or phone. This is the fix for companies that ARE in
  // the CRM but have no formed cluster (the false-pass gap — saib, sdb, …).
  // Records are aggregated per domain via buildClusterFromRecords so the
  // existing verdict ladder applies. Fully defensive: any failure degrades to
  // the prior (cluster-only) behavior and never breaks the working preflight.
  try {
    const unmatched: number[] = [];
    for (let i = 0; i < examineCount; i++) if (!matchByRow.has(i)) unmatched.push(i);
    if (unmatched.length > 0) {
      const todayMs = Date.now();
      const emailByRow = new Map<number, string>();
      const domSet = new Set<string>();
      const emailSet = new Set<string>();
      const phoneSet = new Set<string>();
      for (const i of unmatched) {
        const d = domainByRow.get(i);
        if (d && d.includes(".")) domSet.add(d);
        const em = (rows[i]!.email || "").trim().toLowerCase();
        if (em.includes("@")) {
          emailByRow.set(i, em);
          emailSet.add(em);
        }
        const p = phoneByRow.get(i);
        if (p) phoneSet.add(p);
      }
      if (domSet.size > 0 || emailSet.size > 0 || phoneSet.size > 0) {
        const recQ = await queryWithTimeout<
          PreflightRecordRow & {
            email?: string | null;
            phone_normalized?: string | null;
            mobile_normalized?: string | null;
          }
        >(
          `SELECT cluster_id, domain, record_type,
                  raw_data->>'Stage'        AS stage,
                  status,
                  raw_data->>'Lead_Status'  AS lead_status,
                  NULLIF(raw_data->>'Churn_Date','') AS churn_date,
                  gov_type, owner_name, record_name, company_name, zoho_record_id,
                  layout_name, account_type, lead_type,
                  LOWER(email) AS email, phone_normalized, mobile_normalized
             FROM duplicate_records
            WHERE (domain IS NOT NULL AND LOWER(domain) = ANY($1::text[]))
               OR (email  IS NOT NULL AND LOWER(email)  = ANY($2::text[]))
               OR (phone_normalized  = ANY($3::text[]))
               OR (mobile_normalized = ANY($3::text[]))
            LIMIT 20000`,
          [Array.from(domSet), Array.from(emailSet), Array.from(phoneSet)],
        );
        const recs = recQ?.rows ?? [];
        const recsByDomain = new Map<string, PreflightRecordRow[]>();
        const emailToDomain = new Map<string, string>();
        const phoneToDomain = new Map<string, string>();
        for (const r of recs) {
          const dom = (r.domain || "").trim().toLowerCase();
          if (!dom) continue;
          if (!recsByDomain.has(dom)) recsByDomain.set(dom, []);
          recsByDomain.get(dom)!.push(r);
          const em = (r as any).email as string | null | undefined;
          if (em && !emailToDomain.has(em)) emailToDomain.set(em, dom);
          const pn = (r as any).phone_normalized as string | null | undefined;
          const mn = (r as any).mobile_normalized as string | null | undefined;
          if (pn && !phoneToDomain.has(pn)) phoneToDomain.set(pn, dom);
          if (mn && !phoneToDomain.has(mn)) phoneToDomain.set(mn, dom);
        }
        const clusterCache = new Map<string, PreflightClusterRow | null>();
        const buildFor = (dom: string): PreflightClusterRow | null => {
          if (!clusterCache.has(dom)) {
            clusterCache.set(
              dom,
              buildClusterFromRecords(dom, recsByDomain.get(dom) || [], todayMs),
            );
          }
          return clusterCache.get(dom) ?? null;
        };
        for (const i of unmatched) {
          const d = domainByRow.get(i);
          let dom: string | null = null;
          let via: "domain" | "email" | "phone" = "domain";
          if (d && recsByDomain.has(d)) {
            dom = d;
            via = "domain";
          } else {
            const em = emailByRow.get(i);
            const p = phoneByRow.get(i);
            if (em && emailToDomain.has(em)) {
              dom = emailToDomain.get(em)!;
              via = "email";
            } else if (p && phoneToDomain.has(p)) {
              dom = phoneToDomain.get(p)!;
              via = "phone";
            }
          }
          if (dom) {
            const cl = buildFor(dom);
            if (cl) matchByRow.set(i, { cluster: cl, matched_via: via });
          }
        }
      }
    }
  } catch (e) {
    // Degrade gracefully — the cluster paths already populated matchByRow.
    logger.warn("[preflight] all-records fallback skipped", {
      error: (e as any)?.message || e,
    });
  }

  // OPT-IN — refresh the CS overlap verdict on every matched cluster.
  // Imported lazily so we don't pull in scanClusterForCsOverlap on every
  // call (avoid circular import in dbtest scenarios).
  if (input.refresh_overlap && matchByRow.size > 0) {
    const uniqueClusterIds = new Set<number>();
    for (const m of matchByRow.values()) uniqueClusterIds.add(m.cluster.id);
    const { scanClusterForCsOverlap } = await import("./duplicateRadarDatabase");
    for (const cid of uniqueClusterIds) {
      try {
        await scanClusterForCsOverlap(cid);
      } catch {
        /* non-fatal — fall back to the cached verdict */
      }
    }
    // Re-fetch the affected clusters so the response reflects the freshly
    // computed verdicts. One round-trip, scoped to the touched ids.
    const ids = Array.from(uniqueClusterIds);
    const q = await pool.query<PreflightClusterRow>(
      `SELECT ${CLUSTER_SELECT_COLS}
         FROM duplicate_clusters
        WHERE id = ANY($1::int[])`,
      [ids],
    );
    const freshById = new Map<number, PreflightClusterRow>();
    for (const r of q.rows) freshById.set(r.id, r);
    for (const [i, m] of matchByRow) {
      const fresh = freshById.get(m.cluster.id);
      if (fresh) matchByRow.set(i, { cluster: fresh, matched_via: m.matched_via });
    }
  }

  return classifyPreflightRows({
    rows,
    matchByRow,
    max_check: cap,
  });
}

function severity(v: string | null | undefined): number {
  if (v === "block") return 4;
  if (v === "review") return 3;
  if (v === "warn") return 2;
  if (v) return 1;
  return 0;
}

function extractOwners(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x)).filter(Boolean).slice(0, 5);
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((x) => String(x)).filter(Boolean).slice(0, 5);
      }
    } catch {
      return [raw];
    }
  }
  return [];
}
