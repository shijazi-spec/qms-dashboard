/**
 * complianceJudge — Phase 3.2 LLM-based "does this document satisfy
 * this clause?" helper.
 *
 * Used in two places:
 *   1. Inngest function `compliance-judge-link` triggered immediately
 *      after an /apply-mapping POST.
 *   2. Inngest cron `compliance-judge-pending` (daily 02:00 UTC) which
 *      re-judges any link older than 30 days or never-judged.
 *
 * Output is persisted into `obligation_evidence_quality` via
 * upsertEvidenceQuality() so the dashboard always renders the latest
 * verdict.
 *
 * The prompt builder + parser are exported separately so they can be
 * unit-tested without hitting OpenAI.
 */

import { sharedPool as pool } from "./sharedPool";
import { logger } from "./logger";
import {
  upsertEvidenceQuality,
  type EvidenceQualityStatus,
  logLlmCall,
} from "./complianceQualityDatabase";

export const JUDGE_MAX_DOC_CHARS = 8000;
export const JUDGE_MODEL = process.env.COMPLIANCE_JUDGE_MODEL || "gpt-4o-mini";
export const JUDGE_CALLER = "compliance-judge";

export interface JudgeVerdict {
  status: EvidenceQualityStatus;
  rationale: string;
  missing_aspects: string[];
}

interface JudgeInputs {
  obligation: {
    code: string;
    title: string;
    description: string;
    evidence_requirements: string | null;
  };
  document: {
    title: string;
    text: string;
  };
}

/**
 * Pure: build the LLM prompt. Exported for testing.
 */
export function buildJudgePrompt(inp: JudgeInputs): string {
  const o = inp.obligation;
  const d = inp.document;
  const docExcerpt = (d.text || "").slice(0, JUDGE_MAX_DOC_CHARS);
  return [
    `You are a senior GRC auditor performing an evidence-quality review.`,
    `Decide whether the document below satisfies the compliance clause.`,
    ``,
    `## CLAUSE`,
    `Code: ${o.code}`,
    `Title: ${o.title}`,
    `Requirement: ${o.description}`,
    o.evidence_requirements
      ? `Expected evidence: ${o.evidence_requirements}`
      : `Expected evidence: (not specified)`,
    ``,
    `## DOCUMENT`,
    `Title: ${d.title || "Untitled"}`,
    `Excerpt (first ${JUDGE_MAX_DOC_CHARS} chars):`,
    `"""`,
    docExcerpt || "(no extracted text available)",
    `"""`,
    ``,
    `## TASK`,
    `Return ONLY a JSON object with these keys (no prose, no code fences):`,
    `{`,
    `  "status": "satisfied" | "partial" | "missing_topic" | "needs_review",`,
    `  "rationale": "<one short paragraph citing the document evidence>",`,
    `  "missing_aspects": ["<aspect of the clause not covered by the document>", ...]`,
    `}`,
    ``,
    `Decision rules:`,
    `- "satisfied"     — document clearly addresses the entire requirement`,
    `- "partial"       — document addresses some but not all of the requirement`,
    `- "missing_topic" — document is on-topic for the framework but does not address this clause`,
    `- "needs_review"  — document content is unclear or extraction was poor; a human should look`,
  ].join("\n");
}

/**
 * Pure: parse the model response. Exported for testing.
 */
export function parseJudgeResponse(raw: string): JudgeVerdict {
  if (!raw) {
    return { status: "needs_review", rationale: "Empty model response", missing_aspects: [] };
  }
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return {
      status: "needs_review",
      rationale: `Model returned non-JSON: ${raw.slice(0, 200)}`,
      missing_aspects: [],
    };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    return {
      status: "needs_review",
      rationale: `Could not parse model JSON: ${(err as Error).message}`,
      missing_aspects: [],
    };
  }
  const allowed: EvidenceQualityStatus[] = [
    "satisfied",
    "partial",
    "missing_topic",
    "needs_review",
  ];
  const status = allowed.includes(parsed.status) ? parsed.status : "needs_review";
  const rationale = String(parsed.rationale || "").slice(0, 2000);
  let missing: string[] = [];
  if (Array.isArray(parsed.missing_aspects)) {
    missing = parsed.missing_aspects
      .filter((x: any) => typeof x === "string")
      .map((x: string) => x.slice(0, 200))
      .slice(0, 12);
  }
  return { status, rationale, missing_aspects: missing };
}

/**
 * End-to-end: load obligation + document, call the LLM, persist verdict.
 *
 * Returns the persisted row.
 */
