# Adam Topic Log — Implementation Plan (Revision 1: sections, not keywords)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Adam's options menu rank the platform's own sections by what the team actually asks about — storing which section a question was about and NO text from the question.

**Architecture:** A pure section classifier over the platform's real nav sections, a small `adam_topic_log` table written fire-and-forget from both chat entry points, a `section-menu` tool returning the live ranked sections, and a prompt change so the menu comes from the tool.

**Tech Stack:** TypeScript, Postgres via `pool` (pg), Mastra `createTool` + zod, Vitest (type-checked; executed in CI).

## Global Constraints

- **NO text derived from a question is ever stored.** Only `section_key` (or NULL), `surface`, `asked_by`, `asked_at`. This supersedes the original keyword design — see REVISION 1 in the spec. There is NO keywords column.
- Sections are the platform's REAL sections (from `dashboard/js/navigation.js`), so a menu option always maps to a page the user can open.
- Classification is **keyword-matching only** — no LLM call, nothing added to chat latency.
- `recordQuestionSection` is **fire-and-forget: never throws, never blocks a reply.**
- The menu is **complete from day one**: `getSectionMenu` returns ALL sections (zero-count included), ordered by count desc then canonical order.
- **Nothing is auto-invented.** A question matching no section is a COUNT only (`unclassified`); a rising count is the signal for a human to extend a section's keyword list.
- Retention: `adam_topic_log` is pruned on the existing AI-metrics window (`resolveAiMetricsRetentionDays()`), alongside `ai_call_metrics`.
- Schema-parity STRICT: canonical `CREATE TABLE` is the source of truth; any later column needs BOTH a CREATE entry and an idempotent ALTER. No DROP TABLE.
- **NO backticks and no `${`** may be added to the `qmsConsultantAgent.ts` prompt template literal. Its backtick-containing-line count is **11** (`grep -c`) and must stay 11.
- **`node` is MISSING from this machine** — `tsc`/vitest cannot run. Attempt once, then state plainly in the report that verification was not possible. NEVER fabricate a result.
- **Commit ONLY your task's files** with an explicit `git add <paths>` — NEVER `git add -A`; a parallel session commits in this same checkout.

---

### Task 1 (REVISION): Section classifier — replace the keyword design

**Files:**
- Modify: `src/utils/adamTopicLog.ts` (already exists from the superseded design — rewrite its contents)
- Modify: `tests/vitest/adamTopicLog.vitest.test.ts` (rewrite)

**Interfaces:**
- Produces:
  - `interface SectionDef { key: string; label: string; href: string; keywords: string[] }`
  - `const PLATFORM_SECTIONS: SectionDef[]`
  - `function classifyQuestionSection(text: string): string | null`

- [ ] **Step 1: Rewrite the test**

```ts
import { describe, it, expect } from "vitest";
import { classifyQuestionSection, PLATFORM_SECTIONS } from "../../src/utils/adamTopicLog";

describe("PLATFORM_SECTIONS", () => {
  it("has unique keys, a label and a platform href for each", () => {
    const keys = PLATFORM_SECTIONS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of PLATFORM_SECTIONS) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.href.startsWith("/")).toBe(true);
      expect(s.keywords.length).toBeGreaterThan(0);
    }
  });
});

describe("classifyQuestionSection", () => {
  it("maps a question to a platform section", () => {
    expect(classifyQuestionSection("how many duplicates did we merge?")).toBe("duplicates");
    expect(classifyQuestionSection("any renewal coming up in CS?")).toBe("cs_lifecycle");
    expect(classifyQuestionSection("show me the KPI scorecard")).toBe("kpis");
    expect(classifyQuestionSection("what is open in the risk register?")).toBe("risks");
  });
  it("returns null when nothing matches — and NEVER any text", () => {
    expect(classifyQuestionSection("Acme Trading Ltd wants a partnership brochure")).toBeNull();
    expect(classifyQuestionSection("status?")).toBeNull();
  });
  it("respects canonical order when two sections could match", () => {
    // 'duplicate' (duplicates) precedes 'deal' (deal_compliance) in PLATFORM_SECTIONS
    expect(classifyQuestionSection("duplicate deal records")).toBe("duplicates");
  });
  it("ignores emails, phones and urls when matching", () => {
    expect(classifyQuestionSection("mail ahmad@walaplus.com about +966558733973")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.tests.json`
