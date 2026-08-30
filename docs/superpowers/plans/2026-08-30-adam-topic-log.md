# Adam Topic Log — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Adam's numbered options menu re-order itself from what the team actually asks, and surface recurring new themes for promotion.

**Architecture:** A pure keyword classifier + ranking shaper in one new util, a small `adam_topic_log` table written fire-and-forget from both chat entry points, a `topic-menu` tool the agent calls to get the live ordered options, and a prompt change so the menu comes from the tool instead of a hardcoded list.

**Tech Stack:** TypeScript, Postgres via `pool` (pg), Mastra `createTool` + zod, Vitest (type-checked; executed in CI).

## Global Constraints

- **NEVER store the raw question.** Only `topic_key`, `keywords` (unmatched only), `surface`, `asked_by`, `asked_at`. Questions routinely contain client company names and contact details.
- Keywords must have emails, URLs, and digit runs of length >= 7 stripped BEFORE storage, and contain no digits.
- Classification is **keyword-only** — no LLM call, nothing added to chat latency.
- `recordQuestionTopic` is **fire-and-forget: it must never throw and never block a reply.** A logging failure must not break a chat turn.
- The menu must be **complete from day one**: `getTopicMenu` returns ALL canonical topics (zero-count ones included), ordered by count desc then canonical order.
- **New topics are never auto-invented.** Unmatched keywords surface as `emergingTerms` (count >= 3) for a human to promote by adding a `CANONICAL_TOPICS` entry.
- Retention: `adam_topic_log` is pruned under the existing AI-metrics retention window (`resolveAiMetricsRetentionDays()`), alongside `ai_call_metrics`.
- Schema-parity is STRICT: the canonical `CREATE TABLE` is the source of truth; any later column needs BOTH a CREATE entry and an idempotent ALTER. No DROP TABLE.
- **NO backticks may be added to the `qmsConsultantAgent.ts` prompt template literal**, and no `${`. Its backtick-containing-line count is **11** and must stay 11 (`grep -c` on the file).
- **`node` is currently MISSING from this machine** — `tsc`/vitest cannot run. Attempt once, then state plainly in the report that verification was not possible; NEVER fabricate a result. The Replit build is the real compile check.
- **Commit ONLY your task's files** with an explicit `git add <paths>` — NEVER `git add -A`; a parallel session is committing in this same checkout.

---

### Task 1: Pure classifier + canonical topics

**Files:**
- Create: `src/utils/adamTopicLog.ts`
- Test: `tests/vitest/adamTopicLog.vitest.test.ts`

**Interfaces:**
- Produces:
  - `interface TopicDef { key: string; label: string; keywords: string[] }`
  - `const CANONICAL_TOPICS: TopicDef[]` (the 8 from the spec, in order)
  - `function classifyQuestionTopic(text: string): { topic: string | null; keywords: string[] }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { classifyQuestionTopic, CANONICAL_TOPICS } from "../../src/utils/adamTopicLog";

describe("CANONICAL_TOPICS", () => {
  it("has unique keys and a label for each", () => {
    const keys = CANONICAL_TOPICS.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const t of CANONICAL_TOPICS) expect(t.label.length).toBeGreaterThan(0);
  });
});

describe("classifyQuestionTopic", () => {
  it("matches a known topic by keyword", () => {
    expect(classifyQuestionTopic("how many duplicates did we merge?").topic).toBe("data_cleanup");
    expect(classifyQuestionTopic("any renewal coming up in CS?").topic).toBe("cs_lifecycle");
    expect(classifyQuestionTopic("show me the KPI scorecard").topic).toBe("kpis");
  });
  it("returns null plus keywords when nothing matches", () => {
    const out = classifyQuestionTopic("what about the marketing budget approval workflow");
    expect(out.topic).toBeNull();
    expect(out.keywords.length).toBeGreaterThan(0);
    expect(out.keywords).toContain("marketing");
  });
  it("never keeps emails, urls, or phone numbers in keywords", () => {
    const out = classifyQuestionTopic("ping ahmad@walaplus.com on +966558733973 see https://x.com/abc regarding onboarding paperwork");
    const joined = out.keywords.join(" ");
    expect(joined).not.toContain("walaplus.com");
    expect(joined).not.toContain("966558733973");
    expect(joined).not.toContain("https");
    for (const k of out.keywords) expect(/\d/.test(k)).toBe(false);
  });
  it("treats a too-short question as unlearnable", () => {
    const out = classifyQuestionTopic("status?");
    expect(out.topic).toBeNull();
    expect(out.keywords).toEqual([]);
  });
  it("respects canonical order when two topics could match", () => {
    // 'duplicate' (data_cleanup) precedes 'deal' (deals) in CANONICAL_TOPICS
    expect(classifyQuestionTopic("duplicate deal records").topic).toBe("data_cleanup");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.tests.json`
