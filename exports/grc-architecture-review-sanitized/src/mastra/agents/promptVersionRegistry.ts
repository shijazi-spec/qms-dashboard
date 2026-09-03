// ─────────────────────────────────────────────────────────────────────────────
// Central registry of every agent's *_PROMPT_VERSION constant.
//
// This file is the single source of truth for "which prompt versions are
// currently live in production". Two background jobs depend on it:
//
//   1. promptVersionPurgeFunction (src/mastra/inngest/index.ts)
//        — deletes archived ai_call_metrics rows whose prompt_version is NOT
//          in this list and is older than PROMPT_VERSION_RETENTION_DAYS.
//          Forgetting to add a new agent here means its archived rows would
//          accumulate forever; including a stale version means rows we want
//          purged would survive. This registry guarantees both jobs stay in
//          lockstep.
//
//   2. /api/ai-ops/active-prompt-versions (src/mastra/routes/aiOpsRoutes.ts)
//        — returns the same list to the AI Ops dashboard so operators can see
//          which version is "live" vs "archived".
//
// ─── How to add a new agent ──────────────────────────────────────────────────
// When you add a new agent file under src/mastra/agents/ that exports a
// `*_PROMPT_VERSION` constant:
//
//   1. Import the constant below.
//   2. Add a single entry to ACTIVE_AGENT_PROMPT_VERSIONS with the
//      user-facing agent name (matches the value passed to the Mastra
//      `Agent({ name: ... })` constructor) and the version constant.
//
// That's it — both the purge job and the AI Ops endpoint pick it up
// automatically with no further code changes.
// ─────────────────────────────────────────────────────────────────────────────

import { QMS_CONSULTANT_PROMPT_VERSION } from "./qmsConsultantAgent";
import { QUALITY_SPECIALIST_PROMPT_VERSION } from "./qualitySpecialistAgent";
import { SDR_QUALITY_PROMPT_VERSION } from "./sdrQualityAgent";
import { SALES_QUALITY_PROMPT_VERSION } from "./salesQualityAgent";

export interface ActiveAgentPromptVersion {
  /** User-facing agent name; matches the Mastra `Agent({ name })` value. */
  agent_name: string;
  /** Content-addressed prompt-version hash (e.g. "<REDACTED_EMAIL>"). */
  prompt_version: string;
}

/**
 * Every agent whose prompt version is currently considered "live".
 *
 * Order is not significant. Duplicate prompt_version values are tolerated
 * (the purge job de-duplicates), but each agent should appear at most once.
 */
export const ACTIVE_AGENT_PROMPT_VERSIONS: ReadonlyArray<ActiveAgentPromptVersion> = [
  { agent_name: "ExampleOrg QMS Consultant",           prompt_version: QMS_CONSULTANT_PROMPT_VERSION },
  { agent_name: "ExampleOrg Quality Specialist",       prompt_version: QUALITY_SPECIALIST_PROMPT_VERSION },
  { agent_name: "ExampleOrg SDR Quality Specialist",   prompt_version: SDR_QUALITY_PROMPT_VERSION },
  { agent_name: "ExampleOrg Sales Quality Specialist", prompt_version: SALES_QUALITY_PROMPT_VERSION },
];

/**
 * Returns the unique list of live prompt-version strings, with empty/null
 * values filtered out. The purge job feeds this into
 * `purgeArchivedPromptVersionMetrics()`, whose internal safety guard rejects
 * an empty array — so callers should still verify the result is non-empty
 * before passing it through.
 */
export function getActivePromptVersionStrings(): string[] {
  const seen = new Set<string>();
  for (const entry of ACTIVE_AGENT_PROMPT_VERSIONS) {
    const v = entry.prompt_version;
    if (typeof v === "string" && v.length > 0) {
      seen.add(v);
    }
  }
  return Array.from(seen);
}
