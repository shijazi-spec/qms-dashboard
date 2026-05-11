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
 * Pure: build a simple substring-membership matcher from a corpus of
 * lowercased text + a set of obligation ids known to be referenced.
 * Exported for testing.
 */
export function buildCoverageMatcher(
  textCorpus: string,
  obligationIds: ReadonlySet<number>,
): (c: ResolvedCitation) => boolean {
  const haystack = textCorpus.toLowerCase();
  return (c) => {
    if (c.obligation_id != null && obligationIds.has(c.obligation_id)) {
      return true;
    }
    const needle = c.raw_citation.toLowerCase().trim();
    if (!needle) return false;
    return haystack.includes(needle);
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
      reason: "No clause/article references found in SOP text",
    };
  }

  const { text: coverageText, obligationIds } = await loadCoverageSources();
  const baseMatcher = buildCoverageMatcher(coverageText, obligationIds);

  // Per-doc augmentation: when the SOP itself is tagged with one or more
  // regulation_codes (e.g. ["PDPL"]), a bare "Article 6" inside that SOP
  // should also match an audit_finding that references "PDPL Article 6".
  const haystackLower = coverageText.toLowerCase();
  function isCoveredForDoc(c: ResolvedCitation, regCodes: string[] | null): boolean {
    if (baseMatcher(c)) return true;
    if (!regCodes || regCodes.length === 0) return false;
    const needle = c.raw_citation.toLowerCase().trim();
    if (!needle) return false;
    for (const code of regCodes) {
      const codeStr = String(code).toLowerCase().trim();
      if (!codeStr) continue;
      if (haystackLower.includes(`${codeStr} ${needle}`)) return true;
      if (haystackLower.includes(`${codeStr}: ${needle}`)) return true;
    }
    return false;
  }

  let total = 0;
  let covered = 0;
  const gaps: SopGap[] = [];
  for (const { doc, cits } of perDocCitations) {
    const seenInDoc = new Set<string>();
    for (const c of cits) {
      const key = c.raw_citation.toUpperCase().replace(/\s+/g, " ").trim();
      if (seenInDoc.has(key)) continue;
      seenInDoc.add(key);
      total++;
      if (isCoveredForDoc(c, doc.regulation_codes)) {
        covered++;
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
  };
}
