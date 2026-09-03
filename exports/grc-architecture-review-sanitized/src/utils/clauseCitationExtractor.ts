/**
 * clauseCitationExtractor — Compliance v2 Pillar 4.
 *
 * Reads the extracted text of an uploaded document and surfaces every
 * clause/article reference it finds (e.g. "PDPL Article 6",
 * "ISO 27001 A.5.15", "Clause 8.2.1"). Resolved citations (where the
 * raw reference matches a known obligation_code or article_reference)
 * power two downstream features:
 *
 *   1. Auto-mapping — insert an obligation_documents row with
 *      `link_method='citation_auto'` + `awaiting_review=true`.
 *   2. Strong-confidence channel — surfaced in suggestObligationMappingTool
 *      so the reviewer can one-click accept evidence-driven mappings.
 *
 * Design:
 *   - regex-first: cheap, predictable, no token spend
 *   - AI-fallback only if regex finds < MIN_CITATIONS_FOR_AI_SKIP and
 *     the document is long enough to plausibly contain references
 *   - Always idempotent at the DB layer (UNIQUE on
 *     (document_id, raw_citation))
 *
 * The regex set + the resolveCitation helper are exported separately
 * for unit testing without DB / AI access.
 */

import { sharedPool as pool } from "./sharedPool";
import { logger } from "./logger";

export interface RawCitation {
  raw_citation: string;
  source_excerpt: string;
  framework_hint: string | null; // e.g. "ISO27001", "PDPL"; null if unknown
  clause_hint: string | null; // e.g. "A.5.15", "6.1.1", "Article 6"
}

export interface ResolvedCitation extends RawCitation {
  regulation_id: number | null;
  obligation_id: number | null;
  confidence: number;
  method: "regex" | "ai";
}

// Map of recognised framework aliases -> canonical regulation_code.
// Order matters only for ambiguous overlaps; the longest match wins by
// virtue of the regex alternation order.
export const FRAMEWORK_ALIASES: Array<{ pattern: RegExp; code: string }> = [
  { pattern: /\bISO[\s-]?27001(?::?\s*\d{4})?\b/i, code: "ISO-27001" },
  { pattern: /\bISO[\s-]?9001(?::?\s*\d{4})?\b/i, code: "ISO-9001" },
  { pattern: /\bPCI[\s-]?DSS\b/i, code: "PCI-DSS" },
  { pattern: /\bPDPL\b/i, code: "PDPL" },
  { pattern: /\bSAMA(?:[\s-]?CSF)?\b/i, code: "SAMA-CSF" },
  { pattern: /\bNCA[\s-]?ECC\b/i, code: "NCA-ECC" },
  { pattern: /\bNCA[\s-]?DCC\b/i, code: "NCA-DCC" },
  // SOC 2 is cited three ways in practice: by report name, by the criteria set,
  // or by the abbreviation. Without this alias (and the TSC clause shape below)
  // SOC 2 coverage would be structurally 0% forever — the regulation and its
  // criteria would exist, but nothing could ever create a link to them.
  {
    pattern: /\b(?:SOC[\s-]?2|Trust\s+Services\s+Criteria|TSC)\b/i,
    code: "SOC2",
  },
  // COPC removed 2026-07-29 — the regulation had no clause catalogue and was
  // retired from the compliance frameworks. Citing it can no longer resolve.
];

