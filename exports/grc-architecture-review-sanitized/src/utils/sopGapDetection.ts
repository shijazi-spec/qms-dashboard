/**
 * SOP-driven gap detection for the executive digest (Phase 2).
 *
 * Reads SOP / policy documents from `qms_uploaded_documents`, extracts
 * clause/article references using `clauseCitationExtractor`, and compares
 * each requirement against actual operational records (audit_findings,
 * capas, enterprise_risks, audit_checklists).
 *
 * A requirement with no satisfying record is flagged as a "derived
 * expected NC" (open gap). The aggregate counts feed:
 *   - the digest's new "SOP Gaps" section (HTML + Slack)
 *   - the enterprise health-score formula (SOP-coverage component)
 *
 * Coverage signal — a requirement is considered "covered" when any of:
 *   - audit_findings.criteria_name / description / evidence contains the
 *     raw clause string (case-insensitive)
 *   - capas.title / description / nc_reference contains it
 *   - enterprise_risks.risk_title / risk_description / risk_source
 *     contains it
 *   - audit_checklists.obligation_id matches the resolved obligation_id
 *     OR audit_checklists.obligation_code contains the raw clause
 *
 * Best-effort: if any source table is missing or fails, the helper
 * degrades gracefully (treats it as "no evidence from that source") so
 * the digest never 500s from a schema drift.
 */

import { sharedPool as pool } from "./sharedPool";
import { logger } from "./logger";
import {
  canonicaliseFramework,
  extractRawCitations,
  resolveCitations,
  type ResolvedCitation,
} from "./clauseCitationExtractor";
import { extractDocumentText } from "./documentTextExtractor";
import { setDocumentExtractionResult } from "./qmsDocsDatabase";

/** Categories of qms_uploaded_documents we treat as "SOP-like". */
export const SOP_CATEGORIES: readonly string[] = [
  "sops",
  "policies",
  "security_controls",
];

/** Cap on requirements analysed per SOP doc to bound cost. */
export const MAX_REQUIREMENTS_PER_DOC = 50;

/** Cap on total requirements aggregated across all SOPs. */
export const MAX_TOTAL_REQUIREMENTS = 250;

/** Cap on per-source text scanned for coverage matching. */
const COVERAGE_TEXT_CAP_ROWS = 5_000;

export interface SopGap {
  document_id: number;
  document_title: string;
  category: string;
  raw_citation: string;
  obligation_id: number | null;
  framework_hint: string | null;
}

/**
 * Why a requirement was deemed "covered" by an operational record.
 *
 * - `obligation_id`   — checklist row links to the same obligation.
 * - `normalised_text` — same clause/article after stripping whitespace,
 *   punctuation, and prefix variants (Art./Article/§/Clause), and after
 *   collapsing framework aliases (e.g. "ISO27001" ≈ "ISO 27001").
 * - `ancestor`        — the SOP cites a parent clause (e.g. "A.5.15") and
 *   an operational record cites a sub-clause that lives underneath it
 *   (e.g. "A.5.15.1"). The narrower citation satisfies the broader one.
 */
export type CoverageMatchReason =
  | "obligation_id"
  | "normalised_text"
  | "ancestor";

export interface CoverageMatch {
  matched_by: CoverageMatchReason;
}

export interface SopGapSummary {
  /** Number of SOP docs scanned (those with extracted_text available). */
  documents_scanned: number;
  /** Total distinct requirements derived from SOPs. */
  requirements_total: number;
  /** Requirements with at least one satisfying record. */
  requirements_covered: number;
  /** Requirements with no satisfying record (derived expected NCs). */
  open_gaps: number;
  /** Coverage percentage (0-100). 0 when no requirements were found. */
  coverage_pct: number;
  /** First few open gaps for digest display. */
  top_gaps: SopGap[];
  /**
   * Per-reason count of how covered requirements were matched. Keys are
   * always present (zero-filled) so the dashboard drill-in can render
   * stable rows without having to back-fill missing buckets.
   */
  coverage_breakdown: Record<CoverageMatchReason, number>;
  /** Empty-state hint when no SOPs are available to scan. */
  reason?: string;
}

