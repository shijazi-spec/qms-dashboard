import { requireRole, type UserRole } from "../../utils/rbacMiddleware";
import {
  getWeeklyCostTrend,
  getAgentLatencyPercentiles,
  getTopToolsByCost,
  getRecentSlowFailedCalls,
  getDailyCostSummary,
  getFeedbackRateByAgent,
  getFeedbackRateByPromptVersion,
  getRecentNegativeFeedback,
  getCallById,
  insertCallFeedback,
  getChildToolCallsForParent,
  getKnownAgentNames,
  FEEDBACK_COMMENT_MAX_LEN,
  MODEL_PRICE_TABLE,
  DEFAULT_PROMPT_VERSION_MIN_FEEDBACK,
} from "../../utils/aiTelemetry";
import {
  getAIAlerts,
  acknowledgeAlert,
  resolveAlert,
  type AIAlert,
} from "../../utils/aiAlertsDatabase";
import { QMS_CONSULTANT_PROMPT_VERSION } from "../agents/qmsConsultantAgent";
import { QUALITY_SPECIALIST_PROMPT_VERSION } from "../agents/qualitySpecialistAgent";
import { SDR_QUALITY_PROMPT_VERSION } from "../agents/sdrQualityAgent";
import { SALES_QUALITY_PROMPT_VERSION } from "../agents/salesQualityAgent";
import { join } from "path";
import { existsSync, readFileSync } from "fs";

const ACTIVE_PROMPT_VERSIONS: { agent_name: string; prompt_version: string }[] = [
  { agent_name: "WalaPlus QMS Consultant",           prompt_version: QMS_CONSULTANT_PROMPT_VERSION },
  { agent_name: "WalaPlus Quality Specialist",       prompt_version: QUALITY_SPECIALIST_PROMPT_VERSION },
  { agent_name: "WalaPlus SDR Quality Specialist",   prompt_version: SDR_QUALITY_PROMPT_VERSION },
  { agent_name: "WalaPlus Sales Quality Specialist", prompt_version: SALES_QUALITY_PROMPT_VERSION },
];

const AI_OPS_ROLES: UserRole[] = ['admin', 'ai_specialist', 'grc_manager', 'head_of_operations_quality'];

/**
 * Parse the `related_record_id` written by toolHealthAlertsCron, which uses
 * a stable `<tool_name>:<reason>` composite (see maybeCreateBreachAlert).
 * Tool names can themselves contain ':' (rare, but possible), so we split
 * on the LAST colon and validate the suffix.
 */
function parseToolHealthRelatedId(
  rid: string | undefined | null,
): { tool_name: string; reason: 'error_rate' | 'p95_latency' } | null {
  if (!rid || typeof rid !== 'string') return null;
  const idx = rid.lastIndexOf(':');
  if (idx <= 0 || idx === rid.length - 1) return null;
  const tool_name = rid.slice(0, idx);
  const reason = rid.slice(idx + 1);
  if (reason !== 'error_rate' && reason !== 'p95_latency') return null;
  return { tool_name, reason };
}

