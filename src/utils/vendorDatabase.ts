import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export interface Vendor {
  id?: number;
  vendor_code: string;
  name: string;
  description?: string;
  category: 'technology' | 'consulting' | 'manufacturing' | 'logistics' | 'financial' | 'professional_services' | 'other';
  criticality: 'critical' | 'high' | 'medium' | 'low';
  status: 'active' | 'pending_approval' | 'probation' | 'inactive' | 'terminated';
  contract_start?: Date;
  contract_end?: Date;
  contract_value?: number;
  primary_contact_name?: string;
  primary_contact_email?: string;
  primary_contact_phone?: string;
  country?: string;
  services_provided?: string;
  data_access_level?: 'none' | 'limited' | 'sensitive' | 'critical';
  last_assessment_date?: Date;
  next_assessment_date?: Date;
  overall_risk_score?: number;
  overall_risk_level?: string;
  owner_name?: string;
  owner_department?: string;
  created_by?: string;
  created_at?: Date;
  updated_at?: Date;
}

export interface VendorAssessment {
  id?: number;
  vendor_id: number;
  assessment_type: 'initial' | 'periodic' | 'triggered' | 'exit';
  assessment_date?: Date;
  assessed_by: string;
  status: 'draft' | 'in_progress' | 'completed' | 'approved';
  security_score?: number;
  financial_score?: number;
  operational_score?: number;
  compliance_score?: number;
  overall_score?: number;
  risk_level?: 'critical' | 'high' | 'medium' | 'low';
  security_findings?: string;
  financial_findings?: string;
  operational_findings?: string;
  compliance_findings?: string;
  recommendations?: string;
  next_assessment_date?: Date;
  approved_by?: string;
  approved_date?: Date;
  created_at?: Date;
  updated_at?: Date;
}

export interface VendorRemediation {
  id?: number;
  vendor_id: number;
  assessment_id?: number;
  title: string;
  description: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  category: 'security' | 'financial' | 'operational' | 'compliance';
  status: 'open' | 'in_progress' | 'pending_verification' | 'closed' | 'waived';
  assigned_to?: string;
  due_date?: Date;
  completed_date?: Date;
  evidence?: string;
  waiver_reason?: string;
  waiver_approved_by?: string;
  created_at?: Date;
  updated_at?: Date;
}

