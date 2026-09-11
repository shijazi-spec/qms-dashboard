/**
 * The Sales document-compliance email must describe the Head of Sales's own
 * book, and say which book that is.
 *
 * Found 2026-09-11, in the artifact we were days from sending. The email was
 * built from `getDealComplianceReportRows("all")` while the workbook beside it
 * honoured the segment chip — so the email counted Marketplace and WalaOne
 * deals Ziad does not own (891 instead of his 795), and its owner table could
 * name people outside his team. Same class as SPEC-KPI-02 and QM-KPI-008: a
 * figure computed over one population and labelled with another.
 *
 * Two rules, and the second is the one that survives a refactor:
 *
 *   The DEFAULT is walaplus, everywhere the email is produced. A default of
 *   "all" is silent — every figure still renders, just about the wrong people.
 *
 *   The scope is STATED IN THE EMAIL. A reader cannot check a number whose
 *   population is implied.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  buildMonthlyMissingDocsEmail,
  scopeLabelFor,
} from "../../src/utils/missingDocsMonthlyReport";

const ROUTES = readFileSync(
  join(__dirname, "../../src/mastra/routes/duplicateRadarRoutes.ts"),
  "utf8",
);
const JOBS = readFileSync(
  join(__dirname, "../../src/utils/scheduledJobs.ts"),
  "utf8",
);
const SWEEP = readFileSync(
  join(__dirname, "../../src/utils/dealDocComplianceSweep.ts"),
  "utf8",
);

const row = (o: Partial<any> = {}): any => ({
  deal_id: "1",
  deal_name: "Deal",
  owner: "Bashayr ahmad",
  stage: "Agreement Signed",
  amount: 100000,
  compliant: false,
  ...o,
});

describe("the scope is stated in the email", () => {
  it("names the population in the body", () => {
    const mail = buildMonthlyMissingDocsEmail([row()], {
      periodLabel: "August 2026",
      inScope: 1,
      scopeLabel: scopeLabelFor("walaplus"),
    });
    expect(mail.text).toContain("WalaPlus corporate deals");
    expect(mail.html).toContain("WalaPlus corporate deals");
  });

  it("labels each segment in words a recipient recognises", () => {
    expect(scopeLabelFor("walaplus")).toBe("WalaPlus corporate deals");
    expect(scopeLabelFor("marketplace")).toBe("Marketplace deals");
    expect(scopeLabelFor("all")).toContain("all segments");
  });

  it("falls back to the raw value rather than claiming a scope it doesn't know", () => {
    expect(scopeLabelFor("something_new")).toBe("something_new");
  });

  it("still renders when no scope is given, without inventing one", () => {
    const mail = buildMonthlyMissingDocsEmail([row()], {
      periodLabel: "August 2026",
      inScope: 1,
    });
    expect(mail.text).not.toContain("undefined");
    expect(mail.html).not.toContain("undefined");
  });
});

describe("every producer of this email defaults to WalaPlus", () => {
  it("the preview route does not default to all segments", () => {
    expect(ROUTES).toContain('c.req.query("segment") || "walaplus"');
    expect(ROUTES).not.toContain('getDealComplianceReportRows("all")');
  });

  it("the monthly job does not default to all segments", () => {
    expect(JOBS).toContain('MISSING_DOCS_REPORT_SEGMENT ||');
    expect(JOBS).not.toContain('getDealComplianceReportRows("all")');
  });
});

describe("coverage shares the population it describes", () => {
  it("countNeverChecked can be scoped to a segment", () => {
    // The denominator of the coverage line. Drawn from a wider population than
    // the numerator, it makes coverage look worse than it is — or hides an
    // all-segment count under a WalaPlus headline.
    expect(SWEEP).toContain("buildSegmentPredicate");
    const fn = /export async function countNeverChecked[\s\S]*?\n\}/.exec(SWEEP)![0];
    expect(fn).toContain("segment");
  });

  it("both callers pass their own segment to it", () => {
    expect(ROUTES).toContain("countNeverChecked(REPORT_STAGES, segment)");
    expect(JOBS).toContain("countNeverChecked(REPORT_STAGES, reportSegment)");
  });
});
