import { getSessionFromCookie } from "./authRoutes";
import { inngest, inngestServe } from "../inngest";
import {
  hasValidAdminApiKey,
  gateApiRoute,
  requireRole,
  forbiddenResponse,
} from "../../utils/rbacMiddleware";
import type { UserRole } from "../../utils/rbacDatabase";

import { logger as safeLogger } from "../../utils/logger";
const DASHBOARD_READ_ROLES: UserRole[] = [
  "admin",
  "quality_manager",
  "grc_manager",
  "head_of_operations_quality",
  "executive",
];
const DASHBOARD_WRITE_ROLES: UserRole[] = [
  "admin",
  "quality_manager",
  "grc_manager",
  "head_of_operations_quality",
];
const AUDIT_TRIGGER_ROLES: UserRole[] = [
  "admin",
  "quality_manager",
  "grc_manager",
  "head_of_operations_quality",
  "team_lead",
  "auditor",
  "quality_specialist",
  "ai_specialist",
  "bu_owner",
  "executive",
];

const INNGEST_PATH = "/api/inngest";
const AUDIT_TRIGGER_PATH = "/api/audit/trigger";

const dashboardGate = (route: any) => {
  if (route.path === INNGEST_PATH) return route;
  return {
    ...route,
    createHandler: async (deps: any) => {
      const originalHandler = await route.createHandler(deps);
      return async (c: any) => {
        const method = c.req.method.toUpperCase();
        let roles: UserRole[];
        if (route.path === AUDIT_TRIGGER_PATH && method === "POST") {
          roles = AUDIT_TRIGGER_ROLES;
        } else if (["POST", "PUT", "DELETE", "PATCH"].includes(method)) {
          roles = DASHBOARD_WRITE_ROLES;
        } else {
          roles = DASHBOARD_READ_ROLES;
        }
        const allowed = await requireRole(c, roles);
        if (!allowed) return forbiddenResponse(c);
        return originalHandler(c);
      };
    },
  };
};

