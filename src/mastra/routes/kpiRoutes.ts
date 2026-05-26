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
    path: "/mohammed-sow",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const mastra = c.get("mastra");
        const logger = mastra?.getLogger();
        logger?.info("📋 [MohammedSOW] Serving Scope of Work page");
        try {
          const possiblePaths = [
            join(process.cwd(), "docs", "MOHAMMED_SCOPE_OF_WORK.md"),
            "/home/runner/workspace/docs/MOHAMMED_SCOPE_OF_WORK.md",
          ];
          let markdown = "";
          for (const p of possiblePaths) {
            if (existsSync(p)) {
              logger?.debug("📄 [MohammedSOW] Found markdown at:", p);
              markdown = readFileSync(p, "utf-8");
              break;
            }
          }
          if (!markdown) {
            logger?.warn("⚠️ [MohammedSOW] Markdown file not found");
            return c.text("Mohammed's Scope of Work not found", 404);
          }
          logger?.info("✅ [MohammedSOW] Successfully rendered page");

          const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Mohammed Al Muzaini - Scope of Work</title>
    <link rel="stylesheet" href="/dashboard/tailwind.css">
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <style>
        .markdown-body h1 { font-size: 2em; font-weight: bold; margin-top: 1em; margin-bottom: 0.5em; color: #1e3a8a; }
        .markdown-body h2 { font-size: 1.5em; font-weight: bold; margin-top: 1.5em; margin-bottom: 0.5em; color: #0891b2; border-bottom: 2px solid #e5e7eb; padding-bottom: 0.3em; }
        .markdown-body h3 { font-size: 1.25em; font-weight: 600; margin-top: 1em; margin-bottom: 0.5em; color: #374151; }
        .markdown-body h4 { font-size: 1.1em; font-weight: 600; margin-top: 0.8em; margin-bottom: 0.4em; }
        .markdown-body p { margin-bottom: 1em; line-height: 1.7; }
        .markdown-body ul, .markdown-body ol { margin-left: 1.5em; margin-bottom: 1em; }
        .markdown-body li { margin-bottom: 0.3em; }
        .markdown-body table { width: 100%; border-collapse: collapse; margin: 1em 0; }
        .markdown-body th, .markdown-body td { border: 1px solid #e5e7eb; padding: 0.5em 0.75em; text-align: left; }
        .markdown-body th { background-color: #f3f4f6; font-weight: 600; }
        .markdown-body tr:nth-child(even) { background-color: #f9fafb; }
        .markdown-body blockquote { border-left: 4px solid #0891b2; padding-left: 1em; margin: 1em 0; color: #4b5563; background: #f0f9ff; padding: 1em; border-radius: 0.5em; }
        .markdown-body code { background: #f3f4f6; padding: 0.2em 0.4em; border-radius: 0.25em; font-size: 0.9em; }
        .markdown-body hr { border: none; border-top: 2px solid #e5e7eb; margin: 2em 0; }
    </style>
</head>
<body class="bg-gray-50 min-h-screen">
    <div id="walaplus-nav"></div>
    <script src="/js/navigation.js"></script>
    <script>WalaPlusNav.init('mohammed-sow');</script>
    
    <div class="max-w-5xl mx-auto px-4 py-8">
        <div class="bg-white rounded-xl shadow-lg p-8">
            <div class="markdown-body" id="content"></div>
        </div>
        <div class="mt-6 text-center">
            <a href="/kpis?owner=governance_officer" class="inline-flex items-center px-6 py-3 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 transition">
                <svg class="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>
                </svg>
                View Mohammed's KPIs
            </a>
        </div>
    </div>
    
    <script>
        const markdown = ${JSON.stringify(markdown)};
        document.getElementById('content').innerHTML = marked.parse(markdown);
    </script>
</body>
</html>`;
          return c.html(html);
        } catch (error) {
          logger?.error("❌ [MohammedSOW] Error serving page:", error);
          safeLogger.error("Error serving Mohammed's SOW:", error);
          return c.text("Error loading page", 500);
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
