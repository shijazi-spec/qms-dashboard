import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { checkCommunicationEligibility } from "../../utils/csCommunicationCheck";

/**
 * Tool exposed to the SDR Quality Agent so it can answer "can I contact
 * this domain?" with the same source-of-truth logic the REST endpoint uses.
 *
 * The agent should call this BEFORE recommending any outreach for a domain
 * an operator asks about. The structured response includes per-deal detail
 * (signed/paid signals, churn date, sector, phase) so the agent can produce
 * a clean explanation in its reply rather than just a yes/no.
 */
export const checkCommunicationEligibilityTool = createTool({
  id: "check-communication-eligibility",
  description:
    "Decide whether SDR/Marketing should communicate with a given domain right now. Looks up every Deal record indexed by the Duplicate Radar for that domain and evaluates whether (a) the customer was ever signed/paid and (b) whether the customer's relationship is still live (no churn OR churn within sector cool-off). Returns one of: block (active customer — do not contact), review (prospect deal in progress — hold), allow (safe to contact). Includes per-deal signals (Stage / Invoiced / Phase / Churn Date / sector) so the caller can explain the verdict to an operator.",
  inputSchema: z.object({
    domain: z
      .string()
      .min(1)
      .describe(
        "The company domain to check (e.g. '<REDACTED_HOST>'). Protocol / www / paths are stripped automatically.",
      ),
  }),
  outputSchema: z.object({
    domain_query: z.string(),
    examined_deals: z.number(),
    verdict: z.enum(["block", "review", "allow"]),
    reason: z.string(),
    suggested_action: z.string(),
    ever_a_customer: z.boolean(),
    active_now: z.boolean(),
    matched_deals: z.array(
      z.object({
        duplicate_record_id: z.number(),
        CRMProvider_record_id: z.string().nullable(),
        account_name: z.string().nullable(),
        domain: z.string().nullable(),
        company_domain: z.string().nullable(),
        cluster_id: z.number().nullable(),
        phase: z.string().nullable(),
        stage_value: z.string().nullable(),
        is_signed: z.boolean(),
        is_paid: z.boolean(),
        ever_a_customer: z.boolean(),
        signed_signals: z.array(z.string()),
        paid_signals: z.array(z.string()),
        churn_date: z.string().nullable(),
        churn_days: z.number().nullable(),
        sector: z.enum(["private", "government"]).nullable(),
        per_deal_verdict: z.enum(["block", "review", "allow"]),
        per_deal_reason: z.string(),
      }),
    ),
  }),
  execute: async ({ context }) => {
    return checkCommunicationEligibility({ domain: context.domain });
  },
});
