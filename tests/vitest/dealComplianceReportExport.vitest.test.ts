/**
 * The document-compliance report for the Head of Sales.
 *
 * Sarah's brief (2026-08-25): the missing-document PERCENTAGE, WHICH OWNER the
 * problem sits with, and a SHEET PER STAGE — Proposal, Agreement Signed, Paid.
 *
 * The arithmetic is the report. Two judgement calls are pinned here because
 * getting either wrong changes who gets blamed:
 *
 *   The denominator is CHECKED deals, not all deals. A deal the background
 *   sweep has not reached is not evidence either way.
 *
 *   Owners rank by COUNT of incomplete deals, not by rate. A rep with 2 of 3
 *   incomplete is at 67% and is not the problem; a rep with 180 incomplete is,
 *   even at 40%.
 */
import { describe, it, expect } from "vitest";
import {
  buildDealComplianceReportSheets,
  buildReportNotes,
  ownerBreakdown,
  stageSummary,
  pct,
  sameStage,
  dealComplianceReportFilename,
  FMT_PERCENT,
  FMT_SAR,
  REPORT_STAGES,
  EXPORT_STAGES,
} from "../../src/utils/dealComplianceReportExport";
import { buildMonthlyMissingDocsEmail } from "../../src/utils/missingDocsMonthlyReport";
import type { DealComplianceReportRow } from "../../src/utils/duplicateRadarDatabase";

// The workbook's "How to read this" sheet was removed (commit 344ad5ce): the
// same notes now come straight from buildReportNotes(), not from a sheet a
// test could find by position OR by name. Centralising the `.join(" ")` here
// means a future change to how the notes are joined only needs updating once.
const notesOf = (opts: Parameters<typeof buildReportNotes>[0]) =>
  buildReportNotes(opts).join(" ");

let n = 0;
const deal = (o: Partial<DealComplianceReportRow> = {}): DealComplianceReportRow => ({
  id: `d${++n}`,
  name: "Deal",
  stage: "Proposal",
  owner: "Owner A",
  account: "Acme",
  amount: 1000,
  created: "2026-01-05T00:00:00.000Z",
  compliant: true,
  missing_docs: [],
  attachment_count: 1,
  checked_at: "2026-08-25T00:00:00.000Z",
  // Layout / pipeline / product became required on the row when the
  // report gained those columns (2026-09-03).
  layout: "WalaPlus",
  pipeline: "Standard (Corporate)",
  product: "WalaPlus",
  ...o,
});

const bad = (o: Partial<DealComplianceReportRow> = {}) =>
  deal({ compliant: false, missing_docs: ["VAT certificate"], attachment_count: 0, ...o });

describe("percentages", () => {
  it("rounds to a whole number", () => {
    expect(pct(1, 3)).toBe(33);
    expect(pct(2, 3)).toBe(67);
  });

  it("returns null rather than 0% when there is nothing to divide by", () => {
    // 0% missing reads as "all clean". Nothing checked is not the same claim.
    expect(pct(0, 0)).toBeNull();
  });
});

describe("stage matching", () => {
  it("ignores case and surrounding space, as Zoho stages vary", () => {
    expect(sameStage("agreement signed", "Agreement Signed")).toBe(true);
    expect(sameStage("  Paid ", "Paid")).toBe(true);
    expect(sameStage("Proposal", "Paid")).toBe(false);
  });
});

describe("stage summary", () => {
  it("counts and prices the incomplete deals per stage", () => {
    // Paid is not one of the DEFAULT stages any more (REPORT_STAGES dropped
    // it, see dealComplianceReportExport.ts) — use the other REPORT_STAGES
    // member, Agreement Signed, to exercise the same "two stages, two totals"
    // arithmetic without relying on a stage the default no longer covers.
    const s = stageSummary([
      deal({ stage: "Proposal" }),
      bad({ stage: "Proposal", amount: 500 }),
      bad({ stage: "Agreement Signed", amount: 250 }),
    ]);
    const proposal = s.find((x) => x.stage === "Proposal")!;
    expect(proposal).toMatchObject({ checked: 2, compliant: 1, missing: 1, missing_pct: 50, missing_value: 500 });
    expect(s.find((x) => x.stage === "Agreement Signed")!.missing_value).toBe(250);
  });

  it("reports every stage even when one has nothing checked yet", () => {
    const s = stageSummary([deal({ stage: "Proposal" })]);
    expect(s.map((x) => x.stage)).toEqual([...REPORT_STAGES]);
    expect(s.find((x) => x.stage === "Agreement Signed")!.missing_pct).toBeNull();
  });

  it("takes an explicit stage list, e.g. the wider export scope with Paid", () => {
    const s = stageSummary(
      [deal({ stage: "Proposal" }), bad({ stage: "Paid", amount: 250 })],
      EXPORT_STAGES,
    );
    expect(s.map((x) => x.stage)).toEqual([...EXPORT_STAGES]);
    expect(s.find((x) => x.stage === "Paid")!.missing_value).toBe(250);
  });
});

