import { createRedactedPool } from "./redactedPool";
import { normalizeSslMode } from "./normalizeDatabaseUrl";
import { logger } from "./logger";

const pool = createRedactedPool({
  connectionString: normalizeSslMode(process.env.DATABASE_URL),
});

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
  { key: "duplicates", label: "Data cleanup — duplicates merged, what's still open", href: "/duplicates",
    keywords: ["duplicate", "duplicates", "cleanup", "clean up", "merge", "merged", "dedupe", "تكرار"] },
  { key: "cs_lifecycle", label: "CS Lifecycle — phases, renewals, violations", href: "/duplicates",
    keywords: ["cs lifecycle", "lifecycle", "renewal", "renewals", "churn", "onboarding", "adoption", "customer success"] },
  { key: "deal_compliance", label: "Deals — stage aging and document compliance", href: "/duplicates",
    keywords: ["deal compliance", "deal docs", "required documents", "agreement", "proposal", "stage aging", "deal", "deals"] },
  { key: "preflight", label: "Preflight — vetting a company before creating it", href: "/duplicates",
    keywords: ["preflight", "existing client", "already a client", "already client", "vet", "cold contact"] },
  { key: "quality_reports", label: "Quality Reports — per-business-unit reporting", href: "/quality-reports",
    keywords: ["quality report", "quality reports", "business unit", "bu report", "per bu"] },
  { key: "kpis", label: "KPIs — the GRQ scorecard and any red KPIs", href: "/kpis",
    keywords: ["kpi", "kpis", "scorecard", "target", "red kpi"] },
  { key: "audits", label: "Internal Audits — audit programme and findings", href: "/audits",
    keywords: ["audit", "audits", "internal audit", "finding", "findings", "nonconformity", "nonconformance"] },
  { key: "capa", label: "Open actions — CAPAs and owner accountability", href: "/qms",
    keywords: ["capa", "capas", "corrective", "corrective action", "open action", "open actions", "owner accountability", "accountability"] },
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
    keywords: ["team performance", "team"] },
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

let topicTableReady = false;

/** Idempotent create. Canonical CREATE TABLE — schema-parity source of truth.
 *  There is deliberately NO column that can hold text from a question. */
export async function ensureAdamTopicLogTable(): Promise<void> {
  if (topicTableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS adam_topic_log (
      id           SERIAL PRIMARY KEY,
      section_key  VARCHAR(40),
      surface      VARCHAR(16) NOT NULL,
      asked_by     VARCHAR(200),
      asked_at     TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_adam_topic_log_asked_at ON adam_topic_log(asked_at DESC)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_adam_topic_log_section ON adam_topic_log(section_key)`,
  );
  topicTableReady = true;
}

/**
 * Fire-and-forget. Records WHICH SECTION was asked about — never the question.
 * Must never throw: a logging failure must not break a chat reply.
 */
export async function recordQuestionSection(
  text: string,
  opts: { surface: "web" | "slack"; askedBy?: string | null },
): Promise<void> {
  try {
    const sectionKey = classifyQuestionSection(text);
    await ensureAdamTopicLogTable();
    await pool.query(
      `INSERT INTO adam_topic_log (section_key, surface, asked_by) VALUES ($1, $2, $3)`,
      [sectionKey, opts.surface, opts.askedBy || null],
    );
  } catch (e) {
    logger.warn("[AdamTopicLog] record skipped (non-fatal)", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

export interface SectionMenuOption { key: string; label: string; href: string; asked: number }

/** PURE. Every section, most-asked first, canonical order breaking ties. */
export function rankSections(counts: Record<string, number>): SectionMenuOption[] {
  return PLATFORM_SECTIONS.map((s, i) => ({
    key: s.key,
    label: s.label,
    href: s.href,
    asked: Number(counts[s.key]) || 0,
    _i: i,
  }))
    .sort((a, b) => (b.asked - a.asked) || (a._i - b._i))
    .map(({ key, label, href, asked }) => ({ key, label, href, asked }));
}

/**
 * The live menu: platform sections ranked by the last 90 days, plus a COUNT of
 * questions that matched no section. A rising unclassified count is the signal
 * to extend a section's keyword list — a human edit, never an auto-invented
 * option, and no text is retained to make that judgement.
 */
export async function getSectionMenu(
  limit = 5,
): Promise<{ options: SectionMenuOption[]; unclassified: number }> {
  const counts: Record<string, number> = {};
  let unclassified = 0;
  try {
    await ensureAdamTopicLogTable();
    const r = await pool.query(
      `SELECT section_key, COUNT(*)::int AS n
         FROM adam_topic_log
        WHERE asked_at >= NOW() - INTERVAL '90 days'
        GROUP BY section_key`,
    );
    for (const row of r.rows) {
      if (row.section_key === null) unclassified = Number(row.n) || 0;
      else counts[String(row.section_key)] = Number(row.n) || 0;
    }
  } catch (err) {
    // Ranking is a nicety — an empty count map still yields the full menu.
    logger.warn("[AdamTopicLog] menu ranking unavailable (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return { options: rankSections(counts).slice(0, Math.max(1, limit)), unclassified };
}
