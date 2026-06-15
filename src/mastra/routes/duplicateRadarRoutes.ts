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
  cleanupStaleRecords,
  cleanupOrphanClusters,
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
  completedAt: null,
  result: null,
  error: null,
  moduleStatuses: {},
  recordCounts: {},
  percentage: 0,
};

// SSE listeners for C1: real-time progress
let sseClients: Array<{
  id: string;
  controller: ReadableStreamDefaultController;
}> = [];

function broadcastSSE(event: string, data: any) {
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
): Promise<{ count: number; written: number; skipped: number }> {
  let records: any[] = [];
  scanState.moduleStatuses[moduleName] = "fetching";
  broadcastSSE("module", { module: moduleName, status: "fetching" });

  try {
    await upsertSyncState(moduleName, 0, "syncing");
    records = await fetchAllZohoRecords(moduleName, {
      maxRecords: SCAN_MAX_PER_MODULE,
      ifModifiedSince,
    });
  } catch (e: any) {
    logger.error(`Error fetching ${moduleName}:`, e);
    scanState.moduleStatuses[moduleName] = "error";
    broadcastSSE("module", { module: moduleName, status: "error" });
    await upsertSyncState(moduleName, 0, "failed");
    // If Zoho's OAuth endpoint is in its per-account "too many requests"
    // cooldown, every module will fail for the same reason. Bubble the
    // error so the outer scan catch can fail the whole run with a clear
    // message instead of silently "completing" with 0 records / 0 clusters
    // (which is what was making the dashboard tabs look empty while the
    // header progress bar appeared to finish successfully).
    if (e?.isZohoRateLimited || /too many requests/i.test(String(e?.message || ""))) {
      throw e;
    }
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

  let written = 0;
  let skipped = 0;
  let droppedNoCompany = 0;
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
  broadcastSSE("module", {
    module: moduleName,
    status: "done",
    count: written,
  });
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
  logger.info(
    `🔍 [DuplicateRadar] Starting Zoho CRM duplicate scan (${detectionType})...`,
  );

  scanState.status = "scanning";
  scanState.startedAt = startTime;
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
    const SCAN_MODULES = ["Leads", "Deals", "Contacts", "Accounts"] as const;
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

    // B3: Parallel module fetch
    scanState.progress = incremental
      ? "Fetching changed records from Zoho CRM..."
      : "Fetching all modules from Zoho CRM in parallel...";
    scanState.percentage = 10;
    broadcastSSE("progress", {
      percentage: 10,
      message: incremental ? "Fetching changed records..." : "Fetching all modules...",
    });

    const [leadsResult, dealsResult, contactsResult, accountsResult] =
      await Promise.all([
        processModule("Leads", "lead", clustersUpdated, (record) => {
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
        }, sinceFor("Leads")),
        processModule("Deals", "deal", clustersUpdated, (record) => {
          const d = record.data;
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
            zohoModule: "Deals",
            pipeline: d.Pipeline || "",
            products: d.Product_Details
              ? JSON.stringify(d.Product_Details)
              : "",
            contactName: d.Contact_Name?.name || "",
            accountName: d.Account_Name?.name || "",
          };
        }, sinceFor("Deals")),
        processModule("Contacts", "contact", clustersUpdated, (record) => {
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
        }, sinceFor("Contacts")),
        processModule("Accounts", "account", clustersUpdated, (record) => {
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
        }, sinceFor("Accounts")),
      ]);

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
    let processed = 0;
    for (const clusterId of clustersUpdated) {
      await updateClusterStats(clusterId);
      processed++;
      if (processed % 200 === 0) {
        const pct = 70 + Math.round((processed / clustersUpdated.size) * 25);
        scanState.progress = `Scoring clusters: ${processed}/${clustersUpdated.size}...`;
        scanState.percentage = pct;
        broadcastSSE("progress", {
          percentage: pct,
          message: `Scoring: ${processed}/${clustersUpdated.size}`,
        });
        logger.info(
          `  📊 Updated ${processed}/${clustersUpdated.size} clusters...`,
        );
      }
    }

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

    scanState.status = "completed";
    scanState.completedAt = Date.now();
    scanState.progress = `Complete: ${totalRecords} records scanned, ${summary.trueDuplicateClusters} duplicate clusters found`;
    scanState.result = resultData;
    scanState.percentage = 100;

    broadcastSSE("scan", { status: "completed", result: resultData });

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

    scanState.status = "failed";
    scanState.completedAt = Date.now();
    scanState.progress = rateLimited
      ? "Scan failed — Zoho rate-limited"
      : "Scan failed";
    scanState.error = userMessage;
    scanState.result = errorResult;

    broadcastSSE("scan", { status: "failed", error: scanState.error });

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
          return c.json({
            total: byRecord.length,
            deleted,
            alive,
            errors,
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
          return c.json({ ...tally, truncated, totalInCluster: records.length, byRecord: out });
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
          return c.json({ ...summary, kpis, lastScanDate: lastScan });
        } catch (error: any) {
          logger.error("Error fetching summary:", error);
          return c.json({ error: "An internal error occurred" }, 500);
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
          const report = await executeMergePlan(plan, {
            performedBy:
              (sessionUser as any)?.email ||
              (sessionUser as any)?.role ||
              "admin",
            dryRun,
            closeCluster: !isCrossModule,
          });

          // Learning loop — record what the agent proposed vs. what the
          // operator chose + the outcome, so the agent learns the org's real
          // preferences over time. Proposed survivor = the planner's unbiased
          // default (rebuilt without the override). Best-effort, never blocks.
          try {
            const proposedMasterZohoId = masterZohoId
              ? buildMergePlan(module, id, records, {
                  tagName: "Duplicate-Delete",
                  includeZohoIds,
                }).masterZohoId
              : plan.masterZohoId;
            await recordResolutionEvent({
              clusterId: id,
              eventType: dryRun ? "dry_run" : "applied",
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

          // (Apply notifications are batched into the twice-daily Slack digest
          // at 09:00 / 17:00 KSA — see resolution-digest cron.)

          return c.json({ success: true, dryRun, plan, report });
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

          if (scanState.status === "scanning") {
            return c.json(
              {
                success: false,
                error: "A scan is already in progress",
                progress: scanState.progress,
                startedAt: scanState.startedAt,
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
    path: "/api/duplicates/rebuild",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          if (scanState.status === "scanning") {
            return c.json(
              {
                success: false,
                error: "A scan is already in progress",
                progress: scanState.progress,
                startedAt: scanState.startedAt,
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
            !["resolve", "ignore"].includes(action)
          ) {
            return c.json(
              {
                error:
                  "cluster_ids (array) and action (resolve/ignore) required",
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

              if (!domain) continue;

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
          const csvLines = ["domain,company_name,email,phone"];
          for (const r of rows) {
            const quote = (s: string) =>
              s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
            csvLines.push(
              `${r.domain},${quote(r.company_name)},${quote(r.email)},${quote(r.phone)}`,
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
];

export default duplicateRadarRoutes;