describe("owner breakdown", () => {
  it("ranks by COUNT of incomplete deals, not by rate", () => {
    const rows = [
      // 2 of 3 incomplete = 67%, but only 2 deals.
      ...Array.from({ length: 1 }, () => deal({ owner: "Small" })),
      ...Array.from({ length: 2 }, () => bad({ owner: "Small" })),
      // 6 of 20 incomplete = 30%, but six deals — the real problem.
      ...Array.from({ length: 14 }, () => deal({ owner: "Big" })),
      ...Array.from({ length: 6 }, () => bad({ owner: "Big" })),
    ];
    expect(ownerBreakdown(rows).map((o) => o.owner)).toEqual(["Big", "Small"]);
  });

  it("suppresses the rate on a sample too small to argue from", () => {
    const small = ownerBreakdown([bad({ owner: "Two" }), deal({ owner: "Two" })])[0];
    expect(small.missing).toBe(1);
    expect(small.missing_pct).toBeNull();
  });

  it("reports a rate once there are enough checked deals", () => {
    const rows = [
      ...Array.from({ length: 5 }, () => deal({ owner: "Five" })),
      ...Array.from({ length: 5 }, () => bad({ owner: "Five" })),
    ];
    expect(ownerBreakdown(rows)[0].missing_pct).toBe(50);
  });

  it("sums only the value of the INCOMPLETE deals", () => {
    const o = ownerBreakdown([
      deal({ owner: "X", amount: 900000 }),
      bad({ owner: "X", amount: 1000 }),
    ])[0];
    expect(o.missing_value).toBe(1000);
  });

  it("keeps unassigned deals visible rather than dropping them", () => {
    const o = ownerBreakdown([bad({ owner: "Unassigned" })]);
    expect(o[0].owner).toBe("Unassigned");
  });
});

describe("workbook shape", () => {
  const rows = [
    deal({ stage: "Proposal" }),
    bad({ stage: "Proposal", amount: 5000, name: "Big incomplete" }),
    bad({ stage: "Agreement Signed" }),
    deal({ stage: "Paid" }),
  ];
  const sheets = buildDealComplianceReportSheets(rows, { segment: "walaplus", inScope: 10 });

  it("has a sheet per stage, in pipeline order, plus summary and owners", () => {
    // No "How to read this" sheet: it was deliberately removed (Sarah
    // 2026-09-03) and its text now lives in buildReportNotes() for the
    // covering email instead — see the notesOf() tests below.
    expect(sheets.map((s) => s.name)).toEqual([
      "Summary",
      "By owner",
      "Proposal",
      "Agreement Signed",
      "Paid",
    ]);
  });

  it("closes the summary with an ALL STAGES line", () => {
    const last = (sheets[0].rows as any[]).at(-1);
    expect(last.stage).toBe("ALL STAGES");
    expect(last.checked).toBe(4);
    expect(last.missing).toBe(2);
    // A FRACTION, not 50: the column carries Excel's "0%" format, which
    // multiplies by 100 on display. Writing 50 would render "5000%".
    expect(last.missing_pct).toBe(0.5);
  });

  it("puts incomplete deals first, by value, on each stage sheet", () => {
    const proposal = sheets.find((s) => s.name === "Proposal")!.rows as any[];
    expect(proposal[0].status).toBe("MISSING");
    expect(proposal[0].deal).toBe("Big incomplete");
  });

  it("names the missing documents rather than only flagging the deal", () => {
    const proposal = sheets.find((s) => s.name === "Proposal")!.rows as any[];
    expect(proposal[0].missing).toBe("VAT certificate");
  });

  it("links every deal back to the record", () => {
    const paid = sheets.find((s) => s.name === "Paid")!.rows as any[];
    expect(paid[0].link).toContain("/tab/Deals/");
  });

  it("writes a blank, not a zero, where no rate can be computed", () => {
    const empty = buildDealComplianceReportSheets([], { segment: "all" });
    for (const r of empty[0].rows as any[]) expect(r.missing_pct).toBe("");
  });

  it("states coverage honestly when the sweep has not finished", () => {
    const notes = notesOf({ segment: "walaplus", checked: rows.length, inScope: 10 });
    expect(notes).toContain(`${rows.length} of 10 in-scope deals have been checked`);
    expect(notes).toContain("Percentages are of deals that have been CHECKED");
  });

  it("says so when everything has been checked", () => {
    const notes = notesOf({ segment: "all", checked: rows.length, inScope: rows.length });
    expect(notes).toContain(`All ${rows.length} in-scope deals have been checked`);
  });

  it("records that nothing was changed in the CRM", () => {
    const notes = notesOf({ segment: "walaplus", checked: rows.length, inScope: 10 });
    expect(notes).toContain("Nothing in this workbook has been changed in the CRM");
  });
});