Expected: `classifyQuestionSection` / `PLATFORM_SECTIONS` not found. (If `node` is missing, note it and continue.)

- [ ] **Step 3: Replace the whole contents of `src/utils/adamTopicLog.ts` with**

```ts
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
```

- [ ] **Step 4: Verify**

Run: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → exit 0.
Run: `node node_modules/typescript/bin/tsc -p tsconfig.tests.json` → exit 0.
Run (skip and SAY SO if `node` is missing):

```bash
node node_modules/typescript/bin/tsc src/utils/adamTopicLog.ts --outDir _atl --module commonjs --moduleResolution node --target es2022 --skipLibCheck >/dev/null 2>&1; echo '{"type":"commonjs"}' > _atl/package.json; node -e 'const m=require("./_atl/adamTopicLog.js"); const c=m.classifyQuestionSection; console.log(c("how many duplicates did we merge?")==="duplicates" && c("show me the KPI scorecard")==="kpis" && c("Acme Trading Ltd wants a partnership brochure")===null && c("status?")===null ? "PASS":"FAIL")'; rm -rf _atl
```

Expected: `PASS`.

- [ ] **Step 5: Commit**

```bash
git add src/utils/adamTopicLog.ts tests/vitest/adamTopicLog.vitest.test.ts
git commit -m "feat(adam): classify questions into platform SECTIONS, store no question text"
```

---

### Task 2: Table, recording, ranking

**Files:**
- Modify: `src/utils/adamTopicLog.ts` (append DB layer)
- Test: `tests/vitest/adamTopicLogDb.vitest.test.ts`

