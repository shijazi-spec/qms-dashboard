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
  markStaleRecords,
  removeRecordsByZohoIds,
  cleanupOrphanClusters,
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
  generateSmartRecommendation,
  getSyncState,
  getSyncStateForModule,
  upsertSyncState,
  getDistinctOwners,
  getDistinctLayouts,
  getDistinctDomains,
  getDistinctProducts,
  getDistinctPipelines,
  getFilteredClusters,
  getFilteredSummary,
  upsertTask,
  getTasksForRecords,
  getTaskCountForCluster,
  getLastScanModifiedTime,
  calculateEnhancedScore,
  assessDataQuality,
  getDataQualityStats,
  type DuplicateFilters,
} from '../../utils/duplicateRadarDatabase';

import { fetchAllZohoRecords, fetchDeletedZohoRecords } from '../../utils/zohoCRM';

const SCAN_MAX_PER_MODULE = parseInt(process.env.DUPLICATE_SCAN_LIMIT || '50000');
const SCAN_MODE = process.env.DUPLICATE_SCAN_MODE || 'incremental'; // 'full' or 'incremental'
const SCAN_BATCH_SIZE = parseInt(process.env.DUPLICATE_SCAN_BATCH_SIZE || '25');
const CLUSTER_STATS_BATCH_SIZE = parseInt(process.env.DUPLICATE_CLUSTER_STATS_BATCH || '50');

interface ScanState {
  status: 'idle' | 'scanning' | 'completed' | 'failed';
  progress: string;
  pct: number;
  module_status: Record<string, 'pending' | 'fetching' | 'processing' | 'done' | 'error'>;
  module_counts: Record<string, number>;
  startedAt: number | null;
  completedAt: number | null;
  result: any | null;
  error: string | null;
  listeners: Set<(data: string) => void>;
}

const scanState: ScanState = {
  status: 'idle',
  progress: '',
  pct: 0,
  module_status: {},
  module_counts: {},
  startedAt: null,
  completedAt: null,
  result: null,
  error: null,
  listeners: new Set(),
};

function emitScanEvent(event: string, data: any) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const listener of scanState.listeners) {
    try { listener(payload); } catch { /* client disconnected */ }
  }
}

function updateScanProgress(progress: string, moduleStatus?: Record<string, string>, pct?: number) {
  scanState.progress = progress;
  if (pct !== undefined) scanState.pct = pct;
  if (moduleStatus) {
    Object.assign(scanState.module_status, moduleStatus);
  }
  emitScanEvent('progress', {
    progress,
    pct: scanState.pct,
    module_status: scanState.module_status,
    module_counts: scanState.module_counts,
    elapsed_ms: scanState.startedAt ? Date.now() - scanState.startedAt : 0
  });
}

type RecordExtractor = (record: any) => {
  companyName: string; email: string; phone: string; mobile?: string;
  recordName: string; domain: string | null; ownerName: string; ownerEmail: string;
  status: string; stage?: string; dealValue?: number; source: string;
  createdTime: string; modifiedTime: string;
  layoutName?: string; layoutId?: string; zohoModule?: string;
  pipeline?: string; products?: string; contactName?: string; accountName?: string;
  crNumber?: string; vatNumber?: string; website?: string;
  country?: string; region?: string; industry?: string;
  noOfEmployees?: number; title?: string; leadType?: string;
  govType?: string; accountType?: string;
};

async function fetchModule(
  moduleName: string,
  recordType: 'lead' | 'deal' | 'contact' | 'account',
  extractRecord: RecordExtractor
): Promise<{ records: any[]; extracted: any[] }> {
  updateScanProgress(`Fetching ${moduleName}...`, { [moduleName]: 'fetching' });
  let records: any[] = [];
  try {
    records = await fetchAllZohoRecords(moduleName, {
      maxRecords: SCAN_MAX_PER_MODULE,
      onProgress: (fetched) => {
        scanState.module_counts[moduleName] = fetched;
        updateScanProgress(
          `Fetching ${moduleName}: ${fetched.toLocaleString()} records...`,
          { [moduleName]: `fetching (${fetched.toLocaleString()})` as any }
        );
      }
    });
  } catch (e) {
    console.error(`Error fetching ${moduleName}:`, e);
    updateScanProgress(`${moduleName} fetch failed`, { [moduleName]: 'error' });
    return { records: [], extracted: [] };
  }

  scanState.module_counts[moduleName] = records.length;
  updateScanProgress(`${moduleName}: ${records.length.toLocaleString()} records fetched`, { [moduleName]: 'processing' });

  const extracted = records.map(record => {
    const data = extractRecord(record);
    return { ...data, zohoId: record.id, rawData: record.data, recordType };
  }).filter(d => d.companyName && d.companyName !== 'Unknown');

  return { records, extracted };
}

const LEAD_EXTRACTOR: RecordExtractor = (record) => {
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
    layoutName: d.Layout?.name || '',
    layoutId: d.Layout?.id || '',
    zohoModule: 'Leads',
    products: d.Product || '',
    title: d.Title || d.Designation || '',
    leadType: d.Lead_Type || '',
    website: d.Website || '',
    country: d.Country || '',
    industry: d.Industry || '',
  };
};

