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
  extractDomain,
  normalizePhone,
  resolveCluster,
  bulkResolve,
  getMergeHistory,
  markPrimaryRecord,
  getOwnerAccountability,
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
} from "../../utils/zohoCRM";

import { logger } from "../../utils/logger";
const SCAN_MAX_PER_MODULE = parseInt(
  process.env.DUPLICATE_SCAN_LIMIT || "5000",
);

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

async function processModule(
  moduleName: string,
  recordType: "lead" | "deal" | "contact" | "account",
  clustersUpdated: Set<number>,
  extractRecord: (record: any) => ExtractedRecord,
): Promise<{ count: number }> {
  let records: any[] = [];
  scanState.moduleStatuses[moduleName] = "fetching";
  broadcastSSE("module", { module: moduleName, status: "fetching" });

  try {
    await upsertSyncState(moduleName, 0, "syncing");
    records = await fetchAllZohoRecords(moduleName, {
      maxRecords: SCAN_MAX_PER_MODULE,
    });
  } catch (e) {
    logger.error(`Error fetching ${moduleName}:`, e);
    scanState.moduleStatuses[moduleName] = "error";
    broadcastSSE("module", { module: moduleName, status: "error" });
    await upsertSyncState(moduleName, 0, "failed");
    return { count: 0 };
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

  let skipped = 0;
  for (const record of records) {
    try {
      const data = extractRecord(record);
      if (!data.companyName || data.companyName === "Unknown") continue;

      const cluster = await findOrCreateClusterByCompany(
        data.companyName,
        data.domain || undefined,
        data.phone || undefined,
        data.email || undefined,
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

      clustersUpdated.add(cluster.id!);
    } catch (recordErr) {
      skipped++;
      if (skipped <= 5)
        logger.warn(
          `⚠️ [DuplicateRadar] Skipped ${moduleName} record ${record.id}: ${recordErr}`,
        );
    }
  }
  if (skipped > 0)
    logger.warn(
      `⚠️ [DuplicateRadar] Skipped ${skipped} ${moduleName} records due to errors`,
    );

  scanState.moduleStatuses[moduleName] = "done";
  broadcastSSE("module", {
    module: moduleName,
    status: "done",
    count: records.length,
  });
  await upsertSyncState(moduleName, records.length, "completed");
  return { count: records.length };
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
  detectionType: "manual" | "scheduled" = "manual",
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
    scanState.progress = "Preparing incremental scan...";
    scanState.percentage = 5;
    await clearAllDuplicateData();

    const moduleBreakdown: any[] = [];
    let totalRecords = 0;
    const clustersUpdated = new Set<number>();

    // B3: Parallel module fetch
    scanState.progress = "Fetching all modules from Zoho CRM in parallel...";
    scanState.percentage = 10;
    broadcastSSE("progress", {
      percentage: 10,
      message: "Fetching all modules...",
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
        }),
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
        }),
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
        }),
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
        }),
      ]);

    // Tasks pagination removed per platform-wide Tasks data removal.
    totalRecords =
      leadsResult.count +
      dealsResult.count +
      contactsResult.count +
      accountsResult.count;
    moduleBreakdown.push(
      { module: "Leads", count: leadsResult.count },
      { module: "Deals", count: dealsResult.count },
      { module: "Contacts", count: contactsResult.count },
      { module: "Accounts", count: accountsResult.count },
    );

    scanState.percentage = 60;
    broadcastSSE("progress", {
      percentage: 60,
      message: `All modules fetched (${totalRecords} records)`,
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
      error: "An internal error occurred",
    };

    scanState.status = "failed";
    scanState.completedAt = Date.now();
    scanState.progress = "Scan failed";
    scanState.error = error?.message || "An internal error occurred";
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

          const sort = url.searchParams.get("sort") || undefined;
          const dir = url.searchParams.get("dir") || undefined;

          const filters = {
            status: status || undefined,
            confidence_level: confidence_level || undefined,
            start_date,
            end_date,
            hide_hierarchies: !include_hierarchies,
            layouts,
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
          const limit = limitRaw ? parseInt(limitRaw, 10) : 200;
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

          const { getCrossModuleOverlaps } = await import(
            "../../utils/duplicateRadarDatabase"
          );
          const result = await getCrossModuleOverlaps({
            limit: Number.isFinite(limit) ? limit : 200,
            pairing,
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
            { success: false, error: "An internal error occurred" },
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

          scanZohoCRMForDuplicates("manual").catch((err) => {
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
          const start_date = url.searchParams.get("start_date") || undefined;
          const end_date = url.searchParams.get("end_date") || undefined;

          const result = await getDuplicateRecordsByType("lead", {
            limit,
            offset,
            start_date,
            end_date,
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
          const start_date = url.searchParams.get("start_date") || undefined;
          const end_date = url.searchParams.get("end_date") || undefined;

          const result = await getDuplicateRecordsByType("deal", {
            limit,
            offset,
            start_date,
            end_date,
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
          const start_date = url.searchParams.get("start_date") || undefined;
          const end_date = url.searchParams.get("end_date") || undefined;

          const result = await getDuplicateRecordsByType("contact", {
            limit,
            offset,
            start_date,
            end_date,
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
          const start_date = url.searchParams.get("start_date") || undefined;
          const end_date = url.searchParams.get("end_date") || undefined;

          const result = await getDuplicateRecordsByType("account", {
            limit,
            offset,
            start_date,
            end_date,
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

          if (!action || !["resolve", "ignore"].includes(action)) {
            return c.json(
              { error: 'action must be "resolve" or "ignore"' },
              400,
            );
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

          const { verifyClusterMergedInZoho } = await import(
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

          return c.json({
            success: true,
            merge_action: mergeAction,
            verification,
            cluster_status: verification.verified ? "resolved" : "active",
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
