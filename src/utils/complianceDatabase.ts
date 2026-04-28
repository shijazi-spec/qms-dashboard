import { createRedactedPool } from "./redactedPool";
import { logger } from "./logger";

const pool = createRedactedPool({
  connectionString: process.env.DATABASE_URL,
});

export interface Regulation {
  id?: number;
  regulation_code: string;
  name: string;
  description?: string;
  jurisdiction: "saudi" | "gcc" | "international" | "internal";
  category:
    | "data_privacy"
    | "cybersecurity"
    | "financial"
    | "quality"
    | "environmental"
    | "labor"
    | "industry_specific";
  issuing_body?: string;
  effective_date?: Date;
  last_updated?: Date;
  status: "active" | "pending" | "superseded" | "retired";
  version?: string;
  source_url?: string;
  created_at?: Date;
  updated_at?: Date;
}

export interface Obligation {
  id?: number;
  obligation_code: string;
  regulation_id: number;
  article_reference?: string;
  title: string;
  description: string;
  section_domain?: string;
  section_order?: number;
  clause_number?: string;
  requirement_type: "mandatory" | "recommended" | "optional";
  control_type: "preventive" | "detective" | "corrective";
  applicability_criteria?: string;
  compliance_frequency:
    | "continuous"
    | "daily"
    | "weekly"
    | "monthly"
    | "quarterly"
    | "annual"
    | "event_driven";
  evidence_requirements?: string;
  penalty_for_noncompliance?: string;
  linked_control_ids?: number[];
  linked_policy_ids?: number[];
  linked_risk_ids?: number[];
  responsible_department?: string;
  responsible_role?: string;
  status: "applicable" | "not_applicable" | "pending_review" | "exempt";
  exemption_reason?: string;
  exemption_expiry?: Date;
  priority: "critical" | "high" | "medium" | "low";
  created_at?: Date;
  updated_at?: Date;
}

export interface ComplianceAssessment {
  id?: number;
  obligation_id: number;
  assessment_date: Date;
  assessed_by: string;
  compliance_status:
    | "compliant"
    | "partially_compliant"
    | "non_compliant"
    | "not_assessed";
  score?: number;
  evidence_provided?: string;
  evidence_files?: string[];
  gaps_identified?: string;
  remediation_required?: boolean;
  remediation_deadline?: Date;
  remediation_owner?: string;
  remediation_status?: "not_started" | "in_progress" | "completed" | "overdue";
  comments?: string;
  next_assessment_date?: Date;
  created_at?: Date;
  updated_at?: Date;
}

export interface ComplianceCalendar {
  id?: number;
  obligation_id: number;
  event_type: "assessment" | "reporting" | "renewal" | "audit" | "training";
  scheduled_date: Date;
  completed_date?: Date;
  responsible_party?: string;
  status: "scheduled" | "in_progress" | "completed" | "missed";
  reminder_sent?: boolean;
  notes?: string;
  created_at?: Date;
}

