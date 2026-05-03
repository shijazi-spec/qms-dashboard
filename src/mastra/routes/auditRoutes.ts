import { logger as safeLogger } from "../../utils/logger";
export const auditRoutes = [
  {
    path: "/api/audits",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getAllAudits, initAuditTables } =
            await import("../../utils/auditDatabase");
          await initAuditTables();

          const url = new URL(c.req.url);
          const status = url.searchParams.get("status") || undefined;
          const type = url.searchParams.get("type") || undefined;
          const year = url.searchParams.get("year")
            ? parseInt(url.searchParams.get("year")!)
            : undefined;

          logger?.info("📋 [AuditAPI] GET /api/audits");

          const result = await getAllAudits({ status, type, year });
          return c.json(result);
        } catch (error) {
          safeLogger.error("❌ [AuditAPI] Error fetching audits:", error);
          return c.json({ error: "Failed to fetch audits" }, 500);
        }
      };
    },
  },
  {
    path: "/api/audits/summary",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getAuditSummary, initAuditTables } =
            await import("../../utils/auditDatabase");
          await initAuditTables();

          logger?.info("📊 [AuditAPI] GET /api/audits/summary");
          const summary = await getAuditSummary();
          return c.json(summary);
        } catch (error) {
          safeLogger.error("❌ [AuditAPI] Error fetching summary:", error);
          return c.json({ error: "Failed to fetch audit summary" }, 500);
        }
      };
    },
  },
  {
    path: "/api/audits/findings",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getAllFindings, initAuditTables } =
            await import("../../utils/auditDatabase");
          await initAuditTables();

          const url = new URL(c.req.url);
          const status = url.searchParams.get("status") || undefined;
          const severity = url.searchParams.get("severity") || undefined;
          const audit_id = url.searchParams.get("audit_id")
            ? parseInt(url.searchParams.get("audit_id")!)
            : undefined;

          logger?.info("📋 [AuditAPI] GET /api/audits/findings");

          const result = await getAllFindings({ status, severity, audit_id });
          return c.json(result);
        } catch (error) {
          safeLogger.error("❌ [AuditAPI] Error fetching findings:", error);
          return c.json({ error: "Failed to fetch findings" }, 500);
        }
      };
    },
  },
  {
    // Bulk CSV export of the audits schedule. Mirrors the static streaming
    // export pattern used by /api/vendors/export, /api/policies/export,
    // /api/risks/export, /api/duplicates/export and /api/logs/export so the
    // audits dashboard can expose a one-click "Export Audits CSV" button on
    // first paint (allowing the Arabic streaming-fallback advisory to attach).
    //
    // IMPORTANT: this literal-segment route MUST be registered before the
    // dynamic `/api/audits/:id` handler below, otherwise Hono will treat
    // "export" as the :id param and serve audit-detail JSON / 404 instead of
    // streaming CSV. (Same ordering rule the QMS/CAPA/KPI export routes
    // call out in src/mastra/index.ts.)
    path: "/api/audits/export/estimate",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const pg = await import("pg");
        const pool = new pg.default.Pool({
          connectionString: process.env.DATABASE_URL,
        });
        try {
          const { initAuditTables } =
            await import("../../utils/auditDatabase");
          await initAuditTables();

          const url = new URL(c.req.url);
          const status = url.searchParams.get("status") || undefined;
          const conditions: string[] = [];
          const filterParams: unknown[] = [];
          if (status) {
            filterParams.push(status);
            conditions.push(`status = $${filterParams.length}`);
          }
          const where = conditions.length
            ? `WHERE ${conditions.join(" AND ")}`
            : "";

          const r = await pool.query(
            `SELECT COUNT(*)::int AS total FROM audits ${where}`,
            filterParams,
          );
          const { estimateFromCount, estimateResponse } =
            await import("../../utils/exportEstimate");
          return estimateResponse(estimateFromCount(r.rows[0]?.total, "csv"));
        } catch (error) {
          safeLogger.error(
            "❌ [AuditAPI] Error estimating audits export:",
            error,
          );
          return c.json({ error: "Failed to estimate export size" }, 500);
        } finally {
          await pool.end();
        }
      };
    },
  },
  {
    path: "/api/audits/export",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const pg = await import("pg");
        const exportPool = new pg.default.Pool({
          connectionString: process.env.DATABASE_URL,
        });
        try {
          const { initAuditTables } =
            await import("../../utils/auditDatabase");
          await initAuditTables();

          const url = new URL(c.req.url);
          const status = url.searchParams.get("status") || undefined;

          const conditions: string[] = [];
          const filterParams: unknown[] = [];
          if (status) {
            filterParams.push(status);
            conditions.push(`status = $${filterParams.length}`);
          }
          const where = conditions.length
            ? `WHERE ${conditions.join(" AND ")}`
            : "";

          const { escapeCSVValue } = await import("../../utils/inputSanitizer");
          const { streamCsv, cursorQuery, stageStreamingExportFromHono } =
            await import("../../utils/excelExport");

          const source = cursorQuery(
            exportPool,
            `SELECT id, audit_code, title, COALESCE(audit_type, type) AS audit_type, status,
                    lead_auditor, auditee_department, audit_standard,
                    planned_start_date, planned_end_date,
                    actual_start_date, actual_end_date,
                    findings_count, critical_findings, created_at
             FROM audits ${where}
             ORDER BY COALESCE(planned_start_date, scheduled_date, created_at) DESC NULLS LAST`,
            filterParams,
          );

          const headers = [
            "ID",
            "Audit Code",
            "Title",
            "Type",
            "Status",
            "Lead Auditor",
            "Department",
            "Standard",
            "Planned Start",
            "Planned End",
            "Actual Start",
            "Actual End",
            "Findings",
            "Critical Findings",
            "Created",
          ];
          const rows = (async function* () {
            try {
              for await (const a of source) {
                const row = a as Record<string, unknown>;
                yield [
                  row["id"],
                  row["audit_code"] ?? "",
                  row["title"] ?? "",
                  row["audit_type"] ?? "",
                  row["status"] ?? "",
                  row["lead_auditor"] ?? "",
                  row["auditee_department"] ?? "",
                  row["audit_standard"] ?? "",
                  row["planned_start_date"] ?? "",
                  row["planned_end_date"] ?? "",
                  row["actual_start_date"] ?? "",
                  row["actual_end_date"] ?? "",
                  row["findings_count"] ?? 0,
                  row["critical_findings"] ?? 0,
                  row["created_at"] ?? "",
                ].map((v) => escapeCSVValue(String(v ?? "")));
              }
            } finally {
              await exportPool.end();
            }
          })();
          return await stageStreamingExportFromHono(c, () =>
            streamCsv(
              `audits_${new Date().toISOString().split("T")[0]}.csv`,
              headers,
              rows,
            ),
          );
        } catch (error) {
          safeLogger.error("❌ [AuditAPI] Error exporting audits:", error);
          await exportPool.end();
          return c.json({ error: "Failed to export audits" }, 500);
        }
      };
    },
  },
  {
    path: "/api/audits/:id",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const {
            getAuditById,
            getFindingsByAudit,
            getChecklist,
            initAuditTables,
          } = await import("../../utils/auditDatabase");
          await initAuditTables();

          const id = c.req.param("id");
          logger?.info("📋 [AuditAPI] GET /api/audits/:id", { id });

          const audit = await getAuditById(id);
          if (!audit) {
            return c.json({ error: "Audit not found" }, 404);
          }

          const [findings, checklist] = await Promise.all([
            getFindingsByAudit(id as any),
            getChecklist(id as any),
          ]);

          return c.json({ audit, findings, checklist });
        } catch (error) {
          safeLogger.error("❌ [AuditAPI] Error fetching audit:", error);
          return c.json({ error: "Failed to fetch audit" }, 500);
        }
      };
    },
  },
  {
    path: "/api/audits",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRole, forbiddenResponse, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { createAudit, initAuditTables } =
            await import("../../utils/auditDatabase");
          const { logEvent } = await import("../../utils/eventLogsDatabase");
          await initAuditTables();

          const body = await c.req.json();
          logger?.info("📝 [AuditAPI] POST /api/audits", {
            title: body.title,
            by: sessionUser.email,
          });

          if (!body.audit_code || !body.title || !body.audit_type) {
            return c.json({ error: "Missing required fields" }, 400);
          }

          const audit = await createAudit({
            ...body,
            created_by: sessionUser.email,
          });

          await logEvent({
            entityType: "AUDIT",
            entityId: audit.id!.toString(),
            actionType: "CREATE",
            description: `New audit created: ${audit.title}`,
            newValue: JSON.stringify(audit),
            userName: sessionUser.email,
            severity: "INFO",
            module: "audit_readiness",
          });

          return c.json({ success: true, audit });
        } catch (error: any) {
          safeLogger.error("❌ [AuditAPI] Error creating audit:", error);
          if (error.code === "23505") {
            return c.json({ error: "Audit code already exists" }, 400);
          }
          return c.json({ error: "Failed to create audit" }, 500);
        }
      };
    },
  },
  {
    path: "/api/audits/:id",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRole, forbiddenResponse, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { updateAudit, getAuditById, initAuditTables } =
            await import("../../utils/auditDatabase");
          const { logEvent } = await import("../../utils/eventLogsDatabase");
          await initAuditTables();

          const id = parseInt(c.req.param("id"));
          const body = await c.req.json();
          logger?.info("📝 [AuditAPI] PUT /api/audits/:id", {
            id,
            by: sessionUser.email,
          });

          const existing = await getAuditById(id);
          if (!existing) {
            return c.json({ error: "Audit not found" }, 404);
          }

          const audit = await updateAudit(id, body);

          await logEvent({
            entityType: "AUDIT",
            entityId: id.toString(),
            actionType: "UPDATE",
            description: `Audit updated: ${audit.title}`,
            oldValue: JSON.stringify(existing),
            newValue: JSON.stringify(audit),
            userName: sessionUser.email,
            severity: "INFO",
            module: "audit_readiness",
          });

          return c.json({ success: true, audit });
        } catch (error) {
          safeLogger.error("❌ [AuditAPI] Error updating audit:", error);
          return c.json({ error: "Failed to update audit" }, 500);
        }
      };
    },
  },
  {
    path: "/api/audits/findings",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRole, forbiddenResponse, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { createFinding, getAuditById, initAuditTables } =
            await import("../../utils/auditDatabase");
          const { logEvent } = await import("../../utils/eventLogsDatabase");
          await initAuditTables();

          const body = await c.req.json();
          logger?.info("📝 [AuditAPI] POST /api/audits/findings", {
            title: body.title,
            by: sessionUser.email,
          });

          if (
            !body.audit_id ||
            !body.finding_code ||
            !body.title ||
            !body.description ||
            !body.category ||
            !body.severity
          ) {
            return c.json({ error: "Missing required fields" }, 400);
          }

          const audit = await getAuditById(body.audit_id);
          if (!audit) {
            return c.json({ error: "Audit not found" }, 404);
          }

          const finding = await createFinding({
            ...body,
            created_by: sessionUser.email,
          });

          await logEvent({
            entityType: "FINDING",
            entityId: finding.id!.toString(),
            actionType: "CREATE",
            description: `New audit finding: ${finding.title} (${finding.severity})`,
            newValue: JSON.stringify(finding),
            userName: sessionUser.email,
            severity:
              finding.severity === "critical"
                ? "CRITICAL"
                : finding.severity === "major"
                  ? "WARNING"
                  : "INFO",
            module: "audit_readiness",
          });

          return c.json({ success: true, finding });
        } catch (error: any) {
          safeLogger.error("❌ [AuditAPI] Error creating finding:", error);
          if (error.code === "23505") {
            return c.json({ error: "Finding code already exists" }, 400);
          }
          return c.json({ error: "Failed to create finding" }, 500);
        }
      };
    },
  },
  {
    path: "/api/audits/findings/:id",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getFindingById, initAuditTables } =
            await import("../../utils/auditDatabase");
          await initAuditTables();

          const id = parseInt(c.req.param("id"));
          logger?.info("📋 [AuditAPI] GET /api/audits/findings/:id", { id });

          const finding = await getFindingById(id);
          if (!finding) {
            return c.json({ error: "Finding not found" }, 404);
          }

          return c.json({ finding });
        } catch (error) {
          safeLogger.error("❌ [AuditAPI] Error fetching finding:", error);
          return c.json({ error: "Failed to fetch finding" }, 500);
        }
      };
    },
  },
  {
    path: "/api/audits/findings/:id",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRole, forbiddenResponse, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { updateFinding, getFindingById, initAuditTables } =
            await import("../../utils/auditDatabase");
          const { logEvent } = await import("../../utils/eventLogsDatabase");
          await initAuditTables();

          const id = parseInt(c.req.param("id"));
          const body = await c.req.json();
          logger?.info("📝 [AuditAPI] PUT /api/audits/findings/:id", {
            id,
            by: sessionUser.email,
          });

          const existing = await getFindingById(id);
          if (!existing) {
            return c.json({ error: "Finding not found" }, 404);
          }

          const finding = await updateFinding(id, body);

          await logEvent({
            entityType: "FINDING",
            entityId: id.toString(),
            actionType: "UPDATE",
            description: `Audit finding updated: ${finding.title}`,
            oldValue: JSON.stringify(existing),
            newValue: JSON.stringify(finding),
            userName: sessionUser.email,
            severity: "INFO",
            module: "audit_readiness",
          });

          return c.json({ success: true, finding });
        } catch (error) {
          safeLogger.error("❌ [AuditAPI] Error updating finding:", error);
          return c.json({ error: "Failed to update finding" }, 500);
        }
      };
    },
  },
  {
    path: "/api/audits/evidence-packs",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getEvidencePacks, initAuditTables } =
            await import("../../utils/auditDatabase");
          await initAuditTables();

          const url = new URL(c.req.url);
          const audit_id = url.searchParams.get("audit_id")
            ? parseInt(url.searchParams.get("audit_id")!)
            : undefined;
          const status = url.searchParams.get("status") || undefined;

          logger?.info("📋 [AuditAPI] GET /api/audits/evidence-packs");

          const packs = await getEvidencePacks({ audit_id, status });
          return c.json({ evidence_packs: packs });
        } catch (error) {
          safeLogger.error(
            "❌ [AuditAPI] Error fetching evidence packs:",
            error,
          );
          return c.json({ error: "Failed to fetch evidence packs" }, 500);
        }
      };
    },
  },
  {
    path: "/api/audits/evidence-packs",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRole, forbiddenResponse, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { createEvidencePack, initAuditTables } =
            await import("../../utils/auditDatabase");
          const { logEvent } = await import("../../utils/eventLogsDatabase");
          await initAuditTables();

          const body = await c.req.json();
          logger?.info("📝 [AuditAPI] POST /api/audits/evidence-packs", {
            by: sessionUser.email,
          });

          if (!body.pack_name) {
            return c.json({ error: "Missing required fields" }, 400);
          }

          const pack = await createEvidencePack({
            ...body,
            generated_by: sessionUser.email,
          });

          await logEvent({
            entityType: "EVIDENCE_PACK",
            entityId: pack.id!.toString(),
            actionType: "CREATE",
            description: `Evidence pack created: ${pack.pack_name}`,
            newValue: JSON.stringify(pack),
            userName: sessionUser.email,
            severity: "INFO",
            module: "audit_readiness",
          });

          return c.json({ success: true, evidence_pack: pack });
        } catch (error) {
          safeLogger.error(
            "❌ [AuditAPI] Error creating evidence pack:",
            error,
          );
          return c.json({ error: "Failed to create evidence pack" }, 500);
        }
      };
    },
  },
  {
    path: "/api/audits/:id/checklist",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getChecklist, initAuditTables } =
            await import("../../utils/auditDatabase");
          await initAuditTables();

          const auditId = parseInt(c.req.param("id"));
          logger?.info("📋 [AuditAPI] GET /api/audits/:id/checklist", {
            auditId,
          });

          const checklist = await getChecklist(auditId);
          return c.json({ checklist });
        } catch (error) {
          safeLogger.error("❌ [AuditAPI] Error fetching checklist:", error);
          return c.json({ error: "Failed to fetch checklist" }, 500);
        }
      };
    },
  },
  {
    path: "/api/audits/:id/checklist",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRole, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { createChecklist, getAuditById, initAuditTables } =
            await import("../../utils/auditDatabase");
          await initAuditTables();

          const auditId = parseInt(c.req.param("id"));
          const body = await c.req.json();
          logger?.info("📝 [AuditAPI] POST /api/audits/:id/checklist", {
            auditId,
          });

          const audit = await getAuditById(auditId);
          if (!audit) {
            return c.json({ error: "Audit not found" }, 404);
          }

          if (!body.items || !Array.isArray(body.items)) {
            return c.json({ error: "Missing required fields" }, 400);
          }

          const items = body.items.map((item: any, index: number) => ({
            ...item,
            audit_id: auditId,
            order_index: index,
          }));

          const checklist = await createChecklist(items);
          return c.json({ success: true, checklist });
        } catch (error) {
          safeLogger.error("❌ [AuditAPI] Error creating checklist:", error);
          return c.json({ error: "Failed to create checklist" }, 500);
        }
      };
    },
  },
  {
    path: "/api/audits/checklist/:id",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRole, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { updateChecklistItem, initAuditTables } =
            await import("../../utils/auditDatabase");
          await initAuditTables();

          const id = parseInt(c.req.param("id"));
          const body = await c.req.json();
          logger?.info("📝 [AuditAPI] PUT /api/audits/checklist/:id", { id });

          const item = await updateChecklistItem(id, body);
          return c.json({ success: true, checklist_item: item });
        } catch (error) {
          safeLogger.error(
            "❌ [AuditAPI] Error updating checklist item:",
            error,
          );
          return c.json({ error: "Failed to update checklist item" }, 500);
        }
      };
    },
  },
  {
    path: "/api/audits/:id/export-pdf",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const {
            getAuditById,
            getFindingsByAudit,
            getChecklist,
            initAuditTables,
          } = await import("../../utils/auditDatabase");
          await initAuditTables();

          // audits.id is a UUID (varchar) — never parseInt. The numeric quality_audit_results.id
          // is exported elsewhere; this route serves the GRC audits table.
          const rawId = c.req.param("id");
          const id: string | number = /^\d+$/.test(rawId)
            ? parseInt(rawId, 10)
            : rawId;
          logger?.info("📄 [AuditAPI] GET /api/audits/:id/export-pdf", { id });

          const audit = await getAuditById(id);
          if (!audit) {
            return c.json({ error: "Audit not found" }, 404);
          }

          const [findings, checklist] = await Promise.all([
            getFindingsByAudit(id),
            getChecklist(id),
          ]);

          const PDFDocument = (await import("pdfkit")).default;

          const formatDate = (date: Date | string | null | undefined) => {
            if (!date) return "N/A";
            return new Date(date).toLocaleDateString("en-US", {
              year: "numeric",
              month: "short",
              day: "numeric",
            });
          };

          const doc = new PDFDocument({
            size: "A4",
            margin: 50,
            bufferPages: true,
          });
          const chunks: Buffer[] = [];

          doc.on("data", (chunk: Buffer) => chunks.push(chunk));

          doc
            .fontSize(24)
            .fillColor("#1E3A8A")
            .text("AUDIT REPORT", { align: "center" });
          doc.moveDown(0.5);
          doc
            .fontSize(14)
            .fillColor("#4B5563")
            .text(`${audit.audit_code} - ${audit.title}`, { align: "center" });
          doc.moveDown(1);

          doc
            .fontSize(14)
            .fillColor("#1E3A8A")
            .text("Audit Details", { underline: true });
          doc.moveDown(0.5);

          doc.fontSize(10).fillColor("#000000");
          const details = [
            ["Audit Code", audit.audit_code || "N/A"],
            ["Title", audit.title || "N/A"],
            [
              "Type",
              (audit.audit_type || "N/A").replace(/_/g, " ").toUpperCase(),
            ],
            [
              "Status",
              (audit.status || "N/A").replace(/_/g, " ").toUpperCase(),
            ],
            ["Lead Auditor", audit.lead_auditor || "N/A"],
            ["Department", audit.auditee_department || "N/A"],
            ["Planned Start", formatDate(audit.planned_start_date)],
            ["Planned End", formatDate(audit.planned_end_date)],
            ["Actual Start", formatDate(audit.actual_start_date)],
            ["Actual End", formatDate(audit.actual_end_date)],
            ["Audit Standard", audit.audit_standard || "N/A"],
          ];

          details.forEach(([label, value]) => {
            doc.font("Helvetica-Bold").text(`${label}: `, { continued: true });
            doc.font("Helvetica").text(value as string);
          });
          doc.moveDown(1);

          doc
            .fontSize(14)
            .fillColor("#1E3A8A")
            .text("Scope", { underline: true });
          doc.moveDown(0.3);
          doc
            .fontSize(10)
            .fillColor("#000000")
            .text(audit.scope || "No scope defined.");
          doc.moveDown(1);

          doc
            .fontSize(14)
            .fillColor("#1E3A8A")
            .text("Description", { underline: true });
          doc.moveDown(0.3);
          doc
            .fontSize(10)
            .fillColor("#000000")
            .text(audit.description || "No description provided.");
          doc.moveDown(1);

          const criticalCount = findings.filter(
            (f: any) => f.severity === "critical",
          ).length;
          const majorCount = findings.filter(
            (f: any) => f.severity === "major",
          ).length;
          const minorCount = findings.filter(
            (f: any) => f.severity === "minor",
          ).length;
          const observationCount = findings.filter(
            (f: any) => f.severity === "observation",
          ).length;
          const openCount = findings.filter(
            (f: any) => f.status === "open",
          ).length;

          doc
            .fontSize(14)
            .fillColor("#1E3A8A")
            .text(`Findings Summary (${findings.length} total)`, {
              underline: true,
            });
          doc.moveDown(0.5);
          doc.fontSize(10).fillColor("#000000");
          doc.text(
            `Critical: ${criticalCount}  |  Major: ${majorCount}  |  Minor: ${minorCount}  |  Observation: ${observationCount}  |  Open: ${openCount}`,
          );
          doc.moveDown(1);

          if (findings.length > 0) {
            doc.addPage();
            doc
              .fontSize(16)
              .fillColor("#1E3A8A")
              .text("Detailed Findings", { underline: true });
            doc.moveDown(0.5);

            findings.forEach((finding: any, index: number) => {
              if (doc.y > 700) doc.addPage();

              doc
                .fontSize(11)
                .fillColor("#1E3A8A")
                .text(
                  `${index + 1}. ${finding.finding_code} - ${finding.title}`,
                );
              doc.fontSize(9).fillColor("#6B7280");
              doc.text(
                `Severity: ${(finding.severity || "N/A").toUpperCase()}  |  Category: ${(finding.category || "N/A").replace(/_/g, " ")}  |  Status: ${(finding.status || "N/A").replace(/_/g, " ").toUpperCase()}`,
              );
              doc.text(
                `Due Date: ${formatDate(finding.due_date)}  |  Responsible: ${finding.responsible_party || "N/A"}`,
              );
              doc.moveDown(0.3);
              doc
                .fontSize(10)
                .fillColor("#000000")
                .text(finding.description || "No description.");

              if (finding.root_cause) {
                doc.moveDown(0.3);
                doc
                  .font("Helvetica-Bold")
                  .text("Root Cause: ", { continued: true });
                doc.font("Helvetica").text(finding.root_cause);
              }
              if (finding.corrective_action) {
                doc.moveDown(0.3);
                doc
                  .font("Helvetica-Bold")
                  .text("Corrective Action: ", { continued: true });
                doc.font("Helvetica").text(finding.corrective_action);
              }
              doc.moveDown(0.5);
              doc
                .strokeColor("#E5E7EB")
                .lineWidth(0.5)
                .moveTo(50, doc.y)
                .lineTo(545, doc.y)
                .stroke();
              doc.moveDown(0.5);
            });
          }

          if (checklist && checklist.length > 0) {
            doc.addPage();
            doc
              .fontSize(16)
              .fillColor("#1E3A8A")
              .text("Audit Checklist", { underline: true });
            doc.moveDown(0.5);

            checklist.forEach((item: any, index: number) => {
              if (doc.y > 700) doc.addPage();

              const responseColors: any = {
                yes: "#047857",
                no: "#B91C1C",
                partial: "#D97706",
                not_applicable: "#6B7280",
              };
              doc
                .fontSize(10)
                .fillColor("#000000")
                .text(`${index + 1}. ${item.question || "N/A"}`);
              doc
                .fontSize(9)
                .fillColor(responseColors[item.response] || "#6B7280");
              doc.text(
                `Response: ${(item.response || "Pending").toUpperCase()}  |  Status: ${(item.status || "pending").replace(/_/g, " ").toUpperCase()}`,
              );
              doc.moveDown(0.5);
            });
          }

          const pageCount = doc.bufferedPageRange().count;
          for (let i = 0; i < pageCount; i++) {
            doc.switchToPage(i);
            doc.fontSize(8).fillColor("#6B7280");
            doc.text(
              `WalaPlus GRC & QMS - Generated ${new Date().toLocaleDateString()}`,
              50,
              doc.page.height - 50,
              { align: "left", width: 200 },
            );
            doc.text(
              `Page ${i + 1} of ${pageCount}`,
              doc.page.width - 150,
              doc.page.height - 50,
              { align: "right", width: 100 },
            );
          }

          doc.end();

          const pdfBuffer = await new Promise<Buffer>((resolve) => {
            doc.on("end", () => {
              resolve(Buffer.concat(chunks));
            });
          });

          // Range-aware response so the streaming-download helper can resume
          // an interrupted PDF export instead of restarting from byte 0.
          const { bufferResponseWithRange } =
            await import("../../utils/excelExport");
          const reqHeaders = {
            range: c.req.header("Range"),
            "if-range": c.req.header("If-Range"),
          };
          return bufferResponseWithRange(
            pdfBuffer,
            "application/pdf",
            `${audit.audit_code}_report.pdf`,
            reqHeaders,
          );
        } catch (error) {
          safeLogger.error("❌ [AuditAPI] Error exporting audit PDF:", error);
          return c.json(
            {
              error: "Failed to export audit report to PDF",
              details: String(error),
            },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/audits/:id/export-xlsx",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getAuditById, initAuditTables } =
            await import("../../utils/auditDatabase");
          await initAuditTables();

          const rawId = c.req.param("id");
          const id: string | number = /^\d+$/.test(rawId)
            ? parseInt(rawId, 10)
            : rawId;
          logger?.info("📊 [AuditAPI] GET /api/audits/:id/export-xlsx", { id });

          const audit = await getAuditById(id);
          if (!audit) return c.json({ error: "Audit not found" }, 404);

          const { streamXlsx, cursorQuery, stageStreamingExportFromHono } =
            await import("../../utils/excelExport");
          const pg = await import("pg");

          const formatDate = (d: unknown) =>
            d ? new Date(String(d)).toISOString().substring(0, 10) : "";

          let auditPool: InstanceType<(typeof pg.default)["Pool"]> | null =
            null;
          let streaming = false;
          try {
            auditPool = new pg.default.Pool({
              connectionString: process.env.DATABASE_URL,
            });

            // Aggregate counts for summary sheet — avoids loading all rows into memory
            const aggRes = await auditPool.query(
              `SELECT
                 COUNT(*)::int AS total,
                 COUNT(*) FILTER (WHERE severity = 'critical')::int AS critical,
                 COUNT(*) FILTER (WHERE severity = 'high')::int AS high,
                 COUNT(*) FILTER (WHERE capa_required = true)::int AS capa_req
               FROM grc_audit_findings WHERE audit_id = $1`,
              [id],
            );
            const agg = aggRes.rows[0] ?? {
              total: 0,
              critical: 0,
              high: 0,
              capa_req: 0,
            };

            // Server-side cursor for findings — O(n) total cost vs LIMIT/OFFSET's O(n²)
            const findingsSrc = cursorQuery(
              auditPool!,
              `SELECT finding_number, severity, status, dimension, criteria_name, description, evidence,
                      recommendation, capa_required, owner, target_date, resolution_date
               FROM grc_audit_findings WHERE audit_id = $1
               ORDER BY severity DESC, created_at DESC`,
              [id],
            );
            const findingsRows = (async function* () {
              try {
                for await (const r of findingsSrc) {
                  const f = r as Record<string, unknown>;
                  yield {
                    ...f,
                    capa_required_label: f["capa_required"] ? "Yes" : "No",
                    target_date_str: formatDate(f["target_date"]),
                    resolution_date_str: formatDate(f["resolution_date"]),
                  };
                }
              } finally {
                auditPool && (await auditPool.end());
              }
            })();

            streaming = true;
            return await stageStreamingExportFromHono(c, async () =>
              streamXlsx(
                [
                  {
                    name: "Summary",
                    columns: [
                      { header: "Field", key: "field", width: 28 },
                      { header: "Value", key: "value", width: 60 },
                    ],
                    rows: [
                      {
                        field: "Audit Code",
                        value: audit.audit_code || "(none)",
                      },
                      { field: "Title", value: audit.title || "" },
                      { field: "Type", value: audit.audit_type || "" },
                      { field: "Status", value: audit.status || "" },
                      {
                        field: "Lead Auditor",
                        value: audit.lead_auditor || "",
                      },
                      { field: "Scope", value: audit.scope || "" },
                      {
                        field: "Start Date",
                        value: formatDate(audit.start_date),
                      },
                      { field: "End Date", value: formatDate(audit.end_date) },
                      { field: "Created", value: formatDate(audit.created_at) },
                      { field: "Total Findings", value: agg.total },
                      { field: "Critical Findings", value: agg.critical },
                      { field: "High Findings", value: agg.high },
                      { field: "CAPA Required", value: agg.capa_req },
                    ],
                  },
                  {
                    name: "Findings",
                    columns: [
                      { header: "No.", key: "finding_number", width: 12 },
                      { header: "Severity", key: "severity", width: 10 },
                      { header: "Status", key: "status", width: 12 },
                      { header: "Dimension", key: "dimension", width: 14 },
                      { header: "Criteria", key: "criteria_name", width: 28 },
                      { header: "Description", key: "description", width: 50 },
                      { header: "Evidence", key: "evidence", width: 35 },
                      {
                        header: "Recommendation",
                        key: "recommendation",
                        width: 40,
                      },
                      {
                        header: "CAPA Required",
                        key: "capa_required_label",
                        width: 14,
                      },
                      { header: "Owner", key: "owner", width: 22 },
                      {
                        header: "Target Date",
                        key: "target_date_str",
                        width: 14,
                      },
                      {
                        header: "Resolution Date",
                        key: "resolution_date_str",
                        width: 16,
                      },
                    ],
                    rows: findingsRows,
                  },
                ],
                (() => {
                  const safeCode = String(audit.audit_code || id).replace(
                    /[^A-Za-z0-9._-]/g,
                    "_",
                  );
                  return `${safeCode}_audit_report.xlsx`;
                })(),
                { title: `Audit Report ${audit.audit_code || id}` },
              ),
            );
          } catch (innerErr) {
            if (!streaming && auditPool) await auditPool.end();
            throw innerErr;
          }
        } catch (error) {
          safeLogger.error("❌ [AuditAPI] Error exporting audit XLSX:", error);
          return c.json(
            {
              error: "Failed to export audit report to XLSX",
              details: String(error),
            },
            500,
          );
        }
      };
    },
  },
];
