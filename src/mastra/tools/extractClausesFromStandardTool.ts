/**
 * extractClausesFromStandardTool — Compliance v2 Pillar 1.
 *
 * Given an uploaded standard/regulation PDF (qms_uploaded_documents.id),
 * asks the LLM to draft a list of clauses/articles in a structured form
 * the platform can persist as `obligations` rows after human review.
 *
 * Strict policy:
 *   - The model MUST return a JSON array; we tolerate code-fences and
 *     stray prose around it (defensive parsing identical to the
 *     suggest/judge tools).
 *   - Each draft row has: obligation_code, article_reference,
 *     clause_number, title, description, section_domain, priority.
 *   - Codes are normalised (uppercased, spaces → '-') so they are safe
 *     to insert into obligations(obligation_code) UNIQUE.
 *   - Excerpt is capped at EXTRACT_MAX_DOC_CHARS to protect token budget.
 *
 * The prompt builder + parser are exported separately so they can be
 * unit-tested without hitting OpenAI.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { sharedPool as pool } from "../../utils/sharedPool";

export const EXTRACT_MAX_DOC_CHARS = 24_000;
export const EXTRACT_MAX_CLAUSES = 200;
export const EXTRACT_MODEL =
  process.env.COMPLIANCE_INGEST_MODEL || "gpt-4o-mini";

export interface DraftClauseOut {
  obligation_code: string;
  article_reference: string | null;
  clause_number: string | null;
  title: string;
  description: string;
  section_domain: string | null;
  priority: "critical" | "high" | "medium" | "low";
}

/**
 * Pure: build the LLM prompt. Exported for testing.
 */
export function buildExtractPrompt(input: {
  regulationCode: string | null;
  regulationName: string | null;
  text: string;
}): string {
  const code = input.regulationCode || "(unknown)";
  const name = input.regulationName || "(unnamed standard)";
  const excerpt = (input.text || "").slice(0, EXTRACT_MAX_DOC_CHARS);
  return [
    `You are a senior GRC consultant reading the source text of a compliance standard or regulation.`,
    `Your job is to extract every individual clause/article/control as a structured JSON record so a compliance team can track each one separately.`,
    ``,
    `## STANDARD`,
    `Code: ${code}`,
    `Name: ${name}`,
    ``,
    `## SOURCE TEXT (first ${EXTRACT_MAX_DOC_CHARS} chars)`,
    `"""`,
    excerpt || "(no extracted text available)",
    `"""`,
    ``,
    `## TASK`,
    `Identify every numbered clause, article, control, or sub-control in the text.`,
    `For each one, return:`,
    `- obligation_code (uppercase short ID, e.g. "ISO27001-A.5.1", "PDPL-ART-6", "PCI-DSS-3.2.1"; combine the standard code with the clause number; max 50 chars)`,
    `- article_reference (the exact reference as written in the text, e.g. "Article 6", "A.5.1", "Clause 8.2.1"; null if none)`,
    `- clause_number (just the numeric/dotted part, e.g. "5.1", "8.2.1", "6"; null if none)`,
    `- title (a short human-readable name, max 200 chars)`,
    `- description (the actual requirement; quote or closely paraphrase from the text; max 1500 chars)`,
    `- section_domain (the parent chapter/domain name from the text, e.g. "Information Security Policies", "Access Control"; null if none)`,
    `- priority ("critical" | "high" | "medium" | "low") — your judgement based on whether non-compliance would cause material legal, financial, or operational harm`,
    ``,
    `Return ONLY a JSON array (no prose, no code fences) with at most ${EXTRACT_MAX_CLAUSES} entries, sorted by clause_number.`,
    `Skip preamble, definitions, scope, and references — only return actual requirement clauses.`,
    `If the source text contains no extractable clauses, return [].`,
  ].join("\n");
}

/**
 * Pure: parse the model output. Tolerates code-fences and stray prose
 * around the JSON array. Exported for testing.
 */
