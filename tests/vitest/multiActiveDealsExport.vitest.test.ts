/**
 * The Excel workbook that goes to the Head of Sales.
 *
 * The thing that makes or breaks this file is the SHAPE, not the styling: the
 * recipient filters the sheet to their own name and sorts it by value. A
 * export that groups three deals into one cell cannot be filtered or sorted,
 * and is the reason a grouped CSV gets ignored. So the deal sheet is one row
 * per deal, with the company repeated on every row.
 */
import { describe, it, expect } from "vitest";
import {
  buildMultiActiveDealSheets,
  multiActiveDealsFilename,
  dealZohoUrl,
} from "../../src/utils/multiActiveDealsExport";
import type { MultiActiveDealAccount } from "../../src/utils/duplicateRadarDatabase";

const deal = (o: Partial<any> = {}): any => ({
  id: "5146753000077971324",
  name: "Deal A",
  stage: "Proposal",
  owner: "Bashayr ahmad",
  layout: "WalaPlus",
  amount: 307000,
  created: "2026-07-20T09:00:00.000Z",
  last_activity: "2026-07-28T09:00:00.000Z",
  suggestion: "keep",
  suggestion_reason: "furthest along (Proposal)",
  ...o,
});

const account = (o: Partial<MultiActiveDealAccount> = {}): MultiActiveDealAccount =>
  ({
    domain: "dallah-hospital.com",
    account_id: "acc-1",
    account_name: "Dallah Hospital",
    open_deals: 2,
    distinct_owners: 2,
    total_open_value: 1053605,
    owners: ["Bashayr ahmad", "Mansour Alqahtani"],
    deals: [
      deal(),
      deal({
        id: "5146753000091183102",
        name: "Deal B",
        stage: "On Hold",
        owner: "Mansour Alqahtani",
        amount: 746605,
        suggestion: "close",
        suggestion_reason: "behind Proposal in the pipeline",
      }),
    ],
    ...o,
  }) as MultiActiveDealAccount;

const build = (accts: MultiActiveDealAccount[] = [account()]) =>
  buildMultiActiveDealSheets(accts, { segment: "walaplus", multiOwnerOnly: true });

/** By NAME, never by index: Sarah reordered the sheets on 2026-09-03 and every
 *  positional lookup in this file silently pointed at the wrong one. */
const sheet = (name: string, accts?: MultiActiveDealAccount[]) =>
  build(accts).find((s) => s.name === name)!;
const rowsOf = (name: string, accts?: MultiActiveDealAccount[]) =>
  sheet(name, accts).rows as any[];

describe("the deal sheet is one row per deal", () => {
  it("emits a row per deal, not per company", () => {
    const rows = rowsOf("Duplicated deals");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.deal)).toEqual(["Deal A", "Deal B"]);
  });

  it("repeats the company on every row so a filtered sheet still reads", () => {
    const rows = rowsOf("Duplicated deals");
    expect(rows.every((r) => r.company === "Dallah Hospital")).toBe(true);
    expect(rows.every((r) => r.domain === "dallah-hospital.com")).toBe(true);
  });

  it("carries owner and amount as their own sortable columns", () => {
    const rows = rowsOf("Duplicated deals");
    // Amount must be a NUMBER — "SAR 746,605" as text cannot be summed or
    // sorted in Excel, which is the whole point of shipping xlsx over CSV.
    expect(rows[1].amount).toBe(746605);
    expect(typeof rows[1].amount).toBe("number");
    expect(rows[1].owner).toBe("Mansour Alqahtani");
  });

  it("spells the recommendation as KEEP / CLOSE with its reason", () => {
    const rows = rowsOf("Duplicated deals");
    expect(rows[0].recommendation).toBe("KEEP");
    expect(rows[1].recommendation).toBe("CLOSE");
    expect(rows[1].why).toBe("behind Proposal in the pipeline");
  });

  it("gives every deal a link back to the record", () => {
    const rows = rowsOf("Duplicated deals");
    expect(rows[0].zoho_link).toBe(dealZohoUrl("5146753000077971324"));
    expect(rows[0].zoho_link).toContain("/tab/Deals/");
  });

  it("leaves the link blank rather than building a broken one", () => {
    const rows = rowsOf("Duplicated deals", [account({ deals: [deal({ id: "" })] as any })]);
    expect(rows[0].zoho_link).toBe("");
  });

  it("writes dates as YYYY-MM-DD so Excel sorts them chronologically", () => {
    const rows = rowsOf("Duplicated deals");
    expect(rows[0].created).toBe("2026-07-20");
    expect(rows[0].last_activity).toBe("2026-07-28");
  });

  it("does not crash on a company with no deals", () => {
    const rows = rowsOf("Duplicated deals", [account({ deals: [] as any })]);
    expect(rows).toHaveLength(0);
  });
});

describe("the summary sheet is one row per company", () => {
  it("rolls up counts, owners and value", () => {
    const rows = rowsOf("Summary");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      company: "Dallah Hospital",
      open_deals: 2,
      owners_count: 2,
      open_value: 1053605,
    });
    expect(rows[0].owners).toBe("Bashayr ahmad, Mansour Alqahtani");
  });

  it("states the action instead of leaving it to be worked out", () => {
    expect(rowsOf("Summary")[0].action).toBe("Keep 1 deal, close 1");
    const three = account({ open_deals: 3 });
    expect(rowsOf("Summary", [three])[0].action).toBe("Keep 1 deal, close 2");
  });

  it("never suggests closing a negative number of deals", () => {
    const odd = account({ open_deals: 0 });
    expect(rowsOf("Summary", [odd])[0].action).toBe("Keep 1 deal, close 0");
  });
});

describe("the workbook carries data, not commentary", () => {
  // The "How to read this" sheet was removed on 2026-09-03: Sarah moved the
  // caveats into the covering email, where the recipient reads them, rather
  // than a tab nobody opens.
  //
  // The caveats still have to travel WITH the numbers. If the email ever stops
  // carrying them, the sheet comes back — dropping them entirely would leave a
  // forwarded workbook reading as an instruction from the CRM, which it is not.
  it("ships exactly the two data sheets", () => {
    // Summary FIRST — the covering read before the per-deal detail.
    expect(build().map((s) => s.name)).toEqual(["Summary", "Duplicated deals"]);
  });

  it("keeps the scope legible from the data itself", () => {
    // With no notes sheet, the layout has to be readable from the rows — it is,
    // via the per-deal Layout column — and from the filename.
    const dealCols = sheet("Duplicated deals").columns.map((c) => c.key);
    expect(dealCols).toContain("layout");
    expect(multiActiveDealsFilename("walaplus")).toContain("walaplus");
  });

  it("still states the action per company, which is the one instruction that belongs here", () => {
    expect(rowsOf("Summary")[0].action).toBe("Keep 1 deal, close 1");
  });
});

describe("filename", () => {
  it("names the layout it holds", () => {
    expect(multiActiveDealsFilename("walaplus")).toBe(
      "active-deal-conflicts-walaplus.xlsx",
    );
  });

  it("strips anything that could escape the filename", () => {
    expect(multiActiveDealsFilename('../../etc/passwd"')).toBe(
      "active-deal-conflicts-etcpasswd.xlsx",
    );
  });
});
