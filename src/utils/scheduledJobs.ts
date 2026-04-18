/**
 * Shared scheduled-job runners.
 *
 * Both the Inngest cron triggers and the in-process interval fallback
 * (registered in src/mastra/index.ts) call into these functions, so the
 * actual work is defined exactly once. The fallback exists because the
 * Inngest dev server is not always driving the local dev process, and
 * production runners have occasionally missed cron fires — leaving the
 * Duplicate Radar stale for 5+ days at a time.
 */

import { pool as kpiPool } from "./kpiDatabase";

export interface KPIAutoCalcResult {
  calculated: number;
  results: Array<{
    kpi: string;
    matched?: string;
    value?: number;
    status: 'recorded' | 'no_matching_definition' | 'failed';
    error?: string;
  }>;
}

export async function runKPIAutoCalc(): Promise<KPIAutoCalcResult> {
  console.log("[KPI Auto] Daily KPI calculation triggered");
  const results: KPIAutoCalcResult['results'] = [];
  try {
    const {
      calculateKPI1_GovernanceDocLifecycle,
      calculateKPI2_ComplianceObligationTracking,
      calculateKPI3_AuditEvidencePackReadiness,
      calculateKPI4_QualityGRCHandoff,
      calculateKPI5_RiskRegisterHygiene,
      calculateKPI6_ExecutiveReportingReadiness,
    } = await import("./scorecardDatabase");
    const { recordKPIValue, getAllKPIDefinitions } = await import("./kpiDatabase");

    const calculators = [
      { keywords: ['governance', 'lifecycle', 'doc'], fn: calculateKPI1_GovernanceDocLifecycle, label: 'Governance Doc Lifecycle' },
      { keywords: ['compliance', 'obligation'], fn: calculateKPI2_ComplianceObligationTracking, label: 'Compliance Obligation Tracking' },
      { keywords: ['audit', 'evidence', 'readiness'], fn: calculateKPI3_AuditEvidencePackReadiness, label: 'Audit Evidence Pack Readiness' },
      { keywords: ['handoff', 'quality'], fn: calculateKPI4_QualityGRCHandoff, label: 'Quality-GRC Handoff' },
      { keywords: ['risk', 'register', 'hygiene'], fn: calculateKPI5_RiskRegisterHygiene, label: 'Risk Register Hygiene' },
      { keywords: ['executive', 'reporting'], fn: calculateKPI6_ExecutiveReportingReadiness, label: 'Executive Reporting Readiness' },
    ];

    const kpiDefs = await getAllKPIDefinitions();
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    for (const calc of calculators) {
      try {
        const { value } = await calc.fn();
        const matchingKpi = kpiDefs.find((k: any) => {
          const name = (k.kpi_name || '').toLowerCase();
          return calc.keywords.every((kw) => name.includes(kw));
        }) || kpiDefs.find((k: any) => {
          const name = (k.kpi_name || '').toLowerCase();
          return calc.keywords.some((kw) => name.includes(kw));
        });
        if (matchingKpi) {
          await recordKPIValue({
            kpi_id: matchingKpi.id!,
            actual_value: value,
            period_start: periodStart,
            period_end: periodEnd,
            status: 'green', // recordKPIValue recomputes from thresholds
            calculated_by: 'system',
            override_reason: `Auto-calculated by scheduled job`,
          } as any);
          results.push({ kpi: calc.label, matched: matchingKpi.kpi_name, value, status: 'recorded' });
        } else {
          results.push({ kpi: calc.label, value, status: 'no_matching_definition' });
        }
      } catch (err) {
        results.push({ kpi: calc.label, error: String(err), status: 'failed' });
      }
    }
  } catch (err) {
    console.error("[KPI Auto] Fatal error:", err);
  }
  console.log("[KPI Auto] Completed:", results);
  return { calculated: results.length, results };
}

/**
 * Returns hours since the most recent KPI value across all KPIs, or
 * Infinity if none exist.
 */
