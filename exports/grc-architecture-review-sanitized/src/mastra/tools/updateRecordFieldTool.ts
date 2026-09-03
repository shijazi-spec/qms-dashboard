import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  updateCRMProviderRecord,
  fetchCRMProviderRecordById,
  searchCRMProviderRecords,
  CRMProviderWritesAllowedInEnv,
} from "../../utils/CRMProviderCRM";
import { withTimeout } from "../../utils/promiseTimeout";

/**
 * Does the value CRMProvider actually stored (`got`) match what we asked it to set
 * (`want`)?  Used for post-write read-back verification.
 *
 * CRMProvider's v2 write API returns HTTP 200 + code:SUCCESS even when a field was
 * NOT persisted (field-level profile permission on the API connection, a
 * validation rule / workflow that silently reverts the value, or a no-op).
 * So a SUCCESS response is NOT proof the field changed — we must read the
 * record back and compare. The comparison is deliberately lenient so CRMProvider's
 * own normalization (casing on emails/URLs, phone re-formatting) does not
 * produce a false "did not change" report:
 *   - exact match after trim
 *   - case-insensitive match (emails, URLs)
 *   - digit-only match for phone-like values CRMProvider may reformat
 */
export function fieldValuesMatch(
  got: unknown,
  want: unknown,
  fieldName?: string,
): boolean {
  if (got == null) return false;
  const g = String(got).trim();
  const w = String(want).trim();
  if (g === w) return true;
  if (g.toLowerCase() === w.toLowerCase()) return true;
  // Digit-only equivalence is ONLY safe for phone-like fields CRMProvider reformats
  // (e.g. "<REDACTED_PHONE>" vs "<REDACTED_PHONE>"). Applying it to arbitrary
  // fields would let a non-persisted numeric value (custom id, title) pass
  // verification, so it is gated on the field name.
  if (fieldName && /phone|mobile/i.test(fieldName)) {
    const gd = g.replace(/\D/g, "");
    const wd = w.replace(/\D/g, "");
    if (wd.length >= 4 && gd === wd) return true;
  }
  return false;
}

/**
 * Compare a freshly-read CRMProvider record against the field→value map we asked it
 * to write, returning a human-readable list of fields that did NOT persist.
 * An empty list means every field was confirmed. Pure (no I/O) so the
 * approval-critical "did it actually change?" logic is unit-testable without
 * hitting CRMProvider.
 */
export function computeReadBackMismatches(
  updates: Record<string, any>,
  freshData: Record<string, any> | null,
): string[] {
  if (!freshData) return ["record could not be found on read-back"];
  const mismatches: string[] = [];
  for (const [key, want] of Object.entries(updates)) {
    if (!fieldValuesMatch(freshData[key], want, key)) {
      const got =
        freshData[key] == null || freshData[key] === ""
          ? "(empty)"
          : String(freshData[key]);
      mismatches.push(`${key} still shows "${got}" (expected "${String(want)}")`);
    }
  }
  return mismatches;
}

