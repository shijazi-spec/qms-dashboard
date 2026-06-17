import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { updateZohoRecord, zohoWritesAllowedInEnv } from "../../utils/zohoCRM";
import { withTimeout } from "../../utils/promiseTimeout";

const ZOHO_WRITE_TIMEOUT_MS = 15_000;

/**
 * Link Contacts / Deals to an Account — the chat-side of the cross-module LINK
 * rule. Zoho can't merge across modules, so the correct fix for a Contact/Deal
 * that belongs under an existing Account is to set its Account_Name lookup.
 *
 * This IS a write tool (it sets Account_Name in Zoho via updateZohoRecord). It
 * is wrapped with withApprovalGate in the agent, so a call enqueues an AI
 * Approval card (module, account, record ids) for a Quality Manager / admin to
 * approve before it actually writes — and Slack callers (autoApproveTier
 * "never") can never auto-execute it. Adam DOES have write capability — tagging
 * for removal AND this link — he just routes risky writes through approval.
 *
 * Typical flow: user identifies the contact/deal + the target account (e.g. via
 * lookup-entity) → Adam confirms → calls this with the module, the record ids,
 * and the target Account's Zoho id.
 */
export const linkRecordToAccountTool = createTool({
  id: "link-records-to-account",

  description:
    "Link Zoho Contacts or Deals to an existing Account by setting their Account_Name lookup (the cross-module LINK fix — Zoho can't merge across modules). Use when a contact/deal should sit under a different/existing account. Provide the module (Contacts or Deals), the Zoho record ids to relink, and the target Account's Zoho id (get all ids from lookup-entity first, and confirm with the user). This is a gated write — it enqueues an AI Approval, so report the approval ticket and do NOT claim the link was made until it is approved. You DO have write capability; you are not read-only — you just route writes through approval.",

  inputSchema: z.object({
    module: z
      .enum(["Contacts", "Deals"])
      .describe("Module of the records being linked (only Contacts/Deals have an Account_Name lookup)"),
    recordIds: z
      .array(z.string())
      .min(1)
      .describe("Zoho record ids of the contacts/deals to relink (from lookup-entity)"),
    accountZohoId: z
      .string()
      .min(1)
      .describe("Zoho id of the target Account to link them under"),
    reason: z
      .string()
      .optional()
      .describe("Short reason / context for the audit trail (e.g. 'moved to correct parent account')"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    module: z.string(),
    accountZohoId: z.string(),
    linked: z.number(),
    failed: z.number(),
    message: z.string(),
    error: z.string().optional(),
  }),

  execute: async ({ context }) => {
    const ids = (context.recordIds || []).map(String).filter(Boolean);
    const accountId = String(context.accountZohoId || "").trim();
    if (!ids.length || !accountId) {
      return {
        success: false,
        module: context.module,
        accountZohoId: accountId,
        linked: 0,
        failed: 0,
        message: "Provide both record ids and a target accountZohoId.",
        error: "missing recordIds or accountZohoId",
      };
    }
    if (!zohoWritesAllowedInEnv()) {
      return {
        success: false,
        module: context.module,
        accountZohoId: accountId,
        linked: 0,
        failed: 0,
        message:
          "Linking is blocked outside production (dev shares production's Zoho credentials). Run it from the deployed app.",
        error: "live Zoho writes disabled outside production",
      };
    }
    let linked = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const id of ids) {
      try {
        // Account_Name is a lookup field — Zoho expects the related record id.
        await withTimeout(
          updateZohoRecord(context.module, id, {
            Account_Name: { id: accountId },
          }),
          ZOHO_WRITE_TIMEOUT_MS,
          `link ${id}`,
        );
        linked++;
      } catch (e: any) {
        failed++;
        errors.push(`${id}: ${e?.message || String(e)}`);
      }
    }
    return {
      success: failed === 0,
      module: context.module,
      accountZohoId: accountId,
      linked,
      failed,
      message:
        failed === 0
          ? `Linked ${linked} ${context.module} record(s) to account ${accountId}.`
          : `Linked ${linked}, failed ${failed}. See error for details.`,
      ...(errors.length ? { error: errors.join("; ") } : {}),
    };
  },
});
