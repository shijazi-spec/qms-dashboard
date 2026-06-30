/**
 * In-process background worker for the Agentic Resolution "Apply in Zoho"
 * merge. The `/clusters/:id/execute` endpoint (real run only — dry-run stays
 * synchronous) inserts a `merge_jobs` row and launches `runMergeJob(jobId)`
 * WITHOUT awaiting it, so the HTTP request returns immediately (avoids the
 * 504 a 200+-record merge used to cause on the sync path).
 *
 * The plan is rebuilt here from LIVE records — the job row only carries the
 * cluster id / module / operator overrides, never a stale client-side plan.
 * Merge LOGIC is unchanged: same `buildMergePlan` + `executeMergePlan`, same
 * tagging/reparenting/audit/learning-capture. This file only decides WHERE
 * that work runs (single-flight in-process) and reports progress + a Slack
 * ping on completion.
 */
import {
  getClusterById,
  getRecordsByClusterId,
  getTaggedRecordDbIdsByCluster,
} from "./duplicateRadarDatabase";
import { buildMergePlan, MODULE_RECORD_TYPE, type CrmModule } from "./duplicateMergePlanner";
import { executeMergePlan } from "./duplicateMergeExecutor";
import {
  getMergeJobById,
  updateMergeJobProgress,
  finishMergeJob,
  mergeJobStatusFor,
} from "./mergeJobsDatabase";
import { recordResolutionEvent } from "./duplicateResolutionLearning";
import { postResolutionMessage } from "./duplicateResolutionRunner";
import { logger } from "./logger";

// In-memory single-flight set — guards against a double-launch (e.g. the
// operator double-clicks Apply) racing two workers on the same cluster+module.
// Single PRIMARY instance, in-process — mirrors the old synchronous behavior;
// no distributed queue.
const running = new Set<string>();

export function mergeJobKey(clusterId: number, module: string): string {
  return `${clusterId}::${module}`;
}

export function isMergeJobKeyRunning(clusterId: number, module: string): boolean {
  return running.has(mergeJobKey(clusterId, module));
}

export async function runMergeJob(jobId: number): Promise<void> {
  const job = await getMergeJobById(jobId);
  if (!job) return;

  const key = mergeJobKey(job.cluster_id, job.module);
  if (running.has(key)) return;
  running.add(key);

  try {
    const cluster = await getClusterById(job.cluster_id);
    if (!cluster) {
      await finishMergeJob(jobId, {
        status: "failed",
        errorMessage: "Cluster not found",
      });
      return;
    }

    const module = job.module as CrmModule;
    const records = await getRecordsByClusterId(job.cluster_id);
    const recordType = MODULE_RECORD_TYPE[module];

    let taggedAccountDbIds: number[] = [];
    try {
      taggedAccountDbIds = await getTaggedRecordDbIdsByCluster(job.cluster_id);
    } catch {
      /* non-fatal */
    }

    const plan = buildMergePlan(module, job.cluster_id, records, {
      tagName: "Duplicate-Delete",
      generatedBy: job.created_by || "duplicate-radar",
      generatedAt: new Date().toISOString(),
      masterZohoId: job.master_zoho_id,
      taggedAccountDbIds,
      includeZohoIds: job.include_zoho_ids ? JSON.parse(job.include_zoho_ids) : null,
      linkAccountZohoId: job.link_account_zoho_id === null ? undefined : job.link_account_zoho_id,
      forceMergeContacts: job.force_merge,
    });

    // Multi-module clusters: Agentic resolves ONE module, so it must NOT
    // close the whole cluster — same rule as the (former) synchronous path.
    const isCrossModule = records.some(
      (r) => r.record_type && r.record_type !== recordType,
    );

    const report = await executeMergePlan(plan, {
      performedBy: job.created_by || "admin",
      dryRun: false,
      closeCluster: !isCrossModule,
      onProgress: (p) => {
        void updateMergeJobProgress(jobId, p);
      },
    });

    const reparented =
      report.reparented.deals + report.reparented.contacts + report.reparented.notes;

    await updateMergeJobProgress(jobId, {
      processed: report.taggedRecordIds.length,
      tagged: report.taggedRecordIds.length,
      reparented,
      errors: report.errors.length,
    });

    // `finished: true` can only yield "done" | "partial" (never "running"),
    // but mergeJobStatusFor's return type is shared with the in-flight case —
    // narrow it for finishMergeJob's terminal-status parameter.
    const status = mergeJobStatusFor({ errors: report.errors.length, finished: true }) as
      | "done"
      | "partial";
    await finishMergeJob(jobId, { status });

    // Learning loop — best-effort, never blocks job completion.
    try {
      await recordResolutionEvent({
        clusterId: job.cluster_id,
        eventType: "applied",
        proposedMasterZohoId: plan.masterZohoId,
        chosenMasterZohoId: plan.masterZohoId,
        fieldsMigrated: report.fieldsMigrated.length,
        duplicatesTagged: report.taggedRecordIds.length,
        reparented,
        errors: report.errors.length,
        plan,
        report,
        performedBy: job.created_by || "admin",
      });
    } catch {
      /* learning capture is non-fatal */
    }

    // Best-effort Slack ping on completion — never let a Slack failure
    // affect the job outcome (already recorded above).
    try {
      const icon = report.errors.length > 0 ? "⚠️" : "✅";
      const text =
        `${icon} Merge applied — cluster ${job.cluster_id} (${module}): ` +
        `tagged ${report.taggedRecordIds.length}/${job.total}, ` +
        `reparented ${reparented}, ${report.errors.length} error(s). ` +
        `Survivor: ${report.master.name || report.master.zohoId || "?"}.`;
      await postResolutionMessage(text);
    } catch (slackErr) {
      logger.warn("[merge-job] Slack completion ping failed (non-fatal)", {
        error: slackErr instanceof Error ? slackErr.message : String(slackErr),
      });
    }
  } catch (e: any) {
    try {
      await finishMergeJob(jobId, {
        status: "failed",
        errorMessage: e?.message || "merge job failed",
      });
    } catch (finishErr) {
      logger.error("[merge-job] failed to record job failure", {
        jobId,
        error: finishErr instanceof Error ? finishErr.message : String(finishErr),
      });
    }
  } finally {
    running.delete(key);
  }
}