const DEAL_EXTRACTOR: RecordExtractor = (record) => {
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
    layoutName: d.Layout?.name || '',
    layoutId: d.Layout?.id || '',
    zohoModule: 'Deals',
    pipeline: d.Pipeline || '',
    contactName: d.Contact_Name?.name || '',
    accountName: d.Account_Name?.name || '',
    crNumber: d.CR_Number || d.Commercial_Registration || '',
    vatNumber: d.VAT_Number || d.Tax_ID || '',
    products: d.Product || d.Product_Name || '',
    country: d.Country || '',
  };
};

const CONTACT_EXTRACTOR: RecordExtractor = (record) => {
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
    status: d.Contact_Type || 'Contact',
    source: d.Lead_Source || '',
    createdTime: d.Created_Time || '',
    modifiedTime: d.Modified_Time || '',
    layoutName: d.Layout?.name || '',
    layoutId: d.Layout?.id || '',
    zohoModule: 'Contacts',
    accountName: d.Account_Name?.name || '',
    title: d.Title || d.Designation || '',
    country: d.Mailing_Country || d.Country || '',
  };
};

const ACCOUNT_EXTRACTOR: RecordExtractor = (record) => {
  const d = record.data;
  const website = d.Website?.replace(/^https?:\/\/(www\.)?/, '').split('/')[0] || '';
  return {
    companyName: d.Account_Name || 'Unknown',
    email: d.Email || '',
    phone: d.Phone || '',
    recordName: d.Account_Name || 'Unknown',
    domain: extractDomain(d.Email || '') || (website && !website.includes(' ') ? website : null),
    ownerName: d.Owner?.name || 'Unknown',
    ownerEmail: d.Owner?.email || '',
    status: 'Account',
    source: 'Account',
    createdTime: d.Created_Time || '',
    modifiedTime: d.Modified_Time || '',
    layoutName: d.Layout?.name || '',
    layoutId: d.Layout?.id || '',
    zohoModule: 'Accounts',
    crNumber: d.CR_Number || d.Commercial_Registration || '',
    vatNumber: d.VAT_Number || d.Tax_ID || '',
    website: d.Website || '',
    country: d.Billing_Country || d.Country || '',
    region: d.Billing_State || d.Region || '',
    industry: d.Industry || '',
    noOfEmployees: parseInt(d.Employees) || undefined,
    accountType: d.Account_Type || '',
    govType: d.Gov_Type || '',
  };
};

