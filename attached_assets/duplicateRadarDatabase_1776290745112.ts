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
  record_type: 'lead' | 'deal' | 'contact' | 'account';
  zoho_record_id?: string;
  record_name: string;
  company_name?: string;
  email?: string;
  domain?: string;
  phone?: string;
  phone_normalized?: string;
  mobile?: string;
  mobile_normalized?: string;
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
  layout_name?: string;
  layout_id?: string;
  zoho_module?: string;
  pipeline?: string;
  products?: string;
  contact_name?: string;
  account_name?: string;
  cr_number?: string;
  vat_number?: string;
  website?: string;
  country?: string;
  region?: string;
  industry?: string;
  no_of_employees?: number;
  title?: string;
  lead_type?: string;
  gov_type?: string;
  account_type?: string;
  data_quality_score?: number;
  data_quality_flags?: string[];
}

export interface ZohoSyncState {
  module: string;
  last_sync_at?: Date;
  total_synced: number;
  last_full_sync_at?: Date;
  sync_status: 'idle' | 'syncing' | 'failed';
  error_message?: string;
  updated_at?: Date;
}

export interface DuplicateRecordTask {
  id?: number;
  zoho_task_id: string;
  related_record_id?: string;
  subject?: string;
  due_date?: Date;
  status?: string;
  priority?: string;
  owner_name?: string;
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

const PHONE_GARBAGE = ['na', 'n/a', 'nil', 'none', 'null', '-', '--', '.', '0', '00', '000', 'x', 'xx', 'test', 'unknown'];

export function normalizePhone(phone: string): string {
  if (!phone) return '';
  const trimmed = phone.trim().toLowerCase();
  if (PHONE_GARBAGE.includes(trimmed)) return '';
  const digits = phone.replace(/[\s\-\(\)\+\.]/g, '');
  if (digits.length < 7) return '';
  return digits.replace(/^00966/, '').replace(/^966/, '').replace(/^0/, '').slice(-9);
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

  // New columns for full CRM sync
  await pool.query(`ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS data_quality_score INTEGER DEFAULT 100`);
  await pool.query(`ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS data_quality_flags JSONB DEFAULT '[]'`);

  await pool.query(`ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS layout_name VARCHAR(255)`);
  await pool.query(`ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS layout_id VARCHAR(100)`);
  await pool.query(`ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS zoho_module VARCHAR(50)`);
  await pool.query(`ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS pipeline VARCHAR(255)`);
  await pool.query(`ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS products VARCHAR(255)`);
  await pool.query(`ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS mobile VARCHAR(100)`);
  await pool.query(`ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS mobile_normalized VARCHAR(50)`);
  await pool.query(`ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS contact_name VARCHAR(500)`);
  await pool.query(`ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS account_name VARCHAR(500)`);
  await pool.query(`ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS cr_number VARCHAR(100)`);
  await pool.query(`ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS vat_number VARCHAR(100)`);
  await pool.query(`ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS website VARCHAR(500)`);
  await pool.query(`ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS country VARCHAR(100)`);
  await pool.query(`ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS region VARCHAR(255)`);
  await pool.query(`ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS industry VARCHAR(255)`);
  await pool.query(`ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS no_of_employees INTEGER`);
  await pool.query(`ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS title VARCHAR(255)`);
  await pool.query(`ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS lead_type VARCHAR(100)`);
  await pool.query(`ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS gov_type VARCHAR(100)`);
  await pool.query(`ALTER TABLE duplicate_records ADD COLUMN IF NOT EXISTS account_type VARCHAR(100)`);

  // Sync state table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS zoho_sync_state (
      module VARCHAR(50) PRIMARY KEY,
      last_sync_at TIMESTAMP,
      total_synced INTEGER DEFAULT 0,
      last_full_sync_at TIMESTAMP,
      sync_status VARCHAR(20) DEFAULT 'idle',
      error_message TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Tasks linked to duplicate records
  await pool.query(`
    CREATE TABLE IF NOT EXISTS duplicate_record_tasks (
      id SERIAL PRIMARY KEY,
      zoho_task_id VARCHAR(100) UNIQUE,
      related_record_id VARCHAR(100),
      subject VARCHAR(500),
      due_date TIMESTAMP,
      status VARCHAR(100),
      priority VARCHAR(50),
      owner_name VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

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

  await pool.query(`ALTER TABLE duplicate_clusters ADD COLUMN IF NOT EXISTS company_name_normalized VARCHAR(500)`);

  // Unique partial index for incremental upsert
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_duplicate_records_zoho_id_unique
    ON duplicate_records(zoho_record_id) WHERE zoho_record_id IS NOT NULL
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_duplicate_clusters_domain ON duplicate_clusters(domain)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_duplicate_clusters_status ON duplicate_clusters(status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_duplicate_records_cluster ON duplicate_records(cluster_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_duplicate_records_type ON duplicate_records(record_type)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_duplicate_records_zoho_id ON duplicate_records(zoho_record_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_duplicate_records_email ON duplicate_records(LOWER(email))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_duplicate_records_phone_norm ON duplicate_records(phone_normalized)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_duplicate_records_domain ON duplicate_records(domain)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_duplicate_clusters_company_norm ON duplicate_clusters(company_name_normalized)`);

  // Indexes for rich filtering
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_duplicate_records_layout ON duplicate_records(layout_name)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_duplicate_records_module ON duplicate_records(zoho_module)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_duplicate_records_owner ON duplicate_records(owner_name)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_duplicate_records_created ON duplicate_records(created_date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_duplicate_records_products ON duplicate_records(products)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_duplicate_records_cr_number ON duplicate_records(cr_number)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_duplicate_records_vat_number ON duplicate_records(vat_number)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_duplicate_records_mobile_norm ON duplicate_records(mobile_normalized)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_duplicate_records_website ON duplicate_records(website)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_duplicate_record_tasks_related ON duplicate_record_tasks(related_record_id)`);

  // Try to enable pg_trgm for fuzzy matching (may not be available on all hosts)
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_clusters_company_trgm ON duplicate_clusters USING GIN (company_name_normalized gin_trgm_ops)`);
  } catch (e) {
    console.log('[DuplicateRadar] pg_trgm extension not available, using Levenshtein fallback for fuzzy matching');
  }

  // Backfill company_name_normalized for existing rows
  await pool.query(`
    UPDATE duplicate_clusters SET company_name_normalized = LOWER(
      REGEXP_REPLACE(
        REGEXP_REPLACE(company_name, '[^\\w\\s]', ' ', 'g'),
        '\\s+', ' ', 'g'
      )
    ) WHERE company_name IS NOT NULL AND company_name_normalized IS NULL
  `);
}

