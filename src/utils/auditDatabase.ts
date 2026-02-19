import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export interface Audit {
  id?: string;
  audit_code: string;
  title: string;
  description?: string;
  audit_type: 'internal' | 'external' | 'regulatory' | 'certification' | 'surveillance';
  scope?: string;
  audit_standard?: string;
  lead_auditor?: string;
  audit_team?: string[];
  auditee_department?: string;
  auditee_contact?: string;
  planned_start_date?: Date;
  planned_end_date?: Date;
  actual_start_date?: Date;
  actual_end_date?: Date;
  status: 'planned' | 'in_progress' | 'fieldwork_complete' | 'report_draft' | 'report_final' | 'closed';
  findings_count?: number;
  critical_findings?: number;
  report_path?: string;
  linked_regulation_ids?: number[];
  linked_control_ids?: number[];
  created_by?: string;
  created_at?: Date;
  updated_at?: Date;
}

export interface AuditFinding {
  id?: number;
  audit_id: number;
  finding_code: string;
  title: string;
  description: string;
  category: 'nonconformity' | 'observation' | 'opportunity_for_improvement' | 'good_practice';
  severity: 'critical' | 'major' | 'minor' | 'observation';
  control_reference?: string;
  evidence_description?: string;
  root_cause?: string;
  affected_process?: string;
  responsible_party?: string;
  due_date?: Date;
  status: 'open' | 'in_progress' | 'pending_verification' | 'verified_closed' | 'closed';
  corrective_action?: string;
  corrective_action_owner?: string;
  verification_notes?: string;
  verified_by?: string;
  verified_date?: Date;
  linked_capa_id?: number;
  linked_risk_id?: number;
  created_at?: Date;
  updated_at?: Date;
}

export interface EvidencePack {
  id?: number;
  pack_name: string;
  description?: string;
  audit_id?: number;
  regulation_id?: number;
  control_ids?: number[];
  evidence_items?: any[];
  generated_date?: Date;
  generated_by?: string;
  file_path?: string;
  status: 'draft' | 'compiled' | 'reviewed' | 'submitted';
  review_notes?: string;
  created_at?: Date;
  updated_at?: Date;
}

export interface AuditChecklist {
  id?: number;
  audit_id: number;
  category: string;
  question: string;
  expected_evidence?: string;
  response?: 'yes' | 'no' | 'partial' | 'not_applicable';
  evidence_notes?: string;
  auditor_notes?: string;
  status: 'pending' | 'in_progress' | 'completed';
  order_index?: number;
  created_at?: Date;
  updated_at?: Date;
}

