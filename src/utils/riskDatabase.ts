import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export interface EnterpriseRisk {
  id?: number;
  risk_title: string;
  risk_description: string;
  risk_category: 'operational' | 'legal' | 'financial' | 'data_privacy' | 'information_security' | 'fraud' | 'vendor';
  risk_source?: string;
  identified_date?: Date;
  identified_by?: string;
  risk_owner?: string;
  owner_department?: string;
  impact_score: number;
  likelihood_score: number;
  risk_score?: number;
  risk_level?: 'critical' | 'high' | 'medium' | 'low';
  treatment_strategy?: 'mitigate' | 'accept' | 'transfer' | 'avoid';
  treatment_description?: string;
  treatment_owner?: string;
  treatment_deadline?: Date;
  residual_impact?: number;
  residual_likelihood?: number;
  residual_risk_score?: number;
  control_ids?: number[];
  policy_ids?: number[];
  review_frequency?: 'monthly' | 'quarterly' | 'semi_annual' | 'annual';
  last_review_date?: Date;
  next_review_date?: Date;
  status: 'open' | 'in_treatment' | 'monitoring' | 'closed' | 'escalated';
  escalation_reason?: string;
  linked_audit_id?: number;
  linked_incident_id?: number;
  linked_capa_id?: number;
  ai_detected?: boolean;
  ai_recommendations?: any;
  accepted_by?: string;
  accepted_by_role?: string;
  accepted_at?: Date;
  acceptance_justification?: string;
  grc_approval_required?: boolean;
  created_at?: Date;
  updated_at?: Date;
}

export interface RiskTreatmentAction {
  id?: number;
  risk_id: number;
  action_title: string;
  action_description: string;
  action_type: 'control_implementation' | 'process_change' | 'training' | 'policy_update' | 'technology' | 'insurance' | 'other';
  assigned_to: string;
  due_date: Date;
  status: 'pending' | 'in_progress' | 'completed' | 'overdue' | 'cancelled';
  completion_date?: Date;
  completion_notes?: string;
  evidence_required?: boolean;
  evidence_attached?: boolean;
  evidence_path?: string;
  created_at?: Date;
  updated_at?: Date;
}

export interface RiskAssessmentHistory {
  id?: number;
  risk_id: number;
  assessment_date: Date;
  assessed_by: string;
  previous_impact: number;
  previous_likelihood: number;
  previous_risk_score: number;
  new_impact: number;
  new_likelihood: number;
  new_risk_score: number;
  assessment_notes?: string;
  trigger_reason?: string;
}

export interface RiskCategory {
  id?: number;
  category_name: string;
  category_code: string;
  description?: string;
  parent_category_id?: number;
  is_active: boolean;
}

