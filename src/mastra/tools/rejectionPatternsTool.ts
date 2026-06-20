import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { analyzeRejectionPatterns } from "../../utils/rejectionPatterns";

/**
 * Read-only: "Why are duplicate proposals getting rejected?" Adam reads the
 * deliberately-rejected resolution proposals and reports the top reasons +
 * recommend-only rule/threshold suggestions (he never creates a rule himself —
 * the operator approves them on the Autonomous Resolution screen).
 */
export const rejectionPatternsTool = createTool({
  id: "rejection-patterns",

  description:
    "Analyse why the autonomous resolver's duplicate proposals are being REJECTED by operators (deliberate per-card rejections, not bulk clears). Use when asked 'why are proposals getting rejected', 'what should Adam learn / catch', 'what patterns are in my rejections', or to decide threshold/rule changes before trusting assisted mode. Returns the top rejection reasons with counts + share, per-module rejection counts, and a recommend-only learning-rule or config suggestion per pattern. Read-only — it never creates a rule; the operator approves suggestions on the Autonomous Resolution screen.",

  inputSchema: z.object({
    days: z
      .number()
      .optional()
      .describe("Look-back window in days (default 30)"),
  }),

  outputSchema: z.object({
    windowDays: z.number(),
    totalRejected: z.number(),
    byModule: z.record(z.number()),
    patterns: z.array(z.record(z.any())),
    summary: z.string(),
  }),

  execute: async ({ context }) => {
    const data = await analyzeRejectionPatterns(context.days ?? 30);
    const top = data.patterns
      .slice(0, 3)
      .map((p) => `${p.label} (${p.count}, ${p.sharePct}%)`)
      .join("; ");
    const summary = data.totalRejected
      ? `${data.totalRejected} rejected in the last ${data.windowDays}d. Top reasons: ${top || "none categorised"}.`
      : `No deliberate rejections in the last ${data.windowDays}d.`;
    return { ...data, summary };
  },
});
