/**
 * Leadership KPI Feed
 * ===================
 * Computes the "Current" value of the GRQ KPIs that the WalaPlus **Leadership
 * Platform** (a separate Replit app at wala-plus-leadership-tool-plus.replit.app)
 * tracks on its KPI Management screen. The Leadership Platform PULLS this feed
 * (see src/mastra/routes/leadershipFeedRoutes.ts) and overwrites its manual
 * "Current" values, while keeping its OWN baselines, targets, QTD pace, RAG
 * engine, owners and departments.
 *
 * Scope = the 4 KPIs leadership tracks today:
 *   - QM-KPI-002  Audit Execution Rate                    (Quality Manager)
 *   - QM-KPI-008  BU Pilot Validation Completion Rate     (Quality Manager)
 *   - QM-KPI-015  BU Framework Readiness Rate             (Quality Manager)
 *   - GRC-KPI-008 Compliance Coverage Index               (GRC Manager)
 *
 * SAFETY RULE: if a KPI has no underlying data in QMS (its source table is
 * empty or unreadable), we set `data_available: false` and the route OMITS it
 * from the feed — so the Leadership Platform keeps its existing manual value
 * and we never push a 0 over a real number.
 */

import { pool } from "./kpiDatabase";
import { logger } from "./logger";
import {
  calcCertMilestoneDelivery,
  calcEvidenceSlaCompliance,
  calcTpraTurnaround,
  calcQmsAdoptionRate,
  calcValueRealization,
  makeCaptureCalc,
} from "./northStarSources";

export type RagStatus = "green" | "amber" | "red";

/**
 * The basis a KPI's `value` is computed on. The Leadership Platform files the
 * value into the matching bucket: `quarter`/`cumulative`/`ytd` → the quarter's
 * actual; `month` → that month's value. A KPI must NEVER silently switch basis
 * between calls.
 *   - "quarter"    — quarter-to-date progress against a quarterly plan (resets each quarter).
 *   - "cumulative" — running point-in-time coverage/ratio over all records to date (no reset).
 *   - "month"      — month-to-date value (resets each month).
 *   - "ytd"        — year-to-date value (resets each year).
 */
export type FeedPeriodType = "month" | "quarter" | "cumulative" | "ytd";

export interface FeedKpiResult {
  code: string;
  name: string;
  unit: string;
  value: number | null;
  status: RagStatus | null;
  /** Leadership-style label derived from status: On Track / At Risk / Off Track. */
  status_label?: string | null;
  baseline?: number | null;
  /** % toward target ((value-baseline)/(target-baseline)), clamped 0-100. */
  progress_pct?: number | null;
  data_available: boolean;
  /** Legacy quarter label (e.g. "2026-Q2"); kept for backward compatibility. */
  period: string;
  /** Explicit basis the `value` is computed on (see FeedPeriodType). */
  period_type: FeedPeriodType;
  /** First day the value covers (ISO). null for cumulative (covers since inception). */
  period_start: string | null;
  /** Last day the value covers (ISO); = as_of for cumulative snapshots. */
  period_end: string;
  as_of: string;
  details?: Record<string, unknown>;
}

interface FeedKpiConfig {
  code: string;
  name: string;
  unit: string;
  target: number;
  /** RAG thresholds. For higher-is-better: value>=green => green, >=amber => amber, else red. */
  green: number;
  amber: number;
  direction: "higher_is_better" | "lower_is_better";
  calc: () => Promise<{
    value: number;
    dataAvailable: boolean;
    details?: any;
    /** Custom `unavailable[]` reason when dataAvailable is false (else defaults to "no_data_in_qms"). */
    reason?: string;
  }>;
}

function ragStatus(value: number, cfg: FeedKpiConfig): RagStatus {
  if (cfg.direction === "higher_is_better") {
    if (value >= cfg.green) return "green";
    if (value >= cfg.amber) return "amber";
    return "red";
  }
  if (value <= cfg.green) return "green";
  if (value <= cfg.amber) return "amber";
  return "red";
}

/**
 * Leadership-platform status taxonomy (7 states, matching the WalaPlus
 * Leadership Platform): Not Started, On Track, At Risk, Off Track, Behind,
 * Completed, Exceeded. ("Not Started" is assigned to KPIs with no data, in the
 * page/summary layer.) Derived from value vs baseline→target + our RAG.
 */
export type LeadershipStatus =
  | "Not Started"
  | "On Track"
  | "At Risk"
  | "Off Track"
  | "Behind"
  | "Completed"
  | "Exceeded";

function leadershipStatus(
  value: number,
  baseline: number,
  target: number,
  direction: "higher_is_better" | "lower_is_better",
  rag: RagStatus,
): LeadershipStatus {
  const higher = direction === "higher_is_better";
  const beyond = higher ? value > target : value < target;
  const met = higher ? value >= target : value <= target;
  if (beyond) return "Exceeded";
  if (met) return "Completed";
  if (rag === "green") return "On Track";
  if (rag === "amber") return "At Risk";
  return progressPct(value, baseline, target) < 50 ? "Behind" : "Off Track";
}

/**
 * Baselines per KPI (the "from" of Baseline → Target), as set on the Leadership
 * Platform. Seeded for the KPIs leadership tracks today; defaults to 0 otherwise
 * and is editable. Target comes from each KPI's `target` in FEED_KPIS.
 */
const BASELINES: Record<string, number> = {
  "QM-KPI-002": 40, // Audit Execution Rate (40 → 90)
  "QM-KPI-008": 0, // BU Coverage Rate (0 → 100)
  "GRC-KPI-008": 45, // Compliance Coverage Index (45 → 90)
  "QM-KPI-015": 0, // QMS Framework Completion (0 → 100)
};

function progressPct(value: number, baseline: number, target: number): number {
  const span = target - baseline;
  if (span === 0) return value >= target ? 100 : 0;
  const p = ((value - baseline) / span) * 100;
  return Math.max(0, Math.min(100, Math.round(p * 10) / 10));
}

function currentQuarterLabel(now: Date): string {
  const q = Math.floor(now.getUTCMonth() / 3) + 1;
  return `${now.getUTCFullYear()}-Q${q}`;
}

/**
 * Period basis per KPI code. ALL GRQ KPIs are reported QUARTERLY (per Sarah,
 * 2026-06-17) — the Leadership Platform tracks every KPI on a quarterly cadence,
 * so the default is "quarter" and the connector files each value under the
 * current quarter. Add an explicit override here only if a specific KPI ever
 * needs month/ytd/cumulative.
 */
const PERIOD_TYPE_BY_CODE: Record<string, FeedPeriodType> = {
  // (all default to "quarter"; list any non-quarter exceptions here)
};

function quarterStartIso(now: Date): string {
  const q = Math.floor(now.getUTCMonth() / 3);
  return new Date(Date.UTC(now.getUTCFullYear(), q * 3, 1)).toISOString();
}
function monthStartIso(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}
function yearStartIso(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), 0, 1)).toISOString();
}

/**
 * Resolve the explicit period window for a KPI. `period_end` is always the
 * snapshot time (`as_of`); `period_start` is the first day the value covers, or
 * null for cumulative metrics that have no reset point.
 */
function periodFor(
  code: string,
  now: Date,
): { period_type: FeedPeriodType; period_start: string | null; period_end: string } {
  const pt = PERIOD_TYPE_BY_CODE[code] ?? "quarter";
  const asOf = now.toISOString();
  if (pt === "quarter") return { period_type: pt, period_start: quarterStartIso(now), period_end: asOf };
  if (pt === "ytd") return { period_type: pt, period_start: yearStartIso(now), period_end: asOf };
  if (pt === "month") return { period_type: pt, period_start: monthStartIso(now), period_end: asOf };
  return { period_type: "cumulative", period_start: null, period_end: asOf };
}

// ── Calculators ────────────────────────────────────────────────────────────
// Each is wrapped so any error (missing table/column, empty data) resolves to
// dataAvailable:false rather than throwing — the endpoint must never 500 and
// must never emit a misleading 0.

/** QM-KPI-002 — (completed audits / total audits) × 100, across BOTH formal
 *  audits and completed AI-audit runs. */