// Phase 1: Sync all CRM data from Zoho (incremental via Modified_Time)
async function syncAllModules(mode: 'full' | 'incremental' = 'incremental'): Promise<{
  totalSynced: number;
  moduleBreakdown: Array<{ module: string; count: number }>;
  durationMs: number;
}> {
  const startTime = Date.now();
  const modules: Array<{ name: string; type: 'lead' | 'deal' | 'contact' | 'account'; extractor: RecordExtractor }> = [
    { name: 'Leads', type: 'lead', extractor: LEAD_EXTRACTOR },
    { name: 'Deals', type: 'deal', extractor: DEAL_EXTRACTOR },
    { name: 'Contacts', type: 'contact', extractor: CONTACT_EXTRACTOR },
    { name: 'Accounts', type: 'account', extractor: ACCOUNT_EXTRACTOR },
  ];

  updateScanProgress('Syncing all CRM modules...', undefined, 2);

  if (mode === 'full') {
    updateScanProgress('Clearing previous data (full sync)...');
    await clearAllDuplicateData();
  }

  const moduleBreakdown: Array<{ module: string; count: number }> = [];
  const allExtracted: any[] = [];
  let fetchPct = 2;
  const pctPerModule = 8; // 2% -> 34% for fetching

  for (const mod of modules) {
    const modStart = Date.now();
    scanState.module_status[mod.name] = 'fetching' as any;
    await upsertSyncState(mod.name, { sync_status: 'syncing' });

    let criteria: string | undefined;
    if (mode === 'incremental') {
      const lastModified = await getLastScanModifiedTime(mod.name);
      if (lastModified) {
        criteria = `(Modified_Time:greater_than:${lastModified})`;
        console.log(`[DuplicateRadar] ${mod.name}: incremental since ${lastModified}`);
      }
    }

    try {
      const records = await fetchAllZohoRecords(mod.name, {
        criteria,
        onProgress: (fetched) => {
          scanState.module_counts[mod.name] = fetched;
          updateScanProgress(
            `Fetching ${mod.name}: ${fetched.toLocaleString()} records...`,
            { [mod.name]: `fetching (${fetched.toLocaleString()})` as any }
          );
        }
      });

      scanState.module_counts[mod.name] = records.length;
      const extracted = records.map(record => {
        const data = mod.extractor(record);
        return { ...data, zohoId: record.id, rawData: record.data, recordType: mod.type };
      }).filter(d => d.companyName && d.companyName !== 'Unknown');

      allExtracted.push(...extracted);
      moduleBreakdown.push({ module: mod.name, count: records.length });
      scanState.module_status[mod.name] = 'done' as any;

      await upsertSyncState(mod.name, {
        sync_status: 'idle',
        last_sync_at: new Date(),
        total_synced: records.length,
        ...(mode === 'full' ? { last_full_sync_at: new Date() } : {})
      });

      console.log(`[DuplicateRadar] ${mod.name}: synced ${records.length} records in ${Date.now() - modStart}ms`);
    } catch (err: any) {
      console.error(`[DuplicateRadar] ${mod.name} sync error:`, err);
      scanState.module_status[mod.name] = 'error' as any;
      await upsertSyncState(mod.name, { sync_status: 'failed', error_message: err?.message });
      moduleBreakdown.push({ module: mod.name, count: 0 });
    }

    fetchPct += pctPerModule;
    updateScanProgress(`${mod.name} synced`, undefined, Math.min(fetchPct, 34));
  }

  // Also fetch Tasks
  try {
    updateScanProgress('Fetching Tasks...', undefined, 35);
    const tasks = await fetchAllZohoRecords('Tasks', {
      onProgress: (fetched) => {
        scanState.module_counts['Tasks'] = fetched;
      }
    });
    let tasksSynced = 0;
    for (const t of tasks) {
      const d = t.data;
      if (!d.What_Id?.id) continue;
      await upsertTask({
        zoho_task_id: t.id,
        related_record_id: d.What_Id.id,
        subject: d.Subject || '',
        due_date: d.Due_Date ? new Date(d.Due_Date) : undefined,
        status: d.Status || '',
        priority: d.Priority || '',
        owner_name: d.Owner?.name || ''
      });
      tasksSynced++;
    }
    console.log(`[DuplicateRadar] Tasks: synced ${tasksSynced} linked tasks`);
    moduleBreakdown.push({ module: 'Tasks', count: tasksSynced });
  } catch (err: any) {
    console.error('[DuplicateRadar] Tasks sync error:', err);
  }

  updateScanProgress(`Sync complete. Storing ${allExtracted.length.toLocaleString()} records...`, undefined, 38);

  // Store extracted records in DB
  const clusterCache = new Map<string, { id: number }>();
  const clustersUpdated = new Set<number>();
  const seenZohoIds: string[] = [];
  let processed = 0;

  async function getCachedCluster(companyName: string, domain?: string, phone?: string, email?: string) {
    const cacheKey = (domain || '') + '||' + (companyName || '').toLowerCase().trim();
    const cached = clusterCache.get(cacheKey);
    if (cached) return cached;
    const cluster = await findOrCreateClusterByCompany(companyName, domain, phone, email);
    clusterCache.set(cacheKey, { id: cluster.id! });
    return { id: cluster.id! };
  }

  let junkCount = 0;

  async function processRecord(data: any) {
    const dq = assessDataQuality({
      recordName: data.recordName,
      companyName: data.companyName,
      email: data.email,
      phone: data.phone,
      mobile: data.mobile,
      ownerName: data.ownerName,
      domain: data.domain,
    });

    if (dq.isJunk) {
      junkCount++;
    }

    // Junk records still get stored (for audit trail) but go to a catch-all cluster
    const cluster = dq.isJunk
      ? await getCachedCluster('__JUNK_RECORDS__', undefined, undefined, undefined)
      : await getCachedCluster(data.companyName, data.domain || undefined, data.phone || undefined, data.email || undefined);

    await upsertRecord({
      cluster_id: cluster.id,
      record_type: data.recordType,
      zoho_record_id: data.zohoId,
      record_name: data.recordName,
      company_name: data.companyName,
      email: data.email || undefined,
      domain: data.domain || undefined,
      phone: data.phone || undefined,
      phone_normalized: data.phone ? normalizePhone(data.phone) : undefined,
      mobile: data.mobile || undefined,
      mobile_normalized: data.mobile ? normalizePhone(data.mobile) : undefined,
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
      raw_data: data.rawData,
      layout_name: data.layoutName || undefined,
      layout_id: data.layoutId || undefined,
      zoho_module: data.zohoModule || undefined,
      pipeline: data.pipeline || undefined,
      products: data.products || undefined,
      contact_name: data.contactName || undefined,
      account_name: data.accountName || undefined,
      cr_number: data.crNumber || undefined,
      vat_number: data.vatNumber || undefined,
      website: data.website || undefined,
      country: data.country || undefined,
      region: data.region || undefined,
      industry: data.industry || undefined,
      no_of_employees: data.noOfEmployees || undefined,
      title: data.title || undefined,
      lead_type: data.leadType || undefined,
      gov_type: data.govType || undefined,
      account_type: data.accountType || undefined,
      data_quality_score: dq.score,
      data_quality_flags: dq.flags,
    });

    if (data.zohoId) seenZohoIds.push(data.zohoId);
    if (!dq.isJunk) clustersUpdated.add(cluster.id);
  }

  const total = allExtracted.length;
  for (let i = 0; i < total; i += SCAN_BATCH_SIZE) {
    const batch = allExtracted.slice(i, i + SCAN_BATCH_SIZE);
    await Promise.all(batch.map(processRecord));
    processed += batch.length;
    const pct = Math.round(38 + (processed / total) * 32);
    if (processed % (SCAN_BATCH_SIZE * 4) === 0 || i + SCAN_BATCH_SIZE >= total) {
      updateScanProgress(
        `Storing records: ${processed.toLocaleString()}/${total.toLocaleString()}`,
        undefined, pct
      );
    }
  }

  console.log(`[DuplicateRadar] Sync: ${clusterCache.size} unique cluster keys, ${total} records stored, ${junkCount} junk records quarantined`);

  // Post-sync cleanup:
  //   - FULL mode: seenZohoIds is the complete snapshot of live records, so we can
  //     safely flag everything missing from that list as stale.
  //   - INCREMENTAL mode: seenZohoIds only contains records touched in this window,
  //     so we CANNOT use it to detect deletions. Instead we call Zoho's /deleted
  //     endpoint to discover records the user deleted or MERGED directly in Zoho,
  //     and purge just those. This is what keeps the duplicate radar in sync with
  //     manual merges performed inside Zoho CRM.
  if (mode === 'full' && seenZohoIds.length > 0) {
    updateScanProgress('Marking stale records...', undefined, 71);
    const staleCount = await markStaleRecords(seenZohoIds);
    if (staleCount > 0) console.log(`[DuplicateRadar] Marked ${staleCount} stale records (full sync)`);
    const orphanCount = await cleanupOrphanClusters();
    if (orphanCount > 0) console.log(`[DuplicateRadar] Cleaned up ${orphanCount} orphan clusters`);
  } else if (mode === 'incremental') {
    updateScanProgress('Detecting deleted/merged records in Zoho...', undefined, 71);
    const affectedClusterSet = new Set<number>();
    let totalPurged = 0;
    let totalMerged = 0;

    for (const mod of modules) {
      try {
        const state = await getSyncStateForModule(mod.name);
        const since = state?.last_sync_at ? new Date(state.last_sync_at).toUTCString() : undefined;
        const deleted = await fetchDeletedZohoRecords(mod.name, { modifiedSince: since, type: 'all' });
        if (deleted.length === 0) continue;

        const ids = deleted.map(d => d.id);
        const { removed, affectedClusters } = await removeRecordsByZohoIds(ids, { module: mod.type });
        totalPurged += removed;
        totalMerged += deleted.filter(d => d.type === 'merged').length;
        affectedClusters.forEach(id => affectedClusterSet.add(id));

        if (removed > 0) {
          console.log(`[DuplicateRadar] ${mod.name}: purged ${removed} records deleted/merged in Zoho ` +
            `(merged=${deleted.filter(d => d.type === 'merged').length})`);
        }
      } catch (err: any) {
        console.warn(`[DuplicateRadar] ${mod.name} deletion-sync failed:`, err?.message || err);
      }
    }

    if (affectedClusterSet.size > 0) {
      updateScanProgress(`Recalculating ${affectedClusterSet.size} affected cluster(s)...`, undefined, 73);
      for (const cid of affectedClusterSet) {
        try { await updateClusterStats(cid); } catch { /* non-fatal */ }
      }
      const orphanCount = await cleanupOrphanClusters();
      if (orphanCount > 0) console.log(`[DuplicateRadar] Cleaned up ${orphanCount} orphan clusters after deletion sync`);
    }

    if (totalPurged > 0 || totalMerged > 0) {
      console.log(`[DuplicateRadar] Incremental deletion sync: ${totalPurged} records purged (${totalMerged} from Zoho merges)`);
    }
  }

  return {
    totalSynced: total,
    moduleBreakdown,
    durationMs: Date.now() - startTime,
  };
}

