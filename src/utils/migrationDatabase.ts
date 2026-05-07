import { createRedactedPool } from "./redactedPool";
import { logger } from "./logger";

const pool = createRedactedPool({
  connectionString: process.env.DATABASE_URL,
});

export interface MigrationJob {
  id?: number;
  job_code: string;
  name: string;
  description?: string;
  source_type: "csv" | "excel" | "json" | "api";
  target_module:
    | "risks"
    | "policies"
    | "compliance"
    | "audits"
    | "vendors"
    | "controls";
  status:
    | "pending"
    | "validating"
    | "mapping"
    | "importing"
    | "completed"
    | "failed"
    | "cancelled";
  file_name?: string;
  file_path?: string;
  total_records?: number;
  processed_records?: number;
  success_records?: number;
  failed_records?: number;
  duplicate_records?: number;
  error_log?: string;
  field_mapping?: string;
  validation_rules?: string;
  created_by?: string;
  completed_at?: Date;
  created_at?: Date;
  updated_at?: Date;
}

export interface MigrationTemplate {
  id?: number;
  name: string;
  target_module: string;
  description?: string;
  field_mapping: string;
  sample_data?: string;
  is_active: boolean;
  created_at?: Date;
  updated_at?: Date;
}

export interface DeduplicationRule {
  id?: number;
  target_module: string;
  rule_name: string;
  match_fields: string;
  threshold?: number;
  action: "skip" | "merge" | "flag" | "overwrite";
  is_active: boolean;
  created_at?: Date;
}

