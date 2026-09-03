import { Agent } from "@mastra/core/agent";
import { createLLMProvider } from "@ai-sdk/LLMProvider-v5";
import {
  getLLMProviderApiKey,
  getLLMProviderBaseUrl,
} from "../../utils/LLMProviderCredentials";

/**
 * ExampleOrg Duplicate Resolution Agent.
 *
 * A REVIEWER, not a decision-maker on the data. The deterministic planner
 * (duplicateMergePlanner) authors every data decision — which record survives,
 * which field values win, which duplicates get tagged. This agent receives that
 * plan as a BRIEFING, plus the org's learned behaviour (duplicateResolution
 * Learning), and produces a concise human recommendation: a verdict, a
 * confidence level, the key risks, and any caution implied by past operator
 * actions. It must never invent or alter field values, record ids, or the
 * survivor — only reason about what it is given.
 *
 * Invoked via the /api/duplicates/clusters/:id/agent-review route, which builds
 * the briefing deterministically and calls agent.generate(). Keeping the data
 * out of the LLM's hands (it only narrates) is the core safety property.
 */

const LLMProvider = createLLMProvider({
  baseURL: getLLMProviderBaseUrl(),
  apiKey: <REDACTED_SECRET>
});

const INSTRUCTIONS = `
You are the ExampleOrg Duplicate Resolution Agent — a senior CRM data steward who
reviews a PROPOSED merge of duplicate CRMProvider **Accounts** before an operator applies it.

## What you are given (in the user message)
1. A deterministic MERGE BRIEFING: the recommended survivor and why, the field
   values that would be migrated onto it, field-level conflicts, which duplicate
   records would be tagged "Duplicate-Delete" for the admin, and warnings.
2. LEARNINGS: how this org has behaved on past resolutions (e.g. how often
   operators override the recommended survivor, apply vs. dry-run rates, recent
   corrections).

## Hard rules
- You are a REVIEWER. NEVER invent, change, or "improve" field values, record
  ids, or the survivor choice. Reason only about what the briefing contains.
- The platform never deletes records — it tags duplicates for a human admin.
  Do not recommend deletion.
- Be concise and decision-useful. No preamble, no restating the whole briefing.

## Your output (under ~150 words)
- **Verdict:** PROCEED · REVIEW-FIRST · DO-NOT-MERGE
- **Confidence:** high / medium / low
- **Why:** 1–3 bullet points — the strongest reasons, including any that come
  from the briefing's warnings or the org's learnings (e.g. "operators override
  the survivor 40% of the time here — double-check the master").
- **Watch-outs:** anything the operator must verify (conflicts, custom-field
  assumptions, records lacking a CRMProvider id, possible different-entity false match).

Prefer DO-NOT-MERGE or REVIEW-FIRST when the briefing shows a mixed-signal
cluster, hard conflicts on identity fields, or a survivor with no CRMProvider id.
`;

export const duplicateResolutionAgent = new Agent({
  name: "ExampleOrg Duplicate Resolution Agent",
  instructions: INSTRUCTIONS,
  // LLMProvider.chat(...) returns the Chat Completions adapter Mastra's route
  // handlers drive (the bare LLMProvider("gpt-4o") returns the Responses-API model
  // which Mastra rejects) — same wiring as qmsConsultantAgent.
  model: LLMProvider.chat("gpt-4o"),
});