Expected: compile error — module/exports not found. (If `node` is missing, note it and continue.)

- [ ] **Step 3: Implement**

```ts
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
```

- [ ] **Step 4: Verify**

Run: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → exit 0.
Run: `node node_modules/typescript/bin/tsc -p tsconfig.tests.json` → exit 0.
Run the pure check (skip and SAY SO if `node` is missing):

```bash
node node_modules/typescript/bin/tsc src/utils/adamTopicLog.ts --outDir _atl --module commonjs --moduleResolution node --target es2022 --skipLibCheck >/dev/null 2>&1; echo '{"type":"commonjs"}' > _atl/package.json; node -e 'const m=require("./_atl/adamTopicLog.js"); const a=m.classifyQuestionTopic("how many duplicates did we merge?"), b=m.classifyQuestionTopic("status?"), c=m.classifyQuestionTopic("ping ahmad@walaplus.com on +966558733973 about marketing budget approval"); console.log(a.topic==="data_cleanup" && b.topic===null && b.keywords.length===0 && !c.keywords.join(" ").includes("walaplus") && c.keywords.every(k=>!/\d/.test(k)) ? "PASS":"FAIL")'; rm -rf _atl
```

Expected: `PASS`.

- [ ] **Step 5: Commit**

```bash
git add src/utils/adamTopicLog.ts tests/vitest/adamTopicLog.vitest.test.ts
git commit -m "feat(adam): pure question-topic classifier + canonical topic list"
```

---

### Task 2: Table, recording, ranking

**Files:**
- Modify: `src/utils/adamTopicLog.ts` (append DB layer)
- Test: `tests/vitest/adamTopicLogDb.vitest.test.ts`

