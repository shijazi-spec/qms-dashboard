import pg from "pg";
import { logger } from "./logger";
import {
  analyzeRecordHygiene,
  DEFAULT_GOVERNANCE_RULES,
  fetchAllCRMProviderRecords,
  type CRMProviderCRMRecord,
} from "./CRMProviderCRM";
import { getGovernanceDocumentByModule } from "./database";
import {
  getWeeklyFeedbackDigest,
  summarizeFeedbackTrend,
  type FeedbackTrendSummary,
} from "./aiFeedbackDatabase";
import {
  computeSopGapSummary,
  type SopGapSummary,
} from "./sopGapDetection";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const KSA_OFFSET_MS = 3 * 60 * 60 * 1000;
const KSA_WEEKDAY_THURSDAY = 4;
const DIGEST_DASHBOARD_LINK = process.env.DIGEST_DASHBOARD_URL || "/executive";

export type DigestCadence = "weekly" | "monthly" | "quarterly";
export type DigestChannel = "email" | "ChatProvider";
export type DigestSendTarget = "email" | "ChatProvider" | "both";

export interface DigestWindow {
  cadence: DigestCadence;
  start: Date;
  end: Date;
  periodLabel: string;
}

export interface DigestSectionRule {
  id: string;
  title: string;
  module: "Leads" | "Deals" | "Both";
  includeKeywords?: string[];
  excludeKeywords?: string[];
}

export interface DigestBusinessSection {
  id: string;
  title: string;
  total: number;
  leads: number;
  deals: number;
  new_in_window: number;
  progressed: number;
  stalled: number;
  health_score: number;
  severity_counts: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    total: number;
  };
}

export interface DigestSeveritySummary {
  critical: number;
  high: number;
  medium: number;
  low: number;
  total: number;
}

export interface DigestData {
  generated_at: string;
  cadence: DigestCadence;
  period: string;
  window_start: string;
  window_end: string;
  nc_summary: {
    open: number;
    opened_this_week: number;
    closed_this_week: number;
    overdue: number;
  };
  capa_summary: {
    open: number;
    opened_this_week: number;
    closed_this_week: number;
    effectiveness_rate: number;
  };
  risk_summary: {
    total_active: number;
    critical_high: number;
    new_this_week: number;
    overdue_treatments: number;
  };
  audit_summary: {
    last_score: number | null;
    last_date: string | null;
    trend:
      | "improving"
      | "declining"
      | "stable"
      | "rules_changed"
      | "scope_changed";
    /** Plain-English context for the trend, surfaced in the ChatProvider digest
     *  so leadership never sees "Trend improving" when the rules under
     *  it actually moved. Null when trend was a clean IdentityProviders-to-IdentityProviders
     *  comparison. */
    trend_caveat?: string | null;
  };
  kpi_summary: { green: number; amber: number; red: number; total: number };
  compliance_summary: { met: number; partial: number; not_met: number; total: number };
  /**
   * Composite enterprise health score 0-100, derived from real GRC signals.
   * Components (weights): audit score 30%, CAPA closure 20%, risk hygiene 25%,
   * KPI green rate 15%, NC closure rate 10%. See `computeHealthScore()`.
   */
  health_score: number;
  top_alerts: Array<{ title: string; severity: string; module: string }>;
  capa_recurrences: number;
  duplicate_clusters: number;
  business_overview: {
    total_records: number;
    total_leads: number;
    total_deals: number;
    total_issues: number;
    severity_counts: DigestSeveritySummary;
  };
  finding_types: Array<{
    module: string;
    issue_type: string;
    severity: string;
    count: number;
  }>;
  business_sections: DigestBusinessSection[];
  ai_feedback_summary: {
    period: string;
    total: number;
    thumbs_up: number;
    thumbs_down: number;
    thumbs_up_pct: number;
    trend: FeedbackTrendSummary;
  };
  /**
   * SOP-driven gap detection (Phase 2). Counts how many requirements
   * derived from uploaded SOPs have no matching audit/CAPA/risk record,
   * so Operating Officers see compliance gaps even when operational
   * tables are sparse.
   */
  sop_gap_summary: SopGapSummary;
}

export interface DigestBuildOptions {
  cadence?: DigestCadence;
  now?: Date;
  window?: DigestWindow;
  sectionRules?: DigestSectionRule[];
}

export interface DigestSendOptions {
  cadence?: DigestCadence;
  now?: Date;
  window?: DigestWindow;
  channelOverride?: string;
  preview?: boolean;
  enforceIdempotency?: boolean;
}

export interface DigestSendResult {
  success: boolean;
  method?: string;
  error?: string;
  skipped?: boolean;
  runKey?: string;
  cadence?: DigestCadence;
  windowStart?: string;
  windowEnd?: string;
  preview?: boolean;
  blocks?: any[];
}

export interface DigestFanoutResult {
  cadence: DigestCadence;
  window: DigestWindow;
  email: DigestSendResult;
  ChatProvider: DigestSendResult;
}

export interface DigestRunRecord {
  run_key: string;
  cadence: string;
  channel: string;
  window_start: string;
  window_end: string;
  status: string;
  error: string | null;
  created_at: string;
}

export interface DigestDeliveryHealth {
  cadence: DigestCadence;
  window_start: string;
  window_end: string;
  run_key_ChatProvider: string;
  run_key_email: string;
  ChatProvider_enabled: boolean;
  direct_audit_ChatProvider_enabled: boolean;
  has_ChatProvider_credentials: boolean;
  ChatProvider_channel_resolved: string | null;
  has_digest_email_recipient: boolean;
  idempotent_run_exists_ChatProvider: boolean;
  idempotent_run_exists_email: boolean;
}

function toKsaShifted(date: Date): Date {
  return new Date(date.getTime() + KSA_OFFSET_MS);
}

function fromKsaParts(
  year: number,
  monthIndex: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
): Date {
  return new Date(
    Date.UTC(year, monthIndex, day, hour, minute, second, ms) - KSA_OFFSET_MS,
  );
}

function getKsaParts(date: Date): {
  year: number;
  monthIndex: number;
  day: number;
  weekday: number;
} {
  const shifted = toKsaShifted(date);
  return {
    year: shifted.getUTCFullYear(),
    monthIndex: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
  };
}

function toIsoDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function dateLabelKsa(d: Date): string {
  return d.toLocaleDateString("en-GB", { timeZone: "Asia/Riyadh" });
}

function envBool(name: string, defaultValue = false): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return defaultValue;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

function normalize(value: string | undefined | null): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isProgressed(statusText: string): boolean {
  const s = normalize(statusText);
  if (!s) return false;
  return [
    "qualified",
    "proposal",
    "agreement signed",
    "closed won",
    "converted",
    "won",
    "contract",
    "onboarding",
    "negotiation",
  ].some((token) => s.includes(token));
}

function isStalled(statusText: string): boolean {
  const s = normalize(statusText);
  if (!s) return false;
  return [
    "on hold",
    "stalled",
    "closed lost",
    "lost",
    "not interested",
    "junk",
    "unqualified",
    "dead",
    "inactive",
  ].some((token) => s.includes(token));
}

function getRecordTimestamp(record: CRMProviderCRMRecord): Date | null {
  const raw =
    record.createdTime ||
    record.data?.Created_Time ||
    record.data?.created_time ||
    record.data?.CreatedTime;
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function recordSignalText(record: CRMProviderCRMRecord): string {
  const parts = [
    record.module,
    record.data?.Layout?.name || record.data?.Layout,
    record.data?.Pipeline?.name || record.data?.Pipeline,
    record.data?.Lead_Source?.name || record.data?.Lead_Source,
    record.data?.Lead_Status?.name || record.data?.Lead_Status,
    record.data?.Stage?.name || record.data?.Stage,
    record.data?.Deal_Name,
    record.data?.Company,
    record.data?.Account_Type?.name || record.data?.Account_Type,
    record.data?.Customer_Type?.name || record.data?.Customer_Type,
    record.data?.Type?.name || record.data?.Type,
  ];
  return normalize(parts.filter(Boolean).join(" "));
}

function recordProgressSignal(record: CRMProviderCRMRecord): string {
  const status = [
    record.data?.Stage?.name || record.data?.Stage,
    record.data?.Lead_Status?.name || record.data?.Lead_Status,
    record.data?.Status?.name || record.data?.Status,
  ]
    .filter(Boolean)
    .join(" ");
  return status;
}

export function resolveDigestSectionRules(): DigestSectionRule[] {
  const defaults: DigestSectionRule[] = [
    {
      id: "sdr_leads_only",
      title: "SDR Leads only",
      module: "Leads",
      excludeKeywords: ["marketplace", "market place", "mp"],
    },
    {
      id: "deals_corporates_only",
      title: "Deals ExampleOrg only",
      module: "Deals",
      includeKeywords: ["ExampleOrg layout", "ExampleOrg", "ExampleOrg"],
      excludeKeywords: ["marketplace", "market place", "mp"],
    },
    {
      id: "marketplace_all",
      title: "MarketPlace Leads & Deals",
      module: "Both",
      includeKeywords: ["marketplace", "market place", "mp"],
    },
  ];

  const raw = process.env.DIGEST_SECTION_RULES_JSON;
  if (!raw) return defaults;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaults;
    const mapped = parsed
      .map((r: any) => ({
        id: String(r.id || "").trim(),
        title: String(r.title || "").trim(),
        module: r.module === "Leads" || r.module === "Deals" || r.module === "Both" ? r.module : "Both",
        includeKeywords: Array.isArray(r.includeKeywords)
          ? r.includeKeywords.map((x: any) => String(x)).filter(Boolean)
          : [],
        excludeKeywords: Array.isArray(r.excludeKeywords)
          ? r.excludeKeywords.map((x: any) => String(x)).filter(Boolean)
          : [],
      }))
      .filter((r) => r.id && r.title);
    return mapped.length > 0 ? mapped : defaults;
  } catch (err) {
    logger.warn("[Digest] Invalid DIGEST_SECTION_RULES_JSON, using defaults");
    return defaults;
  }
}

function matchesRule(record: CRMProviderCRMRecord, rule: DigestSectionRule): boolean {
  if (rule.module !== "Both" && record.module !== rule.module) return false;
  const signal = recordSignalText(record);
  if (rule.excludeKeywords && rule.excludeKeywords.length > 0) {
    const hasExcludedKeyword = rule.excludeKeywords.some((k) =>
      signal.includes(normalize(k)),
    );
    if (hasExcludedKeyword) return false;
  }
  if (!rule.includeKeywords || rule.includeKeywords.length === 0) return true;
  return rule.includeKeywords.some((k) => signal.includes(normalize(k)));
}

