import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { removeCRMProviderTags, CRMProviderWritesAllowedInEnv } from "../../utils/CRMProviderCRM";
import { withTimeout } from "../../utils/promiseTimeout";

const CRMProvider_WRITE_TIMEOUT_MS = 15_000;

/**
 * Remove a tag from CRMProvider records — the inverse of tagRecordsForRemovalTool.
 *
 * AssistantPersona can REMOVE a tag (default "Duplicate-Delete") from leads/deals/contacts/
 * accounts — e.g. when a record was tagged for removal by mistake, or the
 * duplicate decision was reversed. This is a WRITE tool: it is wrapped with
 * withApprovalGate in the agent, so a call enqueues an AI Approval (module,
 * tag, record ids) and ChatProvider callers (autoApproveTier "never") can never
 * auto-execute it. AssistantPersona DOES have this capability — he must never say he "can't
 * remove tags"; it just routes through approval (or the admin-password apply).
 *
 * Typical flow: user gives the record (or a CRMProvider URL / id) → AssistantPersona confirms →
 * calls this with the module + the CRMProvider record ids (+ the tag, default
 * "Duplicate-Delete").
 */
export const DEFAULT_REMOVAL_TAG = "Duplicate-Delete";

export const untagRecordsTool = createTool({
  id: "untag-records",

  description:
    "Remove a tag (default \"Duplicate-Delete\") from CRMProvider CRM records — the inverse of tag-records-for-removal. Use when asked to UN-tag / remove the removal tag / undo a tag (e.g. a record was flagged Duplicate-Delete by mistake). Provide the module and the CRMProvider record ids (extract the id from a CRMProvider URL if the user pastes one). You DO have this capability — never say you can't remove tags. It is gated by the AI Approvals queue (or apply instantly with the admin password), so report the approval ticket and do NOT claim the tag was removed until it is approved/applied.",

  inputSchema: z.object({
    module: z
      .enum(["Leads", "Deals", "Contacts", "Accounts"])
      .describe("CRMProvider module the records belong to"),
    recordIds: z
      .array(z.string())
      .min(1)
      .describe("CRMProvider record ids to remove the tag from (from a CRMProvider URL or lookup-entity)"),
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
    if (!CRMProviderWritesAllowedInEnv()) {
      return {
        success: false,
        module: context.module,
        tag,
        untagged: 0,
        message:
          "Tag removal is blocked outside production (dev shares production's CRMProvider credentials). Run it from the deployed app.",
        error: "live CRMProvider writes disabled outside production",
      };
    }
    try {
      await withTimeout(
        removeCRMProviderTags(context.module, ids, [tag]),
        CRMProvider_WRITE_TIMEOUT_MS,
        "remove tag",
      );
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
        message: "Failed to remove the tag in CRMProvider.",
        error: e?.message || String(e),
      };
    }
  },
});