export function parseExtractResponse(raw: string): DraftClauseOut[] {
  if (!raw) return [];
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  let parsed: any;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: DraftClauseOut[] = [];
  const seen = new Set<string>();
  for (const row of parsed) {
    if (!row || typeof row !== "object") continue;
    let code = String(row.obligation_code || "").trim();
    if (!code) continue;
    code = code.toUpperCase().replace(/\s+/g, "-").slice(0, 50);
    if (seen.has(code)) continue; // de-dupe; first occurrence wins
    seen.add(code);
    const title = String(row.title || "").slice(0, 500).trim();
    const description = String(row.description || "").slice(0, 1500).trim();
    if (!title || !description) continue;
    const allowedPriorities = new Set(["critical", "high", "medium", "low"]);
    let priority = String(row.priority || "medium").toLowerCase();
    if (!allowedPriorities.has(priority)) priority = "medium";
    out.push({
      obligation_code: code,
      article_reference:
        row.article_reference != null ? String(row.article_reference).slice(0, 100) : null,
      clause_number:
        row.clause_number != null ? String(row.clause_number).slice(0, 50) : null,
      title,
      description,
      section_domain:
        row.section_domain != null ? String(row.section_domain).slice(0, 100) : null,
      priority: priority as DraftClauseOut["priority"],
    });
    if (out.length >= EXTRACT_MAX_CLAUSES) break;
  }
  return out;
}

/**
 * End-to-end: load the document + (optional) regulation, build prompt,
 * call LLM, parse. Returns the draft array.
 */
export async function extractClausesForDocument(
  documentId: number,
  regulationId: number | null,
): Promise<{
  draft: DraftClauseOut[];
  candidate_text_length: number;
  llm_model: string;
}> {
  const docRes = await pool.query(
    `SELECT id, title, extracted_text, extraction_status
       FROM qms_uploaded_documents WHERE id = $1`,
    [documentId],
  );
  if (docRes.rows.length === 0) {
    throw new Error(`Document ${documentId} not found`);
  }
  const doc = docRes.rows[0];
  if (!doc.extracted_text || doc.extracted_text.length < 200) {
    throw new Error(
      `Document text not yet extracted (status: ${doc.extraction_status || "unknown"}).`,
    );
  }

  let regulationCode: string | null = null;
  let regulationName: string | null = null;
  if (regulationId) {
    const regRes = await pool.query(
      `SELECT regulation_code, name FROM regulations WHERE id = $1`,
      [regulationId],
    );
    if (regRes.rows.length > 0) {
      regulationCode = regRes.rows[0].regulation_code;
      regulationName = regRes.rows[0].name;
    }
  }

  const prompt = buildExtractPrompt({
    regulationCode,
    regulationName,
    text: doc.extracted_text,
  });

  const { createOpenAI } = await import("@ai-sdk/openai");
  const { generateText } = await import("ai");
  const openai = createOpenAI({
    baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
    apiKey:
      process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||
      process.env.OPENAI_API_KEY,
  });

  const result = await generateText({
    model: openai(EXTRACT_MODEL),
    prompt,
    maxTokens: 4000,
  });

  const draft = parseExtractResponse(result.text);
  return {
    draft,
    candidate_text_length: doc.extracted_text.length,
    llm_model: EXTRACT_MODEL,
  };
}

export const extractClausesFromStandardTool = createTool({
  id: "extract-clauses-from-standard",
  description:
    "Extract a draft list of compliance clauses/articles from an uploaded standard or regulation PDF. " +
    "Returns clauses for human review; does NOT write to the obligations table.",
  inputSchema: z.object({
    documentId: z.number().int().positive(),
    regulationId: z.number().int().positive().optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    document_id: z.number(),
    regulation_id: z.number().nullable(),
    draft: z.array(
      z.object({
        obligation_code: z.string(),
        article_reference: z.string().nullable(),
        clause_number: z.string().nullable(),
        title: z.string(),
        description: z.string(),
        section_domain: z.string().nullable(),
        priority: z.enum(["critical", "high", "medium", "low"]),
      }),
    ),
    candidate_text_length: z.number(),
    llm_model: z.string(),
    error: z.string().optional(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    const documentId = context.documentId;
    const regulationId = context.regulationId ?? null;
    try {
      const { draft, candidate_text_length, llm_model } =
        await extractClausesForDocument(documentId, regulationId);
      logger?.info("✅ [extractClausesFromStandardTool] generated", {
        documentId,
        regulationId,
        draftCount: draft.length,
      });
      return {
        success: true,
        document_id: documentId,
        regulation_id: regulationId,
        draft,
        candidate_text_length,
        llm_model,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [extractClausesFromStandardTool] failed", { error: msg });
      return {
        success: false,
        document_id: documentId,
        regulation_id: regulationId,
        draft: [],
        candidate_text_length: 0,
        llm_model: EXTRACT_MODEL,
        error: msg,
      };
    }
  },
});
