/**
 * Unit tests for the pure helpers in `src/utils/sopGapDetection.ts`.
 *
 * Only the DB-free helpers (`partitionCitations`, `buildCoverageMatcher`)
 * are exercised here; the orchestration in `computeSopGapSummary` is
 * covered indirectly by the executive-digest e2e harness.
 *
 * Run: `npx tsx tests/sopGapDetection.test.ts`
 */

import { TestSuite } from "./_helpers/runner";
import {
  buildCoverageMatcher,
  extractCanonicalCitations,
  normaliseCitation,
  partitionCitations,
} from "../src/utils/sopGapDetection";
import type { ResolvedCitation } from "../src/utils/clauseCitationExtractor";

function cit(
  raw: string,
  obligation_id: number | null = null,
  framework_hint: string | null = null,
): ResolvedCitation {
  return {
    raw_citation: raw,
    source_excerpt: raw,
    framework_hint,
    clause_hint: null,
    regulation_id: null,
    obligation_id,
    confidence: 1,
    method: "regex",
  };
}

const suite = new TestSuite("sopGapDetection helpers");

(async () => {
  await suite.test("partitionCitations splits by predicate", () => {
    const cits = [cit("A.5.15"), cit("Article 6"), cit("Clause 8.2.1")];
    const { covered, open } = partitionCitations(
      cits,
      (c) => c.raw_citation === "Article 6",
    );
    suite.expectEqual(covered.length, 1, "covered count");
    suite.expectEqual(open.length, 2, "open count");
    suite.expectEqual(covered[0].raw_citation, "Article 6", "covered citation");
  });

  await suite.test("partitionCitations handles empty input", () => {
    const { covered, open } = partitionCitations([], () => true);
    suite.expectEqual(covered.length, 0, "covered empty");
    suite.expectEqual(open.length, 0, "open empty");
  });

  await suite.test("buildCoverageMatcher matches case-insensitive substring", () => {
    const corpus = "Finding: missing controls per ISO 27001 A.5.15 in HR.";
    const match = buildCoverageMatcher(corpus, new Set());
    suite.expect(match(cit("A.5.15")), "exact-case substring should match");
    suite.expect(match(cit("a.5.15")), "lowercased substring should match");
    suite.expect(!match(cit("A.6.1")), "absent clause should not match");
  });

  await suite.test("buildCoverageMatcher matches by obligation_id even with no text", () => {
    const match = buildCoverageMatcher("", new Set([42]));
    suite.expect(match(cit("Foo", 42)), "linked obligation should match");
    suite.expect(!match(cit("Foo", 7)), "unlinked obligation should not match");
    suite.expect(!match(cit("Foo", null)), "null obligation_id should not match empty corpus");
  });

  await suite.test("buildCoverageMatcher rejects empty raw_citation", () => {
    const match = buildCoverageMatcher("anything goes here", new Set());
    suite.expect(!match(cit("   ")), "blank citation should not match");
    suite.expect(!match(cit("")), "empty citation should not match");
  });

  await suite.test("buildCoverageMatcher prefers obligation_id over text scan", () => {
    const match = buildCoverageMatcher("no clue here", new Set([99]));
    const hit = match(cit("Article 9999", 99));
    suite.expect(!!hit, "obligation_id hit should short-circuit even when text misses");
    suite.expectEqual(hit?.matched_by, "obligation_id", "matched_by should be obligation_id");
  });

  await suite.test("normaliseCitation collapses prefix variants and aliases", () => {
    const a = normaliseCitation("Art. 6");
    const b = normaliseCitation("Article 6");
    const c = normaliseCitation("§ 6");
    suite.expect(!!a && !!b && !!c, "all three prefix variants should parse");
    suite.expectEqual(a?.kind, "article", "Art. is article kind");
    suite.expectEqual(c?.kind, "article", "§ is article kind");
    suite.expectEqual((a?.path || []).join("."), "6", "Art. 6 path is [6]");
    suite.expectEqual((b?.path || []).join("."), "6", "Article 6 path is [6]");
    suite.expectEqual((c?.path || []).join("."), "6", "§ 6 path is [6]");

    const iso = normaliseCitation("ISO27001 A.5.15");
    suite.expectEqual(iso?.framework, "ISO-27001", "ISO27001 alias canonicalised");
    suite.expectEqual(iso?.kind, "annex", "annex kind");
    suite.expectEqual((iso?.path || []).join("."), "5.15", "annex path");

    const pdpl = normaliseCitation("Article 6", "pdpl");
    suite.expectEqual(pdpl?.framework, "PDPL", "framework hint canonicalised");
  });

  await suite.test("buildCoverageMatcher matches across prefix variants", () => {
    // SOP cites "Article 6"; CAPA records use "Art. 6" and "§6".
    const corpus = "CAPA-12: open finding against Art. 6 of PDPL processing.";
    const match = buildCoverageMatcher(corpus, new Set());
    const hit = match(cit("PDPL Article 6"));
    suite.expect(!!hit, "PDPL Article 6 should match Art. 6 of PDPL");
    suite.expectEqual(hit?.matched_by, "normalised_text", "should be normalised_text match");

    const symbolHit = match(cit("§6", null, "PDPL"));
    suite.expect(!!symbolHit, "§ form with PDPL hint should match");
  });

  await suite.test("buildCoverageMatcher honours sub-clause hierarchy", () => {
    // SOP cites the parent control; CAPA references a narrower sub-clause.
    const corpus = "Audit finding referencing ISO 27001 A.5.15.1 access control.";
    const match = buildCoverageMatcher(corpus, new Set());
    const hit = match(cit("A.5.15"));
    suite.expect(!!hit, "parent A.5.15 should be satisfied by child A.5.15.1");
    suite.expectEqual(hit?.matched_by, "ancestor", "matched_by should be ancestor");

    // Exact match still beats ancestor when both are present.
    const corpus2 = "References A.5.15 directly, plus A.5.15.1 sub-clause.";
    const exact = buildCoverageMatcher(corpus2, new Set())(cit("A.5.15"));
    suite.expectEqual(
      exact?.matched_by,
      "normalised_text",
      "exact path match should outrank ancestor",
    );
  });

  await suite.test("buildCoverageMatcher rejects framework mismatch", () => {
    // SOP cites PDPL Article 6; corpus only has ISO 27001 Article 6.
    const corpus = "Finding references ISO 27001 Article 6 of the management system.";
    const match = buildCoverageMatcher(corpus, new Set());
    const hit = match(cit("PDPL Article 6"));
    suite.expect(!hit, "PDPL needle should not match ISO 27001 evidence");
  });

  await suite.test("extractCanonicalCitations finds reverse-of phrasing", () => {
    const cits = extractCanonicalCitations("Cited Article 12 of PDPL in the report.");
    const pdpl = cits.find((c) => c.framework === "PDPL");
    suite.expect(!!pdpl, "PDPL framework should be detected after the article body");
    suite.expectEqual(pdpl?.kind, "article", "kind is article");
    suite.expectEqual((pdpl?.path || []).join("."), "12", "path is [12]");
  });

  suite.finishOrExit();
})();
