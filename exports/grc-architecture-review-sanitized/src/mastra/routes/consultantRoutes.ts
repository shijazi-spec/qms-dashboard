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

/**
 * Adaptive method selection — the FINAL fix to the recurring AI Consultant
 * regression.
 *
 * Background. The widget has alternated between working and broken at
 * least FIVE times across SDK upgrades because Mastra rejects one of
 * generate/stream OR generateLegacy/streamLegacy depending on whether
 * LLMProvider.chat("gpt-4o") at startup produces a V4-shaped or V2/V5-shaped
 * model class. The two error messages that have appeared at different
 * times:
 *
 *   V4 model + generate()       → "AI SDK v4 model not compatible with
 *                                  stream(). Please use AI SDK v5 models
 *                                  or call the streamLegacy() method"
 *   V2 model + generateLegacy() → "V2 models are not supported for
 *                                  generateLegacy. Please use generate"
 *
 * Every previous "root fix" pinned ONE polarity in code, then the next
 * `@mastra/core` or `@ai-sdk/LLMProvider` bump flipped it and broke the
 * widget again. Operators have re-patched this five times.
 *
 * This implementation TRIES one polarity, catches the specific
 * incompatibility error, and self-corrects to the other. The choice is
 * cached so subsequent requests skip the failed attempt. On a Mastra
 * upgrade that flips the polarity, the next failing request flips the
 * cache automatically — no manual patch needed.
 *
 * The detector is matched against the literal error strings the two
 * Mastra paths emit (exact text from their throw sites). Wrong match =
 * we re-throw and the outer route handler logs it. Right match = we
 * flip the cache and retry exactly once.
 */
type AgentMethodPolarity = "modern" | "legacy" | "unknown";
let _generateMethodCache: AgentMethodPolarity = "unknown";
let _streamMethodCache: AgentMethodPolarity = "unknown";

function _isV4ModelError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /AI SDK v4 model.*not compatible with (stream|generate)\(\)|call the (stream|generate)Legacy\(\) method/i.test(
    msg,
  );
}
function _isV2ModelLegacyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /V2 models? (?:are|is) not supported for (stream|generate)Legacy/i.test(
    msg,
  );
}

/**
 * Call agent.generate() OR agent.generateLegacy() adaptively. Cached
 * choice survives between requests; only the FIRST request after a
 * Mastra polarity flip pays the retry cost.
 */
async function agentGenerateAdaptive(
  agent: any,
  message: string,
  options: Record<string, unknown>,
): Promise<unknown> {
  // Pass a proper messages array (matches the known-good qualityAuditWorkflow
  // call) rather than a bare string — some Mastra builds mis-route a raw
  // string into a legacy path.
  const msgs = [{ role: "user", content: message }];
  try {
    const r = await agent.generate(msgs, options as any);
    _generateMethodCache = "modern";
    return r;
  } catch (modernErr) {
    // Any non-polarity error (tool schema, LLMProvider auth/quota, RBAC, etc.) is
    // the REAL cause — surface it directly instead of masking it with a
    // misleading legacy retry.
    if (!_isV4ModelError(modernErr)) throw modernErr;
    try {
      const r = await agent.generateLegacy(msgs, options as any);
      _generateMethodCache = "legacy";
      return r;
    } catch (legacyErr) {
      if (_isV2ModelLegacyError(legacyErr)) {
        throw new Error(
          "AI SDK/core version mismatch: generate() reports a v4-spec model while " +
            "generateLegacy() reports a v2-spec model — @ai-sdk/LLMProvider and @mastra/core " +
            "are incompatible (pin a compatible pair). modern: " +
            (modernErr instanceof Error ? modernErr.message : String(modernErr)),
        );
      }
      throw modernErr; // surface the meaningful (modern) error
    }
  }
}

/**
 * Same adaptive selector for agent.stream() / agent.streamLegacy().
 */
async function agentStreamAdaptive(
  agent: any,
  message: string,
  options: Record<string, unknown>,
): Promise<unknown> {
  const msgs = [{ role: "user", content: message }];
  try {
    const r = await agent.stream(msgs, options as any);
    _streamMethodCache = "modern";
    return r;
  } catch (modernErr) {
    if (!_isV4ModelError(modernErr)) throw modernErr;
    try {
      const r = await agent.streamLegacy(msgs, options as any);
      _streamMethodCache = "legacy";
      return r;
    } catch (legacyErr) {
      if (_isV2ModelLegacyError(legacyErr)) {
        throw new Error(
          "AI SDK/core version mismatch: stream() reports a v4-spec model while " +
            "streamLegacy() reports a v2-spec model — @ai-sdk/LLMProvider and @mastra/core " +
            "are incompatible (pin a compatible pair). modern: " +
            (modernErr instanceof Error ? modernErr.message : String(modernErr)),
        );
      }
      throw modernErr;
    }
  }
}

