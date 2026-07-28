/**
 * gapRecommendationAdvisor — AI remediation advisor for Document-Mapping gaps.
 *
 * For a compliance clause that has NO linked evidence (a "gap"), generate an
 * actionable recommendation: what the clause requires, what document/control
 * to create, the key criteria to include, a suggested title, and a priority.
 *
 * Two-stage so structured output stays reliable while still being grounded in
 * live web guidance:
 *   1. RESEARCH (best-effort, web-grounded) — ask a web-search-enabled model
 *      (gpt-4o-mini-search-preview) for current best-practice guidance on the
 *      clause; capture its answer + the URLs it cited. If the search model is
 *      unreachable through the configured gateway, this degrades to empty
 *      research and the recommendation falls back to the model's own
 *      framework knowledge — never fails.
 *   2. RECOMMEND (structured JSON) — gpt-4o-mini turns the clause + research
 *      into a strict-JSON recommendation.
 *
 * Recommendations are cached in `obligation_gap_recommendations` so the
 * per-clause button, the bulk report, and the CSV export all share one copy.
 */

import { sharedPool as pool } from "./sharedPool";
import { logger } from "./logger";
import { generateChatText } from "./openaiChatHelper";
import { redactSensitiveDeep } from "./eventLogsDatabase";

export const WEB_SEARCH_MODEL =
  process.env.WEB_SEARCH_MODEL || "gpt-4o-mini-search-preview";
export const RECOMMEND_MODEL =
  process.env.DOCUMENT_MAPPING_RECOMMEND_MODEL || "gpt-4o-mini";

/** Web grounding is on by default; set DOCUMENT_MAPPING_WEB_SEARCH=false to use model knowledge only. */
export function webSearchEnabled(): boolean {
  return process.env.DOCUMENT_MAPPING_WEB_SEARCH !== "false";
}

export interface ClauseRecommendation {
  what_required: string;
  recommended_action: string;
  suggested_document_title: string;
  document_type: string;
  key_criteria: string[];
  priority: "high" | "medium" | "low";
  sources: Array<{ title: string; url: string }>;
  web_grounded: boolean;
}

