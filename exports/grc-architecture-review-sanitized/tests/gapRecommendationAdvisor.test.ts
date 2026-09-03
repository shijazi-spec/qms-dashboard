/**
 * Pure-function tests for the AI gap-remediation advisor's prompt builders
 * and JSON parser. No DB / no OpenAI.
 *
 * Run:  npx tsx tests/gapRecommendationAdvisor.test.ts
 */

import { TestSuite } from "./_helpers/runner";
import {
  buildResearchPrompt,
  buildRecommendationPrompt,
  parseRecommendation,
  buildDraftPrompt,
} from "../src/utils/gapRecommendationAdvisor";

const suite = new TestSuite("gapRecommendationAdvisor");

console.log("\n=== AI gap recommendation advisor — pure tests ===\n");

const clause = {
  regulation_code: "ISO-27001",
  obligation_code: "ISO27001-A.8.24",
  title: "Use of cryptography",
  description: "Rules for the effective use of cryptography...",
};

await suite.test("research prompt names the framework + clause", async () => {
  const p = buildResearchPrompt(clause);
  suite.expect(p.includes("ISO-27001"), "framework");
  suite.expect(p.includes("ISO27001-A.8.24"), "code");
  suite.expect(p.includes("Use of cryptography"), "title");
});

await suite.test("recommendation prompt includes clause + research + JSON instruction", async () => {
  const p = buildRecommendationPrompt(clause, "Some web research about crypto policies.");
  suite.expect(p.includes("ISO27001-A.8.24"), "code");
  suite.expect(p.includes("Some web research"), "research folded in");
  suite.expect(p.includes("suggested_document_title"), "asks for the JSON keys");
});

await suite.test("recommendation prompt handles empty research", async () => {
  const p = buildRecommendationPrompt(clause, "");
  suite.expect(p.toLowerCase().includes("none available") || p.toLowerCase().includes("your own knowledge"), "fallback note");
});

await suite.test("parse a clean JSON recommendation", async () => {
  const r = parseRecommendation(JSON.stringify({
    what_required: "Define cryptography rules.",
    recommended_action: "Write a Cryptographic Policy.",
    suggested_document_title: "Cryptographic Key Management Policy",
    document_type: "Policy",
    key_criteria: ["scope", "key lifecycle", "algorithms"],
    priority: "high",
  }));
  suite.expect(r !== null, "parsed");
  suite.expectEqual(r!.suggested_document_title, "Cryptographic Key Management Policy", "title");
  suite.expectEqual(r!.priority, "high", "priority");
  suite.expectEqual(r!.key_criteria.length, 3, "criteria count");
});

await suite.test("tolerates code fences + stray prose", async () => {
  const raw = 'Here you go:\n```json\n{"what_required":"x","recommended_action":"y","suggested_document_title":"Z Policy","document_type":"Policy","key_criteria":["a"],"priority":"medium"}\n```';
  const r = parseRecommendation(raw);
  suite.expect(r !== null, "parsed");
  suite.expectEqual(r!.suggested_document_title, "Z Policy", "title");
});

await suite.test("invalid priority normalises to medium", async () => {
  const r = parseRecommendation('{"what_required":"x","recommended_action":"y","suggested_document_title":"t","document_type":"Policy","key_criteria":[],"priority":"URGENT"}');
  suite.expectEqual(r!.priority, "medium", "normalised");
});

await suite.test("non-JSON returns null", async () => {
  suite.expectEqual(parseRecommendation("sorry, I cannot help"), null, "null");
  suite.expectEqual(parseRecommendation(""), null, "empty null");
});

await suite.test("non-array key_criteria degrades to empty list", async () => {
  const r = parseRecommendation('{"what_required":"x","recommended_action":"y","suggested_document_title":"t","document_type":"Policy","key_criteria":"oops","priority":"low"}');
  suite.expectEqual(r!.key_criteria.length, 0, "empty");
  suite.expectEqual(r!.priority, "low", "low kept");
});

await suite.test("draft prompt anchors to the clause + recommendation structure", async () => {
  const p = buildDraftPrompt(clause, {
    what_required: "Define cryptography rules.",
    document_type: "Policy",
    suggested_document_title: "Cryptographic Policy",
    key_criteria: ["scope", "key lifecycle"],
  });
  suite.expect(p.includes("ISO27001-A.8.24"), "clause code");
  suite.expect(p.includes("Cryptographic Policy"), "title");
  suite.expect(p.includes("key lifecycle"), "criteria folded in");
  suite.expect(p.toLowerCase().includes("markdown"), "asks for markdown");
  suite.expect(p.includes("Purpose") && p.includes("Roles & Responsibilities"), "document structure");
});

await suite.test("draft prompt tolerates a bare recommendation", async () => {
  const p = buildDraftPrompt(clause, {});
  suite.expect(p.includes("ISO-27001"), "framework present");
  suite.expect(typeof p === "string" && p.length > 0, "non-empty");
});

const { passed, failed } = suite.summarize();
console.log(`\n${suite.title}: ${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);
