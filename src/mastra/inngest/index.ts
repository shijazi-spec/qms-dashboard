import { inngest } from "./client";
import { init, serve as originalInngestServe } from "@mastra/inngest";
import { registerApiRoute as originalRegisterApiRoute } from "@mastra/core/server";
import { type Mastra } from "@mastra/core";
import { type Inngest, InngestFunction, NonRetriableError } from "inngest";
import { toolHealthAlertsCronFunction } from "../workflows/toolHealthAlertsCron";
import { promptRegressionAlertsCronFunction } from "../workflows/promptRegressionAlertsCron";

import { logger } from "../../utils/logger";
// Initialize Inngest with Mastra to get Inngest-compatible workflow helpers
const {
  createWorkflow: originalCreateWorkflow,
  createStep,
  cloneStep,
} = init(inngest);

export function createWorkflow(
  params: Parameters<typeof originalCreateWorkflow>[0],
): ReturnType<typeof originalCreateWorkflow> {
  return originalCreateWorkflow({
    ...params,
    retryConfig: {
      attempts: process.env.NODE_ENV === "production" ? 3 : 0,
      ...(params.retryConfig ?? {}),
    },
  });
}

// Export the Inngest client and Inngest-compatible workflow helpers
export { inngest, createStep, cloneStep };

const inngestFunctions: InngestFunction.Any[] = [];

// Create a middleware for Inngest to be able to route triggers to Mastra directly.
export function registerApiRoute<P extends string>(
  ...args: Parameters<typeof originalRegisterApiRoute<P>>
): ReturnType<typeof originalRegisterApiRoute<P>> {
  const [path, options] = args;
  if (typeof options !== "object") {
    // This will throw an error.
    return originalRegisterApiRoute(...args);
  }

  // Extract connector name from path
  // For paths like "/api/linear" -> "linear"
  // For paths like "/linear" or "/linear/webhook" -> "linear"
  const pathWithoutSlash = path.replace(/^\/+/, "");
  const pathWithoutApi = pathWithoutSlash.startsWith("api/")
    ? pathWithoutSlash.substring(4)
    : pathWithoutSlash;
  // Take only the first segment as the connector name
  const connectorName = pathWithoutApi.split("/")[0];

  inngestFunctions.push(
    inngest.createFunction(
      {
        id: `api-${connectorName}`,
        name: path,
      },
      {
        // Match the event pattern created by createWebhook: event/api.webhooks.{connector-name}.action
        event: `event/api.webhooks.${connectorName}.action`,
      },
      async ({ event, step }) => {
        await step.run("forward request to Mastra", async () => {
          // It is hard to obtain an internal handle on the Hono server,
          // so we just forward the request to the local Mastra server.
          const response = await fetch(`http://localhost:5000${path}`, {
            method: event.data.method,
            headers: event.data.headers,
            body: event.data.body,
          });

          if (!response.ok) {
            if (
              (response.status >= 500 && response.status < 600) ||
              response.status == 429 ||
              response.status == 408
            ) {
              // 5XX, 429 (Rate-Limit Exceeded), 408 (Request Timeout) are retriable.
              throw new Error(
                `Failed to forward request to Mastra: ${response.statusText}`,
              );
            } else {
              // All other errors are non-retriable.
              throw new NonRetriableError(
                `Failed to forward request to Mastra: ${response.statusText}`,
              );
            }
          }
        });
      },
    ),
  );

  return originalRegisterApiRoute(...args);
}

// ======================================================================
// TRIGGER FUNCTIONS - CHOOSE ONE BASED ON YOUR AUTOMATION TYPE
// ======================================================================
// An automation only has a single trigger type. Based on your trigger:
//
// FOR TIME-BASED AUTOMATIONS (cron/schedule):
//   - Keep the registerCronWorkflow function below
//   - Delete the registerApiRoute function above (entire function)
//   - Used for: Daily reports, scheduled tasks, periodic checks
//
// FOR WEBHOOK-BASED AUTOMATIONS (Slack, Telegram, connectors):
//   - Keep the registerApiRoute function above
//   - Delete the registerCronWorkflow function below (entire function)
//   - Used for: Slack bots, Telegram bots, GitHub webhooks, Linear webhooks, etc.
// ======================================================================

// Helper function for registering cron-based workflow triggers
export function registerCronWorkflow(cronExpression: string, workflow: any) {
  logger.info("🕐 [registerCronWorkflow] Registering cron trigger", {
    cronExpression,
    workflowId: workflow?.id,
  });

  const cronFunction = inngest.createFunction(
    { id: "cron-trigger" },
    [{ event: "replit/cron.trigger" }, { cron: cronExpression }],
    async ({ event, step }) => {
      return await step.run("execute-cron-workflow", async () => {
        const startedAt = new Date();
        logger.info("🚀 [Cron Trigger] Starting scheduled workflow execution", {
          workflowId: workflow?.id,
          scheduledTime: startedAt.toISOString(),
          cronExpression,
        });

        let workflowRunLogId: number | null = null;

        try {
          const { createWorkflowRun, logSystemEvent } =
            await import("../../utils/database");

          const logResult = await createWorkflowRun({
            workflow_id: workflow?.id || "cron-trigger",
            workflow_name: workflow?.name || "Quality Audit Workflow",
            trigger_type: "scheduled",
            trigger_source: cronExpression,
            status: "running",
            input_data: {},
          });
          workflowRunLogId = logResult?.id || null;

          await logSystemEvent({
            event_type: "workflow_started",
            event_category: "workflow",
            description: `Scheduled workflow started: ${workflow?.id || "cron-trigger"}`,
            severity: "info",
            metadata: {
              workflow_id: workflow?.id,
              cron_expression: cronExpression,
              run_id: workflowRunLogId,
            },
          });

          logger.info("📝 [Cron Trigger] Workflow run logged to database", {
            logId: workflowRunLogId,
          });
        } catch (logError) {
          logger.warn("⚠️ [Cron Trigger] Failed to log workflow start", {
            error:
              logError instanceof Error ? logError.message : String(logError),
          });
        }

        try {
          const run = await workflow.createRunAsync();
          logger.info("📝 [Cron Trigger] Workflow run created", {
            runId: run?.id,
          });

          const result = await run.start({ inputData: {} });
          logger.info("✅ [Cron Trigger] Workflow completed successfully", {
            workflowId: workflow?.id,
            status: result?.status,
          });

          try {
            const { updateWorkflowRun, logSystemEvent } =
              await import("../../utils/database");

            if (workflowRunLogId) {
              await updateWorkflowRun(workflowRunLogId, {
                status: "completed",
                completed_at: new Date(),
                output_data: result,
                duration_ms: Date.now() - startedAt.getTime(),
              });
            }

            await logSystemEvent({
              event_type: "workflow_completed",
              event_category: "workflow",
              description: `Scheduled workflow completed: ${workflow?.id || "cron-trigger"}`,
              severity: "info",
              metadata: {
                workflow_id: workflow?.id,
                run_id: workflowRunLogId,
                duration_ms: Date.now() - startedAt.getTime(),
                status: result?.status,
              },
            });
          } catch (logError) {
            logger.warn("⚠️ [Cron Trigger] Failed to log workflow completion", {
              error:
                logError instanceof Error ? logError.message : String(logError),
            });
          }

          return result;
        } catch (error) {
          logger.error("❌ [Cron Trigger] Workflow execution failed", {
            workflowId: workflow?.id,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });

          try {
            const { updateWorkflowRun, logSystemEvent } =
              await import("../../utils/database");

            if (workflowRunLogId) {
              await updateWorkflowRun(workflowRunLogId, {
                status: "failed",
                completed_at: new Date(),
                error_message:
                  error instanceof Error ? error.message : String(error),
                duration_ms: Date.now() - startedAt.getTime(),
              });
            }

            await logSystemEvent({
              event_type: "workflow_failed",
              event_category: "workflow",
              description: `Scheduled workflow failed: ${workflow?.id || "cron-trigger"}`,
              severity: "error",
              metadata: {
                workflow_id: workflow?.id,
                run_id: workflowRunLogId,
                error: error instanceof Error ? error.message : String(error),
                duration_ms: Date.now() - startedAt.getTime(),
              },
            });
          } catch (logError) {
            logger.warn("⚠️ [Cron Trigger] Failed to log workflow failure", {
              error:
                logError instanceof Error ? logError.message : String(logError),
            });
          }

          throw error;
        }
      });
    },
  );

  inngestFunctions.push(cronFunction);
  logger.info(
    "✅ [registerCronWorkflow] Cron trigger registered successfully",
    {
      cronExpression,
    },
  );
}

