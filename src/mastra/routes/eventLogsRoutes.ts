export const eventLogsRoutes = [
  {
    path: "/api/logs",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          logger?.info("📋 [EventLogs API] Fetching paginated logs");

          const { getEventLogs, initializeEventLogsTable } = await import("../../utils/eventLogsDatabase");
          await initializeEventLogsTable();

          const page = parseInt(c.req.query("page") || "1");
          const pageSize = parseInt(c.req.query("pageSize") || "25");
          const userId = c.req.query("userId") ? parseInt(c.req.query("userId")) : undefined;
          const userName = c.req.query("userName");
          const actionType = c.req.query("actionType");
          const entityType = c.req.query("entityType");
          const module = c.req.query("module");
          const severity = c.req.query("severity");
          const aiInvolved = c.req.query("aiInvolved") !== undefined 
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
            correlationId
          });

          logger?.info("📋 [EventLogs API] Logs fetched successfully", { 
            count: result.logs.length, 
            total: result.total,
            page: result.page 
          });
          return c.json(result);
        } catch (error) {
          console.error("Error fetching event logs:", error);
          return c.json({ 
            error: error instanceof Error ? error.message : "Failed to fetch event logs" 
          }, 500);
        }
      };
    }
  },
  {
    path: "/api/logs/stats",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          logger?.info("📋 [EventLogs API] Fetching log statistics");

          const { getEventLogStats, initializeEventLogsTable } = await import("../../utils/eventLogsDatabase");
          await initializeEventLogsTable();

          const stats = await getEventLogStats();

          logger?.info("📋 [EventLogs API] Stats fetched successfully", { 
            totalLogs: stats.totalLogs,
            last24Hours: stats.last24Hours 
          });
          return c.json(stats);
        } catch (error) {
          console.error("Error fetching event log stats:", error);
          return c.json({ 
            error: error instanceof Error ? error.message : "Failed to fetch stats" 
          }, 500);
        }
      };
    }
  },
  {
    path: "/api/logs/export",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          logger?.info("📋 [EventLogs API] Exporting logs as CSV");

          const { exportEventLogs, initializeEventLogsTable } = await import("../../utils/eventLogsDatabase");
          await initializeEventLogsTable();

          const userId = c.req.query("userId") ? parseInt(c.req.query("userId")) : undefined;
          const userName = c.req.query("userName");
          const actionType = c.req.query("actionType");
          const entityType = c.req.query("entityType");
          const module = c.req.query("module");
          const severity = c.req.query("severity");
          const aiInvolved = c.req.query("aiInvolved") !== undefined 
            ? c.req.query("aiInvolved") === "true" 
            : undefined;
          const fromDate = c.req.query("fromDate");
          const toDate = c.req.query("toDate");
          const search = c.req.query("search");
          const correlationId = c.req.query("correlationId");

          const logs = await exportEventLogs({
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
            correlationId
          });

          const headers = [
            'ID', 'Timestamp', 'User ID', 'User Name', 'User Email', 'User Role',
            'Action Type', 'Entity Type', 'Entity ID', 'Entity Name', 'Description',
            'Old Value', 'New Value', 'AI Involved', 'Severity', 'Correlation ID',
            'IP Address', 'User Agent', 'Module', 'Checksum', 'Created At'
          ];

          const escapeCSV = (value: any): string => {
            if (value === null || value === undefined) return '';
            const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
            if (str.includes(',') || str.includes('"') || str.includes('\n')) {
              return `"${str.replace(/"/g, '""')}"`;
            }
            return str;
          };

          const csvRows = [headers.join(',')];
          for (const log of logs) {
            const row = [
              log.id,
              log.timestamp,
              log.user_id,
              log.user_name,
              log.user_email,
              log.user_role,
              log.action_type,
              log.entity_type,
              log.entity_id,
              log.entity_name,
              log.description,
              log.old_value,
              log.new_value,
              log.ai_involved,
              log.severity,
              log.correlation_id,
              log.ip_address,
              log.user_agent,
              log.module,
              log.checksum,
              log.created_at
            ].map(escapeCSV);
            csvRows.push(row.join(','));
          }

          const csvContent = csvRows.join('\n');

          logger?.info("📋 [EventLogs API] CSV export completed", { rowCount: logs.length });

          return new Response(csvContent, {
            headers: {
              'Content-Type': 'text/csv',
              'Content-Disposition': `attachment; filename="event_logs_${new Date().toISOString().split('T')[0]}.csv"`
            }
          });
        } catch (error) {
          console.error("Error exporting event logs:", error);
          return c.json({ 
            error: error instanceof Error ? error.message : "Failed to export logs" 
          }, 500);
        }
      };
    }
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

          const { getEventLogById, initializeEventLogsTable } = await import("../../utils/eventLogsDatabase");
          await initializeEventLogsTable();

          const eventLog = await getEventLogById(id);

          if (!eventLog) {
            logger?.info("📋 [EventLogs API] Log not found", { id });
            return c.json({ error: "Event log not found" }, 404);
          }

          logger?.info("📋 [EventLogs API] Log fetched successfully", { 
            id, 
            actionType: eventLog.action_type 
          });
          return c.json(eventLog);
        } catch (error) {
          console.error("Error fetching event log:", error);
          return c.json({ 
            error: error instanceof Error ? error.message : "Failed to fetch event log" 
          }, 500);
        }
      };
    }
  },
  {
    path: "/api/logs",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const data = await c.req.json();
          logger?.info("📋 [EventLogs API] Creating new log entry", { 
            actionType: data.actionType,
            entityType: data.entityType 
          });

          const { logEvent, initializeEventLogsTable } = await import("../../utils/eventLogsDatabase");
          await initializeEventLogsTable();

          if (!data.actionType || !data.entityType) {
            return c.json({ 
              error: "Missing required fields: actionType, entityType" 
            }, 400);
          }

          const eventLog = await logEvent({
            userId: data.userId,
            userName: data.userName,
            userEmail: data.userEmail,
            userRole: data.userRole,
            actionType: data.actionType,
            entityType: data.entityType,
            entityId: data.entityId,
            entityName: data.entityName,
            description: data.description,
            oldValue: data.oldValue,
            newValue: data.newValue,
            aiInvolved: data.aiInvolved,
            severity: data.severity,
            correlationId: data.correlationId,
            ipAddress: data.ipAddress,
            userAgent: data.userAgent,
            module: data.module
          });

          logger?.info("📋 [EventLogs API] Log entry created successfully", { id: eventLog.id });
          return c.json(eventLog, 201);
        } catch (error) {
          console.error("Error creating event log:", error);
          return c.json({ 
            error: error instanceof Error ? error.message : "Failed to create event log" 
          }, 500);
        }
      };
    }
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
          
          console.error("📋 [EventLogs] Logs dashboard not found in any path:", possiblePaths);
          return c.text("Event Logs dashboard not found", 404);
        } catch (error) {
          console.error("📋 [EventLogs] Error serving Logs dashboard:", error);
          return c.text("Error loading Event Logs dashboard", 500);
        }
      };
    }
  }
];
