import { createRedactedPool } from './redactedPool';

const pool = createRedactedPool({
  connectionString: process.env.DATABASE_URL,
});

export interface TeamMember {
  id?: number;
  member_id: string;
  full_name: string;
  email: string;
  role: string;
  department: string;
  job_title?: string;
  hire_date?: Date;
  manager_id?: string;
  phone?: string;
  skills?: string[];
  certifications?: string[];
  status: 'active' | 'inactive' | 'on_leave' | 'probation';
  performance_score?: number;
  training_compliance_rate?: number;
  projects_completed?: number;
  avatar_url?: string;
  metadata?: any;
  created_at?: Date;
  updated_at?: Date;
}

export interface TeamPerformanceMetric {
  id?: number;
  member_id: string;
  metric_date: Date;
  quality_score: number;
  productivity_score: number;
  compliance_score: number;
  customer_satisfaction?: number;
  audit_findings_count?: number;
  training_hours?: number;
  projects_active?: number;
  tasks_completed?: number;
  tasks_overdue?: number;
  overall_score?: number;
  period_type: 'daily' | 'weekly' | 'monthly' | 'quarterly';
  notes?: string;
  evaluated_by?: string;
  created_at?: Date;
}

export interface TeamProjectAssignment {
  id?: number;
  assignment_id: string;
  project_name: string;
  project_type: 'governance' | 'audit' | 'capa' | 'rca' | 'six_sigma' | 'redesign' | 'training' | 'quality_improvement' | 'process' | 'compliance' | 'other';
  department?: string;
  member_id: string;
  member_name: string;
  role_in_project: 'owner' | 'contributor' | 'reviewer' | 'approver';
  description?: string;
  scope?: string;
  expected_outputs?: string;
  assigned_date: Date;
  start_date?: Date;
  due_date?: Date;
  completion_date?: Date;
  status: 'backlog' | 'assigned' | 'in_progress' | 'waiting_stakeholder' | 'review' | 'completed' | 'on_hold' | 'cancelled';
  priority: 'critical' | 'high' | 'medium' | 'low';
  stakeholders?: string[];
  risks?: string;
  dependencies?: string;
  effort_hours?: number;
  actual_hours?: number;
  deliverables?: string;
  notes?: string;
  assigned_by?: string;
  calendar_event_id?: string;
  ai_generated_scope?: any;
  created_at?: Date;
  updated_at?: Date;
}

export interface TrainingCourse {
  id?: number;
  course_id: string;
  name: string;
  course_type: 'mandatory' | 'optional' | 'certification' | 'refresher' | 'onboarding';
  description?: string;
  duration_hours: number;
  passing_score?: number;
  attachments?: string[];
  ai_summary?: string;
  department?: string;
  is_active: boolean;
  created_by?: string;
  created_at?: Date;
  updated_at?: Date;
}

export interface TrainingAssignment {
  id?: number;
  assignment_id: string;
  course_id: string;
  member_id: string;
  assigned_date: Date;
  due_date?: Date;
  completion_date?: Date;
  status: 'assigned' | 'in_progress' | 'completed' | 'overdue' | 'waived';
  score?: number;
  attempts?: number;
  priority: 'high' | 'medium' | 'low';
  requires_assessment: boolean;
  notes?: string;
  assigned_by?: string;
  created_at?: Date;
}

export interface AuditLogEntry {
  id?: number;
  action_id: string;
  action_type: 'create' | 'update' | 'delete' | 'assign' | 'status_change' | 'file_upload' | 'approval';
  module: 'project' | 'training' | 'team' | 'capa' | 'nonconformance' | 'audit' | 'system';
  entity_type: string;
  entity_id: string;
  user_id?: string;
  user_name?: string;
  old_value?: any;
  new_value?: any;
  description?: string;
  ip_address?: string;
  ai_involved: boolean;
  metadata?: any;
  created_at?: Date;
}

// PMP Project Interfaces
export interface PMPProject {
  id?: number;
  project_id: string;
  project_name: string;
  project_code: string;
  project_type: 'governance' | 'audit' | 'capa' | 'rca' | 'six_sigma' | 'redesign' | 'training' | 'quality_improvement' | 'process' | 'compliance' | 'other';
  department: string;
  project_manager_id: string;
  project_manager_name: string;
  sponsor_name?: string;
  sponsor_email?: string;
  status: 'initiation' | 'planning' | 'execution' | 'monitoring' | 'closing' | 'completed' | 'on_hold' | 'cancelled';
  priority: 'critical' | 'high' | 'medium' | 'low';
  
  // Scope Management
  project_charter?: string;
  scope_statement?: string;
  wbs_structure?: any; // JSONB WBS hierarchy
  deliverables?: string[];
  exclusions?: string[];
  assumptions?: string[];
  constraints?: string[];
  
  // Schedule Management
  planned_start_date?: Date;
  planned_end_date?: Date;
  actual_start_date?: Date;
  actual_end_date?: Date;
  baseline_start_date?: Date;
  baseline_end_date?: Date;
  
  // Cost Management
  budget_approved?: number;
  budget_spent?: number;
  budget_remaining?: number;
  cost_variance?: number;
  cost_performance_index?: number; // CPI
  
  // Schedule Performance
  schedule_variance?: number;
  schedule_performance_index?: number; // SPI
  percent_complete?: number;
  
  // Quality Management
  quality_criteria?: string;
  acceptance_criteria?: string;
  quality_score?: number;
  
  // Communications
  communication_plan?: any; // JSONB
  status_report_frequency?: 'daily' | 'weekly' | 'bi_weekly' | 'monthly';
  last_status_report_date?: Date;
  
  // AI Generated
  ai_generated_charter?: any;
  ai_recommendations?: any;
  
  // Metadata
  created_by?: string;
  created_at?: Date;
  updated_at?: Date;
}

export interface ProjectRisk {
  id?: number;
  risk_id: string;
  project_id: string;
  title: string;
  description: string;
  category: 'technical' | 'schedule' | 'cost' | 'resource' | 'quality' | 'external' | 'compliance' | 'stakeholder' | 'other';
  probability: 'very_low' | 'low' | 'medium' | 'high' | 'very_high';
  impact: 'very_low' | 'low' | 'medium' | 'high' | 'very_high';
  risk_score?: number; // Probability x Impact
  status: 'identified' | 'analyzed' | 'planned' | 'active' | 'occurred' | 'mitigated' | 'closed';
  response_strategy: 'avoid' | 'mitigate' | 'transfer' | 'accept' | 'exploit' | 'enhance' | 'share';
  response_plan?: string;
  contingency_plan?: string;
  risk_owner_id?: string;
  risk_owner_name?: string;
  trigger_conditions?: string;
  due_date?: Date;
  residual_risk?: string;
  secondary_risks?: string[];
  cost_impact?: number;
  schedule_impact_days?: number;
  notes?: string;
  created_at?: Date;
  updated_at?: Date;
}

export interface ProjectMilestone {
  id?: number;
  milestone_id: string;
  project_id: string;
  name: string;
  description?: string;
  milestone_type: 'phase_gate' | 'deliverable' | 'review' | 'approval' | 'kickoff' | 'closure' | 'checkpoint' | 'other';
  planned_date: Date;
  actual_date?: Date;
  baseline_date?: Date;
  status: 'pending' | 'in_progress' | 'completed' | 'delayed' | 'at_risk' | 'cancelled';
  variance_days?: number;
  predecessor_id?: string;
  successor_id?: string;
  dependencies?: string[];
  deliverables?: string[];
  owner_id?: string;
  owner_name?: string;
  approval_required: boolean;
  approved_by?: string;
  approved_date?: Date;
  percent_complete: number;
  weight: number; // For overall project % calculation
  notes?: string;
  created_at?: Date;
  updated_at?: Date;
}

export interface ProjectStakeholder {
  id?: number;
  stakeholder_id: string;
  project_id: string;
  name: string;
  email?: string;
  phone?: string;
  organization?: string;
  role: string;
  stakeholder_type: 'internal' | 'external' | 'sponsor' | 'customer' | 'vendor' | 'regulator' | 'team_member';
  influence: 'high' | 'medium' | 'low';
  interest: 'high' | 'medium' | 'low';
  engagement_level: 'unaware' | 'resistant' | 'neutral' | 'supportive' | 'leading';
  desired_engagement: 'unaware' | 'resistant' | 'neutral' | 'supportive' | 'leading';
  communication_frequency: 'daily' | 'weekly' | 'bi_weekly' | 'monthly' | 'quarterly' | 'as_needed';
  communication_method: 'email' | 'meeting' | 'report' | 'phone' | 'dashboard';
  expectations?: string;
  requirements?: string;
  power_interest_quadrant?: 'manage_closely' | 'keep_satisfied' | 'keep_informed' | 'monitor';
  is_decision_maker: boolean;
  last_contacted?: Date;
  notes?: string;
  created_at?: Date;
  updated_at?: Date;
}

// Procurement Management Interface
export interface ProjectProcurement {
  id?: number;
  procurement_id: string;
  project_id: string;
  title: string;
  description?: string;
  procurement_type: 'contract' | 'purchase_order' | 'rfp' | 'rfq' | 'vendor_agreement' | 'lease' | 'service_agreement' | 'other';
  vendor_name?: string;
  vendor_contact_name?: string;
  vendor_email?: string;
  vendor_phone?: string;
  contract_number?: string;
  contract_value?: number;
  currency?: string;
  payment_terms?: string;
  start_date?: Date;
  end_date?: Date;
  delivery_date?: Date;
  status: 'draft' | 'pending_approval' | 'approved' | 'active' | 'completed' | 'cancelled' | 'expired';
  approval_required: boolean;
  approved_by?: string;
  approved_date?: Date;
  deliverables?: string[];
  terms_conditions?: string;
  risk_assessment?: string;
  performance_criteria?: string;
  sla_requirements?: string;
  warranty_period_days?: number;
  renewal_option: boolean;
  renewal_date?: Date;
  owner_id?: string;
  owner_name?: string;
  attachments?: string[];
  notes?: string;
  created_at?: Date;
  updated_at?: Date;
}

// Integration Management - Change Request Interface
export interface ProjectChangeRequest {
  id?: number;
  change_request_id: string;
  project_id: string;
  title: string;
  description: string;
  change_type: 'scope' | 'schedule' | 'cost' | 'quality' | 'resource' | 'requirement' | 'technical' | 'process' | 'other';
  change_category: 'corrective' | 'preventive' | 'defect_repair' | 'enhancement' | 'other';
  priority: 'critical' | 'high' | 'medium' | 'low';
  status: 'draft' | 'submitted' | 'under_review' | 'approved' | 'rejected' | 'deferred' | 'implemented' | 'closed';
  requested_by?: string;
  requested_date?: Date;
  justification?: string;
  impact_analysis?: string;
  scope_impact?: string;
  schedule_impact_days?: number;
  cost_impact?: number;
  quality_impact?: string;
  risk_impact?: string;
  alternatives_considered?: string[];
  recommended_action?: string;
  ccb_decision?: string; // Change Control Board decision
  ccb_decision_date?: Date;
  ccb_decision_by?: string;
  implementation_plan?: string;
  implementation_date?: Date;
  verified_by?: string;
  verified_date?: Date;
  baseline_update_required: boolean;
  affected_deliverables?: string[];
  affected_milestones?: string[];
  attachments?: string[];
  notes?: string;
  created_at?: Date;
  updated_at?: Date;
}

