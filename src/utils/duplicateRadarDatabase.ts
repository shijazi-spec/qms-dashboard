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
  company_name_normalized?: string;
  total_leads: number;
  total_deals: number;
  total_contacts: number;
  total_accounts: number;
  total_records: number;
  confidence_level: 'high' | 'medium' | 'low';
  confidence_score: number;
  match_signals?: string[];
  first_record_date?: Date;
  latest_activity_date?: Date;
  owners_involved?: string[];
  estimated_pipeline_value?: number;
  status: 'active' | 'resolved' | 'ignored';
  ai_recommendation?: string;
  resolved_by?: string;
  resolved_at?: Date;
  created_at?: Date;
  updated_at?: Date;
}

export interface DuplicateRecord {
  id?: number;
  cluster_id: number;
  record_type: 'lead' | 'deal' | 'contact' | 'account';
  zoho_record_id?: string;
  record_name: string;
  company_name?: string;
  email?: string;
  domain?: string;
  phone?: string;
  phone_normalized?: string;
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
  match_signals?: string[];
  is_mock_data: boolean;
  raw_data?: any;
  created_at?: Date;
}

export interface MergeAction {
  id?: number;
  cluster_id: number;
  primary_record_id: number;
  merged_record_ids: number[];
  action_type: 'merge' | 'resolve' | 'ignore';
  performed_by?: string;
  notes?: string;
  created_at?: Date;
}

export interface OwnerAccountability {
  owner_name: string;
  owner_email: string;
  total_records: number;
  duplicate_records: number;
  duplicate_rate: number;
  clusters_involved: number;
  high_confidence_duplicates: number;
  estimated_waste_value: number;
  rag_status: 'green' | 'amber' | 'red';
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

export function normalizePhone(phone: string): string {
  if (!phone) return '';
  return phone.replace(/[\s\-\(\)\+\.]/g, '').replace(/^00/, '').replace(/^966/, '').slice(-9);
}

export interface MatchResult {
  score: number;
  signals: string[];
}

export function calculateMultiSignalScore(
  record1: { email?: string; domain?: string; phone?: string; company_name?: string },
  record2: { email?: string; domain?: string; phone?: string; company_name?: string }
): MatchResult {
  const signals: string[] = [];
  let score = 0;

  if (record1.email && record2.email && record1.email.toLowerCase() === record2.email.toLowerCase()) {
    score += 40;
    signals.push('exact_email');
  }

  if (record1.domain && record2.domain && record1.domain === record2.domain) {
    score += 25;
    signals.push('domain_match');
  }

  if (record1.phone && record2.phone) {
    const p1 = normalizePhone(record1.phone);
    const p2 = normalizePhone(record2.phone);
    if (p1 && p2 && p1.length >= 7 && p1 === p2) {
      score += 30;
      signals.push('phone_match');
    }
  }

  if (record1.company_name && record2.company_name) {
    const similarity = calculateSimilarity(
      normalizeCompanyName(record1.company_name),
      normalizeCompanyName(record2.company_name)
    );
    if (similarity >= 90) {
      score += 20;
      signals.push('company_exact');
    } else if (similarity >= 75) {
      score += 10;
      signals.push('company_fuzzy');
    }
  }

  return { score: Math.min(score, 100), signals };
}

export async function initDuplicateRadarTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS duplicate_clusters (
      id SERIAL PRIMARY KEY,
      domain VARCHAR(255) NOT NULL,
      company_name VARCHAR(500),
      company_name_arabic VARCHAR(500),
      company_name_normalized VARCHAR(500),
      total_leads INTEGER DEFAULT 0,
      total_deals INTEGER DEFAULT 0,
      total_contacts INTEGER DEFAULT 0,
      total_accounts INTEGER DEFAULT 0,
      total_records INTEGER DEFAULT 0,
      confidence_level VARCHAR(20) DEFAULT 'medium',
      confidence_score INTEGER DEFAULT 0,
      match_signals JSONB DEFAULT '[]',
      first_record_date TIMESTAMP,
      latest_activity_date TIMESTAMP,
      owners_involved JSONB DEFAULT '[]',
      estimated_pipeline_value DECIMAL(15,2) DEFAULT 0,
      status VARCHAR(50) DEFAULT 'active',
      ai_recommendation TEXT,
      resolved_by VARCHAR(255),
      resolved_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`ALTER TABLE duplicate_clusters ADD COLUMN IF NOT EXISTS total_contacts INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE duplicate_clusters ADD COLUMN IF NOT EXISTS total_accounts INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE duplicate_clusters ADD COLUMN IF NOT EXISTS match_signals JSONB DEFAULT '[]'`);
  await pool.query(`ALTER TABLE duplicate_clusters ADD COLUMN IF NOT EXISTS resolved_by VARCHAR(255)`);
  await pool.query(`ALTER TABLE duplicate_clusters ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP`);
  await pool.query(`ALTER TABLE duplicate_clusters ADD COLUMN IF NOT EXISTS company_name_normalized VARCHAR(500)`);

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
      phone_normalized VARCHAR(50),
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
      match_signals JSONB DEFAULT '[]',
      is_mock_data BOOLEAN DEFAULT FALSE,
      raw_data JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS phone_normalized VARCHAR(50)`);
  await pool.query(`ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS match_signals JSONB DEFAULT '[]'`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS duplicate_merge_actions (
      id SERIAL PRIMARY KEY,
      cluster_id INTEGER REFERENCES duplicate_clusters(id) ON DELETE CASCADE,
      primary_record_id INTEGER REFERENCES duplicate_records(id),
      merged_record_ids JSONB DEFAULT '[]',
      action_type VARCHAR(20) NOT NULL DEFAULT 'resolve',
      performed_by VARCHAR(255),
      notes TEXT,
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

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_duplicate_clusters_domain ON duplicate_clusters(domain)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_duplicate_clusters_status ON duplicate_clusters(status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_duplicate_records_cluster ON duplicate_records(cluster_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_duplicate_records_type ON duplicate_records(record_type)`);

  // B6: Additional performance indexes
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_duplicate_records_zoho_id ON duplicate_records(zoho_record_id) WHERE zoho_record_id IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_duplicate_records_email ON duplicate_records(LOWER(email)) WHERE email IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_duplicate_records_phone_norm ON duplicate_records(phone_normalized) WHERE phone_normalized IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_duplicate_records_domain ON duplicate_records(domain) WHERE domain IS NOT NULL`);

  // B4: pg_trgm for fuzzy matching
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_clusters_company_trgm ON duplicate_clusters USING GIN (company_name_normalized gin_trgm_ops)`);
  } catch (e) {
    console.log('⚠️ [DuplicateRadar] pg_trgm not available, falling back to Levenshtein matching');
  }
}

