/**
 * Unit tests for the calls health metrics. All queries exercised via
 * a mock pool — pure aggregate logic, no DB.
 *
 * Run: npx vitest run tests/vitest/callsHealthMetrics.vitest.test.ts
 */
import { afterEach, describe, expect, test } from "vitest";
import {
  fetchAllCallsHealthMetrics,
  fetchCrmLinkage,
  fetchPipelineYield,
} from "../../src/utils/callsHealthMetrics";
import { _resetCostGuardForTests } from "../../src/utils/aiCostGuard";

afterEach(() => {
  _resetCostGuardForTests();
});

/** Build a pool that returns a sequence of canned results. */
function mockPool(...batches: any[][]) {
  let i = 0;
  return {
    query: async () => {
      const rows = batches[i] || [];
      i++;
      return { rows };
    },
  };
}

describe("fetchPipelineYield", () => {
  test("computes yield_pct from counts", async () => {
    const pool = mockPool([
      { total_calls: 100, analyzed: 95, pending: 3, analysis_failed: 2 },
    ]);
    const r = await fetchPipelineYield(pool);
    expect(r.total_calls).toBe(100);
    expect(r.analyzed).toBe(95);
    expect(r.yield_pct).toBe(95);
  });

  test("yield_pct is 0 when total is 0 (no divide-by-zero)", async () => {
    const pool = mockPool([{ total_calls: 0, analyzed: 0, pending: 0, analysis_failed: 0 }]);
    const r = await fetchPipelineYield(pool);
    expect(r.yield_pct).toBe(0);
  });

  test("handles missing row (returns zeros)", async () => {
    const pool = mockPool([]);
    const r = await fetchPipelineYield(pool);
    expect(r.total_calls).toBe(0);
    expect(r.yield_pct).toBe(0);
  });
});

describe("fetchCrmLinkage", () => {
  test("computes linkage_pct + by_linked_via breakdown", async () => {
    const pool = mockPool(
      [{ total: 50, linked: 40 }],
      [
        { bucket: "phone_match", n: 30 },
        { bucket: "activity_fallback", n: 10 },
      ],
    );
    const r = await fetchCrmLinkage(pool);
    expect(r.linked).toBe(40);
    expect(r.unlinked).toBe(10);
    expect(r.linkage_pct).toBe(80);
    expect(r.by_linked_via).toEqual({ phone_match: 30, activity_fallback: 10 });
  });

  test("handles zero-total without divide-by-zero", async () => {
    const pool = mockPool([{ total: 0, linked: 0 }], []);
    const r = await fetchCrmLinkage(pool);
    expect(r.linkage_pct).toBe(0);
  });
});

describe("fetchAllCallsHealthMetrics (integration with mock pool)", () => {
  test("returns the full shape with all sections", async () => {
    // 6 queries in fetchAll, in order: yield, linkage_total, linkage_breakdown,
    // review_evals, review_status, ingest_mix, coaching, failures
    // The exact ordering depends on Promise.all scheduling. To keep the test
    // deterministic, mock every query to return empty rows — we're testing
    // the SHAPE, not the values, here.
    const pool = mockPool(
      [], [], [], [], [], [], [], [], [],
    );
    const r = await fetchAllCallsHealthMetrics(pool);
    expect(r.generated_at).toBeTruthy();
    expect(r.pipeline_yield).toBeDefined();
    expect(r.crm_linkage).toBeDefined();
    expect(r.manager_review).toBeDefined();
    expect(r.ingest_mix).toBeDefined();
    expect(r.coaching).toBeDefined();
    expect(r.cost).toBeDefined();
    expect(Array.isArray(r.recent_failures)).toBe(true);
  });

  test("degrades gracefully when a query throws", async () => {
    const failing = {
      query: async () => {
        throw new Error("boom");
      },
    };
    const r = await fetchAllCallsHealthMetrics(failing);
    // Every section should still be present with zero values
    expect(r.pipeline_yield.total_calls).toBe(0);
    expect(r.crm_linkage.linked).toBe(0);
    expect(r.manager_review.evaluations).toBe(0);
    expect(r.ingest_mix.by_source).toEqual({});
    expect(r.coaching.delivered_30d).toBe(0);
    expect(r.recent_failures).toEqual([]);
  });

  test("includes cost snapshot with cap_enforced=false when flag off", async () => {
    const pool = mockPool([], [], [], [], [], [], [], [], []);
    const r = await fetchAllCallsHealthMetrics(pool);
    expect(r.cost.cap_enforced).toBe(false);
    expect(r.cost.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