export async function initTeamTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS team_members (
      id SERIAL PRIMARY KEY,
      member_id VARCHAR(50) UNIQUE NOT NULL,
      full_name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      role VARCHAR(100) NOT NULL,
      department VARCHAR(100) NOT NULL,
      job_title VARCHAR(255),
      hire_date DATE,
      manager_id VARCHAR(50),
      phone VARCHAR(50),
      skills TEXT[] DEFAULT '{}',
      certifications TEXT[] DEFAULT '{}',
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      performance_score DECIMAL(5,2),
      training_compliance_rate DECIMAL(5,2),
      projects_completed INTEGER DEFAULT 0,
      avatar_url TEXT,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_team_members_department ON team_members(department);
    CREATE INDEX IF NOT EXISTS idx_team_members_status ON team_members(status);
    CREATE INDEX IF NOT EXISTS idx_team_members_role ON team_members(role);
    CREATE INDEX IF NOT EXISTS idx_team_members_manager ON team_members(manager_id);

    CREATE TABLE IF NOT EXISTS team_performance_metrics (
      id SERIAL PRIMARY KEY,
      member_id VARCHAR(50) NOT NULL REFERENCES team_members(member_id) ON DELETE CASCADE,
      metric_date DATE NOT NULL,
      quality_score DECIMAL(5,2) NOT NULL DEFAULT 0,
      productivity_score DECIMAL(5,2) NOT NULL DEFAULT 0,
      compliance_score DECIMAL(5,2) NOT NULL DEFAULT 0,
      customer_satisfaction DECIMAL(5,2),
      audit_findings_count INTEGER DEFAULT 0,
      training_hours DECIMAL(6,2) DEFAULT 0,
      projects_active INTEGER DEFAULT 0,
      tasks_completed INTEGER DEFAULT 0,
      tasks_overdue INTEGER DEFAULT 0,
      overall_score DECIMAL(5,2),
      period_type VARCHAR(20) NOT NULL DEFAULT 'monthly',
      notes TEXT,
      evaluated_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_team_metrics_member ON team_performance_metrics(member_id);
    CREATE INDEX IF NOT EXISTS idx_team_metrics_date ON team_performance_metrics(metric_date);
    CREATE INDEX IF NOT EXISTS idx_team_metrics_period ON team_performance_metrics(period_type);

    CREATE TABLE IF NOT EXISTS team_project_assignments (
      id SERIAL PRIMARY KEY,
      assignment_id VARCHAR(50) UNIQUE NOT NULL,
      project_name VARCHAR(255) NOT NULL,
      project_type VARCHAR(50) NOT NULL DEFAULT 'other',
      department VARCHAR(100),
      member_id VARCHAR(50) NOT NULL,
      member_name VARCHAR(255) NOT NULL,
      role_in_project VARCHAR(50) NOT NULL DEFAULT 'contributor',
      description TEXT,
      scope TEXT,
      expected_outputs TEXT,
      assigned_date DATE NOT NULL DEFAULT CURRENT_DATE,
      start_date DATE,
      due_date DATE,
      completion_date DATE,
      status VARCHAR(30) NOT NULL DEFAULT 'backlog',
      priority VARCHAR(20) NOT NULL DEFAULT 'medium',
      stakeholders TEXT[] DEFAULT '{}',
      risks TEXT,
      dependencies TEXT,
      effort_hours DECIMAL(6,2),
      actual_hours DECIMAL(6,2),
      deliverables TEXT,
      notes TEXT,
      assigned_by VARCHAR(255),
      calendar_event_id VARCHAR(255),
      ai_generated_scope JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_team_assignments_member ON team_project_assignments(member_id);
    CREATE INDEX IF NOT EXISTS idx_team_assignments_status ON team_project_assignments(status);
    CREATE INDEX IF NOT EXISTS idx_team_assignments_priority ON team_project_assignments(priority);
    CREATE INDEX IF NOT EXISTS idx_team_assignments_type ON team_project_assignments(project_type);

    CREATE TABLE IF NOT EXISTS training_courses (
      id SERIAL PRIMARY KEY,
      course_id VARCHAR(50) UNIQUE NOT NULL,
      name VARCHAR(255) NOT NULL,
      course_type VARCHAR(50) NOT NULL DEFAULT 'optional',
      description TEXT,
      duration_hours DECIMAL(6,2) NOT NULL DEFAULT 1,
      passing_score INTEGER DEFAULT 70,
      attachments TEXT[] DEFAULT '{}',
      ai_summary TEXT,
      department VARCHAR(100),
      is_active BOOLEAN DEFAULT true,
      created_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_training_courses_type ON training_courses(course_type);
    CREATE INDEX IF NOT EXISTS idx_training_courses_dept ON training_courses(department);
    CREATE INDEX IF NOT EXISTS idx_training_courses_active ON training_courses(is_active);

    CREATE TABLE IF NOT EXISTS course_assignments (
      id SERIAL PRIMARY KEY,
      assignment_id VARCHAR(50) UNIQUE NOT NULL,
      course_id VARCHAR(50) NOT NULL,
      member_id VARCHAR(50) NOT NULL,
      assigned_date DATE NOT NULL DEFAULT CURRENT_DATE,
      due_date DATE,
      completion_date DATE,
      status VARCHAR(20) NOT NULL DEFAULT 'assigned',
      score INTEGER,
      attempts INTEGER DEFAULT 0,
      priority VARCHAR(20) NOT NULL DEFAULT 'medium',
      requires_assessment BOOLEAN DEFAULT false,
      notes TEXT,
      assigned_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_course_assign_course ON course_assignments(course_id);
    CREATE INDEX IF NOT EXISTS idx_course_assign_member ON course_assignments(member_id);
    CREATE INDEX IF NOT EXISTS idx_course_assign_status ON course_assignments(status);

    CREATE TABLE IF NOT EXISTS audit_trail (
      id SERIAL PRIMARY KEY,
      action_id VARCHAR(50) UNIQUE NOT NULL,
      action_type VARCHAR(30) NOT NULL,
      module VARCHAR(50) NOT NULL,
      entity_type VARCHAR(100) NOT NULL,
      entity_id VARCHAR(100) NOT NULL,
      user_id VARCHAR(100),
      user_name VARCHAR(255),
      old_value JSONB,
      new_value JSONB,
      description TEXT,
      ip_address VARCHAR(45),
      ai_involved BOOLEAN DEFAULT false,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_audit_trail_module ON audit_trail(module);
    CREATE INDEX IF NOT EXISTS idx_audit_trail_entity ON audit_trail(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_audit_trail_user ON audit_trail(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_trail_date ON audit_trail(created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_trail_action ON audit_trail(action_type);
  `);

  await pool.query(`
    ALTER TABLE team_project_assignments ADD COLUMN IF NOT EXISTS department VARCHAR(100);
    ALTER TABLE team_project_assignments ADD COLUMN IF NOT EXISTS description TEXT;
    ALTER TABLE team_project_assignments ADD COLUMN IF NOT EXISTS scope TEXT;
    ALTER TABLE team_project_assignments ADD COLUMN IF NOT EXISTS expected_outputs TEXT;
    ALTER TABLE team_project_assignments ADD COLUMN IF NOT EXISTS start_date DATE;
    ALTER TABLE team_project_assignments ADD COLUMN IF NOT EXISTS stakeholders TEXT[] DEFAULT '{}';
    ALTER TABLE team_project_assignments ADD COLUMN IF NOT EXISTS risks TEXT;
    ALTER TABLE team_project_assignments ADD COLUMN IF NOT EXISTS dependencies TEXT;
    ALTER TABLE team_project_assignments ADD COLUMN IF NOT EXISTS calendar_event_id VARCHAR(255);
    ALTER TABLE team_project_assignments ADD COLUMN IF NOT EXISTS ai_generated_scope JSONB;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_team_assignments_dept ON team_project_assignments(department);
  `);

  // PMP Projects Table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pmp_projects (
      id SERIAL PRIMARY KEY,
      project_id VARCHAR(50) UNIQUE NOT NULL,
      project_name VARCHAR(255) NOT NULL,
      project_code VARCHAR(50) UNIQUE NOT NULL,
      project_type VARCHAR(50) NOT NULL DEFAULT 'other',
      department VARCHAR(100) NOT NULL,
      project_manager_id VARCHAR(50),
      project_manager_name VARCHAR(255),
      sponsor_name VARCHAR(255),
      sponsor_email VARCHAR(255),
      status VARCHAR(30) NOT NULL DEFAULT 'initiation',
      priority VARCHAR(20) NOT NULL DEFAULT 'medium',
      
      project_charter TEXT,
      scope_statement TEXT,
      objectives TEXT[] DEFAULT '{}',
      wbs_structure JSONB DEFAULT '{}',
      deliverables TEXT[] DEFAULT '{}',
      exclusions TEXT[] DEFAULT '{}',
      assumptions TEXT[] DEFAULT '{}',
      constraints TEXT[] DEFAULT '{}',
      resource_plan JSONB DEFAULT '[]',
      
      planned_start_date DATE,
      planned_end_date DATE,
      actual_start_date DATE,
      actual_end_date DATE,
      baseline_start_date DATE,
      baseline_end_date DATE,
      
      budget_approved DECIMAL(15,2) DEFAULT 0,
      budget_spent DECIMAL(15,2) DEFAULT 0,
      budget_remaining DECIMAL(15,2) DEFAULT 0,
      cost_variance DECIMAL(15,2) DEFAULT 0,
      cost_performance_index DECIMAL(5,2) DEFAULT 1.0,
      
      schedule_variance INTEGER DEFAULT 0,
      schedule_performance_index DECIMAL(5,2) DEFAULT 1.0,
      percent_complete DECIMAL(5,2) DEFAULT 0,
      
      quality_criteria TEXT,
      acceptance_criteria TEXT,
      quality_score DECIMAL(5,2),
      
      communication_plan JSONB DEFAULT '{}',
      status_report_frequency VARCHAR(20) DEFAULT 'weekly',
      last_status_report_date DATE,
      
      ai_generated_charter JSONB,
      ai_recommendations JSONB DEFAULT '[]',
      
      created_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_pmp_projects_dept ON pmp_projects(department);
    CREATE INDEX IF NOT EXISTS idx_pmp_projects_status ON pmp_projects(status);
    CREATE INDEX IF NOT EXISTS idx_pmp_projects_priority ON pmp_projects(priority);
    CREATE INDEX IF NOT EXISTS idx_pmp_projects_manager ON pmp_projects(project_manager_id);
    CREATE INDEX IF NOT EXISTS idx_pmp_projects_type ON pmp_projects(project_type);
  `);

  // Add new scope columns if they don't exist
  await pool.query(`
    ALTER TABLE pmp_projects ADD COLUMN IF NOT EXISTS objectives TEXT[] DEFAULT '{}';
    ALTER TABLE pmp_projects ADD COLUMN IF NOT EXISTS resource_plan JSONB DEFAULT '[]';
  `);

  // Project Risks Table (Risk Register)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_risks (
      id SERIAL PRIMARY KEY,
      risk_id VARCHAR(50) UNIQUE NOT NULL,
      project_id VARCHAR(50) NOT NULL,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      category VARCHAR(50) NOT NULL DEFAULT 'other',
      probability VARCHAR(20) NOT NULL DEFAULT 'medium',
      impact VARCHAR(20) NOT NULL DEFAULT 'medium',
      risk_score INTEGER DEFAULT 0,
      status VARCHAR(30) NOT NULL DEFAULT 'identified',
      response_strategy VARCHAR(30) NOT NULL DEFAULT 'mitigate',
      response_plan TEXT,
      contingency_plan TEXT,
      risk_owner_id VARCHAR(50),
      risk_owner_name VARCHAR(255),
      trigger_conditions TEXT,
      due_date DATE,
      residual_risk TEXT,
      secondary_risks TEXT[] DEFAULT '{}',
      cost_impact DECIMAL(15,2),
      schedule_impact_days INTEGER,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_project_risks_project ON project_risks(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_risks_status ON project_risks(status);
    CREATE INDEX IF NOT EXISTS idx_project_risks_category ON project_risks(category);
    CREATE INDEX IF NOT EXISTS idx_project_risks_owner ON project_risks(risk_owner_id);
  `);

  // Project Milestones Table (Schedule/Gantt)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_milestones (
      id SERIAL PRIMARY KEY,
      milestone_id VARCHAR(50) UNIQUE NOT NULL,
      project_id VARCHAR(50) NOT NULL,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      milestone_type VARCHAR(50) NOT NULL DEFAULT 'checkpoint',
      planned_date DATE NOT NULL,
      actual_date DATE,
      baseline_date DATE,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      variance_days INTEGER DEFAULT 0,
      predecessor_id VARCHAR(50),
      successor_id VARCHAR(50),
      dependencies TEXT[] DEFAULT '{}',
      deliverables TEXT[] DEFAULT '{}',
      owner_id VARCHAR(50),
      owner_name VARCHAR(255),
      approval_required BOOLEAN DEFAULT false,
      approved_by VARCHAR(255),
      approved_date DATE,
      percent_complete DECIMAL(5,2) DEFAULT 0,
      weight DECIMAL(5,2) DEFAULT 1,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_project_milestones_project ON project_milestones(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_milestones_status ON project_milestones(status);
    CREATE INDEX IF NOT EXISTS idx_project_milestones_date ON project_milestones(planned_date);
    CREATE INDEX IF NOT EXISTS idx_project_milestones_owner ON project_milestones(owner_id);
  `);

  // Project Stakeholders Table (Stakeholder Register)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_stakeholders (
      id SERIAL PRIMARY KEY,
      stakeholder_id VARCHAR(50) UNIQUE NOT NULL,
      project_id VARCHAR(50) NOT NULL,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255),
      phone VARCHAR(50),
      organization VARCHAR(255),
      role VARCHAR(100) NOT NULL,
      stakeholder_type VARCHAR(50) NOT NULL DEFAULT 'internal',
      influence VARCHAR(20) NOT NULL DEFAULT 'medium',
      interest VARCHAR(20) NOT NULL DEFAULT 'medium',
      engagement_level VARCHAR(30) NOT NULL DEFAULT 'neutral',
      desired_engagement VARCHAR(30) NOT NULL DEFAULT 'supportive',
      communication_frequency VARCHAR(30) NOT NULL DEFAULT 'weekly',
      communication_method VARCHAR(30) NOT NULL DEFAULT 'email',
      expectations TEXT,
      requirements TEXT,
      power_interest_quadrant VARCHAR(30),
      is_decision_maker BOOLEAN DEFAULT false,
      last_contacted DATE,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_project_stakeholders_project ON project_stakeholders(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_stakeholders_type ON project_stakeholders(stakeholder_type);
    CREATE INDEX IF NOT EXISTS idx_project_stakeholders_influence ON project_stakeholders(influence);
  `);

  // Project Team Assignments Table (Resource Management)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_team_assignments (
      id SERIAL PRIMARY KEY,
      assignment_id VARCHAR(50) UNIQUE NOT NULL,
      project_id VARCHAR(50) NOT NULL,
      member_id VARCHAR(50) NOT NULL,
      member_name VARCHAR(255) NOT NULL,
      role_in_project VARCHAR(100) NOT NULL DEFAULT 'contributor',
      responsibility VARCHAR(50) DEFAULT 'responsible',
      allocation_percent DECIMAL(5,2) DEFAULT 100,
      start_date DATE,
      end_date DATE,
      planned_hours DECIMAL(8,2),
      actual_hours DECIMAL(8,2) DEFAULT 0,
      status VARCHAR(30) NOT NULL DEFAULT 'active',
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_project_team_project ON project_team_assignments(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_team_member ON project_team_assignments(member_id);
  `);

  // Procurement Management Table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_procurement (
      id SERIAL PRIMARY KEY,
      procurement_id VARCHAR(50) UNIQUE NOT NULL,
      project_id VARCHAR(50) NOT NULL,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      procurement_type VARCHAR(50) NOT NULL DEFAULT 'contract',
      vendor_name VARCHAR(255),
      vendor_contact_name VARCHAR(255),
      vendor_email VARCHAR(255),
      vendor_phone VARCHAR(50),
      contract_number VARCHAR(100),
      contract_value DECIMAL(15,2),
      currency VARCHAR(10) DEFAULT 'USD',
      payment_terms TEXT,
      start_date DATE,
      end_date DATE,
      delivery_date DATE,
      status VARCHAR(30) NOT NULL DEFAULT 'draft',
      approval_required BOOLEAN DEFAULT true,
      approved_by VARCHAR(255),
      approved_date DATE,
      deliverables TEXT[] DEFAULT '{}',
      terms_conditions TEXT,
      risk_assessment TEXT,
      performance_criteria TEXT,
      sla_requirements TEXT,
      warranty_period_days INTEGER,
      renewal_option BOOLEAN DEFAULT false,
      renewal_date DATE,
      owner_id VARCHAR(50),
      owner_name VARCHAR(255),
      attachments TEXT[] DEFAULT '{}',
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_project_procurement_project ON project_procurement(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_procurement_status ON project_procurement(status);
    CREATE INDEX IF NOT EXISTS idx_project_procurement_vendor ON project_procurement(vendor_name);
    CREATE INDEX IF NOT EXISTS idx_project_procurement_type ON project_procurement(procurement_type);
  `);

  // Integration Management - Change Requests Table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_change_requests (
      id SERIAL PRIMARY KEY,
      change_request_id VARCHAR(50) UNIQUE NOT NULL,
      project_id VARCHAR(50) NOT NULL,
      title VARCHAR(255) NOT NULL,
      description TEXT NOT NULL,
      change_type VARCHAR(50) NOT NULL DEFAULT 'scope',
      change_category VARCHAR(50) NOT NULL DEFAULT 'enhancement',
      priority VARCHAR(20) NOT NULL DEFAULT 'medium',
      status VARCHAR(30) NOT NULL DEFAULT 'draft',
      requested_by VARCHAR(255),
      requested_date DATE,
      justification TEXT,
      impact_analysis TEXT,
      scope_impact TEXT,
      schedule_impact_days INTEGER,
      cost_impact DECIMAL(15,2),
      quality_impact TEXT,
      risk_impact TEXT,
      alternatives_considered TEXT[] DEFAULT '{}',
      recommended_action TEXT,
      ccb_decision TEXT,
      ccb_decision_date DATE,
      ccb_decision_by VARCHAR(255),
      implementation_plan TEXT,
      implementation_date DATE,
      verified_by VARCHAR(255),
      verified_date DATE,
      baseline_update_required BOOLEAN DEFAULT false,
      affected_deliverables TEXT[] DEFAULT '{}',
      affected_milestones TEXT[] DEFAULT '{}',
      attachments TEXT[] DEFAULT '{}',
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_project_change_requests_project ON project_change_requests(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_change_requests_status ON project_change_requests(status);
    CREATE INDEX IF NOT EXISTS idx_project_change_requests_type ON project_change_requests(change_type);
    CREATE INDEX IF NOT EXISTS idx_project_change_requests_priority ON project_change_requests(priority);
  `);
}

export async function createTeamMember(member: Omit<TeamMember, 'id' | 'member_id' | 'created_at' | 'updated_at'>): Promise<TeamMember> {
  const memberId = `TM-${Date.now().toString(36).toUpperCase()}`;
  
  const result = await pool.query(
    `INSERT INTO team_members 
     (member_id, full_name, email, role, department, job_title, hire_date, manager_id,
      phone, skills, certifications, status, performance_score, training_compliance_rate, 
      projects_completed, avatar_url, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     RETURNING *`,
    [
      memberId, member.full_name, member.email, member.role, member.department,
      member.job_title, member.hire_date, member.manager_id, member.phone,
      member.skills || [], member.certifications || [], member.status || 'active',
      member.performance_score, member.training_compliance_rate, member.projects_completed || 0,
      member.avatar_url, JSON.stringify(member.metadata || {})
    ]
  );
  return result.rows[0];
}

export async function updateTeamMember(memberId: string, updates: Partial<TeamMember>): Promise<TeamMember | null> {
  const allowedFields = ['full_name', 'email', 'role', 'department', 'job_title', 'hire_date',
    'manager_id', 'phone', 'skills', 'certifications', 'status', 'performance_score',
    'training_compliance_rate', 'projects_completed', 'avatar_url', 'metadata'];
  
  const fields: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;
  
  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key) && value !== undefined) {
      if (key === 'metadata') {
        fields.push(`${key} = $${paramIndex}`);
        values.push(JSON.stringify(value));
      } else if (key === 'skills' || key === 'certifications') {
        fields.push(`${key} = $${paramIndex}`);
        values.push(value);
      } else {
        fields.push(`${key} = $${paramIndex}`);
        values.push(value);
      }
      paramIndex++;
    }
  }
  
  if (fields.length === 0) return null;
  
  fields.push('updated_at = NOW()');
  values.push(memberId);
  
  const result = await pool.query(
    `UPDATE team_members SET ${fields.join(', ')} WHERE member_id = $${paramIndex} RETURNING *`,
    values
  );
  
  return result.rows[0] || null;
}

export async function getTeamMemberById(memberId: string): Promise<TeamMember | null> {
  const result = await pool.query('SELECT * FROM team_members WHERE member_id = $1', [memberId]);
  return result.rows[0] || null;
}

export async function getTeamMemberByEmail(email: string): Promise<TeamMember | null> {
  const result = await pool.query('SELECT * FROM team_members WHERE email = $1', [email]);
  return result.rows[0] || null;
}

export async function listTeamMembers(options: {
  department?: string;
  role?: string;
  status?: string;
  managerId?: string;
  sortBy?: 'name' | 'performance' | 'department' | 'created';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
} = {}): Promise<{ members: TeamMember[]; total: number }> {
  let whereClause = 'WHERE 1=1';
  const params: any[] = [];
  let paramIndex = 1;

  if (options.department) {
    whereClause += ` AND department = $${paramIndex}`;
    params.push(options.department);
    paramIndex++;
  }

  if (options.role) {
    whereClause += ` AND role = $${paramIndex}`;
    params.push(options.role);
    paramIndex++;
  }

  if (options.status) {
    whereClause += ` AND status = $${paramIndex}`;
    params.push(options.status);
    paramIndex++;
  }

  if (options.managerId) {
    whereClause += ` AND manager_id = $${paramIndex}`;
    params.push(options.managerId);
    paramIndex++;
  }

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM team_members ${whereClause}`,
    params
  );

  let orderBy = 'created_at DESC';
  const sortOrder = options.sortOrder === 'asc' ? 'ASC' : 'DESC';
  switch (options.sortBy) {
    case 'name': orderBy = `full_name ${sortOrder}`; break;
    case 'performance': orderBy = `performance_score ${sortOrder} NULLS LAST`; break;
    case 'department': orderBy = `department ${sortOrder}`; break;
    case 'created': orderBy = `created_at ${sortOrder}`; break;
  }

  const result = await pool.query(
    `SELECT * FROM team_members ${whereClause} 
     ORDER BY ${orderBy}
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, options.limit || 50, options.offset || 0]
  );

  return {
    members: result.rows,
    total: parseInt(countResult.rows[0].count)
  };
}

export async function deleteTeamMember(memberId: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM team_members WHERE member_id = $1', [memberId]);
  return (result.rowCount || 0) > 0;
}

export async function addPerformanceMetric(metric: Omit<TeamPerformanceMetric, 'id' | 'created_at'>): Promise<TeamPerformanceMetric> {
  const overallScore = (metric.quality_score + metric.productivity_score + metric.compliance_score) / 3;
  
  const result = await pool.query(
    `INSERT INTO team_performance_metrics 
     (member_id, metric_date, quality_score, productivity_score, compliance_score,
      customer_satisfaction, audit_findings_count, training_hours, projects_active,
      tasks_completed, tasks_overdue, overall_score, period_type, notes, evaluated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING *`,
    [
      metric.member_id, metric.metric_date, metric.quality_score, metric.productivity_score,
      metric.compliance_score, metric.customer_satisfaction, metric.audit_findings_count || 0,
      metric.training_hours || 0, metric.projects_active || 0, metric.tasks_completed || 0,
      metric.tasks_overdue || 0, overallScore, metric.period_type || 'monthly',
      metric.notes, metric.evaluated_by
    ]
  );
  return result.rows[0];
}

export async function getPerformanceMetrics(options: {
  memberId?: string;
  startDate?: Date;
  endDate?: Date;
  periodType?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ metrics: TeamPerformanceMetric[]; total: number }> {
  let whereClause = 'WHERE 1=1';
  const params: any[] = [];
  let paramIndex = 1;

  if (options.memberId) {
    whereClause += ` AND member_id = $${paramIndex}`;
    params.push(options.memberId);
    paramIndex++;
  }

  if (options.startDate) {
    whereClause += ` AND metric_date >= $${paramIndex}`;
    params.push(options.startDate);
    paramIndex++;
  }

  if (options.endDate) {
    whereClause += ` AND metric_date <= $${paramIndex}`;
    params.push(options.endDate);
    paramIndex++;
  }

  if (options.periodType) {
    whereClause += ` AND period_type = $${paramIndex}`;
    params.push(options.periodType);
    paramIndex++;
  }

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM team_performance_metrics ${whereClause}`,
    params
  );

  const result = await pool.query(
    `SELECT * FROM team_performance_metrics ${whereClause} 
     ORDER BY metric_date DESC
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, options.limit || 50, options.offset || 0]
  );

  return {
    metrics: result.rows,
    total: parseInt(countResult.rows[0].count)
  };
}