const kpiAutoCalcFunction = inngest.createFunction(
  { id: "kpi-auto-calculation" },
  { cron: process.env.KPI_AUTO_CALC_CRON || "0 2 * * *" },
  async ({ step }) => {
    return await step.run("run-kpi-auto-calc", async () => {
      logger.info("[KPI Auto] Daily KPI calculation triggered");
      const results: any[] = [];
      try {
        const {
          calculateKPI1_GovernanceDocLifecycle,
          calculateKPI2_ComplianceObligationTracking,
          calculateKPI3_AuditEvidencePackReadiness,
          calculateKPI4_QualityGRCHandoff,
          calculateKPI5_RiskRegisterHygiene,
          calculateKPI6_ExecutiveReportingReadiness,
        } = await import("../../utils/scorecardDatabase");
        const { recordKPIValue, getKPIDefinitions } =
          await import("../../utils/kpiDatabase");

        const calculators = [
          {
            name: "Governance Doc Lifecycle",
            fn: calculateKPI1_GovernanceDocLifecycle,
          },
          {
            name: "Compliance Obligation Tracking",
            fn: calculateKPI2_ComplianceObligationTracking,
          },
          {
            name: "Audit Evidence Pack Readiness",
            fn: calculateKPI3_AuditEvidencePackReadiness,
          },
          { name: "Quality→GRC Handoff", fn: calculateKPI4_QualityGRCHandoff },
          {
            name: "Risk Register Hygiene",
            fn: calculateKPI5_RiskRegisterHygiene,
          },
          {
            name: "Executive Reporting Readiness",
            fn: calculateKPI6_ExecutiveReportingReadiness,
          },
        ];

        const kpiDefs = await getKPIDefinitions({});
        const now = new Date();
        const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

        for (const calc of calculators) {
          try {
            const { value } = await calc.fn();
            const matchingKpi = kpiDefs.definitions.find((k: any) =>
              k.name
                .toLowerCase()
                .includes(calc.name.split(" ")[0].toLowerCase()),
            );
            if (matchingKpi) {
              await recordKPIValue({
                kpi_id: matchingKpi.id,
                actual_value: value,
                period_start: periodStart,
                period_end: periodEnd,
                calculated_by: "system_auto",
                notes: `Auto-calculated by scheduled job`,
              });
            }
            results.push({ kpi: calc.name, value, status: "recorded" });
          } catch (err) {
            results.push({
              kpi: calc.name,
              error: String(err),
              status: "failed",
            });
          }
        }
      } catch (err) {
        logger.error("[KPI Auto] Fatal error:", err);
      }
      logger.info("[KPI Auto] Completed:", results);
      return { calculated: results.length, results };
    });
  },
);
inngestFunctions.push(kpiAutoCalcFunction);

const duplicateSyncFunction = inngest.createFunction(
  { id: "duplicate-radar-auto-sync" },
  { cron: process.env.DUPLICATE_SCAN_CRON || "0 */6 * * *" },
  async ({ step }) => {
    const syncResult = await step.run("sync-crm-data", async () => {
      logger.info("[DuplicateRadar] Auto-sync: fetching CRM data");
      const { syncAllModules } = await import("../routes/duplicateRadarRoutes");
      return await syncAllModules("incremental");
    });

    const detectionResult = await step.run("detect-duplicates", async () => {
      logger.info("[DuplicateRadar] Auto-sync: running duplicate detection");
      const { runDuplicateDetection } =
        await import("../routes/duplicateRadarRoutes");
      return await runDuplicateDetection();
    });

    await step.run("notify-results", async () => {
      logger.info("[DuplicateRadar] Sync result:", {
        synced: syncResult.totalSynced,
        clustersScored: detectionResult.clustersScored,
        modules: syncResult.moduleBreakdown,
      });

      try {
        const { getEnhancedSummary } =
          await import("../../utils/duplicateRadarDatabase");
        const summary = await getEnhancedSummary();

        if (summary.highConfidence > 0) {
          const { createNotification } =
            await import("../../utils/notificationHub");
          await createNotification({
            type: "alert",
            title: `Duplicate Radar: ${summary.highConfidence} high-confidence duplicates`,
            message: `Auto-sync completed: ${syncResult.totalSynced} records synced, ${summary.trueDuplicateClusters} duplicate clusters (${summary.highConfidence} high confidence). Pipeline inflation: SAR ${summary.estimatedPipelineInflation.toLocaleString()}.`,
            link: "/duplicates",
            severity: summary.highConfidence > 10 ? "high" : "medium",
          });
        }
      } catch (e) {
        logger.warn("[DuplicateRadar] Failed to send notification:", e);
      }
    });

    return { syncResult, detectionResult };
  },
);
inngestFunctions.push(duplicateSyncFunction);

// HITL approval-queue expiry.
// Rationale: ai_pending_actions rows auto-expire 24h after creation (see
// WP-SOP-011 §Retention). We still need a cron to FLIP status from 'pending'
// to 'expired' so dashboards and counts reflect reality and the audit trail
// captures the expiry moment.
const aiApprovalExpiryFunction = inngest.createFunction(
  { id: "ai-approval-expiry" },
  { cron: process.env.AI_APPROVAL_EXPIRY_CRON || "*/15 * * * *" }, // every 15 min
  async ({ step }) => {
    return await step.run("expire-stale-ai-approvals", async () => {
      const { expireStalePendingActions } =
        await import("../../utils/aiApprovalDatabase");
      const n = await expireStalePendingActions();
      if (n > 0)
        logger.info(`[AI-Approval] Expired ${n} stale pending actions`);
      return { expired: n };
    });
  },
);
inngestFunctions.push(aiApprovalExpiryFunction);

