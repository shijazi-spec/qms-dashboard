import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function createQMSTables() {
  console.log('🗄️ Creating ExampleOrg QMS database tables...');
  
  const createTablesSQL = `
    -- Evaluation Frameworks Table (stores configurable evaluation schemas)
    CREATE TABLE IF NOT EXISTS evaluation_frameworks (
      id SERIAL PRIMARY KEY,
      framework_id VARCHAR(100) UNIQUE NOT NULL,
      name VARCHAR(255) NOT NULL,
      version VARCHAR(50) NOT NULL,
      description TEXT,
      standards TEXT[],
      dimensions JSONB NOT NULL,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    -- Evaluation Criteria Table (individual criteria with weights)
    CREATE TABLE IF NOT EXISTS evaluation_criteria (
      id SERIAL PRIMARY KEY,
      criteria_id VARCHAR(100) UNIQUE NOT NULL,
      framework_id VARCHAR(100) REFERENCES evaluation_frameworks(framework_id),
      name VARCHAR(255) NOT NULL,
      description TEXT,
      category VARCHAR(50) NOT NULL,
      dimension VARCHAR(50) NOT NULL,
      weight DECIMAL(5,2) NOT NULL,
      target_score DECIMAL(5,2) NOT NULL,
      evaluation_type VARCHAR(50) NOT NULL,
      thresholds JSONB NOT NULL,
      field_mappings TEXT[],
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    -- Deal Evaluations Table (stores individual deal evaluation results)
    CREATE TABLE IF NOT EXISTS deal_evaluations (
      id SERIAL PRIMARY KEY,
      deal_id VARCHAR(100) NOT NULL,
      deal_name VARCHAR(500),
      framework_id VARCHAR(100) REFERENCES evaluation_frameworks(framework_id),
      evaluation_date TIMESTAMP DEFAULT NOW(),
      overall_score DECIMAL(5,2),
      dimension_scores JSONB,
      criteria_scores JSONB,
      findings_count INTEGER DEFAULT 0,
      critical_findings INTEGER DEFAULT 0,
      recommendations JSONB,
      deal_data JSONB,
      evaluated_by VARCHAR(255),
      source VARCHAR(50) DEFAULT 'api',
      created_at TIMESTAMP DEFAULT NOW()
    );

    -- CAPA (Corrective and Preventive Action) Table
    CREATE TABLE IF NOT EXISTS capa_records (
      id SERIAL PRIMARY KEY,
      capa_number VARCHAR(50) UNIQUE NOT NULL,
      title VARCHAR(500) NOT NULL,
      description TEXT,
      capa_type VARCHAR(50) NOT NULL CHECK (capa_type IN ('corrective', 'preventive', 'improvement')),
      source_type VARCHAR(100),
      source_id VARCHAR(100),
      source_reference VARCHAR(255),
      severity VARCHAR(50) NOT NULL CHECK (severity IN ('critical', 'major', 'minor', 'observation')),
      status VARCHAR(50) DEFAULT 'open' CHECK (status IN ('open', 'investigation', 'action_plan', 'implementation', 'verification', 'closed', 'cancelled')),
      priority VARCHAR(50) DEFAULT 'medium' CHECK (priority IN ('critical', 'high', 'medium', 'low')),
      assigned_to VARCHAR(255),
      root_cause TEXT,
      root_cause_method VARCHAR(100),
      immediate_action TEXT,
      corrective_action TEXT,
      preventive_action TEXT,
      verification_method TEXT,
      effectiveness_criteria TEXT,
      target_date DATE,
      completion_date DATE,
      verification_date DATE,
      related_criteria JSONB,
      attachments JSONB,
      metadata JSONB,
      created_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    -- CAPA Action Items Table
    CREATE TABLE IF NOT EXISTS capa_action_items (
      id SERIAL PRIMARY KEY,
      capa_id INTEGER REFERENCES capa_records(id) ON DELETE CASCADE,
      action_number INTEGER NOT NULL,
      description TEXT NOT NULL,
      action_type VARCHAR(50) NOT NULL CHECK (action_type IN ('immediate', 'corrective', 'preventive', 'verification')),
      assigned_to VARCHAR(255),
      due_date DATE,
      completion_date DATE,
      status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'overdue', 'cancelled')),
      notes TEXT,
      evidence JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    -- Nonconformance Records Table
    CREATE TABLE IF NOT EXISTS nonconformance_records (
      id SERIAL PRIMARY KEY,
      nc_number VARCHAR(50) UNIQUE NOT NULL,
      title VARCHAR(500) NOT NULL,
      description TEXT,
      nc_type VARCHAR(100) NOT NULL,
      category VARCHAR(100),
      source_type VARCHAR(100),
      source_id VARCHAR(100),
      source_reference VARCHAR(255),
      severity VARCHAR(50) NOT NULL CHECK (severity IN ('critical', 'major', 'minor', 'observation')),
      status VARCHAR(50) DEFAULT 'open' CHECK (status IN ('open', 'under_review', 'disposition', 'capa_required', 'closed', 'rejected')),
      disposition VARCHAR(100),
      disposition_notes TEXT,
      related_capa_id INTEGER REFERENCES capa_records(id),
      detected_by VARCHAR(255),
      detected_date TIMESTAMP DEFAULT NOW(),
      review_notes TEXT,
      reviewed_by VARCHAR(255),
      review_date TIMESTAMP,
      closed_by VARCHAR(255),
      closed_date TIMESTAMP,
      criteria_violations JSONB,
      attachments JSONB,
      metadata JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    -- Training Records Table
    CREATE TABLE IF NOT EXISTS training_records (
      id SERIAL PRIMARY KEY,
      training_id VARCHAR(100) UNIQUE NOT NULL,
      title VARCHAR(500) NOT NULL,
      description TEXT,
      training_type VARCHAR(100) NOT NULL CHECK (training_type IN ('quality_standards', 'iso_9001', 'copc', 'six_sigma', 'process', 'tool', 'compliance', 'onboarding', 'refresher', 'custom')),
      category VARCHAR(100),
      duration_hours DECIMAL(5,2),
      provider VARCHAR(255),
      materials JSONB,
      assessment_required BOOLEAN DEFAULT false,
      passing_score DECIMAL(5,2),
      validity_months INTEGER,
      is_mandatory BOOLEAN DEFAULT false,
      target_roles TEXT[],
      metadata JSONB,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    -- Employee Training Assignments Table
    CREATE TABLE IF NOT EXISTS training_assignments (
      id SERIAL PRIMARY KEY,
      training_id VARCHAR(100) REFERENCES training_records(training_id),
      employee_id VARCHAR(100) NOT NULL,
      employee_name VARCHAR(255) NOT NULL,
      employee_email VARCHAR(255),
      employee_role VARCHAR(100),
      assigned_date TIMESTAMP DEFAULT NOW(),
      due_date DATE,
      completion_date TIMESTAMP,
      status VARCHAR(50) DEFAULT 'assigned' CHECK (status IN ('assigned', 'in_progress', 'completed', 'overdue', 'expired', 'exempted')),
      assessment_score DECIMAL(5,2),
      assessment_passed BOOLEAN,
      certificate_number VARCHAR(100),
      expiry_date DATE,
      notes TEXT,
      assigned_by VARCHAR(255),
      verified_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    -- Audit Findings Table (links to evaluations)
    CREATE TABLE IF NOT EXISTS audit_findings (
      id SERIAL PRIMARY KEY,
      finding_number VARCHAR(50) UNIQUE NOT NULL,
      evaluation_id INTEGER REFERENCES deal_evaluations(id),
      criteria_id VARCHAR(100),
      criteria_name VARCHAR(255),
      dimension VARCHAR(50),
      severity VARCHAR(50) NOT NULL CHECK (severity IN ('critical', 'major', 'minor', 'observation')),
      description TEXT NOT NULL,
      evidence TEXT,
      recommendation TEXT,
      capa_required BOOLEAN DEFAULT false,
      related_capa_id INTEGER REFERENCES capa_records(id),
      related_nc_id INTEGER REFERENCES nonconformance_records(id),
      status VARCHAR(50) DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'in_progress', 'resolved', 'verified', 'closed')),
      owner VARCHAR(255),
      target_date DATE,
      resolution_date DATE,
      resolution_notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    -- Quality Metrics Summary Table (for trending and dashboards)
    CREATE TABLE IF NOT EXISTS quality_metrics (
      id SERIAL PRIMARY KEY,
      metric_date DATE NOT NULL,
      metric_type VARCHAR(100) NOT NULL,
      dimension VARCHAR(50),
      category VARCHAR(100),
      metric_name VARCHAR(255) NOT NULL,
      metric_value DECIMAL(10,4),
      metric_target DECIMAL(10,4),
      metric_unit VARCHAR(50),
      deals_evaluated INTEGER,
      deals_passed INTEGER,
      deals_failed INTEGER,
      capa_opened INTEGER,
      capa_closed INTEGER,
      nc_opened INTEGER,
      nc_closed INTEGER,
      metadata JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );

    -- Document Management Table (for governance docs, SOPs)
    CREATE TABLE IF NOT EXISTS qms_documents (
      id SERIAL PRIMARY KEY,
      document_id VARCHAR(100) UNIQUE NOT NULL,
      title VARCHAR(500) NOT NULL,
      document_type VARCHAR(100) NOT NULL CHECK (document_type IN ('governance', 'sop', 'work_instruction', 'template', 'form', 'policy', 'procedure', 'reference')),
      category VARCHAR(100),
      version VARCHAR(50) NOT NULL,
      status VARCHAR(50) DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'approved', 'active', 'superseded', 'obsolete')),
      content TEXT,
      file_path VARCHAR(500),
      file_type VARCHAR(50),
      file_size INTEGER,
      author VARCHAR(255),
      reviewer VARCHAR(255),
      approver VARCHAR(255),
      effective_date DATE,
      review_date DATE,
      expiry_date DATE,
      revision_history JSONB,
      related_criteria TEXT[],
      tags TEXT[],
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    -- Create indexes for better performance
    CREATE INDEX IF NOT EXISTS idx_deal_evaluations_deal_id ON deal_evaluations(deal_id);
    CREATE INDEX IF NOT EXISTS idx_deal_evaluations_date ON deal_evaluations(evaluation_date DESC);
    CREATE INDEX IF NOT EXISTS idx_deal_evaluations_score ON deal_evaluations(overall_score);
    CREATE INDEX IF NOT EXISTS idx_capa_status ON capa_records(status);
    CREATE INDEX IF NOT EXISTS idx_capa_severity ON capa_records(severity);
    CREATE INDEX IF NOT EXISTS idx_capa_assigned ON capa_records(assigned_to);
    CREATE INDEX IF NOT EXISTS idx_nc_status ON nonconformance_records(status);
    CREATE INDEX IF NOT EXISTS idx_nc_severity ON nonconformance_records(severity);
    CREATE INDEX IF NOT EXISTS idx_training_assignments_employee ON training_assignments(employee_id);
    CREATE INDEX IF NOT EXISTS idx_training_assignments_status ON training_assignments(status);
    CREATE INDEX IF NOT EXISTS idx_audit_findings_status ON audit_findings(status);
    CREATE INDEX IF NOT EXISTS idx_quality_metrics_date ON quality_metrics(metric_date DESC);
    CREATE INDEX IF NOT EXISTS idx_qms_documents_type ON qms_documents(document_type);
    CREATE INDEX IF NOT EXISTS idx_qms_documents_status ON qms_documents(status);

    -- Create sequence for CAPA numbers
    CREATE SEQUENCE IF NOT EXISTS capa_number_seq START 1;

    -- Create sequence for NC numbers
    CREATE SEQUENCE IF NOT EXISTS nc_number_seq START 1;

    -- Create sequence for finding numbers
    CREATE SEQUENCE IF NOT EXISTS finding_number_seq START 1;
  `;

  const alterColumnsSQL = `
    ALTER TABLE nonconformance_records ADD COLUMN IF NOT EXISTS closure_approved_by VARCHAR(255);
    ALTER TABLE nonconformance_records ADD COLUMN IF NOT EXISTS closure_approved_at TIMESTAMP;
    ALTER TABLE nonconformance_records ADD COLUMN IF NOT EXISTS investigation_notes TEXT;
    ALTER TABLE nonconformance_records ADD COLUMN IF NOT EXISTS root_cause TEXT;
    ALTER TABLE capa_records ADD COLUMN IF NOT EXISTS closure_approved_by VARCHAR(255);
    ALTER TABLE capa_records ADD COLUMN IF NOT EXISTS closure_approved_at TIMESTAMP;
    ALTER TABLE capa_records ADD COLUMN IF NOT EXISTS effectiveness_result VARCHAR(30);
    ALTER TABLE capa_records ADD COLUMN IF NOT EXISTS effectiveness_evidence TEXT;
    ALTER TABLE capa_records ADD COLUMN IF NOT EXISTS effectiveness_reviewed_by VARCHAR(255);
    ALTER TABLE capa_records ADD COLUMN IF NOT EXISTS effectiveness_reviewed_at TIMESTAMP;
  `;

  try {
    await pool.query(createTablesSQL);
    await pool.query(alterColumnsSQL);
    console.log('✅ All QMS tables created successfully!');
    
    console.log('\n📋 Tables created:');
    console.log('  - evaluation_frameworks: Configurable evaluation schemas');
    console.log('  - evaluation_criteria: Individual criteria with weights');
    console.log('  - deal_evaluations: Individual deal evaluation results');
    console.log('  - capa_records: Corrective and Preventive Actions');
    console.log('  - capa_action_items: CAPA action items tracking');
    console.log('  - nonconformance_records: Nonconformance tracking');
    console.log('  - training_records: Training courses/programs');
    console.log('  - training_assignments: Employee training tracking');
    console.log('  - audit_findings: Links evaluations to findings');
    console.log('  - quality_metrics: Summary metrics for dashboards');
    console.log('  - qms_documents: Document management for SOPs/governance');
    
  } catch (error) {
    console.error('❌ Error creating tables:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

createQMSTables().catch(console.error);