interface SopDocRow {
  id: number;
  title: string;
  category: string;
  file_path: string | null;
  mime_type: string | null;
  regulation_codes: string[] | null;
  extracted_text: string | null;
  extraction_status: string | null;
}

/** Per-doc cap for on-demand extraction inside the digest path. */
const MAX_ONDEMAND_EXTRACTIONS = 10;

/**
 * Pure: given a set of resolved citations and a coverage matcher, partition
 * them into covered / open. Exported for testing without DB access.
 */
export function partitionCitations(
  citations: ResolvedCitation[],
  isCovered: (c: ResolvedCitation) => boolean,
): { covered: ResolvedCitation[]; open: ResolvedCitation[] } {
  const covered: ResolvedCitation[] = [];
  const open: ResolvedCitation[] = [];
  for (const c of citations) {
    (isCovered(c) ? covered : open).push(c);
  }
  return { covered, open };
}

/**
 * Canonical, framework-aware shape of a single clause/article reference.
 * Built from raw text so we can compare references that look textually
 * different but mean the same thing — e.g. "Article 6", "Art. 6", "§6"
 * all reduce to `{ kind: "article", path: [6] }`.
 *
 * `kind` distinguishes the three reference families we care about:
 *   - `annex`   — ISO-style Annex A controls, e.g. "A.5.15"
 *   - `article` — regulation articles, e.g. "PDPL Article 6"
 *   - `clause`  — numbered clauses/sections, e.g. "Clause 8.2.1"
 *
 * `path` is the numeric hierarchy (e.g. `[5, 15, 1]` for "A.5.15.1") so
 * a parent citation can be detected as covering any of its descendants.
 */
export interface CanonicalCitation {
  framework: string | null;
  kind: "annex" | "article" | "clause";
  path: number[];
}

/** Framework alias alternation, shared by the forward/reverse scanners. */
const FRAMEWORK_ALT =
  "ISO[\\s-]?27001|ISO[\\s-]?9001|PCI[\\s-]?DSS|PDPL|SAMA[\\s-]?CSF|NCA[\\s-]?ECC|NCA[\\s-]?DCC|COPC";

/** Sub-patterns shared between needle parsing and corpus scanning. */
const ANNEX_RE = /A\.(\d+(?:\.\d+){0,3})/i;
const ARTICLE_RE = /(?:Art\.?|Article|§)\s*(\d+(?:\.\d+){0,3})/i;
const CLAUSE_RE = /(?:Clause|Section)\s*(\d+(?:\.\d+){0,3})/i;
const BARE_NUMERIC_RE = /^(\d+(?:\.\d+){1,3})$/;

function pathFromString(s: string): number[] {
  return s.split(".").map((n) => Number(n)).filter((n) => Number.isFinite(n));
}

/**
 * Pure: parse a single raw citation string into its canonical form.
 *
 * Tolerates whitespace/punctuation noise and the most common prefix
 * variants (Art., Article, §, Clause, Section). The `frameworkHint`
 * argument lets callers pass framework context that wasn't part of the
 * raw string itself (e.g. the citation came pre-resolved with a
 * `framework_hint` from the extractor, or the SOP doc declared its
 * regulation_codes). When the raw string itself contains a framework
 * alias, that alias wins over the hint.
 *
 * Returns `null` for strings that don't look like a clause/article
 * reference at all.
 */