const _dashboardApiRoutesRaw = [
  {
    path: "/api/inngest",
    method: "ALL",
    createHandler: async ({ mastra }: any) => inngestServe({ mastra, inngest }),
  },
  {
    path: "/api/dashboard",
    method: "GET",
    createHandler: async () => {
      const { getDashboardData } = await import("../../utils/database");
      // Allow only YYYY-MM-DD; anything else is treated as "no filter".
      const isoDateRe = /^\d{4}-\d{2}-\d{2}$/;
      const sanitize = (v: string | null) =>
        v && isoDateRe.test(v) ? v : null;
      return async (c: any) => {
        try {
          const startDate = sanitize(c.req.query("createdStart") || null);
          const endDate = sanitize(c.req.query("createdEnd") || null);
          const data = await getDashboardData({ startDate, endDate });
          return c.json(data);
        } catch (error) {
          safeLogger.error("Error fetching dashboard data:", error);
          return c.json({ error: "Failed to fetch dashboard data" }, 500);
        }
      };
    },
  },
  {
    path: "/api/dashboard/layouts-breakdown",
    method: "GET",
    createHandler: async () => {
      let cache: { ts: number; data: any } | null = null;
      const TTL_MS = 15 * 60 * 1000;
      return async (c: any) => {
        try {
          const force = c.req.query("force") === "1";
          if (!force && cache && Date.now() - cache.ts < TTL_MS) {
            return c.json({
              ...cache.data,
              cached: true,
              cachedAtMs: cache.ts,
            });
          }
          const { getLeads, getDeals } = await import("../../data/index");
          const [leads, deals] = await Promise.all([getLeads(), getDeals()]);
          const tally = (rows: any[]) => {
            const counts: Record<string, number> = {};
            for (const r of rows) {
              const key =
                ((r as any).Layouts || "").toString().trim() || "(No Layout)";
              counts[key] = (counts[key] || 0) + 1;
            }
            return Object.entries(counts)
              .sort((a, b) => b[1] - a[1])
              .map(([layout, count]) => ({ layout, count }));
          };
          const data = {
            leads: { total: leads.length, breakdown: tally(leads) },
            deals: { total: deals.length, breakdown: tally(deals) },
            generatedAt: new Date().toISOString(),
          };
          cache = { ts: Date.now(), data };
          return c.json({ ...data, cached: false, cachedAtMs: cache.ts });
        } catch (error) {
          safeLogger.error("Error building layouts breakdown:", error);
          return c.json({ error: "Failed to build layouts breakdown" }, 500);
        }
      };
    },
  },
  {
    path: "/api/audit/latest",
    method: "GET",
    createHandler: async () => {
      const { getLatestAuditResult } = await import("../../utils/database");
      const isoDateRe = /^\d{4}-\d{2}-\d{2}$/;
      const sanitize = (v: string | null) =>
        v && isoDateRe.test(v) ? v : null;
      return async (c: any) => {
        try {
          const startDate = sanitize(c.req.query("createdStart") || null);
          const endDate = sanitize(c.req.query("createdEnd") || null);
          const result = await getLatestAuditResult({ startDate, endDate });
          if (!result)
            return c.json({ message: "No audit results found" }, 404);
          return c.json(result);
        } catch (error) {
          safeLogger.error("Error fetching latest audit:", error);
          return c.json({ error: "Failed to fetch latest audit" }, 500);
        }
      };
    },
  },
  {
    path: "/api/audit/history",
    method: "GET",
    createHandler: async () => {
      const { getAuditHistory } = await import("../../utils/database");
      const isoDateRe = /^\d{4}-\d{2}-\d{2}$/;
      const sanitize = (v: string | null) =>
        v && isoDateRe.test(v) ? v : null;
      return async (c: any) => {
        try {
          const limit = parseInt(c.req.query("limit") || "20");
          const startDate = sanitize(c.req.query("createdStart") || null);
          const endDate = sanitize(c.req.query("createdEnd") || null);
          const history = await getAuditHistory(limit, { startDate, endDate });
          return c.json(history);
        } catch (error) {
          safeLogger.error("Error fetching audit history:", error);
          return c.json({ error: "Failed to fetch audit history" }, 500);
        }
      };
    },
  },
  {
    path: "/api/dashboard/quality-trend",
    method: "GET",
    createHandler: async () => {
      const { pool } = await import("../../utils/database");
      return async (c: any) => {
        try {
          const limit = Math.max(
            1,
            Math.min(parseInt(c.req.query("limit") || "30"), 90),
          );
          const auditsRes = await pool.query(
            `SELECT * FROM (SELECT audit_date, overall_score AS compliance_pct, total_issues_found AS records_with_issues, total_records_audited FROM quality_audit_results ORDER BY audit_date DESC LIMIT $1) latest ORDER BY audit_date ASC`,
            [limit],
          );
          const audits = auditsRes.rows.map((r: any) => ({
            date: r.audit_date,
            compliance_pct:
              r.compliance_pct == null ? null : Number(r.compliance_pct),
            records_with_issues:
              r.records_with_issues == null
                ? null
                : Number(r.records_with_issues),
            total_records_audited:
              r.total_records_audited == null
                ? null
                : Number(r.total_records_audited),
          }));
          let duplicates: any[] = [];
          try {
            const scansRes = await pool.query(
              `SELECT * FROM (SELECT completed_at, total_clusters_found, estimated_pipeline_inflation FROM duplicate_detection_logs WHERE status = 'completed' AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT $1) latest ORDER BY completed_at ASC`,
              [limit],
            );
            duplicates = scansRes.rows.map((r: any) => ({
              date: r.completed_at,
              clusters:
                r.total_clusters_found == null
                  ? null
                  : Number(r.total_clusters_found),
              pipeline_inflation_sar:
                r.estimated_pipeline_inflation == null
                  ? null
                  : Number(r.estimated_pipeline_inflation),
            }));
          } catch (e) {
            safeLogger.warn(
              "[quality-trend] duplicate_detection_logs unavailable:",
              (e as Error).message,
            );
          }
          try {
            const liveRes = await pool.query(
              `SELECT COUNT(*) FILTER (WHERE status = 'active') AS clusters, COALESCE(SUM(estimated_pipeline_value) FILTER (WHERE status = 'active'), 0) AS pipeline, MAX(updated_at) AS last_seen FROM duplicate_clusters`,
            );
            const live = liveRes.rows[0];
            if (live && live.last_seen) {
              const liveDate = new Date(live.last_seen);
              const last = duplicates[duplicates.length - 1];
              if (
                !last ||
                new Date(last.date).getTime() !== liveDate.getTime()
              ) {
                duplicates.push({
                  date: liveDate,
                  clusters: Number(live.clusters) || 0,
                  pipeline_inflation_sar: Number(live.pipeline) || 0,
                });
              }
            }
          } catch (e) {
            safeLogger.warn(
              "[quality-trend] live cluster snapshot failed:",
              (e as Error).message,
            );
          }
          if (duplicates.length > limit)
            duplicates = duplicates.slice(duplicates.length - limit);
          return c.json({ audits, duplicates });
        } catch (error) {
          safeLogger.error("Error fetching quality trend:", error);
          return c.json({ error: "Failed to fetch quality trend" }, 500);
        }
      };
    },
  },
  {
    path: "/api/dashboard/issues-category-trend",
    method: "GET",
    createHandler: async () => {
      const { pool } = await import("../../utils/database");
      return async (c: any) => {
        try {
          const limit = Math.max(
            1,
            Math.min(parseInt(c.req.query("limit") || "30"), 90),
          );
          const res = await pool.query(
            `SELECT * FROM (SELECT audit_date, issues_by_category FROM quality_audit_results ORDER BY audit_date DESC LIMIT $1) latest ORDER BY audit_date ASC`,
            [limit],
          );
          const modules = ["Deals", "Contacts", "Leads", "Accounts"];
          const dates: string[] = [];
          const series: Record<string, number[]> = {};
          modules.forEach((m) => (series[m] = []));
          for (const row of res.rows) {
            dates.push(row.audit_date);
            let raw: any = row.issues_by_category;
            if (typeof raw === "string") {
              try {
                raw = JSON.parse(raw);
              } catch {
                raw = {};
              }
            }
            const map: Record<string, number> = {};
            if (Array.isArray(raw)) {
              for (const item of raw) {
                if (item && typeof item === "object") {
                  const key =
                    item.module || item.category || item.issueType || "Other";
                  map[key] = (map[key] || 0) + (Number(item.count) || 1);
                }
              }
            } else if (raw && typeof raw === "object") {
              for (const k of Object.keys(raw)) {
                map[k] = Number(raw[k]) || 0;
              }
            }
            for (const m of modules) {
              series[m].push(map[m] || 0);
            }
          }
          return c.json({ dates, series });
        } catch (error) {
          safeLogger.error("Error fetching issues-category-trend:", error);
          return c.json({ error: "Failed to fetch category trend" }, 500);
        }
      };
    },
  },
  {
    path: "/api/scorecards",
    method: "GET",
    createHandler: async () => {
      const { getActiveScorecardsAll } = await import("../../utils/database");
      return async (c: any) => {
        try {
          const scorecards = await getActiveScorecardsAll();
          return c.json({
            success: true,
            scorecards,
            count: scorecards.length,
          });
        } catch (error) {
          safeLogger.error("Error fetching scorecards:", error);
          return c.json({ error: "Failed to fetch scorecards" }, 500);
        }
      };
    },
  },
  {
    path: "/api/integrations/status",
    method: "GET",
    createHandler: async () => {
      return async (c: any) => {
        try {
          const hasOAuthConfig = !!(
            process.env.ZOHO_CLIENT_ID &&
            process.env.ZOHO_CLIENT_SECRET &&
            process.env.ZOHO_REFRESH_TOKEN
          );
          const hasStaticToken = !!process.env.ZOHO_ACCESS_TOKEN;
          const hasGoogleCalendar = !!(
            process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_EMAIL
          );
          return c.json({
            zoho: {
              connected: hasOAuthConfig || hasStaticToken,
              message:
                hasOAuthConfig || hasStaticToken
                  ? "Connected"
                  : "Not configured",
            },
            googleCalendar: {
              connected: hasGoogleCalendar,
              message: hasGoogleCalendar ? "Connected" : "Not configured",
            },
            email: { connected: true, message: "Replit Mail configured" },
          });
        } catch (error) {
          safeLogger.error("Error checking integration status:", error);
          return c.json({ error: "Failed to check integration status" }, 500);
        }
      };
    },
  },
  {
    path: "/api/crm/data",
    method: "GET",
    createHandler: async ({ mastra }: any) => {
      const { fetchZohoRecords, getZohoConnectionStatus } =
        await import("../../utils/zohoCRM");
      return async (c: any) => {
        const logger = mastra?.getLogger();
        try {
          const ALLOWED_CRM_MODULES = new Set([
            "Leads",
            "Deals",
            "Contacts",
            "Accounts",
          ]);
          const rawModule = c.req.query("module") || "Leads";
          if (!ALLOWED_CRM_MODULES.has(rawModule)) {
            return c.json(
              {
                success: false,
                error: "Invalid module",
                message: `Module '${rawModule}' is not permitted. Allowed values: ${[...ALLOWED_CRM_MODULES].join(", ")}.`,
              },
              400,
            );
          }
          const module = rawModule;
          const page = parseInt(c.req.query("page") || "1");
          const perPage = parseInt(c.req.query("per_page") || "50");
          const status = getZohoConnectionStatus();
          if (!status.configured)
            return c.json(
              {
                success: false,
                error: "Zoho CRM not configured",
                message: status.message,
              },
              400,
            );
          const records = await fetchZohoRecords(module, { page, perPage });
          return c.json({
            success: true,
            module,
            page,
            perPage,
            count: records.length,
            records: records.map((r: any) => ({
              id: r.id,
              owner: r.owner,
              createdTime: r.createdTime,
              modifiedTime: r.modifiedTime,
              ...r.data,
            })),
          });
        } catch (error) {
          logger?.error("❌ [API] CRM data fetch error", { error });
          return c.json(
            { success: false, error: "Failed to fetch CRM data" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/crm/enrich",
    method: "POST",
    createHandler: async () => {
      const { lookupRecordsByZohoIds, runLiveQualityCheck } =
        await import("../../utils/duplicateRadarDatabase");
      return async (c: any) => {
        try {
          const body = await c.req.json();
          const records: any[] = body.records || [];
          const zohoIds = records.map((r: any) => r.id).filter(Boolean);
          const [clusterMap, qualityMap] = await Promise.all([
            lookupRecordsByZohoIds(zohoIds),
            runLiveQualityCheck(records),
          ]);
          return c.json({
            success: true,
            enrichment: Object.fromEntries(
              zohoIds.map((id: string) => [
                id,
                {
                  cluster: clusterMap[id] || null,
                  quality: qualityMap[id] || null,
                },
              ]),
            ),
          });
        } catch (error) {
          safeLogger.error("Error enriching CRM records:", error);
          return c.json(
            { success: false, error: "Failed to enrich records" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/governance",
    method: "GET",
    createHandler: async () => {
      const { getActiveGovernanceDocument } =
        await import("../../utils/database");
      return async (c: any) => {
        try {
          const doc = await getActiveGovernanceDocument();
          if (!doc)
            return c.json({ message: "No governance document found" }, 404);
          return c.json(doc);
        } catch (error) {
          safeLogger.error("Error fetching governance document:", error);
          return c.json({ error: "Failed to fetch governance document" }, 500);
        }
      };
    },
  },
  {
    path: "/api/scorecard",
    method: "GET",
    createHandler: async () => {
      const { getActiveScorecard } = await import("../../utils/database");
      return async (c: any) => {
        try {
          const crmModule = c.req.query("crm_module") || null;
          const teamName = c.req.query("team_name") || null;
          const scorecard = await getActiveScorecard(crmModule, teamName);
          if (!scorecard) return c.json({ message: "No scorecard found" }, 404);
          return c.json(scorecard);
        } catch (error) {
          safeLogger.error("Error fetching scorecard:", error);
          return c.json({ error: "Failed to fetch scorecard" }, 500);
        }
      };
    },
  },
  {
    path: "/api/audit/recommendations",
    method: "GET",
    createHandler: async () => {
      const { getLatestAuditResult } = await import("../../utils/database");
      return async (c: any) => {
        try {
          const result = await getLatestAuditResult();
          if (!result) return c.json({ recommendations: [] });
          const issuesByCategory: any[] = Array.isArray(
            result.issues_by_category,
          )
            ? result.issues_by_category
            : [];
          const recommendations = issuesByCategory.map((issue: any) => ({
            module: issue.module || issue.category || "General",
            count: issue.count || 1,
            description:
              issue.issueType ||
              issue.description ||
              issue.issue ||
              "Data quality issue detected",
            priority: (issue.count || 1) > 5 ? "high" : "medium",
          }));
          return c.json({
            recommendations,
            generatedAt: result.audit_date || new Date().toISOString(),
          });
        } catch (error) {
          safeLogger.error("Error fetching recommendations:", error);
          return c.json({ error: "Failed to fetch recommendations" }, 500);
        }
      };
    },
  },
  {
    path: "/api/audit/trigger",
    method: "POST",
    createHandler: async ({ mastra }: any) => {
      const lastTriggerTime: { value: number } = { value: 0 };
      const MIN_INTERVAL_MS = 60000;
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const session = getSessionFromCookie(c.req.header("Cookie"));
          const hasAdminKey = hasValidAdminApiKey(c);
          if (!session && !hasAdminKey)
            return c.json({ error: "Authentication required" }, 401);
          const now = Date.now();
          if (now - lastTriggerTime.value < MIN_INTERVAL_MS) {
            const waitSeconds = Math.ceil(
              (MIN_INTERVAL_MS - (now - lastTriggerTime.value)) / 1000,
            );
            return c.json(
              {
                success: false,
                error: `Please wait ${waitSeconds} seconds before triggering another audit.`,
              },
              429,
            );
          }
          const userEmail = session?.email || "admin-key";
          lastTriggerTime.value = now;

          // Read the user-selected date filter from the request body (sent
          // by runManualAudit() on the dashboard). Validate light-weight —
          // only YYYY-MM-DD strings are accepted; anything else is dropped.
          let bodyDateFilters: any = null;
          try {
            const body = await c.req.json().catch(() => null);
            const raw = body?.dateFilters;
            if (raw && typeof raw === "object") {
              const dateRe = /^\d{4}-\d{2}-\d{2}$/;
              const clean = (v: any) =>
                typeof v === "string" && dateRe.test(v) ? v : null;
              bodyDateFilters = {
                created: {
                  start: clean(raw.created?.start),
                  end: clean(raw.created?.end),
                },
                modified: {
                  start: clean(raw.modified?.start),
                  end: clean(raw.modified?.end),
                },
              };
              const any =
                bodyDateFilters.created.start ||
                bodyDateFilters.created.end ||
                bodyDateFilters.modified.start ||
                bodyDateFilters.modified.end;
              if (!any) bodyDateFilters = null;
            }
          } catch (_) {
            bodyDateFilters = null;
          }

          try {
            await inngest.send({
              name: "replit/cron.trigger",
              data: {
                workflowId: "quality-audit-workflow",
                manualTrigger: true,
                triggeredBy: userEmail,
                triggeredAt: new Date().toISOString(),
                dateFilters: bodyDateFilters,
              },
            });
          } catch (inngestError) {
            logger?.warn(
              "⚠️ [API] Inngest dispatch failed (continuing with direct execution)",
            );
          }
          (async () => {
            try {
              const { runDirectAudit } =
                await import("../../utils/directAuditRunner");
              await runDirectAudit(logger, bodyDateFilters || undefined);
            } catch (err) {
              safeLogger.error("Direct audit execution error:", err);
            }
          })();
          return c.json({
            success: true,
            message:
              "Quality audit triggered successfully. Results will appear in Audit History shortly.",
          });
        } catch (error) {
          safeLogger.error("Error triggering audit:", error);
          return c.json(
            { success: false, error: "Failed to trigger audit" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/agents/performance",
    method: "GET",
    createHandler: async () => {
      const {
        getLeadsWithSeparateFilters,
        getDealsWithSeparateFilters,
        getUsers,
        getDataMode,
      } = await import("../../data");
      let cache: { ts: number; data: any } | null = null;
      const TTL_MS = 15 * 60 * 1000;
      return async (c: any) => {
        try {
          const createdStart = c.req.query("createdStart");
          const createdEnd = c.req.query("createdEnd");
          const modifiedStart = c.req.query("modifiedStart");
          const modifiedEnd = c.req.query("modifiedEnd");
          const force = c.req.query("force") === "1";
          const includeIssues = c.req.query("includeIssues") !== "0";
          const ownerFilter = (c.req.query("owner") || "").trim().toLowerCase();
          const shapeResponse = (full: any) => {
            if (!includeIssues) {
              const { ownerIssueDetails: _omit, ...rest } = full;
              return rest;
            }
            if (ownerFilter) {
              const rows = (full.ownerIssueDetails || []).filter((i: any) => {
                const o = (i.owner || "").toLowerCase().trim();
                return (
                  o === ownerFilter ||
                  o.includes(ownerFilter) ||
                  ownerFilter.includes(o)
                );
              });
              return { ...full, ownerIssueDetails: rows };
            }
            return full;
          };
          const noFilters =
            !createdStart && !createdEnd && !modifiedStart && !modifiedEnd;
          if (noFilters && !force && cache && Date.now() - cache.ts < TTL_MS) {
            return c.json({
              ...shapeResponse(cache.data),
              cached: true,
              cachedAtMs: cache.ts,
            });
          }
          const dateFilters = {
            created: { start: createdStart || null, end: createdEnd || null },
            modified: {
              start: modifiedStart || null,
              end: modifiedEnd || null,
            },
          };
          const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
          for (const dateStr of [
            createdStart,
            createdEnd,
            modifiedStart,
            modifiedEnd,
          ].filter(Boolean)) {
            if (dateStr && !dateRegex.test(dateStr))
              return c.json(
                {
                  success: false,
                  error: `Invalid date format: ${dateStr}. Use YYYY-MM-DD`,
                },
                400,
              );
          }
          if (
            createdStart &&
            createdEnd &&
            new Date(createdStart) > new Date(createdEnd)
          )
            return c.json(
              {
                success: false,
                error:
                  "Created start date must be before or equal to created end date.",
              },
              400,
            );
          if (
            modifiedStart &&
            modifiedEnd &&
            new Date(modifiedStart) > new Date(modifiedEnd)
          )
            return c.json(
              {
                success: false,
                error:
                  "Modified start date must be before or equal to modified end date.",
              },
              400,
            );
          const mode = getDataMode();
          const { leads, coverage: leadsCoverage } =
            await getLeadsWithSeparateFilters(dateFilters);
          const { deals, coverage: dealsCoverage } =
            await getDealsWithSeparateFilters(dateFilters);
          const users = await getUsers();
          const { NAME_ALIASES } = await import("../../data/seedUsers");
          type ResolvedUser = {
            id: string;
            name: string;
            team: string;
            role: string;
            status: string;
          };
          const userMap: Record<string, ResolvedUser> = {};
          const userMapByName: Record<string, ResolvedUser> = {};
          const normName = (s: string) =>
            s.trim().replace(/\s+/g, " ").toLowerCase();
          for (const user of users) {
            const entry: ResolvedUser = {
              id: user.id,
              name: user.name,
              team: user.team,
              role: user.role,
              status: user.status,
            };
            userMap[user.id] = entry;
            if (user.name) userMapByName[normName(user.name)] = entry;
          }
          for (const [aliasRaw, canonicalRaw] of Object.entries(NAME_ALIASES)) {
            const canonical = userMapByName[normName(canonicalRaw as string)];
            if (canonical) userMapByName[normName(aliasRaw)] = canonical;
          }
          const resolveOwner = (ownerId: string): ResolvedUser | null =>
            userMap[ownerId] || userMapByName[normName(ownerId)] || null;
          const canonicalKey = (
            ownerId: string,
            resolved: ResolvedUser | null,
          ) => (resolved ? `u:${resolved.id}` : `raw:${normName(ownerId)}`);
          type IssueRow = {
            recordId: string;
            module: "Leads" | "Deals";
            owner: string;
            createdTime: string;
            createdBy: string;
            layouts: string;
            products: string;
            issue: string;
            severity: "critical" | "high" | "medium" | "low";
            fieldName: string;
            recommendation: string;
          };
          const ownerStats: Record<
            string,
            {
              id: string;
              name: string;
              team: string;
              role: string;
              status: string;
              recordsAudited: number;
              issues: {
                critical: number;
                high: number;
                medium: number;
                low: number;
              };
              passCount: number;
            }
          > = {};
          const ownerIssueDetails: IssueRow[] = [];
          const pushIssue = (row: IssueRow) => ownerIssueDetails.push(row);
          for (const lead of leads) {
            const ownerId = lead.Owner || "Unassigned";
            const resolved = resolveOwner(ownerId);
            const userInfo = resolved || {
              id: ownerId,
              name: ownerId,
              team: "Unassigned",
              role: "CRM User",
              status: "Unknown",
            };
            const key = canonicalKey(ownerId, resolved);
            if (!ownerStats[key])
              ownerStats[key] = {
                id: userInfo.id,
                name: userInfo.name,
                team: userInfo.team,
                role: userInfo.role,
                status: userInfo.status,
                recordsAudited: 0,
                issues: { critical: 0, high: 0, medium: 0, low: 0 },
                passCount: 0,
              };
            ownerStats[key].recordsAudited++;
            const hasIssue =
              !lead.Email || !lead.Lead_Source || !lead.Lead_Status;
            if (hasIssue) {
              const recordId = (lead as any).id || (lead as any).Id || "";
              const createdTime = (lead as any).Created_Time || "";
              const createdBy =
                (lead as any).Created_By?.name ||
                (lead as any).Created_By ||
                "";
              const layouts =
                (lead as any).Layout?.name || (lead as any).Layout || "";
              const ownerName = userInfo.name;
              if (!lead.Email) {
                ownerStats[key].issues.high++;
                pushIssue({
                  recordId,
                  module: "Leads",
                  owner: ownerName,
                  createdTime,
                  createdBy,
                  layouts,
                  products: "",
                  issue: "Missing Email",
                  severity: "high",
                  fieldName: "Email",
                  recommendation:
                    "Add a valid email address to enable outreach.",
                });
              }
              if (!lead.Lead_Source) {
                ownerStats[key].issues.medium++;
                pushIssue({
                  recordId,
                  module: "Leads",
                  owner: ownerName,
                  createdTime,
                  createdBy,
                  layouts,
                  products: "",
                  issue: "Missing Lead Source",
                  severity: "medium",
                  fieldName: "Lead_Source",
                  recommendation:
                    "Specify how the lead was acquired for attribution.",
                });
              }
              if (!lead.Lead_Status) {
                ownerStats[key].issues.low++;
                pushIssue({
                  recordId,
                  module: "Leads",
                  owner: ownerName,
                  createdTime,
                  createdBy,
                  layouts,
                  products: "",
                  issue: "Missing Lead Status",
                  severity: "low",
                  fieldName: "Lead_Status",
                  recommendation:
                    "Set the current lead status to track pipeline progress.",
                });
              }
            } else {
              ownerStats[key].passCount++;
            }
          }
          for (const deal of deals) {
            const ownerId = deal.Owner || "Unassigned";
            const resolved = resolveOwner(ownerId);
            const userInfo = resolved || {
              id: ownerId,
              name: ownerId,
              team: "Unassigned",
              role: "CRM User",
              status: "Unknown",
            };
            const key = canonicalKey(ownerId, resolved);
            if (!ownerStats[key])
              ownerStats[key] = {
                id: userInfo.id,
                name: userInfo.name,
                team: userInfo.team,
                role: userInfo.role,
                status: userInfo.status,
                recordsAudited: 0,
                issues: { critical: 0, high: 0, medium: 0, low: 0 },
                passCount: 0,
              };
            ownerStats[key].recordsAudited++;
            const hasIssue = !deal.Deal_Name || !deal.Stage || !deal.Amount;
            if (hasIssue) {
              const recordId = (deal as any).id || (deal as any).Id || "";
              const createdTime = (deal as any).Created_Time || "";
              const createdBy =
                (deal as any).Created_By?.name ||
                (deal as any).Created_By ||
                "";
              const layouts =
                (deal as any).Layout?.name || (deal as any).Layout || "";
              const products =
                (deal as any).Product_Name || (deal as any).Products || "";
              const ownerName = userInfo.name;
              if (!deal.Deal_Name) {
                ownerStats[key].issues.critical++;
                pushIssue({
                  recordId,
                  module: "Deals",
                  owner: ownerName,
                  createdTime,
                  createdBy,
                  layouts,
                  products,
                  issue: "Missing Deal Name",
                  severity: "critical",
                  fieldName: "Deal_Name",
                  recommendation:
                    "Every deal must have a descriptive name for identification.",
                });
              }
              if (!deal.Stage) {
                ownerStats[key].issues.critical++;
                pushIssue({
                  recordId,
                  module: "Deals",
                  owner: ownerName,
                  createdTime,
                  createdBy,
                  layouts,
                  products,
                  issue: "Missing Stage",
                  severity: "critical",
                  fieldName: "Stage",
                  recommendation:
                    "Set the pipeline stage so forecasts and reports stay accurate.",
                });
              }
              if (!deal.Amount) {
                ownerStats[key].issues.high++;
                pushIssue({
                  recordId,
                  module: "Deals",
                  owner: ownerName,
                  createdTime,
                  createdBy,
                  layouts,
                  products,
                  issue: "Missing Amount",
                  severity: "high",
                  fieldName: "Amount",
                  recommendation:
                    "Enter the deal amount to enable revenue forecasting.",
                });
              }
            } else {
              ownerStats[key].passCount++;
            }
          }
          const agents = Object.values(ownerStats)
            .filter(
              (a) => a.id && a.id !== "Unassigned" && a.recordsAudited > 0,
            )
            .map((agent) => {
              const weightedIssues =
                agent.issues.critical * 4 +
                agent.issues.high * 3 +
                agent.issues.medium * 2 +
                agent.issues.low;
              const maxWeight = agent.recordsAudited * 4;
              const score =
                maxWeight > 0
                  ? Math.max(
                      0,
                      Math.round((1 - weightedIssues / maxWeight) * 100),
                    )
                  : 100;
              return {
                id: agent.id,
                name: agent.name,
                team: agent.team,
                role: agent.role,
                status: agent.status,
                score,
                recordsAudited: agent.recordsAudited,
                issues: agent.issues,
              };
            })
            .sort((a, b) => b.score - a.score);
          const responseBody = {
            success: true,
            agents,
            ownerIssueDetails,
            totalLeads: leads.length,
            totalDeals: deals.length,
            coverage: {
              leads: leadsCoverage,
              deals: dealsCoverage,
              combined: {
                totalRecordsInCRM:
                  leadsCoverage.totalRecordsInCRM +
                  dealsCoverage.totalRecordsInCRM,
                recordsAudited:
                  leadsCoverage.recordsAudited + dealsCoverage.recordsAudited,
                recordsExcluded:
                  leadsCoverage.recordsExcluded + dealsCoverage.recordsExcluded,
                separateFiltersApplied: dateFilters,
              },
            },
          };
          if (noFilters) {
            cache = { ts: Date.now(), data: responseBody };
            return c.json({
              ...shapeResponse(responseBody),
              cached: false,
              cachedAtMs: cache.ts,
            });
          }
          return c.json(shapeResponse(responseBody));
        } catch (error: any) {
          safeLogger.error("❌ [API] Error fetching agent performance:", error);
          return c.json(
            {
              success: false,
              error: "Failed to fetch agent performance",
              agents: [],
            },
            500,
          );
        }
      };
    },
  },
];

export const dashboardApiRoutes = _dashboardApiRoutesRaw
  .map(dashboardGate)
  .map((route) => (route.path === INNGEST_PATH ? route : gateApiRoute(route)));
