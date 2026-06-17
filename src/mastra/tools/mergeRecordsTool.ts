import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  fetchZohoRecordById,
  updateZohoRecord,
  addZohoTags,
  zohoWritesAllowedInEnv,
} from "../../utils/zohoCRM";

/**
 * Merge duplicate records the WalaPlus way: migrate-then-tag, NEVER a destructive
 * Zoho native merge and NEVER a delete. Keep the survivor, copy the survivor's
 * MISSING simple fields from the duplicate(s) (blanks-only — never overwrite),
 * and tag the duplicate(s) "Duplicate-Delete" so the CRM admin deletes them.
 *
 * Gated (withApprovalGate in the agent) → enqueues an AI Approval / applies via
 * the admin-password pop-up. Adam DOES have this capability — never "I can't
 * merge accounts".
 *
 * Safety: only fills fields that are (a) empty on the survivor, (b) a non-empty
 * scalar on the duplicate, and (c) not a system/readonly/lookup field. So it
 * can't overwrite survivor data, can't touch lookups/multiselects, and never
 * deletes anything.
 */
export const DEFAULT_REMOVAL_TAG = "Duplicate-Delete";

// Never copy from a duplicate and never write to the survivor — system/readonly
// fields, and name/lookup fields (the survivor keeps its own identity + parent).
const PROTECTED_FIELDS = new Set<string>([
  "id",
  "Created_Time",
  "Modified_Time",
  "Created_By",
  "Modified_By",
  "Owner",
  "Last_Activity_Time",
  "Tag",
  "Layout",
  "Record_Image",
  "Account_Name",
  "Parent_Account",
  "Contact_Name",
  "Deal_Name",
  "Full_Name",
  "First_Name",
  "Last_Name",
]);

function isFilledScalar(v: any): boolean {
  return (
    (typeof v === "string" && v.trim() !== "") ||
    typeof v === "number" ||
    typeof v === "boolean"
  );
}
function isEmpty(v: any): boolean {
  return (
    v === null ||
    v === undefined ||
    (typeof v === "string" && v.trim() === "")
  );
}

export const mergeRecordsTool = createTool({
  id: "merge-records",

  description:
    'Merge duplicate Zoho records the platform way (migrate-then-tag — NOT a destructive native merge, NEVER a delete): KEEP the survivor, copy the survivor\'s MISSING simple fields from the duplicate(s), and tag the duplicate(s) "Duplicate-Delete" for the admin to delete. Use when asked to "merge account/contact/lead/deal X into Y" or "merge these two". Get the Zoho ids via lookup-entity first (survivor = the record to keep; confirm which one with the user). You DO have this capability — never say you "can\'t merge accounts". Gated by AI Approvals / admin password — report the ticket and do NOT claim it merged until approved/applied.',

  inputSchema: z.object({
    module: z
      .enum(["Leads", "Deals", "Contacts", "Accounts"])
      .describe("Zoho module the records belong to"),
    survivorZohoId: z
      .string()
      .min(1)
      .describe("Zoho id of the record to KEEP (the survivor / master)"),
    duplicateZohoIds: z
      .array(z.string())
      .min(1)
      .describe("Zoho id(s) of the duplicate(s) to merge into the survivor and tag Duplicate-Delete"),
    reason: z
      .string()
      .optional()
      .describe("Short reason / context for the audit trail"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    module: z.string(),
    survivorZohoId: z.string(),
    duplicatesTagged: z.number(),
    fieldsFilled: z.array(z.string()),
    message: z.string(),
    error: z.string().optional(),
  }),

  execute: async ({ context }) => {
    const survivorId = String(context.survivorZohoId || "").trim();
    const ids = (context.duplicateZohoIds || [])
      .map(String)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((id) => id !== survivorId);
    if (!survivorId || !ids.length) {
      return {
        success: false,
        module: context.module,
        survivorZohoId: survivorId,
        duplicatesTagged: 0,
        fieldsFilled: [],
        message: "Provide a survivor id and at least one different duplicate id.",
        error: "missing or identical ids",
      };
    }
    if (!zohoWritesAllowedInEnv()) {
      return {
        success: false,
        module: context.module,
        survivorZohoId: survivorId,
        duplicatesTagged: 0,
        fieldsFilled: [],
        message:
          "Merging is blocked outside production (dev shares production's Zoho credentials). Run it from the deployed app.",
        error: "live Zoho writes disabled outside production",
      };
    }
    try {
      const survivor = await fetchZohoRecordById(context.module, survivorId);
      if (!survivor) {
        return {
          success: false,
          module: context.module,
          survivorZohoId: survivorId,
          duplicatesTagged: 0,
          fieldsFilled: [],
          message: `Survivor ${survivorId} was not found in Zoho.`,
          error: "survivor not found",
        };
      }
      const sData = (survivor.data || {}) as Record<string, any>;
      const updates: Record<string, any> = {};
      const filled: string[] = [];

      for (const dupId of ids) {
        const dup = await fetchZohoRecordById(context.module, dupId).catch(() => null);
        if (!dup) continue;
        const dData = (dup.data || {}) as Record<string, any>;
        for (const key of Object.keys(dData)) {
          if (PROTECTED_FIELDS.has(key) || key.startsWith("$")) continue;
          if (key in updates) continue; // first duplicate to supply a value wins
          if (!isFilledScalar(dData[key])) continue; // scalars only (skip lookups/arrays)
          if (!isEmpty(sData[key])) continue; // never overwrite survivor data
          updates[key] = dData[key];
          filled.push(key);
        }
      }

      if (Object.keys(updates).length > 0) {
        await updateZohoRecord(context.module, survivorId, updates);
      }
      await addZohoTags(context.module, ids, [DEFAULT_REMOVAL_TAG]);

      return {
        success: true,
        module: context.module,
        survivorZohoId: survivorId,
        duplicatesTagged: ids.length,
        fieldsFilled: filled,
        message:
          `Merged ${ids.length} duplicate(s) into survivor ${survivorId}: ` +
          `filled ${filled.length} empty field(s) on the survivor and tagged the ` +
          `duplicate(s) "${DEFAULT_REMOVAL_TAG}" for the admin to delete. The survivor is kept; nothing is deleted by the platform.`,
      };
    } catch (e: any) {
      return {
        success: false,
        module: context.module,
        survivorZohoId: survivorId,
        duplicatesTagged: 0,
        fieldsFilled: [],
        message: "Failed to merge in Zoho.",
        error: e?.message || String(e),
      };
    }
  },
});