// ──────────────────────────────────────────────────────────────────────────────
// Daily AI cost summary + pruning cron
// Emits a Slack/email alert when the trailing-24h cost exceeds
// AI_DAILY_COST_ALERT_USD (default $10.00).
// Also prunes ai_call_metrics rows older than the configured retention window
// (AI_METRICS_RETENTION_DAYS, default 90 days).
// ──────────────────────────────────────────────────────────────────────────────
const aiCostSummaryFunction = inngest.createFunction(
  { id: "ai-cost-summary" },
  { cron: process.env.AI_COST_SUMMARY_CRON || "0 6 * * *" }, // daily @ 06:00 UTC
  async ({ step }) => {
    return await step.run("check-ai-cost-and-prune", async () => {
      const { getDailyCostSummary, runAiMetricsPruneCronStep } =
        await import("../../utils/aiTelemetry");

      // Task #504 / Task #565: the prune step is extracted into a callable
      // helper so an integration test can invoke the exact same composition
      // (resolve effective window → prune) as the cron. The helper prefers
      // the dashboard override (ai_metrics_retention_config) over the env
      // baseline so admins can tighten/widen the prune window without a
      // redeploy. Falls back to the env var when no override is set, and
      // respects AI_METRICS_RETENTION_DAYS_LOCK as an env-side hard lock.
      const [summary, pruneResult] = await Promise.all([
        getDailyCostSummary(),
        runAiMetricsPruneCronStep(),
      ]);
      const { retentionDays, rowsDeleted: pruned } = pruneResult;

      if (pruned > 0) {
        logger.info(
          `[AI-Cost] Pruned ${pruned} stale ai_call_metrics rows (>${retentionDays} days)`,
        );
      }

      // Task #546: page operators when the prune cron leaves rows outside
      // the retention window — i.e. the prune has fallen behind or is
      // failing. The helper opens at most one storage_health alert at a
      // time (dedup by related_record_id) and auto-resolves it on the next
      // pass once the table is back inside the window.
      try {
        const { getAiMetricsTableStats } =
          await import("../../utils/aiTelemetry");
        const {
          evaluateAndAlertStorageHealth,
          repageStaleStorageHealthAlerts,
        } = await import("../../utils/storageHealthAlerts");
        const {
          openAlertExistsByKey,
          createAIAlert,
          getOpenAlertsByKey,
          resolveAlert,
          recordAlertNotificationResult,
        } = await import("../../utils/aiAlertsDatabase");
        const { createNotification } =
          await import("../../utils/notificationHub");
        const { sendResendEmail } = await import("../../utils/resendMail");

        const stats = await getAiMetricsTableStats();
        const storageResult = await evaluateAndAlertStorageHealth(stats, {
          openAlertExistsByKey,
          createAIAlert,
          getOpenAlertsByKey,
          resolveAlert,
          // Map the helper's neutral shape onto notificationHub's actual
          // schema (module/priority/channel/action_url) instead of relying
          // on a structural cast — the `notifications` table requires
          // `module` NOT NULL so we surface that here explicitly.
          createNotification: (input) =>
            createNotification({
              module: "ai_ops",
              priority: input.severity,
              channel: "in_app",
              title: input.title,
              message: input.message,
              action_url: input.link,
            }),
          sendSlack: async (webhookUrl, text) => {
            try {
              const resp = await fetch(webhookUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text }),
              });
              return resp.ok;
            } catch {
              return false;
            }
          },
          sendEmail: async ({ to, subject, html }) => {
            const sendResult = await sendResendEmail({ to, subject, html });
            return Boolean(sendResult?.success);
          },
        });

        if (storageResult.alertCreated) {
          logger.warn(
            `[AI-Cost] Storage-health alert opened: ai_call_metrics oldest row ` +
              `${stats.oldestAgeDays?.toFixed?.(1) ?? "?"}d > retention ${stats.retentionDays}d ` +
              `(slack=${storageResult.slackSent}, email=${storageResult.emailSent})`,
          );
        } else if (storageResult.alertsResolved > 0) {
          logger.info(
            `[AI-Cost] Storage-health auto-resolved ${storageResult.alertsResolved} alert(s)`,
          );
        }

        // Task #679: re-page on-call when a storage_health alert has sat
        // in the open state past the configured threshold (default 24 h).
        // The /ai-ops banner already surfaces it, but if no operator is
        // looking, the dedupe in evaluateAndAlertStorageHealth means we
        // never re-page. This sweep closes that gap.
        const repageResult = await repageStaleStorageHealthAlerts({
          getOpenAlertsByKey,
          recordAlertNotified: (alertId, channel, whenMs) =>
            recordAlertNotificationResult(alertId, channel, whenMs),
          sendSlack: async (webhookUrl, text) => {
            try {
              const resp = await fetch(webhookUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text }),
              });
              return resp.ok;
            } catch {
              return false;
            }
          },
          sendEmail: async ({ to, subject, html }) => {
            const sendResult = await sendResendEmail({ to, subject, html });
            return Boolean(sendResult?.success);
          },
        });
        if (repageResult.alertsRepaged > 0) {
          logger.warn(
            `[AI-Cost] Storage-health re-paged ${repageResult.alertsRepaged} ` +
              `stale alert(s) (slack=${repageResult.slackSent}, ` +
              `email=${repageResult.emailSent}, ` +
              `throttled=${repageResult.alertsThrottled}, ` +
              `quietHours=${repageResult.alertsQuietHoursSuppressed})`,
          );
        } else if (repageResult.alertsConsidered > 0) {
          logger.info(
            `[AI-Cost] Storage-health re-page sweep: ` +
              `considered=${repageResult.alertsConsidered}, ` +
              `young=${repageResult.alertsSkippedYoung}, ` +
              `acknowledged=${repageResult.alertsSkippedAcknowledged}, ` +
              `throttled=${repageResult.alertsThrottled}, ` +
              `quietHours=${repageResult.alertsQuietHoursSuppressed}, ` +
              `disabled=${repageResult.disabled}`,
          );
        }
      } catch (storageErr) {
        logger.warn(
          "[AI-Cost] Storage-health evaluation failed (non-fatal):",
          storageErr,
        );
      }

      // Task #469 + #475: scrub credential-shaped substrings from any
      // pre-Task-#452 rows that may have leaked secrets into ai_call_metrics
      // free-form TEXT columns (error_message, prompt_preview,
      // tool_input_preview, tool_output_preview) and from the JSONB
      // `metadata` column (Task #475 — covers leaks under innocuously-named
      // leaf keys like `metadata.note`). Idempotent — once the historical
      // rows are clean, every subsequent daily run reports 0 rows updated
      // and is a cheap full-table scan.
      try {
        const pg = await import("pg");
        const { runAiCallMetricsBackfill } =
          await import("../../scripts/backfillAiCallMetricsRedaction");
        const backfillPool = new pg.default.Pool({
          connectionString: process.env.DATABASE_URL,
        });
        try {
          const backfillResult = await runAiCallMetricsBackfill(backfillPool);
          if (backfillResult.rows_updated > 0) {
            logger.info(
              `[AI-Cost] Redaction backfill rewrote ${backfillResult.rows_updated} ` +
                `ai_call_metrics rows (error_message=${backfillResult.error_message_changed}, ` +
                `prompt_preview=${backfillResult.prompt_preview_changed}, ` +
                `tool_input_preview=${backfillResult.tool_input_preview_changed}, ` +
                `tool_output_preview=${backfillResult.tool_output_preview_changed}, ` +
                `metadata=${backfillResult.metadata_changed})`,
            );
          }
        } finally {
          await backfillPool.end();
        }
      } catch (backfillErr) {
        logger.warn(
          "[AI-Cost] ai_call_metrics redaction backfill failed (non-fatal):",
          backfillErr,
        );
      }

      const thresholdUsd = parseFloat(
        process.env.AI_DAILY_COST_ALERT_USD || "10",
      );
      logger.info(
        "[AI-Cost] Daily summary:",
        summary,
        `| threshold: $${thresholdUsd}`,
      );

      if (summary.totalCostUsd >= thresholdUsd) {
        const msg =
          `⚠️ *AI Cost Alert* — trailing-24h spend is *$${summary.totalCostUsd.toFixed(4)}* ` +
          `(threshold: $${thresholdUsd}). ` +
          `Calls: ${summary.callCount}, Errors: ${summary.errorCount}, ` +
          `Avg latency: ${Math.round(summary.avgLatencyMs)}ms.`;

        logger.warn("[AI-Cost] Threshold exceeded:", msg);

        try {
          const { createNotification } =
            await import("../../utils/notificationHub");
          await createNotification({
            type: "alert",
            title: "AI Daily Cost Threshold Exceeded",
            message: msg.replace(/\*/g, ""),
            link: "/ai-ops",
            severity: "high",
          });
        } catch (notifErr) {
          logger.warn("[AI-Cost] Failed to create notification:", notifErr);
        }

        if (process.env.SLACK_WEBHOOK_URL) {
          try {
            await fetch(process.env.SLACK_WEBHOOK_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text: msg }),
            });
          } catch (slackErr) {
            logger.warn("[AI-Cost] Slack notification failed:", slackErr);
          }
        }

        // Recipient resolution (Task #573): the DB-backed admin list
        // takes precedence over `AI_COST_ALERT_EMAIL` so admins can
        // add/remove recipients from the dashboard without a redeploy.
        // The env var continues to work as a fallback when the DB list
        // is empty — unchanged behaviour for existing deployments.
        let emailRecipients: string[] = [];
        let recipientsSource: "db" | "env" | "none" = "none";
        try {
          const { resolveEffectiveRecipients } =
            await import("../../utils/alertEmailRecipients");
          const resolved = await resolveEffectiveRecipients(
            "ai_cost",
            process.env.AI_COST_ALERT_EMAIL,
          );
          emailRecipients = resolved.recipients;
          recipientsSource = resolved.source;
        } catch (resolveErr) {
          logger.warn(
            "[AI-Cost] Recipient resolver failed; falling back to env var:",
            resolveErr,
          );
          emailRecipients = process.env.AI_COST_ALERT_EMAIL
            ? process.env.AI_COST_ALERT_EMAIL.split(",")
                .map((e) => e.trim())
                .filter(Boolean)
            : [];
          recipientsSource = emailRecipients.length > 0 ? "env" : "none";
        }
        if (emailRecipients.length > 0) {
          try {
            const { sendResendEmail } = await import("../../utils/resendMail");
            logger.info(
              `[AI-Cost] Sending alert email to ${emailRecipients.length} recipient(s) (source: ${recipientsSource})`,
            );
            await sendResendEmail({
              to: emailRecipients,
              subject: `⚠️ WalaPlus AI Cost Alert — $${summary.totalCostUsd.toFixed(4)} in 24h`,
              html: `<h2>AI Daily Cost Threshold Exceeded</h2>
<p>Trailing-24h spend has reached <strong>$${summary.totalCostUsd.toFixed(4)}</strong>,
exceeding the configured threshold of <strong>$${thresholdUsd}</strong>.</p>
<ul>
  <li>Total calls: ${summary.callCount}</li>
  <li>Error count: ${summary.errorCount}</li>
  <li>Avg latency: ${Math.round(summary.avgLatencyMs)} ms</li>
</ul>
<p><a href="/ai-ops">View AI Operations panel</a></p>`,
            });
          } catch (emailErr) {
            logger.warn("[AI-Cost] Email alert failed:", emailErr);
          }
        }
      }

      return {
        summary,
        pruned,
        retentionDays,
        thresholdExceeded: summary.totalCostUsd >= thresholdUsd,
      };
    });
  },
);
inngestFunctions.push(aiCostSummaryFunction);

