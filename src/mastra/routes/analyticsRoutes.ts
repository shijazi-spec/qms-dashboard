const ANALYTICS_READ_ROLES = [
  "admin",
  "quality_manager",
  "grc_manager",
  "head_of_operations_quality",
  "executive",
] as const;
const DIGEST_SEND_ROLES = ["admin", "head_of_operations_quality"] as const;

export const analyticsRoutes = [
  {
    path: "/api/analytics/cycle-times",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...ANALYTICS_READ_ROLES]);
          if (!user)
            return forbiddenResponse(
              c,
              "Insufficient permissions for analytics data",
            );
          const { getCycleTimeMetrics } =
            await import("../../utils/analyticsEngine");
          const dateFrom = c.req.query("from") || undefined;
          const dateTo = c.req.query("to") || undefined;
          const metrics = await getCycleTimeMetrics(dateFrom, dateTo);
          return c.json(metrics);
        } catch (error) {
          return c.json({ error: "Failed to fetch cycle time metrics" }, 500);
        }
      };
    },
  },
  {
    path: "/api/analytics/agent-compliance",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...ANALYTICS_READ_ROLES]);
          if (!user)
            return forbiddenResponse(
              c,
              "Insufficient permissions for analytics data",
            );
          const { getAgentComplianceReports } =
            await import("../../utils/analyticsEngine");
          const reports = await getAgentComplianceReports();
          return c.json({ reports });
        } catch (error) {
          return c.json(
            { error: "Failed to fetch agent compliance reports" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/analytics/capa-recurrence",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...ANALYTICS_READ_ROLES]);
          if (!user)
            return forbiddenResponse(
              c,
              "Insufficient permissions for analytics data",
            );
          const { detectCAPARecurrence } =
            await import("../../utils/analyticsEngine");
          const recurrences = await detectCAPARecurrence();
          return c.json({ recurrences, total: recurrences.length });
        } catch (error) {
          return c.json({ error: "Failed to detect CAPA recurrence" }, 500);
        }
      };
    },
  },
  {
    path: "/api/analytics/trends",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...ANALYTICS_READ_ROLES]);
          if (!user)
            return forbiddenResponse(
              c,
              "Insufficient permissions for analytics data",
            );
          const { getTrendData } = await import("../../utils/analyticsEngine");
          const periods = parseInt(c.req.query("periods") || "12");
          const interval =
            c.req.query("interval") === "week" ? "week" : ("month" as const);
          const trends = await getTrendData(periods, interval);
          return c.json({ trends });
        } catch (error) {
          return c.json({ error: "Failed to fetch trend data" }, 500);
        }
      };
    },
  },
  {
    path: "/api/digest/issues.xlsx",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...ANALYTICS_READ_ROLES]);
          if (!user)
            return forbiddenResponse(
              c,
              "Insufficient permissions to export digest issues",
            );

          const {
            computeDigestWindow,
            generateDigestData,
          } = await import("../../utils/executiveDigest");
          const { streamXlsx, stageStreamingExportFromHono } =
            await import("../../utils/excelExport");

          const cadenceRaw = String(c.req.query("cadence") || "weekly").toLowerCase();
          const cadence =
            cadenceRaw === "monthly" || cadenceRaw === "quarterly"
              ? cadenceRaw
              : "weekly";

          const now = new Date();
          const fallbackWindow = computeDigestWindow(cadence as any, now);
          const windowStartRaw = c.req.query("windowStart");
          const windowEndRaw = c.req.query("windowEnd");
          const requestedWindow =
            windowStartRaw && windowEndRaw
              ? {
                  cadence,
                  start: new Date(windowStartRaw),
                  end: new Date(windowEndRaw),
                  periodLabel: fallbackWindow.periodLabel,
                }
              : fallbackWindow;

          const data = await generateDigestData({
            cadence: cadence as any,
            now,
            window: requestedWindow as any,
          });

          const rows = data.finding_types.map((f) => ({
            module: f.module,
            issue_type: f.issue_type,
            severity: f.severity,
            count: f.count,
            period: data.period,
            window_start: data.window_start,
            window_end: data.window_end,
          }));

          const safeCadence = cadence.replace(/[^a-z]/gi, "_");
          const filename = `digest_issues_${safeCadence}_${Date.now()}.xlsx`;

          return await stageStreamingExportFromHono(c, async () =>
            streamXlsx(
              [
                {
                  name: "Digest Issues",
                  columns: [
                    { header: "Module", key: "module", width: 18 },
                    { header: "Issue Type", key: "issue_type", width: 40 },
                    { header: "Severity", key: "severity", width: 12 },
                    { header: "Count", key: "count", width: 10 },
                    { header: "Period", key: "period", width: 26 },
                    { header: "Window Start", key: "window_start", width: 28 },
                    { header: "Window End", key: "window_end", width: 28 },
                  ],
                  rows,
                },
              ],
              filename,
              { title: "Executive Digest Issues" },
            ),
          );
        } catch (error) {
          return c.json({ error: "Failed to export digest issues to XLSX" }, 500);
        }
      };
    },
  },
  {
    path: "/api/analytics/executive-digest",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...ANALYTICS_READ_ROLES]);
          if (!user)
            return forbiddenResponse(
              c,
              "Insufficient permissions for executive digest",
            );
          const { generateDigestData, buildDigestHTML } =
            await import("../../utils/executiveDigest");
          const format = c.req.query("format");
          const periodQuery = String(
            c.req.query("period") || "weekly",
          ).toLowerCase();
          const cadence =
            periodQuery === "monthly" || periodQuery === "quarterly"
              ? periodQuery
              : "weekly";
          const data = await generateDigestData({ cadence: cadence as any });
          if (format === "html") {
            const html = buildDigestHTML(data);
            return new Response(html, {
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
          }
          return c.json(data);
        } catch (error) {
          return c.json({ error: "Failed to generate digest" }, 500);
        }
      };
    },
  },
  {
    path: "/api/analytics/executive-digest/health",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...ANALYTICS_READ_ROLES]);
          if (!user)
            return forbiddenResponse(
              c,
              "Insufficient permissions for executive digest diagnostics",
            );
          const { getDigestDeliveryHealth } =
            await import("../../utils/executiveDigest");
          const periodQuery = String(
            c.req.query("period") || "weekly",
          ).toLowerCase();
          const cadence =
            periodQuery === "monthly" || periodQuery === "quarterly"
              ? periodQuery
              : "weekly";
          const health = await getDigestDeliveryHealth(cadence as any, new Date());
          return c.json({
            success: true,
            health,
            guidance: {
              manual_force_send_endpoint: "/api/analytics/executive-digest/send",
              manual_force_send_payload: {
                target: "slack",
                period: cadence,
                preview: false,
                force: true,
              },
            },
          });
        } catch (error) {
          return c.json(
            { error: "Failed to fetch executive digest diagnostics" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/analytics/executive-digest/runs",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...ANALYTICS_READ_ROLES]);
          if (!user)
            return forbiddenResponse(
              c,
              "Insufficient permissions for executive digest run history",
            );
          const { getRecentDigestRuns } =
            await import("../../utils/executiveDigest");
          const periodQuery = String(
            c.req.query("period") || "",
          ).toLowerCase();
          const cadence =
            periodQuery === "weekly" ||
            periodQuery === "monthly" ||
            periodQuery === "quarterly"
              ? periodQuery
              : undefined;
          const limitRaw = Number.parseInt(String(c.req.query("limit") || "30"), 10);
          const limit = Number.isFinite(limitRaw) ? limitRaw : 30;
          const runs = await getRecentDigestRuns(limit, cadence as any);
          return c.json({
            success: true,
            count: runs.length,
            runs,
          });
        } catch (error) {
          return c.json(
            { error: "Failed to fetch executive digest run history" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/analytics/executive-digest/outbox",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...ANALYTICS_READ_ROLES]);
          if (!user)
            return forbiddenResponse(
              c,
              "Insufficient permissions for notification outbox visibility",
            );
          const { getOutboxEntries } = await import("../../utils/notificationOutbox");
          const source = String(c.req.query("source") || "").trim() || undefined;
          const statusRaw = String(c.req.query("status") || "").trim().toLowerCase();
          const status =
            statusRaw === "pending" ||
            statusRaw === "processing" ||
            statusRaw === "sent" ||
            statusRaw === "failed"
              ? statusRaw
              : undefined;
          const limitRaw = Number.parseInt(String(c.req.query("limit") || "50"), 10);
          const limit = Number.isFinite(limitRaw) ? limitRaw : 50;
          const outbox = await getOutboxEntries({
            source,
            status: status as any,
            limit,
          });
          return c.json({
            success: true,
            count: outbox.length,
            outbox,
          });
        } catch (error) {
          return c.json(
            { error: "Failed to fetch notification outbox entries" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/analytics/executive-digest/outbox/process",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...DIGEST_SEND_ROLES]);
          if (!user)
            return forbiddenResponse(
              c,
              "Insufficient permissions to process notification outbox",
            );
          let body: any = {};
          try {
            body = (await c.req.json()) || {};
          } catch {
            body = {};
          }
          const limitRaw = Number.parseInt(String(body.limit || "30"), 10);
          const limit = Number.isFinite(limitRaw) ? limitRaw : 30;
          const { processDueOutboxMessages } = await import("../../utils/notificationOutbox");
          const result = await processDueOutboxMessages(limit);
          return c.json({
            success: true,
            result,
          });
        } catch (error) {
          return c.json(
            { error: "Failed to process notification outbox" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/analytics/executive-digest/send",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...DIGEST_SEND_ROLES]);
          if (!user)
            return forbiddenResponse(
              c,
              "Insufficient permissions to send executive digest",
            );
          const {
            sendDigestEmail,
            sendDigestSlack,
            runDigestFanout,
            computeDigestWindow,
          } =
            await import("../../utils/executiveDigest");
          let body: any = {};
          try {
            body = (await c.req.json()) || {};
          } catch {
            body = {};
          }
          const target = String(body.target || "email").toLowerCase();
          const period = String(body.period || "weekly").toLowerCase();
          const preview = !!body.preview;
          const force = !!body.force;
          const cadence =
            period === "monthly" || period === "quarterly"
              ? period
              : "weekly";
          const now = new Date();
          const window = computeDigestWindow(cadence as any, now);
          const enforceIdempotency = !force;
          if (target === "slack") {
            const result = await sendDigestSlack({
              cadence: cadence as any,
              now,
              window,
              preview,
              enforceIdempotency,
            });
            return c.json(result);
          }
          if (target === "both") {
            const result = await runDigestFanout(cadence as any, {
              now,
              window,
              preview,
              enforceIdempotency,
            });
            return c.json(result);
          }
          const result = await sendDigestEmail({
            cadence: cadence as any,
            now,
            window,
            enforceIdempotency,
          });
          return c.json(result);
        } catch (error) {
          return c.json({ error: "Failed to send digest" }, 500);
        }
      };
    },
  },
];