/**
 * Robust text extractor for agent.generate() results.
 *
 * Background: this widget has flipped between "No response received"
 * and working state at least four times across SDK upgrades because
 * Mastra's response shape is not stable. As of 2026-06-08 we know of
 * at least SIX different runtime shapes that can come back from
 * `await agent.generate(message, { format: 'aisdk' })`:
 *
 *   1. V4 / generateLegacy()              → { text: string, ... }
 *   2. V2 / generate() + format=aisdk     → { text: string, ... }     (aisdk getFullOutput resolved)
 *   3. V2 / generate() + format=mastra    → MastraModelOutput { content: [...], ... } (DEFAULT)
 *   4. NEW (2026-06-08): generate() returns the *stream object itself*
 *      with `text` as a `Promise<string>` getter — Mastra silently dropped
 *      the deprecated `format` option in some build paths, so the result
 *      is the unresolved AISDKV5OutputStream / MastraModelOutput where
 *      both `.text` and `.textStream` are getters on the live stream.
 *   5. Wrapped result { response: { text: '...' } } (older mastra-format)
 *   6. Plain string (shouldn't happen but some test paths emit this)
 *
 * Each upgrade has silently changed which default applies. We MUST
 * handle the Promise-text shape (#4) — that one returns `undefined`
 * to a sync extractor and is exactly what's causing the
 * "No response received." regression on the live deployment today.
 *
 * Helper is async so we can await Promise-text getters. The two call
 * sites (chat + scan) are already async, so awaiting here is free.
 */
export async function extractAgentText(result: unknown): Promise<string> {
  if (result == null) return "";
  // Shape #6 — plain string.
  if (typeof result === "string") return result;
  if (typeof result !== "object") return "";
  const r = result as Record<string, unknown>;

  // Shape #1, #2, #6: direct .text property. If it's a Promise (shape #4),
  // await it. If it's a non-empty string, return it. Anything else, fall
  // through to the next attempt.
  const rawText = r.text;
  if (rawText != null) {
    if (typeof rawText === "string" && rawText) return rawText;
    // Promise getter — exercise it.
    if (
      typeof (rawText as any)?.then === "function" ||
      typeof rawText === "object"
    ) {
      try {
        const awaited = await Promise.resolve(rawText as any);
        if (typeof awaited === "string" && awaited) return awaited;
      } catch {
        /* fall through */
      }
    }
  }

  // Shape #4 specifically — getFullOutput() exists as a method, call it.
  if (typeof (r as any).getFullOutput === "function") {
    try {
      const full = await (r as any).getFullOutput();
      if (full && typeof full === "object") {
        const t = (full as Record<string, unknown>).text;
        if (typeof t === "string" && t) return t;
      }
    } catch {
      /* fall through */
    }
  }

  // Shape #3 (mastra): { content: [{ type: 'text', text: '...' }, ...] }
  if (Array.isArray(r.content)) {
    const parts = r.content
      .map((p: any) =>
        typeof p?.text === "string" ? p.text : typeof p === "string" ? p : "",
      )
      .filter(Boolean);
    if (parts.length) return parts.join("");
  }

  // Shape #5 (older mastra): { response: { text: '...' } }
  if (r.response && typeof r.response === "object") {
    const inner = (r.response as Record<string, unknown>).text;
    if (typeof inner === "string" && inner) return inner;
    if (
      typeof (inner as any)?.then === "function" ||
      typeof inner === "object"
    ) {
      try {
        const awaited = await Promise.resolve(inner as any);
        if (typeof awaited === "string" && awaited) return awaited;
      } catch {
        /* fall through */
      }
    }
  }

  // Tool-call only or empty completion — return empty string, NOT undefined.
  return "";
}

/**
 * Returns a per-user resource ID so each user's AI conversation history is
 * isolated in Mastra memory. Using the shared constant "consultant-session"
 * would let any role-qualified user read or append to another user's thread
 * by supplying a known threadId — the per-user namespace is the primary
 * ownership boundary that prevents cross-user thread replay.
 */
function userResourceId(userId: string | number): string {
  return `consultant-${userId}`;
}

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
/**
 * Try to extract the assistant message id directly from the agent's own
 * result object before falling back to a memory query. Mastra's generate()
 * and stream() expose the persisted messages on `response.messages` once
 * the turn completes — reading from there avoids an extra PG round-trip
 * after every single chat turn (saves ~10-50ms of TTLB on every request).
 */
function extractAssistantIdFromAgentResult(result: any): string | null {
  try {
    const candidates = [
      result?.response?.messages,
      result?.messages,
      result?.responseMessages,
    ];
    for (const msgs of candidates) {
      if (!Array.isArray(msgs)) continue;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m && m.role === "assistant" && typeof m.id === "string" && m.id) {
          return m.id;
        }
      }
    }
  } catch {
    /* fall through to memory query */
  }
  return null;
}