// Phase 2: Detect duplicates from local DB data (no Zoho calls)
async function runDuplicateDetection(): Promise<{
  clustersScored: number;
  durationMs: number;
}> {
  const startTime = Date.now();
  updateScanProgress('Running duplicate detection (scoring clusters)...', undefined, 73);

  const dbModule = await import('../../utils/duplicateRadarDatabase');
  const clusterIdsResult = await dbModule.pool.query(
    "SELECT id FROM duplicate_clusters WHERE status = 'active'"
  );
  const clusterIds = clusterIdsResult.rows.map((r: any) => r.id);

  let scored = 0;
  for (let i = 0; i < clusterIds.length; i += CLUSTER_STATS_BATCH_SIZE) {
    const batch = clusterIds.slice(i, i + CLUSTER_STATS_BATCH_SIZE);
    await Promise.all(batch.map((cid: number) => updateClusterStats(cid)));
    scored += batch.length;
    if (scored % (CLUSTER_STATS_BATCH_SIZE * 2) === 0 || i + CLUSTER_STATS_BATCH_SIZE >= clusterIds.length) {
      const pct = Math.round(73 + (scored / clusterIds.length) * 25);
      updateScanProgress(`Scoring clusters: ${scored.toLocaleString()}/${clusterIds.length.toLocaleString()}`, undefined, pct);
    }
  }

  return { clustersScored: scored, durationMs: Date.now() - startTime };
}

