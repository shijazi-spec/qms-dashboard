/**
 * suggestObligationMappingTool — Phase 2.2 of the document compliance
 * mapping feature.
 *
 * Given an uploaded document (qms_uploaded_documents.id), returns a
 * ranked list of obligations the document likely satisfies. Always
 * read-only — never auto-creates the link in obligation_documents (the
 * UI surfaces an Accept button so the human stays in the loop).
 *
 * Logic:
 *   1. Fetch document metadata + extracted_text + regulation_codes[]
 *   2. Fetch every obligation under those regulations (or every active
 *      obligation if no regulation_codes were tagged on the doc)
 *   3. Build an LLM prompt: "Document: X. Clauses: Y. Which clauses
 *      does this document satisfy?"
 *   4. Parse JSON response → top-N suggestions with confidence + rationale
 *
 * The prompt builder + parser are exported separately so they can be
 * unit-tested without hitting LLMProvider.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { sharedPool as pool } from "../../utils/sharedPool";
import { getLLMProviderApiKey, getLLMProviderBaseUrl } from "../../utils/LLMProviderCredentials";

export const SUGGEST_MAX_DOC_CHARS = 4000;
export const SUGGEST_MAX_OBLIGATIONS = 200;

interface ObligationCandidate {
  id: number;
  obligation_code: string;
  title: string;
  description: string;
  regulation_code: string;
}

export interface MappingSuggestion {
  obligation_code: string;
  obligation_id: number;
  confidence: number;
  rationale: string;
}

/**
 * Build the LLM prompt. Pure-function for testability.
 */
export function buildSuggestPrompt(
  doc: { title: string; text: string },
  obligations: ObligationCandidate[],
  topN: number,
): string {
  const docTitle = (doc.title || "Untitled").slice(0, 200);
  const docExcerpt = (doc.text || "").slice(0, SUGGEST_MAX_DOC_CHARS);
  const cluasesList = obligations
    .slice(0, SUGGEST_MAX_OBLIGATIONS)
    .map(
      (o) =>
        `- ${o.obligation_code} (${o.regulation_code}): ${o.title}. ${o.description.slice(0, 220)}`,
    )
    .join("\n");

  return [
    `You are a senior GRC consultant mapping company documents to compliance obligations.`,
    ``,
    `## DOCUMENT`,
    `Title: ${docTitle}`,
    `Excerpt (first ${SUGGEST_MAX_DOC_CHARS} chars):`,
    `"""`,
    docExcerpt || "(no extracted text available)",
    `"""`,
    ``,
    `## CANDIDATE OBLIGATIONS`,
    cluasesList,
    ``,
    `## TASK`,
    `Identify which of the candidate obligations the document SATISFIES (in whole or in part).`,
    `For each match, return:`,
    `- obligation_code (must exactly match one of the candidates above)`,
    `- confidence (0-100 integer; use 80+ only when the document text clearly addresses the clause)`,
    `- rationale (1-2 sentences pointing to the specific evidence in the document)`,
    ``,
    `Return ONLY a JSON array with at most ${topN} entries, sorted by confidence descending. Example:`,
    `[`,
    `  {"obligation_code": "ISO27001-A.5.1", "confidence": 92, "rationale": "Document is the approved Information Security Policy with version, owner and review date."},`,
    `  {"obligation_code": "ISO27001-A.5.2", "confidence": 65, "rationale": "Roles section partly covers this; full RACI not present."}`,
    `]`,
    ``,
    `If the document does not satisfy any candidate, return [].`,
    `Do not include any text outside the JSON array.`,
  ].join("\n");
}

/**
 * Parse the model output. Tolerates code-fences and stray prose around
 * the JSON. Pure-function for testability.
 */
export function parseSuggestResponse(
  raw: string,
  obligations: ObligationCandidate[],
): MappingSuggestion[] {
  if (!raw) return [];
  let text = raw.trim();
  // Strip code fences if the model wrapped them.
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  // Locate first JSON array if model added prose.
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  const jsonSlice = text.slice(start, end + 1);

  let parsed: any;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const byCode = new Map<string, ObligationCandidate>();
  for (const o of obligations) byCode.set(o.obligation_code, o);

  const out: MappingSuggestion[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== "object") continue;
    const code = String(row.obligation_code || "").trim();
    const ob = byCode.get(code);
    if (!ob) continue;
    let confidence = Number(row.confidence);
    if (!Number.isFinite(confidence)) confidence = 50;
    confidence = Math.max(0, Math.min(100, Math.round(confidence)));
    const rationale = String(row.rationale || "").slice(0, 1000);
    out.push({
      obligation_code: code,
      obligation_id: ob.id,
      confidence,
      rationale,
    });
  }
  // Sort defensively in case the model didn't.
  out.sort((a, b) => b.confidence - a.confidence);
  return out;
}

/**
 * Internal: load candidate obligations for the document. If the document
 * has regulation_codes set, restrict to those frameworks; otherwise
 * include every active obligation (capped at SUGGEST_MAX_OBLIGATIONS).
 */
async function loadCandidateObligations(
  documentRegulationCodes: string[] | null | undefined,
): Promise<ObligationCandidate[]> {
  let rows;
  if (documentRegulationCodes && documentRegulationCodes.length > 0) {
    rows = await pool.query(
      `SELECT o.id, o.obligation_code, o.title, o.description, r.regulation_code
         FROM obligations o
         JOIN regulations r ON o.regulation_id = r.id
        WHERE r.regulation_code = ANY($1::text[])
          AND o.status = 'applicable'
        ORDER BY r.regulation_code, o.section_order NULLS LAST, o.clause_sort_key NULLS LAST, o.obligation_code
        LIMIT ${SUGGEST_MAX_OBLIGATIONS}`,
      [documentRegulationCodes],
    );
  } else {
    rows = await pool.query(
      `SELECT o.id, o.obligation_code, o.title, o.description, r.regulation_code
         FROM obligations o
         JOIN regulations r ON o.regulation_id = r.id
        WHERE o.status = 'applicable'
        ORDER BY r.regulation_code, o.section_order NULLS LAST, o.clause_sort_key NULLS LAST, o.obligation_code
        LIMIT ${SUGGEST_MAX_OBLIGATIONS}`,
    );
  }
  return rows.rows as ObligationCandidate[];
}

