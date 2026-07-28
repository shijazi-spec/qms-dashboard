/**
 * clauseSortKey — hierarchical ordering for compliance clauses.
 *
 * WHY THIS EXISTS
 * Clause lists were rendering alphabetically by title (`getAllObligations`
 * ordered by `priority DESC, title ASC`), and every other call site ordered by
 * `obligation_code`, which is VARCHAR — so `ISO9001-10.3` sorted BEFORE
 * `ISO9001-4.1`, and `SAMA-105` before `SAMA-11`. The GRC Manager needs
 * clauses in true document order: 1, 1.1, 1.2, 2, 2.1, 2.2, 2.3, 3, … 10.
 *
 * Clause formats differ per framework, so a regex inside ORDER BY is fragile.
 * Instead every obligation stores a precomputed `clause_sort_key` that plain
 * string comparison sorts correctly:
 *
 *   ISO 9001    code ISO9001-4.1        clause "Cl. 4.1"
 *   ISO 27001   code ISO27001-4         clause "Cl. 4"    / Annex "A.5.15"
 *   NCA ECC     code NCA-ECC-1-1-1      clause "1-1-1"
 *   NCA DCC     code NCA-DCC-…          clause "…"
 *   SAMA CSF    code SAMA-08 (flat seq) clause "§3.7"     ← the real hierarchy
 *   PCI DSS     code PCI-DSS-1.1.1      clause "Req. 1.1.1"
 *   PDPL        code PDPL-19            clause "Art. 19" / "IR Art. 3"
 *
 * ENCODING
 * The reference is tokenised into numeric and alphabetic runs, and each token
 * becomes a fixed-width 6-char field so lexicographic order == logical order:
 *
 *   numeric  n  →  '0' + n zero-padded to 5   ("6"  → "000006")
 *   alpha    a  →  '1' + a upper-cased, space-padded to 5 ("A" → "1A    ")
 *
 * Fields join with '.'. The leading 0/1 flag makes numeric segments sort before
 * alphabetic ones at the same depth, which is what we want in two real cases:
 *   - ISO 27001 main clauses (Cl. 4…10) precede Annex A (A.5.1…A.8.34)
 *   - PDPL law articles precede the Implementing Regulations ("IR Art. 3")
 * A shorter key is a prefix of a longer one, so "6.1" sorts before "6.1.3",
 * i.e. a parent clause always precedes its sub-clauses.
 *
 * SORT PRECEDENCE (all clause queries use the same ORDER BY):
 *
 *   ORDER BY o.section_order NULLS LAST, o.clause_sort_key NULLS LAST, o.obligation_code
 *
 * `section_order` leads because the framework seeds set it in clean per-domain
 * bands that already encode the standard's own presentation order (ISO 9001
 * uses 100/200/…/700 for clauses 4–10, NCA ECC and PCI DSS likewise). That
 * carries curated conventions a numeric key cannot express — notably SOC 2,
 * where the Trust Services Criteria list Common Criteria (CC1–CC9) BEFORE the
 * category criteria (A1 / C1 / PI1 / P1–P8) even though "A1" < "CC1"
 * alphabetically. `clause_sort_key` then orders anything section_order leaves
 * tied, and is the whole ordering for obligations created by hand through the
 * API, which have no section_order at all.
 *
 * Pure and dependency-free so it can be unit-tested without a database.
 */

/** Column is VARCHAR(64); 8 segments × 7 chars stays inside that. */
const MAX_SEGMENTS = 8;
export const CLAUSE_SORT_KEY_MAX_LEN = 64;

/**
 * Noise words that carry no ordering information. Stripped before tokenising so
 * "Cl. 4.1" and "4.1" produce the same key.
 *
 * NOT stripped, deliberately:
 *   "IR" — marks PDPL Implementing Regulations, which must sort AFTER the law's
 *          own articles rather than interleaving with them.
 *   "A"  — ISO 27001 Annex A.
 */
const NOISE = /\b(?:cl|clause|req|requirement|art|article|annex|section|sec|control)\b\.?/gi;

/** Framework prefixes on `obligation_code`, stripped when it is the fallback source. */
const CODE_PREFIX =
  /^(?:ISO9001|ISO27001|NCA-ECC|NCA-DCC|PCI-DSS|PDPL|SAMA|SOC2|COPC)[-_]/i;

function encodeToken(token: string): string {
  if (/^\d+$/.test(token)) {
    // Strip leading zeros so "08" and "8" encode identically, then pad.
    const n = String(parseInt(token, 10));
    return "0" + n.padStart(5, "0");
  }
  return "1" + token.toUpperCase().slice(0, 5).padEnd(5, " ");
}

/**
 * Build the sort key for one clause.
 *
 * @param clauseNumber the human clause reference (`obligations.clause_number`
 *        / `article_reference`) — preferred, it is the true hierarchy.
 * @param obligationCode fallback when no clause reference is stored; the
 *        framework prefix is stripped first.
 * @returns the key, or null when nothing orderable can be derived (caller
 *          should then fall back to `section_order`).
 */
export function buildClauseSortKey(
  clauseNumber?: string | null,
  obligationCode?: string | null,
): string | null {
  let raw = String(clauseNumber ?? "").trim();
  if (!raw) {
    raw = String(obligationCode ?? "").trim().replace(CODE_PREFIX, "");
  }
  if (!raw) return null;

  // "§3.7" → "3.7"; drop the noise words; anything else non-alphanumeric is a
  // separator handled by the tokeniser below.
  const cleaned = raw.replace(/§/g, " ").replace(NOISE, " ");

  // Tokenise into numeric and alphabetic runs. This splits "A.5.15" → A,5,15
  // and "6.1.3 d)" → 6,1,3,d without needing to enumerate separators.
  const tokens = cleaned.match(/\d+|[A-Za-z]+/g);
  if (!tokens || tokens.length === 0) return null;

  const key = tokens.slice(0, MAX_SEGMENTS).map(encodeToken).join(".");
  return key.slice(0, CLAUSE_SORT_KEY_MAX_LEN);
}

/**
 * Comparator over already-built keys. Exported for tests and for any in-memory
 * sorting; the database does the same thing with a plain ORDER BY.
 * Rows without a key sort last.
 */
export function compareClauseSortKeys(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}
