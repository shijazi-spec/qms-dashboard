import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { requireRole } from "../../utils/rbacMiddleware";
import type { UserRole } from "../../utils/rbacDatabase";
import {
  listBUs, getBUByKey, upsertBU, deleteBU, setBUOwners, type Channel,
} from "../../utils/qualityReportsDepartments";
import { getBUReport, getBUHeadline } from "../../utils/qualityReportsAggregator";
import { logger } from "../../utils/logger";

// Keep in sync with the ROUTE_PERMISSION_MAP entries added for
// /quality-reports and /api/quality-reports/* in rbacMiddleware.ts.
const READ_ROLES: UserRole[] = ["admin", "ai_specialist", "auditor", "bu_owner", "custom", "department_viewer", "executive", "grc_manager", "head_of_operations_quality", "quality_manager", "quality_specialist", "team_lead", "viewer"];
const WRITE_ROLES: UserRole[] = ["admin", "grc_manager", "head_of_operations_quality", "quality_manager"];

export const qualityReportsRoutes = [
  {
    // Mirrors the /consultant page route (consultantRoutes.ts:453-471):
    // sync existsSync/readFileSync over the same two candidate paths
    // (repo-relative cwd + the Replit workspace absolute path fallback).
    path: "/quality-reports",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const possiblePaths = [
          join(process.cwd(), "dashboard", "quality-reports.html"),
          "/home/runner/workspace/dashboard/quality-reports.html",
        ];
        for (const p of possiblePaths) {
          if (existsSync(p)) {
            return c.html(readFileSync(p, "utf-8"));
          }
        }
        return c.text("Quality Reports page not found", 404);
      };
    },
  },

  {
    path: "/api/quality-reports/bus",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, READ_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);
          return c.json({ bus: await listBUs() });
        } catch (e: any) {
          logger.error("[QualityReports] list bus", e);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },

  {
    path: "/api/quality-reports/bus/:buKey",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, READ_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);
          const rep = await getBUReport(c.req.param("buKey"));
          if (!rep) return c.json({ error: "Not found" }, 404);
          return c.json({ success: true, ...rep });
        } catch (e: any) {
          logger.error("[QualityReports] bu report", e);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },

  {
    path: "/api/quality-reports/bus/:buKey/summary",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, READ_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);
          const h = await getBUHeadline(c.req.param("buKey"));
          if (!h) return c.json({ error: "Not found" }, 404);
          return c.json({ success: true, ...h });
        } catch (e: any) {
          logger.error("[QualityReports] bu headline", e);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },

  {
    path: "/api/quality-reports/bus",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, WRITE_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);
          const b = await c.req.json().catch(() => ({}));
          if (!b?.bu_key || !b?.bu_name || !["B2B", "B2C", "MP"].includes(b?.channel) || !b?.fn) {
            return c.json({ error: "bu_key, bu_name, channel(B2B|B2C|MP), fn required" }, 400);
          }
          return c.json({ bu: await upsertBU(b as { bu_key: string; bu_name: string; channel: Channel; fn: string }) });
        } catch (e: any) {
          logger.error("[QualityReports] upsert", e);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },

  {
    path: "/api/quality-reports/bus/:id",
    method: "DELETE" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, WRITE_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);
          await deleteBU(parseInt(c.req.param("id"), 10));
          return c.json({ ok: true });
        } catch (e: any) {
          logger.error("[QualityReports] delete", e);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },

  {
    path: "/api/quality-reports/bus/:id/owners",
    method: "PUT" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, WRITE_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);
          const b = await c.req.json().catch(() => ({}));
          const emails = Array.isArray(b?.owners) ? b.owners : [];
          await setBUOwners(parseInt(c.req.param("id"), 10), emails);
          return c.json({ ok: true });
        } catch (e: any) {
          logger.error("[QualityReports] owners", e);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
];