export async function createProjectAssignment(assignment: Omit<TeamProjectAssignment, 'id' | 'assignment_id' | 'created_at' | 'updated_at'>): Promise<TeamProjectAssignment> {
  const assignmentId = `PA-${Date.now().toString(36).toUpperCase()}`;
  
  const result = await pool.query(
    `INSERT INTO team_project_assignments 
     (assignment_id, project_name, project_type, member_id, member_name, role_in_project,
      assigned_date, due_date, status, priority, effort_hours, deliverables, notes, assigned_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING *`,
    [
      assignmentId, assignment.project_name, assignment.project_type || 'other',
      assignment.member_id, assignment.member_name, assignment.role_in_project,
      assignment.assigned_date || new Date(), assignment.due_date,
      assignment.status || 'assigned', assignment.priority || 'medium',
      assignment.effort_hours, assignment.deliverables, assignment.notes, assignment.assigned_by
    ]
  );
  return result.rows[0];
}

export async function updateProjectAssignment(assignmentId: string, updates: Partial<TeamProjectAssignment>): Promise<TeamProjectAssignment | null> {
  const allowedFields = ['project_name', 'project_type', 'role_in_project', 'due_date',
    'completion_date', 'status', 'priority', 'effort_hours', 'actual_hours', 'deliverables', 'notes'];
  
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
  values.push(assignmentId);
  
  const result = await pool.query(
    `UPDATE team_project_assignments SET ${fields.join(', ')} WHERE assignment_id = $${paramIndex} RETURNING *`,
    values
  );
  
  return result.rows[0] || null;
}

