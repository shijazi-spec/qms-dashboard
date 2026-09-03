/**
 * policyMappingBridge — connects the Integrated QMS document register
 * (`policies` table) to the Compliance Document-Mapping engine.
 *
 * Why a bridge?
 *   The clause-citation auto-mapper (`runCitationExtraction`) and the whole
 *   Document-Mapping UI/coverage are keyed off `qms_uploaded_documents`
 *   (`obligation_documents.document_id` is a hard FK to it). Integrated QMS
 *   documents live in a different table (`policies`). Rather than fork the
 *   engine + every UI query + the coverage SQL to understand two document
 *   sources, we PROJECT each Integrated QMS document into a single
 *   `qms_uploaded_documents` row (keyed by `source_policy_id`) carrying its
 *   text, then run the existing engine unchanged. From the operator's point
 *   of view their Integrated QMS documents get mapped; the projection row is
 *   an internal implementation detail.
 *
 * Text source priority for a policy: content_text → attached file's
 * extracted text → description. No text ⇒ projection is still written
 * (status 'empty') but no citations are produced.
 *
 * Triggers: policy create/update/file-upload call `syncPolicyToMapping`;
 * policy delete calls `removePolicyMapping`; the Document-Mapping
 * "Run mapping now" button calls `backfillPolicyMappings`.
 */

import { createHash } from "crypto";
import { sharedPool as pool } from "./sharedPool";
import { logger } from "./logger";
import { redactSensitiveDeep } from "./eventLogsDatabase";
import { initQmsDocsTable } from "./qmsDocsDatabase";
import { extractDocumentText } from "./documentTextExtractor";
import {
  runCitationExtraction,
  AUTO_MAP_CONFIDENCE_THRESHOLD,
} from "./clauseCitationExtractor";

// Cap projection text the same way qms_uploaded_documents.extracted_text is
// capped at write time (see setDocumentExtractionResult).
export const MAX_PROJECTION_TEXT = 50_000;

let bridgeReady = false;

/**
 * Idempotently ensure the projection column + uniqueness guarantee exist.
 * `source_policy_id` is nullable (regular GRC uploads leave it NULL) with a
 * partial unique index so each Integrated QMS document maps to at most one
 * projection row.
 */
export async function initPolicyMappingBridge(): Promise<void> {
  if (bridgeReady) return;
  await initQmsDocsTable();
  await pool.query(
    `ALTER TABLE qms_uploaded_documents ADD COLUMN IF NOT EXISTS source_policy_id INTEGER`,
  );
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_qms_uploaded_documents_source_policy
       ON qms_uploaded_documents (source_policy_id)
     WHERE source_policy_id IS NOT NULL`,
  );
  // Tracks which (document, framework) pairs the "Map all frameworks" pass
  // has already considered, so the batched run terminates and never re-spends
  // tokens on a doc×framework it already scanned (even if no match was found).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS document_framework_scans (
      document_id   INTEGER NOT NULL REFERENCES qms_uploaded_documents(id) ON DELETE CASCADE,
      regulation_id INTEGER NOT NULL REFERENCES regulations(id) ON DELETE CASCADE,
      scanned_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (document_id, regulation_id)
    )
  `);
  bridgeReady = true;
}

/**
 * Pure text-source selector. Given a policy's content_text, the already
 * (impurely) extracted file text, and the description, choose the projection
 * text in priority order: content_text → file → description → none. Truncates
 * to MAX_PROJECTION_TEXT. Exported for unit testing — no DB/file access.
 */
export function chooseProjectionText(opts: {
  content_text?: string | null;
  fileText?: string | null;
  description?: string | null;
}): {
  text: string;
  status: "extracted" | "empty";
  source: "content_text" | "file" | "description" | "none";
} {
  const content = (opts.content_text || "").trim();
  if (content.length > 0)
    return { text: content.slice(0, MAX_PROJECTION_TEXT), status: "extracted", source: "content_text" };

  const file = (opts.fileText || "").trim();
  if (file.length > 0)
    return { text: file.slice(0, MAX_PROJECTION_TEXT), status: "extracted", source: "file" };

  const desc = (opts.description || "").trim();
  if (desc.length > 0)
    return { text: desc.slice(0, MAX_PROJECTION_TEXT), status: "extracted", source: "description" };

  return { text: "", status: "empty", source: "none" };
}

