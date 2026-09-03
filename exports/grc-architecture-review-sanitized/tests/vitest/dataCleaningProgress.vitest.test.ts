import { describe, it, expect } from "vitest";
import { shapeCleaningProgress } from "../../src/utils/dataCleaningProgress";

const base = {
  generatedAt: "2026-07-30T00:00:00.000Z",
  lastSyncAt: "2026-07-29T00:00:00.000Z",
  emptyDeleted: { Deals: 5, Accounts: 2 },
  outstanding: { Deals: 40, Accounts: 10 },
  trend: { days: 30, segment: "ExampleOrg", series: [], first: null, latest: null },
};

describe("shapeCleaningProgress", () => {
  it("counts verified merges + est removed for the selected segment only", () => {
    const out = shapeCleaningProgress({
      ...base,
      segment: "ExampleOrg",
      resolveRows: [
        { module: "Deals", survivor_present: true, layout: "Corporate", dup_count: 2 },
        { module: "Deals", survivor_present: true, layout: "Doam Marketplace", dup_count: 3 }, // excluded (marketplace)
        { module: "Accounts", survivor_present: true, layout: "", dup_count: 1 },              // blank -> ExampleOrg
      ],
    });
    expect(out.modules.Deals.verified_merges).toBe(1);
    expect(out.modules.Deals.est_records_removed).toBe(2);
    expect(out.modules.Accounts.verified_merges).toBe(1);
    expect(out.modules.Accounts.est_records_removed).toBe(1);
    expect(out.modules.Deals.empty_deleted).toBe(5);
    expect(out.modules.Deals.outstanding).toBe(40);
  });

  it("segment 'all' counts every present row and routes survivor-missing to unknown", () => {
    const out = shapeCleaningProgress({
      ...base,
      segment: "all",
      resolveRows: [
        { module: "Deals", survivor_present: true, layout: "Corporate", dup_count: 2 },
        { module: "Deals", survivor_present: false, layout: null, dup_count: 4 }, // unknown
      ],
    });
    expect(out.modules.Deals.verified_merges).toBe(1);      // only the present row
    expect(out.unknown_segment.verified_merges).toBe(1);
    expect(out.unknown_segment.est_records_removed).toBe(4);
  });
});