export async function hoursSinceLatestKPI(): Promise<number> {
  try {
    const r = await kpiPool.query(
      `SELECT EXTRACT(EPOCH FROM (NOW() - MAX(updated_at))) / 3600 AS hours FROM kpi_values`
    );
    const h = r.rows[0]?.hours;
    return h == null ? Infinity : Number(h);
  } catch {
    return Infinity;
  }
}

/**
 * Returns hours since the last successful Duplicate Radar scan.
 */
export async function hoursSinceLastDuplicateScan(): Promise<number> {
  // Same source the Platform Health Pulse uses for `duplicate_radar_freshness`.
  try {
    const r = await kpiPool.query(
      `SELECT EXTRACT(EPOCH FROM (NOW() - MAX(updated_at))) / 3600 AS hours
       FROM duplicate_clusters`
    );
    const h = r.rows[0]?.hours;
    return h == null ? Infinity : Number(h);
  } catch {
    return Infinity;
  }
}

export async function runDuplicateScanIfStale(maxAgeHours = 6): Promise<{ ran: boolean; ageHours: number; result?: any }> {
  const ageHours = await hoursSinceLastDuplicateScan();
  if (ageHours < maxAgeHours) {
    return { ran: false, ageHours };
  }
  console.log(`[DuplicateRadar Fallback] Last scan was ${ageHours.toFixed(1)}h ago (>= ${maxAgeHours}h); kicking off scan.`);
  try {
    const { scanZohoCRMForDuplicates } = await import("../mastra/routes/duplicateRadarRoutes");
    const result = await scanZohoCRMForDuplicates('interval-fallback');
    return { ran: true, ageHours, result };
  } catch (err) {
    console.error("[DuplicateRadar Fallback] Scan failed:", err);
    return { ran: false, ageHours };
  }
}

export async function runKPIAutoCalcIfStale(maxAgeHours = 24): Promise<{ ran: boolean; ageHours: number; result?: KPIAutoCalcResult }> {
  const ageHours = await hoursSinceLatestKPI();
  if (ageHours < maxAgeHours) {
    return { ran: false, ageHours };
  }
  console.log(`[KPI Auto Fallback] Last KPI value was ${ageHours === Infinity ? 'never' : ageHours.toFixed(1) + 'h ago'}; running calc.`);
  const result = await runKPIAutoCalc();
  return { ran: true, ageHours, result };
}

/**
 * Returns hours since the last successful Quality Audit.
 */
export async function hoursSinceLastQualityAudit(): Promise<number> {
  try {
    const r = await kpiPool.query(
      `SELECT EXTRACT(EPOCH FROM (NOW() - MAX(created_at))) / 3600 AS hours
       FROM quality_audit_results`
    );
    const h = r.rows[0]?.hours;
    return h == null ? Infinity : Number(h);
  } catch {
    return Infinity;
  }
}

/**
 * Run a fresh quality audit if the latest one is older than `maxAgeHours`.
 * Without this, Zoho data changes (merges, edits, completed records) only
 * appear on the dashboard when someone manually triggers an audit.
 */
export async function runQualityAuditIfStale(maxAgeHours = 6): Promise<{ ran: boolean; ageHours: number; result?: any }> {
  const ageHours = await hoursSinceLastQualityAudit();
  if (ageHours < maxAgeHours) {
    return { ran: false, ageHours };
  }
  console.log(`[QualityAudit Fallback] Last audit was ${ageHours === Infinity ? 'never' : ageHours.toFixed(1) + 'h ago'} (>= ${maxAgeHours}h); running audit.`);
  try {
    const { runDirectAudit } = await import("./directAuditRunner");
    const result = await runDirectAudit();
    return { ran: true, ageHours, result };
  } catch (err) {
    console.error("[QualityAudit Fallback] Audit failed:", err);
    return { ran: false, ageHours };
  }
}
