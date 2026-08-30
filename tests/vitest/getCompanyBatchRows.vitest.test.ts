import { describe, it, expect, vi, beforeEach } from "vitest";
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../src/utils/redactedPool", () => ({
  createRedactedPool: () => ({ query: (...a: any[]) => query(...a), connect: async () => ({ query: (...a: any[]) => query(...a), release: () => {} }) }),
}));
vi.mock("../../src/utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import { getCompanyBatchRows } from "../../src/utils/duplicateRadarDatabase";
beforeEach(() => query.mockReset());

describe("getCompanyBatchRows", () => {
  it("selects names/counts/stages only and never raw_data", async () => {
    query.mockResolvedValue({ rows: [{ crm_name: "KPMG Saudi Arabia", record_type: "deal", n: 2, stages: ["Paid"] }] });
    const rows = await getCompanyBatchRows("walaplus");
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("duplicate_records");
    expect(sql).toContain("record_type");
    expect(sql).not.toContain("raw_data");
    expect(rows[0].crm_name).toBe("KPMG Saudi Arabia");
    expect(rows[0].n).toBe(2);
  });
});