async function calcAuditExecutionRate() {
  // Audit Execution Rate — QUARTERLY (per Sarah, 2026-06-17): of the audits
  // PLANNED for the CURRENT quarter, how many were EXECUTED (completed). This is a
  // true QTD execution rate — the denominator is the quarter's plan, NOT the whole
  // register (the old formula divided by every audit ever, which misrepresented it).
  //   planned   = formal audits whose planned/scheduled date is in this quarter
  //   executed  = those with status fieldwork_complete | report_draft | report_final | closed
  // Source = BOTH: also include completed standalone AI-audit runs finished THIS
  // quarter (each counts as one planned + one executed). Runs linked to a formal
  // audit are excluded to avoid double-counting.
  const r = await pool.query(`
    WITH q AS (
      SELECT date_trunc('quarter', NOW()) AS q_start,
             date_trunc('quarter', NOW()) + interval '3 months' AS q_end
    )
    SELECT
      COUNT(*) FILTER (
        WHERE COALESCE(planned_start_date, scheduled_date, created_at) >= (SELECT q_start FROM q)
          AND COALESCE(planned_start_date, scheduled_date, created_at) <  (SELECT q_end FROM q)
      )::int AS planned,
      COUNT(*) FILTER (
        WHERE COALESCE(planned_start_date, scheduled_date, created_at) >= (SELECT q_start FROM q)
          AND COALESCE(planned_start_date, scheduled_date, created_at) <  (SELECT q_end FROM q)
          AND status IN ('fieldwork_complete','report_draft','report_final','closed','completed')
      )::int AS completed
    FROM audits
  `);
  let planned = r.rows[0]?.planned ?? 0;
  let completed = r.rows[0]?.completed ?? 0;
  let aiRuns = 0;
  try {
    // The weekly AI audit is the qualityAuditWorkflow — it writes ONE row per run
    // to `quality_audit_results` (keyed by audit_date). (The older `audit_runs`
    // table is never populated, so we count the real AI-audit runs here.) Each run
    // this quarter = one executed audit, counted as +1 planned and +1 completed.
    const a = await pool.query(`
      SELECT COUNT(*)::int AS runs
      FROM quality_audit_results
      WHERE audit_date >= date_trunc('quarter', NOW())
        AND audit_date <  date_trunc('quarter', NOW()) + interval '3 months'
    `);
    aiRuns = a.rows[0]?.runs ?? 0;
    planned += aiRuns;
    completed += aiRuns;
  } catch {
    /* quality_audit_results not present — fall back to formal audits only */
  }
  if (planned <= 0) {
    // No audits planned/dated in the current quarter → nothing to execute yet.
    // Mark unavailable (not a real 0%) so leadership keeps its value.
    return { value: 0, dataAvailable: false, reason: "no_audits_planned_this_quarter" };
  }
  return {
    value: Math.round((completed / planned) * 1000) / 10,
    dataAvailable: true,
    details: {
      planned_this_quarter: planned,
      completed_this_quarter: completed,
      ai_audit_runs: aiRuns,
    },
  };
}

/** GRC-KPI-008 — (applicable obligations with a mapped control/policy / total applicable) × 100. */
async function calcComplianceCoverage() {
  // Scored PER QUARTER against the schedule: denominator = applicable obligations
  // DUE to be mapped by the end of the current quarter (target_date ≤ quarter
  // end). "Mapped" now requires ALL THREE — a linked control, a named owner, and
  // an evidence requirement. Obligations with no target_date are out of scope
  // until one is set (same discipline as the BU KPIs).
  const r = await pool.query(`
    WITH q AS (
      SELECT (date_trunc('quarter', NOW()) + interval '3 months')::date AS qend
    )
    SELECT
      COUNT(*) FILTER (
        WHERE o.status = 'applicable'
          AND o.target_date IS NOT NULL AND o.target_date < q.qend
      )::int AS due,
      COUNT(*) FILTER (
        WHERE o.status = 'applicable'
          AND o.target_date IS NOT NULL AND o.target_date < q.qend
          AND o.linked_control_ids IS NOT NULL AND array_length(o.linked_control_ids, 1) > 0
          AND (COALESCE(TRIM(o.responsible_department), '') <> ''
               OR COALESCE(TRIM(o.responsible_role), '') <> '')
          AND COALESCE(TRIM(o.evidence_requirements), '') <> ''
      )::int AS mapped
    FROM obligations o, q
  `);
  const due = r.rows[0]?.due ?? 0;
  const mapped = r.rows[0]?.mapped ?? 0;
  if (due <= 0) {
    // Nothing scheduled to be mapped by this quarter yet → N/A (never a fake 0
    // over the Leadership Platform's value). Set a target_date on obligations to
    // bring them into scope.
    return { value: 0, dataAvailable: false, reason: "no_obligations_due_this_quarter" };
  }
  return {
    value: Math.round((mapped / due) * 1000) / 10,
    dataAvailable: true,
    details: {
      obligations_due_this_quarter: due,
      fully_mapped: mapped,
      mapping_rule: "control + owner + evidence",
    },
  };
}

/** QM-KPI-015 — (published & in-review-date policies / total policies) × 100. */
async function calcProcessQualityFramework() {
  const r = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (
        WHERE status = 'published' AND (review_date IS NULL OR review_date >= NOW())
      )::int AS compliant
    FROM policies
  `);
  const total = r.rows[0]?.total ?? 0;
  const compliant = r.rows[0]?.compliant ?? 0;
  if (total <= 0) {
    return { value: 0, dataAvailable: false, reason: "no_policies_in_qms" };
  }
  if (compliant <= 0) {
    // Policies exist but NONE are published-and-within-review-date yet. That is a
    // "framework not populated" signal, not a measured 0% — emitting value:0 would
    // overwrite the Leadership Platform's manual value with a misleading zero.
    // Mark unavailable so the connector skips it (per the feed safety contract).
    return {
      value: 0,
      dataAvailable: false,
      reason: "no_published_in_review_policies_yet",
      details: { total_policies: total, compliant_policies: 0 },
    };
  }
  return {
    value: Math.round((compliant / total) * 1000) / 10,
    dataAvailable: true,
    details: { total_policies: total, compliant_policies: compliant },
  };
}

/**
 * QM-KPI-015 — BU Framework Readiness Rate = BUs that completed the full 7-stage
 * Readiness action plan ("Ready for Pilot") ÷ the 8 planned BUs. Binary per BU;
 * same value the /kpis page records.
 */
async function calcFrameworkChecklistCompletion() {
  const { actionPlanCompleteRate } = await import("./kpiChecklistDatabase");
  const r = await actionPlanCompleteRate("QM-KPI-015");
  if (!r) {
    return { value: 0, dataAvailable: false, reason: "no_framework_checklist_yet" };
  }
  return {
    value: r.value,
    dataAvailable: true,
    details: { bus_ready_for_pilot: r.complete, bus_planned: r.total },
  };
}

/**
 * QM-KPI-008 — (business units with governance coverage / total business units) × 100.
 *
 * The canonical BU list comes from the GRQ "Quality Plan 2026 → BU Coverage Plan"
 * (13 departments under Commercial / Non-Commercial). We seed `business_units`
 * with exactly that list so the denominator matches the official plan. A BU is
 * counted "covered" when it has >= 1 PUBLISHED governance policy (matched by
 * owner_department) — i.e. governance documentation exists for it. Admins can
 * edit the registry later via SQL/UI.
 */
const CANONICAL_BUSINESS_UNITS: Array<{ name: string; commercial: boolean }> = [
  // Commercial
  { name: "SDR", commercial: true },
  { name: "Sales", commercial: true },
  { name: "Marketplace", commercial: true },
  { name: "Customer Success", commercial: true },
  { name: "WalaOne", commercial: true },
  // Non-Commercial
  { name: "Marketing", commercial: false },
  { name: "HR", commercial: false },
  { name: "Finance", commercial: false },
  { name: "IT", commercial: false },
  { name: "Software", commercial: false },
  { name: "Customer Support", commercial: false },
  { name: "GRC", commercial: false },
  { name: "Quality", commercial: false },
];

async function calcBuCoverageRate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS business_units (
      id SERIAL PRIMARY KEY,
      bu_code VARCHAR(50),
      bu_name VARCHAR(255) UNIQUE NOT NULL,
      is_commercial BOOLEAN DEFAULT true,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Seed the canonical 13 BUs from the Quality Plan 2026 (idempotent). NOTE: this
  // seeding is relied on by calcRiskAssessmentCoverage too — keep it here.
  for (const bu of CANONICAL_BUSINESS_UNITS) {
    await pool.query(
      `INSERT INTO business_units (bu_name, is_commercial)
       VALUES ($1, $2) ON CONFLICT (bu_name) DO NOTHING`,
      [bu.name, bu.commercial],
    );
  }

  // QM-KPI-008 = BU Pilot Validation Completion Rate: BUs that completed the full
  // 5-stage Pilot Validation plan ÷ the 8 planned BUs (binary; same value /kpis
  // records). (business_units seeding above is kept — calcRiskAssessmentCoverage
  // relies on it.)
  const { actionPlanCompleteRate } = await import("./kpiChecklistDatabase");
  const rate = await actionPlanCompleteRate("QM-KPI-008");
  if (!rate) return { value: 0, dataAvailable: false, reason: "no_pilot_checklist_yet" };
  return {
    value: rate.value,
    dataAvailable: true,
    details: { bus_pilot_validated: rate.complete, bus_planned: rate.total },
  };
}

/** QM-KPI-003 — Gap/Finding Closure Rate: (closed findings / total) × 100. */
async function calcGapClosureRate() {
  const r = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status IN ('closed', 'verified_closed'))::int AS closed
    FROM grc_audit_findings
  `);
  const total = r.rows[0]?.total ?? 0;
  const closed = r.rows[0]?.closed ?? 0;
  if (total <= 0) return { value: 0, dataAvailable: false };
  return {
    value: Math.round((closed / total) * 1000) / 10,
    dataAvailable: true,
    details: { total_findings: total, closed_findings: closed },
  };
}