let initialized = false;
export async function initGapRecommendationsTable(): Promise<void> {
  if (initialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS obligation_gap_recommendations (
      obligation_id  INTEGER PRIMARY KEY REFERENCES obligations(id) ON DELETE CASCADE,
      regulation_id  INTEGER,
      recommendation JSONB NOT NULL,
      web_grounded   BOOLEAN NOT NULL DEFAULT FALSE,
      generated_by   VARCHAR(255),
      generated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  initialized = true;
}

/** Pure: build the web-research prompt for a clause. Exported for tests. */
export function buildResearchPrompt(clause: {
  regulation_code: string;
  obligation_code: string;
  title: string;
  description?: string | null;
}): string {
  return [
    `You are a GRC compliance researcher. Research current best-practice guidance for satisfying this specific compliance requirement, using the web.`,
    ``,
    `Framework: ${clause.regulation_code}`,
    `Clause ${clause.obligation_code}: ${clause.title}`,
    clause.description ? `Detail: ${String(clause.description).slice(0, 600)}` : ``,
    ``,
    `Summarise (a) what the requirement actually demands, and (b) what documents, policies, controls, or records organisations typically implement to satisfy it. Prefer authoritative sources (the standard body, regulators, reputable GRC references). Keep it under 250 words.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Pure: build the structured-recommendation prompt. Exported for tests. */
export function buildRecommendationPrompt(
  clause: {
    regulation_code: string;
    obligation_code: string;
    title: string;
    description?: string | null;
  },
  researchText: string,
): string {
  return [
    `You are a senior GRC consultant advising an organisation on how to CLOSE a compliance gap — a clause that currently has NO supporting document or evidence.`,
    ``,
    `## CLAUSE`,
    `Framework: ${clause.regulation_code}`,
    `Code: ${clause.obligation_code}`,
    `Title: ${clause.title}`,
    clause.description ? `Detail: ${String(clause.description).slice(0, 600)}` : ``,
    ``,
    researchText
      ? `## RESEARCH (current web guidance — use it, but you are the expert)\n${researchText.slice(0, 2500)}`
      : `## RESEARCH\n(none available — rely on your own knowledge of this framework)`,
    ``,
    `## TASK`,
    `Recommend exactly what the organisation should create or implement to satisfy this clause. Return ONLY a JSON object (no prose, no code fences) with these keys:`,
    `- "what_required": 1-2 sentences on what the clause demands.`,
    `- "recommended_action": 1-2 sentences on what to create/implement to satisfy it.`,
    `- "suggested_document_title": a concrete document name, e.g. "Cryptographic Key Management Policy".`,
    `- "document_type": one of "Policy","Procedure","Standard","Control","Record","Plan","Register".`,
    `- "key_criteria": array of 3-6 short strings — the specific elements/clauses the document must contain to satisfy the requirement.`,
    `- "priority": one of "high","medium","low" — based on how foundational/risky the clause is.`,
    ``,
    `Return only the JSON object.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Pure: parse + normalise the model's JSON recommendation. Exported for tests. */
export function parseRecommendation(
  raw: string,
): Omit<ClauseRecommendation, "sources" | "web_grounded"> | null {
  if (!raw) return null;
  let text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  let obj: any;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const prio = String(obj.priority || "").toLowerCase();
  const criteria = Array.isArray(obj.key_criteria)
    ? obj.key_criteria.map((c: any) => String(c)).filter(Boolean).slice(0, 8)
    : [];
  return {
    what_required: String(obj.what_required || "").slice(0, 1000),
    recommended_action: String(obj.recommended_action || "").slice(0, 1000),
    suggested_document_title: String(obj.suggested_document_title || "").slice(0, 300),
    document_type: String(obj.document_type || "Document").slice(0, 50),
    key_criteria: criteria,
    priority: prio === "high" || prio === "low" ? prio : "medium",
  };
}

/** Best-effort web research for a clause. Never throws — returns empty on any failure. */
async function researchClauseWeb(clause: {
  regulation_code: string;
  obligation_code: string;
  title: string;
  description?: string | null;
}): Promise<{ text: string; sources: Array<{ title: string; url: string }> }> {
  if (!webSearchEnabled()) return { text: "", sources: [] };
  try {
    const r = await generateChatText({
      model: WEB_SEARCH_MODEL,
      prompt: buildResearchPrompt(clause),
      maxTokens: 700,
      timeoutMs: 45_000,
    });
    // Web-search-preview models attach cited URLs as message annotations.
    const annotations =
      r.raw?.choices?.[0]?.message?.annotations ?? [];
    const sources: Array<{ title: string; url: string }> = [];
    const seen = new Set<string>();
    for (const a of annotations) {
      const c = a?.url_citation || a;
      const url = c?.url;
      if (url && !seen.has(url)) {
        seen.add(url);
        sources.push({ title: String(c?.title || url).slice(0, 200), url: String(url).slice(0, 500) });
      }
      if (sources.length >= 6) break;
    }
    return { text: r.text || "", sources };
  } catch (err) {
    logger.warn(
      `[gapRecommendationAdvisor] web research failed for ${clause.obligation_code}: ${(err as Error).message}`,
    );
    return { text: "", sources: [] };
  }
}

async function loadClause(obligationId: number): Promise<any | null> {
  const r = await pool.query(
    `SELECT o.id, o.obligation_code, o.title, o.description, o.regulation_id,
            r.regulation_code
       FROM obligations o
       JOIN regulations r ON r.id = o.regulation_id
      WHERE o.id = $1`,
    [obligationId],
  );
  return r.rows[0] || null;
}

/**
 * Generate (or, when cached, return) the remediation recommendation for one
 * clause. `force` regenerates; otherwise a cached recommendation is returned.
 */
export async function recommendForClause(
  obligationId: number,
  opts: { force?: boolean; web?: boolean; generatedBy?: string } = {},
): Promise<(ClauseRecommendation & { obligation_id: number }) | null> {
  await initGapRecommendationsTable();

  if (!opts.force) {
    const cached = await pool.query(
      `SELECT recommendation, web_grounded FROM obligation_gap_recommendations WHERE obligation_id = $1`,
      [obligationId],
    );
    if (cached.rows.length > 0) {
      return { obligation_id: obligationId, ...cached.rows[0].recommendation, web_grounded: cached.rows[0].web_grounded };
    }
  }

  const clause = await loadClause(obligationId);
  if (!clause) return null;

  const useWeb = opts.web ?? webSearchEnabled();
  const research = useWeb
    ? await researchClauseWeb(clause)
    : { text: "", sources: [] };

  let parsed: ReturnType<typeof parseRecommendation> = null;
  try {
    const r = await generateChatText({
      model: RECOMMEND_MODEL,
      prompt: buildRecommendationPrompt(clause, research.text),
      maxTokens: 900,
      responseFormat: "json_object",
      timeoutMs: 45_000,
    });
    parsed = parseRecommendation(r.text);
  } catch (err) {
    logger.warn(
      `[gapRecommendationAdvisor] recommend failed for ${clause.obligation_code}: ${(err as Error).message}`,
    );
  }
  if (!parsed) return null;

  const rec: ClauseRecommendation = {
    ...parsed,
    sources: research.sources,
    web_grounded: research.text.length > 0,
  };

  await pool.query(
    `INSERT INTO obligation_gap_recommendations
       (obligation_id, regulation_id, recommendation, web_grounded, generated_by, generated_at)
     VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
     ON CONFLICT (obligation_id) DO UPDATE
       SET regulation_id = EXCLUDED.regulation_id,
           recommendation = EXCLUDED.recommendation,
           web_grounded = EXCLUDED.web_grounded,
           generated_by = EXCLUDED.generated_by,
           generated_at = CURRENT_TIMESTAMP`,
    [
      obligationId,
      clause.regulation_id,
      JSON.stringify(redactSensitiveDeep(rec, "recommendation")),
      rec.web_grounded,
      redactSensitiveDeep(opts.generatedBy || "ai", "generated_by") as string,
    ],
  );

  return { obligation_id: obligationId, ...rec };
}

/** Count gap clauses (no linked evidence) that don't yet have a recommendation. */
export async function countGapsNeedingRecommendation(): Promise<number> {
  await initGapRecommendationsTable();
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM obligations o
       JOIN regulations r ON r.id = o.regulation_id
      WHERE o.status = 'applicable' AND r.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM obligation_documents od WHERE od.obligation_id = o.id)
        AND NOT EXISTS (SELECT 1 FROM obligation_gap_recommendations gr WHERE gr.obligation_id = o.id)`,
  );
  return r.rows[0]?.n || 0;
}

export interface RecommendBatchResult {
  processed: number;
  generated: number;
  failed: number;
  remaining: number;
}

/**
 * Process the next batch of gap clauses lacking a recommendation. Batched (not
 * all-at-once) so the HTTP request never times out on hundreds of clauses and
 * the UI can show progress + resume; cached results mean each call advances.
 */
export async function recommendNextGapBatch(
  opts: { limit?: number; web?: boolean; concurrency?: number; generatedBy?: string } = {},
): Promise<RecommendBatchResult> {
  await initGapRecommendationsTable();
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 50));
  const ids = await pool.query(
    `SELECT o.id
       FROM obligations o
       JOIN regulations r ON r.id = o.regulation_id
      WHERE o.status = 'applicable' AND r.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM obligation_documents od WHERE od.obligation_id = o.id)
        AND NOT EXISTS (SELECT 1 FROM obligation_gap_recommendations gr WHERE gr.obligation_id = o.id)
      ORDER BY r.regulation_code, o.section_order NULLS LAST, o.clause_sort_key NULLS LAST, o.obligation_code
      LIMIT $1`,
    [limit],
  );
  const queue = ids.rows.map((x: any) => Number(x.id));
  const result: RecommendBatchResult = { processed: 0, generated: 0, failed: 0, remaining: 0 };
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 3, 8));

  async function worker(): Promise<void> {
    for (;;) {
      const id = queue.shift();
      if (id === undefined) return;
      result.processed++;
      try {
        const rec = await recommendForClause(id, { web: opts.web, generatedBy: opts.generatedBy });
        if (rec) result.generated++;
        else result.failed++;
      } catch {
        result.failed++;
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length || 1) }, () => worker()),
  );
  result.remaining = await countGapsNeedingRecommendation();
  return result;
}