// ──────────────────────────────────────────────────────────────────────────────
// Archived prompt-version telemetry purge cron
//
// Prompt versions are content-addressed hashes derived from each agent's
// instruction string (e.g. "qms-consultant@a1b2c3d4"). When a new deploy
// changes an agent's prompt the old version becomes "archived" — the UI hides
// it behind a toggle but the underlying ai_call_metrics rows remain forever.
//
// This job deletes those stale rows so the table stays small. It ONLY removes
// rows for versions that are both:
//   (a) not one of the currently-deployed agent PROMPT_VERSION constants
//       (sourced from src/mastra/agents/promptVersionRegistry.ts), AND
//   (b) older than PROMPT_VERSION_RETENTION_DAYS (default 30).
//
// The live-versions list comes from the central registry so adding a new
// agent only requires a single line change in promptVersionRegistry.ts —
// this cron picks up the new constant automatically.
//
// The safety guard in purgeArchivedPromptVersionMetrics() rejects an empty
// live-versions list so a bad import cannot wipe all versioned rows.
// ──────────────────────────────────────────────────────────────────────────────
const promptVersionPurgeFunction = inngest.createFunction(
  { id: "prompt-version-telemetry-purge" },
  { cron: process.env.PROMPT_VERSION_PURGE_CRON || "0 7 * * *" }, // daily @ 07:00 UTC
  async ({ step }) => {
    return await step.run("purge-archived-prompt-version-metrics", async () => {
      const retentionDays = Math.max(
        1,
        parseInt(process.env.PROMPT_VERSION_RETENTION_DAYS || "30", 10) || 30,
      );

      const { getActivePromptVersionStrings } =
        await import("../agents/promptVersionRegistry");
      const liveVersions = getActivePromptVersionStrings();

      logger.info(
        `[PromptVersionPurge] Retention window: ${retentionDays} days. ` +
          `Live versions (${liveVersions.length}): ${liveVersions.join(", ")}`,
      );

      const { purgeArchivedPromptVersionMetrics, recordPromptVersionPurgeRun } =
        await import("../../utils/aiTelemetry");
      const deleted = await purgeArchivedPromptVersionMetrics(
        liveVersions,
        retentionDays,
      );

      // Persist the purge result so the AI Operations panel's "Last purge"
      // info strip has a visible record (the console log alone is invisible
      // to operators looking at the Prompt Version tab).
      await recordPromptVersionPurgeRun(deleted, retentionDays, liveVersions);

      logger.info(
        `[PromptVersionPurge] Deleted ${deleted} ai_call_metrics row(s) for ` +
          `archived prompt versions older than ${retentionDays} days.`,
      );

      return { deleted, retentionDays, liveVersions };
    });
  },
);
inngestFunctions.push(promptVersionPurgeFunction);

const aiScannerFunction = inngest.createFunction(
  { id: "ai-background-scanner" },
  { cron: process.env.AI_SCANNER_CRON || "0 */6 * * *" },
  async ({ step }) => {
    return await step.run("run-ai-platform-scan", async () => {
      logger.info("[AI Scanner] Scheduled scan triggered");
      const { runBackgroundScan } =
        await import("../../utils/aiBackgroundScanner");
      const result = await runBackgroundScan();
      logger.info("[AI Scanner] Scan result:", result);
      return result;
    });
  },
);
inngestFunctions.push(aiScannerFunction);

