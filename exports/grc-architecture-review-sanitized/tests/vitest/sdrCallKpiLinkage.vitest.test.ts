/**
 * SDR-KPI-01 (Calls Per Day) and SDR-KPI-02 (Contact Rate) linkage scope.
 *
 * THE REGRESSION THIS LOCKS IN: both used to require `lead_id IS NOT NULL`.
 * Neither KPI's definition asks for that — 01 is "total outbound calls per
 * working day per SDR agent", 02 is "percentage of calls that result in a live
 * conversation". Measured on the live mirror 2026-08-17, right after the first
 * successful Zoho Calls import: of 236 calls, 200 were linked to a DEAL and
 * exactly 1 to a Lead. The lead-only filter discarded 85% of the corpus and
 * left both KPIs permanently "--".
 *
 * SDR-KPI-06 is intentionally excluded from the broadening: "Average Speed to
 * Lead" measures lead-creation to first contact, so lead linkage is intrinsic.
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
  calcSdrCallsPerDay,
  calcSdrContactRate,
  calcSdrSpeedToLead,
} from "../../src/utils/kpiProcessCalc";

const lastSql = () => String(query.mock.calls.at(-1)?.[0] ?? "");

beforeEach(() => query.mockReset());

describe("SDR call KPIs — CRM linkage scope", () => {
  it("SDR-KPI-01 counts calls linked to a lead OR a deal", async () => {
    query.mockResolvedValue({ rows: [{ total: 200, agents: 4 }] });
    await calcSdrCallsPerDay();
    const sql = lastSql();
    expect(sql).toMatch(/lead_id IS NOT NULL OR deal_id IS NOT NULL/);
    // The regression: a bare lead-only filter drops deal-linked calls.
    expect(sql).not.toMatch(/AND lead_id IS NOT NULL\s*\n/);
  });

  it("SDR-KPI-02 counts calls linked to a lead OR a deal", async () => {
    query.mockResolvedValue({ rows: [{ total: 200, connected: 50 }] });
    await calcSdrContactRate();
    expect(lastSql()).toMatch(/lead_id IS NOT NULL OR deal_id IS NOT NULL/);
  });

  it("SDR-KPI-06 still requires LEAD linkage — speed-to-lead is lead-intrinsic", async () => {
    query.mockResolvedValue({ rows: [{ avg_hours: 3, n: 2 }] });
    await calcSdrSpeedToLead();
    const sql = lastSql();
    expect(sql).toMatch(/lead_id/);
    // Must NOT have been broadened along with 01/02.
    expect(sql).not.toMatch(/deal_id IS NOT NULL/);
  });
});

describe("SDR call KPIs — future-dated calls", () => {
  it("SDR-KPI-01 excludes calls dated in the future", async () => {
    query.mockResolvedValue({ rows: [{ total: 10, agents: 2 }] });
    await calcSdrCallsPerDay();
    // Zoho holds SCHEDULED calls. Counting them would let the metric be raised
    // by BOOKING calls rather than making them.
    expect(lastSql()).toMatch(/call_date <= NOW\(\)/);
  });

  it("SDR-KPI-02 excludes calls dated in the future", async () => {
    query.mockResolvedValue({ rows: [{ total: 10, connected: 4 }] });
    await calcSdrContactRate();
    expect(lastSql()).toMatch(/call_date <= NOW\(\)/);
  });
});

describe("SDR call KPIs — arithmetic", () => {
  it("Contact Rate is connected ÷ total", async () => {
    query.mockResolvedValue({ rows: [{ total: 200, connected: 50 }] });
    const r = await calcSdrContactRate();
    expect(r.value).toBe(25);
    expect(r.details).toMatchObject({ connected: 50, total: 200 });
  });

  it("both report no data on an empty window rather than 0", async () => {
    query.mockResolvedValue({ rows: [{ total: 0, agents: 0, connected: 0 }] });
    expect((await calcSdrCallsPerDay()).dataAvailable).toBe(false);
    expect((await calcSdrContactRate()).dataAvailable).toBe(false);
  });
});
