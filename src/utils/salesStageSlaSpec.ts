/**
 * Sales Stage SLA Spec — single source of truth for the Deals Lifecycle tab.
 *
 * Drives stage-aging compliance: given a Deal's current Stage and how long
 * it has been there, decide whether it is within SLA, in the early-warning
 * band, or breaching SOP. Each entry carries the reference clause so an
 * auditor can trace every flag back to the document.
 *
 * Source: Sales Management Process v1.2 (08.12.2025) — the "Stage Duration
 * (Timeframe)" table:
 *
 *   Not Attend Meeting   ≤ 5 Business Days   §7.2.8
 *   Meeting              ≤ 10 Business Days  §7.3
 *   On Hold              3 - 6 Months        §7.3.11
 *   Proposal             3 Months            §7.4.2
 *   Agreement Sent       3 Months            §7.5.1
 *
 * Verified against v1.1 (01.12.2025) on 2026-08-19: the stage table is
 * byte-identical between the two — same five stages, same durations, same
 * clause numbers. v1.2's only change was the Sales Commission Scheme (pages
 * 31-35), which this spec does not model. So the VALUES below did not move;
 * only the citation was stale, and nothing here needed recalculating.
 *
 * Terminal stages (Agreement Signed, Closed Won, Closed Lost) have no
 * SLA — once a deal enters them, aging freezes. "Paid" is treated as
 * Agreement Signed per the existing GRQ business rule (see Deal Compliance
 * memory: Paid == Agreement Signed by business rule).
 *
 * Pure functions only — no DB, no Zoho. Tests exercise edge cases.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type SlaUnit = "business_days" | "calendar_days";
export type StageAgingSeverity = "info" | "warning" | "critical";

export interface StageSlaSpec {
  stage: string;
  unit: SlaUnit;
  sla: number;
  clauseRef: string;
  description: string;
  warnBandMultiplier?: number;
  critBandMultiplier?: number;
  warnDays?: number;
  critDays?: number;
}

const DEFAULT_WARN_MULTIPLIER = 1.0;
const DEFAULT_CRIT_MULTIPLIER = 1.5;

/**
 * Catch-all SLA (2026-06-18, Ahmad) for ANY OPEN stage that has no explicit
 * SOP duration — so a deal parked in a non-SOP stage (Qualification,
 * Negotiation, Awaiting PO, a custom pipeline stage, …) for months is still
 * surfaced, not silently ignored. Terminal stages (Agreement Signed / Paid /
 * Closed Won / Closed Lost) still freeze and never use this. Generic watch:
 * warning at 90 calendar days, critical past 135 (1.5×). Tune `sla` here.
 */
export const DEFAULT_OPEN_STAGE_SLA: StageSlaSpec = {
  stage: "*",
  unit: "calendar_days",
  sla: 30,
  clauseRef: "—",
  warnDays: 30,
  critDays: 120,
  description:
    "No SOP-defined duration for this stage — generic stuck-deal watch: WARNING past 30 calendar days, CRITICAL past 120 (aging buckets 30 / 60 / 90 / 120+).",
};

/** Aging bucket label (30 / 60 / 90 / 120+) for the generic open-stage watch. */
export function openStageAgingBucket(calendarDays: number): string {
  if (calendarDays >= 120) return "120+";
  if (calendarDays >= 90) return "90+";
  if (calendarDays >= 60) return "60+";
  if (calendarDays >= 30) return "30+";
  return "<30";
}

