import type { Pool as PgPool } from "pg";
import {
  streamCsv,
  stageStreamingExportFromHono,
} from "../../utils/excelExport";
import { escapeCSVValue } from "../../utils/inputSanitizer";
import {
  gateApiRoute,
  requireRole,
  forbiddenResponse,
  QMS_ROLES,
} from "../../utils/rbacMiddleware";
import type { UserRole } from "../../utils/rbacDatabase";

import { logger } from "../../utils/logger";
const QMS_GOVERNANCE_READ: UserRole[] = [
  "admin",
  "quality_manager",
  "grc_manager",
  "head_of_operations_quality",
  "executive",
];
const QMS_GOVERNANCE_WRITE: UserRole[] = [
  "admin",
  "quality_manager",
  "grc_manager",
  "head_of_operations_quality",
];
const QMS_CLOSURE_ROLES: UserRole[] = [
  "admin",
  "quality_manager",
  "head_of_operations_quality",
];
const QMS_CAPA_PATCH_ROLES: UserRole[] = [
  "admin",
  "quality_manager",
  "grc_manager",
  "head_of_operations_quality",
  "auditor",
];
const EVIDENCE_READ_ROLES: UserRole[] = [
  "admin",
  "quality_manager",
  "grc_manager",
  "head_of_operations_quality",
  "auditor",
  "quality_specialist",
  "team_lead",
  "bu_owner",
  "ai_specialist",
  "executive",
];
const EVIDENCE_DELETE_ROLES: UserRole[] = [
  "admin",
  "quality_manager",
  "grc_manager",
  "head_of_operations_quality",
];

function qmsGate<
  T extends { path: string; method: string; createHandler: (deps: any) => any },
>(route: T): T {
  if (!route.path.startsWith("/api/")) return route;

  let roles: UserRole[];
  const p = route.path;
  const m = route.method;
  if (
    p === "/api/pdpl/export" ||
    p === "/api/pdpl/export/estimate" ||
    p === "/api/pdpl/export-xlsx/estimate"
  ) {
    roles = ["admin"];
  } else if (
    p.startsWith("/api/qms/nc/export") ||
    p.startsWith("/api/qms/capa/export") ||
    p.startsWith("/api/qms/capa-export-xlsx") ||
    p.startsWith("/api/compliance/export") ||
    p.startsWith("/api/vendors/export") ||
    p.startsWith("/api/kpis/export")
  ) {
    roles = p.startsWith("/api/kpis/export")
      ? QMS_GOVERNANCE_READ
      : QMS_GOVERNANCE_WRITE;
  } else if (
    (p.endsWith("/approve-closure") || p.endsWith("/effectiveness")) &&
    m === "POST"
  ) {
    roles = QMS_CLOSURE_ROLES;
  } else if (p.match(/^\/api\/qms\/capa\/:[^/]+$/) && m === "PATCH") {
    roles = QMS_CAPA_PATCH_ROLES;
  } else if (p === "/api/evidence-pack" || p === "/api/evidence-summary") {
    roles = [
      "admin",
      "quality_manager",
      "grc_manager",
      "head_of_operations_quality",
      "auditor",
      "quality_specialist",
    ];
  } else if (m === "DELETE" && p.startsWith("/api/evidence/")) {
    roles = EVIDENCE_DELETE_ROLES;
  } else if (p.startsWith("/api/evidence")) {
    roles = EVIDENCE_READ_ROLES;
  } else {
    roles = QMS_GOVERNANCE_WRITE;
  }

  const originalCreate = route.createHandler;
  return {
    ...route,
    createHandler: async (deps: any) => {
      const inner = await originalCreate(deps);
      return async (c: any) => {
        const user = await requireRole(c, roles);
        if (!user)
          return forbiddenResponse(c, "Insufficient permissions for QMS data");
        return inner(c);
      };
    },
  };
}

const evidenceRoutes = [
  {
    path: "/api/evidence/:entityType/:entityId",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const entityType = c.req.param("entityType");
          const entityId = parseInt(c.req.param("entityId"));
          if (isNaN(entityId))
            return c.json({ error: "Invalid entity ID" }, 400);
          const { getEvidenceForEntity, initEvidenceTables } =
            await import("../../utils/evidenceDatabase");
          await initEvidenceTables();
          const evidence = await getEvidenceForEntity(entityType, entityId);
          return c.json({ evidence });
        } catch (error) {
          return c.json({ error: "Failed to fetch evidence" }, 500);
        }
      };
    },
  },
  {
    path: "/api/evidence",
    method: "POST" as const,
    roles: QMS_ROLES,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const body = await c.req.json();
          if (
            !body.entityType ||
            !body.entityId ||
            !body.filename ||
            !body.uploadedBy
          ) {
            return c.json(
              {
                error:
                  "entityType, entityId, filename, and uploadedBy are required",
              },
              400,
            );
          }
          const { addEvidence, initEvidenceTables } =
            await import("../../utils/evidenceDatabase");
          await initEvidenceTables();
          const record = await addEvidence({
            entity_type: body.entityType,
            entity_id: body.entityId,
            filename: body.filename,
            original_filename: body.originalFilename || body.filename,
            file_type: body.fileType || "unknown",
            file_size: body.fileSize || 0,
            uploaded_by: body.uploadedBy,
            description: body.description,
            metadata: body.metadata,
          });
          try {
            const { logEvent } = await import("../../utils/eventLogsDatabase");
            await logEvent({
              actionType: "CREATE",
              entityType: "DOCUMENT",
              entityId: String(record.id),
              description: `Evidence uploaded: ${body.filename} for ${body.entityType} #${body.entityId}`,
              module: "evidence",
              severity: "INFO",
            });
          } catch {}
          return c.json({ success: true, evidence: record });
        } catch (error) {
          return c.json({ error: "Failed to add evidence" }, 500);
        }
      };
    },
  },
  {
    path: "/api/evidence/:id",
    method: "DELETE" as const,
    roles: QMS_ROLES,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
          const { deleteEvidence, initEvidenceTables } =
            await import("../../utils/evidenceDatabase");
          await initEvidenceTables();
          const deleted = await deleteEvidence(id);
          if (!deleted) return c.json({ error: "Evidence not found" }, 404);
          return c.json({ success: true });
        } catch (error) {
          return c.json({ error: "Failed to delete evidence" }, 500);
        }
      };
    },
  },
  {
    path: "/api/evidence-pack",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const entityType = c.req.query("entityType");
          const dateFrom = c.req.query("dateFrom");
          const dateTo = c.req.query("dateTo");
          const entityIdsParam = c.req.query("entityIds");
          const entityIds = entityIdsParam
            ? entityIdsParam
                .split(",")
                .map(Number)
                .filter((n: number) => !isNaN(n))
            : undefined;
          const { getEvidencePack, initEvidenceTables } =
            await import("../../utils/evidenceDatabase");
          await initEvidenceTables();
          const evidence = await getEvidencePack({
            entityType,
            entityIds,
            dateFrom,
            dateTo,
          });
          return c.json({ evidence, total: evidence.length });
        } catch (error) {
          return c.json({ error: "Failed to compile evidence pack" }, 500);
        }
      };
    },
  },
  {
    path: "/api/evidence-summary",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { getEvidenceSummary, initEvidenceTables } =
            await import("../../utils/evidenceDatabase");
          await initEvidenceTables();
          const summary = await getEvidenceSummary();
          return c.json({ summary });
        } catch (error) {
          return c.json({ error: "Failed to get evidence summary" }, 500);
        }
      };
    },
  },
  {
    path: "/api/qms/capa/:id",
    method: "PATCH" as const,
    roles: QMS_ROLES,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
          const body = await c.req.json();
          const { updateCapaRecord } = await import("../../utils/qmsDatabase");
          const updates: any = {};
          if (body.status) updates.status = body.status;
          if (body.assigned_to) updates.assigned_to = body.assigned_to;
          if (body.severity) updates.severity = body.severity;
          if (body.priority) updates.priority = body.priority;
          const result = await updateCapaRecord(id, updates);
          if (!result) return c.json({ error: "CAPA not found" }, 404);
          try {
            const { logEvent } = await import("../../utils/eventLogsDatabase");
            await logEvent({
              actionType: "UPDATE",
              entityType: "CAPA",
              entityId: String(id),
              description: `CAPA updated: ${JSON.stringify(updates)}`,
              module: "qms",
              severity: "INFO",
              newValue: JSON.stringify(updates),
            });
          } catch {}
          return c.json({ success: true, capa: result });
        } catch (error) {
          return c.json({ error: "Failed to update CAPA" }, 500);
        }
      };
    },
  },
];

