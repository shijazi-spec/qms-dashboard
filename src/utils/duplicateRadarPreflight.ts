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
import { extractDomain, normalizeDomain } from "./duplicateRadarDatabase";

export type PreflightVerdict =
  | "block"
  | "review"
  | "warn"
  | "duplicate"
  | "pass";

export interface PreflightInputRow {
  domain?: string | null;
  email?: string | null;
  company_name?: string | null;
  phone?: string | null;
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
}

export interface PreflightSummary {
  block: number;
  review: number;
  warn: number;
  duplicate: number;
  pass: number;
}

export interface PreflightResponse {
  total_rows: number;
  examined: number;
  skipped: number;
  summary: PreflightSummary;
  total_arr_exposure_blocked: number;
  rows: PreflightResultRow[];
}

const VERDICT_REASONS: Record<PreflightVerdict, string> = {
  block: "active_cs_customer",
  review: "cs_termination_within_cooloff",
  warn: "cs_termination_past_cooloff",
  duplicate: "existing_record_no_cs_overlap",
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
  pass: "No overlap detected. Safe to import.",
};

/**
 * Extract a normalized domain from a row using whichever signal is present
 * (explicit domain first, then domain part of an email).
 */
export function resolveDomain(row: PreflightInputRow): string | null {
  const explicit = (row.domain ?? "").trim().toLowerCase();
  if (explicit) return normalizeDomain(explicit);
  const fromEmail = extractDomain(row.email ?? "");
  return fromEmail ? normalizeDomain(fromEmail) : null;
}

export interface PreflightClusterRow {
  id: number;
  domain: string;
  cs_overlap_verdict: string | null;
  pipeline_lifecycle_state: string | null;
  client_sector: string | null;
  arr_exposure: string | number | null;
  owners_involved?: unknown;
  total_leads?: number;
  total_deals?: number;
  total_contacts?: number;
  total_accounts?: number;
}

/**
 * Pure classifier — given a batch of input rows AND a pre-fetched map of
 * clusters keyed by normalized domain, produce the full preflight response.
 * Extracted from runPreflight so unit tests can exercise it without DB mocks.
 */
export function classifyPreflightRows(input: {
  rows: PreflightInputRow[];
  clustersByDomain: Map<string, PreflightClusterRow>;
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
    pass: 0,
  };
  const out: PreflightResultRow[] = [];
  let arrBlocked = 0;

  for (let i = 0; i < examineCount; i++) {
    const row = rows[i]!;
    const ref = row.ref ?? null;
    const domain = resolveDomain(row);

    if (!domain) {
      out.push({
        row_index: i,
        ref,
        input: { domain: null, company_name: row.company_name ?? null },
        verdict: "pass",
        cluster_id: null,
        lifecycle_state: null,
        sector: null,
        arr_exposure: null,
        owners: [],
        reason: "no_domain_resolved",
        suggested_action: SUGGESTED_ACTIONS.pass,
      });
      summary.pass++;
      continue;
    }

    const c = input.clustersByDomain.get(domain);
    if (!c) {
      out.push({
        row_index: i,
        ref,
        input: { domain, company_name: row.company_name ?? null },
        verdict: "pass",
        cluster_id: null,
        lifecycle_state: null,
        sector: null,
        arr_exposure: null,
        owners: [],
        reason: VERDICT_REASONS.pass,
        suggested_action: SUGGESTED_ACTIONS.pass,
      });
      summary.pass++;
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

    summary[verdict]++;
    out.push({
      row_index: i,
      ref,
      input: { domain, company_name: row.company_name ?? null },
      verdict,
      cluster_id: c.id,
      lifecycle_state:
        (c.pipeline_lifecycle_state as PreflightResultRow["lifecycle_state"]) ??
        null,
      sector: (c.client_sector as PreflightResultRow["sector"]) ?? null,
      arr_exposure: arr,
      owners: extractOwners(c.owners_involved),
      reason: VERDICT_REASONS[verdict],
      suggested_action: SUGGESTED_ACTIONS[verdict],
    });
  }

  return {
    total_rows: rows.length,
    examined: examineCount,
    skipped,
    summary,
    total_arr_exposure_blocked: arrBlocked,
    rows: out,
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
export async function runPreflight(input: {
  rows: PreflightInputRow[];
  max_check?: number;
}): Promise<PreflightResponse> {
  const cap = Math.max(1, Math.min(input.max_check ?? 5000, 10000));
  const rows = input.rows ?? [];
  const examineCount = Math.min(rows.length, cap);

  const domainSet = new Set<string>();
  for (let i = 0; i < examineCount; i++) {
    const d = resolveDomain(rows[i]!);
    if (d) domainSet.add(d);
  }

  const clustersByDomain = new Map<string, PreflightClusterRow>();
  if (domainSet.size > 0) {
    const q = await pool.query<PreflightClusterRow>(
      `SELECT id, domain,
              cs_overlap_verdict,
              pipeline_lifecycle_state,
              client_sector,
              arr_exposure,
              owners_involved,
              total_leads, total_deals, total_contacts, total_accounts
         FROM duplicate_clusters
        WHERE domain = ANY($1::text[])
          AND status = 'active'`,
      [Array.from(domainSet)],
    );
    for (const row of q.rows) {
      const existing = clustersByDomain.get(row.domain);
      if (
        !existing ||
        severity(row.cs_overlap_verdict) > severity(existing.cs_overlap_verdict)
      ) {
        clustersByDomain.set(row.domain, row);
      }
    }
  }

  return classifyPreflightRows({
    rows,
    clustersByDomain,
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
