import { qmsConsultantAgent } from "../agents/qmsConsultantAgent";
import { getAIAlerts, getUnreadAlertCount, acknowledgeAlert, resolveAlert, dismissAlert, initAIAlertsTable, type AlertStatus, type AlertSeverity, type AlertType } from "../../utils/aiAlertsDatabase";
import { runBackgroundScan } from "../../utils/aiBackgroundScanner";

let alertsTableInitialized = false;
async function ensureAlertsTable() {
  if (!alertsTableInitialized) {
    await initAIAlertsTable();
    alertsTableInitialized = true;
  }
}

export const consultantRoutes = [
  {
    path: "/api/consultant/chat",
    method: "POST",
    createHandler: async () => {
      return async (c: any) => {
        try {
          const body = await c.req.json();
          const { message, threadId } = body;

          if (!message || typeof message !== "string") {
            return c.json({ error: "Message is required" }, 400);
          }

          const response = await qmsConsultantAgent.generate([
            { role: "user", content: message },
          ]);

          return c.json({
            success: true,
            response: response.text,
            threadId: threadId || "thread_" + Date.now(),
          });
        } catch (error) {
          console.error("[Consultant Chat] Error:", error);
          return c.json({
            error: "Failed to process chat message",
            details: error instanceof Error ? error.message : String(error),
          }, 500);
        }
      };
    },
  },
  {
    path: "/api/consultant/chat/stream",
    method: "POST",
    createHandler: async () => {
      return async (c: any) => {
        try {
          const body = await c.req.json();
          const { message, threadId } = body;

          if (!message || typeof message !== "string") {
            return c.json({ error: "Message is required" }, 400);
          }

          const resolvedThreadId = threadId || "thread_" + Date.now();

          const stream = await qmsConsultantAgent.stream([
            { role: "user", content: message },
          ]);

          const encoder = new TextEncoder();
          const readable = new ReadableStream({
            async start(controller) {
              try {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ threadId: resolvedThreadId })}\n\n`)
                );

                for await (const chunk of stream.textStream) {
                  controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify({ content: chunk })}\n\n`)
                  );
                }

                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
              } catch (streamError) {
                console.error("[Consultant Stream] Stream error:", streamError);
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ error: "Stream interrupted" })}\n\n`
                  )
                );
                controller.close();
              }
            },
          });

          return new Response(readable, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          });
        } catch (error) {
          console.error("[Consultant Stream] Error:", error);
          return c.json({
            error: "Failed to process stream",
            details: error instanceof Error ? error.message : String(error),
          }, 500);
        }
      };
    },
  },
  {
    path: "/api/consultant/alerts",
    method: "GET",
    createHandler: async () => {
      return async (c: any) => {
        try {
          await ensureAlertsTable();

          const status = c.req.query("status") as AlertStatus | undefined;
          const severity = c.req.query("severity") as AlertSeverity | undefined;
          const alertType = c.req.query("alert_type") as AlertType | undefined;
          const limit = parseInt(c.req.query("limit") || "50");
          const offset = parseInt(c.req.query("offset") || "0");

          const { alerts, total } = await getAIAlerts({
            status, severity, alert_type: alertType, limit, offset,
          });

          return c.json({ success: true, alerts, total, limit, offset });
        } catch (error) {
          console.error("[Consultant Alerts] Error:", error);
          return c.json({ error: "Failed to fetch alerts" }, 500);
        }
      };
    },
  },
  {
    path: "/api/consultant/alerts/count",
    method: "GET",
    createHandler: async () => {
      return async (c: any) => {
        try {
          await ensureAlertsTable();
          const count = await getUnreadAlertCount();
          return c.json({ count });
        } catch (error) {
          return c.json({ count: 0 });
        }
      };
    },
  },
  {
    path: "/api/consultant/alerts/:id/acknowledge",
    method: "POST",
    createHandler: async () => {
      return async (c: any) => {
        try {
          const id = parseInt(c.req.param("id"));
          const body = await c.req.json().catch(() => ({}));
          const acknowledgedBy = body.acknowledgedBy || "user";
          const alert = await acknowledgeAlert(id, acknowledgedBy);
          if (!alert) return c.json({ error: "Alert not found" }, 404);
          return c.json({ success: true, alert });
        } catch (error) {
          return c.json({ error: "Failed to acknowledge alert" }, 500);
        }
      };
    },
  },
  {
    path: "/api/consultant/alerts/:id/resolve",
    method: "POST",
    createHandler: async () => {
      return async (c: any) => {
        try {
          const id = parseInt(c.req.param("id"));
          const alert = await resolveAlert(id);
          if (!alert) return c.json({ error: "Alert not found" }, 404);
          return c.json({ success: true, alert });
        } catch (error) {
          return c.json({ error: "Failed to resolve alert" }, 500);
        }
      };
    },
  },
  {
    path: "/api/consultant/alerts/:id/dismiss",
    method: "POST",
    createHandler: async () => {
      return async (c: any) => {
        try {
          const id = parseInt(c.req.param("id"));
          const alert = await dismissAlert(id);
          if (!alert) return c.json({ error: "Alert not found" }, 404);
          return c.json({ success: true, alert });
        } catch (error) {
          return c.json({ error: "Failed to dismiss alert" }, 500);
        }
      };
    },
  },
  {
    path: "/api/consultant/scan",
    method: "POST",
    createHandler: async () => {
      return async (c: any) => {
        try {
          await ensureAlertsTable();
          console.log("[Consultant] Running full platform scan...");
          const result = await runBackgroundScan();

          let summary = `## Platform Scan Complete\n\n`;
          summary += `- **Checks Performed:** ${result.checksPerformed}\n`;
          summary += `- **Alerts Created:** ${result.alertsCreated}\n`;
          summary += `- **Findings:** ${result.findings.length}\n\n`;

          if (result.findings.length > 0) {
            summary += `### Findings\n\n`;
            result.findings.forEach((f, i) => {
              summary += `${i + 1}. ${f}\n`;
            });
          } else {
            summary += `No new issues detected. Your platform is in good shape.\n`;
          }

          return c.json({
            success: true,
            summary,
            checksPerformed: result.checksPerformed,
            alertsCreated: result.alertsCreated,
            findings: result.findings,
          });
        } catch (error) {
          console.error("[Consultant Scan] Error:", error);
          return c.json({ error: "Failed to run platform scan" }, 500);
        }
      };
    },
  },
];
