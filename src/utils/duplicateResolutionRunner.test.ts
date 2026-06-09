/**
 * Unit tests for the pure helpers in the autonomous-resolution runner
 * (buildResolutionRiskInput, buildRuleFeatures, getResolutionRunConfig).
 * The tick itself (runAutonomousResolution) is exercised via shadow runs.
 * Run: npx tsx src/utils/duplicateResolutionRunner.test.ts
 */

import {
  buildResolutionRiskInput,
  buildRuleFeatures,
  getResolutionRunConfig,
  type BuildRiskInputArgs,
} from "./duplicateResolutionRunner";

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

const NOW = Date.parse("2026-06-09T00:00:00Z");

function planRec(p: Partial<any> = {}): any {
  return {
    dbId: 1,
    zohoId: "z1",
    name: "Acme",
    isMaster: false,
    included: true,
    completeness: 0.9,
    createdDate: null,
    modifiedDate: "2026-01-01T00:00:00Z",
    owner: "Owner A",
    layout: "Corporate Accounts",
    hasZohoId: true,
    ...p,
  };
}

function args(over: Partial<BuildRiskInputArgs> = {}): BuildRiskInputArgs {
  return {
    module: "Accounts",
    cluster: {
      confidence_score: 95,
      cs_overlap_verdict: null,
      estimated_pipeline_value: 0,
      arr_exposure: 0,
      verification_state: null,
      total_leads: 0,
      total_deals: 0,
      total_contacts: 0,
      total_accounts: 2,
    },
    moduleRecords: [{ stage: undefined }, { stage: undefined }],
    plan: {
      masterZohoId: "z1",
      fieldDecisions: [{ action: "fill" }],
      warnings: [],
      accountCandidates: [],
      linkAccountZohoId: null,
      records: [
        planRec({ isMaster: true, zohoId: "z1" }),
        planRec({ zohoId: "z2", owner: "Owner A", layout: "Corporate Accounts" }),
      ],
    } as any,
    mixed: { domains: ["acme.com"], phones: ["966500000000"] },
    nowMs: NOW,
    ...over,
  };
}

console.log("buildResolutionRiskInput — clean case");
const clean = buildResolutionRiskInput(args());
assert(clean.confidenceScore === 95, "carries confidence");
assert(clean.mixedDomains === 1 && clean.mixedPhones === 1, "mixed counts from signal");
assert(clean.conflictCount === 0, "no conflicts when all fills");
assert(clean.distinctOwners === 1, "single owner counted once");
assert(clean.distinctLayouts === 1, "single layout counted once");
assert(clean.isCrossModule === false, "single record type → not cross-module");
assert(clean.anyMissingZohoId === false, "all have zoho ids");
assert(Math.round(clean.minDaysSinceModified) === 159, "days-since-modified computed from nowMs");
assert(clean.duplicatesWithAttachments === 0, "attachments default to 0 when not provided");
assert(
  buildResolutionRiskInput(args({ duplicatesWithAttachments: 2 })).duplicatesWithAttachments === 2,
  "attachment count flows through when provided",
);

console.log("derived red-flags");
assert(
  buildResolutionRiskInput(
    args({ plan: { ...args().plan, fieldDecisions: [{ action: "conflict" }] } as any }),
  ).conflictCount === 1,
  "conflict field decision counted",
);
assert(
  buildResolutionRiskInput(
    args({ plan: { ...args().plan, masterZohoId: null } as any }),
  ).anyMissingZohoId === true,
  "null master zoho id → missing",
);
assert(
  buildResolutionRiskInput(
    args({
      plan: {
        ...args().plan,
        warnings: ["Plan touches custom fields whose API names are assumptions"],
      } as any,
    }),
  ).hasCustomFieldAssumption === true,
  "custom-field warning detected",
);
assert(
  buildResolutionRiskInput(
    args({
      cluster: { ...args().cluster, total_contacts: 3 } as any,
    }),
  ).isCrossModule === true,
  "two record types present → cross-module",
);
assert(
  buildResolutionRiskInput(
    args({ module: "Deals", moduleRecords: [{ stage: "Negotiation" }, { stage: "Closed Lost" }] }),
  ).anyActiveDealStage === true,
  "Deals with an open stage → active deal flag",
);
assert(
  buildResolutionRiskInput(
    args({ module: "Deals", moduleRecords: [{ stage: "Closed Lost" }, { stage: "Junk" }] }),
  ).anyActiveDealStage === false,
  "Deals all lost/junk → not active",
);

console.log("buildRuleFeatures — normalized booleans");
const feats = buildRuleFeatures(
  buildResolutionRiskInput(
    args({ mixed: { domains: ["a.com", "b.com"], phones: [] } }),
  ),
);
assert(feats.mixedDomains === true, "≥2 domains → mixedDomains true");
assert(feats.module === "Accounts", "module carried into features");
assert(feats.layoutSplit === false, "single layout → layoutSplit false");

console.log("getResolutionRunConfig — safe defaults");
const cfg = getResolutionRunConfig();
assert(
  cfg.mode === "shadow" || cfg.mode === "assisted" || cfg.mode === "autonomous",
  "mode is a known value (defaults shadow)",
);
assert(typeof cfg.enabled === "boolean", "enabled is boolean (kill switch)");
assert(cfg.maxClusters > 0, "maxClusters positive");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
