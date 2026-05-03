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
  buildAiCallFeedbackMetadata,
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
import {
  withAiTelemetry,
  startTelemetrySpan,
  buildAiCallTelemetryMetadata,
} from "../../utils/aiTelemetry";
import { QMS_CONSULTANT_PROMPT_VERSION } from "../agents/qmsConsultantAgent";

import { logger as safeLogger } from "../../utils/logger";
import { logger } from "../../utils/logger";
interface AgentTextResult {
  text: string;
}

const CONSULTANT_RESOURCE_ID = "consultant-session";

/**
 * After an agent turn completes, the assistant message has been persisted to
 * Mastra memory with a stable id. We surface THAT id to the client as the
 * messageId (instead of an ephemeral randomUUID) so when the user later
 * returns to the page and we fetch /api/consultant/history/:threadId, the
 * messageIds align — letting the existing per-message rating lookup
 * (GET /api/consultant/feedback/:messageId) pre-apply thumbs on prior
 * assistant turns. Falls back to a random UUID if memory is unavailable
 * (e.g. an unexpected query failure) so the client still gets *some* id.
 */
async function resolveLatestAssistantMessageId(
  agent: any,
  threadId: string,
): Promise<string> {
  try {
    const memory = await agent.getMemory?.();
    if (!memory) return randomUUID();
    const result = await memory.query({
      threadId,
      resourceId: CONSULTANT_RESOURCE_ID,
      selectBy: { last: 5 },
    });
    const v2: Array<{ id: string; role: string; createdAt: Date | string }> =
      (result?.messagesV2 as any) || [];
    for (let i = v2.length - 1; i >= 0; i--) {
      if (v2[i] && v2[i].role === "assistant" && v2[i].id) return v2[i].id;
    }
  } catch (err) {
    safeLogger.warn(
      "[ConsultantRoutes] resolveLatestAssistantMessageId failed",
      err as any,
    );
  }
  return randomUUID();
}

const CONSULTANT_ROLES: UserRole[] = [
  "admin",
  "ai_specialist",
  "grc_manager",
  "head_of_operations_quality",
];

initAIAlertsTable().catch((err) =>
  safeLogger.error("[ConsultantRoutes] initAIAlertsTable failed", err),
);
initToolHealthNotificationsTable().catch((err) =>
  safeLogger.error(
    "[ConsultantRoutes] initToolHealthNotificationsTable failed",
    err,
  ),
);
initAIFeedbackTable().catch((err) =>
  safeLogger.error("[ConsultantRoutes] initAIFeedbackTable failed", err),
);

/**
 * Resolves the user's auto-approve tier. For now (document-control phase
 * per user decision) the policy is: Quality Manager approves EVERY risk
 * tier explicitly — no user is auto-approved. This is enforced by always
 * returning 'never' here. When WP-DOC-005 is ratified and auto-approval
 * is permitted for low-risk actions, read from a users-table column.
 */
