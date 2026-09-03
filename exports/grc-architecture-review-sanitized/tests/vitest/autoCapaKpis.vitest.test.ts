/**
 * Unit tests for the auto-CAPA KPI aggregator (pure rollup math).
 *
 * Run: npx vitest run tests/vitest/autoCapaKpis.vitest.test.ts
 *
 * Tests validate the rollupAutoCapaKpis function against hand-crafted
 * fixtures so the math is locked in independent of the database.
 */
import { describe, expect, test } from "vitest";
import { rollupAutoCapaKpis } from "../../src/utils/autoCapaKpis";

const NOW = new Date("2026-05-18T12:00:00Z");

function row(opts: {
  id: number;
  source_type?: string;
  status: string;
  created_days_ago: number;
  completion_days_ago?: number | null;
  target_days_from_created?: number | null;
}): any {
  const created = new Date(
    NOW.getTime() - opts.created_days_ago * 86400 * 1000,
  );
  const completion =
    opts.completion_days_ago == null
      ? null
      : new Date(NOW.getTime() - opts.completion_days_ago * 86400 * 1000);
  const target =
    opts.target_days_from_created == null
      ? null
      : new Date(
          created.getTime() +
            opts.target_days_from_created * 86400 * 1000,
        );
  return {
    id: opts.id,
    source_type: opts.source_type ?? "cs_overlap_block",
    status: opts.status,
    created_at: created.toISOString(),
    completion_date: completion ? completion.toISOString() : null,
    target_date: target ? target.toISOString() : null,
  };
}

describe("rollupAutoCapaKpis — empty input", () => {
  test("returns zeros / nulls", () => {
    const k = rollupAutoCapaKpis([], NOW);
    expect(k.open_count).toBe(0);
    expect(k.closed_last_30d).toBe(0);
    expect(k.avg_days_to_close).toBeNull();
    expect(k.median_days_to_close).toBeNull();
    expect(k.sla_hit_rate).toBeNull();
    expect(k.aging_buckets).toEqual({
      d0_3: 0,
      d4_7: 0,
      d8_14: 0,
      d15_plus: 0,
    });
  });
});

describe("open_count + aging buckets", () => {
  test("each bucket boundary", () => {
    const rows = [
      row({ id: 1, status: "open",           created_days_ago: 0 }),  // 0 → d0_3
      row({ id: 2, status: "investigation",  created_days_ago: 3 }),  // 3 → d0_3
      row({ id: 3, status: "open",           created_days_ago: 4 }),  // 4 → d4_7
      row({ id: 4, status: "action_plan",    created_days_ago: 7 }),  // 7 → d4_7
      row({ id: 5, status: "open",           created_days_ago: 8 }),  // 8 → d8_14
      row({ id: 6, status: "open",           created_days_ago: 14 }), // 14 → d8_14
      row({ id: 7, status: "open",           created_days_ago: 15 }), // 15 → d15_plus
      row({ id: 8, status: "open",           created_days_ago: 100 }),// 100 → d15_plus
    ];
    const k = rollupAutoCapaKpis(rows, NOW);
    expect(k.open_count).toBe(8);
    expect(k.aging_buckets).toEqual({
      d0_3: 2,
      d4_7: 2,
      d8_14: 2,
      d15_plus: 2,
    });
  });

  test("closed and cancelled are NOT in open_count or aging", () => {
    const rows = [
      row({ id: 1, status: "closed",    created_days_ago: 2, completion_days_ago: 1 }),
      row({ id: 2, status: "cancelled", created_days_ago: 5 }),
      row({ id: 3, status: "open",      created_days_ago: 1 }),
    ];
    const k = rollupAutoCapaKpis(rows, NOW);
    expect(k.open_count).toBe(1);
    expect(k.aging_buckets.d0_3).toBe(1);
  });
});

