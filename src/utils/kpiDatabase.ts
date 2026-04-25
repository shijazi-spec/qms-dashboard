import { createRedactedPool } from "./redactedPool";
import { logger } from "./logger";

export const pool = createRedactedPool({
  connectionString: process.env.DATABASE_URL,
});

export interface NavigationStep {
  step: number;
  action: string;
  screen: string;
  route: string;
  what_to_check: string;
  if_result: string;
  then_action: string;
}

export interface KPIDefinition {
  id?: number;
  kpi_name: string;
  kpi_code: string;
  description: string;
  owner_type:
    | "quality_manager"
    | "grc_manager"
    | "governance_officer"
    | "shared";
  owner_name?: string;
  category:
    | "governance"
    | "risk"
    | "compliance"
    | "audit"
    | "quality"
    | "vendor"
    | "training"
    | "ai";
  formula?: string;
  data_source?: string;
  unit: string;
  frequency: "daily" | "weekly" | "monthly" | "quarterly" | "annual";
  threshold_green: number;
  threshold_amber: number;
  threshold_red: number;
  threshold_direction: "higher_is_better" | "lower_is_better";
  target_value?: number;
  weight?: number;
  navigation_map?: NavigationStep[];
  is_active: boolean;
  created_at?: Date;
  updated_at?: Date;
}

export interface KPIValue {
  id?: number;
  kpi_id: number;
  period_start: Date;
  period_end: Date;
  actual_value: number;
  target_value?: number;
  status: "green" | "amber" | "red";
  trend?: "improving" | "stable" | "declining";
  calculated_by?: "system" | "manual";
  override_reason?: string;
  evidence_ids?: number[];
  ai_confidence?: number;
  ai_insights?: any;
  created_at?: Date;
  updated_at?: Date;
}

export interface ExecutiveReport {
  id?: number;
  report_type: "mbr" | "qbr" | "abr";
  period_name: string;
  period_start: Date;
  period_end: Date;
  overall_health_score: number;
  risk_summary?: any;
  compliance_summary?: any;
  quality_summary?: any;
  kpi_highlights?: any;
  action_items?: any;
  generated_by?: string;
  ai_executive_summary?: string;
  ai_confidence?: number;
  status: "draft" | "under_review" | "approved" | "published";
  approved_by?: string;
  approved_at?: Date;
  created_at?: Date;
  updated_at?: Date;
}

