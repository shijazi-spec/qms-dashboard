import { logger as safeLogger } from "../../utils/logger";

/**
 * GRC → QMS document upload library.
 *
 * Five categorised buckets (Documents, Policies, Forms, Security Controls,
 * SOPs) with multipart upload, list, download and delete. Files are stored
 * on disk via the shared `fileUpload` utility (same /data/documents path
 * used by the Policies module so backups stay simple) and metadata lives in
 * `qms_uploaded_documents` so a future task can map each row to one or
 * more `regulations.regulation_code` values.
 *
 * RBAC:
 *   - GET     read access:   admin, grc_manager, quality_manager,
 *                            ai_specialist, head_of_operations_quality
 *   - POST    upload:        admin, grc_manager, quality_manager
 *   - DELETE  remove:        admin, grc_manager
 */

// Aligned with `GOVERNANCE_AND_EXECUTIVE` in staticPageRoutes.ts so that
// the page shell and the API agree on who may read this library.
const READ_ROLES = [
  "admin",
  "head_of_operations_quality",
  "grc_manager",
  "quality_manager",
  "executive",
];

const WRITE_ROLES = ["admin", "grc_manager", "quality_manager"];

const DELETE_ROLES = ["admin", "grc_manager"];

async function gate(c: any, allowed: string[]) {
  const { requireRole, getSessionUser, unauthorizedResponse, forbiddenResponse } =
    await import("../../utils/rbacMiddleware");
  const user = await requireRole(c, allowed as any);
  if (!user) {
    if (!getSessionUser(c)) return { error: unauthorizedResponse(c), user: null };
    return {
      error: forbiddenResponse(
        c,
        "Permission denied for QMS document library",
      ),
      user: null,
    };
  }
  return { error: null, user };
}

