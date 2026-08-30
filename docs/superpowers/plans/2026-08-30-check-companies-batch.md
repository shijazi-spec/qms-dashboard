# check-companies-batch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Adam a bulk company-NAME lookup so a pasted list of companies is answered in ONE call, closing the gap that made him answer ~10 of 56 and blame "data access limitations".

**Architecture:** A pure matcher (`matchCompanyNames`) over rows fetched by one grouped query (`getCompanyBatchRows`), exposed as the read-only Mastra tool `check-companies-batch`, plus the prompt rule pointing Adam at it. Matching reuses the platform's exported `normalizeCompanyName` so it cannot drift from Preflight/Radar.

**Tech Stack:** TypeScript, Postgres via `pool` (pg), Mastra `createTool` + zod, Vitest (type-checked locally; executed in CI).

## Global Constraints

- Matching reuses `normalizeCompanyName` exported from `src/utils/duplicateRadarDatabase.ts:6786` — do NOT write a second normalizer.
- **strict** = normalized names EQUAL (confident). **fuzzy** = one normalized name CONTAINS the other, returned but flagged `match_type: "fuzzy"` and never asserted as a client. Strict wins when both exist.
- Fuzzy requires the SHORTER normalized name to be **>= 4 chars**, so stubs like "co" cannot swallow unrelated companies.
- Read the SYNCED mirror (`duplicate_records`) only — no live Zoho calls. Select names/counts/stages ONLY, never `raw_data` (Quality-Reports 504 lesson).
- Input capped at **300** names (same ceiling Preflight uses).
- Segment scoping via `buildSegmentPredicate`, normalizing legacy `corporate` to `walaplus`, exactly like `getSegmentLeadDuplicateCount` / `getSegmentDealComplianceSummary` do.
- Tool is READ-ONLY: no writes, no approval gate.
- **NO backticks may be added to the `qmsConsultantAgent.ts` prompt template literal** (standing rule). Its backtick count is currently **11** and must stay 11. No `${` either.
- `duplicate_records` columns used: `record_type`, `record_name`, `company_name`, `account_name`, `stage`.
- **vitest CANNOT run locally** (no `vite`) and **`node` is currently MISSING from this machine** — if `node -v` fails, skip the execution steps, say so plainly in your report, and rely on the Replit build. Never invent a test result.
- **Commit ONLY your task's files** with explicit `git add <paths>` — NEVER `git add -A` (a parallel agent has unrelated uncommitted work). Do NOT push (controller pushes after final review).

---

### Task 1: Pure matcher `matchCompanyNames`

**Files:**
- Create: `src/utils/companyNameBatch.ts`
- Test: `tests/vitest/companyNameBatch.vitest.test.ts`

**Interfaces:**
- Consumes: `normalizeCompanyName` from `./duplicateRadarDatabase`.
- Produces:
  - `interface CrmNameRow { crm_name: string; record_type: string; n: number; stages: string[] | null }`
  - `interface CompanyMatch { input: string; matched: boolean; match_type: "strict" | "fuzzy" | null; matched_name: string | null; counts: { leads: number; deals: number; contacts: number; accounts: number }; deal_stages: string[] }`
  - `function matchCompanyNames(inputs: string[], crmRows: CrmNameRow[]): CompanyMatch[]`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { matchCompanyNames } from "../../src/utils/companyNameBatch";

const rows = [
  { crm_name: "KPMG Saudi Arabia", record_type: "account", n: 1, stages: null },
  { crm_name: "KPMG Saudi Arabia", record_type: "deal", n: 2, stages: ["Closed Lost", "Paid"] },
  { crm_name: "Three Lines Trading", record_type: "deal", n: 1, stages: ["Contacted"] },
  { crm_name: "شركة سالم بالحمر القابضة", record_type: "account", n: 1, stages: null },
];

