import { createRedactedPool } from "./redactedPool";
import { logger } from "./logger";
import { normalizeSslMode } from "./normalizeDatabaseUrl";
// Arabic-aware name normalizer (planner only type-imports this file, so this
// runtime import creates no cycle).
import { normalizePersonName } from "./duplicateMergePlanner";

// Normalize sslmode directly on the connection string (module-scope pool —
// see src/utils/normalizeDatabaseUrl.ts for why env-var ordering is unreliable
// in the production bundle). Idempotent.
const pool = createRedactedPool({
  connectionString: normalizeSslMode(process.env.DATABASE_URL),
});

export interface DuplicateCluster {
  id?: number;
  domain: string;
  company_name?: string;
  company_name_arabic?: string;
  company_name_normalized?: string;
  total_leads: number;
  total_deals: number;
  total_contacts: number;
  total_accounts: number;
  total_records: number;
  confidence_level: "high" | "medium" | "low";
  confidence_score: number;
  match_signals?: string[];
  first_record_date?: Date;
  latest_activity_date?: Date;
  owners_involved?: string[];
  estimated_pipeline_value?: number;
  status: "active" | "resolved" | "ignored";
  ai_recommendation?: string;
  resolved_by?: string;
  resolved_at?: Date;
  /** CS-pipeline-overlap verdict: block (active customer), review (within churn cool-off), warn (past cool-off, sales may re-engage), null (no overlap). */
  cs_overlap_verdict?: "block" | "review" | "warn" | null;
  /** Aggregated ARR exposure across the CS-pipeline deals in this cluster. */
  arr_exposure?: number;
  /** Strongest active CS phase observed in the cluster (onboarding > adoption > renewal > termination_recent > termination_old). */
  pipeline_lifecycle_state?:
    | "onboarding"
    | "adoption"
    | "renewal"
    | "termination_recent"
    | "termination_old"
    | null;
  /** Client sector derived from gov_type field or domain heuristic ("private" | "government"). */
  client_sector?: "private" | "government" | null;
  /** R3: post-merge Zoho verification outcome — 'verified' (records confirmed gone), 'failed' (records still in Zoho), or null (never verified). */
  verification_state?: "verified" | "failed" | "pending" | null;
  verification_at?: Date | null;
  verification_notes?: string | null;
  created_at?: Date;
  updated_at?: Date;
}

export interface DuplicateRecord {
  id?: number;
  cluster_id: number;
  record_type: "lead" | "deal" | "contact" | "account";
  zoho_record_id?: string;
  record_name: string;
  company_name?: string;
  email?: string;
  domain?: string;
  phone?: string;
  phone_normalized?: string;
  mobile?: string;
  mobile_normalized?: string;
  owner_name?: string;
  owner_email?: string;
  status?: string;
  stage?: string;
  deal_value?: number;
  source?: string;
  created_date?: Date;
  modified_date?: Date;
  is_primary: boolean;
  ai_recommendation?: string;
  confidence_score: number;
  match_signals?: string[];
  is_mock_data: boolean;
  raw_data?: any;
  layout_name?: string;
  layout_id?: string;
  zoho_module?: string;
  pipeline?: string;
  products?: string;
  contact_name?: string;
  account_name?: string;
  cr_number?: string;
  vat_number?: string;
  website?: string;
  country?: string;
  region?: string;
  industry?: string;
  no_of_employees?: number;
  title?: string;
  lead_type?: string;
  gov_type?: string;
  account_type?: string;
  created_at?: Date;
}

export interface ZohoSyncState {
  module: string;
  last_sync_at?: Date;
  total_synced: number;
  sync_status: "idle" | "syncing" | "completed" | "failed";
}

export interface DuplicateRecordTask {
  id?: number;
  zoho_task_id: string;
  related_record_id?: string;
  cluster_id?: number;
  subject?: string;
  due_date?: Date;
  status?: string;
  owner_name?: string;
  description?: string;
  created_at?: Date;
}

export interface DuplicateFilters {
  modules?: string[];
  owners?: string[];
  layouts?: string[];
  pipelines?: string[];
  stages?: string[];
  domain?: string;
  start_date?: string;
  end_date?: string;
  status?: string;
  confidence_level?: string;
  /**
   * Marketplace / Corporate segmentation. UI exposes this as a 3-way chip
   * + matching dropdown in Advanced Filters. Server maps it to layout_name:
   *   "marketplace" → layout CONTAINS 'marketplace' or 'partner account'
   *                    (e.g. "Doam Marketplace"), read from layout_name with a
   *                    raw_data Layout fallback
   *   "corporate"   → NOT marketplace (incl. NULL/empty = treat as corporate)
   *   "all" / undef → no constraint (current behavior)
   * Both segments stay actionable inside the radar — this is for comparison,
   * not for hiding records.
   */
  segment?: "all" | "marketplace" | "corporate" | "walaplus" | "walaone";
}

/**
 * Returns the SQL predicate (no leading AND), the parameter values, and
 * whether the predicate references the `duplicate_records r` alias (so
 * callers know they need to add the record-table JOIN). `paramOffset` is
 * the next $N number to use — caller advances its own paramIdx by the
 * length of the returned params array.
 *
 * "marketplace" matches Zoho layouts the team treats as merchant /
 *   marketplace (currently "Marketplace" and "Partner Accounts" —
 *   matches the existing exclusion logic in cross-module / preflight).
 * "corporate" is the complement, defaulting NULL/empty to corporate so
 *   legacy records without an explicit layout aren't lost to the filter.
 */
export function buildSegmentPredicate(
  segment: DuplicateFilters["segment"],
  paramOffset: number,
): { condition: string | null; params: string[]; needsRecordJoin: boolean } {
  if (!segment || segment === "all") {
    return { condition: null, params: [], needsRecordJoin: false };
  }
  // Marketplace layouts are matched by SUBSTRING, not exact name (Sarah
  // 2026-07-15): the real Zoho layouts are "Doam Marketplace", "Marketplace",
  // "Partner Accounts", etc. — an exact `IN ('marketplace','partner accounts')`
  // let "Doam Marketplace" fall through into WalaPlus. Match any layout that
  // CONTAINS "marketplace" (normalized) or "partneraccounts". Patterns compare
  // against NORM (below), which is already lowercased + alphanumeric-only.
  const markers = ["%marketplace%", "%partneraccounts%"];
  // Layout source (Sarah 2026-07-14): a Marketplace-layout deal was leaking into
  // the WalaPlus segment because its `layout_name` COLUMN was blank — and blank
  // layouts default into WalaPlus. Fall back to the synced raw_data Layout (Zoho
  // returns Layout as {id,name} under `Layout` and/or the system `$layout`; some
  // records only carry the plain string) so a record whose column wasn't
  // populated STILL segments by its true layout instead of defaulting to WalaPlus.
  const LAYOUT =
    "LOWER(COALESCE(NULLIF(r.layout_name,''), r.raw_data#>>'{Layout,name}', r.raw_data#>>'{$layout,name}', r.raw_data->>'Layout', ''))";
  // Normalized layout (non-alphanumeric stripped) so "WalaOne" / "Wala One" /
  // "wala-one" all match 'walaone' and "Doam Marketplace" matches '%marketplace%'.
  const NORM = `regexp_replace(${LAYOUT}, '[^a-z0-9]', '', 'g')`;
  const mktMatch = (offset: number) =>
    markers.map((_, i) => `${NORM} LIKE $${offset + i}`).join(" OR ");
  if (segment === "marketplace") {
    return {
      condition: `(${mktMatch(paramOffset)})`,
      params: markers,
      needsRecordJoin: true,
    };
  }
  if (segment === "walaone") {
    // WalaOne product — layout CONTAINS "walaone" (substring, so "WalaOne",
    // "Wala One", "WalaOne Corporate" all match). No bind params (literal).
    return {
      condition: `${NORM} LIKE '%walaone%'`,
      params: [],
      needsRecordJoin: true,
    };
  }
  // "walaplus" (renamed "corporate") + legacy "corporate" = NOT marketplace AND
  // NOT WalaOne. NULL/empty layout defaults here so legacy records aren't lost.
  return {
    condition: `NOT (${mktMatch(paramOffset)}) AND ${NORM} NOT LIKE '%walaone%'`,
    params: markers,
    needsRecordJoin: true,
  };
}

/**
 * The JS mirror of `buildSegmentPredicate`'s layout semantics, for filtering an
 * already-fetched array of records (e.g. the cluster preview modal) by segment
 * WITHOUT another query. Reads the record's layout from `layout_name` with the
 * same raw_data Layout fallback, normalizes it (lowercase, alphanumeric-only),
 * and classifies: contains "marketplace"/"partneraccounts" → marketplace;
 * contains "walaone" → walaone; else → walaplus (the corporate default, incl.
 * blank layout). Keep in lockstep with buildSegmentPredicate.
 */
export function readRecordLayout(rec: any): string {
  const r = rec || {};
  const raw = (r.raw_data as any) || {};
  const col = r.layout_name != null ? String(r.layout_name).trim() : "";
  if (col) return col;
  if (raw.Layout && typeof raw.Layout === "object" && raw.Layout.name)
    return String(raw.Layout.name);
  if (raw.$layout && typeof raw.$layout === "object" && raw.$layout.name)
    return String(raw.$layout.name);
  if (typeof raw.Layout === "string") return raw.Layout;
  return "";
}
export function classifyLayoutSegment(
  layoutRaw: string | null | undefined,
): "marketplace" | "walaone" | "walaplus" {
  const norm = String(layoutRaw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  if (norm.includes("marketplace") || norm.includes("partneraccounts"))
    return "marketplace";
  if (norm.includes("walaone")) return "walaone";
  return "walaplus";
}
export function recordMatchesSegment(
  rec: any,
  segment: string | null | undefined,
): boolean {
  if (!segment || segment === "all") return true;
  const seg = classifyLayoutSegment(readRecordLayout(rec));
  // "corporate" is the legacy alias for "walaplus".
  if (segment === "corporate") return seg === "walaplus";
  return seg === segment;
}

export interface MergeAction {
  id?: number;
  cluster_id: number;
  primary_record_id: number;
  merged_record_ids: number[];
  /**
   * Five action types observed in the wild — keep this union in sync with
   * every callsite that writes to duplicate_merge_actions:
   *   "resolve"          — operator Mark Resolved OR successful merge Apply
   *                        (resolveCluster, executeMergePlan single-module path)
   *   "ignore"           — operator Mark Dismissed (false-positive)
   *   "module_resolved"  — partial-apply on a cross-module cluster: one module
   *                        merged, others still open (executeMergePlan
   *                        cross-module path, via recordPartialMergeAction)
   *   "split"            — bulk-split contacts cleanup (carved a cluster into
   *                        ≥2 strict sub-clusters)
   *   "merge"            — legacy; reserved for back-compat
   */
  action_type: "merge" | "resolve" | "ignore" | "module_resolved" | "split";
  performed_by?: string;
  notes?: string;
  created_at?: Date;
}

/** Enriched merge action: MergeAction + the cluster's domain / company name
 *  + the action_type's human-readable label. Powers the Logs tab UI + Adam's
 *  manualActionAuditTool. */
export interface MergeActionEnriched extends MergeAction {
  cluster_domain: string | null;
  cluster_company_name: string | null;
  cluster_status: string | null;
}

export interface OwnerAccountability {
  owner_name: string;
  owner_email: string;
  // Team / role badge sourced from SEED_USERS so coaching reports can group
  // owners by squad ("MP", "WO Sales", "CS", "MGMT", etc.). "Unassigned" when
  // the owner name doesn't match a known seed user.
  team: string;
  total_records: number;
  duplicate_records: number;
  duplicate_rate: number;
  clusters_involved: number;
  high_confidence_duplicates: number;
  estimated_waste_value: number;
  rag_status: "green" | "amber" | "red";
}

export interface DuplicateDetectionLog {
  id?: number;
  detection_type: "manual" | "scheduled" | "on_demand" | "interval-fallback";
  total_records_scanned: number;
  total_clusters_found: number;
  total_duplicates_detected: number;
  high_confidence_count: number;
  medium_confidence_count: number;
  low_confidence_count: number;
  estimated_pipeline_inflation?: number;
  detection_duration_ms?: number;
  triggered_by?: string;
  user_email?: string;
  status: "running" | "completed" | "failed";
  error_message?: string;
  detection_config?: any;
  created_at?: Date;
  completed_at?: Date;
}

export interface DuplicateExportLog {
  id?: number;
  export_type: "cluster" | "owner" | "time_period" | "all";
  filter_criteria?: any;
  total_records_exported: number;
  file_format: "excel" | "csv" | "xlsx";
  exported_by?: string;
  user_email?: string;
  created_at?: Date;
}

const PUBLIC_DOMAINS = [
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "ymail.com",
  "rocketmail.com",
  "hotmail.com",
  "hotmail.co.uk",
  "outlook.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "live.com",
  "msn.com",
  "mail.com",
  "protonmail.com",
  "proton.me",
  "yandex.com",
  "zoho.com",
  "gmx.com",
  "gmx.net",
  "fastmail.com",
  "qq.com",
  "163.com",
  "126.com",
  "stc.com.sa",
  "mobily.com.sa",
  "zain.com.sa",
  // House / internal domains — WalaPlus's OWN domains. Records that picked these
  // up (created via internal forms, or carrying the company email/website
  // instead of the client's) are NOT the same company. Without excluding them,
  // every such record collapses into one giant false "walaplus.com" cluster.
  // Treated like a public domain → not a clustering signal. Add more house/ISP
  // domains via the DUPLICATE_EXCLUDED_DOMAINS env (comma-separated).
  "walaplus.com",
  "walaplus.net",
  ...(process.env.DUPLICATE_EXCLUDED_DOMAINS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
];

// Full list (no LIMIT 5) for "View All" modals on the dashboard.
// Defaults to active clusters only so resolved/ignored false-positives are excluded;
// pass includeInactive=true to see all clusters regardless of status.
export async function getAllClustersByInflation(
  opts: { limit?: number; offset?: number; includeInactive?: boolean } = {},
): Promise<any[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 2000));
  const offset = Math.max(0, opts.offset ?? 0);
  const statusClause = opts.includeInactive ? "" : `AND status = 'active'`;
  const r = await pool.query(
    `SELECT id, domain, company_name, company_name_arabic,
            estimated_pipeline_value, total_records,
            total_leads, total_deals, total_contacts, total_accounts,
            confidence_score, confidence_level, status,
            cs_overlap_verdict, arr_exposure, pipeline_lifecycle_state, client_sector
       FROM duplicate_clusters
      WHERE estimated_pipeline_value > 0
        AND total_records > 1
        ${statusClause}
      ORDER BY estimated_pipeline_value DESC, total_records DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return r.rows;
}

// All clusters that include a given match signal (e.g. exact_email, phone_match).
// Same active-by-default behavior as getAllClustersByInflation.
export async function getClustersBySignal(
  signal: string,
  opts: { limit?: number; offset?: number; includeInactive?: boolean } = {},
): Promise<any[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 2000));
  const offset = Math.max(0, opts.offset ?? 0);
  const statusClause = opts.includeInactive ? "" : `AND status = 'active'`;
  const r = await pool.query(
    `SELECT id, domain, company_name, company_name_arabic,
            estimated_pipeline_value, total_records,
            total_leads, total_deals, total_contacts, total_accounts,
            confidence_score, confidence_level, status, match_signals,
            cs_overlap_verdict, arr_exposure, pipeline_lifecycle_state, client_sector
       FROM duplicate_clusters
      WHERE total_records > 1
        AND match_signals @> to_jsonb(ARRAY[$1::text])
        ${statusClause}
      ORDER BY confidence_score DESC, total_records DESC
      LIMIT $2 OFFSET $3`,
    [signal, limit, offset],
  );
  return r.rows;
}

// Free-text search across clusters by company name (EN/AR/normalized) or
// domain — powers the "show me everything on <X>" entity lookup so Adam can
// flag that a looked-up company also has open duplicate clusters. Active
// clusters with >1 record only; capped.
export async function searchClustersByText(
  query: string,
  limit = 10,
): Promise<any[]> {
  const q = (query || "").trim();
  if (!q) return [];
  const like = `%${q}%`;
  const cap = Math.max(1, Math.min(limit, 50));
  const r = await pool.query(
    `SELECT id, domain, company_name, company_name_arabic,
            estimated_pipeline_value, total_records,
            total_leads, total_deals, total_contacts, total_accounts,
            confidence_score, confidence_level, status,
            cs_overlap_verdict, pipeline_lifecycle_state, client_sector
       FROM duplicate_clusters
      WHERE total_records > 1
        AND status = 'active'
        AND (
          company_name ILIKE $1
          OR company_name_arabic ILIKE $1
          OR company_name_normalized ILIKE $1
          OR domain ILIKE $1
        )
      ORDER BY estimated_pipeline_value DESC NULLS LAST, total_records DESC
      LIMIT $2`,
    [like, cap],
  );
  return r.rows;
}

// ── Deal-Compliance document-scan persistence ─────────────────────────────
export interface DealDocComplianceRow {
  zoho_deal_id: string;
  stage: string | null;
  compliant: boolean;
  present_docs: string[];
  missing_docs: string[];
  attachment_count: number;
  checked_at: string;
  checked_by: string | null;
}

/** Upsert the latest doc-compliance result for a deal (one row per deal). */
export async function upsertDealDocCompliance(rec: {
  zohoDealId: string;
  stage?: string | null;
  compliant: boolean;
  presentDocs: string[];
  missingDocs: string[];
  attachmentCount: number;
  checkedBy?: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO deal_doc_compliance
       (zoho_deal_id, stage, compliant, present_docs, missing_docs, attachment_count, checked_at, checked_by)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, NOW(), $7)
     ON CONFLICT (zoho_deal_id) DO UPDATE SET
       stage = EXCLUDED.stage,
       compliant = EXCLUDED.compliant,
       present_docs = EXCLUDED.present_docs,
       missing_docs = EXCLUDED.missing_docs,
       attachment_count = EXCLUDED.attachment_count,
       checked_at = NOW(),
       checked_by = EXCLUDED.checked_by`,
    [
      rec.zohoDealId,
      rec.stage || null,
      !!rec.compliant,
      JSON.stringify(rec.presentDocs || []),
      JSON.stringify(rec.missingDocs || []),
      Number(rec.attachmentCount) || 0,
      rec.checkedBy || null,
    ],
  );
}

/** Fetch stored doc-compliance results. Optionally filtered to specific deal
 *  ids (the visible page); capped to keep payloads sane. */
export async function getDealDocCompliance(
  ids?: string[],
): Promise<DealDocComplianceRow[]> {
  if (ids && ids.length) {
    const r = await pool.query(
      `SELECT zoho_deal_id, stage, compliant, present_docs, missing_docs,
              attachment_count, checked_at, checked_by
         FROM deal_doc_compliance
        WHERE zoho_deal_id = ANY($1::text[])`,
      [ids],
    );
    return r.rows;
  }
  const r = await pool.query(
    `SELECT zoho_deal_id, stage, compliant, present_docs, missing_docs,
            attachment_count, checked_at, checked_by
       FROM deal_doc_compliance
      ORDER BY checked_at DESC
      LIMIT 5000`,
  );
  return r.rows;
}

// ── Weekly executive-brief snapshots (for week-over-week trend) ───────────
export interface ExecBriefSnapshot {
  total_clusters: number;
  resolved_count: number;
  active_count: number;
  exposure: number;
  dup_rate: number | null;
  metrics_json: any;
  created_at: string;
}

export async function recordExecBriefSnapshot(s: {
  totalClusters: number;
  resolvedCount: number;
  activeCount: number;
  exposure: number;
  dupRate: number | null;
  metricsJson?: any;
}): Promise<void> {
  await pool.query(
    `INSERT INTO exec_brief_snapshots
       (total_clusters, resolved_count, active_count, exposure, dup_rate, metrics_json)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      s.totalClusters || 0,
      s.resolvedCount || 0,
      s.activeCount || 0,
      s.exposure || 0,
      s.dupRate == null ? null : s.dupRate,
      JSON.stringify(s.metricsJson || {}),
    ],
  );
}

/** Most recent snapshot (the prior week's), for computing the delta. */
export async function getPreviousExecBriefSnapshot(): Promise<ExecBriefSnapshot | null> {
  const r = await pool.query(
    `SELECT total_clusters, resolved_count, active_count, exposure, dup_rate, metrics_json, created_at
       FROM exec_brief_snapshots
      ORDER BY created_at DESC
      LIMIT 1`,
  );
  return r.rows[0] || null;
}

export function extractDomain(email: string): string | null {
  if (!email || typeof email !== "string") return null;
  const match = email
    .toLowerCase()
    .trim()
    .match(/@([^@]+)$/);
  if (!match) return null;
  let domain = match[1].replace(/^www\./, "").trim();
  if (PUBLIC_DOMAINS.includes(domain)) return null;
  return domain;
}

export function normalizeDomain(domain: string): string {
  if (!domain) return "";
  return domain
    .toLowerCase()
    .replace(/^www\./, "")
    .trim();
}

export function calculateSimilarity(str1: string, str2: string): number {
  if (!str1 || !str2) return 0;
  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();
  if (s1 === s2) return 100;

  const longer = s1.length > s2.length ? s1 : s2;

  if (longer.length === 0) return 100;

  const editDistance = levenshteinDistance(s1, s2);
  return Math.round((1 - editDistance / longer.length) * 100);
}

function levenshteinDistance(s1: string, s2: string): number {
  const m = s1.length;
  const n = s2.length;
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]) + 1;
      }
    }
  }
  return dp[m][n];
}

export function getConfidenceLevel(score: number): "high" | "medium" | "low" {
  if (score >= 90) return "high";
  if (score >= 60) return "medium";
  return "low";
}

export function normalizePhone(phone: string): string {
  if (!phone) return "";
  return phone
    .replace(/[\s\-\(\)\+\.]/g, "")
    .replace(/^00/, "")
    .replace(/^966/, "")
    .slice(-9);
}

export interface MatchResult {
  score: number;
  signals: string[];
}

/**
 * Multi-signal duplicate match scoring.
 *
 * Weights are calibrated for B2B Saudi data (gov + private sector). In observed
 * real-world data (see `docs/duplicate-radar-cs-overlap.md`), ~100% of true
 * duplicates share the same domain while only ~12% share email — so domain
 * carries more weight than email here. PUBLIC_DOMAINS callers should still
 * suppress the domain signal when both records are personal-email accounts.
 *
 * Override profile by env if a different shape is needed:
 *   DUPLICATE_RADAR_SCORING_PROFILE=b2b   (default, current weights)
 *   DUPLICATE_RADAR_SCORING_PROFILE=email_first  (legacy: email=40, domain=25)
 */
export function calculateMultiSignalScore(
  record1: {
    email?: string;
    domain?: string;
    phone?: string;
    company_name?: string;
  },
  record2: {
    email?: string;
    domain?: string;
    phone?: string;
    company_name?: string;
  },
): MatchResult {
  const profile =
    process.env.DUPLICATE_RADAR_SCORING_PROFILE === "email_first"
      ? "email_first"
      : "b2b";
  const weights =
    profile === "email_first"
      ? { email: 40, domain: 25, phone: 30, companyExact: 20, companyFuzzy: 10 }
      : { email: 30, domain: 50, phone: 30, companyExact: 20, companyFuzzy: 10 };

  const signals: string[] = [];
  let score = 0;

  if (
    record1.email &&
    record2.email &&
    record1.email.toLowerCase() === record2.email.toLowerCase()
  ) {
    score += weights.email;
    signals.push("exact_email");
  }

  if (record1.domain && record2.domain && record1.domain === record2.domain) {
    score += weights.domain;
    signals.push("domain_match");
  }

  if (record1.phone && record2.phone) {
    const p1 = normalizePhone(record1.phone);
    const p2 = normalizePhone(record2.phone);
    if (p1 && p2 && p1.length >= 7 && p1 === p2) {
      score += weights.phone;
      signals.push("phone_match");
    }
  }

  if (record1.company_name && record2.company_name) {
    const similarity = calculateSimilarity(
      normalizeCompanyName(record1.company_name),
      normalizeCompanyName(record2.company_name),
    );
    if (similarity >= 90) {
      score += weights.companyExact;
      signals.push("company_exact");
    } else if (similarity >= 75) {
      score += weights.companyFuzzy;
      signals.push("company_fuzzy");
    }
  }

  return { score: Math.min(score, 100), signals };
}

// Memoization handle for initDuplicateRadarTables.
//
// 6 route handlers in duplicateRadarRoutes.ts call this at the top of
// every request (recalculate-stats, account-hints/scan, packet, kpis,
// preflight, the lifecycle endpoints…). The init body executes ~30
// CREATE TABLE / ALTER TABLE / CREATE INDEX statements plus an optional
// pg_trgm extension install. They're idempotent (IF NOT EXISTS) but on
// a cold Replit container the first run takes 5–15s, and 6 endpoints
// firing in parallel from /duplicates' refreshData all race for the
// same work. Same cold-start failure mode as initCallIntelligenceTables
// before its memoization landed (see that file for the playbook).
//
// Fix: run the schema body exactly once per process lifetime. Subsequent
// calls await the cached promise (cheap) and return as soon as the
// first call finishes. Cached promise is cleared on failure so a
// transient connection blip doesn't pin the cache forever.
let _ddrInitPromise: Promise<void> | null = null;
let _ddrInitDone = false;

export async function initDuplicateRadarTables(): Promise<void> {
  if (_ddrInitDone) return;
  if (_ddrInitPromise) return _ddrInitPromise;
  _ddrInitPromise = (async () => {
    const startedAt = Date.now();
    try {
      await _doInitDuplicateRadarTables();
      _ddrInitDone = true;
      const ms = Date.now() - startedAt;
      // Loud above 2s so an operator tailing logs can spot a legitimate
      // cold start vs a recurring slow path (which would mean the
      // memoization broke).
      if (ms > 2000) {
        logger.warn(
          `[duplicateRadarDatabase] initDuplicateRadarTables took ${ms}ms (cold start)`,
        );
      } else {
        logger.info(
          `[duplicateRadarDatabase] initDuplicateRadarTables completed in ${ms}ms`,
        );
      }
    } catch (err) {
      _ddrInitPromise = null;
      throw err;
    }
  })();
  return _ddrInitPromise;
}

async function _doInitDuplicateRadarTables(): Promise<void> {
  // Agentic-resolution learning store — created at BOOT (here) so it exists in
  // both dev and prod. If it were only created lazily on first use, the dev↔prod
  // schema diff at deploy time keeps proposing to DROP it from prod. DDL mirrors
  // ensureTable() in duplicateResolutionLearning.ts (which stays as a runtime
  // safety net). Keep the two in sync.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS duplicate_resolution_feedback (
      id SERIAL PRIMARY KEY,
      cluster_id INTEGER,
      event_type VARCHAR(32) NOT NULL,
      proposed_master_zoho_id VARCHAR(100),
      chosen_master_zoho_id VARCHAR(100),
      master_overridden BOOLEAN DEFAULT FALSE,
      fields_migrated INTEGER DEFAULT 0,
      duplicates_tagged INTEGER DEFAULT 0,
      reparented INTEGER DEFAULT 0,
      errors INTEGER DEFAULT 0,
      plan_json JSONB,
      report_json JSONB,
      performed_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_dup_res_feedback_cluster ON duplicate_resolution_feedback(cluster_id);`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_dup_res_feedback_created ON duplicate_resolution_feedback(created_at DESC);`,
  );

  // Autonomous-resolution learning RULES (mirrors ensureResolutionRulesTable in
  // duplicateResolutionRules.ts) — boot-created so dev & prod match.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS duplicate_resolution_rules (
      id SERIAL PRIMARY KEY,
      module VARCHAR(32) NOT NULL,
      case_signature JSONB NOT NULL,
      decision VARCHAR(32) NOT NULL,
      scope VARCHAR(16) NOT NULL DEFAULT 'pattern',
      cluster_id INTEGER,
      created_by VARCHAR(255),
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      usage_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      last_used_at TIMESTAMP
    );
  `);
  await pool
    .query(
      `CREATE INDEX IF NOT EXISTS idx_dup_res_rules_module ON duplicate_resolution_rules(module) WHERE enabled = TRUE;`,
    )
    .catch(() => {});

  // Autonomous-resolution competence GRADE LOG (mirrors ensureGradeLogTable in
  // duplicateResolutionGrades.ts) — boot-created so dev & prod match.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS duplicate_resolution_grade_log (
      id SERIAL PRIMARY KEY,
      module VARCHAR(32) NOT NULL,
      grade INTEGER NOT NULL,
      grade_label VARCHAR(48),
      metrics_json JSONB,
      promoted BOOLEAN NOT NULL DEFAULT FALSE,
      note TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool
    .query(
      `CREATE INDEX IF NOT EXISTS idx_dup_res_grade_log_module_time ON duplicate_resolution_grade_log(module, created_at DESC);`,
    )
    .catch(() => {});

  // In-platform autonomous-resolution mode/kill-switch override (single row).
  // Boot-created in BOTH dev & prod so Replit's deploy schema-diff doesn't
  // propose dropping a runtime-created table. See duplicateResolutionRunner.ts.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS autonomous_resolution_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      enabled BOOLEAN,
      mode VARCHAR(16),
      updated_by VARCHAR(255),
      updated_at TIMESTAMP DEFAULT NOW(),
      CONSTRAINT autonomous_resolution_settings_singleton CHECK (id = 1)
    );
  `);

  // Deal-Compliance document-scan results (SOP 7.5.10 attachment checks).
  // One row per Zoho deal, latest scan only — shared across users/devices so
  // the missing-doc scope persists for re-checking and for sending to owners.
  // Boot-created in dev & prod so Replit's schema-diff won't propose dropping it.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deal_doc_compliance (
      zoho_deal_id VARCHAR(64) PRIMARY KEY,
      stage VARCHAR(64),
      compliant BOOLEAN NOT NULL DEFAULT FALSE,
      present_docs JSONB NOT NULL DEFAULT '[]'::jsonb,
      missing_docs JSONB NOT NULL DEFAULT '[]'::jsonb,
      attachment_count INTEGER NOT NULL DEFAULT 0,
      checked_at TIMESTAMP DEFAULT NOW(),
      checked_by VARCHAR(255)
    );
  `);

  // Weekly executive-brief snapshots — one row per weekly leadership digest, so
  // the next digest can report week-over-week trend (clusters cleared, exposure
  // change, duplicate-rate change). Boot-created in dev & prod.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS exec_brief_snapshots (
      id SERIAL PRIMARY KEY,
      total_clusters INTEGER NOT NULL DEFAULT 0,
      resolved_count INTEGER NOT NULL DEFAULT 0,
      active_count INTEGER NOT NULL DEFAULT 0,
      exposure NUMERIC NOT NULL DEFAULT 0,
      dup_rate INTEGER,
      metrics_json JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS duplicate_clusters (
      id SERIAL PRIMARY KEY,
      domain VARCHAR(255) NOT NULL,
      company_name VARCHAR(500),
      company_name_arabic VARCHAR(500),
      company_name_normalized VARCHAR(500),
      total_leads INTEGER DEFAULT 0,
      total_deals INTEGER DEFAULT 0,
      total_contacts INTEGER DEFAULT 0,
      total_accounts INTEGER DEFAULT 0,
      total_records INTEGER DEFAULT 0,
      confidence_level VARCHAR(20) DEFAULT 'medium',
      confidence_score INTEGER DEFAULT 0,
      match_signals JSONB DEFAULT '[]',
      first_record_date TIMESTAMP,
      latest_activity_date TIMESTAMP,
      owners_involved JSONB DEFAULT '[]',
      estimated_pipeline_value DECIMAL(15,2) DEFAULT 0,
      status VARCHAR(50) DEFAULT 'active',
      ai_recommendation TEXT,
      resolved_by VARCHAR(255),
      resolved_at TIMESTAMP,
      cs_overlap_verdict VARCHAR(16),
      arr_exposure DECIMAL(15,2) DEFAULT 0,
      pipeline_lifecycle_state VARCHAR(32),
      client_sector VARCHAR(16),
      verification_state VARCHAR(16),
      verification_at TIMESTAMP,
      verification_notes TEXT,
      cross_module_handled_at TIMESTAMPTZ,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(
    `ALTER TABLE duplicate_clusters ADD COLUMN IF NOT EXISTS total_contacts INTEGER DEFAULT 0`,
  );
  await pool.query(
    `ALTER TABLE duplicate_clusters ADD COLUMN IF NOT EXISTS total_accounts INTEGER DEFAULT 0`,
  );
  await pool.query(
    `ALTER TABLE duplicate_clusters ADD COLUMN IF NOT EXISTS match_signals JSONB DEFAULT '[]'`,
  );
  await pool.query(
    `ALTER TABLE duplicate_clusters ADD COLUMN IF NOT EXISTS resolved_by VARCHAR(255)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_clusters ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP`,
  );
  await pool.query(
    `ALTER TABLE duplicate_clusters ADD COLUMN IF NOT EXISTS company_name_normalized VARCHAR(500)`,
  );

  // CS-pipeline overlap detection (sector-aware) — Phase 1
  await pool.query(
    `ALTER TABLE duplicate_clusters ADD COLUMN IF NOT EXISTS cs_overlap_verdict VARCHAR(16)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_clusters ADD COLUMN IF NOT EXISTS arr_exposure DECIMAL(15,2) DEFAULT 0`,
  );
  await pool.query(
    `ALTER TABLE duplicate_clusters ADD COLUMN IF NOT EXISTS pipeline_lifecycle_state VARCHAR(32)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_clusters ADD COLUMN IF NOT EXISTS client_sector VARCHAR(16)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_clusters_cs_overlap ON duplicate_clusters(cs_overlap_verdict) WHERE cs_overlap_verdict IS NOT NULL`,
  );
  // Cross-Module "Handled" — module-scoped acknowledgement of a cross-module
  // overlap (e.g. Lead<->Account) that must NOT resolve the whole cluster
  // (same-module duplicates, e.g. 2 Leads, must stay visible elsewhere).
  // NULL = still open in the Cross-Module queue; set = handled (reversible).
  await pool.query(
    `ALTER TABLE duplicate_clusters ADD COLUMN IF NOT EXISTS cross_module_handled_at TIMESTAMPTZ`,
  );
  // R3 (quick-wins): post-merge verification state. When an operator clicks
  // "Mark Resolved + Verify" we check that the cluster's non-primary records
  // were actually deleted in Zoho and persist the outcome here so the
  // dashboard can surface a Verified / Failed badge.
  //   verification_state: NULL / 'verified' / 'failed' / 'pending'
  //   verification_at:    when we ran the check
  //   verification_notes: human-readable summary (X confirmed deleted, Y still present)
  await pool.query(
    `ALTER TABLE duplicate_clusters ADD COLUMN IF NOT EXISTS verification_state VARCHAR(16)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_clusters ADD COLUMN IF NOT EXISTS verification_at TIMESTAMP`,
  );
  await pool.query(
    `ALTER TABLE duplicate_clusters ADD COLUMN IF NOT EXISTS verification_notes TEXT`,
  );
  // R10 (medium-term): pre-merge snapshots. Cloudingo's flagship feature is
  // "Undo Merge" — we can't actually undo a Zoho merge (Zoho deletes the
  // record), but we can freeze a JSON copy of the cluster + every record
  // (including raw_data) at the moment "Mark Resolved" is clicked. The
  // forensic trail lets owners audit what was about to be lost if a
  // verification later flags the merge as wrong, or settle a dispute weeks
  // later when memories fade. ON DELETE SET NULL so the snapshot survives
  // even if the cluster row is purged in a cleanup job.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS duplicate_cluster_snapshots (
      id              SERIAL PRIMARY KEY,
      cluster_id      INTEGER REFERENCES duplicate_clusters(id) ON DELETE SET NULL,
      snapshot_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      taken_by        VARCHAR(255),
      trigger         VARCHAR(64) NOT NULL,
      merge_action_id INTEGER,
      record_count    INTEGER NOT NULL DEFAULT 0,
      cluster_snapshot JSONB NOT NULL,
      records_snapshot JSONB NOT NULL,
      notes           TEXT
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_dr_cluster_snapshots_cluster ON duplicate_cluster_snapshots(cluster_id) WHERE cluster_id IS NOT NULL`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_dr_cluster_snapshots_at ON duplicate_cluster_snapshots(snapshot_at DESC)`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS duplicate_records (
      id SERIAL PRIMARY KEY,
      cluster_id INTEGER REFERENCES duplicate_clusters(id) ON DELETE CASCADE,
      record_type VARCHAR(20) NOT NULL,
      zoho_record_id VARCHAR(100),
      record_name VARCHAR(500),
      company_name VARCHAR(500),
      email VARCHAR(255),
      domain VARCHAR(255),
      phone VARCHAR(100),
      phone_normalized VARCHAR(50),
      owner_name VARCHAR(255),
      owner_email VARCHAR(255),
      status VARCHAR(100),
      stage VARCHAR(100),
      deal_value DECIMAL(15,2),
      source VARCHAR(255),
      created_date TIMESTAMP,
      modified_date TIMESTAMP,
      is_primary BOOLEAN DEFAULT FALSE,
      ai_recommendation TEXT,
      confidence_score INTEGER DEFAULT 0,
      match_signals JSONB DEFAULT '[]',
      layout_name VARCHAR(255),
      layout_id VARCHAR(100),
      zoho_module VARCHAR(50),
      pipeline VARCHAR(255),
      products TEXT,
      mobile VARCHAR(100),
      mobile_normalized VARCHAR(50),
      contact_name VARCHAR(255),
      account_name VARCHAR(500),
      cr_number VARCHAR(100),
      vat_number VARCHAR(100),
      website VARCHAR(500),
      country VARCHAR(100),
      region VARCHAR(100),
      industry VARCHAR(255),
      no_of_employees INTEGER,
      title VARCHAR(255),
      lead_type VARCHAR(100),
      gov_type VARCHAR(100),
      account_type VARCHAR(100),
      is_mock_data BOOLEAN DEFAULT FALSE,
      raw_data JSONB,
      cleanup_class TEXT,
      last_verified_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMP`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_records_verified ON duplicate_records(last_verified_at ASC NULLS FIRST)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS phone_normalized VARCHAR(50)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS match_signals JSONB DEFAULT '[]'`,
  );

  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS layout_name VARCHAR(255)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS layout_id VARCHAR(100)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS zoho_module VARCHAR(50)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS pipeline VARCHAR(255)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS products TEXT`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS mobile VARCHAR(100)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS mobile_normalized VARCHAR(50)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS contact_name VARCHAR(255)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS account_name VARCHAR(500)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS cr_number VARCHAR(100)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS vat_number VARCHAR(100)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS website VARCHAR(500)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS country VARCHAR(100)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS region VARCHAR(100)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS industry VARCHAR(255)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS no_of_employees INTEGER`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS title VARCHAR(255)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS lead_type VARCHAR(100)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS gov_type VARCHAR(100)`,
  );
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS account_type VARCHAR(100)`,
  );
  // Empty/Junk cleanup classification (Sarah 2026-07-01) — recomputed every
  // scan from the synced snapshot by classifyCleanupRecords(). Values:
  // 'empty' | 'test' | 'junk' | 'orphaned' | 'tagged' | NULL (real data).
  await pool.query(
    `ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS cleanup_class TEXT`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS zoho_sync_state (
      module VARCHAR(50) PRIMARY KEY,
      last_sync_at TIMESTAMP,
      total_synced INTEGER DEFAULT 0,
      sync_status VARCHAR(50) DEFAULT 'idle'
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS duplicate_record_tasks (
      id SERIAL PRIMARY KEY,
      zoho_task_id VARCHAR(100) UNIQUE,
      related_record_id VARCHAR(100),
      cluster_id INTEGER REFERENCES duplicate_clusters(id) ON DELETE SET NULL,
      subject VARCHAR(500),
      due_date TIMESTAMP,
      status VARCHAR(100),
      owner_name VARCHAR(255),
      description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS duplicate_merge_actions (
      id SERIAL PRIMARY KEY,
      cluster_id INTEGER REFERENCES duplicate_clusters(id) ON DELETE CASCADE,
      primary_record_id INTEGER REFERENCES duplicate_records(id),
      merged_record_ids JSONB DEFAULT '[]',
      action_type VARCHAR(20) NOT NULL DEFAULT 'resolve',
      performed_by VARCHAR(255),
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS merge_jobs (
      id SERIAL PRIMARY KEY,
      cluster_id INTEGER NOT NULL,
      module VARCHAR(20) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'queued',
      total INTEGER NOT NULL DEFAULT 0,
      processed INTEGER NOT NULL DEFAULT 0,
      tagged INTEGER NOT NULL DEFAULT 0,
      reparented INTEGER NOT NULL DEFAULT 0,
      errors INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      master_zoho_id VARCHAR(64),
      created_by VARCHAR(255),
      started_at TIMESTAMPTZ,
      last_progress_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      include_zoho_ids TEXT,
      link_account_zoho_id TEXT,
      force_merge BOOLEAN NOT NULL DEFAULT false
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_merge_jobs_cluster ON merge_jobs(cluster_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_merge_jobs_cluster_module_status ON merge_jobs(cluster_id, module, status)`);
  await pool.query(`ALTER TABLE merge_jobs ADD COLUMN IF NOT EXISTS include_zoho_ids TEXT`);
  await pool.query(`ALTER TABLE merge_jobs ADD COLUMN IF NOT EXISTS link_account_zoho_id TEXT`);
  await pool.query(`ALTER TABLE merge_jobs ADD COLUMN IF NOT EXISTS force_merge BOOLEAN NOT NULL DEFAULT false`);

  // Durable resolution ledger — keyed by STABLE Zoho identity (module +
  // master_zoho_id), NOT by cluster_id. This table is intentionally NOT part of
  // truncateAllDuplicateData()'s TRUNCATE: "Rebuild Clusters" wipes
  // duplicate_clusters/duplicate_records (and cascades duplicate_merge_actions),
  // which previously collapsed the "solved" scoreboard back to 0 on every
  // rebuild/rescan. The ledger remembers that a survivor was resolved so the
  // breakdown can re-attribute "solved" to whatever cluster the survivor lands
  // in after the next scan. ON CONFLICT keeps it idempotent across re-applies.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS duplicate_resolution_ledger (
      id SERIAL PRIMARY KEY,
      module VARCHAR(20) NOT NULL,
      master_zoho_id VARCHAR(100),
      duplicate_zoho_ids JSONB NOT NULL DEFAULT '[]',
      action_type VARCHAR(20) NOT NULL DEFAULT 'resolve',
      performed_by VARCHAR(255),
      notes TEXT,
      resolved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool
    .query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_dup_res_ledger_identity
         ON duplicate_resolution_ledger(module, master_zoho_id)
         WHERE master_zoho_id IS NOT NULL`,
    )
    .catch(() => {});
  await pool
    .query(
      `CREATE INDEX IF NOT EXISTS idx_dup_res_ledger_master
         ON duplicate_resolution_ledger(master_zoho_id)`,
    )
    .catch(() => {});

  // One-time-safe backfill: seed the ledger from solved state that still exists
  // at boot so its "solved" credit survives the next rebuild. Idempotent via
  // ON CONFLICT DO NOTHING, safe on every boot. NOTE: cannot resurrect history
  // wiped by a prior rebuild (before this ledger existed).
  //
  // Attribution must be PER-MODULE-ACCURATE, or a partial cross-module apply
  // would inflate solved counts:
  //   A) WHOLE-cluster resolves (status='resolved' or a 'resolve' merge action)
  //      → credit EVERY module present, each keyed to a record OF THAT MODULE
  //      (its primary if any, else a representative — DISTINCT ON picks it).
  //   B) 'module_resolved' actions (ONE module merged inside a still-open
  //      cross-module cluster) → credit ONLY the module of that action's
  //      primary record, NOT every record_type in the cluster.
  await backfillResolutionLedger();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS duplicate_detection_logs (
      id SERIAL PRIMARY KEY,
      detection_type VARCHAR(50) DEFAULT 'manual',
      total_records_scanned INTEGER DEFAULT 0,
      total_clusters_found INTEGER DEFAULT 0,
      total_duplicates_detected INTEGER DEFAULT 0,
      high_confidence_count INTEGER DEFAULT 0,
      medium_confidence_count INTEGER DEFAULT 0,
      low_confidence_count INTEGER DEFAULT 0,
      estimated_pipeline_inflation DECIMAL(15,2),
      detection_duration_ms INTEGER,
      triggered_by VARCHAR(255),
      user_email VARCHAR(255),
      status VARCHAR(50) DEFAULT 'running',
      error_message TEXT,
      detection_config JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS duplicate_export_logs (
      id SERIAL PRIMARY KEY,
      export_type VARCHAR(50) DEFAULT 'all',
      filter_criteria JSONB,
      total_records_exported INTEGER DEFAULT 0,
      file_format VARCHAR(20) DEFAULT 'excel',
      exported_by VARCHAR(255),
      user_email VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Daily progress snapshot — one row per module per day so the Duplicate Radar
  // can show a BURNDOWN per tab (Leads/Deals/Contacts/Accounts) over time, not
  // just a "right now" number. open = active clusters with that module; solved =
  // clusters no longer active (Sarah's chosen definition, 2026-06-17); total =
  // open + solved (the "from the beginning" denominator, which grows as new
  // duplicates are detected). merged = durable real-merge count from the
  // append-only ledger (survives Rebuild Clusters — the honest "data merged"
  // line). Upserted per (date, module): the last write of the day wins, so the
  // 6-hourly scan keeps today's row current while older days stay frozen as
  // history. See captureDuplicateProgressSnapshot / getDuplicateProgressSeries.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS duplicate_progress_daily (
      snapshot_date DATE NOT NULL,
      module VARCHAR(16) NOT NULL,
      open_count INTEGER NOT NULL DEFAULT 0,
      solved_count INTEGER NOT NULL DEFAULT 0,
      total_count INTEGER NOT NULL DEFAULT 0,
      merged_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (snapshot_date, module)
    )
  `);

  // Separation ledger (Ahmad 2026-06-20) — durable "these Zoho records are NOT
  // duplicates of each other" decisions captured from Split / Dismiss. The
  // radar otherwise re-clusters by shared name / phone / domain on every sync,
  // which silently undoes an operator's split (the "I split it many times and
  // it came back" bug). findOrCreateClusterByCompany consults this and refuses
  // to re-fuse a record into a cluster holding a record it was separated from.
  // Pairs stored canonically (low,high) so the lookup is symmetric.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS duplicate_separation_ledger (
      id SERIAL PRIMARY KEY,
      zoho_id_low VARCHAR(255) NOT NULL,
      zoho_id_high VARCHAR(255) NOT NULL,
      reason VARCHAR(32) NOT NULL DEFAULT 'split',
      created_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (zoho_id_low, zoho_id_high)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_dup_sep_low ON duplicate_separation_ledger(zoho_id_low)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_dup_sep_high ON duplicate_separation_ledger(zoho_id_high)`,
  );

  // Empty/Orphaned cleanup: durable record of which records the operator has
  // already tagged Empty-Delete. The cleanup tab reads the LOCAL mirror, which
  // is stale until the next full sync — so without this a just-tagged record
  // reappears on Refresh ("why does it come back?"). The empty-records queries
  // exclude anything in this ledger, so a tagged record drops off immediately;
  // Untag removes it; a genuine Zoho deletion drops it from the mirror anyway.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS empty_delete_ledger (
      id SERIAL PRIMARY KEY,
      zoho_record_id VARCHAR(255) NOT NULL,
      module VARCHAR(16) NOT NULL,
      tagged_by VARCHAR(255),
      status VARCHAR(16) NOT NULL DEFAULT 'pending_delete',
      deleted_at TIMESTAMP NULL,
      last_checked_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (zoho_record_id)
    )
  `);
  // Deletion-lifecycle columns (additive; reflected in the CREATE TABLE above so
  // schema-parity stays STRICT). status: 'pending_delete' until the Zoho admin
  // removes the record, then 'deleted' with deleted_at set; last_checked_at is
  // stamped by the reconcile pass that verifies existence in Zoho.
  await pool.query(
    `ALTER TABLE empty_delete_ledger ADD COLUMN IF NOT EXISTS status VARCHAR(16) NOT NULL DEFAULT 'pending_delete'`,
  );
  await pool.query(
    `ALTER TABLE empty_delete_ledger ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP NULL`,
  );
  await pool.query(
    `ALTER TABLE empty_delete_ledger ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMP NULL`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_empty_delete_ledger_rec ON empty_delete_ledger(zoho_record_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_empty_delete_ledger_status ON empty_delete_ledger(status)`,
  );

  // Empty/Orphaned cleanup: durable "reviewed — keep, NOT empty" decisions. The
  // operator can Dismiss a flagged record that is actually legitimate (e.g. a
  // deal that has data); the empty-records queries exclude anything here so it
  // never reappears as cleanup work. Un-dismiss removes the row.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS empty_records_dismissed (
      id SERIAL PRIMARY KEY,
      zoho_record_id VARCHAR(255) NOT NULL,
      module VARCHAR(16) NOT NULL,
      dismissed_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (zoho_record_id)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_empty_records_dismissed_rec ON empty_records_dismissed(zoho_record_id)`,
  );

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_clusters_domain ON duplicate_clusters(domain)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_clusters_status ON duplicate_clusters(status)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_records_cluster ON duplicate_records(cluster_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_records_type ON duplicate_records(record_type)`,
  );

  // B6: Additional performance indexes
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_duplicate_records_zoho_id ON duplicate_records(zoho_record_id) WHERE zoho_record_id IS NOT NULL`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_records_email ON duplicate_records(LOWER(email)) WHERE email IS NOT NULL`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_records_phone_norm ON duplicate_records(phone_normalized) WHERE phone_normalized IS NOT NULL`,
  );
  // PERF (Ahmad 2026-06-28): the per-contact cluster match in
  // findContactClusterByStrictMatch filters `LOWER(record_name) = $3` inside an
  // OR alongside email/phone. Email + phone are indexed above, but record_name
  // was NOT — and an OR where one arm is unindexed forces Postgres to SEQ-SCAN
  // all of duplicate_records. That query runs once PER fetched contact (≈59k on a
  // full pull), so the missing index turned the contact sync into hours of
  // O(N²) scanning that never finished (so the Contacts baseline never saved, so
  // every run re-pulled in full). This functional index lets the planner Bitmap-
  // OR all three identity arms. Mirrors idx_duplicate_records_email.
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_records_name_lower ON duplicate_records(LOWER(record_name)) WHERE record_name IS NOT NULL`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_records_domain ON duplicate_records(domain) WHERE domain IS NOT NULL`,
  );

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_records_layout ON duplicate_records(layout_name) WHERE layout_name IS NOT NULL`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_records_zoho_module ON duplicate_records(zoho_module) WHERE zoho_module IS NOT NULL`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_records_pipeline ON duplicate_records(pipeline) WHERE pipeline IS NOT NULL`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_records_owner ON duplicate_records(owner_name) WHERE owner_name IS NOT NULL`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_records_country ON duplicate_records(country) WHERE country IS NOT NULL`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_records_industry ON duplicate_records(industry) WHERE industry IS NOT NULL`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_records_modified ON duplicate_records(modified_date)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_records_mobile_norm ON duplicate_records(mobile_normalized) WHERE mobile_normalized IS NOT NULL`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_records_cr ON duplicate_records(cr_number) WHERE cr_number IS NOT NULL`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_records_vat ON duplicate_records(vat_number) WHERE vat_number IS NOT NULL`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_record_tasks_record ON duplicate_record_tasks(related_record_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_duplicate_records_cleanup_class ON duplicate_records(cleanup_class)`,
  );

  // B4: pg_trgm for fuzzy matching
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_clusters_company_trgm ON duplicate_clusters USING GIN (company_name_normalized gin_trgm_ops)`,
    );
  } catch (e) {
    logger.info(
      "⚠️ [DuplicateRadar] pg_trgm not available, falling back to Levenshtein matching",
    );
  }
  // PERF (Ahmad 2026-06-28): findOrCreateClusterByCompany does an EXACT-equality
  // lookup `WHERE company_name_normalized = $1` once per account/deal during the
  // sync. The GIN trigram index above only serves LIKE/similarity, NOT `=`, so
  // that exact match would seq-scan duplicate_clusters per record. This B-tree
  // index serves the equality lookup (prevents the account phase repeating the
  // contact-phase O(N²) stall).
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_clusters_company_name_eq ON duplicate_clusters(company_name_normalized) WHERE company_name_normalized IS NOT NULL`,
  );

  // Account inference hints — see src/utils/accountInference.ts. Stored
  // suggestions for sales: "this deal looks like it belongs to Account X
  // because the contact's email domain matches". Sales work the queue from
  // the Account Hints tab.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_inference_hints (
      id SERIAL PRIMARY KEY,
      deal_record_id INTEGER NOT NULL REFERENCES duplicate_records(id) ON DELETE CASCADE,
      suggested_account_record_id INTEGER REFERENCES duplicate_records(id) ON DELETE CASCADE,
      suggested_account_name TEXT,
      suggested_domain TEXT,
      evidence_contact_record_id INTEGER REFERENCES duplicate_records(id) ON DELETE SET NULL,
      evidence_contact_email TEXT,
      confidence INTEGER DEFAULT 0,
      status VARCHAR(16) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (deal_record_id, suggested_account_record_id)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_account_inference_status ON account_inference_hints(status)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_account_inference_confidence ON account_inference_hints(confidence DESC) WHERE status = 'pending'`,
  );

  // Record Hint — generalized cross-module link suggestions (Contact->Account,
  // Deal->Contact, etc). Mirrors account_inference_hints above but is
  // link-field agnostic (source_type + link_field describe what's being
  // suggested) so it can cover more than just deal->account.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS record_link_hints (
      id SERIAL PRIMARY KEY,
      source_record_id INT NOT NULL REFERENCES duplicate_records(id) ON DELETE CASCADE,
      source_type VARCHAR(20) NOT NULL,
      link_field VARCHAR(40) NOT NULL,
      suggested_target_record_id INT REFERENCES duplicate_records(id) ON DELETE SET NULL,
      suggested_target_zoho_id VARCHAR(100),
      suggested_target_name TEXT,
      suggested_domain TEXT,
      evidence_record_id INT,
      evidence_detail TEXT,
      confidence INT NOT NULL DEFAULT 0,
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (source_record_id, link_field, suggested_target_record_id)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_record_link_hints_status ON record_link_hints (status)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_record_link_hints_type ON record_link_hints (source_type, link_field)`,
  );

  // Record Hint §4 "Unaccounted deals — decide": the operator's ✗ "dismiss"
  // (Sarah 2026-07-14 — a stalled deal judged NOT a real issue). scanStaleDeals
  // excludes ids listed here so they stop resurfacing. No Zoho write — local
  // triage only.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stale_deal_dismissals (
      deal_zoho_id VARCHAR(100) PRIMARY KEY,
      dismissed_by TEXT,
      dismissed_at TIMESTAMPTZ DEFAULT NOW(),
      -- 'dismissed' = operator judged it not a real stale issue (false positive);
      -- 'resolved'  = operator already handled the deal MANUALLY in Zoho and wants
      -- it recorded as resolved, not dismissed (Sarah 2026-07-16). Both drop the
      -- deal off the Unaccounted list; the value is for audit/labelling.
      disposition TEXT NOT NULL DEFAULT 'dismissed'
    )
  `);
  // Schema-parity migration for tables that predate the disposition column.
  await pool.query(
    `ALTER TABLE stale_deal_dismissals ADD COLUMN IF NOT EXISTS disposition TEXT NOT NULL DEFAULT 'dismissed'`,
  );

  // R2 (per-owner Remediation Packet): cover-sheet text the operator
  // hands to a data-quality owner. Single-row key/value table — keeps the
  // dispute path + escalation contact editable without a code deploy and
  // without touching env vars. Seeded with sensible defaults if empty.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS duplicate_radar_packet_settings (
      setting_key   VARCHAR(64) PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Seed defaults — ON CONFLICT DO NOTHING so existing installs that
  // customised these values are not overwritten. To CHANGE a live value:
  //   UPDATE duplicate_radar_packet_settings
  //     SET setting_value='<new>'
  //     WHERE setting_key='<key>';
  await pool.query(
    `INSERT INTO duplicate_radar_packet_settings (setting_key, setting_value) VALUES
       ('escalation_contact_name',  'Ahmad Amashah — Operations Quality'),
       ('escalation_contact_email', 'a.amashah@walaplus.com'),
       ('dispute_path',             'If a row should NOT be merged (e.g. intentional parallel deals for compliance reasons), flag it back to GRQ Quality with the Cluster ID and a one-line justification. Do not merge in Zoho until acknowledged.')
     ON CONFLICT (setting_key) DO NOTHING`,
  );
}

export interface PacketSettings {
  escalation_contact_name: string;
  escalation_contact_email: string;
  dispute_path: string;
}

export async function getPacketSettings(): Promise<PacketSettings> {
  const r = await pool.query(
    `SELECT setting_key, setting_value FROM duplicate_radar_packet_settings`,
  );
  const map: Record<string, string> = {};
  for (const row of r.rows) map[row.setting_key] = row.setting_value;
  return {
    escalation_contact_name:
      map.escalation_contact_name || "Ahmad Amashah — Operations Quality",
    escalation_contact_email:
      map.escalation_contact_email || "a.amashah@walaplus.com",
    dispute_path:
      map.dispute_path ||
      "If a row should NOT be merged, flag it back to GRQ Quality with the Cluster ID and a one-line justification. Do not merge in Zoho until acknowledged.",
  };
}

export async function createCluster(
  cluster: Omit<DuplicateCluster, "id" | "created_at" | "updated_at">,
): Promise<DuplicateCluster> {
  const companyNormalized = cluster.company_name
    ? normalizeCompanyName(cluster.company_name)
    : null;
  const result = await pool.query(
    `INSERT INTO duplicate_clusters 
     (domain, company_name, company_name_arabic, company_name_normalized, total_leads, total_deals, total_records, 
      confidence_level, confidence_score, first_record_date, latest_activity_date, 
      owners_involved, estimated_pipeline_value, status, ai_recommendation)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING *`,
    [
      cluster.domain,
      cluster.company_name,
      cluster.company_name_arabic,
      companyNormalized,
      cluster.total_leads,
      cluster.total_deals,
      cluster.total_records,
      cluster.confidence_level,
      cluster.confidence_score,
      cluster.first_record_date,
      cluster.latest_activity_date,
      JSON.stringify(cluster.owners_involved || []),
      cluster.estimated_pipeline_value || 0,
      cluster.status,
      cluster.ai_recommendation,
    ],
  );
  return result.rows[0];
}

// A1: Incremental upsert for records (replaces destructive clearAllDuplicateData approach)
export async function upsertRecord(
  record: Omit<DuplicateRecord, "id" | "created_at">,
): Promise<DuplicateRecord> {
  const phoneNorm = record.phone ? normalizePhone(record.phone) : null;
  const mobileNorm = record.mobile ? normalizePhone(record.mobile) : null;
  const result = await pool.query(
    `INSERT INTO duplicate_records 
     (cluster_id, record_type, zoho_record_id, record_name, company_name, email, domain,
      phone, phone_normalized, mobile, mobile_normalized, owner_name, owner_email, status, stage, deal_value, source, created_date,
      modified_date, is_primary, ai_recommendation, confidence_score, is_mock_data, raw_data,
      layout_name, layout_id, zoho_module, pipeline, products, contact_name, account_name,
      cr_number, vat_number, website, country, region, industry, no_of_employees, title,
      lead_type, gov_type, account_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
             $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42)
     ON CONFLICT (zoho_record_id) WHERE zoho_record_id IS NOT NULL DO UPDATE SET
       cluster_id = EXCLUDED.cluster_id,
       record_name = EXCLUDED.record_name,
       company_name = EXCLUDED.company_name,
       email = EXCLUDED.email,
       domain = EXCLUDED.domain,
       phone = EXCLUDED.phone,
       phone_normalized = EXCLUDED.phone_normalized,
       mobile = EXCLUDED.mobile,
       mobile_normalized = EXCLUDED.mobile_normalized,
       owner_name = EXCLUDED.owner_name,
       owner_email = EXCLUDED.owner_email,
       status = EXCLUDED.status,
       stage = EXCLUDED.stage,
       deal_value = EXCLUDED.deal_value,
       source = EXCLUDED.source,
       modified_date = EXCLUDED.modified_date,
       raw_data = EXCLUDED.raw_data,
       layout_name = EXCLUDED.layout_name,
       layout_id = EXCLUDED.layout_id,
       zoho_module = EXCLUDED.zoho_module,
       pipeline = EXCLUDED.pipeline,
       products = EXCLUDED.products,
       contact_name = EXCLUDED.contact_name,
       account_name = EXCLUDED.account_name,
       cr_number = EXCLUDED.cr_number,
       vat_number = EXCLUDED.vat_number,
       website = EXCLUDED.website,
       country = EXCLUDED.country,
       region = EXCLUDED.region,
       industry = EXCLUDED.industry,
       no_of_employees = EXCLUDED.no_of_employees,
       title = EXCLUDED.title,
       lead_type = EXCLUDED.lead_type,
       gov_type = EXCLUDED.gov_type,
       account_type = EXCLUDED.account_type
     RETURNING *`,
    [
      record.cluster_id,
      record.record_type,
      record.zoho_record_id,
      record.record_name,
      record.company_name,
      record.email,
      record.domain,
      record.phone,
      phoneNorm,
      record.mobile,
      mobileNorm,
      record.owner_name,
      record.owner_email,
      record.status,
      record.stage,
      record.deal_value,
      record.source,
      record.created_date,
      record.modified_date,
      record.is_primary,
      record.ai_recommendation,
      record.confidence_score,
      record.is_mock_data,
      JSON.stringify(record.raw_data || {}),
      record.layout_name,
      record.layout_id,
      record.zoho_module,
      record.pipeline,
      record.products,
      record.contact_name,
      record.account_name,
      record.cr_number,
      record.vat_number,
      record.website,
      record.country,
      record.region,
      record.industry,
      record.no_of_employees,
      record.title,
      record.lead_type,
      record.gov_type,
      record.account_type,
    ],
  );
  return result.rows[0];
}

// A7: phone_normalized included directly in INSERT
export async function addRecordToCluster(
  record: Omit<DuplicateRecord, "id" | "created_at">,
): Promise<DuplicateRecord> {
  const phoneNorm = record.phone ? normalizePhone(record.phone) : null;
  const result = await pool.query(
    `INSERT INTO duplicate_records 
     (cluster_id, record_type, zoho_record_id, record_name, company_name, email, domain,
      phone, phone_normalized, owner_name, owner_email, status, stage, deal_value, source, created_date,
      modified_date, is_primary, ai_recommendation, confidence_score, is_mock_data, raw_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
     RETURNING *`,
    [
      record.cluster_id,
      record.record_type,
      record.zoho_record_id,
      record.record_name,
      record.company_name,
      record.email,
      record.domain,
      record.phone,
      phoneNorm,
      record.owner_name,
      record.owner_email,
      record.status,
      record.stage,
      record.deal_value,
      record.source,
      record.created_date,
      record.modified_date,
      record.is_primary,
      record.ai_recommendation,
      record.confidence_score,
      record.is_mock_data,
      JSON.stringify(record.raw_data || {}),
    ],
  );
  return result.rows[0];
}

// Build the shared WHERE clause for cluster listing/counting. Centralised so
// the new `layouts` filter (and any future ones) stay in lock-step between
// `getAllClusters` and `getClusterCount`.
function buildClusterFilterClause(
  filters:
    | {
        status?: string;
        confidence_level?: string;
        start_date?: string;
        end_date?: string;
        hide_hierarchies?: boolean;
        layouts?: string[];
        /**
         * Per-owner drill: keep clusters that contain at least one
         * record owned by this email (case-insensitive). Wired into
         * the Owners tab on /duplicates so clicking an owner row
         * opens a modal listing the clusters they're carrying.
         */
        owner_email?: string;
        /** Marketplace / WalaPlus / WalaOne product segment. */
        segment?: DuplicateFilters["segment"];
      }
    | undefined,
  startIndex: number,
): { clause: string; params: any[]; nextIndex: number } {
  const params: any[] = [];
  let paramIndex = startIndex;
  let clause = "";

  // 2026-06-17 — DEFAULT excludes handled clusters so resolved (merged) and
  // ignored (dismissed) clusters never resurface in the clusters list or the
  // per-owner drill modal (which passes no status). Explicit 'all' opts back
  // in to every status; a specific status (active/resolved/ignored) filters
  // to exactly that one (the audit chips still work).
  if (filters?.status === "all") {
    /* explicit opt-in — no status filter */
  } else if (filters?.status) {
    clause += ` AND status = $${paramIndex++}`;
    params.push(filters.status);
  } else {
    clause += ` AND status NOT IN ('resolved', 'ignored')`;
  }
  if (filters?.confidence_level) {
    clause += ` AND confidence_level = $${paramIndex++}`;
    params.push(filters.confidence_level);
  }
  if (filters?.start_date) {
    clause += ` AND created_at >= $${paramIndex++}`;
    params.push(filters.start_date);
  }
  if (filters?.end_date) {
    clause += ` AND created_at <= $${paramIndex++}`;
    params.push(filters.end_date + "T23:59:59Z");
  }
  if (filters?.hide_hierarchies) {
    clause += ` AND GREATEST(COALESCE(total_leads,0), COALESCE(total_deals,0), COALESCE(total_contacts,0), COALESCE(total_accounts,0)) > 1`;
  }
  // Layout filter: keep clusters that have at least one record in any of the
  // selected Zoho layouts (Corporate Accounts, Standard, Marketplace, ...).
  if (filters?.layouts && filters.layouts.length > 0) {
    clause += ` AND EXISTS (
      SELECT 1 FROM duplicate_records dr
       WHERE dr.cluster_id = duplicate_clusters.id
         AND dr.layout_name = ANY($${paramIndex++}::text[])
    )`;
    params.push(filters.layouts);
  }
  // Owner filter: case-insensitive match against duplicate_records.owner_email.
  // A cluster qualifies when ANY of its records is owned by this person —
  // this matches how the Owners table aggregates total_records / dups
  // (it counts every record an owner is named on, regardless of who owns
  // the other records in the same cluster).
  if (filters?.owner_email && filters.owner_email.trim()) {
    clause += ` AND EXISTS (
      SELECT 1 FROM duplicate_records dr
       WHERE dr.cluster_id = duplicate_clusters.id
         AND LOWER(dr.owner_email) = LOWER($${paramIndex++})
    )`;
    params.push(filters.owner_email.trim());
  }
  // Segment chip (Marketplace / WalaPlus / WalaOne) — Sarah 2026-07-13: keep
  // clusters that have at least one record in the chosen product layout. Mirrors
  // buildSegmentPredicate's layout semantics, inlined with the dr alias (all
  // literal, no bind params) so it composes with the EXISTS filters above.
  if (filters?.segment && filters.segment !== "all") {
    // Same layout source + substring marketplace match as buildSegmentPredicate
    // (Sarah 2026-07-15): fall back to raw_data Layout when the column is blank,
    // and treat any layout CONTAINING "marketplace" (e.g. "Doam Marketplace") as
    // marketplace — not just the exact 'marketplace' name.
    const LAYOUT =
      "LOWER(COALESCE(NULLIF(dr.layout_name,''), dr.raw_data#>>'{Layout,name}', dr.raw_data#>>'{$layout,name}', dr.raw_data->>'Layout', ''))";
    const NORM = `regexp_replace(${LAYOUT}, '[^a-z0-9]', '', 'g')`;
    const MKT = `(${NORM} LIKE '%marketplace%' OR ${NORM} LIKE '%partneraccounts%')`;
    let cond: string;
    if (filters.segment === "marketplace") {
      cond = MKT;
    } else if (filters.segment === "walaone") {
      cond = `${NORM} LIKE '%walaone%'`;
    } else {
      // walaplus / corporate = NOT marketplace AND NOT walaone.
      cond = `NOT ${MKT} AND ${NORM} NOT LIKE '%walaone%'`;
    }
    clause += ` AND EXISTS (
      SELECT 1 FROM duplicate_records dr
       WHERE dr.cluster_id = duplicate_clusters.id
         AND ${cond}
    )`;
  }
  // Hide placeholder / junk-name clusters (Sarah 2026-07-14): لايوجد / "not
  // provided" / N/A / _placeholder etc. are CS name-quality noise, not real
  // duplicates — their home is the Empty/Junk tab. Filter on company_name
  // membership in the placeholder set + the quarantine domain. EMPTY names are
  // NOT hidden here (a real domain-keyed cluster can legitimately carry a blank
  // company name).
  clause += ` AND domain <> '${PLACEHOLDER_CLUSTER_DOMAIN}'
    AND LOWER(BTRIM(COALESCE(company_name,''))) <> ALL($${paramIndex++}::text[])`;
  params.push(PLACEHOLDER_COMPANY_NAMES_LOWER_ARR);
  return { clause, params, nextIndex: paramIndex };
}

// Whitelisted sort columns. Only allow values mapped here to be interpolated
// into the ORDER BY — guards against SQL injection from the query string.
const CLUSTER_SORT_COLUMNS: Record<string, string> = {
  records:    "total_records",
  similarity: "confidence_score",
  domain:     "domain",
  company:    "company_name",
  status:     "status",
  inflation:  "estimated_pipeline_value",
  updated:    "updated_at",
  // Sarah: newest duplicates first. latest_activity_date =
  // MAX(COALESCE(modified_date, created_date)) of the cluster's records,
  // so freshly created/touched dupes sort to the top of Domain Clusters.
  recent:     "latest_activity_date",
};

export async function getAllClusters(filters?: {
  status?: string;
  confidence_level?: string;
  limit?: number;
  offset?: number;
  start_date?: string;
  end_date?: string;
  hide_hierarchies?: boolean;
  layouts?: string[];
  owner_email?: string;
  sort?: string;
  dir?: string;
  segment?: DuplicateFilters["segment"];
}): Promise<Array<DuplicateCluster & { domain_count?: number }>> {
  const { clause, params, nextIndex } = buildClusterFilterClause(filters, 1);
  let paramIndex = nextIndex;
  // domain_count is a correlated subquery counting DISTINCT corporate-shaped
  // domains across the cluster's records. The frontend uses values >= 2 to
  // flag mixed clusters at the card level without an N+1 per-card fetch.
  // We approximate isCorporateDomain() in SQL by excluding empty values and
  // free-mail domains; the JS-side helper is authoritative for the modal,
  // this is just a cheap card-level hint.
  // domain_count is a correlated subquery that the frontend uses to flag
  // mixed-domain clusters at the card level (≥2 ⇒ mixed). We avoid a table
  // alias on the outer FROM because buildClusterFilterClause references
  // `duplicate_clusters.id` unqualified inside its EXISTS sub-clause for
  // the layouts filter.
  let query =
    `SELECT duplicate_clusters.*,
            (SELECT COUNT(DISTINCT LOWER(r.domain))
               FROM duplicate_records r
              WHERE r.cluster_id = duplicate_clusters.id
                AND r.domain IS NOT NULL
                AND r.domain <> ''
                AND LOWER(r.domain) NOT IN (
                  'gmail.com','googlemail.com','yahoo.com','ymail.com',
                  'rocketmail.com','hotmail.com','hotmail.co.uk','outlook.com',
                  'live.com','aol.com','icloud.com','me.com','mac.com','mail.com',
                  'protonmail.com','proton.me','yandex.com','zoho.com',
                  'gmx.com','gmx.net','qq.com','163.com','126.com'
                )
            ) AS domain_count,
            -- sibling_cluster_count: how many ACTIVE clusters share this exact
            -- domain (Sarah 2026-07-14 cross-link). >1 ⇒ this company was split
            -- into multiple cluster rows → show an "also split → Cluster Merge"
            -- badge on the card. Cheap: hits the domain btree index.
            (SELECT COUNT(*) FROM duplicate_clusters sc
              WHERE sc.domain = duplicate_clusters.domain
                AND sc.domain IS NOT NULL AND sc.domain <> ''
                AND sc.status = 'active'
            ) AS sibling_cluster_count
       FROM duplicate_clusters
      WHERE 1=1` + clause;

  // Exclude clusters where all remaining records are queued for deletion —
  // applies only to the active/open view (status='active' or default/undefined).
  // Resolved, ignored, and 'all' views are left exactly as they are.
  const isNonActiveView =
    filters?.status === "all" ||
    filters?.status === "resolved" ||
    filters?.status === "ignored";
  if (!isNonActiveView) {
    query += ` AND (SELECT COUNT(*) FROM duplicate_records dx WHERE dx.cluster_id = duplicate_clusters.id AND NOT ${queuedForDeletionSql("dx")}) >= 2`;
  }

  // Empty/Junk exclusion (Task 3): a cluster only belongs on this tab while
  // it still holds >=2 REAL records (cleanup_class IS NULL). Cleanup records
  // (empty/test/junk/orphaned/tagged) are classified post-scan by
  // classifyCleanupRecords() and are hidden here — their home is the
  // Empty/Junk tab, not Domain Clusters.
  query += ` AND (SELECT COUNT(*) FROM duplicate_records dc2 WHERE dc2.cluster_id = duplicate_clusters.id AND dc2.cleanup_class IS NULL) >= 2`;

  const sortKey = filters?.sort && CLUSTER_SORT_COLUMNS[filters.sort]
    ? CLUSTER_SORT_COLUMNS[filters.sort]
    : "total_records";
  const dir = filters?.dir === "asc" ? "ASC" : "DESC";
  // Stable secondary sort so equal primary values don't churn between pages.
  query += ` ORDER BY ${sortKey} ${dir} NULLS LAST, id ASC`;

  if (filters?.limit) {
    query += ` LIMIT $${paramIndex++}`;
    params.push(filters.limit);
  }
  if (filters?.offset !== undefined && filters?.offset !== null) {
    query += ` OFFSET $${paramIndex++}`;
    params.push(filters.offset);
  }

  const result = await pool.query(query, params);
  return result.rows;
}

export async function getClusterCount(filters?: {
  status?: string;
  confidence_level?: string;
  start_date?: string;
  end_date?: string;
  hide_hierarchies?: boolean;
  layouts?: string[];
  owner_email?: string;
  segment?: DuplicateFilters["segment"];
}): Promise<number> {
  const { clause, params } = buildClusterFilterClause(filters, 1);
  const query =
    "SELECT COUNT(*) as total FROM duplicate_clusters WHERE 1=1" + clause;
  const result = await pool.query(query, params);
  return parseInt(result.rows[0]?.total) || 0;
}

/**
 * Snapshot the current "solved" state (status='resolved' / 'resolve' &
 * 'module_resolved' merge actions) into the durable duplicate_resolution_ledger,
 * keyed by the survivor's stable Zoho id. Idempotent (ON CONFLICT DO NOTHING).
 *
 * MUST run at boot AND immediately before any Rebuild truncate — a Rebuild
 * CASCADE-deletes merge_actions and resets cluster status, so progress only
 * survives if it's been written to the ledger first. Skipping this is exactly
 * why the per-module "solved" counts collapsed to 0 after a rebuild.
 */
export async function backfillResolutionLedger(): Promise<void> {
  await pool
    .query(
      `INSERT INTO duplicate_resolution_ledger
         (module, master_zoho_id, action_type, performed_by, notes, resolved_at)
       SELECT DISTINCT ON (dr.cluster_id, mod.module)
         mod.module,
         dr.zoho_record_id,
         'resolve',
         dc.resolved_by,
         'backfilled from whole-cluster resolve',
         COALESCE(dc.resolved_at, NOW())
       FROM duplicate_clusters dc
       JOIN duplicate_records dr ON dr.cluster_id = dc.id
       JOIN LATERAL (
         SELECT CASE dr.record_type
                  WHEN 'lead' THEN 'Leads'
                  WHEN 'deal' THEN 'Deals'
                  WHEN 'contact' THEN 'Contacts'
                  WHEN 'account' THEN 'Accounts'
                END AS module
       ) mod ON true
       WHERE (
               dc.status = 'resolved'
               OR EXISTS (
                 SELECT 1 FROM duplicate_merge_actions ma
                  WHERE ma.cluster_id = dc.id AND ma.action_type = 'resolve'
               )
             )
         AND dr.record_type IN ('lead','deal','contact','account')
         AND dr.zoho_record_id IS NOT NULL
       ORDER BY dr.cluster_id, mod.module, dr.is_primary DESC, dr.id ASC
       ON CONFLICT (module, master_zoho_id) WHERE master_zoho_id IS NOT NULL DO NOTHING`,
    )
    .catch((e) => {
      logger.warn("[DuplicateRadar] resolution-ledger resolve-backfill skipped (non-fatal)", {
        error: e instanceof Error ? e.message : String(e),
      });
    });
  await pool
    .query(
      `INSERT INTO duplicate_resolution_ledger
         (module, master_zoho_id, action_type, performed_by, notes, resolved_at)
       SELECT DISTINCT ON (ma.cluster_id, mod.module)
         mod.module,
         pr.zoho_record_id,
         'module_resolved',
         ma.performed_by,
         'backfilled from module_resolved action',
         COALESCE(ma.created_at, NOW())
       FROM duplicate_merge_actions ma
       JOIN duplicate_records pr ON pr.id = ma.primary_record_id
       JOIN duplicate_clusters dc ON dc.id = ma.cluster_id
       JOIN LATERAL (
         SELECT CASE pr.record_type
                  WHEN 'lead' THEN 'Leads'
                  WHEN 'deal' THEN 'Deals'
                  WHEN 'contact' THEN 'Contacts'
                  WHEN 'account' THEN 'Accounts'
                END AS module
       ) mod ON true
       WHERE ma.action_type = 'module_resolved'
         AND dc.status <> 'resolved'
         AND NOT EXISTS (
           SELECT 1 FROM duplicate_merge_actions r2
            WHERE r2.cluster_id = ma.cluster_id AND r2.action_type = 'resolve'
         )
         AND pr.record_type IN ('lead','deal','contact','account')
         AND pr.zoho_record_id IS NOT NULL
       ORDER BY ma.cluster_id, mod.module, ma.created_at DESC
       ON CONFLICT (module, master_zoho_id) WHERE master_zoho_id IS NOT NULL DO NOTHING`,
    )
    .catch((e) => {
      logger.warn("[DuplicateRadar] resolution-ledger module-backfill skipped (non-fatal)", {
        error: e instanceof Error ? e.message : String(e),
      });
    });

  // THIRD source — the append-only apply log (duplicate_resolution_feedback).
  // Its cluster_id has NO foreign key, so it SURVIVES a Rebuild's TRUNCATE
  // CASCADE (unlike status + merge_actions). Seeding from it RECOVERS solved
  // progress that a prior rebuild wiped before this ledger captured it (the
  // "0 solved after rebuild" Sarah hit), keyed by the survivor's stable Zoho id.
  // Excludes applies that were later UNDONE (undo removes the tags + reopens).
  await pool
    .query(
      `INSERT INTO duplicate_resolution_ledger
         (module, master_zoho_id, action_type, performed_by, notes, resolved_at)
       SELECT DISTINCT ON (mm.module, mm.master)
         mm.module,
         mm.master,
         -- APPLIED, not verified (Sarah 2026-07-06): an 'applied' feedback event
         -- means the duplicates were TAGGED, not confirmed deleted. Recover it as
         -- 'module_resolved' (AI-Applied/pending) so restoreLedgerResolvedClusterStatus
         -- does NOT auto-resolve it after a boot/Rebuild. Genuinely-verified clusters
         -- are recovered as 'resolve' by source-1 (status='resolved') above.
         'module_resolved',
         f.performed_by,
         'backfilled from apply feedback log (AI-Applied, pending verify)',
         COALESCE(f.created_at, NOW())
       FROM duplicate_resolution_feedback f
       JOIN LATERAL (
         SELECT f.plan_json->>'module' AS module,
                COALESCE(f.chosen_master_zoho_id, f.proposed_master_zoho_id) AS master
       ) mm ON true
       WHERE f.event_type = 'applied'
         AND COALESCE(f.performed_by, '') NOT ILIKE 'UNDO%'
         AND mm.module IN ('Leads','Deals','Contacts','Accounts')
         AND mm.master IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM duplicate_resolution_feedback u
            WHERE u.cluster_id = f.cluster_id
              AND COALESCE(u.performed_by, '') ILIKE 'UNDO%'
              AND u.created_at > f.created_at
         )
       ORDER BY mm.module, mm.master, f.created_at DESC
       ON CONFLICT (module, master_zoho_id) WHERE master_zoho_id IS NOT NULL DO NOTHING`,
    )
    .catch((e) => {
      logger.warn("[DuplicateRadar] resolution-ledger feedback-backfill skipped (non-fatal)", {
        error: e instanceof Error ? e.message : String(e),
      });
    });
}

// ── Daily progress snapshot (per-tab burndown) ────────────────────────────────

const PROGRESS_MODULES: Array<{ col: string; module: string }> = [
  { col: "total_leads", module: "Leads" },
  { col: "total_deals", module: "Deals" },
  { col: "total_contacts", module: "Contacts" },
  { col: "total_accounts", module: "Accounts" },
];

export interface DuplicateProgressRow {
  module: string;
  open: number; // active clusters with this module
  solved: number; // clusters no longer active (Sarah's definition)
  total: number; // open + solved (the "from the beginning" denominator)
  merged: number; // durable real-merge count (ledger; survives rebuilds)
}

/**
 * Capture today's per-module progress and UPSERT one row per (date, module)
 * into duplicate_progress_daily. Idempotent within a day — the last write wins,
 * so the 6-hourly scan keeps today's row current while older days stay frozen
 * as history. Returns the snapshot it wrote. Best-effort: never throws (a
 * snapshot failure must not abort a scan).
 *
 * Definitions (locked with Sarah 2026-06-17; refined 2026-07-06):
 *   open   = clusters with status='active' that contain this module AND have NO
 *            apply action yet (truly untouched). An applied cluster now stays
 *            'active' in the AI-Applied queue until Verify-in-CRM resolves it, so
 *            it must NOT count as "open" — it's handled, awaiting deletion.
 *   solved = every other cluster containing this module (closed OR AI-Applied —
 *            merged, linked, marked-resolved, ignored, or tagged-pending-delete)
 *   total  = open + solved (all clusters that contain this module)
 *   merged = distinct durable real merges for this module from the ledger
 */
export async function captureDuplicateProgressSnapshot(): Promise<DuplicateProgressRow[]> {
  const out: DuplicateProgressRow[] = PROGRESS_MODULES.map((m) => ({
    module: m.module,
    open: 0,
    solved: 0,
    total: 0,
    merged: 0,
  }));
  try {
    const selects = PROGRESS_MODULES.map(
      (o) =>
        `COUNT(*) FILTER (WHERE dc.${o.col} > 0)::int AS ${o.col}_t,
         COUNT(*) FILTER (WHERE dc.${o.col} > 0 AND dc.status = 'active'
                          AND NOT EXISTS (
                            SELECT 1 FROM duplicate_merge_actions ma
                             WHERE ma.cluster_id = dc.id
                               AND ma.action_type IN ('resolve','module_resolved','auto_merge_pending')
                          ))::int AS ${o.col}_o`,
    ).join(",\n");
    const r = await pool.query(`SELECT ${selects} FROM duplicate_clusters dc`);
    const row = r.rows[0] || {};

    // Durable real merges per module (ledger survives Rebuild Clusters).
    const lg = await pool.query<{ module: string; n: string }>(
      `SELECT module, COUNT(*)::text AS n
         FROM duplicate_resolution_ledger
        WHERE master_zoho_id IS NOT NULL
        GROUP BY module`,
    );
    const mergedByModule = new Map<string, number>(
      lg.rows.map((x) => [x.module, Number(x.n) || 0]),
    );

    PROGRESS_MODULES.forEach((o, i) => {
      const total = Number(row[`${o.col}_t`] || 0);
      const open = Number(row[`${o.col}_o`] || 0);
      out[i].total = total;
      out[i].open = open;
      out[i].solved = Math.max(0, total - open);
      out[i].merged = mergedByModule.get(o.module) || 0;
    });

    for (const p of out) {
      await pool.query(
        `INSERT INTO duplicate_progress_daily
           (snapshot_date, module, open_count, solved_count, total_count, merged_count, created_at)
         VALUES (CURRENT_DATE, $1, $2, $3, $4, $5, NOW())
         ON CONFLICT (snapshot_date, module) DO UPDATE SET
           open_count = EXCLUDED.open_count,
           solved_count = EXCLUDED.solved_count,
           total_count = EXCLUDED.total_count,
           merged_count = EXCLUDED.merged_count,
           created_at = NOW()`,
        [p.module, p.open, p.solved, p.total, p.merged],
      );
    }
  } catch (e) {
    logger.warn("[DuplicateRadar] captureDuplicateProgressSnapshot skipped (non-fatal)", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return out;
}

export interface DuplicateProgressSeriesPoint {
  date: string; // YYYY-MM-DD
  open: number;
  solved: number;
  total: number;
  merged: number;
}

/**
 * Read the per-module daily progress series for the last `days` days, plus the
 * latest snapshot per module and the day-over-day deltas. Powers the "Progress
 * by tab" panel + the digest line. If today has no row yet (e.g. first boot
 * before a scan), it captures one on the fly so the caller always sees current
 * numbers.
 */
export async function getDuplicateProgressSeries(days = 30): Promise<{
  byModule: Record<
    string,
    {
      latest: DuplicateProgressSeriesPoint | null;
      previous: DuplicateProgressSeriesPoint | null;
      series: DuplicateProgressSeriesPoint[];
    }
  >;
  generatedAt: string;
}> {
  const lookback = Math.max(1, Math.min(Math.floor(days) || 30, 365));
  const byModule: Record<string, any> = {};
  for (const m of PROGRESS_MODULES) {
    byModule[m.module] = { latest: null, previous: null, series: [] };
  }
  try {
    // Make sure today's row exists so "latest" is never stale.
    const todayCheck = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM duplicate_progress_daily WHERE snapshot_date = CURRENT_DATE`,
    );
    if (Number(todayCheck.rows[0]?.n || 0) === 0) {
      await captureDuplicateProgressSnapshot();
    }

    const r = await pool.query(
      `SELECT to_char(snapshot_date, 'YYYY-MM-DD') AS date, module,
              open_count, solved_count, total_count, merged_count
         FROM duplicate_progress_daily
        WHERE snapshot_date >= CURRENT_DATE - ($1::int - 1)
        ORDER BY module, snapshot_date ASC`,
      [lookback],
    );
    for (const row of r.rows) {
      const bucket = byModule[row.module];
      if (!bucket) continue;
      const point: DuplicateProgressSeriesPoint = {
        date: row.date,
        open: Number(row.open_count) || 0,
        solved: Number(row.solved_count) || 0,
        total: Number(row.total_count) || 0,
        merged: Number(row.merged_count) || 0,
      };
      bucket.series.push(point);
    }
    for (const m of PROGRESS_MODULES) {
      const s = byModule[m.module].series as DuplicateProgressSeriesPoint[];
      byModule[m.module].latest = s.length ? s[s.length - 1] : null;
      byModule[m.module].previous = s.length > 1 ? s[s.length - 2] : null;
    }
  } catch (e) {
    logger.warn("[DuplicateRadar] getDuplicateProgressSeries failed (non-fatal)", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return { byModule, generatedAt: new Date().toISOString() };
}

// ── Bulk auto-merge: Contacts with EXACT email + phone match (Sarah 2026-06-20) ─
//
// Rule: when ≥2 contacts share the SAME email AND the SAME phone (both exact,
// after normalization), they're the same person — safe to bulk-merge. Keep the
// survivor (most complete → linked-Account → oldest), tag the rest
// "Duplicate-Delete" (migrate-then-tag; the admin deletes). Guards exclude
// placeholder emails / junk phones so a placeholder collision can't trigger it.

/**
 * Zoho ids of records already MERGED AWAY for a module (tagged Duplicate-Delete
 * but not yet deleted by the admin). Until the admin deletes them they still
 * sit in duplicate_records, so the bulk auto-merge matchers must EXCLUDE them —
 * otherwise the BATCHED apply re-derives + re-merges the same groups every batch
 * and never converges (re-hitting Zoho with redundant re-tags). Two sources,
 * unioned: the durable resolution ledger (agentic / account merges via
 * executeMergePlan) and pending merge actions (contact auto-merges record an
 * 'auto_merge_pending' action carrying the duplicates' DB ids). Best-effort —
 * a missing table just yields an empty set (no exclusion, no regression).
 */
async function getResolvedDuplicateZohoIds(
  module: "Accounts" | "Contacts" | "Leads" | "Deals",
): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const led = await pool.query<{ duplicate_zoho_ids: unknown }>(
      `SELECT duplicate_zoho_ids FROM duplicate_resolution_ledger WHERE module = $1`,
      [module],
    );
    for (const r of led.rows) {
      const a = Array.isArray(r.duplicate_zoho_ids) ? r.duplicate_zoho_ids : [];
      for (const id of a) if (id != null) out.add(String(id));
    }
  } catch {
    /* ledger absent/empty */
  }
  try {
    const recordType =
      module === "Accounts"
        ? "account"
        : module === "Contacts"
          ? "contact"
          : module === "Leads"
            ? "lead"
            : "deal";
    const res = await pool.query<{ zoho_record_id: string }>(
      `SELECT DISTINCT dr.zoho_record_id
         FROM duplicate_merge_actions ma
         CROSS JOIN LATERAL jsonb_array_elements_text(ma.merged_record_ids) AS e(db_id)
         JOIN duplicate_records dr ON dr.id = e.db_id::int
        WHERE ma.action_type IN ('auto_merge_pending','resolve','module_resolved')
          AND dr.record_type = $1`,
      [recordType],
    );
    for (const r of res.rows) if (r.zoho_record_id) out.add(String(r.zoho_record_id));
  } catch {
    /* merge-actions table absent/empty */
  }
  return out;
}

/** One contact in a merge group, with its data-completeness score (drill-in). */
export interface ContactMergeMember {
  zohoId: string;
  name: string;
  email: string | null;
  phone: string | null;
  /** Raw Phone / Mobile (original formatting) — used to preserve both numbers
   *  on merge and to recompute when the operator overrides the survivor. */
  phoneRaw?: string | null;
  mobileRaw?: string | null;
  account: string | null;
  owner: string | null;
  layout: string | null;
  createdMs: number | null;
  /** Populated tracked fields out of fieldsTotal (name, email, phone, account, title, owner). */
  fieldsPopulated: number;
  fieldsTotal: number;
  completionPct: number;
  /** True for the proposed survivor (kept on merge). Override-able by the operator. */
  isSurvivor: boolean;
}

/** Tracked fields for the contact completion % (drill-in display). */
const CONTACT_SCORE_FIELDS = 6; // name, email, phone, account, title, owner
function _contactCompletion(v: {
  name?: unknown;
  email?: unknown;
  phone?: unknown;
  account?: unknown;
  title?: unknown;
  owner?: unknown;
}): number {
  return [v.name, v.email, v.phone, v.account, v.title, v.owner].reduce<number>(
    (n, x) => n + (x != null && String(x).trim() !== "" ? 1 : 0),
    0,
  );
}

interface ExactContactGroup {
  /** Stable id = email|phone — carries a survivor override on apply. */
  key: string;
  email: string;
  phone: string;
  survivorZohoId: string;
  duplicateZohoIds: string[];
  /** Second number to preserve on the survivor (Mobile gap-fill) — both members
   *  share the same primary email+phone, so only a differing Mobile can be lost. */
  phoneUpdates: { Phone?: string; Mobile?: string };
  extraPhones: string[];
  /** Every contact in the group, scored — so the operator can verify / override. */
  members: ContactMergeMember[];
}

/** Find contact groups where email AND phone match exactly (guarded). */
async function getExactContactMatchGroups(): Promise<ExactContactGroup[]> {
  const res = await pool.query<{
    k_email: string;
    k_phone: string;
    zoho_record_id: string;
    record_name: string | null;
    account_name: string | null;
    owner_name: string | null;
    title: string | null;
    layout_name: string | null;
    phone: string | null;
    mobile: string | null;
    has_account: boolean;
    completeness: number;
    created_ms: string | null;
  }>(
    `SELECT lower(trim(email)) AS k_email,
            phone_normalized    AS k_phone,
            zoho_record_id, record_name, account_name, owner_name, title, layout_name,
            phone, mobile,
            (account_name IS NOT NULL AND btrim(account_name) <> '') AS has_account,
            ( (CASE WHEN account_name IS NOT NULL AND btrim(account_name)<>'' THEN 1 ELSE 0 END)
            + (CASE WHEN title       IS NOT NULL AND btrim(title)<>''        THEN 1 ELSE 0 END)
            + (CASE WHEN website     IS NOT NULL AND btrim(website)<>''      THEN 1 ELSE 0 END)
            + (CASE WHEN owner_name  IS NOT NULL AND btrim(owner_name)<>''   THEN 1 ELSE 0 END)
            + (CASE WHEN company_name IS NOT NULL AND btrim(company_name)<>'' THEN 1 ELSE 0 END)
            ) AS completeness,
            EXTRACT(EPOCH FROM COALESCE(created_date, modified_date))::bigint AS created_ms
       FROM duplicate_records
      WHERE record_type = 'contact'
        AND zoho_record_id IS NOT NULL AND btrim(zoho_record_id) <> ''
        AND email IS NOT NULL
        AND length(btrim(email)) > 4
        AND position('@' in email) > 1
        AND lower(email) NOT LIKE 'test@%'
        AND lower(email) NOT LIKE '%@test%'
        AND lower(email) NOT LIKE '%example.%'
        AND lower(btrim(email)) NOT IN ('n/a','na','none','null','-')
        AND phone_normalized IS NOT NULL
        AND length(phone_normalized) >= 7
        AND phone_normalized !~ '^(.)\\1+$'
        AND LOWER(COALESCE(layout_name, '')) NOT LIKE '%marketplace%'
        AND LOWER(COALESCE(layout_name, '')) NOT LIKE '%partner account%'`,
  );

  // Skip contacts already merged away (tagged Duplicate-Delete, pending admin
  // delete) so the batched apply converges instead of re-merging them forever.
  const resolvedContactIds = await getResolvedDuplicateZohoIds("Contacts");
  const byKey = new Map<string, typeof res.rows>();
  for (const row of res.rows) {
    if (resolvedContactIds.has(row.zoho_record_id)) continue;
    if (!row.k_email || !row.k_phone) continue;
    const key = `${row.k_email}|${row.k_phone}`;
    const arr = byKey.get(key) || [];
    arr.push(row);
    byKey.set(key, arr);
  }

  const groups: ExactContactGroup[] = [];
  for (const [key, rows] of byKey.entries()) {
    // Dedupe by zoho id; need ≥2 DISTINCT records to be a real duplicate set.
    const seen = new Map<string, (typeof rows)[number]>();
    for (const r of rows) if (!seen.has(r.zoho_record_id)) seen.set(r.zoho_record_id, r);
    const members = [...seen.values()];
    if (members.length < 2) continue;
    // Survivor: most complete → linked-Account → oldest.
    members.sort((a, b) => {
      if (b.completeness !== a.completeness) return b.completeness - a.completeness;
      if (a.has_account !== b.has_account) return a.has_account ? -1 : 1;
      const am = Number(a.created_ms || Number.MAX_SAFE_INTEGER);
      const bm = Number(b.created_ms || Number.MAX_SAFE_INTEGER);
      return am - bm; // older first
    });
    const [survivor, ...dups] = members;
    const [email, phone] = key.split("|");
    const memberRows: ContactMergeMember[] = members.map((m) => {
      const pop = _contactCompletion({
        name: m.record_name,
        email: email,
        phone: phone,
        account: m.account_name,
        title: m.title,
        owner: m.owner_name,
      });
      return {
        zohoId: m.zoho_record_id,
        name: (m.record_name || "").trim(),
        email: email || null,
        phone: phone || null,
        phoneRaw: (m.phone || "").trim() || null,
        mobileRaw: (m.mobile || "").trim() || null,
        account: m.account_name,
        owner: m.owner_name,
        layout: m.layout_name,
        createdMs: m.created_ms != null ? Number(m.created_ms) : null,
        fieldsPopulated: pop,
        fieldsTotal: CONTACT_SCORE_FIELDS,
        completionPct: Math.round((pop / CONTACT_SCORE_FIELDS) * 100),
        isSurvivor: m.zoho_record_id === survivor.zoho_record_id,
      };
    });
    // Both members share the same primary email + phone (that's the match key),
    // so the only second number that can be lost is a duplicate's Mobile —
    // preserve it onto the survivor (gap-fill) exactly like the name+phone path.
    const dupNumbers = [...dups]
      .sort((a, b) => Number(b.created_ms || 0) - Number(a.created_ms || 0))
      .flatMap((d) => [String(d.phone || "").trim(), String(d.mobile || "").trim()])
      .filter(Boolean);
    const { updates: phoneUpdates, extra: extraPhones } = planMergedContactPhones({
      survivorPhone: survivor.phone,
      survivorMobile: survivor.mobile,
      otherNumbers: dupNumbers,
    });
    groups.push({
      key,
      email,
      phone,
      survivorZohoId: survivor.zoho_record_id,
      duplicateZohoIds: dups.map((d) => d.zoho_record_id),
      phoneUpdates,
      extraPhones,
      members: memberRows,
    });
  }
  return groups;
}

/** Preview only — count qualifying groups + how many records would be tagged. */
export async function previewExactContactMatches(): Promise<{
  qualifyingGroups: number;
  duplicatesToTag: number;
  numbersPreserved: number;
  sample: ExactContactGroup[];
}> {
  try {
    const groups = await getExactContactMatchGroups();
    return {
      qualifyingGroups: groups.length,
      duplicatesToTag: groups.reduce((n, g) => n + g.duplicateZohoIds.length, 0),
      numbersPreserved: groups.filter(
        (g) => g.phoneUpdates.Phone || g.phoneUpdates.Mobile,
      ).length,
      // Up to 200 groups (with scored members) so the operator can drill into
      // and override the survivor of each before applying.
      sample: groups.slice(0, 200),
    };
  } catch (e) {
    logger.warn("[DuplicateRadar] previewExactContactMatches failed (non-fatal)", {
      error: e instanceof Error ? e.message : String(e),
    });
    return { qualifyingGroups: 0, duplicatesToTag: 0, numbersPreserved: 0, sample: [] };
  }
}

/**
 * Apply the bulk merge: tag the duplicate(s) in each exact-match group
 * Duplicate-Delete (keeping the survivor), batching the Zoho add_tags calls.
 * Records a ledger entry per survivor so the merge counts as "merged" in the
 * progress/breakdown views. Bounded by `limit` groups per run (re-runnable).
 */
export async function applyExactContactMatches(opts: {
  limit?: number;
  performedBy: string;
  /** Per-group survivor overrides { "email|phone": zohoIdToKeep }. */
  overrides?: Record<string, string>;
  /** Per-group EXCLUDED contact ids — left untouched (not survivor, not tagged). */
  excludes?: Record<string, string[]>;
}): Promise<{ mergedGroups: number; taggedRecords: number; remaining: number; errors: number }> {
  const { addZohoTags, updateZohoRecord, zohoWritesAllowedInEnv } = await import("./zohoCRM");
  const { withTimeout } = await import("./promiseTimeout");
  if (!zohoWritesAllowedInEnv()) {
    throw new Error("Live Zoho writes are disabled outside production.");
  }
  const limit = Math.max(1, Math.min(Math.floor(opts.limit || 300), 1000));
  const all = await getExactContactMatchGroups();
  const batch = all.slice(0, limit);
  let taggedRecords = 0;
  let mergedGroups = 0;
  let errors = 0;

  // Honor operator EXCLUDES (members left untouched) + override (else keep the
  // highest-completeness survivor); the duplicates are the other INCLUDED ones.
  const resolved = batch
    .map((g) => {
      const ex = new Set(opts.excludes?.[g.key] ?? []);
      const included = g.members.map((m) => m.zohoId).filter((id) => !ex.has(id));
      if (included.length < 2) return null; // nothing to merge after exclusions
      const ov = opts.overrides?.[g.key];
      const chosen = ov && included.includes(ov)
        ? ov
        : included.includes(g.survivorZohoId)
          ? g.survivorZohoId
          : included[0]!;
      const dupIds = included.filter((id) => id !== chosen);
      return { g, chosen, dupIds };
    })
    .filter((r): r is { g: ExactContactGroup; chosen: string; dupIds: string[] } => r !== null);

  // MIGRATE-THEN-TAG: preserve a second number onto each survivor BEFORE tagging
  // its duplicates, so the admin can never delete the only record holding a
  // number. Recompute for the chosen survivor (it may be an override). A group
  // whose preservation write fails is DROPPED from this run (its dups are not
  // tagged) and stays re-runnable — never tag away an un-preserved number.
  const writeOk: typeof resolved = [];
  for (const r of resolved) {
    try {
      const chosenMember = r.g.members.find((m) => m.zohoId === r.chosen);
      const dupMembers = r.g.members.filter((m) => r.dupIds.includes(m.zohoId));
      const phoneUpd = planMergedContactPhones({
        survivorPhone: chosenMember?.phoneRaw ?? null,
        survivorMobile: chosenMember?.mobileRaw ?? null,
        otherNumbers: dupMembers
          .flatMap((m) => [(m.phoneRaw || "").trim(), (m.mobileRaw || "").trim()])
          .filter(Boolean),
      }).updates;
      if (phoneUpd.Phone || phoneUpd.Mobile) {
        await withTimeout(
          updateZohoRecord("Contacts", r.chosen, phoneUpd as Record<string, unknown>),
          20_000,
          `field-migrate ${r.chosen}`,
        );
      }
      writeOk.push(r);
    } catch (e) {
      errors++;
      logger.warn("[DuplicateRadar] exact-merge survivor number preserve failed — group skipped", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  resolved.length = 0;
  resolved.push(...writeOk);

  // Tag in chunks of 100 ids (Zoho add_tags multi-record limit). Track which
  // ids were ACTUALLY tagged so a failed chunk (e.g. Zoho rate-limited while a
  // sync is running) doesn't get marked AI-Applied · pending below — those
  // groups stay Untouched and re-runnable instead of stuck pending forever.
  const CHUNK = 100;
  const taggedOk = new Set<string>();
  const dupIds = resolved.flatMap((r) => r.dupIds);
  for (let i = 0; i < dupIds.length; i += CHUNK) {
    const chunk = dupIds.slice(i, i + CHUNK);
    try {
      await withTimeout(
        addZohoTags("Contacts", chunk, ["Duplicate-Delete"]),
        20_000,
        `tag contacts ${i}`,
      );
      taggedRecords += chunk.length;
      for (const id of chunk) taggedOk.add(id);
    } catch (e) {
      errors++;
      logger.warn("[DuplicateRadar] bulk contact tag chunk failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Mark each touched cluster AI-APPLIED · pending (Ahmad 2026-06-21). We record
  // an 'auto_merge_pending' merge action — NOT a ledger 'resolve' — so the
  // cluster moves out of Untouched into "AI-Applied · pending Zoho admin delete"
  // but does NOT prematurely flip to Resolved. It becomes Resolved only once the
  // admin actually deletes the tagged duplicates in Zoho, which the next sync's
  // reconcileAutoMergedContactDeletions() detects (it then writes the durable
  // ledger entry, and restoreLedgerResolvedClusterStatus flips it to resolved).
  for (const { g, chosen, dupIds: groupDups } of resolved) {
    try {
      // Only mark groups whose duplicates were ACTUALLY tagged in Zoho.
      const taggedDupZohoIds = groupDups.filter((id) => taggedOk.has(id));
      if (taggedDupZohoIds.length === 0) continue; // tag failed → leave Untouched
      const idRes = await pool.query<{
        id: number;
        cluster_id: number | null;
        zoho_record_id: string;
      }>(
        `SELECT id, cluster_id, zoho_record_id
           FROM duplicate_records
          WHERE zoho_record_id = ANY($1::text[])`,
        [[chosen, ...taggedDupZohoIds]],
      );
      const rows = idRes.rows;
      const survivorRow = rows.find((r) => r.zoho_record_id === chosen);
      const clusterId = survivorRow?.cluster_id ?? rows[0]?.cluster_id ?? null;
      const dupDbIds = rows
        .filter((r) => taggedDupZohoIds.includes(r.zoho_record_id))
        .map((r) => r.id);
      if (!clusterId || dupDbIds.length === 0) continue;
      await pool.query(
        `INSERT INTO duplicate_merge_actions
           (cluster_id, primary_record_id, merged_record_ids, action_type, performed_by, notes)
         VALUES ($1, $2, $3, 'auto_merge_pending', $4, $5)`,
        [
          clusterId,
          survivorRow?.id ?? null,
          JSON.stringify(dupDbIds),
          opts.performedBy,
          `Bulk auto-merge: exact email+phone. Tagged ${dupDbIds.length} Duplicate-Delete, pending Zoho admin delete.`,
        ],
      );
      mergedGroups++;
    } catch (e) {
      logger.warn("[DuplicateRadar] auto-merge mark-pending failed (non-fatal)", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { mergedGroups, taggedRecords, remaining: Math.max(0, all.length - batch.length), errors };
}

// ── Bulk auto-merge: Contacts with SAME NAME + SAME PHONE (Ahmad 2026-06-22) ──
//
// Broader than the exact email+phone rule: two contacts sharing the same
// (Arabic-normalized) name AND the same phone are the same person even when
// their emails differ or one is missing. On merge we keep BOTH emails — the
// survivor's primary Email plus the other in Secondary_Email — and when only
// ONE email exists across the pair it becomes the survivor's primary Email
// (the empty-email record is the same person). Migrate-then-tag; admin deletes.

/**
 * Decide the survivor's email fields for a same-name+phone contact merge.
 * Pure + exported for unit/simulation testing.
 *   • 0–1 distinct email total → that single email is the PRIMARY (no secondary).
 *   • ≥2 distinct emails → primary stays, the freshest OTHER email → Secondary_Email;
 *     any further alternates are returned in `extra` (Zoho has one secondary slot).
 */
export function planMergedContactEmails(input: {
  survivorEmail: string | null;
  otherEmails: string[]; // duplicate emails, freshest-first, original casing
}): { updates: { Email?: string; Secondary_Email?: string }; extra: string[] } {
  const trimOf = (e: string) => (e || "").trim();
  const keyOf = (e: string) => trimOf(e).toLowerCase();
  const updates: { Email?: string; Secondary_Email?: string } = {};
  const survivor = trimOf(input.survivorEmail || "");
  const seen = new Set<string>();
  const distinct: string[] = [];
  if (survivor) {
    seen.add(keyOf(survivor));
    distinct.push(survivor);
  }
  for (const raw of input.otherEmails || []) {
    const e = trimOf(raw);
    if (!e) continue;
    const k = keyOf(e);
    if (seen.has(k)) continue;
    seen.add(k);
    distinct.push(e);
  }
  if (distinct.length === 0) return { updates, extra: [] };
  if (!survivor) {
    // Survivor had no email → promote the freshest distinct email to PRIMARY.
    updates.Email = distinct[0]!;
    if (distinct.length >= 2) updates.Secondary_Email = distinct[1]!;
    return { updates, extra: distinct.slice(2) };
  }
  // Survivor keeps its primary; preserve the next distinct email as secondary.
  if (distinct.length >= 2) updates.Secondary_Email = distinct[1]!;
  return { updates, extra: distinct.slice(2) };
}

/**
 * Decide the survivor's phone fields for a same-name+phone contact merge.
 * Mirrors planMergedContactEmails but for Zoho's two phone slots (Phone +
 * Mobile). Saudi-normalised dedupe (drop +966 / leading 0, last 9 digits) so the
 * same number in different formats isn't double-stored. NEVER overwrites a number
 * the survivor already holds — only GAP-FILLS an empty slot — so a good number
 * can't be clobbered. A 3rd+ distinct number is returned in `extra` (Zoho keeps
 * only two). Pure + exported for unit/simulation testing.
 *   • survivor keeps its Phone (or, if it had none, the freshest distinct number
 *     becomes Phone);
 *   • the next distinct number fills Mobile only when the survivor's Mobile is empty.
 */
export function planMergedContactPhones(input: {
  survivorPhone: string | null;
  survivorMobile: string | null;
  otherNumbers: string[]; // duplicates' Phone+Mobile, freshest-first, original casing
}): { updates: { Phone?: string; Mobile?: string }; extra: string[] } {
  const trimOf = (s: string) => (s || "").trim();
  const normOf = (s: string) =>
    trimOf(s).replace(/\D/g, "").replace(/^966/, "").replace(/^0+/, "").slice(-9);
  const updates: { Phone?: string; Mobile?: string } = {};
  const sPhone = trimOf(input.survivorPhone || "");
  const sMobile = trimOf(input.survivorMobile || "");
  const seen = new Set<string>();
  const distinct: string[] = [];
  const add = (raw: string) => {
    const v = trimOf(raw);
    if (!v) return;
    const k = normOf(v);
    if (!k || seen.has(k)) return;
    seen.add(k);
    distinct.push(v);
  };
  add(sPhone);
  add(sMobile);
  for (const o of input.otherNumbers || []) add(o);
  if (distinct.length === 0) return { updates, extra: [] };
  // Survivor's primary number: keep its Phone; if it had none, promote freshest.
  const effPhone = sPhone || distinct[0]!;
  if (!sPhone) updates.Phone = effPhone;
  // Second slot → Mobile, GAP-FILL only (never overwrite a populated Mobile).
  if (!sMobile) {
    const second = distinct.find((v) => normOf(v) !== normOf(effPhone));
    if (second) updates.Mobile = second;
  }
  // Extras = distinct numbers beyond the two kept slots.
  const keptKeys = new Set<string>([normOf(effPhone)]);
  const effMobile = sMobile || updates.Mobile || "";
  if (effMobile) keptKeys.add(normOf(effMobile));
  const extra = distinct.filter((v) => !keptKeys.has(normOf(v)));
  return { updates, extra };
}

interface NamePhoneContactGroup {
  /** Stable id = normalizedName|phone — carries a survivor override on apply. */
  key: string;
  survivorZohoId: string;
  duplicateZohoIds: string[];
  emailUpdates: { Email?: string; Secondary_Email?: string };
  extraEmails: string[];
  phoneUpdates: { Phone?: string; Mobile?: string };
  extraPhones: string[];
  label: string;
  members: ContactMergeMember[];
}

/** Find contact groups sharing the same Arabic-normalized name + same phone. */
async function getNamePhoneContactGroups(): Promise<NamePhoneContactGroup[]> {
  const res = await pool.query<{
    zoho_record_id: string;
    record_name: string;
    email: string | null;
    phone_normalized: string | null;
    mobile_normalized: string | null;
    phone: string | null;
    mobile: string | null;
    account_name: string | null;
    title: string | null;
    website: string | null;
    company_name: string | null;
    owner_name: string | null;
    layout_name: string | null;
    created_ms: string | null;
  }>(
    `SELECT zoho_record_id, record_name, email,
            phone_normalized, mobile_normalized, phone, mobile,
            account_name, title, website, company_name, owner_name, layout_name,
            EXTRACT(EPOCH FROM COALESCE(created_date, modified_date))::bigint AS created_ms
       FROM duplicate_records
      WHERE record_type = 'contact'
        AND zoho_record_id IS NOT NULL AND btrim(zoho_record_id) <> ''
        AND record_name IS NOT NULL AND btrim(record_name) <> ''
        AND (
          (phone_normalized IS NOT NULL AND length(phone_normalized) >= 7)
          OR (mobile_normalized IS NOT NULL AND length(mobile_normalized) >= 7)
        )
        AND LOWER(COALESCE(layout_name, '')) NOT LIKE '%marketplace%'
        AND LOWER(COALESCE(layout_name, '')) NOT LIKE '%partner account%'`,
  );

  // Skip contacts already merged away (pending admin delete) so the batched
  // apply converges instead of re-merging the same name+phone groups forever.
  const resolvedContactIds = await getResolvedDuplicateZohoIds("Contacts");
  const byKey = new Map<string, typeof res.rows>();
  for (const row of res.rows) {
    if (resolvedContactIds.has(row.zoho_record_id)) continue;
    const nameKey = normalizePersonName(row.record_name);
    if (!nameKey) continue;
    // "Best phone" = the Phone field, else Mobile. (Cross-field Phone-vs-Mobile
    // matches between two records are not grouped in this v1 — same-field is the
    // overwhelmingly common case.)
    const phoneKey = (row.phone_normalized || row.mobile_normalized || "").trim();
    if (!phoneKey || phoneKey.length < 7) continue;
    const key = `${nameKey}|${phoneKey}`;
    const arr = byKey.get(key) || [];
    arr.push(row);
    byKey.set(key, arr);
  }

  const groups: NamePhoneContactGroup[] = [];
  for (const [key, rows] of byKey.entries()) {
    const seenIds = new Map<string, (typeof rows)[number]>();
    for (const r of rows) if (!seenIds.has(r.zoho_record_id)) seenIds.set(r.zoho_record_id, r);
    const members = [...seenIds.values()];
    if (members.length < 2) continue;
    const hasEmail = (r: (typeof rows)[number]) => (r.email && r.email.trim() ? 1 : 0);
    const completeness = (r: (typeof rows)[number]) =>
      (r.account_name && r.account_name.trim() ? 1 : 0) +
      (r.title && r.title.trim() ? 1 : 0) +
      (r.website && r.website.trim() ? 1 : 0) +
      (r.company_name && r.company_name.trim() ? 1 : 0);
    members.sort((a, b) => {
      // A record WITH an email must survive: Zoho dup-checks the PRIMARY Email,
      // so we never promote a still-existing duplicate's email to the survivor's
      // primary (that would be rejected). The survivor's email stays primary;
      // any different duplicate email goes to the un-dup-checked Secondary_Email.
      const ea = hasEmail(a),
        eb = hasEmail(b);
      if (eb !== ea) return eb - ea;
      const ca = completeness(a),
        cb = completeness(b);
      if (cb !== ca) return cb - ca;
      const am = Number(a.created_ms || Number.MAX_SAFE_INTEGER);
      const bm = Number(b.created_ms || Number.MAX_SAFE_INTEGER);
      return am - bm; // older survives on a tie
    });
    const [survivor, ...dups] = members;
    if (!survivor) continue;
    // Duplicate emails, freshest first, to drive the primary/secondary choice.
    const dupEmails = [...dups]
      .sort(
        (a, b) =>
          Number(b.created_ms || 0) - Number(a.created_ms || 0),
      )
      .map((d) => (d.email || "").trim())
      .filter(Boolean);
    const { updates, extra } = planMergedContactEmails({
      survivorEmail: survivor.email,
      otherEmails: dupEmails,
    });
    // Keep BOTH numbers — survivor's Phone stays; the freshest distinct dup
    // number gap-fills Mobile (same person, same name+phone group, so a second
    // number is a real alternate, not a different person).
    const dupNumbers = [...dups]
      .sort((a, b) => Number(b.created_ms || 0) - Number(a.created_ms || 0))
      .flatMap((d) => [String(d.phone || "").trim(), String(d.mobile || "").trim()])
      .filter(Boolean);
    const { updates: phoneUpdates, extra: extraPhones } = planMergedContactPhones({
      survivorPhone: survivor.phone,
      survivorMobile: survivor.mobile,
      otherNumbers: dupNumbers,
    });
    const phoneKey = key.split("|").slice(1).join("|");
    const memberRows: ContactMergeMember[] = members.map((m) => {
      const ph = (m.phone_normalized || m.mobile_normalized || "").trim() || phoneKey;
      const pop = _contactCompletion({
        name: m.record_name,
        email: m.email,
        phone: ph,
        account: m.account_name,
        title: m.title,
        owner: m.owner_name,
      });
      return {
        zohoId: m.zoho_record_id,
        name: (m.record_name || "").trim(),
        email: (m.email || "").trim() || null,
        phone: ph || null,
        phoneRaw: (m.phone || "").trim() || null,
        mobileRaw: (m.mobile || "").trim() || null,
        account: m.account_name,
        owner: m.owner_name,
        layout: m.layout_name,
        createdMs: m.created_ms != null ? Number(m.created_ms) : null,
        fieldsPopulated: pop,
        fieldsTotal: CONTACT_SCORE_FIELDS,
        completionPct: Math.round((pop / CONTACT_SCORE_FIELDS) * 100),
        isSurvivor: m.zoho_record_id === survivor.zoho_record_id,
      };
    });
    groups.push({
      key,
      survivorZohoId: survivor.zoho_record_id,
      duplicateZohoIds: dups.map((d) => d.zoho_record_id),
      emailUpdates: updates,
      extraEmails: extra,
      phoneUpdates,
      extraPhones,
      label: (survivor.record_name || "").trim(),
      members: memberRows,
    });
  }
  return groups;
}

/** Preview only — counts for the same-name+phone auto-merge. */
export async function previewNamePhoneContactMatches(): Promise<{
  qualifyingGroups: number;
  duplicatesToTag: number;
  emailsPreserved: number;
  numbersPreserved: number;
  sample: NamePhoneContactGroup[];
}> {
  try {
    const groups = await getNamePhoneContactGroups();
    return {
      qualifyingGroups: groups.length,
      duplicatesToTag: groups.reduce((n, g) => n + g.duplicateZohoIds.length, 0),
      emailsPreserved: groups.filter(
        (g) => g.emailUpdates.Email || g.emailUpdates.Secondary_Email,
      ).length,
      numbersPreserved: groups.filter(
        (g) => g.phoneUpdates.Phone || g.phoneUpdates.Mobile,
      ).length,
      sample: groups.slice(0, 200),
    };
  } catch (e) {
    logger.warn("[DuplicateRadar] previewNamePhoneContactMatches failed (non-fatal)", {
      error: e instanceof Error ? e.message : String(e),
    });
    return { qualifyingGroups: 0, duplicatesToTag: 0, emailsPreserved: 0, numbersPreserved: 0, sample: [] };
  }
}

/**
 * Apply the same-name+phone auto-merge: write the email field(s) onto the
 * survivor (primary gap-fill and/or Secondary_Email), then tag the duplicates
 * Duplicate-Delete. Marks each touched cluster 'auto_merge_pending' (same
 * lifecycle as the exact email+phone merge). Bounded by `limit`, re-runnable.
 */
export async function applyNamePhoneContactMatches(opts: {
  limit?: number;
  performedBy: string;
  /** Per-group survivor overrides { "name|phone": zohoIdToKeep }. */
  overrides?: Record<string, string>;
  /** Per-group EXCLUDED contact ids — left untouched (not survivor, not tagged). */
  excludes?: Record<string, string[]>;
}): Promise<{
  mergedGroups: number;
  taggedRecords: number;
  emailsWritten: number;
  remaining: number;
  errors: number;
}> {
  const { addZohoTags, updateZohoRecord, zohoWritesAllowedInEnv } = await import("./zohoCRM");
  const { withTimeout } = await import("./promiseTimeout");
  if (!zohoWritesAllowedInEnv()) {
    throw new Error("Live Zoho writes are disabled outside production.");
  }
  const limit = Math.max(1, Math.min(Math.floor(opts.limit || 200), 1000));
  const all = await getNamePhoneContactGroups();
  const batch = all.slice(0, limit);
  let taggedRecords = 0;
  let mergedGroups = 0;
  let emailsWritten = 0;
  let errors = 0;

  for (const g of batch) {
    try {
      // Honor operator EXCLUDES + override. When the survivor or the member set
      // changes we recompute the duplicates AND the email plan from the chosen
      // survivor (a record WITH an email should survive — the email plan keeps
      // the survivor's email primary and routes a different dup email to
      // Secondary_Email). Excluded members are left completely untouched.
      const ex = new Set(opts.excludes?.[g.key] ?? []);
      const included = g.members.map((m) => m.zohoId).filter((id) => !ex.has(id));
      if (included.length < 2) continue; // nothing to merge after exclusions
      const ov = opts.overrides?.[g.key];
      const chosen = ov && included.includes(ov)
        ? ov
        : included.includes(g.survivorZohoId)
          ? g.survivorZohoId
          : included[0]!;
      let dupZohoIds = g.duplicateZohoIds;
      let updates: {
        Email?: string;
        Secondary_Email?: string;
        Phone?: string;
        Mobile?: string;
      } = { ...g.emailUpdates, ...g.phoneUpdates };
      if (chosen !== g.survivorZohoId || ex.size > 0) {
        dupZohoIds = included.filter((id) => id !== chosen);
        const chosenMember = g.members.find((m) => m.zohoId === chosen);
        const includedDups = g.members
          .filter((m) => included.includes(m.zohoId) && m.zohoId !== chosen)
          .sort((a, b) => Number(b.createdMs || 0) - Number(a.createdMs || 0));
        const emailUpd = planMergedContactEmails({
          survivorEmail: chosenMember?.email ?? null,
          otherEmails: includedDups.map((m) => (m.email || "").trim()).filter(Boolean),
        }).updates;
        const phoneUpd = planMergedContactPhones({
          survivorPhone: chosenMember?.phoneRaw ?? null,
          survivorMobile: chosenMember?.mobileRaw ?? null,
          otherNumbers: includedDups
            .flatMap((m) => [(m.phoneRaw || "").trim(), (m.mobileRaw || "").trim()])
            .filter(Boolean),
        }).updates;
        updates = { ...emailUpd, ...phoneUpd };
      }
      // 1) Preserve the email(s) AND number(s) on the survivor BEFORE tagging.
      if (updates.Email || updates.Secondary_Email || updates.Phone || updates.Mobile) {
        await withTimeout(
          updateZohoRecord("Contacts", chosen, updates as Record<string, unknown>),
          20_000,
          `field-migrate ${chosen}`,
        );
        emailsWritten++;
      }
      // 2) Tag the duplicates Duplicate-Delete.
      const taggedOk = new Set<string>();
      for (let i = 0; i < dupZohoIds.length; i += 100) {
        const chunk = dupZohoIds.slice(i, i + 100);
        await withTimeout(
          addZohoTags("Contacts", chunk, ["Duplicate-Delete"]),
          20_000,
          `tag ${chosen} ${i}`,
        );
        taggedRecords += chunk.length;
        for (const id of chunk) taggedOk.add(id);
      }
      // 3) Mark the cluster AI-Applied · pending (only for the tagged dups).
      const taggedDupZohoIds = dupZohoIds.filter((id) => taggedOk.has(id));
      if (taggedDupZohoIds.length > 0) {
        const idRes = await pool.query<{ id: number; cluster_id: number | null; zoho_record_id: string }>(
          `SELECT id, cluster_id, zoho_record_id FROM duplicate_records WHERE zoho_record_id = ANY($1::text[])`,
          [[chosen, ...taggedDupZohoIds]],
        );
        const rows = idRes.rows;
        const survivorRow = rows.find((r) => r.zoho_record_id === chosen);
        const clusterId = survivorRow?.cluster_id ?? rows[0]?.cluster_id ?? null;
        const dupDbIds = rows
          .filter((r) => taggedDupZohoIds.includes(r.zoho_record_id))
          .map((r) => r.id);
        if (clusterId && dupDbIds.length > 0) {
          await pool.query(
            `INSERT INTO duplicate_merge_actions
               (cluster_id, primary_record_id, merged_record_ids, action_type, performed_by, notes)
             VALUES ($1, $2, $3, 'auto_merge_pending', $4, $5)`,
            [
              clusterId,
              survivorRow?.id ?? null,
              JSON.stringify(dupDbIds),
              opts.performedBy,
              `Bulk auto-merge: same name + phone. Preserved email(s) on survivor; tagged ${dupDbIds.length} Duplicate-Delete, pending Zoho admin delete.`,
            ],
          );
          mergedGroups++;
        }
      }
    } catch (e) {
      errors++;
      logger.warn("[DuplicateRadar] name+phone auto-merge group failed (non-fatal)", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    mergedGroups,
    taggedRecords,
    emailsWritten,
    remaining: Math.max(0, all.length - batch.length),
    errors,
  };
}

// ── Account auto-merge: same DOMAIN + same COMPANY NAME, within layout ───────
//
// Ahmad 2026-06-22. Two accounts on the SAME layout that share the same domain
// AND the same (Arabic/English suffix-stripped) company name are the same
// company. Corporate accounts merge only with Corporate accounts; Partner
// (Marketplace) only with Partner — a Corporate and a Partner account for the
// same company are intentionally separate and are NEVER merged. CR/VAT are
// ignored (unreliable data). This is the read-only grouping + PREVIEW; the
// write/cascade (reparent contacts+deals, tag) is applied via the existing
// agentic Account executor once the preview is confirmed.

/** Layout names per scope (lowercased), tunable via env. */
export const ACCOUNT_SCOPE_LAYOUTS: Record<"corporate" | "partner", string[]> = {
  corporate: (process.env.ACCOUNT_CORPORATE_LAYOUTS || "Corporate Accounts")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  partner: (process.env.ACCOUNT_PARTNER_LAYOUTS || "Marketplace")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
};

/** One account in a domain+name group, with its data-completeness score. */
export interface AccountDomainNameMember {
  zohoId: string;
  name: string;
  domain: string | null;
  owner: string | null;
  website: string | null;
  cr: string | null;
  vat: string | null;
  country: string | null;
  industry: string | null;
  layout: string | null;
  createdMs: number | null;
  /** Number of Deals linked to this Account (Account_Name.id) — shown in place
   *  of the unreliable CR number; a bigger Deals book = a stronger survivor. */
  dealCount: number;
  /** Count of the tracked key fields that are populated, out of fieldsTotal. */
  fieldsPopulated: number;
  fieldsTotal: number;
  /** Completion % = fieldsPopulated / fieldsTotal, rounded. */
  completionPct: number;
  /** True for the proposed survivor (highest completion %, tie-break oldest). */
  isSurvivor: boolean;
}

export interface AccountDomainNameGroup {
  /** Stable id = domain|nameKey — used to carry a survivor override on apply. */
  key: string;
  domain: string;
  nameKey: string;
  /** Proposed survivor: the member with the highest completion %. Override-able. */
  survivorZohoId: string;
  duplicateZohoIds: string[];
  /** Distinct display names across the group (surfaces EN vs AR variants). */
  names: string[];
  label: string;
  /** Every account in the group, scored — so the operator can verify / override. */
  members: AccountDomainNameMember[];
}

/**
 * Group accounts on the given layouts by domain + normalized name (>=2).
 *
 * groupBy (Sarah 2026-06-23):
 *   'domain_name' (default) → key = domain|name  (strict; unchanged behaviour)
 *   'domain'                → key = domain only   ("same domain, any name" — the
 *      looser mode that catches EN/AR / spelling variants). A SHARED-DOMAIN
 *      GUARD skips any domain carrying more than `maxDistinctNames` distinct
 *      company names (likely a holding/agency/shared domain) — those are left
 *      for manual review.
 */
async function getAccountDomainNameGroups(
  layoutNames: string[],
  opts?: { groupBy?: "domain_name" | "domain"; maxDistinctNames?: number },
): Promise<AccountDomainNameGroup[]> {
  const groupBy = opts?.groupBy || "domain_name";
  const maxDistinctNames = opts?.maxDistinctNames ?? 6;
  if (!layoutNames.length) return [];
  const res = await pool.query<{
    zoho_record_id: string;
    record_name: string | null;
    company_name: string | null;
    domain: string | null;
    owner_name: string | null;
    website: string | null;
    cr_number: string | null;
    vat_number: string | null;
    country: string | null;
    industry: string | null;
    layout_name: string | null;
    layout_norm: string | null;
    created_ms: string | null;
  }>(
    `SELECT zoho_record_id, record_name, company_name, domain, owner_name, website,
            cr_number, vat_number, country, industry, layout_name,
            LOWER(COALESCE(layout_name, '')) AS layout_norm,
            EXTRACT(EPOCH FROM COALESCE(created_date, modified_date))::bigint AS created_ms
       FROM duplicate_records
      WHERE record_type = 'account'
        AND zoho_record_id IS NOT NULL AND btrim(zoho_record_id) <> ''
        AND domain IS NOT NULL AND btrim(domain) <> ''
        AND LOWER(COALESCE(layout_name, '')) = ANY($1::text[])`,
    [layoutNames],
  );

  // Deal count per Account (local DB — deals whose Account_Name.id points at the
  // account). Shown in the preview in place of the unreliable CR number; a bigger
  // Deals book is a stronger survivor signal. No Zoho call — counted from the
  // already-synced deal records.
  const dealCountByAccount = new Map<string, number>();
  const acctIds = res.rows.map((r) => r.zoho_record_id).filter(Boolean);
  if (acctIds.length > 0) {
    const dcRes = await pool.query<{ account_id: string; n: string }>(
      `SELECT raw_data->'Account_Name'->>'id' AS account_id, COUNT(*) AS n
         FROM duplicate_records
        WHERE record_type = 'deal'
          AND raw_data->'Account_Name'->>'id' = ANY($1::text[])
        GROUP BY 1`,
      [acctIds],
    );
    for (const r of dcRes.rows) {
      if (r.account_id) dealCountByAccount.set(r.account_id, Number(r.n) || 0);
    }
  }

  // Exclude accounts already merged away (see getResolvedDuplicateZohoIds):
  // tagged duplicates aren't deleted until the admin acts, so without this they
  // keep re-grouping and the BATCHED apply re-merges the same groups every batch
  // (never converges, re-hammering Zoho). Excluding them collapses a merged
  // group to a singleton, which drops out — so the work set shrinks each batch.
  const resolvedDupIds = await getResolvedDuplicateZohoIds("Accounts");
  // Groups the operator DISMISSED ("not duplicates") — their accounts are
  // recorded as mutually separated, so the group must never reappear or merge.
  const sepPairs = await getSeparationPairKeySet();

  const byKey = new Map<string, typeof res.rows>();
  for (const row of res.rows) {
    if (resolvedDupIds.has(row.zoho_record_id)) continue; // already merged away
    const dom = (row.domain || "").trim().toLowerCase();
    const nameKey = normalizeCompanyName(row.record_name || row.company_name || "");
    // Merge WITHIN the exact same layout only (Ahmad 2026-06-23). The scope
    // allowlist can carry more than one layout (e.g. ACCOUNT_CORPORATE_LAYOUTS
    // = "Corporate,Partnership"); without this a Corporate account and a
    // Partnership/marketplace account that share a domain would fuse. Putting
    // the exact layout in the grouping key guarantees Corporate ↔ Corporate,
    // Marketplace ↔ Marketplace — never across.
    const layoutNorm = (row.layout_norm || "").trim();
    // Domain-only mode groups by domain alone (any name); strict mode needs both.
    if (!dom) continue;
    if (groupBy === "domain_name" && !nameKey) continue;
    const key =
      groupBy === "domain"
        ? `${dom}|@${layoutNorm}`
        : `${dom}|${nameKey}|@${layoutNorm}`;
    const arr = byKey.get(key) || [];
    arr.push(row);
    byKey.set(key, arr);
  }

  // Data completeness = how many of these key account fields are populated.
  // This is the transparent score the operator sees in the drill-in, and the
  // survivor is the member with the highest %. On apply we FORCE this survivor
  // (or the operator's override) as the merge master, so what's shown is
  // exactly what's kept — no divergence from a separate engine heuristic.
  const SCORED_FIELDS: Array<keyof (typeof res.rows)[number]> = [
    "record_name",
    "domain",
    "website",
    "owner_name",
    "cr_number",
    "vat_number",
    "country",
    "industry",
  ];
  const fieldsPopulated = (r: (typeof res.rows)[number]) =>
    SCORED_FIELDS.reduce(
      (n, f) => n + (r[f] != null && String(r[f]).trim() !== "" ? 1 : 0),
      0,
    );

  const groups: AccountDomainNameGroup[] = [];
  for (const [key, rows] of byKey.entries()) {
    const seen = new Map<string, (typeof rows)[number]>();
    for (const r of rows) if (!seen.has(r.zoho_record_id)) seen.set(r.zoho_record_id, r);
    const sorted = [...seen.values()];
    if (sorted.length < 2) continue;
    // Skip a DISMISSED group: if any member pair was recorded as separated
    // ("not duplicates"), drop the whole group so it never auto-merges.
    if (sepPairs.size > 0) {
      const ids = sorted.map((r) => r.zoho_record_id);
      let separated = false;
      for (let a = 0; a < ids.length && !separated; a++) {
        for (let b = a + 1; b < ids.length; b++) {
          const lo = ids[a]! < ids[b]! ? ids[a]! : ids[b]!;
          const hi = ids[a]! < ids[b]! ? ids[b]! : ids[a]!;
          if (sepPairs.has(lo + "|" + hi)) {
            separated = true;
            break;
          }
        }
      }
      if (separated) continue;
    }
    // Survivor: highest completion % → oldest (canonical original).
    sorted.sort((a, b) => {
      const ca = fieldsPopulated(a),
        cb = fieldsPopulated(b);
      if (cb !== ca) return cb - ca;
      return (
        Number(a.created_ms || Number.MAX_SAFE_INTEGER) -
        Number(b.created_ms || Number.MAX_SAFE_INTEGER)
      );
    });
    const [survivor, ...dups] = sorted;
    if (!survivor) continue;
    const total = SCORED_FIELDS.length;
    const members: AccountDomainNameMember[] = sorted.map((m) => {
      const pop = fieldsPopulated(m);
      return {
        zohoId: m.zoho_record_id,
        name: (m.record_name || m.company_name || "").trim(),
        domain: m.domain,
        owner: m.owner_name,
        website: m.website,
        cr: m.cr_number,
        vat: m.vat_number,
        country: m.country,
        industry: m.industry,
        layout: m.layout_name,
        createdMs: m.created_ms != null ? Number(m.created_ms) : null,
        dealCount: dealCountByAccount.get(m.zoho_record_id) ?? 0,
        fieldsPopulated: pop,
        fieldsTotal: total,
        completionPct: Math.round((pop / total) * 100),
        isSurvivor: m.zoho_record_id === survivor.zoho_record_id,
      };
    });
    const names = [
      ...new Set(
        sorted
          .map((m) => (m.record_name || m.company_name || "").trim())
          .filter(Boolean),
      ),
    ];
    // Shared-domain guard (domain-only mode): a domain carrying many DISTINCT
    // company names is probably a holding/agency/shared domain — skip it so it
    // isn't auto-merged; it stays for manual review.
    if (groupBy === "domain" && names.length > maxDistinctNames) continue;
    groups.push({
      key,
      domain: (sorted[0]!.domain || "").trim().toLowerCase(),
      nameKey: normalizeCompanyName(
        sorted[0]!.record_name || sorted[0]!.company_name || "",
      ),
      survivorZohoId: survivor.zoho_record_id,
      duplicateZohoIds: dups.map((d) => d.zoho_record_id),
      names,
      label: (survivor.record_name || survivor.company_name || "").trim(),
      members,
    });
  }
  return groups;
}

/** Read-only PREVIEW of the account auto-merge for both scopes. No writes. */
export async function previewAccountDomainNameMerge(): Promise<{
  corporate: { groups: number; accountsToTag: number; sample: AccountDomainNameGroup[] };
  partner: { groups: number; accountsToTag: number; sample: AccountDomainNameGroup[] };
}> {
  const build = async (layouts: string[]) => {
    const groups = await getAccountDomainNameGroups(layouts).catch(() => []);
    return {
      groups: groups.length,
      accountsToTag: groups.reduce((n, g) => n + g.duplicateZohoIds.length, 0),
      // Return up to 200 so the operator can drill into and override the
      // survivor of every group before applying (was 15 — too few to verify).
      sample: groups.slice(0, 200),
    };
  };
  return {
    corporate: await build(ACCOUNT_SCOPE_LAYOUTS.corporate),
    partner: await build(ACCOUNT_SCOPE_LAYOUTS.partner),
  };
}

/**
 * Read-only PREVIEW of the LOOSER domain-only account auto-merge (Sarah
 * 2026-06-23): "same domain, any name", with the shared-domain guard. No writes.
 */
export async function previewAccountDomainOnlyMerge(): Promise<{
  corporate: { groups: number; accountsToTag: number; sample: AccountDomainNameGroup[] };
  partner: { groups: number; accountsToTag: number; sample: AccountDomainNameGroup[] };
}> {
  const build = async (layouts: string[]) => {
    const groups = await getAccountDomainNameGroups(layouts, { groupBy: "domain" }).catch(
      () => [],
    );
    return {
      groups: groups.length,
      accountsToTag: groups.reduce((n, g) => n + g.duplicateZohoIds.length, 0),
      sample: groups.slice(0, 200),
    };
  };
  return {
    corporate: await build(ACCOUNT_SCOPE_LAYOUTS.corporate),
    partner: await build(ACCOUNT_SCOPE_LAYOUTS.partner),
  };
}

/**
 * Apply the account auto-merge for one scope. For each domain+name group it
 * reuses the PROVEN agentic merge engine (buildMergePlan + executeMergePlan):
 * survivor selection, EN/AR name preservation (into Description), re-parenting
 * the duplicates' contacts/deals onto the survivor, and tagging the rest
 * Duplicate-Delete — the platform never deletes. dryRun=true writes nothing
 * (still enumerates). Bounded by `limit`, re-runnable.
 */
export async function applyAccountDomainNameMerge(opts: {
  scope: "corporate" | "partner";
  dryRun: boolean;
  limit?: number;
  performedBy: string;
  /**
   * Per-group survivor overrides, keyed by AccountDomainNameGroup.key
   * (domain|nameKey) → the Zoho id to KEEP. When a group isn't listed we keep
   * the default survivor (highest completion %). An override pointing at a
   * record not in the group is ignored by the engine (it falls back safely).
   */
  overrides?: Record<string, string>;
  /**
   * Per-group EXCLUDED account ids, keyed by group key → zoho ids to leave OUT
   * of the merge entirely (not survivor, not tagged — untouched). Lets the
   * operator drop a wrong member (e.g. a Partner account) from a 3+ group and
   * still merge the rest.
   */
  excludes?: Record<string, string[]>;
  /** 'domain_name' (strict, default) or 'domain' (looser same-domain-any-name). */
  groupBy?: "domain_name" | "domain";
}): Promise<{
  scope: string;
  groups: number;
  merged: number;
  accountsTagged: number;
  reparentedDeals: number;
  reparentedContacts: number;
  namesPreserved: number;
  remaining: number;
  errors: number;
}> {
  const layouts = ACCOUNT_SCOPE_LAYOUTS[opts.scope] || [];
  const all = await getAccountDomainNameGroups(layouts, { groupBy: opts.groupBy || "domain_name" });
  const limit = Math.max(1, Math.min(Math.floor(opts.limit || 100), 500));
  const batch = all.slice(0, limit);
  const { buildMergePlan } = await import("./duplicateMergePlanner");
  const { executeMergePlan, zohoWritesAllowedInEnv } = await import("./duplicateMergeExecutor");
  if (!opts.dryRun && !zohoWritesAllowedInEnv()) {
    throw new Error("Live Zoho writes are disabled outside production.");
  }
  let merged = 0,
    accountsTagged = 0,
    reparentedDeals = 0,
    reparentedContacts = 0,
    namesPreserved = 0,
    errors = 0;
  for (const g of batch) {
    try {
      // Drop operator-EXCLUDED members (e.g. a Partner account in a 3-group) so
      // only the chosen set merges; the excluded ones are left untouched.
      const excludedSet = new Set(opts.excludes?.[g.key] ?? []);
      const zohoIds = [g.survivorZohoId, ...g.duplicateZohoIds].filter(
        (id) => !excludedSet.has(id),
      );
      if (zohoIds.length < 2) continue; // nothing left to merge after exclusions
      const recRes = await pool.query(
        `SELECT * FROM duplicate_records WHERE record_type = 'account' AND zoho_record_id = ANY($1::text[])`,
        [zohoIds],
      );
      const recs = recRes.rows as DuplicateRecord[];
      if (recs.length < 2) continue;
      // Honor an operator override (else keep the highest-% survivor) — but only
      // among INCLUDED members. We FORCE it as the engine's master so the
      // applied survivor == the previewed one.
      const overrideId = opts.overrides?.[g.key];
      const chosenSurvivorId =
        overrideId && zohoIds.includes(overrideId)
          ? overrideId
          : zohoIds.includes(g.survivorZohoId)
            ? g.survivorZohoId
            : (g.members.find((m) => zohoIds.includes(m.zohoId))?.zohoId ?? zohoIds[0]!);
      const survivorRow =
        recs.find((r) => (r as any).zoho_record_id === chosenSurvivorId) || recs[0];
      const clusterId = (survivorRow as any)?.cluster_id ?? (recs[0] as any)?.cluster_id;
      if (!clusterId) continue;
      const plan = buildMergePlan("Accounts", clusterId, recs, {
        masterZohoId: chosenSurvivorId,
      });
      if (plan.fieldDecisions.some((d) => d.field === "Description" && d.action === "fill")) {
        namesPreserved++;
      }
      const report = await executeMergePlan(plan, {
        performedBy: opts.performedBy,
        dryRun: opts.dryRun,
        // Leave the cluster open — it may carry other modules; the next sync
        // resolves it once every module's duplicates are tagged/merged.
        closeCluster: false,
      });
      accountsTagged += plan.duplicateZohoIds.length;
      reparentedDeals += report.reparented?.deals ?? 0;
      reparentedContacts += report.reparented?.contacts ?? 0;
      merged++;
    } catch (e) {
      errors++;
      logger.warn("[DuplicateRadar] account auto-merge group failed (non-fatal)", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return {
    scope: opts.scope,
    groups: batch.length,
    merged,
    accountsTagged,
    reparentedDeals,
    reparentedContacts,
    namesPreserved,
    remaining: Math.max(0, all.length - batch.length),
    errors,
  };
}

// ── Bulk link contacts → Account (Ahmad 2026-06-23) ──────────────────────────
// The remaining contact clusters are "chained matches": colleagues at the same
// company who are NOT duplicates of each other (they don't pairwise share ≥2 of
// {email, phone, name}). The productive action is to LINK them to the company's
// Account (set Account_Name) so they roll up under one customer — not merge.
// This bulk job does that link cascade for every cluster that has contacts and
// exactly ONE account (an unambiguous link target) AND no genuine duplicates.

export interface ContactLinkCandidate {
  clusterId: number;
  accountZohoId: string;
  accountName: string;
  contacts: number;
}

/** Active clusters with ≥1 contact and EXACTLY 1 account → unambiguous link. */
export async function getContactLinkCandidates(
  limit = 5000,
): Promise<ContactLinkCandidate[]> {
  const res = await pool.query<{
    cluster_id: number;
    contacts: string;
    account_zoho_id: string | null;
    account_name: string | null;
  }>(
    `SELECT dr.cluster_id,
            COUNT(*) FILTER (WHERE dr.record_type = 'contact') AS contacts,
            (ARRAY_AGG(dr.zoho_record_id) FILTER (WHERE dr.record_type = 'account'))[1] AS account_zoho_id,
            (ARRAY_AGG(COALESCE(NULLIF(btrim(dr.record_name),''), dr.company_name))
               FILTER (WHERE dr.record_type = 'account'))[1] AS account_name
       FROM duplicate_records dr
       JOIN duplicate_clusters dc ON dc.id = dr.cluster_id
      WHERE dc.status = 'active'
        AND dr.cluster_id IS NOT NULL
      GROUP BY dr.cluster_id
     HAVING COUNT(*) FILTER (WHERE dr.record_type = 'contact') >= 1
        AND COUNT(DISTINCT dr.zoho_record_id) FILTER (WHERE dr.record_type = 'account') = 1
        AND COUNT(*) FILTER (WHERE dr.record_type IN ('lead','deal')) = 0
      LIMIT $1`,
    [limit],
  );
  return res.rows
    .map((r) => ({
      clusterId: Number(r.cluster_id),
      accountZohoId: (r.account_zoho_id || "").trim(),
      accountName: (r.account_name || "").trim(),
      contacts: Number(r.contacts) || 0,
    }))
    .filter((c) => c.accountZohoId && Number.isFinite(c.clusterId));
}

/** Read-only preview: how many clusters / contacts the bulk link would touch. */
export async function previewContactLinkToAccount(): Promise<{
  clusters: number;
  contacts: number;
  sample: ContactLinkCandidate[];
}> {
  try {
    const cands = await getContactLinkCandidates();
    return {
      clusters: cands.length,
      contacts: cands.reduce((n, c) => n + c.contacts, 0),
      sample: cands.slice(0, 200),
    };
  } catch (e) {
    logger.warn("[DuplicateRadar] previewContactLinkToAccount failed (non-fatal)", {
      error: e instanceof Error ? e.message : String(e),
    });
    return { clusters: 0, contacts: 0, sample: [] };
  }
}

/**
 * Apply the bulk link: for each candidate cluster, set every contact's
 * Account_Name to the cluster's sole account (the Account_Name cascade). Skips
 * any cluster that actually has genuine contact duplicates (those belong in the
 * merge flow, not a blind link). Reuses buildMergePlan/executeMergePlan — no
 * tagging happens in link-only mode. Bounded by `limit`, re-runnable.
 */
export async function applyContactLinkToAccount(opts: {
  dryRun: boolean;
  limit?: number;
  performedBy: string;
}): Promise<{
  clusters: number;
  linked: number;
  contactsLinked: number;
  skippedHadDuplicates: number;
  remaining: number;
  errors: number;
  errorSample: string | null;
}> {
  const all = await getContactLinkCandidates();
  const limit = Math.max(1, Math.min(Math.floor(opts.limit || 50), 200));
  const batch = all.slice(0, limit);
  const { buildMergePlan } = await import("./duplicateMergePlanner");
  const { executeMergePlan, zohoWritesAllowedInEnv } = await import("./duplicateMergeExecutor");
  if (!opts.dryRun && !zohoWritesAllowedInEnv()) {
    throw new Error("Live Zoho writes are disabled outside production.");
  }
  let linked = 0,
    contactsLinked = 0,
    skippedHadDuplicates = 0,
    errors = 0;
  let errorSample: string | null = null;
  for (const cand of batch) {
    try {
      const recs = await getRecordsByClusterId(cand.clusterId);
      const plan = buildMergePlan("Contacts", cand.clusterId, recs, {
        linkAccountZohoId: cand.accountZohoId,
      });
      // Only link clusters that are link-only — if there are genuine duplicates,
      // leave the cluster for the merge flow (don't blindly link + risk hiding a
      // real dup).
      if (plan.duplicateZohoIds.length > 0) {
        skippedHadDuplicates++;
        continue;
      }
      const report = await executeMergePlan(plan, {
        performedBy: opts.performedBy,
        dryRun: opts.dryRun,
        // Contacts-only cluster (no leads/deals) — once the colleagues are
        // linked to their Account the cluster's job is done, so resolve it.
        // This also makes the batched apply CONVERGE: a resolved cluster drops
        // out of getContactLinkCandidates (active only), so the work set shrinks.
        closeCluster: true,
      });
      contactsLinked += report.reparented?.contacts ?? 0;
      linked++;
    } catch (e) {
      errors++;
      const msg = e instanceof Error ? e.message : String(e);
      if (!errorSample) errorSample = msg;
      logger.warn("[DuplicateRadar] bulk contact link group failed (non-fatal)", {
        clusterId: cand.clusterId,
        accountZohoId: cand.accountZohoId,
        error: msg,
      });
    }
  }
  return {
    clusters: batch.length,
    linked,
    contactsLinked,
    skippedHadDuplicates,
    remaining: Math.max(0, all.length - batch.length),
    errors,
    errorSample,
  };
}

/**
 * Resolve auto-merged contact clusters ONCE their tagged duplicates are
 * actually deleted in Zoho (Ahmad 2026-06-21). The bulk auto-merge marks a
 * cluster 'auto_merge_pending' (→ shows as "AI-Applied · pending Zoho admin
 * delete"). This pass writes the durable resolution-ledger entry only after
 * deletion-detection has removed EVERY tagged duplicate — so the cluster stays
 * pending until the admin truly deletes, then restoreLedgerResolvedClusterStatus
 * (run right after this) flips it to 'resolved'. Idempotent + best-effort.
 *
 * Guards against a full rebuild that reassigned db ids: it only resolves when
 * the survivor row still exists, so stale ids can't false-resolve a cluster.
 */
export async function reconcileAutoMergedContactDeletions(): Promise<number> {
  try {
    const pend = await pool.query<{
      id: number;
      primary_record_id: number | null;
      merged_record_ids: any;
      performed_by: string | null;
    }>(
      `SELECT id, primary_record_id, merged_record_ids, performed_by
         FROM duplicate_merge_actions
        WHERE action_type = 'auto_merge_pending'`,
    );
    let resolved = 0;
    for (const a of pend.rows) {
      const dupIds: number[] = Array.isArray(a.merged_record_ids)
        ? a.merged_record_ids
        : (() => {
            try {
              return JSON.parse(a.merged_record_ids);
            } catch {
              return [];
            }
          })();
      if (!dupIds.length || !a.primary_record_id) continue;
      // Survivor must still exist (a full rebuild would have reassigned ids;
      // don't false-resolve on stale references).
      const surv = await pool.query<{ zoho_record_id: string }>(
        `SELECT zoho_record_id FROM duplicate_records WHERE id = $1`,
        [a.primary_record_id],
      );
      const survivorZoho = surv.rows[0]?.zoho_record_id;
      if (!survivorZoho) continue;
      // Are ALL tagged duplicates gone (admin deleted them)?
      const still = await pool.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM duplicate_records WHERE id = ANY($1::int[])`,
        [dupIds],
      );
      if ((still.rows[0]?.n ?? 0) > 0) continue; // still pending — some dups remain
      // Deleted → record the true merge; the ledger-restore pass resolves it.
      await pool.query(
        `INSERT INTO duplicate_resolution_ledger
           (module, master_zoho_id, duplicate_zoho_ids, action_type, performed_by, notes, resolved_at)
         VALUES ('Contacts', $1, '[]'::jsonb, 'resolve', $2, 'bulk exact email+phone — admin deleted tagged dups', NOW())
         ON CONFLICT (module, master_zoho_id) WHERE master_zoho_id IS NOT NULL DO NOTHING`,
        [survivorZoho, a.performed_by || "auto-merge"],
      );
      // Convert the pending marker to a normal resolve marker so it isn't
      // re-checked and reads correctly in the Manual Actions log.
      await pool.query(
        `UPDATE duplicate_merge_actions SET action_type = 'module_resolved' WHERE id = $1`,
        [a.id],
      );
      resolved++;
    }
    if (resolved > 0) {
      logger.info(
        `🔁 [DuplicateRadar] Auto-merge: ${resolved} cluster(s) had their tagged dups deleted in Zoho → resolving`,
      );
    }
    return resolved;
  } catch (e) {
    logger.warn(
      `[DuplicateRadar] reconcileAutoMergedContactDeletions skipped (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
    );
    return 0;
  }
}

/**
 * Layer-2 of Sarah's "Mark Handled survives the 6h sync" fix (2026-06-16).
 *
 * Walk every status='active' cluster and flip it to status='resolved' when
 * EVERY module present in the cluster has a matching entry in
 * `duplicate_resolution_ledger` (keyed by the survivor's stable Zoho id +
 * module). Run this at the end of every scanZohoCRMForDuplicates pass —
 * right after updateClusterStats — so the cluster that the sync just
 * created for a previously-handled overlap doesn't show back up in the
 * Open queue under a fresh cluster_id.
 *
 * Mechanics: array-set inclusion. `modules_present` is what record_types
 * the cluster has; `modules_ledger_resolved` is the subset of those
 * record_types whose Zoho id is in the ledger for the matching module.
 * Since modules_ledger_resolved ⊆ modules_present by construction, equal
 * cardinalities mean every present module is covered.
 *
 * Best-effort + idempotent: replays don't move anything (only `status =
 * 'active'` rows are candidates). resolved_by is stamped "ledger-restore"
 * so the audit trail distinguishes auto-resolved from manual.
 */
export async function restoreLedgerResolvedClusterStatus(): Promise<{
  candidates_examined: number;
  clusters_restored: number;
}> {
  try {
    const examineQ = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM duplicate_clusters WHERE status = 'active'`,
    );
    const examined = Number(examineQ.rows[0]?.count ?? 0);

    const r = await pool.query<{ id: number }>(
      `WITH cluster_modules AS (
         SELECT cluster_id,
                array_agg(DISTINCT record_type)
                  FILTER (WHERE record_type IS NOT NULL)                       AS present,
                array_agg(DISTINCT record_type)
                  FILTER (WHERE EXISTS (
                    SELECT 1 FROM duplicate_resolution_ledger lg
                    WHERE lg.master_zoho_id = duplicate_records.zoho_record_id
                      AND lg.module = CASE duplicate_records.record_type
                                        WHEN 'lead'    THEN 'Leads'
                                        WHEN 'deal'    THEN 'Deals'
                                        WHEN 'contact' THEN 'Contacts'
                                        WHEN 'account' THEN 'Accounts'
                                      END
                      -- VERIFIED only (Sarah 2026-07-06): 'resolve' means Verify-in-CRM
                      -- confirmed the Duplicate-Delete records are gone. 'module_resolved'
                      -- (an apply that hasn't been verified yet) must NOT auto-resolve — it
                      -- stays in the AI-Applied queue until Verify moves it to Resolved.
                      AND lg.action_type = 'resolve'
                  ))                                                            AS resolved_modules
           FROM duplicate_records
          WHERE zoho_record_id IS NOT NULL
          GROUP BY cluster_id
       )
       UPDATE duplicate_clusters dc
          SET status      = 'resolved',
              resolved_by = COALESCE(dc.resolved_by, 'ledger-restore'),
              resolved_at = COALESCE(dc.resolved_at, NOW()),
              updated_at  = NOW()
         FROM cluster_modules cm
        WHERE dc.id = cm.cluster_id
          AND dc.status = 'active'
          AND COALESCE(array_length(cm.present, 1), 0) > 0
          AND COALESCE(array_length(cm.resolved_modules, 1), 0) =
              COALESCE(array_length(cm.present, 1), 0)
        RETURNING dc.id`,
    );
    const restored = r.rowCount ?? 0;
    if (restored > 0) {
      logger.info(
        `🔁 [DuplicateRadar] Ledger-restore: ${restored} cluster(s) flipped back to status='resolved' (of ${examined} active candidates)`,
      );
    }
    return { candidates_examined: examined, clusters_restored: restored };
  } catch (e) {
    logger.warn(
      "[DuplicateRadar] restoreLedgerResolvedClusterStatus skipped (non-fatal)",
      { error: e instanceof Error ? e.message : String(e) },
    );
    return { candidates_examined: 0, clusters_restored: 0 };
  }
}

// Hard reset for the "Rebuild Clusters" admin action.
// Wipes all clusters + records so the next scan starts from a clean slate.
export async function truncateAllDuplicateData(): Promise<void> {
  logger.info(
    "🧨 [DuplicateRadar] Truncating all duplicate data for rebuild...",
  );
  // CRITICAL: snapshot solved-state into the durable ledger BEFORE truncating.
  // The TRUNCATE ... CASCADE below deletes duplicate_merge_actions and resets
  // every cluster's status, so without this the per-module "solved" scoreboard
  // collapses to 0 on every rebuild (the bug Sarah hit). The ledger survives the
  // truncate and re-credits "solved" to whatever cluster each survivor lands in
  // after the rescan.
  await backfillResolutionLedger();
  await pool.query(
    "TRUNCATE duplicate_records, duplicate_clusters RESTART IDENTITY CASCADE",
  );
  logger.info("✅ [DuplicateRadar] Duplicate tables truncated");
}

export async function getClusterById(
  id: number,
): Promise<DuplicateCluster | null> {
  const result = await pool.query(
    "SELECT * FROM duplicate_clusters WHERE id = $1",
    [id],
  );
  return result.rows[0] || null;
}

export async function getRecordsByClusterId(
  clusterId: number,
): Promise<DuplicateRecord[]> {
  const result = await pool.query(
    "SELECT * FROM duplicate_records WHERE cluster_id = $1 ORDER BY is_primary DESC, created_date ASC",
    [clusterId],
  );
  return result.rows;
}

/**
 * Inspect a cluster's records and report any "mixed signal" — distinct
 * corporate domains or distinct normalized phone numbers found inside.
 * Two unrelated companies that share a generic name fragment can end up
 * in the same cluster (e.g. "Al Suwaidi Industrial Services" + "APEX
 * Industrial Services"). Surfacing this lets the operator review &
 * split before any merge/link is performed in Zoho.
 *
 * `domain_groups` maps each domain to the record IDs holding that
 * domain so the UI can offer a one-click "Split by domain" action.
 */
export async function getClusterMixedSignal(clusterId: number): Promise<{
  domains: string[];
  phones: string[];
  domain_groups: Record<string, number[]>;
}> {
  const records = await getRecordsByClusterId(clusterId);
  const domainGroups: Record<string, number[]> = {};
  const phoneSet = new Set<string>();
  for (const r of records) {
    const d = (r.domain || "").toLowerCase().trim();
    if (d && isCorporateDomain(d)) {
      if (!domainGroups[d]) domainGroups[d] = [];
      if (typeof r.id === "number") domainGroups[d].push(r.id);
    }
    const p = normalizePhone(r.phone || "");
    if (p && p.length >= 7) phoneSet.add(p);
  }
  return {
    domains: Object.keys(domainGroups).sort(),
    phones: Array.from(phoneSet).sort(),
    domain_groups: domainGroups,
  };
}

/**
 * Move a set of records out of `sourceClusterId` and into a freshly
 * created cluster. Returns both cluster IDs so the caller can recompute
 * stats and refresh the UI. The source cluster is left in place even if
 * it ends up empty — `updateClusterStats` will drive its counters to
 * zero and the existing orphan-cleanup pass will collect it later.
 */
/**
 * Transactional core of the cluster-split flow. Performs ONLY the
 * destructive writes (insert new cluster row + move records across) using
 * the supplied client, so callers can wrap multiple plans in a single
 * BEGIN/COMMIT and roll back on any failure.
 *
 * Stats refresh (confidence_score etc.) is intentionally NOT performed
 * here — it is idempotent and is run by the caller AFTER commit. This
 * keeps the transaction window small and avoids the heavy multi-query
 * stats recompute participating in the locking scope.
 *
 * Exported so the split route can compose plans atomically.
 */
export async function splitRecordsIntoNewClusterInTx(
  client: { query: (sql: string, params?: any[]) => Promise<any> },
  sourceClusterId: number,
  recordIds: number[],
  newClusterSeed: {
    company_name: string;
    domain?: string | null;
  },
): Promise<{ source_cluster_id: number; new_cluster_id: number }> {
  if (!Array.isArray(recordIds) || recordIds.length === 0) {
    throw new Error("recordIds must be a non-empty array");
  }

  // Pre-flight: every record must currently belong to the source cluster.
  // This catches concurrent splits/moves and prevents creating a fresh
  // cluster pointing at records that already drifted away.
  const ownership = await client.query(
    `SELECT id FROM duplicate_records
      WHERE cluster_id = $1 AND id = ANY($2::int[])`,
    [sourceClusterId, recordIds],
  );
  if (ownership.rows.length !== recordIds.length) {
    throw new Error(
      `Split aborted — ${recordIds.length - ownership.rows.length} record(s) no longer belong to cluster ${sourceClusterId} (concurrent move?)`,
    );
  }

  const companyNormalized = normalizeCompanyName(newClusterSeed.company_name);
  const seedDomain =
    newClusterSeed.domain ||
    companyNormalized.replace(/\s+/g, "-") + ".cluster";

  const inserted = await client.query(
    `INSERT INTO duplicate_clusters
       (domain, company_name, company_name_arabic, company_name_normalized,
        total_leads, total_deals, total_records, confidence_level,
        confidence_score, owners_involved, estimated_pipeline_value, status)
     VALUES ($1, $2, NULL, $3, 0, 0, 0, 'low', 0, '[]'::jsonb, 0, 'active')
     RETURNING id`,
    [seedDomain, newClusterSeed.company_name, companyNormalized],
  );
  const newClusterId = inserted.rows[0].id as number;

  await client.query(
    `UPDATE duplicate_records
        SET cluster_id = $1,
            is_primary = false
      WHERE cluster_id = $2
        AND id = ANY($3::int[])`,
    [newClusterId, sourceClusterId, recordIds],
  );

  // Clear stale "primary" flag on the source if its old primary just
  // moved out — leaves the source consistent until updateClusterStats
  // (post-commit) re-derives a new primary.
  await client.query(
    `UPDATE duplicate_records
        SET is_primary = false
      WHERE cluster_id = $1
        AND is_primary = true
        AND NOT EXISTS (
          SELECT 1 FROM duplicate_records dr2
           WHERE dr2.cluster_id = $1 AND dr2.is_primary = true
        )`,
    [sourceClusterId],
  );

  return {
    source_cluster_id: sourceClusterId,
    new_cluster_id: newClusterId,
  };
}

/**
 * Convenience single-plan wrapper that opens its own short-lived
 * transaction. Kept for ad-hoc / scripted use; the duplicates route
 * uses the lower-level `splitRecordsIntoNewClusterInTx` to batch
 * multiple plans atomically.
 */
export async function splitRecordsIntoNewCluster(
  sourceClusterId: number,
  recordIds: number[],
  newClusterSeed: {
    company_name: string;
    domain?: string | null;
  },
): Promise<{ source_cluster_id: number; new_cluster_id: number }> {
  const client = await (pool as any).connect();
  let result: { source_cluster_id: number; new_cluster_id: number };
  try {
    await client.query("BEGIN");
    result = await splitRecordsIntoNewClusterInTx(
      client,
      sourceClusterId,
      recordIds,
      newClusterSeed,
    );
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore rollback failure */
    }
    throw err;
  } finally {
    client.release();
  }
  // Stats refresh runs OUTSIDE the transaction — idempotent and
  // best-effort; failures here do not invalidate the split itself.
  try {
    await updateClusterStats(sourceClusterId);
    await updateClusterStats(result.new_cluster_id);
  } catch (e) {
    logger.warn("Post-split stats refresh failed (non-fatal)", e as any);
  }
  return result;
}

export async function getClusterSummary(): Promise<{
  totalClusters: number;
  totalDuplicateLeads: number;
  totalDuplicateDeals: number;
  highConfidence: number;
  mediumConfidence: number;
  lowConfidence: number;
  estimatedPipelineInflation: number;
  activeCount: number;
  resolvedCount: number;
}> {
  // A REAL duplicate cluster has ≥2 records (a 1-record "cluster" is a lone
  // company, NOT a duplicate). The module tabs already gate on ≥2; this brief
  // historically did COUNT(*) over ALL clusters incl. singletons, which massively
  // overstated the headline count + duplicate rate (Ahmad 2026-06-28). Gate on the
  // cluster's record count so the executive figure matches what the tabs show.
  const MULTI = `(COALESCE(dc.total_leads,0)+COALESCE(dc.total_deals,0)+COALESCE(dc.total_contacts,0)+COALESCE(dc.total_accounts,0)) >= 2`;
  const result = await pool.query(`
    WITH resolved_act AS (
      SELECT DISTINCT cluster_id FROM duplicate_merge_actions
       WHERE action_type IN ('resolve','module_resolved')
    )
    SELECT
      COUNT(*) as total_clusters,
      COALESCE(SUM(total_leads), 0) as total_leads,
      COALESCE(SUM(total_deals), 0) as total_deals,
      COUNT(*) FILTER (WHERE confidence_level = 'high') as high_confidence,
      COUNT(*) FILTER (WHERE confidence_level = 'medium') as medium_confidence,
      COUNT(*) FILTER (WHERE confidence_level = 'low') as low_confidence,
      COALESCE(SUM(estimated_pipeline_value), 0) as pipeline_inflation,
      COUNT(*) FILTER (WHERE dc.status = 'active' AND ra.cluster_id IS NULL) as active_count,
      COUNT(*) FILTER (WHERE dc.status = 'resolved' OR ra.cluster_id IS NOT NULL) as resolved_count
    FROM duplicate_clusters dc
    LEFT JOIN resolved_act ra ON ra.cluster_id = dc.id
    WHERE ${MULTI}
  `);

  const row = result.rows[0];
  return {
    totalClusters: parseInt(row.total_clusters) || 0,
    totalDuplicateLeads: parseInt(row.total_leads) || 0,
    totalDuplicateDeals: parseInt(row.total_deals) || 0,
    highConfidence: parseInt(row.high_confidence) || 0,
    mediumConfidence: parseInt(row.medium_confidence) || 0,
    lowConfidence: parseInt(row.low_confidence) || 0,
    estimatedPipelineInflation: parseFloat(row.pipeline_inflation) || 0,
    activeCount: parseInt(row.active_count) || 0,
    resolvedCount: parseInt(row.resolved_count) || 0,
  };
}

/**
 * "Total cleanup actions across ALL tabs" for the Executive Summary (Ahmad
 * 2026-06-30). The headline Resolution Rate only counts duplicate-cluster merges,
 * which made it look like barely anything was done when the team had also tagged
 * thousands of empty records and linked deals to accounts. This rolls up every
 * ACTION workstream so leadership sees the real total. Checks/monitoring tabs
 * (Deal Compliance, CS Lifecycle, Preflight) are NOT actions and are excluded.
 *
 * `total` is additive and NON-overlapping: duplicate resolved + dismissed +
 * Empty-Delete tagged + Account-Hints linked. `crossModuleHandled` is reported
 * separately (informational) — a cross-module overlap IS a duplicate cluster, so
 * its resolution is already inside `duplicatesResolved`; adding it would double-count.
 */
export async function getCleanupActionsSummary(): Promise<{
  duplicatesResolved: number;
  duplicatesDismissed: number;
  emptyDeleteTagged: number;
  accountHintsLinked: number;
  crossModuleHandled: number;
  total: number;
}> {
  // A real duplicate cluster has ≥2 records (mirror the headline gate).
  const MULTI = `(COALESCE(dc.total_leads,0)+COALESCE(dc.total_deals,0)+COALESCE(dc.total_contacts,0)+COALESCE(dc.total_accounts,0)) >= 2`;
  // ≥2 DISTINCT module types in the cluster = a cross-module overlap.
  const CROSS = `(( (dc.total_leads>0)::int + (dc.total_deals>0)::int + (dc.total_contacts>0)::int + (dc.total_accounts>0)::int ) >= 2)`;
  let duplicatesResolved = 0, duplicatesDismissed = 0, crossModuleHandled = 0;
  try {
    const r = await pool.query(`
      WITH resolved_act AS (
        SELECT DISTINCT cluster_id FROM duplicate_merge_actions
         WHERE action_type IN ('resolve','module_resolved')
      )
      SELECT
        COUNT(*) FILTER (WHERE (dc.status='resolved' OR ra.cluster_id IS NOT NULL)) AS resolved,
        COUNT(*) FILTER (WHERE dc.status='dismissed') AS dismissed,
        COUNT(*) FILTER (WHERE (dc.status='resolved' OR ra.cluster_id IS NOT NULL) AND ${CROSS}) AS cross_handled
      FROM duplicate_clusters dc
      LEFT JOIN resolved_act ra ON ra.cluster_id = dc.id
      WHERE ${MULTI}
    `);
    duplicatesResolved = parseInt(r.rows[0]?.resolved) || 0;
    duplicatesDismissed = parseInt(r.rows[0]?.dismissed) || 0;
    crossModuleHandled = parseInt(r.rows[0]?.cross_handled) || 0;
  } catch (e) {
    logger.warn("[getCleanupActionsSummary] duplicate counts failed (non-fatal)", e);
  }
  let emptyDeleteTagged = 0;
  try {
    const r = await pool.query(`SELECT COUNT(*)::int AS c FROM empty_delete_ledger`);
    emptyDeleteTagged = parseInt(r.rows[0]?.c) || 0;
  } catch (e) { /* table may not exist yet */ }
  let accountHintsLinked = 0;
  try {
    const r = await pool.query(`SELECT COUNT(*)::int AS c FROM account_inference_hints WHERE status='applied'`);
    accountHintsLinked = parseInt(r.rows[0]?.c) || 0;
  } catch (e) { /* table may not exist yet */ }
  const total = duplicatesResolved + duplicatesDismissed + emptyDeleteTagged + accountHintsLinked;
  return {
    duplicatesResolved,
    duplicatesDismissed,
    emptyDeleteTagged,
    accountHintsLinked,
    crossModuleHandled,
    total,
  };
}

// ─── Same-domain cluster duplicates (Sarah 2026-06-17) ────────────────
//
// Root cause: `duplicate_clusters.domain` is NOT covered by a UNIQUE
// constraint. Concurrent scans (or a deletion that happens between a
// SELECT and an INSERT in findOrCreateClusterByDomain) can both miss
// the existing row and BOTH insert one — producing two cluster rows
// with the EXACT same `domain` string. The operator finds the
// "duplicate-account-on-another-cluster" pattern when this happens.
//
// `findSameDomainClusterDuplicates()` finds every domain that has ≥2
// active clusters, groups the cluster rows together, and returns one
// row per group with enough detail for the operator to pick a master
// without opening every cluster modal.
//
// `mergeClustersIntoMaster()` is the structural counterpart: reparents
// every record from the source clusters to the target, captures a
// pre-merge snapshot per source (so the merge is undo-able), logs to
// duplicate_merge_actions, recomputes the target's stats, and deletes
// the now-empty source cluster rows. Idempotent within reason — a
// repeat call after success simply finds the source clusters empty and
// no-ops on them.

export interface SameDomainClusterGroup {
  domain: string;
  cluster_count: number;
  total_records: number;
  clusters: Array<{
    id: number;
    company_name: string | null;
    total_records: number;
    total_leads: number;
    total_deals: number;
    total_contacts: number;
    total_accounts: number;
    confidence_score: number;
    status: string;
    created_at: Date | null;
    has_account: boolean;
  }>;
}

/**
 * Find every domain that has ≥2 clusters with status='active' OR
 * status='resolved'. Sarah's view-time fix taught us to count
 * resolved clusters too — they still represent live Zoho records.
 * 'ignored' clusters (operator-dismissed false positives) are skipped
 * since merging them would resurrect a deliberate dismissal.
 *
 * Groups are sorted by total_records desc, then by domain asc, so the
 * biggest collisions surface first. Hard cap at 500 groups to keep
 * payloads bounded; the UI tells the operator when truncated.
 */
export async function findSameDomainClusterDuplicates(opts: {
  limit?: number;
  segment?: DuplicateFilters["segment"];
} = {}): Promise<{
  total_groups: number;
  truncated: boolean;
  groups: SameDomainClusterGroup[];
}> {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 200));

  // Segment chip (Sarah 2026-07-15): only surface domains that have ≥1 cluster
  // holding a record on the chosen Zoho Layout — same predicate as every tab.
  // $1 = limit+1, so segment bind params start at $2.
  const cmParams: any[] = [limit + 1];
  let cmSegExists = "";
  const cmSeg = buildSegmentPredicate(opts.segment, 2);
  if (cmSeg.condition) {
    cmSegExists = `        AND EXISTS (
          SELECT 1 FROM duplicate_records r
           WHERE r.cluster_id = duplicate_clusters.id AND ${cmSeg.condition}
        )\n`;
    cmParams.push(...cmSeg.params);
  }

  // PASS 1 — pick the offending domains. Hits the existing
  // idx_duplicate_clusters_domain btree so it's cheap even on 20k rows.
  // Strip placeholder/quarantine buckets here so they never reach the
  // UI as "merge candidates" (they'd never be safe to merge anyway).
  const groupsQ = await pool.query<{
    domain: string;
    cluster_count: string;
    total_records: string;
  }>(
    `SELECT domain,
            COUNT(*)::text AS cluster_count,
            SUM(total_records)::text AS total_records
       FROM duplicate_clusters
      WHERE status = 'active'
        AND domain IS NOT NULL
        AND domain <> ''
        AND domain <> '${PLACEHOLDER_CLUSTER_DOMAIN}'
        AND NOT (total_deals = total_records AND total_records > 0)
        AND EXISTS (
          SELECT 1 FROM duplicate_records dr2
           WHERE dr2.cluster_id = duplicate_clusters.id AND dr2.cleanup_class IS NULL
        )
${cmSegExists}      GROUP BY domain
     HAVING COUNT(*) > 1
      ORDER BY SUM(total_records) DESC, domain ASC
      LIMIT $1`,
    cmParams,
  );

  const truncated = groupsQ.rows.length > limit;
  const domains = groupsQ.rows.slice(0, limit).map((r) => r.domain);
  if (domains.length === 0) {
    return { total_groups: 0, truncated: false, groups: [] };
  }

  // PASS 2 — fetch every cluster for those domains in one round-trip.
  const detailQ = await pool.query<{
    id: number;
    domain: string;
    company_name: string | null;
    total_records: number;
    total_leads: number;
    total_deals: number;
    total_contacts: number;
    total_accounts: number;
    confidence_score: number;
    status: string;
    created_at: Date | null;
  }>(
    `SELECT id, domain, company_name, total_records,
            total_leads, total_deals, total_contacts, total_accounts,
            confidence_score, status, created_at
       FROM duplicate_clusters
      WHERE domain = ANY($1::text[])
        AND status = 'active'
        AND NOT (total_deals = total_records AND total_records > 0)
        AND EXISTS (
          SELECT 1 FROM duplicate_records dr2
           WHERE dr2.cluster_id = duplicate_clusters.id AND dr2.cleanup_class IS NULL
        )
      ORDER BY domain ASC, total_records DESC, id ASC`,
    [domains],
  );

  const byDomain = new Map<string, SameDomainClusterGroup>();
  for (const head of groupsQ.rows.slice(0, limit)) {
    byDomain.set(head.domain, {
      domain: head.domain,
      cluster_count: Number(head.cluster_count),
      total_records: Number(head.total_records),
      clusters: [],
    });
  }
  for (const row of detailQ.rows) {
    const g = byDomain.get(row.domain);
    if (!g) continue;
    g.clusters.push({
      id: Number(row.id),
      company_name: row.company_name,
      total_records: Number(row.total_records),
      total_leads: Number(row.total_leads),
      total_deals: Number(row.total_deals),
      total_contacts: Number(row.total_contacts),
      total_accounts: Number(row.total_accounts),
      confidence_score: Number(row.confidence_score),
      status: row.status,
      created_at: row.created_at,
      has_account: Number(row.total_accounts) > 0,
    });
  }
  // Drop domain-groups whose clusters were INTENTIONALLY separated (Sarah
  // 2026-07-14). When an operator Split/Dismissed two clusters, their records
  // are logged in duplicate_separation_ledger as keep-apart pairs — re-suggesting
  // a merge is exactly the "already decided, don't resurface" false positive we
  // removed on Cross-Module. A group survives only if it still has at least ONE
  // pair of clusters that is NOT separated (a genuinely mergeable pair); a group
  // that collapses to a single mergeable cluster is dropped too.
  const allGroups = Array.from(byDomain.values());
  const allClusterIds = allGroups.flatMap((g) => g.clusters.map((c) => c.id));
  if (allClusterIds.length > 0) {
    try {
      const recQ = await pool.query<{
        cluster_id: number;
        zoho_record_id: string;
      }>(
        `SELECT cluster_id, zoho_record_id FROM duplicate_records
          WHERE cluster_id = ANY($1::int[])
            AND zoho_record_id IS NOT NULL AND btrim(zoho_record_id) <> ''`,
        [allClusterIds],
      );
      const clusterOfZid = new Map<string, number>();
      for (const r of recQ.rows) {
        clusterOfZid.set(String(r.zoho_record_id), Number(r.cluster_id));
      }
      const sepQ = await pool.query<{
        zoho_id_low: string;
        zoho_id_high: string;
      }>(`SELECT zoho_id_low, zoho_id_high FROM duplicate_separation_ledger`);
      const separatedPairs = new Set<string>();
      for (const p of sepQ.rows) {
        const a = clusterOfZid.get(String(p.zoho_id_low));
        const b = clusterOfZid.get(String(p.zoho_id_high));
        if (a != null && b != null && a !== b) {
          separatedPairs.add(a < b ? `${a}|${b}` : `${b}|${a}`);
        }
      }
      if (separatedPairs.size > 0) {
        for (const g of allGroups) {
          const ids = g.clusters.map((c) => c.id);
          let hasMergeablePair = false;
          for (let i = 0; i < ids.length && !hasMergeablePair; i++) {
            for (let j = i + 1; j < ids.length; j++) {
              const key =
                ids[i] < ids[j] ? `${ids[i]}|${ids[j]}` : `${ids[j]}|${ids[i]}`;
              if (!separatedPairs.has(key)) {
                hasMergeablePair = true;
                break;
              }
            }
          }
          if (!hasMergeablePair) byDomain.delete(g.domain);
        }
      }
    } catch (e) {
      logger.warn(
        `[cluster-merge] separation-ledger filter skipped (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return {
    total_groups: byDomain.size,
    truncated,
    groups: Array.from(byDomain.values()),
  };
}

/**
 * Move every record from sourceClusterIds into targetClusterId,
 * snapshot each source pre-merge, log to duplicate_merge_actions, and
 * delete the now-empty source clusters. Transactional + idempotent.
 *
 * Safeguards:
 *   • target and source must all exist and be in status active/resolved
 *   • a source cannot equal the target
 *   • snapshots captured BEFORE the UPDATE so the merge is undo-able
 *   • final updateClusterStats run on the target so its rollups + owners
 *     reflect the merged record set.
 */
export async function mergeClustersIntoMaster(opts: {
  sourceClusterIds: number[];
  targetClusterId: number;
  performedBy: string;
  notes?: string;
}): Promise<{
  target_cluster_id: number;
  source_cluster_ids: number[];
  records_moved: number;
  source_clusters_deleted: number;
}> {
  const target = Number(opts.targetClusterId);
  const sources = Array.from(
    new Set(
      (opts.sourceClusterIds || [])
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n) && n > 0 && n !== target),
    ),
  );
  if (!Number.isFinite(target) || target <= 0) {
    throw new Error("mergeClustersIntoMaster: invalid targetClusterId");
  }
  if (sources.length === 0) {
    return {
      target_cluster_id: target,
      source_cluster_ids: [],
      records_moved: 0,
      source_clusters_deleted: 0,
    };
  }

  // Validate target exists + is mergeable
  const tgtQ = await pool.query(
    `SELECT id, status FROM duplicate_clusters WHERE id = $1`,
    [target],
  );
  if (tgtQ.rows.length === 0) {
    throw new Error(`mergeClustersIntoMaster: target cluster #${target} not found`);
  }
  if (!["active", "resolved"].includes(tgtQ.rows[0].status)) {
    throw new Error(
      `mergeClustersIntoMaster: target cluster #${target} is ${tgtQ.rows[0].status}, not active/resolved`,
    );
  }

  // Snapshot each source BEFORE the merge so undo is possible.
  for (const sid of sources) {
    await captureClusterSnapshot(sid, opts.performedBy, "pre_resolve", {
      notes: `Pre-merge snapshot — being merged into cluster #${target}.`,
    }).catch(() => { /* snapshot failure must not block the merge */ });
  }

  const client = await (pool as any).connect();
  let recordsMoved = 0;
  let deleted = 0;
  try {
    await client.query("BEGIN");

    // Move every record from each source to the target. Done one-by-one
    // so we can count rowCount per source for the audit log; sources
    // typically number ≤ a handful so this isn't a hot path.
    for (const sid of sources) {
      const moveQ = await client.query(
        `UPDATE duplicate_records
            SET cluster_id = $1, is_primary = false
          WHERE cluster_id = $2`,
        [target, sid],
      );
      recordsMoved += moveQ.rowCount ?? 0;
    }

    // Audit-log a single 'merge' row per source so the Manual Actions
    // tab + the Logs view show "who merged what into where".
    for (const sid of sources) {
      await client.query(
        `INSERT INTO duplicate_merge_actions
           (cluster_id, primary_record_id, merged_record_ids,
            action_type, performed_by, notes)
         VALUES ($1, NULL, '[]'::jsonb, $2, $3, $4)`,
        [
          sid,
          "cluster_merge",
          opts.performedBy,
          opts.notes ||
            `Merged source cluster #${sid} INTO master cluster #${target}.`,
        ],
      );
    }

    // Delete the now-empty source cluster rows.
    const delQ = await client.query(
      `DELETE FROM duplicate_clusters
        WHERE id = ANY($1::int[])
          AND NOT EXISTS (
            SELECT 1 FROM duplicate_records dr WHERE dr.cluster_id = duplicate_clusters.id
          )`,
      [sources],
    );
    deleted = delQ.rowCount ?? 0;

    await client.query("COMMIT");
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }

  // Recompute the target's rollups + owners now that its record set has
  // grown. Best-effort: a stats failure must not roll back the merge.
  try {
    await updateClusterStats(target);
  } catch (e) {
    logger.warn("[DuplicateRadar] mergeClustersIntoMaster: updateClusterStats failed (non-fatal)", {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  return {
    target_cluster_id: target,
    source_cluster_ids: sources,
    records_moved: recordsMoved,
    source_clusters_deleted: deleted,
  };
}

export async function getDuplicatesByOwner(): Promise<
  Array<{
    owner_name: string;
    owner_email: string;
    lead_count: number;
    deal_count: number;
    total_duplicates: number;
  }>
> {
  // 2026-06-17 — only count records whose cluster is still ACTIVE. Resolved
  // (merged) and ignored (dismissed) clusters are handled and must not keep
  // inflating an owner's outstanding-duplicate count on the Owner
  // Accountability tab.
  const result = await pool.query(`
    SELECT
      dr.owner_name,
      dr.owner_email,
      COUNT(*) FILTER (WHERE dr.record_type = 'lead') as lead_count,
      COUNT(*) FILTER (WHERE dr.record_type = 'deal') as deal_count,
      COUNT(*) as total_duplicates
    FROM duplicate_records dr
    JOIN duplicate_clusters dc ON dc.id = dr.cluster_id
    WHERE dr.owner_name IS NOT NULL
      AND dc.status = 'active'
    GROUP BY dr.owner_name, dr.owner_email
    ORDER BY total_duplicates DESC
  `);

  // Consolidate per OWNER_EMAIL_ALIASES so reps tagged on multiple mailboxes
  // (Rayan's three addresses, etc.) land in ONE row. Without this, Adam's
  // answers split a single rep into 3 — the dashboard already merges, but
  // every backend consumer needs the same treatment for parity.
  const { canonicaliseOwnerEmail } = await import("./ownerEmailAliases");
  const byCanonical = new Map<
    string,
    {
      owner_name: string;
      owner_email: string;
      lead_count: number;
      deal_count: number;
      total_duplicates: number;
    }
  >();
  for (const r of result.rows) {
    const rawEmail = String(r.owner_email || "");
    const canonical = canonicaliseOwnerEmail(rawEmail) || rawEmail.toLowerCase();
    const lead = parseInt(r.lead_count) || 0;
    const deal = parseInt(r.deal_count) || 0;
    const total = parseInt(r.total_duplicates) || 0;
    const existing = byCanonical.get(canonical);
    if (!existing) {
      byCanonical.set(canonical, {
        owner_name: r.owner_name,
        owner_email: canonical,
        lead_count: lead,
        deal_count: deal,
        total_duplicates: total,
      });
    } else {
      existing.lead_count += lead;
      existing.deal_count += deal;
      existing.total_duplicates += total;
    }
  }
  return Array.from(byCanonical.values()).sort(
    (a, b) => b.total_duplicates - a.total_duplicates,
  );
}

// CS Pipeline Overlap tab — active duplicate clusters that overlap a live CS
// customer, counted by verdict (block / review / warn). Powers Adam's
// cs-pipeline-overlap status answer.
export async function getCsOverlapVerdictCounts(): Promise<{
  block: number;
  review: number;
  warn: number;
  total: number;
}> {
  const r = await pool.query(
    `SELECT cs_overlap_verdict AS v, COUNT(*)::int AS n
       FROM duplicate_clusters
      WHERE cs_overlap_verdict IS NOT NULL
        AND status = 'active'
        AND total_records > 1
      GROUP BY cs_overlap_verdict`,
  );
  const out = { block: 0, review: 0, warn: 0, total: 0 };
  for (const row of r.rows) {
    const v = String(row.v || "").toLowerCase();
    if (v === "block") out.block = row.n;
    else if (v === "review") out.review = row.n;
    else if (v === "warn") out.warn = row.n;
    out.total += row.n;
  }
  return out;
}

export async function getDuplicatesBySource(): Promise<
  Array<{
    source: string;
    lead_count: number;
    deal_count: number;
    total: number;
  }>
> {
  // 2026-06-17 — "Duplicates by Source" was counting EVERY record (no cluster
  // join), so it showed ~90k for the whole CRM, not duplicates. And empty /
  // whitespace `source` values each became their own blank-labelled bar
  // because GROUP BY used the raw column while only NULL was coalesced.
  // Fixes: (a) count only records that belong to an ACTIVE duplicate cluster
  // (total_records > 1); (b) fold NULL/empty/whitespace into "Unknown" and
  // GROUP BY the same expression so there are no blank bars; (c) cap the long
  // tail into an "Other" bucket so the chart stays readable.
  const result = await pool.query(`
    SELECT
      COALESCE(NULLIF(TRIM(dr.source), ''), 'Unknown') AS source,
      COUNT(*) FILTER (WHERE dr.record_type = 'lead') AS lead_count,
      COUNT(*) FILTER (WHERE dr.record_type = 'deal') AS deal_count,
      COUNT(*) AS total
    FROM duplicate_records dr
    JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
    WHERE dc.status = 'active' AND dc.total_records > 1
    GROUP BY COALESCE(NULLIF(TRIM(dr.source), ''), 'Unknown')
    ORDER BY total DESC
  `);
  const rows = result.rows.map((r) => ({
    source: r.source as string,
    lead_count: parseInt(r.lead_count) || 0,
    deal_count: parseInt(r.deal_count) || 0,
    total: parseInt(r.total) || 0,
  }));
  const TOP_N = 15;
  if (rows.length <= TOP_N) return rows;
  const top = rows.slice(0, TOP_N);
  const other = rows.slice(TOP_N).reduce(
    (acc, r) => ({
      source: "Other",
      lead_count: acc.lead_count + r.lead_count,
      deal_count: acc.deal_count + r.deal_count,
      total: acc.total + r.total,
    }),
    { source: "Other", lead_count: 0, deal_count: 0, total: 0 },
  );
  return [...top, other];
}

export async function updateClusterStatus(
  id: number,
  status: string,
): Promise<DuplicateCluster | null> {
  const result = await pool.query(
    "UPDATE duplicate_clusters SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *",
    [status, id],
  );
  return result.rows[0] || null;
}

export async function createDetectionLog(
  log: Omit<DuplicateDetectionLog, "id" | "created_at">,
): Promise<DuplicateDetectionLog> {
  const result = await pool.query(
    `INSERT INTO duplicate_detection_logs 
     (detection_type, total_records_scanned, total_clusters_found, total_duplicates_detected,
      high_confidence_count, medium_confidence_count, low_confidence_count,
      estimated_pipeline_inflation, detection_duration_ms, triggered_by, user_email, 
      status, error_message, detection_config, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING *`,
    [
      log.detection_type,
      log.total_records_scanned,
      log.total_clusters_found,
      log.total_duplicates_detected,
      log.high_confidence_count,
      log.medium_confidence_count,
      log.low_confidence_count,
      log.estimated_pipeline_inflation,
      log.detection_duration_ms,
      log.triggered_by,
      log.user_email,
      log.status,
      log.error_message,
      JSON.stringify(log.detection_config || {}),
      log.completed_at,
    ],
  );
  return result.rows[0];
}

export async function updateDetectionLog(
  id: number,
  updates: Partial<DuplicateDetectionLog>,
): Promise<DuplicateDetectionLog | null> {
  const setClauses: string[] = [];
  const params: any[] = [];
  let paramIndex = 1;

  if (updates.status !== undefined) {
    setClauses.push(`status = $${paramIndex++}`);
    params.push(updates.status);
  }
  if (updates.total_clusters_found !== undefined) {
    setClauses.push(`total_clusters_found = $${paramIndex++}`);
    params.push(updates.total_clusters_found);
  }
  if (updates.total_duplicates_detected !== undefined) {
    setClauses.push(`total_duplicates_detected = $${paramIndex++}`);
    params.push(updates.total_duplicates_detected);
  }
  if (updates.completed_at !== undefined) {
    setClauses.push(`completed_at = $${paramIndex++}`);
    params.push(updates.completed_at);
  }
  if (updates.detection_duration_ms !== undefined) {
    setClauses.push(`detection_duration_ms = $${paramIndex++}`);
    params.push(updates.detection_duration_ms);
  }
  if (updates.error_message !== undefined) {
    setClauses.push(`error_message = $${paramIndex++}`);
    params.push(updates.error_message);
  }

  if (setClauses.length === 0) return null;

  params.push(id);
  const result = await pool.query(
    `UPDATE duplicate_detection_logs SET ${setClauses.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
    params,
  );
  return result.rows[0] || null;
}

export async function getDetectionLogs(
  limit: number = 50,
): Promise<DuplicateDetectionLog[]> {
  const result = await pool.query(
    "SELECT * FROM duplicate_detection_logs ORDER BY created_at DESC LIMIT $1",
    [limit],
  );
  return result.rows;
}

export async function createExportLog(
  log: Omit<DuplicateExportLog, "id" | "created_at">,
): Promise<DuplicateExportLog> {
  const result = await pool.query(
    `INSERT INTO duplicate_export_logs 
     (export_type, filter_criteria, total_records_exported, file_format, exported_by, user_email)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      log.export_type,
      JSON.stringify(log.filter_criteria || {}),
      log.total_records_exported,
      log.file_format,
      log.exported_by,
      log.user_email,
    ],
  );
  return result.rows[0];
}

export async function clearMockData(): Promise<void> {
  await pool.query("DELETE FROM duplicate_records WHERE is_mock_data = true");
  await pool.query(`
    DELETE FROM duplicate_clusters 
    WHERE id NOT IN (SELECT DISTINCT cluster_id FROM duplicate_records WHERE cluster_id IS NOT NULL)
  `);
}

export async function getKPIMetrics(): Promise<{
  duplicateLeadRate: number;
  duplicateDealRate: number;
  domainsWithMultipleDeals: number;
  duplicateBySource: any[];
  duplicateByOwner: any[];
}> {
  const totalLeadsResult = await pool.query(`
    SELECT COUNT(*) as count FROM duplicate_records WHERE record_type = 'lead'
  `);
  const totalDealsResult = await pool.query(`
    SELECT COUNT(*) as count FROM duplicate_records WHERE record_type = 'deal'
  `);
  const duplicateLeadsResult = await pool.query(`
    SELECT COUNT(*) as count FROM duplicate_records dr
    JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
    WHERE dr.record_type = 'lead' AND dc.total_leads > 1 AND dr.is_primary = false
      AND dc.status = 'active'
  `);
  const duplicateDealsResult = await pool.query(`
    SELECT COUNT(*) as count FROM duplicate_records dr
    JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
    WHERE dr.record_type = 'deal' AND dc.total_deals > 1 AND dr.is_primary = false
      AND dc.status = 'active'
  `);
  const multiDealDomainsResult = await pool.query(`
    SELECT COUNT(*) as count FROM duplicate_clusters WHERE total_deals > 1 AND status = 'active'
  `);

  const totalLeads = parseInt(totalLeadsResult.rows[0].count) || 1;
  const totalDeals = parseInt(totalDealsResult.rows[0].count) || 1;
  const duplicateLeads = parseInt(duplicateLeadsResult.rows[0].count) || 0;
  const duplicateDeals = parseInt(duplicateDealsResult.rows[0].count) || 0;

  return {
    duplicateLeadRate: Math.round((duplicateLeads / totalLeads) * 100),
    duplicateDealRate: Math.round((duplicateDeals / totalDeals) * 100),
    domainsWithMultipleDeals:
      parseInt(multiDealDomainsResult.rows[0].count) || 0,
    duplicateBySource: await getDuplicatesBySource(),
    duplicateByOwner: await getDuplicatesByOwner(),
  };
}

export async function findOrCreateClusterByDomain(
  domain: string,
): Promise<DuplicateCluster> {
  const existing = await pool.query(
    "SELECT * FROM duplicate_clusters WHERE domain = $1",
    [domain],
  );

  if (existing.rows[0]) {
    return existing.rows[0];
  }

  return await createCluster({
    domain,
    total_leads: 0,
    total_deals: 0,
    total_contacts: 0,
    total_accounts: 0,
    total_records: 0,
    confidence_level: "medium",
    confidence_score: 75,
    status: "active",
  });
}

export async function updateClusterStats(clusterId: number): Promise<void> {
  const statsResult = await pool.query(
    `
    SELECT 
      COUNT(*) FILTER (WHERE record_type = 'lead') as lead_count,
      COUNT(*) FILTER (WHERE record_type = 'deal') as deal_count,
      COUNT(*) FILTER (WHERE record_type = 'contact') as contact_count,
      COUNT(*) FILTER (WHERE record_type = 'account') as account_count,
      COUNT(*) as total_count,
      COALESCE(SUM(deal_value), 0) as total_value,
      MIN(created_date) as first_date,
      MAX(COALESCE(modified_date, created_date)) as latest_date,
      ARRAY_AGG(DISTINCT owner_name) FILTER (WHERE owner_name IS NOT NULL) as owners
    FROM duplicate_records WHERE cluster_id = $1
  `,
    [clusterId],
  );

  const stats = statsResult.rows[0];
  const totalRecords = parseInt(stats.total_count) || 0;

  const records = await pool.query(
    "SELECT email, domain, phone, phone_normalized, company_name FROM duplicate_records WHERE cluster_id = $1 LIMIT 50",
    [clusterId],
  );

  let bestScore = 0;
  const allSignals = new Set<string>();
  const recs = records.rows;

  if (recs.length > 1) {
    for (let i = 0; i < Math.min(recs.length, 20); i++) {
      for (let j = i + 1; j < Math.min(recs.length, 20); j++) {
        const match = calculateMultiSignalScore(recs[i], recs[j]);
        if (match.score > bestScore) bestScore = match.score;
        match.signals.forEach((s) => allSignals.add(s));
      }
    }
  }

  // A cluster has 2+ records of the same type → classic same-module duplicate
  // (merge candidate). A cluster with multiple records but ≤1 per type is a
  // cross-module overlap (e.g. 1 Lead + 1 Account for the same company) — Zoho
  // does NOT support cross-module merges, so the action is CONVERT (lead →
  // contact under the existing account) or LINK (set Account_Name on the
  // deal/contact). Either way these are real cleanup work and must be surfaced
  // on the Cross-Module tab with a real confidence score, not buried at 0.
  // The Cross-Module Overlaps query (getCrossModuleOverlaps) already accepts
  // any cluster spanning 2+ record types regardless of score, so the only
  // thing the previous `confidenceScore = 0` did was sort these clusters to
  // the bottom and tag them as "legitimate_hierarchy" (a misleading label —
  // they need action, just not via merge).
  const leadCount = parseInt(stats.lead_count) || 0;
  const dealCount = parseInt(stats.deal_count) || 0;
  const contactCount = parseInt(stats.contact_count) || 0;
  const accountCount = parseInt(stats.account_count) || 0;
  const maxOfSameType = Math.max(
    leadCount,
    dealCount,
    contactCount,
    accountCount,
  );
  const isCrossModuleOnly = totalRecords > 1 && maxOfSameType <= 1;

  let confidenceScore: number;
  if (totalRecords <= 1) {
    confidenceScore = 0;
  } else if (bestScore > 0) {
    confidenceScore = bestScore;
  } else {
    confidenceScore = totalRecords > 3 ? 65 : 55;
  }
  if (isCrossModuleOnly) {
    // Tag for the Cross-Module tab + the cluster-detail modal verdict logic.
    // Keep the legacy signal too so any historic dashboard filter still works.
    allSignals.add("cross_module_link_candidate");
    allSignals.add("legitimate_hierarchy");
  }

  const inflationResult = await pool.query(
    `
    SELECT COALESCE(SUM(deal_value), 0) as inflation
    FROM duplicate_records
    WHERE cluster_id = $1 AND record_type = 'deal' AND is_primary = false AND deal_value > 0
  `,
    [clusterId],
  );
  const pipelineInflation = parseFloat(inflationResult.rows[0]?.inflation) || 0;

  const primaryCheck = await pool.query(
    "SELECT COUNT(*) as cnt FROM duplicate_records WHERE cluster_id = $1 AND is_primary = true",
    [clusterId],
  );
  if (parseInt(primaryCheck.rows[0].cnt) === 0 && totalRecords > 0) {
    const earliest = await pool.query(
      "SELECT id FROM duplicate_records WHERE cluster_id = $1 ORDER BY created_date ASC NULLS LAST LIMIT 1",
      [clusterId],
    );
    if (earliest.rows[0]) {
      await pool.query(
        "UPDATE duplicate_records SET is_primary = true WHERE id = $1",
        [earliest.rows[0].id],
      );
    }
  }

  await pool.query(
    `
    UPDATE duplicate_clusters SET
      total_leads = $1,
      total_deals = $2,
      total_contacts = $3,
      total_accounts = $4,
      total_records = $5,
      estimated_pipeline_value = $6,
      first_record_date = $7,
      latest_activity_date = $8,
      owners_involved = $9,
      confidence_score = $10,
      confidence_level = $11,
      match_signals = $12,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = $13
  `,
    [
      parseInt(stats.lead_count) || 0,
      parseInt(stats.deal_count) || 0,
      parseInt(stats.contact_count) || 0,
      parseInt(stats.account_count) || 0,
      totalRecords,
      pipelineInflation,
      stats.first_date,
      stats.latest_date,
      JSON.stringify(stats.owners || []),
      confidenceScore,
      confidenceScore === 0 ? "low" : getConfidenceLevel(confidenceScore),
      JSON.stringify(Array.from(allSignals)),
      clusterId,
    ],
  );
}

export interface DuplicateSearchParams {
  domain?: string;
  phone?: string;
  company_name?: string;
  contract_number?: string;
  email?: string;
  record_name?: string;
  owner_email?: string;
}

// A3: Fixed paramIndex bug for company_name
export async function searchDuplicates(params: DuplicateSearchParams): Promise<{
  records: DuplicateRecord[];
  clusters: DuplicateCluster[];
  total_records: number;
  search_params: DuplicateSearchParams;
}> {
  const conditions: string[] = [];
  const queryParams: any[] = [];
  let paramIndex = 1;

  if (params.domain?.trim()) {
    conditions.push(`LOWER(dr.domain) LIKE LOWER($${paramIndex++})`);
    queryParams.push(`%${params.domain.trim()}%`);
  }

  if (params.phone?.trim()) {
    conditions.push(
      `REGEXP_REPLACE(dr.phone, '[^0-9+]', '', 'g') LIKE $${paramIndex++}`,
    );
    queryParams.push(`%${params.phone.trim().replace(/[^0-9+]/g, "")}%`);
  }

  if (params.company_name?.trim()) {
    const pi = paramIndex++;
    conditions.push(
      `(LOWER(dr.company_name) LIKE LOWER($${pi}) OR LOWER(dc.company_name) LIKE LOWER($${pi}))`,
    );
    queryParams.push(`%${params.company_name.trim()}%`);
  }

  if (params.contract_number?.trim()) {
    conditions.push(`dr.zoho_record_id LIKE $${paramIndex++}`);
    queryParams.push(`%${params.contract_number.trim()}%`);
  }

  if (params.email?.trim()) {
    conditions.push(`LOWER(dr.email) LIKE LOWER($${paramIndex++})`);
    queryParams.push(`%${params.email.trim()}%`);
  }

  if (params.record_name?.trim()) {
    conditions.push(`LOWER(dr.record_name) LIKE LOWER($${paramIndex++})`);
    queryParams.push(`%${params.record_name.trim()}%`);
  }

  if (params.owner_email?.trim()) {
    conditions.push(`LOWER(dr.owner_email) LIKE LOWER($${paramIndex++})`);
    queryParams.push(`%${params.owner_email.trim()}%`);
  }

  if (conditions.length === 0) {
    return {
      records: [],
      clusters: [],
      total_records: 0,
      search_params: params,
    };
  }

  const whereClause = conditions.join(" OR ");

  const recordsResult = await pool.query(
    `
    SELECT dr.*, dc.domain as cluster_domain, dc.confidence_level, dc.total_records as cluster_total
    FROM duplicate_records dr
    LEFT JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
    WHERE ${whereClause}
    ORDER BY dr.confidence_score DESC, dr.created_at DESC
    LIMIT 200
  `,
    queryParams,
  );

  const clusterIds = [
    ...new Set(recordsResult.rows.map((r) => r.cluster_id).filter(Boolean)),
  ];

  let clustersData: DuplicateCluster[] = [];
  if (clusterIds.length > 0) {
    // 2026-06-17 — exclude already-handled clusters so dismissed
    // (status='ignored', e.g. an intentionally-separate Corporate vs
    // Marketplace account) and merged/resolved (status='resolved') clusters
    // never reappear in the Search "Related Clusters" cards. Only active,
    // still-actionable clusters surface here.
    const clustersResult = await pool.query(
      `
      SELECT * FROM duplicate_clusters
      WHERE id = ANY($1)
        AND status NOT IN ('ignored', 'resolved')
      ORDER BY total_records DESC
    `,
      [clusterIds],
    );
    clustersData = clustersResult.rows;
  }

  return {
    records: recordsResult.rows,
    clusters: clustersData,
    total_records: recordsResult.rows.length,
    search_params: params,
  };
}

// A1: Replaced destructive clear with incremental approach
//
// IMPORTANT: in incremental mode we deliberately do NOT call markStaleRecords()
// any more. The previous behaviour was unsafe: an incremental Zoho fetch only
// returns recently-modified records (or the most-recent N), so every untouched
// record would be marked stale and then purged by cleanupStaleRecords() —
// silently corrupting the radar over time. Records that were truly deleted in
// Zoho are now caught by the deletion-detection pass in the scan flow
// (fetchDeletedZohoRecords + removeRecordsByZohoIds).
export async function clearAllDuplicateData(): Promise<void> {
  const scanMode = process.env.DUPLICATE_SCAN_MODE || "incremental";
  if (scanMode === "full") {
    logger.info(
      "🗑️ [DuplicateRadar] FULL mode: Clearing all duplicate data for fresh Zoho import...",
    );
    await pool.query("DELETE FROM duplicate_records");
    await pool.query("DELETE FROM duplicate_clusters");
    logger.info("✅ [DuplicateRadar] All duplicate data cleared");
  } else {
    logger.info(
      "♻️ [DuplicateRadar] INCREMENTAL mode: relying on upserts + Zoho deletion detection (no stale-marking)",
    );
  }
}

// Purge records by their Zoho ID (used when Zoho reports them as deleted/merged).
// Returns the cluster IDs that lost records so the caller can re-score them.
export async function removeRecordsByZohoIds(
  zohoIds: string[],
  opts?: { module?: string },
): Promise<{ removedCount: number; affectedClusterIds: number[] }> {
  if (!zohoIds || zohoIds.length === 0) {
    return { removedCount: 0, affectedClusterIds: [] };
  }
  const params: any[] = [zohoIds];
  let where = "zoho_record_id = ANY($1::text[])";
  if (opts?.module) {
    params.push(opts.module);
    where += ` AND zoho_module = $${params.length}`;
  }
  const affected = await pool.query(
    `SELECT DISTINCT cluster_id FROM duplicate_records WHERE ${where} AND cluster_id IS NOT NULL`,
    params,
  );
  const affectedClusterIds = affected.rows
    .map((r) => r.cluster_id)
    .filter((v): v is number => v != null);
  const del = await pool.query(
    `DELETE FROM duplicate_records WHERE ${where}`,
    params,
  );
  const removedCount = del.rowCount || 0;
  if (removedCount > 0) {
    logger.info(
      `🗑️ [DuplicateRadar] Removed ${removedCount} record(s) deleted/merged in Zoho` +
        (opts?.module ? ` (${opts.module})` : "") +
        ` — ${affectedClusterIds.length} cluster(s) affected`,
    );
  }
  return { removedCount, affectedClusterIds };
}

// A1: Mark records as stale before incremental scan
export async function markStaleRecords(): Promise<number> {
  const result = await pool.query(`
    UPDATE duplicate_records SET match_signals = match_signals || '["stale_pending"]'::jsonb
    WHERE is_mock_data = false AND NOT (match_signals @> '["stale_pending"]'::jsonb)
  `);
  logger.info(`📌 [DuplicateRadar] Marked ${result.rowCount} records as stale`);
  return result.rowCount || 0;
}

/**
 * Targeted version of markStaleRecords for a single Zoho record id. Used by
 * the agentic merge executor when Zoho responds 400 "the related id given
 * seems to be invalid" — that record is already gone from Zoho and our
 * local copy is a ghost; tagging stale_pending hands it to the existing
 * cleanupStaleRecords sweep so the next tick purges it. Returns true if a
 * row was actually flipped (false = no local match, or already stale).
 */
export async function markRecordStalePending(
  module: string,
  zohoRecordId: string,
): Promise<boolean> {
  if (!zohoRecordId) return false;
  const result = await pool.query(
    `UPDATE duplicate_records
        SET match_signals = match_signals || '["stale_pending"]'::jsonb
      WHERE zoho_record_id = $1
        AND zoho_module    = $2
        AND is_mock_data   = false
        AND NOT (match_signals @> '["stale_pending"]'::jsonb)`,
    [zohoRecordId, module],
  );
  return (result.rowCount || 0) > 0;
}

/**
 * Mark specific duplicate_records rows (by primary-key id) stale_pending so the
 * cleanup sweep purges them. Used when a CRM re-check confirms a record was
 * deleted in Zoho (404) — e.g. the admin deleted a Duplicate-Delete duplicate,
 * so it should disappear from the (now-resolved) cluster, leaving the survivor.
 * Matches by id (not zoho_module, which can be null on legacy rows).
 */
export async function markRecordsStalePendingByIds(
  ids: number[],
): Promise<number> {
  const clean = (ids || []).filter((n) => Number.isFinite(n));
  if (clean.length === 0) return 0;
  const result = await pool.query(
    `UPDATE duplicate_records
        SET match_signals = COALESCE(match_signals, '[]'::jsonb) || '["stale_pending"]'::jsonb
      WHERE id = ANY($1::int[])
        AND is_mock_data = false
        AND NOT (match_signals @> '["stale_pending"]'::jsonb)`,
    [clean],
  );
  return result.rowCount || 0;
}

/**
 * One-shot purge of singleton clusters — `duplicate_clusters` rows with
 * `status = 'active'` and `total_records ≤ 1`. These are residue from
 * the engine speculatively creating a cluster for every incoming record's
 * domain even when no second record ever joined; they're not duplicates,
 * they bloat the table (~78k extra rows in Sarah's env on 2026-06-15),
 * and they dilute COUNT() queries. Today's Executive Summary fix already
 * excludes them from every operator-facing number — this helper is the
 * underlying data hygiene pass.
 *
 * Safety rails:
 *  - `dryRun` defaults TRUE — caller must pass `false` explicitly to write.
 *  - Audit + a 20-row sample come back BEFORE the delete so the caller
 *    can sanity-check what's about to disappear.
 *  - Refuses if candidateCount > maxDelete (default 100,000). A
 *    sudden spike past that is almost certainly a bug, not a
 *    cleanup target.
 *  - duplicate_records rows whose cluster_id points at one of the
 *    targets get their cluster_id cleared FIRST (inside the same
 *    transaction) so a future incremental scan can re-cluster them
 *    cleanly. Without this they'd FK-orphan or be deleted by cascade,
 *    depending on the schema.
 *  - Everything runs inside BEGIN / COMMIT — partial failure rolls
 *    back the whole thing.
 *
 * Returns the full result so the caller can log + surface counts.
 */
export interface SingletonCleanupResult {
  dryRun: boolean;
  candidateCount: number;
  sampleRows: Array<{
    id: number;
    domain: string | null;
    company_name: string | null;
    total_records: number;
    created_at: string | null;
  }>;
  pointedAtByRecordsCount: number;
  refusedReason: "over-limit" | "no-candidates" | null;
  cleanedRecordCount: number;
  deletedClusterCount: number;
  durationMs: number;
}

export async function cleanupSingletonClusters(
  opts: { dryRun?: boolean; maxDelete?: number } = {},
): Promise<SingletonCleanupResult> {
  const t0 = Date.now();
  const dryRun = opts.dryRun !== false;
  const maxDelete = Math.max(1, opts.maxDelete ?? 100000);

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM duplicate_clusters
      WHERE status = 'active' AND total_records <= 1`,
  );
  const candidateCount = countResult.rows[0]?.n ?? 0;

  if (candidateCount === 0) {
    return {
      dryRun,
      candidateCount: 0,
      sampleRows: [],
      pointedAtByRecordsCount: 0,
      refusedReason: "no-candidates",
      cleanedRecordCount: 0,
      deletedClusterCount: 0,
      durationMs: Date.now() - t0,
    };
  }

  const sampleResult = await pool.query(
    `SELECT id, domain, company_name, total_records, created_at
       FROM duplicate_clusters
      WHERE status = 'active' AND total_records <= 1
      ORDER BY created_at DESC NULLS LAST
      LIMIT 20`,
  );
  const sampleRows = sampleResult.rows.map((r: any) => ({
    id: Number(r.id),
    domain: r.domain ?? null,
    company_name: r.company_name ?? null,
    total_records: Number(r.total_records) || 0,
    created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
  }));

  const pointedResult = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM duplicate_records
      WHERE cluster_id IN (
        SELECT id FROM duplicate_clusters
         WHERE status = 'active' AND total_records <= 1
      )`,
  );
  const pointedAtByRecordsCount = pointedResult.rows[0]?.n ?? 0;

  if (candidateCount > maxDelete) {
    logger.warn(
      `🛑 [DuplicateRadar] cleanupSingletonClusters refused: ${candidateCount} candidates > maxDelete ${maxDelete}`,
    );
    return {
      dryRun,
      candidateCount,
      sampleRows,
      pointedAtByRecordsCount,
      refusedReason: "over-limit",
      cleanedRecordCount: 0,
      deletedClusterCount: 0,
      durationMs: Date.now() - t0,
    };
  }

  if (dryRun) {
    return {
      dryRun: true,
      candidateCount,
      sampleRows,
      pointedAtByRecordsCount,
      refusedReason: null,
      cleanedRecordCount: 0,
      deletedClusterCount: 0,
      durationMs: Date.now() - t0,
    };
  }

  const client = await pool.connect();
  let cleanedRecordCount = 0;
  let deletedClusterCount = 0;
  try {
    await client.query("BEGIN");
    const clearResult = await client.query(
      `UPDATE duplicate_records
          SET cluster_id = NULL
        WHERE cluster_id IN (
          SELECT id FROM duplicate_clusters
           WHERE status = 'active' AND total_records <= 1
        )`,
    );
    cleanedRecordCount = clearResult.rowCount || 0;
    const delResult = await client.query(
      `DELETE FROM duplicate_clusters
        WHERE status = 'active' AND total_records <= 1`,
    );
    deletedClusterCount = delResult.rowCount || 0;
    await client.query("COMMIT");
    logger.info(
      `🧹 [DuplicateRadar] cleanupSingletonClusters: deleted ${deletedClusterCount} clusters, cleared cluster_id on ${cleanedRecordCount} records`,
    );
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  return {
    dryRun: false,
    candidateCount,
    sampleRows,
    pointedAtByRecordsCount,
    refusedReason: null,
    cleanedRecordCount,
    deletedClusterCount,
    durationMs: Date.now() - t0,
  };
}

// A1: Remove records that were stale and not refreshed
export async function cleanupStaleRecords(): Promise<number> {
  const result = await pool.query(`
    DELETE FROM duplicate_records 
    WHERE match_signals @> '["stale_pending"]'::jsonb AND is_mock_data = false
  `);
  logger.info(
    `🧹 [DuplicateRadar] Cleaned up ${result.rowCount} stale records`,
  );
  return result.rowCount || 0;
}

// A1: Remove orphan clusters with no records
export async function cleanupOrphanClusters(): Promise<number> {
  const result = await pool.query(`
    DELETE FROM duplicate_clusters 
    WHERE id NOT IN (SELECT DISTINCT cluster_id FROM duplicate_records WHERE cluster_id IS NOT NULL)
  `);
  logger.info(
    `🧹 [DuplicateRadar] Cleaned up ${result.rowCount} orphan clusters`,
  );
  return result.rowCount || 0;
}

export function normalizeCompanyName(name: string): string {
  if (!name) return "";
  let n = name
    .toLowerCase()
    .replace(/[^\w\s\u0600-\u06FF]/g, " ")
    .replace(/\s+/g, " ")
    .replace(
      /\b(llc|ltd|inc|corp|corporation|company|group|holdings?|holding|co|sa|ksa|uae|ae)\b/gi,
      " ",
    );

  const arabicBoilerplate = [
    "شركة",
    "الشركة",
    "مؤسسة",
    "المؤسسة",
    "مجموعة",
    "المجموعة",
    "محدودة",
    "المحدودة",
    "القابضة",
    "قابضة",
    "للتجارة",
    "التجارية",
    "التجاري",
    "للمقاولات",
    "المقاولات",
    "للاستثمار",
    "الاستثمارية",
    "للخدمات",
    "الخدمات",
    "العامة",
    "المتحدة",
    "ذ.م.م",
    "ذمم",
    "ش.م.م",
    "شمم",
    "ش.م.ك",
    "شمك",
  ];
  const boilerplateRe = new RegExp(
    "(^|\\s)(" +
      arabicBoilerplate.map((w) => w.replace(/\./g, "\\.")).join("|") +
      ")(?=\\s|$)",
    "g",
  );
  n = n.replace(boilerplateRe, " ");

  return n.replace(/\s+/g, " ").trim();
}

// Free-mail providers we never treat as a "corporate domain" for the
// purpose of the conflict guard below. Mirrors the list already used in
// `src/utils/zohoCRM.ts`. Keep extending this if more providers appear.
const PUBLIC_EMAIL_DOMAINS = new Set<string>([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "ymail.com",
  "rocketmail.com",
  "hotmail.com",
  "hotmail.co.uk",
  "outlook.com",
  "live.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "mail.com",
  "protonmail.com",
  "proton.me",
  "yandex.com",
  "zoho.com",
  "gmx.com",
  "gmx.net",
  "qq.com",
  "163.com",
  "126.com",
]);

function isCorporateDomain(d: string | null | undefined): boolean {
  if (!d) return false;
  const norm = d.toLowerCase().trim();
  if (!norm) return false;
  return !PUBLIC_EMAIL_DOMAINS.has(norm);
}

// Placeholder / sentinel company names that CS users type into Zoho when the
// real company name is unknown. These should never form identity-bearing
// clusters — two unrelated records both named "N/A" are not duplicates of
// each other. Records with these names get routed to a single quarantine
// cluster so CS can fix the names at source rather than seeing the dashboard
// fan them out into bogus "duplicate" groups.
const PLACEHOLDER_COMPANY_NAMES = new Set<string>([
  // English
  "n/a", "na", "n.a", "n.a.",
  "unknown", "tbd", "tba", "pending",
  "test", "testing", "demo",
  "none", "null", "no name",
  "not provided", "not-provided", "notprovided",
  "not specified", "not available", "not applicable",
  "no company", "unknown company",
  "-", "--", "---", "0",
  // Arabic
  "لا يوجد", "لايوجد", "غير معروف", "غير محدد", "تجريبي",
  "لا شيء", "بدون اسم", "اختبار", "غير متوفر", "غير متاح",
  "لا يوجد حاليا", "لا يوجد حالياً", "غير موجود",
]);

// Lowercased array form for SQL `<> ALL(...)` filters (Domain Clusters hides
// placeholder-named clusters). Arabic is case-invariant, English entries are
// already lowercase, so LOWER(name) compares cleanly against this list.
const PLACEHOLDER_COMPANY_NAMES_LOWER_ARR: string[] = Array.from(
  PLACEHOLDER_COMPANY_NAMES,
).map((s) => s.toLowerCase());

const PLACEHOLDER_CLUSTER_DOMAIN = "_placeholder.cluster";

export function isPlaceholderName(
  name: string | null | undefined,
): boolean {
  if (!name) return true;
  const trimmed = name.trim();
  if (trimmed.length === 0) return true;
  const lower = trimmed.toLowerCase();
  if (PLACEHOLDER_COMPANY_NAMES.has(lower)) return true;
  if (PLACEHOLDER_COMPANY_NAMES.has(trimmed)) return true;
  return false;
}

/** The Zoho id of the (primary) Account record inside a matched cluster — used to
 * put a re-engagement Deal under the company we already have. Null if the cluster
 * has no account record. */
export async function getAccountZohoIdByCluster(clusterId: number): Promise<string | null> {
  if (!Number.isFinite(clusterId)) return null;
  const r = await pool.query(
    `SELECT zoho_record_id FROM duplicate_records
       WHERE cluster_id = $1 AND record_type = 'account'
         AND zoho_record_id IS NOT NULL AND btrim(zoho_record_id) <> ''
       ORDER BY is_primary DESC NULLS LAST, modified_date DESC NULLS LAST
       LIMIT 1`,
    [clusterId],
  );
  return r.rows[0]?.zoho_record_id ? String(r.rows[0].zoho_record_id) : null;
}

/** Resolve the Zoho id of an existing Account by domain (preferred) then by
 * exact normalized company name. Used by the Preflight Structured Push
 * "re-engage churned" action: churned clients are matched via the CS directory
 * (which sets no cluster_id in basic mode), so the existing Account must be
 * found the same way the match was — by domain / company name. Null if none. */
export async function getAccountZohoIdByDomainOrName(
  domain: string | null | undefined,
  companyName: string | null | undefined,
): Promise<string | null> {
  const dom = String(domain || "").trim().toLowerCase();
  if (dom) {
    const r = await pool.query(
      `SELECT zoho_record_id FROM duplicate_records
         WHERE record_type = 'account' AND LOWER(btrim(domain)) = $1
           AND zoho_record_id IS NOT NULL AND btrim(zoho_record_id) <> ''
         ORDER BY is_primary DESC NULLS LAST, modified_date DESC NULLS LAST
         LIMIT 1`,
      [dom],
    );
    if (r.rows[0]?.zoho_record_id) return String(r.rows[0].zoho_record_id);
  }
  const nm = String(companyName || "").trim().toLowerCase();
  if (nm && nm.length >= 3) {
    const r = await pool.query(
      `SELECT zoho_record_id FROM duplicate_records
         WHERE record_type = 'account'
           AND LOWER(btrim(COALESCE(record_name, company_name, ''))) = $1
           AND zoho_record_id IS NOT NULL AND btrim(zoho_record_id) <> ''
         ORDER BY is_primary DESC NULLS LAST, modified_date DESC NULLS LAST
         LIMIT 1`,
      [nm],
    );
    if (r.rows[0]?.zoho_record_id) return String(r.rows[0].zoho_record_id);
  }
  return null;
}

/** Load the ENTIRE existing-account directory in ONE query, indexed by domain
 * and by normalized name, for bulk existing-account matching. The Preflight
 * push enriches ~900 rows at once; doing a per-row SQL lookup was ~900
 * sequential scans (it hung the UI). This loads once, then callers match in
 * memory. Best row per key wins (primary, then most-recently-modified). */
export async function getAccountDirectory(): Promise<{
  byDomain: Map<string, { zohoId: string; name: string }>;
  byName: Map<string, { zohoId: string; name: string }>;
  byId: Map<string, { zohoId: string; name: string }>;
}> {
  const r = await pool.query(
    `SELECT zoho_record_id,
            LOWER(btrim(domain)) AS dom,
            LOWER(btrim(COALESCE(record_name, company_name, ''))) AS nm,
            COALESCE(NULLIF(btrim(record_name), ''), NULLIF(btrim(company_name), ''), '') AS disp
       FROM duplicate_records
      WHERE record_type = 'account'
        AND zoho_record_id IS NOT NULL AND btrim(zoho_record_id) <> ''
      ORDER BY is_primary DESC NULLS LAST, modified_date DESC NULLS LAST`,
  );
  const byDomain = new Map<string, { zohoId: string; name: string }>();
  const byName = new Map<string, { zohoId: string; name: string }>();
  const byId = new Map<string, { zohoId: string; name: string }>();
  for (const row of r.rows) {
    const ref = { zohoId: String(row.zoho_record_id), name: String(row.disp || "") };
    const dom = String(row.dom || "");
    const nm = String(row.nm || "");
    if (dom && !byDomain.has(dom)) byDomain.set(dom, ref);   // first = best (query is pre-ordered)
    if (nm && nm.length >= 3 && !byName.has(nm)) byName.set(nm, ref);
    if (!byId.has(ref.zohoId)) byId.set(ref.zohoId, ref);
  }
  return { byDomain, byName, byId };
}

/** Like getAccountZohoIdByDomainOrName but returns the account's display NAME
 * alongside its Zoho id, so the Preflight push can show a human-readable
 * "links to <Account>" instead of a bare id. Same domain→name match order. */
export async function getAccountRefByDomainOrName(
  domain: string | null | undefined,
  companyName: string | null | undefined,
): Promise<{ zohoId: string; name: string } | null> {
  const dom = String(domain || "").trim().toLowerCase();
  if (dom) {
    const r = await pool.query(
      `SELECT zoho_record_id, COALESCE(NULLIF(btrim(record_name), ''), NULLIF(btrim(company_name), ''), '') AS name
         FROM duplicate_records
         WHERE record_type = 'account' AND LOWER(btrim(domain)) = $1
           AND zoho_record_id IS NOT NULL AND btrim(zoho_record_id) <> ''
         ORDER BY is_primary DESC NULLS LAST, modified_date DESC NULLS LAST
         LIMIT 1`,
      [dom],
    );
    if (r.rows[0]?.zoho_record_id) return { zohoId: String(r.rows[0].zoho_record_id), name: String(r.rows[0].name || "") };
  }
  const nm = String(companyName || "").trim().toLowerCase();
  if (nm && nm.length >= 3) {
    const r = await pool.query(
      `SELECT zoho_record_id, COALESCE(NULLIF(btrim(record_name), ''), NULLIF(btrim(company_name), ''), '') AS name
         FROM duplicate_records
         WHERE record_type = 'account'
           AND LOWER(btrim(COALESCE(record_name, company_name, ''))) = $1
           AND zoho_record_id IS NOT NULL AND btrim(zoho_record_id) <> ''
         ORDER BY is_primary DESC NULLS LAST, modified_date DESC NULLS LAST
         LIMIT 1`,
      [nm],
    );
    if (r.rows[0]?.zoho_record_id) return { zohoId: String(r.rows[0].zoho_record_id), name: String(r.rows[0].name || "") };
  }
  return null;
}

/**
 * Returns true if `clusterId` already has at least one record whose
 * corporate domain differs from `candidateDomain`. Used as a guard so
 * that fuzzy / normalized-name matches do not fuse two unrelated
 * companies that happen to share a generic word ("Industrial Services",
 * "Trading", "Group" etc.).
 *
 * Public free-mail domains (gmail/yahoo/…) are ignored on both sides —
 * those cannot prove identity OR difference.
 */
async function clusterHasConflictingDomain(
  clusterId: number,
  candidateDomain: string,
): Promise<boolean> {
  if (!isCorporateDomain(candidateDomain)) return false;
  const candidate = candidateDomain.toLowerCase().trim();
  // Pull both the explicit domain column AND the email so we can derive
  // the corporate part of the email when Company_Domain is empty. Without
  // this, a cluster whose existing records have email-only identity
  // (Zoho Company_Domain blank) returns an empty conflict set and the
  // guard becomes a no-op.
  const res = await pool.query(
    `SELECT LOWER(domain) AS d, email
       FROM duplicate_records
      WHERE cluster_id = $1
        AND (
          (domain IS NOT NULL AND domain <> '')
          OR (email IS NOT NULL AND email <> '')
        )`,
    [clusterId],
  );
  const seen = new Set<string>();
  for (const row of res.rows) {
    const explicit = (row.d || "").trim();
    if (explicit && isCorporateDomain(explicit)) seen.add(explicit);
    const fromEmail = row.email ? extractDomain(row.email) : null;
    if (fromEmail && isCorporateDomain(fromEmail)) seen.add(fromEmail);
  }
  for (const d of seen) {
    if (d !== candidate) return true;
  }
  return false;
}

/**
 * One-shot cleanup: scan every existing Contacts cluster and retroactively
 * apply the ≥2-attribute strict rule. Contacts that fail the gate are split
 * into per-record stub clusters so the dashboard stops surfacing the
 * "7 SLB employees" false positives detected before the gate existed.
 *
 * Algorithm per cluster:
 *   1. Collect contact records (email, phone_normalized, lower record_name).
 *   2. Union-find: contacts A,B unite when they share ≥2 of the 3 keys.
 *   3. Whichever connected component is largest stays in the cluster.
 *   4. Every other component (and every singleton) gets split out via
 *      splitRecordsIntoNewClusterInTx — same code path as the manual
 *      split, so audit trail / primary-flag invariants are preserved.
 *
 * Returns per-cluster counts. dryRun=true returns the plan without writing.
 */
export async function bulkSplitContactClustersByStrictRule(opts: {
  dryRun?: boolean;
  performedBy: string;
  /** Hard cap on clusters processed in one call (default 500). */
  limit?: number;
}): Promise<{
  dryRun: boolean;
  clustersInspected: number;
  clustersSplit: number;
  recordsMoved: number;
  newClustersCreated: number;
  perCluster: Array<{
    cluster_id: number;
    contacts: number;
    components: number;
    largest_kept: number;
    split_out: number;
  }>;
}> {
  const dryRun = opts.dryRun !== false; // default safe: dry-run
  const limit = Math.max(1, Math.min(opts.limit || 500, 5000));

  // Source list: any cluster with ≥2 contacts. resolve()-d clusters are
  // skipped — historical merges already chose a survivor and we shouldn't
  // retroactively unpick that decision.
  const clusters = await pool.query(
    `SELECT dc.id, dc.company_name
       FROM duplicate_clusters dc
      WHERE dc.status = 'active'
        AND (
          SELECT COUNT(*) FROM duplicate_records dr
           WHERE dr.cluster_id = dc.id AND dr.record_type = 'contact'
        ) >= 2
      ORDER BY dc.id ASC
      LIMIT $1`,
    [limit],
  );

  const perCluster: Array<{
    cluster_id: number;
    contacts: number;
    components: number;
    largest_kept: number;
    split_out: number;
  }> = [];
  let clustersSplit = 0;
  let recordsMoved = 0;
  let newClustersCreated = 0;

  for (const cl of clusters.rows) {
    const recs = await pool.query(
      `SELECT id, email, phone_normalized, LOWER(record_name) AS lname, record_name
         FROM duplicate_records
        WHERE cluster_id = $1 AND record_type = 'contact'`,
      [cl.id],
    );
    const contacts = recs.rows;
    if (contacts.length < 2) continue;

    // Union-find — contacts A,B unite iff ≥2 of {email,phone,name} match.
    const parent = new Map<number, number>();
    const find = (x: number): number => {
      let r = x;
      while (parent.get(r) !== r) {
        const p = parent.get(r) as number;
        parent.set(r, parent.get(p) as number); // path compression
        r = parent.get(r) as number;
      }
      return r;
    };
    const union = (a: number, b: number) => {
      const ra = find(a),
        rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    for (const c of contacts) parent.set(c.id, c.id);
    for (let i = 0; i < contacts.length; i++) {
      for (let j = i + 1; j < contacts.length; j++) {
        const a = contacts[i],
          b = contacts[j];
        let matches = 0;
        if (a.email && b.email && String(a.email).toLowerCase() === String(b.email).toLowerCase())
          matches++;
        if (a.phone_normalized && b.phone_normalized && a.phone_normalized === b.phone_normalized)
          matches++;
        if (a.lname && b.lname && a.lname === b.lname) matches++;
        if (matches >= 2) union(a.id, b.id);
      }
    }

    // Group by root → components
    const components = new Map<number, number[]>();
    for (const c of contacts) {
      const root = find(c.id);
      if (!components.has(root)) components.set(root, []);
      components.get(root)!.push(c.id);
    }
    const componentList = Array.from(components.values()).sort(
      (a, b) => b.length - a.length,
    );
    // If everything is one component, nothing to split — the cluster is
    // already consistent with the strict rule (everyone really IS a dup).
    if (componentList.length <= 1) {
      perCluster.push({
        cluster_id: cl.id,
        contacts: contacts.length,
        components: 1,
        largest_kept: contacts.length,
        split_out: 0,
      });
      continue;
    }

    // Largest component stays in cluster; rest get split. Use real names
    // for the new cluster seed so the audit trail is readable.
    const [, ...toSplit] = componentList;
    let splitCountForCluster = 0;
    for (const recordIds of toSplit) {
      const firstRow = contacts.find((r) => r.id === recordIds[0]);
      const seedName =
        firstRow?.record_name ||
        `Split from cluster ${cl.id} — ${recordIds.length} contact(s)`;
      if (!dryRun) {
        try {
          const split = await splitRecordsIntoNewCluster(cl.id, recordIds, {
            company_name: seedName,
          });
          // record audit-log via duplicate_merge_actions so the Logs tab
          // surfaces the cleanup — action_type='split' so it doesn't
          // count toward the "tagged for delete" set in getTaggedRecordDbIdsByCluster.
          await pool.query(
            `INSERT INTO duplicate_merge_actions
              (cluster_id, primary_record_id, merged_record_ids, action_type, performed_by, notes)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              split.new_cluster_id,
              recordIds[0],
              JSON.stringify(recordIds),
              "split",
              opts.performedBy,
              `Bulk-split: ≥2-attribute rule cleanup. Moved ${recordIds.length} contact(s) from cluster #${cl.id}.`,
            ],
          );
          recordsMoved += recordIds.length;
          newClustersCreated++;
          splitCountForCluster += recordIds.length;
        } catch (e) {
          // Skip clusters that fail (e.g. concurrent move) — keep going.
          logger.warn(
            `[bulk-split-contacts] cluster ${cl.id} split skipped: ${(e as Error).message}`,
          );
        }
      } else {
        // dry-run accounting
        recordsMoved += recordIds.length;
        newClustersCreated++;
        splitCountForCluster += recordIds.length;
      }
    }
    if (splitCountForCluster > 0) clustersSplit++;
    perCluster.push({
      cluster_id: cl.id,
      contacts: contacts.length,
      components: componentList.length,
      largest_kept: componentList[0].length,
      split_out: splitCountForCluster,
    });
  }

  return {
    dryRun,
    clustersInspected: clusters.rows.length,
    clustersSplit,
    recordsMoved,
    newClustersCreated,
    perCluster,
  };
}

/**
 * Strict-match path for Contact records: two contacts are duplicates of each
 * other ONLY when they share AT LEAST 2 of {email, normalized phone, lower
 * record_name}. Sharing only the parent company / domain is not enough —
 * seven different employees at "Schlumberger" are seven different people,
 * not seven duplicates. Returns the existing cluster on a strict match, or
 * `null` when no contact in any cluster meets the bar (the caller then
 * creates a fresh single-record cluster for this contact).
 *
 * Cheap by design — one indexed scan over duplicate_records filtered on
 * record_type='contact' + an OR over the three identity columns, then a
 * per-row tally in JS. Only candidates that have at least ONE matching
 * field come back, so the worst case is a few rows.
 */
export async function findContactClusterByStrictMatch(
  recordName: string | undefined,
  email: string | undefined,
  phone: string | undefined,
): Promise<DuplicateCluster | null> {
  const normalizedEmail = (email || "").trim().toLowerCase();
  const normalizedPhone = phone ? normalizePhone(phone) : "";
  // Compare on the trimmed lowercased full name. Two contacts sharing only
  // a last name ("Smith") would single-attribute match and still fall short
  // of the ≥2 gate, so this stays a strong-but-not-absolute signal.
  const normalizedName = (recordName || "").trim().toLowerCase();

  // Need at least one identity field to even bother with the lookup.
  if (!normalizedEmail && !normalizedPhone && !normalizedName) return null;

  const candidates = await pool.query(
    `SELECT cluster_id, email, phone_normalized, LOWER(record_name) AS lname
       FROM duplicate_records
      WHERE record_type = 'contact'
        AND (
          ($1 <> '' AND LOWER(email) = $1)
          OR ($2 <> '' AND phone_normalized = $2)
          OR ($3 <> '' AND LOWER(record_name) = $3)
        )
      LIMIT 200`,
    [normalizedEmail, normalizedPhone, normalizedName],
  );

  for (const row of candidates.rows) {
    let matches = 0;
    if (
      normalizedEmail &&
      row.email &&
      String(row.email).toLowerCase() === normalizedEmail
    )
      matches++;
    if (
      normalizedPhone &&
      row.phone_normalized &&
      row.phone_normalized === normalizedPhone
    )
      matches++;
    if (normalizedName && row.lname && row.lname === normalizedName) matches++;
    if (matches >= 2) {
      const cluster = await pool.query(
        "SELECT * FROM duplicate_clusters WHERE id = $1",
        [row.cluster_id],
      );
      if (cluster.rows[0]) return cluster.rows[0];
    }
  }
  return null;
}

// B4: Fuzzy match using pg_trgm similarity() with fallback
// ─── Separation ledger (Ahmad 2026-06-20) ───────────────────────────────────
// Durable "not duplicates of each other" decisions from Split / Dismiss, so a
// later sync never re-fuses records the operator pulled apart.

function _sepPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

// Cache the set of Zoho ids that appear in ANY separation pair, so a full
// rebuild (50k+ records) does ONE lookup per sync instead of one per record:
// the vast majority of records aren't in the ledger, so we short-circuit
// getSeparatedZohoIds() without a query. Invalidated on every write; TTL is a
// backstop. Refreshed lazily.
let _sepParticipants: Set<string> | null = null;
let _sepParticipantsAt = 0;
const SEP_PARTICIPANTS_TTL_MS = 60_000;

export async function getSeparationParticipants(): Promise<Set<string>> {
  const now = Date.now();
  if (_sepParticipants && now - _sepParticipantsAt < SEP_PARTICIPANTS_TTL_MS) {
    return _sepParticipants;
  }
  const r = await pool
    .query(
      `SELECT zoho_id_low AS z FROM duplicate_separation_ledger
       UNION
       SELECT zoho_id_high AS z FROM duplicate_separation_ledger`,
    )
    .catch(() => ({ rows: [] as any[] }));
  _sepParticipants = new Set((r.rows || []).map((x: any) => x.z).filter(Boolean));
  _sepParticipantsAt = now;
  return _sepParticipants;
}

/**
 * Record separations: every pair of Zoho ids that ended up in DIFFERENT groups
 * becomes a permanent "do not cluster together" entry. Pass each resulting
 * group as its own array (a Split passes [survivors, movedOut, ...]; a Dismiss
 * passes one singleton group per record so all pairs are separated). Idempotent.
 */
export async function recordSeparations(
  groups: string[][],
  reason: "split" | "dismiss",
  createdBy: string,
): Promise<number> {
  const clean = groups.map((g) =>
    (g || []).map((z) => (z || "").trim()).filter(Boolean),
  );
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < clean.length; i++) {
    for (let j = i + 1; j < clean.length; j++) {
      for (const a of clean[i]) {
        for (const b of clean[j]) {
          if (a !== b) pairs.push(_sepPair(a, b));
        }
      }
    }
  }
  if (pairs.length === 0) return 0;
  let written = 0;
  for (const [low, high] of pairs) {
    const r = await pool
      .query(
        `INSERT INTO duplicate_separation_ledger (zoho_id_low, zoho_id_high, reason, created_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (zoho_id_low, zoho_id_high) DO NOTHING`,
        [low, high, reason, createdBy],
      )
      .catch(() => ({ rowCount: 0 }));
    written += (r as any)?.rowCount || 0;
  }
  _sepParticipants = null; // invalidate the participant cache after a write
  return written;
}

/**
 * All separated pairs as a Set of "low|high" keys — so a grouping pass can
 * exclude a group the operator DISMISSED as "not duplicates" (its members were
 * recorded as mutually separated) in one in-memory lookup. Separation is rare,
 * so the set is small. Best-effort (missing table → empty set).
 */
export async function getSeparationPairKeySet(): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const r = await pool.query<{ zoho_id_low: string; zoho_id_high: string }>(
      `SELECT zoho_id_low, zoho_id_high FROM duplicate_separation_ledger`,
    );
    for (const row of r.rows) {
      if (row.zoho_id_low && row.zoho_id_high) {
        out.add(row.zoho_id_low + "|" + row.zoho_id_high);
      }
    }
  } catch {
    /* ledger absent/empty → nothing separated */
  }
  return out;
}

/** All Zoho ids this record has been separated from (empty for the 99% case). */
export async function getSeparatedZohoIds(zohoId?: string): Promise<string[]> {
  if (!zohoId) return [];
  // Fast path: if this id isn't in any separation pair, skip the per-record
  // query entirely (the common case on a 50k-record sync).
  const participants = await getSeparationParticipants();
  if (!participants.has(zohoId)) return [];
  const r = await pool
    .query(
      `SELECT CASE WHEN zoho_id_low = $1 THEN zoho_id_high ELSE zoho_id_low END AS other
         FROM duplicate_separation_ledger
        WHERE zoho_id_low = $1 OR zoho_id_high = $1`,
      [zohoId],
    )
    .catch(() => ({ rows: [] as any[] }));
  return (r.rows || []).map((x: any) => x.other).filter(Boolean);
}

async function clusterContainsAnyZohoId(
  clusterId: number,
  zohoIds: string[],
): Promise<boolean> {
  if (!zohoIds.length) return false;
  const r = await pool
    .query(
      `SELECT 1 FROM duplicate_records
        WHERE cluster_id = $1 AND zoho_record_id = ANY($2::text[]) LIMIT 1`,
      [clusterId, zohoIds],
    )
    .catch(() => ({ rows: [] as any[] }));
  return (r.rows || []).length > 0;
}

export async function findOrCreateClusterByCompany(
  companyName: string,
  domain?: string,
  phone?: string,
  email?: string,
  // recordType + recordName are CONTACT-ONLY signals — when both are passed
  // and recordType === 'contact', the function delegates to the strict-match
  // path (≥2 of email/phone/name) instead of fusing on company / domain. For
  // every other module (Accounts / Leads / Deals) the legacy company-based
  // path is preserved verbatim — two records at the same company genuinely
  // are duplicates when the module is "Accounts".
  recordType?: "lead" | "deal" | "contact" | "account",
  recordName?: string,
  // The incoming record's Zoho id — when set, the separation ledger is honored
  // so a record the operator split/dismissed apart is never re-fused into a
  // cluster still holding a record it was separated from (Ahmad 2026-06-20).
  zohoRecordId?: string,
): Promise<DuplicateCluster> {
  // CONTACTS: bypass the company-name / domain branches and require ≥2
  // strict-match attributes (email / phone / name). Two contacts sharing
  // only "Schlumberger" are NOT duplicates — they're two different
  // employees. On no strict match, fall through to creating a fresh
  // single-record cluster (size 1 → invisible to the duplicates list).
  if (recordType === "contact") {
    const strict = await findContactClusterByStrictMatch(
      recordName,
      email,
      phone,
    );
    if (strict) return strict;
    // Build a per-contact stub cluster. Domain stays distinct so two stubs
    // never collide; the contact still gets a duplicate_records row so the
    // owner-accountability / coverage queries keep working.
    const stubDomain =
      `contact:${(email || phone || recordName || "anon").toLowerCase().replace(/\s+/g, "-")}.solo`;
    const existingStub = await pool.query(
      "SELECT * FROM duplicate_clusters WHERE domain = $1 LIMIT 1",
      [stubDomain],
    );
    if (existingStub.rows[0]) return existingStub.rows[0];
    return await createCluster({
      domain: stubDomain,
      company_name: recordName || companyName || "Single contact",
      total_leads: 0,
      total_deals: 0,
      total_contacts: 0,
      total_accounts: 0,
      total_records: 0,
      confidence_level: "low",
      confidence_score: 0,
      owners_involved: [],
      estimated_pipeline_value: 0,
      status: "active",
    });
  }

  const normalizedName = normalizeCompanyName(companyName);
  const normalizedPhone = phone ? normalizePhone(phone) : "";

  // Effective identity domain: prefer the explicit Company_Domain field, but
  // fall back to the corporate part of the email address. Without this fallback
  // a record whose Zoho Company_Domain is empty (but whose email is on a real
  // corporate domain) bypasses the conflict guard below and gets fused with
  // any same-named cluster — the root cause of mixed-cluster fan-outs on
  // generic Saudi/Arabic company names.
  const effectiveDomain = domain || (email ? extractDomain(email) : null);

  // Placeholder company names ("N/A", "لا يوجد", "TBD", …) are not identity
  // signals. Two records both named "N/A" are not duplicates of each other.
  // When we hit one, suppress the name-similarity branches entirely so the
  // record only fuses on real identity (domain / email / phone). If those
  // also fail, route the record to a single quarantine cluster instead of
  // creating one synthetic "n-a.cluster" per placeholder string.
  const placeholder = isPlaceholderName(companyName);

  // Durable separation guard. For records the operator split/dismissed apart,
  // skip any candidate cluster that still holds one of their separated records
  // and fall through to the next branch (ultimately a fresh cluster). Empty for
  // virtually every record → `notSeparatedFrom` is a no-op, zero added queries.
  const separatedIds = await getSeparatedZohoIds(zohoRecordId);
  // DIAGNOSTIC (Ahmad 2026-06-26): when an operator reports a dismissed/split
  // cluster "coming back", this confirms whether the ledger guard is actually
  // firing for the re-synced record. Only logs for the rare separated record,
  // so it's quiet in normal operation. No behaviour change.
  if (separatedIds.length > 0) {
    logger.info(
      `[DuplicateRadar][sep-guard] record ${zohoRecordId} (${recordType}, "${companyName}") is separated from ${separatedIds.length} id(s) — clusterer will refuse to re-fuse it`,
    );
  }
  const notSeparatedFrom = async (clu: any): Promise<boolean> =>
    separatedIds.length === 0
      ? true
      : !(await clusterContainsAnyZohoId(clu.id, separatedIds));

  if (domain) {
    const existingByDomain = await pool.query(
      "SELECT * FROM duplicate_clusters WHERE domain = $1",
      [domain],
    );
    if (existingByDomain.rows[0] && (await notSeparatedFrom(existingByDomain.rows[0]))) {
      // Same domain on the cluster row itself → identity is proven, no
      // need to run the conflict guard.
      return existingByDomain.rows[0];
    }
  }

  if (email) {
    const existingByEmail = await pool.query(
      `SELECT dc.* FROM duplicate_clusters dc
       JOIN duplicate_records dr ON dr.cluster_id = dc.id
       WHERE LOWER(dr.email) = LOWER($1) LIMIT 1`,
      [email],
    );
    if (existingByEmail.rows[0] && (await notSeparatedFrom(existingByEmail.rows[0]))) {
      return existingByEmail.rows[0];
    }
  }

  if (normalizedPhone && normalizedPhone.length >= 7) {
    const existingByPhone = await pool.query(
      `SELECT dc.* FROM duplicate_clusters dc
       JOIN duplicate_records dr ON dr.cluster_id = dc.id
       WHERE dr.phone_normalized = $1 LIMIT 1`,
      [normalizedPhone],
    );
    if (existingByPhone.rows[0] && (await notSeparatedFrom(existingByPhone.rows[0]))) {
      return existingByPhone.rows[0];
    }
  }

  // Only use a substring ILIKE shortcut when the normalized name is distinctive
  // enough (>= 5 chars). Short fragments like "شركة" or "ltd" (after partial
  // strips) used to match unrelated rows.
  if (!placeholder && normalizedName && normalizedName.length >= 5) {
    const existingByCompany = await pool.query(
      `SELECT * FROM duplicate_clusters 
       WHERE company_name_normalized = $1`,
      [normalizedName],
    );
    if (existingByCompany.rows[0]) {
      const candidate = existingByCompany.rows[0];
      // Domain conflict guard — calibrated, not absolute. Two unrelated
      // companies sharing a SHORT generic normalized name (e.g. "industrial
      // services", "alkhalij", "saudi group") with different corporate
      // domains are a real false-positive risk and must stay separate.
      // But LONG name matches (≥10 chars normalized) on different corporate
      // domains are far more likely to be a real duplicate where one record
      // has a stale, secondary, or typo'd domain — fuse them and let the
      // reviewer split via the UI if it's actually wrong.
      const domainsConflict =
        !!effectiveDomain &&
        isCorporateDomain(effectiveDomain) &&
        (await clusterHasConflictingDomain(candidate.id, effectiveDomain));
      const nameIsGeneric = normalizedName.length < 10;
      if (domainsConflict && nameIsGeneric) {
        // fall through to fuzzy step / new-cluster creation below
      } else if (await notSeparatedFrom(candidate)) {
        return candidate;
      }
    }
  }

  // B4: Try pg_trgm similarity() first, fallback to limited Levenshtein.
  // Threshold raised to 0.6 — at 0.4, unrelated Arabic LLCs sharing only the
  // boilerplate "شركة ... المحدودة" were being clustered together.
  // Name-only fuse floor (Sarah 2026-07-13 "Shell + شركة العالمية fused —
  // no overlap"). When NO corporate domain corroborates the match, a mere
  // 0.6 trgm on boilerplate Arabic tokens (شركة / مؤسسة / المحدودة /
  // للخدمات / العالمية) fused genuinely different firms into one synthetic
  // cluster. Require a STRONG name match to fuse purely on the name; a
  // corporate domain still lets 0.6 through (the domain corroborates).
  // Env-tunable; 0.85 default. Only affects NEW clustering — existing
  // mixed clusters need a Rebuild (or per-cluster "Split by domain").
  const nameOnlyMinSim = parseFloat(
    process.env.DUPLICATE_RADAR_NAME_ONLY_MIN_SIM || "0.85",
  );
  const haveCorporateDomain = !!(
    effectiveDomain && isCorporateDomain(effectiveDomain)
  );
  if (!placeholder && normalizedName && normalizedName.length > 2) {
    try {
      // Pull the top few candidates so the domain guard can skip a bad
      // top hit (e.g. "alsuwaidi industrial services") and still pick a
      // legitimate sibling further down the list.
      const trgmResult = await pool.query(
        `SELECT *, similarity(company_name_normalized, $1) as sim
         FROM duplicate_clusters
         WHERE company_name_normalized IS NOT NULL AND company_name_normalized != ''
           AND similarity(company_name_normalized, $1) >= 0.6
         ORDER BY sim DESC LIMIT 5`,
        [normalizedName],
      );
      for (const candidate of trgmResult.rows) {
        if (!(candidate.sim >= 0.6)) continue;
        // Calibrated domain guard: skip the candidate only when both the
        // name-similarity is borderline (< 0.85) AND the domains conflict.
        // A very high trgm similarity (≥ 0.85) is strong enough evidence
        // to override the domain mismatch — typically a stale / secondary
        // / typo'd domain on one of the records.
        if (
          candidate.sim < 0.85 &&
          haveCorporateDomain &&
          (await clusterHasConflictingDomain(candidate.id, effectiveDomain))
        ) {
          continue; // try next-best candidate
        }
        // No corporate domain to corroborate → demand a strong name match.
        if (!haveCorporateDomain && candidate.sim < nameOnlyMinSim) {
          continue;
        }
        if (!(await notSeparatedFrom(candidate))) continue;
        return candidate;
      }
    } catch {
      const fallbackLimit = Math.max(
        1,
        Number.parseInt(
          process.env.DUPLICATE_RADAR_FALLBACK_SCAN_LIMIT ?? "2000",
          10,
        ) || 2000,
      );
      const recentClusters = await pool.query(
        "SELECT * FROM duplicate_clusters ORDER BY updated_at DESC LIMIT $1",
        [fallbackLimit],
      );
      for (const cluster of recentClusters.rows) {
        const clusterNormalized = normalizeCompanyName(
          cluster.company_name || "",
        );
        if (
          clusterNormalized &&
          normalizedName &&
          clusterNormalized.length > 2 &&
          normalizedName.length > 2
        ) {
          const similarity = calculateSimilarity(
            clusterNormalized,
            normalizedName,
          );
          if (similarity >= 85) {
            // Calibrated domain guard for the Levenshtein fallback path —
            // matches the trgm path: only skip when name similarity is in
            // the 85–94 borderline band AND domains conflict. ≥95
            // overrides the domain mismatch.
            if (
              similarity < 95 &&
              haveCorporateDomain &&
              (await clusterHasConflictingDomain(cluster.id, effectiveDomain))
            ) {
              continue;
            }
            // Mirror the trgm name-only floor (as a percentage): with no
            // corporate domain to corroborate, demand a strong name match.
            if (!haveCorporateDomain && similarity < nameOnlyMinSim * 100) {
              continue;
            }
            if (!(await notSeparatedFrom(cluster))) continue;
            return cluster;
          }
        }
      }
    }
  }

  // Placeholder-named record with no real identity → quarantine bucket.
  // Look up the existing quarantine cluster before creating a new one so
  // every subsequent placeholder record fuses there instead of fanning out.
  if (placeholder && !domain) {
    const existing = await pool.query(
      "SELECT * FROM duplicate_clusters WHERE domain = $1 LIMIT 1",
      [PLACEHOLDER_CLUSTER_DOMAIN],
    );
    if (existing.rows[0]) return existing.rows[0];
    return await createCluster({
      domain: PLACEHOLDER_CLUSTER_DOMAIN,
      company_name: "[Placeholder names — needs CS review]",
      total_leads: 0,
      total_deals: 0,
      total_contacts: 0,
      total_accounts: 0,
      total_records: 0,
      confidence_level: "low",
      confidence_score: 0,
      status: "active",
    });
  }

  return await createCluster({
    domain: domain || normalizedName.replace(/\s+/g, "-") + ".cluster",
    company_name: companyName,
    total_leads: 0,
    total_deals: 0,
    total_contacts: 0,
    total_accounts: 0,
    total_records: 0,
    confidence_level: "low",
    confidence_score: 0,
    status: "active",
  });
}

export async function markPrimaryRecord(
  clusterId: number,
  recordId: number,
): Promise<boolean> {
  await pool.query(
    "UPDATE duplicate_records SET is_primary = false WHERE cluster_id = $1",
    [clusterId],
  );
  const result = await pool.query(
    "UPDATE duplicate_records SET is_primary = true WHERE id = $1 AND cluster_id = $2 RETURNING id",
    [recordId, clusterId],
  );
  return result.rows.length > 0;
}

/**
 * R10 — Freeze the current cluster + record state into duplicate_cluster_snapshots
 * so that future audit / dispute / forensic queries can see exactly what the
 * cluster looked like at the moment of an action.
 *
 * Best-effort by design: callers should wrap calls in try/catch but a thrown
 * snapshot error must NOT block the operator's primary action (resolve,
 * split, etc). Returns the new snapshot id on success or null on failure.
 *
 * Trigger labels currently in use:
 *   'pre_resolve' — before resolveCluster mutates status to resolved/ignored
 */
export async function captureClusterSnapshot(
  clusterId: number,
  takenBy: string,
  trigger: string,
  opts: { mergeActionId?: number | null; notes?: string | null } = {},
): Promise<number | null> {
  try {
    const clusterR = await pool.query(
      "SELECT * FROM duplicate_clusters WHERE id = $1",
      [clusterId],
    );
    if (clusterR.rows.length === 0) {
      logger.warn(
        `[duplicate-radar/snapshot] cluster ${clusterId} not found; skipping snapshot`,
      );
      return null;
    }
    const recordsR = await pool.query(
      "SELECT * FROM duplicate_records WHERE cluster_id = $1 ORDER BY is_primary DESC, id ASC",
      [clusterId],
    );
    const result = await pool.query<{ id: number }>(
      `INSERT INTO duplicate_cluster_snapshots
         (cluster_id, taken_by, trigger, merge_action_id,
          record_count, cluster_snapshot, records_snapshot, notes)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
       RETURNING id`,
      [
        clusterId,
        takenBy,
        trigger,
        opts.mergeActionId ?? null,
        recordsR.rows.length,
        JSON.stringify(clusterR.rows[0]),
        JSON.stringify(recordsR.rows),
        opts.notes ?? null,
      ],
    );
    return result.rows[0]?.id ?? null;
  } catch (err) {
    logger.warn(
      `[duplicate-radar/snapshot] failed to capture snapshot for cluster ${clusterId} (trigger=${trigger}): ${(err as Error).message}`,
    );
    return null;
  }
}

export interface ClusterSnapshotSummary {
  id: number;
  cluster_id: number | null;
  snapshot_at: Date;
  taken_by: string | null;
  trigger: string;
  merge_action_id: number | null;
  record_count: number;
  notes: string | null;
}

export interface ClusterSnapshotFull extends ClusterSnapshotSummary {
  cluster_snapshot: any;
  records_snapshot: any[];
}

export async function listClusterSnapshots(
  clusterId: number,
): Promise<ClusterSnapshotSummary[]> {
  const r = await pool.query<ClusterSnapshotSummary>(
    `SELECT id, cluster_id, snapshot_at, taken_by, trigger,
            merge_action_id, record_count, notes
       FROM duplicate_cluster_snapshots
      WHERE cluster_id = $1
      ORDER BY snapshot_at DESC`,
    [clusterId],
  );
  return r.rows;
}

export async function getClusterSnapshot(
  snapshotId: number,
): Promise<ClusterSnapshotFull | null> {
  const r = await pool.query(
    `SELECT id, cluster_id, snapshot_at, taken_by, trigger,
            merge_action_id, record_count, notes,
            cluster_snapshot, records_snapshot
       FROM duplicate_cluster_snapshots
      WHERE id = $1`,
    [snapshotId],
  );
  return (r.rows[0] as ClusterSnapshotFull) ?? null;
}

/**
 * Durable "solved" ledger write — keyed by STABLE Zoho identity (module +
 * survivor zoho id), NOT by cluster_id. Survives a Rebuild Clusters wipe so the
 * per-module "solved" scoreboard does not collapse to 0 on every rescan.
 * Best-effort — never throws to the caller. No-op without a master zoho id
 * (nothing stable to re-attribute after a rebuild).
 */
export async function recordResolutionLedgerEntry(params: {
  module: string;
  masterZohoId: string | null | undefined;
  duplicateZohoIds?: string[];
  actionType?: "resolve" | "module_resolved";
  performedBy?: string;
  notes?: string;
}): Promise<void> {
  const { module, masterZohoId } = params;
  if (!module || !masterZohoId) return;
  try {
    await pool.query(
      `INSERT INTO duplicate_resolution_ledger
         (module, master_zoho_id, duplicate_zoho_ids, action_type, performed_by, notes)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6)
       ON CONFLICT (module, master_zoho_id) WHERE master_zoho_id IS NOT NULL
       DO UPDATE SET
         duplicate_zoho_ids = EXCLUDED.duplicate_zoho_ids,
         action_type = EXCLUDED.action_type,
         performed_by = EXCLUDED.performed_by,
         notes = EXCLUDED.notes,
         resolved_at = NOW()`,
      [
        module,
        masterZohoId,
        JSON.stringify(params.duplicateZohoIds || []),
        params.actionType || "resolve",
        params.performedBy || null,
        params.notes || null,
      ],
    );
  } catch (e) {
    logger.warn("[DuplicateRadar] resolution-ledger write failed (non-fatal)", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

export async function resolveCluster(
  clusterId: number,
  action: "resolve" | "ignore",
  performedBy: string,
  primaryRecordId?: number,
  notes?: string,
): Promise<MergeAction | null> {
  // R10: freeze the cluster + records BEFORE any mutation, including the
  // markPrimaryRecord call below. If the operator changes the primary as
  // part of this resolve action, the forensic snapshot must reflect the
  // PRE-decision state ("here's what we had before they chose X as
  // primary") not the post-mutation state. Best-effort — a snapshot
  // failure must not block the operator's primary action.
  await captureClusterSnapshot(clusterId, performedBy, "pre_resolve", {
    notes:
      action === "resolve"
        ? "Pre-resolve snapshot taken when operator clicked Mark Resolved"
        : "Pre-ignore snapshot taken when operator clicked Ignore",
  });

  if (primaryRecordId) {
    await markPrimaryRecord(clusterId, primaryRecordId);
  }

  const nonPrimary = await pool.query(
    "SELECT id FROM duplicate_records WHERE cluster_id = $1 AND is_primary = false",
    [clusterId],
  );
  const mergedIds = nonPrimary.rows.map((r) => r.id);

  const result = await pool.query(
    `
    INSERT INTO duplicate_merge_actions (cluster_id, primary_record_id, merged_record_ids, action_type, performed_by, notes)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
  `,
    [
      clusterId,
      primaryRecordId || null,
      JSON.stringify(mergedIds),
      action,
      performedBy,
      notes || null,
    ],
  );

  const newStatus = action === "resolve" ? "resolved" : "ignored";
  // Clear the cached cs_overlap_verdict here too: it's only re-populated by the
  // next CS-overlap scan, and a resolved/ignored cluster must stop counting
  // toward CS-overlap totals/ARR immediately, not just be hidden by the list
  // query's `status = 'active'` filter. This UPDATE is reached only via the
  // resolve/ignore path (bulkResolve's "reopen" branch calls updateClusterStatus
  // instead), so reopen→active never runs through here and never gets nulled.
  await pool.query(
    "UPDATE duplicate_clusters SET status = $1, resolved_by = $2, resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, cs_overlap_verdict = NULL WHERE id = $3",
    [newStatus, performedBy, clusterId],
  );

  // Dismiss = "these are NOT duplicates of each other." Record every record in
  // the cluster as mutually separated so a future sync can't re-fuse them and
  // resurrect the dismissed cluster (Ahmad 2026-06-20). Each record is its own
  // group → recordSeparations() separates all pairs.
  if (action === "ignore") {
    try {
      const zr = await pool.query(
        `SELECT zoho_record_id FROM duplicate_records
          WHERE cluster_id = $1 AND zoho_record_id IS NOT NULL`,
        [clusterId],
      );
      const groups = zr.rows.map((r) => [r.zoho_record_id as string]);
      if (groups.length >= 2) {
        const n = await recordSeparations(groups, "dismiss", performedBy);
        logger.info(
          `[DuplicateRadar] Dismiss cluster ${clusterId}: recorded ${n} separation pair(s) so it won't re-cluster`,
        );
      }
    } catch (e) {
      logger.warn(
        `[DuplicateRadar] dismiss separation-ledger write skipped (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // Durable ledger write so this "Mark Resolved" survives a future Rebuild
  // Clusters wipe. Only 'resolve' counts as solved ('ignore' is a dismissal).
  // We key EACH present module to a record OF THAT MODULE (its primary if any,
  // else a representative) so the survivor's stable Zoho id re-attributes to
  // whatever cluster it lands in after a rescan. Best-effort.
  if (action === "resolve") {
    try {
      const recs = await pool.query(
        `SELECT id, record_type, zoho_record_id, is_primary
           FROM duplicate_records WHERE cluster_id = $1`,
        [clusterId],
      );
      const rtToModule: Record<string, string> = {
        lead: "Leads",
        deal: "Deals",
        contact: "Contacts",
        account: "Accounts",
      };
      const modules = new Set<string>();
      for (const r of recs.rows) {
        const m = rtToModule[r.record_type as string];
        if (m) modules.add(m);
      }
      for (const m of modules) {
        const modRecs = recs.rows.filter(
          (r) => rtToModule[r.record_type as string] === m && r.zoho_record_id,
        );
        if (modRecs.length === 0) continue;
        const modMaster =
          modRecs.find((r) => primaryRecordId && r.id === primaryRecordId) ||
          modRecs.find((r) => r.is_primary) ||
          modRecs[0];
        const modMasterZoho = modMaster.zoho_record_id as string;
        const dupZohoIds = modRecs
          .filter((r) => r.zoho_record_id && r.zoho_record_id !== modMasterZoho)
          .map((r) => r.zoho_record_id as string);
        await recordResolutionLedgerEntry({
          module: m,
          masterZohoId: modMasterZoho,
          duplicateZohoIds: dupZohoIds,
          actionType: "resolve",
          performedBy,
          notes: notes || "Mark Resolved",
        });
      }
    } catch (e) {
      logger.warn(
        "[DuplicateRadar] ledger write on resolveCluster failed (non-fatal)",
        { error: e instanceof Error ? e.message : String(e) },
      );
    }
  }

  return result.rows[0] || null;
}

export async function bulkResolve(
  clusterIds: number[],
  action: "resolve" | "ignore" | "reopen",
  performedBy: string,
): Promise<number> {
  let count = 0;
  for (const id of clusterIds) {
    if (action === "reopen") {
      // Re-open = set the cluster back to 'active' (recover a mistaken dismiss /
      // resolve). No Zoho changes — same as the per-cluster Re-open.
      await updateClusterStatus(id, "active");
    } else {
      await resolveCluster(id, action, performedBy);
    }
    count++;
  }
  return count;
}

/**
 * R3 — Post-merge verification.
 *
 * After an operator marks a cluster resolved (asserting they merged the
 * duplicates in Zoho), check whether Zoho actually has the non-primary
 * records gone. We do per-record `searchZohoRecords(module, id:equals:RID)`
 * lookups — returning 0 rows means the record no longer exists in Zoho
 * (it was merged, deleted, or moved).
 *
 * Returns a structured result. The caller decides what to do with it
 * (write back verification_state, flip status, notify operator).
 *
 * Why per-record search and not the /deleted feed: the deleted feed has
 * an indeterminate lag (Zoho documents "up to a few minutes") so it's
 * unreliable in the seconds immediately after a merge. A search-by-id
 * returns 204/empty within the same request as the operator's action.
 *
 * Concurrency: at most 4 records are checked in parallel to stay polite
 * with Zoho's rate limiter. Most clusters have 2–5 records so we don't
 * fan out further.
 */
export interface ClusterVerificationResult {
  verified: boolean;
  confirmed_deleted: number;
  still_present: number;
  errors: number;
  notes: string;
  per_record: Array<{
    record_id: number;
    zoho_record_id: string | null;
    module: string;
    status: "deleted" | "still_present" | "error" | "skipped";
    detail?: string;
  }>;
}

export async function verifyClusterMergedInZoho(
  clusterId: number,
): Promise<ClusterVerificationResult> {
  const { searchZohoRecords } = await import("./zohoCRM");

  const rowsR = await pool.query<{
    id: number;
    zoho_record_id: string | null;
    zoho_module: string | null;
    record_type: string | null;
    is_primary: boolean;
  }>(
    `SELECT id, zoho_record_id, zoho_module, record_type, is_primary
       FROM duplicate_records
      WHERE cluster_id = $1`,
    [clusterId],
  );

  // Only the non-primary records are expected to be gone in Zoho.
  const nonPrimary = rowsR.rows.filter((r) => !r.is_primary);

  if (nonPrimary.length === 0) {
    return {
      verified: true,
      confirmed_deleted: 0,
      still_present: 0,
      errors: 0,
      notes:
        "No non-primary records in this cluster; nothing to verify against Zoho.",
      per_record: [],
    };
  }

  // Map record_type → Zoho module name. Records carry zoho_module directly
  // when ingested via the scanner; fall back to type-based mapping for
  // older rows that don't have it.
  const moduleFor = (
    r: (typeof nonPrimary)[number],
  ): string | null => {
    if (r.zoho_module && r.zoho_module.trim()) return r.zoho_module.trim();
    const t = (r.record_type ?? "").trim().toLowerCase();
    if (t === "lead") return "Leads";
    if (t === "deal") return "Deals";
    if (t === "contact") return "Contacts";
    if (t === "account") return "Accounts";
    return null;
  };

  const concurrency = 4;
  const perRecord: ClusterVerificationResult["per_record"] = [];

  // Run lookups in batches to bound Zoho API pressure.
  for (let i = 0; i < nonPrimary.length; i += concurrency) {
    const batch = nonPrimary.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (r) => {
        if (!r.zoho_record_id) {
          return {
            record_id: r.id,
            zoho_record_id: null,
            module: r.record_type ?? "unknown",
            status: "skipped" as const,
            detail: "Record has no zoho_record_id (synthetic / pre-sync row)",
          };
        }
        const mod = moduleFor(r);
        if (!mod) {
          return {
            record_id: r.id,
            zoho_record_id: r.zoho_record_id,
            module: r.record_type ?? "unknown",
            status: "skipped" as const,
            detail: `Unknown Zoho module for record_type=${r.record_type}`,
          };
        }
        try {
          const found = await searchZohoRecords(
            mod,
            `(id:equals:${r.zoho_record_id})`,
          );
          if (!found || found.length === 0) {
            return {
              record_id: r.id,
              zoho_record_id: r.zoho_record_id,
              module: mod,
              status: "deleted" as const,
            };
          }
          return {
            record_id: r.id,
            zoho_record_id: r.zoho_record_id,
            module: mod,
            status: "still_present" as const,
            detail: `Zoho still has this ${mod.slice(0, -1)} record`,
          };
        } catch (err: any) {
          return {
            record_id: r.id,
            zoho_record_id: r.zoho_record_id,
            module: mod,
            status: "error" as const,
            detail: String(err?.message ?? err),
          };
        }
      }),
    );
    perRecord.push(...results);
  }

  const confirmed = perRecord.filter((p) => p.status === "deleted").length;
  const stillPresent = perRecord.filter(
    (p) => p.status === "still_present",
  ).length;
  const errors = perRecord.filter((p) => p.status === "error").length;
  const skipped = perRecord.filter((p) => p.status === "skipped").length;

  // "Verified" = every non-primary record we could check is gone, AND no
  // errors. Skipped records (no zoho id) don't fail verification but they
  // do mean we couldn't fully confirm.
  const verified = stillPresent === 0 && errors === 0;
  const noteParts: string[] = [];
  if (confirmed > 0) noteParts.push(`${confirmed} confirmed deleted in Zoho`);
  if (stillPresent > 0)
    noteParts.push(`${stillPresent} still present in Zoho`);
  if (errors > 0) noteParts.push(`${errors} lookup error(s)`);
  if (skipped > 0) noteParts.push(`${skipped} skipped (no zoho id)`);
  const notes =
    noteParts.length > 0 ? noteParts.join("; ") : "No records to verify.";

  const newState = verified ? "verified" : "failed";
  await pool.query(
    `UPDATE duplicate_clusters
        SET verification_state = $1,
            verification_at    = CURRENT_TIMESTAMP,
            verification_notes = $2,
            updated_at         = CURRENT_TIMESTAMP
      WHERE id = $3`,
    [newState, notes, clusterId],
  );

  return {
    verified,
    confirmed_deleted: confirmed,
    still_present: stillPresent,
    errors,
    notes,
    per_record: perRecord,
  };
}

export async function getMergeHistory(
  clusterId?: number,
  limit: number = 50,
): Promise<MergeAction[]> {
  let query = "SELECT * FROM duplicate_merge_actions";
  const params: any[] = [];
  if (clusterId) {
    query += " WHERE cluster_id = $1";
    params.push(clusterId);
  }
  query += " ORDER BY created_at DESC LIMIT $" + (params.length + 1);
  params.push(limit);
  const result = await pool.query(query, params);
  return result.rows;
}

/**
 * Enriched merge-history reader — joins duplicate_clusters to surface domain
 * + company_name + status alongside each action row. Powers the Logs tab UI
 * (a new "Manual Actions" sub-section) and Adam's manualActionAuditTool so
 * neither has to make a second hop per row.
 *
 * Filters:
 *   - clusterId      : single cluster
 *   - actionTypes    : narrow to one or more of resolve / ignore /
 *                      module_resolved / split / merge
 *   - performedByLike: substring match on the performed_by field
 *                      (e.g. "GRQ Assistant" to find agent actions, or an
 *                       operator's email)
 * Sorted by created_at DESC, capped at 500.
 */
export async function getMergeHistoryEnriched(opts: {
  clusterId?: number;
  actionTypes?: Array<MergeAction["action_type"]>;
  performedByLike?: string;
  limit?: number;
} = {}): Promise<MergeActionEnriched[]> {
  const lim = Math.max(1, Math.min(opts.limit ?? 100, 500));
  const where: string[] = [];
  const params: any[] = [];
  if (typeof opts.clusterId === "number") {
    params.push(opts.clusterId);
    where.push(`ma.cluster_id = $${params.length}`);
  }
  if (opts.actionTypes && opts.actionTypes.length > 0) {
    params.push(opts.actionTypes);
    where.push(`ma.action_type = ANY($${params.length}::text[])`);
  }
  if (opts.performedByLike && opts.performedByLike.trim()) {
    params.push(`%${opts.performedByLike.trim()}%`);
    where.push(`ma.performed_by ILIKE $${params.length}`);
  }
  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  params.push(lim);
  const limitParam = `$${params.length}`;
  const result = await pool.query(
    `SELECT ma.id, ma.cluster_id, ma.primary_record_id, ma.merged_record_ids,
            ma.action_type, ma.performed_by, ma.notes, ma.created_at,
            dc.domain        AS cluster_domain,
            dc.company_name  AS cluster_company_name,
            dc.status        AS cluster_status
       FROM duplicate_merge_actions ma
       LEFT JOIN duplicate_clusters dc ON dc.id = ma.cluster_id
       ${whereClause}
      ORDER BY ma.created_at DESC
      LIMIT ${limitParam}`,
    params,
  );
  return result.rows as MergeActionEnriched[];
}

/**
 * Append a merge_action row WITHOUT closing the cluster. Used for cross-module
 * clusters when a single-module Apply (e.g. Accounts) finishes — the merged
 * Accounts are tagged Duplicate-Delete in Zoho but the cluster stays open so
 * the operator can still resolve its Contacts/Deals/Leads. Without this log
 * row there is no record of which Accounts were already merged, so the next
 * Contact merge plan would surface the deleted SLB / Slb duplicates as link
 * targets in LINK SURVIVOR TO ACCOUNT.
 */
export async function recordPartialMergeAction(
  clusterId: number,
  primaryRecordId: number | null,
  mergedRecordIds: number[],
  performedBy: string,
  notes?: string,
): Promise<MergeAction | null> {
  const result = await pool.query(
    `INSERT INTO duplicate_merge_actions
       (cluster_id, primary_record_id, merged_record_ids, action_type, performed_by, notes)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      clusterId,
      primaryRecordId,
      JSON.stringify(mergedRecordIds || []),
      "module_resolved",
      performedBy,
      notes || null,
    ],
  );
  return result.rows[0] || null;
}

/**
 * Union of merged_record_ids (db ids) across every merge_action recorded on
 * the cluster — closing 'resolve' actions PLUS partial 'module_resolved'
 * actions. The merge planner uses this to drop already-tagged Accounts from
 * LINK SURVIVOR TO ACCOUNT in subsequent module Apply runs.
 */
export async function getTaggedRecordDbIdsByCluster(
  clusterId: number,
): Promise<number[]> {
  const result = await pool.query(
    `SELECT merged_record_ids FROM duplicate_merge_actions
       WHERE cluster_id = $1
         AND action_type IN ('resolve', 'module_resolved', 'auto_merge_pending')`,
    [clusterId],
  );
  const out = new Set<number>();
  for (const row of result.rows) {
    const raw = row.merged_record_ids;
    // JSONB column — node-postgres parses to JS, but accept stringified as a
    // belt-and-braces guard against schema drift / migration scripts.
    let arr: unknown = raw;
    if (typeof raw === "string") {
      try {
        arr = JSON.parse(raw);
      } catch {
        arr = [];
      }
    }
    if (Array.isArray(arr)) {
      for (const v of arr) {
        const n = typeof v === "number" ? v : parseInt(String(v), 10);
        if (Number.isFinite(n)) out.add(n);
      }
    }
  }
  return Array.from(out);
}

// C3: Enhanced owner accountability with RAG status against 2% KPI target.
// dc.status = 'active' is REQUIRED for parity with the packet route — without
// it, owners whose only clusters are archived/dismissed appear in the table
// with a Packet link but get an empty Action Items sheet (Cover still shows
// the stale duplicate counts). See pre-publish review MAJOR-1.
export async function getOwnerAccountability(): Promise<OwnerAccountability[]> {
  const result = await pool.query(`
    SELECT
      dr.owner_name,
      dr.owner_email,
      COUNT(*) as total_records,
      COUNT(*) FILTER (WHERE dc.total_records > 1 AND dr.is_primary = false) as duplicate_records,
      COUNT(DISTINCT dr.cluster_id) FILTER (WHERE dc.total_records > 1) as clusters_involved,
      COUNT(*) FILTER (WHERE dc.total_records > 1 AND dc.confidence_level = 'high' AND dr.is_primary = false) as high_confidence_duplicates,
      COALESCE(SUM(dr.deal_value) FILTER (WHERE dc.total_records > 1 AND dr.is_primary = false AND dr.record_type = 'deal'), 0) as estimated_waste_value
    FROM duplicate_records dr
    JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
    WHERE dr.owner_name IS NOT NULL
      AND dr.owner_name != 'Unknown'
      AND dc.status = 'active'
    GROUP BY dr.owner_name, dr.owner_email
    HAVING COUNT(*) FILTER (WHERE dc.total_records > 1 AND dr.is_primary = false) > 0
    ORDER BY duplicate_records DESC
  `);

  // Resolve owner → team via the SEED_USERS roster so the UI can render a
  // role badge without an extra round-trip. Lazy-imported to avoid pulling
  // the static seed list into modules that don't touch the owner scorecard.
  const { findSeedUser } = await import("../data/seedUsers");
  const { canonicaliseOwnerEmail } = await import("./ownerEmailAliases");

  // Aggregate by CANONICAL email so a single rep tagged on multiple
  // mailboxes (e.g. Rayan's three addresses) lands in ONE row, not three.
  // The map preserves insertion order so the SQL's ORDER BY (highest dup
  // count first) survives the consolidation.
  type Accum = {
    owner_name: string;
    owner_email: string;
    alias_emails: Set<string>;
    total_records: number;
    duplicate_records: number;
    clusters_involved: number;
    high_confidence_duplicates: number;
    estimated_waste_value: number;
  };
  const byCanonical = new Map<string, Accum>();
  for (const r of result.rows) {
    const rawEmail = String(r.owner_email || "");
    const canonical = canonicaliseOwnerEmail(rawEmail) || rawEmail.toLowerCase();
    const totalRecs = parseInt(r.total_records) || 0;
    const dupRecs = parseInt(r.duplicate_records) || 0;
    const clusters = parseInt(r.clusters_involved) || 0;
    const highConf = parseInt(r.high_confidence_duplicates) || 0;
    const waste = parseFloat(r.estimated_waste_value) || 0;
    const existing = byCanonical.get(canonical);
    if (!existing) {
      byCanonical.set(canonical, {
        owner_name: r.owner_name,
        owner_email: canonical,
        alias_emails: new Set(rawEmail ? [rawEmail.toLowerCase()] : []),
        total_records: totalRecs,
        duplicate_records: dupRecs,
        clusters_involved: clusters,
        high_confidence_duplicates: highConf,
        estimated_waste_value: waste,
      });
    } else {
      existing.total_records += totalRecs;
      existing.duplicate_records += dupRecs;
      existing.clusters_involved += clusters;
      existing.high_confidence_duplicates += highConf;
      existing.estimated_waste_value += waste;
      if (rawEmail) existing.alias_emails.add(rawEmail.toLowerCase());
    }
  }

  return Array.from(byCanonical.values()).map((a) => {
    const dupRate =
      a.total_records > 0
        ? Math.round((a.duplicate_records / a.total_records) * 1000) / 10
        : 0;
    // RAG bands (SDR-KPI-09): ≤2% green · 2–5% amber · >5% red. Matches
    // the dashboard's post-merge re-derive — single source of truth.
    let ragStatus: "green" | "amber" | "red" = "green";
    if (dupRate > 5) ragStatus = "red";
    else if (dupRate > 2) ragStatus = "amber";

    const seed = findSeedUser(a.owner_name);
    const team = (seed && seed.team) || "Unassigned";

    return {
      owner_name: a.owner_name,
      owner_email: a.owner_email,
      team,
      total_records: a.total_records,
      duplicate_records: a.duplicate_records,
      duplicate_rate: dupRate,
      clusters_involved: a.clusters_involved,
      high_confidence_duplicates: a.high_confidence_duplicates,
      estimated_waste_value: a.estimated_waste_value,
      rag_status: ragStatus,
    };
  });
}

export async function checkForDuplicates(params: {
  email?: string;
  phone?: string;
  company_name?: string;
}): Promise<{
  is_duplicate: boolean;
  confidence: number;
  signals: string[];
  matching_clusters: DuplicateCluster[];
  matching_records: DuplicateRecord[];
}> {
  const domain = params.email ? extractDomain(params.email) : null;
  const normalizedPhone = params.phone ? normalizePhone(params.phone) : "";
  const conditions: string[] = [];
  const queryParams: any[] = [];
  let idx = 1;

  if (params.email) {
    conditions.push(`LOWER(dr.email) = LOWER($${idx++})`);
    queryParams.push(params.email);
  }
  if (domain) {
    conditions.push(`dr.domain = $${idx++}`);
    queryParams.push(domain);
  }
  if (normalizedPhone && normalizedPhone.length >= 7) {
    conditions.push(`dr.phone_normalized = $${idx++}`);
    queryParams.push(normalizedPhone);
  }
  if (params.company_name) {
    conditions.push(`LOWER(dr.company_name) ILIKE LOWER($${idx++})`);
    queryParams.push(`%${params.company_name}%`);
  }

  if (conditions.length === 0) {
    return {
      is_duplicate: false,
      confidence: 0,
      signals: [],
      matching_clusters: [],
      matching_records: [],
    };
  }

  const result = await pool.query(
    `
    SELECT dr.*, dc.confidence_level, dc.confidence_score as cluster_confidence, dc.total_records as cluster_total
    FROM duplicate_records dr
    JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
    WHERE dc.status = 'active' AND (${conditions.join(" OR ")})
    ORDER BY dr.confidence_score DESC
    LIMIT 20
  `,
    queryParams,
  );

  if (result.rows.length === 0) {
    return {
      is_duplicate: false,
      confidence: 0,
      signals: [],
      matching_clusters: [],
      matching_records: [],
    };
  }

  const matchSignals: string[] = [];
  let bestScore = 0;
  for (const row of result.rows) {
    const match = calculateMultiSignalScore(
      {
        email: params.email,
        domain: domain || undefined,
        phone: params.phone,
        company_name: params.company_name,
      },
      {
        email: row.email,
        domain: row.domain,
        phone: row.phone,
        company_name: row.company_name,
      },
    );
    if (match.score > bestScore) bestScore = match.score;
    match.signals.forEach((s) => {
      if (!matchSignals.includes(s)) matchSignals.push(s);
    });
  }

  const clusterIds = [...new Set(result.rows.map((r) => r.cluster_id))];
  const clustersResult = await pool.query(
    "SELECT * FROM duplicate_clusters WHERE id = ANY($1)",
    [clusterIds],
  );

  return {
    is_duplicate: bestScore >= 50,
    confidence: bestScore,
    signals: matchSignals,
    matching_clusters: clustersResult.rows,
    matching_records: result.rows,
  };
}

// A2: Fixed low_confidence count — only clusters with total_records > 1, added singletonCount
/**
 * R4 — Duplicate creation-rate trend.
 *
 * Industry-standard leading indicator: count NEW DUPLICATE records created
 * per bucket (week or day) — "are bad-data inputs still flowing into Zoho
 * at the same rate, or is prevention work moving the needle?" Stakeholders
 * care about the slope, not the absolute count.
 *
 * Definition of "new duplicate":
 *   - A record (lead / deal / contact / account) whose created_date falls
 *     in the bucket AND whose cluster has total_records > 1 (so the record
 *     is actually a duplicate, not a singleton).
 *   - Both primary AND non-primary records count — both are "new records
 *     that ended up in a duplicate cluster", which is the input rate we
 *     want to track regardless of which one survives the merge.
 *
 * Also returns the per-bucket TOTAL record creation count so the UI can
 * render a duplicate-rate ratio (new_duplicates / new_records) — the
 * percentage that is the headline number for prevention effectiveness.
 *
 * Bucket size: 'week' (default) uses DATE_TRUNC('week', …) which Postgres
 * anchors on Monday. 'day' uses DATE_TRUNC('day', …). Anything else falls
 * back to 'week' silently.
 *
 * `weeks` caps the window. Default 12 weeks. Clamped to [1, 52] to keep
 * the query bounded.
 */
export interface DuplicateCreationTrendBucket {
  bucket_start: string; // ISO date 'YYYY-MM-DD'
  new_records: number;
  new_duplicates: number;
  duplicate_rate_pct: number; // 0-100, rounded to 1 decimal
}

export async function getDuplicateCreationTrend(opts: {
  weeks?: number;
  granularity?: "week" | "day";
} = {}): Promise<{
  granularity: "week" | "day";
  window_weeks: number;
  buckets: DuplicateCreationTrendBucket[];
}> {
  const weeks = Math.min(
    52,
    Math.max(1, Math.floor(Number(opts.weeks ?? 12) || 12)),
  );
  const granularity: "week" | "day" =
    opts.granularity === "day" ? "day" : "week";
  const trunc = granularity === "day" ? "day" : "week";

  // Single query with FILTER for the duplicate subset. DATE_TRUNC handles
  // the bucketing in Postgres so the result set is tiny (≤ 52 rows).
  const sql = `
    SELECT
      TO_CHAR(DATE_TRUNC('${trunc}', dr.created_date)::date, 'YYYY-MM-DD') AS bucket_start,
      COUNT(*)::int AS new_records,
      COUNT(*) FILTER (WHERE dc.total_records > 1)::int AS new_duplicates
    FROM duplicate_records dr
    JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
    WHERE dr.created_date >= NOW() - INTERVAL '${weeks} weeks'
      AND dr.created_date <= NOW()
    GROUP BY DATE_TRUNC('${trunc}', dr.created_date)
    ORDER BY bucket_start ASC
  `;
  const r = await pool.query<{
    bucket_start: string;
    new_records: number;
    new_duplicates: number;
  }>(sql);

  const buckets: DuplicateCreationTrendBucket[] = r.rows.map((row) => {
    const total = Number(row.new_records ?? 0);
    const dup = Number(row.new_duplicates ?? 0);
    const ratePct =
      total > 0 ? Math.round((dup / total) * 1000) / 10 : 0;
    return {
      bucket_start: row.bucket_start,
      new_records: total,
      new_duplicates: dup,
      duplicate_rate_pct: ratePct,
    };
  });

  return { granularity, window_weeks: weeks, buckets };
}

export async function getEnhancedSummary(): Promise<{
  totalClusters: number;
  trueDuplicateClusters: number;
  singletonCount: number;
  totalRecords: number;
  totalDuplicateLeads: number;
  totalDuplicateDeals: number;
  totalDuplicateContacts: number;
  totalDuplicateAccounts: number;
  highConfidence: number;
  mediumConfidence: number;
  lowConfidence: number;
  estimatedPipelineInflation: number;
  activeCount: number;
  resolvedCount: number;
  ignoredCount: number;
  resolutionRate: number;
  topSignals: Record<string, number>;
  duplicateLeadRate: number;
  duplicateDealRate: number;
  /** Whole-system duplicate rate — actionable duplicate records across ALL
   *  modules (Leads + Deals + Contacts + Accounts) over the total record
   *  count across all modules. The Executive Summary gauge uses this so the
   *  headline reflects every module's duplication, not just Leads. */
  duplicateOverallRate: number;
  topClustersByInflation: any[];
  lastScanInfo: any;
  /** ISO timestamp of the most recent successful sync across all modules
   *  (incremental OR full) — sourced from zoho_sync_state. Drives the
   *  "Last sync" line on the Executive Summary card. Distinct from
   *  lastScanInfo, which is the most recent FULL rebuild only. */
  lastSyncAt: string | null;
}> {
  const result = await pool.query(`
    WITH resolved_act AS (
      SELECT DISTINCT cluster_id FROM duplicate_merge_actions
       WHERE action_type IN ('resolve','module_resolved')
    )
    SELECT
      COUNT(*) as total_clusters,
      COUNT(*) FILTER (WHERE GREATEST(COALESCE(total_leads,0), COALESCE(total_deals,0), COALESCE(total_contacts,0), COALESCE(total_accounts,0)) > 1) as true_dup_clusters,
      COUNT(*) FILTER (WHERE total_records <= 1) as singleton_count,
      COALESCE(SUM(total_records), 0) as total_records,
      COALESCE(SUM(total_leads) FILTER (WHERE total_leads > 1), 0) as dup_leads,
      COALESCE(SUM(total_deals) FILTER (WHERE total_deals > 1), 0) as dup_deals,
      COALESCE(SUM(total_contacts) FILTER (WHERE total_contacts > 1), 0) as dup_contacts,
      COALESCE(SUM(total_accounts) FILTER (WHERE total_accounts > 1), 0) as dup_accounts,
      COUNT(*) FILTER (WHERE confidence_level = 'high' AND GREATEST(COALESCE(total_leads,0), COALESCE(total_deals,0), COALESCE(total_contacts,0), COALESCE(total_accounts,0)) > 1) as high_confidence,
      COUNT(*) FILTER (WHERE confidence_level = 'medium' AND GREATEST(COALESCE(total_leads,0), COALESCE(total_deals,0), COALESCE(total_contacts,0), COALESCE(total_accounts,0)) > 1) as medium_confidence,
      COUNT(*) FILTER (WHERE confidence_level = 'low' AND GREATEST(COALESCE(total_leads,0), COALESCE(total_deals,0), COALESCE(total_contacts,0), COALESCE(total_accounts,0)) > 1) as low_confidence,
      COALESCE(SUM(estimated_pipeline_value), 0) as pipeline_inflation,
      COUNT(*) FILTER (WHERE dc.status = 'active' AND ra.cluster_id IS NULL) as active_count,
      COUNT(*) FILTER (WHERE dc.status = 'resolved' OR ra.cluster_id IS NOT NULL) as resolved_count,
      COUNT(*) FILTER (WHERE dc.status = 'ignored' AND ra.cluster_id IS NULL) as ignored_count
    FROM duplicate_clusters dc
    LEFT JOIN resolved_act ra ON ra.cluster_id = dc.id
  `);

  const row = result.rows[0];
  const totalLeads = await pool.query(
    "SELECT COUNT(*) as cnt FROM duplicate_records WHERE record_type = 'lead'",
  );
  const totalDeals = await pool.query(
    "SELECT COUNT(*) as cnt FROM duplicate_records WHERE record_type = 'deal'",
  );
  const totalContacts = await pool.query(
    "SELECT COUNT(*) as cnt FROM duplicate_records WHERE record_type = 'contact'",
  );
  const totalAccounts = await pool.query(
    "SELECT COUNT(*) as cnt FROM duplicate_records WHERE record_type = 'account'",
  );
  const tLeads = parseInt(totalLeads.rows[0]?.cnt) || 1;
  const tDeals = parseInt(totalDeals.rows[0]?.cnt) || 1;
  const tContacts = parseInt(totalContacts.rows[0]?.cnt) || 1;
  const tAccounts = parseInt(totalAccounts.rows[0]?.cnt) || 1;

  // ACTIONABLE-only counts: records that should be merged/deleted to
  // deduplicate, i.e. dup-cluster members that are NOT the survivor.
  // The old "dup_leads" (SUM(total_leads) FILTER total_leads>1) counted
  // EVERY record in a dup cluster including the primary, which inflated
  // the rate from the actionable 43% to a misleading 58% and didn't
  // match the 2% target framing (the target is about records that need
  // action). Same applies to deals/contacts/accounts.
  const actionableResult = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE dr.record_type = 'lead'    AND dc.total_leads    > 1 AND dr.is_primary = false AND dc.status = 'active') AS act_leads,
      COUNT(*) FILTER (WHERE dr.record_type = 'deal'    AND dc.total_deals    > 1 AND dr.is_primary = false AND dc.status = 'active') AS act_deals,
      COUNT(*) FILTER (WHERE dr.record_type = 'contact' AND dc.total_contacts > 1 AND dr.is_primary = false AND dc.status = 'active') AS act_contacts,
      COUNT(*) FILTER (WHERE dr.record_type = 'account' AND dc.total_accounts > 1 AND dr.is_primary = false AND dc.status = 'active') AS act_accounts
    FROM duplicate_records dr
    JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
  `);
  const dupLeads = parseInt(actionableResult.rows[0]?.act_leads) || 0;
  const dupDeals = parseInt(actionableResult.rows[0]?.act_deals) || 0;
  const dupContacts = parseInt(actionableResult.rows[0]?.act_contacts) || 0;
  const dupAccounts = parseInt(actionableResult.rows[0]?.act_accounts) || 0;

  const signalResult = await pool.query(`
    SELECT match_signals FROM duplicate_clusters
    WHERE total_records > 1 AND match_signals IS NOT NULL AND status = 'active'
  `);
  const topSignals: Record<string, number> = {};
  for (const r of signalResult.rows) {
    const signals = Array.isArray(r.match_signals) ? r.match_signals : [];
    for (const s of signals) {
      if (s !== "stale_pending") topSignals[s] = (topSignals[s] || 0) + 1;
    }
  }

  // D4: Top 5 clusters by pipeline inflation (active only — excludes resolved/ignored false positives)
  const topClustersResult = await pool.query(`
    SELECT id, domain, company_name, estimated_pipeline_value, total_records, confidence_score
    FROM duplicate_clusters
    WHERE estimated_pipeline_value > 0 AND total_records > 1 AND status = 'active'
    ORDER BY estimated_pipeline_value DESC
    LIMIT 5
  `);

  // D4: Last scan info — most recent FULL rebuild (every row in
  //     duplicate_detection_logs corresponds to a complete corpus scan).
  const lastScanResult = await pool.query(`
    SELECT completed_at, detection_duration_ms, total_records_scanned, total_clusters_found, total_duplicates_detected
    FROM duplicate_detection_logs WHERE status = 'completed'
    ORDER BY completed_at DESC LIMIT 1
  `);

  // Most recent sync of ANY kind (incremental Sync Now / scheduled cron /
  // full rebuild) — taken from the per-module zoho_sync_state. This is
  // what the operator-facing "Last sync" line reflects. The incremental
  // syncs that landed via the inngest path between full rebuilds DO
  // update zoho_sync_state but not duplicate_detection_logs, which is
  // why the legacy Last-Scan card looked frozen on the last full
  // rebuild date. The query is a no-op if the table is empty.
  const lastSyncResult = await pool.query(`
    SELECT MAX(last_sync_at) AS last_sync_at FROM zoho_sync_state
  `);
  const lastSyncAt: string | null = lastSyncResult.rows[0]?.last_sync_at
    ? new Date(lastSyncResult.rows[0].last_sync_at).toISOString()
    : null;

  const totalClusters = parseInt(row.total_clusters) || 0;
  const resolvedCount = parseInt(row.resolved_count) || 0;
  const ignoredCount = parseInt(row.ignored_count) || 0;
  const trueDuplicateClusters = parseInt(row.true_dup_clusters) || 0;
  // Denominator is the universe of duplicate clusters we ever cared about:
  // open dup clusters + ones we've already resolved or ignored. Using
  // totalClusters here (which includes ~77k singletons) silently diluted
  // the rate to 0% even after hundreds of clusters were closed — singletons
  // are not duplicates and never were.
  const resolutionDenominator =
    trueDuplicateClusters + resolvedCount + ignoredCount;
  const resolutionRate =
    resolutionDenominator > 0
      ? Math.round(
          ((resolvedCount + ignoredCount) / resolutionDenominator) * 100,
        )
      : 0;

  return {
    totalClusters,
    trueDuplicateClusters,
    singletonCount: parseInt(row.singleton_count) || 0,
    totalRecords: parseInt(row.total_records) || 0,
    totalDuplicateLeads: dupLeads,
    totalDuplicateDeals: dupDeals,
    totalDuplicateContacts: dupContacts,
    totalDuplicateAccounts: dupAccounts,
    highConfidence: parseInt(row.high_confidence) || 0,
    mediumConfidence: parseInt(row.medium_confidence) || 0,
    lowConfidence: parseInt(row.low_confidence) || 0,
    estimatedPipelineInflation: parseFloat(row.pipeline_inflation) || 0,
    activeCount: parseInt(row.active_count) || 0,
    resolvedCount,
    ignoredCount,
    resolutionRate,
    topSignals,
    duplicateLeadRate: Math.round((dupLeads / tLeads) * 100),
    duplicateDealRate: Math.round((dupDeals / tDeals) * 100),
    duplicateOverallRate: Math.round(
      ((dupLeads + dupDeals + dupContacts + dupAccounts) /
        Math.max(1, tLeads + tDeals + tContacts + tAccounts)) *
        100,
    ),
    topClustersByInflation: topClustersResult.rows,
    lastScanInfo: lastScanResult.rows[0] || null,
    lastSyncAt,
  };
}

export async function getLastScanDate(): Promise<Date | null> {
  const result = await pool.query(
    "SELECT completed_at FROM duplicate_detection_logs WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1",
  );
  return result.rows[0]?.completed_at || null;
}

/**
 * Lightweight per-tab snapshot for the Executive Summary "at-a-glance"
 * scorecard. Fans out across every Duplicate Radar tab in parallel and
 * returns ONLY the headline figures (no row arrays) so the response
 * stays fast and small.
 *
 * Each tab returns its own `verdict` field — green / amber / red /
 * neutral — so the UI can colour the tile without re-deriving the
 * logic. The verdict thresholds match the same rules each tab uses
 * internally.
 *
 * Errors in any single tab are swallowed and returned as
 * `error: <message>` on that tab's slot so a slow Zoho dependency or
 * missing optional table never bricks the whole exec view.
 */
export interface RadarTabSnapshot {
  verdict: "green" | "amber" | "red" | "neutral";
  headline: string;
  metrics: Record<string, number | string>;
  error?: string;
}
export interface DuplicateRadarOverview {
  generatedAt: string;
  tabs: {
    leadDuplicates: RadarTabSnapshot;
    dealDuplicates: RadarTabSnapshot;
    contactDuplicates: RadarTabSnapshot;
    accountDuplicates: RadarTabSnapshot;
    crossModule: RadarTabSnapshot;
    csOverlap: RadarTabSnapshot;
    csLifecycle: RadarTabSnapshot;
    dealsLifecycle: RadarTabSnapshot;
    dealCompliance: RadarTabSnapshot;
    accountHints: RadarTabSnapshot;
    ownerAccountability: RadarTabSnapshot;
    logs: RadarTabSnapshot;
  };
}

async function _safeSnapshot(
  loader: () => Promise<RadarTabSnapshot>,
): Promise<RadarTabSnapshot> {
  try {
    return await loader();
  } catch (e: any) {
    return {
      verdict: "neutral",
      headline: "Snapshot unavailable",
      metrics: {},
      error: e?.message || String(e),
    };
  }
}

export async function getDuplicateRadarOverview(): Promise<DuplicateRadarOverview> {
  const generatedAt = new Date().toISOString();

  // 2026-06-17 — per-module duplicate snapshot for the at-a-glance grid so the
  // Executive Summary covers the 4 core duplicate tabs too (Lead / Deal /
  // Contact / Account Duplicates), not just the supporting tabs. `field` is a
  // fixed column name (never user input) so the interpolation is safe.
  const _moduleDupSnapshot = (
    field: "total_leads" | "total_deals" | "total_contacts" | "total_accounts",
    noun: string,
  ) =>
    _safeSnapshot(async () => {
      // Same lifecycle as the tabs: a cluster is "handled/resolved" when its
      // status is 'resolved' OR it carries a resolve/module_resolved action;
      // "open" = active and NOT resolved. The resolved-action set is computed
      // once (CTE) and hash-joined, so this stays cheap.
      const r = await pool.query(
        `WITH resolved_act AS (
           SELECT DISTINCT cluster_id FROM duplicate_merge_actions
            WHERE action_type IN ('resolve','module_resolved')
         )
         SELECT
           COUNT(*) FILTER (WHERE dc.status = 'active' AND ra.cluster_id IS NULL AND ${field} > 1)::int AS open_clusters,
           COUNT(*) FILTER (WHERE (dc.status = 'resolved' OR ra.cluster_id IS NOT NULL) AND ${field} > 1)::int AS handled,
           COALESCE(SUM(${field}) FILTER (WHERE dc.status = 'active' AND ra.cluster_id IS NULL AND ${field} > 1), 0)::int AS dup_records
         FROM duplicate_clusters dc
         LEFT JOIN resolved_act ra ON ra.cluster_id = dc.id`,
      );
      const row = r.rows[0] || {};
      const open = Number(row.open_clusters || 0);
      const handled = Number(row.handled || 0);
      const records = Number(row.dup_records || 0);
      const verdict: RadarTabSnapshot["verdict"] =
        open === 0 ? "green" : open > 50 ? "red" : "amber";
      return {
        verdict,
        headline:
          open.toLocaleString() +
          " duplicate cluster(s) · " +
          records.toLocaleString() +
          " " +
          noun,
        metrics: { openClusters: open, handled, dupRecords: records },
      };
    });

  const [
    leadDuplicates,
    dealDuplicates,
    contactDuplicates,
    accountDuplicates,
    crossModule,
    csOverlap,
    csLifecycle,
    dealsLifecycle,
    dealCompliance,
    accountHints,
    ownerAccountability,
    logs,
  ] = await Promise.all([
    _moduleDupSnapshot("total_leads", "lead records"),
    _moduleDupSnapshot("total_deals", "deal records"),
    _moduleDupSnapshot("total_contacts", "contact records"),
    _moduleDupSnapshot("total_accounts", "account records"),
    _safeSnapshot(async () => {
      // Cross-module overlaps are NOT a separate column — they're clusters
      // whose total_<kind> > 0 for ≥2 record types. Lifecycle uses the
      // cluster's existing `status` column. Matches the shape of
      // getCrossModuleOverlaps().
      const crossModuleFilter = `(
        (CASE WHEN total_leads    > 0 THEN 1 ELSE 0 END +
         CASE WHEN total_contacts > 0 THEN 1 ELSE 0 END +
         CASE WHEN total_accounts > 0 THEN 1 ELSE 0 END +
         CASE WHEN total_deals    > 0 THEN 1 ELSE 0 END) >= 2
      )`;
      // Same lifecycle as the tabs (resolve/module_resolved action = handled).
      const r = await pool.query(
        `WITH resolved_act AS (
           SELECT DISTINCT cluster_id FROM duplicate_merge_actions
            WHERE action_type IN ('resolve','module_resolved')
         )
         SELECT
           COUNT(*) FILTER (WHERE dc.status = 'active' AND ra.cluster_id IS NULL)::int   AS open_count,
           COUNT(*) FILTER (WHERE dc.status = 'resolved' OR ra.cluster_id IS NOT NULL)::int AS handled_count,
           COUNT(*) FILTER (WHERE dc.status = 'ignored' AND ra.cluster_id IS NULL)::int  AS dismissed_count,
           COALESCE(SUM(estimated_pipeline_value)
             FILTER (WHERE dc.status = 'active' AND ra.cluster_id IS NULL), 0)::float    AS arr_sar
         FROM duplicate_clusters dc
         LEFT JOIN resolved_act ra ON ra.cluster_id = dc.id
         WHERE ${crossModuleFilter}`,
      );
      const row = r.rows[0] || {};
      const open = Number(row.open_count || 0);
      const handled = Number(row.handled_count || 0);
      const dismissed = Number(row.dismissed_count || 0);
      const arr = Math.round(Number(row.arr_sar || 0));
      const verdict: RadarTabSnapshot["verdict"] =
        open === 0 ? "green" : open > 50 ? "red" : "amber";
      return {
        verdict,
        headline: open + " open overlap(s), SAR " + arr.toLocaleString() + " exposure",
        metrics: { open, handled, dismissed, arrExposureSar: arr },
      };
    }),

    _safeSnapshot(async () => {
      const v = await getCsOverlapVerdictCounts();
      const verdict: RadarTabSnapshot["verdict"] =
        v.block > 0 ? "red" : v.review > 0 || v.warn > 0 ? "amber" : "green";
      return {
        verdict,
        headline:
          v.block + " block / " + v.review + " review / " + v.warn + " warn",
        metrics: { block: v.block, review: v.review, warn: v.warn, total: v.total },
      };
    }),

    _safeSnapshot(async () => {
      const r = await scanCsLifecycleViolations({ limit: 50000 });
      const s = r.summary;
      const critical = s.by_severity.critical || 0;
      const warning = s.by_severity.warning || 0;
      const inRenewal = s.by_phase?.renewal || 0;
      const verdict: RadarTabSnapshot["verdict"] =
        critical > 0 ? "red" : warning > 0 ? "amber" : "green";
      return {
        verdict,
        headline:
          critical +
          " critical / " +
          warning +
          " warning · " +
          s.total_cs_deals +
          " CS deals",
        metrics: {
          critical,
          warning,
          info: s.by_severity.info || 0,
          totalCsDeals: s.total_cs_deals,
          inRenewal,
        },
      };
    }),

    _safeSnapshot(async () => {
      const { scanDealStageAgingViolations } = await import(
        "./duplicateRadarDatabase"
      );
      const r = await scanDealStageAgingViolations({ limit: 50000 });
      const s = r.summary;
      const critical = s.by_severity.critical || 0;
      const warning = s.by_severity.warning || 0;
      const verdict: RadarTabSnapshot["verdict"] =
        critical > 0 ? "red" : warning > 0 ? "amber" : "green";
      return {
        verdict,
        headline:
          critical +
          " critical / " +
          warning +
          " warning · " +
          s.total_tracked_deals +
          " Sales-stage deals",
        metrics: {
          critical,
          warning,
          totalTrackedDeals: s.total_tracked_deals,
        },
      };
    }),

    _safeSnapshot(async () => {
      // deal_doc_compliance schema: compliant BOOLEAN (not result->>compliant).
      const r = await pool.query(
        `SELECT
           COUNT(*)::int                                AS checked,
           COUNT(*) FILTER (WHERE compliant = true)::int AS compliant
         FROM deal_doc_compliance`,
      );
      const row = r.rows[0] || {};
      const checked = Number(row.checked || 0);
      const compliant = Number(row.compliant || 0);
      const missing = checked - compliant;
      const verdict: RadarTabSnapshot["verdict"] =
        checked === 0
          ? "neutral"
          : missing === 0
            ? "green"
            : missing > checked / 2
              ? "red"
              : "amber";
      return {
        verdict,
        headline:
          checked > 0
            ? compliant + " / " + checked + " deals fully documented"
            : "No documents checked yet",
        metrics: { checked, compliant, missing },
      };
    }),

    _safeSnapshot(async () => {
      const r = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'pending')::int                                                    AS pending,
           COUNT(*) FILTER (WHERE status = 'pending' AND confidence >= 70)::int                               AS ready,
           COUNT(*) FILTER (WHERE status = 'applied')::int                                                    AS applied,
           COUNT(*) FILTER (WHERE status = 'dismissed')::int                                                  AS dismissed
         FROM account_inference_hints`,
      );
      const row = r.rows[0] || {};
      const pending = Number(row.pending || 0);
      const ready = Number(row.ready || 0);
      const applied = Number(row.applied || 0);
      const dismissed = Number(row.dismissed || 0);
      const verdict: RadarTabSnapshot["verdict"] =
        pending === 0
          ? "green"
          : ready > 0
            ? "amber"
            : pending > 100
              ? "red"
              : "amber";
      return {
        verdict,
        headline:
          pending +
          " pending (" +
          ready +
          " AI-ready ≥70%) · " +
          applied +
          " applied · " +
          dismissed +
          " dismissed",
        metrics: { pending, ready, applied, dismissed },
      };
    }),

    _safeSnapshot(async () => {
      const owners = await getOwnerAccountability();
      const inRed = owners.filter((o) => o.rag_status === "red").length;
      const inAmber = owners.filter((o) => o.rag_status === "amber").length;
      const worst = owners[0];
      const verdict: RadarTabSnapshot["verdict"] =
        inRed > 0 ? "red" : inAmber > 0 ? "amber" : "green";
      return {
        verdict,
        headline:
          inRed +
          " red / " +
          inAmber +
          " amber" +
          (worst ? " · worst: " + (worst.owner_name || worst.owner_email || "—") : ""),
        metrics: {
          redCount: inRed,
          amberCount: inAmber,
          totalOwners: owners.length,
          worstOwner: worst
            ? worst.owner_name || worst.owner_email || ""
            : "",
          worstRatePct: worst ? Math.round(worst.duplicate_rate) : 0,
        },
      };
    }),

    _safeSnapshot(async () => {
      // Both tables use created_at (not performed_at) for the timestamp.
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const r = await pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM duplicate_resolution_feedback WHERE created_at >= $1) AS agent_24h,
           (SELECT COUNT(*)::int FROM duplicate_merge_actions       WHERE created_at >= $1) AS manual_24h`,
        [since24h],
      );
      const agent = Number(r.rows[0]?.agent_24h || 0);
      const manual = Number(r.rows[0]?.manual_24h || 0);
      const verdict: RadarTabSnapshot["verdict"] =
        agent + manual === 0 ? "neutral" : "green";
      return {
        verdict,
        headline:
          agent +
          " agent event(s) · " +
          manual +
          " operator action(s) in 24h",
        metrics: { agentEvents24h: agent, manualActions24h: manual },
      };
    }),
  ]);

  return {
    generatedAt,
    tabs: {
      leadDuplicates,
      dealDuplicates,
      contactDuplicates,
      accountDuplicates,
      crossModule,
      csOverlap,
      csLifecycle,
      dealsLifecycle,
      dealCompliance,
      accountHints,
      ownerAccountability,
      logs,
    },
  };
}

/**
 * SQL predicate (static, no params) — TRUE when the record at `alias` is QUEUED
 * FOR DELETION: tagged Empty-Delete (via the in-platform ledger OR the synced
 * Zoho Tag) or Duplicate-Delete (synced Zoho Tag). Such records must not appear
 * in the Untouched view of ANY Duplicate Radar tab, nor be compared against
 * other records — they're on their way out, awaiting the CRM admin's deletion
 * (Ahmad 2026-06-26). They DO stay visible in the "AI-Applied · pending Zoho
 * admin delete" bucket, so the exclusion is applied only to the active/Untouched
 * view by the caller. COALESCE(...,false) so a record with a null/absent Tag is
 * treated as NOT queued (it must still count as a real record).
 */
function queuedForDeletionSql(alias: string): string {
  return `COALESCE(
    ${alias}.zoho_record_id IN (SELECT zoho_record_id FROM empty_delete_ledger)
    OR ${alias}.raw_data->'Tag' @> '[{"name":"Empty-Delete"}]'::jsonb
    OR ${alias}.raw_data->'Tag' @> '[{"name":"Duplicate-Delete"}]'::jsonb
  , false)`;
}

// Whitelisted sort columns for the per-type record tabs (Leads/Deals/
// Contacts/Accounts). Mirrors CLUSTER_SORT_COLUMNS above — only values
// mapped here may be interpolated into the ORDER BY, which guards against
// SQL injection from the query string. Keys are the UI sort keys the
// frontend sends.
//
// IMPORTANT: this view paginates by CLUSTER (see the "Paginate by CLUSTER"
// comment below) — the cluster-page query selects only `dc.id` and has no
// `dr` alias in its outer scope, so a per-record column (name/email/owner/
// created/modified) can't be referenced directly in that query's ORDER BY.
// Instead each entry is a full, self-contained correlated-subquery
// expression (referencing dc.id and the outer $1 = recordType param) that
// picks one representative value per cluster — MIN() so the result is
// deterministic regardless of row order, and so NULLs (no matching value)
// naturally sort last via NULLS LAST below. `confidence` is the one
// cluster-level field (dc.confidence_score) and needs no subquery — it's
// also the existing default sort.
const RECORD_SORT_COLUMNS: Record<string, string> = {
  name: `(SELECT MIN(dr_s.record_name) FROM duplicate_records dr_s WHERE dr_s.cluster_id = dc.id AND dr_s.record_type = $1)`,
  email: `(SELECT MIN(dr_s.email) FROM duplicate_records dr_s WHERE dr_s.cluster_id = dc.id AND dr_s.record_type = $1)`,
  owner: `(SELECT MIN(dr_s.owner_name) FROM duplicate_records dr_s WHERE dr_s.cluster_id = dc.id AND dr_s.record_type = $1)`,
  created: `(SELECT MIN(dr_s.created_date) FROM duplicate_records dr_s WHERE dr_s.cluster_id = dc.id AND dr_s.record_type = $1)`,
  modified: `(SELECT MIN(dr_s.modified_date) FROM duplicate_records dr_s WHERE dr_s.cluster_id = dc.id AND dr_s.record_type = $1)`,
  confidence: "dc.confidence_score",
};

// B5: JOIN-based queries eliminating N+1 pattern
export async function getDuplicateRecordsByType(
  recordType: string,
  options?: {
    limit?: number;
    offset?: number;
    start_date?: string;
    end_date?: string;
    owners?: string[];
    layouts?: string[];
    pipelines?: string[];
    stages?: string[];
    confidence_level?: string;
    domain?: string;
    ai_status?: string;
    segment?: "all" | "marketplace" | "corporate" | "walaplus" | "walaone";
    sort?: string;
    dir?: string;
  },
): Promise<{ groups: any[]; total: number }> {
  const countField =
    recordType === "lead"
      ? "total_leads"
      : recordType === "deal"
        ? "total_deals"
        : recordType === "contact"
          ? "total_contacts"
          : "total_accounts";

  // Date AND advanced-filter clauses constraining which records (and
  // therefore which clusters) are in scope. Placeholders start at $2 so the
  // fragment can be reused inside the EXISTS sub-queries below ($1 =
  // recordType). dc is the correlated outer cluster alias in those
  // sub-queries, so cluster-level predicates (confidence_level) are valid here.
  let dateFilter = "";
  const dateParams: any[] = [];
  if (options?.start_date) {
    dateFilter += ` AND dr.created_date >= $${dateParams.length + 2}`;
    dateParams.push(options.start_date);
  }
  if (options?.end_date) {
    dateFilter += ` AND dr.created_date <= $${dateParams.length + 2}`;
    dateParams.push(options.end_date + "T23:59:59Z");
  }
  if (options?.owners && options.owners.length > 0) {
    dateFilter += ` AND dr.owner_name = ANY($${dateParams.length + 2}::text[])`;
    dateParams.push(options.owners);
  }
  if (options?.layouts && options.layouts.length > 0) {
    dateFilter += ` AND dr.layout_name = ANY($${dateParams.length + 2}::text[])`;
    dateParams.push(options.layouts);
  }
  if (options?.pipelines && options.pipelines.length > 0) {
    dateFilter += ` AND dr.pipeline = ANY($${dateParams.length + 2}::text[])`;
    dateParams.push(options.pipelines);
  }
  if (options?.stages && options.stages.length > 0) {
    dateFilter += ` AND dr.stage = ANY($${dateParams.length + 2}::text[])`;
    dateParams.push(options.stages);
  }
  if (options?.confidence_level) {
    dateFilter += ` AND dc.confidence_level = $${dateParams.length + 2}`;
    dateParams.push(options.confidence_level);
  }
  if (options?.domain) {
    dateFilter += ` AND dr.domain ILIKE $${dateParams.length + 2}`;
    dateParams.push(`%${options.domain}%`);
  }
  // Corporate/Marketplace segment chip (Bug #2 fix). buildSegmentPredicate
  // emits its condition against a `r.` alias — dr IS that duplicate_records
  // alias here (the EXISTS sub-query that dateFilter is appended to is
  // `SELECT 1 FROM duplicate_records dr WHERE dr.cluster_id = dc.id ...`),
  // so swap the `r.` the helper returns for `dr.` to match this function's
  // actual alias before appending. Offset = dateParams.length + 2, same
  // running-offset convention as every other clause above ($1=recordType).
  const segmentClause = buildSegmentPredicate(
    options?.segment,
    dateParams.length + 2,
  );
  if (segmentClause.condition) {
    dateFilter += ` AND ${segmentClause.condition.replace(/\br\./g, "dr.")}`;
    dateParams.push(...segmentClause.params);
  }

  const limit = options?.limit || 50;
  const offset = options?.offset || 0;

  // AI-status filter — visualises the "this cluster was already AI-applied
  // and is now waiting for the Zoho admin to physically delete the tagged
  // duplicates" state. Default 'active' keeps the legacy view (untouched
  // active clusters). 'tagged_pending' = active cluster that has at least
  // one merge_action against it. 'resolved' = cluster status='resolved'.
  // 'all' = no filter.
  const aiStatus = ((options as any)?.ai_status as string) || "active";
  // The four AI-status tabs are MUTUALLY EXCLUSIVE — every cluster lands in
  // exactly one, by lifecycle precedence (Sarah 2026-06-24):
  //   Resolved > AI-Applied(pending) > Dismissed > Untouched
  // CRITICAL DISTINCTION: an `auto_merge_pending` action means the AI tagged the
  // duplicates and is WAITING for the Zoho admin to delete them (→ AI-Applied).
  // A `resolve` / `module_resolved` action means the cluster was ALREADY resolved
  // / merged (→ Resolved). The old filter lumped all three as "AI-Applied", so
  // past-resolved clusters whose status hadn't flipped to 'resolved' (records
  // reappeared on a later sync) showed in AI-Applied instead of Resolved — the
  // "124 in AI-Applied but only 7 truly pending" bug.
  const HAS_PENDING =
    "EXISTS (SELECT 1 FROM duplicate_merge_actions ma WHERE ma.cluster_id = dc.id AND ma.action_type = 'auto_merge_pending')";
  const HAS_RESOLVED_ACTION =
    "EXISTS (SELECT 1 FROM duplicate_merge_actions ma WHERE ma.cluster_id = dc.id AND ma.action_type IN ('resolve','module_resolved'))";
  let statusFilter = "AND dc.status = 'active'";
  let mergeActionFilter = "";
  if (aiStatus === "tagged_pending") {
    // AI-APPLIED · pending Zoho admin delete (Sarah 2026-07-06): an apply ran —
    // records were TAGGED Duplicate-Delete — but the cluster is NOT yet Resolved
    // (the admin hasn't deleted the tagged records AND Verify-in-CRM / a sync
    // hasn't confirmed they're gone). This is the "waiting for deletion" queue.
    // Includes cross-module PARTIAL applies (module_resolved) and auto-merge
    // pends. "Applied" ≠ "Resolved" until verified.
    statusFilter = "AND dc.status NOT IN ('resolved','ignored')";
    mergeActionFilter = ` AND (${HAS_PENDING} OR ${HAS_RESOLVED_ACTION})`;
  } else if (aiStatus === "resolved") {
    // Resolved = the cluster STATUS is actually flipped to 'resolved' — Verify-in-
    // CRM confirmed the Duplicate-Delete records are gone, or the sync reconciled
    // every module. NOT merely "Apply was clicked" (that stays AI-Applied above).
    statusFilter = "AND dc.status = 'resolved'";
  } else if (aiStatus === "dismissed") {
    // Dismissed = operator false-positive (status 'ignored') with NO AI action.
    statusFilter = "AND dc.status = 'ignored'";
    mergeActionFilter = ` AND NOT ${HAS_PENDING} AND NOT ${HAS_RESOLVED_ACTION}`;
  } else if (aiStatus === "all") {
    statusFilter = "";
  } else if (aiStatus === "active") {
    // Untouched = active, nothing done by AI or operator.
    statusFilter = "AND dc.status = 'active'";
    mergeActionFilter = ` AND NOT ${HAS_PENDING} AND NOT ${HAS_RESOLVED_ACTION}`;
  }

  // GENUINE-DUPLICATE gate for DEALS (Ahmad 2026-06-21). Deal clusters are
  // grouped by COMPANY, so a company with two DIFFERENT deals (e.g. "Renewal
  // 2025" and "New Project") becomes a cluster with 2 deals — counted as a
  // "duplicate group" even though the deals aren't duplicates. The Deal tab's
  // renderer then drops them (it only shows deals sharing name+account or a
  // duplicate CRM id), leaving the page empty while the footer claimed
  // thousands of groups. Mirror the renderer here so the count + pages reflect
  // ONLY clusters that hold a real deal duplicate. Accounts don't need this —
  // every account-cluster is a genuine duplicate. _normName = lower + trim +
  // collapse whitespace.
  let genuineDupFilter = "";
  if (recordType === "deal") {
    genuineDupFilter = `
      AND (
        EXISTS (
          SELECT 1 FROM duplicate_records dd
           WHERE dd.cluster_id = dc.id AND dd.record_type = 'deal'
             AND dd.record_name IS NOT NULL AND btrim(dd.record_name) <> ''
             AND COALESCE(dd.raw_data->'Account_Name'->>'id', dd.raw_data->>'account_id', '') <> ''
           GROUP BY lower(regexp_replace(btrim(dd.record_name), '\\s+', ' ', 'g')),
                    COALESCE(dd.raw_data->'Account_Name'->>'id', dd.raw_data->>'account_id', '')
          HAVING COUNT(*) >= 2
        )
        OR EXISTS (
          SELECT 1 FROM duplicate_records de
           WHERE de.cluster_id = dc.id AND de.record_type = 'deal'
             AND de.zoho_record_id IS NOT NULL AND btrim(de.zoho_record_id) <> ''
           GROUP BY de.zoho_record_id
          HAVING COUNT(*) >= 2
        )
      )`;
  } else if (recordType === "contact") {
    // GENUINE-DUPLICATE gate for CONTACTS (Ahmad 2026-06-22). A cluster only
    // counts as a contact-duplicate when >=2 of its contacts DIRECTLY share an
    // identity signal — same email, OR same phone, OR same name. Contacts that
    // are merely colleagues at the same company (sharing only the account/
    // domain) form no such pair, so a "chained match" cluster held together
    // only by the domain drops off the list — it's a link-to-account job, not a
    // duplicate. A direct single-signal pair still shows (it MAY be a dup).
    genuineDupFilter = `
      AND (
        EXISTS (
          SELECT 1 FROM duplicate_records ce
           WHERE ce.cluster_id = dc.id AND ce.record_type = 'contact'
             AND ce.email IS NOT NULL AND btrim(ce.email) <> ''
           GROUP BY lower(btrim(ce.email))
          HAVING COUNT(*) >= 2
        )
        OR EXISTS (
          SELECT 1 FROM duplicate_records cp
           WHERE cp.cluster_id = dc.id AND cp.record_type = 'contact'
             AND cp.phone_normalized IS NOT NULL AND length(cp.phone_normalized) >= 7
           GROUP BY cp.phone_normalized
          HAVING COUNT(*) >= 2
        )
        OR EXISTS (
          SELECT 1 FROM duplicate_records cn
           WHERE cn.cluster_id = dc.id AND cn.record_type = 'contact'
             AND cn.record_name IS NOT NULL AND btrim(cn.record_name) <> ''
           -- Arabic-aware to match the frontend _normName: fold ة→ه, ى→ي,
           -- آأإ→ا and drop tatweel (ـ) before collapsing whitespace.
           GROUP BY lower(regexp_replace(
                      translate(btrim(cn.record_name), 'ةىأإآـ', 'هيااا'),
                      '\\s+', ' ', 'g'))
          HAVING COUNT(*) >= 2
        )
      )`;
  }

  // ── Paginate by CLUSTER, not by record. ────────────────────────────────
  //
  // This view groups records into duplicate clusters, so the unit of
  // pagination must be the cluster. The previous implementation applied
  // LIMIT/OFFSET to individual `duplicate_records` rows while computing the
  // page count from the DISTINCT cluster total. Because every duplicate
  // cluster holds >=2 records, there were always more record-pages than the
  // reported cluster-page count, so the low-confidence tail of clusters was
  // unreachable and any cluster whose records straddled a page boundary was
  // split into partial groups. We instead select the page of cluster ids
  // first, then fetch ALL in-scope records for exactly those clusters.
  // A record queued for deletion (Empty-Delete or Duplicate-Delete) must NOT
  // keep showing as duplicate work, nor be compared against other records — it's
  // on its way out (Ahmad 2026-06-26). Require >=2 NON-queued records of the type
  // for the cluster to still count as a duplicate, so a pair where one side is
  // already tagged for deletion drops off. Applied to the UNTOUCHED (active) view
  // ONLY — the pending-verify bucket must keep these records visible until the
  // CRM admin confirms the deletion. Effective the instant the operator tags
  // (ledger) and after sync (Zoho Tag).
  const hideQueued = aiStatus === "active";
  const stillTwoUntagged = hideQueued
    ? `
      AND (
        SELECT COUNT(*) FROM duplicate_records dx
         WHERE dx.cluster_id = dc.id AND dx.record_type = $1
           AND NOT ${queuedForDeletionSql("dx")}
      ) >= 2`
    : "";

  // Sort: only a whitelisted key may be interpolated (RECORD_SORT_COLUMNS),
  // and dir is validated to exactly ASC/DESC — never a raw user string.
  // Falls back to the original default (confidence DESC) when sort is
  // absent/unrecognized, so existing behavior is unchanged unless a sort is
  // explicitly selected. dc.id ASC is a stable tiebreaker so pagination
  // stays deterministic across pages even when many clusters share a value.
  const recordSortKey =
    options?.sort && RECORD_SORT_COLUMNS[options.sort]
      ? RECORD_SORT_COLUMNS[options.sort]
      : null;
  const recordSortDir = options?.dir === "asc" ? "ASC" : "DESC";
  // DEFAULT = MOST-RECENTLY-CREATED cluster first (Sarah 2026-07-06): surface the
  // newest duplications at the top so fresh dupes are caught first, then older
  // data. Ordered by the cluster's NEWEST record's created_date DESC. An explicit
  // column sort still overrides. dc.id ASC = stable pagination tiebreaker.
  const clusterOrderBy = recordSortKey
    ? `ORDER BY ${recordSortKey} ${recordSortDir} NULLS LAST, dc.id ASC`
    : `ORDER BY (SELECT MAX(dr_d.created_date) FROM duplicate_records dr_d WHERE dr_d.cluster_id = dc.id AND dr_d.record_type = $1) DESC NULLS LAST, dc.id ASC`;

  const clusterPage = await pool.query(
    `
    SELECT dc.id
    FROM duplicate_clusters dc
    WHERE dc.${countField} > 1 ${statusFilter}${mergeActionFilter}
      AND EXISTS (
        SELECT 1 FROM duplicate_records dr
        WHERE dr.cluster_id = dc.id AND dr.record_type = $1 AND dr.cleanup_class IS NULL${dateFilter}
      )${genuineDupFilter}${stillTwoUntagged}
    ${clusterOrderBy}
    LIMIT $${dateParams.length + 2} OFFSET $${dateParams.length + 3}
  `,
    [recordType, ...dateParams, limit, offset],
  );

  const clusterIds = clusterPage.rows.map((r) => r.id);

  const countResult = await pool.query(
    `
    SELECT COUNT(*) as total
    FROM duplicate_clusters dc
    WHERE dc.${countField} > 1 ${statusFilter}${mergeActionFilter}
      AND EXISTS (
        SELECT 1 FROM duplicate_records dr
        WHERE dr.cluster_id = dc.id AND dr.record_type = $1 AND dr.cleanup_class IS NULL${dateFilter}
      )${genuineDupFilter}${stillTwoUntagged}
  `,
    [recordType, ...dateParams],
  );

  if (clusterIds.length === 0) {
    return { groups: [], total: parseInt(countResult.rows[0]?.total) || 0 };
  }

  // Records filter re-anchored to $3 ($1=recordType, $2=clusterIds). Mirrors
  // the cluster-scoping fragment above so only records matching the active
  // advanced filters are returned within each in-scope cluster. dc is JOINed
  // in the records query, so confidence_level is valid here too.
  let recDateFilter = "";
  const recDateParams: any[] = [];
  if (options?.start_date) {
    recDateFilter += ` AND dr.created_date >= $${recDateParams.length + 3}`;
    recDateParams.push(options.start_date);
  }
  if (options?.end_date) {
    recDateFilter += ` AND dr.created_date <= $${recDateParams.length + 3}`;
    recDateParams.push(options.end_date + "T23:59:59Z");
  }
  if (options?.owners && options.owners.length > 0) {
    recDateFilter += ` AND dr.owner_name = ANY($${recDateParams.length + 3}::text[])`;
    recDateParams.push(options.owners);
  }
  if (options?.layouts && options.layouts.length > 0) {
    recDateFilter += ` AND dr.layout_name = ANY($${recDateParams.length + 3}::text[])`;
    recDateParams.push(options.layouts);
  }
  if (options?.pipelines && options.pipelines.length > 0) {
    recDateFilter += ` AND dr.pipeline = ANY($${recDateParams.length + 3}::text[])`;
    recDateParams.push(options.pipelines);
  }
  if (options?.stages && options.stages.length > 0) {
    recDateFilter += ` AND dr.stage = ANY($${recDateParams.length + 3}::text[])`;
    recDateParams.push(options.stages);
  }
  if (options?.confidence_level) {
    recDateFilter += ` AND dc.confidence_level = $${recDateParams.length + 3}`;
    recDateParams.push(options.confidence_level);
  }
  if (options?.domain) {
    recDateFilter += ` AND dr.domain ILIKE $${recDateParams.length + 3}`;
    recDateParams.push(`%${options.domain}%`);
  }
  // Mirror the same segment constraint on the records-fetch query so the
  // rows returned for the in-scope clusters are themselves segment-scoped
  // (the clusterIds list above already excludes out-of-segment clusters,
  // but a mixed cluster could otherwise still surface off-segment rows).
  // $1=recordType, $2=clusterIds, so offset starts at recDateParams.length+3.
  const recSegmentClause = buildSegmentPredicate(
    options?.segment,
    recDateParams.length + 3,
  );
  if (recSegmentClause.condition) {
    recDateFilter += ` AND ${recSegmentClause.condition.replace(/\br\./g, "dr.")}`;
    recDateParams.push(...recSegmentClause.params);
  }

  const result = await pool.query(
    `
    SELECT dr.*, dc.domain as cluster_domain, dc.company_name as cluster_company,
           dc.confidence_level, dc.confidence_score as cluster_confidence,
           dc.total_records as cluster_total, dc.estimated_pipeline_value,
           dc.id as cluster_id_ref
    FROM duplicate_records dr
    JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
    WHERE dr.record_type = $1 AND dr.cluster_id = ANY($2::int[]) AND dr.cleanup_class IS NULL${recDateFilter}
      ${hideQueued ? `AND NOT ${queuedForDeletionSql("dr")}` : ""}
    ORDER BY dc.confidence_score DESC, dc.id ASC, dr.is_primary DESC, dr.created_date ASC
  `,
    [recordType, clusterIds, ...recDateParams],
  );

  const grouped: Record<number, any> = {};
  for (const row of result.rows) {
    const cid = row.cluster_id;
    if (!grouped[cid]) {
      grouped[cid] = {
        cluster: {
          id: cid,
          domain: row.cluster_domain,
          company_name: row.cluster_company,
          confidence_level: row.confidence_level,
          confidence_score: row.cluster_confidence,
          total_records: row.cluster_total,
          estimated_pipeline_value: row.estimated_pipeline_value,
        },
        [recordType + "s"]: [],
        duplicate_count: 0,
      };
    }
    grouped[cid][recordType + "s"].push(row);
    grouped[cid].duplicate_count++;
  }

  // Sidecar — per-cluster AI-status. Powers the new "🤖 Already AI-applied,
  // pending Zoho admin delete" badge on each cluster header so the operator
  // can tell apart untouched / tagged / fully-resolved clusters without
  // opening each one. One query per page (≤ ~50 clusters), aggregated by id.
  if (clusterIds.length > 0) {
    const statusRows = await pool.query(
      `SELECT dc.id, dc.status,
              COALESCE(ma.action_count, 0)        AS merge_action_count,
              COALESCE(ma.tagged_records, 0)      AS tagged_records,
              COALESCE(ma.has_pending, false)     AS has_pending,
              COALESCE(ma.has_resolved, false)    AS has_resolved,
              ma.last_merge_at
         FROM duplicate_clusters dc
         LEFT JOIN (
           SELECT cluster_id,
                  COUNT(*) AS action_count,
                  BOOL_OR(action_type = 'auto_merge_pending')               AS has_pending,
                  BOOL_OR(action_type IN ('resolve','module_resolved'))     AS has_resolved,
                  SUM(jsonb_array_length(merged_record_ids))                AS tagged_records,
                  MAX(created_at) AS last_merge_at
             FROM duplicate_merge_actions
            WHERE action_type IN ('resolve','module_resolved','auto_merge_pending')
            GROUP BY cluster_id
         ) ma ON ma.cluster_id = dc.id
        WHERE dc.id = ANY($1::int[])`,
      [clusterIds],
    );
    const byId = new Map<number, any>();
    for (const r of statusRows.rows) {
      byId.set(r.id, r);
    }
    for (const cid of clusterIds) {
      const meta = byId.get(cid);
      if (!meta || !grouped[cid]) continue;
      const taggedCount = Number(meta.tagged_records || 0);
      const actionCount = Number(meta.merge_action_count || 0);
      // SAME lifecycle as the tab filter (getDuplicateRecordsByType), Sarah
      // 2026-07-06: RESOLVED only when the cluster STATUS is actually flipped to
      // 'resolved' (Verify-in-CRM / sync-reconciled). Any apply action
      // (auto_merge_pending OR resolve/module_resolved) with the status not yet
      // resolved = AI-Applied · pending Zoho delete. Keeps the per-row badge in
      // sync with its tab so "Applied" never masquerades as "Resolved".
      const aiState =
        meta.status === "resolved"
          ? "resolved"
          : (meta.has_pending || meta.has_resolved)
            ? "tagged_pending_delete"
            : "untouched";
      grouped[cid].cluster.ai_state = aiState;
      grouped[cid].cluster.merge_action_count = actionCount;
      grouped[cid].cluster.tagged_records = taggedCount;
      grouped[cid].cluster.last_merge_at = meta.last_merge_at || null;
      grouped[cid].cluster.cluster_status = meta.status;
    }
  }

  return {
    groups: Object.values(grouped),
    total: parseInt(countResult.rows[0]?.total) || 0,
  };
}

// B5: JOIN-based export eliminating N+1
export async function getExportRecords(filters?: {
  owner?: string;
  start_date?: string;
  end_date?: string;
  status?: string;
}): Promise<any[]> {
  let whereClause = "WHERE 1=1";
  const params: any[] = [];
  let pi = 1;

  if (filters?.status) {
    whereClause += ` AND dc.status = $${pi++}`;
    params.push(filters.status);
  } else {
    whereClause += ` AND dc.status = 'active'`;
  }
  if (filters?.owner) {
    whereClause += ` AND (dr.owner_name = $${pi++} OR dr.owner_email = $${pi - 1})`;
    params.push(filters.owner);
  }
  if (filters?.start_date) {
    whereClause += ` AND dr.created_date >= $${pi++}`;
    params.push(filters.start_date);
  }
  if (filters?.end_date) {
    whereClause += ` AND dr.created_date <= $${pi++}`;
    params.push(filters.end_date + "T23:59:59Z");
  }

  const result = await pool.query(
    `
    SELECT dr.*, dc.domain as cluster_domain, dc.confidence_level as cluster_confidence
    FROM duplicate_records dr
    JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
    ${whereClause}
    ORDER BY dc.total_records DESC, dr.cluster_id, dr.is_primary DESC
  `,
    params,
  );

  return result.rows;
}

// C5: Auto-resolution engine
export async function autoResolveClusters(): Promise<{
  singletonsIgnored: number;
  highConfidenceResolved: number;
  totalProcessed: number;
}> {
  let singletonsIgnored = 0;
  let highConfidenceResolved = 0;

  // Only auto-clean SINGLETONS (clusters left with <=1 record after deletions
  // — they are not duplicates anymore, so ignoring them is safe cleanup).
  const singletons = await pool.query(`
    SELECT id FROM duplicate_clusters WHERE total_records <= 1 AND status = 'active'
  `);
  for (const row of singletons.rows) {
    await pool.query(
      "UPDATE duplicate_clusters SET status = 'ignored', resolved_by = 'auto-resolve', resolved_at = CURRENT_TIMESTAMP WHERE id = $1",
      [row.id],
    );
    singletonsIgnored++;
  }

  // REMOVED (2026-06-12): the old high-confidence auto-resolve marked any
  // cluster with confidence_score >= 95% as 'resolved' — but high confidence
  // that two records are duplicates is NOT the same as them having been MERGED
  // in Zoho. This silently marked real, un-merged duplicates "Resolved",
  // locking operators out of merging them ("already resolved" guard). A cluster
  // must only become 'resolved' from an actual Apply/merge or an explicit
  // operator "Mark Resolved" after merging in Zoho. highConfidenceResolved
  // stays 0 to preserve the return shape for callers.

  return {
    singletonsIgnored,
    highConfidenceResolved,
    totalProcessed: singletonsIgnored + highConfidenceResolved,
  };
}

// C7: Smart AI recommendations considering completeness, deals, recency
// Zoho-correct recommendation engine.
//
// Zoho does NOT support cross-module merges (you cannot merge a Contact into an
// Account). The right action depends on the relationship between the record
// types in the cluster, not just on which one looks "best":
//
//   • same module as primary  → MERGE (native Zoho merge inside the module)
//   • Contact/Deal under an Account primary → LINK (set Account_Name field)
//   • Deal under a Contact primary          → LINK (set Contact_Name field)
//   • Lead when a real Account/Contact/Deal already exists → CLOSE/convert
//   • anything else (e.g. Deal vs Contact with no Account) → REVIEW manually
//
// Primary selection priority is by record type first
// (Account > Contact > Deal > Lead > Task), with quality-score breaking ties.
export type DuplicateActionType =
  | "keep"
  | "merge"
  | "link"
  | "close"
  | "review";

export interface SmartRecommendation {
  record_id: number;
  record_name: string;
  is_primary: boolean;
  recommendation: string;
  action_type: DuplicateActionType;
  confidence: number;
  reasons: string[];
}

const RECORD_TYPE_PRIORITY: Record<string, number> = {
  account: 5,
  contact: 4,
  deal: 3,
  lead: 2,
  task: 1,
};

export function generateSmartRecommendations(
  records: DuplicateRecord[],
): SmartRecommendation[] {
  if (records.length === 0) return [];

  const scored = records.map((r) => {
    let score = 0;
    const reasons: string[] = [];

    const fields = [
      r.email,
      r.phone,
      r.company_name,
      r.owner_name,
      r.source,
    ].filter(Boolean);
    const completeness = Math.round((fields.length / 5) * 100);
    score += completeness;
    if (completeness >= 80) reasons.push("High data completeness");

    if (r.record_type === "deal" && r.deal_value && r.deal_value > 0) {
      score += 30;
      reasons.push("Has active deal value");
    }

    if (r.modified_date) {
      const daysSinceModified =
        (Date.now() - new Date(r.modified_date).getTime()) /
        (1000 * 60 * 60 * 24);
      if (daysSinceModified < 30) {
        score += 20;
        reasons.push("Recently modified");
      } else if (daysSinceModified < 90) {
        score += 10;
        reasons.push("Modified in last 90 days");
      }
    }

    if (r.created_date) {
      const ageInDays =
        (Date.now() - new Date(r.created_date).getTime()) /
        (1000 * 60 * 60 * 24);
      if (ageInDays > 180) {
        score += 5;
        reasons.push("Established record (6mo+)");
      }
    }

    if (
      r.stage &&
      ["Closed Won", "Negotiation", "Proposal"].includes(r.stage)
    ) {
      score += 15;
      reasons.push(`Active deal stage: ${r.stage}`);
    }

    return { record: r, score, reasons };
  });

  // Pick primary by Zoho-module priority first, then by quality score.
  // Account beats Contact beats Deal beats Lead beats Task.
  scored.sort((a, b) => {
    const pa = RECORD_TYPE_PRIORITY[a.record.record_type] || 0;
    const pb = RECORD_TYPE_PRIORITY[b.record.record_type] || 0;
    if (pa !== pb) return pb - pa;
    return b.score - a.score;
  });

  const primary = scored[0].record;
  const primaryType = primary.record_type;
  const primaryScore = scored[0].score;
  const hasAccount = scored.some((s) => s.record.record_type === "account");
  const hasContact = scored.some((s) => s.record.record_type === "contact");
  const hasDeal = scored.some((s) => s.record.record_type === "deal");

  return scored.map((item, index) => {
    if (index === 0) {
      return {
        record_id: item.record.id!,
        record_name: item.record.record_name,
        is_primary: true,
        recommendation: `KEEP as primary ${primaryType} (best Zoho-priority + quality score)`,
        action_type: "keep" as const,
        confidence: 95,
        reasons: item.reasons,
      };
    }

    const t = item.record.record_type;
    let action: DuplicateActionType;
    let recommendation: string;

    if (t === primaryType) {
      action = "merge";
      recommendation = `MERGE into primary ${primaryType} (native Zoho merge — same module)`;
    } else if (
      primaryType === "account" &&
      ((t as string) === "contact" ||
        (t as string) === "deal" ||
        (t as string) === "task")
    ) {
      action = "link";
      const field =
        (t as string) === "contact" || (t as string) === "deal"
          ? "Account_Name"
          : "What_Id";
      recommendation = `LINK to primary account by setting ${field} on this ${t} (cross-module — do NOT merge)`;
    } else if (
      primaryType === "contact" &&
      ((t as string) === "deal" || (t as string) === "task")
    ) {
      action = "link";
      const field = t === "deal" ? "Contact_Name" : "Who_Id";
      recommendation = `LINK to primary contact by setting ${field} on this ${t} (cross-module — do NOT merge)`;
    } else if (t === "lead" && (hasAccount || hasContact || hasDeal)) {
      action = "close";
      recommendation =
        "CLOSE — a converted Account/Contact/Deal already exists for this company";
    } else {
      action = "review";
      recommendation = `REVIEW manually — cross-module pairing (${primaryType} ↔ ${t}) has no automatic Zoho action`;
    }

    return {
      record_id: item.record.id!,
      record_name: item.record.record_name,
      is_primary: false,
      recommendation,
      action_type: action,
      confidence: Math.min(95, 60 + Math.max(0, primaryScore - item.score)),
      reasons: item.reasons,
    };
  });
}

// Convenience: derive cluster-level metadata from a set of records, used by
// the cluster API responses so the UI can render cross-module banners and
// pick the right Resolve button label.
export function getClusterRecordTypeMeta(records: DuplicateRecord[]): {
  primary_type: string | null;
  is_cross_module: boolean;
  record_types: string[];
} {
  if (!records || records.length === 0) {
    return { primary_type: null, is_cross_module: false, record_types: [] };
  }
  const types = Array.from(
    new Set(records.map((r) => r.record_type).filter(Boolean)),
  );
  const sorted = [...records].sort(
    (a, b) =>
      (RECORD_TYPE_PRIORITY[b.record_type] || 0) -
      (RECORD_TYPE_PRIORITY[a.record_type] || 0),
  );
  return {
    primary_type: sorted[0].record_type,
    is_cross_module: types.length > 1,
    record_types: types,
  };
}

/**
 * R6 — Classify a cross-module cluster by which pair of record types
 * co-exist. Pure helper, exported for vitest.
 *
 * Industry context: a Lead at `acme.com` representing the same person /
 * company as a Contact under the existing ACME Account is the most common
 * cross-module duplicate. The fix is NOT "merge" (Zoho doesn't support
 * cross-module merges) — it's CONVERT (the Lead becomes the Contact) or
 * LINK (set Account_Name on the deal/contact). The generateSmartRecommendations
 * helper already emits the right per-record action; this classifier groups
 * clusters by pairing type so the Cross-Module tab can filter / KPI them.
 *
 * Returns one of:
 *   lead_contact   — Lead + Contact (most common — convert lead to contact)
 *   lead_account   — Lead + Account (close the lead, link to account)
 *   lead_deal      — Lead + Deal (close the lead, deal is canonical)
 *   contact_account — Contact + Account (link Contact's Account_Name)
 *   contact_deal   — Contact + Deal (link Deal's Contact_Name)
 *   deal_account   — Deal + Account (link Deal's Account_Name)
 *   mixed          — 3 or more distinct record types (compound case)
 *   null           — same-module / not actually cross-module
 *
 * Two-module pairings use an explicit canonical ordering (Lead first, then
 * Contact, then Deal, then Account) so the same pair always maps to the
 * same key. Lead-first ordering follows operational priority: Leads are
 * net-new pipeline that need disposition, so a "Lead + something" pair is
 * always read as "what do we do with the Lead?".
 */
// ─── Cross-module lifecycle helpers ──────────────────────────────────────
//
// Sarah's refined rules (2026-06-16):
//   • Lead has no "link to Account/Contact" field in Zoho — the only
//     action on a Lead in a cross-module cluster is CLOSE, and that's
//     already handled by the Leads Duplicates tab. So Lead↔Contact and
//     Lead↔Account add NOISE to this tab and must be hidden.
//   • Lead↔Deal IS surfaced — only when BOTH sides are still live
//     (active Lead + active Deal = wasted prospecting effort).
//   • "Existing client" = a Paid / Agreement Signed style Deal (those
//     are CS-owned). A Contact alone is NOT customer evidence.
//   • Contact↔Account, Deal↔Account, Contact↔Deal are the real LINK
//     queue — these CAN be wired up in Zoho via Account_Name /
//     Contact_Name and that's the actionable work on this tab.
//
// Stage / status string sets are lowercased + frozen at module load so
// the membership check is allocation-free in the hot path. Kept in sync
// with sdrCallLinking.JUNK_LEAD_STATUSES and dealComplianceCheck stages.

const INACTIVE_LEAD_STATUSES_LOWER: ReadonlySet<string> = new Set([
  "junk lead",
  "bogus lead",
  "lost lead",
  "not qualified",
  "disqualified",
  "converted",
]);

const INACTIVE_DEAL_STAGES_LOWER: ReadonlySet<string> = new Set([
  "closed lost",
  "lost",
  "dropped",
  "cancelled",
  "canceled",
]);

const CLIENT_DEAL_STAGES_LOWER: ReadonlySet<string> = new Set([
  "paid",
  "agreement signed",
  "closed won",
  "agreement sent",
  "awaiting po",
  "client activated",
  "transferred to cs",
]);

/** A Lead is "active" when its Lead_Status is not in the disqualified /
 *  closed / converted set. Empty / null status counts as active (raw
 *  records from Zoho occasionally lack the field). */
export function isActiveLead(leadStatus: string | null | undefined): boolean {
  const v = String(leadStatus ?? "").trim().toLowerCase();
  if (!v) return true;
  return !INACTIVE_LEAD_STATUSES_LOWER.has(v);
}

/** A Deal is "active" when its Stage is not Closed Lost / Lost / Dropped /
 *  Cancelled. Empty / null stage counts as active. */
export function isActiveDeal(stage: string | null | undefined): boolean {
  const v = String(stage ?? "").trim().toLowerCase();
  if (!v) return true;
  return !INACTIVE_DEAL_STAGES_LOWER.has(v);
}

/** A "client deal" is one whose Stage indicates we already have this
 *  customer (Paid / Agreement Signed / Closed Won / Agreement Sent /
 *  etc.). Such clusters are CS-owned — Sales should not pursue. */
export function isClientDeal(stage: string | null | undefined): boolean {
  const v = String(stage ?? "").trim().toLowerCase();
  if (!v) return false;
  return CLIENT_DEAL_STAGES_LOWER.has(v);
}

export type CrossModulePairing =
  | "lead_contact"
  | "lead_account"
  | "lead_deal"
  | "contact_account"
  | "contact_deal"
  | "deal_account"
  | "mixed";

// Explicit lookup: hasLead × hasContact × hasAccount × hasDeal → key.
// Keeps the type union in lock-step with what the classifier returns.
const CROSS_MODULE_PAIRING_LOOKUP: Record<string, CrossModulePairing> = {
  "lead+contact": "lead_contact",
  "lead+account": "lead_account",
  "lead+deal": "lead_deal",
  "contact+account": "contact_account",
  "contact+deal": "contact_deal",
  "deal+account": "deal_account",
};

export function classifyCrossModulePairing(input: {
  total_leads: number;
  total_contacts: number;
  total_accounts: number;
  total_deals: number;
}): CrossModulePairing | null {
  const present: string[] = [];
  if ((input.total_leads ?? 0) > 0) present.push("lead");
  if ((input.total_contacts ?? 0) > 0) present.push("contact");
  if ((input.total_deals ?? 0) > 0) present.push("deal");
  if ((input.total_accounts ?? 0) > 0) present.push("account");
  if (present.length <= 1) return null;
  if (present.length >= 3) return "mixed";
  // Exactly two — the priority push order above (lead, contact, deal,
  // account) guarantees they're already in canonical order when joined.
  const key = present.join("+");
  return CROSS_MODULE_PAIRING_LOOKUP[key] ?? "mixed";
}

export interface CrossModuleClusterRow {
  id: number;
  domain: string | null;
  company_name: string | null;
  confidence_score: number;
  confidence_level: "high" | "medium" | "low";
  total_records: number;
  total_leads: number;
  total_contacts: number;
  total_accounts: number;
  total_deals: number;
  pairing: CrossModulePairing | null;
  estimated_pipeline_value: number;
  status: string;
  cross_module_handled_at?: Date | null;
  created_at: Date | null;
  updated_at: Date | null;
  // Per-record dimensions aggregated from duplicate_records so the dashboard's
  // Advanced Filters (Owner / Module / Stage / Layout / Pipeline) can match a
  // cross-module CLUSTER by what its member records hold. Owner/Stage/etc. live
  // on records, not the cluster, so without these the filters silently no-op.
  modules_present?: string[]; // e.g. ["lead","deal"]
  owners?: string[];
  owner_name?: string; // owners joined — the substring matcher reads this
  stages?: string[]; // Deal stages present in the cluster
  layouts?: string[];
  pipelines?: string[];
  // Refined-rule lifecycle flags (Sarah 2026-06-16). Derived from the
  // member records' Lead_Status / Stage so the tab can reason in business
  // terms (active vs. dead Lead, active vs. dead Deal, existing client).
  has_active_lead?: boolean;
  has_active_deal?: boolean;
  has_client_deal?: boolean;
  // True when ALL modules present in the cluster have a matching entry in
  // duplicate_resolution_ledger — i.e. the operator already clicked Mark
  // Handled on this overlap on a prior cluster row, and the next 6h sync
  // re-clustered the records into a new row that lost the status flag.
  // The tab treats these as "effectively resolved" and hides them from
  // the Open queue even though duplicate_clusters.status='active'.
  ledger_resolved?: boolean;
}

export interface CrossModuleOverlapsResponse {
  total: number;
  by_pairing: Record<string, number>;
  // Action-oriented counts that power the headline tiles. A single cluster
  // can fall into multiple buckets (a 3+ modules cluster might be both a
  // Lead↔ActiveDeal AND a Deal↔Account link gap) — this is intentional:
  // each tile asks a different operator question.
  by_action: {
    lead_vs_active_deal: number;
    contact_account_link: number;
    deal_account_link: number;
    contact_deal_link: number;
    three_plus_modules: number;
    existing_client_cs_owned: number;
  };
  arr_exposure_total: number;
  clusters: CrossModuleClusterRow[];
}

/**
 * R6 — Fetch active clusters that span 2+ record types ("cross-module
 * overlaps") with per-pairing counts.
 *
 * Definition: at least two of total_leads/contacts/accounts/deals are > 0.
 * Filtering: status='active' so resolved/ignored clusters drop off the
 * triage queue. Optional `pairing` filter applies a post-query JS filter
 * (the SQL aggregates produce all pairings; trimming after is cheap given
 * the result set is bounded by `limit`).
 *
 * Returns the FULL set of active cross-module clusters by default (the previous
 * 200 cap silently hid real overlaps). The dashboard paginates client-side, so
 * returning everything is fine. `limit` defaults to "all" and is clamped to a
 * 100,000 safety ceiling to guard against a pathological payload.
 */
export async function getCrossModuleOverlaps(opts: {
  limit?: number;
  pairing?: CrossModulePairing | null;
  /** Which lifecycle status to return: 'active' (default, the open queue),
   *  'resolved' (whole cluster resolved), 'ignored' (dismissed), 'handled'
   *  (module-scoped: cross_module_handled_at IS NOT NULL, cluster itself
   *  still 'active' — see markCrossModuleHandled), or 'all'. */
  status?: "active" | "resolved" | "ignored" | "handled" | "all";
  /** Marketplace / WalaPlus / WalaOne segment chip. Filters clusters by the
   *  layouts present on their member records (c.layouts). undefined/'all' = no
   *  filter. Mirrors buildSegmentPredicate's layout semantics. */
  segment?: DuplicateFilters["segment"];
} = {}): Promise<CrossModuleOverlapsResponse> {
  const CROSS_MODULE_MAX = 100000;
  const limit = Math.min(
    CROSS_MODULE_MAX,
    Math.max(1, Math.floor(opts.limit ?? CROSS_MODULE_MAX) || CROSS_MODULE_MAX),
  );
  const statusOpt = opts.status ?? "active";
  // Parameterised status clause; 'all' drops the filter entirely.
  // 'handled' is NOT a cluster.status value — it's the module-scoped
  // cross_module_handled_at column on an otherwise-'active' cluster, so it
  // filters on status='active' (same base population as the open queue)
  // and flips the handled-column condition below.
  const statusClause =
    statusOpt === "all"
      ? "TRUE"
      : statusOpt === "handled"
        ? "duplicate_clusters.status = 'active'"
        : statusOpt === "resolved"
          // Merged view (Sarah 2026-07-04): the operator sees NO difference
          // between "handled" and "resolved" on this tab, so "Resolved" returns
          // BOTH — whole-cluster resolved OR cross-module marked-done (handled).
          ? "(duplicate_clusters.status = 'resolved' OR (duplicate_clusters.status = 'active' AND duplicate_clusters.cross_module_handled_at IS NOT NULL))"
          : "duplicate_clusters.status = $2";
  const params: any[] =
    statusOpt === "all" || statusOpt === "handled" || statusOpt === "resolved"
      ? [limit]
      : [limit, statusOpt];
  const r = await pool.query<CrossModuleClusterRow>(
    `
    SELECT
      id, domain, company_name,
      confidence_score, confidence_level,
      total_records,
      total_leads, total_contacts, total_accounts, total_deals,
      COALESCE(estimated_pipeline_value, 0)::numeric AS estimated_pipeline_value,
      status, cross_module_handled_at, created_at, updated_at
    FROM duplicate_clusters
    WHERE ${statusClause}
      AND (
        ${statusOpt === "handled"
          ? "duplicate_clusters.cross_module_handled_at IS NOT NULL"
          : statusOpt === "active"
            ? "duplicate_clusters.cross_module_handled_at IS NULL"
            : "TRUE"}
      )
      AND (
        ${statusOpt === "active"
          ? `(CASE WHEN EXISTS (SELECT 1 FROM duplicate_records dr WHERE dr.cluster_id = duplicate_clusters.id AND dr.record_type = 'lead'    AND dr.cleanup_class IS NULL AND NOT ${queuedForDeletionSql("dr")}) THEN 1 ELSE 0 END +
         CASE WHEN EXISTS (SELECT 1 FROM duplicate_records dr WHERE dr.cluster_id = duplicate_clusters.id AND dr.record_type = 'contact' AND dr.cleanup_class IS NULL AND NOT ${queuedForDeletionSql("dr")}) THEN 1 ELSE 0 END +
         CASE WHEN EXISTS (SELECT 1 FROM duplicate_records dr WHERE dr.cluster_id = duplicate_clusters.id AND dr.record_type = 'account' AND dr.cleanup_class IS NULL AND NOT ${queuedForDeletionSql("dr")}) THEN 1 ELSE 0 END +
         CASE WHEN EXISTS (SELECT 1 FROM duplicate_records dr WHERE dr.cluster_id = duplicate_clusters.id AND dr.record_type = 'deal'    AND dr.cleanup_class IS NULL AND NOT ${queuedForDeletionSql("dr")}) THEN 1 ELSE 0 END`
          : `(CASE WHEN total_leads > 0 THEN 1 ELSE 0 END +
         CASE WHEN total_contacts > 0 THEN 1 ELSE 0 END +
         CASE WHEN total_accounts > 0 THEN 1 ELSE 0 END +
         CASE WHEN total_deals > 0 THEN 1 ELSE 0 END`}
        ) >= 2
      )
    ORDER BY total_records DESC, confidence_score DESC
    LIMIT $1
    `,
    params,
  );

  const all = r.rows.map((row) => ({
    ...row,
    estimated_pipeline_value: Number(row.estimated_pipeline_value ?? 0),
    pairing: classifyCrossModulePairing({
      total_leads: Number(row.total_leads ?? 0),
      total_contacts: Number(row.total_contacts ?? 0),
      total_accounts: Number(row.total_accounts ?? 0),
      total_deals: Number(row.total_deals ?? 0),
    }),
  }));

  // Drop placeholder / quarantine buckets — these are NOT real cross-module
  // overlaps. `_placeholder.cluster` is the single quarantine bucket for blank /
  // placeholder company names, and any cluster whose company name is itself a
  // placeholder (N/A, "Not Provided", …) is CS name-quality noise, not one
  // company to CONVERT/LINK. They'd otherwise inflate Total open + ARR with
  // thousands of unrelated records. Genuine no-domain clusters (a real company
  // that simply has no domain, e.g. "جباس") are KEPT.
  const realOverlaps = all.filter(
    (c) =>
      c.domain !== PLACEHOLDER_CLUSTER_DOMAIN &&
      !isPlaceholderName(c.company_name),
  );

  // Aggregate the per-record dimensions (owner / module / deal-stage / layout /
  // pipeline) onto each cluster so the dashboard's Advanced Filters can match a
  // cross-module cluster by what its member records hold. One grouped query over
  // the already-bounded cluster set — owner_name is a column; stage/layout/
  // pipeline are read out of raw_data (Layout arrives as { name }). Best-effort:
  // any failure just leaves the dimensions empty (filters skip them, no crash).
  //
  // Also derives the refined-rule lifecycle flags inline:
  //   • has_active_lead / has_active_deal / has_client_deal — drive the
  //     Lead↔ActiveDeal filter + the "Existing client → CS" badge.
  //   • modules_ledger_resolved — which of the cluster's modules already
  //     have a matching `duplicate_resolution_ledger` entry. When every
  //     module-present has a ledger match, the cluster is "effectively
  //     resolved" (the operator clicked Mark Handled on a prior incarnation
  //     of this cluster before the 6h sync re-clustered) and must drop
  //     out of the Open queue.
  if (realOverlaps.length > 0) {
    try {
      const ids = realOverlaps.map((c) => c.id);
      const agg = await pool.query(
        `SELECT cluster_id,
                COUNT(*) FILTER (WHERE record_type = 'lead')    AS real_leads,
                COUNT(*) FILTER (WHERE record_type = 'contact') AS real_contacts,
                COUNT(*) FILTER (WHERE record_type = 'account') AS real_accounts,
                COUNT(*) FILTER (WHERE record_type = 'deal')    AS real_deals,
                array_agg(DISTINCT record_type)
                  FILTER (WHERE record_type IS NOT NULL)                       AS modules_present,
                array_agg(DISTINCT owner_name)
                  FILTER (WHERE owner_name IS NOT NULL AND owner_name <> '')   AS owners,
                array_agg(DISTINCT (raw_data->>'Stage'))
                  FILTER (WHERE record_type = 'deal'
                          AND COALESCE(raw_data->>'Stage','') <> '')           AS stages,
                array_agg(DISTINCT COALESCE(raw_data#>>'{Layout,name}', raw_data->>'Layout'))
                  FILTER (WHERE COALESCE(raw_data#>>'{Layout,name}', raw_data->>'Layout','') <> '') AS layouts,
                array_agg(DISTINCT (raw_data->>'Pipeline'))
                  FILTER (WHERE COALESCE(raw_data->>'Pipeline','') <> '')      AS pipelines,
                array_agg(DISTINCT LOWER(COALESCE(raw_data->>'Lead_Status','')))
                  FILTER (WHERE record_type = 'lead')                          AS lead_statuses,
                array_agg(DISTINCT LOWER(COALESCE(raw_data->>'Stage','')))
                  FILTER (WHERE record_type = 'deal')                          AS deal_stages_lower,
                array_agg(DISTINCT record_type)
                  FILTER (WHERE EXISTS (
                    SELECT 1 FROM duplicate_resolution_ledger lg
                    WHERE lg.master_zoho_id = duplicate_records.zoho_record_id
                      AND lg.module = CASE duplicate_records.record_type
                                        WHEN 'lead'    THEN 'Leads'
                                        WHEN 'deal'    THEN 'Deals'
                                        WHEN 'contact' THEN 'Contacts'
                                        WHEN 'account' THEN 'Accounts'
                                      END
                      AND lg.action_type IN ('resolve','module_resolved')
                  ))                                                            AS modules_ledger_resolved
           FROM duplicate_records
          WHERE cluster_id = ANY($1::int[]) AND cleanup_class IS NULL
          GROUP BY cluster_id`,
        [ids],
      );
      const byId = new Map<number, any>();
      for (const row of agg.rows) byId.set(Number(row.cluster_id), row);
      for (const c of realOverlaps as any[]) {
        const a = byId.get(c.id);
        if (!a) continue;
        // Overwrite the denormalized duplicate_clusters totals with REAL
        // (cleanup_class IS NULL) per-type counts so isActionable/byAction/
        // matchesPairingChip below judge the cluster's cross-module status
        // on genuine records only, not cleanup (empty/test/junk/tagged) ones.
        c.total_leads = Number(a.real_leads ?? 0);
        c.total_contacts = Number(a.real_contacts ?? 0);
        c.total_accounts = Number(a.real_accounts ?? 0);
        c.total_deals = Number(a.real_deals ?? 0);
        c.modules_present = a.modules_present ?? [];
        c.owners = a.owners ?? [];
        c.owner_name = (a.owners ?? []).join(", ");
        c.stages = a.stages ?? [];
        c.layouts = a.layouts ?? [];
        c.pipelines = a.pipelines ?? [];

        // Lifecycle flags (string sets already lowercased by the SQL).
        const leadStatuses: string[] = a.lead_statuses ?? [];
        const dealStagesLower: string[] = a.deal_stages_lower ?? [];
        c.has_active_lead =
          (Number(c.total_leads) || 0) > 0 &&
          (leadStatuses.length === 0
            ? true // no statuses captured → assume active (raw_data gap)
            : leadStatuses.some((s) => isActiveLead(s)));
        c.has_active_deal =
          (Number(c.total_deals) || 0) > 0 &&
          (dealStagesLower.length === 0
            ? true
            : dealStagesLower.some((s) => isActiveDeal(s)));
        c.has_client_deal =
          (Number(c.total_deals) || 0) > 0 &&
          dealStagesLower.some((s) => isClientDeal(s));

        // Ledger-resolved heuristic: every module present in the cluster
        // has a matching ledger entry. Empty cluster (no modules) doesn't
        // qualify (nothing to be resolved AGAINST).
        const modulesPresent: string[] = c.modules_present ?? [];
        const modulesLedgerResolved: string[] = a.modules_ledger_resolved ?? [];
        c.ledger_resolved =
          modulesPresent.length > 0 &&
          modulesLedgerResolved.length > 0 &&
          modulesPresent.every((m: string) =>
            modulesLedgerResolved.includes(m),
          );
      }
    } catch (e) {
      logger.warn(
        "[DuplicateRadar] cross-module dimension aggregation failed (filters will skip those dims)",
        { error: e instanceof Error ? e.message : String(e) },
      );
    }
  }

  // ─── Refined-rule filter (Sarah 2026-06-16) ───────────────────────────
  //
  // Hide clusters whose ONLY cross-module relationship is Lead↔Contact or
  // Lead↔Account — those have no Zoho action available on this tab (a
  // Lead can't be linked to anything), and CLOSE-the-Lead is the job of
  // the Leads Duplicates tab anyway. Keep the cluster if ANY of these
  // actionable conditions are true:
  //   • Active Lead alongside an active Deal (wasted prospecting).
  //   • Contact + Account (potential Account_Name link gap).
  //   • Deal + Account (potential Account_Name link gap).
  //   • Contact + Deal (potential Contact_Name link gap).
  //
  // Also drop "effectively resolved" clusters from the Open queue (status
  // 'active' callers only) — these are clusters where the survivor records
  // are all in the resolution ledger, meaning a prior Mark Handled click
  // is being re-displayed because the 6h sync re-clustered.
  // Live-conflict-only rule (Sarah 2026-07-13 "this cluster has no overlap").
  // The old rule flipped a cluster to actionable on bare CO-PRESENCE of
  // contact+account / deal+account / contact+deal — but a Contact and its
  // Account (or a Deal under its Account) for ONE company is the NORMAL CRM
  // hierarchy, not an overlap, and those 2-module LINK gaps moved to the Record
  // Hint tab anyway. It also ignored lifecycle, so a Closed Lost deal + a Not
  // Qualified lead (both DEAD) still counted. Result: legit account hierarchies
  // sprinkled with dead records showed as "3+ modules compound cases".
  //
  // A cross-module cluster is now actionable ONLY on a genuine LIVE conflict —
  // dead records never create work here (has_active_* already exclude Closed
  // Lost/Lost/Dropped deals and Not Qualified/Junk/Lost/Converted leads):
  //   1. An ACTIVE lead is still being worked while the same company already
  //      exists as a real account / contact / active deal → CLOSE the redundant
  //      lead (wasted prospecting on an already-converted company).
  //   2. An existing-CLIENT deal (Paid / Agreement Signed / Closed Won / …)
  //      coexists with an active Sales deal or an active lead → CS conflict,
  //      route to Customer Success.
  // A plain Account + Contacts + Deals hierarchy with no active stray lead and
  // no client-vs-sales conflict is a legitimate hierarchy → hidden.
  const isActionable = (c: any): boolean => {
    const activeLead = !!c.has_active_lead; // implies total_leads > 0
    const activeDeal = !!c.has_active_deal; // implies total_deals > 0
    // A cross-module ALERT is ONLY a genuine LEAD ↔ DEAL conflict (Sarah
    // 2026-07-15): an ACTIVE lead AND an ACTIVE deal for the same company
    // coexisting — Sales is prospecting via a lead while a live deal already
    // exists → CLOSE the redundant lead. Contacts/Accounts are NEVER the
    // conflict; they're the expected hierarchy. So these are NOT cross-module:
    //   • Lead + Contact + Account, no deal   → an unconverted prospect + its
    //     records (nothing to reconcile until there's a deal to conflict with);
    //   • Deal + Contact + Account, no lead    → a normal account hierarchy /
    //     success story;
    //   • Contact + Account (± Deal), no active lead → normal hierarchy.
    // 2-module link gaps live on the Record Hint tab; open-sales-vs-client-deal
    // CS conflicts live on the CS Pipeline Overlap tab.
    return activeLead && activeDeal;
  };
  // Segment chip (Marketplace / WalaPlus / WalaOne) — Sarah 2026-07-13: the chip
  // never reached this tab. Filter by the layouts present on the cluster's member
  // records (c.layouts, aggregated above). Marketplace = a Marketplace/Partner
  // Accounts layout present; WalaOne = a WalaOne layout present; WalaPlus = a
  // corporate layout present (neither of those) OR no layout at all (legacy
  // default). Mirrors the server buildSegmentPredicate layout semantics.
  const _segNorm = (v: any) =>
    String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const segMatch = (c: any): boolean => {
    const seg = opts.segment;
    if (!seg || seg === "all") return true;
    const layouts: string[] = Array.isArray(c.layouts) ? c.layouts : [];
    // Marketplace = layout CONTAINS "marketplace" (e.g. "Doam Marketplace") or
    // "partneraccounts" — substring, not exact (Sarah 2026-07-15). Mirrors the
    // SQL buildSegmentPredicate so this JS path segments identically.
    const _isMktLayout = (v: any) => {
      const n = _segNorm(v);
      return n.includes("marketplace") || n.includes("partneraccounts");
    };
    const isMkt = layouts.some(_isMktLayout);
    const isW1 = layouts.some((v) => _segNorm(v).includes("walaone"));
    if (seg === "marketplace") return isMkt;
    if (seg === "walaone") return isW1;
    // walaplus / corporate: a corporate record present, or no layout at all.
    return (
      layouts.length === 0 ||
      layouts.some((v) => !_isMktLayout(v) && !_segNorm(v).includes("walaone"))
    );
  };

  const visible = realOverlaps.filter((c) => {
    if (!isActionable(c)) return false;
    if (!segMatch(c)) return false;
    if (statusOpt === "active" && (c as any).ledger_resolved) return false;
    // The Record Hint tab now owns the 3 strict 2-module LINKING pairings
    // (Contact↔Account, Contact↔Deal, Deal↔Account) — a cluster classified
    // as EXACTLY one of those no longer belongs on Cross-Module. `mixed`
    // (3+ modules) stays even if it contains one of those relationships,
    // since it's genuinely a compound cross-module case owned here.
    if (
      c.pairing === "contact_account" ||
      c.pairing === "contact_deal" ||
      c.pairing === "deal_account"
    )
      return false;
    return true;
  });

  // Pairing chip filter: a chip click sends pairing=lead_deal /
  // contact_account / etc. Under the refined rules a "Contact ↔ Account"
  // chip should ALSO include 3+ modules clusters that carry a Contact +
  // Account pair, not just the strict 2-module case. Likewise Lead ↔
  // Active Deal must require BOTH sides active. The match table below
  // mirrors the headline-tile semantics so chip filtering and tile
  // counts agree.
  const matchesPairingChip = (c: any, pairing: CrossModulePairing): boolean => {
    const leads = Number(c.total_leads || 0);
    const deals = Number(c.total_deals || 0);
    switch (pairing) {
      case "lead_deal":
        return (
          leads > 0 &&
          deals > 0 &&
          !!c.has_active_lead &&
          !!c.has_active_deal
        );
      case "mixed":
        return c.pairing === "mixed";
      // lead_contact / lead_account / contact_account / contact_deal /
      // deal_account chips are deprecated on this tab — the latter 3 now
      // live on the Record Hint tab (see the `visible` filter above, which
      // already drops those pairings from this endpoint's result set), and
      // lead_contact/lead_account never had a Zoho action here. The chip
      // filters never match; the frontend hides those chips entirely — this
      // just makes the backend safe if a stale client still sends them.
      case "lead_contact":
      case "lead_account":
      case "contact_account":
      case "contact_deal":
      case "deal_account":
        return false;
      default:
        return false;
    }
  };
  const filtered = opts.pairing
    ? visible.filter((c) => matchesPairingChip(c, opts.pairing!))
    : visible;

  // Counts: by_pairing keeps shape for back-compat (Adam tool etc.) but
  // is now computed over `visible` (the actionable set), so lead_contact
  // and lead_account always read 0 — operators should look at by_action.
  const byPairing: Record<string, number> = {};
  let arrTotal = 0;
  for (const c of visible) {
    const key = c.pairing ?? "unknown";
    byPairing[key] = (byPairing[key] ?? 0) + 1;
    arrTotal += Number(c.estimated_pipeline_value ?? 0);
  }
  const byAction = {
    lead_vs_active_deal: 0,
    contact_account_link: 0,
    deal_account_link: 0,
    contact_deal_link: 0,
    three_plus_modules: 0,
    existing_client_cs_owned: 0,
  };
  for (const c of visible as any[]) {
    const leads = Number(c.total_leads || 0);
    const contacts = Number(c.total_contacts || 0);
    const accounts = Number(c.total_accounts || 0);
    const deals = Number(c.total_deals || 0);
    if (
      leads > 0 &&
      deals > 0 &&
      c.has_active_lead &&
      c.has_active_deal
    )
      byAction.lead_vs_active_deal++;
    if (contacts > 0 && accounts > 0) byAction.contact_account_link++;
    if (deals > 0 && accounts > 0) byAction.deal_account_link++;
    if (contacts > 0 && deals > 0) byAction.contact_deal_link++;
    if (c.pairing === "mixed") byAction.three_plus_modules++;
    if (c.has_client_deal) byAction.existing_client_cs_owned++;
  }

  return {
    total: filtered.length,
    by_pairing: byPairing,
    by_action: byAction,
    arr_exposure_total: arrTotal,
    clusters: filtered,
  };
}

/**
 * Follow-up 3 — Bulk-close lead records in cross-module clusters.
 *
 * Context: cross-module clusters (R6) have a Lead alongside a Contact /
 * Account / Deal for the same domain. Zoho doesn't support cross-module
 * merges, so the recommended action is to CLOSE the lead — the company
 * is already represented by the canonical Account / Contact / Deal.
 * Operators were doing this one-by-one in Zoho; this helper does it in
 * bulk via the Zoho update-record API.
 *
 * Per cluster:
 *   1. Fetch the cluster's lead records (record_type='lead', has zoho_record_id)
 *   2. For each lead, call Zoho `PUT /Leads/:id` with
 *      Lead_Status='Lost Lead' + a Description note explaining why.
 *      Already-Lost / already-Junk leads are skipped silently (idempotent).
 *   3. If every lead update succeeded, mark the cluster resolved via
 *      resolveCluster — this also captures a pre-resolve snapshot (R10)
 *      and logs the action in duplicate_merge_actions.
 *   4. If any lead update failed, the cluster is NOT marked resolved —
 *      partial-failure state is reported back so the operator can retry.
 *
 * Safety:
 *   - clusterIds is REQUIRED — callers explicitly enumerate which
 *     clusters to act on (no "close everything matching this filter").
 *   - maxClusters hard-clamps the batch size at 25 (default).
 *   - dryRun=true returns the per-cluster plan without writing.
 *   - Concurrency 3 — Zoho rate limits are real.
 */
export interface BulkCloseLeadResult {
  cluster_id: number;
  leads_closed: number;
  leads_skipped: number;
  leads_failed: number;
  cluster_resolved: boolean;
  errors: Array<{ zoho_lead_id: string; message: string }>;
  notes: string;
}

export async function bulkCloseLeadsInClusters(opts: {
  clusterIds: number[];
  performedBy: string;
  dryRun?: boolean;
  maxClusters?: number;
}): Promise<{
  dry_run: boolean;
  examined: number;
  total_leads_closed: number;
  total_leads_skipped: number;
  total_leads_failed: number;
  clusters_resolved: number;
  per_cluster: BulkCloseLeadResult[];
}> {
  const dryRun = !!opts.dryRun;
  const cap = Math.min(25, Math.max(1, opts.maxClusters ?? 25));
  const ids = Array.isArray(opts.clusterIds)
    ? opts.clusterIds.slice(0, cap)
    : [];

  if (ids.length === 0) {
    return {
      dry_run: dryRun,
      examined: 0,
      total_leads_closed: 0,
      total_leads_skipped: 0,
      total_leads_failed: 0,
      clusters_resolved: 0,
      per_cluster: [],
    };
  }

  const { updateZohoRecord, zohoWritesAllowedInEnv } = await import("./zohoCRM");

  // Env guardrail: bulk-close mutates live Zoho (Lead_Status → Lost Lead), so
  // a REAL run must be blocked outside production (dev shares prod's Zoho
  // credentials). Dry-run is always allowed (it writes nothing).
  if (!dryRun && !zohoWritesAllowedInEnv()) {
    throw new Error(
      "Bulk-close is blocked outside production (dev shares production's Zoho credentials). " +
        "Run it from the deployed app, or set RESOLUTION_ALLOW_WRITES_OUTSIDE_PROD=true only for a dedicated non-prod Zoho org.",
    );
  }

  const closeOneLead = async (
    zohoLeadId: string,
    clusterId: number,
    currentStatus: string | null,
  ): Promise<{ status: "closed" | "skipped" | "failed"; message?: string }> => {
    // Idempotency: skip leads already in a Lost / Junk terminal state so
    // re-running the batch doesn't spam Zoho with no-op updates.
    const lower = (currentStatus ?? "").trim().toLowerCase();
    if (lower === "lost lead" || lower === "junk lead") {
      return { status: "skipped", message: `Already ${currentStatus}` };
    }
    if (dryRun) return { status: "closed" }; // count as "would-close" in dry run
    try {
      await updateZohoRecord("Leads", zohoLeadId, {
        Lead_Status: "Lost Lead",
        Description: `Closed by Duplicate Radar bulk-close on cross-module cluster #${clusterId}. The company is represented in another module (Account / Contact / Deal) and a duplicate Lead is no longer needed.`,
      });
      return { status: "closed" };
    } catch (err) {
      return {
        status: "failed",
        message: (err as Error)?.message ?? String(err),
      };
    }
  };

  const perCluster: BulkCloseLeadResult[] = [];

  for (const clusterId of ids) {
    const leadsR = await pool.query<{
      id: number;
      zoho_record_id: string | null;
      status: string | null;
    }>(
      `SELECT id, zoho_record_id, status
         FROM duplicate_records
        WHERE cluster_id = $1
          AND record_type = 'lead'
          AND zoho_record_id IS NOT NULL
          AND zoho_record_id <> ''`,
      [clusterId],
    );

    const leads = leadsR.rows;
    if (leads.length === 0) {
      perCluster.push({
        cluster_id: clusterId,
        leads_closed: 0,
        leads_skipped: 0,
        leads_failed: 0,
        cluster_resolved: false,
        errors: [],
        notes: "No lead records with zoho_record_id in this cluster",
      });
      continue;
    }

    const concurrency = 3;
    let closed = 0;
    let skipped = 0;
    let failed = 0;
    const errors: BulkCloseLeadResult["errors"] = [];

    for (let i = 0; i < leads.length; i += concurrency) {
      const batch = leads.slice(i, i + concurrency);
      const results = await Promise.all(
        batch.map((l) => closeOneLead(l.zoho_record_id!, clusterId, l.status)),
      );
      for (let j = 0; j < results.length; j++) {
        const r = results[j]!;
        const lead = batch[j]!;
        if (r.status === "closed") closed++;
        else if (r.status === "skipped") skipped++;
        else {
          failed++;
          errors.push({
            zoho_lead_id: lead.zoho_record_id ?? "",
            message: r.message ?? "Unknown error",
          });
        }
      }
    }

    // Mark cluster resolved only when every lead either closed cleanly
    // or was already-skipped. A single failure leaves the cluster active
    // so the operator can investigate / retry without losing visibility.
    let clusterResolved = false;
    const allClean = failed === 0;
    if (allClean && !dryRun) {
      try {
        await resolveCluster(
          clusterId,
          "resolve",
          opts.performedBy,
          undefined,
          `Bulk-close: closed ${closed} lead${closed === 1 ? "" : "s"} in Zoho (cross-module cluster — company represented in another module)`,
        );
        clusterResolved = true;
      } catch (err) {
        // resolveCluster failing after the Zoho writes succeeded is a
        // partial state; surface the error but the leads ARE closed in
        // Zoho already. Operator can mark the cluster resolved manually.
        errors.push({
          zoho_lead_id: "",
          message: `Cluster mark-resolved failed after Zoho updates: ${(err as Error).message}`,
        });
      }
    }

    perCluster.push({
      cluster_id: clusterId,
      leads_closed: closed,
      leads_skipped: skipped,
      leads_failed: failed,
      cluster_resolved: clusterResolved,
      errors,
      notes: dryRun
        ? `Dry run — would close ${closed} lead${closed === 1 ? "" : "s"} (${skipped} already-closed skipped)`
        : `Closed ${closed} lead${closed === 1 ? "" : "s"}, skipped ${skipped}, failed ${failed}`,
    });
  }

  const totalClosed = perCluster.reduce((a, c) => a + c.leads_closed, 0);
  const totalSkipped = perCluster.reduce((a, c) => a + c.leads_skipped, 0);
  const totalFailed = perCluster.reduce((a, c) => a + c.leads_failed, 0);
  const clustersResolved = perCluster.filter((c) => c.cluster_resolved).length;

  return {
    dry_run: dryRun,
    examined: ids.length,
    total_leads_closed: totalClosed,
    total_leads_skipped: totalSkipped,
    total_leads_failed: totalFailed,
    clusters_resolved: clustersResolved,
    per_cluster: perCluster,
  };
}

export async function getSyncState(
  module: string,
): Promise<ZohoSyncState | null> {
  const result = await pool.query(
    "SELECT * FROM zoho_sync_state WHERE module = $1",
    [module],
  );
  return result.rows[0] || null;
}

export async function getAllSyncStates(): Promise<ZohoSyncState[]> {
  // Tasks module was removed platform-wide; filter out any stale rows so the
  // Sync Status badges only reflect modules we actively sync.
  const result = await pool.query(
    "SELECT * FROM zoho_sync_state WHERE module NOT IN ('Tasks') ORDER BY module",
  );
  return result.rows;
}

export async function upsertSyncState(
  module: string,
  totalSynced: number,
  status: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO zoho_sync_state (module, last_sync_at, total_synced, sync_status)
     VALUES ($1, NOW(), $2, $3)
     ON CONFLICT (module) DO UPDATE SET last_sync_at = NOW(), total_synced = $2, sync_status = $3`,
    [module, totalSynced, status],
  );
}

export async function getDistinctOwners(): Promise<string[]> {
  const result = await pool.query(
    `SELECT DISTINCT owner_name FROM duplicate_records WHERE owner_name IS NOT NULL AND owner_name != '' ORDER BY owner_name`,
  );
  return result.rows.map((r) => r.owner_name);
}

export async function getDistinctLayouts(): Promise<string[]> {
  const result = await pool.query(
    `SELECT DISTINCT layout_name FROM duplicate_records WHERE layout_name IS NOT NULL AND layout_name != '' ORDER BY layout_name`,
  );
  return result.rows.map((r) => r.layout_name);
}

export async function getDistinctDomains(): Promise<string[]> {
  const result = await pool.query(
    `SELECT DISTINCT domain FROM duplicate_records WHERE domain IS NOT NULL AND domain != '' ORDER BY domain LIMIT 200`,
  );
  return result.rows.map((r) => r.domain);
}

export async function getDistinctProducts(): Promise<string[]> {
  const result = await pool.query(
    `SELECT DISTINCT products FROM duplicate_records WHERE products IS NOT NULL AND products != '' ORDER BY products`,
  );
  return result.rows.map((r) => r.products);
}

export async function getDistinctPipelines(): Promise<string[]> {
  const result = await pool.query(
    `SELECT DISTINCT pipeline FROM duplicate_records WHERE pipeline IS NOT NULL AND pipeline != '' ORDER BY pipeline`,
  );
  return result.rows.map((r) => r.pipeline);
}

// Distinct Deal stages — restricted to the Deals module since stage only
// applies to Deal records. Used to populate the Stage filter dropdown.
export async function getDistinctStages(): Promise<string[]> {
  const result = await pool.query(
    `SELECT DISTINCT stage FROM duplicate_records
       WHERE zoho_module = 'Deals' AND stage IS NOT NULL AND stage != ''
       ORDER BY stage`,
  );
  return result.rows.map((r) => r.stage);
}

export async function getFilteredClusters(
  filters: DuplicateFilters,
  limit = 30,
  offset = 0,
): Promise<{ clusters: DuplicateCluster[]; total: number }> {
  let whereConditions = ["c.status = $1"];
  let params: any[] = [filters.status || "active"];
  let paramIdx = 2;

  // Hide placeholder / junk-name clusters (Sarah 2026-07-14) — same as the
  // direct Domain Clusters load (buildClusterFilterClause) so the Advanced-Filter
  // path stays consistent.
  whereConditions.push(`c.domain <> '${PLACEHOLDER_CLUSTER_DOMAIN}'`);
  whereConditions.push(
    `LOWER(BTRIM(COALESCE(c.company_name,''))) <> ALL($${paramIdx++}::text[])`,
  );
  params.push(PLACEHOLDER_COMPANY_NAMES_LOWER_ARR);

  if (filters.confidence_level) {
    whereConditions.push(`c.confidence_level = $${paramIdx++}`);
    params.push(filters.confidence_level);
  }

  if (filters.start_date) {
    whereConditions.push(`c.created_at >= $${paramIdx++}`);
    params.push(filters.start_date);
  }

  if (filters.end_date) {
    whereConditions.push(`c.created_at <= $${paramIdx++}`);
    params.push(filters.end_date);
  }

  let joinNeeded = false;
  let recordConditions: string[] = [];

  if (filters.modules && filters.modules.length > 0) {
    joinNeeded = true;
    recordConditions.push(
      `r.zoho_module IN (${filters.modules.map((_, i) => `$${paramIdx + i}`).join(",")})`,
    );
    params.push(...filters.modules);
    paramIdx += filters.modules.length;
  }

  if (filters.owners && filters.owners.length > 0) {
    joinNeeded = true;
    recordConditions.push(
      `r.owner_name IN (${filters.owners.map((_, i) => `$${paramIdx + i}`).join(",")})`,
    );
    params.push(...filters.owners);
    paramIdx += filters.owners.length;
  }

  if (filters.layouts && filters.layouts.length > 0) {
    joinNeeded = true;
    recordConditions.push(
      `r.layout_name IN (${filters.layouts.map((_, i) => `$${paramIdx + i}`).join(",")})`,
    );
    params.push(...filters.layouts);
    paramIdx += filters.layouts.length;
  }

  if (filters.pipelines && filters.pipelines.length > 0) {
    joinNeeded = true;
    recordConditions.push(
      `r.pipeline IN (${filters.pipelines.map((_, i) => `$${paramIdx + i}`).join(",")})`,
    );
    params.push(...filters.pipelines);
    paramIdx += filters.pipelines.length;
  }

  if (filters.stages && filters.stages.length > 0) {
    joinNeeded = true;
    recordConditions.push(
      `r.stage IN (${filters.stages.map((_, i) => `$${paramIdx + i}`).join(",")})`,
    );
    params.push(...filters.stages);
    paramIdx += filters.stages.length;
  }

  if (filters.domain) {
    joinNeeded = true;
    recordConditions.push(`r.domain ILIKE $${paramIdx++}`);
    params.push(`%${filters.domain}%`);
  }

  const segmentClause = buildSegmentPredicate(filters.segment, paramIdx);
  if (segmentClause.condition) {
    joinNeeded = joinNeeded || segmentClause.needsRecordJoin;
    recordConditions.push(segmentClause.condition);
    params.push(...segmentClause.params);
    paramIdx += segmentClause.params.length;
  }

  const joinClause = joinNeeded
    ? "INNER JOIN duplicate_records r ON r.cluster_id = c.id"
    : "";
  const recordWhere =
    recordConditions.length > 0 ? "AND " + recordConditions.join(" AND ") : "";

  const countQuery = `SELECT COUNT(DISTINCT c.id) as total FROM duplicate_clusters c ${joinClause} WHERE ${whereConditions.join(" AND ")} ${recordWhere}`;
  const countResult = await pool.query(countQuery, params);
  const total = parseInt(countResult.rows[0].total);

  const dataParams = [...params, limit, offset];
  const dataQuery = `SELECT DISTINCT c.* FROM duplicate_clusters c ${joinClause} WHERE ${whereConditions.join(" AND ")} ${recordWhere} ORDER BY c.confidence_score DESC, c.total_records DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
  const dataResult = await pool.query(dataQuery, dataParams);

  return { clusters: dataResult.rows, total };
}

export async function getFilteredSummary(
  filters: DuplicateFilters,
): Promise<any> {
  let whereConditions = ["c.status = 'active'"];
  let params: any[] = [];
  let paramIdx = 1;

  // Hide placeholder / junk-name clusters (Sarah 2026-07-14) — keep the summary
  // KPIs consistent with the filtered cluster list.
  whereConditions.push(`c.domain <> '${PLACEHOLDER_CLUSTER_DOMAIN}'`);
  whereConditions.push(
    `LOWER(BTRIM(COALESCE(c.company_name,''))) <> ALL($${paramIdx++}::text[])`,
  );
  params.push(PLACEHOLDER_COMPANY_NAMES_LOWER_ARR);

  let joinNeeded = false;
  let recordConditions: string[] = [];

  if (filters.modules && filters.modules.length > 0) {
    joinNeeded = true;
    recordConditions.push(
      `r.zoho_module IN (${filters.modules.map((_, i) => `$${paramIdx + i}`).join(",")})`,
    );
    params.push(...filters.modules);
    paramIdx += filters.modules.length;
  }

  if (filters.owners && filters.owners.length > 0) {
    joinNeeded = true;
    recordConditions.push(
      `r.owner_name IN (${filters.owners.map((_, i) => `$${paramIdx + i}`).join(",")})`,
    );
    params.push(...filters.owners);
    paramIdx += filters.owners.length;
  }

  if (filters.stages && filters.stages.length > 0) {
    joinNeeded = true;
    recordConditions.push(
      `r.stage IN (${filters.stages.map((_, i) => `$${paramIdx + i}`).join(",")})`,
    );
    params.push(...filters.stages);
    paramIdx += filters.stages.length;
  }

  if (filters.domain) {
    joinNeeded = true;
    recordConditions.push(`r.domain ILIKE $${paramIdx++}`);
    params.push(`%${filters.domain}%`);
  }

  const segmentClause = buildSegmentPredicate(filters.segment, paramIdx);
  if (segmentClause.condition) {
    joinNeeded = joinNeeded || segmentClause.needsRecordJoin;
    recordConditions.push(segmentClause.condition);
    params.push(...segmentClause.params);
    paramIdx += segmentClause.params.length;
  }

  const joinClause = joinNeeded
    ? "INNER JOIN duplicate_records r ON r.cluster_id = c.id"
    : "";
  const recordWhere =
    recordConditions.length > 0 ? "AND " + recordConditions.join(" AND ") : "";

  const query = `
    SELECT
      COUNT(DISTINCT c.id) as total_clusters,
      COUNT(DISTINCT CASE WHEN c.confidence_level = 'high' THEN c.id END) as high_confidence,
      COUNT(DISTINCT CASE WHEN c.confidence_level = 'medium' THEN c.id END) as medium_confidence,
      COUNT(DISTINCT CASE WHEN c.confidence_level = 'low' THEN c.id END) as low_confidence,
      COALESCE(SUM(c.estimated_pipeline_value), 0) as pipeline_inflation
    FROM duplicate_clusters c ${joinClause}
    WHERE ${whereConditions.join(" AND ")} ${recordWhere}
  `;

  const result = await pool.query(query, params);
  const row = result.rows[0];

  // Actionable per-module duplicate counts under the SAME filter — matches
  // the act_leads/act_deals/act_contacts/act_accounts logic in
  // getEnhancedSummary so the Executive Summary tiles can rescope by segment
  // (or any other filter) without lying. r.is_primary = false EXCLUDES the
  // survivor in each cluster — these are the records the team actually has
  // to act on. Reuses the SAME r alias that recordConditions/segmentClause
  // were written against, so the filter applies cleanly and we count out of
  // exactly one join.
  const actionableQuery = `
    SELECT
      COUNT(*) FILTER (WHERE r.record_type = 'lead'    AND c.total_leads    > 1 AND r.is_primary = false) AS act_leads,
      COUNT(*) FILTER (WHERE r.record_type = 'deal'    AND c.total_deals    > 1 AND r.is_primary = false) AS act_deals,
      COUNT(*) FILTER (WHERE r.record_type = 'contact' AND c.total_contacts > 1 AND r.is_primary = false) AS act_contacts,
      COUNT(*) FILTER (WHERE r.record_type = 'account' AND c.total_accounts > 1 AND r.is_primary = false) AS act_accounts
    FROM duplicate_clusters c
    INNER JOIN duplicate_records r ON r.cluster_id = c.id
    WHERE ${whereConditions.join(" AND ")} ${recordWhere}
  `;
  const actionable = await pool.query(actionableQuery, params).then(
    (r) => r.rows[0],
    () => null,
  );

  return {
    totalClusters: parseInt(row.total_clusters),
    highConfidence: parseInt(row.high_confidence),
    mediumConfidence: parseInt(row.medium_confidence),
    lowConfidence: parseInt(row.low_confidence),
    estimatedPipelineInflation: parseFloat(row.pipeline_inflation),
    totalDuplicateLeads: actionable ? parseInt(actionable.act_leads) || 0 : 0,
    totalDuplicateDeals: actionable ? parseInt(actionable.act_deals) || 0 : 0,
    totalDuplicateContacts: actionable ? parseInt(actionable.act_contacts) || 0 : 0,
    totalDuplicateAccounts: actionable ? parseInt(actionable.act_accounts) || 0 : 0,
  };
}

export async function upsertTask(
  task: Omit<DuplicateRecordTask, "id" | "created_at">,
): Promise<DuplicateRecordTask> {
  const result = await pool.query(
    `INSERT INTO duplicate_record_tasks (zoho_task_id, related_record_id, cluster_id, subject, due_date, status, owner_name, description)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (zoho_task_id) DO UPDATE SET
       subject = EXCLUDED.subject, due_date = EXCLUDED.due_date, status = EXCLUDED.status,
       owner_name = EXCLUDED.owner_name, description = EXCLUDED.description
     RETURNING *`,
    [
      task.zoho_task_id,
      task.related_record_id,
      task.cluster_id,
      task.subject,
      task.due_date,
      task.status,
      task.owner_name,
      task.description,
    ],
  );
  return result.rows[0];
}

export async function getTasksForRecords(
  recordIds: string[],
): Promise<DuplicateRecordTask[]> {
  if (recordIds.length === 0) return [];
  const placeholders = recordIds.map((_, i) => `$${i + 1}`).join(",");
  const result = await pool.query(
    `SELECT * FROM duplicate_record_tasks WHERE related_record_id IN (${placeholders}) ORDER BY due_date DESC`,
    recordIds,
  );
  return result.rows;
}

export async function getTaskCountForCluster(
  clusterId: number,
): Promise<number> {
  const result = await pool.query(
    `SELECT COUNT(*) as cnt FROM duplicate_record_tasks WHERE cluster_id = $1`,
    [clusterId],
  );
  return parseInt(result.rows[0].cnt);
}

export async function calculateEnhancedScore(
  record1: DuplicateRecord,
  record2: DuplicateRecord,
): Promise<{ score: number; signals: string[] }> {
  const base = calculateMultiSignalScore(
    {
      email: record1.email,
      domain: record1.domain,
      phone: record1.phone,
      company_name: record1.company_name,
    },
    {
      email: record2.email,
      domain: record2.domain,
      phone: record2.phone,
      company_name: record2.company_name,
    },
  );

  let score = base.score;
  const signals = [...base.signals];

  if (record1.mobile && record2.mobile) {
    const m1 = normalizePhone(record1.mobile);
    const m2 = normalizePhone(record2.mobile);
    if (m1 && m2 && m1.length >= 7 && m1 === m2) {
      score += 25;
      signals.push("mobile_match");
    }
  }

  if (
    record1.cr_number &&
    record2.cr_number &&
    record1.cr_number === record2.cr_number
  ) {
    score += 35;
    signals.push("cr_number_match");
  }

  if (
    record1.vat_number &&
    record2.vat_number &&
    record1.vat_number === record2.vat_number
  ) {
    score += 30;
    signals.push("vat_number_match");
  }

  if (record1.website && record2.website) {
    const w1 = record1.website
      .toLowerCase()
      .replace(/^https?:\/\/(www\.)?/, "")
      .split("/")[0];
    const w2 = record2.website
      .toLowerCase()
      .replace(/^https?:\/\/(www\.)?/, "")
      .split("/")[0];
    if (w1 === w2) {
      score += 20;
      signals.push("website_match");
    }
  }

  return { score: Math.min(score, 100), signals };
}

export interface DataQualityResult {
  score: number;
  flags: string[];
  isJunk: boolean;
}

const GIBBERISH_REGEX = /^[a-zA-Z]{20,}$/;
const RANDOM_MIXED_REGEX = /^[a-zA-Z0-9]{25,}$/;
const CONSECUTIVE_CAPS_REGEX = /[A-Z]{8,}/;
const NAME_GARBAGE = [
  "test",
  "testing",
  "asdf",
  "qwerty",
  "xxx",
  "yyy",
  "zzz",
  "demo",
  "sample",
  "unknown",
  "n/a",
  "na",
  "-",
  ".",
  "..",
  "null",
];

function isGibberishName(name: string): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  if (trimmed.length < 2) return true;

  const words = trimmed.split(/\s+/);
  if (words.some((w) => w.length > 25 && /^[a-zA-Z]+$/.test(w))) return true;
  if (GIBBERISH_REGEX.test(trimmed.replace(/\s/g, ""))) return true;
  if (RANDOM_MIXED_REGEX.test(trimmed.replace(/\s/g, ""))) return true;

  const latinLetters = (trimmed.match(/[a-zA-Z]/g) || []).length;
  const upperCase = (trimmed.match(/[A-Z]/g) || []).length;
  if (latinLetters > 10 && upperCase / latinLetters > 0.6) return true;
  if (CONSECUTIVE_CAPS_REGEX.test(trimmed)) return true;

  const consonants = (
    trimmed.toLowerCase().match(/[bcdfghjklmnpqrstvwxyz]/g) || []
  ).length;
  const vowels = (trimmed.toLowerCase().match(/[aeiou]/g) || []).length;
  if (latinLetters > 10 && vowels === 0) return true;
  if (
    latinLetters > 15 &&
    consonants > 0 &&
    vowels > 0 &&
    consonants / vowels > 8
  )
    return true;

  return false;
}

function isSuspiciousEmail(email: string): boolean {
  if (!email) return false;
  const local = email.split("@")[0] || "";
  if (/\d{6,}/.test(local)) return true;
  if (local.length > 30 && /^[a-z0-9.]+$/.test(local)) {
    const dots = (local.match(/\./g) || []).length;
    if (dots > 4) return true;
  }
  return false;
}

export function assessDataQuality(record: {
  recordName?: string;
  companyName?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  ownerName?: string;
  domain?: string | null;
}): DataQualityResult {
  const flags: string[] = [];
  let score = 100;

  const name = record.recordName || "";
  const nameLower = name.toLowerCase().trim();
  if (!name || nameLower === "-" || nameLower === ".") {
    flags.push("missing_name");
    score -= 20;
  } else if (NAME_GARBAGE.includes(nameLower)) {
    flags.push("garbage_name");
    score -= 40;
  } else if (isGibberishName(name)) {
    flags.push("gibberish_name");
    score -= 50;
  }

  const company = record.companyName || "";
  if (!company || company === "Unknown") {
    flags.push("missing_company");
    score -= 15;
  } else if (isGibberishName(company)) {
    flags.push("gibberish_company");
    score -= 30;
  }

  if (!record.email) {
    flags.push("missing_email");
    score -= 10;
  } else if (isSuspiciousEmail(record.email)) {
    flags.push("suspicious_email");
    score -= 15;
  }

  const phoneNorm = record.phone ? normalizePhone(record.phone) : "";
  const mobileNorm = record.mobile ? normalizePhone(record.mobile) : "";
  if (!phoneNorm && !mobileNorm) {
    flags.push("missing_phone");
    score -= 10;
  }

  if (!record.ownerName || record.ownerName === "Unknown") {
    flags.push("missing_owner");
    score -= 5;
  }

  if (!record.domain) {
    flags.push("no_business_domain");
    score -= 5;
  }

  return {
    score: Math.max(0, score),
    flags,
    isJunk:
      score <= 20 ||
      flags.includes("gibberish_name") ||
      flags.includes("garbage_name"),
  };
}

export async function lookupRecordsByZohoIds(zohoIds: string[]): Promise<{
  [zohoId: string]: {
    clusterId: number;
    clusterDomain: string;
    clusterCompany: string | null;
    confidenceLevel: string;
    confidenceScore: number;
    totalInCluster: number;
    dataQualityScore: number;
    dataQualityFlags: string[];
    recordType: string;
    isJunk: boolean;
  };
}> {
  if (!zohoIds.length) return {};
  const result = await pool.query(
    `SELECT dr.zoho_record_id, dr.cluster_id, dr.record_type,
            dr.data_quality_score, dr.data_quality_flags,
            dc.domain, dc.company_name, dc.confidence_level,
            dc.confidence_score, dc.total_records
     FROM duplicate_records dr
     JOIN duplicate_clusters dc ON dc.id = dr.cluster_id
     WHERE dr.zoho_record_id = ANY($1)`,
    [zohoIds],
  );
  const map: Record<string, any> = {};
  for (const row of result.rows) {
    map[row.zoho_record_id] = {
      clusterId: row.cluster_id,
      clusterDomain: row.domain,
      clusterCompany: row.company_name,
      confidenceLevel: row.confidence_level,
      confidenceScore: row.confidence_score,
      totalInCluster: row.total_records,
      dataQualityScore: row.data_quality_score ?? 100,
      dataQualityFlags: row.data_quality_flags || [],
      recordType: row.record_type,
      isJunk: row.cluster_id && row.domain === "__JUNK_RECORDS__",
    };
  }
  return map;
}

export async function runLiveQualityCheck(
  records: Array<{
    id: string;
    Full_Name?: string;
    Last_Name?: string;
    First_Name?: string;
    Company?: string;
    Account_Name?: any;
    Deal_Name?: string;
    Email?: string;
    Phone?: string;
    Mobile?: string;
    Owner?: any;
  }>,
): Promise<{
  [id: string]: { score: number; flags: string[]; isJunk: boolean };
}> {
  const results: Record<string, any> = {};
  for (const r of records) {
    const name =
      r.Full_Name ||
      r.Deal_Name ||
      (r.First_Name
        ? `${r.First_Name} ${r.Last_Name || ""}`.trim()
        : r.Last_Name) ||
      "";
    const company =
      typeof r.Company === "string"
        ? r.Company
        : (typeof r.Account_Name === "object"
            ? r.Account_Name?.name
            : r.Account_Name) || "";
    const owner = typeof r.Owner === "object" ? r.Owner?.name : r.Owner || "";
    const email = r.Email || "";
    const phone = r.Phone || "";
    const mobile = r.Mobile || "";
    const domain = email.includes("@") ? email.split("@")[1] : undefined;
    const dq = assessDataQuality({
      recordName: name,
      companyName: company,
      email,
      phone,
      mobile,
      ownerName: owner,
      domain,
    });
    results[r.id] = { score: dq.score, flags: dq.flags, isJunk: dq.isJunk };
  }
  return results;
}

// ─── CS-pipeline overlap detection (Phase 1) ──────────────────────────────────
// Scans duplicate_records belonging to a cluster, classifies any Deal records
// whose raw_data exposes the Customer Success section (Phase + Churn Date),
// rolls up to a cluster-level verdict (BLOCK / REVIEW / WARN), and persists
// the verdict + ARR exposure + lifecycle state + sector on the cluster row.
// All thresholds and field names are env-configurable; see duplicateRadarCsOverlap.

import {
  classifyClusterOverlap,
  extractCsFieldsFromRawData,
  extractDealStage,
  type ClusterDealInfo,
  type CsLifecycleState,
  type CsOverlapVerdict,
  type ClientSector,
} from "./duplicateRadarCsOverlap";

export interface CsOverlapScanResult {
  cluster_id: number;
  verdict: CsOverlapVerdict;
  lifecycle_state: CsLifecycleState;
  sector: ClientSector;
  arr_exposure: number;
  classified_records: number;
}

/**
 * Scan a single cluster's records and persist the cs_overlap verdict.
 * Returns the persisted summary, or { verdict: null } if no CS deals found.
 */
export async function scanClusterForCsOverlap(
  clusterId: number,
): Promise<CsOverlapScanResult> {
  const clusterRow = await pool.query(
    `SELECT id, domain FROM duplicate_clusters WHERE id = $1`,
    [clusterId],
  );
  if (clusterRow.rows.length === 0) {
    return {
      cluster_id: clusterId,
      verdict: null,
      lifecycle_state: null,
      sector: null,
      arr_exposure: 0,
      classified_records: 0,
    };
  }
  const domain = clusterRow.rows[0].domain as string;

  const recordsRow = await pool.query(
    `SELECT id, zoho_module, raw_data, gov_type
       FROM duplicate_records
       WHERE cluster_id = $1
         AND zoho_module = 'Deals'
         AND cleanup_class IS NULL`,
    [clusterId],
  );
  // cleanup_class IS NULL (Sarah 2026-07-14): exclude empty/test/junk/orphaned/
  // tagged + ghost deals from the overlap classification — same records the tab
  // and modal already hide. A hidden junk/ghost deal (often stage-less) was
  // being counted as a phantom "open sales deal", so a cluster with only a real
  // Agreement-Signed/Paid deal (a normal signed customer, NO open sales deal)
  // was wrongly flagged BLOCK and its ARR double-counted.

  // Build the cluster-level deal list: every Deal record's Stage + CS section
  // + ARR. The new classifier (Sarah Hijazi 2026-06-11) needs the WHOLE set
  // so it can detect "OPEN sales deal + Paid/Agreement-Signed handoff deal
  // coexist" — the per-deal classifier alone can't see that co-existence.
  const deals: ClusterDealInfo[] = [];
  let classifiedCount = 0;
  for (const rec of recordsRow.rows) {
    const fields = extractCsFieldsFromRawData(rec.raw_data, { domain });
    // gov_type column is preferred over raw_data lookup if present
    if (rec.gov_type) fields.gov_type = rec.gov_type;
    const stage = extractDealStage(rec.raw_data);
    deals.push({
      stage,
      cs: fields,
      arr_value: typeof fields.arr_value === "number" ? fields.arr_value : null,
    });
    // Count any deal with a readable CS phase as "classified" for the
    // cluster-level metric the route already exposes.
    if (fields.phase && String(fields.phase).trim() !== "") classifiedCount++;
  }

  const verdictPick = classifyClusterOverlap(deals);

  await pool.query(
    `UPDATE duplicate_clusters
       SET cs_overlap_verdict       = $2,
           pipeline_lifecycle_state = $3,
           client_sector            = $4,
           arr_exposure             = $5,
           updated_at               = NOW()
       WHERE id = $1`,
    [
      clusterId,
      verdictPick.verdict,
      verdictPick.lifecycle_state,
      verdictPick.sector,
      verdictPick.arr_exposure,
    ],
  );

  return {
    cluster_id: clusterId,
    verdict: verdictPick.verdict,
    lifecycle_state: verdictPick.lifecycle_state,
    sector: verdictPick.sector,
    arr_exposure: verdictPick.arr_exposure,
    classified_records: classifiedCount,
  };
}

export interface CsOverlapBatchResult {
  scanned: number;
  flagged: number;
  block_count: number;
  review_count: number;
  warn_count: number;
  total_arr_exposure: number;
  duration_ms: number;
}

/**
 * Scan every cluster that has at least one Deal record. Idempotent — safe to
 * re-run any time (e.g. nightly, or on-demand after Zoho resync).
 */
export async function scanAllClustersForCsOverlap(): Promise<CsOverlapBatchResult> {
  const t0 = Date.now();
  const eligible = await pool.query(
    `SELECT DISTINCT c.id
       FROM duplicate_clusters c
       INNER JOIN duplicate_records r ON r.cluster_id = c.id
       WHERE r.zoho_module = 'Deals'`,
  );

  const out: CsOverlapBatchResult = {
    scanned: 0,
    flagged: 0,
    block_count: 0,
    review_count: 0,
    warn_count: 0,
    total_arr_exposure: 0,
    duration_ms: 0,
  };

  // Per-cluster scan was sequential, which gave us 3 DB round-trips × N clusters
  // and a 504 from the gateway on datasets with several hundred eligible
  // clusters. Run a small batch in parallel (6 ≤ default pg pool size 10, so
  // the route handler's own connection still has room) — wall time drops by
  // roughly the batch size.
  const CONCURRENCY = 6;
  for (let i = 0; i < eligible.rows.length; i += CONCURRENCY) {
    const batch = eligible.rows.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((row) => scanClusterForCsOverlap(row.id)),
    );
    for (const res of results) {
      out.scanned++;
      if (!res.verdict) continue;
      out.flagged++;
      if (res.verdict === "block") out.block_count++;
      else if (res.verdict === "review") out.review_count++;
      else if (res.verdict === "warn") out.warn_count++;
      out.total_arr_exposure += res.arr_exposure;
    }
  }

  out.duration_ms = Date.now() - t0;
  logger.info("[duplicateRadar] CS overlap scan complete", out);
  return out;
}

// ─── CS Lifecycle Compliance scan (Phase 4) ──────────────────────────────────
// Iterates every Deal record in duplicate_records and evaluates whether its
// Customer Success section violates any of the GRQ-defined CS process rules
// (onboarding duration, phase ↔ churn-date sync, phase-transition SLA).
// Pure computation in csLifecycleCompliance.ts; this layer only does the
// per-record fan-out and rollup.

import {
  evaluateCsLifecycle,
  summarizeViolations,
  type CsLifecycleEvaluation,
  type CsLifecycleSummary,
  type CsViolation,
  type CsViolationCode,
  type CsViolationSeverity,
} from "./csLifecycleCompliance";

export interface CsLifecycleViolationRow {
  record_id: number;
  cluster_id: number | null;
  zoho_record_id: string | null;
  account_name: string | null;
  domain: string | null;
  current_phase: string | null;
  days_since_modified: number | null;
  cs_owner_name: string | null;
  customer_since: string | null;
  renewal_date: string | null;
  churn_date: string | null;
  health: string | null;
  // ExtID (Admin) — Zoho custom field surfaced in the CS Lifecycle tab
  // (operator request 2026-05-30). Replaces the Health column in the
  // dashboard UI; Health stays on the row so existing CSV exports and
  // any future consumer keep both signals available.
  ext_id: string | null;
  // 2026-06-08 — surface the underlying Zoho Deal's Layout name + Stage
  // value on the row so the dashboard's Advanced Filters (Layout /
  // Stage / Pipeline multi-selects) can actually narrow the CS
  // Lifecycle violation list. Without these, selecting Layout=WalaPlus
  // or Stage=Agreement Signed on this tab had no visible effect — the
  // client-side rowMatchesAdvancedFilter() had no field to match
  // against. Pulled from raw_data inside scanCsLifecycleViolations.
  layout: string | null;
  stage: string | null;
  pipeline: string | null;
  violation: CsViolation;
}

export interface CsLifecycleScanResult {
  summary: CsLifecycleSummary;
  violations: CsLifecycleViolationRow[];
  duration_ms: number;
}

/**
 * Scan every Deal record under duplicate_records for CS lifecycle violations.
 * Returns the summary plus a flat array of violation rows. No persistence —
 * the scan is cheap enough to recompute on demand (data is bounded to deals
 * the radar already indexes).
 */
/**
 * CS OWNER ROSTER (Sarah 2026-07-20). The platform stores no CS team list — the
 * owner lives per-deal in Zoho's "CS Owner Name" field, so nothing could answer
 * "who are the CS owners?" (Adam included). This derives the roster from the
 * data: the DISTINCT CS Owner Name values across Deal records, with how many
 * deals/accounts each owns, plus how many CS deals have NO owner (the
 * missing_cs_owner gap). Tolerates Zoho's key variants and the lookup-object
 * shape ({name}) exactly like duplicateRadarCsOverlap's extractor.
 */
export interface CsOwnerRow {
  owner: string;
  deals: number;
  accounts: number;
  /** True when this name resolves to a member of the maintained CS roster. */
  on_roster: boolean;
  /** Roster mailbox when matched — the stable identity behind the display name. */
  email: string | null;
}
export async function getCsOwners(
  opts: { segment?: DuplicateFilters["segment"]; limit?: number } = {},
): Promise<{
  owners: CsOwnerRow[];
  totalOwners: number;
  totalCsDeals: number;
  dealsWithoutOwner: number;
  /** Roster members carrying NO deals — nobody assigned / new joiner. */
  roster_without_deals: Array<{ name: string; email: string }>;
  /** Names found on deals that are NOT on the roster — typo / ex-employee / non-CS person. */
  off_roster_names: string[];
  /** Size of the maintained roster (independent of the deal data). */
  roster_size: number;
}> {
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
  // Zoho key variants — hardcoded constants (no injection surface). A lookup
  // field arrives as {name}; a picklist/text arrives as a bare string.
  const OWNER_KEYS = [
    "CS_Owner_Name",
    "CS_Owner",
    "CS_Owner1",
    "CSOwnerName",
    "cs_owner_name",
    "CS Owner Name",
  ];
  const PHASE_KEYS = ["Phase", "phase", "CS_Phase", "Customer_Phase"];
  const jsonText = (key: string) =>
    `CASE WHEN jsonb_typeof(r.raw_data->'${key}') = 'object' THEN NULLIF(BTRIM(r.raw_data->'${key}'->>'name'),'')` +
    ` WHEN jsonb_typeof(r.raw_data->'${key}') = 'string' THEN NULLIF(BTRIM(r.raw_data->>'${key}'),'') ELSE NULL END`;
  const ownerExpr = `COALESCE(${OWNER_KEYS.map(jsonText).join(", ")})`;
  const phaseExpr = `COALESCE(${PHASE_KEYS.map(jsonText).join(", ")})`;

  const params: any[] = [];
  const seg = buildSegmentPredicate(opts.segment, 1);
  let segmentCond = "";
  if (seg.condition) {
    segmentCond = ` AND ${seg.condition}`;
    params.push(...seg.params);
  }
  const baseCte = `
    WITH cs AS (
      SELECT ${ownerExpr} AS owner,
             ${phaseExpr} AS phase,
             r.account_name
        FROM duplicate_records r
       WHERE r.record_type = 'deal'
         AND r.cleanup_class IS NULL${segmentCond}
    )`;

  const ownersQ = await pool.query<{ owner: string; deals: string; accounts: string }>(
    `${baseCte}
     SELECT owner,
            COUNT(*)::text AS deals,
            COUNT(DISTINCT NULLIF(BTRIM(account_name), ''))::text AS accounts
       FROM cs
      WHERE owner IS NOT NULL
      GROUP BY owner
      ORDER BY COUNT(*) DESC, owner ASC
      LIMIT $${params.length + 1}`,
    [...params, limit],
  );
  // "CS deals" for the no-owner gap = deals that carry a CS Phase (i.e. are on
  // the CS pipeline). Counting every Deal would drown the number in sales deals.
  const gapQ = await pool.query<{ with_owner: string; without_owner: string }>(
    `${baseCte}
     SELECT COUNT(*) FILTER (WHERE owner IS NOT NULL)::text AS with_owner,
            COUNT(*) FILTER (WHERE owner IS NULL AND phase IS NOT NULL)::text AS without_owner
       FROM cs`,
    params,
  );
  // Cross-reference the derived names against the MAINTAINED roster. The two
  // answer different questions — the roster is who is ON the team, the query is
  // who actually carries deals — and the mismatch in either direction is the
  // useful signal (Sarah 2026-07-21).
  const { getCsTeamMembers, matchCsTeamMember } = await import("./csTeamMembers");
  const roster = getCsTeamMembers();
  const seenEmails = new Set<string>();
  const offRoster: string[] = [];
  const owners: CsOwnerRow[] = ownersQ.rows.map((r) => {
    const member = matchCsTeamMember(r.owner);
    if (member) seenEmails.add(member.email.toLowerCase());
    else if (r.owner) offRoster.push(r.owner);
    return {
      owner: r.owner,
      deals: parseInt(r.deals) || 0,
      accounts: parseInt(r.accounts) || 0,
      on_roster: !!member,
      email: member ? member.email : null,
    };
  });
  const rosterWithoutDeals = roster
    .filter((m) => !seenEmails.has(m.email.toLowerCase()))
    .map((m) => ({ name: m.name, email: m.email }));

  return {
    owners,
    totalOwners: owners.length,
    totalCsDeals: parseInt(gapQ.rows[0]?.with_owner || "0") || 0,
    dealsWithoutOwner: parseInt(gapQ.rows[0]?.without_owner || "0") || 0,
    roster_without_deals: rosterWithoutDeals,
    off_roster_names: offRoster,
    roster_size: roster.length,
  };
}

export async function scanCsLifecycleViolations(opts: {
  severity?: CsViolationSeverity;
  code?: CsViolationCode;
  limit?: number;
  segment?: DuplicateFilters["segment"];
} = {}): Promise<CsLifecycleScanResult> {
  const t0 = Date.now();
  // Bumped default 2000 → 10000 and cap 5000 → 50000 so the scan covers
  // the full Deal corpus by default. The bulk Zoho sync currently caps
  // at 5,000 records per module, so 10000 comfortably scans every
  // synced Deal; the 50000 ceiling leaves headroom for a future Zoho
  // page-size bump without another deploy. Without this, the "CS Deals
  // Scanned" KPI was silently capped at the 2000 most-recently-modified
  // Deals — orgs with >2k Deals never saw every CS deal evaluated.
  const limit = Math.max(1, Math.min(opts.limit ?? 10000, 50000));

  // Segment scope. CS Lifecycle is the B2B CS team's domain, so it DEFAULTS to
  // the WalaPlus (corporate) layout — a bare "all"/unset segment resolves to
  // WalaPlus, NOT every layout, because WalaOne / Marketplace are not part of
  // the CS-B2B book (Sarah 2026-07-07). An explicit Marketplace/WalaOne chip
  // still overrides for ad-hoc inspection. Same layout_name predicate the radar
  // tabs use. Segment bind params come first ($1..$N); LIMIT is the last one.
  const csSegment: DuplicateFilters["segment"] =
    !opts.segment || opts.segment === "all" ? "walaplus" : opts.segment;
  const params: any[] = [];
  const seg = buildSegmentPredicate(csSegment, 1);
  let segmentCond = "";
  if (seg.condition) {
    segmentCond = " AND " + seg.condition;
    params.push(...seg.params);
  }
  params.push(limit);
  const limitPh = "$" + params.length;

  const dealRows = await pool.query(
    `SELECT r.id, r.cluster_id, r.zoho_record_id, r.account_name,
            r.domain, r.modified_date, r.raw_data, r.gov_type
       FROM duplicate_records r
       LEFT JOIN duplicate_clusters dc ON dc.id = r.cluster_id
      WHERE r.zoho_module = 'Deals'
        AND r.cleanup_class IS NULL
        AND (dc.status IS NULL OR dc.status = 'active')${segmentCond}
      ORDER BY r.modified_date DESC NULLS LAST
      LIMIT ${limitPh}`,
    params,
  );

  const evaluations: CsLifecycleEvaluation[] = [];
  const violations: CsLifecycleViolationRow[] = [];

  for (const row of dealRows.rows) {
    const ev = evaluateCsLifecycle({
      raw_data: row.raw_data,
      modified_date: row.modified_date,
      domain: row.domain,
      gov_type: row.gov_type,
    });
    evaluations.push(ev);
    if (!ev.is_cs_deal) continue;

    // Pull the Customer Success section detail fields for display alongside
    // each violation (CS owner, customer-since, renewal/churn dates, health).
    // Same extractor evaluateCsLifecycle uses, so values stay consistent.
    const detail = extractCsFieldsFromRawData(row.raw_data, {
      domain: row.domain,
    });
    const fmtDate = (d: string | Date | null | undefined): string | null => {
      if (!d) return null;
      const s = typeof d === "string" ? d : d.toISOString();
      return s.slice(0, 10);
    };

    for (const v of ev.violations) {
      if (opts.severity && v.severity !== opts.severity) continue;
      if (opts.code && v.code !== opts.code) continue;
      // 2026-05-30 — operator request: the "Account" column on the CS
      // Lifecycle tab must be sourced from the Customer Success section's
      // Company custom field (the field the CS team curates) rather
      // than the Deal's standard Account_Name lookup that duplicate_records
      // .account_name was populated from at sync time. The two fields
      // are normally aligned, but if a CS team renames a customer in the
      // CS section without touching the top-level Account_Name lookup
      // the dashboard otherwise drifts from the CRM's CS view. Fall back
      // to the legacy Account_Name when the CS Company field is empty so
      // legacy data still shows something useful.
      const csAccountName =
        (detail.cs_company && detail.cs_company.trim()) ||
        row.account_name ||
        null;

      // 2026-06-08 — pull Layout / Stage / Pipeline straight off the
      // Zoho raw_data so the dashboard's Advanced Filters can match
      // against them. Layout in Zoho is an object { id, name }; Stage
      // and Pipeline are plain strings. Defensive .toString() in case
      // a tenant has the field with an unexpected shape.
      const rawDeal: any = (row.raw_data as any) ?? {};
      const _readObjOrStr = (v: any): string | null => {
        if (v == null) return null;
        if (typeof v === "string") return v.trim() || null;
        if (typeof v === "object" && typeof v.name === "string") {
          return v.name.trim() || null;
        }
        return null;
      };
      const dealLayout = _readObjOrStr(rawDeal.Layout);
      const dealStage = _readObjOrStr(rawDeal.Stage);
      const dealPipeline = _readObjOrStr(rawDeal.Pipeline);

      violations.push({
        record_id: row.id,
        cluster_id: row.cluster_id ?? null,
        zoho_record_id: row.zoho_record_id ?? null,
        account_name: csAccountName,
        domain: row.domain ?? null,
        current_phase: ev.current_phase,
        days_since_modified: ev.days_since_modified,
        cs_owner_name: detail.cs_owner_name ?? null,
        customer_since: fmtDate(detail.customer_since),
        renewal_date: fmtDate(detail.renewal_date),
        churn_date: fmtDate(detail.churn_date),
        health: detail.health ?? null,
        ext_id: detail.ext_id ?? null,
        layout: dealLayout,
        stage: dealStage,
        pipeline: dealPipeline,
        violation: v,
      });
    }
  }

  // Severity ordering: critical → warning → info
  const sevOrder: Record<CsViolationSeverity, number> = {
    critical: 0,
    warning: 1,
    info: 2,
  };
  violations.sort((a, b) => {
    const s =
      sevOrder[a.violation.severity] - sevOrder[b.violation.severity];
    if (s !== 0) return s;
    return (b.days_since_modified ?? 0) - (a.days_since_modified ?? 0);
  });

  return {
    summary: summarizeViolations(evaluations),
    violations,
    duration_ms: Date.now() - t0,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Deal Stage Aging — scans the Deal corpus for stage-aging SOP violations.
// Mirrors scanCsLifecycleViolations but applies the Sales SOP per-stage SLA
// spec from salesStageSlaSpec.ts. Used by:
//   - GET /api/duplicates/deal-stage-aging
//   - dealStageAgingStatusTool (Adam)
//   - twice-daily digest (buildRadarTabStatus)
// ────────────────────────────────────────────────────────────────────────────

export interface DealStageAgingViolationRow {
  record_id: number;
  cluster_id: number | null;
  zoho_record_id: string | null;
  deal_name: string | null;
  account_name: string | null;
  owner_name: string | null;
  owner_email: string | null;
  layout: string | null;
  pipeline: string | null;
  stage: string;
  amount: number | null;
  created_time: string | null;
  modified_date: string | null;
  violation: import("./dealStageAgingCompliance").DealStageAgingViolation;
}

export interface DealStageAgingScanResult {
  summary: import("./dealStageAgingCompliance").DealStageAgingSummary;
  violations: DealStageAgingViolationRow[];
  duration_ms: number;
}

export async function scanDealStageAgingViolations(
  opts: {
    severity?: "info" | "warning" | "critical";
    stage?: string;
    limit?: number;
    segment?: DuplicateFilters["segment"];
  } = {},
): Promise<DealStageAgingScanResult> {
  const t0 = Date.now();
  const limit = Math.max(1, Math.min(opts.limit ?? 10000, 50000));

  const { evaluateDealStageAging, summarizeDealStageAging } = await import(
    "./dealStageAgingCompliance"
  );

  // Segment chip (WalaPlus / WalaOne / Marketplace) — filter deals by their Zoho
  // Layout, using the SAME predicate the radar tabs use so "WalaPlus" shows only
  // WalaPlus-layout deals, etc. (Sarah 2026-07-07). Segment bind params come
  // first ($1..$N); the LIMIT is always the last placeholder.
  const params: any[] = [];
  const seg = buildSegmentPredicate(opts.segment, 1);
  let segmentCond = "";
  if (seg.condition) {
    segmentCond = " AND " + seg.condition;
    params.push(...seg.params);
  }
  params.push(limit);
  const limitPh = "$" + params.length;

  const dealRows = await pool.query(
    `SELECT r.id, r.cluster_id, r.zoho_record_id, r.account_name,
            r.modified_date, r.raw_data
       FROM duplicate_records r
       LEFT JOIN duplicate_clusters dc ON dc.id = r.cluster_id
      WHERE r.zoho_module = 'Deals'
        AND r.cleanup_class IS NULL
        AND (dc.status IS NULL OR dc.status = 'active')${segmentCond}
      ORDER BY r.modified_date DESC NULLS LAST
      LIMIT ${limitPh}`,
    params,
  );

  const evaluations: ReturnType<typeof evaluateDealStageAging>[] = [];
  const violations: DealStageAgingViolationRow[] = [];

  const fmtDate = (d: string | Date | null | undefined): string | null => {
    if (!d) return null;
    const s = typeof d === "string" ? d : d.toISOString();
    return s.slice(0, 10);
  };
  const readObjOrStr = (v: any): string | null => {
    if (v == null) return null;
    if (typeof v === "string") return v.trim() || null;
    if (typeof v === "object" && typeof v.name === "string") {
      return v.name.trim() || null;
    }
    return null;
  };

  for (const row of dealRows.rows) {
    const raw: any = (row.raw_data as any) ?? {};
    const stage = readObjOrStr(raw.Stage);
    const ev = evaluateDealStageAging({
      stage,
      modified_date: row.modified_date,
      created_time: raw.Created_Time ?? null,
    });
    evaluations.push(ev);
    if (!ev.violation) continue;
    if (opts.severity && ev.violation.severity !== opts.severity) continue;
    if (
      opts.stage &&
      ev.violation.stage.toLowerCase() !== opts.stage.toLowerCase()
    )
      continue;

    const owner = raw.Owner ?? null;
    const ownerName =
      (owner && typeof owner === "object" && typeof owner.name === "string"
        ? owner.name.trim() || null
        : null) ?? null;
    const ownerEmail =
      (owner && typeof owner === "object" && typeof owner.email === "string"
        ? owner.email.trim().toLowerCase() || null
        : null) ?? null;

    const amountRaw = raw.Amount;
    const amount =
      typeof amountRaw === "number"
        ? amountRaw
        : typeof amountRaw === "string" && amountRaw.trim() !== ""
          ? Number.parseFloat(amountRaw)
          : null;

    violations.push({
      record_id: row.id,
      cluster_id: row.cluster_id ?? null,
      zoho_record_id: row.zoho_record_id ?? null,
      deal_name: readObjOrStr(raw.Deal_Name),
      account_name: row.account_name ?? readObjOrStr(raw.Account_Name) ?? null,
      owner_name: ownerName,
      owner_email: ownerEmail,
      layout: readObjOrStr(raw.Layout),
      pipeline: readObjOrStr(raw.Pipeline),
      stage: ev.violation.stage,
      amount: Number.isFinite(amount as number) ? (amount as number) : null,
      created_time: fmtDate(raw.Created_Time ?? null),
      modified_date: fmtDate(row.modified_date),
      violation: ev.violation,
    });
  }

  const sevOrder: Record<"info" | "warning" | "critical", number> = {
    critical: 0,
    warning: 1,
    info: 2,
  };
  violations.sort((a, b) => {
    const s =
      sevOrder[a.violation.severity] - sevOrder[b.violation.severity];
    if (s !== 0) return s;
    return (b.violation.aging_calendar_days ?? 0) - (a.violation.aging_calendar_days ?? 0);
  });

  return {
    summary: summarizeDealStageAging(evaluations),
    violations,
    duration_ms: Date.now() - t0,
  };
}

export { pool };
