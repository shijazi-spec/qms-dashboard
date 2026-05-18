/**
 * Sector-aware CS-pipeline overlap classification for the Duplicate Radar.
 *
 * Background: every Deal record in CRM has a "Customer Success" section with a
 * `Phase` field (Onboarding / Adoption / Renewal / Termination). When a duplicate
 * cluster overlaps with an active CS-pipeline deal on the same domain, marketing
 * should NOT push it to sales as a fresh lead — it's already an active customer.
 *
 * Sector-based re-engagement policy (set by GRQ Quality):
 *   - Private sector: sales can re-engage if churn date > 6 months
 *   - Government sector: sales can re-engage if churn date > 12 months
 *
 * Everything that affects detection (phase field name, active-phase list,
 * cool-off windows, gov-detection signal) is env-configurable so Quality can
 * adjust without code changes.
 */

export type CsLifecycleState =
  | "onboarding"
  | "adoption"
  | "renewal"
  | "termination_recent"
  | "termination_old"
  | null;

export type CsOverlapVerdict = "block" | "review" | "warn" | null;

export type ClientSector = "private" | "government" | null;

export interface CsOverlapInput {
  /** Phase field value from the Customer Success section on the Deal. */
  phase?: string | null;
  /** Churn Date — only meaningful for Termination phase. ISO string or Date. */
  churn_date?: string | Date | null;
  /** Gov Type field value from CRM (e.g. "Private", "Government"). */
  gov_type?: string | null;
  /** Domain — fallback signal when gov_type is empty. */
  domain?: string | null;
}

export interface CsOverlapClassification {
  lifecycle_state: CsLifecycleState;
  sector: ClientSector;
  churn_days: number | null;
  verdict: CsOverlapVerdict;
  reason: string;
}

interface Config {
  phaseFieldActive: string[];
  phaseTermination: string;
  cooloffPrivateDays: number;
  cooloffGovernmentDays: number;
  govValues: string[];
  govDomainPatterns: string[];
}

let cachedConfig: Config | null = null;

function loadConfig(): Config {
  if (cachedConfig) return cachedConfig;
  const list = (v: string | undefined, fallback: string[]): string[] =>
    (v ?? "").trim()
      ? (v as string).split(",").map((s) => s.trim()).filter(Boolean)
      : fallback;

  cachedConfig = {
    phaseFieldActive: list(process.env.DUPLICATE_RADAR_CS_ACTIVE_PHASES, [
      "Onboarding",
      "Adoption",
      "Renewal",
    ]),
    phaseTermination:
      process.env.DUPLICATE_RADAR_CS_TERMINATION_PHASE?.trim() || "Termination",
    cooloffPrivateDays: Number.parseInt(
      process.env.DUPLICATE_RADAR_CHURN_COOLOFF_PRIVATE_DAYS ?? "180",
      10,
    ),
    cooloffGovernmentDays: Number.parseInt(
      process.env.DUPLICATE_RADAR_CHURN_COOLOFF_GOVERNMENT_DAYS ?? "365",
      10,
    ),
    govValues: list(process.env.DUPLICATE_RADAR_GOV_VALUES, [
      "Government",
      "Gov",
      "Public Sector",
      "حكومي",
    ]),
    govDomainPatterns: list(process.env.DUPLICATE_RADAR_GOV_DOMAIN_PATTERNS, [
      ".gov.sa",
      ".gov",
      ".mil.sa",
    ]),
  };
  return cachedConfig;
}

/** Reset config cache. Tests should call this between cases. */
export function resetCsOverlapConfigCache(): void {
  cachedConfig = null;
}

/**
 * Detect sector for a record.
 *
 * Order:
 *   1. gov_type field — exact match (case-insensitive) against configured gov values
 *   2. Domain TLD — ends with any configured pattern (.gov.sa, .gov, etc.)
 *   3. Default: private
 *
 * Returns null only when both inputs are absent.
 */
export function detectSector(input: {
  gov_type?: string | null;
  domain?: string | null;
}): ClientSector {
  const cfg = loadConfig();
  const gt = (input.gov_type ?? "").trim();
  if (gt) {
    const govMatch = cfg.govValues.some(
      (v) => v.toLowerCase() === gt.toLowerCase(),
    );
    if (govMatch) return "government";
    return "private";
  }
  const d = (input.domain ?? "").trim().toLowerCase();
  if (d) {
    if (cfg.govDomainPatterns.some((p) => d.endsWith(p.toLowerCase()))) {
      return "government";
    }
    return "private";
  }
  return null;
}