// Full pipeline: sync + detect
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
  console.log(`[DuplicateRadar] Starting full sync + detection (${detectionType}, mode: ${SCAN_MODE})...`);

  scanState.status = 'scanning';
  scanState.startedAt = startTime;
  scanState.progress = 'Initializing...';
  scanState.pct = 0;
  scanState.module_status = { Leads: 'pending', Deals: 'pending', Contacts: 'pending', Accounts: 'pending' };
  scanState.module_counts = {};
  scanState.result = null;
  scanState.error = null;
  emitScanEvent('start', { mode: SCAN_MODE, detectionType });

  try {
    const syncResult = await syncAllModules(SCAN_MODE as 'full' | 'incremental');
    const detectionResult = await runDuplicateDetection();

    const summary = await getEnhancedSummary();
    const duration = Date.now() - startTime;

    await createDetectionLog({
      detection_type: detectionType,
      total_records_scanned: syncResult.totalSynced,
      total_clusters_found: detectionResult.clustersScored,
      total_duplicates_detected: summary.trueDuplicateClusters,
      high_confidence_count: summary.highConfidence,
      medium_confidence_count: summary.mediumConfidence,
      low_confidence_count: summary.lowConfidence,
      estimated_pipeline_inflation: summary.estimatedPipelineInflation,
      detection_duration_ms: duration,
      triggered_by: detectionType === 'scheduled' ? 'Auto Sync' : 'Manual Scan',
      status: 'completed',
      completed_at: new Date()
    });

    console.log(`[DuplicateRadar] Complete: ${syncResult.totalSynced} synced, ${summary.trueDuplicateClusters} duplicates, ${duration}ms`);

    const resultData = {
      success: true,
      totalRecordsScanned: syncResult.totalSynced,
      totalClustersFound: detectionResult.clustersScored,
      duplicatesDetected: summary.trueDuplicateClusters,
      highConfidence: summary.highConfidence,
      mediumConfidence: summary.mediumConfidence,
      moduleBreakdown: syncResult.moduleBreakdown,
      pipelineInflation: summary.estimatedPipelineInflation,
      durationMs: duration
    };

    scanState.status = 'completed';
    scanState.completedAt = Date.now();
    scanState.progress = `Complete: ${syncResult.totalSynced.toLocaleString()} records, ${summary.trueDuplicateClusters} duplicate clusters`;
    scanState.result = resultData;
    updateScanProgress(scanState.progress, undefined, 100);
    emitScanEvent('complete', resultData);

    return resultData;

  } catch (error: any) {
    console.error('[DuplicateRadar] Scan error:', error);
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
      error: error?.message || 'An internal error occurred'
    };

    scanState.status = 'failed';
    scanState.completedAt = Date.now();
    scanState.progress = 'Scan failed';
    scanState.error = error?.message || 'An internal error occurred';
    scanState.result = errorResult;
    emitScanEvent('error', { error: scanState.error });

    return errorResult;
  }
}

