import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const searchKnowledgeTool = createTool({
  id: "search-knowledge-base",
  description:
    "Searches the uploaded regulatory knowledge base for relevant information. Use this to find specific " +
    "clauses, requirements, or guidance from uploaded documents (ISO standards, PDPL law, SOPs, internal " +
    "policies, audit standards). Returns matching text passages with document source and section references. " +
    "Use 'search' to find content, 'list' to see all documents, or 'document' to get a specific document's details.",
  inputSchema: z.object({
    action: z.enum(["search", "list", "document"]).describe("Action: search for content, list all documents, or get document details"),
    query: z.string().optional().describe("Search query (for search action) -- use keywords related to the regulation, clause, or topic"),
    documentType: z.string().optional().describe("Filter by document type: regulation, standard, sop, policy, guideline"),
    documentId: z.number().optional().describe("Specific document ID (for document action or to scope search)"),
    limit: z.number().optional().describe("Max results to return (default 10)"),
  }),
  execute: async ({ context }) => {
    const { action, query, documentType, documentId, limit } = context;

    const { searchKnowledge, getDocuments, getDocumentById, initKnowledgeTables } = await import("../../utils/knowledgeDatabase");
    await initKnowledgeTables();

    if (action === "list") {
      const docs = await getDocuments({ document_type: documentType, is_active: true });
      if (docs.length === 0) {
        return {
          success: true,
          message: "No documents in the knowledge base. Documents can be uploaded via the Consultant page or the /api/knowledge/upload endpoint.",
          documents: [],
        };
      }
      return {
        success: true,
        count: docs.length,
        documents: docs.map((d: any) => ({
          id: d.id, title: d.title, type: d.document_type, source: d.source,
          tags: d.tags, chunkCount: d.chunk_count, uploadedAt: d.created_at,
        })),
      };
    }

    if (action === "document") {
      if (!documentId) return { success: false, error: "documentId is required" };
      const doc = await getDocumentById(documentId);
      if (!doc) return { success: false, error: "Document not found" };
      return {
        success: true,
        document: {
          id: doc.id, title: doc.title, description: doc.description,
          type: doc.document_type, source: doc.source, fileType: doc.file_type,
          tags: doc.tags, uploadedBy: doc.uploaded_by, createdAt: doc.created_at,
        },
      };
    }

    if (action === "search") {
      if (!query) return { success: false, error: "query is required for search" };
      const results = await searchKnowledge(query, { documentId, documentType, limit: limit || 10 });
      if (results.length === 0) {
        return {
          success: true,
          message: `No results found for "${query}". Try broader keywords or check if relevant documents have been uploaded.`,
          results: [],
        };
      }
      return {
        success: true,
        query,
        resultCount: results.length,
        results: results.map(r => ({
          documentTitle: r.document_title,
          section: r.chunk.section_title,
          content: r.chunk.content.substring(0, 1000),
          pageNumber: r.chunk.page_number,
          relevance: Math.round(r.rank * 100) / 100,
        })),
      };
    }

    return { success: false, error: "Unknown action" };
  },
});
