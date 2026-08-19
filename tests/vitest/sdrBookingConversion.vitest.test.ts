/**
 * SDR-KPI-12 Booking Conversion Rate — the governed meeting-conversion KPI.
 *
 * Source: SDR Governance Document (WalaPlus_SDR v2.2, 08.12.2025), Individual
 * KPIs table — "(# of Booked meetings / Total leads answered) x 100", target
 * >=40%. It replaced ADHOC-SALES-04, whose 20% target came from a BI-portal
 * screenshot and appears in no controlled document.
 *
 * The assertions guard the three decisions that make the number mean what the
 * SOP says, each of which produced a wrong KPI earlier in this platform:
 *  - ONE window on both sides (an all-time denominator with a windowed
 *    numerator is what made the ad-hoc churn and revenue KPIs meaningless);
 *  - "answered" excludes exactly New Lead and No Answer, per the SOP's stage
 *    vocabulary — not an invented list;
 *  - a >100% result is suppressed rather than published.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../src/utils/duplicateRadarDatabase", () => ({
  pool: { query: (...a: any[]) => query(...a) },
  getDealDocCompliance: vi.fn(),
  scanDealStageAgingViolations: vi.fn(),
  scanCsLifecycleViolations: vi.fn(),
  openStagePredicate: () => "TRUE",
  buildSegmentPredicate: () => ({ condition: null, params: [], needsRecordJoin: false }),
}));
vi.mock("../../src/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { calcSdrBookingConversionRate, PROCESS_CALCULATORS } from "../../src/utils/kpiProcessCalc";

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();

/** localRawRecords issues one query per module; route by the $1 parameter. */
function mockCorpus(leads: any[], deals: any[]) {
  query.mockImplementation(async (_sql: string, params: any[] = []) => ({
    rows: (params[0] === "Leads" ? leads : deals).map((raw) => ({ raw_data: raw })),
  }));
}

const lead = (status: string, ageDays = 5) => ({
  Lead_Status: status,
  Created_Time: daysAgo(ageDays),
});
const deal = (stage: string, ageDays = 5) => ({
  Stage: stage,
  Created_Time: daysAgo(ageDays),
});

beforeEach(() => query.mockReset());

describe("what counts as an answered lead", () => {
  it("excludes exactly New Lead and No Answer", async () => {
    mockCorpus(
      [
        lead("New Lead"),
        lead("No Answer"),
        lead("Contacting"),
        lead("Qualified Lead"),
        lead("Potential"),
        lead("On Hold"),
      ],
      [deal("Meeting")],
    );
    // 4 answered of 6 leads; 1 booked → 25%. Those two stages are the SOP's
    // own words for "nobody replied"; every other stage means contact happened.
    const r = await calcSdrBookingConversionRate();
    expect(r.value).toBe(25);
    expect(r.details).toMatchObject({ leads_answered: 4, booked_meetings: 1 });
  });

  it("does not count a blank status as answered", async () => {
    mockCorpus([lead(""), lead("Contacting")], [deal("Meeting")]);
    expect((await calcSdrBookingConversionRate()).details).toMatchObject({
      leads_answered: 1,
    });
  });

  it("reports no data when nothing was answered in the window", async () => {
    mockCorpus([lead("New Lead"), lead("No Answer")], [deal("Meeting")]);
    expect((await calcSdrBookingConversionRate()).dataAvailable).toBe(false);
  });
});

describe("what counts as a booked meeting", () => {
  it("counts Not Attend Meeting — it was booked, the client did not show", async () => {
    mockCorpus(
      [lead("Contacting"), lead("Contacting"), lead("Contacting"), lead("Contacting")],
      [deal("Meeting"), deal("Not Attend Meeting")],
    );
    // 2 of 4 = 50%. Dropping the no-show would report 25% and punish the SDR
    // twice for it — show-rate is SDR-KPI-05's job.
    expect((await calcSdrBookingConversionRate()).value).toBe(50);
  });

  it("ignores deals that never reached a meeting stage", async () => {
    mockCorpus(
      [lead("Contacting"), lead("Contacting")],
      [deal("Proposal"), deal("Closed Lost"), deal("Meeting")],
    );
    expect((await calcSdrBookingConversionRate()).details).toMatchObject({
      booked_meetings: 1,
    });
  });
});

describe("both sides share one window", () => {
  it("drops leads and deals created outside it", async () => {
    mockCorpus(
      [lead("Contacting", 2), lead("Contacting", 400)],
      [deal("Meeting", 2), deal("Meeting", 400)],
    );
    // One of each survives → 100%. If only the numerator were windowed, the
    // stale lead would sit in the denominator and halve the rate.
    const r = await calcSdrBookingConversionRate();
    expect(r.details).toMatchObject({ leads_answered: 1, booked_meetings: 1 });
  });
});

describe("the implausibility guard", () => {
  it("suppresses a rate above 100% instead of publishing it", async () => {
    mockCorpus([lead("Contacting")], [deal("Meeting"), deal("Meeting"), deal("Meeting")]);
    const r = await calcSdrBookingConversionRate();
    // 300% would read as a triumph rather than a data problem: it means the
    // meetings were booked against leads from an earlier period, so the cohort
    // assumption does not hold.
    expect(r.dataAvailable).toBe(false);
  });

  it("allows exactly 100%", async () => {
    mockCorpus([lead("Contacting")], [deal("Meeting")]);
    expect((await calcSdrBookingConversionRate()).value).toBe(100);
  });
});

describe("wiring", () => {
  it("is registered so the daily recalc records it", () => {
    expect(PROCESS_CALCULATORS["SDR-KPI-12"]).toBeTypeOf("function");
  });
});
