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

/** Sheet per stage, in pipeline order — the order Sales thinks in. */
export const REPORT_STAGES = ["Proposal", "Agreement Signed", "Paid"] as const;

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
  rows: DealComplianceReportRow[],
  opts: { segment: string; inScope?: number },
): SheetSpec[] {
  const missingAll = rows.filter((r) => !r.compliant);
  const stages = stageSummary(rows);
  const owners = ownerBreakdown(rows);
  const inScope = opts.inScope ?? rows.length;

  const sheets: SheetSpec[] = [
    {
      name: "Summary",
      columns: [
        { header: "Stage", key: "stage", width: 20 },
        { header: "Deals checked", key: "checked", width: 14 },
        { header: "Complete", key: "compliant", width: 12 },
        { header: "Missing documents", key: "missing", width: 18 },
        { header: "% missing", key: "missing_pct", width: 11 },
        { header: "Value at risk (SAR)", key: "missing_value", width: 19 },
      ],
      rows: [
        ...stages.map((s) => ({
          ...s,
          // Excel shows a blank rather than a misleading 0% when the sweep has
          // not reached a single deal in that stage.
          missing_pct: s.missing_pct == null ? "" : s.missing_pct,
        })),
        {
          stage: "ALL STAGES",
          checked: rows.length,
          compliant: rows.length - missingAll.length,
          missing: missingAll.length,
          missing_pct: pct(missingAll.length, rows.length) ?? "",
          missing_value: Math.round(missingAll.reduce((n, r) => n + (r.amount || 0), 0)),
        },
      ],
    },
    {
      name: "By owner",
      columns: [
        { header: "Deal owner", key: "owner", width: 28 },
        { header: "Deals checked", key: "checked", width: 14 },
        { header: "Complete", key: "compliant", width: 12 },
        { header: "Missing documents", key: "missing", width: 18 },
        { header: "% missing", key: "missing_pct", width: 11 },
        { header: "Value at risk (SAR)", key: "missing_value", width: 19 },
        { header: "Note", key: "note", width: 34 },
      ],
      rows: owners.map((o) => ({
        ...o,
        missing_pct: o.missing_pct == null ? "" : o.missing_pct,
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
        { header: "Amount (SAR)", key: "amount", width: 15 },
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
        amount: Math.round(r.amount || 0),
        created: day(r.created),
        missing: (r.missing_docs || []).join(", "),
        attachments: r.attachment_count,
        checked_at: day(r.checked_at),
        link: r.id ? dealZohoUrl(r.id) : "",
      })),
    });
  }

  const coverage =
    inScope > rows.length
      ? `${rows.length} of ${inScope} in-scope deals have been checked so far; the rest are queued.`
      : `All ${rows.length} in-scope deals have been checked.`;

  sheets.push({
    name: "How to read this",
    columns: [{ header: "Notes", key: "note", width: 118 }],
    rows: [
      { note: `Scope: ${opts.segment} · stages ${REPORT_STAGES.join(", ")}.` },
      { note: coverage },
      {
        note:
          "Percentages are of deals that have been CHECKED, not of all deals. A deal the " +
          "automatic check has not reached yet is not counted either way — padding the " +
          "denominator with unknowns would flatter the numbers.",
      },
      {
        note:
          "Owners are ranked by the NUMBER of deals missing documents, not by rate. A rep with " +
          "2 of 3 incomplete is at 67% but is not the problem; a rep with 180 incomplete is, " +
          "even at 40%. Rates are hidden below " + MIN_DEALS_FOR_RATE + " checked deals.",
      },
      {
        note:
          "Requirements per Sales SOP 7.5.10 — Proposal needs the financial offer; " +
          "Agreement Signed and Paid need the proposal, service agreement/contract, " +
          "quotation/PO/invoice, VAT certificate, commercial registration and national address.",
      },
      {
        note:
          "This checks the FILES uploaded to Zoho. Field and data-entry compliance is a " +
          "separate audit on the Quality Dashboard.",
      },
      { note: "Nothing in this workbook has been changed in the CRM." },
    ],
  });

  return sheets;
}
