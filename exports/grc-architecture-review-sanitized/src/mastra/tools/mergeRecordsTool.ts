import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  fetchCRMProviderRecordById,
  updateCRMProviderRecord,
  addCRMProviderTags,
  CRMProviderWritesAllowedInEnv,
} from "../../utils/CRMProviderCRM";

/**
 * Merge duplicate records the ExampleOrg way: migrate-then-tag, NEVER a destructive
 * CRMProvider native merge and NEVER a delete. Keep the survivor, copy the survivor's
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

/**
 * Bound every live CRMProvider call so a single hanging request can never stall the
 * whole merge. When the merge auto-executes inline (the caller's role tier
 * covers this risk), an un-timed CRMProvider call that hangs would leave the agent
 * waiting forever → the user gets a blank reply / endless spinner. On timeout
 * we reject so the outer try/catch returns a clear, actionable failure.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const CRMProvider_READ_TIMEOUT_MS = 12_000;
const CRMProvider_WRITE_TIMEOUT_MS = 15_000;

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
    'Merge duplicate CRMProvider records the platform way (migrate-then-tag — NOT a destructive native merge, NEVER a delete): KEEP the survivor, copy the survivor\'s MISSING simple fields from the duplicate(s), and tag the duplicate(s) "Duplicate-Delete" for the admin to delete. Use when asked to "merge account/contact/lead/deal X into Y" or "merge these two". Get the CRMProvider ids via lookup-entity first (survivor = the record to keep; confirm which one with the user). You DO have this capability — never say you "can\'t merge accounts". Gated by AI Approvals / admin password — report the ticket and do NOT claim it merged until approved/applied.',

  inputSchema: z.object({
    module: z
      .enum(["Leads", "Deals", "Contacts", "Accounts"])
      .describe("CRMProvider module the records belong to"),
    survivorCRMProviderId: z
      .string()
      .min(1)
      .describe("CRMProvider id of the record to KEEP (the survivor / master)"),
    duplicateCRMProviderIds: z
      .array(z.string())
      .min(1)
      .describe("CRMProvider id(s) of the duplicate(s) to merge into the survivor and tag Duplicate-Delete"),
    reason: z
      .string()
      .optional()
      .describe("Short reason / context for the audit trail"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    module: z.string(),
    survivorCRMProviderId: z.string(),
    duplicatesTagged: z.number(),
    fieldsFilled: z.array(z.string()),
    message: z.string(),
    error: z.string().optional(),
  }),

  execute: async ({ context }) => {
    const survivorId = String(context.survivorCRMProviderId || "").trim();
    const ids = (context.duplicateCRMProviderIds || [])
      .map(String)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((id) => id !== survivorId);
    if (!survivorId || !ids.length) {
      return {
        success: false,
        module: context.module,
        survivorCRMProviderId: survivorId,
        duplicatesTagged: 0,
        fieldsFilled: [],
        message: "Provide a survivor id and at least one different duplicate id.",
        error: "missing or identical ids",
      };
    }
    if (!CRMProviderWritesAllowedInEnv()) {
      return {
        success: false,
        module: context.module,
        survivorCRMProviderId: survivorId,
        duplicatesTagged: 0,
        fieldsFilled: [],
        message:
          "Merging is blocked outside production (dev shares production's CRMProvider credentials). Run it from the deployed app.",
        error: "live CRMProvider writes disabled outside production",
      };
    }
    try {
      const survivor = await withTimeout(
        fetchCRMProviderRecordById(context.module, survivorId),
        CRMProvider_READ_TIMEOUT_MS,
        "survivor fetch",
      );
      if (!survivor) {
        return {
          success: false,
          module: context.module,
          survivorCRMProviderId: survivorId,
          duplicatesTagged: 0,
          fieldsFilled: [],
          message: `Survivor ${survivorId} was not found in CRMProvider.`,
          error: "survivor not found",
        };
      }
      const sData = (survivor.data || {}) as Record<string, any>;
      const updates: Record<string, any> = {};
      const filled: string[] = [];

      for (const dupId of ids) {
        const dup = await withTimeout(
          fetchCRMProviderRecordById(context.module, dupId),
          CRMProvider_READ_TIMEOUT_MS,
          `duplicate ${dupId} fetch`,
        ).catch(() => null);
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
        await withTimeout(
          updateCRMProviderRecord(context.module, survivorId, updates),
          CRMProvider_WRITE_TIMEOUT_MS,
          "survivor update",
        );
      }
      await withTimeout(
        addCRMProviderTags(context.module, ids, [DEFAULT_REMOVAL_TAG]),
        CRMProvider_WRITE_TIMEOUT_MS,
        "tag duplicates",
      );

      return {
        success: true,
        module: context.module,
        survivorCRMProviderId: survivorId,
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
        survivorCRMProviderId: survivorId,
        duplicatesTagged: 0,
        fieldsFilled: [],
        message: "Failed to merge in CRMProvider.",
        error: e?.message || String(e),
      };
    }
  },
});
