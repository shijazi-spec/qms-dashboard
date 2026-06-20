/**
 * Rejection-pattern analysis (Sarah 2026-06-20).
 *
 * Reads the duplicate-resolution proposals an operator DELIBERATELY rejected
 * (per-card Reject — NOT bulk clears) and surfaces the common reasons, so we can
 * see WHAT to stop proposing and recommend a learning rule / threshold change.
 * Recommend-only: it never creates a rule itself (segregation of duties).
 *
 * Signal sources per rejected proposal:
 *   - payload.features  → the boolean case features the resolver computed
 *                         (mixedDomains, mixedPhones, layoutSplit, multiOwner,
 *                         crossModule, hasPipeline) — these map 1:1 to a learning
 *                         rule signature, so they can be a one-click suggestion.
 *   - payload.reasons   → the human-readable escalation reasons, for categories
 *                         that aren't a feature (low confidence, active deal
 *                         stage, attachments, …) — surfaced as advice.
 */

import { aiApprovalPool as pool } from "./aiApprovalDatabase";
import { logger } from "./logger";

export interface RejectionPattern {
  key: string;
  label: string;
  count: number;
  sharePct: number;
  /** A one-click learning-rule suggestion (only for feature-backed categories). */
  suggestedRule: { decision: "never_merge"; signature: Record<string, unknown> } | null;
  /** A config/threshold recommendation when a rule signature doesn't fit. */
  advice: string;
}

interface CategorySpec {
  key: string;
  label: string;
  feature?: string; // payload.features[feature] === true
  reason?: RegExp; // matches against the joined payload.reasons
  suggestedRule?: { decision: "never_merge"; signature: Record<string, unknown> };
  advice: string;
}

const CATEGORIES: CategorySpec[] = [
  {
    key: "low_confidence",
    label: "Confidence below the auto threshold",
    reason: /below the auto threshold/i,
    advice:
      "These clusters scored below the confidence floor. If you're rejecting most of them, raise RESOLUTION_MIN_CONFIDENCE (or have the cluster engine re-segment) rather than reviewing them one by one.",
  },
  {
    key: "multiple_phones",
    label: "Multiple distinct phone numbers",
    feature: "mixedPhones",
    suggestedRule: { decision: "never_merge", signature: { mixedPhones: true } },
    advice: "Clusters spanning ≥2 phone numbers are likely different entities.",
  },
  {
    key: "multiple_domains",
    label: "Multiple distinct corporate domains",
    feature: "mixedDomains",
    suggestedRule: { decision: "never_merge", signature: { mixedDomains: true } },
    advice: "Clusters spanning ≥2 corporate domains are likely different companies.",
  },
  {
    key: "layout_split",
    label: "Different Zoho layouts (intentional split)",
    feature: "layoutSplit",
    suggestedRule: { decision: "never_merge", signature: { layoutSplit: true } },
    advice: "Records on different layouts are often a deliberate split (e.g. Corporate vs Partner).",
  },
  {
    key: "multi_owner",
    label: "Multiple owners",
    feature: "multiOwner",
    suggestedRule: { decision: "never_merge", signature: { multiOwner: true } },
    advice: "Clusters with ≥2 owners need coordination before a merge.",
  },
  {
    key: "cross_module",
    label: "Cross-module cluster",
    feature: "crossModule",
    suggestedRule: { decision: "never_merge", signature: { crossModule: true } },
    advice: "Cross-module clusters are handled by LINK rules, not a same-module merge.",
  },
  {
    key: "has_pipeline",
    label: "Carries deal pipeline / ARR value",
    feature: "hasPipeline",
    suggestedRule: { decision: "never_merge", signature: { hasPipeline: true } },
    advice:
      "Duplicates carrying deal value escalate by design. Raise RESOLUTION_MAX_PIPELINE_VALUE / _ARR_EXPOSURE if you want the agent to auto-merge small-value ones.",
  },
  {
    key: "active_deal_stage",
    label: "A duplicate is in an active deal stage",
    reason: /active deal stage/i,
    advice: "Active deals are kept out of auto-merge — review individually.",
  },
  {
    key: "field_conflicts",
    label: "Field conflicts needing a human decision",
    reason: /field conflict/i,
    advice: "Conflicting values on the same field — the survivor/value choice needs you.",
  },
  {
    key: "attachments",
    label: "Duplicate carries Zoho attachments (evidence)",
    reason: /attachment/i,
    advice: "Never auto-merge away a record with files (signed contracts/NDAs) — keep it as survivor.",
  },
  {
    key: "survivor_incomplete",
    label: "Survivor record is sparse",
    reason: /complete/i,
    advice: "The chosen survivor is under-filled — pick a more complete master.",
  },
  {
    key: "recently_modified",
    label: "A record was edited very recently",
    reason: /modified .* ago/i,
    advice: "A record edited in the last few days may be an in-flight change — wait before merging.",
  },
];

/**
 * Analyse deliberately-rejected duplicate-resolution proposals in the window.
 * Returns the patterns sorted by frequency + per-module rejection counts.
 */
export async function analyzeRejectionPatterns(windowDays = 30): Promise<{
  windowDays: number;
  totalRejected: number;
  byModule: Record<string, number>;
  patterns: RejectionPattern[];
}> {
  const days = Math.max(1, Math.min(Math.floor(windowDays) || 30, 365));
  const out = {
    windowDays: days,
    totalRejected: 0,
    byModule: {} as Record<string, number>,
    patterns: [] as RejectionPattern[],
  };
  try {
    const res = await pool.query(
      `SELECT payload
         FROM ai_pending_actions
        WHERE tool_id = 'duplicate-resolution'
          AND status = 'rejected'
          AND reviewed_at > NOW() - ($1 || ' days')::interval
          -- exclude bulk "Clear" resets — those aren't per-cluster judgments
          AND COALESCE(rejection_reason, '') NOT ILIKE '%cleared in bulk%'`,
      [String(days)],
    );
    out.totalRejected = res.rows.length;
    const counts: Record<string, number> = {};
    for (const row of res.rows) {
      const payload = row.payload || {};
      const feats = (payload.features || {}) as Record<string, unknown>;
      const reasons = Array.isArray(payload.reasons) ? payload.reasons.join(" | ") : "";
      const module = String(payload.module || "Unknown");
      out.byModule[module] = (out.byModule[module] || 0) + 1;
      for (const cat of CATEGORIES) {
        const hit = cat.feature
          ? feats[cat.feature] === true
          : cat.reason
            ? cat.reason.test(reasons)
            : false;
        if (hit) counts[cat.key] = (counts[cat.key] || 0) + 1;
      }
    }
    const total = out.totalRejected || 1;
    out.patterns = CATEGORIES.map((cat) => ({
      key: cat.key,
      label: cat.label,
      count: counts[cat.key] || 0,
      sharePct: Math.round(((counts[cat.key] || 0) / total) * 100),
      suggestedRule: cat.suggestedRule || null,
      advice: cat.advice,
    }))
      .filter((p) => p.count > 0)
      .sort((a, b) => b.count - a.count);
  } catch (e) {
    logger.warn("[rejectionPatterns] analyze failed (non-fatal)", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return out;
}