function parseChurnDate(d: string | Date | null | undefined): Date | null {
  if (!d) return null;
  if (d instanceof Date) return isNaN(d.getTime()) ? null : d;
  // Tolerate ISO strings, "2025-05-13", and Excel-serial-as-string if any sneak in
  const parsed = new Date(d);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function daysSince(d: Date, now: Date = new Date()): number {
  const ms = now.getTime() - d.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

/**
 * Classify a CS overlap and produce a verdict.
 *
 * Verdict ladder:
 *   - Phase ∈ {Onboarding, Adoption, Renewal}                  → BLOCK
 *   - Phase = Termination + within sector cool-off              → REVIEW
 *   - Phase = Termination + past sector cool-off                → WARN
 *   - No phase / non-CS-pipeline                                → null
 */
export function classifyCsOverlap(
  input: CsOverlapInput,
  now: Date = new Date(),
): CsOverlapClassification {
  const cfg = loadConfig();
  const sector = detectSector({ gov_type: input.gov_type, domain: input.domain });
  const phase = (input.phase ?? "").trim();

  if (!phase) {
    return {
      lifecycle_state: null,
      sector,
      churn_days: null,
      verdict: null,
      reason: "no_cs_phase",
    };
  }

  // Active phases — always block regardless of sector
  const isActive = cfg.phaseFieldActive.some(
    (p) => p.toLowerCase() === phase.toLowerCase(),
  );
  if (isActive) {
    const state = phase.toLowerCase() as CsLifecycleState;
    return {
      lifecycle_state: (state === "onboarding" || state === "adoption" || state === "renewal")
        ? state
        : "renewal",
      sector,
      churn_days: null,
      verdict: "block",
      reason: `active_phase:${phase.toLowerCase()}`,
    };
  }

  // Termination — sector-aware cool-off
  if (phase.toLowerCase() === cfg.phaseTermination.toLowerCase()) {
    const churned = parseChurnDate(input.churn_date);
    const cooloffDays =
      sector === "government" ? cfg.cooloffGovernmentDays : cfg.cooloffPrivateDays;

    if (!churned) {
      // Termination phase but no churn date — be conservative, REVIEW
      return {
        lifecycle_state: "termination_recent",
        sector,
        churn_days: null,
        verdict: "review",
        reason: "termination_no_churn_date",
      };
    }

    const days = daysSince(churned, now);
    if (days < cooloffDays) {
      return {
        lifecycle_state: "termination_recent",
        sector,
        churn_days: days,
        verdict: "review",
        reason: `termination_within_cooloff:${days}d<${cooloffDays}d`,
      };
    }
    return {
      lifecycle_state: "termination_old",
      sector,
      churn_days: days,
      verdict: "warn",
      reason: `termination_past_cooloff:${days}d>=${cooloffDays}d`,
    };
  }

  // Unknown phase value — no verdict
  return {
    lifecycle_state: null,
    sector,
    churn_days: null,
    verdict: null,
    reason: `unknown_phase:${phase}`,
  };
}

/**
 * Pull CS-pipeline fields out of a Zoho raw_data JSON blob, tolerant of common
 * field-name variations (Phase / phase / Phase__c, etc). Specific keys can be
 * pinned via env (DUPLICATE_RADAR_FIELD_PHASE etc).
 *
 * Phase 4 completion: also extracts Customer_Since and Trial_End_Date when
 * those fields are present (or env-mapped). These let the lifecycle module
 * reason about whether an Adoption-phase deal actually completed Onboarding
 * and/or its trial period.
 */
export function extractCsFieldsFromRawData(
  rawData: unknown,
  context: { domain?: string | null } = {},
): CsOverlapInput & {
  arr_value?: number | null;
  customer_since?: string | Date | null;
  trial_end_date?: string | Date | null;
  company_domain?: string | null;
  churn_reason?: string | null;
} {
  if (!rawData || typeof rawData !== "object") {
    return { domain: context.domain ?? null };
  }
  const r = rawData as Record<string, unknown>;

  const envOr = (envKey: string, defaults: string[]): string[] => {
    const v = process.env[envKey];
    return v && v.trim() ? [v.trim()] : defaults;
  };

  const tryKeys = (keys: string[]): unknown => {
    for (const k of keys) {
      if (r[k] !== undefined && r[k] !== null && r[k] !== "") return r[k];
    }
    return null;
  };

  const phaseRaw = tryKeys(
    envOr("DUPLICATE_RADAR_FIELD_PHASE", [
      "Phase",
      "phase",
      "CS_Phase",
      "Customer_Phase",
    ]),
  );
  const churnRaw = tryKeys(
    envOr("DUPLICATE_RADAR_FIELD_CHURN_DATE", [
      "Churn_Date",
      "churn_date",
      "ChurnDate",
      "Churn date",
    ]),
  );
  const govRaw = tryKeys(
    envOr("DUPLICATE_RADAR_FIELD_GOV_TYPE", [
      "Gov_Type",
      "gov_type",
      "GovType",
      "Gov Type",
    ]),
  );
  const arrRaw = tryKeys(
    envOr("DUPLICATE_RADAR_FIELD_ARR_VALUE", [
      "ARR_value",
      "ARR_Value",
      "arr_value",
      "ARR value",
      "ARR",
    ]),
  );
  const customerSinceRaw = tryKeys(
    envOr("DUPLICATE_RADAR_FIELD_CUSTOMER_SINCE", [
      "Customer_Since",
      "customer_since",
      "CustomerSince",
      "Customer Since",
    ]),
  );
  const trialEndRaw = tryKeys(
    envOr("DUPLICATE_RADAR_FIELD_TRIAL_END", [
      "Trial_End_Date",
      "trial_end_date",
      "TrialEndDate",
      "Trial End Date",
      "Trial_End",
    ]),
  );
  // CS team's curated authoritative domain — populated at Onboarding handoff.
  // Tolerant of the common Zoho key variations; pin via env if your field has
  // a different API name (DUPLICATE_RADAR_FIELD_COMPANY_DOMAIN=Company_Domain).
  const companyDomainRaw = tryKeys(
    envOr("DUPLICATE_RADAR_FIELD_COMPANY_DOMAIN", [
      "Company_Domain",
      "company_domain",
      "CompanyDomain",
      "Company Domain",
      "Domain",
      "domain",
    ]),
  );
  // Churn reason — required alongside Churn_Date when a deal moves to
  // Termination phase. Without it the CS team can't run reason-level
  // analytics ("why are private clients churning at month 6?").
  const churnReasonRaw = tryKeys(
    envOr("DUPLICATE_RADAR_FIELD_CHURN_REASON", [
      "Churn_Reason",
      "churn_reason",
      "ChurnReason",
      "Churn Reason",
      "Reason_For_Churn",
      "Reason for Churn",
    ]),
  );

  const arrNum =
    arrRaw == null
      ? null
      : typeof arrRaw === "number"
        ? arrRaw
        : Number.parseFloat(String(arrRaw)) || 0;

  return {
    phase: phaseRaw == null ? null : String(phaseRaw),
    churn_date: churnRaw == null ? null : (churnRaw as string | Date),
    gov_type: govRaw == null ? null : String(govRaw),
    domain: context.domain ?? null,
    arr_value: arrNum,
    customer_since:
      customerSinceRaw == null ? null : (customerSinceRaw as string | Date),
    trial_end_date:
      trialEndRaw == null ? null : (trialEndRaw as string | Date),
    company_domain:
      companyDomainRaw == null
        ? null
        : String(companyDomainRaw).trim().toLowerCase() || null,
    churn_reason:
      churnReasonRaw == null
        ? null
        : String(churnReasonRaw).trim() || null,
  };
}

/** Pick the strongest verdict across multiple records sharing a cluster. */
export function rollupClusterVerdict(
  perRecord: CsOverlapClassification[],
): {
  verdict: CsOverlapVerdict;
  lifecycle_state: CsLifecycleState;
  sector: ClientSector;
} {
  // Severity order: block > review > warn > null
  const order: Record<string, number> = { block: 3, review: 2, warn: 1 };
  let best: CsOverlapClassification | null = null;
  for (const r of perRecord) {
    if (!r.verdict) continue;
    if (!best || (order[r.verdict] ?? 0) > (order[best.verdict ?? ""] ?? 0)) {
      best = r;
    }
  }
  if (!best) {
    return { verdict: null, lifecycle_state: null, sector: null };
  }
  return {
    verdict: best.verdict,
    lifecycle_state: best.lifecycle_state,
    sector: best.sector,
  };
}
