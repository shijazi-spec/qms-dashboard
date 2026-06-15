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
import {
  analyzeRecordHygiene,
  DEFAULT_GOVERNANCE_RULES,
  fetchDealStageHistory,
} from "./zohoCRM";

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

/** Hygiene "clean" share: records with zero governance issues ÷ total. */
function cleanShare(rawRecords: any[], module: "Leads" | "Deals"): ProcessKpiValue {
  if (rawRecords.length === 0) return EMPTY;
  let clean = 0;
  for (const raw of rawRecords) {
    const issues = analyzeRecordHygiene(
      { id: String(raw.id || ""), module, data: raw } as any,
      DEFAULT_GOVERNANCE_RULES,
    );
    if (issues.length === 0) clean++;
  }
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
    if (/agreement signed|paid|closed won/.test(s)) signed++;
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
