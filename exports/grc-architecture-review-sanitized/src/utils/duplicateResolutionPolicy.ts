/**
 * Autonomous Duplicate Resolution — RISK POLICY (the "1% doubt" gate).
 *
 * Pure, deterministic, dependency-free. Given a compact set of signals about a
 * proposed merge, it decides AUTO (safe to apply unattended) vs ESCALATE (queue
 * for Sample User) and returns the reasons. The autonomous workflow assembles the
 * input from the MergePlan + cluster + mixed-signal + records; this module just
 * applies the gates so it is trivially unit-testable.
 *
 * Philosophy (locked with Sample User): conservative — ANY meaningful doubt escalates.
 * Every escalation carries human-readable reasons so the approval card explains
 * itself. Thresholds live in one config object (env-overridable).
 */

export type ResolutionVerdict = "auto" | "escalate";

export interface ResolutionRiskInput {
  module: "Accounts" | "Leads" | "Deals" | "Contacts";
  /** 0..100 cluster confidence. */
  confidenceScore: number;
  /** distinct corporate domains / distinct phones in the cluster (mixed-signal). */
  mixedDomains: number;
  mixedPhones: number;
  /** 'block' | 'review' | 'warn' | null — CS pipeline overlap verdict. */
  csOverlapVerdict: string | null;
  /** SAR pipeline value on the duplicates + ARR exposure. */
  pipelineValue: number;
  arrExposure: number;
  /** a prior merge on this cluster's domain failed CRMProvider verification. */
  verificationFailed: boolean;
  /** plan.fieldDecisions where action === 'conflict'. */
  conflictCount: number;
  /** plan touches custom fields whose API names are assumptions. */
  hasCustomFieldAssumption: boolean;
  /** master or any included duplicate lacks a CRMProvider_record_id. */
  anyMissingCRMProviderId: boolean;
  /** 0..1 completeness of the chosen survivor. */
  masterCompleteness: number;
  /** distinct owners across the merge set. */
  distinctOwners: number;
  /** distinct CRMProvider layouts across the merge set (split = intentional). */
  distinctLayouts: number;
  /** smallest "days since modified" across the merge set (Infinity if unknown). */
  minDaysSinceModified: number;
  /** any duplicate sits in an active deal stage (Open/In-Progress/Closed-Won...). */
  anyActiveDealStage: boolean;
  /** cluster spans more than this module's record type. */
  isCrossModule: boolean;
  /**
   * Count of duplicate records (the ones that would be tagged Duplicate-Delete)
   * that carry ≥1 CRMProvider attachment. ANY > 0 forces escalate — auto-merging a
   * record with files risks losing audit evidence (signed contracts, NDAs…).
   * The runner only populates this for clusters it would otherwise auto-apply
   * (bounded CRMProvider calls); defaults 0 elsewhere.
   */
  duplicatesWithAttachments: number;
}

export interface ResolutionRiskVerdict {
  verdict: ResolutionVerdict;
  /** Empty when verdict === 'auto'. */
  reasons: string[];
}