/**
 * Helper that runs a single COUNT(*) and returns an estimate Response.
 * Falls back to a zero-row estimate if the COUNT itself fails (e.g. table
 * not yet provisioned), so the client UX still works on empty installs.
 */
async function qmsEstimateResponse(
  countSql: string,
  params: unknown[],
  format: "csv" | "xlsx",
  avgBytesPerRow?: number,
): Promise<Response> {
  const pg = await import("pg");
  const pool = new pg.default.Pool({
    connectionString: process.env.DATABASE_URL,
  });
  try {
    const { estimateFromCount, estimateResponse } =
      await import("../../utils/exportEstimate");
    const r = await pool.query(countSql, params);
    return estimateResponse(
      estimateFromCount(r.rows[0]?.total, format, avgBytesPerRow),
    );
  } finally {
    await pool.end();
  }
}

const _qmsEnhancedRoutesRaw = [
  ...evidenceRoutes,
  {
    path: "/api/qms/nc/export/estimate",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      try {
        return await qmsEstimateResponse(
          `SELECT COUNT(*)::int AS total FROM nonconformance_records`,
          [],
          "csv",
        );
      } catch (e) {
        logger.error("NC CSV estimate error:", e);
        return c.json({ error: "Failed to estimate export size" }, 500);
      }
    },
  },
  {
    path: "/api/qms/capa/export/estimate",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      try {
        return await qmsEstimateResponse(
          `SELECT COUNT(*)::int AS total FROM capa_records`,
          [],
          "csv",
        );
      } catch (e) {
        logger.error("CAPA CSV estimate error:", e);
        return c.json({ error: "Failed to estimate export size" }, 500);
      }
    },
  },
  {
    path: "/api/compliance/export/estimate",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      try {
        const { initComplianceTables } =
          await import("../../utils/complianceDatabase");
        await initComplianceTables();
        return await qmsEstimateResponse(
          `SELECT COUNT(*)::int AS total FROM obligations`,
          [],
          "csv",
        );
      } catch (e) {
        logger.error("Compliance estimate error:", e);
        return c.json({ error: "Failed to estimate export size" }, 500);
      }
    },
  },
  {
    path: "/api/pdpl/export/estimate",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      try {
        const { initPdplTables } = await import("../../utils/pdplDatabase");
        await initPdplTables();
        return await qmsEstimateResponse(
          `SELECT COUNT(*)::int AS total FROM data_inventory`,
          [],
          "csv",
        );
      } catch (e) {
        logger.error("PDPL estimate error:", e);
        return c.json({ error: "Failed to estimate export size" }, 500);
      }
    },
  },
  {
    path: "/api/compliance/export-xlsx/estimate",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      try {
        const { requireAdminOrKey, unauthorizedResponse } =
          await import("../../utils/rbacMiddleware");
        if (!(await requireAdminOrKey(c))) return unauthorizedResponse(c);
        const { initComplianceTables } =
          await import("../../utils/complianceDatabase");
        await initComplianceTables();
        return await qmsEstimateResponse(
          `SELECT COUNT(*)::int AS total FROM obligations`,
          [],
          "xlsx",
          200,
        );
      } catch (e) {
        logger.error("Compliance XLSX estimate error:", e);
        return c.json({ error: "Failed to estimate export size" }, 500);
      }
    },
  },
  {
    path: "/api/pdpl/export-xlsx/estimate",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      try {
        const { requireAdminOrKey, unauthorizedResponse } =
          await import("../../utils/rbacMiddleware");
        if (!(await requireAdminOrKey(c))) return unauthorizedResponse(c);
        const { initPdplTables } = await import("../../utils/pdplDatabase");
        await initPdplTables();
        return await qmsEstimateResponse(
          `SELECT COUNT(*)::int AS total FROM data_inventory`,
          [],
          "xlsx",
          200,
        );
      } catch (e) {
        logger.error("PDPL XLSX estimate error:", e);
        return c.json({ error: "Failed to estimate export size" }, 500);
      }
    },
  },
  {
    path: "/api/kpis/export/estimate",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      try {
        // Mirrors the LEFT JOIN row shape of /api/kpis/export — one row per
        // (kpi_definition × kpi_value), with at least one row per definition.
        // The department-KPI exclusion must mirror it too, or the pre-download
        // size warning overstates a file that no longer contains those rows.
        const { getDepartmentKpiOwnerNames } = await import(
          "../../utils/qualityReportsDepartments"
        );
        const deptOwnerNames = await getDepartmentKpiOwnerNames();
        return await qmsEstimateResponse(
          `SELECT COUNT(*)::int AS total
             FROM kpi_definitions kd
             LEFT JOIN kpi_values kv ON kd.id = kv.kpi_id
            WHERE (kd.owner_name IS NULL OR kd.owner_name <> ALL($1::text[]))`,
          [deptOwnerNames],
          "csv",
        );
      } catch (e) {
        logger.error("KPI CSV estimate error:", e);
        return c.json({ error: "Failed to estimate export size" }, 500);
      }
    },
  },
  {
    path: "/api/kpis/export-xlsx/estimate",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      try {
        const pg = await import("pg");
        const pool = new pg.default.Pool({
          connectionString: process.env.DATABASE_URL,
        });
        try {
          // Same exclusion, and the same LEFT JOIN shape, as the two counts the
          // real /api/kpis/export-xlsx handler runs — an estimate that counted
          // department KPIs would warn about rows the workbook no longer has.
          const { getDepartmentKpiOwnerNames } = await import(
            "../../utils/qualityReportsDepartments"
          );
          const deptOwnerNames = await getDepartmentKpiOwnerNames();
          const notDept = `(kd.owner_name IS NULL OR kd.owner_name <> ALL($1::text[]))`;
          const [defR, valR] = await Promise.all([
            pool.query(
              `SELECT COUNT(*)::int AS total FROM kpi_definitions kd
                WHERE kd.is_active = true AND ${notDept}`,
              [deptOwnerNames],
            ),
            pool.query(
              `SELECT COUNT(*)::int AS total FROM kpi_values kv
                 LEFT JOIN kpi_definitions kd ON kd.id = kv.kpi_id
                WHERE ${notDept}`,
              [deptOwnerNames],
            ),
          ]);
          const totalRows =
            (defR.rows[0]?.total ?? 0) + (valR.rows[0]?.total ?? 0);
          const { estimateBytesFromRows, estimateResponse } =
            await import("../../utils/exportEstimate");
          return estimateResponse({
            rows: totalRows,
            bytes: estimateBytesFromRows(totalRows, "xlsx", 140),
            format: "xlsx",
          });
        } finally {
          await pool.end();
        }
      } catch (e) {
        logger.error("KPI XLSX estimate error:", e);
        return c.json({ error: "Failed to estimate export size" }, 500);
      }
    },
  },
  {
    path: "/api/vendors/export/estimate",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      try {
        const { initVendorTables } = await import("../../utils/vendorDatabase");
        await initVendorTables();
        // Same LEFT JOIN row shape as /api/vendors/export.
        return await qmsEstimateResponse(
          `SELECT COUNT(*)::int AS total FROM vendors v LEFT JOIN vendor_assessments va ON v.id = va.vendor_id`,
          [],
          "csv",
        );
      } catch (e) {
        logger.error("Vendor CSV estimate error:", e);
        return c.json({ error: "Failed to estimate export size" }, 500);
      }
    },
  },
  {
    path: "/api/vendors/export-xlsx/estimate",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      try {
        const { requireAdminOrKey, unauthorizedResponse } =
          await import("../../utils/rbacMiddleware");
        if (!(await requireAdminOrKey(c))) return unauthorizedResponse(c);
        const { initVendorTables } = await import("../../utils/vendorDatabase");
        await initVendorTables();
        const pg = await import("pg");
        const pool = new pg.default.Pool({
          connectionString: process.env.DATABASE_URL,
        });
        try {
          const [vR, aR] = await Promise.all([
            pool.query(`SELECT COUNT(*)::int AS total FROM vendors`),
            pool.query(`SELECT COUNT(*)::int AS total FROM vendor_assessments`),
          ]);
          const totalRows = (vR.rows[0]?.total ?? 0) + (aR.rows[0]?.total ?? 0);
          const { estimateBytesFromRows, estimateResponse } =
            await import("../../utils/exportEstimate");
          return estimateResponse({
            rows: totalRows,
            bytes: estimateBytesFromRows(totalRows, "xlsx", 160),
            format: "xlsx",
          });
        } finally {
          await pool.end();
        }
      } catch (e) {
        logger.error("Vendor XLSX estimate error:", e);
        return c.json({ error: "Failed to estimate export size" }, 500);
      }
    },
  },
  {
    path: "/api/qms/nc/export-xlsx/estimate",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      try {
        const { requireAdminOrKey, unauthorizedResponse } =
          await import("../../utils/rbacMiddleware");
        if (!(await requireAdminOrKey(c))) return unauthorizedResponse(c);
        return await qmsEstimateResponse(
          `SELECT COUNT(*)::int AS total FROM nonconformance_records`,
          [],
          "xlsx",
          200,
        );
      } catch (e) {
        logger.error("NC XLSX estimate error:", e);
        return c.json({ error: "Failed to estimate export size" }, 500);
      }
    },
  },
  {
    // Mirrors the hyphenated CAPA XLSX path used by /api/qms/capa-export-xlsx
    // — see the comment on that route for why it is not /capa/export-xlsx.
    path: "/api/qms/capa-export-xlsx/estimate",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      try {
        const { requireAdminOrKey, unauthorizedResponse } =
          await import("../../utils/rbacMiddleware");
        if (!(await requireAdminOrKey(c))) return unauthorizedResponse(c);
        return await qmsEstimateResponse(
          `SELECT COUNT(*)::int AS total FROM capa_records`,
          [],
          "xlsx",
          220,
        );
      } catch (e) {
        logger.error("CAPA XLSX estimate error:", e);
        return c.json({ error: "Failed to estimate export size" }, 500);
      }
    },
  },
  {
    path: "/api/qms/nc/export",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const pg = await import("pg");
        const ncPool = new pg.default.Pool({
          connectionString: process.env.DATABASE_URL,
        });
        try {
          const { cursorQuery } = await import("../../utils/excelExport");
          const cols = [
            "nc_number",
            "title",
            "nc_type",
            "severity",
            "status",
            "detected_by",
            "detected_date",
            "category",
            "closure_approved_by",
          ];
          const source = cursorQuery(
            ncPool,
            `SELECT ${cols.join(",")} FROM nonconformance_records ORDER BY created_at DESC`,
          );
          const rows = (async function* () {
            try {
              for await (const r of source)
                yield cols.map((k) =>
                  escapeCSVValue(
                    String((r as Record<string, unknown>)[k] ?? ""),
                  ),
                );
            } finally {
              await ncPool.end();
            }
          })();
          return await stageStreamingExportFromHono(c, () =>
            streamCsv("nonconformances.csv", cols, rows),
          );
        } catch (error) {
          await ncPool.end();
          return c.json({ error: "Export failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/qms/capa/export",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const pg = await import("pg");
        const capaPool = new pg.default.Pool({
          connectionString: process.env.DATABASE_URL,
        });
        try {
          const { cursorQuery } = await import("../../utils/excelExport");
          const cols = [
            "capa_number",
            "title",
            "capa_type",
            "severity",
            "status",
            "assigned_to",
            "target_date",
            "effectiveness_result",
            "closure_approved_by",
          ];
          const source = cursorQuery(
            capaPool,
            `SELECT ${cols.join(",")} FROM capa_records ORDER BY created_at DESC`,
          );
          const rows = (async function* () {
            try {
              for await (const r of source)
                yield cols.map((k) =>
                  escapeCSVValue(
                    String((r as Record<string, unknown>)[k] ?? ""),
                  ),
                );
            } finally {
              await capaPool.end();
            }
          })();
          return await stageStreamingExportFromHono(c, () =>
            streamCsv("capa_records.csv", cols, rows),
          );
        } catch (error) {
          await capaPool.end();
          return c.json({ error: "Export failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/compliance/export",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const pg = await import("pg");
        const pool = new pg.default.Pool({
          connectionString: process.env.DATABASE_URL,
        });
        try {
          const { initComplianceTables } =
            await import("../../utils/complianceDatabase");
          await initComplianceTables();
          const { cursorQuery } = await import("../../utils/excelExport");
          const cols = [
            "id",
            "obligation_code",
            "title",
            "regulation_id",
            "status",
            "requirement_type",
            "responsible_department",
            "compliance_frequency",
          ];
          const source = cursorQuery(
            pool,
            `SELECT ${cols.join(",")} FROM obligations ORDER BY id ASC`,
          );
          const rows = (async function* () {
            try {
              for await (const r of source)
                yield cols.map((k) =>
                  escapeCSVValue(
                    String((r as Record<string, unknown>)[k] ?? ""),
                  ),
                );
            } finally {
              await pool.end();
            }
          })();
          return await stageStreamingExportFromHono(c, () =>
            streamCsv("compliance_obligations.csv", cols, rows),
          );
        } catch (error) {
          logger.error("Compliance export error:", error);
          await pool.end();
          return c.json({ error: "Export failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/pdpl/export",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const pg = await import("pg");
        const pool = new pg.default.Pool({
          connectionString: process.env.DATABASE_URL,
        });
        try {
          const { initPdplTables } = await import("../../utils/pdplDatabase");
          await initPdplTables();
          const { cursorQuery } = await import("../../utils/excelExport");
          const cols = [
            "id",
            "field_name",
            "data_category",
            "module",
            "table_name",
            "purpose",
            "legal_basis",
            "storage_location",
            "retention_days",
            "is_encrypted",
            "is_masked",
            "pii_type",
          ];
          const source = cursorQuery(
            pool,
            `SELECT ${cols.join(",")} FROM data_inventory ORDER BY created_at DESC`,
          );
          const rows = (async function* () {
            try {
              for await (const r of source)
                yield cols.map((k) =>
                  escapeCSVValue(
                    String((r as Record<string, unknown>)[k] ?? ""),
                  ),
                );
            } finally {
              await pool.end();
            }
          })();
          return await stageStreamingExportFromHono(c, () =>
            streamCsv("pdpl_inventory.csv", cols, rows),
          );
        } catch (error) {
          logger.error("PDPL export error:", error);
          await pool.end();
          return c.json({ error: "Export failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/kpis/export",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const pg = await import("pg");
        const pool = new pg.default.Pool({
          connectionString: process.env.DATABASE_URL,
        });
        try {
          const { cursorQuery } = await import("../../utils/excelExport");
          const cols = [
            "kpi_name",
            "target_value",
            "actual_value",
            "period_start",
            "period_end",
            "calculated_by",
          ];
          const { getDepartmentKpiOwnerNames } = await import(
            "../../utils/qualityReportsDepartments"
          );
          const deptOwnerNames = await getDepartmentKpiOwnerNames();
          const source = cursorQuery(
            pool,
            `SELECT kd.kpi_name, kd.target_value, kv.actual_value, kv.period_start, kv.period_end, kv.calculated_by
               FROM kpi_definitions kd LEFT JOIN kpi_values kv ON kd.id = kv.kpi_id
              WHERE (kd.owner_name IS NULL OR kd.owner_name <> ALL($1::text[]))
              ORDER BY kd.kpi_name, kv.period_end DESC`,
            [deptOwnerNames],
          );
          const rows = (async function* () {
            try {
              for await (const r of source)
                yield cols.map((k) =>
                  escapeCSVValue(
                    String((r as Record<string, unknown>)[k] ?? ""),
                  ),
                );
            } finally {
              await pool.end();
            }
          })();
          return await stageStreamingExportFromHono(c, () =>
            streamCsv("kpi_values.csv", cols, rows),
          );
        } catch (error) {
          await pool.end();
          return c.json({ error: "Export failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/kpis/export-xlsx",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const pg = await import("pg");
        const pool = new pg.default.Pool({
          connectionString: process.env.DATABASE_URL,
        });
        try {
          const { streamXlsx, cursorQuery } =
            await import("../../utils/excelExport");

          const { getDepartmentKpiOwnerNames } = await import(
            "../../utils/qualityReportsDepartments"
          );
          const deptOwnerNames = await getDepartmentKpiOwnerNames();
          const notDept = `(kd.owner_name IS NULL OR kd.owner_name <> ALL($1::text[]))`;

          // Aggregate summary stats and distinct categories — small results
          const [kpiTotR, valTotR, catsR] = await Promise.all([
            pool.query(
              `SELECT COUNT(*)::int AS total FROM kpi_definitions kd WHERE kd.is_active = true AND ${notDept}`,
              [deptOwnerNames],
            ),
            pool.query(
              `SELECT COUNT(*)::int AS total FROM kpi_values kv
                 LEFT JOIN kpi_definitions kd ON kd.id = kv.kpi_id
                WHERE ${notDept}`,
              [deptOwnerNames],
            ),
            pool.query(
              `SELECT DISTINCT COALESCE(kd.category, 'Uncategorised') AS cat
                 FROM kpi_definitions kd WHERE kd.is_active = true AND ${notDept} ORDER BY cat`,
              [deptOwnerNames],
            ),
          ]);
          const kpiTotal = kpiTotR.rows[0]?.total ?? 0;
          const valTotal = valTotR.rows[0]?.total ?? 0;
          const kpiCats = catsR.rows.map((r) => r.cat as string);

          const kpiDefCols = [
            { header: "Code", key: "kpi_code", width: 12 },
            { header: "KPI Name", key: "kpi_name", width: 36 },
            { header: "Target", key: "target_value", width: 12 },
            { header: "Unit", key: "unit", width: 8 },
            { header: "Green ≥", key: "threshold_green", width: 10 },
            { header: "Amber ≥", key: "threshold_amber", width: 10 },
            { header: "Red <", key: "threshold_red", width: 10 },
            { header: "Direction", key: "threshold_direction", width: 18 },
            { header: "Frequency", key: "frequency", width: 12 },
            { header: "Owner", key: "owner", width: 22 },
            { header: "Latest Actual", key: "latest_actual", width: 14 },
            { header: "Latest Period End", key: "latest_period", width: 16 },
            { header: "Formula", key: "formula", width: 40 },
          ];

          // Per-category sheets use a LATERAL join to get latest value per KPI definition
          // — bounded by number of KPI defs (typically small), not number of kpi_values
          const catDefSql = `
            SELECT kd.kpi_code, kd.kpi_name, kd.target_value, kd.unit, kd.owner_name AS owner,
                   kd.frequency, kd.formula, kd.threshold_green, kd.threshold_amber,
                   kd.threshold_red, kd.threshold_direction,
                   lat.actual_value AS latest_actual,
                   TO_CHAR(lat.period_end, 'YYYY-MM-DD') AS latest_period
            FROM kpi_definitions kd
            LEFT JOIN LATERAL (
              SELECT actual_value, period_end
              FROM kpi_values WHERE kpi_id = kd.id ORDER BY period_end DESC LIMIT 1
            ) lat ON true
            WHERE kd.is_active = true AND COALESCE(kd.category, 'Uncategorised') = $1
              AND (kd.owner_name IS NULL OR kd.owner_name <> ALL($2::text[]))
            ORDER BY kd.kpi_name`;

          const sheets: Array<{
            name: string;
            columns: { header: string; key: string; width: number }[];
            rows:
              | AsyncIterable<Record<string, unknown>>
              | Array<Record<string, unknown>>;
          }> = [
            {
              name: "Summary",
              columns: [
                { header: "Metric", key: "metric", width: 32 },
                { header: "Value", key: "value", width: 18 },
              ],
              rows: [
                { metric: "Total KPI definitions", value: kpiTotal },
                { metric: "Total recorded values", value: valTotal },
                { metric: "Categories", value: kpiCats.length },
                { metric: "Generated", value: new Date().toISOString() },
              ],
            },
          ];

          for (const cat of kpiCats) {
            const catSource = cursorQuery(pool, catDefSql, [cat, deptOwnerNames]);
            const catRows = (async function* () {
              for await (const r of catSource)
                yield r as Record<string, unknown>;
            })();
            sheets.push({ name: cat, columns: kpiDefCols, rows: catRows });
          }

          // All Values sheet — server-side cursor via JOIN to include kpi_name; closes pool when done
          const allValSource = cursorQuery(
            pool,
            `
            SELECT kv.kpi_id, COALESCE(kd.kpi_name, '') AS kpi_name,
                   kv.actual_value, kv.target_value,
                   TO_CHAR(kv.period_start, 'YYYY-MM-DD') AS period_start_str,
                   TO_CHAR(kv.period_end,   'YYYY-MM-DD') AS period_end_str,
                   kv.calculated_by
            FROM kpi_values kv LEFT JOIN kpi_definitions kd ON kd.id = kv.kpi_id
            WHERE (kd.owner_name IS NULL OR kd.owner_name <> ALL($1::text[]))
            ORDER BY kv.period_end DESC, kv.kpi_id`,
            [deptOwnerNames],
          );
          const allValRows = (async function* () {
            try {
              for await (const r of allValSource)
                yield r as Record<string, unknown>;
            } finally {
              await pool.end();
            }
          })();

          sheets.push({
            name: "All Values",
            columns: [
              { header: "KPI ID", key: "kpi_id", width: 8 },
              { header: "KPI Name", key: "kpi_name", width: 36 },
              { header: "Actual", key: "actual_value", width: 12 },
              { header: "Target", key: "target_value", width: 12 },
              { header: "Period Start", key: "period_start_str", width: 14 },
              { header: "Period End", key: "period_end_str", width: 14 },
              { header: "Calculated By", key: "calculated_by", width: 22 },
            ],
            rows: allValRows,
          });

          return await stageStreamingExportFromHono(c, async () =>
            streamXlsx(sheets, `kpi_scorecard_${Date.now()}.xlsx`, {
              title: "KPI Scorecard Export",
            }),
          );
        } catch (error) {
          logger.error("Error exporting KPIs XLSX:", error);
          await pool.end();
          return c.json({ error: "Export failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/vendors/export",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const pg = await import("pg");
        const pool = new pg.default.Pool({
          connectionString: process.env.DATABASE_URL,
        });
        try {
          const { initVendorTables } =
            await import("../../utils/vendorDatabase");
          await initVendorTables();
          const { cursorQuery } = await import("../../utils/excelExport");
          const cols = [
            "name",
            "category",
            "overall_risk_level",
            "assessment_type",
            "status",
            "overall_score",
            "assessment_date",
          ];
          const source = cursorQuery(
            pool,
            `SELECT v.name, v.category, v.overall_risk_level, va.assessment_type, va.status, va.overall_score, va.assessment_date FROM vendors v LEFT JOIN vendor_assessments va ON v.id = va.vendor_id ORDER BY v.name`,
          );
          const rows = (async function* () {
            try {
              for await (const r of source)
                yield cols.map((k) =>
                  escapeCSVValue(
                    String((r as Record<string, unknown>)[k] ?? ""),
                  ),
                );
            } finally {
              await pool.end();
            }
          })();
          return await stageStreamingExportFromHono(c, () =>
            streamCsv("vendor_assessments.csv", cols, rows),
          );
        } catch (error) {
          await pool.end();
          return c.json({ error: "Export failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/qms/nc/export-xlsx",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        let ncXlsxPool: PgPool | null = null;
        try {
          const { requireAdminOrKey, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          if (!(await requireAdminOrKey(c))) return unauthorizedResponse(c);
          const { streamXlsx, cursorQuery } =
            await import("../../utils/excelExport");
          const pg = await import("pg");
          ncXlsxPool = new pg.default.Pool({
            connectionString: process.env.DATABASE_URL,
          });

          // Aggregate summary stats — small result, no large array
          const [totR, statR, sevR] = await Promise.all([
            ncXlsxPool.query(
              `SELECT COUNT(*)::int AS total FROM nonconformance_records`,
            ),
            ncXlsxPool.query(
              `SELECT status, COUNT(*)::int AS cnt FROM nonconformance_records GROUP BY status`,
            ),
            ncXlsxPool.query(
              `SELECT severity, COUNT(*)::int AS cnt FROM nonconformance_records GROUP BY severity`,
            ),
          ]);
          const ncTotal = totR.rows[0]?.total ?? 0;
          const ncByStat = (s: string) =>
            statR.rows.find((r) => r.status === s)?.cnt ?? 0;
          const ncBySev = (s: string) =>
            sevR.rows.find((r) => r.severity === s)?.cnt ?? 0;

          // Stream data rows — O(n) total cost via server-side cursor
          const ncDataSource = cursorQuery(
            ncXlsxPool,
            `SELECT nc_number, title, nc_type, category, severity, status, disposition, source_type, source_reference, detected_by,
                    TO_CHAR(detected_date, 'YYYY-MM-DD') AS detected_date_str,
                    reviewed_by, closed_by,
                    TO_CHAR(closed_date, 'YYYY-MM-DD') AS closed_date_str,
                    description, disposition_notes
             FROM nonconformance_records ORDER BY created_at DESC`,
          );
          const ncDataRows = (async function* () {
            try {
              for await (const r of ncDataSource)
                yield r as Record<string, unknown>;
            } finally {
              if (ncXlsxPool) await ncXlsxPool.end();
            }
          })();

          return await stageStreamingExportFromHono(c, async () =>
            streamXlsx(
              [
                {
                  name: "Summary",
                  columns: [
                    { header: "Metric", key: "metric", width: 32 },
                    { header: "Value", key: "value", width: 18 },
                  ],
                  rows: [
                    { metric: "Total nonconformances", value: ncTotal },
                    { metric: "Open", value: ncByStat("open") },
                    { metric: "Acknowledged", value: ncByStat("acknowledged") },
                    { metric: "Closed", value: ncByStat("closed") },
                    { metric: "Critical", value: ncBySev("critical") },
                    { metric: "Major", value: ncBySev("major") },
                    { metric: "Minor", value: ncBySev("minor") },
                    { metric: "Generated", value: new Date().toISOString() },
                  ],
                },
                {
                  name: "Nonconformances",
                  columns: [
                    { header: "NC #", key: "nc_number", width: 14 },
                    { header: "Title", key: "title", width: 40 },
                    { header: "Type", key: "nc_type", width: 16 },
                    { header: "Category", key: "category", width: 16 },
                    { header: "Severity", key: "severity", width: 12 },
                    { header: "Status", key: "status", width: 14 },
                    { header: "Disposition", key: "disposition", width: 16 },
                    { header: "Source", key: "source_type", width: 16 },
                    {
                      header: "Source Ref",
                      key: "source_reference",
                      width: 22,
                    },
                    { header: "Detected By", key: "detected_by", width: 22 },
                    { header: "Detected", key: "detected_date_str", width: 14 },
                    { header: "Reviewed By", key: "reviewed_by", width: 22 },
                    { header: "Closed By", key: "closed_by", width: 22 },
                    { header: "Closed", key: "closed_date_str", width: 14 },
                    { header: "Description", key: "description", width: 50 },
                    {
                      header: "Disposition Notes",
                      key: "disposition_notes",
                      width: 40,
                    },
                  ],
                  rows: ncDataRows,
                },
              ],
              `nonconformances_${Date.now()}.xlsx`,
              { title: "Nonconformance Records Export" },
            ),
          );
        } catch (error) {
          logger.error("Error exporting NC XLSX:", error);
          if (ncXlsxPool) await ncXlsxPool.end();
          return c.json({ error: "Export failed" }, 500);
        }
      };
    },
  },
  {
    // NOTE: not "/api/qms/capa/export-xlsx" — that pattern is shadowed by the
    // GET "/api/qms/capa/:id" handler defined in src/mastra/index.ts which would
    // try to parseInt('export-xlsx') and 500. The hyphenated path avoids the param match.
    path: "/api/qms/capa-export-xlsx",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        let capaXlsxPool: PgPool | null = null;
        try {
          const { requireAdminOrKey, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          if (!(await requireAdminOrKey(c))) return unauthorizedResponse(c);
          const { streamXlsx, cursorQuery } =
            await import("../../utils/excelExport");
          const pg = await import("pg");
          capaXlsxPool = new pg.default.Pool({
            connectionString: process.env.DATABASE_URL,
          });

          // Aggregate summary stats — small result, no large array
          const [capaTotR, capaStatR, capaOvR] = await Promise.all([
            capaXlsxPool.query(
              `SELECT COUNT(*)::int AS total FROM capa_records`,
            ),
            capaXlsxPool.query(
              `SELECT status, COUNT(*)::int AS cnt FROM capa_records GROUP BY status`,
            ),
            capaXlsxPool.query(
              `SELECT COUNT(*)::int AS cnt FROM capa_records WHERE status != 'closed' AND target_date IS NOT NULL AND target_date < NOW()`,
            ),
          ]);
          const capaTotal = capaTotR.rows[0]?.total ?? 0;
          const capaByStat = (s: string) =>
            capaStatR.rows.find((r) => r.status === s)?.cnt ?? 0;
          const capaOverdue = capaOvR.rows[0]?.cnt ?? 0;

          // Stream data rows — O(n) total cost via server-side cursor
          const capaDataSource = cursorQuery(
            capaXlsxPool,
            `SELECT capa_number, title, capa_type, severity, priority, status, assigned_to,
                    TO_CHAR(target_date, 'YYYY-MM-DD') AS target_date_str,
                    TO_CHAR(completion_date, 'YYYY-MM-DD') AS completion_date_str,
                    TO_CHAR(verification_date, 'YYYY-MM-DD') AS verification_date_str,
                    effectiveness_result, closure_approved_by, source_type, source_reference,
                    root_cause, corrective_action, preventive_action
             FROM capa_records ORDER BY created_at DESC`,
          );
          const capaDataRows = (async function* () {
            try {
              for await (const r of capaDataSource)
                yield r as Record<string, unknown>;
            } finally {
              if (capaXlsxPool) await capaXlsxPool.end();
            }
          })();

          return await stageStreamingExportFromHono(c, async () =>
            streamXlsx(
              [
                {
                  name: "Summary",
                  columns: [
                    { header: "Metric", key: "metric", width: 32 },
                    { header: "Value", key: "value", width: 18 },
                  ],
                  rows: [
                    { metric: "Total CAPAs", value: capaTotal },
                    { metric: "Open", value: capaByStat("open") },
                    {
                      metric: "Investigation",
                      value: capaByStat("investigation"),
                    },
                    { metric: "Action Plan", value: capaByStat("action_plan") },
                    {
                      metric: "Implementation",
                      value: capaByStat("implementation"),
                    },
                    {
                      metric: "Verification",
                      value: capaByStat("verification"),
                    },
                    { metric: "Closed", value: capaByStat("closed") },
                    {
                      metric: "Overdue (open + past target date)",
                      value: capaOverdue,
                    },
                    { metric: "Generated", value: new Date().toISOString() },
                  ],
                },
                {
                  name: "CAPAs",
                  columns: [
                    { header: "CAPA #", key: "capa_number", width: 14 },
                    { header: "Title", key: "title", width: 40 },
                    { header: "Type", key: "capa_type", width: 14 },
                    { header: "Severity", key: "severity", width: 12 },
                    { header: "Priority", key: "priority", width: 10 },
                    { header: "Status", key: "status", width: 16 },
                    { header: "Assigned To", key: "assigned_to", width: 22 },
                    {
                      header: "Target Date",
                      key: "target_date_str",
                      width: 14,
                    },
                    {
                      header: "Completion Date",
                      key: "completion_date_str",
                      width: 16,
                    },
                    {
                      header: "Verification Date",
                      key: "verification_date_str",
                      width: 16,
                    },
                    {
                      header: "Effectiveness",
                      key: "effectiveness_result",
                      width: 16,
                    },
                    {
                      header: "Closure Approved By",
                      key: "closure_approved_by",
                      width: 22,
                    },
                    { header: "Source", key: "source_type", width: 16 },
                    {
                      header: "Source Ref",
                      key: "source_reference",
                      width: 22,
                    },
                    { header: "Root Cause", key: "root_cause", width: 40 },
                    {
                      header: "Corrective Action",
                      key: "corrective_action",
                      width: 40,
                    },
                    {
                      header: "Preventive Action",
                      key: "preventive_action",
                      width: 40,
                    },
                  ],
                  rows: capaDataRows,
                },
              ],
              `capa_records_${Date.now()}.xlsx`,
              { title: "CAPA Records Export" },
            ),
          );
        } catch (error) {
          logger.error("Error exporting CAPA XLSX:", error);
          if (capaXlsxPool) await capaXlsxPool.end();
          return c.json({ error: "Export failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/vendors/export-xlsx",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const { requireAdminOrKey, unauthorizedResponse } =
          await import("../../utils/rbacMiddleware");
        if (!(await requireAdminOrKey(c))) return unauthorizedResponse(c);
        const pg = await import("pg");
        const pool = new pg.default.Pool({
          connectionString: process.env.DATABASE_URL,
        });
        try {
          const { initVendorTables } =
            await import("../../utils/vendorDatabase");
          await initVendorTables();

          const { streamXlsx, cursorQuery } =
            await import("../../utils/excelExport");

          // Aggregate summary stats — small results, no large arrays
          const [vTotR, vCritR, aTotR, aRiskR] = await Promise.all([
            pool.query(`SELECT COUNT(*)::int AS total FROM vendors`),
            pool.query(
              `SELECT criticality, COUNT(*)::int AS cnt FROM vendors GROUP BY criticality`,
            ),
            pool.query(`SELECT COUNT(*)::int AS total FROM vendor_assessments`),
            pool.query(
              `SELECT risk_level, COUNT(*)::int AS cnt FROM vendor_assessments GROUP BY risk_level`,
            ),
          ]);
          const vTotal = vTotR.rows[0]?.total ?? 0;
          const vByCrit = (c: string) =>
            vCritR.rows.find((r) => r.criticality === c)?.cnt ?? 0;
          const aTotal = aTotR.rows[0]?.total ?? 0;
          const aByRisk = (l: string) =>
            aRiskR.rows.find((r) => r.risk_level === l)?.cnt ?? 0;

          // Stream Vendors sheet — O(n) total cost via server-side cursor
          const vendorSource = cursorQuery(
            pool,
            `SELECT vendor_code, name, category, criticality, status, country, data_access_level,
                    TO_CHAR(contract_start, 'YYYY-MM-DD') AS contract_start_str,
                    TO_CHAR(contract_end, 'YYYY-MM-DD') AS contract_end_str,
                    contract_value, primary_contact_name, primary_contact_email, primary_contact_phone,
                    TO_CHAR(last_assessment_date, 'YYYY-MM-DD') AS last_assessment_str
             FROM vendors ORDER BY name`,
          );
          const vendorRows = (async function* () {
            for await (const r of vendorSource)
              yield r as Record<string, unknown>;
          })();

          // Stream Assessments sheet — O(n) total cost via server-side cursor
          const assessSource = cursorQuery(
            pool,
            `SELECT v.name AS vendor_name, va.assessment_type,
                    TO_CHAR(va.assessment_date, 'YYYY-MM-DD') AS assessment_date_str,
                    va.status, va.risk_level, va.overall_score, va.security_score,
                    va.financial_score, va.operational_score, va.compliance_score,
                    va.assessed_by, va.recommendations
             FROM vendor_assessments va LEFT JOIN vendors v ON v.id = va.vendor_id
             ORDER BY va.assessment_date DESC`,
          );
          const assessRows = (async function* () {
            try {
              for await (const r of assessSource)
                yield r as Record<string, unknown>;
            } finally {
              await pool.end();
            }
          })();

          return await stageStreamingExportFromHono(c, async () =>
            streamXlsx(
              [
                {
                  name: "Summary",
                  columns: [
                    { header: "Metric", key: "metric", width: 32 },
                    { header: "Value", key: "value", width: 18 },
                  ],
                  rows: [
                    { metric: "Total vendors", value: vTotal },
                    {
                      metric: "Critical criticality",
                      value: vByCrit("critical"),
                    },
                    { metric: "High criticality", value: vByCrit("high") },
                    { metric: "Total assessments", value: aTotal },
                    {
                      metric: "High-risk assessments",
                      value: aByRisk("high") + aByRisk("critical"),
                    },
                    { metric: "Generated", value: new Date().toISOString() },
                  ],
                },
                {
                  name: "Vendors",
                  columns: [
                    { header: "Code", key: "vendor_code", width: 12 },
                    { header: "Name", key: "name", width: 36 },
                    { header: "Category", key: "category", width: 18 },
                    { header: "Criticality", key: "criticality", width: 12 },
                    { header: "Status", key: "status", width: 18 },
                    { header: "Country", key: "country", width: 14 },
                    {
                      header: "Data Access",
                      key: "data_access_level",
                      width: 14,
                    },
                    {
                      header: "Contract Start",
                      key: "contract_start_str",
                      width: 14,
                    },
                    {
                      header: "Contract End",
                      key: "contract_end_str",
                      width: 14,
                    },
                    {
                      header: "Contract Value",
                      key: "contract_value",
                      width: 14,
                    },
                    {
                      header: "Primary Contact",
                      key: "primary_contact_name",
                      width: 24,
                    },
                    {
                      header: "Email",
                      key: "primary_contact_email",
                      width: 28,
                    },
                    {
                      header: "Phone",
                      key: "primary_contact_phone",
                      width: 18,
                    },
                    {
                      header: "Last Assessment",
                      key: "last_assessment_str",
                      width: 16,
                    },
                  ],
                  rows: vendorRows,
                },
                {
                  name: "Assessments",
                  columns: [
                    { header: "Vendor", key: "vendor_name", width: 30 },
                    { header: "Type", key: "assessment_type", width: 14 },
                    { header: "Date", key: "assessment_date_str", width: 14 },
                    { header: "Status", key: "status", width: 12 },
                    { header: "Risk Level", key: "risk_level", width: 12 },
                    { header: "Overall", key: "overall_score", width: 10 },
                    { header: "Security", key: "security_score", width: 10 },
                    { header: "Financial", key: "financial_score", width: 10 },
                    {
                      header: "Operational",
                      key: "operational_score",
                      width: 12,
                    },
                    {
                      header: "Compliance",
                      key: "compliance_score",
                      width: 12,
                    },
                    { header: "Assessed By", key: "assessed_by", width: 22 },
                    {
                      header: "Recommendations",
                      key: "recommendations",
                      width: 40,
                    },
                  ],
                  rows: assessRows,
                },
              ],
              `vendors_${Date.now()}.xlsx`,
              { title: "Vendor Risk Export" },
            ),
          );
        } catch (error) {
          logger.error("Error exporting vendors XLSX:", error);
          await pool.end();
          return c.json({ error: "Export failed" }, 500);
        }
        // pool is closed by the Assessments sheet generator's finally block after full stream
      };
    },
  },
  {
    path: "/api/qms/nc/bulk-update",
    method: "POST" as const,
    roles: QMS_ROLES,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const body = await c.req.json();
          const { ids, status } = body;
          if (!Array.isArray(ids) || !status) {
            return c.json(
              { error: "ids (array) and status are required" },
              400,
            );
          }
          // Scrub deny-list keys / credential-shaped strings out of the
          // user-supplied status value BEFORE it touches the SQL UPDATE.
          // `status` is meant to be a short enum like "open"/"closed", but
          // the endpoint never validated it, so a misbehaving client could
          // otherwise paste a JWT, GitHub PAT (`ghp_…`), bcrypt hash, etc.
          // straight into nonconformance_records.status.
          const { redactSensitiveDeep: redact } = await import(
            "../../utils/sensitiveRedaction"
          );
          const safeStatus = redact(status) as string;
          // Delegated to qmsDatabase.bulkUpdateNCStatus so the UPDATE lives
          // alongside the rest of the QMS writes (Task #746).
          const { bulkUpdateNCStatus } = await import(
            "../../utils/qmsDatabase"
          );
          const rows = await bulkUpdateNCStatus(ids, safeStatus);
          try {
            const { logEvent } = await import("../../utils/eventLogsDatabase");
            await logEvent({
              actionType: "UPDATE",
              entityType: "CAPA",
              description: `Bulk NC status update to ${status}: ${ids.length} records`,
              module: "qms",
              severity: "INFO",
            });
          } catch {}
          return c.json({ success: true, updated: rows.length });
        } catch (error) {
          return c.json({ error: "Bulk update failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/qms/capa/bulk-update",
    method: "POST" as const,
    roles: QMS_ROLES,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const body = await c.req.json();
          const { ids, status } = body;
          if (!Array.isArray(ids) || !status) {
            return c.json(
              { error: "ids (array) and status are required" },
              400,
            );
          }
          // See nc/bulk-update above — same redaction rationale.
          const { redactSensitiveDeep: redact } = await import(
            "../../utils/sensitiveRedaction"
          );
          const safeStatus = redact(status) as string;
          // Delegated to qmsDatabase.bulkUpdateCAPAStatus (Task #746).
          const { bulkUpdateCAPAStatus } = await import(
            "../../utils/qmsDatabase"
          );
          const rows = await bulkUpdateCAPAStatus(ids, safeStatus);
          try {
            const { logEvent } = await import("../../utils/eventLogsDatabase");
            await logEvent({
              actionType: "UPDATE",
              entityType: "CAPA",
              description: `Bulk CAPA status update to ${status}: ${ids.length} records`,
              module: "qms",
              severity: "INFO",
            });
          } catch {}
          return c.json({ success: true, updated: rows.length });
        } catch (error) {
          return c.json({ error: "Bulk update failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/qms/nc/:id/history",
    method: "GET" as const,
    roles: QMS_ROLES,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
          const { getNCChangeHistory, initChangeHistoryTables } =
            await import("../../utils/changeHistoryDatabase");
          await initChangeHistoryTables();
          const history = await getNCChangeHistory(id);
          return c.json({ history });
        } catch (error) {
          return c.json({ error: "Failed to fetch history" }, 500);
        }
      };
    },
  },
  {
    path: "/api/qms/capa/:id/history",
    method: "GET" as const,
    roles: QMS_ROLES,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
          const { getCAPAChangeHistory, initChangeHistoryTables } =
            await import("../../utils/changeHistoryDatabase");
          await initChangeHistoryTables();
          const history = await getCAPAChangeHistory(id);
          return c.json({ history });
        } catch (error) {
          return c.json({ error: "Failed to fetch history" }, 500);
        }
      };
    },
  },
  {
    path: "/api/qms/nc/:id/approve-closure",
    method: "POST" as const,
    roles: QMS_ROLES,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
          const body = await c.req.json().catch(() => ({}));
          const { approveNCClosure } = await import("../../utils/qmsDatabase");
          const result = await approveNCClosure(
            id,
            body.approvedBy || "Quality Manager",
          );
          if (!result)
            return c.json({ error: "NC not found or already closed" }, 404);
          try {
            const { logNCChange, initChangeHistoryTables } =
              await import("../../utils/changeHistoryDatabase");
            await initChangeHistoryTables();
            await logNCChange(
              id,
              "status",
              result.status,
              "closed",
              body.approvedBy || "Quality Manager",
              "Closure approved",
            );
            const { logEvent } = await import("../../utils/eventLogsDatabase");
            await logEvent({
              actionType: "STATUS_CHANGE",
              entityType: "CAPA",
              entityId: String(id),
              description: `NC closure approved by ${body.approvedBy || "Quality Manager"}`,
              module: "qms",
              severity: "INFO",
            });
          } catch {}
          return c.json({ success: true, nc: result });
        } catch (error) {
          return c.json({ error: "Approval failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/qms/capa/:id/effectiveness",
    method: "POST" as const,
    roles: QMS_ROLES,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
          const body = await c.req.json();
          if (!body.result || !body.evidence || !body.reviewedBy) {
            return c.json(
              { error: "result, evidence, and reviewedBy are required" },
              400,
            );
          }
          const { recordCAPAEffectiveness, createCapaRecord, getCapaById } =
            await import("../../utils/qmsDatabase");
          const capa = await recordCAPAEffectiveness(
            id,
            body.result,
            body.evidence,
            body.reviewedBy,
          );
          if (!capa) return c.json({ error: "CAPA not found" }, 404);
          let reCapaId: number | null = null;
          try {
            const { logCAPAChange, initChangeHistoryTables } =
              await import("../../utils/changeHistoryDatabase");
            await initChangeHistoryTables();
            await logCAPAChange(
              id,
              "effectiveness_result",
              null,
              body.result,
              body.reviewedBy,
              body.evidence,
            );
            const { logEvent } = await import("../../utils/eventLogsDatabase");
            await logEvent({
              actionType: "UPDATE",
              entityType: "CAPA",
              entityId: String(id),
              description: `CAPA effectiveness recorded: ${body.result}`,
              module: "qms",
              severity: "INFO",
            });
          } catch {}
          if (body.result === "not_effective") {
            try {
              const original = await getCapaById(id);
              if (original) {
                const reCapa = await createCapaRecord({
                  title: `Re-CAPA: ${original.title}`,
                  description: `Auto-generated re-CAPA because CAPA ${original.capa_number} was found not effective. Evidence: ${body.evidence}`,
                  capa_type: original.capa_type || "corrective",
                  source_type: "capa",
                  source_id: String(original.id),
                  source_reference: original.capa_number,
                  severity: original.severity || "major",
                  status: "open",
                  priority: "high",
                  assigned_to: original.assigned_to,
                  target_date: new Date(Date.now() + 30 * 86400000),
                  created_by: body.reviewedBy || "System",
                });
                reCapaId = reCapa.id ?? null;
                try {
                  const { logEvent } =
                    await import("../../utils/eventLogsDatabase");
                  await logEvent({
                    actionType: "CREATE",
                    entityType: "CAPA",
                    entityId: String(reCapa.id),
                    entityName: reCapa.capa_number,
                    description: `Auto re-CAPA created from ineffective CAPA ${original.capa_number}`,
                    module: "qms",
                    severity: "WARNING",
                  });
                } catch {}
              }
            } catch {}
          }
          return c.json({ success: true, capa, reCapaId });
        } catch (error) {
          return c.json({ error: "Failed to record effectiveness" }, 500);
        }
      };
    },
  },
  {
    path: "/api/qms/capa/:id/approve-closure",
    method: "POST" as const,
    roles: QMS_ROLES,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
          const body = await c.req.json().catch(() => ({}));
          const { approveCAPAClosure } =
            await import("../../utils/qmsDatabase");
          const result = await approveCAPAClosure(
            id,
            body.approvedBy || "Quality Manager",
          );
          if (!result)
            return c.json(
              {
                error:
                  "CAPA not found, already closed, or effectiveness not yet recorded",
              },
              404,
            );
          try {
            const { logCAPAChange, initChangeHistoryTables } =
              await import("../../utils/changeHistoryDatabase");
            await initChangeHistoryTables();
            await logCAPAChange(
              id,
              "status",
              "verification",
              "closed",
              body.approvedBy || "Quality Manager",
              "Closure approved",
            );
            const { logEvent } = await import("../../utils/eventLogsDatabase");
            await logEvent({
              actionType: "STATUS_CHANGE",
              entityType: "CAPA",
              entityId: String(id),
              description: `CAPA closure approved by ${body.approvedBy || "Quality Manager"}`,
              module: "qms",
              severity: "INFO",
            });
          } catch {}
          return c.json({ success: true, capa: result });
        } catch (error) {
          return c.json({ error: "Approval failed" }, 500);
        }
      };
    },
  },
];

export const qmsEnhancedRoutes = _qmsEnhancedRoutesRaw
  .map(qmsGate)
  .map(gateApiRoute);
