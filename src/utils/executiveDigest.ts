import pg from "pg";
import { logger } from "./logger";
import { sendSlackNotification } from "./slackNotifications";
import {
  analyzeRecordHygiene,
  DEFAULT_GOVERNANCE_RULES,
  fetchAllZohoRecords,
  type ZohoCRMRecord,
} from "./zohoCRM";
import { getGovernanceDocumentByModule } from "./database";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const KSA_OFFSET_MS = 3 * 60 * 60 * 1000;
const KSA_WEEKDAY_THURSDAY = 4;
const DIGEST_DASHBOARD_LINK = process.env.DIGEST_DASHBOARD_URL || "/executive";

export type DigestCadence = "weekly" | "monthly" | "quarterly";
export type DigestChannel = "email" | "slack";
export type DigestSendTarget = "email" | "slack" | "both";

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
    trend: "improving" | "declining" | "stable";
  };
  kpi_summary: { green: number; amber: number; red: number; total: number };
  compliance_summary: { met: number; partial: number; not_met: number; total: number };
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
  slack: DigestSendResult;
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
  run_key_slack: string;
  run_key_email: string;
  slack_enabled: boolean;
  direct_audit_slack_enabled: boolean;
  has_slack_credentials: boolean;
  slack_channel_resolved: string | null;
  has_digest_email_recipient: boolean;
  idempotent_run_exists_slack: boolean;
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

