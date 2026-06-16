import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { removeZohoTags, zohoWritesAllowedInEnv } from "../../utils/zohoCRM";

/**
 * Remove a tag from Zoho records — the inverse of tagRecordsForRemovalTool.
 *
 * Adam can REMOVE a tag (default "Duplicate-Delete") from leads/deals/contacts/
 * accounts — e.g. when a record was tagged for removal by mistake, or the
 * duplicate decision was reversed. This is a WRITE tool: it is wrapped with
 * withApprovalGate in the agent, so a call enqueues an AI Approval (module,
 * tag, record ids) and Slack callers (autoApproveTier "never") can never
 * auto-execute it. Adam DOES have this capability — he must never say he "can't
 * remove tags"; it just routes through approval (or the admin-password apply).
 *
 * Typical flow: user gives the record (or a Zoho URL / id) → Adam confirms →
 * calls this with the module + the Zoho record ids (+ the tag, default
 * "Duplicate-Delete").
 */
export const DEFAULT_REMOVAL_TAG = "Duplicate-Delete";

export const untagRecordsTool = createTool({
  id: "untag-records",

  description:
    "Remove a tag (default \"Duplicate-Delete\") from Zoho CRM records — the inverse of tag-records-for-removal. Use when asked to UN-tag / remove the removal tag / undo a tag (e.g. a record was flagged Duplicate-Delete by mistake). Provide the module and the Zoho record ids (extract the id from a Zoho URL if the user pastes one). You DO have this capability — never say you can't remove tags. It is gated by the AI Approvals queue (or apply instantly with the admin password), so report the approval ticket and do NOT claim the tag was removed until it is approved/applied.",

  inputSchema: z.object({
    module: z
      .enum(["Leads", "Deals", "Contacts", "Accounts"])
      .describe("Zoho module the records belong to"),
    recordIds: z
      .array(z.string())
      .min(1)
      .describe("Zoho record ids to remove the tag from (from a Zoho URL or lookup-entity)"),
    tag: z
      .string()
      .optional()
      .describe(`Tag to remove. Defaults to "${DEFAULT_REMOVAL_TAG}".`),
    reason: z
      .string()
      .optional()
      .describe("Short reason / context for the audit trail (e.g. 'tagged by mistake', 'not a duplicate')"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    module: z.string(),
    tag: z.string(),
    untagged: z.number(),
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
        untagged: 0,
        message: "No record ids provided.",
        error: "recordIds is empty",
      };
    }
    if (!zohoWritesAllowedInEnv()) {
      return {
        success: false,
        module: context.module,
        tag,
        untagged: 0,
        message:
          "Tag removal is blocked outside production (dev shares production's Zoho credentials). Run it from the deployed app.",
        error: "live Zoho writes disabled outside production",
      };
    }
    try {
      await removeZohoTags(context.module, ids, [tag]);
      return {
        success: true,
        module: context.module,
        tag,
        untagged: ids.length,
        message: `Removed the "${tag}" tag from ${ids.length} ${context.module} record(s).`,
      };
    } catch (e: any) {
      return {
        success: false,
        module: context.module,
        tag,
        untagged: 0,
        message: "Failed to remove the tag in Zoho.",
        error: e?.message || String(e),
      };
    }
  },
});
