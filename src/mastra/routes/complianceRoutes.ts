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

          const rawUploadLen = c.req.header('Content-Length');
          if (!rawUploadLen) return c.json({ error: 'Content-Length header required for file uploads' }, 411);
          const uploadContentLen = parseInt(rawUploadLen, 10);
          if (!Number.isFinite(uploadContentLen) || uploadContentLen > 26 * 1024 * 1024) {
            return c.json({ error: 'Request body too large (max 25 MB)' }, 413);
          }

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
            'compliance',
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
          const { getUploadedFileForModule } = await import("../../utils/fileUpload");
          await initComplianceTables();

          const id = await resolveGenericId(c.req.param("id"), "regulations");
          if (!id) return c.json({ error: "Regulation not found" }, 404);
          const reg = await getRegulationById(id);
          if (!reg) return c.json({ error: "Regulation not found" }, 404);
          if (!reg.document_path)
            return c.json({ error: "No document uploaded" }, 404);

          // Scoped read: refuse to return a blob that isn't under the
          // compliance namespace. The legacy un-prefixed layout has been
          // migrated out (any orphan rows whose blobs had already vanished
          // from disk were deleted as part of the cutover), so allowLegacy
          // is no longer needed.
          const file = getUploadedFileForModule(reg.document_path, 'compliance');
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
          return new Response(new Uint8Array(file.buffer), {
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

  // ──────────────────────────────────────────────────────────────────
  // Phase 1.2 — Document-mapping coverage endpoints
  //
  //   GET /api/compliance/coverage/all                — tile grid
  //   GET /api/compliance/regulations/:id/coverage    — single framework
  //   GET /api/compliance/regulations/:id/unmapped    — drill-down list
  //
  // All three are read-only, RBAC = read role set (handled at the
  // ROUTE_PERMISSION_MAP level for the existing /api/compliance prefix).
  // ──────────────────────────────────────────────────────────────────
  {
    path: "/api/compliance/coverage/all",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { getAllFrameworkCoverage, initObligationDocumentsTable } =
            await import("../../utils/obligationDocumentsDatabase");
          const { initComplianceTables } = await import(
            "../../utils/complianceDatabase"
          );
          await initComplianceTables();
          await initObligationDocumentsTable();
          const coverage = await getAllFrameworkCoverage();
          return c.json({ coverage, count: coverage.length });
        } catch (error) {
          safeLogger.error(
            "❌ [ComplianceAPI] Error fetching coverage/all:",
            error,
          );
          return c.json({ error: "Failed to fetch coverage" }, 500);
        }
      };
    },
  },
  {
    path: "/api/compliance/regulations/:id/coverage",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { resolveGenericId } = await import("../../utils/riskDatabase");
          const { getFrameworkCoverage, initObligationDocumentsTable } =
            await import("../../utils/obligationDocumentsDatabase");
          const { initComplianceTables } = await import(
            "../../utils/complianceDatabase"
          );
          await initComplianceTables();
          await initObligationDocumentsTable();
          const id = await resolveGenericId(c.req.param("id"), "regulations");
          if (!id) return c.json({ error: "Regulation not found" }, 404);
          const coverage = await getFrameworkCoverage(id);
          return c.json({ coverage });
        } catch (error) {
          safeLogger.error(
            "❌ [ComplianceAPI] Error fetching coverage for regulation:",
            error,
          );
          return c.json({ error: "Failed to fetch framework coverage" }, 500);
        }
      };
    },
  },
  // Phase 3.4 — Audit-Readiness PDF report
  //
  // Sections in the generated PDF (one row per clause + findings + unmapped):
  //   1. Cover with framework name, coverage %, generated date
  //   2. Per-clause status table (mapped + AI quality verdict if any)
  //   3. Detailed findings (partial / missing_topic / needs_review)
  //   4. Unmapped clauses (no document linked)
  //
  // Reuses generateFraudPdfReport — the renderer is generic enough that a
  // single helper covers fraud + compliance until we need richer typography.
  {
    path: "/api/compliance/regulations/:id/audit-readiness/pdf",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { resolveGenericId } = await import("../../utils/riskDatabase");
          const { generateFraudPdfReport } = await import(
            "../../utils/fraudPdfHelper"
          );
          const { bufferResponseWithRange } = await import(
            "../../utils/excelExport"
          );
          const { getFrameworkCoverage } = await import(
            "../../utils/obligationDocumentsDatabase"
          );
          const { listNonComplianceFindings } = await import(
            "../../utils/complianceQualityDatabase"
          );
          const { sharedPool } = await import("../../utils/sharedPool");

          const id = await resolveGenericId(c.req.param("id"), "regulations");
          if (!id) return c.json({ error: "Regulation not found" }, 404);

          const coverage = await getFrameworkCoverage(id);
          const findings = await listNonComplianceFindings({
            regulationId: id,
            limit: 500,
          });

          // Per-clause table: every applicable clause + best quality verdict
          // joined via the obligation_documents + obligation_evidence_quality
          // tables so we don't need a second round-trip per row.
          const perClauseRes = await sharedPool.query(
            `SELECT
                o.id, o.obligation_code, o.title, o.priority, o.section_domain,
                COUNT(od.id)::int                                 AS doc_count,
                COALESCE(
                  MAX(CASE q.status
                        WHEN 'satisfied'     THEN 4
                        WHEN 'partial'       THEN 3
                        WHEN 'needs_review'  THEN 2
                        WHEN 'missing_topic' THEN 1
                        ELSE 0
                      END),
                  0
                )::int                                            AS best_status_rank
               FROM obligations o
          LEFT JOIN obligation_documents od ON od.obligation_id = o.id
          LEFT JOIN obligation_evidence_quality q
                  ON q.obligation_id = o.id AND q.document_id = od.document_id
              WHERE o.regulation_id = $1 AND o.status = 'applicable'
           GROUP BY o.id, o.obligation_code, o.title, o.priority, o.section_domain
           ORDER BY COALESCE(o.section_order, 0), o.obligation_code`,
            [id],
          );
          const RANK_TO_LABEL: Record<number, string> = {
            4: "satisfied",
            3: "partial",
            2: "needs review",
            1: "missing topic",
            0: "no judgement",
          };
          const summaryRows = perClauseRes.rows.map((r: any) => ({
            obligation_code: r.obligation_code,
            title: r.title,
            domain: r.section_domain || "—",
            priority: r.priority || "—",
            doc_count: r.doc_count,
            quality:
              r.doc_count === 0
                ? "unmapped"
                : RANK_TO_LABEL[r.best_status_rank] || "no judgement",
          }));

          // 4 separate report sections rendered as one PDF — but the helper
          // only takes one table, so we generate three PDFs and stack their
          // bytes? No — easier: build the body via three sequential helper
          // calls is overkill. Keep it simple: one combined table with all
          // clauses; then render findings + unmapped as separate
          // (helper-call) tables joined at the buffer level via PDFKit's
          // multi-section renderer would require re-architecting the helper.
          // Pragmatic v1: emit a single PDF with the per-clause table and
          // include findings + unmapped as inline highlight blocks at the
          // start of the report via the `meta` lines; full multi-table
          // refactor is in the Phase 3.4 follow-up.
          const meta: { label: string; value: string }[] = [
            {
              label: "Framework",
              value: `${coverage.regulation_code} — ${coverage.regulation_name}`,
            },
            {
              label: "Document-Mapping Coverage",
              value: `${coverage.with_evidence} / ${coverage.total_obligations} clauses (${coverage.coverage_pct}%)`,
            },
            {
              label: "Unmapped Clauses",
              value: String(coverage.unmapped.length),
            },
            {
              label: "Non-Compliance Findings",
              value: String(findings.length),
            },
          ];

          const buf = await generateFraudPdfReport({
            title: `Audit Readiness — ${coverage.regulation_code}`,
            subtitle: coverage.regulation_name,
            meta,
            columns: [
              { key: "obligation_code", label: "Code", width: 70 },
              { key: "title", label: "Clause / Control", width: 200 },
              { key: "domain", label: "Domain", width: 110 },
              { key: "priority", label: "Priority", width: 50 },
              { key: "doc_count", label: "Docs", width: 30, align: "right" },
              { key: "quality", label: "AI Verdict", width: 65 },
            ],
            rows: summaryRows as any,
            footer:
              `Findings (${findings.length}): ` +
              (findings.length === 0
                ? "no AI-judged non-compliance findings"
                : findings
                    .slice(0, 8)
                    .map(
                      (f: any) =>
                        `${f.obligation_code} (${f.status})`,
                    )
                    .join(", ") +
                  (findings.length > 8 ? `, +${findings.length - 8} more` : "")) +
              ` — Generated by WalaPlus QMS Platform — Confidential`,
          });

          // Audit-log the export.
          try {
            const { logEvent } = await import("../../utils/eventLogsDatabase");
            await logEvent({
              actionType: "EXPORT" as any,
              entityType: "SYSTEM" as any,
              entityName: "compliance_audit_readiness",
              description: `Exported audit-readiness PDF for ${coverage.regulation_code} (${summaryRows.length} clauses, ${findings.length} findings)`,
              module: "compliance" as any,
              severity: "INFO" as any,
            });
          } catch {
            /* never block on audit */
          }

          const filename = `audit-readiness_${coverage.regulation_code}_${new Date()
            .toISOString()
            .slice(0, 10)}.pdf`;
          return bufferResponseWithRange(
            buf,
            "application/pdf",
            filename,
            {
              range: c.req.header("Range"),
              "if-range": c.req.header("If-Range"),
            },
          );
        } catch (error) {
          safeLogger.error(
            "❌ [ComplianceAPI] audit-readiness PDF failed:",
            error,
          );
          return c.json(
            { error: "Failed to generate audit-readiness PDF" },
            500,
          );
        }
      };
    },
  },

  {
    path: "/api/compliance/regulations/:id/unmapped",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { resolveGenericId } = await import("../../utils/riskDatabase");
          const { getFrameworkCoverage, initObligationDocumentsTable } =
            await import("../../utils/obligationDocumentsDatabase");
          const { initComplianceTables } = await import(
            "../../utils/complianceDatabase"
          );
          await initComplianceTables();
          await initObligationDocumentsTable();
          const id = await resolveGenericId(c.req.param("id"), "regulations");
          if (!id) return c.json({ error: "Regulation not found" }, 404);
          const coverage = await getFrameworkCoverage(id);
          return c.json({
            regulation_code: coverage.regulation_code,
            regulation_name: coverage.regulation_name,
            unmapped: coverage.unmapped,
            count: coverage.unmapped.length,
          });
        } catch (error) {
          safeLogger.error(
            "❌ [ComplianceAPI] Error fetching unmapped clauses:",
            error,
          );
          return c.json({ error: "Failed to fetch unmapped clauses" }, 500);
        }
      };
    },
  },

  // ════════════════════════════════════════════════════════════════════
  // Compliance v2 — Ingest Standard from Document
  //
  // Lifecycle:
  //   POST /api/compliance/imports         create (kicks off Inngest)
  //   GET  /api/compliance/imports         list runs
  //   GET  /api/compliance/imports/:id     fetch run + draft
  //   PUT  /api/compliance/imports/:id     save edited draft
  //   POST /api/compliance/imports/:id/apply  bulk-insert into obligations
  // ════════════════════════════════════════════════════════════════════
  {
    path: "/api/compliance/imports",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireWriteRole, unauthorizedResponse } = await import(
            "../../utils/rbacMiddleware"
          );
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const { initComplianceTables } = await import(
            "../../utils/complianceDatabase"
          );
          await initComplianceTables();
          const { createImportRun } = await import(
            "../../utils/regulationImportsDatabase"
          );
          const body = await c.req.json().catch(() => ({}));
          const documentId = Number(body.document_id);
          const regulationId =
            body.regulation_id != null ? Number(body.regulation_id) : null;
          if (!Number.isFinite(documentId) || documentId <= 0) {
            return c.json({ error: "document_id is required" }, 400);
          }
          const run = await createImportRun({
            document_id: documentId,
            regulation_id: regulationId,
            created_by: sessionUser.email || sessionUser.role || "user",
          });
          // Fire the Inngest event so the AI extractor runs out-of-band.
          try {
            const { inngest } = await import("../inngest/client");
            await inngest.send({
              name: "compliance.ingest.requested",
              data: {
                import_id: run.id,
                document_id: documentId,
                regulation_id: regulationId,
              },
            });
          } catch (sendErr) {
            safeLogger.warn(
              `[ComplianceAPI] could not send compliance.ingest.requested: ${(sendErr as Error).message}`,
            );
          }
          return c.json({ import: run });
        } catch (err) {
          safeLogger.error(
            "❌ [ComplianceAPI] create import run failed:",
            err,
          );
          return c.json({ error: "Failed to create import run" }, 500);
        }
      };
    },
  },
  {
    path: "/api/compliance/imports",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { initComplianceTables } = await import(
            "../../utils/complianceDatabase"
          );
          await initComplianceTables();
          const { listImportRuns } = await import(
            "../../utils/regulationImportsDatabase"
          );
          const url = new URL(c.req.url);
          const status = url.searchParams.get("status") || undefined;
          const runs = await listImportRuns({
            status: status as any,
            limit: 100,
          });
          return c.json({ imports: runs });
        } catch (err) {
          safeLogger.error("❌ [ComplianceAPI] list imports failed:", err);
          return c.json({ error: "Failed to list import runs" }, 500);
        }
      };
    },
  },
  {
    path: "/api/compliance/imports/:id",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { initComplianceTables } = await import(
            "../../utils/complianceDatabase"
          );
          await initComplianceTables();
          const { getImportRun } = await import(
            "../../utils/regulationImportsDatabase"
          );
          const id = Number(c.req.param("id"));
          if (!Number.isFinite(id) || id <= 0) {
            return c.json({ error: "Invalid import id" }, 400);
          }
          const run = await getImportRun(id);
          if (!run) return c.json({ error: "Import not found" }, 404);
          return c.json({ import: run });
        } catch (err) {
          safeLogger.error("❌ [ComplianceAPI] get import failed:", err);
          return c.json({ error: "Failed to load import run" }, 500);
        }
      };
    },
  },
  {
    path: "/api/compliance/imports/:id",
    method: "PUT" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireWriteRole, unauthorizedResponse } = await import(
            "../../utils/rbacMiddleware"
          );
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const { setImportDraft } = await import(
            "../../utils/regulationImportsDatabase"
          );
          const id = Number(c.req.param("id"));
          if (!Number.isFinite(id) || id <= 0) {
            return c.json({ error: "Invalid import id" }, 400);
          }
          const body = await c.req.json().catch(() => ({}));
          if (!Array.isArray(body.draft_clauses)) {
            return c.json({ error: "draft_clauses[] is required" }, 400);
          }
          await setImportDraft(id, body.draft_clauses, "awaiting_review");
          return c.json({ ok: true });
        } catch (err) {
          safeLogger.error("❌ [ComplianceAPI] save draft failed:", err);
          return c.json({ error: "Failed to save draft" }, 500);
        }
      };
    },
  },
  {
    path: "/api/compliance/imports/:id/apply",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireWriteRole, unauthorizedResponse } = await import(
            "../../utils/rbacMiddleware"
          );
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const { applyImportRun, getImportRun } = await import(
            "../../utils/regulationImportsDatabase"
          );
          const id = Number(c.req.param("id"));
          if (!Number.isFinite(id) || id <= 0) {
            return c.json({ error: "Invalid import id" }, 400);
          }
          const run = await getImportRun(id);
          if (!run) return c.json({ error: "Import not found" }, 404);
          const body = await c.req.json().catch(() => ({}));
          const regulationId = Number(body.regulation_id ?? run.regulation_id);
          if (!Number.isFinite(regulationId) || regulationId <= 0) {
            return c.json(
              {
                error:
                  "regulation_id is required (either on the import row or in the request body)",
              },
              400,
            );
          }
          const summary = await applyImportRun(id, {
            regulationId,
            sourceDocumentId: run.document_id,
          });
          return c.json({ ...summary, import_id: id });
        } catch (err) {
          safeLogger.error("❌ [ComplianceAPI] apply import failed:", err);
          return c.json({ error: "Failed to apply import" }, 500);
        }
      };
    },
  },

  // ════════════════════════════════════════════════════════════════════
  // Compliance v2 — Audit Run engine
  //
  // Reuses the existing `audits` + `audit_checklists` + `grc_audit_findings`
  // infrastructure. A "compliance audit run" is an `audits` row with
  // audit_kind='compliance' + a populated regulation_id; its checklist
  // items are auto-generated from that regulation's obligations.
  //
  //   POST /api/compliance/regulations/:id/audit-runs   create + checklist
  //   GET  /api/compliance/audit-runs                   list
  //   GET  /api/compliance/audit-runs/:id               detail (audit + items)
  //   PUT  /api/compliance/audit-runs/:id/items/:itemId record per-clause outcome
  //   POST /api/compliance/audit-runs/:id/finalize      close + write findings
  //   GET  /api/compliance/audit-runs/:id/report.pdf    audit report PDF
  // ════════════════════════════════════════════════════════════════════
  {
    path: "/api/compliance/regulations/:id/audit-runs",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireWriteRole, unauthorizedResponse } = await import(
            "../../utils/rbacMiddleware"
          );
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const { resolveGenericId } = await import("../../utils/riskDatabase");
          const { initAuditTables } = await import(
            "../../utils/auditDatabase"
          );
          const { initComplianceTables } = await import(
            "../../utils/complianceDatabase"
          );
          const { sharedPool } = await import("../../utils/sharedPool");
          await initComplianceTables();
          await initAuditTables();

          const regulationId = await resolveGenericId(
            c.req.param("id"),
            "regulations",
          );
          if (!regulationId)
            return c.json({ error: "Regulation not found" }, 404);

          const body = await c.req.json().catch(() => ({}));
          const lead = String(body.lead_auditor || sessionUser.email || "").slice(
            0,
            255,
          );
          const title =
            String(body.title || "").slice(0, 500) ||
            `Compliance Audit Run`;
          const scope = String(body.scope_summary || "").slice(0, 4000);
          const plannedStart = body.planned_start_date || null;
          const plannedEnd = body.planned_end_date || null;

          const reg = await sharedPool.query(
            `SELECT regulation_code, name FROM regulations WHERE id = $1`,
            [regulationId],
          );
          if (reg.rows.length === 0) {
            return c.json({ error: "Regulation not found" }, 404);
          }
          const regCode = reg.rows[0].regulation_code as string;
          const regName = reg.rows[0].name as string;

          const auditId = `AUD-${Date.now()}`;
          const auditCode = `${regCode}-${new Date().getFullYear()}-${Math.floor(Math.random() * 9000 + 1000)}`;
          await sharedPool.query(
            `INSERT INTO audits
               (id, audit_code, title, audit_type, audit_kind, scope, scope_summary, audit_standard,
                lead_auditor, planned_start_date, planned_end_date, status,
                regulation_id, linked_regulation_ids, created_by)
             VALUES ($1, $2, $3, 'compliance', 'compliance', $4, $5, $6, $7, $8, $9, 'in_progress', $10, $11, $12)`,
            [
              auditId,
              auditCode,
              `${title} — ${regCode}`,
              scope,
              scope,
              `${regCode} — ${regName}`,
              lead,
              plannedStart,
              plannedEnd,
              regulationId,
              [regulationId],
              sessionUser.email || sessionUser.role || "user",
            ],
          );

          // Auto-generate one checklist item per applicable clause.
          const obls = await sharedPool.query(
            `SELECT id, obligation_code, title, description, section_domain, evidence_requirements
               FROM obligations
              WHERE regulation_id = $1 AND status = 'applicable'
              ORDER BY COALESCE(section_order, 0), obligation_code`,
            [regulationId],
          );
          let order = 1;
          for (const o of obls.rows) {
            await sharedPool.query(
              `INSERT INTO audit_checklists
                 (audit_id, category, question, expected_evidence, status, order_index,
                  obligation_id, obligation_code)
               VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7)`,
              [
                auditId,
                String(o.section_domain || regCode),
                `${o.obligation_code} — ${o.title}`,
                o.evidence_requirements || o.description || null,
                order++,
                o.id,
                o.obligation_code,
              ],
            );
          }

          return c.json({
            audit_id: auditId,
            audit_code: auditCode,
            checklist_items: obls.rows.length,
          });
        } catch (err) {
          safeLogger.error(
            "❌ [ComplianceAPI] create audit run failed:",
            err,
          );
          return c.json({ error: "Failed to create audit run" }, 500);
        }
      };
    },
  },
  {
    path: "/api/compliance/audit-runs",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { initAuditTables } = await import(
            "../../utils/auditDatabase"
          );
          await initAuditTables();
          const { sharedPool } = await import("../../utils/sharedPool");
          const url = new URL(c.req.url);
          const regulationId = url.searchParams.get("regulation_id");
          const status = url.searchParams.get("status");
          const where: string[] = ["audit_kind = 'compliance'"];
          const values: any[] = [];
          let p = 1;
          if (regulationId) {
            where.push(`regulation_id = $${p++}`);
            values.push(Number(regulationId));
          }
          if (status) {
            where.push(`status = $${p++}`);
            values.push(status);
          }
          const result = await sharedPool.query(
            `SELECT a.id, a.audit_code, a.title, a.status, a.lead_auditor,
                    a.planned_start_date, a.planned_end_date,
                    a.actual_start_date, a.actual_end_date,
                    a.regulation_id, a.findings_count, a.critical_findings,
                    a.created_at,
                    r.regulation_code, r.name AS regulation_name,
                    (SELECT COUNT(*)::int FROM audit_checklists ac WHERE ac.audit_id = a.id) AS checklist_count,
                    (SELECT COUNT(*)::int FROM audit_checklists ac WHERE ac.audit_id = a.id AND ac.status = 'completed') AS completed_count
               FROM audits a
          LEFT JOIN regulations r ON r.id = a.regulation_id
              WHERE ${where.join(" AND ")}
              ORDER BY COALESCE(a.actual_start_date, a.planned_start_date, a.created_at) DESC NULLS LAST
              LIMIT 200`,
            values,
          );
          return c.json({ runs: result.rows });
        } catch (err) {
          safeLogger.error("❌ [ComplianceAPI] list audit runs failed:", err);
          return c.json({ error: "Failed to list audit runs" }, 500);
        }
      };
    },
  },
  {
    path: "/api/compliance/audit-runs/:id",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { initAuditTables } = await import(
            "../../utils/auditDatabase"
          );
          await initAuditTables();
          const { sharedPool } = await import("../../utils/sharedPool");
          const auditId = String(c.req.param("id"));
          const audit = await sharedPool.query(
            `SELECT a.*, r.regulation_code, r.name AS regulation_name
               FROM audits a
          LEFT JOIN regulations r ON r.id = a.regulation_id
              WHERE a.id = $1`,
            [auditId],
          );
          if (audit.rows.length === 0) {
            return c.json({ error: "Audit run not found" }, 404);
          }
          const items = await sharedPool.query(
            `SELECT ac.id, ac.obligation_id, ac.obligation_code, ac.category,
                    ac.question, ac.expected_evidence, ac.outcome, ac.status,
                    ac.evidence_notes, ac.auditor_notes, ac.evidence_document_ids,
                    ac.order_index, ac.updated_at,
                    o.title AS obligation_title, o.priority, o.section_domain
               FROM audit_checklists ac
          LEFT JOIN obligations o ON o.id = ac.obligation_id
              WHERE ac.audit_id = $1
              ORDER BY ac.order_index ASC NULLS LAST, ac.id ASC`,
            [auditId],
          );
          const findings = await sharedPool.query(
            `SELECT id, finding_code, title, severity, status, control_reference, due_date
               FROM grc_audit_findings WHERE audit_id = $1 ORDER BY id ASC`,
            [auditId],
          );
          return c.json({
            run: audit.rows[0],
            items: items.rows,
            findings: findings.rows,
          });
        } catch (err) {
          safeLogger.error("❌ [ComplianceAPI] get audit run failed:", err);
          return c.json({ error: "Failed to load audit run" }, 500);
        }
      };
    },
  },
  {
    path: "/api/compliance/audit-runs/:id/items/:itemId",
    method: "PUT" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireWriteRole, unauthorizedResponse } = await import(
            "../../utils/rbacMiddleware"
          );
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const { initAuditTables } = await import(
            "../../utils/auditDatabase"
          );
          await initAuditTables();
          const { sharedPool } = await import("../../utils/sharedPool");
          const auditId = String(c.req.param("id"));
          const itemId = Number(c.req.param("itemId"));
          if (!Number.isFinite(itemId) || itemId <= 0) {
            return c.json({ error: "Invalid item id" }, 400);
          }
          const body = await c.req.json().catch(() => ({}));
          const allowedOutcomes = new Set([
            "conformant",
            "minor_nc",
            "major_nc",
            "observation",
            "ofi",
            "not_applicable",
            null,
          ]);
          let outcome = body.outcome ?? null;
          if (typeof outcome === "string") outcome = outcome.toLowerCase();
          if (!allowedOutcomes.has(outcome)) {
            return c.json({ error: "Invalid outcome" }, 400);
          }
          const evidenceNotes = body.evidence_notes
            ? String(body.evidence_notes).slice(0, 2000)
            : null;
          const auditorNotes = body.auditor_notes
            ? String(body.auditor_notes).slice(0, 2000)
            : null;
          const evDocIds: number[] = Array.isArray(body.evidence_document_ids)
            ? body.evidence_document_ids
                .map((x: any) => Number(x))
                .filter((n: number) => Number.isFinite(n) && n > 0)
            : [];
          const status = outcome ? "completed" : "in_progress";
          const r = await sharedPool.query(
            `UPDATE audit_checklists
                SET outcome              = $3,
                    evidence_notes       = $4,
                    auditor_notes        = $5,
                    evidence_document_ids = $6,
                    status               = $7,
                    updated_at           = NOW()
              WHERE id = $1 AND audit_id = $2
              RETURNING *`,
            [itemId, auditId, outcome, evidenceNotes, auditorNotes, evDocIds, status],
          );
          if (r.rowCount === 0) {
            return c.json({ error: "Item not found" }, 404);
          }
          return c.json({ item: r.rows[0] });
        } catch (err) {
          safeLogger.error(
            "❌ [ComplianceAPI] update audit item failed:",
            err,
          );
          return c.json({ error: "Failed to update audit item" }, 500);
        }
      };
    },
  },
  {
    path: "/api/compliance/audit-runs/:id/finalize",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireWriteRole, unauthorizedResponse } = await import(
            "../../utils/rbacMiddleware"
          );
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const { initAuditTables } = await import(
            "../../utils/auditDatabase"
          );
          await initAuditTables();
          const { sharedPool } = await import("../../utils/sharedPool");
          const auditId = String(c.req.param("id"));
          const audit = await sharedPool.query(
            `SELECT a.*, r.regulation_code FROM audits a
        LEFT JOIN regulations r ON r.id = a.regulation_id
              WHERE a.id = $1`,
            [auditId],
          );
          if (audit.rows.length === 0) {
            return c.json({ error: "Audit run not found" }, 404);
          }
          const regCode = audit.rows[0].regulation_code || "GEN";

          const items = await sharedPool.query(
            `SELECT ac.id, ac.obligation_id, ac.obligation_code, ac.outcome,
                    ac.evidence_notes, ac.auditor_notes
               FROM audit_checklists ac
              WHERE ac.audit_id = $1`,
            [auditId],
          );

          // Compliance v2 — outcome -> (severity, finding kind, assessment status)
          // mapping table. `null` severity means no finding row written.
          const OUTCOME_MAP: Record<
            string,
            { severity: string | null; finding_label: string; assessment: string }
          > = {
            conformant: { severity: null, finding_label: "Conformant", assessment: "compliant" },
            minor_nc: { severity: "minor", finding_label: "Minor NC", assessment: "partially_compliant" },
            major_nc: { severity: "major", finding_label: "Major NC", assessment: "non_compliant" },
            observation: { severity: "observation", finding_label: "Observation", assessment: "partially_compliant" },
            ofi: { severity: "low", finding_label: "OFI", assessment: "partially_compliant" },
            not_applicable: { severity: null, finding_label: "N/A", assessment: "not_assessed" },
          };

          let findingsCreated = 0;
          let criticalFindings = 0;
          let assessmentsWritten = 0;

          for (const it of items.rows) {
            const map = it.outcome ? OUTCOME_MAP[it.outcome] : null;
            if (!map) continue;

            // 1. Per-clause assessment (always)
            if (it.obligation_id && map.assessment !== "not_assessed") {
              await sharedPool.query(
                `INSERT INTO compliance_assessments
                   (obligation_id, assessment_date, assessed_by, compliance_status,
                    evidence_provided, gaps_identified, comments)
                 VALUES ($1, NOW(), $2, $3, $4, $5, $6)`,
                [
                  it.obligation_id,
                  audit.rows[0].lead_auditor || sessionUser.email || "auditor",
                  map.assessment,
                  it.evidence_notes,
                  it.outcome === "minor_nc" || it.outcome === "major_nc"
                    ? it.auditor_notes || it.evidence_notes
                    : null,
                  `Audit run ${audit.rows[0].audit_code}`,
                ],
              );
              assessmentsWritten++;
            }

            // 2. Finding row (only for nc / observation / ofi)
            if (map.severity) {
              const findingCode = `${regCode}-F-${Date.now()}-${it.id}`;
              await sharedPool.query(
                `INSERT INTO grc_audit_findings
                   (audit_id, finding_code, title, description, category, severity,
                    control_reference, evidence_description)
                 VALUES ($1, $2, $3, $4, 'compliance', $5, $6, $7)`,
                [
                  auditId,
                  findingCode,
                  `${map.finding_label}: ${it.obligation_code}`,
                  it.auditor_notes ||
                    it.evidence_notes ||
                    `${map.finding_label} recorded during audit run.`,
                  map.severity,
                  it.obligation_code,
                  it.evidence_notes,
                ],
              );
              findingsCreated++;
              if (map.severity === "major") criticalFindings++;
            }
          }

          await sharedPool.query(
            `UPDATE audits
                SET status            = 'completed',
                    actual_end_date   = NOW(),
                    findings_count    = $2,
                    critical_findings = $3,
                    updated_at        = NOW()
              WHERE id = $1`,
            [auditId, findingsCreated, criticalFindings],
          );

          return c.json({
            audit_id: auditId,
            findings_created: findingsCreated,
            critical_findings: criticalFindings,
            assessments_written: assessmentsWritten,
          });
        } catch (err) {
          safeLogger.error(
            "❌ [ComplianceAPI] finalize audit run failed:",
            err,
          );
          return c.json({ error: "Failed to finalize audit run" }, 500);
        }
      };
    },
  },
  {
    path: "/api/compliance/audit-runs/:id/report.pdf",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { generateFraudPdfReport } = await import(
            "../../utils/fraudPdfHelper"
          );
          const { bufferResponseWithRange } = await import(
            "../../utils/excelExport"
          );
          const { sharedPool } = await import("../../utils/sharedPool");
          const auditId = String(c.req.param("id"));
          const audit = await sharedPool.query(
            `SELECT a.*, r.regulation_code, r.name AS regulation_name
               FROM audits a
          LEFT JOIN regulations r ON r.id = a.regulation_id
              WHERE a.id = $1`,
            [auditId],
          );
          if (audit.rows.length === 0) {
            return c.json({ error: "Audit run not found" }, 404);
          }
          const items = await sharedPool.query(
            `SELECT ac.obligation_code, ac.question, ac.outcome, ac.status,
                    ac.evidence_notes, ac.auditor_notes, o.priority, o.section_domain
               FROM audit_checklists ac
          LEFT JOIN obligations o ON o.id = ac.obligation_id
              WHERE ac.audit_id = $1
              ORDER BY ac.order_index ASC NULLS LAST, ac.id ASC`,
            [auditId],
          );
          const findings = await sharedPool.query(
            `SELECT finding_code, severity, title, control_reference
               FROM grc_audit_findings WHERE audit_id = $1 ORDER BY id ASC`,
            [auditId],
          );
          const a = audit.rows[0];
          const meta = [
            { label: "Audit", value: `${a.audit_code} — ${a.title}` },
            { label: "Framework", value: `${a.regulation_code} — ${a.regulation_name}` },
            { label: "Lead Auditor", value: a.lead_auditor || "—" },
            { label: "Status", value: a.status },
            { label: "Findings", value: String(findings.rows.length) },
          ];
          const buf = await generateFraudPdfReport({
            title: `Audit Report — ${a.audit_code}`,
            subtitle: `${a.regulation_code} — ${a.regulation_name}`,
            meta,
            columns: [
              { label: "Clause", key: "obligation_code", width: 90 },
              { label: "Domain", key: "section_domain", width: 100 },
              { label: "Outcome", key: "outcome", width: 70 },
              { label: "Auditor Notes", key: "auditor_notes", width: 235 },
            ],
            rows: items.rows.map((r: any) => ({
              obligation_code: r.obligation_code || "—",
              section_domain: r.section_domain || "—",
              outcome: (r.outcome || "—").toUpperCase().replace(/_/g, " "),
              auditor_notes: (r.auditor_notes || r.evidence_notes || "—").slice(0, 240),
            })),
          });
          return bufferResponseWithRange(
            buf,
            "application/pdf",
            `audit-${a.audit_code}.pdf`,
            {
              range: c.req.header("Range"),
              "if-range": c.req.header("If-Range"),
            },
          );
        } catch (err) {
          safeLogger.error(
            "❌ [ComplianceAPI] audit report PDF failed:",
            err,
          );
          return c.json({ error: "Failed to generate audit report" }, 500);
        }
      };
    },
  },

  // ════════════════════════════════════════════════════════════════════
  // Compliance v2 — Internal Gap Analysis Report (snapshot, not audit)
  //
  //   GET /api/compliance/regulations/:id/gap-analysis.pdf
  // ════════════════════════════════════════════════════════════════════
  {
    path: "/api/compliance/regulations/:id/gap-analysis.pdf",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { resolveGenericId } = await import("../../utils/riskDatabase");
          const { generateFraudPdfReport } = await import(
            "../../utils/fraudPdfHelper"
          );
          const { bufferResponseWithRange } = await import(
            "../../utils/excelExport"
          );
          const { sharedPool } = await import("../../utils/sharedPool");
          const id = await resolveGenericId(c.req.param("id"), "regulations");
          if (!id) return c.json({ error: "Regulation not found" }, 404);

          const reg = await sharedPool.query(
            `SELECT regulation_code, name FROM regulations WHERE id = $1`,
            [id],
          );
          if (reg.rows.length === 0) {
            return c.json({ error: "Regulation not found" }, 404);
          }

          // Same shape as the gap-analysis endpoint but inline so we don't
          // pull a query helper. Latest assessment per clause via ROW_NUMBER.
          const rows = await sharedPool.query(
            `SELECT
                o.obligation_code, o.title, o.section_domain, o.priority,
                COALESCE(latest.compliance_status, 'not_assessed') AS latest_status,
                latest.score AS latest_score,
                latest.assessment_date AS last_assessed
              FROM obligations o
         LEFT JOIN LATERAL (
                  SELECT compliance_status, score, assessment_date
                    FROM compliance_assessments
                   WHERE obligation_id = o.id
                ORDER BY assessment_date DESC
                   LIMIT 1
               ) latest ON true
              WHERE o.regulation_id = $1 AND o.status = 'applicable'
              ORDER BY COALESCE(o.section_order, 0), o.obligation_code`,
            [id],
          );
          const counts = { compliant: 0, partial: 0, non_compliant: 0, not_assessed: 0 };
          for (const r of rows.rows as any[]) {
            if (r.latest_status === "compliant") counts.compliant++;
            else if (r.latest_status === "partially_compliant") counts.partial++;
            else if (r.latest_status === "non_compliant") counts.non_compliant++;
            else counts.not_assessed++;
          }
          const meta = [
            {
              label: "Framework",
              value: `${reg.rows[0].regulation_code} — ${reg.rows[0].name}`,
            },
            { label: "Total Clauses", value: String(rows.rows.length) },
            {
              label: "Compliant / Partial / Non-Compliant / Not Assessed",
              value: `${counts.compliant} / ${counts.partial} / ${counts.non_compliant} / ${counts.not_assessed}`,
            },
          ];
          const buf = await generateFraudPdfReport({
            title: `Internal Gap Analysis — ${reg.rows[0].regulation_code}`,
            subtitle: reg.rows[0].name,
            meta,
            columns: [
              { label: "Clause", key: "obligation_code", width: 90 },
              { label: "Title", key: "title", width: 165 },
              { label: "Domain", key: "section_domain", width: 90 },
              { label: "Priority", key: "priority", width: 60 },
              { label: "Status", key: "latest_status", width: 90 },
            ],
            rows: rows.rows.map((r: any) => ({
              obligation_code: r.obligation_code,
              title: (r.title || "").slice(0, 200),
              section_domain: r.section_domain || "—",
              priority: r.priority || "—",
              latest_status: (r.latest_status || "not_assessed").replace(/_/g, " "),
            })),
          });
          return bufferResponseWithRange(
            buf,
            "application/pdf",
            `gap-${reg.rows[0].regulation_code}.pdf`,
            {
              range: c.req.header("Range"),
              "if-range": c.req.header("If-Range"),
            },
          );
        } catch (err) {
          safeLogger.error(
            "❌ [ComplianceAPI] gap-analysis PDF failed:",
            err,
          );
          return c.json({ error: "Failed to generate gap-analysis PDF" }, 500);
        }
      };
    },
  },

  // ════════════════════════════════════════════════════════════════════
  // Compliance v2 — Auto-mapped review queue
  //
  // Surfaces obligation_documents rows that the citation extractor
  // created automatically (link_method='citation_auto', awaiting_review=true).
  // Reviewers confirm or reject; confirming clears the flag, rejecting
  // calls the existing unlink helper.
  // ════════════════════════════════════════════════════════════════════
  {
    path: "/api/compliance/auto-mapped",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { initObligationDocumentsTable } = await import(
            "../../utils/obligationDocumentsDatabase"
          );
          await initObligationDocumentsTable();
          const { sharedPool } = await import("../../utils/sharedPool");
          const r = await sharedPool.query(
            `SELECT od.id AS link_id, od.obligation_id, od.document_id, od.linked_at, od.link_method,
                    o.obligation_code, o.title AS obligation_title, o.regulation_id,
                    r.regulation_code,
                    d.title AS document_title, d.file_name,
                    (SELECT raw_citation FROM document_clause_citations c
                      WHERE c.document_id = od.document_id AND c.obligation_id = od.obligation_id
                      LIMIT 1) AS raw_citation,
                    (SELECT source_excerpt FROM document_clause_citations c
                      WHERE c.document_id = od.document_id AND c.obligation_id = od.obligation_id
                      LIMIT 1) AS source_excerpt
               FROM obligation_documents od
               JOIN obligations o ON o.id = od.obligation_id
               JOIN regulations r ON r.id = o.regulation_id
               JOIN qms_uploaded_documents d ON d.id = od.document_id
              WHERE od.awaiting_review = TRUE
              ORDER BY od.linked_at DESC
              LIMIT 200`,
          );
          return c.json({ items: r.rows });
        } catch (err) {
          safeLogger.error(
            "❌ [ComplianceAPI] list auto-mapped failed:",
            err,
          );
          return c.json({ error: "Failed to list auto-mapped links" }, 500);
        }
      };
    },
  },
  {
    path: "/api/compliance/auto-mapped/:linkId/confirm",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireWriteRole, unauthorizedResponse } = await import(
            "../../utils/rbacMiddleware"
          );
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);
          const { initObligationDocumentsTable } = await import(
            "../../utils/obligationDocumentsDatabase"
          );
          await initObligationDocumentsTable();
          const { sharedPool } = await import("../../utils/sharedPool");
          const linkId = Number(c.req.param("linkId"));
          if (!Number.isFinite(linkId) || linkId <= 0) {
            return c.json({ error: "Invalid link id" }, 400);
          }
          const r = await sharedPool.query(
            `UPDATE obligation_documents
                SET awaiting_review = FALSE, link_method = 'citation_confirmed', linked_by = $2
              WHERE id = $1 RETURNING id`,
            [linkId, sessionUser.email || sessionUser.role || "user"],
          );
          if (r.rowCount === 0) {
            return c.json({ error: "Link not found" }, 404);
          }
          return c.json({ ok: true });
        } catch (err) {
          safeLogger.error(
            "❌ [ComplianceAPI] confirm auto-mapped failed:",
            err,
          );
          return c.json({ error: "Failed to confirm link" }, 500);
        }
      };
    },
  },
  {
    path: "/api/compliance/auto-mapped/:linkId/reject",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireWriteRole, unauthorizedResponse } = await import(
            "../../utils/rbacMiddleware"
          );
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);
          const { sharedPool } = await import("../../utils/sharedPool");
          const linkId = Number(c.req.param("linkId"));
          if (!Number.isFinite(linkId) || linkId <= 0) {
            return c.json({ error: "Invalid link id" }, 400);
          }
          const r = await sharedPool.query(
            `DELETE FROM obligation_documents WHERE id = $1 AND awaiting_review = TRUE RETURNING id`,
            [linkId],
          );
          if (r.rowCount === 0) {
            return c.json({ error: "Link not found or already confirmed" }, 404);
          }
          return c.json({ ok: true });
        } catch (err) {
          safeLogger.error(
            "❌ [ComplianceAPI] reject auto-mapped failed:",
            err,
          );
          return c.json({ error: "Failed to reject link" }, 500);
        }
      };
    },
  },
];
