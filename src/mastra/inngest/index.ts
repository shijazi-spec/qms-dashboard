import { inngest } from "./client";
import { init, serve as originalInngestServe } from "@mastra/inngest";
import { registerApiRoute as originalRegisterApiRoute } from "@mastra/core/server";
import { type Mastra } from "@mastra/core";
import { type Inngest, InngestFunction, NonRetriableError } from "inngest";

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
        // FIX: was importing non-existent getKPIDefinitions and reading
        // k.name (column is kpi_name). Resulted in zero rows ever recorded.
        const { recordKPIValue, getAllKPIDefinitions } = await import("../../utils/kpiDatabase");

        const calculators = [
          { keywords: ['governance', 'lifecycle', 'doc'], fn: calculateKPI1_GovernanceDocLifecycle, label: 'Governance Doc Lifecycle' },
          { keywords: ['compliance', 'obligation'], fn: calculateKPI2_ComplianceObligationTracking, label: 'Compliance Obligation Tracking' },
          { keywords: ['audit', 'evidence', 'readiness'], fn: calculateKPI3_AuditEvidencePackReadiness, label: 'Audit Evidence Pack Readiness' },
          { keywords: ['handoff', 'quality'], fn: calculateKPI4_QualityGRCHandoff, label: 'Quality-GRC Handoff' },
          { keywords: ['risk', 'register', 'hygiene'], fn: calculateKPI5_RiskRegisterHygiene, label: 'Risk Register Hygiene' },
          { keywords: ['executive', 'reporting'], fn: calculateKPI6_ExecutiveReportingReadiness, label: 'Executive Reporting Readiness' },
        ];

        const kpiDefs = await getAllKPIDefinitions();
        const now = new Date();
        const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

        for (const calc of calculators) {
          try {
            const { value } = await calc.fn();
            const matchingKpi = kpiDefs.find((k: any) => {
              const name = (k.kpi_name || '').toLowerCase();
              return calc.keywords.every((kw) => name.includes(kw));
            }) || kpiDefs.find((k: any) => {
              const name = (k.kpi_name || '').toLowerCase();
              return calc.keywords.some((kw) => name.includes(kw));
            });
            if (matchingKpi) {
              await recordKPIValue({
                kpi_id: matchingKpi.id!,
                actual_value: value,
                period_start: periodStart,
                period_end: periodEnd,
                status: 'green', // recordKPIValue recomputes from thresholds
                calculated_by: 'system',
                override_reason: `Auto-calculated by scheduled job`,
              } as any);
              results.push({ kpi: calc.label, matched: matchingKpi.kpi_name, value, status: 'recorded' });
            } else {
              results.push({ kpi: calc.label, value, status: 'no_matching_definition' });
            }
          } catch (err) {
            results.push({ kpi: calc.label, error: String(err), status: 'failed' });
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

// FIX: this previously imported `syncAllModules` and `runDuplicateDetection`
// which do not exist on duplicateRadarRoutes. The cron silently threw on every
// fire, leaving the radar stale for 5+ days. Use `scanZohoCRMForDuplicates`
// which performs both sync and detection in one call.
const duplicateSyncFunction = inngest.createFunction(
  { id: "duplicate-radar-auto-sync" },
  { cron: process.env.DUPLICATE_SCAN_CRON || "0 */6 * * *" },
  async ({ step }) => {
    const scanResult = await step.run("scan-crm-for-duplicates", async () => {
      console.log("[DuplicateRadar] Auto-scan: starting scheduled Zoho scan");
      const { scanZohoCRMForDuplicates } = await import("../routes/duplicateRadarRoutes");
      return await scanZohoCRMForDuplicates('scheduled');
    });

    await step.run("notify-results", async () => {
      console.log("[DuplicateRadar] Scan result:", {
        success: scanResult.success,
        totalRecords: scanResult.totalRecordsScanned,
        clusters: scanResult.totalClustersFound,
        highConfidence: scanResult.highConfidence,
        durationMs: scanResult.durationMs,
      });

      if (!scanResult.success) {
        try {
          const { notifyEvent } = await import("../../utils/notificationHub");
          await notifyEvent({
            type: 'duplicate_radar_scan_failed',
            module: 'duplicates',
            title: 'Duplicate Radar scan failed',
            message: scanResult.error || 'Scheduled scan did not complete successfully',
            priority: 'high',
            actionUrl: '/duplicates',
          });
        } catch (e) { console.warn("[DuplicateRadar] Failed to send failure notification:", e); }
        return;
      }

      if (scanResult.highConfidence > 0) {
        try {
          const { notifyEvent } = await import("../../utils/notificationHub");
          await notifyEvent({
            type: 'duplicate_radar_alert',
            module: 'duplicates',
            title: `Duplicate Radar: ${scanResult.highConfidence} high-confidence duplicates`,
            message: `Auto-scan completed: ${scanResult.totalRecordsScanned} records scanned, ${scanResult.totalClustersFound} clusters (${scanResult.highConfidence} high confidence). Estimated pipeline inflation: SAR ${(scanResult.pipelineInflation || 0).toLocaleString()}.`,
            priority: scanResult.highConfidence > 10 ? 'high' : 'medium',
            actionUrl: '/duplicates',
          });
        } catch (e) {
          console.warn("[DuplicateRadar] Failed to send notification:", e);
        }
      }
    });

    return scanResult;
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

// Platform Health Pulse - 15-minute heartbeat
// Catches silent regressions (e.g., audit only saving Leads) within minutes,
// not days. See src/utils/platformHealthPulse.ts for the assertion list.
const healthPulseFunction = inngest.createFunction(
  { id: "platform-health-pulse" },
  { cron: process.env.HEALTH_PULSE_CRON || "*/15 * * * *" },
  async ({ step }) => {
    return await step.run("run-health-pulse", async () => {
      const { runHealthPulse, maybeNotifyOnPulse, initHealthPulseTables } = await import("../../utils/platformHealthPulse");
      try { await initHealthPulseTables(); } catch {}
      const run = await runHealthPulse();
      if (run.overall_status !== "healthy") {
        console.warn(`[HealthPulse] ${run.overall_status.toUpperCase()}: ${run.fail_count} fail, ${run.warn_count} warn`);
        await maybeNotifyOnPulse(run);
      } else {
        console.log(`[HealthPulse] healthy (${run.pass_count}/${run.checks.length} checks pass, ${run.duration_ms}ms)`);
      }
      return { id: run.id, status: run.overall_status, pass: run.pass_count, warn: run.warn_count, fail: run.fail_count };
    });
  },
);
inngestFunctions.push(healthPulseFunction);

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
