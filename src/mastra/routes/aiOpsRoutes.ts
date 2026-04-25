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
  getParentCallsForTool,
  getKnownAgentNames,
  FEEDBACK_COMMENT_MAX_LEN,
  MODEL_PRICE_TABLE,
  DEFAULT_PROMPT_VERSION_MIN_FEEDBACK,
} from "../../utils/aiTelemetry";
import {
  getAIAlerts,
  getToolHealthAlertHistory,
  getToolHealthAlertTrend,
  acknowledgeAlert,
  resolveAlert,
  type AIAlert,
} from "../../utils/aiAlertsDatabase";
import { QMS_CONSULTANT_PROMPT_VERSION } from "../agents/qmsConsultantAgent";
import { QUALITY_SPECIALIST_PROMPT_VERSION } from "../agents/qualitySpecialistAgent";
import { SDR_QUALITY_PROMPT_VERSION } from "../agents/sdrQualityAgent";
import { SALES_QUALITY_PROMPT_VERSION } from "../agents/salesQualityAgent";
import {
  TOOL_HEALTH_DEFAULTS,
  TOOL_HEALTH_ENV_BASELINE,
  getEffectiveToolHealthConfig,
  evaluateWindowAggregates,
  type EffectiveToolHealthConfig,
  type ToolHealthBreachCandidate,
} from "../workflows/toolHealthAlertsCron";
import { getToolWindowAggregates } from "../../utils/aiTelemetry";
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
 * Tuning the thresholds is a privileged action — it directly changes which
 * tools page on-call. Restrict the write/audit endpoints to admins; the
 * read endpoint stays open to the broader AI_OPS_ROLES so non-admin ops
 * can still see the live floor when triaging an alert.
 */
const TOOL_HEALTH_CONFIG_WRITE_ROLES: UserRole[] = ['admin'];

/**
 * Per-field validation bounds for the tool-health threshold form. Picked to
 * cover every legitimate tuning operators have asked for (e.g. 5%–90% error
 * floors, 1s–10min p95 ceilings) while still rejecting obviously broken
 * inputs (negative numbers, days-long windows). Mirrored in the UI so the
 * server is the source of truth either way.
 */
const TOOL_HEALTH_CONFIG_BOUNDS = {
  windowMinutes:        { min: 5,   max: 1440 },
  minCalls:             { min: 1,   max: 10_000 },
  errorRatePct:         { min: 1,   max: 100 },
  errorRateHighPct:     { min: 1,   max: 100 },
  errorRateCriticalPct: { min: 1,   max: 100 },
  p95LatencyMs:         { min: 100, max: 600_000 },
  latencyHighMs:        { min: 100, max: 600_000 },
  latencyCriticalMs:    { min: 100, max: 600_000 },
} as const;

type ToolHealthConfigField = keyof typeof TOOL_HEALTH_CONFIG_BOUNDS;
const TOOL_HEALTH_CONFIG_FIELD_LIST = Object.keys(
  TOOL_HEALTH_CONFIG_BOUNDS,
) as ToolHealthConfigField[];

/**
 * Maximum horizon the dashboard may schedule an override expiry for. Set
 * to 30 days because the whole point of time-boxed overrides (Task #191)
 * is "silence the noise during this incident" — anything beyond a month
 * is indistinguishable from a permanent change and should go through a
 * code/config review instead. Mirrored in the UI so the picker doesn't
 * offer values the server will reject.
 */
const TOOL_HEALTH_EXPIRY_MAX_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Convenience presets the AI Ops "Alert Thresholds" tab renders as a select
 * box ("Expires in 1h / 4h / 24h / Never"). Kept on the server so tweaks
 * to the menu propagate without a frontend redeploy. `ms = 0` is the
 * sentinel for "never" (clear any existing expiry).
 */
const TOOL_HEALTH_EXPIRY_OPTIONS: Array<{ label: string; ms: number }> = [
  { label: "Never (clear expiry)", ms: 0 },
  { label: "1 hour",  ms: 1  * 60 * 60 * 1000 },
  { label: "4 hours", ms: 4  * 60 * 60 * 1000 },
  { label: "24 hours", ms: 24 * 60 * 60 * 1000 },
];

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

