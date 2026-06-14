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
  // Quality may configure DUPLICATE_RADAR_CS_ACTIVE_PHASES with values that
  // don't lower-case to one of the three standard names (e.g. "Re-engagement").
  // We still flag those as BLOCK, but tag the state so dashboards don't lie
  // by labelling them as "Renewal".
  | "active_other"
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
  /**
   * Renewal Date — when set AFTER Churn Date on a Termination-phase deal,
   * the customer effectively re-engaged. The overlap detector treats such
   * deals as ACTIVE (BLOCK), matching the CS Lifecycle Compliance check's
   * phase_churn_desync suppression for re-engaged customers.
   */
  renewal_date?: string | Date | null;
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
 *   - Phase = Termination + Renewal_Date > Churn_Date           → BLOCK (re-engaged)
 *   - Phase = Termination + within sector cool-off              → REVIEW
 *   - Phase = Termination + past sector cool-off                → WARN
 *   - No phase / non-CS-pipeline                                → null
 *
 * Re-engagement rule (matches CS Lifecycle Compliance):
 *   When a Termination-phase deal also carries a Renewal_Date that's later
 *   than its Churn_Date, the customer churned and came back. The Churn_Date
 *   is historical; the customer is effectively active again. Marketing must
 *   not be allowed to push a new lead on that domain.
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
    const lower = phase.toLowerCase();
    const standardActive =
      lower === "onboarding" || lower === "adoption" || lower === "renewal";
    return {
      lifecycle_state: standardActive
        ? (lower as CsLifecycleState)
        : "active_other",
      sector,
      churn_days: null,
      verdict: "block",
      reason: `active_phase:${lower}`,
    };
  }

  // Termination — sector-aware cool-off
  if (phase.toLowerCase() === cfg.phaseTermination.toLowerCase()) {
    const churned = parseChurnDate(input.churn_date);
    const renewed = parseChurnDate(input.renewal_date);

    // Re-engagement: Renewal Date set AFTER Churn Date means the customer
    // came back. The Churn Date is historical, the customer is effectively
    // active. Block any new lead/deal that overlaps on this domain.
    if (churned && renewed && renewed.getTime() > churned.getTime()) {
      return {
        lifecycle_state: "active_other",
        sector,
        churn_days: null,
        verdict: "block",
        reason: "re_engaged_renewal_after_churn",
      };
    }

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
  renewal_date?: string | Date | null;
  cs_owner_name?: string | null;
  health?: string | null;
  // ExtID (Admin) — Zoho custom field surfaced in the CS Lifecycle tab.
  // Optional so legacy callers don't have to destructure it.
  ext_id?: string | null;
  // Customer Success → Company field. Source of truth for the CS
  // Lifecycle Account column (see scanCsLifecycleViolations).
  cs_company?: string | null;
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

  // Normalized lookup: matches any raw_data key whose lower-cased,
  // separator-stripped form equals one of the candidates. Catches Zoho
  // tenants where the API name uses a different casing or separator than
  // the documented defaults (e.g. "CompanyDomain1" matching "company_domain"
  // after normalisation). Skipped when the explicit tryKeys path already
  // found a value.
  const norm = (s: string): string =>
    s.toLowerCase().replace(/[\s_\-./]+/g, "");
  const normalizedKeyIndex: Map<string, unknown> = new Map();
  for (const k of Object.keys(r)) {
    const v = r[k];
    if (v === undefined || v === null || v === "") continue;
    normalizedKeyIndex.set(norm(k), v);
  }
  const tryKeysOrNormalized = (keys: string[]): unknown => {
    const direct = tryKeys(keys);
    if (direct !== null) return direct;
    for (const k of keys) {
      const hit = normalizedKeyIndex.get(norm(k));
      if (hit !== undefined) return hit;
    }
    return null;
  };

  /**
   * Fuzzy fallback (2026-05-30): when the exact + normalised passes
   * above can't find the field, walk every raw_data key and match
   * any whose normalised form CONTAINS one of the substrings. Used
   * for fields whose Zoho API name varies enough across tenants that
   * a fixed candidate list misses them — operator's CS section field
   * "ExtID (Admin)" is one such field; depending on tenant it could
   * be "ExtID", "Ext_ID", "ExtID_Admin", "ExtIDAdmin1", "External_ID_2",
   * or any other variant. Substring containment means any of those
   * lands the same value, while still avoiding accidental matches on
   * obviously-unrelated fields ("Connection_ID" doesn't contain
   * "extid" so it's safely ignored).
   *
   * Returns the FIRST non-empty value in iteration order over keys.
   * Iteration order in modern engines matches insertion order, which
   * for Zoho responses follows the layout order — close enough to
   * "the field the operator means" in practice.
   */
  const tryKeysFuzzyContains = (substrs: string[]): unknown => {
    const needles = substrs.map(norm).filter((s) => s.length > 0);
    if (needles.length === 0) return null;
    for (const [normKey, value] of normalizedKeyIndex) {
      if (needles.some((n) => normKey.includes(n))) return value;
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
  const customerSinceRaw = tryKeysOrNormalized(
    envOr("DUPLICATE_RADAR_FIELD_CUSTOMER_SINCE", [
      "Customer_Since",
      "customer_since",
      "CustomerSince",
      "Customer Since",
    ]),
  );
  const trialEndRaw = tryKeysOrNormalized(
    envOr("DUPLICATE_RADAR_FIELD_TRIAL_END", [
      "Trial_End_Date",
      "trial_end_date",
      "TrialEndDate",
      "Trial End Date",
      "Trial_End",
    ]),
  );
  // CS team's curated authoritative domain — populated at Onboarding handoff.
  // Tolerant of the common Zoho key variations AND case/separator variants
  // (via normalised lookup); pin via env if your field name doesn't normalise
  // to "companydomain" (DUPLICATE_RADAR_FIELD_COMPANY_DOMAIN=<api_name>).
  const companyDomainRaw = tryKeysOrNormalized(
    envOr("DUPLICATE_RADAR_FIELD_COMPANY_DOMAIN", [
      "Company_Domain",
      "company_domain",
      "CompanyDomain",
      "Company Domain",
      "Domain",
      "domain",
    ]),
  );
  // Renewal Date — when set AFTER Churn Date, indicates the customer
  // re-engaged after churning. Such records should not be flagged as
  // phase_churn_desync (a stale Churn Date is expected on re-engaged deals).
  const renewalDateRaw = tryKeysOrNormalized(
    envOr("DUPLICATE_RADAR_FIELD_RENEWAL_DATE", [
      "Renewal_Date",
      "renewal_date",
      "RenewalDate",
      "Renewal Date",
    ]),
  );
  // Churn reason — required alongside Churn_Date when a deal moves to
  // Termination phase. Without it the CS team can't run reason-level
  // analytics ("why are private clients churning at month 6?").
  const churnReasonRaw = tryKeysOrNormalized(
    envOr("DUPLICATE_RADAR_FIELD_CHURN_REASON", [
      "Churn_Reason",
      "churn_reason",
      "ChurnReason",
      "Churn Reason",
      "Reason_For_Churn",
      "Reason for Churn",
    ]),
  );

  // CS Owner display name — surfaced for the lifecycle violations table so CS
  // can see who owns the deal without opening Zoho. Tolerant of the common
  // Zoho key variants; a lookup field may arrive as an object {name}.
  const csOwnerRaw = tryKeysOrNormalized(
    envOr("DUPLICATE_RADAR_FIELD_CS_OWNER", [
      "CS_Owner_Name",
      "cs_owner_name",
      "CSOwnerName",
      "CS Owner Name",
      "CS_Owner1",
      "CS_Owner",
    ]),
  );
  const csOwnerName =
    csOwnerRaw == null
      ? null
      : typeof csOwnerRaw === "object"
        ? ((csOwnerRaw as Record<string, unknown>).name == null
            ? null
            : String((csOwnerRaw as Record<string, unknown>).name))
        : String(csOwnerRaw);
  // CS Health score — display only.
  const healthRaw = tryKeysOrNormalized(
    envOr("DUPLICATE_RADAR_FIELD_HEALTH", [
      "Health",
      "health",
      "CS_Health",
      "Customer_Health",
    ]),
  );

  // Customer Success → Company field (2026-05-30). Operator wants the
  // CS Lifecycle "Account" column sourced from THIS custom field rather
  // than the Deal's standard Account_Name lookup. Without this, the
  // column inherits Account_Name (which is what duplicate_records.
  // account_name is populated from at sync time), and if the CS team
  // renames the company in the CS section without touching the Deal's
  // top-level lookup the dashboard drifts from the CRM's CS view.
  //
  // Lookup is two-step (no fuzzy fallback): exact + normalised against
  // the candidates, then env-var override. Fuzzy CONTAINS pass is
  // deliberately skipped because "company" is too generic a substring
  // — accidentally matching Account_Name.name (when raw_data exposes
  // the lookup as nested keys) or some unrelated "Company_Type" field
  // is the kind of false positive a fuzzy pass would silently
  // introduce. If a tenant's field name doesn't hit the candidate
  // list, DUPLICATE_RADAR_FIELD_CS_COMPANY pins it.
  const csCompanyEnv = process.env.DUPLICATE_RADAR_FIELD_CS_COMPANY;
  const csCompanyRaw = csCompanyEnv && csCompanyEnv.trim()
    ? tryKeysOrNormalized([csCompanyEnv.trim()])
    : tryKeysOrNormalized([
        "Company1",            // Zoho's common auto-suffix when "Company" already exists on the layout
        "Company",
        "CS_Company",
        "Customer_Company",
        "Customer_Success_Company",
        "CS_Company_Name",
      ]);

  // ExtID (Admin) — Zoho custom field operators use as an internal
  // reference key (lives in the same Customer Success section as
  // Health). Three-step lookup so the operator never has to hunt for
  // the API name:
  //   1. tryKeysOrNormalized against the documented candidates.
  //   2. Fuzzy CONTAINS pass against every raw_data key — picks up
  //      any tenant-specific spelling like "ExtIDAdmin1" or
  //      "Ext_ID__Admin" without manual env-var configuration.
  //   3. DUPLICATE_RADAR_FIELD_EXT_ID env var still overrides
  //      everything for the rare case where the fuzzy pass picks
  //      a wrong field with a colliding substring.
  const extIdEnv = process.env.DUPLICATE_RADAR_FIELD_EXT_ID;
  const extIdRaw = extIdEnv && extIdEnv.trim()
    ? tryKeysOrNormalized([extIdEnv.trim()])
    : tryKeysOrNormalized([
        "ExtID",
        "Ext_ID",
        "ExtID_Admin",
        "Ext_ID_Admin",
        "External_ID",
        "External_Id",
      ]) ??
      // Fuzzy fallback: any raw_data key whose normalised form
      // contains "extid". Catches custom-field permutations that
      // a fixed candidate list will always miss eventually.
      tryKeysFuzzyContains(["ExtID", "External_ID"]);

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
    renewal_date:
      renewalDateRaw == null ? null : (renewalDateRaw as string | Date),
    cs_owner_name:
      csOwnerName == null ? null : csOwnerName.trim() || null,
    health: healthRaw == null ? null : String(healthRaw).trim() || null,
    ext_id: extIdRaw == null ? null : String(extIdRaw).trim() || null,
    cs_company:
      csCompanyRaw == null
        ? null
        : typeof csCompanyRaw === "object" && (csCompanyRaw as any)?.name
          ? String((csCompanyRaw as any).name).trim() || null
          : String(csCompanyRaw).trim() || null,
  };
}

// ── Cluster-level overlap classifier ────────────────────────────────────────
//
// Sarah Hijazi (2026-06-11) rewrote the BLOCK rule:
//
//   BLOCK only fires when an OPEN sales Deal AND a CS-HANDOFF Deal coexist
//   in the same cluster. The handoff Deal is the one that says "this
//   customer is now in CS's hands" — Stage ∈ {Paid, Agreement Signed} by
//   default — and the open Deal is anything still in the sales motion
//   (NOT in the closed/handoff stage set). The sector-aware churn cool-off
//   (180 private / 365 government) gates the verdict: while the customer
//   is active or within cool-off, BLOCK; past cool-off, the overlap
//   becomes WARN (sales may re-engage after notifying CS).
//
// This replaces the per-deal phase-only classifier as the cluster's
// authoritative verdict. classifyCsOverlap() is preserved for the CS
// Lifecycle Compliance + Communication Eligibility checks, which still
// reason about individual deals — those checks don't conflate the
// duplicate-radar cluster context.

/** Pulled from raw_data with the same tolerance as extractCsFieldsFromRawData. */
export interface ClusterDealInfo {
  /** Zoho Stage field — drives the open / handoff classification. */
  stage: string | null;
  /** CS section fields — Phase / Churn Date / Renewal Date / Gov Type / Domain. */
  cs: CsOverlapInput;
  /** ARR pulled from raw_data — included in the cluster's arrExposure when verdict fires. */
  arr_value: number | null;
}

interface ClusterOverlapConfig {
  /** Stages that mean "Sales has handed this customer off to CS". */
  handoffStages: string[];
  /** Stages that mean "this Deal is closed in the sales pipeline" (handoff or lost). */
  closedStages: string[];
}

let cachedClusterConfig: ClusterOverlapConfig | null = null;

function loadClusterConfig(): ClusterOverlapConfig {
  if (cachedClusterConfig) return cachedClusterConfig;
  const list = (v: string | undefined, fallback: string[]): string[] =>
    (v ?? "").trim()
      ? (v as string).split(",").map((s) => s.trim()).filter(Boolean)
      : fallback;
  cachedClusterConfig = {
    handoffStages: list(process.env.DUPLICATE_RADAR_CS_HANDOFF_STAGES, [
      "Paid",
      "Agreement Signed",
    ]),
    closedStages: list(process.env.DUPLICATE_RADAR_CS_CLOSED_STAGES, [
      "Paid",
      "Agreement Signed",
      "Closed Won",
      "Closed Lost",
    ]),
  };
  return cachedClusterConfig;
}

/** Reset cluster-config cache. Tests should call this between cases. */
export function resetClusterOverlapConfigCache(): void {
  cachedClusterConfig = null;
}

/** Pull Zoho Stage out of a raw_data blob, tolerant of common variants. */
export function extractDealStage(rawData: unknown): string | null {
  if (!rawData || typeof rawData !== "object") return null;
  const r = rawData as Record<string, unknown>;
  const tryKeys = ["Stage", "stage", "Deal_Stage", "DealStage"];
  for (const k of tryKeys) {
    const v = r[k];
    if (v == null || v === "") continue;
    if (typeof v === "string") return v.trim() || null;
    // Some Zoho responses wrap stage as { value: "Paid" } — be tolerant.
    if (typeof v === "object") {
      const obj = v as Record<string, unknown>;
      const candidate = obj.value ?? obj.name ?? obj.display_label;
      if (typeof candidate === "string") return candidate.trim() || null;
    }
  }
  return null;
}

function stageInSet(stage: string | null, set: string[]): boolean {
  if (!stage) return false;
  const lower = stage.trim().toLowerCase();
  return set.some((s) => s.toLowerCase() === lower);
}

/**
 * Cluster-level CS-pipeline overlap classifier (the new BLOCK rule).
 *
 * Returns the cluster's verdict + the lifecycle_state and sector pulled
 * from the chosen handoff Deal (so the dashboard's CS Phase column keeps
 * showing the customer's current state). On no overlap → null verdict.
 *
 * Verdict ladder:
 *   - Open Sales Deal + Handoff Deal both present:
 *       Phase ∈ {Onboarding, Adoption, Renewal} OR re-engaged       → BLOCK
 *       Phase = Termination + within sector cool-off                → BLOCK
 *       Phase = Termination + past sector cool-off                  → WARN
 *       Phase missing or unknown                                    → BLOCK
 *         (be conservative; CS team has unfinished data)
 *   - No Handoff Deal, or no Open Sales Deal                        → null
 *     (just a duplicate cluster — not an overlap)
 */
export function classifyClusterOverlap(
  deals: ClusterDealInfo[],
  now: Date = new Date(),
): {
  verdict: CsOverlapVerdict;
  lifecycle_state: CsLifecycleState;
  sector: ClientSector;
  arr_exposure: number;
  reason: string;
} {
  const cfg = loadClusterConfig();

  // Partition the deals.
  const handoffDeals: ClusterDealInfo[] = [];
  const openSalesDeals: ClusterDealInfo[] = [];
  for (const d of deals) {
    if (stageInSet(d.stage, cfg.handoffStages)) {
      handoffDeals.push(d);
    } else if (!stageInSet(d.stage, cfg.closedStages)) {
      // Anything not in the closed-stage set is "still in the sales motion".
      openSalesDeals.push(d);
    }
    // Deals in closedStages but not handoffStages (e.g. "Closed Lost")
    // are ignored — they don't represent the customer being in CS hands
    // AND they're not open opportunities either.
  }

  if (handoffDeals.length === 0 || openSalesDeals.length === 0) {
    return {
      verdict: null,
      lifecycle_state: null,
      sector: null,
      arr_exposure: 0,
      reason: handoffDeals.length === 0
        ? "no_handoff_deal"
        : "no_open_sales_deal",
    };
  }

  // Pick the most-actionable handoff deal: prefer the one with the active
  // CS phase, then the freshest churn date, then anything. This drives
  // the cool-off gating + the lifecycle_state we report back.
  let chosenHandoff = handoffDeals[0];
  let chosenClassification = classifyCsOverlap(chosenHandoff.cs, now);
  for (const h of handoffDeals.slice(1)) {
    const cls = classifyCsOverlap(h.cs, now);
    // BLOCK > review > warn > null
    const order: Record<string, number> = { block: 3, review: 2, warn: 1 };
    const better =
      (order[cls.verdict ?? ""] ?? 0) >
      (order[chosenClassification.verdict ?? ""] ?? 0);
    if (better) {
      chosenHandoff = h;
      chosenClassification = cls;
    }
  }

  // ARR exposure — sum across every verdict-bearing deal (handoff and open).
  // The "exposure" is real revenue at risk: the existing CS book PLUS the
  // pipeline value Sales would build on the same customer.
  const arrExposure = deals.reduce((acc, d) => {
    return acc + (d.arr_value && d.arr_value > 0 ? d.arr_value : 0);
  }, 0);

  // Apply the cool-off / re-engagement gating.
  let verdict: CsOverlapVerdict = "block";
  let reason = "overlap_active_handoff";
  if (chosenClassification.verdict === "warn") {
    // Termination + past cool-off → downgrade to WARN even though there's
    // a real open sales deal. The customer churned long ago; Sales may
    // proceed after notifying CS.
    verdict = "warn";
    reason = `overlap_past_cooloff:${chosenClassification.reason}`;
  } else if (chosenClassification.verdict === "review") {
    // Termination + within cool-off → BLOCK. The customer is recently
    // churned; CS may still be in recovery talks. Sales must not push.
    verdict = "block";
    reason = `overlap_within_cooloff:${chosenClassification.reason}`;
  } else if (chosenClassification.verdict === "block") {
    verdict = "block";
    reason = `overlap_active_cs_phase:${chosenClassification.reason}`;
  } else {
    // Handoff deal has no readable CS phase. Be conservative: BLOCK.
    verdict = "block";
    reason = "overlap_unknown_cs_phase";
  }

  return {
    verdict,
    lifecycle_state: chosenClassification.lifecycle_state,
    sector: chosenClassification.sector,
    arr_exposure: arrExposure,
    reason,
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
