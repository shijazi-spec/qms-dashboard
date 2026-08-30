export interface TopicDef {
  key: string;
  label: string;
  keywords: string[];
}

/**
 * The menu Adam offers, and the only place a topic is defined. Promoting a new
 * theme (see emergingTerms) = adding an entry here. Order matters: the first
 * topic whose keyword appears wins, so put the more specific ones first.
 */
export const CANONICAL_TOPICS: TopicDef[] = [
  { key: "data_cleanup", label: "Data cleanup — duplicates merged, what is still open",
    keywords: ["duplicate", "duplicates", "cleanup", "clean up", "merge", "merged", "dedupe", "تكرار"] },
  { key: "cs_lifecycle", label: "CS Lifecycle — client phases, renewals, violations",
    keywords: ["cs lifecycle", "lifecycle", "renewal", "churn", "onboarding", "adoption", "customer success"] },
  { key: "deals", label: "Deals — stage aging and document compliance",
    keywords: ["deal", "deals", "stage", "aging", "proposal", "agreement", "compliance", "documents attached"] },
  { key: "kpis", label: "KPIs — the GRQ scorecard and any red KPIs",
    keywords: ["kpi", "kpis", "scorecard", "target", "performance"] },
  { key: "open_actions", label: "Open actions — CAPAs and owner accountability",
    keywords: ["capa", "capas", "action", "actions", "accountability", "overdue", "owner"] },
  { key: "preflight", label: "Preflight — vetting a company before creating it",
    keywords: ["preflight", "existing client", "already a client", "already client", "vet", "import"] },
  { key: "documents", label: "Documents — SOPs, policies and document control",
    keywords: ["sop", "sops", "policy", "policies", "document control", "governance document"] },
  { key: "sync_status", label: "CRM sync — freshness and scan status",
    keywords: ["sync", "scan", "refresh", "last sync", "up to date"] },
];

const STOPWORDS = new Set([
  "what", "when", "where", "which", "about", "there", "their", "these", "those", "have", "has",
  "with", "from", "that", "this", "your", "please", "could", "would", "should", "give", "show",
  "tell", "need", "want", "does", "did", "the", "and", "for", "any", "all", "our", "you", "adam",
  "status", "update", "updates", "regarding", "dear", "hello", "thanks",
]);

/**
 * PURE. Map a question to a canonical topic by keyword. When nothing matches,
 * return normalized keywords instead so a recurring NEW theme can surface —
 * the raw question is never returned and never stored.
 */
export function classifyQuestionTopic(text: string): { topic: string | null; keywords: string[] } {
  const raw = String(text ?? "");
  // Strip anything that could carry PII before we look at words at all.
  const scrubbed = raw
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, " ")
    .replace(/[+\d][\d\s()-]{6,}/g, " ")
    .replace(/[^a-z0-9\s؀-ۿ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!scrubbed) return { topic: null, keywords: [] };

  for (const t of CANONICAL_TOPICS) {
    for (const kw of t.keywords) {
      if (kw.includes(" ")) {
        if (scrubbed.includes(kw)) return { topic: t.key, keywords: [] };
      } else if (new RegExp("(^| )" + kw + "( |$)").test(scrubbed)) {
        return { topic: t.key, keywords: [] };
      }
    }
  }

  const tokens = scrubbed.split(" ").filter(Boolean);
  // Too thin to learn anything from (e.g. "status?") — exactly the vague case
  // the menu exists to handle, so log the ask without inventing a theme.
  if (tokens.length < 3) return { topic: null, keywords: [] };

  const keywords: string[] = [];
  for (const tk of tokens) {
    if (tk.length < 4) continue;
    if (/\d/.test(tk)) continue;
    if (STOPWORDS.has(tk)) continue;
    if (keywords.includes(tk)) continue;
    keywords.push(tk);
    if (keywords.length >= 5) break;
  }
  return { topic: null, keywords };
}
