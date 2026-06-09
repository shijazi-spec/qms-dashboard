/**
 * Unit tests for the pure rule-matching helpers (signatureMatches, pickRuleOutcome).
 * The DB layer is best-effort and exercised via integration/manual testing.
 * Run: npx tsx src/utils/duplicateResolutionRules.test.ts
 */

import { signatureMatches, pickRuleOutcome } from "./duplicateResolutionRules";

let passed = 0;
let failed = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

console.log("signatureMatches — subset match");
const features = { module: "Contacts", layoutSplit: true, mixedDomains: false, domain: "acme.com" };
assert(signatureMatches({ layoutSplit: true }, features), "single-key subset matches");
assert(signatureMatches({ module: "Contacts", domain: "acme.com" }, features), "multi-key subset matches");
assert(!signatureMatches({ layoutSplit: false }, features), "mismatched value does not match");
assert(!signatureMatches({ missingKey: true }, features), "missing feature key does not match");
assert(!signatureMatches({}, features), "empty signature never matches (no accidental match-all)");

console.log("pickRuleOutcome — net decision");
assert(
  pickRuleOutcome([{ decision: "auto_approve" }]).override === "auto",
  "auto_approve → auto override",
);
assert(
  pickRuleOutcome([{ decision: "never_merge" }]).override === "escalate",
  "never_merge → escalate override",
);
assert(
  pickRuleOutcome([{ decision: "auto_approve" }, { decision: "never_merge" }]).override === "escalate",
  "never_merge wins over auto_approve (safety)",
);
assert(
  pickRuleOutcome([{ decision: "always_link" }]).alwaysLink === true &&
    pickRuleOutcome([{ decision: "always_link" }]).override === null,
  "always_link sets the link hint, no verdict override",
);
assert(
  pickRuleOutcome([]).override === null && pickRuleOutcome([]).alwaysLink === false,
  "no rules → no override, no link",
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