/**
 * Resolve the text we will hand to the citation engine for one policy.
 * content_text wins; otherwise extract the attached file; otherwise fall
 * back to the description. Never throws — extraction failures degrade to the
 * next source. The selection itself is delegated to the pure
 * `chooseProjectionText` so it can be unit-tested without DB/file access.
 */
async function resolvePolicyText(policy: any): Promise<{
  text: string;
  status: "extracted" | "empty" | "placeholder";
}> {
  let fileText: string | null = null;
  // Only pay for file extraction when there is no content_text to use.
  if (!(policy.content_text || "").trim() && policy.file_path) {
    try {
      const res = await extractDocumentText(
        policy.file_path,
        policy.file_mime_type || null,
      );
      if (res.status === "extracted") fileText = res.text;
    } catch (err) {
      logger.warn(
        `[policyMappingBridge] file extraction failed for policy=${policy.id}: ${(err as Error).message}`,
      );
    }
  }

  const chosen = chooseProjectionText({
    content_text: policy.content_text,
    fileText,
    description: policy.description,
  });

  // A register entry whose only text is its own one-line description, with no
  // file attached, is NOT document content — it is metadata about a document
  // that has not been uploaded yet. The 154 seeded WP-* controlled documents
  // are all in this state ("Controlled document (WP-…) — pending file upload").
  //
  // Treating those as mappable text is what made "Suggest Documents" return the
  // same 154 rows, all scoring 0, for every clause in every framework. Mark
  // them 'placeholder' so the suggester and the auto-mapper skip them. As soon
  // as the approved file is attached the projection re-runs and flips to
  // 'extracted' on its own.
  if (chosen.source === "description" && !policy.file_path) {
    return { text: chosen.text, status: "placeholder" };
  }
  return { text: chosen.text, status: chosen.status };
}

/** Resolve regulation_codes for the projection from the policy's linked regulation ids. */
async function regulationCodesForPolicy(
  linkedRegulationIds: number[] | null | undefined,
): Promise<string[] | null> {
  if (!Array.isArray(linkedRegulationIds) || linkedRegulationIds.length === 0)
    return null;
  try {
    const r = await pool.query(
      `SELECT regulation_code FROM regulations WHERE id = ANY($1::int[])`,
      [linkedRegulationIds],
    );
    const codes = r.rows
      .map((row: any) => row.regulation_code)
      .filter(Boolean);
    return codes.length > 0 ? codes : null;
  } catch {
    return null;
  }
}

export const SEMANTIC_MAX_OBLIGATIONS = 200;
export const SEMANTIC_TOP_N = 8;

/**
 * Confidence bar for the LLM semantic auto-mapper.
 *
 * AUDIT-GRADE DEFAULT (benchmark rec #1, 2026-06-17): precision-first at 70.
 * Below the citation bar (80) but high enough that a confirmed link is
 * defensible — pure low-confidence "map everything" is the documented
 * anti-pattern for audit readiness. For an aggressive DISCOVERY/pilot sweep,
 * lower it via DOCUMENT_MAPPING_SEMANTIC_THRESHOLD (e.g. 40) and turn on
 * best-effort (DOCUMENT_MAPPING_BEST_EFFORT=true). See [[document-mapping-benchmark]].
 */
export const SEMANTIC_AUTO_MAP_THRESHOLD =
  Number(process.env.DOCUMENT_MAPPING_SEMANTIC_THRESHOLD) || 70;

/**
 * Best-effort = "link the single best match even if it didn't clear the bar".
 * OFF by default now (precision-first): we do NOT manufacture a weak link just
 * to avoid a 0 — an unmatched document is a finding, not a failure. Turn on
 * with DOCUMENT_MAPPING_BEST_EFFORT=true for a discovery sweep.
 */
export function bestEffortEnabled(): boolean {
  return process.env.DOCUMENT_MAPPING_BEST_EFFORT === "true";
}

