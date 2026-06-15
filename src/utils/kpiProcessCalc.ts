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
import { analyzeRecordHygiene, DEFAULT_GOVERNANCE_RULES } from "./zohoCRM";

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
 * Map of canonical SDR/Sales KPI code → calculator. Codes NOT listed here have no
 * safe local source yet (e.g. Calls/Tasks-module KPIs, stage-history cycle times)
 * and are intentionally left to show "--".
 */
export const PROCESS_CALCULATORS: Record<
  string,
  () => Promise<ProcessKpiValue>
> = {
  // SDR
  "SDR-KPI-03": calcSdrQualificationRate,
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
export async function computeProcessKPIs(): Promise<
  Record<string, ProcessKpiValue>
> {
  const out: Record<string, ProcessKpiValue> = {};
  for (const [code, fn] of Object.entries(PROCESS_CALCULATORS)) {
    try {
      out[code] = await fn();
    } catch (e) {
      logger.error(`[KPIProcessCalc] ${code} failed: ${(e as Error).message}`);
      out[code] = EMPTY;
    }
  }
  return out;
}
