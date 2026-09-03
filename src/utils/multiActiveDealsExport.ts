/**
 * Excel workbook for the "one active deal per company" conflicts — the
 * attachment that goes with the flag to the Head of Sales.
 *
 * PURE. Takes the rows the tab already renders and returns SheetSpecs; it
 * queries nothing and sends nothing, so the workbook can never disagree with
 * what the operator saw on screen, and the shape is testable without a
 * database or a live Zoho.
 *
 * Two sheets, deliberately:
 *
 *   "Duplicated deals"  ONE ROW PER DEAL. The recipient acts on individual
 *                       deals — they filter to their own name, sort by value,
 *                       paste rows into a task list. A single cell holding
 *                       three deals as text cannot be sorted or filtered,
 *                       which is what makes a grouped export useless in
 *                       practice. Every row repeats its company so the sheet
 *                       stands alone when filtered.
 *
 *   "Summary"           ONE ROW PER COMPANY, for the covering read: how many
 *                       deals, how many owners, who they are, how much is open.
 *
 * There is deliberately NO "How to read this" sheet. It existed to carry the
 * caveats — open-deals-only, how deals are grouped, and that KEEP / CLOSE is a
 * recommendation rather than an instruction from the CRM. Sarah moved those
 * notes into the covering email (2026-09-03), where the recipient actually
 * reads them, so repeating them on a tab nobody opens was noise. The caveats
 * still have to travel WITH the numbers — if the email stops carrying them,
 * this sheet needs to come back rather than the caveats being dropped.
 */
import type { SheetSpec } from "./excelExport";
import { FMT_SAR } from "./dealComplianceReportExport";
import type { MultiActiveDealAccount } from "./duplicateRadarDatabase";

/** Deep link to the deal record, so every row can be checked before acting. */
export function dealZohoUrl(id: string): string {
  return `https://crm.zoho.com/crm/org766568398/tab/Deals/${encodeURIComponent(id)}`;
}

/** ISO timestamp → YYYY-MM-DD. Excel sorts these lexically = chronologically. */
function day(v: string | null | undefined): string {
  return v ? String(v).slice(0, 10) : "";
}

export function multiActiveDealsFilename(segment: string): string {
  const safe = String(segment || "walaplus").replace(/[^a-z0-9_-]/gi, "");
  return `active-deal-conflicts-${safe}.xlsx`;
}

export function buildMultiActiveDealSheets(
  accounts: MultiActiveDealAccount[],
  opts: { segment: string; multiOwnerOnly: boolean },
): SheetSpec[] {
  const dealRows: Record<string, any>[] = [];
  const summaryRows: Record<string, any>[] = [];

  for (const a of accounts) {
    summaryRows.push({
      company: a.account_name || "",
      domain: a.domain || "",
      account_id: a.account_id || "",
      open_deals: a.open_deals,
      owners_count: a.distinct_owners,
      owners: (a.owners || []).join(", "),
      open_value: Math.round(a.total_open_value),
      // What the recipient has to decide, spelled out per company rather than
      // left for them to work out from the deal sheet.
      action: `Keep 1 deal, close ${Math.max(0, a.open_deals - 1)}`,
    });
    for (const d of a.deals || []) {
      dealRows.push({
        company: a.account_name || "",
        domain: a.domain || "",
        recommendation: d.suggestion === "keep" ? "KEEP" : "CLOSE",
        deal: d.name || "",
        stage: d.stage || "",
        owner: d.owner || "",
        layout: d.layout || "",
        amount: Math.round(d.amount || 0),
        created: day(d.created),
        last_activity: day(d.last_activity),
        why: d.suggestion_reason || "",
        deal_id: d.id || "",
        // Excel turns a bare URL in a cell into a link on click, and the raw
        // text survives copy/paste into an email — both matter more here than
        // a styled hyperlink object.
        zoho_link: d.id ? dealZohoUrl(String(d.id)) : "",
      });
    }
  }

  return [
    {
      name: "Summary",
      columns: [
        { header: "Company", key: "company", width: 38 },
        { header: "Domain", key: "domain", width: 22 },
        { header: "Account ID", key: "account_id", width: 22 },
        { header: "Open deals", key: "open_deals", width: 11 },
        { header: "Owners", key: "owners_count", width: 9 },
        { header: "Owner names", key: "owners", width: 46 },
        { header: "Open value (SAR)", key: "open_value", width: 19, numFmt: FMT_SAR },
        { header: "Action needed", key: "action", width: 24 },
      ],
      rows: summaryRows,
    },
    {
      name: "Duplicated deals",
      columns: [
        { header: "Company", key: "company", width: 38 },
        { header: "Domain", key: "domain", width: 22 },
        { header: "Recommendation", key: "recommendation", width: 16 },
        { header: "Deal", key: "deal", width: 34 },
        { header: "Stage", key: "stage", width: 18 },
        { header: "Deal owner", key: "owner", width: 22 },
        { header: "Layout", key: "layout", width: 14 },
        { header: "Amount (SAR)", key: "amount", width: 17, numFmt: FMT_SAR },
        { header: "Created", key: "created", width: 12 },
        { header: "Last activity", key: "last_activity", width: 13 },
        { header: "Why", key: "why", width: 46 },
        { header: "Deal ID", key: "deal_id", width: 22 },
        { header: "Open in Zoho", key: "zoho_link", width: 58 },
      ],
      rows: dealRows,
    },
  ];
}
