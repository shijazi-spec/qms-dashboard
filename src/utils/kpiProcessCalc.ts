/**
 * SDR + Sales KPI process calculators (Phase B + C).
 *
 * IMPORTANT — these read ONLY the Duplicate Radar's already-synced LOCAL tables
 * (`duplicate_records.raw_data` holds the full Zoho JSON per record, plus the
 * `deal_doc_compliance` scan table). They do NOT make live Zoho API calls, so a
 * recalc can never freeze the platform on a 50k-record pull (a recurring hazard).
 * Coverage is therefore whatever the Radar has synced.
 *
 * Each calculator returns { value, dataAvailable, details }. When the source is
 * empty we return dataAvailable:false so the KPI stays "--" rather than a fake 0.
 */
import { logger } from "./logger";
import {
  pool,
  getDealDocCompliance,
  scanDealStageAgingViolations,
} from "./duplicateRadarDatabase";
import { fetchDealStageHistory } from "./zohoCRM";
import { getAllFrameworkCoverage } from "./obligationDocumentsDatabase";

export interface ProcessKpiValue {
  value: number;
  dataAvailable: boolean;
  details?: Record<string, unknown>;
}

const EMPTY: ProcessKpiValue = { value: 0, dataAvailable: false };

/** Read a Zoho string-or-{name} field off a raw record. */
function readField(v: any): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "object" && typeof v.name === "string")
    return v.name.trim() || null;
  return null;
}

/** All locally-synced raw records for a module (full Zoho JSON each). */
async function localRawRecords(
  module: string,
  limit = 60000,
): Promise<any[]> {
  const res = await pool.query(
    `SELECT raw_data FROM duplicate_records WHERE zoho_module = $1 LIMIT $2`,
    [module, limit],
  );
  return res.rows.map((r: any) => r.raw_data || {});
}

/** True if a Zoho field (string or {name}) has a non-empty value on the record. */
function hasField(raw: any, field: string): boolean {
  const v = raw?.[field];
  if (v == null) return false;
  if (typeof v === "object") return String(v.name ?? "").trim() !== "";
  return String(v).trim() !== "";
}

// CRM Data Accuracy = share of records that carry their CORE operational fields.
// Deliberately NOT the full DEFAULT_GOVERNANCE_RULES (which require enrichment
// fields like City/Industry/Description that are essentially never filled →
// 0% clean and useless as a trend KPI). Full-governance compliance lives on the
// Quality Dashboard AI Audit. Core fields confirmed against the live data
// distribution (2026-06-16). Easy to extend if the team adds required fields.
const LEAD_CORE_REQUIRED = ["First_Name", "Lead_Source", "Lead_Status"];
const DEAL_CORE_REQUIRED = ["Stage", "Amount", "Account_Name", "Closing_Date"];

function leadIsClean(raw: any): boolean {
  // Contactable = phone OR email (requiring both is too strict for the data).
  const contactable = hasField(raw, "Phone") || hasField(raw, "Email");
  return contactable && LEAD_CORE_REQUIRED.every((f) => hasField(raw, f));
}

function dealIsClean(raw: any): boolean {
  return DEAL_CORE_REQUIRED.every((f) => hasField(raw, f));
}

/** Core-field "clean" share ÷ total. */
function cleanShare(rawRecords: any[], module: "Leads" | "Deals"): ProcessKpiValue {
  if (rawRecords.length === 0) return EMPTY;
  const isClean = module === "Leads" ? leadIsClean : dealIsClean;
  let clean = 0;
  for (const raw of rawRecords) if (isClean(raw)) clean++;
  const value = Math.round((clean / rawRecords.length) * 1000) / 10;
  return { value, dataAvailable: true, details: { clean, total: rawRecords.length } };
}

/** Days between an ISO date and now (calendar). */
function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / 86400000;
}

// ─────────────────────────────── SDR ────────────────────────────────────────

/** SDR-KPI-09 Duplicate Rate — non-primary Leads in multi-record clusters ÷ all Leads. */
export async function calcSdrDuplicateRate(): Promise<ProcessKpiValue> {
  const res = await pool.query(
    `WITH lead_clusters AS (
       SELECT cluster_id FROM duplicate_records
        WHERE zoho_module = 'Leads' AND cluster_id IS NOT NULL
        GROUP BY cluster_id HAVING COUNT(*) > 1
     )
     SELECT
       (SELECT COUNT(*) FROM duplicate_records WHERE zoho_module = 'Leads')::int AS total,
       (SELECT COUNT(*) FROM duplicate_records r
          JOIN lead_clusters lc ON r.cluster_id = lc.cluster_id
         WHERE r.zoho_module = 'Leads' AND r.is_primary = false)::int AS dups`,
  );
  const total = Number(res.rows[0]?.total || 0);
  const dups = Number(res.rows[0]?.dups || 0);
  if (total === 0) return EMPTY;
  return {
    value: Math.round((dups / total) * 1000) / 10,
    dataAvailable: true,
    details: { duplicate_leads: dups, total_leads: total },
  };
}