export async function listProjectAssignments(options: {
  memberId?: string;
  projectType?: string;
  status?: string;
  priority?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ assignments: TeamProjectAssignment[]; total: number }> {
  let whereClause = 'WHERE 1=1';
  const params: any[] = [];
  let paramIndex = 1;

  if (options.memberId) {
    whereClause += ` AND member_id = $${paramIndex}`;
    params.push(options.memberId);
    paramIndex++;
  }

  if (options.projectType) {
    whereClause += ` AND project_type = $${paramIndex}`;
    params.push(options.projectType);
    paramIndex++;
  }

  if (options.status) {
    whereClause += ` AND status = $${paramIndex}`;
    params.push(options.status);
    paramIndex++;
  }

  if (options.priority) {
    whereClause += ` AND priority = $${paramIndex}`;
    params.push(options.priority);
    paramIndex++;
  }

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM team_project_assignments ${whereClause}`,
    params
  );

  const result = await pool.query(
    `SELECT * FROM team_project_assignments ${whereClause} 
     ORDER BY 
       CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
       due_date ASC NULLS LAST
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, options.limit || 50, options.offset || 0]
  );

  return {
    assignments: result.rows,
    total: parseInt(countResult.rows[0].count)
  };
}

export async function deleteProjectAssignment(assignmentId: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM team_project_assignments WHERE assignment_id = $1', [assignmentId]);
  return (result.rowCount || 0) > 0;
}

export async function getTeamAnalytics(): Promise<{
  totalMembers: number;
  byDepartment: Array<{ department: string; count: number; avg_performance: number }>;
  byStatus: { active: number; inactive: number; on_leave: number; probation: number };
  avgPerformance: number;
  avgTrainingCompliance: number;
  totalActiveProjects: number;
  projectsByStatus: { assigned: number; in_progress: number; completed: number; on_hold: number };
  topPerformers: TeamMember[];
  overdueAssignments: number;
}> {
  const [totalResult, deptResult, statusResult, avgResult, projectResult, projectStatusResult, topResult, overdueResult] = await Promise.all([
    pool.query('SELECT COUNT(*) FROM team_members'),
    pool.query(`
      SELECT department, COUNT(*) as count, AVG(performance_score) as avg_performance
      FROM team_members 
      WHERE status = 'active'
      GROUP BY department 
      ORDER BY count DESC
    `),
    pool.query(`
      SELECT status, COUNT(*) as count 
      FROM team_members 
      GROUP BY status
    `),
    pool.query(`
      SELECT AVG(performance_score) as avg_performance, AVG(training_compliance_rate) as avg_training
      FROM team_members WHERE status = 'active'
    `),
    pool.query(`SELECT COUNT(*) FROM team_project_assignments WHERE status IN ('assigned', 'in_progress')`),
    pool.query(`
      SELECT status, COUNT(*) as count 
      FROM team_project_assignments 
      GROUP BY status
    `),
    pool.query(`
      SELECT * FROM team_members 
      WHERE status = 'active' AND performance_score IS NOT NULL
      ORDER BY performance_score DESC 
      LIMIT 5
    `),
    pool.query(`
      SELECT COUNT(*) FROM team_project_assignments 
      WHERE due_date < CURRENT_DATE AND status NOT IN ('completed', 'cancelled')
    `)
  ]);

  const byStatus = { active: 0, inactive: 0, on_leave: 0, probation: 0 };
  for (const row of statusResult.rows) {
    if (row.status in byStatus) {
      byStatus[row.status as keyof typeof byStatus] = parseInt(row.count);
    }
  }

  const projectsByStatus = { assigned: 0, in_progress: 0, completed: 0, on_hold: 0 };
  for (const row of projectStatusResult.rows) {
    if (row.status in projectsByStatus) {
      projectsByStatus[row.status as keyof typeof projectsByStatus] = parseInt(row.count);
    }
  }

  return {
    totalMembers: parseInt(totalResult.rows[0].count),
    byDepartment: deptResult.rows.map(r => ({
      department: r.department,
      count: parseInt(r.count),
      avg_performance: parseFloat(r.avg_performance) || 0
    })),
    byStatus,
    avgPerformance: parseFloat(avgResult.rows[0].avg_performance) || 0,
    avgTrainingCompliance: parseFloat(avgResult.rows[0].avg_training) || 0,
    totalActiveProjects: parseInt(projectResult.rows[0].count),
    projectsByStatus,
    topPerformers: topResult.rows,
    overdueAssignments: parseInt(overdueResult.rows[0].count)
  };
}

export async function getTrainingMatrix(): Promise<{
  members: Array<{
    member_id: string;
    full_name: string;
    department: string;
    training_assignments: Array<{
      training_id: string;
      title: string;
      status: string;
      due_date: Date | null;
      completion_date: Date | null;
    }>;
    compliance_rate: number;
  }>;
}> {
  const membersResult = await pool.query(`
    SELECT tm.member_id, tm.full_name, tm.department, tm.training_compliance_rate,
           COALESCE(
             json_agg(
               json_build_object(
                 'training_id', ta.training_id,
                 'title', tr.title,
                 'status', ta.status,
                 'due_date', ta.due_date,
                 'completion_date', ta.completion_date
               )
             ) FILTER (WHERE ta.id IS NOT NULL),
             '[]'
           ) as training_assignments
    FROM team_members tm
    LEFT JOIN training_assignments ta ON tm.member_id = ta.employee_id
    LEFT JOIN training_records tr ON ta.training_id = tr.training_id
    WHERE tm.status = 'active'
    GROUP BY tm.member_id, tm.full_name, tm.department, tm.training_compliance_rate
    ORDER BY tm.full_name
  `);

  return {
    members: membersResult.rows.map(r => ({
      member_id: r.member_id,
      full_name: r.full_name,
      department: r.department,
      training_assignments: r.training_assignments || [],
      compliance_rate: parseFloat(r.training_compliance_rate) || 0
    }))
  };
}

