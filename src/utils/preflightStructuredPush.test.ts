/**
 * Unit tests for preflightStructuredPush constants.
 * Run: npx tsx src/utils/preflightStructuredPush.test.ts
 * (Co-located src/utils/*.test.ts run via the tsx harness in
 *  tests/runIntegrationTests.ts — NOT vitest, which is scoped to tests/vitest/**.)
 */
import assert from "node:assert";

let passed = 0;
let failed = 0;
function assertEq(cond: boolean, label: string): void {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}

import { PREFLIGHT_DEAL_TARGET, PREFLIGHT_LEAD_TARGET } from "./preflightStructuredPush";
assertEq(PREFLIGHT_DEAL_TARGET.layoutId === "5146753000000019023", "deal layout id default");
assertEq(PREFLIGHT_DEAL_TARGET.pipeline === "Standard (Corporates)", "deal pipeline default");
assertEq(PREFLIGHT_DEAL_TARGET.stage === "New Deal", "deal stage default");
assertEq(PREFLIGHT_LEAD_TARGET.layoutId === "5146753000000091055", "lead layout id default");
assertEq(PREFLIGHT_LEAD_TARGET.status === "New Lead", "lead status default");
console.log("preflightStructuredPush constants ok");

if (failed > 0) { console.error(`\n${failed} test(s) FAILED`); process.exit(1); }