// Clause-shape regexes. Each match returns the framework hint (if
// captured) plus the clause portion. We collect every hit, then
// resolve in a second pass.
//
// Patterns covered:
//   "ISO 27001 A.5.15"      — framework + Annex A code
//   "ISO 27001 Clause 6.1"  — framework + clause/section
//   "PDPL Article 6"        — framework + article number
//   "Article 12 of PDPL"    — article + framework
//   "Clause 8.2.1"          — clause without framework hint
//   "A.12.1.2"              — bare Annex A id
const CLAUSE_PATTERNS: Array<{ regex: RegExp; framework_idx: number; clause_idx: number }> = [
  // ISO 27001 A.5.15 / ISO27001 A.5.15 / SOC 2 CC6.1
  {
    regex: /\b(ISO[\s-]?27001|ISO[\s-]?9001|PCI[\s-]?DSS|PDPL|SAMA[\s-]?CSF|NCA[\s-]?ECC|NCA[\s-]?DCC|SOC[\s-]?2|Trust\s+Services\s+Criteria|TSC)[\s:.-]+(A\.[0-9]+(?:\.[0-9]+){1,3}|CC[1-9]\.[0-9]+|A1\.[0-9]+|C1\.[0-9]+|PI1\.[0-9]+|P[1-8]\.[0-9]+|Clause\s+\d+(?:\.\d+){0,3}|Article\s+\d+(?:\.\d+)?|\d+(?:\.\d+){1,3})\b/gi,
    framework_idx: 1,
    clause_idx: 2,
  },
  // Article 12 of PDPL / CC6.1 of SOC 2
  {
    regex: /\b(Article\s+\d+(?:\.\d+)?|Clause\s+\d+(?:\.\d+){0,3}|CC[1-9]\.[0-9]+|A1\.[0-9]+|C1\.[0-9]+|PI1\.[0-9]+|P[1-8]\.[0-9]+)\s+of\s+(ISO[\s-]?27001|ISO[\s-]?9001|PCI[\s-]?DSS|PDPL|SAMA[\s-]?CSF|NCA[\s-]?ECC|NCA[\s-]?DCC|SOC[\s-]?2|Trust\s+Services\s+Criteria|TSC)\b/gi,
    framework_idx: 2,
    clause_idx: 1,
  },
  // Bare A.5.1.2 (Annex A)
  {
    regex: /\bA\.[0-9]+(?:\.[0-9]+){1,3}\b/g,
    framework_idx: -1,
    clause_idx: 0,
  },
  // Bare Trust Services Criteria id (CC6.1, A1.2, C1.1, PI1.3, P6.4).
  // Placed AFTER the framework-qualified patterns so the claimed-range
  // suppression keeps "SOC 2 CC6.1" as one qualified hit rather than also
  // matching the bare "CC6.1" inside it. Note "A1.2" (TSC) and "A.1.2"
  // (ISO Annex A) are distinct shapes and cannot collide.
  {
    regex: /\b(?:CC[1-9]\.[0-9]+|A1\.[0-9]+|C1\.[0-9]+|PI1\.[0-9]+|P[1-8]\.[0-9]+)\b/g,
    framework_idx: -1,
    clause_idx: 0,
  },
  // Bare Clause N.N / Article N (no framework — collected but
  // weighted lower at resolution time)
  {
    regex: /\b(Clause\s+\d+(?:\.\d+){0,3}|Article\s+\d+(?:\.\d+)?)\b/gi,
    framework_idx: -1,
    clause_idx: 0,
  },
];

export const EXCERPT_BEFORE = 60;
export const EXCERPT_AFTER = 80;
export const MAX_CITATIONS_PER_DOC = 200;

/**
 * Pure: scan the text and return raw citations. Exported for testing.
 */
export function extractRawCitations(text: string): RawCitation[] {
  if (!text || text.length < 30) return [];
  const out: RawCitation[] = [];
  const seen = new Set<string>();
  // Track text-index ranges already claimed by an earlier (more specific)
  // pattern. Later patterns (e.g. bare "A.5.15") must not re-emit a hit
  // that lies inside a region already matched by a framework+clause hit
  // like "ISO 27001 A.5.15".
  const claimedRanges: Array<[number, number]> = [];
  const overlapsClaimed = (start: number, end: number) => {
    for (const [s, e] of claimedRanges) {
      if (start < e && end > s) return true;
    }
    return false;
  };

  for (const p of CLAUSE_PATTERNS) {
    p.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.regex.exec(text)) !== null) {
      const raw = m[0];
      if (!raw || raw.length > 80) continue;
      const matchStart = m.index;
      const matchEnd = m.index + raw.length;
      if (overlapsClaimed(matchStart, matchEnd)) continue;
      // Always claim the range, even if we later drop the hit as a
      // duplicate key — otherwise a later, less-specific pattern (e.g.
      // bare "A.5.15") would still match the *second* occurrence of
      // "ISO 27001 A.5.15" and emit it as a separate citation.
      claimedRanges.push([matchStart, matchEnd]);
      const key = raw.toUpperCase().replace(/\s+/g, " ").trim();
      if (seen.has(key)) continue;
      seen.add(key);
      const fwRaw =
        p.framework_idx >= 0 && m[p.framework_idx]
          ? m[p.framework_idx]
          : null;
      const clauseRaw = m[p.clause_idx] || raw;
      const start = Math.max(0, m.index - EXCERPT_BEFORE);
      const end = Math.min(
        text.length,
        m.index + raw.length + EXCERPT_AFTER,
      );
      out.push({
        raw_citation: raw,
        source_excerpt: text.slice(start, end).replace(/\s+/g, " ").trim(),
        framework_hint: fwRaw ? canonicaliseFramework(fwRaw) : null,
        clause_hint: clauseRaw,
      });
      if (out.length >= MAX_CITATIONS_PER_DOC) return out;
    }
  }
  return out;
}

