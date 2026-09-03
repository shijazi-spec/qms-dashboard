/**
 * SALES-KPI-03 (Proposal Cycle Time) and SALES-KPI-04 (Agreement Cycle Time),
 * computed LOCALLY.
 *
 * These were previously reachable only through CRMProvider's per-deal Stage_History —
 * up to 40 sequential API calls, which is why they were excluded from the
 * interactive recalculate. That path does not work in this tenant: verified
 * live 2026-08-17, a full cycle-times run completed and reported "no synced
 * source data" for both, and /api/CRMProvider/deals/:id/stage-aging returns
 * source:"created", meaning no usable Stage_Duration came back.
 *
 * The local versions use `modified_date` as the stage-entry proxy — the same
 * proxy the Deal Stage Aging engine already uses platform-wide.
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
  calcSalesProposalCycleTime,
  calcSalesAgreementCycleTime,
} from "../../src/utils/kpiProcessCalc";

const lastCall = () => query.mock.calls.at(-1);

beforeEach(() => query.mockReset());

describe("SALES-KPI-03 Proposal Cycle Time (local)", () => {
  it("averages dwell days for deals currently in Proposal", async () => {
    query.mockResolvedValue({ rows: [{ deals: 12, avg_days: 41.27 }] });
    const r = await calcSalesProposalCycleTime();
    expect(r.value).toBe(41.3);
    expect(r.details).toMatchObject({ deals_in_stage: 12 });
    expect(String(lastCall()?.[1]?.[0])).toBe("%proposal%");
  });

  it("reads Deals only, with the stage-entry proxy", async () => {
    query.mockResolvedValue({ rows: [{ deals: 1, avg_days: 5 }] });
    await calcSalesProposalCycleTime();
    const sql = String(lastCall()?.[0]);
    expect(sql).toMatch(/CRMProvider_module = 'Deals'/);
    expect(sql).toMatch(/modified_date/);
    // Must NOT reach CRMProvider — that is the whole point of the local versions.
    expect(sql).not.toMatch(/Stage_History/i);
  });

  it("reports no data when nothing is in the stage", async () => {
    query.mockResolvedValue({ rows: [{ deals: 0, avg_days: null }] });
    expect((await calcSalesProposalCycleTime()).dataAvailable).toBe(false);
  });
});

describe("SALES-KPI-04 Agreement Cycle Time (local)", () => {
  it("matches 'agreement sent' specifically, NOT 'agreement signed'", async () => {
    query.mockResolvedValue({ rows: [{ deals: 4, avg_days: 20 }] });
    await calcSalesAgreementCycleTime();
    // "Agreement Signed" is terminal — averaging a won deal's age in would
    // inflate the cycle time with deals that already closed.
    expect(String(lastCall()?.[1]?.[0])).toBe("%agreement sent%");
  });

  it("averages dwell days and rounds to one decimal", async () => {
    query.mockResolvedValue({ rows: [{ deals: 4, avg_days: 19.94 }] });
    const r = await calcSalesAgreementCycleTime();
    expect(r.value).toBe(19.9);
  });

  it("reports no data on a null average", async () => {
    query.mockResolvedValue({ rows: [{ deals: 3, avg_days: null }] });
    expect((await calcSalesAgreementCycleTime()).dataAvailable).toBe(false);
  });
});
