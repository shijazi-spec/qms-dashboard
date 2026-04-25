/**
 * Typed factory helpers for vitest tests under tests/vitest/. Each helper
 * returns a fully-typed instance of the corresponding interface from the
 * application code, with sensible defaults that callers can override per
 * test. Lets test files build minimal-but-typed fixtures without resorting
 * to `as any` casts.
 */
import type {
  CapaRecord,
  CapaActionItem,
  NonconformanceRecord,
  TrainingRecord,
  TrainingAssignment,
  DealEvaluationRecord,
} from "../../src/utils/qmsDatabase";
import type { EvaluationFramework } from "../../src/utils/evaluationSchema";
import type {
  AdminActivity,
  GovernanceDocument,
  QualityScorecard,
  ScorecardAttribute,
  WorkflowRun,
  SystemEvent,
  TeamFeedback,
} from "../../src/utils/database";
import type { KPIDefinition, KPIValue, ExecutiveReport } from "../../src/utils/kpiDatabase";
import type {
  PMPProject,
  ProjectRisk,
  ProjectMilestone,
  ProjectStakeholder,
  ProjectProcurement,
  ProjectChangeRequest,
} from "../../src/utils/teamDatabase";
import type {
  CallRecord,
  CallTranscript,
  CallAnalysis,
  CallQAScore,
  CallCompliance,
  MeetingMOM,
} from "../../src/utils/callIntelligenceDb";
import type { MohammedKPI, ScorecardSnapshot } from "../../src/utils/scorecardDatabase";

export function makeCapa(overrides: Partial<CapaRecord> = {}): CapaRecord {
  return {
    id: 1,
    capa_number: "CAPA-2026-0001",
    title: "Test CAPA",
    capa_type: "corrective",
    severity: "minor",
    status: "open",
    priority: "medium",
    ...overrides,
  };
}

export function makeCapaActionItem(
  overrides: Partial<CapaActionItem> = {},
): CapaActionItem {
  return {
    id: 1,
    capa_id: 1,
    action_number: 1,
    description: "Test action",
    action_type: "corrective",
    status: "pending",
    ...overrides,
  };
}

export function makeNonconformance(
  overrides: Partial<NonconformanceRecord> = {},
): NonconformanceRecord {
  return {
    id: 1,
    nc_number: "NC-2026-0001",
    title: "Test NC",
    nc_type: "process",
    severity: "minor",
    status: "open",
    ...overrides,
  };
}

export function makeTrainingRecord(
  overrides: Partial<TrainingRecord> = {},
): TrainingRecord {
  return {
    id: 1,
    training_id: "T-1",
    title: "Test Training",
    training_type: "onboarding",
    ...overrides,
  };
}

export function makeTrainingAssignment(
  overrides: Partial<TrainingAssignment> = {},
): TrainingAssignment {
  return {
    id: 1,
    training_id: "T-1",
    employee_id: "E-1",
    employee_name: "Test Employee",
    status: "assigned",
    ...overrides,
  };
}

export function makeDealEvaluation(
  overrides: Partial<DealEvaluationRecord> = {},
): DealEvaluationRecord {
  return {
    id: 1,
    deal_id: "D-1",
    ...overrides,
  };
}

