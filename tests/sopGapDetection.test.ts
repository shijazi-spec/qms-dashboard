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
    suite.expect(
      match(cit("Article 9999", 99)),
      "obligation_id hit should short-circuit even when text misses",
    );
  });

  suite.finishOrExit();
})();