export function normaliseCitation(
  raw: string,
  frameworkHint?: string | null,
): CanonicalCitation | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const inlineFw = trimmed.match(new RegExp(FRAMEWORK_ALT, "i"));
  const framework = inlineFw
    ? canonicaliseFramework(inlineFw[0])
    : frameworkHint
    ? canonicaliseFramework(frameworkHint) || frameworkHint.toUpperCase()
    : null;

  const annex = trimmed.match(ANNEX_RE);
  if (annex) return { framework, kind: "annex", path: pathFromString(annex[1]) };

  const article = trimmed.match(ARTICLE_RE);
  if (article)
    return { framework, kind: "article", path: pathFromString(article[1]) };

  const clause = trimmed.match(CLAUSE_RE);
  if (clause)
    return { framework, kind: "clause", path: pathFromString(clause[1]) };

  const bare = trimmed.match(BARE_NUMERIC_RE);
  if (bare) return { framework, kind: "clause", path: pathFromString(bare[1]) };

  return null;
}

/**
 * Pure: scan a free-text corpus and return every clause/article-shaped
 * reference it contains, normalised to canonical form. De-duplicates
 * exact repeats. Used to build the coverage index that
 * `buildCoverageMatcher` checks needles against.
 */
export function extractCanonicalCitations(text: string): CanonicalCitation[] {
  if (!text) return [];
  const out: CanonicalCitation[] = [];
  const seen = new Set<string>();

  const push = (c: CanonicalCitation | null) => {
    if (!c || c.path.length === 0) return;
    const key = `${c.framework || "*"}|${c.kind}|${c.path.join(".")}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };

  const annexBody = "A\\.\\d+(?:\\.\\d+){1,3}";
  const articleBody = "(?:Art\\.?|Article|§)\\s*\\d+(?:\\.\\d+){0,3}";
  const clauseBody = "(?:Clause|Section)\\s*\\d+(?:\\.\\d+){0,3}";
  const bodyAlt = `(?:${annexBody}|${articleBody}|${clauseBody})`;

  // "PDPL Article 6", "ISO 27001 A.5.15", or a bare clause body.
  const forward = new RegExp(
    `(?:(${FRAMEWORK_ALT})[\\s:.,;\\-]{1,5})?(${bodyAlt})`,
    "gi",
  );
  let m: RegExpExecArray | null;
  while ((m = forward.exec(text)) !== null) {
    const fw = m[1] ? canonicaliseFramework(m[1]) : null;
    push(normaliseCitation(m[2], fw));
  }

  // "Article 12 of PDPL" — framework appears AFTER the citation body.
  const reverse = new RegExp(
    `(${bodyAlt})\\s+of\\s+(${FRAMEWORK_ALT})`,
    "gi",
  );
  while ((m = reverse.exec(text)) !== null) {
    const fw = canonicaliseFramework(m[2]);
    push(normaliseCitation(m[1], fw));
  }

  return out;
}

/** True when `prefix` is a (proper or full) prefix of `path`. */
function pathStartsWith(path: number[], prefix: number[]): boolean {
  if (prefix.length === 0 || prefix.length > path.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (path[i] !== prefix[i]) return false;
  }
  return true;
}

/** Frameworks are compatible if either side is unspecified, or they match. */
function frameworksCompatible(a: string | null, b: string | null): boolean {
  if (!a || !b) return true;
  return a === b;
}

/**
 * Pure: build a coverage matcher that returns *why* a citation matched.
 *
 * Match precedence (highest first):
 *   1. `obligation_id` — checklist row links to the same obligation row.
 *   2. `normalised_text` — the corpus contains the same canonical
 *      reference (after normalising whitespace/punctuation, prefix
 *      variants like "Art." vs "Article" vs "§", and framework aliases).
 *   3. `ancestor` — the corpus cites a strictly narrower sub-clause that
 *      lives under the requirement's clause (e.g. SOP says "A.5.15",
 *      a CAPA references "A.5.15.1"). The narrower citation satisfies
 *      the broader one because every sub-clause is part of its parent.
 *
 * As a final safety net (so we never lose coverage on free-form text
 * that didn't survive normalisation), the matcher also falls back to a
 * lower-cased substring scan of the original corpus and reports that
 * as `normalised_text` too — this preserves the previous behaviour for
 * obligation codes and other identifiers that aren't clause-shaped.
 *
 * Returns `null` when nothing matches; otherwise a `CoverageMatch`
 * carrying the reason. The truthy/falsy shape keeps it usable as a
 * predicate from existing call sites.
 */
export function buildCoverageMatcher(
  textCorpus: string,
  obligationIds: ReadonlySet<number>,
): (c: ResolvedCitation) => CoverageMatch | null {
  const canonical = extractCanonicalCitations(textCorpus);

  // Bucket by `kind` so we don't scan article/clause candidates while
  // looking for an annex match (and vice versa).
  const byKind = new Map<CanonicalCitation["kind"], CanonicalCitation[]>();
  for (const c of canonical) {
    const arr = byKind.get(c.kind) ?? [];
    arr.push(c);
    byKind.set(c.kind, arr);
  }

  const haystackLower = textCorpus.toLowerCase();

  return (c) => {
    if (c.obligation_id != null && obligationIds.has(c.obligation_id)) {
      return { matched_by: "obligation_id" };
    }
    const raw = c.raw_citation;
    if (!raw || !raw.trim()) return null;

    const needle = normaliseCitation(raw, c.framework_hint);
    if (needle && needle.path.length > 0) {
      const candidates = byKind.get(needle.kind) ?? [];
      let ancestorHit = false;
      for (const h of candidates) {
        if (!frameworksCompatible(needle.framework, h.framework)) continue;
        if (!pathStartsWith(h.path, needle.path)) continue;
        if (h.path.length === needle.path.length) {
          return { matched_by: "normalised_text" };
        }
        ancestorHit = true;
      }
      if (ancestorHit) return { matched_by: "ancestor" };
    }

    // Last-resort lexical fallback: keeps non-clause identifiers
    // (obligation codes, framework-prefixed ids) working as before.
    const lex = raw.toLowerCase().trim();
    if (lex && haystackLower.includes(lex)) {
      return { matched_by: "normalised_text" };
    }
    return null;
  };
}

async function safeRows<T = any>(sql: string): Promise<T[]> {
  try {
    const r = await pool.query(sql);
    return r.rows as T[];
  } catch (err) {
    logger.warn(
      `[sopGapDetection] coverage source query failed: ${(err as Error).message}`,
    );
    return [];
  }
}

/** Pull the haystack of operational text + linked obligation ids. */
async function loadCoverageSources(): Promise<{
  text: string;
  obligationIds: Set<number>;
}> {
  const cap = COVERAGE_TEXT_CAP_ROWS;
  const [findings, capas, risks, checklists, audits] = await Promise.all([
    safeRows<{ s: string }>(
      `SELECT COALESCE(criteria_name,'') || ' ' || COALESCE(description,'') || ' ' || COALESCE(evidence,'') || ' ' || COALESCE(recommendation,'') AS s
         FROM audit_findings LIMIT ${cap}`,
    ),
    safeRows<{ s: string }>(
      `SELECT COALESCE(title,'') || ' ' || COALESCE(description,'') || ' ' || COALESCE(nc_reference,'') AS s
         FROM capas LIMIT ${cap}`,
    ),
    safeRows<{ s: string }>(
      `SELECT COALESCE(risk_title,'') || ' ' || COALESCE(risk_description,'') || ' ' || COALESCE(risk_source,'') AS s
         FROM enterprise_risks LIMIT ${cap}`,
    ),
    safeRows<{ obligation_id: number | null; obligation_code: string | null }>(
      `SELECT obligation_id, obligation_code FROM audit_checklists LIMIT ${cap}`,
    ),
    // Per task spec, the audits table itself is also a satisfying source:
    // an audit whose title/scope/description references a clause counts
    // as evidence that the clause has been exercised.
    safeRows<{ s: string }>(
      `SELECT COALESCE(title,'') || ' ' || COALESCE(description,'') || ' ' || COALESCE(scope,'') AS s
         FROM audits LIMIT ${cap}`,
    ),
  ]);

  const parts: string[] = [];
  for (const r of findings) if (r.s) parts.push(r.s);
  for (const r of capas) if (r.s) parts.push(r.s);
  for (const r of risks) if (r.s) parts.push(r.s);
  for (const r of audits) if (r.s) parts.push(r.s);
  const obligationIds = new Set<number>();
  for (const r of checklists) {
    if (r.obligation_id != null) obligationIds.add(Number(r.obligation_id));
    if (r.obligation_code) parts.push(r.obligation_code);
  }
  return { text: parts.join("\n"), obligationIds };
}

async function loadSopDocs(): Promise<SopDocRow[]> {
  try {
    const placeholders = SOP_CATEGORIES.map((_, i) => `$${i + 1}`).join(",");
    // Load every SOP-like row; on-demand extraction inside
    // computeSopGapSummary() will fill in extracted_text when missing
    // (PDFs not yet processed by the Inngest backfill cron).
    const r = await pool.query(
      `SELECT id, title, category, file_path, mime_type, regulation_codes,
              extracted_text, extraction_status
         FROM qms_uploaded_documents
        WHERE category IN (${placeholders})
        ORDER BY uploaded_at DESC
        LIMIT 200`,
      [...SOP_CATEGORIES],
    );
    return r.rows as SopDocRow[];
  } catch (err) {
    logger.warn(
      `[sopGapDetection] failed to load SOP docs: ${(err as Error).message}`,
    );
    return [];
  }
}

/**
 * Ensure a SOP doc has extracted text. If `extracted_text` is missing or
 * too short, attempt on-the-fly extraction via `extractDocumentText` and
 * persist the result (so subsequent digests don't re-pay the cost).
 *
 * Returns the text to scan, or `null` if nothing usable could be obtained.
 * Never throws.
 */
async function ensureExtractedText(doc: SopDocRow): Promise<string | null> {
  if (doc.extracted_text && doc.extracted_text.length >= 30) {
    return doc.extracted_text;
  }
  if (!doc.file_path) return null;
  try {
    const result = await extractDocumentText(doc.file_path, doc.mime_type);
    // Persist whatever happened so this doc isn't re-extracted next run.
    try {
      await setDocumentExtractionResult(
        doc.id,
        result.status,
        result.text,
        result.hash,
      );
    } catch (persistErr) {
      logger.warn(
        `[sopGapDetection] failed to persist extraction for doc ${doc.id}: ${(persistErr as Error).message}`,
      );
    }
    if (result.status === "extracted" && result.text && result.text.length >= 30) {
      return result.text;
    }
    return null;
  } catch (err) {
    logger.warn(
      `[sopGapDetection] on-demand extraction failed for doc ${doc.id}: ${(err as Error).message}`,
    );
    return null;
  }
}

/**
 * Main entry — scan SOPs, derive requirements, compare against records.
 *
 * Returns an empty/zero summary (with `reason` set) rather than throwing
 * when there is nothing to scan, so the digest can fall through cleanly.
 */
export async function computeSopGapSummary(): Promise<SopGapSummary> {
  const docs = await loadSopDocs();
  if (docs.length === 0) {
    return {
      documents_scanned: 0,
      requirements_total: 0,
      requirements_covered: 0,
      open_gaps: 0,
      coverage_pct: 0,
      top_gaps: [],
      coverage_breakdown: emptyBreakdown(),
      reason: "No SOP documents with extracted text available",
    };
  }

  // Per-document extraction, then global de-dup by raw_citation+doc_id so
  // the same clause cited twice in one doc only counts once but the same
  // clause appearing in two different SOPs is still tracked separately
  // (different ownership, different gap).
  const perDocCitations: Array<{ doc: SopDocRow; cits: ResolvedCitation[] }> = [];
  let totalSoFar = 0;
  let onDemandUsed = 0;
  let scanned = 0;
  for (const doc of docs) {
    let text: string | null = null;
    if (doc.extracted_text && doc.extracted_text.length >= 30) {
      text = doc.extracted_text;
    } else if (onDemandUsed < MAX_ONDEMAND_EXTRACTIONS) {
      onDemandUsed++;
      text = await ensureExtractedText(doc);
    }
    if (!text) continue;
    scanned++;
    const raws = extractRawCitations(text).slice(0, MAX_REQUIREMENTS_PER_DOC);
    if (raws.length === 0) continue;
    const resolved = await resolveCitations(raws);
    perDocCitations.push({ doc, cits: resolved });
    totalSoFar += resolved.length;
    if (totalSoFar >= MAX_TOTAL_REQUIREMENTS) break;
  }

  if (scanned === 0) {
    return {
      documents_scanned: 0,
      requirements_total: 0,
      requirements_covered: 0,
      open_gaps: 0,
      coverage_pct: 0,
      top_gaps: [],
      coverage_breakdown: emptyBreakdown(),
      reason: "No SOP documents with extractable text available",
    };
  }

  if (perDocCitations.length === 0) {
    return {
      documents_scanned: scanned,
      requirements_total: 0,
      requirements_covered: 0,
      open_gaps: 0,
      coverage_pct: 0,
      top_gaps: [],
      coverage_breakdown: emptyBreakdown(),
      reason: "No clause/article references found in SOP text",
    };
  }

  const { text: coverageText, obligationIds } = await loadCoverageSources();
  const baseMatcher = buildCoverageMatcher(coverageText, obligationIds);

  // Per-doc augmentation: when the SOP itself is tagged with one or more
  // regulation_codes (e.g. ["PDPL"]) and the citation has no inline
  // framework hint, retry against each declared framework so a bare
  // "Article 6" inside a PDPL SOP still finds "PDPL Article 6" evidence.
  function matchForDoc(
    c: ResolvedCitation,
    regCodes: string[] | null,
  ): CoverageMatch | null {
    const direct = baseMatcher(c);
    if (direct) return direct;
    if (c.framework_hint) return null;
    if (!regCodes || regCodes.length === 0) return null;
    for (const code of regCodes) {
      const codeStr = String(code || "").trim();
      if (!codeStr) continue;
      const augmented: ResolvedCitation = { ...c, framework_hint: codeStr };
      const r = baseMatcher(augmented);
      if (r) return r;
    }
    return null;
  }

  let total = 0;
  let covered = 0;
  const breakdown = emptyBreakdown();
  const gaps: SopGap[] = [];
  for (const { doc, cits } of perDocCitations) {
    const seenInDoc = new Set<string>();
    for (const c of cits) {
      const key = c.raw_citation.toUpperCase().replace(/\s+/g, " ").trim();
      if (seenInDoc.has(key)) continue;
      seenInDoc.add(key);
      total++;
      const hit = matchForDoc(c, doc.regulation_codes);
      if (hit) {
        covered++;
        breakdown[hit.matched_by]++;
      } else {
        gaps.push({
          document_id: doc.id,
          document_title: doc.title,
          category: doc.category,
          raw_citation: c.raw_citation,
          obligation_id: c.obligation_id,
          framework_hint: c.framework_hint,
        });
      }
    }
  }

  const open_gaps = gaps.length;
  const coverage_pct = total > 0 ? Math.round((covered / total) * 100) : 0;
  return {
    documents_scanned: scanned,
    requirements_total: total,
    requirements_covered: covered,
    open_gaps,
    coverage_pct,
    top_gaps: gaps.slice(0, 10),
    coverage_breakdown: breakdown,
  };
}

/** Zero-filled breakdown so summaries always carry the full key set. */
function emptyBreakdown(): Record<CoverageMatchReason, number> {
  return { obligation_id: 0, normalised_text: 0, ancestor: 0 };
}
