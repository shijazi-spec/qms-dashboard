/**
 * Remediation Playbook — stakeholder-facing enrichment of duplicate-radar
 * exports.
 *
 * Background: every CRM-deduplication best-practice playbook (Plauti,
 * DemandTools, Insycle, HubSpot) makes the same point — a duplicate report
 * that just lists records is a data dump, not an action plan. Owners need
 * to see WHAT to do, WHY, and BY WHEN to actually close out the cleanup.
 *
 * This module produces the five columns we add to every CSV / XLSX export:
 *   - Recommended action   (Keep / Merge into "<primary>" / Review manually)
 *   - Survivorship rule    (e.g. "High-confidence cluster; auto-merge eligible")
 *   - Owner to consult     (owner_name + email)
 *   - Why this verdict     (humanised cluster signal + ai_recommendation)
 *   - Due date             (SLA derived from severity — high=7d / med=14d / low=30d)
 *
 * Pure functions only — no DB access, no env-driven config (today). Severity
 * thresholds match the existing confidence-tier convention used elsewhere
 * in the radar (90+/60-89/<60), so a single source of truth for "high /
 * medium / low" stays in `getConfidenceTier`.
 */

export type ConfidenceTier = "high" | "medium" | "low";

/** Match the dashboard's `getConfidenceLevel` thresholds. */
export function getConfidenceTier(score: number | null | undefined): ConfidenceTier {
  const n = Number(score ?? 0);
  if (n >= 90) return "high";
  if (n >= 60) return "medium";
  return "low";
}

/**
 * Recommended action for a single record. The caller is responsible for
 * threading the cluster's primary record name through — once per cluster.
 */
export function recommendedAction(input: {
  is_primary: boolean | null | undefined;
  primary_name: string | null | undefined;
}): string {
  if (input.is_primary) return "Keep — primary record";
  const p = (input.primary_name ?? "").trim();
  if (p) return `Merge into "${p}"`;
  // No primary marked yet — operator decides which record survives.
  return "Review manually — no primary selected yet";
}

/**
 * Survivorship-rule descriptor for the cluster. We don't compute this
 * per-pair (that requires buffering the whole cluster); we summarise the
 * cluster-level signal so a stakeholder reading the report knows how much
 * trust to put in the primary selection before merging in CRMProvider.
 */
export function survivorshipRule(input: {
  cluster_confidence: number | null | undefined;
  has_primary: boolean;
}): string {
  if (!input.has_primary) {
    return "No primary record selected — operator must mark one before merging in CRMProvider";
  }
  const tier = getConfidenceTier(input.cluster_confidence);
  if (tier === "high") {
    return "High-confidence cluster (≥90%); primary auto-selected by signal score — verify in CRMProvider then merge";
  }
  if (tier === "medium") {
    return "Medium-confidence cluster (60-89%); review primary's field completeness before merging";
  }
  return "Low-confidence cluster (<60%); do not auto-merge — escalate to CS / record owner for manual triage";
}

/**
 * Combined "owner to consult" string. Prefers owner_name + " <email>" when
 * both are present; falls back to whichever is set; "—" if neither.
 */
export function ownerToConsult(input: {
  owner_name?: string | null;
  owner_email?: string | null;
}): string {
  const name = (input.owner_name ?? "").trim();
  const email = (input.owner_email ?? "").trim();
  if (name && email) return `${name} <${email}>`;
  if (name) return name;
  if (email) return email;
  return "—";
}

/**
 * Plain-English explanation of why this cluster was surfaced. Combines the
 * cluster's signal tier with any per-record AI recommendation the radar
 * already produces. Operators see ONE column with a complete answer rather
 * than having to cross-reference Confidence + Recommendation cells.
 */
export function whyVerdict(input: {
  cluster_confidence: number | null | undefined;
  ai_recommendation?: string | null;
  total_records?: number | null;
}): string {
  const tier = getConfidenceTier(input.cluster_confidence);
  const count = Number(input.total_records ?? 0);
  const recs = (input.ai_recommendation ?? "").trim();
  const sizePart =
    count > 1
      ? `${count} records grouped by company-name / domain / email signal match`
      : "Single record cluster (signal candidate)";
  const tierLabel =
    tier === "high"
      ? "High-confidence match"
      : tier === "medium"
        ? "Medium-confidence match"
        : "Low-confidence match";
  if (recs && recs !== "Review manually") {
    return `${tierLabel}: ${sizePart}. ${recs}`;
  }
  return `${tierLabel}: ${sizePart}`;
}

