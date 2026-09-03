import { describe, it, expect, vi, beforeEach } from "vitest";
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../src/utils/redactedPool", () => ({
  createRedactedPool: () => ({ query: (...a: any[]) => query(...a), connect: async () => ({ query: (...a: any[]) => query(...a), release: () => {} }) }),
}));
vi.mock("../../src/utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import { getSegmentDealComplianceSummary } from "../../src/utils/duplicateRadarDatabase";
beforeEach(() => query.mockReset());

describe("getSegmentDealComplianceSummary (expanded)", () => {
  it("fetches per-deal rows and returns the full breakdown", async () => {
    query.mockResolvedValue({ rows: [
      { stage: "Agreement Signed", compliant: false, amount: 100, owner: "Sample User", missing_docs: [{ label: "VAT Certificate" }] },
      { stage: "Agreement Signed", compliant: true, amount: 50, owner: "Sample User", missing_docs: [] },
    ] });
    const out = await getSegmentDealComplianceSummary("ExampleOrg");
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("deal_doc_compliance");
    expect(sql).toContain("duplicate_records");
    expect(sql).toContain("missing_docs");
    expect(out.checked).toBe(2);
    expect(out.at_risk_sar).toBe(100);
    expect(out.compliant_rate).toBe(50);
    expect(Array.isArray(out.by_owner)).toBe(true);
    expect(Array.isArray(out.by_stage)).toBe(true);
  });
});
