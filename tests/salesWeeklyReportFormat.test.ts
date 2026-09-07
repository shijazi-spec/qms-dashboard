/**
 * Guards the compliance-rate formatting in src/utils/salesWeeklyReports.ts.
 *
 * The first real report posted "compliant 1800.0%" on a figure that was
 * actually 18%: shapeDealCompliance already returns a PERCENTAGE
 * (Math.round(100 * compliant / checked)) and the report multiplied it by 100
 * again. A wrong number in a compliance report is worse than no report — it
 * gets quoted, and nobody re-derives it.
 *
 * This pins the contract at its source so the two cannot drift apart again.
 *
 * Run:  npx tsx tests/salesWeeklyReportFormat.test.ts
 */

import { shapeDealCompliance } from "../src/utils/dealComplianceReport";
import { TestSuite } from "./_helpers/runner";

const suite = new TestSuite("salesWeeklyReportFormat");

console.log("\n=== deal-compliance rate contract ===\n");

const rows = (compliant: number, total: number) =>
  Array.from({ length: total }, (_, i) => ({
    stage: "Proposal",
    compliant: i < compliant,
    amount: 100,
    owner: "someone",
    missing_docs: i < compliant ? null : ["Agreement"],
  }));

await suite.test("compliant_rate is a PERCENTAGE, not a ratio", async () => {
  // The whole bug in one assertion: 214 of 1210 must be ~18, never ~0.18.
  const s = shapeDealCompliance("walaplus", rows(214, 1210));
  suite.expectEqual(s.compliant_rate, 18, "18, not 0.18");
});

await suite.test("the reported figure stays in 0-100", async () => {
  // Rendering it verbatim must never produce the 1800% that shipped.
  for (const [c, t] of [[0, 10], [5, 10], [10, 10], [214, 1210]]) {
    const s = shapeDealCompliance("walaplus", rows(c, t));
    const rate = s.compliant_rate ?? 0;
    suite.expectEqual(rate >= 0 && rate <= 100, true, `${c}/${t} -> ${rate}`);
  }
});

await suite.test("all compliant reads 100, none reads 0", async () => {
  suite.expectEqual(shapeDealCompliance("walaplus", rows(10, 10)).compliant_rate, 100, "all");
  suite.expectEqual(shapeDealCompliance("walaplus", rows(0, 10)).compliant_rate, 0, "none");
});

await suite.test("nothing checked yields null, not a divide-by-zero", async () => {
  const s = shapeDealCompliance("walaplus", []);
  suite.expectEqual(s.compliant_rate, null, "null");
  suite.expectEqual(s.checked, 0, "checked");
});

await suite.test("missing count is derivable and matches the report", async () => {
  // The report prints `checked - compliant` as "missing"; keep that honest.
  const s = shapeDealCompliance("walaplus", rows(214, 1210));
  suite.expectEqual(s.checked - s.compliant, 996, "996 missing");
});

suite.finishOrExit();