export async function createTrainingCourse(course: Omit<TrainingCourse, 'id' | 'course_id' | 'created_at' | 'updated_at'>): Promise<TrainingCourse> {
  const courseId = `TC-${Date.now().toString(36).toUpperCase()}`;
  
  const result = await pool.query(
    `INSERT INTO training_courses 
     (course_id, name, course_type, description, duration_hours, passing_score, 
      attachments, ai_summary, department, is_active, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      courseId, course.name, course.course_type || 'optional', course.description,
      course.duration_hours || 1, course.passing_score || 70,
      course.attachments || [], course.ai_summary, course.department,
      course.is_active !== false, course.created_by
    ]
  );
  return result.rows[0];
}

export async function updateTrainingCourse(courseId: string, updates: Partial<TrainingCourse>): Promise<TrainingCourse | null> {
  const allowedFields = ['name', 'course_type', 'description', 'duration_hours', 'passing_score',
    'attachments', 'ai_summary', 'department', 'is_active', 'created_by'];
  
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
  values.push(courseId);
  
  const result = await pool.query(
    `UPDATE training_courses SET ${fields.join(', ')} WHERE course_id = $${paramIndex} RETURNING *`,
    values
  );
  
  return result.rows[0] || null;
}

export async function getTrainingCourseById(courseId: string): Promise<TrainingCourse | null> {
  const result = await pool.query('SELECT * FROM training_courses WHERE course_id = $1', [courseId]);
  return result.rows[0] || null;
}

export async function listTrainingCourses(options: {
  department?: string;
  courseType?: string;
  isActive?: boolean;
  limit?: number;
  offset?: number;
}): Promise<{ courses: TrainingCourse[]; total: number }> {
  const conditions: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (options.department) {
    conditions.push(`department = $${paramIndex++}`);
    values.push(options.department);
  }
  if (options.courseType) {
    conditions.push(`course_type = $${paramIndex++}`);
    values.push(options.courseType);
  }
  if (options.isActive !== undefined) {
    conditions.push(`is_active = $${paramIndex++}`);
    values.push(options.isActive);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  
  const countResult = await pool.query(`SELECT COUNT(*) FROM training_courses ${whereClause}`, values);
  
  const limit = options.limit || 50;
  const offset = options.offset || 0;
  values.push(limit, offset);
  
  const result = await pool.query(
    `SELECT * FROM training_courses ${whereClause} ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    values
  );

  return { courses: result.rows, total: parseInt(countResult.rows[0].count) };
}

export async function deleteTrainingCourse(courseId: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM training_courses WHERE course_id = $1', [courseId]);
  return (result.rowCount || 0) > 0;
}

export async function createCourseAssignment(assignment: Omit<TrainingAssignment, 'id' | 'assignment_id' | 'created_at'>): Promise<TrainingAssignment> {
  const assignmentId = `CA-${Date.now().toString(36).toUpperCase()}`;
  
  const result = await pool.query(
    `INSERT INTO course_assignments 
     (assignment_id, course_id, member_id, assigned_date, due_date, status, 
      score, attempts, priority, requires_assessment, notes, assigned_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      assignmentId, assignment.course_id, assignment.member_id,
      assignment.assigned_date || new Date(), assignment.due_date,
      assignment.status || 'assigned', assignment.score, assignment.attempts || 0,
      assignment.priority || 'medium', assignment.requires_assessment || false,
      assignment.notes, assignment.assigned_by
    ]
  );
  return result.rows[0];
}

export async function updateCourseAssignment(assignmentId: string, updates: Partial<TrainingAssignment>): Promise<TrainingAssignment | null> {
  const allowedFields = ['status', 'completion_date', 'score', 'attempts', 'priority', 'notes', 'due_date'];
  
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
  
  values.push(assignmentId);
  
  const result = await pool.query(
    `UPDATE course_assignments SET ${fields.join(', ')} WHERE assignment_id = $${paramIndex} RETURNING *`,
    values
  );
  
  return result.rows[0] || null;
}

export async function listCourseAssignments(options: {
  memberId?: string;
  courseId?: string;
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<{ assignments: any[]; total: number }> {
  const conditions: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (options.memberId) {
    conditions.push(`ca.member_id = $${paramIndex++}`);
    values.push(options.memberId);
  }
  if (options.courseId) {
    conditions.push(`ca.course_id = $${paramIndex++}`);
    values.push(options.courseId);
  }
  if (options.status) {
    conditions.push(`ca.status = $${paramIndex++}`);
    values.push(options.status);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  
  const countResult = await pool.query(
    `SELECT COUNT(*) FROM course_assignments ca ${whereClause}`, 
    values
  );
  
  const limit = options.limit || 50;
  const offset = options.offset || 0;
  values.push(limit, offset);
  
  const result = await pool.query(
    `SELECT ca.*, tc.name as course_name, tc.course_type, tc.duration_hours, tc.passing_score,
            tm.full_name as member_name, tm.department as member_department
     FROM course_assignments ca
     LEFT JOIN training_courses tc ON ca.course_id = tc.course_id
     LEFT JOIN team_members tm ON ca.member_id = tm.member_id
     ${whereClause} 
     ORDER BY ca.created_at DESC 
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    values
  );

  return { assignments: result.rows, total: parseInt(countResult.rows[0].count) };
}

export async function deleteCourseAssignment(assignmentId: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM course_assignments WHERE assignment_id = $1', [assignmentId]);
  return (result.rowCount || 0) > 0;
}

export async function logAuditEntry(entry: Omit<AuditLogEntry, 'id' | 'action_id' | 'created_at'>): Promise<AuditLogEntry> {
  const actionId = `AL-${Date.now().toString(36).toUpperCase()}`;
  
  const result = await pool.query(
    `INSERT INTO audit_trail 
     (action_id, action_type, module, entity_type, entity_id, user_id, user_name,
      old_value, new_value, description, ip_address, ai_involved, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [
      actionId, entry.action_type, entry.module, entry.entity_type, entry.entity_id,
      entry.user_id, entry.user_name,
      entry.old_value ? JSON.stringify(entry.old_value) : null,
      entry.new_value ? JSON.stringify(entry.new_value) : null,
      entry.description, entry.ip_address, entry.ai_involved || false,
      JSON.stringify(entry.metadata || {})
    ]
  );
  return result.rows[0];
}

export async function listAuditLogs(options: {
  module?: string;
  entityType?: string;
  entityId?: string;
  userId?: string;
  actionType?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}): Promise<{ logs: AuditLogEntry[]; total: number }> {
  const conditions: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (options.module) {
    conditions.push(`module = $${paramIndex++}`);
    values.push(options.module);
  }
  if (options.entityType) {
    conditions.push(`entity_type = $${paramIndex++}`);
    values.push(options.entityType);
  }
  if (options.entityId) {
    conditions.push(`entity_id = $${paramIndex++}`);
    values.push(options.entityId);
  }
  if (options.userId) {
    conditions.push(`user_id = $${paramIndex++}`);
    values.push(options.userId);
  }
  if (options.actionType) {
    conditions.push(`action_type = $${paramIndex++}`);
    values.push(options.actionType);
  }
  if (options.startDate) {
    conditions.push(`created_at >= $${paramIndex++}`);
    values.push(options.startDate);
  }
  if (options.endDate) {
    conditions.push(`created_at <= $${paramIndex++}`);
    values.push(options.endDate);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  
  const countResult = await pool.query(`SELECT COUNT(*) FROM audit_trail ${whereClause}`, values);
  
  const limit = options.limit || 100;
  const offset = options.offset || 0;
  values.push(limit, offset);
  
  const result = await pool.query(
    `SELECT * FROM audit_trail ${whereClause} ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    values
  );

  return { logs: result.rows, total: parseInt(countResult.rows[0].count) };
}

export async function getProjectsByKanbanStatus(): Promise<{
  backlog: TeamProjectAssignment[];
  in_progress: TeamProjectAssignment[];
  waiting_stakeholder: TeamProjectAssignment[];
  review: TeamProjectAssignment[];
  completed: TeamProjectAssignment[];
}> {
  const result = await pool.query(`
    SELECT * FROM team_project_assignments 
    WHERE status NOT IN ('cancelled', 'on_hold')
    ORDER BY priority DESC, due_date ASC NULLS LAST
  `);

  const kanban = {
    backlog: [] as TeamProjectAssignment[],
    in_progress: [] as TeamProjectAssignment[],
    waiting_stakeholder: [] as TeamProjectAssignment[],
    review: [] as TeamProjectAssignment[],
    completed: [] as TeamProjectAssignment[]
  };

  for (const row of result.rows) {
    const status = row.status as string;
    if (status === 'assigned' || status === 'backlog') {
      kanban.backlog.push(row);
    } else if (status === 'in_progress') {
      kanban.in_progress.push(row);
    } else if (status === 'waiting_stakeholder') {
      kanban.waiting_stakeholder.push(row);
    } else if (status === 'review') {
      kanban.review.push(row);
    } else if (status === 'completed') {
      kanban.completed.push(row);
    } else {
      kanban.backlog.push(row);
    }
  }

  return kanban;
}

export async function getCourseTrainingMatrix(): Promise<{
  members: Array<{
    member_id: string;
    full_name: string;
    department: string;
    course_assignments: Array<{
      course_id: string;
      course_name: string;
      course_type: string;
      status: string;
      due_date: Date | null;
      completion_date: Date | null;
      score: number | null;
    }>;
    compliance_rate: number;
  }>;
}> {
  const membersResult = await pool.query(`
    SELECT tm.member_id, tm.full_name, tm.department, tm.training_compliance_rate,
           COALESCE(
             json_agg(
               json_build_object(
                 'course_id', ca.course_id,
                 'course_name', tc.name,
                 'course_type', tc.course_type,
                 'status', ca.status,
                 'due_date', ca.due_date,
                 'completion_date', ca.completion_date,
                 'score', ca.score
               )
             ) FILTER (WHERE ca.id IS NOT NULL),
             '[]'
           ) as course_assignments
    FROM team_members tm
    LEFT JOIN course_assignments ca ON tm.member_id = ca.member_id
    LEFT JOIN training_courses tc ON ca.course_id = tc.course_id
    WHERE tm.status = 'active'
    GROUP BY tm.member_id, tm.full_name, tm.department, tm.training_compliance_rate
    ORDER BY tm.full_name
  `);

  return {
    members: membersResult.rows.map(r => ({
      member_id: r.member_id,
      full_name: r.full_name,
      department: r.department,
      course_assignments: r.course_assignments || [],
      compliance_rate: parseFloat(r.training_compliance_rate) || 0
    }))
  };
}

// ============================================
// PMP PROJECT CRUD FUNCTIONS
// ============================================

function calculateRiskScore(probability: string, impact: string): number {
  const probMap: Record<string, number> = { very_low: 1, low: 2, medium: 3, high: 4, very_high: 5 };
  const impactMap: Record<string, number> = { very_low: 1, low: 2, medium: 3, high: 4, very_high: 5 };
  return (probMap[probability] || 3) * (impactMap[impact] || 3);
}

function calculatePowerInterestQuadrant(influence: string, interest: string): string {
  const highInfluence = influence === 'high';
  const highInterest = interest === 'high';
  if (highInfluence && highInterest) return 'manage_closely';
  if (highInfluence && !highInterest) return 'keep_satisfied';
  if (!highInfluence && highInterest) return 'keep_informed';
  return 'monitor';
}