function resolveAutoApproveTier(_role: string | null): AutoApproveTier {
  return "never";
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
    // Returns the persisted Mastra chat history for a thread so the
    // consultant page (and embedded widget) can re-render the prior
    // conversation when the user reloads or comes back later. Each
    // assistant message carries its Mastra-stored id as `messageId`,
    // which matches the id surfaced at chat-time — letting the client's
    // existing per-message rating lookup pre-apply thumbs.
    path: "/api/consultant/history/:threadId",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, CONSULTANT_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);

          const threadId = c.req.param("threadId");
          if (!threadId || typeof threadId !== "string") {
            return c.json({ error: "threadId is required" }, 400);
          }

          const mastra = c.get("mastra");
          const agent = mastra?.getAgent("qmsConsultantAgent");
          if (!agent) {
            return c.json({ error: "QMS Consultant agent not available" }, 503);
          }

          const memory = await agent.getMemory?.();
          if (!memory) {
            return c.json({ messages: [] });
          }

          // Confirm the thread exists before querying — keeps the
          // response a clean empty list for unknown / never-used
          // threadIds (e.g. a stale sessionStorage value from a thread
          // the user cleared) instead of surfacing a memory error.
          const thread = await memory.getThreadById({ threadId });
          if (!thread) {
            return c.json({ messages: [] });
          }

          // Sanitize the optional ?limit= query — fall back to the
          // default when the value is missing, non-numeric, or NaN, then
          // clamp to [1, 200] so a malformed client cannot ask the
          // memory layer for an unbounded slice.
          const limitRaw = parseInt(c.req.query("limit") || "100", 10);
          const lastN = Math.max(
            1,
            Math.min(200, Number.isFinite(limitRaw) ? limitRaw : 100),
          );
          const result = await memory.query({
            threadId,
            resourceId: CONSULTANT_RESOURCE_ID,
            selectBy: { last: lastN },
          });

          // We read V2 messages only — they carry the persisted Mastra
          // id (needed to align with later feedback rating lookups) and
          // a real createdAt. Threads created with the current agent
          // configuration always populate messagesV2; legacy / V1-only
          // threads are not supported by this rehydration path and will
          // appear as an empty transcript (the welcome state takes over)
          // rather than being shown without stable ids. We only surface
          // user / assistant text turns — tool calls, system messages,
          // and working-memory injections aren't useful for re-rendering
          // the chat transcript.
          const v2: any[] = (result?.messagesV2 as any[]) || [];
          const messages = v2
            .filter((m) => m && (m.role === "user" || m.role === "assistant"))
            .map((m) => {
              let text = "";
              const content = m.content;
              if (typeof content === "string") {
                text = content;
              } else if (content && typeof content === "object") {
                if (typeof content.content === "string") {
                  text = content.content;
                } else if (Array.isArray(content.parts)) {
                  text = content.parts
                    .map((p: any) =>
                      p && typeof p === "object" && typeof p.text === "string"
                        ? p.text
                        : "",
                    )
                    .filter(Boolean)
                    .join("");
                }
              }
              return {
                messageId: m.id,
                role: m.role,
                content: text,
                createdAt:
                  m.createdAt instanceof Date
                    ? m.createdAt.toISOString()
                    : m.createdAt || null,
              };
            })
            .filter((m) => m.content && m.content.trim().length > 0);

          return c.json({
            threadId,
            promptVersion: QMS_CONSULTANT_PROMPT_VERSION,
            messages,
          });
        } catch (error) {
          logger.error("[Consultant] History fetch error:", error);
          return c.json({ error: "Failed to fetch history" }, 500);
        }
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

          const chatTimeout = parseInt(
            process.env.CONSULTANT_CHAT_TIMEOUT_MS || "120000",
          );
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), chatTimeout);

          try {
            // Wrap agent invocation in AsyncLocalStorage so any AI write-tool
            // called during this turn can see WHO prompted it. Without this,
            // the HITL gate cannot attribute pending actions to a user.
            const { result: response, callId } =
              await withAiTelemetry<AgentTextResult>(
                {
                  agentName: "WalaPlus QMS Consultant",
                  model: "gpt-4o",
                  promptText: message,
                  userId: user.userId,
                  sessionId: resolvedThreadId,
                  metadata: buildAiCallTelemetryMetadata({
                    promptVersion: QMS_CONSULTANT_PROMPT_VERSION,
                  }),
                },
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
                    () =>
                      agent.generateLegacy(message, {
                        threadId: resolvedThreadId,
                        resourceId: CONSULTANT_RESOURCE_ID,
                        abortSignal: controller.signal,
                      }),
                  );
                  return res as AgentTextResult;
                },
              );

            const messageId = await resolveLatestAssistantMessageId(
              agent,
              resolvedThreadId,
            );
            return c.json({
              success: true,
              threadId: resolvedThreadId,
              response: response.text,
              callId: callId ?? undefined,
              messageId,
              // Surface the prompt revision active for THIS turn so the
              // client can echo it back when the user thumbs-up/down,
              // letting analytics correlate ratings to the exact prompt
              // the user actually saw (instead of the latest server-side
              // constant at rating-save time).
              promptVersion: QMS_CONSULTANT_PROMPT_VERSION,
            });
          } finally {
            clearTimeout(timer);
          }
        } catch (error) {
          logger.error("[Consultant] Chat error:", error);
          return c.json(
            {
              error: "Failed to process message",
              details: error instanceof Error ? error.message : String(error),
            },
            500,
          );
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

          const streamTimeout = parseInt(
            process.env.CONSULTANT_STREAM_TIMEOUT_MS || "120000",
          );
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), streamTimeout);

          // Open the parent telemetry row UP FRONT so any tools the agent
          // calls during the stream consumption can record their child rows
          // with parent_call_id pointing back here. The .run() wrapper
          // installs the AsyncLocalStorage context that propagates through
          // the agent's tool-execution loop.
          const span = await startTelemetrySpan({
            agentName: "WalaPlus QMS Consultant",
            model: "gpt-4o",
            promptText: message,
            userId: user.userId,
            sessionId: resolvedThreadId,
            metadata: buildAiCallTelemetryMetadata({
              promptVersion: QMS_CONSULTANT_PROMPT_VERSION,
            }),
          });
          let stream: Awaited<ReturnType<typeof agent.streamLegacy>>;
          try {
            stream = await span.run(() =>
              withAgentUserContext(
                {
                  user: {
                    userId: user.userId,
                    email: user.email,
                    role: user.role,
                    autoApproveTier: resolveAutoApproveTier(user.role),
                  },
                  threadId: resolvedThreadId,
                },
                () =>
                  agent.streamLegacy(message, {
                    threadId: resolvedThreadId,
                    resourceId: CONSULTANT_RESOURCE_ID,
                    abortSignal: controller.signal,
                  }),
              ),
            );
          } catch (streamInitErr) {
            clearTimeout(timer);
            const e =
              streamInitErr instanceof Error
                ? streamInitErr
                : new Error(String(streamInitErr));
            span
              .finalize({
                success: false,
                errorClass: e.constructor.name,
                errorMessage: e.message,
              })
              .catch(() => {});
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
                      encoder.encode(
                        `data: ${JSON.stringify({ text: chunk, threadId: resolvedThreadId })}\n\n`,
                      ),
                    );
                  }
                });
                // Surface callId on the final frame so clients can attach
                // inline thumbs / comment feedback (POST /api/ai-ops/feedback)
                // to this exact response. The span allocates the callId up
                // front, so it's known here without waiting for finalize().
                // messageId is resolved AFTER streaming completes so it
                // matches the assistant message Mastra just persisted to
                // memory. Returning that stable id (instead of a random
                // UUID) lets the history endpoint pre-apply prior thumbs
                // when the user revisits the page.
                const messageId = await resolveLatestAssistantMessageId(
                  agent,
                  resolvedThreadId,
                );
                streamController.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ done: true, threadId: resolvedThreadId, messageId, callId: span.callId ?? undefined, promptVersion: QMS_CONSULTANT_PROMPT_VERSION })}\n\n`,
                  ),
                );
                streamController.close();
              } catch (err) {
                streamSuccess = false;
                streamError =
                  err instanceof Error ? err : new Error(String(err));
                const errMsg =
                  err instanceof Error && err.name === "AbortError"
                    ? "Request timed out. Please try a simpler query."
                    : "Stream error";
                streamController.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ error: errMsg })}\n\n`,
                  ),
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
                      new Promise<null>((res) =>
                        setTimeout(() => res(null), 2000),
                      ),
                    ]);
                    if (usage && typeof usage === "object") {
                      const u = usage as Record<string, unknown>;
                      const pt = u.promptTokens ?? u.prompt_tokens;
                      const ct = u.completionTokens ?? u.completion_tokens;
                      const tt = u.totalTokens ?? u.total_tokens;
                      promptTokens = typeof pt === "number" ? pt : undefined;
                      completionTokens =
                        typeof ct === "number" ? ct : undefined;
                      totalTokens = typeof tt === "number" ? tt : undefined;
                    }
                  } catch {
                    /* usage unavailable */
                  }
                }
                span
                  .finalize({
                    success: streamSuccess,
                    promptTokens,
                    completionTokens,
                    totalTokens,
                    errorClass: streamError
                      ? streamError.constructor.name
                      : undefined,
                    errorMessage: streamError?.message,
                  })
                  .catch(() => {});
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
          logger.error("[Consultant] Stream error:", error);
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
          logger.error("[Consultant] Alerts fetch error:", error);
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
          const {
            messageId,
            conversationId,
            rating,
            category,
            comment,
            promptPreview,
            responsePreview,
            toolsCalled,
            promptVersion: clientPromptVersion,
            ratingSource: clientRatingSource,
            clientSurface: clientSurfaceInput,
          } = body;

          if (!messageId || !rating || !["up", "down"].includes(rating)) {
            return c.json(
              {
                error: "messageId and valid rating ('up'|'down') are required",
              },
              400,
            );
          }

          // Validate caller-supplied metadata strings: trim, drop empties,
          // and clamp length so a malicious / buggy client can't push a
          // multi-MB blob into the JSONB column. The closed allow-list
          // already prevents arbitrary KEYS from being persisted (see
          // buildAiCallFeedbackMetadata); this guards the VALUES.
          const safeMetaString = (value: unknown, max: number): string | undefined => {
            if (typeof value !== 'string') return undefined;
            const trimmed = value.trim();
            if (!trimmed) return undefined;
            return trimmed.substring(0, max);
          };

          // Always route metadata through buildAiCallFeedbackMetadata so the
          // closed allow-list (Task #512) is enforced at the call site.
          // promptVersion lets analytics correlate thumbs-up/down to the
          // exact consultant prompt revision the user reacted to — we
          // prefer the value the CLIENT echoed back (captured at the
          // moment the response was rendered) and fall back to the
          // current server-side constant only when the client didn't
          // send one (older clients that haven't been updated yet).
          // ratingSource / clientSurface mark which UI surface produced
          // the rating; defaults match the inline thumbs on the web
          // consultant chat (other surfaces — Slack, mobile, embedded
          // widget — supply different values when wired up).
          const feedbackMetadata = buildAiCallFeedbackMetadata({
            promptVersion: safeMetaString(clientPromptVersion, 100) ?? QMS_CONSULTANT_PROMPT_VERSION,
            ratingSource: safeMetaString(clientRatingSource, 50) ?? 'inline_thumbs',
            clientSurface: safeMetaString(clientSurfaceInput, 50) ?? 'web',
          });

          const result = await saveFeedback({
            message_id: messageId,
            conversation_id: conversationId || undefined,
            agent: "qmsConsultantAgent",
            rating,
            category: category || undefined,
            comment: comment ? String(comment).substring(0, 1000) : undefined,
            user_id: user.userId,
            user_email: user.email,
            prompt_preview: promptPreview || undefined,
            response_preview: responsePreview || undefined,
            tools_called: toolsCalled
              ? JSON.stringify(toolsCalled).substring(0, 1000)
              : undefined,
            metadata: feedbackMetadata,
          });

          return c.json({ success: true, id: result.id });
        } catch (error) {
          logger.error("[Consultant] Feedback save error:", error);
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
          const user = await requireRole(c, [
            "admin",
            "ai_specialist",
          ] as UserRole[]);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);

          const days = parseInt(c.req.query("days") || "30");

          // Optional metadata filters so admins triaging a regression can
          // narrow the recent thumbs-down list down to a specific prompt
          // revision (`metadata->>'prompt_version'`), feature-flag bucket
          // (`metadata->>'feature_flag'`), or client surface
          // (`metadata->>'client_surface'`). Mirrors the snake_case shape
          // the sibling `ai_call_metrics.metadata` endpoints already speak
          // so the dashboard can wire the same filter values across both
          // panels. The downstream `getRecentThumbsDown()` helper trims,
          // length-caps, and binds these via parameterised SQL so no
          // validation needs to happen here.
          const promptVersion =
            c.req.query("prompt_version") ?? c.req.query("promptVersion");
          const featureFlag =
            c.req.query("feature_flag") ?? c.req.query("featureFlag");
          const clientSurface =
            c.req.query("client_surface") ?? c.req.query("clientSurface");
          // Task #767: third triage dimension on the recent thumbs-down list.
          // Mirrors the snake_case / camelCase fallback pattern used by the
          // sibling filters so the dashboard can speak either spelling.
          const ratingSource =
            c.req.query("rating_source") ?? c.req.query("ratingSource");
          // Task #423: optional `agent` filter so the AI Ops feedback tab can
          // narrow KPIs, top-thumbs-down categories, and the recent
          // thumbs-down list down to the same agent already supported by the
          // trend chart endpoint. The literal "all" sentinel emitted by the
          // dashboard dropdown is treated as "no filter" so the frontend can
          // forward the dropdown value verbatim.
          const agentRaw = c.req.query("agent");
          const agentNormalized =
            typeof agentRaw === "string" ? agentRaw.trim() : "";
          const agent =
            agentNormalized && agentNormalized !== "all"
              ? agentNormalized
              : null;

          const isAdmin = user.role === "admin";
          const [stats, recent] = await Promise.all([
            getFeedbackStats(days, agent),
            isAdmin
              ? getRecentThumbsDown(20, {
                  promptVersion:
                    typeof promptVersion === "string" ? promptVersion : null,
                  featureFlag:
                    typeof featureFlag === "string" ? featureFlag : null,
                  clientSurface:
                    typeof clientSurface === "string" ? clientSurface : null,
                  ratingSource:
                    typeof ratingSource === "string" ? ratingSource : null,
                  agent,
                })
              : Promise.resolve([]),
          ]);

          return c.json({ stats, recent, isAdmin, agent: agent || "all" });
        } catch (error) {
          logger.error("[Consultant] Feedback stats error:", error);
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
          const user = await requireRole(c, [
            "admin",
            "ai_specialist",
          ] as UserRole[]);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);

          const days = parseInt(c.req.query("days") || "30");
          const agentParam = c.req.query("agent");
          const normalized =
            typeof agentParam === "string" ? agentParam.trim() : "";
          const agent = normalized && normalized !== "all" ? normalized : null;

          const [trend, agents] = await Promise.all([
            getFeedbackTrend(days, agent),
            getDistinctFeedbackAgents(),
          ]);

          return c.json({ trend, agents, agent: agent || "all" });
        } catch (error) {
          logger.error("[Consultant] Feedback trend error:", error);
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

          const feedback = await getFeedbackByMessageId(
            messageId,
            user.userId,
            user.email,
          );
          if (!feedback) return c.json({ rating: null });

          return c.json({
            rating: feedback.rating,
            category: feedback.category,
            comment: feedback.comment,
          });
        } catch (error) {
          logger.error("[Consultant] Feedback get error:", error);
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

          const scanTimeout = parseInt(
            process.env.CONSULTANT_SCAN_TIMEOUT_MS || "300000",
          );
          const scanController = new AbortController();
          const scanTimer = setTimeout(
            () => scanController.abort(),
            scanTimeout,
          );

          let scanResult: AgentTextResult | undefined;
          try {
            const { result } = await withAiTelemetry<AgentTextResult>(
              {
                agentName: "WalaPlus QMS Consultant",
                model: "gpt-4o",
                promptText: scanPrompt.slice(0, 300),
                userId: user.userId,
                metadata: buildAiCallTelemetryMetadata({
                  scanType: "platform_scan",
                  promptVersion: QMS_CONSULTANT_PROMPT_VERSION,
                }),
              },
              async () =>
                (await agent.generateLegacy(scanPrompt, {
                  threadId: `scan-${Date.now()}`,
                  resourceId: "system-scanner",
                  abortSignal: scanController.signal,
                })) as AgentTextResult,
            );
            scanResult = result;
          } finally {
            clearTimeout(scanTimer);
          }

          return c.json({
            success: true,
            summary: scanResult?.text ?? "",
          });
        } catch (error) {
          logger.error("[Consultant] Scan error:", error);
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
              const { runBackgroundScan } =
                await import("../../utils/aiBackgroundScanner");

              for (const step of steps) {
                streamController.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ step: step.label, pct: step.pct })}\n\n`,
                  ),
                );
              }

              const result = await runBackgroundScan();
              streamController.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ done: true, pct: 100, result })}\n\n`,
                ),
              );
            } catch (err) {
              streamController.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ error: err instanceof Error ? err.message : "Scan failed" })}\n\n`,
                ),
              );
            }
            streamController.close();
          },
        });

        return new Response(readable, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
          },
        });
      };
    },
  },
];