export const qmsDocsRoutes = [
  {
    path: "/api/qms-docs",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const g = await gate(c, READ_ROLES);
          if (g.error) return g.error;

          const {
            listDocumentsByCategory,
            countDocumentsByCategory,
            isValidCategory,
          } = await import("../../utils/qmsDocsDatabase");

          const rawCat = c.req.query("category");
          const category = rawCat && isValidCategory(rawCat) ? rawCat : undefined;

          const [documents, counts] = await Promise.all([
            listDocumentsByCategory(category as any),
            countDocumentsByCategory(),
          ]);
          return c.json({ success: true, documents, counts });
        } catch (error) {
          safeLogger.error("❌ [QmsDocs] list error:", error);
          return c.json({ error: "Failed to load QMS documents" }, 500);
        }
      };
    },
  },
  {
    path: "/api/qms-docs/upload",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const g = await gate(c, WRITE_ROLES);
          if (g.error) return g.error;

          const { initQmsDocsTable, createDocument, isValidCategory } =
            await import("../../utils/qmsDocsDatabase");
          const { validateFile, saveUploadedFile } =
            await import("../../utils/fileUpload");
          await initQmsDocsTable();

          const rawUploadLen = c.req.header('Content-Length');
          if (!rawUploadLen) return c.json({ error: 'Content-Length header required for file uploads' }, 411);
          const uploadContentLen = parseInt(rawUploadLen, 10);
          if (!Number.isFinite(uploadContentLen) || uploadContentLen > 26 * 1024 * 1024) {
            return c.json({ error: 'Request body too large (max 25 MB)' }, 413);
          }

          const formData = await c.req.formData();
          const file = formData.get("file");
          const category = String(formData.get("category") || "").trim();
          const title = String(formData.get("title") || "").trim();
          const notes = String(formData.get("notes") || "").trim() || null;
          const regCsv = String(formData.get("regulation_codes") || "").trim();
          const regulation_codes = regCsv
            ? regCsv.split(",").map((s) => s.trim()).filter(Boolean)
            : null;

          if (!file || !(file instanceof File))
            return c.json({ error: "No file provided" }, 400);
          if (!isValidCategory(category))
            return c.json(
              {
                error:
                  "Invalid category. Allowed: documents, policies, forms, security_controls, sops",
              },
              400,
            );
          if (!title)
            return c.json({ error: "title is required" }, 400);

          const validation = validateFile(file.name, file.size, file.type);
          if (!validation.valid)
            return c.json({ error: validation.error }, 400);

          const buffer = Buffer.from(await file.arrayBuffer());
          const fileInfo = await saveUploadedFile(buffer, file.name, file.type, 'qms-docs');

          const row = await createDocument({
            category: category as any,
            title,
            file_path: fileInfo.filePath,
            file_name: fileInfo.fileName,
            file_size: fileInfo.fileSize,
            mime_type: fileInfo.mimeType,
            notes,
            regulation_codes,
            uploaded_by: g.user!.email || g.user!.id || "unknown",
          });

          return c.json({ success: true, document: row });
        } catch (error) {
          safeLogger.error("❌ [QmsDocs] upload error:", error);
          return c.json({ error: "Failed to upload document" }, 500);
        }
      };
    },
  },
  {
    path: "/api/qms-docs/bulk-upload",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const g = await gate(c, WRITE_ROLES);
          if (g.error) return g.error;

          const { initQmsDocsTable, createDocument, isValidCategory } =
            await import("../../utils/qmsDocsDatabase");
          const { validateFile, saveUploadedFile } =
            await import("../../utils/fileUpload");
          await initQmsDocsTable();

          const MAX_FILES = 20;
          const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
          const MAX_NOTES = 2000;
          const MAX_REG_CSV = 1000;

          const rawBatchLen = c.req.header('Content-Length');
          if (!rawBatchLen) return c.json({ error: 'Content-Length header required for file uploads' }, 411);
          const batchContentLen = parseInt(rawBatchLen, 10);
          if (!Number.isFinite(batchContentLen) || batchContentLen > MAX_TOTAL_BYTES) {
            return c.json({ error: 'Request body too large (max 50 MB total)' }, 413);
          }

          const formData = await c.req.formData();
          const category = String(formData.get("category") || "").trim();
          const rawNotes = String(formData.get("notes") || "").trim();
          if (rawNotes.length > MAX_NOTES)
            return c.json(
              { error: "notes exceeds " + MAX_NOTES + " characters" },
              400,
            );
          const notes = rawNotes || null;
          const regCsv = String(formData.get("regulation_codes") || "").trim();
          if (regCsv.length > MAX_REG_CSV)
            return c.json(
              { error: "regulation_codes exceeds " + MAX_REG_CSV + " characters" },
              400,
            );
          const regulation_codes = regCsv
            ? regCsv.split(",").map((s) => s.trim()).filter(Boolean)
            : null;

          if (!isValidCategory(category))
            return c.json(
              {
                error:
                  "Invalid category. Allowed: documents, policies, forms, security_controls, sops",
              },
              400,
            );

          const files = formData.getAll("file").filter(
            (f) => f instanceof File && (f as File).size > 0,
          ) as File[];
          if (files.length === 0)
            return c.json({ error: "No files provided" }, 400);
          if (files.length > MAX_FILES)
            return c.json(
              { error: "Too many files in one request (max " + MAX_FILES + ")" },
              400,
            );
          const totalBytes = files.reduce((s, f) => s + f.size, 0);
          if (totalBytes > MAX_TOTAL_BYTES)
            return c.json(
              {
                error:
                  "Aggregate upload exceeds " +
                  Math.round(MAX_TOTAL_BYTES / 1024 / 1024) +
                  " MB limit",
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
                'qms-docs',
              );
              const row = await createDocument({
                category: category as any,
                title: file.name.replace(/\.[^.]+$/, ""),
                file_path: fileInfo.filePath,
                file_name: fileInfo.fileName,
                file_size: fileInfo.fileSize,
                mime_type: fileInfo.mimeType,
                notes,
                regulation_codes,
                uploaded_by: g.user!.email || g.user!.id || "unknown",
              });
              uploaded.push(row);
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
          safeLogger.error("❌ [QmsDocs] bulk-upload error:", error);
          return c.json({ error: "Failed bulk upload" }, 500);
        }
      };
    },
  },
  {
    path: "/api/qms-docs/:id/download",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const g = await gate(c, READ_ROLES);
          if (g.error) return g.error;

          const { getDocumentById } = await import(
            "../../utils/qmsDocsDatabase"
          );
          const { getUploadedFileForModule } = await import("../../utils/fileUpload");

          const id = parseInt(c.req.param("id"), 10);
          if (!Number.isFinite(id)) return c.json({ error: "Invalid id" }, 400);
          const doc = await getDocumentById(id);
          if (!doc) return c.json({ error: "Document not found" }, 404);

          // Scoped read: refuse to return any blob that isn't stored under
          // /data/documents/qms-docs/. Legacy un-prefixed rows have been
          // migrated/deleted, so allowLegacy is no longer needed.
          const fileBlob = getUploadedFileForModule(doc.file_path, 'qms-docs');
          if (!fileBlob) return c.json({ error: "File missing on disk" }, 404);

          c.header("Content-Type", doc.mime_type || "application/octet-stream");
          c.header(
            "Content-Disposition",
            `attachment; filename="${encodeURIComponent(doc.file_name)}"`,
          );
          // Send a bounded byte payload — `Buffer.buffer` exposes the full
          // underlying ArrayBuffer (which may be larger than `fileBlob` when
          // the buffer was sliced/pooled). Copy to a tight Uint8Array so we
          // never leak adjacent memory and the response length is exact.
          const payload = new Uint8Array(
            fileBlob.buffer,
            fileBlob.byteOffset,
            fileBlob.byteLength,
          );
          c.header("Content-Length", String(payload.byteLength));
          return c.body(payload);
        } catch (error) {
          safeLogger.error("❌ [QmsDocs] download error:", error);
          return c.json({ error: "Failed to download document" }, 500);
        }
      };
    },
  },
  {
    path: "/api/qms-docs/:id",
    method: "DELETE" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const g = await gate(c, DELETE_ROLES);
          if (g.error) return g.error;

          const { getDocumentById, deleteDocument } = await import(
            "../../utils/qmsDocsDatabase"
          );
          const { deleteUploadedFile } = await import("../../utils/fileUpload");

          const id = parseInt(c.req.param("id"), 10);
          if (!Number.isFinite(id)) return c.json({ error: "Invalid id" }, 400);
          const existing = await getDocumentById(id);
          if (!existing) return c.json({ error: "Document not found" }, 404);

          await deleteDocument(id);
          // Best-effort file cleanup — failure to remove the on-disk blob is
          // logged but does NOT fail the request, since the DB row (the
          // source of truth for what is "in the library") is already gone.
          try {
            deleteUploadedFile(existing.file_path);
          } catch (e) {
            safeLogger.warn("⚠️ [QmsDocs] file cleanup failed", { e });
          }
          return c.json({ success: true });
        } catch (error) {
          safeLogger.error("❌ [QmsDocs] delete error:", error);
          return c.json({ error: "Failed to delete document" }, 500);
        }
      };
    },
  },
];