/** SDR-KPI-08 CRM Data Accuracy (SDR) — clean Leads ÷ total Leads. */
export async function calcSdrCrmAccuracy(): Promise<ProcessKpiValue> {
  return cleanShare(await localRawRecords("Leads"), "Leads");
}

/** Classify a lead status into funnel buckets from its raw Lead_Status. */
function leadFunnel(raw: any): { contacted: boolean; qualified: boolean; junk: boolean } {
  const s = (readField(raw.Lead_Status) || "").toLowerCase();
  const junk = /junk|lost|invalid|not interested|unqualified|not qualified/.test(s);
  const qualified = !junk && /qualified|converted|opportunity|won/.test(s);
  // "contacted" = anything past the brand-new/untouched state.
  const isNew = s === "" || /new|untouched|not contacted|fresh/.test(s);
  const contacted = !isNew;
  return { contacted, qualified, junk };
}

/** SDR-KPI-07 Lead-to-Qualified Conversion — qualified ÷ all leads. */
export async function calcSdrLeadToQualified(): Promise<ProcessKpiValue> {
  const recs = await localRawRecords("Leads");
  if (recs.length === 0) return EMPTY;
  let qualified = 0;
  for (const r of recs) if (leadFunnel(r).qualified) qualified++;
  return {
    value: Math.round((qualified / recs.length) * 1000) / 10,
    dataAvailable: true,
    details: { qualified, total: recs.length },
  };
}

/** SDR-KPI-03 Qualification Rate — qualified ÷ contacted leads. */
export async function calcSdrQualificationRate(): Promise<ProcessKpiValue> {
  const recs = await localRawRecords("Leads");
  let contacted = 0;
  let qualified = 0;
  for (const r of recs) {
    const f = leadFunnel(r);
    if (f.contacted) contacted++;
    if (f.qualified) qualified++;
  }
  if (contacted === 0) return EMPTY;
  return {
    value: Math.round((qualified / contacted) * 1000) / 10,
    dataAvailable: true,
    details: { qualified, contacted },
  };
}

/** SDR-KPI-10 Pipeline Aging — avg days leads sit in Contacting/Contacted. */
export async function calcSdrPipelineAging(): Promise<ProcessKpiValue> {
  const recs = await localRawRecords("Leads");
  const ages: number[] = [];
  for (const r of recs) {
    const s = (readField(r.Lead_Status) || "").toLowerCase();
    if (!/contact/.test(s)) continue; // Contacting / Contacted
    const d = daysSince(r.Modified_Time || r.Created_Time);
    if (d !== null) ages.push(d);
  }
  if (ages.length === 0) return EMPTY;
  const avg = ages.reduce((a, b) => a + b, 0) / ages.length;
  return {
    value: Math.round(avg * 10) / 10,
    dataAvailable: true,
    details: { in_pipeline: ages.length },
  };
}

// ───────────────────────── SDR — Call Intelligence ──────────────────────────
// Per Sarah (2026-06-16): all SDR calls are captured in the platform's Call
// Intelligence logs (`call_records`). SDR activity = outbound calls tied to a
// Lead (SDRs work Leads; Sales works Deals). 30-day rolling window.

const CALL_WINDOW_DAYS = 30;

/** Business days (Mon–Fri) in the last N days — denominator for calls/day. */
function businessDaysInWindow(days: number): number {
  let count = 0;
  const now = Date.now();
  for (let i = 0; i < days; i++) {
    const d = new Date(now - i * 86400000).getUTCDay();
    if (d !== 0 && d !== 6) count++;
  }
  return Math.max(1, count);
}

