import { requireRole, type UserRole } from "../../utils/rbacMiddleware";
import {
  getWeeklyCostTrend,
  getAgentLatencyPercentiles,
  getTopToolsByCost,
  getRecentSlowFailedCalls,
  getDailyCostSummary,
  getFeedbackRateByAgent,
  insertCallFeedback,
  MODEL_PRICE_TABLE,
} from "../../utils/aiTelemetry";
import { join } from "path";
import { existsSync, readFileSync } from "fs";

const AI_OPS_ROLES: UserRole[] = ['admin', 'ai_specialist', 'grc_manager', 'head_of_operations_quality'];

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
          const { callId, rating } = body;
          const parsedCallId = parseInt(String(callId ?? ''), 10);
          if (!Number.isFinite(parsedCallId) || parsedCallId <= 0 || !['thumbs_up', 'thumbs_down'].includes(rating)) {
            return c.json({ error: "callId (positive integer) and rating ('thumbs_up'|'thumbs_down') are required" }, 400);
          }
          const ok = await insertCallFeedback(parsedCallId, rating as 'thumbs_up' | 'thumbs_down', user.userId);
          return c.json({ success: ok });
        } catch (error) {
          console.error("[AI-Ops] feedback error:", error);
          return c.json({ error: "Failed to record feedback" }, 500);
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
          const data = await getTopToolsByCost(limit);
          return c.json({ data });
        } catch (error) {
          console.error("[AI-Ops] top-tools error:", error);
          return c.json({ error: "Failed to fetch tool stats" }, 500);
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
];