/** QM-KPI-005 — Quality Training Coverage: (completed assignments / total) × 100. */
async function calcTrainingCoverage() {
  const r = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'completed')::int AS completed
    FROM training_assignments
  `);
  const total = r.rows[0]?.total ?? 0;
  const completed = r.rows[0]?.completed ?? 0;
  if (total <= 0) return { value: 0, dataAvailable: false };
  return {
    value: Math.round((completed / total) * 1000) / 10,
    dataAvailable: true,
    details: { total_assignments: total, completed_assignments: completed },
  };
}

/** GRC-KPI-005 — Risk Treatment Closure (CAPA): (completed / non-cancelled total) × 100. */
async function calcRiskTreatmentClosure() {
  const r = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status <> 'cancelled')::int AS total,
      COUNT(*) FILTER (WHERE status = 'completed')::int AS completed
    FROM risk_treatment_actions
  `);
  const total = r.rows[0]?.total ?? 0;
  const completed = r.rows[0]?.completed ?? 0;
  if (total <= 0) return { value: 0, dataAvailable: false };
  return {
    value: Math.round((completed / total) * 1000) / 10,
    dataAvailable: true,
    details: { total_due: total, completed },
  };
}

/** GRC-KPI-007 — Year-End Compliance Closure: (obligations closed-or-accepted / applicable) × 100. */
async function calcYearEndComplianceClosure() {
  const r = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE o.status = 'exempt' OR ca.compliant IS TRUE)::int AS closed
    FROM obligations o
    LEFT JOIN LATERAL (
      SELECT bool_or(compliance_status = 'compliant') AS compliant
      FROM compliance_assessments ca
      WHERE ca.obligation_id = o.id
    ) ca ON TRUE
    WHERE o.status IN ('applicable', 'exempt')
  `);
  const total = r.rows[0]?.total ?? 0;
  const closed = r.rows[0]?.closed ?? 0;
  if (total <= 0) return { value: 0, dataAvailable: false };
  return {
    value: Math.round((closed / total) * 1000) / 10,
    dataAvailable: true,
    details: { applicable_obligations: total, closed_or_accepted: closed },
  };
}

/** QM-KPI-006 — Quality→GRC Handoff Cycle Time (avg days from created to processed; lower is better). */
async function calcHandoffCycleTime() {
  const r = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE processed_at IS NOT NULL)::int AS done,
      AVG(EXTRACT(EPOCH FROM (processed_at - created_at)) / 86400.0)
        FILTER (WHERE processed_at IS NOT NULL) AS avg_days
    FROM handoff_events
  `);
  const done = r.rows[0]?.done ?? 0;
  const avg = r.rows[0]?.avg_days;
  if (done <= 0 || avg === null || avg === undefined) {
    return { value: 0, dataAvailable: false };
  }
  return {
    value: Math.round(Number(avg) * 10) / 10,
    dataAvailable: true,
    details: { processed_events: done },
  };
}

/** GRC-KPI-003 — Audit & Certification Readiness: (ready evidence packs / total) × 100. */
async function calcAuditCertReadiness() {
  const r = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status IN ('compiled', 'reviewed', 'submitted'))::int AS ready
    FROM evidence_packs
  `);
  const total = r.rows[0]?.total ?? 0;
  const ready = r.rows[0]?.ready ?? 0;
  if (total <= 0) return { value: 0, dataAvailable: false };
  return {
    value: Math.round((ready / total) * 1000) / 10,
    dataAvailable: true,
    details: { total_packs: total, ready_packs: ready },
  };
}

// ── Phase-2 OKR calculators over EXISTING QMS data ──────────────────────────

/** QM-KPI-009 — Audit Cycle Time: avg days from audit start to end (lower better). */
async function calcAuditCycleTime() {
  const r = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE actual_start_date IS NOT NULL AND actual_end_date IS NOT NULL)::int AS done,
      AVG(EXTRACT(EPOCH FROM (actual_end_date - actual_start_date)) / 86400.0)
        FILTER (WHERE actual_start_date IS NOT NULL AND actual_end_date IS NOT NULL) AS avg_days
    FROM audits
  `);
  const done = r.rows[0]?.done ?? 0;
  const avg = r.rows[0]?.avg_days;
  if (done <= 0 || avg === null || avg === undefined) return { value: 0, dataAvailable: false };
  return { value: Math.round(Number(avg) * 10) / 10, dataAvailable: true, details: { completed_audits: done } };
}

/** GRC-KPI-009 (canonical GRC-KPI-010) — Risk Register Quality Index: INTERNAL
 *  (processes/BUs — enterprise risk register) + EXTERNAL (vendor assessments),
 *  averaged 50/50. A record counts only if owned + scored + review current +
 *  status valid. Replaces the old 'does this BU have any risk?' coverage count. */
async function calcRiskAssessmentCoverage() {
  // Two halves, averaged 50/50 (renormalised if one side has no records so an
  // empty vendor list can't halve the score). A record counts only if it passes
  // ALL FOUR checks: owned, scored, review current, status valid.
  try {
    const internal = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE
              COALESCE(TRIM(risk_owner), '') <> ''
          AND COALESCE(TRIM(owner_department), '') <> ''
          AND risk_score IS NOT NULL
          AND COALESCE(TRIM(risk_level), '') <> ''
          AND next_review_date IS NOT NULL AND next_review_date >= NOW()
          AND COALESCE(TRIM(status), '') <> ''
        )::int AS valid,
        COUNT(*) FILTER (WHERE COALESCE(TRIM(risk_owner),'') <> '' AND COALESCE(TRIM(owner_department),'') <> '')::int AS owned,
        COUNT(*) FILTER (WHERE risk_score IS NOT NULL AND COALESCE(TRIM(risk_level),'') <> '')::int AS scored,
        COUNT(*) FILTER (WHERE next_review_date IS NOT NULL AND next_review_date >= NOW())::int AS review_current,
        COUNT(*) FILTER (WHERE COALESCE(TRIM(status),'') <> '')::int AS status_valid
      FROM enterprise_risks
      WHERE LOWER(COALESCE(TRIM(status), '')) NOT IN ('closed', 'archived', 'rejected', 'cancelled')
    `);
    const external = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE
              COALESCE(TRIM(owner_name), '') <> ''
          AND COALESCE(TRIM(owner_department), '') <> ''
          AND (overall_risk_score IS NOT NULL OR COALESCE(TRIM(overall_risk_level), '') <> '')
          AND next_assessment_date IS NOT NULL AND next_assessment_date >= NOW()
          AND last_assessment_date IS NOT NULL
        )::int AS valid,
        COUNT(*) FILTER (WHERE COALESCE(TRIM(owner_name),'') <> '' AND COALESCE(TRIM(owner_department),'') <> '')::int AS owned,
        COUNT(*) FILTER (WHERE overall_risk_score IS NOT NULL OR COALESCE(TRIM(overall_risk_level),'') <> '')::int AS scored,
        COUNT(*) FILTER (WHERE next_assessment_date IS NOT NULL AND next_assessment_date >= NOW())::int AS review_current,
        COUNT(*) FILTER (WHERE last_assessment_date IS NOT NULL)::int AS status_valid
      FROM vendors
      WHERE LOWER(COALESCE(TRIM(status), '')) NOT IN ('inactive', 'terminated', 'archived')
    `);
    const i = internal.rows[0] ?? {};
    const e = external.rows[0] ?? {};
    const iTotal = Number(i.total ?? 0), eTotal = Number(e.total ?? 0);
    if (iTotal <= 0 && eTotal <= 0) {
      return { value: 0, dataAvailable: false, reason: "no_risk_or_vendor_records" };
    }
    const pct = (v: any, t: number) => (t > 0 ? (Number(v ?? 0) / t) * 100 : null);
    const iPct = pct(i.valid, iTotal);
    const ePct = pct(e.valid, eTotal);
    // 50/50, renormalised over the halves that actually have records.
    const halves = [iPct, ePct].filter((x): x is number => x !== null);
    const value = Math.round((halves.reduce((a, b) => a + b, 0) / halves.length) * 10) / 10;
    return {
      value,
      dataAvailable: true,
      details: {
        internal: {
          scope: "processes / BUs (enterprise risk register, live records)",
          total: iTotal, valid: Number(i.valid ?? 0), pct: iPct === null ? null : Math.round(iPct * 10) / 10,
          failing: { not_owned: iTotal - Number(i.owned ?? 0), not_scored: iTotal - Number(i.scored ?? 0), review_overdue_or_unset: iTotal - Number(i.review_current ?? 0), status_blank: iTotal - Number(i.status_valid ?? 0) },
        },
        external: {
          scope: "vendors (third-party assessments, active vendors)",
          total: eTotal, valid: Number(e.valid ?? 0), pct: ePct === null ? null : Math.round(ePct * 10) / 10,
          failing: { not_owned: eTotal - Number(e.owned ?? 0), not_scored: eTotal - Number(e.scored ?? 0), reassessment_overdue_or_unset: eTotal - Number(e.review_current ?? 0), never_assessed: eTotal - Number(e.status_valid ?? 0) },
        },
        weighting: halves.length === 2 ? "50/50 internal/external" : "single half (other has no records)",
      },
    };
  } catch (err) {
    logger.error(`[LeadershipFeed] risk register quality index failed: ${(err as Error).message}`);
    return { value: 0, dataAvailable: false, reason: "risk_or_vendor_table_unavailable" };
  }
}