/**
 * Suggested fix-by date computed at export time. Severity drives the SLA:
 *   high   → 7 days   (revenue-at-risk; act fast)
 *   medium → 14 days  (standard hygiene cadence)
 *   low    → 30 days  (de-prioritised triage)
 *
 * `now` is injected for deterministic testing. Returns a YYYY-MM-DD string.
 */
export function dueDate(input: {
  cluster_confidence: number | null | undefined;
  now?: Date;
}): string {
  const tier = getConfidenceTier(input.cluster_confidence);
  const days = tier === "high" ? 7 : tier === "medium" ? 14 : 30;
  const base = input.now ?? new Date();
  const d = new Date(base.getTime() + days * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}

/** Header tuple for the five new columns — keeps CSV + XLSX in lock-step. */
export const PLAYBOOK_HEADERS = [
  "Recommended Action",
  "Survivorship Rule",
  "Owner to Consult",
  "Why This Verdict",
  "Due Date",
] as const;

/** Mirror for XLSX column key/header definitions. */
export const PLAYBOOK_XLSX_COLUMNS = [
  { header: "Recommended Action", key: "recommended_action", width: 40 },
  { header: "Survivorship Rule", key: "survivorship_rule", width: 50 },
  { header: "Owner to Consult", key: "owner_to_consult", width: 30 },
  { header: "Why This Verdict", key: "why_verdict", width: 60 },
  { header: "Due Date", key: "due_date", width: 14 },
] as const;

/**
 * Cluster-scoped state the row generator keeps across records of the same
 * cluster (since the SELECT is ORDER BY cluster_id, is_primary DESC, the
 * first row of a cluster carries primary info we re-use on subsequent rows).
 */
export interface ClusterPlaybookState {
  cluster_id: number | null;
  primary_name: string | null;
  has_primary: boolean;
  cluster_confidence: number | null;
  total_records: number | null;
  due_date: string;
  survivorship: string;
}

export function emptyPlaybookState(): ClusterPlaybookState {
  return {
    cluster_id: null,
    primary_name: null,
    has_primary: false,
    cluster_confidence: null,
    total_records: null,
    due_date: "",
    survivorship: "",
  };
}

/**
 * Update cluster-scoped state when the row generator transitions to a new
 * cluster_id. Call this exactly once per cluster — when the first row of
 * that cluster is encountered (which, given ORDER BY ... is_primary DESC,
 * IS the primary record if any primary is set).
 */
export function startCluster(
  state: ClusterPlaybookState,
  firstRowOfCluster: Record<string, unknown>,
  now?: Date,
): void {
  const isPrimary = Boolean(firstRowOfCluster["is_primary"]);
  state.cluster_id = Number(firstRowOfCluster["cluster_id"] ?? null) || null;
  state.primary_name = isPrimary
    ? String(firstRowOfCluster["record_name"] ?? "").trim() || null
    : null;
  state.has_primary = isPrimary;
  state.cluster_confidence =
    firstRowOfCluster["cluster_confidence_score"] == null
      ? null
      : Number(firstRowOfCluster["cluster_confidence_score"]);
  state.total_records =
    firstRowOfCluster["cluster_total_records"] == null
      ? null
      : Number(firstRowOfCluster["cluster_total_records"]);
  state.due_date = dueDate({
    cluster_confidence: state.cluster_confidence,
    now,
  });
  state.survivorship = survivorshipRule({
    cluster_confidence: state.cluster_confidence,
    has_primary: state.has_primary,
  });
}

/**
 * Build the five playbook values for a single record row, given the
 * already-initialised cluster state.
 */
export function rowPlaybook(
  row: Record<string, unknown>,
  state: ClusterPlaybookState,
): {
  recommended_action: string;
  survivorship_rule: string;
  owner_to_consult: string;
  why_verdict: string;
  due_date: string;
} {
  return {
    recommended_action: recommendedAction({
      is_primary: Boolean(row["is_primary"]),
      primary_name: state.primary_name,
    }),
    survivorship_rule: state.survivorship,
    owner_to_consult: ownerToConsult({
      owner_name: row["owner_name"] as string | null | undefined,
      owner_email: row["owner_email"] as string | null | undefined,
    }),
    why_verdict: whyVerdict({
      cluster_confidence: state.cluster_confidence,
      ai_recommendation: row["ai_recommendation"] as string | null | undefined,
      total_records: state.total_records,
    }),
    due_date: state.due_date,
  };
}
