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

// Phase 1-3 — write roles for compliance mapping (link / unlink / judge).
// Plan calls for admin, head_of_operations_quality, grc_manager, quality_manager.
const WRITE_ROLES = [
  "admin",
  "head_of_operations_quality",
  "grc_manager",
  "quality_manager",
];

const MAX_FILES_PER_REQUEST = 20;
const MAX_TOTAL_BYTES_PER_REQUEST = 50 * 1024 * 1024; // 50 MB
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
              linked_by: g.user!.email || String(g.user!.id ?? "") || "unknown",
            });
            try {
              const { logEvent } = await import(
                "../../utils/eventLogsDatabase"
              );
              await logEvent({
                actionType: "CREATE" as any,
                entityType: "SYSTEM" as any,
                entityName: "obligation_documents",
                description: `Manual link: doc ${documentId} → obligation ${id}`,
                module: "compliance" as any,
                severity: "INFO" as any,
                userEmail: g.user?.email,
              });
            } catch {
              /* never block on audit */
            }
            // Phase 3 — fire judge event for the new link.
            try {
              const { inngest } = await import("../inngest/client");
              await inngest.send({
                name: "compliance.mapping.applied",
                data: {
                  obligation_id: id,
                  document_id: documentId,
                  applied_by: g.user?.email || "manual-link",
                },
              });
            } catch (sendErr) {
              safeLogger.warn(
                "[ObligationDocs] dispatch compliance.mapping.applied failed:",
                sendErr,
              );
            }
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
          if (removed) {
            try {
              const { logEvent } = await import(
                "../../utils/eventLogsDatabase"
              );
              await logEvent({
                actionType: "DELETE" as any,
                entityType: "SYSTEM" as any,
                entityName: "obligation_documents",
                description: `Unlink: doc ${docId} from obligation ${id}`,
                module: "compliance" as any,
                severity: "INFO" as any,
                userEmail: g.user?.email,
              });
            } catch {
              /* never block on audit */
            }
          }
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
            return c.json({ error: 'Request body too large (max 50 MB total)' }, 413);
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
            (f: unknown) => f instanceof File && (f as File).size > 0,
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
                'qms-docs',
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
                uploaded_by: g.user!.email || String(g.user!.id ?? "") || "unknown",
              });
              await linkDocumentToObligation({
                obligation_id: obligationId,
                document_id: doc.id,
                linked_by: g.user!.email || String(g.user!.id ?? "") || "unknown",
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

  // ──────────────────────────────────────────────────────────────────
  // Phase 2.3 — AI-assisted mapping endpoints
  //
  //   POST /api/compliance/documents/:id/suggest-mappings
  //         → ranked list of obligations the document likely satisfies
  //   POST /api/compliance/documents/:id/apply-mapping  { obligation_id }
  //         → creates the link in obligation_documents (writes audit log)
  //   POST /api/compliance/obligations/:id/suggest-documents
  //         → reverse: which uploaded docs likely satisfy this clause
  // ──────────────────────────────────────────────────────────────────

  {
    path: "/api/compliance/documents/:id/suggest-mappings",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const g = await gate(c, READ_ROLES);
          if (g.error) return g.error;
          const documentId = parseInt(c.req.param("id"), 10);
          if (!Number.isFinite(documentId))
            return c.json({ error: "Invalid document id" }, 400);

          const body = await c.req.json().catch(() => ({}));
          const topN = Math.min(20, Math.max(1, parseInt(body?.top_n, 10) || 5));

          const { suggestObligationMappingTool } = await import(
            "../tools/suggestObligationMappingTool"
          );
          // Tools call returns the validated outputSchema shape.
          const result = await (suggestObligationMappingTool as any).execute({
            context: { documentId, topN },
          });
          if (!result?.success) {
            return c.json(
              {
                success: false,
                error: result?.error || "Suggestion failed",
                document_id: documentId,
              },
              result?.error?.includes("not found") ? 404 : 400,
            );
          }
          return c.json(result);
        } catch (error) {
          safeLogger.error("❌ [ObligationDocs] suggest-mappings error:", error);
          return c.json({ error: "Failed to suggest mappings" }, 500);
        }
      };
    },
  },

  {
    path: "/api/compliance/documents/:id/apply-mapping",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const g = await gate(c, WRITE_ROLES);
          if (g.error) return g.error;

          const documentId = parseInt(c.req.param("id"), 10);
          if (!Number.isFinite(documentId))
            return c.json({ error: "Invalid document id" }, 400);

          const body = await c.req.json().catch(() => ({}));
          const obligationId = parseInt(body?.obligation_id, 10);
          if (!Number.isFinite(obligationId))
            return c.json({ error: "obligation_id is required" }, 400);

          const { linkDocumentToObligation } = await import(
            "../../utils/obligationDocumentsDatabase"
          );
          let link: any;
          try {
            link = await linkDocumentToObligation({
              obligation_id: obligationId,
              document_id: documentId,
              linked_by: g.user!.email || String(g.user!.id ?? "") || "ai-suggest",
            });
          } catch (err: any) {
            if (err && err.code === "23503")
              return c.json(
                { error: "Unknown obligation_id or document_id" },
                400,
              );
            throw err;
          }

          // Audit + Phase 3 trigger.
          try {
            const { logEvent } = await import("../../utils/eventLogsDatabase");
            await logEvent({
              actionType: "CREATE" as any,
              entityType: "SYSTEM" as any,
              entityName: `obligation_documents`,
              description: `AI-suggested mapping accepted: doc ${documentId} → obligation ${obligationId}`,
              module: "compliance" as any,
              severity: "INFO" as any,
              userEmail: g.user?.email,
            });
          } catch {
            /* never block on audit */
          }
          // Phase 3 — fire judge event so quality assessment runs async.
          try {
            const { inngest } = await import("../inngest/client");
            await inngest.send({
              name: "compliance.mapping.applied",
              data: {
                obligation_id: obligationId,
                document_id: documentId,
                applied_by: g.user?.email || "ai-suggest",
              },
            });
          } catch (err) {
            safeLogger.warn(
              "[ObligationDocs] failed to dispatch compliance.mapping.applied:",
              err,
            );
          }

          return c.json({
            success: true,
            link,
            already_linked: !link,
          });
        } catch (error) {
          safeLogger.error("❌ [ObligationDocs] apply-mapping error:", error);
          return c.json({ error: "Failed to apply mapping" }, 500);
        }
      };
    },
  },

  // Phase 3 — manual re-judge endpoint for a specific (obligation, document)
  // pair. Useful when an evidence quality decision needs to be refreshed
  // outside the daily cron.
  {
    path: "/api/compliance/obligations/:id/judge",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const g = await gate(c, WRITE_ROLES);
          if (g.error) return g.error;
          const obligationId = parseInt(c.req.param("id"), 10);
          if (!Number.isFinite(obligationId))
            return c.json({ error: "Invalid obligation id" }, 400);
          const body = await c.req.json().catch(() => ({}));
          const documentId = parseInt(body?.document_id, 10);
          if (!Number.isFinite(documentId))
            return c.json({ error: "document_id is required" }, 400);
          const { judgeEvidence } = await import(
            "../../utils/complianceJudge"
          );
          const verdict = await judgeEvidence(
            obligationId,
            documentId,
            g.user?.email || "manual-rejudge",
          );
          return c.json({ success: true, verdict });
        } catch (error) {
          safeLogger.error("❌ [ObligationDocs] judge error:", error);
          return c.json({ error: "Failed to judge evidence" }, 500);
        }
      };
    },
  },

  // Phase 3 — Non-Compliance Findings (drives the dashboard table).
  {
    path: "/api/compliance/non-compliance-findings",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const g = await gate(c, READ_ROLES);
          if (g.error) return g.error;
          const url = new URL(c.req.url);
          const regParam = url.searchParams.get("regulation_id");
          const limit = parseInt(url.searchParams.get("limit") || "200", 10);
          const opts: any = { limit };
          if (regParam) opts.regulationId = parseInt(regParam, 10);
          const { listNonComplianceFindings } = await import(
            "../../utils/complianceQualityDatabase"
          );
          const findings = await listNonComplianceFindings(opts);
          return c.json({ success: true, findings, count: findings.length });
        } catch (error) {
          safeLogger.error("❌ [ObligationDocs] findings error:", error);
          return c.json({ error: "Failed to load findings" }, 500);
        }
      };
    },
  },

  // Re-judge existing non-compliance findings so their AI rationales are
  // regenerated with the latest (more actionable) judge prompt. Batched +
  // bounded by a `before` cutoff so the UI can loop to completion. Write
  // action → gov roles only.
  {
    path: "/api/compliance/non-compliance-findings/rejudge",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const g = await gate(c, WRITE_ROLES);
          if (g.error) return g.error;
          const body = await c.req.json().catch(() => ({}));
          const before =
            typeof body.before === "string" && body.before
              ? body.before
              : new Date().toISOString();
          const {
            listFindingsToRejudge,
            countFindingsToRejudge,
          } = await import("../../utils/complianceQualityDatabase");

          if (body.estimate) {
            return c.json({
              success: true,
              before,
              remaining: await countFindingsToRejudge(before),
            });
          }

          const { judgeEvidence } = await import("../../utils/complianceJudge");
          const batch = await listFindingsToRejudge({ before, limit: 6 });
          const votes = Number(process.env.DOCUMENT_MAPPING_JUDGE_VOTES) || 3;
          const by = g.user?.email || "ai-review";
          let processed = 0;
          for (const f of batch) {
            try {
              await judgeEvidence(
                Number(f.obligation_id),
                Number(f.document_id),
                by,
                { votes },
              );
              processed++;
            } catch (err) {
              safeLogger.warn(
                `[ObligationDocs] rejudge failed ob=${f.obligation_id} doc=${f.document_id}: ${(err as Error).message}`,
              );
            }
          }
          const remaining = await countFindingsToRejudge(before);
          return c.json({ success: true, before, processed, remaining });
        } catch (error) {
          safeLogger.error("❌ [ObligationDocs] rejudge error:", error);
          return c.json({ error: "Failed to re-judge findings" }, 500);
        }
      };
    },
  },

  {
    path: "/api/compliance/obligations/:id/suggest-documents",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const g = await gate(c, READ_ROLES);
          if (g.error) return g.error;

          const obligationId = parseInt(c.req.param("id"), 10);
          if (!Number.isFinite(obligationId))
            return c.json({ error: "Invalid obligation id" }, 400);

          const { sharedPool } = await import("../../utils/sharedPool");
          const obRes = await sharedPool.query(
            `SELECT o.id, o.obligation_code, o.title, o.description, r.regulation_code
               FROM obligations o
               JOIN regulations r ON o.regulation_id = r.id
              WHERE o.id = $1`,
            [obligationId],
          );
          if (obRes.rows.length === 0)
            return c.json({ error: "Obligation not found" }, 404);
          const ob = obRes.rows[0];

          // Full-corpus, full-body search. The previous implementation read
          // LEFT(extracted_text, 1500) from the 25 most recently uploaded rows,
          // so it judged every clause of every framework against a cover page
          // from the same fixed 25-document window. It now ranks EVERY document
          // that has extracted text, against its whole body, over the GIN
          // full-text index created in qmsDocsDatabase (the to_tsvector
          // expression here must stay identical to the indexed one).
          //
          // `extraction_status <> 'placeholder'` is still load-bearing. Register
          // entries awaiting their file upload project a row whose only text is
          // the register's own blurb ("Controlled document (WP-...) - pending
          // file upload"). Those matched every framework, scored 0 against every
          // clause, and — an all-zero sort being a no-op — came back in
          // uploaded_at order, i.e. the SAME list every time, dressed up as a
          // relevance ranking.
          const STOP_WORDS = new Set([
            "the", "and", "for", "with", "that", "this", "from", "shall",
            "must", "are", "its", "their", "other", "within", "into", "upon",
            "been", "such", "any", "all", "which", "when", "where", "should",
          ]);
          const obKeywords: string[] = Array.from(
            new Set(
              String(ob.title || "")
                .toLowerCase()
                .split(/[^a-z0-9]+/)
                .filter((w: string) => w.length >= 4 && !STOP_WORDS.has(w)),
            ),
          );

          // The real size of the searched corpus. Reported to the user so
          // "N document(s) were checked" states what was actually examined —
          // the old number was `LIMIT 25` wearing a disguise.
          const consideredRes = await sharedPool.query(
            `SELECT COUNT(*)::int AS n
               FROM qms_uploaded_documents
              WHERE COALESCE(extraction_status, '') <> 'placeholder'
                AND extracted_text IS NOT NULL
                AND extracted_text <> ''`,
          );
          const consideredCount: number = consideredRes.rows[0]?.n ?? 0;

          // OR-joined tsquery. plainto_tsquery ANDs its terms, which returns
          // nothing for all but the shortest clause titles; ranking is what
          // separates a document matching four terms from one matching one.
          const tsQuery = obKeywords.join(" | ");

          let scored: any[] = [];
          if (tsQuery && consideredCount > 0) {
            const docsRes = await sharedPool.query(
              `WITH q AS (SELECT to_tsquery('english', $1) AS tsq)
               SELECT d.id, d.title, d.mime_type, d.regulation_codes,
                      d.extraction_status,
                      ts_rank_cd(
                        to_tsvector('english', COALESCE(d.extracted_text, '')),
                        q.tsq
                      ) AS fts_rank,
                      -- How many DISTINCT clause terms appear in the body.
                      -- Plain containment, not a second tsvector pass: building
                      -- a tsvector of a 50k-char body once per term per row is
                      -- the expensive way to ask a cheap question, and this
                      -- also works for the Arabic documents, which 'english'
                      -- does not stem.
                      (SELECT COUNT(*)::int
                         FROM unnest($2::text[]) AS w
                        WHERE d.extracted_text ILIKE '%' || w || '%') AS terms_matched,
                      ts_headline(
                        'english', COALESCE(d.extracted_text, ''), q.tsq,
                        'MaxFragments=3, MinWords=8, MaxWords=26, FragmentDelimiter=" ... ", StartSel="<<", StopSel=">>"'
                      ) AS snippet
                 FROM qms_uploaded_documents d, q
                WHERE COALESCE(d.extraction_status, '') <> 'placeholder'
                  AND d.extracted_text IS NOT NULL
                  AND to_tsvector('english', COALESCE(d.extracted_text, '')) @@ q.tsq
                ORDER BY terms_matched DESC, fts_rank DESC
                LIMIT 10`,
              [tsQuery, obKeywords],
            );

            // Every row here matched at least one clause term in the body, so
            // the score reports evidence rather than manufacturing a ranking:
            // how many DISTINCT clause terms the document actually contains,
            // plus a small nudge for carrying the framework tag.
            scored = docsRes.rows.map((d: any) => {
              const termsMatched = Number(d.terms_matched) || 0;
              let score = termsMatched * 10;
              if (
                Array.isArray(d.regulation_codes) &&
                d.regulation_codes.includes(ob.regulation_code)
              ) {
                score += 5;
              }
              return {
                document_id: d.id,
                title: d.title,
                // The passage that matched, not the first page — this is what
                // makes the result reviewable rather than a bare filename.
                excerpt: d.snippet,
                extraction_status: d.extraction_status,
                terms_matched: termsMatched,
                terms_total: obKeywords.length,
                score,
              };
            });
          }

          // Stage 2 — semantic pass. Full-text finds documents that use the
          // clause's WORDS; this finds ones that satisfy it in different words,
          // which is most of them: a clause saying "nonconformity and
          // corrective action" is answered by a procedure that says "raising
          // and closing a CAPA" and shares not one search term with it.
          //
          // Additive and best-effort. Every failure path returns [] and leaves
          // the full-text ranking exactly as it was, so the Console degrades to
          // Stage 1 rather than breaking when embeddings are off or OpenAI is
          // unreachable.
          const byId = new Map<number, any>();
          for (const s of scored) {
            byId.set(s.document_id, { ...s, match_via: "text" });
          }

          try {
            const { semanticDocumentCandidates } = await import(
              "../../utils/documentChunkEmbeddings"
            );
            const clauseText = [ob.obligation_code, ob.title, ob.description]
              .filter(Boolean)
              .join(" — ");
            const semantic = await semanticDocumentCandidates(clauseText, {
              limit: 10,
            });

            if (semantic.length > 0) {
              // Titles for documents the text pass never surfaced.
              const unseen = semantic
                .map((s: any) => s.document_id)
                .filter((id: number) => !byId.has(id));
              const titles = new Map<number, any>();
              if (unseen.length > 0) {
                const tRes = await sharedPool.query(
                  `SELECT id, title, extraction_status, regulation_codes
                     FROM qms_uploaded_documents WHERE id = ANY($1::int[])`,
                  [unseen],
                );
                for (const r of tRes.rows) titles.set(r.id, r);
              }

              for (const hit of semantic) {
                const sim = Number(hit.best_similarity) || 0;
                const existing = byId.get(hit.document_id);
                if (existing) {
                  // Both passes agree — the strongest signal available here.
                  existing.match_via = "both";
                  existing.semantic_similarity = Number(sim.toFixed(3));
                  existing.score += Math.round(sim * 20);
                  if (hit.chunks?.[0]?.chunk_text) {
                    existing.matched_passage = hit.chunks[0].chunk_text;
                  }
                  continue;
                }
                const meta = titles.get(hit.document_id);
                if (!meta) continue;
                byId.set(hit.document_id, {
                  document_id: hit.document_id,
                  title: meta.title,
                  // The passage itself: for a semantic-only hit there is no
                  // keyword to highlight, so the passage IS the justification.
                  excerpt: hit.chunks?.[0]?.chunk_text || "",
                  matched_passage: hit.chunks?.[0]?.chunk_text || "",
                  extraction_status: meta.extraction_status,
                  terms_matched: 0,
                  terms_total: obKeywords.length,
                  semantic_similarity: Number(sim.toFixed(3)),
                  match_via: "semantic",
                  score: Math.round(sim * 100),
                });
              }
            }
          } catch (err) {
            safeLogger.warn(
              `[ObligationDocs] semantic pass unavailable: ${(err as Error).message}`,
            );
          }

          const ranked = Array.from(byId.values())
            .sort((a: any, b: any) => b.score - a.score)
            .slice(0, 10);

          // Machine-readable reason so the UI can say something true rather
          // than rendering an empty list with no explanation.
          let empty_reason: string | null = null;
          if (ranked.length === 0) {
            empty_reason =
              consideredCount === 0
                ? "no_documents_with_content"
                : "no_relevant_match";
          }

          return c.json({
            success: true,
            obligation_id: obligationId,
            obligation_code: ob.obligation_code,
            candidates: ranked,
            candidates_considered: consideredCount,
            empty_reason,
          });
        } catch (error) {
          safeLogger.error("❌ [ObligationDocs] suggest-documents error:", error);
          return c.json({ error: "Failed to suggest documents" }, 500);
        }
      };
    },
  },
];
