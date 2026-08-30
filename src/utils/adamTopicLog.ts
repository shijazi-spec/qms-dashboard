export interface SectionDef {
  key: string;
  label: string;
  href: string;
  keywords: string[];
}

/**
 * The platform's OWN sections (mirrors dashboard/js/navigation.js), which is
 * what Adam offers as options and what the topic log counts. Order matters:
 * the first section whose keyword appears wins, so the more specific ones come
 * first. Extending a keyword list here is the ONLY way a new theme enters the
 * menu — nothing is auto-invented, and no text from a question is ever stored.
 */
export const PLATFORM_SECTIONS: SectionDef[] = [
  { key: "duplicates", label: "Duplicates Radar — data cleanup and merges", href: "/duplicates",
    keywords: ["duplicate", "duplicates", "cleanup", "clean up", "merge", "merged", "dedupe", "تكرار"] },
  { key: "cs_lifecycle", label: "CS Lifecycle — client phases, renewals, churn", href: "/duplicates",
    keywords: ["cs lifecycle", "lifecycle", "renewal", "renewals", "churn", "onboarding", "adoption", "customer success"] },
  { key: "deal_compliance", label: "Deal Compliance — required documents on deals", href: "/duplicates",
    keywords: ["deal compliance", "deal docs", "required documents", "agreement", "proposal", "stage aging", "deal", "deals"] },
  { key: "preflight", label: "Preflight — vetting a company before creating it", href: "/duplicates",
    keywords: ["preflight", "existing client", "already a client", "already client", "vet", "cold contact"] },
  { key: "quality_reports", label: "Quality Reports — per-business-unit reporting", href: "/quality-reports",
    keywords: ["quality report", "quality reports", "business unit", "bu report", "per bu"] },
  { key: "kpis", label: "KPIs — the GRQ scorecard", href: "/kpis",
    keywords: ["kpi", "kpis", "scorecard", "target", "performance"] },
  { key: "audits", label: "Internal Audits — audit programme and findings", href: "/audits",
    keywords: ["audit", "audits", "internal audit", "finding", "findings", "nonconformity", "nonconformance"] },
  { key: "capa", label: "CAPA — corrective actions and audit reports", href: "/qms",
    keywords: ["capa", "capas", "corrective", "corrective action"] },
  { key: "compliance", label: "Compliance — obligations and audit readiness", href: "/compliance",
    keywords: ["compliance", "obligation", "obligations", "pdpl", "iso", "regulation", "regulatory"] },
  { key: "risks", label: "Risk Management — the risk register", href: "/risks",
    keywords: ["risk", "risks", "risk register", "mitigation"] },
  { key: "documents", label: "Documents — SOPs, policies and document control", href: "/integrated-qms",
    keywords: ["sop", "sops", "policy", "policies", "document control", "governance document", "procedure"] },
  { key: "calls", label: "Call Evaluation — call quality scoring", href: "/calls",
    keywords: ["call", "calls", "call evaluation", "call quality", "recording"] },
  { key: "handoff", label: "Handoff Tracker — Quality and GRC handoffs", href: "/handoff-tracker",
    keywords: ["handoff", "handoffs", "hand off"] },
  { key: "vendors", label: "Vendors — vendor assessments", href: "/vendors",
    keywords: ["vendor", "vendors", "supplier", "suppliers"] },
  { key: "reviews", label: "Management Review", href: "/reviews",
    keywords: ["management review", "mgmt review", "review meeting"] },
  { key: "fraud", label: "Fraud — rules, incidents and KPIs", href: "/fraud-incidents",
    keywords: ["fraud", "incident", "incidents", "country risk"] },
  { key: "team", label: "Team Performance", href: "/team",
    keywords: ["team performance", "team", "owner accountability", "accountability"] },
  { key: "approvals", label: "AI Approvals Queue — actions waiting for sign-off", href: "/ai-approvals",
    keywords: ["approval", "approvals", "approve", "queue", "pending action"] },
];

/**
 * PURE. Which platform section is this question about? Returns the section key,
 * or null when nothing matches. It returns NO text from the question under any
 * circumstance — the caller stores only this key, so a client name or contact
 * detail in the question can never reach the database.
 */
export function classifyQuestionSection(text: string): string | null {
  const scrubbed = String(text ?? "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, " ")
    .replace(/[+\d][\d\s()-]{6,}/g, " ")
    .replace(/[^a-z0-9\s؀-ۿ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!scrubbed) return null;

  for (const s of PLATFORM_SECTIONS) {
    for (const kw of s.keywords) {
      if (kw.includes(" ")) {
        if (scrubbed.includes(kw)) return s.key;
      } else if (new RegExp("(^| )" + kw + "( |$)").test(scrubbed)) {
        return s.key;
      }
    }
  }
  return null;
}