/** GRC-KPI-010 — High-Risk Items with Treatment Plan: high/critical risks with >=1 treatment / total. */
async function calcHighRiskTreatmentPlan() {
  const r = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE risk_level IN ('high','critical'))::int AS total_high,
      COUNT(*) FILTER (WHERE risk_level IN ('high','critical')
        AND EXISTS (SELECT 1 FROM risk_treatment_actions t WHERE t.risk_id = er.id))::int AS with_plan
    FROM enterprise_risks er
  `);
  const total = r.rows[0]?.total_high ?? 0;
  const withPlan = r.rows[0]?.with_plan ?? 0;
  if (total <= 0) return { value: 0, dataAvailable: false };
  return { value: Math.round((withPlan / total) * 1000) / 10, dataAvailable: true, details: { total_high_risks: total, with_treatment_plan: withPlan } };
}

/** GRC-KPI-016 — Policy Review Compliance: policies within review cycle (not overdue) / total. */
async function calcPolicyReviewCompliance() {
  const r = await pool.query(`
    SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE review_date IS NULL OR review_date >= NOW())::int AS on_time
    FROM policies
  `);
  const total = r.rows[0]?.total ?? 0;
  const onTime = r.rows[0]?.on_time ?? 0;
  if (total <= 0) return { value: 0, dataAvailable: false };
  return { value: Math.round((onTime / total) * 1000) / 10, dataAvailable: true, details: { total_policies: total, within_review_cycle: onTime } };
}

/** GRC-KPI-011 — TPRA Coverage: critical vendors with an assessment / total critical vendors. */
async function calcTpraCoverage() {
  const r = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE criticality = 'critical')::int AS total_critical,
      COUNT(*) FILTER (WHERE criticality = 'critical'
        AND EXISTS (SELECT 1 FROM vendor_assessments a WHERE a.vendor_id = v.id))::int AS assessed
    FROM vendors v
  `);
  const total = r.rows[0]?.total_critical ?? 0;
  const assessed = r.rows[0]?.assessed ?? 0;
  if (total <= 0) return { value: 0, dataAvailable: false };
  return { value: Math.round((assessed / total) * 1000) / 10, dataAvailable: true, details: { total_critical_vendors: total, assessed } };
}

/** GRC-KPI-013 — High-Risk Vendor Findings Closure: closed remediations / total. */
async function calcVendorFindingsClosure() {
  const r = await pool.query(`
    SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status IN ('closed','completed','resolved','verified'))::int AS closed
    FROM vendor_remediations
  `);
  const total = r.rows[0]?.total ?? 0;
  const closed = r.rows[0]?.closed ?? 0;
  if (total <= 0) return { value: 0, dataAvailable: false };
  return { value: Math.round((closed / total) * 1000) / 10, dataAvailable: true, details: { total_findings: total, closed_findings: closed } };
}