export async function createPMPProject(project: Omit<PMPProject, 'id' | 'project_id' | 'created_at' | 'updated_at'>): Promise<PMPProject> {
  const projectId = `PMP-${Date.now().toString(36).toUpperCase()}`;
  
  const result = await pool.query(
    `INSERT INTO pmp_projects 
     (project_id, project_name, project_code, project_type, department, project_manager_id, project_manager_name,
      sponsor_name, sponsor_email, status, priority, project_charter, scope_statement, objectives, wbs_structure,
      deliverables, exclusions, assumptions, constraints, resource_plan, planned_start_date, planned_end_date,
      budget_approved, quality_criteria, acceptance_criteria, communication_plan, status_report_frequency, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28)
     RETURNING *`,
    [
      projectId, project.project_name, project.project_code, project.project_type || 'other',
      project.department, project.project_manager_id, project.project_manager_name,
      project.sponsor_name, project.sponsor_email, project.status || 'initiation', project.priority || 'medium',
      project.project_charter, project.scope_statement, (project as any).objectives || [],
      JSON.stringify(project.wbs_structure || {}),
      project.deliverables || [], project.exclusions || [], project.assumptions || [], project.constraints || [],
      JSON.stringify((project as any).resource_plan || []),
      project.planned_start_date, project.planned_end_date, project.budget_approved || 0,
      project.quality_criteria, project.acceptance_criteria, JSON.stringify(project.communication_plan || {}),
      project.status_report_frequency || 'weekly', project.created_by
    ]
  );
  return result.rows[0];
}

export async function updatePMPProject(projectId: string, updates: Partial<PMPProject>): Promise<PMPProject | null> {
  const allowedFields = ['project_name', 'project_type', 'department', 'project_manager_id', 'project_manager_name',
    'sponsor_name', 'sponsor_email', 'status', 'priority', 'project_charter', 'scope_statement', 'objectives', 'wbs_structure',
    'deliverables', 'exclusions', 'assumptions', 'constraints', 'resource_plan', 'planned_start_date', 'planned_end_date',
    'actual_start_date', 'actual_end_date', 'baseline_start_date', 'baseline_end_date', 'budget_approved',
    'budget_spent', 'quality_criteria', 'acceptance_criteria', 'quality_score', 'communication_plan',
    'status_report_frequency', 'last_status_report_date', 'ai_generated_charter', 'ai_recommendations', 'percent_complete'];
  
  const fields: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;
  
  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key) && value !== undefined) {
      if (['wbs_structure', 'communication_plan', 'ai_generated_charter', 'ai_recommendations', 'resource_plan'].includes(key)) {
        fields.push(`${key} = $${paramIndex}`);
        values.push(JSON.stringify(value));
      } else if (['deliverables', 'exclusions', 'assumptions', 'constraints', 'objectives'].includes(key)) {
        fields.push(`${key} = $${paramIndex}`);
        values.push(value);
      } else {
        fields.push(`${key} = $${paramIndex}`);
        values.push(value);
      }
      paramIndex++;
    }
  }
  
  if (fields.length === 0) return null;
  
  // Recalculate budget remaining and variance
  fields.push('budget_remaining = budget_approved - budget_spent');
  fields.push('cost_variance = budget_approved - budget_spent');
  fields.push('updated_at = NOW()');
  values.push(projectId);
  
  const result = await pool.query(
    `UPDATE pmp_projects SET ${fields.join(', ')} WHERE project_id = $${paramIndex} RETURNING *`,
    values
  );
  
  return result.rows[0] || null;
}

export async function getPMPProjectById(projectId: string): Promise<PMPProject | null> {
  const result = await pool.query('SELECT * FROM pmp_projects WHERE project_id = $1', [projectId]);
  return result.rows[0] || null;
}

export async function listPMPProjects(options: {
  department?: string;
  status?: string;
  priority?: string;
  projectType?: string;
  managerId?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ projects: PMPProject[]; total: number }> {
  let whereClause = 'WHERE 1=1';
  const params: any[] = [];
  let paramIndex = 1;

  if (options.department) {
    whereClause += ` AND department = $${paramIndex++}`;
    params.push(options.department);
  }
  if (options.status) {
    whereClause += ` AND status = $${paramIndex++}`;
    params.push(options.status);
  }
  if (options.priority) {
    whereClause += ` AND priority = $${paramIndex++}`;
    params.push(options.priority);
  }
  if (options.projectType) {
    whereClause += ` AND project_type = $${paramIndex++}`;
    params.push(options.projectType);
  }
  if (options.managerId) {
    whereClause += ` AND project_manager_id = $${paramIndex++}`;
    params.push(options.managerId);
  }

  const countResult = await pool.query(`SELECT COUNT(*) FROM pmp_projects ${whereClause}`, params);
  
  const result = await pool.query(
    `SELECT * FROM pmp_projects ${whereClause} 
     ORDER BY CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
              planned_end_date ASC NULLS LAST
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, options.limit || 50, options.offset || 0]
  );

  return { projects: result.rows, total: parseInt(countResult.rows[0].count) };
}

export async function deletePMPProject(projectId: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM pmp_projects WHERE project_id = $1', [projectId]);
  return (result.rowCount || 0) > 0;
}

// ============================================
// PROJECT RISK CRUD FUNCTIONS
// ============================================

export async function createProjectRisk(risk: Omit<ProjectRisk, 'id' | 'risk_id' | 'risk_score' | 'created_at' | 'updated_at'>): Promise<ProjectRisk> {
  const riskId = `RSK-${Date.now().toString(36).toUpperCase()}`;
  const riskScore = calculateRiskScore(risk.probability, risk.impact);
  
  const result = await pool.query(
    `INSERT INTO project_risks 
     (risk_id, project_id, title, description, category, probability, impact, risk_score,
      status, response_strategy, response_plan, contingency_plan, risk_owner_id, risk_owner_name,
      trigger_conditions, due_date, residual_risk, secondary_risks, cost_impact, schedule_impact_days, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
     RETURNING *`,
    [
      riskId, risk.project_id, risk.title, risk.description, risk.category || 'other',
      risk.probability || 'medium', risk.impact || 'medium', riskScore,
      risk.status || 'identified', risk.response_strategy || 'mitigate',
      risk.response_plan, risk.contingency_plan, risk.risk_owner_id, risk.risk_owner_name,
      risk.trigger_conditions, risk.due_date, risk.residual_risk, risk.secondary_risks || [],
      risk.cost_impact, risk.schedule_impact_days, risk.notes
    ]
  );
  return result.rows[0];
}

export async function updateProjectRisk(riskId: string, updates: Partial<ProjectRisk>): Promise<ProjectRisk | null> {
  const allowedFields = ['title', 'description', 'category', 'probability', 'impact', 'status',
    'response_strategy', 'response_plan', 'contingency_plan', 'risk_owner_id', 'risk_owner_name',
    'trigger_conditions', 'due_date', 'residual_risk', 'secondary_risks', 'cost_impact', 'schedule_impact_days', 'notes'];
  
  const fields: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;
  
  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key) && value !== undefined) {
      fields.push(`${key} = $${paramIndex++}`);
      values.push(value);
    }
  }
  
  if (fields.length === 0) return null;
  
  // Recalculate risk score if probability or impact changed
  if (updates.probability || updates.impact) {
    const currentRisk = await getProjectRiskById(riskId);
    if (currentRisk) {
      const newScore = calculateRiskScore(
        updates.probability || currentRisk.probability,
        updates.impact || currentRisk.impact
      );
      fields.push(`risk_score = $${paramIndex++}`);
      values.push(newScore);
    }
  }
  
  fields.push('updated_at = NOW()');
  values.push(riskId);
  
  const result = await pool.query(
    `UPDATE project_risks SET ${fields.join(', ')} WHERE risk_id = $${paramIndex} RETURNING *`,
    values
  );
  
  return result.rows[0] || null;
}

export async function getProjectRiskById(riskId: string): Promise<ProjectRisk | null> {
  const result = await pool.query('SELECT * FROM project_risks WHERE risk_id = $1', [riskId]);
  return result.rows[0] || null;
}

export async function listProjectRisks(options: {
  projectId?: string;
  category?: string;
  status?: string;
  ownerId?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ risks: ProjectRisk[]; total: number }> {
  let whereClause = 'WHERE 1=1';
  const params: any[] = [];
  let paramIndex = 1;

  if (options.projectId) {
    whereClause += ` AND project_id = $${paramIndex++}`;
    params.push(options.projectId);
  }
  if (options.category) {
    whereClause += ` AND category = $${paramIndex++}`;
    params.push(options.category);
  }
  if (options.status) {
    whereClause += ` AND status = $${paramIndex++}`;
    params.push(options.status);
  }
  if (options.ownerId) {
    whereClause += ` AND risk_owner_id = $${paramIndex++}`;
    params.push(options.ownerId);
  }

  const countResult = await pool.query(`SELECT COUNT(*) FROM project_risks ${whereClause}`, params);
  
  const result = await pool.query(
    `SELECT * FROM project_risks ${whereClause} ORDER BY risk_score DESC, created_at DESC
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, options.limit || 50, options.offset || 0]
  );

  return { risks: result.rows, total: parseInt(countResult.rows[0].count) };
}

export async function deleteProjectRisk(riskId: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM project_risks WHERE risk_id = $1', [riskId]);
  return (result.rowCount || 0) > 0;
}

// ============================================
// PROJECT MILESTONE CRUD FUNCTIONS
// ============================================

export async function createProjectMilestone(milestone: Omit<ProjectMilestone, 'id' | 'milestone_id' | 'variance_days' | 'created_at' | 'updated_at'>): Promise<ProjectMilestone> {
  const milestoneId = `MS-${Date.now().toString(36).toUpperCase()}`;
  
  const result = await pool.query(
    `INSERT INTO project_milestones 
     (milestone_id, project_id, name, description, milestone_type, planned_date, baseline_date,
      status, predecessor_id, successor_id, dependencies, deliverables, owner_id, owner_name,
      approval_required, percent_complete, weight, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     RETURNING *`,
    [
      milestoneId, milestone.project_id, milestone.name, milestone.description,
      milestone.milestone_type || 'checkpoint', milestone.planned_date, milestone.baseline_date || milestone.planned_date,
      milestone.status || 'pending', milestone.predecessor_id, milestone.successor_id,
      milestone.dependencies || [], milestone.deliverables || [], milestone.owner_id, milestone.owner_name,
      milestone.approval_required || false, milestone.percent_complete || 0, milestone.weight || 1, milestone.notes
    ]
  );
  return result.rows[0];
}

export async function updateProjectMilestone(milestoneId: string, updates: Partial<ProjectMilestone>): Promise<ProjectMilestone | null> {
  const allowedFields = ['name', 'description', 'milestone_type', 'planned_date', 'actual_date', 'baseline_date',
    'status', 'predecessor_id', 'successor_id', 'dependencies', 'deliverables', 'owner_id', 'owner_name',
    'approval_required', 'approved_by', 'approved_date', 'percent_complete', 'weight', 'notes'];
  
  const fields: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;
  
  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key) && value !== undefined) {
      fields.push(`${key} = $${paramIndex++}`);
      values.push(value);
    }
  }
  
  if (fields.length === 0) return null;
  
  // Calculate variance days if actual_date is set
  if (updates.actual_date) {
    fields.push(`variance_days = EXTRACT(DAY FROM ($${paramIndex}::date - planned_date))`);
    values.push(updates.actual_date);
    paramIndex++;
  }
  
  fields.push('updated_at = NOW()');
  values.push(milestoneId);
  
  const result = await pool.query(
    `UPDATE project_milestones SET ${fields.join(', ')} WHERE milestone_id = $${paramIndex} RETURNING *`,
    values
  );
  
  return result.rows[0] || null;
}