/** LLM semantic fallback is on by default; set DOCUMENT_MAPPING_LLM_FALLBACK=false to disable platform-wide (cost kill-switch). */
export function semanticFallbackEnabled(): boolean {
  return process.env.DOCUMENT_MAPPING_LLM_FALLBACK !== "false";
}

/**
 * LLM semantic fallback. The citation extractor only maps documents that
 * literally cite a clause ("ISO 27001 A.5.15"); most controlled documents
 * don't. This pass asks an LLM which obligations the document SATISFIES and
 * writes high-confidence matches as `awaiting_review` links (HITL preserved),
 * reusing the read-only suggest tool's prompt/parse + the same confidence
 * bar as citation auto-mapping. A display row is written to
 * document_clause_citations so the review queue shows the LLM rationale.
 *
 * Cost: one gpt-4o-mini call per document. Caller gates this to run only
 * when citation mapping produced nothing, so documents that DO cite clauses
 * never incur the token spend.
 */
export async function runSemanticAutoMap(
  documentId: number,
  opts: {
    confidenceThreshold?: number;
    topN?: number;
    regulationCode?: string;
    bestEffort?: boolean;
  } = {},
): Promise<{ suggested: number; auto_mapped: number; reason?: string }> {
  const threshold = opts.confidenceThreshold ?? SEMANTIC_AUTO_MAP_THRESHOLD;
  const topN = opts.topN ?? SEMANTIC_TOP_N;
  try {
    const docRes = await pool.query(
      `SELECT title, extracted_text, regulation_codes
         FROM qms_uploaded_documents WHERE id = $1`,
      [documentId],
    );
    if (docRes.rows.length === 0)
      return { suggested: 0, auto_mapped: 0, reason: "doc not found" };
    const doc = docRes.rows[0];
    const text = String(doc.extracted_text || "");
    if (text.trim().length < 50)
      return { suggested: 0, auto_mapped: 0, reason: "insufficient text" };

    // Candidate obligations: when a specific framework is requested (the
    // per-framework "Map this framework" action) scope strictly to it,
    // regardless of the document's own tags — that is the whole point of a
    // framework-targeted run. Otherwise scope to the doc's frameworks when
    // tagged, else every applicable obligation (capped). Includes
    // regulation_id for the display-citation row.
    const regCodes: string[] | null = opts.regulationCode
      ? [opts.regulationCode]
      : Array.isArray(doc.regulation_codes) && doc.regulation_codes.length > 0
        ? doc.regulation_codes
        : null;
    const candSql = `SELECT o.id, o.obligation_code, o.title, o.description,
                            o.regulation_id, r.regulation_code
                       FROM obligations o
                       JOIN regulations r ON o.regulation_id = r.id
                      WHERE o.status = 'applicable'${regCodes ? " AND r.regulation_code = ANY($1::text[])" : ""}
                      ORDER BY r.regulation_code, o.section_order NULLS LAST, o.clause_sort_key NULLS LAST, o.obligation_code
                      LIMIT ${SEMANTIC_MAX_OBLIGATIONS}`;
    const candRes = regCodes
      ? await pool.query(candSql, [regCodes])
      : await pool.query(candSql);
    let candidates = candRes.rows;
    if (candidates.length === 0)
      return { suggested: 0, auto_mapped: 0, reason: "no candidate obligations" };

    // Retrieve-then-verify (rec #3): when embeddings are enabled, shortlist the
    // most semantically similar clauses so the LLM verifier sees a focused list
    // instead of the full candidate set. Best-effort — no-op/passthrough when
    // embeddings are off or unavailable.
    try {
      const { shortlistByEmbedding } = await import("./clauseEmbeddings");
      candidates = await shortlistByEmbedding(text, candidates);
    } catch {
      /* passthrough — keep full candidate list */
    }

    // Reuse the read-only suggest tool's pure prompt/parse helpers (dynamic
    // import avoids a static util→tool cycle at module load).
    const { buildSuggestPrompt, parseSuggestResponse } = await import(
      "../mastra/tools/suggestObligationMappingTool"
    );
    const prompt = buildSuggestPrompt(
      { title: doc.title, text },
      candidates as any,
      topN,
    );

    let resultText = "";
    try {
      const { generateChatText } = await import("./LLMProviderChatHelper");
      const r = await generateChatText({
        model: "gpt-4o-mini",
        prompt,
        maxTokens: <REDACTED_SECRET>
      });
      resultText = r.text || "";
    } catch (err) {
      logger.warn(
        `[policyMappingBridge] semantic LLM call failed for doc=${documentId}: ${(err as Error).message}`,
      );
      return { suggested: 0, auto_mapped: 0, reason: "llm error" };
    }

    const suggestions = parseSuggestResponse(resultText, candidates as any);
    const byId = new Map<number, any>();
    for (const c of candidates) byId.set(c.id, c);

    // Write one suggestion as an awaiting-review link (+ a display citation
    // row carrying the LLM rationale). Returns true if a NEW link was created.
    const linkOne = async (s: any): Promise<boolean> => {
      const ob = byId.get(s.obligation_id);
      if (!ob) return false;
      try {
        await pool.query(
          `INSERT INTO document_clause_citations
             (document_id, regulation_id, obligation_id, raw_citation, source_excerpt, confidence, method)
           VALUES ($1, $2, $3, $4, $5, $6, 'llm')
           ON CONFLICT (document_id, raw_citation) DO UPDATE
             SET source_excerpt = EXCLUDED.source_excerpt,
                 confidence    = EXCLUDED.confidence,
                 method        = EXCLUDED.method`,
          [
            documentId,
            ob.regulation_id ?? null,
            s.obligation_id,
            redactSensitiveDeep(`LLM:${ob.obligation_code}`.slice(0, 200), "raw_citation") as string,
            redactSensitiveDeep((s.rationale || "").slice(0, 1000), "source_excerpt") as string,
            s.confidence,
          ],
        );
        const ins = await pool.query(
          `INSERT INTO obligation_documents
             (obligation_id, document_id, linked_by, link_method, awaiting_review)
           VALUES ($1, $2, 'ai-semantic', 'llm_semantic', TRUE)
           ON CONFLICT (obligation_id, document_id) DO NOTHING
           RETURNING id`,
          [s.obligation_id, documentId],
        );
        return !!(ins.rowCount && ins.rowCount > 0);
      } catch (err) {
        logger.warn(
          `[policyMappingBridge] semantic auto-map write failed doc=${documentId} ob=${s.obligation_id}: ${(err as Error).message}`,
        );
        return false;
      }
    };

    let auto_mapped = 0;
    for (const s of suggestions) {
      if (s.confidence < threshold) continue;
      if (await linkOne(s)) auto_mapped++;
    }
    // Best-effort (discovery only): if nothing cleared the bar, link the single
    // best candidate anyway. OFF by default now — precision-first means an
    // unmatched document is left as a gap, not given a manufactured weak link.
    if (auto_mapped === 0 && (opts.bestEffort ?? bestEffortEnabled()) && suggestions.length > 0) {
      if (await linkOne(suggestions[0])) auto_mapped++;
    }
    return { suggested: suggestions.length, auto_mapped };
  } catch (err) {
    logger.warn(
      `[policyMappingBridge] semantic auto-map failed for doc=${documentId}: ${(err as Error).message}`,
    );
    return { suggested: 0, auto_mapped: 0, reason: "error" };
  }
}

