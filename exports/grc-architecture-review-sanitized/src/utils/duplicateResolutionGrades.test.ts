/**
 * Unit tests for the pure grade-banding logic (computeGrade).
 * DB layer is best-effort and exercised via integration/manual testing.
 * Run: npx tsx src/utils/duplicateResolutionGrades.test.ts
 */

import { computeGrade, type GradeMetrics } from "./duplicateResolutionGrades";

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

function m(p: Partial<GradeMetrics> = {}): GradeMetrics {
  return {
    decisions: 50,
    agreementRate: 0.97,
    overrideRate: 0.03,
    autoShare: 0.5,
    appliedCount: 25,
    ...p,
  };
}

console.log("computeGrade — banding");
assert(computeGrade(m({ decisions: 5 })).grade === 1, "too few decisions → G1 Trainee regardless of agreement");
assert(computeGrade(m({ decisions: 5 })).label === "Trainee", "G1 label is Trainee");

assert(
  computeGrade(m({ agreementRate: 0.87, overrideRate: 0.2 })).grade === 2,
  "≥20 decisions & agreement ≥85% → G2 Assistant",
);

assert(
  computeGrade(m({ agreementRate: 0.93, overrideRate: 0.08 })).grade === 3,
  "agreement ≥92% & override ≤10% → G3 Trusted",
);
assert(
  computeGrade(m({ agreementRate: 0.93, overrideRate: 0.15 })).grade === 2,
  "high agreement but override >10% → capped at G2",
);

assert(
  computeGrade(m({ agreementRate: 0.97, overrideRate: 0.03 })).grade === 4,
  "agreement ≥96% & override ≤5% → G4 Autonomous Specialist",
);
assert(
  computeGrade(m({ agreementRate: 0.97, overrideRate: 0.06 })).grade === 3,
  "G4 agreement but override >5% → G3",
);

assert(
  computeGrade(m({ agreementRate: 0.5, overrideRate: 0.5 })).grade === 1,
  "low agreement → G1 even with enough decisions",
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
