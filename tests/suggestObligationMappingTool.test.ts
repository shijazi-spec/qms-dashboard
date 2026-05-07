/**
 * Pure-function tests for the suggest-mapping prompt builder + parser
 * (Phase 2.2). LLM call is not exercised here.
 *
 * Run:  npx tsx tests/suggestObligationMappingTool.test.ts
 */

import { TestSuite } from "./_helpers/runner";
import {
  buildSuggestPrompt,
  parseSuggestResponse,
  SUGGEST_MAX_DOC_CHARS,
} from "../src/mastra/tools/suggestObligationMappingTool";

const suite = new TestSuite("suggestObligationMappingTool");

console.log("\n=== Suggest mapping — prompt builder + parser tests ===\n");

const SAMPLE_OBS = [
  {
    id: 1,
    obligation_code: "ISO27001-A.5.1",
    title: "Policies for information security",
    description: "Approve, publish and review information security policy.",
    regulation_code: "ISO-27001",
  },
  {
    id: 2,
    obligation_code: "ISO27001-A.5.15",
    title: "Access control",
    description: "Establish rules to control access to information.",
    regulation_code: "ISO-27001",
  },
];

// ─── buildSuggestPrompt ─────────────────────────────────────────────
await suite.test("prompt includes document title and excerpt", async () => {
  const p = buildSuggestPrompt(
    { title: "Access Control Policy v2", text: "MFA is required." },
    SAMPLE_OBS,
    5,
  );
  suite.expect(p.includes("Access Control Policy v2"), "title present");
  suite.expect(p.includes("MFA is required."), "excerpt present");
});

await suite.test("prompt lists every candidate obligation by code", async () => {
  const p = buildSuggestPrompt(
    { title: "Doc", text: "x" },
    SAMPLE_OBS,
    5,
  );
  for (const ob of SAMPLE_OBS) {
    suite.expect(p.includes(ob.obligation_code), `missing ${ob.obligation_code}`);
    suite.expect(p.includes(ob.title), `missing title for ${ob.obligation_code}`);
  }
});

await suite.test("prompt instructs the model to return at most topN entries", async () => {
  const p = buildSuggestPrompt({ title: "Doc", text: "x" }, SAMPLE_OBS, 3);
  suite.expect(p.includes("at most 3 entries"), "topN included in prompt");
});

await suite.test("prompt truncates very long document text to SUGGEST_MAX_DOC_CHARS", async () => {
  const big = "z".repeat(SUGGEST_MAX_DOC_CHARS * 3);
  const p = buildSuggestPrompt({ title: "Big Doc", text: big }, SAMPLE_OBS, 5);
  // Count z's between the leading and trailing triple quotes.
  const m = p.match(/"""\s*([\s\S]*?)\s*"""/);
  suite.expect(!!m, "excerpt block not found");
  if (m) {
    suite.expect(
      m[1].length === SUGGEST_MAX_DOC_CHARS,
      `excerpt length ${m[1].length} ≠ SUGGEST_MAX_DOC_CHARS`,
    );
  }
});

await suite.test("prompt handles empty extracted text without crashing", async () => {
  const p = buildSuggestPrompt({ title: "Doc", text: "" }, SAMPLE_OBS, 5);
  suite.expect(p.includes("(no extracted text available)"), "fallback present");
});

// ─── parseSuggestResponse ───────────────────────────────────────────
await suite.test("parses valid JSON array", async () => {
  const raw = JSON.stringify([
    { obligation_code: "ISO27001-A.5.1", confidence: 92, rationale: "approved policy" },
    { obligation_code: "ISO27001-A.5.15", confidence: 65, rationale: "covers access" },
  ]);
  const out = parseSuggestResponse(raw, SAMPLE_OBS);
  suite.expectEqual(out.length, 2, "two suggestions parsed");
  suite.expectEqual(out[0].obligation_id, 1, "id resolved from code");
  suite.expect(out[0].confidence === 92, "confidence preserved");
});

await suite.test("strips ```json fences before parsing", async () => {
  const raw = '```json\n[{"obligation_code":"ISO27001-A.5.1","confidence":80,"rationale":"x"}]\n```';
  const out = parseSuggestResponse(raw, SAMPLE_OBS);
  suite.expectEqual(out.length, 1, "one suggestion");
  suite.expectEqual(out[0].obligation_id, 1, "id resolved");
});

await suite.test("ignores prose surrounding the JSON array", async () => {
  const raw = 'Sure, here are my suggestions: [{"obligation_code":"ISO27001-A.5.15","confidence":90,"rationale":"x"}] Hope that helps!';
  const out = parseSuggestResponse(raw, SAMPLE_OBS);
  suite.expectEqual(out.length, 1, "one suggestion parsed despite prose");
  suite.expectEqual(out[0].obligation_code, "ISO27001-A.5.15", "code preserved");
});

await suite.test("drops suggestions whose code is not in candidates (anti-hallucination)", async () => {
  const raw = JSON.stringify([
    { obligation_code: "ISO27001-A.5.1", confidence: 80, rationale: "ok" },
    { obligation_code: "MADE-UP-CODE-99", confidence: 95, rationale: "hallucinated" },
  ]);
  const out = parseSuggestResponse(raw, SAMPLE_OBS);
  suite.expectEqual(out.length, 1, "hallucinated code dropped");
  suite.expectEqual(out[0].obligation_code, "ISO27001-A.5.1", "kept the valid one");
});

await suite.test("clamps confidence to 0..100", async () => {
  const raw = JSON.stringify([
    { obligation_code: "ISO27001-A.5.1", confidence: 999, rationale: "high" },
    { obligation_code: "ISO27001-A.5.15", confidence: -10, rationale: "neg" },
  ]);
  const out = parseSuggestResponse(raw, SAMPLE_OBS);
  suite.expectEqual(out.length, 2, "two suggestions");
  // Sorted desc by confidence after clamping
  suite.expect(out[0].confidence === 100, `expected 100, got ${out[0].confidence}`);
  suite.expect(out[1].confidence === 0, `expected 0, got ${out[1].confidence}`);
});

await suite.test("returns [] for non-JSON garbage", async () => {
  suite.expectEqual(parseSuggestResponse("nonsense", SAMPLE_OBS).length, 0, "len");
});

await suite.test("returns [] for empty string", async () => {
  suite.expectEqual(parseSuggestResponse("", SAMPLE_OBS).length, 0, "len");
});

await suite.test("returns [] when model returns an object instead of array", async () => {
  suite.expectEqual(
    parseSuggestResponse('{"foo": "bar"}', SAMPLE_OBS).length,
    0,
    "len",
  );
});

await suite.test("sorts results by confidence descending", async () => {
  const raw = JSON.stringify([
    { obligation_code: "ISO27001-A.5.1", confidence: 50, rationale: "x" },
    { obligation_code: "ISO27001-A.5.15", confidence: 90, rationale: "y" },
  ]);
  const out = parseSuggestResponse(raw, SAMPLE_OBS);
  suite.expect(out[0].confidence > out[1].confidence, "sorted desc");
  suite.expectEqual(out[0].obligation_code, "ISO27001-A.5.15", "highest first");
});

const { passed, failed } = suite.summarize();
console.log(`\n${suite.title}: ${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);
