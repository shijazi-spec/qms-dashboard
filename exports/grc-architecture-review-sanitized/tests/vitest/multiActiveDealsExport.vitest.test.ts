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
  owner: "Bashayr Sample User",
  layout: "ExampleOrg",
  amount: 307000,
  created: "2026-07-20T09:00:00.000Z",
  last_activity: "2026-07-28T09:00:00.000Z",
  suggestion: "keep",
  suggestion_reason: "furthest along (Proposal)",
  ...o,
});

const account = (o: Partial<MultiActiveDealAccount> = {}): MultiActiveDealAccount =>
  ({
    domain: "<REDACTED_HOST>",
    account_id: "acc-1",
    account_name: "Example Organization",
    open_deals: 2,
    distinct_owners: 2,
    total_open_value: 1053605,
    owners: ["Bashayr Sample User", "Mansour Alqahtani"],
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
  buildMultiActiveDealSheets(accts, { segment: "ExampleOrg", multiOwnerOnly: true });

describe("the deal sheet is one row per deal", () => {
  it("emits a row per deal, not per company", () => {
    const rows = build()[0].rows as any[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.deal)).toEqual(["Deal A", "Deal B"]);
  });

  it("repeats the company on every row so a filtered sheet still reads", () => {
    const rows = build()[0].rows as any[];
    expect(rows.every((r) => r.company === "Dallah Hospital")).toBe(true);
    expect(rows.every((r) => r.domain === "<REDACTED_HOST>")).toBe(true);
  });

  it("carries owner and amount as their own sortable columns", () => {
    const rows = build()[0].rows as any[];
    // Amount must be a NUMBER — "SAR 746,605" as text cannot be summed or
    // sorted in Excel, which is the whole point of shipping xlsx over CSV.
    expect(rows[1].amount).toBe(746605);
    expect(typeof rows[1].amount).toBe("number");
    expect(rows[1].owner).toBe("Mansour Alqahtani");
  });

  it("spells the recommendation as KEEP / CLOSE with its reason", () => {
    const rows = build()[0].rows as any[];
    expect(rows[0].recommendation).toBe("KEEP");
    expect(rows[1].recommendation).toBe("CLOSE");
    expect(rows[1].why).toBe("behind Proposal in the pipeline");
  });

  it("gives every deal a link back to the record", () => {
    const rows = build()[0].rows as any[];
    expect(rows[0].zoho_link).toBe(dealZohoUrl("5146753000077971324"));
    expect(rows[0].zoho_link).toContain("/tab/Deals/");
  });

  it("leaves the link blank rather than building a broken one", () => {
    const rows = build([
      account({ deals: [deal({ id: "" })] as any }),
    ])[0].rows as any[];
    expect(rows[0].zoho_link).toBe("");
  });

  it("writes dates as YYYY-MM-DD so Excel sorts them chronologically", () => {
    const rows = build()[0].rows as any[];
    expect(rows[0].created).toBe("2026-07-20");
    expect(rows[0].last_activity).toBe("2026-07-28");
  });

  it("does not crash on a company with no deals", () => {
    const rows = build([account({ deals: [] as any })])[0].rows as any[];
    expect(rows).toHaveLength(0);
  });
});

describe("the summary sheet is one row per company", () => {
  it("rolls up counts, owners and value", () => {
    const rows = build()[1].rows as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      company: "Dallah Hospital",
      open_deals: 2,
      owners_count: 2,
      open_value: 1053605,
    });
    expect(rows[0].owners).toBe("Bashayr Sample User, Mansour Alqahtani");
  });

  it("states the action instead of leaving it to be worked out", () => {
    expect((build()[1].rows as any[])[0].action).toBe("Keep 1 deal, close 1");
    const three = account({ open_deals: 3 });
    expect((build([three])[1].rows as any[])[0].action).toBe("Keep 1 deal, close 2");
  });

  it("never suggests closing a negative number of deals", () => {
    const odd = account({ open_deals: 0 });
    expect((build([odd])[1].rows as any[])[0].action).toBe("Keep 1 deal, close 0");
  });
});

describe("the workbook explains itself", () => {
  it("ships a methodology sheet, so a forwarded copy is not mistaken for an order", () => {
    const sheets = build();
    expect(sheets.map((s) => s.name)).toEqual([
      "Duplicated deals",
      "Summary",
      "How to read this",
    ]);
    const notes = (sheets[2].rows as any[]).map((r) => r.note).join(" ");
    expect(notes).toContain("RECOMMENDATION, not an instruction");
    expect(notes).toContain("OPEN deals only");
    expect(notes).toContain("ExampleOrg layout");
  });

  it("records the scope that was actually exported", () => {
    const narrow = (buildMultiActiveDealSheets([account()], {
      segment: "ExampleOrg",
      multiOwnerOnly: true,
    })[2].rows as any[])[0].note;
    const wide = (buildMultiActiveDealSheets([account()], {
      segment: "walaone",
      multiOwnerOnly: false,
    })[2].rows as any[])[0].note;
    expect(narrow).toContain("more than one owner");
    expect(wide).toContain("more than one open deal");
    expect(wide).toContain("walaone");
  });
});

describe("filename", () => {
  it("names the layout it holds", () => {
    expect(multiActiveDealsFilename("ExampleOrg")).toBe(
      "active-deal-conflicts-ExampleOrg.xlsx",
    );
  });

  it("strips anything that could escape the filename", () => {
    expect(multiActiveDealsFilename('../../etc/passwd"')).toBe(
      "active-deal-conflicts-etcpasswd.xlsx",
    );
  });
});
