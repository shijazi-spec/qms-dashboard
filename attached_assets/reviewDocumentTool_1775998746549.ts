import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export const reviewDocumentTool = createTool({
  id: "review-document",

  description:
    "Reviews governance documents (policies, SOPs, governance docs) for compliance gaps. " +
    "Can review a specific document by ID or scan all active documents. Checks for " +
    "review currency, completeness, and publication status.",

  inputSchema: z.object({
    documentId: z.number().optional().describe("Specific document ID to review. If omitted, reviews all non-archived documents."),
    documentType: z.enum(["policy", "sop", "governance"]).describe("Type of document to review"),
    checkAgainst: z.enum(["pdpl", "iso_9001", "iso_27001", "general"]).optional()
      .describe("Standard to check the document against (default: general)"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    documentTitle: z.string(),
    gaps: z.array(z.object({
      area: z.string(),
      finding: z.string(),
      recommendation: z.string(),
      severity: z.enum(["critical", "major", "minor", "observation"]),
    })),
    overallStatus: z.enum(["compliant", "needs_review", "non_compliant"]),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📄 [reviewDocumentTool] Starting document review...", {
      documentId: context.documentId,
      documentType: context.documentType,
      checkAgainst: context.checkAgainst || "general",
    });

    try {
      let rows: any[];

      if (context.documentId) {
        const result = await pool.query(
          `SELECT * FROM governance_documents WHERE id = $1 AND document_type = $2`,
          [context.documentId, context.documentType]
        );
        rows = result.rows;
      } else {
        const result = await pool.query(
          `SELECT * FROM governance_documents WHERE document_type = $1 AND status != 'archived' ORDER BY updated_at DESC`,
          [context.documentType]
        );
        rows = result.rows;
      }

      if (rows.length === 0) {
        return {
          success: true,
          documentTitle: context.documentId ? `Document #${context.documentId}` : `All ${context.documentType} documents`,
          gaps: [{
            area: "Document Availability",
            finding: "No documents found matching the criteria.",
            recommendation: "Ensure documents exist and are not archived.",
            severity: "major" as const,
          }],
          overallStatus: "needs_review" as const,
        };
      }

      const gaps: Array<{ area: string; finding: string; recommendation: string; severity: "critical" | "major" | "minor" | "observation" }> = [];
      const now = new Date();
      const oneYearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

      for (const doc of rows) {
        const reviewDate = doc.review_date ? new Date(doc.review_date) : null;
        if (!reviewDate || reviewDate < oneYearAgo) {
          gaps.push({
            area: "Review Currency",
            finding: `Document "${doc.title}" has not been reviewed in over 365 days (last review: ${reviewDate ? reviewDate.toISOString().split('T')[0] : 'never'}).`,
            recommendation: "Schedule an immediate document review with the document owner and relevant stakeholders.",
            severity: reviewDate ? "major" : "critical",
          });
        }

        const requiredFields = ["title", "description", "owner", "version"];
        const missingFields = requiredFields.filter(f => !doc[f] || String(doc[f]).trim() === "");
        if (missingFields.length > 0) {
          gaps.push({
            area: "Document Completeness",
            finding: `Document "${doc.title || `ID:${doc.id}`}" is missing required fields: ${missingFields.join(", ")}.`,
            recommendation: "Complete all mandatory fields before publishing the document.",
            severity: missingFields.includes("title") || missingFields.includes("description") ? "major" : "minor",
          });
        }

        if (doc.status !== "published") {
          gaps.push({
            area: "Publication Status",
            finding: `Document "${doc.title}" has status "${doc.status}" instead of "published".`,
            recommendation: "Finalize review and publish the document to make it effective.",
            severity: doc.status === "draft" ? "major" : "minor",
          });
        }
      }

      let overallStatus: "compliant" | "needs_review" | "non_compliant";
      const hasCritical = gaps.some(g => g.severity === "critical");
      const hasMajor = gaps.some(g => g.severity === "major");

      if (hasCritical) {
        overallStatus = "non_compliant";
      } else if (hasMajor) {
        overallStatus = "needs_review";
      } else {
        overallStatus = gaps.length === 0 ? "compliant" : "needs_review";
      }

      const title = context.documentId
        ? rows[0]?.title || `Document #${context.documentId}`
        : `${rows.length} ${context.documentType} document(s)`;

      logger?.info("✅ [reviewDocumentTool] Review complete", {
        documentsReviewed: rows.length,
        gapsFound: gaps.length,
        overallStatus,
      });

      return {
        success: true,
        documentTitle: title,
        gaps,
        overallStatus,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [reviewDocumentTool] Review failed", { error: errorMessage });

      return {
        success: false,
        documentTitle: "Error",
        gaps: [],
        overallStatus: "non_compliant" as const,
        error: errorMessage,
      };
    }
  },
});