export async function initAuditTables(): Promise<void> {
  console.log('📋 [AuditDB] Initializing audit readiness tables...');
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audits (
      id VARCHAR PRIMARY KEY,
      title TEXT NOT NULL,
      audit_number TEXT,
      type TEXT,
      status TEXT DEFAULT 'planned',
      auditor TEXT,
      department TEXT,
      scheduled_date TIMESTAMP,
      completed_date TIMESTAMP,
      findings INTEGER DEFAULT 0,
      description TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  const addColumnIfNotExists = async (table: string, column: string, type: string) => {
    try {
      await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}`);
    } catch {}
  };

  await addColumnIfNotExists('audits', 'audit_code', 'VARCHAR(50)');
  await addColumnIfNotExists('audits', 'audit_type', 'VARCHAR(30)');
  await addColumnIfNotExists('audits', 'scope', 'TEXT');
  await addColumnIfNotExists('audits', 'audit_standard', 'VARCHAR(255)');
  await addColumnIfNotExists('audits', 'lead_auditor', 'VARCHAR(255)');
  await addColumnIfNotExists('audits', 'audit_team', 'TEXT[]');
  await addColumnIfNotExists('audits', 'auditee_department', 'VARCHAR(100)');
  await addColumnIfNotExists('audits', 'auditee_contact', 'VARCHAR(255)');
  await addColumnIfNotExists('audits', 'planned_start_date', 'TIMESTAMP');
  await addColumnIfNotExists('audits', 'planned_end_date', 'TIMESTAMP');
  await addColumnIfNotExists('audits', 'actual_start_date', 'TIMESTAMP');
  await addColumnIfNotExists('audits', 'actual_end_date', 'TIMESTAMP');
  await addColumnIfNotExists('audits', 'findings_count', 'INTEGER DEFAULT 0');
  await addColumnIfNotExists('audits', 'critical_findings', 'INTEGER DEFAULT 0');
  await addColumnIfNotExists('audits', 'report_path', 'TEXT');
  await addColumnIfNotExists('audits', 'linked_regulation_ids', 'INTEGER[]');
  await addColumnIfNotExists('audits', 'linked_control_ids', 'INTEGER[]');
  await addColumnIfNotExists('audits', 'created_by', 'VARCHAR(255)');
  await addColumnIfNotExists('audits', 'updated_at', 'TIMESTAMP DEFAULT NOW()');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS grc_audit_findings (
      id SERIAL PRIMARY KEY,
      audit_id VARCHAR REFERENCES audits(id) ON DELETE CASCADE,
      finding_code VARCHAR(50) UNIQUE NOT NULL,
      title VARCHAR(500) NOT NULL,
      description TEXT NOT NULL,
      category VARCHAR(50) NOT NULL,
      severity VARCHAR(20) NOT NULL,
      control_reference VARCHAR(100),
      evidence_description TEXT,
      root_cause TEXT,
      affected_process VARCHAR(255),
      responsible_party VARCHAR(255),
      due_date TIMESTAMP,
      status VARCHAR(30) DEFAULT 'open',
      corrective_action TEXT,
      corrective_action_owner VARCHAR(255),
      verification_notes TEXT,
      verified_by VARCHAR(255),
      verified_date TIMESTAMP,
      linked_capa_id INTEGER,
      linked_risk_id INTEGER,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS evidence_packs (
      id SERIAL PRIMARY KEY,
      pack_name VARCHAR(255) NOT NULL,
      description TEXT,
      audit_id VARCHAR REFERENCES audits(id) ON DELETE SET NULL,
      regulation_id INTEGER,
      control_ids INTEGER[],
      evidence_items JSONB DEFAULT '[]',
      generated_date TIMESTAMP,
      generated_by VARCHAR(255),
      file_path TEXT,
      status VARCHAR(20) DEFAULT 'draft',
      review_notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_checklists (
      id SERIAL PRIMARY KEY,
      audit_id VARCHAR REFERENCES audits(id) ON DELETE CASCADE,
      category VARCHAR(100) NOT NULL,
      question TEXT NOT NULL,
      expected_evidence TEXT,
      response VARCHAR(20),
      evidence_notes TEXT,
      auditor_notes TEXT,
      status VARCHAR(20) DEFAULT 'pending',
      order_index INTEGER,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  console.log('✅ [AuditDB] Audit readiness tables initialized');
}

export async function createAudit(audit: Audit): Promise<Audit> {
  console.log('📝 [AuditDB] Creating audit:', audit.title);
  
  const id = audit.id || `AUD-${Date.now()}`;
  const result = await pool.query(`
    INSERT INTO audits (
      id, audit_code, title, description, audit_type, scope, audit_standard,
      lead_auditor, audit_team, auditee_department, auditee_contact,
      planned_start_date, planned_end_date, status,
      linked_regulation_ids, linked_control_ids, created_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
    RETURNING *
  `, [
    id, audit.audit_code, audit.title, audit.description, audit.audit_type,
    audit.scope, audit.audit_standard, audit.lead_auditor, audit.audit_team,
    audit.auditee_department, audit.auditee_contact,
    audit.planned_start_date, audit.planned_end_date, audit.status || 'planned',
    audit.linked_regulation_ids, audit.linked_control_ids, audit.created_by
  ]);

  return result.rows[0];
}

export async function updateAudit(id: string | number, updates: Partial<Audit>): Promise<Audit> {
  const setClause: string[] = [];
  const values: any[] = [];
  let paramCount = 1;

  const allowedFields = ['title', 'description', 'audit_type', 'scope', 'audit_standard', 'lead_auditor', 'audit_team', 'auditee_department', 'auditee_contact', 'planned_start_date', 'planned_end_date', 'actual_start_date', 'actual_end_date', 'status', 'report_path', 'linked_regulation_ids', 'linked_control_ids'];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key) && value !== undefined) {
      setClause.push(`${key} = $${paramCount}`);
      values.push(value);
      paramCount++;
    }
  }

  setClause.push('updated_at = NOW()');
  values.push(id);

  const result = await pool.query(`UPDATE audits SET ${setClause.join(', ')} WHERE id = $${paramCount} RETURNING *`, values);
  return result.rows[0];
}

export async function getAuditById(id: string | number): Promise<Audit | null> {
  const result = await pool.query('SELECT * FROM audits WHERE id = $1', [id]);
  return result.rows[0] || null;
}

export async function getAllAudits(filters?: { status?: string; type?: string; year?: number }): Promise<{ audits: Audit[]; total: number }> {
  let query = 'SELECT * FROM audits WHERE 1=1';
  const values: any[] = [];
  let paramCount = 1;

  if (filters?.status) {
    query += ` AND status = $${paramCount}`;
    values.push(filters.status);
    paramCount++;
  }
  if (filters?.type) {
    query += ` AND COALESCE(audit_type, type) = $${paramCount}`;
    values.push(filters.type);
    paramCount++;
  }
  if (filters?.year) {
    query += ` AND EXTRACT(YEAR FROM COALESCE(planned_start_date, scheduled_date, created_at)) = $${paramCount}`;
    values.push(filters.year);
    paramCount++;
  }

  const countResult = await pool.query(`SELECT COUNT(*) FROM audits WHERE 1=1` + query.replace('SELECT * FROM audits WHERE 1=1', ''), values);
  
  query += ' ORDER BY COALESCE(planned_start_date, scheduled_date, created_at) DESC NULLS LAST';
  const result = await pool.query(query, values);
  
  return { audits: result.rows, total: parseInt(countResult.rows[0].count) };
}

export async function createFinding(finding: AuditFinding): Promise<AuditFinding> {
  console.log('📝 [AuditDB] Creating audit finding:', finding.title);
  
  const result = await pool.query(`
    INSERT INTO grc_audit_findings (
      audit_id, finding_code, title, description, category, severity,
      control_reference, evidence_description, root_cause, affected_process,
      responsible_party, due_date, status, corrective_action, corrective_action_owner,
      linked_capa_id, linked_risk_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
    RETURNING *
  `, [
    finding.audit_id, finding.finding_code, finding.title, finding.description,
    finding.category, finding.severity, finding.control_reference, finding.evidence_description,
    finding.root_cause, finding.affected_process, finding.responsible_party, finding.due_date,
    finding.status || 'open', finding.corrective_action, finding.corrective_action_owner,
    finding.linked_capa_id, finding.linked_risk_id
  ]);

  await updateAuditFindingsCount(finding.audit_id);
  return result.rows[0];
}

export async function updateFinding(id: number, updates: Partial<AuditFinding>): Promise<AuditFinding> {
  const setClause: string[] = [];
  const values: any[] = [];
  let paramCount = 1;

  const allowedFields = ['title', 'description', 'category', 'severity', 'control_reference', 'evidence_description', 'root_cause', 'affected_process', 'responsible_party', 'due_date', 'status', 'corrective_action', 'corrective_action_owner', 'verification_notes', 'verified_by', 'verified_date', 'linked_capa_id', 'linked_risk_id'];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key) && value !== undefined) {
      setClause.push(`${key} = $${paramCount}`);
      values.push(value);
      paramCount++;
    }
  }

  setClause.push('updated_at = NOW()');
  values.push(id);

  const result = await pool.query(`UPDATE grc_audit_findings SET ${setClause.join(', ')} WHERE id = $${paramCount} RETURNING *`, values);
  
  if (result.rows[0]) {
    await updateAuditFindingsCount(result.rows[0].audit_id);
  }
  
  return result.rows[0];
}

async function updateAuditFindingsCount(auditId: string | number): Promise<void> {
  await pool.query(`
    UPDATE audits SET 
      findings_count = (SELECT COUNT(*) FROM grc_audit_findings WHERE audit_id = $1),
      critical_findings = (SELECT COUNT(*) FROM grc_audit_findings WHERE audit_id = $1 AND severity IN ('critical', 'major')),
      updated_at = NOW()
    WHERE id = $1
  `, [auditId]);
}

export async function getFindingById(id: number): Promise<AuditFinding | null> {
  const result = await pool.query('SELECT * FROM grc_audit_findings WHERE id = $1', [id]);
  return result.rows[0] || null;
}

export async function getFindingsByAudit(auditId: number): Promise<AuditFinding[]> {
  const result = await pool.query('SELECT * FROM grc_audit_findings WHERE audit_id = $1 ORDER BY severity DESC, created_at DESC', [auditId]);
  return result.rows;
}

export async function getAllFindings(filters?: { status?: string; severity?: string; audit_id?: number }): Promise<{ findings: AuditFinding[]; total: number }> {
  let query = 'SELECT f.*, a.title as audit_title, a.audit_code FROM grc_audit_findings f LEFT JOIN audits a ON f.audit_id = a.id WHERE 1=1';
  const values: any[] = [];
  let paramCount = 1;

  if (filters?.status) {
    query += ` AND f.status = $${paramCount}`;
    values.push(filters.status);
    paramCount++;
  }
  if (filters?.severity) {
    query += ` AND f.severity = $${paramCount}`;
    values.push(filters.severity);
    paramCount++;
  }
  if (filters?.audit_id) {
    query += ` AND f.audit_id = $${paramCount}`;
    values.push(filters.audit_id);
    paramCount++;
  }

  const countResult = await pool.query(`SELECT COUNT(*) FROM grc_audit_findings f WHERE 1=1` + query.replace(/SELECT f\.\*, a\.title as audit_title, a\.audit_code FROM grc_audit_findings f LEFT JOIN audits a ON f\.audit_id = a\.id WHERE 1=1/, ''), values);
  
  query += ' ORDER BY f.severity DESC, f.created_at DESC';
  const result = await pool.query(query, values);
  
  return { findings: result.rows, total: parseInt(countResult.rows[0].count) };
}

export async function createEvidencePack(pack: EvidencePack): Promise<EvidencePack> {
  console.log('📝 [AuditDB] Creating evidence pack:', pack.pack_name);
  
  const result = await pool.query(`
    INSERT INTO evidence_packs (pack_name, description, audit_id, regulation_id, control_ids, evidence_items, generated_date, generated_by, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *
  `, [
    pack.pack_name, pack.description, pack.audit_id, pack.regulation_id,
    pack.control_ids, JSON.stringify(pack.evidence_items || []),
    pack.generated_date || new Date(), pack.generated_by, pack.status || 'draft'
  ]);

  return result.rows[0];
}

export async function getEvidencePacks(filters?: { audit_id?: number; status?: string }): Promise<EvidencePack[]> {
  let query = 'SELECT * FROM evidence_packs WHERE 1=1';
  const values: any[] = [];
  let paramCount = 1;

  if (filters?.audit_id) {
    query += ` AND audit_id = $${paramCount}`;
    values.push(filters.audit_id);
    paramCount++;
  }
  if (filters?.status) {
    query += ` AND status = $${paramCount}`;
    values.push(filters.status);
    paramCount++;
  }

  query += ' ORDER BY created_at DESC';
  const result = await pool.query(query, values);
  return result.rows;
}

export async function getAuditSummary(): Promise<any> {
  console.log('📊 [AuditDB] Generating audit summary...');

  const auditsStats = await pool.query(`
    SELECT 
      COUNT(*) as total_audits,
      COUNT(*) FILTER (WHERE status = 'planned') as planned,
      COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress,
      COUNT(*) FILTER (WHERE status IN ('fieldwork_complete', 'report_draft', 'report_final', 'completed')) as completing,
      COUNT(*) FILTER (WHERE status = 'closed') as closed,
      COUNT(*) FILTER (WHERE COALESCE(planned_start_date, scheduled_date) <= NOW() AND status = 'planned') as overdue_start
    FROM audits
  `);

  let findingsStats;
  try {
    findingsStats = await pool.query(`
      SELECT 
        COUNT(*) as total_findings,
        COUNT(*) FILTER (WHERE status = 'open') as open,
        COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress,
        COUNT(*) FILTER (WHERE status IN ('pending_verification', 'verified_closed', 'closed')) as resolved,
        COUNT(*) FILTER (WHERE severity = 'critical') as critical,
        COUNT(*) FILTER (WHERE severity = 'major') as major,
        COUNT(*) FILTER (WHERE due_date < NOW() AND status NOT IN ('verified_closed', 'closed')) as overdue
      FROM grc_audit_findings
    `);
  } catch {
    findingsStats = { rows: [{ total_findings: 0, open: 0, in_progress: 0, resolved: 0, critical: 0, major: 0, overdue: 0 }] };
  }

  let bySeverity;
  try {
    bySeverity = await pool.query(`
      SELECT severity, COUNT(*) as count
      FROM grc_audit_findings
      WHERE status NOT IN ('verified_closed', 'closed')
      GROUP BY severity
      ORDER BY 
        CASE severity 
          WHEN 'critical' THEN 1 
          WHEN 'major' THEN 2 
          WHEN 'minor' THEN 3 
          ELSE 4 
        END
    `);
  } catch {
    bySeverity = { rows: [] };
  }

  const upcomingAudits = await pool.query(`
    SELECT id, audit_code, title, COALESCE(audit_type, type) as audit_type, COALESCE(planned_start_date, scheduled_date) as planned_start_date, COALESCE(lead_auditor, auditor) as lead_auditor
    FROM audits
    WHERE status IN ('planned', 'in_progress')
    AND (COALESCE(planned_start_date, scheduled_date) >= NOW() OR (planned_start_date IS NULL AND scheduled_date IS NULL))
    ORDER BY COALESCE(planned_start_date, scheduled_date) ASC NULLS LAST
    LIMIT 5
  `);

  let openFindingsByAudit;
  try {
    openFindingsByAudit = await pool.query(`
      SELECT a.audit_code, a.title, COUNT(f.id) as open_findings
      FROM audits a
      LEFT JOIN grc_audit_findings f ON a.id = f.audit_id AND f.status NOT IN ('verified_closed', 'closed')
      GROUP BY a.id, a.audit_code, a.title
      HAVING COUNT(f.id) > 0
      ORDER BY open_findings DESC
      LIMIT 5
    `);
  } catch {
    openFindingsByAudit = { rows: [] };
  }

  return {
    audits: auditsStats.rows[0],
    findings: findingsStats.rows[0],
    findings_by_severity: bySeverity.rows,
    upcoming_audits: upcomingAudits.rows,
    open_findings_by_audit: openFindingsByAudit.rows
  };
}

export async function createChecklist(items: AuditChecklist[]): Promise<AuditChecklist[]> {
  const results: AuditChecklist[] = [];
  for (const item of items) {
    const result = await pool.query(`
      INSERT INTO audit_checklists (audit_id, category, question, expected_evidence, status, order_index)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [item.audit_id, item.category, item.question, item.expected_evidence, item.status || 'pending', item.order_index]);
    results.push(result.rows[0]);
  }
  return results;
}

export async function getChecklist(auditId: number): Promise<AuditChecklist[]> {
  const result = await pool.query('SELECT * FROM audit_checklists WHERE audit_id = $1 ORDER BY category, order_index', [auditId]);
  return result.rows;
}

export async function updateChecklistItem(id: number, updates: Partial<AuditChecklist>): Promise<AuditChecklist> {
  const setClause: string[] = [];
  const values: any[] = [];
  let paramCount = 1;

  const allowedFields = ['response', 'evidence_notes', 'auditor_notes', 'status'];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key) && value !== undefined) {
      setClause.push(`${key} = $${paramCount}`);
      values.push(value);
      paramCount++;
    }
  }

  setClause.push('updated_at = NOW()');
  values.push(id);

  const result = await pool.query(`UPDATE audit_checklists SET ${setClause.join(', ')} WHERE id = $${paramCount} RETURNING *`, values);
  return result.rows[0];
}
