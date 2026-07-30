# Data Cleaning Progress Report — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a trustworthy, segment-filterable "Data Cleaning Progress" report (Deals & Accounts) inside the Duplicate Radar, backed by one function that also fixes the singleton-count bug feeding Adam's contradictory numbers.

**Architecture:** One backend function `getDataCleaningProgress(segment)` composes verified-merge counts (from `duplicate_resolution_ledger` `resolve` rows, attributed to a segment via the surviving record's layout), verified empty-record deletions (`empty_delete_ledger status='deleted'`), current outstanding duplicates (live, segmented), and a burndown trend (segmented forward). A new dashboard tab, a CSV/print export, and an Adam tool all read from this one function. A prerequisite SQL fix gates the executive-summary counts to real duplicates.

**Tech Stack:** TypeScript (Hono routes registered as `{path, method, createHandler}` arrays), Postgres via `pool` (pg), Mastra tools, vanilla-JS dashboard (`dashboard/js/duplicates-app.js` + `dashboard/duplicates.html`), Vitest.

## Global Constraints

- Segment values are exactly `all | marketplace | walaplus | walaone`; reuse `buildSegmentPredicate` (DRD:165-215). "walaplus" = NOT marketplace AND NOT walaone; blank layout defaults to walaplus.
- "Cleaned" headline = VERIFIED only: `duplicate_resolution_ledger.action_type='resolve'` and `empty_delete_ledger.status='deleted'`. NEVER count `module_resolved`, `auto_merge_pending`, `duplicate_resolution_feedback.event_type='applied'`, `merge_jobs.tagged`, or `duplicate_separation_ledger`.
- Records whose survivor is missing from `duplicate_records` go to an explicit `unknown_segment` bucket — never silently dropped.
- Empty-record deletions have no layout → reported all-segments with a note flag; never presented as segmented.
- No DROP TABLE (Replit publish schema-sync trap). Every `ALTER ADD COLUMN` must also appear in the canonical `CREATE TABLE` (schema-parity is strict).
- `DRD` = `src/utils/duplicateRadarDatabase.ts`.
- Deploy = commit only touched files, push `origin/QMS`, bump `dashboard/duplicates.html` `?v=` on any JS change, then user Pulls → Republishes. Local edits alone deploy stale.
- Verify commands: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (the global `tsc` stub is wrong); `node --check <file.js>`; tests `npx vitest run <path>` (fallback `node node_modules/vitest/vitest.mjs run <path>`); `npm run check:schema-parity` (or `node scripts/check-schema-parity.mjs`).

---

### Task 1: Trust fix — gate executive-summary counts to real duplicates

**Files:**
- Modify: `src/utils/duplicateRadarDatabase.ts:8107-8109` (`getEnhancedSummary`)

**Interfaces:**
- Consumes: nothing new.
- Produces: no signature change — `getEnhancedSummary()` still returns the same fields; `activeCount`/`resolvedCount`/`ignoredCount` become duplicate-gated.

**Why:** `active_count`/`resolved_count`/`ignored_count` are computed over `FROM duplicate_clusters dc` with no `>1` gate, so they include ~100k singleton clusters — the source of Adam's impossible "108,270 active clusters". `trueDuplicateClusters` (DRD:8079) already gates with `GREATEST(...) > 1`; mirror it here (same idea as the `MULTI` WHERE in `getClusterSummary`, DRD:4243/4278).

- [ ] **Step 1: Apply the gate to all three FILTERs**

Replace DRD:8107-8109:
```ts
      COUNT(*) FILTER (WHERE dc.status = 'active' AND ra.cluster_id IS NULL) as active_count,
      COUNT(*) FILTER (WHERE dc.status = 'resolved' OR ra.cluster_id IS NOT NULL) as resolved_count,
      COUNT(*) FILTER (WHERE dc.status = 'ignored' AND ra.cluster_id IS NULL) as ignored_count
```
with (add the duplicate gate; keep a local alias for readability):
```ts
      COUNT(*) FILTER (WHERE GREATEST(dc.total_leads, dc.total_deals, dc.total_contacts, dc.total_accounts) > 1
                        AND dc.status = 'active' AND ra.cluster_id IS NULL) as active_count,
      COUNT(*) FILTER (WHERE GREATEST(dc.total_leads, dc.total_deals, dc.total_contacts, dc.total_accounts) > 1
                        AND (dc.status = 'resolved' OR ra.cluster_id IS NOT NULL)) as resolved_count,
      COUNT(*) FILTER (WHERE GREATEST(dc.total_leads, dc.total_deals, dc.total_contacts, dc.total_accounts) > 1
                        AND dc.status = 'ignored' AND ra.cluster_id IS NULL) as ignored_count
```

- [ ] **Step 2: Type-check**

Run: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`
Expected: exit 0, no output.

- [ ] **Step 3: Record the post-deploy invariant check (do NOT run locally — no DB here)**

Add this to the task's PR notes; run against the deployed DB after republish:
```sql
-- active/resolved/ignored must each be <= trueDuplicateClusters+resolved+ignored,
-- and active must be a plausible small number (thousands, not 100k+).
SELECT
  COUNT(*) FILTER (WHERE GREATEST(total_leads,total_deals,total_contacts,total_accounts) > 1) AS true_dup_clusters,
  COUNT(*) FILTER (WHERE GREATEST(total_leads,total_deals,total_contacts,total_accounts) > 1 AND status='active') AS active_dup_clusters
FROM duplicate_clusters;
```
Expected: `active_dup_clusters <= true_dup_clusters`.

- [ ] **Step 4: Commit**

```bash
git add src/utils/duplicateRadarDatabase.ts
git commit -m "fix(radar): gate exec-summary active/resolved/ignored to real duplicates (kills 108k singleton inflation)"
```

---

### Task 2: Schema — add `segment` to `duplicate_progress_daily`

**Files:**
- Modify: `src/utils/duplicateRadarDatabase.ts:1361-1372` (canonical `CREATE TABLE`)
- Modify: `src/utils/duplicateRadarDatabase.ts` — add an idempotent ALTER right after that `CREATE TABLE` block.

**Interfaces:**
- Produces: `duplicate_progress_daily` now has `segment VARCHAR(16) NOT NULL DEFAULT 'all'` and `PRIMARY KEY (snapshot_date, module, segment)`. Existing rows become `segment='all'`.

- [ ] **Step 1: Update the canonical CREATE TABLE (schema-parity source of truth)**

Replace DRD:1362-1372 body so the create includes the column + 3-col PK:
```ts
    CREATE TABLE IF NOT EXISTS duplicate_progress_daily (
      snapshot_date DATE NOT NULL,
      module VARCHAR(16) NOT NULL,
      segment VARCHAR(16) NOT NULL DEFAULT 'all',
      open_count INTEGER NOT NULL DEFAULT 0,
      solved_count INTEGER NOT NULL DEFAULT 0,
      total_count INTEGER NOT NULL DEFAULT 0,
      merged_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (snapshot_date, module, segment)
    )
```

- [ ] **Step 2: Add the idempotent migration for existing deployments**

Immediately AFTER the `CREATE TABLE ... duplicate_progress_daily ...` `pool.query(...)` call (after DRD:1372's closing `);`), insert:
```ts
  // Segment burndown (2026-07-30): older deployments created this table before
  // the segment column existed. Add it + widen the PK so we can store one row
  // per (date, module, segment). Existing rows default to 'all' → no PK clash.
  // No DROP TABLE (Replit publish schema-sync trap). Idempotent.
  await pool.query(
    `ALTER TABLE duplicate_progress_daily
       ADD COLUMN IF NOT EXISTS segment VARCHAR(16) NOT NULL DEFAULT 'all'`,
  );
  await pool.query(
    `ALTER TABLE duplicate_progress_daily
       DROP CONSTRAINT IF EXISTS duplicate_progress_daily_pkey`,
  );
  await pool.query(
    `ALTER TABLE duplicate_progress_daily
       ADD PRIMARY KEY (snapshot_date, module, segment)`,
  );
