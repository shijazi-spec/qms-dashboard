import { join } from "path";
import { readFileSync, existsSync } from "fs";

import {
  initDuplicateRadarTables,
  getAllClusters,
  getClusterCount,
  getClusterById,
  getRecordsByClusterId,
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
  updateClusterStats,
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
  getSyncState,
  getAllSyncStates,
  upsertSyncState,
  getDistinctOwners,
  getDistinctLayouts,
  getDistinctDomains,
  getDistinctPipelines,
  getDistinctProducts,
  getFilteredClusters,
  getFilteredSummary,
  upsertTask,
  getTasksForRecords,
  getTaskCountForCluster,
} from '../../utils/duplicateRadarDatabase';

import type { DuplicateFilters } from '../../utils/duplicateRadarDatabase';

import { fetchAllZohoRecords, fetchDeletedZohoRecords } from '../../utils/zohoCRM';

const SCAN_MAX_PER_MODULE = parseInt(process.env.DUPLICATE_SCAN_LIMIT || '5000');

interface ScanState {
  status: 'idle' | 'scanning' | 'completed' | 'failed';
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
  status: 'idle',
  progress: '',
  startedAt: null,
  completedAt: null,
  result: null,
  error: null,
  moduleStatuses: {},
  recordCounts: {},
  percentage: 0,
};

// SSE listeners for C1: real-time progress
let sseClients: Array<{ id: string; controller: ReadableStreamDefaultController }> = [];

function broadcastSSE(event: string, data: any) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients = sseClients.filter(client => {
    try {
      client.controller.enqueue(new TextEncoder().encode(msg));
      return true;
    } catch {
      return false;
    }
  });
}

interface ExtractedRecord {
  companyName: string; email: string; phone: string; recordName: string;
  domain: string | null; ownerName: string; ownerEmail: string; status: string;
  stage?: string; dealValue?: number; source: string; createdTime: string; modifiedTime: string;
  layoutName?: string; layoutId?: string; zohoModule?: string; pipeline?: string;
  products?: string; mobile?: string; contactName?: string; accountName?: string;
  crNumber?: string; vatNumber?: string; website?: string; country?: string;
  region?: string; industry?: string; noOfEmployees?: number; title?: string;
  leadType?: string; govType?: string; accountType?: string;
}

async function processModule(
  moduleName: string,
  recordType: 'lead' | 'deal' | 'contact' | 'account',
  clustersUpdated: Set<number>,
  extractRecord: (record: any) => ExtractedRecord
): Promise<{ count: number }> {
  let records: any[] = [];
  scanState.moduleStatuses[moduleName] = 'fetching';
  broadcastSSE('module', { module: moduleName, status: 'fetching' });

  try {
    await upsertSyncState(moduleName, 0, 'syncing');
    records = await fetchAllZohoRecords(moduleName, { maxRecords: SCAN_MAX_PER_MODULE });
  } catch (e) {
    console.error(`Error fetching ${moduleName}:`, e);
    scanState.moduleStatuses[moduleName] = 'error';
    broadcastSSE('module', { module: moduleName, status: 'error' });
    await upsertSyncState(moduleName, 0, 'failed');
    return { count: 0 };
  }

  console.log(`📥 [DuplicateRadar] Fetched ${records.length} ${moduleName} from Zoho`);
  scanState.moduleStatuses[moduleName] = 'processing';
  scanState.recordCounts[moduleName] = records.length;
  broadcastSSE('module', { module: moduleName, status: 'processing', count: records.length });

  let skipped = 0;
  for (const record of records) {
    try {
      const data = extractRecord(record);
      if (!data.companyName || data.companyName === 'Unknown') continue;

      const cluster = await findOrCreateClusterByCompany(
        data.companyName, data.domain || undefined, data.phone || undefined, data.email || undefined
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
        created_date: data.createdTime ? new Date(data.createdTime) : new Date(),
        modified_date: data.modifiedTime ? new Date(data.modifiedTime) : new Date(),
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
      if (skipped <= 5) console.warn(`⚠️ [DuplicateRadar] Skipped ${moduleName} record ${record.id}: ${recordErr}`);
    }
  }
  if (skipped > 0) console.warn(`⚠️ [DuplicateRadar] Skipped ${skipped} ${moduleName} records due to errors`);

  scanState.moduleStatuses[moduleName] = 'done';
  broadcastSSE('module', { module: moduleName, status: 'done', count: records.length });
  await upsertSyncState(moduleName, records.length, 'completed');
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
    { name: 'Leads' },
    { name: 'Deals' },
    { name: 'Contacts' },
    { name: 'Accounts' },
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
      const deleted = await fetchDeletedZohoRecords(m.name, { type: 'all', modifiedSince: since });
      if (deleted.length === 0) {
        perModule[m.name] = 0;
        continue;
      }
      const ids = deleted.map(d => d.id).filter(Boolean);
      const { removedCount, affectedClusterIds } = await removeRecordsByZohoIds(ids, { module: m.name });
      affectedClusterIds.forEach(id => clustersUpdated.add(id));
      perModule[m.name] = removedCount;
      totalRemoved += removedCount;
    } catch (e: any) {
      console.warn(`⚠️ [DuplicateRadar] Deletion detection failed for ${m.name} (non-fatal):`, e?.message || e);
      perModule[m.name] = 0;
    }
  }
  return { totalRemoved, perModule };
}