**Interfaces:**
- Consumes: `PLATFORM_SECTIONS`, `classifyQuestionSection` (Task 1).
- Produces:
  - `async function ensureAdamTopicLogTable(): Promise<void>`
  - `async function recordQuestionSection(text: string, opts: { surface: "web" | "slack"; askedBy?: string | null }): Promise<void>` (never throws)
  - `interface SectionMenuOption { key: string; label: string; href: string; asked: number }`
  - `function rankSections(counts: Record<string, number>): SectionMenuOption[]` (PURE)
  - `async function getSectionMenu(limit?: number): Promise<{ options: SectionMenuOption[]; unclassified: number }>`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../src/utils/redactedPool", () => ({
  createRedactedPool: () => ({ query: (...a: any[]) => query(...a), connect: async () => ({ query: (...a: any[]) => query(...a), release: () => {} }) }),
}));
vi.mock("../../src/utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import { rankSections, recordQuestionSection } from "../../src/utils/adamTopicLog";
beforeEach(() => query.mockReset());

describe("rankSections", () => {
  it("returns every section, most-asked first, zero-count ones included", () => {
    const out = rankSections({ kpis: 9, duplicates: 3 });
    expect(out[0].key).toBe("kpis");
    expect(out[1].key).toBe("duplicates");
    expect(out.length).toBeGreaterThan(2);
    expect(out.find((o) => o.key === "risks")?.asked).toBe(0);
    expect(out.every((o) => o.href.startsWith("/"))).toBe(true);
  });
});

describe("recordQuestionSection", () => {
  it("stores only the section key — never any question text", async () => {
    query.mockResolvedValue({ rows: [] });
    await recordQuestionSection("how many duplicates for Acme Trading Ltd?", { surface: "web", askedBy: "s@walaplus.com" });
    const call = query.mock.calls.find((c) => String(c[0]).includes("INSERT INTO adam_topic_log"));
    expect(call).toBeTruthy();
    expect(JSON.stringify(call?.[1])).not.toContain("Acme");
    expect(JSON.stringify(call?.[1])).not.toContain("duplicates for");
  });
  it("swallows DB errors so a chat turn never breaks", async () => {
    query.mockRejectedValue(new Error("db down"));
    await expect(
      recordQuestionSection("any renewals due?", { surface: "slack", askedBy: null }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.tests.json`
Expected: exports not found. (If `node` is missing, note it and continue.)

- [ ] **Step 3: Implement.** Add these imports at the TOP of `src/utils/adamTopicLog.ts`:

```ts
import { createRedactedPool } from "./redactedPool";
import { normalizeSslMode } from "./normalizeDatabaseUrl";
import { logger } from "./logger";

const pool = createRedactedPool({
  connectionString: normalizeSslMode(process.env.DATABASE_URL),
});
```

then APPEND:

```ts
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
```

- [ ] **Step 4: Verify**

Run: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → exit 0.
Run: `node node_modules/typescript/bin/tsc -p tsconfig.tests.json` → exit 0.
Run: `node scripts/check-schema-parity.mjs --strict` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/utils/adamTopicLog.ts tests/vitest/adamTopicLogDb.vitest.test.ts
git commit -m "feat(adam): adam_topic_log table, fire-and-forget section recording, ranked menu"
```

---

### Task 3: Record from both chat surfaces + prune with AI metrics

**Files:**
- Modify: `src/mastra/routes/consultantRoutes.ts`
- Modify: `src/triggers/grqAssistantSlackChat.ts`
- Modify: `src/utils/aiTelemetry.ts`

**Interfaces:**
- Consumes: `recordQuestionSection` (Task 2).

- [ ] **Step 1: Record from the web chat.** In `src/mastra/routes/consultantRoutes.ts`, inside the `path: "/api/consultant/chat"` handler, just AFTER the guard `if (!message || typeof message !== "string")` block, insert:

```ts
          // Section log (fire-and-forget): records WHICH platform section was
          // asked about, never the question text. Never awaited into the reply.
          void import("../../utils/adamTopicLog").then(({ recordQuestionSection }) =>
            recordQuestionSection(message, { surface: "web", askedBy: user?.email || null }),
          ).catch(() => {});
```

(The handler destructures `const { message, threadId } = body;` and has `user` from the role gate — confirm both names before inserting.)

- [ ] **Step 2: Record from Slack.** In `src/triggers/grqAssistantSlackChat.ts`, immediately BEFORE the `agent.generate(...)` call (the block passing `maxSteps: SLACK_AGENT_MAX_STEPS`), insert:

```ts
        void import("../utils/adamTopicLog").then(({ recordQuestionSection }) =>
          recordQuestionSection(q, { surface: "slack", askedBy: `slack-${slackUser}` }),
        ).catch(() => {});
```

(`q` is the cleaned question and `slackUser` is in scope there.)

- [ ] **Step 3: Prune on the AI-metrics window.** In `src/utils/aiTelemetry.ts`, find the prune function containing `DELETE FROM ai_call_metrics WHERE started_at < NOW() - MAKE_INTERVAL(days => $1)` (~line 1093). Immediately AFTER that `pool.query(...)` call and BEFORE `const deleted = result.rowCount ?? 0;`, insert:

```ts
    // Adam's section log is AI-usage data, so it ages out on the SAME retention
    // window as the metrics above.
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

(Confirm `logger` is already imported in that file; if not, use the file's existing logging mechanism rather than adding an import.)

- [ ] **Step 4: Verify**

Run: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → exit 0.
Confirm neither chat handler AWAITS the call (must be `void import(...)`), so a slow log cannot delay a reply:
`grep -n "recordQuestionSection" src/mastra/routes/consultantRoutes.ts src/triggers/grqAssistantSlackChat.ts`

- [ ] **Step 5: Commit**

```bash
git add src/mastra/routes/consultantRoutes.ts src/triggers/grqAssistantSlackChat.ts src/utils/aiTelemetry.ts
git commit -m "feat(adam): log question sections from web + Slack, prune with AI metrics"
```

---

### Task 4: `section-menu` tool + prompt uses the live menu

**Files:**
- Create: `src/mastra/tools/sectionMenuTool.ts`
- Modify: `src/mastra/agents/qmsConsultantAgent.ts` (import + tools entry + ONE prompt edit)

**Interfaces:**
- Consumes: `getSectionMenu` (Task 2).
- Produces: tool `section-menu`, exported as `sectionMenuTool`.

- [ ] **Step 1: Create the tool**

```ts
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/**
 * The live options menu: the platform's own sections, ranked by what this team
 * has actually asked about over the last 90 days, so the menu evolves without a
 * prompt edit. `unclassified` counts questions that matched no section — a
 * signal for Quality to extend a section's keywords, not something to show a
 * manager.
 */
export const sectionMenuTool = createTool({
  id: "section-menu",

  description:
    "Get the live numbered options menu — the platform's sections, ordered by what the team has actually asked about recently. Call this whenever you need to offer someone a list of what you can report on (for example when a request is vague, like 'what is the status?'). Returns options (key, label, href, asked) in the order to present them, plus unclassified: a count of questions that matched no section, which is a signal for Quality and not for a manager. Read-only.",

  inputSchema: z.object({
    limit: z.number().optional().describe("How many options to return (default 5)"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    options: z.array(z.record(z.any())),
    unclassified: z.number(),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    try {
      const { getSectionMenu } = await import("../../utils/adamTopicLog");
      const { options, unclassified } = await getSectionMenu(context?.limit ?? 5);
      logger?.info("🧭 [sectionMenuTool] menu served", {
        options: options.length,
        unclassified,
      });
      return { success: true, options, unclassified };
    } catch (e: any) {
      return { success: false, options: [], unclassified: 0, error: e?.message || String(e) };
    }
  },
});
```

- [ ] **Step 2: Register it.** In `src/mastra/agents/qmsConsultantAgent.ts` add the import beside the other tool imports:

```ts
import { sectionMenuTool } from "../tools/sectionMenuTool";
```

and add to the tools object next to `checkCompaniesBatchTool` (grep for `checkCompaniesBatchTool:`), matching the neighbours' alignment:

```ts
    sectionMenuTool:                  wt(sectionMenuTool, AGENT_NAME),           // live options menu
```

- [ ] **Step 3: Point the prompt at the tool.** In the `## VAGUE QUESTIONS — ASK WHICH, DO NOT GUESS` section, replace this sentence:

```
Instead reply with ONE short, professional message: acknowledge, then offer a NUMBERED menu of what you can report and invite them to pick a number. Order the options by what is most likely for who is asking. A sound default:
```

with:

```
Instead reply with ONE short, professional message: acknowledge, then offer a NUMBERED menu of what you can report and invite them to pick a number. Get that menu from sectionMenuTool and present its options IN THE ORDER RETURNED — they are the platform's own sections, ranked by what this team actually asks, so the menu stays current without anyone editing you. Never show the unclassified count to a manager; it is a signal for Quality. If the tool fails, fall back to this list:
```

Leave the numbered 1-5 list and everything after it exactly as is (it becomes the documented fallback).

- [ ] **Step 4: Verify the standing rule**

Run: `grep -c '\x60' src/mastra/agents/qmsConsultantAgent.ts` → must print `11`.
Run: `git diff src/mastra/agents/qmsConsultantAgent.ts | grep '^+' | grep -c '\${'` → must print `0`.
Run: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/mastra/tools/sectionMenuTool.ts src/mastra/agents/qmsConsultantAgent.ts
git commit -m "feat(adam): section-menu tool + prompt serves the live ranked menu"
```

---

### Task 5: Ship

- [ ] **Step 1:** `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (exit 0), `node node_modules/typescript/bin/tsc -p tsconfig.tests.json` (exit 0), `node scripts/check-schema-parity.mjs --strict` (PASS), `grep -c '\x60' src/mastra/agents/qmsConsultantAgent.ts` → `11`. If `node` is missing, record that plainly instead of inventing results.
- [ ] **Step 2:** `git pull --rebase --autostash origin QMS` then `git push origin QMS`.
- [ ] **Step 3:** Tell the user: Pull → Republish. The menu starts in canonical order and re-ranks as questions accumulate; the `unclassified` count shows when a section's keywords need extending.

## Self-Review notes

- **Spec coverage (as revised):** REVISION 1 sections-not-keywords → Task 1 (`PLATFORM_SECTIONS`, `classifyQuestionSection` returns a key or null, never text). No-free-text storage → Task 2 (no keywords column; test asserts params carry no question text). §6 recording from both surfaces, fire-and-forget → Task 3. §7 ranking/tool/prompt → Tasks 2 and 4, with `unclassified` replacing `emergingTerms`. Retention → Task 3 Step 3. §9 testing → Tasks 1-2. §10 deploy → Task 5.
- **Placeholder scan:** none. The two "confirm the variable name / confirm logger is imported" notes name the exact symbol and the fallback.
- **Type consistency:** `PLATFORM_SECTIONS`/`classifyQuestionSection` (Task 1) consumed by Task 2; `SectionMenuOption`/`getSectionMenu` (Task 2) consumed by Task 4; `recordQuestionSection` (Task 2) consumed by Task 3. Column names (`section_key`, `surface`, `asked_by`, `asked_at`) and option fields (`key`, `label`, `href`, `asked`) identical across tasks.