/**
 * Trigger auto-escalation + daily re-evaluation.
 *
 * Two responsibilities (rolled into one cron so the audit trail stays
 * coherent and we don't fight with multiple schedulers over the same rows):
 *
 *  1. Re-evaluate dismissed triggers — any row where
 *     status='dismissed' AND next_reevaluate_at <= NOW()  is flipped
 *     back to status='pending'. This prevents "dismiss forever" from
 *     becoming a way to bury a real problem.
 *
 *  2. Auto-escalate stale pending triggers:
 *      - severity='critical' and older than 7 days  →  open a Finding
 *      - severity='warning'/'info' and older than 30 days → open a Finding
 *
 *     The finding is written to grc_audit_findings so it surfaces in the
 *     auditor's formal report (ISO 19011 §6.5). The trigger is marked
 *     'actioned' with auto_escalated_at and escalation_finding_id so the
 *     link is traceable both ways.
 *
 * Reference: WP-SOP-009 (Nonconformity & Corrective Action), WP-SOP-040
 * (Audit Programme Governance), ISO 19011:2018 §6.7 (follow-up).
 */
const triggerAutoEscalateFunction = inngest.createFunction(
  { id: "trigger-auto-escalate" },
  { cron: process.env.TRIGGER_AUTO_ESCALATE_CRON || "0 3 * * *" }, // daily @ 03:00
  async ({ step }) => {
    const reactivated = await step.run(
      "reactivate-dismissed-triggers",
      async () => {
        const { auditTriggerPool: pool } =
          await import("../../utils/auditTriggerDatabase");
        const res = await pool.query(
          `UPDATE audit_triggers
            SET status             = 'pending',
                reevaluated_at     = NOW(),
                next_reevaluate_at = NULL
          WHERE status             = 'dismissed'
            AND next_reevaluate_at IS NOT NULL
            AND next_reevaluate_at <= NOW()
          RETURNING id, trigger_id, title, severity, dismiss_reason`,
        );
        for (const row of res.rows) {
          logger.info(
            `[TriggerCron] Re-surfaced dismissed trigger ${row.trigger_id} ` +
              `(severity=${row.severity}) — prior reason: "${row.dismiss_reason}"`,
          );
        }
        return { count: res.rowCount || 0, triggers: res.rows };
      },
    );

    const escalated = await step.run(
      "auto-escalate-stale-triggers",
      async () => {
        const { auditTriggerPool: pool } =
          await import("../../utils/auditTriggerDatabase");
        const { createFinding } = await import("../../utils/auditDatabase");
        const { logEvent } = await import("../../utils/eventLogsDatabase");

        // Find triggers that exceed their SLA and have not yet been escalated.
        // We do NOT auto-escalate rows that are already acknowledged/actioned —
        // the timer only applies to truly neglected pending rows.
        const stale = await pool.query(
          `SELECT *
           FROM audit_triggers
          WHERE status = 'pending'
            AND auto_escalated_at IS NULL
            AND (
                 (severity = 'critical' AND created_at <= NOW() - INTERVAL '7 days')
              OR (severity IN ('warning','info') AND created_at <= NOW() - INTERVAL '30 days')
            )
          ORDER BY created_at ASC
          LIMIT 50`,
        );

        const out: any[] = [];
        for (const t of stale.rows) {
          try {
            const ageDays = Math.floor(
              (Date.now() - new Date(t.created_at).getTime()) / 86_400_000,
            );
            const severity =
              t.severity === "critical"
                ? "major"
                : t.severity === "warning"
                  ? "minor"
                  : "observation";

            const finding = await createFinding({
              audit_id: t.audit_id,
              finding_code: `AUTO-ESC-${t.trigger_id || t.id}`,
              title: `Auto-escalated: ${t.title}`,
              description:
                `This finding was auto-generated because trigger ` +
                `${t.trigger_id || `#${t.id}`} (severity: ${t.severity}) has been ` +
                `pending for ${ageDays} days without action.\n\n` +
                `Original trigger description:\n${t.description || "(none)"}\n\n` +
                `Action originally required:\n${t.action_required || "(none specified)"}`,
              category: "process",
              severity: severity as any,
              control_reference: "WP-SOP-009 / ISO 19011 §6.7",
              evidence_description: `audit_triggers.id=${t.id}, created_at=${t.created_at}`,
              affected_process: t.trigger_type,
              responsible_party: t.assigned_role || "quality_manager",
              status: "open",
            } as any);

            await pool.query(
              `UPDATE audit_triggers
                SET status                = 'actioned',
                    auto_escalated_at     = NOW(),
                    escalation_finding_id = $1
              WHERE id = $2`,
              [finding.id, t.id],
            );

            await logEvent({
              actionType: "STATUS_CHANGE",
              entityType: "SYSTEM",
              entityId: String(t.id),
              entityName: t.title,
              description:
                `Trigger ${t.trigger_id || t.id} auto-escalated to Finding ` +
                `${finding.finding_code} after ${ageDays} days pending.`,
              severity: t.severity === "critical" ? "CRITICAL" : "WARNING",
              module: "audits",
              aiInvolved: false,
              correlationId: finding.finding_code,
            });

            out.push({
              trigger_id: t.trigger_id || t.id,
              finding_id: finding.id,
              finding_code: finding.finding_code,
              age_days: ageDays,
            });
          } catch (err) {
            logger.error(
              `[TriggerCron] Failed to escalate trigger ${t.id}:`,
              err,
            );
          }
        }

        return { count: out.length, escalations: out };
      },
    );

    logger.info("[TriggerCron] Completed:", {
      reactivated: reactivated.count,
      escalated: escalated.count,
    });
    return { reactivated, escalated };
  },
);
inngestFunctions.push(triggerAutoEscalateFunction);

const rateLimitJanitorFunction = inngest.createFunction(
  { id: "rate-limit-janitor" },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    return await step.run("prune-expired-rate-limit-buckets", async () => {
      const pg = await import("pg");
      const pool = new pg.default.Pool({
        connectionString: process.env.DATABASE_URL,
      });
      try {
        const result = await pool.query(
          `DELETE FROM rate_limit_buckets WHERE window_start < NOW() - INTERVAL '15 minutes'`,
        );
        const deleted = result.rowCount ?? 0;
        if (deleted > 0) {
          logger.info(
            `[RateLimitJanitor] Pruned ${deleted} expired rate_limit_buckets rows`,
          );
        }
        return { deleted };
      } finally {
        await pool.end();
      }
    });
  },
);
inngestFunctions.push(rateLimitJanitorFunction);

// Prune `system_events` rows of type `rate_limit_429` older than the
// configured retention (default 24h, env: RATE_LIMIT_429_RETENTION_HOURS).
// The Rate Limits panel only looks back 5 minutes, so older rows just
// bloat the table and slow `getRateLimitStats` / activity queries —
// especially during a real attack when this row can grow by thousands per
// minute.
const rateLimit429EventsPrunerFunction = inngest.createFunction(
  { id: "rate-limit-429-events-pruner" },
  { cron: process.env.RATE_LIMIT_429_PRUNER_CRON || "0 * * * *" },
  async ({ step }) => {
    return await step.run("prune-rate-limit-429-events", async () => {
      const { pruneRateLimit429Events } =
        await import("../../utils/rateLimiter");
      const result = await pruneRateLimit429Events();
      logger.info(`[RateLimit429Pruner] Cron run complete:`, result);
      return result;
    });
  },
);
inngestFunctions.push(rateLimit429EventsPrunerFunction);