export async function initVendorTables(): Promise<void> {
  console.log('📋 [VendorDB] Initializing vendor risk tables...');
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vendors (
      id SERIAL PRIMARY KEY,
      vendor_code VARCHAR(50) UNIQUE NOT NULL,
      name VARCHAR(500) NOT NULL,
      description TEXT,
      category VARCHAR(50) NOT NULL,
      criticality VARCHAR(20) DEFAULT 'medium',
      status VARCHAR(30) DEFAULT 'pending_approval',
      contract_start TIMESTAMP,
      contract_end TIMESTAMP,
      contract_value DECIMAL(15,2),
      primary_contact_name VARCHAR(255),
      primary_contact_email VARCHAR(255),
      primary_contact_phone VARCHAR(100),
      country VARCHAR(100),
      services_provided TEXT,
      data_access_level VARCHAR(20) DEFAULT 'none',
      last_assessment_date TIMESTAMP,
      next_assessment_date TIMESTAMP,
      overall_risk_score INTEGER,
      overall_risk_level VARCHAR(20),
      owner_name VARCHAR(255),
      owner_department VARCHAR(100),
      created_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS vendor_assessments (
      id SERIAL PRIMARY KEY,
      vendor_id INTEGER REFERENCES vendors(id) ON DELETE CASCADE,
      assessment_type VARCHAR(20) NOT NULL,
      assessment_date TIMESTAMP DEFAULT NOW(),
      assessed_by VARCHAR(255) NOT NULL,
      status VARCHAR(20) DEFAULT 'draft',
      security_score INTEGER,
      financial_score INTEGER,
      operational_score INTEGER,
      compliance_score INTEGER,
      overall_score INTEGER,
      risk_level VARCHAR(20),
      security_findings TEXT,
      financial_findings TEXT,
      operational_findings TEXT,
      compliance_findings TEXT,
      recommendations TEXT,
      next_assessment_date TIMESTAMP,
      approved_by VARCHAR(255),
      approved_date TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS vendor_remediations (
      id SERIAL PRIMARY KEY,
      vendor_id INTEGER REFERENCES vendors(id) ON DELETE CASCADE,
      assessment_id INTEGER REFERENCES vendor_assessments(id) ON DELETE SET NULL,
      title VARCHAR(500) NOT NULL,
      description TEXT NOT NULL,
      priority VARCHAR(20) NOT NULL,
      category VARCHAR(30) NOT NULL,
      status VARCHAR(30) DEFAULT 'open',
      assigned_to VARCHAR(255),
      due_date TIMESTAMP,
      completed_date TIMESTAMP,
      evidence TEXT,
      waiver_reason TEXT,
      waiver_approved_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  console.log('✅ [VendorDB] Vendor risk tables initialized');
}

export async function createVendor(vendor: Vendor): Promise<Vendor> {
  console.log('📝 [VendorDB] Creating vendor:', vendor.name);
  
  const result = await pool.query(`
    INSERT INTO vendors (
      vendor_code, name, description, category, criticality, status,
      contract_start, contract_end, contract_value,
      primary_contact_name, primary_contact_email, primary_contact_phone,
      country, services_provided, data_access_level,
      owner_name, owner_department, created_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
    RETURNING *
  `, [
    vendor.vendor_code, vendor.name, vendor.description, vendor.category,
    vendor.criticality || 'medium', vendor.status || 'pending_approval',
    vendor.contract_start, vendor.contract_end, vendor.contract_value,
    vendor.primary_contact_name, vendor.primary_contact_email, vendor.primary_contact_phone,
    vendor.country, vendor.services_provided, vendor.data_access_level || 'none',
    vendor.owner_name, vendor.owner_department, vendor.created_by
  ]);

  return result.rows[0];
}

export async function updateVendor(id: number, updates: Partial<Vendor>): Promise<Vendor> {
  const setClause: string[] = [];
  const values: any[] = [];
  let paramCount = 1;

  const allowedFields = ['name', 'description', 'category', 'criticality', 'status', 'contract_start', 'contract_end', 'contract_value', 'primary_contact_name', 'primary_contact_email', 'primary_contact_phone', 'country', 'services_provided', 'data_access_level', 'last_assessment_date', 'next_assessment_date', 'overall_risk_score', 'overall_risk_level', 'owner_name', 'owner_department'];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key) && value !== undefined) {
      setClause.push(`${key} = $${paramCount}`);
      values.push(value);
      paramCount++;
    }
  }

  setClause.push('updated_at = NOW()');
  values.push(id);

  const result = await pool.query(`UPDATE vendors SET ${setClause.join(', ')} WHERE id = $${paramCount} RETURNING *`, values);
  return result.rows[0];
}

export async function getVendorById(id: number): Promise<Vendor | null> {
  const result = await pool.query('SELECT * FROM vendors WHERE id = $1', [id]);
  return result.rows[0] || null;
}

export async function getAllVendors(filters?: { status?: string; criticality?: string; category?: string; search?: string }): Promise<{ vendors: Vendor[]; total: number }> {
  let query = 'SELECT * FROM vendors WHERE 1=1';
  const values: any[] = [];
  let paramCount = 1;

  if (filters?.status) {
    query += ` AND status = $${paramCount}`;
    values.push(filters.status);
    paramCount++;
  }
  if (filters?.criticality) {
    query += ` AND criticality = $${paramCount}`;
    values.push(filters.criticality);
    paramCount++;
  }
  if (filters?.category) {
    query += ` AND category = $${paramCount}`;
    values.push(filters.category);
    paramCount++;
  }
  if (filters?.search) {
    query += ` AND (name ILIKE $${paramCount} OR vendor_code ILIKE $${paramCount})`;
    values.push(`%${filters.search}%`);
    paramCount++;
  }

  const countResult = await pool.query(`SELECT COUNT(*) FROM vendors WHERE 1=1` + query.replace('SELECT * FROM vendors WHERE 1=1', ''), values);
  
  query += ' ORDER BY criticality DESC, name ASC';
  const result = await pool.query(query, values);
  
  return { vendors: result.rows, total: parseInt(countResult.rows[0].count) };
}

