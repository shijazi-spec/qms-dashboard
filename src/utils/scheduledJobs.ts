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
import { sharedPool } from "./sharedPool";

import { logger } from "./logger";
const RATE_LIMIT_429_RETENTION_HOURS = (() => {
  const raw = process.env.RATE_LIMIT_429_RETENTION_HOURS;
  const parsed = parseInt(raw ?? "24", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 24;
})();

export interface KPIAutoCalcResult {
  calculated: number;
  results: Array<{
    kpi: string;
    matched?: string;
    value?: number;
    status: "recorded" | "no_matching_definition" | "failed";
    error?: string;
  }>;
}

export async function runKPIAutoCalc(): Promise<KPIAutoCalcResult> {
  logger.info("[KPI Auto] Daily KPI calculation triggered");
  const results: KPIAutoCalcResult["results"] = [];
  try {
    const {
      calculateKPI1_GovernanceDocLifecycle,
      calculateKPI2_ComplianceObligationTracking,
      calculateKPI3_AuditEvidencePackReadiness,
      calculateKPI4_QualityGRCHandoff,
      calculateKPI5_RiskRegisterHygiene,
      calculateKPI6_ExecutiveReportingReadiness,
    } = await import("./scorecardDatabase");
    const { recordKPIValue, getAllKPIDefinitions } =
      await import("./kpiDatabase");

    const calculators = [
      {
        keywords: ["governance", "lifecycle", "doc"],
        fn: calculateKPI1_GovernanceDocLifecycle,
        label: "Governance Doc Lifecycle",
      },
      {
        keywords: ["compliance", "obligation"],
        fn: calculateKPI2_ComplianceObligationTracking,
        label: "Compliance Obligation Tracking",
      },
      {
        keywords: ["audit", "evidence", "readiness"],
        fn: calculateKPI3_AuditEvidencePackReadiness,
        label: "Audit Evidence Pack Readiness",
      },
      {
        keywords: ["handoff", "quality"],
        fn: calculateKPI4_QualityGRCHandoff,
        label: "Quality-GRC Handoff",
      },
      {
        keywords: ["risk", "register", "hygiene"],
        fn: calculateKPI5_RiskRegisterHygiene,
        label: "Risk Register Hygiene",
      },
      {
        keywords: ["executive", "reporting"],
        fn: calculateKPI6_ExecutiveReportingReadiness,
        label: "Executive Reporting Readiness",
      },
    ];

    const kpiDefs = await getAllKPIDefinitions();
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    for (const calc of calculators) {
      try {
        const { value } = await calc.fn();
        const matchingKpi =
          kpiDefs.find((k: any) => {
            const name = (k.kpi_name || "").toLowerCase();
            return calc.keywords.every((kw) => name.includes(kw));
          }) ||
          kpiDefs.find((k: any) => {
            const name = (k.kpi_name || "").toLowerCase();
            return calc.keywords.some((kw) => name.includes(kw));
          });
        if (matchingKpi) {
          await recordKPIValue({
            kpi_id: matchingKpi.id!,
            actual_value: value,
            period_start: periodStart,
            period_end: periodEnd,
            status: "green", // recordKPIValue recomputes from thresholds
            calculated_by: "system",
            override_reason: `Auto-calculated by scheduled job`,
          } as any);
          results.push({
            kpi: calc.label,
            matched: matchingKpi.kpi_name,
            value,
            status: "recorded",
          });
        } else {
          results.push({
            kpi: calc.label,
            value,
            status: "no_matching_definition",
          });
        }
      } catch (err) {
        results.push({ kpi: calc.label, error: String(err), status: "failed" });
      }
    }
  } catch (err) {
    logger.error("[KPI Auto] Fatal error:", err);
  }
  logger.info("[KPI Auto] Completed:", results);
  return { calculated: results.length, results };
}

/**
 * Returns hours since the most recent KPI value across all KPIs, or
 * Infinity if none exist.
 */
export async function hoursSinceLatestKPI(): Promise<number> {
  try {
    const r = await kpiPool.query(
      `SELECT EXTRACT(EPOCH FROM (NOW() - MAX(updated_at))) / 3600 AS hours FROM kpi_values`,
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
       FROM duplicate_clusters`,
    );
    const h = r.rows[0]?.hours;
    return h == null ? Infinity : Number(h);
  } catch {
    return Infinity;
  }
}

export async function runDuplicateScanIfStale(
  maxAgeHours = 6,
): Promise<{ ran: boolean; ageHours: number; result?: any }> {
  const ageHours = await hoursSinceLastDuplicateScan();
  if (ageHours < maxAgeHours) {
    return { ran: false, ageHours };
  }
  logger.info(
    `[DuplicateRadar Fallback] Last scan was ${ageHours.toFixed(1)}h ago (>= ${maxAgeHours}h); kicking off scan.`,
  );
  try {
    const { scanZohoCRMForDuplicates } =
      await import("../mastra/routes/duplicateRadarRoutes");
    const result = await scanZohoCRMForDuplicates("interval-fallback");
    return { ran: true, ageHours, result };
  } catch (err) {
    logger.error("[DuplicateRadar Fallback] Scan failed:", err);
    return { ran: false, ageHours };
  }
}

/**
 * Hours since the most recent CS-pipeline overlap classification.
 * Returns Infinity when no cluster has ever been classified.
 */
export async function hoursSinceLastCsOverlapScan(): Promise<number> {
  try {
    const r = await kpiPool.query(
      `SELECT EXTRACT(EPOCH FROM (NOW() - MAX(updated_at))) / 3600 AS hours
         FROM duplicate_clusters
        WHERE cs_overlap_verdict IS NOT NULL`,
    );
    const h = r.rows[0]?.hours;
    return h == null ? Infinity : Number(h);
  } catch {
    return Infinity;
  }
}

/**
 * In-process fallback for the CS-pipeline overlap nightly scan.
 *
 * The Inngest cron `duplicate-radar-cs-overlap-scan` is the primary driver
 * (default 03:30 UTC daily). This helper re-runs the scan when no cluster
 * has been re-classified in the last `maxAgeHours` (defaults 25h to keep one
 * hour of slack after the cron fire).
 *
 * Idempotent — safe to call on any interval.
 */
export async function runCsOverlapScanIfStale(
  maxAgeHours = 25,
): Promise<{ ran: boolean; ageHours: number; result?: any }> {
  const ageHours = await hoursSinceLastCsOverlapScan();
  if (ageHours < maxAgeHours) {
    return { ran: false, ageHours };
  }
  logger.info(
    `[CsOverlap Fallback] Last classification was ${ageHours === Infinity ? "never" : ageHours.toFixed(1) + "h ago"} (>= ${maxAgeHours}h); running scan.`,
  );
  try {
    const { scanAllClustersForCsOverlap, initDuplicateRadarTables } =
      await import("./duplicateRadarDatabase");
    await initDuplicateRadarTables();
    const result = await scanAllClustersForCsOverlap();
    return { ran: true, ageHours, result };
  } catch (err) {
    logger.error("[CsOverlap Fallback] Scan failed:", err);
    return { ran: false, ageHours };
  }
}

export async function runKPIAutoCalcIfStale(
  maxAgeHours = 24,
): Promise<{ ran: boolean; ageHours: number; result?: KPIAutoCalcResult }> {
  const ageHours = await hoursSinceLatestKPI();
  if (ageHours < maxAgeHours) {
    return { ran: false, ageHours };
  }
  logger.info(
    `[KPI Auto Fallback] Last KPI value was ${ageHours === Infinity ? "never" : ageHours.toFixed(1) + "h ago"}; running calc.`,
  );
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
       FROM quality_audit_results`,
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
export async function runQualityAuditIfStale(
  maxAgeHours = 168,
): Promise<{ ran: boolean; ageHours: number; result?: any }> {
  const ageHours = await hoursSinceLastQualityAudit();
  if (ageHours < maxAgeHours) {
    return { ran: false, ageHours };
  }
  logger.info(
    `[QualityAudit Fallback] Last audit was ${ageHours === Infinity ? "never" : ageHours.toFixed(1) + "h ago"} (>= ${maxAgeHours}h); running audit.`,
  );
  try {
    const { runDirectAudit } = await import("./directAuditRunner");
    const result = await runDirectAudit();
    return { ran: true, ageHours, result };
  } catch (err) {
    logger.error("[QualityAudit Fallback] Audit failed:", err);
    return { ran: false, ageHours };
  }
}

/**
 * Run the AI Consultant background scanner if the last run is older than
 * `maxAgeHours`. This is the in-process safety net for the
 * `ai-background-scanner` Inngest cron when Inngest dispatch is unreachable
 * (mirrors the same pattern used for the quality audit).
 *
 * "Last run" is tracked in a tiny `scanner_run_log` table that the function
 * creates on first call so we don't depend on alerts existing (alerts only
 * fire when issues are found, which would mask a successful clean scan).
 */

/**
 * Hours since the oldest surviving `rate_limit_429` row in `system_events`.
 * Returns Infinity when the table has no such rows (nothing to prune).
 * Returns 0 when the table is unreachable so we don't trigger a spurious run.
 */
export async function hoursSinceOldestRateLimit429(): Promise<number> {
  try {
    const r = await sharedPool.query<{ hours: number | null }>(
      `SELECT EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))/3600 AS hours
       FROM system_events WHERE event_type = 'rate_limit_429'`,
    );
    const h = r.rows[0]?.hours;
    return h == null ? Infinity : Number(h);
  } catch {
    return 0;
  }
}

/**
 * In-process safety-net for the `rate-limit-429-events-pruner` Inngest cron.
 *
 * Calls `pruneRateLimit429Events()` when the oldest surviving `rate_limit_429`
 * row in `system_events` is older than `retentionHours + gracePeriodHours`.
 * The default grace period (1h) matches the health-pulse threshold so both
 * signals fire in lockstep.
 *
 * Mirror of `runConsultantScannerIfStale` / `runDuplicateScanIfStale`.
 */
export async function runPruneRateLimit429IfStale(
  retentionHours = RATE_LIMIT_429_RETENTION_HOURS,
  gracePeriodHours = 1,
): Promise<{ ran: boolean; ageHours: number; result?: any }> {
  const maxAgeHours = retentionHours + gracePeriodHours;
  const ageHours = await hoursSinceOldestRateLimit429();
  if (ageHours < maxAgeHours) {
    return { ran: false, ageHours };
  }
  logger.info(
    `[RateLimit429Pruner Fallback] Oldest rate_limit_429 row is ${
      ageHours === Infinity
        ? "absent (table empty — nothing to prune)"
        : ageHours.toFixed(1) + "h old"
    } (threshold ${maxAgeHours}h); running pruner.`,
  );
  if (ageHours === Infinity) {
    return { ran: false, ageHours };
  }
  try {
    const { pruneRateLimit429Events } = await import("./rateLimiter");
    const result = await pruneRateLimit429Events();
    return { ran: true, ageHours, result };
  } catch (err) {
    logger.error("[RateLimit429Pruner Fallback] Pruner failed:", err);
    return { ran: false, ageHours };
  }
}

export async function runConsultantScannerIfStale(
  maxAgeHours = 6,
): Promise<{ ran: boolean; ageHours: number; result?: any }> {
  const pool = sharedPool;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scanner_run_log (
      id SERIAL PRIMARY KEY,
      scanner_name VARCHAR(100) NOT NULL,
      ran_at TIMESTAMP NOT NULL DEFAULT NOW(),
      success BOOLEAN NOT NULL DEFAULT true,
      summary JSONB
    );
    CREATE INDEX IF NOT EXISTS idx_scanner_run_log_name_time ON scanner_run_log(scanner_name, ran_at DESC);
  `);
  const r = await pool.query<{ hours: number | null }>(
    `SELECT EXTRACT(EPOCH FROM (NOW() - MAX(ran_at)))/3600 AS hours
     FROM scanner_run_log WHERE scanner_name='ai-background-scanner' AND success=true`,
  );
  const ageHours =
    r.rows[0]?.hours == null ? Infinity : Number(r.rows[0].hours);
  if (ageHours < maxAgeHours) {
    return { ran: false, ageHours };
  }
  logger.info(
    `[AIScanner Fallback] Last scan was ${ageHours === Infinity ? "never" : ageHours.toFixed(1) + "h ago"} (>= ${maxAgeHours}h); running scan.`,
  );
  try {
    const { runBackgroundScan } = await import("./aiBackgroundScanner");
    const result = await runBackgroundScan();
    await pool.query(
      `INSERT INTO scanner_run_log (scanner_name, success, summary) VALUES ($1, true, $2)`,
      ["ai-background-scanner", JSON.stringify(result || {})],
    );
    return { ran: true, ageHours, result };
  } catch (err) {
    logger.error("[AIScanner Fallback] Scan failed:", err);
    await pool.query(
      `INSERT INTO scanner_run_log (scanner_name, success, summary) VALUES ($1, false, $2)`,
      ["ai-background-scanner", JSON.stringify({ error: String(err) })],
    );
    return { ran: false, ageHours };
  }
}
