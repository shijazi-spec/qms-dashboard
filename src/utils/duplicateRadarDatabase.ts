import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export interface DuplicateCluster {
  id?: number;
  domain: string;
  company_name?: string;
  company_name_arabic?: string;
  total_leads: number;
  total_deals: number;
  total_records: number;
  confidence_level: 'high' | 'medium' | 'low';
  confidence_score: number;
  first_record_date?: Date;
  latest_activity_date?: Date;
  owners_involved?: string[];
  estimated_pipeline_value?: number;
  status: 'active' | 'resolved' | 'ignored';
  ai_recommendation?: string;
  created_at?: Date;
  updated_at?: Date;
}

export interface DuplicateRecord {
  id?: number;
  cluster_id: number;
  record_type: 'lead' | 'deal';
  zoho_record_id?: string;
  record_name: string;
  company_name?: string;
  email?: string;
  domain?: string;
  phone?: string;
  owner_name?: string;
  owner_email?: string;
  status?: string;
  stage?: string;
  deal_value?: number;
  source?: string;
  created_date?: Date;
  modified_date?: Date;
  is_primary: boolean;
  ai_recommendation?: string;
  confidence_score: number;
  is_mock_data: boolean;
  raw_data?: any;
  created_at?: Date;
}

export interface DuplicateDetectionLog {
  id?: number;
  detection_type: 'manual' | 'scheduled' | 'on_demand';
  total_records_scanned: number;
  total_clusters_found: number;
  total_duplicates_detected: number;
  high_confidence_count: number;
  medium_confidence_count: number;
  low_confidence_count: number;
  estimated_pipeline_inflation?: number;
  detection_duration_ms?: number;
  triggered_by?: string;
  user_email?: string;
  status: 'running' | 'completed' | 'failed';
  error_message?: string;
  detection_config?: any;
  created_at?: Date;
  completed_at?: Date;
}

export interface DuplicateExportLog {
  id?: number;
  export_type: 'cluster' | 'owner' | 'time_period' | 'all';
  filter_criteria?: any;
  total_records_exported: number;
  file_format: 'excel' | 'csv';
  exported_by?: string;
  user_email?: string;
  created_at?: Date;
}

const PUBLIC_DOMAINS = [
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com',
  'aol.com', 'live.com', 'msn.com', 'mail.com', 'protonmail.com',
  'yandex.com', 'zoho.com', 'gmx.com', 'fastmail.com',
  'stc.com.sa', 'mobily.com.sa', 'zain.com.sa'
];

export function extractDomain(email: string): string | null {
  if (!email || typeof email !== 'string') return null;
  const match = email.toLowerCase().trim().match(/@([^@]+)$/);
  if (!match) return null;
  let domain = match[1].replace(/^www\./, '').trim();
  if (PUBLIC_DOMAINS.includes(domain)) return null;
  return domain;
}

export function normalizeDomain(domain: string): string {
  if (!domain) return '';
  return domain.toLowerCase().replace(/^www\./, '').trim();
}

export function calculateSimilarity(str1: string, str2: string): number {
  if (!str1 || !str2) return 0;
  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();
  if (s1 === s2) return 100;
  
  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;
  
  if (longer.length === 0) return 100;
  
  const editDistance = levenshteinDistance(s1, s2);
  return Math.round((1 - editDistance / longer.length) * 100);
}

function levenshteinDistance(s1: string, s2: string): number {
  const m = s1.length;
  const n = s2.length;
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]) + 1;
      }
    }
  }
  return dp[m][n];
}

export function getConfidenceLevel(score: number): 'high' | 'medium' | 'low' {
  if (score >= 90) return 'high';
  if (score >= 60) return 'medium';
  return 'low';
}

