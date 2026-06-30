import { join } from "path";
import { readFileSync, existsSync } from "fs";
import {
  requireRoleOrKey,
  unauthorizedResponse,
} from "../../utils/rbacMiddleware";

const DUPLICATE_RADAR_READ_ROLES = [
  "admin",
  "grc_manager",
  "ai_specialist",
  "head_of_operations_quality",
  "quality_manager",
  "bu_owner",
  "executive",
] as const;

async function requireDuplicateRadarAccess(c: any) {
  return requireRoleOrKey(c, [...DUPLICATE_RADAR_READ_ROLES]);
}

// Parse the shared Advanced Filters query params used by the per-tab record
// endpoints (leads/deals/contacts/accounts). The Module filter is intentionally
// omitted: each record tab already pins its own module, so module selection is
// driven by which tab is active, not by this query param.
function parseRecordTabFilters(url: URL): {
  start_date?: string;
  end_date?: string;
  owners?: string[];
  layouts?: string[];
  pipelines?: string[];
  stages?: string[];
  confidence_level?: string;
  domain?: string;
  ai_status?: string;
} {
  const csv = (key: string): string[] | undefined => {
    const raw = url.searchParams.get(key);
    if (!raw) return undefined;
    const vals = raw
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    return vals.length > 0 ? vals : undefined;
  };
  // AI-status chip: active (untouched) | tagged_pending | resolved | all.
  // Whitelist enforced server-side so the DB query can't see unknown values.
  const rawAi = (url.searchParams.get("ai_status") || "").trim();
  const ai_status = ["active", "tagged_pending", "resolved", "dismissed", "all"].includes(
    rawAi,
  )
    ? rawAi
    : undefined;
  return {
    start_date: url.searchParams.get("start_date") || undefined,
    end_date: url.searchParams.get("end_date") || undefined,
    owners: csv("owners"),
    layouts: csv("layouts"),
    pipelines: csv("pipelines"),
    stages: csv("stages"),
    confidence_level: url.searchParams.get("confidence_level") || undefined,
    domain: url.searchParams.get("domain") || undefined,
    ai_status,
  };
}

import {
  initDuplicateRadarTables,
  getAllClusters,
  getClusterCount,
  getClusterById,
  getClusterMixedSignal,
  getRecordsByClusterId,
  splitRecordsIntoNewCluster,
  splitRecordsIntoNewClusterInTx,
  updateClusterStats,
  getClusterSummary,
  getDuplicatesByOwner,
  getDuplicatesBySource,
  updateClusterStatus,
  createDetectionLog,
  getDetectionLogs,
  createExportLog,
  clearMockData,
  getKPIMetrics,
  addRecordToCluster,
  upsertRecord,
  findOrCreateClusterByDomain,
  searchDuplicates,
  createCluster,
  clearAllDuplicateData,
  truncateAllDuplicateData,
  backfillResolutionLedger,
  restoreLedgerResolvedClusterStatus,
  reconcileAutoMergedContactDeletions,
  captureDuplicateProgressSnapshot,
  getDuplicateProgressSeries,
  cleanupStaleRecords,
  cleanupOrphanClusters,
  markRecordsStalePendingByIds,
  removeRecordsByZohoIds,
  getClusterRecordTypeMeta,
  getSyncState,
  getAllClustersByInflation,
  getClustersBySignal,
  findOrCreateClusterByCompany,
  upsertDealDocCompliance,
  getDealDocCompliance,
  normalizeCompanyName,
  extractDomain,
  normalizePhone,
  resolveCluster,
  bulkResolve,
  getMergeHistory,
  getTaggedRecordDbIdsByCluster,
  bulkSplitContactClustersByStrictRule,
  markPrimaryRecord,
  getOwnerAccountability,
  getPacketSettings,
  checkForDuplicates,
  getEnhancedSummary,
  getLastScanDate,
  getDuplicateRecordsByType,
  getExportRecords,
  autoResolveClusters,
  generateSmartRecommendations,
  getAllSyncStates,
  upsertSyncState,
  getDistinctOwners,
  getDistinctLayouts,
  getDistinctDomains,
  getDistinctPipelines,
  getDistinctStages,
  getDistinctProducts,
  getFilteredClusters,
  getFilteredSummary,
  upsertTask,
  getTasksForRecords,
  getTaskCountForCluster,
  pool as sharedDuplicateRadarPool,
} from "../../utils/duplicateRadarDatabase";

import type { DuplicateFilters } from "../../utils/duplicateRadarDatabase";
import { extractCsFieldsFromRawData } from "../../utils/duplicateRadarCsOverlap";

import {
  fetchAllZohoRecords,
  fetchDeletedZohoRecords,
  fetchZohoRecordById,
  fetchRecordAttachments,
  fetchZohoRelatedRecords,
  removeZohoTags,
} from "../../utils/zohoCRM";
import {
  DEAL_COMPLIANCE_STAGES,
  requiredDocsForStage,
  evaluateDocCompliance,
} from "../../utils/dealComplianceCheck";

import { logger } from "../../utils/logger";
import {
  buildMergePlan,
  MODULE_RECORD_TYPE,
  type CrmModule,
} from "../../utils/duplicateMergePlanner";

const AGENTIC_MODULES: CrmModule[] = ["Accounts", "Leads", "Deals", "Contacts"];
/** Parse + validate the `module` field from a request body; defaults Accounts. */
function parseAgenticModule(body: any): CrmModule {
  const m = typeof body?.module === "string" ? body.module : "Accounts";
  return (AGENTIC_MODULES as string[]).includes(m) ? (m as CrmModule) : "Accounts";
}
import { executeMergePlan } from "../../utils/duplicateMergeExecutor";
import {
  recordResolutionEvent,
  getResolutionLearnings,
  getResolutionActivity,
} from "../../utils/duplicateResolutionLearning";
import {
  runAutonomousResolution,
  runResolutionForCluster,
  undoClusterResolution,
  getResolutionRunConfig,
  resolveResolutionRunConfig,
  setResolutionSetting,
  isResolutionSlackConfigured,
  sendResolutionSlackTest,
  postResolutionMessage,
  buildExecutiveBriefText,
  postWeeklyExecBrief,
  postResolutionDigest,
  cleanupZeroResolutionPings,
  ADAM_NOTIFICATION_SCHEDULE,
  getModuleResolutionBreakdown,
  type ResolutionMode,
} from "../../utils/duplicateResolutionRunner";

// Management tier allowed to flip the agent's mode / kill switch (writes to Zoho).
const AUTONOMOUS_RESOLUTION_MANAGE_ROLES = [
  "admin",
  "head_of_operations_quality",
  "grc_manager",
  "quality_manager",
] as const;
import {
  listResolutionRules,
  recordResolutionRule,
  setResolutionRuleEnabled,
  type RuleDecision,
} from "../../utils/duplicateResolutionRules";
import { getGradeHistory } from "../../utils/duplicateResolutionGrades";
// Default to fetching the entire module so duplicate detection reflects the
// real CRM. Set DUPLICATE_SCAN_LIMIT to a positive integer to re-cap (useful
// for staging or when Zoho daily-credit budget is tight). An unset, blank,
// "0", or non-numeric value means "no cap" → fetchAllZohoRecords treats
// Infinity as "page until Zoho says more_records=false".
const SCAN_MAX_PER_MODULE = (() => {
  const raw = process.env.DUPLICATE_SCAN_LIMIT;
  if (!raw) return Infinity;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
})();

interface ScanState {
  status: "idle" | "scanning" | "completed" | "failed";
  progress: string;
  startedAt: number | null;
  /** Heartbeat: last time the scan emitted forward progress. Staleness is judged
   * from THIS, not startedAt — a long-but-progressing sync (e.g. a 68k-contact
   * full pull) is healthy and must NOT be reset just for running > 20 min. */
  lastProgressAt: number | null;
  completedAt: number | null;
  result: any | null;
  error: string | null;
  moduleStatuses: Record<string, string>;
  recordCounts: Record<string, number>;
  percentage: number;
}

const scanState: ScanState = {
  status: "idle",
  progress: "",
  startedAt: null,
  lastProgressAt: null,
  completedAt: null,
  result: null,
  error: null,
  moduleStatuses: {},
  recordCounts: {},
  percentage: 0,
};

// Monotonic scan "generation" — each run captures its number at start; a run
// only writes terminal state if it's still the current generation. This fences
// a stale background run (released below) from clobbering a newer run's state.
let scanGeneration = 0;

// A scan that's been "scanning" longer than this is treated as stalled and its
// lock can be reclaimed (e.g. the process was killed mid-run, or Zoho hung).
const STALE_SCAN_MS = (() => {
  const n = parseInt(process.env.DUPLICATE_SCAN_STALE_MS || "", 10);
  return Number.isFinite(n) && n > 0 ? n : 20 * 60 * 1000; // default 20 min
})();

/**
 * Gate for starting a new scan. Returns a block reason when a HEALTHY scan is
 * still running; otherwise releases a stale (or force-reset) "scanning" lock
 * and returns null so the caller proceeds. The released run, if still alive in
 * the background, is fenced by scanGeneration so it can't clobber the new run.
 */
function blockOrClearScan(force: boolean): { error: string; ageMinutes: number } | null {
  if (scanState.status !== "scanning") return null;
  // Staleness is measured from the LAST PROGRESS heartbeat, not the scan's start.
  // A sync that's still emitting progress is healthy no matter how long it has
  // run (a full 68k-contact pull legitimately takes far longer than 20 min); only
  // one that has made NO progress for STALE_SCAN_MS is treated as hung. This stops
  // the restart loop where every cron/fallback trigger killed an in-flight long
  // sync, so Contacts never finished and its baseline never saved.
  const heartbeat = scanState.lastProgressAt || scanState.startedAt;
  const idleMs = heartbeat ? Date.now() - heartbeat : Infinity;
  const ageMs = scanState.startedAt ? Date.now() - scanState.startedAt : Infinity;
  const ageMinutes = Number.isFinite(ageMs) ? Math.round(ageMs / 60000) : 0;
  const idleMinutes = Number.isFinite(idleMs) ? Math.round(idleMs / 60000) : 0;
  if (!force && idleMs < STALE_SCAN_MS) {
    return { error: "A scan is already in progress", ageMinutes };
  }
  logger.warn(
    `🧹 [DuplicateRadar] Releasing ${force ? "force-reset" : "stale"} scan lock (running ${ageMinutes}m, idle ${idleMinutes}m, no progress) — starting fresh`,
  );
  scanState.status = "failed";
  scanState.error = force
    ? "Reset by admin"
    : `Auto-reset: previous scan stalled (${ageMinutes}m)`;
  return null;
}

// SSE listeners for C1: real-time progress
let sseClients: Array<{
  id: string;
  controller: ReadableStreamDefaultController;
}> = [];

function broadcastSSE(event: string, data: any) {
  // Heartbeat: a "progress" emit (fetch %/scoring) OR a "module" emit (fired
  // every 200 records during the per-record write loop) means the scan is alive
  // and moving forward. blockOrClearScan reads lastProgressAt so a long-but-
  // progressing sync is never mistaken for a stalled one and reset — the bug that
  // made the 68k-Contacts pull restart forever and never complete (Ahmad 2026-06-30).
  if (scanState.status === "scanning" && (event === "progress" || event === "module")) {
    scanState.lastProgressAt = Date.now();
  }
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients = sseClients.filter((client) => {
    try {
      client.controller.enqueue(new TextEncoder().encode(msg));
      return true;
    } catch {
      return false;
    }
  });
}

interface ExtractedRecord {
  companyName: string;
  email: string;
  phone: string;
  recordName: string;
  domain: string | null;
  ownerName: string;
  ownerEmail: string;
  status: string;
  stage?: string;
  dealValue?: number;
  source: string;
  createdTime: string;
  modifiedTime: string;
  layoutName?: string;
  layoutId?: string;
  zohoModule?: string;
  pipeline?: string;
  products?: string;
  mobile?: string;
  contactName?: string;
  accountName?: string;
  crNumber?: string;
  vatNumber?: string;
  website?: string;
  country?: string;
  region?: string;
  industry?: string;
  noOfEmployees?: number;
  title?: string;
  leadType?: string;
  govType?: string;
  accountType?: string;
}

// Errors that indicate the database is in a state where NO record will ever
// succeed — schema drift, missing column, missing extension, exhausted
// connection pool, etc. When we hit one of these, swallowing it per-record
// just lets the loop "complete" with 0 writes and stamps the sync chip green.
// That is the exact silent-failure mode that made the radar look empty in
// May 2026. Treat these as fatal: bubble out so the whole scan fails loudly.
function isFatalPersistenceError(err: any): boolean {
  const msg = String(err?.message || err || "");
  const code = String(err?.code || "");
  // Postgres SQLSTATE class:
  //   42xxx — syntax error / schema mismatch (missing column, undefined func)
  //   53xxx — out of resources (connection pool exhausted, disk full)
  //   57xxx — operator intervention (admin shutdown, query canceled)
  //   58xxx — system error
  //   08xxx — connection exception
  if (/^(08|42|53|57|58)\d{3}$/.test(code)) return true;
  // Generic "column does not exist" / "relation does not exist" string match
  // for cases where the driver doesn't surface the SQLSTATE code cleanly.
  if (/column .* does not exist/i.test(msg)) return true;
  if (/relation .* does not exist/i.test(msg)) return true;
  if (/no such column/i.test(msg)) return true;
  if (/connection terminated/i.test(msg)) return true;
  if (/too many connections/i.test(msg)) return true;
  return false;
}

async function processModule(
  moduleName: string,
  recordType: "lead" | "deal" | "contact" | "account",
  clustersUpdated: Set<number>,
  extractRecord: (record: any) => ExtractedRecord,
  // Incremental sync: when set (ISO8601), only records modified at/after this
  // time are fetched from Zoho (via the If-Modified-Since header). undefined =
  // full pull (first sync, or an explicit "Rebuild all").
  ifModifiedSince?: string,
  // Live progress reporter — receives this module's completion fraction (0..1)
  // as it fetches then writes, so the caller can advance the shared 10→60%
  // "fetch band" smoothly instead of leaving it frozen at 10% until every
  // module's parallel Promise.all settles. Never throws into the loop.
  onProgress?: (frac: number) => void,
): Promise<{ count: number; written: number; skipped: number }> {
  const t0 = Date.now();
  let records: any[] = [];
  scanState.moduleStatuses[moduleName] = "fetching";
  broadcastSSE("module", { module: moduleName, status: "fetching" });

  try {
    await upsertSyncState(moduleName, 0, "syncing");
    records = await fetchAllZohoRecords(moduleName, {
      maxRecords: SCAN_MAX_PER_MODULE,
      ifModifiedSince,
      // Surface live page counts: update the chip with the running fetched
      // total and nudge the fetch band (asymptotic — we don't know the total
      // page count up front, so approach ~0.45 of this module's slice).
      onProgress: (fetched, page) => {
        scanState.recordCounts[moduleName] = fetched;
        broadcastSSE("module", {
          module: moduleName,
          status: "fetching",
          count: fetched,
        });
        if (onProgress) onProgress(Math.min(0.45, 0.45 * (1 - 1 / (1 + page / 12))));
      },
    });
  } catch (e: any) {
    logger.error(`Error fetching ${moduleName}:`, e);
    scanState.moduleStatuses[moduleName] = "error";
    broadcastSSE("module", { module: moduleName, status: "error" });
    await upsertSyncState(moduleName, 0, "failed");
    // Resilience (Ahmad 2026-06-23): a module that rate-limits / errors is
    // already marked "failed" above (its chip shows "0 (failed)"), so DON'T
    // abort the whole scan — let the OTHER modules finish and ADVANCE THEIR
    // cursors. This breaks the stuck-sync cycle: when one huge module (e.g.
    // Leads) can't complete in one window, the smaller modules still sync, and
    // the next run only retries the failed one against a fresh cursor instead
    // of re-pulling everything from scratch every time. (Previously a single
    // rate-limit threw and failed the entire run, so nothing ever advanced.)
    return { count: 0, written: 0, skipped: 0 };
  }

  logger.info(
    `📥 [DuplicateRadar] Fetched ${records.length} ${moduleName} from Zoho`,
  );
  scanState.moduleStatuses[moduleName] = "processing";
  scanState.recordCounts[moduleName] = records.length;
  broadcastSSE("module", {
    module: moduleName,
    status: "processing",
    count: records.length,
  });
  // Fetch sub-phase done — the write sub-phase fills the remaining half of
  // this module's slice (0.5 → 1.0), reported exactly by written/total below.
  if (onProgress) onProgress(0.5);

  let written = 0;
  let skipped = 0;
  let droppedNoCompany = 0;
  let processedInLoop = 0;
  for (const record of records) {
    try {
      const data = extractRecord(record);
      if (!data.companyName || data.companyName === "Unknown") {
        // Previously a silent `continue`. Now we count it so the post-loop
        // summary can flag a Zoho layout that doesn't populate Company /
        // Account_Name / Last_Name as expected — that was the only other
        // explanation for an apparently-successful sync with 0 writes.
        droppedNoCompany++;
        continue;
      }

      const cluster = await findOrCreateClusterByCompany(
        data.companyName,
        data.domain || undefined,
        data.phone || undefined,
        data.email || undefined,
        // Pass recordType + recordName so contacts route to the strict
        // ≥2-attribute path; every other module keeps the legacy
        // company-name clustering behaviour verbatim.
        recordType,
        data.recordName,
        // Zoho id → lets the clusterer honor the separation ledger so a record
        // the operator split/dismissed apart is never silently re-fused.
        record.id,
      );

      await upsertRecord({
        cluster_id: cluster.id!,
        record_type: recordType,
        zoho_record_id: record.id,
        record_name: data.recordName,
        company_name: data.companyName,
        email: data.email || undefined,
        domain: data.domain || undefined,
        phone: data.phone || undefined,
        mobile: data.mobile || undefined,
        owner_name: data.ownerName,
        owner_email: data.ownerEmail,
        status: data.status,
        stage: data.stage,
        deal_value: data.dealValue,
        source: data.source,
        created_date: data.createdTime
          ? new Date(data.createdTime)
          : new Date(),
        modified_date: data.modifiedTime
          ? new Date(data.modifiedTime)
          : new Date(),
        is_primary: false,
        confidence_score: 0,
        is_mock_data: false,
        raw_data: record.data,
        layout_name: data.layoutName,
        layout_id: data.layoutId,
        zoho_module: data.zohoModule || moduleName,
        pipeline: data.pipeline,
        products: data.products,
        contact_name: data.contactName,
        account_name: data.accountName,
        cr_number: data.crNumber,
        vat_number: data.vatNumber,
        website: data.website,
        country: data.country,
        region: data.region,
        industry: data.industry,
        no_of_employees: data.noOfEmployees,
        title: data.title,
        lead_type: data.leadType,
        gov_type: data.govType,
        account_type: data.accountType,
      });

      written++;
      clustersUpdated.add(cluster.id!);
    } catch (recordErr: any) {
      // Schema/connection-class errors mean NO record will succeed — fail
      // the whole scan loudly instead of looping through 5,000 identical
      // failures and stamping "completed" at the end.
      if (isFatalPersistenceError(recordErr)) {
        logger.error(
          `❌ [DuplicateRadar] Fatal persistence error on ${moduleName} record ${record.id} — aborting scan:`,
          recordErr,
        );
        await upsertSyncState(moduleName, written, "failed");
        throw recordErr;
      }
      skipped++;
      if (skipped <= 5)
        logger.warn(
          `⚠️ [DuplicateRadar] Skipped ${moduleName} record ${record.id}: ${recordErr}`,
        );
    }
    processedInLoop++;
    if (processedInLoop % 200 === 0) {
      broadcastSSE("module", {
        module: moduleName,
        status: "processing",
        count: written,
      });
      if (onProgress && records.length > 0)
        onProgress(0.5 + 0.5 * (processedInLoop / records.length));
    }
  }
  if (droppedNoCompany > 0)
    logger.warn(
      `⚠️ [DuplicateRadar] ${moduleName}: dropped ${droppedNoCompany} record(s) with no extractable company name (Zoho layout likely missing Company / Account_Name / Last_Name)`,
    );
  if (skipped > 0)
    logger.warn(
      `⚠️ [DuplicateRadar] Skipped ${skipped} ${moduleName} records due to errors`,
    );

  scanState.moduleStatuses[moduleName] = "done";
  if (onProgress) onProgress(1);
  broadcastSSE("module", {
    module: moduleName,
    status: "done",
    count: written,
  });
  // INSTRUMENTATION (2026-06-20) — per-module timing so a slow sync is
  // diagnosable from the logs: how long each module took, how many records
  // it fetched vs wrote. A module that dominates the wall-clock (rate-limited
  // fetch or a huge changed-set) shows up here immediately.
  logger.info(
    `⏱️ [DuplicateRadar] ${moduleName} done in ${((Date.now() - t0) / 1000).toFixed(1)}s — fetched ${records.length}, written ${written}, skipped ${skipped + droppedNoCompany}`,
  );
  // CHIP HONESTY: report the count actually persisted to the database, not
  // the count fetched from Zoho. Previously this passed records.length even
  // when every upsertRecord threw — sync_status went 'completed' / 5000
  // while duplicate_records stayed empty, which is what hid the silent
  // failure for weeks. If `written < records.length` something dropped
  // rows; if `written === 0 && records.length > 0` the chip will say
  // "0 (completed)" instead of lying about 5,000.
  await upsertSyncState(moduleName, written, "completed");
  return { count: records.length, written, skipped: skipped + droppedNoCompany };
}

/**
 * Run module-fetch tasks with bounded concurrency. Default 1 (sequential) keeps
 * the number of simultaneous Zoho API calls low so a multi-module sync doesn't
 * trip Zoho's rate / concurrency limit — the cause of "Leads/Deals/Accounts:
 * error" while one module squeaked through. A task that throws still rejects
 * (same as Promise.all). Results preserve input order.
 */
async function runModulesWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, tasks.length));
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= tasks.length) break;
      results[i] = await tasks[i]!();
    }
  };
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

// Detect records deleted/merged inside Zoho CRM since the last successful sync
// and purge them from the duplicate radar. Without this, a manual Zoho merge
// would leave the losing record visible in the radar forever (Modified_Time
// filters never return deleted records).
async function runDeletionDetection(clustersUpdated: Set<number>): Promise<{
  totalRemoved: number;
  perModule: Record<string, number>;
}> {
  const modules: Array<{ name: string }> = [
    { name: "Leads" },
    { name: "Deals" },
    { name: "Contacts" },
    { name: "Accounts" },
  ];
  const perModule: Record<string, number> = {};
  let totalRemoved = 0;

  for (const m of modules) {
    try {
      const syncState = await getSyncState(m.name);
      const since = syncState?.last_sync_at || undefined;
      // Skip on first ever sync — no baseline to diff against, and the
      // initial fetch will populate the radar from scratch anyway.
      if (!since) {
        perModule[m.name] = 0;
        continue;
      }
      const deleted = await fetchDeletedZohoRecords(m.name, {
        type: "all",
        modifiedSince: since,
      });
      if (deleted.length === 0) {
        perModule[m.name] = 0;
        continue;
      }
      const ids = deleted.map((d) => d.id).filter(Boolean);
      const { removedCount, affectedClusterIds } = await removeRecordsByZohoIds(
        ids,
        { module: m.name },
      );
      affectedClusterIds.forEach((id) => clustersUpdated.add(id));
      perModule[m.name] = removedCount;
      totalRemoved += removedCount;
    } catch (e: any) {
      logger.warn(
        `⚠️ [DuplicateRadar] Deletion detection failed for ${m.name} (non-fatal):`,
        e?.message || e,
      );
      perModule[m.name] = 0;
    }
  }
  return { totalRemoved, perModule };
}

