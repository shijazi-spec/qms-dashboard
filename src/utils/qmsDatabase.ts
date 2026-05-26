import { createRedactedPool } from './redactedPool';
import { EvaluationFramework, EvaluationCriteria, DealEvaluationResult, EvaluationFinding } from './evaluationSchema';
import { logger } from './logger';

const pool = createRedactedPool({
  connectionString: process.env.DATABASE_URL,
});

// ──────────────────────────────────────────────────────────────────────────────
// Self-initialising schema
//
// Every other DB utility in the project (aiAlertsDatabase, aiTelemetry,
// database, complianceDatabase, …) creates its own tables on first import
// using CREATE TABLE IF NOT EXISTS. QMS used to be the lone exception, which
// meant CI had to apply tests/fixtures/ci-schema.sql before running tests
// and developers with a fresh database hit "relation does not exist" errors.
//
// The schema below mirrors what tests/fixtures/ci-schema.sql provided so that
// integration suites (qmsApiRoutes.test.ts, dashboardApiRoutes.test.ts …)
// and a fresh dev DB both Just Work after a single import. Column types are
// intentionally permissive (TEXT / JSONB / TIMESTAMPTZ) — production schemas
// may add stricter constraints or extra columns via migrations, but CREATE
// TABLE IF NOT EXISTS leaves any existing definition untouched.
//
// The init runs at module load via top-level await so any caller awaiting
// `import('../utils/qmsDatabase')` gets a fully-initialised schema before
// the first pool.query() fires. If DATABASE_URL is unset (typical for
// happy-path-skipped tests on a clean checkout) we no-op so the import
// itself doesn't crash.
// ──────────────────────────────────────────────────────────────────────────────
async function initQmsSchema(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  await pool.query(`
    CREATE SEQUENCE IF NOT EXISTS capa_number_seq;
    CREATE SEQUENCE IF NOT EXISTS nc_number_seq;

    CREATE TABLE IF NOT EXISTS evaluation_frameworks (
      framework_id   TEXT PRIMARY KEY,
      name           TEXT,
      version        TEXT,
      description    TEXT,
      standards      JSONB,
      dimensions     JSONB,
      is_active      BOOLEAN DEFAULT FALSE,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      updated_at     TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS deal_evaluations (
      id                 SERIAL PRIMARY KEY,
      deal_id            TEXT,
      deal_name          TEXT,
      framework_id       TEXT,
      overall_score      NUMERIC,
      dimension_scores   JSONB,
      criteria_scores    JSONB,
      findings_count     INTEGER DEFAULT 0,
      critical_findings  INTEGER DEFAULT 0,
      recommendations    JSONB,
      deal_data          JSONB,
      source             TEXT,
      evaluation_date    TIMESTAMPTZ DEFAULT NOW(),
      created_at         TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS capa_records (
      id                     SERIAL PRIMARY KEY,
      capa_number            TEXT UNIQUE,
      title                  TEXT NOT NULL,
      description            TEXT,
      capa_type              TEXT,
      source_type            TEXT,
      source_id              TEXT,
      source_reference       TEXT,
      severity               TEXT,
      status                 TEXT DEFAULT 'open',
      priority               TEXT DEFAULT 'medium',
      assigned_to            TEXT,
      root_cause             TEXT,
      root_cause_method      TEXT,
      immediate_action       TEXT,
      corrective_action      TEXT,
      preventive_action      TEXT,
      verification_method    TEXT,
      effectiveness_criteria TEXT,
      target_date            TIMESTAMPTZ,
      completion_date        TIMESTAMPTZ,
      verification_date      TIMESTAMPTZ,
      related_criteria       JSONB,
      attachments            JSONB,
      metadata               JSONB,
      created_by             TEXT,
      created_at             TIMESTAMPTZ DEFAULT NOW(),
      updated_at             TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS capa_action_items (
      id              SERIAL PRIMARY KEY,
      capa_id         INTEGER REFERENCES capa_records(id) ON DELETE CASCADE,
      action_number   INTEGER,
      description     TEXT,
      action_type     TEXT,
      assigned_to     TEXT,
      due_date        TIMESTAMPTZ,
      completion_date TIMESTAMPTZ,
      status          TEXT DEFAULT 'pending',
      notes           TEXT,
      evidence        JSONB,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS nonconformance_records (
      id                  SERIAL PRIMARY KEY,
      nc_number           TEXT UNIQUE,
      title               TEXT,
      description         TEXT,
      nc_type             TEXT,
      category            TEXT,
      source_type         TEXT,
      source_id           TEXT,
      source_reference    TEXT,
      severity            TEXT,
      status              TEXT DEFAULT 'open',
      disposition         TEXT,
      disposition_notes   TEXT,
      related_capa_id     INTEGER,
      detected_by         TEXT,
      detected_date       TIMESTAMPTZ,
      review_notes        TEXT,
      reviewed_by         TEXT,
      review_date         TIMESTAMPTZ,
      closed_by           TEXT,
      closed_date         TIMESTAMPTZ,
      criteria_violations JSONB,
      attachments         JSONB,
      metadata            JSONB,
      created_by          TEXT,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS training_records (
      id                  SERIAL PRIMARY KEY,
      training_id         TEXT UNIQUE,
      title               TEXT,
      description         TEXT,
      training_type       TEXT,
      category            TEXT,
      duration_hours      NUMERIC,
      provider            TEXT,
      materials           JSONB,
      assessment_required BOOLEAN DEFAULT FALSE,
      passing_score       NUMERIC,
      validity_months     INTEGER,
      is_mandatory        BOOLEAN DEFAULT FALSE,
      target_roles        TEXT[],
      metadata            JSONB,
      is_active           BOOLEAN DEFAULT TRUE,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS training_assignments (
      id              SERIAL PRIMARY KEY,
      training_id     TEXT,
      employee_id     TEXT,
      employee_name   TEXT,
      employee_email  TEXT,
      employee_role   TEXT,
      due_date        TIMESTAMPTZ,
      status          TEXT DEFAULT 'assigned',
      assigned_by     TEXT,
      completed_date  TIMESTAMPTZ,
      score           NUMERIC,
      notes           TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    );

    -- Columns added by later code paths (closure approval & effectiveness review).
    -- Production DBs got these via legacy migrations; ALTER … IF NOT EXISTS keeps
    -- a fresh dev/CI database in sync without disturbing existing schemas.
    ALTER TABLE capa_records
      ADD COLUMN IF NOT EXISTS closure_approved_by      TEXT,
      ADD COLUMN IF NOT EXISTS closure_approved_at      TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS effectiveness_result     TEXT,
      ADD COLUMN IF NOT EXISTS effectiveness_evidence   TEXT,
      ADD COLUMN IF NOT EXISTS effectiveness_reviewed_by TEXT,
      ADD COLUMN IF NOT EXISTS effectiveness_reviewed_at TIMESTAMPTZ;

    ALTER TABLE nonconformance_records
      ADD COLUMN IF NOT EXISTS closure_approved_by TEXT,
      ADD COLUMN IF NOT EXISTS closure_approved_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS quality_metrics (
      id               SERIAL PRIMARY KEY,
      metric_date      DATE NOT NULL,
      metric_type      TEXT NOT NULL,
      dimension        TEXT,
      category         TEXT,
      metric_name      TEXT NOT NULL,
      metric_value     NUMERIC,
      metric_target    NUMERIC,
      metric_unit      TEXT,
      deals_evaluated  INTEGER,
      deals_passed     INTEGER,
      deals_failed     INTEGER,
      capa_opened      INTEGER,
      capa_closed      INTEGER,
      nc_opened        INTEGER,
      nc_closed        INTEGER,
      metadata         JSONB,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

// Top-level await ensures any caller `await import('../utils/qmsDatabase')`
// receives a module whose schema has already been created. We swallow errors
// (logging them) so a bad DATABASE_URL on a dev box doesn't blow up unrelated
// imports — the subsequent pool.query() call will surface the real error.
await initQmsSchema().catch((err) => {
  logger.error('[QMS] schema init failed', { err });
});

export interface CapaRecord {
  id?: number;
  capa_number: string;
  title: string;
  description?: string;
  capa_type: 'corrective' | 'preventive' | 'improvement';
  source_type?: string;
  source_id?: string;
  source_reference?: string;
  severity: 'critical' | 'major' | 'minor' | 'observation';
  status: 'open' | 'investigation' | 'action_plan' | 'implementation' | 'verification' | 'closed' | 'cancelled';
  priority: 'critical' | 'high' | 'medium' | 'low';
  assigned_to?: string;
  root_cause?: string;
  root_cause_method?: string;
  immediate_action?: string;
  corrective_action?: string;
  preventive_action?: string;
  verification_method?: string;
  effectiveness_criteria?: string;
  target_date?: Date;
  completion_date?: Date;
  verification_date?: Date;
  related_criteria?: any;
  attachments?: any;
  metadata?: any;
  created_by?: string;
  created_at?: Date;
  updated_at?: Date;
}

export interface CapaActionItem {
  id?: number;
  capa_id: number;
  action_number: number;
  description: string;
  action_type: 'immediate' | 'corrective' | 'preventive' | 'verification';
  assigned_to?: string;
  due_date?: Date;
  completion_date?: Date;
  status: 'pending' | 'in_progress' | 'completed' | 'overdue' | 'cancelled';
  notes?: string;
  evidence?: any;
  created_at?: Date;
  updated_at?: Date;
}

export interface NonconformanceRecord {
  id?: number;
  nc_number: string;
  title: string;
  description?: string;
  nc_type: string;
  category?: string;
  source_type?: string;
  source_id?: string;
  source_reference?: string;
  severity: 'critical' | 'major' | 'minor' | 'observation';
  status: 'open' | 'under_review' | 'disposition' | 'capa_required' | 'closed' | 'rejected';
  disposition?: string;
  disposition_notes?: string;
  related_capa_id?: number;
  detected_by?: string;
  detected_date?: Date;
  review_notes?: string;
  reviewed_by?: string;
  review_date?: Date;
  closed_by?: string;
  closed_date?: Date;
  criteria_violations?: any;
  attachments?: any;
  metadata?: any;
  created_at?: Date;
  updated_at?: Date;
}

export interface TrainingRecord {
  id?: number;
  training_id: string;
  title: string;
  description?: string;
  training_type: 'quality_standards' | 'iso_9001' | 'copc' | 'six_sigma' | 'process' | 'tool' | 'compliance' | 'onboarding' | 'refresher' | 'custom';
  category?: string;
  duration_hours?: number;
  provider?: string;
  materials?: any;
  assessment_required?: boolean;
  passing_score?: number;
  validity_months?: number;
  is_mandatory?: boolean;
  target_roles?: string[];
  metadata?: any;
  is_active?: boolean;
  created_at?: Date;
  updated_at?: Date;
}

export interface TrainingAssignment {
  id?: number;
  training_id: string;
  employee_id: string;
  employee_name: string;
  employee_email?: string;
  employee_role?: string;
  assigned_date?: Date;
  due_date?: Date;
  completion_date?: Date;
  status: 'assigned' | 'in_progress' | 'completed' | 'overdue' | 'expired' | 'exempted';
  assessment_score?: number;
  assessment_passed?: boolean;
  certificate_number?: string;
  expiry_date?: Date;
  notes?: string;
  assigned_by?: string;
  verified_by?: string;
  created_at?: Date;
  updated_at?: Date;
}

export interface DealEvaluationRecord {
  id?: number;
  deal_id: string;
  deal_name?: string;
  framework_id?: string;
  evaluation_date?: Date;
  overall_score?: number;
  dimension_scores?: any;
  criteria_scores?: any;
  findings_count?: number;
  critical_findings?: number;
  recommendations?: any;
  deal_data?: any;
  evaluated_by?: string;
  source?: string;
  created_at?: Date;
}

export async function saveEvaluationFramework(framework: EvaluationFramework): Promise<void> {
  await pool.query('UPDATE evaluation_frameworks SET is_active = false WHERE framework_id != $1', [framework.id]);
  
  await pool.query(
    `INSERT INTO evaluation_frameworks (framework_id, name, version, description, standards, dimensions, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (framework_id) DO UPDATE SET
       name = $2, version = $3, description = $4, standards = $5, dimensions = $6, is_active = $7, updated_at = NOW()`,
    [framework.id, framework.name, framework.version, framework.description, 
     framework.standards, JSON.stringify(framework.dimensions), framework.isActive]
  );
}

export async function getActiveFramework(): Promise<EvaluationFramework | null> {
  const result = await pool.query(
    'SELECT * FROM evaluation_frameworks WHERE is_active = true ORDER BY updated_at DESC LIMIT 1'
  );
  if (result.rows[0]) {
    const row = result.rows[0];
    return {
      id: row.framework_id,
      name: row.name,
      version: row.version,
      description: row.description,
      standards: row.standards,
      dimensions: typeof row.dimensions === 'string' ? JSON.parse(row.dimensions) : row.dimensions,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      isActive: row.is_active
    };
  }
  return null;
}

export async function saveDealEvaluation(evaluation: DealEvaluationResult): Promise<DealEvaluationRecord> {
  const result = await pool.query(
    `INSERT INTO deal_evaluations 
     (deal_id, deal_name, framework_id, overall_score, dimension_scores, criteria_scores, 
      findings_count, critical_findings, recommendations, deal_data, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      evaluation.dealId,
      evaluation.dealName,
      evaluation.frameworkId,
      evaluation.scores.overall,
      JSON.stringify(evaluation.scores.byDimension),
      JSON.stringify(evaluation.scores.byCriteria),
      evaluation.findings.length,
      evaluation.findings.filter(f => f.severity === 'critical').length,
      JSON.stringify(evaluation.recommendations),
      JSON.stringify(evaluation.dealData),
      'api'
    ]
  );
  return result.rows[0];
}

export async function getDealEvaluations(options: {
  limit?: number;
  offset?: number;
  dealId?: string;
  minScore?: number;
  maxScore?: number;
  startDate?: Date;
  endDate?: Date;
} = {}): Promise<{ evaluations: DealEvaluationRecord[]; total: number }> {
  const { limit = 50, offset = 0, dealId, minScore, maxScore, startDate, endDate } = options;
  
  let whereClause = 'WHERE 1=1';
  const params: any[] = [];
  let paramIndex = 1;
  
  if (dealId) {
    whereClause += ` AND deal_id = $${paramIndex}`;
    params.push(dealId);
    paramIndex++;
  }
  
  if (minScore !== undefined) {
    whereClause += ` AND overall_score >= $${paramIndex}`;
    params.push(minScore);
    paramIndex++;
  }
  
  if (maxScore !== undefined) {
    whereClause += ` AND overall_score <= $${paramIndex}`;
    params.push(maxScore);
    paramIndex++;
  }
  
  if (startDate) {
    whereClause += ` AND evaluation_date >= $${paramIndex}`;
    params.push(startDate);
    paramIndex++;
  }
  
  if (endDate) {
    whereClause += ` AND evaluation_date <= $${paramIndex}`;
    params.push(endDate);
    paramIndex++;
  }
  
  const countResult = await pool.query(
    `SELECT COUNT(*) FROM deal_evaluations ${whereClause}`,
    params
  );
  
  const result = await pool.query(
    `SELECT * FROM deal_evaluations ${whereClause} 
     ORDER BY evaluation_date DESC 
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, limit, offset]
  );
  
  return {
    evaluations: result.rows,
    total: parseInt(countResult.rows[0].count)
  };
}

export async function getEvaluationStatistics(): Promise<{
  totalEvaluations: number;
  averageScore: number;
  passRate: number;
  criticalFindings: number;
  evaluationsByDimension: Record<string, number>;
}> {
  const statsResult = await pool.query(`
    SELECT 
      COUNT(*) as total,
      AVG(overall_score) as avg_score,
      COUNT(*) FILTER (WHERE overall_score >= 70) as passed,
      SUM(critical_findings) as critical_total
    FROM deal_evaluations
    WHERE evaluation_date >= NOW() - INTERVAL '30 days'
  `);
  
  const stats = statsResult.rows[0];
  
  return {
    totalEvaluations: parseInt(stats.total) || 0,
    averageScore: parseFloat(stats.avg_score) || 0,
    passRate: stats.total > 0 ? (parseInt(stats.passed) / parseInt(stats.total)) * 100 : 0,
    criticalFindings: parseInt(stats.critical_total) || 0,
    evaluationsByDimension: {}
  };
}

export async function generateNextCapaNumber(): Promise<string> {
  const result = await pool.query("SELECT nextval('capa_number_seq')");
  const seq = result.rows[0].nextval;
  return `CAPA-${new Date().getFullYear()}-${String(seq).padStart(4, '0')}`;
}

export async function createCapaRecord(capa: Omit<CapaRecord, 'id' | 'capa_number' | 'created_at' | 'updated_at'>): Promise<CapaRecord> {
  const capaNumber = await generateNextCapaNumber();
  
  const result = await pool.query(
    `INSERT INTO capa_records 
     (capa_number, title, description, capa_type, source_type, source_id, source_reference,
      severity, status, priority, assigned_to, root_cause, root_cause_method,
      immediate_action, corrective_action, preventive_action, verification_method,
      effectiveness_criteria, target_date, related_criteria, attachments, metadata, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
     RETURNING *`,
    [
      capaNumber, capa.title, capa.description, capa.capa_type, capa.source_type,
      capa.source_id, capa.source_reference, capa.severity, capa.status || 'open',
      capa.priority || 'medium', capa.assigned_to, capa.root_cause, capa.root_cause_method,
      capa.immediate_action, capa.corrective_action, capa.preventive_action,
      capa.verification_method, capa.effectiveness_criteria, capa.target_date,
      JSON.stringify(capa.related_criteria || {}), JSON.stringify(capa.attachments || []),
      JSON.stringify(capa.metadata || {}), capa.created_by
    ]
  );
  
  return result.rows[0];
}

export async function updateCapaRecord(id: number, updates: Partial<CapaRecord>): Promise<CapaRecord | null> {
  const allowedFields = ['title', 'description', 'status', 'priority', 'assigned_to', 
    'root_cause', 'root_cause_method', 'immediate_action', 'corrective_action', 
    'preventive_action', 'verification_method', 'effectiveness_criteria',
    'target_date', 'completion_date', 'verification_date'];
  
  const fields: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;
  
  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key) && value !== undefined) {
      fields.push(`${key} = $${paramIndex}`);
      values.push(value);
      paramIndex++;
    }
  }
  
  if (fields.length === 0) return null;
  
  fields.push('updated_at = NOW()');
  values.push(id);
  
  const result = await pool.query(
    `UPDATE capa_records SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    values
  );
  
  return result.rows[0] || null;
}

export async function getCapaRecords(options: {
  limit?: number;
  offset?: number;
  status?: string;
  severity?: string;
  assignedTo?: string;
} = {}): Promise<{ records: CapaRecord[]; total: number }> {
  const { limit = 50, offset = 0, status, severity, assignedTo } = options;
  
  let whereClause = 'WHERE 1=1';
  const params: any[] = [];
  let paramIndex = 1;
  
  if (status) {
    whereClause += ` AND status = $${paramIndex}`;
    params.push(status);
    paramIndex++;
  }
  
  if (severity) {
    whereClause += ` AND severity = $${paramIndex}`;
    params.push(severity);
    paramIndex++;
  }
  
  if (assignedTo) {
    whereClause += ` AND assigned_to = $${paramIndex}`;
    params.push(assignedTo);
    paramIndex++;
  }
  
  const countResult = await pool.query(
    `SELECT COUNT(*) FROM capa_records ${whereClause}`,
    params
  );
  
  const result = await pool.query(
    `SELECT * FROM capa_records ${whereClause} 
     ORDER BY created_at DESC 
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, limit, offset]
  );
  
  return {
    records: result.rows,
    total: parseInt(countResult.rows[0].count)
  };
}

export async function getCapaById(id: number): Promise<CapaRecord | null> {
  const result = await pool.query('SELECT * FROM capa_records WHERE id = $1', [id]);
  return result.rows[0] || null;
}

export async function addCapaActionItem(item: Omit<CapaActionItem, 'id' | 'created_at' | 'updated_at'>): Promise<CapaActionItem> {
  const result = await pool.query(
    `INSERT INTO capa_action_items 
     (capa_id, action_number, description, action_type, assigned_to, due_date, status, notes, evidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [item.capa_id, item.action_number, item.description, item.action_type,
     item.assigned_to, item.due_date, item.status || 'pending',
     item.notes, JSON.stringify(item.evidence || {})]
  );
  return result.rows[0];
}

export async function getCapaActionItems(capaId: number): Promise<CapaActionItem[]> {
  const result = await pool.query(
    'SELECT * FROM capa_action_items WHERE capa_id = $1 ORDER BY action_number ASC',
    [capaId]
  );
  return result.rows;
}

export async function generateNextNcNumber(): Promise<string> {
  const result = await pool.query("SELECT nextval('nc_number_seq')");
  const seq = result.rows[0].nextval;
  return `NC-${new Date().getFullYear()}-${String(seq).padStart(4, '0')}`;
}

export async function createNonconformance(nc: Omit<NonconformanceRecord, 'id' | 'nc_number' | 'created_at' | 'updated_at'>): Promise<NonconformanceRecord> {
  const ncNumber = await generateNextNcNumber();
  
  const result = await pool.query(
    `INSERT INTO nonconformance_records 
     (nc_number, title, description, nc_type, category, source_type, source_id, source_reference,
      severity, status, detected_by, criteria_violations, attachments, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING *`,
    [
      ncNumber, nc.title, nc.description, nc.nc_type, nc.category,
      nc.source_type, nc.source_id, nc.source_reference, nc.severity,
      nc.status || 'open', nc.detected_by,
      JSON.stringify(nc.criteria_violations || {}),
      JSON.stringify(nc.attachments || []),
      JSON.stringify(nc.metadata || {})
    ]
  );
  
  return result.rows[0];
}

export async function getNonconformances(options: {
  limit?: number;
  offset?: number;
  status?: string;
  severity?: string;
} = {}): Promise<{ records: NonconformanceRecord[]; total: number }> {
  const { limit = 50, offset = 0, status, severity } = options;
  
  let whereClause = 'WHERE 1=1';
  const params: any[] = [];
  let paramIndex = 1;
  
  if (status) {
    whereClause += ` AND status = $${paramIndex}`;
    params.push(status);
    paramIndex++;
  }
  
  if (severity) {
    whereClause += ` AND severity = $${paramIndex}`;
    params.push(severity);
    paramIndex++;
  }
  
  const countResult = await pool.query(
    `SELECT COUNT(*) FROM nonconformance_records ${whereClause}`,
    params
  );
  
  const result = await pool.query(
    `SELECT * FROM nonconformance_records ${whereClause} 
     ORDER BY created_at DESC 
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, limit, offset]
  );
  
  return {
    records: result.rows,
    total: parseInt(countResult.rows[0].count)
  };
}

export async function createTrainingRecord(training: Omit<TrainingRecord, 'id' | 'created_at' | 'updated_at'>): Promise<TrainingRecord> {
  const result = await pool.query(
    `INSERT INTO training_records 
     (training_id, title, description, training_type, category, duration_hours, provider,
      materials, assessment_required, passing_score, validity_months, is_mandatory, target_roles, metadata, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING *`,
    [
      training.training_id, training.title, training.description, training.training_type,
      training.category, training.duration_hours, training.provider,
      JSON.stringify(training.materials || {}), training.assessment_required || false,
      training.passing_score, training.validity_months, training.is_mandatory || false,
      training.target_roles || [], JSON.stringify(training.metadata || {}), training.is_active !== false
    ]
  );
  return result.rows[0];
}

export async function getTrainingRecords(options: {
  limit?: number;
  offset?: number;
  trainingType?: string;
  isActive?: boolean;
} = {}): Promise<{ records: TrainingRecord[]; total: number }> {
  const { limit = 50, offset = 0, trainingType, isActive } = options;
  
  let whereClause = 'WHERE 1=1';
  const params: any[] = [];
  let paramIndex = 1;
  
  if (trainingType) {
    whereClause += ` AND training_type = $${paramIndex}`;
    params.push(trainingType);
    paramIndex++;
  }
  
  if (isActive !== undefined) {
    whereClause += ` AND is_active = $${paramIndex}`;
    params.push(isActive);
    paramIndex++;
  }
  
  const countResult = await pool.query(
    `SELECT COUNT(*) FROM training_records ${whereClause}`,
    params
  );
  
  const result = await pool.query(
    `SELECT * FROM training_records ${whereClause} 
     ORDER BY created_at DESC 
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, limit, offset]
  );
  
  return {
    records: result.rows,
    total: parseInt(countResult.rows[0].count)
  };
}

export async function assignTraining(assignment: Omit<TrainingAssignment, 'id' | 'created_at' | 'updated_at'>): Promise<TrainingAssignment> {
  const result = await pool.query(
    `INSERT INTO training_assignments 
     (training_id, employee_id, employee_name, employee_email, employee_role,
      due_date, status, assigned_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      assignment.training_id, assignment.employee_id, assignment.employee_name,
      assignment.employee_email, assignment.employee_role, assignment.due_date,
      assignment.status || 'assigned', assignment.assigned_by
    ]
  );
  return result.rows[0];
}

export async function getTrainingAssignments(options: {
  limit?: number;
  offset?: number;
  employeeId?: string;
  trainingId?: string;
  status?: string;
} = {}): Promise<{ assignments: TrainingAssignment[]; total: number }> {
  const { limit = 50, offset = 0, employeeId, trainingId, status } = options;
  
  let whereClause = 'WHERE 1=1';
  const params: any[] = [];
  let paramIndex = 1;
  
  if (employeeId) {
    whereClause += ` AND employee_id = $${paramIndex}`;
    params.push(employeeId);
    paramIndex++;
  }
  
  if (trainingId) {
    whereClause += ` AND training_id = $${paramIndex}`;
    params.push(trainingId);
    paramIndex++;
  }
  
  if (status) {
    whereClause += ` AND status = $${paramIndex}`;
    params.push(status);
    paramIndex++;
  }
  
  const countResult = await pool.query(
    `SELECT COUNT(*) FROM training_assignments ${whereClause}`,
    params
  );
  
  const result = await pool.query(
    `SELECT ta.*, tr.title as training_title, tr.training_type 
     FROM training_assignments ta
     LEFT JOIN training_records tr ON ta.training_id = tr.training_id
     ${whereClause} 
     ORDER BY ta.assigned_date DESC 
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, limit, offset]
  );
  
  return {
    assignments: result.rows,
    total: parseInt(countResult.rows[0].count)
  };
}

export async function updateTrainingAssignment(id: number, updates: Partial<TrainingAssignment>): Promise<TrainingAssignment | null> {
  const allowedFields = ['status', 'completion_date', 'assessment_score', 
    'assessment_passed', 'certificate_number', 'expiry_date', 'notes', 'verified_by'];
  
  const fields: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;
  
  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key) && value !== undefined) {
      fields.push(`${key} = $${paramIndex}`);
      values.push(value);
      paramIndex++;
    }
  }
  
  if (fields.length === 0) return null;
  
  fields.push('updated_at = NOW()');
  values.push(id);
  
  const result = await pool.query(
    `UPDATE training_assignments SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    values
  );
  
  return result.rows[0] || null;
}

export async function saveQualityMetrics(metrics: {
  metric_date: Date;
  metric_type: string;
  dimension?: string;
  category?: string;
  metric_name: string;
  metric_value: number;
  metric_target?: number;
  deals_evaluated?: number;
  deals_passed?: number;
  deals_failed?: number;
  capa_opened?: number;
  capa_closed?: number;
  nc_opened?: number;
  nc_closed?: number;
}): Promise<void> {
  await pool.query(
    `INSERT INTO quality_metrics 
     (metric_date, metric_type, dimension, category, metric_name, metric_value, metric_target,
      deals_evaluated, deals_passed, deals_failed, capa_opened, capa_closed, nc_opened, nc_closed)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      metrics.metric_date, metrics.metric_type, metrics.dimension, metrics.category,
      metrics.metric_name, metrics.metric_value, metrics.metric_target,
      metrics.deals_evaluated, metrics.deals_passed, metrics.deals_failed,
      metrics.capa_opened, metrics.capa_closed, metrics.nc_opened, metrics.nc_closed
    ]
  );
}

