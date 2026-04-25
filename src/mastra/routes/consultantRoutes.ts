import { join } from "path";
import { readFileSync, existsSync } from "fs";
import { randomUUID } from "crypto";
import {
  initAIAlertsTable,
  initToolHealthNotificationsTable,
  getAIAlerts,
  getUnreadAlertCount,
  acknowledgeAlert,
  resolveAlert,
  dismissAlert,
  type AlertStatus,
  type AlertSeverity,
  type AlertType,
} from "../../utils/aiAlertsDatabase";
import {
  initAIFeedbackTable,
  saveFeedback,
  getFeedbackStats,
  getRecentThumbsDown,
  getFeedbackTrend,
  getDistinctFeedbackAgents,
  getFeedbackByMessageId,
} from "../../utils/aiFeedbackDatabase";
import { requireRole } from "../../utils/rbacMiddleware";
import type { UserRole } from "../../utils/rbacDatabase";
import { withAgentUserContext } from "../../utils/withApprovalGate";
import type { AutoApproveTier } from "../../utils/aiToolGovernance";
import { withAiTelemetry, startTelemetrySpan } from "../../utils/aiTelemetry";
import { QMS_CONSULTANT_PROMPT_VERSION } from "../agents/qmsConsultantAgent";

interface AgentTextResult { text: string }

const CONSULTANT_ROLES: UserRole[] = ['admin', 'ai_specialist', 'grc_manager', 'head_of_operations_quality'];

