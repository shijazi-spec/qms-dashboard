/**
 * CS Lifecycle Compliance — detects when Customer Success deals deviate from
 * the GRQ-defined process rules:
 *
 *   - Onboarding stage ≈ 30 calendar days
 *   - One working day SLA for phase-to-phase transitions
 *   - Churn Date set → Phase auto-moves to Termination
 *   - Termination phase implies Churn Date populated (data integrity)
 *
 * Pure functions only — DB queries live in duplicateRadarDatabase.ts, the
 * Inngest cron / route / UI compose this with that data layer. No external
 * dependencies; all thresholds env-configurable.
 */

import { extractCsFieldsFromRawData } from "./duplicateRadarCsOverlap";

export type CsViolationCode =
  | "onboarding_overdue"
  | "phase_churn_desync"
  | "termination_missing_churn_date"
  | "phase_transition_stalled"
  | "adoption_premature";

export type CsViolationSeverity = "info" | "warning" | "critical";

export interface CsViolation {
  code: CsViolationCode;
  severity: CsViolationSeverity;
  message: string;
  days_in_phase: number | null;
  current_phase: string | null;
  suggested_action: string;
}

export interface CsLifecycleEvaluation {
  is_cs_deal: boolean;
  current_phase: string | null;
  days_since_modified: number | null;
  violations: CsViolation[];
}

export interface CsLifecycleInput {
  raw_data?: unknown;
  modified_date?: string | Date | null;
  /** Optional pre-resolved domain (passed through to extractCsFieldsFromRawData). */
  domain?: string | null;
  /** Optional pre-resolved gov_type (overrides whatever is in raw_data). */
  gov_type?: string | null;
}

interface Config {
  onboardingMaxDays: number;
  stalledTransitionDays: number;
  activePhases: string[];
  terminationPhase: string;
  steadyStatePhases: string[];
  /** Minimum days a customer must have existed before Adoption is plausible. */
  adoptionMinCustomerAgeDays: number;
}

let cachedConfig: Config | null = null;