const FEED_KPIS: FeedKpiConfig[] = [
  {
    code: "QM-KPI-002",
    name: "Audit Execution Rate",
    unit: "%",
    target: 90,
    green: 90,
    amber: 75,
    direction: "higher_is_better",
    calc: calcAuditExecutionRate,
  },
  {
    code: "QM-KPI-008",
    name: "BU Pilot Validation Completion Rate",
    unit: "%",
    target: 100,
    green: 95,
    amber: 80,
    direction: "higher_is_better",
    calc: calcBuCoverageRate, // NOTE: fn name is legacy; it computes the QM-KPI-008 Pilot Validation checklist rate (see its body).
  },
  {
    code: "GRC-KPI-008",
    name: "Compliance Coverage Index",
    unit: "%",
    target: 90,
    green: 90,
    amber: 75,
    direction: "higher_is_better",
    calc: calcComplianceCoverage,
  },
  {
    code: "QM-KPI-015",
    name: "BU Framework Readiness Rate",
    unit: "%",
    target: 100,
    green: 95,
    amber: 80,
    direction: "higher_is_better",
    calc: calcFrameworkChecklistCompletion, // BU Framework checklist — same as /kpis
  },
  // ── Additional North Star KPIs (emitted when their source data exists;
  //    omitted otherwise so leadership keeps any manual value). ──────────────
  {
    code: "QM-KPI-003",
    name: "Gap Closure Rate",
    unit: "%",
    target: 90,
    green: 85,
    amber: 70,
    direction: "higher_is_better",
    calc: calcGapClosureRate,
  },
  {
    code: "QM-KPI-005",
    name: "Quality Training Coverage",
    unit: "%",
    target: 90,
    green: 90,
    amber: 75,
    direction: "higher_is_better",
    calc: calcTrainingCoverage,
  },
  {
    code: "GRC-KPI-005",
    name: "Risk Treatment Closure Rate (CAPA)",
    unit: "%",
    target: 80,
    green: 80,
    amber: 65,
    direction: "higher_is_better",
    calc: calcRiskTreatmentClosure,
  },
  {
    code: "GRC-KPI-007",
    name: "Year-End Compliance Closure Score",
    unit: "%",
    target: 95,
    green: 90,
    amber: 75,
    direction: "higher_is_better",
    calc: calcYearEndComplianceClosure,
  },
  {
    code: "QM-KPI-006",
    name: "Quality→GRC Handoff Cycle Time",
    unit: "days",
    target: 5,
    green: 5,
    amber: 8,
    direction: "lower_is_better",
    calc: calcHandoffCycleTime,
  },
  // ── KPIs backed by dedicated capture tables (src/utils/northStarSources.ts).
  //    Emit once data is entered via /api/northstar/* ; omitted while empty. ──
  {
    code: "QM-KPI-004",
    name: "QMS Adoption Rate",
    unit: "%",
    target: 70,
    green: 70,
    amber: 50,
    direction: "higher_is_better",
    calc: calcQmsAdoptionRate,
  },
  {
    code: "QM-KPI-007",
    name: "Operational Excellence Value Realization",
    unit: "%",
    target: 70,
    green: 70,
    amber: 50,
    direction: "higher_is_better",
    calc: calcValueRealization,
  },
  {
    code: "GRC-KPI-002",
    name: "Certification Milestone Delivery Rate",
    unit: "%",
    target: 100,
    green: 100,
    amber: 85,
    direction: "higher_is_better",
    calc: calcCertMilestoneDelivery,
  },
  {
    code: "GRC-KPI-004",
    name: "Evidence SLA Compliance",
    unit: "%",
    target: 90,
    green: 90,
    amber: 75,
    direction: "higher_is_better",
    calc: calcEvidenceSlaCompliance,
  },
  {
    code: "GRC-KPI-006",
    name: "TPRA Vendor Risk Turnaround SLA",
    unit: "%",
    target: 85,
    green: 85,
    amber: 70,
    direction: "higher_is_better",
    calc: calcTpraTurnaround,
  },
  {
    code: "GRC-KPI-003",
    name: "Audit & Certification Readiness Index",
    unit: "%",
    target: 95,
    green: 95,
    amber: 81,
    direction: "higher_is_better",
    calc: calcAuditCertReadiness,
  },
  // ── Phase-2 OKR KPIs (6 from existing data, 8 from okr_metric_entries). ────
  { code: "QM-KPI-009", name: "Audit Cycle Time", unit: "days", target: 10, green: 10, amber: 15, direction: "lower_is_better", calc: calcAuditCycleTime },
  { code: "QM-KPI-010", name: "Repeat Findings Rate", unit: "%", target: 10, green: 10, amber: 15, direction: "lower_is_better", calc: makeCaptureCalc("QM-KPI-010", "ratio") },
  { code: "QM-KPI-011", name: "Escalation Reduction (Quality)", unit: "%", target: 20, green: 20, amber: 10, direction: "higher_is_better", calc: makeCaptureCalc("QM-KPI-011", "reduction") },
  { code: "QM-KPI-012", name: "Automation Coverage (Quality Workflows)", unit: "%", target: 30, green: 30, amber: 20, direction: "higher_is_better", calc: makeCaptureCalc("QM-KPI-012", "ratio") },
  { code: "QM-KPI-013", name: "Manual Effort Reduction", unit: "%", target: 30, green: 30, amber: 20, direction: "higher_is_better", calc: makeCaptureCalc("QM-KPI-013", "reduction") },
  { code: "QM-KPI-014", name: "Operational Waste Reduction (Rework)", unit: "%", target: 20, green: 20, amber: 10, direction: "higher_is_better", calc: makeCaptureCalc("QM-KPI-014", "reduction") },
  { code: "GRC-KPI-009", name: "Risk Register Quality Index (Internal + External)", unit: "%", target: 95, green: 95, amber: 81, direction: "higher_is_better", calc: calcRiskAssessmentCoverage },
  { code: "GRC-KPI-011", name: "TPRA Coverage Rate (Critical Vendors)", unit: "%", target: 95, green: 95, amber: 80, direction: "higher_is_better", calc: calcTpraCoverage },
  { code: "GRC-KPI-012", name: "Client/Partner Security Assessment SLA", unit: "%", target: 90, green: 90, amber: 75, direction: "higher_is_better", calc: makeCaptureCalc("GRC-KPI-012", "ratio") },
  { code: "GRC-KPI-014", name: "Regulatory Response Timeliness", unit: "days", target: 5, green: 5, amber: 8, direction: "lower_is_better", calc: makeCaptureCalc("GRC-KPI-014", "days") },
  { code: "GRC-KPI-015", name: "Security Incident Governance Closure Time", unit: "days", target: 30, green: 30, amber: 45, direction: "lower_is_better", calc: makeCaptureCalc("GRC-KPI-015", "days") },
  { code: "GRC-KPI-016", name: "Policy Review Compliance", unit: "%", target: 95, green: 95, amber: 80, direction: "higher_is_better", calc: calcPolicyReviewCompliance },
];

/**
 * Per-KPI explanatory detail to embed in each KPI tab on the Leadership
 * Platform — "how it is calculated and why" — sourced from the GRQ
 * "Quality Plan 2026" and the "Quality North Star" deck. Keyed by feed code.
 */
interface KpiDetail {
  description: string; // what it measures
  methodology: string; // how QMS calculates it (source + formula, plain English)
  rationale: string; // why it matters (business purpose)
  plan_ref: string; // tie-back to Quality Plan / North Star
  // ── Calculation-parity contract (Problem 2): the exact records counted, so
  //    the Leadership Platform can confirm it is comparing the same definition. ──
  numerator?: string; // exact records counted (table + filter)
  denominator?: string; // exact records (table + filter + scope)
  scope?: string; // which BUs / obligations / policies are in-scope (and exclusions)
  rounding?: string; // decimals + rounding rule (must match Leadership display)
}

/** Default rounding rule shared by every percentage KPI in the feed. */
const DEFAULT_ROUNDING =
  "value = round(numerator ÷ denominator × 100) to 1 decimal place (round half up); reconcile against the raw counts in `details`.";