function buildBusinessSections(
  records: CRMProviderCRMRecord[],
  rules: DigestSectionRule[],
  governanceRulesByModule: Record<string, any[]>,
): DigestBusinessSection[] {
  const recordSeverityMap = new Map<
    string,
    { critical: number; high: number; medium: number; low: number; total: number }
  >();
  for (const record of records) {
    const governanceRules =
      governanceRulesByModule[record.module] || DEFAULT_GOVERNANCE_RULES;
    const issues = analyzeRecordHygiene(record, governanceRules);
    const sev = { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
    for (const issue of issues) {
      sev.total++;
      if (issue.severity === "critical") sev.critical++;
      else if (issue.severity === "high") sev.high++;
      else if (issue.severity === "medium") sev.medium++;
      else sev.low++;
    }
    recordSeverityMap.set(record.id, sev);
  }

  const claimedRecordIds = new Set<string>();
  return rules.map((rule) => {
    const items = records.filter((r) => {
      if (claimedRecordIds.has(r.id)) return false;
      const matched = matchesRule(r, rule);
      if (matched) claimedRecordIds.add(r.id);
      return matched;
    });
    const leads = items.filter((r) => r.module === "Leads").length;
    const deals = items.filter((r) => r.module === "Deals").length;
    const progressed = items.filter((r) => isProgressed(recordProgressSignal(r))).length;
    const stalled = items.filter((r) => isStalled(recordProgressSignal(r))).length;
    const severity = { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
    for (const item of items) {
      const itemSev = recordSeverityMap.get(item.id);
      if (!itemSev) continue;
      severity.critical += itemSev.critical;
      severity.high += itemSev.high;
      severity.medium += itemSev.medium;
      severity.low += itemSev.low;
      severity.total += itemSev.total;
    }

    const itemHealth = severity.total > 0 ? Math.max(0, 100 - Math.round((severity.critical * 8 + severity.high * 4 + severity.medium * 2 + severity.low) / Math.max(items.length, 1))) : 100;

    return {
      id: rule.id,
      title: rule.title,
      total: items.length,
      leads,
      deals,
      new_in_window: items.length,
      progressed,
      stalled,
      severity_counts: severity,
      health_score: itemHealth,
    };
  });
}

async function resolveDigestGovernanceRulesByModule(): Promise<
  Record<string, any[]>
> {
  const modules = ["Leads", "Deals"] as const;
  const byModule: Record<string, any[]> = {
    Leads: DEFAULT_GOVERNANCE_RULES,
    Deals: DEFAULT_GOVERNANCE_RULES,
  };
  for (const moduleName of modules) {
    try {
      const moduleDoc = await getGovernanceDocumentByModule(moduleName);
      const rawRules = moduleDoc?.rules_json;
      if (!rawRules) continue;
      const parsed =
        typeof rawRules === "string" ? JSON.parse(rawRules) : rawRules;
      if (Array.isArray(parsed) && parsed.length > 0) {
        byModule[moduleName] = parsed;
        continue;
      }
      if (parsed?.rules && Array.isArray(parsed.rules) && parsed.rules.length > 0) {
        byModule[moduleName] = parsed.rules;
      }
    } catch (err) {
      logger.warn("[Digest] Failed to load governance rules; using defaults", {
        moduleName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return byModule;
}

function summarizeFindingTypes(
  records: CRMProviderCRMRecord[],
  governanceRulesByModule: Record<string, any[]>,
): Array<{ module: string; issue_type: string; severity: string; count: number }> {
  const counts = new Map<string, { module: string; issue_type: string; severity: string; count: number }>();
  for (const record of records) {
    const governanceRules =
      governanceRulesByModule[record.module] || DEFAULT_GOVERNANCE_RULES;
    const issues = analyzeRecordHygiene(record, governanceRules);
    for (const issue of issues) {
      const key = `${issue.module}::${issue.issueType}`;
      const existing = counts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(key, {
          module: issue.module,
          issue_type: issue.issueType,
          severity: issue.severity,
          count: 1,
        });
      }
    }
  }
  return Array.from(counts.values()).sort((a, b) => b.count - a.count);
}

export function computeDigestWindow(
  cadence: DigestCadence = "weekly",
  now = new Date(),
): DigestWindow {
  const ksa = getKsaParts(now);

  if (cadence === "weekly") {
    let diffToThursday = KSA_WEEKDAY_THURSDAY - ksa.weekday;
    if (diffToThursday > 0) diffToThursday -= 7; // keep completed week

    const anchorThursdayDate = ksa.day + diffToThursday;
    const anchorThursdayStart = fromKsaParts(ksa.year, ksa.monthIndex, anchorThursdayDate);
    const anchorParts = getKsaParts(anchorThursdayStart);
    // windowStart is the Friday 6 KSA-days before the Thursday anchor.
    // We anchor at UTC 00:00 on that KSA calendar date (rather than
    // KSA-midnight, which falls on the previous UTC date) so that
    // start.toISOString().slice(0,10) renders the correct Friday and
    // matches the convention used by downstream consumers
    // (window_start in ChatProvider blocks etc).
    const fridayUtc = new Date(
      Date.UTC(anchorParts.year, anchorParts.monthIndex, anchorParts.day - 6, 0, 0, 0, 0),
    );
    const windowStart = fridayUtc;
    const windowEnd = fromKsaParts(
      anchorParts.year,
      anchorParts.monthIndex,
      anchorParts.day,
      23,
      59,
      59,
      999,
    );
    return {
      cadence,
      start: windowStart,
      end: windowEnd,
      periodLabel: `${dateLabelKsa(windowStart)} - ${dateLabelKsa(windowEnd)}`,
    };
  }

  if (cadence === "monthly") {
    const previousMonthIndex = ksa.monthIndex - 1;
    const start = fromKsaParts(ksa.year, previousMonthIndex, 1, 0, 0, 0, 0);
    const startParts = getKsaParts(start);
    const end = fromKsaParts(
      startParts.year,
      startParts.monthIndex + 1,
      0,
      23,
      59,
      59,
      999,
    );
    return {
      cadence,
      start,
      end,
      periodLabel: `${dateLabelKsa(start)} - ${dateLabelKsa(end)}`,
    };
  }

  // quarterly: previous full quarter
  const quarterIndex = Math.floor(ksa.monthIndex / 3);
  const previousQuarterStartMonth = quarterIndex * 3 - 3;
  const start = fromKsaParts(ksa.year, previousQuarterStartMonth, 1, 0, 0, 0, 0);
  const startParts = getKsaParts(start);
  const end = fromKsaParts(
    startParts.year,
    startParts.monthIndex + 3,
    0,
    23,
    59,
    59,
    999,
  );
  return {
    cadence,
    start,
    end,
    periodLabel: `${dateLabelKsa(start)} - ${dateLabelKsa(end)}`,
  };
}

export function isFirstThursdayInKsa(
  now: Date,
  cadence: "monthly" | "quarterly",
): boolean {
  const ksa = getKsaParts(now);
  const isThursday = ksa.weekday === KSA_WEEKDAY_THURSDAY;
  const isFirstWeek = ksa.day >= 1 && ksa.day <= 7;
  if (!isThursday || !isFirstWeek) return false;
  if (cadence === "monthly") return true;
  const monthOneBased = ksa.monthIndex + 1;
  return monthOneBased === 1 || monthOneBased === 4 || monthOneBased === 7 || monthOneBased === 10;
}

export function buildDigestRunKey(
  cadence: DigestCadence,
  window: DigestWindow,
  channel: DigestChannel,
): string {
  return `${cadence}:${toIsoDateOnly(window.start)}:${toIsoDateOnly(window.end)}:${channel}`;
}

export async function safeQuery(sql: string, params: any[] = []): Promise<any[]> {
  try {
    const result = await pool.query(sql, params);
    return result.rows;
  } catch (err) {
    logger.warn("[Digest] Query failed (safe fallback to empty)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

async function initDigestRunsTable(): Promise<void> {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS digest_delivery_runs (
        id SERIAL PRIMARY KEY,
        run_key VARCHAR(255) UNIQUE NOT NULL,
        cadence VARCHAR(20) NOT NULL,
        channel VARCHAR(20) NOT NULL,
        window_start TIMESTAMP NOT NULL,
        window_end TIMESTAMP NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'success',
        error TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
  } catch (err) {
    logger.warn("[Digest] digest_delivery_runs table init failed; idempotency persistence disabled", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function hasSuccessfulDigestRun(runKey: string): Promise<boolean> {
  try {
    await initDigestRunsTable();
    const rows = await safeQuery(
      `SELECT 1 FROM digest_delivery_runs WHERE run_key = $1 AND status = 'success' LIMIT 1`,
      [runKey],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function recordDigestRun(params: {
  runKey: string;
  cadence: DigestCadence;
  channel: DigestChannel;
  window: DigestWindow;
  status: "success" | "failed" | "queued";
  error?: string;
}): Promise<void> {
  try {
    await initDigestRunsTable();
    await pool.query(
      `INSERT INTO digest_delivery_runs (run_key, cadence, channel, window_start, window_end, status, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (run_key) DO UPDATE SET status = EXCLUDED.status, error = EXCLUDED.error, created_at = NOW()`,
      [
        params.runKey,
        params.cadence,
        params.channel,
        params.window.start.toISOString(),
        params.window.end.toISOString(),
        params.status,
        params.error || null,
      ],
    );
  } catch (err) {
    logger.warn("[Digest] Failed to persist digest run record", {
      runKey: params.runKey,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function fetchWindowedBusinessRecords(window: DigestWindow): Promise<CRMProviderCRMRecord[]> {
  const hasCRMProviderCreds = !!(
    process.env.CRMProvider_ACCESS_TOKEN ||
    (process.env.CRMProvider_CLIENT_ID && process.env.CRMProvider_CLIENT_SECRET && process.env.CRMProvider_REFRESH_TOKEN) ||
    (process.env.CRMProvider_CLIENT_ID_NEW && process.env.CRMProvider_CLIENT_SECRET && process.env.CRMProvider_REFRESH_TOKEN)
  );
  if (!hasCRMProviderCreds) {
    logger.info("[Digest] CRMProvider credentials missing; business sections will be empty");
    return [];
  }

  const maxRecords = Number(process.env.DIGEST_MAX_RECORDS_PER_MODULE || "5000");
  const [leads, deals] = await Promise.all([
    fetchAllCRMProviderRecords("Leads", { maxRecords }),
    fetchAllCRMProviderRecords("Deals", { maxRecords }),
  ]);
  const all = [...leads, ...deals];
  const startMs = window.start.getTime();
  const endMs = window.end.getTime();
  return all.filter((rec) => {
    const ts = getRecordTimestamp(rec);
    if (!ts) return false;
    const t = ts.getTime();
    return t >= startMs && t <= endMs;
  });
}

export async function generateDigestData(
  options: DigestBuildOptions = {},
): Promise<DigestData> {
  const cadence = options.cadence || "weekly";
  const now = options.now || new Date();
  const window = options.window || computeDigestWindow(cadence, now);
  const weekAgoStr = window.start.toISOString();

  // Schema mapping (May 2026 audit):
  //   NC      -> audit_findings (canonical NC source; nonconformance_records is unused)
  //   CAPA    -> capas + capa_action_items (capa_records is unused)
  //   Risk    -> enterprise_risks (risk_register does not exist)
  //   KPI     -> kpi_values JOIN kpi_definitions (kpi_entries does not exist)
  //   Compl.  -> compliance_assessments (compliance_obligations does not exist)
  //   Audit   -> quality_audit_results (quality_audits does not exist)
  // Each safeQuery falls back to [] if a table is missing in a future env,
  // so the digest degrades gracefully rather than 500-ing.
  const [
    ncOpen,
    ncNewWeek,
    ncClosedWeek,
    ncOverdue,
    ncTotal,
    capaOpen,
    capaTotal,
    capaNewWeek,
    capaClosedWeek,
    capaEffective,
    riskActive,
    riskCritHigh,
    riskTotal,
    riskNew,
    riskOverdueTreatments,
    auditRows,
    kpiRows,
    compRows,
    alertRows,
    recurrenceRows,
    duplicateClusters,
    businessRecords,
  ] = await Promise.all([
    safeQuery(
      `SELECT COUNT(*) as cnt FROM audit_findings WHERE LOWER(COALESCE(status,'open')) NOT IN ('closed', 'resolved', 'rejected')`,
    ),
    safeQuery(
      `SELECT COUNT(*) as cnt FROM audit_findings WHERE created_at >= $1`,
      [weekAgoStr],
    ),
    safeQuery(
      `SELECT COUNT(*) as cnt FROM audit_findings WHERE resolution_date >= $1`,
      [weekAgoStr],
    ),
    safeQuery(
      `SELECT COUNT(*) as cnt FROM audit_findings WHERE LOWER(COALESCE(status,'open')) NOT IN ('closed', 'resolved', 'rejected') AND target_date IS NOT NULL AND target_date < CURRENT_DATE`,
    ),
    safeQuery(
      `SELECT COUNT(*) as cnt FROM audit_findings`,
    ),
    safeQuery(
      `SELECT COUNT(*) as cnt FROM capas WHERE LOWER(COALESCE(status,'open')) NOT IN ('closed', 'cancelled', 'completed')`,
    ),
    safeQuery(`SELECT COUNT(*) as cnt FROM capas`),
    safeQuery(`SELECT COUNT(*) as cnt FROM capas WHERE created_at >= $1`, [weekAgoStr]),
    safeQuery(
      `SELECT COUNT(*) as cnt FROM capa_action_items WHERE completion_date >= $1`,
      [weekAgoStr],
    ),
    // Effectiveness proxy: action-items completed vs total across all CAPAs
    // (capas table has no effectiveness_result column).
    safeQuery(
      `SELECT COUNT(*) FILTER (WHERE LOWER(COALESCE(status,'open')) = 'completed') as eff, COUNT(*) as total FROM capa_action_items`,
    ),
    safeQuery(`SELECT COUNT(*) as cnt FROM enterprise_risks WHERE LOWER(COALESCE(status,'open')) NOT IN ('closed', 'accepted')`),
    safeQuery(
      `SELECT COUNT(*) as cnt FROM enterprise_risks WHERE COALESCE(risk_score,0) >= 15 AND LOWER(COALESCE(status,'open')) NOT IN ('closed', 'accepted')`,
    ),
    safeQuery(`SELECT COUNT(*) as cnt FROM enterprise_risks`),
    safeQuery(`SELECT COUNT(*) as cnt FROM enterprise_risks WHERE created_at >= $1`, [weekAgoStr]),
    safeQuery(
      `SELECT COUNT(*) as cnt FROM enterprise_risks WHERE treatment_deadline IS NOT NULL AND treatment_deadline < NOW() AND LOWER(COALESCE(status,'open')) NOT IN ('closed', 'accepted')`,
    ),
    safeQuery(
      `SELECT overall_score, people_score, process_score, governance_score,
              total_records_audited, total_issues_found, dimension_details, audit_date,
              rules_hash
       FROM quality_audit_results
       ORDER BY audit_date DESC LIMIT 3`,
    ),
    // Latest kpi_value per kpi_id, then bucket by status.  Falls back to
    // raw status counts if the window-over-partition is unavailable.
    safeQuery(`
      WITH latest AS (
        SELECT DISTINCT ON (kpi_id) kpi_id, status
        FROM kpi_values
        ORDER BY kpi_id, period_end DESC NULLS LAST, id DESC
      )
      SELECT
        COUNT(*) FILTER (WHERE LOWER(COALESCE(status,'')) IN ('green', 'on_track')) as green,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(status,'')) IN ('amber', 'at_risk')) as amber,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(status,'')) IN ('red', 'off_track')) as red,
        COUNT(*) as total
      FROM latest
    `),
    safeQuery(`
      SELECT
        COUNT(*) FILTER (WHERE LOWER(COALESCE(compliance_status,'')) IN ('met', 'compliant')) as met,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(compliance_status,'')) IN ('partial', 'partially_compliant')) as partial,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(compliance_status,'')) IN ('not_met', 'non_compliant')) as not_met,
        COUNT(*) as total
      FROM compliance_assessments
    `),
    safeQuery(`
      SELECT title, severity, related_module as module
      FROM ai_alerts
      WHERE status = 'active' AND severity IN ('critical', 'high')
      ORDER BY created_at DESC LIMIT 5
    `),
    // Recurrence proxy: audit_findings with the same criteria_name appearing
    // more than once (capas table has no root_cause column).
    safeQuery(`
      SELECT criteria_name, COUNT(*) as cnt
      FROM audit_findings
      WHERE criteria_name IS NOT NULL AND TRIM(criteria_name) != ''
      GROUP BY criteria_name HAVING COUNT(*) > 1
    `),
    safeQuery(`SELECT COUNT(*) as cnt FROM duplicate_clusters WHERE status = 'active'`),
    fetchWindowedBusinessRecords(window),
  ]);

  let auditTrend:
    | "improving"
    | "declining"
    | "stable"
    | "rules_changed"
    | "scope_changed" = "stable";
  let auditTrendCaveat: string | null = null;
  if (auditRows.length >= 2) {
    const latest = auditRows[0] || {};
    const prior = auditRows[1] || {};
    const hashA = latest?.rules_hash ?? null;
    const hashB = prior?.rules_hash ?? null;
    const recordsA = parseInt(latest?.total_records_audited ?? "0", 10) || 0;
    const recordsB = parseInt(prior?.total_records_audited ?? "0", 10) || 0;
    const recordsBase = Math.max(1, recordsB);
    const recordsSwingPct = Math.abs((recordsA - recordsB) / recordsBase) * 100;

    // Trust the comparison only when BOTH rows used the same rule set
    // AND the audit covered roughly the same number of records (within
    // 10%). Either condition violated and the diff is meaningless: the
    // score change is from a different ruler / different scope, not
    // from quality changing. Surface this honestly instead of saying
    // "improving" / "declining" on IdentityProviders-to-oranges data.
    if (!hashA || !hashB) {
      auditTrend = "rules_changed";
      auditTrendCaveat =
        "Latest audits don't both carry a rule-set fingerprint — historical comparisons paused until we have two audits run on the same rules.";
    } else if (hashA !== hashB) {
      auditTrend = "rules_changed";
      auditTrendCaveat =
        "The governance rule set changed between the last two audits — score difference is not directly comparable.";
    } else if (recordsSwingPct > 10) {
      auditTrend = "scope_changed";
      auditTrendCaveat =
        `The audit scope changed (${recordsB.toLocaleString()} → ${recordsA.toLocaleString()} records, ${recordsSwingPct.toFixed(0)}% swing) — score difference is not directly comparable.`;
    } else {
      const diff =
        parseFloat(latest?.overall_score || "0") -
        parseFloat(prior?.overall_score || "0");
      auditTrend = diff > 2 ? "improving" : diff < -2 ? "declining" : "stable";
    }
  }

  const sectionRules = options.sectionRules || resolveDigestSectionRules();
  const governanceRulesByModule = await resolveDigestGovernanceRulesByModule();
  const findingTypes = summarizeFindingTypes(
    businessRecords,
    governanceRulesByModule,
  );
  const businessSections = buildBusinessSections(
    businessRecords,
    sectionRules,
    governanceRulesByModule,
  );
  const overallSeverity: DigestSeveritySummary = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    total: 0,
  };
  for (const section of businessSections) {
    overallSeverity.critical += section.severity_counts.critical;
    overallSeverity.high += section.severity_counts.high;
    overallSeverity.medium += section.severity_counts.medium;
    overallSeverity.low += section.severity_counts.low;
    overallSeverity.total += section.severity_counts.total;
  }
  const totalLeads = businessSections.reduce((sum, s) => sum + s.leads, 0);
  const totalDeals = businessSections.reduce((sum, s) => sum + s.deals, 0);
  const totalRecords = businessSections.reduce((sum, s) => sum + s.total, 0);

  let aiFeedbackSummary: DigestData['ai_feedback_summary'] = {
    period: `${window.start.toDateString()} – ${now.toDateString()}`,
    total: 0,
    thumbs_up: 0,
    thumbs_down: 0,
    thumbs_up_pct: 0,
    trend: {
      direction: 'insufficient_data',
      peak_negative_day: null,
      peak_negative_count: 0,
      total_thumbs_up: 0,
      total_thumbs_down: 0,
      first_half_down_rate: 0,
      second_half_down_rate: 0,
      days_observed: 0,
    },
  };
  try {
    const weekly = await getWeeklyFeedbackDigest();
    aiFeedbackSummary = {
      period: weekly.period,
      total: weekly.total,
      thumbs_up: weekly.thumbs_up,
      thumbs_down: weekly.thumbs_down,
      thumbs_up_pct: weekly.thumbs_up_pct,
      trend: summarizeFeedbackTrend(weekly.trend),
    };
  } catch {}

  let sopGapSummary: SopGapSummary;
  try {
    sopGapSummary = await computeSopGapSummary();
  } catch (err) {
    logger.warn("[Digest] SOP gap detection failed; defaulting to empty", {
      error: err instanceof Error ? err.message : String(err),
    });
    sopGapSummary = {
      documents_scanned: 0,
      requirements_total: 0,
      requirements_covered: 0,
      open_gaps: 0,
      coverage_pct: 0,
      top_gaps: [],
      coverage_breakdown: { obligation_id: 0, normalised_text: 0, ancestor: 0 },
      reason: "SOP gap detection failed",
    };
  }

  return {
    generated_at: now.toISOString(),
    cadence,
    period: window.periodLabel,
    window_start: window.start.toISOString(),
    window_end: window.end.toISOString(),
    nc_summary: {
      open: parseInt(ncOpen[0]?.cnt || "0", 10),
      opened_this_week: parseInt(ncNewWeek[0]?.cnt || "0", 10),
      closed_this_week: parseInt(ncClosedWeek[0]?.cnt || "0", 10),
      overdue: parseInt(ncOverdue[0]?.cnt || "0", 10),
    },
    capa_summary: {
      open: parseInt(capaOpen[0]?.cnt || "0", 10),
      opened_this_week: parseInt(capaNewWeek[0]?.cnt || "0", 10),
      closed_this_week: parseInt(capaClosedWeek[0]?.cnt || "0", 10),
      effectiveness_rate:
        parseInt(capaEffective[0]?.total || "0", 10) > 0
          ? Math.round(
              (parseInt(capaEffective[0]?.eff || "0", 10) /
                parseInt(capaEffective[0]?.total || "1", 10)) *
                100,
            )
          : 0,
    },
    risk_summary: {
      total_active: parseInt(riskActive[0]?.cnt || "0", 10),
      critical_high: parseInt(riskCritHigh[0]?.cnt || "0", 10),
      new_this_week: parseInt(riskNew[0]?.cnt || "0", 10),
      overdue_treatments: parseInt(riskOverdueTreatments[0]?.cnt || "0", 10),
    },
    audit_summary: {
      last_score: auditRows[0]?.overall_score ? parseFloat(auditRows[0].overall_score) : null,
      last_date: auditRows[0]?.audit_date || null,
      trend: auditTrend,
      trend_caveat: auditTrendCaveat,
    },
    kpi_summary: {
      green: parseInt(kpiRows[0]?.green || "0", 10),
      amber: parseInt(kpiRows[0]?.amber || "0", 10),
      red: parseInt(kpiRows[0]?.red || "0", 10),
      total: parseInt(kpiRows[0]?.total || "0", 10),
    },
    compliance_summary: {
      met: parseInt(compRows[0]?.met || "0", 10),
      partial: parseInt(compRows[0]?.partial || "0", 10),
      not_met: parseInt(compRows[0]?.not_met || "0", 10),
      total: parseInt(compRows[0]?.total || "0", 10),
    },
    health_score: computeEnterpriseHealthScore({
      auditScore: auditRows[0]?.overall_score ? parseFloat(auditRows[0].overall_score) : null,
      auditPeople: auditRows[0]?.people_score != null ? parseFloat(auditRows[0].people_score) : null,
      auditProcess: auditRows[0]?.process_score != null ? parseFloat(auditRows[0].process_score) : null,
      auditGovernance: auditRows[0]?.governance_score != null ? parseFloat(auditRows[0].governance_score) : null,
      auditRecords: parseInt(auditRows[0]?.total_records_audited || "0", 10),
      auditIssues: parseInt(auditRows[0]?.total_issues_found || "0", 10),
      auditModuleBreakdown: parseAuditModuleBreakdown(auditRows[0]?.dimension_details),
      ncOpen: parseInt(ncOpen[0]?.cnt || "0", 10),
      ncTotal: parseInt(ncTotal[0]?.cnt || "0", 10),
      capaOpen: parseInt(capaOpen[0]?.cnt || "0", 10),
      capaTotal: parseInt(capaTotal[0]?.cnt || "0", 10),
      capaEffectiveCompleted: parseInt(capaEffective[0]?.eff || "0", 10),
      capaEffectiveTotal: parseInt(capaEffective[0]?.total || "0", 10),
      riskActive: parseInt(riskActive[0]?.cnt || "0", 10),
      riskCritHigh: parseInt(riskCritHigh[0]?.cnt || "0", 10),
      riskTotal: parseInt(riskTotal[0]?.cnt || "0", 10),
      kpiGreen: parseInt(kpiRows[0]?.green || "0", 10),
      kpiAmber: parseInt(kpiRows[0]?.amber || "0", 10),
      kpiTotal: parseInt(kpiRows[0]?.total || "0", 10),
      complianceMet: parseInt(compRows[0]?.met || "0", 10),
      compliancePartial: parseInt(compRows[0]?.partial || "0", 10),
      complianceTotal: parseInt(compRows[0]?.total || "0", 10),
      sopRequirementsTotal: sopGapSummary.requirements_total,
      sopRequirementsCovered: sopGapSummary.requirements_covered,
    }),
    top_alerts: alertRows,
    capa_recurrences: recurrenceRows.length,
    duplicate_clusters: parseInt(duplicateClusters[0]?.cnt || "0", 10),
    business_overview: {
      total_records: totalRecords,
      total_leads: totalLeads,
      total_deals: totalDeals,
      total_issues: overallSeverity.total,
      severity_counts: overallSeverity,
    },
    finding_types: findingTypes,
    business_sections: businessSections,
    ai_feedback_summary: aiFeedbackSummary,
    sop_gap_summary: sopGapSummary,
  };
}

/**
 * Composite enterprise health score (0-100) from real GRC signals.
 *
 * Component formulas (each clamped to 0-100):
 *  - audit       (weight 25): NOT the QA scorer's flat-averaged
 *                overall_score. We re-blend the three dimensions so
 *                process problems (data quality / record errors) carry
 *                more weight than people/governance — otherwise a high
 *                people score papers over hundreds of thousands of
 *                record-level issues:
 *                    auditBlend = 0.5*process + 0.3*governance + 0.2*people
 *                Then we apply an issue-density penalty:
 *                    density   = total_issues_found / total_records_audited
 *                    penalty   = max(0, 1 - 0.15 * density)
 *                    auditValue = auditBlend * penalty
 *                so a register averaging >1 issue per record is dragged
 *                down accordingly. Falls back to overall_score if the
 *                dimension breakdown is missing on legacy rows.
 *                Omitted entirely if no audits recorded.
 *  - capa        (weight 20): average of two sub-signals when both are
 *                available, else whichever is present:
 *                  · closureRate    = 100 * (1 - capaOpen / capaTotal)
 *                  · completionRate = 100 * completed / total action items
 *                Omitted entirely if neither the capas table nor the
 *                action-items table has any rows.
 *  - risk        (weight 20): 100 * (1 - critical_high / active).
 *                Only credited when riskTotal > 0; an empty register is
 *                treated as "no signal", not "perfectly healthy".
 *  - kpi         (weight 15): (green + 0.5 * amber) / total * 100.
 *                Amber gets half credit so partial-progress KPIs move the
 *                score, instead of being lumped in with red.
 *  - nc          (weight 10): 100 * (1 - open / total). Omitted if zero.
 *  - compliance  (weight 10): (met + 0.5 * partial) / total * 100.
 *                Omitted when no controls have been assessed.
 *
 * If a component is omitted, the remaining weights are re-normalised so
 * the score still spans 0-100. Returns 0 only when no components have
 * data (fully-empty system).
 */
export interface AuditModuleBreakdown {
  module: string;
  recordsAudited: number;
  recordsWithIssues: number;
  issuesFound?: number;
}

/**
 * Pull the per-module breakdown out of `quality_audit_results.dimension_details`.
 * Tolerates already-parsed jsonb (object) and string-encoded jsonb. Returns
 * an empty array on any shape that doesn't expose the expected fields so the
 * scorer falls back to the legacy global density penalty cleanly.
 */
export function parseAuditModuleBreakdown(raw: unknown): AuditModuleBreakdown[] {
  if (raw === null || raw === undefined) return [];
  let obj: any = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  const arr = obj && Array.isArray(obj.moduleBreakdown) ? obj.moduleBreakdown : null;
  if (!arr) return [];
  return arr
    .map((m: any) => ({
      module: String(m?.module ?? "").trim() || "(unknown)",
      recordsAudited: Number(m?.recordsAudited) || 0,
      recordsWithIssues: Number(m?.recordsWithIssues) || 0,
      issuesFound: Number(m?.issuesFound) || 0,
    }))
    .filter((m: AuditModuleBreakdown) => m.recordsAudited > 0);
}

/**
 * Reblend the audit component using process-weighted dimensions and a
 * department-level contamination penalty.
 *
 * Penalty logic (preferred path):
 *   For each department with recordsAudited > 0:
 *       badRate_m = recordsWithIssues_m / recordsAudited_m
 *   penalty = 1 - mean(badRate_m)   // unweighted across departments
 *   so a small clean department isn't drowned out by a huge dirty one,
 *   and "1 issue" vs "100 issues" on the same record both count as one
 *   contaminated record.
 *
 * Fallback when no per-module breakdown is provided: the legacy global
 * issue-density penalty `max(0, 1 - 0.15 * issues/records)`.
 *
 * Returns null when no audit signal is available at all.
 */
function computeAuditComponentValue(input: {
  auditScore: number | null;
  auditPeople?: number | null;
  auditProcess?: number | null;
  auditGovernance?: number | null;
  auditRecords?: number;
  auditIssues?: number;
  auditModuleBreakdown?: AuditModuleBreakdown[];
}): number | null {
  const hasDimensions =
    input.auditPeople != null && Number.isFinite(input.auditPeople) &&
    input.auditProcess != null && Number.isFinite(input.auditProcess) &&
    input.auditGovernance != null && Number.isFinite(input.auditGovernance);
  let blend: number;
  if (hasDimensions) {
    blend =
      0.5 * (input.auditProcess as number) +
      0.3 * (input.auditGovernance as number) +
      0.2 * (input.auditPeople as number);
  } else if (input.auditScore !== null && Number.isFinite(input.auditScore)) {
    blend = input.auditScore;
  } else {
    return null;
  }
  let penalty = 1;
  const modules = (input.auditModuleBreakdown ?? []).filter(
    (m) => Number.isFinite(m.recordsAudited) && m.recordsAudited > 0,
  );
  if (modules.length > 0) {
    const avgBadRate =
      modules.reduce(
        (s, m) =>
          s + Math.min(1, Math.max(0, (m.recordsWithIssues || 0) / m.recordsAudited)),
        0,
      ) / modules.length;
    penalty = Math.max(0, 1 - avgBadRate);
  } else {
    const records = input.auditRecords ?? 0;
    const issues = input.auditIssues ?? 0;
    if (records > 0 && issues > 0) {
      const density = issues / records;
      penalty = Math.max(0, 1 - 0.15 * density);
    }
  }
  return clampPct(blend * penalty);
}

export function computeEnterpriseHealthScore(input: {
  auditScore: number | null;
  auditPeople?: number | null;
  auditProcess?: number | null;
  auditGovernance?: number | null;
  auditRecords?: number;
  auditIssues?: number;
  auditModuleBreakdown?: AuditModuleBreakdown[];
  ncOpen: number;
  ncTotal: number;
  capaOpen: number;
  capaTotal: number;
  capaEffectiveCompleted: number;
  capaEffectiveTotal: number;
  riskActive: number;
  riskCritHigh: number;
  riskTotal: number;
  kpiGreen: number;
  kpiAmber: number;
  kpiTotal: number;
  complianceMet: number;
  compliancePartial: number;
  complianceTotal: number;
  /** SOP-coverage signal: derived requirements vs satisfying records. */
  sopRequirementsTotal?: number;
  sopRequirementsCovered?: number;
}): number {
  const components: Array<{ value: number; weight: number }> = [];

  const auditValue = computeAuditComponentValue(input);
  if (auditValue !== null) {
    components.push({ value: auditValue, weight: 25 });
  }

  // CAPA: combine open-vs-total closure (from `capas`) and action-item
  // completion (from `capa_action_items`). Either signal alone counts;
  // both averaged when present so backlog of open CAPAs is never ignored.
  const capaSignals: number[] = [];
  if (input.capaTotal > 0) {
    capaSignals.push(clampPct((1 - input.capaOpen / input.capaTotal) * 100));
  }
  if (input.capaEffectiveTotal > 0) {
    capaSignals.push(
      clampPct((input.capaEffectiveCompleted / input.capaEffectiveTotal) * 100),
    );
  }
  if (capaSignals.length > 0) {
    const capaValue =
      capaSignals.reduce((s, v) => s + v, 0) / capaSignals.length;
    components.push({ value: capaValue, weight: 20 });
  }

  if (input.riskTotal > 0) {
    const riskHygiene =
      input.riskActive > 0
        ? (1 - input.riskCritHigh / input.riskActive) * 100
        : 100;
    components.push({ value: clampPct(riskHygiene), weight: 20 });
  }

  if (input.kpiTotal > 0) {
    const kpiPct =
      ((input.kpiGreen + 0.5 * input.kpiAmber) / input.kpiTotal) * 100;
    components.push({ value: clampPct(kpiPct), weight: 15 });
  }

  if (input.ncTotal > 0) {
    components.push({
      value: clampPct((1 - input.ncOpen / input.ncTotal) * 100),
      weight: 10,
    });
  }

  if (input.complianceTotal > 0) {
    const compPct =
      ((input.complianceMet + 0.5 * input.compliancePartial) /
        input.complianceTotal) *
      100;
    components.push({ value: clampPct(compPct), weight: 10 });
  }

  // SOP coverage: percent of SOP-derived requirements with at least one
  // satisfying audit/CAPA/risk record. Only credited when at least one
  // requirement was extracted; an empty SOP corpus is treated as "no
  // signal" rather than perfect coverage.
  if ((input.sopRequirementsTotal ?? 0) > 0) {
    const sopPct =
      ((input.sopRequirementsCovered ?? 0) /
        (input.sopRequirementsTotal as number)) *
      100;
    components.push({ value: clampPct(sopPct), weight: 10 });
  }

  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
  if (totalWeight === 0) return 0;
  const weighted = components.reduce((sum, c) => sum + c.value * c.weight, 0);
  return Math.round(weighted / totalWeight);
}

export interface EnterpriseHealthScoreComponent {
  name: string;
  value: number | null; // null when omitted
  weight: number;
  included: boolean;
  reason?: string; // why omitted
  raw?: Record<string, number | null | unknown[]>;
}

export interface EnterpriseHealthScoreDetail {
  score: number;
  rating: EnterpriseHealthRating;
  components: EnterpriseHealthScoreComponent[];
  totalWeight: number;
}

/**
 * Same math as `computeEnterpriseHealthScore` but returns a per-component
 * breakdown for display (cover sheets, audit, debugging). Keep the two
 * functions in lock-step; this one delegates to no shared helper because
 * we need `included`/`reason` per branch.
 */
export function computeEnterpriseHealthScoreDetail(
  input: Parameters<typeof computeEnterpriseHealthScore>[0],
): EnterpriseHealthScoreDetail {
  const components: EnterpriseHealthScoreComponent[] = [];

  const auditVal = computeAuditComponentValue(input);
  if (auditVal !== null) {
    const records = input.auditRecords ?? 0;
    const issues = input.auditIssues ?? 0;
    const density = records > 0 ? issues / records : 0;
    const modules = (input.auditModuleBreakdown ?? []).filter(
      (m) => Number.isFinite(m.recordsAudited) && m.recordsAudited > 0,
    );
    const perModuleBadRates = modules.map((m) => ({
      module: m.module,
      recordsAudited: m.recordsAudited,
      recordsWithIssues: m.recordsWithIssues || 0,
      badRatePct:
        Math.round(
          Math.min(1, Math.max(0, (m.recordsWithIssues || 0) / m.recordsAudited)) *
            1000,
        ) / 10,
    }));
    const avgBadRatePct =
      perModuleBadRates.length > 0
        ? Math.round(
            (perModuleBadRates.reduce((s, m) => s + m.badRatePct, 0) /
              perModuleBadRates.length) *
              10,
          ) / 10
        : null;
    components.push({
      name: "Audit (process-weighted, dept-contamination-penalised)",
      value: auditVal,
      weight: 25,
      included: true,
      raw: {
        people: input.auditPeople ?? null,
        process: input.auditProcess ?? null,
        governance: input.auditGovernance ?? null,
        overall: input.auditScore,
        records,
        issues,
        issuesPerRecord: Math.round(density * 100) / 100,
        avgDeptBadRatePct: avgBadRatePct,
        perModuleBadRates: perModuleBadRates.length > 0 ? perModuleBadRates : null,
      },
    });
  } else {
    components.push({
      name: "Audit (process-weighted, dept-contamination-penalised)",
      value: null,
      weight: 25,
      included: false,
      reason: "No quality_audit_results recorded",
    });
  }

  const capaSignals: number[] = [];
  if (input.capaTotal > 0) {
    capaSignals.push(clampPct((1 - input.capaOpen / input.capaTotal) * 100));
  }
  if (input.capaEffectiveTotal > 0) {
    capaSignals.push(
      clampPct((input.capaEffectiveCompleted / input.capaEffectiveTotal) * 100),
    );
  }
  if (capaSignals.length > 0) {
    components.push({
      name: "CAPA (closure + action-item completion)",
      value: capaSignals.reduce((s, v) => s + v, 0) / capaSignals.length,
      weight: 20,
      included: true,
      raw: {
        capaOpen: input.capaOpen,
        capaTotal: input.capaTotal,
        actionsCompleted: input.capaEffectiveCompleted,
        actionsTotal: input.capaEffectiveTotal,
      },
    });
  } else {
    components.push({
      name: "CAPA (closure + action-item completion)",
      value: null,
      weight: 20,
      included: false,
      reason: "No CAPAs and no action items recorded",
    });
  }

  if (input.riskTotal > 0) {
    const v =
      input.riskActive > 0
        ? (1 - input.riskCritHigh / input.riskActive) * 100
        : 100;
    components.push({
      name: "Risk (hygiene of active register)",
      value: clampPct(v),
      weight: 20,
      included: true,
      raw: {
        active: input.riskActive,
        criticalHigh: input.riskCritHigh,
        total: input.riskTotal,
      },
    });
  } else {
    components.push({
      name: "Risk (hygiene of active register)",
      value: null,
      weight: 20,
      included: false,
      reason: "Risk register is empty (no signal)",
    });
  }

  if (input.kpiTotal > 0) {
    components.push({
      name: "KPIs (green + half-credit amber)",
      value: clampPct(
        ((input.kpiGreen + 0.5 * input.kpiAmber) / input.kpiTotal) * 100,
      ),
      weight: 15,
      included: true,
      raw: {
        green: input.kpiGreen,
        amber: input.kpiAmber,
        total: input.kpiTotal,
      },
    });
  } else {
    components.push({
      name: "KPIs (green + half-credit amber)",
      value: null,
      weight: 15,
      included: false,
      reason: "No KPI values recorded",
    });
  }

  if (input.ncTotal > 0) {
    components.push({
      name: "Nonconformances (closure rate)",
      value: clampPct((1 - input.ncOpen / input.ncTotal) * 100),
      weight: 10,
      included: true,
      raw: { open: input.ncOpen, total: input.ncTotal },
    });
  } else {
    components.push({
      name: "Nonconformances (closure rate)",
      value: null,
      weight: 10,
      included: false,
      reason: "No NCs recorded",
    });
  }

  if (input.complianceTotal > 0) {
    components.push({
      name: "Compliance (met + half-credit partial)",
      value: clampPct(
        ((input.complianceMet + 0.5 * input.compliancePartial) /
          input.complianceTotal) *
          100,
      ),
      weight: 10,
      included: true,
      raw: {
        met: input.complianceMet,
        partial: input.compliancePartial,
        total: input.complianceTotal,
      },
    });
  } else {
    components.push({
      name: "Compliance (met + half-credit partial)",
      value: null,
      weight: 10,
      included: false,
      reason: "No compliance assessments recorded",
    });
  }

  const sopTotal = input.sopRequirementsTotal ?? 0;
  const sopCovered = input.sopRequirementsCovered ?? 0;
  if (sopTotal > 0) {
    components.push({
      name: "SOP coverage (requirements with satisfying records)",
      value: clampPct((sopCovered / sopTotal) * 100),
      weight: 10,
      included: true,
      raw: {
        sopRequirementsTotal: sopTotal,
        sopRequirementsCovered: sopCovered,
        sopOpenGaps: Math.max(0, sopTotal - sopCovered),
      },
    });
  } else {
    components.push({
      name: "SOP coverage (requirements with satisfying records)",
      value: null,
      weight: 10,
      included: false,
      reason: "No SOP-derived requirements available",
    });
  }

  const included = components.filter((c) => c.included);
  const totalWeight = included.reduce((s, c) => s + c.weight, 0);
  const score =
    totalWeight === 0
      ? 0
      : Math.round(
          included.reduce((s, c) => s + (c.value as number) * c.weight, 0) /
            totalWeight,
        );

  return {
    score,
    rating: ratingForEnterpriseHealth(score),
    components,
    totalWeight,
  };
}

export type EnterpriseHealthRating = "Excellent" | "Good" | "Needs Attention" | "At Risk";

export function ratingForEnterpriseHealth(score: number): EnterpriseHealthRating {
  return score >= 90 ? "Excellent" : score >= 75 ? "Good" : score >= 60 ? "Needs Attention" : "At Risk";
}

export interface EnterpriseGRCSnapshot {
  audit_score: number | null;
  audit_dimensions: {
    people: number | null;
    process: number | null;
    governance: number | null;
  } | null;
  audit_records: number;
  audit_issues: number;
  audit_module_breakdown: AuditModuleBreakdown[];
  nc_summary: { open: number; total: number };
  capa_summary: { open: number; total: number; effectiveness_rate: number };
  risk_summary: { active: number; critical_high: number };
  kpi_summary: { green: number; amber: number; red: number; total: number };
  compliance_summary: { met: number; partial: number; not_met: number; total: number };
  sop_gap_summary: SopGapSummary;
  enterprise_health_score: number;
  enterprise_health_rating: EnterpriseHealthRating;
}

// Brief in-process cache for the snapshot. The dashboard pulls /api/dashboard
// on every page load and on the auto-refresh tick; without this, every load
// fans out ~10 aggregate queries even though the underlying counts barely
// change second-to-second. 30 s is short enough that operators see fresh
// data after acting on a finding, while collapsing burst refreshes onto a
// single DB pass. Single-process; tests can override with the env var.
let _snapshotCache: { value: EnterpriseGRCSnapshot; expiresAt: number } | null = null;
let _snapshotInflight: Promise<EnterpriseGRCSnapshot> | null = null;
function snapshotCacheTtlMs(): number {
  const raw = process.env.GRC_SNAPSHOT_CACHE_TTL_MS;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 30_000;
}

/** Test-only: drop the in-process snapshot cache. */
export function resetEnterpriseGRCSnapshotCache(): void {
  _snapshotCache = null;
  _snapshotInflight = null;
}

/**
 * Lightweight snapshot of the same enterprise-wide GRC signals the executive
 * digest summarises, without the CRMProvider CRM scan or business-section build.
 *
 * Mirrors `generateDigestData` numerically (uses the same queries and the
 * same `computeEnterpriseHealthScore`) so any UI rendering this snapshot
 * agrees with the ChatProvider/email digest by construction. Cached in-process for
 * `GRC_SNAPSHOT_CACHE_TTL_MS` (default 30 s) so the dashboard's per-request
 * call doesn't multiply DB load on refresh storms.
 */
export async function getEnterpriseGRCSnapshot(): Promise<EnterpriseGRCSnapshot> {
  const now = Date.now();
  if (_snapshotCache && _snapshotCache.expiresAt > now) {
    return _snapshotCache.value;
  }
  // Coalesce concurrent callers onto a single in-flight DB pass.
  if (_snapshotInflight) return _snapshotInflight;
  _snapshotInflight = (async () => {
    try {
      const value = await _computeEnterpriseGRCSnapshot();
      _snapshotCache = { value, expiresAt: Date.now() + snapshotCacheTtlMs() };
      return value;
    } finally {
      _snapshotInflight = null;
    }
  })();
  return _snapshotInflight;
}

async function _computeEnterpriseGRCSnapshot(): Promise<EnterpriseGRCSnapshot> {
  const [
    ncOpen,
    ncTotal,
    capaOpen,
    capaTotal,
    capaEffective,
    riskActive,
    riskCritHigh,
    riskTotal,
    kpiRows,
    compRows,
    auditRows,
  ] = await Promise.all([
    safeQuery(`SELECT COUNT(*) as cnt FROM audit_findings WHERE LOWER(COALESCE(status,'open')) NOT IN ('closed','resolved','rejected')`),
    safeQuery(`SELECT COUNT(*) as cnt FROM audit_findings`),
    safeQuery(`SELECT COUNT(*) as cnt FROM capas WHERE LOWER(COALESCE(status,'open')) NOT IN ('closed','cancelled','completed')`),
    safeQuery(`SELECT COUNT(*) as cnt FROM capas`),
    safeQuery(`SELECT COUNT(*) FILTER (WHERE LOWER(COALESCE(status,'open')) = 'completed') as eff, COUNT(*) as total FROM capa_action_items`),
    safeQuery(`SELECT COUNT(*) as cnt FROM enterprise_risks WHERE LOWER(COALESCE(status,'open')) NOT IN ('closed','accepted')`),
    safeQuery(`SELECT COUNT(*) as cnt FROM enterprise_risks WHERE COALESCE(risk_score,0) >= 15 AND LOWER(COALESCE(status,'open')) NOT IN ('closed','accepted')`),
    safeQuery(`SELECT COUNT(*) as cnt FROM enterprise_risks`),
    safeQuery(`
      WITH latest AS (
        SELECT DISTINCT ON (kpi_id) kpi_id, status
        FROM kpi_values
        ORDER BY kpi_id, period_end DESC NULLS LAST, id DESC
      )
      SELECT
        COUNT(*) FILTER (WHERE LOWER(COALESCE(status,'')) IN ('green','on_track')) as green,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(status,'')) IN ('amber','at_risk')) as amber,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(status,'')) IN ('red','off_track')) as red,
        COUNT(*) as total FROM latest
    `),
    safeQuery(`
      SELECT
        COUNT(*) FILTER (WHERE LOWER(COALESCE(compliance_status,'')) IN ('met','compliant')) as met,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(compliance_status,'')) IN ('partial','partially_compliant')) as partial,
        COUNT(*) FILTER (WHERE LOWER(COALESCE(compliance_status,'')) IN ('not_met','non_compliant')) as not_met,
        COUNT(*) as total
      FROM compliance_assessments
    `),
    safeQuery(
      `SELECT overall_score, people_score, process_score, governance_score,
              total_records_audited, total_issues_found, dimension_details
       FROM quality_audit_results
       ORDER BY audit_date DESC LIMIT 1`,
    ),
  ]);

  const auditScore = auditRows[0]?.overall_score
    ? parseFloat(auditRows[0].overall_score)
    : null;
  const auditPeople = auditRows[0]?.people_score != null
    ? parseFloat(auditRows[0].people_score)
    : null;
  const auditProcess = auditRows[0]?.process_score != null
    ? parseFloat(auditRows[0].process_score)
    : null;
  const auditGovernance = auditRows[0]?.governance_score != null
    ? parseFloat(auditRows[0].governance_score)
    : null;
  const auditRecords = parseInt(auditRows[0]?.total_records_audited || "0", 10);
  const auditIssues = parseInt(auditRows[0]?.total_issues_found || "0", 10);
  const auditModuleBreakdown = parseAuditModuleBreakdown(
    auditRows[0]?.dimension_details,
  );
  const ncOpenN = parseInt(ncOpen[0]?.cnt || "0", 10);
  const ncTotalN = parseInt(ncTotal[0]?.cnt || "0", 10);
  const capaOpenN = parseInt(capaOpen[0]?.cnt || "0", 10);
  const capaTotalN = parseInt(capaTotal[0]?.cnt || "0", 10);
  const capaEffN = parseInt(capaEffective[0]?.eff || "0", 10);
  const capaEffTotalN = parseInt(capaEffective[0]?.total || "0", 10);
  const riskActiveN = parseInt(riskActive[0]?.cnt || "0", 10);
  const riskCritHighN = parseInt(riskCritHigh[0]?.cnt || "0", 10);
  const riskTotalN = parseInt(riskTotal[0]?.cnt || "0", 10);
  const kpiGreenN = parseInt(kpiRows[0]?.green || "0", 10);
  const kpiAmberN = parseInt(kpiRows[0]?.amber || "0", 10);
  const kpiRedN = parseInt(kpiRows[0]?.red || "0", 10);
  const kpiTotalN = parseInt(kpiRows[0]?.total || "0", 10);

  const compMetN = parseInt(compRows[0]?.met || "0", 10);
  const compPartialN = parseInt(compRows[0]?.partial || "0", 10);
  const compTotalN = parseInt(compRows[0]?.total || "0", 10);

  let sopSummary: SopGapSummary;
  try {
    sopSummary = await computeSopGapSummary();
  } catch {
    sopSummary = {
      documents_scanned: 0,
      requirements_total: 0,
      requirements_covered: 0,
      open_gaps: 0,
      coverage_pct: 0,
      top_gaps: [],
      coverage_breakdown: { obligation_id: 0, normalised_text: 0, ancestor: 0 },
      reason: "SOP gap detection failed",
    };
  }

  const score = computeEnterpriseHealthScore({
    auditScore,
    auditPeople,
    auditProcess,
    auditGovernance,
    auditRecords,
    auditIssues,
    auditModuleBreakdown,
    ncOpen: ncOpenN,
    ncTotal: ncTotalN,
    capaOpen: capaOpenN,
    capaTotal: capaTotalN,
    capaEffectiveCompleted: capaEffN,
    capaEffectiveTotal: capaEffTotalN,
    riskActive: riskActiveN,
    riskCritHigh: riskCritHighN,
    riskTotal: riskTotalN,
    kpiGreen: kpiGreenN,
    kpiAmber: kpiAmberN,
    kpiTotal: kpiTotalN,
    complianceMet: compMetN,
    compliancePartial: compPartialN,
    complianceTotal: compTotalN,
    sopRequirementsTotal: sopSummary.requirements_total,
    sopRequirementsCovered: sopSummary.requirements_covered,
  });

  return {
    audit_score: auditScore,
    audit_dimensions:
      auditPeople !== null || auditProcess !== null || auditGovernance !== null
        ? { people: auditPeople, process: auditProcess, governance: auditGovernance }
        : null,
    audit_records: auditRecords,
    audit_issues: auditIssues,
    audit_module_breakdown: auditModuleBreakdown,
    nc_summary: { open: ncOpenN, total: ncTotalN },
    capa_summary: {
      open: capaOpenN,
      total: capaTotalN,
      effectiveness_rate:
        capaEffTotalN > 0 ? Math.round((capaEffN / capaEffTotalN) * 100) : 0,
    },
    risk_summary: { active: riskActiveN, critical_high: riskCritHighN },
    kpi_summary: { green: kpiGreenN, amber: kpiAmberN, red: kpiRedN, total: kpiTotalN },
    compliance_summary: {
      met: parseInt(compRows[0]?.met || "0", 10),
      partial: parseInt(compRows[0]?.partial || "0", 10),
      not_met: parseInt(compRows[0]?.not_met || "0", 10),
      total: parseInt(compRows[0]?.total || "0", 10),
    },
    sop_gap_summary: sopSummary,
    enterprise_health_score: score,
    enterprise_health_rating: ratingForEnterpriseHealth(score),
  };
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

function cadenceLabel(cadence: DigestCadence): string {
  if (cadence === "monthly") return "Monthly";
  if (cadence === "quarterly") return "Quarterly";
  return "Weekly";
}

function escapeHtmlAttr(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeChatProvider(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildSopGapChatProviderBlocks(sop: SopGapSummary): Array<Record<string, unknown>> {
  if (sop.documents_scanned === 0 || sop.requirements_total === 0) {
    return [];
  }
  const lines = [
    `*SOP gaps:* ${sop.open_gaps} expected NC(s) - ${sop.coverage_pct}% coverage (${sop.requirements_covered}/${sop.requirements_total} across ${sop.documents_scanned} SOP doc(s))`,
  ];
  const top = sop.top_gaps.slice(0, 5);
  if (top.length > 0) {
    lines.push(
      ...top.map(
        (g) =>
          `- ${escapeChatProvider(g.framework_hint || g.category)} ${escapeChatProvider(g.raw_citation)} _(${escapeChatProvider(g.document_title)})_`,
      ),
    );
  }
  return [
    { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
  ];
}

export function buildSopGapHtml(sop: SopGapSummary): string {
  if (sop.documents_scanned === 0) {
    return `<div class="card"><h3>SOP Gaps</h3><p style="font-size:13px;color:#6B7280">${escapeHtmlAttr(sop.reason || "No SOP documents available to scan.")}</p></div>`;
  }
  if (sop.requirements_total === 0) {
    return `<div class="card"><h3>SOP Gaps</h3>
<div class="metric-row"><span>SOP documents scanned</span><span class="metric-value">${sop.documents_scanned}</span></div>
<p style="font-size:13px;color:#6B7280">${escapeHtmlAttr(sop.reason || "No clause/article references found in SOP text.")}</p></div>`;
  }
  const gapRows = sop.top_gaps
    .map(
      (g) => `<div class="alert-row"><span class="badge badge-${sop.open_gaps > 0 ? "amber" : "green"}">${escapeHtmlAttr(g.framework_hint || g.category)}</span> ${escapeHtmlAttr(g.raw_citation)} <span style="color:#6B7280">— ${escapeHtmlAttr(g.document_title)}</span></div>`,
    )
    .join("");
  const color = sop.open_gaps > 0 ? "#B91C1C" : "#047857";
  return `<div class="card">
  <h3>SOP Gaps (derived from uploaded SOPs)</h3>
  <div class="metric-row"><span>SOP documents scanned</span><span class="metric-value">${sop.documents_scanned}</span></div>
  <div class="metric-row"><span>Requirements derived</span><span class="metric-value">${sop.requirements_total}</span></div>
  <div class="metric-row"><span>Covered by audits/CAPAs/risks</span><span class="metric-value">${sop.requirements_covered}</span></div>
  <div class="metric-row"><span>Open gaps (expected NCs)</span><span class="metric-value" style="color:${color}">${sop.open_gaps}</span></div>
  <div class="metric-row"><span>Coverage</span><span class="metric-value">${sop.coverage_pct}%</span></div>
  ${gapRows ? `<hr style="border:0;border-top:1px solid #E5E7EB;margin:10px 0;" />${gapRows}` : ""}
</div>`;
}

export function buildDigestHTML(data: DigestData): string {
  const trendIcon =
    data.audit_summary.trend === "improving"
      ? "UP"
      : data.audit_summary.trend === "declining"
        ? "DOWN"
        : data.audit_summary.trend === "rules_changed"
          ? "RULES CHANGED"
          : data.audit_summary.trend === "scope_changed"
            ? "SCOPE CHANGED"
            : "STABLE";
  const trendColor =
    data.audit_summary.trend === "improving"
      ? "#047857"
      : data.audit_summary.trend === "declining"
        ? "#B91C1C"
        : data.audit_summary.trend === "rules_changed" ||
            data.audit_summary.trend === "scope_changed"
          ? "#B45309"
          : "#6B7280";
  const businessSectionsHtml = data.business_sections
    .map(
      (section) => `<div class="metric-row"><span>${section.title}</span><span class="metric-value">${section.total} (L:${section.leads} / D:${section.deals})</span></div>
  <div class="metric-row"><span>Progressed / Stalled</span><span class="metric-value">${section.progressed} / ${section.stalled}</span></div>
  <div class="metric-row"><span>Severity (C/H/M/L)</span><span class="metric-value">${section.severity_counts.critical}/${section.severity_counts.high}/${section.severity_counts.medium}/${section.severity_counts.low}</span></div>
  <div class="metric-row"><span>Section Health</span><span class="metric-value">${section.health_score}%</span></div>`,
    )
    .join("");

  const fb = data.ai_feedback_summary;
  const fbDir = fb.trend.direction;
  const fbIcon = fbDir === "improving" ? "↑" : fbDir === "worsening" ? "↓" : fbDir === "stable" ? "→" : "·";
  const fbColor = fbDir === "improving" ? "#047857" : fbDir === "worsening" ? "#B91C1C" : "#6B7280";
  const fbLabel = fbDir === "insufficient_data" ? "insufficient data" : fbDir;
  const fbSection = fb.total === 0
    ? `<div class="card"><h3>AI Consultant Feedback</h3><p style="font-size:13px;color:#6B7280">No feedback this week.</p></div>`
    : `<div class="card">
  <h3>AI Consultant Feedback</h3>
  <div class="metric-row"><span>Total responses rated</span><span class="metric-value">${fb.total}</span></div>
  <div class="metric-row"><span><span class="badge badge-green">Thumbs up</span></span><span class="metric-value">${fb.thumbs_up} (${fb.thumbs_up_pct}%)</span></div>
  <div class="metric-row"><span><span class="badge badge-red">Thumbs down</span></span><span class="metric-value">${fb.thumbs_down}</span></div>
  <div class="metric-row"><span>Trend</span><span class="metric-value" style="color:${fbColor}">${fbIcon} ${fbLabel}</span></div>
  ${fb.trend.peak_negative_day && fb.trend.peak_negative_count > 0 ? `<div class="metric-row"><span>Peak negative day</span><span class="metric-value">${fb.trend.peak_negative_day} (${fb.trend.peak_negative_count})</span></div>` : ""}
</div>`;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>ExampleOrg ${cadenceLabel(data.cadence)} Quality Digest</title>
<style>
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #1a1a1a; max-width: 760px; margin: 0 auto; padding: 20px; background: #f9fafb; }
  .header { background: linear-gradient(135deg, #1E3A8A, #3B82F6); color: white; padding: 24px; border-radius: 12px; margin-bottom: 20px; }
  .header h1 { margin: 0; font-size: 22px; }
  .header p { margin: 4px 0 0; opacity: 0.85; font-size: 13px; }
  .card { background: white; border-radius: 10px; padding: 16px 20px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .card h3 { margin: 0 0 12px; font-size: 15px; color: #374151; border-bottom: 1px solid #E5E7EB; padding-bottom: 8px; }
  .metric-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; }
  .metric-value { font-weight: 600; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
  .badge-red { background: #FEE2E2; color: #B91C1C; }
  .badge-amber { background: #FEF3C7; color: #D97706; }
  .badge-green { background: #D1FAE5; color: #047857; }
  .alert-row { padding: 6px 0; border-bottom: 1px solid #F3F4F6; font-size: 13px; }
  .footer { text-align: center; margin-top: 20px; font-size: 11px; color: #9CA3AF; }
</style></head><body>
<div class="header">
  <h1>${cadenceLabel(data.cadence)} Quality Digest</h1>
  <p>${data.period}</p>
</div>

<div class="card">
  <h3>Business Sections</h3>
  <div class="metric-row"><span>Total records in scope</span><span class="metric-value">${data.business_overview.total_records} (L:${data.business_overview.total_leads} / D:${data.business_overview.total_deals})</span></div>
  <div class="metric-row"><span>Total hygiene issues</span><span class="metric-value">${data.business_overview.total_issues}</span></div>
  <div class="metric-row"><span>Severity (C/H/M/L)</span><span class="metric-value">${data.business_overview.severity_counts.critical}/${data.business_overview.severity_counts.high}/${data.business_overview.severity_counts.medium}/${data.business_overview.severity_counts.low}</span></div>
  <hr style="border:0;border-top:1px solid #E5E7EB;margin:10px 0;" />
  ${businessSectionsHtml || `<div class="metric-row"><span>No CRM records in window</span><span class="metric-value">0</span></div>`}
</div>

<div class="card">
  <h3>Nonconformances</h3>
  <div class="metric-row"><span>Open NCs</span><span class="metric-value">${data.nc_summary.open}</span></div>
  <div class="metric-row"><span>Opened in window</span><span class="metric-value">${data.nc_summary.opened_this_week}</span></div>
  <div class="metric-row"><span>Closed in window</span><span class="metric-value">${data.nc_summary.closed_this_week}</span></div>
  <div class="metric-row"><span>Overdue (&gt;15 days)</span><span class="metric-value" style="color:${data.nc_summary.overdue > 0 ? "#B91C1C" : "#047857"}">${data.nc_summary.overdue}</span></div>
</div>

<div class="card">
  <h3>CAPAs</h3>
  <div class="metric-row"><span>Open CAPAs</span><span class="metric-value">${data.capa_summary.open}</span></div>
  <div class="metric-row"><span>Opened in window</span><span class="metric-value">${data.capa_summary.opened_this_week}</span></div>
  <div class="metric-row"><span>Closed in window</span><span class="metric-value">${data.capa_summary.closed_this_week}</span></div>
  <div class="metric-row"><span>Effectiveness rate</span><span class="metric-value">${data.capa_summary.effectiveness_rate}%</span></div>
</div>

<div class="card">
  <h3>Risks</h3>
  <div class="metric-row"><span>Active risks</span><span class="metric-value">${data.risk_summary.total_active}</span></div>
  <div class="metric-row"><span>Critical/High</span><span class="metric-value" style="color:${data.risk_summary.critical_high > 0 ? "#B91C1C" : "#047857"}">${data.risk_summary.critical_high}</span></div>
  <div class="metric-row"><span>New in window</span><span class="metric-value">${data.risk_summary.new_this_week}</span></div>
  <div class="metric-row"><span>Overdue treatments</span><span class="metric-value" style="color:${data.risk_summary.overdue_treatments > 0 ? "#D97706" : "#047857"}">${data.risk_summary.overdue_treatments}</span></div>
</div>

<div class="card">
  <h3>Quality Audit</h3>
  <div class="metric-row"><span>Last score</span><span class="metric-value">${data.audit_summary.last_score !== null ? `${data.audit_summary.last_score}%` : "N/A"}</span></div>
  <div class="metric-row"><span>Trend</span><span class="metric-value" style="color:${trendColor}">${trendIcon} ${data.audit_summary.trend}</span></div>
  <div class="metric-row"><span>Enterprise Health</span><span class="metric-value" style="color:${data.health_score >= 75 ? "#047857" : data.health_score >= 50 ? "#D97706" : "#B91C1C"}">${data.health_score}%</span></div>
</div>

<div class="card">
  <h3>KPIs</h3>
  <div class="metric-row"><span><span class="badge badge-green">Green</span></span><span class="metric-value">${data.kpi_summary.green}</span></div>
  <div class="metric-row"><span><span class="badge badge-amber">Amber</span></span><span class="metric-value">${data.kpi_summary.amber}</span></div>
  <div class="metric-row"><span><span class="badge badge-red">Red</span></span><span class="metric-value">${data.kpi_summary.red}</span></div>
</div>

${fbSection}

${data.top_alerts.length > 0 ? `<div class="card">
  <h3>Top Alerts</h3>
  ${data.top_alerts.map((a) => `<div class="alert-row"><span class="badge badge-${a.severity === "critical" ? "red" : "amber"}">${a.severity}</span> ${a.title}</div>`).join("")}
</div>` : ""}

${data.capa_recurrences > 0 ? `<div class="card"><h3>CAPA Recurrences</h3><p style="font-size:13px">${data.capa_recurrences} recurring root cause pattern(s) detected - review recommended.</p></div>` : ""}

${data.duplicate_clusters > 0 ? `<div class="card"><h3>Duplicate Radar</h3><p style="font-size:13px">${data.duplicate_clusters} active duplicate cluster(s) require attention.</p></div>` : ""}

${buildSopGapHtml(data.sop_gap_summary)}

<div class="footer">Generated by ExampleOrg QMS Platform - ${data.generated_at}<br/>This is an automated quality digest. Do not reply.</div>
</body></html>`;
}

export function buildDigestChatProviderBlocks(data: DigestData): any[] {
  const healthEmoji = (score: number): string =>
    score >= 90 ? "Excellent" : score >= 75 ? "Good" : score >= 60 ? "Needs Attention" : "At Risk";
  const hasAbsoluteDashboardUrl = /^https?:\/\//i.test(DIGEST_DASHBOARD_LINK);
  const generatedTimeKsa = new Date(data.generated_at).toLocaleTimeString("en-US", {
    timeZone: "Asia/Riyadh",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });

  const sections = data.business_sections.map((section) => ({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*--- ${section.title} ---*\n- Total: *${section.total}* (Leads *${section.leads}* / Deals *${section.deals}*)\n- New: *${section.new_in_window}*\n- Progressed: *${section.progressed}*\n- Stalled: *${section.stalled}*\n- Severity: 🔴 Critical *${section.severity_counts.critical}* | 🟠 High *${section.severity_counts.high}* | 🟡 Medium *${section.severity_counts.medium}* | 🟢 Low *${section.severity_counts.low}*\n- Health: ${healthEmoji(section.health_score)} *${section.health_score}%*`,
    },
  }));
  const findingTypeLines = data.finding_types.map(
    (f) =>
      `- *${f.module}* / ${f.issue_type}: ${f.count} _(${f.severity})_`,
  );
  const findingTypeChunks: string[] = [];
  if (findingTypeLines.length > 0) {
    let currentChunk = "";
    for (const line of findingTypeLines) {
      const candidate = currentChunk ? `${currentChunk}\n${line}` : line;
      if (candidate.length > 2800) {
        if (currentChunk) findingTypeChunks.push(currentChunk);
        currentChunk = line;
      } else {
        currentChunk = candidate;
      }
    }
    if (currentChunk) findingTypeChunks.push(currentChunk);
  }
  const blocks: any[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${cadenceLabel(data.cadence)} Executive Digest`,
        emoji: true,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Period Covered: ${data.period} (KSA)`,
        },
        {
          type: "mrkdwn",
          text: `Generated: ${generatedTimeKsa} (KSA)`,
        },
      ],
    },
    { type: "divider" },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Records Audited*\n${data.business_overview.total_records} (Leads ${data.business_overview.total_leads} / Deals ${data.business_overview.total_deals})`,
        },
        {
          type: "mrkdwn",
          text: `*Issues Found*\n${data.business_overview.total_issues}`,
        },
        {
          type: "mrkdwn",
          text: `*Severity*\n🔴 Critical ${data.business_overview.severity_counts.critical}\n🟠 High ${data.business_overview.severity_counts.high}\n🟡 Medium ${data.business_overview.severity_counts.medium}\n🟢 Low ${data.business_overview.severity_counts.low}`,
        },
        {
          type: "mrkdwn",
          text: `*Audit Snapshot*\nScore ${data.audit_summary.last_score !== null ? `${data.audit_summary.last_score}%` : "N/A"} - Trend ${data.audit_summary.trend}${data.audit_summary.trend_caveat ? `\n_${data.audit_summary.trend_caveat}_` : ""}\nHealth ${healthEmoji(data.health_score)} *${data.health_score}%*`,
        },
      ],
    },
    { type: "divider" },
    ...sections.flatMap((s, idx) => (idx < sections.length - 1 ? [s, { type: "divider" }] : [s])),
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Quality snapshot:* NC Open ${data.nc_summary.open} - CAPA Open ${data.capa_summary.open} - Risks ${data.risk_summary.total_active} - KPI Red ${data.kpi_summary.red}`,
      },
    },
    ...buildSopGapChatProviderBlocks(data.sop_gap_summary),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `*Progressed = records in advancing stages (Qualified, Proposal, Negotiation, Won/Converted/Contract/Onboarding).*\n*Stalled = records in non-progress stages (On hold, Lost, Not Interested, Junk, Unqualified, Inactive).*`,
        },
      ],
    },
  ];
  if (hasAbsoluteDashboardUrl) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open Executive Dashboard", emoji: true },
          url: DIGEST_DASHBOARD_LINK,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Download Issues (Excel)", emoji: true },
          url: `${new URL("/api/digest/issues.xlsx", DIGEST_DASHBOARD_LINK).toString()}?cadence=${encodeURIComponent(data.cadence)}&windowStart=${encodeURIComponent(data.window_start)}&windowEnd=${encodeURIComponent(data.window_end)}`,
        },
      ],
    });
  }
  if (findingTypeChunks.length > 0) {
    blocks.push({ type: "divider" });
    findingTypeChunks.forEach((chunk, idx) => {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            idx === 0
              ? `*--- All Finding Types (${data.finding_types.length}) ---*\n${chunk}`
              : `*--- All Finding Types (continued ${idx + 1}) ---*\n${chunk}`,
        },
      });
    });
  }
  return blocks;
}

function resolveChatProviderChannel(cadence: DigestCadence, override?: string): string | null {
  if (override) return override;
  if (cadence === "monthly" && process.env.DIGEST_ChatProvider_CHANNEL_MONTHLY)
    return process.env.DIGEST_ChatProvider_CHANNEL_MONTHLY;
  if (cadence === "quarterly" && process.env.DIGEST_ChatProvider_CHANNEL_QUARTERLY)
    return process.env.DIGEST_ChatProvider_CHANNEL_QUARTERLY;
  if (cadence === "weekly" && process.env.DIGEST_ChatProvider_CHANNEL_WEEKLY)
    return process.env.DIGEST_ChatProvider_CHANNEL_WEEKLY;
  return (
    process.env.DIGEST_ChatProvider_CHANNEL ||
    process.env.ChatProvider_CHANNEL_ID ||
    process.env.ChatProvider_QMS_CHANNEL ||
    null
  );
}

export async function sendDigestEmail(
  options: DigestSendOptions = {},
): Promise<DigestSendResult> {
  const cadence = options.cadence || "weekly";
  const window = options.window || computeDigestWindow(cadence, options.now || new Date());
  const runKey = buildDigestRunKey(cadence, window, "email");

  if (options.enforceIdempotency !== false && (await hasSuccessfulDigestRun(runKey))) {
    return {
      success: true,
      skipped: true,
      method: "email-idempotent",
      runKey,
      cadence,
      windowStart: window.start.toISOString(),
      windowEnd: window.end.toISOString(),
    };
  }

  const data = await generateDigestData({ cadence, window, now: options.now });
  const html = buildDigestHTML(data);

  const recipientEmail = process.env.QUALITY_DIGEST_EMAIL || process.env.ADMIN_EMAIL;
  if (!recipientEmail) {
    const error = "No recipient email configured (QUALITY_DIGEST_EMAIL or ADMIN_EMAIL)";
    await recordDigestRun({ runKey, cadence, channel: "email", window, status: "failed", error });
    return { success: false, error, runKey, cadence };
  }

  try {
    if (process.env.EmailProvider_API_KEY) {
      const response = await fetch("<REDACTED_URL>", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.EmailProvider_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: process.env.EmailProvider_FROM || "ExampleOrg QMS <user@example.invalid>",
          to: recipientEmail,
          subject: `${cadenceLabel(cadence)} Quality Digest - ${new Date().toLocaleDateString()}`,
          html,
        }),
      });
      if (response.ok) {
        await recordDigestRun({ runKey, cadence, channel: "email", window, status: "success" });
        return { success: true, method: "EmailProvider", runKey, cadence };
      }
    }
  } catch (err) {
    logger.warn("[Digest][email] EmailProvider branch failed, trying fallback", {
      error: err instanceof Error ? err.message : String(err),
      runKey,
    });
  }

  try {
    const mailUrl = `<REDACTED_URL> || "qms"}.${process.env.REPL_OWNER || "user"}.<REDACTED_HOST>/__repl_mail/send`;
    const response = await fetch(mailUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: recipientEmail,
        subject: `${cadenceLabel(cadence)} Quality Digest - ${new Date().toLocaleDateString()}`,
        html,
      }),
    });
    if (response.ok) {
      await recordDigestRun({ runKey, cadence, channel: "email", window, status: "success" });
      return { success: true, method: "HostingPlatform_mail", runKey, cadence };
    }
  } catch (err) {
    logger.warn("[Digest][email] HostingPlatform mail branch failed", {
      error: err instanceof Error ? err.message : String(err),
      runKey,
    });
  }

  const error = "No email service available";
  await recordDigestRun({ runKey, cadence, channel: "email", window, status: "failed", error });
  return { success: false, error, runKey, cadence };
}

export async function sendDigestChatProvider(
  options: DigestSendOptions = {},
): Promise<DigestSendResult> {
  const cadence = options.cadence || "weekly";
  const window = options.window || computeDigestWindow(cadence, options.now || new Date());
  const runKey = buildDigestRunKey(cadence, window, "ChatProvider");

  const ChatProviderEnabled = envBool("DIGEST_ChatProvider_NOTIFY", true);
  if (!ChatProviderEnabled) {
    return { success: true, skipped: true, method: "ChatProvider-disabled", runKey, cadence };
  }

  const hasChatProviderCreds = !!(process.env.ChatProvider_BOT_TOKEN || process.env.ChatProvider_API_TOKEN);
  if (!hasChatProviderCreds) {
    return {
      success: true,
      skipped: true,
      method: "ChatProvider-no-credentials",
      runKey,
      cadence,
    };
  }

  const channel = resolveChatProviderChannel(cadence, options.channelOverride);
  if (!channel) {
    return { success: true, skipped: true, method: "ChatProvider-no-channel", runKey, cadence };
  }

  if (options.enforceIdempotency !== false && (await hasSuccessfulDigestRun(runKey))) {
    return {
      success: true,
      skipped: true,
      method: "ChatProvider-idempotent",
      runKey,
      cadence,
      windowStart: window.start.toISOString(),
      windowEnd: window.end.toISOString(),
    };
  }

  const data = await generateDigestData({ cadence, window, now: options.now });
  const blocks = buildDigestChatProviderBlocks(data);
  const fallback = `${cadenceLabel(cadence)} executive digest (${data.period})`;

  if (options.preview) {
    return {
      success: true,
      preview: true,
      blocks,
      method: "ChatProvider-preview",
      runKey,
      cadence,
      windowStart: window.start.toISOString(),
      windowEnd: window.end.toISOString(),
    };
  }

  const { enqueueChatProviderOutboxMessage, processOutboxMessageById, processDueOutboxMessages } =
    await import("./notificationOutbox");
  await processDueOutboxMessages(20);
  const dedupeKey = options.enforceIdempotency === false ? undefined : runKey;
  const outbox = await enqueueChatProviderOutboxMessage({
    source: `executive_digest_${cadence}`,
    destination: channel,
    text: fallback,
    blocks,
    dedupeKey,
    metadata: {
      cadence,
      runKey,
      windowStart: window.start.toISOString(),
      windowEnd: window.end.toISOString(),
    },
    maxAttempts: Number.parseInt(process.env.DIGEST_OUTBOX_MAX_ATTEMPTS || "4", 10),
  });
  const delivered = await processOutboxMessageById(outbox.id);
  if (!delivered) {
    const error = "Outbox enqueue succeeded but delivery record unavailable";
    await recordDigestRun({ runKey, cadence, channel: "ChatProvider", window, status: "failed", error });
    return { success: false, error, runKey, cadence };
  }
  if (delivered.status === "sent") {
    await recordDigestRun({ runKey, cadence, channel: "ChatProvider", window, status: "success" });
    return { success: true, method: "ChatProvider-outbox", runKey, cadence };
  }
  if (delivered.status === "pending" || delivered.status === "processing") {
    await recordDigestRun({
      runKey,
      cadence,
      channel: "ChatProvider",
      window,
      status: "queued",
      error: delivered.last_error || undefined,
    });
    return {
      success: true,
      method: "ChatProvider-outbox-queued",
      runKey,
      cadence,
      error: delivered.last_error || undefined,
    };
  }

  const error = delivered.last_error || "ChatProvider delivery failed";
  await recordDigestRun({ runKey, cadence, channel: "ChatProvider", window, status: "failed", error });
  return { success: false, error, runKey, cadence };
}

export async function runDigestFanout(
  cadence: DigestCadence,
  options: DigestSendOptions = {},
): Promise<DigestFanoutResult> {
  const now = options.now || new Date();
  const window = options.window || computeDigestWindow(cadence, now);
  const [emailResult, ChatProviderResult] = await Promise.allSettled([
    sendDigestEmail({ ...options, cadence, now, window }),
    sendDigestChatProvider({ ...options, cadence, now, window }),
  ]);
  const email =
    emailResult.status === "fulfilled"
      ? emailResult.value
      : ({ success: false, error: emailResult.reason ? String(emailResult.reason) : "email fanout failed" } as DigestSendResult);
  const ChatProvider =
    ChatProviderResult.status === "fulfilled"
      ? ChatProviderResult.value
      : ({ success: false, error: ChatProviderResult.reason ? String(ChatProviderResult.reason) : "ChatProvider fanout failed" } as DigestSendResult);
  return { cadence, window, email, ChatProvider };
}

export async function getDigestDeliveryHealth(
  cadence: DigestCadence = "weekly",
  now = new Date(),
): Promise<DigestDeliveryHealth> {
  const window = computeDigestWindow(cadence, now);
  const runKeyChatProvider = buildDigestRunKey(cadence, window, "ChatProvider");
  const runKeyEmail = buildDigestRunKey(cadence, window, "email");
  const ChatProviderEnabled = envBool("DIGEST_ChatProvider_NOTIFY", true);
  const directAuditChatProviderEnabled = envBool("DIRECT_AUDIT_ChatProvider_NOTIFY", true);
  const hasChatProviderCredentials = !!(
    process.env.ChatProvider_BOT_TOKEN || process.env.ChatProvider_API_TOKEN
  );
  const ChatProviderChannelResolved = resolveChatProviderChannel(cadence);
  const hasDigestEmailRecipient = !!(
    process.env.QUALITY_DIGEST_EMAIL || process.env.ADMIN_EMAIL
  );
  const [idempotentRunExistsChatProvider, idempotentRunExistsEmail] = await Promise.all([
    hasSuccessfulDigestRun(runKeyChatProvider),
    hasSuccessfulDigestRun(runKeyEmail),
  ]);
  return {
    cadence,
    window_start: window.start.toISOString(),
    window_end: window.end.toISOString(),
    run_key_ChatProvider: runKeyChatProvider,
    run_key_email: runKeyEmail,
    ChatProvider_enabled: ChatProviderEnabled,
    direct_audit_ChatProvider_enabled: directAuditChatProviderEnabled,
    has_ChatProvider_credentials: hasChatProviderCredentials,
    ChatProvider_channel_resolved: ChatProviderChannelResolved,
    has_digest_email_recipient: hasDigestEmailRecipient,
    idempotent_run_exists_ChatProvider: idempotentRunExistsChatProvider,
    idempotent_run_exists_email: idempotentRunExistsEmail,
  };
}

export async function getRecentDigestRuns(
  limit = 30,
  cadence?: DigestCadence,
): Promise<DigestRunRecord[]> {
  await initDigestRunsTable();
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), 200) : 30;
  if (cadence) {
    const rows = await safeQuery(
      `SELECT run_key, cadence, channel, window_start, window_end, status, error, created_at
       FROM digest_delivery_runs
       WHERE cadence = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [cadence, safeLimit],
    );
    return rows as DigestRunRecord[];
  }
  const rows = await safeQuery(
    `SELECT run_key, cadence, channel, window_start, window_end, status, error, created_at
     FROM digest_delivery_runs
     ORDER BY created_at DESC
     LIMIT $1`,
    [safeLimit],
  );
  return rows as DigestRunRecord[];
}