export interface PolicySyncResult {
  policy_id: number;
  projected_document_id: number | null;
  status: "mapped" | "empty" | "skipped" | "unchanged";
  stored?: number;
  auto_mapped?: number;
  semantic_mapped?: number;
  raw_count?: number;
  reason?: string;
}

/**
 * Bump this whenever the mapping POLICY changes (thresholds, best-effort,
 * candidate scope) so the incremental fingerprint check invalidates and the
 * next "Run mapping now" re-maps every document under the new rules. v2 =
 * lowered semantic threshold + best-effort "map everything" (2026-06-17).
 */
export const MAPPING_FINGERPRINT_VERSION = "v3";

/** Stable fingerprint of the inputs that affect a document's mapping. Exported for unit testing. */
export function mappingFingerprint(text: string, regCodes: string[] | null): string {
  return createHash("sha256")
    .update(MAPPING_FINGERPRINT_VERSION)
    .update("|")
    .update(text)
    .update(" ")
    .update((regCodes || []).slice().sort().join(","))
    .digest("hex");
}

/**
 * Project one Integrated QMS document into the mapping source and run the
 * citation auto-mapper over it. Idempotent: re-running updates the existing
 * projection in place (keyed by source_policy_id) so links are refreshed,
 * not duplicated.
 */
