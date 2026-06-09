/**
 * duplicate-resolution — the gated EXECUTE tool behind the AI Approvals queue.
 *
 * The autonomous runner enqueues doubtful clusters as `ai_pending_actions` rows
 * with tool_id="duplicate-resolution" and the full MergePlan in the payload.
 * When Sarah clicks Approve, the approval route calls executeApprovedAction(),
 * which looks this tool up in the wrapped-tool registry and runs `execute` with
 * the stored payload — applying the merge for real, on her behalf.
 *
 * This file wraps itself with withApprovalGate at import time (registering it in
 * the registry) and is side-effect-imported from src/mastra/index.ts so the
 * registration happens at boot. The matching governance policy lives in
 * aiToolGovernance.ts (id "duplicate-resolution").
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { executeMergePlan } from "../../utils/duplicateMergeExecutor";
import { recordResolutionEvent } from "../../utils/duplicateResolutionLearning";
import { captureClusterSnapshot } from "../../utils/duplicateRadarDatabase";
import { withApprovalGate } from "../../utils/withApprovalGate";
import { AGENT_PERFORMED_BY } from "../../utils/duplicateResolutionRunner";
import type { MergePlan } from "../../utils/duplicateMergePlanner";

export const duplicateResolutionExecuteTool = createTool({
  id: "duplicate-resolution",
  description:
    "Apply an approved duplicate-merge plan: migrate fields onto the survivor, tag duplicates 'Duplicate-Delete', optionally link to the account. Never deletes. Acts on behalf of Sarah Hijazi.",
  inputSchema: z
    .object({
      clusterId: z.number().optional(),
      module: z.string().optional(),
      plan: z.any(),
    })
    .passthrough(),
  outputSchema: z.object({
    success: z.boolean(),
    clusterId: z.number().optional(),
    tagged: z.number().optional(),
    fieldsMigrated: z.number().optional(),
    linkedToAccount: z.string().nullable().optional(),
    message: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ context }) => {
    const plan = (context as any)?.plan as MergePlan | undefined;
    if (!plan || !plan.clusterId) {
      return { success: false, error: "No merge plan in approval payload." };
    }
    try {
      // Forensic snapshot before any write (Undo / audit).
      await captureClusterSnapshot(plan.clusterId, AGENT_PERFORMED_BY, "pre_agent_apply").catch(
        () => null,
      );
      const report = await executeMergePlan(plan, {
        performedBy: AGENT_PERFORMED_BY,
        dryRun: false,
        // Cross-module clusters keep the cluster open for the follow-up link step.
        closeCluster: !(context as any)?.features?.crossModule,
      });
      const ok = report.errors.length === 0;
      await recordResolutionEvent({
        clusterId: plan.clusterId,
        eventType: "applied",
        plan,
        report,
        fieldsMigrated: report.fieldsMigrated.length,
        duplicatesTagged: report.taggedRecordIds.length,
        reparented:
          report.reparented.deals + report.reparented.contacts + report.reparented.notes,
        errors: report.errors.length,
        performedBy: AGENT_PERFORMED_BY,
      }).catch(() => {});
      return {
        success: ok,
        clusterId: plan.clusterId,
        tagged: report.taggedRecordIds.length,
        fieldsMigrated: report.fieldsMigrated.length,
        linkedToAccount: report.linkedToAccount,
        message: ok
          ? `Applied: ${report.taggedRecordIds.length} tagged, ${report.fieldsMigrated.length} fields migrated.`
          : undefined,
        error: ok ? undefined : report.errors.map((e) => e.message).join("; "),
      };
    } catch (e) {
      return {
        success: false,
        clusterId: plan.clusterId,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
});

// Wrap + register in the approval registry at import time so
// executeApprovedAction() / isToolGated() can find it when Sarah approves.
export const duplicateResolutionExecuteToolGated = withApprovalGate(
  duplicateResolutionExecuteTool,
);
