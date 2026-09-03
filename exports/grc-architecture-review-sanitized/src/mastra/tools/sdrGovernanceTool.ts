import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { evaluateLoadedGovernanceRules } from "../../utils/sdrGovernanceRulesEngine";

export const evaluateSdrGovernanceTool = createTool({
  id: "evaluate-sdr-governance",
  description:
    "Evaluate a call transcript against the active ExampleOrg SDR Governance 2.1 JSON ruleset (src/config/sdr-governance-2.1.rules.json). Returns governance issues (opening, purpose, next-step, compliance/forbidden language) plus ruleset metadata. Use after a transcript is available; pair with call-reconciliation for the full report.",
  inputSchema: z.object({
    transcript_text: z
      .string()
      .nullable()
      .describe("Full transcript text. Pass empty/null to detect missing-transcript guard."),
  }),
  outputSchema: z.object({
    ruleset_version: z.string().nullable(),
    rules_evaluated: z.number(),
    load_error: z.string().nullable(),
    source_artifacts: z.array(z.string()),
    governance_issue_count: z.number(),
    issues: z.array(
      z.object({
        code: z.string(),
        severity: z.enum(["info", "warning", "critical"]),
        message: z.string(),
        suggestion: z.string().optional(),
      }),
    ),
  }),
  execute: async ({ context }) => {
    const result = evaluateLoadedGovernanceRules(context.transcript_text);
    return {
      ruleset_version: result.ruleset_version,
      rules_evaluated: result.rules_evaluated,
      load_error: result.load_error,
      source_artifacts: result.source_artifacts,
      governance_issue_count: result.issues.length,
      issues: result.issues,
    };
  },
});