describe("closed_last_30d + durations", () => {
  test("only counts closures within 30 days", () => {
    const rows = [
      row({ id: 1, status: "closed", created_days_ago: 10, completion_days_ago: 5 }),  // closed 5d ago — in window
      row({ id: 2, status: "closed", created_days_ago: 50, completion_days_ago: 35 }), // closed 35d ago — out of window
      row({ id: 3, status: "closed", created_days_ago: 35, completion_days_ago: 29 }), // closed 29d ago — in window
    ];
    const k = rollupAutoCapaKpis(rows, NOW);
    expect(k.closed_last_30d).toBe(2);
  });

  test("avg + median days to close", () => {
    // Closed durations: 5, 10, 15 → avg 10, median 10
    const rows = [
      row({ id: 1, status: "closed", created_days_ago: 5,  completion_days_ago: 0 }),  // 5d
      row({ id: 2, status: "closed", created_days_ago: 10, completion_days_ago: 0 }),  // 10d
      row({ id: 3, status: "closed", created_days_ago: 15, completion_days_ago: 0 }),  // 15d
    ];
    const k = rollupAutoCapaKpis(rows, NOW);
    expect(k.closed_last_30d).toBe(3);
    expect(k.avg_days_to_close).toBeCloseTo(10);
    expect(k.median_days_to_close).toBeCloseTo(10);
  });

  test("median for even-count set", () => {
    const rows = [
      row({ id: 1, status: "closed", created_days_ago: 5,  completion_days_ago: 0 }),
      row({ id: 2, status: "closed", created_days_ago: 7,  completion_days_ago: 0 }),
      row({ id: 3, status: "closed", created_days_ago: 9,  completion_days_ago: 0 }),
      row({ id: 4, status: "closed", created_days_ago: 11, completion_days_ago: 0 }),
    ];
    const k = rollupAutoCapaKpis(rows, NOW);
    // Sorted: 5,7,9,11 → median = (7+9)/2 = 8
    expect(k.median_days_to_close).toBeCloseTo(8);
  });
});

describe("sla_hit_rate", () => {
  test("100% when every closure beat target", () => {
    const rows = [
      // Created 10d ago, target was 7d after creation (still 3d in the past),
      // completed 5d after creation → beat target.
      row({ id: 1, status: "closed", created_days_ago: 10, completion_days_ago: 5, target_days_from_created: 7 }),
      row({ id: 2, status: "closed", created_days_ago: 6,  completion_days_ago: 3, target_days_from_created: 4 }),
    ];
    const k = rollupAutoCapaKpis(rows, NOW);
    expect(k.sla_hit_rate).toBe(1);
  });

  test("0% when every closure missed target", () => {
    const rows = [
      // Created 20d ago, target 3d after creation (so target was 17d ago),
      // completed 1d ago → missed target.
      row({ id: 1, status: "closed", created_days_ago: 20, completion_days_ago: 1, target_days_from_created: 3 }),
    ];
    const k = rollupAutoCapaKpis(rows, NOW);
    expect(k.sla_hit_rate).toBe(0);
  });

  test("partial — 1 of 2 hit", () => {
    const rows = [
      row({ id: 1, status: "closed", created_days_ago: 10, completion_days_ago: 5, target_days_from_created: 7 }),  // hit
      row({ id: 2, status: "closed", created_days_ago: 20, completion_days_ago: 1, target_days_from_created: 3 }),  // miss
    ];
    const k = rollupAutoCapaKpis(rows, NOW);
    expect(k.sla_hit_rate).toBe(0.5);
  });

  test("null when no target_date on any row", () => {
    const rows = [
      row({ id: 1, status: "closed", created_days_ago: 5, completion_days_ago: 0 }),
    ];
    const k = rollupAutoCapaKpis(rows, NOW);
    expect(k.sla_hit_rate).toBeNull();
  });
});

describe("mixed real-world batch", () => {
  test("rolls up open + closed + aging together", () => {
    const rows = [
      // 4 currently-open at different ages
      row({ id: 1, status: "open",       created_days_ago: 1 }),
      row({ id: 2, status: "investigation", created_days_ago: 6 }),
      row({ id: 3, status: "open",       created_days_ago: 10 }),
      row({ id: 4, status: "open",       created_days_ago: 20 }),
      // 2 closed in window, hitting/missing target
      row({ id: 5, status: "closed", created_days_ago: 12, completion_days_ago: 5,  target_days_from_created: 7 }), // hit (closed 7d after, target 7d)
      row({ id: 6, status: "closed", created_days_ago: 4,  completion_days_ago: 1,  target_days_from_created: 2 }), // miss (closed 3d after, target 2d)
      // 1 cancelled, ignored
      row({ id: 7, status: "cancelled", created_days_ago: 30 }),
    ];
    const k = rollupAutoCapaKpis(rows, NOW);
    expect(k.open_count).toBe(4);
    expect(k.aging_buckets).toEqual({
      d0_3: 1,
      d4_7: 1,
      d8_14: 1,
      d15_plus: 1,
    });
    expect(k.closed_last_30d).toBe(2);
    expect(k.avg_days_to_close).toBeCloseTo(5); // (7 + 3) / 2
    expect(k.sla_hit_rate).toBe(0.5);
  });
});
