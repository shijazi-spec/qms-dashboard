/**
 * SDR-KPI-04 (Meetings Booked Per Week) and SDR-KPI-05 (Show Rate).
 *
 * CRMProvider's Events/Meetings module is NOT synced into this platform, so both are
 * derived from the two Deal stages the Sales SOP defines for the meeting step:
 * "Meeting" (§7.3) and "Not Attend Meeting" (§7.2.8).
 *
 * THE TRAP THIS LOCKS IN: "Not Attend Meeting" also contains the substring
 * "meeting". If the classifier tests for "meeting" before "not attend", every
 * no-show scores as attended and Show Rate reads 100% — a KPI that looks
 * perfect precisely when the team is failing.
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
  calcSdrMeetingsBooked,
  calcSdrShowRate,
} from "../../src/utils/kpiProcessCalc";

/** Deal rows as duplicate_records stores them: { raw_data }. */
function deals(...raws: any[]) {
  query.mockResolvedValue({ rows: raws.map((raw_data) => ({ raw_data })) });
}
const recent = () => new Date(Date.now() - 3 * 86400000).toISOString();
const old = () => new Date(Date.now() - 200 * 86400000).toISOString();

beforeEach(() => query.mockReset());

describe("calcSdrShowRate (SDR-KPI-05)", () => {
  it("does NOT count 'Not Attend Meeting' as attended", async () => {
    // The regression: substring order. 1 attended of 4 booked = 25%.
    deals(
      { Stage: "Meeting" },
      { Stage: "Not Attend Meeting" },
      { Stage: "Not Attend Meeting" },
      { Stage: "Not Attend Meeting" },
    );
    const r = await calcSdrShowRate();
    expect(r.value).toBe(25);
    expect(r.details).toMatchObject({ attended: 1, no_show: 3, booked: 4 });
  });

  it("ignores deals that are not at the meeting step", async () => {
    deals(
      { Stage: "Meeting" },
      { Stage: "Not Attend Meeting" },
      { Stage: "Proposal" },
      { Stage: "Paid" },
      { Stage: "Closed Lost" },
    );
    const r = await calcSdrShowRate();
    expect(r.details).toMatchObject({ booked: 2 });
    expect(r.value).toBe(50);
  });

  it("reports no data when nobody is at the meeting step", async () => {
    deals({ Stage: "Proposal" }, { Stage: "Paid" });
    expect((await calcSdrShowRate()).dataAvailable).toBe(false);
  });

  it("reads a Stage given as a CRMProvider lookup object", async () => {
    deals({ Stage: { name: "Not Attend Meeting" } }, { Stage: { name: "Meeting" } });
    const r = await calcSdrShowRate();
    expect(r.details).toMatchObject({ attended: 1, no_show: 1 });
  });

  it("is case- and whitespace-tolerant", async () => {
    deals({ Stage: "  NOT ATTEND MEETING " }, { Stage: "meeting" });
    const r = await calcSdrShowRate();
    expect(r.details).toMatchObject({ attended: 1, no_show: 1 });
  });
});

describe("calcSdrMeetingsBooked (SDR-KPI-04)", () => {
  it("counts BOTH attended and no-show deals — both were booked", async () => {
    deals(
      { Stage: "Meeting", Modified_Time: recent() },
      { Stage: "Not Attend Meeting", Modified_Time: recent() },
      { Stage: "Meeting", Modified_Time: recent() },
      { Stage: "Meeting", Modified_Time: recent() },
    );
    // 4 booked over a 4-week window = 1.0 per week.
    const r = await calcSdrMeetingsBooked();
    expect(r.details).toMatchObject({ booked: 4 });
    expect(r.value).toBe(1);
  });

  it("excludes deals outside the window", async () => {
    deals(
      { Stage: "Meeting", Modified_Time: recent() },
      { Stage: "Meeting", Modified_Time: old() },
      { Stage: "Not Attend Meeting", Modified_Time: old() },
    );
    expect((await calcSdrMeetingsBooked()).details).toMatchObject({ booked: 1 });
  });

  it("excludes non-meeting stages even inside the window", async () => {
    deals(
      { Stage: "Proposal", Modified_Time: recent() },
      { Stage: "Paid", Modified_Time: recent() },
    );
    expect((await calcSdrMeetingsBooked()).dataAvailable).toBe(false);
  });

  it("falls back to Created_Time when Modified_Time is absent", async () => {
    deals({ Stage: "Meeting", Created_Time: recent() });
    expect((await calcSdrMeetingsBooked()).details).toMatchObject({ booked: 1 });
  });
});
