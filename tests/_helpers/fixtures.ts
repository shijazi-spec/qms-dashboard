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
  WorkflowRun,
  SystemEvent,
} from "../../src/utils/database";

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
