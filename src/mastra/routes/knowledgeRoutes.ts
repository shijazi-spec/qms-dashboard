import { requireRole } from "../../utils/rbacMiddleware";
import type { UserRole } from "../../utils/rbacDatabase";

const KNOWLEDGE_READ_ROLES: UserRole[] = ['admin', 'ai_specialist', 'grc_manager', 'head_of_operations_quality', 'quality_manager'];
const KNOWLEDGE_WRITE_ROLES: UserRole[] = ['admin', 'ai_specialist', 'grc_manager'];
const KNOWLEDGE_DELETE_ROLES: UserRole[] = ['admin', 'grc_manager'];

export const knowledgeRoutes = [
  {
    path: "/api/knowledge/documents",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, KNOWLEDGE_READ_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);

          const { getDocuments, initKnowledgeTables } = await import("../../utils/knowledgeDatabase");
          await initKnowledgeTables();
          const documentType = c.req.query("type");
          const docs = await getDocuments({ document_type: documentType, is_active: true });
          return c.json({ success: true, documents: docs });
        } catch (error) {
          return c.json({ error: "Failed to fetch documents" }, 500);
        }
      };
    },
  },
  {
    path: "/api/knowledge/upload",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, KNOWLEDGE_WRITE_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);

          const { ingestDocument, initKnowledgeTables } = await import("../../utils/knowledgeDatabase");
          await initKnowledgeTables();
          const body = await c.req.json();

          if (!body.title || !body.content) {
            return c.json({ error: "title and content are required" }, 400);
          }

          const result = await ingestDocument({
            title: body.title,
            description: body.description,
            document_type: body.documentType || 'other',
            source: body.source,
            file_type: body.fileType || 'text',
            file_size: body.content.length,
            uploaded_by: user.email,
            tags: body.tags || [],
          }, body.content);

          try {
            const { logEvent } = await import("../../utils/eventLogsDatabase");
            await logEvent({
              actionType: 'CREATE',
              entityType: 'DOCUMENT',
              entityId: String(result.document.id),
              entityName: body.title,
              description: `Knowledge base document uploaded: ${body.title} (${result.chunkCount} chunks)`,
              module: 'knowledge',
              severity: 'INFO',
            });
          } catch {}

          return c.json({
            success: true,
            document: result.document,
            chunkCount: result.chunkCount,
            message: `Document "${body.title}" ingested with ${result.chunkCount} searchable chunks`,
          });
        } catch (error) {
          console.error("[Knowledge] Upload error:", error);
          return c.json({ error: "Failed to upload document" }, 500);
        }
      };
    },
  },
  {
    path: "/api/knowledge/search",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, KNOWLEDGE_READ_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);

          const { searchKnowledge, initKnowledgeTables } = await import("../../utils/knowledgeDatabase");
          await initKnowledgeTables();
          const query = c.req.query("q");
          if (!query) return c.json({ error: "q parameter is required" }, 400);
          const documentType = c.req.query("type");
          const documentId = c.req.query("documentId") ? parseInt(c.req.query("documentId")) : undefined;
          const limit = parseInt(c.req.query("limit") || "10");

          const results = await searchKnowledge(query, { documentType, documentId, limit });
          return c.json({
            success: true,
            query,
            results: results.map(r => ({
              documentTitle: r.document_title,
              section: r.chunk.section_title,
              content: r.chunk.content,
              pageNumber: r.chunk.page_number,
              relevance: r.rank,
            })),
          });
        } catch (error) {
          return c.json({ error: "Search failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/knowledge/documents/:id",
    method: "DELETE" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, KNOWLEDGE_DELETE_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);

          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
          const { deleteDocument, initKnowledgeTables } = await import("../../utils/knowledgeDatabase");
          await initKnowledgeTables();
          const deleted = await deleteDocument(id);
          if (!deleted) return c.json({ error: "Document not found" }, 404);
          return c.json({ success: true });
        } catch (error) {
          return c.json({ error: "Failed to delete document" }, 500);
        }
      };
    },
  },
  {
    path: "/api/checklists",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { getChecklists, initChecklistTables } = await import("../../utils/checklistDatabase");
          await initChecklistTables();
          const standard = c.req.query("standard");
          const checklists = await getChecklists({ standard, is_active: true });
          return c.json({ success: true, checklists });
        } catch (error) {
          return c.json({ error: "Failed to fetch checklists" }, 500);
        }
      };
    },
  },
  {
    path: "/api/checklists/:id",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
          const { getChecklistById, initChecklistTables } = await import("../../utils/checklistDatabase");
          await initChecklistTables();
          const data = await getChecklistById(id);
          if (!data) return c.json({ error: "Checklist not found" }, 404);
          return c.json({ success: true, ...data });
        } catch (error) {
          return c.json({ error: "Failed to fetch checklist" }, 500);
        }
      };
    },
  },
  {
    path: "/api/checklists/:id/run",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
          const { runChecklist, initChecklistTables } = await import("../../utils/checklistDatabase");
          await initChecklistTables();
          const run = await runChecklist(id, "api");
          return c.json({ success: true, run });
        } catch (error) {
          return c.json({ error: "Failed to run checklist" }, 500);
        }
      };
    },
  },
  {
    path: "/api/checklists/:id/runs",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
          const { getChecklistRuns, initChecklistTables } = await import("../../utils/checklistDatabase");
          await initChecklistTables();
          const runs = await getChecklistRuns(id);
          return c.json({ success: true, runs });
        } catch (error) {
          return c.json({ error: "Failed to fetch runs" }, 500);
        }
      };
    },
  },
];
