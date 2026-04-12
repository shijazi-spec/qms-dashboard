import { join } from "path";
import { readFileSync, existsSync } from "fs";

let scanState: {
  status: 'idle' | 'running' | 'complete' | 'error';
  progress?: string;
  startedAt?: number;
  result?: any;
  error?: string;
} = { status: 'idle' };

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
  findOrCreateClusterByDomain,
  updateClusterStats,
  searchDuplicates,
  createCluster,
  clearAllDuplicateData,
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
} from '../../utils/duplicateRadarDatabase';

import { fetchAllZohoRecords } from '../../utils/zohoCRM';

const SCAN_MAX_PER_MODULE = 20000;

async function processModule(
  moduleName: string,
  recordType: 'lead' | 'deal' | 'contact' | 'account',
  clustersUpdated: Set<number>,
  extractRecord: (record: any) => { companyName: string; email: string; phone: string; recordName: string; domain: string | null; ownerName: string; ownerEmail: string; status: string; stage?: string; dealValue?: number; source: string; createdTime: string; modifiedTime: string }
): Promise<{ count: number }> {
  let records: any[] = [];
  try {
    records = await fetchAllZohoRecords(moduleName, { maxRecords: SCAN_MAX_PER_MODULE });
  } catch (e) {
    console.error(`Error fetching ${moduleName}:`, e);
    return { count: 0 };
  }

  console.log(`📥 [DuplicateRadar] Fetched ${records.length} ${moduleName} from Zoho`);

  for (const record of records) {
    const data = extractRecord(record);
    if (!data.companyName || data.companyName === 'Unknown') continue;

    const cluster = await findOrCreateClusterByCompany(
      data.companyName, data.domain || undefined, data.phone || undefined, data.email || undefined
    );

    const phoneNormalized = data.phone ? normalizePhone(data.phone) : undefined;

    await addRecordToCluster({
      cluster_id: cluster.id!,
      record_type: recordType,
      zoho_record_id: record.id,
      record_name: data.recordName,
      company_name: data.companyName,
      email: data.email || undefined,
      domain: data.domain || undefined,
      phone: data.phone || undefined,
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
      raw_data: record.data
    });

    if (phoneNormalized) {
      await (await import('../../utils/duplicateRadarDatabase')).pool.query(
        'UPDATE duplicate_records SET phone_normalized = $1 WHERE cluster_id = $2 AND zoho_record_id = $3',
        [phoneNormalized, cluster.id, record.id]
      ).catch(() => {});
    }

    clustersUpdated.add(cluster.id!);
  }
  return { count: records.length };
}