/** SDR-KPI-01 Calls Per Day — outbound lead calls ÷ (agents × business days). */
export async function calcSdrCallsPerDay(): Promise<ProcessKpiValue> {
  const res = await pool.query(
    `SELECT COUNT(*)::int AS total, COUNT(DISTINCT agent_email)::int AS agents
       FROM call_records
      WHERE lower(coalesce(direction,'outbound')) = 'outbound' AND lead_id IS NOT NULL
        AND call_date >= NOW() - INTERVAL '${CALL_WINDOW_DAYS} days'`,
  );
  const total = Number(res.rows[0]?.total || 0);
  const agents = Math.max(1, Number(res.rows[0]?.agents || 0));
  if (total === 0) return EMPTY;
  const perDay = total / (agents * businessDaysInWindow(CALL_WINDOW_DAYS));
  return {
    value: Math.round(perDay * 10) / 10,
    dataAvailable: true,
    details: { total_calls: total, agents, window_days: CALL_WINDOW_DAYS },
  };
}

/** SDR-KPI-02 Contact Rate — connected (duration>0) ÷ total outbound lead calls. */
export async function calcSdrContactRate(): Promise<ProcessKpiValue> {
  const res = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE duration_seconds > 0)::int AS connected
       FROM call_records
      WHERE lower(coalesce(direction,'outbound')) = 'outbound' AND lead_id IS NOT NULL
        AND call_date >= NOW() - INTERVAL '${CALL_WINDOW_DAYS} days'`,
  );
  const total = Number(res.rows[0]?.total || 0);
  const connected = Number(res.rows[0]?.connected || 0);
  if (total === 0) return EMPTY;
  return {
    value: Math.round((connected / total) * 1000) / 10,
    dataAvailable: true,
    details: { connected, total },
  };
}

/** SDR-KPI-06 Average Speed to Lead — avg hours from lead creation to first call. */
export async function calcSdrSpeedToLead(): Promise<ProcessKpiValue> {
  const res = await pool.query(
    `WITH first_calls AS (
       SELECT lead_id, MIN(call_date) AS first_call
         FROM call_records
        WHERE lead_id IS NOT NULL AND call_date IS NOT NULL
        GROUP BY lead_id
     ),
     joined AS (
       SELECT fc.first_call,
              CASE WHEN dr.raw_data->>'Created_Time' ~ '^\\d{4}-\\d{2}-\\d{2}T'
                   THEN (dr.raw_data->>'Created_Time')::timestamptz END AS created
         FROM first_calls fc
         JOIN duplicate_records dr
           ON dr.zoho_module = 'Leads' AND dr.zoho_record_id = fc.lead_id
     )
     SELECT AVG(EXTRACT(EPOCH FROM (first_call - created)) / 3600.0) AS avg_hours,
            COUNT(*)::int AS n
       FROM joined
      WHERE created IS NOT NULL AND first_call >= created`,
  );
  const n = Number(res.rows[0]?.n || 0);
  const avgHours = res.rows[0]?.avg_hours;
  if (n === 0 || avgHours == null) return EMPTY;
  return {
    value: Math.round(Number(avgHours) * 10) / 10,
    dataAvailable: true,
    details: { leads_with_calls: n },
  };
}

// ────────────────────────────── SALES ───────────────────────────────────────

/** SALES-KPI-01 Deal Stage Aging Compliance — deals within SLA ÷ tracked deals. */
export async function calcSalesStageAgingCompliance(): Promise<ProcessKpiValue> {
  const scan = await scanDealStageAgingViolations({ limit: 50000 });
  const tracked = scan.summary.total_tracked_deals;
  const violations = scan.summary.total_violations;
  if (tracked === 0) return EMPTY;
  return {
    value: Math.round(((tracked - violations) / tracked) * 1000) / 10,
    dataAvailable: true,
    details: { tracked, violations, by_severity: scan.summary.by_severity },
  };
}

/** SALES-KPI-02 Conversion Rate (SQL→Signed) — signed ÷ (signed + lost). */
export async function calcSalesConversionRate(): Promise<ProcessKpiValue> {
  const recs = await localRawRecords("Deals");
  let signed = 0;
  let lost = 0;
  for (const r of recs) {
    const s = (readField(r.Stage) || "").toLowerCase();
    // Won = any "Signed" stage (covers "Signed" + "Agreement Signed"), Paid, Closed Won.
    if (/signed|paid|closed won/.test(s)) signed++;
    else if (/closed lost|junk/.test(s)) lost++;
  }
  const denom = signed + lost;
  if (denom === 0) return EMPTY;
  return {
    value: Math.round((signed / denom) * 1000) / 10,
    dataAvailable: true,
    details: { signed, lost },
  };
}

/** SALES-KPI-05 Deal Document Compliance — compliant ÷ scanned deals (deal_doc_compliance). */
export async function calcSalesDocCompliance(): Promise<ProcessKpiValue> {
  const rows = await getDealDocCompliance();
  if (rows.length === 0) return EMPTY;
  const compliant = rows.filter((r: any) => r.compliant).length;
  return {
    value: Math.round((compliant / rows.length) * 1000) / 10,
    dataAvailable: true,
    details: { compliant, checked: rows.length },
  };
}

/** SALES-KPI-06 CRM Data Accuracy (Deals) — clean Deals ÷ total Deals. */
export async function calcSalesCrmAccuracy(): Promise<ProcessKpiValue> {
  return cleanShare(await localRawRecords("Deals"), "Deals");
}

/**
 * SALES-KPI-03 Proposal Cycle Time + SALES-KPI-04 Agreement Cycle Time — from
 * Zoho Stage_History (per Sarah's choice). Zoho gives Stage_Duration (days spent
 * in each stage) directly, so no transition math. This is the ONE place that hits
 * the live Zoho API, so it is bounded to a sample of recently-modified deals that
 * have reached Proposal+; the sample size is logged (no silent truncation).
 */
const CYCLE_TIME_DEAL_CAP = 40;

export async function computeSalesCycleTimes(
  cap = CYCLE_TIME_DEAL_CAP,
): Promise<Record<string, ProcessKpiValue>> {
  const dealRows = await pool.query(
    `SELECT zoho_record_id
       FROM duplicate_records
      WHERE zoho_module = 'Deals' AND zoho_record_id IS NOT NULL
        AND lower(coalesce(raw_data->>'Stage','')) ~ '(proposal|agreement|paid|closed won)'
      ORDER BY modified_date DESC NULLS LAST
      LIMIT $1`,
    [cap],
  );
  const ids: string[] = dealRows.rows
    .map((r: any) => r.zoho_record_id)
    .filter(Boolean);

  if (ids.length === 0) {
    return { "SALES-KPI-03": EMPTY, "SALES-KPI-04": EMPTY };
  }

  const proposalDurations: number[] = [];
  const agreementDurations: number[] = [];
  let fetched = 0;

  for (const id of ids) {
    try {
      const history = await fetchDealStageHistory(id);
      fetched++;
      for (const row of history) {
        const stage = (row.Stage || "").toLowerCase();
        const dur =
          typeof row.Stage_Duration === "number"
            ? row.Stage_Duration
            : Number(row.Stage_Duration);
        if (!Number.isFinite(dur) || dur < 0) continue;
        if (stage.includes("proposal")) proposalDurations.push(dur);
        else if (stage.includes("agreement sent")) agreementDurations.push(dur);
      }
    } catch (e) {
      // One deal's history failing must not abort the sample.
      logger.error(
        `[KPIProcessCalc] stage history failed for deal ${id}: ${(e as Error).message}`,
      );
    }
  }

  logger.info(
    `[KPIProcessCalc] Sales cycle times sampled ${fetched}/${ids.length} deals ` +
      `(proposal n=${proposalDurations.length}, agreement n=${agreementDurations.length})`,
  );

  const avg = (xs: number[]): ProcessKpiValue =>
    xs.length === 0
      ? EMPTY
      : {
          value: Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10,
          dataAvailable: true,
          details: { sample: xs.length },
        };

  return {
    "SALES-KPI-03": avg(proposalDurations),
    "SALES-KPI-04": avg(agreementDurations),
  };
}

// ───────────────────────── GRC — Certification Milestones ───────────────────
/**
 * GRC-KPI-002 Certification Milestones On-Track — driven by the Document Mapping
 * "Coverage by Framework" data (per Sarah, 2026-06-16). Each certification /
 * compliance framework (COPC, ISO-27001, ISO-9001, NCA-DCC/ECC, PCI-DSS, PDPL,
 * SAMA-CSF) is a milestone; progress = clauses with ≥1 linked document. The KPI
 * = overall coverage across all frameworks (mirrors the page's "Overall
 * Document-Mapping Coverage" headline). Details carry per-framework breakdown.
 */
export async function calcCertificationMilestones(): Promise<ProcessKpiValue> {
  let frameworks;
  try {
    frameworks = await getAllFrameworkCoverage();
  } catch {
    return EMPTY;
  }
  if (!frameworks || frameworks.length === 0) return EMPTY;
  let total = 0;
  let mapped = 0;
  const byFramework: Record<string, number> = {};
  for (const f of frameworks) {
    total += Number(f.total_obligations) || 0;
    mapped += Number(f.with_evidence) || 0;
    byFramework[f.regulation_code] = Number(f.coverage_pct) || 0;
  }
  if (total === 0) return EMPTY;
  return {
    value: Math.round((mapped / total) * 1000) / 10,
    dataAvailable: true,
    details: { frameworks: frameworks.length, total_clauses: total, mapped, byFramework },
  };
}

// ───────────────────── Quality — Documentation Lifecycle ────────────────────
/**
 * QM-KPI-010 Documentation Lifecycle Compliance — driven by the Integrated QMS
 * document register (`policies` table, the /policies "Document Lifecycle" page)
 * per Sarah (2026-06-16). NOTE: this is the document REVIEW CYCLE (Draft → Review
 * → Approval → Published → Annual Review), NOT the AI Approvals Queue. Value =
 * controlled documents that completed the lifecycle (Published) AND are current
 * (review not overdue) ÷ active controlled documents.
 */
export async function calcDocumentationLifecycle(): Promise<ProcessKpiValue> {
  let res;
  try {
    res = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status NOT IN ('archived','retired'))::int AS active_total,
         COUNT(*) FILTER (WHERE status = 'published')::int AS published,
         COUNT(*) FILTER (WHERE status = 'published' AND review_date < NOW())::int AS overdue
       FROM policies`,
    );
  } catch {
    return EMPTY;
  }
  const activeTotal = Number(res.rows[0]?.active_total || 0);
  const published = Number(res.rows[0]?.published || 0);
  const overdue = Number(res.rows[0]?.overdue || 0);
  if (activeTotal === 0) return EMPTY;
  const compliant = Math.max(0, published - overdue);
  return {
    value: Math.round((compliant / activeTotal) * 1000) / 10,
    dataAvailable: true,
    details: { active_total: activeTotal, published, overdue_reviews: overdue, compliant },
  };
}

