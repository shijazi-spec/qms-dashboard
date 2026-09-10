/**
 * CS-KPI-14 Average Client Health Score.
 *
 * Built 2026-09-10 only AFTER checking the tenant: 939 of 939 populated Health
 * fields parse as numbers in 0-100. The code had claimed nothing either way —
 * the extractor keeps Health a STRING (while coercing arr_value to a number),
 * and the lifecycle engine only ever checked that it was non-empty. So no part
 * of the platform had evaluated whether these values were numeric until the
 * question was asked directly of the data.
 *
 * Three ways an average like this goes wrong, all pinned here:
 *
 *   `Number("")` is 0. A blank Health field silently becomes a zero and drags
 *   the mean down, and 0 is indistinguishable from a real "this customer is on
 *   fire" score once it is in the sum.
 *
 *   Averaging the violation rows. Those exist only for deals that broke a
 *   rule, so the mean would describe the unhealthiest slice of the book and be
 *   labelled "average health".
 *
 *   Counting unscored customers as zero. That reports the CS book as failing
 *   because of an empty field.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  parseHealthScore,
  summarizeViolations,
  type CsLifecycleEvaluation,
} from "../../src/utils/csLifecycleCompliance";

const CALC = readFileSync(
  join(__dirname, "../../src/utils/kpiProcessCalc.ts"),
  "utf8",
);

const ev = (o: Partial<CsLifecycleEvaluation> = {}): CsLifecycleEvaluation => ({
  is_cs_deal: true,
  current_phase: "Adoption",
  days_since_modified: 3,
  violations: [],
  health_score: null,
  has_health_value: false,
  ...o,
});

describe("parseHealthScore", () => {
  it("accepts a plain number in range", () => {
    expect(parseHealthScore("78")).toBe(78);
    expect(parseHealthScore("78.5")).toBe(78.5);
    expect(parseHealthScore(78)).toBe(78);
  });

  it("accepts 0 and 100, the ends of the scale", () => {
    // 0 is a real score — the customer is on fire. Rule 10 of the lifecycle
    // engine says so explicitly, and treating it as missing would quietly
    // remove the worst customers from the average.
    expect(parseHealthScore("0")).toBe(0);
    expect(parseHealthScore("100")).toBe(100);
  });

  it("treats blank and whitespace as no score, NOT as zero", () => {
    // Number("") === 0 and Number("   ") === 0. This is the whole trap.
    expect(parseHealthScore("")).toBeNull();
    expect(parseHealthScore("   ")).toBeNull();
    expect(parseHealthScore(null)).toBeNull();
    expect(parseHealthScore(undefined)).toBeNull();
  });

  it("rejects text rather than turning it into NaN", () => {
    for (const v of ["Green", "At Risk", "N/A", "-"]) {
      expect(parseHealthScore(v), `${v} must not parse`).toBeNull();
    }
  });

  it("rejects out-of-range values instead of clamping them", () => {
    // A stray 1000 clamped to 100 is invisible; rejected, it shows up in the
    // invalid count as the data-entry error it is.
    expect(parseHealthScore("1000")).toBeNull();
    expect(parseHealthScore("-5")).toBeNull();
  });

  it("rejects the special numbers that survive Number()", () => {
    expect(parseHealthScore("Infinity")).toBeNull();
    expect(parseHealthScore("NaN")).toBeNull();
  });
});

describe("the health census counts every CS deal, not just violating ones", () => {
  it("sums and counts only scored deals", () => {
    const s = summarizeViolations([
      ev({ health_score: 80, has_health_value: true }),
      ev({ health_score: 60, has_health_value: true }),
    ]);
    expect(s.health_scored).toBe(2);
    expect(s.health_sum).toBe(140);
    expect(s.health_unscored).toBe(0);
  });

  it("separates never-scored from scored-with-rubbish", () => {
    const s = summarizeViolations([
      ev({ health_score: 90, has_health_value: true }),
      ev({ health_score: null, has_health_value: false }),
      ev({ health_score: null, has_health_value: true }),
    ]);
    expect(s.health_scored).toBe(1);
    expect(s.health_unscored).toBe(1);
    expect(s.health_invalid).toBe(1);
  });

  it("keeps the three buckets adding up to the CS-deal count", () => {
    // If they ever disagree, a deal has been counted in the KPI's denominator
    // that the phase census does not know about, or vice versa.
    const s = summarizeViolations([
      ev({ health_score: 70, has_health_value: true }),
      ev({ health_score: null, has_health_value: false }),
      ev({ health_score: null, has_health_value: true }),
      ev({ health_score: 0, has_health_value: true }),
    ]);
    expect(s.health_scored + s.health_unscored + s.health_invalid).toBe(
      s.total_cs_deals,
    );
  });

  it("counts a health score of 0 as scored", () => {
    const s = summarizeViolations([ev({ health_score: 0, has_health_value: true })]);
    expect(s.health_scored).toBe(1);
    expect(s.health_sum).toBe(0);
    expect(s.health_unscored).toBe(0);
  });

  it("ignores non-CS deals entirely", () => {
    // A deal with no CS Phase is not part of the CS book and must not appear
    // in the coverage denominator.
    const s = summarizeViolations([
      ev({ is_cs_deal: false, health_score: 10, has_health_value: true }),
      ev({ health_score: 50, has_health_value: true }),
    ]);
    expect(s.total_cs_deals).toBe(1);
    expect(s.health_scored).toBe(1);
    expect(s.health_sum).toBe(50);
  });
});

describe("the calculator", () => {
  const body = /export async function calcCsAverageHealthScore[\s\S]*?\n\}/.exec(
    CALC,
  )![0];

  it("reports no data rather than a number when nobody is scored", () => {
    expect(body).toContain("a.healthScored === 0");
    expect(body).toContain("return EMPTY");
  });

  it("divides by scored deals, not by all CS deals", () => {
    // Dividing by every CS deal would report the book as failing because of
    // blank fields rather than because of unhealthy customers.
    expect(body).toContain("a.healthSum / a.healthScored");
    expect(body).not.toContain("/ a.csDeals");
  });

  it("carries coverage with the value", () => {
    // "78 across 12% of customers" is a different fact from "78 across all of
    // them", and the number alone cannot tell them apart.
    expect(body).toContain("coverage_pct");
    expect(body).toContain("deals_unscored");
    expect(body).toContain("deals_health_not_a_valid_score");
  });

  it("does not claim to be a proxy, because it is not one", () => {
    // CS-KPI-11 and 19 substitute lifecycle timeliness for the SOP's stated
    // measure and say so. This one reads the field the SOP describes.
    expect(body).not.toContain("PROXY");
  });
});