async function scanZohoCRMForDuplicates(detectionType: 'manual' | 'scheduled' = 'manual'): Promise<{
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
  console.log(`🔍 [DuplicateRadar] Starting Zoho CRM duplicate scan (${detectionType})...`);

  scanState.status = 'scanning';
  scanState.startedAt = startTime;
  scanState.progress = 'Initializing scan...';
  scanState.result = null;
  scanState.error = null;
  scanState.moduleStatuses = { Leads: 'pending', Deals: 'pending', Contacts: 'pending', Accounts: 'pending' };
  scanState.recordCounts = {};
  scanState.percentage = 0;

  broadcastSSE('scan', { status: 'started', timestamp: startTime });

  try {
    scanState.progress = 'Preparing incremental scan...';
    scanState.percentage = 5;
    await clearAllDuplicateData();

    const moduleBreakdown: any[] = [];
    let totalRecords = 0;
    const clustersUpdated = new Set<number>();

    // B3: Parallel module fetch
    scanState.progress = 'Fetching all modules from Zoho CRM in parallel...';
    scanState.percentage = 10;
    broadcastSSE('progress', { percentage: 10, message: 'Fetching all modules...' });

    const [leadsResult, dealsResult, contactsResult, accountsResult] = await Promise.all([
      processModule('Leads', 'lead', clustersUpdated, (record) => {
        const d = record.data;
        return {
          companyName: d.Company || d.Last_Name || 'Unknown',
          email: d.Email || '',
          phone: d.Phone || '',
          mobile: d.Mobile || '',
          recordName: d.Full_Name || `${d.First_Name || ''} ${d.Last_Name || ''}`.trim(),
          domain: extractDomain(d.Email || ''),
          ownerName: d.Owner?.name || 'Unknown',
          ownerEmail: d.Owner?.email || '',
          status: d.Lead_Status || '',
          source: d.Lead_Source || '',
          createdTime: d.Created_Time || '',
          modifiedTime: d.Modified_Time || '',
          layoutName: d.Layout?.name || d.$layout?.name || '',
          layoutId: d.Layout?.id || d.$layout?.id || '',
          zohoModule: 'Leads',
          title: d.Designation || d.Title || '',
          leadType: d.Lead_Type || '',
          country: d.Country || '',
          industry: d.Industry || '',
          website: d.Website || '',
        };
      }),
      processModule('Deals', 'deal', clustersUpdated, (record) => {
        const d = record.data;
        return {
          companyName: d.Account_Name?.name || d.Deal_Name || 'Unknown',
          email: d.Contact_Email || '',
          phone: d.Contact_Phone || '',
          recordName: d.Deal_Name || 'Unknown Deal',
          domain: extractDomain(d.Contact_Email || ''),
          ownerName: d.Owner?.name || 'Unknown',
          ownerEmail: d.Owner?.email || '',
          status: '',
          stage: d.Stage || '',
          dealValue: parseFloat(d.Amount) || 0,
          source: d.Lead_Source || '',
          createdTime: d.Created_Time || '',
          modifiedTime: d.Modified_Time || '',
          layoutName: d.Layout?.name || d.$layout?.name || '',
          layoutId: d.Layout?.id || d.$layout?.id || '',
          zohoModule: 'Deals',
          pipeline: d.Pipeline || '',
          products: d.Product_Details ? JSON.stringify(d.Product_Details) : '',
          contactName: d.Contact_Name?.name || '',
          accountName: d.Account_Name?.name || '',
        };
      }),
      processModule('Contacts', 'contact', clustersUpdated, (record) => {
        const d = record.data;
        return {
          companyName: d.Account_Name?.name || d.Company || d.Last_Name || 'Unknown',
          email: d.Email || '',
          phone: d.Phone || '',
          mobile: d.Mobile || '',
          recordName: d.Full_Name || `${d.First_Name || ''} ${d.Last_Name || ''}`.trim(),
          domain: extractDomain(d.Email || ''),
          ownerName: d.Owner?.name || 'Unknown',
          ownerEmail: d.Owner?.email || '',
          status: 'Contact',
          source: d.Lead_Source || '',
          createdTime: d.Created_Time || '',
          modifiedTime: d.Modified_Time || '',
          layoutName: d.Layout?.name || d.$layout?.name || '',
          layoutId: d.Layout?.id || d.$layout?.id || '',
          zohoModule: 'Contacts',
          title: d.Title || '',
          accountName: d.Account_Name?.name || '',
          country: d.Mailing_Country || d.Other_Country || '',
        };
      }),
      processModule('Accounts', 'account', clustersUpdated, (record) => {
        const d = record.data;
        const websiteRaw = d.Website || '';
        const websiteDomain = websiteRaw.replace(/^https?:\/\/(www\.)?/, '').split('/')[0] || '';
        return {
          companyName: d.Account_Name || 'Unknown',
          email: d.Email || '',
          phone: d.Phone || '',
          recordName: d.Account_Name || 'Unknown',
          domain: extractDomain(d.Email || '') || (websiteDomain && !websiteDomain.includes(' ') ? websiteDomain : null),
          ownerName: d.Owner?.name || 'Unknown',
          ownerEmail: d.Owner?.email || '',
          status: 'Account',
          source: 'Account',
          createdTime: d.Created_Time || '',
          modifiedTime: d.Modified_Time || '',
          layoutName: d.Layout?.name || d.$layout?.name || '',
          layoutId: d.Layout?.id || d.$layout?.id || '',
          zohoModule: 'Accounts',
          website: websiteRaw,
          crNumber: d.CR_Number || d.Registration_Number || '',
          vatNumber: d.VAT_Number || d.Tax_ID || '',
          country: d.Billing_Country || d.Shipping_Country || '',
          region: d.Billing_State || d.Shipping_State || '',
          industry: d.Industry || '',
          noOfEmployees: parseInt(d.Employees) || undefined,
          accountType: d.Account_Type || '',
        };
      })
    ]);

    scanState.percentage = 55;
    broadcastSSE('progress', { percentage: 55, message: 'Syncing Tasks from Zoho...' });
    scanState.progress = 'Syncing Tasks from Zoho CRM...';

    try {
      const tasks = await fetchAllZohoRecords('Tasks', { maxRecords: SCAN_MAX_PER_MODULE });
      let tasksSynced = 0;
      for (const task of tasks) {
        const td = task.data;
        const relatedId = td.What_Id?.id || td.Who_Id?.id || '';
        if (!relatedId) continue;
        await upsertTask({
          zoho_task_id: task.id,
          related_record_id: relatedId,
          subject: td.Subject || '',
          due_date: td.Due_Date ? new Date(td.Due_Date) : undefined,
          status: td.Status || '',
          owner_name: td.Owner?.name || '',
          description: td.Description || '',
        });
        tasksSynced++;
      }
      console.log(`📋 [DuplicateRadar] Synced ${tasksSynced} Tasks from Zoho`);
      await upsertSyncState('Tasks', tasksSynced, 'completed');
    } catch (e) {
      console.warn('⚠️ [DuplicateRadar] Tasks sync failed (non-fatal):', e);
      await upsertSyncState('Tasks', 0, 'failed');
    }

    totalRecords = leadsResult.count + dealsResult.count + contactsResult.count + accountsResult.count;
    moduleBreakdown.push(
      { module: 'Leads', count: leadsResult.count },
      { module: 'Deals', count: dealsResult.count },
      { module: 'Contacts', count: contactsResult.count },
      { module: 'Accounts', count: accountsResult.count }
    );

    scanState.percentage = 60;
    broadcastSSE('progress', { percentage: 60, message: `All modules fetched (${totalRecords} records)` });

    // Deletion-detection pass: ask Zoho which records were deleted/merged
    // since our last sync and purge them locally. This is what makes a
    // manual Zoho merge propagate into the duplicate radar.
    const scanMode = process.env.DUPLICATE_SCAN_MODE || 'incremental';
    scanState.progress = 'Checking Zoho for deleted/merged records...';
    broadcastSSE('progress', { percentage: 62, message: 'Checking Zoho for deletions...' });
    const deletionResult = await runDeletionDetection(clustersUpdated);
    if (deletionResult.totalRemoved > 0) {
      console.log(
        `🗑️ [DuplicateRadar] Deletion-detection removed ${deletionResult.totalRemoved} record(s):`,
        deletionResult.perModule,
      );
      broadcastSSE('progress', {
        percentage: 65,
        message: `Removed ${deletionResult.totalRemoved} deleted/merged Zoho records`,
      });
    }

    // Cleanup stale records (legacy, mostly a no-op now) and orphan clusters
    if (scanMode !== 'full') {
      scanState.progress = 'Cleaning up orphan clusters...';
      await cleanupStaleRecords();
      await cleanupOrphanClusters();
    }

    scanState.percentage = 70;

    scanState.progress = `All modules fetched (${totalRecords} records). Scoring ${clustersUpdated.size} clusters...`;
    console.log(`📊 [DuplicateRadar] Updating stats for ${clustersUpdated.size} clusters...`);
    let processed = 0;
    for (const clusterId of clustersUpdated) {
      await updateClusterStats(clusterId);
      processed++;
      if (processed % 200 === 0) {
        const pct = 70 + Math.round((processed / clustersUpdated.size) * 25);
        scanState.progress = `Scoring clusters: ${processed}/${clustersUpdated.size}...`;
        scanState.percentage = pct;
        broadcastSSE('progress', { percentage: pct, message: `Scoring: ${processed}/${clustersUpdated.size}` });
        console.log(`  📊 Updated ${processed}/${clustersUpdated.size} clusters...`);
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
      triggered_by: detectionType === 'scheduled' ? 'Automated Weekly Scan' : 'Zoho CRM Scan',
      status: 'completed',
      completed_at: new Date()
    });

    console.log(`✅ [DuplicateRadar] Scan complete: ${totalRecords} records, ${summary.trueDuplicateClusters} true duplicate clusters, ${summary.highConfidence} high confidence`);

    const resultData = {
      success: true,
      totalRecordsScanned: totalRecords,
      totalClustersFound: clustersUpdated.size,
      duplicatesDetected: summary.trueDuplicateClusters,
      highConfidence: summary.highConfidence,
      mediumConfidence: summary.mediumConfidence,
      moduleBreakdown,
      pipelineInflation: summary.estimatedPipelineInflation,
      durationMs: duration
    };

    scanState.status = 'completed';
    scanState.completedAt = Date.now();
    scanState.progress = `Complete: ${totalRecords} records scanned, ${summary.trueDuplicateClusters} duplicate clusters found`;
    scanState.result = resultData;
    scanState.percentage = 100;

    broadcastSSE('scan', { status: 'completed', result: resultData });

    return resultData;

  } catch (error: any) {
    console.error('❌ [DuplicateRadar] Scan error:', error);
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
      error: 'An internal error occurred'
    };

    scanState.status = 'failed';
    scanState.completedAt = Date.now();
    scanState.progress = 'Scan failed';
    scanState.error = error?.message || 'An internal error occurred';
    scanState.result = errorResult;

    broadcastSSE('scan', { status: 'failed', error: scanState.error });

    return errorResult;
  }
}

