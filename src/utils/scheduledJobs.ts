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

  // Refresh the local Zoho Calls mirror BEFORE the KPI engine runs below.
  //
  // Same ordering rule as the Tasks sync that follows: SDR-KPI-01 (Calls Per
  // Day), SDR-KPI-02 (Contact Rate) and SDR-KPI-06 (Speed to Lead) read
  // `call_records`, so recalculating first would score them against yesterday's
  // calls.
  //
  // The 30-day window is not arbitrary — it matches CALL_WINDOW_DAYS in
  // kpiProcessCalc.ts, which is the window those KPIs actually measure over.
  // Syncing a shorter window would leave the KPI counting days it has no data
  // for and understate the team.
  //
  // maxRecords is set well above one Zoho page: the import was capped at 200
  // for its whole life because it fetched a single page, which is why Calls Per
  // Day read 0.9 against a target of 40.
  try {
    const { runZohoCallsImport } = await import("./zohoCallsImport");
    const calls = await runZohoCallsImport({
      sinceIso: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      maxRecords: 2000,
    });
    logger.info("[KPI Auto] Zoho calls import", {
      scanned: calls.scanned,
      new: calls.imported_new,
      updated: calls.updated_existing,
      errors: calls.errors,
    });
    results.push({
      kpi: "zoho-calls-import",
      value: calls.scanned,
      status: calls.errors === 0 ? "recorded" : "failed",
      error: calls.error_samples[0],
    });
  } catch (err) {
    // Isolated like the Tasks sync: a Zoho outage must not cost the day's
    // non-call KPIs. The call KPIs return "--" on an empty window, not a fake 0.
    logger.error("[KPI Auto] Zoho calls import error:", err);
    results.push({ kpi: "zoho-calls-import", error: String(err), status: "failed" });
  }

  // Refresh the local Zoho Tasks mirror BEFORE the KPI engine runs below.
  //
  // ORDER MATTERS: SDR-KPI-11, SALES-KPI-07 and SALES-KPI-08 read `zoho_tasks`.
  // Recalculating first would score them against yesterday's tasks, so every
  // value would silently trail the data by a day. Syncing here is also what
  // stops these three going stale — the sync is otherwise manual-only, wired to
  // POST /api/zoho/tasks/sync and nothing else.
  //
  // Isolated in its own try/catch on purpose: a Zoho outage must not stop the
  // KPI engine below from recording everything that does not depend on tasks.
  // The three task KPIs return "--" on an empty mirror rather than a fake 0.
  try {
    const { runZohoTasksSync } = await import("./zohoTasksSync");
    const tasks = await runZohoTasksSync({ maxRecords: 5000 });
    logger.info("[KPI Auto] Zoho tasks sync", {
      scanned: tasks.scanned,
      new: tasks.imported_new,
      updated: tasks.updated_existing,
      linkage: tasks.linkage,
      errors: tasks.errors,
    });
    results.push({
      kpi: "zoho-tasks-sync",
      value: tasks.scanned,
      status: tasks.errors === 0 ? "recorded" : "failed",
      error: tasks.error_samples[0],
    });
    // A healthy total with almost nothing linked means the follow-up KPIs are
    // measuring an empty set — worth seeing in the log before someone reports
    // the numbers as broken.
    if (tasks.scanned > 0 && tasks.linkage.none === tasks.scanned) {
      logger.warn(
        "[KPI Auto] every synced task is unlinked — the follow-up KPIs have nothing to measure",
      );
    }
  } catch (err) {
    logger.error("[KPI Auto] Zoho tasks sync error:", err);
    results.push({ kpi: "zoho-tasks-sync", error: String(err), status: "failed" });
  }

  // Also run the canonical KPI engine: leadership-feed-backed Quality/GRC values
  // + checklist-mode KPIs (% of items done). This is the authoritative source for
  // the agreed owner-based KPI list on /kpis; the scorecard calculators above
  // remain for the legacy fuzzy-matched KPIs.
  try {
    const { runKPIAutoCalc: runCanonicalKPIAutoCalc } =
      await import("./kpiAutoCalc");
    // includeCycleTimes=true: the daily background run also refreshes the Sales
    // Proposal/Agreement cycle times (Zoho stage-history sample) — too slow for
    // the interactive Recalculate button, fine here.
    const canon = await runCanonicalKPIAutoCalc(true);
    for (const d of canon.details) {
      results.push({
        kpi: d.code,
        value: d.value,
        status: d.value !== undefined ? "recorded" : "failed",
        error: d.reason,
      });
    }
  } catch (err) {
    logger.error("[KPI Auto] Canonical engine error:", err);
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

// DELETION-FEED SWEEP — sync-INDEPENDENT schedule (Sarah 2026-07-23).
// The post-sync sweep only runs when a sync COMPLETES, and the recurring
// stuck/3h syncs mean it often doesn't. This runs the SAME authoritative
// /deleted-feed prune on the 45-min housekeeping loop, gated to ~every 3h, so
// records removed in Zoho are pruned from the mirror + the pending-delete ledger
// regardless of sync state. In-memory last-run stamp: a restart just triggers
// one extra run, which is harmless (the sweep is idempotent).
let _lastDeletionFeedSweepMs = 0;
export async function runDeletionFeedSweepIfStale(
  maxAgeHours = Number(process.env.RADAR_DELETION_SWEEP_INTERVAL_HOURS || 3),
): Promise<{ ran: boolean; ageHours: number; result?: any }> {
  if (process.env.RADAR_DELETION_SWEEP_SCHEDULE === "false") {
    return { ran: false, ageHours: 0 };
  }
  const ageHours =
    _lastDeletionFeedSweepMs === 0
      ? Infinity
      : (Date.now() - _lastDeletionFeedSweepMs) / 3600000;
  if (ageHours < maxAgeHours) {
    return { ran: false, ageHours };
  }
  logger.info(
    `[DeletionFeedSweep Fallback] Last sweep ${ageHours === Infinity ? "never" : ageHours.toFixed(1) + "h ago"} (>= ${maxAgeHours}h); running.`,
  );
  try {
    const { sweepDeletedByFeed } = await import("./emptyRecordsDatabase");
    const days = parseInt(
      process.env.RADAR_POSTSYNC_SWEEP_LOOKBACK_DAYS || "30",
      10,
    );
    const result = await sweepDeletedByFeed({ lookbackDays: days });
    _lastDeletionFeedSweepMs = Date.now();
    return { ran: true, ageHours, result };
  } catch (err) {
    logger.error("[DeletionFeedSweep Fallback] failed:", err);
    // Stamp anyway so a persistent failure doesn't hammer Zoho every 45 min.
    _lastDeletionFeedSweepMs = Date.now();
    return { ran: false, ageHours };
  }
}

// DEAL DOCUMENT COMPLIANCE — rolling background sweep (Sarah 2026-08-25:
// "this page is a disaster, it stopped the whole PC when it works").
//
// Deal Compliance used to learn a deal's document status only when a human sat
// on the tab and pressed "Check all documents", which walked the loaded rows
// calling Zoho's attachments API. It capped at 200 of 976 in-scope deals, so
// it could never finish, and it pinned the browser while running.
//
// Now a slice runs here instead, every tick. Deliberately NOT a once-a-day
// burst: 976 attachment calls back-to-back risks Zoho's rate limit, and this
// deployment has already shown it falls over under that kind of load. ~60
// deals per 45-minute tick is ~1,900 checks a day, so every in-scope deal is
// re-checked daily with the load spread thin.
// CONTACT ACTIVITY CENSUS — proves which contacts hold no activity, so nothing
// is ever proposed for deletion on the strength of "we did not look"
// (Sarah 2026-09-06). Runs less often than the doc sweep: the bulk pass reads
// whole activity modules, and the answer only changes when someone logs a call.
// Disable with CONTACT_ACTIVITY_SWEEP_ENABLED=false.
let _lastContactActivitySweepMs = 0;
export async function runContactActivitySweepIfDue(
  minIntervalMinutes = Number(process.env.CONTACT_ACTIVITY_SWEEP_INTERVAL_MINUTES || 240),
): Promise<{ ran: boolean; ageHours: number; result?: any }> {
  if (process.env.CONTACT_ACTIVITY_SWEEP_ENABLED === "false") {
    return { ran: false, ageHours: 0 };
  }
  const ageHours =
    _lastContactActivitySweepMs === 0
      ? Infinity
      : (Date.now() - _lastContactActivitySweepMs) / 3600000;
  if (ageHours * 60 < minIntervalMinutes) return { ran: false, ageHours };
  try {
    const { runContactActivitySweep } = await import("./contactActivitySweep");
    const result = await runContactActivitySweep();
    _lastContactActivitySweepMs = Date.now();
    return { ran: true, ageHours, result };
  } catch (e: any) {
    // Stamp the clock even on failure so a persistent error cannot turn into a
    // hot loop against the Zoho API on every housekeeping tick.
    _lastContactActivitySweepMs = Date.now();
    logger.error("[ContactActivitySweep] failed:", e?.message || e);
    return { ran: false, ageHours };
  }
}

let _lastDealDocSweepMs = 0;
export async function runDealDocComplianceSweepIfDue(
  minIntervalMinutes = Number(process.env.DEAL_DOC_SWEEP_INTERVAL_MINUTES || 45),
): Promise<{ ran: boolean; ageHours: number; result?: any }> {
  if (process.env.DEAL_DOC_SWEEP_ENABLED === "false") {
    return { ran: false, ageHours: 0 };
  }
  const ageHours =
    _lastDealDocSweepMs === 0
      ? Infinity
      : (Date.now() - _lastDealDocSweepMs) / 3600000;
  if (ageHours * 60 < minIntervalMinutes) return { ran: false, ageHours };
  try {
    const { runDealDocComplianceSweep } = await import("./dealDocComplianceSweep");
    const result = await runDealDocComplianceSweep();
    _lastDealDocSweepMs = Date.now();
    if (result.scanned > 0) {
      logger.info(
        `[DealDocSweep] checked ${result.scanned} deal(s): ${result.compliant} compliant, ` +
          `${result.missing} missing docs, ${result.errors} error(s); ${result.remaining} never checked`,
      );
    }
    return { ran: true, ageHours, result };
  } catch (err) {
    logger.error("[DealDocSweep] pass failed:", err);
    // Stamp anyway — a persistent failure must not hammer Zoho every tick.
    _lastDealDocSweepMs = Date.now();
    return { ran: false, ageHours };
  }
}

// MONTHLY MISSING-DOCUMENTS REPORT (Sarah 2026-08-25, shipped 2026-09-02).
//
// Sends once per calendar month, on the 1st, in a morning KSA window. Three
// deliberate guards, in order of how much damage skipping them would do:
//
//   OFF BY DEFAULT. MISSING_DOCS_REPORT_ENABLED must be "true". A job that
//   emails the Head of Sales the moment it deploys is an incident, not a
//   feature.
//
//   SEND-ONCE IS ENFORCED IN THE DATABASE, not by an in-memory stamp. The
//   45-minute loop ticks several times inside the window and the process
//   restarts freely; the (report_key, period) primary key on
//   scheduled_report_sends is what makes a second send impossible. The row is
//   inserted BEFORE the send, so a crash mid-send costs a missed report rather
//   than a duplicate — the safer failure for something with an audience.
//
//   RECIPIENTS COME FROM ENV, never a request. See missingDocsMonthlyReport.ts.
export async function runMonthlyMissingDocsReportIfDue(): Promise<{
  ran: boolean;
  ageHours: number;
  result?: any;
}> {
  const {
    isMonthlyMissingDocsEnabled,
    monthlyMissingDocsRecipients,
    buildMonthlyMissingDocsEmail,
    periodKey,
    periodLabel,
  } = await import("./missingDocsMonthlyReport");

  if (!isMonthlyMissingDocsEnabled()) return { ran: false, ageHours: 0 };

  // KSA is UTC+3 and does not observe DST, so a fixed offset is exact here.
  const nowKsa = new Date(Date.now() + 3 * 3600_000);
  const sendDay = Number(process.env.MISSING_DOCS_REPORT_DAY || 1);
  if (nowKsa.getUTCDate() !== sendDay) return { ran: false, ageHours: 0 };
  const hour = nowKsa.getUTCHours();
  if (hour < 7 || hour > 9) return { ran: false, ageHours: 0 };

  // The report covers the month that just ended, not the one just begun.
  const covered = new Date(
    Date.UTC(nowKsa.getUTCFullYear(), nowKsa.getUTCMonth() - 1, 1),
  );
  const period = periodKey(covered);

  try {
    const { pool, getDealComplianceReportRows } = await import(
      "./duplicateRadarDatabase"
    );
    const recipients = monthlyMissingDocsRecipients();
    if (!recipients.length) {
      logger.warn(
        "[MissingDocsReport] enabled but no valid recipients configured — not sending",
      );
      return { ran: false, ageHours: 0 };
    }

    // Claim the period FIRST. A conflict means another tick (or another
    // process) already has it.
    const claim = await pool.query(
      `INSERT INTO scheduled_report_sends (report_key, period, recipient_count, detail)
       VALUES ('missing_docs_monthly', $1, $2, $3::jsonb)
       ON CONFLICT (report_key, period) DO NOTHING
       RETURNING period`,
      [period, recipients.length, JSON.stringify({ claimed_at: new Date().toISOString() })],
    );
    if (!claim.rows.length) return { ran: false, ageHours: 0 };

    const { countNeverChecked } = await import("./dealDocComplianceSweep");
    const { REPORT_STAGES, sameStage } = await import("./dealComplianceReportExport");
    const rows = await getDealComplianceReportRows("all");
    // Paid deals are Customer Success's, not Sales's, and buildMonthlyMissingDocsEmail
    // already excludes them from every figure it reports (REPORT_STAGES). The
    // denominator here must be scoped the same way — Paid deals excluded from
    // BOTH the numerator and the denominator — or the coverage line quotes a
    // percentage of a smaller set against a total that includes deals it never
    // mentions.
    const inScopeRows = rows.filter((r) => REPORT_STAGES.some((s) => sameStage(s, r.stage)));
    const neverChecked = await countNeverChecked(REPORT_STAGES);
    const mail = buildMonthlyMissingDocsEmail(rows, {
      periodLabel: periodLabel(covered),
      inScope: inScopeRows.length + neverChecked,
      dashboardUrl: process.env.MISSING_DOCS_REPORT_LINK,
    });

    const { sendResendEmail } = await import("./resendMail");
    const sent = await sendResendEmail({
      to: recipients,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
    logger.info(
      `[MissingDocsReport] ${period}: ${sent.success ? "sent" : "FAILED"} to ${recipients.length} recipient(s)` +
        (sent.error ? ` — ${sent.error}` : ""),
    );
    return {
      ran: true,
      ageHours: 0,
      result: { period, recipients: recipients.length, sent: sent.success, checked: rows.length },
    };
  } catch (err) {
    logger.error("[MissingDocsReport] failed:", err);
    return { ran: false, ageHours: 0 };
  }
}

// KPI VISIBILITY WATCHDOG — every housekeeping tick (Sarah 2026-09-06:
// "make sure this issue is not done again").
//
// The boot-time repair was not enough on its own. The GRQ final-seed sweep
// deactivates by owner_type and its owner_name exemption FAILS OPEN — an
// unreadable BU registry exempts nobody — so department KPIs can be switched
// off at any time, not just during startup. A boot-only repair leaves them
// missing for as long as the process happens to stay up, which is how all 33
// Customer Success KPIs stayed invisible for days while every page reported
// "No active KPIs found" and nothing anywhere raised a word.
//
// So: re-check on the loop, repair if needed, and re-verify that the repair
// actually worked. Cheap when healthy — three indexed reads and no writes.
export async function runKpiVisibilityWatchdog(): Promise<{
  ran: boolean;
  ageHours: number;
  result?: any;
}> {
  try {
    const { verifySeededKpiVisibility, restoreDepartmentKpis } = await import(
      "./kpiDatabase"
    );
    // Orphan auto-values FIRST, and deliberately before the healthy-exit
    // below: an orphan only ever shows up while visibility is fine. CS-KPI-21
    // was visible and green-lit by every other check while displaying a red
    // 61% that no calculator had maintained since the day it was written.
    let orphanCount = 0;
    try {
      const { findOrphanAutoValues } = await import("./kpiOrphanValues");
      const orphans = await findOrphanAutoValues();
      orphanCount = orphans.length;
      if (orphanCount) {
        logger.warn(
          `⚠️ [KpiWatchdog] ${orphanCount} orphan auto-value(s) — a calculator wrote them, ` +
            `the KPI is now manual, nothing maintains them: ` +
            orphans
              .map((o) => `${o.kpi_code}=${o.actual_value}`)
              .join(", ") +
            `. Suppressed from display; POST /api/kpis/orphan-values/purge to remove.`,
        );
      }
    } catch (e) {
      logger.error("[KpiWatchdog] orphan-value check failed:", e);
    }

    const before = await verifySeededKpiVisibility();
    const broken = before.filter((t) => !t.ok);
    if (!broken.length)
      return { ran: true, ageHours: 0, result: { healthy: true, orphanCount } };

    const restored = await restoreDepartmentKpis();
    const after = await verifySeededKpiVisibility();
    const stillBroken = after.filter((t) => !t.ok);
    if (stillBroken.length) {
      // The repair could not fix it, so the cause is something new. Say so
      // loudly rather than silently retrying every 45 minutes forever.
      logger.error(
        "❌ [KpiWatchdog] KPIs still not visible after the repair — cause is NOT the known sweep. " +
          `Check /api/kpis/seed-health forensics: ${stillBroken
            .map((t) => `${t.ownerName} ${t.visible}/${t.expected}`)
            .join(", ")}`,
      );
    } else {
      logger.warn(
        `⚠️ [KpiWatchdog] ${broken.map((t) => t.ownerName).join(", ")} had lost their KPIs; ` +
          `restored ${restored} row(s) and re-verified.`,
      );
    }
    return {
      ran: true,
      ageHours: 0,
      result: {
        repaired: restored,
        stillBroken: stillBroken.map((t) => t.ownerName),
        orphanCount,
      },
    };
  } catch (err) {
    logger.error("[KpiWatchdog] failed:", err);
    return { ran: false, ageHours: 0 };
  }
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

/**
 * Autonomous Duplicate Resolution — in-process fallback for the 6h cron.
 *
 * Mirror of `runConsultantScannerIfStale`. Runs the same orchestration core as
 * the Inngest workflow (`runAutonomousResolution`) when the last successful run
 * is ≥ maxAgeHours old, so the agent keeps ticking on hosts where Inngest isn't
 * driving it. The runner is itself gated by AUTONOMOUS_RESOLUTION_ENABLED/_MODE
 * (default shadow → writes nothing), so this fallback is safe to ship as-is.
 * Last run tracked in scanner_run_log under 'autonomous-resolution'.
 */
export async function runAutonomousResolutionIfStale(
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
     FROM scanner_run_log WHERE scanner_name='autonomous-resolution' AND success=true`,
  );
  const ageHours =
    r.rows[0]?.hours == null ? Infinity : Number(r.rows[0].hours);
  if (ageHours < maxAgeHours) {
    return { ran: false, ageHours };
  }
  logger.info(
    `[AutoResolution Fallback] Last run was ${ageHours === Infinity ? "never" : ageHours.toFixed(1) + "h ago"} (>= ${maxAgeHours}h); running tick.`,
  );
  try {
    const { runAutonomousResolution } = await import("./duplicateResolutionRunner");
    const result = await runAutonomousResolution();
    await pool.query(
      `INSERT INTO scanner_run_log (scanner_name, success, summary) VALUES ($1, $2, $3)`,
      ["autonomous-resolution", result.errors === 0, JSON.stringify(result)],
    );
    return { ran: true, ageHours, result };
  } catch (err) {
    logger.error("[AutoResolution Fallback] Tick failed:", err);
    await pool.query(
      `INSERT INTO scanner_run_log (scanner_name, success, summary) VALUES ($1, false, $2)`,
      ["autonomous-resolution", JSON.stringify({ error: String(err) })],
    );
    return { ran: false, ageHours };
  }
}

/**
 * Twice-daily Autonomous-Resolution apply digest — in-process fallback for the
 * Inngest cron. Posts the morning digest in the 06:00–07:00 UTC window
 * (09:00 KSA) and the evening digest in 14:00–15:00 UTC (17:00 KSA). Each is
 * tracked separately in scanner_run_log so a digest fires at most once per day
 * even though the fallback loop ticks every ~45 min. No-op outside the windows.
 */
export async function runResolutionDigestIfDue(): Promise<{ ran: boolean; ageHours: number }> {
  const now = new Date();
  const hourUTC = now.getUTCHours();
  let slot: "morning" | "evening" | null = null;
  if (hourUTC === 6) slot = "morning";
  else if (hourUTC === 14) slot = "evening";
  if (!slot) return { ran: false, ageHours: 0 };

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
  // Single shared once-per-slot claim (Sarah 2026-06-22): the cron AND this
  // fallback both go through postResolutionDigestOncePerSlot, which atomically
  // claims the (slot, UTC-date) key — so the digest posts exactly once even if
  // both triggers fire. (Previously each path had its own marker → double-post.)
  try {
    const { postResolutionDigestOncePerSlot } = await import("./duplicateResolutionRunner");
    const res = await postResolutionDigestOncePerSlot(slot);
    return { ran: !!res.posted, ageHours: 0 };
  } catch (err) {
    logger.error("[ResolutionDigest Fallback] failed:", err);
    return { ran: false, ageHours: 0 };
  }
}

/**
 * In-process fallback for the WEEKLY leadership exec brief, in case the Inngest
 * cron doesn't fire. Sunday 06:00 KSA = 03:00 UTC; we accept a 03:00–06:00 UTC
 * Sunday window to absorb the ~45-min tick drift, gated to once per 6 days so
 * only one fire actually posts.
 */
export async function runWeeklyExecBriefIfDue(): Promise<{ ran: boolean; ageHours: number }> {
  const now = new Date();
  const isSunday = now.getUTCDay() === 0;
  const hourUTC = now.getUTCHours();
  if (!isSunday || hourUTC < 3 || hourUTC > 6) return { ran: false, ageHours: 0 };

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
  const scanner = "exec-brief-weekly";
  const r = await pool.query<{ hours: number | null }>(
    `SELECT EXTRACT(EPOCH FROM (NOW() - MAX(ran_at)))/3600 AS hours
     FROM scanner_run_log WHERE scanner_name=$1 AND success=true`,
    [scanner],
  );
  const ageHours = r.rows[0]?.hours == null ? Infinity : Number(r.rows[0].hours);
  if (ageHours < 144) return { ran: false, ageHours }; // already posted this week
  try {
    const { postWeeklyExecBrief } = await import("./duplicateResolutionRunner");
    const res = await postWeeklyExecBrief();
    await pool.query(
      `INSERT INTO scanner_run_log (scanner_name, success, summary) VALUES ($1, true, $2)`,
      [scanner, JSON.stringify(res)],
    );
    return { ran: true, ageHours };
  } catch (err) {
    logger.error("[ExecBriefWeekly Fallback] failed:", err);
    await pool.query(
      `INSERT INTO scanner_run_log (scanner_name, success, summary) VALUES ($1, false, $2)`,
      [scanner, JSON.stringify({ error: String(err) })],
    );
    return { ran: false, ageHours };
  }
}

/**
 * WEEKLY push of QMS KPI values to the Leadership Platform webhook — every
 * THURSDAY morning (Ahmad 2026-09-02: changed from daily to weekly-Thursday).
 *
 * QMS is the source of truth; the Leadership Platform only pulls on its own
 * schedule, so this posts the mapped KPIs once a week so the board reflects the
 * current QMS values without waiting on their pull. Weekly (vs daily) also stops
 * the every-morning churn that made a KPI's row flip on each push.
 *
 * Window: Thursday 03:00–06:00 UTC (06:00–09:00 KSA), gated to once per ~6 days
 * so only one fire per week actually posts. No-op (and NOT stamped, so it retries
 * next Thursday) when the push isn't configured — pushToLeadership() returns
 * {configured:false} unless PLATFORM_WEBHOOK_URL + WEBHOOK_SECRET are set, and it
 * only sends KPIs that map to a real leadership record (skips the rest).
 */
export async function runLeadershipPushIfDue(): Promise<{ ran: boolean; ageHours: number }> {
  const now = new Date();
  // ONLY the production deployment may run the automatic push. The dev workspace
  // and any preview deploy run this same fallback loop but read a DIFFERENT
  // database (Replit dev/prod split), so if they also push, the leadership board
  // flip-flops between each instance's value (seen 2026-08/09: BU Pilot bouncing
  // 75/66.7/0 on every push, across all KPIs). We BLOCK only when positively
  // identified as the dev workspace (REPLIT_DEV_DOMAIN set and NOT a deployment),
  // so production is never accidentally silenced if the env vars ever change.
  // LEADERSHIP_PUSH_FORCE=true forces this instance to push regardless.
  const inDeployment =
    process.env.REPLIT_DEPLOYMENT === "1" || !!process.env.REPLIT_DEPLOYMENT_ID;
  const isDevWorkspace = !inDeployment && !!process.env.REPLIT_DEV_DOMAIN;
  const forced =
    String(process.env.LEADERSHIP_PUSH_FORCE || "").toLowerCase() === "true";
  if (isDevWorkspace && !forced) return { ran: false, ageHours: 0 };

  const isThursday = now.getUTCDay() === 4; // 0=Sun … 4=Thu
  const hourUTC = now.getUTCHours();
  if (!isThursday || hourUTC < 3 || hourUTC > 6) return { ran: false, ageHours: 0 };

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
  const scanner = "leadership-push-weekly";
  const r = await pool.query<{ hours: number | null }>(
    `SELECT EXTRACT(EPOCH FROM (NOW() - MAX(ran_at)))/3600 AS hours
     FROM scanner_run_log WHERE scanner_name=$1 AND success=true`,
    [scanner],
  );
  const ageHours = r.rows[0]?.hours == null ? Infinity : Number(r.rows[0].hours);
  if (ageHours < 144) return { ran: false, ageHours }; // already pushed this week (6d)
  try {
    const { pushToLeadership } = await import("./leadershipPush");
    const res = await pushToLeadership();
    // Not-configured is a no-op, not a failure — don't stamp, so it retries once
    // the operator sets the secrets.
    if (!res.configured) return { ran: false, ageHours };
    await pool.query(
      `INSERT INTO scanner_run_log (scanner_name, success, summary) VALUES ($1, true, $2)`,
      [scanner, JSON.stringify(res)],
    );
    return { ran: true, ageHours };
  } catch (err) {
    logger.error("[LeadershipPush Fallback] failed:", err);
    await pool.query(
      `INSERT INTO scanner_run_log (scanner_name, success, summary) VALUES ($1, false, $2)`,
      [scanner, JSON.stringify({ error: String(err) })],
    );
    return { ran: false, ageHours };
  }
}


/**
 * Run the platform health pulse if the last recorded run is stale.
 *
 * WHY THIS IS A FALLBACK HELPER AND NOT ONLY AN INNGEST CRON:
 * the pulse's whole job is to notice when scheduled work stops, so hanging it
 * off the same scheduler that stops is circular. This module's own header says
 * production runners have missed cron fires for days at a time, and the
 * evidence agreed — `ai-approval-expiry` is registered every 15 minutes with a
 * one-line UPDATE, and as of 2026-09-07 not a single row had EVER been expired
 * while 275 sat eligible. A monitor must not share a single point of failure
 * with the thing it monitors.
 *
 * Freshness is read from health_pulse_runs rather than tracked in memory, so a
 * restart does not re-trigger a run and multiple instances do not duplicate it.
 */
export async function runHealthPulseIfStale(
  maxAgeHours = 1,
): Promise<{ ran: boolean; ageHours: number; result?: any }> {
  let ageHours = Infinity;
  try {
    const r = await sharedPool.query<{ hours: number | null }>(
      `SELECT EXTRACT(EPOCH FROM (NOW() - MAX(run_at)))/3600 AS hours
         FROM health_pulse_runs`,
    );
    const raw = r.rows[0]?.hours;
    ageHours = raw === null || raw === undefined ? Infinity : Number(raw);
  } catch (err) {
    // Table absent on a fresh deployment — runHealthPulse creates it.
    logger.info(
      "[HealthPulse Fallback] Could not read last run age; treating as stale.",
      { error: err instanceof Error ? err.message : String(err) },
    );
  }

  if (ageHours < maxAgeHours) return { ran: false, ageHours };

  logger.info(
    `[HealthPulse Fallback] Last pulse ${
      ageHours === Infinity ? "never recorded" : ageHours.toFixed(1) + "h ago"
    } (threshold ${maxAgeHours}h); running pulse.`,
  );

  try {
    const { runHealthPulse, maybeNotifyOnPulse } = await import(
      "./platformHealthPulse"
    );
    const run = await runHealthPulse();
    // The run is already persisted; a failed alert must not discard it.
    try {
      await maybeNotifyOnPulse(run);
    } catch (notifyErr) {
      logger.error(
        "[HealthPulse Fallback] Pulse recorded but alert dispatch failed:",
        notifyErr,
      );
    }
    return {
      ran: true,
      ageHours,
      result: {
        overall: run.overall_status,
        fail: run.fail_count,
        warn: run.warn_count,
      },
    };
  } catch (err) {
    logger.error("[HealthPulse Fallback] Pulse failed:", err);
    return { ran: false, ageHours };
  }
}

/**
 * Flip HITL approvals past their expiry from 'pending' to 'expired'.
 *
 * The ai-approval-expiry Inngest cron (every 15 min) already does this and its
 * body is a single UPDATE. It has never run: on 2026-09-07, 275 rows were
 * eligible and
 * the count EVER expired was zero. That is the clearest single proof that
 * Inngest crons do not fire on this deployment.
 *
 * Time-based rather than freshness-based: there is no "last run" timestamp to
 * read, so this self-throttles in memory. A restart re-runs it once, which is
 * harmless — the UPDATE is idempotent and matches nothing when the queue is
 * already clean.
 */
let _lastApprovalExpiryMs = 0;
export async function runApprovalExpiryIfDue(
  minIntervalMinutes = 15,
): Promise<{ ran: boolean; ageHours: number; result?: any }> {
  const ageHours = _lastApprovalExpiryMs
    ? (Date.now() - _lastApprovalExpiryMs) / 3_600_000
    : Infinity;
  if (ageHours * 60 < minIntervalMinutes) return { ran: false, ageHours };

  try {
    const { expireStalePendingActions } = await import("./aiApprovalDatabase");
    const expired = await expireStalePendingActions();
    _lastApprovalExpiryMs = Date.now();
    if (expired > 0) {
      // Deliberately loud. Each row is an AI proposal that aged out WITHOUT a
      // human decision, which is a governance event, not routine housekeeping.
      logger.warn(
        `[ApprovalExpiry Fallback] Expired ${expired} pending AI approval(s) — these aged out unreviewed.`,
      );
    }
    return { ran: true, ageHours, result: { expired } };
  } catch (err) {
    logger.error("[ApprovalExpiry Fallback] Expiry failed:", err);
    return { ran: false, ageHours };
  }
}

/**
 * Send queued Slack messages sitting in notification_outbox.
 *
 * The outbox is the durable-retry path for Slack: directAuditRunner enqueues
 * audit results into it and relies on the notification-outbox-drain cron
 * (every 10 min) to send them. That cron has no fallback, so on a deployment where
 * Inngest does not fire, the quality-audit fallback keeps ENQUEUEING while
 * nothing DRAINS — messages accumulate as 'pending' and are never sent.
 *
 * executiveDigest drains inline after enqueueing, so it is unaffected; this
 * covers the producers that do not.
 */
let _lastOutboxDrainMs = 0;
export async function runOutboxDrainIfDue(
  minIntervalMinutes = 10,
): Promise<{ ran: boolean; ageHours: number; result?: any }> {
  const ageHours = _lastOutboxDrainMs
    ? (Date.now() - _lastOutboxDrainMs) / 3_600_000
    : Infinity;
  if (ageHours * 60 < minIntervalMinutes) return { ran: false, ageHours };

  try {
    const { processDueOutboxMessages } = await import("./notificationOutbox");
    const result = await processDueOutboxMessages();
    _lastOutboxDrainMs = Date.now();
    if (result.sent > 0 || result.failed > 0) {
      logger.info(
        `[OutboxDrain Fallback] sent=${result.sent} failed=${result.failed} pending=${result.pending}`,
      );
    }
    return { ran: true, ageHours, result };
  } catch (err) {
    logger.error("[OutboxDrain Fallback] Drain failed:", err);
    return { ran: false, ageHours };
  }
}

/**
 * The six fraud compliance checks, on the in-process fallback.
 *
 * Their Inngest crons do not fire on this deployment (see
 * runApprovalExpiryIfDue for the proof), so without these the SAMA 72-hour
 * deadline warning, the containment-SLA breach check and the four periodic
 * reminders never ran at all. The bodies live in ./fraudScheduledChecks so the
 * cron and this fallback execute identical code.
 *
 * Each self-throttles in memory against its own interval. The intervals are
 * deliberately looser than the cron equivalents: the fallback tick is every 45
 * minutes, so anything tighter than that would just run on every tick.
 */
const _lastFraudCheckMs: Record<string, number> = {};

async function runFraudCheckIfDue(
  key: string,
  minIntervalMinutes: number,
  fn: () => Promise<any>,
): Promise<{ ran: boolean; ageHours: number; result?: any }> {
  const last = _lastFraudCheckMs[key] || 0;
  const ageHours = last ? (Date.now() - last) / 3_600_000 : Infinity;
  if (ageHours * 60 < minIntervalMinutes) return { ran: false, ageHours };
  try {
    const result = await fn();
    _lastFraudCheckMs[key] = Date.now();
    return { ran: true, ageHours, result };
  } catch (err) {
    logger.error(`[FraudChecks Fallback] ${key} failed:`, err);
    return { ran: false, ageHours };
  }
}

/** Hourly in cron terms; incident-specific, emails named recipients. */
export async function runFraudSamaDeadlineCheckIfDue() {
  return runFraudCheckIfDue("sama-deadline", 60, async () => {
    const { runFraudSamaDeadlineCheck } = await import("./fraudScheduledChecks");
    return runFraudSamaDeadlineCheck();
  });
}

/** Hourly in cron terms; incident-specific, emails named recipients. */
export async function runFraudIncidentSlaCheckIfDue() {
  return runFraudCheckIfDue("incident-sla", 60, async () => {
    const { runFraudIncidentSlaCheck } = await import("./fraudScheduledChecks");
    return runFraudIncidentSlaCheck();
  });
}

/** Daily. Aggregated Slack summary. */
export async function runFraudIncidentOverdueCheckIfDue() {
  return runFraudCheckIfDue("incident-overdue", 24 * 60, async () => {
    const { runFraudIncidentOverdueCheck } = await import(
      "./fraudScheduledChecks"
    );
    return runFraudIncidentOverdueCheck();
  });
}

/** Daily. Aggregated Slack summary. */
export async function runFraudRuleReviewReminderIfDue() {
  return runFraudCheckIfDue("rule-review", 24 * 60, async () => {
    const { runFraudRuleReviewReminder } = await import(
      "./fraudScheduledChecks"
    );
    return runFraudRuleReviewReminder();
  });
}

/**
 * Semi-annual (FATF plenary cadence). The 30-day floor only stops the fallback
 * from re-firing after a restart; the real cadence is the operator acting on it.
 */
export async function runFraudCountryReviewReminderIfDue() {
  return runFraudCheckIfDue("country-review", 30 * 24 * 60, async () => {
    const { runFraudCountryReviewReminder } = await import(
      "./fraudScheduledChecks"
    );
    return runFraudCountryReviewReminder();
  });
}

/**
 * Month-end KPI snapshot. Guarded to the first four days of the month so a
 * fallback restart mid-month does not recompute and re-announce a month that
 * has already been handled.
 */
export async function runFraudKpiMonthlyReminderIfDue() {
  if (new Date().getUTCDate() > 4) return { ran: false, ageHours: 0 };
  return runFraudCheckIfDue("kpi-monthly", 20 * 24 * 60, async () => {
    const { runFraudKpiMonthlyReminder } = await import(
      "./fraudScheduledChecks"
    );
    return runFraudKpiMonthlyReminder();
  });
}

/**
 * Weekly Sales/SDR reports — deal compliance and active deal conflicts.
 *
 * Weekly "with the audits" per Sarah 2026-09-07, and threshold-gated: each one
 * stays silent when there is nothing wrong, so the channel keeps meaning
 * something.
 *
 * Both are guarded by a PERSISTENT marker rather than an in-memory timer. The
 * fraud reminders taught this the hard way — an in-process throttle resets on
 * every restart, and a semi-annual reminder fired four times in one morning
 * across three republishes. A weekly report on a platform that republishes
 * several times a day would be far worse.
 *
 * The marker is the notification row the report itself writes, so there is no
 * extra table and no state to keep in sync.
 */
async function salesReportPostedWithinDays(
  entityType: string,
  days: number,
): Promise<boolean> {
  try {
    const { notificationPool } = await import("./notificationHub");
    const res = await notificationPool.query(
      `SELECT 1 FROM notifications
        WHERE related_entity_type = $1
          AND created_at > NOW() - MAKE_INTERVAL(days => $2)
        LIMIT 1`,
      [entityType, days],
    );
    return (res.rowCount ?? 0) > 0;
  } catch (err) {
    // Fail OPEN: a dedup lookup failing must not silence the report.
    logger.warn(
      "[SalesWeekly] Dedup lookup failed; posting anyway:",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/**
 * The weekly Sales/SDR Slack reports are OFF by default.
 *
 * Sarah 2026-09-07: hold delivery until she has reviewed the first report.
 * These post to wp-sdr-sales-audits — a real team channel — and the only
 * other guard is a 6-day dedup on `related_entity_type`. Both entity types
 * are new, so that lookup finds nothing and the FIRST scheduler tick after a
 * republish would post unannounced. The dedup also fails open by design, so
 * it cannot be relied on to hold anything back.
 *
 * Nothing stops being measured: deal compliance and active deal conflicts are
 * already visible in the app and in the exports. Only the Slack delivery, and
 * the dedup-ledger row that goes with it, are withheld — gating here rather
 * than at the send point means no ledger row is written while the reports are
 * off, so the first run after enabling is a clean one rather than one the
 * dedup thinks it has already sent.
 *
 * Set SALES_WEEKLY_SLACK_REPORTS=true to turn delivery on.
 */
function salesWeeklyReportsEnabled(): boolean {
  return (
    String(process.env.SALES_WEEKLY_SLACK_REPORTS || "").toLowerCase() === "true"
  );
}

export async function runDealComplianceWeeklyIfDue(): Promise<{
  ran: boolean;
  ageHours: number;
  result?: any;
}> {
  if (!salesWeeklyReportsEnabled()) {
    logger.info(
      '[SalesWeekly] Deal compliance report skipped — delivery is off (SALES_WEEKLY_SLACK_REPORTS is not "true")',
    );
    return { ran: false, ageHours: 0 };
  }
  if (await salesReportPostedWithinDays("deal_compliance", 6)) {
    return { ran: false, ageHours: 0 };
  }
  try {
    const { runDealComplianceWeeklyReport } = await import(
      "./salesWeeklyReports"
    );
    const result = await runDealComplianceWeeklyReport();
    return { ran: result.posted, ageHours: 0, result };
  } catch (err) {
    logger.error("[SalesWeekly] Deal compliance report failed:", err);
    return { ran: false, ageHours: 0 };
  }
}

export async function runActiveDealConflictsWeeklyIfDue(): Promise<{
  ran: boolean;
  ageHours: number;
  result?: any;
}> {
  if (!salesWeeklyReportsEnabled()) {
    logger.info(
      '[SalesWeekly] Active deal conflicts report skipped — delivery is off (SALES_WEEKLY_SLACK_REPORTS is not "true")',
    );
    return { ran: false, ageHours: 0 };
  }
  if (await salesReportPostedWithinDays("active_deal_conflicts", 6)) {
    return { ran: false, ageHours: 0 };
  }
  try {
    const { runActiveDealConflictsWeeklyReport } = await import(
      "./salesWeeklyReports"
    );
    const result = await runActiveDealConflictsWeeklyReport();
    return { ran: result.posted, ageHours: 0, result };
  } catch (err) {
    logger.error("[SalesWeekly] Active deal conflicts report failed:", err);
    return { ran: false, ageHours: 0 };
  }
}