function safeInt(value: string | undefined, defaultVal: number, min: number, max: number): number {
  const n = parseInt(value ?? '', 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : defaultVal;
}

export const aiOpsRoutes = [
  {
    path: "/ai-ops",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const user = await requireRole(c, AI_OPS_ROLES);
        if (!user) return c.json({ error: "Insufficient permissions" }, 403);
        const possiblePaths = [
          join(process.cwd(), "dashboard", "ai-ops.html"),
          "/home/runner/workspace/dashboard/ai-ops.html",
        ];
        for (const p of possiblePaths) {
          if (existsSync(p)) {
            return c.html(readFileSync(p, "utf-8"));
          }
        }
        return c.text("AI Operations page not found", 404);
      };
    },
  },

  {
    path: "/api/ai-ops/summary",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, AI_OPS_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);
          const data = await getDailyCostSummary();
          return c.json({ data, priceTable: MODEL_PRICE_TABLE });
        } catch (error) {
          console.error("[AI-Ops] summary error:", error);
          return c.json({ error: "Failed to fetch summary" }, 500);
        }
      };
    },
  },

  {
    path: "/api/ai-ops/cost-trend",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, AI_OPS_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);
          const days = safeInt(c.req.query("days"), 14, 1, 90);
          const data = await getWeeklyCostTrend(days);
          return c.json({ data });
        } catch (error) {
          console.error("[AI-Ops] cost-trend error:", error);
          return c.json({ error: "Failed to fetch cost trend" }, 500);
        }
      };
    },
  },

  {
    path: "/api/ai-ops/agent-latency",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, AI_OPS_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);
          const [latency, feedback] = await Promise.all([
            getAgentLatencyPercentiles(),
            getFeedbackRateByAgent(),
          ]);
          const fbMap = new Map(feedback.map(f => [f.agent_name, f]));
          const data = latency.map(row => ({
            ...row,
            feedback_rate_pct: fbMap.get(row.agent_name)?.feedback_rate_pct ?? null,
            total_feedback:    fbMap.get(row.agent_name)?.total_feedback ?? 0,
          }));
          return c.json({ data });
        } catch (error) {
          console.error("[AI-Ops] agent-latency error:", error);
          return c.json({ error: "Failed to fetch latency data" }, 500);
        }
      };
    },
  },

  {
    path: "/api/ai-ops/feedback",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, AI_OPS_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);
          const body = await c.req.json();
          const { callId, rating, comment } = body;
          const parsedCallId = parseInt(String(callId ?? ''), 10);
          if (!Number.isFinite(parsedCallId) || parsedCallId <= 0 || !['thumbs_up', 'thumbs_down'].includes(rating)) {
            return c.json({ error: "callId (positive integer) and rating ('thumbs_up'|'thumbs_down') are required" }, 400);
          }
          let cleanComment: string | undefined;
          if (comment != null) {
            if (typeof comment !== 'string') {
              return c.json({ error: "comment must be a string" }, 400);
            }
            if (comment.length > FEEDBACK_COMMENT_MAX_LEN) {
              return c.json({ error: `comment exceeds ${FEEDBACK_COMMENT_MAX_LEN} character limit` }, 400);
            }
            cleanComment = comment;
          }
          const ok = await insertCallFeedback(
            parsedCallId,
            rating as 'thumbs_up' | 'thumbs_down',
            user.userId,
            cleanComment,
          );
          return c.json({ success: ok });
        } catch (error) {
          console.error("[AI-Ops] feedback error:", error);
          return c.json({ error: "Failed to record feedback" }, 500);
        }
      };
    },
  },

  {
    path: "/api/ai-ops/prompt-versions",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, AI_OPS_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);
          const days = safeInt(c.req.query("days"), 30, 1, 90);
          // Minimum number of feedback votes a prompt version needs before
          // we let the dashboard flag it as "best" or "regressed". Defaults
          // to DEFAULT_PROMPT_VERSION_MIN_FEEDBACK so the floor stays in
          // one place (single source of truth in aiTelemetry.ts). Capped
          // at 1000 so the param can't be used to silently disable the
          // protection on the API side.
          const minFeedback = safeInt(
            c.req.query("minFeedback"),
            DEFAULT_PROMPT_VERSION_MIN_FEEDBACK,
            0,
            1000,
          );
          const data = await getFeedbackRateByPromptVersion(days, minFeedback);
          return c.json({ data, min_feedback: minFeedback });
        } catch (error) {
          console.error("[AI-Ops] prompt-versions error:", error);
          return c.json({ error: "Failed to fetch prompt-version comparison" }, 500);
        }
      };
    },
  },

  {
    path: "/api/ai-ops/prompt-versions/active",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, AI_OPS_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);
          return c.json({ data: ACTIVE_PROMPT_VERSIONS });
        } catch (error) {
          console.error("[AI-Ops] active prompt-versions error:", error);
          return c.json({ error: "Failed to fetch active prompt versions" }, 500);
        }
      };
    },
  },

  {
    path: "/api/ai-ops/negative-feedback",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, AI_OPS_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);
          const limit = safeInt(c.req.query("limit"), 25, 1, 100);
          const data = await getRecentNegativeFeedback(limit);
          return c.json({ data });
        } catch (error) {
          console.error("[AI-Ops] negative-feedback error:", error);
          return c.json({ error: "Failed to fetch negative feedback" }, 500);
        }
      };
    },
  },

  {
    path: "/api/ai-ops/call/:id",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, AI_OPS_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);
          const idParam = c.req.param("id");
          const callId = parseInt(idParam, 10);
          if (!Number.isFinite(callId) || callId <= 0) {
            return c.json({ error: "Invalid call id" }, 400);
          }
          const data = await getCallById(callId);
          if (!data) return c.json({ error: "Call not found" }, 404);
          return c.json({ data });
        } catch (error) {
          console.error("[AI-Ops] call-detail error:", error);
          return c.json({ error: "Failed to fetch call detail" }, 500);
        }
      };
    },
  },

  {
    path: "/api/ai-ops/top-tools",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, AI_OPS_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);
          const limit = safeInt(c.req.query("limit"), 10, 1, 50);
          const agentParam = c.req.query("agent");
          const agent = typeof agentParam === 'string' ? agentParam.slice(0, 100) : undefined;
          const [data, agents] = await Promise.all([
            getTopToolsByCost(limit, agent),
            getKnownAgentNames(),
          ]);
          return c.json({ data, agents });
        } catch (error) {
          console.error("[AI-Ops] top-tools error:", error);
          return c.json({ error: "Failed to fetch tool stats" }, 500);
        }
      };
    },
  },

  {
    path: "/api/ai-ops/calls/:id/children",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, AI_OPS_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);
          const idParam = c.req.param("id");
          const parentId = parseInt(String(idParam ?? ''), 10);
          if (!Number.isFinite(parentId) || parentId <= 0) {
            return c.json({ error: "Invalid call id" }, 400);
          }
          const data = await getChildToolCallsForParent(parentId);
          return c.json({ data });
        } catch (error) {
          console.error("[AI-Ops] call children error:", error);
          return c.json({ error: "Failed to fetch child tool calls" }, 500);
        }
      };
    },
  },

  {
    path: "/api/ai-ops/recent-issues",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, AI_OPS_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);
          const limit = safeInt(c.req.query("limit"), 20, 1, 100);
          const data = await getRecentSlowFailedCalls(limit);
          return c.json({ data });
        } catch (error) {
          console.error("[AI-Ops] recent-issues error:", error);
          return c.json({ error: "Failed to fetch recent issues" }, 500);
        }
      };
    },
  },

  /**
   * Open `tool_health` alerts written by the toolHealthAlertsCron, with the
   * `<tool_name>:<reason>` composite key parsed out so the frontend can link
   * each alert to the matching row in the per-tool error/latency table.
   *
   * Returns alerts with status='open' only — acknowledged alerts have already
   * been triaged and shouldn't re-pin to the top of the panel. Resolved /
   * dismissed alerts are excluded for the same reason.
   */
  {
    path: "/api/ai-ops/tool-health-alerts",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, AI_OPS_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);
          const limit = safeInt(c.req.query("limit"), 20, 1, 100);
          const { alerts, total } = await getAIAlerts({
            alert_type: 'tool_health',
            status: 'open',
            limit,
          });
          const data = alerts.map((a: AIAlert) => {
            const parsed = parseToolHealthRelatedId(a.related_record_id);
            return {
              id: a.id,
              severity: a.severity,
              title: a.title,
              description: a.description,
              suggestion: a.suggestion,
              status: a.status,
              related_record_id: a.related_record_id,
              tool_name: parsed?.tool_name ?? null,
              reason: parsed?.reason ?? null,
              created_at: a.created_at,
            };
          });
          return c.json({ data, total });
        } catch (error) {
          console.error("[AI-Ops] tool-health-alerts error:", error);
          return c.json({ error: "Failed to fetch tool-health alerts" }, 500);
        }
      };
    },
  },

  /**
   * Acknowledge a tool-health alert from the AI Ops panel. Thin wrapper
   * around acknowledgeAlert() scoped to AI_OPS_ROLES so the panel doesn't
   * need to call cross-namespace consultant endpoints.
   */
  {
    path: "/api/ai-ops/alerts/:id/acknowledge",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, AI_OPS_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);
          const id = parseInt(String(c.req.param("id") ?? ''), 10);
          if (!Number.isFinite(id) || id <= 0) {
            return c.json({ error: "Invalid alert id" }, 400);
          }
          const acknowledgedBy = user.name || user.email;
          const alert = await acknowledgeAlert(id, acknowledgedBy);
          if (!alert) return c.json({ error: "Alert not found" }, 404);
          return c.json({ success: true, alert });
        } catch (error) {
          console.error("[AI-Ops] alert acknowledge error:", error);
          return c.json({ error: "Failed to acknowledge alert" }, 500);
        }
      };
    },
  },

  /**
   * Resolve a tool-health alert from the AI Ops panel. See
   * /api/ai-ops/alerts/:id/acknowledge for the rationale on keeping this
   * separate from the consultant alert routes.
   */
  {
    path: "/api/ai-ops/alerts/:id/resolve",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, AI_OPS_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);
          const id = parseInt(String(c.req.param("id") ?? ''), 10);
          if (!Number.isFinite(id) || id <= 0) {
            return c.json({ error: "Invalid alert id" }, 400);
          }
          const alert = await resolveAlert(id);
          if (!alert) return c.json({ error: "Alert not found" }, 404);
          return c.json({ success: true, alert });
        } catch (error) {
          console.error("[AI-Ops] alert resolve error:", error);
          return c.json({ error: "Failed to resolve alert" }, 500);
        }
      };
    },
  },
];
