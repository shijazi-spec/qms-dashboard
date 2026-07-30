import { describe, it, expect, vi, beforeEach } from "vitest";
const query = vi.fn();
vi.mock("../../src/utils/database", () => ({ pool: { query: (...a: any[]) => query(...a) } }));
import { getDuplicateProgressSeries } from "../../src/utils/duplicateRadarDatabase";
beforeEach(() => query.mockReset());

describe("getDuplicateProgressSeries segment", () => {
  it("filters by the given segment", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ n: "1" }] })         // today exists
      .mockResolvedValueOnce({ rows: [] });                   // series
    await getDuplicateProgressSeries(30, "walaplus");
    const seriesSql = query.mock.calls[1][0] as string;
    const seriesParams = query.mock.calls[1][1] as any[];
    expect(seriesSql).toContain("segment = ");
    expect(seriesParams).toContain("walaplus");
  });
});