/**
 * Map of canonical SDR/Sales KPI code → LOCAL-only calculator (no Zoho calls).
 * Cycle-time KPIs (SALES-KPI-03/04) are handled separately via
 * computeSalesCycleTimes() because they hit the live Zoho API. Codes not covered
 * anywhere have no source yet and stay "--".
 */
export const PROCESS_CALCULATORS: Record<
  string,
  () => Promise<ProcessKpiValue>
> = {
  // SDR
  "SDR-KPI-01": calcSdrCallsPerDay,
  "SDR-KPI-02": calcSdrContactRate,
  "SDR-KPI-03": calcSdrQualificationRate,
  "SDR-KPI-06": calcSdrSpeedToLead,
  "SDR-KPI-07": calcSdrLeadToQualified,
  "SDR-KPI-08": calcSdrCrmAccuracy,
  "SDR-KPI-09": calcSdrDuplicateRate,
  "SDR-KPI-10": calcSdrPipelineAging,
  // Sales
  "SALES-KPI-01": calcSalesStageAgingCompliance,
  "SALES-KPI-02": calcSalesConversionRate,
  "SALES-KPI-05": calcSalesDocCompliance,
  "SALES-KPI-06": calcSalesCrmAccuracy,
  // GRC — driven by the Document Mapping framework coverage
  "GRC-KPI-002": calcCertificationMilestones,
  // Quality — driven by the Integrated QMS document lifecycle
  "QM-KPI-010": calcDocumentationLifecycle,
};

/**
 * Run every process calculator and return code → result. Each is isolated so one
 * failure (or empty source) can't abort the rest.
 */
export async function computeProcessKPIs(
  includeCycleTimes = false,
): Promise<Record<string, ProcessKpiValue>> {
  const out: Record<string, ProcessKpiValue> = {};
  for (const [code, fn] of Object.entries(PROCESS_CALCULATORS)) {
    try {
      out[code] = await fn();
    } catch (e) {
      logger.error(`[KPIProcessCalc] ${code} failed: ${(e as Error).message}`);
      out[code] = EMPTY;
    }
  }

  // Sales cycle times = the ONLY Zoho-API step (up to 40 sequential per-deal
  // history calls). Run it only in the background daily job (includeCycleTimes),
  // NOT on the interactive Recalculate button, so the button can't hang / time out.
  if (includeCycleTimes) {
    try {
      Object.assign(out, await computeSalesCycleTimes());
    } catch (e) {
      logger.error(`[KPIProcessCalc] cycle-times failed: ${(e as Error).message}`);
      out["SALES-KPI-03"] = EMPTY;
      out["SALES-KPI-04"] = EMPTY;
    }
  }

  return out;
}