export const suggestObligationMappingTool = createTool({
  id: "suggest-obligation-mapping",

  description:
    "Suggest which compliance obligations (clauses/controls) a previously uploaded document satisfies. " +
    "Returns ranked suggestions with confidence and rationale. Read-only — does NOT create the mapping (user reviews and accepts).",

  inputSchema: z.object({
    documentId: z
      .number()
      .int()
      .positive()
      .describe("ID of the uploaded document in qms_uploaded_documents."),
    topN: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe("Max suggestions to return (default 5)."),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    document_id: z.number(),
    document_title: z.string(),
    suggestions: z.array(
      z.object({
        obligation_code: z.string(),
        obligation_id: z.number(),
        confidence: z.number(),
        rationale: z.string(),
      }),
    ),
    candidate_count: z.number(),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    const documentId = context.documentId;
    const topN = context.topN ?? 5;
    try {
      const docRes = await pool.query(
        `SELECT id, title, mime_type, regulation_codes, extracted_text, extraction_status
           FROM qms_uploaded_documents
          WHERE id = $1
          LIMIT 1`,
        [documentId],
      );
      if (docRes.rows.length === 0) {
        return {
          success: false,
          document_id: documentId,
          document_title: "",
          suggestions: [],
          candidate_count: 0,
          error: `Document ${documentId} not found`,
        };
      }
      const doc = docRes.rows[0];

      if (!doc.extracted_text || doc.extracted_text.length < 50) {
        return {
          success: false,
          document_id: documentId,
          document_title: doc.title,
          suggestions: [],
          candidate_count: 0,
          error:
            doc.extraction_status === "pending"
              ? "Document text extraction is still pending. Try again in a minute."
              : `Document has no extracted text (status: ${doc.extraction_status || "unknown"}).`,
        };
      }

      const candidates = await loadCandidateObligations(doc.regulation_codes);
      if (candidates.length === 0) {
        return {
          success: true,
          document_id: documentId,
          document_title: doc.title,
          suggestions: [],
          candidate_count: 0,
        };
      }

      // Compliance v2 — Pillar 4 strong-confidence channel: read any
      // citations the regex extractor already resolved for this doc.
      // High-confidence resolved citations short-circuit the LLM call
      // for the obligations they cover (and are stitched in at the
      // top of the suggestion list).
      let citationSuggestions: MappingSuggestion[] = [];
      try {
        const { listCitationsForDocument } = await import(
          "../../utils/clauseCitationExtractor"
        );
        const cites = await listCitationsForDocument(documentId);
        const candByCode = new Map<string, ObligationCandidate>();
        for (const c of candidates) candByCode.set(c.obligation_code, c);
        const seenObCode = new Set<string>();
        for (const cit of cites) {
          if (!cit.obligation_code || cit.confidence < 70) continue;
          if (seenObCode.has(cit.obligation_code)) continue;
          const ob = candByCode.get(cit.obligation_code);
          if (!ob) continue;
          seenObCode.add(cit.obligation_code);
          citationSuggestions.push({
            obligation_code: ob.obligation_code,
            obligation_id: ob.id,
            confidence: Math.max(85, Number(cit.confidence) || 85),
            rationale: `Document explicitly cites this clause ("${cit.raw_citation}"). Excerpt: ${(cit.source_excerpt || "").slice(0, 200)}`,
          });
        }
      } catch (citErr) {
        // best-effort; the existing LLM channel still runs
      }

      const prompt = buildSuggestPrompt(
        { title: doc.title, text: doc.extracted_text },
        candidates,
        topN,
      );

      const { createLLMProvider } = await import("@ai-sdk/LLMProvider");
      const { generateText } = await import("ai");
      const LLMProvider = createLLMProvider({
        baseURL: getLLMProviderBaseUrl(),
        apiKey: getLLMProviderApiKey(),
      });

      // Raw-fetch /chat/completions — `.chat()` adapter emits v3 spec
      // under @ai-sdk/LLMProvider 3.x, incompatible with ai@5 (needs v2).
      const { generateChatText } = await import("../../utils/LLMProviderChatHelper");
      const result = await generateChatText({
        model: "gpt-4o-mini",
        prompt,
        maxTokens: 1500,
      });

      const llmSuggestions = parseSuggestResponse(result.text, candidates);
      // Merge: citation hits at the top, LLM hits underneath, de-dupe by code.
      const seen = new Set<string>();
      const suggestions: MappingSuggestion[] = [];
      for (const s of [...citationSuggestions, ...llmSuggestions]) {
        if (seen.has(s.obligation_code)) continue;
        seen.add(s.obligation_code);
        suggestions.push(s);
        if (suggestions.length >= topN) break;
      }

      logger?.info("✅ [suggestObligationMappingTool] generated", {
        documentId,
        candidateCount: candidates.length,
        suggestionCount: suggestions.length,
      });

      return {
        success: true,
        document_id: documentId,
        document_title: doc.title,
        suggestions,
        candidate_count: candidates.length,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [suggestObligationMappingTool] failed", { error: msg });
      return {
        success: false,
        document_id: documentId,
        document_title: "",
        suggestions: [],
        candidate_count: 0,
        error: msg,
      };
    }
  },
});
