/**
 * SALES-KPI-02 rename: "Conversion Rate (SQL→Signed)" -> "Win Rate (Decided Deals)".
 *
 * The old label was wrong on both halves. The calculator computes
 * signed / (signed + lost) — a win rate among DECIDED deals, with open deals
 * excluded from the denominator — and this tenant has no SQL stage at all.
 *
 * It mattered because the BI portal publishes a real SQL→Closed Won funnel
 * conversion at 3.5% while this read 9.5%: two GRQ-owned surfaces appearing to
 * contradict each other on the same metric when they measured different things.
 *
 * The seed uses ON CONFLICT DO NOTHING, so a corrective UPDATE is the only way
 * the existing row is fixed. These tests pin that it runs, and that it is
 * guarded so it can never clobber a human's own rename.
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

import { seedSalesKPIsManual } from "../../src/utils/kpiDatabase";

/** Every statement issued, flattened for inspection. */
const statements = () => query.mock.calls.map((c) => ({ sql: String(c[0]), params: (c[1] ?? []) as any[] }));

beforeEach(() => query.mockReset().mockResolvedValue({ rows: [] }));

describe("SALES-KPI-02 corrective rename", () => {
  it("issues an UPDATE — the seed's ON CONFLICT DO NOTHING cannot fix an existing row", async () => {
    await seedSalesKPIsManual();
    const update = statements().find(
      (s) => /UPDATE kpi_definitions/i.test(s.sql) && /SALES-KPI-02/.test(s.sql),
    );
    expect(update, "no corrective UPDATE was issued").toBeTruthy();
    expect(update!.params).toContain("Win Rate (Decided Deals)");
  });

  it("never overwrites a manager's own edit", async () => {
    await seedSalesKPIsManual();
    const update = statements().find(
      (s) => /UPDATE kpi_definitions/i.test(s.sql) && /SALES-KPI-02/.test(s.sql),
    )!;
    expect(update.sql).toMatch(/is_customized IS NOT TRUE/i);
  });

  it("is one-time: guarded on the OLD name so it no-ops once corrected", async () => {
    await seedSalesKPIsManual();
    const update = statements().find(
      (s) => /UPDATE kpi_definitions/i.test(s.sql) && /SALES-KPI-02/.test(s.sql),
    )!;
    // Without this, a later manual rename would be reverted on every boot.
    expect(update.sql).toMatch(/kpi_name = 'Conversion Rate \(SQL→Signed\)'/);
  });

  it("corrects the formula too — it described a division that never happened", async () => {
    await seedSalesKPIsManual();
    const update = statements().find(
      (s) => /UPDATE kpi_definitions/i.test(s.sql) && /SALES-KPI-02/.test(s.sql),
    )!;
    const formula = update.params.find((p) => typeof p === "string" && p.includes("÷"));
    expect(formula).toBeTruthy();
    // The old formula claimed a SQL denominator. There is no SQL stage here.
    expect(formula).not.toMatch(/SQL/);
    expect(formula).toMatch(/Closed Lost/);
  });

  it("seeds the corrected name for a fresh install", async () => {
    await seedSalesKPIsManual();
    const insert = statements().find(
      (s) => /INSERT INTO kpi_definitions/i.test(s.sql) && s.params.includes("SALES-KPI-02"),
    );
    expect(insert, "SALES-KPI-02 not seeded").toBeTruthy();
    expect(insert!.params).toContain("Win Rate (Decided Deals)");
  });
});
