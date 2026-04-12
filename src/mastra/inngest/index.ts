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
  { id: "kpi-auto-calculation", name: "KPI Auto Calculation" },
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

const duplicateScanFunction = inngest.createFunction(
  { id: "duplicate-radar-weekly-scan" },
  { cron: process.env.DUPLICATE_SCAN_CRON || "0 3 * * 0" },
  async ({ step }) => {
    return await step.run("run-duplicate-scan", async () => {
      console.log("[DuplicateRadar] Weekly automated scan triggered");
      const { scanZohoCRMForDuplicates } = await import("../routes/duplicateRadarRoutes");
      const result = await scanZohoCRMForDuplicates('scheduled');
      console.log("[DuplicateRadar] Scan result:", { success: result.success, clusters: result.totalClustersFound, duplicates: result.duplicatesDetected });

      if (result.success && result.highConfidence > 0) {
        try {
          const { createNotification } = await import("../../utils/notificationHub");
          await createNotification({
            type: 'alert',
            title: `Duplicate Radar: ${result.highConfidence} high-confidence duplicates found`,
            message: `Weekly scan completed: ${result.totalRecordsScanned} records scanned, ${result.duplicatesDetected} duplicate clusters detected (${result.highConfidence} high confidence). Pipeline inflation: SAR ${result.pipelineInflation.toLocaleString()}.`,
            link: '/duplicates',
            severity: result.highConfidence > 10 ? 'high' : 'medium'
          });
        } catch (e) {
          console.warn("[DuplicateRadar] Failed to send notification:", e);
        }
      }

      return result;
    });
  },
);
inngestFunctions.push(duplicateScanFunction);

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
