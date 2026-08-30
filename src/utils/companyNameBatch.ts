import { normalizeCompanyName } from "./duplicateRadarDatabase";

export interface CrmNameRow {
  crm_name: string;
  record_type: string;
  n: number;
  stages: string[] | null;
}
export interface CompanyMatch {
  input: string;
  matched: boolean;
  match_type: "strict" | "fuzzy" | null;
  matched_name: string | null;
  counts: { leads: number; deals: number; contacts: number; accounts: number };
  deal_stages: string[];
}

/** Shorter normalized name must be at least this long before containment counts
 *  as a fuzzy hit — stops stubs like "co" swallowing unrelated companies. */
const MIN_FUZZY_LEN = 4;

interface Agg {
  display: string;
  counts: { leads: number; deals: number; contacts: number; accounts: number };
  stages: Set<string>;
}

function bucketFor(recordType: string): keyof Agg["counts"] | null {
  switch ((recordType || "").toLowerCase()) {
    case "lead": return "leads";
    case "deal": return "deals";
    case "contact": return "contacts";
    case "account": return "accounts";
    default: return null;
  }
}

/** True when `needle` sits inside `haystack` on word boundaries. Normalized
 *  names are space-separated, so this stops "aster" matching "master builders". */
function containsToken(haystack: string, needle: string): boolean {
  if (needle === haystack) return true;
  return (
    haystack.startsWith(needle + " ") ||
    haystack.endsWith(" " + needle) ||
    haystack.includes(" " + needle + " ")
  );
}

/**
 * PURE. Resolve each input company name against CRM name rows.
 * strict = normalized equality; fuzzy = containment (flagged, never asserted).
 */
export function matchCompanyNames(inputs: string[], crmRows: CrmNameRow[]): CompanyMatch[] {
  // Aggregate CRM rows per normalized name.
  const byNorm = new Map<string, Agg>();
  for (const row of crmRows || []) {
    const display = String(row?.crm_name ?? "").trim();
    if (!display) continue;
    const norm = normalizeCompanyName(display);
    if (!norm) continue;
    let agg = byNorm.get(norm);
    if (!agg) {
      agg = { display, counts: { leads: 0, deals: 0, contacts: 0, accounts: 0 }, stages: new Set<string>() };
      byNorm.set(norm, agg);
    }
    const bucket = bucketFor(row.record_type);
    if (bucket) agg.counts[bucket] += Number(row.n) || 0;
    for (const s of row.stages || []) {
      const st = String(s ?? "").trim();
      if (st) agg.stages.add(st);
    }
  }
  const normKeys = Array.from(byNorm.keys());

  const empty = () => ({ leads: 0, deals: 0, contacts: 0, accounts: 0 });
  const out: CompanyMatch[] = [];
  const seen = new Set<string>();

  for (const raw of inputs || []) {
    const input = String(raw ?? "").trim();
    if (!input) continue;
    const norm = normalizeCompanyName(input);
    // Key on the RAW input, not the normalized form: "Almarai Company" and
    // "Almarai Group" are different lines the user pasted and each deserves a
    // row (normalized dedupe silently shrank the answer below the list length).
    const dedupeKey = input.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    let hit = norm ? byNorm.get(norm) : undefined;
    let type: CompanyMatch["match_type"] = hit ? "strict" : null;

    if (!hit && norm && norm.length >= MIN_FUZZY_LEN) {
      // Token-aligned containment only, and a DETERMINISTIC pick: the query has
      // no ORDER BY, so taking whatever arrived first made the same list return
      // different matches run to run. Closest length wins, ties alphabetical.
      const candidates = normKeys.filter(
        (k) => k.length >= MIN_FUZZY_LEN && (containsToken(k, norm) || containsToken(norm, k)),
      );
      if (candidates.length) {
        candidates.sort((a, b) => {
          const da = Math.abs(a.length - norm.length);
          const db = Math.abs(b.length - norm.length);
          return da !== db ? da - db : a.localeCompare(b);
        });
        hit = byNorm.get(candidates[0]);
        type = "fuzzy";
      }
    }

    out.push({
      input,
      matched: !!hit,
      match_type: hit ? type : null,
      matched_name: hit ? hit.display : null,
      counts: hit ? { ...hit.counts } : empty(),
      deal_stages: hit ? Array.from(hit.stages) : [],
    });
  }
  return out;
}