export async function initComplianceTables(): Promise<void> {
  logger.info("📋 [ComplianceDB] Initializing compliance tables...");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS regulations (
      id SERIAL PRIMARY KEY,
      regulation_code VARCHAR(50) UNIQUE NOT NULL,
      name VARCHAR(500) NOT NULL,
      description TEXT,
      jurisdiction VARCHAR(50) NOT NULL,
      category VARCHAR(50) NOT NULL,
      issuing_body VARCHAR(255),
      effective_date TIMESTAMP,
      last_updated TIMESTAMP,
      status VARCHAR(20) DEFAULT 'active',
      version VARCHAR(50),
      source_url TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS obligations (
      id SERIAL PRIMARY KEY,
      obligation_code VARCHAR(50) UNIQUE NOT NULL,
      regulation_id INTEGER REFERENCES regulations(id) ON DELETE CASCADE,
      article_reference VARCHAR(100),
      title VARCHAR(500) NOT NULL,
      description TEXT NOT NULL,
      requirement_type VARCHAR(20) DEFAULT 'mandatory',
      control_type VARCHAR(20) DEFAULT 'preventive',
      applicability_criteria TEXT,
      compliance_frequency VARCHAR(30) DEFAULT 'annual',
      evidence_requirements TEXT,
      penalty_for_noncompliance TEXT,
      linked_control_ids INTEGER[],
      linked_policy_ids INTEGER[],
      linked_risk_ids INTEGER[],
      responsible_department VARCHAR(100),
      responsible_role VARCHAR(100),
      status VARCHAR(30) DEFAULT 'applicable',
      exemption_reason TEXT,
      exemption_expiry TIMESTAMP,
      priority VARCHAR(20) DEFAULT 'medium',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS compliance_assessments (
      id SERIAL PRIMARY KEY,
      obligation_id INTEGER REFERENCES obligations(id) ON DELETE CASCADE,
      assessment_date TIMESTAMP NOT NULL,
      assessed_by VARCHAR(255) NOT NULL,
      compliance_status VARCHAR(30) NOT NULL,
      score INTEGER,
      evidence_provided TEXT,
      evidence_files TEXT[],
      gaps_identified TEXT,
      remediation_required BOOLEAN DEFAULT FALSE,
      remediation_deadline TIMESTAMP,
      remediation_owner VARCHAR(255),
      remediation_status VARCHAR(20),
      comments TEXT,
      next_assessment_date TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS compliance_calendar (
      id SERIAL PRIMARY KEY,
      obligation_id INTEGER REFERENCES obligations(id) ON DELETE CASCADE,
      event_type VARCHAR(30) NOT NULL,
      scheduled_date TIMESTAMP NOT NULL,
      completed_date TIMESTAMP,
      responsible_party VARCHAR(255),
      status VARCHAR(20) DEFAULT 'scheduled',
      reminder_sent BOOLEAN DEFAULT FALSE,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(
    `ALTER TABLE regulations ADD COLUMN IF NOT EXISTS public_id UUID DEFAULT gen_random_uuid()`,
  );
  await pool.query(
    `ALTER TABLE obligations ADD COLUMN IF NOT EXISTS public_id UUID DEFAULT gen_random_uuid()`,
  );
  await pool.query(
    `ALTER TABLE compliance_assessments ADD COLUMN IF NOT EXISTS public_id UUID DEFAULT gen_random_uuid()`,
  );
  await pool.query(
    `UPDATE regulations SET public_id = gen_random_uuid() WHERE public_id IS NULL`,
  );
  await pool.query(
    `UPDATE obligations SET public_id = gen_random_uuid() WHERE public_id IS NULL`,
  );
  await pool.query(
    `UPDATE compliance_assessments SET public_id = gen_random_uuid() WHERE public_id IS NULL`,
  );
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_regulations_public_id ON regulations(public_id)`,
  );
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_obligations_public_id ON obligations(public_id)`,
  );
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_compliance_assessments_public_id ON compliance_assessments(public_id)`,
  );

  await pool.query(
    `ALTER TABLE obligations ADD COLUMN IF NOT EXISTS section_domain VARCHAR(100)`,
  );
  await pool.query(
    `ALTER TABLE obligations ADD COLUMN IF NOT EXISTS section_order INTEGER`,
  );
  await pool.query(
    `ALTER TABLE obligations ADD COLUMN IF NOT EXISTS clause_number VARCHAR(50)`,
  );

  await seedDefaultRegulations();
  await seedPDPLObligations();
  await seedSAMAObligations();
  logger.info("✅ [ComplianceDB] Compliance tables initialized");
}

async function seedDefaultRegulations(): Promise<void> {
  // Idempotent seed: walk the canonical list every boot and rely on
  // `ON CONFLICT (regulation_code) DO NOTHING` to skip rows that already
  // exist. The previous early-return guard meant new entries (e.g. PCI DSS)
  // would never reach a database that had been seeded before, so any
  // additions had to be applied by hand. Walking the list is cheap (single
  // INSERT per row, all conflicts are no-ops) and keeps the canonical set
  // in sync with what's defined here.
  logger.info("🌱 [ComplianceDB] Reconciling default regulations (idempotent upsert)...");

  const saudiRegulations = [
    {
      regulation_code: "PDPL",
      name: "Saudi Personal Data Protection Law",
      description:
        "Comprehensive data protection regulation governing collection, processing, and storage of personal data in Saudi Arabia",
      jurisdiction: "saudi",
      category: "data_privacy",
      issuing_body: "SDAIA (Saudi Data & AI Authority)",
      effective_date: "2023-09-14",
      status: "active",
      version: "2023",
    },
    {
      regulation_code: "SAMA-CSF",
      name: "SAMA Cyber Security Framework",
      description:
        "Mandatory cyber security framework issued by the Saudi Central Bank (SAMA) for all member organisations — banks, insurance companies, financing companies, and payment service providers. Spans four domains: leadership & governance, risk management & compliance, operations & technology, and third-party cyber security.",
      jurisdiction: "saudi",
      category: "financial",
      issuing_body: "Saudi Central Bank (SAMA)",
      effective_date: "2017-05-01",
      status: "active",
      version: "1.0",
    },
    {
      regulation_code: "NCA-ECC",
      name: "NCA Essential Cybersecurity Controls",
      description:
        "Cybersecurity framework mandated by National Cybersecurity Authority for all organizations in Saudi Arabia",
      jurisdiction: "saudi",
      category: "cybersecurity",
      issuing_body: "National Cybersecurity Authority (NCA)",
      effective_date: "2018-05-01",
      status: "active",
      version: "2.0",
    },
    {
      regulation_code: "NCA-DCC",
      name: "NCA Data Cybersecurity Controls",
      description:
        "Data-specific cybersecurity controls for protecting organizational and personal data",
      jurisdiction: "saudi",
      category: "cybersecurity",
      issuing_body: "National Cybersecurity Authority (NCA)",
      effective_date: "2022-01-01",
      status: "active",
      version: "1.0",
    },
    {
      regulation_code: "ISO-9001",
      name: "ISO 9001:2015 Quality Management",
      description: "International standard for quality management systems",
      jurisdiction: "international",
      category: "quality",
      issuing_body: "International Organization for Standardization",
      effective_date: "2015-09-15",
      status: "active",
      version: "2015",
    },
    {
      regulation_code: "ISO-27001",
      name: "ISO 27001:2022 Information Security",
      description:
        "International standard for information security management systems",
      jurisdiction: "international",
      category: "cybersecurity",
      issuing_body: "International Organization for Standardization",
      effective_date: "2022-10-25",
      status: "active",
      version: "2022",
    },
    {
      regulation_code: "COPC",
      name: "COPC Customer Experience Standard",
      description:
        "Performance management framework for customer experience operations",
      jurisdiction: "international",
      category: "quality",
      issuing_body: "COPC Inc.",
      effective_date: "2020-01-01",
      status: "active",
      version: "7.0",
    },
    {
      regulation_code: "PCI-DSS",
      name: "PCI DSS v4.0 Payment Card Industry Data Security Standard",
      description:
        "Mandatory security baseline for any organisation that stores, processes, or transmits cardholder data — covers network segmentation, encryption-in-transit, access control, vulnerability management, and continuous monitoring.",
      jurisdiction: "international",
      category: "cybersecurity",
      issuing_body: "PCI Security Standards Council",
      effective_date: "2024-04-01",
      status: "active",
      version: "4.0",
    },
  ];

  for (const reg of saudiRegulations) {
    await pool.query(
      `
      INSERT INTO regulations (regulation_code, name, description, jurisdiction, category, issuing_body, effective_date, status, version)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (regulation_code) DO NOTHING
    `,
      [
        reg.regulation_code,
        reg.name,
        reg.description,
        reg.jurisdiction,
        reg.category,
        reg.issuing_body,
        reg.effective_date,
        reg.status,
        reg.version,
      ],
    );
  }

  logger.info("✅ [ComplianceDB] Default regulations seeded");
}

export async function createRegulation(reg: Regulation): Promise<Regulation> {
  logger.info("📝 [ComplianceDB] Creating regulation:", reg.name);

  const result = await pool.query(
    `
    INSERT INTO regulations (regulation_code, name, description, jurisdiction, category, issuing_body, effective_date, last_updated, status, version, source_url)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING *
  `,
    [
      reg.regulation_code,
      reg.name,
      reg.description,
      reg.jurisdiction,
      reg.category,
      reg.issuing_body,
      reg.effective_date,
      reg.last_updated,
      reg.status || "active",
      reg.version,
      reg.source_url,
    ],
  );

  return result.rows[0];
}

export async function getAllRegulations(filters?: {
  status?: string;
  jurisdiction?: string;
  category?: string;
}): Promise<Regulation[]> {
  let query = "SELECT * FROM regulations WHERE 1=1";
  const values: any[] = [];
  let paramCount = 1;

  if (filters?.status) {
    query += ` AND status = $${paramCount}`;
    values.push(filters.status);
    paramCount++;
  }
  if (filters?.jurisdiction) {
    query += ` AND jurisdiction = $${paramCount}`;
    values.push(filters.jurisdiction);
    paramCount++;
  }
  if (filters?.category) {
    query += ` AND category = $${paramCount}`;
    values.push(filters.category);
    paramCount++;
  }

  query += " ORDER BY name ASC";
  const result = await pool.query(query, values);
  return result.rows;
}

export async function getRegulationById(
  id: number,
): Promise<Regulation | null> {
  const result = await pool.query("SELECT * FROM regulations WHERE id = $1", [
    id,
  ]);
  return result.rows[0] || null;
}

export async function createObligation(obl: Obligation): Promise<Obligation> {
  logger.info("📝 [ComplianceDB] Creating obligation:", obl.title);

  const result = await pool.query(
    `
    INSERT INTO obligations (
      obligation_code, regulation_id, article_reference, title, description,
      requirement_type, control_type, applicability_criteria, compliance_frequency,
      evidence_requirements, penalty_for_noncompliance,
      linked_control_ids, linked_policy_ids, linked_risk_ids,
      responsible_department, responsible_role, status, priority
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
    RETURNING *
  `,
    [
      obl.obligation_code,
      obl.regulation_id,
      obl.article_reference,
      obl.title,
      obl.description,
      obl.requirement_type || "mandatory",
      obl.control_type || "preventive",
      obl.applicability_criteria,
      obl.compliance_frequency || "annual",
      obl.evidence_requirements,
      obl.penalty_for_noncompliance,
      obl.linked_control_ids,
      obl.linked_policy_ids,
      obl.linked_risk_ids,
      obl.responsible_department,
      obl.responsible_role,
      obl.status || "applicable",
      obl.priority || "medium",
    ],
  );

  return result.rows[0];
}

export async function getObligationsByRegulation(
  regulationId: number,
): Promise<Obligation[]> {
  const result = await pool.query(
    "SELECT * FROM obligations WHERE regulation_id = $1 ORDER BY section_order ASC NULLS LAST, obligation_code ASC",
    [regulationId],
  );
  return result.rows;
}

export async function getAllObligations(filters?: {
  status?: string;
  priority?: string;
  department?: string;
  regulation_id?: number;
}): Promise<{ obligations: Obligation[]; total: number }> {
  let query =
    "SELECT o.*, r.name as regulation_name, r.regulation_code FROM obligations o LEFT JOIN regulations r ON o.regulation_id = r.id WHERE 1=1";
  const values: any[] = [];
  let paramCount = 1;

  if (filters?.status) {
    query += ` AND o.status = $${paramCount}`;
    values.push(filters.status);
    paramCount++;
  }
  if (filters?.priority) {
    query += ` AND o.priority = $${paramCount}`;
    values.push(filters.priority);
    paramCount++;
  }
  if (filters?.department) {
    query += ` AND o.responsible_department = $${paramCount}`;
    values.push(filters.department);
    paramCount++;
  }
  if (filters?.regulation_id) {
    query += ` AND o.regulation_id = $${paramCount}`;
    values.push(filters.regulation_id);
    paramCount++;
  }

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM (${query.replace("o.*, r.name as regulation_name, r.regulation_code", "1")}) as count_query`,
    values,
  );

  query += " ORDER BY o.priority DESC, o.title ASC";
  const result = await pool.query(query, values);

  return {
    obligations: result.rows,
    total: parseInt(countResult.rows[0].count),
  };
}

export async function getObligationById(
  id: number,
): Promise<Obligation | null> {
  const result = await pool.query(
    `
    SELECT o.*, r.name as regulation_name, r.regulation_code 
    FROM obligations o 
    LEFT JOIN regulations r ON o.regulation_id = r.id 
    WHERE o.id = $1
  `,
    [id],
  );
  return result.rows[0] || null;
}

export async function updateObligation(
  id: number,
  updates: Partial<Obligation>,
): Promise<Obligation> {
  const setClause: string[] = [];
  const values: any[] = [];
  let paramCount = 1;

  const allowedFields = [
    "title",
    "description",
    "requirement_type",
    "control_type",
    "applicability_criteria",
    "compliance_frequency",
    "evidence_requirements",
    "penalty_for_noncompliance",
    "responsible_department",
    "responsible_role",
    "status",
    "priority",
    "exemption_reason",
    "exemption_expiry",
    "linked_control_ids",
    "linked_policy_ids",
    "linked_risk_ids",
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
    `UPDATE obligations SET ${setClause.join(", ")} WHERE id = $${paramCount} RETURNING *`,
    values,
  );
  return result.rows[0];
}

export async function createAssessment(
  assessment: ComplianceAssessment,
): Promise<ComplianceAssessment> {
  logger.info(
    "📝 [ComplianceDB] Creating compliance assessment for obligation:",
    assessment.obligation_id,
  );

  const result = await pool.query(
    `
    INSERT INTO compliance_assessments (
      obligation_id, assessment_date, assessed_by, compliance_status, score,
      evidence_provided, evidence_files, gaps_identified,
      remediation_required, remediation_deadline, remediation_owner, remediation_status,
      comments, next_assessment_date
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    RETURNING *
  `,
    [
      assessment.obligation_id,
      assessment.assessment_date || new Date(),
      assessment.assessed_by,
      assessment.compliance_status,
      assessment.score,
      assessment.evidence_provided,
      assessment.evidence_files,
      assessment.gaps_identified,
      assessment.remediation_required || false,
      assessment.remediation_deadline,
      assessment.remediation_owner,
      assessment.remediation_status,
      assessment.comments,
      assessment.next_assessment_date,
    ],
  );

  return result.rows[0];
}

export async function getAssessmentHistory(
  obligationId: number,
): Promise<ComplianceAssessment[]> {
  const result = await pool.query(
    "SELECT * FROM compliance_assessments WHERE obligation_id = $1 ORDER BY assessment_date DESC",
    [obligationId],
  );
  return result.rows;
}

export async function getLatestAssessments(): Promise<any[]> {
  const result = await pool.query(`
    SELECT DISTINCT ON (ca.obligation_id) 
      ca.*, o.title as obligation_title, o.obligation_code, r.name as regulation_name
    FROM compliance_assessments ca
    JOIN obligations o ON ca.obligation_id = o.id
    JOIN regulations r ON o.regulation_id = r.id
    ORDER BY ca.obligation_id, ca.assessment_date DESC
  `);
  return result.rows;
}

export async function getComplianceSummary(): Promise<any> {
  logger.info("📊 [ComplianceDB] Generating compliance summary...");

  const regulationsCount = await pool.query(
    "SELECT COUNT(*) FROM regulations WHERE status = $1",
    ["active"],
  );
  const obligationsCount = await pool.query("SELECT COUNT(*) FROM obligations");

  const byStatus = await pool.query(`
    SELECT 
      COUNT(*) FILTER (WHERE compliance_status = 'compliant') as compliant,
      COUNT(*) FILTER (WHERE compliance_status = 'partially_compliant') as partially_compliant,
      COUNT(*) FILTER (WHERE compliance_status = 'non_compliant') as non_compliant,
      COUNT(*) FILTER (WHERE compliance_status = 'not_assessed') as not_assessed
    FROM (
      SELECT DISTINCT ON (obligation_id) compliance_status
      FROM compliance_assessments
      ORDER BY obligation_id, assessment_date DESC
    ) as latest
  `);

  const byPriority = await pool.query(`
    SELECT priority, COUNT(*) as count
    FROM obligations
    WHERE status = 'applicable'
    GROUP BY priority
  `);

  const byRegulation = await pool.query(`
    SELECT r.name, r.regulation_code, COUNT(o.id) as obligation_count
    FROM regulations r
    LEFT JOIN obligations o ON r.id = o.regulation_id
    WHERE r.status = 'active'
    GROUP BY r.id, r.name, r.regulation_code
    ORDER BY obligation_count DESC
  `);

  const remediationsPending = await pool.query(`
    SELECT COUNT(*) FROM compliance_assessments
    WHERE remediation_required = true AND remediation_status IN ('not_started', 'in_progress')
  `);

  const overdueRemediations = await pool.query(`
    SELECT COUNT(*) FROM compliance_assessments
    WHERE remediation_required = true 
    AND remediation_deadline < NOW() 
    AND remediation_status != 'completed'
  `);

  const complianceScore = await calculateOverallComplianceScore();

  return {
    active_regulations: parseInt(regulationsCount.rows[0].count),
    total_obligations: parseInt(obligationsCount.rows[0].count),
    compliance_breakdown: byStatus.rows[0],
    by_priority: byPriority.rows,
    by_regulation: byRegulation.rows,
    pending_remediations: parseInt(remediationsPending.rows[0].count),
    overdue_remediations: parseInt(overdueRemediations.rows[0].count),
    overall_compliance_score: complianceScore,
  };
}

async function calculateOverallComplianceScore(): Promise<number> {
  const result = await pool.query(`
    SELECT 
      SUM(CASE 
        WHEN compliance_status = 'compliant' THEN 100
        WHEN compliance_status = 'partially_compliant' THEN 50
        WHEN compliance_status = 'non_compliant' THEN 0
        ELSE 0
      END) as total_score,
      COUNT(*) as count
    FROM (
      SELECT DISTINCT ON (obligation_id) compliance_status
      FROM compliance_assessments
      ORDER BY obligation_id, assessment_date DESC
    ) as latest
    WHERE compliance_status != 'not_assessed'
  `);

  if (parseInt(result.rows[0].count) === 0) return 0;
  return Math.round(
    parseInt(result.rows[0].total_score) / parseInt(result.rows[0].count),
  );
}

export async function getComplianceCalendar(filters?: {
  month?: number;
  year?: number;
  status?: string;
}): Promise<ComplianceCalendar[]> {
  let query = `
    SELECT cc.*, o.title as obligation_title, o.obligation_code
    FROM compliance_calendar cc
    JOIN obligations o ON cc.obligation_id = o.id
    WHERE 1=1
  `;
  const values: any[] = [];
  let paramCount = 1;

  if (filters?.month && filters?.year) {
    query += ` AND EXTRACT(MONTH FROM cc.scheduled_date) = $${paramCount} AND EXTRACT(YEAR FROM cc.scheduled_date) = $${paramCount + 1}`;
    values.push(filters.month, filters.year);
    paramCount += 2;
  }

  if (filters?.status) {
    query += ` AND cc.status = $${paramCount}`;
    values.push(filters.status);
    paramCount++;
  }

  query += " ORDER BY cc.scheduled_date ASC";
  const result = await pool.query(query, values);
  return result.rows;
}

export async function createCalendarEvent(
  event: ComplianceCalendar,
): Promise<ComplianceCalendar> {
  const result = await pool.query(
    `
    INSERT INTO compliance_calendar (obligation_id, event_type, scheduled_date, responsible_party, status, notes)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `,
    [
      event.obligation_id,
      event.event_type,
      event.scheduled_date,
      event.responsible_party,
      event.status || "scheduled",
      event.notes,
    ],
  );
  return result.rows[0];
}

export async function getUpcomingDeadlines(days: number = 30): Promise<any[]> {
  const safeDays = Math.max(1, Math.min(365, Math.floor(Number(days) || 30)));
  const result = await pool.query(
    `
    SELECT cc.*, o.title as obligation_title, o.obligation_code, r.name as regulation_name
    FROM compliance_calendar cc
    JOIN obligations o ON cc.obligation_id = o.id
    JOIN regulations r ON o.regulation_id = r.id
    WHERE cc.status IN ('scheduled', 'in_progress')
    AND cc.scheduled_date BETWEEN NOW() AND NOW() + make_interval(days => $1)
    ORDER BY cc.scheduled_date ASC
    LIMIT 20
  `,
    [safeDays],
  );
  return result.rows;
}

export async function getOverdueEvents(): Promise<any[]> {
  const result = await pool.query(`
    SELECT cc.*, o.title as obligation_title, o.obligation_code, r.name as regulation_name
    FROM compliance_calendar cc
    JOIN obligations o ON cc.obligation_id = o.id
    JOIN regulations r ON o.regulation_id = r.id
    WHERE cc.status IN ('scheduled', 'in_progress')
    AND cc.scheduled_date < NOW()
    ORDER BY cc.scheduled_date ASC
  `);
  return result.rows;
}

async function seedPDPLObligations(): Promise<void> {
  const existing = await pool.query(
    "SELECT COUNT(*) FROM obligations WHERE obligation_code LIKE 'PDPL-%'",
  );
  if (parseInt(existing.rows[0].count) > 0) return;

  const pdplReg = await pool.query(
    "SELECT id FROM regulations WHERE regulation_code = 'PDPL'",
  );
  if (pdplReg.rows.length === 0) return;
  const regId = pdplReg.rows[0].id;

  logger.info("🌱 [ComplianceDB] Seeding PDPL obligations...");

  const pdplObligations = [
    {
      code: "PDPL-01",
      clause: "Art 5",
      domain: "Lawful Basis",
      order: 1,
      title: "Lawful Basis for Processing",
      desc: "Ensure all personal data processing has a valid lawful basis (consent, contractual necessity, legitimate interest, legal obligation, vital interest, or public interest)",
      type: "mandatory",
      ctrl: "preventive",
      freq: "continuous",
      priority: "critical",
      dept: "Legal",
    },
    {
      code: "PDPL-02",
      clause: "Art 6",
      domain: "Lawful Basis",
      order: 2,
      title: "Consent Requirements",
      desc: "Obtain explicit, informed, and freely given consent for processing personal data where consent is the lawful basis",
      type: "mandatory",
      ctrl: "preventive",
      freq: "continuous",
      priority: "critical",
      dept: "All Departments",
    },
    {
      code: "PDPL-03",
      clause: "Art 7",
      domain: "Data Subject Rights",
      order: 3,
      title: "Right to Be Informed",
      desc: "Inform data subjects about the purpose, legal basis, data categories, recipients, retention period, and their rights before or at the time of collection",
      type: "mandatory",
      ctrl: "preventive",
      freq: "continuous",
      priority: "high",
      dept: "Privacy Office",
    },
    {
      code: "PDPL-04",
      clause: "Art 8",
      domain: "Data Subject Rights",
      order: 4,
      title: "Right of Access",
      desc: "Provide data subjects with access to their personal data upon request within 30 days",
      type: "mandatory",
      ctrl: "detective",
      freq: "event_driven",
      priority: "high",
      dept: "Privacy Office",
    },
    {
      code: "PDPL-05",
      clause: "Art 9",
      domain: "Data Subject Rights",
      order: 5,
      title: "Right to Rectification",
      desc: "Allow data subjects to request correction or completion of inaccurate or incomplete personal data",
      type: "mandatory",
      ctrl: "corrective",
      freq: "event_driven",
      priority: "high",
      dept: "Privacy Office",
    },
    {
      code: "PDPL-06",
      clause: "Art 10",
      domain: "Data Subject Rights",
      order: 6,
      title: "Right to Erasure",
      desc: "Delete personal data when it is no longer necessary, consent is withdrawn, or processing is unlawful",
      type: "mandatory",
      ctrl: "corrective",
      freq: "event_driven",
      priority: "high",
      dept: "IT / Privacy Office",
    },
    {
      code: "PDPL-07",
      clause: "Art 14",
      domain: "Data Protection",
      order: 7,
      title: "Data Minimisation",
      desc: "Collect and process only personal data that is adequate, relevant, and limited to the stated purpose",
      type: "mandatory",
      ctrl: "preventive",
      freq: "continuous",
      priority: "high",
      dept: "All Departments",
    },
    {
      code: "PDPL-08",
      clause: "Art 15",
      domain: "Data Protection",
      order: 8,
      title: "Purpose Limitation",
      desc: "Process personal data only for the specific, explicit, and legitimate purposes stated at the time of collection",
      type: "mandatory",
      ctrl: "preventive",
      freq: "continuous",
      priority: "critical",
      dept: "All Departments",
    },
    {
      code: "PDPL-09",
      clause: "Art 16",
      domain: "Data Protection",
      order: 9,
      title: "Storage Limitation",
      desc: "Retain personal data only for as long as necessary to fulfil the purposes for which it was collected",
      type: "mandatory",
      ctrl: "detective",
      freq: "quarterly",
      priority: "medium",
      dept: "IT / Records",
    },
    {
      code: "PDPL-10",
      clause: "Art 17",
      domain: "Security",
      order: 10,
      title: "Technical & Organisational Measures",
      desc: "Implement appropriate technical and organisational measures to protect personal data against unauthorised access, disclosure, alteration, or destruction",
      type: "mandatory",
      ctrl: "preventive",
      freq: "continuous",
      priority: "critical",
      dept: "IT Security",
    },
    {
      code: "PDPL-11",
      clause: "Art 19",
      domain: "Breach Management",
      order: 11,
      title: "Data Breach Notification",
      desc: "Notify SDAIA and affected data subjects of personal data breaches within 72 hours of discovery",
      type: "mandatory",
      ctrl: "corrective",
      freq: "event_driven",
      priority: "critical",
      dept: "Privacy Office / CISO",
    },
    {
      code: "PDPL-12",
      clause: "Art 22",
      domain: "Cross-Border",
      order: 12,
      title: "Cross-Border Transfer Controls",
      desc: "Ensure personal data transfers outside Saudi Arabia comply with SDAIA-approved adequacy decisions or contractual safeguards",
      type: "mandatory",
      ctrl: "preventive",
      freq: "event_driven",
      priority: "critical",
      dept: "Legal / IT",
    },
    {
      code: "PDPL-13",
      clause: "Art 30",
      domain: "Governance",
      order: 13,
      title: "Data Protection Impact Assessment",
      desc: "Conduct DPIA for high-risk processing activities before commencement and maintain records",
      type: "mandatory",
      ctrl: "preventive",
      freq: "event_driven",
      priority: "high",
      dept: "Privacy Office",
    },
    {
      code: "PDPL-14",
      clause: "Art 31",
      domain: "Governance",
      order: 14,
      title: "Records of Processing Activities",
      desc: "Maintain comprehensive, up-to-date records of all personal data processing activities (ROPA)",
      type: "mandatory",
      ctrl: "detective",
      freq: "quarterly",
      priority: "high",
      dept: "Privacy Office",
    },
    {
      code: "PDPL-15",
      clause: "Art 32",
      domain: "Governance",
      order: 15,
      title: "Data Protection Officer",
      desc: "Appoint a qualified Data Protection Officer and ensure independence, resources, and direct reporting to senior management",
      type: "mandatory",
      ctrl: "preventive",
      freq: "annual",
      priority: "high",
      dept: "Executive Management",
    },
    {
      code: "PDPL-16",
      clause: "Art 11",
      domain: "Sensitive Data",
      order: 16,
      title: "Sensitive Data Processing",
      desc: "Apply enhanced safeguards for processing sensitive personal data (health, biometric, genetic, religious, criminal, financial)",
      type: "mandatory",
      ctrl: "preventive",
      freq: "continuous",
      priority: "critical",
      dept: "Privacy Office / Legal",
    },
    {
      code: "PDPL-17",
      clause: "Art 20",
      domain: "Third Parties",
      order: 17,
      title: "Processor Agreements",
      desc: "Establish binding agreements with data processors specifying processing scope, security measures, breach notification, and audit rights",
      type: "mandatory",
      ctrl: "preventive",
      freq: "annual",
      priority: "high",
      dept: "Procurement / Legal",
    },
    {
      code: "PDPL-18",
      clause: "Art 33",
      domain: "Governance",
      order: 18,
      title: "Awareness & Training",
      desc: "Provide regular data protection awareness and training programmes to all employees handling personal data",
      type: "recommended",
      ctrl: "preventive",
      freq: "annual",
      priority: "medium",
      dept: "HR / Privacy Office",
    },
  ];

  for (const ob of pdplObligations) {
    await pool.query(
      `
      INSERT INTO obligations (obligation_code, regulation_id, article_reference, title, description, section_domain, section_order, clause_number, requirement_type, control_type, compliance_frequency, priority, responsible_department, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'applicable')
      ON CONFLICT (obligation_code) DO NOTHING
    `,
      [
        ob.code,
        regId,
        ob.clause,
        ob.title,
        ob.desc,
        ob.domain,
        ob.order,
        ob.clause,
        ob.type,
        ob.ctrl,
        ob.freq,
        ob.priority,
        ob.dept,
      ],
    );
  }

  logger.info(
    "✅ [ComplianceDB] PDPL obligations seeded (" +
      pdplObligations.length +
      " items)",
  );
}

/**
 * SAMA Cyber Security Framework (CSF) v1.0 — Phase 1 seed.
 *
 * Covers 20 high-priority controls across the 4 CSF domains. The full
 * framework has ~118 sub-controls; this seed selects the controls that
 * (a) auditors always check first, (b) cross-map cleanly to NCA-ECC and
 * ISO 27001, and (c) are achievable by most WalaPlus customers without
 * specialist hardware.
 *
 * Source: SAMA CSF (May 2017, public release). Descriptions are
 * paraphrased summaries — not verbatim reg text — suitable for dashboard
 * display and review workflows. Compliance officers can edit any row via
 * the standard obligations UI without breaking the seed (ON CONFLICT
 * DO NOTHING keeps the seed idempotent on re-boot).
 *
 * Exported so that tests can validate structural invariants (unique codes,
 * four domains covered, required fields present) without a live database.
 */
export interface SamaObligationDef {
  code: string;
  clause: string;
  domain: string;
  order: number;
  title: string;
  desc: string;
  type: "mandatory" | "recommended" | "optional";
  ctrl: "preventive" | "detective" | "corrective";
  freq:
    | "continuous"
    | "daily"
    | "weekly"
    | "monthly"
    | "quarterly"
    | "annual"
    | "event_driven";
  priority: "critical" | "high" | "medium" | "low";
  dept: string;
}

export const SAMA_OBLIGATION_DEFINITIONS: SamaObligationDef[] = [
  {
    code: "SAMA-01",
    clause: "§1.1",
    domain: "Leadership & Governance",
    order: 1,
    title: "Cyber Security Governance",
    desc: "Establish a board-approved cyber security governance structure with a dedicated steering committee, clear reporting lines to the board, and documented accountability for cyber security across the organisation.",
    type: "mandatory",
    ctrl: "preventive",
    freq: "annual",
    priority: "critical",
    dept: "Executive Management",
  },
  {
    code: "SAMA-02",
    clause: "§1.3",
    domain: "Leadership & Governance",
    order: 2,
    title: "Cyber Security Policy",
    desc: "Maintain a documented, board-approved cyber security policy that is reviewed at least annually, communicated to all staff, and aligned with SAMA directives and business objectives.",
    type: "mandatory",
    ctrl: "preventive",
    freq: "annual",
    priority: "critical",
    dept: "CISO Office",
  },
  {
    code: "SAMA-03",
    clause: "§1.4",
    domain: "Leadership & Governance",
    order: 3,
    title: "Roles and Responsibilities",
    desc: "Formally appoint a Chief Information Security Officer (CISO) with a direct reporting line independent of IT, and document cyber security roles, responsibilities, and segregation of duties across all functions.",
    type: "mandatory",
    ctrl: "preventive",
    freq: "annual",
    priority: "critical",
    dept: "Executive Management",
  },
  {
    code: "SAMA-04",
    clause: "§1.6",
    domain: "Leadership & Governance",
    order: 4,
    title: "Cyber Security Awareness",
    desc: "Run a continuous cyber security awareness programme for all employees, contractors, and third parties — covering phishing, social engineering, password hygiene, and incident reporting — with mandatory annual refreshers.",
    type: "mandatory",
    ctrl: "preventive",
    freq: "continuous",
    priority: "high",
    dept: "HR / CISO Office",
  },
  {
    code: "SAMA-05",
    clause: "§1.9",
    domain: "Leadership & Governance",
    order: 5,
    title: "Cyber Security Audit",
    desc: "Conduct independent internal and external cyber security audits at least annually, covering policy adherence, control effectiveness, and SAMA CSF coverage. Findings must be tracked to closure and reported to the board.",
    type: "mandatory",
    ctrl: "detective",
    freq: "annual",
    priority: "high",
    dept: "Internal Audit",
  },
  {
    code: "SAMA-06",
    clause: "§2.1",
    domain: "Risk Management & Compliance",
    order: 6,
    title: "Cyber Security Risk Management",
    desc: "Define a cyber security risk appetite approved by the board, maintain an up-to-date risk register covering all information assets, and perform risk assessments before any material change to systems or processes.",
    type: "mandatory",
    ctrl: "preventive",
    freq: "quarterly",
    priority: "critical",
    dept: "Risk Management",
  },
  {
    code: "SAMA-07",
    clause: "§2.2",
    domain: "Risk Management & Compliance",
    order: 7,
    title: "Regulatory Compliance",
    desc: "Monitor, document, and demonstrate compliance with all applicable SAMA directives, circulars, and the CSF. Maintain a regulatory obligations register and report compliance status to the board at least annually.",
    type: "mandatory",
    ctrl: "detective",
    freq: "quarterly",
    priority: "critical",
    dept: "Compliance",
  },
  {
    code: "SAMA-08",
    clause: "§3.3",
    domain: "Operations & Technology",
    order: 8,
    title: "Asset Management",
    desc: "Maintain a complete, classified, and regularly reconciled inventory of all information assets (systems, applications, data, network devices) with assigned owners, criticality ratings, and handling requirements.",
    type: "mandatory",
    ctrl: "preventive",
    freq: "quarterly",
    priority: "high",
    dept: "IT Operations",
  },
  {
    code: "SAMA-09",
    clause: "§3.4",
    domain: "Operations & Technology",
    order: 9,
    title: "Cyber Security Architecture",
    desc: "Design and maintain a layered cyber security architecture covering network segmentation, defence-in-depth, secure-by-default configurations, and regular architecture reviews for all new and existing systems.",
    type: "mandatory",
    ctrl: "preventive",
    freq: "annual",
    priority: "high",
    dept: "IT Security / Architecture",
  },
  {
    code: "SAMA-10",
    clause: "§3.5",
    domain: "Operations & Technology",
    order: 10,
    title: "Identity and Access Management",
    desc: "Enforce least-privilege access, role-based authorisation, multi-factor authentication for remote and privileged access, quarterly access reviews, and immediate revocation on role change or termination.",
    type: "mandatory",
    ctrl: "preventive",
    freq: "quarterly",
    priority: "critical",
    dept: "IT Security",
  },
  {
    code: "SAMA-11",
    clause: "§3.6",
    domain: "Operations & Technology",
    order: 11,
    title: "Application Security",
    desc: "Apply a secure software development life-cycle (SSDLC) including threat modelling, secure coding standards, peer review, static and dynamic application security testing, and pre-production penetration testing.",
    type: "mandatory",
    ctrl: "preventive",
    freq: "continuous",
    priority: "high",
    dept: "Development / AppSec",
  },
  {
    code: "SAMA-12",
    clause: "§3.9",
    domain: "Operations & Technology",
    order: 12,
    title: "Cryptography and Key Management",
    desc: "Use only SAMA-approved cryptographic algorithms and key lengths for data at rest, in transit, and in use. Maintain a documented key management lifecycle (generation, distribution, rotation, revocation, destruction).",
    type: "mandatory",
    ctrl: "preventive",
    freq: "annual",
    priority: "critical",
    dept: "IT Security",
  },
  {
    code: "SAMA-13",
    clause: "§3.15",
    domain: "Operations & Technology",
    order: 13,
    title: "Cyber Security Incident Management",
    desc: "Operate a documented incident response plan with defined roles, classification, escalation paths, and reporting to SAMA within the required timeframe for major incidents. Conduct post-incident reviews and update controls.",
    type: "mandatory",
    ctrl: "corrective",
    freq: "event_driven",
    priority: "critical",
    dept: "CISO Office / SOC",
  },
  {
    code: "SAMA-14",
    clause: "§3.17",
    domain: "Operations & Technology",
    order: 14,
    title: "Vulnerability Management",
    desc: "Run recurring vulnerability scans across all infrastructure and applications, prioritise remediation by risk rating, track SLAs for patching (critical within 14 days), and perform annual penetration tests.",
    type: "mandatory",
    ctrl: "detective",
    freq: "monthly",
    priority: "high",
    dept: "IT Security",
  },
  {
    code: "SAMA-15",
    clause: "§3.19",
    domain: "Operations & Technology",
    order: 15,
    title: "Logging and Monitoring",
    desc: "Centralise security logs in a SIEM with tamper-resistant storage, define retention (minimum 12 months), detect and alert on suspicious activity 24/7, and correlate events across systems to surface campaigns.",
    type: "mandatory",
    ctrl: "detective",
    freq: "continuous",
    priority: "critical",
    dept: "SOC",
  },
  {
    code: "SAMA-16",
    clause: "§3.12",
    domain: "Operations & Technology",
    order: 16,
    title: "Payment Systems Security",
    desc: "Protect payment systems (card, SWIFT, ATM, online banking, mobile banking) with segregated networks, hardened endpoints, transaction monitoring, fraud detection, and compliance with PCI DSS where applicable.",
    type: "mandatory",
    ctrl: "preventive",
    freq: "continuous",
    priority: "critical",
    dept: "Payments / IT Security",
  },
  {
    code: "SAMA-17",
    clause: "§4.1",
    domain: "Third Party",
    order: 17,
    title: "Contract and Vendor Management",
    desc: "Perform cyber security due diligence on all vendors before onboarding, include mandatory security clauses in contracts (right to audit, breach notification, data return/destruction), and review vendor security posture annually.",
    type: "mandatory",
    ctrl: "preventive",
    freq: "annual",
    priority: "high",
    dept: "Procurement / Legal",
  },
  {
    code: "SAMA-18",
    clause: "§4.2",
    domain: "Third Party",
    order: 18,
    title: "Outsourcing",
    desc: "Assess and document cyber security risk for every outsourcing arrangement. Obtain SAMA no-objection where required, retain accountability for outsourced functions, and monitor service provider performance continuously.",
    type: "mandatory",
    ctrl: "preventive",
    freq: "annual",
    priority: "high",
    dept: "Risk / Compliance",
  },
  {
    code: "SAMA-19",
    clause: "§4.3",
    domain: "Third Party",
    order: 19,
    title: "Cloud Computing",
    desc: "Before adopting any cloud service, assess data residency, encryption (at rest and in transit), shared-responsibility boundaries, exit and portability strategy, and compliance with SAMA cloud directives. Sensitive data must remain in approved jurisdictions.",
    type: "mandatory",
    ctrl: "preventive",
    freq: "event_driven",
    priority: "critical",
    dept: "IT / Legal / Compliance",
  },
  {
    code: "SAMA-20",
    clause: "§1.5",
    domain: "Leadership & Governance",
    order: 20,
    title: "Cyber Security in Project Management",
    desc: "Integrate cyber security requirements, risk assessments, and security acceptance testing into every project from initiation through go-live. No project proceeds to production without documented CISO sign-off.",
    type: "mandatory",
    ctrl: "preventive",
    freq: "event_driven",
    priority: "high",
    dept: "PMO / CISO Office",
  },
];

async function seedSAMAObligations(): Promise<void> {
  const existing = await pool.query(
    "SELECT COUNT(*) FROM obligations WHERE obligation_code LIKE 'SAMA-%'",
  );
  if (parseInt(existing.rows[0].count) > 0) return;

  const samaReg = await pool.query(
    "SELECT id FROM regulations WHERE regulation_code = 'SAMA-CSF'",
  );
  if (samaReg.rows.length === 0) {
    logger.warn(
      "⚠️ [ComplianceDB] SAMA-CSF regulation missing — skipping SAMA obligations seed",
    );
    return;
  }
  const regId = samaReg.rows[0].id;

  logger.info("🌱 [ComplianceDB] Seeding SAMA CSF obligations...");

  for (const ob of SAMA_OBLIGATION_DEFINITIONS) {
    await pool.query(
      `
      INSERT INTO obligations (obligation_code, regulation_id, article_reference, title, description, section_domain, section_order, clause_number, requirement_type, control_type, compliance_frequency, priority, responsible_department, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'applicable')
      ON CONFLICT (obligation_code) DO NOTHING
    `,
      [
        ob.code,
        regId,
        ob.clause,
        ob.title,
        ob.desc,
        ob.domain,
        ob.order,
        ob.clause,
        ob.type,
        ob.ctrl,
        ob.freq,
        ob.priority,
        ob.dept,
      ],
    );
  }

  logger.info(
    "✅ [ComplianceDB] SAMA CSF obligations seeded (" +
      SAMA_OBLIGATION_DEFINITIONS.length +
      " items)",
  );
}

export async function getComplianceDashboardStats(): Promise<any> {
  const [regsResult, oblResult, assessResult, overdueResult] =
    await Promise.all([
      pool.query(
        "SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = 'active') as active FROM regulations",
      ),
      pool.query(`SELECT COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'applicable') as applicable,
      COUNT(*) FILTER (WHERE priority = 'critical') as critical,
      COUNT(*) FILTER (WHERE priority = 'high') as high
      FROM obligations`),
      pool.query(`SELECT COUNT(*) as total,
      COUNT(*) FILTER (WHERE compliance_status = 'compliant') as compliant,
      COUNT(*) FILTER (WHERE compliance_status = 'partially_compliant') as partial,
      COUNT(*) FILTER (WHERE compliance_status = 'non_compliant') as non_compliant,
      COUNT(*) FILTER (WHERE compliance_status = 'not_assessed') as not_assessed
      FROM compliance_assessments`),
      pool.query(
        `SELECT COUNT(*) as count FROM compliance_calendar WHERE status IN ('scheduled','in_progress') AND scheduled_date < NOW()`,
      ),
    ]);

  const totalOb = parseInt(oblResult.rows[0].total) || 0;
  const assessed = parseInt(assessResult.rows[0].total) || 0;
  const compliant = parseInt(assessResult.rows[0].compliant) || 0;

  return {
    regulations: regsResult.rows[0],
    obligations: oblResult.rows[0],
    assessments: assessResult.rows[0],
    overdue_events: parseInt(overdueResult.rows[0].count),
    compliance_rate:
      assessed > 0 ? Math.round((compliant / assessed) * 100) : 0,
    coverage_rate: totalOb > 0 ? Math.round((assessed / totalOb) * 100) : 0,
  };
}

export async function getComplianceGapAnalysis(
  regulationId?: number,
): Promise<any[]> {
  let query = `
    SELECT o.id, o.obligation_code, o.title, o.priority, o.section_domain,
      o.responsible_department, r.name as regulation_name, r.regulation_code,
      COALESCE(ca.compliance_status, 'not_assessed') as latest_status,
      ca.score as latest_score,
      ca.assessment_date as last_assessed
    FROM obligations o
    JOIN regulations r ON o.regulation_id = r.id
    LEFT JOIN LATERAL (
      SELECT * FROM compliance_assessments WHERE obligation_id = o.id ORDER BY assessment_date DESC LIMIT 1
    ) ca ON true
    WHERE o.status = 'applicable'
  `;
  const params: any[] = [];
  if (regulationId) {
    query += " AND o.regulation_id = $1";
    params.push(regulationId);
  }
  query += " ORDER BY r.regulation_code, o.section_order ASC NULLS LAST";
  const result = await pool.query(query, params);
  return result.rows;
}