export async function initKPITables(): Promise<void> {
  logger.info("📊 [KPIDB] Initializing KPI Engine tables...");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS kpi_definitions (
      id SERIAL PRIMARY KEY,
      kpi_name VARCHAR(255) NOT NULL,
      kpi_code VARCHAR(50) UNIQUE NOT NULL,
      description TEXT,
      owner_type VARCHAR(20) NOT NULL CHECK (owner_type IN ('quality_manager', 'grc_manager', 'governance_officer', 'shared')),
      owner_name VARCHAR(100),
      category VARCHAR(30) NOT NULL,
      formula TEXT,
      data_source VARCHAR(255),
      unit VARCHAR(50) DEFAULT '%',
      frequency VARCHAR(20) DEFAULT 'monthly',
      threshold_green DECIMAL(10,2) NOT NULL,
      threshold_amber DECIMAL(10,2) NOT NULL,
      threshold_red DECIMAL(10,2) NOT NULL,
      threshold_direction VARCHAR(20) DEFAULT 'higher_is_better',
      target_value DECIMAL(10,2),
      weight DECIMAL(5,2) DEFAULT 1.0,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(
    `ALTER TABLE kpi_definitions ADD COLUMN IF NOT EXISTS navigation_map JSONB`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS kpi_values (
      id SERIAL PRIMARY KEY,
      kpi_id INTEGER REFERENCES kpi_definitions(id) ON DELETE CASCADE,
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      actual_value DECIMAL(10,2) NOT NULL,
      target_value DECIMAL(10,2),
      status VARCHAR(10) NOT NULL CHECK (status IN ('green', 'amber', 'red')),
      trend VARCHAR(15),
      calculated_by VARCHAR(10) DEFAULT 'system',
      override_reason TEXT,
      evidence_ids INTEGER[],
      ai_confidence DECIMAL(5,2),
      ai_insights JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // FIX: idempotency. Without this, the daily KPI cron silently inserted
  // duplicate rows whenever it ran more than once for the same period.
  // One-time dedup BEFORE the unique index, otherwise CREATE UNIQUE INDEX
  // fails on existing duplicate (kpi_id, period_start, period_end) tuples.
  // Keep the most recent row (highest id) per tuple.
  await pool.query(`
    DELETE FROM kpi_values v
    USING kpi_values v2
    WHERE v.kpi_id = v2.kpi_id
      AND v.period_start = v2.period_start
      AND v.period_end = v2.period_end
      AND v.id < v2.id
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS kpi_values_kpi_period_uidx
    ON kpi_values (kpi_id, period_start, period_end)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS executive_reports (
      id SERIAL PRIMARY KEY,
      report_type VARCHAR(10) NOT NULL CHECK (report_type IN ('mbr', 'qbr', 'abr')),
      period_name VARCHAR(100) NOT NULL,
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      overall_health_score DECIMAL(5,2),
      risk_summary JSONB,
      compliance_summary JSONB,
      quality_summary JSONB,
      kpi_highlights JSONB,
      action_items JSONB,
      generated_by VARCHAR(100),
      ai_executive_summary TEXT,
      ai_confidence DECIMAL(5,2),
      status VARCHAR(20) DEFAULT 'draft',
      approved_by VARCHAR(100),
      approved_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE kpi_definitions DROP CONSTRAINT IF EXISTS kpi_definitions_owner_type_check;
      ALTER TABLE kpi_definitions ADD CONSTRAINT kpi_definitions_owner_type_check
        CHECK (owner_type IN ('quality_manager', 'grc_manager', 'governance_officer', 'shared', 'sdr_team', 'sales_team'));
    EXCEPTION WHEN others THEN NULL;
    END $$;
  `);

  await seedDefaultKPIs();

  logger.info("✅ [KPIDB] KPI Engine tables initialized");
}

async function seedDefaultKPIs(): Promise<void> {
  const count = await pool.query("SELECT COUNT(*) FROM kpi_definitions");
  if (parseInt(count.rows[0].count) > 0) return;

  logger.info("🌱 [KPIDB] Seeding default KPI definitions...");

  const defaultKPIs: Partial<KPIDefinition>[] = [
    // Quality Manager (Sara) KPIs
    {
      kpi_name: "Governance Coverage",
      kpi_code: "QM-GOV-001",
      description:
        "Percentage of business processes covered by governance documents",
      owner_type: "quality_manager",
      owner_name: "Sara",
      category: "governance",
      formula: "(Covered Processes / Total Processes) × 100",
      unit: "%",
      frequency: "monthly",
      threshold_green: 90,
      threshold_amber: 75,
      threshold_red: 60,
      threshold_direction: "higher_is_better",
      target_value: 95,
    },
    {
      kpi_name: "Document Completion Rate",
      kpi_code: "QM-DOC-001",
      description: "Percentage of required documents completed and approved",
      owner_type: "quality_manager",
      owner_name: "Sara",
      category: "governance",
      formula: "(Approved Documents / Required Documents) × 100",
      unit: "%",
      frequency: "monthly",
      threshold_green: 95,
      threshold_amber: 85,
      threshold_red: 70,
      threshold_direction: "higher_is_better",
      target_value: 100,
    },
    {
      kpi_name: "Audit Execution Rate",
      kpi_code: "QM-AUD-001",
      description: "Percentage of planned audits completed on schedule",
      owner_type: "quality_manager",
      owner_name: "Sara",
      category: "audit",
      formula: "(Completed Audits / Planned Audits) × 100",
      unit: "%",
      frequency: "quarterly",
      threshold_green: 95,
      threshold_amber: 80,
      threshold_red: 65,
      threshold_direction: "higher_is_better",
      target_value: 100,
    },
    {
      kpi_name: "Audit Finding Closure Rate",
      kpi_code: "QM-AUD-002",
      description: "Percentage of audit findings closed within SLA",
      owner_type: "quality_manager",
      owner_name: "Sara",
      category: "audit",
      formula: "(Closed Findings / Total Findings) × 100",
      unit: "%",
      frequency: "monthly",
      threshold_green: 85,
      threshold_amber: 70,
      threshold_red: 50,
      threshold_direction: "higher_is_better",
      target_value: 90,
    },
    {
      kpi_name: "Repeat Findings Reduction",
      kpi_code: "QM-AUD-003",
      description: "Reduction in repeat audit findings vs previous period",
      owner_type: "quality_manager",
      owner_name: "Sara",
      category: "audit",
      formula: "((Previous Repeat Findings - Current) / Previous) × 100",
      unit: "%",
      frequency: "quarterly",
      threshold_green: 20,
      threshold_amber: 10,
      threshold_red: 0,
      threshold_direction: "higher_is_better",
      target_value: 25,
    },
    {
      kpi_name: "Training Coverage",
      kpi_code: "QM-TRN-001",
      description: "Percentage of staff with up-to-date training",
      owner_type: "quality_manager",
      owner_name: "Sara",
      category: "training",
      formula: "(Trained Staff / Total Staff) × 100",
      unit: "%",
      frequency: "monthly",
      threshold_green: 95,
      threshold_amber: 85,
      threshold_red: 70,
      threshold_direction: "higher_is_better",
      target_value: 100,
    },
    {
      kpi_name: "Continuous Improvement Index",
      kpi_code: "QM-CI-001",
      description: "Number of improvement initiatives implemented per quarter",
      owner_type: "quality_manager",
      owner_name: "Sara",
      category: "quality",
      formula: "Count of implemented initiatives",
      unit: "count",
      frequency: "quarterly",
      threshold_green: 10,
      threshold_amber: 5,
      threshold_red: 2,
      threshold_direction: "higher_is_better",
      target_value: 12,
    },
    {
      kpi_name: "Automation Coverage",
      kpi_code: "QM-AUTO-001",
      description: "Percentage of QMS processes with automation",
      owner_type: "quality_manager",
      owner_name: "Sara",
      category: "quality",
      formula: "(Automated Processes / Total Processes) × 100",
      unit: "%",
      frequency: "quarterly",
      threshold_green: 60,
      threshold_amber: 40,
      threshold_red: 20,
      threshold_direction: "higher_is_better",
      target_value: 75,
    },

    // GRC Manager (Maram) KPIs
    {
      kpi_name: "Enterprise Risk Coverage",
      kpi_code: "GRC-RSK-001",
      description:
        "Percentage of business units with completed risk assessments",
      owner_type: "grc_manager",
      owner_name: "Maram",
      category: "risk",
      formula: "(Assessed BUs / Total BUs) × 100",
      unit: "%",
      frequency: "quarterly",
      threshold_green: 100,
      threshold_amber: 85,
      threshold_red: 70,
      threshold_direction: "higher_is_better",
      target_value: 100,
    },
    {
      kpi_name: "Risk Treatment Completion",
      kpi_code: "GRC-RSK-002",
      description: "Percentage of risk treatments completed on time",
      owner_type: "grc_manager",
      owner_name: "Maram",
      category: "risk",
      formula: "(Completed Treatments / Total Treatments) × 100",
      unit: "%",
      frequency: "monthly",
      threshold_green: 90,
      threshold_amber: 75,
      threshold_red: 60,
      threshold_direction: "higher_is_better",
      target_value: 95,
    },
    {
      kpi_name: "High Risk Aging",
      kpi_code: "GRC-RSK-003",
      description:
        "Average age of high/critical risks without treatment (days)",
      owner_type: "grc_manager",
      owner_name: "Maram",
      category: "risk",
      formula: "AVG(Current Date - Risk Identified Date)",
      unit: "days",
      frequency: "weekly",
      threshold_green: 30,
      threshold_amber: 60,
      threshold_red: 90,
      threshold_direction: "lower_is_better",
      target_value: 14,
    },
    {
      kpi_name: "Compliance Coverage",
      kpi_code: "GRC-CMP-001",
      description: "Percentage of regulatory obligations with mapped controls",
      owner_type: "grc_manager",
      owner_name: "Maram",
      category: "compliance",
      formula: "(Mapped Obligations / Total Obligations) × 100",
      unit: "%",
      frequency: "quarterly",
      threshold_green: 95,
      threshold_amber: 80,
      threshold_red: 65,
      threshold_direction: "higher_is_better",
      target_value: 100,
    },
    {
      kpi_name: "Audit Readiness Score",
      kpi_code: "GRC-AUD-001",
      description: "Readiness score based on evidence and control testing",
      owner_type: "grc_manager",
      owner_name: "Maram",
      category: "audit",
      formula: "Weighted average of readiness factors",
      unit: "%",
      frequency: "monthly",
      threshold_green: 90,
      threshold_amber: 75,
      threshold_red: 60,
      threshold_direction: "higher_is_better",
      target_value: 95,
    },
    {
      kpi_name: "Vendor Risk Posture",
      kpi_code: "GRC-VND-001",
      description: "Percentage of critical vendors with acceptable risk rating",
      owner_type: "grc_manager",
      owner_name: "Maram",
      category: "vendor",
      formula: "(Low/Medium Risk Vendors / Critical Vendors) × 100",
      unit: "%",
      frequency: "quarterly",
      threshold_green: 85,
      threshold_amber: 70,
      threshold_red: 50,
      threshold_direction: "higher_is_better",
      target_value: 90,
    },
    {
      kpi_name: "Regulatory Response Time",
      kpi_code: "GRC-REG-001",
      description: "Average time to respond to regulatory requests (days)",
      owner_type: "grc_manager",
      owner_name: "Maram",
      category: "compliance",
      formula: "AVG(Response Date - Request Date)",
      unit: "days",
      frequency: "monthly",
      threshold_green: 5,
      threshold_amber: 10,
      threshold_red: 15,
      threshold_direction: "lower_is_better",
      target_value: 3,
    },

    // Shared KPIs
    {
      kpi_name: "Governance Loop Closure",
      kpi_code: "SHR-GOV-001",
      description: "Percentage of governance issues resolved end-to-end",
      owner_type: "shared",
      category: "governance",
      formula: "(Closed Governance Issues / Total Issues) × 100",
      unit: "%",
      frequency: "monthly",
      threshold_green: 90,
      threshold_amber: 75,
      threshold_red: 60,
      threshold_direction: "higher_is_better",
      target_value: 95,
    },
    {
      kpi_name: "AI-Enabled Resolution Index",
      kpi_code: "SHR-AI-001",
      description: "Percentage of issues resolved using AI recommendations",
      owner_type: "shared",
      category: "ai",
      formula: "(AI-Resolved Issues / Total Resolved) × 100",
      unit: "%",
      frequency: "monthly",
      threshold_green: 50,
      threshold_amber: 30,
      threshold_red: 10,
      threshold_direction: "higher_is_better",
      target_value: 60,
    },
    {
      kpi_name: "Cross-Module Integration Score",
      kpi_code: "SHR-INT-001",
      description: "Effectiveness of Quality-GRC handoff automation",
      owner_type: "shared",
      category: "quality",
      formula: "Weighted success rate of handoff rules",
      unit: "%",
      frequency: "monthly",
      threshold_green: 85,
      threshold_amber: 70,
      threshold_red: 50,
      threshold_direction: "higher_is_better",
      target_value: 90,
    },
  ];

  for (const kpi of defaultKPIs) {
    await pool.query(
      `
      INSERT INTO kpi_definitions (kpi_name, kpi_code, description, owner_type, owner_name, category, formula, unit, frequency, threshold_green, threshold_amber, threshold_red, threshold_direction, target_value)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (kpi_code) DO NOTHING
    `,
      [
        kpi.kpi_name,
        kpi.kpi_code,
        kpi.description,
        kpi.owner_type,
        kpi.owner_name,
        kpi.category,
        kpi.formula,
        kpi.unit,
        kpi.frequency,
        kpi.threshold_green,
        kpi.threshold_amber,
        kpi.threshold_red,
        kpi.threshold_direction,
        kpi.target_value,
      ],
    );
  }

  logger.info("✅ [KPIDB] Seeded default KPIs");

  await seedMohammedKPIs();
  await seedSDRKPIs();
}

async function seedMohammedKPIs(): Promise<void> {
  const exists = await pool.query(
    "SELECT COUNT(*) FROM kpi_definitions WHERE owner_type = 'governance_officer'",
  );
  if (parseInt(exists.rows[0].count) > 0) return;

  logger.info("🌱 [KPIDB] Seeding Mohammed Al Muzaini KPIs...");

  const mohammedKPIs = [
    {
      kpi_name: "Governance Documentation Lifecycle",
      kpi_code: "MAM-KPI-01",
      description:
        "Ensure all documents follow: Draft → Review → Approval → Publish → Periodic Review",
      owner_type: "governance_officer",
      owner_name: "Mohammed",
      category: "governance",
      formula: "% of documents compliant with lifecycle requirements",
      unit: "%",
      frequency: "weekly",
      threshold_green: 85,
      threshold_amber: 70,
      threshold_red: 60,
      threshold_direction: "higher_is_better",
      target_value: 95,
      weight: 20,
      navigation_map: JSON.stringify([
        {
          step: 1,
          action: "Open Policies Dashboard",
          screen: "Policy & Document Governance",
          route: "/policies",
          what_to_check: "Filter by status to see lifecycle stages",
          if_result: "Documents stuck in Draft/Review too long",
          then_action: "Follow up with document owner for status update",
        },
        {
          step: 2,
          action: "Check Review Dates",
          screen: "Policies Table",
          route: "/policies",
          what_to_check: "Look for red/overdue review dates",
          if_result: "Review date passed",
          then_action: "Contact owner (e.g., Sara) to schedule review",
        },
        {
          step: 3,
          action: "Verify Approval Evidence",
          screen: "Policy Details",
          route: "/policies",
          what_to_check: "Check approval status and approver name",
          if_result: "Missing approval",
          then_action: "Escalate to approver or document in QMS",
        },
        {
          step: 4,
          action: "Update Tracking",
          screen: "QMS Dashboard",
          route: "/qms",
          what_to_check: "Log follow-up action taken",
          if_result: "Issue tracked",
          then_action: "Set reminder for next check",
        },
      ]),
    },
    {
      kpi_name: "Compliance Obligation Tracking",
      kpi_code: "MAM-KPI-02",
      description:
        "Accuracy of compliance mapping across PDPL, ISO 27001, NCA, COPC",
      owner_type: "governance_officer",
      owner_name: "Mohammed",
      category: "compliance",
      formula: "% of obligations with owner + evidence + status",
      unit: "%",
      frequency: "weekly",
      threshold_green: 85,
      threshold_amber: 70,
      threshold_red: 60,
      threshold_direction: "higher_is_better",
      target_value: 95,
      weight: 20,
      navigation_map: JSON.stringify([
        {
          step: 1,
          action: "Open Compliance Dashboard",
          screen: "Compliance & Regulatory Tracker",
          route: "/compliance",
          what_to_check: "Review obligation summary by regulation",
          if_result: "Missing mappings for PDPL/NCA/ISO",
          then_action: "Flag to Maram (GRC Manager) for review",
        },
        {
          step: 2,
          action: "Check Obligation Details",
          screen: "Obligations Table",
          route: "/compliance",
          what_to_check: "Verify each obligation has owner + evidence",
          if_result: "Owner missing",
          then_action: "Assign to responsible department head",
        },
        {
          step: 3,
          action: "Verify Evidence Status",
          screen: "Compliance Assessments",
          route: "/compliance",
          what_to_check: "Check evidence_provided field is populated",
          if_result: "No evidence uploaded",
          then_action: "Request evidence from IT/department owner",
        },
        {
          step: 4,
          action: "Update Status",
          screen: "Compliance Dashboard",
          route: "/compliance",
          what_to_check: "Mark as Compliant when evidence complete",
          if_result: "All fields complete",
          then_action: "Log in tracking sheet for audit trail",
        },
      ]),
    },
    {
      kpi_name: "Audit Evidence Pack Readiness",
      kpi_code: "MAM-KPI-03",
      description: "Audit readiness before internal/external audits begin",
      owner_type: "governance_officer",
      owner_name: "Mohammed",
      category: "audit",
      formula: "% of audits with complete evidence packs pre-audit",
      unit: "%",
      frequency: "weekly",
      threshold_green: 85,
      threshold_amber: 70,
      threshold_red: 60,
      threshold_direction: "higher_is_better",
      target_value: 100,
      weight: 20,
      navigation_map: JSON.stringify([
        {
          step: 1,
          action: "Check Upcoming Audits",
          screen: "Audit Readiness Dashboard",
          route: "/audits",
          what_to_check: "Review audits scheduled in next 30 days",
          if_result: "Audit in 3 weeks",
          then_action: "Check evidence pack status immediately",
        },
        {
          step: 2,
          action: "Review Evidence Packs",
          screen: "Evidence Packs Section",
          route: "/audits",
          what_to_check: "Verify pack status (Draft/Compiled/Reviewed)",
          if_result: "Pack still in Draft",
          then_action: "Escalate to pack owner for completion",
        },
        {
          step: 3,
          action: "Complete Checklist",
          screen: "Audit Checklists",
          route: "/audits",
          what_to_check: "Ensure all checklist items have responses",
          if_result: "3 items missing evidence",
          then_action: "Request documents from relevant teams before Day 1",
        },
        {
          step: 4,
          action: "Final Verification",
          screen: "Audit Details",
          route: "/audits",
          what_to_check: "Confirm all sections marked complete",
          if_result: "Pack ready",
          then_action: "Mark as Reviewed and notify audit lead",
        },
      ]),
    },
    {
      kpi_name: "Quality→GRC Handoff Effectiveness",
      kpi_code: "MAM-KPI-04",
      description: "Proper handoff of Quality findings into GRC tracking",
      owner_type: "governance_officer",
      owner_name: "Mohammed",
      category: "quality",
      formula: "% of critical findings logged and tracked to closure",
      unit: "%",
      frequency: "weekly",
      threshold_green: 85,
      threshold_amber: 70,
      threshold_red: 60,
      threshold_direction: "higher_is_better",
      target_value: 95,
      weight: 15,
      navigation_map: JSON.stringify([
        {
          step: 1,
          action: "Monitor Handoff Events",
          screen: "Quality-GRC Handoff Engine",
          route: "/handoffs",
          what_to_check: "Check for pending/failed handoffs",
          if_result: "Handoff failed",
          then_action: "Investigate error and retry or log manually",
        },
        {
          step: 2,
          action: "Track Critical Findings",
          screen: "Handoff Events Table",
          route: "/handoffs",
          what_to_check: "Filter by priority=critical",
          if_result: "Critical finding not in GRC",
          then_action: "Log in GRC tracker manually, assign to HR/Maram",
        },
        {
          step: 3,
          action: "Verify GRC Entry",
          screen: "GRC Control Tower",
          route: "/grc",
          what_to_check: "Confirm finding appears in risk/compliance register",
          if_result: "Entry exists",
          then_action: "Link to source QMS record",
        },
        {
          step: 4,
          action: "Track to Closure",
          screen: "Risk Register / Compliance",
          route: "/risks",
          what_to_check: "Monitor status until resolved",
          if_result: "Evidence uploaded, closed",
          then_action: "Mark handoff as complete in tracker",
        },
      ]),
    },
    {
      kpi_name: "Risk Register Hygiene",
      kpi_code: "MAM-KPI-05",
      description: "Maintain cleanliness of risk register",
      owner_type: "governance_officer",
      owner_name: "Mohammed",
      category: "risk",
      formula: "% of risks with owner, status, and review date",
      unit: "%",
      frequency: "weekly",
      threshold_green: 85,
      threshold_amber: 70,
      threshold_red: 60,
      threshold_direction: "higher_is_better",
      target_value: 100,
      weight: 15,
      navigation_map: JSON.stringify([
        {
          step: 1,
          action: "Review Risk Register",
          screen: "Enterprise Risk Register",
          route: "/risks",
          what_to_check: "Identify risks missing owner field",
          if_result: "Risk without owner detected",
          then_action: "Flag to Maram for owner assignment",
        },
        {
          step: 2,
          action: "Check Review Dates",
          screen: "Risk Register Table",
          route: "/risks",
          what_to_check: "Look for overdue review dates (red)",
          if_result: "Review overdue by 30+ days",
          then_action: "Contact risk owner to schedule reassessment",
        },
        {
          step: 3,
          action: "Verify Treatment Status",
          screen: "Risk Treatment Actions",
          route: "/risks",
          what_to_check: "Check all treatments have current status",
          if_result: "Status is stale/unclear",
          then_action: "Request update from treatment owner",
        },
        {
          step: 4,
          action: "Update Register",
          screen: "Risk Details",
          route: "/risks",
          what_to_check: "Ensure all fields populated correctly",
          if_result: "All hygiene checks pass",
          then_action: "Document in weekly hygiene report",
        },
      ]),
    },
    {
      kpi_name: "Executive GRC Reporting Readiness",
      kpi_code: "MAM-KPI-06",
      description: "Accuracy and timeliness of executive GRC views",
      owner_type: "governance_officer",
      owner_name: "Mohammed",
      category: "governance",
      formula: "Timely, error-free dashboards and summaries",
      unit: "%",
      frequency: "weekly",
      threshold_green: 85,
      threshold_amber: 70,
      threshold_red: 60,
      threshold_direction: "higher_is_better",
      target_value: 95,
      weight: 10,
      navigation_map: JSON.stringify([
        {
          step: 1,
          action: "Review GRC Control Tower",
          screen: "GRC Control Tower",
          route: "/grc",
          what_to_check: "Verify all metrics are current and accurate",
          if_result: "Data looks outdated",
          then_action: "Trigger data refresh or investigate source",
        },
        {
          step: 2,
          action: "Check Executive Dashboard",
          screen: "Executive Dashboard",
          route: "/executive",
          what_to_check: "Confirm no errors or missing sections",
          if_result: "Section shows error/blank",
          then_action: "Check data source and fix or escalate",
        },
        {
          step: 3,
          action: "Validate KPI Engine",
          screen: "KPI Engine",
          route: "/kpis",
          what_to_check: "Ensure all KPIs have recent values",
          if_result: "KPI value missing/stale",
          then_action: "Update KPI calculation or request data input",
        },
        {
          step: 4,
          action: "Pre-Leadership Review",
          screen: "All Dashboards",
          route: "/grc",
          what_to_check: "Do quick walkthrough before exec meeting",
          if_result: "All current and accurate",
          then_action: "Confirm ready for CEO/leadership review",
        },
      ]),
    },
  ];

  for (const kpi of mohammedKPIs) {
    await pool.query(
      `
      INSERT INTO kpi_definitions (kpi_name, kpi_code, description, owner_type, owner_name, category, formula, unit, frequency, threshold_green, threshold_amber, threshold_red, threshold_direction, target_value, weight, navigation_map)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      ON CONFLICT (kpi_code) DO NOTHING
    `,
      [
        kpi.kpi_name,
        kpi.kpi_code,
        kpi.description,
        kpi.owner_type,
        kpi.owner_name,
        kpi.category,
        kpi.formula,
        kpi.unit,
        kpi.frequency,
        kpi.threshold_green,
        kpi.threshold_amber,
        kpi.threshold_red,
        kpi.threshold_direction,
        kpi.target_value,
        kpi.weight,
        kpi.navigation_map,
      ],
    );
  }

  logger.info("✅ [KPIDB] Seeded Mohammed Al Muzaini KPIs");
}

export async function seedMohammedKPIsManual(): Promise<void> {
  await seedMohammedKPIs();
}

async function seedSDRKPIs(): Promise<void> {
  const exists = await pool.query(
    "SELECT COUNT(*) FROM kpi_definitions WHERE owner_type = 'sdr_team'",
  );
  if (parseInt(exists.rows[0].count) > 0) return;

  logger.info("🌱 [KPIDB] Seeding SDR Team KPIs...");

  const sdrKPIs = [
    {
      kpi_name: "Calls Per Day",
      kpi_code: "SDR-KPI-01",
      description: "Total outbound calls per working day per SDR agent",
      owner_type: "sdr_team",
      owner_name: "SDR Team",
      category: "individual",
      formula: "Total outbound calls / working days",
      unit: "calls/day",
      frequency: "daily",
      threshold_green: 40,
      threshold_amber: 30,
      threshold_red: 20,
      threshold_direction: "higher_is_better",
      target_value: 40,
      weight: 10,
      navigation_map: JSON.stringify([
        {
          step: 1,
          action: "Check CRM call logs",
          screen: "Zoho CRM Calls",
          route: "/crm",
          what_to_check: "Count outbound calls per SDR today",
          if_result: "<30 calls",
          then_action: "Coach SDR on call volume targets",
        },
      ]),
    },
    {
      kpi_name: "Contact Rate",
      kpi_code: "SDR-KPI-02",
      description: "Percentage of calls that result in a live conversation",
      owner_type: "sdr_team",
      owner_name: "SDR Team",
      category: "individual",
      formula: "(Connected calls / Total calls) × 100",
      unit: "%",
      frequency: "weekly",
      threshold_green: 30,
      threshold_amber: 20,
      threshold_red: 15,
      threshold_direction: "higher_is_better",
      target_value: 30,
      weight: 10,
      navigation_map: JSON.stringify([
        {
          step: 1,
          action: "Pull call analytics",
          screen: "CRM Reports",
          route: "/crm",
          what_to_check: "Filter calls by Outgoing_Call_Result = Connected",
          if_result: "<20% connected",
          then_action: "Review calling times and data quality",
        },
      ]),
    },
    {
      kpi_name: "Qualification Rate",
      kpi_code: "SDR-KPI-03",
      description: "Percentage of contacted leads that get qualified",
      owner_type: "sdr_team",
      owner_name: "SDR Team",
      category: "individual",
      formula: "(Qualified leads / Total contacted leads) × 100",
      unit: "%",
      frequency: "weekly",
      threshold_green: 25,
      threshold_amber: 18,
      threshold_red: 12,
      threshold_direction: "higher_is_better",
      target_value: 25,
      weight: 10,
      navigation_map: JSON.stringify([
        {
          step: 1,
          action: "Check lead conversion funnel",
          screen: "CRM Lead Reports",
          route: "/crm",
          what_to_check: "Count leads moved to Qualified vs total Contacted",
          if_result: "<18%",
          then_action:
            "Review qualification criteria adherence and lead quality",
        },
      ]),
    },
    {
      kpi_name: "Meetings Booked Per Week",
      kpi_code: "SDR-KPI-04",
      description: "Number of qualified meetings booked for Sales per week",
      owner_type: "sdr_team",
      owner_name: "SDR Team",
      category: "individual",
      formula: "Count of meetings booked per week",
      unit: "meetings",
      frequency: "weekly",
      threshold_green: 5,
      threshold_amber: 3,
      threshold_red: 2,
      threshold_direction: "higher_is_better",
      target_value: 5,
      weight: 10,
      navigation_map: JSON.stringify([
        {
          step: 1,
          action: "Count new deals created from converted leads",
          screen: "CRM Deals",
          route: "/crm",
          what_to_check: "Filter deals created this week by SDR source",
          if_result: "<3 meetings",
          then_action: "Discuss pipeline building strategy with SDR TL",
        },
      ]),
    },
    {
      kpi_name: "Show Rate",
      kpi_code: "SDR-KPI-05",
      description: "Percentage of booked meetings that are actually attended",
      owner_type: "sdr_team",
      owner_name: "SDR Team",
      category: "individual",
      formula: "(Meetings attended / Meetings booked) × 100",
      unit: "%",
      frequency: "weekly",
      threshold_green: 80,
      threshold_amber: 65,
      threshold_red: 50,
      threshold_direction: "higher_is_better",
      target_value: 80,
      weight: 8,
      navigation_map: JSON.stringify([
        {
          step: 1,
          action: "Compare booked vs attended meetings",
          screen: "CRM Deals",
          route: "/crm",
          what_to_check: "Count deals in Meeting vs Not Attend Meeting stages",
          if_result: "<65% show rate",
          then_action: "Implement confirmation call protocol (30-60min before)",
        },
      ]),
    },
    {
      kpi_name: "Average Speed to Lead",
      kpi_code: "SDR-KPI-06",
      description: "Average time from lead creation to first contact attempt",
      owner_type: "sdr_team",
      owner_name: "SDR Team",
      category: "individual",
      formula: "Average(First_Call_Date - Created_Time) in hours",
      unit: "hours",
      frequency: "weekly",
      threshold_green: 2,
      threshold_amber: 4,
      threshold_red: 8,
      threshold_direction: "lower_is_better",
      target_value: 2,
      weight: 10,
      navigation_map: JSON.stringify([
        {
          step: 1,
          action: "Check lead response times",
          screen: "CRM Leads",
          route: "/crm",
          what_to_check: "Compare Created_Time vs first activity timestamp",
          if_result: ">4 hours avg",
          then_action: "Investigate queue distribution and SDR workload",
        },
      ]),
    },
    {
      kpi_name: "Lead-to-Qualified Conversion",
      kpi_code: "SDR-KPI-07",
      description: "Percentage of all new leads that reach Qualified status",
      owner_type: "sdr_team",
      owner_name: "SDR Team",
      category: "process",
      formula: "(Qualified / Total new leads) × 100",
      unit: "%",
      frequency: "monthly",
      threshold_green: 20,
      threshold_amber: 15,
      threshold_red: 10,
      threshold_direction: "higher_is_better",
      target_value: 20,
      weight: 8,
      navigation_map: JSON.stringify([
        {
          step: 1,
          action: "Pull monthly lead funnel report",
          screen: "CRM Reports",
          route: "/crm",
          what_to_check: "Total new leads vs Qualified leads this month",
          if_result: "<15%",
          then_action: "Review lead source quality and SDR training",
        },
      ]),
    },
    {
      kpi_name: "CRM Data Accuracy Score (SDR)",
      kpi_code: "SDR-KPI-08",
      description:
        "Percentage of leads with all required fields correctly filled",
      owner_type: "sdr_team",
      owner_name: "SDR Team",
      category: "process",
      formula: "(Leads with all required fields / Total leads) × 100",
      unit: "%",
      frequency: "weekly",
      threshold_green: 95,
      threshold_amber: 85,
      threshold_red: 75,
      threshold_direction: "higher_is_better",
      target_value: 95,
      weight: 8,
      navigation_map: JSON.stringify([
        {
          step: 1,
          action: "Run audit on Leads module",
          screen: "Quality Audit",
          route: "/crm",
          what_to_check: "Check hygiene issues for Leads in latest audit",
          if_result: "<85% accuracy",
          then_action:
            "Provide targeted data entry training to offending agents",
        },
      ]),
    },
    {
      kpi_name: "Duplicate Rate",
      kpi_code: "SDR-KPI-09",
      description: "Percentage of leads identified as duplicates",
      owner_type: "sdr_team",
      owner_name: "SDR Team",
      category: "process",
      formula: "(Duplicate leads / Total leads) × 100",
      unit: "%",
      frequency: "monthly",
      threshold_green: 2,
      threshold_amber: 5,
      threshold_red: 10,
      threshold_direction: "lower_is_better",
      target_value: 2,
      weight: 6,
      navigation_map: JSON.stringify([
        {
          step: 1,
          action: "Run dedup report in CRM",
          screen: "CRM Leads",
          route: "/crm",
          what_to_check: "Check for duplicate emails and phone numbers",
          if_result: ">5% duplicates",
          then_action:
            "Merge duplicates and enforce pre-entry duplicate check SOP",
        },
      ]),
    },
    {
      kpi_name: "Pipeline Aging",
      kpi_code: "SDR-KPI-10",
      description:
        "Average days leads stay in active stages (Contacting/Contacted)",
      owner_type: "sdr_team",
      owner_name: "SDR Team",
      category: "process",
      formula: "Average days in Contacting + Contacted stages",
      unit: "days",
      frequency: "weekly",
      threshold_green: 5,
      threshold_amber: 8,
      threshold_red: 12,
      threshold_direction: "lower_is_better",
      target_value: 5,
      weight: 10,
      navigation_map: JSON.stringify([
        {
          step: 1,
          action: "Check lead aging",
          screen: "CRM Leads",
          route: "/crm",
          what_to_check:
            "Filter leads by status Contacting/Contacted, sort by Modified_Time",
          if_result: ">8 days avg",
          then_action: "Push SDRs to qualify or disqualify stale leads",
        },
      ]),
    },
    {
      kpi_name: "Follow-Up Compliance (SDR)",
      kpi_code: "SDR-KPI-11",
      description: "Percentage of follow-up tasks completed on time",
      owner_type: "sdr_team",
      owner_name: "SDR Team",
      category: "process",
      formula: "(On-time follow-ups / Total follow-ups) × 100",
      unit: "%",
      frequency: "weekly",
      threshold_green: 95,
      threshold_amber: 85,
      threshold_red: 75,
      threshold_direction: "higher_is_better",
      target_value: 95,
      weight: 10,
      navigation_map: JSON.stringify([
        {
          step: 1,
          action: "Check overdue tasks for SDR owners",
          screen: "CRM Tasks",
          route: "/crm",
          what_to_check:
            "Filter tasks by SDR owners where Due_Date < today and status != Completed",
          if_result: ">15% overdue",
          then_action: "Escalate to SDR TL for immediate follow-up",
        },
      ]),
    },
  ];

  for (const kpi of sdrKPIs) {
    await pool.query(
      `
      INSERT INTO kpi_definitions (kpi_name, kpi_code, description, owner_type, owner_name, category, formula, unit, frequency, threshold_green, threshold_amber, threshold_red, threshold_direction, target_value, weight, navigation_map)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      ON CONFLICT (kpi_code) DO NOTHING
    `,
      [
        kpi.kpi_name,
        kpi.kpi_code,
        kpi.description,
        kpi.owner_type,
        kpi.owner_name,
        kpi.category,
        kpi.formula,
        kpi.unit,
        kpi.frequency,
        kpi.threshold_green,
        kpi.threshold_amber,
        kpi.threshold_red,
        kpi.threshold_direction,
        kpi.target_value,
        kpi.weight,
        kpi.navigation_map,
      ],
    );
  }

  logger.info("✅ [KPIDB] Seeded 11 SDR Team KPIs");
}

export async function seedSDRKPIsManual(): Promise<void> {
  await seedSDRKPIs();
}

export async function getAllKPIDefinitions(): Promise<KPIDefinition[]> {
  const result = await pool.query(
    "SELECT * FROM kpi_definitions WHERE is_active = true ORDER BY owner_type, category, kpi_name",
  );
  return result.rows;
}

export async function getKPIsByOwner(
  ownerType: string,
): Promise<KPIDefinition[]> {
  const result = await pool.query(
    "SELECT * FROM kpi_definitions WHERE owner_type = $1 AND is_active = true ORDER BY category, kpi_name",
    [ownerType],
  );
  return result.rows;
}

export async function getKPIById(id: number): Promise<KPIDefinition | null> {
  const result = await pool.query(
    "SELECT * FROM kpi_definitions WHERE id = $1",
    [id],
  );
  return result.rows[0] || null;
}

export async function createKPIDefinition(
  kpi: KPIDefinition,
): Promise<KPIDefinition> {
  const result = await pool.query(
    `
    INSERT INTO kpi_definitions (kpi_name, kpi_code, description, owner_type, owner_name, category, formula, data_source, unit, frequency, threshold_green, threshold_amber, threshold_red, threshold_direction, target_value, weight, is_active)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
    RETURNING *
  `,
    [
      kpi.kpi_name,
      kpi.kpi_code,
      kpi.description,
      kpi.owner_type,
      kpi.owner_name,
      kpi.category,
      kpi.formula,
      kpi.data_source,
      kpi.unit,
      kpi.frequency,
      kpi.threshold_green,
      kpi.threshold_amber,
      kpi.threshold_red,
      kpi.threshold_direction,
      kpi.target_value,
      kpi.weight || 1.0,
      kpi.is_active,
    ],
  );
  return result.rows[0];
}

export async function updateKPIDefinition(
  id: number,
  kpi: Partial<KPIDefinition>,
): Promise<KPIDefinition | null> {
  const fields: string[] = [];
  const values: any[] = [];
  let paramCount = 1;

  const allowedFields = [
    "kpi_name",
    "description",
    "owner_type",
    "owner_name",
    "category",
    "formula",
    "data_source",
    "unit",
    "frequency",
    "threshold_green",
    "threshold_amber",
    "threshold_red",
    "threshold_direction",
    "target_value",
    "weight",
    "is_active",
  ];

  for (const field of allowedFields) {
    if (kpi[field as keyof KPIDefinition] !== undefined) {
      fields.push(`${field} = $${paramCount}`);
      values.push(kpi[field as keyof KPIDefinition]);
      paramCount++;
    }
  }

  if (fields.length === 0) return null;

  fields.push(`updated_at = NOW()`);
  values.push(id);

  const result = await pool.query(
    `UPDATE kpi_definitions SET ${fields.join(", ")} WHERE id = $${paramCount} RETURNING *`,
    values,
  );
  return result.rows[0] || null;
}

export async function recordKPIValue(value: KPIValue): Promise<KPIValue> {
  const kpi = await getKPIById(value.kpi_id);
  if (!kpi) throw new Error("KPI not found");

  let status: "green" | "amber" | "red";
  if (kpi.threshold_direction === "higher_is_better") {
    if (value.actual_value >= kpi.threshold_green) status = "green";
    else if (value.actual_value >= kpi.threshold_amber) status = "amber";
    else status = "red";
  } else {
    if (value.actual_value <= kpi.threshold_green) status = "green";
    else if (value.actual_value <= kpi.threshold_amber) status = "amber";
    else status = "red";
  }

  const previousValue = await getLatestKPIValue(value.kpi_id);
  let trend: "improving" | "stable" | "declining" = "stable";
  if (previousValue) {
    const diff = value.actual_value - previousValue.actual_value;
    const threshold = 0.05 * previousValue.actual_value;
    if (kpi.threshold_direction === "higher_is_better") {
      if (diff > threshold) trend = "improving";
      else if (diff < -threshold) trend = "declining";
    } else {
      if (diff < -threshold) trend = "improving";
      else if (diff > threshold) trend = "declining";
    }
  }

  // Idempotent upsert keyed on (kpi_id, period_start, period_end). Re-runs of
  // the daily cron for the same period now update the existing row instead of
  // duplicating it (relies on the unique index added in initKPITables).
  const result = await pool.query(
    `
    INSERT INTO kpi_values (kpi_id, period_start, period_end, actual_value, target_value, status, trend, calculated_by, override_reason, evidence_ids, ai_confidence, ai_insights)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT (kpi_id, period_start, period_end) DO UPDATE SET
      actual_value = EXCLUDED.actual_value,
      target_value = EXCLUDED.target_value,
      status = EXCLUDED.status,
      trend = EXCLUDED.trend,
      calculated_by = EXCLUDED.calculated_by,
      override_reason = EXCLUDED.override_reason,
      evidence_ids = EXCLUDED.evidence_ids,
      ai_confidence = EXCLUDED.ai_confidence,
      ai_insights = EXCLUDED.ai_insights,
      updated_at = NOW()
    RETURNING *
  `,
    [
      value.kpi_id,
      value.period_start,
      value.period_end,
      value.actual_value,
      value.target_value || kpi.target_value,
      status,
      trend,
      value.calculated_by || "system",
      value.override_reason,
      value.evidence_ids,
      value.ai_confidence,
      JSON.stringify(value.ai_insights),
    ],
  );

  return result.rows[0];
}

export async function getLatestKPIValue(
  kpiId: number,
): Promise<KPIValue | null> {
  const result = await pool.query(
    "SELECT * FROM kpi_values WHERE kpi_id = $1 ORDER BY period_end DESC LIMIT 1",
    [kpiId],
  );
  return result.rows[0] || null;
}

export async function getKPIHistory(
  kpiId: number,
  limit: number = 12,
): Promise<KPIValue[]> {
  const result = await pool.query(
    "SELECT * FROM kpi_values WHERE kpi_id = $1 ORDER BY period_end DESC LIMIT $2",
    [kpiId, limit],
  );
  return result.rows;
}

export async function getKPIDashboardSummary(): Promise<any> {
  const kpis = await getAllKPIDefinitions();
  const summary: any = {
    total: kpis.length,
    byOwner: { quality_manager: 0, grc_manager: 0, shared: 0 },
    byStatus: { green: 0, amber: 0, red: 0, no_data: 0 },
    byCategory: {},
    kpiDetails: [],
  };

  for (const kpi of kpis) {
    summary.byOwner[kpi.owner_type]++;
    if (!summary.byCategory[kpi.category]) summary.byCategory[kpi.category] = 0;
    summary.byCategory[kpi.category]++;

    const latestValue = await getLatestKPIValue(kpi.id!);
    if (latestValue) {
      summary.byStatus[latestValue.status]++;
      summary.kpiDetails.push({
        ...kpi,
        latestValue: latestValue.actual_value,
        status: latestValue.status,
        trend: latestValue.trend,
        lastUpdated: latestValue.period_end,
      });
    } else {
      summary.byStatus.no_data++;
      summary.kpiDetails.push({
        ...kpi,
        latestValue: null,
        status: "no_data",
        trend: null,
        lastUpdated: null,
      });
    }
  }

  return summary;
}

export async function createExecutiveReport(
  report: ExecutiveReport,
): Promise<ExecutiveReport> {
  const result = await pool.query(
    `
    INSERT INTO executive_reports (report_type, period_name, period_start, period_end, overall_health_score, risk_summary, compliance_summary, quality_summary, kpi_highlights, action_items, generated_by, ai_executive_summary, ai_confidence, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    RETURNING *
  `,
    [
      report.report_type,
      report.period_name,
      report.period_start,
      report.period_end,
      report.overall_health_score,
      JSON.stringify(report.risk_summary),
      JSON.stringify(report.compliance_summary),
      JSON.stringify(report.quality_summary),
      JSON.stringify(report.kpi_highlights),
      JSON.stringify(report.action_items),
      report.generated_by,
      report.ai_executive_summary,
      report.ai_confidence,
      report.status || "draft",
    ],
  );
  return result.rows[0];
}

export async function getExecutiveReports(
  reportType?: string,
): Promise<ExecutiveReport[]> {
  let query = "SELECT * FROM executive_reports";
  const params: any[] = [];
  if (reportType) {
    query += " WHERE report_type = $1";
    params.push(reportType);
  }
  query += " ORDER BY period_end DESC";
  const result = await pool.query(query, params);
  return result.rows;
}

export async function getExecutiveReportById(
  id: number,
): Promise<ExecutiveReport | null> {
  const result = await pool.query(
    "SELECT * FROM executive_reports WHERE id = $1",
    [id],
  );
  return result.rows[0] || null;
}

export async function updateExecutiveReport(
  id: number,
  updates: Partial<ExecutiveReport>,
): Promise<ExecutiveReport | null> {
  const fields: string[] = [];
  const values: any[] = [];
  let paramCount = 1;

  const allowedFields = [
    "overall_health_score",
    "risk_summary",
    "compliance_summary",
    "quality_summary",
    "kpi_highlights",
    "action_items",
    "ai_executive_summary",
    "ai_confidence",
    "status",
    "approved_by",
    "approved_at",
  ];

  for (const field of allowedFields) {
    if (updates[field as keyof ExecutiveReport] !== undefined) {
      const value = updates[field as keyof ExecutiveReport];
      fields.push(`${field} = $${paramCount}`);
      values.push(
        typeof value === "object" && !(value instanceof Date)
          ? JSON.stringify(value)
          : value,
      );
      paramCount++;
    }
  }

  if (fields.length === 0) return null;

  fields.push(`updated_at = NOW()`);
  values.push(id);

  const result = await pool.query(
    `UPDATE executive_reports SET ${fields.join(", ")} WHERE id = $${paramCount} RETURNING *`,
    values,
  );
  return result.rows[0] || null;
}

export async function generateMBRData(): Promise<any> {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

  const summary = await getKPIDashboardSummary();

  const riskResult = await pool.query(`
    SELECT risk_level, COUNT(*) as count FROM enterprise_risks WHERE status != 'closed' GROUP BY risk_level
  `);

  const complianceResult = await pool.query(`
    SELECT status, COUNT(*) as count FROM obligations GROUP BY status
  `);

  const auditResult = await pool.query(
    `
    SELECT status, COUNT(*) as count FROM audits WHERE audit_date >= $1 GROUP BY status
  `,
    [monthStart],
  );

  return {
    period: {
      start: monthStart,
      end: monthEnd,
      name: monthStart.toLocaleDateString("en-US", {
        month: "long",
        year: "numeric",
      }),
    },
    kpiSummary: summary,
    riskSummary: riskResult.rows,
    complianceSummary: complianceResult.rows,
    auditSummary: auditResult.rows,
  };
}