/**
 * Shared body-validator for the threshold PUT and the dry-run preview
 * endpoint. Both expect the same `{ overrides: { <field>: number|null } }`
 * shape and must agree on per-field bounds AND on the cross-field band
 * ordering rules — otherwise an admin could "preview" a config the server
 * would then reject on save (silent contract drift).
 *
 * Returns either:
 *   - `{ ok: false, status, error, details? }` ready to pass into c.json,
 *   - `{ ok: true, cleanOverrides, mergedEffective }` for the caller to
 *     persist or evaluate. `mergedEffective` is the
 *     {@link EffectiveToolHealthConfig} that *would* be live if the patch
 *     were applied on top of the currently-persisted overrides.
 *
 * Note on the cross-field check: we don't require the patch itself to be
 * complete — a request that only updates `errorRateHighPct` is still
 * validated against the existing `errorRateCriticalPct` override, mirroring
 * what the cron actually evaluates at runtime.
 */
type ValidatedOverrides = { [K in ToolHealthConfigField]?: number | null };
type OverrideValidationResult =
  | {
      ok: true;
      cleanOverrides: ValidatedOverrides;
      mergedEffective: EffectiveToolHealthConfig;
    }
  | {
      ok: false;
      status: 400;
      error: string;
      details?: string[];
    };

async function validateThresholdOverridesBody(
  body: any,
): Promise<OverrideValidationResult> {
  if (!body || typeof body !== 'object') {
    return { ok: false, status: 400, error: "Request body must be an object" };
  }
  const rawOverrides = body.overrides;
  if (!rawOverrides || typeof rawOverrides !== 'object' || Array.isArray(rawOverrides)) {
    return { ok: false, status: 400, error: "overrides must be an object" };
  }

  const cleanOverrides: ValidatedOverrides = {};
  const errors: string[] = [];
  for (const field of TOOL_HEALTH_CONFIG_FIELD_LIST) {
    if (!Object.prototype.hasOwnProperty.call(rawOverrides, field)) continue;
    const v = rawOverrides[field];
    if (v === null) {
      cleanOverrides[field] = null;
      continue;
    }
    const n = Number(v);
    const { min, max } = TOOL_HEALTH_CONFIG_BOUNDS[field];
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      errors.push(`${field} must be an integer or null`);
      continue;
    }
    if (n < min || n > max) {
      errors.push(`${field} must be between ${min} and ${max}`);
      continue;
    }
    cleanOverrides[field] = n;
  }
  if (errors.length > 0) {
    return { ok: false, status: 400, error: "Validation failed", details: errors };
  }

  const { getToolHealthConfigRow } = await import(
    "../../utils/toolHealthConfigDatabase"
  );
  const currentRow = await getToolHealthConfigRow();
  const merged: EffectiveToolHealthConfig = { ...TOOL_HEALTH_ENV_BASELINE };
  for (const field of TOOL_HEALTH_CONFIG_FIELD_LIST) {
    const ovr = currentRow.overrides[field];
    if (ovr != null) merged[field] = ovr;
  }
  for (const field of TOOL_HEALTH_CONFIG_FIELD_LIST) {
    if (Object.prototype.hasOwnProperty.call(cleanOverrides, field)) {
      const v = cleanOverrides[field];
      merged[field] = v == null
        ? TOOL_HEALTH_ENV_BASELINE[field]
        : v;
    }
  }
  if (merged.errorRateHighPct >= merged.errorRateCriticalPct) {
    return {
      ok: false, status: 400,
      error: "errorRateHighPct must be less than errorRateCriticalPct " +
        `(would be ${merged.errorRateHighPct} ≥ ${merged.errorRateCriticalPct})`,
    };
  }
  if (merged.errorRatePct > merged.errorRateHighPct) {
    return {
      ok: false, status: 400,
      error: "errorRatePct (breach floor) must not exceed errorRateHighPct " +
        `(would be ${merged.errorRatePct} > ${merged.errorRateHighPct})`,
    };
  }
  if (merged.latencyHighMs >= merged.latencyCriticalMs) {
    return {
      ok: false, status: 400,
      error: "latencyHighMs must be less than latencyCriticalMs " +
        `(would be ${merged.latencyHighMs} ≥ ${merged.latencyCriticalMs})`,
    };
  }
  if (merged.p95LatencyMs > merged.latencyHighMs) {
    return {
      ok: false, status: 400,
      error: "p95LatencyMs (breach floor) must not exceed latencyHighMs " +
        `(would be ${merged.p95LatencyMs} > ${merged.latencyHighMs})`,
    };
  }

  return { ok: true, cleanOverrides, mergedEffective: merged };
}