/** All cached recommendations joined with clause/framework metadata (newest first). */
export async function listRecommendations(): Promise<any[]> {
  await initGapRecommendationsTable();
  const r = await pool.query(
    `SELECT gr.obligation_id, gr.recommendation, gr.web_grounded, gr.generated_at,
            o.obligation_code, o.title AS obligation_title,
            reg.regulation_code, reg.name AS regulation_name
       FROM obligation_gap_recommendations gr
       JOIN obligations o ON o.id = gr.obligation_id
       JOIN regulations reg ON reg.id = o.regulation_id
      ORDER BY reg.regulation_code, o.section_order NULLS LAST, o.clause_sort_key NULLS LAST, o.obligation_code`,
  );
  return r.rows.map((row: any) => {
    // Keep the list/CSV light — surface only whether a draft exists, not the
    // full document text (fetched per-clause via the draft endpoint).
    const { draft, draft_at, ...rec } = row.recommendation || {};
    return {
      obligation_id: row.obligation_id,
      regulation_code: row.regulation_code,
      regulation_name: row.regulation_name,
      obligation_code: row.obligation_code,
      obligation_title: row.obligation_title,
      web_grounded: row.web_grounded,
      generated_at: row.generated_at,
      has_draft: !!draft,
      ...rec,
    };
  });
}

