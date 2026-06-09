/**
 * Unit tests for the autonomous resolution risk policy (the "1% doubt" gate).
 * Pure logic. Run: npx tsx src/utils/duplicateResolutionPolicy.test.ts
 * Wired: auto-discovered by tests/runIntegrationTests.ts
 */

import {
  evaluateResolutionRisk,
  getResolutionPolicyConfig,
  type ResolutionRiskInput,
} from "./duplicateResolutionPolicy";

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

// A clean, safe-tier input that should AUTO with the default config.
function clean(partial: Partial<ResolutionRiskInput> = {}): ResolutionRiskInput {
  return {
    module: "Accounts",
    confidenceScore: 95,
    mixedDomains: 1,
    mixedPhones: 1,
    csOverlapVerdict: null,
    pipelineValue: 0,
    arrExposure: 0,
    verificationFailed: false,
    conflictCount: 0,
    hasCustomFieldAssumption: false,
    anyMissingZohoId: false,
    masterCompleteness: 0.8,
    distinctOwners: 1,
    distinctLayouts: 1,
    minDaysSinceModified: 90,
    anyActiveDealStage: false,
    isCrossModule: false,
    ...partial,
  };
}

const cfg = getResolutionPolicyConfig();

console.log("evaluateResolutionRisk — clean case AUTOs");
const ok = evaluateResolutionRisk(clean(), cfg);
assert(ok.verdict === "auto" && ok.reasons.length === 0, "clean cluster → AUTO, no reasons");

console.log("each red flag forces ESCALATE");
const flags: Array<[string, Partial<ResolutionRiskInput>, RegExp]> = [
  ["low confidence", { confidenceScore: 70 }, /confidence/i],
  ["mixed domains", { mixedDomains: 2 }, /domain/i],
  ["mixed phones", { mixedPhones: 2 }, /phone/i],
  ["CS block", { csOverlapVerdict: "block" }, /CS overlap/i],
  ["CS review", { csOverlapVerdict: "review" }, /CS overlap/i],
  ["pipeline value", { pipelineValue: 50000 }, /pipeline/i],
  ["arr exposure", { arrExposure: 100000 }, /ARR/i],
  ["active deal stage", { anyActiveDealStage: true }, /active deal/i],
  ["field conflict", { conflictCount: 1 }, /conflict/i],
  ["missing zoho id", { anyMissingZohoId: true }, /no Zoho id/i],
  ["cross module", { isCrossModule: true }, /cross-module/i],
  ["layout split", { distinctLayouts: 2 }, /layout/i],
  ["multiple owners", { distinctOwners: 2 }, /owner/i],
  ["recent modification", { minDaysSinceModified: 2 }, /in-flight/i],
  ["verification failed", { verificationFailed: true }, /verification/i],
  ["custom field assumption", { hasCustomFieldAssumption: true }, /custom field/i],
  ["hollow master", { masterCompleteness: 0.2 }, /complete/i],
];
for (const [name, patch, rx] of flags) {
  const v = evaluateResolutionRisk(clean(patch), cfg);
  assert(
    v.verdict === "escalate" && v.reasons.some((r) => rx.test(r)),
    `${name} → ESCALATE with matching reason`,
  );
}

console.log("CS 'warn' alone does not escalate (only block/review do)");
assert(
  evaluateResolutionRisk(clean({ csOverlapVerdict: "warn" }), cfg).verdict === "auto",
  "CS 'warn' (no other flag) → AUTO",
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
