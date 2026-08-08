import { describe, it, expect, vi, beforeEach } from "vitest";
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../src/utils/redactedPool", () => ({
  createRedactedPool: () => ({ query: (...a: any[]) => query(...a), connect: async () => ({ query: (...a: any[]) => query(...a), release: () => {} }) }),
}));
vi.mock("../../src/utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import { getSegmentDealComplianceSummary, getSegmentDealDuplicateCount } from "../../src/utils/duplicateRadarDatabase";
beforeEach(() => query.mockReset());

describe("getSegmentDealComplianceSummary", () => {
  it("joins deal_doc_compliance to duplicate_records and computes rate", async () => {
    query.mockResolvedValue({ rows: [{ checked: 10, compliant: 7 }] });
    const out = await getSegmentDealComplianceSummary("walaplus");
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("deal_doc_compliance");
    expect(sql).toContain("duplicate_records");
    expect(sql).toContain("compliant");
    expect(out.checked).toBe(10);
    expect(out.compliant).toBe(7);
    expect(out.compliant_rate).toBe(70);
  });
  it("rate is null when nothing checked", async () => {
    query.mockResolvedValue({ rows: [{ checked: 0, compliant: 0 }] });
    const out = await getSegmentDealComplianceSummary("walaone");
    expect(out.checked).toBe(0);
    expect(out.compliant_rate).toBeNull();
  });
});
describe("getSegmentDealDuplicateCount", () => {
  it("counts non-primary deal members of active >1 clusters", async () => {
    query.mockResolvedValue({ rows: [{ n: "12" }] });
    const out = await getSegmentDealDuplicateCount("walaplus");
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("record_type = 'deal'");
    expect(sql).toContain("total_deals > 1");
    expect(out.outstanding_deals).toBe(12);
  });
});