export function canonicaliseFramework(raw: string): string | null {
  for (const a of FRAMEWORK_ALIASES) {
    if (a.pattern.test(raw)) return a.code;
  }
  return null;
}

/**
 * Pure: normalise a clause hint into the parts we use for lookup.
 * Returns the candidate code suffix, the article-number string, and
 * the clause-number string. Exported for testing.
 */
export function normaliseClauseHint(hint: string): {
  annex: string | null; // "A.5.15"
  article: string | null; // "6"
  clause: string | null; // "8.2.1"
} {
  const t = hint.trim();
  let annex: string | null = null;
  let article: string | null = null;
  let clause: string | null = null;
  const annexM = t.match(/A\.[0-9]+(?:\.[0-9]+){1,3}/i);
  if (annexM) annex = annexM[0].toUpperCase();
  const artM = t.match(/Article\s+(\d+(?:\.\d+)?)/i);
  if (artM) article = artM[1];
  const clauseM = t.match(/Clause\s+(\d+(?:\.\d+){0,3})/i);
  if (clauseM) clause = clauseM[1];
  if (!annex && !article && !clause) {
    // Bare "5.1.2" — count it as a clause hint
    const bare = t.match(/^\d+(?:\.\d+){0,3}$/);
    if (bare) clause = bare[0];
  }
  return { annex, article, clause };
}

/**
 * Resolve raw citations to (regulation_id, obligation_id) using a
 * single round-trip per document.
 *
 * Strategy: for each citation, try to match either by:
 *   - obligation_code suffix containing the annex/article/clause hint
 *   - regulation_code matching the framework hint
 *
 * Returns one ResolvedCitation per input row (resolved or not).
 */
export async function resolveCitations(
  raws: RawCitation[],
): Promise<ResolvedCitation[]> {
  if (raws.length === 0) return [];
  // Pre-load all regulations (cheap; <50 rows in practice).
  const regs = await pool.query(
    `SELECT id, regulation_code FROM regulations WHERE status = 'active'`,
  );
  const regByCode = new Map<string, number>();
  for (const r of regs.rows) {
    regByCode.set(String(r.regulation_code).toUpperCase(), Number(r.id));
  }
  // Pre-load every obligation (capped); we do a per-citation scan
  // because the search space is small (<5k rows) and the alternative
  // is N db calls per document.
  const obls = await pool.query(
    `SELECT id, regulation_id, obligation_code, article_reference, clause_number
       FROM obligations
      WHERE status = 'applicable'
      LIMIT 10000`,
  );
  const obligations = obls.rows as Array<{
    id: number;
    regulation_id: number;
    obligation_code: string;
    article_reference: string | null;
    clause_number: string | null;
  }>;

  const out: ResolvedCitation[] = [];
  for (const r of raws) {
    const fwId = r.framework_hint ? regByCode.get(r.framework_hint) : undefined;
    const norm = normaliseClauseHint(r.clause_hint || r.raw_citation);
    let bestObligationId: number | null = null;
    let bestConfidence = 0;
    for (const o of obligations) {
      if (fwId && o.regulation_id !== fwId) continue;
      let conf = 0;
      const code = String(o.obligation_code || "").toUpperCase();
      const art = String(o.article_reference || "").toLowerCase();
      const cl = String(o.clause_number || "");
      if (norm.annex && code.includes(norm.annex)) conf = Math.max(conf, fwId ? 95 : 80);
      if (norm.article && (art.includes("article " + norm.article) || code.endsWith("-" + norm.article))) {
        conf = Math.max(conf, fwId ? 90 : 70);
      }
      if (norm.clause && (cl === norm.clause || code.endsWith(norm.clause))) {
        conf = Math.max(conf, fwId ? 88 : 65);
      }
      if (conf > bestConfidence) {
        bestConfidence = conf;
        bestObligationId = o.id;
      }
    }
    out.push({
      ...r,
      regulation_id: fwId ?? null,
      obligation_id: bestConfidence >= 60 ? bestObligationId : null,
      confidence: bestConfidence,
      method: "regex",
    });
  }
  return out;
}

