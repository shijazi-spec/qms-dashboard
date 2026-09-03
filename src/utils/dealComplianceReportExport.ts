/**
 * The document-compliance report for the Head of Sales.
 *
 * PURE — takes checked deals, returns SheetSpecs. No queries, no I/O, so the
 * arithmetic is testable and the workbook can never disagree with the tab.
 *
 * Sarah's brief (2026-08-25): the missing-document PERCENTAGE, WHICH OWNER the
 * problem sits with, and A SHEET PER STAGE — Proposal, Agreement Signed, Paid.
 *
 * Two deliberate choices about what makes this land:
 *
 *   PERCENTAGES ARE OF CHECKED DEALS, NOT OF ALL DEALS. A deal the background
 *   sweep has not reached yet is not evidence of anything. Padding the
 *   denominator with unknowns would flatter the numbers; leaving them out and
 *   stating the coverage is honest.
 *
 *   OWNERS ARE RANKED BY COUNT OF MISSING-DOCUMENT DEALS, NOT BY RATE. A rep
 *   with 2 of 3 deals incomplete is at 67% but is not the problem; a rep with
 *   180 incomplete deals is, even at 40%. Both columns are shown, sorted by
 *   the count, and anyone with fewer than a handful of checked deals is
 *   flagged as too small to read a rate from.
 */
import type { SheetSpec } from "./excelExport";
import type { DealComplianceReportRow } from "./duplicateRadarDatabase";

/**
 * Sheet per stage, in pipeline order — the order Sales thinks in.
 *
 * "Paid" was REMOVED on Sarah's instruction (2026-09-03): "skip the paid from
 * the excel sheet itself, as it will be handled by the CS team." Paid deals are
 * past the sales motion, so chasing their documents through a Sales report puts
 * the follow-up on the wrong team. They are still visible on the Deal
 * Compliance tab — only this report drops them.
 *
 * Every sheet, the Summary totals and the email all derive from this list (the
 * rows are filtered to it in buildDealComplianceReportSheets), so a stage can be
 * added or removed here without leaving one surface disagreeing with another.
 */
export const REPORT_STAGES = ["Proposal", "Agreement Signed"] as const;

/** Below this, a percentage is noise rather than a signal. */
const MIN_DEALS_FOR_RATE = 5;

export function dealZohoUrl(id: string): string {
  return `https://crm.zoho.com/crm/org766568398/tab/Deals/${encodeURIComponent(id)}`;
}

const day = (v: string | null | undefined) => (v ? String(v).slice(0, 10) : "");

/** Whole-number percent, or null when there is nothing to divide by. */
export function pct(part: number, whole: number): number | null {
  if (!whole) return null;
  return Math.round((part / whole) * 100);
}

/**
 * Formatting Sarah applied by hand to the first export (2026-09-03) and asked
 * to have built in. Kept here as named constants so the workbook and its tests
 * refer to the same values.
 *
 * The percentage columns carry a FRACTION and are displayed with "0%": Excel's
 * percent format multiplies by 100, so storing 46 would render "4600%". This
 * is also why `pct()` above (whole numbers, for the email and the UI) and the
 * workbook's percentages are deliberately different types.
 */
export const FMT_PERCENT = "0%";
export const FMT_SAR =
  '_([$SAR]\\ * #,##0.00_);_([$SAR]\\ * \\(#,##0.00\\);_([$SAR]\\ * "-"??_);_(@_)';
const FILL_COMPLETE = "FF92D050"; // green — deals with every document
const FILL_MISSING = "FFFF0000"; // red — deals short of one
const FILL_EMPHASIS = "FF1F2937"; // the header navy, reused to weight % missing
const FONT_ON_EMPHASIS = "FFFFFFFF";

/** Fraction for Excel's percent format, or "" when nothing was measured. */
function pctFraction(part: number, whole: number): number | string {
  if (!whole) return "";
  return part / whole;
}

export function dealComplianceReportFilename(segment: string): string {
  const safe = String(segment || "all").replace(/[^a-z0-9_-]/gi, "");
  return `deal-document-compliance-${safe}.xlsx`;
}

export interface OwnerBreakdownRow {
  owner: string;
  checked: number;
  compliant: number;
  missing: number;
  missing_pct: number | null;
  missing_value: number;
}

