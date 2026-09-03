/**
 * Tests for the COPC-aligned SDR evaluation prompt + the router that
 * decides between v2 (COPC) and v1 (legacy) prompts based on scorecard
 * shape.
 *
 * Run: npx vitest run tests/vitest/copcSdrEvaluationPrompt.vitest.test.ts
 *
 * Pure-function tests — no DB, no LLMProvider calls.
 */
import { describe, expect, test } from "vitest";
import {
  buildCopcSDREvaluationPrompt,
  buildSDREvaluationPrompt,
} from "../../src/utils/callIntelligenceDb";

const SAMPLE_TRANSCRIPT = "Agent: السلام عليكم. Customer: وعليكم السلام. ...";

function copcAttr(over: any = {}) {
  return {
    id: "comm_skills",
    name: "Communication Skills",
    description: "Clarity + professionalism",
    dimension: "people" as const,
    weight: 0.075,
    severity: "minor" as const,
    evaluation_logic: "Rubric 0-2 on clarity",
    evidence_fields: [],
    scoring_type: "numeric" as const,
    target: 100,
    section_id: "quality_and_soft_skills",
    metric: "Rubric 0-2 assessing clarity",
    data_dependency: "call_transcripts + ai_judge_prompt",
    ...over,
  };
}

function legacyAttr(over: any = {}) {
  return {
    id: "old_attr_1",
    name: "Old Attribute",
    description: "Some legacy attribute",
    dimension: "process" as const,
    weight: 0.1,
    severity: "major" as const,
    evaluation_logic: "Did the SDR do X",
    evidence_fields: [],
    scoring_type: "pass_fail" as const,
    target: 100,
    // NO section_id — that's what makes it "legacy"
    ...over,
  };
}

describe("buildSDREvaluationPrompt — routing", () => {
  test("dispatches to COPC builder when attributes have section_id", () => {
    const card = {
      id: 1,
      name: "ExampleOrg COPC v2",
      version: "2.0.0",
      team_name: undefined,
      attributes: [copcAttr()],
    };
    const p = buildSDREvaluationPrompt(SAMPLE_TRANSCRIPT, card);
    expect(p).toContain("COPC-aligned");
    expect(p).toContain("0 = Not Met");
    expect(p).not.toContain("نموذج التقييم"); // legacy Arabic header
  });

  test("dispatches to legacy builder when no attribute has section_id", () => {
    const card = {
      id: 1,
      name: "Example Organization Sales Quality v1.5",
      version: "1.5",
      team_name: undefined,
      attributes: [legacyAttr()],
    };
    const p = buildSDREvaluationPrompt(SAMPLE_TRANSCRIPT, card);
    expect(p).toContain("نموذج التقييم"); // legacy Arabic header
    expect(p).not.toContain("COPC-aligned");
  });

  test("dispatches to COPC builder even if only SOME attributes have section_id (mixed = treat as v2)", () => {
    const card = {
      id: 1,
      name: "Mixed",
      version: "2.0.0",
      team_name: undefined,
      attributes: [copcAttr(), legacyAttr()],
    };
    const p = buildSDREvaluationPrompt(SAMPLE_TRANSCRIPT, card);
    expect(p).toContain("COPC-aligned");
  });
});

describe("buildCopcSDREvaluationPrompt — structure", () => {
  test("includes the transcript verbatim", () => {
    const card = {
      id: 1,
      name: "x",
      version: "x",
      team_name: undefined,
      attributes: [copcAttr()],
    };
    const p = buildCopcSDREvaluationPrompt(SAMPLE_TRANSCRIPT, card);
    expect(p).toContain(SAMPLE_TRANSCRIPT);
  });

  test("explains the 0/1/2/null rubric explicitly", () => {
    const card = {
      id: 1,
      name: "x",
      version: "x",
      team_name: undefined,
      attributes: [copcAttr()],
    };
    const p = buildCopcSDREvaluationPrompt(SAMPLE_TRANSCRIPT, card);
    expect(p).toContain("0 = Not Met");
    expect(p).toContain("1 = Partially Met");
    expect(p).toContain("2 = Fully Met");
    expect(p).toContain("null = Cannot Score");
  });

  test("groups attributes by section_id with a header per section", () => {
    const card = {
      id: 1,
      name: "x",
      version: "x",
      team_name: undefined,
      attributes: [
        copcAttr({ id: "a1", section_id: "quality_and_soft_skills" }),
        copcAttr({ id: "a2", section_id: "quality_and_soft_skills" }),
        copcAttr({ id: "a3", section_id: "coaching_and_improvement" }),
      ],
    };
    const p = buildCopcSDREvaluationPrompt(SAMPLE_TRANSCRIPT, card);
    expect(p).toContain("### Section: quality_and_soft_skills");
    expect(p).toContain("### Section: coaching_and_improvement");
  });

  test("tags ContactCenterProvider-deferred checkpoints inline so the AI scores them null", () => {
    const card = {
      id: 1,
      name: "x",
      version: "x",
      team_name: undefined,
      attributes: [
        copcAttr({
          id: "login_gap",
          section_id: "activity_and_process",
          data_dependency: "ContactCenterProvider_real_ingest",
        }),
      ],
    };
    const p = buildCopcSDREvaluationPrompt(SAMPLE_TRANSCRIPT, card);
    expect(p).toContain("[<REDACTED_SCHEME> deferred");
  });

  test("requires the JSON status mapping rule (2→PASS, 0|1→FAIL, null→NA)", () => {
    const card = {
      id: 1,
      name: "x",
      version: "x",
      team_name: undefined,
      attributes: [copcAttr()],
    };
    const p = buildCopcSDREvaluationPrompt(SAMPLE_TRANSCRIPT, card);
    expect(p).toContain('score=2 → "PASS"');
    expect(p).toContain('score 0 or 1 → "FAIL"');
    expect(p).toContain('score=null → "NA"');
  });

  test("specifies the weighted overall_score formula explicitly", () => {
    const card = {
      id: 1,
      name: "x",
      version: "x",
      team_name: undefined,
      attributes: [copcAttr()],
    };
    const p = buildCopcSDREvaluationPrompt(SAMPLE_TRANSCRIPT, card);
    expect(p).toContain("Overall score formula");
    expect(p).toContain("weighted average");
    expect(p).toContain("re-normalize across remaining sections");
  });

  test("requires section_scores in the response (per-section breakdown)", () => {
    const card = {
      id: 1,
      name: "x",
      version: "x",
      team_name: undefined,
      attributes: [copcAttr()],
    };
    const p = buildCopcSDREvaluationPrompt(SAMPLE_TRANSCRIPT, card);
    expect(p).toContain("section_scores");
    expect(p).toContain("avg_score_0_2");
    expect(p).toContain("scored_count");
    expect(p).toContain("deferred_count");
  });

  test("preserves legacy dimension_scores field for backward-compat parsers", () => {
    const card = {
      id: 1,
      name: "x",
      version: "x",
      team_name: undefined,
      attributes: [copcAttr()],
    };
    const p = buildCopcSDREvaluationPrompt(SAMPLE_TRANSCRIPT, card);
    expect(p).toContain("dimension_scores");
    expect(p).toContain('"people"');
    expect(p).toContain('"process"');
    expect(p).toContain('"governance"');
  });
});
