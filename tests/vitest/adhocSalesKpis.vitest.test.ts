/**
 * The four ad-hoc Sales KPIs, now computed by QMS instead of typed in:
 *   ADHOC-SALES-01 Closed-Won Revenue
 *   ADHOC-SALES-02 Qualified Pipeline
 *   ADHOC-SALES-03 Avg Deal Value (ASP)
 *   ADHOC-SALES-04 Meeting Conversion
 *
 * Every assertion here guards a scope decision that is invisible in the
 * resulting number, so a regression would look like a plausible figure rather
 * than a failure:
 *  - corporate-only (Marketplace partner deals must not enter either total);
 *  - won and open are DISJOINT, so a "Signed" deal is revenue OR pipeline,
 *    never both;
 *  - ASP divides by won deals that carry an Amount, not by all won deals;
 *  - one DB scan feeds all four, so ASP can never contradict revenue.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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

import {
  adhocSalesAggregates,
  resetAdhocSalesCache,
  calcAdhocSalesWonRevenue,
  calcAdhocSalesQualifiedPipeline,
  calcAdhocSalesAvgDealValue,
  calcAdhocSalesMeetingConversion,
  PROCESS_CALCULATORS,
} from "../../src/utils/kpiProcessCalc";

const ROW = {
  won_count: 40,
  won_value: "41000000",
  won_with_amount: 32,
  open_count: 300,
  open_value: "168000000",
  reached_meeting: 500,
  past_meeting: 180,
};

const lastSql = () => String(query.mock.calls.at(-1)?.[0] ?? "");

beforeEach(() => {
  resetAdhocSalesCache();
  query.mockReset().mockResolvedValue({ rows: [ROW] });
});

describe("scope of the single aggregate scan", () => {
  it("reads Deals only, restricted to the corporate (WalaPlus) segment", async () => {
    await adhocSalesAggregates();
    const sql = lastSql();
    expect(sql).toMatch(/FROM duplicate_records r/);
    expect(sql).toMatch(/zoho_module = 'Deals'/);
    // The WalaPlus branch of buildSegmentPredicate = NOT marketplace AND NOT
    // WalaOne. Without it, "Partner Active" / "Welcome Communications" records
    // land in the Sales team's revenue and pipeline.
    expect(sql).toMatch(/walaone/);
    expect(sql).toMatch(/layout/i);
    const params = query.mock.calls.at(-1)?.[1] as any[];
    expect(params.some((p) => String(p).includes("marketplace"))).toBe(true);
  });

  it("keeps won and open disjoint", async () => {
    await adhocSalesAggregates();
    const sql = lastSql();
    // openStagePredicate excludes only 'agreement signed'/'paid' by name, so the
    // plain "Signed" stage reads as OPEN there. Without this subtraction those
    // deals are billed as revenue AND as pipeline.
    expect(sql).toMatch(/AND NOT \(/);
    expect(sql).toMatch(/signed\|paid\|closed won/);
  });

  it("runs ONE query for all four KPIs", async () => {
    await calcAdhocSalesWonRevenue();
    await calcAdhocSalesQualifiedPipeline();
    await calcAdhocSalesAvgDealValue();
    await calcAdhocSalesMeetingConversion();
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe("ADHOC-SALES-01 Closed-Won Revenue", () => {
  it("sums the value of won deals", async () => {
    const r = await calcAdhocSalesWonRevenue();
    expect(r.value).toBe(41000000);
    expect(r.dataAvailable).toBe(true);
    expect(r.details).toMatchObject({ won_deals: 40, segment: "walaplus" });
  });

  it("reports no data when nothing has been won", async () => {
    query.mockResolvedValue({ rows: [{ ...ROW, won_count: 0, won_value: "0" }] });
    expect((await calcAdhocSalesWonRevenue()).dataAvailable).toBe(false);
  });
});

describe("ADHOC-SALES-02 Qualified Pipeline", () => {
  it("sums the value of open deals", async () => {
    const r = await calcAdhocSalesQualifiedPipeline();
    expect(r.value).toBe(168000000);
    expect(r.details).toMatchObject({ open_deals: 300 });
  });

  it("reports no data when the pipeline is empty", async () => {
    query.mockResolvedValue({ rows: [{ ...ROW, open_count: 0, open_value: "0" }] });
    expect((await calcAdhocSalesQualifiedPipeline()).dataAvailable).toBe(false);
  });
});

describe("ADHOC-SALES-03 Avg Deal Value (ASP)", () => {
  it("divides won value by won deals that CARRY an amount", async () => {
    const r = await calcAdhocSalesAvgDealValue();
    // 41,000,000 / 32 = 1,281,250 — dividing by all 40 won deals would report
    // 1,025,000, i.e. an average dragged down by a blank Amount field.
    expect(r.value).toBe(1281250);
    expect(r.details).toMatchObject({ won_deals_with_amount: 32, won_deals_missing_amount: 8 });
  });

  it("reports no data when no won deal carries an amount", async () => {
    query.mockResolvedValue({ rows: [{ ...ROW, won_with_amount: 0 }] });
    const r = await calcAdhocSalesAvgDealValue();
    // Never divide by zero into Infinity/NaN and record it as a value.
    expect(r.dataAvailable).toBe(false);
  });
});

describe("ADHOC-SALES-04 Meeting Conversion", () => {
  it("is deals past the meeting ÷ deals that reached it", async () => {
    const r = await calcAdhocSalesMeetingConversion();
    expect(r.value).toBe(36); // 180/500
    expect(r.details).toMatchObject({ reached_meeting: 500, past_meeting: 180 });
  });

  it("counts On Hold as reached-but-not-converted", async () => {
    await adhocSalesAggregates();
    const sql = lastSql();
    const reached = sql.match(/AS reached_meeting/) ? sql.split("AS reached_meeting")[0] : "";
    const past = sql.split("AS reached_meeting")[1]?.split("AS past_meeting")[0] ?? "";
    expect(reached).toMatch(/on hold/);
    // A deal parked On Hold has not advanced past the meeting — if it appeared
    // in the numerator too, the KPI could only ever go up.
    expect(past).not.toMatch(/on hold/);
  });

  it("reports no data when no deal has reached a meeting", async () => {
    query.mockResolvedValue({ rows: [{ ...ROW, reached_meeting: 0 }] });
    expect((await calcAdhocSalesMeetingConversion()).dataAvailable).toBe(false);
  });
});

describe("wiring", () => {
  it("registers all four codes so the daily recalc records them", async () => {
    for (const code of ["ADHOC-SALES-01", "ADHOC-SALES-02", "ADHOC-SALES-03", "ADHOC-SALES-04"]) {
      expect(PROCESS_CALCULATORS[code], `${code} not registered`).toBeTypeOf("function");
    }
  });
});