describe("matchCompanyNames", () => {
  it("matches strictly, ignoring legal suffixes and case", () => {
    const [r] = matchCompanyNames(["kpmg saudi arabia ltd"], rows);
    expect(r.matched).toBe(true);
    expect(r.match_type).toBe("strict");
    expect(r.matched_name).toBe("KPMG Saudi Arabia");
    expect(r.counts).toEqual({ leads: 0, deals: 2, contacts: 0, accounts: 1 });
    expect(r.deal_stages.sort()).toEqual(["Closed Lost", "Paid"]);
  });
  it("flags a containment hit as fuzzy, never strict", () => {
    const [r] = matchCompanyNames(["Three Lines"], rows);
    expect(r.matched).toBe(true);
    expect(r.match_type).toBe("fuzzy");
    expect(r.matched_name).toBe("Three Lines Trading");
  });
  it("does not fuzzy-match on a short stub", () => {
    const [r] = matchCompanyNames(["Co"], rows);
    expect(r.matched).toBe(false);
    expect(r.match_type).toBeNull();
    expect(r.counts).toEqual({ leads: 0, deals: 0, contacts: 0, accounts: 0 });
  });
  it("matches Arabic names", () => {
    const [r] = matchCompanyNames(["شركة سالم بالحمر القابضة"], rows);
    expect(r.matched).toBe(true);
    expect(r.match_type).toBe("strict");
  });
  it("reports unmatched cleanly", () => {
    const [r] = matchCompanyNames(["Nonexistent Widgets"], rows);
    expect(r).toEqual({ input: "Nonexistent Widgets", matched: false, match_type: null, matched_name: null, counts: { leads: 0, deals: 0, contacts: 0, accounts: 0 }, deal_stages: [] });
  });
  it("dedupes repeated inputs but keeps original order and spelling", () => {
    const out = matchCompanyNames(["KPMG Saudi Arabia", "Three Lines", "KPMG Saudi Arabia"], rows);
    expect(out.length).toBe(2);
    expect(out.map((x) => x.input)).toEqual(["KPMG Saudi Arabia", "Three Lines"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.tests.json`
Expected: compile error — module/function not found. (If `node` is missing on this machine, note it and continue.)

- [ ] **Step 3: Implement**

```ts
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
    const dedupeKey = norm || input.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    let hit = norm ? byNorm.get(norm) : undefined;
    let type: CompanyMatch["match_type"] = hit ? "strict" : null;

    if (!hit && norm && norm.length >= MIN_FUZZY_LEN) {
      // Containment either way; both sides must clear MIN_FUZZY_LEN.
      const key = normKeys.find(
        (k) => k.length >= MIN_FUZZY_LEN && (k.includes(norm) || norm.includes(k)),
      );
      if (key) { hit = byNorm.get(key); type = "fuzzy"; }
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
```

- [ ] **Step 4: Verify**

Run: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → exit 0.
Run: `node node_modules/typescript/bin/tsc -p tsconfig.tests.json` → exit 0.
Run the pure check (skip and say so if `node` is missing):

```bash
node node_modules/typescript/bin/tsc src/utils/companyNameBatch.ts src/utils/duplicateRadarDatabase.ts --outDir _cnb --module commonjs --moduleResolution node --target es2022 --skipLibCheck --esModuleInterop --rootDir src/utils >/dev/null 2>&1; echo '{"type":"commonjs"}' > _cnb/package.json; node -e 'const {matchCompanyNames:M}=require("./_cnb/companyNameBatch.js"); const rows=[{crm_name:"KPMG Saudi Arabia",record_type:"account",n:1,stages:null},{crm_name:"KPMG Saudi Arabia",record_type:"deal",n:2,stages:["Closed Lost"]},{crm_name:"Three Lines Trading",record_type:"deal",n:1,stages:["Contacted"]}]; const a=M(["kpmg saudi arabia ltd"],rows)[0], b=M(["Three Lines"],rows)[0], c=M(["Co"],rows)[0]; console.log(a.match_type==="strict"&&a.counts.deals===2&&b.match_type==="fuzzy"&&c.matched===false?"PASS":"FAIL")'; rm -rf _cnb
```

Expected: `PASS`.

- [ ] **Step 5: Commit**

```bash
git add src/utils/companyNameBatch.ts tests/vitest/companyNameBatch.vitest.test.ts
git commit -m "feat(adam): pure matchCompanyNames (strict + flagged fuzzy) for bulk name lookup"
```

---

### Task 2: `getCompanyBatchRows` query

**Files:**
- Modify: `src/utils/duplicateRadarDatabase.ts` (add near `getSegmentLeadDuplicateCount`)
- Test: `tests/vitest/getCompanyBatchRows.vitest.test.ts`

**Interfaces:**
- Consumes: `buildSegmentPredicate`, `pool`, `DuplicateFilters`; `CrmNameRow` from `./companyNameBatch` (Task 1).
- Produces: `getCompanyBatchRows(segment: DuplicateFilters["segment"]): Promise<CrmNameRow[]>`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../src/utils/redactedPool", () => ({
  createRedactedPool: () => ({ query: (...a: any[]) => query(...a), connect: async () => ({ query: (...a: any[]) => query(...a), release: () => {} }) }),
}));
vi.mock("../../src/utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import { getCompanyBatchRows } from "../../src/utils/duplicateRadarDatabase";
beforeEach(() => query.mockReset());

describe("getCompanyBatchRows", () => {
  it("selects names/counts/stages only and never raw_data", async () => {
    query.mockResolvedValue({ rows: [{ crm_name: "KPMG Saudi Arabia", record_type: "deal", n: 2, stages: ["Paid"] }] });
    const rows = await getCompanyBatchRows("walaplus");
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("duplicate_records");
    expect(sql).toContain("record_type");
    expect(sql).not.toContain("raw_data");
    expect(rows[0].crm_name).toBe("KPMG Saudi Arabia");
    expect(rows[0].n).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.tests.json`
Expected: `getCompanyBatchRows` not exported. (If `node` is missing, note it and continue.)

- [ ] **Step 3: Implement.** Add the type import at the top of the file beside the other `./` imports:

```ts
import type { CrmNameRow } from "./companyNameBatch";
```

Then add the function immediately after `getSegmentLeadDuplicateCount`:

```ts
/** CRM company names + per-module counts + deal stages for the bulk name matcher.
 *  Names/counts/stages ONLY — never raw_data (large-payload lesson). */
export async function getCompanyBatchRows(
  segment: DuplicateFilters["segment"],
): Promise<CrmNameRow[]> {
  const seg = segment && segment !== "all" ? (segment === "corporate" ? "walaplus" : segment) : "all";
  const p = buildSegmentPredicate(seg, 1);
  const segCond = p.condition ? " AND " + p.condition : "";
  const res = await pool.query(
    `SELECT COALESCE(NULLIF(r.company_name,''), NULLIF(r.account_name,''), r.record_name) AS crm_name,
            r.record_type AS record_type,
            COUNT(*)::int AS n,
            ARRAY_AGG(DISTINCT r.stage) FILTER (
              WHERE r.record_type = 'deal' AND COALESCE(r.stage,'') <> ''
            ) AS stages
       FROM duplicate_records r
      WHERE COALESCE(NULLIF(r.company_name,''), NULLIF(r.account_name,''), r.record_name) IS NOT NULL${segCond}
      GROUP BY 1, 2`,
    [...p.params],
  );
  return res.rows.map((x: any) => ({
    crm_name: String(x.crm_name || ""),
    record_type: String(x.record_type || ""),
    n: Number(x.n) || 0,
    stages: Array.isArray(x.stages) ? x.stages.filter(Boolean) : [],
  }));
}
```

- [ ] **Step 4: Verify**

Run: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → exit 0.
Run: `node node_modules/typescript/bin/tsc -p tsconfig.tests.json` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/utils/duplicateRadarDatabase.ts tests/vitest/getCompanyBatchRows.vitest.test.ts
git commit -m "feat(adam): getCompanyBatchRows — one grouped query for bulk name lookup"
```

---

### Task 3: The `check-companies-batch` tool + registration

**Files:**
- Create: `src/mastra/tools/checkCompaniesBatchTool.ts`
- Modify: `src/mastra/agents/qmsConsultantAgent.ts` (import + tools-map entry ONLY — no prompt text in this task)

**Interfaces:**
- Consumes: `getCompanyBatchRows` (Task 2), `matchCompanyNames` (Task 1).
- Produces: tool id `check-companies-batch`, exported as `checkCompaniesBatchTool`.

- [ ] **Step 1: Create the tool** (mirrors `src/mastra/tools/checkDomainsBatchTool.ts`)

```ts
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/**
 * Bulk company-NAME lookup — the name equivalent of check-domains-batch.
 * Answers a pasted list of company names in ONE query against the synced CRM
 * mirror, so Adam no longer burns one tool call per company (which capped a
 * 56-company list at ~10 answers and looked like a permissions problem).
 */
export const checkCompaniesBatchTool = createTool({
  id: "check-companies-batch",

  description:
    "Check MANY company NAMES at once — 'are these companies already in the CRM / already clients?'. Pass an array of company names; it answers the WHOLE list in one fast batched query against the synced CRM data. Per company it returns matched (yes/no), match_type ('strict' = exact match on the normalized name, 'fuzzy' = name resemblance only, present these as 'possible match, verify' and never as a confirmed client), the CRM name matched, per-module counts (leads/deals/contacts/accounts) and the distinct deal stages. Use this for a pasted LIST of company names; for ONE company use lookup-entity, and if the user has DOMAINS prefer check-domains-batch. Read-only.",

  inputSchema: z.object({
    companies: z
      .array(z.string())
      .min(1)
      .max(300)
      .describe("Company names to check (max 300)"),
    segment: z
      .enum(["all", "marketplace", "walaplus", "walaone"])
      .optional()
      .describe("Optional CRM segment scope; defaults to all"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    checked: z.number(),
    matchedCount: z.number(),
    results: z.array(z.record(z.any())),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    try {
      const { getCompanyBatchRows } = await import("../../utils/duplicateRadarDatabase");
      const { matchCompanyNames } = await import("../../utils/companyNameBatch");
      const companies = (context?.companies || []).slice(0, 300);
      const rows = await getCompanyBatchRows((context?.segment as any) || "all");
      const results = matchCompanyNames(companies, rows);
      const matchedCount = results.filter((r) => r.matched).length;
      logger?.info("🔎 [checkCompaniesBatchTool] checked companies", {
        checked: results.length,
        matchedCount,
      });
      return { success: true, checked: results.length, matchedCount, results };
    } catch (e: any) {
      return {
        success: false,
        checked: 0,
        matchedCount: 0,
        results: [],
        error: e?.message || String(e),
      };
    }
  },
});
```

- [ ] **Step 2: Register on the agent.** In `src/mastra/agents/qmsConsultantAgent.ts` add the import beside the other tool imports:

```ts
import { checkCompaniesBatchTool } from "../tools/checkCompaniesBatchTool";
```

and add the entry to the tools object next to `checkDomainsBatchTool` (grep for `checkDomainsBatchTool:` to find the exact line), using the SAME `wt(...)` wrapper the sibling read-only tools use:

```ts
    checkCompaniesBatchTool:          wt(checkCompaniesBatchTool, AGENT_NAME),   // bulk company-NAME lookup
```

Do NOT touch the prompt template literal in this task (Task 4 does that).

- [ ] **Step 3: Verify**

Run: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → exit 0.
Run: `grep -c '\x60' src/mastra/agents/qmsConsultantAgent.ts` → must still print `11`.

- [ ] **Step 4: Commit**

```bash
git add src/mastra/tools/checkCompaniesBatchTool.ts src/mastra/agents/qmsConsultantAgent.ts
git commit -m "feat(adam): check-companies-batch tool + agent registration"
```

---

### Task 4: Point Adam's prompt rule at the new tool

**Files:**
- Modify: `src/mastra/agents/qmsConsultantAgent.ts` (the name-list bullet at ~line 189)

**Interfaces:**
- Consumes: the tool id `check-companies-batch` (Task 3).

- [ ] **Step 1: Replace the "no batch tool" bullet.** Find the bullet that begins `- **A pasted LIST of COMPANY NAMES (not domains) — state the limit, never disguise it:**` and replace that WHOLE bullet (it is one long line) with this one line:

```
- **A pasted LIST of COMPANY NAMES (not domains) — use checkCompaniesBatchTool:** never loop lookupEntityTool or preflightCheckTool over a long list (one call each — that is what capped a 56-company list at ~10 answers). checkCompaniesBatchTool answers the WHOLE list in one call and returns, per company, matched yes/no, match_type, the CRM name matched, per-module counts and the deal stages. Report a **strict** hit as a real match; report a **fuzzy** hit as "possible match — verify", NEVER as a confirmed client (it is name resemblance only). If the user has DOMAINS, prefer checkDomainsBatchTool — it is more precise. Your data access is IDENTICAL in Slack and in the web chat, so never explain a partial or negative answer as a permissions or access restriction.
```

Keep the NEXT bullet (`- **Say which object you checked.** ...`) exactly as it is.

- [ ] **Step 2: Verify the standing rule**

Run: `grep -c '\x60' src/mastra/agents/qmsConsultantAgent.ts` → must print `11` (no backticks added).
Run: `git diff src/mastra/agents/qmsConsultantAgent.ts | grep '^+' | grep -c '\${'` → must print `0`.
Run: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/mastra/agents/qmsConsultantAgent.ts
git commit -m "feat(adam): prompt rule now points name lists at check-companies-batch"
```

---

### Task 5: Ship

- [ ] **Step 1:** `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (exit 0), `node node_modules/typescript/bin/tsc -p tsconfig.tests.json` (exit 0), and `grep -c '\x60' src/mastra/agents/qmsConsultantAgent.ts` → `11`. If `node` is missing on this machine, record that in the report instead of inventing results.
- [ ] **Step 2:** `git pull --rebase --autostash origin QMS` then `git push origin QMS`.
- [ ] **Step 3:** Tell the user: Pull → Republish, then paste a company list at Adam (Slack or web) — it should come back complete in one pass, with fuzzy hits marked "verify".

## Self-Review notes

- **Spec coverage:** §2 matching rules → Task 1 (strict/fuzzy/MIN_FUZZY_LEN/strict-wins). §3 query shape, bounded, no raw_data → Task 2. §4 tool contract (id, 300 cap, segment, output fields) → Task 3. §5 pure core incl. dedupe/order → Task 1. §6 wiring (DB fn, tool file, registration, prompt) → Tasks 2, 3, 4. §7 non-goals honored (no live Zoho, no writes; both the tool description and the prompt say prefer domains). §8 testing → Tasks 1-2 tests + the backtick guard in Tasks 3-4. §9 deploy → Task 5.
- **Placeholder scan:** none — every code step carries complete code, and the node-missing contingency names the exact fallback (report it, never fabricate a result).
- **Type consistency:** `CrmNameRow` defined in Task 1, imported by Task 2's `getCompanyBatchRows`; `matchCompanyNames` from Task 1 consumed by Task 3's tool; tool id `check-companies-batch` in Task 3 matches the prompt text in Task 4. Field names (`crm_name`, `record_type`, `n`, `stages`; `match_type`, `matched_name`, `counts`, `deal_stages`) identical across all tasks.
