/**
 * Deal Stage Aging Compliance — flags Deals that have been sitting in a
 * Sales pipeline stage longer than the WalaPlus Sales SOP allows.
 *
 * Mirrors the CS Lifecycle compliance engine but applies the per-stage
 * SLA spec from salesStageSlaSpec.ts. Pure per-record evaluation;
 * scanDealStageAgingViolations() in duplicateRadarDatabase.ts wraps this
 * over the duplicate_records corpus.
 *
 * For first ship we approximate "stage entered at" with the Deal's
 * Modified_Time — the same proxy CS Lifecycle uses for phase entry.
 * Edge case: a non-stage field edit also bumps Modified_Time, which
 * under-reports aging on those deals. Acceptable for v1; the upgrade
 * path is to integrate Zoho's Stage_History audit log (zohoAging.ts
 * already pulls it) and persist entered_stage_at per deal.
 */

import {
  StageAgingSeverity,
  getStageSlaSpec,
  gradeStageAging,
  isTerminalSalesStage,
  measureAging,
} from "./salesStageSlaSpec";

export type DealStageAgingCode =
  | "stage_overdue_warning"
  | "stage_overdue_critical";

export interface DealStageAgingViolation {
  code: DealStageAgingCode;
  severity: StageAgingSeverity;
  message: string;
  stage: string;
  unit: "business_days" | "calendar_days";
  aging_units: number;
  aging_calendar_days: number;
  sla_units: number;
  warn_threshold: number | null;
  crit_threshold: number | null;
  clause_ref: string;
  suggested_action: string;
}

export interface DealStageAgingEvaluation {
  is_tracked_stage: boolean;
  is_terminal: boolean;
  current_stage: string | null;
  aging_calendar_days: number | null;
  aging_units: number | null;
  unit: "business_days" | "calendar_days" | null;
  violation: DealStageAgingViolation | null;
}

export interface DealStageAgingInput {
  stage: string | null | undefined;
  modified_date?: string | Date | null;
  created_time?: string | Date | null;
  /** Optional override — supply when zohoAging-style Stage_History is available. */
  entered_stage_at?: string | Date | null;
}

function suggestedActionFor(stage: string, severity: StageAgingSeverity): string {
  const stageL = stage.toLowerCase();
  if (severity === "critical") {
    if (stageL === "not attend meeting") {
      return "SDR reschedule window is past breach — escalate to the Sales Manager and either reconfirm a meeting date or close the lead with the appropriate Lost reason.";
    }
    if (stageL === "meeting") {
      return "Meeting workflow has run past 1.5× SLA — complete the meeting documentation now or move the deal to On Hold / Closed Lost.";
    }
    if (stageL === "on hold") {
      return "On Hold has exceeded 6 months — per SOP §7.3.11 this deal must move to an active stage (Proposal / Agreement Sent) or be closed.";
    }
    if (stageL === "proposal") {
      return "Proposal has been outstanding past 1.5× the SOP allowance (3 months × 1.5 = ~4.5 months). Confirm with the client this week or close the deal.";
    }
    if (stageL === "agreement sent") {
      return "Agreement Sent has run past 1.5× SLA (3 months × 1.5 = ~4.5 months). Chase the signature today or revert to Proposal / close the deal.";
    }
    return `Deal in ${stage} has breached its SOP SLA past the critical band — escalate or move it.`;
  }
  return `Deal in ${stage} has crossed the SOP SLA threshold. Confirm the next action with the deal owner so it doesn't slip into the critical band.`;
}

export function evaluateDealStageAging(
  input: DealStageAgingInput,
  now: Date = new Date(),
): DealStageAgingEvaluation {
  const stage = (input.stage ?? "").trim();
  if (!stage) {
    return {
      is_tracked_stage: false,
      is_terminal: false,
      current_stage: null,
      aging_calendar_days: null,
      aging_units: null,
      unit: null,
      violation: null,
    };
  }

  const terminal = isTerminalSalesStage(stage);
  const spec = getStageSlaSpec(stage);
  if (terminal || !spec) {
    return {
      is_tracked_stage: !!spec,
      is_terminal: terminal,
      current_stage: stage,
      aging_calendar_days: null,
      aging_units: null,
      unit: spec?.unit ?? null,
      violation: null,
    };
  }

  const enteredAt =
    input.entered_stage_at ?? input.modified_date ?? input.created_time ?? null;
  if (!enteredAt) {
    return {
      is_tracked_stage: true,
      is_terminal: false,
      current_stage: stage,
      aging_calendar_days: null,
      aging_units: null,
      unit: spec.unit,
      violation: null,
    };
  }

  const aging = measureAging(stage, enteredAt, now);
  const grade = gradeStageAging(stage, aging);

  let violation: DealStageAgingViolation | null = null;
  if (grade.severity !== "info") {
    const code: DealStageAgingCode =
      grade.severity === "critical"
        ? "stage_overdue_critical"
        : "stage_overdue_warning";
    const unitLabel = aging.unit === "business_days" ? "business days" : "days";
    const slaLabel =
      aging.unit === "business_days"
        ? `${spec.sla} business days`
        : `${spec.sla} days`;
    const bandNote =
      grade.severity === "critical"
        ? grade.critThreshold != null
          ? ` (past critical threshold of ${grade.critThreshold} ${unitLabel})`
          : ""
        : "";
    violation = {
      code,
      severity: grade.severity,
      message: `Deal in stage "${stage}" has aged ${aging.agingUnits} ${unitLabel} — Sales SOP §${spec.clauseRef} allows ${slaLabel}${bandNote}.`,
      stage,
      unit: aging.unit,
      aging_units: aging.agingUnits,
      aging_calendar_days: aging.agingCalendarDays,
      sla_units: spec.sla,
      warn_threshold: grade.warnThreshold,
      crit_threshold: grade.critThreshold,
      clause_ref: spec.clauseRef,
      suggested_action: suggestedActionFor(stage, grade.severity),
    };
  }

  return {
    is_tracked_stage: true,
    is_terminal: false,
    current_stage: stage,
    aging_calendar_days: aging.agingCalendarDays,
    aging_units: aging.agingUnits,
    unit: aging.unit,
    violation,
  };
}

export interface DealStageAgingSummary {
  total_evaluated: number;
  total_tracked_deals: number;
  total_violations: number;
  by_severity: Record<StageAgingSeverity, number>;
  by_stage: Record<string, number>;
  by_clause: Record<string, number>;
}

export function summarizeDealStageAging(
  evaluations: DealStageAgingEvaluation[],
): DealStageAgingSummary {
  const s: DealStageAgingSummary = {
    total_evaluated: evaluations.length,
    total_tracked_deals: 0,
    total_violations: 0,
    by_severity: { info: 0, warning: 0, critical: 0 },
    by_stage: {},
    by_clause: {},
  };
  for (const ev of evaluations) {
    if (ev.is_tracked_stage) s.total_tracked_deals++;
    if (ev.violation) {
      s.total_violations++;
      s.by_severity[ev.violation.severity]++;
      s.by_stage[ev.violation.stage] =
        (s.by_stage[ev.violation.stage] ?? 0) + 1;
      s.by_clause[ev.violation.clause_ref] =
        (s.by_clause[ev.violation.clause_ref] ?? 0) + 1;
    }
  }
  return s;
}
