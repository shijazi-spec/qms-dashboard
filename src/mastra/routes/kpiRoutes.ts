import { join } from "path";
import { readFileSync, existsSync } from "fs";

import { logger as safeLogger } from "../../utils/logger";
import {
  initKPITables,
  getAllKPIDefinitions,
  getKPIsByOwner,
  getKPIById,
  getKPIByCode,
  createKPIDefinition,
  updateKPIDefinition,
  recordKPIValue,
  getLatestKPIValue,
  getLatestKPIValueForQuarter,
  getKPIHistory,
  getKPIDashboardSummary,
  createExecutiveReport,
  getExecutiveReports,
  getExecutiveReportById,
  updateExecutiveReport,
  generateMBRData,
  seedMohammedKPIsManual,
  seedSDRKPIsManual,
  seedSalesKPIsManual,
} from "../../utils/kpiDatabase";
import { runKPIAutoCalc } from "../../utils/kpiAutoCalc";
import {
  initKPIChecklistTables,
  getChecklistItems,
  checklistProgress,
  addChecklistItem,
  updateChecklistItem,
  deleteChecklistItem,
  recordChecklistKPIValue,
} from "../../utils/kpiChecklistDatabase";
import {
  initKpiBuCoverageTables,
  getBuCoverage,
  buCoverageAverage,
  updateBuCoverage,
  recordBuCoverageValue,
} from "../../utils/kpiBuCoverageDatabase";

