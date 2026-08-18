import { logger as safeLogger } from "../../utils/logger";
export const eventLogsRoutes = [
  {
    path: "/api/logs",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          logger?.info("📋 [EventLogs API] Fetching paginated logs");

          const { getSessionUser, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          if (!getSessionUser(c)) return unauthorizedResponse(c);

          const { getEventLogs, initializeEventLogsTable } =
            await import("../../utils/eventLogsDatabase");
          await initializeEventLogsTable();

          const page = parseInt(c.req.query("page") || "1");
          const pageSize = parseInt(c.req.query("pageSize") || "25");
          const userId = c.req.query("userId")
            ? parseInt(c.req.query("userId"))
            : undefined;
          const userName = c.req.query("userName");
          const actionType = c.req.query("actionType");
          const entityType = c.req.query("entityType");
          const module = c.req.query("module");
          const severity = c.req.query("severity");
          const aiInvolved =
            c.req.query("aiInvolved") !== undefined
              ? c.req.query("aiInvolved") === "true"
              : undefined;
          const fromDate = c.req.query("fromDate");
          const toDate = c.req.query("toDate");
          const search = c.req.query("search");
          const correlationId = c.req.query("correlationId");

          const result = await getEventLogs({
            page,
            pageSize,
            userId,
            userName,
            actionType,
            entityType,
            module,
            severity,
            aiInvolved,
            fromDate,
            toDate,
            search,
            correlationId,
          });

          logger?.info("📋 [EventLogs API] Logs fetched successfully", {
            count: result.logs.length,
            total: result.total,
            page: result.page,
          });
          return c.json(result);
        } catch (error) {
          safeLogger.error("Error fetching event logs:", error);
          return c.json(
            {
              error: "Failed to fetch event logs",
            },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/logs/stats",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          logger?.info("📋 [EventLogs API] Fetching log statistics");

          const { getSessionUser, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          if (!getSessionUser(c)) return unauthorizedResponse(c);

          const {
            getEventLogStats,
            initializeEventLogsTable,
            getAuditWriteHealth,
            partitionInventory,
          } = await import("../../utils/eventLogsDatabase");
          await initializeEventLogsTable();

          // `last24Hours: 0` cannot distinguish "quiet day" from "audit trail
          // is broken", which is what let the August 2026 outage run for
          // eighteen days. auditWriteHealth carries the last write failure so
          // the answer is readable without shell access to the deployment log.
          const stats = {
            ...(await getEventLogStats()),
            auditWriteHealth: {
              ...getAuditWriteHealth(),
              // The bounds of the real partitions. A gap here is what silently
              // ate 18 days of audit history, and rows sitting in
              // event_logs_default are the ones needing a later tidy-up.
              partitions: await partitionInventory(),
            },
          };

          logger?.info("📋 [EventLogs API] Stats fetched successfully", {
            totalLogs: stats.totalLogs,
            last24Hours: stats.last24Hours,
          });
          return c.json(stats);
        } catch (error) {
          safeLogger.error("Error fetching event log stats:", error);
          return c.json(
            {
              error: "Failed to fetch stats",
            },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/logs/export/estimate",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const { requireAuthOrKey, unauthorizedResponse } =
          await import("../../utils/rbacMiddleware");
        const user = requireAuthOrKey(c);
        if (!user) return unauthorizedResponse(c);

        const pg = await import("pg");
        const pool = new pg.default.Pool({
          connectionString: process.env.DATABASE_URL,
        });
        try {
          const { initializeEventLogsTable } =
            await import("../../utils/eventLogsDatabase");
          await initializeEventLogsTable();

          const userId = c.req.query("userId")
            ? parseInt(c.req.query("userId"))
            : undefined;
          const userName = c.req.query("userName");
          const actionType = c.req.query("actionType");
          const entityType = c.req.query("entityType");
          const logModule = c.req.query("module");
          const severity = c.req.query("severity");
          const aiInvolved =
            c.req.query("aiInvolved") !== undefined
              ? c.req.query("aiInvolved") === "true"
              : undefined;
          const fromDate = c.req.query("fromDate");
          const toDate = c.req.query("toDate");
          const search = c.req.query("search");
          const correlationId = c.req.query("correlationId");

          // Mirrors the WHERE construction used by /api/logs/export so the
          // estimate matches the body the client will actually receive.
          const conditions: string[] = [];
          const params: unknown[] = [];
          let i = 1;
          if (userId !== undefined) {
            conditions.push(`user_id = $${i++}`);
            params.push(userId);
          }
          if (userName) {
            conditions.push(`user_name ILIKE $${i++}`);
            params.push(`%${userName}%`);
          }
          if (actionType) {
            conditions.push(`action_type = $${i++}`);
            params.push(actionType);
          }
          if (entityType) {
            conditions.push(`entity_type = $${i++}`);
            params.push(entityType);
          }
          if (logModule) {
            conditions.push(`module = $${i++}`);
            params.push(logModule);
          }
          if (severity) {
            conditions.push(`severity = $${i++}`);
            params.push(severity);
          }
          if (aiInvolved !== undefined) {
            conditions.push(`ai_involved = $${i++}`);
            params.push(aiInvolved);
          }
          if (fromDate) {
            conditions.push(`timestamp >= $${i++}`);
            params.push(fromDate);
          }
          if (toDate) {
            conditions.push(`timestamp <= $${i++}`);
            params.push(toDate);
          }
          if (correlationId) {
            conditions.push(`correlation_id = $${i++}`);
            params.push(correlationId);
          }
          if (search) {
            conditions.push(
              `(description ILIKE $${i} OR entity_name ILIKE $${i} OR user_name ILIKE $${i})`,
            );
            params.push(`%${search}%`);
            i++;
          }

          const where =
            conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
          const r = await pool.query(
            `SELECT COUNT(*)::int AS total FROM event_logs ${where}`,
            params,
          );
          const { estimateFromCount, estimateResponse } =
            await import("../../utils/exportEstimate");
          // Event-log rows carry full description / old_value / new_value JSON
          // payloads, so the per-row average is materially higher than a
          // typical thin CSV row.
          return estimateResponse(
            estimateFromCount(r.rows[0]?.total, "csv", 600),
          );
        } catch (error) {
          safeLogger.error("Error estimating event logs export:", error);
          return c.json({ error: "Failed to estimate export size" }, 500);
        } finally {
          await pool.end();
        }
      };
    },
  },
  {
    path: "/api/logs/export",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          logger?.info("📋 [EventLogs API] Exporting logs as CSV");

          const { getSessionUser, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          if (!getSessionUser(c)) return unauthorizedResponse(c);

          const { initializeEventLogsTable } =
            await import("../../utils/eventLogsDatabase");
          await initializeEventLogsTable();

          const userId = c.req.query("userId")
            ? parseInt(c.req.query("userId"))
            : undefined;
          const userName = c.req.query("userName");
          const actionType = c.req.query("actionType");
          const entityType = c.req.query("entityType");
          const logModule = c.req.query("module");
          const severity = c.req.query("severity");
          const aiInvolved =
            c.req.query("aiInvolved") !== undefined
              ? c.req.query("aiInvolved") === "true"
              : undefined;
          const fromDate = c.req.query("fromDate");
          const toDate = c.req.query("toDate");
          const search = c.req.query("search");
          const correlationId = c.req.query("correlationId");

          // Build dynamic WHERE conditions (mirrors exportEventLogs logic)
          const conditions: string[] = [];
          const baseParams: unknown[] = [];
          let paramIndex = 1;

          if (userId !== undefined) {
            conditions.push(`user_id = $${paramIndex++}`);
            baseParams.push(userId);
          }
          if (userName) {
            conditions.push(`user_name ILIKE $${paramIndex++}`);
            baseParams.push(`%${userName}%`);
          }
          if (actionType) {
            conditions.push(`action_type = $${paramIndex++}`);
            baseParams.push(actionType);
          }
          if (entityType) {
            conditions.push(`entity_type = $${paramIndex++}`);
            baseParams.push(entityType);
          }
          if (logModule) {
            conditions.push(`module = $${paramIndex++}`);
            baseParams.push(logModule);
          }
          if (severity) {
            conditions.push(`severity = $${paramIndex++}`);
            baseParams.push(severity);
          }
          if (aiInvolved !== undefined) {
            conditions.push(`ai_involved = $${paramIndex++}`);
            baseParams.push(aiInvolved);
          }
          if (fromDate) {
            conditions.push(`timestamp >= $${paramIndex++}`);
            baseParams.push(fromDate);
          }
          if (toDate) {
            conditions.push(`timestamp <= $${paramIndex++}`);
            baseParams.push(toDate);
          }
          if (correlationId) {
            conditions.push(`correlation_id = $${paramIndex++}`);
            baseParams.push(correlationId);
          }
          if (search) {
            conditions.push(
              `(description ILIKE $${paramIndex} OR entity_name ILIKE $${paramIndex} OR user_name ILIKE $${paramIndex})`,
            );
            baseParams.push(`%${search}%`);
            paramIndex++;
          }

          const where =
            conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
          // No trailing LIMIT/OFFSET — cursorQuery streams the full result set
          // via a server-side Postgres cursor (O(n) total).
          const baseSql = `SELECT id,timestamp,user_id,user_name,user_email,user_role,action_type,entity_type,entity_id,entity_name,description,old_value,new_value,ai_involved,severity,correlation_id,ip_address,user_agent,module,checksum,created_at FROM event_logs ${where} ORDER BY timestamp DESC`;

          const pg = await import("pg");
          const logPool = new pg.default.Pool({
            connectionString: process.env.DATABASE_URL,
          });
          const { escapeCSVValue } = await import("../../utils/inputSanitizer");
          const { streamCsv, cursorQuery, stageStreamingExportFromHono } =
            await import("../../utils/excelExport");
          const logCols = [
            "id",
            "timestamp",
            "user_id",
            "user_name",
            "user_email",
            "user_role",
            "action_type",
            "entity_type",
            "entity_id",
            "entity_name",
            "description",
            "old_value",
            "new_value",
            "ai_involved",
            "severity",
            "correlation_id",
            "ip_address",
            "user_agent",
            "module",
            "checksum",
            "created_at",
          ];

          const source = cursorQuery(logPool, baseSql, baseParams);
          const mappedRows = (async function* () {
            try {
              for await (const log of source) {
                const r = log as Record<string, unknown>;
                yield logCols.map((k) => escapeCSVValue(String(r[k] ?? "")));
              }
            } finally {
              await logPool.end();
            }
          })();

          const headers = [
            "ID",
            "Timestamp",
            "User ID",
            "User Name",
            "User Email",
            "User Role",
            "Action Type",
            "Entity Type",
            "Entity ID",
            "Entity Name",
            "Description",
            "Old Value",
            "New Value",
            "AI Involved",
            "Severity",
            "Correlation ID",
            "IP Address",
            "User Agent",
            "Module",
            "Checksum",
            "Created At",
          ];

          logger?.info(
            "📋 [EventLogs API] CSV export streaming started (paged)",
          );
          return await stageStreamingExportFromHono(c, () =>
            streamCsv(
              `event_logs_${new Date().toISOString().split("T")[0]}.csv`,
              headers,
              mappedRows,
            ),
          );
        } catch (error) {
          safeLogger.error("Error exporting event logs:", error);
          return c.json(
            {
              error: "Failed to export logs",
            },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/logs/:id",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const id = parseInt(c.req.param("id"));
          logger?.info("📋 [EventLogs API] Fetching log by ID", { id });

          const { getSessionUser, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          if (!getSessionUser(c)) return unauthorizedResponse(c);

          const { getEventLogById, initializeEventLogsTable } =
            await import("../../utils/eventLogsDatabase");
          await initializeEventLogsTable();

          const eventLog = await getEventLogById(id);

          if (!eventLog) {
            logger?.info("📋 [EventLogs API] Log not found", { id });
            return c.json({ error: "Event log not found" }, 404);
          }

          logger?.info("📋 [EventLogs API] Log fetched successfully", {
            id,
            actionType: eventLog.action_type,
          });
          return c.json(eventLog);
        } catch (error) {
          safeLogger.error("Error fetching event log:", error);
          return c.json(
            {
              error: "Failed to fetch event log",
            },
            500,
          );
        }
      };
    },
  },

  {
    path: "/logs",
    method: "GET" as const,
    createHandler: async () => {
      const { readFileSync, existsSync } = await import("fs");
      const { join } = await import("path");

      return async (c: any) => {
        try {
          const possiblePaths = [
            join(process.cwd(), "dashboard", "logs.html"),
            join(process.cwd(), "..", "dashboard", "logs.html"),
            "/home/runner/workspace/dashboard/logs.html",
          ];

          for (const logsPath of possiblePaths) {
            if (existsSync(logsPath)) {
              const html = readFileSync(logsPath, "utf-8");
              return c.html(html);
            }
          }

          safeLogger.error(
            "📋 [EventLogs] Logs dashboard not found in any path:",
            possiblePaths,
          );
          return c.text("Event Logs dashboard not found", 404);
        } catch (error) {
          safeLogger.error(
            "📋 [EventLogs] Error serving Logs dashboard:",
            error,
          );
          return c.text("Error loading Event Logs dashboard", 500);
        }
      };
    },
  },
];