const KPI_DETAILS: Record<string, KpiDetail> = {
  "QM-KPI-015": {
    description:
      "Quarterly framework-build progress for the BUs in scope THIS quarter (e.g. Q2 = Marketplace + Customer Success), measured by the BU Framework checklist (9-phase build plan per BU).",
    methodology:
      "Framework checklist phases done ÷ total phases, counted ONLY for BUs in scope this quarter (status in_progress/postponed in the BU Coverage tracker) — NOT all 13 BUs (source: kpi_checklist_items for QM-KPI-015 joined to kpi_bu_coverage). Same value as the internal /kpis page.",
    rationale:
      "Shows how far this quarter's targeted BUs' governance frameworks are built (process drafting → review → release → training → trial audit), without being diluted by BUs not yet started.",
    plan_ref:
      "Quality Plan → Governance Framework build (9-phase methodology); North Star 'Framework Completion' (Q1 40% → Q4 100%).",
    numerator:
      "in-scope kpi_checklist_items WHERE is_done = true (for QM-KPI-015) — see details.completed_phases.",
    denominator: "in-scope kpi_checklist_items for QM-KPI-015 (this quarter's BUs × 9 phases) — see details.in_scope_phases.",
    scope:
      "Only BUs in this quarter's plan (BU Coverage status in_progress/postponed). If no BU is in scope the KPI is reported in unavailable[] (reason no_bu_in_scope_this_quarter), not value:0. Scope is controlled via the Manage BU Coverage statuses.",
    rounding: DEFAULT_ROUNDING,
  },
  "QM-KPI-002": {
    description:
      "Percentage of planned internal audits that were actually executed.",
    methodology:
      "Completed audits (fieldwork_complete / report / closed) ÷ total audits in the register (source: audits table). The plan denominator is the per-BU quarterly Audit Plan.",
    rationale:
      "Ensures consistent internal quality execution and effective closure of audit and process gaps across all business units.",
    plan_ref:
      "Quality Plan → Audit Execution Rate (per-BU quarterly schedule); North Star 'Audit Execution' (Q1 80% → Q4 90%).",
    numerator:
      "audits PLANNED this quarter WHERE status IN ('fieldwork_complete','report_draft','report_final','closed','completed') PLUS weekly AI-audit runs this quarter (quality_audit_results, one row per run, by audit_date) — see details.completed_this_quarter.",
    denominator:
      "audits PLANNED this quarter (planned/scheduled date in the current quarter) PLUS the same weekly AI-audit runs this quarter — see details.planned_this_quarter (details.ai_audit_runs counts the AI runs added to both sides).",
    scope:
      "QUARTERLY (QTD): audits whose planned/scheduled date falls in the current quarter, across all BUs, + weekly AI-audit runs this quarter (qualityAuditWorkflow → quality_audit_results). If no audits are planned this quarter the KPI is reported unavailable (reason 'no_audits_planned_this_quarter'), not a 0%.",
    rounding: DEFAULT_ROUNDING,
  },
  "QM-KPI-003": {
    description: "Percentage of audit findings / process gaps closed.",
    methodology:
      "Findings with status closed or verified_closed ÷ total findings (source: grc_audit_findings).",
    rationale:
      "Measures whether identified quality gaps are actually remediated, not merely logged.",
    plan_ref: "North Star 'Gap Closure' (Q2 80% → Q4 90%).",
  },
  "QM-KPI-005": {
    description:
      "Percentage of targeted staff with completed quality/governance training.",
    methodology:
      "Completed training assignments ÷ total assignments (source: training_assignments). Targeting follows the per-BU quarterly Training Plan.",
    rationale:
      "Confirms business units are equipped to follow the new SOPs — adoption depends on training.",
    plan_ref:
      "Quality Plan → Training Plan; North Star 'Training Coverage' (Q4 90%).",
  },
  "QM-KPI-004": {
    description:
      "Percentage of the 13 business units actively adopting the QMS / governance system.",
    methodology:
      "Business units marked 'adopted' ÷ 13 business units (source: qms_adoption + business_units). Captured via POST /api/northstar/qms_adoption.",
    rationale:
      "Measures whether governance is actually used by the org, not just documented — the real test of operational excellence.",
    plan_ref:
      "Quality Plan → BU Coverage Plan (Discovery → Partial → Full); North Star 'QMS Adoption' (Q1 20% → Q4 70%).",
  },
  "QM-KPI-007": {
    description:
      "Percentage of targeted value realized from quality / automation initiatives.",
    methodology:
      "SUM(realized_value) ÷ SUM(target_value), capped at 100% (source: value_realization). Captured via POST /api/northstar/value_realization.",
    rationale:
      "Proves quality work delivers measurable business value (ROI), not just activity.",
    plan_ref:
      "North Star 'Value Realization' (Q3-Q4 70%); Governance Document Plan automation/improvement impact column.",
  },
  "QM-KPI-006": {
    description:
      "Average days from a Quality finding to its GRC handoff (lower is better).",
    methodology:
      "AVG(processed_at − created_at) in days over processed handoff events (source: handoff_events).",
    rationale:
      "A fast handoff ensures no quality findings are lost between the Quality and GRC functions.",
    plan_ref:
      "Quality ↔ GRC RACI; North Star 'Handoff SLA / Cycle Time' (≤ 5 days).",
  },
  "GRC-KPI-008": {
    description:
      "Percentage of applicable regulatory obligations mapped to a control or policy.",
    methodology:
      "Applicable obligations with a linked control or policy ÷ total applicable obligations (source: obligations).",
    rationale:
      "Shows regulatory obligations (PDPL / ISO 27001 / NCA / PCI) are governed by controls — the audit-readiness foundation.",
    plan_ref: "Quality ↔ GRC RACI (Compliance → GRC = Accountable).",
    numerator:
      "obligations WHERE status='applicable' AND (linked_control_ids non-empty OR linked_policy_ids non-empty) — see details.mapped_obligations.",
    denominator: "obligations WHERE status='applicable' — see details.total_applicable.",
    scope:
      "Applicable obligations only (status='applicable'); non-applicable/exempt obligations excluded. Cumulative point-in-time snapshot. If 0 applicable obligations are mapped, the KPI is reported in unavailable[] (not value:0).",
    rounding: DEFAULT_ROUNDING,
  },
  "GRC-KPI-003": {
    description:
      "Percentage of required audit/certification evidence artifacts compiled and approved.",
    methodology:
      "Evidence packs in ready states (compiled / reviewed / submitted) ÷ total packs (source: evidence_packs).",
    rationale:
      "Maintains an always-audit-ready state — 100% before external audits — for ISO 27001 / PDPL / PCI / NCA.",
    plan_ref:
      "North Star 'Audit & Certification Readiness Index' (Q1 90% → Q4 100%).",
  },
  "GRC-KPI-004": {
    description:
      "Percentage of evidence requests delivered by business units within SLA.",
    methodology:
      "Requests delivered on/before sla_due_date ÷ total requests (source: evidence_requests). Captured via POST /api/northstar/evidence_requests.",
    rationale:
      "Ensures business units supply audit evidence on time so certifications stay on track.",
    plan_ref: "North Star 'Evidence SLA Compliance' (≥ 90%).",
  },
  "GRC-KPI-005": {
    description: "Percentage of risk treatments / CAPAs closed.",
    methodology:
      "Treatments with status completed ÷ non-cancelled treatments (source: risk_treatment_actions).",
    rationale:
      "Confirms identified risks are actually treated and closed, with no critical risk left overdue > 30 days.",
    plan_ref: "North Star 'Risk Treatment Closure (CAPA)' (≥ 80%).",
  },
  "GRC-KPI-006": {
    description:
      "Percentage of third-party (vendor) risk assessments completed within SLA.",
    methodology:
      "TPRA completed on/before sla_due_date ÷ total requests (source: tpra_requests). Captured via POST /api/northstar/tpra_requests.",
    rationale:
      "Keeps vendor / third-party risk under control within agreed turnaround times.",
    plan_ref: "North Star 'TPRA (Vendor Risk) Turnaround SLA' (≥ 85%).",
  },
  "GRC-KPI-002": {
    description:
      "Percentage of certification-roadmap milestones delivered on time.",
    methodology:
      "Milestones delivered on/before planned_date ÷ planned milestones (source: certification_milestones). Captured via POST /api/northstar/certification_milestones.",
    rationale:
      "Tracks on-time delivery of ISO 27001 / PDPL / PCI / NCA milestones — the certification roadmap.",
    plan_ref: "North Star 'Certification Milestone Delivery' (≥ 90%).",
  },
  "GRC-KPI-007": {
    description:
      "Percentage of 2026 obligations closed or formally accepted by year-end.",
    methodology:
      "Obligations marked exempt (accepted) OR carrying a compliant assessment ÷ applicable obligations (source: obligations + compliance_assessments).",
    rationale:
      "Year-end proof that all obligations are closed or risk-accepted by executives.",
    plan_ref:
      "North Star 'Year-End Compliance Closure' (≥ 95% by Dec 31, 2026).",
  },
  "QM-KPI-008": {
    description:
      "Percentage of the 13 business units with full governance coverage.",
    methodology:
      "Business units with ≥ 1 published governance policy ÷ 13 business units (source: business_units + policies). Canonical BU list seeded from the Quality Plan.",
    rationale:
      "Measures how broadly governance has rolled out across the org (Discovery → Partial → Full).",
    plan_ref: "Quality Plan → BU Coverage Plan (D / P / F per quarter).",
    numerator:
      "PREFERRED: mean per-BU completion % from the BU coverage tracker (partial credit; details.source='bu_coverage_tracker'). FALLBACK (tracker empty): COUNT(DISTINCT business_units with ≥1 published policy matched by owner_department) — see details.covered_business_units.",
    denominator:
      "the 13 canonical active business_units (Quality Plan 2026 BU Coverage Plan) — see details.total_business_units.",
    scope:
      "All 13 canonical BUs. NOTE: when the tracker has data the value is a mean of per-BU completion percentages (NOT a simple covered÷total), so it will not reconcile against a plain count — reconcile against the tracker instead. Cumulative point-in-time snapshot.",
    rounding: DEFAULT_ROUNDING,
  },
};

/**
 * Where in the QMS platform to enter/maintain the data that feeds each KPI.
 * `route` is the QMS page; `where` is the human instruction. KPIs whose data
 * is captured through the dedicated North Star endpoints (no UI form yet) point
 * at the REST path.
 */