```

- [ ] **Step 3: Type-check + schema-parity**

Run: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`
Expected: exit 0.
Run: `node scripts/check-schema-parity.mjs`
Expected: PASS (the `segment` ALTER is now mirrored in the CREATE TABLE).

- [ ] **Step 4: Commit**

```bash
git add src/utils/duplicateRadarDatabase.ts
git commit -m "feat(radar): add segment column to duplicate_progress_daily (additive, no DROP)"
```

---

### Task 3: `classifySegmentFromLayout` pure helper

**Files:**
- Create: `src/utils/duplicateRadarSegment.ts`
- Test: `tests/vitest/duplicateRadarSegment.vitest.test.ts`

**Interfaces:**
- Produces: `export function classifySegmentFromLayout(layout: string | null | undefined): "marketplace" | "walaplus" | "walaone"` — the JS mirror of `buildSegmentPredicate`'s SQL classification (marketplace = normalized layout contains "marketplace"/"partneraccounts"; walaone = contains "walaone"; else walaplus, incl. blank).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { classifySegmentFromLayout } from "../../src/utils/duplicateRadarSegment";

describe("classifySegmentFromLayout", () => {
  it("classifies marketplace variants", () => {
    expect(classifySegmentFromLayout("Doam Marketplace")).toBe("marketplace");
    expect(classifySegmentFromLayout("Partner Accounts")).toBe("marketplace");
    expect(classifySegmentFromLayout("Marketplace")).toBe("marketplace");
  });
  it("classifies walaone variants", () => {
    expect(classifySegmentFromLayout("WalaOne")).toBe("walaone");
    expect(classifySegmentFromLayout("Wala One")).toBe("walaone");
    expect(classifySegmentFromLayout("wala-one corporate")).toBe("walaone");
  });
  it("defaults blank/other to walaplus", () => {
    expect(classifySegmentFromLayout("")).toBe("walaplus");
    expect(classifySegmentFromLayout(null)).toBe("walaplus");
    expect(classifySegmentFromLayout("Corporate")).toBe("walaplus");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/vitest/duplicateRadarSegment.vitest.test.ts`
Expected: FAIL — module not found / function not defined.

- [ ] **Step 3: Implement**

```ts
// JS mirror of buildSegmentPredicate's SQL layout classification (DRD:165-215),
// used to attribute a resolved-cluster survivor (whose layout we read from
// duplicate_records) to a segment in application code.
export type RadarSegment = "marketplace" | "walaplus" | "walaone";

export function classifySegmentFromLayout(
  layout: string | null | undefined,
): RadarSegment {
  const norm = (layout ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (norm.includes("marketplace") || norm.includes("partneraccounts")) {
    return "marketplace";
  }
  if (norm.includes("walaone")) return "walaone";
  return "walaplus"; // includes blank/legacy corporate
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/vitest/duplicateRadarSegment.vitest.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils/duplicateRadarSegment.ts tests/vitest/duplicateRadarSegment.vitest.test.ts
git commit -m "feat(radar): classifySegmentFromLayout JS mirror of segment predicate"
```

---

### Task 4: `shapeCleaningProgress` pure assembler

**Files:**
- Create: `src/utils/dataCleaningProgress.ts`
- Test: `tests/vitest/dataCleaningProgress.vitest.test.ts`

**Interfaces:**
- Consumes: `classifySegmentFromLayout` (Task 3).
- Produces the types + assembler used by Task 5:
```ts
export interface ResolveRowRaw { module: string; survivor_present: boolean; layout: string | null; dup_count: number; }
export interface CleaningProgressModule { outstanding: number; verified_merges: number; est_records_removed: number; empty_deleted: number; }
export interface DataCleaningProgress {
  segment: string; generated_at: string; last_sync_at: string | null;
  modules: { Deals: CleaningProgressModule; Accounts: CleaningProgressModule };
  unknown_segment: { verified_merges: number; est_records_removed: number };
  empty_deleted_all_segments: true;
  trend: { days: number; segment: string; series: any[]; first: any | null; latest: any | null };
}
export function shapeCleaningProgress(input: {
  segment: string; generatedAt: string; lastSyncAt: string | null;
  resolveRows: ResolveRowRaw[];                 // ALL resolve rows for Deals+Accounts
  emptyDeleted: Record<"Deals" | "Accounts", number>;
  outstanding: Record<"Deals" | "Accounts", number>;
  trend: DataCleaningProgress["trend"];
}): DataCleaningProgress;
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { shapeCleaningProgress } from "../../src/utils/dataCleaningProgress";

const base = {
  generatedAt: "2026-07-30T00:00:00.000Z",
  lastSyncAt: "2026-07-29T00:00:00.000Z",
  emptyDeleted: { Deals: 5, Accounts: 2 },
  outstanding: { Deals: 40, Accounts: 10 },
  trend: { days: 30, segment: "walaplus", series: [], first: null, latest: null },
};

describe("shapeCleaningProgress", () => {
  it("counts verified merges + est removed for the selected segment only", () => {
    const out = shapeCleaningProgress({
      ...base,
      segment: "walaplus",
      resolveRows: [
        { module: "Deals", survivor_present: true, layout: "Corporate", dup_count: 2 },
        { module: "Deals", survivor_present: true, layout: "Doam Marketplace", dup_count: 3 }, // excluded (marketplace)
        { module: "Accounts", survivor_present: true, layout: "", dup_count: 1 },              // blank -> walaplus
      ],
    });
    expect(out.modules.Deals.verified_merges).toBe(1);
    expect(out.modules.Deals.est_records_removed).toBe(2);
    expect(out.modules.Accounts.verified_merges).toBe(1);
    expect(out.modules.Accounts.est_records_removed).toBe(1);
    expect(out.modules.Deals.empty_deleted).toBe(5);
    expect(out.modules.Deals.outstanding).toBe(40);
  });

  it("segment 'all' counts every present row and routes survivor-missing to unknown", () => {
    const out = shapeCleaningProgress({
      ...base,
      segment: "all",
      resolveRows: [
        { module: "Deals", survivor_present: true, layout: "Corporate", dup_count: 2 },
        { module: "Deals", survivor_present: false, layout: null, dup_count: 4 }, // unknown
      ],
    });
    expect(out.modules.Deals.verified_merges).toBe(1);      // only the present row
    expect(out.unknown_segment.verified_merges).toBe(1);
    expect(out.unknown_segment.est_records_removed).toBe(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/vitest/dataCleaningProgress.vitest.test.ts`
Expected: FAIL — module/function not defined.

- [ ] **Step 3: Implement**

```ts
import { classifySegmentFromLayout } from "./duplicateRadarSegment";

export interface ResolveRowRaw { module: string; survivor_present: boolean; layout: string | null; dup_count: number; }
export interface CleaningProgressModule { outstanding: number; verified_merges: number; est_records_removed: number; empty_deleted: number; }
export interface DataCleaningProgress {
  segment: string; generated_at: string; last_sync_at: string | null;
  modules: { Deals: CleaningProgressModule; Accounts: CleaningProgressModule };
  unknown_segment: { verified_merges: number; est_records_removed: number };
  empty_deleted_all_segments: true;
  trend: { days: number; segment: string; series: any[]; first: any | null; latest: any | null };
}

export function shapeCleaningProgress(input: {
  segment: string; generatedAt: string; lastSyncAt: string | null;
  resolveRows: ResolveRowRaw[];
  emptyDeleted: Record<"Deals" | "Accounts", number>;
  outstanding: Record<"Deals" | "Accounts", number>;
  trend: DataCleaningProgress["trend"];
}): DataCleaningProgress {
  const mk = (m: "Deals" | "Accounts"): CleaningProgressModule => ({
    outstanding: input.outstanding[m] || 0,
    verified_merges: 0,
    est_records_removed: 0,
    empty_deleted: input.emptyDeleted[m] || 0,
  });
  const modules = { Deals: mk("Deals"), Accounts: mk("Accounts") };
  const unknown = { verified_merges: 0, est_records_removed: 0 };

  for (const row of input.resolveRows) {
    const mod = row.module === "Deals" || row.module === "Accounts" ? row.module : null;
    if (!mod) continue;
    if (!row.survivor_present) {
      unknown.verified_merges += 1;
      unknown.est_records_removed += row.dup_count || 0;
      continue;
    }
    const seg = classifySegmentFromLayout(row.layout);
    if (input.segment !== "all" && seg !== input.segment) continue;
    modules[mod].verified_merges += 1;
    modules[mod].est_records_removed += row.dup_count || 0;
  }

  return {
    segment: input.segment,
    generated_at: input.generatedAt,
    last_sync_at: input.lastSyncAt,
    modules,
    unknown_segment: unknown,
    empty_deleted_all_segments: true,
    trend: input.trend,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/vitest/dataCleaningProgress.vitest.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils/dataCleaningProgress.ts tests/vitest/dataCleaningProgress.vitest.test.ts
git commit -m "feat(radar): shapeCleaningProgress pure assembler + tests"
```

---

### Task 5: `getDataCleaningProgress` DB function + shared resolve-row fetch

**Files:**
- Modify: `src/utils/duplicateRadarDatabase.ts` (add two exported functions near the progress helpers, ~after DRD:2403)
- Test: `tests/vitest/getDataCleaningProgress.vitest.test.ts`

**Interfaces:**
- Consumes: `shapeCleaningProgress`, `ResolveRowRaw`, `DataCleaningProgress` (Task 4); `getDuplicateProgressSeries` (Task 6 adds the `segment` param — until then call with default; final wiring in Task 6).
- Produces:
  - `export async function fetchResolveRowsWithSurvivorSegment(): Promise<ResolveRowRaw[]>` (also used by Task 6's writer).
  - `export async function getDataCleaningProgress(segment: DuplicateFilters["segment"]): Promise<DataCleaningProgress>`

- [ ] **Step 1: Write the failing test (mocked pool)**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const query = vi.fn();
vi.mock("../../src/utils/database", () => ({ pool: { query: (...a: any[]) => query(...a) } }));

import { getDataCleaningProgress } from "../../src/utils/duplicateRadarDatabase";

beforeEach(() => query.mockReset());

describe("getDataCleaningProgress", () => {
  it("only counts action_type='resolve' and returns per-module modules", async () => {
    // Order of pool.query calls inside getDataCleaningProgress:
    // 1) last_sync_at  2) resolve rows  3) empty deleted  4) outstanding Deals  5) outstanding Accounts  6) trend series
    query
      .mockResolvedValueOnce({ rows: [{ last_sync_at: "2026-07-29T00:00:00Z" }] })
      .mockResolvedValueOnce({ rows: [
        { module: "Deals", survivor_present: true, layout: "Corporate", dup_count: 2 },
        { module: "Accounts", survivor_present: true, layout: "WalaOne", dup_count: 1 },
      ] })
      .mockResolvedValueOnce({ rows: [{ module: "Deals", n: "5" }, { module: "Accounts", n: "2" }] })
      .mockResolvedValueOnce({ rows: [{ n: "40" }] })
      .mockResolvedValueOnce({ rows: [{ n: "10" }] })
      .mockResolvedValueOnce({ rows: [] });

    const out = await getDataCleaningProgress("all");
    expect(out.modules.Deals.verified_merges).toBe(1);
    expect(out.modules.Deals.empty_deleted).toBe(5);
    expect(out.modules.Accounts.verified_merges).toBe(1);
    // The resolve-rows query must be gated to action_type='resolve'.
    const resolveSql = query.mock.calls[1][0] as string;
    expect(resolveSql).toContain("action_type = 'resolve'");
    expect(resolveSql).not.toContain("module_resolved");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/vitest/getDataCleaningProgress.vitest.test.ts`
Expected: FAIL — `getDataCleaningProgress` not exported.

- [ ] **Step 3: Implement both functions**

Add near the progress helpers in DRD (import the shaper at top of file: `import { shapeCleaningProgress, type ResolveRowRaw, type DataCleaningProgress } from "./dataCleaningProgress";`):
```ts
/**
 * All VERIFIED duplicate merges (action_type='resolve'), each joined to its
 * surviving record so we can attribute it to a segment by layout. survivor_present
 * distinguishes "blank layout on a real record" (→ walaplus) from "survivor gone"
 * (→ unknown bucket). dup_count = number of dups tagged/removed for that survivor.
 */
export async function fetchResolveRowsWithSurvivorSegment(): Promise<ResolveRowRaw[]> {
  const r = await pool.query(
    `SELECT l.module AS module,
            (r.zoho_record_id IS NOT NULL) AS survivor_present,
            COALESCE(NULLIF(r.layout_name,''), r.raw_data#>>'{Layout,name}',
                     r.raw_data#>>'{$layout,name}', r.raw_data->>'Layout') AS layout,
            COALESCE(jsonb_array_length(NULLIF(l.duplicate_zoho_ids, '[]'::jsonb)), 0) AS dup_count
       FROM duplicate_resolution_ledger l
       LEFT JOIN duplicate_records r ON r.zoho_record_id = l.master_zoho_id
      WHERE l.action_type = 'resolve'
        AND l.module IN ('Deals','Accounts')`,
  );
  return r.rows.map((x: any) => ({
    module: x.module,
    survivor_present: x.survivor_present === true,
    layout: x.layout ?? null,
    dup_count: Number(x.dup_count) || 0,
  }));
}

/** One source of truth for the Cleaning Progress tab, its export, and Adam. */
export async function getDataCleaningProgress(
  segment: DuplicateFilters["segment"],
): Promise<DataCleaningProgress> {
  const seg = segment && segment !== "all" ? segment : "all";
  const sync = await pool.query(
    `SELECT to_char(MAX(last_sync_at), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_sync_at FROM zoho_sync_state`,
  );
  const resolveRows = await fetchResolveRowsWithSurvivorSegment();
  const empty = await pool.query(
    `SELECT module, COUNT(*)::text AS n FROM empty_delete_ledger
      WHERE status = 'deleted' AND module IN ('Deals','Accounts') GROUP BY module`,
  );
  const emptyMap: Record<"Deals" | "Accounts", number> = { Deals: 0, Accounts: 0 };
  for (const row of empty.rows) if (row.module in emptyMap) emptyMap[row.module as "Deals" | "Accounts"] = Number(row.n) || 0;

  const outstanding = { Deals: 0, Accounts: 0 } as Record<"Deals" | "Accounts", number>;
  for (const [mod, rtype] of [["Deals", "deal"], ["Accounts", "account"]] as const) {
    const p = buildSegmentPredicate(seg, 1);
    const segCond = p.condition ? " AND " + p.condition : "";
    const res = await pool.query(
      `SELECT COUNT(*)::text AS n
         FROM duplicate_records r
         JOIN duplicate_clusters dc ON dc.id = r.cluster_id
         LEFT JOIN duplicate_merge_actions ma ON ma.cluster_id = dc.id
        WHERE r.record_type = $${p.params.length + 1}
          AND dc.status = 'active' AND dc.total_${rtype === "deal" ? "deals" : "accounts"} > 1
          AND r.is_primary = false${segCond}`,
      [...p.params, rtype],
    );
    outstanding[mod] = Number(res.rows[0]?.n) || 0;
  }

  const series = await getDuplicateProgressSeries(30, seg);
  const trendModule = "Deals"; // burndown headline module
  const bm = series.byModule[trendModule] || { series: [], latest: null };
  const trend = {
    days: 30, segment: seg, series: bm.series,
    first: bm.series[0] ?? null, latest: bm.latest ?? null,
  };

  return shapeCleaningProgress({
    segment: seg,
    generatedAt: new Date().toISOString(),
    lastSyncAt: sync.rows[0]?.last_sync_at ?? null,
    resolveRows, emptyDeleted: emptyMap, outstanding, trend,
  });
}
```
NOTE: the `getDuplicateProgressSeries(30, seg)` two-arg call requires Task 6. If implementing Task 5 before Task 6, temporarily call `getDuplicateProgressSeries(30)` and add `seg` in Task 6 — but prefer implementing Task 6 first for the reader signature, then this compiles as written.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/vitest/getDataCleaningProgress.vitest.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check + commit**

Run: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → exit 0.
```bash
git add src/utils/duplicateRadarDatabase.ts tests/vitest/getDataCleaningProgress.vitest.test.ts
git commit -m "feat(radar): getDataCleaningProgress + survivor-join verified-merge attribution"
```

---

### Task 6: Segment the burndown writer + reader

**Files:**
- Modify: `src/utils/duplicateRadarDatabase.ts:2268-2330` (`captureDuplicateProgressSnapshot`)
- Modify: `src/utils/duplicateRadarDatabase.ts:2347-2403` (`getDuplicateProgressSeries`)
- Test: `tests/vitest/duplicateProgressSeriesSegment.vitest.test.ts`

**Interfaces:**
- Consumes: `classifySegmentFromLayout` (Task 3), `fetchResolveRowsWithSurvivorSegment` (Task 5).
- Produces: `getDuplicateProgressSeries(days = 30, segment = "all")` — new optional 2nd param; existing 1-arg callers unaffected. Writer now UPSERTs `segment='all'` PLUS `marketplace`/`walaplus`/`walaone` rows per module.

- [ ] **Step 1: Write the failing test (reader honours segment filter)**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
const query = vi.fn();
vi.mock("../../src/utils/database", () => ({ pool: { query: (...a: any[]) => query(...a) } }));
import { getDuplicateProgressSeries } from "../../src/utils/duplicateRadarDatabase";
beforeEach(() => query.mockReset());

describe("getDuplicateProgressSeries segment", () => {
  it("filters by the given segment", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ n: "1" }] })         // today exists
      .mockResolvedValueOnce({ rows: [] });                   // series
    await getDuplicateProgressSeries(30, "walaplus");
    const seriesSql = query.mock.calls[1][0] as string;
    const seriesParams = query.mock.calls[1][1] as any[];
    expect(seriesSql).toContain("segment = ");
    expect(seriesParams).toContain("walaplus");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/vitest/duplicateProgressSeriesSegment.vitest.test.ts`
Expected: FAIL — series query has no `segment =` filter / wrong arity.

- [ ] **Step 3: Update the reader**

Change the signature + the today-check + the series query in `getDuplicateProgressSeries`:
```ts
export async function getDuplicateProgressSeries(days = 30, segment: string = "all"): Promise<{
```
Replace the today-check query (DRD:2365-2367) to be segment-scoped:
```ts
    const todayCheck = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM duplicate_progress_daily
        WHERE snapshot_date = CURRENT_DATE AND segment = $1`,
      [segment],
    );
```
Replace the series query (DRD:2372-2379):
```ts
    const r = await pool.query(
      `SELECT to_char(snapshot_date, 'YYYY-MM-DD') AS date, module,
              open_count, solved_count, total_count, merged_count
         FROM duplicate_progress_daily
        WHERE snapshot_date >= CURRENT_DATE - ($1::int - 1) AND segment = $2
        ORDER BY module, snapshot_date ASC`,
      [lookback, segment],
    );
```

- [ ] **Step 4: Update the writer to emit per-segment rows**

In `captureDuplicateProgressSnapshot`, after computing the all-segments `out` array and BEFORE/around the UPSERT loop, compute per-segment counts and write all four segment rows. Replace the existing single UPSERT loop (DRD:2310-2323) with:
```ts
    // Per-segment merged counts (verified resolves attributed by survivor layout).
    const resolveRows = await fetchResolveRowsWithSurvivorSegment();
    const mergedBySeg: Record<string, Record<string, number>> = {}; // segment -> module -> count
    const bump = (seg: string, mod: string) => {
      (mergedBySeg[seg] ??= {})[mod] = ((mergedBySeg[seg] ??= {})[mod] || 0) + 1;
    };
    for (const row of resolveRows) {
      if (!row.survivor_present) continue; // unknown segment excluded from per-segment trend
      bump(classifySegmentFromLayout(row.layout), row.module);
      bump("all", row.module);
    }

    // open/solved/total per segment via an EXISTS on duplicate_records layout.
    const SEG_LIST = ["all", "marketplace", "walaplus", "walaone"] as const;
    for (const seg of SEG_LIST) {
      const p = buildSegmentPredicate(seg === "all" ? "all" : seg, 1);
      const exists = p.condition
        ? `AND EXISTS (SELECT 1 FROM duplicate_records r
                        WHERE r.cluster_id = dc.id AND ${p.condition})`
        : "";
      const segSelects = PROGRESS_MODULES.map(
        (o) =>
          `COUNT(*) FILTER (WHERE dc.${o.col} > 0 ${exists})::int AS ${o.col}_t,
           COUNT(*) FILTER (WHERE dc.${o.col} > 0 ${exists} AND dc.status = 'active'
                            AND NOT EXISTS (SELECT 1 FROM duplicate_merge_actions ma
                              WHERE ma.cluster_id = dc.id
                                AND ma.action_type IN ('resolve','module_resolved','auto_merge_pending')))::int AS ${o.col}_o`,
      ).join(",\n");
      const sr = await pool.query(`SELECT ${segSelects} FROM duplicate_clusters dc`, p.params);
      const srow = sr.rows[0] || {};
      for (const o of PROGRESS_MODULES) {
        const total = Number(srow[`${o.col}_t`] || 0);
        const open = Number(srow[`${o.col}_o`] || 0);
        const merged = mergedBySeg[seg]?.[o.module] || 0;
        await pool.query(
          `INSERT INTO duplicate_progress_daily
             (snapshot_date, module, segment, open_count, solved_count, total_count, merged_count, created_at)
           VALUES (CURRENT_DATE, $1, $2, $3, $4, $5, $6, NOW())
           ON CONFLICT (snapshot_date, module, segment) DO UPDATE SET
             open_count = EXCLUDED.open_count, solved_count = EXCLUDED.solved_count,
             total_count = EXCLUDED.total_count, merged_count = EXCLUDED.merged_count, created_at = NOW()`,
          [o.module, seg, open, Math.max(0, total - open), total, merged],
        );
      }
    }
```
Remove the now-superseded `lg`/`mergedByModule` block (DRD:2290-2299) and the old per-module UPSERT loop; the `out` return array should still be populated from the `seg === "all"` pass (keep populating `out[i]` when `seg === "all"` so the function's return value is unchanged for existing callers). Add imports at top of DRD: `import { classifySegmentFromLayout } from "./duplicateRadarSegment";`.

- [ ] **Step 5: Run tests + type-check**

Run: `npx vitest run tests/vitest/duplicateProgressSeriesSegment.vitest.test.ts` → PASS.
Run: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/utils/duplicateRadarDatabase.ts tests/vitest/duplicateProgressSeriesSegment.vitest.test.ts
git commit -m "feat(radar): per-segment burndown snapshots + segment-filtered reader"
```

---

### Task 7: Endpoint + RBAC allowlist

**Files:**
- Modify: `src/mastra/routes/duplicateRadarRoutes.ts` (add a route object to the exported array)
- Modify: `src/utils/rbacMiddleware.ts` (add allowlist pattern)
- Test: `tests/vitest/cleaningProgressRoute.vitest.test.ts` (light — asserts handler shape)

**Interfaces:**
- Consumes: `getDataCleaningProgress` (Task 5).
- Produces: `GET /api/duplicates/cleaning-progress?segment=` → `{ success: true, ...DataCleaningProgress }`.

- [ ] **Step 1: Add the route** (mirror the CS-lifecycle route at duplicateRadarRoutes.ts:7862-7895)

```ts
  {
    path: "/api/duplicates/cleaning-progress",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireDuplicateRadarAccess(c);
          if (!user) return unauthorizedResponse(c);
          const segment = new URL(c.req.url).searchParams.get("segment") || "all";
          const { getDataCleaningProgress } = await import("../../utils/duplicateRadarDatabase");
          const result = await getDataCleaningProgress(segment as any);
          return c.json({ success: true, ...result });
        } catch (error: any) {
          logger.error("Error building cleaning-progress report:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
```

- [ ] **Step 2: Add the RBAC allowlist entry** (mirror the openai-health pattern added at a2191f02)

In `src/utils/rbacMiddleware.ts`, alongside the other `/api/duplicates/...` patterns:
```ts
    { pattern: /^\/api\/duplicates\/cleaning-progress$/, methods: ["GET"],
      roles: ["admin","ai_specialist","auditor","bu_owner","custom","department_viewer","executive","grc_manager","head_of_operations_quality","quality_manager","quality_specialist","team_lead"] },
```
(Match the exact role list used by the sibling `/api/duplicates/*` read routes in that file — copy from the nearest existing duplicates GET rule if it differs.)

- [ ] **Step 3: Type-check**

Run: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/mastra/routes/duplicateRadarRoutes.ts src/utils/rbacMiddleware.ts
git commit -m "feat(radar): GET /api/duplicates/cleaning-progress + RBAC allowlist"
```

---

### Task 8: Dashboard "Cleaning Progress" tab

**Files:**
- Modify: `dashboard/duplicates.html` (tab registration in the tab list ~line 904-947; tab content section; `?v=` bump ~line 2359)
- Modify: `dashboard/js/duplicates-app.js` (tab switch handler ~line 127-134 + 7352; `loadCleaningProgress` + `renderCleaningProgress` + CSV export)

**Interfaces:**
- Consumes: `GET /api/duplicates/cleaning-progress?segment=`.
- Produces: a new tab `cleaning-progress` that obeys `#filterSegment` and renders KPI cards + trend + explanations + export.

- [ ] **Step 1: Register the tab** — add to the tab-definitions array (near duplicates-app.js:904):
```js
{ key: 'cleaningProgress', label: 'Cleaning Progress', icon: '🧹', tab: 'cleaning-progress', desc: 'Verified data-cleaning results for Deals & Accounts.' },
```
And in the tab-switch dispatcher (near :127 and :7352) add:
```js
} else if (activeTab === 'cleaning-progress') { await loadCleaningProgress(getActiveSegment()); }
```
(Use the same segment-read helper the CS-Lifecycle tab uses: read `#filterSegment` value, default 'all'.)

- [ ] **Step 2: Add the tab content markup** in `duplicates.html` (mirror `#content-cs-lifecycle` structure): a note banner, a segment-aware KPI grid with element ids `cpDealsOutstanding`, `cpDealsMerges`, `cpDealsRemoved`, `cpAcctOutstanding`, `cpAcctMerges`, `cpAcctRemoved`, `cpEmptyDeleted`, a `#cpTrend` container, a `#cpExplain` panel, and an Export button `data-on-click="exportCleaningProgress"`. All cards use `rr-kpi rr-kpi-rich` + valid `rr-acc-*` accents. No inline `style=""` (CSP strips it) — use classes.

- [ ] **Step 3: Implement `loadCleaningProgress` + `renderCleaningProgress`**:
```js
async function loadCleaningProgress(segment) {
  const seg = segment || 'all';
  let url = '/api/duplicates/cleaning-progress';
  if (seg && seg !== 'all') url += '?segment=' + encodeURIComponent(seg);
  const host = document.getElementById('cpTrend');
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    renderCleaningProgress(await res.json());
  } catch (e) {
    if (host) host.innerHTML = '<div class="text-sm text-red-600">Failed to load: ' + escapeHtml(String(e.message || e)) + '</div>';
  }
}
function renderCleaningProgress(d) {
  const m = d.modules || {};
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = (v == null ? 0 : v); };
  set('cpDealsOutstanding', m.Deals?.outstanding); set('cpDealsMerges', m.Deals?.verified_merges); set('cpDealsRemoved', m.Deals?.est_records_removed);
  set('cpAcctOutstanding', m.Accounts?.outstanding); set('cpAcctMerges', m.Accounts?.verified_merges); set('cpAcctRemoved', m.Accounts?.est_records_removed);
  set('cpEmptyDeleted', (m.Deals?.empty_deleted || 0) + (m.Accounts?.empty_deleted || 0));
  // Explanations (plain language + honesty footnotes)
  const ex = document.getElementById('cpExplain');
  if (ex) ex.innerHTML = [
    '<p><strong>Verified merges</strong> = duplicate clusters confirmed merged in Zoho (survivor kept, dups deleted).</p>',
    '<p><strong>Empty/messy records deleted</strong> = records verified removed from Zoho. Shown for <em>all layouts</em> (deletion records carry no layout).</p>',
    '<p><strong>Est. records removed</strong> may undercount cleanup done before per-record tracking existed.</p>',
    d.unknown_segment && (d.unknown_segment.verified_merges > 0)
      ? '<p class="text-gray-500">' + d.unknown_segment.verified_merges + ' verified merges could not be attributed to a layout (survivor record no longer present).</p>' : '',
  ].join('');
  renderCleaningTrend(d.trend); // simple inline SVG/bars from d.trend.series (open vs solved). Empty-state: "trend starts building today for this segment".
  window._cleaningProgressData = d;
}
```
(Provide `renderCleaningTrend` as a minimal bar/line from `trend.series`; if `series.length < 2`, show the empty-state text.)

- [ ] **Step 4: CSV export**:
```js
function exportCleaningProgress() {
  const d = window._cleaningProgressData; if (!d) { rrToast('Nothing to export yet.'); return; }
  const headers = ['Module','Outstanding','Verified merges','Est. records removed','Empty/messy deleted (all layouts)'];
  const rows = ['Deals','Accounts'].map(k => [k, d.modules[k].outstanding, d.modules[k].verified_merges, d.modules[k].est_records_removed, d.modules[k].empty_deleted]);
  downloadCsvRows('data-cleaning-progress-' + (d.segment || 'all') + '.csv', headers, rows);
}
```

- [ ] **Step 5: Bump cache-buster** — `dashboard/duplicates.html`: `js/duplicates-app.js?v=138` → `?v=139`.

- [ ] **Step 6: Verify + commit**

Run: `node --check dashboard/js/duplicates-app.js` → prints `JS-SYNTAX-OK` (add the echo) / no error.
Manual: republish, open the tab, switch segment chips, confirm numbers change and Export downloads.
```bash
git add dashboard/duplicates.html dashboard/js/duplicates-app.js
git commit -m "feat(radar): Cleaning Progress tab (KPI + trend + export, segment-aware)"
```

---

### Task 9: Adam `cleaningProgressTool`

**Files:**
- Modify: `src/mastra/tools/radarTabTools.ts` (add tool) OR create `src/mastra/tools/cleaningProgressTool.ts`
- Modify: `src/mastra/agents/qmsConsultantAgent.ts` (register the tool in the tools map — NO backticks in the prompt template literal)

**Interfaces:**
- Consumes: `getDataCleaningProgress` (Task 5).
- Produces: tool id `cleaning-progress-status` returning `{ success, segment, deals, accounts, emptyDeletedAllSegments, note }`.

- [ ] **Step 1: Implement the tool** (mirror `csLifecycleStatusTool.ts`):
```ts
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const cleaningProgressTool = createTool({
  id: "cleaning-progress-status",
  description:
    "Data Cleaning Progress for Deals & Accounts — verified duplicate merges and verified empty-record deletions, plus how many duplicates are still outstanding, filterable by segment (all/marketplace/walaplus/walaone). Use for 'how much data have we cleaned', cleanup reports, or WalaPlus Deals/Accounts progress.",
  inputSchema: z.object({ segment: z.enum(["all","marketplace","walaplus","walaone"]).optional() }),
  outputSchema: z.object({
    success: z.boolean(),
    segment: z.string(),
    deals: z.object({ outstanding: z.number(), verifiedMerges: z.number(), estRecordsRemoved: z.number(), emptyDeleted: z.number() }),
    accounts: z.object({ outstanding: z.number(), verifiedMerges: z.number(), estRecordsRemoved: z.number(), emptyDeleted: z.number() }),
    note: z.string(),
    error: z.string().optional(),
  }),
  execute: async ({ context }) => {
    try {
      const { getDataCleaningProgress } = await import("../../utils/duplicateRadarDatabase");
      const d = await getDataCleaningProgress((context?.segment as any) || "all");
      const M = (x: any) => ({ outstanding: x.outstanding, verifiedMerges: x.verified_merges, estRecordsRemoved: x.est_records_removed, emptyDeleted: x.empty_deleted });
      return { success: true, segment: d.segment, deals: M(d.modules.Deals), accounts: M(d.modules.Accounts),
        note: "Verified merges + verified Zoho deletions only; tagged-not-deleted excluded. Empty deletions are all-layers. Est. removed may undercount pre-tracking cleanup." };
    } catch (e: any) {
      return { success: false, segment: "all", deals: { outstanding: 0, verifiedMerges: 0, estRecordsRemoved: 0, emptyDeleted: 0 }, accounts: { outstanding: 0, verifiedMerges: 0, estRecordsRemoved: 0, emptyDeleted: 0 }, note: "", error: e?.message || String(e) };
    }
  },
});
```

- [ ] **Step 2: Register the tool** in `qmsConsultantAgent.ts` tools map (find the existing `csLifecycleStatusTool` registration and add `cleaningProgressTool` beside it, importing it the same way). Do NOT add backticks anywhere in the prompt template literal.

- [ ] **Step 3: Type-check + commit**

Run: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → exit 0.
```bash
git add src/mastra/tools/*.ts src/mastra/agents/qmsConsultantAgent.ts
git commit -m "feat(adam): cleaningProgressTool reads the reconciled cleanup report"
```

---

### Task 10: Ship

- [ ] **Step 1:** `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (exit 0), `node scripts/check-schema-parity.mjs` (PASS), run all new vitest files.
- [ ] **Step 2:** `git pull --rebase --autostash origin QMS` then `git push origin QMS`.
- [ ] **Step 3:** Tell the user: Pull → Republish on Replit; then run the Task 1 invariant SQL and eyeball the new tab per segment.

## Self-Review notes

- **Spec §2 (trust fix)** → Task 1. **§3 sources** → Task 5 (resolve `resolve`-only + empty `deleted`), exclusions enforced in `fetchResolveRowsWithSurvivorSegment` WHERE + test. **§4 schema** → Task 2. **§4 writer/reader forward-segmentation** → Task 6. **§5 survivor-join** → Task 5 + Task 3 (classify) + Task 4 (unknown bucket). **§6 endpoint/RBAC** → Task 7. **§7 UI** → Task 8. **§8 Adam** → Task 9. **§9 limits** surfaced in Task 8 `cpExplain` + Task 9 `note`. **§10 testing** → Tasks 3-6 vitest. **§11 deploy** → Task 10.
- **Type consistency:** `DataCleaningProgress` / `ResolveRowRaw` / `CleaningProgressModule` defined in Task 4, consumed unchanged in Tasks 5/7/9. `classifySegmentFromLayout` (Task 3) used in Tasks 4 & 6. `getDuplicateProgressSeries(days, segment)` new arity (Task 6) consumed in Task 5 — implement Task 6 before/with Task 5's series call (noted in Task 5 Step 3).
- **No silent caps:** survivor-missing → `unknown_segment` (surfaced in UI); empty-deleted all-segments flagged.