export { scanZohoCRMForDuplicates, syncAllModules, runDuplicateDetection };

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
  {
    path: "/api/duplicates/clusters",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const url = new URL(c.req.url);
          const status = url.searchParams.get('status');
          const confidence_level = url.searchParams.get('confidence_level');
          const limit = parseInt(url.searchParams.get('limit') || '100');
          const offset = parseInt(url.searchParams.get('offset') || '0');

          const filters = {
            status: status || undefined,
            confidence_level: confidence_level || undefined
          };

          const [clusters, total] = await Promise.all([
            getAllClusters({ ...filters, limit, offset }),
            getClusterCount(filters)
          ]);

          return c.json({ clusters, total, limit, offset });
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
          const cluster = await getClusterById(id);
          if (!cluster) {
            return c.json({ error: 'Cluster not found' }, 404);
          }
          const records = await getRecordsByClusterId(id);
          return c.json({ cluster, records });
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
          const record_type = (url.searchParams.get('type') || 'all') as string;

          const searchParams = {
            company_name: query,
            domain: query,
            email: query.includes('@') ? query : undefined,
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

          console.log('[DuplicateRadar] Zoho CRM scan triggered via API (async)');

          scanZohoCRMForDuplicates().catch(err => {
            console.error('[DuplicateRadar] Background scan error:', err);
            scanState.status = 'failed';
            scanState.error = err?.message || 'Background scan failed';
          });

          return c.json({
            success: true,
            message: 'Scan started in background. Poll /api/duplicates/scan-status or connect to /api/duplicates/scan-stream for real-time updates.',
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
    path: "/api/duplicates/scan-status",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const elapsed = scanState.startedAt ? Date.now() - scanState.startedAt : 0;
          return c.json({
            status: scanState.status,
            progress: scanState.progress,
            pct: scanState.pct,
            module_status: scanState.module_status,
            module_counts: scanState.module_counts,
            startedAt: scanState.startedAt,
            completedAt: scanState.completedAt,
            elapsedMs: elapsed,
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
        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            const send = (data: string) => {
              try { controller.enqueue(encoder.encode(data)); } catch { /* stream closed */ }
            };

            send(`event: connected\ndata: ${JSON.stringify({ status: scanState.status, progress: scanState.progress })}\n\n`);

            scanState.listeners.add(send);

            const keepAlive = setInterval(() => {
              send(`: keepalive\n\n`);
            }, 15000);

            const cleanup = () => {
              scanState.listeners.delete(send);
              clearInterval(keepAlive);
            };

            c.req.raw.signal?.addEventListener('abort', cleanup);
          }
        });

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          }
        });
      };
    },
  },
  {
    path: "/api/duplicates/generate-mock-data",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const startTime = Date.now();
          await clearMockData();

          const companies = [
            { domain: 'acme-corp.com', names: ['ACME Corporation', 'Acme Corp', 'ACME Corp.'] },
            { domain: 'techsolutions.sa', names: ['Tech Solutions', 'Tech Solutionss', 'TechSolutions SA'] },
            { domain: 'saudiarabia-invest.com', names: ['Saudi Arabia Investment', 'SA Invest', 'Saudi Invest'] },
            { domain: 'globaltrading.ae', names: ['Global Trading LLC', 'Global Trade', 'GlobalTrading'] },
            { domain: 'constructionplus.sa', names: ['Construction Plus', 'Construction+', 'ConstructionPlus SA'] },
            { domain: 'healthcare-ksa.com', names: ['Healthcare KSA', 'HealthCare Saudi', 'HC KSA'] },
            { domain: 'finance-hub.sa', names: ['Finance Hub', 'FinanceHub', 'Finance Hub SA'] },
            { domain: 'logistics-express.com', names: ['Logistics Express', 'LogisticsExpress', 'Logistics Xpress'] },
            { domain: 'retail-kingdom.sa', names: ['Retail Kingdom', 'RetailKingdom', 'Retail Kingdum'] },
            { domain: 'energy-solutions.sa', names: ['Energy Solutions', 'EnergySolutions', 'Energy Sol'] },
          ];

          const owners = [
            { name: 'Ahmed Al-Rashid', email: 'ahmed.rashid@walaplus.com' },
            { name: 'Fatima Hassan', email: 'fatima.hassan@walaplus.com' },
            { name: 'Omar Mahmoud', email: 'omar.mahmoud@walaplus.com' },
            { name: 'Sara Al-Qahtani', email: 'sara.qahtani@walaplus.com' },
            { name: 'Khalid Ibrahim', email: 'khalid.ibrahim@walaplus.com' }
          ];

          const sources = ['Website', 'Landing Page', 'Manual Entry', 'Import', 'Referral', 'LinkedIn', 'Trade Show'];
          const leadStatuses = ['New', 'Contacted', 'Qualified', 'Unqualified', 'Converted'];
          const dealStages = ['Qualification', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost'];

          let totalLeads = 0, totalDeals = 0, totalClusters = 0;

          for (const company of companies) {
            const cluster = await findOrCreateClusterByDomain(company.domain);
            totalClusters++;
            const numLeads = Math.floor(Math.random() * 5) + 2;
            const numDeals = Math.floor(Math.random() * 3) + 1;

            for (let i = 0; i < numLeads; i++) {
              const owner = owners[Math.floor(Math.random() * owners.length)];
              const nameVar = company.names[Math.floor(Math.random() * company.names.length)];
              const created = new Date(Date.now() - Math.random() * 180 * 86400000);
              await addRecordToCluster({
                cluster_id: cluster.id!, record_type: 'lead',
                zoho_record_id: `LEAD_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                record_name: `Lead - ${nameVar}`, company_name: nameVar,
                email: `contact${i + 1}@${company.domain}`, domain: company.domain,
                phone: `+966 5${Math.floor(Math.random() * 90000000 + 10000000)}`,
                owner_name: owner.name, owner_email: owner.email,
                status: leadStatuses[Math.floor(Math.random() * leadStatuses.length)],
                source: sources[Math.floor(Math.random() * sources.length)],
                created_date: created, modified_date: new Date(created.getTime() + Math.random() * 30 * 86400000),
                is_primary: i === 0, confidence_score: 75 + Math.floor(Math.random() * 25),
                is_mock_data: true, raw_data: { mock: true }
              });
              totalLeads++;
            }

            for (let i = 0; i < numDeals; i++) {
              const owner = owners[Math.floor(Math.random() * owners.length)];
              const nameVar = company.names[Math.floor(Math.random() * company.names.length)];
              const created = new Date(Date.now() - Math.random() * 120 * 86400000);
              await addRecordToCluster({
                cluster_id: cluster.id!, record_type: 'deal',
                zoho_record_id: `DEAL_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                record_name: `Deal - ${nameVar}`, company_name: nameVar,
                email: `sales@${company.domain}`, domain: company.domain,
                phone: `+966 5${Math.floor(Math.random() * 90000000 + 10000000)}`,
                owner_name: owner.name, owner_email: owner.email,
                stage: dealStages[Math.floor(Math.random() * dealStages.length)],
                deal_value: Math.floor(Math.random() * 500000) + 50000,
                source: sources[Math.floor(Math.random() * sources.length)],
                created_date: created, modified_date: new Date(created.getTime() + Math.random() * 30 * 86400000),
                is_primary: i === 0, confidence_score: 80 + Math.floor(Math.random() * 20),
                is_mock_data: true, raw_data: { mock: true }
              });
              totalDeals++;
            }
            await updateClusterStats(cluster.id!);
          }

          const duration = Date.now() - startTime;
          await createDetectionLog({
            detection_type: 'manual', total_records_scanned: totalLeads + totalDeals,
            total_clusters_found: totalClusters, total_duplicates_detected: totalLeads + totalDeals - totalClusters,
            high_confidence_count: Math.floor(totalClusters * 0.4), medium_confidence_count: Math.floor(totalClusters * 0.4),
            low_confidence_count: Math.floor(totalClusters * 0.2), detection_duration_ms: duration,
            triggered_by: 'Mock Data Generator', status: 'completed'
          });

          return c.json({ success: true, stats: { clusters: totalClusters, leads: totalLeads, deals: totalDeals, duration_ms: duration } });
        } catch (error: any) {
          console.error('Error generating mock data:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
        }
      };
    },
  },
  // A6: Added RBAC guard
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
  // B5: Replaced N+1 export with JOIN-based query
  {
    path: "/api/duplicates/export",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const url = new URL(c.req.url);
          const exportType = url.searchParams.get('type') || 'all';
          const owner = url.searchParams.get('owner');
          const startDate = url.searchParams.get('start_date');
          const endDate = url.searchParams.get('end_date');

          const records = await getExportRecords({
            owner: owner || undefined,
            start_date: startDate || undefined,
            end_date: endDate || undefined,
            record_type: exportType === 'all' ? undefined : exportType,
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
  // B5: Replaced N+1 leads with JOIN-based paginated query
  {
    path: "/api/duplicates/leads",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const url = new URL(c.req.url);
          const limit = parseInt(url.searchParams.get('limit') || '100');
          const offset = parseInt(url.searchParams.get('offset') || '0');
          const sort_by = url.searchParams.get('sort_by') || 'total_records';
          const sort_order = url.searchParams.get('sort_order') || 'desc';
          const start_date = url.searchParams.get('start_date') || undefined;
          const end_date = url.searchParams.get('end_date') || undefined;

          const result = await getDuplicateRecordsByType('lead', { limit, offset, sort_by, sort_order, start_date, end_date });
          return c.json({ total_duplicate_groups: result.total, groups: result.groups });
        } catch (error: any) {
          console.error('Error fetching lead duplicates:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
        }
      };
    },
  },
  // B5: Replaced N+1 deals with JOIN-based paginated query
  {
    path: "/api/duplicates/deals",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const url = new URL(c.req.url);
          const limit = parseInt(url.searchParams.get('limit') || '100');
          const offset = parseInt(url.searchParams.get('offset') || '0');
          const sort_by = url.searchParams.get('sort_by') || 'total_records';
          const sort_order = url.searchParams.get('sort_order') || 'desc';
          const start_date = url.searchParams.get('start_date') || undefined;
          const end_date = url.searchParams.get('end_date') || undefined;

          const result = await getDuplicateRecordsByType('deal', { limit, offset, sort_by, sort_order, start_date, end_date });
          return c.json({ total_duplicate_groups: result.total, groups: result.groups });
        } catch (error: any) {
          console.error('Error fetching deal duplicates:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
        }
      };
    },
  },
  // C2: Account Duplicates endpoint
  {
    path: "/api/duplicates/accounts",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const url = new URL(c.req.url);
          const limit = parseInt(url.searchParams.get('limit') || '100');
          const offset = parseInt(url.searchParams.get('offset') || '0');
          const result = await getDuplicateRecordsByType('account', { limit, offset });
          return c.json({ total_duplicate_groups: result.total, groups: result.groups });
        } catch (error: any) {
          console.error('Error fetching account duplicates:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
        }
      };
    },
  },
  // C2: Contact Duplicates endpoint
  {
    path: "/api/duplicates/contacts",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const url = new URL(c.req.url);
          const limit = parseInt(url.searchParams.get('limit') || '100');
          const offset = parseInt(url.searchParams.get('offset') || '0');
          const result = await getDuplicateRecordsByType('contact', { limit, offset });
          return c.json({ total_duplicate_groups: result.total, groups: result.groups });
        } catch (error: any) {
          console.error('Error fetching contact duplicates:', error);
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
          const cluster = await getClusterById(clusterId);
          if (!cluster) return c.json({ error: 'Cluster not found' }, 404);

          const records = await getRecordsByClusterId(clusterId);
          const smart = generateSmartRecommendation(records);

          return c.json({
            cluster_id: clusterId,
            domain: cluster.domain,
            total_records: records.length,
            primary_id: smart.primary_id,
            primary_type: smart.primary_type,
            is_cross_module: smart.is_cross_module,
            recommendations: smart.recommendations,
            ai_summary: smart.summary
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
          if (!email) return c.json({ error: 'Missing required fields' }, 400);

          const emailDomain = email.split('@')[1]?.toLowerCase();
          if (!emailDomain) return c.json({ error: 'Invalid email format' }, 400);

          const publicDomains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com', 'live.com'];
          if (publicDomains.includes(emailDomain)) {
            return c.json({ error: 'Public email domains are excluded from duplicate detection. Use a company domain.' }, 400);
          }

          const cluster = await findOrCreateClusterByDomain(emailDomain);
          const recordName = record_type === 'lead'
            ? `${first_name || ''} ${last_name || ''}`.trim() || 'Unknown Lead'
            : deal_name || 'Unknown Deal';
          const ownerName = owner_email ? owner_email.split('@')[0].replace(/\./g, ' ').replace(/^\w/, (ch: string) => ch.toUpperCase()) : 'Unknown';

          await addRecordToCluster({
            cluster_id: cluster.id!, zoho_record_id: `test_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            record_type: record_type || 'lead', record_name: recordName, email, domain: emailDomain,
            company_name: company || undefined, owner_name: ownerName, owner_email: owner_email || undefined,
            deal_value: record_type === 'deal' ? (amount || 0) : undefined,
            source: 'Sandbox Test', created_date: new Date(), modified_date: new Date(),
            is_primary: false, confidence_score: 95, is_mock_data: true
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
          const { domain, phone, company_name, contract_number, email, record_name, owner_email } = params;
          if (!domain && !phone && !company_name && !contract_number && !email && !record_name && !owner_email) {
            return c.json({ error: 'Missing required fields' }, 400);
          }
          const results = await searchDuplicates({ domain, phone, company_name, contract_number, email, record_name, owner_email });
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
          if (!action || !['resolve', 'ignore'].includes(action)) return c.json({ error: 'action must be "resolve" or "ignore"' }, 400);
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
          if (!email && !phone && !company_name) return c.json({ error: 'Provide at least one of: email, phone, company_name' }, 400);
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
  // C5: Auto-resolve endpoint
  {
    path: "/api/duplicates/auto-resolve",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireAdminOrKey(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const body = await c.req.json().catch(() => ({}));
          const result = await autoResolveClusters({
            min_confidence: body.min_confidence,
            auto_ignore_singletons: body.auto_ignore_singletons
          });
          return c.json({ success: true, ...result });
        } catch (error: any) {
          console.error('Error auto-resolving:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
        }
      };
    },
  },
  // ── Filter metadata endpoints ──
  {
    path: "/api/duplicates/filter-meta",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const [owners, layouts, domains, products, pipelines, syncState] = await Promise.all([
            getDistinctOwners(),
            getDistinctLayouts(),
            getDistinctDomains(),
            getDistinctProducts(),
            getDistinctPipelines(),
            getSyncState(),
          ]);
          return c.json({ owners, layouts, domains, products, pipelines, syncState });
        } catch (error: any) {
          console.error('Error fetching filter metadata:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/sync-state",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const state = await getSyncState();
          return c.json({ modules: state });
        } catch (error: any) {
          return c.json({ error: 'An internal error occurred' }, 500);
        }
      };
    },
  },
  // ── Filtered clusters and summary ──
  {
    path: "/api/duplicates/filtered-clusters",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const url = new URL(c.req.url);
          const filters: DuplicateFilters = {
            module: url.searchParams.get('module') || undefined,
            layout: url.searchParams.get('layout') || undefined,
            owner: url.searchParams.get('owner') || undefined,
            start_date: url.searchParams.get('start_date') || undefined,
            end_date: url.searchParams.get('end_date') || undefined,
            domain: url.searchParams.get('domain') || undefined,
            products: url.searchParams.get('products') || undefined,
            pipeline: url.searchParams.get('pipeline') || undefined,
            status: url.searchParams.get('status') || undefined,
            confidence_level: url.searchParams.get('confidence_level') || undefined,
            limit: parseInt(url.searchParams.get('limit') || '100'),
            offset: parseInt(url.searchParams.get('offset') || '0'),
          };
          const result = await getFilteredClusters(filters);
          return c.json(result);
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
            module: url.searchParams.get('module') || undefined,
            layout: url.searchParams.get('layout') || undefined,
            owner: url.searchParams.get('owner') || undefined,
            start_date: url.searchParams.get('start_date') || undefined,
            end_date: url.searchParams.get('end_date') || undefined,
            domain: url.searchParams.get('domain') || undefined,
            products: url.searchParams.get('products') || undefined,
            pipeline: url.searchParams.get('pipeline') || undefined,
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
  // ── Tasks for cluster ──
  {
    path: "/api/duplicates/clusters/:id/tasks",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const clusterId = parseInt(c.req.param('id'));
          const records = await getRecordsByClusterId(clusterId);
          const zohoIds = records.map(r => r.zoho_record_id).filter(Boolean) as string[];
          const tasks = await getTasksForRecords(zohoIds);
          const taskCount = await getTaskCountForCluster(clusterId);
          return c.json({ tasks, total: taskCount });
        } catch (error: any) {
          console.error('Error fetching cluster tasks:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
        }
      };
    },
  },
  // Data quality stats endpoint
  {
    path: "/api/duplicates/data-quality",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const stats = await getDataQualityStats();
          return c.json(stats);
        } catch (error: any) {
          console.error('Error fetching data quality stats:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
        }
      };
    },
  },
];

export default duplicateRadarRoutes;