/**
 * Update simple fields on a CRMProvider record — the chat-side of "change this
 * contact's email / phone / website / name to X". Adam previously had NO tool
 * for arbitrary field edits, so he could only tell the user to do it manually
 * in CRMProvider. This closes that gap: it writes the given SCALAR fields via the v2
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

const CRMProvider_WRITE_TIMEOUT_MS = 15_000;

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

/** Pull the trailing record id out of a pasted CRMProvider URL, else return as-is. */
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
    'Update simple field(s) on ONE CRMProvider record — e.g. change a Contact\'s Email, Phone, Mobile, Website, or Title. Use when asked to "change this contact\'s email to X", "update the phone on this lead", "fix the website on this account", etc. Provide the module (Leads/Deals/Contacts/Accounts), the record id (you may pass the CRMProvider record URL — the tool extracts the id), and the field(s) to set: email / phone / mobile / website / title (set only the ones you are changing). For any OTHER text field, use fieldName (its CRMProvider API name) + fieldValue. To relink a Contact/Deal to an Account use link-records-to-account instead (Account_Name is a lookup, not a text field). You DO have this capability — do NOT tell the user to edit it manually in CRMProvider. It is gated: report the APR-… ticket and do not claim it was changed until approved/applied.',

  inputSchema: z.object({
    module: z
      .enum(["Leads", "Deals", "Contacts", "Accounts"])
      .describe("CRMProvider module the record belongs to"),
    recordId: z
      .string()
      .min(1)
      .describe("CRMProvider record id (or the full CRMProvider record URL — the id is extracted)"),
    // Explicit common fields (an open dictionary schema is unreliable with
    // function-calling). Set whichever apply; leave the rest empty.
    email: z.string().optional().describe("New Email address"),
    phone: z.string().optional().describe("New Phone number"),
    mobile: z.string().optional().describe("New Mobile number"),
    website: z.string().optional().describe("New Website URL"),
    title: z.string().optional().describe("New Title / job title"),
    // Escape hatch for any other simple text field by its CRMProvider API name.
    fieldName: z
      .string()
      .optional()
      .describe("Any OTHER CRMProvider field's API name to set (e.g. 'Description'). Use with fieldValue."),
    fieldValue: z
      .string()
      .optional()
      .describe("Value for fieldName"),
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

    // Assemble the field→value map from the explicit inputs (maps the friendly
    // names to CRMProvider API field names) plus the generic fieldName/fieldValue.
    const raw: Record<string, any> = {};
    if (context.email != null && context.email !== "") raw["Email"] = context.email;
    if (context.phone != null && context.phone !== "") raw["Phone"] = context.phone;
    if (context.mobile != null && context.mobile !== "") raw["Mobile"] = context.mobile;
    if (context.website != null && context.website !== "") raw["Website"] = context.website;
    if (context.title != null && context.title !== "") raw["Title"] = context.title;
    if (context.fieldName && context.fieldValue != null && context.fieldValue !== "") {
      raw[context.fieldName] = context.fieldValue;
    }

    if (!recordId) {
      return {
        success: false,
        module,
        recordId: "",
        fieldsUpdated: [],
        message: "No record id provided (pass a CRMProvider id or record URL).",
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

    if (!CRMProviderWritesAllowedInEnv()) {
      return {
        success: false,
        module,
        recordId,
        fieldsUpdated: [],
        message:
          "Updating is blocked outside production (dev shares production's CRMProvider credentials). Run it from the deployed app.",
        error: "live CRMProvider writes disabled outside production",
      };
    }

    const fields = Object.keys(updates);
    try {
      await withTimeout(
        updateCRMProviderRecord(module, recordId, updates),
        CRMProvider_WRITE_TIMEOUT_MS,
        "field update",
      );
    } catch (e: any) {
      const errMsg = e?.message || String(e);

      // DUPLICATE_DATA is the common "approved but nothing changed" cause for
      // Email/Phone/Mobile edits: CRMProvider enforces uniqueness on these fields, so
      // setting a value that ANOTHER record already holds is silently rejected
      // (old code reported it as Executed). This almost always means the two
      // records are duplicates of the same entity — copying the value across is
      // the wrong fix; they should be MERGED. Surface that clearly, and make a
      // best-effort lookup of the conflicting record so the user can act.
      if (/DUPLICATE_DATA/i.test(errMsg)) {
        const conflictField =
          fields.find((f) => new RegExp(`\\b${f}\\b`, "i").test(errMsg)) ||
          fields[0];
        const conflictValue = updates[conflictField];

        let conflictHint = "";
        try {
          // Escape CRMProvider criteria-grammar specials so a value containing
          // parens/commas/backslashes can't break the best-effort lookup.
          const escaped = String(conflictValue).replace(/([\\(),])/g, "\\$1");
          const existing = await withTimeout(
            searchCRMProviderRecords(module, `(${conflictField}:equals:${escaped})`),
            CRMProvider_WRITE_TIMEOUT_MS,
            "duplicate lookup",
          );
          const other = existing.find((r) => String(r.id) !== String(recordId));
          if (other) {
            const od = (other.data ?? {}) as Record<string, any>;
            const name =
              od.Full_Name || od.Last_Name || od.Account_Name || od.Deal_Name || "record";
            conflictHint =
              ` Another ${module} record already uses this ${conflictField}: ` +
              `"${name}" (id ${other.id}). These look like duplicates — merge them ` +
              `(use the duplicate-resolution / merge flow) instead of copying the ${conflictField}.`;
          }
        } catch {
          /* best-effort only — never let the lookup mask the real failure */
        }

        return {
          success: false,
          module,
          recordId,
          fieldsUpdated: [],
          message:
            `CRMProvider rejected the update: the ${conflictField} "${String(conflictValue)}" ` +
            `is already in use on another ${module} record (DUPLICATE_DATA).` +
            (conflictHint ||
              ` This usually means a duplicate record already holds this value — ` +
                `merge the two records instead of copying the value.`),
          error: errMsg,
        };
      }

      return {
        success: false,
        module,
        recordId,
        fieldsUpdated: [],
        message: "Failed to update the record in CRMProvider.",
        error: errMsg,
      };
    }

    // ROOT-CAUSE GUARD (read-back verification): CRMProvider's v2 write API returns
    // HTTP 200 + code:SUCCESS even when the field was NOT actually persisted
    // (field-level profile permission on the API connection, a validation
    // rule / workflow that reverts the value, or a no-op). Reporting that
    // SUCCESS as "Executed" while nothing changed in CRMProvider is exactly the
    // "approved but nothing happened" disconnect. So we re-read the record
    // from CRMProvider's REAL-TIME single-record endpoint and confirm each field
    // now holds the requested value before we claim success.
    let fresh: Awaited<ReturnType<typeof fetchCRMProviderRecordById>> = null;
    try {
      fresh = await withTimeout(
        fetchCRMProviderRecordById(module, recordId),
        CRMProvider_WRITE_TIMEOUT_MS,
        "field update verify",
      );
    } catch (e: any) {
      // The write returned SUCCESS but we could not read the record back to
      // confirm. We must NOT let this land as "Executed" without proof — that
      // is the exact false-confidence the user reported. Report success:false
      // (the approval is recorded as FAILED, not Executed) so "Done" always
      // means a verified change. The write is idempotent, so re-approving once
      // CRMProvider is reachable simply re-applies the same value safely.
      return {
        success: false,
        module,
        recordId,
        fieldsUpdated: [],
        message:
          `CRMProvider accepted the update to ${module}/${recordId} (${fields.join(", ")}), ` +
          `but the new value could NOT be verified (read-back failed: ${e?.message || String(e)}). ` +
          `Not marking this as done — please retry, or confirm the value directly in CRMProvider.`,
        error: "verification_unavailable",
      };
    }

    const data = (fresh?.data ?? null) as Record<string, any> | null;
    const mismatches = computeReadBackMismatches(updates, data);

    if (mismatches.length > 0) {
      // CRMProvider said SUCCESS but the value did not change. Surface this honestly
      // so the approval is recorded as FAILED (not Executed) with the real
      // reason — almost always a field-level permission or validation rule on
      // the API connection's profile.
      return {
        success: false,
        module,
        recordId,
        fieldsUpdated: [],
        message:
          `CRMProvider reported success but the change did NOT persist: ${mismatches.join("; ")}. ` +
          `This usually means the API connection's profile lacks field-level edit ` +
          `permission, or a CRMProvider validation rule/workflow reverted the value. ` +
          `Fix the field permission in CRMProvider and try again.`,
        error: "CRMProvider write not persisted (read-back mismatch)",
      };
    }

    return {
      success: true,
      module,
      recordId,
      fieldsUpdated: fields,
      message:
        `Updated and verified ${fields.length} field(s) on ${module}/${recordId}: ${fields.join(", ")}.` +
        (rejected.length ? ` (Skipped: ${rejected.join(", ")}.)` : ""),
    };
  },
});