initAIAlertsTable().catch(console.error);
initToolHealthNotificationsTable().catch(console.error);
initAIFeedbackTable().catch(console.error);

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
          const user = await requireRole(c, CONSULTANT_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);

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
            const { result: response, callId } = await withAiTelemetry<AgentTextResult>(
              { agentName: 'WalaPlus QMS Consultant', model: 'gpt-4o',
                promptText: message,
                userId: user.userId, sessionId: resolvedThreadId,
                metadata: { prompt_version: QMS_CONSULTANT_PROMPT_VERSION } },
              async () => {
                const res = await withAgentUserContext(
                  {
                    user: {
                      userId: user.userId,
                      email: user.email,
                      role: user.role,
                      autoApproveTier: resolveAutoApproveTier(user.role),
                    },
                    threadId: resolvedThreadId,
                  },
                  () => agent.generateLegacy(message, {
                    threadId: resolvedThreadId,
                    resourceId: "consultant-session",
                    abortSignal: controller.signal,
                  })
                );
                return res as AgentTextResult;
              }
            );

            const messageId = randomUUID();
            return c.json({
              success: true,
              threadId: resolvedThreadId,
              response: response.text,
              callId: callId ?? undefined,
              messageId,
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
          const user = await requireRole(c, CONSULTANT_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);

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

          // Open the parent telemetry row UP FRONT so any tools the agent
          // calls during the stream consumption can record their child rows
          // with parent_call_id pointing back here. The .run() wrapper
          // installs the AsyncLocalStorage context that propagates through
          // the agent's tool-execution loop.
          const span = await startTelemetrySpan({
            agentName: 'WalaPlus QMS Consultant',
            model: 'gpt-4o',
            promptText: message,
            userId: user.userId,
            sessionId: resolvedThreadId,
            metadata: { prompt_version: QMS_CONSULTANT_PROMPT_VERSION },
          });
          const messageId = randomUUID();
          let stream: Awaited<ReturnType<typeof agent.streamLegacy>>;
          try {
            stream = await span.run(() => withAgentUserContext(
              {
                user: {
                  userId: user.userId,
                  email: user.email,
                  role: user.role,
                  autoApproveTier: resolveAutoApproveTier(user.role),
                },
                threadId: resolvedThreadId,
              },
              () => agent.streamLegacy(message, {
                threadId: resolvedThreadId,
                resourceId: "consultant-session",
                abortSignal: controller.signal,
              })
            ));
          } catch (streamInitErr) {
            clearTimeout(timer);
            const e = streamInitErr instanceof Error ? streamInitErr : new Error(String(streamInitErr));
            span.finalize({
              success: false,
              errorClass: e.constructor.name,
              errorMessage: e.message,
            }).catch(() => {});
            throw streamInitErr;
          }

          c.header("Content-Type", "text/event-stream");
          c.header("Cache-Control", "no-cache");
          c.header("Connection", "keep-alive");

          const encoder = new TextEncoder();
          const readable = new ReadableStream({
            async start(streamController) {
              let streamSuccess = true;
              let streamError: Error | undefined;
              try {
                // Run the stream consumption INSIDE span.run() so the
                // parent_call_id ALS context is visible to tools invoked
                // during streaming (tools execute lazily as chunks flow).
                await span.run(async () => {
                  for await (const chunk of stream.textStream) {
                    streamController.enqueue(
                      encoder.encode(`data: ${JSON.stringify({ text: chunk, threadId: resolvedThreadId })}\n\n`)
                    );
                  }
                });
                // Surface callId on the final frame so clients can attach
                // inline thumbs / comment feedback (POST /api/ai-ops/feedback)
                // to this exact response. The span allocates the callId up
                // front, so it's known here without waiting for finalize().
                // messageId comes from main and is used by the client to
                // address an individual assistant turn for editing/threading.
                streamController.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ done: true, threadId: resolvedThreadId, messageId, callId: span.callId ?? undefined })}\n\n`)
                );
                streamController.close();
              } catch (err) {
                streamSuccess = false;
                streamError = err instanceof Error ? err : new Error(String(err));
                const errMsg = err instanceof Error && err.name === 'AbortError'
                  ? 'Request timed out. Please try a simpler query.'
                  : 'Stream error';
                streamController.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ error: errMsg })}\n\n`)
                );
                streamController.close();
              } finally {
                clearTimeout(timer);

                // Best-effort token-usage extraction, then finalize the
                // parent row that was opened above.
                let promptTokens: number | undefined;
                let completionTokens: number | undefined;
                let totalTokens: number | undefined;
                if (streamSuccess) {
                  try {
                    const usage = await Promise.race([
                      stream.usage ?? Promise.resolve(null),
                      new Promise<null>(res => setTimeout(() => res(null), 2000)),
                    ]);
                    if (usage && typeof usage === 'object') {
                      const u = usage as Record<string, unknown>;
                      const pt = u.promptTokens     ?? u.prompt_tokens;
                      const ct = u.completionTokens ?? u.completion_tokens;
                      const tt = u.totalTokens      ?? u.total_tokens;
                      promptTokens     = typeof pt === 'number' ? pt : undefined;
                      completionTokens = typeof ct === 'number' ? ct : undefined;
                      totalTokens      = typeof tt === 'number' ? tt : undefined;
                    }
                  } catch { /* usage unavailable */ }
                }
                span.finalize({
                  success: streamSuccess,
                  promptTokens,
                  completionTokens,
                  totalTokens,
                  errorClass: streamError ? streamError.constructor.name : undefined,
                  errorMessage: streamError?.message,
                }).catch(() => {});
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
          const user = await requireRole(c, CONSULTANT_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);

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
          const user = await requireRole(c, CONSULTANT_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);

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
          const user = await requireRole(c, CONSULTANT_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);

          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid alert ID" }, 400);

          const acknowledgedBy = user.name || user.email;

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
          const user = await requireRole(c, CONSULTANT_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);

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
          const user = await requireRole(c, CONSULTANT_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);

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
    path: "/api/consultant/feedback",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, CONSULTANT_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);

          const body = await c.req.json();
          const { messageId, conversationId, rating, category, comment, promptPreview, responsePreview, toolsCalled } = body;

          if (!messageId || !rating || !['up', 'down'].includes(rating)) {
            return c.json({ error: "messageId and valid rating ('up'|'down') are required" }, 400);
          }

          const result = await saveFeedback({
            message_id: messageId,
            conversation_id: conversationId || undefined,
            agent: 'qmsConsultantAgent',
            rating,
            category: category || undefined,
            comment: comment ? String(comment).substring(0, 1000) : undefined,
            user_id: user.userId,
            user_email: user.email,
            prompt_preview: promptPreview || undefined,
            response_preview: responsePreview || undefined,
            tools_called: toolsCalled ? JSON.stringify(toolsCalled).substring(0, 1000) : undefined,
          });

          return c.json({ success: true, id: result.id });
        } catch (error) {
          console.error("[Consultant] Feedback save error:", error);
          return c.json({ error: "Failed to save feedback" }, 500);
        }
      };
    },
  },

  {
    path: "/api/consultant/feedback/stats",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, ['admin', 'ai_specialist'] as UserRole[]);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);

          const days = parseInt(c.req.query("days") || "30");

          const isAdmin = user.role === 'admin';
          const [stats, recent] = await Promise.all([
            getFeedbackStats(days),
            isAdmin ? getRecentThumbsDown(20) : Promise.resolve([]),
          ]);

          return c.json({ stats, recent, isAdmin });
        } catch (error) {
          console.error("[Consultant] Feedback stats error:", error);
          return c.json({ error: "Failed to fetch feedback stats" }, 500);
        }
      };
    },
  },

  {
    path: "/api/consultant/feedback/trend",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, ['admin', 'ai_specialist'] as UserRole[]);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);

          const days = parseInt(c.req.query("days") || "30");
          const agentParam = c.req.query("agent");
          const normalized = typeof agentParam === "string" ? agentParam.trim() : "";
          const agent = normalized && normalized !== "all" ? normalized : null;

          const [trend, agents] = await Promise.all([
            getFeedbackTrend(days, agent),
            getDistinctFeedbackAgents(),
          ]);

          return c.json({ trend, agents, agent: agent || "all" });
        } catch (error) {
          console.error("[Consultant] Feedback trend error:", error);
          return c.json({ error: "Failed to fetch feedback trend" }, 500);
        }
      };
    },
  },

  {
    path: "/api/consultant/feedback/:messageId",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, CONSULTANT_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);

          const messageId = c.req.param("messageId");
          if (!messageId || typeof messageId !== "string") {
            return c.json({ error: "messageId is required" }, 400);
          }

          const feedback = await getFeedbackByMessageId(messageId, user.userId, user.email);
          if (!feedback) return c.json({ rating: null });

          return c.json({ rating: feedback.rating, category: feedback.category, comment: feedback.comment });
        } catch (error) {
          console.error("[Consultant] Feedback get error:", error);
          return c.json({ error: "Failed to fetch feedback" }, 500);
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
          const user = await requireRole(c, CONSULTANT_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);

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

          let scanResult: AgentTextResult | undefined;
          try {
            const { result } = await withAiTelemetry<AgentTextResult>(
              { agentName: 'WalaPlus QMS Consultant', model: 'gpt-4o',
                promptText: scanPrompt.slice(0, 300),
                userId: user.userId,
                metadata: {
                  type: 'platform_scan',
                  prompt_version: QMS_CONSULTANT_PROMPT_VERSION,
                } },
              async () => (await agent.generateLegacy(scanPrompt, {
                threadId: `scan-${Date.now()}`,
                resourceId: "system-scanner",
                abortSignal: scanController.signal,
              })) as AgentTextResult
            );
            scanResult = result;
          } finally {
            clearTimeout(scanTimer);
          }

          return c.json({
            success: true,
            summary: scanResult?.text ?? '',
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
        const user = await requireRole(c, CONSULTANT_ROLES);
        if (!user) {
          return c.json({ error: "Insufficient permissions" }, 403);
        }

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