initKPITables()
  .then(() => initKPIChecklistTables())
  .then(() => initKpiBuCoverageTables())
  .catch((err) =>
    safeLogger.error("[KpiRoutes] KPI table init failed", err),
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
          // Optional ?quarter=1..4&year=YYYY → show that quarter's recorded value.
          const qn = parseInt(c.req.query("quarter") || "");
          const yr = parseInt(c.req.query("year") || "");
          const q = qn >= 1 && qn <= 4 ? { quarter: qn, year: yr || new Date().getFullYear() } : null;
          let kpis;
          if (ownerType) {
            kpis = await getKPIsByOwner(ownerType);
          } else {
            kpis = await getAllKPIDefinitions();
          }
          // Attach the recorded value to each KPI so owner-filtered cards show real
          // numbers + RAG status (parity with /api/kpis/summary). latestValue = the
          // numeric actual_value; status is separate. Quarter-scoped when ?quarter set.
          kpis = await Promise.all(
            (kpis as any[]).map(async (k) => {
              const lv = k?.id
                ? q
                  ? await getLatestKPIValueForQuarter(k.id, q.year, q.quarter)
                  : await getLatestKPIValue(k.id)
                : null;
              return {
                ...k,
                latestValue: lv ? lv.actual_value : null,
                status: lv ? lv.status : "no_data",
                trend: lv ? lv.trend : null,
                lastUpdated: lv ? lv.period_end : null,
              };
            }),
          );
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
          const qn = parseInt(c.req.query("quarter") || "");
          const yr = parseInt(c.req.query("year") || "");
          const q = qn >= 1 && qn <= 4 ? { quarter: qn, year: yr || new Date().getFullYear() } : undefined;
          const summary = await getKPIDashboardSummary(q);
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

          // Refresh the roll-up North Star composites from their components, so a
          // manual value change is reflected "from the upper data" immediately
          // (they aggregate each owner's KPIs; e.g. Legal Governance Score).
          try {
            const { recordRollupComposites } = await import(
              "../../utils/kpiAutoCalc"
            );
            await recordRollupComposites();
          } catch (e) {
            safeLogger.error("Composite refresh after value record failed:", e);
          }

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
    path: "/api/kpis/seed-sales",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, ["admin"]);
          if (!user)
            return forbiddenResponse(c, "Admin access required to seed KPIs");
          await seedSalesKPIsManual();
          return c.json({
            success: true,
            message: "Sales Team KPIs (8) seeded successfully",
          });
        } catch (error) {
          safeLogger.error("Error seeding Sales KPIs:", error);
          return c.json({ error: "Failed to seed Sales KPIs" }, 500);
        }
      };
    },
  },
  {
    // Recompute live KPI values (leadership-feed-backed Quality/GRC + checklist
    // KPIs) and record them into kpi_values so /kpis shows real numbers.
    path: "/api/kpis/recalc",
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
              "Insufficient permissions to recalculate KPIs",
            );
          // ?cycleTimes=1 forces the Zoho stage-history step (Sales cycle times)
          // on demand; default is the fast local-only recompute.
          const includeCycleTimes =
            c.req.query("cycleTimes") === "1" ||
            c.req.query("cycleTimes") === "true";
          const result = await runKPIAutoCalc(includeCycleTimes);
          return c.json({ success: true, ...result });
        } catch (error) {
          safeLogger.error("Error recalculating KPIs:", error);
          return c.json({ error: "Failed to recalculate KPIs" }, 500);
        }
      };
    },
  },
  {
    path: "/api/kpis/:id{[0-9]+}/checklist",
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
              "Insufficient permissions for KPI checklist",
            );
          const kpiId = parseInt(c.req.param("id"));
          const items = await getChecklistItems(kpiId);
          const { groupChecklistBySection, getBuSchedules } = await import(
            "../../utils/kpiChecklistDatabase"
          );
          const sections = groupChecklistBySection(items);
          // Attach each BU's start date + deadline (if set) to its section.
          const schedules = await getBuSchedules(kpiId);
          for (const s of sections as any[]) {
            const sch = s.section ? schedules[s.section] : null;
            s.start_date = sch?.start_date ?? null;
            s.deadline = sch?.deadline ?? null;
          }
          const buComplete = sections.filter(
            (s: any) => s.section && s.complete,
          ).length;
          const buTotal = sections.filter((s: any) => s.section).length;
          return c.json({
            items,
            progress: checklistProgress(items),
            sections,
            bu_summary: { complete: buComplete, total: buTotal },
          });
        } catch (error) {
          safeLogger.error("Error fetching KPI checklist:", error);
          return c.json({ error: "Failed to fetch KPI checklist" }, 500);
        }
      };
    },
  },
  {
    path: "/api/kpis/:id{[0-9]+}/checklist",
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
              "Insufficient permissions to edit KPI checklist",
            );
          const kpiId = parseInt(c.req.param("id"));
          const body = await c.req.json();
          const text = (body?.item_text || "").trim();
          if (!text) return c.json({ error: "item_text is required" }, 400);
          const by = user?.email || "system";
          const section = (body?.section || "").trim() || undefined;
          const item = await addChecklistItem(kpiId, text, by, section);
          // Re-record the KPI value so its % reflects the new item immediately.
          await recordChecklistKPIValue(kpiId);
          return c.json({ success: true, item });
        } catch (error) {
          safeLogger.error("Error adding checklist item:", error);
          return c.json({ error: "Failed to add checklist item" }, 500);
        }
      };
    },
  },
  {
    // Add a Business Unit (section) pre-filled with the standard framework action plan.
    path: "/api/kpis/:id{[0-9]+}/checklist/bu",
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
              "Insufficient permissions to edit KPI checklist",
            );
          const kpiId = parseInt(c.req.param("id"));
          const body = await c.req.json();
          const bu = (body?.name || "").trim();
          if (!bu) return c.json({ error: "BU name is required" }, 400);
          const by = user?.email || "system";
          const { addBuWithPlan } = await import(
            "../../utils/kpiChecklistDatabase"
          );
          // Seed the new BU with this KPI's own action plan (Readiness / Pilot).
          const r = await addBuWithPlan(kpiId, bu, by);
          if (r.existed) return c.json({ error: "That BU already exists" }, 409);
          await recordChecklistKPIValue(kpiId);
          return c.json({ success: true, bu, items: r.items });
        } catch (error) {
          safeLogger.error("Error adding checklist BU:", error);
          return c.json({ error: "Failed to add BU" }, 500);
        }
      };
    },
  },
  {
    // Set a BU's start date and/or deadline (per-BU schedule).
    path: "/api/kpis/:id{[0-9]+}/checklist/bu-schedule",
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
              "Insufficient permissions to edit KPI checklist",
            );
          const kpiId = parseInt(c.req.param("id"));
          const body = await c.req.json();
          const bu = (body?.bu || "").trim();
          if (!bu) return c.json({ error: "bu is required" }, 400);
          const patch: { start_date?: string | null; deadline?: string | null } = {};
          if ("start_date" in (body || {})) patch.start_date = body.start_date;
          if ("deadline" in (body || {})) patch.deadline = body.deadline;
          const { setBuSchedule } = await import(
            "../../utils/kpiChecklistDatabase"
          );
          await setBuSchedule(kpiId, bu, patch, user?.email || "system");
          return c.json({ success: true });
        } catch (error) {
          safeLogger.error("Error setting BU schedule:", error);
          return c.json({ error: "Failed to set BU schedule" }, 500);
        }
      };
    },
  },
  {
    // Rename a BU (section) across its checklist + schedule.
    path: "/api/kpis/:id{[0-9]+}/checklist/bu/rename",
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
              "Insufficient permissions to edit KPI checklist",
            );
          const kpiId = parseInt(c.req.param("id"));
          const body = await c.req.json();
          const from = (body?.from || "").trim();
          const to = (body?.to || "").trim();
          if (!from || !to) return c.json({ error: "from and to are required" }, 400);
          const { renameBu } = await import("../../utils/kpiChecklistDatabase");
          await renameBu(kpiId, from, to);
          await recordChecklistKPIValue(kpiId);
          return c.json({ success: true });
        } catch (error) {
          safeLogger.error("Error renaming BU:", error);
          return c.json({ error: "Failed to rename BU" }, 500);
        }
      };
    },
  },
  {
    // Remove a BU (section) entirely — its checklist items + schedule.
    path: "/api/kpis/:id{[0-9]+}/checklist/bu",
    method: "DELETE" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...KPI_WRITE_ROLES]);
          if (!user)
            return forbiddenResponse(
              c,
              "Insufficient permissions to edit KPI checklist",
            );
          const kpiId = parseInt(c.req.param("id"));
          const body = await c.req.json().catch(() => ({}));
          const bu = (body?.bu || "").trim();
          if (!bu) return c.json({ error: "bu is required" }, 400);
          const { removeBu } = await import("../../utils/kpiChecklistDatabase");
          await removeBu(kpiId, bu);
          await recordChecklistKPIValue(kpiId);
          return c.json({ success: true });
        } catch (error) {
          safeLogger.error("Error removing BU:", error);
          return c.json({ error: "Failed to remove BU" }, 500);
        }
      };
    },
  },
  {
    path: "/api/kpis/checklist/:itemId{[0-9]+}",
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
              "Insufficient permissions to edit KPI checklist",
            );
          const itemId = parseInt(c.req.param("itemId"));
          const body = await c.req.json();
          const by = user?.email || "system";
          const item = await updateChecklistItem(
            itemId,
            {
              item_text: body?.item_text,
              is_done: body?.is_done,
              note: body?.note,
            },
            by,
          );
          if (!item) return c.json({ error: "Checklist item not found" }, 404);
          // Recompute the parent KPI's value after a tick/edit.
          await recordChecklistKPIValue(item.kpi_id);
          // If this is the BU Framework checklist (QM-KPI-015), BU Coverage Rate
          // (QM-KPI-008) is derived from it — keep them in sync so ticking a BU's
          // phases moves its coverage % immediately (single source of truth).
          try {
            const fw = await getKPIByCode("QM-KPI-015");
            if (fw?.id === item.kpi_id) {
              const { syncBuCoverageFromChecklist } = await import(
                "../../utils/kpiBuCoverageDatabase"
              );
              await syncBuCoverageFromChecklist();
            }
          } catch (e) {
            safeLogger.error("[KpiRoutes] BU coverage sync after tick failed", e);
          }
          return c.json({ success: true, item });
        } catch (error) {
          safeLogger.error("Error updating checklist item:", error);
          return c.json({ error: "Failed to update checklist item" }, 500);
        }
      };
    },
  },
  {
    // Batch tick/untick — lets the UI flush a burst of checkbox changes in ONE
    // request instead of one-per-click (which tripped the write rate limit).
    path: "/api/kpis/checklist/batch",
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
              "Insufficient permissions to edit KPI checklist",
            );
          const body = await c.req.json().catch(() => ({}));
          const updates: Array<{ id: number; is_done: boolean }> = Array.isArray(
            body?.updates,
          )
            ? body.updates
            : [];
          if (!updates.length) return c.json({ error: "updates required" }, 400);
          if (updates.length > 500)
            return c.json({ error: "too many updates in one batch" }, 400);
          const by = user?.email || "system";
          const kpiIds = new Set<number>();
          let applied = 0;
          for (const u of updates) {
            const id = parseInt(String(u?.id), 10);
            if (!Number.isFinite(id)) continue;
            const item = await updateChecklistItem(id, { is_done: !!u.is_done }, by);
            if (item) {
              kpiIds.add(item.kpi_id);
              applied++;
            }
          }
          // Recompute each affected KPI once, and sync BU coverage if the framework
          // checklist changed (same single-source logic as the per-item route).
          for (const kpiId of kpiIds) {
            await recordChecklistKPIValue(kpiId);
            try {
              const fw = await getKPIByCode("QM-KPI-015");
              if (fw?.id === kpiId) {
                const { syncBuCoverageFromChecklist } = await import(
                  "../../utils/kpiBuCoverageDatabase"
                );
                await syncBuCoverageFromChecklist();
              }
            } catch (e) {
              safeLogger.error("[KpiRoutes] BU coverage sync after batch failed", e);
            }
          }
          return c.json({ success: true, applied });
        } catch (error) {
          safeLogger.error("Error batch-updating checklist:", error);
          return c.json({ error: "Failed to update checklist" }, 500);
        }
      };
    },
  },
  {
    path: "/api/kpis/checklist/:itemId{[0-9]+}",
    method: "DELETE" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...KPI_WRITE_ROLES]);
          if (!user)
            return forbiddenResponse(
              c,
              "Insufficient permissions to edit KPI checklist",
            );
          const itemId = parseInt(c.req.param("itemId"));
          const ok = await deleteChecklistItem(itemId);
          return c.json({ success: ok });
        } catch (error) {
          safeLogger.error("Error deleting checklist item:", error);
          return c.json({ error: "Failed to delete checklist item" }, 500);
        }
      };
    },
  },
  {
    // BU Coverage tracker (QM-KPI-008): list the BUs with completion % + due date.
    path: "/api/kpis/:id{[0-9]+}/bu-coverage",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...KPI_READ_ROLES]);
          if (!user)
            return forbiddenResponse(c, "Insufficient permissions for BU coverage");
          const kpiId = parseInt(c.req.param("id"));
          const rows = await getBuCoverage(kpiId);
          // Attach each BU's 9-phase Framework checklist (from QM-KPI-015, now the
          // hidden checklist store behind BU Coverage) so the modal can tick phases
          // per BU directly.
          let rowsOut: any[] = rows;
          try {
            const fw = await getKPIByCode("QM-KPI-015");
            if (fw?.id) {
              const { getChecklistItems } = await import(
                "../../utils/kpiChecklistDatabase"
              );
              const items = await getChecklistItems(fw.id);
              const byBU: Record<string, any[]> = {};
              for (const it of items) {
                const sec = (it.section || "").trim();
                (byBU[sec] ??= []).push({
                  id: it.id,
                  item_text: it.item_text,
                  is_done: it.is_done,
                });
              }
              rowsOut = rows.map((r: any) => ({
                ...r,
                phases: byBU[r.bu_name] || [],
              }));
            }
          } catch (e) {
            safeLogger.error("[KpiRoutes] attach BU phases failed", e);
          }
          return c.json({ rows: rowsOut, average: buCoverageAverage(rows) });
        } catch (error) {
          safeLogger.error("Error fetching BU coverage:", error);
          return c.json({ error: "Failed to fetch BU coverage" }, 500);
        }
      };
    },
  },
  {
    path: "/api/kpis/bu-coverage/:rowId{[0-9]+}",
    method: "PUT" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireRole, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const user = await requireRole(c, [...KPI_WRITE_ROLES]);
          if (!user)
            return forbiddenResponse(c, "Insufficient permissions to edit BU coverage");
          const rowId = parseInt(c.req.param("rowId"));
          const body = await c.req.json();
          const by = user?.email || "system";
          const row = await updateBuCoverage(
            rowId,
            {
              completion_pct: body?.completion_pct,
              due_date: body?.due_date,
              status: body?.status,
              note: body?.note,
            },
            by,
          );
          if (!row) return c.json({ error: "BU coverage row not found" }, 404);
          // Re-record the KPI value (avg coverage %) immediately.
          await recordBuCoverageValue(row.kpi_id);
          return c.json({ success: true, row });
        } catch (error) {
          safeLogger.error("Error updating BU coverage:", error);
          return c.json({ error: "Failed to update BU coverage" }, 500);
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
