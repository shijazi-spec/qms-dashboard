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
  | "termination_missing_churn_reason"
  | "phase_transition_stalled"
  | "adoption_premature"
  | "missing_company_domain"
  // 2026-05-30 — CS data-quality audit pack. These rules surface deals
  // where the CS team has not populated the section's core fields, so
  // the dashboard becomes a per-deal completeness audit rather than
  // just a process-violation list.
  | "missing_cs_owner"
  | "missing_customer_since"
  | "missing_renewal_date"
  | "missing_health_score"
  | "missing_arr_value"
  | "renewal_overdue";

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
  /**
   * Days a Renewal Date can be overdue before the deal is treated as a CRITICAL
   * churn/termination candidate (not just a warning). Default 90 (~a quarter):
   * past this, the renewal motion has clearly failed and the deal should be
   * moved to Termination/Churn.
   */
  renewalOverdueCriticalDays: number;
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
    renewalOverdueCriticalDays: num(
      process.env.CS_LIFECYCLE_RENEWAL_OVERDUE_CRITICAL_DAYS,
      90,
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

const COMPANY_DOMAIN_DEFAULT_KEYS = new Set([
  "Company_Domain",
  "company_domain",
  "CompanyDomain",
  "Company Domain",
  "Domain",
  "domain",
]);

function collectDomainLikeKeys(rawData: unknown): string[] {
  if (!rawData || typeof rawData !== "object") return [];
  const out: string[] = [];
  for (const k of Object.keys(rawData as Record<string, unknown>)) {
    if (COMPANY_DOMAIN_DEFAULT_KEYS.has(k)) continue;
    if (/domain/i.test(k)) out.push(k);
  }
  return out.slice(0, 5);
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
  termination_missing_churn_reason:
    "Termination phase requires a Churn Reason so CS can analyse churn drivers (price, fit, competitor, …). Fill the Churn_Reason field on the Deal in Zoho.",
  phase_transition_stalled:
    "Deal has not been touched recently and is not in a steady-state phase. Confirm CS is still working it or move to the appropriate next phase.",
  adoption_premature:
    "Deal moved to Adoption without evidence of a completed Onboarding period (or while still inside the trial window). Verify Onboarding sign-off and trial completion with CS before counting this as an active adopter.",
  missing_company_domain:
    "Active Customer Success deal has no Company_Domain populated. CS team should fill this field at Onboarding handoff so Marketing / Sales preflight checks recognise this account as an active customer.",
  missing_cs_owner:
    "Active CS deal has no CS Owner Name. Assign an owner so the deal has someone accountable for the CS motion.",
  missing_customer_since:
    "Active CS deal has no Customer Since date. Backfill it from the original signup / contract date so renewal and tenure reporting works.",
  missing_renewal_date:
    "Active CS deal has no Renewal Date. Set it so the radar can surface upcoming renewals and overdue renewal motion.",
  missing_health_score:
    "Active CS deal has no Health score. Score the customer (0–100) so coaching plans and CS escalation triggers have a signal to read from.",
  missing_arr_value:
    "Active CS deal has no ARR value (or it is zero). Set it so revenue-at-risk reports and ARR exposure rollups attribute correctly.",
  renewal_overdue:
    "Renewal Date has already passed but the deal is still in an active CS phase. Confirm renewal status with the customer and update the Renewal Date or Phase.",
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
  const renewal = parseDate(fields.renewal_date ?? null);
  const daysSinceModified = modified ? daysBetween(modified, now) : null;
  const violations: CsViolation[] = [];

  // Re-engagement signal: a Renewal Date set AFTER the Churn Date means the
  // customer churned and then came back. The Churn Date becomes historical
  // and should not trigger phase_churn_desync — the deal is legitimately
  // back in an active phase (typically Adoption).
  const renewedAfterChurn =
    churn !== null && renewal !== null && renewal.getTime() > churn.getTime();

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
    phase.toLowerCase() !== cfg.terminationPhase.toLowerCase() &&
    !renewedAfterChurn
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

  // 3b. Termination without Churn Reason — independent of the Churn Date
  //     check above. Both can fire on the same deal; the UI groups
  //     violations by deal so duplicates don't show as separate table rows.
  if (
    phase.toLowerCase() === cfg.terminationPhase.toLowerCase() &&
    !(fields.churn_reason ?? "").trim()
  ) {
    violations.push({
      code: "termination_missing_churn_reason",
      severity: "warning",
      message: `Phase is "${phase}" but Churn Reason is empty — CS can't analyse churn drivers without it.`,
      days_in_phase: daysSinceModified,
      current_phase: phase,
      suggested_action: SUGGESTED_ACTIONS.termination_missing_churn_reason,
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

  // 5. Adoption premature — Phase = Adoption but the trial period has not
  //    yet ended (deal flipped to a paying / fully-adopted state while
  //    still inside a free / evaluation window).
  //
  //    The earlier customer-age heuristic ("Customer_Since < N days =
  //    jumped over Onboarding") was removed: in GRQ's CS model Adoption
  //    is the **terminal** lifecycle phase for new clients, so reaching
  //    it shortly after sign-up is the normal, healthy path — not a
  //    process breach. The trial-end check is kept because a deal
  //    flagged "Adoption" while still inside the trial is a genuine
  //    billing / state inconsistency regardless of customer age.
  if (phase.toLowerCase() === "adoption") {
    const trialEnd = parseDate(fields.trial_end_date ?? null);
    if (trialEnd && trialEnd.getTime() > now.getTime()) {
      const daysRemaining = Math.ceil(
        (trialEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
      );
      violations.push({
        code: "adoption_premature",
        severity: "warning",
        message: `Adoption phase reached prematurely: trial ends in ${daysRemaining}d (deal moved to Adoption before trial completion).`,
        days_in_phase: daysSinceModified,
        current_phase: phase,
        suggested_action: SUGGESTED_ACTIONS.adoption_premature,
      });
    }
  }

  // 6. Missing Company_Domain — only fires for ACTIVE CS phases where CS is
  //    expected to have curated the authoritative domain at Onboarding
  //    handoff. Skipped for pre-Onboarding records and Termination (per
  //    GRQ ops decision: only enforce for clients currently in the CS
  //    pipeline). Severity = warning (data quality, not SLA breach).
  const isActiveCsPhase = cfg.activePhases.some(
    (p) => p.toLowerCase() === phase.toLowerCase(),
  );
  if (isActiveCsPhase) {
    const cd = (fields.company_domain ?? "").trim();
    if (!cd) {
      // Diagnostic: if raw_data contains domain-like keys none of the extractor's
      // variants matched, surface them so an operator can pin the correct Zoho
      // API name via DUPLICATE_RADAR_FIELD_COMPANY_DOMAIN. Without this hint,
      // a populated-in-CRM-but-missing-in-radar bug is invisible.
      const domainKeys = collectDomainLikeKeys(input.raw_data);
      const hint =
        domainKeys.length > 0
          ? ` (raw_data contains domain-like keys not matched by the extractor: ${domainKeys.join(", ")}; set DUPLICATE_RADAR_FIELD_COMPANY_DOMAIN to the correct Zoho API name)`
          : "";
      violations.push({
        code: "missing_company_domain",
        severity: "warning",
        message: `Active CS deal in phase "${phase}" has no Company_Domain populated. Without it, Marketing/Sales preflight cannot recognise this as an existing customer.${hint}`,
        days_in_phase: daysSinceModified,
        current_phase: phase,
        suggested_action: SUGGESTED_ACTIONS.missing_company_domain,
      });
    }
  }

  // ─── CS data-quality completeness rules (2026-05-30) ───────────────────
  //
  // These rules fire only for ACTIVE CS phases — pre-Onboarding records
  // and Termination are deliberately exempt. The CS team isn't expected
  // to have filled every section field BEFORE Onboarding completes
  // (data flows in over time during the sales→CS handoff), and a
  // Terminated deal is read-only so flagging it for missing data adds
  // noise without action.
  //
  // Each rule is independent — a single deal missing all five core
  // fields will surface 5 separate violations, which the UI groups
  // into one row per deal so the operator sees the full punch list at
  // a glance. Severity choices reflect what's actionable:
  //   • critical → blocks the CS motion (missing owner = no one running it).
  //   • warning  → silently corrupts reporting (missing dates / scores).
  //   • renewal_overdue is a warning, not critical, because a passed
  //     renewal date may legitimately mean the renewal just landed and
  //     the date hasn't been updated yet; the CS team should confirm
  //     status before treating it as a SLA breach.
  if (isActiveCsPhase) {
    // 7. Missing CS Owner — every active CS deal must have someone
    //    accountable for the motion. Severity = critical because the
    //    absence of an owner means nobody is going to act on any of
    //    the other warnings either.
    if (!(fields.cs_owner_name ?? "").trim()) {
      violations.push({
        code: "missing_cs_owner",
        severity: "critical",
        message: `Active CS deal in phase "${phase}" has no CS Owner Name set. Nobody is accountable for the CS motion until this is filled.`,
        days_in_phase: daysSinceModified,
        current_phase: phase,
        suggested_action: SUGGESTED_ACTIONS.missing_cs_owner,
      });
    }

    // 8. Missing Customer Since — required for tenure / renewal reporting.
    if (!fields.customer_since) {
      violations.push({
        code: "missing_customer_since",
        severity: "warning",
        message: `Active CS deal in phase "${phase}" has no Customer Since date. Backfill from the original contract / signup date.`,
        days_in_phase: daysSinceModified,
        current_phase: phase,
        suggested_action: SUGGESTED_ACTIONS.missing_customer_since,
      });
    }

    // 9. Missing Renewal Date — required for renewal motion + ARR risk.
    if (!fields.renewal_date) {
      violations.push({
        code: "missing_renewal_date",
        severity: "warning",
        message: `Active CS deal in phase "${phase}" has no Renewal Date. Renewal motion and ARR-at-risk reports skip this deal.`,
        days_in_phase: daysSinceModified,
        current_phase: phase,
        suggested_action: SUGGESTED_ACTIONS.missing_renewal_date,
      });
    }

    // 10. Missing Health score — Health=null is the gap (Health=0 is
    //     a legitimate "this customer is on fire" score and must NOT
    //     trip this rule). String compare so the extractor's "null →
    //     null", "empty-string → null" passthrough behaves correctly.
    const healthVal = (fields.health ?? "").trim();
    if (!healthVal) {
      violations.push({
        code: "missing_health_score",
        severity: "warning",
        message: `Active CS deal in phase "${phase}" has no Health score. Coaching plans and escalation triggers can't read a signal.`,
        days_in_phase: daysSinceModified,
        current_phase: phase,
        suggested_action: SUGGESTED_ACTIONS.missing_health_score,
      });
    }

    // 11. Missing ARR value — null or 0 both count as "not set" for
    //     audit purposes. ARR=0 is a real data-entry mistake on a
    //     paying customer; flag it the same as null. fields.arr_value
    //     comes from the extractor as Number | null (already coerced).
    const arrVal = fields.arr_value;
    if (arrVal == null || arrVal === 0) {
      violations.push({
        code: "missing_arr_value",
        severity: "warning",
        message: `Active CS deal in phase "${phase}" has no ARR value${arrVal === 0 ? " (set to 0)" : ""}. Revenue-at-risk and ARR exposure rollups will under-count this customer.`,
        days_in_phase: daysSinceModified,
        current_phase: phase,
        suggested_action: SUGGESTED_ACTIONS.missing_arr_value,
      });
    }

    // 12. Renewal overdue — Renewal Date in the past while phase is
    //     still active. Genuine signal that either the renewal landed
    //     and the date wasn't updated, OR the customer is silently
    //     past the agreed term without a renewal motion.
    if (renewal && renewal.getTime() < now.getTime()) {
      const daysOverdue = Math.floor(
        (now.getTime() - renewal.getTime()) / (1000 * 60 * 60 * 24),
      );
      // Past ~a quarter overdue the renewal motion has clearly failed: escalate
      // to CRITICAL — the deal should be moved to Termination/Churn rather than
      // left sitting in an active phase.
      const pastQuarter = daysOverdue >= cfg.renewalOverdueCriticalDays;
      violations.push({
        code: "renewal_overdue",
        severity: pastQuarter ? "critical" : "warning",
        message: pastQuarter
          ? `Renewal Date was ${daysOverdue} day(s) ago — over ${cfg.renewalOverdueCriticalDays} days (a quarter) overdue while still in active phase "${phase}". The renewal has effectively lapsed: move this deal to Termination/Churn or close the renewal now.`
          : `Renewal Date was ${daysOverdue} day(s) ago but deal is still in active phase "${phase}". Confirm renewal status and update the date or phase.`,
        days_in_phase: daysSinceModified,
        current_phase: phase,
        suggested_action: pastQuarter
          ? `Renewal is over a quarter overdue (${daysOverdue} days). Treat as a churn/termination candidate: confirm with the CS owner, then move the deal to the Termination phase with a Churn Date and Churn Reason, or record a completed renewal if it actually renewed.`
          : SUGGESTED_ACTIONS.renewal_overdue,
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
  /** CS deals counted by current lifecycle phase (onboarding/adoption/renewal/
   *  termination/…) — answers "how many deals are in the renewal stage". */
  by_phase: Record<string, number>;
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
      termination_missing_churn_reason: 0,
      phase_transition_stalled: 0,
      adoption_premature: 0,
      missing_company_domain: 0,
      missing_cs_owner: 0,
      missing_customer_since: 0,
      missing_renewal_date: 0,
      missing_health_score: 0,
      missing_arr_value: 0,
      renewal_overdue: 0,
    },
    by_phase: {},
  };
  for (const ev of evaluations) {
    if (ev.is_cs_deal) {
      s.total_cs_deals++;
      const phase = (ev.current_phase || "unknown").toLowerCase();
      s.by_phase[phase] = (s.by_phase[phase] || 0) + 1;
    }
    for (const v of ev.violations) {
      s.total_violations++;
      s.by_severity[v.severity]++;
      s.by_code[v.code]++;
    }
  }
  return s;
}
