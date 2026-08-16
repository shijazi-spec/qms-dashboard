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
    path: "/api/quality-reports/bus/:buKey/email-preview",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, READ_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);
          const { buildBUReportEmail } = await import("../../utils/qualityReportsEmail");
          const dateISO = new Date().toISOString().slice(0, 10);
          const built = await buildBUReportEmail(c.req.param("buKey"), dateISO);
          if (!built) return c.json({ error: "Not found" }, 404);
          return c.json({ success: true, subject: built.subject, html: built.html, headEmail: built.headEmail, buName: built.buName });
        } catch (error: any) {
          logger.error("[QualityReports] email preview:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/quality-reports/bus/:buKey/email",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, WRITE_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);
          const body = await c.req.json().catch(() => ({}));
          const mode = String(body?.mode || "");
          const { buildBUReportEmail, resolveEmailRecipient } = await import("../../utils/qualityReportsEmail");
          const { sendResendEmail } = await import("../../utils/resendMail");
          const dateISO = new Date().toISOString().slice(0, 10);
          const built = await buildBUReportEmail(c.req.param("buKey"), dateISO);
          if (!built) return c.json({ error: "Not found" }, 404);
          // Recipient is decided server-side ONLY — never from the request body.
          const recip = resolveEmailRecipient(mode, built.headEmail, user.email || null);
          if ("error" in recip) return c.json({ error: recip.error }, recip.status);
          const res = await sendResendEmail({ to: recip.to, subject: built.subject, html: built.html });
          logger.info("[QualityReports] email send", { actor: user.email, buKey: c.req.param("buKey"), to: recip.to, mode, ok: res.success, resendId: res.id, error: res.error });
          if (!res.success) return c.json({ success: false, error: res.error || "Email failed to send." }, 502);
          return c.json({ success: true, id: res.id, to: recip.to });
        } catch (error: any) {
          logger.error("[QualityReports] email send:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },

  {
    // Create a KPI for this BU's team. The owner is resolved SERVER-SIDE from
    // the BU mapping and never read from the body -- otherwise a client could
    // file a KPI under any team, or under none (which would surface it in the
    // GRQ KPI Engine). Same rule as the email route's recipient.
    path: "/api/quality-reports/bus/:buKey/kpis",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, WRITE_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);
          const buKey = c.req.param("buKey");
          const bu = await getBUByKey(buKey);
          if (!bu) return c.json({ error: "Not found" }, 404);
          if (!bu.kpi_owner_name) {
            return c.json(
              { error: "This business unit has no KPI owner mapped." },
              400,
            );
          }
          const b = await c.req.json().catch(() => ({}));
          const str = (v: any) => (typeof v === "string" ? v.trim() : "");
          const kpi_name = str(b?.kpi_name);
          const kpi_code = str(b?.kpi_code);
          const category = str(b?.category);
          if (!kpi_name || !kpi_code || !category) {
            return c.json(
              { error: "kpi_name, kpi_code and category are required." },
              400,
            );
          }
          const num = (v: any, d: number | null) =>
            v === null || v === undefined || v === "" ? d : Number(v);
          const { createKPIDefinition, getOwnerTypeForOwnerName } =
            await import("../../utils/kpiDatabase");
          const kpi = await createKPIDefinition({
            kpi_name,
            kpi_code,
            description: str(b?.description) || null,
            owner_name: bu.kpi_owner_name,
            owner_type: await getOwnerTypeForOwnerName(bu.kpi_owner_name),
            category,
            formula: str(b?.formula) || null,
            data_source: null,
            unit: str(b?.unit) || "%",
            frequency: str(b?.frequency) || "monthly",
            threshold_green: num(b?.threshold_green, 0),
            threshold_amber: num(b?.threshold_amber, 0),
            threshold_red: num(b?.threshold_red, 0),
            threshold_direction: str(b?.threshold_direction) || "higher_is_better",
            target_value: num(b?.target_value, null),
            weight: 1.0,
            is_active: true,
            is_north_star: false,
            calc_mode: "manual",
          } as any);
          logger.info("[QualityReports] KPI created", {
            actor: user.email, buKey, kpi_code, owner: bu.kpi_owner_name,
          });
          return c.json({ success: true, kpi });
        } catch (e: any) {
          if (e?.code === "23505") {
            return c.json({ error: "That KPI code already exists." }, 409);
          }
          logger.error("[QualityReports] create kpi", e);
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
