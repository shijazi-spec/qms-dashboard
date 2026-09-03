import { describe, it, expect, vi, beforeEach } from "vitest";

// Pool comes from redactedPool (createRedactedPool), NOT ./database. Use
// vi.hoisted so the hoisted vi.mock factory can reference the shared spy.
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../src/utils/redactedPool", () => ({
  createRedactedPool: () => ({
    query: (...a: any[]) => query(...a),
    connect: async () => ({ query: (...a: any[]) => query(...a), release: () => {} }),
  }),
}));
vi.mock("../../src/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getDataCleaningProgress } from "../../src/utils/duplicateRadarDatabase";

beforeEach(() => query.mockReset());

describe("getDataCleaningProgress", () => {
  it("fetches verified merges with action_type='resolve' ONLY (never tagged-not-deleted)", async () => {
    // Default every query to empty rows — the assertion is on WHICH SQL runs,
    // not on a fixed call order (getDataCleaningProgress nests other queries).
    query.mockResolvedValue({ rows: [] });

    await getDataCleaningProgress("all");

    const sqls = query.mock.calls.map((c) => String(c[0]));
    const resolveSql = sqls.find((s) => s.includes("duplicate_resolution_ledger"));
    expect(resolveSql, "a duplicate_resolution_ledger query should run").toBeTruthy();
    expect(resolveSql).toContain("action_type = 'resolve'");
    expect(resolveSql).not.toContain("module_resolved");
    expect(resolveSql).not.toContain("auto_merge_pending");
    // Empty-record deletions must be gated to verified deletions.
    const emptySql = sqls.find((s) => s.includes("empty_delete_ledger"));
    expect(emptySql).toContain("status = 'deleted'");
  });
});