/**
 * Roll a list of breach candidates into the count summary the AI Ops
 * "Preview impact" UI renders side-by-side with the current-config result.
 * Kept tiny and dependency-free so the response shape stays stable for
 * both the JS dashboard and any future CLI consumers.
 */
function summarizeBreachCandidates(
  candidates: ToolHealthBreachCandidate[],
): {
  total: number;
  byReason: { error_rate: number; p95_latency: number };
  bySeverity: { critical: number; high: number; medium: number };
} {
  const summary = {
    total: candidates.length,
    byReason: { error_rate: 0, p95_latency: 0 },
    bySeverity: { critical: 0, high: 0, medium: 0 },
  };
  for (const c of candidates) {
    summary.byReason[c.reason]++;
    if (c.severity === 'critical') summary.bySeverity.critical++;
    else if (c.severity === 'high') summary.bySeverity.high++;
    else summary.bySeverity.medium++;
  }
  return summary;
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
    path: "/api/ai-ops/tools/:name/parents",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, AI_OPS_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);
          const toolName = String(c.req.param("name") ?? '').slice(0, 200);
          if (!toolName.trim()) {
            return c.json({ error: "Tool name is required" }, 400);
          }
          const limit = safeInt(c.req.query("limit"), 20, 1, 50);
          const data = await getParentCallsForTool(toolName, limit);
          return c.json({ data });
        } catch (error) {
          console.error("[AI-Ops] tool parents error:", error);
          return c.json({ error: "Failed to fetch parent calls for tool" }, 500);
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
   * Acknowledged + resolved tool-health alerts from the last 7 days.
   * Rendered by the "Recently triaged" history toggle on /ai-ops so ops can
   * see who handled what without navigating away from the page.
   */
  {
    path: "/api/ai-ops/tool-health-alerts/history",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, AI_OPS_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);
          const days  = safeInt(c.req.query("days"),  7,  1, 90);
          const limit = safeInt(c.req.query("limit"), 20, 1, 100);
          // Whitelist severity here so the database layer never sees a
          // free-form string. Unknown / "all" / blank values fall through
          // as `undefined`, which keeps the unfiltered query path.
          const ALLOWED_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
          const sevRaw = (c.req.query("severity") || '').toLowerCase();
          const severity = (ALLOWED_SEVERITIES as readonly string[]).includes(sevRaw)
            ? sevRaw
            : undefined;
          const alerts = await getToolHealthAlertHistory(days, limit, severity);
          const data = alerts.map((a: AIAlert) => {
            const parsed = parseToolHealthRelatedId(a.related_record_id);
            const triagedAt = a.status === 'resolved'
              ? (a.resolved_at ?? null)
              : (a.acknowledged_at ?? null);
            return {
              id: a.id,
              severity: a.severity,
              title: a.title,
              status: a.status,
              tool_name: parsed?.tool_name ?? null,
              reason: parsed?.reason ?? null,
              acknowledged_by: a.acknowledged_by ?? null,
              triaged_at: triagedAt,
              created_at: a.created_at,
              // resolution_note powers the "Auto-resolved" vs "Manual"
              // pill and the inline note line in the history list. Both
              // tool-health and prompt-regression auto-resolve sweeps
              // stamp this with an "auto-resolved" prefix.
              resolution_note: a.resolution_note ?? null,
            };
          });
          return c.json({ data, days, severity: severity ?? null });
        } catch (error) {
          console.error("[AI-Ops] tool-health-alerts history error:", error);
          return c.json({ error: "Failed to fetch tool-health alert history" }, 500);
        }
      };
    },
  },

  /**
   * Daily-bucketed trend of tool-health alert activity over the last
   * `days` days (default 14, max 90). Returns:
   *   - `buckets[]`  — one entry per day in the window with severity
   *                    counts and a per-day median time-to-resolve. Days
   *                    with zero activity are returned as explicit zeros
   *                    so the chart shows continuous time, not gaps.
   *   - `overall`    — total fired, total resolved, and median + average
   *                    time-to-resolve across the whole window.
   *
   * Powers the trend chart inside the "Recently triaged tool-health
   * alerts" panel on /ai-ops so ops can spot whether a tool is getting
   * noisier over time and whether resolution times are improving.
   */
  {
    path: "/api/ai-ops/tool-health-alerts/trend",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, AI_OPS_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);
          const days = safeInt(c.req.query("days"), 14, 1, 90);
          const trend = await getToolHealthAlertTrend(days);
          return c.json({ data: trend });
        } catch (error) {
          console.error("[AI-Ops] tool-health-alerts trend error:", error);
          return c.json({ error: "Failed to fetch tool-health alert trend" }, 500);
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
          const resolvedBy = user.name || user.email;
          const alert = await resolveAlert(id, undefined, resolvedBy);
          if (!alert) return c.json({ error: "Alert not found" }, 404);
          return c.json({ success: true, alert });
        } catch (error) {
          console.error("[AI-Ops] alert resolve error:", error);
          return c.json({ error: "Failed to resolve alert" }, 500);
        }
      };
    },
  },

  /**
   * Tool-health threshold tuning — read endpoint.
   *
   * Returns the merged effective config plus the underlying layers so the
   * AI Ops panel can render "currently effective", "your override", "env
   * baseline", and "compile-time default" side-by-side. Available to all
   * AI_OPS_ROLES so non-admin ops can verify the live floor while triaging,
   * even if they can't edit it.
   */
  {
    path: "/api/ai-ops/tool-health-config",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, AI_OPS_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);

          // Lazy-load the DB module so the handler can still answer 403/auth
          // checks without a Postgres connection (matches the pattern other
          // routes in this file use for new tables).
          const {
            getToolHealthConfigRow,
            getToolHealthConfigAudit,
          } = await import("../../utils/toolHealthConfigDatabase");

          // Pull the same number of audit rows the dashboard advertises in
          // its "Recent threshold changes" header so the two stay in sync.
          const [row, effective, audit] = await Promise.all([
            getToolHealthConfigRow(),
            getEffectiveToolHealthConfig(),
            getToolHealthConfigAudit(25),
          ]);

          // Surface a derived `expired` flag so the dashboard doesn't have to
          // re-implement the timestamp comparison. The reaper sweeps these on
          // every cron tick, so this should usually be `false` even when an
          // expires_at is set; `true` means the dashboard caught the row in
          // the brief window between expiry and the next reaper pass.
          const expiresAt = row.expires_at;
          const expired =
            expiresAt != null &&
            new Date(expiresAt).getTime() <= Date.now();

          return c.json({
            data: {
              defaults: TOOL_HEALTH_DEFAULTS,
              env_baseline: TOOL_HEALTH_ENV_BASELINE,
              overrides: row.overrides,
              effective,
              updated_by: row.updated_by,
              updated_at: row.updated_at,
              expires_at: expiresAt,
              expired,
              expiry_options: TOOL_HEALTH_EXPIRY_OPTIONS,
              bounds: TOOL_HEALTH_CONFIG_BOUNDS,
              fields: TOOL_HEALTH_CONFIG_FIELD_LIST,
              audit,
              can_edit: TOOL_HEALTH_CONFIG_WRITE_ROLES.includes(
                user.role as UserRole,
              ),
            },
          });
        } catch (error) {
          console.error("[AI-Ops] tool-health-config GET error:", error);
          return c.json({ error: "Failed to load tool-health config" }, 500);
        }
      };
    },
  },

  /**
   * Tool-health threshold tuning — write endpoint.
   *
   * Body: { overrides: { <field>: number | null, ... }, note?: string }
   * - A `number` sets/replaces the override for that field.
   * - `null` clears the override (falls back to env baseline).
   * - Fields not listed in `overrides` are left as-is.
   *
   * Validates each provided field against TOOL_HEALTH_CONFIG_BOUNDS and also
   * enforces the cross-field invariant that 'high' < 'critical' for both
   * the error-rate and latency severity bands. The cross-field check is
   * computed against the effective config that *would* result from applying
   * this patch (not just the patch in isolation), so changing only the
   * 'high' value while the existing 'critical' override stays in place is
   * still validated correctly.
   *
   * Audit-logged via setToolHealthConfigOverrides() — every successful
   * write inserts a `tool_health_config_audit` row capturing the
   * before/after JSON and the operator's name/email.
   */
  {
    path: "/api/ai-ops/tool-health-config",
    method: "PUT" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, TOOL_HEALTH_CONFIG_WRITE_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);

          let body: any;
          try {
            body = await c.req.json();
          } catch {
            return c.json({ error: "Request body must be valid JSON" }, 400);
          }

          let note: string | null = null;
          if (body && typeof body === 'object' && body.note != null) {
            if (typeof body.note !== 'string') {
              return c.json({ error: "note must be a string" }, 400);
            }
            note = body.note.length > 500 ? body.note.slice(0, 500) : body.note;
          }

          // Time-boxed overrides (Task #191). The dashboard sends:
          //   • expires_at omitted          → leave existing expiry alone
          //   • expires_at: null            → clear any existing expiry
          //   • expires_at: "<ISO 8601>"    → schedule auto-revert at that ts
          // We accept Date objects too so server-side callers don't have to
          // serialize. Past timestamps are rejected — if the operator wants
          // "expire now" they should clear the overrides directly. The
          // 30-day horizon (TOOL_HEALTH_EXPIRY_MAX_MS) keeps the feature
          // from quietly turning into a permanent-change channel.
          let expiresAtPatch: { provided: boolean; value: Date | null } = {
            provided: false,
            value: null,
          };
          if (Object.prototype.hasOwnProperty.call(body, "expires_at")) {
            expiresAtPatch.provided = true;
            const raw = body.expires_at;
            if (raw == null) {
              expiresAtPatch.value = null;
            } else if (raw instanceof Date) {
              expiresAtPatch.value = raw;
            } else if (typeof raw === "string" || typeof raw === "number") {
              const parsed = new Date(raw);
              if (Number.isNaN(parsed.getTime())) {
                return c.json({
                  error: "expires_at must be an ISO 8601 timestamp or null",
                }, 400);
              }
              expiresAtPatch.value = parsed;
            } else {
              return c.json({
                error: "expires_at must be an ISO 8601 timestamp or null",
              }, 400);
            }
            if (expiresAtPatch.value != null) {
              const delta = expiresAtPatch.value.getTime() - Date.now();
              if (delta <= 0) {
                return c.json({
                  error: "expires_at must be a timestamp in the future",
                }, 400);
              }
              if (delta > TOOL_HEALTH_EXPIRY_MAX_MS) {
                const days = Math.floor(TOOL_HEALTH_EXPIRY_MAX_MS / (24 * 60 * 60 * 1000));
                return c.json({
                  error: `expires_at must be at most ${days} days in the future`,
                }, 400);
              }
            }
          }

          // Validate the body against per-field bounds AND the cross-field
          // band ordering, computing the merged effective config that would
          // result if the patch were applied. Identical to the dry-run
          // preview endpoint so the two cannot drift apart (Task #189).
          const validation = await validateThresholdOverridesBody(body);
          if (!validation.ok) {
            const payload: any = { error: validation.error };
            if (validation.details) payload.details = validation.details;
            return c.json(payload, validation.status);
          }
          const { cleanOverrides } = validation;

          // Compute the breach diff (same evaluation the preview endpoint runs)
          // so the audit row captures "this change opened N new alerts / closed N".
          // Best-effort: a transient aggregate-load failure silently stores null
          // rather than blocking the save itself.
          let breachDiff: import("../../utils/toolHealthConfigDatabase").ToolHealthAuditBreachDiff | null = null;
          try {
            const effective_current = await getEffectiveToolHealthConfig();
            const effective_proposed = validation.mergedEffective;
            const sameWindow =
              effective_current.windowMinutes === effective_proposed.windowMinutes;
            let currentAggregates: Awaited<ReturnType<typeof getToolWindowAggregates>>;
            let proposedAggregates: Awaited<ReturnType<typeof getToolWindowAggregates>>;
            if (sameWindow) {
              const minCallsUsed = Math.min(
                effective_current.minCalls,
                effective_proposed.minCalls,
              );
              const aggs = await getToolWindowAggregates(
                effective_current.windowMinutes,
                minCallsUsed,
              );
              currentAggregates = aggs;
              proposedAggregates = aggs;
            } else {
              [currentAggregates, proposedAggregates] = await Promise.all([
                getToolWindowAggregates(
                  effective_current.windowMinutes,
                  effective_current.minCalls,
                ),
                getToolWindowAggregates(
                  effective_proposed.windowMinutes,
                  effective_proposed.minCalls,
                ),
              ]);
            }
            const currentBreaches = evaluateWindowAggregates(currentAggregates, effective_current);
            const proposedBreaches = evaluateWindowAggregates(proposedAggregates, effective_proposed);
            const currentByKey = new Map(currentBreaches.map((b) => [b.related_record_id, b]));
            const proposedByKey = new Map(proposedBreaches.map((b) => [b.related_record_id, b]));
            const newBreaches: Array<{ tool_name: string; reason: string; severity: string }> = [];
            const severityChanges: Array<{ tool_name: string; reason: string; from_severity: string; to_severity: string }> = [];
            for (const [key, p] of proposedByKey) {
              const cur = currentByKey.get(key);
              if (!cur) {
                newBreaches.push({ tool_name: p.tool_name, reason: p.reason, severity: p.severity });
              } else if (cur.severity !== p.severity) {
                severityChanges.push({
                  tool_name: p.tool_name,
                  reason: p.reason,
                  from_severity: cur.severity,
                  to_severity: p.severity,
                });
              }
            }
            const resolvedBreaches: Array<{ tool_name: string; reason: string; severity: string }> = [];
            for (const [key, c2] of currentByKey) {
              if (!proposedByKey.has(key)) {
                resolvedBreaches.push({ tool_name: c2.tool_name, reason: c2.reason, severity: c2.severity });
              }
            }
            breachDiff = { new_breaches: newBreaches, resolved_breaches: resolvedBreaches, severity_changes: severityChanges };
          } catch (diffErr) {
            console.error("[AI-Ops] tool-health-config breach diff error (best-effort):", diffErr);
          }

          const { setToolHealthConfigOverrides } = await import(
            "../../utils/toolHealthConfigDatabase"
          );
          const changedBy = user.name || user.email || `user:${user.userId}`;
          const result = await setToolHealthConfigOverrides({
            overrides: cleanOverrides,
            changedBy,
            note,
            breachDiff,
            // Only forward expiresAt when the caller actually included it,
            // so an "edit just the floor" PUT doesn't accidentally wipe a
            // previously-scheduled auto-revert.
            ...(expiresAtPatch.provided
              ? { expiresAt: expiresAtPatch.value }
              : {}),
          });

          const effective = await getEffectiveToolHealthConfig();

          // Best-effort Slack notification so on-call sees who changed the
          // alert thresholds — the DB write itself is silent and audit rows
          // tend to be checked only after something has already gone wrong
          // (Task #190). Gated by TOOL_HEALTH_CONFIG_NOTIFY=1; never blocks
          // or fails the save.
          try {
            const { notifyToolHealthConfigChange } = await import(
              "../../utils/toolHealthAlertNotifier"
            );
            await notifyToolHealthConfigChange({
              changedBy,
              before: result.before,
              after: result.after,
              note,
              audit_id: result.audit_id,
            });
          } catch (notifyErr) {
            console.error(
              "[AI-Ops] tool-health-config notify error (best-effort):",
              notifyErr,
            );
          }

          return c.json({
            success: true,
            before: result.before,
            after: result.after,
            before_expires_at: result.before_expires_at,
            after_expires_at: result.after_expires_at,
            effective,
            audit_id: result.audit_id,
          });
        } catch (error) {
          console.error("[AI-Ops] tool-health-config PUT error:", error);
          return c.json({ error: "Failed to update tool-health config" }, 500);
        }
      };
    },
  },

  /**
   * Tool-health threshold tuning — audit endpoint.
   *
   * Returns the most recent N change rows, newest first. Same role gate as
   * the GET endpoint so non-admin ops can audit the change history while
   * triaging an alert without being able to flip the floor themselves.
   */
  {
    path: "/api/ai-ops/tool-health-config/audit",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, AI_OPS_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);
          const limit = safeInt(c.req.query("limit"), 25, 1, 200);
          const { getToolHealthConfigAudit } = await import(
            "../../utils/toolHealthConfigDatabase"
          );
          const data = await getToolHealthConfigAudit(limit);
          return c.json({ data });
        } catch (error) {
          console.error("[AI-Ops] tool-health-config audit error:", error);
          return c.json({ error: "Failed to load config audit" }, 500);
        }
      };
    },
  },

  /**
   * Tool-health threshold tuning — dry-run "Preview impact" endpoint.
   *
   * Lets an admin sanity-check a proposed threshold change BEFORE saving:
   * runs the same evaluator the cron uses against the current rolling
   * window's per-tool aggregates, with both the currently-effective config
   * AND the proposed config, and returns the would-be breach lists side by
   * side (no `ai_alerts` rows written, no on-call paged).
   *
   * Body shape: identical to PUT — `{ overrides: { <field>: number|null, ... } }`.
   * Validation: same as PUT (per-field bounds + band ordering on the merged
   * effective config), so a preview that "passes" can always be saved
   * without a second validation surprise.
   *
   * Auth: AI_OPS_ROLES (read-level). Anyone who can see the threshold form
   * can preview — they still cannot save it. The endpoint is read-only and
   * has no audit-log side-effect, so opening it up does not weaken the
   * write gate.
   *
   * Response shape (kept in sync with the c.json(...) call below):
   *   {
   *     effective_current:      EffectiveToolHealthConfig,
   *     effective_proposed:     EffectiveToolHealthConfig,
   *     window_minutes_changed: boolean,        // true when current/proposed
   *                                             // windowMinutes differ — UI
   *                                             // surfaces this so operators
   *                                             // know the diff compares two
   *                                             // different aggregation horizons
   *     current:  { window_minutes, tools_evaluated, breaches: [...], summary: {...} },
   *     proposed: { window_minutes, tools_evaluated, breaches: [...], summary: {...} },
   *     diff: {
   *       new_breaches:      [...],  // in proposed, not in current
   *       resolved_breaches: [...],  // in current,  not in proposed
   *       severity_changes:  [...],  // same key, severity differs
   *     }
   *   }
   *
   * Aggregate sourcing
   *   `getToolWindowAggregates(windowMinutes, minCalls)` returns metrics
   *   pre-aggregated over EXACTLY that time horizon. A 60-min aggregate
   *   cannot be derived from a 30-min one (and vice versa). So:
   *     - If both configs share the same windowMinutes, we make ONE SQL
   *       hit with the loosest minCalls and let `evaluateWindowAggregates`
   *       enforce each cfg's own minCalls in-memory.
   *     - If the windowMinutes differ, we make TWO SQL hits — one per
   *       config — to guarantee each evaluation sees aggregates over its
   *       own exact window. Correctness > a single round-trip.
   */
  {
    path: "/api/ai-ops/tool-health-config/preview",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, AI_OPS_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);

          let body: any;
          try {
            body = await c.req.json();
          } catch {
            return c.json({ error: "Request body must be valid JSON" }, 400);
          }

          const validation = await validateThresholdOverridesBody(body);
          if (!validation.ok) {
            const payload: any = { error: validation.error };
            if (validation.details) payload.details = validation.details;
            return c.json(payload, validation.status);
          }

          const effective_current = await getEffectiveToolHealthConfig();
          const effective_proposed = validation.mergedEffective;

          // Load aggregates per cfg's exact windowMinutes — see doc block
          // above. When the two configs share a window we collapse to one
          // SQL hit using the loosest minCalls, since `evaluateWindowAggregates`
          // enforces each cfg's own minCalls in-memory.
          const sameWindow =
            effective_current.windowMinutes === effective_proposed.windowMinutes;
          let currentAggregates: Awaited<ReturnType<typeof getToolWindowAggregates>>;
          let proposedAggregates: Awaited<ReturnType<typeof getToolWindowAggregates>>;
          try {
            if (sameWindow) {
              const minCallsUsed = Math.min(
                effective_current.minCalls,
                effective_proposed.minCalls,
              );
              const aggs = await getToolWindowAggregates(
                effective_current.windowMinutes,
                minCallsUsed,
              );
              currentAggregates = aggs;
              proposedAggregates = aggs;
            } else {
              // Different windows ⇒ different SQL aggregations. We must
              // load each separately or proposed/current breaches will be
              // computed off the wrong horizon.
              [currentAggregates, proposedAggregates] = await Promise.all([
                getToolWindowAggregates(
                  effective_current.windowMinutes,
                  effective_current.minCalls,
                ),
                getToolWindowAggregates(
                  effective_proposed.windowMinutes,
                  effective_proposed.minCalls,
                ),
              ]);
            }
          } catch (err) {
            console.error("[AI-Ops] tool-health-config preview aggregate error:", err);
            return c.json(
              { error: "Failed to load tool window aggregates for preview" },
              500,
            );
          }

          const currentBreaches = evaluateWindowAggregates(
            currentAggregates, effective_current,
          );
          const proposedBreaches = evaluateWindowAggregates(
            proposedAggregates, effective_proposed,
          );

          // Diff by `related_record_id` (= "<tool>:<reason>"). Same scheme
          // the cron uses for ai_alerts.related_record_id, so two breaches
          // are "the same alert" iff their composite key matches.
          const currentByKey = new Map(
            currentBreaches.map((b) => [b.related_record_id, b]),
          );
          const proposedByKey = new Map(
            proposedBreaches.map((b) => [b.related_record_id, b]),
          );
          const newBreaches: ToolHealthBreachCandidate[] = [];
          const severityChanges: Array<{
            tool_name: string;
            reason: ToolHealthBreachCandidate['reason'];
            from_severity: ToolHealthBreachCandidate['severity'];
            to_severity: ToolHealthBreachCandidate['severity'];
          }> = [];
          for (const [key, p] of proposedByKey) {
            const cur = currentByKey.get(key);
            if (!cur) {
              newBreaches.push(p);
            } else if (cur.severity !== p.severity) {
              severityChanges.push({
                tool_name: p.tool_name,
                reason: p.reason,
                from_severity: cur.severity,
                to_severity: p.severity,
              });
            }
          }
          const resolvedBreaches: ToolHealthBreachCandidate[] = [];
          for (const [key, c2] of currentByKey) {
            if (!proposedByKey.has(key)) resolvedBreaches.push(c2);
          }

          // `window_minutes_changed` flags the case where current and
          // proposed windows differ. The UI surfaces this so operators
          // know the diff compares two different aggregation horizons.
          return c.json({
            data: {
              effective_current,
              effective_proposed,
              window_minutes_changed: !sameWindow,
              current: {
                window_minutes: effective_current.windowMinutes,
                tools_evaluated: currentAggregates.length,
                breaches: currentBreaches,
                summary: summarizeBreachCandidates(currentBreaches),
              },
              proposed: {
                window_minutes: effective_proposed.windowMinutes,
                tools_evaluated: proposedAggregates.length,
                breaches: proposedBreaches,
                summary: summarizeBreachCandidates(proposedBreaches),
              },
              diff: {
                new_breaches: newBreaches,
                resolved_breaches: resolvedBreaches,
                severity_changes: severityChanges,
              },
            },
          });
        } catch (error) {
          console.error("[AI-Ops] tool-health-config preview error:", error);
          return c.json({ error: "Failed to preview tool-health config" }, 500);
        }
      };
    },
  },
];