export { scanZohoCRMForDuplicates };

initDuplicateRadarTables().catch(err => {
  console.error('Failed to initialize duplicate radar tables:', err);
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
          console.error("Error serving Duplicate Radar dashboard:", error);
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
          const summary = await getEnhancedSummary();
          const kpis = await getKPIMetrics();
          const lastScan = await getLastScanDate();
          return c.json({ ...summary, kpis, lastScanDate: lastScan });
        } catch (error: any) {
          console.error('Error fetching summary:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
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
          const url = new URL(c.req.url);
          const limit = parseInt(url.searchParams.get('limit') || '500');
          const offset = parseInt(url.searchParams.get('offset') || '0');
          const rows = await getAllClustersByInflation({ limit, offset });
          return c.json({ clusters: rows, total: rows.length, limit, offset });
        } catch (error: any) {
          console.error('Error fetching clusters by inflation:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
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
          const signal = c.req.param('signal');
          if (!signal) return c.json({ error: 'signal is required' }, 400);
          const url = new URL(c.req.url);
          const limit = parseInt(url.searchParams.get('limit') || '500');
          const offset = parseInt(url.searchParams.get('offset') || '0');
          const rows = await getClustersBySignal(signal, { limit, offset });
          return c.json({ signal, clusters: rows, total: rows.length, limit, offset });
        } catch (error: any) {
          console.error('Error fetching clusters by signal:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
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
          const url = new URL(c.req.url);
          const status = url.searchParams.get('status');
          const confidence_level = url.searchParams.get('confidence_level');
          const limit = parseInt(url.searchParams.get('limit') || '30');
          const offset = parseInt(url.searchParams.get('offset') || '0');
          const start_date = url.searchParams.get('start_date') || undefined;
          const end_date = url.searchParams.get('end_date') || undefined;
          // Hide legitimate parent-child hierarchies (e.g. 1 account + N contacts/deals)
          // by default. Pass ?include_hierarchies=true to see them.
          const include_hierarchies = url.searchParams.get('include_hierarchies') === 'true';
          const layoutsParam = url.searchParams.get('layouts');
          const layouts = layoutsParam
            ? layoutsParam.split(',').map(s => s.trim()).filter(Boolean)
            : undefined;

          const filters = {
            status: status || undefined,
            confidence_level: confidence_level || undefined,
            start_date,
            end_date,
            hide_hierarchies: !include_hierarchies,
            layouts,
          };

          const [clusters, total] = await Promise.all([
            getAllClusters({ ...filters, limit, offset }),
            getClusterCount(filters)
          ]);

          return c.json({ clusters, total, limit, offset, pages: Math.ceil(total / limit) });
        } catch (error: any) {
          console.error('Error fetching clusters:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
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
          const id = parseInt(c.req.param('id'));
          if (isNaN(id)) return c.json({ error: 'Invalid cluster ID' }, 400);
          const cluster = await getClusterById(id);
          if (!cluster) {
            return c.json({ error: 'Cluster not found' }, 404);
          }
          const records = await getRecordsByClusterId(id);
          const recommendations = generateSmartRecommendations(records);
          const meta = getClusterRecordTypeMeta(records);
          return c.json({
            cluster,
            records,
            recommendations,
            primary_type: meta.primary_type,
            is_cross_module: meta.is_cross_module,
            record_types: meta.record_types,
          });
        } catch (error: any) {
          console.error('Error fetching cluster:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
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
          const id = parseInt(c.req.param('id'));
          if (isNaN(id)) return c.json({ error: 'Invalid cluster ID' }, 400);
          const { status } = await c.req.json();
          
          if (!['active', 'resolved', 'ignored'].includes(status)) {
            return c.json({ error: 'Invalid status' }, 400);
          }

          const cluster = await updateClusterStatus(id, status);
          if (!cluster) {
            return c.json({ error: 'Cluster not found' }, 404);
          }

          return c.json({ success: true, cluster });
        } catch (error: any) {
          console.error('Error updating cluster status:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
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
          const data = await getDuplicatesByOwner();
          return c.json({ owners: data });
        } catch (error: any) {
          console.error('Error fetching by owner:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
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
          const data = await getDuplicatesBySource();
          return c.json({ sources: data });
        } catch (error: any) {
          console.error('Error fetching by source:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
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
          const kpis = await getKPIMetrics();
          return c.json(kpis);
        } catch (error: any) {
          console.error('Error fetching KPIs:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
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
          const url = new URL(c.req.url);
          const limit = parseInt(url.searchParams.get('limit') || '50');
          const logs = await getDetectionLogs(limit);
          return c.json({ logs });
        } catch (error: any) {
          console.error('Error fetching logs:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
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
          const url = new URL(c.req.url);
          const query = url.searchParams.get('query') || '';
          const record_type = url.searchParams.get('type') as 'lead' | 'deal' | 'all' || 'all';
          const limit = parseInt(url.searchParams.get('limit') || '50');
          const offset = parseInt(url.searchParams.get('offset') || '0');

          console.log(`🔍 [DuplicateRadar] Search query: "${query}", type: ${record_type}`);

          const searchParams = {
            company_name: query,
            domain: query,
            email: query.includes('@') ? query : undefined,
            record_type: record_type === 'all' ? undefined : record_type,
            limit,
            offset
          };

          const results = await searchDuplicates(searchParams);
          
          return c.json({
            success: true,
            query,
            records: results.records,
            clusters: results.clusters,
            total: results.total_records
          });
        } catch (error: any) {
          console.error('Error searching duplicates:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
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
          const { requireAdminOrKey, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          if (scanState.status === 'scanning') {
            return c.json({
              success: false,
              error: 'A scan is already in progress',
              progress: scanState.progress,
              startedAt: scanState.startedAt,
            }, 409);
          }

          console.log('🚀 [DuplicateRadar] Zoho CRM scan triggered via API (async)');

          scanZohoCRMForDuplicates().catch(err => {
            console.error('[DuplicateRadar] Background scan error:', err);
            scanState.status = 'failed';
            scanState.error = err?.message || 'Background scan failed';
          });

          return c.json({
            success: true,
            message: 'Scan started in background. Poll /api/duplicates/scan-status or connect to /api/duplicates/scan-stream for real-time progress.',
            status: 'scanning',
          });
        } catch (error: any) {
          console.error('Error starting Zoho CRM scan:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
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
          const { requireAdminOrKey, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          if (scanState.status === 'scanning') {
            return c.json({
              success: false,
              error: 'A scan is already in progress',
              progress: scanState.progress,
              startedAt: scanState.startedAt,
            }, 409);
          }

          console.log('🧨 [DuplicateRadar] Rebuild Clusters triggered — wiping tables and rescanning');
          await truncateAllDuplicateData();

          scanZohoCRMForDuplicates('manual').catch(err => {
            console.error('[DuplicateRadar] Background rebuild scan error:', err);
            scanState.status = 'failed';
            scanState.error = err?.message || 'Background scan failed';
          });

          return c.json({
            success: true,
            message: 'Clusters wiped. A fresh Zoho scan is rebuilding them. Watch /api/duplicates/scan-stream for progress.',
            status: 'scanning',
          });
        } catch (error: any) {
          console.error('Error rebuilding clusters:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
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
          const elapsed = scanState.startedAt ? Date.now() - scanState.startedAt : 0;
          return c.json({
            status: scanState.status,
            progress: scanState.progress,
            startedAt: scanState.startedAt,
            completedAt: scanState.completedAt,
            elapsedMs: elapsed,
            percentage: scanState.percentage,
            moduleStatuses: scanState.moduleStatuses,
            recordCounts: scanState.recordCounts,
            result: scanState.status === 'completed' || scanState.status === 'failed' ? scanState.result : null,
            error: scanState.error,
          });
        } catch (error) {
          return c.json({ status: 'unknown', error: 'Failed to get scan status' }, 500);
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

          const stream = new ReadableStream({
            start(controller) {
              sseClients.push({ id: clientId, controller });

              const initialMsg = `event: connected\ndata: ${JSON.stringify({
                clientId,
                currentStatus: scanState.status,
                progress: scanState.progress,
                percentage: scanState.percentage,
                moduleStatuses: scanState.moduleStatuses,
                elapsedMs: scanState.startedAt ? Date.now() - scanState.startedAt : 0
              })}\n\n`;
              controller.enqueue(new TextEncoder().encode(initialMsg));

              const keepAlive = setInterval(() => {
                try {
                  controller.enqueue(new TextEncoder().encode(': keepalive\n\n'));
                } catch {
                  clearInterval(keepAlive);
                }
              }, 15000);
            },
            cancel() {
              sseClients = sseClients.filter(c => c.id !== clientId);
            }
          });

          return new Response(stream, {
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
              'X-Accel-Buffering': 'no'
            }
          });
        } catch (error) {
          return c.json({ error: 'Failed to create SSE stream' }, 500);
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
          const { requireAdminOrKey, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          await clearMockData();
          return c.json({ success: true, message: 'Mock data cleared' });
        } catch (error: any) {
          console.error('Error clearing mock data:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
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
          const url = new URL(c.req.url);
          const exportType = url.searchParams.get('type') || 'all';
          const owner = url.searchParams.get('owner') || undefined;
          const startDate = url.searchParams.get('start_date') || undefined;
          const endDate = url.searchParams.get('end_date') || undefined;

          const records = await getExportRecords({
            owner,
            start_date: startDate,
            end_date: endDate,
            status: 'active'
          });

          await createExportLog({
            export_type: exportType as any,
            filter_criteria: { owner, startDate, endDate },
            total_records_exported: records.length,
            file_format: 'csv',
            exported_by: 'User'
          });

          const { escapeCSVValue } = await import("../../utils/inputSanitizer");
          const csvHeader = 'Record ID,Type,Name,Company,Domain,Owner,Status/Stage,Value,Source,Created Date,Confidence,Recommendation\n';
          const csvRows = records.map(r => 
            [r.zoho_record_id || r.id, r.record_type, r.record_name, r.company_name, r.domain, r.owner_name, r.status || r.stage, r.deal_value || '', r.source, r.created_date, `${r.confidence_score}%`, r.ai_recommendation || 'Review manually'].map(escapeCSVValue).join(',')
          ).join('\n');

          c.header('Content-Type', 'text/csv');
          c.header('Content-Disposition', `attachment; filename="duplicate_radar_export_${Date.now()}.csv"`);
          return c.text(csvHeader + csvRows);
        } catch (error: any) {
          console.error('Error exporting data:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
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
          const url = new URL(c.req.url);
          const limit = parseInt(url.searchParams.get('limit') || '50');
          const offset = parseInt(url.searchParams.get('offset') || '0');
          const start_date = url.searchParams.get('start_date') || undefined;
          const end_date = url.searchParams.get('end_date') || undefined;

          const result = await getDuplicateRecordsByType('lead', { limit, offset, start_date, end_date });
          return c.json({
            total_duplicate_groups: result.total,
            groups: result.groups,
            limit,
            offset,
            pages: Math.ceil(result.total / limit)
          });
        } catch (error: any) {
          console.error('Error fetching lead duplicates:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
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
          const url = new URL(c.req.url);
          const limit = parseInt(url.searchParams.get('limit') || '50');
          const offset = parseInt(url.searchParams.get('offset') || '0');
          const start_date = url.searchParams.get('start_date') || undefined;
          const end_date = url.searchParams.get('end_date') || undefined;

          const result = await getDuplicateRecordsByType('deal', { limit, offset, start_date, end_date });
          return c.json({
            total_duplicate_groups: result.total,
            groups: result.groups,
            limit,
            offset,
            pages: Math.ceil(result.total / limit)
          });
        } catch (error: any) {
          console.error('Error fetching deal duplicates:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
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
          const url = new URL(c.req.url);
          const limit = parseInt(url.searchParams.get('limit') || '50');
          const offset = parseInt(url.searchParams.get('offset') || '0');
          const start_date = url.searchParams.get('start_date') || undefined;
          const end_date = url.searchParams.get('end_date') || undefined;

          const result = await getDuplicateRecordsByType('contact', { limit, offset, start_date, end_date });
          return c.json({
            total_duplicate_groups: result.total,
            groups: result.groups,
            limit,
            offset,
            pages: Math.ceil(result.total / limit)
          });
        } catch (error: any) {
          console.error('Error fetching contact duplicates:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
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
          const url = new URL(c.req.url);
          const limit = parseInt(url.searchParams.get('limit') || '50');
          const offset = parseInt(url.searchParams.get('offset') || '0');
          const start_date = url.searchParams.get('start_date') || undefined;
          const end_date = url.searchParams.get('end_date') || undefined;

          const result = await getDuplicateRecordsByType('account', { limit, offset, start_date, end_date });
          return c.json({
            total_duplicate_groups: result.total,
            groups: result.groups,
            limit,
            offset,
            pages: Math.ceil(result.total / limit)
          });
        } catch (error: any) {
          console.error('Error fetching account duplicates:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
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
          const clusterId = parseInt(c.req.param('clusterId'));
          if (isNaN(clusterId)) return c.json({ error: 'Invalid cluster ID' }, 400);

          const cluster = await getClusterById(clusterId);
          if (!cluster) {
            return c.json({ error: 'Cluster not found' }, 404);
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
              ? `Cross-module cluster (${meta.record_types.join(' + ')}) for ${cluster.domain || cluster.company_name}. Same-module records get MERGE; cross-module get LINK (set Account_Name / Contact_Name in Zoho — never merge across modules).`
              : `Analyzed ${records.length} ${meta.primary_type || 'record'}(s) for ${cluster.domain || cluster.company_name}. Smart scoring considers data completeness, deal activity, recency, and record age.`,
          });
        } catch (error: any) {
          console.error('Error generating AI recommendations:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
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
          const { record_type, email, first_name, last_name, deal_name, company, amount, owner_email } = data;

          if (!email) {
            return c.json({ error: 'Missing required fields' }, 400);
          }

          const emailDomain = email.split('@')[1]?.toLowerCase();
          if (!emailDomain) {
            return c.json({ error: 'Invalid email format' }, 400);
          }

          const publicDomains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com', 'live.com'];
          if (publicDomains.includes(emailDomain)) {
            return c.json({ error: 'Public email domains (gmail, yahoo, etc.) are excluded from duplicate detection. Use a company domain.' }, 400);
          }

          const cluster = await findOrCreateClusterByDomain(emailDomain);
          
          const recordName = record_type === 'lead' 
            ? `${first_name || ''} ${last_name || ''}`.trim() || 'Unknown Lead'
            : deal_name || 'Unknown Deal';

          const ownerName = owner_email ? owner_email.split('@')[0].replace(/\./g, ' ').replace(/^\w/, (c: string) => c.toUpperCase()) : 'Unknown';

          await addRecordToCluster({
            cluster_id: cluster.id!,
            zoho_record_id: `test_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            record_type: record_type || 'lead',
            record_name: recordName,
            email: email,
            domain: emailDomain,
            phone: undefined,
            company_name: company || undefined,
            owner_name: ownerName,
            owner_email: owner_email || undefined,
            deal_value: record_type === 'deal' ? (amount || 0) : undefined,
            stage: undefined,
            source: 'Sandbox Test',
            created_date: new Date(),
            modified_date: new Date(),
            is_primary: false,
            confidence_score: 95,
            is_mock_data: true
          });

          await updateClusterStats(cluster.id!);

          return c.json({ success: true, cluster_id: cluster.id, domain: emailDomain });
        } catch (error: any) {
          console.error('Error adding test record:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
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
          console.log('🔍 [DuplicateSearch] Searching with params:', params);
          
          const { domain, phone, company_name, contract_number, email, record_name, owner_email } = params;

          if (!domain && !phone && !company_name && !contract_number && !email && !record_name && !owner_email) {
            return c.json({ error: 'Missing required fields' }, 400);
          }

          const results = await searchDuplicates({
            domain,
            phone,
            company_name,
            contract_number,
            email,
            record_name,
            owner_email
          });

          console.log('✅ [DuplicateSearch] Found', results.total_records, 'records in', results.clusters.length, 'clusters');

          return c.json(results);
        } catch (error: any) {
          console.error('Error searching duplicates:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
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
          const { requireAdminOrKey, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const id = parseInt(c.req.param('id'));
          if (isNaN(id)) return c.json({ error: 'Invalid cluster ID' }, 400);

          const body = await c.req.json();
          const { action, primary_record_id, notes } = body;

          if (!action || !['resolve', 'ignore'].includes(action)) {
            return c.json({ error: 'action must be "resolve" or "ignore"' }, 400);
          }

          const result = await resolveCluster(id, action, sessionUser.email || 'admin', primary_record_id, notes);
          return c.json({ success: true, merge_action: result });
        } catch (error: any) {
          console.error('Error resolving cluster:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
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
          const { requireAdminOrKey, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const clusterId = parseInt(c.req.param('id'));
          const { record_id } = await c.req.json();
          if (isNaN(clusterId) || !record_id) return c.json({ error: 'Invalid parameters' }, 400);

          const success = await markPrimaryRecord(clusterId, record_id);
          return c.json({ success });
        } catch (error: any) {
          console.error('Error marking primary:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
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
          const { requireAdminOrKey, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const { cluster_ids, action } = await c.req.json();
          if (!Array.isArray(cluster_ids) || !['resolve', 'ignore'].includes(action)) {
            return c.json({ error: 'cluster_ids (array) and action (resolve/ignore) required' }, 400);
          }

          const count = await bulkResolve(cluster_ids, action, sessionUser.email || 'admin');
          return c.json({ success: true, resolved: count });
        } catch (error: any) {
          console.error('Error bulk resolving:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
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
          const url = new URL(c.req.url);
          const clusterId = url.searchParams.get('cluster_id');
          const limit = parseInt(url.searchParams.get('limit') || '50');
          const history = await getMergeHistory(clusterId ? parseInt(clusterId) : undefined, limit);
          return c.json({ history });
        } catch (error: any) {
          console.error('Error fetching merge history:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
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
            return c.json({ error: 'Provide at least one of: email, phone, company_name' }, 400);
          }

          const result = await checkForDuplicates({ email, phone, company_name });
          return c.json(result);
        } catch (error: any) {
          console.error('Error checking duplicates:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
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
          const data = await getOwnerAccountability();
          return c.json({ owners: data });
        } catch (error: any) {
          console.error('Error fetching owner accountability:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
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
          const summary = await getEnhancedSummary();
          const lastScan = await getLastScanDate();
          return c.json({ ...summary, lastScanDate: lastScan });
        } catch (error: any) {
          console.error('Error fetching enhanced summary:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
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
          console.error('Error fetching sync status:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
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
          const [owners, layouts, domains, pipelines, products] = await Promise.all([
            getDistinctOwners(),
            getDistinctLayouts(),
            getDistinctDomains(),
            getDistinctPipelines(),
            getDistinctProducts(),
          ]);
          return c.json({ owners, layouts, domains, pipelines, products, modules: ['Leads', 'Deals', 'Contacts', 'Accounts'] });
        } catch (error: any) {
          console.error('Error fetching filter options:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
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
          const url = new URL(c.req.url);
          const rawLimit = parseInt(url.searchParams.get('limit') || '30');
          const rawOffset = parseInt(url.searchParams.get('offset') || '0');
          const limit = isNaN(rawLimit) ? 30 : Math.min(Math.max(rawLimit, 1), 100);
          const offset = isNaN(rawOffset) ? 0 : Math.max(rawOffset, 0);

          const filters: DuplicateFilters = {
            modules: url.searchParams.get('modules') ? url.searchParams.get('modules')!.split(',') : undefined,
            owners: url.searchParams.get('owners') ? url.searchParams.get('owners')!.split(',') : undefined,
            layouts: url.searchParams.get('layouts') ? url.searchParams.get('layouts')!.split(',') : undefined,
            pipelines: url.searchParams.get('pipelines') ? url.searchParams.get('pipelines')!.split(',') : undefined,
            domain: url.searchParams.get('domain') || undefined,
            start_date: url.searchParams.get('start_date') || undefined,
            end_date: url.searchParams.get('end_date') || undefined,
            status: url.searchParams.get('status') || 'active',
            confidence_level: url.searchParams.get('confidence_level') || undefined,
          };

          const { clusters, total } = await getFilteredClusters(filters, limit, offset);
          return c.json({ clusters, total, limit, offset, pages: Math.ceil(total / limit) });
        } catch (error: any) {
          console.error('Error fetching filtered clusters:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
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
          const url = new URL(c.req.url);
          const filters: DuplicateFilters = {
            modules: url.searchParams.get('modules') ? url.searchParams.get('modules')!.split(',') : undefined,
            owners: url.searchParams.get('owners') ? url.searchParams.get('owners')!.split(',') : undefined,
            domain: url.searchParams.get('domain') || undefined,
          };
          const summary = await getFilteredSummary(filters);
          return c.json(summary);
        } catch (error: any) {
          console.error('Error fetching filtered summary:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
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
          const clusterId = parseInt(c.req.param('id'));
          if (isNaN(clusterId)) return c.json({ error: 'Invalid cluster ID' }, 400);

          const records = await getRecordsByClusterId(clusterId);
          const recordIds = records.map(r => r.zoho_record_id).filter(Boolean) as string[];
          const tasks = await getTasksForRecords(recordIds);
          const taskCount = await getTaskCountForCluster(clusterId);

          return c.json({ tasks, total: taskCount });
        } catch (error: any) {
          console.error('Error fetching cluster tasks:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
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
          const { requireAdminOrKey, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const result = await autoResolveClusters();
          return c.json({ success: true, ...result });
        } catch (error: any) {
          console.error('Error auto-resolving:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
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
          const { pool } = await import('../../utils/duplicateRadarDatabase');
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
          return c.json({ success: true, clustersUpdated: result.rowCount || 0 });
        } catch (error: any) {
          console.error('Error recalculating stats:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
        }
      };
    },
  },
];

export default duplicateRadarRoutes;
