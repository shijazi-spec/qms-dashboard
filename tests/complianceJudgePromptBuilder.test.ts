/**
 * Pure-function tests for the compliance-judge LLM prompt builder + parser
 * (Phase 3.2). LLM call is not exercised here — only the prompt
 * construction and JSON parsing.
 *
 * Run:  npx tsx tests/complianceJudgePromptBuilder.test.ts
 */

import { TestSuite } from "./_helpers/runner";
import {
  buildJudgePrompt,
  parseJudgeResponse,
  JUDGE_MAX_DOC_CHARS,
} from "../src/utils/complianceJudge";

const suite = new TestSuite("complianceJudgePromptBuilder");

console.log("\n=== Compliance judge — prompt + parser tests ===\n");

const SAMPLE = {
  obligation: {
    code: "ISO27001-A.5.15",
    title: "Access control",
    description: "Establish rules to control access to information.",
    evidence_requirements: "Approved access-control policy + RBAC matrix.",
  },
  document: {
    title: "Access Control Policy v2",
    text: "Section 3 mandates MFA on all admin accounts. Section 4 requires quarterly access reviews.",
  },
};

// ─── buildJudgePrompt ───────────────────────────────────────────────
await suite.test("prompt includes obligation code, title, description", async () => {
  const p = buildJudgePrompt(SAMPLE);
  suite.expect(p.includes("ISO27001-A.5.15"), "code present");
  suite.expect(p.includes("Access control"), "title present");
  suite.expect(p.includes("Establish rules"), "description present");
});

await suite.test("prompt includes evidence requirements when provided", async () => {
  const p = buildJudgePrompt(SAMPLE);
  suite.expect(p.includes("Approved access-control policy"), "evidence present");
});

await suite.test("prompt includes fallback when evidence requirements null", async () => {
  const p = buildJudgePrompt({
    ...SAMPLE,
    obligation: { ...SAMPLE.obligation, evidence_requirements: null },
  });
  suite.expect(p.includes("(not specified)"), "fallback present");
});

await suite.test("prompt includes document title and excerpt", async () => {
  const p = buildJudgePrompt(SAMPLE);
  suite.expect(p.includes("Access Control Policy v2"), "doc title");
  suite.expect(p.includes("MFA on all admin accounts"), "doc text");
});

await suite.test("prompt truncates very long document text", async () => {
  const big = "x".repeat(JUDGE_MAX_DOC_CHARS * 3);
  const p = buildJudgePrompt({
    ...SAMPLE,
    document: { title: "Big Doc", text: big },
  });
  const m = p.match(/"""\s*([\s\S]*?)\s*"""/);
  suite.expect(!!m, "excerpt block found");
  if (m) {
    suite.expect(
      m[1].length === JUDGE_MAX_DOC_CHARS,
      `excerpt length ${m[1].length} ≠ JUDGE_MAX_DOC_CHARS`,
    );
  }
});

await suite.test("prompt enumerates all 4 allowed status values", async () => {
  const p = buildJudgePrompt(SAMPLE);
  for (const s of ["satisfied", "partial", "missing_topic", "needs_review"]) {
    suite.expect(p.includes(s), `status enum missing: ${s}`);
  }
});

// ─── parseJudgeResponse ─────────────────────────────────────────────
await suite.test("parses valid JSON object", async () => {
  const raw = JSON.stringify({
    status: "partial",
    rationale: "Doc covers MFA but not quarterly reviews.",
    missing_aspects: ["quarterly access reviews"],
  });
  const v = parseJudgeResponse(raw);
  suite.expectEqual(v.status, "partial", "status");
  suite.expect(
    v.rationale.includes("MFA"),
    "rationale preserved",
  );
  suite.expectEqual(v.missing_aspects.length, 1, "missing_aspects length");
});

await suite.test("strips ```json fences", async () => {
  const raw = '```json\n{"status":"satisfied","rationale":"All good","missing_aspects":[]}\n```';
  const v = parseJudgeResponse(raw);
  suite.expectEqual(v.status, "satisfied", "status");
});

await suite.test("ignores prose around the JSON object", async () => {
  const raw =
    'Here is my verdict: {"status":"missing_topic","rationale":"document is about something else","missing_aspects":[]} -- end';
  const v = parseJudgeResponse(raw);
  suite.expectEqual(v.status, "missing_topic", "status");
});

await suite.test("falls back to needs_review for empty input", async () => {
  const v = parseJudgeResponse("");
  suite.expectEqual(v.status, "needs_review", "status");
});

await suite.test("falls back to needs_review for non-JSON garbage", async () => {
  const v = parseJudgeResponse("Sorry, I can't help");
  suite.expectEqual(v.status, "needs_review", "status");
});

await suite.test("falls back to needs_review for malformed JSON", async () => {
  const v = parseJudgeResponse('{"status": "satisfied", "rationale": ');
  suite.expectEqual(v.status, "needs_review", "status");
});

await suite.test("rejects unknown status enum and returns needs_review", async () => {
  const raw = JSON.stringify({
    status: "totally_compliant",
    rationale: "x",
    missing_aspects: [],
  });
  const v = parseJudgeResponse(raw);
  suite.expectEqual(v.status, "needs_review", "status");
});

await suite.test("missing_aspects: filters non-strings and caps to 12", async () => {
  const aspects = Array.from({ length: 30 }, (_, i) => `aspect-${i}`);
  const raw = JSON.stringify({
    status: "partial",
    rationale: "x",
    missing_aspects: [...aspects, 123, null, { foo: "bar" }],
  });
  const v = parseJudgeResponse(raw);
  suite.expectEqual(v.missing_aspects.length, 12, "capped to 12");
  suite.expect(v.missing_aspects.every((a) => typeof a === "string"), "all strings");
});

await suite.test("rationale is truncated to 2000 chars", async () => {
  const raw = JSON.stringify({
    status: "satisfied",
    rationale: "z".repeat(5000),
    missing_aspects: [],
  });
  const v = parseJudgeResponse(raw);
  suite.expect(v.rationale.length === 2000, `rationale length ${v.rationale.length}`);
});

const { passed, failed } = suite.summarize();
console.log(`\n${suite.title}: ${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);