const KPI_ENTRY: Record<string, { where: string; route: string }> = {
  "QM-KPI-015": {
    where: "QMS → Policies: create & publish governance documents (SOPs, controls), one set per business unit.",
    route: "/policies",
  },
  "QM-KPI-002": {
    where: "QMS → Audits: log each planned audit, then set status to fieldwork-complete/closed when done.",
    route: "/audits",
  },
  "QM-KPI-003": {
    where: "QMS → Audits → Findings: log audit findings and mark them closed/verified once remediated.",
    route: "/audits",
  },
  "QM-KPI-005": {
    where: "QMS → QMS module → Training: create training and assign to staff; mark each assignment completed.",
    route: "/qms",
  },
  "QM-KPI-004": {
    where: "Capture API: POST /api/northstar/qms_adoption — set each business unit's status to 'adopted' (no UI form yet).",
    route: "/leadership-kpis",
  },
  "QM-KPI-007": {
    where: "Capture API: POST /api/northstar/value_realization — add initiatives with target vs realized value (no UI form yet).",
    route: "/leadership-kpis",
  },
  "QM-KPI-006": {
    where: "Generated automatically by the Quality→GRC handoff engine — no manual entry; managed in the GRC module.",
    route: "/grc",
  },
  "GRC-KPI-008": {
    where: "QMS → Compliance: ensure each applicable obligation has a linked control or policy.",
    route: "/compliance",
  },
  "GRC-KPI-003": {
    where: "QMS → Audit Readiness: compile evidence packs and mark them reviewed/submitted.",
    route: "/audit-readiness",
  },
  "GRC-KPI-004": {
    where: "Capture API: POST /api/northstar/evidence_requests — log requests with SLA due + delivered dates (no UI form yet).",
    route: "/leadership-kpis",
  },
  "GRC-KPI-005": {
    where: "QMS → Risks: add treatment actions to risks and mark them completed when closed.",
    route: "/risks",
  },
  "GRC-KPI-006": {
    where: "Capture API: POST /api/northstar/tpra_requests — log vendor assessments with SLA due + completed dates (no UI form yet).",
    route: "/leadership-kpis",
  },
  "GRC-KPI-002": {
    where: "Capture API: POST /api/northstar/certification_milestones — log milestones with planned + delivered dates (no UI form yet).",
    route: "/leadership-kpis",
  },
  "GRC-KPI-007": {
    where: "QMS → Compliance: record compliance assessments as 'compliant', or mark obligations exempt/accepted.",
    route: "/compliance",
  },
  "QM-KPI-008": {
    where: "QMS → Policies: publish at least one governance policy per business unit (the 13 BUs are pre-seeded).",
    route: "/policies",
  },
  // Phase-2 OKR KPIs
  "QM-KPI-009": { where: "QMS → Audits: record actual start & end dates so cycle time can be computed.", route: "/audits" },
  "QM-KPI-010": { where: "Capture form: Enter KPI Data → metric QM-KPI-010 (numerator = repeat findings, denominator = total).", route: "/leadership-kpis/data" },
  "QM-KPI-011": { where: "Capture form: Enter KPI Data → metric QM-KPI-011 (baseline & current escalations).", route: "/leadership-kpis/data" },
  "QM-KPI-012": { where: "Capture form: Enter KPI Data → metric QM-KPI-012 (numerator = automated, denominator = total workflows).", route: "/leadership-kpis/data" },
  "QM-KPI-013": { where: "Capture form: Enter KPI Data → metric QM-KPI-013 (baseline & current manual hours).", route: "/leadership-kpis/data" },
  "QM-KPI-014": { where: "Capture form: Enter KPI Data → metric QM-KPI-014 (baseline & current rework).", route: "/leadership-kpis/data" },
  "GRC-KPI-009": { where: "QMS → Risks: ensure each BU has a risk assessment (matched by owner department).", route: "/risks" },
  "GRC-KPI-011": { where: "QMS → Vendors: mark critical vendors and record an assessment for each.", route: "/vendors" },
  "GRC-KPI-012": { where: "Capture form: Enter KPI Data → metric GRC-KPI-012 (numerator = on-time, denominator = total assessments).", route: "/leadership-kpis/data" },
  "GRC-KPI-014": { where: "Capture form: Enter KPI Data → metric GRC-KPI-014 (avg days to respond).", route: "/leadership-kpis/data" },
  "GRC-KPI-015": { where: "Capture form: Enter KPI Data → metric GRC-KPI-015 (avg days to close incidents).", route: "/leadership-kpis/data" },
  "GRC-KPI-016": { where: "QMS → Policies: keep each policy's review date current (not overdue).", route: "/policies" },
};

export interface KpiDefinitionOut extends KpiDetail {
  code: string;
  name: string;
  unit: string;
  target: number;
  green: number;
  amber: number;
  direction: "higher_is_better" | "lower_is_better";
  entry_where: string;
  entry_route: string;
  baseline: number;
  /** Explicit period basis this KPI's value is computed on (see FeedPeriodType). */
  period_type: FeedPeriodType;
}

export interface LeadershipFeed {
  generated_at: string;
  source: "QMS";
  /**
   * Static definition of EVERY feed KPI (regardless of data availability) —
   * name, target, RAG bands, and the "how calculated / why" detail to render
   * in each KPI's tab on the Leadership Platform.
   */
  definitions: KpiDefinitionOut[];
  /** KPIs WITH live data. Leadership maps each by `code` and overwrites Current. */
  kpis: FeedKpiResult[];
  /**
   * KPIs that currently have NO data in QMS — listed for diagnostics only.
   * The Leadership Platform must NOT touch these (keep its manual value).
   */
  unavailable: Array<{ code: string; name: string; reason: string }>;
}

/**
 * North Star composite weight tables — straight from the GRQ North Star Excel.
 * For each quarter: the headline `target` (the bar to clear) and the component
 * KPIs with their weights. The North Star Score = Σ(weight × component actual
 * fraction) for the current quarter; a missing component counts as 0 (matching
 * the Excel). Handoff (days, lower-is-better) is folded as min(1, 5 / days).
 */
interface NsComponent {
  code: string;
  weight: number;
}
interface NsQuarter {
  target: number; // 0-1 headline bar for the quarter
  components: NsComponent[];
}

const SARA_NORTH_STAR: Record<number, NsQuarter> = {
  1: {
    target: 0.35,
    components: [
      { code: "QM-KPI-015", weight: 0.5 },
      { code: "QM-KPI-002", weight: 0.3 },
      { code: "QM-KPI-004", weight: 0.2 },
    ],
  },
  2: {
    target: 0.65,
    components: [
      { code: "QM-KPI-015", weight: 0.35 },
      { code: "QM-KPI-002", weight: 0.25 },
      { code: "QM-KPI-003", weight: 0.2 },
      { code: "QM-KPI-004", weight: 0.2 },
    ],
  },
  3: {
    target: 0.75,
    components: [
      { code: "QM-KPI-015", weight: 0.25 },
      { code: "QM-KPI-002", weight: 0.2 },
      { code: "QM-KPI-003", weight: 0.2 },
      { code: "QM-KPI-004", weight: 0.2 },
      { code: "QM-KPI-007", weight: 0.15 },
    ],
  },
  4: {
    target: 0.8,
    components: [
      { code: "QM-KPI-015", weight: 0.15 },
      { code: "QM-KPI-002", weight: 0.15 },
      { code: "QM-KPI-003", weight: 0.15 },
      { code: "QM-KPI-005", weight: 0.15 },
      { code: "QM-KPI-004", weight: 0.15 },
      { code: "QM-KPI-006", weight: 0.1 },
      { code: "QM-KPI-007", weight: 0.15 },
    ],
  },
};

const MARAM_NORTH_STAR: Record<number, NsQuarter> = {
  1: {
    target: 0.9,
    components: [
      { code: "GRC-KPI-002", weight: 0.35 },
      { code: "GRC-KPI-003", weight: 0.25 },
      { code: "GRC-KPI-004", weight: 0.4 },
    ],
  },
  2: {
    target: 0.85,
    components: [
      { code: "GRC-KPI-004", weight: 0.35 },
      { code: "GRC-KPI-003", weight: 0.3 },
      { code: "GRC-KPI-002", weight: 0.35 },
    ],
  },
  3: {
    target: 0.8,
    components: [
      { code: "GRC-KPI-005", weight: 0.4 },
      { code: "GRC-KPI-006", weight: 0.35 },
      { code: "GRC-KPI-003", weight: 0.25 },
    ],
  },
  4: {
    target: 0.95,
    components: [
      { code: "GRC-KPI-003", weight: 0.3 },
      { code: "GRC-KPI-007", weight: 0.4 },
      { code: "QM-KPI-006", weight: 0.3 },
    ],
  },
};

/** Convert a component KPI's value to a 0-1 fraction for the composite. */
function componentFraction(code: string, value: number): number {
  if (code === "QM-KPI-006") {
    // Handoff cycle time in days; lower is better, target 5 days.
    if (!value || value <= 0) return 0;
    return Math.min(1, 5 / value);
  }
  return Math.max(0, Math.min(1, value / 100));
}

const NORTH_STAR_DEFS: Array<{
  code: string;
  name: string;
  weights: Record<number, NsQuarter>;
  detail: KpiDetail;
}> = [
  {
    code: "QM-KPI-001",
    name: "Quality North Star Score",
    weights: SARA_NORTH_STAR,
    detail: {
      description:
        "Single weighted score combining Sarah's quality KPIs for the current quarter (the headline of the Quality scorecard).",
      methodology:
        "Σ(quarter weight × component actual fraction) over the quarter's components (weights from the North Star plan). Handoff (days) folded as min(1, 5/days). A component with no data counts as 0.",
      rationale:
        "One number that shows whether Quality is on track this quarter instead of seven separate metrics.",
      plan_ref:
        "North Star deck — Quality quarterly weights (Q1 Foundation 35% → Q4 Excellence 80%).",
    },
  },
  {
    code: "GRC-KPI-001",
    name: "GRC North Star Score",
    weights: MARAM_NORTH_STAR,
    detail: {
      description:
        "Single weighted score combining Maram's GRC KPIs for the current quarter (the headline of the GRC scorecard).",
      methodology:
        "Σ(quarter weight × component actual fraction) over the quarter's components (weights from the North Star plan). Handoff (days) folded as min(1, 5/days). A component with no data counts as 0.",
      rationale:
        "One number that shows whether GRC is on track this quarter instead of seven separate metrics.",
      plan_ref:
        "North Star deck — GRC quarterly weights (Q1 Roadmap 90% → Q4 Closure 95%).",
    },
  },
];

