import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { updateZohoRecord, zohoWritesAllowedInEnv } from "../../utils/zohoCRM";
import { withTimeout } from "../../utils/promiseTimeout";

/**
 * Update simple fields on a Zoho record — the chat-side of "change this
 * contact's email / phone / website / name to X". Adam previously had NO tool
 * for arbitrary field edits, so he could only tell the user to do it manually
 * in Zoho. This closes that gap: it writes the given SCALAR fields via the v2
 * API and is wrapped with withApprovalGate in the agent, so the change queues
 * as an AI Approval (or applies via the admin-password pop-up).
 *
 * Deliberately SCALAR-ONLY for safety:
 *   - Account_Name / Contact_Name are LOOKUPS — use linkRecordToAccountTool, not
 *     this. We reject object/array values so a lookup can't be corrupted here.
 *   - System / read-only fields (id, Created_Time, Owner, …) are blocked.
 * So this can set Email, Phone, Mobile, Website, Title, a custom text field,
 * etc. — but it can't reparent a record or touch system metadata.
 */

const ZOHO_WRITE_TIMEOUT_MS = 15_000;

// Never write these — system/readonly metadata or lookup/identity fields that
// have their own dedicated flows (merge / link).
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
]);

/** Pull the trailing record id out of a pasted Zoho URL, else return as-is. */
function extractRecordId(raw: string): string {
  const s = String(raw || "").trim();
  // .../tab/Contacts/5146753000181667008  (optionally with trailing slash/query)
  const m = s.match(/\/(\d{6,})(?:[/?#].*)?$/);
  if (m) return m[1];
  // bare id
  const bare = s.match(/^(\d{6,})$/);
  return bare ? bare[1] : s;
}

function isScalar(v: any): boolean {
  return (
    (typeof v === "string" && v.trim() !== "") ||
    typeof v === "number" ||
    typeof v === "boolean"
  );
}

export const updateRecordFieldTool = createTool({
  id: "update-record-field",

  description:
    'Update simple field(s) on ONE Zoho record — e.g. change a Contact\'s Email, Phone, Mobile, Website, Title, or a text custom field. Use when asked to "change this contact\'s email to X", "update the phone on this lead", "fix the website on this account", etc. Provide the module (Leads/Deals/Contacts/Accounts), the record id (you may pass the Zoho record URL — the tool extracts the id), and an updates object mapping the Zoho field API name to its new value (e.g. {"Email":"x@y.com"}). SCALAR fields only — to relink a Contact/Deal to an Account use link-records-to-account instead. You DO have this capability — do NOT tell the user to edit it manually in Zoho. It is gated: report the APR-… ticket and do not claim it was changed until approved/applied.',

  inputSchema: z.object({
    module: z
      .enum(["Leads", "Deals", "Contacts", "Accounts"])
      .describe("Zoho module the record belongs to"),
    recordId: z
      .string()
      .min(1)
      .describe("Zoho record id (or the full Zoho record URL — the id is extracted)"),
    updates: z
      .record(z.union([z.string(), z.number(), z.boolean()]))
      .describe('Field API name → new scalar value, e.g. {"Email":"ralsannat@masdr.sa"}'),
    reason: z
      .string()
      .optional()
      .describe("Short reason / context for the audit trail"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    module: z.string(),
    recordId: z.string(),
    fieldsUpdated: z.array(z.string()),
    message: z.string(),
    error: z.string().optional(),
  }),

  execute: async ({ context }) => {
    const module = context.module;
    const recordId = extractRecordId(context.recordId);
    const raw = context.updates || {};

    if (!recordId) {
      return {
        success: false,
        module,
        recordId: "",
        fieldsUpdated: [],
        message: "No record id provided (pass a Zoho id or record URL).",
        error: "missing recordId",
      };
    }

    // Keep only writable scalar fields; surface anything we refuse so the
    // caller knows WHY (e.g. tried to set Account_Name, which is a lookup).
    const updates: Record<string, any> = {};
    const rejected: string[] = [];
    for (const [key, value] of Object.entries(raw)) {
      if (PROTECTED_FIELDS.has(key) || key.startsWith("$")) {
        rejected.push(`${key} (protected/lookup field)`);
        continue;
      }
      if (!isScalar(value)) {
        rejected.push(`${key} (non-scalar value)`);
        continue;
      }
      updates[key] = typeof value === "string" ? value.trim() : value;
    }

    if (Object.keys(updates).length === 0) {
      return {
        success: false,
        module,
        recordId,
        fieldsUpdated: [],
        message:
          "No writable scalar fields to update." +
          (rejected.length ? ` Rejected: ${rejected.join(", ")}.` : "") +
          " To relink a record to an Account, use link-records-to-account.",
        error: "no writable fields",
      };
    }

    if (!zohoWritesAllowedInEnv()) {
      return {
        success: false,
        module,
        recordId,
        fieldsUpdated: [],
        message:
          "Updating is blocked outside production (dev shares production's Zoho credentials). Run it from the deployed app.",
        error: "live Zoho writes disabled outside production",
      };
    }

    try {
      await withTimeout(
        updateZohoRecord(module, recordId, updates),
        ZOHO_WRITE_TIMEOUT_MS,
        "field update",
      );
      const fields = Object.keys(updates);
      return {
        success: true,
        module,
        recordId,
        fieldsUpdated: fields,
        message:
          `Updated ${fields.length} field(s) on ${module}/${recordId}: ${fields.join(", ")}.` +
          (rejected.length ? ` (Skipped: ${rejected.join(", ")}.)` : ""),
      };
    } catch (e: any) {
      return {
        success: false,
        module,
        recordId,
        fieldsUpdated: [],
        message: "Failed to update the record in Zoho.",
        error: e?.message || String(e),
      };
    }
  },
});
