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
import {
  TOOL_HEALTH_DEFAULTS,
  TOOL_HEALTH_ENV_BASELINE,
  getEffectiveToolHealthConfig,
} from "../workflows/toolHealthAlertsCron";
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

          return c.json({
            data: {
              defaults: TOOL_HEALTH_DEFAULTS,
              env_baseline: TOOL_HEALTH_ENV_BASELINE,
              overrides: row.overrides,
              effective,
              updated_by: row.updated_by,
              updated_at: row.updated_at,
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
          if (!body || typeof body !== 'object') {
            return c.json({ error: "Request body must be an object" }, 400);
          }
          const rawOverrides = body.overrides;
          if (!rawOverrides || typeof rawOverrides !== 'object' || Array.isArray(rawOverrides)) {
            return c.json({ error: "overrides must be an object" }, 400);
          }

          // Validate each field that was provided. Missing fields are left
          // alone (existing override is preserved).
          const cleanOverrides: { [K in ToolHealthConfigField]?: number | null } = {};
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
            return c.json({ error: "Validation failed", details: errors }, 400);
          }

          let note: string | null = null;
          if (body.note != null) {
            if (typeof body.note !== 'string') {
              return c.json({ error: "note must be a string" }, 400);
            }
            note = body.note.length > 500 ? body.note.slice(0, 500) : body.note;
          }

          // Compute the effective config that would result *after* applying
          // this patch, so the band-ordering invariant catches a change to
          // 'high' even when 'critical' isn't part of the same request.
          const {
            getToolHealthConfigRow: peekRow,
            setToolHealthConfigOverrides,
          } = await import("../../utils/toolHealthConfigDatabase");
          const currentRow = await peekRow();
          const merged = { ...TOOL_HEALTH_ENV_BASELINE };
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
            return c.json({
              error:
                "errorRateHighPct must be less than errorRateCriticalPct " +
                `(would be ${merged.errorRateHighPct} ≥ ${merged.errorRateCriticalPct})`,
            }, 400);
          }
          if (merged.errorRatePct > merged.errorRateHighPct) {
            return c.json({
              error:
                "errorRatePct (breach floor) must not exceed errorRateHighPct " +
                `(would be ${merged.errorRatePct} > ${merged.errorRateHighPct})`,
            }, 400);
          }
          if (merged.latencyHighMs >= merged.latencyCriticalMs) {
            return c.json({
              error:
                "latencyHighMs must be less than latencyCriticalMs " +
                `(would be ${merged.latencyHighMs} ≥ ${merged.latencyCriticalMs})`,
            }, 400);
          }
          if (merged.p95LatencyMs > merged.latencyHighMs) {
            return c.json({
              error:
                "p95LatencyMs (breach floor) must not exceed latencyHighMs " +
                `(would be ${merged.p95LatencyMs} > ${merged.latencyHighMs})`,
            }, 400);
          }

          const changedBy = user.name || user.email || `user:${user.userId}`;
          const result = await setToolHealthConfigOverrides({
            overrides: cleanOverrides,
            changedBy,
            note,
          });

          const effective = await getEffectiveToolHealthConfig();
          return c.json({
            success: true,
            before: result.before,
            after: result.after,
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
];