export async function getQmsDashboardData(): Promise<{
  evaluations: { total: number; avgScore: number; passRate: number };
  capa: { open: number; inProgress: number; closed: number; overdue: number };
  nonconformances: { open: number; critical: number; closed: number };
  training: { assigned: number; completed: number; overdue: number };
  recentEvaluations: DealEvaluationRecord[];
  recentCapas: CapaRecord[];
}> {
  const [evalStats, capaStats, ncStats, trainingStats, recentEvals, recentCapas] = await Promise.all([
    pool.query(`
      SELECT 
        COUNT(*) as total,
        AVG(overall_score) as avg_score,
        COUNT(*) FILTER (WHERE overall_score >= 70) as passed
      FROM deal_evaluations
      WHERE evaluation_date >= NOW() - INTERVAL '30 days'
    `),
    pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'open') as open,
        COUNT(*) FILTER (WHERE status IN ('investigation', 'action_plan', 'implementation')) as in_progress,
        COUNT(*) FILTER (WHERE status = 'closed') as closed,
        COUNT(*) FILTER (WHERE status != 'closed' AND target_date < NOW()) as overdue
      FROM capa_records
    `),
    pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status != 'closed') as open,
        COUNT(*) FILTER (WHERE severity = 'critical' AND status != 'closed') as critical,
        COUNT(*) FILTER (WHERE status = 'closed') as closed
      FROM nonconformance_records
    `),
    pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'assigned') as assigned,
        COUNT(*) FILTER (WHERE status = 'completed') as completed,
        COUNT(*) FILTER (WHERE status = 'overdue' OR (status = 'assigned' AND due_date < NOW())) as overdue
      FROM training_assignments
    `),
    pool.query('SELECT * FROM deal_evaluations ORDER BY evaluation_date DESC LIMIT 10'),
    pool.query('SELECT * FROM capa_records ORDER BY created_at DESC LIMIT 10')
  ]);

  const evalRow = evalStats.rows[0];
  const capaRow = capaStats.rows[0];
  const ncRow = ncStats.rows[0];
  const trainRow = trainingStats.rows[0];

  return {
    evaluations: {
      total: parseInt(evalRow.total) || 0,
      avgScore: parseFloat(evalRow.avg_score) || 0,
      passRate: evalRow.total > 0 ? (parseInt(evalRow.passed) / parseInt(evalRow.total)) * 100 : 0
    },
    capa: {
      open: parseInt(capaRow.open) || 0,
      inProgress: parseInt(capaRow.in_progress) || 0,
      closed: parseInt(capaRow.closed) || 0,
      overdue: parseInt(capaRow.overdue) || 0
    },
    nonconformances: {
      open: parseInt(ncRow.open) || 0,
      critical: parseInt(ncRow.critical) || 0,
      closed: parseInt(ncRow.closed) || 0
    },
    training: {
      assigned: parseInt(trainRow.assigned) || 0,
      completed: parseInt(trainRow.completed) || 0,
      overdue: parseInt(trainRow.overdue) || 0
    },
    recentEvaluations: recentEvals.rows,
    recentCapas: recentCapas.rows
  };
}

export async function approveNCClosure(ncId: number, approvedBy: string): Promise<any> {
  const result = await pool.query(
    `UPDATE nonconformance_records 
     SET status = 'closed', closed_by = $2, closed_date = NOW(),
         closure_approved_by = $2, closure_approved_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status != 'closed'
     RETURNING *`,
    [ncId, approvedBy]
  );
  return result.rows[0] || null;
}

export async function approveCAPAClosure(capaId: number, approvedBy: string): Promise<any> {
  const result = await pool.query(
    `UPDATE capa_records 
     SET status = 'closed', completion_date = NOW(),
         closure_approved_by = $2, closure_approved_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status != 'closed' AND effectiveness_result IS NOT NULL
     RETURNING *`,
    [capaId, approvedBy]
  );
  return result.rows[0] || null;
}

export async function recordCAPAEffectiveness(
  capaId: number, result: string, evidence: string, reviewedBy: string
): Promise<any> {
  const res = await pool.query(
    `UPDATE capa_records 
     SET effectiveness_result = $2, effectiveness_evidence = $3,
         effectiveness_reviewed_by = $4, effectiveness_reviewed_at = NOW(),
         status = 'verification', updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [capaId, result, evidence, reviewedBy]
  );
  return res.rows[0] || null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Bulk status updates (Task #746)
//
// Moved out of `src/mastra/routes/qmsEnhancedRoutes.ts` so all
// nonconformance/CAPA writes live next to the rest of the QMS persistence
// layer and the secret-leak coverage gate doesn't have to track that route
// file separately.
// ──────────────────────────────────────────────────────────────────────────────
export async function bulkUpdateNCStatus(
  ids: number[],
  status: string,
): Promise<{ id: number; status: string }[]> {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const placeholders = ids.map((_, i) => `$${i + 2}`).join(",");
  const result = await pool.query(
    `UPDATE nonconformance_records SET status = $1, updated_at = NOW() WHERE id IN (${placeholders}) RETURNING id, status`,
    [status, ...ids],
  );
  return result.rows;
}

export async function bulkUpdateCAPAStatus(
  ids: number[],
  status: string,
): Promise<{ id: number; status: string }[]> {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const placeholders = ids.map((_, i) => `$${i + 2}`).join(",");
  const result = await pool.query(
    `UPDATE capa_records SET status = $1, updated_at = NOW() WHERE id IN (${placeholders}) RETURNING id, status`,
    [status, ...ids],
  );
  return result.rows;
}

export { pool as qmsPool };