async function scanZohoCRMForDuplicates(
  detectionType: "manual" | "scheduled" | "interval-fallback" = "manual",
  // When true, force a FULL rebuild (wipe + re-pull every record) instead of
  // the default incremental (changed-records-only) sync. Wired to a "Rebuild
  // all" control; routine syncs stay incremental and finish in ~1-2 min.
  forceFull = false,
): Promise<{
  success: boolean;
  totalRecordsScanned: number;
  totalClustersFound: number;
  duplicatesDetected: number;
  highConfidence: number;
  mediumConfidence: number;
  moduleBreakdown: any[];
  pipelineInflation: number;
  durationMs: number;
  error?: string;
}> {
  const startTime = Date.now();

  // SINGLE-FLIGHT GUARD (Ahmad 2026-06-30): the scheduled crons + the in-process
  // fallback call this function DIRECTLY (not via the /scan endpoint), so they
  // previously bypassed blockOrClearScan and could start a SECOND scan on top of
  // a healthy long-running one — abandoning the in-flight 68k-Contacts pass
  // (its terminal write gets fenced) so it never finished. Centralise the guard
  // here: if a scan is already running AND still making progress (heartbeat fresh),
  // skip this trigger instead of clobbering it. A genuinely stalled run (no
  // progress for STALE_SCAN_MS) is released and we take over. The /scan + /rebuild
  // endpoints still call blockOrClearScan first for their force-reset semantics.
  const blocked = blockOrClearScan(false);
  if (blocked) {
    logger.info(
      `⏭️ [DuplicateRadar] Skipping ${detectionType} scan — a healthy scan is already in progress (running ${blocked.ageMinutes}m, still making progress).`,
    );
    return {
      success: true,
      totalRecordsScanned: 0,
      totalClustersFound: 0,
      duplicatesDetected: 0,
      highConfidence: 0,
      mediumConfidence: 0,
      moduleBreakdown: [],
      pipelineInflation: 0,
      durationMs: 0,
      error: "skipped — a healthy scan is already in progress",
    };
  }

  // Claim this generation; terminal writes below are gated on it still being
  // current, so a stale concurrent run can't overwrite a newer run's state.
  const myGeneration = ++scanGeneration;
  logger.info(
    `🔍 [DuplicateRadar] Starting Zoho CRM duplicate scan (${detectionType}) [gen ${myGeneration}]...`,
  );

  scanState.status = "scanning";
  scanState.startedAt = startTime;
  scanState.lastProgressAt = startTime; // heartbeat starts now
  scanState.progress = "Initializing scan...";
  scanState.result = null;
  scanState.error = null;
  scanState.moduleStatuses = {
    Leads: "pending",
    Deals: "pending",
    Contacts: "pending",
    Accounts: "pending",
  };
  scanState.recordCounts = {};
  scanState.percentage = 0;

  broadcastSSE("scan", { status: "started", timestamp: startTime });

  try {
    // ── Persist "solved" BEFORE we re-cluster ────────────────────────────
    // Every scan (incremental OR full) re-clusters, which reassigns cluster_ids
    // and can drop status='resolved' / merge_actions — so the per-module
    // "solved" scoreboard kept collapsing to 0 each 6-hourly sync. Snapshot the
    // current solved-state into the durable resolution-ledger (keyed by survivor
    // Zoho id) FIRST, so the breakdown's ledger join re-credits "solved" to
    // whatever cluster each survivor lands in after this scan. Idempotent +
    // best-effort (never blocks the scan).
    await backfillResolutionLedger().catch((e) =>
      logger.warn(
        `[DuplicateRadar] pre-scan ledger snapshot skipped (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      ),
    );

    // ── Decide FULL vs INCREMENTAL ───────────────────────────────────────
    // Incremental = fetch only records modified since each module's last
    // successful sync (Zoho If-Modified-Since header) and DON'T wipe existing
    // data — updates land in place (upsertRecord is idempotent by Zoho id) and
    // the deletion-detection pass purges merged/deleted rows.
    //
    // PER-MODULE: incremental kicks in as soon as ANY module has a baseline
    // (not all four). Each module independently does an incremental fetch if IT
    // has a last_sync_at, else a full pull — so if a heavy module (Contacts,
    // 56k) never finished and has no baseline, only IT does the full pull while
    // Leads/Deals/Accounts go incremental. This breaks the "full never
    // completes → no baseline → always full → freezes again" trap. The
    // first-ever sync (no baseline anywhere) or an explicit "Rebuild all"
    // (forceFull / DUPLICATE_SCAN_MODE=full) does a clean full rebuild.
    // Order = fetch order (Ahmad 2026-06-23): the preflight client directory +
    // duplicate detection lean on Deals/Accounts, so fetch those FIRST and the
    // giant Leads module LAST — if Leads exhausts the window, the critical
    // modules already synced (paired with the per-module resilience above).
    const SCAN_MODULES = ["Deals", "Contacts", "Accounts", "Leads"] as const;
    const envFull = (process.env.DUPLICATE_SCAN_MODE || "incremental") === "full";
    const baselines: Record<string, string | undefined> = {};
    for (const m of SCAN_MODULES) {
      const st = await getSyncState(m);
      baselines[m] = st?.last_sync_at
        ? new Date(st.last_sync_at).toISOString()
        : undefined;
    }
    const anyBaseline = SCAN_MODULES.some((m) => !!baselines[m]);
    const incremental = !forceFull && !envFull && anyBaseline;

    // Per-module: incremental only for modules that already have a baseline;
    // modules without one fetch in full (and, because we skip the global wipe
    // in incremental mode, their full upsert just refreshes those rows).
    // 10-min safety overlap so records modified mid-sync aren't missed
    // (re-processing a handful is harmless — upsert is idempotent by Zoho id).
    const sinceFor = (m: string): string | undefined => {
      if (!incremental || !baselines[m]) return undefined;
      return new Date(new Date(baselines[m]!).getTime() - 10 * 60 * 1000).toISOString();
    };

    scanState.progress = incremental
      ? "Preparing incremental scan (changed records only)..."
      : "Preparing full rebuild...";
    scanState.percentage = 5;
    logger.info(
      `🔁 [DuplicateRadar] Scan mode: ${incremental ? "INCREMENTAL (changed-only)" : "FULL rebuild"}` +
        (forceFull ? " [forced]" : ""),
    );
    // Full rebuild wipes first; incremental keeps existing data and updates it.
    if (!incremental) {
      await clearAllDuplicateData();
    }

    const moduleBreakdown: any[] = [];
    let totalRecords = 0;
    const clustersUpdated = new Set<number>();

    // B3: Module fetch (sequential by default — see runModulesWithConcurrency)
    scanState.progress = incremental
      ? "Fetching changed records from Zoho CRM..."
      : "Fetching all modules from Zoho CRM...";
    scanState.percentage = 10;
    broadcastSSE("progress", {
      percentage: 10,
      message: incremental ? "Fetching changed records..." : "Fetching all modules...",
    });

    // Shared fetch-band progress (10 → 60%). Each of the 4 parallel modules
    // reports its own 0..1 completion fraction; the bar = 10 + 50 × average,
    // so it climbs smoothly while modules fetch + write instead of freezing at
    // 10% until the whole Promise.all settles. Monotonic (never moves back).
    const FETCH_BAND_START = 10;
    const FETCH_BAND_END = 60;
    const moduleFrac: Record<string, number> = {
      Leads: 0,
      Deals: 0,
      Contacts: 0,
      Accounts: 0,
    };
    let lastBandPct = FETCH_BAND_START;
    const reportFetch = (mod: string, frac: number) => {
      moduleFrac[mod] = Math.max(moduleFrac[mod] ?? 0, Math.min(1, frac));
      const avg =
        (moduleFrac.Leads +
          moduleFrac.Deals +
          moduleFrac.Contacts +
          moduleFrac.Accounts) /
        4;
      const pct = Math.min(
        FETCH_BAND_END,
        FETCH_BAND_START +
          Math.round((FETCH_BAND_END - FETCH_BAND_START) * avg),
      );
      if (pct > lastBandPct) {
        lastBandPct = pct;
        scanState.percentage = pct;
        broadcastSSE("progress", {
          percentage: pct,
          message: scanState.progress,
        });
      }
    };

    // Fetch modules with BOUNDED concurrency (default 1 = sequential). Fetching
    // all 4 modules in parallel × ZOHO_FETCH_CONCURRENCY pages each meant up to
    // ~16 simultaneous Zoho calls, which tripped Zoho's rate/concurrency limit
    // and failed 3 of 4 modules. Sequential keeps it to one module at a time.
    // Tune with DUPLICATE_MODULE_CONCURRENCY (1–4).
    const MODULE_CONCURRENCY = (() => {
      const n = parseInt(process.env.DUPLICATE_MODULE_CONCURRENCY || "", 10);
      return Number.isFinite(n) && n >= 1 && n <= 4 ? n : 1;
    })();
    // Destructure in the SAME order as the task array below (Deals, Contacts,
    // Accounts, Leads) — runModulesWithConcurrency preserves input order.
    const [dealsResult, contactsResult, accountsResult, leadsResult] =
      await runModulesWithConcurrency([
        () => processModule("Deals", "deal", clustersUpdated, (record) => {
          const d = record.data;
          // Reflect the CS "Company Domain" field (e.g. riyadbank.com) into the
          // deal's domain column — it's the customer's real domain, whereas the
          // Contact_Email is often empty/personal. Same extractor the CS
          // Lifecycle uses (env-override + fuzzy field name), so a client deal's
          // domain is recognised platform-wide (radar, clustering, preflight).
          const csDomain = extractCsFieldsFromRawData(d, {}).company_domain;
          return {
            companyName: d.Account_Name?.name || d.Deal_Name || "Unknown",
            email: d.Contact_Email || "",
            phone: d.Contact_Phone || "",
            recordName: d.Deal_Name || "Unknown Deal",
            domain: csDomain || extractDomain(d.Contact_Email || ""),
            ownerName: d.Owner?.name || "Unknown",
            ownerEmail: d.Owner?.email || "",
            status: "",
            stage: d.Stage || "",
            dealValue: parseFloat(d.Amount) || 0,
            source: d.Lead_Source || "",
            createdTime: d.Created_Time || "",
            modifiedTime: d.Modified_Time || "",
            layoutName: d.Layout?.name || d.$layout?.name || "",
            layoutId: d.Layout?.id || d.$layout?.id || "",
            zohoModule: "Deals",
            pipeline: d.Pipeline || "",
            products: d.Product_Details
              ? JSON.stringify(d.Product_Details)
              : "",
            contactName: d.Contact_Name?.name || "",
            accountName: d.Account_Name?.name || "",
          };
        }, sinceFor("Deals"), (frac) => reportFetch("Deals", frac)),
        () => processModule("Contacts", "contact", clustersUpdated, (record) => {
          const d = record.data;
          return {
            companyName:
              d.Account_Name?.name || d.Company || d.Last_Name || "Unknown",
            email: d.Email || "",
            phone: d.Phone || "",
            mobile: d.Mobile || "",
            recordName:
              d.Full_Name ||
              `${d.First_Name || ""} ${d.Last_Name || ""}`.trim(),
            domain: extractDomain(d.Email || ""),
            ownerName: d.Owner?.name || "Unknown",
            ownerEmail: d.Owner?.email || "",
            status: "Contact",
            source: d.Lead_Source || "",
            createdTime: d.Created_Time || "",
            modifiedTime: d.Modified_Time || "",
            layoutName: d.Layout?.name || d.$layout?.name || "",
            layoutId: d.Layout?.id || d.$layout?.id || "",
            zohoModule: "Contacts",
            title: d.Title || "",
            accountName: d.Account_Name?.name || "",
            country: d.Mailing_Country || d.Other_Country || "",
          };
        }, sinceFor("Contacts"), (frac) => reportFetch("Contacts", frac)),
        () => processModule("Accounts", "account", clustersUpdated, (record) => {
          const d = record.data;
          const websiteRaw = d.Website || "";
          const websiteDomain =
            websiteRaw.replace(/^https?:\/\/(www\.)?/, "").split("/")[0] || "";
          return {
            companyName: d.Account_Name || "Unknown",
            email: d.Email || "",
            phone: d.Phone || "",
            recordName: d.Account_Name || "Unknown",
            domain:
              extractDomain(d.Email || "") ||
              (websiteDomain && !websiteDomain.includes(" ")
                ? websiteDomain
                : null),
            ownerName: d.Owner?.name || "Unknown",
            ownerEmail: d.Owner?.email || "",
            status: "Account",
            source: "Account",
            createdTime: d.Created_Time || "",
            modifiedTime: d.Modified_Time || "",
            layoutName: d.Layout?.name || d.$layout?.name || "",
            layoutId: d.Layout?.id || d.$layout?.id || "",
            zohoModule: "Accounts",
            website: websiteRaw,
            crNumber: d.CR_Number || d.Registration_Number || "",
            vatNumber: d.VAT_Number || d.Tax_ID || "",
            country: d.Billing_Country || d.Shipping_Country || "",
            region: d.Billing_State || d.Shipping_State || "",
            industry: d.Industry || "",
            noOfEmployees: parseInt(d.Employees) || undefined,
            accountType: d.Account_Type || "",
          };
        }, sinceFor("Accounts"), (frac) => reportFetch("Accounts", frac)),
        () => processModule("Leads", "lead", clustersUpdated, (record) => {
          const d = record.data;
          return {
            companyName: d.Company || d.Last_Name || "Unknown",
            email: d.Email || "",
            phone: d.Phone || "",
            mobile: d.Mobile || "",
            recordName:
              d.Full_Name ||
              `${d.First_Name || ""} ${d.Last_Name || ""}`.trim(),
            domain: extractDomain(d.Email || ""),
            ownerName: d.Owner?.name || "Unknown",
            ownerEmail: d.Owner?.email || "",
            status: d.Lead_Status || "",
            source: d.Lead_Source || "",
            createdTime: d.Created_Time || "",
            modifiedTime: d.Modified_Time || "",
            layoutName: d.Layout?.name || d.$layout?.name || "",
            layoutId: d.Layout?.id || d.$layout?.id || "",
            zohoModule: "Leads",
            title: d.Designation || d.Title || "",
            leadType: d.Lead_Type || "",
            country: d.Country || "",
            industry: d.Industry || "",
            website: d.Website || "",
          };
        }, sinceFor("Leads"), (frac) => reportFetch("Leads", frac)),
      ], MODULE_CONCURRENCY);

    // All-modules-failed guard (Ahmad 2026-06-23): the per-module resilience
    // above intentionally lets a PARTIAL sync complete (some modules synced) —
    // but if EVERY module failed (Zoho outage / OAuth cooldown / connectivity),
    // don't let the scan report a green "done" with 0 records (which reads as
    // "data is fresh"). Fail loudly so the operator knows it did NOT complete.
    if (SCAN_MODULES.every((m) => scanState.moduleStatuses[m] === "error")) {
      throw new Error(
        "Zoho sync failed for every module (rate-limit / OAuth cooldown or connectivity) — no data was fetched. The scan did not complete; please retry.",
      );
    }

    // Tasks pagination removed per platform-wide Tasks data removal.
    // `totalRecords` was previously the count fetched from Zoho — that
    // counter looked healthy even when every upsertRecord threw. Use
    // `written` (the count actually persisted) so the scan summary, the
    // detection log, and the dashboard agree with what's queryable.
    totalRecords =
      leadsResult.written +
      dealsResult.written +
      contactsResult.written +
      accountsResult.written;
    const totalFetched =
      leadsResult.count +
      dealsResult.count +
      contactsResult.count +
      accountsResult.count;
    const totalSkipped =
      leadsResult.skipped +
      dealsResult.skipped +
      contactsResult.skipped +
      accountsResult.skipped;
    moduleBreakdown.push(
      { module: "Leads",    fetched: leadsResult.count,    written: leadsResult.written,    skipped: leadsResult.skipped },
      { module: "Deals",    fetched: dealsResult.count,    written: dealsResult.written,    skipped: dealsResult.skipped },
      { module: "Contacts", fetched: contactsResult.count, written: contactsResult.written, skipped: contactsResult.skipped },
      { module: "Accounts", fetched: accountsResult.count, written: accountsResult.written, skipped: accountsResult.skipped },
    );

    // Loud signal in the server log when a sync persisted nothing despite
    // fetching records. Operators tailing logs catch this immediately; the
    // chip showing "0 (completed)" instead of "5000 (completed)" is the
    // user-facing tell.
    if (totalFetched > 0 && totalRecords === 0) {
      logger.error(
        `❌ [DuplicateRadar] Scan persisted 0 records despite fetching ${totalFetched} from Zoho — every upsert was skipped or threw. Check the warnings above (${totalSkipped} skipped).`,
      );
    } else if (totalSkipped > 0) {
      logger.warn(
        `⚠️ [DuplicateRadar] Scan wrote ${totalRecords}/${totalFetched} records (${totalSkipped} skipped across all modules)`,
      );
    }

    scanState.percentage = 60;
    broadcastSSE("progress", {
      percentage: 60,
      message: `All modules fetched (${totalFetched} from Zoho, ${totalRecords} persisted)`,
    });

    // Deletion-detection pass: ask Zoho which records were deleted/merged
    // since our last sync and purge them locally. This is what makes a
    // manual Zoho merge propagate into the duplicate radar.
    const scanMode = process.env.DUPLICATE_SCAN_MODE || "incremental";
    scanState.progress = "Checking Zoho for deleted/merged records...";
    broadcastSSE("progress", {
      percentage: 62,
      message: "Checking Zoho for deletions...",
    });
    const deletionResult = await runDeletionDetection(clustersUpdated);
    if (deletionResult.totalRemoved > 0) {
      logger.info(
        `🗑️ [DuplicateRadar] Deletion-detection removed ${deletionResult.totalRemoved} record(s):`,
        deletionResult.perModule,
      );
      broadcastSSE("progress", {
        percentage: 65,
        message: `Removed ${deletionResult.totalRemoved} deleted/merged Zoho records`,
      });
    }

    // Cleanup stale records (legacy, mostly a no-op now) and orphan clusters
    if (scanMode !== "full") {
      scanState.progress = "Cleaning up orphan clusters...";
      await cleanupStaleRecords();
      await cleanupOrphanClusters();
    }

    scanState.percentage = 70;

    scanState.progress = `All modules fetched (${totalRecords} records). Scoring ${clustersUpdated.size} clusters...`;
    logger.info(
      `📊 [DuplicateRadar] Updating stats for ${clustersUpdated.size} clusters...`,
    );
    // Scoring is the 70→95% phase. Previously single-threaded (one
    // updateClusterStats await per cluster) — with 10k+ clusters that's the
    // dominant tail of a full rebuild. Run it in bounded-concurrency batches
    // so the DB pool is used efficiently without being overwhelmed. Tune via
    // DUPLICATE_SCORE_CONCURRENCY (default 8). A single cluster's scoring
    // failure is logged and skipped, not allowed to abort the whole scan.
    const scoreConcEnv = parseInt(
      process.env.DUPLICATE_SCORE_CONCURRENCY || "",
      10,
    );
    const SCORE_CONCURRENCY =
      Number.isFinite(scoreConcEnv) && scoreConcEnv >= 1 && scoreConcEnv <= 32
        ? scoreConcEnv
        : 8;
    const clusterIds = Array.from(clustersUpdated);
    const scoreT0 = Date.now();
    let processed = 0;
    for (let i = 0; i < clusterIds.length; i += SCORE_CONCURRENCY) {
      const batch = clusterIds.slice(i, i + SCORE_CONCURRENCY);
      await Promise.all(
        batch.map((clusterId) =>
          updateClusterStats(clusterId).catch((e) =>
            logger.warn(
              `[DuplicateRadar] cluster ${clusterId} scoring failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
            ),
          ),
        ),
      );
      processed += batch.length;
      if (processed % 200 < SCORE_CONCURRENCY || processed === clusterIds.length) {
        const pct =
          clusterIds.length > 0
            ? 70 + Math.round((processed / clusterIds.length) * 25)
            : 95;
        scanState.progress = `Scoring clusters: ${processed}/${clusterIds.length}...`;
        scanState.percentage = pct;
        broadcastSSE("progress", {
          percentage: pct,
          message: `Scoring: ${processed}/${clusterIds.length}`,
        });
      }
    }
    logger.info(
      `⏱️ [DuplicateRadar] Scored ${clusterIds.length} clusters in ${((Date.now() - scoreT0) / 1000).toFixed(1)}s (concurrency ${SCORE_CONCURRENCY})`,
    );

    // Layer-2 of Mark-Handled persistence (Sarah 2026-06-16). Every scan
    // re-clusters records and the new cluster row defaults to status='active'
    // even when the survivor Zoho ids are in the resolution ledger from a
    // prior Mark Handled click. Walk active clusters now and flip status back
    // to 'resolved' when every present module has a ledger match — this is
    // the durable counterpart to the view-time filter in getCrossModuleOverlaps.
    // Auto-merge contacts that were tagged "pending Zoho admin delete" → resolve
    // them now IF the admin has actually deleted the tagged duplicates (so they
    // stay AI-Applied · pending until then). Must run BEFORE the ledger-restore
    // below, which reads the entries this writes.
    await reconcileAutoMergedContactDeletions().catch((e) =>
      logger.warn(
        `[DuplicateRadar] auto-merge deletion reconcile skipped (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      ),
    );

    // Reconcile empty-delete ledger: flip pending_delete → deleted for any
    // record the admin has actually removed from Zoho since the last sync.
    await (await import("../../utils/emptyRecordsDatabase"))
      .reconcileEmptyDeleteDeletions()
      .catch(() => {});

    await restoreLedgerResolvedClusterStatus().catch((e) =>
      logger.warn(
        `[DuplicateRadar] post-scan ledger restore skipped (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      ),
    );

    // Record today's per-tab progress snapshot (open / solved / total) so the
    // Duplicate Radar has a daily burndown per module, not just a live number.
    // Upsert-per-day: this keeps today's row current on every scan.
    await captureDuplicateProgressSnapshot().catch((e) =>
      logger.warn(
        `[DuplicateRadar] post-scan progress snapshot skipped (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      ),
    );

    const summary = await getEnhancedSummary();
    const duration = Date.now() - startTime;

    await createDetectionLog({
      detection_type: detectionType,
      total_records_scanned: totalRecords,
      total_clusters_found: clustersUpdated.size,
      total_duplicates_detected: summary.trueDuplicateClusters,
      high_confidence_count: summary.highConfidence,
      medium_confidence_count: summary.mediumConfidence,
      low_confidence_count: summary.lowConfidence,
      estimated_pipeline_inflation: summary.estimatedPipelineInflation,
      detection_duration_ms: duration,
      triggered_by:
        detectionType === "scheduled"
          ? "Automated Weekly Scan"
          : "Zoho CRM Scan",
      status: "completed",
      completed_at: new Date(),
    });

    logger.info(
      `✅ [DuplicateRadar] Scan complete: ${totalRecords} records, ${summary.trueDuplicateClusters} true duplicate clusters, ${summary.highConfidence} high confidence`,
    );

    const resultData = {
      success: true,
      totalRecordsScanned: totalRecords,
      totalClustersFound: clustersUpdated.size,
      duplicatesDetected: summary.trueDuplicateClusters,
      highConfidence: summary.highConfidence,
      mediumConfidence: summary.mediumConfidence,
      moduleBreakdown,
      pipelineInflation: summary.estimatedPipelineInflation,
      durationMs: duration,
    };

    if (myGeneration === scanGeneration) {
      scanState.status = "completed";
      scanState.completedAt = Date.now();
      scanState.progress = `Complete: ${totalRecords} records scanned, ${summary.trueDuplicateClusters} duplicate clusters found`;
      scanState.result = resultData;
      scanState.percentage = 100;
      broadcastSSE("scan", { status: "completed", result: resultData });
    } else {
      logger.warn(
        `[DuplicateRadar] Scan gen ${myGeneration} finished but a newer scan (gen ${scanGeneration}) owns the state — not overwriting.`,
      );
    }

    return resultData;
  } catch (error: any) {
    logger.error("❌ [DuplicateRadar] Scan error:", error);
    // Surface Zoho rate-limit cooldowns with a user-actionable message
    // instead of leaking the raw OAuth body or "An internal error occurred".
    const rateLimited =
      error?.isZohoRateLimited ||
      /too many requests/i.test(String(error?.message || ""));
    const userMessage = rateLimited
      ? "Zoho is temporarily rate-limited (too many token refresh attempts in a short window). Wait a few minutes, then click Run scan again."
      : error?.message || "An internal error occurred";

    const errorResult = {
      success: false,
      totalRecordsScanned: 0,
      totalClustersFound: 0,
      duplicatesDetected: 0,
      highConfidence: 0,
      mediumConfidence: 0,
      moduleBreakdown: [],
      pipelineInflation: 0,
      durationMs: Date.now() - startTime,
      error: userMessage,
    };

    if (myGeneration === scanGeneration) {
      scanState.status = "failed";
      scanState.completedAt = Date.now();
      scanState.progress = rateLimited
        ? "Scan failed — Zoho rate-limited"
        : "Scan failed";
      scanState.error = userMessage;
      scanState.result = errorResult;
      broadcastSSE("scan", { status: "failed", error: scanState.error });
    }

    return errorResult;
  }
}

export { scanZohoCRMForDuplicates };

initDuplicateRadarTables().catch((err) => {
  logger.error("Failed to initialize duplicate radar tables:", err);
});

export const duplicateRadarRoutes = [
  // ── Autonomous Resolution: status / manual run / grades / rules ─────────────
  {
    // Config + last run summary + current grades, for the status panel.
    path: "/api/duplicates/autonomous/status",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const cfg = await resolveResolutionRunConfig();
          const canManage = (AUTONOMOUS_RESOLUTION_MANAGE_ROLES as readonly string[]).includes(
            (user as any)?.role,
          );
          const grades = await getGradeHistory(undefined, 4 * 8).catch(() => []);
          // Latest grade per module from the history (history is DESC).
          const latestByModule: Record<string, any> = {};
          for (const g of grades) {
            if (!latestByModule[g.module]) latestByModule[g.module] = g;
          }
          return c.json({
            config: cfg,
            can_manage: canManage,
            slack: { configured: isResolutionSlackConfigured() },
            grades_latest: Object.values(latestByModule),
            module_breakdown: await getModuleResolutionBreakdown().catch(() => []),
            learnings: await getResolutionLearnings().catch(() => null),
          });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // One-tap EXECUTIVE BRIEF — assembles the real aggregate figures into a
    // board-ready, shareable text block (CEO/CCO). Deterministic (no LLM), so
    // it's consistent and never hallucinates a number. Same framing Adam uses.
    path: "/api/duplicates/autonomous/executive-brief",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          // Shared deterministic builder (same one the weekly digest uses);
          // withTrend shows week-over-week vs the last weekly snapshot.
          const { brief, metrics } = await buildExecutiveBriefText({ withTrend: true });
          return c.json({ brief, generated_at: new Date().toISOString(), data: metrics });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Adam's notification schedule (single source of truth) — for the platform
    // "Notification Schedule" card. Reviewed monthly; timings edited via env.
    path: "/api/duplicates/autonomous/notification-schedule",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          return c.json({ schedule: ADAM_NOTIFICATION_SCHEDULE });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Post a (generated) executive brief to the resolution Slack channel.
    path: "/api/duplicates/autonomous/executive-brief/post",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const body = await c.req.json().catch(() => ({}));
          const text = String(body?.text || "").trim().slice(0, 6000);
          if (!text) return c.json({ error: "Nothing to post." }, 400);
          const stamped =
            text + `\n\n_Shared by ${(user as any)?.email || "an operator"} from the Autonomous Resolution screen._`;
          const res = await postResolutionMessage(stamped);
          if (!res.ok) return c.json({ error: res.error || "Slack post failed" }, 502);
          return c.json({ ok: true, channel: res.channel });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // "Send weekly brief now" — manually fire the SAME weekly leadership job
    // (posts to both channels), but WITHOUT recording a trend snapshot so the
    // Sunday-anchored week-over-week math stays intact. Management-tier only,
    // since it broadcasts to leadership channels.
    path: "/api/duplicates/autonomous/weekly-brief/send",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRoleOrKey(c, [...AUTONOMOUS_RESOLUTION_MANAGE_ROLES]);
          if (!user) return unauthorizedResponse(c);
          const res = await postWeeklyExecBrief({ recordSnapshot: false });
          if (!res.ok) {
            return c.json({ error: (res.errors || []).join("; ") || "Slack post failed" }, 502);
          }
          return c.json({ ok: true, posted: res.posted, errors: res.errors });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Safe-tier vs escalated breakdown of the autonomous resolver's PENDING
    // proposals. verdict 'auto' = the agent is confident (would auto-apply once
    // in assisted mode); 'escalate' = needs a human. Lets an operator see the
    // scope before flipping shadow → assisted.
    //   GET /api/duplicates/autonomous/proposal-tiers
    path: "/api/duplicates/autonomous/proposal-tiers",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const { pool } = await import("../../utils/duplicateRadarDatabase");
          const r = await pool.query(
            `SELECT COALESCE(payload->>'verdict','unknown') AS verdict, COUNT(*)::int AS n
               FROM ai_pending_actions
              WHERE tool_id = 'duplicate-resolution' AND status = 'pending'
              GROUP BY 1`,
          );
          let safeTier = 0,
            escalated = 0,
            other = 0;
          for (const row of r.rows) {
            if (row.verdict === "auto") safeTier = Number(row.n);
            else if (row.verdict === "escalate") escalated = Number(row.n);
            else other += Number(row.n);
          }
          return c.json({
            success: true,
            total: safeTier + escalated + other,
            safeTier,
            escalated,
            other,
          });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Hygiene & business rules catalog (Sarah 2026-06-20): the read-only list
    // of agreed data-hygiene / governance rules Adam enforces, surfaced on the
    // Autonomous Resolution screen so an operator can see what's being checked.
    //   GET /api/duplicates/hygiene-rules
    path: "/api/duplicates/hygiene-rules",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const { getHygieneRulesCatalog } = await import("../../utils/hygieneRulesCatalog");
          return c.json({ success: true, ...getHygieneRulesCatalog() });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Flag a hygiene rule for editing (Sarah 2026-06-20): record the operator's
    // requested change to event_logs so it can be reviewed/actioned. The rules
    // live in code (hygieneRulesCatalog.ts); this is the lightweight "I want
    // this edited" capture, not an in-place editor.
    //   POST /api/duplicates/hygiene-rules/flag  { tab, ruleId, note }
    path: "/api/duplicates/hygiene-rules/flag",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const body = await c.req.json().catch(() => ({}));
          const tab = String(body?.tab || "").slice(0, 64);
          const ruleId = String(body?.ruleId || "").slice(0, 64);
          const note = String(body?.note || "").slice(0, 1000).trim();
          if (!ruleId || !note) {
            return c.json({ error: "ruleId and note are required" }, 400);
          }
          const { logEvent } = await import("../../utils/eventLogsDatabase");
          await logEvent({
            userId: (user as any)?.userId ?? undefined,
            userEmail: (user as any)?.email ?? undefined,
            userRole: (user as any)?.role ?? undefined,
            actionType: "AI_ACTION",
            entityType: "SYSTEM",
            entityId: `hygiene-rule:${tab}/${ruleId}`,
            entityName: "Hygiene rule edit request",
            description: `Hygiene rule edit requested for ${tab}/${ruleId}: ${note}`,
            aiInvolved: false,
            severity: "INFO",
            module: "duplicate-radar",
          }).catch(() => {});
          return c.json({ success: true });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Rejection-pattern analysis (Sarah 2026-06-20): why deliberately-rejected
    // proposals were rejected, with recommend-only rule/threshold suggestions.
    //   GET /api/duplicates/autonomous/rejection-patterns?days=30
    path: "/api/duplicates/autonomous/rejection-patterns",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const url = new URL(c.req.url);
          const days = parseInt(url.searchParams.get("days") || "30", 10);
          const { analyzeRejectionPatterns } = await import("../../utils/rejectionPatterns");
          const data = await analyzeRejectionPatterns(
            Number.isFinite(days) && days > 0 ? days : 30,
          );
          return c.json({ success: true, ...data });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Bulk exact email+phone contact merge — PREVIEW (Sarah 2026-06-20).
    //   GET /api/duplicates/contacts/exact-match-preview
    path: "/api/duplicates/contacts/exact-match-preview",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const { previewExactContactMatches } = await import("../../utils/duplicateRadarDatabase");
          const data = await previewExactContactMatches();
          return c.json({ success: true, ...data });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Bulk exact email+phone contact merge — APPLY (admin-key gated, Sarah 2026-06-20).
    // Keeps the survivor, tags duplicates Duplicate-Delete (migrate-then-tag).
    //   POST /api/duplicates/contacts/exact-match-merge  { limit? }
    path: "/api/duplicates/contacts/exact-match-merge",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse: unauthorized } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorized(c);
          const body = await c.req.json().catch(() => ({}));
          const limit = parseInt(body?.limit, 10);
          const overrides: Record<string, string> = {};
          if (body?.overrides && typeof body.overrides === "object") {
            for (const [k, v] of Object.entries(body.overrides)) {
              if (typeof k === "string" && typeof v === "string" && v.trim()) overrides[k] = v.trim();
            }
          }
          const excludes: Record<string, string[]> = {};
          if (body?.excludes && typeof body.excludes === "object") {
            for (const [k, v] of Object.entries(body.excludes)) {
              if (typeof k === "string" && Array.isArray(v)) {
                const ids = v.map((x: any) => String(x || "").trim()).filter(Boolean);
                if (ids.length) excludes[k] = ids;
              }
            }
          }
          const performedBy =
            `${(sessionUser as any)?.email || "admin"} (bulk exact email+phone merge)`;
          const { applyExactContactMatches } = await import("../../utils/duplicateRadarDatabase");
          const result = await applyExactContactMatches({
            limit: Number.isFinite(limit) && limit > 0 ? limit : 300,
            performedBy,
            overrides,
            excludes,
          });
          return c.json({ success: true, ...result });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Bulk same-name+phone contact merge — PREVIEW (Ahmad 2026-06-22).
    //   GET /api/duplicates/contacts/name-phone-preview
    path: "/api/duplicates/contacts/name-phone-preview",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const { previewNamePhoneContactMatches } = await import("../../utils/duplicateRadarDatabase");
          const data = await previewNamePhoneContactMatches();
          return c.json({ success: true, ...data });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Bulk same-name+phone contact merge — APPLY (admin-key gated, Ahmad 2026-06-22).
    // Preserves the survivor's email(s) (primary + Secondary_Email), tags
    // duplicates Duplicate-Delete (migrate-then-tag).
    //   POST /api/duplicates/contacts/name-phone-merge  { limit? }
    path: "/api/duplicates/contacts/name-phone-merge",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse: unauthorized } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorized(c);
          const body = await c.req.json().catch(() => ({}));
          const limit = parseInt(body?.limit, 10);
          const overrides: Record<string, string> = {};
          if (body?.overrides && typeof body.overrides === "object") {
            for (const [k, v] of Object.entries(body.overrides)) {
              if (typeof k === "string" && typeof v === "string" && v.trim()) overrides[k] = v.trim();
            }
          }
          const excludes: Record<string, string[]> = {};
          if (body?.excludes && typeof body.excludes === "object") {
            for (const [k, v] of Object.entries(body.excludes)) {
              if (typeof k === "string" && Array.isArray(v)) {
                const ids = v.map((x: any) => String(x || "").trim()).filter(Boolean);
                if (ids.length) excludes[k] = ids;
              }
            }
          }
          const performedBy =
            `${(sessionUser as any)?.email || "admin"} (bulk same name+phone merge)`;
          const { applyNamePhoneContactMatches } = await import("../../utils/duplicateRadarDatabase");
          const result = await applyNamePhoneContactMatches({
            limit: Number.isFinite(limit) && limit > 0 ? limit : 200,
            performedBy,
            excludes,
            overrides,
          });
          return c.json({ success: true, ...result });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Bulk link colleagues → Account — PREVIEW (Ahmad 2026-06-23).
    //   GET /api/duplicates/contacts/link-account-preview
    path: "/api/duplicates/contacts/link-account-preview",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const { previewContactLinkToAccount } = await import("../../utils/duplicateRadarDatabase");
          const data = await previewContactLinkToAccount();
          return c.json({ success: true, ...data });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Bulk link colleagues → Account — APPLY (admin-gated, Ahmad 2026-06-23).
    // Sets Account_Name on the contacts of each link-only cluster (no tagging).
    //   POST /api/duplicates/contacts/link-account-apply  { limit? }
    path: "/api/duplicates/contacts/link-account-apply",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse: unauthorized } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorized(c);
          const body = await c.req.json().catch(() => ({}));
          const limit = parseInt(body?.limit, 10);
          const performedBy =
            `${(sessionUser as any)?.email || "admin"} (bulk link contacts → account)`;
          const { applyContactLinkToAccount } = await import("../../utils/duplicateRadarDatabase");
          const result = await applyContactLinkToAccount({
            dryRun: false,
            limit: Number.isFinite(limit) && limit > 0 ? limit : 50,
            performedBy,
          });
          return c.json({ success: true, ...result });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Account auto-merge (same domain + same name, within layout) — READ-ONLY
    // PREVIEW (Ahmad 2026-06-22). No writes. Corporate↔Corporate and
    // Partner↔Partner only; the apply (cascade) is a separate, confirmed step.
    //   GET /api/duplicates/accounts/domain-name-preview
    path: "/api/duplicates/accounts/domain-name-preview",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const { previewAccountDomainNameMerge } = await import("../../utils/duplicateRadarDatabase");
          const data = await previewAccountDomainNameMerge();
          return c.json({ success: true, ...data });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Account auto-merge — APPLY one scope (admin-key gated, Ahmad 2026-06-22).
    // Reuses the agentic merge engine: preserves EN/AR names, re-parents the
    // duplicates' contacts/deals onto the survivor, tags the rest. Never deletes.
    //   POST /api/duplicates/accounts/domain-name-merge  { scope, limit? }
    path: "/api/duplicates/accounts/domain-name-merge",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse: unauthorized } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorized(c);
          const body = await c.req.json().catch(() => ({}));
          const scope = body?.scope === "partner" ? "partner" : "corporate";
          const limit = parseInt(body?.limit, 10);
          // Per-group survivor overrides { "domain|name": zohoIdToKeep }.
          const overrides: Record<string, string> = {};
          if (body?.overrides && typeof body.overrides === "object") {
            for (const [k, v] of Object.entries(body.overrides)) {
              if (typeof k === "string" && typeof v === "string" && v.trim()) {
                overrides[k] = v.trim();
              }
            }
          }
          const excludes: Record<string, string[]> = {};
          if (body?.excludes && typeof body.excludes === "object") {
            for (const [k, v] of Object.entries(body.excludes)) {
              if (typeof k === "string" && Array.isArray(v)) {
                const ids = v.map((x: any) => String(x || "").trim()).filter(Boolean);
                if (ids.length) excludes[k] = ids;
              }
            }
          }
          const performedBy =
            `${(sessionUser as any)?.email || "admin"} (bulk account ${scope} domain+name merge)`;
          const { applyAccountDomainNameMerge } = await import("../../utils/duplicateRadarDatabase");
          const result = await applyAccountDomainNameMerge({
            scope,
            dryRun: false,
            limit: Number.isFinite(limit) && limit > 0 ? limit : 100,
            performedBy,
            overrides,
            excludes,
          });
          return c.json({ success: true, ...result });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // ONE-CLICK "Apply all safe auto-merges" (Sarah 2026-06-25). Runs ONE bounded
    // batch of each PROVEN safe matcher in sequence — accounts (domain+name) first
    // so contacts re-parent onto the merged survivor, then contacts (exact
    // email+phone, then same name+phone). No new merge logic: it just orchestrates
    // the existing, conservative apply functions behind ONE admin check. The
    // frontend loops this until `more` is false. Each pass is small so the request
    // never hits the proxy timeout; nothing is deleted by the platform.
    path: "/api/duplicates/apply-all-safe",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse: unauthorized } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorized(c);
          const body = await c.req.json().catch(() => ({}));
          const n = parseInt(body?.limit, 10);
          const limit = Number.isFinite(n) && n > 0 ? Math.min(n, 25) : 15;
          const by = `${(sessionUser as any)?.email || "admin"} (apply-all-safe)`;
          const {
            applyAccountDomainNameMerge,
            applyExactContactMatches,
            applyNamePhoneContactMatches,
          } = await import("../../utils/duplicateRadarDatabase");
          const accounts = await applyAccountDomainNameMerge({
            scope: "corporate",
            dryRun: false,
            limit,
            performedBy: by,
          });
          const exactContacts = await applyExactContactMatches({ limit, performedBy: by });
          const namePhoneContacts = await applyNamePhoneContactMatches({ limit, performedBy: by });
          const didWork =
            (accounts.merged || 0) +
            (exactContacts.mergedGroups || 0) +
            (namePhoneContacts.mergedGroups || 0);
          const remaining =
            (accounts.remaining || 0) +
            (exactContacts.remaining || 0) +
            (namePhoneContacts.remaining || 0);
          // Loop only while this pass made progress — a progress-based guard that
          // can't spin forever even if `remaining` is stuck (e.g. Zoho rate-limit).
          return c.json({
            success: true,
            accounts,
            exactContacts,
            namePhoneContacts,
            remaining,
            more: didWork > 0,
          });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Dismiss an account auto-merge group as "NOT duplicates" (Ahmad 2026-06-23).
    // Records the group's accounts as mutually separated (durable) so the group
    // is excluded from this AND future previews/merges — no Zoho write.
    //   POST /api/duplicates/accounts/dismiss-merge-group  { zohoIds: string[] }
    path: "/api/duplicates/accounts/dismiss-merge-group",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const body = await c.req.json().catch(() => ({}));
          const zohoIds: string[] = Array.isArray(body?.zohoIds)
            ? body.zohoIds.map((z: any) => String(z || "").trim()).filter(Boolean)
            : [];
          if (zohoIds.length < 2) {
            return c.json({ error: "Need at least 2 account ids to dismiss." }, 400);
          }
          const performedBy = `${(user as any)?.email || "user"} (dismiss account merge group)`;
          const { recordSeparations } = await import("../../utils/duplicateRadarDatabase");
          // Each account is its own group → recordSeparations separates all pairs.
          const pairs = await recordSeparations(
            zohoIds.map((z) => [z]),
            "dismiss",
            performedBy,
          );
          return c.json({ success: true, separatedPairs: pairs, accounts: zohoIds.length });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Looser DOMAIN-ONLY account auto-merge — PREVIEW (Sarah 2026-06-23).
    // "Same domain, any name" with the shared-domain guard. No writes.
    //   GET /api/duplicates/accounts/domain-only-preview
    path: "/api/duplicates/accounts/domain-only-preview",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const { previewAccountDomainOnlyMerge } = await import("../../utils/duplicateRadarDatabase");
          const data = await previewAccountDomainOnlyMerge();
          return c.json({ success: true, ...data });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Looser DOMAIN-ONLY account auto-merge — APPLY one scope (admin-key gated).
    //   POST /api/duplicates/accounts/domain-only-merge  { scope, limit?, overrides? }
    path: "/api/duplicates/accounts/domain-only-merge",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse: unauthorized } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorized(c);
          const body = await c.req.json().catch(() => ({}));
          const scope = body?.scope === "partner" ? "partner" : "corporate";
          const limit = parseInt(body?.limit, 10);
          const overrides: Record<string, string> = {};
          if (body?.overrides && typeof body.overrides === "object") {
            for (const [k, v] of Object.entries(body.overrides)) {
              if (typeof k === "string" && typeof v === "string" && v.trim()) {
                overrides[k] = v.trim();
              }
            }
          }
          const excludes: Record<string, string[]> = {};
          if (body?.excludes && typeof body.excludes === "object") {
            for (const [k, v] of Object.entries(body.excludes)) {
              if (typeof k === "string" && Array.isArray(v)) {
                const ids = v.map((x: any) => String(x || "").trim()).filter(Boolean);
                if (ids.length) excludes[k] = ids;
              }
            }
          }
          const performedBy =
            `${(sessionUser as any)?.email || "admin"} (bulk account ${scope} domain-only merge)`;
          const { applyAccountDomainNameMerge } = await import("../../utils/duplicateRadarDatabase");
          const result = await applyAccountDomainNameMerge({
            scope,
            dryRun: false,
            limit: Number.isFinite(limit) && limit > 0 ? limit : 100,
            performedBy,
            overrides,
            excludes,
            groupBy: "domain",
          });
          return c.json({ success: true, ...result });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Acceptance-pattern analysis (Sarah 2026-06-20): learn AUTO-APPROVE rules
    // from resolved data (manual merges + agent applies). Recommend-only.
    //   GET /api/duplicates/autonomous/acceptance-patterns?module=Accounts&days=90
    path: "/api/duplicates/autonomous/acceptance-patterns",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const url = new URL(c.req.url);
          const days = parseInt(url.searchParams.get("days") || "90", 10);
          const moduleRaw = url.searchParams.get("module") || "";
          const module = ["Accounts", "Leads", "Deals", "Contacts"].includes(moduleRaw)
            ? moduleRaw
            : undefined;
          const { analyzeAcceptancePatterns } = await import("../../utils/rejectionPatterns");
          const data = await analyzeAcceptancePatterns({
            module,
            windowDays: Number.isFinite(days) && days > 0 ? days : 90,
          });
          return c.json({ success: true, ...data });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Per-tab daily PROGRESS burndown (Sarah 2026-06-17): for each module
    // (Leads/Deals/Contacts/Accounts) returns the daily series of open / solved
    // / total (+ durable merged) plus the latest snapshot and the day-over-day
    // delta. "solved" = clusters no longer active; "total" = open + solved (the
    // denominator, which grows as new duplicates are detected). Read-only.
    //   GET /api/duplicates/progress?days=30
    path: "/api/duplicates/progress",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const url = new URL(c.req.url);
          const days = parseInt(url.searchParams.get("days") || "30", 10);
          const data = await getDuplicateProgressSeries(
            Number.isFinite(days) && days > 0 ? days : 30,
          );
          return c.json({ success: true, ...data });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Clear the autonomous resolver's stale SHADOW proposals — bulk-reject every
    // PENDING 'duplicate-resolution' card in one call. Management-tier. These were
    // never applied to Zoho (shadow), so this writes NOTHING to the CRM — it just
    // empties the review backlog so the queue shows only real escalations.
    // Optional onlyVerdict ('auto'|'escalate') clears just one tier.
    //   POST /api/duplicates/autonomous/clear-shadow-proposals
    path: "/api/duplicates/autonomous/clear-shadow-proposals",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRoleOrKey(c, [...AUTONOMOUS_RESOLUTION_MANAGE_ROLES]);
          if (!user) return unauthorizedResponse(c);
          const body = await c.req.json().catch(() => ({}));
          const onlyVerdict =
            body?.onlyVerdict === "auto" || body?.onlyVerdict === "escalate"
              ? body.onlyVerdict
              : null;
          // sourceGroup (Sarah 2026-06-20): which pending actions to clear.
          //   'autonomous' (default) → only the resolver's shadow proposals
          //   'adam'                 → only chat-initiated requests
          //   'all'                  → EVERY pending action (full reset)
          const sourceGroup =
            body?.sourceGroup === "all" || body?.sourceGroup === "adam"
              ? body.sourceGroup
              : "autonomous";
          const { pool } = await import("../../utils/duplicateRadarDatabase");
          const params: any[] = [
            (user as any)?.email || "admin",
            (user as any)?.name || "admin",
          ];
          // Build the tool-scope clause for the chosen source group.
          let toolClause = " AND tool_id = 'duplicate-resolution'";
          if (sourceGroup === "adam") toolClause = " AND tool_id <> 'duplicate-resolution'";
          else if (sourceGroup === "all") toolClause = "";
          let verdictClause = "";
          if (onlyVerdict) {
            verdictClause = ` AND payload->>'verdict' = $${params.length + 1}`;
            params.push(onlyVerdict);
          }
          const r = await pool.query(
            `UPDATE ai_pending_actions
                SET status = 'rejected',
                    rejection_reason = 'Cleared in bulk — backlog reset, never applied to Zoho.',
                    reviewed_by_email = $1,
                    reviewed_by_name = $2,
                    reviewed_at = NOW()
              WHERE status = 'pending'${toolClause}${verdictClause}`,
            params,
          );
          return c.json({ success: true, cleared: r.rowCount ?? 0 });
        } catch (e: any) {
          logger.error("Error clearing shadow proposals:", e);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // "Post operational digest now" — manually fire the SAME twice-daily apply
    // digest (per-tab status board) on demand, so you can see it immediately
    // instead of waiting for the 09:00 / 17:00 KSA run. Posts to the resolution
    // Slack channel. Management-tier only (it broadcasts to the team channel).
    path: "/api/duplicates/autonomous/digest/send",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRoleOrKey(c, [...AUTONOMOUS_RESOLUTION_MANAGE_ROLES]);
          if (!user) return unauthorizedResponse(c);
          const body = await c.req.json().catch(() => ({}));
          const sinceHours =
            Number.isFinite(body?.sinceHours) && body.sinceHours > 0
              ? Math.min(168, Math.floor(body.sinceHours))
              : 8;
          await postResolutionDigest({ label: "Manual run", sinceHours });
          return c.json({ ok: true, sinceHours });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Admin-only: change the agent's mode / kill switch from inside the platform
    // (DB override; applies on the next tick, no republish). Audit-logged.
    path: "/api/duplicates/autonomous/mode",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRoleOrKey(c, [...AUTONOMOUS_RESOLUTION_MANAGE_ROLES]);
          if (!user) return unauthorizedResponse(c);
          const body = await c.req.json().catch(() => ({}));
          const patch: { enabled?: boolean; mode?: ResolutionMode } = {};
          if (typeof body?.enabled === "boolean") patch.enabled = body.enabled;
          if (["shadow", "assisted", "autonomous"].includes(body?.mode)) {
            patch.mode = body.mode as ResolutionMode;
          }
          if (patch.enabled === undefined && patch.mode === undefined) {
            return c.json({ error: "Provide `mode` (shadow|assisted|autonomous) and/or `enabled` (boolean)." }, 400);
          }
          const before = await resolveResolutionRunConfig();
          const updated = await setResolutionSetting(
            patch,
            (user as any)?.email || "admin",
          );
          const after = await resolveResolutionRunConfig();
          try {
            const { logEvent } = await import("../../utils/eventLogsDatabase");
            await logEvent({
              userEmail: (user as any)?.email || undefined,
              userRole: (user as any)?.role || undefined,
              actionType: "AI_ACTION",
              entityType: "SYSTEM",
              entityId: "autonomous-resolution",
              entityName: "Autonomous Resolution mode",
              description:
                `Autonomous Resolution changed: mode ${before.mode}→${after.mode}, ` +
                `writes ${before.enabled ? "ON" : "OFF"}→${after.enabled ? "ON" : "OFF"}.`,
              aiInvolved: true,
              severity: after.enabled && after.mode !== "shadow" ? "WARNING" : "INFO",
              module: "duplicate-radar",
            });
          } catch {
            /* audit is best-effort */
          }
          return c.json({ ok: true, config: after, override: updated });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Send a one-off test ping to the resolution Slack channel.
    path: "/api/duplicates/autonomous/slack-test",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const result = await sendResolutionSlackTest(
            (user as any)?.email || "operator",
          );
          return c.json(result, result.ok ? 200 : 400);
        } catch (e: any) {
          return c.json({ ok: false, error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // One-off cleanup: delete the bot's zero-progress "applied 0" resolution
    // pings from the Slack channel (Sarah 2026-06-20). Management-tier.
    path: "/api/duplicates/autonomous/cleanup-slack-pings",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRoleOrKey(c, [...AUTONOMOUS_RESOLUTION_MANAGE_ROLES]);
          if (!user) return unauthorizedResponse(c);
          const result = await cleanupZeroResolutionPings({ limit: 800 });
          return c.json({ success: !result.error, ...result });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Manual "Run now" — runs one full tick (respects mode/kill-switch).
    path: "/api/duplicates/autonomous/run-now",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const body = await c.req.json().catch(() => ({}));
          const modeOverride =
            body?.mode === "shadow" || body?.mode === "assisted" || body?.mode === "autonomous"
              ? body.mode
              : undefined;
          const summary = await runAutonomousResolution({ modeOverride });
          return c.json({ ok: true, summary });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Re-do: re-run the resolution for one cluster (Agent Activity log).
    path: "/api/duplicates/autonomous/run-cluster/:id",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);
          const summary = await runResolutionForCluster(id);
          return c.json({ ok: true, summary });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Undo: remove the agent's Duplicate-Delete tags + reopen the cluster.
    path: "/api/duplicates/autonomous/undo/:id",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);
          const result = await undoClusterResolution(
            id,
            (user as any)?.email || "duplicate-radar",
          );
          return c.json(result, result.ok ? 200 : 400);
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Learning-curve history for the chart. Optional ?module=Accounts.
    path: "/api/duplicates/autonomous/grades",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const module = c.req.query("module") || undefined;
          const history = await getGradeHistory(module, 300);
          return c.json({ history });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // List learning rules (Rules view).
    path: "/api/duplicates/autonomous/rules",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const includeDisabled = c.req.query("all") === "1";
          const rules = await listResolutionRules(includeDisabled);
          return c.json({ rules });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Create a learning rule ("Make this a rule" — don't re-ask similar cases).
    path: "/api/duplicates/autonomous/rules",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const body = await c.req.json().catch(() => ({}));
          const module = parseAgenticModule(body);
          const decision = body?.decision as RuleDecision;
          if (!["auto_approve", "never_merge", "always_link"].includes(decision)) {
            return c.json({ error: "decision must be auto_approve | never_merge | always_link" }, 400);
          }
          const id = await recordResolutionRule({
            module,
            caseSignature:
              body?.caseSignature && typeof body.caseSignature === "object"
                ? body.caseSignature
                : {},
            decision,
            scope: body?.clusterId ? "cluster" : "pattern",
            clusterId: body?.clusterId ?? null,
            createdBy: (user as any)?.email || "duplicate-radar",
          });
          if (id == null) return c.json({ error: "Could not create rule" }, 500);
          return c.json({ ok: true, id });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Enable / disable a rule.
    path: "/api/duplicates/autonomous/rules/:id",
    method: "PATCH" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid rule id" }, 400);
          const body = await c.req.json().catch(() => ({}));
          const ok = await setResolutionRuleEnabled(id, body?.enabled !== false);
          return c.json({ ok });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Per-record attachment counts for a cluster (the 📎 chip in the merge
    // modal + evidence-safety signal). ?module=Accounts|Leads|Deals|Contacts.
    path: "/api/duplicates/clusters/:id/attachments",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);
          const module = parseAgenticModule({ module: c.req.query("module") });
          const recordType = MODULE_RECORD_TYPE[module];
          const records = await getRecordsByClusterId(id);
          const ids = records
            .filter((r) => r.record_type === recordType && r.zoho_record_id)
            .map((r) => r.zoho_record_id as string)
            .slice(0, 25); // bound the Zoho calls
          const counts: Record<string, number> = {};
          await Promise.all(
            ids.map(async (zid) => {
              try {
                const atts = await fetchRecordAttachments(module, zid);
                counts[zid] = Array.isArray(atts) ? atts.length : 0;
              } catch {
                counts[zid] = -1; // unknown (Zoho error) — UI shows a neutral dash
              }
            }),
          );
          return c.json({ module, counts });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Per-Account child-deal counts. Replaces the 📎 attachments chip in
    // the Accounts merge modal — "which of these two Accounts has the
    // bigger Deals book?" is a stronger survivor signal than attachment
    // counts. Sarah Hijazi (2026-06-10): "instead of attachments here we
    // can add the no. of deals that inside the account itself".
    //   GET /api/duplicates/clusters/:id/deal-counts
    //   Response: { counts: { <accountZohoId>: N, ... } }
    //   -1 = Zoho error (UI renders a neutral dash, no crash).
    path: "/api/duplicates/clusters/:id/deal-counts",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);
          const records = await getRecordsByClusterId(id);
          const accountIds = records
            .filter((r) => r.record_type === "account" && r.zoho_record_id)
            .map((r) => r.zoho_record_id as string)
            .slice(0, 25); // bound the Zoho fan-out per click
          const counts: Record<string, number> = {};
          await Promise.all(
            accountIds.map(async (zid) => {
              try {
                const deals = await fetchZohoRelatedRecords(
                  "Accounts",
                  zid,
                  "Deals",
                  { perPage: 200 },
                );
                counts[zid] = Array.isArray(deals) ? deals.length : 0;
              } catch {
                counts[zid] = -1;
              }
            }),
          );
          return c.json({ counts });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    //   GET /api/duplicates/clusters/:id/account-deals
    //   Lists the Deals linked to each Account in the cluster, so the Account
    //   merge pop-up can show them and let the operator move a Deal from one
    //   Account to another. Response: { accounts:[{zohoId,name}], deals:{<acct>:[{id,name,stage}]} }
    path: "/api/duplicates/clusters/:id/account-deals",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);
          const records = await getRecordsByClusterId(id);
          const accounts = records
            .filter((r) => r.record_type === "account" && r.zoho_record_id)
            .map((r) => ({
              zohoId: r.zoho_record_id as string,
              name: r.record_name || r.company_name || "Account",
            }))
            .slice(0, 25);
          const deals: Record<
            string,
            Array<{ id: string; name: string; stage: string }>
          > = {};
          await Promise.all(
            accounts.map(async (a) => {
              try {
                const ds = await fetchZohoRelatedRecords(
                  "Accounts",
                  a.zohoId,
                  "Deals",
                  { perPage: 200 },
                );
                deals[a.zohoId] = (Array.isArray(ds) ? ds : []).map(
                  (d: any) => ({
                    id: String(d.id),
                    name: d.Deal_Name || d.Name || "Deal",
                    stage: d.Stage || "",
                  }),
                );
              } catch {
                deals[a.zohoId] = [];
              }
            }),
          );
          return c.json({ accounts, deals });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    //   POST /api/duplicates/link-record-to-account
    //   Move a single Deal or Contact under an Account by setting its
    //   Account_Name lookup in Zoho. Reuses the same primitive the merge
    //   executor uses for "link survivor to account". Admin-gated; supports
    //   dry_run. Body: { module:'Deals'|'Contacts', record_zoho_id, account_zoho_id, dry_run? }
    path: "/api/duplicates/link-record-to-account",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse: ua } = await import(
            "../../utils/rbacMiddleware"
          );
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return ua(c);
          const body = await c.req.json().catch(() => ({}));
          const module = String(body?.module || "");
          const recordId = String(body?.record_zoho_id || "");
          const accountId = String(body?.account_zoho_id || "");
          const dryRun = body?.dry_run === true;
          if (!["Deals", "Contacts"].includes(module)) {
            return c.json({ error: "module must be 'Deals' or 'Contacts'" }, 400);
          }
          if (!recordId || !accountId) {
            return c.json(
              { error: "record_zoho_id and account_zoho_id are required" },
              400,
            );
          }
          if (dryRun) {
            return c.json({
              success: true,
              dry_run: true,
              message: `Would set ${module} ${recordId} Account_Name → ${accountId}`,
            });
          }
          const { updateZohoRecord } = await import("../../utils/zohoCRM");
          await updateZohoRecord(module, recordId, {
            Account_Name: { id: accountId },
          });
          logger.info(
            `🔗 [DuplicateRadar] Linked ${module} ${recordId} → Account ${accountId} by ${sessionUser.email || "admin"}`,
          );
          return c.json({
            success: true,
            module,
            record_zoho_id: recordId,
            account_zoho_id: accountId,
          });
        } catch (error: any) {
          logger.error("Error linking record to account:", error);
          return c.json({ error: error?.message || "Link failed" }, 500);
        }
      };
    },
  },
  {
    // Post-merge verification — re-query Zoho for every record this cluster
    // has tagged Duplicate-Delete (via prior merge_actions). Reports how many
    // the admin has actually deleted vs. still pending. Closes the "did the
    // tag-and-delete handoff actually happen?" visibility gap.
    //   GET /api/duplicates/clusters/:id/verify-tags
    // Response: { total, deleted, alive, errors, byRecord: [{zohoId, module, status}] }
    path: "/api/duplicates/clusters/:id/verify-tags",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);

          const { pool } = await import("../../utils/duplicateRadarDatabase");
          // Union of every merged_record_ids the cluster has accumulated —
          // closing 'resolve' AND partial 'module_resolved' actions both
          // count, so cross-module clusters with multiple module Applies
          // verify end-to-end on a single call.
          const acts = await pool.query(
            `SELECT merged_record_ids FROM duplicate_merge_actions
              WHERE cluster_id = $1
                AND action_type IN ('resolve', 'module_resolved')`,
            [id],
          );
          const dbIdSet = new Set<number>();
          for (const r of acts.rows) {
            const raw = r.merged_record_ids;
            const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
            if (Array.isArray(arr)) {
              for (const v of arr) {
                const n = typeof v === "number" ? v : parseInt(String(v), 10);
                if (Number.isFinite(n)) dbIdSet.add(n);
              }
            }
          }
          if (dbIdSet.size === 0) {
            return c.json({
              total: 0,
              deleted: 0,
              alive: 0,
              errors: 0,
              byRecord: [],
              message: "No tagged duplicates on this cluster yet — run Apply first.",
            });
          }

          // Resolve db ids → (zoho_record_id, zoho_module). Bound to ≤50
          // ids per call so a runaway merge_action history can't pin us in
          // a 5-minute Zoho fan-out.
          const dbIds = Array.from(dbIdSet).slice(0, 50);
          const recs = await pool.query(
            `SELECT id, zoho_record_id, zoho_module, record_type, record_name
               FROM duplicate_records
              WHERE id = ANY($1::int[])`,
            [dbIds],
          );
          const RECORD_TYPE_TO_MODULE: Record<string, string> = {
            lead: "Leads",
            deal: "Deals",
            contact: "Contacts",
            account: "Accounts",
          };
          const byRecord: Array<{
            dbId: number;
            zohoId: string | null;
            module: string | null;
            name: string | null;
            status: "deleted" | "alive" | "no-zoho-id" | "error";
            error?: string;
          }> = [];
          let deleted = 0,
            alive = 0,
            errors = 0;
          await Promise.all(
            recs.rows.map(async (row: any) => {
              const zohoId = row.zoho_record_id || null;
              const moduleName =
                row.zoho_module ||
                RECORD_TYPE_TO_MODULE[row.record_type as string] ||
                null;
              if (!zohoId || !moduleName) {
                byRecord.push({
                  dbId: row.id,
                  zohoId,
                  module: moduleName,
                  name: row.record_name || null,
                  status: "no-zoho-id",
                });
                return;
              }
              try {
                const live = await fetchZohoRecordById(moduleName, zohoId);
                if (live === null) {
                  deleted++;
                  byRecord.push({
                    dbId: row.id,
                    zohoId,
                    module: moduleName,
                    name: row.record_name || null,
                    status: "deleted",
                  });
                } else {
                  alive++;
                  byRecord.push({
                    dbId: row.id,
                    zohoId,
                    module: moduleName,
                    name: row.record_name || null,
                    status: "alive",
                  });
                }
              } catch (e: any) {
                errors++;
                byRecord.push({
                  dbId: row.id,
                  zohoId,
                  module: moduleName,
                  name: row.record_name || null,
                  status: "error",
                  error: e?.message || String(e),
                });
              }
            }),
          );
          // 2026-06-18 — reconcile like /recheck: records confirmed gone from
          // Zoho (404) are marked stale_pending and purged, so the cluster
          // collapses to the survivor(s) instead of listing deleted dupes.
          let purged = 0;
          const deletedDbIds = byRecord
            .filter((x) => x.status === "deleted")
            .map((x) => x.dbId);
          if (deletedDbIds.length > 0) {
            try {
              await markRecordsStalePendingByIds(deletedDbIds);
              purged = await cleanupStaleRecords();
              await cleanupOrphanClusters();
              await updateClusterStats(id).catch(() => {});
            } catch (reErr: any) {
              logger.warn("[DuplicateRadar] verify-tags reconcile skipped:", {
                error: reErr?.message || String(reErr),
              });
            }
          }
          return c.json({
            total: byRecord.length,
            deleted,
            alive,
            errors,
            purged,
            byRecord,
          });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // BULK verify-and-resolve: for every AI-Applied (pending Zoho delete)
    // cluster — optionally a single module — re-query Zoho for the tagged
    // Duplicate-Delete records and mark Resolved ONLY those where the admin has
    // deleted every one. For when the admin clears a big batch at once. Bounded
    // (≤ maxClusters, ≤50 records/cluster) and conservative — a cluster is only
    // resolved when EVERY tagged duplicate is provably gone (no alive, no
    // no-zoho-id, no Zoho error). Reuses the verify-tags logic + resolveCluster.
    //   POST /api/duplicates/verify-resolve-applied
    //   Body: { module?: 'Accounts'|'Leads'|'Deals'|'Contacts', maxClusters?: number }
    //   Response: { checked, resolved, pending, errored, noTags, more, perCluster }
    path: "/api/duplicates/verify-resolve-applied",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse: unauthorized } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorized(c);
          const body = await c.req.json().catch(() => ({}));
          const MODCOL: Record<string, string> = {
            Accounts: "total_accounts",
            Leads: "total_leads",
            Deals: "total_deals",
            Contacts: "total_contacts",
          };
          const moduleRaw = String(body?.module || "").trim();
          const moduleCol = MODCOL[moduleRaw] || null;
          const maxClusters = Number.isFinite(body?.maxClusters)
            ? Math.max(1, Math.min(50, Number(body.maxClusters)))
            : 20;

          const { pool } = await import("../../utils/duplicateRadarDatabase");
          const moduleFilter = moduleCol ? ` AND dc.${moduleCol} > 0` : "";
          // AI-Applied = active cluster carrying a resolve/module_resolved action.
          const clustersQ = await pool.query(
            `SELECT dc.id
               FROM duplicate_clusters dc
              WHERE dc.status = 'active'
                AND EXISTS (
                  SELECT 1 FROM duplicate_merge_actions ma
                   WHERE ma.cluster_id = dc.id
                     AND ma.action_type IN ('resolve','module_resolved')
                )${moduleFilter}
              ORDER BY dc.updated_at DESC NULLS LAST
              LIMIT $1`,
            [maxClusters + 1],
          );
          const allIds = clustersQ.rows.map((r: any) => Number(r.id));
          const more = allIds.length > maxClusters;
          const ids = allIds.slice(0, maxClusters);

          const RTM: Record<string, string> = {
            lead: "Leads",
            deal: "Deals",
            contact: "Contacts",
            account: "Accounts",
          };
          let resolved = 0,
            pending = 0,
            errored = 0,
            noTags = 0;
          const perCluster: any[] = [];

          // Sequential across clusters (so a big batch can't fan out into a
          // thousand concurrent Zoho calls); records WITHIN a cluster checked in
          // parallel, bounded to ≤50.
          for (const cid of ids) {
            const acts = await pool.query(
              `SELECT merged_record_ids FROM duplicate_merge_actions
                WHERE cluster_id = $1 AND action_type IN ('resolve','module_resolved')`,
              [cid],
            );
            const dbIdSet = new Set<number>();
            for (const r of acts.rows) {
              const raw = r.merged_record_ids;
              const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
              if (Array.isArray(arr)) {
                for (const v of arr) {
                  const n = typeof v === "number" ? v : parseInt(String(v), 10);
                  if (Number.isFinite(n)) dbIdSet.add(n);
                }
              }
            }
            if (dbIdSet.size === 0) {
              noTags++;
              continue;
            }
            const dbIds = Array.from(dbIdSet).slice(0, 50);
            const recs = await pool.query(
              `SELECT id, zoho_record_id, zoho_module, record_type
                 FROM duplicate_records WHERE id = ANY($1::int[])`,
              [dbIds],
            );
            let total = 0,
              deleted = 0,
              alive = 0,
              errs = 0;
            await Promise.all(
              recs.rows.map(async (row: any) => {
                total++;
                const zohoId = row.zoho_record_id || null;
                const mod =
                  row.zoho_module || RTM[row.record_type as string] || null;
                if (!zohoId || !mod) {
                  // Can't confirm deletion → conservatively treat as not-gone.
                  alive++;
                  return;
                }
                try {
                  const live = await fetchZohoRecordById(mod, zohoId);
                  if (live === null) deleted++;
                  else alive++;
                } catch {
                  errs++;
                }
              }),
            );
            if (total > 0 && alive === 0 && errs === 0 && deleted === total) {
              await resolveCluster(
                cid,
                "resolve",
                sessionUser.email || "admin",
                undefined,
                `Verified in CRM (bulk): all ${total} Duplicate-Delete record(s) confirmed deleted in Zoho.`,
              );
              resolved++;
              perCluster.push({ id: cid, outcome: "resolved", deleted, total });
            } else if (errs > 0) {
              errored++;
              perCluster.push({ id: cid, outcome: "error", deleted, alive, errors: errs, total });
            } else {
              pending++;
              perCluster.push({ id: cid, outcome: "pending", deleted, alive, total });
            }
          }
          return c.json({
            success: true,
            checked: ids.length,
            resolved,
            pending,
            errored,
            noTags,
            more,
            perCluster,
          });
        } catch (error: any) {
          logger.error("Error in verify-resolve-applied:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // One-shot cleanup: apply the ≥2-attribute Contact rule retroactively
    // to every existing active Contacts cluster. Splits each cluster's
    // sub-components into their own clusters so today's "7 SLB employees"
    // mass clusters drop off the dashboard. DESTRUCTIVE (rewrites cluster_id
    // on duplicate_records rows) → admin only. Defaults to dry-run.
    //   POST /api/duplicates/bulk-split-contacts
    //   Body: { confirm?: boolean, limit?: number }
    //     confirm !== true → dry-run that returns the plan + counts
    //     limit (default 500, max 5000) bounds clusters touched per call
    path: "/api/duplicates/bulk-split-contacts",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse: unauthorized } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorized(c);
          const body = await c.req.json().catch(() => ({}));
          const dryRun = body?.confirm !== true;
          const limit = Number.isFinite(body?.limit)
            ? Math.max(1, Math.min(5000, Number(body.limit)))
            : 500;
          const performedBy =
            (sessionUser as any)?.email ||
            (sessionUser as any)?.role ||
            "admin";
          const result = await bulkSplitContactClustersByStrictRule({
            dryRun,
            limit,
            performedBy,
          });
          return c.json({ success: true, ...result });
        } catch (e: any) {
          logger.error("[bulk-split-contacts] failed:", e);
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Per-cluster re-check: for every record currently in the cluster,
    // re-fetch from Zoho and report its live state — does the record still
    // exist? what's its current Account_Name? what tags? Used right after
    // an Apply to confirm the migrate-tag-cascade chain actually landed in
    // Zoho without needing to wait for the next 6h scan.
    //   GET /api/duplicates/clusters/:id/recheck
    path: "/api/duplicates/clusters/:id/recheck",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);

          const records = await getRecordsByClusterId(id);
          const RECORD_TYPE_TO_MODULE: Record<string, string> = {
            lead: "Leads",
            deal: "Deals",
            contact: "Contacts",
            account: "Accounts",
          };
          // Bound the fan-out — clusters with hundreds of records would
          // otherwise burn our Zoho quota in one click.
          const targets = records
            .filter((r) => r.zoho_record_id)
            .slice(0, 50);
          const truncated = records.length > targets.length;

          const out = await Promise.all(
            targets.map(async (r) => {
              const moduleName =
                r.zoho_module ||
                RECORD_TYPE_TO_MODULE[r.record_type as string];
              const zohoId = r.zoho_record_id as string;
              if (!moduleName) {
                return {
                  dbId: r.id,
                  zohoId,
                  module: null,
                  name: r.record_name || null,
                  recordType: r.record_type,
                  isPrimary: !!r.is_primary,
                  status: "no-module" as const,
                };
              }
              try {
                const live = await fetchZohoRecordById(moduleName, zohoId);
                if (live === null) {
                  return {
                    dbId: r.id,
                    zohoId,
                    module: moduleName,
                    name: r.record_name || null,
                    recordType: r.record_type,
                    isPrimary: !!r.is_primary,
                    status: "deleted" as const,
                  };
                }
                const data = (live.data as Record<string, any>) || {};
                const tagList: string[] = Array.isArray(data.Tag)
                  ? data.Tag.map((t: any) => String(t?.name || t || "")).filter(Boolean)
                  : [];
                const accountName =
                  data.Account_Name?.name || data.account_name || null;
                return {
                  dbId: r.id,
                  zohoId,
                  module: moduleName,
                  name: r.record_name || null,
                  recordType: r.record_type,
                  isPrimary: !!r.is_primary,
                  status: "alive" as const,
                  hasDuplicateDeleteTag: tagList.some((t) =>
                    /duplicate.?delete/i.test(t),
                  ),
                  tags: tagList,
                  currentAccountName: accountName,
                };
              } catch (e: any) {
                return {
                  dbId: r.id,
                  zohoId,
                  module: moduleName,
                  name: r.record_name || null,
                  recordType: r.record_type,
                  isPrimary: !!r.is_primary,
                  status: "error" as const,
                  error: e?.message || String(e),
                };
              }
            }),
          );
          const tally = {
            total: out.length,
            alive: out.filter((x) => x.status === "alive").length,
            deleted: out.filter((x) => x.status === "deleted").length,
            errors: out.filter((x) => x.status === "error").length,
            tagged: out.filter(
              (x: any) => x.status === "alive" && x.hasDuplicateDeleteTag,
            ).length,
          };
          // 2026-06-18 — reconcile: records confirmed GONE from Zoho (404) are
          // marked stale_pending and purged, so a resolved cluster collapses to
          // just the survivor instead of lingering with already-deleted dupes.
          // Only acts on definitively-deleted rows (never on transient errors).
          let purged = 0;
          const deletedDbIds = out
            .filter((x) => x.status === "deleted" && typeof x.dbId === "number")
            .map((x) => x.dbId as number);
          if (deletedDbIds.length > 0) {
            try {
              await markRecordsStalePendingByIds(deletedDbIds);
              purged = await cleanupStaleRecords();
              await cleanupOrphanClusters();
              await updateClusterStats(id).catch(() => {});
            } catch (reErr: any) {
              logger.warn("[DuplicateRadar] recheck reconcile skipped:", {
                error: reErr?.message || String(reErr),
              });
            }
          }
          return c.json({
            ...tally,
            purged,
            truncated,
            totalInCluster: records.length,
            byRecord: out,
          });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Reparent preview — for an Accounts (or Contacts) merge plan, count
    // the child Deals / Contacts the executor will repoint onto the
    // survivor. The number already lands in the execute report; this
    // endpoint surfaces it BEFORE Apply so the merge modal can render
    // "Will reparent: X Deals · Y Contacts" up front.
    //   GET /api/duplicates/clusters/:id/reparent-preview?module=Accounts
    path: "/api/duplicates/clusters/:id/reparent-preview",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);
          const module = parseAgenticModule({ module: c.req.query("module") });
          // Only Accounts (→ Deals + Contacts) and Contacts (→ Deals) have
          // related-list children worth previewing. Leads / Deals have none.
          if (module !== "Accounts" && module !== "Contacts") {
            return c.json({ module, deals: 0, contacts: 0, scope: "n/a" });
          }
          const recordType = MODULE_RECORD_TYPE[module];
          const records = await getRecordsByClusterId(id);
          // Survivor = the most-complete record (auto-pick) unless the
          // operator overrode it. The preview counts cover all NON-survivor
          // records — same set the executor would walk.
          const sameModuleRecords = records.filter(
            (r) => r.record_type === recordType && r.zoho_record_id,
          );
          if (sameModuleRecords.length < 2) {
            return c.json({ module, deals: 0, contacts: 0, scope: "no-dups" });
          }
          // Pick the primary as the assumed survivor (matches planner's
          // default master selection well enough for a preview).
          const survivor =
            sameModuleRecords.find((r) => r.is_primary) ||
            sameModuleRecords[0];
          const dups = sameModuleRecords.filter(
            (r) => r.zoho_record_id !== survivor.zoho_record_id,
          );

          // Same list shape as duplicateMergeExecutor.MODULE_REPARENT.
          const REPARENT_LISTS: Array<{
            list: string;
            bucket: "deals" | "contacts";
          }> =
            module === "Accounts"
              ? [
                  { list: "Deals", bucket: "deals" },
                  { list: "Contacts", bucket: "contacts" },
                ]
              : [{ list: "Deals", bucket: "deals" }];

          const counts = { deals: 0, contacts: 0 };
          for (const dup of dups.slice(0, 25)) {
            // Bound the fan-out: 25 dups × 2 lists = 50 Zoho calls max.
            for (const rp of REPARENT_LISTS) {
              try {
                const children = await fetchZohoRelatedRecords(
                  module,
                  dup.zoho_record_id as string,
                  rp.list,
                  { perPage: 200 },
                );
                counts[rp.bucket] += Array.isArray(children) ? children.length : 0;
              } catch {
                /* best-effort — partial preview is better than no preview */
              }
            }
          }
          return c.json({
            module,
            deals: counts.deals,
            contacts: counts.contacts,
            scope: dups.length > 25 ? "truncated" : "complete",
            duplicatesInspected: Math.min(dups.length, 25),
            duplicatesTotal: dups.length,
          });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Deal-stage DOCUMENT compliance (Sales SOP 7.5.10): lists deals in
    // Proposal/Paid/Agreement Signed + the documents each stage requires.
    // Field/data-entry compliance is owned by the Quality Dashboard audit;
    // this surface is purely the Zoho-Attachments layer. Per-deal document
    // verification is loaded via the doc-compliance endpoint (lazy, bounds
    // Zoho calls).
    path: "/api/duplicates/deal-compliance",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          // Which stages to check — from the Advanced Filters Stage selector
          // (?stages=A,B,C); defaults to the real closing stages. Zoho's list
          // endpoint ignores `criteria`, so we filter in CODE (reliable).
          const stagesParam = (c.req.query("stages") || "").trim();
          const wanted = stagesParam
            ? stagesParam.split(",").map((s: string) => s.trim()).filter(Boolean)
            : [...DEAL_COMPLIANCE_STAGES];
          const wantedLower = new Set(wanted.map((s: string) => s.toLowerCase()));

          // Fetch recent deals (most-recently-modified first so active/closing
          // deals are covered) and filter to the wanted stages in code.
          let allDeals: any[] = [];
          try {
            allDeals = await fetchAllZohoRecords("Deals", {
              sortBy: "Modified_Time",
              sortOrder: "desc",
              maxRecords: 3000,
            });
          } catch (e: any) {
            return c.json({ error: `Zoho fetch failed: ${e?.message || e}` }, 502);
          }

          // Distinct stages present (for the UI to know what's available).
          const distinctStages = Array.from(
            new Set(allDeals.map((r: any) => (r.data?.Stage || "").trim()).filter(Boolean)),
          ).sort();

          const deals = allDeals.filter((r: any) =>
            wantedLower.has(String(r.data?.Stage || "").trim().toLowerCase()),
          );
          const rows = deals.map((rec: any) => {
            const d = rec.data || {};
            const stage = d.Stage || "";
            return {
              id: rec.id,
              name: d.Deal_Name || rec.id,
              stage,
              owner: d.Owner?.name || rec.owner || "—",
              amount: d.Amount ?? null,
              accountName:
                (typeof d.Account_Name === "object" ? d.Account_Name?.name : d.Account_Name) || null,
              source: d.Lead_Source || "",
              createdTime: d.Created_Time || "",
              requiredDocs: requiredDocsForStage(stage).map((x) => ({ key: x.key, label: x.label })),
            };
          });
          const byStage: Record<string, { total: number }> = {};
          for (const r of rows) {
            byStage[r.stage] = byStage[r.stage] || { total: 0 };
            byStage[r.stage].total++;
          }
          return c.json({
            total: rows.length,
            scanned: allDeals.length,
            wanted,
            distinct_stages: distinctStages,
            by_stage: byStage,
            deals: rows,
          });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Per-deal document (attachment) compliance — fetches the deal's Zoho
    // attachments and keyword-matches the SOP-required documents for its stage.
    path: "/api/duplicates/deals/:id/doc-compliance",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const id = c.req.param("id");
          const stage = c.req.query("stage") || "";
          if (!id) return c.json({ error: "deal id required" }, 400);
          let atts: any[] = [];
          try {
            atts = await fetchRecordAttachments("Deals", id);
          } catch (e: any) {
            return c.json({ error: `Zoho attachments fetch failed: ${e?.message || e}` }, 502);
          }
          const result = evaluateDocCompliance(stage, atts);
          // Persist the latest result (shared across users/devices) so the
          // scan survives reloads and can be re-checked / sent to owners.
          // Best-effort: a DB hiccup must not fail the live compliance answer.
          try {
            await upsertDealDocCompliance({
              zohoDealId: String(id),
              stage,
              compliant: !!result.compliant,
              presentDocs: (result.presentDocs || []).map((p: any) => p.label),
              missingDocs: (result.missingDocs || []).map((m: any) => m.label),
              attachmentCount: result.attachmentCount || 0,
              checkedBy: user.email || user.userId ? String(user.email || user.userId) : null,
            });
          } catch (persistErr: any) {
            logger.warn(
              `[DealCompliance] persist failed for deal ${id} (non-fatal): ${persistErr?.message || persistErr}`,
            );
          }
          // Return checkedBy + checkedAt alongside the live verdict so the
          // dashboard's freshly-scanned row immediately shows "checked just
          // now by <user>" — without waiting for the next page-load overlay
          // from /deal-compliance/results. Cross-team visibility: any other
          // reviewer hitting Refresh will see the same attribution.
          const checkedBy =
            user.email || user.userId ? String(user.email || user.userId) : null;
          return c.json({ ...result, checkedBy, checkedAt: new Date().toISOString() });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    // Persisted doc-compliance results (latest scan per deal) — rehydrates the
    // Deal-Compliance tab on open so prior scans aren't lost. Optional ?ids=a,b
    // to fetch just the visible deals; otherwise returns the most recent 5000.
    path: "/api/duplicates/deal-compliance/results",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const idsParam = (c.req.query("ids") || "").trim();
          const ids = idsParam
            ? idsParam.split(",").map((s: string) => s.trim()).filter(Boolean)
            : undefined;
          const rows = await getDealDocCompliance(ids);
          const results: Record<string, any> = {};
          for (const r of rows) {
            results[r.zoho_deal_id] = {
              compliant: !!r.compliant,
              present: Array.isArray(r.present_docs) ? r.present_docs : [],
              missing: Array.isArray(r.missing_docs) ? r.missing_docs : [],
              attachmentCount: r.attachment_count || 0,
              stage: r.stage || "",
              checkedAt: r.checked_at,
              checkedBy: r.checked_by || null,
            };
          }
          return c.json({ results });
        } catch (e: any) {
          return c.json({ error: e?.message || String(e) }, 500);
        }
      };
    },
  },
  {
    path: "/duplicates",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const possiblePaths = [
            join(process.cwd(), "dashboard", "duplicates.html"),
            "/home/runner/workspace/dashboard/duplicates.html",
          ];
          for (const p of possiblePaths) {
            if (existsSync(p)) {
              return c.html(readFileSync(p, "utf-8"));
            }
          }
          return c.text("Duplicate Radar Dashboard not found", 404);
        } catch (error) {
          logger.error("Error serving Duplicate Radar dashboard:", error);
          return c.text("Error loading Duplicate Radar dashboard", 500);
        }
      };
    },
  },
  {
    // The in-platform Autonomous Resolution screen (status / grades / learning
    // curve / rules / run-now). Auth is enforced by its API calls.
    path: "/autonomous-resolution",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const possiblePaths = [
            join(process.cwd(), "dashboard", "autonomous-resolution.html"),
            "/home/runner/workspace/dashboard/autonomous-resolution.html",
          ];
          for (const p of possiblePaths) {
            if (existsSync(p)) {
              return c.html(readFileSync(p, "utf-8"));
            }
          }
          return c.text("Autonomous Resolution screen not found", 404);
        } catch (error) {
          logger.error("Error serving Autonomous Resolution screen:", error);
          return c.text("Error loading Autonomous Resolution screen", 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/summary",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const summary = await getEnhancedSummary();
          const kpis = await getKPIMetrics();
          const lastScan = await getLastScanDate();
          // Total cleanup actions across ALL action tabs (not just merges) — so
          // the Executive Summary reflects everything the team has actioned.
          const { getCleanupActionsSummary } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          const cleanupActions = await getCleanupActionsSummary().catch(() => null);
          return c.json({ ...summary, kpis, cleanupActions, lastScanDate: lastScan });
        } catch (error: any) {
          logger.error("Error fetching summary:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Per-tab snapshot — one headline + verdict per Duplicate Radar tab.
    // Fans out across all the tab scanners in parallel and returns ONLY
    // the summary metrics so the Executive Summary "at-a-glance"
    // scorecard loads fast. Each tab is wrapped — one slow / failing
    // dependency cannot brick the whole exec view.
    path: "/api/duplicates/overview",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const { getDuplicateRadarOverview } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          const overview = await getDuplicateRadarOverview();
          return c.json({ success: true, ...overview });
        } catch (error: any) {
          logger.error("Error fetching Duplicate Radar overview:", error);
          return c.json(
            { success: false, error: "An internal error occurred" },
            500,
          );
        }
      };
    },
  },
  // "View All" support for the executive-summary cards (Top Match Signal Sources
  // and Top Clusters by Pipeline Inflation). These endpoints return the full
  // ranked list, not just the top 5 rendered inline on the page.
  {
    path: "/api/duplicates/clusters-by-inflation",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const limit = parseInt(url.searchParams.get("limit") || "500");
          const offset = parseInt(url.searchParams.get("offset") || "0");
          const includeInactive =
            new URL(c.req.url).searchParams.get("include_inactive") === "true";
          const rows = await getAllClustersByInflation({
            limit,
            offset,
            includeInactive,
          });
          return c.json({ clusters: rows, total: rows.length, limit, offset });
        } catch (error: any) {
          logger.error("Error fetching clusters by inflation:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/clusters-by-signal/:signal",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const signal = c.req.param("signal");
          if (!signal) return c.json({ error: "signal is required" }, 400);
          const url = new URL(c.req.url);
          const limit = parseInt(url.searchParams.get("limit") || "500");
          const offset = parseInt(url.searchParams.get("offset") || "0");
          const includeInactive =
            url.searchParams.get("include_inactive") === "true";
          const rows = await getClustersBySignal(signal, {
            limit,
            offset,
            includeInactive,
          });
          return c.json({
            signal,
            clusters: rows,
            total: rows.length,
            limit,
            offset,
          });
        } catch (error: any) {
          logger.error("Error fetching clusters by signal:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  // C4: Server-side pagination on clusters (30/page)
  {
    path: "/api/duplicates/clusters",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const status = url.searchParams.get("status");
          const confidence_level = url.searchParams.get("confidence_level");
          const limit = parseInt(url.searchParams.get("limit") || "30");
          const offset = parseInt(url.searchParams.get("offset") || "0");
          const start_date = url.searchParams.get("start_date") || undefined;
          const end_date = url.searchParams.get("end_date") || undefined;
          // Hide legitimate parent-child hierarchies (e.g. 1 account + N contacts/deals)
          // by default. Pass ?include_hierarchies=true to see them.
          const include_hierarchies =
            url.searchParams.get("include_hierarchies") === "true";
          const layoutsParam = url.searchParams.get("layouts");
          const layouts = layoutsParam
            ? layoutsParam
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : undefined;

          // owner_email filter: powers the per-owner drill modal on
          // the Owners tab. Click an owner row → modal opens →
          // fetches /api/duplicates/clusters?owner_email=<email> →
          // server returns only clusters where at least one record
          // is owned by that email (case-insensitive match).
          const owner_email = url.searchParams.get("owner_email") || undefined;

          const sort = url.searchParams.get("sort") || undefined;
          const dir = url.searchParams.get("dir") || undefined;

          const filters = {
            status: status || undefined,
            confidence_level: confidence_level || undefined,
            start_date,
            end_date,
            hide_hierarchies: !include_hierarchies,
            layouts,
            owner_email,
          };

          const [clusters, total] = await Promise.all([
            getAllClusters({ ...filters, limit, offset, sort, dir }),
            getClusterCount(filters),
          ]);

          return c.json({
            clusters,
            total,
            limit,
            offset,
            pages: Math.ceil(total / limit),
          });
        } catch (error: any) {
          logger.error("Error fetching clusters:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/clusters/:id",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);
          const cluster = await getClusterById(id);
          if (!cluster) {
            return c.json({ error: "Cluster not found" }, 404);
          }
          const records = await getRecordsByClusterId(id);
          const recommendations = generateSmartRecommendations(records);
          const meta = getClusterRecordTypeMeta(records);
          // Surface "mixed signal" — a cluster containing 2+ distinct
          // corporate domains (or distinct phones) is almost always two
          // unrelated companies that happened to share a name fragment.
          // The frontend uses this to render a red banner and a
          // "Split by domain" button.
          const mixed = await getClusterMixedSignal(id);
          return c.json({
            cluster,
            records,
            recommendations,
            primary_type: meta.primary_type,
            is_cross_module: meta.is_cross_module,
            record_types: meta.record_types,
            mixed_signal: mixed,
          });
        } catch (error: any) {
          logger.error("Error fetching cluster:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Phase 1 — Agentic Duplicate Resolution: PROPOSE a non-destructive merge
    // plan for an Accounts cluster. READ-ONLY: builds the plan in memory and
    // returns it; performs NO writes to Zoho or the radar DB. Gated on the
    // read-level duplicate-radar role (same as the cluster detail view) — the
    // destructive /execute path (separate, admin-gated) will consume the plan.
    // Response: { success, plan } — see MergePlan in duplicateMergePlanner.ts.
    path: "/api/duplicates/clusters/:id/plan",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);

          const cluster = await getClusterById(id);
          if (!cluster) return c.json({ error: "Cluster not found" }, 404);

          const records = await getRecordsByClusterId(id);
          const body = await c.req.json().catch(() => ({}));
          const module = parseAgenticModule(body);
          const recordType = MODULE_RECORD_TYPE[module];
          const moduleCount = records.filter(
            (r) => r.record_type === recordType,
          ).length;
          if (moduleCount < 2) {
            return c.json(
              {
                error: `This cluster has fewer than 2 ${module} records to plan a merge.`,
                module,
                module_record_count: moduleCount,
              },
              400,
            );
          }

          const includeZohoIds = Array.isArray(body?.record_zoho_ids)
            ? body.record_zoho_ids.filter((x: any) => typeof x === "string")
            : null;
          const masterZohoId =
            typeof body?.master_zoho_id === "string"
              ? body.master_zoho_id
              : null;
          const linkAccountZohoId =
            body && "link_account_zoho_id" in body
              ? typeof body.link_account_zoho_id === "string"
                ? body.link_account_zoho_id
                : ""
              : undefined;
          const forceMergeContacts = body?.force_merge === true;

          const generatedBy =
            (user as any)?.email || (user as any)?.role || "duplicate-radar";
          // Records already tagged Duplicate-Delete by a prior Apply on this
          // same cluster — the planner uses these to drop zombie Accounts
          // from LINK SURVIVOR TO ACCOUNT. Best-effort: if the read fails,
          // we just show the full list (no worse than before this feature).
          let taggedAccountDbIds: number[] = [];
          try {
            taggedAccountDbIds = await getTaggedRecordDbIdsByCluster(id);
          } catch (_) {
            /* non-fatal — fall back to unfiltered candidates */
          }
          let plan;
          try {
            plan = buildMergePlan(module, id, records, {
              tagName: "Duplicate-Delete",
              generatedBy,
              generatedAt: new Date().toISOString(),
              includeZohoIds,
              masterZohoId,
              linkAccountZohoId,
              taggedAccountDbIds,
              forceMergeContacts,
            });
          } catch (e: any) {
            return c.json({ error: e?.message || "Could not build plan" }, 400);
          }

          return c.json({ success: true, plan });
        } catch (error: any) {
          logger.error("Error building merge plan:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Phase 1 — Agentic Duplicate Resolution: EXECUTE a merge plan.
    // Migrates winning fields onto the survivor, reparents Deals/Contacts/Notes,
    // tags duplicates `Duplicate-Delete`, stamps audit notes, and resolves the
    // cluster. The platform NEVER deletes. DESTRUCTIVE → requireAdminOrKey.
    //
    // Body: { confirm?: boolean, dry_run?: boolean, master_zoho_id?: string }
    //   - dry-run is the default; a real write requires confirm === true.
    //   - master_zoho_id lets the operator override the survivor.
    // The plan is rebuilt server-side from live records (the client plan is
    // never trusted) and re-validated before execution.
    path: "/api/duplicates/clusters/:id/execute",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse: unauthorized } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorized(c);

          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);

          const body = await c.req.json().catch(() => ({}));
          const dryRun = body?.confirm !== true || body?.dry_run === true;
          const masterZohoId =
            typeof body?.master_zoho_id === "string"
              ? body.master_zoho_id
              : null;
          const includeZohoIds = Array.isArray(body?.record_zoho_ids)
            ? body.record_zoho_ids.filter((x: any) => typeof x === "string")
            : null;
          const linkAccountZohoId =
            body && "link_account_zoho_id" in body
              ? typeof body.link_account_zoho_id === "string"
                ? body.link_account_zoho_id
                : ""
              : undefined;
          const forceMergeContacts = body?.force_merge === true;

          const cluster = await getClusterById(id);
          if (!cluster) return c.json({ error: "Cluster not found" }, 404);
          if (cluster.status !== "active") {
            return c.json(
              {
                error: `Cluster is already '${cluster.status}'. Only active clusters can be resolved.`,
              },
              409,
            );
          }

          const records = await getRecordsByClusterId(id);
          const module = parseAgenticModule(body);
          const recordType = MODULE_RECORD_TYPE[module];
          const moduleCount = records.filter(
            (r) => r.record_type === recordType,
          ).length;
          if (moduleCount < 2) {
            return c.json(
              {
                error: `This cluster has fewer than 2 ${module} records to resolve.`,
                module,
                module_record_count: moduleCount,
              },
              400,
            );
          }

          let taggedAccountDbIdsExec: number[] = [];
          try {
            taggedAccountDbIdsExec = await getTaggedRecordDbIdsByCluster(id);
          } catch (_) {
            /* non-fatal */
          }
          let plan;
          try {
            plan = buildMergePlan(module, id, records, {
              tagName: "Duplicate-Delete",
              generatedBy:
                (sessionUser as any)?.email ||
                (sessionUser as any)?.role ||
                "duplicate-radar",
              generatedAt: new Date().toISOString(),
              masterZohoId,
              includeZohoIds,
              linkAccountZohoId,
              taggedAccountDbIds: taggedAccountDbIdsExec,
              forceMergeContacts,
            });
          } catch (e: any) {
            return c.json({ error: e?.message || "Could not build plan" }, 400);
          }

          // Multi-module clusters: Agentic resolves ONE module, so it must NOT
          // close the whole cluster — other modules' records still need their
          // own resolution (manual Mark-Resolved or a separate Agentic run).
          // Only a single-module cluster is fully resolved by one Apply.
          const isCrossModule = records.some(
            (r) => r.record_type && r.record_type !== recordType,
          );

          if (dryRun) {
            // Dry-run stays fully synchronous — no writes, no job row, just
            // the preview report (unchanged behavior).
            const report = await executeMergePlan(plan, {
              performedBy:
                (sessionUser as any)?.email ||
                (sessionUser as any)?.role ||
                "admin",
              dryRun: true,
              closeCluster: !isCrossModule,
            });

            // Learning loop — record what the agent proposed vs. what the
            // operator chose + the outcome, so the agent learns the org's
            // real preferences over time. Best-effort, never blocks.
            try {
              const proposedMasterZohoId = masterZohoId
                ? buildMergePlan(module, id, records, {
                    tagName: "Duplicate-Delete",
                    includeZohoIds,
                  }).masterZohoId
                : plan.masterZohoId;
              await recordResolutionEvent({
                clusterId: id,
                eventType: "dry_run",
                proposedMasterZohoId,
                chosenMasterZohoId: plan.masterZohoId,
                fieldsMigrated: report.fieldsMigrated.length,
                duplicatesTagged: report.taggedRecordIds.length,
                reparented:
                  report.reparented.deals +
                  report.reparented.contacts +
                  report.reparented.notes,
                errors: report.errors.length,
                plan,
                report,
                performedBy: (sessionUser as any)?.email || "admin",
              });
            } catch {
              /* learning capture is non-fatal */
            }

            return c.json({ success: true, dryRun, plan, report });
          }

          // Real run (confirm === true) — move execution off the request
          // path: a 200+-record merge used to 504 here. Single-flight via
          // the merge_jobs row (queued/running for this cluster+module wins),
          // launch the in-process worker WITHOUT awaiting, and return the
          // job id immediately. The worker rebuilds the plan from live
          // records, runs executeMergePlan + learning capture, and pings
          // Slack on completion — see src/utils/mergeJobRunner.ts.
          const { getActiveOrLatestMergeJob, createMergeJob } = await import(
            "../../utils/mergeJobsDatabase"
          );
          const existingJob = await getActiveOrLatestMergeJob(id, module);
          if (
            existingJob &&
            (existingJob.status === "queued" || existingJob.status === "running")
          ) {
            return c.json(
              {
                job_id: existingJob.id,
                status: existingJob.status,
                total: existingJob.total,
                resumed: true,
              },
              202,
            );
          }

          const total = plan.duplicateZohoIds?.length ?? moduleCount - 1;
          const job = await createMergeJob({
            clusterId: id,
            module,
            total,
            masterZohoId: plan.masterZohoId,
            createdBy:
              (sessionUser as any)?.email || (sessionUser as any)?.role || "admin",
            includeZohoIds,
            linkAccountZohoId,
            forceMergeContacts,
          });

          void import("../../utils/mergeJobRunner")
            .then((m) => m.runMergeJob(job.id))
            .catch(() => {});

          return c.json({ job_id: job.id, status: "running", total }, 202);
        } catch (error: any) {
          logger.error("Error executing merge plan:", error);
          return c.json(
            { success: false, error: error?.message || "An internal error occurred" },
            500,
          );
        }
      };
    },
  },
  {
    // Agentic Resolution — poll the background merge job started by the real
    // (non-dry-run) `/execute` above. Returns the latest job for this
    // cluster+module (queued/running takes priority over a finished one so a
    // resumed poll always sees in-flight work first), plus a `stale` flag if
    // a "running" job's heartbeat has gone cold (worker crashed mid-merge).
    path: "/api/duplicates/clusters/:id/merge-job",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse: unauthorized } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorized(c);

          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);

          const module = parseAgenticModule({ module: c.req.query("module") });
          const { getActiveOrLatestMergeJob, isMergeJobStale } = await import(
            "../../utils/mergeJobsDatabase"
          );
          const job = await getActiveOrLatestMergeJob(id, module);
          if (!job) return c.json({ job: null });
          const stale = isMergeJobStale(job, Date.now());
          return c.json({ job: { ...job, stale } });
        } catch (error: any) {
          logger.error("Error fetching merge job status:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Agentic Resolution — learned signals (read-only). Surfaces what the
    // agent has learned from platform data + operator actions: override rate,
    // apply/dry-run volume, recent corrections, plain-English guidance.
    path: "/api/duplicates/resolution-learnings",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const learnings = await getResolutionLearnings();
          return c.json({ success: true, learnings });
        } catch (error: any) {
          logger.error("Error fetching resolution learnings:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Agentic Resolution — chronological activity log (read-only). Powers the
    // "Agent Activity" section in the Logs tab: every preview/dry-run/apply the
    // agent performed, who ran it, what changed, and any errors.
    path: "/api/duplicates/resolution-activity",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const url = new URL(c.req.url);
          const limit = parseInt(url.searchParams.get("limit") || "100");
          const activity = await getResolutionActivity(
            Number.isFinite(limit) ? limit : 100,
          );
          return c.json({ success: true, activity });
        } catch (error: any) {
          logger.error("Error fetching resolution activity:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // "Manual Actions" section in the Logs tab: every Mark Resolved / Mark
    // Dismissed / Bulk-split / partial-apply (module_resolved) operators
    // perform. Reads duplicate_merge_actions, joined with the cluster row
    // for display. Filters: ?action_type=resolve,ignore,split,module_resolved
    // and ?performed_by_like=<substring> and ?cluster_id=N.
    path: "/api/duplicates/merge-actions",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const url = new URL(c.req.url);
          const limit = parseInt(url.searchParams.get("limit") || "100");
          const clusterIdRaw = url.searchParams.get("cluster_id");
          const clusterId =
            clusterIdRaw && !isNaN(Number(clusterIdRaw))
              ? Number(clusterIdRaw)
              : undefined;
          const actionTypeRaw = url.searchParams.get("action_type");
          const VALID_TYPES = [
            "resolve",
            "ignore",
            "module_resolved",
            "split",
            "merge",
          ] as const;
          const actionTypes = actionTypeRaw
            ? actionTypeRaw
                .split(",")
                .map((s) => s.trim())
                .filter((s): s is (typeof VALID_TYPES)[number] =>
                  VALID_TYPES.includes(s as any),
                )
            : undefined;
          const performedByLike =
            url.searchParams.get("performed_by_like") || undefined;
          const { getMergeHistoryEnriched } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          const actions = await getMergeHistoryEnriched({
            clusterId,
            actionTypes,
            performedByLike,
            limit: Number.isFinite(limit) ? limit : 100,
          });
          return c.json({ success: true, actions });
        } catch (error: any) {
          logger.error("Error fetching merge actions:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Agentic Resolution — LLM reviewer. READ-ONLY: builds the deterministic
    // plan + learnings briefing server-side and asks the duplicateResolution
    // Agent for a concise verdict/confidence/risks narrative. No writes; the
    // LLM only reasons over the briefing (it never authors data decisions).
    path: "/api/duplicates/clusters/:id/agent-review",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);

          const cluster = await getClusterById(id);
          if (!cluster) return c.json({ error: "Cluster not found" }, 404);

          const records = await getRecordsByClusterId(id);
          const body = await c.req.json().catch(() => ({}));
          const module = parseAgenticModule(body);
          const recordType = MODULE_RECORD_TYPE[module];
          const moduleCount = records.filter(
            (r) => r.record_type === recordType,
          ).length;
          if (moduleCount < 2) {
            return c.json(
              {
                error: `This cluster has fewer than 2 ${module} records to review.`,
                module,
                module_record_count: moduleCount,
              },
              400,
            );
          }

          const plan = buildMergePlan(module, id, records, {
            tagName: "Duplicate-Delete",
            generatedBy: (user as any)?.email || "duplicate-radar",
            generatedAt: new Date().toISOString(),
          });
          const learnings = await getResolutionLearnings();

          // Deterministic briefing — the LLM narrates over this, never edits it.
          const fieldLines = plan.fieldDecisions
            .map(
              (d) =>
                `- ${d.label}: ${d.action.toUpperCase()} → "${d.chosenValue ?? "—"}" (${d.reason})`,
            )
            .join("\n");
          const briefing =
            `MERGE BRIEFING — cluster ${id}\n` +
            `Survivor: ${plan.masterName} (${plan.masterZohoId ?? "no-zoho-id"}) — ${plan.masterReason}\n` +
            `Duplicates to tag "${plan.tagName}": ${plan.duplicateZohoIds.length} (${plan.duplicateZohoIds.join(", ") || "none"})\n` +
            `Field decisions (${plan.fieldDecisions.length}):\n${fieldLines || "- none"}\n` +
            `Warnings:\n${(plan.warnings.map((w) => "- " + w).join("\n")) || "- none"}\n\n` +
            `ORG LEARNINGS\n` +
            `- Resolutions so far: ${learnings.totalEvents} (applied ${learnings.applied}, dry-run ${learnings.dryRuns})\n` +
            `- Master override rate: ${Math.round(learnings.masterOverrideRate * 100)}%\n` +
            `- Guidance: ${learnings.guidance.join(" ")}\n\n` +
            `Produce your reviewer recommendation now.`;

          let recommendation = "";
          try {
            const { mastra } = await import("../index");
            const agent = (mastra as any)?.getAgent?.(
              "duplicateResolutionAgent",
            );
            if (agent) {
              const out = await agent.generate(briefing, { maxSteps: 1 });
              recommendation =
                (out && (out.text || out.content)) ||
                (typeof out === "string" ? out : "");
            }
          } catch (agentErr: any) {
            logger.warn("agent-review generate failed; returning plan only", {
              error: agentErr?.message || String(agentErr),
            });
          }

          // Capture the review as a 'preview' learning signal (best-effort).
          try {
            await recordResolutionEvent({
              clusterId: id,
              eventType: "preview",
              proposedMasterZohoId: plan.masterZohoId,
              chosenMasterZohoId: plan.masterZohoId,
              plan,
              performedBy: (user as any)?.email || "reviewer",
            });
          } catch {
            /* non-fatal */
          }

          return c.json({
            success: true,
            recommendation:
              recommendation ||
              "AI reviewer unavailable — see the deterministic plan and warnings.",
            plan,
            learnings,
          });
        } catch (error: any) {
          logger.error("Error in agent-review:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/clusters/:id/split",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          // Splitting a cluster is a state-mutating, hard-to-undo write.
          // Gate it on the same write-level role used by /resolve, /primary
          // and /bulk-resolve — NOT the read-only duplicate-radar viewer
          // role, which would otherwise let analysts mutate cluster shape.
          const { requireAdminOrKey, unauthorizedResponse: unauthorized } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorized(c);

          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);

          const body = await c.req.json().catch(() => ({}));
          const mode: string = body.mode || "manual";

          // Confirm the source cluster exists before doing anything.
          const source = await getClusterById(id);
          if (!source) return c.json({ error: "Cluster not found" }, 404);

          // Build one-or-more split plans.
          // Each plan = { recordIds, seed: { company_name, domain } }.
          const plans: Array<{
            recordIds: number[];
            seed: { company_name: string; domain?: string | null };
          }> = [];

          if (mode === "by_domain") {
            const mixed = await getClusterMixedSignal(id);
            if (mixed.domains.length < 2) {
              return c.json(
                { error: "Cluster does not have multiple domains to split" },
                400,
              );
            }
            // Keep the largest group on the source cluster (matches the
            // user's mental model: "the original cluster shrinks, the
            // outlier becomes its own"). Split every other domain off.
            // The scan-time conflict guard prevents re-merging on the
            // next scan because incoming records carry their own domain.
            const allRecords = await getRecordsByClusterId(id);
            const sortedDomains = [...mixed.domains].sort((a, b) => {
              const la = (mixed.domain_groups[a] || []).length;
              const lb = (mixed.domain_groups[b] || []).length;
              return lb - la;
            });
            for (const dom of sortedDomains.slice(1)) {
              const ids = mixed.domain_groups[dom] || [];
              if (ids.length === 0) continue;
              // Pick the first record's company_name as the seed for the
              // new cluster — the operator can rename later via Zoho.
              const seedRec = allRecords.find(
                (r) => (r.id as number | undefined) === ids[0],
              );
              plans.push({
                recordIds: ids,
                seed: {
                  company_name: seedRec?.company_name || dom,
                  domain: dom,
                },
              });
            }
          } else if (mode === "by_name") {
            // Auto-split by distinct COMPANY NAME — for name-collision clusters
            // (two real companies sharing a word, e.g. "Andalusia Group" vs
            // "Andalusia Hospital"). Group records by normalized company name,
            // keep the largest group on the source cluster, split each other
            // name-group into its own cluster. NOTE: an EN and AR spelling of
            // the SAME company normalize differently, so they may land in
            // separate groups — use the manual tick-split for those.
            const allRecords = await getRecordsByClusterId(id);
            const byName = new Map<string, { ids: number[]; label: string }>();
            for (const r of allRecords) {
              const raw = (r.company_name || r.record_name || "").trim();
              const key = normalizeCompanyName(raw) || `__${r.id}`;
              if (!byName.has(key)) byName.set(key, { ids: [], label: raw || key });
              if (typeof r.id === "number") byName.get(key)!.ids.push(r.id);
            }
            const groups = Array.from(byName.values()).filter((g) => g.ids.length > 0);
            if (groups.length < 2) {
              return c.json(
                { error: "All records share the same company name — nothing to split by name." },
                400,
              );
            }
            // Keep the largest group on the source; split the rest off.
            groups.sort((a, b) => b.ids.length - a.ids.length);
            for (const g of groups.slice(1)) {
              plans.push({
                recordIds: g.ids,
                seed: { company_name: g.label, domain: null },
              });
            }
          } else {
            // Manual mode: caller supplies the record IDs to move out.
            const recordIds: number[] = Array.isArray(body.record_ids)
              ? body.record_ids
                  .map((n: unknown) => Number(n))
                  .filter((n: number) => Number.isFinite(n))
              : [];
            if (recordIds.length === 0) {
              return c.json(
                { error: "record_ids must be a non-empty array" },
                400,
              );
            }
            plans.push({
              recordIds,
              seed: {
                company_name:
                  typeof body.new_company_name === "string" &&
                  body.new_company_name.trim()
                    ? body.new_company_name.trim()
                    : `${source.company_name || "Cluster"} (split)`,
                domain:
                  typeof body.new_domain === "string" && body.new_domain.trim()
                    ? body.new_domain.trim().toLowerCase()
                    : null,
              },
            });
          }

          if (plans.length === 0) {
            return c.json({ error: "Nothing to split" }, 400);
          }

          // Wrap ALL plans in a single DB transaction so a failure on plan
          // N rolls back plans 0..N-1 — operators never see a half-applied
          // split. Stats refresh runs AFTER commit (idempotent, best-effort).
          const { pool: duplicateRadarPool } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          const client = await (duplicateRadarPool as any).connect();
          const newClusterIds: number[] = [];
          try {
            await client.query("BEGIN");
            for (const plan of plans) {
              const result = await splitRecordsIntoNewClusterInTx(
                client,
                id,
                plan.recordIds,
                plan.seed,
              );
              newClusterIds.push(result.new_cluster_id);
            }
            await client.query("COMMIT");
          } catch (txErr) {
            try {
              await client.query("ROLLBACK");
            } catch {
              /* ignore rollback failure */
            }
            throw txErr;
          } finally {
            client.release();
          }

          // Post-commit stats refresh (idempotent). A failure here doesn't
          // invalidate the split — the next scan or manual refresh will
          // re-derive the same numbers.
          try {
            await updateClusterStats(id);
            for (const ncid of newClusterIds) {
              await updateClusterStats(ncid);
            }
          } catch (statsErr) {
            logger.warn(
              "Post-split stats refresh failed (non-fatal)",
              statsErr as any,
            );
          }

          // Durable separation (Ahmad 2026-06-20): record that the records left
          // on the source cluster and the records in each split-off cluster are
          // NOT duplicates of each other, so the next sync can't re-fuse them by
          // a shared name / phone / domain and silently undo this split.
          try {
            const { pool: dpool, recordSeparations } = await import(
              "../../utils/duplicateRadarDatabase"
            );
            const groups: string[][] = [];
            for (const cid of [id, ...newClusterIds]) {
              const rr = await dpool.query(
                `SELECT zoho_record_id FROM duplicate_records
                  WHERE cluster_id = $1 AND zoho_record_id IS NOT NULL`,
                [cid],
              );
              groups.push(rr.rows.map((r: any) => r.zoho_record_id as string));
            }
            const n = await recordSeparations(
              groups,
              "split",
              (sessionUser as any)?.email || "operator",
            );
            logger.info(
              `[DuplicateRadar] Split cluster ${id}: recorded ${n} separation pair(s) so it won't re-cluster`,
            );
          } catch (sepErr) {
            logger.warn(
              "Post-split separation-ledger write failed (non-fatal)",
              sepErr as any,
            );
          }

          return c.json({
            success: true,
            source_cluster_id: id,
            new_cluster_ids: newClusterIds,
            split_count: newClusterIds.length,
          });
        } catch (error: any) {
          logger.error("Error splitting cluster:", error);
          return c.json(
            { error: error?.message || "An internal error occurred" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/duplicates/clusters/:id/status",
    method: "PATCH" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);
          const { status } = await c.req.json();

          if (!["active", "resolved", "ignored"].includes(status)) {
            return c.json({ error: "Invalid status" }, 400);
          }

          const cluster = await updateClusterStatus(id, status);
          if (!cluster) {
            return c.json({ error: "Cluster not found" }, 404);
          }

          return c.json({ success: true, cluster });
        } catch (error: any) {
          logger.error("Error updating cluster status:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/by-owner",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const data = await getDuplicatesByOwner();
          return c.json({ owners: data });
        } catch (error: any) {
          logger.error("Error fetching by owner:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/by-source",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const data = await getDuplicatesBySource();
          return c.json({ sources: data });
        } catch (error: any) {
          logger.error("Error fetching by source:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // R6 — Cross-module overlaps. Returns the active clusters that
    // span 2+ record types (Lead+Contact, Lead+Account, etc.), each
    // classified by pairing type so the dashboard can KPI / filter
    // them. Default limit 200 (most tenants run well under that for
    // open cross-module clusters); use ?limit=N to override.
    //
    // Query params:
    //   limit=N        cap result list, default 200, clamped [1, 1000]
    //   pairing=key    filter to one pairing
    //                  (lead_contact / lead_account / lead_deal /
    //                   contact_account / contact_deal /
    //                   deal_account / mixed)
    path: "/api/duplicates/cross-module-overlaps",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const limitRaw = url.searchParams.get("limit");
          // Default to "all" (100k ceiling in getCrossModuleOverlaps) — the old
          // 200 default silently hid real cross-module overlaps.
          const limit = limitRaw ? parseInt(limitRaw, 10) : 100000;
          const pairingRaw = url.searchParams.get("pairing");
          const allowedPairings = new Set([
            "lead_contact",
            "lead_account",
            "lead_deal",
            "contact_account",
            "contact_deal",
            "deal_account",
            "mixed",
          ]);
          const pairing =
            pairingRaw && allowedPairings.has(pairingRaw)
              ? (pairingRaw as
                  | "lead_contact"
                  | "lead_account"
                  | "lead_deal"
                  | "contact_account"
                  | "contact_deal"
                  | "deal_account"
                  | "mixed")
              : null;

          const statusRaw = (url.searchParams.get("status") || "active").toLowerCase();
          const status = (["active", "resolved", "ignored", "all"].includes(statusRaw)
            ? statusRaw
            : "active") as "active" | "resolved" | "ignored" | "all";

          const { getCrossModuleOverlaps } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          const result = await getCrossModuleOverlaps({
            limit: Number.isFinite(limit) ? limit : 200,
            pairing,
            status,
          });
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error fetching cross-module overlaps:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Follow-up 3 — Bulk-close lead records in selected cross-module
    // clusters. For each cluster_id, the helper PUTs Lead_Status='Lost Lead'
    // on every Lead record's Zoho id, then marks the cluster resolved if
    // every Zoho write succeeded. Body:
    //   { cluster_ids: number[], dry_run?: boolean, max_clusters?: number }
    //
    // Auth: requireAdminOrKey — this is a destructive write to Zoho.
    //
    // Response: per-cluster summary so the operator can see exactly what
    // closed, what was skipped (already-Lost), what failed and why.
    path: "/api/duplicates/cross-module-overlaps/bulk-close-leads",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          let body: any = {};
          try {
            body = (await c.req.json()) ?? {};
          } catch {
            return c.json(
              {
                success: false,
                error:
                  "Body must be JSON: { cluster_ids: number[], dry_run?, max_clusters? }",
              },
              400,
            );
          }

          if (!Array.isArray(body.cluster_ids) || body.cluster_ids.length === 0) {
            return c.json(
              {
                success: false,
                error: "cluster_ids must be a non-empty array of cluster IDs",
              },
              400,
            );
          }

          const ids: number[] = body.cluster_ids
            .map((x: any) => Number(x))
            .filter((n: number) => Number.isFinite(n) && n > 0);
          if (ids.length === 0) {
            return c.json(
              {
                success: false,
                error: "cluster_ids contained no valid positive integers",
              },
              400,
            );
          }

          const { bulkCloseLeadsInClusters } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          const result = await bulkCloseLeadsInClusters({
            clusterIds: ids,
            performedBy: sessionUser.email || "admin",
            dryRun: !!body.dry_run,
            maxClusters:
              typeof body.max_clusters === "number"
                ? body.max_clusters
                : undefined,
          });
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error in bulk-close-leads:", error);
          return c.json(
            { success: false, error: error?.message || "An internal error occurred" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/duplicates/kpis",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const kpis = await getKPIMetrics();
          return c.json(kpis);
        } catch (error: any) {
          logger.error("Error fetching KPIs:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // R4 — Creation-rate trend. Returns weekly (or daily) buckets of
    // new duplicate records vs new total records, plus the percentage
    // duplicate-rate per bucket. Stakeholders use the slope as the
    // leading indicator of whether prevention work is paying off.
    // Query params:
    //   weeks=N        window size, default 12, clamped 1-52
    //   granularity=week|day  default 'week'
    path: "/api/duplicates/creation-trend",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const weeksRaw = url.searchParams.get("weeks");
          const granRaw = url.searchParams.get("granularity");
          const weeks = weeksRaw ? parseInt(weeksRaw, 10) : 12;
          const granularity: "week" | "day" =
            granRaw === "day" ? "day" : "week";

          const { getDuplicateCreationTrend } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          const trend = await getDuplicateCreationTrend({
            weeks: Number.isFinite(weeks) ? weeks : 12,
            granularity,
          });
          return c.json({ success: true, ...trend });
        } catch (error: any) {
          logger.error("Error fetching creation trend:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/logs",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const limit = parseInt(url.searchParams.get("limit") || "50");
          const logs = await getDetectionLogs(limit);
          return c.json({ logs });
        } catch (error: any) {
          logger.error("Error fetching logs:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/search",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const query = url.searchParams.get("query") || "";
          const record_type =
            (url.searchParams.get("type") as "lead" | "deal" | "all") || "all";
          const limit = parseInt(url.searchParams.get("limit") || "50");
          const offset = parseInt(url.searchParams.get("offset") || "0");

          logger.info(
            `🔍 [DuplicateRadar] Search query: "${query}", type: ${record_type}`,
          );

          const searchParams = {
            company_name: query,
            domain: query,
            email: query.includes("@") ? query : undefined,
            record_type: record_type === "all" ? undefined : record_type,
            limit,
            offset,
          };

          const results = await searchDuplicates(searchParams);

          return c.json({
            success: true,
            query,
            records: results.records,
            clusters: results.clusters,
            total: results.total_records,
          });
        } catch (error: any) {
          logger.error("Error searching duplicates:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/scan-zoho",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const body = await c.req.json().catch(() => ({}));
          const blocked = blockOrClearScan(body?.force === true);
          if (blocked) {
            return c.json(
              {
                success: false,
                error: blocked.error,
                ageMinutes: blocked.ageMinutes,
                progress: scanState.progress,
                startedAt: scanState.startedAt,
                hint: "Send { force: true } to abort the in-progress scan and start a fresh one.",
              },
              409,
            );
          }

          logger.info(
            "🚀 [DuplicateRadar] Zoho CRM scan triggered via API (async)",
          );

          scanZohoCRMForDuplicates().catch((err) => {
            logger.error("[DuplicateRadar] Background scan error:", err);
            scanState.status = "failed";
            scanState.error = err?.message || "Background scan failed";
          });

          return c.json({
            success: true,
            message:
              "Scan started in background. Poll /api/duplicates/scan-status or connect to /api/duplicates/scan-stream for real-time progress.",
            status: "scanning",
          });
        } catch (error: any) {
          logger.error("Error starting Zoho CRM scan:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // One-shot purge of singleton clusters (status='active' AND
    // total_records<=1). Engine residue, not duplicates. Defaults to
    // dryRun=true: returns the audit + 20-row sample + the count of
    // duplicate_records pointing at them. Caller must POST
    // { "dryRun": false } to actually delete. Refuses if candidate
    // count > maxDelete (default 100k). Admin-only.
    path: "/api/duplicates/cleanup-singletons",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const body = await c.req.json().catch(() => ({}));
          const dryRun = body?.dryRun !== false;
          const maxDelete =
            typeof body?.maxDelete === "number" && body.maxDelete > 0
              ? Math.floor(body.maxDelete)
              : 100000;

          const { cleanupSingletonClusters } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          const result = await cleanupSingletonClusters({ dryRun, maxDelete });
          logger.info(
            `🧹 [DuplicateRadar] cleanupSingletonClusters (${dryRun ? "DRY-RUN" : "APPLIED"}) by ${sessionUser?.email || "admin-key"}: ${result.candidateCount} candidates, deleted ${result.deletedClusterCount}, cleared ${result.cleanedRecordCount} records, refused=${result.refusedReason ?? "no"}`,
          );
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error in cleanup-singletons:", error);
          return c.json(
            { success: false, error: "An internal error occurred" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/duplicates/rebuild",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const rebuildBody = await c.req.json().catch(() => ({}));
          const rebuildBlocked = blockOrClearScan(rebuildBody?.force === true);
          if (rebuildBlocked) {
            return c.json(
              {
                success: false,
                error: rebuildBlocked.error,
                ageMinutes: rebuildBlocked.ageMinutes,
                progress: scanState.progress,
                startedAt: scanState.startedAt,
                hint: "Send { force: true } to abort the in-progress scan and start a fresh one.",
              },
              409,
            );
          }

          logger.info(
            "🧨 [DuplicateRadar] Rebuild Clusters triggered — wiping tables and rescanning",
          );
          await truncateAllDuplicateData();

          // forceFull=true: we just wiped everything, so a full re-pull is
          // mandatory — an incremental (changed-only) fetch here would leave
          // the radar nearly empty.
          scanZohoCRMForDuplicates("manual", true).catch((err) => {
            logger.error(
              "[DuplicateRadar] Background rebuild scan error:",
              err,
            );
            scanState.status = "failed";
            scanState.error = err?.message || "Background scan failed";
          });

          return c.json({
            success: true,
            message:
              "Clusters wiped. A fresh Zoho scan is rebuilding them. Watch /api/duplicates/scan-stream for progress.",
            status: "scanning",
          });
        } catch (error: any) {
          logger.error("Error rebuilding clusters:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/scan-status",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const elapsed = scanState.startedAt
            ? Date.now() - scanState.startedAt
            : 0;
          return c.json({
            status: scanState.status,
            progress: scanState.progress,
            startedAt: scanState.startedAt,
            completedAt: scanState.completedAt,
            elapsedMs: elapsed,
            percentage: scanState.percentage,
            moduleStatuses: scanState.moduleStatuses,
            recordCounts: scanState.recordCounts,
            result:
              scanState.status === "completed" || scanState.status === "failed"
                ? scanState.result
                : null,
            error: scanState.error,
          });
        } catch (error) {
          return c.json(
            { status: "unknown", error: "Failed to get scan status" },
            500,
          );
        }
      };
    },
  },
  // C1: SSE endpoint for real-time scan progress
  {
    path: "/api/duplicates/scan-stream",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const clientId = `sse-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

          let keepAlive: ReturnType<typeof setInterval> | undefined;

          const stream = new ReadableStream({
            start(controller) {
              sseClients.push({ id: clientId, controller });

              const initialMsg = `event: connected\ndata: ${JSON.stringify({
                clientId,
                currentStatus: scanState.status,
                progress: scanState.progress,
                percentage: scanState.percentage,
                moduleStatuses: scanState.moduleStatuses,
                elapsedMs: scanState.startedAt
                  ? Date.now() - scanState.startedAt
                  : 0,
              })}\n\n`;
              controller.enqueue(new TextEncoder().encode(initialMsg));

              keepAlive = setInterval(() => {
                try {
                  controller.enqueue(
                    new TextEncoder().encode(": keepalive\n\n"),
                  );
                } catch {
                  clearInterval(keepAlive);
                  keepAlive = undefined;
                }
              }, 15000);
              // Allow the Node event loop to exit even if this interval is still
              // active (e.g. during in-process tests). The interval is also
              // cleared explicitly in cancel() when the client disconnects.
              keepAlive.unref();
            },
            cancel() {
              clearInterval(keepAlive);
              keepAlive = undefined;
              sseClients = sseClients.filter((c) => c.id !== clientId);
            },
          });

          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "X-Accel-Buffering": "no",
            },
          });
        } catch (error) {
          return c.json({ error: "Failed to create SSE stream" }, 500);
        }
      };
    },
  },
  // A6: RBAC guard on DELETE mock-data
  {
    path: "/api/duplicates/mock-data",
    method: "DELETE" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          await clearMockData();
          return c.json({ success: true, message: "Mock data cleared" });
        } catch (error: any) {
          logger.error("Error clearing mock data:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/export/estimate",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const owner = url.searchParams.get("owner") || undefined;
          const startDate = url.searchParams.get("start_date") || undefined;
          const endDate = url.searchParams.get("end_date") || undefined;

          const filterParams: unknown[] = ["active"];
          let whereClause = "WHERE dc.status = $1";
          if (owner) {
            filterParams.push(owner);
            whereClause += ` AND (dr.owner_name = $${filterParams.length} OR dr.owner_email = $${filterParams.length})`;
          }
          if (startDate) {
            filterParams.push(startDate);
            whereClause += ` AND dr.created_date >= $${filterParams.length}`;
          }
          if (endDate) {
            filterParams.push(endDate + "T23:59:59Z");
            whereClause += ` AND dr.created_date <= $${filterParams.length}`;
          }

          // Use the module-level shared pool. Creating a fresh pg.Pool per
          // request was opening TCP connections that never recycled; under
          // concurrent owner-export traffic (operator clicks several rows
          // in a row) the host's connection limit was being hit and the
          // streams stalled, which the client's abort logic surfaced as
          // "Cancelled" in the download history.
          const r = await sharedDuplicateRadarPool.query(
            `SELECT COUNT(*)::int AS total FROM duplicate_records dr JOIN duplicate_clusters dc ON dr.cluster_id = dc.id ${whereClause}`,
            filterParams,
          );
          const { estimateFromCount, estimateResponse } =
            await import("../../utils/exportEstimate");
          return estimateResponse(
            estimateFromCount(r.rows[0]?.total, "csv", 240),
          );
        } catch (error: any) {
          logger.error("Error estimating duplicates CSV export:", error);
          return c.json({ error: "Failed to estimate export size" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/export-xlsx/estimate",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const start_date = url.searchParams.get("start_date") || undefined;
          const end_date = url.searchParams.get("end_date") || undefined;
          const includeRaw = url.searchParams.get("include_raw") === "1";

          const filterParams: unknown[] = [];
          let whereClause = "WHERE dc.status = 'active'";
          if (start_date) {
            filterParams.push(start_date);
            whereClause += ` AND dr.created_date >= $${filterParams.length}`;
          }
          if (end_date) {
            filterParams.push(end_date + "T23:59:59Z");
            whereClause += ` AND dr.created_date <= $${filterParams.length}`;
          }

          const r = await sharedDuplicateRadarPool.query(
            `SELECT COUNT(*)::int AS total FROM duplicate_records dr JOIN duplicate_clusters dc ON dr.cluster_id = dc.id ${whereClause}`,
            filterParams,
          );
          // Type-split sheets duplicate the per-record overhead 4x; All Records
          // adds a 5th copy when include_raw=1. Bump the per-row average so the
          // estimate stays conservative against the picker threshold.
          const baseRows = r.rows[0]?.total ?? 0;
          const sheetMultiplier = includeRaw ? 5 : 4;
          const { estimateBytesFromRows, estimateResponse } =
            await import("../../utils/exportEstimate");
          return estimateResponse({
            rows: baseRows,
            bytes: estimateBytesFromRows(
              baseRows * sheetMultiplier,
              "xlsx",
              140,
            ),
            format: "xlsx",
          });
        } catch (error: any) {
          logger.error("Error estimating duplicates XLSX export:", error);
          return c.json({ error: "Failed to estimate export size" }, 500);
        }
      };
    },
  },
  // B5: JOIN-based export (no N+1)
  {
    path: "/api/duplicates/export",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const exportType = url.searchParams.get("type") || "all";
          const owner = url.searchParams.get("owner") || undefined;
          const startDate = url.searchParams.get("start_date") || undefined;
          const endDate = url.searchParams.get("end_date") || undefined;
          // Optional per-module filter so the per-tab "Export CSV" buttons
          // (replacing the standalone Export Center tab) can scope the
          // download to just the module the user is currently viewing.
          // Allow only the canonical record types — anything else is
          // ignored to keep the WHERE clause shape stable.
          const rawRecordType = url.searchParams.get("record_type") || "";
          const recordType = ["lead", "deal", "contact", "account"].includes(
            rawRecordType,
          )
            ? rawRecordType
            : undefined;

          const { escapeCSVValue } = await import("../../utils/inputSanitizer");
          const { streamCsv, cursorQuery, stageStreamingExportFromHono } =
            await import("../../utils/excelExport");
          const {
            PLAYBOOK_HEADERS,
            emptyPlaybookState,
            startCluster,
            rowPlaybook,
          } = await import("../../utils/duplicateRadarPlaybook");

          // Build WHERE clause matching getExportRecords filter logic
          const filterParams: unknown[] = ["active"];
          let whereClause = "WHERE dc.status = $1";
          if (owner) {
            filterParams.push(owner);
            whereClause += ` AND (dr.owner_name = $${filterParams.length} OR dr.owner_email = $${filterParams.length})`;
          }
          if (startDate) {
            filterParams.push(startDate);
            whereClause += ` AND dr.created_date >= $${filterParams.length}`;
          }
          if (endDate) {
            filterParams.push(endDate + "T23:59:59Z");
            whereClause += ` AND dr.created_date <= $${filterParams.length}`;
          }
          if (recordType) {
            filterParams.push(recordType);
            whereClause += ` AND dr.record_type = $${filterParams.length}`;
            // Match the per-tab UI (getDuplicateRecordsByType): a record only
            // appears under the Lead/Deal/Contact/Account tab when its cluster
            // has more than one record of that same type. Without this guard
            // the CSV pulled extra rows from cross-module clusters (e.g. a
            // lead sharing a cluster with a contact but no other lead) and
            // ended up larger than the table the user was looking at.
            const countCol =
              recordType === "lead"
                ? "total_leads"
                : recordType === "deal"
                  ? "total_deals"
                  : recordType === "contact"
                    ? "total_contacts"
                    : "total_accounts";
            whereClause += ` AND dc.${countCol} > 1`;
          }

          // Use the module-level shared pool. The cursor stream releases
          // its own client when complete or on error, so we don't manage
          // pool lifetime here. Fresh-pool-per-request was causing
          // connection exhaustion under concurrent owner-export traffic.
          const drCsvPool = sharedDuplicateRadarPool;

          // Count query for the export log (fast aggregate, not a full materialisation)
          const countRes = await drCsvPool.query(
            `SELECT COUNT(*)::int AS total FROM duplicate_records dr JOIN duplicate_clusters dc ON dr.cluster_id = dc.id ${whereClause}`,
            filterParams,
          );
          const totalCount: number = countRes.rows[0]?.total ?? 0;

          await createExportLog({
            export_type: exportType as any,
            filter_criteria: { owner, startDate, endDate },
            total_records_exported: totalCount,
            file_format: "csv",
            exported_by: "User",
          });

          const csvHeaders = [
            "Record ID",
            "Type",
            "Name",
            "Company",
            "Domain",
            "Owner",
            "Status/Stage",
            "Value",
            "Source",
            "Created Date",
            "Confidence",
            "Recommendation",
            // R1 (quick wins): remediation-playbook columns appended after
            // the raw record data. Stakeholders skim the right side of the
            // sheet for what to do, due dates, and who to contact.
            ...PLAYBOOK_HEADERS,
          ];
          const source = cursorQuery(
            drCsvPool,
            `SELECT dr.cluster_id, dr.zoho_record_id, dr.id, dr.record_type, dr.record_name, dr.company_name, dr.domain,
                    dr.owner_name, dr.owner_email, dr.status, dr.stage, dr.deal_value, dr.source, dr.created_date,
                    dr.confidence_score, dr.ai_recommendation, dr.is_primary,
                    dc.confidence_score AS cluster_confidence_score,
                    dc.total_records AS cluster_total_records
             FROM duplicate_records dr JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
             ${whereClause}
             ORDER BY dc.total_records DESC, dr.cluster_id, dr.is_primary DESC`,
            filterParams,
          );
          const rows = (async function* () {
            // Cluster-scoped state: ORDER BY puts is_primary=true first
            // within each cluster, so the first row we see for a cluster
            // carries the primary record's name. Subsequent rows in the
            // same cluster reuse that primary name in the "Merge into …"
            // recommendation.
            const playbookState = emptyPlaybookState();
            for await (const r of source) {
              const rec = r as Record<string, unknown>;
              const cid = Number(rec["cluster_id"] ?? -1);
              if (cid !== playbookState.cluster_id) {
                startCluster(playbookState, rec);
              }
              const pb = rowPlaybook(rec, playbookState);
              yield [
                rec["zoho_record_id"] ?? rec["id"],
                rec["record_type"],
                rec["record_name"],
                rec["company_name"],
                rec["domain"],
                rec["owner_name"],
                rec["status"] ?? rec["stage"],
                rec["deal_value"] ?? "",
                rec["source"],
                rec["created_date"],
                rec["confidence_score"] == null
                  ? ""
                  : `${rec["confidence_score"]}%`,
                rec["ai_recommendation"] ?? "Review manually",
                pb.recommended_action,
                pb.survivorship_rule,
                pb.owner_to_consult,
                pb.why_verdict,
                pb.due_date,
              ].map((v) => escapeCSVValue(String(v ?? "")));
            }
            // No pool.end() — shared pool is reused across requests.
            // cursorQuery() releases the per-stream client in its own
            // finally block.
          })();
          return await stageStreamingExportFromHono(c, () =>
            streamCsv(
              `duplicate_radar_export_${Date.now()}.csv`,
              csvHeaders,
              rows,
            ),
          );
        } catch (error: any) {
          logger.error("Error exporting data:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/export-xlsx",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const start_date = url.searchParams.get("start_date") || undefined;
          const end_date = url.searchParams.get("end_date") || undefined;
          const includeRaw = url.searchParams.get("include_raw") === "1";

          const { streamXlsx, cursorQuery, stageStreamingExportFromHono } =
            await import("../../utils/excelExport");
          const {
            PLAYBOOK_XLSX_COLUMNS,
            emptyPlaybookState,
            startCluster,
            rowPlaybook,
          } = await import("../../utils/duplicateRadarPlaybook");

          // Build WHERE clause for date filters (no status filter — XLSX exports all active)
          const xlsxFilterParams: unknown[] = [];
          let xlsxWhere = "WHERE dc.status = 'active'";
          if (start_date) {
            xlsxFilterParams.push(start_date);
            xlsxWhere += ` AND dr.created_date >= $${xlsxFilterParams.length}`;
          }
          if (end_date) {
            xlsxFilterParams.push(end_date + "T23:59:59Z");
            xlsxWhere += ` AND dr.created_date <= $${xlsxFilterParams.length}`;
          }

          // Shared module-level pool (see /export rationale).
          const drXlsxPool = sharedDuplicateRadarPool;

          // Aggregate summary counts and enhanced summary — small results
          const [typeCntRes, summary] = await Promise.all([
              drXlsxPool.query(
                `SELECT COALESCE(dr.record_type, 'other') AS rtype, COUNT(*)::int AS cnt
                 FROM duplicate_records dr JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
                 ${xlsxWhere} GROUP BY dr.record_type`,
                xlsxFilterParams,
              ),
              getEnhancedSummary(),
            ]);

            const countByType: Record<string, number> = {};
            let totalXlsx = 0;
            for (const row of typeCntRes.rows) {
              countByType[row.rtype] = row.cnt;
              totalXlsx += row.cnt;
            }

            // Log export (non-blocking)
            try {
              await createExportLog({
                export_type: "all",
                filter_criteria: {
                  start_date,
                  end_date,
                  include_raw: includeRaw,
                },
                total_records_exported: totalXlsx,
                file_format: "xlsx",
                exported_by: "User",
              });
            } catch (logErr) {
              logger.warn(
                "[DuplicateRadar] export-xlsx log write failed (non-blocking):",
                logErr,
              );
            }

            const recordColumns = [
              { header: "Cluster ID", key: "cluster_id", width: 12 },
              { header: "Zoho ID", key: "zoho_record_id", width: 22 },
              { header: "Name", key: "record_name", width: 30 },
              { header: "Company", key: "company_name", width: 30 },
              { header: "Email", key: "email", width: 28 },
              { header: "Domain", key: "domain", width: 22 },
              { header: "Phone", key: "phone", width: 18 },
              { header: "Owner", key: "owner_name", width: 22 },
              { header: "Status / Stage", key: "status_or_stage", width: 18 },
              { header: "Value", key: "deal_value", width: 14 },
              { header: "Source", key: "source", width: 18 },
              { header: "Confidence", key: "confidence_score", width: 12 },
              { header: "Recommendation", key: "ai_recommendation", width: 40 },
              { header: "Created", key: "created_str", width: 14 },
              // R1 (quick wins): remediation playbook columns appended to
              // every type sheet so stakeholders see action / owner / due
              // alongside the raw record data.
              ...PLAYBOOK_XLSX_COLUMNS,
            ];

            // SQL template for per-type cursor queries — avoids raw_data JSONB blob.
            // Pulls is_primary + owner_email + cluster_confidence_score so
            // the playbook helpers can compute Merge-into-X / due-date /
            // owner-to-consult / survivorship-rule for each row.
            const typeIdx = xlsxFilterParams.length + 1;
            const recSql = `
              SELECT dr.cluster_id, dr.zoho_record_id, dr.record_name, dr.company_name, dr.email,
                     dr.domain, dr.phone, dr.owner_name, dr.owner_email, dr.is_primary,
                     COALESCE(dr.status, dr.stage, '') AS status_or_stage,
                     dr.deal_value, dr.source, dr.confidence_score, dr.ai_recommendation,
                     TO_CHAR(dr.created_date::date, 'YYYY-MM-DD') AS created_str,
                     dc.confidence_score AS cluster_confidence_score,
                     dc.total_records AS cluster_total_records
              FROM duplicate_records dr JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
              ${xlsxWhere} AND dr.record_type = $${typeIdx}
              ORDER BY dc.total_records DESC, dr.cluster_id, dr.is_primary DESC`;

            // Async generator that enriches each row with the five playbook
            // fields. Cluster state is per-generator-instance so the four
            // type sheets (lead/deal/contact/account) don't share state.
            const enrichRows = (src: AsyncIterable<unknown>) =>
              (async function* () {
                const state = emptyPlaybookState();
                for await (const r of src) {
                  const rec = r as Record<string, unknown>;
                  const cid = Number(rec["cluster_id"] ?? -1);
                  if (cid !== state.cluster_id) {
                    startCluster(state, rec);
                  }
                  const pb = rowPlaybook(rec, state);
                  yield { ...rec, ...pb } as Record<string, unknown>;
                }
              })();

            const makeTypeRows = (rtype: string) => {
              const src = cursorQuery(drXlsxPool, recSql, [
                ...xlsxFilterParams,
                rtype,
              ]);
              return enrichRows(src);
            };

            const sheets: Array<{
              name: string;
              columns: typeof recordColumns;
              rows:
                | AsyncIterable<Record<string, unknown>>
                | Array<Record<string, unknown>>;
            }> = [
              {
                name: "Summary",
                columns: [
                  { header: "Metric", key: "metric", width: 32 },
                  { header: "Value", key: "value", width: 18 },
                ],
                rows: [
                  {
                    metric: "Total clusters",
                    value: summary?.totalClusters ?? 0,
                  },
                  { metric: "Total duplicate records", value: totalXlsx },
                  { metric: "Singletons", value: summary?.singletonCount ?? 0 },
                  {
                    metric: "Resolution rate",
                    value: summary?.resolutionRate
                      ? `${summary.resolutionRate}%`
                      : "n/a",
                  },
                  {
                    metric: "Low-confidence clusters",
                    value: summary?.lowConfidence ?? 0,
                  },
                  {
                    metric: "Leads with duplicates",
                    value: countByType["lead"] ?? 0,
                  },
                  {
                    metric: "Deals with duplicates",
                    value: countByType["deal"] ?? 0,
                  },
                  {
                    metric: "Contacts with duplicates",
                    value: countByType["contact"] ?? 0,
                  },
                  {
                    metric: "Accounts with duplicates",
                    value: countByType["account"] ?? 0,
                  },
                  { metric: "Date range start", value: start_date || "(all)" },
                  { metric: "Date range end", value: end_date || "(all)" },
                  { metric: "Generated", value: new Date().toISOString() },
                ],
              },
              {
                name: "Leads",
                columns: recordColumns,
                rows: makeTypeRows("lead"),
              },
              {
                name: "Deals",
                columns: recordColumns,
                rows: makeTypeRows("deal"),
              },
              {
                name: "Contacts",
                columns: recordColumns,
                rows: makeTypeRows("contact"),
              },
            ];

            const accountsSrc = cursorQuery(drXlsxPool, recSql, [
              ...xlsxFilterParams,
              "account",
            ]);
            sheets.push({
              name: "Accounts",
              columns: recordColumns,
              rows: enrichRows(accountsSrc),
            });

            if (includeRaw) {
              const allSrc = cursorQuery(
                drXlsxPool,
                `SELECT dr.cluster_id, dr.zoho_record_id, dr.record_name, dr.company_name, dr.email, dr.domain,
                        dr.phone, dr.owner_name, dr.owner_email, dr.is_primary,
                        COALESCE(dr.status, dr.stage, '') AS status_or_stage,
                        dr.deal_value, dr.source, dr.confidence_score, dr.ai_recommendation,
                        TO_CHAR(dr.created_date::date, 'YYYY-MM-DD') AS created_str,
                        dc.confidence_score AS cluster_confidence_score,
                        dc.total_records AS cluster_total_records
                 FROM duplicate_records dr JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
                 ${xlsxWhere} ORDER BY dc.total_records DESC, dr.cluster_id, dr.is_primary DESC`,
                xlsxFilterParams,
              );
              sheets.push({
                name: "All Records",
                columns: recordColumns,
                rows: enrichRows(allSrc),
              });
            }

          return await stageStreamingExportFromHono(c, async () =>
            streamXlsx(sheets, `duplicate_radar_${Date.now()}.xlsx`, {
              title: "Duplicate Radar Export",
            }),
          );
        } catch (error: any) {
          logger.error("Error exporting duplicates XLSX:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  // B5: JOIN-based lead/deal/contact/account endpoints (no N+1)
  {
    path: "/api/duplicates/leads",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const limit = parseInt(url.searchParams.get("limit") || "50");
          const offset = parseInt(url.searchParams.get("offset") || "0");
          const result = await getDuplicateRecordsByType("lead", {
            limit,
            offset,
            ...parseRecordTabFilters(url),
          });
          return c.json({
            total_duplicate_groups: result.total,
            groups: result.groups,
            limit,
            offset,
            pages: Math.ceil(result.total / limit),
          });
        } catch (error: any) {
          logger.error("Error fetching lead duplicates:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/deals",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const limit = parseInt(url.searchParams.get("limit") || "50");
          const offset = parseInt(url.searchParams.get("offset") || "0");
          const result = await getDuplicateRecordsByType("deal", {
            limit,
            offset,
            ...parseRecordTabFilters(url),
          });
          return c.json({
            total_duplicate_groups: result.total,
            groups: result.groups,
            limit,
            offset,
            pages: Math.ceil(result.total / limit),
          });
        } catch (error: any) {
          logger.error("Error fetching deal duplicates:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  // C2: Contacts and Accounts endpoints
  {
    path: "/api/duplicates/contacts",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const limit = parseInt(url.searchParams.get("limit") || "50");
          const offset = parseInt(url.searchParams.get("offset") || "0");
          const result = await getDuplicateRecordsByType("contact", {
            limit,
            offset,
            ...parseRecordTabFilters(url),
          });
          return c.json({
            total_duplicate_groups: result.total,
            groups: result.groups,
            limit,
            offset,
            pages: Math.ceil(result.total / limit),
          });
        } catch (error: any) {
          logger.error("Error fetching contact duplicates:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/accounts",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const limit = parseInt(url.searchParams.get("limit") || "50");
          const offset = parseInt(url.searchParams.get("offset") || "0");
          const result = await getDuplicateRecordsByType("account", {
            limit,
            offset,
            ...parseRecordTabFilters(url),
          });
          return c.json({
            total_duplicate_groups: result.total,
            groups: result.groups,
            limit,
            offset,
            pages: Math.ceil(result.total / limit),
          });
        } catch (error: any) {
          logger.error("Error fetching account duplicates:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  // C7: Smart AI recommendations
  {
    path: "/api/duplicates/ai-recommendations/:clusterId",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const clusterId = parseInt(c.req.param("clusterId"));
          if (isNaN(clusterId))
            return c.json({ error: "Invalid cluster ID" }, 400);

          const cluster = await getClusterById(clusterId);
          if (!cluster) {
            return c.json({ error: "Cluster not found" }, 404);
          }

          const records = await getRecordsByClusterId(clusterId);
          const recommendations = generateSmartRecommendations(records);
          const meta = getClusterRecordTypeMeta(records);

          return c.json({
            cluster_id: clusterId,
            domain: cluster.domain,
            total_records: records.length,
            recommendations,
            primary_type: meta.primary_type,
            is_cross_module: meta.is_cross_module,
            record_types: meta.record_types,
            ai_summary: meta.is_cross_module
              ? `Cross-module cluster (${meta.record_types.join(" + ")}) for ${cluster.domain || cluster.company_name}. Same-module records get MERGE; cross-module get LINK (set Account_Name / Contact_Name in Zoho — never merge across modules).`
              : `Analyzed ${records.length} ${meta.primary_type || "record"}(s) for ${cluster.domain || cluster.company_name}. Smart scoring considers data completeness, deal activity, recency, and record age.`,
          });
        } catch (error: any) {
          logger.error("Error generating AI recommendations:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/test-record",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const data = await c.req.json();
          const {
            record_type,
            email,
            first_name,
            last_name,
            deal_name,
            company,
            amount,
            owner_email,
          } = data;

          if (!email) {
            return c.json({ error: "Missing required fields" }, 400);
          }

          const emailDomain = email.split("@")[1]?.toLowerCase();
          if (!emailDomain) {
            return c.json({ error: "Invalid email format" }, 400);
          }

          const publicDomains = [
            "gmail.com",
            "yahoo.com",
            "hotmail.com",
            "outlook.com",
            "icloud.com",
            "aol.com",
            "live.com",
          ];
          if (publicDomains.includes(emailDomain)) {
            return c.json(
              {
                error:
                  "Public email domains (gmail, yahoo, etc.) are excluded from duplicate detection. Use a company domain.",
              },
              400,
            );
          }

          const cluster = await findOrCreateClusterByDomain(emailDomain);

          const recordName =
            record_type === "lead"
              ? `${first_name || ""} ${last_name || ""}`.trim() ||
                "Unknown Lead"
              : deal_name || "Unknown Deal";

          const ownerName = owner_email
            ? owner_email
                .split("@")[0]
                .replace(/\./g, " ")
                .replace(/^\w/, (c: string) => c.toUpperCase())
            : "Unknown";

          await addRecordToCluster({
            cluster_id: cluster.id!,
            zoho_record_id: `test_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            record_type: record_type || "lead",
            record_name: recordName,
            email: email,
            domain: emailDomain,
            phone: undefined,
            company_name: company || undefined,
            owner_name: ownerName,
            owner_email: owner_email || undefined,
            deal_value: record_type === "deal" ? amount || 0 : undefined,
            stage: undefined,
            source: "Sandbox Test",
            created_date: new Date(),
            modified_date: new Date(),
            is_primary: false,
            confidence_score: 95,
            is_mock_data: true,
          });

          await updateClusterStats(cluster.id!);

          return c.json({
            success: true,
            cluster_id: cluster.id,
            domain: emailDomain,
          });
        } catch (error: any) {
          logger.error("Error adding test record:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/search",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const params = await c.req.json();
          logger.info("🔍 [DuplicateSearch] Searching with params:", params);

          const {
            domain,
            phone,
            company_name,
            contract_number,
            email,
            record_name,
            owner_email,
          } = params;

          if (
            !domain &&
            !phone &&
            !company_name &&
            !contract_number &&
            !email &&
            !record_name &&
            !owner_email
          ) {
            return c.json({ error: "Missing required fields" }, 400);
          }

          const results = await searchDuplicates({
            domain,
            phone,
            company_name,
            contract_number,
            email,
            record_name,
            owner_email,
          });

          logger.info(
            "✅ [DuplicateSearch] Found",
            results.total_records,
            "records in",
            results.clusters.length,
            "clusters",
          );

          return c.json(results);
        } catch (error: any) {
          logger.error("Error searching duplicates:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/clusters/:id/resolve",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);

          const body = await c.req.json();
          const { action, primary_record_id, notes } = body;

          if (!action || !["resolve", "ignore", "reopen"].includes(action)) {
            return c.json(
              { error: 'action must be "resolve", "ignore" or "reopen"' },
              400,
            );
          }

          // Re-open: put a resolved/ignored cluster back to ACTIVE so it can be
          // merged/applied. For clusters marked resolved before they were
          // actually merged in Zoho (or dismissed by mistake).
          if (action === "reopen") {
            const cluster = await getClusterById(id);
            if (!cluster) return c.json({ error: "Cluster not found" }, 404);
            await updateClusterStatus(id, "active");
            logger.info(
              `🔓 [DuplicateRadar] Cluster #${id} re-opened (was '${cluster.status}') by ${sessionUser.email || "admin"}`,
            );
            return c.json({ success: true, status: "active" });
          }

          const result = await resolveCluster(
            id,
            action,
            sessionUser.email || "admin",
            primary_record_id,
            notes,
          );
          return c.json({ success: true, merge_action: result });
        } catch (error: any) {
          logger.error("Error resolving cluster:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // R10 — List pre-merge snapshots for a cluster. Returned in
    // descending snapshot_at order; payload is a summary (no full JSONB)
    // so the dashboard can render a quick list without pulling MB of
    // records_snapshot data over the wire. Use /snapshots/:id to fetch
    // the full frozen state.
    path: "/api/duplicates/clusters/:id/snapshots",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);

          const { listClusterSnapshots } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          const snapshots = await listClusterSnapshots(id);
          return c.json({ success: true, snapshots });
        } catch (error: any) {
          logger.error("Error listing cluster snapshots:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // R10 — Fetch a single snapshot's frozen cluster + records state.
    // Returned as JSONB so the dashboard can render the full record set
    // including raw_data. 404 when the snapshot id doesn't exist or
    // belongs to a cluster the user isn't authorised to see.
    path: "/api/duplicates/snapshots/:snapshotId",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          const sid = parseInt(c.req.param("snapshotId"));
          if (isNaN(sid)) {
            return c.json({ error: "Invalid snapshot ID" }, 400);
          }

          const { getClusterSnapshot } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          const snapshot = await getClusterSnapshot(sid);
          if (!snapshot) {
            return c.json({ error: "Snapshot not found" }, 404);
          }
          return c.json({ success: true, snapshot });
        } catch (error: any) {
          logger.error("Error fetching cluster snapshot:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // R3 (quick-wins): Mark cluster Resolved AND verify the non-primary
    // records were actually deleted in Zoho. The operator's "Mark
    // Resolved" click asserts a manual Zoho merge happened — this
    // endpoint checks that assertion against Zoho's current state so
    // the dashboard can show Verified / Failed badges instead of just
    // trusting the operator's word.
    //
    // Behaviour:
    //   1. Resolve the cluster (existing resolveCluster flow)
    //   2. For each non-primary record, search Zoho by exact id
    //   3. Persist verification_state = 'verified' | 'failed' + notes
    //   4. If verification failed (records still in Zoho), flip cluster
    //      status back to 'active' so it doesn't silently disappear
    //      from operator queues.
    path: "/api/duplicates/clusters/:id/resolve-and-verify",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid cluster ID" }, 400);

          let body: {
            action?: string;
            primary_record_id?: number;
            notes?: string;
          } = {};
          try {
            body = await c.req.json();
          } catch {
            body = {};
          }
          const action = body.action ?? "resolve";
          if (!["resolve", "ignore"].includes(action)) {
            return c.json(
              { error: 'action must be "resolve" or "ignore"' },
              400,
            );
          }

          const mergeAction = await resolveCluster(
            id,
            action as "resolve" | "ignore",
            sessionUser.email || "admin",
            body.primary_record_id,
            body.notes,
          );

          const { verifyClusterMergedInZoho, listClusterSnapshots } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          const verification = await verifyClusterMergedInZoho(id);

          // Verification failed → flip the cluster back to active so it
          // reappears in operator queues. The verification_state stays
          // 'failed' with the notes attached so they can see why.
          if (!verification.verified) {
            await updateClusterStatus(id, "active");
            logger.info(
              `[DuplicateRadar] Cluster ${id} verification failed; status reverted to active. ${verification.notes}`,
            );
          }

          // Follow-up 2: surface the just-captured pre-resolve snapshot
          // id so the UI can one-click open the viewer on verification
          // failure. resolveCluster (called above) invokes
          // captureClusterSnapshot internally as its first step (R10),
          // so the most-recent snapshot for this cluster IS the one we
          // just captured. Pulling the latest is cheap (indexed query)
          // and avoids a second client round-trip.
          let latestSnapshotId: number | null = null;
          try {
            const snaps = await listClusterSnapshots(id);
            latestSnapshotId = snaps[0]?.id ?? null;
          } catch (snapErr) {
            // Best-effort — a snapshot-lookup failure must NOT mask the
            // verification result the operator is waiting on.
            logger.warn(
              `[DuplicateRadar] Could not fetch latest snapshot for cluster ${id} after resolve-and-verify: ${(snapErr as Error).message}`,
            );
          }

          return c.json({
            success: true,
            merge_action: mergeAction,
            verification,
            cluster_status: verification.verified ? "resolved" : "active",
            latest_snapshot_id: latestSnapshotId,
          });
        } catch (error: any) {
          logger.error("Error in resolve-and-verify:", error);
          return c.json(
            { success: false, error: "An internal error occurred" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/duplicates/clusters/:id/primary",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const clusterId = parseInt(c.req.param("id"));
          const { record_id } = await c.req.json();
          if (isNaN(clusterId) || !record_id)
            return c.json({ error: "Invalid parameters" }, 400);

          const success = await markPrimaryRecord(clusterId, record_id);
          return c.json({ success });
        } catch (error: any) {
          logger.error("Error marking primary:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/bulk-resolve",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const { cluster_ids, action } = await c.req.json();
          if (
            !Array.isArray(cluster_ids) ||
            !["resolve", "ignore", "reopen"].includes(action)
          ) {
            return c.json(
              {
                error:
                  "cluster_ids (array) and action (resolve/ignore/reopen) required",
              },
              400,
            );
          }

          const count = await bulkResolve(
            cluster_ids,
            action,
            sessionUser.email || "admin",
          );
          return c.json({ success: true, resolved: count });
        } catch (error: any) {
          logger.error("Error bulk resolving:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/merge-history",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const clusterId = url.searchParams.get("cluster_id");
          const limit = parseInt(url.searchParams.get("limit") || "50");
          const history = await getMergeHistory(
            clusterId ? parseInt(clusterId) : undefined,
            limit,
          );
          return c.json({ history });
        } catch (error: any) {
          logger.error("Error fetching merge history:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/check",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { email, phone, company_name } = await c.req.json();

          if (!email && !phone && !company_name) {
            return c.json(
              { error: "Provide at least one of: email, phone, company_name" },
              400,
            );
          }

          const result = await checkForDuplicates({
            email,
            phone,
            company_name,
          });
          return c.json(result);
        } catch (error: any) {
          logger.error("Error checking duplicates:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/owner-accountability",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const data = await getOwnerAccountability();
          return c.json({ owners: data });
        } catch (error: any) {
          logger.error("Error fetching owner accountability:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  // R2: per-owner Remediation Packet — 4-sheet xlsx (Cover, Action Items,
  // Raw Records, FAQ). Owner name passes through the querystring rather
  // than the path so existing owner-name characters (spaces, dots,
  // Arabic) don't have to be URL-pre-encoded by the link generator.
  {
    path: "/api/duplicates/owner-packet",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const ownerName = (url.searchParams.get("owner") || "").trim();
          if (!ownerName) {
            return c.json({ error: "owner query param is required" }, 400);
          }
          // Locale for the packet body. Defaults to English; clamp anything
          // unrecognised so a typo can't break the build (XLSX still ships
          // in English rather than 500ing). Frontend passes "ar" when the
          // dashboard is in Arabic mode (WalaPlusI18n.currentLang()).
          const langParam = (url.searchParams.get("lang") || "en").toLowerCase();
          const lang: "en" | "ar" = langParam === "ar" ? "ar" : "en";

          const [owners, settings] = await Promise.all([
            getOwnerAccountability(),
            getPacketSettings(),
          ]);
          // Match owner by name OR email, case-insensitive — the dashboard
          // link passes the display name, but operators sometimes hit the
          // endpoint directly with the email.
          const needle = ownerName.toLowerCase();
          const owner = owners.find(
            (o) =>
              (o.owner_name ?? "").trim().toLowerCase() === needle ||
              (o.owner_email ?? "").trim().toLowerCase() === needle,
          );
          if (!owner) {
            return c.json(
              { error: "Owner not found", owner: ownerName },
              404,
            );
          }

          // Pull every duplicate-cluster record this owner is on, sorted so
          // the playbook helpers see is_primary first per cluster. Same
          // name-or-email match as above so a single owner with mismatched
          // case in legacy rows still gets a complete packet.
          const recordsRes = await sharedDuplicateRadarPool.query(
            `
              SELECT dr.cluster_id, dr.zoho_record_id, dr.record_name, dr.record_type,
                     dr.company_name, dr.email, dr.domain, dr.phone,
                     dr.owner_name, dr.owner_email, dr.is_primary,
                     COALESCE(dr.status, dr.stage, '') AS status_or_stage,
                     dr.deal_value, dr.source, dr.confidence_score, dr.ai_recommendation,
                     TO_CHAR(dr.created_date::date, 'YYYY-MM-DD') AS created_str,
                     dc.confidence_score AS cluster_confidence_score,
                     dc.total_records      AS cluster_total_records
              FROM duplicate_records dr
              JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
              WHERE dc.status = 'active'
                AND dc.total_records > 1
                AND (
                  LOWER(TRIM(dr.owner_name))  = $1 OR
                  LOWER(TRIM(dr.owner_email)) = $1
                )
              ORDER BY dc.total_records DESC, dr.cluster_id, dr.is_primary DESC
            `,
            [needle],
          );

          const records = recordsRes.rows as Array<Record<string, unknown>>;
          const seenClusters = new Set<number>();
          const clusterConfidences: number[] = [];
          for (const r of records) {
            const cid = Number(r.cluster_id ?? -1);
            if (cid > 0 && !seenClusters.has(cid)) {
              seenClusters.add(cid);
              const cc = Number(r.cluster_confidence_score ?? 0);
              if (!Number.isNaN(cc)) clusterConfidences.push(cc);
            }
          }

          const { streamXlsx, stageStreamingExportFromHono } = await import(
            "../../utils/excelExport"
          );
          const { buildPacketSheets, packetFilename } = await import(
            "../../utils/duplicateRadarPacket"
          );

          const sheets = buildPacketSheets({
            owner,
            settings,
            records,
            clusterConfidences,
            lang,
          });
          const filename = packetFilename(owner.owner_name);

          // Audit trail — same table the CSV / XLSX exports write to. Lets
          // operators see who pulled a packet and when from the existing
          // export-log dashboard. Non-blocking: a logging failure must not
          // stop the owner from receiving their packet.
          //
          // `exported_by` is the ACTOR (the admin / ops user that ran the
          // download), not the target owner. The target owner is in
          // filter_criteria. This is the audit invariant: "who pulled
          // sensitive data about whom".
          const actor =
            (admin as any).email ||
            (admin as any).name ||
            `user:${(admin as any).userId ?? "unknown"}`;
          try {
            await createExportLog({
              export_type: "owner_packet" as any,
              filter_criteria: {
                owner: owner.owner_name,
                packet: true,
                lang,
              },
              total_records_exported: records.length,
              file_format: "xlsx",
              exported_by: actor,
            });
          } catch (logErr) {
            logger.warn(
              "[DuplicateRadar] owner-packet export log write failed (non-blocking):",
              logErr,
            );
          }

          return await stageStreamingExportFromHono(c, async () =>
            streamXlsx(sheets, filename, {
              title: `Duplicate Radar — Remediation Packet for ${owner.owner_name}`,
            }),
          );
        } catch (error: any) {
          logger.error("Error generating owner packet:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/enhanced-summary",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const summary = await getEnhancedSummary();
          const lastScan = await getLastScanDate();
          return c.json({ ...summary, lastScanDate: lastScan });
        } catch (error: any) {
          logger.error("Error fetching enhanced summary:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/sync-status",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const states = await getAllSyncStates();
          return c.json({ syncStates: states });
        } catch (error: any) {
          logger.error("Error fetching sync status:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/filters/options",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const [owners, layouts, domains, pipelines, products, stages] =
            await Promise.all([
              getDistinctOwners(),
              getDistinctLayouts(),
              getDistinctDomains(),
              getDistinctPipelines(),
              getDistinctProducts(),
              getDistinctStages(),
            ]);
          return c.json({
            owners,
            layouts,
            domains,
            pipelines,
            products,
            stages,
            modules: ["Leads", "Deals", "Contacts", "Accounts"],
          });
        } catch (error: any) {
          logger.error("Error fetching filter options:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/filtered-clusters",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const rawLimit = parseInt(url.searchParams.get("limit") || "30");
          const rawOffset = parseInt(url.searchParams.get("offset") || "0");
          const limit = isNaN(rawLimit)
            ? 30
            : Math.min(Math.max(rawLimit, 1), 100);
          const offset = isNaN(rawOffset) ? 0 : Math.max(rawOffset, 0);

          const rawSegment = url.searchParams.get("segment");
          const segment: DuplicateFilters["segment"] =
            rawSegment === "marketplace" || rawSegment === "corporate"
              ? rawSegment
              : undefined;

          const filters: DuplicateFilters = {
            modules: url.searchParams.get("modules")
              ? url.searchParams.get("modules")!.split(",")
              : undefined,
            owners: url.searchParams.get("owners")
              ? url.searchParams.get("owners")!.split(",")
              : undefined,
            layouts: url.searchParams.get("layouts")
              ? url.searchParams.get("layouts")!.split(",")
              : undefined,
            pipelines: url.searchParams.get("pipelines")
              ? url.searchParams.get("pipelines")!.split(",")
              : undefined,
            stages: url.searchParams.get("stages")
              ? url.searchParams.get("stages")!.split(",")
              : undefined,
            domain: url.searchParams.get("domain") || undefined,
            start_date: url.searchParams.get("start_date") || undefined,
            end_date: url.searchParams.get("end_date") || undefined,
            status: url.searchParams.get("status") || "active",
            confidence_level:
              url.searchParams.get("confidence_level") || undefined,
            segment,
          };

          const { clusters, total } = await getFilteredClusters(
            filters,
            limit,
            offset,
          );
          return c.json({
            clusters,
            total,
            limit,
            offset,
            pages: Math.ceil(total / limit),
          });
        } catch (error: any) {
          logger.error("Error fetching filtered clusters:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/filtered-summary",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const rawSegment = url.searchParams.get("segment");
          const segment: DuplicateFilters["segment"] =
            rawSegment === "marketplace" || rawSegment === "corporate"
              ? rawSegment
              : undefined;

          const filters: DuplicateFilters = {
            modules: url.searchParams.get("modules")
              ? url.searchParams.get("modules")!.split(",")
              : undefined,
            owners: url.searchParams.get("owners")
              ? url.searchParams.get("owners")!.split(",")
              : undefined,
            stages: url.searchParams.get("stages")
              ? url.searchParams.get("stages")!.split(",")
              : undefined,
            domain: url.searchParams.get("domain") || undefined,
            segment,
          };
          const summary = await getFilteredSummary(filters);
          return c.json(summary);
        } catch (error: any) {
          logger.error("Error fetching filtered summary:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/clusters/:id/tasks",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const admin = await requireDuplicateRadarAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const clusterId = parseInt(c.req.param("id"));
          if (isNaN(clusterId))
            return c.json({ error: "Invalid cluster ID" }, 400);

          const records = await getRecordsByClusterId(clusterId);
          const recordIds = records
            .map((r) => r.zoho_record_id)
            .filter(Boolean) as string[];
          const tasks = await getTasksForRecords(recordIds);
          const taskCount = await getTaskCountForCluster(clusterId);

          return c.json({ tasks, total: taskCount });
        } catch (error: any) {
          logger.error("Error fetching cluster tasks:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  // C5: Auto-resolve engine
  {
    path: "/api/duplicates/auto-resolve",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const result = await autoResolveClusters();
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error auto-resolving:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/recalculate-stats",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { pool } = await import("../../utils/duplicateRadarDatabase");
          const result = await pool.query(`
            UPDATE duplicate_clusters dc SET
              total_leads = sub.lead_count,
              total_deals = sub.deal_count,
              total_contacts = sub.contact_count,
              total_accounts = sub.account_count,
              total_records = sub.total_count,
              estimated_pipeline_value = sub.inflation,
              first_record_date = sub.first_date,
              latest_activity_date = sub.latest_date,
              updated_at = CURRENT_TIMESTAMP
            FROM (
              SELECT
                cluster_id,
                COUNT(*) FILTER (WHERE record_type = 'lead') as lead_count,
                COUNT(*) FILTER (WHERE record_type = 'deal') as deal_count,
                COUNT(*) FILTER (WHERE record_type = 'contact') as contact_count,
                COUNT(*) FILTER (WHERE record_type = 'account') as account_count,
                COUNT(*) as total_count,
                COALESCE(SUM(deal_value) FILTER (WHERE is_primary = false AND record_type = 'deal'), 0) as inflation,
                MIN(created_date) as first_date,
                MAX(COALESCE(modified_date, created_date)) as latest_date
              FROM duplicate_records
              GROUP BY cluster_id
            ) sub
            WHERE dc.id = sub.cluster_id
          `);
          return c.json({
            success: true,
            clustersUpdated: result.rowCount || 0,
          });
        } catch (error: any) {
          logger.error("Error recalculating stats:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  // ─── CS-pipeline overlap: list + scan ──────────────────────────────────────
  {
    path: "/api/duplicates/cs-overlap/clusters",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const verdict = url.searchParams.get("verdict"); // block|review|warn|null
          const limit = Math.min(
            Math.max(parseInt(url.searchParams.get("limit") || "500"), 1),
            2000,
          );
          const offset = Math.max(
            parseInt(url.searchParams.get("offset") || "0"),
            0,
          );

          const { pool } = await import("../../utils/duplicateRadarDatabase");
          const conds: string[] = ["cs_overlap_verdict IS NOT NULL"];
          const params: any[] = [];
          if (verdict && ["block", "review", "warn"].includes(verdict)) {
            params.push(verdict);
            conds.push(`cs_overlap_verdict = $${params.length}`);
          }
          const where = conds.join(" AND ");

          const sql = `SELECT id, domain, company_name, company_name_arabic,
                              estimated_pipeline_value, total_records,
                              total_leads, total_deals, total_contacts, total_accounts,
                              confidence_score, confidence_level, status,
                              cs_overlap_verdict, arr_exposure,
                              pipeline_lifecycle_state, client_sector,
                              updated_at
                         FROM duplicate_clusters
                        WHERE ${where}
                        ORDER BY
                          CASE cs_overlap_verdict
                            WHEN 'block' THEN 1
                            WHEN 'review' THEN 2
                            WHEN 'warn' THEN 3
                            ELSE 4
                          END,
                          arr_exposure DESC NULLS LAST
                        LIMIT $${params.length + 1}
                       OFFSET $${params.length + 2}`;
          params.push(limit, offset);
          const r = await pool.query(sql, params);

          const sumRow = await pool.query(
            `SELECT cs_overlap_verdict AS verdict,
                    COUNT(*)::int AS count,
                    COALESCE(SUM(arr_exposure),0)::float AS arr
               FROM duplicate_clusters
              WHERE cs_overlap_verdict IS NOT NULL
              GROUP BY cs_overlap_verdict`,
          );
          const summary: Record<string, { count: number; arr: number }> = {};
          let totalArr = 0;
          for (const row of sumRow.rows) {
            summary[row.verdict] = { count: row.count, arr: row.arr };
            totalArr += row.arr;
          }

          return c.json({
            clusters: r.rows,
            total: r.rows.length,
            limit,
            offset,
            summary,
            total_arr_exposure: totalArr,
          });
        } catch (error: any) {
          logger.error("Error fetching CS overlap clusters:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/cs-overlap/scan",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          const { scanAllClustersForCsOverlap, initDuplicateRadarTables } =
            await import("../../utils/duplicateRadarDatabase");
          await initDuplicateRadarTables();
          const result = await scanAllClustersForCsOverlap();
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error running CS overlap scan:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Manually trigger auto-CAPA for current BLOCK clusters above the ARR
    // threshold. Idempotent: existing open CAPAs are skipped.
    path: "/api/duplicates/cs-overlap/auto-capa",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          let body: { threshold_sar?: number; created_by?: string } = {};
          try {
            body = (await c.req.json()) || {};
          } catch {
            body = {};
          }

          const { autoOpenCapasForBlockClusters } = await import(
            "../../utils/csOverlapAutoCapa"
          );
          const result = await autoOpenCapasForBlockClusters({
            thresholdSar:
              typeof body.threshold_sar === "number"
                ? body.threshold_sar
                : undefined,
            createdBy: body.created_by,
          });
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error running auto-CAPA:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Communication-eligibility check — answers "can SDR/Marketing contact
    // this domain right now?". Combines contract state (signed/paid),
    // CS Phase, Churn Date, and sector-based cool-off into a single
    // verdict (block / review / allow) with per-deal reasoning.
    path: "/api/duplicates/communication-check",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          let body: { domain?: string } = {};
          try {
            body = (await c.req.json()) || {};
          } catch {
            body = {};
          }
          if (!body.domain || typeof body.domain !== "string") {
            return c.json(
              { error: "Body must include { domain: string }" },
              400,
            );
          }

          const { checkCommunicationEligibility } = await import(
            "../../utils/csCommunicationCheck"
          );
          const result = await checkCommunicationEligibility({
            domain: body.domain,
          });
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error running communication-check:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Reconcile synthetic cluster domains (`*.cluster` / company-name slugs)
    // with the authoritative Company_Domain that CS adds during Onboarding.
    // Promotes the cluster's `domain` to the real one whenever every Deal in
    // the cluster agrees. Idempotent + safe to re-run. Pass {dry_run:true}
    // to preview without writing.
    path: "/api/duplicates/reconcile-synthetic-domains",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          let body: { dry_run?: boolean; limit?: number } = {};
          try {
            body = (await c.req.json()) || {};
          } catch {
            body = {};
          }

          const { reconcileSyntheticClusterDomains } = await import(
            "../../utils/duplicateRadarDomainReconciler"
          );
          const result = await reconcileSyntheticClusterDomains({
            dryRun: !!body.dry_run,
            limit: typeof body.limit === "number" ? body.limit : undefined,
          });
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error reconciling synthetic domains:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // List synthetic-domain clusters whose proposed authoritative domain
    // collides with another active cluster. Each row pairs the synthetic
    // cluster with the authoritative one so an operator can decide which
    // to keep. Optional ?limit= caps how many synthetic clusters are scanned.
    path: "/api/duplicates/domain-reconcile/collisions",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          const limitQ = c.req.query("limit");
          const limit = limitQ ? Number.parseInt(limitQ, 10) : undefined;

          const { listDomainReconcileCollisions } = await import(
            "../../utils/duplicateRadarDomainReconciler"
          );
          const result = await listDomainReconcileCollisions({
            limit: Number.isFinite(limit as number) ? (limit as number) : undefined,
          });
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error listing domain-reconcile collisions:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Resolve a domain-reconcile collision by merging the synthetic cluster
    // INTO the authoritative one. Body: { authoritative_cluster_id, notes? }.
    // Records the action in duplicate_merge_actions as 'domain_collision_merge'.
    // Requires the standard Duplicate Radar write role.
    path: "/api/duplicates/domain-reconcile/collisions/:syntheticId/merge",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey } = await import(
            "../../utils/rbacMiddleware"
          );
          const user = await requireAdminOrKey(c);
          if (!user) return unauthorizedResponse(c);

          const syntheticId = Number.parseInt(
            c.req.param("syntheticId") ?? "",
            10,
          );
          if (!Number.isFinite(syntheticId) || syntheticId <= 0) {
            return c.json(
              { success: false, error: "Invalid syntheticId path param" },
              400,
            );
          }

          let body: { authoritative_cluster_id?: number; notes?: string } = {};
          try {
            body = (await c.req.json()) || {};
          } catch {
            body = {};
          }
          const authoritativeId = Number(body.authoritative_cluster_id);
          if (!Number.isFinite(authoritativeId) || authoritativeId <= 0) {
            return c.json(
              {
                success: false,
                error: "Body must include numeric authoritative_cluster_id",
              },
              400,
            );
          }

          const { mergeSyntheticIntoAuthoritative } = await import(
            "../../utils/duplicateRadarDomainReconciler"
          );
          const result = await mergeSyntheticIntoAuthoritative({
            syntheticClusterId: syntheticId,
            authoritativeClusterId: authoritativeId,
            performedBy:
              (user as any).email ?? (user as any).id ?? "domain-reconcile",
            notes: body.notes,
          });
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error merging collision pair:", error);
          const msg = String(error?.message ?? "");
          // Validation errors (cluster not active / not synthetic / etc.) carry
          // operator-actionable info — surface them rather than a generic 500.
          const isValidation =
            msg.includes("not found") ||
            msg.includes("not active") ||
            msg.includes("real domain") ||
            msg.includes("must differ");
          return c.json(
            { success: false, error: isValidation ? msg : "An internal error occurred" },
            isValidation ? 400 : 500,
          );
        }
      };
    },
  },
  // ===================================================================
  //  Manual CAPA conversion endpoint (2026-05-30 operator request).
  //
  //  Every actionable row across the duplicate radar (CS Lifecycle
  //  violation, Cross-Module overlap, Domain cluster, Account Hint,
  //  Owner Accountability row, etc.) can be escalated to a formal
  //  CAPA via this single endpoint. The frontend opens a shared
  //  modal that pre-fills the body from row context; this handler
  //  writes the CAPA into the canonical capa_records table so the
  //  same record shows up in the QMS CAPA inbox (where Quality works
  //  it) and in any Audit Reports rollup the team builds on top.
  //
  //  Idempotency: if an OPEN CAPA already exists for the same
  //  (source_type, source_id), we return that record instead of
  //  creating a duplicate. Operators can double-click the button
  //  without spawning two CAPAs.
  //
  //  Body:
  //    {
  //      source_type: string,            // 'duplicate_cluster' | 'cs_lifecycle_manual' | ...
  //      source_id: string,              // stable id from the row (cluster id, deal id, ...)
  //      source_reference?: string,      // human label for cross-link (domain, account name)
  //      title: string,                  // CAPA title (operator-editable in the modal)
  //      description?: string,           // CAPA body (likewise editable)
  //      severity?: 'critical' | 'major' | 'minor' | 'observation' (default 'major')
  //      target_days?: number,           // SLA window in days from now (default 7)
  //      assigned_to?: string,           // owner email
  //      metadata?: any                  // free-form (origin tab, row IDs, …)
  //    }
  //
  //  Returns: { success: true, capa_number, capa_id, was_existing: bool }
  // ===================================================================
  {
    path: "/api/duplicates/capa/manual-open",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          const body = await c.req.json().catch(() => ({}));
          const sourceType = String(body?.source_type || "").trim();
          const sourceId = String(body?.source_id || "").trim();
          const title = String(body?.title || "").trim();
          if (!sourceType || !sourceId || !title) {
            return c.json(
              {
                error:
                  "source_type, source_id and title are required.",
              },
              400,
            );
          }

          const description = String(body?.description || "").trim() || undefined;
          const sourceReference = String(body?.source_reference || "").trim() || undefined;
          const assignedTo = String(body?.assigned_to || "").trim() || undefined;
          const VALID_SEVERITIES = new Set([
            "critical",
            "major",
            "minor",
            "observation",
          ]);
          const severity = VALID_SEVERITIES.has(String(body?.severity))
            ? (body.severity as "critical" | "major" | "minor" | "observation")
            : "major";
          // Severity → priority mapping mirrors the auto-CAPA pipeline
          // (csLifecycleAutoCapa.priorityForViolation) so the QMS CAPA
          // inbox sorts manual + auto CAPAs the same way.
          const priority: "critical" | "high" | "medium" | "low" =
            severity === "critical"
              ? "critical"
              : severity === "major"
                ? "high"
                : severity === "minor"
                  ? "medium"
                  : "low";

          const targetDaysRaw = Number(body?.target_days);
          const targetDays =
            Number.isFinite(targetDaysRaw) && targetDaysRaw > 0
              ? Math.min(targetDaysRaw, 365)
              : 7;
          const targetDate = new Date(Date.now() + targetDays * 86400 * 1000);

          const { qmsPool, createCapaRecord } = await import(
            "../../utils/qmsDatabase"
          );

          // Idempotency check — return existing open CAPA for the same
          // (source_type, source_id) instead of duplicating. Matches the
          // auto-CAPA runners' existingOpenCapa() rule.
          const existingRes = await qmsPool.query(
            `SELECT id, capa_number
               FROM capa_records
              WHERE source_type = $1
                AND source_id   = $2
                AND status NOT IN ('closed', 'cancelled')
              LIMIT 1`,
            [sourceType, sourceId],
          );
          if (existingRes.rows.length > 0) {
            return c.json({
              success: true,
              capa_number: existingRes.rows[0].capa_number,
              capa_id: existingRes.rows[0].id,
              was_existing: true,
            });
          }

          const userEmail = (user as any).email || undefined;
          const userName = (user as any).name || undefined;
          const createdBy = userEmail || "duplicate-radar:manual";

          const capa = await createCapaRecord({
            title,
            description,
            capa_type: "corrective",
            source_type: sourceType,
            source_id: sourceId,
            source_reference: sourceReference,
            severity,
            status: "open",
            priority,
            assigned_to: assignedTo,
            target_date: targetDate,
            related_criteria: {},
            attachments: [],
            metadata: {
              origin: "duplicate-radar",
              opened_by: userEmail,
              opened_by_name: userName,
              ...(body?.metadata && typeof body.metadata === "object"
                ? body.metadata
                : {}),
            },
            created_by: createdBy,
          });

          // Audit-log every manual CAPA so the Audit Reports surface +
          // the QMS CAPA history both have a trail. Same envelope shape
          // the SDR review submissions and manual call-status overrides
          // use, so timeline reports stay coherent across action types.
          try {
            const { logEvent } = await import(
              "../../utils/eventLogsDatabase"
            );
            await logEvent({
              actionType: "capa_manual_open",
              entityType: "capa_record",
              entityId: String(capa.id ?? ""),
              entityName: capa.capa_number || title,
              module: "duplicates",
              severity:
                severity === "critical"
                  ? "WARNING"
                  : "INFO",
              aiInvolved: false,
              userEmail,
              userName,
              description: `Operator ${userEmail || "(unknown)"} opened CAPA ${
                capa.capa_number
              } from the duplicate radar: ${title}`,
              newValue: {
                capa_id: capa.id,
                capa_number: capa.capa_number,
                source_type: sourceType,
                source_id: sourceId,
                source_reference: sourceReference,
                severity,
                target_days: targetDays,
              },
            });
          } catch (logErr: any) {
            logger.warn(
              `[duplicate-radar/manual-capa] audit log failed: ${
                logErr?.message || logErr
              }`,
            );
          }

          return c.json({
            success: true,
            capa_number: capa.capa_number,
            capa_id: capa.id,
            was_existing: false,
          });
        } catch (error: any) {
          logger.error("Error opening manual CAPA:", error);
          return c.json(
            { error: error?.message || "Failed to open CAPA" },
            500,
          );
        }
      };
    },
  },
  {
    // KPI rollup over auto-created CAPAs (CS-overlap + CS-lifecycle).
    // Returns: totals, per-source-type breakdown, and a 30-day opened trend.
    path: "/api/duplicates/auto-capa/kpis",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          const { getAutoCapaKpis } = await import(
            "../../utils/autoCapaKpis"
          );
          const result = await getAutoCapaKpis({});
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error computing auto-CAPA KPIs:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Manually trigger auto-CAPA for current CS Lifecycle violations
    // (default: critical-severity only). Idempotent: existing open CAPAs
    // for the same (record × code) pair are skipped.
    path: "/api/duplicates/cs-lifecycle/auto-capa",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          let body: {
            severities?: ("info" | "warning" | "critical")[];
            codes?: string[];
            created_by?: string;
          } = {};
          try {
            body = (await c.req.json()) || {};
          } catch {
            body = {};
          }

          const { autoOpenCapasForCsLifecycle } = await import(
            "../../utils/csLifecycleAutoCapa"
          );
          const result = await autoOpenCapasForCsLifecycle({
            severities: body.severities,
            codes: body.codes as any,
            createdBy: body.created_by,
          });
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error running CS lifecycle auto-CAPA:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Deal Stage Aging — list current Sales-SOP stage-aging violations.
    // Query params: severity={info|warning|critical}, stage={Proposal|...}, limit=N
    // Backed by scanDealStageAgingViolations + the Sales SOP spec
    // (src/utils/salesStageSlaSpec.ts). Pairs with the "Deals Lifecycle"
    // tab in the Duplicate Radar.
    path: "/api/duplicates/deal-stage-aging",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const severity = url.searchParams.get("severity") || undefined;
          const stage = url.searchParams.get("stage") || undefined;
          const limit = parseInt(url.searchParams.get("limit") || "2000", 10);

          const { scanDealStageAgingViolations } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          const { SALES_STAGE_SLA_SPEC } = await import(
            "../../utils/salesStageSlaSpec"
          );
          const result = await scanDealStageAgingViolations({
            severity: severity as any,
            stage,
            limit,
          });
          return c.json({
            success: true,
            spec: SALES_STAGE_SLA_SPEC,
            ...result,
          });
        } catch (error: any) {
          logger.error("Error fetching Deal Stage Aging violations:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // CS lifecycle compliance — list current violations.
    // Query params: severity={info|warning|critical}, code={onboarding_overdue|...}, limit=N
    path: "/api/duplicates/cs-lifecycle/violations",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const severity = url.searchParams.get("severity") || undefined;
          const code = url.searchParams.get("code") || undefined;
          const limit = parseInt(url.searchParams.get("limit") || "2000", 10);

          const { scanCsLifecycleViolations } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          const result = await scanCsLifecycleViolations({
            severity: severity as any,
            code: code as any,
            limit,
          });
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error fetching CS lifecycle violations:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Force-refresh one or more Deals directly from Zoho's single-record API
    // (real-time, not subject to the bulk-read eventual-consistency lag that
    // can cause CS Lifecycle violations to show stale Phase / Company_Domain
    // values long after the CRM record was updated). For each id we pull the
    // live record, run it through the same Deal extractor used by the bulk
    // sync, and upsert it so the next /violations call reflects current CRM
    // state. Reusing the existing cluster (by zoho_record_id) avoids
    // re-clustering side-effects.
    path: "/api/duplicates/cs-lifecycle/refresh-deals",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          const body = await c.req.json().catch(() => ({}));
          const zohoIds: string[] = Array.isArray(body?.zohoIds)
            ? body.zohoIds.filter((x: any) => typeof x === "string" && x.trim())
            : [];
          if (zohoIds.length === 0) {
            return c.json({ error: "zohoIds array required" }, 400);
          }
          const MAX = 50;
          if (zohoIds.length > MAX) {
            return c.json({ error: `Refresh at most ${MAX} deals per request` }, 400);
          }

          const { pool } = await import("../../utils/database");

          const refreshed: string[] = [];
          const missing: string[] = [];
          const failed: { id: string; error: string }[] = [];

          for (const zohoId of zohoIds) {
            try {
              const live = await fetchZohoRecordById("Deals", zohoId);
              if (!live) {
                missing.push(zohoId);
                continue;
              }
              const d: any = live.data;
              const existing = await pool.query(
                `SELECT cluster_id FROM duplicate_records WHERE zoho_record_id = $1 LIMIT 1`,
                [zohoId],
              );
              const clusterId = existing.rows[0]?.cluster_id;
              if (!clusterId) {
                missing.push(zohoId);
                continue;
              }
              await upsertRecord({
                cluster_id: clusterId,
                record_type: "deal",
                zoho_record_id: live.id,
                record_name: d.Deal_Name || "Unknown Deal",
                company_name: d.Account_Name?.name || d.Deal_Name || "Unknown",
                email: d.Contact_Email || undefined,
                domain: extractDomain(d.Contact_Email || "") || undefined,
                phone: d.Contact_Phone || undefined,
                owner_name: d.Owner?.name || "Unknown",
                owner_email: d.Owner?.email || "",
                status: "",
                stage: d.Stage || "",
                deal_value: parseFloat(d.Amount) || 0,
                source: d.Lead_Source || "",
                created_date: d.Created_Time ? new Date(d.Created_Time) : new Date(),
                modified_date: d.Modified_Time ? new Date(d.Modified_Time) : new Date(),
                is_primary: false,
                confidence_score: 0,
                is_mock_data: false,
                raw_data: d,
                layout_name: d.Layout?.name || d.$layout?.name || "",
                layout_id: d.Layout?.id || d.$layout?.id || "",
                zoho_module: "Deals",
                pipeline: d.Pipeline || "",
                products: d.Product_Details ? JSON.stringify(d.Product_Details) : "",
                contact_name: d.Contact_Name?.name || "",
                account_name: d.Account_Name?.name || "",
              });
              refreshed.push(zohoId);
            } catch (err: any) {
              logger.warn(
                `⚠️ [CS-Lifecycle Refresh] Failed to refresh Deal ${zohoId}: ${err?.message || err}`,
              );
              failed.push({ id: zohoId, error: String(err?.message || err) });
            }
          }

          logger.info(
            `🔄 [CS-Lifecycle Refresh] User ${user.email} refreshed ${refreshed.length}/${zohoIds.length} deals live from Zoho`,
          );
          return c.json({
            success: true,
            requested: zohoIds.length,
            refreshed_count: refreshed.length,
            missing_count: missing.length,
            failed_count: failed.length,
            refreshed,
            missing,
            failed,
          });
        } catch (error: any) {
          logger.error("Error in cs-lifecycle/refresh-deals:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Generic per-module live refresh from Zoho. Same pattern as
    // /api/duplicates/cs-lifecycle/refresh-deals but works for any of the
    // four duplicate-radar record types (lead / deal / contact / account)
    // so each per-module tab can offer the same "Refresh from Zoho (live)"
    // UX. For each id we fetch the live record from Zoho's single-record
    // API, run the same per-module extractor used by the bulk sync, and
    // upsert it into the existing cluster so the next /api/duplicates/{type}
    // call reflects the up-to-date CRM values.
    path: "/api/duplicates/refresh-records",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          const body = await c.req.json().catch(() => ({}));
          const moduleRaw = String(body?.module || "").toLowerCase();
          const MODULE_MAP: Record<
            string,
            {
              zohoModule: "Leads" | "Deals" | "Contacts" | "Accounts";
              recordType: "lead" | "deal" | "contact" | "account";
            }
          > = {
            leads: { zohoModule: "Leads", recordType: "lead" },
            deals: { zohoModule: "Deals", recordType: "deal" },
            contacts: { zohoModule: "Contacts", recordType: "contact" },
            accounts: { zohoModule: "Accounts", recordType: "account" },
          };
          const cfg = MODULE_MAP[moduleRaw];
          if (!cfg) {
            return c.json(
              {
                error:
                  "module must be one of: leads, deals, contacts, accounts",
              },
              400,
            );
          }
          const zohoIds: string[] = Array.isArray(body?.zohoIds)
            ? body.zohoIds.filter(
                (x: any) => typeof x === "string" && x.trim(),
              )
            : [];
          if (zohoIds.length === 0) {
            return c.json({ error: "zohoIds array required" }, 400);
          }
          const MAX = 50;
          if (zohoIds.length > MAX) {
            return c.json(
              { error: `Refresh at most ${MAX} records per request` },
              400,
            );
          }

          // Per-module extractor — mirrors the bulk-scan extractors at the
          // top of this file (processModule callsites). Kept inline so the
          // refresh endpoint and the bulk scan stay obviously in sync.
          const extract = (
            record: any,
          ): {
            companyName: string;
            recordName: string;
            email: string;
            phone: string;
            mobile?: string;
            domain: string | null;
            ownerName: string;
            ownerEmail: string;
            status: string;
            stage?: string;
            dealValue?: number;
            source: string;
            createdTime: string;
            modifiedTime: string;
            layoutName?: string;
            layoutId?: string;
            pipeline?: string;
            products?: string;
            contactName?: string;
            accountName?: string;
            crNumber?: string;
            vatNumber?: string;
            website?: string;
            country?: string;
            region?: string;
            industry?: string;
            noOfEmployees?: number;
            title?: string;
            leadType?: string;
            accountType?: string;
          } => {
            const d = record.data;
            switch (cfg.recordType) {
              case "lead":
                return {
                  companyName: d.Company || d.Last_Name || "Unknown",
                  email: d.Email || "",
                  phone: d.Phone || "",
                  mobile: d.Mobile || "",
                  recordName:
                    d.Full_Name ||
                    `${d.First_Name || ""} ${d.Last_Name || ""}`.trim(),
                  domain: extractDomain(d.Email || ""),
                  ownerName: d.Owner?.name || "Unknown",
                  ownerEmail: d.Owner?.email || "",
                  status: d.Lead_Status || "",
                  source: d.Lead_Source || "",
                  createdTime: d.Created_Time || "",
                  modifiedTime: d.Modified_Time || "",
                  layoutName: d.Layout?.name || d.$layout?.name || "",
                  layoutId: d.Layout?.id || d.$layout?.id || "",
                  title: d.Designation || d.Title || "",
                  leadType: d.Lead_Type || "",
                  country: d.Country || "",
                  industry: d.Industry || "",
                  website: d.Website || "",
                };
              case "deal":
                return {
                  companyName: d.Account_Name?.name || d.Deal_Name || "Unknown",
                  email: d.Contact_Email || "",
                  phone: d.Contact_Phone || "",
                  recordName: d.Deal_Name || "Unknown Deal",
                  domain: extractDomain(d.Contact_Email || ""),
                  ownerName: d.Owner?.name || "Unknown",
                  ownerEmail: d.Owner?.email || "",
                  status: "",
                  stage: d.Stage || "",
                  dealValue: parseFloat(d.Amount) || 0,
                  source: d.Lead_Source || "",
                  createdTime: d.Created_Time || "",
                  modifiedTime: d.Modified_Time || "",
                  layoutName: d.Layout?.name || d.$layout?.name || "",
                  layoutId: d.Layout?.id || d.$layout?.id || "",
                  pipeline: d.Pipeline || "",
                  products: d.Product_Details
                    ? JSON.stringify(d.Product_Details)
                    : "",
                  contactName: d.Contact_Name?.name || "",
                  accountName: d.Account_Name?.name || "",
                };
              case "contact":
                return {
                  companyName:
                    d.Account_Name?.name ||
                    d.Company ||
                    d.Last_Name ||
                    "Unknown",
                  email: d.Email || "",
                  phone: d.Phone || "",
                  mobile: d.Mobile || "",
                  recordName:
                    d.Full_Name ||
                    `${d.First_Name || ""} ${d.Last_Name || ""}`.trim(),
                  domain: extractDomain(d.Email || ""),
                  ownerName: d.Owner?.name || "Unknown",
                  ownerEmail: d.Owner?.email || "",
                  status: "Contact",
                  source: d.Lead_Source || "",
                  createdTime: d.Created_Time || "",
                  modifiedTime: d.Modified_Time || "",
                  layoutName: d.Layout?.name || d.$layout?.name || "",
                  layoutId: d.Layout?.id || d.$layout?.id || "",
                  title: d.Title || "",
                  accountName: d.Account_Name?.name || "",
                  country: d.Mailing_Country || d.Other_Country || "",
                };
              case "account": {
                const websiteRaw = d.Website || "";
                const websiteDomain =
                  websiteRaw.replace(/^https?:\/\/(www\.)?/, "").split("/")[0] ||
                  "";
                return {
                  companyName: d.Account_Name || "Unknown",
                  email: d.Email || "",
                  phone: d.Phone || "",
                  recordName: d.Account_Name || "Unknown",
                  domain:
                    extractDomain(d.Email || "") ||
                    (websiteDomain && !websiteDomain.includes(" ")
                      ? websiteDomain
                      : null),
                  ownerName: d.Owner?.name || "Unknown",
                  ownerEmail: d.Owner?.email || "",
                  status: "Account",
                  source: "Account",
                  createdTime: d.Created_Time || "",
                  modifiedTime: d.Modified_Time || "",
                  layoutName: d.Layout?.name || d.$layout?.name || "",
                  layoutId: d.Layout?.id || d.$layout?.id || "",
                  website: websiteRaw,
                  crNumber: d.CR_Number || d.Registration_Number || "",
                  vatNumber: d.VAT_Number || d.Tax_ID || "",
                  country: d.Billing_Country || d.Shipping_Country || "",
                  region: d.Billing_State || d.Shipping_State || "",
                  industry: d.Industry || "",
                  noOfEmployees: parseInt(d.Employees) || undefined,
                  accountType: d.Account_Type || "",
                };
              }
            }
          };

          const { pool } = await import("../../utils/database");
          const refreshed: string[] = [];
          const missing: string[] = [];
          const failed: { id: string; error: string }[] = [];

          for (const zohoId of zohoIds) {
            try {
              const live = await fetchZohoRecordById(cfg.zohoModule, zohoId);
              if (!live) {
                missing.push(zohoId);
                continue;
              }
              const existing = await pool.query(
                `SELECT cluster_id FROM duplicate_records WHERE zoho_record_id = $1 AND record_type = $2 LIMIT 1`,
                [zohoId, cfg.recordType],
              );
              const clusterId = existing.rows[0]?.cluster_id;
              if (!clusterId) {
                missing.push(zohoId);
                continue;
              }
              const e = extract(live);
              await upsertRecord({
                cluster_id: clusterId,
                record_type: cfg.recordType,
                zoho_record_id: live.id,
                record_name: e.recordName,
                company_name: e.companyName,
                email: e.email || undefined,
                domain: e.domain || undefined,
                phone: e.phone || undefined,
                mobile: e.mobile || undefined,
                owner_name: e.ownerName,
                owner_email: e.ownerEmail,
                status: e.status,
                stage: e.stage,
                deal_value: e.dealValue,
                source: e.source,
                created_date: e.createdTime
                  ? new Date(e.createdTime)
                  : new Date(),
                modified_date: e.modifiedTime
                  ? new Date(e.modifiedTime)
                  : new Date(),
                is_primary: false,
                confidence_score: 0,
                is_mock_data: false,
                raw_data: live.data,
                layout_name: e.layoutName,
                layout_id: e.layoutId,
                zoho_module: cfg.zohoModule,
                pipeline: e.pipeline,
                products: e.products,
                contact_name: e.contactName,
                account_name: e.accountName,
                cr_number: e.crNumber,
                vat_number: e.vatNumber,
                website: e.website,
                country: e.country,
                region: e.region,
                industry: e.industry,
                no_of_employees: e.noOfEmployees,
                title: e.title,
                lead_type: e.leadType,
                account_type: e.accountType,
              });
              refreshed.push(zohoId);
            } catch (err: any) {
              logger.warn(
                `⚠️ [Radar Refresh] Failed to refresh ${cfg.zohoModule} ${zohoId}: ${err?.message || err}`,
              );
              failed.push({ id: zohoId, error: String(err?.message || err) });
            }
          }

          logger.info(
            `🔄 [Radar Refresh] User ${user.email} refreshed ${refreshed.length}/${zohoIds.length} ${cfg.zohoModule} live from Zoho`,
          );
          return c.json({
            success: true,
            module: moduleRaw,
            requested: zohoIds.length,
            refreshed_count: refreshed.length,
            missing_count: missing.length,
            failed_count: failed.length,
            refreshed,
            missing,
            failed,
          });
        } catch (error: any) {
          logger.error("Error in /api/duplicates/refresh-records:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Account inference scan — walks every deal that lacks a real Account
    // and tries to infer one from its linked contact's email domain. See
    // src/utils/accountInference.ts for the walk + scoring.
    path: "/api/duplicates/account-hints/scan",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          const { initDuplicateRadarTables } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          await initDuplicateRadarTables();
          const { scanDealsForAccountHints } = await import(
            "../../utils/accountInference"
          );
          const result = await scanDealsForAccountHints();
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error running account-hints scan:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // List account inference hints. Query params:
    //   ?status=pending|dismissed|applied (default pending)
    //   ?limit=N (default 500, max 2000)
    path: "/api/duplicates/account-hints",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          const url = new URL(c.req.url);
          const status = url.searchParams.get("status") || undefined;
          const limit = parseInt(url.searchParams.get("limit") || "500", 10);

          const { listAccountInferenceHints } = await import(
            "../../utils/accountInference"
          );
          const result = await listAccountInferenceHints({ status, limit });
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error listing account-hints:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // AI-resolve a single Account-Hint: write the suggested Account_Name
    // directly onto the Zoho Deal record and mark the hint applied. Refuses
    // when confidence is below the threshold (default 70%); the operator
    // can still use the manual Applied / Dismiss buttons for low-signal
    // rows. DESTRUCTIVE (writes to Zoho) → requireAdminOrKey.
    //   POST /api/duplicates/account-hints/:id/resolve-with-ai
    //   Body: { minConfidence?: number }
    path: "/api/duplicates/account-hints/:id/resolve-with-ai",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse: unauthorized } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorized(c);
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid hint id" }, 400);
          let body: { minConfidence?: number } = {};
          try {
            body = (await c.req.json()) || {};
          } catch {
            body = {};
          }
          const performedBy =
            (sessionUser as any)?.email ||
            (sessionUser as any)?.role ||
            "admin";
          const attribution = `GRQ Assistant (on behalf of ${performedBy})`;
          const { aiResolveAccountHint } = await import(
            "../../utils/accountInference"
          );
          const result = await aiResolveAccountHint(id, attribution, {
            minConfidence: Number.isFinite(body.minConfidence)
              ? Number(body.minConfidence)
              : undefined,
          });
          // Map domain-level "won't apply" cases to 200s (so the UI can
          // render the reason inline) and real failures to 500.
          if (!result.success && result.error) {
            return c.json({ ...result }, 500);
          }
          return c.json({ ...result });
        } catch (error: any) {
          logger.error("Error AI-resolving account-hint:", error);
          return c.json({ error: error?.message || String(error) }, 500);
        }
      };
    },
  },
  {
    // Bulk AI-resolve every pending Account Hint at-or-above the confidence
    // threshold. Same per-row logic as the single-id endpoint above, but
    // looped — useful when the user has hundreds of high-confidence hints
    // pending. DESTRUCTIVE (writes to Zoho) → requireAdminOrKey.
    //   POST /api/duplicates/account-hints/resolve-all-with-ai
    //   Body: { minConfidence?: number, limit?: number }
    path: "/api/duplicates/account-hints/resolve-all-with-ai",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse: unauthorized } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorized(c);
          let body: { minConfidence?: number; limit?: number } = {};
          try {
            body = (await c.req.json()) || {};
          } catch {
            body = {};
          }
          const performedBy =
            (sessionUser as any)?.email ||
            (sessionUser as any)?.role ||
            "admin";
          const attribution = `GRQ Assistant (on behalf of ${performedBy})`;
          const { aiResolveAllAccountHints } = await import(
            "../../utils/accountInference"
          );
          const report = await aiResolveAllAccountHints(attribution, {
            minConfidence: Number.isFinite(body.minConfidence)
              ? Number(body.minConfidence)
              : undefined,
            limit: Number.isFinite(body.limit)
              ? Number(body.limit)
              : undefined,
          });
          return c.json({ success: true, ...report });
        } catch (error: any) {
          logger.error("Error bulk AI-resolving account-hints:", error);
          return c.json({ error: error?.message || String(error) }, 500);
        }
      };
    },
  },
  {
    // Mark a hint as dismissed (sales reviewed and rejected) or applied
    // (sales fixed the Zoho Account_Name and the next sync will reclassify).
    // Body: { status: "dismissed" | "applied" }
    path: "/api/duplicates/account-hints/:id/status",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid hint id" }, 400);
          let body: { status?: string } = {};
          try {
            body = (await c.req.json()) || {};
          } catch {
            body = {};
          }
          if (body.status !== "dismissed" && body.status !== "applied") {
            return c.json(
              { error: 'status must be "dismissed" or "applied"' },
              400,
            );
          }
          const { setHintStatus } = await import(
            "../../utils/accountInference"
          );
          const ok = await setHintStatus(id, body.status);
          if (!ok) return c.json({ error: "Hint not found" }, 404);
          return c.json({ success: true });
        } catch (error: any) {
          logger.error("Error updating account-hint status:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // R5 — Single-record Preflight Webhook for inbound integrations.
    //
    // The existing /api/duplicates/preflight endpoint is built for
    // dashboard operators running batches. This one is the machine-to-
    // machine variant: one record in, one verdict + a should_create
    // boolean back. Zoho workflows, web-form backends, and marketing
    // tools call this BEFORE creating a record so genuine duplicates
    // never enter CRM in the first place (Plauti benchmark: real-time
    // prevention cuts duplicate creation 60% within 90 days).
    //
    // Auth: requireAdminOrKey — accepts an `x-admin-key` header so
    // external systems can call it without a session cookie.
    //
    // Body shape (at least one of domain / email / company_name / phone required):
    //   {
    //     "domain": "acme.com",                     // optional
    //     "email":  "buyer@acme.com",                // optional (domain extracted)
    //     "company_name": "ACME Co",                 // optional
    //     "phone": "+966500000000",                  // optional
    //     "ref":   "web-form-submission-12345"       // optional, echoed back
    //   }
    //
    // Response shape:
    //   {
    //     "success": true,
    //     "verdict": "block" | "review" | "warn" | "duplicate" | "pass",
    //     "should_create": true | false,            // simple yes/no for callers
    //     "ref": "web-form-submission-12345",
    //     "reason": "active_cs_customer",
    //     "suggested_action": "...",
    //     "cluster_id": 42 | null,
    //     "lifecycle_state": "adoption" | null,
    //     "sector": "private" | "government" | null,
    //     "owners": ["Ali Alhumoud"],
    //     "arr_exposure": 50000 | null
    //   }
    //
    // Reuses runPreflight() under the hood so the verdict logic stays
    // identical to the dashboard's Preflight tab — operators and
    // webhook callers always see the same answer for the same input.
    path: "/api/duplicates/preflight/check",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireAdminOrKey(c);
          if (!user) return unauthorizedResponse(c);

          let body: any = {};
          try {
            body = (await c.req.json()) ?? {};
          } catch {
            return c.json(
              {
                success: false,
                error:
                  "Body must be JSON: { domain?, email?, company_name?, phone?, ref? }",
              },
              400,
            );
          }

          // At least one identifying signal must be present — otherwise
          // we'd return PASS for an effectively-empty payload, which
          // would be misleading to the caller.
          const hasIdentity =
            !!(body.domain && String(body.domain).trim()) ||
            !!(body.email && String(body.email).trim()) ||
            !!(body.company_name && String(body.company_name).trim()) ||
            !!(body.phone && String(body.phone).trim());
          if (!hasIdentity) {
            return c.json(
              {
                success: false,
                error:
                  "At least one of domain / email / company_name / phone must be provided",
              },
              400,
            );
          }

          const { runPreflight, shouldCreateForVerdict } = await import(
            "../../utils/duplicateRadarPreflight"
          );
          const result = await runPreflight({
            rows: [
              {
                domain: body.domain ?? null,
                email: body.email ?? null,
                company_name: body.company_name ?? null,
                phone: body.phone ?? null,
                ref: body.ref ?? null,
              },
            ],
            // Webhook callers (Zoho workflows, intake forms) tend to fire
            // right when a record is being created — staleness matters.
            // Default to ON for the single-record webhook so the verdict
            // reflects the latest CS section. Caller can override with
            // refresh_overlap=false to skip the recompute.
            refresh_overlap: body.refresh_overlap !== false,
          });

          const row = result.rows[0];
          if (!row) {
            return c.json(
              {
                success: false,
                error: "Preflight returned no verdict (unexpected)",
              },
              500,
            );
          }

          return c.json({
            success: true,
            verdict: row.verdict,
            should_create: shouldCreateForVerdict(row.verdict),
            ref: row.ref ?? body.ref ?? null,
            reason: row.reason,
            suggested_action: row.suggested_action,
            cluster_id: row.cluster_id,
            lifecycle_state: row.lifecycle_state,
            sector: row.sector,
            owners: row.owners,
            arr_exposure: row.arr_exposure,
            matched_via: row.matched_via,
            module_counts: row.module_counts,
          });
        } catch (error: any) {
          logger.error("Error in preflight webhook:", error);
          return c.json(
            { success: false, error: "An internal error occurred" },
            500,
          );
        }
      };
    },
  },
  {
    // Pre-import duplicate check for marketing batches (dashboard-facing).
    // Body: { rows: [{ domain?, email?, company_name?, phone?, ref? }, ...], max_check? }
    // Returns per-row verdict (block | review | warn | duplicate | pass) plus summary.
    // Parse an uploaded Excel (.xlsx) workbook on the operator's behalf
    // and return the rows in the same shape /api/duplicates/preflight
    // expects. Keeps the existing 'paste CSV/JSON' workflow intact —
    // this endpoint is just a convenience so ops can drag the source
    // file from their inbox/Drive instead of converting it by hand.
    //
    //   POST /api/duplicates/preflight/parse-excel
    //     multipart/form-data with one field 'file' (the .xlsx)
    //   Returns: { rows: [{ domain, company_name }], csv: "...", count: N }
    //
    // Header detection is case-insensitive and tolerates 'Domain' /
    // 'Company' / 'Company Name' / 'Email' (domain extracted from
    // email when no domain column is present). Empty rows are dropped.
    // First worksheet only; we don't infer across sheets.
    path: "/api/duplicates/preflight/parse-excel",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          // Accept either multipart upload or raw arrayBuffer body.
          let buffer: Buffer | null = null;
          let fileName = "upload.xlsx";
          const contentType = c.req.header("content-type") || "";
          if (contentType.startsWith("multipart/form-data")) {
            const form = await c.req.parseBody();
            const file = (form as any).file;
            if (!file || typeof file === "string") {
              return c.json(
                { error: "Send the workbook as a multipart 'file' field." },
                400,
              );
            }
            fileName = (file as any).name || fileName;
            const ab = await (file as any).arrayBuffer();
            buffer = Buffer.from(ab);
          } else {
            const ab = await c.req.arrayBuffer();
            buffer = Buffer.from(ab);
          }

          if (!buffer || buffer.length === 0) {
            return c.json({ error: "Empty upload." }, 400);
          }
          if (buffer.length > 10 * 1024 * 1024) {
            return c.json(
              { error: "Workbook too large — 10 MB cap." },
              413,
            );
          }

          // 2026-06-08 ROOT FIX — exceljs is a CommonJS module; dynamic
          // `await import("exceljs")` returns the ESM wrapper
          // `{ default: ... }`, so the constructor is at
          // .default.Workbook, NOT .Workbook directly. The old code hit
          // `new (ExcelJS as any).Workbook()` which was undefined →
          // TypeError: ExcelJS.Workbook is not a constructor (visible to
          // operators uploading a workbook on the preflight check page).
          // Same fix as documentTextExtractor.ts:219 which has been
          // working correctly.
          const ExcelJSMod: any = await import("exceljs");
          const ExcelJS = ExcelJSMod.default ?? ExcelJSMod;
          const wb = new ExcelJS.Workbook();
          try {
            await wb.xlsx.load(buffer);
          } catch (parseErr: any) {
            return c.json(
              {
                error:
                  "Could not parse as .xlsx — make sure the file isn't .xls / .csv / password-protected.",
                detail: parseErr?.message || String(parseErr),
              },
              400,
            );
          }

          const ws = wb.worksheets?.[0];
          if (!ws) {
            return c.json({ error: "Workbook has no worksheets." }, 400);
          }

          // Defensive coercion — exceljs cell values come in many shapes:
          //   - primitive (string / number / boolean / Date)
          //   - { text } for hyperlinks / shared strings
          //   - { richText: [{ text, font }, ...] } for formatted cells
          //   - { result, formula } for formula cells
          //   - { error } for #N/A / #REF! / etc.
          // The historic code called String(v) directly, which produced
          // "[object Object]" for the structured shapes and silently
          // poisoned header detection. cellToString below normalises every
          // shape into the plain-text the operator would see in Excel.
          function cellToString(v: any): string {
            if (v == null) return "";
            if (typeof v === "string") return v;
            if (typeof v === "number" || typeof v === "boolean") return String(v);
            if (v instanceof Date) return v.toISOString();
            if (typeof v === "object") {
              if (typeof v.text === "string") return v.text;
              if (Array.isArray(v.richText)) {
                return v.richText.map((p: any) => p?.text ?? "").join("");
              }
              if (v.result != null) return cellToString(v.result);
              if (v.error != null) return String(v.error);
              if (typeof v.hyperlink === "string") return v.hyperlink;
            }
            return String(v);
          }
          // Cap the iteration at a sane upper bound — exceljs sometimes
          // reports ws.rowCount = 1,048,576 (Excel's max) for files that
          // really only have 50 rows but carry stray formatting in the
          // empty range. Without the cap we'd burn minutes walking
          // millions of empty rows.
          const MAX_ROWS = 50000;
          const lastRow = Math.min(ws.rowCount || 0, MAX_ROWS);

          // Find header row — first non-empty row.
          let headerRowIdx = 1;
          for (let i = 1; i <= lastRow; i++) {
            const r = ws.getRow(i);
            const rv = r.values;
            if (Array.isArray(rv) && rv.some((v: any) => cellToString(v).trim() !== "")) {
              headerRowIdx = i;
              break;
            }
          }
          const headerRow = ws.getRow(headerRowIdx);
          const headers: string[] = [];
          const headerValues = headerRow.values as any[];
          // exceljs row.values is 1-indexed; index 0 is undefined
          for (let i = 1; i < headerValues.length; i++) {
            headers.push(cellToString(headerValues[i]).trim().toLowerCase());
          }

          function findCol(...needles: string[]): number {
            for (const n of needles) {
              const idx = headers.indexOf(n.toLowerCase());
              if (idx >= 0) return idx;
            }
            return -1;
          }
          const domainIdx = findCol("domain", "website", "url");
          const companyIdx = findCol("company_name", "company name", "company", "name", "account name");
          const emailIdx = findCol("email", "email_address", "email address");
          // NEW — capture the rich dedup signals for multi-signal matching
          // (Tier 1 #2 recommendation from the 2026-05-30 review). The
          // preflight engine already accepts these on PreflightInputRow;
          // wiring them in here means the engine can use email + phone
          // for cross-Zoho matching instead of falling back to domain-only.
          const mobileIdx = findCol("mobile_phone", "mobile phone", "mobile", "cell", "cell phone");
          const corporatePhoneIdx = findCol("corporate_phone", "corporate phone", "phone", "work phone", "office phone");
          // Contact (person) name — used to REJECT a named contact that has no
          // email AND no phone (can't be contacted, so don't import). Distinct
          // from company_name so company-only screening rows aren't rejected.
          const contactIdx = findCol(
            "contact_name", "contact name", "full_name", "full name", "fullname", "contact",
          );
          const firstNameIdx = findCol("first_name", "first name", "firstname");
          const lastNameIdx = findCol("last_name", "last name", "lastname");

          if (domainIdx < 0 && emailIdx < 0) {
            return c.json(
              {
                error:
                  "Workbook is missing required column. Need at least one of: 'domain', 'website', 'url', or 'email'.",
                detected_headers: headers,
              },
              400,
            );
          }

          // Read data rows. Each row tracks both the parsed identifier set
          // (for preflight) and the FULL original row indexed by header
          // (so the UI can later export PASS rows back out with all 32+
          // original columns intact — that's the Tier 1 #3 workflow win).
          interface ParsedRow {
            domain: string;
            email: string;
            phone: string;
            company_name: string;
            contact_name: string;
            original_row: Record<string, any>;
            source_row_number: number;
          }
          const rows: ParsedRow[] = [];
          let skippedRows = 0;
          for (let i = headerRowIdx + 1; i <= lastRow; i++) {
            try {
              const r = ws.getRow(i);
              const rv = r.values as any[];
              if (!rv || !Array.isArray(rv)) continue;
              // Skip empty rows
              const nonEmpty = rv.some((v: any) => cellToString(v).trim() !== "");
              if (!nonEmpty) continue;

              let domain = "";
              if (domainIdx >= 0) {
                domain = cellToString(rv[domainIdx + 1]).trim();
              }
              let email = "";
              if (emailIdx >= 0) {
                email = cellToString(rv[emailIdx + 1]).trim();
              }
              if (!domain && email) {
                const at = email.lastIndexOf("@");
                if (at > 0 && at < email.length - 1) domain = email.slice(at + 1);
              }
              // Strip leading https:// www. and trailing / from domain
              domain = domain
                .replace(/^https?:\/\//i, "")
                .replace(/^www\./i, "")
                .replace(/\/.*$/, "")
                .trim()
                .toLowerCase();

              let companyName = "";
              if (companyIdx >= 0) {
                companyName = cellToString(rv[companyIdx + 1]).trim();
              }
              let mobile = "";
              if (mobileIdx >= 0) {
                // Excel sometimes stores phones with a leading apostrophe to
                // force text format (e.g., "'+966 11 464 1611") — strip it.
                mobile = cellToString(rv[mobileIdx + 1]).replace(/^'/, "").trim();
              }
              let corporatePhone = "";
              if (corporatePhoneIdx >= 0) {
                corporatePhone = cellToString(rv[corporatePhoneIdx + 1]).replace(/^'/, "").trim();
              }
              // Combined phone for preflight matching — mobile preferred,
              // corporate as fallback.
              const phone = mobile || corporatePhone;

              let contactName = "";
              if (contactIdx >= 0) {
                contactName = cellToString(rv[contactIdx + 1]).trim();
              }
              if (!contactName && (firstNameIdx >= 0 || lastNameIdx >= 0)) {
                contactName = [
                  firstNameIdx >= 0 ? cellToString(rv[firstNameIdx + 1]).trim() : "",
                  lastNameIdx >= 0 ? cellToString(rv[lastNameIdx + 1]).trim() : "",
                ]
                  .filter(Boolean)
                  .join(" ")
                  .trim();
              }

              // Keep a row that has ANY signal — a domain, an email, a phone, OR a
              // contact name. A NAMED contact with no email/phone used to be dropped
              // here (no domain) and vanish; now it flows through so preflight can
              // REJECT it (no way to contact them). Only a totally empty row drops.
              if (!domain && !email && !phone && !contactName) continue;

              // Reconstruct the full original row keyed by header so the
              // export step can write the operator's original columns back
              // out (including First Name, Title, Industry, Annual Revenue,
              // etc. that preflight itself ignores).
              const originalRow: Record<string, any> = {};
              const fullHeaderValues = headerRow.values as any[];
              for (let h = 1; h < fullHeaderValues.length; h++) {
                const headerLabel = cellToString(fullHeaderValues[h]) || `col_${h}`;
                originalRow[headerLabel] = cellToString(rv[h]);
              }

              rows.push({
                domain,
                email,
                phone,
                company_name: companyName,
                contact_name: contactName,
                original_row: originalRow,
                source_row_number: i,
              });
            } catch (rowErr: any) {
              // Don't let one corrupted row sink the whole upload —
              // log it server-side and keep scanning. The skipped count is
              // returned to the UI so the operator knows.
              skippedRows++;
              logger.warn("[preflight/parse-excel] skipped row", {
                row: i,
                error: rowErr instanceof Error ? rowErr.message : String(rowErr),
              });
            }
          }

          if (rows.length === 0) {
            return c.json(
              {
                error: "No rows with a domain/email found after the header.",
                detected_headers: headers,
                header_row: headerRowIdx,
              },
              400,
            );
          }

          // Within-file dedup detection (Tier 1 #1 recommendation). Same
          // domain appearing twice within an uploaded list is the most
          // common operator mistake when merging multiple lead sources —
          // catching it here saves Zoho cleanup later. Flag by domain
          // first (strongest signal), then by email as a separate axis
          // (catches "two contacts at the same company" which is
          // legitimate vs "same exact email twice" which is not).
          const seenDomain = new Map<string, number[]>();
          const seenEmail = new Map<string, number[]>();
          for (let idx = 0; idx < rows.length; idx++) {
            const r = rows[idx];
            if (r.domain) {
              const existing = seenDomain.get(r.domain) || [];
              existing.push(idx);
              seenDomain.set(r.domain, existing);
            }
            if (r.email) {
              const e = r.email.toLowerCase();
              const existing = seenEmail.get(e) || [];
              existing.push(idx);
              seenEmail.set(e, existing);
            }
          }
          const domainDuplicateGroups = Array.from(seenDomain.entries())
            .filter(([, indices]) => indices.length > 1)
            .map(([domain, indices]) => ({ domain, row_indices: indices, count: indices.length }));
          const emailDuplicateGroups = Array.from(seenEmail.entries())
            .filter(([, indices]) => indices.length > 1)
            .map(([email, indices]) => ({ email, row_indices: indices, count: indices.length }));
          const intraFileDuplicateRowCount =
            domainDuplicateGroups.reduce((acc, g) => acc + (g.count - 1), 0);

          // Build a CSV the operator can see / re-edit in the textarea.
          // Includes the dedup signals the engine can now use.
          const csvLines = ["domain,company_name,contact_name,email,phone"];
          for (const r of rows) {
            const quote = (s: string) =>
              s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
            csvLines.push(
              `${r.domain},${quote(r.company_name)},${quote(r.contact_name)},${quote(r.email)},${quote(r.phone)}`,
            );
          }

          return c.json({
            success: true,
            count: rows.length,
            skipped_rows: skippedRows,
            // Strip the original_row from the rows that go to the preflight
            // engine (it doesn't need 32 columns of overhead). Keep
            // original_rows as a SEPARATE field, parallel-indexed, so the
            // UI can store them client-side for the export step later.
            rows: rows.map((r) => ({
              domain: r.domain,
              email: r.email,
              phone: r.phone,
              company_name: r.company_name,
              contact_name: r.contact_name,
            })),
            original_rows: rows.map((r) => r.original_row),
            source_row_numbers: rows.map((r) => r.source_row_number),
            csv: csvLines.join("\n"),
            file_name: fileName,
            detected_headers: headers,
            header_row: headerRowIdx,
            // Within-file dedup result. UI surfaces a "Internal duplicates"
            // badge so the operator sees the issue before clicking Check.
            intra_file_duplicates: {
              by_domain_groups: domainDuplicateGroups.length,
              by_domain_rows: intraFileDuplicateRowCount,
              by_email_groups: emailDuplicateGroups.length,
              groups: domainDuplicateGroups.slice(0, 20), // cap preview at 20 groups
            },
          });
        } catch (error: any) {
          // Surface the real reason instead of an opaque 500 — without this
          // the operator sees "internal error" and has no path forward. The
          // most common cases here are: an unsupported cell type (date/
          // hyperlink/formula error that exceljs can't coerce), an
          // unexpectedly-shaped row, a header containing non-string content,
          // or a worksheet with a wildly wrong rowCount (Excel sometimes
          // reports millions of empty rows). All three are fixable once the
          // operator knows what to look for.
          logger.error("Error parsing preflight Excel:", error);
          const errName = error instanceof Error ? error.name : "Error";
          const errMsg  = error instanceof Error ? error.message : String(error);
          const detail  = `${errName}: ${errMsg}`;
          return c.json(
            {
              error:
                "Failed to parse the workbook — " + detail +
                ". If the file opens cleanly in Excel, try re-saving it as " +
                "a fresh .xlsx (File → Save As → Excel Workbook) so any " +
                "legacy formatting metadata is dropped, then upload again.",
              detail,
              error_type: errName,
            },
            500,
          );
        }
      };
    },
  },
  {
    // Populate the Layout picker on the "Push PASS rows to Zoho" modal.
    // Returns one entry per layout configured on the requested Zoho
    // module (default Leads). Admin-gated because it touches Zoho
    // credentials.
    path: "/api/duplicates/preflight/zoho-layouts",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } = await import(
            "../../utils/rbacMiddleware"
          );
          const user = await requireAdminOrKey(c);
          if (!user) return unauthorizedResponse(c);
          const url = new URL(c.req.url);
          const module = (url.searchParams.get("module") || "Leads").trim();
          const { fetchZohoLayouts } = await import("../../utils/zohoCRM");
          const layouts = await fetchZohoLayouts(module);
          return c.json({ success: true, module, layouts });
        } catch (error: any) {
          logger.error("Error fetching Zoho layouts:", error);
          return c.json(
            { error: "Failed to fetch Zoho layouts — " + (error?.message || "unknown") },
            500,
          );
        }
      };
    },
  },
  {
    // Populate the Owner picker on the Push-to-Zoho modal.
    path: "/api/duplicates/preflight/zoho-users",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } = await import(
            "../../utils/rbacMiddleware"
          );
          const user = await requireAdminOrKey(c);
          if (!user) return unauthorizedResponse(c);
          const { fetchZohoUsers } = await import("../../utils/zohoCRM");
          const users = await fetchZohoUsers("ActiveUsers");
          // Return only the operator-relevant fields, sorted by name.
          const trimmed = users
            .map((u) => ({
              id: u.id,
              name: u.full_name,
              email: u.email,
              role: u.role,
            }))
            .sort((a, b) =>
              (a.name || "").localeCompare(b.name || ""),
            );
          return c.json({ success: true, users: trimmed });
        } catch (error: any) {
          logger.error("Error fetching Zoho users:", error);
          return c.json(
            { error: "Failed to fetch Zoho users — " + (error?.message || "unknown") },
            500,
          );
        }
      };
    },
  },
  {
    // Push the PASS rows from a Preflight run into Zoho as new Leads.
    // Admin-gated (HIGH risk write — creates records in production CRM).
    //
    // Body:
    //   {
    //     rows: PreflightResultRow[]  // typically the verdict='pass' subset
    //     layout_id: string            // required — Zoho Layout to land on
    //     owner_mode: 'self' | 'round_robin' | 'custom'
    //     owner_id?: string            // required when owner_mode='custom'
    //     round_robin_user_ids?: string[]  // required when owner_mode='round_robin'
    //     source: string               // stamped on every Lead's Lead_Source
    //     dry_run?: boolean            // default TRUE — caller must pass false to actually write
    //     max_batch?: number           // hard cap, default 5000
    //   }
    //
    // Server-side defense in depth:
    //   - Only rows with verdict='pass' are pushed (block/review/warn/
    //     duplicate are dropped with an explanatory outcome).
    //   - At least one of (domain, email, company_name) must be present
    //     per row, or it's dropped.
    //   - Hard cap at max_batch — refuses a load larger than the cap.
    //   - Source string is stamped onto Lead_Source so an auditor can
    //     find every record this push created.
    //   - Audit row written to event_logs with the count + layout +
    //     source + dry_run flag.
    path: "/api/duplicates/preflight/push-to-zoho",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } = await import(
            "../../utils/rbacMiddleware"
          );
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const body = await c.req.json().catch(() => ({}));
          const allRows: any[] = Array.isArray(body?.rows) ? body.rows : [];
          if (allRows.length === 0) {
            return c.json({ error: "rows array required" }, 400);
          }
          const layoutId = String(body?.layout_id || "").trim();
          if (!layoutId) {
            return c.json({ error: "layout_id is required" }, 400);
          }
          const ownerMode = String(body?.owner_mode || "self").trim();
          const ownerId = body?.owner_id ? String(body.owner_id).trim() : null;
          const roundRobinIds: string[] = Array.isArray(body?.round_robin_user_ids)
            ? body.round_robin_user_ids.map((x: any) => String(x).trim()).filter(Boolean)
            : [];
          if (ownerMode === "custom" && !ownerId) {
            return c.json(
              { error: "owner_id required when owner_mode='custom'" },
              400,
            );
          }
          if (ownerMode === "round_robin" && roundRobinIds.length === 0) {
            return c.json(
              { error: "round_robin_user_ids required when owner_mode='round_robin'" },
              400,
            );
          }
          const source = (
            body?.source || `Preflight Push — ${new Date().toISOString().slice(0, 10)}`
          ).toString().trim();
          const dryRun = body?.dry_run !== false;
          const MAX_BATCH_HARD = 5000;
          const maxBatch =
            typeof body?.max_batch === "number" && body.max_batch > 0
              ? Math.min(MAX_BATCH_HARD, Math.floor(body.max_batch))
              : MAX_BATCH_HARD;

          // Defense in depth: drop any row that didn't get a PASS verdict.
          // Drop rows that lack ANY identifier the operator could push.
          const eligible: any[] = [];
          const dropped: Array<{ row_index: number; reason: string }> = [];
          for (const r of allRows) {
            if (r?.verdict && r.verdict !== "pass") {
              dropped.push({
                row_index: r.row_index ?? -1,
                reason: "not_pass_verdict",
              });
              continue;
            }
            const dom = (r?.input?.domain ?? r?.domain ?? "").toString().trim();
            const email = (r?.email ?? "").toString().trim();
            const company = (r?.input?.company_name ?? r?.company_name ?? "").toString().trim();
            if (!dom && !email && !company) {
              dropped.push({
                row_index: r.row_index ?? -1,
                reason: "no_identifier",
              });
              continue;
            }
            eligible.push(r);
          }

          if (eligible.length > maxBatch) {
            return c.json(
              {
                error: `Eligible rows (${eligible.length}) exceed max_batch (${maxBatch}). Split client-side.`,
                eligible_count: eligible.length,
              },
              400,
            );
          }

          // Build the Zoho Lead payloads.
          const payloads: Array<Record<string, any>> = eligible.map((r, i) => {
            const dom = (r?.input?.domain ?? r?.domain ?? "").toString().trim() || null;
            const email = (r?.email ?? "").toString().trim() || null;
            const company = (r?.input?.company_name ?? r?.company_name ?? "").toString().trim() || null;
            const phone = (r?.phone ?? "").toString().trim() || null;
            const ownerForRow =
              ownerMode === "self"
                ? sessionUser?.email || null
                : ownerMode === "round_robin"
                  ? roundRobinIds[i % roundRobinIds.length]
                  : ownerId;
            const p: Record<string, any> = {
              Company: company || dom || "(unknown)",
              Last_Name: company || dom || "(unknown)",
              Lead_Source: source,
              Description: `Imported via QMS Preflight Push — ${new Date().toISOString()}. Operator: ${sessionUser?.email || "unknown"}.`,
              Layout: { id: layoutId },
            };
            if (email) p.Email = email;
            if (phone) p.Phone = phone;
            if (dom) p.Website = dom.startsWith("http") ? dom : `https://${dom}`;
            if (ownerForRow && ownerMode !== "self") {
              p.Owner = { id: ownerForRow };
            }
            return p;
          });

          if (dryRun) {
            // No Zoho calls. Return what WOULD happen.
            return c.json({
              success: true,
              dry_run: true,
              eligible_count: eligible.length,
              dropped_count: dropped.length,
              dropped_sample: dropped.slice(0, 10),
              would_create_count: payloads.length,
              sample_payload: payloads[0] || null,
              source,
              layout_id: layoutId,
              owner_mode: ownerMode,
            });
          }

          const { createZohoRecordsBulk } = await import(
            "../../utils/zohoCRM"
          );
          const outcomes = await createZohoRecordsBulk("Leads", payloads);
          const created = outcomes.filter((o) => o.status === "success").length;
          const failed = outcomes.filter((o) => o.status === "error").length;

          // Audit log — every push gets one row in event_logs.
          try {
            const { logEvent } = await import(
              "../../utils/eventLogsDatabase"
            );
            await logEvent({
              userId: sessionUser?.userId ?? 0,
              userEmail: sessionUser?.email ?? "system",
              userRole: sessionUser?.role,
              actionType: "PUSH_TO_ZOHO",
              entityType: "Leads",
              entityId: layoutId,
              entityName: source,
              description: `Preflight Push: created ${created} of ${payloads.length} Leads (${failed} failed) into Layout ${layoutId}, source "${source}", owner_mode=${ownerMode}.`,
              aiInvolved: false,
              severity: failed > 0 ? "WARNING" : "INFO",
              module: "duplicate-radar",
            });
          } catch {
            /* non-fatal */
          }

          return c.json({
            success: true,
            dry_run: false,
            eligible_count: eligible.length,
            dropped_count: dropped.length,
            attempted: payloads.length,
            created,
            failed,
            outcomes_sample: outcomes.slice(0, 20),
            source,
            layout_id: layoutId,
            owner_mode: ownerMode,
          });
        } catch (error: any) {
          logger.error("Error in preflight push-to-zoho:", error);
          return c.json(
            { error: "Push to Zoho failed — " + (error?.message || "unknown") },
            500,
          );
        }
      };
    },
  },
  {
    // Structured push to Zoho — four actions (re-engage, multi-contact,
    // new-company Account→Contact→Deal, Leads). Dry-run by default.
    // Action 1: Push a Deal under an existing Account (churned-past-cool-off).
    // Action 2: Create Account + all contacts + one Deal (multi-contact new).
    // Action 3: Create Account + contact + Deal (single-contact new, first N).
    // Action 4: Create Leads for the remaining rows (after action 3's slice).
    // Body: { action:1|2|3|4, rows:SPRow[], count?, offset?, dry_run?,
    //         owner_mode?, owner_id?, round_robin_user_ids?, source? }
    path: "/api/duplicates/preflight/structured-push",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } = await import(
            "../../utils/rbacMiddleware"
          );
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const body = await c.req.json().catch(() => ({}));

          const action = Number(body?.action) as 1 | 2 | 3 | 4;
          if (![1, 2, 3, 4].includes(action)) {
            return c.json({ error: "action must be 1, 2, 3, or 4" }, 400);
          }
          const rows: any[] = Array.isArray(body?.rows) ? body.rows : [];
          if (rows.length === 0) {
            return c.json({ error: "rows array required" }, 400);
          }

          const count =
            typeof body?.count === "number" && body.count >= 0
              ? Math.floor(body.count)
              : 0;
          const offset =
            typeof body?.offset === "number" && body.offset >= 0
              ? Math.floor(body.offset)
              : 0;
          const dryRun = body?.dry_run !== false;

          const ownerMode = String(body?.owner_mode || "self").trim();
          const ownerId = body?.owner_id ? String(body.owner_id).trim() : null;
          const roundRobinIds: string[] = Array.isArray(body?.round_robin_user_ids)
            ? body.round_robin_user_ids.map((x: any) => String(x).trim()).filter(Boolean)
            : [];
          if (ownerMode === "custom" && !ownerId) {
            return c.json(
              { error: "owner_id required when owner_mode='custom'" },
              400,
            );
          }
          if (ownerMode === "round_robin" && roundRobinIds.length === 0) {
            return c.json(
              { error: "round_robin_user_ids required when owner_mode='round_robin'" },
              400,
            );
          }
          const source = (
            body?.source ||
            `Preflight Structured Push — ${new Date().toISOString().slice(0, 10)}`
          ).toString().trim();

          // Map raw body rows to SPRow shape.
          const { buildStructuredPushPlan, PREFLIGHT_DEAL_TARGET, PREFLIGHT_LEAD_TARGET } =
            await import("../../utils/preflightStructuredPush");

          const spRows = rows.map((r: any, idx: number) => ({
            row_index: typeof r.row_index === "number" ? r.row_index : idx,
            company: String(r.company ?? r.input?.company_name ?? r.company_name ?? ""),
            domain: String(r.domain ?? r.input?.domain ?? ""),
            email: String(r.email ?? ""),
            phone: String(r.phone ?? ""),
            contact_name: String(r.contact_name ?? r.input?.contact_name ?? ""),
            verdict: String(r.verdict ?? ""),
            cluster_id: r.cluster_id != null ? Number(r.cluster_id) : null,
            lifecycle_state: r.lifecycle_state != null ? String(r.lifecycle_state) : null,
          }));

          const plan = buildStructuredPushPlan(action, spRows, { count, offset });
          const DEAL = PREFLIGHT_DEAL_TARGET;
          const LEAD = PREFLIGHT_LEAD_TARGET;

          // Helper: resolve owner field for a given row index.
          function ownerForIndex(i: number): string | null {
            if (ownerMode === "self") return sessionUser?.email || null;
            if (ownerMode === "round_robin") return roundRobinIds[i % roundRobinIds.length];
            return ownerId;
          }

          // ----------------------------------------------------------------
          // DRY-RUN — no Zoho calls.
          // ----------------------------------------------------------------
          if (dryRun) {
            const dealTag = action === 1 ? "Re-engagement" : "Preflight import";

            // Build sample payloads per action type.
            let samplePayload: Record<string, any> | null = null;
            let wouldAccounts = 0;
            let wouldContacts = 0;
            let wouldDeals = 0;
            let wouldLeads = 0;
            let a1SkippedNoAccount = 0;

            if (action === 4) {
              wouldLeads = plan.leads.length;
              const r = plan.leads[0];
              if (r) {
                const dom = r.domain || null;
                samplePayload = {
                  Last_Name: r.contact_name || r.company || r.domain || "(unknown)",
                  Company: r.company || r.domain || "(unknown)",
                  Lead_Source: source,
                  Layout: { id: LEAD.layoutId },
                  Lead_Status: LEAD.status,
                  ...(r.email ? { Email: r.email } : {}),
                  ...(r.phone ? { Phone: r.phone } : {}),
                  ...(dom ? { Website: dom.startsWith("http") ? dom : `https://${dom}` } : {}),
                };
              }
            } else if (action === 1) {
              // A1 re-engages under an EXISTING Account. Resolve the matched
              // account NOW so the preview is honest: a churned company whose
              // matched cluster has no Account record is skipped at run time
              // (reason no_matched_account), not turned into a deal. Without
              // this, the dry-run over-promises deals it won't actually create.
              const { getAccountZohoIdByCluster: resolveAccForPreview } =
                await import("../../utils/duplicateRadarDatabase");
              let sampleCo: (typeof plan.companies)[number] | null = null;
              let sampleAccId: string | null = null;
              for (const co of plan.companies) {
                const accId =
                  co.clusterId != null
                    ? await resolveAccForPreview(co.clusterId)
                    : null;
                if (accId) {
                  wouldDeals += 1;
                  wouldContacts += co.contacts.length;
                  if (!sampleCo) {
                    sampleCo = co;
                    sampleAccId = accId;
                  }
                } else {
                  a1SkippedNoAccount += 1;
                }
              }
              wouldAccounts = 0; // A1 never creates an account.
              if (sampleCo) {
                samplePayload = {
                  account: null,
                  contact: sampleCo.contacts[0] ? {
                    Last_Name: sampleCo.contacts[0].contact_name || sampleCo.companyName,
                    ...(sampleCo.contacts[0].email ? { Email: sampleCo.contacts[0].email } : {}),
                    ...(sampleCo.contacts[0].phone ? { Phone: sampleCo.contacts[0].phone } : {}),
                    Account_Name: { id: sampleAccId },
                  } : null,
                  deal: {
                    Deal_Name: `${sampleCo.companyName} — ${dealTag}`,
                    Stage: DEAL.stage,
                    Pipeline: DEAL.pipeline,
                    Layout: { id: DEAL.layoutId },
                    Account_Name: { id: sampleAccId },
                    Contact_Name: { id: "(would-be-created)" },
                  },
                };
              }
            } else {
              wouldAccounts = plan.companies.length;
              wouldContacts = plan.contact_count;
              wouldDeals = plan.companies.length;
              const co = plan.companies[0];
              if (co) {
                const dom = co.domain || null;
                const accountId = "(would-be-created)";
                const contactId = "(would-be-created)";
                samplePayload = {
                  account: {
                    Account_Name: co.companyName,
                    Layout: { id: DEAL.layoutId },
                    ...(dom ? { Website: dom.startsWith("http") ? dom : `https://${dom}` } : {}),
                  },
                  contact: co.contacts[0] ? {
                    Last_Name: co.contacts[0].contact_name || co.companyName,
                    ...(co.contacts[0].email ? { Email: co.contacts[0].email } : {}),
                    ...(co.contacts[0].phone ? { Phone: co.contacts[0].phone } : {}),
                    Account_Name: { id: accountId },
                  } : null,
                  deal: {
                    Deal_Name: `${co.companyName} — ${dealTag}`,
                    Stage: DEAL.stage,
                    Pipeline: DEAL.pipeline,
                    Layout: { id: DEAL.layoutId },
                    Account_Name: { id: accountId },
                    Contact_Name: { id: contactId },
                  },
                };
              }
            }

            return c.json({
              success: true,
              dry_run: true,
              action,
              eligible_count: plan.eligible_count,
              contact_count: plan.contact_count,
              would: {
                accounts: wouldAccounts,
                contacts: wouldContacts,
                deals: wouldDeals,
                leads: wouldLeads,
              },
              sample_payload: samplePayload,
              skipped_count: plan.skipped.length + a1SkippedNoAccount,
              no_matched_account_count: a1SkippedNoAccount,
              skipped_sample: plan.skipped.slice(0, 10),
            });
          }

          // ----------------------------------------------------------------
          // REAL RUN — ordered batched creates with id-mapping.
          // ----------------------------------------------------------------
          const { createZohoRecordsBulk } = await import("../../utils/zohoCRM");
          const { getAccountZohoIdByCluster } = await import(
            "../../utils/duplicateRadarDatabase"
          );

          const dealTag = action === 1 ? "Re-engagement" : "Preflight import";

          // Track counts
          const created = { accounts: 0, contacts: 0, deals: 0, leads: 0 };
          const failed = { accounts: 0, contacts: 0, deals: 0, leads: 0 };
          let outcomesSample: any[] = [];

          if (action === 4) {
            // --- ACTION 4: create Leads only ---
            const leadPayloads = plan.leads.map((r, i) => {
              const dom = r.domain || null;
              const p: Record<string, any> = {
                Last_Name: r.contact_name || r.company || r.domain || "(unknown)",
                Company: r.company || r.domain || "(unknown)",
                Lead_Source: source,
                Layout: { id: LEAD.layoutId },
                Lead_Status: LEAD.status,
                Description: `Imported via QMS Preflight Structured Push — ${new Date().toISOString()}. Operator: ${sessionUser?.email || "unknown"}.`,
              };
              if (r.email) p.Email = r.email;
              if (r.phone) p.Phone = r.phone;
              if (dom) p.Website = dom.startsWith("http") ? dom : `https://${dom}`;
              const ownerVal = ownerForIndex(i);
              if (ownerVal && ownerMode !== "self") {
                p.Owner = { id: ownerVal };
              }
              return p;
            });

            const leadOut = leadPayloads.length > 0
              ? await createZohoRecordsBulk("Leads", leadPayloads)
              : [];
            created.leads = leadOut.filter(o => o.status === "success").length;
            failed.leads = leadOut.filter(o => o.status === "error").length;
            outcomesSample = leadOut.slice(0, 20);
          } else {
            // --- ACTIONS 1/2/3: Account → Contact → Deal ---

            // Step 1: For A1 resolve existing account ids; for A2/A3 create accounts.
            // companyKey → accountId (string)
            const accountIdMap = new Map<string, string>();
            const companiesWithAccount: typeof plan.companies = [];
            const companiesSkippedNoAccount: typeof plan.companies = [];

            if (action === 1) {
              // A1: resolve existing account id per company.
              for (const co of plan.companies) {
                const existingId = co.clusterId != null
                  ? await getAccountZohoIdByCluster(co.clusterId)
                  : null;
                if (!existingId) {
                  // Cannot push without a matched account — skip this company.
                  companiesSkippedNoAccount.push(co);
                } else {
                  accountIdMap.set(co.companyKey, existingId);
                  companiesWithAccount.push(co);
                }
              }
            } else {
              // A2/A3: create all accounts first.
              const accountPayloads = plan.companies.map((co) => {
                const dom = co.domain || null;
                const p: Record<string, any> = {
                  Account_Name: co.companyName,
                  Layout: { id: DEAL.layoutId },
                };
                if (dom) p.Website = dom.startsWith("http") ? dom : `https://${dom}`;
                return p;
              });

              const accOut = accountPayloads.length > 0
                ? await createZohoRecordsBulk("Accounts", accountPayloads)
                : [];
              created.accounts = accOut.filter(o => o.status === "success").length;
              failed.accounts = accOut.filter(o => o.status === "error").length;

              // Map companyKey → created account id.
              for (let i = 0; i < plan.companies.length; i++) {
                const co = plan.companies[i];
                const out = accOut[i];
                if (out?.status === "success" && out.id) {
                  accountIdMap.set(co.companyKey, out.id);
                  companiesWithAccount.push(co);
                } else {
                  // Account creation failed — skip this company's contacts + deal.
                  companiesSkippedNoAccount.push(co);
                }
              }
            }

            // Step 2: Create contacts for companies that have an account id.
            // Map companyKey → firstContactId (for deal linkage)
            const firstContactIdMap = new Map<string, string>();

            if (companiesWithAccount.length > 0) {
              // Build contact payloads (one per contact row, all companies interleaved).
              interface ContactMeta { companyKey: string; rowIndex: number }
              const contactMeta: ContactMeta[] = [];
              const contactPayloads: Record<string, any>[] = [];

              for (const co of companiesWithAccount) {
                const accountId = accountIdMap.get(co.companyKey)!;
                for (const row of co.contacts) {
                  const p: Record<string, any> = {
                    Last_Name: row.contact_name || co.companyName,
                    Account_Name: { id: accountId },
                  };
                  if (row.email) p.Email = row.email;
                  if (row.phone) p.Phone = row.phone;
                  contactPayloads.push(p);
                  contactMeta.push({ companyKey: co.companyKey, rowIndex: row.row_index });
                }
              }

              const conOut = contactPayloads.length > 0
                ? await createZohoRecordsBulk("Contacts", contactPayloads)
                : [];
              created.contacts = conOut.filter(o => o.status === "success").length;
              failed.contacts = conOut.filter(o => o.status === "error").length;

              // First successful contact per company → firstContactId for Deal.
              for (let i = 0; i < conOut.length; i++) {
                const out = conOut[i];
                if (out?.status === "success" && out.id) {
                  const meta = contactMeta[i];
                  if (!firstContactIdMap.has(meta.companyKey)) {
                    firstContactIdMap.set(meta.companyKey, out.id);
                  }
                }
              }
            }

            // Step 3: Create deals.
            if (companiesWithAccount.length > 0) {
              const dealPayloads: Record<string, any>[] = [];
              const dealCompanyKeys: string[] = [];

              for (const co of companiesWithAccount) {
                const accountId = accountIdMap.get(co.companyKey);
                const firstContactId = firstContactIdMap.get(co.companyKey);
                // Only create deal if we have at least an account id.
                if (!accountId) continue;
                const p: Record<string, any> = {
                  Deal_Name: `${co.companyName} — ${dealTag}`,
                  Stage: DEAL.stage,
                  Pipeline: DEAL.pipeline,
                  Layout: { id: DEAL.layoutId },
                  Account_Name: { id: accountId },
                };
                if (firstContactId) {
                  p.Contact_Name = { id: firstContactId };
                }
                dealPayloads.push(p);
                dealCompanyKeys.push(co.companyKey);
              }

              const dealOut = dealPayloads.length > 0
                ? await createZohoRecordsBulk("Deals", dealPayloads)
                : [];
              created.deals = dealOut.filter(o => o.status === "success").length;
              failed.deals = dealOut.filter(o => o.status === "error").length;
              outcomesSample = dealOut.slice(0, 20);
            }

            // Add skipped-no-account to the plan's skipped count.
            plan.skipped.push(
              ...companiesSkippedNoAccount.flatMap(co =>
                co.contacts.map(r => ({ row_index: r.row_index, reason: "no_matched_account" }))
              )
            );
          }

          // Audit log.
          try {
            const { logEvent } = await import("../../utils/eventLogsDatabase");
            const totalFailed = failed.accounts + failed.contacts + failed.deals + failed.leads;
            const desc =
              action === 4
                ? `Preflight structured push (action 4): created ${created.leads} Leads (${failed.leads} failed). Source: "${source}".`
                : `Preflight structured push (action ${action}): created ${created.accounts} accounts, ${created.contacts} contacts, ${created.deals} deals (${totalFailed} failed). Source: "${source}".`;
            await logEvent({
              userId: sessionUser?.userId ?? 0,
              userEmail: sessionUser?.email ?? "system",
              userRole: sessionUser?.role,
              actionType: "PUSH_TO_ZOHO",
              entityType: action === 4 ? "Leads" : "Deals",
              entityId: action === 4 ? LEAD.layoutId : DEAL.layoutId,
              entityName: source,
              description: desc,
              aiInvolved: false,
              severity: (failed.accounts + failed.contacts + failed.deals + failed.leads) > 0 ? "WARNING" : "INFO",
              module: "duplicate-radar",
            });
          } catch {
            /* non-fatal */
          }

          return c.json({
            success: true,
            dry_run: false,
            action,
            created,
            failed,
            skipped_count: plan.skipped.length,
            outcomes_sample: outcomesSample,
          });
        } catch (error: any) {
          logger.error("Error in preflight structured-push:", error);
          return c.json(
            { error: "Structured push to Zoho failed — " + (error?.message || "unknown") },
            500,
          );
        }
      };
    },
  },
  {
    // Formatted Excel export for the Preflight Check tab. Takes either a
    // PreflightResponse the client already rendered (preferred — no
    // re-run) or `rows` to re-run server-side. Returns an .xlsx with:
    //   - "Summary" cover sheet (totals, % blocked/duplicate, top reasons,
    //     generated-at)
    //   - "Findings" sheet (color-coded severity rows, frozen header,
    //     business-language "Recommended Action" column, owner column,
    //     module counts, reason code)
    // Designed to be the attachment for an executive email — drop straight
    // into a "Hi [Head of Sales], …" body.
    path: "/api/duplicates/preflight/export-xlsx",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const body = await c.req.json().catch(() => ({}));

          // Prefer the client-supplied result (no extra DB load); fall
          // back to re-running over `rows` if the caller wants the server
          // to compute fresh.
          let result: any = null;
          if (body?.result && typeof body.result === "object") {
            result = body.result;
          } else if (Array.isArray(body?.rows)) {
            const { runPreflight } = await import(
              "../../utils/duplicateRadarPreflight"
            );
            result = await runPreflight({
              rows: body.rows,
              max_check:
                typeof body.max_check === "number"
                  ? body.max_check
                  : undefined,
              refresh_overlap: body.refresh_overlap === true,
            });
          } else {
            return c.json(
              { error: "Provide either `result` or `rows`." },
              400,
            );
          }

          // 2026-06-17 — flagged-only export for the Head-of-Sales hand-off
          // (no PASS rows) + optional per-row contact columns merged from the
          // uploaded file (keyed by row_index). Sending a native .xlsx avoids
          // the CSV→Excel conversion that was shifting cells / dropping the
          // header on the client-built file.
          const flaggedOnly = body?.flaggedOnly === true;
          const passOnly = body?.passOnly === true;
          const contacts =
            body?.contacts && typeof body.contacts === "object"
              ? body.contacts
              : null;
          // FULL original columns from the uploaded file (per row_index) + the
          // ordered header list — appended after the analysis columns so the
          // exported sheet carries the operator's COMPLETE record, not just
          // Company/Contact/Email/Phone.
          const originals =
            body?.originals && typeof body.originals === "object"
              ? body.originals
              : null;
          // Columns from the uploaded file we never want in the hand-off export
          // (enrichment-vendor noise the Sales team doesn't need). Sarah
          // 2026-06-25: drop "Keywords" and "Technologies". Filtering the header
          // list here removes them from BOTH the column defs and the per-row
          // values (which are keyed by header name) with no index drift.
          const PREFLIGHT_EXPORT_EXCLUDE_COLS = new Set(["keywords", "technologies"]);
          const originalHeaders: string[] = Array.isArray(body?.original_headers)
            ? body.original_headers
                .map((h: any) => String(h))
                .filter(Boolean)
                .filter((h: string) => !PREFLIGHT_EXPORT_EXCLUDE_COLS.has(h.trim().toLowerCase()))
            : [];
          const rowsToEmit = (Array.isArray(result.rows) ? result.rows : []).filter(
            (r: any) => {
              if (flaggedOnly) return r && r.verdict && r.verdict !== "pass";
              if (passOnly) return r && r.verdict === "pass";
              return true;
            },
          );

          const ExcelJS = (await import("exceljs")).default;
          const wb = new ExcelJS.Workbook();
          wb.creator = "WalaPlus QMS — Duplicate Radar";
          wb.created = new Date();

          // ── Summary sheet ────────────────────────────────────────────
          const summary = wb.addWorksheet("Summary", {
            properties: { tabColor: { argb: "FF4F46E5" } },
          });
          summary.columns = [
            { header: "Metric", key: "k", width: 50 },
            { header: "Value", key: "v", width: 28 },
          ];
          const headerRow = summary.getRow(1);
          headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
          headerRow.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FF4F46E5" },
          };
          summary.getRow(1).alignment = { vertical: "middle" };
          summary.views = [{ state: "frozen", ySplit: 1 }];

          const add = (k: string, v: any) => summary.addRow({ k, v });
          add("Generated at (UTC)", result.generated_at || new Date().toISOString());
          add("Total rows submitted", result.total_rows || 0);
          add("Rows examined", result.examined || 0);
          add("Rows skipped (over cap)", result.skipped || 0);
          add(
            "Share that would have created a duplicate (%)",
            (result.pct_actionable ?? 0) + "%",
          );
          summary.addRow({});
          const sHdr = summary.addRow({
            k: "Verdict breakdown",
            v: "Count",
          });
          sHdr.font = { bold: true };
          add("✗ BLOCK — active CS customer", result.summary?.block || 0);
          add("⚠ REVIEW — within CS cool-off", result.summary?.review || 0);
          add("✓ WARN — past CS cool-off", result.summary?.warn || 0);
          add(
            "≡ DUPLICATE — already in CRM",
            result.summary?.duplicate || 0,
          );
          add(
            "✗ REJECTED — no email & no phone",
            (result.summary as any)?.no_contact || 0,
          );
          add("✓ PASS — safe to import", result.summary?.pass || 0);

          if (Array.isArray(result.top_reasons) && result.top_reasons.length > 0) {
            summary.addRow({});
            const tHdr = summary.addRow({
              k: "Top reasons (business language)",
              v: "Count / %",
            });
            tHdr.font = { bold: true };
            for (const r of result.top_reasons) {
              add(r.label, r.count + " rows (" + r.pct + "%)");
            }
          }

          // Cell border + alternating row tint for the summary sheet.
          summary.eachRow((row: any, idx: number) => {
            if (idx > 1 && idx % 2 === 0) {
              row.fill = {
                type: "pattern",
                pattern: "solid",
                fgColor: { argb: "FFF8FAFC" },
              };
            }
            row.eachCell((cell: any) => {
              cell.border = {
                top: { style: "thin", color: { argb: "FFE2E8F0" } },
                left: { style: "thin", color: { argb: "FFE2E8F0" } },
                bottom: { style: "thin", color: { argb: "FFE2E8F0" } },
                right: { style: "thin", color: { argb: "FFE2E8F0" } },
              };
            });
          });

          // ── Findings sheet ───────────────────────────────────────────
          const findings = wb.addWorksheet("Findings");
          // Every column from the operator's uploaded file, appended AFTER the
          // analysis columns (unique keys orig_<n>, original header text kept
          // verbatim) so the export carries the COMPLETE original record.
          const origColumns = originalHeaders.map((h, idx) => ({
            header: h,
            key: `orig_${idx}`,
            width: 22,
          }));
          findings.columns = [
            { header: "#", key: "i", width: 6 },
            { header: "Verdict", key: "verdict", width: 12 },
            { header: "Severity", key: "sev", width: 10 },
            { header: "Comment / Reason", key: "exec", width: 60 },
            { header: "Domain", key: "domain", width: 26 },
            { header: "Company", key: "company", width: 32 },
            ...(contacts
              ? [
                  { header: "Contact Name", key: "contact_name", width: 24 },
                  { header: "Email", key: "contact_email", width: 30 },
                  { header: "Phone", key: "contact_phone", width: 18 },
                ]
              : []),
            { header: "Existing Owner(s)", key: "owners", width: 28 },
            { header: "CS Owner", key: "cs_owner", width: 22 },
            { header: "CRM Modules (L·D·C·A)", key: "modules", width: 22 },
            { header: "CS Phase", key: "phase", width: 16 },
            { header: "Churn Date", key: "churn_date", width: 14 },
            { header: "Days Since Churn", key: "churn_days", width: 14 },
            // Sarah 2026-06-17 — clickable Zoho links per rejected row.
            // Operator clicks straight to the existing Lead / Deal /
            // Account to verify the rejection without going back into
            // the dashboard. Empty cell when the cluster has no
            // matching record of that type.
            { header: "Existing Active Lead",         key: "link_active_lead",  width: 36 },
            { header: "Existing Active Deal",         key: "link_active_deal",  width: 36 },
            { header: "Existing Customer Deal (CS)",  key: "link_client_deal",  width: 36 },
            { header: "Existing Account",             key: "link_account",      width: 36 },
            { header: "Reason (engineer)", key: "reason", width: 32 },
            { header: "Matched via", key: "matched_via", width: 16 },
            ...origColumns,
          ];
          const fHdr = findings.getRow(1);
          fHdr.font = { bold: true, color: { argb: "FFFFFFFF" } };
          fHdr.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FF1E293B" },
          };
          findings.views = [{ state: "frozen", ySplit: 1 }];

          const severityFill: Record<string, string> = {
            critical: "FFFEE2E2",
            high: "FFFEF3C7",
            medium: "FFFEF9C3",
            low: "FFDBEAFE",
            info: "FFDCFCE7",
          };

          const fmtModules = (mc: any) =>
            mc
              ? `${mc.leads || 0}·${mc.deals || 0}·${mc.contacts || 0}·${mc.accounts || 0}`
              : "—";

          // Sarah 2026-06-17 — hyperlink helper. ExcelJS understands
          // a cell value of { text, hyperlink, tooltip } as a clickable
          // link. Empty cell when there's no matching record.
          const mkLink = (lk: any) =>
            lk && lk.url
              ? { text: lk.label || "Open in Zoho", hyperlink: lk.url, tooltip: lk.url }
              : "";
          // CS Phase column — render the lifecycle_state enum as a human label
          // for the Head of Sales. Termination rows additionally carry the
          // Churn Date in its own column (Ahmad 2026-06-22).
          const phaseLabel = (s: any): string => {
            switch (s) {
              case "onboarding": return "Onboarding";
              case "adoption": return "Adoption";
              case "renewal": return "Renewal";
              case "termination_recent": return "Termination (within cool-off)";
              case "termination_old": return "Termination (past cool-off)";
              default: return "";
            }
          };
          for (const r of rowsToEmit) {
            const ct = contacts
              ? contacts[r.row_index] || contacts[String(r.row_index)] || {}
              : {};
            // Pull this row's full original record and map each header to its
            // orig_<n> column key.
            const origRow = originals
              ? originals[r.row_index] || originals[String(r.row_index)] || {}
              : {};
            const origValues: Record<string, any> = {};
            originalHeaders.forEach((h, idx) => {
              const v = (origRow as any)[h];
              origValues[`orig_${idx}`] = v == null ? "" : v;
            });
            const row = findings.addRow({
              ...origValues,
              i: (r.row_index ?? 0) + 1,
              verdict: r.verdict?.toUpperCase() || "PASS",
              sev: r.executive_severity?.toUpperCase() || "INFO",
              exec: r.executive_action || r.suggested_action || "",
              domain: r.input?.domain || "",
              company: r.input?.company_name || "",
              contact_name: ct.name || "",
              contact_email: ct.email || "",
              contact_phone: ct.phone || "",
              owners: Array.isArray(r.owners) ? r.owners.join(", ") : "",
              cs_owner: r.cs_owner || "",
              modules: fmtModules(r.module_counts),
              phase: (r.cs_phase && String(r.cs_phase).trim()) || phaseLabel(r.lifecycle_state),
              churn_date: r.churn_date || "",
              churn_days: r.churn_days != null ? r.churn_days : "",
              link_active_lead:  mkLink(r.crm_links?.active_lead),
              link_active_deal:  mkLink(r.crm_links?.active_deal),
              link_client_deal:  mkLink(r.crm_links?.client_deal),
              link_account:      mkLink(r.crm_links?.account),
              reason: r.reason || "",
              matched_via: r.matched_via || "",
            });
            // Apply Excel hyperlink styling (blue underline) to the
            // four CRM-link cells when populated. Skip cells where
            // the value is plain text ("").
            for (const key of ["link_active_lead","link_active_deal","link_client_deal","link_account"]) {
              const cell = row.getCell(key);
              if (cell.value && typeof cell.value === "object" && "hyperlink" in (cell.value as any)) {
                cell.font = { color: { argb: "FF1D4ED8" }, underline: true };
              }
            }
            // Existing-client highlighting (Ahmad 2026-06-23) — colour CS clients
            // the way the operator hand-marked them so the sales lead can't miss
            // them: RED = existing ACTIVE client (do not contact), ORANGE =
            // churned client (recent / cool-off), AMBER = possible client (verify).
            let fill = severityFill[r.executive_severity] || null;
            const reasonStr = String(r.reason || "");
            if (r.verdict === "block") {
              fill = "FFFFC7CE"; // red — existing active client
            } else if (r.verdict === "review" && reasonStr.startsWith("recently_churned")) {
              fill = "FFFFD27F"; // orange — churned within cool-off
            } else if (r.verdict === "review") {
              fill = "FFFFE699"; // amber — possible client, verify
            }
            if (fill) {
              row.fill = {
                type: "pattern",
                pattern: "solid",
                fgColor: { argb: fill },
              };
            }
            row.alignment = { vertical: "top", wrapText: true };
          }

          findings.eachRow((row: any) => {
            row.eachCell((cell: any) => {
              cell.border = {
                top: { style: "thin", color: { argb: "FFE2E8F0" } },
                left: { style: "thin", color: { argb: "FFE2E8F0" } },
                bottom: { style: "thin", color: { argb: "FFE2E8F0" } },
                right: { style: "thin", color: { argb: "FFE2E8F0" } },
              };
            });
          });

          const buf = await wb.xlsx.writeBuffer();
          const stamp = new Date()
            .toISOString()
            .slice(0, 16)
            .replace("T", "_")
            .replace(":", "");
          c.header(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          );
          c.header(
            "Content-Disposition",
            `attachment; filename="preflight-report_${stamp}.xlsx"`,
          );
          return c.body(buf as ArrayBuffer);
        } catch (error: any) {
          logger.error("Error exporting preflight xlsx:", error);
          return c.json(
            { error: "Failed to export — " + (error?.message || "unknown") },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/duplicates/preflight",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          let body: any = {};
          try {
            body = (await c.req.json()) ?? {};
          } catch {
            return c.json(
              { error: "Body must be JSON: { rows: [...], max_check?: number }" },
              400,
            );
          }
          if (!Array.isArray(body.rows)) {
            return c.json(
              { error: "rows must be an array of row objects" },
              400,
            );
          }
          if (body.rows.length === 0) {
            return c.json(
              { error: "rows must contain at least one entry" },
              400,
            );
          }

          const { runPreflight } = await import(
            "../../utils/duplicateRadarPreflight"
          );
          const result = await runPreflight({
            rows: body.rows,
            max_check:
              typeof body.max_check === "number" ? body.max_check : undefined,
            // Opt-in: when the operator wants a fresh CS overlap verdict
            // (e.g. they just nudged a Phase in Zoho), pass
            // ?refresh_overlap=true in the body. Default false keeps the
            // batch endpoint fast.
            refresh_overlap: body.refresh_overlap === true,
          });
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error running preflight:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Per-row "↻ Re-check from CRM" (Sarah 2026-06-25). After the operator
    // corrects a mis-tagged client in Zoho, this re-fetches ONLY that company's
    // deals from Zoho, busts the CS-client directory cache, and re-runs the
    // preflight verdict for the affected rows — so a stale BLOCK flips to PASS
    // in seconds without re-uploading or waiting for the full scan. Reuses the
    // exact resync logic as scripts/resyncCorrectedDeals.ts.
    path: "/api/duplicates/preflight/recheck",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);

          let body: any = {};
          try {
            body = (await c.req.json()) ?? {};
          } catch {
            return c.json(
              { error: "Body must be JSON: { domains?: [], names?: [], rows: [...] }" },
              400,
            );
          }
          if (!Array.isArray(body.rows) || body.rows.length === 0) {
            return c.json({ error: "rows must contain at least one entry" }, 400);
          }
          const domains: string[] = Array.isArray(body.domains)
            ? body.domains.filter((d: any) => typeof d === "string" && d.trim())
            : [];
          const names: string[] = Array.isArray(body.names)
            ? body.names.filter((n: any) => typeof n === "string" && n.trim())
            : [];
          if (!domains.length && !names.length) {
            return c.json(
              { error: "Provide at least one domain or company name to re-sync" },
              400,
            );
          }

          // 1) Re-fetch this company's deals from Zoho + bust the directory cache.
          const { resyncCompanyDealsFromZoho } = await import(
            "../../utils/duplicateRadarResync"
          );
          const resync = await resyncCompanyDealsFromZoho([{ domains, names }]);

          // 2) Re-run preflight for the affected rows against the fresh data.
          //    refresh_overlap=true so the CS verdict is recomputed, not cached.
          const { runPreflight } = await import(
            "../../utils/duplicateRadarPreflight"
          );
          const result = await runPreflight({
            rows: body.rows,
            refresh_overlap: true,
          });

          return c.json({
            success: true,
            resync: {
              updated: resync.updated,
              missing: resync.missing,
              scanned: resync.scanned,
            },
            rows: result.rows,
            summary: result.summary,
          });
        } catch (error: any) {
          logger.error("Error in preflight recheck:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Sarah 2026-06-17 — Account merge candidates surface. Returns the
    // set of domains that have ≥2 clusters in active/resolved status,
    // grouped so the operator picks a master and merges the rest in.
    // Read-only.
    path: "/api/duplicates/cluster-merge-candidates",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const url = new URL(c.req.url);
          const limit = parseInt(url.searchParams.get("limit") || "200", 10);
          const { findSameDomainClusterDuplicates } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          const r = await findSameDomainClusterDuplicates({ limit });
          return c.json({ success: true, ...r });
        } catch (error: any) {
          logger.error("Error fetching cluster merge candidates:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    // Admin-gated structural cluster merge. Reparents every record from
    // sourceClusterIds to targetClusterId, snapshots each source pre-
    // merge so the action is undo-able, writes one duplicate_merge_actions
    // row per source, deletes the now-empty source rows, and recomputes
    // the target's stats. Body:
    //   { target_cluster_id: number, source_cluster_ids: number[], notes?: string }
    path: "/api/duplicates/clusters/merge-into",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse: ua } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return ua(c);

          const body = await c.req.json().catch(() => ({}));
          const targetId = Number(body?.target_cluster_id);
          const sourceIds = Array.isArray(body?.source_cluster_ids)
            ? body.source_cluster_ids.map((x: any) => Number(x))
            : [];
          if (!Number.isFinite(targetId) || targetId <= 0) {
            return c.json(
              { error: "target_cluster_id must be a positive integer" },
              400,
            );
          }
          if (sourceIds.length === 0) {
            return c.json(
              { error: "source_cluster_ids must contain at least one id" },
              400,
            );
          }
          const { mergeClustersIntoMaster } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          const r = await mergeClustersIntoMaster({
            sourceClusterIds: sourceIds,
            targetClusterId: targetId,
            performedBy: sessionUser.email || "admin",
            notes: typeof body?.notes === "string" ? body.notes : undefined,
          });
          logger.info(
            `🔁 [DuplicateRadar] Cluster merge: target=#${r.target_cluster_id}, sources=[${r.source_cluster_ids.join(",")}], records_moved=${r.records_moved}, deleted=${r.source_clusters_deleted}, by=${sessionUser.email || "admin"}`,
          );
          return c.json({ success: true, ...r });
        } catch (error: any) {
          logger.error("Error merging clusters:", error);
          return c.json(
            { error: error?.message || "Cluster merge failed" },
            500,
          );
        }
      };
    },
  },

  // ── Empty / Orphaned Records cleanup tab (Sarah 2026-06-25) ──────────────
  // Surfaces orphaned/empty/test records → admin tags them "Empty-Delete" (HITL,
  // never auto-deletes; admin deletes in Zoho). Detection off local data; the
  // only live Zoho call is the lazy per-account attachment check.
  {
    path: "/api/duplicates/empty-records/deals",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      try {
        const user = await requireDuplicateRadarAccess(c);
        if (!user) return unauthorizedResponse(c);
        const { getEmptyDeals } = await import("../../utils/emptyRecordsDatabase");
        return c.json({ success: true, rows: await getEmptyDeals() });
      } catch (e: any) {
        logger.error("empty-records/deals failed", e);
        return c.json({ error: "An internal error occurred" }, 500);
      }
    },
  },
  {
    path: "/api/duplicates/empty-records/accounts",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      try {
        const user = await requireDuplicateRadarAccess(c);
        if (!user) return unauthorizedResponse(c);
        const { getEmptyAccounts } = await import("../../utils/emptyRecordsDatabase");
        return c.json({ success: true, rows: await getEmptyAccounts() });
      } catch (e: any) {
        logger.error("empty-records/accounts failed", e);
        return c.json({ error: "An internal error occurred" }, 500);
      }
    },
  },
  {
    path: "/api/duplicates/empty-records/contacts",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      try {
        const user = await requireDuplicateRadarAccess(c);
        if (!user) return unauthorizedResponse(c);
        const { getEmptyContacts } = await import("../../utils/emptyRecordsDatabase");
        return c.json({ success: true, rows: await getEmptyContacts() });
      } catch (e: any) {
        logger.error("empty-records/contacts failed", e);
        return c.json({ error: "An internal error occurred" }, 500);
      }
    },
  },
  {
    // Lazy per-account attachment count — Delete stays disabled in the UI until
    // this confirms 0 (so we never tag an account holding a signed contract).
    path: "/api/duplicates/empty-records/accounts/:id/attachments",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      try {
        const user = await requireDuplicateRadarAccess(c);
        if (!user) return unauthorizedResponse(c);
        const id = c.req.param("id");
        if (!id) return c.json({ error: "account id required" }, 400);
        let atts: any[] = [];
        try {
          atts = await fetchRecordAttachments("Accounts", id);
        } catch (e: any) {
          return c.json({ error: `Zoho attachments fetch failed: ${e?.message || e}` }, 502);
        }
        // An account is only truly empty when it ALSO has no live deals/contacts —
        // the local mirror can be stale, so confirm against Zoho here too (Ahmad
        // 2026-06-26: real accounts with deals were wrongly shown as deletable).
        let dealsCount = 0;
        let contactsCount = 0;
        try {
          const deals = await fetchZohoRelatedRecords("Accounts", id, "Deals", { perPage: 1 });
          dealsCount = Array.isArray(deals) ? deals.length : 0;
          const contacts = await fetchZohoRelatedRecords("Accounts", id, "Contacts", { perPage: 1 });
          contactsCount = Array.isArray(contacts) ? contacts.length : 0;
        } catch (e: any) {
          // Inconclusive → fail safe: report it as not-empty so it is NOT tagged.
          return c.json({ error: `Zoho related-list fetch failed: ${e?.message || e}` }, 502);
        }
        return c.json({
          count: Array.isArray(atts) ? atts.length : 0,
          deals: dealsCount,
          contacts: contactsCount,
        });
      } catch (e: any) {
        logger.error("empty-records attachment check failed", e);
        return c.json({ error: "An internal error occurred" }, 500);
      }
    },
  },
  {
    // Per-row "Check documents" — read-only live emptiness check for a single
    // Accounts/Deals/Contacts record (same shared gate AI-Apply uses). Returns
    // { empty, reason, ghost, tagged }; makes NO change.
    path: "/api/duplicates/empty-records/:module/:id/check-empty",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      try {
        const user = await requireDuplicateRadarAccess(c);
        if (!user) return unauthorizedResponse(c);
        const module = String(c.req.param("module") || "");
        const id = c.req.param("id");
        if (!["Deals", "Accounts", "Contacts"].includes(module))
          return c.json({ error: "module must be Deals|Accounts|Contacts" }, 400);
        if (!id) return c.json({ error: "record id required" }, 400);
        const { checkRecordEmptiness } = await import("../../utils/emptyRecordsDatabase");
        const r = await checkRecordEmptiness(module as "Deals" | "Accounts" | "Contacts", id);
        return c.json(r);
      } catch (e: any) {
        logger.error("empty-records check-empty failed", e);
        return c.json({ error: `check failed: ${e?.message || e}` }, 502);
      }
    },
  },
  {
    // Read-only BATCH emptiness check — verifies a whole page of ids in ONE request
    // (auto-check on fetch, without firing 50 separate calls that trip the rate
    // limit). Makes NO change. Body: { module, zohoIds[] }.
    path: "/api/duplicates/empty-records/check-batch",
    method: "POST" as const,
    createHandler: async () => async (c: any) => {
      try {
        const user = await requireDuplicateRadarAccess(c);
        if (!user) return unauthorizedResponse(c);
        const body = await c.req.json().catch(() => ({}));
        const module = String(body?.module || "");
        if (!["Deals", "Accounts", "Contacts"].includes(module))
          return c.json({ error: "module must be Deals|Accounts|Contacts" }, 400);
        const zohoIds = Array.isArray(body?.zohoIds)
          ? body.zohoIds.map((x: any) => String(x)).filter(Boolean)
          : [];
        if (!zohoIds.length) return c.json({ success: true, results: [] });
        const { getEmptinessBatch } = await import("../../utils/emptyRecordsDatabase");
        const results = await getEmptinessBatch(module as "Deals" | "Accounts" | "Contacts", zohoIds);
        return c.json({ success: true, results });
      } catch (e: any) {
        logger.error("empty-records check-batch failed", e);
        return c.json({ error: `batch check failed: ${e?.message || e}` }, 502);
      }
    },
  },
  {
    // Smart Account Inference suggestion for an orphaned deal (link, not delete).
    path: "/api/duplicates/empty-records/deals/:id/account-suggestion",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      try {
        const user = await requireDuplicateRadarAccess(c);
        if (!user) return unauthorizedResponse(c);
        const id = c.req.param("id");
        if (!id) return c.json({ error: "deal id required" }, 400);
        const { pool } = await import("../../utils/duplicateRadarDatabase");
        const dr = await pool.query(
          `SELECT zoho_record_id, raw_data FROM duplicate_records
            WHERE record_type='deal' AND zoho_record_id=$1 LIMIT 1`,
          [id],
        );
        if (!dr.rows.length) return c.json({ suggestion: null });
        const { inferAccountForDeal } = await import("../../utils/accountInference");
        const inf = await inferAccountForDeal(dr.rows[0] as any);
        return c.json({
          suggestion: inf
            ? {
                accountId: inf.account.zoho_record_id,
                accountName: inf.account.account_name || inf.account.company_name || "",
                confidence: inf.confidence,
              }
            : null,
        });
      } catch (e: any) {
        logger.error("empty-records account-suggestion failed", e);
        return c.json({ error: "An internal error occurred" }, 500);
      }
    },
  },
  {
    // Admin-gated: append the Empty-Delete tag (batched by 100). Never deletes.
    path: "/api/duplicates/empty-records/tag",
    method: "POST" as const,
    createHandler: async () => async (c: any) => {
      try {
        const { requireAdminOrKey, unauthorizedResponse: unauth } =
          await import("../../utils/rbacMiddleware");
        const su = await requireAdminOrKey(c);
        if (!su) return unauth(c);
        const body = await c.req.json().catch(() => ({}));
        const module = String(body?.module || "");
        const zohoIds: string[] = Array.isArray(body?.zohoIds)
          ? body.zohoIds.map((x: any) => String(x)).filter(Boolean)
          : [];
        if (!["Deals", "Accounts", "Contacts"].includes(module))
          return c.json({ error: "module must be Deals|Accounts|Contacts" }, 400);
        if (!zohoIds.length) return c.json({ error: "zohoIds required" }, 400);
        const tag = process.env.EMPTY_DELETE_TAG || "Empty-Delete";
        const { addZohoTags } = await import("../../utils/zohoCRM");
        const { markEmptyDeleteTagged } = await import(
          "../../utils/emptyRecordsDatabase"
        );
        let tagged = 0;
        for (let i = 0; i < zohoIds.length; i += 100) {
          const batch = zohoIds.slice(i, i + 100);
          await addZohoTags(module, batch, [tag]);
          // Record locally so the cleanup list drops them on the NEXT refresh,
          // without waiting for the slow full sync to re-pull the Zoho tag.
          await markEmptyDeleteTagged(module, batch, su?.email || null);
          tagged += batch.length;
        }
        return c.json({ success: true, tagged, tag });
      } catch (e: any) {
        logger.error("empty-records/tag failed", e);
        return c.json({ error: "An internal error occurred" }, 500);
      }
    },
  },
  {
    // Admin-gated undo: remove the Empty-Delete tag from the given records.
    path: "/api/duplicates/empty-records/untag",
    method: "POST" as const,
    createHandler: async () => async (c: any) => {
      try {
        const { requireAdminOrKey, unauthorizedResponse: unauth } =
          await import("../../utils/rbacMiddleware");
        const su = await requireAdminOrKey(c);
        if (!su) return unauth(c);
        const body = await c.req.json().catch(() => ({}));
        const module = String(body?.module || "");
        const zohoIds: string[] = Array.isArray(body?.zohoIds)
          ? body.zohoIds.map((x: any) => String(x)).filter(Boolean)
          : [];
        if (!["Deals", "Accounts", "Contacts"].includes(module))
          return c.json({ error: "module must be Deals|Accounts|Contacts" }, 400);
        if (!zohoIds.length) return c.json({ error: "zohoIds required" }, 400);
        const tag = process.env.EMPTY_DELETE_TAG || "Empty-Delete";
        const { unmarkEmptyDeleteTagged } = await import(
          "../../utils/emptyRecordsDatabase"
        );
        let untagged = 0;
        for (let i = 0; i < zohoIds.length; i += 100) {
          const batch = zohoIds.slice(i, i + 100);
          await removeZohoTags(module, batch, [tag]);
          await unmarkEmptyDeleteTagged(batch);
          untagged += batch.length;
        }
        return c.json({ success: true, untagged });
      } catch (e: any) {
        logger.error("empty-records/untag failed", e);
        return c.json({ error: "An internal error occurred" }, 500);
      }
    },
  },
  {
    // Admin-gated: Dismiss flagged records as "reviewed — keep, NOT empty"
    // (false positives, e.g. a deal that actually has data). They drop off the
    // cleanup list durably and never reappear. No Zoho write.
    path: "/api/duplicates/empty-records/dismiss",
    method: "POST" as const,
    createHandler: async () => async (c: any) => {
      try {
        const { requireAdminOrKey, unauthorizedResponse: unauth } =
          await import("../../utils/rbacMiddleware");
        const su = await requireAdminOrKey(c);
        if (!su) return unauth(c);
        const body = await c.req.json().catch(() => ({}));
        const module = String(body?.module || "");
        const undo = body?.undo === true;
        const zohoIds: string[] = Array.isArray(body?.zohoIds)
          ? body.zohoIds.map((x: any) => String(x)).filter(Boolean)
          : [];
        if (!["Deals", "Accounts", "Contacts"].includes(module))
          return c.json({ error: "module must be Deals|Accounts|Contacts" }, 400);
        if (!zohoIds.length) return c.json({ error: "zohoIds required" }, 400);
        const { markEmptyRecordsDismissed, undismissEmptyRecords } = await import(
          "../../utils/emptyRecordsDatabase"
        );
        if (undo) {
          await undismissEmptyRecords(zohoIds);
          return c.json({ success: true, undismissed: zohoIds.length });
        }
        await markEmptyRecordsDismissed(module, zohoIds, su?.email || null);
        return c.json({ success: true, dismissed: zohoIds.length });
      } catch (e: any) {
        logger.error("empty-records/dismiss failed", e);
        return c.json({ error: "An internal error occurred" }, 500);
      }
    },
  },
  {
    // Admin-gated: link an orphaned deal to an account (re-parent in Zoho).
    path: "/api/duplicates/empty-records/link-deal",
    method: "POST" as const,
    createHandler: async () => async (c: any) => {
      try {
        const { requireAdminOrKey, unauthorizedResponse: unauth } =
          await import("../../utils/rbacMiddleware");
        const su = await requireAdminOrKey(c);
        if (!su) return unauth(c);
        const body = await c.req.json().catch(() => ({}));
        const dealId = String(body?.dealId || "");
        const accountId = String(body?.accountId || "");
        if (!dealId || !accountId) return c.json({ error: "dealId and accountId required" }, 400);
        const { updateZohoRecord } = await import("../../utils/zohoCRM");
        await updateZohoRecord("Deals", dealId, { Account_Name: { id: accountId } });
        return c.json({ success: true });
      } catch (e: any) {
        logger.error("empty-records/link-deal failed", e);
        return c.json({ error: "An internal error occurred" }, 500);
      }
    },
  },
  {
    // Read-access: show every ledger row + counts for the "Tagged · pending delete"
    // sub-section.  No Zoho call; purely our own ledger.
    path: "/api/duplicates/empty-records/tagged-status",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      try {
        const user = await requireDuplicateRadarAccess(c);
        if (!user) return unauthorizedResponse(c);
        const module = c.req.query("module") || undefined;
        const { getTaggedStatus } = await import("../../utils/emptyRecordsDatabase");
        const result = await getTaggedStatus(module);
        return c.json({ success: true, ...result });
      } catch (e: any) {
        logger.error("empty-records/tagged-status failed", e);
        return c.json({ error: "An internal error occurred" }, 500);
      }
    },
  },
  {
    // Admin-gated: manually trigger the deletion-reconcile pass (also runs
    // automatically on every post-sync).  Checks pending_delete rows against
    // live Zoho; stamps ledger 'deleted' + prunes mirror when gone.
    path: "/api/duplicates/empty-records/recheck-deletions",
    method: "POST" as const,
    createHandler: async () => async (c: any) => {
      try {
        const { requireAdminOrKey, unauthorizedResponse: unauth } =
          await import("../../utils/rbacMiddleware");
        const su = await requireAdminOrKey(c);
        if (!su) return unauth(c);
        const body = await c.req.json().catch(() => ({}));
        const module = body?.module ? String(body.module) : undefined;
        const { reconcileEmptyDeleteDeletions } = await import("../../utils/emptyRecordsDatabase");
        const r = await reconcileEmptyDeleteDeletions(module);
        return c.json({ success: true, ...r });
      } catch (e: any) {
        logger.error("empty-records/recheck-deletions failed", e);
        return c.json({ error: "An internal error occurred" }, 500);
      }
    },
  },
  {
    // Admin-gated: AI-Apply batch — verify each empty candidate against Zoho
    // (prune ghosts, skip docs/protected stages), then tag survivors Empty-Delete.
    // Never deletes in Zoho; the admin removes tagged records.
    path: "/api/duplicates/empty-records/ai-apply",
    method: "POST" as const,
    createHandler: async () => async (c: any) => {
      try {
        const { requireAdminOrKey, unauthorizedResponse: unauth } =
          await import("../../utils/rbacMiddleware");
        const su = await requireAdminOrKey(c);
        if (!su) return unauth(c);
        const body = await c.req.json().catch(() => ({}));
        const module = String(body?.module || "");
        if (!["Deals", "Accounts", "Contacts"].includes(module))
          return c.json({ error: "module must be Deals|Accounts|Contacts" }, 400);
        const limit =
          Number.isFinite(body?.limit) && body.limit > 0
            ? Math.floor(body.limit)
            : undefined;
        const { aiApplyEmptyDelete } = await import("../../utils/emptyRecordsDatabase");
        const AGENT =
          "Adam — GRQ Assistant (on behalf of " + (su?.email || "operator") + ")";
        const r = await aiApplyEmptyDelete(
          module as "Deals" | "Accounts" | "Contacts",
          { limit, by: AGENT },
        );
        return c.json({ success: true, ...r });
      } catch (e: any) {
        logger.error("empty-records/ai-apply failed", e);
        return c.json({ error: "An internal error occurred" }, 500);
      }
    },
  },
  {
    // Admin-gated: live-verify the ids the operator currently sees on a page
    // against Zoho (the same gate AI-Apply uses) WITHOUT tagging — confirms which
    // are genuinely empty, auto-Dismisses any that turn out to have deals/contacts,
    // and prunes ghosts. Bounded by the caller to one visible page.
    path: "/api/duplicates/empty-records/verify-page",
    method: "POST" as const,
    createHandler: async () => async (c: any) => {
      try {
        const { requireAdminOrKey, unauthorizedResponse: unauth } =
          await import("../../utils/rbacMiddleware");
        const su = await requireAdminOrKey(c);
        if (!su) return unauth(c);
        const body = await c.req.json().catch(() => ({}));
        const module = String(body?.module || "");
        if (!["Deals", "Accounts", "Contacts"].includes(module))
          return c.json({ error: "module must be Deals|Accounts|Contacts" }, 400);
        const zohoIds = Array.isArray(body?.zohoIds)
          ? body.zohoIds.map((x: any) => String(x)).filter(Boolean).slice(0, 100)
          : [];
        if (!zohoIds.length) return c.json({ error: "zohoIds required" }, 400);
        const { verifyEmptyCandidates } = await import("../../utils/emptyRecordsDatabase");
        const AGENT =
          "Adam — GRQ Assistant (on behalf of " + (su?.email || "operator") + ")";
        const r = await verifyEmptyCandidates(
          module as "Deals" | "Accounts" | "Contacts",
          zohoIds,
          AGENT,
        );
        return c.json({ success: true, ...r });
      } catch (e: any) {
        logger.error("empty-records/verify-page failed", e);
        return c.json({ error: "An internal error occurred" }, 500);
      }
    },
  },
];

export default duplicateRadarRoutes;