export function makeFramework(
  overrides: Partial<EvaluationFramework> = {},
): EvaluationFramework {
  return {
    id: "fw-1",
    name: "Test Framework",
    version: "v1",
    description: "",
    standards: [],
    dimensions: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

export function makeGovernanceDocument(
  overrides: Partial<GovernanceDocument> = {},
): GovernanceDocument {
  return {
    id: 1,
    name: "Test Document",
    document_type: "sales",
    version: "v1",
    is_active: true,
    ...overrides,
  };
}

export function makeScorecard(
  overrides: Partial<QualityScorecard> = {},
): QualityScorecard {
  return {
    id: 1,
    name: "Test Scorecard",
    dimensions: {},
    is_active: true,
    ...overrides,
  };
}

export function makeScorecardAttribute(
  overrides: Partial<ScorecardAttribute> = {},
): ScorecardAttribute {
  return {
    id: 1,
    scorecard_id: 1,
    dimension: "people",
    attribute_name: "Test Attribute",
    weight: 10,
    is_active: true,
    order_index: 0,
    ...overrides,
  };
}

export function makeAdminActivity(
  overrides: Partial<AdminActivity> = {},
): AdminActivity {
  return {
    id: 1,
    action_type: "test_action",
    action_description: "Test action description",
    ...overrides,
  };
}

export function makeWorkflowRun(
  overrides: Partial<WorkflowRun> = {},
): WorkflowRun {
  return {
    id: 1,
    workflow_id: "wf-1",
    workflow_name: "Test Workflow",
    status: "completed",
    trigger_type: "manual",
    ...overrides,
  };
}

export function makeSystemEvent(
  overrides: Partial<SystemEvent> = {},
): SystemEvent {
  return {
    id: 1,
    event_type: "test_event",
    event_category: "test",
    description: "Test event",
    severity: "info",
    ...overrides,
  };
}

export function makeTeamFeedback(overrides: Partial<TeamFeedback> = {}): TeamFeedback {
  return {
    submitter_name: "Test User",
    dashboard: "kpi",
    rating: 4,
    ...overrides,
  };
}

export function makeKPIDefinition(overrides: Partial<KPIDefinition> = {}): KPIDefinition {
  return {
    kpi_name: "Test KPI",
    kpi_code: "KPI-TEST-01",
    description: "Test KPI description",
    owner_type: "quality_manager",
    category: "quality",
    unit: "%",
    frequency: "monthly",
    threshold_green: 90,
    threshold_amber: 75,
    threshold_red: 60,
    threshold_direction: "higher_is_better",
    is_active: true,
    ...overrides,
  };
}

export function makeKPIValue(overrides: Partial<KPIValue> = {}): KPIValue {
  return {
    kpi_id: 1,
    period_start: new Date("2026-01-01"),
    period_end: new Date("2026-01-31"),
    actual_value: 85,
    status: "green",
    ...overrides,
  };
}

export function makeExecutiveReport(overrides: Partial<ExecutiveReport> = {}): ExecutiveReport {
  return {
    report_type: "mbr",
    period_name: "2026-Q1",
    period_start: new Date("2026-01-01"),
    period_end: new Date("2026-03-31"),
    overall_health_score: 82,
    status: "draft",
    ...overrides,
  };
}

export function makePMPProject(overrides: Partial<PMPProject> = {}): PMPProject {
  return {
    project_id: "p-1",
    project_name: "Test Project",
    project_code: "PROJ-01",
    project_type: "governance",
    department: "Quality",
    project_manager_id: "mgr-1",
    project_manager_name: "Test Manager",
    status: "planning",
    priority: "medium",
    ...overrides,
  };
}

export function makeCallRecord(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    call_id: "call-test-01",
    source: "five9",
    agent_email: "agent@example.com",
    direction: "outbound",
    status: "pending",
    ...overrides,
  };
}

export function makeProjectRisk(overrides: Partial<ProjectRisk> = {}): ProjectRisk {
  return {
    risk_id: "r-1",
    project_id: "p-1",
    title: "Test Risk",
    description: "Test risk description",
    category: "technical",
    probability: "medium",
    impact: "medium",
    status: "identified",
    response_strategy: "mitigate",
    ...overrides,
  };
}

export function makeProjectMilestone(
  overrides: Partial<ProjectMilestone> = {},
): ProjectMilestone {
  return {
    milestone_id: "m-1",
    project_id: "p-1",
    name: "Test Milestone",
    milestone_type: "deliverable",
    planned_date: new Date("2026-06-01"),
    status: "pending",
    approval_required: false,
    percent_complete: 0,
    weight: 1,
    ...overrides,
  };
}

export function makeProjectStakeholder(
  overrides: Partial<ProjectStakeholder> = {},
): ProjectStakeholder {
  return {
    stakeholder_id: "s-1",
    project_id: "p-1",
    name: "Test Stakeholder",
    role: "Sponsor",
    stakeholder_type: "internal",
    influence: "medium",
    interest: "medium",
    engagement_level: "neutral",
    desired_engagement: "supportive",
    communication_frequency: "weekly",
    communication_method: "email",
    is_decision_maker: false,
    ...overrides,
  };
}

export function makeProjectProcurement(
  overrides: Partial<ProjectProcurement> = {},
): ProjectProcurement {
  return {
    procurement_id: "pc-1",
    project_id: "p-1",
    title: "Test Procurement",
    procurement_type: "contract",
    status: "draft",
    approval_required: false,
    renewal_option: false,
    ...overrides,
  };
}

export function makeProjectChangeRequest(
  overrides: Partial<ProjectChangeRequest> = {},
): ProjectChangeRequest {
  return {
    change_request_id: "cr-1",
    project_id: "p-1",
    title: "Test Change Request",
    description: "Test change request description",
    change_type: "scope",
    change_category: "enhancement",
    priority: "medium",
    status: "draft",
    baseline_update_required: false,
    ...overrides,
  };
}

export function makeCallTranscript(
  overrides: Partial<CallTranscript> = {},
): CallTranscript {
  return {
    call_record_id: 1,
    transcript_text: "Test transcript text",
    ...overrides,
  };
}

export function makeCallAnalysis(overrides: Partial<CallAnalysis> = {}): CallAnalysis {
  return {
    call_record_id: 1,
    sentiment_score: 0.5,
    sentiment_label: "neutral",
    ...overrides,
  };
}

export function makeCallQAScore(overrides: Partial<CallQAScore> = {}): CallQAScore {
  return {
    call_record_id: 1,
    scorecard_type: "sdr",
    total_score: 80,
    max_score: 100,
    score_percentage: 80,
    ...overrides,
  };
}

export function makeCallCompliance(
  overrides: Partial<CallCompliance> = {},
): CallCompliance {
  return {
    call_record_id: 1,
    notes_updated: true,
    call_logged: true,
    task_created: false,
    stage_updated: false,
    meeting_outcome_logged: false,
    overall_compliance: false,
    compliance_score: 50,
    ...overrides,
  };
}

export function makeMeetingMOM(overrides: Partial<MeetingMOM> = {}): MeetingMOM {
  return {
    calendar_event_id: "evt-1",
    meeting_title: "Test Meeting",
    meeting_date: new Date("2026-01-15"),
    summary: "Test meeting summary",
    ...overrides,
  };
}

export function makeMohammedKPI(overrides: Partial<MohammedKPI> = {}): MohammedKPI {
  return {
    kpi_id: "MAM-KPI-TEST",
    kpi_name: "Test Mohammed KPI",
    weight: 10,
    description: "Test KPI description",
    measurement: "% of test items",
    current_value: 80,
    target: 95,
    status: "amber",
    trend: "stable",
    navigation_map: [],
    data_sources: [],
    last_updated: new Date("2026-01-01"),
    ...overrides,
  };
}

export function makeScorecardSnapshot(
  overrides: Partial<ScorecardSnapshot> = {},
): ScorecardSnapshot {
  return {
    employee_name: "Mohammed Al Muzaini",
    employee_role: "Head of Operations",
    period_start: new Date("2026-01-01"),
    period_end: new Date("2026-01-31"),
    overall_score: 85,
    weighted_score: 82,
    kpi_details: [],
    ...overrides,
  };
}