/**
 * Persist resolved citations + auto-link to obligations when
 * confidence is high enough.
 *
 * Auto-mapping rules:
 *   - Only when obligation_id is set AND confidence >= AUTO_MAP_THRESHOLD
 *   - Insert with link_method='citation_auto' + awaiting_review=true
 *   - Skip if a manual link already exists (UNIQUE constraint kicks in)
 */
export const AUTO_MAP_CONFIDENCE_THRESHOLD = 80;

export async function persistAndAutoMap(
  documentId: number,
  citations: ResolvedCitation[],
  options: { skipAutoMap?: boolean } = {},
): Promise<{ stored: number; auto_mapped: number }> {
  let stored = 0;
  let autoMapped = 0;
  for (const c of citations) {
    try {
      await pool.query(
        `INSERT INTO document_clause_citations
           (document_id, regulation_id, obligation_id, raw_citation, source_excerpt, confidence, method)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (document_id, raw_citation) DO UPDATE
           SET regulation_id = EXCLUDED.regulation_id,
               obligation_id = EXCLUDED.obligation_id,
               source_excerpt = EXCLUDED.source_excerpt,
               confidence    = EXCLUDED.confidence,
               method        = EXCLUDED.method`,
        [
          documentId,
          c.regulation_id,
          c.obligation_id,
          c.raw_citation.slice(0, 200),
          c.source_excerpt.slice(0, 1000),
          c.confidence,
          c.method,
        ],
      );
      stored++;
    } catch (err) {
      logger.warn(
        `[citationExtractor] persist failed for doc=${documentId} cit="${c.raw_citation}": ${(err as Error).message}`,
      );
    }
    if (
      !options.skipAutoMap &&
      c.obligation_id &&
      c.confidence >= AUTO_MAP_CONFIDENCE_THRESHOLD
    ) {
      try {
        const r = await pool.query(
          `INSERT INTO obligation_documents
             (obligation_id, document_id, linked_by, link_method, awaiting_review)
           VALUES ($1, $2, 'ai-citation', 'citation_auto', TRUE)
           ON CONFLICT (obligation_id, document_id) DO NOTHING
           RETURNING id`,
          [c.obligation_id, documentId],
        );
        if (r.rowCount && r.rowCount > 0) autoMapped++;
      } catch (err) {
        logger.warn(
          `[citationExtractor] auto-map failed for doc=${documentId} ob=${c.obligation_id}: ${(err as Error).message}`,
        );
      }
    }
  }
  return { stored, auto_mapped: autoMapped };
}

/**
 * End-to-end runner used by the qmsdocs-text-extract Inngest pipeline.
 * Cheap: regex extraction + small SQL queries; no LLM call.
 */
export async function runCitationExtraction(
  documentId: number,
): Promise<{ stored: number; auto_mapped: number; raw_count: number }> {
  const docRes = await pool.query(
    `SELECT extracted_text FROM qms_uploaded_documents WHERE id = $1`,
    [documentId],
  );
  if (docRes.rows.length === 0) {
    return { stored: 0, auto_mapped: 0, raw_count: 0 };
  }
  const text = docRes.rows[0].extracted_text || "";
  const raws = extractRawCitations(text);
  if (raws.length === 0) {
    return { stored: 0, auto_mapped: 0, raw_count: 0 };
  }
  const resolved = await resolveCitations(raws);
  const { stored, auto_mapped } = await persistAndAutoMap(documentId, resolved);
  return { stored, auto_mapped, raw_count: raws.length };
}

/**
 * Read all citations for a document, joined with obligation/regulation
 * metadata. Used by the Document Mapping UI's "Auto-mapped, needs
 * review" tab and by the suggest tool's strong-confidence channel.
 */
export async function listCitationsForDocument(documentId: number): Promise<
  Array<{
    raw_citation: string;
    regulation_code: string | null;
    obligation_code: string | null;
    obligation_id: number | null;
    confidence: number;
    source_excerpt: string;
  }>
> {
  const r = await pool.query(
    `SELECT c.raw_citation, c.confidence, c.source_excerpt, c.obligation_id,
            r.regulation_code, o.obligation_code
       FROM document_clause_citations c
  LEFT JOIN regulations r ON r.id = c.regulation_id
  LEFT JOIN obligations o ON o.id = c.obligation_id
      WHERE c.document_id = $1
      ORDER BY c.confidence DESC NULLS LAST, c.id ASC`,
    [documentId],
  );
  return r.rows;
}
