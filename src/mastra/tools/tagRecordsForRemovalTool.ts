import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { addZohoTags, zohoWritesAllowedInEnv } from "../../utils/zohoCRM";

/**
 * Tag Zoho records for removal — the chat-side of the migrate-then-tag rule.
 *
 * Adam can FLAG leads/deals/contacts/accounts with the agreed removal tag
 * (default "Duplicate-Delete") so the CRM admin can delete them. Adam NEVER
 * deletes records himself. This is a WRITE tool: it is wrapped with
 * withApprovalGate in the agent, so a call enqueues an AI Approval card
 * (with the module, tag, and record ids) for a Quality Manager / admin to
 * approve before the tag is actually applied — and Slack callers
 * (autoApproveTier "never") can never auto-execute it.
 *
 * Typical flow: user gives a phone/email/company → Adam finds the records via
 * lookup-entity → confirms the list with the user → calls this tool with the
 * module + the Zoho record ids to tag.
 */

export const DEFAULT_REMOVAL_TAG = "Duplicate-Delete";

export const tagRecordsForRemovalTool = createTool({
  id: "tag-records-for-removal",

  description:
    "Flag Zoho CRM records for removal by applying the agreed removal tag (default \"Duplicate-Delete\") so the CRM admin can delete them. Use AFTER finding the records (e.g. via lookup-entity by phone/email/company) and confirming the list with the user. Provide the module and the Zoho record ids. This NEVER deletes records — it only tags them — and it is gated by the AI Approvals queue, so report the approval ticket and do NOT claim the tag was applied until it is approved.",

  inputSchema: z.object({
    module: z
      .enum(["Leads", "Deals", "Contacts", "Accounts"])
      .describe("Zoho module the records belong to"),
    recordIds: z
      .array(z.string())
      .min(1)
      .describe("Zoho record ids to tag (get these from lookup-entity first)"),
    tag: z
      .string()
      .optional()
      .describe(`Tag to apply. Defaults to "${DEFAULT_REMOVAL_TAG}" (the agreed removal tag).`),
    reason: z
      .string()
      .optional()
      .describe("Short reason / context for the audit trail (e.g. 'duplicate of X', 'wrong number')"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    module: z.string(),
    tag: z.string(),
    tagged: z.number(),
    message: z.string(),
    error: z.string().optional(),
  }),

  execute: async ({ context }) => {
    const tag = (context.tag && context.tag.trim()) || DEFAULT_REMOVAL_TAG;
    const ids = (context.recordIds || []).map(String).filter(Boolean);
    if (!ids.length) {
      return {
        success: false,
        module: context.module,
        tag,
        tagged: 0,
        message: "No record ids provided.",
        error: "recordIds is empty",
      };
    }
    if (!zohoWritesAllowedInEnv()) {
      return {
        success: false,
        module: context.module,
        tag,
        tagged: 0,
        message:
          "Tagging is blocked outside production (dev shares production's Zoho credentials). Run it from the deployed app.",
        error: "live Zoho writes disabled outside production",
      };
    }
    try {
      await addZohoTags(context.module, ids, [tag]);
      return {
        success: true,
        module: context.module,
        tag,
        tagged: ids.length,
        message: `Tagged ${ids.length} ${context.module} record(s) with "${tag}" for the CRM admin to remove.`,
      };
    } catch (e: any) {
      return {
        success: false,
        module: context.module,
        tag,
        tagged: 0,
        message: "Failed to apply the tag in Zoho.",
        error: e?.message || String(e),
      };
    }
  },
});
