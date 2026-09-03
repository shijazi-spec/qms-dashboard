import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { findLeadsByPhoneMatch } from "../../utils/callLeadPhoneMatch";

export const matchLeadByPhoneTool = createTool({
  id: "match-lead-by-phone",
  description:
    "Look up CRMProvider CRM Leads by phone number (Leads module only — Contacts/Deals/Activities are out of scope). Normalizes the phone (digits-only, KSA country-code aware) and matches against Phone/Mobile fields on fetched Leads. Returns matches plus a count of leads scanned. Empty matches with scanned=0 typically means CRMProvider credentials are not set.",
  inputSchema: z.object({
    phone: z
      .string()
      .min(1)
      .describe("Phone number to match (any format — digits will be normalized)."),
    max_records: z
      .number()
      .int()
      .positive()
      .max(10000)
      .optional()
      .describe("Maximum Leads to scan. Defaults to 2500."),
  }),
  outputSchema: z.object({
    normalized_query: z.string(),
    scanned: z.number(),
    matches: z.array(
      z.object({
        id: z.string(),
        module: z.literal("Leads"),
        full_name: z.string().optional(),
        phone: z.string().optional(),
        email: z.string().optional(),
        owner: z.string().optional(),
      }),
    ),
  }),
  execute: async ({ context }) => {
    const result = await findLeadsByPhoneMatch(context.phone, {
      maxRecords: context.max_records,
    });
    return result;
  },
});