/**
 * Map a policy `document_type` to a Documents Library (`qms_uploaded_documents`)
 * category bucket so the /qms-docs category cards mirror the real type. Any
 * unrecognised type (incl. the plain 'policy') buckets under 'policies'.
 * Exported so the Documents Library upload path can pick a document_type that
 * round-trips to the bucket the user chose.
 */
export function qmsCategoryForDocType(docType: string | null | undefined): string {
  switch (String(docType || "").toLowerCase()) {
    case "control":
      return "security_controls";
    case "sop":
      return "sops";
    case "form":
      return "forms";
    case "document":
      return "documents";
    default:
      return "policies";
  }
}

export async function syncPolicyToMapping(
  policyId: number,
  opts: { semantic?: boolean; force?: boolean } = {},
): Promise<PolicySyncResult> {
  await initPolicyMappingBridge();

  const polRes = await pool.query(
    `SELECT id, policy_number, title, description, category, content_text,
            document_type, file_path, file_name, file_size, file_mime_type,
            created_by, owner_name, linked_regulation_ids
       FROM policies
      WHERE id = $1`,
    [policyId],
  );
  if (polRes.rows.length === 0) {
    return { policy_id: policyId, projected_document_id: null, status: "skipped", reason: "policy not found" };
  }
  const policy = polRes.rows[0];

  const { text, status } = await resolvePolicyText(policy);
  const regCodes = await regulationCodesForPolicy(policy.linked_regulation_ids);
  const fingerprint = mappingFingerprint(text, regCodes);

  // Bucket the projected row into the matching Documents Library category so
  // the /qms-docs category cards reflect the real document type (Forms, SOPs,
  // Controls, …) instead of lumping everything under 'policies'. Falls back to
  // 'policies' for the plain 'policy' type or anything unrecognised. Both the
  // Integrated QMS register and Documents Library uploads flow through here.
  const projCategory = qmsCategoryForDocType(policy.document_type);
  // Projection row column values. file_* columns are NOT NULL, so synthesise
  // placeholders for content-only policies.
  const projTitle = String(policy.title || policy.policy_number || `Policy ${policyId}`).slice(0, 512);
  const projFilePath = String(policy.file_path || `<REDACTED_URL>`).slice(0, 1024);
  const projFileName = String(policy.file_name || policy.policy_number || `policy-${policyId}`).slice(0, 512);
  const projFileSize = Number(policy.file_size) || 0;
  const projMime = String(policy.file_mime_type || "text/plain").slice(0, 128);
  const projUploadedBy = String(policy.created_by || policy.owner_name || "integrated-qms").slice(0, 255);

  // SECURITY: scrub credential-shaped substrings (and deny-list keyed values)
  // from every caller/document-derived string before it reaches the projection
  // INSERT/UPDATE params. Policy title/file metadata/uploaded_by and the
  // projected document text are all operator-supplied content that could embed
  // a leaked token — redactSensitiveDeep leaves ordinary prose untouched.
  const safeProjTitle = redactSensitiveDeep(projTitle, "title") as string;
  const safeProjFilePath = redactSensitiveDeep(projFilePath, "file_path") as string;
  const safeProjFileName = redactSensitiveDeep(projFileName, "file_name") as string;
  const safeProjUploadedBy = redactSensitiveDeep(projUploadedBy, "uploaded_by") as string;
  const safeText = text ? (redactSensitiveDeep(text, "extracted_text") as string) : text;

  // Upsert by source_policy_id (explicit select→update/insert to avoid the
  // ON CONFLICT-with-partial-index inference gotcha).
  const existing = await pool.query(
    `SELECT id, extracted_hash FROM qms_uploaded_documents WHERE source_policy_id = $1`,
    [policyId],
  );

  // Incremental skip: if the document's mapping inputs (text + framework
  // tags) are byte-for-byte unchanged since the last run, the citation +
  // LLM passes would reproduce the same links — skip them entirely. This is
  // what makes repeated "Run mapping now" near-instant and stops re-running
  // (and re-paying for) the LLM on documents that haven't changed.
  if (
    existing.rows.length > 0 &&
    !opts.force &&
    existing.rows[0].extracted_hash === fingerprint
  ) {
    return {
      policy_id: policyId,
      projected_document_id: existing.rows[0].id,
      status: "unchanged",
      reason: "inputs unchanged since last mapping",
    };
  }

  let projectedId: number;
  if (existing.rows.length > 0) {
    projectedId = existing.rows[0].id;
    await pool.query(
      `UPDATE qms_uploaded_documents
          SET category = $12, title = $2, file_path = $3, file_name = $4,
              file_size = $5, mime_type = $6, regulation_codes = $7,
              extracted_text = $8, extraction_status = $9,
              extracted_at = CURRENT_TIMESTAMP, uploaded_by = $10,
              extracted_hash = $11
        WHERE id = $1`,
      [projectedId, safeProjTitle, safeProjFilePath, safeProjFileName, projFileSize, projMime, regCodes, safeText || null, status, safeProjUploadedBy, fingerprint, projCategory],
    );
  } else {
    const ins = await pool.query(
      `INSERT INTO qms_uploaded_documents
         (category, title, file_path, file_name, file_size, mime_type,
          regulation_codes, uploaded_by, source_policy_id,
          extracted_text, extraction_status, extracted_at, extracted_hash)
       VALUES ($12, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP, $11)
       RETURNING id`,
      [safeProjTitle, safeProjFilePath, safeProjFileName, projFileSize, projMime, regCodes, safeProjUploadedBy, policyId, safeText || null, status, fingerprint, projCategory],
    );
    projectedId = ins.rows[0].id;
  }

  if (status === "empty" || !text) {
    return { policy_id: policyId, projected_document_id: projectedId, status: "empty", reason: "no mappable text" };
  }

  // Placeholder = the document has not been uploaded yet, so there is nothing
  // to map. Stop before the citation pass and before any LLM spend; mapping
  // against the register's own blurb produces noise, not evidence.
  if (status === "placeholder") {
    return {
      policy_id: policyId,
      projected_document_id: projectedId,
      status: "empty",
      reason: "awaiting file upload — no document content to map",
    };
  }

  const { stored, auto_mapped, raw_count } = await runCitationExtraction(projectedId);

  // Semantic fallback: only when citation mapping produced no links (so
  // documents that explicitly cite clauses never incur LLM cost) and the
  // fallback is enabled.
  let semantic_mapped = 0;
  const wantSemantic = (opts.semantic ?? true) && semanticFallbackEnabled();
  if (wantSemantic && auto_mapped === 0) {
    const sem = await runSemanticAutoMap(projectedId);
    semantic_mapped = sem.auto_mapped;
  }

  return {
    policy_id: policyId,
    projected_document_id: projectedId,
    status: "mapped",
    stored,
    auto_mapped: auto_mapped + semantic_mapped,
    semantic_mapped,
    raw_count,
  };
}

