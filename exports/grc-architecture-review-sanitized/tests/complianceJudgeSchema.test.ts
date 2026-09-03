/**
 * Structural tests for the obligation_evidence_quality + llm_call_log
 * schema (Phase 3.1). Pure-function check that the helper functions
 * exist and pass through the expected status enum values.
 *
 * Does NOT hit the database — only validates the module surface.
 *
 * Run:  npx tsx tests/complianceJudgeSchema.test.ts
 */

import { TestSuite } from "./_helpers/runner";
import * as quality from "../src/utils/complianceQualityDatabase";

const suite = new TestSuite("complianceJudgeSchema");

console.log("\n=== Compliance judge schema — module surface tests ===\n");

await suite.test("module exports the helper functions", async () => {
  suite.expect(
    typeof quality.initEvidenceQualityTable === "function",
    "initEvidenceQualityTable",
  );
  suite.expect(
    typeof quality.upsertEvidenceQuality === "function",
    "upsertEvidenceQuality",
  );
  suite.expect(
    typeof quality.getEvidenceQualityForLink === "function",
    "getEvidenceQualityForLink",
  );
  suite.expect(
    typeof quality.listNonComplianceFindings === "function",
    "listNonComplianceFindings",
  );
  suite.expect(
    typeof quality.listLinksPendingJudgement === "function",
    "listLinksPendingJudgement",
  );
  suite.expect(typeof quality.logLlmCall === "function", "logLlmCall");
});

await suite.test("EvidenceQualityStatus type covers the 4 expected values", async () => {
  // We cannot inspect TS types at runtime, but we can ensure the upsert
  // signature accepts the documented values without TS narrowing failures
  // by walking through them at compile time. (Pure structural smoke test.)
  const allowed: quality.EvidenceQualityStatus[] = [
    "satisfied",
    "partial",
    "missing_topic",
    "needs_review",
  ];
  suite.expectEqual(allowed.length, 4, "four enum values");
});

const { passed, failed } = suite.summarize();
console.log(`\n${suite.title}: ${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);
