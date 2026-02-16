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
  findOrCreateClusterByDomain,
  updateClusterStats,
  searchDuplicates,
  createCluster,
  clearAllDuplicateData,
  findOrCreateClusterByCompany,
  extractDomain,
} from '../../utils/duplicateRadarDatabase';

import { fetchZohoRecords } from '../../utils/zohoCRM';

async function scanZohoCRMForDuplicates(): Promise<{
  success: boolean;
  totalRecordsScanned: number;
  totalClustersFound: number;
  duplicatesDetected: number;
  moduleBreakdown: any[];
  durationMs: number;
  error?: string;
}> {
  const startTime = Date.now();
  console.log('🔍 [DuplicateRadar] Starting Zoho CRM duplicate scan...');

  try {
    await clearAllDuplicateData();

    const moduleBreakdown: any[] = [];
    let totalRecords = 0;
    let clustersUpdated = new Set<number>();

    const [leadsRecords, dealsRecords, contactsRecords, accountsRecords] = await Promise.all([
      fetchZohoRecords('Leads', { page: 1, perPage: 200 }).catch(e => { console.error('Error fetching Leads:', e); return []; }),
      fetchZohoRecords('Deals', { page: 1, perPage: 200 }).catch(e => { console.error('Error fetching Deals:', e); return []; }),
      fetchZohoRecords('Contacts', { page: 1, perPage: 200 }).catch(e => { console.error('Error fetching Contacts:', e); return []; }),
      fetchZohoRecords('Accounts', { page: 1, perPage: 200 }).catch(e => { console.error('Error fetching Accounts:', e); return []; })
    ]);

    console.log(`📥 [DuplicateRadar] Fetched ${leadsRecords.length} Leads from Zoho`);
    
    for (const record of leadsRecords) {
      const lead = record.data;
      const companyName = lead.Company || lead.Last_Name || 'Unknown';
      const email = lead.Email || '';
      const domain = extractDomain(email);
      
      if (!companyName || companyName === 'Unknown') continue;

      const cluster = await findOrCreateClusterByCompany(companyName, domain || undefined);
      
      await addRecordToCluster({
        cluster_id: cluster.id!,
        record_type: 'lead',
        zoho_record_id: record.id,
        record_name: lead.Full_Name || `${lead.First_Name || ''} ${lead.Last_Name || ''}`.trim(),
        company_name: companyName,
        email: email,
        domain: domain || undefined,
        phone: lead.Phone || lead.Mobile,
        owner_name: lead.Owner?.name || 'Unknown',
        owner_email: lead.Owner?.email,
        status: lead.Lead_Status,
        source: lead.Lead_Source,
        created_date: lead.Created_Time ? new Date(lead.Created_Time) : new Date(),
        modified_date: lead.Modified_Time ? new Date(lead.Modified_Time) : new Date(),
        is_primary: false,
        confidence_score: 85,
        is_mock_data: false,
        raw_data: lead
      });
      
      clustersUpdated.add(cluster.id!);
      totalRecords++;
    }
    moduleBreakdown.push({ module: 'Leads', count: leadsRecords.length });

    console.log(`📥 [DuplicateRadar] Fetched ${dealsRecords.length} Deals from Zoho`);
    
    for (const record of dealsRecords) {
      const deal = record.data;
      const companyName = deal.Account_Name?.name || deal.Deal_Name || 'Unknown';
      const email = deal.Contact_Email || '';
      const domain = extractDomain(email);
      
      if (!companyName || companyName === 'Unknown') continue;

      const cluster = await findOrCreateClusterByCompany(companyName, domain || undefined);
      
      await addRecordToCluster({
        cluster_id: cluster.id!,
        record_type: 'deal',
        zoho_record_id: record.id,
        record_name: deal.Deal_Name || 'Unknown Deal',
        company_name: companyName,
        email: email,
        domain: domain || undefined,
        phone: deal.Contact_Phone,
        owner_name: deal.Owner?.name || 'Unknown',
        owner_email: deal.Owner?.email,
        stage: deal.Stage,
        deal_value: parseFloat(deal.Amount) || 0,
        source: deal.Lead_Source,
        created_date: deal.Created_Time ? new Date(deal.Created_Time) : new Date(),
        modified_date: deal.Modified_Time ? new Date(deal.Modified_Time) : new Date(),
        is_primary: false,
        confidence_score: 85,
        is_mock_data: false,
        raw_data: deal
      });
      
      clustersUpdated.add(cluster.id!);
      totalRecords++;
    }
    moduleBreakdown.push({ module: 'Deals', count: dealsRecords.length });

    console.log(`📥 [DuplicateRadar] Fetched ${contactsRecords.length} Contacts from Zoho`);
    
    for (const record of contactsRecords) {
      const contact = record.data;
      const companyName = contact.Account_Name?.name || contact.Company || contact.Last_Name || 'Unknown';
      const email = contact.Email || '';
      const domain = extractDomain(email);
      
      if (!companyName || companyName === 'Unknown') continue;

      const cluster = await findOrCreateClusterByCompany(companyName, domain || undefined);
      
      await addRecordToCluster({
        cluster_id: cluster.id!,
        record_type: 'lead',
        zoho_record_id: record.id,
        record_name: contact.Full_Name || `${contact.First_Name || ''} ${contact.Last_Name || ''}`.trim(),
        company_name: companyName,
        email: email,
        domain: domain || undefined,
        phone: contact.Phone || contact.Mobile,
        owner_name: contact.Owner?.name || 'Unknown',
        owner_email: contact.Owner?.email,
        status: 'Contact',
        source: contact.Lead_Source,
        created_date: contact.Created_Time ? new Date(contact.Created_Time) : new Date(),
        modified_date: contact.Modified_Time ? new Date(contact.Modified_Time) : new Date(),
        is_primary: false,
        confidence_score: 80,
        is_mock_data: false,
        raw_data: contact
      });
      
      clustersUpdated.add(cluster.id!);
      totalRecords++;
    }
    moduleBreakdown.push({ module: 'Contacts', count: contactsRecords.length });

    console.log(`📥 [DuplicateRadar] Fetched ${accountsRecords.length} Accounts from Zoho`);
    
    for (const record of accountsRecords) {
      const account = record.data;
      const companyName = account.Account_Name || 'Unknown';
      const email = account.Email || '';
      const domain = extractDomain(email) || account.Website?.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
      
      if (!companyName || companyName === 'Unknown') continue;

      const cluster = await findOrCreateClusterByCompany(companyName, domain || undefined);
      
      await addRecordToCluster({
        cluster_id: cluster.id!,
        record_type: 'lead',
        zoho_record_id: record.id,
        record_name: companyName,
        company_name: companyName,
        email: email,
        domain: domain || undefined,
        phone: account.Phone,
        owner_name: account.Owner?.name || 'Unknown',
        owner_email: account.Owner?.email,
        status: 'Account',
        source: 'Account',
        created_date: account.Created_Time ? new Date(account.Created_Time) : new Date(),
        modified_date: account.Modified_Time ? new Date(account.Modified_Time) : new Date(),
        is_primary: false,
        confidence_score: 80,
        is_mock_data: false,
        raw_data: account
      });
      
      clustersUpdated.add(cluster.id!);
      totalRecords++;
    }
    moduleBreakdown.push({ module: 'Accounts', count: accountsRecords.length });

    console.log(`📊 [DuplicateRadar] Updating stats for ${clustersUpdated.size} clusters...`);
    for (const clusterId of clustersUpdated) {
      await updateClusterStats(clusterId);
    }

    const allClusters = await getAllClusters({});
    const duplicateClusters = allClusters.filter(c => c.total_records > 1);
    const duplicateCount = duplicateClusters.reduce((sum, c) => sum + (c.total_records - 1), 0);

    const duration = Date.now() - startTime;

    const pipelineInflation = duplicateClusters.reduce((sum, c) => {
      const value = parseFloat(String(c.estimated_pipeline_value || '0')) || 0;
      return sum + value;
    }, 0);

    await createDetectionLog({
      detection_type: 'manual',
      total_records_scanned: totalRecords,
      total_clusters_found: clustersUpdated.size,
      total_duplicates_detected: duplicateCount,
      high_confidence_count: duplicateClusters.filter(c => c.confidence_level === 'high').length,
      medium_confidence_count: duplicateClusters.filter(c => c.confidence_level === 'medium').length,
      low_confidence_count: duplicateClusters.filter(c => c.confidence_level === 'low').length,
      estimated_pipeline_inflation: pipelineInflation,
      detection_duration_ms: duration,
      triggered_by: 'Zoho CRM Scan',
      status: 'completed',
      completed_at: new Date()
    });

    console.log(`✅ [DuplicateRadar] Scan complete: ${totalRecords} records, ${clustersUpdated.size} clusters, ${duplicateCount} duplicates found`);

    return {
      success: true,
      totalRecordsScanned: totalRecords,
      totalClustersFound: clustersUpdated.size,
      duplicatesDetected: duplicateCount,
      moduleBreakdown,
      durationMs: duration
    };

  } catch (error: any) {
    console.error('❌ [DuplicateRadar] Scan error:', error);
    return {
      success: false,
      totalRecordsScanned: 0,
      totalClustersFound: 0,
      duplicatesDetected: 0,
      moduleBreakdown: [],
      durationMs: Date.now() - startTime,
      error: error.message
    };
  }
}

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
          const summary = await getClusterSummary();
          const kpis = await getKPIMetrics();
          return c.json({ ...summary, kpis });
        } catch (error: any) {
          console.error('Error fetching summary:', error);
          return c.json({ error: error.message }, 500);
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
          return c.json({ error: error.message }, 500);
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
          return c.json({ error: error.message }, 500);
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
          return c.json({ error: error.message }, 500);
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
          return c.json({ error: error.message }, 500);
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
          return c.json({ error: error.message }, 500);
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
          return c.json({ error: error.message }, 500);
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
          return c.json({ error: error.message }, 500);
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
          return c.json({ error: error.message }, 500);
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
          console.log('🚀 [DuplicateRadar] Zoho CRM scan triggered via API');
          const result = await scanZohoCRMForDuplicates();
          
          if (result.success) {
            return c.json({
              success: true,
              message: `Scanned ${result.totalRecordsScanned} records from Zoho CRM`,
              totalRecordsScanned: result.totalRecordsScanned,
              totalClustersFound: result.totalClustersFound,
              duplicatesDetected: result.duplicatesDetected,
              moduleBreakdown: result.moduleBreakdown,
              durationMs: result.durationMs
            });
          } else {
            return c.json({
              success: false,
              error: result.error || 'Scan failed'
            }, 500);
          }
        } catch (error: any) {
          console.error('Error scanning Zoho CRM:', error);
          return c.json({ error: error.message }, 500);
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
          return c.json({ error: error.message }, 500);
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
          return c.json({ error: error.message }, 500);
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

          const csvHeader = 'Record ID,Type,Name,Company,Domain,Owner,Status/Stage,Value,Source,Created Date,Confidence,Recommendation\n';
          const csvRows = records.map(r => 
            `"${r.zoho_record_id || r.id}","${r.record_type}","${r.record_name}","${r.company_name}","${r.domain}","${r.owner_name}","${r.status || r.stage}","${r.deal_value || ''}","${r.source}","${r.created_date}","${r.confidence_score}%","${r.ai_recommendation || 'Review manually'}"`
          ).join('\n');

          c.header('Content-Type', 'text/csv');
          c.header('Content-Disposition', `attachment; filename="duplicate_radar_export_${Date.now()}.csv"`);
          return c.text(csvHeader + csvRows);
        } catch (error: any) {
          console.error('Error exporting data:', error);
          return c.json({ error: error.message }, 500);
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
          return c.json({ error: error.message }, 500);
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
          return c.json({ error: error.message }, 500);
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
          return c.json({ error: error.message }, 500);
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
            return c.json({ error: 'Email is required for duplicate detection' }, 400);
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
          return c.json({ error: error.message }, 500);
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
            return c.json({ error: 'At least one search criteria is required' }, 400);
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
          return c.json({ error: error.message }, 500);
        }
      };
    },
  },
];

export default duplicateRadarRoutes;
