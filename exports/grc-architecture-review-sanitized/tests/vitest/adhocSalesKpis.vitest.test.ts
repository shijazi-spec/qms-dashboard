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
 *  - revenue and ASP are calendar YTD on Closing_Date, because their targets
 *    are annual and the engine files every value under the current month --
 *    an all-time total read as a 3x beat when it was a since-inception figure;
 *  - pipeline is deliberately NOT windowed (point-in-time snapshot);
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
  won_ytd_count: 40,
  won_ytd_value: "41000000",
  won_ytd_with_amount: 32,
  won_all_count: 260,
  won_no_close_date: 11,
  open_count: 300,
  open_value: "<REDACTED_PHONE>",
  reached_meeting: 500,
  past_meeting: 180,
};

const lastSql = () => String(query.mock.calls.at(-1)?.[0] ?? "");

beforeEach(() => {
  resetAdhocSalesCache();
  query.mockReset().mockResolvedValue({ rows: [ROW] });
});

describe("scope of the single aggregate scan", () => {
  it("reads Deals only, restricted to the corporate (ExampleOrg) segment", async () => {
    await adhocSalesAggregates();
    const sql = lastSql();
    expect(sql).toMatch(/FROM duplicate_records r/);
    expect(sql).toMatch(/zoho_module = 'Deals'/);
    // The ExampleOrg branch of buildSegmentPredicate = NOT marketplace AND NOT
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

  it("windows revenue on Closing_Date, from the start of the calendar year to today", async () => {
    await adhocSalesAggregates();
    const sql = lastSql();
    expect(sql).toMatch(/Closing_Date/);
    expect(sql).toMatch(/date_trunc\('year', CURRENT_DATE\)/);
    // Upper bound matters as much as the lower one: a deal closing in November
    // is not year-TO-date revenue, and without this it would inflate the KPI.
    expect(sql).toMatch(/<= CURRENT_DATE/);
    // Shape-checked before the cast -- a junk Closing_Date must drop out of the
    // window, not abort the whole aggregate with an invalid-date error.
    expect(sql).toMatch(/~ '\^\[0-9\]\{4\}-\[0-9\]\{2\}-\[0-9\]\{2\}'/);
  });

  it("does NOT window the pipeline", async () => {
    await adhocSalesAggregates();
    const sql = lastSql();
    const openExpr = sql.split("AS open_value")[0].split("AS won_no_close_date")[1] ?? "";
    // Pipeline is what is open RIGHT NOW. Windowing it on Closing_Date would
    // silently drop every open deal whose expected close is next year.
    expect(openExpr).not.toMatch(/date_trunc/);
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
  it("sums the value of deals won this calendar year", async () => {
    const r = await calcAdhocSalesWonRevenue();
    expect(r.value).toBe(41000000);
    expect(r.dataAvailable).toBe(true);
    expect(r.details).toMatchObject({ won_deals_ytd: 40, segment: "ExampleOrg" });
  });

  it("surfaces the won deals that carry no usable Closing_Date", async () => {
    const r = await calcAdhocSalesWonRevenue();
    // Those deals sit in no year at all, so they are outside the window. If the
    // count grows, the KPI under-reports for a data reason -- it must be
    // visible on the detail page rather than swallowed.
    expect(r.details).toMatchObject({ won_deals_all_time: 260, won_deals_without_closing_date: 11 });
  });

  it("reports no data when nothing has been won this year", async () => {
    query.mockResolvedValue({ rows: [{ ...ROW, won_ytd_count: 0, won_ytd_value: "0" }] });
    // Not zero revenue -- "--" until the first win lands, so January does not
    // open with a fabricated SAR 0 against the annual target.
    expect((await calcAdhocSalesWonRevenue()).dataAvailable).toBe(false);
  });
});

describe("ADHOC-SALES-02 Qualified Pipeline", () => {
  it("sums the value of open deals", async () => {
    const r = await calcAdhocSalesQualifiedPipeline();
    expect(r.value).toBe(<REDACTED_PHONE>;
    expect(r.details).toMatchObject({ open_deals: 300 });
  });

  it("reports no data when the pipeline is empty", async () => {
    query.mockResolvedValue({ rows: [{ ...ROW, open_count: 0, open_value: "0" }] });
    expect((await calcAdhocSalesQualifiedPipeline()).dataAvailable).toBe(false);
  });
});

describe("ADHOC-SALES-03 Avg Deal Value (ASP)", () => {
  it("divides YTD won value by YTD won deals that CARRY an amount", async () => {
    const r = await calcAdhocSalesAvgDealValue();
    // 41,000,000 / 32 = 1,281,250 — dividing by all 40 YTD won deals would
    // report 1,025,000, i.e. an average dragged down by a blank Amount field.
    // Dividing by all 260 all-time wins would report 157,692 — a different KPI.
    expect(r.value).toBe(1281250);
    expect(r.details).toMatchObject({
      won_deals_ytd_with_amount: 32,
      won_deals_ytd_missing_amount: 8,
      window: "calendar YTD on Closing_Date",
    });
  });

  it("reports no data when no won deal this year carries an amount", async () => {
    query.mockResolvedValue({ rows: [{ ...ROW, won_ytd_with_amount: 0 }] });
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