export async function judgeEvidence(
  obligationId: number,
  documentId: number,
  judgedBy?: string,
): Promise<JudgeVerdict & { persisted: boolean }> {
  const obRes = await pool.query(
    `SELECT obligation_code, title, description, evidence_requirements
       FROM obligations WHERE id = $1`,
    [obligationId],
  );
  if (obRes.rows.length === 0) {
    throw new Error(`Obligation ${obligationId} not found`);
  }
  const docRes = await pool.query(
    `SELECT title, extracted_text, extraction_status
       FROM qms_uploaded_documents WHERE id = $1`,
    [documentId],
  );
  if (docRes.rows.length === 0) {
    throw new Error(`Document ${documentId} not found`);
  }
  const ob = obRes.rows[0];
  const doc = docRes.rows[0];

  // If no extracted text, write a needs_review verdict immediately and skip LLM.
  if (!doc.extracted_text || doc.extracted_text.length < 50) {
    const verdict: JudgeVerdict = {
      status: "needs_review",
      rationale: `Document text not yet extracted (status: ${doc.extraction_status || "unknown"}). Re-judge once extraction completes.`,
      missing_aspects: [],
    };
    await upsertEvidenceQuality({
      obligation_id: obligationId,
      document_id: documentId,
      status: verdict.status,
      rationale: verdict.rationale,
      missing_aspects: verdict.missing_aspects,
      judged_by: judgedBy ?? "ai-judge-v1",
      llm_model: null,
      tokens_used: null,
    });
    return { ...verdict, persisted: true };
  }

  // Compliance v2 — Pillar 4: contradicting-citation guard.
  // If the document explicitly cites OTHER clauses in the same
  // framework but never the one we're judging, downgrade to
  // missing_topic without spending an LLM call. This catches the
  // common failure mode where similarity-based suggesters propose
  // a clause that the document is actually evidencing for a
  // sibling clause (e.g. a Backup Policy doc that names PCI-DSS
  // 3.2 but not 3.4).
  try {
    const citeRes = await pool.query(
      `SELECT obligation_id, raw_citation FROM document_clause_citations
        WHERE document_id = $1 AND obligation_id IS NOT NULL`,
      [documentId],
    );
    if (citeRes.rows.length >= 2) {
      const cited = citeRes.rows.map((r: any) => Number(r.obligation_id));
      const includesThis = cited.includes(obligationId);
      if (!includesThis) {
        const verdict: JudgeVerdict = {
          status: "missing_topic",
          rationale: `Document cites ${cited.length} other clauses in this framework but does not reference ${ob.obligation_code}. Likely the link is mis-targeted.`,
          missing_aspects: [],
        };
        await upsertEvidenceQuality({
          obligation_id: obligationId,
          document_id: documentId,
          status: verdict.status,
          rationale: verdict.rationale,
          missing_aspects: verdict.missing_aspects,
          judged_by: judgedBy ?? "ai-judge-v1",
          llm_model: null,
          tokens_used: null,
        });
        return { ...verdict, persisted: true };
      }
    }
  } catch {
    /* best-effort guard; fall through to LLM */
  }

  const prompt = buildJudgePrompt({
    obligation: {
      code: ob.obligation_code,
      title: ob.title,
      description: ob.description,
      evidence_requirements: ob.evidence_requirements,
    },
    document: { title: doc.title, text: doc.extracted_text },
  });

  const start = Date.now();
  let verdict: JudgeVerdict;
  let tokensUsed: number | null = null;
  let llmError: string | null = null;
  try {
    const { createOpenAI } = await import("@ai-sdk/openai");
    const { generateText } = await import("ai");
    const openai = createOpenAI({
      baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
      apiKey:
        process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||
        process.env.OPENAI_API_KEY,
    });
    const result = await generateText({
      model: openai(JUDGE_MODEL),
      prompt,
      maxTokens: 600,
    });
    verdict = parseJudgeResponse(result.text);
    const usage: any = (result as any).usage || {};
    tokensUsed =
      Number(usage.totalTokens || usage.total_tokens) ||
      (Number(usage.promptTokens || usage.prompt_tokens) || 0) +
        (Number(usage.completionTokens || usage.completion_tokens) || 0) ||
      null;
  } catch (err) {
    llmError = (err as Error).message;
    logger.warn(
      `[ComplianceJudge] LLM call failed for ob=${obligationId} doc=${documentId}: ${llmError}`,
    );
    verdict = {
      status: "needs_review",
      rationale: `LLM call failed: ${llmError}`,
      missing_aspects: [],
    };
  }

  const elapsed = Date.now() - start;
  await logLlmCall({
    caller: JUDGE_CALLER,
    model: JUDGE_MODEL,
    tokens_used: tokensUsed,
    latency_ms: elapsed,
    success: !llmError,
    error: llmError,
  });

  await upsertEvidenceQuality({
    obligation_id: obligationId,
    document_id: documentId,
    status: verdict.status,
    rationale: verdict.rationale,
    missing_aspects: verdict.missing_aspects,
    judged_by: judgedBy ?? "ai-judge-v1",
    llm_model: JUDGE_MODEL,
    tokens_used: tokensUsed,
  });

  return { ...verdict, persisted: true };
}
