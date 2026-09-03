/**
 * Rejection-pattern analysis (Sample User 2026-06-20).
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
    label: "Different CRMProvider layouts (intentional split)",
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
    label: "Duplicate carries CRMProvider attachments (evidence)",
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

// ── Acceptance patterns — learn AUTO-APPROVE rules from resolved data ──────────
//
// Mirror of the rejection analysis, over decisions you ACCEPTED. Source (Sample User
// 2026-06-20): your manual merges + agent applies. Feature-backed suggestions
// require the case features, which are reliably stored on duplicate-resolution
// proposals you APPROVED from the queue (ai_pending_actions status='executed').
// Pure dashboard manual merges + assisted agent applies have no stored feature
// signature, so they count toward the accepted VOLUME (context) but can't, on
// their own, become a feature rule. When you repeatedly approve clusters that
// carry a flag (e.g. layoutSplit), that flag becomes an auto-approve suggestion.

interface AcceptCategorySpec {
  key: string;
  feature: string;
  label: string;
  advice: string;
}

const ACCEPT_CATEGORIES: AcceptCategorySpec[] = [
  { key: "ok_layout_split", feature: "layoutSplit", label: "Approved despite different layouts", advice: "You keep merging layout-split clusters — safe to auto-approve that shape." },
  { key: "ok_multi_owner", feature: "multiOwner", label: "Approved despite multiple owners", advice: "You keep merging multi-owner clusters — safe to auto-approve that shape." },
  { key: "ok_has_pipeline", feature: "hasPipeline", label: "Approved despite deal value", advice: "You keep merging clusters carrying pipeline — consider auto-approving (or raise the value cap)." },
  { key: "ok_mixed_phones", feature: "mixedPhones", label: "Approved despite multiple phones", advice: "You keep merging multi-phone clusters — auto-approve that shape if it's reliably the same company." },
];

export async function analyzeAcceptancePatterns(opts?: {
  module?: string;
  windowDays?: number;
}): Promise<{
  windowDays: number;
  module: string | null;
  totalAccepted: number;
  featureBacked: number;
  patterns: Array<{
    key: string;
    label: string;
    count: number;
    sharePct: number;
    suggestedRule: { decision: "auto_approve"; signature: Record<string, unknown> } | null;
    advice: string;
  }>;
  note: string;
}> {
  const days = Math.max(1, Math.min(Math.floor(opts?.windowDays ?? 90) || 90, 365));
  const moduleFilter = opts?.module || null;
  const out = {
    windowDays: days,
    module: moduleFilter,
    totalAccepted: 0,
    featureBacked: 0,
    patterns: [] as any[],
    note: "",
  };
  try {
    // (a) Feature-bearing approvals: proposals you executed from the queue.
    const execParams: any[] = [String(days)];
    let modClause = "";
    if (moduleFilter) {
      execParams.push(moduleFilter);
      modClause = ` AND payload->>'module' = $${execParams.length}`;
    }
    const execRes = await pool.query(
      `SELECT payload
         FROM ai_pending_actions
        WHERE tool_id = 'duplicate-resolution'
          AND status = 'executed'
          AND executed_at > NOW() - ($1 || ' days')::interval${modClause}`,
      execParams,
    );
    out.featureBacked = execRes.rows.length;
    const counts: Record<string, number> = {};
    for (const row of execRes.rows) {
      const feats = (row.payload?.features || {}) as Record<string, unknown>;
      for (const cat of ACCEPT_CATEGORIES) {
        if (feats[cat.feature] === true) counts[cat.key] = (counts[cat.key] || 0) + 1;
      }
    }

    // (b) Accepted VOLUME context = manual merges + agent applies (not undone).
    let manualCount = 0;
    let agentCount = 0;
    try {
      const recType = moduleFilter
        ? { Leads: "lead", Deals: "deal", Contacts: "contact", Accounts: "account" }[moduleFilter]
        : null;
      const mParams: any[] = [String(days)];
      let mClause = "";
      if (recType) {
        mParams.push(recType);
        mClause = ` AND pr.record_type = $${mParams.length}`;
      }
      const m = await pool.query(
        `SELECT COUNT(*)::int AS n
           FROM duplicate_merge_actions ma
           LEFT JOIN duplicate_records pr ON pr.id = ma.primary_record_id
          WHERE ma.action_type IN ('resolve','module_resolved')
            AND ma.created_at > NOW() - ($1 || ' days')::interval${mClause}`,
        mParams,
      );
      manualCount = Number(m.rows[0]?.n || 0);
    } catch { /* table shape varies; volume is best-effort */ }
    try {
      const aParams: any[] = [String(days)];
      let aClause = "";
      if (moduleFilter) {
        aParams.push(moduleFilter);
        aClause = ` AND plan_json->>'module' = $${aParams.length}`;
      }
      const a = await pool.query(
        `SELECT COUNT(*)::int AS n
           FROM duplicate_resolution_feedback f
          WHERE event_type = 'applied'
            AND COALESCE(performed_by,'') NOT ILIKE 'UNDO%'
            AND created_at > NOW() - ($1 || ' days')::interval${aClause}`,
        aParams,
      );
      agentCount = Number(a.rows[0]?.n || 0);
    } catch { /* best-effort */ }

    out.totalAccepted = manualCount + agentCount;
    const denom = out.featureBacked || 1;
    out.patterns = ACCEPT_CATEGORIES.map((cat) => ({
      key: cat.key,
      label: cat.label,
      count: counts[cat.key] || 0,
      sharePct: Math.round(((counts[cat.key] || 0) / denom) * 100),
      suggestedRule:
        (counts[cat.key] || 0) > 0
          ? { decision: "auto_approve" as const, signature: { [cat.feature]: true } }
          : null,
      advice: cat.advice,
    }))
      .filter((p) => p.count > 0)
      .sort((a, b) => b.count - a.count);

    out.note =
      `${out.totalAccepted} accepted in the last ${days}d (${manualCount} manual · ${agentCount} agent). ` +
      (out.featureBacked
        ? `${out.featureBacked} were approved from the queue with a known signature.`
        : `None were approved from the queue yet, so no feature-based auto-approve rule can be suggested — approve a few proposals (or run in assisted) to seed these.`);
  } catch (e) {
    logger.warn("[acceptancePatterns] analyze failed (non-fatal)", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return out;
}