export async function initDuplicateRadarTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS duplicate_clusters (
      id SERIAL PRIMARY KEY,
      domain VARCHAR(255) NOT NULL,
      company_name VARCHAR(500),
      company_name_arabic VARCHAR(500),
      total_leads INTEGER DEFAULT 0,
      total_deals INTEGER DEFAULT 0,
      total_records INTEGER DEFAULT 0,
      confidence_level VARCHAR(20) DEFAULT 'medium',
      confidence_score INTEGER DEFAULT 0,
      first_record_date TIMESTAMP,
      latest_activity_date TIMESTAMP,
      owners_involved JSONB DEFAULT '[]',
      estimated_pipeline_value DECIMAL(15,2) DEFAULT 0,
      status VARCHAR(50) DEFAULT 'active',
      ai_recommendation TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS duplicate_records (
      id SERIAL PRIMARY KEY,
      cluster_id INTEGER REFERENCES duplicate_clusters(id) ON DELETE CASCADE,
      record_type VARCHAR(20) NOT NULL,
      zoho_record_id VARCHAR(100),
      record_name VARCHAR(500),
      company_name VARCHAR(500),
      email VARCHAR(255),
      domain VARCHAR(255),
      phone VARCHAR(100),
      owner_name VARCHAR(255),
      owner_email VARCHAR(255),
      status VARCHAR(100),
      stage VARCHAR(100),
      deal_value DECIMAL(15,2),
      source VARCHAR(255),
      created_date TIMESTAMP,
      modified_date TIMESTAMP,
      is_primary BOOLEAN DEFAULT FALSE,
      ai_recommendation TEXT,
      confidence_score INTEGER DEFAULT 0,
      is_mock_data BOOLEAN DEFAULT FALSE,
      raw_data JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS duplicate_detection_logs (
      id SERIAL PRIMARY KEY,
      detection_type VARCHAR(50) DEFAULT 'manual',
      total_records_scanned INTEGER DEFAULT 0,
      total_clusters_found INTEGER DEFAULT 0,
      total_duplicates_detected INTEGER DEFAULT 0,
      high_confidence_count INTEGER DEFAULT 0,
      medium_confidence_count INTEGER DEFAULT 0,
      low_confidence_count INTEGER DEFAULT 0,
      estimated_pipeline_inflation DECIMAL(15,2),
      detection_duration_ms INTEGER,
      triggered_by VARCHAR(255),
      user_email VARCHAR(255),
      status VARCHAR(50) DEFAULT 'running',
      error_message TEXT,
      detection_config JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS duplicate_export_logs (
      id SERIAL PRIMARY KEY,
      export_type VARCHAR(50) DEFAULT 'all',
      filter_criteria JSONB,
      total_records_exported INTEGER DEFAULT 0,
      file_format VARCHAR(20) DEFAULT 'excel',
      exported_by VARCHAR(255),
      user_email VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_duplicate_clusters_domain ON duplicate_clusters(domain)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_duplicate_clusters_status ON duplicate_clusters(status)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_duplicate_records_cluster ON duplicate_records(cluster_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_duplicate_records_type ON duplicate_records(record_type)
  `);
}

export async function createCluster(cluster: Omit<DuplicateCluster, 'id' | 'created_at' | 'updated_at'>): Promise<DuplicateCluster> {
  const result = await pool.query(
    `INSERT INTO duplicate_clusters 
     (domain, company_name, company_name_arabic, total_leads, total_deals, total_records, 
      confidence_level, confidence_score, first_record_date, latest_activity_date, 
      owners_involved, estimated_pipeline_value, status, ai_recommendation)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING *`,
    [
      cluster.domain, cluster.company_name, cluster.company_name_arabic,
      cluster.total_leads, cluster.total_deals, cluster.total_records,
      cluster.confidence_level, cluster.confidence_score,
      cluster.first_record_date, cluster.latest_activity_date,
      JSON.stringify(cluster.owners_involved || []),
      cluster.estimated_pipeline_value || 0, cluster.status,
      cluster.ai_recommendation
    ]
  );
  return result.rows[0];
}

export async function addRecordToCluster(record: Omit<DuplicateRecord, 'id' | 'created_at'>): Promise<DuplicateRecord> {
  const result = await pool.query(
    `INSERT INTO duplicate_records 
     (cluster_id, record_type, zoho_record_id, record_name, company_name, email, domain,
      phone, owner_name, owner_email, status, stage, deal_value, source, created_date,
      modified_date, is_primary, ai_recommendation, confidence_score, is_mock_data, raw_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
     RETURNING *`,
    [
      record.cluster_id, record.record_type, record.zoho_record_id, record.record_name,
      record.company_name, record.email, record.domain, record.phone,
      record.owner_name, record.owner_email, record.status, record.stage,
      record.deal_value, record.source, record.created_date, record.modified_date,
      record.is_primary, record.ai_recommendation, record.confidence_score,
      record.is_mock_data, JSON.stringify(record.raw_data || {})
    ]
  );
  return result.rows[0];
}

export async function getAllClusters(filters?: {
  status?: string;
  confidence_level?: string;
  limit?: number;
  offset?: number;
}): Promise<DuplicateCluster[]> {
  let query = 'SELECT * FROM duplicate_clusters WHERE 1=1';
  const params: any[] = [];
  let paramIndex = 1;

  if (filters?.status) {
    query += ` AND status = $${paramIndex++}`;
    params.push(filters.status);
  }
  if (filters?.confidence_level) {
    query += ` AND confidence_level = $${paramIndex++}`;
    params.push(filters.confidence_level);
  }

  query += ' ORDER BY total_records DESC, confidence_score DESC';

  if (filters?.limit) {
    query += ` LIMIT $${paramIndex++}`;
    params.push(filters.limit);
  }
  if (filters?.offset) {
    query += ` OFFSET $${paramIndex++}`;
    params.push(filters.offset);
  }

  const result = await pool.query(query, params);
  return result.rows;
}

export async function getClusterCount(filters?: {
  status?: string;
  confidence_level?: string;
}): Promise<number> {
  let query = 'SELECT COUNT(*) as total FROM duplicate_clusters WHERE 1=1';
  const params: any[] = [];
  let paramIndex = 1;

  if (filters?.status) {
    query += ` AND status = $${paramIndex++}`;
    params.push(filters.status);
  }
  if (filters?.confidence_level) {
    query += ` AND confidence_level = $${paramIndex++}`;
    params.push(filters.confidence_level);
  }

  const result = await pool.query(query, params);
  return parseInt(result.rows[0]?.total) || 0;
}

export async function getClusterById(id: number): Promise<DuplicateCluster | null> {
  const result = await pool.query('SELECT * FROM duplicate_clusters WHERE id = $1', [id]);
  return result.rows[0] || null;
}

export async function getRecordsByClusterId(clusterId: number): Promise<DuplicateRecord[]> {
  const result = await pool.query(
    'SELECT * FROM duplicate_records WHERE cluster_id = $1 ORDER BY is_primary DESC, created_date ASC',
    [clusterId]
  );
  return result.rows;
}

export async function getClusterSummary(): Promise<{
  totalClusters: number;
  totalDuplicateLeads: number;
  totalDuplicateDeals: number;
  highConfidence: number;
  mediumConfidence: number;
  lowConfidence: number;
  estimatedPipelineInflation: number;
  activeCount: number;
  resolvedCount: number;
}> {
  const result = await pool.query(`
    SELECT 
      COUNT(*) as total_clusters,
      COALESCE(SUM(total_leads), 0) as total_leads,
      COALESCE(SUM(total_deals), 0) as total_deals,
      COUNT(*) FILTER (WHERE confidence_level = 'high') as high_confidence,
      COUNT(*) FILTER (WHERE confidence_level = 'medium') as medium_confidence,
      COUNT(*) FILTER (WHERE confidence_level = 'low') as low_confidence,
      COALESCE(SUM(estimated_pipeline_value), 0) as pipeline_inflation,
      COUNT(*) FILTER (WHERE status = 'active') as active_count,
      COUNT(*) FILTER (WHERE status = 'resolved') as resolved_count
    FROM duplicate_clusters
  `);
  
  const row = result.rows[0];
  return {
    totalClusters: parseInt(row.total_clusters) || 0,
    totalDuplicateLeads: parseInt(row.total_leads) || 0,
    totalDuplicateDeals: parseInt(row.total_deals) || 0,
    highConfidence: parseInt(row.high_confidence) || 0,
    mediumConfidence: parseInt(row.medium_confidence) || 0,
    lowConfidence: parseInt(row.low_confidence) || 0,
    estimatedPipelineInflation: parseFloat(row.pipeline_inflation) || 0,
    activeCount: parseInt(row.active_count) || 0,
    resolvedCount: parseInt(row.resolved_count) || 0
  };
}

export async function getDuplicatesByOwner(): Promise<Array<{
  owner_name: string;
  owner_email: string;
  lead_count: number;
  deal_count: number;
  total_duplicates: number;
}>> {
  const result = await pool.query(`
    SELECT 
      owner_name,
      owner_email,
      COUNT(*) FILTER (WHERE record_type = 'lead') as lead_count,
      COUNT(*) FILTER (WHERE record_type = 'deal') as deal_count,
      COUNT(*) as total_duplicates
    FROM duplicate_records
    WHERE owner_name IS NOT NULL
    GROUP BY owner_name, owner_email
    ORDER BY total_duplicates DESC
  `);
  return result.rows;
}

export async function getDuplicatesBySource(): Promise<Array<{
  source: string;
  lead_count: number;
  deal_count: number;
  total: number;
}>> {
  const result = await pool.query(`
    SELECT 
      COALESCE(source, 'Unknown') as source,
      COUNT(*) FILTER (WHERE record_type = 'lead') as lead_count,
      COUNT(*) FILTER (WHERE record_type = 'deal') as deal_count,
      COUNT(*) as total
    FROM duplicate_records
    GROUP BY source
    ORDER BY total DESC
  `);
  return result.rows;
}

export async function updateClusterStatus(id: number, status: string): Promise<DuplicateCluster | null> {
  const result = await pool.query(
    'UPDATE duplicate_clusters SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
    [status, id]
  );
  return result.rows[0] || null;
}

export async function createDetectionLog(log: Omit<DuplicateDetectionLog, 'id' | 'created_at'>): Promise<DuplicateDetectionLog> {
  const result = await pool.query(
    `INSERT INTO duplicate_detection_logs 
     (detection_type, total_records_scanned, total_clusters_found, total_duplicates_detected,
      high_confidence_count, medium_confidence_count, low_confidence_count,
      estimated_pipeline_inflation, detection_duration_ms, triggered_by, user_email, 
      status, error_message, detection_config, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING *`,
    [
      log.detection_type, log.total_records_scanned, log.total_clusters_found,
      log.total_duplicates_detected, log.high_confidence_count, log.medium_confidence_count,
      log.low_confidence_count, log.estimated_pipeline_inflation, log.detection_duration_ms,
      log.triggered_by, log.user_email, log.status, log.error_message,
      JSON.stringify(log.detection_config || {}), log.completed_at
    ]
  );
  return result.rows[0];
}

export async function updateDetectionLog(id: number, updates: Partial<DuplicateDetectionLog>): Promise<DuplicateDetectionLog | null> {
  const setClauses: string[] = [];
  const params: any[] = [];
  let paramIndex = 1;

  if (updates.status !== undefined) {
    setClauses.push(`status = $${paramIndex++}`);
    params.push(updates.status);
  }
  if (updates.total_clusters_found !== undefined) {
    setClauses.push(`total_clusters_found = $${paramIndex++}`);
    params.push(updates.total_clusters_found);
  }
  if (updates.total_duplicates_detected !== undefined) {
    setClauses.push(`total_duplicates_detected = $${paramIndex++}`);
    params.push(updates.total_duplicates_detected);
  }
  if (updates.completed_at !== undefined) {
    setClauses.push(`completed_at = $${paramIndex++}`);
    params.push(updates.completed_at);
  }
  if (updates.detection_duration_ms !== undefined) {
    setClauses.push(`detection_duration_ms = $${paramIndex++}`);
    params.push(updates.detection_duration_ms);
  }
  if (updates.error_message !== undefined) {
    setClauses.push(`error_message = $${paramIndex++}`);
    params.push(updates.error_message);
  }

  if (setClauses.length === 0) return null;

  params.push(id);
  const result = await pool.query(
    `UPDATE duplicate_detection_logs SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    params
  );
  return result.rows[0] || null;
}

export async function getDetectionLogs(limit: number = 50): Promise<DuplicateDetectionLog[]> {
  const result = await pool.query(
    'SELECT * FROM duplicate_detection_logs ORDER BY created_at DESC LIMIT $1',
    [limit]
  );
  return result.rows;
}

export async function createExportLog(log: Omit<DuplicateExportLog, 'id' | 'created_at'>): Promise<DuplicateExportLog> {
  const result = await pool.query(
    `INSERT INTO duplicate_export_logs 
     (export_type, filter_criteria, total_records_exported, file_format, exported_by, user_email)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      log.export_type, JSON.stringify(log.filter_criteria || {}),
      log.total_records_exported, log.file_format, log.exported_by, log.user_email
    ]
  );
  return result.rows[0];
}

export async function clearMockData(): Promise<void> {
  await pool.query('DELETE FROM duplicate_records WHERE is_mock_data = true');
  await pool.query(`
    DELETE FROM duplicate_clusters 
    WHERE id NOT IN (SELECT DISTINCT cluster_id FROM duplicate_records WHERE cluster_id IS NOT NULL)
  `);
}

export async function getKPIMetrics(): Promise<{
  duplicateLeadRate: number;
  duplicateDealRate: number;
  domainsWithMultipleDeals: number;
  duplicateBySource: any[];
  duplicateByOwner: any[];
}> {
  const totalLeadsResult = await pool.query(`
    SELECT COUNT(*) as count FROM duplicate_records WHERE record_type = 'lead'
  `);
  const totalDealsResult = await pool.query(`
    SELECT COUNT(*) as count FROM duplicate_records WHERE record_type = 'deal'
  `);
  const duplicateLeadsResult = await pool.query(`
    SELECT COUNT(*) as count FROM duplicate_records dr
    JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
    WHERE dr.record_type = 'lead' AND dc.total_leads > 1 AND dr.is_primary = false
  `);
  const duplicateDealsResult = await pool.query(`
    SELECT COUNT(*) as count FROM duplicate_records dr
    JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
    WHERE dr.record_type = 'deal' AND dc.total_deals > 1 AND dr.is_primary = false
  `);
  const multiDealDomainsResult = await pool.query(`
    SELECT COUNT(*) as count FROM duplicate_clusters WHERE total_deals > 1
  `);

  const totalLeads = parseInt(totalLeadsResult.rows[0].count) || 1;
  const totalDeals = parseInt(totalDealsResult.rows[0].count) || 1;
  const duplicateLeads = parseInt(duplicateLeadsResult.rows[0].count) || 0;
  const duplicateDeals = parseInt(duplicateDealsResult.rows[0].count) || 0;

  return {
    duplicateLeadRate: Math.round((duplicateLeads / totalLeads) * 100),
    duplicateDealRate: Math.round((duplicateDeals / totalDeals) * 100),
    domainsWithMultipleDeals: parseInt(multiDealDomainsResult.rows[0].count) || 0,
    duplicateBySource: await getDuplicatesBySource(),
    duplicateByOwner: await getDuplicatesByOwner()
  };
}

export async function findOrCreateClusterByDomain(domain: string): Promise<DuplicateCluster> {
  const existing = await pool.query(
    'SELECT * FROM duplicate_clusters WHERE domain = $1',
    [domain]
  );
  
  if (existing.rows[0]) {
    return existing.rows[0];
  }

  return await createCluster({
    domain,
    total_leads: 0,
    total_deals: 0,
    total_records: 0,
    confidence_level: 'medium',
    confidence_score: 75,
    status: 'active'
  });
}

export async function updateClusterStats(clusterId: number): Promise<void> {
  const statsResult = await pool.query(`
    SELECT 
      COUNT(*) FILTER (WHERE record_type = 'lead') as lead_count,
      COUNT(*) FILTER (WHERE record_type = 'deal') as deal_count,
      COUNT(*) as total_count,
      COALESCE(SUM(deal_value), 0) as total_value,
      MIN(created_date) as first_date,
      MAX(COALESCE(modified_date, created_date)) as latest_date,
      ARRAY_AGG(DISTINCT owner_name) FILTER (WHERE owner_name IS NOT NULL) as owners
    FROM duplicate_records WHERE cluster_id = $1
  `, [clusterId]);

  const stats = statsResult.rows[0];
  const totalRecords = parseInt(stats.total_count) || 0;
  const confidenceScore = totalRecords > 3 ? 95 : (totalRecords > 1 ? 80 : 60);

  await pool.query(`
    UPDATE duplicate_clusters SET
      total_leads = $1,
      total_deals = $2,
      total_records = $3,
      estimated_pipeline_value = $4,
      first_record_date = $5,
      latest_activity_date = $6,
      owners_involved = $7,
      confidence_score = $8,
      confidence_level = $9,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = $10
  `, [
    parseInt(stats.lead_count) || 0,
    parseInt(stats.deal_count) || 0,
    totalRecords,
    parseFloat(stats.total_value) || 0,
    stats.first_date,
    stats.latest_date,
    JSON.stringify(stats.owners || []),
    confidenceScore,
    getConfidenceLevel(confidenceScore),
    clusterId
  ]);
}

export interface DuplicateSearchParams {
  domain?: string;
  phone?: string;
  company_name?: string;
  contract_number?: string;
  email?: string;
  record_name?: string;
  owner_email?: string;
}

export async function searchDuplicates(params: DuplicateSearchParams): Promise<{
  records: DuplicateRecord[];
  clusters: DuplicateCluster[];
  total_records: number;
  search_params: DuplicateSearchParams;
}> {
  const conditions: string[] = [];
  const queryParams: any[] = [];
  let paramIndex = 1;

  if (params.domain?.trim()) {
    conditions.push(`LOWER(dr.domain) LIKE LOWER($${paramIndex++})`);
    queryParams.push(`%${params.domain.trim()}%`);
  }

  if (params.phone?.trim()) {
    conditions.push(`REGEXP_REPLACE(dr.phone, '[^0-9+]', '', 'g') LIKE $${paramIndex++}`);
    queryParams.push(`%${params.phone.trim().replace(/[^0-9+]/g, '')}%`);
  }

  if (params.company_name?.trim()) {
    conditions.push(`(LOWER(dr.company_name) LIKE LOWER($${paramIndex}) OR LOWER(dc.company_name) LIKE LOWER($${paramIndex++}))`);
    queryParams.push(`%${params.company_name.trim()}%`);
  }

  if (params.contract_number?.trim()) {
    conditions.push(`dr.zoho_record_id LIKE $${paramIndex++}`);
    queryParams.push(`%${params.contract_number.trim()}%`);
  }

  if (params.email?.trim()) {
    conditions.push(`LOWER(dr.email) LIKE LOWER($${paramIndex++})`);
    queryParams.push(`%${params.email.trim()}%`);
  }

  if (params.record_name?.trim()) {
    conditions.push(`LOWER(dr.record_name) LIKE LOWER($${paramIndex++})`);
    queryParams.push(`%${params.record_name.trim()}%`);
  }

  if (params.owner_email?.trim()) {
    conditions.push(`LOWER(dr.owner_email) LIKE LOWER($${paramIndex++})`);
    queryParams.push(`%${params.owner_email.trim()}%`);
  }

  if (conditions.length === 0) {
    return { records: [], clusters: [], total_records: 0, search_params: params };
  }

  const whereClause = conditions.join(' OR ');

  const recordsResult = await pool.query(`
    SELECT dr.*, dc.domain as cluster_domain, dc.confidence_level, dc.total_records as cluster_total
    FROM duplicate_records dr
    LEFT JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
    WHERE ${whereClause}
    ORDER BY dr.confidence_score DESC, dr.created_at DESC
    LIMIT 200
  `, queryParams);

  const clusterIds = [...new Set(recordsResult.rows.map(r => r.cluster_id).filter(Boolean))];
  
  let clustersData: DuplicateCluster[] = [];
  if (clusterIds.length > 0) {
    const clustersResult = await pool.query(`
      SELECT * FROM duplicate_clusters 
      WHERE id = ANY($1)
      ORDER BY total_records DESC
    `, [clusterIds]);
    clustersData = clustersResult.rows;
  }

  return {
    records: recordsResult.rows,
    clusters: clustersData,
    total_records: recordsResult.rows.length,
    search_params: params
  };
}

export async function clearAllDuplicateData(): Promise<void> {
  console.log('🗑️ [DuplicateRadar] Clearing all duplicate data for fresh Zoho import...');
  await pool.query('DELETE FROM duplicate_records');
  await pool.query('DELETE FROM duplicate_clusters');
  console.log('✅ [DuplicateRadar] All duplicate data cleared');
}

export function normalizeCompanyName(name: string): string {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[^\w\s\u0600-\u06FF]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b(llc|ltd|inc|corp|company|group|co|sa|ksa|uae|ae)\b/gi, '')
    .trim();
}

export async function findOrCreateClusterByCompany(companyName: string, domain?: string): Promise<DuplicateCluster> {
  const normalizedName = normalizeCompanyName(companyName);
  
  if (domain) {
    const existingByDomain = await pool.query(
      'SELECT * FROM duplicate_clusters WHERE domain = $1',
      [domain]
    );
    if (existingByDomain.rows[0]) {
      return existingByDomain.rows[0];
    }
  }

  const existingByCompany = await pool.query(
    `SELECT * FROM duplicate_clusters 
     WHERE company_name ILIKE $1 
     OR company_name ILIKE $2`,
    [`%${normalizedName}%`, `%${companyName}%`]
  );
  
  if (existingByCompany.rows[0]) {
    return existingByCompany.rows[0];
  }

  const allClusters = await pool.query('SELECT * FROM duplicate_clusters');
  for (const cluster of allClusters.rows) {
    const clusterNormalized = normalizeCompanyName(cluster.company_name || '');
    if (clusterNormalized && normalizedName) {
      const similarity = calculateSimilarity(clusterNormalized, normalizedName);
      if (similarity >= 75) {
        console.log(`📎 [DuplicateRadar] Matched "${companyName}" to existing cluster "${cluster.company_name}" (${similarity}% similar)`);
        return cluster;
      }
    }
  }

  console.log(`➕ [DuplicateRadar] Creating new cluster for "${companyName}"`);
  return await createCluster({
    domain: domain || normalizedName.replace(/\s+/g, '-') + '.cluster',
    company_name: companyName,
    total_leads: 0,
    total_deals: 0,
    total_records: 0,
    confidence_level: 'medium',
    confidence_score: 75,
    status: 'active'
  });
}

export { pool };
