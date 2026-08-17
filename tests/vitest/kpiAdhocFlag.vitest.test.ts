/**
 * The manager-tagged `is_adhoc` flag.
 *
 * Sarah 2026-08-17 chose a per-KPI tag over deriving ad-hoc status from
 * calc_mode, specifically so it can be applied RETROACTIVELY to KPIs that
 * already exist. That rules out any creation-time-only marker.
 *
 * The distinction matters: calc_mode says how a value is PRODUCED (auto /
 * checklist / manual), is_adhoc says why the KPI EXISTS. A permanent catalog
 * KPI can be manually entered, and an ad-hoc one can later be automated —
 * splitting the BU page's boxes on calc_mode would shuffle KPIs between them
 * for reasons unrelated to the split.
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
  updateKPIDefinition,
  getKPIsWithValuesByOwnerName,
} from "../../src/utils/kpiDatabase";

beforeEach(() => query.mockReset().mockResolvedValue({ rows: [] }));

describe("is_adhoc is editable per KPI", () => {
  it("passes through updateKPIDefinition so it can be tagged retroactively", async () => {
    query.mockResolvedValue({ rows: [{ id: 7, is_adhoc: true }] });
    await updateKPIDefinition(7, { is_adhoc: true } as any);
    const call = query.mock.calls.find((c) => /UPDATE kpi_definitions/i.test(String(c[0])));
    expect(call, "no UPDATE issued").toBeTruthy();
    expect(String(call![0])).toMatch(/is_adhoc = \$/);
    expect((call![1] as any[]).includes(true)).toBe(true);
  });

  it("can be cleared again, not just set", async () => {
    query.mockResolvedValue({ rows: [{ id: 7, is_adhoc: false }] });
    await updateKPIDefinition(7, { is_adhoc: false } as any);
    const call = query.mock.calls.find((c) => /UPDATE kpi_definitions/i.test(String(c[0])));
    // `false` is falsy — an `if (value)` guard in the field loop would silently
    // drop it and make the tag one-way.
    expect(String(call![0])).toMatch(/is_adhoc = \$/);
    expect((call![1] as any[]).includes(false)).toBe(true);
  });

  it("is NOT touched when the caller does not mention it", async () => {
    query.mockResolvedValue({ rows: [{ id: 7 }] });
    await updateKPIDefinition(7, { kpi_name: "Renamed" } as any);
    const call = query.mock.calls.find((c) => /UPDATE kpi_definitions/i.test(String(c[0])));
    expect(String(call![0])).not.toMatch(/is_adhoc/);
  });
});

describe("is_adhoc reaches the BU page", () => {
  it("is carried on each catalog row so the page can split the boxes", async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          { id: 1, kpi_code: "SDR-KPI-01", kpi_name: "Calls", unit: "%", target_value: 40, threshold_direction: "higher_is_better", calc_mode: "auto", is_adhoc: false },
          { id: 2, kpi_code: "ADHOC-01", kpi_name: "One-off", unit: "%", target_value: 50, threshold_direction: "higher_is_better", calc_mode: "manual", is_adhoc: true },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const out = await getKPIsWithValuesByOwnerName("SDR Team");
    expect(out.map((k) => k.is_adhoc)).toEqual([false, true]);
  });

  it("defaults to false when the column is null on an older row", async () => {
    query
      .mockResolvedValueOnce({
        rows: [{ id: 3, kpi_code: "X-1", kpi_name: "Legacy", unit: "%", target_value: 1, threshold_direction: "higher_is_better", calc_mode: "manual", is_adhoc: null }],
      })
      .mockResolvedValueOnce({ rows: [] });
    const out = await getKPIsWithValuesByOwnerName("SDR Team");
    // Null must read as "catalog", not as ad-hoc — otherwise every pre-existing
    // KPI would jump into the ad-hoc box the moment the column was added.
    expect(out[0].is_adhoc).toBe(false);
  });
});