function dateLabelKsa(d: Date): string {
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

function getRecordTimestamp(record: ZohoCRMRecord): Date | null {
  const raw =
    record.createdTime ||
    record.data?.Created_Time ||
    record.data?.created_time ||
    record.data?.CreatedTime;
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function recordSignalText(record: ZohoCRMRecord): string {
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

function recordProgressSignal(record: ZohoCRMRecord): string {
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
      title: "Deals Corporates only",
      module: "Deals",
      includeKeywords: ["corporate", "enterprise", "b2b", "company"],
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

function matchesRule(record: ZohoCRMRecord, rule: DigestSectionRule): boolean {
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
  records: ZohoCRMRecord[],
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
  records: ZohoCRMRecord[],
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
    const windowStart = new Date(anchorThursdayStart.getTime() - 6 * 24 * 60 * 60 * 1000);
    const windowEnd = fromKsaParts(
      getKsaParts(anchorThursdayStart).year,
      getKsaParts(anchorThursdayStart).monthIndex,
      getKsaParts(anchorThursdayStart).day,
      23,
      59,
      59,
      999,
    );
    return {
      cadence,
      start: windowStart,
      end: windowEnd,
      periodLabel: `${dateLabelKsa(windowStart)} ΓÇö ${dateLabelKsa(windowEnd)}`,
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
      periodLabel: `${dateLabelKsa(start)} ΓÇö ${dateLabelKsa(end)}`,
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
    periodLabel: `${dateLabelKsa(start)} ΓÇö ${dateLabelKsa(end)}`,
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

async function safeQuery(sql: string, params: any[] = []): Promise<any[]> {
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
  status: "success" | "failed";
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

async function fetchWindowedBusinessRecords(window: DigestWindow): Promise<ZohoCRMRecord[]> {
  const hasZohoCreds = !!(
    process.env.ZOHO_ACCESS_TOKEN ||
    (process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET && process.env.ZOHO_REFRESH_TOKEN) ||
    (process.env.ZOHO_CLIENT_ID_NEW && process.env.ZOHO_CLIENT_SECRET && process.env.ZOHO_REFRESH_TOKEN)
  );
  if (!hasZohoCreds) {
    logger.info("[Digest] Zoho credentials missing; business sections will be empty");
    return [];
  }

  const maxRecords = Number(process.env.DIGEST_MAX_RECORDS_PER_MODULE || "5000");
  const [leads, deals] = await Promise.all([
    fetchAllZohoRecords("Leads", { maxRecords }),
    fetchAllZohoRecords("Deals", { maxRecords }),
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

  const [
    ncOpen,
    ncNewWeek,
    ncClosedWeek,
    ncOverdue,
    capaOpen,
    capaNewWeek,
    capaClosedWeek,
    capaEffective,
    riskActive,
    riskCritHigh,
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
      `SELECT COUNT(*) as cnt FROM nonconformance_records WHERE status NOT IN ('closed', 'rejected')`,
    ),
    safeQuery(
      `SELECT COUNT(*) as cnt FROM nonconformance_records WHERE created_at >= $1`,
      [weekAgoStr],
    ),
    safeQuery(
      `SELECT COUNT(*) as cnt FROM nonconformance_records WHERE closed_date >= $1`,
      [weekAgoStr],
    ),
    safeQuery(
      `SELECT COUNT(*) as cnt FROM nonconformance_records WHERE status NOT IN ('closed', 'rejected') AND created_at < NOW() - INTERVAL '15 days'`,
    ),
    safeQuery(
      `SELECT COUNT(*) as cnt FROM capa_records WHERE status NOT IN ('closed', 'cancelled')`,
    ),
    safeQuery(`SELECT COUNT(*) as cnt FROM capa_records WHERE created_at >= $1`, [weekAgoStr]),
    safeQuery(
      `SELECT COUNT(*) as cnt FROM capa_records WHERE completion_date >= $1`,
      [weekAgoStr],
    ),
    safeQuery(
      `SELECT COUNT(*) FILTER (WHERE effectiveness_result = 'effective') as eff, COUNT(*) as total FROM capa_records WHERE effectiveness_result IS NOT NULL`,
    ),
    safeQuery(`SELECT COUNT(*) as cnt FROM risk_register WHERE status != 'closed'`),
    safeQuery(
      `SELECT COUNT(*) as cnt FROM risk_register WHERE (likelihood * impact) >= 15 AND status != 'closed'`,
    ),
    safeQuery(`SELECT COUNT(*) as cnt FROM risk_register WHERE created_at >= $1`, [weekAgoStr]),
    safeQuery(
      `SELECT COUNT(*) as cnt FROM risk_treatment_actions WHERE due_date < CURRENT_DATE AND status NOT IN ('completed', 'cancelled')`,
    ),
    safeQuery(
      `SELECT overall_score, audit_date FROM quality_audits ORDER BY audit_date DESC LIMIT 3`,
    ),
    safeQuery(`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('green', 'on_track')) as green,
        COUNT(*) FILTER (WHERE status IN ('amber', 'at_risk')) as amber,
        COUNT(*) FILTER (WHERE status IN ('red', 'off_track')) as red,
        COUNT(*) as total
      FROM kpi_entries
    `),
    safeQuery(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'met') as met,
        COUNT(*) FILTER (WHERE status = 'partial') as partial,
        COUNT(*) FILTER (WHERE status = 'not_met') as not_met,
        COUNT(*) as total
      FROM compliance_obligations
    `),
    safeQuery(`
      SELECT title, severity, related_module as module
      FROM ai_alerts
      WHERE status = 'active' AND severity IN ('critical', 'high')
      ORDER BY created_at DESC LIMIT 5
    `),
    safeQuery(`
      SELECT root_cause, COUNT(*) as cnt
      FROM capa_records
      WHERE root_cause IS NOT NULL AND TRIM(root_cause) != ''
      GROUP BY root_cause HAVING COUNT(*) > 1
    `),
    safeQuery(`SELECT COUNT(*) as cnt FROM duplicate_clusters WHERE status = 'active'`),
    fetchWindowedBusinessRecords(window),
  ]);

  let auditTrend: "improving" | "declining" | "stable" = "stable";
  if (auditRows.length >= 2) {
    const diff =
      parseFloat(auditRows[0]?.overall_score || "0") -
      parseFloat(auditRows[1]?.overall_score || "0");
    auditTrend = diff > 2 ? "improving" : diff < -2 ? "declining" : "stable";
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
  };
}

function cadenceLabel(cadence: DigestCadence): string {
  if (cadence === "monthly") return "Monthly";
  if (cadence === "quarterly") return "Quarterly";
  return "Weekly";
}

export function buildDigestHTML(data: DigestData): string {
  const trendIcon =
    data.audit_summary.trend === "improving"
      ? "Γåæ"
      : data.audit_summary.trend === "declining"
        ? "Γåô"
        : "ΓåÆ";
  const trendColor =
    data.audit_summary.trend === "improving"
      ? "#047857"
      : data.audit_summary.trend === "declining"
        ? "#B91C1C"
        : "#6B7280";
  const businessSectionsHtml = data.business_sections
    .map(
      (section) => `<div class="metric-row"><span>${section.title}</span><span class="metric-value">${section.total} (L:${section.leads} / D:${section.deals})</span></div>
  <div class="metric-row"><span>Progressed / Stalled</span><span class="metric-value">${section.progressed} / ${section.stalled}</span></div>
  <div class="metric-row"><span>Severity (C/H/M/L)</span><span class="metric-value">${section.severity_counts.critical}/${section.severity_counts.high}/${section.severity_counts.medium}/${section.severity_counts.low}</span></div>
  <div class="metric-row"><span>Section Health</span><span class="metric-value">${section.health_score}%</span></div>`,
    )
    .join("");

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>WalaPlus ${cadenceLabel(data.cadence)} Quality Digest</title>
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
</div>

<div class="card">
  <h3>KPIs</h3>
  <div class="metric-row"><span><span class="badge badge-green">Green</span></span><span class="metric-value">${data.kpi_summary.green}</span></div>
  <div class="metric-row"><span><span class="badge badge-amber">Amber</span></span><span class="metric-value">${data.kpi_summary.amber}</span></div>
  <div class="metric-row"><span><span class="badge badge-red">Red</span></span><span class="metric-value">${data.kpi_summary.red}</span></div>
</div>

${data.top_alerts.length > 0 ? `<div class="card">
  <h3>Top Alerts</h3>
  ${data.top_alerts.map((a) => `<div class="alert-row"><span class="badge badge-${a.severity === "critical" ? "red" : "amber"}">${a.severity}</span> ${a.title}</div>`).join("")}
</div>` : ""}

${data.capa_recurrences > 0 ? `<div class="card"><h3>CAPA Recurrences</h3><p style="font-size:13px">${data.capa_recurrences} recurring root cause pattern(s) detected ΓÇö review recommended.</p></div>` : ""}

${data.duplicate_clusters > 0 ? `<div class="card"><h3>Duplicate Radar</h3><p style="font-size:13px">${data.duplicate_clusters} active duplicate cluster(s) require attention.</p></div>` : ""}

<div class="footer">Generated by WalaPlus QMS Platform ΓÇö ${data.generated_at}<br/>This is an automated quality digest. Do not reply.</div>
</body></html>`;
}

export function buildDigestSlackBlocks(data: DigestData): any[] {
  const healthEmoji = (score: number): string =>
    score >= 90 ? "≡ƒƒó" : score >= 75 ? "≡ƒƒí" : score >= 60 ? "≡ƒƒá" : "≡ƒö┤";
  const hasAbsoluteDashboardUrl = /^https?:\/\//i.test(DIGEST_DASHBOARD_LINK);

  const sections = data.business_sections.map((section) => ({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*${section.title}*\n- Total: *${section.total}* (Leads ${section.leads} / Deals ${section.deals})\n- New: *${section.new_in_window}*\n- Progressed: *${section.progressed}* | Stalled: *${section.stalled}*\n- Severity: C *${section.severity_counts.critical}* / H *${section.severity_counts.high}* / M *${section.severity_counts.medium}* / L *${section.severity_counts.low}*\n- Health: ${healthEmoji(section.health_score)} *${section.health_score}%*`,
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
        text: `≡ƒôè ${cadenceLabel(data.cadence)} Executive Digest`,
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
          text: `Generated: ${new Date(data.generated_at).toLocaleString("en-GB", { timeZone: "Asia/Riyadh" })} (KSA)`,
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
          text: `*Severity*\nC ${data.business_overview.severity_counts.critical} - H ${data.business_overview.severity_counts.high} - M ${data.business_overview.severity_counts.medium} - L ${data.business_overview.severity_counts.low}`,
        },
        {
          type: "mrkdwn",
          text: `*Audit Snapshot*\nScore ${data.audit_summary.last_score !== null ? `${data.audit_summary.last_score}%` : "N/A"} - Trend ${data.audit_summary.trend}`,
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
              ? `*All Finding Types (${data.finding_types.length})*\n${chunk}`
              : `*All Finding Types (continued ${idx + 1})*\n${chunk}`,
        },
      });
    });
  }
  return blocks;
}

function resolveSlackChannel(cadence: DigestCadence, override?: string): string | null {
  if (override) return override;
  if (cadence === "monthly" && process.env.DIGEST_SLACK_CHANNEL_MONTHLY)
    return process.env.DIGEST_SLACK_CHANNEL_MONTHLY;
  if (cadence === "quarterly" && process.env.DIGEST_SLACK_CHANNEL_QUARTERLY)
    return process.env.DIGEST_SLACK_CHANNEL_QUARTERLY;
  if (cadence === "weekly" && process.env.DIGEST_SLACK_CHANNEL_WEEKLY)
    return process.env.DIGEST_SLACK_CHANNEL_WEEKLY;
  return (
    process.env.DIGEST_SLACK_CHANNEL ||
    process.env.SLACK_CHANNEL_ID ||
    process.env.SLACK_QMS_CHANNEL ||
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
    if (process.env.RESEND_API_KEY) {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: process.env.RESEND_FROM || "WalaPlus QMS <noreply@walaplus.com>",
          to: recipientEmail,
          subject: `${cadenceLabel(cadence)} Quality Digest ΓÇö ${new Date().toLocaleDateString()}`,
          html,
        }),
      });
      if (response.ok) {
        await recordDigestRun({ runKey, cadence, channel: "email", window, status: "success" });
        return { success: true, method: "resend", runKey, cadence };
      }
    }
  } catch (err) {
    logger.warn("[Digest][email] Resend branch failed, trying fallback", {
      error: err instanceof Error ? err.message : String(err),
      runKey,
    });
  }

  try {
    const mailUrl = `https://${process.env.REPL_SLUG || "qms"}.${process.env.REPL_OWNER || "user"}.repl.co/__repl_mail/send`;
    const response = await fetch(mailUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: recipientEmail,
        subject: `${cadenceLabel(cadence)} Quality Digest ΓÇö ${new Date().toLocaleDateString()}`,
        html,
      }),
    });
    if (response.ok) {
      await recordDigestRun({ runKey, cadence, channel: "email", window, status: "success" });
      return { success: true, method: "replit_mail", runKey, cadence };
    }
  } catch (err) {
    logger.warn("[Digest][email] Replit mail branch failed", {
      error: err instanceof Error ? err.message : String(err),
      runKey,
    });
  }

  const error = "No email service available";
  await recordDigestRun({ runKey, cadence, channel: "email", window, status: "failed", error });
  return { success: false, error, runKey, cadence };
}

export async function sendDigestSlack(
  options: DigestSendOptions = {},
): Promise<DigestSendResult> {
  const cadence = options.cadence || "weekly";
  const window = options.window || computeDigestWindow(cadence, options.now || new Date());
  const runKey = buildDigestRunKey(cadence, window, "slack");

  const slackEnabled = envBool("DIGEST_SLACK_NOTIFY", true);
  if (!slackEnabled) {
    return { success: true, skipped: true, method: "slack-disabled", runKey, cadence };
  }

  const hasSlackCreds = !!(process.env.SLACK_BOT_TOKEN || process.env.SLACK_API_TOKEN);
  if (!hasSlackCreds) {
    return {
      success: true,
      skipped: true,
      method: "slack-no-credentials",
      runKey,
      cadence,
    };
  }

  const channel = resolveSlackChannel(cadence, options.channelOverride);
  if (!channel) {
    return { success: true, skipped: true, method: "slack-no-channel", runKey, cadence };
  }

  if (options.enforceIdempotency !== false && (await hasSuccessfulDigestRun(runKey))) {
    return {
      success: true,
      skipped: true,
      method: "slack-idempotent",
      runKey,
      cadence,
      windowStart: window.start.toISOString(),
      windowEnd: window.end.toISOString(),
    };
  }

  const data = await generateDigestData({ cadence, window, now: options.now });
  const blocks = buildDigestSlackBlocks(data);
  const fallback = `${cadenceLabel(cadence)} executive digest (${data.period})`;

  if (options.preview) {
    return {
      success: true,
      preview: true,
      blocks,
      method: "slack-preview",
      runKey,
      cadence,
      windowStart: window.start.toISOString(),
      windowEnd: window.end.toISOString(),
    };
  }

  const sent = await sendSlackNotification(channel, fallback, blocks);
  if (sent) {
    await recordDigestRun({ runKey, cadence, channel: "slack", window, status: "success" });
    return { success: true, method: "slack", runKey, cadence };
  }

  const error = "Slack delivery failed";
  await recordDigestRun({ runKey, cadence, channel: "slack", window, status: "failed", error });
  return { success: false, error, runKey, cadence };
}

export async function runDigestFanout(
  cadence: DigestCadence,
  options: DigestSendOptions = {},
): Promise<DigestFanoutResult> {
  const now = options.now || new Date();
  const window = options.window || computeDigestWindow(cadence, now);
  const [emailResult, slackResult] = await Promise.allSettled([
    sendDigestEmail({ ...options, cadence, now, window }),
    sendDigestSlack({ ...options, cadence, now, window }),
  ]);
  const email =
    emailResult.status === "fulfilled"
      ? emailResult.value
      : ({ success: false, error: emailResult.reason ? String(emailResult.reason) : "email fanout failed" } as DigestSendResult);
  const slack =
    slackResult.status === "fulfilled"
      ? slackResult.value
      : ({ success: false, error: slackResult.reason ? String(slackResult.reason) : "slack fanout failed" } as DigestSendResult);
  return { cadence, window, email, slack };
}

export async function getDigestDeliveryHealth(
  cadence: DigestCadence = "weekly",
  now = new Date(),
): Promise<DigestDeliveryHealth> {
  const window = computeDigestWindow(cadence, now);
  const runKeySlack = buildDigestRunKey(cadence, window, "slack");
  const runKeyEmail = buildDigestRunKey(cadence, window, "email");
  const slackEnabled = envBool("DIGEST_SLACK_NOTIFY", true);
  const directAuditSlackEnabled = envBool("DIRECT_AUDIT_SLACK_NOTIFY", true);
  const hasSlackCredentials = !!(
    process.env.SLACK_BOT_TOKEN || process.env.SLACK_API_TOKEN
  );
  const slackChannelResolved = resolveSlackChannel(cadence);
  const hasDigestEmailRecipient = !!(
    process.env.QUALITY_DIGEST_EMAIL || process.env.ADMIN_EMAIL
  );
  const [idempotentRunExistsSlack, idempotentRunExistsEmail] = await Promise.all([
    hasSuccessfulDigestRun(runKeySlack),
    hasSuccessfulDigestRun(runKeyEmail),
  ]);
  return {
    cadence,
    window_start: window.start.toISOString(),
    window_end: window.end.toISOString(),
    run_key_slack: runKeySlack,
    run_key_email: runKeyEmail,
    slack_enabled: slackEnabled,
    direct_audit_slack_enabled: directAuditSlackEnabled,
    has_slack_credentials: hasSlackCredentials,
    slack_channel_resolved: slackChannelResolved,
    has_digest_email_recipient: hasDigestEmailRecipient,
    idempotent_run_exists_slack: idempotentRunExistsSlack,
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
