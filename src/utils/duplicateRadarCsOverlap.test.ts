/**
 * Unit tests for the cluster-level CS pipeline overlap classifier.
 *
 * The classifier was rewritten on 2026-06-11 (Sarah Hijazi): BLOCK now
 * fires ONLY when an OPEN sales Deal AND a Paid/Agreement-Signed handoff
 * Deal coexist in the same duplicate cluster, modulated by the
 * sector-aware churn cool-off. These tests lock that behaviour in.
 */
import {
  classifyClusterOverlap,
  resetClusterOverlapConfigCache,
  resetCsOverlapConfigCache,
  type ClusterDealInfo,
} from "./duplicateRadarCsOverlap";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    resetClusterOverlapConfigCache();
    resetCsOverlapConfigCache();
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${e?.message || e}`);
    failed++;
  }
}
function assert(cond: any, msg: string): void {
  if (!cond) throw new Error(msg);
}

const NOW = new Date("2026-06-11T00:00:00Z");

console.log("cluster-level CS overlap classifier");

test("BLOCK: open Proposal deal + Paid handoff deal + Adoption phase", () => {
  const deals: ClusterDealInfo[] = [
    {
      stage: "Proposal",
      cs: { phase: null, gov_type: "Private", domain: "acme.com" },
      arr_value: 0,
    },
    {
      stage: "Paid",
      cs: {
        phase: "Adoption",
        gov_type: "Private",
        domain: "acme.com",
      },
      arr_value: 1_000_000,
    },
  ];
  const out = classifyClusterOverlap(deals, NOW);
  assert(out.verdict === "block", `expected block, got ${out.verdict}`);
  assert(out.arr_exposure === 1_000_000, `wrong ARR: ${out.arr_exposure}`);
  assert(out.lifecycle_state === "adoption", `wrong phase: ${out.lifecycle_state}`);
});

test("BLOCK: open Awaiting PO deal + Agreement Signed handoff in Renewal", () => {
  const deals: ClusterDealInfo[] = [
    {
      stage: "Awaiting PO",
      cs: { phase: null, gov_type: "Government", domain: "x.gov.sa" },
      arr_value: 0,
    },
    {
      stage: "Agreement Signed",
      cs: { phase: "Renewal", gov_type: "Government", domain: "x.gov.sa" },
      arr_value: 500_000,
    },
  ];
  const out = classifyClusterOverlap(deals, NOW);
  assert(out.verdict === "block", `expected block, got ${out.verdict}`);
  assert(out.lifecycle_state === "renewal", `wrong phase: ${out.lifecycle_state}`);
});

test("BLOCK: handoff Termination + within sector cool-off (private 100d)", () => {
  const churnDate = new Date(NOW);
  churnDate.setDate(churnDate.getDate() - 100); // 100 days ago < 180 cool-off
  const deals: ClusterDealInfo[] = [
    {
      stage: "Proposal",
      cs: { phase: null, gov_type: "Private", domain: "acme.com" },
      arr_value: 0,
    },
    {
      stage: "Paid",
      cs: {
        phase: "Termination",
        churn_date: churnDate,
        gov_type: "Private",
        domain: "acme.com",
      },
      arr_value: 200_000,
    },
  ];
  const out = classifyClusterOverlap(deals, NOW);
  assert(out.verdict === "block", `expected block within cool-off, got ${out.verdict}`);
});

test("WARN: handoff Termination + past sector cool-off (private 250d)", () => {
  const churnDate = new Date(NOW);
  churnDate.setDate(churnDate.getDate() - 250); // 250 days ago > 180 cool-off
  const deals: ClusterDealInfo[] = [
    {
      stage: "Proposal",
      cs: { phase: null, gov_type: "Private", domain: "acme.com" },
      arr_value: 0,
    },
    {
      stage: "Paid",
      cs: {
        phase: "Termination",
        churn_date: churnDate,
        gov_type: "Private",
        domain: "acme.com",
      },
      arr_value: 200_000,
    },
  ];
  const out = classifyClusterOverlap(deals, NOW);
  assert(out.verdict === "warn", `expected warn past cool-off, got ${out.verdict}`);
});

test("BLOCK: handoff Termination + government cool-off 300d (within 365)", () => {
  const churnDate = new Date(NOW);
  churnDate.setDate(churnDate.getDate() - 300); // 300 days ago < 365 gov cool-off
  const deals: ClusterDealInfo[] = [
    {
      stage: "Proposal",
      cs: { phase: null, gov_type: "Government", domain: "x.gov.sa" },
      arr_value: 0,
    },
    {
      stage: "Agreement Signed",
      cs: {
        phase: "Termination",
        churn_date: churnDate,
        gov_type: "Government",
        domain: "x.gov.sa",
      },
      arr_value: 600_000,
    },
  ];
  const out = classifyClusterOverlap(deals, NOW);
  assert(out.verdict === "block", `expected block within gov cool-off, got ${out.verdict}`);
});

test("null: only handoff Paid deal exists, no open sales deal", () => {
  const deals: ClusterDealInfo[] = [
    {
      stage: "Paid",
      cs: { phase: "Adoption", gov_type: "Private", domain: "acme.com" },
      arr_value: 1_000_000,
    },
  ];
  const out = classifyClusterOverlap(deals, NOW);
  assert(out.verdict === null, `expected null (no overlap), got ${out.verdict}`);
  assert(out.reason === "no_open_sales_deal", `wrong reason: ${out.reason}`);
});

test("null: only open sales deals, no handoff deal", () => {
  const deals: ClusterDealInfo[] = [
    {
      stage: "Proposal",
      cs: { phase: null, gov_type: "Private", domain: "acme.com" },
      arr_value: 0,
    },
    {
      stage: "Prepare Client",
      cs: { phase: null, gov_type: "Private", domain: "acme.com" },
      arr_value: 0,
    },
  ];
  const out = classifyClusterOverlap(deals, NOW);
  assert(out.verdict === null, `expected null, got ${out.verdict}`);
  assert(out.reason === "no_handoff_deal", `wrong reason: ${out.reason}`);
});

test("null: only Closed Lost deal (not handoff, not open)", () => {
  const deals: ClusterDealInfo[] = [
    {
      stage: "Closed Lost",
      cs: { phase: null, gov_type: "Private", domain: "acme.com" },
      arr_value: 0,
    },
  ];
  const out = classifyClusterOverlap(deals, NOW);
  assert(out.verdict === null, `expected null, got ${out.verdict}`);
});

test("BLOCK: handoff deal with no CS phase still blocks (conservative)", () => {
  const deals: ClusterDealInfo[] = [
    {
      stage: "Proposal",
      cs: { phase: null, gov_type: "Private", domain: "acme.com" },
      arr_value: 0,
    },
    {
      stage: "Paid",
      cs: { phase: null, gov_type: "Private", domain: "acme.com" },
      arr_value: 100_000,
    },
  ];
  const out = classifyClusterOverlap(deals, NOW);
  assert(out.verdict === "block", `expected block (conservative), got ${out.verdict}`);
  assert(out.reason === "overlap_unknown_cs_phase", `wrong reason: ${out.reason}`);
});

test("ARR exposure: sums BOTH open + handoff deal values", () => {
  const deals: ClusterDealInfo[] = [
    {
      stage: "Proposal",
      cs: { phase: null, gov_type: "Private", domain: "acme.com" },
      arr_value: 50_000,
    },
    {
      stage: "Paid",
      cs: { phase: "Adoption", gov_type: "Private", domain: "acme.com" },
      arr_value: 1_000_000,
    },
  ];
  const out = classifyClusterOverlap(deals, NOW);
  assert(out.arr_exposure === 1_050_000, `wrong ARR: ${out.arr_exposure}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
