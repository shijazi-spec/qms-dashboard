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
    const sql = String(query.mock.calls[0][0]);
    const params = query.mock.calls[0][1];
    expect(sql).toContain("quality_report_bus");
    // 'marketplace' (derived from MP) must be among the bound params.
    expect(params).toContain("marketplace");
  });
});
