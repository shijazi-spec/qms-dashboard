/**
 * Autonomous Duplicate Resolution — LEARNING RULES.
 *
 * When Sample User queued item (or teaches the agent in chat), her decision
 * is stored as a durable rule keyed by a normalized "case signature". On future
 * runs the agent matches rules BEFORE the risk gate and may flip the verdict —
 * so it never re-asks the same kind of question. This is the "update your
 * memory, don't ask again" mechanism.
 *
 * DB writes are best-effort (never block a resolution). The matching logic is
 * pure + exported for unit tests.
 */

import { pool } from "./duplicateRadarDatabase";
import { logger } from "./logger";

export type RuleDecision =
  | "auto_approve" // pattern matched → treat as AUTO even if the gate said escalate
  | "never_merge" // pattern matched → always ESCALATE / never auto-apply
  | "always_link"; // behavioural hint: link survivor to the cluster account

export type RuleScope = "pattern" | "cluster";

export interface ResolutionRule {
  id: number;
  module: string;
  caseSignature: Record<string, unknown>;
  decision: RuleDecision;
  scope: RuleScope;
  clusterId: number | null;
  createdBy: string | null;
  enabled: boolean;
  usageCount: number;
  createdAt: string | null;
  lastUsedAt: string | null;
}

// ── Pure matching helpers (unit-tested) ──────────────────────────────────────

/** A rule signature matches a case when every key in the signature equals the
 *  corresponding feature on the case (subset match). Empty signature never
 *  matches (avoids an accidental match-all rule). */
export function signatureMatches(
  signature: Record<string, unknown>,
  features: Record<string, unknown>,
): boolean {
  const keys = Object.keys(signature || {});
  if (keys.length === 0) return false;
  return keys.every((k) => features[k] === signature[k]);
}

/** Of the matching rules, pick the strongest decision. never_merge wins over
 *  auto_approve (safety first); always_link is additive (returned separately). */
export function pickRuleOutcome(
  rules: Array<Pick<ResolutionRule, "decision">>,
): { override: "auto" | "escalate" | null; alwaysLink: boolean } {
  let override: "auto" | "escalate" | null = null;
  let alwaysLink = false;
  for (const r of rules) {
    if (r.decision === "never_merge") override = "escalate"; // hard, wins
    else if (r.decision === "auto_approve" && override !== "escalate")
      override = "auto";
    else if (r.decision === "always_link") alwaysLink = true;
  }
  return { override, alwaysLink };
}

// ── DB layer (best-effort) ────────────────────────────────────────────────────

let _ready = false;
export async function ensureResolutionRulesTable(): Promise<void> {
  if (_ready) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS duplicate_resolution_rules (
      id SERIAL PRIMARY KEY,
      module VARCHAR(32) NOT NULL,
      case_signature JSONB NOT NULL,
      decision VARCHAR(32) NOT NULL,
      scope VARCHAR(16) NOT NULL DEFAULT 'pattern',
      cluster_id INTEGER,
      created_by VARCHAR(255),
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      usage_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      last_used_at TIMESTAMP
    );
  `);
  await pool
    .query(
      `CREATE INDEX IF NOT EXISTS idx_dup_res_rules_module ON duplicate_resolution_rules(module) WHERE enabled = TRUE;`,
    )
    .catch(() => {});
  _ready = true;
}

function rowToRule(row: any): ResolutionRule {
  return {
    id: row.id,
    module: row.module,
    caseSignature:
      typeof row.case_signature === "string"
        ? JSON.parse(row.case_signature)
        : row.case_signature || {},
    decision: row.decision,
    scope: row.scope,
    clusterId: row.cluster_id,
    createdBy: row.created_by,
    enabled: !!row.enabled,
    usageCount: row.usage_count ?? 0,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
  };
}

export interface NewRule {
  module: string;
  caseSignature: Record<string, unknown>;
  decision: RuleDecision;
  scope?: RuleScope;
  clusterId?: number | null;
  createdBy?: string;
}

export async function recordResolutionRule(rule: NewRule): Promise<number | null> {
  try {
    await ensureResolutionRulesTable();
    const r = await pool.query<{ id: number }>(
      `INSERT INTO duplicate_resolution_rules
         (module, case_signature, decision, scope, cluster_id, created_by)
       VALUES ($1,$2::jsonb,$3,$4,$5,$6) RETURNING id`,
      [
        rule.module,
        JSON.stringify(rule.caseSignature || {}),
        rule.decision,
        rule.scope || "pattern",
        rule.clusterId ?? null,
        rule.createdBy ?? null,
      ],
    );
    return r.rows[0]?.id ?? null;
  } catch (e) {
    logger.warn("[dup-resolution-rules] recordResolutionRule failed (non-fatal)", {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

export async function listResolutionRules(
  includeDisabled = false,
): Promise<ResolutionRule[]> {
  try {
    await ensureResolutionRulesTable();
    const r = await pool.query(
      `SELECT * FROM duplicate_resolution_rules
        ${includeDisabled ? "" : "WHERE enabled = TRUE"}
        ORDER BY created_at DESC LIMIT 500`,
    );
    return r.rows.map(rowToRule);
  } catch {
    return [];
  }
}

export async function setResolutionRuleEnabled(
  id: number,
  enabled: boolean,
): Promise<boolean> {
  try {
    await ensureResolutionRulesTable();
    await pool.query(
      `UPDATE duplicate_resolution_rules SET enabled = $2 WHERE id = $1`,
      [id, enabled],
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Find rules that apply to a case and return the net outcome. Considers
 * pattern rules (subset match on features) + cluster-scoped rules (exact
 * cluster id). Bumps usage_count on the fired rules (best-effort).
 */
export async function evaluateRules(
  module: string,
  features: Record<string, unknown>,
  clusterId?: number,
): Promise<{ override: "auto" | "escalate" | null; alwaysLink: boolean; ruleIds: number[] }> {
  try {
    await ensureResolutionRulesTable();
    const r = await pool.query(
      `SELECT * FROM duplicate_resolution_rules WHERE enabled = TRUE AND module = $1`,
      [module],
    );
    const rules = r.rows.map(rowToRule);
    const fired = rules.filter((rule) =>
      rule.scope === "cluster"
        ? clusterId != null && rule.clusterId === clusterId
        : signatureMatches(rule.caseSignature, features),
    );
    const outcome = pickRuleOutcome(fired);
    const ruleIds = fired.map((f) => f.id);
    if (ruleIds.length) {
      pool
        .query(
          `UPDATE duplicate_resolution_rules
             SET usage_count = usage_count + 1, last_used_at = NOW()
           WHERE id = ANY($1::int[])`,
          [ruleIds],
        )
        .catch(() => {});
    }
    return { ...outcome, ruleIds };
  } catch (e) {
    logger.warn("[dup-resolution-rules] evaluateRules failed (non-fatal)", {
      error: e instanceof Error ? e.message : String(e),
    });
    return { override: null, alwaysLink: false, ruleIds: [] };
  }
}