export async function createCluster(cluster: Omit<DuplicateCluster, 'id' | 'created_at' | 'updated_at'>): Promise<DuplicateCluster> {
  const companyNormalized = cluster.company_name ? normalizeCompanyName(cluster.company_name) : null;
  const result = await pool.query(
    `INSERT INTO duplicate_clusters 
     (domain, company_name, company_name_arabic, company_name_normalized, total_leads, total_deals, total_records, 
      confidence_level, confidence_score, first_record_date, latest_activity_date, 
      owners_involved, estimated_pipeline_value, status, ai_recommendation)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING *`,
    [
      cluster.domain, cluster.company_name, cluster.company_name_arabic, companyNormalized,
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

// A1: Incremental upsert for records (replaces destructive clearAllDuplicateData approach)
export async function upsertRecord(record: Omit<DuplicateRecord, 'id' | 'created_at'>): Promise<DuplicateRecord> {
  const phoneNorm = record.phone ? normalizePhone(record.phone) : null;
  const result = await pool.query(
    `INSERT INTO duplicate_records 
     (cluster_id, record_type, zoho_record_id, record_name, company_name, email, domain,
      phone, phone_normalized, owner_name, owner_email, status, stage, deal_value, source, created_date,
      modified_date, is_primary, ai_recommendation, confidence_score, is_mock_data, raw_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
     ON CONFLICT (zoho_record_id) WHERE zoho_record_id IS NOT NULL DO UPDATE SET
       cluster_id = EXCLUDED.cluster_id,
       record_name = EXCLUDED.record_name,
       company_name = EXCLUDED.company_name,
       email = EXCLUDED.email,
       domain = EXCLUDED.domain,
       phone = EXCLUDED.phone,
       phone_normalized = EXCLUDED.phone_normalized,
       owner_name = EXCLUDED.owner_name,
       owner_email = EXCLUDED.owner_email,
       status = EXCLUDED.status,
       stage = EXCLUDED.stage,
       deal_value = EXCLUDED.deal_value,
       source = EXCLUDED.source,
       modified_date = EXCLUDED.modified_date,
       raw_data = EXCLUDED.raw_data
     RETURNING *`,
    [
      record.cluster_id, record.record_type, record.zoho_record_id, record.record_name,
      record.company_name, record.email, record.domain, record.phone,
      phoneNorm,
      record.owner_name, record.owner_email, record.status, record.stage,
      record.deal_value, record.source, record.created_date, record.modified_date,
      record.is_primary, record.ai_recommendation, record.confidence_score,
      record.is_mock_data, JSON.stringify(record.raw_data || {})
    ]
  );
  return result.rows[0];
}

// A7: phone_normalized included directly in INSERT
export async function addRecordToCluster(record: Omit<DuplicateRecord, 'id' | 'created_at'>): Promise<DuplicateRecord> {
  const phoneNorm = record.phone ? normalizePhone(record.phone) : null;
  const result = await pool.query(
    `INSERT INTO duplicate_records 
     (cluster_id, record_type, zoho_record_id, record_name, company_name, email, domain,
      phone, phone_normalized, owner_name, owner_email, status, stage, deal_value, source, created_date,
      modified_date, is_primary, ai_recommendation, confidence_score, is_mock_data, raw_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
     RETURNING *`,
    [
      record.cluster_id, record.record_type, record.zoho_record_id, record.record_name,
      record.company_name, record.email, record.domain, record.phone,
      phoneNorm,
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
  start_date?: string;
  end_date?: string;
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
  if (filters?.start_date) {
    query += ` AND created_at >= $${paramIndex++}`;
    params.push(filters.start_date);
  }
  if (filters?.end_date) {
    query += ` AND created_at <= $${paramIndex++}`;
    params.push(filters.end_date + 'T23:59:59Z');
  }

  query += ' ORDER BY total_records DESC, confidence_score DESC';

  if (filters?.limit) {
    query += ` LIMIT $${paramIndex++}`;
    params.push(filters.limit);
  }
  if (filters?.offset !== undefined && filters?.offset !== null) {
    query += ` OFFSET $${paramIndex++}`;
    params.push(filters.offset);
  }

  const result = await pool.query(query, params);
  return result.rows;
}

export async function getClusterCount(filters?: {
  status?: string;
  confidence_level?: string;
  start_date?: string;
  end_date?: string;
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
  if (filters?.start_date) {
    query += ` AND created_at >= $${paramIndex++}`;
    params.push(filters.start_date);
  }
  if (filters?.end_date) {
    query += ` AND created_at <= $${paramIndex++}`;
    params.push(filters.end_date + 'T23:59:59Z');
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
    total_contacts: 0,
    total_accounts: 0,
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
      COUNT(*) FILTER (WHERE record_type = 'contact') as contact_count,
      COUNT(*) FILTER (WHERE record_type = 'account') as account_count,
      COUNT(*) as total_count,
      COALESCE(SUM(deal_value), 0) as total_value,
      MIN(created_date) as first_date,
      MAX(COALESCE(modified_date, created_date)) as latest_date,
      ARRAY_AGG(DISTINCT owner_name) FILTER (WHERE owner_name IS NOT NULL) as owners
    FROM duplicate_records WHERE cluster_id = $1
  `, [clusterId]);

  const stats = statsResult.rows[0];
  const totalRecords = parseInt(stats.total_count) || 0;

  const records = await pool.query(
    'SELECT email, domain, phone, phone_normalized, company_name FROM duplicate_records WHERE cluster_id = $1 LIMIT 50',
    [clusterId]
  );

  let bestScore = 0;
  const allSignals = new Set<string>();
  const recs = records.rows;

  if (recs.length > 1) {
    for (let i = 0; i < Math.min(recs.length, 20); i++) {
      for (let j = i + 1; j < Math.min(recs.length, 20); j++) {
        const match = calculateMultiSignalScore(recs[i], recs[j]);
        if (match.score > bestScore) bestScore = match.score;
        match.signals.forEach(s => allSignals.add(s));
      }
    }
  }

  let confidenceScore: number;
  if (totalRecords <= 1) {
    confidenceScore = 0;
  } else if (bestScore > 0) {
    confidenceScore = bestScore;
  } else {
    confidenceScore = totalRecords > 3 ? 65 : 55;
  }

  const inflationResult = await pool.query(`
    SELECT COALESCE(SUM(deal_value), 0) as inflation
    FROM duplicate_records
    WHERE cluster_id = $1 AND record_type = 'deal' AND is_primary = false AND deal_value > 0
  `, [clusterId]);
  const pipelineInflation = parseFloat(inflationResult.rows[0]?.inflation) || 0;

  const primaryCheck = await pool.query(
    'SELECT COUNT(*) as cnt FROM duplicate_records WHERE cluster_id = $1 AND is_primary = true', [clusterId]
  );
  if (parseInt(primaryCheck.rows[0].cnt) === 0 && totalRecords > 0) {
    const earliest = await pool.query(
      'SELECT id FROM duplicate_records WHERE cluster_id = $1 ORDER BY created_date ASC NULLS LAST LIMIT 1', [clusterId]
    );
    if (earliest.rows[0]) {
      await pool.query('UPDATE duplicate_records SET is_primary = true WHERE id = $1', [earliest.rows[0].id]);
    }
  }

  await pool.query(`
    UPDATE duplicate_clusters SET
      total_leads = $1,
      total_deals = $2,
      total_contacts = $3,
      total_accounts = $4,
      total_records = $5,
      estimated_pipeline_value = $6,
      first_record_date = $7,
      latest_activity_date = $8,
      owners_involved = $9,
      confidence_score = $10,
      confidence_level = $11,
      match_signals = $12,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = $13
  `, [
    parseInt(stats.lead_count) || 0,
    parseInt(stats.deal_count) || 0,
    parseInt(stats.contact_count) || 0,
    parseInt(stats.account_count) || 0,
    totalRecords,
    pipelineInflation,
    stats.first_date,
    stats.latest_date,
    JSON.stringify(stats.owners || []),
    confidenceScore,
    confidenceScore === 0 ? 'low' : getConfidenceLevel(confidenceScore),
    JSON.stringify(Array.from(allSignals)),
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

// A3: Fixed paramIndex bug for company_name
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
    const pi = paramIndex++;
    conditions.push(`(LOWER(dr.company_name) LIKE LOWER($${pi}) OR LOWER(dc.company_name) LIKE LOWER($${pi}))`);
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

// A1: Replaced destructive clear with incremental approach
export async function clearAllDuplicateData(): Promise<void> {
  const scanMode = process.env.DUPLICATE_SCAN_MODE || 'incremental';
  if (scanMode === 'full') {
    console.log('🗑️ [DuplicateRadar] FULL mode: Clearing all duplicate data for fresh Zoho import...');
    await pool.query('DELETE FROM duplicate_records');
    await pool.query('DELETE FROM duplicate_clusters');
    console.log('✅ [DuplicateRadar] All duplicate data cleared');
  } else {
    console.log('♻️ [DuplicateRadar] INCREMENTAL mode: Marking existing records as stale...');
    await markStaleRecords();
  }
}

// A1: Mark records as stale before incremental scan
export async function markStaleRecords(): Promise<number> {
  const result = await pool.query(`
    UPDATE duplicate_records SET match_signals = match_signals || '["stale_pending"]'::jsonb
    WHERE is_mock_data = false AND NOT (match_signals @> '["stale_pending"]'::jsonb)
  `);
  console.log(`📌 [DuplicateRadar] Marked ${result.rowCount} records as stale`);
  return result.rowCount || 0;
}

// A1: Remove records that were stale and not refreshed
export async function cleanupStaleRecords(): Promise<number> {
  const result = await pool.query(`
    DELETE FROM duplicate_records 
    WHERE match_signals @> '["stale_pending"]'::jsonb AND is_mock_data = false
  `);
  console.log(`🧹 [DuplicateRadar] Cleaned up ${result.rowCount} stale records`);
  return result.rowCount || 0;
}

// A1: Remove orphan clusters with no records
export async function cleanupOrphanClusters(): Promise<number> {
  const result = await pool.query(`
    DELETE FROM duplicate_clusters 
    WHERE id NOT IN (SELECT DISTINCT cluster_id FROM duplicate_records WHERE cluster_id IS NOT NULL)
  `);
  console.log(`🧹 [DuplicateRadar] Cleaned up ${result.rowCount} orphan clusters`);
  return result.rowCount || 0;
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

// B4: Fuzzy match using pg_trgm similarity() with fallback
export async function findOrCreateClusterByCompany(
  companyName: string,
  domain?: string,
  phone?: string,
  email?: string
): Promise<DuplicateCluster> {
  const normalizedName = normalizeCompanyName(companyName);
  const normalizedPhone = phone ? normalizePhone(phone) : '';

  if (domain) {
    const existingByDomain = await pool.query(
      'SELECT * FROM duplicate_clusters WHERE domain = $1',
      [domain]
    );
    if (existingByDomain.rows[0]) {
      return existingByDomain.rows[0];
    }
  }

  if (email) {
    const existingByEmail = await pool.query(
      `SELECT dc.* FROM duplicate_clusters dc
       JOIN duplicate_records dr ON dr.cluster_id = dc.id
       WHERE LOWER(dr.email) = LOWER($1) LIMIT 1`,
      [email]
    );
    if (existingByEmail.rows[0]) {
      return existingByEmail.rows[0];
    }
  }

  if (normalizedPhone && normalizedPhone.length >= 7) {
    const existingByPhone = await pool.query(
      `SELECT dc.* FROM duplicate_clusters dc
       JOIN duplicate_records dr ON dr.cluster_id = dc.id
       WHERE dr.phone_normalized = $1 LIMIT 1`,
      [normalizedPhone]
    );
    if (existingByPhone.rows[0]) {
      return existingByPhone.rows[0];
    }
  }

  if (normalizedName) {
    const existingByCompany = await pool.query(
      `SELECT * FROM duplicate_clusters 
       WHERE company_name ILIKE $1 OR company_name ILIKE $2`,
      [`%${normalizedName}%`, `%${companyName}%`]
    );
    if (existingByCompany.rows[0]) {
      return existingByCompany.rows[0];
    }
  }

  // B4: Try pg_trgm similarity() first, fallback to limited Levenshtein
  if (normalizedName && normalizedName.length > 2) {
    try {
      const trgmResult = await pool.query(
        `SELECT *, similarity(company_name_normalized, $1) as sim
         FROM duplicate_clusters
         WHERE company_name_normalized IS NOT NULL AND company_name_normalized != ''
           AND similarity(company_name_normalized, $1) >= 0.4
         ORDER BY sim DESC LIMIT 1`,
        [normalizedName]
      );
      if (trgmResult.rows[0] && trgmResult.rows[0].sim >= 0.4) {
        return trgmResult.rows[0];
      }
    } catch {
      const recentClusters = await pool.query(
        'SELECT * FROM duplicate_clusters ORDER BY updated_at DESC LIMIT 2000'
      );
      for (const cluster of recentClusters.rows) {
        const clusterNormalized = normalizeCompanyName(cluster.company_name || '');
        if (clusterNormalized && normalizedName && clusterNormalized.length > 2 && normalizedName.length > 2) {
          const similarity = calculateSimilarity(clusterNormalized, normalizedName);
          if (similarity >= 80) {
            return cluster;
          }
        }
      }
    }
  }

  return await createCluster({
    domain: domain || normalizedName.replace(/\s+/g, '-') + '.cluster',
    company_name: companyName,
    total_leads: 0,
    total_deals: 0,
    total_contacts: 0,
    total_accounts: 0,
    total_records: 0,
    confidence_level: 'low',
    confidence_score: 0,
    status: 'active'
  });
}

export async function markPrimaryRecord(clusterId: number, recordId: number): Promise<boolean> {
  await pool.query('UPDATE duplicate_records SET is_primary = false WHERE cluster_id = $1', [clusterId]);
  const result = await pool.query(
    'UPDATE duplicate_records SET is_primary = true WHERE id = $1 AND cluster_id = $2 RETURNING id',
    [recordId, clusterId]
  );
  return result.rows.length > 0;
}

export async function resolveCluster(
  clusterId: number,
  action: 'resolve' | 'ignore',
  performedBy: string,
  primaryRecordId?: number,
  notes?: string
): Promise<MergeAction | null> {
  if (primaryRecordId) {
    await markPrimaryRecord(clusterId, primaryRecordId);
  }

  const nonPrimary = await pool.query(
    'SELECT id FROM duplicate_records WHERE cluster_id = $1 AND is_primary = false',
    [clusterId]
  );
  const mergedIds = nonPrimary.rows.map(r => r.id);

  const result = await pool.query(`
    INSERT INTO duplicate_merge_actions (cluster_id, primary_record_id, merged_record_ids, action_type, performed_by, notes)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
  `, [clusterId, primaryRecordId || null, JSON.stringify(mergedIds), action, performedBy, notes || null]);

  const newStatus = action === 'resolve' ? 'resolved' : 'ignored';
  await pool.query(
    'UPDATE duplicate_clusters SET status = $1, resolved_by = $2, resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
    [newStatus, performedBy, clusterId]
  );

  return result.rows[0] || null;
}

export async function bulkResolve(
  clusterIds: number[],
  action: 'resolve' | 'ignore',
  performedBy: string
): Promise<number> {
  let count = 0;
  for (const id of clusterIds) {
    await resolveCluster(id, action, performedBy);
    count++;
  }
  return count;
}

export async function getMergeHistory(clusterId?: number, limit: number = 50): Promise<MergeAction[]> {
  let query = 'SELECT * FROM duplicate_merge_actions';
  const params: any[] = [];
  if (clusterId) {
    query += ' WHERE cluster_id = $1';
    params.push(clusterId);
  }
  query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
  params.push(limit);
  const result = await pool.query(query, params);
  return result.rows;
}

// C3: Enhanced owner accountability with RAG status against 2% KPI target
export async function getOwnerAccountability(): Promise<OwnerAccountability[]> {
  const result = await pool.query(`
    SELECT 
      dr.owner_name,
      dr.owner_email,
      COUNT(*) as total_records,
      COUNT(*) FILTER (WHERE dc.total_records > 1 AND dr.is_primary = false) as duplicate_records,
      COUNT(DISTINCT dr.cluster_id) FILTER (WHERE dc.total_records > 1) as clusters_involved,
      COUNT(*) FILTER (WHERE dc.total_records > 1 AND dc.confidence_level = 'high' AND dr.is_primary = false) as high_confidence_duplicates,
      COALESCE(SUM(dr.deal_value) FILTER (WHERE dc.total_records > 1 AND dr.is_primary = false AND dr.record_type = 'deal'), 0) as estimated_waste_value
    FROM duplicate_records dr
    JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
    WHERE dr.owner_name IS NOT NULL AND dr.owner_name != 'Unknown'
    GROUP BY dr.owner_name, dr.owner_email
    ORDER BY duplicate_records DESC
  `);

  return result.rows.map(r => {
    const totalRecs = parseInt(r.total_records) || 0;
    const dupRecs = parseInt(r.duplicate_records) || 0;
    const dupRate = totalRecs > 0 ? Math.round((dupRecs / totalRecs) * 100) : 0;
    let ragStatus: 'green' | 'amber' | 'red' = 'green';
    if (dupRate > 5) ragStatus = 'red';
    else if (dupRate > 2) ragStatus = 'amber';

    return {
      owner_name: r.owner_name,
      owner_email: r.owner_email || '',
      total_records: totalRecs,
      duplicate_records: dupRecs,
      duplicate_rate: dupRate,
      clusters_involved: parseInt(r.clusters_involved) || 0,
      high_confidence_duplicates: parseInt(r.high_confidence_duplicates) || 0,
      estimated_waste_value: parseFloat(r.estimated_waste_value) || 0,
      rag_status: ragStatus
    };
  });
}

export async function checkForDuplicates(params: {
  email?: string;
  phone?: string;
  company_name?: string;
}): Promise<{
  is_duplicate: boolean;
  confidence: number;
  signals: string[];
  matching_clusters: DuplicateCluster[];
  matching_records: DuplicateRecord[];
}> {
  const domain = params.email ? extractDomain(params.email) : null;
  const normalizedPhone = params.phone ? normalizePhone(params.phone) : '';
  const conditions: string[] = [];
  const queryParams: any[] = [];
  let idx = 1;

  if (params.email) {
    conditions.push(`LOWER(dr.email) = LOWER($${idx++})`);
    queryParams.push(params.email);
  }
  if (domain) {
    conditions.push(`dr.domain = $${idx++}`);
    queryParams.push(domain);
  }
  if (normalizedPhone && normalizedPhone.length >= 7) {
    conditions.push(`dr.phone_normalized = $${idx++}`);
    queryParams.push(normalizedPhone);
  }
  if (params.company_name) {
    conditions.push(`LOWER(dr.company_name) ILIKE LOWER($${idx++})`);
    queryParams.push(`%${params.company_name}%`);
  }

  if (conditions.length === 0) {
    return { is_duplicate: false, confidence: 0, signals: [], matching_clusters: [], matching_records: [] };
  }

  const result = await pool.query(`
    SELECT dr.*, dc.confidence_level, dc.confidence_score as cluster_confidence, dc.total_records as cluster_total
    FROM duplicate_records dr
    JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
    WHERE dc.status = 'active' AND (${conditions.join(' OR ')})
    ORDER BY dr.confidence_score DESC
    LIMIT 20
  `, queryParams);

  if (result.rows.length === 0) {
    return { is_duplicate: false, confidence: 0, signals: [], matching_clusters: [], matching_records: [] };
  }

  const matchSignals: string[] = [];
  let bestScore = 0;
  for (const row of result.rows) {
    const match = calculateMultiSignalScore(
      { email: params.email, domain: domain || undefined, phone: params.phone, company_name: params.company_name },
      { email: row.email, domain: row.domain, phone: row.phone, company_name: row.company_name }
    );
    if (match.score > bestScore) bestScore = match.score;
    match.signals.forEach(s => { if (!matchSignals.includes(s)) matchSignals.push(s); });
  }

  const clusterIds = [...new Set(result.rows.map(r => r.cluster_id))];
  const clustersResult = await pool.query('SELECT * FROM duplicate_clusters WHERE id = ANY($1)', [clusterIds]);

  return {
    is_duplicate: bestScore >= 50,
    confidence: bestScore,
    signals: matchSignals,
    matching_clusters: clustersResult.rows,
    matching_records: result.rows
  };
}

// A2: Fixed low_confidence count — only clusters with total_records > 1, added singletonCount
export async function getEnhancedSummary(): Promise<{
  totalClusters: number;
  trueDuplicateClusters: number;
  singletonCount: number;
  totalRecords: number;
  totalDuplicateLeads: number;
  totalDuplicateDeals: number;
  totalDuplicateContacts: number;
  totalDuplicateAccounts: number;
  highConfidence: number;
  mediumConfidence: number;
  lowConfidence: number;
  estimatedPipelineInflation: number;
  activeCount: number;
  resolvedCount: number;
  ignoredCount: number;
  resolutionRate: number;
  topSignals: Record<string, number>;
  duplicateLeadRate: number;
  duplicateDealRate: number;
  topClustersByInflation: any[];
  lastScanInfo: any;
}> {
  const result = await pool.query(`
    SELECT 
      COUNT(*) as total_clusters,
      COUNT(*) FILTER (WHERE total_records > 1) as true_dup_clusters,
      COUNT(*) FILTER (WHERE total_records <= 1) as singleton_count,
      COALESCE(SUM(total_records), 0) as total_records,
      COALESCE(SUM(total_leads) FILTER (WHERE total_records > 1), 0) as dup_leads,
      COALESCE(SUM(total_deals) FILTER (WHERE total_records > 1), 0) as dup_deals,
      COALESCE(SUM(total_contacts) FILTER (WHERE total_records > 1), 0) as dup_contacts,
      COALESCE(SUM(total_accounts) FILTER (WHERE total_records > 1), 0) as dup_accounts,
      COUNT(*) FILTER (WHERE confidence_level = 'high' AND total_records > 1) as high_confidence,
      COUNT(*) FILTER (WHERE confidence_level = 'medium' AND total_records > 1) as medium_confidence,
      COUNT(*) FILTER (WHERE confidence_level = 'low' AND total_records > 1) as low_confidence,
      COALESCE(SUM(estimated_pipeline_value), 0) as pipeline_inflation,
      COUNT(*) FILTER (WHERE status = 'active') as active_count,
      COUNT(*) FILTER (WHERE status = 'resolved') as resolved_count,
      COUNT(*) FILTER (WHERE status = 'ignored') as ignored_count
    FROM duplicate_clusters
  `);

  const row = result.rows[0];
  const totalLeads = await pool.query("SELECT COUNT(*) as cnt FROM duplicate_records WHERE record_type = 'lead'");
  const totalDeals = await pool.query("SELECT COUNT(*) as cnt FROM duplicate_records WHERE record_type = 'deal'");
  const tLeads = parseInt(totalLeads.rows[0]?.cnt) || 1;
  const tDeals = parseInt(totalDeals.rows[0]?.cnt) || 1;
  const dupLeads = parseInt(row.dup_leads) || 0;
  const dupDeals = parseInt(row.dup_deals) || 0;

  const signalResult = await pool.query(`
    SELECT match_signals FROM duplicate_clusters WHERE total_records > 1 AND match_signals IS NOT NULL
  `);
  const topSignals: Record<string, number> = {};
  for (const r of signalResult.rows) {
    const signals = Array.isArray(r.match_signals) ? r.match_signals : [];
    for (const s of signals) {
      if (s !== 'stale_pending') topSignals[s] = (topSignals[s] || 0) + 1;
    }
  }

  // D4: Top 5 clusters by pipeline inflation
  const topClustersResult = await pool.query(`
    SELECT id, domain, company_name, estimated_pipeline_value, total_records, confidence_score
    FROM duplicate_clusters
    WHERE estimated_pipeline_value > 0 AND total_records > 1
    ORDER BY estimated_pipeline_value DESC
    LIMIT 5
  `);

  // D4: Last scan info
  const lastScanResult = await pool.query(`
    SELECT completed_at, detection_duration_ms, total_records_scanned, total_clusters_found, total_duplicates_detected
    FROM duplicate_detection_logs WHERE status = 'completed'
    ORDER BY completed_at DESC LIMIT 1
  `);

  const totalClusters = parseInt(row.total_clusters) || 0;
  const resolvedCount = parseInt(row.resolved_count) || 0;
  const ignoredCount = parseInt(row.ignored_count) || 0;
  const resolutionRate = totalClusters > 0 ? Math.round(((resolvedCount + ignoredCount) / totalClusters) * 100) : 0;

  return {
    totalClusters,
    trueDuplicateClusters: parseInt(row.true_dup_clusters) || 0,
    singletonCount: parseInt(row.singleton_count) || 0,
    totalRecords: parseInt(row.total_records) || 0,
    totalDuplicateLeads: dupLeads,
    totalDuplicateDeals: dupDeals,
    totalDuplicateContacts: parseInt(row.dup_contacts) || 0,
    totalDuplicateAccounts: parseInt(row.dup_accounts) || 0,
    highConfidence: parseInt(row.high_confidence) || 0,
    mediumConfidence: parseInt(row.medium_confidence) || 0,
    lowConfidence: parseInt(row.low_confidence) || 0,
    estimatedPipelineInflation: parseFloat(row.pipeline_inflation) || 0,
    activeCount: parseInt(row.active_count) || 0,
    resolvedCount,
    ignoredCount,
    resolutionRate,
    topSignals,
    duplicateLeadRate: Math.round((dupLeads / tLeads) * 100),
    duplicateDealRate: Math.round((dupDeals / tDeals) * 100),
    topClustersByInflation: topClustersResult.rows,
    lastScanInfo: lastScanResult.rows[0] || null
  };
}

export async function getLastScanDate(): Promise<Date | null> {
  const result = await pool.query(
    "SELECT completed_at FROM duplicate_detection_logs WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1"
  );
  return result.rows[0]?.completed_at || null;
}

// B5: JOIN-based queries eliminating N+1 pattern
export async function getDuplicateRecordsByType(
  recordType: string,
  options?: { limit?: number; offset?: number; start_date?: string; end_date?: string }
): Promise<{ groups: any[]; total: number }> {
  const countField = recordType === 'lead' ? 'total_leads' :
                     recordType === 'deal' ? 'total_deals' :
                     recordType === 'contact' ? 'total_contacts' : 'total_accounts';

  let dateFilter = '';
  const params: any[] = [recordType];
  let pi = 2;

  if (options?.start_date) {
    dateFilter += ` AND dr.created_date >= $${pi++}`;
    params.push(options.start_date);
  }
  if (options?.end_date) {
    dateFilter += ` AND dr.created_date <= $${pi++}`;
    params.push(options.end_date + 'T23:59:59Z');
  }

  const limit = options?.limit || 50;
  const offset = options?.offset || 0;

  const result = await pool.query(`
    SELECT dr.*, dc.domain as cluster_domain, dc.company_name as cluster_company,
           dc.confidence_level, dc.confidence_score as cluster_confidence,
           dc.total_records as cluster_total, dc.estimated_pipeline_value,
           dc.id as cluster_id_ref
    FROM duplicate_records dr
    JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
    WHERE dr.record_type = $1 AND dc.${countField} > 1 AND dc.status = 'active'
    ${dateFilter}
    ORDER BY dc.confidence_score DESC, dr.is_primary DESC, dr.created_date ASC
    LIMIT $${pi++} OFFSET $${pi++}
  `, [...params, limit, offset]);

  const countResult = await pool.query(`
    SELECT COUNT(DISTINCT dc.id) as total
    FROM duplicate_records dr
    JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
    WHERE dr.record_type = $1 AND dc.${countField} > 1 AND dc.status = 'active'
    ${dateFilter}
  `, params);

  const grouped: Record<number, any> = {};
  for (const row of result.rows) {
    const cid = row.cluster_id;
    if (!grouped[cid]) {
      grouped[cid] = {
        cluster: {
          id: cid,
          domain: row.cluster_domain,
          company_name: row.cluster_company,
          confidence_level: row.confidence_level,
          confidence_score: row.cluster_confidence,
          total_records: row.cluster_total,
          estimated_pipeline_value: row.estimated_pipeline_value
        },
        [recordType + 's']: [],
        duplicate_count: 0
      };
    }
    grouped[cid][recordType + 's'].push(row);
    grouped[cid].duplicate_count++;
  }

  return {
    groups: Object.values(grouped),
    total: parseInt(countResult.rows[0]?.total) || 0
  };
}

// B5: JOIN-based export eliminating N+1
export async function getExportRecords(filters?: {
  owner?: string;
  start_date?: string;
  end_date?: string;
  status?: string;
}): Promise<any[]> {
  let whereClause = 'WHERE 1=1';
  const params: any[] = [];
  let pi = 1;

  if (filters?.status) {
    whereClause += ` AND dc.status = $${pi++}`;
    params.push(filters.status);
  } else {
    whereClause += ` AND dc.status = 'active'`;
  }
  if (filters?.owner) {
    whereClause += ` AND (dr.owner_name = $${pi++} OR dr.owner_email = $${pi - 1})`;
    params.push(filters.owner);
  }
  if (filters?.start_date) {
    whereClause += ` AND dr.created_date >= $${pi++}`;
    params.push(filters.start_date);
  }
  if (filters?.end_date) {
    whereClause += ` AND dr.created_date <= $${pi++}`;
    params.push(filters.end_date + 'T23:59:59Z');
  }

  const result = await pool.query(`
    SELECT dr.*, dc.domain as cluster_domain, dc.confidence_level as cluster_confidence
    FROM duplicate_records dr
    JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
    ${whereClause}
    ORDER BY dc.total_records DESC, dr.cluster_id, dr.is_primary DESC
  `, params);

  return result.rows;
}

// C5: Auto-resolution engine
export async function autoResolveClusters(): Promise<{
  singletonsIgnored: number;
  highConfidenceResolved: number;
  totalProcessed: number;
}> {
  let singletonsIgnored = 0;
  let highConfidenceResolved = 0;

  const singletons = await pool.query(`
    SELECT id FROM duplicate_clusters WHERE total_records <= 1 AND status = 'active'
  `);
  for (const row of singletons.rows) {
    await pool.query(
      "UPDATE duplicate_clusters SET status = 'ignored', resolved_by = 'auto-resolve', resolved_at = CURRENT_TIMESTAMP WHERE id = $1",
      [row.id]
    );
    singletonsIgnored++;
  }

  const highConf = await pool.query(`
    SELECT id FROM duplicate_clusters WHERE confidence_score >= 95 AND status = 'active' AND total_records > 1
  `);
  for (const row of highConf.rows) {
    const primary = await pool.query(
      'SELECT id FROM duplicate_records WHERE cluster_id = $1 AND is_primary = true LIMIT 1',
      [row.id]
    );
    if (primary.rows[0]) {
      await resolveCluster(row.id, 'resolve', 'auto-resolve', primary.rows[0].id, 'Auto-resolved: confidence >= 95% with clear primary');
      highConfidenceResolved++;
    }
  }

  return {
    singletonsIgnored,
    highConfidenceResolved,
    totalProcessed: singletonsIgnored + highConfidenceResolved
  };
}

// C7: Smart AI recommendations considering completeness, deals, recency
export function generateSmartRecommendations(records: DuplicateRecord[]): Array<{
  record_id: number;
  record_name: string;
  is_primary: boolean;
  recommendation: string;
  action_type: 'keep' | 'merge' | 'close';
  confidence: number;
  reasons: string[];
}> {
  if (records.length === 0) return [];

  const scored = records.map(r => {
    let score = 0;
    const reasons: string[] = [];

    const fields = [r.email, r.phone, r.company_name, r.owner_name, r.source].filter(Boolean);
    const completeness = Math.round((fields.length / 5) * 100);
    score += completeness;
    if (completeness >= 80) reasons.push('High data completeness');

    if (r.record_type === 'deal' && r.deal_value && r.deal_value > 0) {
      score += 30;
      reasons.push('Has active deal value');
    }

    if (r.modified_date) {
      const daysSinceModified = (Date.now() - new Date(r.modified_date).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceModified < 30) {
        score += 20;
        reasons.push('Recently modified');
      } else if (daysSinceModified < 90) {
        score += 10;
        reasons.push('Modified in last 90 days');
      }
    }

    if (r.created_date) {
      const ageInDays = (Date.now() - new Date(r.created_date).getTime()) / (1000 * 60 * 60 * 24);
      if (ageInDays > 180) {
        score += 5;
        reasons.push('Established record (6mo+)');
      }
    }

    if (r.stage && ['Closed Won', 'Negotiation', 'Proposal'].includes(r.stage)) {
      score += 15;
      reasons.push(`Active deal stage: ${r.stage}`);
    }

    return { record: r, score, reasons };
  });

  scored.sort((a, b) => b.score - a.score);

  return scored.map((item, index) => ({
    record_id: item.record.id!,
    record_name: item.record.record_name,
    is_primary: index === 0,
    recommendation: index === 0
      ? 'KEEP as primary record (highest quality score)'
      : item.record.record_type === 'lead' && scored.some(s => s.record.record_type === 'deal')
        ? 'CLOSE – Deal exists for this company'
        : 'MERGE into primary record',
    action_type: index === 0 ? 'keep' as const : (item.record.record_type === 'lead' && scored.some(s => s.record.record_type === 'deal') ? 'close' as const : 'merge' as const),
    confidence: Math.min(95, 60 + (scored[0].score - item.score)),
    reasons: item.reasons
  }));
}

export { pool };
