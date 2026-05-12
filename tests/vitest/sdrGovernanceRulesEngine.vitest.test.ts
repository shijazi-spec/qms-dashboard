/**
 * Run: npx vitest run tests/vitest/sdrGovernanceRulesEngine.vitest.test.ts
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  evaluateGovernanceRuleset,
  loadGovernanceRulesetFromPath,
  parseGovernanceRulesJson,
  resetGovernanceRulesetCache,
  type GovernanceRuleset,
} from "../../src/utils/sdrGovernanceRulesEngine";
import { buildTranscriptVsEvaluationReport } from "../../src/utils/callMcpReconciliation";

const _dir = dirname(fileURLToPath(import.meta.url));
const repoRulesPath = join(_dir, "../../src/config/sdr-governance-2.1.rules.json");

afterEach(() => {
  resetGovernanceRulesetCache();
  delete process.env.SDR_GOVERNANCE_RULES_PATH;
});

describe("parseGovernanceRulesJson", () => {
  test("returns null for invalid JSON", () => {
    expect(parseGovernanceRulesJson("")).toBeNull();
    expect(parseGovernanceRulesJson("{}")).toBeNull();
  });

  test("parses minimal valid ruleset", () => {
    const raw = JSON.stringify({
      ruleset_version: "0.0.1",
      rules: [
        {
          id: "t",
          code: "c",
          severity: "info",
          message: "m",
          match: { type: "min_transcript_length", min_chars: 10 },
        },
      ],
    });
    const r = parseGovernanceRulesJson(raw);
    expect(r?.ruleset_version).toBe("0.0.1");
    expect(r?.rules).toHaveLength(1);
  });
});

describe("evaluateGovernanceRuleset", () => {
  const ruleset: GovernanceRuleset = {
    ruleset_version: "test",
    rules: [
      {
        id: "forbid",
        code: "bad",
        severity: "critical",
        message: "forbidden",
        match: { type: "forbidden_substring", phrases: ["xyzbadphrase"] },
      },
      {
        id: "any",
        code: "need_hello",
        severity: "warning",
        message: "say hello",
        match: { type: "contains_any", min_transcript_chars: 1, phrases: ["hello"] },
      },
    ],
  };

  test("forbidden_substring triggers", () => {
    const issues = evaluateGovernanceRuleset("prefix xyzbadphrase suffix", ruleset);
    expect(issues.some((i) => i.code === "bad")).toBe(true);
  });

  test("contains_any passes when phrase present", () => {
    const issues = evaluateGovernanceRuleset("hello there friend", ruleset);
    expect(issues.some((i) => i.code === "need_hello")).toBe(false);
  });

  test("contains_any fails when phrase absent", () => {
    const issues = evaluateGovernanceRuleset("goodbye there friend", ruleset);
    expect(issues.some((i) => i.code === "need_hello")).toBe(true);
  });

  test("min_transcript_length only when transcript non-empty and short", () => {
    const rs: GovernanceRuleset = {
      ruleset_version: "t",
      rules: [
        {
          id: "len",
          code: "short",
          severity: "warning",
          message: "too short",
          match: { type: "min_transcript_length", min_chars: 100 },
        },
      ],
    };
    expect(evaluateGovernanceRuleset("", rs)).toHaveLength(0);
    expect(evaluateGovernanceRuleset("x".repeat(50), rs)).toHaveLength(1);
    expect(evaluateGovernanceRuleset("x".repeat(200), rs)).toHaveLength(0);
  });
});

describe("shipped rules file", () => {
  test("loads default JSON from repo", () => {
    const res = loadGovernanceRulesetFromPath(repoRulesPath);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.ruleset.rules.length).toBeGreaterThan(0);
      expect(res.ruleset.ruleset_version).toMatch(/^2\.1/);
    }
  });
});

describe("buildTranscriptVsEvaluationReport governance merge", () => {
  test("includes governance block and merged issues", () => {
    process.env.SDR_GOVERNANCE_RULES_PATH = repoRulesPath;
    resetGovernanceRulesetCache();

    const report = buildTranscriptVsEvaluationReport({
      call_record_id: 1,
      lead_id: "Z1",
      transcript_text: "a".repeat(400),
      qa_score_percentage: 80,
      talk_ratio: 0.5,
      sentiment_label: "neutral",
      improvements: [],
    });

    expect(report.governance?.ruleset_version).toBeTruthy();
    expect(report.governance?.rules_evaluated).toBeGreaterThan(0);
    expect(report.issues.length).toBeGreaterThanOrEqual(report.governance?.governance_issue_count ?? 0);
  });
});
