/**
 * Pure-function tests for the framework coverage % calculation
 * (Phase 1.2 of the document-mapping feature).
 *
 * No database — exercises the pure helper that backs both
 * getFrameworkCoverage() and getAllFrameworkCoverage().
 *
 * Run:  npx tsx tests/coverageMath.test.ts
 */

import { TestSuite } from "./_helpers/runner";
import { calculateCoveragePct } from "../src/utils/obligationDocumentsDatabase";

const suite = new TestSuite("coverageMath");

console.log("\n=== Coverage % math — pure tests ===\n");

await suite.test("0 of 0 → 0% (no division by zero on empty framework)", async () => {
  suite.expectEqual(calculateCoveragePct(0, 0), 0, "calc(0,0)");
});

await suite.test("0 of 100 → 0%", async () => {
  suite.expectEqual(calculateCoveragePct(100, 0), 0, "calc(100,0)");
});

await suite.test("100 of 100 → 100%", async () => {
  suite.expectEqual(calculateCoveragePct(100, 100), 100, "calc(100,100)");
});

await suite.test("50 of 100 → 50%", async () => {
  suite.expectEqual(calculateCoveragePct(100, 50), 50, "calc(100,50)");
});

await suite.test("33 of 100 → 33% (rounded)", async () => {
  suite.expectEqual(calculateCoveragePct(100, 33), 33, "calc(100,33)");
});

await suite.test("1 of 3 → 33% (33.33% rounded)", async () => {
  suite.expectEqual(calculateCoveragePct(3, 1), 33, "calc(3,1)");
});

await suite.test("2 of 3 → 67% (66.67% rounded)", async () => {
  suite.expectEqual(calculateCoveragePct(3, 2), 67, "calc(3,2)");
});

await suite.test("withEvidence > total clamps to 100", async () => {
  suite.expectEqual(
    calculateCoveragePct(10, 999),
    100,
    "calc(10,999) should clamp",
  );
});

await suite.test("negative withEvidence clamps to 0", async () => {
  suite.expectEqual(
    calculateCoveragePct(10, -3),
    0,
    "calc(10,-3) should clamp",
  );
});

await suite.test("negative total clamps to 0", async () => {
  suite.expectEqual(
    calculateCoveragePct(-10, 5),
    0,
    "calc(-10,5) should clamp",
  );
});

await suite.test("real-world: ISO 27001 with 12 of 104 mapped → 12%", async () => {
  suite.expectEqual(calculateCoveragePct(104, 12), 12, "calc(104,12)");
});

await suite.test("real-world: PCI DSS with 70 of 89 mapped → 79%", async () => {
  suite.expectEqual(calculateCoveragePct(89, 70), 79, "calc(89,70)");
});

const { passed, failed } = suite.summarize();
console.log(`\n${suite.title}: ${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);