export async function getProjectMilestoneById(milestoneId: string): Promise<ProjectMilestone | null> {
  const result = await pool.query('SELECT * FROM project_milestones WHERE milestone_id = $1', [milestoneId]);
  return result.rows[0] || null;
}

export async function listProjectMilestones(options: {
  projectId?: string;
  status?: string;
  milestoneType?: string;
  ownerId?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ milestones: ProjectMilestone[]; total: number }> {
  let whereClause = 'WHERE 1=1';
  const params: any[] = [];
  let paramIndex = 1;

  if (options.projectId) {
    whereClause += ` AND project_id = $${paramIndex++}`;
    params.push(options.projectId);
  }
  if (options.status) {
    whereClause += ` AND status = $${paramIndex++}`;
    params.push(options.status);
  }
  if (options.milestoneType) {
    whereClause += ` AND milestone_type = $${paramIndex++}`;
    params.push(options.milestoneType);
  }
  if (options.ownerId) {
    whereClause += ` AND owner_id = $${paramIndex++}`;
    params.push(options.ownerId);
  }

  const countResult = await pool.query(`SELECT COUNT(*) FROM project_milestones ${whereClause}`, params);
  
  const result = await pool.query(
    `SELECT * FROM project_milestones ${whereClause} ORDER BY planned_date ASC
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, options.limit || 50, options.offset || 0]
  );

  return { milestones: result.rows, total: parseInt(countResult.rows[0].count) };
}

export async function deleteProjectMilestone(milestoneId: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM project_milestones WHERE milestone_id = $1', [milestoneId]);
  return (result.rowCount || 0) > 0;
}

// ============================================
// PROJECT STAKEHOLDER CRUD FUNCTIONS
// ============================================

export async function createProjectStakeholder(stakeholder: Omit<ProjectStakeholder, 'id' | 'stakeholder_id' | 'power_interest_quadrant' | 'created_at' | 'updated_at'>): Promise<ProjectStakeholder> {
  const stakeholderId = `SH-${Date.now().toString(36).toUpperCase()}`;
  const quadrant = calculatePowerInterestQuadrant(stakeholder.influence, stakeholder.interest);
  
  const result = await pool.query(
    `INSERT INTO project_stakeholders 
     (stakeholder_id, project_id, name, email, phone, organization, role, stakeholder_type,
      influence, interest, engagement_level, desired_engagement, communication_frequency,
      communication_method, expectations, requirements, power_interest_quadrant, is_decision_maker, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
     RETURNING *`,
    [
      stakeholderId, stakeholder.project_id, stakeholder.name, stakeholder.email, stakeholder.phone,
      stakeholder.organization, stakeholder.role, stakeholder.stakeholder_type || 'internal',
      stakeholder.influence || 'medium', stakeholder.interest || 'medium',
      stakeholder.engagement_level || 'neutral', stakeholder.desired_engagement || 'supportive',
      stakeholder.communication_frequency || 'weekly', stakeholder.communication_method || 'email',
      stakeholder.expectations, stakeholder.requirements, quadrant, stakeholder.is_decision_maker || false,
      stakeholder.notes
    ]
  );
  return result.rows[0];
}

export async function updateProjectStakeholder(stakeholderId: string, updates: Partial<ProjectStakeholder>): Promise<ProjectStakeholder | null> {
  const allowedFields = ['name', 'email', 'phone', 'organization', 'role', 'stakeholder_type',
    'influence', 'interest', 'engagement_level', 'desired_engagement', 'communication_frequency',
    'communication_method', 'expectations', 'requirements', 'is_decision_maker', 'last_contacted', 'notes'];
  
  const fields: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;
  
  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key) && value !== undefined) {
      fields.push(`${key} = $${paramIndex++}`);
      values.push(value);
    }
  }
  
  if (fields.length === 0) return null;
  
  // Recalculate quadrant if influence or interest changed
  if (updates.influence || updates.interest) {
    const current = await getProjectStakeholderById(stakeholderId);
    if (current) {
      const quadrant = calculatePowerInterestQuadrant(
        updates.influence || current.influence,
        updates.interest || current.interest
      );
      fields.push(`power_interest_quadrant = $${paramIndex++}`);
      values.push(quadrant);
    }
  }
  
  fields.push('updated_at = NOW()');
  values.push(stakeholderId);
  
  const result = await pool.query(
    `UPDATE project_stakeholders SET ${fields.join(', ')} WHERE stakeholder_id = $${paramIndex} RETURNING *`,
    values
  );
  
  return result.rows[0] || null;
}

export async function getProjectStakeholderById(stakeholderId: string): Promise<ProjectStakeholder | null> {
  const result = await pool.query('SELECT * FROM project_stakeholders WHERE stakeholder_id = $1', [stakeholderId]);
  return result.rows[0] || null;
}

export async function listProjectStakeholders(options: {
  projectId?: string;
  stakeholderType?: string;
  influence?: string;
  quadrant?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ stakeholders: ProjectStakeholder[]; total: number }> {
  let whereClause = 'WHERE 1=1';
  const params: any[] = [];
  let paramIndex = 1;

  if (options.projectId) {
    whereClause += ` AND project_id = $${paramIndex++}`;
    params.push(options.projectId);
  }
  if (options.stakeholderType) {
    whereClause += ` AND stakeholder_type = $${paramIndex++}`;
    params.push(options.stakeholderType);
  }
  if (options.influence) {
    whereClause += ` AND influence = $${paramIndex++}`;
    params.push(options.influence);
  }
  if (options.quadrant) {
    whereClause += ` AND power_interest_quadrant = $${paramIndex++}`;
    params.push(options.quadrant);
  }

  const countResult = await pool.query(`SELECT COUNT(*) FROM project_stakeholders ${whereClause}`, params);
  
  const result = await pool.query(
    `SELECT * FROM project_stakeholders ${whereClause} 
     ORDER BY CASE influence WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
              CASE interest WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, options.limit || 50, options.offset || 0]
  );

  return { stakeholders: result.rows, total: parseInt(countResult.rows[0].count) };
}

export async function deleteProjectStakeholder(stakeholderId: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM project_stakeholders WHERE stakeholder_id = $1', [stakeholderId]);
  return (result.rowCount || 0) > 0;
}

// ============================================
// PROJECT PORTFOLIO ANALYTICS
// ============================================

export async function getProjectPortfolioAnalytics(): Promise<{
  totalProjects: number;
  byStatus: Record<string, number>;
  byPriority: Record<string, number>;
  byDepartment: Array<{ department: string; count: number; avgCompletion: number }>;
  avgSPI: number;
  avgCPI: number;
  totalBudget: number;
  totalSpent: number;
  atRiskProjects: number;
  overdueProjects: number;
  completedThisMonth: number;
  riskSummary: { high: number; medium: number; low: number; totalExposure: number };
  milestoneMetrics: { onTime: number; delayed: number; upcoming: number };
  procurementMetrics: { total: number; active: number; pending: number; totalValue: number };
  changeControlMetrics: { total: number; pending: number; approved: number; rejected: number; totalImpact: number };
}> {
  const projectStats = await pool.query(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 'initiation' THEN 1 ELSE 0 END) as initiation,
      SUM(CASE WHEN status = 'planning' THEN 1 ELSE 0 END) as planning,
      SUM(CASE WHEN status = 'execution' THEN 1 ELSE 0 END) as execution,
      SUM(CASE WHEN status = 'monitoring' THEN 1 ELSE 0 END) as monitoring,
      SUM(CASE WHEN status = 'closing' THEN 1 ELSE 0 END) as closing,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'on_hold' THEN 1 ELSE 0 END) as on_hold,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
      SUM(CASE WHEN priority = 'critical' THEN 1 ELSE 0 END) as critical,
      SUM(CASE WHEN priority = 'high' THEN 1 ELSE 0 END) as high,
      SUM(CASE WHEN priority = 'medium' THEN 1 ELSE 0 END) as medium,
      SUM(CASE WHEN priority = 'low' THEN 1 ELSE 0 END) as low,
      AVG(schedule_performance_index) as avg_spi,
      AVG(cost_performance_index) as avg_cpi,
      SUM(budget_approved) as total_budget,
      SUM(budget_spent) as total_spent,
      SUM(CASE WHEN schedule_performance_index < 0.9 OR cost_performance_index < 0.9 THEN 1 ELSE 0 END) as at_risk,
      SUM(CASE WHEN planned_end_date < CURRENT_DATE AND status NOT IN ('completed', 'cancelled', 'on_hold') THEN 1 ELSE 0 END) as overdue,
      SUM(CASE WHEN status = 'completed' AND actual_end_date >= DATE_TRUNC('month', CURRENT_DATE) THEN 1 ELSE 0 END) as completed_this_month
    FROM pmp_projects
  `);

  const deptStats = await pool.query(`
    SELECT department, COUNT(*) as count, AVG(percent_complete) as avg_completion
    FROM pmp_projects
    WHERE status NOT IN ('cancelled')
    GROUP BY department
    ORDER BY count DESC
  `);

  const riskStats = await pool.query(`
    SELECT 
      SUM(CASE WHEN risk_score >= 15 THEN 1 ELSE 0 END) as high,
      SUM(CASE WHEN risk_score >= 8 AND risk_score < 15 THEN 1 ELSE 0 END) as medium,
      SUM(CASE WHEN risk_score < 8 THEN 1 ELSE 0 END) as low,
      SUM(COALESCE(cost_impact, 0)) as total_exposure
    FROM project_risks
    WHERE status NOT IN ('closed', 'mitigated')
  `);

  const milestoneStats = await pool.query(`
    SELECT 
      SUM(CASE WHEN status = 'completed' AND (actual_date IS NULL OR actual_date <= planned_date) THEN 1 ELSE 0 END) as on_time,
      SUM(CASE WHEN status = 'delayed' OR (status = 'completed' AND actual_date > planned_date) THEN 1 ELSE 0 END) as delayed,
      SUM(CASE WHEN status IN ('pending', 'in_progress') AND planned_date >= CURRENT_DATE AND planned_date <= CURRENT_DATE + INTERVAL '14 days' THEN 1 ELSE 0 END) as upcoming
    FROM project_milestones
  `);

  const procurementStats = await pool.query(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN status = 'pending_approval' THEN 1 ELSE 0 END) as pending,
      SUM(COALESCE(contract_value, 0)) as total_value
    FROM project_procurement
  `);

  const changeControlStats = await pool.query(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status IN ('submitted', 'under_review') THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN ccb_decision = 'approved' THEN 1 ELSE 0 END) as approved,
      SUM(CASE WHEN ccb_decision = 'rejected' THEN 1 ELSE 0 END) as rejected,
      SUM(CASE WHEN ccb_decision = 'approved' THEN COALESCE(cost_impact, 0) ELSE 0 END) as total_impact
    FROM project_change_requests
  `);

  const stats = projectStats.rows[0];
  const risks = riskStats.rows[0];
  const milestones = milestoneStats.rows[0];
  const procStats = procurementStats.rows[0];
  const changeStats = changeControlStats.rows[0];

  return {
    totalProjects: parseInt(stats.total) || 0,
    byStatus: {
      initiation: parseInt(stats.initiation) || 0,
      planning: parseInt(stats.planning) || 0,
      execution: parseInt(stats.execution) || 0,
      monitoring: parseInt(stats.monitoring) || 0,
      closing: parseInt(stats.closing) || 0,
      completed: parseInt(stats.completed) || 0,
      on_hold: parseInt(stats.on_hold) || 0,
      cancelled: parseInt(stats.cancelled) || 0
    },
    byPriority: {
      critical: parseInt(stats.critical) || 0,
      high: parseInt(stats.high) || 0,
      medium: parseInt(stats.medium) || 0,
      low: parseInt(stats.low) || 0
    },
    byDepartment: deptStats.rows.map(r => ({
      department: r.department,
      count: parseInt(r.count),
      avgCompletion: parseFloat(r.avg_completion) || 0
    })),
    avgSPI: parseFloat(stats.avg_spi) || 1.0,
    avgCPI: parseFloat(stats.avg_cpi) || 1.0,
    totalBudget: parseFloat(stats.total_budget) || 0,
    totalSpent: parseFloat(stats.total_spent) || 0,
    atRiskProjects: parseInt(stats.at_risk) || 0,
    overdueProjects: parseInt(stats.overdue) || 0,
    completedThisMonth: parseInt(stats.completed_this_month) || 0,
    riskSummary: {
      high: parseInt(risks.high) || 0,
      medium: parseInt(risks.medium) || 0,
      low: parseInt(risks.low) || 0,
      totalExposure: parseFloat(risks.total_exposure) || 0
    },
    milestoneMetrics: {
      onTime: parseInt(milestones.on_time) || 0,
      delayed: parseInt(milestones.delayed) || 0,
      upcoming: parseInt(milestones.upcoming) || 0
    },
    procurementMetrics: {
      total: parseInt(procStats.total) || 0,
      active: parseInt(procStats.active) || 0,
      pending: parseInt(procStats.pending) || 0,
      totalValue: parseFloat(procStats.total_value) || 0
    },
    changeControlMetrics: {
      total: parseInt(changeStats.total) || 0,
      pending: parseInt(changeStats.pending) || 0,
      approved: parseInt(changeStats.approved) || 0,
      rejected: parseInt(changeStats.rejected) || 0,
      totalImpact: parseFloat(changeStats.total_impact) || 0
    }
  };
}

export async function getProjectGanttData(projectId: string): Promise<{
  project: PMPProject | null;
  milestones: ProjectMilestone[];
  timeline: Array<{
    id: string;
    name: string;
    type: 'milestone' | 'phase';
    start: Date;
    end: Date;
    progress: number;
    dependencies: string[];
    status: string;
  }>;
}> {
  const project = await getPMPProjectById(projectId);
  const { milestones } = await listProjectMilestones({ projectId, limit: 100 });

  const timeline = milestones.map(m => ({
    id: m.milestone_id,
    name: m.name,
    type: 'milestone' as const,
    start: m.planned_date,
    end: m.actual_date || m.planned_date,
    progress: m.percent_complete,
    dependencies: m.dependencies || [],
    status: m.status
  }));

  return { project, milestones, timeline };
}

// ============================================
// PROCUREMENT MANAGEMENT FUNCTIONS
// ============================================

export async function createProjectProcurement(procurement: Partial<ProjectProcurement>): Promise<ProjectProcurement> {
  const procurementId = `PROC-${Date.now().toString(36).toUpperCase()}`;
  
  const result = await pool.query(
    `INSERT INTO project_procurement 
     (procurement_id, project_id, title, description, procurement_type, vendor_name,
      vendor_contact_name, vendor_email, vendor_phone, contract_number, contract_value,
      currency, payment_terms, start_date, end_date, delivery_date, status, approval_required,
      deliverables, terms_conditions, risk_assessment, performance_criteria, sla_requirements,
      warranty_period_days, renewal_option, owner_id, owner_name, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28)
     RETURNING *`,
    [
      procurementId, procurement.project_id, procurement.title, procurement.description,
      procurement.procurement_type || 'contract', procurement.vendor_name, procurement.vendor_contact_name,
      procurement.vendor_email, procurement.vendor_phone, procurement.contract_number,
      procurement.contract_value, procurement.currency || 'USD', procurement.payment_terms,
      procurement.start_date, procurement.end_date, procurement.delivery_date,
      procurement.status || 'draft', procurement.approval_required !== false,
      procurement.deliverables || [], procurement.terms_conditions, procurement.risk_assessment,
      procurement.performance_criteria, procurement.sla_requirements, procurement.warranty_period_days,
      procurement.renewal_option || false, procurement.owner_id, procurement.owner_name, procurement.notes
    ]
  );
  return result.rows[0];
}

export async function getProjectProcurementById(procurementId: string): Promise<ProjectProcurement | null> {
  const result = await pool.query('SELECT * FROM project_procurement WHERE procurement_id = $1', [procurementId]);
  return result.rows[0] || null;
}

export async function updateProjectProcurement(procurementId: string, updates: Partial<ProjectProcurement>): Promise<ProjectProcurement | null> {
  const allowedFields = ['title', 'description', 'procurement_type', 'vendor_name', 'vendor_contact_name',
    'vendor_email', 'vendor_phone', 'contract_number', 'contract_value', 'currency', 'payment_terms',
    'start_date', 'end_date', 'delivery_date', 'status', 'approval_required', 'approved_by', 'approved_date',
    'deliverables', 'terms_conditions', 'risk_assessment', 'performance_criteria', 'sla_requirements',
    'warranty_period_days', 'renewal_option', 'renewal_date', 'owner_id', 'owner_name', 'attachments', 'notes'];
  
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
  values.push(procurementId);
  
  const result = await pool.query(
    `UPDATE project_procurement SET ${fields.join(', ')} WHERE procurement_id = $${paramIndex} RETURNING *`,
    values
  );
  
  return result.rows[0] || null;
}

export async function listProjectProcurement(options: {
  projectId?: string;
  status?: string;
  procurementType?: string;
  vendorName?: string;
  limit?: number;
  offset?: number;
}): Promise<{ procurement: ProjectProcurement[]; total: number }> {
  const conditions: string[] = [];
  const params: any[] = [];
  let paramIndex = 1;

  if (options.projectId) {
    conditions.push(`project_id = $${paramIndex++}`);
    params.push(options.projectId);
  }
  if (options.status) {
    conditions.push(`status = $${paramIndex++}`);
    params.push(options.status);
  }
  if (options.procurementType) {
    conditions.push(`procurement_type = $${paramIndex++}`);
    params.push(options.procurementType);
  }
  if (options.vendorName) {
    conditions.push(`vendor_name ILIKE $${paramIndex++}`);
    params.push(`%${options.vendorName}%`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await pool.query(`SELECT COUNT(*) FROM project_procurement ${whereClause}`, params);
  const result = await pool.query(
    `SELECT * FROM project_procurement ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, options.limit || 50, options.offset || 0]
  );

  return { procurement: result.rows, total: parseInt(countResult.rows[0].count) };
}

