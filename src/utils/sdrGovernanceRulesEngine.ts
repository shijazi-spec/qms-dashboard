import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReconciliationIssue } from "./callMcpReconciliation";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RULES_PATH = join(__dirname, "../config/sdr-governance-2.1.rules.json");
const CWD_FALLBACK_RULES_PATH = join(process.cwd(), "src/config/sdr-governance-2.1.rules.json");

export type GovernanceRuleMatch =
  | { type: "min_transcript_length"; min_chars: number }
  | {
      type: "contains_any";
      phrases: string[];
      min_transcript_chars?: number;
    }
  | {
      type: "contains_all";
      phrases: string[];
      min_transcript_chars?: number;
    }
  | { type: "forbidden_substring"; phrases: string[] };

export interface GovernanceRuleRow {
  id: string;
  code: string;
  severity: ReconciliationIssue["severity"];
  message: string;
  suggestion?: string;
  match: GovernanceRuleMatch;
}

export interface GovernanceRuleset {
  ruleset_version: string;
  source_artifacts?: string[];
  notes?: string;
  rules: GovernanceRuleRow[];
}

let cachedRuleset: GovernanceRuleset | null | undefined;

function lower(s: string): string {
  return s.toLowerCase();
}

/** Parse JSON string; returns null if invalid. */
export function parseGovernanceRulesJson(raw: string): GovernanceRuleset | null {
  try {
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object") return null;
    const o = data as Record<string, unknown>;
    if (typeof o.ruleset_version !== "string" || !Array.isArray(o.rules)) return null;
    return data as GovernanceRuleset;
  } catch {
    return null;
  }
}

/**
 * Evaluate ruleset against transcript. Rules with min_transcript_chars skip when transcript is shorter.
 * `min_transcript_length` fires an issue when transcript is **below** min_chars (too short).
 */
export function evaluateGovernanceRuleset(
  transcript: string | null | undefined,
  ruleset: GovernanceRuleset,
): ReconciliationIssue[] {
  const t = transcript?.trim() ?? "";
  const tl = lower(t);
  const issues: ReconciliationIssue[] = [];

  for (const rule of ruleset.rules) {
    const m = rule.match;
    if (!m) continue;

    if (m.type === "min_transcript_length") {
      if (t.length > 0 && t.length < m.min_chars) {
        issues.push({
          code: rule.code,
          severity: rule.severity,
          message: rule.message,
          suggestion: rule.suggestion,
        });
      }
      continue;
    }

    if (m.type === "forbidden_substring") {
      for (const p of m.phrases) {
        if (p && tl.includes(lower(p))) {
          issues.push({
            code: rule.code,
            severity: rule.severity,
            message: `${rule.message} (matched: "${p.slice(0, 80)}")`,
            suggestion: rule.suggestion,
          });
          break;
        }
      }
      continue;
    }

    const minLen = m.min_transcript_chars ?? 0;
    if (t.length < minLen) continue;

    if (m.type === "contains_any") {
      const hit = m.phrases.some((p) => p && tl.includes(lower(p)));
      if (!hit) {
        issues.push({
          code: rule.code,
          severity: rule.severity,
          message: rule.message,
          suggestion: rule.suggestion,
        });
      }
      continue;
    }

    if (m.type === "contains_all") {
      const miss = m.phrases.some((p) => !p || !tl.includes(lower(p)));
      if (miss) {
        issues.push({
          code: rule.code,
          severity: rule.severity,
          message: rule.message,
          suggestion: rule.suggestion,
        });
      }
    }
  }

  return issues;
}

export function loadGovernanceRulesetFromPath(
  absolutePath: string,
): { ok: true; ruleset: GovernanceRuleset } | { ok: false; error: string } {
  try {
    const raw = readFileSync(absolutePath, "utf8");
    const ruleset = parseGovernanceRulesJson(raw);
    if (!ruleset) return { ok: false, error: "invalid_rules_json" };
    return { ok: true, ruleset };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "read_failed",
    };
  }
}

/**
 * Loads SDR Governance 2.1 rules JSON once per process. Set `process.env.SDR_GOVERNANCE_RULES_PATH` to override file path.
 */
export function getGovernanceRuleset(): GovernanceRuleset | null {
  if (cachedRuleset !== undefined) return cachedRuleset;

  const envPath = process.env.SDR_GOVERNANCE_RULES_PATH;
  const candidates = envPath
    ? [envPath]
    : [DEFAULT_RULES_PATH, CWD_FALLBACK_RULES_PATH];

  for (const path of candidates) {
    const res = loadGovernanceRulesetFromPath(path);
    if (res.ok) {
      cachedRuleset = res.ruleset;
      return cachedRuleset;
    }
  }
  cachedRuleset = null;
  return null;
}

/** Test helper: reset module cache between tests. */
export function resetGovernanceRulesetCache(): void {
  cachedRuleset = undefined;
}

export function evaluateLoadedGovernanceRules(
  transcript: string | null | undefined,
): {
  issues: ReconciliationIssue[];
  ruleset_version: string | null;
  rules_evaluated: number;
  load_error: string | null;
  source_artifacts: string[];
} {
  const ruleset = getGovernanceRuleset();
  if (!ruleset) {
    const tried = process.env.SDR_GOVERNANCE_RULES_PATH
      ? process.env.SDR_GOVERNANCE_RULES_PATH
      : `${DEFAULT_RULES_PATH} ; ${CWD_FALLBACK_RULES_PATH}`;
    return {
      issues: [
        {
          code: "sdr_gov_rules_unavailable",
          severity: "info",
          message: `SDR governance rules file could not be loaded (tried: ${tried}).`,
          suggestion: "Ensure sdr-governance-2.1.rules.json exists under src/config or set SDR_GOVERNANCE_RULES_PATH.",
        },
      ],
      ruleset_version: null,
      rules_evaluated: 0,
      load_error: "missing_or_invalid",
      source_artifacts: [],
    };
  }

  const issues = evaluateGovernanceRuleset(transcript, ruleset);
  return {
    issues,
    ruleset_version: ruleset.ruleset_version,
    rules_evaluated: ruleset.rules.length,
    load_error: null,
    source_artifacts: ruleset.source_artifacts ?? [],
  };
}