// 24h rate-limit 429 spike alert cron (Task #282) — checks the rolling-24h
// `rate_limit_429` event count against `RATE_LIMIT_429_24H_ALERT_THRESHOLD`
// (default 500) every hour and writes a `rate_limit_429_spike_alert`
// `system_event` (plus optional Slack/email page) when the threshold is
// crossed. Repeat-suppression window is `RATE_LIMIT_429_24H_ALERT_REPEAT_HOURS`
// (default 6h) so an ongoing spike does not page on every tick.
const rateLimit429SpikeAlertFunction = inngest.createFunction(
  { id: "rate-limit-429-spike-alert" },
  { cron: process.env.RATE_LIMIT_429_24H_ALERT_CRON || "15 * * * *" },
  async ({ step }) => {
    return await step.run("check-rate-limit-429-spike", async () => {
      const { runRateLimit429SpikeAlertCheck } =
        await import("../../utils/rateLimit429SpikeAlert");
      const result = await runRateLimit429SpikeAlertCheck();
      logger.info(`[RateLimit429SpikeAlert] Cron run complete:`, result);
      return result;
    });
  },
);
inngestFunctions.push(rateLimit429SpikeAlertFunction);

// Export-endpoint p95 latency alert cron (Task #440) — scrapes the in-memory
// rolling window populated by `instrumentExportResponseTiming` in
// `src/utils/excelExport.ts` and pages on-call when any route's rolling p95
// of TTFB or total duration exceeds `EXPORT_TTFB_BUDGET_MS` /
// `EXPORT_TOTAL_BUDGET_MS`. Repeat-suppression is per-(route, reason) so a
// sustained regression on one endpoint does not silence a fresh regression
// on another. Runbook: docs/runbook-export-timing-alert.md.
const exportTimingAlertFunction = inngest.createFunction(
  { id: "export-timing-p95-alert" },
  { cron: process.env.EXPORT_TIMING_ALERT_CRON || "*/5 * * * *" },
  async ({ step }) => {
    return await step.run("check-export-timing-p95", async () => {
      const { runExportTimingAlertCheck } = await import(
        "../../utils/exportTimingMetrics"
      );
      const result = await runExportTimingAlertCheck();
      logger.info(`[ExportTimingAlert] Cron run complete:`, result);
      return result;
    });
  },
);
inngestFunctions.push(exportTimingAlertFunction);

// ──────────────────────────────────────────────────────────────────────────────
// Per-tool health alert cron — defined in workflows/toolHealthAlertsCron.ts
// (kept there so all the threshold config + evaluation logic live together).
// ──────────────────────────────────────────────────────────────────────────────
inngestFunctions.push(toolHealthAlertsCronFunction);

// ──────────────────────────────────────────────────────────────────────────────
// Prompt-regression alert cron — defined in workflows/promptRegressionAlertsCron.ts
// (Task #121: warns admins when a newer prompt version of an agent is at
// least 10pp worse than the best version for the same agent in the rolling
// window, so a bad prompt edit is caught even if no one opens the AI Ops
// dashboard).
// ──────────────────────────────────────────────────────────────────────────────
inngestFunctions.push(promptRegressionAlertsCronFunction);

const executiveDigestFunction = inngest.createFunction(
  { id: "weekly-executive-digest" },
  { cron: process.env.DIGEST_CRON || "0 7 * * 1" },
  async ({ step }) => {
    return await step.run("send-executive-digest", async () => {
      logger.info("[Digest] Weekly executive quality digest triggered");
      const { sendDigestEmail } = await import("../../utils/executiveDigest");
      const result = await sendDigestEmail();
      logger.info("[Digest] Result:", result);

      if (result.success) {
        try {
          const { createNotification } =
            await import("../../utils/notificationHub");
          await createNotification({
            type: "info",
            title: "Weekly Quality Digest sent",
            message: `Executive quality digest sent via ${result.method}.`,
            link: "/executive",
            severity: "low",
          });
        } catch {}
      }

      return result;
    });
  },
);
inngestFunctions.push(executiveDigestFunction);

const aiFeedbackDigestFunction = inngest.createFunction(
  { id: "ai-feedback-digest" },
  { cron: process.env.AI_FEEDBACK_DIGEST_CRON || "0 7 * * 1" },
  async ({ step }) => {
    return await step.run("send-ai-feedback-digest", async () => {
      logger.info("[AIFeedbackDigest] Weekly AI feedback digest triggered");
      const { getWeeklyFeedbackDigest, summarizeFeedbackTrend } =
        await import("../../utils/aiFeedbackDatabase");
      const digest = await getWeeklyFeedbackDigest();
      const trend = Array.isArray(digest.trend) ? digest.trend : [];
      const trendSummary = summarizeFeedbackTrend(trend);
      logger.info("[AIFeedbackDigest] Digest data:", digest);
      logger.info("[AIFeedbackDigest] Trend summary:", trendSummary);

      if (!digest || digest.total === 0) {
        logger.info(
          "[AIFeedbackDigest] No feedback this week, skipping notifications",
        );
        return { skipped: true, trend: trendSummary };
      }

      const upRate =
        digest.total > 0
          ? Math.round((digest.thumbs_up / digest.total) * 100)
          : 0;
      const trendLabel: Record<typeof trendSummary.direction, string> = {
        improving: "📈 improving",
        worsening: "📉 worsening",
        stable: "➡️ stable",
        insufficient_data: "insufficient data",
      };
      const peakSuffix =
        trendSummary.peak_negative_day && trendSummary.peak_negative_count > 0
          ? `, worst day ${trendSummary.peak_negative_day} (${trendSummary.peak_negative_count} 👎)`
          : "";
      const trendLine = `Trend: ${trendLabel[trendSummary.direction]}${peakSuffix}.`;
      const summary = `AI Consultant received ${digest.total} ratings this week: ${digest.thumbs_up} 👍 (${upRate}%) / ${digest.thumbs_down} 👎. Top issue: ${digest.top_categories?.[0]?.category || "none"}. ${trendLine}`;

      const trendPlainLines =
        trend.length > 0
          ? [
              "Day         👍   👎",
              ...trend.map(
                (p) =>
                  `${p.day}  ${String(p.thumbs_up).padStart(3)}  ${String(p.thumbs_down).padStart(3)}`,
              ),
            ]
          : ["No daily activity recorded this week."];
      const trendPlain = trendPlainLines.join("\n");
      const messageWithTrend = `${summary}\n\nDaily trend (last 7 days):\n${trendPlain}`;

      try {
        const { createNotification } =
          await import("../../utils/notificationHub");
        await createNotification({
          type: "info",
          title: "Weekly AI Feedback Digest",
          message: messageWithTrend,
          link: "/dashboard/admin.html",
          severity: "low",
        });
      } catch {}

      try {
        const { sendSlackNotification } =
          await import("../../utils/slackNotifications");
        const slackChannel =
          process.env.SLACK_CHANNEL_ID ||
          process.env.SLACK_QMS_CHANNEL ||
          "#general";
        const slackMessage = `📊 *Weekly AI Consultant Feedback*\n${summary}\n\n*Daily trend (last 7 days):*\n\`\`\`\n${trendPlain}\n\`\`\``;
        await sendSlackNotification(slackChannel, slackMessage);
      } catch {}

      return {
        total: digest.total,
        thumbsUp: digest.thumbs_up,
        thumbsDown: digest.thumbs_down,
        upRate,
        trendDays: trend.length,
        trend: trendSummary,
      };
    });
  },
);
inngestFunctions.push(aiFeedbackDigestFunction);