function loadConfig(): Config {
  if (cachedConfig) return cachedConfig;
  const list = (v: string | undefined, fallback: string[]): string[] =>
    (v ?? "").trim()
      ? (v as string).split(",").map((s) => s.trim()).filter(Boolean)
      : fallback;
  const num = (v: string | undefined, fallback: number): number => {
    const n = Number.parseInt(v ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };

  cachedConfig = {
    onboardingMaxDays: num(
      process.env.CS_LIFECYCLE_ONBOARDING_MAX_DAYS,
      30,
    ),
    stalledTransitionDays: num(
      process.env.CS_LIFECYCLE_STALLED_TRANSITION_DAYS,
      7,
    ),
    activePhases: list(
      process.env.DUPLICATE_RADAR_CS_ACTIVE_PHASES,
      ["Onboarding", "Adoption", "Renewal"],
    ),
    terminationPhase:
      process.env.DUPLICATE_RADAR_CS_TERMINATION_PHASE?.trim() ||
      "Termination",
    steadyStatePhases: list(
      process.env.CS_LIFECYCLE_STEADY_STATE_PHASES,
      ["Adoption", "Renewal"],
    ),
    adoptionMinCustomerAgeDays: num(
      process.env.CS_LIFECYCLE_ADOPTION_MIN_CUSTOMER_AGE_DAYS,
      30,
    ),
  };
  return cachedConfig;
}

export function resetCsLifecycleConfigCache(): void {
  cachedConfig = null;
}

function parseDate(d: string | Date | null | undefined): Date | null {
  if (!d) return null;
  if (d instanceof Date) return isNaN(d.getTime()) ? null : d;
  const p = new Date(d);
  return isNaN(p.getTime()) ? null : p;
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

const SUGGESTED_ACTIONS: Record<CsViolationCode, string> = {
  onboarding_overdue:
    "Onboarding stage has run beyond the 30-day target. Confirm with the CS owner whether the client agreement was delayed or escalate.",
  phase_churn_desync:
    "Churn Date is populated but Phase is not Termination. Move the deal to Termination phase (CS SLA: one working day).",
  termination_missing_churn_date:
    "Termination phase requires a Churn Date for downstream reporting. Backfill the date or revert the phase.",
  phase_transition_stalled:
    "Deal has not been touched recently and is not in a steady-state phase. Confirm CS is still working it or move to the appropriate next phase.",
  adoption_premature:
    "Deal moved to Adoption without evidence of a completed Onboarding period (or while still inside the trial window). Verify Onboarding sign-off and trial completion with CS before counting this as an active adopter.",
};

/**
 * Evaluate a single Deal record's Customer Success section for lifecycle
 * compliance violations. Returns is_cs_deal=false when the record does not
 * expose a Phase field (i.e. not a CS-tracked deal).
 */
export function evaluateCsLifecycle(
  input: CsLifecycleInput,
  now: Date = new Date(),
): CsLifecycleEvaluation {
  const cfg = loadConfig();
  const fields = extractCsFieldsFromRawData(input.raw_data, {
    domain: input.domain ?? null,
  });
  if (input.gov_type) fields.gov_type = input.gov_type;

  const phase = (fields.phase ?? "").trim();
  if (!phase) {
    return {
      is_cs_deal: false,
      current_phase: null,
      days_since_modified: null,
      violations: [],
    };
  }

  const modified = parseDate(input.modified_date);
  const churn = parseDate(fields.churn_date ?? null);
  const daysSinceModified = modified ? daysBetween(modified, now) : null;
  const violations: CsViolation[] = [];

  // 1. Onboarding overdue (uses modified_date as proxy for phase entry time)
  if (phase.toLowerCase() === "onboarding" && daysSinceModified !== null) {
    if (daysSinceModified > cfg.onboardingMaxDays) {
      violations.push({
        code: "onboarding_overdue",
        severity: "warning",
        message: `Deal has been in Onboarding for ${daysSinceModified} days (target ≤${cfg.onboardingMaxDays}).`,
        days_in_phase: daysSinceModified,
        current_phase: phase,
        suggested_action: SUGGESTED_ACTIONS.onboarding_overdue,
      });
    }
  }

  // 2. Phase / Churn-Date desync
  if (
    churn &&
    phase.toLowerCase() !== cfg.terminationPhase.toLowerCase()
  ) {
    violations.push({
      code: "phase_churn_desync",
      severity: "critical",
      message: `Churn Date is set (${churn.toISOString().slice(0, 10)}) but Phase is "${phase}" — should be "${cfg.terminationPhase}".`,
      days_in_phase: daysSinceModified,
      current_phase: phase,
      suggested_action: SUGGESTED_ACTIONS.phase_churn_desync,
    });
  }

  // 3. Termination without Churn Date
  if (
    phase.toLowerCase() === cfg.terminationPhase.toLowerCase() &&
    !churn
  ) {
    violations.push({
      code: "termination_missing_churn_date",
      severity: "warning",
      message: `Phase is "${phase}" but Churn Date is empty.`,
      days_in_phase: daysSinceModified,
      current_phase: phase,
      suggested_action: SUGGESTED_ACTIONS.termination_missing_churn_date,
    });
  }

  // 4. Phase transition stalled — only if NOT a steady-state phase (Adoption /
  //    Renewal are expected to sit for long stretches; Onboarding is bounded
  //    by rule #1; Termination is terminal). This catches "stuck in an
  //    intermediate transition that should have advanced".
  if (
    daysSinceModified !== null &&
    daysSinceModified > cfg.stalledTransitionDays &&
    !cfg.steadyStatePhases.some(
      (p) => p.toLowerCase() === phase.toLowerCase(),
    ) &&
    phase.toLowerCase() !== "onboarding" && // covered by rule #1
    phase.toLowerCase() !== cfg.terminationPhase.toLowerCase()
  ) {
    violations.push({
      code: "phase_transition_stalled",
      severity: "info",
      message: `Deal in phase "${phase}" has not been modified in ${daysSinceModified} days (SLA: 1 working day per transition).`,
      days_in_phase: daysSinceModified,
      current_phase: phase,
      suggested_action: SUGGESTED_ACTIONS.phase_transition_stalled,
    });
  }

  // 5. Adoption premature — Phase = Adoption but either (a) the customer was
  //    created less than `adoptionMinCustomerAgeDays` ago (jumped over the
  //    Onboarding period) or (b) the trial period has not yet ended.
  //
  //    This is the closest signal-only check we can do without Zoho Stage
  //    History. Customer_Since and Trial_End_Date are env-mappable and may
  //    be absent — when both are absent we skip the rule entirely rather
  //    than fire false positives.
  if (phase.toLowerCase() === "adoption") {
    const customerSince = parseDate(fields.customer_since ?? null);
    const trialEnd = parseDate(fields.trial_end_date ?? null);
    const reasons: string[] = [];

    if (customerSince) {
      const ageDays = daysBetween(customerSince, now);
      if (ageDays < cfg.adoptionMinCustomerAgeDays) {
        reasons.push(
          `customer is only ${ageDays}d old (< ${cfg.adoptionMinCustomerAgeDays}d, expected post-Onboarding)`,
        );
      }
    }
    if (trialEnd && trialEnd.getTime() > now.getTime()) {
      const daysRemaining = Math.ceil(
        (trialEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
      );
      reasons.push(
        `trial ends in ${daysRemaining}d (deal moved to Adoption before trial completion)`,
      );
    }

    if (reasons.length > 0) {
      violations.push({
        code: "adoption_premature",
        severity: "warning",
        message: `Adoption phase reached prematurely: ${reasons.join("; ")}.`,
        days_in_phase: daysSinceModified,
        current_phase: phase,
        suggested_action: SUGGESTED_ACTIONS.adoption_premature,
      });
    }
  }

  return {
    is_cs_deal: true,
    current_phase: phase,
    days_since_modified: daysSinceModified,
    violations,
  };
}

/**
 * Roll up violations across many records into a summary count by severity
 * and code.
 */
export interface CsLifecycleSummary {
  total_evaluated: number;
  total_cs_deals: number;
  total_violations: number;
  by_severity: Record<CsViolationSeverity, number>;
  by_code: Record<CsViolationCode, number>;
}

export function summarizeViolations(
  evaluations: CsLifecycleEvaluation[],
): CsLifecycleSummary {
  const s: CsLifecycleSummary = {
    total_evaluated: evaluations.length,
    total_cs_deals: 0,
    total_violations: 0,
    by_severity: { info: 0, warning: 0, critical: 0 },
    by_code: {
      onboarding_overdue: 0,
      phase_churn_desync: 0,
      termination_missing_churn_date: 0,
      phase_transition_stalled: 0,
      adoption_premature: 0,
    },
  };
  for (const ev of evaluations) {
    if (ev.is_cs_deal) s.total_cs_deals++;
    for (const v of ev.violations) {
      s.total_violations++;
      s.by_severity[v.severity]++;
      s.by_code[v.code]++;
    }
  }
  return s;
}