export async function createCluster(cluster: Omit<DuplicateCluster, 'id' | 'created_at' | 'updated_at'>): Promise<DuplicateCluster> {
  const companyNorm = cluster.company_name ? normalizeCompanyName(cluster.company_name) : null;
  const result = await pool.query(
    `INSERT INTO duplicate_clusters 
     (domain, company_name, company_name_arabic, company_name_normalized, total_leads, total_deals, total_records, 
      confidence_level, confidence_score, first_record_date, latest_activity_date, 
      owners_involved, estimated_pipeline_value, status, ai_recommendation)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING *`,
    [
      cluster.domain, cluster.company_name, cluster.company_name_arabic, companyNorm,
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

export async function addRecordToCluster(record: Omit<DuplicateRecord, 'id' | 'created_at'> & { phone_normalized?: string }): Promise<DuplicateRecord> {
  const phoneNorm = record.phone_normalized || (record.phone ? normalizePhone(record.phone) : null);
  const result = await pool.query(
    `INSERT INTO duplicate_records 
     (cluster_id, record_type, zoho_record_id, record_name, company_name, email, domain,
      phone, phone_normalized, owner_name, owner_email, status, stage, deal_value, source, created_date,
      modified_date, is_primary, ai_recommendation, confidence_score, is_mock_data, raw_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
     RETURNING *`,
    [
      record.cluster_id, record.record_type, record.zoho_record_id, record.record_name,
      record.company_name, record.email, record.domain, record.phone, phoneNorm,
      record.owner_name, record.owner_email, record.status, record.stage,
      record.deal_value, record.source, record.created_date, record.modified_date,
      record.is_primary, record.ai_recommendation, record.confidence_score,
      record.is_mock_data, JSON.stringify(record.raw_data || {})
    ]
  );
  return result.rows[0];
}

export async function upsertRecord(record: Omit<DuplicateRecord, 'id' | 'created_at'>): Promise<DuplicateRecord> {
  const phoneNorm = record.phone_normalized || (record.phone ? normalizePhone(record.phone) : null);
  const mobileNorm = record.mobile_normalized || (record.mobile ? normalizePhone(record.mobile) : null);
  const result = await pool.query(
    `INSERT INTO duplicate_records 
     (cluster_id, record_type, zoho_record_id, record_name, company_name, email, domain,
      phone, phone_normalized, mobile, mobile_normalized, owner_name, owner_email, status, stage, deal_value, source,
      created_date, modified_date, is_primary, ai_recommendation, confidence_score, is_mock_data, raw_data,
      layout_name, layout_id, zoho_module, pipeline, products, contact_name, account_name,
      cr_number, vat_number, website, country, region, industry, no_of_employees, title, lead_type, gov_type, account_type,
      data_quality_score, data_quality_flags)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43)
     ON CONFLICT (zoho_record_id) WHERE zoho_record_id IS NOT NULL DO UPDATE SET
       cluster_id = EXCLUDED.cluster_id,
       record_name = EXCLUDED.record_name,
       company_name = EXCLUDED.company_name,
       email = EXCLUDED.email,
       domain = EXCLUDED.domain,
       phone = EXCLUDED.phone,
       phone_normalized = EXCLUDED.phone_normalized,
       mobile = EXCLUDED.mobile,
       mobile_normalized = EXCLUDED.mobile_normalized,
       owner_name = EXCLUDED.owner_name,
       owner_email = EXCLUDED.owner_email,
       status = EXCLUDED.status,
       stage = EXCLUDED.stage,
       deal_value = EXCLUDED.deal_value,
       source = EXCLUDED.source,
       modified_date = EXCLUDED.modified_date,
       raw_data = EXCLUDED.raw_data,
       layout_name = EXCLUDED.layout_name,
       layout_id = EXCLUDED.layout_id,
       zoho_module = EXCLUDED.zoho_module,
       pipeline = EXCLUDED.pipeline,
       products = EXCLUDED.products,
       contact_name = EXCLUDED.contact_name,
       account_name = EXCLUDED.account_name,
       cr_number = EXCLUDED.cr_number,
       vat_number = EXCLUDED.vat_number,
       website = EXCLUDED.website,
       country = EXCLUDED.country,
       region = EXCLUDED.region,
       industry = EXCLUDED.industry,
       no_of_employees = EXCLUDED.no_of_employees,
       title = EXCLUDED.title,
       lead_type = EXCLUDED.lead_type,
       gov_type = EXCLUDED.gov_type,
       account_type = EXCLUDED.account_type,
       data_quality_score = EXCLUDED.data_quality_score,
       data_quality_flags = EXCLUDED.data_quality_flags
     RETURNING *`,
    [
      record.cluster_id, record.record_type, record.zoho_record_id, record.record_name,
      record.company_name, record.email, record.domain, record.phone, phoneNorm,
      record.mobile || null, mobileNorm,
      record.owner_name, record.owner_email, record.status, record.stage,
      record.deal_value, record.source, record.created_date, record.modified_date,
      record.is_primary, record.ai_recommendation, record.confidence_score,
      record.is_mock_data, JSON.stringify(record.raw_data || {}),
      record.layout_name || null, record.layout_id || null, record.zoho_module || null,
      record.pipeline || null, record.products || null, record.contact_name || null, record.account_name || null,
      record.cr_number || null, record.vat_number || null, record.website || null,
      record.country || null, record.region || null, record.industry || null,
      record.no_of_employees || null, record.title || null, record.lead_type || null,
      record.gov_type || null, record.account_type || null,
      record.data_quality_score ?? 100, JSON.stringify(record.data_quality_flags || [])
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

  // Multi-signal confidence: compare all record pairs in the cluster
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

  // If only 1 record, score = 0 (not a duplicate). If multiple but no signal match, give base score from count.
  let confidenceScore: number;
  if (totalRecords <= 1) {
    confidenceScore = 0;
  } else if (bestScore > 0) {
    confidenceScore = bestScore;
  } else {
    confidenceScore = totalRecords > 3 ? 65 : 55;
  }

  // Pipeline inflation = total deal value of non-primary deals in the cluster
  const inflationResult = await pool.query(`
    SELECT COALESCE(SUM(deal_value), 0) as inflation
    FROM duplicate_records
    WHERE cluster_id = $1 AND record_type = 'deal' AND is_primary = false AND deal_value > 0
  `, [clusterId]);
  const pipelineInflation = parseFloat(inflationResult.rows[0]?.inflation) || 0;

  // Auto-mark primary: earliest created record
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

export async function clearAllDuplicateData(): Promise<void> {
  console.log('🗑️ [DuplicateRadar] Clearing all duplicate data for fresh Zoho import...');
  await pool.query('DELETE FROM duplicate_records');
  await pool.query('DELETE FROM duplicate_clusters');
  console.log('✅ [DuplicateRadar] All duplicate data cleared');
}

export async function markStaleRecords(seenZohoIds: string[]): Promise<number> {
  if (seenZohoIds.length === 0) return 0;
  const result = await pool.query(
    `UPDATE duplicate_records SET status = 'stale'
     WHERE zoho_record_id IS NOT NULL AND is_mock_data = false
       AND zoho_record_id != ALL($1)
       AND status != 'stale'`,
    [seenZohoIds]
  );
  return result.rowCount || 0;
}

export async function cleanupOrphanClusters(): Promise<number> {
  const result = await pool.query(`
    DELETE FROM duplicate_clusters
    WHERE id NOT IN (
      SELECT DISTINCT cluster_id FROM duplicate_records WHERE cluster_id IS NOT NULL AND status != 'stale'
    ) AND status = 'active'
  `);
  return result.rowCount || 0;
}

export async function getLastScanModifiedTime(moduleName: string): Promise<string | null> {
  const result = await pool.query(`
    SELECT MAX(modified_date) as last_modified
    FROM duplicate_records
    WHERE record_type = $1 AND is_mock_data = false AND zoho_record_id IS NOT NULL
  `, [moduleName === 'Leads' ? 'lead' : moduleName === 'Deals' ? 'deal' : moduleName === 'Contacts' ? 'contact' : 'account']);
  const d = result.rows[0]?.last_modified;
  return d ? new Date(d).toISOString() : null;
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

// ═══════════════════════════════════════════════════════════
//  DATA QUALITY ASSESSMENT
// ═══════════════════════════════════════════════════════════

export interface DataQualityResult {
  score: number;         // 0-100: 0 = junk, 100 = pristine
  flags: string[];       // machine-readable issue codes
  isJunk: boolean;       // true = should be excluded from duplicate detection
}

const GIBBERISH_REGEX = /^[a-zA-Z]{20,}$/;
const RANDOM_MIXED_REGEX = /^[a-zA-Z0-9]{25,}$/;
const CONSECUTIVE_CAPS_REGEX = /[A-Z]{8,}/;
const NAME_GARBAGE = ['test', 'testing', 'asdf', 'qwerty', 'xxx', 'yyy', 'zzz', 'demo', 'sample', 'unknown', 'n/a', 'na', '-', '.', '..', 'null'];

function isGibberishName(name: string): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  if (trimmed.length < 2) return true;

  const words = trimmed.split(/\s+/);
  if (words.some(w => w.length > 25 && /^[a-zA-Z]+$/.test(w))) return true;
  if (GIBBERISH_REGEX.test(trimmed.replace(/\s/g, ''))) return true;
  if (RANDOM_MIXED_REGEX.test(trimmed.replace(/\s/g, ''))) return true;

  const latinLetters = (trimmed.match(/[a-zA-Z]/g) || []).length;
  const upperCase = (trimmed.match(/[A-Z]/g) || []).length;
  if (latinLetters > 10 && upperCase / latinLetters > 0.6) return true;
  if (CONSECUTIVE_CAPS_REGEX.test(trimmed)) return true;

  const consonants = (trimmed.toLowerCase().match(/[bcdfghjklmnpqrstvwxyz]/g) || []).length;
  const vowels = (trimmed.toLowerCase().match(/[aeiou]/g) || []).length;
  if (latinLetters > 10 && vowels === 0) return true;
  if (latinLetters > 15 && consonants > 0 && vowels > 0 && consonants / vowels > 8) return true;

  return false;
}

function isSuspiciousEmail(email: string): boolean {
  if (!email) return false;
  const local = email.split('@')[0] || '';
  if (/\d{6,}/.test(local)) return true;
  if (local.length > 30 && /^[a-z0-9.]+$/.test(local)) {
    const dots = (local.match(/\./g) || []).length;
    if (dots > 4) return true;
  }
  return false;
}

export function assessDataQuality(record: {
  recordName?: string;
  companyName?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  ownerName?: string;
  domain?: string | null;
}): DataQualityResult {
  const flags: string[] = [];
  let score = 100;

  // Name quality
  const name = record.recordName || '';
  const nameLower = name.toLowerCase().trim();
  if (!name || nameLower === '-' || nameLower === '.') {
    flags.push('missing_name');
    score -= 20;
  } else if (NAME_GARBAGE.includes(nameLower)) {
    flags.push('garbage_name');
    score -= 40;
  } else if (isGibberishName(name)) {
    flags.push('gibberish_name');
    score -= 50;
  }

  // Company quality
  const company = record.companyName || '';
  if (!company || company === 'Unknown') {
    flags.push('missing_company');
    score -= 15;
  } else if (isGibberishName(company)) {
    flags.push('gibberish_company');
    score -= 30;
  }

  // Email quality
  if (!record.email) {
    flags.push('missing_email');
    score -= 10;
  } else if (isSuspiciousEmail(record.email)) {
    flags.push('suspicious_email');
    score -= 15;
  }

  // Phone quality
  const phoneNorm = record.phone ? normalizePhone(record.phone) : '';
  const mobileNorm = record.mobile ? normalizePhone(record.mobile) : '';
  if (!phoneNorm && !mobileNorm) {
    flags.push('missing_phone');
    score -= 10;
  }

  // Owner quality
  if (!record.ownerName || record.ownerName === 'Unknown') {
    flags.push('missing_owner');
    score -= 5;
  }

  // Domain quality (public domains already filtered to null)
  if (!record.domain) {
    flags.push('no_business_domain');
    score -= 5;
  }

  return {
    score: Math.max(0, score),
    flags,
    isJunk: score <= 20 || flags.includes('gibberish_name') || flags.includes('garbage_name'),
  };
}

export async function findOrCreateClusterByCompany(
  companyName: string,
  domain?: string,
  phone?: string,
  email?: string
): Promise<DuplicateCluster> {
  const normalizedName = normalizeCompanyName(companyName);
  const normalizedPhone = phone ? normalizePhone(phone) : '';

  // Signal 1: Exact domain match (strongest for B2B)
  if (domain) {
    const existingByDomain = await pool.query(
      'SELECT * FROM duplicate_clusters WHERE domain = $1',
      [domain]
    );
    if (existingByDomain.rows[0]) {
      return existingByDomain.rows[0];
    }
  }

  // Signal 2: Exact email match in existing records
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

  // Signal 3: Phone match in existing records
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

  // Signal 4: Normalized company name match (uses indexed column)
  if (normalizedName) {
    const existingByCompany = await pool.query(
      `SELECT * FROM duplicate_clusters 
       WHERE company_name_normalized = $1 LIMIT 1`,
      [normalizedName]
    );
    if (existingByCompany.rows[0]) {
      return existingByCompany.rows[0];
    }
  }

  // Signal 5: Fuzzy company name match via pg_trgm (index-accelerated)
  if (normalizedName && normalizedName.length > 2) {
    try {
      const trigramResult = await pool.query(
        `SELECT *, similarity(company_name_normalized, $1) as sim
         FROM duplicate_clusters
         WHERE company_name_normalized IS NOT NULL AND company_name_normalized % $1
         ORDER BY sim DESC LIMIT 1`,
        [normalizedName]
      );
      if (trigramResult.rows[0] && parseFloat(trigramResult.rows[0].sim) >= 0.4) {
        return trigramResult.rows[0];
      }
    } catch {
      // pg_trgm extension not available — skip fuzzy matching
    }
  }

  return await createCluster({
    domain: domain || normalizedName.replace(/\s+/g, '-') + '.cluster',
    company_name: companyName,
    total_leads: 0,
    total_deals: 0,
    total_records: 0,
    confidence_level: 'low',
    confidence_score: 0,
    status: 'active'
  });
}

// ═══════════════════════════════════════════════════════════
//  MERGE WORKFLOW
// ═══════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════
//  OWNER ACCOUNTABILITY SCORING
// ═══════════════════════════════════════════════════════════

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

  return result.rows.map(r => ({
    owner_name: r.owner_name,
    owner_email: r.owner_email || '',
    total_records: parseInt(r.total_records) || 0,
    duplicate_records: parseInt(r.duplicate_records) || 0,
    duplicate_rate: parseInt(r.total_records) > 0
      ? Math.round((parseInt(r.duplicate_records) / parseInt(r.total_records)) * 100)
      : 0,
    clusters_involved: parseInt(r.clusters_involved) || 0,
    high_confidence_duplicates: parseInt(r.high_confidence_duplicates) || 0,
    estimated_waste_value: parseFloat(r.estimated_waste_value) || 0
  }));
}

// ═══════════════════════════════════════════════════════════
//  REAL-TIME DUPLICATE CHECK (pre-creation)
// ═══════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════
//  ENHANCED SUMMARY (with true duplicate count)
// ═══════════════════════════════════════════════════════════

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
  topSignals: Record<string, number>;
  duplicateLeadRate: number;
  duplicateDealRate: number;
  resolutionRate: number;
  topInflationClusters: Array<{ id: number; domain: string; company_name: string; value: number; total_records: number }>;
  lastScanInfo: { date: Date | null; duration_ms: number | null; records_scanned: number | null } | null;
}> {
  const result = await pool.query(`
    SELECT 
      COUNT(*) as total_clusters,
      COUNT(*) FILTER (WHERE total_records > 1) as true_dup_clusters,
      COALESCE(SUM(total_records), 0) as total_records,
      COALESCE(SUM(total_leads) FILTER (WHERE total_records > 1), 0) as dup_leads,
      COALESCE(SUM(total_deals) FILTER (WHERE total_records > 1), 0) as dup_deals,
      COALESCE(SUM(total_contacts) FILTER (WHERE total_records > 1), 0) as dup_contacts,
      COALESCE(SUM(total_accounts) FILTER (WHERE total_records > 1), 0) as dup_accounts,
      COUNT(*) FILTER (WHERE confidence_level = 'high' AND total_records > 1) as high_confidence,
      COUNT(*) FILTER (WHERE confidence_level = 'medium' AND total_records > 1) as medium_confidence,
      COUNT(*) FILTER (WHERE confidence_level = 'low' AND total_records > 1) as low_confidence,
      COUNT(*) FILTER (WHERE total_records <= 1) as singleton_count,
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
      topSignals[s] = (topSignals[s] || 0) + 1;
    }
  }

  const topInflationResult = await pool.query(`
    SELECT id, domain, company_name, estimated_pipeline_value as value, total_records
    FROM duplicate_clusters
    WHERE status = 'active' AND total_records > 1 AND estimated_pipeline_value > 0
    ORDER BY estimated_pipeline_value DESC LIMIT 5
  `);

  const lastScanResult = await pool.query(`
    SELECT completed_at, detection_duration_ms, total_records_scanned
    FROM duplicate_detection_logs WHERE status = 'completed'
    ORDER BY completed_at DESC LIMIT 1
  `);
  const lastScanRow = lastScanResult.rows[0];

  const activeCount = parseInt(row.active_count) || 0;
  const resolvedCount = parseInt(row.resolved_count) || 0;
  const totalActionable = activeCount + resolvedCount + (parseInt(row.ignored_count) || 0);

  return {
    totalClusters: parseInt(row.total_clusters) || 0,
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
    activeCount,
    resolvedCount,
    ignoredCount: parseInt(row.ignored_count) || 0,
    topSignals,
    duplicateLeadRate: Math.round((dupLeads / tLeads) * 100),
    duplicateDealRate: Math.round((dupDeals / tDeals) * 100),
    resolutionRate: totalActionable > 0 ? Math.round((resolvedCount / totalActionable) * 100) : 0,
    topInflationClusters: topInflationResult.rows.map(r => ({
      id: r.id, domain: r.domain, company_name: r.company_name || r.domain,
      value: parseFloat(r.value) || 0, total_records: parseInt(r.total_records) || 0
    })),
    lastScanInfo: lastScanRow ? {
      date: lastScanRow.completed_at,
      duration_ms: parseInt(lastScanRow.detection_duration_ms) || null,
      records_scanned: parseInt(lastScanRow.total_records_scanned) || null
    } : null
  };
}

export async function getLastScanDate(): Promise<Date | null> {
  const result = await pool.query(
    "SELECT completed_at FROM duplicate_detection_logs WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1"
  );
  return result.rows[0]?.completed_at || null;
}

// ═══════════════════════════════════════════════════════════
//  JOIN-BASED QUERIES (replacing N+1 pattern)
// ═══════════════════════════════════════════════════════════

export async function getDuplicateRecordsByType(
  recordType: string,
  filters?: { limit?: number; offset?: number; start_date?: string; end_date?: string; sort_by?: string; sort_order?: string }
): Promise<{ groups: any[]; total: number }> {
  const typeCountCol = recordType === 'lead' ? 'total_leads' : recordType === 'deal' ? 'total_deals' : recordType === 'contact' ? 'total_contacts' : 'total_accounts';
  const limit = filters?.limit || 100;
  const offset = filters?.offset || 0;
  const sortBy = filters?.sort_by === 'confidence' ? 'dc.confidence_score' : filters?.sort_by === 'value' ? 'dc.estimated_pipeline_value' : 'dc.total_records';
  const sortOrder = filters?.sort_order === 'asc' ? 'ASC' : 'DESC';

  let dateFilter = '';
  const params: any[] = [recordType];
  let pi = 2;
  if (filters?.start_date) {
    dateFilter += ` AND dr.created_date >= $${pi++}`;
    params.push(filters.start_date);
  }
  if (filters?.end_date) {
    dateFilter += ` AND dr.created_date <= $${pi++}`;
    params.push(filters.end_date);
  }

  const countResult = await pool.query(`
    SELECT COUNT(DISTINCT dc.id) as total
    FROM duplicate_clusters dc
    WHERE dc.status = 'active' AND dc.${typeCountCol} > 1
  `);

  params.push(limit, offset);
  const result = await pool.query(`
    SELECT dc.id as cluster_id, dc.domain, dc.company_name, dc.confidence_score, dc.confidence_level,
           dc.total_records, dc.estimated_pipeline_value, dc.${typeCountCol} as type_count,
           dr.id as record_id, dr.record_type, dr.zoho_record_id, dr.record_name, dr.company_name as rec_company,
           dr.email, dr.domain as rec_domain, dr.phone, dr.owner_name, dr.owner_email,
           dr.status as rec_status, dr.stage, dr.deal_value, dr.source,
           dr.created_date, dr.is_primary, dr.confidence_score as rec_confidence
    FROM duplicate_clusters dc
    JOIN duplicate_records dr ON dr.cluster_id = dc.id
    WHERE dc.status = 'active' AND dc.${typeCountCol} > 1 AND dr.record_type = $1 ${dateFilter}
    ORDER BY ${sortBy} ${sortOrder}, dr.is_primary DESC, dr.created_date ASC
    LIMIT $${pi++} OFFSET $${pi}
  `, params);

  const groupMap = new Map<number, any>();
  for (const row of result.rows) {
    if (!groupMap.has(row.cluster_id)) {
      groupMap.set(row.cluster_id, {
        cluster: { id: row.cluster_id, domain: row.domain, company_name: row.company_name, confidence_score: row.confidence_score, confidence_level: row.confidence_level, total_records: row.total_records, estimated_pipeline_value: row.estimated_pipeline_value },
        [recordType + 's']: [],
        duplicate_count: 0
      });
    }
    const group = groupMap.get(row.cluster_id);
    group[recordType + 's'].push({
      id: row.record_id, record_type: row.record_type, zoho_record_id: row.zoho_record_id,
      record_name: row.record_name, company_name: row.rec_company, email: row.email,
      domain: row.rec_domain, phone: row.phone, owner_name: row.owner_name,
      owner_email: row.owner_email, status: row.rec_status, stage: row.stage,
      deal_value: row.deal_value, source: row.source, created_date: row.created_date,
      is_primary: row.is_primary, confidence_score: row.rec_confidence
    });
    group.duplicate_count = group[recordType + 's'].length;
  }

  return { groups: Array.from(groupMap.values()), total: parseInt(countResult.rows[0]?.total) || 0 };
}

export async function getExportRecords(filters?: {
  owner?: string; start_date?: string; end_date?: string; record_type?: string;
}): Promise<any[]> {
  let where = `dc.status = 'active'`;
  const params: any[] = [];
  let pi = 1;

  if (filters?.owner) {
    where += ` AND (dr.owner_name = $${pi} OR dr.owner_email = $${pi++})`;
    params.push(filters.owner);
  }
  if (filters?.start_date) {
    where += ` AND dr.created_date >= $${pi++}`;
    params.push(filters.start_date);
  }
  if (filters?.end_date) {
    where += ` AND dr.created_date <= $${pi++}`;
    params.push(filters.end_date);
  }
  if (filters?.record_type && filters.record_type !== 'all') {
    where += ` AND dr.record_type = $${pi++}`;
    params.push(filters.record_type);
  }

  const result = await pool.query(`
    SELECT dr.*, dc.domain as cluster_domain, dc.confidence_level as cluster_confidence
    FROM duplicate_records dr
    JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
    WHERE ${where}
    ORDER BY dc.confidence_score DESC, dr.created_date ASC
  `, params);
  return result.rows;
}

// ═══════════════════════════════════════════════════════════
//  AUTO-RESOLUTION ENGINE
// ═══════════════════════════════════════════════════════════

export async function autoResolveClusters(thresholds?: { min_confidence?: number; auto_ignore_singletons?: boolean }): Promise<{
  resolved: number; ignored: number;
}> {
  const minConf = thresholds?.min_confidence ?? 95;
  const ignoreSingletons = thresholds?.auto_ignore_singletons ?? true;
  let resolved = 0;
  let ignored = 0;

  if (ignoreSingletons) {
    const singletonResult = await pool.query(`
      UPDATE duplicate_clusters SET status = 'ignored', resolved_by = 'auto-engine', resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE total_records <= 1 AND status = 'active'
    `);
    ignored += singletonResult.rowCount || 0;
  }

  const highConfClusters = await pool.query(`
    SELECT id FROM duplicate_clusters
    WHERE confidence_score >= $1 AND total_records > 1 AND status = 'active'
  `, [minConf]);

  for (const row of highConfClusters.rows) {
    const primaryCheck = await pool.query(
      'SELECT id FROM duplicate_records WHERE cluster_id = $1 AND is_primary = true LIMIT 1',
      [row.id]
    );
    if (primaryCheck.rows[0]) {
      await resolveCluster(row.id, 'resolve', 'auto-engine', primaryCheck.rows[0].id, 'Auto-resolved: high confidence with clear primary');
      resolved++;
    }
  }

  return { resolved, ignored };
}

// ═══════════════════════════════════════════════════════════
//  SMARTER AI RECOMMENDATIONS
// ═══════════════════════════════════════════════════════════

export function scoreRecordCompleteness(record: any): number {
  let score = 0;
  const fields = ['email', 'phone', 'company_name', 'owner_name', 'source', 'domain'];
  for (const f of fields) {
    if (record[f] && String(record[f]).trim()) score += 15;
  }
  if (record.deal_value && parseFloat(record.deal_value) > 0) score += 10;
  return Math.min(score, 100);
}

export function generateSmartRecommendation(records: DuplicateRecord[]): {
  primary_id: number | null;
  recommendations: Array<{
    record_id: number; record_name: string; action: string; reason: string; completeness: number;
  }>;
  summary: string;
} {
  if (records.length === 0) return { primary_id: null, recommendations: [], summary: 'No records to analyze' };

  const scored = records.map(r => ({
    ...r,
    completeness: scoreRecordCompleteness(r),
    hasActiveDeal: r.record_type === 'deal' && r.stage && !['Closed Lost', 'Closed Won'].includes(r.stage),
    recentActivity: r.modified_date ? new Date(r.modified_date).getTime() : 0,
    age: r.created_date ? new Date(r.created_date).getTime() : Date.now()
  }));

  scored.sort((a, b) => {
    if (a.hasActiveDeal !== b.hasActiveDeal) return a.hasActiveDeal ? -1 : 1;
    if (a.completeness !== b.completeness) return b.completeness - a.completeness;
    if (a.recentActivity !== b.recentActivity) return b.recentActivity - a.recentActivity;
    return a.age - b.age;
  });

  const best = scored[0];
  const recs = scored.map((r, i) => ({
    record_id: r.id!,
    record_name: r.record_name,
    action: i === 0 ? 'KEEP' : r.record_type === 'lead' && scored.some(s => s.record_type === 'deal') ? 'CLOSE' : 'MERGE',
    reason: i === 0
      ? `Best candidate: ${r.completeness}% complete${r.hasActiveDeal ? ', active deal' : ''}`
      : r.record_type === 'lead' && scored.some(s => s.record_type === 'deal')
        ? 'Close lead — deal exists for this company'
        : `Merge into primary (${r.completeness}% complete, less recent)`,
    completeness: r.completeness
  }));

  return {
    primary_id: best.id || null,
    recommendations: recs,
    summary: `Analyzed ${records.length} records. Recommend keeping "${best.record_name}" (${best.completeness}% complete${best.hasActiveDeal ? ', active deal' : ', earliest'}). ${records.length - 1} duplicate(s) for merge/closure.`
  };
}

// ═══════════════════════════════════════════════════════════
//  SYNC STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════

export async function getSyncState(): Promise<ZohoSyncState[]> {
  const result = await pool.query('SELECT * FROM zoho_sync_state ORDER BY module');
  return result.rows;
}

export async function getSyncStateForModule(module: string): Promise<ZohoSyncState | null> {
  const result = await pool.query('SELECT * FROM zoho_sync_state WHERE module = $1', [module]);
  return result.rows[0] || null;
}

export async function upsertSyncState(module: string, updates: Partial<ZohoSyncState>): Promise<void> {
  await pool.query(`
    INSERT INTO zoho_sync_state (module, last_sync_at, total_synced, last_full_sync_at, sync_status, error_message, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
    ON CONFLICT (module) DO UPDATE SET
      last_sync_at = COALESCE($2, zoho_sync_state.last_sync_at),
      total_synced = COALESCE($3, zoho_sync_state.total_synced),
      last_full_sync_at = COALESCE($4, zoho_sync_state.last_full_sync_at),
      sync_status = COALESCE($5, zoho_sync_state.sync_status),
      error_message = $6,
      updated_at = CURRENT_TIMESTAMP
  `, [module, updates.last_sync_at || null, updates.total_synced ?? null, updates.last_full_sync_at || null,
      updates.sync_status || null, updates.error_message || null]);
}

// ═══════════════════════════════════════════════════════════
//  FILTER METADATA
// ═══════════════════════════════════════════════════════════

export async function getDistinctOwners(): Promise<Array<{ owner_name: string; record_count: number }>> {
  const result = await pool.query(`
    SELECT owner_name, COUNT(*) as record_count
    FROM duplicate_records
    WHERE owner_name IS NOT NULL AND owner_name != '' AND owner_name != 'Unknown'
    GROUP BY owner_name
    ORDER BY record_count DESC
    LIMIT 200
  `);
  return result.rows;
}

export async function getDistinctLayouts(): Promise<Array<{ layout_name: string; zoho_module: string; record_count: number }>> {
  const result = await pool.query(`
    SELECT layout_name, zoho_module, COUNT(*) as record_count
    FROM duplicate_records
    WHERE layout_name IS NOT NULL AND layout_name != ''
    GROUP BY layout_name, zoho_module
    ORDER BY zoho_module, record_count DESC
  `);
  return result.rows;
}

export async function getDistinctDomains(): Promise<Array<{ domain: string; record_count: number }>> {
  const result = await pool.query(`
    SELECT domain, COUNT(*) as record_count
    FROM duplicate_records
    WHERE domain IS NOT NULL AND domain != '' AND domain NOT LIKE '%.cluster'
    GROUP BY domain
    ORDER BY record_count DESC
    LIMIT 500
  `);
  return result.rows;
}

export async function getDistinctProducts(): Promise<Array<{ products: string; record_count: number }>> {
  const result = await pool.query(`
    SELECT products, COUNT(*) as record_count
    FROM duplicate_records
    WHERE products IS NOT NULL AND products != ''
    GROUP BY products
    ORDER BY record_count DESC
  `);
  return result.rows;
}

export async function getDistinctPipelines(): Promise<Array<{ pipeline: string; record_count: number }>> {
  const result = await pool.query(`
    SELECT pipeline, COUNT(*) as record_count
    FROM duplicate_records
    WHERE pipeline IS NOT NULL AND pipeline != ''
    GROUP BY pipeline
    ORDER BY record_count DESC
  `);
  return result.rows;
}

export interface DuplicateFilters {
  module?: string;
  layout?: string;
  owner?: string;
  start_date?: string;
  end_date?: string;
  domain?: string;
  products?: string;
  pipeline?: string;
  status?: string;
  confidence_level?: string;
  limit?: number;
  offset?: number;
  sort_by?: string;
  sort_order?: string;
}

function buildFilterWhere(filters: DuplicateFilters, tableAlias: string = 'dr'): { where: string; params: any[]; nextIndex: number } {
  const conditions: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (filters.module) {
    conditions.push(`${tableAlias}.zoho_module = $${idx++}`);
    params.push(filters.module);
  }
  if (filters.layout) {
    conditions.push(`${tableAlias}.layout_name = $${idx++}`);
    params.push(filters.layout);
  }
  if (filters.owner) {
    conditions.push(`${tableAlias}.owner_name = $${idx++}`);
    params.push(filters.owner);
  }
  if (filters.start_date) {
    conditions.push(`${tableAlias}.created_date >= $${idx++}`);
    params.push(filters.start_date);
  }
  if (filters.end_date) {
    conditions.push(`${tableAlias}.created_date <= $${idx++}`);
    params.push(filters.end_date);
  }
  if (filters.domain) {
    conditions.push(`LOWER(${tableAlias}.domain) LIKE LOWER($${idx++})`);
    params.push(`%${filters.domain}%`);
  }
  if (filters.products) {
    conditions.push(`${tableAlias}.products = $${idx++}`);
    params.push(filters.products);
  }
  if (filters.pipeline) {
    conditions.push(`${tableAlias}.pipeline = $${idx++}`);
    params.push(filters.pipeline);
  }

  return {
    where: conditions.length > 0 ? conditions.join(' AND ') : '1=1',
    params,
    nextIndex: idx
  };
}

export async function getFilteredClusters(filters: DuplicateFilters): Promise<{ clusters: DuplicateCluster[]; total: number }> {
  const hasRecordFilters = filters.module || filters.layout || filters.owner || filters.start_date
    || filters.end_date || filters.domain || filters.products || filters.pipeline;

  if (!hasRecordFilters) {
    const clusters = await getAllClusters({
      status: filters.status, confidence_level: filters.confidence_level,
      limit: filters.limit || 100, offset: filters.offset || 0
    });
    const total = await getClusterCount({ status: filters.status, confidence_level: filters.confidence_level });
    return { clusters, total };
  }

  const { where, params, nextIndex } = buildFilterWhere(filters);
  let idx = nextIndex;
  let statusFilter = '';
  if (filters.status) {
    statusFilter = ` AND dc.status = $${idx++}`;
    params.push(filters.status);
  }
  if (filters.confidence_level) {
    statusFilter += ` AND dc.confidence_level = $${idx++}`;
    params.push(filters.confidence_level);
  }

  const countResult = await pool.query(`
    SELECT COUNT(DISTINCT dc.id) as total
    FROM duplicate_clusters dc
    JOIN duplicate_records dr ON dr.cluster_id = dc.id
    WHERE ${where} ${statusFilter}
  `, params);

  const limit = filters.limit || 100;
  const offset = filters.offset || 0;
  const dataParams = [...params, limit, offset];
  const dataResult = await pool.query(`
    SELECT DISTINCT dc.*
    FROM duplicate_clusters dc
    JOIN duplicate_records dr ON dr.cluster_id = dc.id
    WHERE ${where} ${statusFilter}
    ORDER BY dc.total_records DESC, dc.confidence_score DESC
    LIMIT $${idx++} OFFSET $${idx++}
  `, dataParams);

  return {
    clusters: dataResult.rows,
    total: parseInt(countResult.rows[0]?.total) || 0
  };
}

export async function getFilteredSummary(filters: DuplicateFilters): Promise<any> {
  const hasRecordFilters = filters.module || filters.layout || filters.owner || filters.start_date
    || filters.end_date || filters.domain || filters.products || filters.pipeline;

  if (!hasRecordFilters) {
    return getEnhancedSummary();
  }

  const { where, params } = buildFilterWhere(filters);

  const result = await pool.query(`
    SELECT
      COUNT(DISTINCT dc.id) as total_clusters,
      COUNT(DISTINCT dc.id) FILTER (WHERE dc.total_records > 1) as true_duplicate_clusters,
      COUNT(dr.id) as total_records,
      COUNT(dr.id) FILTER (WHERE dr.record_type = 'lead') as total_leads,
      COUNT(dr.id) FILTER (WHERE dr.record_type = 'deal') as total_deals,
      COUNT(dr.id) FILTER (WHERE dr.record_type = 'contact') as total_contacts,
      COUNT(dr.id) FILTER (WHERE dr.record_type = 'account') as total_accounts,
      COUNT(DISTINCT dc.id) FILTER (WHERE dc.confidence_level = 'high') as high_confidence,
      COUNT(DISTINCT dc.id) FILTER (WHERE dc.confidence_level = 'medium') as medium_confidence,
      COUNT(DISTINCT dc.id) FILTER (WHERE dc.confidence_level = 'low') as low_confidence,
      COALESCE(SUM(dc.estimated_pipeline_value), 0) as pipeline_inflation,
      COUNT(DISTINCT dc.id) FILTER (WHERE dc.status = 'active') as active_clusters,
      COUNT(DISTINCT dc.id) FILTER (WHERE dc.status = 'resolved') as resolved_clusters
    FROM duplicate_records dr
    JOIN duplicate_clusters dc ON dr.cluster_id = dc.id
    WHERE ${where}
  `, params);

  const row = result.rows[0];
  return {
    totalClusters: parseInt(row.total_clusters) || 0,
    trueDuplicateClusters: parseInt(row.true_duplicate_clusters) || 0,
    totalRecords: parseInt(row.total_records) || 0,
    totalLeads: parseInt(row.total_leads) || 0,
    totalDeals: parseInt(row.total_deals) || 0,
    totalContacts: parseInt(row.total_contacts) || 0,
    totalAccounts: parseInt(row.total_accounts) || 0,
    highConfidence: parseInt(row.high_confidence) || 0,
    mediumConfidence: parseInt(row.medium_confidence) || 0,
    lowConfidence: parseInt(row.low_confidence) || 0,
    estimatedPipelineInflation: parseFloat(row.pipeline_inflation) || 0,
    activeClusters: parseInt(row.active_clusters) || 0,
    resolvedClusters: parseInt(row.resolved_clusters) || 0
  };
}

// ═══════════════════════════════════════════════════════════
//  TASK FUNCTIONS
// ═══════════════════════════════════════════════════════════

export async function upsertTask(task: Omit<DuplicateRecordTask, 'id' | 'created_at'>): Promise<void> {
  await pool.query(`
    INSERT INTO duplicate_record_tasks (zoho_task_id, related_record_id, subject, due_date, status, priority, owner_name)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (zoho_task_id) DO UPDATE SET
      related_record_id = EXCLUDED.related_record_id,
      subject = EXCLUDED.subject,
      due_date = EXCLUDED.due_date,
      status = EXCLUDED.status,
      priority = EXCLUDED.priority,
      owner_name = EXCLUDED.owner_name
  `, [task.zoho_task_id, task.related_record_id || null, task.subject || null,
      task.due_date || null, task.status || null, task.priority || null, task.owner_name || null]);
}

export async function getTasksForRecords(zohoRecordIds: string[]): Promise<DuplicateRecordTask[]> {
  if (zohoRecordIds.length === 0) return [];
  const result = await pool.query(
    'SELECT * FROM duplicate_record_tasks WHERE related_record_id = ANY($1) ORDER BY due_date ASC',
    [zohoRecordIds]
  );
  return result.rows;
}

export async function getTaskCountForCluster(clusterId: number): Promise<number> {
  const result = await pool.query(`
    SELECT COUNT(t.id) as task_count
    FROM duplicate_record_tasks t
    JOIN duplicate_records dr ON t.related_record_id = dr.zoho_record_id
    WHERE dr.cluster_id = $1
  `, [clusterId]);
  return parseInt(result.rows[0]?.task_count) || 0;
}

// ═══════════════════════════════════════════════════════════
//  ENHANCED MULTI-SIGNAL SCORING (with new fields)
// ═══════════════════════════════════════════════════════════

export function calculateEnhancedScore(record1: any, record2: any): { score: number; signals: string[] } {
  let score = 0;
  const signals: string[] = [];

  // CR Number match = definite duplicate
  if (record1.cr_number && record2.cr_number && record1.cr_number === record2.cr_number) {
    return { score: 99, signals: ['cr_number_match'] };
  }
  // VAT Number match = definite duplicate
  if (record1.vat_number && record2.vat_number && record1.vat_number === record2.vat_number) {
    return { score: 99, signals: ['vat_number_match'] };
  }

  // Website domain match
  if (record1.website && record2.website) {
    const d1 = extractDomain(record1.website);
    const d2 = extractDomain(record2.website);
    if (d1 && d2 && d1 === d2) {
      score += 35;
      signals.push('website_match');
    }
  }

  // Email exact match
  if (record1.email && record2.email) {
    if (record1.email.toLowerCase() === record2.email.toLowerCase()) {
      score += 35;
      signals.push('email_exact');
    } else {
      const d1 = extractDomain(record1.email);
      const d2 = extractDomain(record2.email);
      if (d1 && d2 && d1 === d2 && !isPublicDomain(d1)) {
        score += 15;
        signals.push('email_domain');
      }
    }
  }

  // Phone match (including mobile cross-check)
  const phones1 = [record1.phone_normalized, record1.mobile_normalized].filter(Boolean);
  const phones2 = [record2.phone_normalized, record2.mobile_normalized].filter(Boolean);
  for (const p1 of phones1) {
    for (const p2 of phones2) {
      if (p1 && p2 && p1.length >= 7 && p1 === p2) {
        score += 30;
        signals.push('phone_match');
        break;
      }
    }
    if (signals.includes('phone_match')) break;
  }

  // Company name match
  if (record1.company_name && record2.company_name) {
    const sim = calculateSimilarity(normalizeCompanyName(record1.company_name), normalizeCompanyName(record2.company_name));
    if (sim >= 90) {
      score += 20;
      signals.push('company_exact');
    } else if (sim >= 75) {
      score += 10;
      signals.push('company_fuzzy');
    }
  }

  // Account name match (for deals/contacts)
  if (record1.account_name && record2.account_name) {
    const sim = calculateSimilarity(normalizeCompanyName(record1.account_name), normalizeCompanyName(record2.account_name));
    if (sim >= 90) {
      score += 15;
      signals.push('account_match');
    }
  }

  return { score: Math.min(score, 100), signals };
}

function isPublicDomain(domain: string): boolean {
  const public_domains = ['gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com','aol.com','live.com','mail.com','protonmail.com'];
  return public_domains.includes(domain.toLowerCase());
}

// ═══════════════════════════════════════════════════════════
//  DATA QUALITY STATS
// ═══════════════════════════════════════════════════════════

export async function getDataQualityStats(): Promise<{
  totalRecords: number;
  junkRecords: number;
  avgQualityScore: number;
  qualityDistribution: { bucket: string; count: number }[];
  topIssues: { flag: string; count: number }[];
  byModule: { module: string; avgScore: number; junkCount: number; totalCount: number }[];
}> {
  const totalRes = await pool.query('SELECT COUNT(*) as cnt FROM duplicate_records WHERE is_mock_data = false');
  const totalRecords = parseInt(totalRes.rows[0].cnt) || 0;

  const junkRes = await pool.query('SELECT COUNT(*) as cnt FROM duplicate_records WHERE is_mock_data = false AND data_quality_score <= 20');
  const junkRecords = parseInt(junkRes.rows[0].cnt) || 0;

  const avgRes = await pool.query('SELECT ROUND(AVG(data_quality_score)) as avg FROM duplicate_records WHERE is_mock_data = false');
  const avgQualityScore = parseInt(avgRes.rows[0]?.avg) || 0;

  const distRes = await pool.query(`
    SELECT
      CASE
        WHEN data_quality_score >= 80 THEN 'Good (80-100)'
        WHEN data_quality_score >= 50 THEN 'Fair (50-79)'
        WHEN data_quality_score >= 21 THEN 'Poor (21-49)'
        ELSE 'Junk (0-20)'
      END as bucket,
      COUNT(*) as count
    FROM duplicate_records WHERE is_mock_data = false
    GROUP BY bucket ORDER BY MIN(data_quality_score) DESC
  `);

  const flagRes = await pool.query(`
    SELECT flag, COUNT(*) as count
    FROM duplicate_records, jsonb_array_elements_text(data_quality_flags) AS flag
    WHERE is_mock_data = false
    GROUP BY flag ORDER BY count DESC LIMIT 15
  `);

  const modRes = await pool.query(`
    SELECT zoho_module as module,
      ROUND(AVG(data_quality_score)) as avg_score,
      COUNT(*) FILTER (WHERE data_quality_score <= 20) as junk_count,
      COUNT(*) as total_count
    FROM duplicate_records WHERE is_mock_data = false AND zoho_module IS NOT NULL
    GROUP BY zoho_module ORDER BY zoho_module
  `);

  return {
    totalRecords,
    junkRecords,
    avgQualityScore,
    qualityDistribution: distRes.rows,
    topIssues: flagRes.rows,
    byModule: modRes.rows.map((r: any) => ({
      module: r.module,
      avgScore: parseInt(r.avg_score) || 0,
      junkCount: parseInt(r.junk_count) || 0,
      totalCount: parseInt(r.total_count) || 0,
    })),
  };
}

export async function lookupRecordsByZohoIds(zohoIds: string[]): Promise<{
  [zohoId: string]: {
    clusterId: number;
    clusterDomain: string;
    clusterCompany: string | null;
    confidenceLevel: string;
    confidenceScore: number;
    totalInCluster: number;
    dataQualityScore: number;
    dataQualityFlags: string[];
    recordType: string;
    isJunk: boolean;
  };
}> {
  if (!zohoIds.length) return {};
  const result = await pool.query(
    `SELECT dr.zoho_record_id, dr.cluster_id, dr.record_type,
            dr.data_quality_score, dr.data_quality_flags,
            dc.domain, dc.company_name, dc.confidence_level,
            dc.confidence_score, dc.total_records
     FROM duplicate_records dr
     JOIN duplicate_clusters dc ON dc.id = dr.cluster_id
     WHERE dr.zoho_record_id = ANY($1)`,
    [zohoIds]
  );
  const map: Record<string, any> = {};
  for (const row of result.rows) {
    map[row.zoho_record_id] = {
      clusterId: row.cluster_id,
      clusterDomain: row.domain,
      clusterCompany: row.company_name,
      confidenceLevel: row.confidence_level,
      confidenceScore: row.confidence_score,
      totalInCluster: row.total_records,
      dataQualityScore: row.data_quality_score ?? 100,
      dataQualityFlags: row.data_quality_flags || [],
      recordType: row.record_type,
      isJunk: row.cluster_id && row.domain === '__JUNK_RECORDS__',
    };
  }
  return map;
}

export async function runLiveQualityCheck(records: Array<{
  id: string;
  Full_Name?: string;
  Last_Name?: string;
  First_Name?: string;
  Company?: string;
  Account_Name?: any;
  Deal_Name?: string;
  Email?: string;
  Phone?: string;
  Mobile?: string;
  Owner?: any;
}>): Promise<{ [id: string]: { score: number; flags: string[]; isJunk: boolean } }> {
  const results: Record<string, any> = {};
  for (const r of records) {
    const name = r.Full_Name || r.Deal_Name || (r.First_Name ? `${r.First_Name} ${r.Last_Name || ''}`.trim() : r.Last_Name) || '';
    const company = typeof r.Company === 'string' ? r.Company : (typeof r.Account_Name === 'object' ? r.Account_Name?.name : r.Account_Name) || '';
    const owner = typeof r.Owner === 'object' ? r.Owner?.name : r.Owner || '';
    const email = r.Email || '';
    const phone = r.Phone || '';
    const mobile = r.Mobile || '';
    const domain = email.includes('@') ? email.split('@')[1] : undefined;
    const dq = assessDataQuality({ recordName: name, companyName: company, email, phone, mobile, ownerName: owner, domain });
    results[r.id] = { score: dq.score, flags: dq.flags, isJunk: dq.isJunk };
  }
  return results;
}

export { pool };
