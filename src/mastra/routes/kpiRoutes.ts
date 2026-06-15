import { join } from "path";
import { readFileSync, existsSync } from "fs";

import { logger as safeLogger } from "../../utils/logger";
import {
  initKPITables,
  getAllKPIDefinitions,
  getKPIsByOwner,
  getKPIById,
  createKPIDefinition,
  updateKPIDefinition,
  recordKPIValue,
  getLatestKPIValue,
  getKPIHistory,
  getKPIDashboardSummary,
  createExecutiveReport,
  getExecutiveReports,
  getExecutiveReportById,
  updateExecutiveReport,
  generateMBRData,
  seedMohammedKPIsManual,
  seedSDRKPIsManual,
} from "../../utils/kpiDatabase";

initKPITables().catch((err) =>
  safeLogger.error("[KpiRoutes] initKPITables failed", err),
);

const KPI_READ_ROLES = [
  "admin",
  "quality_manager",
  "grc_manager",
  "head_of_operations_quality",
  "executive",
] as const;
const KPI_WRITE_ROLES = [
  "admin",
  "quality_manager",
  "grc_manager",
  "head_of_operations_quality",
] as const;

export const kpiRoutes = [
  {
    path: "/kpis",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const possiblePaths = [
            join(process.cwd(), "dashboard", "kpis.html"),
            "/home/runner/workspace/dashboard/kpis.html",
          ];
          for (const p of possiblePaths) {
            if (existsSync(p)) {
              return c.html(readFileSync(p, "utf-8"));
            }
          }
          return c.text("KPI Dashboard not found", 404);
        } catch (error) {
          safeLogger.error("Error serving KPI dashboard:", error);
          return c.text("Error loading KPI dashboard", 500);
        }
      };
    },
  },
  {
    path: "/executive",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const possiblePaths = [
            join(process.cwd(), "dashboard", "executive.html"),
            "/home/runner/workspace/dashboard/executive.html",
          ];
          for (const p of possiblePaths) {
            if (existsSync(p)) {
              return c.html(readFileSync(p, "utf-8"));
            }
          }
          return c.text("Executive Dashboard not found", 404);
        } catch (error) {
          safeLogger.error("Error serving Executive dashboard:", error);
          return c.text("Error loading Executive dashboard", 500);
        }
      };
    },
  },
  {
    path: "/api/kpis",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...KPI_READ_ROLES]);
          if (!user)
            return forbiddenResponse(
              c,
              "Insufficient permissions for KPI data",
            );
          const ownerType = c.req.query("owner");
          let kpis;
          if (ownerType) {
            kpis = await getKPIsByOwner(ownerType);
          } else {
            kpis = await getAllKPIDefinitions();
          }
          return c.json(kpis);
        } catch (error) {
          safeLogger.error("Error fetching KPIs:", error);
          return c.json({ error: "Failed to fetch KPIs" }, 500);
        }
      };
    },
  },
  {
    path: "/api/kpis/summary",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...KPI_READ_ROLES]);
          if (!user)
            return forbiddenResponse(
              c,
              "Insufficient permissions for KPI data",
            );
          const summary = await getKPIDashboardSummary();
          return c.json(summary);
        } catch (error) {
          safeLogger.error("Error fetching KPI summary:", error);
          return c.json({ error: "Failed to fetch KPI summary" }, 500);
        }
      };
    },
  },
  {
    // Constrain :id to digits so literal segments like `/api/kpis/export`
    // and `/api/kpis/export-xlsx` are not swallowed by this dynamic GET
    // handler. See task-443 — without this, the KPI export endpoints were
    // shadowed and authorized roles received 400 "Invalid KPI ID" instead
    // of the export stream.
    path: "/api/kpis/:id{[0-9]+}",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...KPI_READ_ROLES]);
          if (!user)
            return forbiddenResponse(
              c,
              "Insufficient permissions for KPI data",
            );
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) {
            return c.json({ error: "Invalid KPI ID" }, 400);
          }
          const kpi = await getKPIById(id);
          if (!kpi) {
            return c.json({ error: "KPI not found" }, 404);
          }
          const latestValue = await getLatestKPIValue(id);
          const history = await getKPIHistory(id, 12);
          return c.json({ ...kpi, latestValue, history });
        } catch (error) {
          safeLogger.error("Error fetching KPI:", error);
          return c.json({ error: "Failed to fetch KPI" }, 500);
        }
      };
    },
  },
  {
    path: "/api/kpis",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...KPI_WRITE_ROLES]);
          if (!user)
            return forbiddenResponse(
              c,
              "Insufficient permissions to create KPIs",
            );
          const body = await c.req.json();
          const kpi = await createKPIDefinition(body);

          try {
            const { logEvent } = await import("../../utils/eventLogsDatabase");
            await logEvent({
              actionType: "CREATE",
              entityType: "KPI",
              entityId: String(kpi.id),
              entityName: kpi.kpi_name || kpi.kpi_code,
              description: `KPI created: ${kpi.kpi_name || kpi.kpi_code}`,
              newValue: JSON.stringify(kpi),
              module: "kpis",
              severity: "INFO",
            });
          } catch {}

          return c.json({ success: true, kpi });
        } catch (error) {
          safeLogger.error("Error creating KPI:", error);
          return c.json({ error: "Failed to create KPI" }, 500);
        }
      };
    },
  },
  {
    path: "/api/kpis/:id",
    method: "PUT" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...KPI_WRITE_ROLES]);
          if (!user)
            return forbiddenResponse(
              c,
              "Insufficient permissions to update KPIs",
            );
          const id = parseInt(c.req.param("id"));
          const body = await c.req.json();
          const kpi = await updateKPIDefinition(id, body);
          if (!kpi) {
            return c.json({ error: "KPI not found or no changes" }, 404);
          }

          try {
            const { logEvent } = await import("../../utils/eventLogsDatabase");
            await logEvent({
              actionType: "UPDATE",
              entityType: "KPI",
              entityId: String(id),
              entityName: kpi.kpi_name || kpi.kpi_code,
              description: `KPI updated: ${kpi.kpi_name || kpi.kpi_code}`,
              newValue: JSON.stringify(kpi),
              module: "kpis",
              severity: "INFO",
            });
          } catch {}

          return c.json({ success: true, kpi });
        } catch (error) {
          safeLogger.error("Error updating KPI:", error);
          return c.json({ error: "Failed to update KPI" }, 500);
        }
      };
    },
  },
  {
    path: "/api/kpis/:id/values",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...KPI_WRITE_ROLES]);
          if (!user)
            return forbiddenResponse(
              c,
              "Insufficient permissions to record KPI values",
            );
          const kpiId = parseInt(c.req.param("id"));
          const body = await c.req.json();
          const value = await recordKPIValue({ ...body, kpi_id: kpiId });

          try {
            const { logEvent } = await import("../../utils/eventLogsDatabase");
            await logEvent({
              actionType: "UPDATE",
              entityType: "KPI",
              entityId: String(kpiId),
              entityName: `KPI #${kpiId}`,
              description: `KPI value recorded for KPI #${kpiId}`,
              newValue: JSON.stringify(value),
              module: "kpis",
              severity: "INFO",
            });
          } catch {}

          return c.json({ success: true, value });
        } catch (error) {
          safeLogger.error("Error recording KPI value:", error);
          return c.json({ error: "Failed to record KPI value" }, 500);
        }
      };
    },
  },
  {
    path: "/api/kpis/:id/history",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...KPI_READ_ROLES]);
          if (!user)
            return forbiddenResponse(
              c,
              "Insufficient permissions for KPI history",
            );
          const id = parseInt(c.req.param("id"));
          const limit = parseInt(c.req.query("limit") || "12");
          const history = await getKPIHistory(id, limit);
          return c.json(history);
        } catch (error) {
          safeLogger.error("Error fetching KPI history:", error);
          return c.json({ error: "Failed to fetch KPI history" }, 500);
        }
      };
    },
  },
  {
    path: "/api/executive/reports",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...KPI_READ_ROLES]);
          if (!user)
            return forbiddenResponse(
              c,
              "Insufficient permissions for executive reports",
            );
          const reportType = c.req.query("type");
          const reports = await getExecutiveReports(reportType);
          return c.json(reports);
        } catch (error) {
          safeLogger.error("Error fetching executive reports:", error);
          return c.json({ error: "Failed to fetch reports" }, 500);
        }
      };
    },
  },
  {
    path: "/api/executive/reports",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...KPI_WRITE_ROLES]);
          if (!user)
            return forbiddenResponse(
              c,
              "Insufficient permissions to create executive reports",
            );
          const body = await c.req.json();
          const report = await createExecutiveReport(body);

          try {
            const { logEvent } = await import("../../utils/eventLogsDatabase");
            await logEvent({
              actionType: "CREATE",
              entityType: "DOCUMENT",
              entityId: String(report.id),
              entityName: report.period_name || `Report #${report.id}`,
              description: `Executive report created: ${report.period_name || report.id}`,
              newValue: JSON.stringify(report),
              module: "kpis",
              severity: "INFO",
            });
          } catch {}

          return c.json({ success: true, report });
        } catch (error) {
          safeLogger.error("Error creating executive report:", error);
          return c.json({ error: "Failed to create report" }, 500);
        }
      };
    },
  },
  {
    path: "/api/executive/reports/:id",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...KPI_READ_ROLES]);
          if (!user)
            return forbiddenResponse(
              c,
              "Insufficient permissions for executive reports",
            );
          const id = parseInt(c.req.param("id"));
          const report = await getExecutiveReportById(id);
          if (!report) {
            return c.json({ error: "Report not found" }, 404);
          }
          return c.json(report);
        } catch (error) {
          safeLogger.error("Error fetching report:", error);
          return c.json({ error: "Failed to fetch report" }, 500);
        }
      };
    },
  },
  {
    path: "/api/executive/reports/:id",
    method: "PUT" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...KPI_WRITE_ROLES]);
          if (!user)
            return forbiddenResponse(
              c,
              "Insufficient permissions to update executive reports",
            );
          const id = parseInt(c.req.param("id"));
          const body = await c.req.json();
          const report = await updateExecutiveReport(id, body);
          if (!report) {
            return c.json({ error: "Report not found" }, 404);
          }

          try {
            const { logEvent } = await import("../../utils/eventLogsDatabase");
            await logEvent({
              actionType: "UPDATE",
              entityType: "DOCUMENT",
              entityId: String(id),
              entityName: report.period_name || `Report #${id}`,
              description: `Executive report updated: ${report.period_name || id}`,
              newValue: JSON.stringify(report),
              module: "kpis",
              severity: "INFO",
            });
          } catch {}

          return c.json({ success: true, report });
        } catch (error) {
          safeLogger.error("Error updating report:", error);
          return c.json({ error: "Failed to update report" }, 500);
        }
      };
    },
  },
  {
    path: "/api/executive/mbr-data",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...KPI_READ_ROLES]);
          if (!user)
            return forbiddenResponse(
              c,
              "Insufficient permissions for MBR data",
            );
          const data = await generateMBRData();
          return c.json(data);
        } catch (error) {
          safeLogger.error("Error generating MBR data:", error);
          return c.json({ error: "Failed to generate MBR data" }, 500);
        }
      };
    },
  },
  {
    path: "/api/kpis/seed-mohammed",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, ["admin"]);
          if (!user)
            return forbiddenResponse(c, "Admin access required to seed KPIs");
          await seedMohammedKPIsManual();
          return c.json({
            success: true,
            message: "Mohammed's KPIs seeded successfully",
          });
        } catch (error) {
          safeLogger.error("Error seeding Mohammed's KPIs:", error);
          return c.json({ error: "Failed to seed KPIs" }, 500);
        }
      };
    },
  },
  {
    path: "/api/kpis/seed-sdr",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, ["admin"]);
          if (!user)
            return forbiddenResponse(c, "Admin access required to seed KPIs");
          await seedSDRKPIsManual();
          return c.json({
            success: true,
            message: "SDR Team KPIs (11) seeded successfully",
          });
        } catch (error) {
          safeLogger.error("Error seeding SDR KPIs:", error);
          return c.json({ error: "Failed to seed SDR KPIs" }, 500);
        }
      };
    },
  },
  {
    path: "/docs/screenshots/:filename",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const mastra = c.get("mastra");
        const logger = mastra?.getLogger();
        try {
          const rawFilename = c.req.param("filename");
          const filename =
            rawFilename.split("/").pop()?.split("\\").pop() || "";
          if (
            !filename ||
            filename.includes("..") ||
            filename.startsWith(".")
          ) {
            return c.text("Invalid filename", 400);
          }
          const allowedExtensions = ["png", "jpg", "jpeg", "gif", "webp"];
          const ext = filename.split(".").pop()?.toLowerCase() || "";
          if (!allowedExtensions.includes(ext)) {
            return c.text("File type not allowed", 400);
          }
          logger?.info(`📸 [Screenshots] Serving: ${filename}`);
          const possiblePaths = [
            join(process.cwd(), "docs", "screenshots", filename),
            `/home/runner/workspace/docs/screenshots/${filename}`,
          ];
          for (const p of possiblePaths) {
            if (existsSync(p)) {
              const content = readFileSync(p);
              const ext = filename.split(".").pop()?.toLowerCase();
              const mimeTypes: Record<string, string> = {
                png: "image/png",
                jpg: "image/jpeg",
                jpeg: "image/jpeg",
                gif: "image/gif",
                webp: "image/webp",
              };
              c.header("Content-Type", mimeTypes[ext || "png"] || "image/png");
              return c.body(content);
            }
          }
          return c.text("Screenshot not found", 404);
        } catch (error) {
          safeLogger.error("Error serving screenshot:", error);
          return c.text("Error loading screenshot", 500);
        }
      };
    },
  },
];