export const SALES_STAGE_SLA_SPEC: ReadonlyArray<StageSlaSpec> = [
  {
    stage: "Not Attend Meeting",
    unit: "business_days",
    sla: 5,
    clauseRef: "7.2.8",
    description: "SDR reschedule window — within 5 business days of the missed meeting.",
  },
  {
    stage: "Meeting",
    unit: "business_days",
    sla: 10,
    clauseRef: "7.3",
    description: "Sales Agent has up to 10 business days (max 2 weeks) to complete the meeting workflow.",
  },
  {
    stage: "On Hold",
    unit: "calendar_days",
    sla: 90,
    clauseRef: "7.3.11",
    description: "On Hold is acceptable 3 to 6 months based on reason. Past 6 months the deal must move or close.",
    warnDays: 90,
    critDays: 180,
  },
  {
    stage: "Proposal",
    unit: "calendar_days",
    sla: 90,
    clauseRef: "7.4.2",
    description: "Proposal sent and being followed up — SOP allows up to 3 months before escalation.",
  },
  {
    stage: "Agreement Sent",
    unit: "calendar_days",
    sla: 90,
    clauseRef: "7.5.1",
    description: "Service Agreement sent for signature — SOP allows up to 3 months before chasing or closing.",
  },
];

const STAGE_LOOKUP: Map<string, StageSlaSpec> = new Map(
  SALES_STAGE_SLA_SPEC.map((s) => [s.stage.toLowerCase(), s]),
);

export const TERMINAL_SALES_STAGES: ReadonlyArray<string> = [
  "Agreement Signed",
  "Paid",
  "Closed Won",
  "Closed Lost",
];

const TERMINAL_LOOKUP: Set<string> = new Set(
  TERMINAL_SALES_STAGES.map((s) => s.toLowerCase()),
);

export function isTerminalSalesStage(stage: string | null | undefined): boolean {
  if (!stage) return false;
  return TERMINAL_LOOKUP.has(stage.trim().toLowerCase());
}

export function getStageSlaSpec(stage: string | null | undefined): StageSlaSpec | null {
  if (!stage) return null;
  return STAGE_LOOKUP.get(stage.trim().toLowerCase()) ?? null;
}

/**
 * Business-day count between two dates (Mon–Fri, weekends skipped).
 *
 * Uses UTC day boundaries — matches zohoAging.ts conventions and avoids
 * timezone drift when the deploy runs in UTC and operators read in KSA
 * (UTC+3). A deal entering a stage on Friday 23:30 KSA and read on
 * Monday 09:00 KSA reads as 1 business day (Friday → Monday).
 */
export function businessDaysBetween(fromIso: string | Date, toIso: string | Date): number {
  const from = fromIso instanceof Date ? fromIso : new Date(fromIso);
  const to = toIso instanceof Date ? toIso : new Date(toIso);
  if (isNaN(from.getTime()) || isNaN(to.getTime())) return 0;
  if (to.getTime() <= from.getTime()) return 0;

  const startUtcMs = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const endUtcMs = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  const totalCalendarDays = Math.floor((endUtcMs - startUtcMs) / MS_PER_DAY);
  if (totalCalendarDays <= 0) return 0;

  const fullWeeks = Math.floor(totalCalendarDays / 7);
  let businessDays = fullWeeks * 5;
  const remainder = totalCalendarDays % 7;

  const startDow = new Date(startUtcMs).getUTCDay();
  for (let i = 1; i <= remainder; i++) {
    const dow = (startDow + i) % 7;
    if (dow !== 0 && dow !== 6) businessDays++;
  }

  return businessDays;
}

export function calendarDaysBetween(fromIso: string | Date, toIso: string | Date): number {
  const from = fromIso instanceof Date ? fromIso : new Date(fromIso);
  const to = toIso instanceof Date ? toIso : new Date(toIso);
  if (isNaN(from.getTime()) || isNaN(to.getTime())) return 0;
  if (to.getTime() <= from.getTime()) return 0;
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);
}

export interface AgingMeasurement {
  unit: SlaUnit;
  /** Number of units (business or calendar days) the deal has spent in this stage. */
  agingUnits: number;
  /** Always populated for cross-stage comparison + UI display. */
  agingCalendarDays: number;
}

