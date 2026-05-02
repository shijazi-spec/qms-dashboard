import { logger as safeLogger } from "../../utils/logger";
export const complianceRoutes = [
  {
    path: "/api/compliance/regulations",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getAllRegulations, initComplianceTables } =
            await import("../../utils/complianceDatabase");
          await initComplianceTables();

          const url = new URL(c.req.url);
          const status = url.searchParams.get("status") || undefined;
          const jurisdiction =
            url.searchParams.get("jurisdiction") || undefined;
          const category = url.searchParams.get("category") || undefined;

          logger?.info("📋 [ComplianceAPI] GET /api/compliance/regulations");

          const regulations = await getAllRegulations({
            status,
            jurisdiction,
            category,
          });
          const { obfuscateResourceIdsList } =
            await import("../../utils/riskDatabase");
          return c.json({ regulations: obfuscateResourceIdsList(regulations) });
        } catch (error) {
          safeLogger.error(
            "❌ [ComplianceAPI] Error fetching regulations:",
            error,
          );
          return c.json({ error: "Failed to fetch regulations" }, 500);
        }
      };
    },
  },
  {
    path: "/api/compliance/regulations/:id",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const {
            getRegulationById,
            getObligationsByRegulation,
            initComplianceTables,
          } = await import("../../utils/complianceDatabase");
          await initComplianceTables();

          const {
            resolveGenericId,
            obfuscateResourceIds,
            obfuscateResourceIdsList,
          } = await import("../../utils/riskDatabase");
          const id = await resolveGenericId(c.req.param("id"), "regulations");
          if (!id) return c.json({ error: "Regulation not found" }, 404);
          logger?.info(
            "📋 [ComplianceAPI] GET /api/compliance/regulations/:id",
            { id },
          );

          const regulation = await getRegulationById(id);
          if (!regulation) {
            return c.json({ error: "Regulation not found" }, 404);
          }

          const obligations = await getObligationsByRegulation(id);
          return c.json({
            regulation: obfuscateResourceIds(regulation),
            obligations: obfuscateResourceIdsList(obligations),
          });
        } catch (error) {
          safeLogger.error(
            "❌ [ComplianceAPI] Error fetching regulation:",
            error,
          );
          return c.json({ error: "Failed to fetch regulation" }, 500);
        }
      };
    },
  },
  {
    path: "/api/compliance/regulations",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRole, forbiddenResponse, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { createRegulation, initComplianceTables } =
            await import("../../utils/complianceDatabase");
          const { logEvent } = await import("../../utils/eventLogsDatabase");
          await initComplianceTables();

          const body = await c.req.json();
          logger?.info("📝 [ComplianceAPI] POST /api/compliance/regulations", {
            name: body.name,
            by: sessionUser.email,
          });

          if (
            !body.regulation_code ||
            !body.name ||
            !body.jurisdiction ||
            !body.category
          ) {
            return c.json({ error: "Missing required fields" }, 400);
          }

          const regulation = await createRegulation({
            ...body,
            created_by: sessionUser.email,
          });

          await logEvent({
            entityType: "REGULATION",
            entityId: regulation.id!.toString(),
            actionType: "CREATE",
            description: `New regulation added: ${regulation.name}`,
            newValue: JSON.stringify(regulation),
            userName: sessionUser.email,
            severity: "INFO",
            module: "compliance_tracker",
          });

          return c.json({ success: true, regulation });
        } catch (error: any) {
          safeLogger.error(
            "❌ [ComplianceAPI] Error creating regulation:",
            error,
          );
          if (error.code === "23505") {
            return c.json({ error: "Regulation code already exists" }, 400);
          }
          return c.json({ error: "Failed to create regulation" }, 500);
        }
      };
    },
  },
  {
    path: "/api/compliance/regulations/:id/document",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireRole, unauthorizedResponse, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireRole(c, ["admin", "grc_manager"]);
          if (!sessionUser) {
            // Distinguish unauth vs forbidden so the UI can react usefully.
            const { getSessionUser } = await import("../../utils/rbacMiddleware");
            return getSessionUser(c)
              ? forbiddenResponse(
                  c,
                  "Only admins or GRC managers can upload regulation documents",
                )
              : unauthorizedResponse(c);
          }

          const logger = mastra?.getLogger();
          const {
            getRegulationById,
            updateRegulationDocument,
            initComplianceTables,
          } = await import("../../utils/complianceDatabase");
          const { resolveGenericId } = await import("../../utils/riskDatabase");
          const { validateFile, saveUploadedFile, deleteUploadedFile } =
            await import("../../utils/fileUpload");
          const { logEvent } = await import("../../utils/eventLogsDatabase");
          await initComplianceTables();

          const id = await resolveGenericId(c.req.param("id"), "regulations");
          if (!id) return c.json({ error: "Regulation not found" }, 404);
          const existing = await getRegulationById(id);
          if (!existing) return c.json({ error: "Regulation not found" }, 404);

          const formData = await c.req.formData();
          const file = formData.get("file");
          if (!file || !(file instanceof File))
            return c.json({ error: "No file provided" }, 400);

          // PDF only, max 25 MB. validateFile already enforces 25 MB and the
          // .pdf extension is part of its allow-list, but we also force the
          // mime type here so DOCX/PNG/etc are rejected even though the
          // shared util permits them for other uploaders.
          const ext = (file.name.match(/\.[^.]+$/)?.[0] || "").toLowerCase();
          if (ext !== ".pdf" || file.type !== "application/pdf") {
            return c.json(
              { error: "Only PDF files are allowed (max 25 MB)" },
              400,
            );
          }
          const validation = validateFile(file.name, file.size, file.type);
          if (!validation.valid)
            return c.json({ error: validation.error }, 400);

          const buffer = Buffer.from(await file.arrayBuffer());
          const fileInfo = await saveUploadedFile(
            buffer,
            file.name,
            file.type,
          );

          const updated = await updateRegulationDocument(id, {
            document_path: fileInfo.filePath,
            document_filename: fileInfo.fileName,
            document_size: fileInfo.fileSize,
            uploaded_by: sessionUser.email,
          });

          // Best-effort: drop the previous file now that the row points at
          // the new one. Failures are non-fatal (orphaned files only).
          if (
            existing.document_path &&
            existing.document_path !== fileInfo.filePath
          ) {
            try {
              deleteUploadedFile(existing.document_path);
            } catch {
              // ignore
            }
          }

          logger?.info(
            "📎 [ComplianceAPI] POST /api/compliance/regulations/:id/document",
            { id, by: sessionUser.email, size: fileInfo.fileSize },
          );

          await logEvent({
            entityType: "REGULATION",
            entityId: id.toString(),
            actionType: "UPDATE",
            description: `Regulation document uploaded for ${existing.regulation_code}: ${fileInfo.fileName}`,
            newValue: JSON.stringify({
              document_filename: fileInfo.fileName,
              document_size: fileInfo.fileSize,
            }),
            userName: sessionUser.email,
            severity: "INFO",
            module: "compliance_tracker",
          });

          return c.json({ success: true, regulation: updated });
        } catch (error) {
          safeLogger.error(
            "❌ [ComplianceAPI] Error uploading regulation document:",
            error,
          );
          return c.json(
            { error: "Failed to upload regulation document" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/compliance/regulations/:id/document",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { getSessionUser, hasValidAdminApiKey } =
            await import("../../utils/rbacMiddleware");
          if (!getSessionUser(c) && !hasValidAdminApiKey(c)) {
            return c.json({ error: "Authentication required" }, 401);
          }

          const { getRegulationById, initComplianceTables } =
            await import("../../utils/complianceDatabase");
          const { resolveGenericId } = await import("../../utils/riskDatabase");
          const { getUploadedFile } = await import("../../utils/fileUpload");
          await initComplianceTables();

          const id = await resolveGenericId(c.req.param("id"), "regulations");
          if (!id) return c.json({ error: "Regulation not found" }, 404);
          const reg = await getRegulationById(id);
          if (!reg) return c.json({ error: "Regulation not found" }, 404);
          if (!reg.document_path)
            return c.json({ error: "No document uploaded" }, 404);

          const file = getUploadedFile(reg.document_path);
          if (!file)
            return c.json(
              { error: "Document file is missing on disk" },
              404,
            );

          // Sanitise the user-supplied original filename before echoing it
          // back in Content-Disposition: strip CR/LF/quote (header injection)
          // and path separators (so a malicious upload named
          // "../../etc/passwd" cannot suggest a file-system path to the
          // downloading client), and force a non-empty .pdf default.
          const rawName =
            reg.document_filename || file.fileName || "regulation.pdf";
          const downloadName =
            rawName
              .replace(/[\r\n"\\\/]/g, "")
              .replace(/^\.+/, "")
              .trim() || "regulation.pdf";
          return new Response(file.buffer, {
            status: 200,
            headers: {
              "Content-Type": "application/pdf",
              "Content-Length": String(file.buffer.length),
              "Content-Disposition": `inline; filename="${downloadName}"`,
              "Cache-Control": "private, max-age=0, no-cache",
            },
          });
        } catch (error) {
          safeLogger.error(
            "❌ [ComplianceAPI] Error serving regulation document:",
            error,
          );
          return c.json(
            { error: "Failed to fetch regulation document" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/compliance/regulations/:id/document",
    method: "DELETE" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireRole, unauthorizedResponse, forbiddenResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = await requireRole(c, ["admin", "grc_manager"]);
          if (!sessionUser) {
            const { getSessionUser } = await import("../../utils/rbacMiddleware");
            return getSessionUser(c)
              ? forbiddenResponse(
                  c,
                  "Only admins or GRC managers can remove regulation documents",
                )
              : unauthorizedResponse(c);
          }

          const logger = mastra?.getLogger();
          const {
            getRegulationById,
            updateRegulationDocument,
            initComplianceTables,
          } = await import("../../utils/complianceDatabase");
          const { resolveGenericId } = await import("../../utils/riskDatabase");
          const { deleteUploadedFile } = await import("../../utils/fileUpload");
          const { logEvent } = await import("../../utils/eventLogsDatabase");
          await initComplianceTables();

          const id = await resolveGenericId(c.req.param("id"), "regulations");
          if (!id) return c.json({ error: "Regulation not found" }, 404);
          const existing = await getRegulationById(id);
          if (!existing) return c.json({ error: "Regulation not found" }, 404);
          if (!existing.document_path)
            return c.json({ success: true, regulation: existing });

          const previousPath = existing.document_path;
          const previousName = existing.document_filename;
          const updated = await updateRegulationDocument(id, {
            document_path: null,
            document_filename: null,
            document_size: null,
            uploaded_by: null,
          });
          try {
            deleteUploadedFile(previousPath);
          } catch {
            // ignore disk-side failure
          }

          logger?.info(
            "🗑️  [ComplianceAPI] DELETE /api/compliance/regulations/:id/document",
            { id, by: sessionUser.email },
          );

          await logEvent({
            entityType: "REGULATION",
            entityId: id.toString(),
            actionType: "UPDATE",
            description: `Regulation document removed for ${existing.regulation_code}: ${previousName || "(unknown)"}`,
            userName: sessionUser.email,
            severity: "INFO",
            module: "compliance_tracker",
          });

          return c.json({ success: true, regulation: updated });
        } catch (error) {
          safeLogger.error(
            "❌ [ComplianceAPI] Error deleting regulation document:",
            error,
          );
          return c.json(
            { error: "Failed to remove regulation document" },
            500,
          );
        }
      };
    },
  },
  {
    path: "/api/compliance/obligations",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getAllObligations, initComplianceTables } =
            await import("../../utils/complianceDatabase");
          await initComplianceTables();

          const url = new URL(c.req.url);
          const status = url.searchParams.get("status") || undefined;
          const priority = url.searchParams.get("priority") || undefined;
          const department = url.searchParams.get("department") || undefined;
          const regulation_id = url.searchParams.get("regulation_id")
            ? parseInt(url.searchParams.get("regulation_id")!)
            : undefined;

          logger?.info("📋 [ComplianceAPI] GET /api/compliance/obligations");

          const result = await getAllObligations({
            status,
            priority,
            department,
            regulation_id,
          });
          return c.json(result);
        } catch (error) {
          safeLogger.error(
            "❌ [ComplianceAPI] Error fetching obligations:",
            error,
          );
          return c.json({ error: "Failed to fetch obligations" }, 500);
        }
      };
    },
  },
  {
    path: "/api/compliance/obligations/:id",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const {
            getObligationById,
            getAssessmentHistory,
            initComplianceTables,
          } = await import("../../utils/complianceDatabase");
          await initComplianceTables();

          const id = parseInt(c.req.param("id"));
          logger?.info(
            "📋 [ComplianceAPI] GET /api/compliance/obligations/:id",
            { id },
          );

          const obligation = await getObligationById(id);
          if (!obligation) {
            return c.json({ error: "Obligation not found" }, 404);
          }

          const assessments = await getAssessmentHistory(id);
          return c.json({ obligation, assessments });
        } catch (error) {
          safeLogger.error(
            "❌ [ComplianceAPI] Error fetching obligation:",
            error,
          );
          return c.json({ error: "Failed to fetch obligation" }, 500);
        }
      };
    },
  },
  {
    path: "/api/compliance/obligations",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRole, forbiddenResponse, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { createObligation, initComplianceTables } =
            await import("../../utils/complianceDatabase");
          const { logEvent } = await import("../../utils/eventLogsDatabase");
          await initComplianceTables();

          const body = await c.req.json();
          logger?.info("📝 [ComplianceAPI] POST /api/compliance/obligations", {
            title: body.title,
            by: sessionUser.email,
          });

          if (
            !body.obligation_code ||
            !body.regulation_id ||
            !body.title ||
            !body.description
          ) {
            return c.json({ error: "Missing required fields" }, 400);
          }

          const obligation = await createObligation({
            ...body,
            created_by: sessionUser.email,
          });

          await logEvent({
            entityType: "OBLIGATION",
            entityId: obligation.id!.toString(),
            actionType: "CREATE",
            description: `New compliance obligation created: ${obligation.title}`,
            newValue: JSON.stringify(obligation),
            userName: sessionUser.email,
            severity: "INFO",
            module: "compliance_tracker",
          });

          return c.json({ success: true, obligation });
        } catch (error: any) {
          safeLogger.error(
            "❌ [ComplianceAPI] Error creating obligation:",
            error,
          );
          if (error.code === "23505") {
            return c.json({ error: "Obligation code already exists" }, 400);
          }
          return c.json({ error: "Failed to create obligation" }, 500);
        }
      };
    },
  },
  {
    path: "/api/compliance/obligations/:id",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRole, forbiddenResponse, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { updateObligation, getObligationById, initComplianceTables } =
            await import("../../utils/complianceDatabase");
          const { logEvent } = await import("../../utils/eventLogsDatabase");
          await initComplianceTables();

          const id = parseInt(c.req.param("id"));
          const body = await c.req.json();
          logger?.info(
            "📝 [ComplianceAPI] PUT /api/compliance/obligations/:id",
            { id, by: sessionUser.email },
          );

          const existing = await getObligationById(id);
          if (!existing) {
            return c.json({ error: "Obligation not found" }, 404);
          }

          const obligation = await updateObligation(id, body);

          await logEvent({
            entityType: "OBLIGATION",
            entityId: id.toString(),
            actionType: "UPDATE",
            description: `Compliance obligation updated: ${obligation.title}`,
            oldValue: JSON.stringify(existing),
            newValue: JSON.stringify(obligation),
            userName: sessionUser.email,
            severity: "INFO",
            module: "compliance_tracker",
          });

          return c.json({ success: true, obligation });
        } catch (error) {
          safeLogger.error(
            "❌ [ComplianceAPI] Error updating obligation:",
            error,
          );
          return c.json({ error: "Failed to update obligation" }, 500);
        }
      };
    },
  },
  {
    path: "/api/compliance/assessments",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRole, forbiddenResponse, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { createAssessment, getObligationById, initComplianceTables } =
            await import("../../utils/complianceDatabase");
          const { logEvent } = await import("../../utils/eventLogsDatabase");
          await initComplianceTables();

          const body = await c.req.json();
          logger?.info("📝 [ComplianceAPI] POST /api/compliance/assessments", {
            by: sessionUser.email,
          });

          if (!body.obligation_id || !body.compliance_status) {
            return c.json({ error: "Missing required fields" }, 400);
          }

          const obligation = await getObligationById(body.obligation_id);
          if (!obligation) {
            return c.json({ error: "Obligation not found" }, 404);
          }

          const assessment = await createAssessment({
            ...body,
            assessed_by: sessionUser.email,
          });

          await logEvent({
            entityType: "ASSESSMENT",
            entityId: assessment.id!.toString(),
            actionType: "CREATE",
            description: `Compliance assessment recorded for ${obligation.title}: ${body.compliance_status}`,
            newValue: JSON.stringify(assessment),
            userName: sessionUser.email,
            severity:
              body.compliance_status === "non_compliant" ? "CRITICAL" : "INFO",
            module: "compliance_tracker",
          });

          return c.json({ success: true, assessment });
        } catch (error) {
          safeLogger.error(
            "❌ [ComplianceAPI] Error creating assessment:",
            error,
          );
          return c.json({ error: "Failed to create assessment" }, 500);
        }
      };
    },
  },
  {
    path: "/api/compliance/summary",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getComplianceSummary, initComplianceTables } =
            await import("../../utils/complianceDatabase");
          await initComplianceTables();

          logger?.info("📊 [ComplianceAPI] GET /api/compliance/summary");
          const summary = await getComplianceSummary();
          return c.json(summary);
        } catch (error) {
          safeLogger.error("❌ [ComplianceAPI] Error fetching summary:", error);
          return c.json({ error: "Failed to fetch compliance summary" }, 500);
        }
      };
    },
  },
  {
    path: "/api/compliance/calendar",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getComplianceCalendar, initComplianceTables } =
            await import("../../utils/complianceDatabase");
          await initComplianceTables();

          const url = new URL(c.req.url);
          const month = url.searchParams.get("month")
            ? parseInt(url.searchParams.get("month")!)
            : undefined;
          const year = url.searchParams.get("year")
            ? parseInt(url.searchParams.get("year")!)
            : undefined;
          const status = url.searchParams.get("status") || undefined;

          logger?.info("📋 [ComplianceAPI] GET /api/compliance/calendar");
          const events = await getComplianceCalendar({ month, year, status });
          return c.json({ events });
        } catch (error) {
          safeLogger.error(
            "❌ [ComplianceAPI] Error fetching calendar:",
            error,
          );
          return c.json({ error: "Failed to fetch compliance calendar" }, 500);
        }
      };
    },
  },
  {
    path: "/api/compliance/calendar",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRole, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { createCalendarEvent, initComplianceTables } =
            await import("../../utils/complianceDatabase");
          await initComplianceTables();

          const body = await c.req.json();
          logger?.info("📝 [ComplianceAPI] POST /api/compliance/calendar");

          if (!body.obligation_id || !body.event_type || !body.scheduled_date) {
            return c.json({ error: "Missing required fields" }, 400);
          }

          const event = await createCalendarEvent(body);
          return c.json({ success: true, event });
        } catch (error) {
          safeLogger.error(
            "❌ [ComplianceAPI] Error creating calendar event:",
            error,
          );
          return c.json({ error: "Failed to create calendar event" }, 500);
        }
      };
    },
  },
  {
    path: "/api/compliance/deadlines",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const {
            getUpcomingDeadlines,
            getOverdueEvents,
            initComplianceTables,
          } = await import("../../utils/complianceDatabase");
          await initComplianceTables();

          const url = new URL(c.req.url);
          const days = parseInt(url.searchParams.get("days") || "30");

          logger?.info("📋 [ComplianceAPI] GET /api/compliance/deadlines");

          const [upcoming, overdue] = await Promise.all([
            getUpcomingDeadlines(days),
            getOverdueEvents(),
          ]);

          return c.json({ upcoming, overdue });
        } catch (error) {
          safeLogger.error(
            "❌ [ComplianceAPI] Error fetching deadlines:",
            error,
          );
          return c.json({ error: "Failed to fetch deadlines" }, 500);
        }
      };
    },
  },
  {
    path: "/api/compliance/dashboard",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { getComplianceDashboardStats, initComplianceTables } =
            await import("../../utils/complianceDatabase");
          await initComplianceTables();
          const stats = await getComplianceDashboardStats();
          return c.json(stats);
        } catch (error) {
          safeLogger.error(
            "❌ [ComplianceAPI] Error fetching dashboard:",
            error,
          );
          return c.json({ error: "Failed to fetch dashboard stats" }, 500);
        }
      };
    },
  },
  {
    path: "/api/compliance/gap-analysis",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { getComplianceGapAnalysis, initComplianceTables } =
            await import("../../utils/complianceDatabase");
          await initComplianceTables();
          const url = new URL(c.req.url);
          const regulationId = url.searchParams.get("regulation_id")
            ? parseInt(url.searchParams.get("regulation_id")!)
            : undefined;
          const gaps = await getComplianceGapAnalysis(regulationId);
          const { obfuscateResourceIdsList } =
            await import("../../utils/riskDatabase");
          return c.json({ gap_analysis: obfuscateResourceIdsList(gaps) });
        } catch (error) {
          safeLogger.error(
            "❌ [ComplianceAPI] Error fetching gap analysis:",
            error,
          );
          return c.json({ error: "Failed to fetch gap analysis" }, 500);
        }
      };
    },
  },
];
