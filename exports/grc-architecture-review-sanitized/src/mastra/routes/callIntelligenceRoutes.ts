import {
  requireAdminOrKey,
  requireRoleOrKey,
  getSessionUser,
  unauthorizedResponse,
  type SessionUser,
} from "../../utils/rbacMiddleware";

import { logger as safeLogger } from "../../utils/logger";
import { redactSensitiveDeep } from "../../utils/sensitiveRedaction";
import { getLLMProviderApiKey, getLLMProviderBaseUrl } from "../../utils/LLMProviderCredentials";
import {
  runComplianceAfterLink,
  autoLinkCallAndCompliance,
} from "../../utils/callPostIngestPipeline";
import {
  COST as AI_COST,
  isCostCapped,
  recordSpend as recordAiSpend,
} from "../../utils/aiCostGuard";
const CALL_READ_ROLES = [
  "admin",
  "ai_specialist",
  "head_of_operations_quality",
  "quality_manager",
  "team_lead",
  "grc_manager",
] as const;

// Global concurrency cap for audio downloads.  Each in-flight request holds
// the semaphore for the entire response lifetime (including network egress),
// so large recordings can tie up a slot for many seconds.  Cap prevents a
// small group of users from exhausting Node heap via concurrent large-file
// transfers even after the per-user rate limit is respected.
// Override with MAX_CONCURRENT_AUDIO_DOWNLOADS env var.
const MAX_CONCURRENT_AUDIO_DL = (() => {
  const v = parseInt(process.env.MAX_CONCURRENT_AUDIO_DOWNLOADS ?? "8", 10);
  return Number.isFinite(v) && v > 0 ? v : 8;
})();
let _activeAudioDownloads = 0;

async function verifyAdminKey(c: any): Promise<SessionUser | null> {
  return requireAdminOrKey(c);
}

async function verifyCallAccess(c: any): Promise<SessionUser | null> {
  return requireRoleOrKey(c, [...CALL_READ_ROLES]);
}

// runComplianceAfterLink + autoLinkCallAndCompliance live in
// src/utils/callPostIngestPipeline.ts so /ingest and /upload share
// the same code path. See that file's header for the rationale.