export async function deleteProjectProcurement(procurementId: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM project_procurement WHERE procurement_id = $1', [procurementId]);
  return (result.rowCount || 0) > 0;
}

// ============================================
// CHANGE REQUEST (INTEGRATION) FUNCTIONS
// ============================================

export async function createProjectChangeRequest(changeRequest: Partial<ProjectChangeRequest>): Promise<ProjectChangeRequest> {
  const changeRequestId = `CR-${Date.now().toString(36).toUpperCase()}`;
  
  const result = await pool.query(
    `INSERT INTO project_change_requests 
     (change_request_id, project_id, title, description, change_type, change_category,
      priority, status, requested_by, requested_date, justification, impact_analysis,
      scope_impact, schedule_impact_days, cost_impact, quality_impact, risk_impact,
      alternatives_considered, recommended_action, baseline_update_required,
      affected_deliverables, affected_milestones, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
     RETURNING *`,
    [
      changeRequestId, changeRequest.project_id, changeRequest.title, changeRequest.description,
      changeRequest.change_type || 'scope', changeRequest.change_category || 'enhancement',
      changeRequest.priority || 'medium', changeRequest.status || 'draft',
      changeRequest.requested_by, changeRequest.requested_date || new Date(),
      changeRequest.justification, changeRequest.impact_analysis, changeRequest.scope_impact,
      changeRequest.schedule_impact_days, changeRequest.cost_impact, changeRequest.quality_impact,
      changeRequest.risk_impact, changeRequest.alternatives_considered || [],
      changeRequest.recommended_action, changeRequest.baseline_update_required || false,
      changeRequest.affected_deliverables || [], changeRequest.affected_milestones || [],
      changeRequest.notes
    ]
  );
  return result.rows[0];
}

export async function getProjectChangeRequestById(changeRequestId: string): Promise<ProjectChangeRequest | null> {
  const result = await pool.query('SELECT * FROM project_change_requests WHERE change_request_id = $1', [changeRequestId]);
  return result.rows[0] || null;
}

export async function updateProjectChangeRequest(changeRequestId: string, updates: Partial<ProjectChangeRequest>): Promise<ProjectChangeRequest | null> {
  const allowedFields = ['title', 'description', 'change_type', 'change_category', 'priority', 'status',
    'justification', 'impact_analysis', 'scope_impact', 'schedule_impact_days', 'cost_impact',
    'quality_impact', 'risk_impact', 'alternatives_considered', 'recommended_action',
    'ccb_decision', 'ccb_decision_date', 'ccb_decision_by', 'implementation_plan', 'implementation_date',
    'verified_by', 'verified_date', 'baseline_update_required', 'affected_deliverables',
    'affected_milestones', 'attachments', 'notes'];
  
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
  values.push(changeRequestId);
  
  const result = await pool.query(
    `UPDATE project_change_requests SET ${fields.join(', ')} WHERE change_request_id = $${paramIndex} RETURNING *`,
    values
  );
  
  return result.rows[0] || null;
}

export async function listProjectChangeRequests(options: {
  projectId?: string;
  status?: string;
  changeType?: string;
  priority?: string;
  limit?: number;
  offset?: number;
}): Promise<{ changeRequests: ProjectChangeRequest[]; total: number }> {
  const conditions: string[] = [];
  const params: any[] = [];
  let paramIndex = 1;

  if (options.projectId) {
    conditions.push(`project_id = $${paramIndex++}`);
    params.push(options.projectId);
  }
  if (options.status) {
    conditions.push(`status = $${paramIndex++}`);
    params.push(options.status);
  }
  if (options.changeType) {
    conditions.push(`change_type = $${paramIndex++}`);
    params.push(options.changeType);
  }
  if (options.priority) {
    conditions.push(`priority = $${paramIndex++}`);
    params.push(options.priority);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await pool.query(`SELECT COUNT(*) FROM project_change_requests ${whereClause}`, params);
  const result = await pool.query(
    `SELECT * FROM project_change_requests ${whereClause}
     ORDER BY CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
              created_at DESC
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, options.limit || 50, options.offset || 0]
  );

  return { changeRequests: result.rows, total: parseInt(countResult.rows[0].count) };
}

export async function deleteProjectChangeRequest(changeRequestId: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM project_change_requests WHERE change_request_id = $1', [changeRequestId]);
  return (result.rowCount || 0) > 0;
}