// ─────────────────────────────────────────────────────────────────────────────
// Fraud Management Module — scheduled jobs (PRD-FRD-001 §9)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * fraud-rule-review-reminder — daily at 08:00 UTC.
 *
 * Notifies the rule owner (in-app) when a fraud rule's `next_review` date is
 * within the next 14 days, so reviews are scheduled proactively rather than
 * being chased after they go overdue. Re-running the cron is idempotent at
 * the data level (we use createNotification, which is allowed to enqueue
 * duplicates; if dedup becomes important we can add a `last_reminded_at`
 * column to fraud_rules in a follow-up).
 */
const fraudRuleReviewReminderFunction = inngest.createFunction(
  { id: "fraud-rule-review-reminder" },
  { cron: process.env.FRAUD_RULE_REVIEW_REMINDER_CRON || "0 8 * * *" },
  async ({ step }) => {
    return await step.run("notify-rule-owners-of-upcoming-reviews", async () => {
      const { getFraudRulesNeedingReviewSoon, initFraudTables } = await import(
        "../../utils/fraudDatabase"
      );
      const { createNotification } = await import("../../utils/notificationHub");

      await initFraudTables();
      const due = await getFraudRulesNeedingReviewSoon(14);
      if (due.length === 0) {
        logger.info("[FraudRuleReviewReminder] No rules due for review in next 14 days");
        return { notified: 0 };
      }

      let notified = 0;
      for (const rule of due) {
        try {
          await createNotification({
            title: `Fraud rule review due: ${rule.rule_id}`,
            message: `Rule "${rule.rule_name}" (${rule.rule_id}) needs review by ${String(rule.next_review).slice(0, 10)}. Owner: ${rule.owner}.`,
            module: "fraud",
            priority: "medium",
            channel: "in_app",
            recipient: rule.owner,
            related_entity_type: "fraud_rule",
            related_entity_id: String(rule.id ?? rule.rule_id),
            action_url: "/fraud-rules",
          });
          notified++;
        } catch (err) {
          logger.error(
            `[FraudRuleReviewReminder] Failed to notify for rule ${rule.rule_id}:`,
            err,
          );
        }
      }
      logger.info(
        `[FraudRuleReviewReminder] Notified ${notified}/${due.length} rule owners`,
      );
      return { notified, total_due: due.length };
    });
  },
);
inngestFunctions.push(fraudRuleReviewReminderFunction);

/**
 * fraud-sama-deadline-check — hourly.
 *
 * P1 incidents must be reported to SAMA within 72 hours of detection. This
 * cron alerts the Head of GRQ + admin recipients when an open P1 hits the
 * 12-hour-remaining threshold (i.e. >=60h elapsed and sama_reported is
 * still null/false). Re-runs are safe — same dedup posture as the rule
 * review reminder.
 */
const fraudSamaDeadlineCheckFunction = inngest.createFunction(
  { id: "fraud-sama-deadline-check" },
  { cron: process.env.FRAUD_SAMA_DEADLINE_CRON || "5 * * * *" },
  async ({ step }) => {
    return await step.run("notify-on-sama-deadline-approaching", async () => {
      const { getSamaDeadlineApproaching, initFraudTables } = await import(
        "../../utils/fraudDatabase"
      );
      const { createNotification } = await import("../../utils/notificationHub");
      await initFraudTables();
      const candidates = await getSamaDeadlineApproaching(60);
      if (candidates.length === 0) {
        return { notified: 0 };
      }
      const recipients = (
        process.env.FRAUD_SAMA_NOTIFY_EMAILS ||
        "head.grq@walaplus.com,admin@walaplus.com"
      )
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean);
      let notified = 0;
      for (const inc of candidates) {
        for (const recipient of recipients) {
          try {
            await createNotification({
              title: `URGENT — SAMA 72h deadline approaching: ${inc.incident_code}`,
              message: `P1 incident ${inc.incident_code} detected ${String(inc.date_detected).slice(0, 10)} is not yet SAMA-reported. Take action within 12 hours.`,
              module: "fraud",
              priority: "critical",
              channel: "in_app",
              recipient,
              related_entity_type: "fraud_incident",
              related_entity_id: String(inc.id),
              action_url: "/fraud-incidents",
            });
            notified++;
          } catch (err) {
            logger.error(
              `[FraudSamaDeadline] Failed to notify ${recipient} for ${inc.incident_code}:`,
              err,
            );
          }
        }
      }
      logger.info(
        `[FraudSamaDeadline] ${candidates.length} P1 incidents approaching deadline; ${notified} notifications dispatched`,
      );
      return { notified, candidates: candidates.length };
    });
  },
);
inngestFunctions.push(fraudSamaDeadlineCheckFunction);

/**
 * fraud-incident-overdue-check — daily 09:00 UTC.
 *
 * Incidents older than 30 days without a `resolution_date` violate the
 * SAMA consumer-protection 30-day resolution requirement. Notify the
 * Head of GRQ so escalation can be triggered.
 */
const fraudIncidentOverdueCheckFunction = inngest.createFunction(
  { id: "fraud-incident-overdue-check" },
  { cron: process.env.FRAUD_INCIDENT_OVERDUE_CRON || "0 9 * * *" },
  async ({ step }) => {
    return await step.run("notify-on-overdue-incidents", async () => {
      const { getOverdueFraudIncidents, initFraudTables } = await import(
        "../../utils/fraudDatabase"
      );
      const { createNotification } = await import("../../utils/notificationHub");
      await initFraudTables();
      const overdue = await getOverdueFraudIncidents(30);
      if (overdue.length === 0) {
        return { notified: 0 };
      }
      const recipient =
        process.env.FRAUD_OVERDUE_NOTIFY_EMAIL || "head.grq@walaplus.com";
      let notified = 0;
      for (const inc of overdue) {
        try {
          await createNotification({
            title: `Fraud incident overdue (>30 days): ${inc.incident_code}`,
            message: `Incident ${inc.incident_code} (${inc.severity}) detected ${String(inc.date_detected).slice(0, 10)} has no resolution_date. Status: ${inc.status}.`,
            module: "fraud",
            priority: "high",
            channel: "in_app",
            recipient,
            related_entity_type: "fraud_incident",
            related_entity_id: String(inc.id),
            action_url: "/fraud-incidents",
          });
          notified++;
        } catch (err) {
          logger.error(
            `[FraudIncidentOverdue] Failed to notify for ${inc.incident_code}:`,
            err,
          );
        }
      }
      logger.info(
        `[FraudIncidentOverdue] ${overdue.length} overdue; ${notified} notifications dispatched`,
      );
      return { notified, overdue: overdue.length };
    });
  },
);
inngestFunctions.push(fraudIncidentOverdueCheckFunction);

