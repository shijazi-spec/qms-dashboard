/**
 * Pure-function tests for the multi-vote judge consensus (benchmark rec #4).
 * Run:  npx tsx tests/judgeAggregate.test.ts
 */

import { TestSuite } from "./_helpers/runner";
import { aggregateVerdicts } from "../src/utils/complianceJudge";

const suite = new TestSuite("judgeAggregate");
const v = (status: any, r = "") => ({ status, rationale: r, missing_aspects: [] as string[] });

console.log("\n=== judge multi-vote consensus — pure tests ===\n");

await suite.test("single verdict passes through unchanged", async () => {
  const out = aggregateVerdicts([v("satisfied", "ok")]);
  suite.expectEqual(out.status, "satisfied", "status");
  suite.expectEqual(out.rationale, "ok", "rationale unchanged for 1 vote");
});

await suite.test("clear majority wins", async () => {
  const out = aggregateVerdicts([v("satisfied"), v("satisfied"), v("partial")]);
  suite.expectEqual(out.status, "satisfied", "2/3 satisfied");
});

await suite.test("tie breaks conservatively away from 'satisfied'", async () => {
  const out = aggregateVerdicts([v("satisfied"), v("partial")]);
  suite.expectEqual(out.status, "partial", "tie -> partial, not satisfied");
});

await suite.test("tie satisfied vs missing_topic -> missing_topic (most conservative)", async () => {
  const out = aggregateVerdicts([v("satisfied"), v("missing_topic")]);
  suite.expectEqual(out.status, "missing_topic", "most conservative tie wins");
});

await suite.test("consensus annotation present for multi-vote", async () => {
  const out = aggregateVerdicts([v("partial", "x"), v("partial", "y"), v("satisfied", "z")]);
  suite.expect(out.rationale.indexOf("consensus") !== -1, "annotated");
  suite.expectEqual(out.status, "partial", "status");
});

await suite.test("empty -> needs_review", async () => {
  suite.expectEqual(aggregateVerdicts([]).status, "needs_review", "empty");
});

const { passed, failed } = suite.summarize();
console.log(`\n${suite.title}: ${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);