**Interfaces:**
- Consumes: `CANONICAL_TOPICS`, `classifyQuestionTopic` (Task 1).
- Produces:
  - `async function ensureAdamTopicLogTable(): Promise<void>`
  - `async function recordQuestionTopic(text: string, opts: { surface: "web" | "slack"; askedBy?: string | null }): Promise<void>` (never throws)
  - `interface TopicMenuOption { key: string; label: string; asked: number }`
  - `async function getTopicMenu(limit?: number): Promise<{ options: TopicMenuOption[]; emergingTerms: Array<{ term: string; count: number }> }>`
  - `function rankTopics(counts: Record<string, number>): TopicMenuOption[]` (PURE — exported for testing)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../src/utils/redactedPool", () => ({
  createRedactedPool: () => ({ query: (...a: any[]) => query(...a), connect: async () => ({ query: (...a: any[]) => query(...a), release: () => {} }) }),
}));
vi.mock("../../src/utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import { rankTopics, recordQuestionTopic } from "../../src/utils/adamTopicLog";
beforeEach(() => query.mockReset());

describe("rankTopics", () => {
  it("returns every canonical topic, most-asked first", () => {
    const out = rankTopics({ kpis: 9, data_cleanup: 3 });
    expect(out[0].key).toBe("kpis");
    expect(out[1].key).toBe("data_cleanup");
    // zero-count topics still present so the menu is complete on day one
    expect(out.length).toBeGreaterThan(2);
    expect(out.every((o) => typeof o.label === "string" && o.label.length > 0)).toBe(true);
    expect(out.find((o) => o.key === "deals")?.asked).toBe(0);
  });
});

describe("recordQuestionTopic", () => {
  it("never stores the raw question text", async () => {
    query.mockResolvedValue({ rows: [] });
    await recordQuestionTopic("how many duplicates for Acme Trading Ltd?", { surface: "web", askedBy: "s@walaplus.com" });
    const insert = query.mock.calls.map((c) => String(c[0])).find((s) => s.includes("INSERT INTO adam_topic_log"));
    expect(insert).toBeTruthy();
    const params = (query.mock.calls.find((c) => String(c[0]).includes("INSERT INTO adam_topic_log")) || [])[1] as any[];
    expect(JSON.stringify(params)).not.toContain("Acme Trading");
  });
  it("swallows DB errors so a chat turn never breaks", async () => {
    query.mockRejectedValue(new Error("db down"));
    await expect(
      recordQuestionTopic("any renewals due?", { surface: "slack", askedBy: null }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.tests.json`
Expected: exports not found. (If `node` is missing, note it and continue.)

- [ ] **Step 3: Implement** (append to `src/utils/adamTopicLog.ts`; add these imports at the TOP of the file)

```ts
import { createRedactedPool } from "./redactedPool";
import { normalizeSslMode } from "./normalizeDatabaseUrl";
import { logger } from "./logger";

const pool = createRedactedPool({
  connectionString: normalizeSslMode(process.env.DATABASE_URL),
});
```

then append:

```ts
let topicTableReady = false;

/** Idempotent create. Canonical CREATE TABLE — schema-parity source of truth. */
export async function ensureAdamTopicLogTable(): Promise<void> {
  if (topicTableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS adam_topic_log (
      id         SERIAL PRIMARY KEY,
      topic_key  VARCHAR(40),
      keywords   TEXT[] NOT NULL DEFAULT '{}',
      surface    VARCHAR(16) NOT NULL,
      asked_by   VARCHAR(200),
      asked_at   TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_adam_topic_log_asked_at ON adam_topic_log(asked_at DESC)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_adam_topic_log_topic ON adam_topic_log(topic_key)`,
  );
  topicTableReady = true;
}

/**
 * Fire-and-forget. Records WHAT was asked about, never the question itself.
 * Must never throw: a logging failure must not break a chat reply.
 */
export async function recordQuestionTopic(
  text: string,
  opts: { surface: "web" | "slack"; askedBy?: string | null },
): Promise<void> {
  try {
    const { topic, keywords } = classifyQuestionTopic(text);
    if (!topic && keywords.length === 0) return; // nothing to learn from
    await ensureAdamTopicLogTable();
    await pool.query(
      `INSERT INTO adam_topic_log (topic_key, keywords, surface, asked_by)
       VALUES ($1, $2::text[], $3, $4)`,
      [topic, keywords, opts.surface, opts.askedBy || null],
    );
  } catch (e) {
    logger.warn("[AdamTopicLog] record skipped (non-fatal)", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

export interface TopicMenuOption { key: string; label: string; asked: number }

/** PURE. Every canonical topic, most-asked first, canonical order breaking ties. */
export function rankTopics(counts: Record<string, number>): TopicMenuOption[] {
  return CANONICAL_TOPICS.map((t, i) => ({
    key: t.key,
    label: t.label,
    asked: Number(counts[t.key]) || 0,
    _i: i,
  }))
    .sort((a, b) => (b.asked - a.asked) || (a._i - b._i))
    .map(({ key, label, asked }) => ({ key, label, asked }));
}

/**
 * The live menu: all canonical topics ranked by the last 90 days, plus the
 * recurring UNMATCHED terms (>= 3) that are candidates for promotion into
 * CANONICAL_TOPICS. Never invents a label — promotion is a human step.
 */
export async function getTopicMenu(
  limit = 5,
): Promise<{ options: TopicMenuOption[]; emergingTerms: Array<{ term: string; count: number }> }> {
  const counts: Record<string, number> = {};
  let emergingTerms: Array<{ term: string; count: number }> = [];
  try {
    await ensureAdamTopicLogTable();
    const r = await pool.query(
      `SELECT topic_key, COUNT(*)::int AS n
         FROM adam_topic_log
        WHERE topic_key IS NOT NULL AND asked_at >= NOW() - INTERVAL '90 days'
        GROUP BY topic_key`,
    );
    for (const row of r.rows) counts[String(row.topic_key)] = Number(row.n) || 0;

    const e = await pool.query(
      `SELECT term, COUNT(*)::int AS n
         FROM adam_topic_log, UNNEST(keywords) AS term
        WHERE topic_key IS NULL AND asked_at >= NOW() - INTERVAL '90 days'
        GROUP BY term
       HAVING COUNT(*) >= 3
        ORDER BY n DESC
        LIMIT 10`,
    );
    emergingTerms = e.rows.map((x: any) => ({ term: String(x.term), count: Number(x.n) || 0 }));
  } catch (err) {
    // Ranking is a nicety — an empty count map still yields the full default menu.
    logger.warn("[AdamTopicLog] menu ranking unavailable (non-fatal)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const options = rankTopics(counts).slice(0, Math.max(1, limit));
  return { options, emergingTerms };
}
```

- [ ] **Step 4: Verify**

Run: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → exit 0.
Run: `node node_modules/typescript/bin/tsc -p tsconfig.tests.json` → exit 0.
Run: `node scripts/check-schema-parity.mjs --strict` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/utils/adamTopicLog.ts tests/vitest/adamTopicLogDb.vitest.test.ts
git commit -m "feat(adam): adam_topic_log table, fire-and-forget recording, ranked menu"
```

---

### Task 3: Record from both chat surfaces + prune with AI metrics

**Files:**
- Modify: `src/mastra/routes/consultantRoutes.ts` (the `/api/consultant/chat` handler)
- Modify: `src/triggers/grqAssistantSlackChat.ts`
- Modify: `src/utils/aiTelemetry.ts` (prune path)

**Interfaces:**
- Consumes: `recordQuestionTopic` (Task 2).

- [ ] **Step 1: Record from the web chat.** In `src/mastra/routes/consultantRoutes.ts`, inside the `path: "/api/consultant/chat"` handler, just AFTER the guard that rejects a missing message (the `if (!message || typeof message !== "string")` block), insert:

```ts
          // Topic log (fire-and-forget): records WHAT was asked about, never the
          // question text. Never awaited into the reply path.
          void import("../../utils/adamTopicLog").then(({ recordQuestionTopic }) =>
            recordQuestionTopic(message, { surface: "web", askedBy: user?.email || null }),
          ).catch(() => {});
```

(Confirm the in-scope variable names first: the handler destructures `const { message, threadId } = body;` and has `user` from the role gate.)

- [ ] **Step 2: Record from Slack.** In `src/triggers/grqAssistantSlackChat.ts`, immediately BEFORE the `agent.generate(...)` call (the block that passes `maxSteps: SLACK_AGENT_MAX_STEPS`), insert:

```ts
        void import("../utils/adamTopicLog").then(({ recordQuestionTopic }) =>
          recordQuestionTopic(q, { surface: "slack", askedBy: `slack-${slackUser}` }),
        ).catch(() => {});
```

(`q` is the cleaned question text and `slackUser` is already in scope there.)

- [ ] **Step 3: Prune under the AI-metrics retention window.** In `src/utils/aiTelemetry.ts`, find the prune function containing `DELETE FROM ai_call_metrics WHERE started_at < NOW() - MAKE_INTERVAL(days => $1)` (~line 1093). Immediately AFTER that `pool.query(...)` call and BEFORE `const deleted = result.rowCount ?? 0;`, insert:

```ts
    // Adam's topic log is AI-usage data derived from user questions, so it ages
    // out on the SAME retention window as the metrics above (PDPL).
    try {
      await pool.query(
        `DELETE FROM adam_topic_log WHERE asked_at < NOW() - MAKE_INTERVAL(days => $1)`,
        [days],
      );
    } catch (e) {
      logger.warn("[AI-Metrics] adam_topic_log prune skipped (non-fatal)", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
```

(Confirm `logger` is already imported in that file; if it is not, use the file's existing logging mechanism instead of adding an import.)

- [ ] **Step 4: Verify**

Run: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → exit 0.
Confirm by grep that neither chat handler awaits the call (it must be `void import(...)`, never `await`), so a slow log cannot delay a reply:
`grep -n "recordQuestionTopic" src/mastra/routes/consultantRoutes.ts src/triggers/grqAssistantSlackChat.ts`

- [ ] **Step 5: Commit**

```bash
git add src/mastra/routes/consultantRoutes.ts src/triggers/grqAssistantSlackChat.ts src/utils/aiTelemetry.ts
git commit -m "feat(adam): log question topics from web + Slack, prune with AI metrics"
```

---

### Task 4: `topic-menu` tool + prompt uses the live menu

**Files:**
- Create: `src/mastra/tools/topicMenuTool.ts`
- Modify: `src/mastra/agents/qmsConsultantAgent.ts` (import + tools entry + ONE prompt edit)

**Interfaces:**
- Consumes: `getTopicMenu` (Task 2).
- Produces: tool `topic-menu`, exported as `topicMenuTool`.

- [ ] **Step 1: Create the tool**

```ts
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/**
 * The live options menu. Ranked by what this team has actually asked over the
 * last 90 days, so the menu evolves without a prompt edit. emergingTerms are
 * recurring UNMATCHED themes — candidates for promotion into CANONICAL_TOPICS
 * by a human; they are never shown as menu options.
 */
export const topicMenuTool = createTool({
  id: "topic-menu",

  description:
    "Get the live numbered options menu, ordered by what the team has actually asked about recently. Call this whenever you need to offer someone a list of what you can report on (for example when a request is vague, like 'what is the status?'). Returns options (key, label, asked) in the order you should present them, plus emergingTerms — recurring topics people ask about that are NOT yet menu options, which are for Quality/Sarah to review, not to show a manager. Read-only.",

  inputSchema: z.object({
    limit: z.number().optional().describe("How many options to return (default 5)"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    options: z.array(z.record(z.any())),
    emergingTerms: z.array(z.record(z.any())),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    try {
      const { getTopicMenu } = await import("../../utils/adamTopicLog");
      const { options, emergingTerms } = await getTopicMenu(context?.limit ?? 5);
      logger?.info("🧭 [topicMenuTool] menu served", {
        options: options.length,
        emerging: emergingTerms.length,
      });
      return { success: true, options, emergingTerms };
    } catch (e: any) {
      return { success: false, options: [], emergingTerms: [], error: e?.message || String(e) };
    }
  },
});
```

- [ ] **Step 2: Register it.** In `src/mastra/agents/qmsConsultantAgent.ts` add the import beside the other tool imports:

```ts
import { topicMenuTool } from "../tools/topicMenuTool";
```

and add to the tools object next to `checkCompaniesBatchTool` (grep for `checkCompaniesBatchTool:`), matching the neighbours' alignment:

```ts
    topicMenuTool:                    wt(topicMenuTool, AGENT_NAME),             // live options menu
```

- [ ] **Step 3: Point the prompt at the tool.** In the same file, in the `## VAGUE QUESTIONS — ASK WHICH, DO NOT GUESS` section, replace this sentence:

```
Instead reply with ONE short, professional message: acknowledge, then offer a NUMBERED menu of what you can report and invite them to pick a number. Order the options by what is most likely for who is asking. A sound default:
```

with:

```
Instead reply with ONE short, professional message: acknowledge, then offer a NUMBERED menu of what you can report and invite them to pick a number. Get that menu from topicMenuTool and present its options IN THE ORDER RETURNED — it is ranked by what this team actually asks, so it stays current without anyone editing you. If that tool fails, fall back to this list:
```

Leave the numbered 1-5 list, and everything after it, exactly as it is (it is now the documented fallback). Do NOT show emergingTerms in a menu — they are a review signal for Quality.

- [ ] **Step 4: Verify the standing rule**

Run: `grep -c '\x60' src/mastra/agents/qmsConsultantAgent.ts` → must print `11`.
Run: `git diff src/mastra/agents/qmsConsultantAgent.ts | grep '^+' | grep -c '\${'` → must print `0`.
Run: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/mastra/tools/topicMenuTool.ts src/mastra/agents/qmsConsultantAgent.ts
git commit -m "feat(adam): topic-menu tool + prompt serves the live ranked menu"
```

---

### Task 5: Ship

- [ ] **Step 1:** `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (exit 0), `node node_modules/typescript/bin/tsc -p tsconfig.tests.json` (exit 0), `node scripts/check-schema-parity.mjs --strict` (PASS), and `grep -c '\x60' src/mastra/agents/qmsConsultantAgent.ts` → `11`. If `node` is missing, record that plainly instead of inventing results.
- [ ] **Step 2:** `git pull --rebase --autostash origin QMS` then `git push origin QMS`.
- [ ] **Step 3:** Tell the user: Pull → Republish. The menu starts in canonical order and re-ranks as questions accumulate; ask Adam "what have people been asking about?" to see emerging themes once a few have repeated 3+ times.

## Self-Review notes

- **Spec coverage:** §2 decisions (surface-then-promote; topic+keywords only) → Task 1 classifier (no raw text returned) + Task 2 (`emergingTerms`, no text column) + Task 4 (emergingTerms never shown as options). §3 canonical topics → Task 1 `CANONICAL_TOPICS`. §4 classifier incl. PII strip + short-question rule → Task 1. §5 table + retention → Task 2 (CREATE) + Task 3 Step 3 (prune). §6 recording from both surfaces, fire-and-forget → Task 3 Steps 1-2. §7 ranking + tool + prompt → Task 2 (`getTopicMenu`/`rankTopics`), Task 4. §8 non-goals honored (no LLM pass, no auto-labels, no UI). §9 testing → Tasks 1-2. §10 deploy → Task 5.
- **Placeholder scan:** none. The two "confirm the variable names / confirm logger is imported" notes name the exact symbol to check and the fallback, rather than leaving work undefined.
- **Type consistency:** `CANONICAL_TOPICS`/`classifyQuestionTopic` (Task 1) consumed by Task 2's `recordQuestionTopic`/`rankTopics`; `TopicMenuOption` + `getTopicMenu` (Task 2) consumed by Task 3 (recording) and Task 4 (tool). Field names (`topic_key`, `keywords`, `surface`, `asked_by`, `asked_at`; `key`/`label`/`asked`; `term`/`count`) identical across tasks.