export async function createAssessment(assessment: VendorAssessment): Promise<VendorAssessment> {
  console.log('📝 [VendorDB] Creating vendor assessment for vendor:', assessment.vendor_id);
  
  const overallScore = Math.round(
    ((assessment.security_score || 0) + (assessment.financial_score || 0) + 
     (assessment.operational_score || 0) + (assessment.compliance_score || 0)) / 4
  );

  let riskLevel = 'low';
  if (overallScore < 40) riskLevel = 'critical';
  else if (overallScore < 60) riskLevel = 'high';
  else if (overallScore < 80) riskLevel = 'medium';

  const result = await pool.query(`
    INSERT INTO vendor_assessments (
      vendor_id, assessment_type, assessment_date, assessed_by, status,
      security_score, financial_score, operational_score, compliance_score,
      overall_score, risk_level,
      security_findings, financial_findings, operational_findings, compliance_findings,
      recommendations, next_assessment_date
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
    RETURNING *
  `, [
    assessment.vendor_id, assessment.assessment_type, assessment.assessment_date || new Date(),
    assessment.assessed_by, assessment.status || 'draft',
    assessment.security_score, assessment.financial_score, assessment.operational_score, assessment.compliance_score,
    overallScore, riskLevel,
    assessment.security_findings, assessment.financial_findings, assessment.operational_findings, assessment.compliance_findings,
    assessment.recommendations, assessment.next_assessment_date
  ]);

  if (assessment.status === 'completed' || assessment.status === 'approved') {
    await updateVendor(assessment.vendor_id, {
      last_assessment_date: new Date(),
      next_assessment_date: assessment.next_assessment_date,
      overall_risk_score: overallScore,
      overall_risk_level: riskLevel
    });
  }

  return result.rows[0];
}

export async function getAssessmentsByVendor(vendorId: number): Promise<VendorAssessment[]> {
  const result = await pool.query('SELECT * FROM vendor_assessments WHERE vendor_id = $1 ORDER BY assessment_date DESC', [vendorId]);
  return result.rows;
}

export async function createRemediation(remediation: VendorRemediation): Promise<VendorRemediation> {
  console.log('📝 [VendorDB] Creating vendor remediation:', remediation.title);
  
  const result = await pool.query(`
    INSERT INTO vendor_remediations (vendor_id, assessment_id, title, description, priority, category, status, assigned_to, due_date)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *
  `, [
    remediation.vendor_id, remediation.assessment_id, remediation.title, remediation.description,
    remediation.priority, remediation.category, remediation.status || 'open',
    remediation.assigned_to, remediation.due_date
  ]);

  return result.rows[0];
}

export async function updateRemediation(id: number, updates: Partial<VendorRemediation>): Promise<VendorRemediation> {
  const setClause: string[] = [];
  const values: any[] = [];
  let paramCount = 1;

  const allowedFields = ['title', 'description', 'priority', 'category', 'status', 'assigned_to', 'due_date', 'completed_date', 'evidence', 'waiver_reason', 'waiver_approved_by'];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key) && value !== undefined) {
      setClause.push(`${key} = $${paramCount}`);
      values.push(value);
      paramCount++;
    }
  }

  setClause.push('updated_at = NOW()');
  values.push(id);

  const result = await pool.query(`UPDATE vendor_remediations SET ${setClause.join(', ')} WHERE id = $${paramCount} RETURNING *`, values);
  return result.rows[0];
}