async function resolveLatestAssistantMessageId(
  agent: any,
  threadId: string,
  resourceId: string,
  preloaded?: any,
): Promise<string> {
  // Fast path — pull the id straight from the agent result if available.
  if (preloaded) {
    const fromResult = extractAssistantIdFromAgentResult(preloaded);
    if (fromResult) return fromResult;
  }
  try {
    const memory = await agent.getMemory?.();
    if (!memory) return randomUUID();
    const result = await memory.query({
      threadId,
      resourceId,
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

/**
 * Per-thread serialization. Mastra's memory layer is not safe against
 * two concurrent writes on the same threadId — rapid double-sends from
 * the same user (e.g. impatient retry) can interleave assistant turns
 * and corrupt the transcript order. We chain incoming requests for the
 * same threadId through a tiny in-process Map so they execute serially.
 * Different threads remain fully concurrent.
 *
 * We also cap the map size as a safety net so a long-running process
 * with many threads does not leak entries when threads finish (each
 * thread's entry is removed once it resolves).
 */
const threadMutex = new Map<string, Promise<unknown>>();
const THREAD_MUTEX_MAX_SIZE = 5_000;
async function withThreadLock<T>(
  threadId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = threadMutex.get(threadId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  threadMutex.set(threadId, next);
  if (threadMutex.size > THREAD_MUTEX_MAX_SIZE) {
    // Drop the oldest entries; any in-flight promise they reference is
    // still kept alive by the await chain below.
    const it = threadMutex.keys();
    for (let i = 0; i < 1000; i++) {
      const k = it.next();
      if (k.done) break;
      threadMutex.delete(k.value);
    }
  }
  try {
    return await next;
  } finally {
    // Only clear if no newer waiter has chained on top of us.
    if (threadMutex.get(threadId) === next) {
      threadMutex.delete(threadId);
    }
  }
}

// AI Consultant is intentionally available to every authenticated platform
// user, regardless of role. Per product decision (May 2026): the consultant
// is a self-service helper for the whole team, not an admin-only tool. The
// underlying data tools the consultant invokes still apply their own per-
// module RBAC, so a viewer-level user can chat with the consultant but the
// consultant will only see / surface data that user is allowed to see.
const CONSULTANT_ROLES: UserRole[] = [
  "admin",
  "head_of_operations_quality",
  "quality_manager",
  "quality_specialist",
  "grc_manager",
  "team_lead",
  "department_viewer",
  "auditor",
  "ai_specialist",
  "bu_owner",
  "executive",
  "custom",
];

// The comprehensive scan (/api/consultant/scan and /api/consultant/scan-stream)
// invokes every restricted monitoring tool in sequence and must therefore be
// limited to roles that are allowed by ALL of those tools' individual RBAC
// checks. runBackgroundScan() (used by scan-stream) queries the database
// directly and cannot rely on tool-level RBAC at all, so it must be gated
// here at the route level as well.
const SCAN_ROLES: UserRole[] = [
  "admin",
  "head_of_operations_quality",
  "grc_manager",
  "quality_manager",
];

// Alert endpoints expose cross-module operational data (risk scores, PDPL
// incidents, AI-ops failures, tool-health incidents) that is not scoped to
// any individual user or module. Restrict both reads and mutations to roles
// that legitimately own the full operational picture.
const ALERT_ADMIN_ROLES: UserRole[] = ["admin", "ai_specialist"];

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

          // Ownership check: the thread's resourceId must match the
          // requesting user's own resource namespace. Without this a
          // role-qualified user who knows another user's threadId could
          // read that user's full AI conversation history.
          const expectedResourceId = userResourceId(user.userId);
          if (thread.resourceId && thread.resourceId !== expectedResourceId) {
            return c.json({ error: "Not found" }, 404);
          }

          // Sanitize the optional ?limit= query — fall back to the
          // default when the value is missing, non-numeric, or NaN, then
          // clamp to [1, 200] so a malformed client cannot ask the
          // memory layer for an unbounded slice. Default is 40 to match
          // the agent's lastMessages window — fetching more is wasted
          // work since the model only ever sees the last 40 anyway.
          const limitRaw = parseInt(c.req.query("limit") || "40", 10);
          const lastN = Math.max(
            1,
            Math.min(200, Number.isFinite(limitRaw) ? limitRaw : 40),
          );
          const result = await memory.query({
            threadId,
            resourceId: expectedResourceId,
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
    // List the requesting user's chat threads (server-side, so the Chat
    // History sidebar follows the user across devices/browsers instead of
    // living only in that browser's localStorage). Resource-scoped: only the
    // caller's own threads (resourceId = userResourceId) are ever returned.
    // Title + message-count come from thread.title / thread.metadata, which the
    // /threads/:threadId/meta endpoint keeps current as the user chats.
    path: "/api/consultant/threads",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, CONSULTANT_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);

          const mastra = c.get("mastra");
          const agent = mastra?.getAgent("qmsConsultantAgent");
          const memory = await agent?.getMemory?.();
          if (!memory) return c.json({ threads: [] });

          const resourceId = userResourceId(user.userId);
          const threads: any[] = await memory
            .getThreadsByResourceId({ resourceId })
            .catch(() => []);

          const toIso = (d: any): string | null =>
            d instanceof Date ? d.toISOString() : typeof d === "string" ? d : null;

          const list = (threads || [])
            .filter((t) => t && t.id)
            .map((t) => ({
              threadId: t.id,
              title:
                (t.title && String(t.title).trim()) ||
                (t.metadata && String(t.metadata.title || "").trim()) ||
                "Chat",
              messages:
                (t.metadata && Number(t.metadata.messages)) || 0,
              time: toIso(t.updatedAt) || toIso(t.createdAt) || null,
            }))
            // Newest first (server ordering isn't guaranteed across adapters).
            .sort((a, b) => String(b.time || "").localeCompare(String(a.time || "")));

          return c.json({ threads: list });
        } catch (error) {
          logger.error("[Consultant] Thread list error:", error);
          return c.json({ error: "Failed to list threads" }, 500);
        }
      };
    },
  },

  {
    // Persist a thread's display title + message count so the cross-device
    // history list can show a meaningful label. Called by the client as the
    // user chats (mirrors the old localStorage saveChatToHistory). generateTitle
    // is disabled on this agent (avoids a blocking GPT call), so the title is
    // the client-derived first-user-message snippet. Ownership-checked.
    path: "/api/consultant/threads/:threadId/meta",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, CONSULTANT_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);

          const threadId = c.req.param("threadId");
          if (!threadId) return c.json({ error: "threadId is required" }, 400);

          const body = await c.req.json().catch(() => ({}));
          const title =
            typeof body?.title === "string" ? body.title.trim().slice(0, 120) : "";
          const messages = Number.isFinite(body?.messages)
            ? Math.max(0, Math.floor(body.messages))
            : 0;

          const mastra = c.get("mastra");
          const agent = mastra?.getAgent("qmsConsultantAgent");
          const memory = await agent?.getMemory?.();
          if (!memory) return c.json({ ok: false });

          const resourceId = userResourceId(user.userId);
          const thread = await memory.getThreadById({ threadId });
          // Thread is created by the chat generate call; if it isn't there yet
          // (meta arrived first), skip quietly rather than error.
          if (!thread) return c.json({ ok: false });
          if (thread.resourceId && thread.resourceId !== resourceId) {
            return c.json({ error: "Not found" }, 404);
          }

          await memory.updateThread({
            id: threadId,
            title: title || thread.title || "Chat",
            metadata: {
              ...(thread.metadata || {}),
              title: title || (thread.metadata as any)?.title || "Chat",
              messages,
            },
          });
          return c.json({ ok: true });
        } catch (error) {
          logger.error("[Consultant] Thread meta update error:", error);
          return c.json({ error: "Failed to update thread" }, 500);
        }
      };
    },
  },

  {
    // Delete ONE of the caller's chat threads — the only thing that removes a
    // chat (the client's ✕ button). Ownership-checked so a role-qualified user
    // cannot delete another user's thread by id.
    path: "/api/consultant/threads/:threadId",
    method: "DELETE" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, CONSULTANT_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);

          const threadId = c.req.param("threadId");
          if (!threadId) return c.json({ error: "threadId is required" }, 400);

          const mastra = c.get("mastra");
          const agent = mastra?.getAgent("qmsConsultantAgent");
          const memory = await agent?.getMemory?.();
          if (!memory) return c.json({ ok: true });

          const resourceId = userResourceId(user.userId);
          const thread = await memory.getThreadById({ threadId });
          if (thread && thread.resourceId && thread.resourceId !== resourceId) {
            return c.json({ error: "Not found" }, 404);
          }
          await memory.deleteThread(threadId).catch(() => {});
          return c.json({ ok: true });
        } catch (error) {
          logger.error("[Consultant] Thread delete error:", error);
          return c.json({ error: "Failed to delete thread" }, 500);
        }
      };
    },
  },

  {
    // AssistantPersona's persistent Working Memory for the requesting user — the durable
    // "what AssistantPersona knows about me" profile that follows them across every chat
    // (web + ChatProvider). PDPL/ISO 27001: a user can only ever read THEIR OWN
    // memory (namespaced by resourceId) and can clear it via the sibling
    // /clear route. Returns the raw markdown so the page can render it.
    path: "/api/consultant/memory",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, CONSULTANT_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);

          const mastra = c.get("mastra");
          const agent = mastra?.getAgent("qmsConsultantAgent");
          const memory = agent ? await agent.getMemory?.() : null;
          if (!memory) return c.json({ memory: "", enabled: false });

          const resourceId = userResourceId(user.userId);
          // Working memory is resource-scoped; threadId is required by the
          // signature but the stored value is keyed by resourceId.
          const content = await memory.getWorkingMemory({
            threadId: `consultant-${user.userId}`,
            resourceId,
          });
          return c.json({ memory: content || "", enabled: true });
        } catch (error) {
          logger.error("[Consultant] Working-memory fetch error:", error);
          return c.json({ error: "Failed to fetch memory" }, 500);
        }
      };
    },
  },

  {
    // LLMProvider credential health check (Sample User 2026-07-26): confirm the key the
    // app actually uses works — after swapping in the Tier-4 key. Reports which
    // env source is active + a MASKED tail (never the full key), then makes a
    // tiny live chat call and reports ok / the exact provider error (rate limit,
    // auth, etc.). Read-only, no state change.
    //   GET /api/consultant/LLMProvider-health
    path: "/api/consultant/LLMProvider-health",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, CONSULTANT_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);

          const { getLLMProviderApiKey, getLLMProviderBaseUrl } = await import(
            "../../utils/LLMProviderCredentials"
          );
          const key = getLLMProviderApiKey();
          const baseUrl = getLLMProviderBaseUrl() || "<REDACTED_URL>";
          const aiInt = process.env.AI_INTEGRATIONS_LLMProvider_API_KEY;
          const source =
            aiInt && aiInt.length >= 40
              ? "AI_INTEGRATIONS_LLMProvider_API_KEY"
              : process.env.LLMProvider_API_KEY
                ? "LLMProvider_API_KEY"
                : "<REDACTED_SECRET>";
          const mask = (k?: string) =>
            k ? `${k.slice(0, 3)}…${k.slice(-4)} (len ${k.length})` : "(unset)";

          if (!key) {
            return c.json({
              ok: false,
              keySource: source,
              keyMasked: mask(key),
              error: "No LLMProvider key resolved — set LLMProvider_API_KEY.",
            });
          }

          const t0 = Date.now();
          let ok = false;
          let status = 0;
          let model = "gpt-4o";
          let errorMsg: string | undefined;
          let org: string | undefined;
          try {
            const resp = await fetch(`${baseUrl}/chat/completions`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${key}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model,
                max_tokens: <REDACTED_SECRET>
                messages: [{ role: "user", content: "ping" }],
              }),
            });
            status = resp.status;
            org = resp.headers.get("LLMProvider-organization") || undefined;
            ok = resp.ok;
            if (!resp.ok) {
              const body = await resp.json().catch(() => ({}));
              // Sanitize — never echo a key even if the provider does.
              errorMsg = String(body?.error?.message || resp.statusText).replace(
                /sk-[A-Za-z0-9_-]+/g,
                "sk-…",
              );
            }
          } catch (e: any) {
            errorMsg = e?.message || String(e);
          }

          return c.json({
            ok,
            keySource: source,
            keyMasked: mask(key),
            usingGateway: baseUrl !== "<REDACTED_URL>",
            baseUrl: baseUrl.replace(/\/+$/, ""),
            org: org || null,
            model,
            httpStatus: status,
            latencyMs: Date.now() - t0,
            error: errorMsg || null,
            hint: ok
              ? "Key works — AssistantPersona is live on this key."
              : /rate limit|429|tokens per min|TPM/i.test(errorMsg || "")
                ? "Still rate-limited — the app is NOT on the new Tier-4 key yet. Check that LLMProvider_API_KEY holds the new key AND that AI_INTEGRATIONS_LLMProvider_API_KEY is cleared, then republish."
                : /invalid|incorrect|auth|401/i.test(errorMsg || "")
                  ? "Auth error — the key value looks wrong or wasn't saved to the deployment secrets."
                  : "Call failed — see error.",
          });
        } catch (error) {
          logger.error("[Consultant] LLMProvider-health error:", error);
          return c.json({ error: "Health check failed" }, 500);
        }
      };
    },
  },

  {
    // Clear what AssistantPersona remembers about the requesting user (PDPL right to
    // erasure). Resets the resource-scoped working memory to empty so the
    // next conversation starts fresh. Only ever affects the caller's own
    // namespace.
    path: "/api/consultant/memory/clear",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, CONSULTANT_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);

          const mastra = c.get("mastra");
          const agent = mastra?.getAgent("qmsConsultantAgent");
          const memory = agent ? await agent.getMemory?.() : null;
          if (!memory) return c.json({ ok: true });

          const resourceId = userResourceId(user.userId);
          await memory.updateWorkingMemory({
            threadId: `consultant-${user.userId}`,
            resourceId,
            workingMemory: "",
          });
          logger.info(`[Consultant] Working memory cleared for ${resourceId}`);
          return c.json({ ok: true });
        } catch (error) {
          logger.error("[Consultant] Working-memory clear error:", error);
          return c.json({ error: "Failed to clear memory" }, 500);
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

          // Section log (fire-and-forget): records WHICH platform section was
          // asked about, never the question text. Never awaited into the reply.
          void import("../../utils/adamTopicLog").then(({ recordQuestionSection }) =>
            recordQuestionSection(message, { surface: "web", askedBy: user?.email || null }),
          ).catch(() => {});

          const agent = mastra?.getAgent("qmsConsultantAgent");
          if (!agent) {
            return c.json({ error: "QMS Consultant agent not available" }, 503);
          }

          // Scope all memory to this user. Using a per-user resource ID
          // prevents cross-user thread replay: even if an attacker knows
          // another user's threadId, they cannot read or poison that
          // thread because the resourceId namespace is different.
          const resourceId = userResourceId(user.userId);
          // Use a cryptographically random UUID for new threads so the
          // threadId cannot be brute-forced from a known time window.
          const resolvedThreadId = (threadId && typeof threadId === "string")
            ? threadId
            : `consultant-${randomUUID()}`;

          const chatTimeout = parseInt(
            process.env.CONSULTANT_CHAT_TIMEOUT_MS || "120000",
          );
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), chatTimeout);

          try {
            // Wrap agent invocation in AsyncLocalStorage so any AI write-tool
            // called during this turn can see WHO prompted it. Without this,
            // the HITL gate cannot attribute pending actions to a user.
            const { result: response, callId } = await withThreadLock(
              resolvedThreadId,
              () =>
                withAiTelemetry<AgentTextResult>(
                  {
                    agentName: "ExampleOrg QMS Consultant",
                    model: "gpt-4o",
                    promptText: message,
                    userId: String(user.userId),
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
                        // 2026-06-08 ADAPTIVE FIX — use agentGenerateAdaptive
                        // which tries generate() and generateLegacy()
                        // in turn, caching whichever one Mastra accepts
                        // for the current model class. Stops the V4/V2
                        // flip-flop regression at the root.
                        agentGenerateAdaptive(agent, message, {
                          threadId: resolvedThreadId,
                          resourceId,
                          abortSignal: controller.signal,
                        }),
                    );
                    return res as AgentTextResult;
                  },
                ),
            );

            const messageId = await resolveLatestAssistantMessageId(
              agent,
              resolvedThreadId,
              resourceId,
              response,
            );
            // Defensive extraction — see extractAgentText() at top of
            // file. Helper is async because some Mastra shapes return
            // text as a Promise getter on the live stream object. If
            // the result is genuinely empty we LOG it loud so the next
            // outage debugs faster instead of showing a silent "No
            // response received." in the widget.
            const extractedText = await extractAgentText(response);
            if (!extractedText) {
              logger.warn(
                "[Consultant] /chat extracted empty text — shape mismatch",
                {
                  shapeKeys: response && typeof response === "object"
                    ? Object.keys(response as unknown as Record<string, unknown>)
                    : typeof response,
                },
              );
            }
            return c.json({
              success: true,
              threadId: resolvedThreadId,
              response:
                extractedText ||
                "(The assistant returned an empty response. Try rephrasing your question, or check the server logs.)",
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

          // Scope all memory to this user. Using a per-user resource ID
          // prevents cross-user thread replay: even if an attacker knows
          // another user's threadId, they cannot read or poison that
          // thread because the resourceId namespace is different.
          const resourceId = userResourceId(user.userId);
          // Use a cryptographically random UUID for new threads so the
          // threadId cannot be brute-forced from a known time window.
          const resolvedThreadId = (threadId && typeof threadId === "string")
            ? threadId
            : `consultant-${randomUUID()}`;

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
            agentName: "ExampleOrg QMS Consultant",
            model: "gpt-4o",
            promptText: message,
            userId: String(user.userId),
            sessionId: resolvedThreadId,
            metadata: buildAiCallTelemetryMetadata({
              promptVersion: QMS_CONSULTANT_PROMPT_VERSION,
            }),
          });
          let stream: Awaited<ReturnType<typeof agent.stream>>;
          // Acquire the per-thread lock for the lifetime of THIS stream
          // (init + consumption). We resolve `releaseThreadLock` from the
          // SSE finally{} block so the next request on the same thread
          // can begin only after we finish writing to memory.
          //
          // Safety: a hard auto-release timer (streamTimeout + 30s) fires
          // even if every code path forgets to release the lock — that
          // way a single bug here can never permanently starve a thread.
          // The release function is idempotent.
          let lockReleased = false;
          let releaseThreadLock: () => void = () => {};
          const releaseLockOnce = () => {
            if (lockReleased) return;
            lockReleased = true;
            releaseThreadLock();
          };
          const lockSafetyTimer = setTimeout(
            releaseLockOnce,
            streamTimeout + 30_000,
          );
          const threadLockHandshake = withThreadLock(
            resolvedThreadId,
            () =>
              new Promise<void>((res) => {
                releaseThreadLock = () => {
                  clearTimeout(lockSafetyTimer);
                  res();
                };
              }),
          );
          // Surface lock-acquisition failures to the outer catch so we
          // don't leak the span; otherwise the await inside .start() will
          // never resolve if the prior thread holder rejected.
          threadLockHandshake.catch(() => {});
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
                  // 2026-06-08 ADAPTIVE FIX — agentStreamAdaptive picks
                  // stream() vs streamLegacy() based on what the model
                  // class actually supports. Caches the right choice.
                  // Cast: the inferred Promise<unknown> conflicts with
                  // span.run's typed inner signature; runtime shape is
                  // the same — a stream object with .textStream / .text.
                  agentStreamAdaptive(agent, message, {
                    threadId: resolvedThreadId,
                    resourceId,
                    abortSignal: controller.signal,
                  }) as Promise<any>,
              ),
            );
          } catch (streamInitErr) {
            releaseLockOnce();
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
          // Heartbeat: while the agent is "thinking" (e.g. waiting on a
          // slow tool before the first chunk arrives), the SSE socket is
          // idle and intermediate proxies (HostingPlatform's edge, corporate
          // gateways) can drop the connection after ~30-60s. Send an
          // SSE comment frame every 15s — comments are ignored by the
          // EventSource parser but keep the TCP socket warm.
          const HEARTBEAT_MS = 15_000;
          const readable = new ReadableStream({
            async start(streamController) {
              let streamSuccess = true;
              let streamError: Error | undefined;
              let firstChunkSeen = false;
              const heartbeat = setInterval(() => {
                if (firstChunkSeen) return;
                try {
                  streamController.enqueue(encoder.encode(`: ping\n\n`));
                } catch {
                  /* controller closed — ignore */
                }
              }, HEARTBEAT_MS);
              try {
                // Run the stream consumption INSIDE span.run() so the
                // parent_call_id ALS context is visible to tools invoked
                // during streaming (tools execute lazily as chunks flow).
                await span.run(async () => {
                  // 2026-06-08 — Mastra's `.textStream` is sometimes a
                  // ReadableStream<string> (AISDKV5OutputStream / aisdk
                  // format) and sometimes a different async iterable
                  // (MastraModelOutput). Both support for-await-of on
                  // modern Node, but a missing/undefined textStream
                  // (which we've seen on certain Mastra builds when
                  // format: 'aisdk' is silently dropped) would throw a
                  // TypeError that the widget surfaces as "Stream error
                  // 500". Guard against that — if textStream isn't
                  // iterable, fall through to the .text getter (which
                  // is a Promise) and emit a single chunk so the user
                  // still gets the response.
                  const ts: any = (stream as any)?.textStream;
                  const isIterable =
                    ts != null &&
                    (typeof ts[Symbol.asyncIterator] === "function" ||
                      typeof ts[Symbol.iterator] === "function" ||
                      typeof ts.getReader === "function");
                  if (isIterable) {
                    for await (const chunk of ts) {
                      firstChunkSeen = true;
                      streamController.enqueue(
                        encoder.encode(
                          `<REDACTED_SCHEME> ${JSON.stringify({ text: chunk, threadId: resolvedThreadId })}\n\n`,
                        ),
                      );
                    }
                  } else {
                    // Fallback: resolve .text (Promise<string>) and
                    // emit as a single SSE frame. Slower (no progressive
                    // UX) but correct — beats a 500 error bubble.
                    const txt = await Promise.resolve(
                      (stream as any)?.text ?? "",
                    );
                    if (typeof txt === "string" && txt) {
                      firstChunkSeen = true;
                      streamController.enqueue(
                        encoder.encode(
                          `<REDACTED_SCHEME> ${JSON.stringify({ text: txt, threadId: resolvedThreadId })}\n\n`,
                        ),
                      );
                    } else {
                      safeLogger.warn(
                        "[Consultant] stream had neither textStream nor text — empty response",
                        {
                          streamKeys:
                            stream && typeof stream === "object"
                              ? Object.keys(stream as Record<string, unknown>)
                              : typeof stream,
                        },
                      );
                    }
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
                // Try to read the assistant id directly from the stream
                // result first (Mastra exposes a `response` promise that
                // resolves once the turn is fully persisted) — falls
                // back to the memory query if that shape isn't present.
                let preloaded: any = null;
                try {
                  const responseProp = (stream as any).response;
                  if (responseProp && typeof responseProp.then === "function") {
                    preloaded = await Promise.race([
                      responseProp,
                      new Promise((res) => setTimeout(() => res(null), 500)),
                    ]);
                  } else if (responseProp) {
                    preloaded = responseProp;
                  }
                } catch {
                  /* fall back to memory query below */
                }
                const messageId = await resolveLatestAssistantMessageId(
                  agent,
                  resolvedThreadId,
                  resourceId,
                  preloaded,
                );
                streamController.enqueue(
                  encoder.encode(
                    `<REDACTED_SCHEME> ${JSON.stringify({ done: true, threadId: resolvedThreadId, messageId, callId: span.callId ?? undefined, promptVersion: QMS_CONSULTANT_PROMPT_VERSION })}\n\n`,
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
                    `<REDACTED_SCHEME> ${JSON.stringify({ error: errMsg })}\n\n`,
                  ),
                );
                streamController.close();
              } finally {
                clearTimeout(timer);
                clearInterval(heartbeat);
                // Release the per-thread mutex now that this stream is
                // fully done writing to Mastra memory — the next request
                // on the same threadId can proceed. Idempotent so the
                // safety timer doesn't double-release after us.
                releaseLockOnce();

                // Best-effort token-usage extraction, then finalize the
                // parent row that was opened above. We also clear the
                // race-timer handle so it doesn't keep the event loop
                // alive when usage resolves first (was a small leak).
                let promptTokens: number | undefined;
                let completionTokens: number | undefined;
                let totalTokens: number | undefined;
                if (streamSuccess) {
                  try {
                    let usageRaceTimer: ReturnType<typeof setTimeout> | null =
                      null;
                    const usage = await Promise.race([
                      Promise.resolve(stream.usage ?? null).then((u) => {
                        if (usageRaceTimer) clearTimeout(usageRaceTimer);
                        return u;
                      }),
                      new Promise<null>((res) => {
                        usageRaceTimer = setTimeout(() => res(null), 2000);
                      }),
                    ]);
                    if (usage && typeof usage === "object") {
                      const u = usage as Record<string, unknown>;
                      const pt = u.promptTokens ?? u.prompt_tokens;
                      const ct = u.completionTokens ?? u.completion_tokens;
                      const tt = u.totalTokens ?? u.total_tokens;
                      promptTokens = <REDACTED_SECRET>
                      completionTokens =
                        <REDACTED_SECRET>
                      totalTokens = <REDACTED_SECRET>
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
          // Surface the underlying error class + message in the response so
          // DevTools shows the real cause (e.g. "LLMProviderError: 401 Incorrect
          // API key", "AbortError", "RateLimitError"). The frontend
          // previously got an opaque "Failed to start stream" and could only
          // tell the user "No response received." — invisible by design.
          //
          // Safe to leak: this endpoint already gates on requireRole, and the
          // error messages emitted by the upstream SDKs never contain
          // credentials (only the redacted class/status). If you ever add an
          // error path that DOES leak secrets, redact at THIS layer, not by
          // hiding the whole message.
          const errMsg = error instanceof Error ? error.message : String(error);
          const errClass = error instanceof Error ? error.constructor.name : "Error";
          return c.json(
            {
              error: "Failed to start stream",
              details: errMsg,
              errorClass: errClass,
            },
            500,
          );
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
          const user = await requireRole(c, ALERT_ADMIN_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);

          const status = c.req.query("status") as AlertStatus | undefined;
          const severity = c.req.query("severity") as AlertSeverity | undefined;
          const alertType = c.req.query("type") as AlertType | undefined;
          const limit = parseInt(c.req.query("limit") || "50");
          const offset = parseInt(c.req.query("offset") || "0");
          // Server-side resolution-source filter (Task #417). The All
          // Alerts modal previously applied this client-side AFTER the
          // 50-row API cap, which silently dropped matches whenever
          // closed-alert volume crossed the cap in a single status.
          // Whitelist here so only the two valid values reach the SQL.
          const resolutionRaw = (c.req.query("resolution") || "").toLowerCase();
          const resolution =
            resolutionRaw === "auto" || resolutionRaw === "manual"
              ? (resolutionRaw as "auto" | "manual")
              : undefined;

          const result = await getAIAlerts({
            status: status || undefined,
            severity: severity || undefined,
            alert_type: alertType || undefined,
            resolution,
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
          const user = await requireRole(c, ALERT_ADMIN_ROLES);
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
          const user = await requireRole(c, ALERT_ADMIN_ROLES);
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
          const user = await requireRole(c, ALERT_ADMIN_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);

          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid alert ID" }, 400);

          // Task #324: capture the optional resolution note posted by the
          // manual-resolve popover and the resolver's identity so the
          // resolved-alerts feed can render WHO closed it and WHY. Empty /
          // non-string values fall through as `undefined` so resolveAlert()
          // preserves any prior note via COALESCE.
          let note: string | undefined;
          try {
            const body = await c.req.json().catch(() => null);
            const raw = body?.note;
            if (typeof raw === "string") {
              const trimmed = raw.trim();
              if (trimmed.length > 0) {
                note = trimmed.slice(0, 1000);
              }
            }
          } catch {
            // No body / invalid JSON — legacy clients that POST without a
            // body still work; just no note attached.
          }
          const resolvedBy = user.name || user.email;
          const alert = await resolveAlert(id, note, resolvedBy);
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
          const user = await requireRole(c, ALERT_ADMIN_ROLES);
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
          // consultant chat (other surfaces — ChatProvider, mobile, embedded
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
            user_id: String(user.userId),
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
            String(user.userId),
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
          // The scan instructs the agent to use ALL monitoring tools, which
          // query PDPL, NC, risk, KPI, and governance data. Restrict to the
          // intersection of those tools' own RBAC allowlists so a low-
          // privilege consultant cannot trigger the full platform scan.
          const user = await requireRole(c, SCAN_ROLES);
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
                agentName: "ExampleOrg QMS Consultant",
                model: "gpt-4o",
                promptText: scanPrompt.slice(0, 300),
                userId: String(user.userId),
                metadata: buildAiCallTelemetryMetadata({
                  scanType: "platform_scan",
                  promptVersion: QMS_CONSULTANT_PROMPT_VERSION,
                }),
              },
              // Wrap the agent call with the user's verified identity so that
              // tool-level RBAC checks (getCurrentAgentContext()) can resolve
              // the caller's role and enforce per-module access controls.
              async () =>
                withAgentUserContext(
                  {
                    user: {
                      userId: user.userId,
                      email: user.email,
                      role: user.role,
                      autoApproveTier: resolveAutoApproveTier(user.role),
                    },
                    threadId: `scan-${Date.now()}`,
                  },
                  async () =>
                    // 2026-06-08 ADAPTIVE FIX — same wrapper as /chat and
                    // /chat/stream above. Stops the polarity flip-flop from
                    // breaking the scan endpoint independently.
                    (await agentGenerateAdaptive(agent, scanPrompt, {
                      threadId: `scan-${Date.now()}`,
                      resourceId: userResourceId(user.userId),
                      abortSignal: scanController.signal,
                    })) as AgentTextResult,
                ),
            );
            scanResult = result;
          } finally {
            clearTimeout(scanTimer);
          }

          return c.json({
            success: true,
            summary: await extractAgentText(scanResult),
          });
        } catch (error) {
          logger.error("[Consultant] Scan error:", error);
          // 2026-06-08 — surface the actual error message + class back to
          // the client. The old code returned only a generic 500 with no
          // details, so the dashboard rendered "Scan returned 500" with
          // zero diagnostic. /chat has been surfacing `details` for
          // months — the scan handler was overlooked.
          return c.json(
            {
              error: "Failed to run platform scan",
              details:
                error instanceof Error ? error.message : String(error ?? ""),
              errorClass:
                error instanceof Error ? error.constructor.name : "Unknown",
            },
            500,
          );
        }
      };
    },
  },

  {
    path: "/api/consultant/scan-stream",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        // runBackgroundScan() queries the database directly and bypasses all
        // tool-level RBAC, so we must enforce the role gate here at the route
        // level. Restrict to the same narrow cohort used by /api/consultant/scan.
        const user = await requireRole(c, SCAN_ROLES);
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
                    `<REDACTED_SCHEME> ${JSON.stringify({ step: step.label, pct: step.pct })}\n\n`,
                  ),
                );
              }

              const result = await runBackgroundScan();
              streamController.enqueue(
                encoder.encode(
                  `<REDACTED_SCHEME> ${JSON.stringify({ done: true, pct: 100, result })}\n\n`,
                ),
              );
            } catch (err) {
              streamController.enqueue(
                encoder.encode(
                  `<REDACTED_SCHEME> ${JSON.stringify({ error: err instanceof Error ? err.message : "Scan failed" })}\n\n`,
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
