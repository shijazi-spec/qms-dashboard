/**
 * The "What's inside & gaps" fallback.
 *
 * KPIs with no bespoke insight (the ad-hoc Sales four, and every SDR/Sales
 * process KPI) rendered a heading promising gaps followed by "No live breakdown
 * for this KPI type". They now get a gap-to-target view built from the STORED
 * value — never by re-running the calculator, because a detail-page render must
 * not trigger a 22k-row scan and must agree with the number printed above it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { getKPIByCode, getLatestKPIValue } = vi.hoisted(() => ({
  getKPIByCode: vi.fn(),
  getLatestKPIValue: vi.fn(),
}));

vi.mock("../../src/utils/kpiDatabase", () => ({ getKPIByCode, getLatestKPIValue }));
vi.mock("../../src/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getKpiInsight } from "../../src/utils/kpiInsight";

const REVENUE = {
  id: 16863,
  kpi_code: "ADHOC-SALES-01",
  unit: "SAR",
  target_value: 41000000,
  threshold_direction: "higher_is_better",
};

beforeEach(() => {
  getKPIByCode.mockReset().mockResolvedValue(REVENUE);
  getLatestKPIValue.mockReset().mockResolvedValue({
    actual_value: "16373892.00",
    period_end: "2026-08-31T00:00:00.000Z",
  });
});

describe("gap to target", () => {
  it("states the shortfall in the KPI's own unit", async () => {
    const i = await getKpiInsight("ADHOC-SALES-01");
    expect(i.kind).toBe("auto");
    expect(i.data_available).toBe(true);
    // 41M - 16,373,892 = 24,626,108, shown the way the BI portal shows money.
    expect(i.details).toMatchObject({
      target: "SAR 41M",
      gap_to_target: "SAR 24.6M",
      attainment_of_target: "39.9%",
      measured_period_ending: "2026-08-31",
    });
  });

  it("never re-runs the calculator", async () => {
    const proc = await import("../../src/utils/kpiProcessCalc");
    const spy = vi.spyOn(proc, "adhocSalesAggregates");
    await getKpiInsight("ADHOC-SALES-01");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("flips the wording when the KPI is ahead", async () => {
    getLatestKPIValue.mockResolvedValue({ actual_value: 45000000, period_end: "2026-08-31" });
    const d: any = (await getKpiInsight("ADHOC-SALES-01")).details;
    expect(d.ahead_of_target_by).toBe("SAR 4M");
    expect(d.gap_to_target).toBeUndefined();
  });

  it("measures the gap the other way for lower-is-better KPIs", async () => {
    getKPIByCode.mockResolvedValue({
      id: 73, kpi_code: "SALES-KPI-03", unit: "days", target_value: 7,
      threshold_direction: "lower_is_better",
    });
    getLatestKPIValue.mockResolvedValue({ actual_value: 99.1, period_end: "2026-08-31" });
    const d: any = (await getKpiInsight("SALES-KPI-03")).details;
    // 99.1 days against a 7-day target is 92.1 days TOO SLOW. Using the
    // higher-is-better subtraction would report it as 92.1 days ahead.
    expect(d.gap_to_target).toBe("92.1 days");
  });
});

describe("cases that must not invent a comparison", () => {
  it("quotes pace only for the cumulative KPI", async () => {
    const rev: any = (await getKpiInsight("ADHOC-SALES-01")).details;
    expect(rev.pace).toBeTypeOf("string");

    // ASP is an average and Qualified Pipeline is a point-in-time snapshot —
    // neither accumulates over the year, so "x% of target vs y% of the year" is
    // a meaningless comparison for them.
    getKPIByCode.mockResolvedValue({
      id: 16864, kpi_code: "ADHOC-SALES-03", unit: "SAR", target_value: 170000,
      threshold_direction: "higher_is_better",
    });
    getLatestKPIValue.mockResolvedValue({ actual_value: 297707, period_end: "2026-08-31" });
    const asp: any = (await getKpiInsight("ADHOC-SALES-03")).details;
    expect(asp.pace).toBeUndefined();
    expect(asp.ahead_of_target_by).toBe("SAR 128K");
  });

  it("falls back to the empty panel when the KPI has no target", async () => {
    getKPIByCode.mockResolvedValue({ ...REVENUE, target_value: null });
    expect((await getKpiInsight("ADHOC-SALES-01")).kind).toBe("none");
  });

  it("says it has not been calculated rather than showing a gap of zero", async () => {
    getLatestKPIValue.mockResolvedValue(null);
    const i = await getKpiInsight("ADHOC-SALES-01");
    expect(i.data_available).toBe(false);
    expect(i.details).toBeUndefined();
  });

  it("does not hijack KPIs that have their own insight", async () => {
    // QM-KPI-015 is a checklist KPI — it must keep its own breakdown path and
    // never fall through to the generic gap view, which would replace a per-BU
    // completion list with a single "gap to target" line.
    const i: any = await getKpiInsight("QM-KPI-015").catch(() => null);
    expect(i?.kind).not.toBe("auto");
    expect(i?.details?.gap_to_target).toBeUndefined();
    expect(i?.details?.target).toBeUndefined();
  });
});
