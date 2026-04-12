import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { createAIAlert, alertExists, AlertType, AlertSeverity } from "../../utils/aiAlertsDatabase";

export const createAlertTool = createTool({
  id: "create-alert",

  description:
    "Creates an AI-generated alert in the system. Automatically deduplicates by checking for " +
    "existing open alerts with the same title and type before creating a new one.",

  inputSchema: z.object({
    alertType: z.enum([
      "nc_detection", "risk_alert", "kpi_miss", "regulation_gap",
      "improvement", "capa_recommendation", "training_gap",
      "doc_review", "policy_expiry", "audit_decline",
    ]).describe("Type of alert to create"),
    severity: z.enum(["critical", "high", "medium", "low", "info"])
      .describe("Severity level of the alert"),
    title: z.string().describe("Alert title (used for deduplication)"),
    description: z.string().describe("Detailed description of the alert"),
    suggestion: z.string().optional().describe("Recommended action to resolve the alert"),
    relatedModule: z.string().optional().describe("QMS module related to this alert (e.g., 'risks', 'kpis', 'documents')"),
    relatedRecordId: z.string().optional().describe("ID of the related record for cross-referencing"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    alertId: z.number().optional(),
    message: z.string(),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🔔 [createAlertTool] Creating alert...", {
      alertType: context.alertType,
      severity: context.severity,
      title: context.title,
    });

    try {
      const isDuplicate = await alertExists(
        context.title,
        context.alertType as AlertType
      );

      if (isDuplicate) {
        logger?.info("⏭️ [createAlertTool] Duplicate alert skipped", {
          title: context.title,
          alertType: context.alertType,
        });

        return {
          success: true,
          message: "Duplicate alert skipped",
        };
      }

      const alert = await createAIAlert({
        alert_type: context.alertType as AlertType,
        severity: context.severity as AlertSeverity,
        title: context.title,
        description: context.description,
        suggestion: context.suggestion,
        related_module: context.relatedModule,
        related_record_id: context.relatedRecordId,
      });

      logger?.info("✅ [createAlertTool] Alert created successfully", {
        alertId: alert.id,
        alertType: context.alertType,
      });

      return {
        success: true,
        alertId: alert.id,
        message: `Alert created successfully with ID ${alert.id}`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [createAlertTool] Failed to create alert", { error: errorMessage });

      return {
        success: false,
        message: "Failed to create alert",
        error: errorMessage,
      };
    }
  },
});