export async function initRiskTables(): Promise<void> {
  console.log('📊 [RiskDB] Initializing enterprise risk management tables...');
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS enterprise_risks (
      id SERIAL PRIMARY KEY,
      risk_title VARCHAR(500) NOT NULL,
      risk_description TEXT,
      risk_category VARCHAR(50) NOT NULL,
      risk_source VARCHAR(255),
      identified_date TIMESTAMP DEFAULT NOW(),
      identified_by VARCHAR(255),
      risk_owner VARCHAR(255),
      owner_department VARCHAR(100),
      impact_score INTEGER NOT NULL CHECK (impact_score >= 1 AND impact_score <= 5),
      likelihood_score INTEGER NOT NULL CHECK (likelihood_score >= 1 AND likelihood_score <= 5),
      risk_score INTEGER GENERATED ALWAYS AS (impact_score * likelihood_score) STORED,
      risk_level VARCHAR(20) GENERATED ALWAYS AS (
        CASE 
          WHEN impact_score * likelihood_score >= 20 THEN 'critical'
          WHEN impact_score * likelihood_score >= 12 THEN 'high'
          WHEN impact_score * likelihood_score >= 6 THEN 'medium'
          ELSE 'low'
        END
      ) STORED,
      treatment_strategy VARCHAR(20),
      treatment_description TEXT,
      treatment_owner VARCHAR(255),
      treatment_deadline TIMESTAMP,
      residual_impact INTEGER CHECK (residual_impact >= 1 AND residual_impact <= 5),
      residual_likelihood INTEGER CHECK (residual_likelihood >= 1 AND residual_likelihood <= 5),
      residual_risk_score INTEGER GENERATED ALWAYS AS (COALESCE(residual_impact, impact_score) * COALESCE(residual_likelihood, likelihood_score)) STORED,
      control_ids INTEGER[],
      policy_ids INTEGER[],
      review_frequency VARCHAR(20) DEFAULT 'quarterly',
      last_review_date TIMESTAMP,
      next_review_date TIMESTAMP,
      status VARCHAR(20) DEFAULT 'open',
      escalation_reason TEXT,
      linked_audit_id INTEGER,
      linked_incident_id INTEGER,
      linked_capa_id INTEGER,
      ai_detected BOOLEAN DEFAULT FALSE,
      ai_recommendations JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS risk_treatment_actions (
      id SERIAL PRIMARY KEY,
      risk_id INTEGER REFERENCES enterprise_risks(id) ON DELETE CASCADE,
      action_title VARCHAR(500) NOT NULL,
      action_description TEXT,
      action_type VARCHAR(50) NOT NULL,
      assigned_to VARCHAR(255) NOT NULL,
      due_date TIMESTAMP NOT NULL,
      status VARCHAR(20) DEFAULT 'pending',
      completion_date TIMESTAMP,
      completion_notes TEXT,
      evidence_required BOOLEAN DEFAULT FALSE,
      evidence_attached BOOLEAN DEFAULT FALSE,
      evidence_path VARCHAR(500),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS risk_assessment_history (
      id SERIAL PRIMARY KEY,
      risk_id INTEGER REFERENCES enterprise_risks(id) ON DELETE CASCADE,
      assessment_date TIMESTAMP DEFAULT NOW(),
      assessed_by VARCHAR(255) NOT NULL,
      previous_impact INTEGER,
      previous_likelihood INTEGER,
      previous_risk_score INTEGER,
      new_impact INTEGER,
      new_likelihood INTEGER,
      new_risk_score INTEGER,
      assessment_notes TEXT,
      trigger_reason VARCHAR(255)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS risk_categories (
      id SERIAL PRIMARY KEY,
      category_name VARCHAR(100) NOT NULL UNIQUE,
      category_code VARCHAR(20) NOT NULL UNIQUE,
      description TEXT,
      parent_category_id INTEGER REFERENCES risk_categories(id),
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    INSERT INTO risk_categories (category_name, category_code, description)
    VALUES 
      ('Operational', 'OPS', 'Risks related to business operations and processes'),
      ('Legal', 'LEG', 'Legal and contractual risks'),
      ('Financial', 'FIN', 'Financial and economic risks'),
      ('Data Privacy', 'PDPL', 'Personal data protection and privacy risks'),
      ('Information Security', 'ISEC', 'Cybersecurity and information protection risks'),
      ('Fraud', 'FRD', 'Fraud and misconduct risks'),
      ('Vendor/Third-Party', 'VND', 'Vendor and third-party relationship risks')
    ON CONFLICT (category_code) DO NOTHING
  `);

  console.log('✅ [RiskDB] Enterprise risk management tables initialized');
}

export async function createRisk(risk: EnterpriseRisk): Promise<EnterpriseRisk> {
  console.log('📝 [RiskDB] Creating new enterprise risk:', risk.risk_title);
  
  const result = await pool.query(`
    INSERT INTO enterprise_risks (
      risk_title, risk_description, risk_category, risk_source,
      identified_by, risk_owner, owner_department,
      impact_score, likelihood_score,
      treatment_strategy, treatment_description, treatment_owner, treatment_deadline,
      residual_impact, residual_likelihood,
      control_ids, policy_ids, review_frequency, next_review_date,
      status, linked_audit_id, linked_incident_id, linked_capa_id,
      ai_detected, ai_recommendations
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
    RETURNING *
  `, [
    risk.risk_title, risk.risk_description, risk.risk_category, risk.risk_source,
    risk.identified_by, risk.risk_owner, risk.owner_department,
    risk.impact_score, risk.likelihood_score,
    risk.treatment_strategy, risk.treatment_description, risk.treatment_owner, risk.treatment_deadline,
    risk.residual_impact, risk.residual_likelihood,
    risk.control_ids, risk.policy_ids, risk.review_frequency || 'quarterly', risk.next_review_date,
    risk.status || 'open', risk.linked_audit_id, risk.linked_incident_id, risk.linked_capa_id,
    risk.ai_detected || false, JSON.stringify(risk.ai_recommendations || {})
  ]);

  console.log('✅ [RiskDB] Risk created with ID:', result.rows[0].id);
  return result.rows[0];
}

export async function updateRisk(id: number, risk: Partial<EnterpriseRisk>, assessedBy?: string): Promise<EnterpriseRisk> {
  console.log('📝 [RiskDB] Updating risk ID:', id);
  
  const existingRisk = await getRiskById(id);
  if (!existingRisk) {
    throw new Error(`Risk with ID ${id} not found`);
  }

  if (risk.impact_score !== undefined || risk.likelihood_score !== undefined) {
    await pool.query(`
      INSERT INTO risk_assessment_history (
        risk_id, assessed_by, 
        previous_impact, previous_likelihood, previous_risk_score,
        new_impact, new_likelihood, new_risk_score,
        trigger_reason
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      id,
      assessedBy || 'System',
      existingRisk.impact_score,
      existingRisk.likelihood_score,
      existingRisk.risk_score,
      risk.impact_score || existingRisk.impact_score,
      risk.likelihood_score || existingRisk.likelihood_score,
      (risk.impact_score || existingRisk.impact_score) * (risk.likelihood_score || existingRisk.likelihood_score),
      'Manual update'
    ]);
  }

  const updateFields: string[] = [];
  const values: any[] = [];
  let paramCount = 1;

  const allowedFields = [
    'risk_title', 'risk_description', 'risk_category', 'risk_source',
    'risk_owner', 'owner_department', 'impact_score', 'likelihood_score',
    'treatment_strategy', 'treatment_description', 'treatment_owner', 'treatment_deadline',
    'residual_impact', 'residual_likelihood', 'control_ids', 'policy_ids',
    'review_frequency', 'last_review_date', 'next_review_date', 'status',
    'escalation_reason', 'ai_recommendations',
    'accepted_by', 'accepted_by_role', 'accepted_at', 'acceptance_justification', 'grc_approval_required'
  ];

  for (const [key, value] of Object.entries(risk)) {
    if (allowedFields.includes(key) && value !== undefined) {
      updateFields.push(`${key} = $${paramCount}`);
      values.push(key === 'ai_recommendations' ? JSON.stringify(value) : value);
      paramCount++;
    }
  }

  updateFields.push(`updated_at = NOW()`);

  values.push(id);
  const result = await pool.query(`
    UPDATE enterprise_risks 
    SET ${updateFields.join(', ')}
    WHERE id = $${paramCount}
    RETURNING *
  `, values);

  console.log('✅ [RiskDB] Risk updated:', id);
  return result.rows[0];
}

export async function getRiskById(id: number): Promise<EnterpriseRisk | null> {
  const result = await pool.query('SELECT * FROM enterprise_risks WHERE id = $1', [id]);
  return result.rows[0] || null;
}

export async function getAllRisks(filters?: {
  status?: string;
  category?: string;
  risk_level?: string;
  owner_department?: string;
  limit?: number;
  offset?: number;
}): Promise<{ risks: EnterpriseRisk[]; total: number }> {
  console.log('📊 [RiskDB] Fetching risks with filters:', filters);
  
  let whereConditions: string[] = [];
  let values: any[] = [];
  let paramCount = 1;

  if (filters?.status) {
    whereConditions.push(`status = $${paramCount}`);
    values.push(filters.status);
    paramCount++;
  }
  if (filters?.category) {
    whereConditions.push(`risk_category = $${paramCount}`);
    values.push(filters.category);
    paramCount++;
  }
  if (filters?.risk_level) {
    whereConditions.push(`risk_level = $${paramCount}`);
    values.push(filters.risk_level);
    paramCount++;
  }
  if (filters?.owner_department) {
    whereConditions.push(`owner_department = $${paramCount}`);
    values.push(filters.owner_department);
    paramCount++;
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  const countResult = await pool.query(`SELECT COUNT(*) FROM enterprise_risks ${whereClause}`, values);
  const total = parseInt(countResult.rows[0].count);

  const limit = filters?.limit || 50;
  const offset = filters?.offset || 0;
  values.push(limit, offset);

  const result = await pool.query(`
    SELECT * FROM enterprise_risks 
    ${whereClause}
    ORDER BY risk_score DESC, created_at DESC
    LIMIT $${paramCount} OFFSET $${paramCount + 1}
  `, values);

  console.log('✅ [RiskDB] Found', result.rows.length, 'risks');
  return { risks: result.rows, total };
}

export async function getRiskHeatmapData(): Promise<any> {
  console.log('📊 [RiskDB] Generating risk heatmap data...');
  
  const result = await pool.query(`
    SELECT 
      impact_score,
      likelihood_score,
      COUNT(*) as count,
      ARRAY_AGG(id) as risk_ids,
      ARRAY_AGG(risk_title) as risk_titles
    FROM enterprise_risks
    WHERE status NOT IN ('closed')
    GROUP BY impact_score, likelihood_score
    ORDER BY impact_score DESC, likelihood_score DESC
  `);

  const heatmapMatrix = [];
  for (let impact = 5; impact >= 1; impact--) {
    const row = [];
    for (let likelihood = 1; likelihood <= 5; likelihood++) {
      const cell = result.rows.find(r => 
        r.impact_score === impact && r.likelihood_score === likelihood
      );
      row.push({
        impact,
        likelihood,
        count: cell ? parseInt(cell.count) : 0,
        risk_ids: cell ? cell.risk_ids : [],
        risk_titles: cell ? cell.risk_titles : []
      });
    }
    heatmapMatrix.push(row);
  }

  console.log('✅ [RiskDB] Heatmap data generated');
  return heatmapMatrix;
}

export async function getRiskSummaryStats(): Promise<any> {
  console.log('📊 [RiskDB] Generating risk summary statistics...');
  
  const stats = await pool.query(`
    SELECT 
      COUNT(*) FILTER (WHERE status = 'open') as open_risks,
      COUNT(*) FILTER (WHERE status = 'in_treatment') as in_treatment,
      COUNT(*) FILTER (WHERE status = 'monitoring') as monitoring,
      COUNT(*) FILTER (WHERE status = 'closed') as closed,
      COUNT(*) FILTER (WHERE status = 'escalated') as escalated,
      COUNT(*) FILTER (WHERE risk_level = 'critical') as critical_risks,
      COUNT(*) FILTER (WHERE risk_level = 'high') as high_risks,
      COUNT(*) FILTER (WHERE risk_level = 'medium') as medium_risks,
      COUNT(*) FILTER (WHERE risk_level = 'low') as low_risks,
      COUNT(*) FILTER (WHERE ai_detected = true) as ai_detected_risks,
      COUNT(*) FILTER (WHERE next_review_date < NOW()) as overdue_reviews,
      AVG(risk_score)::numeric(10,2) as avg_risk_score,
      COUNT(*) as total_risks
    FROM enterprise_risks
  `);

  const byCategory = await pool.query(`
    SELECT 
      risk_category,
      COUNT(*) as count,
      AVG(risk_score)::numeric(10,2) as avg_score
    FROM enterprise_risks
    WHERE status NOT IN ('closed')
    GROUP BY risk_category
    ORDER BY avg_score DESC
  `);

  const byDepartment = await pool.query(`
    SELECT 
      owner_department,
      COUNT(*) as count,
      AVG(risk_score)::numeric(10,2) as avg_score
    FROM enterprise_risks
    WHERE status NOT IN ('closed') AND owner_department IS NOT NULL
    GROUP BY owner_department
    ORDER BY count DESC
  `);

  const topRisks = await pool.query(`
    SELECT id, risk_title, risk_category, risk_score, risk_level, status
    FROM enterprise_risks
    WHERE status NOT IN ('closed')
    ORDER BY risk_score DESC
    LIMIT 10
  `);

  console.log('✅ [RiskDB] Summary statistics generated');
  return {
    ...stats.rows[0],
    by_category: byCategory.rows,
    by_department: byDepartment.rows,
    top_risks: topRisks.rows
  };
}

export async function createTreatmentAction(action: RiskTreatmentAction): Promise<RiskTreatmentAction> {
  console.log('📝 [RiskDB] Creating treatment action for risk:', action.risk_id);
  
  const result = await pool.query(`
    INSERT INTO risk_treatment_actions (
      risk_id, action_title, action_description, action_type,
      assigned_to, due_date, status,
      evidence_required
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *
  `, [
    action.risk_id, action.action_title, action.action_description, action.action_type,
    action.assigned_to, action.due_date, action.status || 'pending',
    action.evidence_required || false
  ]);

  await pool.query(`
    UPDATE enterprise_risks SET status = 'in_treatment', updated_at = NOW()
    WHERE id = $1 AND status = 'open'
  `, [action.risk_id]);

  console.log('✅ [RiskDB] Treatment action created:', result.rows[0].id);
  return result.rows[0];
}

export async function getTreatmentActions(riskId: number): Promise<RiskTreatmentAction[]> {
  const result = await pool.query(`
    SELECT * FROM risk_treatment_actions
    WHERE risk_id = $1
    ORDER BY due_date ASC
  `, [riskId]);
  return result.rows;
}

export async function updateTreatmentAction(id: number, action: Partial<RiskTreatmentAction>): Promise<RiskTreatmentAction> {
  console.log('📝 [RiskDB] Updating treatment action:', id);
  
  const updateFields: string[] = [];
  const values: any[] = [];
  let paramCount = 1;

  const allowedFields = [
    'action_title', 'action_description', 'action_type', 'assigned_to',
    'due_date', 'status', 'completion_date', 'completion_notes',
    'evidence_required', 'evidence_attached', 'evidence_path'
  ];

  for (const [key, value] of Object.entries(action)) {
    if (allowedFields.includes(key) && value !== undefined) {
      updateFields.push(`${key} = $${paramCount}`);
      values.push(value);
      paramCount++;
    }
  }

  updateFields.push(`updated_at = NOW()`);
  values.push(id);

  const result = await pool.query(`
    UPDATE risk_treatment_actions 
    SET ${updateFields.join(', ')}
    WHERE id = $${paramCount}
    RETURNING *
  `, values);

  console.log('✅ [RiskDB] Treatment action updated:', id);
  return result.rows[0];
}

export async function getRiskAssessmentHistory(riskId: number): Promise<RiskAssessmentHistory[]> {
  const result = await pool.query(`
    SELECT * FROM risk_assessment_history
    WHERE risk_id = $1
    ORDER BY assessment_date DESC
  `, [riskId]);
  return result.rows;
}

export async function getRiskCategories(): Promise<RiskCategory[]> {
  const result = await pool.query(`
    SELECT * FROM risk_categories
    WHERE is_active = true
    ORDER BY category_name
  `);
  return result.rows;
}

export async function getOverdueRisks(): Promise<EnterpriseRisk[]> {
  console.log('📊 [RiskDB] Fetching overdue risks for review...');
  
  const result = await pool.query(`
    SELECT * FROM enterprise_risks
    WHERE next_review_date < NOW()
    AND status NOT IN ('closed')
    ORDER BY risk_score DESC
  `);

  console.log('✅ [RiskDB] Found', result.rows.length, 'overdue risks');
  return result.rows;
}

export async function getOverdueTreatmentActions(): Promise<any[]> {
  console.log('📊 [RiskDB] Fetching overdue treatment actions...');
  
  const result = await pool.query(`
    SELECT 
      ta.*,
      er.risk_title,
      er.risk_level,
      er.risk_category
    FROM risk_treatment_actions ta
    JOIN enterprise_risks er ON ta.risk_id = er.id
    WHERE ta.due_date < NOW()
    AND ta.status NOT IN ('completed', 'cancelled')
    ORDER BY ta.due_date ASC
  `);

  console.log('✅ [RiskDB] Found', result.rows.length, 'overdue actions');
  return result.rows;
}

export async function getRiskTrends(days: number = 90): Promise<any[]> {
  console.log('📊 [RiskDB] Generating risk trends for last', days, 'days...');
  
  const result = await pool.query(`
    SELECT 
      DATE(created_at) as date,
      COUNT(*) as new_risks,
      COUNT(*) FILTER (WHERE risk_level = 'critical') as critical,
      COUNT(*) FILTER (WHERE risk_level = 'high') as high,
      COUNT(*) FILTER (WHERE risk_level = 'medium') as medium,
      COUNT(*) FILTER (WHERE risk_level = 'low') as low
    FROM enterprise_risks
    WHERE created_at >= NOW() - INTERVAL '${days} days'
    GROUP BY DATE(created_at)
    ORDER BY date ASC
  `);

  console.log('✅ [RiskDB] Trend data generated');
  return result.rows;
}
