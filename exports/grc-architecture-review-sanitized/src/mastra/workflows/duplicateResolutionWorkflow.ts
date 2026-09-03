/**
 * Autonomous Duplicate Resolution — 6-hourly Inngest workflow.
 *
 * Thin wrapper around runAutonomousResolution() (src/utils/duplicateResolutionRunner.ts)
 * so the cron, the in-process fallback, and the manual "Run now" endpoint all
 * share one orchestration core. Runs 30 min after the duplicate-radar auto-sync
 * so it works on freshly-synced clusters. Never throws — the runner captures
 * per-cluster failures into the summary.
 */

import { createStep, createWorkflow } from "../inngest";
import { z } from "zod";
import { runAutonomousResolution } from "../../utils/duplicateResolutionRunner";

const runResolutionStep = createStep({
  id: "run-autonomous-resolution",
  description:
    "Builds plans for every active cluster, applies the safe tier (on behalf of Sample User) or queues doubtful ones to AI Approvals, then snapshots competence grades.",

  inputSchema: z.object({}),

  outputSchema: z.object({
    mode: z.string(),
    enabled: z.boolean(),
    clustersScanned: z.number(),
    plansBuilt: z.number(),
    applied: z.number(),
    queued: z.number(),
    errors: z.number(),
    startedAt: z.string(),
    finishedAt: z.string(),
  }),

  execute: async ({ mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🤖 [AutoResolution] 6h tick starting…");
    const summary = await runAutonomousResolution();
    logger?.info("✅ [AutoResolution] tick complete", {
      mode: summary.mode,
      enabled: summary.enabled,
      scanned: summary.clustersScanned,
      applied: summary.applied,
      queued: summary.queued,
      errors: summary.errors,
    });
    return {
      mode: summary.mode,
      enabled: summary.enabled,
      clustersScanned: summary.clustersScanned,
      plansBuilt: summary.plansBuilt,
      applied: summary.applied,
      queued: summary.queued,
      errors: summary.errors,
      startedAt: summary.startedAt,
      finishedAt: summary.finishedAt,
    };
  },
});

export const duplicateResolutionWorkflow = createWorkflow({
  id: "duplicate-resolution-workflow",
  inputSchema: z.object({}) as any,
  outputSchema: z.object({
    mode: z.string(),
    enabled: z.boolean(),
    clustersScanned: z.number(),
    plansBuilt: z.number(),
    applied: z.number(),
    queued: z.number(),
    errors: z.number(),
    startedAt: z.string(),
    finishedAt: z.string(),
  }),
})
  .then(runResolutionStep as any)
  .commit();
