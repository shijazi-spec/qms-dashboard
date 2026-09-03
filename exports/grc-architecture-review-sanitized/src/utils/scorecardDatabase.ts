import { createRedactedPool } from "./redactedPool";
import { logger } from "./logger";

const pool = createRedactedPool({
  connectionString: process.env.DATABASE_URL,
});

export interface MohammedKPI {
  kpi_id: string;
  kpi_name: string;
  weight: number;
  description: string;
  measurement: string;
  current_value: number;
  target: number;
  status: "green" | "amber" | "red" | "no_data";
  trend: "improving" | "stable" | "declining" | "new";
  navigation_map: NavigationStep[];
  data_sources: string[];
  last_updated: Date;
}

export interface NavigationStep {
  step: number;
  action: string;
  screen: string;
  route: string;
  what_to_check: string;
  if_result: string;
  then_action: string;
}

export interface ScorecardSnapshot {
  id?: number;
  employee_name: string;
  employee_role: string;
  period_start: Date;
  period_end: Date;
  overall_score: number;
  weighted_score: number;
  kpi_details: MohammedKPI[];
  created_at?: Date;
}

export async function initScorecardTables(): Promise<void> {
  logger.info("📊 [ScorecardDB] Initializing scorecard tables...");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS employee_scorecards (
      id SERIAL PRIMARY KEY,
      employee_name VARCHAR(255) NOT NULL,
      employee_role VARCHAR(255) NOT NULL,
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      overall_score DECIMAL(5,2),
      weighted_score DECIMAL(5,2),
      kpi_details JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  logger.info("✅ [ScorecardDB] Scorecard tables initialized");
}

export async function calculateKPI1_GovernanceDocLifecycle(): Promise<{
  value: number;
  details: any;
}> {
  logger.info(
    "📊 [ScorecardDB] Calculating KPI 1: Governance Documentation Lifecycle...",
  );

  const result = await pool.query(`
    SELECT 
      COUNT(*) as total_policies,
      COUNT(*) FILTER (WHERE status = 'published' AND (review_date IS NULL OR review_date >= NOW())) as compliant,
      COUNT(*) FILTER (WHERE status = 'published' AND review_date < NOW()) as overdue_review,
      COUNT(*) FILTER (WHERE status = 'draft') as draft,
      COUNT(*) FILTER (WHERE status = 'review') as in_review,
      COUNT(*) FILTER (WHERE status = 'approval') as pending_approval,
      COUNT(*) FILTER (WHERE status = 'published') as published,
      COUNT(*) FILTER (WHERE status = 'archived' OR status = 'retired') as archived
    FROM policies
  `);

  const stats = result.rows[0];
  const total = parseInt(stats.total_policies) || 1;
  const compliant = parseInt(stats.compliant) || 0;
  const published = parseInt(stats.published) || 0;

  const lifecycleCompliance =
    total > 0 ? Math.round((compliant / total) * 100) : 0;

  logger.info("✅ [ScorecardDB] KPI 1 calculated:", lifecycleCompliance, "%");
  return {
    value: lifecycleCompliance,
    details: {
      total_documents: total,
      compliant_documents: compliant,
      overdue_reviews: parseInt(stats.overdue_review) || 0,
      by_status: {
        draft: parseInt(stats.draft) || 0,
        in_review: parseInt(stats.in_review) || 0,
        pending_approval: parseInt(stats.pending_approval) || 0,
        published: published,
        archived: parseInt(stats.archived) || 0,
      },
    },
  };
}

export async function calculateKPI2_ComplianceObligationTracking(): Promise<{
  value: number;
  details: any;
}> {
  logger.info(
    "📊 [ScorecardDB] Calculating KPI 2: Compliance Obligation Tracking...",
  );

  const result = await pool.query(`
    SELECT 
      COUNT(*) as total_obligations,
      COUNT(*) FILTER (WHERE responsible_department IS NOT NULL) as has_owner,
      COUNT(*) FILTER (WHERE status = 'applicable') as applicable,
      COUNT(*) FILTER (WHERE evidence_requirements IS NOT NULL AND evidence_requirements != '') as has_evidence_req
    FROM obligations
  `);

  const assessmentResult = await pool.query(`
    SELECT 
      COUNT(DISTINCT obligation_id) as assessed_obligations,
      COUNT(*) FILTER (WHERE compliance_status = 'compliant') as compliant,
      COUNT(*) FILTER (WHERE evidence_provided IS NOT NULL) as with_evidence
    FROM compliance_assessments
  `);

  const stats = result.rows[0];
  const assessStats = assessmentResult.rows[0];

  const totalObligations = parseInt(stats.total_obligations) || 1;
  const hasOwner = parseInt(stats.has_owner) || 0;
  const assessedWithEvidence = parseInt(assessStats.with_evidence) || 0;

  const completenessScore =
    totalObligations > 0
      ? Math.round(
          ((hasOwner + assessedWithEvidence) / (totalObligations * 2)) * 100,
        )
      : 0;

  logger.info("✅ [ScorecardDB] KPI 2 calculated:", completenessScore, "%");
  return {
    value: completenessScore,
    details: {
      total_obligations: totalObligations,
      with_owner: hasOwner,
      with_evidence: assessedWithEvidence,
      assessed_obligations: parseInt(assessStats.assessed_obligations) || 0,
      compliant_count: parseInt(assessStats.compliant) || 0,
    },
  };
}

export async function calculateKPI3_AuditEvidencePackReadiness(): Promise<{
  value: number;
  details: any;
}> {
  logger.info(
    "📊 [ScorecardDB] Calculating KPI 3: Audit Evidence Pack Readiness...",
  );

  const auditsResult = await pool.query(`
    SELECT 
      COUNT(*) as total_audits,
      COUNT(*) FILTER (WHERE status IN ('planned', 'in_progress')) as upcoming,
      COUNT(*) FILTER (WHERE status IN ('fieldwork_complete', 'report_draft', 'report_final', 'closed')) as completed
    FROM audits
  `);

  const evidenceResult = await pool.query(`
    SELECT 
      COUNT(*) as total_packs,
      COUNT(*) FILTER (WHERE status = 'compiled' OR status = 'reviewed' OR status = 'submitted') as ready,
      COUNT(*) FILTER (WHERE status = 'draft') as draft
    FROM evidence_packs
  `);

  const checklistResult = await pool.query(`
    SELECT 
      COUNT(*) as total_items,
      COUNT(*) FILTER (WHERE status = 'completed') as completed_items
    FROM audit_checklists
  `);

  const audits = auditsResult.rows[0];
  const evidence = evidenceResult.rows[0];
  const checklist = checklistResult.rows[0];

  const totalAudits = parseInt(audits.total_audits) || 1;
  const readyPacks = parseInt(evidence.ready) || 0;
  const totalPacks = parseInt(evidence.total_packs) || 1;
  const completedItems = parseInt(checklist.completed_items) || 0;
  const totalItems = parseInt(checklist.total_items) || 1;

  const packReadiness = totalPacks > 0 ? (readyPacks / totalPacks) * 100 : 0;
  const checklistCompletion =
    totalItems > 0 ? (completedItems / totalItems) * 100 : 0;
  const overallReadiness = Math.round(
    packReadiness * 0.6 + checklistCompletion * 0.4,
  );

  logger.info("✅ [ScorecardDB] KPI 3 calculated:", overallReadiness, "%");
  return {
    value: overallReadiness,
    details: {
      total_audits: totalAudits,
      upcoming_audits: parseInt(audits.upcoming) || 0,
      evidence_packs: {
        total: parseInt(evidence.total_packs) || 0,
        ready: readyPacks,
        draft: parseInt(evidence.draft) || 0,
      },
      checklist: {
        total_items: parseInt(checklist.total_items) || 0,
        completed: completedItems,
      },
    },
  };
}

export async function calculateKPI4_QualityGRCHandoff(): Promise<{
  value: number;
  details: any;
}> {
  logger.info(
    "📊 [ScorecardDB] Calculating KPI 4: Quality→GRC Handoff Effectiveness...",
  );

  const result = await pool.query(`
    SELECT 
      COUNT(*) as total_events,
      COUNT(*) FILTER (WHERE status = 'completed') as completed,
      COUNT(*) FILTER (WHERE status = 'failed') as failed,
      COUNT(*) FILTER (WHERE status = 'pending' OR status = 'processing') as pending
    FROM handoff_events
  `);

  const ruleResult = await pool.query(`
    SELECT 
      COUNT(*) as total_rules,
      COUNT(*) FILTER (WHERE is_active = true) as active_rules,
      SUM(trigger_count) as total_triggers
    FROM handoff_rules
  `);

  const stats = result.rows[0];
  const rules = ruleResult.rows[0];

  const totalEvents = parseInt(stats.total_events) || 1;
  const completedEvents = parseInt(stats.completed) || 0;

  const handoffEffectiveness =
    totalEvents > 0 ? Math.round((completedEvents / totalEvents) * 100) : 100;

  logger.info("✅ [ScorecardDB] KPI 4 calculated:", handoffEffectiveness, "%");
  return {
    value: handoffEffectiveness,
    details: {
      total_events: parseInt(stats.total_events) || 0,
      completed: completedEvents,
      failed: parseInt(stats.failed) || 0,
      pending: parseInt(stats.pending) || 0,
      active_rules: parseInt(rules.active_rules) || 0,
      total_triggers: parseInt(rules.total_triggers) || 0,
    },
  };
}

export async function calculateKPI5_RiskRegisterHygiene(): Promise<{
  value: number;
  details: any;
}> {
  logger.info("📊 [ScorecardDB] Calculating KPI 5: Risk Register Hygiene...");

  const result = await pool.query(`
    SELECT 
      COUNT(*) as total_risks,
      COUNT(*) FILTER (WHERE risk_owner IS NOT NULL AND risk_owner != '') as has_owner,
      COUNT(*) FILTER (WHERE status IS NOT NULL) as has_status,
      COUNT(*) FILTER (WHERE next_review_date IS NOT NULL) as has_review_date,
      COUNT(*) FILTER (WHERE next_review_date < NOW() AND status NOT IN ('closed')) as overdue_review,
      COUNT(*) FILTER (WHERE status = 'open') as open_risks,
      COUNT(*) FILTER (WHERE status = 'in_treatment') as in_treatment,
      COUNT(*) FILTER (WHERE status = 'closed') as closed,
      COUNT(*) FILTER (WHERE risk_level = 'critical' OR risk_level = 'high') as high_priority
    FROM enterprise_risks
  `);

  const stats = result.rows[0];
  const totalRisks = parseInt(stats.total_risks) || 1;
  const hasOwner = parseInt(stats.has_owner) || 0;
  const hasStatus = parseInt(stats.has_status) || 0;
  const hasReviewDate = parseInt(stats.has_review_date) || 0;
  const overdueReview = parseInt(stats.overdue_review) || 0;

  const ownerScore = (hasOwner / totalRisks) * 100;
  const statusScore = (hasStatus / totalRisks) * 100;
  const reviewScore = ((totalRisks - overdueReview) / totalRisks) * 100;

  const hygieneScore = Math.round(
    ownerScore * 0.4 + statusScore * 0.3 + reviewScore * 0.3,
  );

  logger.info("✅ [ScorecardDB] KPI 5 calculated:", hygieneScore, "%");
  return {
    value: hygieneScore,
    details: {
      total_risks: parseInt(stats.total_risks) || 0,
      with_owner: hasOwner,
      with_status: hasStatus,
      with_review_date: hasReviewDate,
      overdue_reviews: overdueReview,
      by_status: {
        open: parseInt(stats.open_risks) || 0,
        in_treatment: parseInt(stats.in_treatment) || 0,
        closed: parseInt(stats.closed) || 0,
      },
      high_priority_count: parseInt(stats.high_priority) || 0,
    },
  };
}

export async function calculateKPI6_ExecutiveReportingReadiness(): Promise<{
  value: number;
  details: any;
}> {
  logger.info(
    "📊 [ScorecardDB] Calculating KPI 6: Executive GRC Reporting Readiness...",
  );

  const policyStats = await pool.query(
    `SELECT COUNT(*) as count FROM policies WHERE status = 'published'`,
  );
  const riskStats = await pool.query(
    `SELECT COUNT(*) as count FROM enterprise_risks WHERE status != 'closed'`,
  );
  const complianceStats = await pool.query(
    `SELECT COUNT(*) as count FROM obligations WHERE status = 'applicable'`,
  );
  const auditStats = await pool.query(
    `SELECT COUNT(*) as count FROM audits WHERE status NOT IN ('closed')`,
  );

  const reportResult = await pool.query(`
    SELECT 
      COUNT(*) as total_reports,
      COUNT(*) FILTER (WHERE status = 'approved' OR status = 'published') as approved,
      COUNT(*) FILTER (WHERE status = 'draft') as draft,
      MAX(created_at) as last_report_date
    FROM executive_reports
  `);

  const reports = reportResult.rows[0];

  const hasRecentData =
    parseInt(policyStats.rows[0].count) > 0 ||
    parseInt(riskStats.rows[0].count) > 0 ||
    parseInt(complianceStats.rows[0].count) > 0;

  const dataQualityScore = hasRecentData ? 80 : 40;
  const reportApprovalRate =
    parseInt(reports.total_reports) > 0
      ? (parseInt(reports.approved) / parseInt(reports.total_reports)) * 100
      : 50;

  const readinessScore = Math.round(
    dataQualityScore * 0.6 + reportApprovalRate * 0.4,
  );

  logger.info("✅ [ScorecardDB] KPI 6 calculated:", readinessScore, "%");
  return {
    value: readinessScore,
    details: {
      data_sources: {
        policies: parseInt(policyStats.rows[0].count) || 0,
        risks: parseInt(riskStats.rows[0].count) || 0,
        compliance: parseInt(complianceStats.rows[0].count) || 0,
        audits: parseInt(auditStats.rows[0].count) || 0,
      },
      reports: {
        total: parseInt(reports.total_reports) || 0,
        approved: parseInt(reports.approved) || 0,
        draft: parseInt(reports.draft) || 0,
      },
      last_report_date: reports.last_report_date,
    },
  };
}

export async function getMohammedScorecard(): Promise<{
  employee: { name: string; role: string; mission: string };
  overall_score: number;
  weighted_score: number;
  kpis: MohammedKPI[];
  generated_at: Date;
}> {
  logger.info("📊 [ScorecardDB] Generating Sample User...");

  const kpi1 = await calculateKPI1_GovernanceDocLifecycle();
  const kpi2 = await calculateKPI2_ComplianceObligationTracking();
  const kpi3 = await calculateKPI3_AuditEvidencePackReadiness();
  const kpi4 = await calculateKPI4_QualityGRCHandoff();
  const kpi5 = await calculateKPI5_RiskRegisterHygiene();
  const kpi6 = await calculateKPI6_ExecutiveReportingReadiness();

  const getStatus = (value: number): "green" | "amber" | "red" | "no_data" => {
    if (value >= 85) return "green";
    if (value >= 70) return "amber";
    return "red";
  };

  const kpis: MohammedKPI[] = [
    {
      kpi_id: "MAM-KPI-01",
      kpi_name: "Governance Documentation Lifecycle",
      weight: 20,
      description:
        "Ensure all documents follow: Draft → Review → Approval → Publish → Periodic Review",
      measurement: "% of documents compliant with lifecycle requirements",
      current_value: kpi1.value,
      target: 95,
      status: getStatus(kpi1.value),
      trend: "stable",
      data_sources: ["Policies Dashboard", "Policy Review Cycles"],
      navigation_map: [
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
          screen: "ExampleOrg",
          route: "/qms",
          what_to_check: "Log follow-up action taken",
          if_result: "Issue tracked",
          then_action: "Set reminder for next check",
        },
      ],
      last_updated: new Date(),
    },
    {
      kpi_id: "MAM-KPI-02",
      kpi_name: "Compliance Obligation Tracking Accuracy",
      weight: 20,
      description:
        "Accuracy of compliance mapping across PDPL, ISO 27001, NCA, COPC",
      measurement: "% of obligations with owner + evidence + status",
      current_value: kpi2.value,
      target: 95,
      status: getStatus(kpi2.value),
      trend: "stable",
      data_sources: ["Compliance Dashboard", "Obligations Table"],
      navigation_map: [
        {
          step: 1,
          action: "Open Compliance Dashboard",
          screen: "Compliance & Regulatory Tracker",
          route: "/compliance",
          what_to_check: "Review obligation summary by regulation",
          if_result: "Missing mappings for PDPL/NCA/ISO",
          then_action: "Flag to Sample User (GRC Manager) for review",
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
      ],
      last_updated: new Date(),
    },
    {
      kpi_id: "MAM-KPI-03",
      kpi_name: "Audit Evidence Pack Readiness",
      weight: 20,
      description: "Audit readiness before internal/external audits begin",
      measurement: "% of audits with complete evidence packs pre-audit",
      current_value: kpi3.value,
      target: 100,
      status: getStatus(kpi3.value),
      trend: "stable",
      data_sources: ["Audit Readiness Dashboard", "Evidence Packs"],
      navigation_map: [
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
      ],
      last_updated: new Date(),
    },
    {
      kpi_id: "MAM-KPI-04",
      kpi_name: "Quality → GRC Handoff Effectiveness",
      weight: 15,
      description: "Proper handoff of Quality findings into GRC tracking",
      measurement: "% of critical findings logged and tracked to closure",
      current_value: kpi4.value,
      target: 95,
      status: getStatus(kpi4.value),
      trend: "stable",
      data_sources: ["Quality-GRC Handoff Engine", "Handoff Events"],
      navigation_map: [
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
          then_action: "Log in GRC tracker manually, assign to HR/Sample User",
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
      ],
      last_updated: new Date(),
    },
    {
      kpi_id: "MAM-KPI-05",
      kpi_name: "Risk Register Hygiene Support",
      weight: 15,
      description: "Maintain cleanliness of risk register",
      measurement: "% of risks with owner, status, and review date",
      current_value: kpi5.value,
      target: 100,
      status: getStatus(kpi5.value),
      trend: "stable",
      data_sources: ["Enterprise Risk Register", "Risk Treatment Actions"],
      navigation_map: [
        {
          step: 1,
          action: "Review Risk Register",
          screen: "Enterprise Risk Register",
          route: "/risks",
          what_to_check: "Identify risks missing owner field",
          if_result: "Risk without owner detected",
          then_action: "Flag to Sample User for owner assignment",
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
      ],
      last_updated: new Date(),
    },
    {
      kpi_id: "MAM-KPI-06",
      kpi_name: "Executive GRC Reporting Readiness",
      weight: 10,
      description: "Accuracy and timeliness of executive GRC views",
      measurement: "Timely, error-free dashboards and summaries",
      current_value: kpi6.value,
      target: 95,
      status: getStatus(kpi6.value),
      trend: "stable",
      data_sources: ["Executive Dashboard", "GRC Control Tower", "KPI Engine"],
      navigation_map: [
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
      ],
      last_updated: new Date(),
    },
  ];

  const totalWeight = kpis.reduce((sum, k) => sum + k.weight, 0);
  const weightedSum = kpis.reduce(
    (sum, k) => sum + k.current_value * k.weight,
    0,
  );
  const weightedScore = Math.round(weightedSum / totalWeight);
  const overallScore = Math.round(
    kpis.reduce((sum, k) => sum + k.current_value, 0) / kpis.length,
  );

  logger.info(
    "✅ [ScorecardDB] Scorecard generated. Overall:",
    overallScore,
    "%, Weighted:",
    weightedScore,
    "%",
  );

  return {
    employee: {
      name: "Sample User",
      role: "Quality & GRC Governance Officer",
      mission:
        "Ensure governance discipline, visibility & readiness — NOT execution",
    },
    overall_score: overallScore,
    weighted_score: weightedScore,
    kpis,
    generated_at: new Date(),
  };
}

export async function saveScorecard(
  scorecard: ScorecardSnapshot,
): Promise<ScorecardSnapshot> {
  logger.info("📝 [ScorecardDB] Saving scorecard snapshot...");

  const result = await pool.query(
    `
    INSERT INTO employee_scorecards (employee_name, employee_role, period_start, period_end, overall_score, weighted_score, kpi_details)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
  `,
    [
      scorecard.employee_name,
      scorecard.employee_role,
      scorecard.period_start,
      scorecard.period_end,
      scorecard.overall_score,
      scorecard.weighted_score,
      JSON.stringify(scorecard.kpi_details),
    ],
  );

  return result.rows[0];
}

export async function getScorecardHistory(
  employeeName: string,
  limit: number = 12,
): Promise<ScorecardSnapshot[]> {
  const result = await pool.query(
    `
    SELECT * FROM employee_scorecards 
    WHERE employee_name = $1 
    ORDER BY period_end DESC 
    LIMIT $2
  `,
    [employeeName, limit],
  );
  return result.rows;
}