/** Per-owner rollup, worst FIRST by count of incomplete deals. */
export function ownerBreakdown(rows: DealComplianceReportRow[]): OwnerBreakdownRow[] {
  const by = new Map<string, OwnerBreakdownRow>();
  for (const r of rows) {
    const key = r.owner || "Unassigned";
    const o =
      by.get(key) ||
      ({ owner: key, checked: 0, compliant: 0, missing: 0, missing_pct: null, missing_value: 0 } as OwnerBreakdownRow);
    o.checked++;
    if (r.compliant) o.compliant++;
    else {
      o.missing++;
      o.missing_value += r.amount || 0;
    }
    by.set(key, o);
  }
  const out = [...by.values()].map((o) => ({
    ...o,
    // Suppress the rate on tiny samples: "100% incomplete" off two deals
    // invites an argument about the report instead of about the deals.
    missing_pct: o.checked >= MIN_DEALS_FOR_RATE ? pct(o.missing, o.checked) : null,
    missing_value: Math.round(o.missing_value),
  }));
  return out.sort(
    (a, b) => b.missing - a.missing || b.missing_value - a.missing_value || a.owner.localeCompare(b.owner),
  );
}

export interface StageSummaryRow {
  stage: string;
  checked: number;
  compliant: number;
  missing: number;
  missing_pct: number | null;
  missing_value: number;
}

export function stageSummary(rows: DealComplianceReportRow[]): StageSummaryRow[] {
  return REPORT_STAGES.map((stage) => {
    const inStage = rows.filter((r) => sameStage(r.stage, stage));
    const missing = inStage.filter((r) => !r.compliant);
    return {
      stage,
      checked: inStage.length,
      compliant: inStage.length - missing.length,
      missing: missing.length,
      missing_pct: pct(missing.length, inStage.length),
      missing_value: Math.round(missing.reduce((n, r) => n + (r.amount || 0), 0)),
    };
  });
}

/** Stage names arrive from Zoho with inconsistent case and spacing. */
export function sameStage(a: string, b: string): boolean {
  return (a || "").trim().toLowerCase() === (b || "").trim().toLowerCase();
}

