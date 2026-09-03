/**
 * The three follow-up KPIs, all reading the local `zoho_tasks` mirror:
 *   SDR-KPI-11  Follow-Up Compliance (SDR)
 *   SALES-KPI-07 Follow-Up Effectiveness
 *   SALES-KPI-08 First-Contact SLA
 *
 * These assert on the SQL each calculator issues plus its arithmetic, because
 * the denominator choices are the whole design and each one is a decision that
 * could be silently reversed:
 *  - compliance counts only COMPLETED tasks that had a due date;
 *  - effectiveness does NOT let an overdue task count as covered;
 *  - first-contact counts a deal with NO task as a MISS, not an exclusion.
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
  calcSdrFollowUpCompliance,
  calcSalesFollowUpEffectiveness,
  calcSalesFirstContactSla,
} from "../../src/utils/kpiProcessCalc";

const lastSql = () => String(query.mock.calls.at(-1)?.[0] ?? "");

beforeEach(() => query.mockReset());

describe("SDR-KPI-11 Follow-Up Compliance", () => {
  it("is on-time ÷ completed, scoped to Leads", async () => {
    query.mockResolvedValue({ rows: [{ completed: 8, on_time: 6 }] });
    const r = await calcSdrFollowUpCompliance();
    expect(r.value).toBe(75);
    expect(r.details).toMatchObject({ on_time: 6, completed: 8 });
    const sql = lastSql();
    // Joined to Leads specifically — a Contact-linked task must not count.
    expect(sql).toMatch(/zoho_module = 'Leads'/);
    expect(sql).toMatch(/r\.zoho_record_id = t\.who_id/);
  });

  it("counts only COMPLETED tasks that carried a due date", async () => {
    query.mockResolvedValue({ rows: [{ completed: 1, on_time: 1 }] });
    await calcSdrFollowUpCompliance();
    const sql = lastSql();
    expect(sql).toMatch(/status = 'Completed'/);
    expect(sql).toMatch(/due_date IS NOT NULL/);
    expect(sql).toMatch(/closed_time IS NOT NULL/);
  });

  it("reports no data when nothing has been completed", async () => {
    query.mockResolvedValue({ rows: [{ completed: 0, on_time: 0 }] });
    expect((await calcSdrFollowUpCompliance()).dataAvailable).toBe(false);
  });
});

describe("SALES-KPI-07 Follow-Up Effectiveness", () => {
  it("is covered ÷ open deals", async () => {
    query.mockResolvedValue({ rows: [{ deals: 10, covered: 4 }] });
    const r = await calcSalesFollowUpEffectiveness();
    expect(r.value).toBe(40);
    expect(r.details).toMatchObject({ covered: 4, open_deals: 10 });
  });

  it("does NOT let an overdue or completed task count as covered", async () => {
    query.mockResolvedValue({ rows: [{ deals: 1, covered: 1 }] });
    await calcSalesFollowUpEffectiveness();
    const sql = lastSql();
    // An overdue open task is the failure state, not coverage.
    expect(sql).toMatch(/due_date >= CURRENT_DATE/);
    expect(sql).toMatch(/status IS NULL OR t\.status <> 'Completed'/);
  });

  it("reports no data when there are no open deals", async () => {
    query.mockResolvedValue({ rows: [{ deals: 0, covered: 0 }] });
    expect((await calcSalesFollowUpEffectiveness()).dataAvailable).toBe(false);
  });
});

describe("SALES-KPI-08 First-Contact SLA", () => {
  it("is within-SLA ÷ new deals, and reports the SLA it used", async () => {
    query.mockResolvedValue({ rows: [{ deals: 20, within_sla: 9 }] });
    const r = await calcSalesFirstContactSla();
    expect(r.value).toBe(45);
    expect(r.details).toMatchObject({ within_sla: 9, new_deals: 20, sla_hours: 24 });
  });

  it("treats a deal with NO task as a miss, not an exclusion", async () => {
    query.mockResolvedValue({ rows: [{ deals: 5, within_sla: 0 }] });
    const r = await calcSalesFirstContactSla();
    // 5 deals, none contacted -> 0%, NOT "no data". Never being contacted is
    // the worst outcome; excluding those would make the metric improve as the
    // team touched fewer deals.
    expect(r.dataAvailable).toBe(true);
    expect(r.value).toBe(0);
    expect(lastSql()).toMatch(/first_task IS NOT NULL/);
  });

  it("measures from the FIRST task against the deal's creation time", async () => {
    query.mockResolvedValue({ rows: [{ deals: 1, within_sla: 1 }] });
    await calcSalesFirstContactSla();
    const sql = lastSql();
    expect(sql).toMatch(/MIN\(t\.created_time\)/);
    expect(sql).toMatch(/INTERVAL '24 hours'/);
  });

  it("reports no data when no deals were created in the window", async () => {
    query.mockResolvedValue({ rows: [{ deals: 0, within_sla: 0 }] });
    expect((await calcSalesFirstContactSla()).dataAvailable).toBe(false);
  });
});
