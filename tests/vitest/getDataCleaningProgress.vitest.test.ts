import { describe, it, expect, vi, beforeEach } from "vitest";

const query = vi.fn();
vi.mock("../../src/utils/database", () => ({ pool: { query: (...a: any[]) => query(...a) } }));

import { getDataCleaningProgress } from "../../src/utils/duplicateRadarDatabase";

beforeEach(() => query.mockReset());

describe("getDataCleaningProgress", () => {
  it("only counts action_type='resolve' and returns per-module modules", async () => {
    // Order of pool.query calls inside getDataCleaningProgress:
    // 1) last_sync_at  2) resolve rows  3) empty deleted  4) outstanding Deals  5) outstanding Accounts  6) trend series
    query
      .mockResolvedValueOnce({ rows: [{ last_sync_at: "2026-07-29T00:00:00Z" }] })
      .mockResolvedValueOnce({ rows: [
        { module: "Deals", survivor_present: true, layout: "Corporate", dup_count: 2 },
        { module: "Accounts", survivor_present: true, layout: "WalaOne", dup_count: 1 },
      ] })
      .mockResolvedValueOnce({ rows: [{ module: "Deals", n: "5" }, { module: "Accounts", n: "2" }] })
      .mockResolvedValueOnce({ rows: [{ n: "40" }] })
      .mockResolvedValueOnce({ rows: [{ n: "10" }] })
      .mockResolvedValueOnce({ rows: [] });

    const out = await getDataCleaningProgress("all");
    expect(out.modules.Deals.verified_merges).toBe(1);
    expect(out.modules.Deals.empty_deleted).toBe(5);
    expect(out.modules.Accounts.verified_merges).toBe(1);
    // The resolve-rows query must be gated to action_type='resolve'.
    const resolveSql = query.mock.calls[1][0] as string;
    expect(resolveSql).toContain("action_type = 'resolve'");
    expect(resolveSql).not.toContain("module_resolved");
  });
});
