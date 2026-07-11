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

// Documents Library uploads are stored as POLICIES (the single source of
// truth) and the existing policy→mapping bridge projects them back into
// `qms_uploaded_documents`, so one upload shows in BOTH the Integrated QMS
// register and the Documents Library / Document Mapping. This maps each
// library category bucket to the policy document_type + category + a
// policy_number prefix. `qmsCategoryForDocType` in the bridge is the reverse
// map, so the projected row lands back in the same bucket the user picked.
const CATEGORY_TO_POLICY: Record<
  string,
  { document_type: string; category: string; prefix: string }
> = {
  documents: { document_type: "document", category: "governance", prefix: "LIB-DOC" },
  policies: { document_type: "policy", category: "governance", prefix: "LIB-POL" },
  forms: { document_type: "form", category: "operational", prefix: "LIB-FRM" },
  security_controls: { document_type: "control", category: "security", prefix: "LIB-CTL" },
  sops: { document_type: "sop", category: "operational", prefix: "LIB-SOP" },
};

/** Next sequential policy_number for a Documents Library prefix (e.g. LIB-CTL-003). */
async function nextLibraryPolicyNumber(prefix: string): Promise<string> {
  const { sharedPool } = await import("../../utils/sharedPool");
  const r = await sharedPool.query(
    `SELECT policy_number FROM policies WHERE policy_number LIKE $1`,
    [`${prefix}-%`],
  );
  let max = 0;
  for (const row of r.rows) {
    const m = /-(\d+)$/.exec(String(row.policy_number || ""));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}-${String(max + 1).padStart(3, "0")}`;
}

/** Resolve regulation CODES (e.g. "ISO-27001") to numeric regulation ids for linked_regulation_ids. */
async function resolveRegulationIds(codes: string[] | null): Promise<number[] | null> {
  if (!codes || codes.length === 0) return null;
  try {
    const { sharedPool } = await import("../../utils/sharedPool");
    const r = await sharedPool.query(
      `SELECT id FROM regulations WHERE UPPER(regulation_code) = ANY($1::text[])`,
      [codes.map((c) => c.toUpperCase())],
    );
    const ids = r.rows.map((x: any) => Number(x.id)).filter(Number.isFinite);
    return ids.length ? ids : null;
  } catch {
    return null;
  }
}

/**
 * Create a policy from a Documents Library upload (file already saved under the
 * 'policies' module) and project it into the mapping pool. Returns the new
 * policy id. Retries on a policy_number collision.
 */
async function createPolicyFromUpload(opts: {
  category: string;
  title: string;
  filePath: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  notes: string | null;
  regulationCodes: string[] | null;
  uploadedBy: string;
}): Promise<number> {
  const map = CATEGORY_TO_POLICY[opts.category] || CATEGORY_TO_POLICY.documents;
  const { createPolicy } = await import("../../utils/policyDatabase");
  const { syncPolicyToMapping } = await import("../../utils/policyMappingBridge");
  const linkedIds = await resolveRegulationIds(opts.regulationCodes);
  let lastErr: any;
  for (let attempt = 0; attempt < 4; attempt++) {
    let num = await nextLibraryPolicyNumber(map.prefix);
    if (attempt > 0) num = `${num}-${Math.floor(Math.random() * 9000 + 1000)}`;
    try {
      const created = await createPolicy({
        policy_number: num,
        title: opts.title,
        category: map.category as any,
        document_type: map.document_type as any,
        description: opts.notes || undefined,
        file_path: opts.filePath,
        file_name: opts.fileName,
        file_size: opts.fileSize,
        file_mime_type: opts.mimeType,
        created_by: opts.uploadedBy,
        linked_regulation_ids: linkedIds || undefined,
      } as any);
      const pid = Number((created as any).id);
      // Project into qms_uploaded_documents so it shows in Documents Library
      // + Document Mapping. Best-effort — the policy already exists in the
      // register either way.
      try {
        await syncPolicyToMapping(pid, { semantic: false });
      } catch (e) {
        safeLogger.warn("⚠️ [QmsDocs] bridge sync after upload failed", { e });
      }
      return pid;
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message || "").toLowerCase();
      if (!(msg.includes("duplicate") || msg.includes("unique"))) throw e;
    }
  }
  throw lastErr;
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

          const { initQmsDocsTable, isValidCategory } =
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

          // Store under the 'policies' module so /api/policies/:id/(download|view)
          // and the mapping-pool download both resolve the same blob.
          const buffer = Buffer.from(await file.arrayBuffer());
          const fileInfo = await saveUploadedFile(buffer, file.name, file.type, 'policies');

          // Create as a policy (single source of truth); the bridge projects it
          // into the mapping pool so it shows in Documents Library too.
          const policyId = await createPolicyFromUpload({
            category,
            title,
            filePath: fileInfo.filePath,
            fileName: fileInfo.fileName,
            fileSize: fileInfo.fileSize,
            mimeType: fileInfo.mimeType,
            notes,
            regulationCodes: regulation_codes,
            uploadedBy: g.user!.email || String(g.user!.id ?? "") || "unknown",
          });

          return c.json({ success: true, policy_id: policyId });
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

          const { initQmsDocsTable, isValidCategory } =
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
            (f: unknown) => f instanceof File && (f as File).size > 0,
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
                'policies',
              );
              const policyId = await createPolicyFromUpload({
                category,
                title: file.name.replace(/\.[^.]+$/, ""),
                filePath: fileInfo.filePath,
                fileName: fileInfo.fileName,
                fileSize: fileInfo.fileSize,
                mimeType: fileInfo.mimeType,
                notes,
                regulationCodes: regulation_codes,
                uploadedBy: g.user!.email || String(g.user!.id ?? "") || "unknown",
              });
              uploaded.push({ policy_id: policyId, title: file.name.replace(/\.[^.]+$/, "") });
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

          // Scoped read. Rows projected from a policy (source_policy_id set —
          // incl. everything uploaded via Documents Library, which is now
          // stored as a policy) live under /data/documents/policies/; plain
          // legacy library rows live under /data/documents/qms-docs/. Pick the
          // module by provenance so both resolve.
          const module = doc.source_policy_id ? "policies" : "qms-docs";
          const fileBlob = getUploadedFileForModule(doc.file_path, module);
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
          const buf = fileBlob.buffer;
          const payload = new Uint8Array(
            buf.buffer,
            buf.byteOffset,
            buf.byteLength,
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

          if (existing.source_policy_id) {
            // Projected policy row: delete the underlying POLICY (single source
            // of truth) + its mapping projection, else the bridge would simply
            // re-create this row on the next sync. removePolicyMapping deletes
            // the qms_uploaded_documents projection; deletePolicy removes the
            // register entry.
            const { removePolicyMapping } = await import(
              "../../utils/policyMappingBridge"
            );
            const { deletePolicy } = await import("../../utils/policyDatabase");
            await removePolicyMapping(existing.source_policy_id);
            await deletePolicy(existing.source_policy_id);
          } else {
            await deleteDocument(id);
          }
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