describe("the formatting Sarah applied by hand, now built in", () => {
  // She exported the first report, formatted it herself, and sent it back
  // (2026-09-03). These assert the workbook now produces what she made:
  // percentages as real percentages, money as SAR, and colour that separates
  // complete from missing at a glance.
  const sheets = buildDealComplianceReportSheets(
    [deal({ stage: "Paid" }), bad({ stage: "Paid", amount: 5000 })],
    { segment: "walaplus", pipeline: "Standard" },
  );
  const col = (sheetName: string, key: string) =>
    sheets.find((s) => s.name === sheetName)!.columns.find((c) => c.key === key)!;

  it("formats both percentage columns as percentages", () => {
    expect((col("Summary", "missing_pct") as any).numFmt).toBe(FMT_PERCENT);
    expect((col("By owner", "missing_pct") as any).numFmt).toBe(FMT_PERCENT);
  });

  it("stores percentages as fractions, so 0% format renders correctly", () => {
    const paid = (sheets[0].rows as any[]).find((r) => r.stage === "Paid");
    expect(paid.missing_pct).toBeGreaterThan(0);
    expect(paid.missing_pct).toBeLessThanOrEqual(1);
  });

  it("formats every money column as SAR", () => {
    expect((col("Summary", "missing_value") as any).numFmt).toBe(FMT_SAR);
    expect((col("By owner", "missing_value") as any).numFmt).toBe(FMT_SAR);
    expect((col("Paid", "amount") as any).numFmt).toBe(FMT_SAR);
  });

  it("colours Complete green and Missing red, only when non-zero", () => {
    for (const sheet of ["Summary", "By owner"]) {
      const complete = col(sheet, "compliant") as any;
      const missing = col(sheet, "missing") as any;
      expect(complete.fill).toBe("FF92D050");
      expect(missing.fill).toBe("FFFF0000");
      // Without this, a stage with nothing missing still gets a red cell.
      expect(complete.fillWhenTruthy).toBe(true);
      expect(missing.fillWhenTruthy).toBe(true);
    }
  });

  it("carries Layout, Pipeline and Product on every stage sheet", () => {
    // EXPORT_STAGES, not REPORT_STAGES: the export covers Paid too, and its
    // sheet needs the same columns as every other stage sheet.
    for (const stage of EXPORT_STAGES) {
      const keys = sheets.find((s) => s.name === stage)!.columns.map((c) => c.key);
      expect(keys).toContain("layout");
      expect(keys).toContain("pipeline");
      expect(keys).toContain("product");
    }
  });

  it("states the layout AND pipeline it was scoped to", () => {
    const notes = notesOf({ segment: "walaplus", checked: 2, pipeline: "Standard" });
    expect(notes).toContain("layout walaplus");
    expect(notes).toContain("pipeline Standard");
  });

  it("says 'all pipelines' rather than going silent when unscoped", () => {
    // A filtered report that does not say so reads as covering everything.
    const notes = notesOf({ segment: "all", checked: 1 });
    expect(notes).toContain("all pipelines");
  });
});

describe("export vs monthly email — the two surfaces deliberately cover different stages", () => {
  // "Paid" deals are Customer Success's, not Sales's, once a deal is won.
  // The XLSX/CSV export and the in-app tab review them jointly with Sales and
  // CS (EXPORT_STAGES); the monthly email to the Head of Sales must not, or
  // Sales would be chased for documents CS owns (REPORT_STAGES). Same input
  // rows, deliberately different output — this pins that the two surfaces
  // never converge on Paid by accident.
  const rows = [
    deal({ stage: "Proposal", owner: "Owner A" }),
    bad({ stage: "Paid", owner: "Owner Paid Only", name: "Paid deal", amount: 9000 }),
  ];

  it("the export gives the Paid deal its own sheet", () => {
    const sheets = buildDealComplianceReportSheets(rows, { segment: "all" });
    const paidSheet = sheets.find((s) => s.name === "Paid")!;
    expect((paidSheet.rows as any[]).map((r) => r.deal)).toContain("Paid deal");
  });

  it("the monthly email excludes the Paid deal from every figure", () => {
    const mail = buildMonthlyMissingDocsEmail(rows, {
      periodLabel: "September 2026",
      inScope: rows.length,
    });
    // Only the Proposal deal (compliant) is in scope: 0 of 1 checked deals
    // missing, not 1 of 2 — the Paid deal must not pad either side.
    expect(mail.text).toContain("0 of 1 checked deals are missing required documents");
    // Neither the Paid stage nor its owner appears anywhere in the email.
    expect(mail.text).not.toContain("Paid");
    expect(mail.html).not.toContain("Paid");
  });
});

describe("filename", () => {
  it("names the segment", () => {
    expect(dealComplianceReportFilename("walaplus")).toBe(
      "deal-document-compliance-walaplus.xlsx",
    );
  });

  it("strips anything that could escape the filename", () => {
    expect(dealComplianceReportFilename('../../etc"')).toBe(
      "deal-document-compliance-etc.xlsx",
    );
  });
});