export async function getRemediationsByVendor(vendorId: number): Promise<VendorRemediation[]> {
  const result = await pool.query('SELECT * FROM vendor_remediations WHERE vendor_id = $1 ORDER BY priority DESC, due_date ASC', [vendorId]);
  return result.rows;
}

export async function getAllRemediations(filters?: { status?: string; priority?: string }): Promise<{ remediations: VendorRemediation[]; total: number }> {
  let query = 'SELECT r.*, v.name as vendor_name, v.vendor_code FROM vendor_remediations r LEFT JOIN vendors v ON r.vendor_id = v.id WHERE 1=1';
  const values: any[] = [];
  let paramCount = 1;

  if (filters?.status) {
    query += ` AND r.status = $${paramCount}`;
    values.push(filters.status);
    paramCount++;
  }
  if (filters?.priority) {
    query += ` AND r.priority = $${paramCount}`;
    values.push(filters.priority);
    paramCount++;
  }

  const countResult = await pool.query(`SELECT COUNT(*) FROM vendor_remediations r WHERE 1=1` + query.replace(/SELECT r\.\*, v\.name as vendor_name, v\.vendor_code FROM vendor_remediations r LEFT JOIN vendors v ON r\.vendor_id = v\.id WHERE 1=1/, ''), values);
  
  query += ' ORDER BY r.priority DESC, r.due_date ASC';
  const result = await pool.query(query, values);
  
  return { remediations: result.rows, total: parseInt(countResult.rows[0].count) };
}

export async function getVendorSummary(): Promise<any> {
  console.log('📊 [VendorDB] Generating vendor summary...');

  const vendorStats = await pool.query(`
    SELECT 
      COUNT(*) as total_vendors,
      COUNT(*) FILTER (WHERE status = 'active') as active,
      COUNT(*) FILTER (WHERE status = 'pending_approval') as pending_approval,
      COUNT(*) FILTER (WHERE status = 'probation') as on_probation,
      COUNT(*) FILTER (WHERE status = 'inactive') as inactive,
      COUNT(*) FILTER (WHERE criticality = 'critical') as critical_vendors,
      COUNT(*) FILTER (WHERE data_access_level IN ('sensitive', 'critical')) as high_data_access
    FROM vendors
  `);

  const byCriticality = await pool.query(`
    SELECT criticality, COUNT(*) as count
    FROM vendors
    WHERE status = 'active'
    GROUP BY criticality
    ORDER BY 
      CASE criticality 
        WHEN 'critical' THEN 1 
        WHEN 'high' THEN 2 
        WHEN 'medium' THEN 3 
        ELSE 4 
      END
  `);

  const byRiskLevel = await pool.query(`
    SELECT overall_risk_level as risk_level, COUNT(*) as count
    FROM vendors
    WHERE status = 'active' AND overall_risk_level IS NOT NULL
    GROUP BY overall_risk_level
  `);

  const openRemediations = await pool.query(`
    SELECT 
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'open') as open,
      COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress,
      COUNT(*) FILTER (WHERE due_date < NOW() AND status NOT IN ('closed', 'waived')) as overdue
    FROM vendor_remediations
  `);

  const expiringContracts = await pool.query(`
    SELECT id, vendor_code, name, contract_end, criticality
    FROM vendors
    WHERE status = 'active'
    AND contract_end BETWEEN NOW() AND NOW() + INTERVAL '90 days'
    ORDER BY contract_end ASC
    LIMIT 5
  `);

  const dueDueAssessments = await pool.query(`
    SELECT id, vendor_code, name, next_assessment_date, criticality
    FROM vendors
    WHERE status = 'active'
    AND next_assessment_date < NOW()
    ORDER BY next_assessment_date ASC
    LIMIT 5
  `);

  return {
    vendors: vendorStats.rows[0],
    by_criticality: byCriticality.rows,
    by_risk_level: byRiskLevel.rows,
    remediations: openRemediations.rows[0],
    expiring_contracts: expiringContracts.rows,
    overdue_assessments: dueDueAssessments.rows
  };
}