/**
 * Remove a policy's projection. The FK from obligation_documents +
 * document_clause_citations is ON DELETE CASCADE, so removing the projection
 * row also removes any auto-mapped links it produced.
 */
export async function removePolicyMapping(policyId: number): Promise<void> {
  await initPolicyMappingBridge();
  await pool.query(
    `DELETE FROM qms_uploaded_documents WHERE source_policy_id = $1`,
    [policyId],
  );
}

export interface BackfillResult {
  processed: number;
  mapped: number;
  unchanged: number;
  empty: number;
  skipped: number;
  links_created: number;
  semantic_links: number;
}

/** Default backfill parallelism — bounded so we never exhaust the DB pool or hammer the LLM. */
export const BACKFILL_CONCURRENCY = 4;

/**
 * Backfill: project + map every Integrated QMS document. Used by the
 * Document-Mapping "Run mapping now" button.
 *
 * Efficient by construction:
 *   - incremental — `syncPolicyToMapping` skips documents whose mapping
 *     inputs are unchanged (see the fingerprint check), so a second run only
 *     touches new/edited documents and pays for no redundant LLM calls;
 *   - bounded-concurrent — documents are processed in parallel up to
 *     BACKFILL_CONCURRENCY to cut wall-clock without overwhelming the pool.
 *
 * Best-effort per document — one bad document never aborts the run. Pass
 * `force` to re-map everything regardless of the unchanged check.
 */
