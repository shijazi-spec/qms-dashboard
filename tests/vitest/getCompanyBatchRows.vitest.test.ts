import { describe, it, expect, vi, beforeEach } from "vitest";
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../src/utils/redactedPool", () => ({
  createRedactedPool: () => ({ query: (...a: any[]) => query(...a), connect: async () => ({ query: (...a: any[]) => query(...a), release: () => {} }) }),
}));
vi.mock("../../src/utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import { getCompanyBatchRows } from "../../src/utils/duplicateRadarDatabase";
beforeEach(() => query.mockReset());

describe("getCompanyBatchRows", () => {
  it("selects names/counts/stages only and never projects raw_data", async () => {
    query.mockResolvedValue({ rows: [{ crm_name: "KPMG Saudi Arabia", record_type: "deal", n: 2, stages: ["Paid"] }] });
    // segment "all" => buildSegmentPredicate returns no condition, so the SQL is
    // purely our own projection and the raw_data check is meaningful here.
    const rows = await getCompanyBatchRows("all");
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("duplicate_records");
    expect(sql).toContain("record_type");
    expect(sql).not.toContain("raw_data");
    expect(rows[0].crm_name).toBe("KPMG Saudi Arabia");
    expect(rows[0].n).toBe(2);
  });

  it("applies the segment predicate for a specific segment", async () => {
    query.mockResolvedValue({ rows: [] });
    await getCompanyBatchRows("walaplus");
    const sql = String(query.mock.calls[0][0]);
    // The predicate's layout expression is appended. It legitimately references
    // raw_data as the fallback when layout_name is blank, so assert the
    // predicate landed rather than re-checking for raw_data here.
    expect(sql).toContain("layout_name");
  });

  it("maps a NULL stages aggregate to an empty array", async () => {
    query.mockResolvedValue({ rows: [{ crm_name: "Acme", record_type: "account", n: 1, stages: null }] });
    const rows = await getCompanyBatchRows("all");
    expect(rows[0].stages).toEqual([]);
  });
});