export interface ResolutionPolicyConfig {
  minConfidence: number;
  maxPipelineValue: number;
  maxArrExposure: number;
  maxConflicts: number;
  minMasterCompleteness: number;
  maxOwners: number;
  recentModifiedDays: number;
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Default gates — conservative. Override via env without code changes. */
export function getResolutionPolicyConfig(): ResolutionPolicyConfig {
  return {
    minConfidence: envNum("RESOLUTION_MIN_CONFIDENCE", 85),
    // Default 0 → ANY pipeline value on a duplicate escalates (safest start).
    maxPipelineValue: envNum("RESOLUTION_MAX_PIPELINE_VALUE", 0),
    maxArrExposure: envNum("RESOLUTION_MAX_ARR_EXPOSURE", 0),
    maxConflicts: envNum("RESOLUTION_MAX_CONFLICTS", 0),
    minMasterCompleteness: envNum("RESOLUTION_MIN_MASTER_COMPLETENESS", 0.5),
    maxOwners: envNum("RESOLUTION_MAX_OWNERS", 1),
    recentModifiedDays: envNum("RESOLUTION_RECENT_MODIFIED_DAYS", 7),
  };
}

/**
 * Decide AUTO vs ESCALATE for one proposed module merge. Returns escalation
 * reasons (empty array when AUTO). Learned rules are applied OUTSIDE this
 * function (in the rules layer) and may override the verdict either way.
 */
export function evaluateResolutionRisk(
  input: ResolutionRiskInput,
  cfg: ResolutionPolicyConfig = getResolutionPolicyConfig(),
): ResolutionRiskVerdict {
  const reasons: string[] = [];

  if (input.confidenceScore < cfg.minConfidence) {
    reasons.push(
      `Confidence ${input.confidenceScore} is below the auto threshold (${cfg.minConfidence}).`,
    );
  }
  if (input.mixedDomains >= 2) {
    reasons.push(
      `${input.mixedDomains} distinct corporate domains — likely different companies, not true duplicates.`,
    );
  }
  if (input.mixedPhones >= 2) {
    reasons.push(`${input.mixedPhones} distinct phone numbers in the cluster.`);
  }
  if (input.csOverlapVerdict === "block" || input.csOverlapVerdict === "review") {
    reasons.push(
      `Active/churn-cooloff customer (CS overlap = "${input.csOverlapVerdict}").`,
    );
  }
  if (input.pipelineValue > cfg.maxPipelineValue) {
    reasons.push(
      `Pipeline value ${input.pipelineValue} exceeds the auto cap (${cfg.maxPipelineValue}).`,
    );
  }
  if (input.arrExposure > cfg.maxArrExposure) {
    reasons.push(
      `ARR exposure ${input.arrExposure} exceeds the auto cap (${cfg.maxArrExposure}).`,
    );
  }
  if (input.anyActiveDealStage) {
    reasons.push("A duplicate is in an active deal stage.");
  }
  if (input.conflictCount > cfg.maxConflicts) {
    reasons.push(
      `${input.conflictCount} field conflict(s) need a human decision.`,
    );
  }
  if (input.anyMissingCRMProviderId) {
    reasons.push(
      "A record (master or duplicate) has no CRMProvider id — cannot be safely written/tagged.",
    );
  }
  if (input.isCrossModule) {
    reasons.push(
      "Cross-module cluster — only one module is resolved here; the rest stays open.",
    );
  }
  if (input.distinctLayouts >= 2) {
    reasons.push(
      `${input.distinctLayouts} distinct layouts — possibly an intentional split (e.g. Corporate vs Partner).`,
    );
  }
  if (input.distinctOwners > cfg.maxOwners) {
    reasons.push(
      `${input.distinctOwners} distinct owners — coordination needed.`,
    );
  }
  if (input.minDaysSinceModified < cfg.recentModifiedDays) {
    reasons.push(
      `A record was modified ${Math.floor(input.minDaysSinceModified)}d ago (< ${cfg.recentModifiedDays}d) — possible in-flight edit.`,
    );
  }
  if (input.verificationFailed) {
    reasons.push(
      "A previous merge on this cluster's domain failed CRMProvider verification.",
    );
  }
  if (input.hasCustomFieldAssumption) {
    reasons.push(
      "Plan touches custom fields whose CRMProvider API names are unconfirmed.",
    );
  }
  if (input.masterCompleteness < cfg.minMasterCompleteness) {
    reasons.push(
      `Survivor is only ${Math.round(input.masterCompleteness * 100)}% complete (< ${Math.round(cfg.minMasterCompleteness * 100)}%).`,
    );
  }
  if (input.duplicatesWithAttachments > 0) {
    reasons.push(
      `${input.duplicatesWithAttachments} duplicate(s) carry CRMProvider attachments — escalating to protect audit evidence (ISO 9001 §7.5).`,
    );
  }

  return { verdict: reasons.length === 0 ? "auto" : "escalate", reasons };
}