const DRAFT_MODEL =
  process.env.DOCUMENT_MAPPING_DRAFT_MODEL || RECOMMEND_MODEL;

/** Map a recommendation document_type to a policies.document_type enum value. */
function mapDraftDocType(t: string): string {
  const s = (t || "").toLowerCase();
  if (s.includes("procedure")) return "procedure";
  if (s.includes("policy")) return "policy";
  if (s.includes("control")) return "control";
  if (s.includes("record") || s.includes("form")) return "form";
  if (s.includes("manual")) return "manual";
  if (s.includes("guideline")) return "guideline";
  return "document";
}

/** Pure: build the document-drafting prompt. Exported for tests. */
export function buildDraftPrompt(
  clause: {
    regulation_code: string;
    obligation_code: string;
    title: string;
    description?: string | null;
  },
  rec: { what_required?: string; document_type?: string; suggested_document_title?: string; key_criteria?: string[] },
): string {
  return [
    `You are a GRC documentation specialist drafting a controlled document for [Organisation].`,
    `Draft a COMPLETE, ready-to-review ${rec.document_type || "document"} titled "${rec.suggested_document_title || clause.title}" that fully satisfies the following compliance requirement.`,
    ``,
    `Framework: ${clause.regulation_code}`,
    `Clause ${clause.obligation_code}: ${clause.title}`,
    clause.description ? `Clause detail: ${String(clause.description).slice(0, 500)}` : ``,
    rec.what_required ? `What it requires: ${rec.what_required}` : ``,
    (rec.key_criteria && rec.key_criteria.length)
      ? `Required elements to cover:\n- ${rec.key_criteria.join("\n- ")}`
      : ``,
    ``,
    `Write the full document in Markdown with this structure:`,
    `# <title>`,
    `**Document control:** Version 0.1 (DRAFT) · Owner: [role] · Approver: [role] · Effective: [date] · Next review: [date]`,
    `## 1. Purpose`,
    `## 2. Scope`,
    `## 3. Definitions`,
    `## 4. Policy / Requirements   (the substantive statements that satisfy the clause)`,
    `## 5. Roles & Responsibilities`,
    `## 6. Records & Evidence`,
    `## 7. Review`,
    ``,
    `Be specific and audit-ready, not generic. Map the substantive section explicitly to what the clause demands. Use [Organisation], [role], [date] placeholders where specifics are unknown. Output ONLY the Markdown document — no preamble.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Draft the full missing document for a gap clause. Ensures a recommendation
 * exists first (re-using it for structure), generates the document, and caches
 * it inside the recommendation JSON (`draft`) so it isn't re-generated.
 */
export async function draftDocumentForClause(
  obligationId: number,
  opts: { force?: boolean; generatedBy?: string } = {},
): Promise<{ obligation_id: number; title: string; document_type: string; draft: string } | null> {
  await initGapRecommendationsTable();
  // Make sure a recommendation exists (cached or fresh) to anchor the draft.
  const rec = await recommendForClause(obligationId, { generatedBy: opts.generatedBy });
  if (!rec) return null;

  if (!opts.force) {
    const cached = await pool.query(
      `SELECT recommendation FROM obligation_gap_recommendations WHERE obligation_id = $1`,
      [obligationId],
    );
    const existing = cached.rows[0]?.recommendation;
    if (existing?.draft) {
      return {
        obligation_id: obligationId,
        title: rec.suggested_document_title,
        document_type: rec.document_type,
        draft: existing.draft,
      };
    }
  }

  const clause = await loadClause(obligationId);
  if (!clause) return null;

  let draft = "";
  try {
    const r = await generateChatText({
      model: DRAFT_MODEL,
      prompt: buildDraftPrompt(clause, rec),
      maxTokens: 2800,
      timeoutMs: 60_000,
    });
    draft = (r.text || "").trim();
  } catch (err) {
    logger.warn(
      `[gapRecommendationAdvisor] draft failed for ${clause.obligation_code}: ${(err as Error).message}`,
    );
  }
  if (!draft) return null;

  // Persist the draft inside the cached recommendation JSON.
  const cur = await pool.query(
    `SELECT recommendation FROM obligation_gap_recommendations WHERE obligation_id = $1`,
    [obligationId],
  );
  const recJson = cur.rows[0]?.recommendation || {};
  recJson.draft = draft.slice(0, 60_000);
  await pool.query(
    `UPDATE obligation_gap_recommendations SET recommendation = $2 WHERE obligation_id = $1`,
    [obligationId, JSON.stringify(redactSensitiveDeep(recJson, "recommendation"))],
  );

  return {
    obligation_id: obligationId,
    title: rec.suggested_document_title,
    document_type: rec.document_type,
    draft,
  };
}

/**
 * Save a drafted document into the Integrated QMS register as a DRAFT policy,
 * tagged to the clause's framework so the mapper relates it straight back —
 * closing the gap. Returns the created policy (or throws on duplicate number).
 */
export async function saveDraftAsPolicy(
  obligationId: number,
  generatedBy: string,
): Promise<any> {
  const d = await draftDocumentForClause(obligationId, { generatedBy });
  if (!d) return null;
  const clause = await loadClause(obligationId);
  if (!clause) return null;

  const { createPolicy, initPolicyTables } = await import("./policyDatabase");
  await initPolicyTables();

  const policyNumber = ("DRAFT-" + (clause.obligation_code || String(obligationId)))
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .slice(0, 50);

  const policy = await createPolicy({
    policy_number: policyNumber,
    title: (d.title || `Draft for ${clause.obligation_code}`).slice(0, 500),
    category: "compliance",
    document_type: mapDraftDocType(d.document_type) as any,
    content_text: d.draft,
    description: `AI-drafted to satisfy ${clause.regulation_code} ${clause.obligation_code}.`,
    status: "draft",
    created_by: generatedBy,
    linked_regulation_ids: clause.regulation_id ? [clause.regulation_id] : undefined,
  } as any);

  return policy;
}
