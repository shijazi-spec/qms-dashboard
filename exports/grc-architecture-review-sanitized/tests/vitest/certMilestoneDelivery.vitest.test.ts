/**
 * GRC-KPI-002 = on-time delivery of 'plan' milestones due in the quarter.
 * The math is pure so it is testable without a database.
 */
import { describe, it, expect } from "vitest";

import { summarizeMilestoneDelivery, onTimeCountFromSummary } from "../../src/utils/northStarSources";

const Q4_START = new Date("2026-10-01T00:00:00Z");
const Q4_END = new Date("2027-01-01T00:00:00Z");

describe("summarizeMilestoneDelivery", () => {
  it("reports no data when nothing is due in the quarter", () => {
    const r = summarizeMilestoneDelivery(
      [{ planned_date: "2027-02-28", delivered_date: null, status: "planned" }],
      Q4_START, Q4_END,
    );
    expect(r.dataAvailable).toBe(false);
    expect(r.due).toBe(0);
  });

  it("counts a milestone delivered on or before its planned date as on time", () => {
    const r = summarizeMilestoneDelivery(
      [
        { planned_date: "2026-10-31", delivered_date: "2026-10-31", status: "delivered" },
        { planned_date: "2026-11-30", delivered_date: "2026-12-05", status: "delivered" },
      ],
      Q4_START, Q4_END,
    );
    expect(r.due).toBe(2);
    expect(r.onTime).toBe(1);
    expect(r.value).toBe(50);
  });

  it("treats an undelivered past-due milestone as not on time", () => {
    const r = summarizeMilestoneDelivery(
      [{ planned_date: "2026-10-31", delivered_date: null, status: "planned" }],
      Q4_START, Q4_END,
    );
    expect(r.due).toBe(1);
    expect(r.onTime).toBe(0);
    expect(r.value).toBe(0);
  });

  it("excludes cancelled milestones from the denominator", () => {
    const r = summarizeMilestoneDelivery(
      [
        { planned_date: "2026-10-31", delivered_date: "2026-10-01", status: "delivered" },
        { planned_date: "2026-11-30", delivered_date: null, status: "cancelled" },
      ],
      Q4_START, Q4_END,
    );
    expect(r.due).toBe(1);
    expect(r.value).toBe(100);
  });

  it("includes a milestone falling exactly on the quarter start", () => {
    const r = summarizeMilestoneDelivery(
      [{ planned_date: "2026-10-01", delivered_date: "2026-10-01", status: "delivered" }],
      Q4_START, Q4_END,
    );
    expect(r.due).toBe(1);
    expect(r.onTime).toBe(1);
  });

  it("excludes a milestone falling on the next quarter's first day", () => {
    const r = summarizeMilestoneDelivery(
      [{ planned_date: "2027-01-01", delivered_date: null, status: "planned" }],
      Q4_START, Q4_END,
    );
    expect(r.due).toBe(0);
    expect(r.dataAvailable).toBe(false);
  });
});

describe("leadership count derivation", () => {
  it("emits the on-time COUNT, never the percentage", () => {
    const s = { due: 4, onTime: 3, value: 75, dataAvailable: true };
    expect(onTimeCountFromSummary(s)).toBe(3);
  });

  it("emits null when there is no data, so the feed omits rather than sends 0", () => {
    const s = { due: 0, onTime: 0, value: 0, dataAvailable: false };
    expect(onTimeCountFromSummary(s)).toBeNull();
  });
});
