/**
 * `kpi_values.calc_details` — the calculator's working, persisted alongside the
 * number it produced.
 *
 * Sample User 2026-08-18: the ad-hoc revenue KPI counts how many won deals were
 * dropped from the YTD window for want of a parseable Closing_Date, but
 * recordKPIValue stored only the value, so that exclusion was computed on every
 * recalc and thrown away. A KPI suppressed by a data gap looked identical to
 * one suppressed by poor sales.
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

import { recordKPIValue } from "../../src/utils/kpiDatabase";

const KPI = {
  id: 5,
  threshold_direction: "higher_is_better",
  threshold_green: 100,
  threshold_amber: 50,
  target_value: 100,
};

/** getKPIById → getLatestKPIValue → INSERT. */
function mockChain(latest: any = null) {
  query.mockReset();
  query
    .mockResolvedValueOnce({ rows: [KPI] })
    .mockResolvedValueOnce({ rows: latest ? [latest] : [] })
    .mockResolvedValueOnce({ rows: [{ id: 1 }] });
}

const insertCall = () =>
  query.mock.calls.find((c) => /INSERT INTO kpi_values/i.test(String(c[0])));

beforeEach(() => query.mockReset());

describe("calc_details is persisted with the value", () => {
  it("writes the details object as JSON", async () => {
    mockChain();
    await recordKPIValue({
      kpi_id: 5,
      period_start: new Date("2026-08-01"),
      period_end: new Date("2026-08-31"),
      actual_value: 16373892,
      calc_details: { window: "calendar YTD", won_deals_without_closing_date: 11 },
    } as any);
    const call = insertCall();
    expect(String(call![0])).toMatch(/calc_details/);
    const params = call![1] as any[];
    const stored = params.find((p) => typeof p === "string" && p.includes("won_deals_without_closing_date"));
    expect(stored, "details never reached the INSERT").toBeTruthy();
    expect(JSON.parse(stored)).toMatchObject({ won_deals_without_closing_date: 11 });
  });

  it("stores NULL — not the string \"undefined\" — when the caller has no details", async () => {
    mockChain();
    await recordKPIValue({
      kpi_id: 5,
      period_start: new Date("2026-08-01"),
      period_end: new Date("2026-08-31"),
      actual_value: 42,
    } as any);
    const params = insertCall()![1] as any[];
    // JSON.stringify(undefined) is undefined, which pg would send as NULL, but
    // an accidental String() somewhere would store the literal "undefined" and
    // the page would render a breakdown that says nothing.
    expect(params.at(-1)).toBeNull();
  });

  it("does not let a later manual entry erase an earlier auto breakdown", async () => {
    mockChain();
    await recordKPIValue({
      kpi_id: 5,
      period_start: new Date("2026-08-01"),
      period_end: new Date("2026-08-31"),
      actual_value: 42,
    } as any);
    const sql = String(insertCall()![0]);
    // Same (kpi_id, period) upsert path: a manual value carries no working, so
    // a blind EXCLUDED overwrite would blank the provenance for that period.
    expect(sql).toMatch(/calc_details = COALESCE\(EXCLUDED\.calc_details, kpi_values\.calc_details\)/);
  });
});