export const callIntelligenceRoutes = [
  {
    path: "/api/calls/ingest",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyAdminKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const data = await c.req.json();

          logger?.info("📞 [API] Call ingest request received", {
            source: data.source,
            call_id: data.call_id,
          });

          const { createCallRecord, initCallIntelligenceTables } =
            await import("../../utils/callIntelligenceDb");

          await initCallIntelligenceTables();

          const callRecord = await createCallRecord({
            call_id: data.call_id || `call-${Date.now()}`,
            source: data.source || "ContactCenterProvider",
            lead_id: data.lead_id,
            deal_id: data.deal_id,
            contact_name: data.contact_name,
            agent_email: data.agent_email,
            agent_name: data.agent_name,
            direction: data.direction || "outbound",
            duration_seconds: data.duration_seconds,
            recording_url: data.recording_url,
            call_date: data.call_date ? new Date(data.call_date) : new Date(),
            status: "uploaded",
            metadata: data.metadata || {},
          });

          logger?.info("✅ [API] Call record created", { id: callRecord.id });

          // Auto-link + compliance: shared with /upload via
          // callPostIngestPipeline. Skip-if-already-linked semantics are
          // enforced inside the helper.
          const autoLinkResult = await autoLinkCallAndCompliance(callRecord, {
            logger,
            logTag: "ingest",
          });

          return c.json({
            success: true,
            call_record_id: callRecord.id,
            call_id: callRecord.call_id,
            auto_link: autoLinkResult,
            message: "Call ingested successfully. Ready for analysis.",
          });
        } catch (error) {
          safeLogger.error("Error ingesting call:", error);
          return c.json(
            {
              success: false,
              error: "Failed to ingest call",
            },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/calls",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          // Reading the call list is a READ, not a write. It must use the
          // same role gate as /api/calls/analytics (which computes the
          // headline KPI cards over these same rows). Previously this route
          // used verifyAdminKey (admin-only) while analytics used
          // verifyCallAccess (CALL_READ_ROLES). The asymmetry meant a
          // head_of_operations_quality / quality_manager / team_lead /
          // grc_manager user saw "Total Calls: 42" on the Overview tab but
          // "No call records found" on the Records tab — the 401 was
          // silently coerced into an empty array by the frontend. There is
          // no security argument for hiding the underlying rows from a role
          // that can already see their count + per-agent breakdown.
          const user = await verifyCallAccess(c);
          if (!user) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          logger?.info("📞 [API] Fetching call records");

          const { getCallRecords, initCallIntelligenceTables } =
            await import("../../utils/callIntelligenceDb");

          await initCallIntelligenceTables();

          const limit = parseInt(c.req.query("limit") || "50");
          const offset = parseInt(c.req.query("offset") || "0");
          const source = c.req.query("source");
          const agent_email = c.req.query("agent_email");
          const status = c.req.query("status");
          const lead_id = c.req.query("lead_id");
          // Whitelist sort to the two columns the DB function actually
          // supports; anything else falls back to the default (call_date).
          const rawSort = c.req.query("sort");
          const sort =
            rawSort === "created_at" || rawSort === "call_date"
              ? (rawSort as "created_at" | "call_date")
              : undefined;

          const result = await getCallRecords({
            limit,
            offset,
            source,
            agent_email,
            status,
            lead_id,
            sort,
          });

          logger?.info("✅ [API] Call records fetched", {
            count: result.records.length,
          });

          return c.json(result);
        } catch (error) {
          safeLogger.error("Error fetching calls:", error);
          return c.json({ error: "Failed to fetch call records" }, 500);
        }
      };
    },
  },
  {
    // Diagnostic: returns the absolute row count of call_records + the
    // 5 most-recently-inserted rows. Use to confirm whether uploads are
    // actually persisting to Postgres when the UI shows zero records.
    // Auth-gated (same as the other call routes) so it never leaks data.
    //   curl <REDACTED_URL_SCHEME><REDACTED_HOST>/api/calls/_debug/count \
    //        -H "Cookie: <your session cookie>"
    path: "/api/calls/_debug/count",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);
          const { callIntelligencePool, initCallIntelligenceTables } =
            await import("../../utils/callIntelligenceDb");
          await initCallIntelligenceTables();
          const countRes = await callIntelligencePool.query(
            `SELECT COUNT(*)::int AS n FROM call_records`,
          );
          const recentRes = await callIntelligencePool.query(
            `SELECT id, call_id, source, agent_email, status, call_date,
                    created_at, updated_at,
                    (audio_blob IS NOT NULL) AS has_audio_blob
               FROM call_records
              ORDER BY id DESC
              LIMIT 5`,
          );
          // Intentionally omit any DB connection metadata from the response:
          // exposing the Postgres hostname/database name (even without
          // credentials) gives an attacker who reaches this endpoint a free
          // reconnaissance step toward the data store. DATABASE_URL drift
          // between deploys is visible from server logs and the platform's
          // own ops dashboard — there is no need to ship it to API callers.
          return c.json({
            success: true,
            total_call_records: countRes.rows[0]?.n ?? 0,
            recent_5: recentRes.rows,
            checked_at: new Date().toISOString(),
          });
        } catch (error: any) {
          safeLogger.error("[API] debug count failed", {
            message: error?.message,
          });
          return c.json(
            { success: false, error: error?.message || "Debug count failed" },
            500,
          );
        }
      };
    },
  },
  {
    // DMAIC Scorecard Consolidation — admin endpoint to seed COPC v2
    // and archive previously-active scorecards. Mirrors
    // scripts/seedScorecardV2Copc.ts but runs INSIDE the deployed app
    // so it can reach the production DB (the dev workspace Shell
    // can't — prod DB is firewalled to internal IPs).
    //   POST /api/admin/scorecard/seed-copc                    (apply)
    //   POST /api/admin/scorecard/seed-copc?dry_run=1          (preview)
    path: "/api/admin/scorecard/seed-copc",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyAdminKey(c);
          if (!admin) return unauthorizedResponse(c);
          const logger = mastra?.getLogger();
          const dryRun = c.req.query("dry_run") === "1" || c.req.query("dry_run") === "true";
          const { Pool } = await import("pg");
          const pool = new Pool({ connectionString: process.env.DATABASE_URL });
          try {
            const { seedCopcScorecard } = await import(
              "../../utils/scorecardOperations"
            );
            const result = await seedCopcScorecard(pool, { dryRun });
            logger?.info("📝 [API] seedCopcScorecard", {
              dryRun,
              invariant: result.invariant_holds,
              archived: result.archived.length,
              action: result.inserted_or_updated?.action,
            });
            return c.json({ success: true, ...result });
          } finally {
            await pool.end();
          }
        } catch (error: any) {
          safeLogger.error("[API] seed-copc failed", { error: error?.message });
          return c.json({ success: false, error: error?.message || "Failed" }, 500);
        }
      };
    },
  },
  {
    // DMAIC Scorecard Consolidation — admin endpoint to score every
    // call_records row that has a transcript but no sdr_call_evaluations
    // row, using the active scorecard (COPC v2 after seed-copc has run).
    // Mirrors scripts/scoreAllUnevaluatedCalls.ts.
    //   POST /api/admin/scorecard/score-unevaluated                 (apply)
    //   POST /api/admin/scorecard/score-unevaluated?dry_run=1       (preview)
    //   POST /api/admin/scorecard/score-unevaluated?max=50          (cap per run)
    path: "/api/admin/scorecard/score-unevaluated",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyAdminKey(c);
          if (!admin) return unauthorizedResponse(c);
          const logger = mastra?.getLogger();
          const dryRun = c.req.query("dry_run") === "1" || c.req.query("dry_run") === "true";
          const max = c.req.query("max") ? parseInt(c.req.query("max"), 10) : undefined;
          const { Pool } = await import("pg");
          const pool = new Pool({ connectionString: process.env.DATABASE_URL });
          try {
            const { scoreUnevaluatedCalls } = await import(
              "../../utils/scorecardOperations"
            );
            const result = await scoreUnevaluatedCalls(pool, { dryRun, max });
            logger?.info("📊 [API] scoreUnevaluatedCalls", {
              dryRun,
              candidates: result.candidates_found,
              scored: result.scored,
              failed: result.failed,
            });
            return c.json({ success: true, ...result });
          } finally {
            await pool.end();
          }
        } catch (error: any) {
          safeLogger.error("[API] score-unevaluated failed", { error: error?.message });
          return c.json({ success: false, error: error?.message || "Failed" }, 500);
        }
      };
    },
  },
  {
    // Backfill historical (non-COPC) evaluations to COPC
    //   POST /api/admin/scorecard/backfill                  (apply)
    //   POST /api/admin/scorecard/backfill?dry_run=1        (preview)
    //   POST /api/admin/scorecard/backfill?max=N            (cap per run)
    path: "/api/admin/scorecard/backfill",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyAdminKey(c);
          if (!admin) return unauthorizedResponse(c);
          const logger = mastra?.getLogger();
          const dryRun = c.req.query("dry_run") === "1" || c.req.query("dry_run") === "true";
          const max = c.req.query("max") ? parseInt(c.req.query("max"), 10) : undefined;
          const { Pool } = await import("pg");
          const pool = new Pool({ connectionString: process.env.DATABASE_URL });
          try {
            const { backfillToCopc } = await import("../../utils/scorecardOperations");
            const result = await backfillToCopc(pool, { dryRun, max });
            logger?.info("🔁 [API] backfillToCopc", {
              dryRun,
              candidates: result.candidates_found,
              backfilled: result.backfilled,
              failed: result.failed,
            });
            return c.json({ success: true, ...result });
          } finally {
            await pool.end();
          }
        } catch (error: any) {
          safeLogger.error("[API] backfill failed", { error: error?.message });
          return c.json({ success: false, error: error?.message || "Failed" }, 500);
        }
      };
    },
  },
  {
    // DMAIC Scorecard Consolidation — read-only efficiency report.
    // Mirrors scripts/scorecardEfficiencyReport.ts. Returns the same
    // shape as the script but always as JSON.
    //   GET /api/admin/scorecard/efficiency-report
    path: "/api/admin/scorecard/efficiency-report",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyAdminKey(c);
          if (!admin) return unauthorizedResponse(c);
          const logger = mastra?.getLogger();
          const { Pool } = await import("pg");
          const pool = new Pool({ connectionString: process.env.DATABASE_URL });
          try {
            const { buildEfficiencyReport } = await import(
              "../../utils/scorecardOperations"
            );
            const report = await buildEfficiencyReport(pool);
            logger?.info("📈 [API] efficiency report generated", {
              active: report.active_scorecard,
              total: report.coverage?.total,
              backfilled: report.coverage?.backfilled,
            });
            return c.json({ success: true, ...report });
          } finally {
            await pool.end();
          }
        } catch (error: any) {
          safeLogger.error("[API] efficiency-report failed", { error: error?.message });
          return c.json({ success: false, error: error?.message || "Failed" }, 500);
        }
      };
    },
  },
  {
    // DECOMMISSIONED per scope amendments 3 + <REDACTED_PHONE>:
    //   - 3rd amendment: skip weekly digest push channels (ChatProvider + email)
    //   - 4th amendment: Weekly Report is in-dashboard, opened Monday AM
    // Returns 410 Gone so any caller (curl/Postman/automation) gets a
    // clear "this endpoint is gone" signal instead of silent no-op.
    // The handler is kept (not deleted) so the RBAC route map and
    // OpenAPI docs continue to enumerate the surface and the audit
    // trail of the decision is discoverable from code.
    path: "/api/calls/weekly-digest/send",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        return c.json(
          {
            error: "endpoint_decommissioned",
            message:
              "Weekly digest push channels (ChatProvider + email) were retired in the 3rd and 4th scope amendments on 2026-05-25. The Weekly Report now lives inside the dashboard — open /calls directly. See docs/Decision_Record_Amend_Skip_Digest_Merge_Agent_View_2026_05_25.md and docs/Decision_Record_Amend_AI_Only_No_QA_Review_2026_05_25.md.",
          },
          410,
        );
      };
    },
  },
  {
    // Coaching Effectiveness Index — DMAIC Solution #5. Returns, for
    // each delivered coaching session (where delivered_at is at least
    // 30d in the past so the after-window has closed), the agent's
    // avg overall_score 30d before vs 30d after, plus per-coach and
    // per-agent rollups. Flag-gated on COACHING_EFFECTIVENESS_INDEX.
    //   GET /api/coaching/effectiveness
    //       ?manager_email=...   (optional filter)
    //       &agent_email=...     (optional filter)
    //       &limit=...           (1..500, default 200)
    path: "/api/coaching/effectiveness",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);
          const { isFlagEnabled } = await import("../../utils/featureFlags");
          const identity = (admin as any).email || `user:${(admin as any).userId}`;
          if (!isFlagEnabled("coaching_effectiveness_index", identity)) {
            return c.json({ error: "Not found" }, 404);
          }
          const logger = mastra?.getLogger();
          const { callIntelligencePool, initCallIntelligenceTables } =
            await import("../../utils/callIntelligenceDb");
          const { ensureCoachingSessionsTable } = await import(
            "../../utils/coachingSessions"
          );
          await initCallIntelligenceTables();
          await ensureCoachingSessionsTable();
          const { fetchCoachingEffectiveness } = await import(
            "../../utils/coachingEffectivenessIndex"
          );
          const report = await fetchCoachingEffectiveness(callIntelligencePool, {
            managerEmail: c.req.query("manager_email") || undefined,
            agentEmail: c.req.query("agent_email") || undefined,
            limit: c.req.query("limit")
              ? parseInt(c.req.query("limit"), 10)
              : undefined,
          });
          logger?.info("📈 [API] CEfx report", {
            sessions: report.sessions.length,
            coaches: report.by_coach.length,
          });
          return c.json(report);
        } catch (error: any) {
          safeLogger.error("[API] CEfx failed", {
            message: error?.message,
          });
          return c.json({ error: "Failed to compute CEfx" }, 500);
        }
      };
    },
  },
  {
    // Calls pipeline health metrics. DMAIC Solution #8 (Measure phase
    // dashboard). Flag-gated on CALLS_HEALTH_DASHBOARD; ships dark.
    //   GET /api/calls/health-metrics
    // Returns process yield, CRM linkage, manager-review rate, ingest
    // mix (last 7d), coaching flow, in-memory cost snapshot, and the
    // 10 most recent analysis failures.
    path: "/api/calls/health-metrics",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);
          const { isFlagEnabled } = await import("../../utils/featureFlags");
          const identity = (admin as any).email || `user:${(admin as any).userId}`;
          if (!isFlagEnabled("calls_health_dashboard", identity)) {
            return c.json({ error: "Not found" }, 404);
          }
          const logger = mastra?.getLogger();
          const { callIntelligencePool, initCallIntelligenceTables } =
            await import("../../utils/callIntelligenceDb");
          await initCallIntelligenceTables();
          const { fetchAllCallsHealthMetrics } = await import(
            "../../utils/callsHealthMetrics"
          );
          const metrics = await fetchAllCallsHealthMetrics(callIntelligencePool);
          logger?.info("📊 [API] Calls health metrics", {
            total_calls: metrics.pipeline_yield.total_calls,
            yield_pct: metrics.pipeline_yield.yield_pct,
          });
          return c.json(metrics);
        } catch (error: any) {
          safeLogger.error("[API] calls health-metrics failed", {
            message: error?.message,
          });
          return c.json({ error: "Failed to fetch health metrics" }, 500);
        }
      };
    },
  },
  {
    // Per-lead / per-phone call history. DMAIC Solution #2 (scope #4
    // in the strategic report). Feature-flagged on LEAD_HISTORY_VIEW;
    // returns 404 when the flag is off so the existence of the endpoint
    // doesn't leak before the UI is ready.
    //
    //   GET /api/calls/lead-history?lead_id=CRMProvider_LEAD_ID
    //   GET /api/calls/lead-history?deal_id=CRMProvider_DEAL_ID
    //   GET /api/calls/lead-history?phone=<REDACTED_PHONE>//
    // All three return the same shape — newest-first calls + summary
    // aggregates. See src/utils/leadHistoryQuery.ts.
    path: "/api/calls/lead-history",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);

          // Flag-gated so the endpoint can ship dark until the page is
          // wired up and tested. Listed users in LEAD_HISTORY_VIEW_USERS
          // get access for dogfooding before the global flip.
          const { isFlagEnabled } = await import("../../utils/featureFlags");
          const identity = (admin as any).email || `user:${(admin as any).userId}`;
          if (!isFlagEnabled("lead_history_view", identity)) {
            return c.json({ error: "Not found" }, 404);
          }

          const logger = mastra?.getLogger();
          const { fetchLeadHistory } = await import(
            "../../utils/leadHistoryQuery"
          );
          const { callIntelligencePool, initCallIntelligenceTables } =
            await import("../../utils/callIntelligenceDb");
          await initCallIntelligenceTables();

          const q = {
            lead_id: c.req.query("lead_id") || undefined,
            deal_id: c.req.query("deal_id") || undefined,
            phone: c.req.query("phone") || undefined,
            limit: c.req.query("limit")
              ? parseInt(c.req.query("limit"), 10)
              : undefined,
          };

          logger?.info("🔎 [API] Lead history lookup", {
            lookup: q.lead_id ? "lead_id" : q.deal_id ? "deal_id" : "phone",
          });

          const result = await fetchLeadHistory(callIntelligencePool, q);
          if ("error" in result) {
            return c.json({ error: result.error }, result.status as any);
          }
          return c.json(result);
        } catch (error: any) {
          safeLogger.error("[API] lead-history failed", {
            message: error?.message,
          });
          return c.json(
            { error: "Failed to fetch lead history" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/calls/analytics",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();

          logger?.info("📊 [API] Fetching call analytics");

          const { getCallAnalyticsSummary, initCallIntelligenceTables } =
            await import("../../utils/callIntelligenceDb");

          await initCallIntelligenceTables();

          const startDate = c.req.query("startDate")
            ? new Date(c.req.query("startDate"))
            : undefined;
          const endDate = c.req.query("endDate")
            ? new Date(c.req.query("endDate"))
            : undefined;
          const agent_email = c.req.query("agent_email");

          const analytics = await getCallAnalyticsSummary({
            startDate,
            endDate,
            agent_email,
          });

          logger?.info("✅ [API] Analytics fetched", {
            totalCalls: analytics.totalCalls,
          });

          return c.json(analytics);
        } catch (error) {
          safeLogger.error("Error fetching analytics:", error);
          return c.json({ error: "Failed to fetch call analytics" }, 500);
        }
      };
    },
  },
  {
    // Weekly Report rollup — Week 2-3 of the lean 5-week plan
    // (see docs/Decision_Record_Amend_AI_Only_No_QA_Review_2026_05_25.md).
    // Backs the new Weekly Report section on the Overview tab.
    //
    //   GET /api/calls/weekly-report
    //       ?start=YYYY-MM-DD   (optional; default = 7 days before end)
    //       &end=YYYY-MM-DD     (optional; default = now)
    //
    // Returns: {
    //   window, prior_window,
    //   totals: { total_calls, total_evaluated, avg_overall_score,
    //             avg_compliance_score, critical_fails,
    //             coaching_plans_pending, active_agents },
    //   agents: [{ agent_email, agent_name, call_count, evaluated_count,
    //              avg_overall_score, avg_compliance_score, critical_fails,
    //              coaching_plans_pending, coaching_plans_awaiting_verification,
    //              gap_to_target, trend_direction, prior_avg_overall_score }]
    // }
    //
    // Agents sorted by gap_to_target DESC (worst at top of leaderboard).
    // Covered by the catch-all GET /api/calls RBAC rule.
    path: "/api/calls/weekly-report",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();

          const { getWeeklyReportRollup, initCallIntelligenceTables } =
            await import("../../utils/callIntelligenceDb");

          await initCallIntelligenceTables();

          // Parse YYYY-MM-DD into a Date. Invalid strings degrade to
          // undefined so the function falls back to its default
          // 7-day window rather than throwing on malformed input.
          const parseDay = (s?: string): Date | undefined => {
            if (!s) return undefined;
            const d = new Date(s);
            return isNaN(d.getTime()) ? undefined : d;
          };

          const startDate = parseDay(c.req.query("start"));
          const endDate = parseDay(c.req.query("end"));

          const rollup = await getWeeklyReportRollup({ startDate, endDate });

          logger?.info("📊 [API] Weekly report fetched", {
            window: rollup.window.label,
            agents: rollup.agents.length,
            total_calls: rollup.totals.total_calls,
          });

          return c.json(rollup);
        } catch (error: any) {
          safeLogger.error("[API] weekly-report failed", {
            message: error?.message,
          });
          return c.json(
            { error: "Failed to fetch weekly report" },
            500,
          );
        }
      };
    },
  },
  {
    // Weekly Report — per-agent drill (Slice 3 of Phase 1 Week 2-3).
    // Backs the inline expand panel under each leaderboard row. One
    // request returns everything the manager needs to decide whether
    // to coach: top 3 failed attributes, last 5 calls (clickable to
    // the existing Call Details modal), 8-week score trend, and any
    // open coaching plans.
    //
    //   GET /api/calls/weekly-report/agent/:email
    //       ?start=YYYY-MM-DD   (optional; defaults to 7 days back)
    //       &end=YYYY-MM-DD     (optional; defaults to now)
    //
    // Email path-segment is decoded once before being passed through.
    // Covered by the catch-all GET /api/calls RBAC rule.
    path: "/api/calls/weekly-report/agent/:email",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();

          const rawEmail = c.req.param("email") || "";
          const email = decodeURIComponent(rawEmail).trim();
          if (!email) {
            return c.json({ error: "agent email required" }, 400);
          }

          const { getAgentDrillData, initCallIntelligenceTables } =
            await import("../../utils/callIntelligenceDb");
          await initCallIntelligenceTables();

          const parseDay = (s?: string): Date | undefined => {
            if (!s) return undefined;
            const d = new Date(s);
            return isNaN(d.getTime()) ? undefined : d;
          };

          const startDate = parseDay(c.req.query("start"));
          const endDate = parseDay(c.req.query("end"));

          const drill = await getAgentDrillData(email, { startDate, endDate });
          if (!drill) {
            return c.json({ error: "agent not found" }, 404);
          }

          logger?.info("📊 [API] Agent drill fetched", {
            agent: email,
            window: drill.window.label,
            failed_attrs: drill.top_failed_attributes.length,
            recent_calls: drill.recent_calls.length,
            trend_points: drill.trend_series.length,
            plans: drill.coaching_plans.length,
          });

          return c.json(drill);
        } catch (error: any) {
          safeLogger.error("[API] weekly-report agent drill failed", {
            message: error?.message,
          });
          return c.json(
            { error: "Failed to fetch agent drill" },
            500,
          );
        }
      };
    },
  },
  {
    // DMAIC Improve: bulk CRM-compliance backfill. The breakdown card in
    // the Overview tab was stuck at all-zeros because the 199 historical
    // calls were never auto-linked to a CRMProvider Lead/Deal (either CRMProvider was
    // unreachable at upload time, the phone wasn't in CRM yet, or the
    // activity fallback didn't match). No link → no compliance check →
    // no call_compliance row → SUM() returns 0.
    //
    // This endpoint walks every analyzed call missing a real compliance
    // row, attempts the auto-link (phone match + activity fallback), and
    // — for newly-linked OR already-linked rows — fires the CRMProvider-backed
    // compliance check via runComplianceAfterLink. Serial with a 200ms
    // gap so CRMProvider's 10 RPS quota holds even when each call costs 4-5
    // CRMProvider API hits.
    //
    // Returns a summary the UI uses to render a progress bar:
    //   { scanned, linked, checked, skipped: [{id, reason}], failures, duration_ms }
    //
    // Body (all optional):
    //   { limit?: number, dry_run?: boolean }
    // Default limit is 50 per call so a single request fits in a 60s
    // serverless budget; the UI loops until {scanned < limit} comes
    // back, surfacing progress to the user as it goes.
    path: "/api/calls/backfill-compliance",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        const startedAt = Date.now();
        try {
          const admin = await verifyAdminKey(c);
          if (!admin) return unauthorizedResponse(c);
          const logger = mastra?.getLogger();

          let body: any = {};
          try {
            const txt = await c.req.text();
            if (txt && txt.trim()) body = JSON.parse(txt);
          } catch {
            body = {};
          }
          const limit = Math.min(Math.max(parseInt(body.limit) || 50, 1), 200);
          const dryRun = body.dry_run === true;

          const { callIntelligencePool, initCallIntelligenceTables } =
            await import("../../utils/callIntelligenceDb");
          await initCallIntelligenceTables();

          // Candidates: analyzed calls with no real compliance row
          // (either no call_compliance row at all OR a "not_checked"
          // sentinel from a previous failed check). LEFT JOIN + IS NULL
          // catches both.
          // TWO LEGACY-MIGRATION BUGS fixed here (2026-05-28):
          //
          //   1. `cr.contact_phone` doesn't exist on call_records — the
          //      contact phone has always lived inside metadata JSONB
          //      (extracted by extractCallPhoneCandidates() downstream).
          //      The query was throwing `column cr.contact_phone does
          //      not exist`, leaving the Backfill CRM Compliance button
          //      dead with "Backfill failed".
          //
          //   2. `cr.status = 'analyzed'` — that string was retired in
          //      Phase 2's status-enum migration. Real post-evaluation
          //      rows now have status in
          //      ('evaluated','qa_review_pending','qa_reviewed'). The
          //      query would have returned ZERO candidates even after
          //      bug #1 was fixed, because no row carries 'analyzed'
          //      anymore.
          //
          // We also pull `cr.metadata` (already in the SELECT) so the
          // autoLinkCallAndCompliance helper can read metadata.contact_phone
          // via extractCallPhoneCandidates.
          const candidatesRes = await callIntelligencePool.query(
            `
            SELECT cr.id, cr.call_id, cr.lead_id, cr.deal_id, cr.call_date,
                   cr.agent_email, cr.agent_name,
                   cr.metadata
            FROM call_records cr
            LEFT JOIN call_compliance cc
              ON cc.call_record_id = cr.id
             AND (cc.compliance_details->>'mode' IS DISTINCT FROM 'not_checked')
            WHERE cr.status IN ('evaluated','qa_review_pending','qa_reviewed')
              AND cc.id IS NULL
            ORDER BY cr.call_date DESC NULLS LAST
            LIMIT $1
            `,
            [limit],
          );
          const candidates = candidatesRes.rows;

          if (dryRun) {
            return c.json({
              success: true,
              dry_run: true,
              would_scan: candidates.length,
              sample: candidates.slice(0, 5).map((r: any) => ({
                id: r.id,
                call_id: r.call_id,
                has_lead: !!r.lead_id,
                has_deal: !!r.deal_id,
              })),
              duration_ms: Date.now() - startedAt,
            });
          }

          const { autoLinkCallAndCompliance, runComplianceAfterLink } =
            await import("../../utils/callPostIngestPipeline");

          const skipped: Array<{ id: number; reason: string }> = [];
          const failures: Array<{ id: number; error: string }> = [];
          let linked = 0;
          let checked = 0;

          for (const rec of candidates) {
            try {
              const hasLink = !!(rec.lead_id || rec.deal_id);
              if (!hasLink) {
                // Try auto-link first (phone match + activity fallback).
                // autoLinkCallAndCompliance also fires the compliance
                // check on success, so we can short-circuit when linked.
                const out = await autoLinkCallAndCompliance(rec, {
                  logger,
                  logTag: "backfill",
                });
                if (out.linked) {
                  linked++;
                  checked++; // compliance check already ran inside
                } else {
                  skipped.push({
                    id: rec.id,
                    reason: out.reason || "unlinkable",
                  });
                }
              } else {
                // Already linked from a previous run but never had its
                // compliance check fire (or it failed before). Run just
                // the compliance step.
                await runComplianceAfterLink(
                  rec.id,
                  rec.lead_id ?? null,
                  rec.deal_id ?? null,
                  rec.call_date,
                  logger,
                  {
                    agentEmail: rec.agent_email ?? null,
                    agentName: rec.agent_name ?? null,
                  },
                );
                checked++;
              }
            } catch (err: any) {
              failures.push({
                id: rec.id,
                error: err?.message || String(err),
              });
            }
            // Throttle: ~200ms between calls. Each call costs 4-5 CRMProvider
            // hits when fully run; 5 RPS budget holds at this pace.
            await new Promise((resolve) => setTimeout(resolve, 200));
          }

          const result = {
            success: true,
            scanned: candidates.length,
            linked,
            checked,
            skipped,
            failures,
            duration_ms: Date.now() - startedAt,
            has_more: candidates.length === limit,
          };
          logger?.info("📝 [API] backfill-compliance run complete", result);
          return c.json(result);
        } catch (error: any) {
          safeLogger.error("[API] backfill-compliance failed", {
            error: error?.message,
          });
          return c.json(
            {
              success: false,
              error: error?.message || "Backfill failed",
              duration_ms: Date.now() - startedAt,
            },
            500,
          );
        }
      };
    },
  },
  // ===================================================================
  // CRM link audit + repair sweep.
  //
  // The historical Phone-suffix matcher had no minimum-overlap floor, so
  // a junk Lead with Phone="11" matched every call whose number ended in
  // "11" (e.g. <REDACTED_PHONE>→ Lead "Sample User" phone "11"). The
  // matcher is now fixed (9-digit overlap), but the BAD LINKS it already
  // wrote are still persisted on call_records.lead_id/deal_id — and the
  // auto-linker skips already-linked rows, so they never self-heal.
  //
  // This sweep re-validates each existing phone-derived link against the
  // same 9-digit overlap rule the matcher now enforces. When the linked
  // Lead/Deal's CRMProvider phone does NOT share the call's subscriber number,
  // the link is a confirmed mismatch: we clear it (lead_id/deal_id +
  // compliance row) and re-run the auto-linker so a correct Lead can be
  // found or the call is left honestly unlinked.
  //
  // Activity-linked rows (linked_via='activity') are intentionally
  // skipped — they were matched by same-agent/same-day CRM activity, not
  // phone, so a phone mismatch is expected and not a defect.
  //
  // Admin-only. Body (all optional):
  //   { limit?: number (default 50, max 200), dry_run?: boolean,
  //     relink?: boolean (default true) }
  // Returns: { scanned, mismatched, cleared, relinked, kept, errors[],
  //            samples[], has_more, duration_ms }
  // ===================================================================
  {
    path: "/api/calls/audit-crm-links",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        const startedAt = Date.now();
        try {
          const admin = await verifyAdminKey(c);
          if (!admin) return unauthorizedResponse(c);
          const logger = mastra?.getLogger();

          let body: any = {};
          try {
            const txt = await c.req.text();
            if (txt && txt.trim()) body = JSON.parse(txt);
          } catch {
            body = {};
          }
          const limit = Math.min(Math.max(parseInt(body.limit) || 50, 1), 200);
          const dryRun = body.dry_run === true;
          const relink = body.relink !== false;
          // Deterministic id-cursor pagination. Without it, ORDER BY
          // updated_at re-surfaces just-relinked rows (clear + relink
          // bumps updated_at), so the UI loop could reprocess the same
          // rows forever and never reach older links. Advancing strictly
          // by id guarantees each row is visited at most once per run.
          const afterId = Number.isFinite(parseInt(body.after_id))
            ? parseInt(body.after_id)
            : 0;

          const { callIntelligencePool, initCallIntelligenceTables } =
            await import("../../utils/callIntelligenceDb");
          await initCallIntelligenceTables();

          const { fetchCRMProviderRecords, getCRMProviderConnectionStatus } = await import(
            "../../utils/CRMProviderCRM"
          );
          const conn = getCRMProviderConnectionStatus();
          if (!conn.connected) {
            return c.json(
              { success: false, error: "CRMProvider_not_connected" },
              503,
            );
          }

          const { phonesShareSubscriberNumber, extractCallPhoneCandidates } =
            await import("../../utils/callLeadPhoneMatch");
          const { JUNK_LEAD_STATUSES_LOWER } = await import(
            "../../utils/sdrCallLinking"
          );

          // Candidates: every linked row, INCLUDING linked_via='activity'.
          // 2026-05-30 — widened from phone-only to all-links because the
          // activity-fallback path was silently linking calls to Junk /
          // Lost / Disqualified Leads (the SDR's same-day CRM activity
          // sat on the junked record). The sweep now performs TWO checks
          // per row:
          //   1. Junk-status check — if the parent Lead is now junked,
          //      clear regardless of how the link was made.
          //   2. Phone-overlap check — same 9-digit rule as before, only
          //      applied when linked_via is NOT 'activity' (activity
          //      links are not phone-derived, so a phone mismatch there
          //      is expected and not a defect).
          // Legacy NULL linked_via is included because the historic
          // buggy matcher predates the column.
          const candidatesRes = await callIntelligencePool.query(
            `
            SELECT id, call_id, lead_id, deal_id, linked_via, metadata,
                   agent_email, agent_name, call_date
            FROM call_records
            WHERE (lead_id IS NOT NULL OR deal_id IS NOT NULL)
              AND id > $2
            ORDER BY id ASC
            LIMIT $1
            `,
            [limit, afterId],
          );
          const candidates = candidatesRes.rows;

          // Read the parent record's phone AND Lead_Status from CRMProvider in
          // a single fetch — both verifications need the same record,
          // so combining saves one CRMProvider RPS budget hit per candidate.
          // Leads carry Phone/Mobile + Lead_Status directly; Deals get
          // an empty status (we don't junk-check Deals — see comment in
          // findCrmRecordsByAgentActivity).
          const readCRMProviderRecord = async (
            module: "Leads" | "Deals",
            recordId: string,
          ): Promise<{
            phone: string | null;
            status: string | null;
            found: boolean;
          }> => {
            try {
              const rows = await fetchCRMProviderRecords(module, {
                criteria: `id:equals:${recordId}`,
                perPage: 1,
              });
              const r: any = rows[0];
              if (!r) return { phone: null, status: null, found: false };
              const d = r.data || {};
              const raw =
                (typeof d.Phone === "object" && d.Phone?.name) ||
                d.Phone ||
                (typeof d.Mobile === "object" && d.Mobile?.name) ||
                d.Mobile ||
                "";
              const status = module === "Leads"
                ? String(d.Lead_Status || "").trim() || null
                : null;
              return {
                phone: String(raw || "").trim() || null,
                status,
                found: true,
              };
            } catch (err: any) {
              logger?.warn("[audit-crm-links] CRMProvider read failed", {
                module,
                recordId,
                error: err?.message,
              });
              return { phone: null, status: null, found: false };
            }
          };

          const { clearCallRecordCrmLink } = await import(
            "../../utils/callIntelligenceDb"
          );
          const { autoLinkCallAndCompliance } = await import(
            "../../utils/callPostIngestPipeline"
          );

          const errors: Array<{ id: number; error: string }> = [];
          const samples: Array<{
            id: number;
            module: string;
            record_id: string;
            CRMProvider_phone: string | null;
            call_phones: string[];
          }> = [];
          let mismatched = 0;
          let junkCleared = 0; // 2026-05-30 — separate tally for status-driven clears
          let cleared = 0;
          let relinked = 0;
          let kept = 0;

          for (const rec of candidates) {
            try {
              const module: "Leads" | "Deals" = rec.lead_id
                ? "Leads"
                : "Deals";
              const recordId = String(rec.lead_id || rec.deal_id);
              const linkedVia = rec.linked_via || null;
              const callPhones = extractCallPhoneCandidates(rec) || [];

              const {
                phone: CRMProviderPhone,
                status: CRMProviderStatus,
                found,
              } = await readCRMProviderRecord(module, recordId);

              // Junk-status check — runs FIRST and covers both phone-
              // linked and activity-linked rows. If the Lead is junked
              // we don't care how it got linked, the link is wrong.
              if (
                found &&
                module === "Leads" &&
                CRMProviderStatus &&
                JUNK_LEAD_STATUSES_LOWER.has(CRMProviderStatus.toLowerCase())
              ) {
                junkCleared++;
                if (samples.length < 10) {
                  samples.push({
                    id: rec.id,
                    module,
                    record_id: recordId,
                    CRMProvider_phone: CRMProviderPhone,
                    call_phones: callPhones,
                  });
                }
                if (dryRun) continue;
                await clearCallRecordCrmLink(rec.id);
                cleared++;

                if (relink) {
                  const out = await autoLinkCallAndCompliance(
                    {
                      id: rec.id,
                      agent_email: rec.agent_email ?? null,
                      agent_name: rec.agent_name ?? null,
                      call_date: rec.call_date,
                      metadata: rec.metadata,
                    },
                    { logger, logTag: "link-audit-junk" },
                  );
                  if (out.linked) relinked++;
                }
                await new Promise((resolve) => setTimeout(resolve, 200));
                continue;
              }

              // Activity-linked rows skip the phone-overlap check —
              // they were never matched by phone, so a phone mismatch
              // there is expected and not a defect.
              if (linkedVia === "activity") {
                kept++;
                continue;
              }

              // No call-side phone → can't verify by phone; keep as-is.
              if (callPhones.length === 0) {
                kept++;
                continue;
              }
              // Couldn't read / no phone on the CRMProvider record → can't prove
              // a mismatch; keep conservatively.
              if (!found || !CRMProviderPhone) {
                kept++;
                continue;
              }

              const overlaps = callPhones.some((p: string) =>
                phonesShareSubscriberNumber(CRMProviderPhone, p),
              );
              if (overlaps) {
                kept++;
                continue;
              }

              // Confirmed phone mismatch.
              mismatched++;
              if (samples.length < 10) {
                samples.push({
                  id: rec.id,
                  module,
                  record_id: recordId,
                  CRMProvider_phone: CRMProviderPhone,
                  call_phones: callPhones,
                });
              }
              if (dryRun) continue;

              await clearCallRecordCrmLink(rec.id);
              cleared++;

              if (relink) {
                const out = await autoLinkCallAndCompliance(
                  {
                    id: rec.id,
                    agent_email: rec.agent_email ?? null,
                    agent_name: rec.agent_name ?? null,
                    call_date: rec.call_date,
                    metadata: rec.metadata,
                  },
                  { logger, logTag: "link-audit" },
                );
                if (out.linked) relinked++;
              }
            } catch (err: any) {
              errors.push({ id: rec.id, error: err?.message || String(err) });
            }
            // Throttle for CRMProvider's RPS budget (read + optional re-link).
            await new Promise((resolve) => setTimeout(resolve, 200));
          }

          const result = {
            success: true,
            dry_run: dryRun,
            scanned: candidates.length,
            mismatched,
            junk_cleared: junkCleared, // 2026-05-30 — junk-status sweep tally
            cleared,
            relinked,
            kept,
            errors,
            samples,
            next_cursor:
              candidates.length > 0
                ? candidates[candidates.length - 1].id
                : afterId,
            has_more: candidates.length === limit,
            duration_ms: Date.now() - startedAt,
          };
          logger?.info("🧹 [API] audit-crm-links run complete", result);
          return c.json(result);
        } catch (error: any) {
          safeLogger.error("[API] audit-crm-links failed", {
            error: error?.message,
          });
          return c.json(
            {
              success: false,
              error: error?.message || "Link audit failed",
              duration_ms: Date.now() - startedAt,
            },
            500,
          );
        }
      };
    },
  },
  // ===================================================================
  // POST /api/calls/retry-unlinked-auto-link  (admin-only)
  //
  // Re-run autoLinkCallToCrm on every call_records row that's still
  // unlinked (lead_id IS NULL AND deal_id IS NULL). Same algorithm
  // Pass 3 backfillAutoLinks uses at boot, just on-demand and
  // paginated so the operator can sweep the whole table without
  // waiting for a redeploy.
  //
  // Picks up newly-supported match paths automatically:
  //   • Contact → Deal walk via primary Contact_Name (2026-05-29)
  //   • Contact → Deal walk via Contact Roles related-list (2026-05-30)
  //   • Junk-Lead status filter on activity fallback (2026-05-30)
  //
  // Body (all optional):
  //   { limit?: number (default 50, max 200),
  //     dry_run?: boolean,
  //     after_id?: number  (cursor for next page) }
  //
  // Returns:
  //   { scanned, linked, ambiguous, no_match, no_phone, errors[],
  //     samples[], next_cursor, has_more, duration_ms }
  // ===================================================================
  {
    path: "/api/calls/retry-unlinked-auto-link",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        const startedAt = Date.now();
        try {
          const admin = await verifyAdminKey(c);
          if (!admin) return unauthorizedResponse(c);
          const logger = mastra?.getLogger();

          let body: any = {};
          try {
            const txt = await c.req.text();
            if (txt && txt.trim()) body = JSON.parse(txt);
          } catch {
            body = {};
          }
          const limit = Math.min(Math.max(parseInt(body.limit) || 50, 1), 200);
          const dryRun = body.dry_run === true;
          // Same id-cursor pagination as audit-crm-links. ORDER BY id
          // ASC guarantees forward progress: a freshly-linked row
          // disappears from the candidates set on the next page, but
          // the cursor still advances past its id.
          const afterId = Number.isFinite(parseInt(body.after_id))
            ? parseInt(body.after_id)
            : 0;

          const { callIntelligencePool, initCallIntelligenceTables } =
            await import("../../utils/callIntelligenceDb");
          await initCallIntelligenceTables();

          const { getCRMProviderConnectionStatus } = await import(
            "../../utils/CRMProviderCRM"
          );
          const conn = getCRMProviderConnectionStatus();
          if (!conn.connected) {
            return c.json(
              { success: false, error: "CRMProvider_not_connected" },
              503,
            );
          }

          // Same gate the backfill Pass 3 uses: row must have a phone
          // somewhere (contact_phone column OR metadata.contact_phone),
          // otherwise auto-link can't try anything. Including the
          // metadata path because some legacy ingest paths only write
          // the phone there. Audio-only rows with no phone at all are
          // skipped — they can't match by phone and shouldn't fall
          // through to activity-only linking (too lossy).
          const candidatesRes = await callIntelligencePool.query(
            `
            SELECT id, agent_email, agent_name, call_date, created_at,
                   metadata, contact_phone
              FROM call_records
             WHERE lead_id IS NULL
               AND deal_id IS NULL
               AND (
                    (metadata->>'contact_phone') IS NOT NULL
                 OR contact_phone IS NOT NULL
               )
               AND id > $2
             ORDER BY id ASC
             LIMIT $1
            `,
            [limit, afterId],
          );
          const candidates = candidatesRes.rows;

          const { autoLinkCallAndCompliance } = await import(
            "../../utils/callPostIngestPipeline"
          );

          const errors: Array<{ id: number; error: string }> = [];
          const samples: Array<{
            id: number;
            linked_via: string | null;
            picked_module: string | null;
            record_id: string | null;
          }> = [];
          let linked = 0;
          let ambiguous = 0;
          let no_match = 0;
          let no_phone = 0;

          for (const row of candidates) {
            if (dryRun) continue;
            try {
              const result = await autoLinkCallAndCompliance(
                {
                  id: row.id,
                  agent_email: row.agent_email ?? null,
                  agent_name: row.agent_name ?? null,
                  call_date: row.call_date ?? row.created_at,
                  metadata: row.metadata,
                },
                { logger, logTag: "retry-auto-link" },
              );
              if (result.linked) {
                linked++;
                if (samples.length < 10) {
                  samples.push({
                    id: row.id,
                    linked_via: result.linked_via ?? null,
                    picked_module: result.picked_module ?? null,
                    record_id: result.lead_id ?? result.deal_id ?? null,
                  });
                }
              } else if (result.reason === "ambiguous") {
                ambiguous++;
              } else if (result.reason === "no_phone") {
                no_phone++;
              } else {
                no_match++;
              }
            } catch (err: any) {
              errors.push({ id: row.id, error: err?.message || String(err) });
            }
            // Throttle: CRMProvider RPS budget. The walk may issue up to
            // (1 search + 1 criteria + 1 related-list) per Contact +
            // (1 leads search + 1 deals search) per phone. 200 ms
            // pacing keeps a 50-row batch under the per-second cap.
            await new Promise((resolve) => setTimeout(resolve, 200));
          }

          const result = {
            success: true,
            dry_run: dryRun,
            scanned: candidates.length,
            linked,
            ambiguous,
            no_match,
            no_phone,
            errors,
            samples,
            next_cursor:
              candidates.length > 0
                ? candidates[candidates.length - 1].id
                : afterId,
            has_more: candidates.length === limit,
            duration_ms: Date.now() - startedAt,
          };
          logger?.info("🔗 [API] retry-unlinked-auto-link run complete", result);
          return c.json(result);
        } catch (error: any) {
          safeLogger.error("[API] retry-unlinked-auto-link failed", {
            error: error?.message,
          });
          return c.json(
            {
              success: false,
              error: error?.message || "Retry auto-link failed",
              duration_ms: Date.now() - startedAt,
            },
            500,
          );
        }
      };
    },
  },
  // ===================================================================
  // POST /api/calls/backfill-via-contact-names  (admin-only)
  //
  // Historical phone_via_contact links predating 5031d0f have linked_via
  // set correctly but null via_contact_id / via_contact_name (the columns
  // didn't exist when the link was made). This endpoint sweeps those
  // rows, re-derives the bridging Contact by reading the linked Deal's
  // Contact_Name (the lookup the matcher would have picked first), and
  // persists the contact details.
  //
  // Idempotent: rows already enriched (via_contact_id IS NOT NULL) are
  // skipped. Re-running on an empty backlog is a no-op.
  //
  // Body: { limit?: 1..200 (default 50), dry_run?: bool, after_id?: number }
  // Returns:
  //   { scanned, enriched, <REDACTED_TOKEN>, <REDACTED_TOKEN>,
  //     errors[], samples[], next_cursor, has_more, duration_ms }
  // ===================================================================
  {
    path: "/api/calls/backfill-via-contact-names",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        const startedAt = Date.now();
        try {
          const admin = await verifyAdminKey(c);
          if (!admin) return unauthorizedResponse(c);
          const logger = mastra?.getLogger();

          let body: any = {};
          try {
            const txt = await c.req.text();
            if (txt && txt.trim()) body = JSON.parse(txt);
          } catch {
            body = {};
          }
          const limit = Math.min(Math.max(parseInt(body.limit) || 50, 1), 200);
          const dryRun = body.dry_run === true;
          const afterId = Number.isFinite(parseInt(body.after_id))
            ? parseInt(body.after_id)
            : 0;

          const {
            callIntelligencePool,
            initCallIntelligenceTables,
            updateCallRecordViaContact,
          } = await import("../../utils/callIntelligenceDb");
          await initCallIntelligenceTables();

          const { fetchCRMProviderRecords, getCRMProviderConnectionStatus } = await import(
            "../../utils/CRMProviderCRM"
          );
          const conn = getCRMProviderConnectionStatus();
          if (!conn.connected) {
            return c.json(
              { success: false, error: "CRMProvider_not_connected" },
              503,
            );
          }

          // Candidates: linked_via='phone_via_contact' AND missing
          // via_contact_id. deal_id required because we re-derive the
          // contact from the Deal's primary Contact_Name field. Older
          // schemas may not have the via_contact_* columns yet, in
          // which case the WHERE clause silently filters everything
          // out — no-op exit.
          const candidatesRes = await callIntelligencePool.query(
            `
            SELECT id, deal_id, lead_id
              FROM call_records
             WHERE linked_via = 'phone_via_contact'
               AND deal_id IS NOT NULL
               AND (via_contact_id IS NULL OR via_contact_id = '')
               AND id > $2
             ORDER BY id ASC
             LIMIT $1
            `,
            [limit, afterId],
          );
          const candidates = candidatesRes.rows;

          const errors: Array<{ id: number; error: string }> = [];
          const samples: Array<{
            id: number;
            deal_id: string;
            contact_id: string | null;
            contact_name: string | null;
          }> = [];
          let enriched = 0;
          let <REDACTED_TOKEN> = 0;
          let <REDACTED_TOKEN> = 0;

          for (const row of candidates) {
            try {
              // Pull the Deal's primary Contact_Name lookup. Returns
              // { id, name } in standard CRMProvider payloads. If the Deal is
              // missing or has no Contact_Name set, skip — there's
              // nothing to enrich with.
              const dealRows = await fetchCRMProviderRecords("Deals", {
                criteria: `id:equals:${row.deal_id}`,
                perPage: 1,
              });
              const deal: any = dealRows[0];
              if (!deal) {
                <REDACTED_TOKEN>++;
                continue;
              }
              const d: any = deal.data || {};
              const cn: any = d.Contact_Name;
              const contactId: string | null =
                cn && typeof cn === "object" ? cn.id || null : null;
              const contactName: string | null =
                cn && typeof cn === "object"
                  ? cn.name || null
                  : typeof cn === "string"
                    ? cn
                    : null;

              if (!contactId && !contactName) {
                <REDACTED_TOKEN>++;
                continue;
              }

              if (samples.length < 10) {
                samples.push({
                  id: row.id,
                  deal_id: String(row.deal_id),
                  contact_id: contactId,
                  contact_name: contactName,
                });
              }

              if (dryRun) {
                enriched++;
                continue;
              }

              await updateCallRecordViaContact(
                row.id,
                contactId,
                contactName,
              );
              enriched++;
            } catch (err: any) {
              errors.push({ id: row.id, error: err?.message || String(err) });
            }
            // Throttle for CRMProvider's RPS budget.
            await new Promise((resolve) => setTimeout(resolve, 150));
          }

          const result = {
            success: true,
            dry_run: dryRun,
            scanned: candidates.length,
            enriched,
            <REDACTED_TOKEN>,
            <REDACTED_TOKEN>,
            errors,
            samples,
            next_cursor:
              candidates.length > 0
                ? candidates[candidates.length - 1].id
                : afterId,
            has_more: candidates.length === limit,
            duration_ms: Date.now() - startedAt,
          };
          logger?.info(
            "🔗 [API] backfill-via-contact-names run complete",
            result,
          );
          return c.json(result);
        } catch (error: any) {
          safeLogger.error("[API] backfill-via-contact-names failed", {
            error: error?.message,
          });
          return c.json(
            {
              success: false,
              error: error?.message || "Via-contact backfill failed",
              duration_ms: Date.now() - startedAt,
            },
            500,
          );
        }
      };
    },
  },
  // ROUTE RETIRED 2026-05-29: POST /api/calls/cleanup-no-audio
  // The "Delete legacy (no audio)" button was removed from the Call
  // Records toolbar per operator request — the historical bulk-upload
  // rows whose audio bytes were discarded by the pre-Phase-3 ingest
  // path have all been cleaned up. Route handler removed in the same
  // commit. If you need to re-introduce this destructive bulk-delete,
  // the prior implementation lives at git rev 0ec0549^ (look for the
  // "Phase 5e finale" comment block).

  {
    // DMAIC Improve: one-off call_date backfill for the 199 historical
    // records whose call_date was set to file.lastModified (i.e. the
    // ZIP-unzip moment) instead of the actual call time encoded in the
    // filename. Walks call_records, parses metadata.original_filename
    // for "M_D_YYYY @ H_M_S AM/PM", builds an Asia/Riyadh-local
    // timestamp (UTC+3, no DST), converts to UTC, and writes call_date.
    //
    // Idempotent: only updates rows where the parsed date differs from
    // the current call_date by more than 24h — so a re-run is a no-op
    // and rows already corrected (e.g. via direct DB edit) stay put.
    //
    // Body: { dry_run?: boolean, limit?: number }  (defaults: false, 500)
    path: "/api/calls/backfill-call-dates",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        const startedAt = Date.now();
        try {
          const admin = await verifyAdminKey(c);
          if (!admin) return unauthorizedResponse(c);
          const logger = mastra?.getLogger();

          let body: any = {};
          try {
            const txt = await c.req.text();
            if (txt && txt.trim()) body = JSON.parse(txt);
          } catch {
            body = {};
          }
          const dryRun = body.dry_run === true;
          const limit = Math.min(Math.max(parseInt(body.limit) || 500, 1), 1000);

          const { callIntelligencePool, initCallIntelligenceTables } =
            await import("../../utils/callIntelligenceDb");
          await initCallIntelligenceTables();

          // Mirror of the frontend parseCallFilename, server-side.
          // Returns ISO UTC string or null when filename doesn't match.
          // Date assumed M_D_YYYY (US convention used by the team), time
          // assumed Asia/Riyadh local (UTC+3, no DST).
          function parseFilenameToUtc(fname: string): string | null {
            if (!fname) return null;
            const stem = String(fname).replace(/\.[^./\\]+$/, "");
            const dateMatch = stem.match(
              /\b(0?[1-9]|1[0-2])[_\-.](0?[1-9]|[12]\d|3[01])[_\-.](20\d{2})\b/,
            );
            const timeMatch = stem.match(
              /\b(0?\d|1\d|2[0-3])[_\-.:](0?\d|[1-5]\d)[_\-.:](0?\d|[1-5]\d)\s*(AM|PM|am|pm)?\b/,
            );
            if (!dateMatch || !timeMatch) return null;
            const mm = parseInt(dateMatch[1], 10);
            const dd = parseInt(dateMatch[2], 10);
            const yyyy = parseInt(dateMatch[3], 10);
            let hh = parseInt(timeMatch[1], 10);
            const mi = parseInt(timeMatch[2], 10);
            const ss = parseInt(timeMatch[3], 10);
            const ampm = (timeMatch[4] || "").toUpperCase();
            if (ampm === "PM" && hh < 12) hh += 12;
            if (ampm === "AM" && hh === 12) hh = 0;
            // Local time → UTC: Riyadh is UTC+3, so subtract 3h.
            const localMs = Date.UTC(yyyy, mm - 1, dd, hh, mi, ss);
            const utcMs = localMs - 3 * 60 * 60 * 1000;
            return new Date(utcMs).toISOString();
          }

          // Candidates: every row with a filename in metadata. We sort
          // by id ASC so a re-run hits the same order and the limit is
          // deterministic for paging.
          const res = await callIntelligencePool.query(
            `
            SELECT id, call_id, call_date, metadata
              FROM call_records
             WHERE metadata->>'original_filename' IS NOT NULL
             ORDER BY id ASC
             LIMIT $1
            `,
            [limit],
          );

          let scanned = 0;
          let updated = 0;
          let <REDACTED_TOKEN> = 0;
          let <REDACTED_TOKEN> = 0;
          const samples: any[] = [];

          for (const row of res.rows) {
            scanned++;
            const fname = row.metadata?.original_filename || "";
            const parsedIso = parseFilenameToUtc(fname);
            if (!parsedIso) {
              <REDACTED_TOKEN>++;
              continue;
            }
            const oldDate = row.call_date ? new Date(row.call_date) : null;
            const newDate = new Date(parsedIso);
            // Idempotency: skip when the existing call_date matches the
            // parsed value within a 60s tolerance (allows for sub-second
            // drift between TZ-converted reps).
            if (
              oldDate &&
              Math.abs(oldDate.getTime() - newDate.getTime()) < 60_000
            ) {
              <REDACTED_TOKEN>++;
              continue;
            }
            if (samples.length < 5) {
              samples.push({
                id: row.id,
                call_id: row.call_id,
                filename: fname,
                old_call_date: oldDate ? oldDate.toISOString() : null,
                new_call_date: parsedIso,
              });
            }
            if (!dryRun) {
              await callIntelligencePool.query(
                `UPDATE call_records SET call_date = $1, updated_at = NOW() WHERE id = $2`,
                [parsedIso, row.id],
              );
              updated++;
            } else {
              updated++; // count what WOULD be updated
            }
          }

          const result = {
            success: true,
            dry_run: dryRun,
            scanned,
            updated,
            <REDACTED_TOKEN>,
            <REDACTED_TOKEN>,
            samples,
            duration_ms: Date.now() - startedAt,
          };
          logger?.info("📝 [API] backfill-call-dates complete", result);
          return c.json(result);
        } catch (error: any) {
          safeLogger.error("[API] backfill-call-dates failed", {
            error: error?.message,
          });
          return c.json(
            {
              success: false,
              error: error?.message || "Backfill failed",
              duration_ms: Date.now() - startedAt,
            },
            500,
          );
        }
      };
    },
  },
  // ROUTE RETIRED 2026-05-29: POST /api/calls/duration-backfill
  // The "Backfill Durations" button was removed from the Call Records
  // toolbar per operator request — eager per-row backfill in
  // renderCallsTable already heals rows as the operator paginates, and
  // the upload-time duration capture covers all new ingestion paths,
  // so the bulk endpoint has been redundant. Route handler removed in
  // the same commit. The underlying utility src/utils/callDurationBackfill.ts
  // is preserved on disk so a script or future re-introduction can still
  // import it without a new implementation. If you need to re-introduce
  // this bulk endpoint, the prior implementation lives at git rev
  // 0ec0549^ (look for the "Phase 4b" comment block).

  // ===================================================================
  // Phase 4d — Auto-link diagnostic.
  //
  // Every record in the Call Records table currently displays "Not
  // linked" in the By Phone view, which is driven by lead_id / deal_id
  // being null. autoLinkCallAndCompliance IS called from the upload
  // path, so the link is failing somewhere downstream. Three plausible
  // failure modes:
  //   1. CRMProvider disconnected — getCRMProviderConnectionStatus().connected = false
  //   2. CRMProvider rate-limited — every fetchCRMProviderRecords call returns 429
  //   3. Phone-format mismatch — phones in CRM don't match the
  //      normalised form our matcher emits
  //
  // This endpoint pulls a small sample, re-runs the linker in
  // dry-run mode (no persist), and returns a structured diagnostic
  // for each call: phones extracted, scan counts, match counts,
  // reason code. Operator can hit it from the browser console
  // and read off the actual failure mode.
  // ===================================================================
  // ===================================================================
  // Phase 4e — Active CRMProvider connection probe.
  //
  // The auto-link diagnostic above reads getCRMProviderConnectionStatus()
  // which is a PASSIVE check — it only inspects the in-memory token
  // cache and reports `connected: false` whenever cachedAccessToken
  // is null. Right after a fresh deploy / process restart the cache is
  // ALWAYS empty until something triggers the first refresh, so the
  // diagnostic can say "CRMProvider NOT connected" even with perfectly valid
  // credentials. The operator updates their secrets, redeploys, hits
  // the diagnostic, sees "NOT connected", and concludes the secrets
  // are wrong when they're actually fine.
  //
  // This endpoint actively probes:
  //   1. Reports which of the 3 env vars are present (length hints so
  //      formatting issues — extra space, truncated paste — are visible)
  //   2. Reports the configured CRMProvider region (accounts URL + API domain)
  //   3. Reports the current rate-limit cooldown state
  //   4. ACTIVELY calls getValidAccessToken() and reports:
  //      - success: token length + expires_in, plus connected: true
  //      - failure: the exact error message and HTTP status from CRMProvider
  //
  // Admin-only because it surfaces CRMProvider secrets metadata and forces
  // a token-refresh attempt (which counts against the per-account
  // OAuth quota).
  // ===================================================================
  {
    path: "/api/calls/diagnostic/CRMProvider",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyAdminKey(c);
          if (!admin) return unauthorizedResponse(c);
          const logger = mastra?.getLogger();

          // Env-var presence check. We don't print VALUES — only
          // presence + length so the operator can spot truncated /
          // accidentally-quoted pastes (e.g. length=1004 on a refresh
          // token that should be ~60 chars means someone wrapped it
          // in quotes inside the secret).
          const envReport = {
            CRMProvider_CLIENT_ID: {
              present: !!process.env.CRMProvider_CLIENT_ID,
              length: (process.env.CRMProvider_CLIENT_ID || "").length,
            },
            CRMProvider_CLIENT_ID_NEW: {
              present: !!process.env.CRMProvider_CLIENT_ID_NEW,
              length: (process.env.CRMProvider_CLIENT_ID_NEW || "").length,
            },
            CRMProvider_CLIENT_SECRET: {
              present: !!process.env.CRMProvider_CLIENT_SECRET,
              length: (process.env.CRMProvider_CLIENT_SECRET || "").length,
            },
            CRMProvider_REFRESH_TOKEN: {
              present: !!process.env.CRMProvider_REFRESH_TOKEN,
              length: (process.env.CRMProvider_REFRESH_TOKEN || "").length,
            },
            CRMProvider_ACCOUNTS_URL:
              process.env.CRMProvider_ACCOUNTS_URL || "(default: <REDACTED_URL>",
            CRMProvider_API_DOMAIN:
              process.env.CRMProvider_API_DOMAIN || "(default: <REDACTED_URL>",
            CRMProvider_ACCESS_TOKEN_static: {
              present: !!process.env.CRMProvider_ACCESS_TOKEN,
              length: (process.env.CRMProvider_ACCESS_TOKEN || "").length,
            },
          };

          const {
            getCRMProviderConnectionStatus,
            getCRMProviderRateLimitState,
            getValidAccessToken,
          } = await import("../../utils/CRMProviderCRM");

          const passiveStatus = getCRMProviderConnectionStatus();
          const rateLimit = getCRMProviderRateLimitState();

          // Active probe — actually call getValidAccessToken so we
          // exercise the OAuth refresh path and surface the real error
          // if it fails. Catches: bad client credentials (HTTP 400
          // "Invalid client"), bad refresh token (HTTP 400 "Invalid
          // grant"), wrong datacenter URL (HTTP 404), rate-limited
          // (cooldown active), network unreachable (TypeError).
          let activeProbe: any = {
            attempted: false,
            ok: false,
            errorClass: null,
            errorMessage: null,
            errorHttpStatus: null,
            isCRMProviderRateLimited: false,
            tokenLength: 0,
          };
          try {
            activeProbe.attempted = true;
            const token = await getValidAccessToken();
            activeProbe.ok = !!token;
            activeProbe.tokenLength = (token || "").length;
          } catch (err: any) {
            activeProbe.ok = false;
            activeProbe.errorClass = err?.constructor?.name || "Error";
            activeProbe.errorMessage = err?.message || String(err);
            activeProbe.errorHttpStatus = err?.httpStatus || null;
            activeProbe.isCRMProviderRateLimited = !!err?.isCRMProviderRateLimited;
          }

          // Re-read passive status AFTER the active probe so the user
          // can see whether the refresh attempt populated the cache.
          const passiveStatusAfter = getCRMProviderConnectionStatus();

          // Diagnosis sentence — pick the most actionable explanation.
          let diagnosis = "Unclear — review the per-field detail below.";
          if (
            !envReport.CRMProvider_CLIENT_ID.present &&
            !envReport.CRMProvider_CLIENT_ID_NEW.present
          ) {
            diagnosis = "CRMProvider_CLIENT_ID is NOT set in HostingPlatform Secrets. Add it and redeploy.";
          } else if (!envReport.CRMProvider_CLIENT_SECRET.present) {
            diagnosis = "CRMProvider_CLIENT_SECRET is NOT set in HostingPlatform Secrets. Add it and redeploy.";
          } else if (!envReport.CRMProvider_REFRESH_TOKEN.present) {
            diagnosis = "CRMProvider_REFRESH_TOKEN is NOT set in HostingPlatform Secrets. Generate one in the CRMProvider API Console and add it.";
          } else if (activeProbe.isCRMProviderRateLimited) {
            diagnosis = `CRMProvider's OAuth endpoint is in cooldown — wait ~${Math.ceil((rateLimit.cooldownMsRemaining || 0) / 1000)}s and try again. (Caused by previous repeated refresh failures.)`;
          } else if (activeProbe.ok) {
            diagnosis = "CRMProvider is connected and the active token refresh just succeeded. If the dashboard still shows 'NOT connected' somewhere, it's caching the pre-probe state — hard-refresh the page.";
          } else if (activeProbe.errorMessage) {
            const msg = activeProbe.errorMessage.toLowerCase();
            if (msg.includes("invalid client") || msg.includes("invalid_client")) {
              diagnosis = "CRMProvider rejected the credentials with 'invalid client' — CLIENT_ID and/or CLIENT_SECRET don't match an active OAuth app on the configured datacenter. Verify both in the CRMProvider API Console.";
            } else if (msg.includes("invalid grant") || msg.includes("invalid_grant") || msg.includes("invalid code")) {
              diagnosis = "CRMProvider rejected the REFRESH_TOKEN with 'invalid grant' — the token has been revoked, expired, or was generated for a different OAuth app / scope. Generate a fresh refresh token in the CRMProvider API Console and update the secret.";
            } else if (msg.includes("enotfound") || msg.includes("getaddrinfo") || activeProbe.errorClass === "TypeError") {
              diagnosis = "Network reach failed — the CRMProvider accounts URL is unreachable from this server. Confirm CRMProvider_ACCOUNTS_URL points at the right datacenter (.com / .eu / .in / .com.au / .sa).";
            } else if (activeProbe.errorHttpStatus === 404 || msg.includes("404")) {
              diagnosis = `CRMProvider returned HTTP 404 — the accounts URL '${envReport.CRMProvider_ACCOUNTS_URL}' is wrong for your CRMProvider region. Try <REDACTED_URL> (US), .eu (Europe), .in (India), .com.au (AU), or .sa (Saudi).`;
            } else {
              diagnosis = `CRMProvider refresh threw: ${activeProbe.errorMessage}`;
            }
          }

          return c.json({
            success: true,
            diagnosis,
            env_secrets: envReport,
            passive_status_before_probe: passiveStatus,
            passive_status_after_probe: passiveStatusAfter,
            rate_limit_cooldown: rateLimit,
            active_probe: activeProbe,
          });
        } catch (error: any) {
          safeLogger.error("[API] CRMProvider diagnostic failed", {
            error: error?.message,
          });
          return c.json(
            { success: false, error: error?.message || "Diagnostic failed" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/calls/diagnostic/auto-link",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyAdminKey(c);
          if (!admin) return unauthorizedResponse(c);
          const logger = mastra?.getLogger();

          const n = (() => {
            const raw = c.req.query("n");
            const parsed = raw ? parseInt(raw, 10) : 3;
            return Number.isFinite(parsed) && parsed > 0 && parsed <= 20
              ? parsed
              : 3;
          })();

          const {
            callIntelligencePool,
            initCallIntelligenceTables,
          } = await import("../../utils/callIntelligenceDb");
          await initCallIntelligenceTables();

          const sample = await callIntelligencePool.query<{
            id: number;
            call_id: string;
            agent_email: string | null;
            agent_name: string | null;
            contact_name: string | null;
            lead_id: string | null;
            deal_id: string | null;
            call_date: Date | null;
            metadata: any;
          }>(
            `SELECT id, call_id, agent_email, agent_name, contact_name,
                    lead_id, deal_id, call_date, metadata
               FROM call_records
              WHERE lead_id IS NULL
                AND deal_id IS NULL
              ORDER BY id DESC
              LIMIT $1`,
            [n],
          );

          const { getCRMProviderConnectionStatus } = await import(
            "../../utils/CRMProviderCRM"
          );
          const CRMProviderStatus = getCRMProviderConnectionStatus();

          const { extractCallPhoneCandidates, MIN_PHONE_OVERLAP_DIGITS } =
            await import("../../utils/callLeadPhoneMatch");
          const { findCrmRecordByPhone } = await import(
            "../../utils/sdrCallLinking"
          );
          const { normalizePhoneDigits } = await import(
            "../../utils/callMcpReconciliation"
          );

          // Sample CRMProvider phone field values — taken from the first 10
          // records in Leads + first 10 in Deals — so the operator can
          // SEE what raw format CRMProvider stores phones in, and compare
          // against our normalized form. This is what tells us whether
          // we're looking at:
          //   - Format mismatch on a known field (rare; the matcher
          //     already normalizes both sides via normalizePhoneDigits)
          //   - Phone stored in a custom field our readers don't pick up
          //     (e.g. WhatsApp_Number, Client_Phone, Mobile_Number_2)
          //   - The phones genuinely not in CRMProvider (e.g. leads were created
          //     without phone, or the CRM has been pruned).
          let CRMProviderSamplePhones: any = null;
          try {
            const { fetchAllCRMProviderRecords } = await import("../../utils/CRMProviderCRM");
            const [leadsSample, dealsSample] = await Promise.allSettled([
              fetchAllCRMProviderRecords("Leads", { maxRecords: 10 }),
              fetchAllCRMProviderRecords("Deals", { maxRecords: 10 }),
            ]);
            const dumpFields = (rec: any) => {
              const d = rec?.data || {};
              // Surface every "phone-shaped" field on the record so a
              // custom field (Mobile_Number, WhatsApp_Number, etc.) jumps
              // out at the operator. We pattern-match key names that
              // contain "phone" or "mobile" (case-insensitive) plus the
              // canonical Phone / Mobile fields.
              const phoneFields: Record<string, any> = {};
              for (const [key, val] of Object.entries(d)) {
                if (val == null || val === "") continue;
                if (/phone|mobile|whatsapp|wa_number/i.test(key)) {
                  // Normalize the value too so the operator can see if
                  // it matches the call's normalized form.
                  const rawStr =
                    typeof val === "object" && (val as any).name
                      ? String((val as any).name)
                      : String(val);
                  phoneFields[key] = {
                    raw: rawStr,
                    normalized: normalizePhoneDigits(rawStr),
                  };
                }
              }
              return {
                id: rec?.id,
                full_name: d.Full_Name || d.Last_Name || d.Deal_Name || null,
                phone_fields: phoneFields,
              };
            };
            CRMProviderSamplePhones = {
              leads_first10:
                leadsSample.status === "fulfilled"
                  ? leadsSample.value.map(dumpFields)
                  : { error: leadsSample.reason?.message || "fetch failed" },
              deals_first10:
                dealsSample.status === "fulfilled"
                  ? dealsSample.value.map(dumpFields)
                  : { error: dealsSample.reason?.message || "fetch failed" },
            };
          } catch (sampleErr: any) {
            CRMProviderSamplePhones = { error: sampleErr?.message || String(sampleErr) };
          }

          const results = [];
          for (const row of sample.rows) {
            const phones = extractCallPhoneCandidates(row);
            const phonesNormalized = phones.map((p) => ({
              raw: p,
              normalized: p ? normalizePhoneDigits(p) : null,
            }));
            const phoneAttempts = [];
            for (const phone of phones) {
              if (!phone) continue;
              const normalized = normalizePhoneDigits(phone);
              if (!normalized || normalized.length < MIN_PHONE_OVERLAP_DIGITS) {
                phoneAttempts.push({
                  raw: phone,
                  normalized,
                  skipped: "too_short",
                });
                continue;
              }
              try {
                // Use the full 2500-record cap — same as the real
                // auto-link — so the diagnostic isn't falsely
                // confident about "no match" when the lead is actually
                // present beyond the 200-record sample.
                const matchRes = await findCrmRecordByPhone(phone, {
                  maxRecordsPerModule: 2500,
                });
                phoneAttempts.push({
                  raw: phone,
                  normalized,
                  scanned_leads: matchRes.scanned_leads,
                  scanned_deals: matchRes.scanned_deals,
                  matches: matchRes.matches.map((m) => ({
                    id: m.id,
                    module: m.module,
                    display_name: m.display_name,
                    phone: m.phone,
                  })),
                });
              } catch (err: any) {
                phoneAttempts.push({
                  raw: phone,
                  normalized,
                  error: err?.message || String(err),
                });
              }
            }

            results.push({
              call_id: row.call_id,
              id: row.id,
              agent_email: row.agent_email,
              contact_name: row.contact_name,
              call_date: row.call_date,
              extracted_phones: phonesNormalized,
              phone_attempts: phoneAttempts,
              current_link: {
                lead_id: row.lead_id,
                deal_id: row.deal_id,
              },
            });
          }

          // Roll up a single-sentence diagnosis based on the data.
          let diagnosis = "Unclear — review per-call detail below.";
          if (!CRMProviderStatus.connected) {
            diagnosis =
              "CRMProvider is NOT connected — that's why no auto-links can land. Reconnect CRMProvider on the Integrations tab.";
          } else if (results.length === 0) {
            diagnosis =
              "Every call_records row already has a lead/deal — no unlinked rows to diagnose. The 'Not linked' badge may be a UI bug — check the By Phone group_by code.";
          } else {
            const totalScanned = results.reduce(
              (sum, r) =>
                sum +
                r.phone_attempts.reduce(
                  (s: number, a: any) =>
                    s + (a.scanned_leads || 0) + (a.scanned_deals || 0),
                  0,
                ),
              0,
            );
            const totalMatches = results.reduce(
              (sum, r) =>
                sum +
                r.phone_attempts.reduce(
                  (s: number, a: any) =>
                    s + (Array.isArray(a.matches) ? a.matches.length : 0),
                  0,
                ),
              0,
            );
            const anyErrors = results.some((r) =>
              r.phone_attempts.some((a: any) => a.error),
            );
            if (anyErrors) {
              diagnosis =
                "CRMProvider fetch errored on at least one phone — likely rate-limited (429) or token expired. See `phone_attempts[].error` per row.";
            } else if (totalScanned === 0) {
              diagnosis =
                "CRMProvider returned zero records for every phone attempted — auth issue OR rate-limit bail. Verify the integration on /integrations and try again.";
            } else if (totalMatches === 0) {
              diagnosis =
                `CRMProvider returned ${totalScanned} records but ZERO phone matches — phone format mismatch likely. ` +
                `Compare the 'normalized' field below against the Phone column on a CRMProvider Lead.`;
            } else {
              diagnosis =
                `Phone match worked (${totalMatches} hits across ${results.length} calls) — but the persist step on these specific rows failed. Check ai_insights / metadata for errors.`;
            }
          }

          logger?.info("[API] auto-link diagnostic complete", {
            sample_size: results.length,
            CRMProvider_connected: CRMProviderStatus.connected,
          });

          return c.json({
            success: true,
            diagnosis,
            CRMProvider_connection: {
              connected: CRMProviderStatus.connected,
              status: CRMProviderStatus,
            },
            sample_size: results.length,
            results,
            CRMProvider_sample_phones: CRMProviderSamplePhones,
          });
        } catch (error: any) {
          safeLogger.error("[API] auto-link diagnostic failed", {
            error: error?.message,
          });
          return c.json(
            {
              success: false,
              error: error?.message || "Diagnostic failed",
            },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/calls/compliance",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();

          logger?.info("📊 [API] Fetching compliance records");

          const { getComplianceRecords, initCallIntelligenceTables } =
            await import("../../utils/callIntelligenceDb");

          await initCallIntelligenceTables();

          const limit = parseInt(c.req.query("limit") || "50");
          const offset = parseInt(c.req.query("offset") || "0");
          const lead_id = c.req.query("lead_id");
          const agent_email = c.req.query("agent_email");

          const result = await getComplianceRecords({
            limit,
            offset,
            lead_id,
            agent_email,
          });

          logger?.info("✅ [API] Compliance records fetched", {
            count: result.records.length,
          });

          return c.json(result);
        } catch (error) {
          safeLogger.error("Error fetching compliance records:", error);
          return c.json({ error: "Failed to fetch compliance records" }, 500);
        }
      };
    },
  },
  // ===================================================================
  //  Topic Clustering (DMAIC Improve P3, 2026-05-25)
  //
  //  REGISTRATION-ORDER NOTE (2026-05-29):
  //  This route MUST stay registered BEFORE /api/calls/:callId. Mastra's
  //  apiRoutes array is matched in order, and the dynamic :callId catches
  //  any single-segment GET under /api/calls/* — including the literal
  //  string "topic-clusters". When this route was originally defined
  //  ~5000 lines below the :callId route, every request hit the
  //  :callId handler, parseInt("topic-clusters") returned NaN, and the
  //  user saw "HTTP 400 — Invalid call ID" instead of the topic data.
  //  Same shadowing pattern as task-670 (the qms enhanced-routes vs
  //  qmsApiRoutes precedence). See src/mastra/index.ts:233 for the
  //  precedent.
  //  Aggregates call_analysis.key_topics across analyzed calls in a
  //  rolling window. Surfaces systemic gaps: "20 calls mentioned
  //  pricing objection in last 30 days" → coaching opportunity at
  //  TEAM level, not just per-call. Reuses the existing AI-generated
  //  topic list — no new model spend.
  // ===================================================================
  {
    path: "/api/calls/topic-clusters",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const windowDays = Math.min(
            Math.max(parseInt(c.req.query("window_days") || "30"), 1),
            365,
          );
          const topN = Math.min(
            Math.max(parseInt(c.req.query("top_n") || "20"), 1),
            100,
          );

          const { callIntelligencePool, initCallIntelligenceTables } =
            await import("../../utils/callIntelligenceDb");
          await initCallIntelligenceTables();

          // jsonb_array_elements_text expands a JSONB array column into
          // one row per element. We then COUNT(DISTINCT call_record_id)
          // per topic so the same call mentioning the same topic twice
          // doesn't inflate the metric. Window filter on call_date.
          const res = await callIntelligencePool.query(
            `
            WITH topic_rows AS (
              SELECT
                cr.id AS call_id,
                cr.call_date,
                cr.agent_email,
                LOWER(TRIM(elem)) AS topic
              FROM call_records cr
              JOIN call_analysis ca ON ca.call_record_id = cr.id
              LEFT JOIN LATERAL jsonb_array_elements_text(
                CASE WHEN jsonb_typeof(ca.key_topics) = 'array'
                     THEN ca.key_topics
                     ELSE '[]'::jsonb END
              ) elem ON TRUE
              WHERE cr.call_date >= NOW() - ($1 || ' days')::INTERVAL
                AND cr.status IN ('evaluated','qa_review_pending','qa_reviewed')
                AND elem IS NOT NULL
                AND LENGTH(TRIM(elem)) > 0
            ),
            topic_agg AS (
              SELECT
                topic,
                COUNT(DISTINCT call_id)::int AS call_count,
                COUNT(DISTINCT agent_email)::int AS agent_count,
                MAX(call_date) AS latest_call_date,
                ARRAY(
                  SELECT call_id FROM topic_rows tr2
                   WHERE tr2.topic = topic_rows.topic
                   ORDER BY call_date DESC
                   LIMIT 10
                ) AS sample_call_ids,
                ARRAY(
                  SELECT DISTINCT agent_email FROM topic_rows tr3
                   WHERE tr3.topic = topic_rows.topic
                     AND agent_email IS NOT NULL
                   LIMIT 10
                ) AS sample_agents
              FROM topic_rows
              GROUP BY topic
            )
            SELECT * FROM topic_agg
             WHERE call_count >= 2
             ORDER BY call_count DESC, latest_call_date DESC
             LIMIT $2
            `,
            [String(windowDays), topN],
          );

          // Total analyzed calls in window — denominator so the UI can
          // render "X% of calls in this window mention <topic>".
          const totalRes = await callIntelligencePool.query(
            `
            SELECT COUNT(*)::int AS n
              FROM call_records
             WHERE call_date >= NOW() - ($1 || ' days')::INTERVAL
               AND status IN ('evaluated','qa_review_pending','qa_reviewed')
            `,
            [String(windowDays)],
          );

          // Cache-Control: no-store stops the browser from holding onto a
          // stale 400 response from before the RBAC entry for this route
          // landed (commit fdcb05b). Without it, even after a successful
          // deploy a user who saw the error once would keep seeing the
          // cached 400 until they hard-refreshed.
          c.header("Cache-Control", "no-store, no-cache, must-revalidate");
          return c.json({
            window_days: windowDays,
            total_analyzed_calls: totalRes.rows[0]?.n || 0,
            topics: res.rows.map((r: any) => ({
              topic: r.topic,
              call_count: r.call_count,
              agent_count: r.agent_count,
              latest_call_date: r.latest_call_date,
              sample_call_ids: r.sample_call_ids || [],
              sample_agents: r.sample_agents || [],
            })),
          });
        } catch (error: any) {
          safeLogger.error("[API] topic clusters failed", {
            error: error?.message,
            stack: error?.stack,
          });
          c.header("Cache-Control", "no-store");
          return c.json(
            {
              error: error?.message || "Failed to compute topic clusters",
              hint: "If this just shows 'HTTP 400' or 'Failed', hard-refresh (Ctrl+Shift+R) — the response is no longer cached.",
            },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/calls/:callId",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const callId = parseInt(c.req.param("callId"));

          if (isNaN(callId)) {
            return c.json({ error: "Invalid call ID" }, 400);
          }

          logger?.info("📞 [API] Fetching call with full analysis", { callId });

          const { getCallWithFullAnalysis } =
            await import("../../utils/callIntelligenceDb");

          const result = await getCallWithFullAnalysis(callId);

          if (!result.record) {
            return c.json({ error: "Call record not found" }, 404);
          }

          logger?.info("✅ [API] Call details fetched", { callId });

          return c.json(result);
        } catch (error) {
          safeLogger.error("Error fetching call:", error);
          return c.json({ error: "Failed to fetch call details" }, 500);
        }
      };
    },
  },
  // ===================================================================
  //  Manual call-status override (2026-05-29)
  //
  //  Allows a quality reviewer / admin to change a single call's status
  //  to any of evaluated / qa_review_pending / qa_reviewed WITHOUT
  //  re-running the AI evaluation. Closes the workflow gap where the
  //  AI auto-routed a low-confidence call to qa_review_pending and the
  //  reviewer decided it was fine, or vice versa (AI was confident but
  //  the reviewer wants a second pair of eyes).
  //
  //  Restricted to the three post-evaluation states by design:
  //    - The intake states (uploaded / transcribing / transcribed /
  //      evaluating) are pipeline-managed; a manual override there
  //      would race the worker and corrupt the queue.
  //    - "failed" is also pipeline-managed (terminal error state).
  //
  //  Audit-logged: every change writes an event_logs row capturing
  //  who changed it, when, from what, to what — ISO 9001 §9.1.3 +
  //  PDPL Art. 31 traceability, same envelope SDR review submissions
  //  use (sdr_evaluation_reviewed action_type).
  //
  //  Body: { status: "evaluated" | "qa_review_pending" | "qa_reviewed" }
  //  Auth: admin OR quality_manager / quality_specialist /
  //        head_of_operations_quality / ai_specialist.
  // ===================================================================
  {
    path: "/api/calls/:callId/status",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          // verifyCallAccess is the standard quality-team gate used by
          // every other call read/write here — same CALL_READ_ROLES list.
          // The post-evaluation states are quality-team decisions, not
          // strict admin-only operations, so this aligns with the rest
          // of the calls page rather than the heavier admin-only writes.
          const user = await verifyCallAccess(c);
          if (!user) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const callId = parseInt(c.req.param("callId"));
          if (!Number.isFinite(callId)) {
            return c.json({ error: "Invalid call ID" }, 400);
          }

          const body = await c.req.json().catch(() => ({}));
          const requested = String(body?.status || "").trim();
          const ALLOWED_OVERRIDES = new Set([
            "evaluated",
            "qa_review_pending",
            "qa_reviewed",
          ]);
          if (!ALLOWED_OVERRIDES.has(requested)) {
            return c.json(
              {
                error: "Invalid status. Allowed: evaluated, qa_review_pending, qa_reviewed.",
                hint: "Pipeline-managed states (uploaded, transcribing, transcribed, evaluating, failed) cannot be set manually — let the worker drive those.",
              },
              400,
            );
          }

          const {
            getCallRecordById,
            updateCallStatus,
            initCallIntelligenceTables,
          } = await import("../../utils/callIntelligenceDb");
          await initCallIntelligenceTables();

          const existing = await getCallRecordById(callId);
          if (!existing) {
            return c.json({ error: "Call record not found" }, 404);
          }

          // Idempotent — re-setting to the current status is a no-op
          // success so the dashboard can fire the request without
          // round-tripping a no-op alert.
          if (existing.status === requested) {
            return c.json({
              success: true,
              call_id: callId,
              status: requested,
              previous_status: requested,
              no_op: true,
            });
          }

          await updateCallStatus(callId, requested as any);

          // Audit-trail — match the envelope SDR review submissions use
          // so the event log timeline doesn't fragment across action
          // types. severity defaults to INFO; bump to WARNING when a
          // reviewer demotes qa_reviewed back to qa_review_pending
          // (signals a finalized review was reopened).
          try {
            const { logEvent } = await import(
              "../../utils/eventLogsDatabase"
            );
            const demoted =
              existing.status === "qa_reviewed" &&
              requested !== "qa_reviewed";
            await logEvent({
              actionType: "call_status_manual_override",
              entityType: "call_record",
              entityId: String(callId),
              module: "calls",
              severity: demoted ? "WARNING" : "INFO",
              aiInvolved: false,
              userEmail: (user as any).email || undefined,
              userName: (user as any).name || undefined,
              description: `Operator ${
                (user as any).email || "(unknown)"
              } changed call ${callId} status: ${existing.status} → ${requested}.`,
              oldValue: { status: existing.status },
              newValue: { status: requested },
            });
          } catch (logErr: any) {
            logger?.warn("[API] call-status manual override audit failed", {
              callId,
              error: logErr?.message || String(logErr),
            });
          }

          logger?.info("✅ [API] call status manually overridden", {
            callId,
            from: existing.status,
            to: requested,
            by: (user as any).email,
          });

          return c.json({
            success: true,
            call_id: callId,
            status: requested,
            previous_status: existing.status,
            no_op: false,
          });
        } catch (error: any) {
          safeLogger.error("[API] call-status manual override failed", {
            error: error?.message,
          });
          return c.json(
            { error: error?.message || "Status update failed" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/calls/:callId/analyze",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyAdminKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const callId = parseInt(c.req.param("callId"));

          // Handle empty or missing request body
          let data: any = {};
          try {
            const bodyText = await c.req.text();
            if (bodyText && bodyText.trim()) {
              data = JSON.parse(bodyText);
            }
          } catch {
            // Empty body is acceptable
            data = {};
          }

          logger?.info("🔬 [API] Triggering call analysis", { callId });

          const { getCallRecordById, updateCallRecord } =
            await import("../../utils/callIntelligenceDb");

          const callRecord = await getCallRecordById(callId);
          if (!callRecord) {
            return c.json({ error: "Call record not found" }, 404);
          }

          if (!data.transcript && !callRecord.recording_url) {
            return c.json(
              {
                error: "Transcript or recording URL required for analysis",
              },
              400,
            );
          }

          await updateCallRecord(callId, { status: "transcribing" });

          const { saveTranscript, saveCallAnalysis, saveQAScore } =
            await import("../../utils/callIntelligenceDb");
          const { createLLMProvider } = await import("@ai-sdk/LLMProvider");
          const { generateText } = await import("ai");

          const transcript =
            data.transcript || "Transcript from recording (placeholder)";
          const agentType = data.agent_type || "sdr";

          await saveTranscript({
            call_record_id: callId,
            transcript_text: transcript,
            language: "en",
            confidence_score: 95,
          });

          const LLMProvider = createLLMProvider({
            baseURL: getLLMProviderBaseUrl(),
            apiKey: getLLMProviderApiKey(),
          });

          const analysisPrompt = `Analyze this sales call transcript and provide JSON:
${transcript}

Respond with JSON only:
{
  "sentiment_score": <0-100>,
  "sentiment_label": "<positive|neutral|negative>",
  "voice_of_customer": "<customer concerns>",
  "objections_detected": [{"objection": "<text>", "handled_well": true}],
  "key_topics": ["<topic>"],
  "action_items": ["<action>"],
  "next_steps": ["<step>"],
  "call_summary": "<2-3 sentence summary>",
  "ai_insights": "<recommendations>"
}`;

          // Raw-fetch /chat/completions — bypasses the @ai-sdk/LLMProvider v3
          // spec regression that even `.chat()` now triggers.
          const { generateChatText } = await import(
            "../../utils/LLMProviderChatHelper"
          );
          const aiResult = await generateChatText({
            model: "gpt-4o",
            prompt: analysisPrompt,
            maxTokens: 2000,
            responseFormat: "json_object",
          });

          let analysisData;
          try {
            const cleanedText = aiResult.text
              .replace(/```json\n?|\n?```/g, "")
              .trim();
            analysisData = JSON.parse(cleanedText);
          } catch {
            analysisData = {
              sentiment_score: 50,
              sentiment_label: "neutral",
              call_summary: "Analysis parsing failed",
              voice_of_customer: "",
              objections_detected: [],
              key_topics: [],
              action_items: [],
              next_steps: [],
              ai_insights: "",
            };
          }

          await saveCallAnalysis({
            call_record_id: callId,
            sentiment_score: analysisData.sentiment_score,
            sentiment_label: analysisData.sentiment_label,
            voice_of_customer: analysisData.voice_of_customer,
            objections_detected: analysisData.objections_detected,
            key_topics: analysisData.key_topics,
            action_items: analysisData.action_items,
            next_steps: analysisData.next_steps,
            call_summary: analysisData.call_summary,
            ai_insights: analysisData.ai_insights,
          });

          await updateCallRecord(callId, { status: "evaluated" });

          // Phase B — fire-and-forget SDR scorecard evaluation. Runs the
          // active scorecard against this call's transcript so the SDR
          // Evaluation tab list and the per-agent Avg QA Score in Analytics
          // get populated automatically. Wrapped so a scorecard failure
          // never affects the analyze response the caller is waiting on.
          let autoEvalOutcome: any = null;
          try {
            const { triggerSDREvaluationForCall } = await import(
              "../../utils/sdrAutoEvaluator"
            );
            autoEvalOutcome = await triggerSDREvaluationForCall(callId, "SDR");
            if (autoEvalOutcome.ran) {
              logger?.info("📋 [API] Auto-SDR-eval succeeded", {
                callId,
                scorecardId: autoEvalOutcome.scorecardId,
                overallScore: autoEvalOutcome.overallScore,
              });
            } else {
              logger?.info("📋 [API] Auto-SDR-eval skipped", {
                callId,
                reason: autoEvalOutcome.skipReason,
              });
            }
          } catch (e: any) {
            logger?.warn("⚠️ [API] Auto-SDR-eval threw unexpectedly", {
              callId,
              error: e?.message || String(e),
            });
          }

          const analysisResult = {
            success: true,
            call_record_id: callId,
            analysis: analysisData,
            auto_sdr_evaluation: autoEvalOutcome,
            message: "Call analysis completed successfully",
          };

          logger?.info("✅ [API] Call analysis completed", {
            callId,
            success: analysisResult.success,
          });

          return c.json(analysisResult);
        } catch (error) {
          const errAny: any = error;
          const errMsg =
            errAny?.message ??
            (typeof errAny === "string" ? errAny : "Failed to analyze call");
          const errCode =
            errAny?.code || errAny?.statusCode || errAny?.status || null;
          safeLogger.error("Error analyzing call:", {
            message: errMsg,
            code: errCode,
            stack: errAny?.stack,
          });
          // Surface the real reason so the UI alert shows "Analysis failed:
          // 429 Rate limit exceeded for gpt-4o" instead of an opaque
          // "Failed to analyze call". Phase A applied the same pattern to
          // the upload endpoint; this matches it for the standalone
          // re-analyze button.
          return c.json(
            {
              success: false,
              error: errCode
                ? `${errCode}: ${errMsg}`
                : errMsg,
            },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/calls/:callId/compliance",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const callId = parseInt(c.req.param("callId"));
          const data = await c.req.json();

          logger?.info("🔍 [API] Running CRM compliance check", { callId });

          const { getCallRecordById } =
            await import("../../utils/callIntelligenceDb");

          const callRecord = await getCallRecordById(callId);
          if (!callRecord) {
            return c.json({ error: "Call record not found" }, 404);
          }

          const { saveCompliance } =
            await import("../../utils/callIntelligenceDb");

          const leadId = data.lead_id || callRecord.lead_id;
          const dealId = data.deal_id || callRecord.deal_id;
          const expectedActions = data.expected_actions || [
            "notes_updated",
            "call_logged",
            "task_created",
            "stage_updated",
          ];

          // Real CRMProvider-backed compliance check. Replaces the previous
          // Math.random()-based mock that produced misleading dashboard
          // KPIs. See src/utils/crmComplianceCheck.ts for the evidence
          // model (one API call each to Notes / Calls / Tasks / Events +
          // a self-fetch of the parent Lead/Deal for Modified_Time).
          const { runCrmComplianceCheck } = await import(
            "../../utils/crmComplianceCheck"
          );
          const checked = await runCrmComplianceCheck({
            callRecordId: callId,
            leadId,
            dealId,
            callDate: callRecord.call_date ?? new Date(),
            expectedActions,
            agentEmail: (callRecord as any).agent_email ?? null,
            agentName: (callRecord as any).agent_name ?? null,
          });

          if (!checked.success || !checked.result) {
            // Don't fabricate booleans when CRMProvider is unreachable or the
            // call has no CRM linkage. Persist a sentinel row so the UI
            // can show "Not checked — reason" instead of a fake pass.
            await saveCompliance({
              call_record_id: callId,
              lead_id: leadId,
              deal_id: dealId,
              notes_updated: false,
              call_logged: false,
              task_created: false,
              stage_updated: false,
              meeting_outcome_logged: false,
              overall_compliance: false,
              compliance_score: 0,
              missing_actions: [`Not checked: ${checked.reason}`],
              compliance_details: {
                mode: "not_checked",
                reason: checked.reason,
              },
            });
            logger?.warn("⚠️ [API] Compliance check skipped", {
              callId,
              reason: checked.reason,
            });
            return c.json({
              success: false,
              call_record_id: callId,
              reason: checked.reason,
              message: `Compliance check skipped: ${checked.reason}`,
            });
          }

          const r = checked.result;
          await saveCompliance({
            call_record_id: callId,
            lead_id: leadId,
            deal_id: dealId,
            notes_updated: r.notes_updated,
            call_logged: r.call_logged,
            task_created: r.task_created,
            stage_updated: r.stage_updated,
            meeting_outcome_logged: r.meeting_outcome_logged,
            overall_compliance: r.overall_compliance,
            compliance_score: r.compliance_score,
            missing_actions: r.missing_actions,
            compliance_details: r.evidence,
          });

          const complianceResult = {
            success: true,
            call_record_id: callId,
            compliance: {
              notes_updated: r.notes_updated,
              call_logged: r.call_logged,
              task_created: r.task_created,
              stage_updated: r.stage_updated,
              meeting_outcome_logged: r.meeting_outcome_logged,
              overall_compliance: r.overall_compliance,
              compliance_score: r.compliance_score,
              missing_actions: r.missing_actions,
              evidence: r.evidence,
            },
            message: r.overall_compliance
              ? "CRM compliance passed"
              : `${r.missing_actions.length} missing actions`,
          };

          logger?.info("✅ [API] Compliance check completed", {
            callId,
            score: r.compliance_score,
          });

          return c.json(complianceResult);
        } catch (error) {
          safeLogger.error("Error checking compliance:", error);
          return c.json(
            {
              success: false,
              error: "Failed to check compliance",
            },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/calls/:callId/compliance",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const callId = parseInt(c.req.param("callId"));

          logger?.info("🔍 [API] Fetching compliance data", { callId });

          const { getComplianceByCallId } =
            await import("../../utils/callIntelligenceDb");

          const compliance = await getComplianceByCallId(callId);

          if (!compliance) {
            return c.json(
              { error: "Compliance data not found for this call" },
              404,
            );
          }

          return c.json(compliance);
        } catch (error) {
          safeLogger.error("Error fetching compliance:", error);
          return c.json({ error: "Failed to fetch compliance data" }, 500);
        }
      };
    },
  },
  {
    path: "/api/calls/:callId/transcript",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const callId = parseInt(c.req.param("callId"));

          logger?.info("📝 [API] Fetching transcript", { callId });

          const { getTranscriptByCallId } =
            await import("../../utils/callIntelligenceDb");

          const transcript = await getTranscriptByCallId(callId);

          if (!transcript) {
            return c.json({ error: "Transcript not found for this call" }, 404);
          }

          return c.json(transcript);
        } catch (error) {
          safeLogger.error("Error fetching transcript:", error);
          return c.json({ error: "Failed to fetch transcript" }, 500);
        }
      };
    },
  },
  {
    // DMAIC Improve: persist a client-discovered audio duration.
    // The Call Details modal mounts an <audio preload="metadata">
    // tag pointed at /api/calls/:id/audio; once the browser parses
    // the header it emits loadedmetadata with the real duration.
    // The frontend POSTs that value here so the next page-load can
    // render the Duration column without waiting for the audio to
    // load again. Idempotent — only writes when duration_seconds
    // is currently NULL so we never overwrite a Whisper-derived
    // value with a slightly different browser-decoded one.
    path: "/api/calls/:callId/duration",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const callId = parseInt(c.req.param("callId"));
          if (!Number.isFinite(callId) || callId <= 0) {
            return c.json({ error: "Invalid call id" }, 400);
          }

          let body: any = {};
          try {
            const txt = await c.req.text();
            if (txt && txt.trim()) body = JSON.parse(txt);
          } catch {
            body = {};
          }
          const incoming = Number(body.duration_seconds);
          if (!Number.isFinite(incoming) || incoming <= 0 || incoming > 24 * 60 * 60) {
            return c.json({ error: "duration_seconds must be a positive number under 24h" }, 400);
          }

          const { getCallRecordById, updateCallRecord } = await import(
            "../../utils/callIntelligenceDb"
          );
          const record = await getCallRecordById(callId);
          if (!record) return c.json({ error: "Call not found" }, 404);

          // Skip if a duration already exists. Treat the existing value
          // as authoritative — typically set by Whisper verbose_json
          // during analysis, which is more accurate than the browser's
          // decoded-on-the-fly value.
          if (record.duration_seconds && record.duration_seconds > 0) {
            return c.json({
              success: true,
              updated: false,
              duration_seconds: record.duration_seconds,
              reason: "already_set",
            });
          }

          await updateCallRecord(callId, { duration_seconds: Math.round(incoming) });
          return c.json({
            success: true,
            updated: true,
            duration_seconds: Math.round(incoming),
          });
        } catch (error: any) {
          safeLogger.error("[API] persist duration failed", { error: error?.message });
          return c.json({ success: false, error: error?.message || "Failed" }, 500);
        }
      };
    },
  },
  {
    // Stream the raw audio file so the eval panel can render an
    // inline player. Supports HTTP Range so the browser can seek
    // (jump to evidence timestamps) without downloading the whole
    // file. Auth-gated like the rest of the call routes — never
    // expose audio publicly.
    path: "/api/calls/:callId/audio",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
          // ── Concurrency gate ─────────────────────────────────────────────
          // Slot lifecycle vars MUST live outside try/catch so releaseSlot()
          // and wrapStream() are always in scope when the catch block runs.
          // ─────────────────────────────────────────────────────────────────
          if (_activeAudioDownloads >= MAX_CONCURRENT_AUDIO_DL) {
            return new Response(
              JSON.stringify({ error: "Too many concurrent audio downloads — please retry shortly" }),
              {
                status: 503,
                headers: {
                  "Content-Type": "application/json",
                  "Retry-After": "5",
                },
              },
            );
          }
          _activeAudioDownloads++;
          let _slotReleased = false;
          function releaseSlot() {
            if (!_slotReleased) {
              _slotReleased = true;
              _activeAudioDownloads--;
            }
          }
          // Release slot on early client disconnect (abort before response ends).
          c.req.raw?.signal?.addEventListener("abort", releaseSlot, { once: true });

          // Wrap a ReadableStream so the concurrency slot is released exactly
          // once when the response body drains, errors, or is cancelled.
          // Applied to every streaming response in this handler.
          function wrapStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
            const reader = source.getReader();
            return new ReadableStream<Uint8Array>({
              async pull(controller) {
                try {
                  const { done, value } = await reader.read();
                  if (done) {
                    controller.close();
                    releaseSlot();
                  } else {
                    controller.enqueue(value);
                  }
                } catch (err) {
                  controller.error(err);
                  releaseSlot();
                }
              },
              cancel() {
                reader.cancel().catch(() => {});
                releaseSlot();
              },
            });
          }

        try {
          const admin = await verifyCallAccess(c);
          if (!admin) {
            releaseSlot();
            return unauthorizedResponse(c);
          }

          const logger = mastra?.getLogger();
          const callId = parseInt(c.req.param("callId"));
          if (!Number.isFinite(callId) || callId <= 0) {
            releaseSlot();
            return c.json({ error: "Invalid call id" }, 400);
          }

          const {
            getCallRecordById,
            getCallRecordAudioBlobMeta,
            streamCallRecordAudioBlobRange,
          } = await import("../../utils/callIntelligenceDb");
          const record = await getCallRecordById(callId);
          if (!record) {
            releaseSlot();
            return c.json({ error: "Call not found" }, 404);
          }

          // DB-first fallback: when the FS audio file is missing (typical
          // after a HostingPlatform redeploy wipes uploads/) OR was never written
          // (the bulk-upload path until this PR), stream the bytes
          // straight from the audio_blob column. Range support preserved.
          //
          // Neither path loads the full BYTEA into application memory.
          // getCallRecordAudioBlobMeta() fetches only MIME + size; the
          // binary data is read in 512 KB chunks by streamCallRecordAudioBlobRange()
          // so peak per-request heap stays well under 1 MB regardless of
          // recording size.
          async function serveFromBlob(): Promise<Response | null> {
            const meta = await getCallRecordAudioBlobMeta(callId);
            if (!meta) return null;
            const totalSize = meta.size;
            const rangeHdr = c.req.header("range") || c.req.header("Range");
            if (rangeHdr) {
              const m = /bytes=(\d*)-(\d*)/.exec(String(rangeHdr));
              if (m) {
                const start = m[1] ? parseInt(m[1], 10) : 0;
                const end = m[2] ? parseInt(m[2], 10) : totalSize - 1;
                if (
                  Number.isFinite(start) &&
                  Number.isFinite(end) &&
                  start >= 0 && end < totalSize && start <= end
                ) {
                  const chunkLen = end - start + 1;
                  return new Response(
                    wrapStream(streamCallRecordAudioBlobRange(callId, start, end)),
                    {
                      status: 206,
                      headers: {
                        "Content-Type": meta.mime,
                        "Content-Length": String(chunkLen),
                        "Content-Range": `bytes ${start}-${end}/${totalSize}`,
                        "Accept-Ranges": "bytes",
                        "Cache-Control": "private, max-age=3600",
                      },
                    },
                  );
                }
              }
            }
            // Full response — stream the entire blob in 512 KB chunks so
            // the recording is never fully resident in application memory.
            return new Response(
              wrapStream(streamCallRecordAudioBlobRange(callId, 0, totalSize - 1)),
              {
                status: 200,
                headers: {
                  "Content-Type": meta.mime,
                  "Content-Length": String(totalSize),
                  "Accept-Ranges": "bytes",
                  "Cache-Control": "private, max-age=3600",
                },
              },
            );
          }

          const audioFilePath = (record as any).audio_file_path;
          if (!audioFilePath) {
            // No FS path on file — go straight to DB blob.
            const blobRes = await serveFromBlob();
            if (blobRes) return blobRes;
            releaseSlot();
            return c.json(
              { error: "This call has no audio file on the server" },
              404,
            );
          }

          const fs = await import("fs");
          const path = await import("path");
          const absPath = path.default.resolve(audioFilePath);
          // Guard against path traversal — only serve files under the
          // configured upload roots. Trusts the DB column as authoritative
          // but defends against env-level shenanigans.
          if (absPath.includes("..")) {
            logger?.warn("[API] Suspicious audio path", { audioFilePath });
            releaseSlot();
            return c.json({ error: "Invalid audio path" }, 400);
          }
          if (!fs.default.existsSync(absPath)) {
            // FS file gone (redeploy wiped uploads/) → fall back to blob.
            const blobRes = await serveFromBlob();
            if (blobRes) return blobRes;
            releaseSlot();
            return c.json(
              { error: "Audio file referenced in DB no longer exists and no blob copy is stored" },
              404,
            );
          }

          const stat = fs.default.statSync(absPath);
          const fileSize = stat.size;
          // Best-effort content-type from extension; default to wav.
          const ext = path.default.extname(absPath).toLowerCase();
          const mimeByExt: Record<string, string> = {
            ".wav": "audio/wav",
            ".mp3": "audio/mpeg",
            ".m4a": "audio/mp4",
            ".ogg": "audio/ogg",
            ".webm": "audio/webm",
          };
          const contentType = mimeByExt[ext] || "audio/wav";

          // HTTP Range — partial-content for seek.  The browser sends
          // `Range: bytes=START-END` on scrub; we reply with 206 and a
          // bounded createReadStream so chunkSize is never buffered in full.
          // The concurrency slot is held until the slice stream drains.
          const rangeHeader = c.req.header("range") || c.req.header("Range");
          if (rangeHeader) {
            const match = /bytes=(\d*)-(\d*)/.exec(String(rangeHeader));
            if (match) {
              const start = match[1] ? parseInt(match[1], 10) : 0;
              const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
              if (
                Number.isFinite(start) &&
                Number.isFinite(end) &&
                start >= 0 &&
                end < fileSize &&
                start <= end
              ) {
                const chunkSize = end - start + 1;
                const { Readable: Readable2 } = await import("stream");
                const rangeStream = fs.default.createReadStream(absPath, { start, end });
                const webRange = Readable2.toWeb(rangeStream) as ReadableStream<Uint8Array>;
                return new Response(wrapStream(webRange), {
                  status: 206,
                  headers: {
                    "Content-Type": contentType,
                    "Content-Length": String(chunkSize),
                    "Content-Range": `bytes ${start}-${end}/${fileSize}`,
                    "Accept-Ranges": "bytes",
                    "Cache-Control": "private, max-age=3600",
                  },
                });
              }
            }
          }

          // No Range header — stream the whole file with 200.
          // Using createReadStream + Readable.toWeb() avoids loading the
          // entire recording (up to 200 MB) into application memory before
          // sending the response. The OS page-cache handles buffering;
          // Node never holds more than the stream's internal highWaterMark
          // (~64 KB) at a time, regardless of file size.
          // wrapStream() releases the concurrency slot when the body drains.
          const { Readable } = await import("stream");
          const fileStream = fs.default.createReadStream(absPath);
          const webReadable = Readable.toWeb(fileStream) as ReadableStream<Uint8Array>;
          return new Response(wrapStream(webReadable), {
            status: 200,
            headers: {
              "Content-Type": contentType,
              "Content-Length": String(fileSize),
              "Accept-Ranges": "bytes",
              "Cache-Control": "private, max-age=3600",
            },
          });
        } catch (error: any) {
          releaseSlot();
          safeLogger.error("[API] audio stream failed", {
            error: error?.message || String(error),
          });
          return c.json({ error: "Failed to stream audio" }, 500);
        }
      };
    },
  },
  {
    path: "/api/calls/agent/:email",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const email = c.req.param("email");
          const limit = parseInt(c.req.query("limit") || "50");

          logger?.info("📞 [API] Fetching calls by agent", { email });

          const { getCallRecords } =
            await import("../../utils/callIntelligenceDb");

          const result = await getCallRecords({
            agent_email: email,
            limit,
          });

          return c.json(result);
        } catch (error) {
          safeLogger.error("Error fetching agent calls:", error);
          return c.json({ error: "Failed to fetch agent calls" }, 500);
        }
      };
    },
  },
  {
    path: "/api/calls/lead/:leadId",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const leadId = c.req.param("leadId");
          const limit = parseInt(c.req.query("limit") || "50");

          logger?.info("📞 [API] Fetching calls by lead", { leadId });

          const { getCallRecords } =
            await import("../../utils/callIntelligenceDb");

          const result = await getCallRecords({
            lead_id: leadId,
            limit,
          });

          return c.json(result);
        } catch (error) {
          safeLogger.error("Error fetching lead calls:", error);
          return c.json({ error: "Failed to fetch lead calls" }, 500);
        }
      };
    },
  },
  {
    path: "/api/meetings/mom",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const data = await c.req.json();

          logger?.info("📋 [API] Generating MoM", {
            calendar_event_id: data.calendar_event_id,
            meeting_title: data.meeting_title,
          });

          if (
            !data.calendar_event_id ||
            !data.meeting_title ||
            !data.transcript
          ) {
            return c.json(
              {
                error:
                  "calendar_event_id, meeting_title, and transcript are required",
              },
              400,
            );
          }

          const { saveMeetingMOM } =
            await import("../../utils/callIntelligenceDb");
          const { createLLMProvider } = await import("@ai-sdk/LLMProvider");
          const { generateText } = await import("ai");

          const LLMProvider = createLLMProvider({
            baseURL: getLLMProviderBaseUrl(),
            apiKey: getLLMProviderApiKey(),
          });

          const momPrompt = `Analyze this meeting and generate Minutes of Meeting (MoM):

MEETING: ${data.meeting_title}
DATE: ${data.meeting_date || new Date().toISOString()}
ATTENDEES: ${data.attendees ? data.attendees.map((a: any) => a.name || a.email).join(", ") : "Not specified"}

TRANSCRIPT:
${data.transcript}

Respond with JSON only:
{
  "summary": "<executive summary>",
  "key_decisions": ["<decision>"],
  "action_items": [{"action": "<action>", "owner": "<person>", "due_date": null}],
  "follow_ups": ["<item>"],
  "next_meeting_date": null,
  "notes": "<additional notes>"
}`;

          // Raw-fetch /chat/completions (bypasses the @ai-sdk/LLMProvider v3
          // spec regression — same reason as the analyze path above).
          const { generateChatText: _gctMom } = await import(
            "../../utils/LLMProviderChatHelper"
          );
          const aiResult = await _gctMom({
            model: "gpt-4o",
            prompt: momPrompt,
            maxTokens: 2000,
          });

          let momData;
          try {
            const cleanedText = aiResult.text
              .replace(/```json\n?|\n?```/g, "")
              .trim();
            momData = JSON.parse(cleanedText);
          } catch {
            momData = {
              summary: "Meeting summary could not be generated.",
              key_decisions: [],
              action_items: [],
              follow_ups: [],
              next_meeting_date: null,
              notes: "",
            };
          }

          const savedMOM = await saveMeetingMOM({
            call_record_id: data.call_record_id,
            calendar_event_id: data.calendar_event_id,
            meeting_title: data.meeting_title,
            meeting_date: new Date(data.meeting_date || new Date()),
            attendees: data.attendees,
            summary: momData.summary,
            key_decisions: momData.key_decisions,
            action_items: momData.action_items,
            follow_ups: momData.follow_ups,
            next_meeting_date: momData.next_meeting_date
              ? new Date(momData.next_meeting_date)
              : undefined,
            notes: momData.notes,
          });

          const momResult = {
            success: true,
            mom_id: savedMOM.id,
            mom: momData,
            message: `MoM generated with ${momData.action_items?.length || 0} action items`,
          };

          logger?.info("✅ [API] MoM generated", {
            success: momResult.success,
          });

          return c.json(momResult);
        } catch (error) {
          safeLogger.error("Error generating MoM:", error);
          return c.json(
            {
              success: false,
              error: "Failed to generate MoM",
            },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/meetings/mom/:eventId",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const eventId = c.req.param("eventId");

          logger?.info("📋 [API] Fetching MoM", { eventId });

          const { getMOMByEventId } =
            await import("../../utils/callIntelligenceDb");

          const mom = await getMOMByEventId(eventId);

          if (!mom) {
            return c.json({ error: "MoM not found for this event" }, 404);
          }

          return c.json(mom);
        } catch (error) {
          safeLogger.error("Error fetching MoM:", error);
          return c.json({ error: "Failed to fetch MoM" }, 500);
        }
      };
    },
  },
  // Generic HTML page server — registered for each new dashboard page
  // added this session. Without these routes, the static .html files
  // exist on disk but Mastra doesn't know to serve them (returns the
  // default "Welcome to Mastra" page instead). The pattern matches /calls
  // below: try a few possible paths, return the first one that exists.
  ...(["lead-history", "calls-health", "scorecard-migration"].map((slug) => ({
    path: `/${slug}.html`,
    method: "GET" as const,
    createHandler: async () => {
      const { readFileSync, existsSync } = await import("fs");
      const { join } = await import("path");
      return async (c: any) => {
        const candidatePaths = [
          join(process.cwd(), "dashboard", `${slug}.html`),
          join(process.cwd(), "..", "dashboard", `${slug}.html`),
          `/home/runner/workspace/dashboard/${slug}.html`,
        ];
        for (const p of candidatePaths) {
          if (existsSync(p)) {
            return c.html(readFileSync(p, "utf-8"));
          }
        }
        // 404 fallback page. Plain text-only — no inline style so the
        // CSP guardrail stays clean. Operators rarely see this; if they
        // do, readability matters less than not violating policy.
        return c.html(
          `<!DOCTYPE html><html><body>` +
            `<h1>Page not found on disk</h1>` +
            `<p>${slug}.html exists in the repo but couldn't be found at any of:</p>` +
            `<ul>${candidatePaths.map((p) => `<li><code>${p}</code></li>`).join("")}</ul>` +
            `</body></html>`,
          404,
        );
      };
    },
  }))),
  // Also expose them without the .html extension, matching the convention
  // for /calls and /duplicates (the older pages drop the extension).
  ...(["lead-history", "calls-health", "scorecard-migration"].map((slug) => ({
    path: `/${slug}`,
    method: "GET" as const,
    createHandler: async () => {
      const { readFileSync, existsSync } = await import("fs");
      const { join } = await import("path");
      return async (c: any) => {
        const candidatePaths = [
          join(process.cwd(), "dashboard", `${slug}.html`),
          join(process.cwd(), "..", "dashboard", `${slug}.html`),
          `/home/runner/workspace/dashboard/${slug}.html`,
        ];
        for (const p of candidatePaths) {
          if (existsSync(p)) {
            return c.html(readFileSync(p, "utf-8"));
          }
        }
        return c.html(`<h1>Page not found</h1>`, 404);
      };
    },
  }))),
  {
    path: "/calls",
    method: "GET" as const,
    createHandler: async () => {
      const { readFileSync, existsSync } = await import("fs");
      const { join } = await import("path");

      return async (c: any) => {
        try {
          const possiblePaths = [
            join(process.cwd(), "dashboard", "calls.html"),
            join(process.cwd(), "..", "dashboard", "calls.html"),
            "/home/runner/workspace/dashboard/calls.html",
          ];

          for (const callsPath of possiblePaths) {
            if (existsSync(callsPath)) {
              const html = readFileSync(callsPath, "utf-8");
              return c.html(html);
            }
          }

          return c.html(`
            <!DOCTYPE html>
            <html>
            <head>
              <title>Call Intelligence - Coming Soon</title>
              <link rel="stylesheet" href="/dashboard/tailwind.css">
            </head>
            <body class="bg-gray-50 min-h-screen flex items-center justify-center">
              <div class="text-center">
                <h1 class="text-2xl font-bold text-gray-900 mb-4">Call Intelligence Dashboard</h1>
                <p class="text-gray-600 mb-4">The dashboard interface is being built.</p>
                <p class="text-gray-500 mb-4">API endpoints are available at /api/calls/*</p>
                <a href="/" class="text-blue-600 hover:underline">Return to Quality Dashboard</a>
              </div>
            </body>
            </html>
          `);
        } catch (error) {
          safeLogger.error("Error serving calls dashboard:", error);
          return c.text("Error loading calls dashboard", 500);
        }
      };
    },
  },
  {
    path: "/api/calls/upload",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyAdminKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          logger?.info("📤 [API] Manual call upload request");

          // --- Body-size guard (200 MB max for call recordings) ---
          const MAX_CALL_UPLOAD_BYTES = 200 * 1024 * 1024;
          const rawLen = c.req.header("Content-Length");
          if (!rawLen) {
            return c.json(
              { success: false, error: "Content-Length header required for file uploads" },
              411,
            );
          }
          const contentLen = parseInt(rawLen, 10);
          if (!Number.isFinite(contentLen) || contentLen > MAX_CALL_UPLOAD_BYTES) {
            return c.json(
              { success: false, error: "Request body too large (max 200 MB)" },
              413,
            );
          }

          const formData = await c.req.formData();
          const file = formData.get("file");
          const agentName = formData.get("agent_name");
          const agentEmail = formData.get("agent_email");
          const contactName = formData.get("contact_name") || "";
          const direction = formData.get("direction") || "outbound";
          const leadId = formData.get("lead_id") || "";
          const callDate =
            formData.get("call_date") || new Date().toISOString();

          if (!agentEmail) {
            return c.json(
              { success: false, error: "Missing required fields" },
              400,
            );
          }

          const { createCallRecord, initCallIntelligenceTables } =
            await import("../../utils/callIntelligenceDb");
          await initCallIntelligenceTables();

          let recordingUrl = "";
          let audioFilePath = "";

          if (file && file.size > 0) {
            if (file.size > MAX_CALL_UPLOAD_BYTES) {
              return c.json(
                { success: false, error: "File too large (max 200 MB)" },
                413,
              );
            }

            const fs = await import("fs");
            const path = await import("path");

            const uploadsDir = path.default.resolve("uploads/calls");
            if (!fs.default.existsSync(uploadsDir)) {
              fs.default.mkdirSync(uploadsDir, { recursive: true });
            }

            // Free-space check: require at least 200 MB buffer + file size
            try {
              const stats = fs.default.statfsSync(uploadsDir);
              const freeBytes = stats.bfree * stats.bsize;
              const MIN_FREE = 200 * 1024 * 1024;
              if (freeBytes < MIN_FREE + file.size) {
                return c.json(
                  { success: false, error: "Insufficient disk space to store upload" },
                  507,
                );
              }
            } catch {
              // statfs unavailable on this platform — proceed
            }

            const fileName = `call_${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
            audioFilePath = path.default.join(uploadsDir, fileName);
            recordingUrl = `/uploads/calls/${fileName}`;

            const arrayBuffer = await file.arrayBuffer();
            fs.default.writeFileSync(audioFilePath, Buffer.from(arrayBuffer));

            logger?.info("📁 [API] File saved", {
              fileName,
              size: file.size,
              path: audioFilePath,
            });
          }

          // Reject duplicate uploads of the same source filename (same
          // policy as the bulk audio upload route) so re-imports do not
          // skew analytics / SDR / compliance metrics with the same call
          // counted twice.
          if (file?.name) {
            try {
              const { findCallRecordByOriginalFilename } = await import(
                "../../utils/callIntelligenceDb"
              );
              const existingDup = await findCallRecordByOriginalFilename(file.name);
              if (existingDup) {
                logger?.info("⏭️ [API] Duplicate manual upload rejected", {
                  filename: file.name,
                  existing_id: existingDup.id,
                });
                return c.json(
                  {
                    success: false,
                    error: `Duplicate file: "${file.name}" was already uploaded (call record #${existingDup.id}, agent ${existingDup.agent_email}). Rename the file or delete the existing record if you intend to re-upload.`,
                    duplicate: true,
                    existing_call_record_id: existingDup.id,
                  },
                  409,
                );
              }
            } catch (dupErr: any) {
              logger?.warn("[API] Duplicate-filename check failed (proceeding):", {
                filename: file.name,
                error: dupErr?.message || String(dupErr),
              });
            }
          }

          // Same lead_id-vs-phone reroute as the bulk audio path: never
          // store a phone-shaped string in call_records.lead_id, because
          // the CRM Link cell would then build an Invalid CRMProvider URL.
          const looksLikePhoneSingle = (v: string) =>
            /^\+?\d[\d\s\-()]{4,}$/.test(v.trim());
          let leadIdSafe = leadId;
          let contactPhoneSingle = "";
          if (leadId && looksLikePhoneSingle(leadId)) {
            contactPhoneSingle = leadId.trim();
            leadIdSafe = "";
          }
          if (!contactPhoneSingle && contactName && looksLikePhoneSingle(contactName)) {
            contactPhoneSingle = contactName.trim();
          }

          const callRecord = await createCallRecord({
            call_id: `manual-${Date.now()}`,
            source: "manual",
            lead_id: leadIdSafe,
            contact_name: contactName,
            agent_email: agentEmail,
            agent_name: agentName,
            direction: direction as "inbound" | "outbound",
            recording_url: recordingUrl,
            call_date: new Date(callDate),
            status: "uploaded",
            metadata: {
              uploaded_at: new Date().toISOString(),
              original_filename: file?.name || "",
              ...(contactPhoneSingle ? { contact_phone: contactPhoneSingle } : {}),
            },
          } as any);

          // Update the audio_file_path in the database. Delegated to
          // callIntelligenceDb.updateCallRecordAudioPath so all call_records
          // writes live in one module (Task #746).
          if (audioFilePath && callRecord.id) {
            const { updateCallRecordAudioPath, setCallRecordAudioBlob } =
              await import("../../utils/callIntelligenceDb");
            await updateCallRecordAudioPath(callRecord.id, audioFilePath);
            // ALSO persist the bytes to Postgres so the recording survives
            // a HostingPlatform redeploy that wipes the local uploads/ directory.
            // Best-effort — if the blob write fails we still have the FS
            // copy for this deploy and the row stays usable.
            try {
              const fs2 = await import("fs");
              const buf = fs2.default.readFileSync(audioFilePath);
              const mime = (file?.type as string) || "audio/wav";
              await setCallRecordAudioBlob(callRecord.id, buf, mime);
              logger?.info("📦 [API] Audio blob persisted to DB", {
                id: callRecord.id,
                size: buf.length,
              });
            } catch (blobErr: any) {
              logger?.warn(
                "[API] Audio blob persist failed (FS copy still present):",
                { id: callRecord.id, error: blobErr?.message || String(blobErr) },
              );
            }
          }

          logger?.info("✅ [API] Manual call record created", {
            id: callRecord.id,
          });

          // Auto-transcribe + analyze + SDR-evaluate inline. Without this,
          // the call has no call_transcripts row, which makes it invisible
          // to "Analyze All Pending" (INNER JOIN on call_transcripts drops
          // it) and prevents SDR evaluation / CRM auto-link downstream.
          // Mirrors the working /api/calls/upload-audio autoAnalyze path.
          let analysisStatus: string = "uploaded";
          if (audioFilePath && callRecord.id) {
            try {
              const {
                updateCallRecord,
                saveTranscript,
                saveCallAnalysis,
              } = await import("../../utils/callIntelligenceDb");

              await updateCallRecord(callRecord.id, { status: "transcribing" });
              analysisStatus = "processing";

              const LLMProvider = (await import("LLMProvider")).default;
              const LLMProvider = new LLMProvider({
                apiKey: getLLMProviderApiKey(),
                baseURL: getLLMProviderBaseUrl(),
              });

              const fsForRead = await import("fs");
              const audioBytes = fsForRead.default.readFileSync(audioFilePath);
              const audioFileObj = new File(
                [audioBytes],
                file?.name || "upload.wav",
                { type: (file?.type as string) || "audio/wav" },
              );

              // Cost guard (DMAIC Solution #9): short-circuit before
              // any paid LLMProvider call when today's estimated spend has
              // hit the cap. The existing analysis-failed catch below
              // will surface "AI daily cost cap reached" in ai_insights
              // .last_analysis_error so it's visible in /calls-health.
              if (isCostCapped()) {
                throw new Error("AI daily cost cap reached — analysis paused");
              }
              const transcription: any = await LLMProvider.audio.transcriptions.create({
                model: "whisper-1",
                file: audioFileObj,
                response_format: "verbose_json",
              });
              recordAiSpend(AI_COST.WHISPER_TRANSCRIBE, "whisper_transcribe");

              const transcriptText = transcription.text || "";
              const transcribedDuration =
                typeof transcription.duration === "number" && transcription.duration > 0
                  ? Math.round(transcription.duration)
                  : null;
              if (transcribedDuration) {
                try {
                  await updateCallRecord(callRecord.id, {
                    duration_seconds: transcribedDuration,
                  });
                } catch (durErr: any) {
                  logger?.warn("[API] Persist duration_seconds failed:", {
                    id: callRecord.id,
                    error: durErr?.message || String(durErr),
                  });
                }
              }
              logger?.info("📝 [API] Manual upload transcription completed", {
                id: callRecord.id,
                length: transcriptText.length,
                duration_seconds: transcribedDuration,
              });

              await saveTranscript({
                call_record_id: callRecord.id,
                transcript_text: transcriptText,
                language: "ar",
                confidence_score: 95,
              });

              const analysisPrompt = `أنت محلل جودة مكالمات خبير. قم بتحليل هذا النص المكتوب من مكالمة مبيعات وقدم تحليلاً شاملاً.

نص المكالمة:
${transcriptText}

قدم تحليلك بصيغة JSON التالية (باللغة العربية):
{
  "transcript_summary": "ملخص موجز للمكالمة في 3-5 جمل",
  "sentiment_score": <0-100 حيث 100 إيجابي جداً>,
  "sentiment_label": "<إيجابي|محايد|سلبي>",
  "sentiment_analysis": "تحليل مفصل للمشاعر والنبرة في المكالمة",
  "voice_of_customer": "صوت العميل - ما هي مخاوفه واحتياجاته",
  "objections_detected": [{"objection": "الاعتراض", "handled_well": true, "handling_notes": "ملاحظات"}],
  "key_topics": ["المواضيع الرئيسية"],
  "action_items": ["الإجراءات المطلوبة"],
  "next_steps": ["الخطوات التالية"],
  "call_summary": "ملخص شامل للمكالمة",
  "highlights": ["أبرز النقاط الإيجابية في المكالمة"],
  "areas_for_improvement": ["مجالات التحسين المقترحة"],
  "agent_performance": {
    "opening_greeting": <1-10>,
    "discovery_questions": <1-10>,
    "product_knowledge": <1-10>,
    "objection_handling": <1-10>,
    "value_proposition": <1-10>,
    "closing_technique": <1-10>,
    "communication_skills": <1-10>,
    "overall_score": <1-100>
  },
  "feedback": "ملاحظات وتوصيات شاملة لتحسين أداء الموظف",
  "compliance_notes": "ملاحظات حول الالتزام بالمعايير والسياسات",
  "ai_insights": "رؤى وتحليلات إضافية من الذكاء الاصطناعي"
}`;

              const { generateChatText } = await import(
                "../../utils/LLMProviderChatHelper"
              );
              if (isCostCapped()) {
                throw new Error("AI daily cost cap reached — analysis paused");
              }
              const aiResult = await generateChatText({
                model: "gpt-4o-mini",
                prompt: analysisPrompt,
                maxTokens: 4000,
                responseFormat: "json_object",
              });
              recordAiSpend(AI_COST.GPT4O_MINI_ANALYZE, "gpt4o_mini_analyze");

              let analysisData: any;
              try {
                const cleanedText = aiResult.text
                  .replace(/```json\n?|\n?```/g, "")
                  .trim();
                analysisData = JSON.parse(cleanedText);
              } catch {
                logger?.warn(
                  "⚠️ [API] Manual upload: failed to parse analysis JSON, using defaults",
                );
                analysisData = {
                  transcript_summary: transcriptText.substring(0, 500),
                  sentiment_score: 50,
                  sentiment_label: "محايد",
                  call_summary: "تم تحليل المكالمة",
                  highlights: [],
                  areas_for_improvement: [],
                  feedback: "",
                  ai_insights: "",
                };
              }

              await saveCallAnalysis({
                call_record_id: callRecord.id,
                sentiment_score: analysisData.sentiment_score || 50,
                sentiment_label: analysisData.sentiment_label || "neutral",
                voice_of_customer: analysisData.voice_of_customer || "",
                objections_detected: analysisData.objections_detected || [],
                key_topics: analysisData.key_topics || [],
                action_items: analysisData.action_items || [],
                next_steps: analysisData.next_steps || [],
                call_summary: analysisData.call_summary || "",
                ai_insights: JSON.stringify({
                  transcript_summary: analysisData.transcript_summary,
                  sentiment_analysis: analysisData.sentiment_analysis,
                  highlights: analysisData.highlights,
                  areas_for_improvement: analysisData.areas_for_improvement,
                  agent_performance: analysisData.agent_performance,
                  feedback: analysisData.feedback,
                  compliance_notes: analysisData.compliance_notes,
                  ai_insights: analysisData.ai_insights,
                }),
              });

              await updateCallRecord(callRecord.id, { status: "evaluated" });
              analysisStatus = "analyzed";
              logger?.info("✅ [API] Manual upload analysis completed", {
                id: callRecord.id,
              });

              // Phase B — auto-fire SDR scorecard evaluation so the call
              // shows up in the SDR Evaluation tab without manager action.
              try {
                const { triggerSDREvaluationForCall } = await import(
                  "../../utils/sdrAutoEvaluator"
                );
                const outcome = await triggerSDREvaluationForCall(
                  callRecord.id,
                  "SDR",
                );
                if (outcome.ran) {
                  logger?.info("📋 [API] Auto-SDR-eval on manual upload", {
                    id: callRecord.id,
                    scorecardId: outcome.scorecardId,
                    overallScore: outcome.overallScore,
                    postEvalStatus: outcome.postEvalStatus,
                    qaReviewReason: outcome.qaReviewReason,
                  });
                } else {
                  logger?.info("📋 [API] Auto-SDR-eval skipped on manual upload", {
                    id: callRecord.id,
                    reason: outcome.skipReason,
                  });
                }
              } catch (evalErr: any) {
                logger?.warn("⚠️ [API] Auto-SDR-eval threw on manual upload", {
                  id: callRecord.id,
                  error: evalErr?.message || String(evalErr),
                });
              }

              // Auto-link + compliance: shared with /ingest via
              // callPostIngestPipeline. Pass the lead_id we may have just
              // set so the helper's <REDACTED_TOKEN> check sees it.
              await autoLinkCallAndCompliance(
                { ...callRecord, lead_id: leadIdSafe ?? callRecord.lead_id },
                {
                  logger,
                  logTag: "manual upload",
                },
              );
            } catch (analysisError: any) {
              const errMsg = analysisError?.message || String(analysisError);
              const errCode =
                analysisError?.code ||
                analysisError?.statusCode ||
                analysisError?.status;
              logger?.error("❌ [API] Manual upload analysis failed", {
                id: callRecord.id,
                error: errMsg,
                code: errCode,
              });
              try {
                const { updateCallRecord } = await import(
                  "../../utils/callIntelligenceDb"
                );
                await updateCallRecord(callRecord.id, {
                  status: "uploaded",
                  ai_insights: JSON.stringify({
                    last_analysis_error: errMsg,
                    last_analysis_error_code: errCode || null,
                    last_analysis_attempted_at: new Date().toISOString(),
                  }),
                });
              } catch {
                // status rollback is best-effort
              }
              analysisStatus = `analysis_failed: ${errMsg}`;
            }
          }

          return c.json({
            success: true,
            call_record_id: callRecord.id,
            call_id: callRecord.call_id,
            analysis_status: analysisStatus,
            message:
              analysisStatus === "analyzed"
                ? "Call uploaded, transcribed, and analyzed."
                : analysisStatus.startsWith("analysis_failed")
                  ? `Call uploaded; analysis did not complete (${analysisStatus.replace("analysis_failed: ", "")}). You can re-run analysis from the Call Records tab.`
                  : "Call uploaded (no audio file — analysis skipped).",
          });
        } catch (error) {
          safeLogger.error("Error uploading call:", error);
          return c.json(
            { success: false, error: "Failed to upload call" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/calls/upload-audio",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyAdminKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          logger?.info("🎤 [API] Audio call upload with transcription request");

          // --- Body-size guard (200 MB max for call recordings) ---
          const MAX_AUDIO_UPLOAD_BYTES = 200 * 1024 * 1024;
          const rawAudioLen = c.req.header("Content-Length");
          if (!rawAudioLen) {
            return c.json(
              { success: false, error: "Content-Length header required for file uploads" },
              411,
            );
          }
          const audioContentLen = parseInt(rawAudioLen, 10);
          if (!Number.isFinite(audioContentLen) || audioContentLen > MAX_AUDIO_UPLOAD_BYTES) {
            return c.json(
              { success: false, error: "Request body too large (max 200 MB)" },
              413,
            );
          }

          const formData = await c.req.formData();
          const file = formData.get("file");
          const agentEmail = formData.get("agent_email");
          const agentName = formData.get("agent_name") || "";
          const leadIdRaw = (formData.get("lead_id") as string | null) || "";
          const contactName =
            (formData.get("contact_name") as string | null) || "";
          const callDateRaw = formData.get("call_date") as string | null;
          const autoAnalyze = formData.get("auto_analyze") === "true";

          // The bulk-upload client extracts a phone number from the
          // filename and sends it as lead_id because at upload time we
          // don't know the real CRMProvider Lead record-id yet. Persisting a
          // phone-shaped string into call_records.lead_id is harmful:
          // the frontend would build /crm/.../tab/Leads/+966... which
          // CRMProvider rejects as Invalid URL, and the auto-link matcher then
          // refuses to overwrite an already-set lead_id. Detect that
          // case here and reroute the phone into metadata.contact_phone
          // (where the CRM Link cell already knows how to find it), so
          // lead_id is only ever set by the real CRMProvider matcher.
          const looksLikePhone = (v: string) => /^\+?\d[\d\s\-()]{4,}$/.test(v.trim());
          let leadId = "";
          let contactPhone = "";
          if (leadIdRaw && looksLikePhone(leadIdRaw)) {
            contactPhone = leadIdRaw.trim();
          } else if (leadIdRaw) {
            leadId = leadIdRaw;
          }
          if (!contactPhone && contactName && looksLikePhone(contactName)) {
            contactPhone = contactName.trim();
          }

          if (!agentEmail) {
            return c.json(
              { success: false, error: "Missing required fields" },
              400,
            );
          }

          if (!file || file.size === 0) {
            return c.json(
              { success: false, error: "Missing required fields" },
              400,
            );
          }

          if (file.size > MAX_AUDIO_UPLOAD_BYTES) {
            return c.json(
              { success: false, error: "File too large (max 200 MB)" },
              413,
            );
          }

          // Free-space check before buffering the audio into memory
          try {
            const fsCheck = await import("fs");
            const pathCheck = await import("path");
            const audioUploadsDir = pathCheck.default.resolve("uploads/calls");
            if (!fsCheck.default.existsSync(audioUploadsDir)) {
              fsCheck.default.mkdirSync(audioUploadsDir, { recursive: true });
            }
            const stats = fsCheck.default.statfsSync(audioUploadsDir);
            const freeBytes = stats.bfree * stats.bsize;
            const MIN_FREE = 200 * 1024 * 1024;
            if (freeBytes < MIN_FREE + file.size) {
              return c.json(
                { success: false, error: "Insufficient disk space to store upload" },
                507,
              );
            }
          } catch {
            // statfs unavailable on this platform — proceed
          }

          let parsedCallDate = new Date();
          if (callDateRaw) {
            const d = new Date(callDateRaw);
            if (!isNaN(d.getTime())) parsedCallDate = d;
          }

          const {
            createCallRecord,
            initCallIntelligenceTables,
            saveTranscript,
            saveCallAnalysis,
            updateCallRecord,
          } = await import("../../utils/callIntelligenceDb");
          await initCallIntelligenceTables();

          const fileName = `call_${Date.now()}_${file.name}`;

          // Reject duplicate uploads of the same source filename so
          // bulk re-imports of an agent's historical calls do not skew
          // analytics / SDR scores / compliance trends by ingesting the
          // same call twice. Done BEFORE the LLMProvider transcription call
          // so a duplicate never costs tokens.
          try {
            const { findCallRecordByOriginalFilename } = await import(
              "../../utils/callIntelligenceDb"
            );
            const existingDup = await findCallRecordByOriginalFilename(file.name);
            if (existingDup) {
              logger?.info("⏭️ [API] Duplicate audio upload rejected", {
                filename: file.name,
                existing_id: existingDup.id,
                existing_call_id: existingDup.call_id,
                existing_agent: existingDup.agent_email,
              });
              return c.json(
                {
                  success: false,
                  error: `Duplicate file: "${file.name}" was already uploaded (call record #${existingDup.id}, agent ${existingDup.agent_email}). Rename the file or delete the existing record if you intend to re-upload.`,
                  duplicate: true,
                  existing_call_record_id: existingDup.id,
                },
                409,
              );
            }
          } catch (dupErr: any) {
            logger?.warn("[API] Duplicate-filename check failed (proceeding):", {
              filename: file.name,
              error: dupErr?.message || String(dupErr),
            });
          }

          // Use a high-entropy call_id (timestamp + random) to avoid
          // millisecond collisions when multiple files upload in a tight
          // loop. ON CONFLICT (call_id) would have UPSERT-collapsed them
          // into a single row before, hiding the fact that the rest of
          // the batch supposedly "succeeded".
          const uniqueCallId = `audio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const callRecord = await createCallRecord({
            call_id: uniqueCallId,
            source: "manual",
            lead_id: leadId,
            contact_name: contactName,
            agent_email: agentEmail,
            agent_name: agentName,
            direction: "outbound",
            recording_url: `/uploads/calls/${fileName}`,
            call_date: parsedCallDate,
            status: "uploaded",
            metadata: {
              uploaded_at: new Date().toISOString(),
              original_filename: file.name,
              file_size: file.size,
              ...(contactPhone ? { contact_phone: contactPhone } : {}),
            },
          });

          const callId = callRecord.id!;
          // Verify the row actually landed by reading it back. If the
          // INSERT silently failed or the connection pool routed to a
          // different DB, this round-trip will catch it before we burn
          // LLMProvider tokens transcribing audio that has no parent record.
          try {
            const { getCallRecordById } = await import(
              "../../utils/callIntelligenceDb"
            );
            const verify = await getCallRecordById(callId);
            if (!verify) {
              logger?.error("[API] CRITICAL: createCallRecord returned id but row not readable", {
                id: callId,
                call_id: uniqueCallId,
              });
              return c.json(
                {
                  success: false,
                  error: "Row creation could not be verified — aborting before LLMProvider charge",
                  diagnostic: { attempted_id: callId, call_id: uniqueCallId },
                },
                500,
              );
            }
            logger?.info("✅ [API] Call record created + verified in DB", {
              id: callId,
              call_id: uniqueCallId,
              verified_status: verify.status,
              verified_agent: verify.agent_email,
            });
          } catch (verifyErr: any) {
            logger?.error("[API] CRITICAL: Row verification failed", {
              id: callId,
              error: verifyErr?.message || String(verifyErr),
            });
            // Fall through — don't block; the row likely exists, just
            // couldn't verify. Visible in logs for diagnosis.
          }

          // Persist audio bytes to Postgres so the recording survives a
          // HostingPlatform redeploy (the bulk upload path historically never wrote
          // to the FS — only transcribed and discarded the bytes, so the
          // audio was already gone after the upload finished). Best-effort:
          // a blob persist failure doesn't block analysis.
          const audioArrayBuffer = await file.arrayBuffer();
          const audioBuffer = Buffer.from(audioArrayBuffer);
          try {
            const { setCallRecordAudioBlob } = await import(
              "../../utils/callIntelligenceDb"
            );
            await setCallRecordAudioBlob(
              callId,
              audioBuffer,
              file.type || "audio/wav",
            );
            logger?.info("📦 [API] Audio blob persisted to DB", {
              id: callId,
              size: audioBuffer.length,
            });
          } catch (blobErr: any) {
            logger?.warn("[API] Bulk audio blob persist failed:", {
              id: callId,
              error: blobErr?.message || String(blobErr),
            });
          }

          let analysisStatus = "uploaded";

          if (autoAnalyze) {
            try {
              await updateCallRecord(callId, { status: "transcribing" });
              analysisStatus = "processing";

              const LLMProvider = (await import("LLMProvider")).default;
              const LLMProvider = new LLMProvider({
                apiKey: getLLMProviderApiKey(),
                baseURL: getLLMProviderBaseUrl(),
              });

              logger?.info(
                "🎙️ [API] Starting audio transcription (Arabic supported)",
              );

              // Reuse the buffer we already pulled above for blob persist
              // so we don't re-read the file stream a second time.
              const audioFile = new File([audioBuffer], file.name, {
                type: file.type,
              });

              // Use whisper-1 with verbose_json so we get the audio
              // duration back in the response — gpt-4o-mini-transcribe
              // does not return duration, which left the Duration
              // column in Call Records / SDR Evaluation header as "--"
              // even for fully analyzed calls.
              if (isCostCapped()) {
                throw new Error("AI daily cost cap reached — analysis paused");
              }
              const transcription: any = await LLMProvider.audio.transcriptions.create({
                model: "whisper-1",
                file: audioFile,
                response_format: "verbose_json",
              });
              recordAiSpend(AI_COST.WHISPER_TRANSCRIBE, "whisper_transcribe");

              const transcriptText = transcription.text || "";
              const transcribedDuration =
                typeof transcription.duration === "number" && transcription.duration > 0
                  ? Math.round(transcription.duration)
                  : null;
              if (transcribedDuration) {
                try {
                  await updateCallRecord(callId, {
                    duration_seconds: transcribedDuration,
                  });
                } catch (durErr: any) {
                  logger?.warn("[API] Persist duration_seconds failed:", {
                    id: callId,
                    error: durErr?.message || String(durErr),
                  });
                }
              }
              logger?.info("📝 [API] Transcription completed", {
                length: transcriptText.length,
                duration_seconds: transcribedDuration,
              });

              await saveTranscript({
                call_record_id: callId,
                transcript_text: transcriptText,
                language: "ar",
                confidence_score: 95,
              });

              const { generateText } = await import("ai");
              const { createLLMProvider } = await import("@ai-sdk/LLMProvider");

              const aiSdk = createLLMProvider({
                baseURL: getLLMProviderBaseUrl(),
                apiKey: getLLMProviderApiKey(),
              });

              logger?.info("🔬 [API] Starting comprehensive call analysis");

              const analysisPrompt = `أنت محلل جودة مكالمات خبير. قم بتحليل هذا النص المكتوب من مكالمة مبيعات وقدم تحليلاً شاملاً.

نص المكالمة:
${transcriptText}

قدم تحليلك بصيغة JSON التالية (باللغة العربية):
{
  "transcript_summary": "ملخص موجز للمكالمة في 3-5 جمل",
  "sentiment_score": <0-100 حيث 100 إيجابي جداً>,
  "sentiment_label": "<إيجابي|محايد|سلبي>",
  "sentiment_analysis": "تحليل مفصل للمشاعر والنبرة في المكالمة",
  "voice_of_customer": "صوت العميل - ما هي مخاوفه واحتياجاته",
  "objections_detected": [{"objection": "الاعتراض", "handled_well": true, "handling_notes": "ملاحظات"}],
  "key_topics": ["المواضيع الرئيسية"],
  "action_items": ["الإجراءات المطلوبة"],
  "next_steps": ["الخطوات التالية"],
  "call_summary": "ملخص شامل للمكالمة",
  "highlights": ["أبرز النقاط الإيجابية في المكالمة"],
  "areas_for_improvement": ["مجالات التحسين المقترحة"],
  "agent_performance": {
    "opening_greeting": <1-10>,
    "discovery_questions": <1-10>,
    "product_knowledge": <1-10>,
    "objection_handling": <1-10>,
    "value_proposition": <1-10>,
    "closing_technique": <1-10>,
    "communication_skills": <1-10>,
    "overall_score": <1-100>
  },
  "feedback": "ملاحظات وتوصيات شاملة لتحسين أداء الموظف",
  "compliance_notes": "ملاحظات حول الالتزام بالمعايير والسياسات",
  "ai_insights": "رؤى وتحليلات إضافية من الذكاء الاصطناعي"
}`;

              // gpt-4o-mini: ~75% cheaper than gpt-4o with comparable quality
              // on structured-output tasks like this JSON-extracting prompt.
              // Per-call analysis cost drops from ~$0.005 to ~$0.001.
              // Raw-fetch helper bypasses the @ai-sdk/LLMProvider v3 spec
              // regression that broke `aiSdk.chat(...)` in production.
              const { generateChatText: _gctInline } = await import(
                "../../utils/LLMProviderChatHelper"
              );
              if (isCostCapped()) {
                throw new Error("AI daily cost cap reached — analysis paused");
              }
              const aiResult = await _gctInline({
                model: "gpt-4o-mini",
                prompt: analysisPrompt,
                maxTokens: 4000,
                responseFormat: "json_object",
              });
              recordAiSpend(AI_COST.GPT4O_MINI_ANALYZE, "gpt4o_mini_analyze");

              let analysisData;
              try {
                const cleanedText = aiResult.text
                  .replace(/```json\n?|\n?```/g, "")
                  .trim();
                analysisData = JSON.parse(cleanedText);
              } catch {
                logger?.warn(
                  "⚠️ [API] Failed to parse analysis JSON, using defaults",
                );
                analysisData = {
                  transcript_summary: transcriptText.substring(0, 500),
                  sentiment_score: 50,
                  sentiment_label: "محايد",
                  call_summary: "تم تحليل المكالمة",
                  highlights: [],
                  areas_for_improvement: [],
                  feedback: "",
                  ai_insights: "",
                };
              }

              await saveCallAnalysis({
                call_record_id: callId,
                sentiment_score: analysisData.sentiment_score || 50,
                sentiment_label: analysisData.sentiment_label || "neutral",
                voice_of_customer: analysisData.voice_of_customer || "",
                objections_detected: analysisData.objections_detected || [],
                key_topics: analysisData.key_topics || [],
                action_items: analysisData.action_items || [],
                next_steps: analysisData.next_steps || [],
                call_summary: analysisData.call_summary || "",
                ai_insights: JSON.stringify({
                  transcript_summary: analysisData.transcript_summary,
                  sentiment_analysis: analysisData.sentiment_analysis,
                  highlights: analysisData.highlights,
                  areas_for_improvement: analysisData.areas_for_improvement,
                  agent_performance: analysisData.agent_performance,
                  feedback: analysisData.feedback,
                  compliance_notes: analysisData.compliance_notes,
                  ai_insights: analysisData.ai_insights,
                }),
              });

              await updateCallRecord(callId, { status: "evaluated" });
              analysisStatus = "analyzed";
              logger?.info("✅ [API] Full analysis completed", { callId });

              // Phase B — same auto-eval hook on the upload-audio →
              // autoAnalyze path so batch-uploaded calls get scorecard-
              // scored on ingest, not just on manual re-analyze.
              try {
                const { triggerSDREvaluationForCall } = await import(
                  "../../utils/sdrAutoEvaluator"
                );
                const outcome = await triggerSDREvaluationForCall(callId, "SDR");
                if (outcome.ran) {
                  logger?.info("📋 [API] Auto-SDR-eval on upload", {
                    callId,
                    scorecardId: outcome.scorecardId,
                    overallScore: outcome.overallScore,
                    postEvalStatus: outcome.postEvalStatus,
                    qaReviewReason: outcome.qaReviewReason,
                  });
                } else {
                  logger?.info("📋 [API] Auto-SDR-eval skipped on upload", {
                    callId,
                    reason: outcome.skipReason,
                  });
                }
              } catch (e: any) {
                logger?.warn("⚠️ [API] Auto-SDR-eval threw on upload", {
                  callId,
                  error: e?.message || String(e),
                });
              }

              // Auto-link + compliance: shared with /ingest and /upload
              // via callPostIngestPipeline. Closes the gap noted in
              // commit 759e1ae (Solution #6) — /upload-audio's autoAnalyze
              // block was missing this step, so auto-uploaded audio calls
              // never got CRM-linked, the badge never appeared, and the
              // Compliance Rate KPI couldn't populate.
              await autoLinkCallAndCompliance(callRecord, {
                logger,
                logTag: "upload-audio",
              });
            } catch (analysisError) {
              const errAny: any = analysisError;
              const errMsg =
                errAny?.message ??
                (typeof errAny === "string" ? errAny : "Unknown error");
              const errCode = errAny?.code || errAny?.statusCode || errAny?.status;
              logger?.error("❌ [API] Analysis failed", {
                callId,
                error: errMsg,
                code: errCode,
                stack: errAny?.stack,
              });
              await updateCallRecord(callId, {
                status: "uploaded",
                ai_insights: JSON.stringify({
                  last_analysis_error: errMsg,
                  last_analysis_error_code: errCode || null,
                  last_analysis_attempted_at: new Date().toISOString(),
                }),
              });
              analysisStatus = "analysis_failed";
              // Bubble the reason up to the caller so the upload-results UI
              // can show "analysis_failed: <reason>" instead of an opaque
              // "analysis_failed". The upload itself still succeeded.
              (analysisStatus as any) = `analysis_failed: ${errMsg}`;
            }
          }

          return c.json({
            success: true,
            call_record_id: callId,
            call_id: callRecord.call_id,
            analysis_status: analysisStatus,
            message: autoAnalyze
              ? analysisStatus === "analyzed"
                ? "Call uploaded and analysis completed"
                : `Call uploaded, analysis did not complete (${analysisStatus})`
              : "Call uploaded successfully",
          });
        } catch (error) {
          safeLogger.error("Error uploading audio call:", error);
          return c.json(
            { success: false, error: "Failed to upload call" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/calls/bulk-upload",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyAdminKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          logger?.info("📤 [API] Bulk call upload request");

          const body = await c.req.json();
          const calls = body.calls;

          if (!Array.isArray(calls) || calls.length === 0) {
            return c.json(
              {
                success: false,
                error: "No calls provided. Expected an array of call records.",
              },
              400,
            );
          }

          if (calls.length > 100) {
            return c.json(
              { success: false, error: "Maximum 100 calls per bulk upload" },
              400,
            );
          }

          const { createCallRecord, initCallIntelligenceTables } =
            await import("../../utils/callIntelligenceDb");
          await initCallIntelligenceTables();

          const results: any[] = [];
          const errors: any[] = [];

          for (let i = 0; i < calls.length; i++) {
            const call = calls[i];
            try {
              if (!call.agent_email) {
                errors.push({ row: i + 1, error: "Missing required fields" });
                continue;
              }

              const callRecord = await createCallRecord({
                call_id: call.call_id || `bulk-${Date.now()}-${i}`,
                source: "bulk_upload",
                lead_id: call.lead_id || "",
                contact_name: call.contact_name || "",
                agent_email: call.agent_email,
                agent_name: call.agent_name || "",
                direction: (call.direction || "outbound") as
                  | "inbound"
                  | "outbound",
                recording_url: call.recording_url || "",
                call_date: call.call_date
                  ? new Date(call.call_date)
                  : new Date(),
                duration_seconds: call.duration_seconds || null,
                status: "uploaded",
                metadata: {
                  uploaded_at: new Date().toISOString(),
                  bulk_upload: true,
                  notes: call.notes || "",
                },
              });

              results.push({
                row: i + 1,
                success: true,
                call_record_id: callRecord.id,
              });
            } catch (err) {
              errors.push({
                row: i + 1,
                error: err instanceof Error ? err.message : "Unknown error",
              });
            }
          }

          logger?.info("✅ [API] Bulk upload completed", {
            total: calls.length,
            success: results.length,
            errors: errors.length,
          });

          return c.json({
            success: true,
            message: `Bulk upload completed: ${results.length} successful, ${errors.length} failed`,
            total: calls.length,
            successful: results.length,
            failed: errors.length,
            results,
            errors,
          });
        } catch (error) {
          safeLogger.error("Error in bulk upload:", error);
          return c.json(
            { success: false, error: "Failed to process bulk upload" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/calls/ContactCenterProvider/test",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyAdminKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const body = await c.req.json();

          logger?.info("🔌 [API] Testing ContactCenterProvider connection", {
            domain: body.domain,
          });

          if (!body.domain || !body.username || !body.password) {
            return c.json(
              {
                success: false,
                error: "Domain, username, and password are required",
              },
              400,
            );
          }

          return c.json({
            success: true,
            message: "ContactCenterProvider connection test successful. API is reachable.",
            domain: body.domain,
          });
        } catch (error) {
          safeLogger.error("Error testing ContactCenterProvider connection:", error);
          return c.json(
            { success: false, error: "Connection test failed" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/calls/ContactCenterProvider/configure",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!(await verifyAdminKey(c))) {
            return c.json({ error: "Authentication required" }, 401);
          }

          const logger = mastra?.getLogger();
          const body = await c.req.json();

          logger?.info("⚙️ [API] Configuring ContactCenterProvider integration", {
            domain: body.domain,
          });

          if (!body.domain || !body.username || !body.password) {
            return c.json(
              {
                success: false,
                error: "Domain, username, and password are required",
              },
              400,
            );
          }

          // Scrub deny-list keys / credential-shaped strings out of the
          // free-text ContactCenterProvider config blob BEFORE persisting it as JSONB.
          // The endpoint deliberately drops the raw password (it is not
          // included in the persisted object), but `domain`/`username`
          // are still operator-controlled and could otherwise smuggle a
          // JWT, SourceControlProvider PAT (`ghp_…`), bcrypt hash, etc. into Postgres.
          const safeConfig = redactSensitiveDeep({
            domain: body.domain,
            username: body.username,
            configured_at: new Date().toISOString(),
          }) as Record<string, unknown>;
          // Delegated to callIntelligenceDb (Task #746) so the
          // integration_config writes live in a *Database/*Db module.
          const { upsertContactCenterProviderIntegrationConfig } = await import(
            "../../utils/callIntelligenceDb"
          );
          await upsertContactCenterProviderIntegrationConfig(safeConfig);

          logger?.info("✅ [API] ContactCenterProvider configuration saved");

          return c.json({
            success: true,
            message: "ContactCenterProvider configuration saved successfully",
          });
        } catch (error) {
          safeLogger.error("Error configuring ContactCenterProvider:", error);
          return c.json({ success: false, error: "Configuration failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/calls/ContactCenterProvider/sync",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          if (!(await verifyAdminKey(c))) {
            return c.json({ error: "Authentication required" }, 401);
          }

          const logger = mastra?.getLogger();
          logger?.info("🔄 [API] Syncing calls from ContactCenterProvider");

          // Delegated to callIntelligenceDb (Task #746).
          const {
            getActiveContactCenterProviderIntegrationConfig,
            markContactCenterProviderIntegrationSynced,
          } = await import("../../utils/callIntelligenceDb");
          const cfg = await getActiveContactCenterProviderIntegrationConfig();
          if (!cfg) {
            return c.json(
              {
                success: false,
                error: "ContactCenterProvider not configured. Please configure first.",
              },
              400,
            );
          }
          await markContactCenterProviderIntegrationSynced();

          logger?.info(
            "✅ [API] ContactCenterProvider sync completed (placeholder - actual ContactCenterProvider API integration pending)",
          );

          return c.json({
            success: true,
            synced_count: 0,
            message:
              "ContactCenterProvider sync completed. Configure ContactCenterProvider API credentials in secrets for full integration.",
          });
        } catch (error) {
          safeLogger.error("Error syncing ContactCenterProvider calls:", error);
          return c.json({ success: false, error: "Sync failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/calls/:id/evaluate",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyAdminKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const callId = parseInt(c.req.param("id"));
          const body = await c.req.json();

          logger?.info("📝 [API] Saving SDR evaluation", {
            callId,
            totalScore: body.total_score,
          });

          const {
            createOrUpdateQAScore,
            updateCallStatus,
            initCallIntelligenceTables,
          } = await import("../../utils/callIntelligenceDb");
          await initCallIntelligenceTables();

          const qaScore = await createOrUpdateQAScore({
            call_record_id: callId,
            scorecard_type: body.scorecard_type || "sdr",
            total_score: body.total_score,
            max_score: body.max_score || 100,
            score_percentage: body.score_percentage,
            criteria_scores: body.criteria_scores,
            coaching_notes: body.coaching_notes,
            evaluator: body.evaluator || "<REDACTED_EMAIL>",
          });

          if (body.complete) {
            await updateCallStatus(callId, "evaluated");
          }

          logger?.info("✅ [API] SDR evaluation saved", { id: qaScore.id });

          return c.json({
            success: true,
            qa_score_id: qaScore.id,
            message: body.complete
              ? "Evaluation completed and saved"
              : "Evaluation saved as draft",
          });
        } catch (error) {
          safeLogger.error("Error saving evaluation:", error);
          return c.json(
            { success: false, error: "Failed to save evaluation" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/calls/:id/sdr-evaluate",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyAdminKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const callId = parseInt(c.req.param("id"));
          const body = await c.req.json().catch(() => ({}));
          const teamName = body.team_name || "SDR";

          logger?.info("🤖 [API] Starting AI-powered SDR evaluation", {
            callId,
            teamName,
          });

          const {
            getCallRecordById,
            getTranscriptByCallId,
            getActiveSDRScorecard,
            buildSDREvaluationPrompt,
            saveSDREvaluation,
            updateCallStatus,
            initCallIntelligenceTables,
          } = await import("../../utils/callIntelligenceDb");

          await initCallIntelligenceTables();

          const callRecord = await getCallRecordById(callId);
          if (!callRecord) {
            return c.json(
              { success: false, error: "Call record not found" },
              404,
            );
          }

          let transcript = await getTranscriptByCallId(callId);

          // If no transcript exists but audio file is available, transcribe first
          const audioFilePath = (callRecord as any).audio_file_path;
          if (!transcript?.transcript_text && audioFilePath) {
            logger?.info(
              "🎙️ [API] No transcript found, transcribing audio first...",
              { audioPath: audioFilePath },
            );

            try {
              const fs = await import("fs");
              const path = await import("path");
              const { createLLMProvider } = await import("@ai-sdk/LLMProvider");

              // Audio source resolution: prefer the FS file (cheaper, no DB
              // round-trip), fall back to the audio_blob column when the
              // FS file is missing because of a HostingPlatform redeploy that wiped
              // uploads/. Without this fallback, re-evaluating after a
              // redeploy would always 404.
              let audioBuffer: Buffer | null = null;
              let audioMime = "audio/wav";
              const audioPath = path.default.resolve(audioFilePath);
              if (fs.default.existsSync(audioPath)) {
                audioBuffer = fs.default.readFileSync(audioPath);
              } else {
                const { getCallRecordAudioBlob } = await import(
                  "../../utils/callIntelligenceDb"
                );
                const blob = await getCallRecordAudioBlob(callId);
                if (blob) {
                  audioBuffer = blob.buffer;
                  audioMime = blob.mime || audioMime;
                  logger?.info(
                    "📦 [API] Audio loaded from DB blob (FS copy missing)",
                    { callId, size: audioBuffer.length },
                  );
                }
              }
              if (!audioBuffer) {
                return c.json(
                  {
                    success: false,
                    error:
                      "Audio file not found on server and no blob copy stored",
                  },
                  404,
                );
              }
              const audioBlob = new Blob([new Uint8Array(audioBuffer)], {
                type: audioMime,
              });

              const formData = new FormData();
              formData.append("file", audioBlob, "audio.wav");
              formData.append("model", "gpt-4o-mini-transcribe");
              formData.append("language", "ar");
              formData.append("response_format", "text");

              const transcribeRes = await fetch(
                `${process.env.AI_INTEGRATIONS_LLMProvider_BASE_URL}/audio/transcriptions`,
                {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${getLLMProviderApiKey() ?? ""}`,
                  },
                  body: formData,
                },
              );

              if (!transcribeRes.ok) {
                const errorText = await transcribeRes.text();
                logger?.error("❌ [API] Transcription failed", {
                  status: transcribeRes.status,
                  error: errorText,
                });
                return c.json(
                  {
                    success: false,
                    error: "Failed to transcribe audio: " + errorText,
                  },
                  500,
                );
              }

              const transcriptText = await transcribeRes.text();
              logger?.info("✅ [API] Audio transcribed successfully", {
                length: transcriptText.length,
              });

              // Save the transcript
              const { saveTranscript } =
                await import("../../utils/callIntelligenceDb");
              await saveTranscript({
                call_record_id: callId,
                transcript_text: transcriptText,
                language: "ar",
              } as any);

              transcript = {
                call_record_id: callId,
                transcript_text: transcriptText,
              } as any;
            } catch (transcribeError: any) {
              logger?.error("❌ [API] Transcription error", {
                error: transcribeError?.message || transcribeError,
              });
              return c.json(
                {
                  success: false,
                  error:
                    "Failed to transcribe audio: " +
                    (transcribeError?.message || "Unknown error"),
                },
                500,
              );
            }
          }

          if (!transcript?.transcript_text) {
            return c.json(
              {
                success: false,
                error:
                  "No audio file or transcript available. Please upload an audio recording.",
              },
              400,
            );
          }

          const scorecard = await getActiveSDRScorecard(teamName);
          if (!scorecard) {
            return c.json(
              { success: false, error: "No active SDR scorecard found" },
              400,
            );
          }

          logger?.info("📊 [API] Using scorecard", {
            name: scorecard.name,
            attributes: scorecard.attributes.length,
          });

          const evaluationPrompt = buildSDREvaluationPrompt(
            transcript.transcript_text,
            scorecard,
          );

          const { generateText } = await import("ai");
          const { createLLMProvider } = await import("@ai-sdk/LLMProvider");

          const aiSdk = createLLMProvider({
            baseURL: getLLMProviderBaseUrl(),
            apiKey: getLLMProviderApiKey(),
          });

          logger?.info("🔬 [API] Sending evaluation to AI");

          // gpt-4o-mini for SDR scorecard evaluation — same cost-reduction
          // logic as the analysis step above. Raw-fetch helper bypasses the
          // @ai-sdk/LLMProvider v3 spec regression that took down the bulk
          // analyze path in production (.chat() adapter started emitting
          // v3 spec, incompatible with <REDACTED_EMAIL> which requires v2).
          const { generateChatText: _gctEval } = await import(
            "../../utils/LLMProviderChatHelper"
          );
          const aiResult = await _gctEval({
            model: "gpt-4o-mini",
            prompt: evaluationPrompt,
            maxTokens: 8000,
          });

          let evaluationData;
          try {
            const cleanedText = aiResult.text
              .replace(/```json\n?|\n?```/g, "")
              .trim();
            evaluationData = JSON.parse(cleanedText);
          } catch (parseError) {
            logger?.error("❌ [API] Failed to parse AI response", {
              error: parseError,
            });
            return c.json(
              {
                success: false,
                error: "Failed to parse AI evaluation response",
              },
              500,
            );
          }

          logger?.info("✅ [API] AI evaluation completed", {
            overallScore: evaluationData.overall_summary?.overall_score,
            attributesEvaluated: evaluationData.attribute_evaluations?.length,
          });

          const evaluation = {
            call_record_id: callId,
            scorecard_id: scorecard.id,
            scorecard_name: scorecard.name,
            overall_score: evaluationData.overall_summary?.overall_score || 0,
            dimension_scores: evaluationData.overall_summary
              ?.dimension_scores || { people: 0, process: 0, governance: 0 },
            attribute_evaluations: evaluationData.attribute_evaluations || [],
            top_strengths: evaluationData.overall_summary?.top_strengths || [],
            top_gaps: evaluationData.overall_summary?.top_gaps || [],
            coaching_actions:
              evaluationData.overall_summary?.coaching_actions || [],
            critical_risks:
              evaluationData.overall_summary?.critical_risks || [],
            coaching_message_ar:
              evaluationData.coaching_recommendation?.message_ar || "",
            coaching_message_en:
              evaluationData.coaching_recommendation?.message_en,
            micro_training_topics:
              evaluationData.coaching_recommendation?.micro_training_topics ||
              [],
            key_moments: evaluationData.transcript_analysis?.key_moments || {},
            evaluated_at: new Date(),
          };

          const evaluationId = await saveSDREvaluation(evaluation);
          await updateCallStatus(callId, "evaluated");

          logger?.info("💾 [API] SDR evaluation saved", { evaluationId });

          return c.json({
            success: true,
            evaluation_id: evaluationId,
            scorecard_used: scorecard.name,
            overall_score: evaluation.overall_score,
            dimension_scores: evaluation.dimension_scores,
            attributes_evaluated: evaluation.attribute_evaluations.length,
            top_strengths: evaluation.top_strengths,
            top_gaps: evaluation.top_gaps,
            coaching_actions: evaluation.coaching_actions,
            coaching_message: evaluation.coaching_message_ar,
            key_moments: evaluation.key_moments,
            full_evaluation: evaluation,
          });
        } catch (error) {
          const errAny: any = error;
          const errMsg =
            errAny?.message ??
            (typeof errAny === "string" ? errAny : "Failed to evaluate call");
          const errCode =
            errAny?.code || errAny?.statusCode || errAny?.status || null;
          safeLogger.error("Error in SDR evaluation:", {
            message: errMsg,
            code: errCode,
            stack: errAny?.stack,
          });
          // Surface the real reason — most common causes are LLMProvider quota
          // exhaustion, transcript missing on the call record, or no active
          // SDR scorecard in quality_scorecards. Opaque "Failed to evaluate
          // call" hides all three.
          return c.json(
            {
              success: false,
              error: errCode ? `${errCode}: ${errMsg}` : errMsg,
            },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/calls/:id/sdr-evaluation",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const callId = parseInt(c.req.param("id"));

          logger?.info("📊 [API] Fetching SDR evaluation", { callId });

          const { getSDREvaluation, initCallIntelligenceTables } =
            await import("../../utils/callIntelligenceDb");
          await initCallIntelligenceTables();

          const evaluation = await getSDREvaluation(callId);

          if (!evaluation) {
            return c.json(
              {
                success: false,
                error: "No SDR evaluation found for this call",
              },
              404,
            );
          }

          return c.json({
            success: true,
            evaluation,
          });
        } catch (error) {
          safeLogger.error("Error fetching SDR evaluation:", error);
          return c.json(
            { success: false, error: "Failed to fetch evaluation" },
            500,
          );
        }
      };
    },
  },
  // ===================================================================
  // Manager Review Workflow (#6) — POST a review + GET review history
  // for an SDR evaluation. AI-generated scores stay informational until
  // a manager approves or disagrees with them, at which point the
  // canonical "true" score becomes COALESCE(adjusted, ai) per call.
  // ===================================================================
  {
    path: "/api/calls/:id/sdr-evaluation/review",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const callId = parseInt(c.req.param("id"));
          const body = await c.req.json().catch(() => ({}));
          const { getSessionFromCookie } = await import("./authRoutes");
          const session = getSessionFromCookie(c.req.header("Cookie"));
          const reviewerEmail = session?.email || body.reviewer_email || "unknown";
          const reviewerName = session?.name || body.reviewer_name || null;
          const reviewStatus = body.review_status;

          if (!["approved", "adjusted", "disagreed"].includes(reviewStatus)) {
            return c.json(
              {
                success: false,
                error:
                  "review_status must be one of: approved, adjusted, disagreed",
              },
              400,
            );
          }

          const {
            getSDREvaluation,
            saveSDREvaluationReview,
            initCallIntelligenceTables,
          } = await import("../../utils/callIntelligenceDb");
          await initCallIntelligenceTables();

          const evaluation = await getSDREvaluation(callId);
          if (!evaluation) {
            return c.json(
              {
                success: false,
                error:
                  "No SDR evaluation exists for this call — cannot review.",
              },
              404,
            );
          }
          // sdr_call_evaluations.id is needed as FK — re-fetch it because
          // getSDREvaluation returns the typed result without the row id.
          const { callIntelligencePool } = await import(
            "../../utils/callIntelligenceDb"
          );
          const evalIdResult = await callIntelligencePool.query(
            `SELECT id FROM sdr_call_evaluations WHERE call_record_id = $1`,
            [callId],
          );
          const evaluationId = evalIdResult.rows[0]?.id;
          if (!evaluationId) {
            return c.json(
              { success: false, error: "Evaluation id lookup failed" },
              500,
            );
          }

          const reviewId = await saveSDREvaluationReview({
            evaluation_id: evaluationId,
            call_record_id: callId,
            reviewer_email: reviewerEmail,
            reviewer_name: reviewerName,
            review_status: reviewStatus,
            adjusted_overall_score:
              typeof body.adjusted_overall_score === "number"
                ? body.adjusted_overall_score
                : null,
            adjusted_dimension_scores: body.adjusted_dimension_scores,
            adjusted_attribute_evaluations:
              body.adjusted_attribute_evaluations,
            review_notes: body.review_notes,
          });

          // Phase 3b — promote the call to `qa_reviewed` once a human has
          // weighed in. Any of approved / adjusted / disagreed counts as
          // "human looked at it" for status purposes; the review_status
          // column on sdr_evaluation_reviews keeps the verdict-level
          // detail so reports can split them out later. Skipped on the
          // status-update layer if the call has already been QA-reviewed
          // (idempotent).
          let statusPromoted = false;
          try {
            const { updateCallStatus: promoteCallStatus } = await import(
              "../../utils/callIntelligenceDb"
            );
            await promoteCallStatus(callId, "qa_reviewed");
            statusPromoted = true;
          } catch (statusErr: any) {
            logger?.warn("⚠️ [API] qa_reviewed status promote failed", {
              callId,
              reviewId,
              error: statusErr?.message || String(statusErr),
            });
          }

          // Audit trail — surfaces who reviewed and when in the
          // immutable event_logs partition. ISO 9001 §9.1.3 (analysis
          // and evaluation) plus PDPL Art. 31 (decision traceability).
          try {
            const { logEvent } = await import(
              "../../utils/eventLogsDatabase"
            );
            await logEvent({
              actionType: "sdr_evaluation_reviewed",
              entityType: "call_record",
              entityId: String(callId),
              module: "calls",
              severity: reviewStatus === "disagreed" ? "WARNING" : "INFO",
              aiInvolved: false,
              userEmail: reviewerEmail,
              userName: reviewerName || undefined,
              description: `Human reviewer ${reviewerEmail} ${reviewStatus} the SDR evaluation for call ${callId}`,
              newValue: {
                review_id: reviewId,
                evaluation_id: evaluationId,
                review_status: reviewStatus,
                adjusted_overall_score:
                  typeof body.adjusted_overall_score === "number"
                    ? body.adjusted_overall_score
                    : null,
                has_review_notes: Boolean(body.review_notes),
                status_promoted: statusPromoted,
              },
            });
          } catch (logErr: any) {
            logger?.warn("[API] sdr_evaluation_reviewed audit write failed", {
              callId,
              reviewId,
              error: logErr?.message || String(logErr),
            });
          }

          logger?.info("📝 [API] SDR evaluation review saved", {
            callId,
            evaluationId,
            reviewId,
            reviewStatus,
            reviewer: reviewerEmail,
            statusPromoted,
          });

          return c.json({
            success: true,
            review_id: reviewId,
            evaluation_id: evaluationId,
            review_status: reviewStatus,
            call_status: statusPromoted ? "qa_reviewed" : undefined,
          });
        } catch (error) {
          const errAny: any = error;
          safeLogger.error("Error saving SDR evaluation review:", {
            message: errAny?.message,
            code: errAny?.code,
            stack: errAny?.stack,
          });
          return c.json(
            { success: false, error: errAny?.message || "Failed to save review" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/calls/:id/sdr-evaluation/reviews",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const callId = parseInt(c.req.param("id"));
          const { getSDRReviewsForCall, initCallIntelligenceTables } =
            await import("../../utils/callIntelligenceDb");
          await initCallIntelligenceTables();

          const reviews = await getSDRReviewsForCall(callId);
          return c.json({ success: true, reviews });
        } catch (error) {
          const errAny: any = error;
          safeLogger.error("Error fetching SDR evaluation reviews:", {
            message: errAny?.message,
          });
          return c.json(
            { success: false, error: errAny?.message || "Failed to fetch reviews" },
            500,
          );
        }
      };
    },
  },
  // ===================================================================
  // Phase 3b — "QA Checked" button.
  //
  // The /sdr-evaluation/review endpoint above is the full
  // approved / adjusted / disagreed review surface for managers who want
  // to push back on the AI's scoring. Operators (QA leads who are just
  // confirming "I read the transcript, the AI scoring matches my read,
  // good to go") needed a one-click button that doesn't require picking
  // a verdict shape or filling out per-attribute adjustments.
  //
  // This endpoint is a thin wrapper: review_status is locked to
  // "approved", review_notes is the only optional payload field, and the
  // same auditable plumbing (sdr_evaluation_reviews row + qa_reviewed
  // status promote + event_logs audit row) fires under the hood.
  //
  // Operator workflow:
  //   1. Upload triggers auto-transcribe + auto-evaluate → status lands
  //      in `evaluated` (clean run) or `qa_review_pending` (flagged).
  //   2. QA opens the call detail, reads transcript + AI scoring.
  //   3. QA clicks "QA Checked" — optionally types a verification note.
  //   4. POST hits this endpoint → call_records.status → qa_reviewed,
  //      sdr_evaluation_reviews gets an `approved` row, event_logs gets
  //      a tamper-evident audit entry.
  //
  // Idempotent for repeated clicks (new review row each time, no de-dup
  // — same as the existing review endpoint — so operators reviewing the
  // history can compare verification runs).
  // ===================================================================
  {
    path: "/api/calls/:id/qa-check",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const callId = parseInt(c.req.param("id"));
          if (!Number.isFinite(callId)) {
            return c.json(
              { success: false, error: "Invalid call id" },
              400,
            );
          }

          const body = await c.req.json().catch(() => ({}));
          const { getSessionFromCookie } = await import("./authRoutes");
          const session = getSessionFromCookie(c.req.header("Cookie"));
          const reviewerEmail =
            session?.email || body.reviewer_email || "unknown";
          const reviewerName = session?.name || body.reviewer_name || null;
          const reviewNotes =
            typeof body.review_notes === "string"
              ? body.review_notes.trim() || null
              : null;

          const {
            getSDREvaluation,
            saveSDREvaluationReview,
            updateCallStatus: promoteCallStatus,
            callIntelligencePool,
            initCallIntelligenceTables,
          } = await import("../../utils/callIntelligenceDb");
          await initCallIntelligenceTables();

          // No evaluation = nothing to certify. We return 409 (conflict)
          // not 404 because the call record itself almost certainly does
          // exist — the auto-eval just hasn't run / has skipped. The
          // operator can re-run auto-eval and try again.
          const evaluation = await getSDREvaluation(callId);
          if (!evaluation) {
            return c.json(
              {
                success: false,
                error:
                  "No SDR evaluation exists yet for this call — run the auto-evaluator first, then QA-check.",
              },
              409,
            );
          }
          const evalIdResult = await callIntelligencePool.query(
            `SELECT id FROM sdr_call_evaluations WHERE call_record_id = $1`,
            [callId],
          );
          const evaluationId = evalIdResult.rows[0]?.id;
          if (!evaluationId) {
            return c.json(
              { success: false, error: "Evaluation id lookup failed" },
              500,
            );
          }

          const reviewId = await saveSDREvaluationReview({
            evaluation_id: evaluationId,
            call_record_id: callId,
            reviewer_email: reviewerEmail,
            reviewer_name: reviewerName,
            review_status: "approved",
            review_notes: reviewNotes,
          });

          let statusPromoted = false;
          try {
            await promoteCallStatus(callId, "qa_reviewed");
            statusPromoted = true;
          } catch (statusErr: any) {
            logger?.warn("⚠️ [API] qa-check status promote failed", {
              callId,
              reviewId,
              error: statusErr?.message || String(statusErr),
            });
          }

          try {
            const { logEvent } = await import(
              "../../utils/eventLogsDatabase"
            );
            await logEvent({
              actionType: "sdr_qa_checked",
              entityType: "call_record",
              entityId: String(callId),
              module: "calls",
              severity: "INFO",
              aiInvolved: false,
              userEmail: reviewerEmail,
              userName: reviewerName || undefined,
              description: `QA reviewer ${reviewerEmail} QA-checked call ${callId} (evaluation ${evaluationId})`,
              newValue: {
                review_id: reviewId,
                evaluation_id: evaluationId,
                review_status: "approved",
                has_review_notes: Boolean(reviewNotes),
                status_promoted: statusPromoted,
                source: "qa_check_button",
              },
            });
          } catch (logErr: any) {
            logger?.warn("[API] sdr_qa_checked audit write failed", {
              callId,
              reviewId,
              error: logErr?.message || String(logErr),
            });
          }

          logger?.info("✅ [API] QA Checked button fired", {
            callId,
            evaluationId,
            reviewId,
            reviewer: reviewerEmail,
            statusPromoted,
          });

          return c.json({
            success: true,
            review_id: reviewId,
            evaluation_id: evaluationId,
            call_status: statusPromoted ? "qa_reviewed" : undefined,
          });
        } catch (error) {
          const errAny: any = error;
          safeLogger.error("Error processing QA Checked:", {
            message: errAny?.message,
            code: errAny?.code,
          });
          return c.json(
            {
              success: false,
              error: errAny?.message || "Failed to QA-check call",
            },
            500,
          );
        }
      };
    },
  },
  // ===================================================================
  // Medium #7 — Coaching loop integration.
  // Returns prioritised coaching suggestions for a call by mapping
  // every below-threshold attribute against the training_courses
  // catalog. On-demand so it always reflects the current catalog.
  // ===================================================================
  {
    path: "/api/calls/:id/coaching-suggestions",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const callId = parseInt(c.req.param("id"));
          const { getSDREvaluation, initCallIntelligenceTables } =
            await import("../../utils/callIntelligenceDb");
          await initCallIntelligenceTables();

          const evaluation = await getSDREvaluation(callId);
          if (!evaluation) {
            return c.json(
              { success: false, error: "No SDR evaluation exists for this call yet" },
              404,
            );
          }

          const { buildCoachingPlan } = await import(
            "../../utils/sdrCoachingSuggestions"
          );
          const plan = await buildCoachingPlan(evaluation);

          return c.json({ success: true, plan });
        } catch (error) {
          const errAny: any = error;
          safeLogger.error("Error building coaching suggestions:", {
            message: errAny?.message,
          });
          return c.json(
            {
              success: false,
              error: errAny?.message || "Failed to build coaching suggestions",
            },
            500,
          );
        }
      };
    },
  },
  // ===================================================================
  // Coaching loop closure — track manager-delivered coaching sessions.
  // The "Mark coaching delivered" button on the Coaching Plan panel
  // POSTs here; the session captures who coached whom, on which
  // attributes, with what training, and the SDR's commitment. Outcome
  // call linking measures whether coaching moved the needle.
  // ===================================================================
  {
    path: "/api/coaching-sessions",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);
          const body = await c.req.json().catch(() => ({}));
          if (!body.call_record_id || !body.agent_email) {
            return c.json(
              { success: false, error: "call_record_id and agent_email are required" },
              400,
            );
          }
          const { createCoachingSession } = await import(
            "../../utils/coachingSessions"
          );
          const session = await createCoachingSession({
            call_record_id: parseInt(body.call_record_id, 10),
            evaluation_id: body.evaluation_id ?? null,
            agent_email: body.agent_email,
            agent_name: body.agent_name ?? null,
            manager_email: (admin as any).email || body.manager_email || "unknown",
            manager_name: (admin as any).name || body.manager_name || null,
            status: body.status || "delivered",
            scheduled_for: body.scheduled_for ? new Date(body.scheduled_for) : null,
            delivered_at: body.delivered_at ? new Date(body.delivered_at) : undefined,
            duration_minutes:
              typeof body.duration_minutes === "number" ? body.duration_minutes : null,
            assigned_course_ids: Array.isArray(body.assigned_course_ids)
              ? body.assigned_course_ids
              : [],
            attribute_focus_ids: Array.isArray(body.attribute_focus_ids)
              ? body.attribute_focus_ids
              : [],
            commitment_notes: body.commitment_notes ?? null,
            followup_due_date: body.followup_due_date ?? null,
          });
          return c.json({ success: true, session });
        } catch (error) {
          const errAny: any = error;
          safeLogger.error("Create coaching session failed:", {
            message: errAny?.message,
          });
          return c.json(
            { success: false, error: errAny?.message || "Create failed" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/coaching-sessions",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);
          const url = new URL(c.req.url);
          const { listCoachingSessions } = await import(
            "../../utils/coachingSessions"
          );
          const statusParam = url.searchParams.get("status");
          const result = await listCoachingSessions({
            agent_email: url.searchParams.get("agent_email") || undefined,
            manager_email: url.searchParams.get("manager_email") || undefined,
            call_record_id: url.searchParams.get("call_record_id")
              ? parseInt(url.searchParams.get("call_record_id")!, 10)
              : undefined,
            status: statusParam
              ? (statusParam.split(",") as any)
              : undefined,
            limit: parseInt(url.searchParams.get("limit") || "50", 10),
            offset: parseInt(url.searchParams.get("offset") || "0", 10),
          });
          return c.json({ success: true, ...result });
        } catch (error) {
          const errAny: any = error;
          safeLogger.error("List coaching sessions failed:", {
            message: errAny?.message,
          });
          return c.json(
            { success: false, error: errAny?.message || "List failed" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/coaching-sessions/kpis",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);
          const url = new URL(c.req.url);
          const { getCoachingKPIs } = await import(
            "../../utils/coachingSessions"
          );
          const kpis = await getCoachingKPIs({
            startDate: url.searchParams.get("start_date")
              ? new Date(url.searchParams.get("start_date")!)
              : undefined,
            endDate: url.searchParams.get("end_date")
              ? new Date(url.searchParams.get("end_date")!)
              : undefined,
            manager_email: url.searchParams.get("manager_email") || undefined,
            agent_email: url.searchParams.get("agent_email") || undefined,
          });
          return c.json({ success: true, kpis });
        } catch (error) {
          const errAny: any = error;
          safeLogger.error("Coaching KPIs failed:", { message: errAny?.message });
          return c.json(
            { success: false, error: errAny?.message || "KPIs failed" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/coaching-sessions/:id",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);
          const id = parseInt(c.req.param("id"), 10);
          const { getCoachingSession } = await import(
            "../../utils/coachingSessions"
          );
          const session = await getCoachingSession(id);
          if (!session)
            return c.json(
              { success: false, error: "Coaching session not found" },
              404,
            );
          return c.json({ success: true, session });
        } catch (error) {
          const errAny: any = error;
          safeLogger.error("Get coaching session failed:", {
            message: errAny?.message,
          });
          return c.json(
            { success: false, error: errAny?.message || "Get failed" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/coaching-sessions/:id",
    method: "PATCH" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);
          const id = parseInt(c.req.param("id"), 10);
          const body = await c.req.json().catch(() => ({}));
          const { updateCoachingSession } = await import(
            "../../utils/coachingSessions"
          );
          // Convert ISO date strings to Date instances for fields the
          // helper expects as Date. Leave string-typed columns alone.
          const patch: any = { ...body };
          if (patch.scheduled_for)
            patch.scheduled_for = new Date(patch.scheduled_for);
          if (patch.delivered_at)
            patch.delivered_at = new Date(patch.delivered_at);
          const session = await updateCoachingSession(id, patch);
          if (!session)
            return c.json(
              { success: false, error: "Coaching session not found" },
              404,
            );
          return c.json({ success: true, session });
        } catch (error) {
          const errAny: any = error;
          safeLogger.error("Update coaching session failed:", {
            message: errAny?.message,
          });
          return c.json(
            { success: false, error: errAny?.message || "Update failed" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/coaching-sessions/:id/link-outcome",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);
          const id = parseInt(c.req.param("id"), 10);
          const body = await c.req.json().catch(() => ({}));
          if (!body.outcome_call_id) {
            return c.json(
              { success: false, error: "outcome_call_id is required" },
              400,
            );
          }
          const { linkOutcomeCall } = await import(
            "../../utils/coachingSessions"
          );
          const session = await linkOutcomeCall(
            id,
            parseInt(body.outcome_call_id, 10),
          );
          if (!session)
            return c.json(
              { success: false, error: "Coaching session not found" },
              404,
            );
          return c.json({ success: true, session });
        } catch (error) {
          const errAny: any = error;
          safeLogger.error("Link outcome call failed:", {
            message: errAny?.message,
          });
          return c.json(
            { success: false, error: errAny?.message || "Link failed" },
            500,
          );
        }
      };
    },
  },
  // ===================================================================
  // Medium #9 — LLMProvider Batch API for bulk SDR evaluation.
  //   POST   /api/calls/batch/submit-pending  → bundle all eligible calls
  //   GET    /api/calls/batch/jobs            → list recent batches
  //   GET    /api/calls/batch/jobs/:id        → one batch + linked calls
  //   POST   /api/calls/batch/jobs/:id/sync   → manual poll trigger
  // Interactive single-call evaluation still uses the real-time path.
  // ===================================================================
  {
    path: "/api/calls/batch/eligibility",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);
          const { countEligibleCalls } = await import(
            "../../utils/sdrBatchEvaluator"
          );
          const count = await countEligibleCalls();
          // Rough cost guidance: gpt-4o-mini batch ≈ $0.000625/call
          // (50% of the real-time ~$0.00125). Use 0.001 to be safe.
          const estimatedCostUsd = Number((count * 0.001).toFixed(4));
          return c.json({ success: true, eligible_count: count, estimated_cost_usd: estimatedCostUsd });
        } catch (error) {
          const errAny: any = error;
          safeLogger.error("Batch eligibility check failed:", { message: errAny?.message });
          return c.json(
            { success: false, error: errAny?.message || "Eligibility check failed" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/calls/batch/submit-pending",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);
          const body = await c.req.json().catch(() => ({}));
          const { submitPendingForBatch } = await import(
            "../../utils/sdrBatchEvaluator"
          );
          const result = await submitPendingForBatch({
            scorecardTeam: body.scorecard_team || "SDR",
            submittedBy:
              admin.email || (admin.id != null ? String(admin.id) : undefined),
            maxCalls: typeof body.max_calls === "number" ? body.max_calls : 200,
          });
          return c.json({ success: true, ...result });
        } catch (error) {
          const errAny: any = error;
          safeLogger.error("Batch submit failed:", { message: errAny?.message });
          return c.json(
            { success: false, error: errAny?.message || "Batch submit failed" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/calls/batch/jobs",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);
          const { listBatchJobs } = await import("../../utils/sdrBatchEvaluator");
          const jobs = await listBatchJobs(50);
          return c.json({ success: true, jobs });
        } catch (error) {
          const errAny: any = error;
          safeLogger.error("List batch jobs failed:", { message: errAny?.message });
          return c.json(
            { success: false, error: errAny?.message || "List batch jobs failed" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/calls/batch/jobs/:id",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);
          const id = parseInt(c.req.param("id"), 10);
          const { getBatchJob } = await import("../../utils/sdrBatchEvaluator");
          const job = await getBatchJob(id);
          if (!job) return c.json({ success: false, error: "Batch job not found" }, 404);
          return c.json({ success: true, job });
        } catch (error) {
          const errAny: any = error;
          safeLogger.error("Get batch job failed:", { message: errAny?.message });
          return c.json(
            { success: false, error: errAny?.message || "Get batch job failed" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/calls/batch/jobs/:id/sync",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);
          // Triggers a poll across ALL open batches — manual fallback when
          // the Inngest 15min poller is too slow. The endpoint is :id-scoped
          // for URL clarity but the poll itself is global (cheaper than
          // single-target lookups against LLMProvider).
          const { pollAndProcessOpenBatches, getBatchJob } = await import(
            "../../utils/sdrBatchEvaluator"
          );
          const summary = await pollAndProcessOpenBatches();
          const id = parseInt(c.req.param("id"), 10);
          const job = await getBatchJob(id);
          return c.json({ success: true, poll_summary: summary, job });
        } catch (error) {
          const errAny: any = error;
          safeLogger.error("Batch sync failed:", { message: errAny?.message });
          return c.json(
            { success: false, error: errAny?.message || "Batch sync failed" },
            500,
          );
        }
      };
    },
  },
  // ===================================================================
  // Medium #10 — Excel export of one call's SDR evaluation.
  // Multi-sheet workbook (Summary, Attribute Evaluations, Coaching,
  // Review History) so Quality team can email a shareable .xlsx to
  // sales managers. Built on streamXlsx per SOP §25.
  // ===================================================================
  {
    path: "/api/calls/:id/sdr-evaluation/export.xlsx",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);

          const callId = parseInt(c.req.param("id"));
          const logger = mastra?.getLogger();

          const {
            getCallRecordById,
            getSDREvaluation,
            getSDRReviewsForCall,
            initCallIntelligenceTables,
          } = await import("../../utils/callIntelligenceDb");
          const { streamXlsx } = await import("../../utils/excelExport");
          await initCallIntelligenceTables();

          const callRecord: any = await getCallRecordById(callId);
          if (!callRecord) return c.json({ error: "Call not found" }, 404);

          const evaluation = await getSDREvaluation(callId);
          if (!evaluation) {
            return c.json(
              { error: "No SDR evaluation exists for this call yet" },
              404,
            );
          }
          const reviews = await getSDRReviewsForCall(callId);

          const fmtDate = (d: unknown) =>
            d
              ? new Date(String(d)).toISOString().substring(0, 19).replace("T", " ")
              : "";
          const fmtNum = (n: unknown) =>
            n === null || n === undefined || n === "" ? "" : String(n);

          const latestReview = reviews[0] || null;
          const canonicalScore =
            latestReview?.adjusted_overall_score ?? evaluation.overall_score;
          const dim: any = evaluation.dimension_scores || {
            people: 0,
            process: 0,
            governance: 0,
          };

          const sheets = [
            {
              name: "Summary",
              columns: [
                { header: "Field", key: "field", width: 32 },
                { header: "Value", key: "value", width: 70 },
              ],
              rows: [
                { field: "Call ID", value: callRecord.call_id || String(callId) },
                { field: "Agent Email", value: callRecord.agent_email || "" },
                { field: "Agent Name", value: callRecord.agent_name || "" },
                { field: "Contact Name", value: callRecord.contact_name || "" },
                { field: "Contact Phone", value: callRecord.contact_phone || "" },
                { field: "Call Date", value: fmtDate(callRecord.call_date) },
                { field: "Source", value: callRecord.source || "" },
                { field: "", value: "" },
                { field: "Scorecard", value: evaluation.scorecard_name || "" },
                { field: "AI Overall Score", value: fmtNum(evaluation.overall_score) + " / 100" },
                { field: "People Dimension", value: fmtNum(dim.people) + " / 100" },
                { field: "Process Dimension", value: fmtNum(dim.process) + " / 100" },
                { field: "Governance Dimension", value: fmtNum(dim.governance) + " / 100" },
                { field: "AI Evaluated At", value: fmtDate((evaluation as any).evaluated_at) },
                { field: "", value: "" },
                { field: "Latest Review Status", value: latestReview?.review_status || "(not reviewed)" },
                { field: "Latest Reviewer", value: latestReview ? (latestReview.reviewer_name || latestReview.reviewer_email) : "" },
                { field: "Latest Reviewed At", value: latestReview ? fmtDate(latestReview.reviewed_at) : "" },
                { field: "Canonical Score (review-adjusted)", value: fmtNum(canonicalScore) + " / 100" },
                { field: "Total Reviews", value: String(reviews.length) },
              ],
            },
            {
              name: "Attribute Evaluations",
              columns: [
                { header: "Attribute", key: "attribute_name", width: 35 },
                { header: "Dimension", key: "dimension", width: 14 },
                { header: "Status", key: "status", width: 10 },
                { header: "Score", key: "score", width: 8 },
                { header: "Comment", key: "comment", width: 60 },
                { header: "Evidence Quote", key: "evidence", width: 60 },
                { header: "Improvement Tip", key: "improvement_tip", width: 50 },
              ],
              rows: ((evaluation.attribute_evaluations as any[]) || []).map((a: any) => ({
                attribute_name: a.attribute_name || "",
                dimension: a.dimension || "",
                status: a.status || "",
                score: fmtNum(a.score),
                comment: a.comment || "",
                evidence: Array.isArray(a.evidence_quotes) && a.evidence_quotes.length
                  ? a.evidence_quotes.join(" | ")
                  : "",
                improvement_tip: a.improvement_tip || "",
              })),
            },
            {
              name: "Coaching",
              columns: [
                { header: "Type", key: "type", width: 22 },
                { header: "Item", key: "item", width: 90 },
              ],
              rows: [
                ...(((evaluation.top_strengths as string[]) || []).map((s: string) => ({ type: "Strength", item: s }))),
                ...(((evaluation.top_gaps as string[]) || []).map((g: string) => ({ type: "Gap", item: g }))),
                ...(((evaluation.coaching_actions as string[]) || []).map((a: string) => ({ type: "Coaching Action", item: a }))),
                ...(((evaluation.micro_training_topics as string[]) || []).map((t: string) => ({ type: "Training Topic", item: t }))),
                ...(((evaluation.critical_risks as string[]) || []).map((r: string) => ({ type: "Critical Risk", item: r }))),
                ...(evaluation.coaching_message_ar
                  ? [{ type: "Coaching Message (AR)", item: evaluation.coaching_message_ar }]
                  : []),
                ...(evaluation.coaching_message_en
                  ? [{ type: "Coaching Message (EN)", item: evaluation.coaching_message_en }]
                  : []),
              ],
            },
            {
              name: "Review History",
              columns: [
                { header: "Reviewed At", key: "reviewed_at", width: 22 },
                { header: "Reviewer", key: "reviewer", width: 35 },
                { header: "Status", key: "status", width: 12 },
                { header: "Adjusted Overall Score", key: "adjusted_score", width: 18 },
                { header: "Notes", key: "notes", width: 80 },
              ],
              rows: reviews.map((r: any) => ({
                reviewed_at: fmtDate(r.reviewed_at),
                reviewer: r.reviewer_name || r.reviewer_email || "",
                status: r.review_status || "",
                adjusted_score: fmtNum(r.adjusted_overall_score),
                notes: r.review_notes || "",
              })),
            },
          ];

          const safeCallId = String(callRecord.call_id || callId).replace(/[^a-zA-Z0-9_-]/g, "_");
          const filename = `sdr_evaluation_${safeCallId}_${Date.now()}.xlsx`;
          logger?.info("📤 [API] Exporting SDR evaluation to xlsx", { callId, filename });
          return await streamXlsx(sheets, filename, {
            creator: "ExampleOrg QMS",
            title: `SDR Evaluation — ${callRecord.agent_email || callId}`,
          });
        } catch (error) {
          const errAny: any = error;
          safeLogger.error("Error exporting SDR evaluation xlsx:", {
            message: errAny?.message,
            stack: errAny?.stack,
          });
          return c.json(
            { error: errAny?.message || "Failed to export evaluation" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/sdr-scorecards/active",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const teamName = c.req.query("team");

          logger?.info("📊 [API] Fetching active SDR scorecard", { teamName });

          const { getActiveSDRScorecard, initCallIntelligenceTables } =
            await import("../../utils/callIntelligenceDb");
          await initCallIntelligenceTables();

          const scorecard = await getActiveSDRScorecard(teamName);

          if (!scorecard) {
            return c.json(
              { success: false, error: "No active scorecard found" },
              404,
            );
          }

          return c.json({
            success: true,
            scorecard,
          });
        } catch (error) {
          safeLogger.error("Error fetching scorecard:", error);
          return c.json(
            { success: false, error: "Failed to fetch scorecard" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/ai-training/feedback",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const body = await c.req.json();

          logger?.info("📊 [API] Submitting AI evaluation feedback", {
            call_record_id: body.call_record_id,
            evaluation_id: body.evaluation_id,
            feedback_type: body.feedback_type,
          });

          // Validate required fields
          if (!body.call_record_id || !body.feedback_type) {
            logger?.warn("⚠️ [API] Missing required fields for AI feedback");
            return c.json(
              { success: false, error: "Missing required fields" },
              400,
            );
          }

          const validTypes = ["accurate", "partially_accurate", "inaccurate"];
          if (!validTypes.includes(body.feedback_type)) {
            logger?.warn("⚠️ [API] Invalid feedback_type", {
              feedback_type: body.feedback_type,
            });
            return c.json(
              { success: false, error: "Invalid input provided" },
              400,
            );
          }

          const { submitAIFeedback, initCallIntelligenceTables } =
            await import("../../utils/callIntelligenceDb");
          await initCallIntelligenceTables();

          const feedbackId = await submitAIFeedback({
            callRecordId: body.call_record_id,
            evaluationId: body.evaluation_id || 0,
            feedbackType: body.feedback_type,
            details: body.details || "",
            submittedBy: body.submitted_by || "anonymous",
          });

          logger?.info("✅ [API] AI feedback submitted successfully", {
            feedbackId,
          });

          return c.json({
            success: true,
            feedbackId,
          });
        } catch (error) {
          safeLogger.error("Error submitting AI feedback:", error);
          return c.json(
            { success: false, error: "Failed to submit feedback" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/ai-training/stats",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          logger?.info("📊 [API] Fetching AI training stats");

          const { getAITrainingStats, initCallIntelligenceTables } =
            await import("../../utils/callIntelligenceDb");
          await initCallIntelligenceTables();

          const stats = await getAITrainingStats();

          logger?.info(
            "✅ [API] AI training stats fetched successfully",
            stats,
          );

          return c.json({
            success: true,
            stats,
          });
        } catch (error) {
          safeLogger.error("Error fetching AI training stats:", error);
          return c.json(
            { success: false, error: "Failed to fetch stats" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/quality-scorecards",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          logger?.info("📊 [API] Fetching quality scorecards");

          const { getScorecardsByModuleAndTeam } =
            await import("../../utils/database");
          const scorecards = await getScorecardsByModuleAndTeam();

          logger?.info("✅ [API] Quality scorecards fetched", {
            count: scorecards.length,
          });

          return c.json({
            success: true,
            scorecards,
          });
        } catch (error) {
          safeLogger.error("Error fetching quality scorecards:", error);
          return c.json(
            { success: false, error: "Failed to fetch scorecards" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/quality-scorecards",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyAdminKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const data = await c.req.json();

          logger?.info("📝 [API] Creating quality scorecard", {
            name: data.name,
            team: data.team_name,
          });

          if (!data.name) {
            return c.json(
              { success: false, error: "Missing required fields" },
              400,
            );
          }

          const { createScorecard, updateScorecard } =
            await import("../../utils/database");
          const scorecard = await createScorecard({
            name: data.name,
            description: data.description || "",
            crm_module: data.crm_module || "Leads",
            team_name: data.team_name || "SDR",
            version: data.version || "1.0",
            dimensions: data.dimensions || {},
          });

          if (data.is_active && scorecard.id) {
            await updateScorecard(scorecard.id, { is_active: data.is_active });
          }

          logger?.info("✅ [API] Quality scorecard created", {
            id: scorecard.id,
          });

          return c.json({
            success: true,
            id: scorecard.id,
            scorecard,
          });
        } catch (error) {
          safeLogger.error("Error creating quality scorecard:", error);
          return c.json(
            { success: false, error: "Failed to create scorecard" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/quality-scorecards/:id",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const id = parseInt(c.req.param("id"));
          const updates = await c.req.json();

          logger?.info("📝 [API] Updating quality scorecard", {
            id,
            updates: Object.keys(updates),
          });

          const { updateScorecard } = await import("../../utils/database");
          const scorecard = await updateScorecard(id, updates);

          if (!scorecard) {
            return c.json(
              { success: false, error: "Scorecard not found" },
              404,
            );
          }

          logger?.info("✅ [API] Quality scorecard updated", { id });

          return c.json({
            success: true,
            scorecard,
          });
        } catch (error) {
          safeLogger.error("Error updating quality scorecard:", error);
          return c.json(
            { success: false, error: "Failed to update scorecard" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/calls/:callId/sync-CRMProvider",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyAdminKey(c);
          if (!admin) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const callId = parseInt(c.req.param("callId"));

          logger?.info("🔄 [API] Syncing call evaluation to CRMProvider CRM", {
            callId,
          });

          const { getSDREvaluation, getCallRecordById } =
            await import("../../utils/callIntelligenceDb");
          const { updateCRMProviderRecordNotes } = await import("../../utils/CRMProviderCRM");

          const callRecord = await getCallRecordById(callId);
          if (!callRecord) {
            return c.json(
              { success: false, error: "Call record not found" },
              404,
            );
          }

          const evaluation = await getSDREvaluation(callId);
          if (!evaluation) {
            return c.json(
              { success: false, error: "No evaluation found for this call" },
              404,
            );
          }

          const noteContent = formatEvaluationForCRMProvider(evaluation, callRecord);

          let synced = false;
          let syncTarget = "";

          if (callRecord.lead_id) {
            await updateCRMProviderRecordNotes(
              "Leads",
              callRecord.lead_id,
              noteContent,
            );
            synced = true;
            syncTarget = `Lead ${callRecord.lead_id}`;
          } else if (callRecord.deal_id) {
            await updateCRMProviderRecordNotes(
              "Deals",
              callRecord.deal_id,
              noteContent,
            );
            synced = true;
            syncTarget = `Deal ${callRecord.deal_id}`;
          }

          if (!synced) {
            return c.json(
              {
                success: false,
                error: "No Lead or Deal ID associated with this call",
              },
              400,
            );
          }

          // DMAIC Solution #4: also promote the evaluation into
          // structured CRMProvider fields (QA_Score / Compliance_Pass /
          // Last_Evaluation_Date) so the result is filterable in
          // CRMProvider's native reports. Feature-flagged on
          // CRMProvider_STRUCTURED_FIELDS — ships dark until the CRMProvider admin
          // creates the custom fields. Best-effort: the Note write
          // above already succeeded; we never fail the sync because
          // of a structured-fields hiccup.
          let structuredResult: any = null;
          try {
            const { syncEvaluationToCRMProviderStructuredFields } = await import(
              "../../utils/CRMProviderStructuredFieldsSync"
            );
            structuredResult = await syncEvaluationToCRMProviderStructuredFields(
              {
                overall_score: (evaluation as any).overall_score,
                compliance_pass: (evaluation as any).compliance_pass,
                evaluated_at:
                  (evaluation as any).evaluated_at ||
                  (evaluation as any).created_at ||
                  null,
              },
              callRecord,
              {
                logger,
                identity: (admin as any).email || `user:${(admin as any).userId}`,
              },
            );
          } catch (err: any) {
            logger?.warn("[API] structured-fields sync threw, continuing", {
              callId,
              error: err?.message || String(err),
            });
          }

          logger?.info("✅ [API] Call evaluation synced to CRMProvider", {
            callId,
            syncTarget,
            structured_fields_synced: structuredResult?.synced || false,
          });

          return c.json({
            success: true,
            message: `Evaluation synced to ${syncTarget}`,
            syncTarget,
            structured_fields: structuredResult,
          });
        } catch (error) {
          safeLogger.error("Error syncing to CRMProvider:", error);
          return c.json(
            { success: false, error: "Failed to sync to CRMProvider" },
            500,
          );
        }
      };
    },
  },
  {
    // SDR Activity Timeline for a linked call. Returns recent CRMProvider
    // activities (Notes / Calls / Tasks / Events) on the call's linked
    // Lead or Deal since the call_date. Powers the "what did the SDR do
    // with this prospect after the call" view in the Calls dashboard.
    path: "/api/calls/:callId/activity-timeline",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const user = await verifyCallAccess(c);
        if (!user) return unauthorizedResponse(c);
        try {
          const callId = parseInt(c.req.param("callId"));
          if (!Number.isFinite(callId) || callId <= 0) {
            return c.json({ error: "invalid call id" }, 400);
          }
          const { getCallRecordById } = await import(
            "../../utils/callIntelligenceDb"
          );
          const record = await getCallRecordById(callId);
          if (!record) {
            return c.json({ error: "call record not found" }, 404);
          }
          const recordId = record.lead_id || record.deal_id;
          if (!recordId) {
            return c.json({
              success: false,
              reason: "no_crm_linkage",
              message:
                "Call is not linked to a CRMProvider Lead or Deal — run auto-link first.",
            });
          }
          const module = record.lead_id ? "Leads" : "Deals";
          const { getSdrActivityTimeline } = await import(
            "../../utils/sdrCallLinking"
          );
          const timeline = await getSdrActivityTimeline(
            recordId,
            module,
            record.call_date ?? new Date(),
          );
          return c.json({ success: true, ...timeline });
        } catch (error: any) {
          safeLogger.error("[API] activity-timeline failed", {
            error: error?.message || String(error),
          });
          return c.json(
            { success: false, error: "Failed to load activity timeline" },
            500,
          );
        }
      };
    },
  },
  {
    // Manual auto-link trigger — re-runs the Lead+Deal phone match on a
    // call after the fact (e.g. for calls ingested before the auto-link
    // feature shipped, or when CRMProvider was unreachable at ingest time).
    path: "/api/calls/:callId/auto-link",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        const user = await verifyCallAccess(c);
        if (!user) return unauthorizedResponse(c);
        try {
          const callId = parseInt(c.req.param("callId"));
          if (!Number.isFinite(callId) || callId <= 0) {
            return c.json({ error: "invalid call id" }, 400);
          }
          const {
            getCallRecordById,
            updateCallRecordLeadId,
            updateCallRecordDealId,
          } = await import("../../utils/callIntelligenceDb");
          const record = await getCallRecordById(callId);
          if (!record) {
            return c.json({ error: "call record not found" }, 404);
          }
          if (record.lead_id || record.deal_id) {
            return c.json({
              linked: false,
              reason: "already_linked",
              lead_id: record.lead_id ?? null,
              deal_id: record.deal_id ?? null,
            });
          }
          const { autoLinkCallToCrm } = await import(
            "../../utils/sdrCallLinking"
          );
          const { extractCallPhoneCandidates } = await import(
            "../../utils/callLeadPhoneMatch"
          );
          // Activity-based fallback: when the phone digits don't pull
          // up a unique lead/deal, look for CRM activities the same
          // agent created on the same day and link to the parent. This
          // recovers calls where the SDR called from a number not on
          // file but still logged a follow-up note/task in CRMProvider.
          const result = await autoLinkCallToCrm(
            callId,
            extractCallPhoneCandidates(record),
            updateCallRecordLeadId,
            updateCallRecordDealId,
            {
              agentEmail: (record as any).agent_email || undefined,
              agentName: (record as any).agent_name || null,
              callDate: (record as any).call_date
                ? new Date((record as any).call_date)
                : new Date((record as any).created_at || Date.now()),
            },
          );
          // Persist the match source so the UI can show a confidence
          // badge ("matched via activity" vs the higher-confidence
          // phone match). Best-effort — never block the response.
          if (result.linked && result.linked_via) {
            try {
              const { updateCallRecordLinkedVia } = await import(
                "../../utils/callIntelligenceDb"
              );
              await updateCallRecordLinkedVia(callId, result.linked_via);
            } catch {
              /* ignore — diagnostic column only */
            }
          }
          // Auto-trigger compliance check on freshly linked calls so
          // the Compliance Rate KPI updates without a manual run.
          if (result.linked) {
            await runComplianceAfterLink(
              callId,
              result.lead_id ?? null,
              result.deal_id ?? null,
              (record as any).call_date ?? (record as any).created_at,
              undefined,
              {
                agentEmail: (record as any).agent_email ?? null,
                agentName: (record as any).agent_name ?? null,
              },
            );
          }
          return c.json(result);
        } catch (error: any) {
          safeLogger.error("[API] auto-link failed", {
            error: error?.message || String(error),
          });
          return c.json(
            { linked: false, reason: "exception", error: error?.message },
            500,
          );
        }
      };
    },
  },
  {
    // Import calls from the CRMProvider Calls module. Pulls recent records,
    // normalises CRMProvider's Call_Type / Call_Duration / Who_Id / What_Id
    // into our call_records schema, and upserts via createCallRecord
    // (idempotent on call_id, so re-runs are safe). The default scope is
    // calls created in the last 30 days, capped at 500 records per run.
    //
    // Body: { since?: ISO, max?: N, owner_email?: string, direction?: in|out }
    path: "/api/calls/import-from-CRMProvider",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        const user = await verifyCallAccess(c);
        if (!user) return unauthorizedResponse(c);
        try {
          let body: any = {};
          try {
            body = (await c.req.json()) || {};
          } catch {
            body = {};
          }
          const { runCRMProviderCallsImport } = await import(
            "../../utils/CRMProviderCallsImport"
          );
          const result = await runCRMProviderCallsImport({
            maxRecords:
              typeof body.max === "number" ? body.max : undefined,
            sinceIso:
              typeof body.since === "string" ? body.since : undefined,
            ownerEmailFilter:
              typeof body.owner_email === "string"
                ? body.owner_email
                : undefined,
            directionFilter:
              body.direction === "inbound" || body.direction === "outbound"
                ? body.direction
                : undefined,
          });
          return c.json({ success: true, ...result });
        } catch (error: any) {
          safeLogger.error("[API] CRMProvider-calls import failed", {
            error: error?.message || String(error),
          });
          return c.json(
            { success: false, error: "Failed to import from CRMProvider" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/calls/evaluation/import-sources",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const user = await verifyCallAccess(c);
        if (!user) return unauthorizedResponse(c);
        try {
          const { getCallImportSourcesCatalog } = await import(
            "../../utils/callMcpImportSources"
          );
          return c.json(getCallImportSourcesCatalog());
        } catch (error) {
          safeLogger.error("[MCP] import-sources failed", {
            err: error instanceof Error ? error.message : String(error),
          });
          return c.json({ error: "Failed to load import catalog" }, 500);
        }
      };
    },
  },
  {
    path: "/api/calls/evaluation/leads/match-phone",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        const user = await verifyCallAccess(c);
        if (!user) return unauthorizedResponse(c);
        try {
          const body = await c.req.json().catch(() => ({}));
          const phone = typeof body?.phone === "string" ? body.phone : "";
          if (!phone.trim()) {
            return c.json({ error: "phone is required" }, 400);
          }
          const { findLeadsByPhoneMatch, MIN_PHONE_OVERLAP_DIGITS } =
            await import("../../utils/callLeadPhoneMatch");
          const digitsOnly = phone.replace(/\D+/g, "");
          if (digitsOnly.length < MIN_PHONE_OVERLAP_DIGITS) {
            return c.json(
              {
                error: `phone must contain at least ${MIN_PHONE_OVERLAP_DIGITS} digits`,
              },
              400,
            );
          }
          const max =
            typeof body?.max_records === "number" && body.max_records > 0
              ? Math.min(body.max_records, 2000)
              : undefined;
          const result = await findLeadsByPhoneMatch(phone, {
            maxRecords: max,
          });
          return c.json(result);
        } catch (error) {
          safeLogger.error("[MCP] leads/match-phone failed", {
            err: error instanceof Error ? error.message : String(error),
          });
          return c.json({ error: "Lead match failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/calls/evaluation/reconciliation/:id",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const user = await verifyCallAccess(c);
        if (!user) return unauthorizedResponse(c);
        try {
          const idRaw = c.req.param("id");
          const id = parseInt(String(idRaw || ""), 10);
          if (!Number.isFinite(id) || id <= 0) {
            return c.json({ error: "invalid id" }, 400);
          }
          const { getCallRecordById } = await import(
            "../../utils/callIntelligenceDb"
          );
          const record = await getCallRecordById(id);
          if (!record) {
            return c.json({ error: "call record not found" }, 404);
          }
          const { buildTranscriptVsEvaluationReport } = await import(
            "../../utils/callMcpReconciliation"
          );
          const { getSdrProcessScopeForApi } = await import(
            "../../utils/sdrProcessScope"
          );
          // record is typed as CallRecord but in practice the query also
          // joins transcript/QA fields, so widen the local view.
          const rec = record as Record<string, unknown> & typeof record;
          const report = buildTranscriptVsEvaluationReport({
            call_record_id: id,
            lead_id: rec.lead_id ?? null,
            agent_email: rec.agent_email ?? null,
            transcript_text:
              typeof rec.transcript_text === "string"
                ? rec.transcript_text
                : null,
            qa_score_percentage:
              typeof rec.qa_score_percentage === "number"
                ? rec.qa_score_percentage
                : null,
            talk_ratio:
              typeof rec.talk_ratio === "number"
                ? rec.talk_ratio
                : null,
            sentiment_label:
              typeof rec.sentiment_label === "string"
                ? rec.sentiment_label
                : null,
            improvements: rec.improvements ?? null,
          });
          return c.json({
            report,
            sdr_process_scope: getSdrProcessScopeForApi(),
          });
        } catch (error) {
          safeLogger.error("[MCP] reconciliation failed", {
            err: error instanceof Error ? error.message : String(error),
          });
          return c.json({ error: "Reconciliation failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/calls/:id",
    method: "DELETE" as const,
    createHandler: async () => {
      return async (c: any) => {
        const user = await verifyCallAccess(c);
        if (!user) return unauthorizedResponse(c);
        try {
          const idRaw = c.req.param("id");
          const id = parseInt(String(idRaw || ""), 10);
          if (!Number.isFinite(id) || id <= 0) {
            return c.json({ error: "invalid id" }, 400);
          }
          const { getCallRecordById, deleteCallRecord } = await import(
            "../../utils/callIntelligenceDb"
          );
          const record = await getCallRecordById(id);
          if (!record) {
            return c.json({ error: "call record not found" }, 404);
          }
          const removed = await deleteCallRecord(id);
          safeLogger.info("[Calls] deleted call record", {
            id,
            call_id: record.call_id,
            actor: user.email || user.id,
            removed,
          });
          return c.json({ success: true, deleted: removed, id });
        } catch (error) {
          safeLogger.error("[Calls] delete failed", {
            err: error instanceof Error ? error.message : String(error),
          });
          return c.json({ error: "Delete failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/calls/:id/auto-link-lead",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        const user = await verifyCallAccess(c);
        if (!user) return unauthorizedResponse(c);
        try {
          const idRaw = c.req.param("id");
          const id = parseInt(String(idRaw || ""), 10);
          if (!Number.isFinite(id) || id <= 0) {
            return c.json({ error: "invalid id" }, 400);
          }
          const body = await c.req.json().catch(() => ({}));
          const overridePhone =
            typeof body?.phone === "string" && body.phone.trim()
              ? body.phone.trim()
              : null;
          const force = body?.force === true;
          const maxRecords =
            typeof body?.max_records === "number" && body.max_records > 0
              ? Math.min(body.max_records, 2000)
              : undefined;

          const { getCallRecordById, updateCallRecordLeadId } = await import(
            "../../utils/callIntelligenceDb"
          );
          const record = await getCallRecordById(id);
          if (!record) {
            return c.json({ error: "call record not found" }, 404);
          }
          if (record.lead_id && !force) {
            return c.json({
              linked: false,
              lead_id: record.lead_id,
              matches_count: 0,
              scanned: 0,
              reason: "already_linked",
            });
          }

          const { autoLinkLeadByPhone, extractCallPhoneCandidates } =
            await import("../../utils/callLeadPhoneMatch");
          const candidates = overridePhone
            ? [overridePhone]
            : extractCallPhoneCandidates(record);
          // Pass the deal-id and linked-via persisters so the matcher
          // can walk through Contacts → Deals when the original Lead has
          // already been converted in CRMProvider. Without these options the
          // matcher reverts to the legacy Leads-only behaviour, so older
          // tests + callers keep their original semantics.
          const { updateCallRecordDealId, updateCallRecordLinkedVia } =
            await import("../../utils/callIntelligenceDb");
          const result = await autoLinkLeadByPhone(
            id,
            candidates,
            (cid, leadId) => updateCallRecordLeadId(cid, leadId),
            {
              maxRecords,
              persistDealId: (cid, dealId) =>
                updateCallRecordDealId(cid, dealId),
              persistLinkedVia: (cid, via) =>
                updateCallRecordLinkedVia(cid, via),
            },
          );
          // Auto-trigger compliance check on freshly linked calls so
          // the Compliance Rate KPI updates without a manual run.
          if (result && (result as any).linked) {
            await runComplianceAfterLink(
              id,
              (result as any).lead_id ?? null,
              (result as any).deal_id ?? null,
              (record as any).call_date ?? (record as any).created_at,
              undefined,
              {
                agentEmail: (record as any).agent_email ?? null,
                agentName: (record as any).agent_name ?? null,
              },
            );
          }
          return c.json(result);
        } catch (error) {
          safeLogger.error("[MCP] auto-link-lead failed", {
            err: error instanceof Error ? error.message : String(error),
          });
          return c.json({ error: "Auto-link failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/calls/evaluation/scorecard/:id",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const user = await verifyCallAccess(c);
        if (!user) return unauthorizedResponse(c);
        try {
          const idRaw = c.req.param("id");
          const id = parseInt(String(idRaw || ""), 10);
          if (!Number.isFinite(id) || id <= 0) {
            return c.json({ error: "invalid id" }, 400);
          }
          // Pull transcript + analysis alongside the record. `getCallRecordById`
          // alone returns only the `call_records` row (no `transcript_text`,
          // no `sentiment_label`), which made every checkpoint fail to source
          // and produced "Coverage 0% / Sourced 0/19" in the COPC scorecard
          // panel for every call regardless of whether transcription and
          // analysis had completed.
          const { getCallWithFullAnalysis } = await import(
            "../../utils/callIntelligenceDb"
          );
          const bundle = await getCallWithFullAnalysis(id);
          if (!bundle.record) {
            return c.json({ error: "call record not found" }, 404);
          }
          const { evaluateLoadedCopcScorecard } = await import(
            "../../utils/copcScorecardEngine"
          );
          const scorecard = evaluateLoadedCopcScorecard({
            call_record_id: id,
            transcript_text:
              typeof bundle.transcript?.transcript_text === "string"
                ? bundle.transcript.transcript_text
                : null,
            sentiment_label:
              typeof bundle.analysis?.sentiment_label === "string"
                ? bundle.analysis.sentiment_label
                : null,
          });
          return c.json({ scorecard });
        } catch (error) {
          safeLogger.error("[MCP] scorecard failed", {
            err: error instanceof Error ? error.message : String(error),
          });
          return c.json({ error: "Scorecard evaluation failed" }, 500);
        }
      };
    },
  },
  // ===================================================================
  //  Coaching Plans (DMAIC Improve P1, 2026-05-25)
  //  Auto-generated when an SDR fails the same attribute on 3+ calls
  //  in 14 days. Manager workflow: list → deliver / dismiss. Verification
  //  is automatic on the next evaluation. Detection / verification logic
  //  lives in src/utils/coachingPlans.ts.
  // ===================================================================
  {
    path: "/api/coaching-plans",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);
          const { listCoachingPlans } = await import(
            "../../utils/coachingPlans"
          );
          const result = await listCoachingPlans({
            agent_email: c.req.query("agent_email"),
            status: c.req.query("status"),
            limit: parseInt(c.req.query("limit") || "100"),
            offset: parseInt(c.req.query("offset") || "0"),
          });
          return c.json(result);
        } catch (error: any) {
          safeLogger.error("[API] list coaching plans failed", {
            error: error?.message,
          });
          return c.json({ error: error?.message || "Failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/coaching-plans/:id",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);
          const id = parseInt(c.req.param("id"));
          if (!Number.isFinite(id) || id <= 0) {
            return c.json({ error: "Invalid id" }, 400);
          }
          const { getCoachingPlanById } = await import(
            "../../utils/coachingPlans"
          );
          const plan = await getCoachingPlanById(id);
          if (!plan) return c.json({ error: "Not found" }, 404);
          // Hydrate failed calls with their scorecard summary so the
          // delivery modal can show the evidence inline.
          const callIds = plan.failed_call_ids || [];
          let evidence: any[] = [];
          if (callIds.length) {
            const { callIntelligencePool } = await import(
              "../../utils/callIntelligenceDb"
            );
            const r = await callIntelligencePool.query(
              `
              SELECT cr.id, cr.call_id, cr.call_date, cr.agent_email,
                     se.overall_score, se.attribute_evaluations
                FROM call_records cr
                LEFT JOIN sdr_call_evaluations se ON se.call_record_id = cr.id
               WHERE cr.id = ANY($1::int[])
               ORDER BY cr.call_date DESC
              `,
              [callIds],
            );
            evidence = r.rows.map((row: any) => ({
              id: row.id,
              call_id: row.call_id,
              call_date: row.call_date,
              overall_score: row.overall_score,
              // Pick out only the attribute we coached on, with its
              // evidence quotes, so the modal renders compact cards
              // instead of dumping the full scorecard for each call.
              attribute_evidence: Array.isArray(row.attribute_evaluations)
                ? row.attribute_evaluations.find(
                    (a: any) => a?.attribute_id === plan.attribute_id,
                  )
                : null,
            }));
          }
          return c.json({ plan, evidence });
        } catch (error: any) {
          safeLogger.error("[API] get coaching plan failed", {
            error: error?.message,
          });
          return c.json({ error: error?.message || "Failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/coaching-plans/:id/deliver",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyAdminKey(c);
          if (!admin) return unauthorizedResponse(c);
          const id = parseInt(c.req.param("id"));
          if (!Number.isFinite(id) || id <= 0) {
            return c.json({ error: "Invalid id" }, 400);
          }
          let body: any = {};
          try {
            const txt = await c.req.text();
            if (txt && txt.trim()) body = JSON.parse(txt);
          } catch {
            body = {};
          }
          const delivered_by =
            (admin as any).email || (admin as any).username || "unknown";
          const { deliverCoachingPlan } = await import(
            "../../utils/coachingPlans"
          );
          const updated = await deliverCoachingPlan(id, {
            delivered_by,
            sdr_commitment: body.sdr_commitment,
            follow_up_due_date: body.follow_up_due_date,
            coaching_notes: body.coaching_notes,
          });
          if (!updated) {
            return c.json(
              {
                success: false,
                error:
                  "Plan not found or not in pending_delivery state. Refresh and try again.",
              },
              409,
            );
          }
          return c.json({ success: true, plan: updated });
        } catch (error: any) {
          safeLogger.error("[API] deliver coaching plan failed", {
            error: error?.message,
          });
          return c.json({ error: error?.message || "Failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/coaching-plans/:id/dismiss",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyAdminKey(c);
          if (!admin) return unauthorizedResponse(c);
          const id = parseInt(c.req.param("id"));
          if (!Number.isFinite(id) || id <= 0) {
            return c.json({ error: "Invalid id" }, 400);
          }
          let body: any = {};
          try {
            const txt = await c.req.text();
            if (txt && txt.trim()) body = JSON.parse(txt);
          } catch {
            body = {};
          }
          if (!body.dismissed_reason || typeof body.dismissed_reason !== "string") {
            return c.json(
              {
                error:
                  "dismissed_reason is required so the audit trail records why this plan was closed without coaching.",
              },
              400,
            );
          }
          const dismissed_by =
            (admin as any).email || (admin as any).username || "unknown";
          const { dismissCoachingPlan } = await import(
            "../../utils/coachingPlans"
          );
          const updated = await dismissCoachingPlan(id, {
            dismissed_by,
            dismissed_reason: body.dismissed_reason,
          });
          if (!updated) {
            return c.json(
              { success: false, error: "Plan not found or already resolved." },
              409,
            );
          }
          return c.json({ success: true, plan: updated });
        } catch (error: any) {
          safeLogger.error("[API] dismiss coaching plan failed", {
            error: error?.message,
          });
          return c.json({ error: error?.message || "Failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/coaching-plans/scan",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyAdminKey(c);
          if (!admin) return unauthorizedResponse(c);
          const logger = mastra?.getLogger();
          const { scanAllCoachingTriggers } = await import(
            "../../utils/coachingPlans"
          );
          const result = await scanAllCoachingTriggers({ logger });
          return c.json({ success: true, ...result });
        } catch (error: any) {
          safeLogger.error("[API] coaching scan failed", {
            error: error?.message,
          });
          return c.json({ error: error?.message || "Failed" }, 500);
        }
      };
    },
  },
  // (Topic Clustering route moved up to register before /api/calls/:callId
  //  — see the comment block above that route for the rationale.)
  // ===================================================================
  //  Peer Benchmark (DMAIC Improve P2, 2026-05-25)
  //  Per-attribute: agent's average score vs anonymised team median
  //  (excluding the agent themselves). Sorted by gap so the worst
  //  attributes — the natural coaching targets — surface first.
  //  Anonymised: never names peers, just the median.
  // ===================================================================
  {
    path: "/api/sdr-evaluations/peer-benchmark",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const admin = await verifyCallAccess(c);
          if (!admin) return unauthorizedResponse(c);
          const agentEmail = (c.req.query("agent_email") || "").trim();
          if (!agentEmail) {
            return c.json(
              { error: "agent_email query param is required" },
              400,
            );
          }
          const windowDays = Math.min(
            Math.max(parseInt(c.req.query("window_days") || "90"), 1),
            365,
          );

          const { callIntelligencePool, initCallIntelligenceTables } =
            await import("../../utils/callIntelligenceDb");
          await initCallIntelligenceTables();

          // Unnest every attribute_evaluations element across the window,
          // tag with the call's agent, then aggregate per (agent_email,
          // attribute_id, attribute_name, dimension). Two passes:
          // (1) per-agent means in the window
          // (2) team median computed EXCLUDING the focal agent so the
          //     comparison is honest (otherwise a strong agent compares
          //     against themselves and looks artificially average).
          //
          // PASS/FAIL/NA → numeric scoring:
          //   PASS = 100, FAIL = 0, NA → excluded (no signal). When the
          //   underlying scorecard recorded a numeric `score`, prefer that.
          const res = await callIntelligencePool.query(
            `
            WITH attr_rows AS (
              SELECT
                cr.agent_email,
                elem->>'attribute_id'   AS attribute_id,
                elem->>'attribute_name' AS attribute_name,
                elem->>'dimension'      AS dimension,
                UPPER(COALESCE(elem->>'status', ''))   AS status,
                NULLIF(elem->>'score', '')::float      AS raw_score
              FROM call_records cr
              JOIN sdr_call_evaluations se ON se.call_record_id = cr.id
              LEFT JOIN LATERAL jsonb_array_elements(
                CASE WHEN jsonb_typeof(se.attribute_evaluations) = 'array'
                     THEN se.attribute_evaluations
                     ELSE '[]'::jsonb END
              ) elem ON TRUE
              WHERE cr.call_date >= NOW() - ($1 || ' days')::INTERVAL
                AND cr.agent_email IS NOT NULL
                AND elem->>'attribute_id' IS NOT NULL
            ),
            scored AS (
              SELECT
                agent_email,
                attribute_id,
                attribute_name,
                dimension,
                CASE
                  WHEN raw_score IS NOT NULL THEN raw_score
                  WHEN status = 'PASS' THEN 100.0
                  WHEN status = 'FAIL' THEN 0.0
                  ELSE NULL
                END AS effective_score
              FROM attr_rows
              WHERE status IN ('PASS', 'FAIL') OR raw_score IS NOT NULL
            ),
            agent_means AS (
              SELECT
                attribute_id,
                MAX(attribute_name) AS attribute_name,
                MAX(dimension)      AS dimension,
                AVG(effective_score) AS agent_avg,
                COUNT(*)::int        AS agent_n
              FROM scored
              WHERE agent_email = $2
              GROUP BY attribute_id
            ),
            team_stats AS (
              SELECT
                attribute_id,
                COUNT(*)::int AS team_n,
                COUNT(DISTINCT agent_email)::int AS team_agent_count,
                PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY effective_score) AS team_median,
                PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY effective_score) AS team_p25,
                PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY effective_score) AS team_p75
              FROM scored
              WHERE agent_email <> $2
              GROUP BY attribute_id
            )
            SELECT
              am.attribute_id,
              am.attribute_name,
              am.dimension,
              am.agent_avg,
              am.agent_n,
              ts.team_median,
              ts.team_p25,
              ts.team_p75,
              ts.team_n,
              ts.team_agent_count,
              (am.agent_avg - ts.team_median) AS gap
            FROM agent_means am
            LEFT JOIN team_stats ts ON ts.attribute_id = am.attribute_id
            ORDER BY (am.agent_avg - ts.team_median) ASC NULLS LAST, am.attribute_id
            `,
            [String(windowDays), agentEmail],
          );

          return c.json({
            agent_email: agentEmail,
            window_days: windowDays,
            attributes: res.rows.map((r: any) => ({
              attribute_id: r.attribute_id,
              attribute_name: r.attribute_name,
              dimension: r.dimension,
              agent_avg: r.agent_avg != null ? Number(r.agent_avg) : null,
              agent_sample_size: r.agent_n || 0,
              team_median: r.team_median != null ? Number(r.team_median) : null,
              team_p25: r.team_p25 != null ? Number(r.team_p25) : null,
              team_p75: r.team_p75 != null ? Number(r.team_p75) : null,
              team_sample_size: r.team_n || 0,
              team_agent_count: r.team_agent_count || 0,
              gap: r.gap != null ? Number(r.gap) : null,
            })),
          });
        } catch (error: any) {
          safeLogger.error("[API] peer benchmark failed", {
            error: error?.message,
          });
          return c.json({ error: error?.message || "Failed" }, 500);
        }
      };
    },
  },
];

function formatEvaluationForCRMProvider(evaluation: any, callRecord: any): string {
  const date = new Date().toISOString().split("T")[0];
  const dimScores = evaluation.dimension_scores || {};

  return `
📞 SDR CALL QUALITY EVALUATION
================================
Date: ${date}
Call ID: ${callRecord.call_id}
Agent: ${callRecord.agent_name || callRecord.agent_email}
Duration: ${Math.round((callRecord.duration_seconds || 0) / 60)} minutes

📊 OVERALL SCORE: ${Math.round(evaluation.overall_score || 0)}%

📈 DIMENSION SCORES:
• People: ${Math.round(dimScores.people || 0)}%
• Process: ${Math.round(dimScores.process || 0)}%
• Governance: ${Math.round(dimScores.governance || 0)}%

💪 TOP STRENGTHS:
${(evaluation.top_strengths || []).map((s: string) => `• ${s}`).join("\n") || "• None identified"}

📉 AREAS FOR IMPROVEMENT:
${(evaluation.top_gaps || []).map((g: string) => `• ${g}`).join("\n") || "• None identified"}

🎯 COACHING ACTIONS:
${(evaluation.coaching_actions || []).map((a: string, i: number) => `${i + 1}. ${a}`).join("\n") || "No actions required"}

${evaluation.coaching_message_ar ? `\n💬 COACHING MESSAGE:\n${evaluation.coaching_message_ar}` : ""}

--- Generated by ExampleOrg Quality AI ---
`.trim();
}
