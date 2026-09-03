import { describe, it, expect, vi, beforeEach } from "vitest";
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../src/utils/redactedPool", () => ({
  createRedactedPool: () => ({ query: (...a: any[]) => query(...a), connect: async () => ({ query: (...a: any[]) => query(...a), release: () => {} }) }),
}));
vi.mock("../../src/utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import { upsertBU } from "../../src/utils/qualityReportsDepartments";
beforeEach(() => query.mockReset());

describe("upsertBU", () => {
  it("derives segment from channel and never trusts a caller-supplied segment", async () => {
    query.mockResolvedValue({ rows: [{ id: 1, bu_key: "x", bu_name: "X", channel: "MP", segment: "marketplace", fn: "partnership", sort_order: 0, is_active: true }] });
    await upsertBU({ bu_key: "x", bu_name: "X", channel: "MP", fn: "partnership" });
    const upsertCall = query.mock.calls.find((c) => String(c[0]).includes("ON CONFLICT (bu_key) DO UPDATE"));
    expect(upsertCall, "upsert INSERT should have run").toBeTruthy();
    const sql = String(upsertCall![0]);
    const params = upsertCall![1] as any[];
    expect(sql).toContain("quality_report_bus");
    // 'marketplace' (derived from MP) must be among the bound params.
    expect(params).toContain("marketplace");
  });
});
