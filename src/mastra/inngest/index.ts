import { inngest } from "./client";
import { init, serve as originalInngestServe } from "@mastra/inngest";
import { registerApiRoute as originalRegisterApiRoute } from "@mastra/core/server";
import { type Mastra } from "@mastra/core";
import { type Inngest, InngestFunction, NonRetriableError } from "inngest";
import { toolHealthAlertsCronFunction } from "../workflows/toolHealthAlertsCron";
import { promptRegressionAlertsCronFunction } from "../workflows/promptRegressionAlertsCron";

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
  console.log("🕐 [registerCronWorkflow] Registering cron trigger", {
    cronExpression,
    workflowId: workflow?.id,
  });

  const cronFunction = inngest.createFunction(
    { id: "cron-trigger" },
    [{ event: "replit/cron.trigger" }, { cron: cronExpression }],
    async ({ event, step }) => {
      return await step.run("execute-cron-workflow", async () => {
        const startedAt = new Date();
        console.log("🚀 [Cron Trigger] Starting scheduled workflow execution", {
          workflowId: workflow?.id,
          scheduledTime: startedAt.toISOString(),
          cronExpression,
        });

        let workflowRunLogId: number | null = null;
        
        try {
          const { createWorkflowRun, logSystemEvent } = await import("../../utils/database");
          
          const logResult = await createWorkflowRun({
            workflow_id: workflow?.id || 'cron-trigger',
            workflow_name: workflow?.name || 'Quality Audit Workflow',
            trigger_type: 'scheduled',
            trigger_source: cronExpression,
            status: 'running',
            input_data: {},
          });
          workflowRunLogId = logResult?.id || null;
          
          await logSystemEvent({
            event_type: 'workflow_started',
            event_category: 'workflow',
            description: `Scheduled workflow started: ${workflow?.id || 'cron-trigger'}`,
            severity: 'info',
            metadata: { workflow_id: workflow?.id, cron_expression: cronExpression, run_id: workflowRunLogId }
          });
          
          console.log("📝 [Cron Trigger] Workflow run logged to database", { logId: workflowRunLogId });
        } catch (logError) {
          console.warn("⚠️ [Cron Trigger] Failed to log workflow start", { error: logError instanceof Error ? logError.message : String(logError) });
        }

        try {
          const run = await workflow.createRunAsync();
          console.log("📝 [Cron Trigger] Workflow run created", {
            runId: run?.id,
          });

          const result = await run.start({ inputData: {} });
          console.log("✅ [Cron Trigger] Workflow completed successfully", {
            workflowId: workflow?.id,
            status: result?.status,
          });

          try {
            const { updateWorkflowRun, logSystemEvent } = await import("../../utils/database");
            
            if (workflowRunLogId) {
              await updateWorkflowRun(workflowRunLogId, {
                status: 'completed',
                completed_at: new Date(),
                output_data: result,
                duration_ms: Date.now() - startedAt.getTime(),
              });
            }
            
            await logSystemEvent({
              event_type: 'workflow_completed',
              event_category: 'workflow',
              description: `Scheduled workflow completed: ${workflow?.id || 'cron-trigger'}`,
              severity: 'info',
              metadata: { 
                workflow_id: workflow?.id, 
                run_id: workflowRunLogId,
                duration_ms: Date.now() - startedAt.getTime(),
                status: result?.status 
              }
            });
          } catch (logError) {
            console.warn("⚠️ [Cron Trigger] Failed to log workflow completion", { error: logError instanceof Error ? logError.message : String(logError) });
          }

          return result;
        } catch (error) {
          console.error("❌ [Cron Trigger] Workflow execution failed", {
            workflowId: workflow?.id,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });
          
          try {
            const { updateWorkflowRun, logSystemEvent } = await import("../../utils/database");
            
            if (workflowRunLogId) {
              await updateWorkflowRun(workflowRunLogId, {
                status: 'failed',
                completed_at: new Date(),
                error_message: error instanceof Error ? error.message : String(error),
                duration_ms: Date.now() - startedAt.getTime(),
              });
            }
            
            await logSystemEvent({
              event_type: 'workflow_failed',
              event_category: 'workflow',
              description: `Scheduled workflow failed: ${workflow?.id || 'cron-trigger'}`,
              severity: 'error',
              metadata: { 
                workflow_id: workflow?.id, 
                run_id: workflowRunLogId,
                error: error instanceof Error ? error.message : String(error),
                duration_ms: Date.now() - startedAt.getTime()
              }
            });
          } catch (logError) {
            console.warn("⚠️ [Cron Trigger] Failed to log workflow failure", { error: logError instanceof Error ? logError.message : String(logError) });
          }
          
          throw error;
        }
      });
    },
  );

  inngestFunctions.push(cronFunction);
  console.log(
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
      console.log("[KPI Auto] Daily KPI calculation triggered");
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
        const { recordKPIValue, getKPIDefinitions } = await import("../../utils/kpiDatabase");

        const calculators = [
          { name: 'Governance Doc Lifecycle', fn: calculateKPI1_GovernanceDocLifecycle },
          { name: 'Compliance Obligation Tracking', fn: calculateKPI2_ComplianceObligationTracking },
          { name: 'Audit Evidence Pack Readiness', fn: calculateKPI3_AuditEvidencePackReadiness },
          { name: 'Quality→GRC Handoff', fn: calculateKPI4_QualityGRCHandoff },
          { name: 'Risk Register Hygiene', fn: calculateKPI5_RiskRegisterHygiene },
          { name: 'Executive Reporting Readiness', fn: calculateKPI6_ExecutiveReportingReadiness },
        ];

        const kpiDefs = await getKPIDefinitions({});
        const now = new Date();
        const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

        for (const calc of calculators) {
          try {
            const { value } = await calc.fn();
            const matchingKpi = kpiDefs.definitions.find((k: any) =>
              k.name.toLowerCase().includes(calc.name.split(' ')[0].toLowerCase())
            );
            if (matchingKpi) {
              await recordKPIValue({
                kpi_id: matchingKpi.id,
                actual_value: value,
                period_start: periodStart,
                period_end: periodEnd,
                calculated_by: 'system_auto',
                notes: `Auto-calculated by scheduled job`,
              });
            }
            results.push({ kpi: calc.name, value, status: 'recorded' });
          } catch (err) {
            results.push({ kpi: calc.name, error: String(err), status: 'failed' });
          }
        }
      } catch (err) {
        console.error("[KPI Auto] Fatal error:", err);
      }
      console.log("[KPI Auto] Completed:", results);
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
      console.log("[DuplicateRadar] Auto-sync: fetching CRM data");
      const { syncAllModules } = await import("../routes/duplicateRadarRoutes");
      return await syncAllModules('incremental');
    });

    const detectionResult = await step.run("detect-duplicates", async () => {
      console.log("[DuplicateRadar] Auto-sync: running duplicate detection");
      const { runDuplicateDetection } = await import("../routes/duplicateRadarRoutes");
      return await runDuplicateDetection();
    });

    await step.run("notify-results", async () => {
      console.log("[DuplicateRadar] Sync result:", {
        synced: syncResult.totalSynced,
        clustersScored: detectionResult.clustersScored,
        modules: syncResult.moduleBreakdown
      });

      try {
        const { getEnhancedSummary } = await import("../../utils/duplicateRadarDatabase");
        const summary = await getEnhancedSummary();

        if (summary.highConfidence > 0) {
          const { createNotification } = await import("../../utils/notificationHub");
          await createNotification({
            type: 'alert',
            title: `Duplicate Radar: ${summary.highConfidence} high-confidence duplicates`,
            message: `Auto-sync completed: ${syncResult.totalSynced} records synced, ${summary.trueDuplicateClusters} duplicate clusters (${summary.highConfidence} high confidence). Pipeline inflation: SAR ${summary.estimatedPipelineInflation.toLocaleString()}.`,
            link: '/duplicates',
            severity: summary.highConfidence > 10 ? 'high' : 'medium'
          });
        }
      } catch (e) {
        console.warn("[DuplicateRadar] Failed to send notification:", e);
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
      const { expireStalePendingActions } = await import("../../utils/aiApprovalDatabase");
      const n = await expireStalePendingActions();
      if (n > 0) console.log(`[AI-Approval] Expired ${n} stale pending actions`);
      return { expired: n };
    });
  },
);
inngestFunctions.push(aiApprovalExpiryFunction);