/**
 * fraud-incident-sla-check — hourly.
 *
 * Surfaces open incidents that have no `contained_at` after the severity-
 * based SLA window has elapsed. SLA is defined per severity; this function
 * uses inline thresholds matching the escalation matrix Excel
 * (P1=4h, P2=24h, P3=72h, P4=168h) until Feature 4 wires the matrix as
 * the canonical source.
 */
const fraudIncidentSlaCheckFunction = inngest.createFunction(
  { id: "fraud-incident-sla-check" },
  { cron: process.env.FRAUD_INCIDENT_SLA_CRON || "10 * * * *" },
  async ({ step }) => {
    return await step.run("notify-on-sla-breach", async () => {
      const { getOpenFraudIncidents, initFraudTables } = await import(
        "../../utils/fraudDatabase"
      );
      const { createNotification } = await import("../../utils/notificationHub");
      await initFraudTables();
      const open = await getOpenFraudIncidents();

      const SLA_HOURS: Record<string, number> = {
        P1: 4,
        P2: 24,
        P3: 72,
        P4: 168,
      };
      const now = Date.now();
      const breaches = open.filter((inc: any) => {
        if (inc.contained_at) return false;
        const detected = new Date(inc.created_at ?? inc.date_detected).getTime();
        const sla = SLA_HOURS[inc.severity] ?? 168;
        return now - detected > sla * 3600 * 1000;
      });

      if (breaches.length === 0) {
        return { notified: 0, open: open.length };
      }
      const recipient =
        process.env.FRAUD_SLA_NOTIFY_EMAIL || "head.grq@walaplus.com";
      let notified = 0;
      for (const inc of breaches as any[]) {
        try {
          await createNotification({
            title: `SLA breach — ${inc.severity} incident ${inc.incident_code}`,
            message: `Incident ${inc.incident_code} (${inc.severity}) is open past its containment SLA. Status: ${inc.status}.`,
            module: "fraud",
            priority: inc.severity === "P1" ? "critical" : "high",
            channel: "in_app",
            recipient,
            related_entity_type: "fraud_incident",
            related_entity_id: String(inc.id),
            action_url: "/fraud-incidents",
          });
          notified++;
        } catch (err) {
          logger.error(
            `[FraudSlaCheck] Failed to notify for ${inc.incident_code}:`,
            err,
          );
        }
      }
      logger.info(
        `[FraudSlaCheck] ${breaches.length} SLA breaches; ${notified} notifications dispatched`,
      );
      return { notified, breaches: breaches.length, open: open.length };
    });
  },
);
inngestFunctions.push(fraudIncidentSlaCheckFunction);

/**
 * fraud-country-review-reminder — twice a year on Feb 1 and Oct 1 at 09:00.
 *
 * FATF publishes plenary updates 3x/year (typically Feb, Jun, Oct); this
 * cron prompts the GRQ team to refresh the country-risk register against
 * the latest FATF black/grey lists and any sanctions changes. Single
 * notification to the head of GRQ — the team owns the data refresh.
 */
const fraudCountryReviewReminderFunction = inngest.createFunction(
  { id: "fraud-country-review-reminder" },
  { cron: process.env.FRAUD_COUNTRY_REVIEW_CRON || "0 9 1 2,10 *" },
  async ({ step }) => {
    return await step.run("notify-grq-of-country-review-due", async () => {
      const { initFraudTables, getBlackListedCountryCount } = await import(
        "../../utils/fraudDatabase"
      );
      const { createNotification } = await import("../../utils/notificationHub");
      await initFraudTables();
      const blacklisted = await getBlackListedCountryCount();
      const recipient =
        process.env.FRAUD_COUNTRY_NOTIFY_EMAIL || "head.grq@walaplus.com";
      await createNotification({
        title: "Country Risk Register — semi-annual review due",
        message: `FATF publishes updates 3x/year. Refresh country-risk ratings against the latest plenary outcomes. Currently ${blacklisted} country/countries are on the FATF black-list.`,
        module: "fraud",
        priority: "medium",
        channel: "in_app",
        recipient,
        related_entity_type: "fraud_country_risk",
        related_entity_id: "review",
        action_url: "/fraud-country-risk",
      });
      return { notified: 1, blacklisted };
    });
  },
);
inngestFunctions.push(fraudCountryReviewReminderFunction);

/**
 * fraud-kpi-monthly-reminder — 1st business day of each month at 09:00 UTC.
 *
 * On the 1st of each month, auto-calculate the *previous* month's KPIs
 * from incidents data (so the dashboard shows real numbers immediately)
 * and notify the GRQ team to fill in the manual fields
 * (total_transactions, total_rejections, customer_complaints).
 *
 * Cron is "0 9 1 * *" (1st of every month). Calling this on a Sunday is
 * fine; the notification just lands in inboxes ahead of business hours.
 */
const fraudKpiMonthlyReminderFunction = inngest.createFunction(
  { id: "fraud-kpi-monthly-reminder" },
  { cron: process.env.FRAUD_KPI_MONTHLY_CRON || "0 9 1 * *" },
  async ({ step }) => {
    return await step.run("auto-calc-and-remind", async () => {
      const { initFraudTables, autoCalculateKpisForMonth, upsertFraudKpi } =
        await import("../../utils/fraudDatabase");
      const { createNotification } = await import("../../utils/notificationHub");
      await initFraudTables();

      // Compute previous month YYYY-MM-01.
      const today = new Date();
      const prev = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const prevMonth = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}-01`;

      let result: any = null;
      try {
        const calc = await autoCalculateKpisForMonth(prevMonth);
        result = await upsertFraudKpi(prevMonth, calc, "system:monthly-cron");
      } catch (err) {
        logger.error(
          `[FraudKpiMonthly] auto-calc failed for ${prevMonth}:`,
          err,
        );
      }

      const recipient =
        process.env.FRAUD_KPI_NOTIFY_EMAIL || "head.grq@walaplus.com";
      try {
        await createNotification({
          title: `Fraud KPI snapshot ready: ${prevMonth.slice(0, 7)}`,
          message: `Previous-month KPIs auto-calculated from incidents data. Please fill in total_transactions, total_rejections, and customer_complaints in the dashboard.`,
          module: "fraud",
          priority: "medium",
          channel: "in_app",
          recipient,
          related_entity_type: "fraud_kpi",
          related_entity_id: prevMonth,
          action_url: "/fraud-dashboard",
        });
      } catch (err) {
        logger.error(`[FraudKpiMonthly] notify failed:`, err);
      }

      logger.info(`[FraudKpiMonthly] processed ${prevMonth}`);
      return { month: prevMonth, kpi_id: result?.id ?? null };
    });
  },
);
inngestFunctions.push(fraudKpiMonthlyReminderFunction);

export function inngestServe({
  mastra,
  inngest,
}: {
  mastra: Mastra;
  inngest: Inngest;
}): ReturnType<typeof originalInngestServe> {
  let serveHost: string | undefined = undefined;
  if (process.env.NODE_ENV === "production") {
    if (process.env.REPLIT_DOMAINS) {
      serveHost = `https://${process.env.REPLIT_DOMAINS.split(",")[0]}`;
    }
  } else {
    serveHost = "http://localhost:5000";
  }
  return originalInngestServe({
    mastra,
    inngest,
    functions: inngestFunctions,
    registerOptions: { serveHost },
  });
}