export function buildDealComplianceReportSheets(
  allRows: DealComplianceReportRow[],
  opts: { segment: string; inScope?: number; pipeline?: string },
): SheetSpec[] {
  // Scope EVERY sheet to the reported stages, so the Summary totals, the
  // per-owner ranking and the per-stage sheets can never disagree. Before this,
  // dropping a stage from REPORT_STAGES removed its sheet but left its deals
  // inside "ALL STAGES" and the owner counts — the report would have said one
  // thing in the summary and another in the tabs.
  const rows = allRows.filter((r) =>
    REPORT_STAGES.some((s) => sameStage(s, r.stage)),
  );
  const missingAll = rows.filter((r) => !r.compliant);
  const stages = stageSummary(rows);
  const owners = ownerBreakdown(rows);
  const inScope = opts.inScope ?? rows.length;

  const sheets: SheetSpec[] = [
    {
      name: "Summary",
      columns: [
        { header: "Stage", key: "stage", width: 20, fill: FILL_EMPHASIS, fontColor: FONT_ON_EMPHASIS, bold: true },
        { header: "Deals checked", key: "checked", width: 14 },
        { header: "Complete", key: "compliant", width: 12, fill: FILL_COMPLETE, fillWhenTruthy: true },
        { header: "Missing documents", key: "missing", width: 18, fill: FILL_MISSING, fillWhenTruthy: true },
        { header: "% missing", key: "missing_pct", width: 11, numFmt: FMT_PERCENT, fill: FILL_EMPHASIS, fontColor: FONT_ON_EMPHASIS, bold: true },
        { header: "Value at risk (SAR)", key: "missing_value", width: 19, numFmt: FMT_SAR },
      ],
      rows: [
        ...stages.map((s) => ({
          ...s,
          // Blank, not 0%, when the sweep has not reached a single deal in the
          // stage — "0% missing" would read as perfect compliance.
          missing_pct: pctFraction(s.missing, s.checked),
        })),
        {
          stage: "ALL STAGES",
          checked: rows.length,
          compliant: rows.length - missingAll.length,
          missing: missingAll.length,
          missing_pct: pctFraction(missingAll.length, rows.length),
          missing_value: Math.round(missingAll.reduce((n, r) => n + (r.amount || 0), 0)),
        },
      ],
    },
    {
      name: "By owner",
      columns: [
        { header: "Deal owner", key: "owner", width: 28 },
        { header: "Deals checked", key: "checked", width: 14 },
        { header: "Complete", key: "compliant", width: 12, fill: FILL_COMPLETE, fillWhenTruthy: true },
        { header: "Missing documents", key: "missing", width: 18, fill: FILL_MISSING, fillWhenTruthy: true },
        { header: "% missing", key: "missing_pct", width: 11, numFmt: FMT_PERCENT, fill: FILL_EMPHASIS, fontColor: FONT_ON_EMPHASIS, bold: true },
        { header: "Value at risk (SAR)", key: "missing_value", width: 19, numFmt: FMT_SAR },
        { header: "Note", key: "note", width: 34 },
      ],
      rows: owners.map((o) => ({
        ...o,
        missing_pct: o.missing_pct == null ? "" : pctFraction(o.missing, o.checked),
        note:
          o.missing_pct == null
            ? `Too few deals checked (${o.checked}) to read a rate`
            : "",
      })),
    },
  ];

  // One sheet per stage — the ask. Every checked deal in that stage, incomplete
  // FIRST and by value, so the sheet opens on what matters.
  for (const stage of REPORT_STAGES) {
    const inStage = rows
      .filter((r) => sameStage(r.stage, stage))
      .sort(
        (a, b) =>
          Number(a.compliant) - Number(b.compliant) || (b.amount || 0) - (a.amount || 0),
      );
    sheets.push({
      name: stage,
      columns: [
        { header: "Status", key: "status", width: 12 },
        { header: "Deal", key: "deal", width: 36 },
        { header: "Account", key: "account", width: 30 },
        { header: "Deal owner", key: "owner", width: 24 },
        // Layout / Pipeline / Product (Sarah 2026-09-03). Even when the whole
        // workbook is scoped to one layout, the columns stay: a sheet that has
        // been filtered must still say what it was filtered to, or a forwarded
        // copy reads as if it covered everything.
        { header: "Layout", key: "layout", width: 18 },
        { header: "Pipeline", key: "pipeline", width: 22 },
        { header: "Product", key: "product", width: 22 },
        { header: "Amount (SAR)", key: "amount", width: 17, numFmt: FMT_SAR },
        { header: "Created", key: "created", width: 12 },
        { header: "Missing documents", key: "missing", width: 52 },
        { header: "Attachments", key: "attachments", width: 12 },
        { header: "Checked", key: "checked_at", width: 12 },
        { header: "Open in Zoho", key: "link", width: 58 },
      ],
      rows: inStage.map((r) => ({
        status: r.compliant ? "Complete" : "MISSING",
        deal: r.name,
        account: r.account || "",
        owner: r.owner,
        layout: r.layout || "",
        pipeline: r.pipeline || "",
        product: r.product || "",
        amount: Math.round(r.amount || 0),
        created: day(r.created),
        missing: (r.missing_docs || []).join(", "),
        attachments: r.attachment_count,
        checked_at: day(r.checked_at),
        link: r.id ? dealZohoUrl(r.id) : "",
      })),
    });
  }

  // The "How to read this" sheet was REMOVED (Sarah 2026-09-03): "exclude how
  // to read this tab to be inside the email template instead". The same notes
  // now open the email that carries this workbook, where the recipient reads
  // them once instead of in a tab nobody opens. buildReportNotes() is the
  // single source for that text, so the scope line and the email cannot drift.

  return sheets;
}

/**
 * The notes that used to be the workbook's "How to read this" sheet, for the
 * email that carries the workbook. Kept here, beside the code that produces the
 * numbers, so a change to the method updates the explanation with it.
 */
export function buildReportNotes(opts: {
  segment: string;
  checked: number;
  inScope?: number;
  pipeline?: string;
}): string[] {
  const inScope = opts.inScope ?? opts.checked;
  return [
    `Scope: layout ${opts.segment}` +
      (opts.pipeline ? ` · pipeline ${opts.pipeline}` : " · all pipelines") +
      ` · stages ${REPORT_STAGES.join(", ")}. Paid deals are excluded — Customer Success handles those.`,
    inScope > opts.checked
      ? `${opts.checked} of ${inScope} in-scope deals have been checked so far; the rest are queued.`
      : `All ${opts.checked} in-scope deals have been checked.`,
    "Percentages are of deals that have been CHECKED, not of all deals. A deal the automatic check has not reached yet is not counted either way — padding the denominator with unknowns would flatter the numbers.",
    `Owners are ranked by the NUMBER of deals missing documents, not by rate. A rep with 2 of 3 incomplete is at 67% but is not the problem; a rep with 180 incomplete is, even at 40%. Rates are hidden below ${MIN_DEALS_FOR_RATE} checked deals.`,
    "Requirements per Sales SOP 7.5.10 — Proposal needs the financial offer; Agreement Signed needs the proposal, service agreement/contract, quotation/PO/invoice, VAT certificate, commercial registration and national address.",
    "This checks the FILES uploaded to Zoho. Field and data-entry compliance is a separate audit on the Quality Dashboard.",
    "Nothing in this workbook has been changed in the CRM.",
  ];
}
