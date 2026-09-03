/**
 * Unit tests for the Sales Stage SLA Spec (Deals Lifecycle tab engine).
 *
 * Run: npx vitest run tests/vitest/salesStageSlaSpec.vitest.test.ts
 *
 * Pure logic only — no DB, no CRMProvider. Covers the math (business-day skipping,
 * calendar-day fallback), grading thresholds at SLA / 1.5× SLA / past 1.5×
 * SLA, On Hold's custom 90/180 bands, terminal stage freeze, and unknown
 * stage passthrough.
 */
import { describe, expect, test } from "vitest";
import {
  SALES_STAGE_SLA_SPEC,
  TERMINAL_SALES_STAGES,
  businessDaysBetween,
  calendarDaysBetween,
  describeSla,
  getStageSlaSpec,
  gradeStageAging,
  isTerminalSalesStage,
  measureAging,
  openStageAgingBucket,
} from "../../src/utils/salesStageSlaSpec";

function utc(y: number, m: number, d: number, h = 12): Date {
  return new Date(Date.UTC(y, m - 1, d, h, 0, 0));
}

describe("businessDaysBetween — Mon–Fri only", () => {
  test("same day returns 0", () => {
    const d = utc(2026, 6, 15);
    expect(businessDaysBetween(d, d)).toBe(0);
  });

  test("Monday to Tuesday = 1 business day", () => {
    expect(businessDaysBetween(utc(2026, 6, 15), utc(2026, 6, 16))).toBe(1);
  });

  test("Friday to Monday spans a weekend = 1 business day", () => {
    expect(businessDaysBetween(utc(2026, 6, 12), utc(2026, 6, 15))).toBe(1);
  });

  test("Monday to Monday next week = 5 business days", () => {
    expect(businessDaysBetween(utc(2026, 6, 15), utc(2026, 6, 22))).toBe(5);
  });

  test("two-week SLA window: Monday to Friday +14 days = 10 business days", () => {
    expect(businessDaysBetween(utc(2026, 6, 15), utc(2026, 6, 29))).toBe(10);
  });

  test("weekend-only span (Sat to Sun) = 0 business days", () => {
    expect(businessDaysBetween(utc(2026, 6, 13), utc(2026, 6, 14))).toBe(0);
  });

  test("reverse range returns 0 (no negative aging)", () => {
    expect(businessDaysBetween(utc(2026, 6, 20), utc(2026, 6, 15))).toBe(0);
  });

  test("invalid date string returns 0", () => {
    expect(businessDaysBetween("not a date", utc(2026, 6, 15))).toBe(0);
  });
});

describe("calendarDaysBetween", () => {
  test("Friday to Monday = 3 calendar days", () => {
    expect(calendarDaysBetween(utc(2026, 6, 12), utc(2026, 6, 15))).toBe(3);
  });

  test("90 days = a quarter", () => {
    expect(calendarDaysBetween(utc(2026, 1, 1), utc(2026, 4, 1))).toBe(90);
  });
});

describe("getStageSlaSpec + isTerminalSalesStage", () => {
  test("each stage from the SOP table is registered", () => {
    expect(getStageSlaSpec("Not Attend Meeting")?.clauseRef).toBe("7.2.8");
    expect(getStageSlaSpec("Meeting")?.clauseRef).toBe("7.3");
    expect(getStageSlaSpec("On Hold")?.clauseRef).toBe("7.3.11");
    expect(getStageSlaSpec("Proposal")?.clauseRef).toBe("7.4.2");
    expect(getStageSlaSpec("Agreement Sent")?.clauseRef).toBe("7.5.1");
  });

  test("lookup is case-insensitive and trim-tolerant", () => {
    expect(getStageSlaSpec("  proposal  ")?.sla).toBe(90);
    expect(getStageSlaSpec("PROPOSAL")?.sla).toBe(90);
  });

  test("unknown stage returns null", () => {
    expect(getStageSlaSpec("Discovery")).toBeNull();
    expect(getStageSlaSpec(null)).toBeNull();
  });

  test("terminal stages: Agreement Signed + Paid + Closed Won + Closed Lost", () => {
    for (const s of TERMINAL_SALES_STAGES) {
      expect(isTerminalSalesStage(s)).toBe(true);
    }
    expect(isTerminalSalesStage("Agreement Signed")).toBe(true);
    expect(isTerminalSalesStage("Paid")).toBe(true);
    expect(isTerminalSalesStage("Proposal")).toBe(false);
    expect(isTerminalSalesStage(null)).toBe(false);
  });
});

describe("measureAging — picks BD vs calendar by spec", () => {
  test("Meeting (business_days) — Friday→Monday is 1 BD even though 3 calendar days", () => {
    const m = measureAging("Meeting", utc(2026, 6, 12), utc(2026, 6, 15));
    expect(m.unit).toBe("business_days");
    expect(m.agingUnits).toBe(1);
    expect(m.agingCalendarDays).toBe(3);
  });

  test("Proposal (calendar_days) — units == calendar days", () => {
    const m = measureAging("Proposal", utc(2026, 1, 1), utc(2026, 4, 1));
    expect(m.unit).toBe("calendar_days");
    expect(m.agingUnits).toBe(90);
    expect(m.agingCalendarDays).toBe(90);
  });

  test("unknown stage defaults to calendar_days", () => {
    const m = measureAging("Discovery", utc(2026, 6, 12), utc(2026, 6, 15));
    expect(m.unit).toBe("calendar_days");
    expect(m.agingUnits).toBe(3);
  });
});