export async function backfillPolicyMappings(
  opts: { force?: boolean; concurrency?: number } = {},
): Promise<BackfillResult> {
  await initPolicyMappingBridge();
  const ids = await pool.query(`SELECT id FROM policies ORDER BY id ASC`);
  const result: BackfillResult = {
    processed: 0,
    mapped: 0,
    unchanged: 0,
    empty: 0,
    skipped: 0,
    links_created: 0,
    semantic_links: 0,
  };

  const queue = ids.rows.map((r: any) => Number(r.id));
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? BACKFILL_CONCURRENCY, 16));

  // Simple worker pool: `concurrency` workers pull ids off the shared queue.
  async function worker(): Promise<void> {
    for (;;) {
      const id = queue.shift();
      if (id === undefined) return;
      result.processed++;
      try {
        const r = await syncPolicyToMapping(id, { force: opts.force });
        if (r.status === "mapped") {
          result.mapped++;
          result.links_created += r.auto_mapped || 0;
          result.semantic_links += r.semantic_mapped || 0;
        } else if (r.status === "unchanged") {
          result.unchanged++;
        } else if (r.status === "empty") {
          result.empty++;
        } else {
          result.skipped++;
        }
      } catch (err) {
        result.skipped++;
        logger.warn(
          `[policyMappingBridge] backfill failed for policy=${id}: ${(err as Error).message}`,
        );
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length || 1) }, () => worker()),
  );

  logger.info(
    `[policyMappingBridge] backfill complete: ${JSON.stringify(result)}`,
  );
  return result;
}

export interface FrameworkMapResult {
  regulation_code: string;
  candidate_documents: number;
  scanned: number;
  links_created: number;
}

/**
 * Projected documents worth scanning for a framework: those with mappable
 * text that are NOT already linked to ANY clause of that framework. Skipping
 * already-covered documents is what keeps the per-framework AI scan cheap —
 * it only spends tokens where a new match could plausibly exist.
 */
async function frameworkCandidateDocIds(
  regulationCode: string,
): Promise<number[]> {
  const r = await pool.query(
    `SELECT d.id
       FROM qms_uploaded_documents d
      WHERE d.source_policy_id IS NOT NULL
        AND d.extraction_status = 'extracted'
        AND COALESCE(length(d.extracted_text), 0) >= 50
        AND NOT EXISTS (
          SELECT 1
            FROM obligation_documents od
            JOIN obligations o ON o.id = od.obligation_id
            JOIN regulations r ON r.id = o.regulation_id
           WHERE od.document_id = d.id AND r.regulation_code = $1
        )
      ORDER BY d.id ASC`,
    [regulationCode],
  );
  return r.rows.map((x: any) => Number(x.id));
}

/** Pre-flight count for the confirmation dialog — how many documents the scan would cover. */
export async function estimateFrameworkMapping(
  regulationCode: string,
): Promise<{ regulation_code: string; candidate_documents: number }> {
  await initPolicyMappingBridge();
  const ids = await frameworkCandidateDocIds(regulationCode);
  return { regulation_code: regulationCode, candidate_documents: ids.length };
}

/**
 * "Map this framework": run the LLM semantic mapper over every projected
 * document not yet linked to the given framework, with candidates scoped
 * strictly to that framework's clauses. Bounded-concurrent; best-effort per
 * document. This is the targeted way to close one framework's gaps when the
 * default per-document pass didn't consider it (e.g. untagged documents).
 */
