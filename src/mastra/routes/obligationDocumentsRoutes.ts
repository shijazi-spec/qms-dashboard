import { logger as safeLogger } from "../../utils/logger";

/**
 * Clause-level document mapping for the Compliance section.
 *
 * Each `obligation` (a clause inside a regulation) can be linked to one or
 * more uploaded files from the QMS document library. This module exposes:
 *
 *   GET    /api/compliance/obligations/:id/documents
 *   POST   /api/compliance/obligations/:id/documents     { document_id }
 *   DELETE /api/compliance/obligations/:id/documents/:docId
 *
 * Plus a bulk-upload endpoint that uploads multiple files to the QMS library
 * AND links them to the target clause in a single request:
 *
 *   POST   /api/compliance/obligations/:id/bulk-upload   (multipart, many `file`)
 *
 * Roles mirror the rest of the compliance + qms-docs surface.
 */

const READ_ROLES = [
  "admin",
  "head_of_operations_quality",
  "grc_manager",
  "quality_manager",
  "executive",
];

const WRITE_ROLES = ["admin", "grc_manager", "quality_manager"];

const MAX_FILES_PER_REQUEST = 50;
const MAX_TOTAL_BYTES_PER_REQUEST = 250 * 1024 * 1024; // 250 MB
const MAX_NOTES_LEN = 2000;
const MAX_REG_CSV_LEN = 1000;

async function gate(c: any, allowed: string[]) {
  const { requireRole, getSessionUser, unauthorizedResponse, forbiddenResponse } =
    await import("../../utils/rbacMiddleware");
  const user = await requireRole(c, allowed as any);
  if (!user) {
    if (!getSessionUser(c)) return { error: unauthorizedResponse(c), user: null };
    return {
      error: forbiddenResponse(c, "Permission denied for clause-document mapping"),
      user: null,
    };
  }
  return { error: null, user };
}