describe("gradeStageAging — severity bands", () => {
  test("Meeting at 10 BD (exactly SLA) = info (within SLA)", () => {
    const aging = { unit: "business_days" as const, agingUnits: 10, agingCalendarDays: 14 };
    const g = gradeStageAging("Meeting", aging);
    expect(g.severity).toBe("info");
    expect(g.slaUnits).toBe(10);
    expect(g.warnThreshold).toBe(10);
    expect(g.critThreshold).toBe(15);
  });

  test("Meeting at 11 BD (past SLA, before 1.5×) = warning", () => {
    const aging = { unit: "business_days" as const, agingUnits: 11, agingCalendarDays: 15 };
    expect(gradeStageAging("Meeting", aging).severity).toBe("warning");
  });

  test("Meeting at 16 BD (> 1.5× SLA = 15) = critical", () => {
    const aging = { unit: "business_days" as const, agingUnits: 16, agingCalendarDays: 22 };
    expect(gradeStageAging("Meeting", aging).severity).toBe("critical");
  });

  test("Proposal at 90 days = info, 91 = warning, 136 = critical", () => {
    const at = (n: number) => ({
      unit: "calendar_days" as const,
      agingUnits: n,
      agingCalendarDays: n,
    });
    expect(gradeStageAging("Proposal", at(90)).severity).toBe("info");
    expect(gradeStageAging("Proposal", at(91)).severity).toBe("warning");
    expect(gradeStageAging("Proposal", at(135)).severity).toBe("warning");
    expect(gradeStageAging("Proposal", at(136)).severity).toBe("critical");
  });

  test("On Hold uses custom 90/180 bands (3–6 month range)", () => {
    const at = (n: number) => ({
      unit: "calendar_days" as const,
      agingUnits: n,
      agingCalendarDays: n,
    });
    expect(gradeStageAging("On Hold", at(89)).severity).toBe("info");
    expect(gradeStageAging("On Hold", at(91)).severity).toBe("warning");
    expect(gradeStageAging("On Hold", at(180)).severity).toBe("warning");
    expect(gradeStageAging("On Hold", at(181)).severity).toBe("critical");
    const g = gradeStageAging("On Hold", at(91));
    expect(g.warnThreshold).toBe(90);
    expect(g.critThreshold).toBe(180);
  });

  test("Not Attend Meeting (5 BD) — 6 BD warning, 8 BD critical", () => {
    const at = (n: number) => ({
      unit: "business_days" as const,
      agingUnits: n,
      agingCalendarDays: n,
    });
    expect(gradeStageAging("Not Attend Meeting", at(5)).severity).toBe("info");
    expect(gradeStageAging("Not Attend Meeting", at(6)).severity).toBe("warning");
    expect(gradeStageAging("Not Attend Meeting", at(8)).severity).toBe("critical");
  });

  test("terminal stage freezes — Agreement Signed at 365d still info", () => {
    const at365 = { unit: "calendar_days" as const, agingUnits: 365, agingCalendarDays: 365 };
    const g = gradeStageAging("Agreement Signed", at365);
    expect(g.severity).toBe("info");
    expect(g.isTerminal).toBe(true);
  });

  test("unknown OPEN stage uses the catch-all default — warn >30, critical >120", () => {
    // 2026-06-18 (Sample User) — a non-SOP open stage is no longer ignored: it grades
    // against the generic watch (warning past 30 days, critical past 120) so a
    // deal stuck there is still surfaced. Buckets 30/60/90/120+.
    const ok = gradeStageAging("Discovery", { unit: "calendar_days", agingUnits: 20, agingCalendarDays: 20 });
    expect(ok.severity).toBe("info");
    expect(ok.isUnknownStage).toBe(true);
    expect(ok.slaUnits).toBe(30);

    const warn = gradeStageAging("Discovery", { unit: "calendar_days", agingUnits: 50, agingCalendarDays: 50 });
    expect(warn.severity).toBe("warning");
    expect(warn.isUnknownStage).toBe(true);

    const stillWarn = gradeStageAging("Discovery", { unit: "calendar_days", agingUnits: 100, agingCalendarDays: 100 });
    expect(stillWarn.severity).toBe("warning");

    const crit = gradeStageAging("Discovery", { unit: "calendar_days", agingUnits: 130, agingCalendarDays: 130 });
    expect(crit.severity).toBe("critical");
  });

  test("openStageAgingBucket labels 30/60/90/120+", () => {
    expect(openStageAgingBucket(10)).toBe("<30");
    expect(openStageAgingBucket(45)).toBe("30+");
    expect(openStageAgingBucket(70)).toBe("60+");
    expect(openStageAgingBucket(100)).toBe("90+");
    expect(openStageAgingBucket(200)).toBe("120+");
  });

  test("terminal stage still freezes even past the catch-all window", () => {
    const g = gradeStageAging("Closed Lost", { unit: "calendar_days", agingUnits: 500, agingCalendarDays: 500 });
    expect(g.severity).toBe("info");
    expect(g.isTerminal).toBe(true);
  });
});

describe("describeSla — human-readable formatter", () => {
  test("business-day SLA shows BD", () => {
    const meeting = SALES_STAGE_SLA_SPEC.find((s) => s.stage === "Meeting")!;
    expect(describeSla(meeting)).toBe("≤ 10 business days (Sales SOP §7.3)");
  });

  test("On Hold shows the range", () => {
    const onHold = SALES_STAGE_SLA_SPEC.find((s) => s.stage === "On Hold")!;
    expect(describeSla(onHold)).toBe("90–180 calendar days (Sales SOP §7.3.11)");
  });

  test("Proposal shows calendar day form", () => {
    const proposal = SALES_STAGE_SLA_SPEC.find((s) => s.stage === "Proposal")!;
    expect(describeSla(proposal)).toBe("≤ 90 calendar days (Sales SOP §7.4.2)");
  });
});