/**
 * Compute all feed KPIs. KPIs that error or have no data are returned under
 * `unavailable` instead of `kpis`, so callers can omit them from the push.
 */
/**
 * The 5 GRQ North-Star KPIs leadership tracks. For THESE we mirror the /kpis
 * dashboard exactly — send the same stored KPI-engine value (kpi_values) the
 * dashboard shows — instead of the feed's own independent recompute, so leadership
 * never drifts from what the Quality/GRC managers see in QMS (Ahmad 2026-08-16).
 * Every other feed KPI keeps its live calc.
 */
const MIRROR_DASHBOARD_CODES = new Set<string>([
  "QM-KPI-002", // Audit Execution Rate
  "QM-KPI-015", // BU Framework Readiness Rate
  "QM-KPI-008", // BU Pilot Validation Completion Rate
  "GRC-KPI-002", // Certification Milestones On Track
  "GRC-KPI-008", // Compliance Coverage Index
]);

/**
 * Read the exact value the /kpis dashboard shows for a code: the recorded
 * kpi_values.actual_value for the CURRENT quarter (identical to the dashboard's
 * quarter card via getLatestKPIValueForQuarter), falling back to the latest
 * recorded value if this quarter has no entry yet. dataAvailable:false (→ omitted,
 * leadership keeps its prior value) when nothing is recorded at all.
 */
async function dashboardValueForCode(
  code: string,
  now: Date,
): Promise<{ value: number; dataAvailable: boolean; reason?: string; details?: any }> {
  const { getKPIByCode, getLatestKPIValueForQuarter, getLatestKPIValue } =
    await import("./kpiDatabase");
  const def = await getKPIByCode(code);
  if (!def?.id) return { value: 0, dataAvailable: false, reason: "kpi_not_defined_in_qms" };
  const year = now.getUTCFullYear();
  const quarter = Math.floor(now.getUTCMonth() / 3) + 1;
  let lv = await getLatestKPIValueForQuarter(def.id, year, quarter);
  if (!lv) lv = await getLatestKPIValue(def.id);
  if (!lv || lv.actual_value == null) {
    return { value: 0, dataAvailable: false, reason: "no_value_recorded_in_qms" };
  }
  return {
    value: Number(lv.actual_value),
    dataAvailable: true,
    details: { source: "kpi_values (mirrors /kpis)", period_end: lv.period_end },
  };
}

export async function buildLeadershipKpiFeed(): Promise<LeadershipFeed> {
  const now = new Date();
  const asOf = now.toISOString();
  const period = currentQuarterLabel(now);

  const kpis: FeedKpiResult[] = [];
  const unavailable: LeadershipFeed["unavailable"] = [];

  // Static definitions for EVERY KPI (rendered in each leadership tab).
  const definitions: KpiDefinitionOut[] = FEED_KPIS.map((cfg) => ({
    code: cfg.code,
    name: cfg.name,
    unit: cfg.unit,
    target: cfg.target,
    green: cfg.green,
    amber: cfg.amber,
    direction: cfg.direction,
    description: KPI_DETAILS[cfg.code]?.description ?? "",
    methodology: KPI_DETAILS[cfg.code]?.methodology ?? "",
    rationale: KPI_DETAILS[cfg.code]?.rationale ?? "",
    plan_ref: KPI_DETAILS[cfg.code]?.plan_ref ?? "",
    numerator: KPI_DETAILS[cfg.code]?.numerator ?? "",
    denominator: KPI_DETAILS[cfg.code]?.denominator ?? "",
    scope: KPI_DETAILS[cfg.code]?.scope ?? "",
    rounding: KPI_DETAILS[cfg.code]?.rounding ?? (cfg.unit === "%" ? DEFAULT_ROUNDING : ""),
    entry_where: KPI_ENTRY[cfg.code]?.where ?? "",
    entry_route: KPI_ENTRY[cfg.code]?.route ?? "",
    baseline: BASELINES[cfg.code] ?? 0,
    period_type: PERIOD_TYPE_BY_CODE[cfg.code] ?? "quarter",
  }));

  for (const cfg of FEED_KPIS) {
    try {
      // The 5 GRQ North-Star KPIs mirror the /kpis dashboard value exactly; the
      // rest keep their live recompute.
      const { value, dataAvailable, details, reason } = MIRROR_DASHBOARD_CODES.has(cfg.code)
        ? await dashboardValueForCode(cfg.code, now)
        : await cfg.calc();
      if (!dataAvailable) {
        unavailable.push({
          code: cfg.code,
          name: cfg.name,
          reason: reason ?? "no_data_in_qms",
        });
        continue;
      }
      const st = ragStatus(value, cfg);
      const baseline = BASELINES[cfg.code] ?? 0;
      kpis.push({
        code: cfg.code,
        name: cfg.name,
        unit: cfg.unit,
        value,
        status: st,
        status_label: leadershipStatus(value, baseline, cfg.target, cfg.direction, st),
        baseline,
        progress_pct: progressPct(value, baseline, cfg.target),
        data_available: true,
        period,
        ...periodFor(cfg.code, now),
        as_of: asOf,
        details,
      });
    } catch (err) {
      logger.error(`[LeadershipFeed] ${cfg.code} calc failed:`, err);
      unavailable.push({
        code: cfg.code,
        name: cfg.name,
        reason: "calc_error",
      });
    }
  }

  // ── North Star composites (computed from the component actuals above). ─────
  const quarter = Math.floor(now.getUTCMonth() / 3) + 1;
  const liveMap = new Map(kpis.map((k) => [k.code, k]));
  for (const ns of NORTH_STAR_DEFS) {
    const tbl = ns.weights[quarter];
    const targetPct = Math.round(tbl.target * 1000) / 10;
    definitions.push({
      code: ns.code,
      name: ns.name,
      unit: "%",
      target: targetPct,
      green: targetPct,
      amber: Math.round(tbl.target * 0.9 * 1000) / 10,
      direction: "higher_is_better",
      ...ns.detail,
      numerator:
        "Σ(quarter weight × component actual fraction) over this quarter's component KPIs (a missing component counts as 0).",
      denominator:
        "Σ(quarter weight) across the same components (normalised to the weights that have data — see details.weight_with_data).",
      scope:
        "Current quarter's component KPIs and weights from the North Star plan; resets each quarter. Composite — not a simple num/den count.",
      rounding: "value = round(weighted fraction × 100) to 1 decimal place.",
      entry_where:
        "Composite — auto-computed from the KPIs in this scorecard; nothing to enter directly.",
      entry_route: "/leadership-kpis",
      baseline: 0,
      period_type: PERIOD_TYPE_BY_CODE[ns.code] ?? "quarter",
    });
    let score = 0;
    let weightWithData = 0;
    const missing: string[] = [];
    for (const comp of tbl.components) {
      const k = liveMap.get(comp.code);
      if (k && typeof k.value === "number") {
        score += comp.weight * componentFraction(comp.code, k.value);
        weightWithData += comp.weight;
      } else {
        missing.push(comp.code);
      }
    }
    if (weightWithData <= 0) {
      unavailable.push({
        code: ns.code,
        name: ns.name,
        reason: "no_component_data",
      });
      continue;
    }
    const value = Math.round(score * 1000) / 10;
    const status: RagStatus =
      value >= targetPct ? "green" : value >= targetPct * 0.9 ? "amber" : "red";
    kpis.push({
      code: ns.code,
      name: ns.name,
      unit: "%",
      value,
      status,
      status_label: leadershipStatus(value, 0, targetPct, "higher_is_better", status),
      baseline: 0,
      progress_pct: progressPct(value, 0, targetPct),
      data_available: true,
      period,
      ...periodFor(ns.code, now),
      as_of: asOf,
      details: {
        quarter: `Q${quarter}`,
        target_pct: targetPct,
        weight_with_data: Math.round(weightWithData * 100) / 100,
        components_missing: missing,
      },
    });
  }

  return { generated_at: asOf, source: "QMS", definitions, kpis, unavailable };
}