// ──────────────────────────────────────────────────────────────────────────────
// Daily AI cost summary + pruning cron
// Emits a Slack/email alert when the trailing-24h cost exceeds
// AI_DAILY_COST_ALERT_USD (default $10.00).
// Also prunes ai_call_metrics rows older than 90 days.
// ──────────────────────────────────────────────────────────────────────────────
const aiCostSummaryFunction = inngest.createFunction(
  { id: "ai-cost-summary" },
  { cron: process.env.AI_COST_SUMMARY_CRON || "0 6 * * *" }, // daily @ 06:00 UTC
  async ({ step }) => {
    return await step.run("check-ai-cost-and-prune", async () => {
      const { getDailyCostSummary, pruneOldAiMetrics } = await import("../../utils/aiTelemetry");

      const [summary, pruned] = await Promise.all([
        getDailyCostSummary(),
        pruneOldAiMetrics(),
      ]);

      if (pruned > 0) {
        console.log(`[AI-Cost] Pruned ${pruned} stale ai_call_metrics rows (>90 days)`);
      }

      const thresholdUsd = parseFloat(process.env.AI_DAILY_COST_ALERT_USD || "10");
      console.log("[AI-Cost] Daily summary:", summary, `| threshold: $${thresholdUsd}`);

      if (summary.totalCostUsd >= thresholdUsd) {
        const msg =
          `⚠️ *AI Cost Alert* — trailing-24h spend is *$${summary.totalCostUsd.toFixed(4)}* ` +
          `(threshold: $${thresholdUsd}). ` +
          `Calls: ${summary.callCount}, Errors: ${summary.errorCount}, ` +
          `Avg latency: ${Math.round(summary.avgLatencyMs)}ms.`;

        console.warn("[AI-Cost] Threshold exceeded:", msg);

        try {
          const { createNotification } = await import("../../utils/notificationHub");
          await createNotification({
            type: "alert",
            title: "AI Daily Cost Threshold Exceeded",
            message: msg.replace(/\*/g, ""),
            link: "/ai-ops",
            severity: "high",
          });
        } catch (notifErr) {
          console.warn("[AI-Cost] Failed to create notification:", notifErr);
        }

        if (process.env.SLACK_WEBHOOK_URL) {
          try {
            await fetch(process.env.SLACK_WEBHOOK_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text: msg }),
            });
          } catch (slackErr) {
            console.warn("[AI-Cost] Slack notification failed:", slackErr);
          }
        }

        const emailRecipients = process.env.AI_COST_ALERT_EMAIL
          ? process.env.AI_COST_ALERT_EMAIL.split(",").map(e => e.trim()).filter(Boolean)
          : [];
        if (emailRecipients.length > 0) {
          try {
            const { sendResendEmail } = await import("../../utils/resendMail");
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
            console.warn("[AI-Cost] Email alert failed:", emailErr);
          }
        }
      }

      return { summary, pruned, thresholdExceeded: summary.totalCostUsd >= thresholdUsd };
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
//   (a) not one of the four currently-deployed PROMPT_VERSION constants, AND
//   (b) older than PROMPT_VERSION_RETENTION_DAYS (default 30).
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

      const [
        { QMS_CONSULTANT_PROMPT_VERSION },
        { QUALITY_SPECIALIST_PROMPT_VERSION },
        { SDR_QUALITY_PROMPT_VERSION },
        { SALES_QUALITY_PROMPT_VERSION },
      ] = await Promise.all([
        import("../agents/qmsConsultantAgent"),
        import("../agents/qualitySpecialistAgent"),
        import("../agents/sdrQualityAgent"),
        import("../agents/salesQualityAgent"),
      ]);

      const liveVersions = [
        QMS_CONSULTANT_PROMPT_VERSION,
        QUALITY_SPECIALIST_PROMPT_VERSION,
        SDR_QUALITY_PROMPT_VERSION,
        SALES_QUALITY_PROMPT_VERSION,
      ];

      console.log(
        `[PromptVersionPurge] Retention window: ${retentionDays} days. ` +
        `Live versions: ${liveVersions.join(", ")}`,
      );

      const { purgeArchivedPromptVersionMetrics } = await import("../../utils/aiTelemetry");
      const deleted = await purgeArchivedPromptVersionMetrics(liveVersions, retentionDays);

      console.log(
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
      console.log("[AI Scanner] Scheduled scan triggered");
      const { runBackgroundScan } = await import("../../utils/aiBackgroundScanner");
      const result = await runBackgroundScan();
      console.log("[AI Scanner] Scan result:", result);
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
    const reactivated = await step.run("reactivate-dismissed-triggers", async () => {
      const { auditTriggerPool: pool } = await import("../../utils/auditTriggerDatabase");
      const res = await pool.query(
        `UPDATE audit_triggers
            SET status             = 'pending',
                reevaluated_at     = NOW(),
                next_reevaluate_at = NULL
          WHERE status             = 'dismissed'
            AND next_reevaluate_at IS NOT NULL
            AND next_reevaluate_at <= NOW()
          RETURNING id, trigger_id, title, severity, dismiss_reason`
      );
      for (const row of res.rows) {
        console.log(
          `[TriggerCron] Re-surfaced dismissed trigger ${row.trigger_id} ` +
          `(severity=${row.severity}) — prior reason: "${row.dismiss_reason}"`
        );
      }
      return { count: res.rowCount || 0, triggers: res.rows };
    });

    const escalated = await step.run("auto-escalate-stale-triggers", async () => {
      const { auditTriggerPool: pool } = await import("../../utils/auditTriggerDatabase");
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
          LIMIT 50`
      );

      const out: any[] = [];
      for (const t of stale.rows) {
        try {
          const ageDays = Math.floor(
            (Date.now() - new Date(t.created_at).getTime()) / 86_400_000
          );
          const severity =
            t.severity === 'critical' ? 'major' :
            t.severity === 'warning'  ? 'minor' : 'observation';

          const finding = await createFinding({
            audit_id:             t.audit_id,
            finding_code:         `AUTO-ESC-${t.trigger_id || t.id}`,
            title:                `Auto-escalated: ${t.title}`,
            description:
              `This finding was auto-generated because trigger ` +
              `${t.trigger_id || `#${t.id}`} (severity: ${t.severity}) has been ` +
              `pending for ${ageDays} days without action.\n\n` +
              `Original trigger description:\n${t.description || '(none)'}\n\n` +
              `Action originally required:\n${t.action_required || '(none specified)'}`,
            category:             'process',
            severity:             severity as any,
            control_reference:    'WP-SOP-009 / ISO 19011 §6.7',
            evidence_description: `audit_triggers.id=${t.id}, created_at=${t.created_at}`,
            affected_process:     t.trigger_type,
            responsible_party:    t.assigned_role || 'quality_manager',
            status:               'open',
          } as any);

          await pool.query(
            `UPDATE audit_triggers
                SET status                = 'actioned',
                    auto_escalated_at     = NOW(),
                    escalation_finding_id = $1
              WHERE id = $2`,
            [finding.id, t.id]
          );

          await logEvent({
            actionType:  'STATUS_CHANGE',
            entityType:  'SYSTEM',
            entityId:    String(t.id),
            entityName:  t.title,
            description:
              `Trigger ${t.trigger_id || t.id} auto-escalated to Finding ` +
              `${finding.finding_code} after ${ageDays} days pending.`,
            severity:    t.severity === 'critical' ? 'CRITICAL' : 'WARNING',
            module:      'audits',
            aiInvolved:  false,
            correlationId: finding.finding_code,
          });

          out.push({
            trigger_id: t.trigger_id || t.id,
            finding_id: finding.id,
            finding_code: finding.finding_code,
            age_days: ageDays,
          });
        } catch (err) {
          console.error(`[TriggerCron] Failed to escalate trigger ${t.id}:`, err);
        }
      }

      return { count: out.length, escalations: out };
    });

    console.log("[TriggerCron] Completed:", {
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
      const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL });
      try {
        const result = await pool.query(
          `DELETE FROM rate_limit_buckets WHERE window_start < NOW() - INTERVAL '15 minutes'`
        );
        const deleted = result.rowCount ?? 0;
        if (deleted > 0) {
          console.log(`[RateLimitJanitor] Pruned ${deleted} expired rate_limit_buckets rows`);
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
      const { pruneRateLimit429Events } = await import("../../utils/rateLimiter");
      const result = await pruneRateLimit429Events();
      console.log(`[RateLimit429Pruner] Cron run complete:`, result);
      return result;
    });
  },
);
inngestFunctions.push(rateLimit429EventsPrunerFunction);

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
      console.log("[Digest] Weekly executive quality digest triggered");
      const { sendDigestEmail } = await import("../../utils/executiveDigest");
      const result = await sendDigestEmail();
      console.log("[Digest] Result:", result);

      if (result.success) {
        try {
          const { createNotification } = await import("../../utils/notificationHub");
          await createNotification({
            type: 'info',
            title: 'Weekly Quality Digest sent',
            message: `Executive quality digest sent via ${result.method}.`,
            link: '/executive',
            severity: 'low'
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
      console.log("[AIFeedbackDigest] Weekly AI feedback digest triggered");
      const {
        getWeeklyFeedbackDigest,
        summarizeFeedbackTrend,
      } = await import("../../utils/aiFeedbackDatabase");
      const digest = await getWeeklyFeedbackDigest();
      const trend = Array.isArray(digest.trend) ? digest.trend : [];
      const trendSummary = summarizeFeedbackTrend(trend);
      console.log("[AIFeedbackDigest] Digest data:", digest);
      console.log("[AIFeedbackDigest] Trend summary:", trendSummary);

      if (!digest || digest.total === 0) {
        console.log("[AIFeedbackDigest] No feedback this week, skipping notifications");
        return { skipped: true, trend: trendSummary };
      }

      const upRate = digest.total > 0 ? Math.round((digest.thumbs_up / digest.total) * 100) : 0;
      const trendLabel: Record<typeof trendSummary.direction, string> = {
        improving: '📈 improving',
        worsening: '📉 worsening',
        stable: '➡️ stable',
        insufficient_data: 'insufficient data',
      };
      const peakSuffix = trendSummary.peak_negative_day && trendSummary.peak_negative_count > 0
        ? `, worst day ${trendSummary.peak_negative_day} (${trendSummary.peak_negative_count} 👎)`
        : '';
      const trendLine = `Trend: ${trendLabel[trendSummary.direction]}${peakSuffix}.`;
      const summary = `AI Consultant received ${digest.total} ratings this week: ${digest.thumbs_up} 👍 (${upRate}%) / ${digest.thumbs_down} 👎. Top issue: ${digest.top_categories?.[0]?.category || 'none'}. ${trendLine}`;

      const trendPlainLines = trend.length > 0
        ? [
            'Day         👍   👎',
            ...trend.map(p => `${p.day}  ${String(p.thumbs_up).padStart(3)}  ${String(p.thumbs_down).padStart(3)}`),
          ]
        : ['No daily activity recorded this week.'];
      const trendPlain = trendPlainLines.join('\n');
      const messageWithTrend = `${summary}\n\nDaily trend (last 7 days):\n${trendPlain}`;

      try {
        const { createNotification } = await import("../../utils/notificationHub");
        await createNotification({
          type: 'info',
          title: 'Weekly AI Feedback Digest',
          message: messageWithTrend,
          link: '/dashboard/admin.html',
          severity: 'low'
        });
      } catch {}

      try {
        const { sendSlackNotification } = await import("../../utils/slackNotifications");
        const slackChannel = process.env.SLACK_CHANNEL_ID || process.env.SLACK_QMS_CHANNEL || '#general';
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
