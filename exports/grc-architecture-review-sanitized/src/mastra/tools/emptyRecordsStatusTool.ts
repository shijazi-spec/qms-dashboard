import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/**
 * Read tool for the "Empty / Orphaned Records" CRM-cleanup tab so Adam can
 * answer "how many empty / orphaned / test records do we have to clean?" with
 * real numbers. Reuses the exact detection the tab uses. Read-only — the
 * platform never deletes; it tags "Empty-Delete" for the CRMProvider admin to delete.
 */
export const emptyRecordsStatusTool = createTool({
  id: "empty-records-status",
  description:
    "Counts of junk CRM records flagged by the 'Empty / Orphaned Records' cleanup tab (Duplicate Radar). Per module returns: Deals — orphaned (no Account → should be LINKED to an account, not deleted), empty (no account/contact/amount), test (name like 'Test'/'dummy'/whole-name 'name' junk); Accounts — empty (no deals & no contacts; needs a per-row attachment check before it's delete-eligible) + test; Contacts — empty (name-only: no email/phone/account/deal) + test. Also returns deleteEligible per module (how many would receive the Empty-Delete tag). The platform NEVER deletes — it tags Empty-Delete for the CRMProvider admin to delete; orphaned deals are linked instead. Counts capped at 500/module. Use for 'how much empty/test data is there to clean?'. Read-only.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    success: z.boolean(),
    deals: z
      .object({
        total: z.number(),
        orphaned: z.number(),
        empty: z.number(),
        test: z.number(),
        deleteEligible: z.number(),
      })
      .optional(),
    accounts: z
      .object({
        total: z.number(),
        empty: z.number(),
        test: z.number(),
        deleteEligible: z.number(),
      })
      .optional(),
    contacts: z
      .object({
        total: z.number(),
        empty: z.number(),
        test: z.number(),
        deleteEligible: z.number(),
      })
      .optional(),
    note: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async () => {
    try {
      const { getEmptyDeals, getEmptyAccounts, getEmptyContacts } =
        await import("../../utils/emptyRecordsDatabase");
      const [deals, accounts, contacts] = await Promise.all([
        getEmptyDeals(),
        getEmptyAccounts(),
        getEmptyContacts(),
      ]);
      const count = (rows: any[], reason: string) =>
        rows.filter((r) => r.reason === reason).length;
      const del = (rows: any[]) => rows.filter((r) => r.deleteEligible).length;
      return {
        success: true,
        deals: {
          total: deals.length,
          orphaned: count(deals, "orphaned"),
          empty: count(deals, "empty"),
          test: count(deals, "test"),
          deleteEligible: del(deals),
        },
        accounts: {
          total: accounts.length,
          empty: count(accounts, "empty"),
          test: count(accounts, "test"),
          deleteEligible: del(accounts),
        },
        contacts: {
          total: contacts.length,
          empty: count(contacts, "empty"),
          test: count(contacts, "test"),
          deleteEligible: del(contacts),
        },
        note: "Counts capped at 500/module. Empty accounts need a per-row attachment check before they become delete-eligible. The platform only tags Empty-Delete; the CRMProvider admin performs deletion. Orphaned deals are LINKED to an account, not deleted.",
      };
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) };
    }
  },
});
