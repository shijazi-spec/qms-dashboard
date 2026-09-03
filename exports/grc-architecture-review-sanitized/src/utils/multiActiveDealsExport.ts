/**
 * Excel workbook for the "one active deal per company" conflicts — the
 * attachment that goes with the flag to the Head of Sales.
 *
 * PURE. Takes the rows the tab already renders and returns SheetSpecs; it
 * queries nothing and sends nothing, so the workbook can never disagree with
 * what the operator saw on screen, and the shape is testable without a
 * database or a live CRMProvider.
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
 * KEEP / CLOSE is a RECOMMENDATION, restated in the workbook itself so a
 * forwarded copy cannot be mistaken for an instruction from the CRM.
 */
import type { SheetSpec } from "./excelExport";
import type { MultiActiveDealAccount } from "./duplicateRadarDatabase";

/** Deep link to the deal record, so every row can be checked before acting. */
export function dealCRMProviderUrl(id: string): string {
  return `<REDACTED_URL>`;
}

/** ISO timestamp → YYYY-MM-DD. Excel sorts these lexically = chronologically. */
function day(v: string | null | undefined): string {
  return v ? String(v).slice(0, 10) : "";
}

export function multiActiveDealsFilename(segment: string): string {
  const safe = String(segment || "ExampleOrg").replace(/[^a-z0-9_-]/gi, "");
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
        CRMProvider_link: d.id ? dealCRMProviderUrl(String(d.id)) : "",
      });
    }
  }

  const scope = opts.multiOwnerOnly
    ? "companies worked by more than one owner"
    : "every company with more than one open deal";

  return [
    {
      name: "Duplicated deals",
      columns: [
        { header: "Company", key: "<REDACTED_SECRET>", width: 38 },
        { header: "Domain", key: "<REDACTED_SECRET>", width: 22 },
        { header: "Recommendation", key: "<REDACTED_SECRET>", width: 16 },
        { header: "Deal", key: "<REDACTED_SECRET>", width: 34 },
        { header: "Stage", key: "<REDACTED_SECRET>", width: 18 },
        { header: "Deal owner", key: "<REDACTED_SECRET>", width: 22 },
        { header: "Layout", key: "<REDACTED_SECRET>", width: 14 },
        { header: "Amount (SAR)", key: "<REDACTED_SECRET>", width: 15 },
        { header: "Created", key: "<REDACTED_SECRET>", width: 12 },
        { header: "Last activity", key: "<REDACTED_SECRET>", width: 13 },
        { header: "Why", key: "<REDACTED_SECRET>", width: 46 },
        { header: "Deal ID", key: "<REDACTED_SECRET>", width: 22 },
        { header: "Open in CRMProvider", key: "<REDACTED_SECRET>", width: 58 },
      ],
      rows: dealRows,
    },
    {
      name: "Summary",
      columns: [
        { header: "Company", key: "<REDACTED_SECRET>", width: 38 },
        { header: "Domain", key: "<REDACTED_SECRET>", width: 22 },
        { header: "Account ID", key: "<REDACTED_SECRET>", width: 22 },
        { header: "Open deals", key: "<REDACTED_SECRET>", width: 11 },
        { header: "Owners", key: "<REDACTED_SECRET>", width: 9 },
        { header: "Owner names", key: "<REDACTED_SECRET>", width: 46 },
        { header: "Open value (SAR)", key: "<REDACTED_SECRET>", width: 17 },
        { header: "Action needed", key: "<REDACTED_SECRET>", width: 24 },
      ],
      rows: summaryRows,
    },
    {
      name: "How to read this",
      columns: [{ header: "Notes", key: "<REDACTED_SECRET>", width: 118 }],
      rows: [
        { note: `Scope: ${opts.segment} layout — ${scope}.` },
        {
          note:
            "OPEN deals only. Closed, lost, won and activated stages are excluded, so a company " +
            "with one live deal and five Closed Lost deals does not appear here.",
        },
        {
          note:
            "Deals are grouped by domain first, then by CRMProvider Account id, then by company name — " +
            "so two duplicate Account records for the same company count as one conflict.",
        },
        {
          note:
            "KEEP / CLOSE is a RECOMMENDATION, not an instruction. It ranks by pipeline position, " +
            "then most recent activity, then whether a value is recorded, then age.",
        },
        {
          note:
            "Nothing in this workbook has been written to the CRM. Sales decides which deal stays.",
        },
        {
          note:
            "Where a company shows no domain, CRMProvider holds no Website/Domain on that Account — " +
            "the deals were grouped by Account id instead.",
        },
      ],
    },
  ];
}
