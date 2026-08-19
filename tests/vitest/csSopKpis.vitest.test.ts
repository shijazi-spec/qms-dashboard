/**
 * The four CS SOP KPIs QMS can measure from its Zoho mirror.
 *
 * WP-BU-CS-SOP-003 defines 33 KPIs; 29 name Client-Hub, Jira, the Admin/BI
 * Portal or QA sampling as their system of record and stay manual. These four
 * come off the CS lifecycle engine, which already grades every synced CS deal
 * against the SOP's phase rules.
 *
 * The assertions guard the counting rule that makes them meaningful: DISTINCT
 * DEALS per violation family, never violation rows. A deal routinely breaches
 * several rules at once, so dividing rows by deals can exceed 100% or push
 * adherence below zero.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { scan } = vi.hoisted(() => ({ scan: vi.fn() }));

vi.mock("../../src/utils/duplicateRadarDatabase", () => ({
  pool: { query: vi.fn() },
  getDealDocCompliance: vi.fn(),
  scanDealStageAgingViolations: vi.fn(),
  scanCsLifecycleViolations: (...a: any[]) => scan(...a),
  openStagePredicate: () => "TRUE",
  buildSegmentPredicate: () => ({ condition: null, params: [], needsRecordJoin: false }),
}));
vi.mock("../../src/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  resetCsKpiCache,
  csKpiAggregates,
  calcCsSlaAdherence,
  calcCsDataAccuracy,
  calcCsChurnClassificationAccuracy,
  PROCESS_CALCULATORS,
} from "../../src/utils/kpiProcessCalc";

const v = (record_id: number, code: string) => ({ record_id, violation: { code } });

function mockScan(opts: {
  csDeals?: number;
  violations?: any[];
  byPhase?: Record<string, number>;
} = {}) {
  scan.mockReset().mockResolvedValue({
    summary: {
      total_cs_deals: opts.csDeals ?? 100,
      by_phase: opts.byPhase ?? { onboarding: 40, adoption: 40, termination: 20 },
    },
    violations: opts.violations ?? [],
    duration_ms: 1,
  });
}

beforeEach(() => {
  resetCsKpiCache();
  mockScan();
});

describe("counting rule", () => {
  it("counts a multi-breach deal once, not once per rule", async () => {
    mockScan({
      csDeals: 10,
      violations: [
        v(1, "onboarding_overdue"),
        v(1, "renewal_overdue"),
        v(1, "phase_transition_stalled"),
      ],
    });
    const a = await csKpiAggregates();
    // Three rows, ONE deal. Counting rows would report 7/10 adherence here,
    // and a deal breaching four rules would push it negative.
    expect(a.slaBreachDeals).toBe(1);
    expect((await calcCsSlaAdherence()).value).toBe(90);
  });

  it("runs ONE scan for all the KPIs it feeds", async () => {
    await calcCsSlaAdherence();
    await calcCsDataAccuracy();
    await calcCsChurnClassificationAccuracy();
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("asks for violation rows, not summaryOnly", async () => {
    await csKpiAggregates();
    // summaryOnly returns an empty violations array, which would silently make
    // every one of these KPIs report a perfect score.
    expect(scan.mock.calls[0][0]?.summaryOnly).toBeFalsy();
  });
});

describe("CS-KPI-25 SLA / Milestone Adherence", () => {
  it("counts only the timeliness rules", async () => {
    mockScan({
      csDeals: 10,
      violations: [
        v(1, "onboarding_overdue"),
        v(2, "missing_cs_owner"),
        v(3, "missing_health_score"),
      ],
    });
    // A blank health-score field is a data gap, not a missed deadline — folding
    // it in would make this KPI a duplicate of Data Accuracy.
    expect((await calcCsSlaAdherence()).value).toBe(90);
  });

  it("reports no data when nothing is in the CS book", async () => {
    mockScan({ csDeals: 0 });
    expect((await calcCsSlaAdherence()).dataAvailable).toBe(false);
  });
});

describe("CS-KPI-23 Client-Hub Data Accuracy Score", () => {
  it("counts only the mandatory-field rules", async () => {
    mockScan({
      csDeals: 4,
      violations: [v(1, "missing_renewal_date"), v(2, "onboarding_overdue")],
    });
    expect((await calcCsDataAccuracy()).value).toBe(75);
  });

  it("names the Zoho source, since the SOP specifies Client-Hub", async () => {
    const r = await calcCsDataAccuracy();
    // The number must never be presented as if it came from Client-Hub.
    expect(String((r.details as any).source)).toMatch(/Zoho/);
    expect(String((r.details as any).source)).toMatch(/Client-Hub/);
  });
});

describe("CS-KPI-30 Churn Classification Accuracy", () => {
  it("divides by churned deals, not the whole book", async () => {
    mockScan({
      csDeals: 100,
      byPhase: { adoption: 90, termination: 10 },
      violations: [v(1, "termination_missing_churn_reason")],
    });
    // 9/10 churned records complete = 90%. Dividing by 100 CS deals would
    // report 99% and hide the gap entirely.
    expect((await calcCsChurnClassificationAccuracy()).value).toBe(90);
  });

  it("stays blank when nothing has churned", async () => {
    mockScan({ csDeals: 50, byPhase: { adoption: 50 } });
    const r = await calcCsChurnClassificationAccuracy();
    // Nothing to classify is not 100% accuracy.
    expect(r.dataAvailable).toBe(false);
  });
});

describe("CS-KPI-21 Client Churn Rate stays unwired", () => {
  it("is NOT registered, because Zoho cannot source it", () => {
    // Wiring it produced 61% against a 15% annual ceiling: the denominator was
    // the whole historical CS book rather than the active population, and there
    // is no per-deal churn date to window a "per year" rate by. Swapping the
    // denominator gives 156%, so the measure is unavailable, not mis-scaled.
    expect(PROCESS_CALCULATORS["CS-KPI-21"]).toBeUndefined();
  });
});

describe("wiring", () => {
  it("registers the three measurable codes", () => {
    for (const code of ["CS-KPI-23", "CS-KPI-25", "CS-KPI-30"]) {
      expect(PROCESS_CALCULATORS[code], `${code} not registered`).toBeTypeOf("function");
    }
  });

  it("does NOT register the codes Zoho cannot source", () => {
    // Registering one would make it record a value it cannot actually source —
    // CS-KPI-21 is in this list because it was tried and produced a confident
    // 61% against a 15% ceiling.
    for (const code of ["CS-KPI-01", "CS-KPI-12", "CS-KPI-17", "CS-KPI-21", "CS-KPI-33"]) {
      expect(PROCESS_CALCULATORS[code], `${code} must stay manual`).toBeUndefined();
    }
  });
});
