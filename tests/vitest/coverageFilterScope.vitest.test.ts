/**
 * The coverage line counts the population it describes.
 *
 * "827 of 832 in-scope deals had been checked" only means anything if both
 * numbers come from the same filters. They did not. The ROWS honoured segment,
 * pipeline and period; countNeverChecked knew only segment and stage. So a
 * report narrowed to one quarter was padded with unchecked deals from every
 * quarter — a denominator describing a wider population than its numerator.
 *
 * The routes papered over the pipeline half by writing
 * `pipeline ? rows.length : rows.length + neverChecked`, which HID unchecked
 * deals whenever a pipeline was set instead of counting them, and left the
 * period half broken regardless.
 *
 * Now one helper builds the pipeline/period predicate and both sides call it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { buildDealReportFilterSql } from "../../src/utils/duplicateRadarDatabase";

const read = (p: string) => readFileSync(join(__dirname, "../../", p), "utf8");
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const DB = code(read("src/utils/duplicateRadarDatabase.ts"));
const SWEEP = code(read("src/utils/dealDocComplianceSweep.ts"));
const ROUTES = code(read("src/mastra/routes/duplicateRadarRoutes.ts"));

describe("buildDealReportFilterSql", () => {
  it("is empty when nothing is filtered", () => {
    const f = buildDealReportFilterSql(undefined, 0);
    expect(f.condition).toBe("");
    expect(f.params).toEqual([]);
  });

  it("numbers the pipeline param after the caller's own", () => {
    // The segment predicate binds first and can be one param wide or three,
    // so the offset is the contract. Off by one here reads a date as a
    // pipeline name and Postgres throws mid-report.
    const f = buildDealReportFilterSql({ pipeline: "Standard" }, 2);
    expect(f.params).toEqual(["Standard"]);
    expect(f.condition).toContain("$3");
  });

  it("matches the pipeline case-insensitively and on a CONTAINS", () => {
    // Zoho spells it "Standard", "Standard (Corporate)", "Corporate Standard".
    const f = buildDealReportFilterSql({ pipeline: "standard" }, 0);
    expect(f.condition).toContain("LOWER(COALESCE(r.pipeline, ''))");
    expect(f.condition).toContain("LIKE '%'");
  });

  it("bounds a year as a half-open range on created_date", () => {
    const f = buildDealReportFilterSql({ periodYear: 2026 }, 0);
    expect(f.params).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2027-01-01T00:00:00.000Z",
    ]);
    expect(f.condition).toContain("r.created_date >= $1");
    expect(f.condition).toContain("r.created_date < $2");
  });

  it("narrows to a quarter when one is given", () => {
    const f = buildDealReportFilterSql({ periodYear: 2026, periodQuarter: 3 }, 0);
    expect(f.params[0]).toBe("2026-07-01T00:00:00.000Z");
    expect(f.params[1]).toBe("2026-10-01T00:00:00.000Z");
  });

  it("ignores a quarter with no year, which is meaningless", () => {
    const f = buildDealReportFilterSql({ periodQuarter: 2 }, 0);
    expect(f.condition).toBe("");
    expect(f.params).toEqual([]);
  });

  it("ignores an implausible year rather than querying on it", () => {
    for (const y of [0, 1900, 9999, NaN]) {
      expect(buildDealReportFilterSql({ periodYear: y }, 0).params).toEqual([]);
    }
  });

  it("keeps pipeline and period params in the order it numbers them", () => {
    const f = buildDealReportFilterSql(
      { pipeline: "Standard", periodYear: 2026, periodQuarter: 1 },
      1,
    );
    expect(f.params).toHaveLength(3);
    expect(f.params[0]).toBe("Standard");
    expect(f.condition.indexOf("$2")).toBeLessThan(f.condition.indexOf("$4"));
    expect(f.condition).toContain("$2");
    expect(f.condition).toContain("$3");
    expect(f.condition).toContain("$4");
  });
});

describe("both sides of the coverage line use it", () => {
  it("the report rows narrow with it", () => {
    const fn = /export async function getDealComplianceReportRows[\s\S]*?\n\}/.exec(DB)![0];
    expect(fn).toContain("buildDealReportFilterSql(opts, p.params.length)");
    expect(fn).toContain("${filt.condition}");
    expect(fn).toContain("...filt.params");
  });

  it("the unchecked count narrows with it, offset past the segment params", () => {
    const fn = /export async function countNeverChecked[\s\S]*?\n\}/.exec(SWEEP)![0];
    expect(fn).toContain("buildDealReportFilterSql(filters, seg.params.length)");
    expect(fn).toContain("${filt.condition}");
    expect(fn).toContain("...filt.params");
  });
});

describe("no route hides unchecked deals instead of counting them", () => {
  it("the pipeline ternary is gone", () => {
    // `pipeline ? rows.length : rows.length + neverChecked` silently dropped
    // every unchecked deal from the denominator whenever a pipeline was set,
    // making coverage read 100% precisely when it was least likely to be.
    expect(ROUTES).not.toContain("pipeline ? rows.length");
  });

  it("the two FILTERED routes pass their pipeline and period to the count", () => {
    // Only these two accept ?pipeline / ?period_year. The monthly-email
    // preview and the scheduled job are deliberately unfiltered, so requiring
    // a period everywhere would be wrong — and would make this test fail on
    // correct code.
    expect(ROUTES).toContain("countNeverChecked(REPORT_STAGES, segment as any, {");
    expect(ROUTES).toContain("countNeverChecked(undefined, segment as any, {");
  });

  it("no route calls it bare", () => {
    expect(ROUTES).not.toContain("countNeverChecked(REPORT_STAGES)");
    expect(ROUTES).not.toContain("countNeverChecked()");
  });
});