export async function initMigrationTables(): Promise<void> {
  logger.info("📋 [MigrationDB] Initializing migration tables...");
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS migration_jobs (
      id SERIAL PRIMARY KEY,
      job_code VARCHAR(50) UNIQUE NOT NULL,
      name VARCHAR(500) NOT NULL,
      description TEXT,
      source_type VARCHAR(20) NOT NULL,
      target_module VARCHAR(50) NOT NULL,
      status VARCHAR(30) DEFAULT 'pending',
      file_name VARCHAR(500),
      file_path VARCHAR(1000),
      total_records INTEGER DEFAULT 0,
      processed_records INTEGER DEFAULT 0,
      success_records INTEGER DEFAULT 0,
      failed_records INTEGER DEFAULT 0,
      duplicate_records INTEGER DEFAULT 0,
      error_log TEXT,
      field_mapping JSONB,
      validation_rules JSONB,
      created_by VARCHAR(255),
      completed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS migration_templates (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      target_module VARCHAR(50) NOT NULL,
      description TEXT,
      field_mapping JSONB NOT NULL,
      sample_data JSONB,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS deduplication_rules (
      id SERIAL PRIMARY KEY,
      target_module VARCHAR(50) NOT NULL,
      rule_name VARCHAR(255) NOT NULL,
      match_fields TEXT[] NOT NULL,
      threshold DECIMAL(3,2) DEFAULT 0.85,
      action VARCHAR(20) DEFAULT 'flag',
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS migration_records (
      id SERIAL PRIMARY KEY,
      job_id INTEGER REFERENCES migration_jobs(id) ON DELETE CASCADE,
      row_number INTEGER NOT NULL,
      source_data JSONB NOT NULL,
      mapped_data JSONB,
      status VARCHAR(20) DEFAULT 'pending',
      error_message TEXT,
      target_record_id INTEGER,
      is_duplicate BOOLEAN DEFAULT false,
      duplicate_of INTEGER,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await seedMigrationTemplates();
  await seedDeduplicationRules();
  logger.info("✅ [MigrationDB] Migration tables initialized");
}

async function seedMigrationTemplates(): Promise<void> {
  const existingTemplates = await pool.query(
    "SELECT COUNT(*) FROM migration_templates",
  );
  if (parseInt(existingTemplates.rows[0].count) > 0) return;

  logger.info("📝 [MigrationDB] Seeding migration templates...");
  
  const templates = [
    {
      name: "Risk Register Import",
      target_module: "risks",
      description: "Standard template for importing risks from spreadsheets",
      field_mapping: JSON.stringify({
        required: ["risk_code", "title", "category", "likelihood", "impact"],
        optional: ["description", "owner_name", "treatment_plan", "status"],
        mappings: {
          "Risk ID": "risk_code",
          "Risk Title": "title",
          "Risk Name": "title",
          Category: "category",
          Type: "category",
          Likelihood: "likelihood",
          Probability: "likelihood",
          Impact: "impact",
          Severity: "impact",
          Description: "description",
          Owner: "owner_name",
          "Risk Owner": "owner_name",
          Treatment: "treatment_plan",
          Mitigation: "treatment_plan",
          Status: "status",
        },
      }),
    },
    {
      name: "Policy Library Import",
      target_module: "policies",
      description: "Import policies from document management systems",
      field_mapping: JSON.stringify({
        required: ["policy_code", "title", "category"],
        optional: [
          "description",
          "owner",
          "effective_date",
          "review_date",
          "status",
        ],
        mappings: {
          "Policy ID": "policy_code",
          "Policy Code": "policy_code",
          "Policy Title": "title",
          Title: "title",
          "Policy Name": "title",
          Category: "category",
          Type: "category",
          Description: "description",
          Content: "content",
          Owner: "owner",
          "Effective Date": "effective_date",
          "Review Date": "next_review_date",
          Status: "status",
        },
      }),
    },
    {
      name: "Compliance Obligations Import",
      target_module: "compliance",
      description: "Import regulatory obligations and compliance requirements",
      field_mapping: JSON.stringify({
        required: ["regulation_id", "title", "priority"],
        optional: ["description", "due_date", "owner_name", "status"],
        mappings: {
          "Obligation ID": "obligation_code",
          "Requirement ID": "obligation_code",
          Obligation: "title",
          Requirement: "title",
          Title: "title",
          Regulation: "regulation_id",
          Framework: "regulation_id",
          Priority: "priority",
          Description: "description",
          "Due Date": "due_date",
          Deadline: "due_date",
          Owner: "owner_name",
          Status: "compliance_status",
        },
      }),
    },
    {
      name: "Vendor Registry Import",
      target_module: "vendors",
      description: "Import vendor/supplier data for risk assessment",
      field_mapping: JSON.stringify({
        required: ["vendor_code", "name", "category"],
        optional: [
          "criticality",
          "country",
          "contact_name",
          "contact_email",
          "services",
        ],
        mappings: {
          "Vendor ID": "vendor_code",
          "Vendor Code": "vendor_code",
          "Supplier ID": "vendor_code",
          "Vendor Name": "name",
          "Supplier Name": "name",
          Name: "name",
          Category: "category",
          Type: "category",
          Criticality: "criticality",
          Priority: "criticality",
          Country: "country",
          Location: "country",
          Contact: "primary_contact_name",
          "Contact Name": "primary_contact_name",
          Email: "primary_contact_email",
          Services: "services_provided",
        },
      }),
    },
    // ----------------------------------------------------------------------
    // Quality / Audit templates (added under WP-SOP-042, Admin & Tools expansion).
    // These mirror the columns most-often seen in exported CAPA / NC / Training
    // spreadsheets so the mapper can auto-match without human intervention.
    // ----------------------------------------------------------------------
    {
      name: "CAPA Register Import",
      target_module: "capa",
      description:
        "Import Corrective & Preventive Actions from existing CAPA logs (WP-SOP-009).",
      field_mapping: JSON.stringify({
        required: ["capa_code", "title", "root_cause", "due_date"],
        optional: [
          "description",
          "owner_email",
          "status",
          "severity",
          "related_finding_code",
        ],
        mappings: {
          "CAPA ID": "capa_code",
          "CAPA Code": "capa_code",
          "Action ID": "capa_code",
          Title: "title",
          "Action Title": "title",
          Description: "description",
          "Root Cause": "root_cause",
          RCA: "root_cause",
          "Corrective Action": "corrective_action",
          "Preventive Action": "preventive_action",
          Owner: "owner_email",
          Responsible: "owner_email",
          "Due Date": "due_date",
          "Target Date": "due_date",
          Status: "status",
          Severity: "severity",
          "Finding Ref": "related_finding_code",
          "Linked Finding": "related_finding_code",
        },
      }),
    },
    {
      name: "Nonconformity (NC) Log Import",
      target_module: "nonconformities",
      description:
        "Import historic nonconformities from paper / Excel logs (WP-SOP-009, ISO 9001 §10.2).",
      field_mapping: JSON.stringify({
        required: ["nc_code", "title", "severity", "detected_at"],
        optional: [
          "description",
          "source",
          "process",
          "reporter_email",
          "status",
        ],
        mappings: {
          "NC ID": "nc_code",
          "NC Code": "nc_code",
          Nonconformity: "title",
          Issue: "title",
          Title: "title",
          Description: "description",
          Severity: "severity",
          Classification: "severity",
          Source: "source",
          "Detected By": "reporter_email",
          "Reported By": "reporter_email",
          "Date Detected": "detected_at",
          "Detected At": "detected_at",
          Process: "process",
          Department: "process",
          Status: "status",
        },
      }),
    },
    {
      name: "Training Records Import",
      target_module: "training",
      description:
        "Import training & competency records for auditor qualification (ISO 19011:2018 §7).",
      field_mapping: JSON.stringify({
        required: ["employee_email", "training_name", "completed_at"],
        optional: [
          "provider",
          "hours",
          "certificate_ref",
          "expires_at",
          "role_scope",
        ],
        mappings: {
          "Employee Email": "employee_email",
          Email: "employee_email",
          Employee: "employee_email",
          Training: "training_name",
          Course: "training_name",
          "Course Title": "training_name",
          Provider: "provider",
          "Training Provider": "provider",
          Hours: "hours",
          Duration: "hours",
          Completed: "completed_at",
          "Completion Date": "completed_at",
          Date: "completed_at",
          Certificate: "certificate_ref",
          "Certificate #": "certificate_ref",
          Expires: "expires_at",
          Expiry: "expires_at",
          Role: "role_scope",
          Scope: "role_scope",
        },
      }),
    },
    {
      name: "Audit Findings Import",
      target_module: "audit_findings",
      description:
        "Import historical audit findings from past internal / external audits (WP-SOP-042).",
      field_mapping: JSON.stringify({
        required: ["finding_code", "title", "severity", "audit_reference"],
        optional: [
          "description",
          "category",
          "control_reference",
          "responsible_party",
          "status",
          "detected_at",
        ],
        mappings: {
          "Finding ID": "finding_code",
          "Finding Code": "finding_code",
          "NC Ref": "finding_code",
          Title: "title",
          Finding: "title",
          Description: "description",
          Details: "description",
          Severity: "severity",
          Classification: "severity",
          Category: "category",
          Type: "category",
          Clause: "control_reference",
          Control: "control_reference",
          Requirement: "control_reference",
          Responsible: "responsible_party",
          Owner: "responsible_party",
          Audit: "audit_reference",
          "Audit Ref": "audit_reference",
          "Audit Code": "audit_reference",
          Date: "detected_at",
          "Date Raised": "detected_at",
          Status: "status",
        },
      }),
    },
    {
      name: "Deal Evaluations Import",
      target_module: "deal_evaluations",
      description:
        "Import historical deal / sales evaluation scores for quality trend analysis.",
      field_mapping: JSON.stringify({
        required: ["deal_code", "evaluator_email", "evaluated_at", "score"],
        optional: ["deal_name", "agent_email", "layout", "stage", "notes"],
        mappings: {
          "Deal ID": "deal_code",
          "Deal Code": "deal_code",
          "Deal Name": "deal_name",
          Opportunity: "deal_name",
          Evaluator: "evaluator_email",
          Reviewer: "evaluator_email",
          Agent: "agent_email",
          "Sales Agent": "agent_email",
          Owner: "agent_email",
          Layout: "layout",
          Pipeline: "layout",
          Stage: "stage",
          "Deal Stage": "stage",
          Date: "evaluated_at",
          "Evaluated At": "evaluated_at",
          Score: "score",
          "Quality Score": "score",
          Notes: "notes",
          Comments: "notes",
        },
      }),
    },
  ];

  for (const template of templates) {
    await pool.query(
      "INSERT INTO migration_templates (name, target_module, description, field_mapping) VALUES ($1, $2, $3, $4)",
      [
        template.name,
        template.target_module,
        template.description,
        template.field_mapping,
      ],
    );
  }
}

async function seedDeduplicationRules(): Promise<void> {
  const existingRules = await pool.query(
    "SELECT COUNT(*) FROM deduplication_rules",
  );
  if (parseInt(existingRules.rows[0].count) > 0) return;

  logger.info("📝 [MigrationDB] Seeding deduplication rules...");
  
  const rules = [
    {
      target_module: "risks",
      rule_name: "Exact Risk Code Match",
      match_fields: ["risk_code"],
      threshold: 1.0,
      action: "skip",
    },
    {
      target_module: "risks",
      rule_name: "Similar Risk Title",
      match_fields: ["title", "category"],
      threshold: 0.85,
      action: "flag",
    },
    {
      target_module: "policies",
      rule_name: "Exact Policy Code Match",
      match_fields: ["policy_code"],
      threshold: 1.0,
      action: "skip",
    },
    {
      target_module: "policies",
      rule_name: "Similar Policy Title",
      match_fields: ["title"],
      threshold: 0.9,
      action: "flag",
    },
    {
      target_module: "vendors",
      rule_name: "Exact Vendor Code Match",
      match_fields: ["vendor_code"],
      threshold: 1.0,
      action: "skip",
    },
    {
      target_module: "vendors",
      rule_name: "Similar Vendor Name",
      match_fields: ["name"],
      threshold: 0.85,
      action: "flag",
    },
    {
      target_module: "compliance",
      rule_name: "Exact Obligation Match",
      match_fields: ["obligation_code"],
      threshold: 1.0,
      action: "skip",
    },
  ];

  for (const rule of rules) {
    await pool.query(
      "INSERT INTO deduplication_rules (target_module, rule_name, match_fields, threshold, action) VALUES ($1, $2, $3, $4, $5)",
      [
        rule.target_module,
        rule.rule_name,
        rule.match_fields,
        rule.threshold,
        rule.action,
      ],
    );
  }
}

export async function createMigrationJob(
  job: MigrationJob,
): Promise<MigrationJob> {
  logger.info("📝 [MigrationDB] Creating migration job:", job.name);

  const result = await pool.query(
    `
    INSERT INTO migration_jobs (
      job_code, name, description, source_type, target_module, status,
      file_name, file_path, field_mapping, validation_rules, created_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING *
  `,
    [
      job.job_code,
      job.name,
      job.description,
      job.source_type,
      job.target_module,
      job.status || "pending",
      job.file_name,
      job.file_path,
      job.field_mapping,
      job.validation_rules,
      job.created_by,
    ],
  );

  return result.rows[0];
}

export async function updateMigrationJob(
  id: number,
  updates: Partial<MigrationJob>,
): Promise<MigrationJob> {
  const setClause: string[] = [];
  const values: any[] = [];
  let paramCount = 1;

  const allowedFields = [
    "name",
    "description",
    "status",
    "total_records",
    "processed_records",
    "success_records",
    "failed_records",
    "duplicate_records",
    "error_log",
    "field_mapping",
    "completed_at",
  ];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key) && value !== undefined) {
      setClause.push(`${key} = $${paramCount}`);
      values.push(value);
      paramCount++;
    }
  }

  setClause.push("updated_at = NOW()");
  values.push(id);

  const result = await pool.query(
    `UPDATE migration_jobs SET ${setClause.join(", ")} WHERE id = $${paramCount} RETURNING *`,
    values,
  );
  return result.rows[0];
}

export async function getMigrationJobById(
  id: number,
): Promise<MigrationJob | null> {
  const result = await pool.query(
    "SELECT * FROM migration_jobs WHERE id = $1",
    [id],
  );
  return result.rows[0] || null;
}

export async function getAllMigrationJobs(filters?: {
  status?: string;
  target_module?: string;
}): Promise<{ jobs: MigrationJob[]; total: number }> {
  let query = "SELECT * FROM migration_jobs WHERE 1=1";
  const values: any[] = [];
  let paramCount = 1;

  if (filters?.status) {
    query += ` AND status = $${paramCount}`;
    values.push(filters.status);
    paramCount++;
  }
  if (filters?.target_module) {
    query += ` AND target_module = $${paramCount}`;
    values.push(filters.target_module);
    paramCount++;
  }

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM migration_jobs WHERE 1=1` +
      query.replace("SELECT * FROM migration_jobs WHERE 1=1", ""),
    values,
  );

  query += " ORDER BY created_at DESC";
  const result = await pool.query(query, values);
  
  return { jobs: result.rows, total: parseInt(countResult.rows[0].count) };
}

export async function getTemplates(
  targetModule?: string,
): Promise<MigrationTemplate[]> {
  let query = "SELECT * FROM migration_templates WHERE is_active = true";
  const values: any[] = [];
  
  if (targetModule) {
    query += " AND target_module = $1";
    values.push(targetModule);
  }
  
  query += " ORDER BY target_module, name";
  const result = await pool.query(query, values);
  return result.rows;
}

export async function getDeduplicationRules(
  targetModule?: string,
): Promise<DeduplicationRule[]> {
  let query = "SELECT * FROM deduplication_rules WHERE is_active = true";
  const values: any[] = [];
  
  if (targetModule) {
    query += " AND target_module = $1";
    values.push(targetModule);
  }
  
  query += " ORDER BY target_module, rule_name";
  const result = await pool.query(query, values);
  return result.rows;
}

export async function getMigrationSummary(): Promise<any> {
  logger.info("📊 [MigrationDB] Generating migration summary...");

  const jobStats = await pool.query(`
    SELECT 
      COUNT(*) as total_jobs,
      COUNT(*) FILTER (WHERE status = 'pending') as pending,
      COUNT(*) FILTER (WHERE status IN ('validating', 'mapping', 'importing')) as in_progress,
      COUNT(*) FILTER (WHERE status = 'completed') as completed,
      COUNT(*) FILTER (WHERE status = 'failed') as failed,
      COALESCE(SUM(total_records), 0) as total_records,
      COALESCE(SUM(success_records), 0) as imported_records,
      COALESCE(SUM(duplicate_records), 0) as duplicate_records
    FROM migration_jobs
  `);

  const byModule = await pool.query(`
    SELECT target_module, COUNT(*) as count, COALESCE(SUM(success_records), 0) as records_imported
    FROM migration_jobs
    GROUP BY target_module
    ORDER BY count DESC
  `);

  const recentJobs = await pool.query(`
    SELECT id, job_code, name, target_module, status, total_records, success_records, created_at
    FROM migration_jobs
    ORDER BY created_at DESC
    LIMIT 5
  `);

  const templateCount = await pool.query(
    "SELECT COUNT(*) FROM migration_templates WHERE is_active = true",
  );
  const ruleCount = await pool.query(
    "SELECT COUNT(*) FROM deduplication_rules WHERE is_active = true",
  );

  return {
    jobs: jobStats.rows[0],
    by_module: byModule.rows,
    recent_jobs: recentJobs.rows,
    templates_count: parseInt(templateCount.rows[0].count),
    dedup_rules_count: parseInt(ruleCount.rows[0].count),
  };
}