export async function mapFrameworkPolicies(
  regulationCode: string,
  opts: { concurrency?: number } = {},
): Promise<FrameworkMapResult> {
  await initPolicyMappingBridge();
  const queue = await frameworkCandidateDocIds(regulationCode);
  const result: FrameworkMapResult = {
    regulation_code: regulationCode,
    candidate_documents: queue.length,
    scanned: 0,
    links_created: 0,
  };
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? BACKFILL_CONCURRENCY, 16));

  async function worker(): Promise<void> {
    for (;;) {
      const id = queue.shift();
      if (id === undefined) return;
      result.scanned++;
      try {
        const r = await runSemanticAutoMap(id, { regulationCode });
        result.links_created += r.auto_mapped || 0;
      } catch (err) {
        logger.warn(
          `[policyMappingBridge] framework map failed doc=${id} fw=${regulationCode}: ${(err as Error).message}`,
        );
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length || 1) }, () => worker()),
  );
  logger.info(
    `[policyMappingBridge] framework map complete: ${JSON.stringify(result)}`,
  );
  return result;
}

export interface MapAllBatchResult {
  processed: number;
  links_created: number;
  remaining: number;
}

// (document, framework) pairs still worth scanning: a projected doc with text,
// an active framework, NOT already linked to that framework, and NOT already
// scanned. Excluding scanned pairs is what makes the batched loop terminate.
const MAP_ALL_CANDIDATE_SQL = `
  FROM qms_uploaded_documents d
  CROSS JOIN regulations reg
 WHERE d.source_policy_id IS NOT NULL
   AND d.extraction_status = 'extracted'
   AND COALESCE(length(d.extracted_text), 0) >= 50
   AND reg.status = 'active'
   AND NOT EXISTS (
     SELECT 1 FROM document_framework_scans s
      WHERE s.document_id = d.id AND s.regulation_id = reg.id
   )
   AND NOT EXISTS (
     SELECT 1 FROM obligation_documents od
       JOIN obligations o ON o.id = od.obligation_id
      WHERE od.document_id = d.id AND o.regulation_id = reg.id
   )`;

/** Outstanding (document × framework) pairs the "Map all frameworks" pass would scan. */
export async function countMapAllRemaining(): Promise<number> {
  await initPolicyMappingBridge();
  const r = await pool.query(`SELECT COUNT(*)::int AS n ${MAP_ALL_CANDIDATE_SQL}`);
  return r.rows[0]?.n || 0;
}

/**
 * "Map all frameworks": the comprehensive pass that compares every projected
 * document against EVERY framework's clauses (scoped per framework so late-
 * alphabet frameworks like PDPL/PCI/SAMA are no longer skipped by the capped
 * single-list default). Batched (a chunk of doc×framework pairs per call) so
 * the request never times out; the UI loops until remaining === 0. Each pair
 * is marked scanned afterwards so re-runs are cheap and the loop terminates.
 */
export async function mapAllNextBatch(
  opts: { limit?: number; concurrency?: number } = {},
): Promise<MapAllBatchResult> {
  await initPolicyMappingBridge();
  const limit = Math.max(1, Math.min(opts.limit ?? 12, 50));
  const rows = await pool.query(
    `SELECT d.id AS document_id, reg.id AS regulation_id, reg.regulation_code
       ${MAP_ALL_CANDIDATE_SQL}
      ORDER BY reg.regulation_code, d.id
      LIMIT $1`,
    [limit],
  );
  const queue = rows.rows.slice();
  const result: MapAllBatchResult = { processed: 0, links_created: 0, remaining: 0 };
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 4, 16));

  async function worker(): Promise<void> {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      result.processed++;
      try {
        const r = await runSemanticAutoMap(Number(job.document_id), {
          regulationCode: job.regulation_code,
        });
        result.links_created += r.auto_mapped || 0;
      } catch (err) {
        logger.warn(
          `[policyMappingBridge] map-all failed doc=${job.document_id} fw=${job.regulation_code}: ${(err as Error).message}`,
        );
      }
      // Mark scanned regardless of whether a match was found.
      try {
        await pool.query(
          `INSERT INTO document_framework_scans (document_id, regulation_id)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [Number(job.document_id), Number(job.regulation_id)],
        );
      } catch {
        /* best-effort */
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length || 1) }, () => worker()),
  );
  result.remaining = await countMapAllRemaining();
  return result;
}