export const obligationDocumentsRoutes = [
  {
    path: "/api/compliance/obligations/:id/documents",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const g = await gate(c, READ_ROLES);
          if (g.error) return g.error;

          const id = parseInt(c.req.param("id"), 10);
          if (!Number.isFinite(id))
            return c.json({ error: "Invalid obligation id" }, 400);

          const { listDocumentsForObligation } = await import(
            "../../utils/obligationDocumentsDatabase"
          );
          const documents = await listDocumentsForObligation(id);
          return c.json({ success: true, documents });
        } catch (error) {
          safeLogger.error("❌ [ObligationDocs] list error:", error);
          return c.json({ error: "Failed to load clause documents" }, 500);
        }
      };
    },
  },

  {
    path: "/api/compliance/obligations/:id/documents",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const g = await gate(c, WRITE_ROLES);
          if (g.error) return g.error;

          const id = parseInt(c.req.param("id"), 10);
          if (!Number.isFinite(id))
            return c.json({ error: "Invalid obligation id" }, 400);

          const body = await c.req.json();
          const documentId = parseInt(body?.document_id, 10);
          if (!Number.isFinite(documentId))
            return c.json({ error: "document_id is required" }, 400);

          const { linkDocumentToObligation } = await import(
            "../../utils/obligationDocumentsDatabase"
          );
          try {
            const link = await linkDocumentToObligation({
              obligation_id: id,
              document_id: documentId,
              linked_by: g.user!.email || g.user!.id || "unknown",
            });
            return c.json({ success: true, link, already_linked: !link });
          } catch (err: any) {
            // Postgres FK violation when obligation_id or document_id is missing
            if (err && err.code === "23503")
              return c.json(
                { error: "Unknown obligation_id or document_id" },
                400,
              );
            throw err;
          }
        } catch (error) {
          safeLogger.error("❌ [ObligationDocs] link error:", error);
          return c.json({ error: "Failed to link document" }, 500);
        }
      };
    },
  },

  {
    path: "/api/compliance/obligations/:id/documents/:docId",
    method: "DELETE" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const g = await gate(c, WRITE_ROLES);
          if (g.error) return g.error;

          const id = parseInt(c.req.param("id"), 10);
          const docId = parseInt(c.req.param("docId"), 10);
          if (!Number.isFinite(id) || !Number.isFinite(docId))
            return c.json({ error: "Invalid id" }, 400);

          const { unlinkDocumentFromObligation } = await import(
            "../../utils/obligationDocumentsDatabase"
          );
          const removed = await unlinkDocumentFromObligation(id, docId);
          return c.json({ success: true, removed });
        } catch (error) {
          safeLogger.error("❌ [ObligationDocs] unlink error:", error);
          return c.json({ error: "Failed to unlink document" }, 500);
        }
      };
    },
  },

  {
    path: "/api/compliance/obligations/:id/bulk-upload",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const g = await gate(c, WRITE_ROLES);
          if (g.error) return g.error;

          const obligationId = parseInt(c.req.param("id"), 10);
          if (!Number.isFinite(obligationId))
            return c.json({ error: "Invalid obligation id" }, 400);

          const { initQmsDocsTable, createDocument, isValidCategory } =
            await import("../../utils/qmsDocsDatabase");
          const { validateFile, saveUploadedFile } = await import(
            "../../utils/fileUpload"
          );
          const { linkDocumentToObligation } = await import(
            "../../utils/obligationDocumentsDatabase"
          );
          const { getObligationById } = await import(
            "../../utils/complianceDatabase"
          );

          const obligation = await getObligationById(obligationId);
          if (!obligation)
            return c.json({ error: "Obligation not found" }, 404);

          await initQmsDocsTable();

          const rawBatchLen = c.req.header('Content-Length');
          if (!rawBatchLen) return c.json({ error: 'Content-Length header required for file uploads' }, 411);
          const batchContentLen = parseInt(rawBatchLen, 10);
          if (!Number.isFinite(batchContentLen) || batchContentLen > MAX_TOTAL_BYTES_PER_REQUEST) {
            return c.json({ error: 'Request body too large (max 250 MB total)' }, 413);
          }

          const formData = await c.req.formData();
          const rawCategory = String(
            formData.get("category") || "documents",
          ).trim();
          if (!isValidCategory(rawCategory))
            return c.json(
              {
                error:
                  "Invalid category. Allowed: documents, policies, forms, security_controls, sops",
              },
              400,
            );
          const category = rawCategory as any;

          const regCsv = String(formData.get("regulation_codes") || "").trim();
          if (regCsv.length > MAX_REG_CSV_LEN)
            return c.json(
              { error: "regulation_codes exceeds " + MAX_REG_CSV_LEN + " characters" },
              400,
            );
          const regulation_codes = regCsv
            ? regCsv.split(",").map((s) => s.trim()).filter(Boolean)
            : (obligation as any).regulation_code
              ? [(obligation as any).regulation_code]
              : null;

          const rawNotes = String(formData.get("notes") || "").trim();
          if (rawNotes.length > MAX_NOTES_LEN)
            return c.json(
              { error: "notes exceeds " + MAX_NOTES_LEN + " characters" },
              400,
            );
          const notes = rawNotes || null;

          const files = formData.getAll("file").filter(
            (f) => f instanceof File && (f as File).size > 0,
          ) as File[];
          if (files.length === 0)
            return c.json({ error: "No files provided" }, 400);
          if (files.length > MAX_FILES_PER_REQUEST)
            return c.json(
              {
                error:
                  "Too many files in one request (max " +
                  MAX_FILES_PER_REQUEST +
                  ")",
              },
              400,
            );
          const totalBytes = files.reduce((s, f) => s + f.size, 0);
          if (totalBytes > MAX_TOTAL_BYTES_PER_REQUEST)
            return c.json(
              {
                error:
                  "Aggregate upload exceeds " +
                  Math.round(MAX_TOTAL_BYTES_PER_REQUEST / 1024 / 1024) +
                  " MB",
              },
              413,
            );

          const uploaded: any[] = [];
          const failed: any[] = [];

          for (const file of files) {
            const validation = validateFile(file.name, file.size, file.type);
            if (!validation.valid) {
              failed.push({ name: file.name, error: validation.error });
              continue;
            }
            try {
              const buffer = Buffer.from(await file.arrayBuffer());
              const fileInfo = await saveUploadedFile(
                buffer,
                file.name,
                file.type,
              );
              const doc = await createDocument({
                category,
                title: file.name.replace(/\.[^.]+$/, ""),
                file_path: fileInfo.filePath,
                file_name: fileInfo.fileName,
                file_size: fileInfo.fileSize,
                mime_type: fileInfo.mimeType,
                notes,
                regulation_codes,
                uploaded_by: g.user!.email || g.user!.id || "unknown",
              });
              await linkDocumentToObligation({
                obligation_id: obligationId,
                document_id: doc.id,
                linked_by: g.user!.email || g.user!.id || "unknown",
              });
              uploaded.push(doc);
            } catch (err: any) {
              failed.push({ name: file.name, error: err?.message || "upload failed" });
            }
          }

          return c.json({
            success: true,
            uploaded_count: uploaded.length,
            failed_count: failed.length,
            uploaded,
            failed,
          });
        } catch (error) {
          safeLogger.error("❌ [ObligationDocs] bulk-upload error:", error);
          return c.json({ error: "Failed bulk upload to clause" }, 500);
        }
      };
    },
  },
];