export function measureAging(
  stage: string,
  enteredStageAt: string | Date,
  now: string | Date = new Date(),
): AgingMeasurement {
  const spec = getStageSlaSpec(stage);
  const unit: SlaUnit = spec?.unit ?? "calendar_days";
  const calendar = calendarDaysBetween(enteredStageAt, now);
  const agingUnits =
    unit === "business_days"
      ? businessDaysBetween(enteredStageAt, now)
      : calendar;
  return { unit, agingUnits, agingCalendarDays: calendar };
}

export interface GradeResult {
  severity: StageAgingSeverity;
  slaUnits: number | null;
  warnThreshold: number | null;
  critThreshold: number | null;
  isTerminal: boolean;
  isUnknownStage: boolean;
}

/**
 * Grade a deal's stage aging against the SOP.
 *
 * Returns:
 *   info     — within SLA (≤ warnThreshold)
 *   warning  — between warn and crit thresholds (early-warning band)
 *   critical — past crit threshold (clear breach)
 *
 * Terminal stages return info with isTerminal=true (no SLA to breach).
 * Unknown stages return info with isUnknownStage=true so the caller can
 * decide whether to surface them (default: not in the tab).
 */
export function gradeStageAging(
  stage: string | null | undefined,
  aging: AgingMeasurement,
): GradeResult {
  if (isTerminalSalesStage(stage)) {
    return {
      severity: "info",
      slaUnits: null,
      warnThreshold: null,
      critThreshold: null,
      isTerminal: true,
      isUnknownStage: false,
    };
  }
  // Non-terminal stages with no explicit SOP duration fall back to the
  // generic catch-all SLA so a deal stuck in any open stage is still graded.
  const specced = getStageSlaSpec(stage);
  const spec = specced ?? DEFAULT_OPEN_STAGE_SLA;
  const warnThreshold = spec.warnDays ?? spec.sla * (spec.warnBandMultiplier ?? DEFAULT_WARN_MULTIPLIER);
  const critThreshold = spec.critDays ?? spec.sla * (spec.critBandMultiplier ?? DEFAULT_CRIT_MULTIPLIER);
  let severity: StageAgingSeverity = "info";
  if (aging.agingUnits > critThreshold) severity = "critical";
  else if (aging.agingUnits > warnThreshold) severity = "warning";
  return {
    severity,
    slaUnits: spec.sla,
    warnThreshold,
    critThreshold,
    isTerminal: false,
    isUnknownStage: !specced,
  };
}

/**
 * The source document these SLAs come from, so a KPI detail page can name the
 * process it grades against instead of showing an empty "Data source".
 *
 * Now a controlled document: registered in Document Control on 2026-08-19 under
 * `WalaPlus_Sales`. It predates the WP-BU-<FN>-SOP-<NNN> coding scheme and so
 * carries no formal code — `reference` is the Document Control number, not an
 * invented one. Update it here if a code is later assigned.
 *
 * `WP-SOP Sales v1.1 / 01.12.2025` was the previous value and was stale: v1.2
 * superseded it on 08.12.2025. The stage durations were unaffected (see the
 * file header), so this was a citation fix, not a threshold change.
 */
export const SALES_SOP_DOCUMENT = {
  title: "Sales Management Process",
  reference: "WalaPlus_Sales",
  version: "1.2",
  issued: "08.12.2025",
} as const;

// The KPI → clause mapping that used to live here now sits in
// utils/kpiProcessReference.ts, alongside the Customer Success SOP's, so one
// module owns "which document is this KPI measured against" for every team.
// This file stays what it is: the Sales stage SLA spec itself.

/** Used by the dashboard + Adam tool to render the SLA next to a stage. */
export function describeSla(spec: StageSlaSpec): string {
  const unit = spec.unit === "business_days" ? "business day" : "calendar day";
  const plural = spec.sla === 1 ? unit : unit + "s";
  if (spec.warnDays !== undefined && spec.critDays !== undefined) {
    return `${spec.warnDays}–${spec.critDays} calendar days (Sales SOP §${spec.clauseRef})`;
  }
  return `≤ ${spec.sla} ${plural} (Sales SOP §${spec.clauseRef})`;
}
