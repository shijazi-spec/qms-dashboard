import { join } from "path";
import { readFileSync, existsSync } from "fs";
import {
  initAIAlertsTable,
  getAIAlerts,
  getUnreadAlertCount,
  acknowledgeAlert,
  resolveAlert,
  dismissAlert,
  type AlertStatus,
  type AlertSeverity,
  type AlertType,
} from "../../utils/aiAlertsDatabase";
import { requireAuthOrKey } from "../../utils/rbacMiddleware";
import { withAgentUserContext } from "../../utils/withApprovalGate";
import type { AutoApproveTier } from "../../utils/aiToolGovernance";

initAIAlertsTable().catch(console.error);

/**
 * Resolves the user's auto-approve tier. For now (document-control phase
 * per user decision) the policy is: Quality Manager approves EVERY risk
 * tier explicitly — no user is auto-approved. This is enforced by always
 * returning 'never' here. When WP-DOC-005 is ratified and auto-approval
 * is permitted for low-risk actions, read from a users-table column.
 */
function resolveAutoApproveTier(_role: string | null): AutoApproveTier {
  return 'never';
}

export const consultantRoutes = [
  {
    path: "/consultant",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const possiblePaths = [
          join(process.cwd(), "dashboard", "consultant.html"),
          "/home/runner/workspace/dashboard/consultant.html",
        ];
        for (const p of possiblePaths) {
          if (existsSync(p)) {
            return c.html(readFileSync(p, "utf-8"));
          }
        }
        return c.text("Consultant page not found", 404);
      };
    },
  },

  {
    path: "/api/consultant/chat",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = requireAuthOrKey(c);
          if (!user) return c.json({ error: "Authentication required" }, 401);

          const mastra = c.get("mastra");
          const body = await c.req.json();
          const { message, threadId } = body;

          if (!message || typeof message !== "string") {
            return c.json({ error: "Message is required" }, 400);
          }

          const agent = mastra?.getAgent("qmsConsultantAgent");
          if (!agent) {
            return c.json({ error: "QMS Consultant agent not available" }, 503);
          }

          const resolvedThreadId = threadId || `consultant-${Date.now()}`;

          const chatTimeout = parseInt(process.env.CONSULTANT_CHAT_TIMEOUT_MS || '120000');
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), chatTimeout);

          try {
            // Wrap agent invocation in AsyncLocalStorage so any AI write-tool
            // called during this turn can see WHO prompted it. Without this,
            // the HITL gate cannot attribute pending actions to a user.
            const response = await withAgentUserContext(
              {
                user: {
                  userId: user.userId,
                  email: user.email,
                  role: user.role,
                  autoApproveTier: resolveAutoApproveTier(user.role),
                },
                threadId: resolvedThreadId,
              },
              () => agent.generate(message, {
                threadId: resolvedThreadId,
                resourceId: "consultant-session",
                abortSignal: controller.signal,
              })
            );

            return c.json({
              success: true,
              threadId: resolvedThreadId,
              response: (response as any).text,
            });
          } finally {
            clearTimeout(timer);
          }
        } catch (error) {
          console.error("[Consultant] Chat error:", error);
          return c.json({
            error: "Failed to process message",
            details: error instanceof Error ? error.message : String(error),
          }, 500);
        }
      };
    },
  },

  {
    path: "/api/consultant/chat/stream",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = requireAuthOrKey(c);
          if (!user) return c.json({ error: "Authentication required" }, 401);

          const mastra = c.get("mastra");
          const body = await c.req.json();
          const { message, threadId } = body;

          if (!message || typeof message !== "string") {
            return c.json({ error: "Message is required" }, 400);
          }

          const agent = mastra?.getAgent("qmsConsultantAgent");
          if (!agent) {
            return c.json({ error: "QMS Consultant agent not available" }, 503);
          }

          const resolvedThreadId = threadId || `consultant-${Date.now()}`;

          const streamTimeout = parseInt(process.env.CONSULTANT_STREAM_TIMEOUT_MS || '120000');
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), streamTimeout);

          const stream = await withAgentUserContext(
            {
              user: {
                userId: user.userId,
                email: user.email,
                role: user.role,
                autoApproveTier: resolveAutoApproveTier(user.role),
              },
              threadId: resolvedThreadId,
            },
            () => agent.stream(message, {
              threadId: resolvedThreadId,
              resourceId: "consultant-session",
              abortSignal: controller.signal,
            })
          );

          c.header("Content-Type", "text/event-stream");
          c.header("Cache-Control", "no-cache");
          c.header("Connection", "keep-alive");

          const encoder = new TextEncoder();
          const readable = new ReadableStream({
            async start(streamController) {
              try {
                for await (const chunk of stream.textStream) {
                  streamController.enqueue(
                    encoder.encode(`data: ${JSON.stringify({ text: chunk, threadId: resolvedThreadId })}\n\n`)
                  );
                }
                streamController.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true, threadId: resolvedThreadId })}\n\n`));
                streamController.close();
              } catch (err) {
                const errMsg = err instanceof Error && err.name === 'AbortError'
                  ? 'Request timed out. Please try a simpler query.'
                  : 'Stream error';
                streamController.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ error: errMsg })}\n\n`)
                );
                streamController.close();
              } finally {
                clearTimeout(timer);
              }
            },
          });

          return new Response(readable, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
            },
          });
        } catch (error) {
          console.error("[Consultant] Stream error:", error);
          return c.json({ error: "Failed to start stream" }, 500);
        }
      };
    },
  },

  {
    path: "/api/consultant/alerts",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const status = c.req.query("status") as AlertStatus | undefined;
          const severity = c.req.query("severity") as AlertSeverity | undefined;
          const alertType = c.req.query("type") as AlertType | undefined;
          const limit = parseInt(c.req.query("limit") || "50");
          const offset = parseInt(c.req.query("offset") || "0");

          const result = await getAIAlerts({
            status: status || undefined,
            severity: severity || undefined,
            alert_type: alertType || undefined,
            limit: isNaN(limit) ? 50 : limit,
            offset: isNaN(offset) ? 0 : offset,
          });

          return c.json(result);
        } catch (error) {
          console.error("[Consultant] Alerts fetch error:", error);
          return c.json({ error: "Failed to fetch alerts" }, 500);
        }
      };
    },
  },

  {
    path: "/api/consultant/alerts/count",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
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
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = requireAuthOrKey(c);
          if (!user) return c.json({ error: "Authentication required" }, 401);

          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid alert ID" }, 400);

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
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = requireAuthOrKey(c);
          if (!user) return c.json({ error: "Authentication required" }, 401);

          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid alert ID" }, 400);

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
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = requireAuthOrKey(c);
          if (!user) return c.json({ error: "Authentication required" }, 401);

          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid alert ID" }, 400);

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
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = requireAuthOrKey(c);
          if (!user) return c.json({ error: "Authentication required" }, 401);

          const mastra = c.get("mastra");
          const agent = mastra?.getAgent("qmsConsultantAgent");
          if (!agent) {
            return c.json({ error: "QMS Consultant agent not available" }, 503);
          }

          const scanPrompt = `Perform a comprehensive platform health scan. Use all available monitoring tools to:
1. Check regulation compliance across PDPL, ISO 9001, ISO 27001, and NCA
2. Analyze nonconformance patterns for the last 90 days
3. Monitor the risk register for high risks and overdue treatments
4. Check KPI performance for missed targets
5. Review governance documents for expired reviews
6. Suggest improvements based on overall trends

IMPORTANT: Do NOT automatically create alerts, NCs, or CAPAs. Instead, compile a detailed findings report with severity ratings. At the end of the summary, list which findings warrant alerts and ask the user whether they would like you to create them. Present findings grouped by severity (Critical → High → Medium → Low).`;

          const scanTimeout = parseInt(process.env.CONSULTANT_SCAN_TIMEOUT_MS || '300000');
          const scanController = new AbortController();
          const scanTimer = setTimeout(() => scanController.abort(), scanTimeout);

          let response;
          try {
            response = await agent.generate(scanPrompt, {
              threadId: `scan-${Date.now()}`,
              resourceId: "system-scanner",
              abortSignal: scanController.signal,
            });
          } finally {
            clearTimeout(scanTimer);
          }

          return c.json({
            success: true,
            summary: response.text,
          });
        } catch (error) {
          console.error("[Consultant] Scan error:", error);
          return c.json({ error: "Failed to run platform scan" }, 500);
        }
      };
    },
  },

  {
    path: "/api/consultant/scan-stream",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        c.header("Content-Type", "text/event-stream");
        c.header("Cache-Control", "no-cache");
        c.header("Connection", "keep-alive");

        const encoder = new TextEncoder();
        const readable = new ReadableStream({
          async start(streamController) {
            const steps = [
              { label: "compliance", pct: 15 },
              { label: "nonconformances", pct: 30 },
              { label: "risks", pct: 45 },
              { label: "kpis", pct: 60 },
              { label: "documents", pct: 75 },
              { label: "summary", pct: 90 },
            ];

            try {
              const { runBackgroundScan } = await import("../../utils/aiBackgroundScanner");

              for (const step of steps) {
                streamController.enqueue(encoder.encode(
                  `data: ${JSON.stringify({ step: step.label, pct: step.pct })}\n\n`
                ));
              }

              const result = await runBackgroundScan();
              streamController.enqueue(encoder.encode(
                `data: ${JSON.stringify({ done: true, pct: 100, result })}\n\n`
              ));
            } catch (err) {
              streamController.enqueue(encoder.encode(
                `data: ${JSON.stringify({ error: err instanceof Error ? err.message : "Scan failed" })}\n\n`
              ));
            }
            streamController.close();
          },
        });

        return new Response(readable, {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        });
      };
    },
  },
];
