/**
 * Unit tests for src/mastra/tools/extractClausesFromStandardTool.ts
 * (Compliance v2 Pillar 1 — Ingest Standard from Document).
 *
 * Coverage:
 *   - buildExtractPrompt includes framework + excerpt + JSON contract
 *   - parseExtractResponse handles bare arrays, code-fences, prose wrapping
 *   - parseExtractResponse normalises codes / drops invalid rows / dedupes
 *   - parseExtractResponse caps at EXTRACT_MAX_CLAUSES
 *
 * Run:  npx tsx tests/extractClausesFromStandardTool.test.ts
 */

import {
  buildExtractPrompt,
  parseExtractResponse,
  EXTRACT_MAX_CLAUSES,
} from "../src/mastra/tools/extractClausesFromStandardTool";
import { TestSuite } from "./_helpers/runner";

const suite = new TestSuite("extractClausesFromStandardTool");

console.log("\n=== extractClausesFromStandardTool unit tests ===\n");

await suite.test("buildExtractPrompt includes the standard code, name and excerpt", async () => {
  const prompt = buildExtractPrompt({
    regulationCode: "ISO-27001",
    regulationName: "Information Security Management",
    text: "Annex A controls cover information security policies, including A.5.1 ...",
  });
  suite.expect(prompt.includes("ISO-27001"), "should include regulation code");
  suite.expect(prompt.includes("Information Security Management"), "should include name");
  suite.expect(prompt.includes("A.5.1"), "should include excerpt content");
  suite.expect(prompt.includes("JSON array"), "should describe JSON contract");
});

await suite.test("parseExtractResponse handles a bare JSON array", async () => {
  const raw = `[{"obligation_code":"ISO27001-A.5.1","title":"Policies for information security","description":"A set of policies ...","priority":"high"}]`;
  const out = parseExtractResponse(raw);
  suite.expect(out.length === 1, `got ${out.length}`);
  suite.expect(out[0].obligation_code === "ISO27001-A.5.1", "code preserved");
  suite.expect(out[0].priority === "high", "priority normalised");
});

await suite.test("parseExtractResponse strips code-fences and prose", async () => {
  const raw = "Here are the clauses I found:\n```json\n[{\"obligation_code\":\"PDPL-ART-6\",\"title\":\"Lawful processing\",\"description\":\"Personal data shall ...\"}]\n```";
  const out = parseExtractResponse(raw);
  suite.expect(out.length === 1, `expected 1, got ${out.length}`);
  suite.expect(out[0].obligation_code === "PDPL-ART-6", "code preserved");
});

await suite.test("parseExtractResponse drops rows missing title or description", async () => {
  const raw = `[
    {"obligation_code":"OK","title":"Has both","description":"good"},
    {"obligation_code":"NOTITLE","description":"no title here"},
    {"obligation_code":"NODESC","title":"no desc"}
  ]`;
  const out = parseExtractResponse(raw);
  suite.expect(out.length === 1, `expected 1 valid row, got ${out.length}`);
  suite.expect(out[0].obligation_code === "OK", "kept the valid one");
});

await suite.test("parseExtractResponse normalises codes (uppercases, strips spaces)", async () => {
  const raw = `[{"obligation_code":"iso 27001 a.5.1","title":"x","description":"y"}]`;
  const out = parseExtractResponse(raw);
  suite.expect(out[0].obligation_code === "ISO-27001-A.5.1", `got ${out[0].obligation_code}`);
});

await suite.test("parseExtractResponse de-dupes by code", async () => {
  const raw = `[
    {"obligation_code":"DUP","title":"first","description":"d1"},
    {"obligation_code":"DUP","title":"second","description":"d2"}
  ]`;
  const out = parseExtractResponse(raw);
  suite.expect(out.length === 1, `expected 1 (deduped), got ${out.length}`);
  suite.expect(out[0].title === "first", "first occurrence wins");
});

await suite.test("parseExtractResponse defaults bad priority to medium", async () => {
  const raw = `[{"obligation_code":"X","title":"t","description":"d","priority":"super-critical"}]`;
  const out = parseExtractResponse(raw);
  suite.expect(out[0].priority === "medium", `got ${out[0].priority}`);
});

await suite.test("parseExtractResponse caps at EXTRACT_MAX_CLAUSES", async () => {
  const arr: any[] = [];
  for (let i = 0; i < EXTRACT_MAX_CLAUSES + 25; i++) {
    arr.push({ obligation_code: `X-${i}`, title: "t", description: "d" });
  }
  const out = parseExtractResponse(JSON.stringify(arr));
  suite.expect(
    out.length <= EXTRACT_MAX_CLAUSES,
    `expected <=${EXTRACT_MAX_CLAUSES}, got ${out.length}`,
  );
});

await suite.test("parseExtractResponse returns [] for non-JSON or empty", async () => {
  suite.expect(parseExtractResponse("").length === 0, "empty");
  suite.expect(parseExtractResponse("not json at all").length === 0, "not json");
  suite.expect(parseExtractResponse("{not an array}").length === 0, "object not array");
});

suite.finishOrExit();
