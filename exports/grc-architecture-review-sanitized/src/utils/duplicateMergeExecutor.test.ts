/**
 * Unit tests for duplicateMergeExecutor's pure progress-throttle helper.
 * Run: npx tsx src/utils/duplicateMergeExecutor.test.ts
 * (Co-located src/utils/*.test.ts run via the tsx harness in
 *  tests/runIntegrationTests.ts — NOT vitest, which is scoped to tests/vitest/**.)
 */
import assert from "node:assert";
let passed=0, failed=0;
function eq(c:boolean,l:string){ if(c){console.log("  ✓ "+l);passed++;} else {console.error("  ✗ "+l);failed++;} }
import { makeProgressThrottle } from "./duplicateMergeExecutor";

const seen: number[] = [];
const t = makeProgressThrottle(10, (n) => seen.push(n));
for (let i = 1; i <= 25; i++) t(i);
t(25); // final flush is the caller's job; throttle emits on multiples of 10
eq(seen.includes(10) && seen.includes(20), "emits on each 10th");
eq(!seen.includes(5), "does not emit between thresholds");
console.log("executor throttle ok");
if (failed > 0) { console.error(`\n${failed} FAILED`); process.exit(1); }
