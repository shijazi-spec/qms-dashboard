import { describe, it, expect, vi, beforeEach } from "vitest";
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../src/utils/redactedPool", () => ({
  createRedactedPool: () => ({ query: (...a: any[]) => query(...a), connect: async () => ({ query: (...a: any[]) => query(...a), release: () => {} }) }),
}));
vi.mock("../../src/utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import { getSegmentDealDuplicateCount } from "../../src/utils/duplicateRadarDatabase";
beforeEach(() => query.mockReset());

describe("getSegmentDealDuplicateCount", () => {
  it("counts non-primary deal members of active >1 clusters", async () => {
    query.mockResolvedValue({ rows: [{ n: "12" }] });
    const out = await getSegmentDealDuplicateCount("ExampleOrg");
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("record_type = 'deal'");
    expect(sql).toContain("total_deals > 1");
    expect(out.outstanding_deals).toBe(12);
  });
});
