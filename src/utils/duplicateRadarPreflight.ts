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
} from "./duplicateRadarDatabase";

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
   *   "phone"        — normalized phone hit a duplicate_records row
   *   "company_name" — normalized company name fuzzy-matched a cluster
   *   null           — no match (PASS rows) or no fallback path
   */
  matched_via: "domain" | "phone" | "company_name" | null;
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
}

export interface PreflightSummary {
  block: number;
  review: number;
  warn: number;
  duplicate: number;
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
}): { text: string; severity: PreflightResultRow["executive_severity"] } {
  const ownerStr =
    Array.isArray(input.owners) && input.owners.length > 0
      ? input.owners.slice(0, 2).join(", ") +
        (input.owners.length > 2 ? ` +${input.owners.length - 2}` : "")
      : null;
  const ownerSuffix = ownerStr ? ` (current owner: ${ownerStr})` : "";

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
      text: `Existing customer ${phase} — DO NOT pursue. Route to Customer Success${ownerSuffix}.`,
      severity: "critical",
    };
  }
  if (input.verdict === "review") {
    return {
      text: `Recent CS termination — within churn cool-off window (${
        input.sector === "government" ? "365" : "180"
      } days). Coordinate with CS before contacting${ownerSuffix}.`,
      severity: "high",
    };
  }
  if (input.verdict === "warn") {
    return {
      text: `Past CS cool-off — Sales may re-engage, but notify CS owner first${ownerSuffix}.`,
      severity: "medium",
    };
  }
  if (input.verdict === "duplicate") {
    const recs = input.module_counts?.total || 0;
    const dealsN = input.module_counts?.deals || 0;
    const hasOpenDeal = dealsN > 0;
    if (hasOpenDeal) {
      return {
        text: `Active deal already in pipeline (${dealsN} deal${dealsN === 1 ? "" : "s"}, ${recs} total record${recs === 1 ? "" : "s"}). Assign to existing owner${ownerSuffix.replace("current ", "")}; do NOT create a new lead.`,
        severity: "high",
      };
    }
    return {
      text: `Already in CRM as a duplicate (${recs} record${recs === 1 ? "" : "s"}). Resolve in Duplicate Radar before importing${ownerSuffix}.`,
      severity: "medium",
    };
  }
  return { text: "Safe to import.", severity: "info" };
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
 * Normalized company name (≥5 chars) for the fuzzy-match fallback path.
 * Below 5 chars the trigram similarity threshold collapses to noise.
 */
export function resolveCompany(row: PreflightInputRow): string | null {
  const raw = (row.company_name ?? "").trim();
  if (!raw) return null;
  const normalized = normalizeCompanyName(raw);
  return normalized && normalized.length >= 5 ? normalized : null;
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
 * How the cluster for a single row was found. Drives the matched_via
 * field on the result row + lets the classifier stay pure (no DB).
 */
export interface PreflightRowMatch {
  cluster: PreflightClusterRow;
  matched_via: "domain" | "phone" | "company_name";
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

    if (!matched) {
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
        reason: domain ? VERDICT_REASONS.pass : "no_domain_resolved",
        suggested_action: SUGGESTED_ACTIONS.pass,
        executive_action: "Safe to import.",
        executive_severity: "info",
        module_counts: null,
        matched_via: null,
      });
      summary.pass++;
      continue;
    }
    const c = matched.cluster;

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
    const leadsN    = _n(c.total_leads);
    const dealsN    = _n(c.total_deals);
    const contactsN = _n(c.total_contacts);
    const accountsN = _n(c.total_accounts);

    summary[verdict]++;
    // Reason — for non-domain matches, prefix so the operator knows
    // WHY this row hit a cluster (phone match vs company-name match
    // vs the obvious domain match).
    const matchedViaPrefix =
      matched.matched_via === "phone"
        ? "phone_match__"
        : matched.matched_via === "company_name"
          ? "company_fuzzy_match__"
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
    const execAction = buildExecutiveAction({
      verdict,
      lifecycle_state: lifecycle,
      module_counts: moduleCounts,
      owners,
      arr_exposure: arr,
      sector: sectorVal,
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
      label = (r.module_counts?.deals || 0) > 0
        ? "Active deal already in pipeline — assign to existing owner"
        : "Duplicate already in CRM — resolve before importing";
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
): Promise<{ rows: T[] } | null> {
  const client = await (pool as any).connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SET LOCAL statement_timeout = ${PREFLIGHT_QUERY_TIMEOUT_MS}`,
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
  const clustersByDomain = new Map<string, PreflightClusterRow>();
  if (domainSet.size > 0) {
    const q = await queryWithTimeout<PreflightClusterRow>(
      `SELECT ${CLUSTER_SELECT_COLS}
         FROM duplicate_clusters
        WHERE domain = ANY($1::text[])
          AND status = 'active'`,
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

  // PATH 2 — Batch lookup by phone for the rows that didn't hit on domain.
  // Joins through duplicate_records → duplicate_clusters because the phone
  // lives on the record row, not the cluster row.
  const phonesNeeded = new Set<string>();
  for (const [i, p] of phoneByRow) {
    const d = domainByRow.get(i);
    if (d && clustersByDomain.has(d)) continue;
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
          AND dc.status = 'active'
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
            WHERE status = 'active'
              AND company_name_normalized IS NOT NULL
              AND company_name_normalized != ''
              AND company_name_normalized % v.name
            ORDER BY similarity(company_name_normalized, v.name) DESC
            LIMIT 1
         ) dc ON true
        WHERE dc.id IS NOT NULL`,
      [names],
      [`SELECT set_limit(0.6)`],
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
              WHERE status = 'active'
                AND company_name_normalized IS NOT NULL
                AND company_name_normalized != ''
                AND similarity(company_name_normalized, $1) >= 0.6
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

  // Build the per-row match map by walking the fallback chain in priority
  // order: domain → phone → company.
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