async function scanZohoCRMForDuplicates(detectionType: 'manual' | 'scheduled' = 'manual', onProgress?: (msg: string) => void): Promise<{
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

  try {
    const report = (msg: string) => { onProgress?.(msg); console.log(`📊 [DuplicateRadar] ${msg}`); };
    report('Clearing old data...');
    await clearAllDuplicateData();

    const moduleBreakdown: any[] = [];
    let totalRecords = 0;
    const clustersUpdated = new Set<number>();

    report('Scanning Leads module...');
    const leadsResult = await processModule('Leads', 'lead', clustersUpdated, (record) => {
      const d = record.data;
      return {
        companyName: d.Company || d.Last_Name || 'Unknown',
        email: d.Email || '',
        phone: d.Phone || d.Mobile || '',
        recordName: d.Full_Name || `${d.First_Name || ''} ${d.Last_Name || ''}`.trim(),
        domain: extractDomain(d.Email || ''),
        ownerName: d.Owner?.name || 'Unknown',
        ownerEmail: d.Owner?.email || '',
        status: d.Lead_Status || '',
        source: d.Lead_Source || '',
        createdTime: d.Created_Time || '',
        modifiedTime: d.Modified_Time || ''
      };
    });
    totalRecords += leadsResult.count;
    moduleBreakdown.push({ module: 'Leads', count: leadsResult.count });

    report(`Leads done (${leadsResult.count} records). Scanning Deals module...`);
    const dealsResult = await processModule('Deals', 'deal', clustersUpdated, (record) => {
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
        modifiedTime: d.Modified_Time || ''
      };
    });
    totalRecords += dealsResult.count;
    moduleBreakdown.push({ module: 'Deals', count: dealsResult.count });

    report(`Deals done (${dealsResult.count} records). Scanning Contacts module...`);
    const contactsResult = await processModule('Contacts', 'contact', clustersUpdated, (record) => {
      const d = record.data;
      return {
        companyName: d.Account_Name?.name || d.Company || d.Last_Name || 'Unknown',
        email: d.Email || '',
        phone: d.Phone || d.Mobile || '',
        recordName: d.Full_Name || `${d.First_Name || ''} ${d.Last_Name || ''}`.trim(),
        domain: extractDomain(d.Email || ''),
        ownerName: d.Owner?.name || 'Unknown',
        ownerEmail: d.Owner?.email || '',
        status: 'Contact',
        source: d.Lead_Source || '',
        createdTime: d.Created_Time || '',
        modifiedTime: d.Modified_Time || ''
      };
    });
    totalRecords += contactsResult.count;
    moduleBreakdown.push({ module: 'Contacts', count: contactsResult.count });

    report(`Contacts done (${contactsResult.count} records). Scanning Accounts module...`);
    const accountsResult = await processModule('Accounts', 'account', clustersUpdated, (record) => {
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
        modifiedTime: d.Modified_Time || ''
      };
    });
    totalRecords += accountsResult.count;
    moduleBreakdown.push({ module: 'Accounts', count: accountsResult.count });

    report(`Accounts done (${accountsResult.count} records). Updating ${clustersUpdated.size} cluster stats...`);
    let processed = 0;
    for (const clusterId of clustersUpdated) {
      await updateClusterStats(clusterId);
      processed++;
      if (processed % 200 === 0) {
        report(`Updating cluster stats... ${processed}/${clustersUpdated.size}`);
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

    return {
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

  } catch (error: any) {
    console.error('❌ [DuplicateRadar] Scan error:', error);
    return {
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
    path: "/api/duplicates/scan-status",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        if (scanState.status === 'complete' || scanState.status === 'error') {
          const resp = { ...scanState };
          if (scanState.status === 'complete') {
            scanState = { status: 'idle' };
          }
          return c.json(resp);
        }
        return c.json(scanState);
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

          if (scanState.status === 'running') {
            return c.json({ success: true, status: 'already_running', progress: scanState.progress });
          }

          scanState = { status: 'running', progress: 'Initializing scan...', startedAt: Date.now() };

          scanZohoCRMForDuplicates('manual', (progress: string) => {
            scanState.progress = progress;
          }).then(result => {
            if (result.success) {
              scanState = {
                status: 'complete',
                result,
                totalRecordsScanned: result.totalRecordsScanned,
                totalClustersFound: result.totalClustersFound,
                duplicatesDetected: result.duplicatesDetected,
                moduleBreakdown: result.moduleBreakdown,
                durationMs: result.durationMs,
              } as any;
            } else {
              scanState = { status: 'error', error: result.error || 'Scan failed' };
            }
          }).catch(err => {
            console.error('[DuplicateRadar] Background scan error:', err);
            scanState = { status: 'error', error: 'Scan crashed unexpectedly' };
          });

          return c.json({ success: true, status: 'started', message: 'Scan started in background' });
        } catch (error: any) {
          console.error('Error starting scan:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
        }
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
            { domain: 'acme-corp.com', names: ['ACME Corporation', 'أكمي للشركات', 'Acme Corp', 'ACME Corp.'] },
            { domain: 'techsolutions.sa', names: ['Tech Solutions', 'تقنية الحلول', 'Tech Solutionss', 'TechSolutions SA'] },
            { domain: 'saudiarabia-invest.com', names: ['Saudi Arabia Investment', 'استثمارات السعودية', 'SA Invest', 'Saudi Invest'] },
            { domain: 'globaltrading.ae', names: ['Global Trading LLC', 'التجارة العالمية', 'Global Trade', 'GlobalTrading'] },
            { domain: 'constructionplus.sa', names: ['Construction Plus', 'البناء بلس', 'Construction+', 'ConstructionPlus SA'] },
            { domain: 'healthcare-ksa.com', names: ['Healthcare KSA', 'الرعاية الصحية', 'HealthCare Saudi', 'HC KSA'] },
            { domain: 'finance-hub.sa', names: ['Finance Hub', 'مركز التمويل', 'FinanceHub', 'Finance Hub SA'] },
            { domain: 'logistics-express.com', names: ['Logistics Express', 'اللوجستيات السريعة', 'LogisticsExpress', 'Logistics Xpress'] },
            { domain: 'retail-kingdom.sa', names: ['Retail Kingdom', 'مملكة التجزئة', 'RetailKingdom', 'Retail Kingdum'] },
            { domain: 'energy-solutions.sa', names: ['Energy Solutions', 'حلول الطاقة', 'EnergySolutions', 'Energy Sol'] },
            { domain: 'pharma-gulf.com', names: ['Pharma Gulf', 'فارما الخليج', 'PharmaGulf', 'Pharma-Gulf Ltd'] },
            { domain: 'automotive-sa.com', names: ['Automotive SA', 'السيارات السعودية', 'Auto SA', 'AutomotiveSA'] },
            { domain: 'telecom-arabia.sa', names: ['Telecom Arabia', 'اتصالات العربية', 'TelecomArabia', 'Telcom Arabia'] },
            { domain: 'food-industries.sa', names: ['Food Industries', 'الصناعات الغذائية', 'FoodInd', 'Food Ind. SA'] },
            { domain: 'education-center.sa', names: ['Education Center', 'مركز التعليم', 'EduCenter', 'Education Centr'] }
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

          let totalLeads = 0;
          let totalDeals = 0;
          let totalClusters = 0;

          for (const company of companies) {
            const cluster = await findOrCreateClusterByDomain(company.domain);
            totalClusters++;

            const numLeads = Math.floor(Math.random() * 5) + 2;
            const numDeals = Math.floor(Math.random() * 3) + 1;

            for (let i = 0; i < numLeads; i++) {
              const owner = owners[Math.floor(Math.random() * owners.length)];
              const nameVariation = company.names[Math.floor(Math.random() * company.names.length)];
              const createdDate = new Date(Date.now() - Math.random() * 180 * 24 * 60 * 60 * 1000);
              
              await addRecordToCluster({
                cluster_id: cluster.id!,
                record_type: 'lead',
                zoho_record_id: `LEAD_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                record_name: `Lead - ${nameVariation}`,
                company_name: nameVariation,
                email: `contact${i + 1}@${company.domain}`,
                domain: company.domain,
                phone: `+966 5${Math.floor(Math.random() * 90000000 + 10000000)}`,
                owner_name: owner.name,
                owner_email: owner.email,
                status: leadStatuses[Math.floor(Math.random() * leadStatuses.length)],
                source: sources[Math.floor(Math.random() * sources.length)],
                created_date: createdDate,
                modified_date: new Date(createdDate.getTime() + Math.random() * 30 * 24 * 60 * 60 * 1000),
                is_primary: i === 0,
                confidence_score: 75 + Math.floor(Math.random() * 25),
                is_mock_data: true,
                raw_data: { mock: true, generated_at: new Date().toISOString() }
              });
              totalLeads++;
            }

            for (let i = 0; i < numDeals; i++) {
              const owner = owners[Math.floor(Math.random() * owners.length)];
              const nameVariation = company.names[Math.floor(Math.random() * company.names.length)];
              const createdDate = new Date(Date.now() - Math.random() * 120 * 24 * 60 * 60 * 1000);
              const dealValue = Math.floor(Math.random() * 500000) + 50000;
              
              await addRecordToCluster({
                cluster_id: cluster.id!,
                record_type: 'deal',
                zoho_record_id: `DEAL_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                record_name: `Deal - ${nameVariation}`,
                company_name: nameVariation,
                email: `sales@${company.domain}`,
                domain: company.domain,
                phone: `+966 5${Math.floor(Math.random() * 90000000 + 10000000)}`,
                owner_name: owner.name,
                owner_email: owner.email,
                stage: dealStages[Math.floor(Math.random() * dealStages.length)],
                deal_value: dealValue,
                source: sources[Math.floor(Math.random() * sources.length)],
                created_date: createdDate,
                modified_date: new Date(createdDate.getTime() + Math.random() * 30 * 24 * 60 * 60 * 1000),
                is_primary: i === 0,
                confidence_score: 80 + Math.floor(Math.random() * 20),
                is_mock_data: true,
                raw_data: { mock: true, generated_at: new Date().toISOString() }
              });
              totalDeals++;
            }

            await updateClusterStats(cluster.id!);
          }

          const duration = Date.now() - startTime;

          await createDetectionLog({
            detection_type: 'manual',
            total_records_scanned: totalLeads + totalDeals,
            total_clusters_found: totalClusters,
            total_duplicates_detected: totalLeads + totalDeals - totalClusters,
            high_confidence_count: Math.floor(totalClusters * 0.4),
            medium_confidence_count: Math.floor(totalClusters * 0.4),
            low_confidence_count: Math.floor(totalClusters * 0.2),
            estimated_pipeline_inflation: 0,
            detection_duration_ms: duration,
            triggered_by: 'Mock Data Generator',
            status: 'completed'
          });

          return c.json({
            success: true,
            message: 'Mock data generated successfully',
            stats: {
              clusters: totalClusters,
              leads: totalLeads,
              deals: totalDeals,
              duration_ms: duration
            }
          });
        } catch (error: any) {
          console.error('Error generating mock data:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/mock-data",
    method: "DELETE" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          await clearMockData();
          return c.json({ success: true, message: 'Mock data cleared' });
        } catch (error: any) {
          console.error('Error clearing mock data:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
        }
      };
    },
  },
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

          let clusters = await getAllClusters({ status: 'active' });
          let records: any[] = [];

          for (const cluster of clusters) {
            const clusterRecords = await getRecordsByClusterId(cluster.id!);
            records.push(...clusterRecords.map(r => ({
              ...r,
              cluster_domain: cluster.domain,
              cluster_confidence: cluster.confidence_level
            })));
          }

          if (owner) {
            records = records.filter(r => r.owner_name === owner || r.owner_email === owner);
          }
          if (startDate) {
            records = records.filter(r => new Date(r.created_date) >= new Date(startDate));
          }
          if (endDate) {
            records = records.filter(r => new Date(r.created_date) <= new Date(endDate));
          }

          await createExportLog({
            export_type: exportType as any,
            filter_criteria: { owner, startDate, endDate },
            total_records_exported: records.length,
            file_format: 'excel',
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
  {
    path: "/api/duplicates/leads",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const clusters = await getAllClusters({ status: 'active' });
          const leadsWithDuplicates: any[] = [];

          for (const cluster of clusters) {
            if (cluster.total_leads > 1) {
              const records = await getRecordsByClusterId(cluster.id!);
              const leads = records.filter(r => r.record_type === 'lead');
              leadsWithDuplicates.push({
                cluster,
                leads,
                duplicate_count: leads.length
              });
            }
          }

          return c.json({
            total_duplicate_groups: leadsWithDuplicates.length,
            groups: leadsWithDuplicates
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
          const clusters = await getAllClusters({ status: 'active' });
          const dealsWithDuplicates: any[] = [];

          for (const cluster of clusters) {
            if (cluster.total_deals > 1) {
              const records = await getRecordsByClusterId(cluster.id!);
              const deals = records.filter(r => r.record_type === 'deal');
              dealsWithDuplicates.push({
                cluster,
                deals,
                duplicate_count: deals.length,
                total_value: deals.reduce((sum, d) => sum + (parseFloat(String(d.deal_value)) || 0), 0)
              });
            }
          }

          return c.json({
            total_duplicate_groups: dealsWithDuplicates.length,
            groups: dealsWithDuplicates
          });
        } catch (error: any) {
          console.error('Error fetching deal duplicates:', error);
          return c.json({ error: 'An internal error occurred' }, 500);
        }
      };
    },
  },
  {
    path: "/api/duplicates/ai-recommendations/:clusterId",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const clusterId = parseInt(c.req.param('clusterId'));
          const cluster = await getClusterById(clusterId);
          if (!cluster) {
            return c.json({ error: 'Cluster not found' }, 404);
          }

          const records = await getRecordsByClusterId(clusterId);
          
          const sortedRecords = [...records].sort((a, b) => {
            const dateA = new Date(a.created_date || 0).getTime();
            const dateB = new Date(b.created_date || 0).getTime();
            return dateA - dateB;
          });

          const primaryRecord = sortedRecords[0];
          const recommendations = sortedRecords.map((record, index) => ({
            record_id: record.id,
            record_name: record.record_name,
            is_primary: index === 0,
            recommendation: index === 0 
              ? 'KEEP as primary record (earliest created)'
              : record.record_type === 'lead' && sortedRecords.some(r => r.record_type === 'deal')
                ? 'CLOSE as duplicate (Deal exists for this company)'
                : 'MERGE into primary or CLOSE as duplicate',
            action_type: index === 0 ? 'keep' : 'merge_or_close',
            confidence: index === 0 ? 95 : 85
          }));

          return c.json({
            cluster_id: clusterId,
            domain: cluster.domain,
            primary_record: primaryRecord,
            total_records: records.length,
            recommendations,
            ai_summary: `Found ${records.length} records for ${cluster.domain}. Recommend keeping the earliest record (${primaryRecord?.record_name}) as primary. ${records.length - 1} duplicate(s) should be reviewed for merge or closure.`
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
];

export default duplicateRadarRoutes;
