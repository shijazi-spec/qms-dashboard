/**
 * Unit tests for src/utils/clauseCitationExtractor.ts (Compliance v2 Pillar 4).
 *
 * Coverage:
 *   - extractRawCitations recognises common patterns
 *   - canonicaliseFramework maps known aliases
 *   - normaliseClauseHint splits annex / article / clause shapes
 *   - de-dupes identical citations
 *
 * Run:  npx tsx tests/clauseCitationExtractor.test.ts
 */

import {
  extractRawCitations,
  canonicaliseFramework,
  normaliseClauseHint,
  MAX_CITATIONS_PER_DOC,
} from "../src/utils/clauseCitationExtractor";
import { TestSuite } from "./_helpers/runner";

const suite = new TestSuite("clauseCitationExtractor");

console.log("\n=== clauseCitationExtractor unit tests ===\n");

await suite.test("extractRawCitations finds ISO 27001 Annex A pattern", async () => {
  const text =
    "This document covers ISO 27001 A.5.15 access control and ISO 27001 A.5.16 management of access rights.";
  const out = extractRawCitations(text);
  suite.expect(out.length >= 2, `expected >=2 hits, got ${out.length}`);
  const codes = out.map((c) => c.framework_hint);
  suite.expect(
    codes.includes("ISO-27001"),
    `expected ISO-27001 framework hint, got ${JSON.stringify(codes)}`,
  );
});

await suite.test("extractRawCitations finds PDPL Article pattern in both orders", async () => {
  const text =
    "PDPL Article 6 governs lawful processing. Per Article 12 of PDPL, data subjects have rights.";
  const out = extractRawCitations(text);
  suite.expect(out.length >= 2, `expected >=2 hits, got ${out.length}`);
  suite.expect(
    out.some((c) => c.framework_hint === "PDPL"),
    "expected at least one PDPL hit",
  );
});

await suite.test("extractRawCitations de-dupes identical raw citations", async () => {
  const text =
    "ISO 27001 A.5.15 is mentioned. Later, ISO 27001 A.5.15 is mentioned again.";
  const out = extractRawCitations(text);
  // exactly one hit, since both raw strings are identical (case-insensitive)
  suite.expect(out.length === 1, `expected 1 unique hit, got ${out.length}`);
});

await suite.test("extractRawCitations caps at MAX_CITATIONS_PER_DOC", async () => {
  const lines: string[] = [];
  for (let i = 1; i <= MAX_CITATIONS_PER_DOC + 50; i++) {
    lines.push(`ISO 27001 A.${i}.1`);
  }
  const out = extractRawCitations(lines.join("\n"));
  suite.expect(
    out.length <= MAX_CITATIONS_PER_DOC,
    `expected <=${MAX_CITATIONS_PER_DOC}, got ${out.length}`,
  );
});

await suite.test("extractRawCitations returns [] for empty/short text", async () => {
  suite.expect(extractRawCitations("").length === 0, "empty");
  suite.expect(extractRawCitations("hi").length === 0, "too short");
});

await suite.test("canonicaliseFramework maps common aliases", async () => {
  suite.expect(canonicaliseFramework("ISO 27001") === "ISO-27001", "ISO 27001");
  suite.expect(canonicaliseFramework("ISO27001") === "ISO-27001", "ISO27001");
  suite.expect(canonicaliseFramework("PCI-DSS") === "PCI-DSS", "PCI-DSS");
  suite.expect(canonicaliseFramework("PCI DSS") === "PCI-DSS", "PCI DSS");
  suite.expect(canonicaliseFramework("Random Bank Standard") === null, "unknown returns null");
});

await suite.test("normaliseClauseHint splits annex/article/clause", async () => {
  const a = normaliseClauseHint("A.5.15");
  suite.expect(a.annex === "A.5.15", `annex got ${a.annex}`);
  const b = normaliseClauseHint("Article 6");
  suite.expect(b.article === "6", `article got ${b.article}`);
  const c = normaliseClauseHint("Clause 8.2.1");
  suite.expect(c.clause === "8.2.1", `clause got ${c.clause}`);
  const d = normaliseClauseHint("5.1.2");
  suite.expect(d.clause === "5.1.2", `bare clause got ${d.clause}`);
});

await suite.test("source_excerpt is bounded and trimmed", async () => {
  const fluff = "lorem ipsum ".repeat(200);
  const text = fluff + "ISO 27001 A.7.1 explains physical security." + fluff;
  const out = extractRawCitations(text);
  suite.expect(out.length === 1, "expect 1 hit");
  // EXCERPT_BEFORE + EXCERPT_AFTER + raw length ≈ <250 chars
  suite.expect(
    out[0].source_excerpt.length < 300,
    `excerpt too long: ${out[0].source_excerpt.length}`,
  );
  suite.expect(
    out[0].source_excerpt.includes("ISO 27001 A.7.1") ||
      out[0].source_excerpt.includes("A.7.1"),
    "excerpt should contain the hit",
  );
});

suite.finishOrExit();
