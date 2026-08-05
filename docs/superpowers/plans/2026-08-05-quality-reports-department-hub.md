# Quality Reports — Department Hub (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a "Quality Reports" hub under Quality — a grid of 9 business-unit boxes, each opening a page that assembles SOPs, KPIs, cleanup/compliance, and open actions for that BU from existing engines via an admin-editable registry.

**Architecture:** A dedicated registry (`quality_report_bus` + `quality_report_bu_owners`) seeded with the 9 BUs; a per-BU aggregator that calls existing report functions scoped by the BU's segment (channel-derived) and owner set; thin routes + a hub/BU page + an admin screen. No new report engines — only aggregation.

**Tech Stack:** TypeScript, Postgres via `pool` (pg), Hono routes (`{path, method, createHandler}` arrays), vanilla-JS dashboard, Vitest (type-checked locally; executed in CI).

## Global Constraints

- The 9 BUs are exactly: SDR (B2B), Sales (B2B), Customer Success (B2B), SDR (B2C), Sales (B2C), Customer Success (B2C), Partnership (MP), Onboarding (MP), PartnerSuccess (MP).
- Channel→segment is FIXED: `B2B→walaplus`, `B2C→walaone`, `MP→marketplace`. Never let the admin set segment independently of channel.
- Function→reports: `sdr→Leads`; `sales→Deals cleanup + Deal compliance + Stage aging`; `cs`/`partnersuccess→CS Lifecycle`; `partnership→Leads + Deals`; `onboarding→CS Lifecycle (Onboarding phase) + Deals`.
- Reuse existing engines; do NOT reimplement report logic.
- A missing mapping (`policy_department`/`kpi_bu_name`/no owners = NULL/empty) renders a "not configured" state, never an error. `getBUReport` is best-effort per section — one section failing must not 500 the page.
- No DROP TABLE. Every `ALTER ADD COLUMN` also appears in the canonical `CREATE TABLE` (schema-parity strict).
- Email-to-heads is OUT OF SCOPE (Phase 3). `head_email` is stored but unused.
- Verify commands: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (the global `tsc` stub is wrong); `node node_modules/typescript/bin/tsc -p tsconfig.tests.json`; `node scripts/check-schema-parity.mjs --strict`; `node scripts/check-dashboard-html-js.mjs`; `node --check <file.js>`.
- **vitest CANNOT run locally** (no `vite`). Verify pure functions by compiling to CJS and running with node: `node node_modules/typescript/bin/tsc <files> --outDir _out --module commonjs --moduleResolution node --target es2022 --skipLibCheck --rootDir src/utils && echo '{"type":"commonjs"}' > _out/package.json && node -e '...require("./_out/..").fn()...' && rm -rf _out`. Still WRITE the vitest test files (they run in CI + type-check via tsconfig.tests.json).
- `DRD` = `src/utils/duplicateRadarDatabase.ts`.
- Deploy: commit only touched files; push `origin/QMS`; bump any changed dashboard JS `?v=`; user Pulls → Republishes. Tables auto-create in the idempotent init path on boot.

---

### Task 1: Registry tables + seed + `channelToSegment` helper

**Files:**
- Create: `src/utils/qualityReportsDepartments.ts`
- Test: `tests/vitest/qualityReportsDepartments.vitest.test.ts`

**Interfaces:**
- Produces:
  - `type Channel = "B2B" | "B2C" | "MP"`
  - `type Segment = "walaplus" | "walaone" | "marketplace"`
  - `function channelToSegment(ch: Channel): Segment`
  - `interface QualityReportBUSeed { bu_key: string; bu_name: string; channel: Channel; fn: string; sort_order: number }`
  - `const SEED_BUS: QualityReportBUSeed[]` (the 9)
  - `async function ensureQualityReportTables(): Promise<void>` (idempotent CREATE + seed)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { channelToSegment, SEED_BUS } from "../../src/utils/qualityReportsDepartments";

describe("channelToSegment", () => {
  it("maps channel to the fixed segment", () => {
    expect(channelToSegment("B2B")).toBe("walaplus");
    expect(channelToSegment("B2C")).toBe("walaone");
    expect(channelToSegment("MP")).toBe("marketplace");
  });
});
describe("SEED_BUS", () => {
  it("has the 9 canonical BUs with unique keys and valid channels", () => {
    expect(SEED_BUS).toHaveLength(9);
    const keys = SEED_BUS.map((b) => b.bu_key);
    expect(new Set(keys).size).toBe(9);
    for (const b of SEED_BUS) expect(["B2B", "B2C", "MP"]).toContain(b.channel);
    expect(SEED_BUS.map((b) => b.bu_name)).toContain("Partnership (MP)");
    expect(SEED_BUS.map((b) => b.fn)).toContain("partnersuccess");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.tests.json` (module not found) — vitest can't run; this confirms the test references a not-yet-existing module.
Expected: compile error "Cannot find module qualityReportsDepartments".

- [ ] **Step 3: Implement the module (tables + seed + helper)**

```ts
import { pool } from "./redactedPool";
import { logger } from "./logger";

export type Channel = "B2B" | "B2C" | "MP";
export type Segment = "walaplus" | "walaone" | "marketplace";

export function channelToSegment(ch: Channel): Segment {
  if (ch === "B2C") return "walaone";
  if (ch === "MP") return "marketplace";
  return "walaplus"; // B2B
}

export interface QualityReportBUSeed {
  bu_key: string;
  bu_name: string;
  channel: Channel;
  fn: string;
  sort_order: number;
}

export const SEED_BUS: QualityReportBUSeed[] = [
  { bu_key: "sdr_b2b", bu_name: "SDR (B2B)", channel: "B2B", fn: "sdr", sort_order: 1 },
  { bu_key: "sales_b2b", bu_name: "Sales (B2B)", channel: "B2B", fn: "sales", sort_order: 2 },
  { bu_key: "cs_b2b", bu_name: "Customer Success (B2B)", channel: "B2B", fn: "cs", sort_order: 3 },
  { bu_key: "sdr_b2c", bu_name: "SDR (B2C)", channel: "B2C", fn: "sdr", sort_order: 4 },
  { bu_key: "sales_b2c", bu_name: "Sales (B2C)", channel: "B2C", fn: "sales", sort_order: 5 },
  { bu_key: "cs_b2c", bu_name: "Customer Success (B2C)", channel: "B2C", fn: "cs", sort_order: 6 },
  { bu_key: "partnership_mp", bu_name: "Partnership (MP)", channel: "MP", fn: "partnership", sort_order: 7 },
  { bu_key: "onboarding_mp", bu_name: "Onboarding (MP)", channel: "MP", fn: "onboarding", sort_order: 8 },
  { bu_key: "partnersuccess_mp", bu_name: "PartnerSuccess (MP)", channel: "MP", fn: "partnersuccess", sort_order: 9 },
];

let tablesReady = false;

export async function ensureQualityReportTables(): Promise<void> {
  if (tablesReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quality_report_bus (
      id                SERIAL PRIMARY KEY,
      bu_key            VARCHAR(40) NOT NULL UNIQUE,
      bu_name           VARCHAR(80) NOT NULL,
      channel           VARCHAR(8)  NOT NULL,
      segment           VARCHAR(16) NOT NULL,
      fn                VARCHAR(24) NOT NULL,
      head_email        VARCHAR(200),
      policy_department VARCHAR(100),
      kpi_bu_name       VARCHAR(80),
      sort_order        INTEGER NOT NULL DEFAULT 0,
      is_active         BOOLEAN NOT NULL DEFAULT TRUE,
      created_at        TIMESTAMP DEFAULT NOW(),
      updated_at        TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quality_report_bu_owners (
      id          SERIAL PRIMARY KEY,
      bu_id       INTEGER NOT NULL REFERENCES quality_report_bus(id) ON DELETE CASCADE,
      owner_email VARCHAR(200) NOT NULL,
      UNIQUE (bu_id, owner_email)
    )
  `);
  // Idempotent seed: insert the 9 canonical BUs; never overwrite admin edits.
  for (const b of SEED_BUS) {
    await pool.query(
      `INSERT INTO quality_report_bus (bu_key, bu_name, channel, segment, fn, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (bu_key) DO NOTHING`,
      [b.bu_key, b.bu_name, b.channel, channelToSegment(b.channel), b.fn, b.sort_order],
    );
  }
  tablesReady = true;
  logger.info("[QualityReports] tables ensured + seeded");
}
```

- [ ] **Step 4: Verify types + run the pure test via node**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.tests.json` → exit 0.
Run (execute the pure logic):
```bash
node node_modules/typescript/bin/tsc src/utils/qualityReportsDepartments.ts --outDir _qr --module commonjs --moduleResolution node --target es2022 --skipLibCheck --rootDir src/utils >/dev/null 2>&1; echo '{"type":"commonjs"}' > _qr/package.json; node -e 'const m=require("./_qr/qualityReportsDepartments.js"); console.log(m.channelToSegment("B2B")==="walaplus" && m.channelToSegment("MP")==="marketplace" && m.SEED_BUS.length===9 ? "PASS":"FAIL")'; rm -rf _qr
```
Expected: `PASS`.
(Note: this file imports `./redactedPool`/`./logger`; the CJS-emit + `require` resolves them since it compiles the single file with `--module commonjs`. If the require pulls a DB connection at import time and hangs, instead verify by asserting only `channelToSegment`/`SEED_BUS` via a re-export test file that imports nothing DB — but `pool`/`logger` are lazy, so direct require is fine.)

- [ ] **Step 5: Commit**

```bash
git add src/utils/qualityReportsDepartments.ts tests/vitest/qualityReportsDepartments.vitest.test.ts
git commit -m "feat(quality-reports): registry tables + 9-BU seed + channelToSegment"
```

---

### Task 2: Registry CRUD

**Files:**
- Modify: `src/utils/qualityReportsDepartments.ts`
- Test: `tests/vitest/qualityReportsDepartmentsCrud.vitest.test.ts`

**Interfaces:**
- Consumes: `ensureQualityReportTables`, `channelToSegment`, `Channel` (Task 1).
- Produces:
  - `interface QualityReportBU { id: number; bu_key: string; bu_name: string; channel: Channel; segment: Segment; fn: string; head_email: string | null; policy_department: string | null; kpi_bu_name: string | null; sort_order: number; is_active: boolean; owners: string[] }`
  - `async function listBUs(): Promise<QualityReportBU[]>`
  - `async function getBUByKey(buKey: string): Promise<QualityReportBU | null>`
  - `async function upsertBU(input: { bu_key: string; bu_name: string; channel: Channel; fn: string; head_email?: string | null; policy_department?: string | null; kpi_bu_name?: string | null; sort_order?: number; is_active?: boolean }): Promise<QualityReportBU>`
  - `async function deleteBU(id: number): Promise<void>`
  - `async function setBUOwners(buId: number, emails: string[]): Promise<void>`

- [ ] **Step 1: Write the failing test (mock pool via redactedPool)**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../src/utils/redactedPool", () => ({
  createRedactedPool: () => ({ query: (...a: any[]) => query(...a), connect: async () => ({ query: (...a: any[]) => query(...a), release: () => {} }) }),
}));
vi.mock("../../src/utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import { upsertBU } from "../../src/utils/qualityReportsDepartments";
beforeEach(() => query.mockReset());

describe("upsertBU", () => {
  it("derives segment from channel and never trusts a caller-supplied segment", async () => {
    query.mockResolvedValue({ rows: [{ id: 1, bu_key: "x", bu_name: "X", channel: "MP", segment: "marketplace", fn: "partnership", sort_order: 0, is_active: true }] });
    await upsertBU({ bu_key: "x", bu_name: "X", channel: "MP", fn: "partnership" });
    const sql = String(query.mock.calls[0][0]);
    const params = query.mock.calls[0][1];
    expect(sql).toContain("quality_report_bus");
    // 'marketplace' (derived from MP) must be among the bound params.
    expect(params).toContain("marketplace");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.tests.json`
Expected: compile error — `upsertBU` not exported.

- [ ] **Step 3: Implement CRUD (append to qualityReportsDepartments.ts)**

```ts
export interface QualityReportBU {
  id: number; bu_key: string; bu_name: string; channel: Channel; segment: Segment;
  fn: string; head_email: string | null; policy_department: string | null;
  kpi_bu_name: string | null; sort_order: number; is_active: boolean; owners: string[];
}

async function ownersFor(buIds: number[]): Promise<Map<number, string[]>> {
  const map = new Map<number, string[]>();
  if (!buIds.length) return map;
  const r = await pool.query(
    `SELECT bu_id, owner_email FROM quality_report_bu_owners WHERE bu_id = ANY($1::int[])`,
    [buIds],
  );
  for (const row of r.rows) {
    const list = map.get(row.bu_id) || [];
    list.push(row.owner_email);
    map.set(row.bu_id, list);
  }
  return map;
}

function rowToBU(row: any, owners: string[]): QualityReportBU {
  return {
    id: row.id, bu_key: row.bu_key, bu_name: row.bu_name, channel: row.channel,
    segment: row.segment, fn: row.fn, head_email: row.head_email ?? null,
    policy_department: row.policy_department ?? null, kpi_bu_name: row.kpi_bu_name ?? null,
    sort_order: Number(row.sort_order) || 0, is_active: row.is_active !== false, owners,
  };
}

export async function listBUs(): Promise<QualityReportBU[]> {
  await ensureQualityReportTables();
  const r = await pool.query(`SELECT * FROM quality_report_bus ORDER BY sort_order ASC, id ASC`);
  const owners = await ownersFor(r.rows.map((x) => x.id));
  return r.rows.map((row) => rowToBU(row, owners.get(row.id) || []));
}

export async function getBUByKey(buKey: string): Promise<QualityReportBU | null> {
  await ensureQualityReportTables();
  const r = await pool.query(`SELECT * FROM quality_report_bus WHERE bu_key = $1 LIMIT 1`, [buKey]);
  if (!r.rows[0]) return null;
  const owners = await ownersFor([r.rows[0].id]);
  return rowToBU(r.rows[0], owners.get(r.rows[0].id) || []);
}

export async function upsertBU(input: {
  bu_key: string; bu_name: string; channel: Channel; fn: string;
  head_email?: string | null; policy_department?: string | null;
  kpi_bu_name?: string | null; sort_order?: number; is_active?: boolean;
}): Promise<QualityReportBU> {
  await ensureQualityReportTables();
  const segment = channelToSegment(input.channel); // ALWAYS derived
  const r = await pool.query(
    `INSERT INTO quality_report_bus
       (bu_key, bu_name, channel, segment, fn, head_email, policy_department, kpi_bu_name, sort_order, is_active, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10,true),NOW())
     ON CONFLICT (bu_key) DO UPDATE SET
       bu_name=EXCLUDED.bu_name, channel=EXCLUDED.channel, segment=EXCLUDED.segment,
       fn=EXCLUDED.fn, head_email=EXCLUDED.head_email, policy_department=EXCLUDED.policy_department,
       kpi_bu_name=EXCLUDED.kpi_bu_name, sort_order=EXCLUDED.sort_order,
       is_active=EXCLUDED.is_active, updated_at=NOW()
     RETURNING *`,
    [input.bu_key, input.bu_name, input.channel, segment, input.fn,
     input.head_email ?? null, input.policy_department ?? null, input.kpi_bu_name ?? null,
     input.sort_order ?? 0, input.is_active ?? true],
  );
  const owners = await ownersFor([r.rows[0].id]);
  return rowToBU(r.rows[0], owners.get(r.rows[0].id) || []);
}

export async function deleteBU(id: number): Promise<void> {
  await ensureQualityReportTables();
  await pool.query(`DELETE FROM quality_report_bus WHERE id = $1`, [id]);
}

export async function setBUOwners(buId: number, emails: string[]): Promise<void> {
  await ensureQualityReportTables();
  const clean = Array.from(new Set(
    (emails || []).map((e) => String(e || "").trim().toLowerCase()).filter(Boolean),
  ));
  await pool.query(`DELETE FROM quality_report_bu_owners WHERE bu_id = $1`, [buId]);
  for (const email of clean) {
    await pool.query(
      `INSERT INTO quality_report_bu_owners (bu_id, owner_email) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [buId, email],
    );
  }
}
```

- [ ] **Step 4: Verify**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.tests.json` → exit 0.
Run: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/utils/qualityReportsDepartments.ts tests/vitest/qualityReportsDepartmentsCrud.vitest.test.ts
git commit -m "feat(quality-reports): registry CRUD (list/get/upsert/delete/owners)"
```

---

### Task 3: Per-BU aggregator `getBUReport`

**Files:**
- Create: `src/utils/qualityReportsAggregator.ts`
- Test: `tests/vitest/qualityReportsAggregator.vitest.test.ts`

**Interfaces:**
- Consumes: `getBUByKey`, `QualityReportBU` (Task 2); existing engines (read them before calling): `getDataCleaningProgress(segment)` (DRD:2488, returns `DataCleaningProgress`), `scanCsLifecycleViolations({segment})` (DRD:11555, returns `{summary, violations}`), `scanDealStageAgingViolations({segment})` (DRD:11745), `getAllPolicies({owner_department})` (`policyDatabase.ts:413`), `getFrameworkProgressByBU()` (`kpiChecklistDatabase.ts:704`, returns `Record<buName,{done,total,pct}>`), `getCapaRecords({status})` (`qmsDatabase.ts:577`, returns `{records, total}`; each record has `assigned_to`), `getOwnerAccountability()` (DRD:7448).
- Produces:
  - `function functionReportKeys(fn: string): string[]` (pure — which report keys a function shows)
  - `interface BUReport { bu: QualityReportBU; sections: { sops: any; kpis: any; cleanup: any; compliance: any; actions: any }; notConfigured: string[] }`
  - `async function getBUReport(buKey: string): Promise<BUReport | null>`

- [ ] **Step 1: Write the failing test (pure functionReportKeys)**

```ts
import { describe, it, expect } from "vitest";
import { functionReportKeys } from "../../src/utils/qualityReportsAggregator";

describe("functionReportKeys", () => {
  it("maps each function to its report set", () => {
    expect(functionReportKeys("sdr")).toEqual(["leads"]);
    expect(functionReportKeys("sales")).toEqual(["deals", "deal_compliance", "stage_aging"]);
    expect(functionReportKeys("cs")).toEqual(["cs_lifecycle"]);
    expect(functionReportKeys("partnersuccess")).toEqual(["cs_lifecycle"]);
    expect(functionReportKeys("partnership")).toEqual(["leads", "deals"]);
    expect(functionReportKeys("onboarding")).toEqual(["cs_lifecycle_onboarding", "deals"]);
    expect(functionReportKeys("unknown")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.tests.json`
Expected: `functionReportKeys` not found.

- [ ] **Step 3: Implement the aggregator**

```ts
import { getBUByKey, type QualityReportBU } from "./qualityReportsDepartments";
import { logger } from "./logger";

export function functionReportKeys(fn: string): string[] {
  switch (fn) {
    case "sdr": return ["leads"];
    case "sales": return ["deals", "deal_compliance", "stage_aging"];
    case "cs":
    case "partnersuccess": return ["cs_lifecycle"];
    case "partnership": return ["leads", "deals"];
    case "onboarding": return ["cs_lifecycle_onboarding", "deals"];
    default: return [];
  }
}

export interface BUReport {
  bu: QualityReportBU;
  sections: { sops: any; kpis: any; cleanup: any; compliance: any; actions: any };
  notConfigured: string[];
}

// Best-effort runner: never let one section throw the whole page. Records the
// section name in notConfigured when it's unmapped or errors.
async function section<T>(
  name: string, enabled: boolean, run: () => Promise<T>, notConfigured: string[],
): Promise<T | null> {
  if (!enabled) { notConfigured.push(name); return null; }
  try { return await run(); }
  catch (e) { logger.warn(`[QualityReports] section ${name} failed`, { error: e instanceof Error ? e.message : String(e) }); notConfigured.push(name); return null; }
}

export async function getBUReport(buKey: string): Promise<BUReport | null> {
  const bu = await getBUByKey(buKey);
  if (!bu) return null;
  const notConfigured: string[] = [];
  const keys = functionReportKeys(bu.fn);

  // Lazy imports keep the module graph light + avoid load-time cycles.
  const DRD = await import("./duplicateRadarDatabase");
  const policyDb = await import("./policyDatabase");
  const kpiDb = await import("./kpiChecklistDatabase");
  const qmsDb = await import("./qmsDatabase");

  const sops = await section("sops", !!bu.policy_department, async () => {
    const res = await policyDb.getAllPolicies({ owner_department: bu.policy_department as string } as any);
    return res;
  }, notConfigured);

  const kpis = await section("kpis", !!bu.kpi_bu_name, async () => {
    const all = await kpiDb.getFrameworkProgressByBU();
    return all[bu.kpi_bu_name as string] || { done: 0, total: 0, pct: 0 };
  }, notConfigured);

  const cleanup = await section("cleanup", keys.some((k) => k === "deals" || k === "leads"), async () => {
    const out: any = {};
    if (keys.includes("deals")) out.deals = await DRD.getDataCleaningProgress(bu.segment as any);
    if (keys.includes("leads")) {
      // Lead duplicates in this segment: non-primary lead members of active dup clusters.
      // Reuse buildSegmentPredicate; count via a light query wrapper if one exists,
      // else compute inline (implementer: mirror the outstanding-count query in
      // getDataCleaningProgress, record_type='lead').
      out.leads = await DRD.getSegmentLeadDuplicateCount(bu.segment as any);
    }
    return out;
  }, notConfigured);

  const compliance = await section("compliance", keys.some((k) => k.startsWith("cs_lifecycle") || k === "deal_compliance" || k === "stage_aging"), async () => {
    const out: any = {};
    if (keys.includes("cs_lifecycle") || keys.includes("cs_lifecycle_onboarding")) {
      out.cs = await DRD.scanCsLifecycleViolations({ segment: bu.segment as any });
      if (keys.includes("cs_lifecycle_onboarding")) out.phaseFocus = "Onboarding";
    }
    if (keys.includes("stage_aging")) out.stageAging = await DRD.scanDealStageAgingViolations({ segment: bu.segment as any });
    return out;
  }, notConfigured);

  const actions = await section("actions", bu.owners.length > 0, async () => {
    const owners = new Set(bu.owners.map((o) => o.toLowerCase()));
    const capaRes = await qmsDb.getCapaRecords({ status: "open" });
    const capas = (capaRes.records || []).filter((r: any) =>
      r.assigned_to && owners.has(String(r.assigned_to).toLowerCase()));
    const acct = await DRD.getOwnerAccountability();
    const ownerRows = (acct || []).filter((a: any) =>
      a.owner_email && owners.has(String(a.owner_email).toLowerCase()));
    return { openCapas: capas.length, capas, ownerAccountability: ownerRows };
  }, notConfigured);

  return { bu, sections: { sops, kpis, cleanup, compliance, actions }, notConfigured };
}
```

- [ ] **Step 4: Add the missing `getSegmentLeadDuplicateCount` helper to DRD**

In `src/utils/duplicateRadarDatabase.ts`, add (mirror the outstanding-count query pattern used in `getDataCleaningProgress`, but `record_type='lead'` and `total_leads>1`):
```ts
export async function getSegmentLeadDuplicateCount(
  segment: DuplicateFilters["segment"],
): Promise<{ segment: string; outstanding_leads: number }> {
  const seg = segment && segment !== "all" ? (segment === "corporate" ? "walaplus" : segment) : "all";
  const p = buildSegmentPredicate(seg, 1);
  const segCond = p.condition ? " AND " + p.condition : "";
  const res = await pool.query(
    `SELECT COUNT(*)::text AS n
       FROM duplicate_records r
       JOIN duplicate_clusters dc ON dc.id = r.cluster_id
      WHERE r.record_type = 'lead' AND dc.status = 'active'
        AND dc.total_leads > 1 AND r.is_primary = false${segCond}`,
    [...p.params],
  );
  return { segment: seg, outstanding_leads: Number(res.rows[0]?.n) || 0 };
}
```

- [ ] **Step 5: Verify types + run the pure test via node**

Run: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → exit 0.
Run: `node node_modules/typescript/bin/tsc -p tsconfig.tests.json` → exit 0.
Run (pure functionReportKeys):
```bash
node node_modules/typescript/bin/tsc src/utils/qualityReportsAggregator.ts src/utils/qualityReportsDepartments.ts --outDir _qr --module commonjs --moduleResolution node --target es2022 --skipLibCheck --rootDir src/utils >/dev/null 2>&1; echo '{"type":"commonjs"}' > _qr/package.json; node -e 'const m=require("./_qr/qualityReportsAggregator.js"); const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b); console.log(eq(m.functionReportKeys("sales"),["deals","deal_compliance","stage_aging"]) && eq(m.functionReportKeys("onboarding"),["cs_lifecycle_onboarding","deals"]) && eq(m.functionReportKeys("x"),[]) ? "PASS":"FAIL")'; rm -rf _qr
```
Expected: `PASS`.

- [ ] **Step 6: Commit**

```bash
git add src/utils/qualityReportsAggregator.ts src/utils/duplicateRadarDatabase.ts tests/vitest/qualityReportsAggregator.vitest.test.ts
git commit -m "feat(quality-reports): per-BU aggregator + segment lead-dup count"
```

---

### Task 4: Routes + RBAC + page route

**Files:**
- Create: `src/mastra/routes/qualityReportsRoutes.ts`
- Modify: the route registry that mounts route arrays (find where `consultantRoutes` is spread into the app, e.g. `src/mastra/index.ts` or the routes barrel — grep `consultantRoutes`); add `...qualityReportsRoutes`.
- Modify: `src/utils/rbacMiddleware.ts` (allowlist entries)
- Modify: `dashboard/` — a new `dashboard/quality-reports.html` is served by a page route (mirror the `/consultant` page route at `consultantRoutes.ts:455`).

**Interfaces:**
- Consumes: `listBUs`, `getBUByKey`, `upsertBU`, `deleteBU`, `setBUOwners` (Task 2); `getBUReport` (Task 3).
- Produces the HTTP surface in spec §5.

- [ ] **Step 1: Implement the routes** (mirror `consultantRoutes.ts` structure — `{path, method, createHandler}`; reads use `requireRole(c, READ_ROLES)`, writes use the admin gate used by other admin routes, e.g. `requireRole(c, WRITE_ROLES)` or `verifyAdminKey`; read one sibling admin route to match the exact gate).

```ts
import { requireRole } from "../../utils/rbacMiddleware"; // match how consultantRoutes imports its gate
import {
  listBUs, getBUByKey, upsertBU, deleteBU, setBUOwners, type Channel,
} from "../../utils/qualityReportsDepartments";
import { getBUReport } from "../../utils/qualityReportsAggregator";
import { logger } from "../../utils/logger";
import { join } from "path";

const READ_ROLES = ["admin","ai_specialist","auditor","bu_owner","custom","department_viewer","executive","grc_manager","head_of_operations_quality","quality_manager","quality_specialist","team_lead","viewer"];
const WRITE_ROLES = ["admin","grc_manager","head_of_operations_quality","quality_manager"];

export const qualityReportsRoutes = [
  { // page
    path: "/quality-reports", method: "GET" as const,
    createHandler: async () => async (c: any) => {
      // mirror consultantRoutes.ts:455 file-serving (serveStatic or readFile of dashboard/quality-reports.html)
      return c.html(await (await import("fs/promises")).readFile(join(process.cwd(), "dashboard", "quality-reports.html"), "utf8"));
    },
  },
  { path: "/api/quality-reports/bus", method: "GET" as const,
    createHandler: async () => async (c: any) => {
      try { const u = await requireRole(c, READ_ROLES); if (!u) return c.json({ error: "Insufficient permissions" }, 403);
        return c.json({ bus: await listBUs() });
      } catch (e:any) { logger.error("[QualityReports] list bus", e); return c.json({ error: "An internal error occurred" }, 500); }
    },
  },
  { path: "/api/quality-reports/bus/:buKey", method: "GET" as const,
    createHandler: async () => async (c: any) => {
      try { const u = await requireRole(c, READ_ROLES); if (!u) return c.json({ error: "Insufficient permissions" }, 403);
        const rep = await getBUReport(c.req.param("buKey"));
        if (!rep) return c.json({ error: "Not found" }, 404);
        return c.json({ success: true, ...rep });
      } catch (e:any) { logger.error("[QualityReports] bu report", e); return c.json({ error: "An internal error occurred" }, 500); }
    },
  },
  { path: "/api/quality-reports/bus", method: "POST" as const,
    createHandler: async () => async (c: any) => {
      try { const u = await requireRole(c, WRITE_ROLES); if (!u) return c.json({ error: "Insufficient permissions" }, 403);
        const b = await c.req.json().catch(() => ({}));
        if (!b?.bu_key || !b?.bu_name || !["B2B","B2C","MP"].includes(b?.channel) || !b?.fn)
          return c.json({ error: "bu_key, bu_name, channel(B2B|B2C|MP), fn required" }, 400);
        return c.json({ bu: await upsertBU(b as any) });
      } catch (e:any) { logger.error("[QualityReports] upsert", e); return c.json({ error: "An internal error occurred" }, 500); }
    },
  },
  { path: "/api/quality-reports/bus/:id", method: "DELETE" as const,
    createHandler: async () => async (c: any) => {
      try { const u = await requireRole(c, WRITE_ROLES); if (!u) return c.json({ error: "Insufficient permissions" }, 403);
        await deleteBU(parseInt(c.req.param("id"), 10)); return c.json({ ok: true });
      } catch (e:any) { logger.error("[QualityReports] delete", e); return c.json({ error: "An internal error occurred" }, 500); }
    },
  },
  { path: "/api/quality-reports/bus/:id/owners", method: "PUT" as const,
    createHandler: async () => async (c: any) => {
      try { const u = await requireRole(c, WRITE_ROLES); if (!u) return c.json({ error: "Insufficient permissions" }, 403);
        const b = await c.req.json().catch(() => ({}));
        const emails = Array.isArray(b?.owners) ? b.owners : [];
        await setBUOwners(parseInt(c.req.param("id"), 10), emails); return c.json({ ok: true });
      } catch (e:any) { logger.error("[QualityReports] owners", e); return c.json({ error: "An internal error occurred" }, 500); }
    },
  },
];
```
(Implementer: confirm `requireRole` is the exported gate name in rbacMiddleware and that `c.html`/file-serving matches the `/consultant` page route's actual mechanism — copy that mechanism verbatim.)

- [ ] **Step 2: Register the route array** — grep `consultantRoutes` to find the spread site; add `...qualityReportsRoutes` alongside it, importing from `./qualityReportsRoutes` (or the correct relative path).

- [ ] **Step 3: Add RBAC allowlist entries** in `src/utils/rbacMiddleware.ts` (near the other consultant/kpi read rules):
```ts
  { pattern: /^\/quality-reports$/, methods: ["GET"], roles: ["admin","ai_specialist","auditor","bu_owner","custom","department_viewer","executive","grc_manager","head_of_operations_quality","quality_manager","quality_specialist","team_lead","viewer"] },
  { pattern: /^\/api\/quality-reports\/bus$/, methods: ["GET","POST"], roles: ["admin","ai_specialist","auditor","bu_owner","custom","department_viewer","executive","grc_manager","head_of_operations_quality","quality_manager","quality_specialist","team_lead","viewer"] },
  { pattern: /^\/api\/quality-reports\/bus\/[^/]+$/, methods: ["GET","DELETE"], roles: ["admin","ai_specialist","auditor","bu_owner","custom","department_viewer","executive","grc_manager","head_of_operations_quality","quality_manager","quality_specialist","team_lead","viewer"] },
  { pattern: /^\/api\/quality-reports\/bus\/[^/]+\/owners$/, methods: ["PUT"], roles: ["admin","grc_manager","head_of_operations_quality","quality_manager"] },
```
(Handlers still enforce WRITE_ROLES on POST/DELETE/PUT as defense-in-depth; the allowlist is coarser but handlers are the real gate for writes.)

- [ ] **Step 4: Verify**

Run: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/mastra/routes/qualityReportsRoutes.ts src/utils/rbacMiddleware.ts src/mastra/index.ts
git commit -m "feat(quality-reports): routes + RBAC + page route"
```

---

### Task 5: Hub grid + BU page (view)

**Files:**
- Create: `dashboard/quality-reports.html`
- Create: `dashboard/js/quality-reports.js`

**Interfaces:**
- Consumes: `GET /api/quality-reports/bus`, `GET /api/quality-reports/bus/:buKey`.

- [ ] **Step 1: Build the page shell** — model `dashboard/quality-reports.html` on an existing dashboard page's head/nav/theme scaffold (copy the `<head>`, theme FOUC script, and nav include from `dashboard/consultant.html` or `dashboard/duplicates.html`). Body: a `#qrHub` grid container + a `#qrBU` detail container (hidden until a box is opened). Include `<script src="/js/quality-reports.js?v=1"></script>`. No inline `style=""` (CSP). Theme-aware.

- [ ] **Step 2: Implement `quality-reports.js`**:
```js
async function qrLoadHub() {
  const host = document.getElementById('qrHub');
  try {
    const res = await fetch('/api/quality-reports/bus', { credentials: 'same-origin' });
    const data = await res.json();
    const bus = (data && data.bus) || [];
    host.innerHTML = bus.map(function(b){
      return '<button type="button" class="rr-kpi rr-kpi-rich rr-acc-indigo text-left" data-on-click="qrOpenBU" data-args="' + escAttr(JSON.stringify([b.bu_key])) + '">' +
        '<div class="rr-kpi-label">' + escapeHtml(b.channel) + '</div>' +
        '<div class="rr-kpi-value" style="font-size:16px">' + escapeHtml(b.bu_name) + '</div>' +
        '</button>';
    }).join('');
  } catch(e) { host.innerHTML = '<div class="text-sm text-red-600">Failed to load: ' + escapeHtml(String(e.message||e)) + '</div>'; }
}
window.qrOpenBU = async function(buKey) {
  const host = document.getElementById('qrBU');
  document.getElementById('qrHub').classList.add('hidden');
  host.classList.remove('hidden');
  host.innerHTML = '<div class="text-sm text-gray-500">Loading…</div>';
  try {
    const res = await fetch('/api/quality-reports/bus/' + encodeURIComponent(buKey), { credentials: 'same-origin' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    qrRenderBU(await res.json());
  } catch(e) { host.innerHTML = '<div class="text-sm text-red-600">Failed to load: ' + escapeHtml(String(e.message||e)) + '</div>'; }
};
function qrSection(title, bodyHtml, configured) {
  return '<div class="bg-white rounded-lg shadow p-4 mb-3">' +
    '<div class="font-semibold mb-2">' + escapeHtml(title) + '</div>' +
    (configured ? bodyHtml : '<div class="text-xs text-gray-500">Not configured yet — map this in Quality Reports settings.</div>') +
    '</div>';
}
function qrRenderBU(d) {
  const host = document.getElementById('qrBU');
  const bu = d.bu || {};
  const nc = d.notConfigured || [];
  const isCfg = function(name){ return nc.indexOf(name) === -1; };
  const s = d.sections || {};
  const parts = [];
  parts.push('<button type="button" class="rr-btn rr-btn-ghost mb-3" data-on-click="qrBackToHub">← All units</button>');
  parts.push('<h2 class="text-lg font-bold mb-1">' + escapeHtml(bu.bu_name || '') + '</h2>');
  parts.push('<div class="text-xs text-gray-500 mb-3">' + escapeHtml((bu.channel||'') + ' · segment ' + (bu.segment||'')) + '</div>');
  // SOPs
  parts.push(qrSection('SOPs', s.sops ? ('<div class="text-sm">' + ((s.sops.policies||s.sops.records||[]).length || (s.sops.total||0)) + ' controlled documents</div>') : '', isCfg('sops')));
  // KPIs
  parts.push(qrSection('KPIs', s.kpis ? ('<div class="text-sm">' + (s.kpis.pct||0) + '% (' + (s.kpis.done||0) + '/' + (s.kpis.total||0) + ')</div>') : '', isCfg('kpis')));
  // Cleanup
  parts.push(qrSection('Data cleanup', s.cleanup ? qrCleanupHtml(s.cleanup) : '', isCfg('cleanup')));
  // Compliance
  parts.push(qrSection('Compliance', s.compliance ? qrComplianceHtml(s.compliance) : '', isCfg('compliance')));
  // Actions
  parts.push(qrSection('Open actions', s.actions ? ('<div class="text-sm">' + (s.actions.openCapas||0) + ' open CAPAs</div>') : '', isCfg('actions')));
  host.innerHTML = parts.join('');
}
function qrCleanupHtml(c) {
  var out = [];
  if (c.deals && c.deals.modules) out.push('<div class="text-sm">Deals removed (verified merges): ' + (c.deals.modules.Deals && c.deals.modules.Deals.verified_merges || 0) + ' · Accounts: ' + (c.deals.modules.Accounts && c.deals.modules.Accounts.verified_merges || 0) + '</div>');
  if (c.leads) out.push('<div class="text-sm">Outstanding duplicate leads: ' + (c.leads.outstanding_leads||0) + '</div>');
  return out.join('') || '<div class="text-xs text-gray-500">No cleanup data.</div>';
}
function qrComplianceHtml(c) {
  var out = [];
  if (c.cs && c.cs.summary) out.push('<div class="text-sm">CS Lifecycle violations: ' + (c.cs.summary.total_violations||0) + (c.phaseFocus ? ' (focus: ' + escapeHtml(c.phaseFocus) + ')' : '') + '</div>');
  if (c.stageAging && c.stageAging.summary) out.push('<div class="text-sm">Deal stage-aging violations: ' + (c.stageAging.summary.total_violations||0) + '</div>');
  return out.join('') || '<div class="text-xs text-gray-500">No compliance data.</div>';
}
window.qrBackToHub = function(){ document.getElementById('qrBU').classList.add('hidden'); document.getElementById('qrHub').classList.remove('hidden'); };
document.addEventListener('DOMContentLoaded', qrLoadHub);
```
(Implementer: confirm `escAttr`/`escapeHtml` helpers are available on this page — if the shared helpers aren't auto-included, copy the tiny `escapeHtml`/`escAttr` definitions from `dashboard/consultant.html`. Adjust the SOPs/KPIs field access once the real `getAllPolicies`/`getFrameworkProgressByBU` return shapes are confirmed in Task 3.)

- [ ] **Step 3: Verify**

Run: `node --check dashboard/js/quality-reports.js` → no error.
Run: `node scripts/check-dashboard-html-js.mjs` → PASS.

- [ ] **Step 4: Commit**

```bash
git add dashboard/quality-reports.html dashboard/js/quality-reports.js
git commit -m "feat(quality-reports): hub grid + BU page view"
```

---

### Task 6: Admin screen (registry CRUD UI)

**Files:**
- Modify: `dashboard/quality-reports.html` (add an admin panel toggle, gated visually to write-roles) + `dashboard/js/quality-reports.js` (CRUD calls) — bump `?v=`.

**Interfaces:**
- Consumes: `POST/PUT/DELETE /api/quality-reports/bus*`.

- [ ] **Step 1: Add an admin panel** — a collapsible section listing BUs with editable `head_email`, `policy_department`, `kpi_bu_name`, and an owners textarea (comma/newline separated). Buttons: Save (POST upsert with the BU's existing key/name/channel/fn + edited fields), Save owners (PUT owners). Use `data-on-click` handlers `qrSaveBU` / `qrSaveOwners`. No inline styles.
```js
window.qrSaveBU = async function(buKey) {
  var bu = qrCurrentBUs.find(function(b){ return b.bu_key === buKey; });
  if (!bu) return;
  var payload = { bu_key: bu.bu_key, bu_name: bu.bu_name, channel: bu.channel, fn: bu.fn,
    head_email: qrVal('qr-head-'+buKey), policy_department: qrVal('qr-pol-'+buKey), kpi_bu_name: qrVal('qr-kpi-'+buKey) };
  await fetch('/api/quality-reports/bus', { method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
  rrToast && rrToast('Saved'); qrLoadHub();
};
window.qrSaveOwners = async function(buId, buKey) {
  var raw = qrVal('qr-owners-'+buKey) || '';
  var owners = raw.split(/[\s,;]+/).map(function(s){return s.trim();}).filter(Boolean);
  await fetch('/api/quality-reports/bus/' + encodeURIComponent(buId) + '/owners', { method:'PUT', credentials:'same-origin', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ owners: owners }) });
  rrToast && rrToast('Owners saved');
};
function qrVal(id){ var el = document.getElementById(id); return el ? el.value.trim() : ''; }
```
(Keep `qrCurrentBUs` populated in `qrLoadHub` from the fetched list. Admin panel is a convenience; the write endpoints are the real gate. If `rrToast` isn't present on this page, use a minimal inline alert or a status span.)

- [ ] **Step 2: Verify**

Run: `node --check dashboard/js/quality-reports.js` → no error.
Run: `node scripts/check-dashboard-html-js.mjs` → PASS.

- [ ] **Step 3: Commit**

```bash
git add dashboard/quality-reports.html dashboard/js/quality-reports.js
git commit -m "feat(quality-reports): in-app registry admin (mappings + owners)"
```

---

### Task 7: Nav entry under Quality + ship

**Files:**
- Modify: the shared nav definition (grep for the Quality section menu — where "Duplicates Radar" / "Audit Reports" nav items are defined, likely `dashboard/js/nav.js` / `WalaPlusNav`) to add a "Quality Reports" item linking to `/quality-reports`.

**Interfaces:** none new.

- [ ] **Step 1: Add the nav item** — mirror the existing Quality-section entries (grep `Audit Reports` or `Duplicates Radar` in the nav source) and add:
```js
{ label: "Quality Reports", href: "/quality-reports", icon: "📊" }
```
in the QUALITY section, matching the surrounding object shape exactly.

- [ ] **Step 2: Full pre-ship checks**

Run: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (exit 0), `node node_modules/typescript/bin/tsc -p tsconfig.tests.json` (exit 0), `node scripts/check-schema-parity.mjs --strict` (PASS), `node scripts/check-dashboard-html-js.mjs` (PASS), `node --check dashboard/js/quality-reports.js`.

- [ ] **Step 3: Commit + push**

```bash
git add -A
git commit -m "feat(quality-reports): nav entry under Quality"
git pull --rebase --autostash origin QMS && git push origin QMS
```

- [ ] **Step 4:** Tell the user: Pull → Republish; open Quality → Quality Reports; open each BU; then map SOP department / KPI BU / owners per BU in the admin panel to light up those sections.

## Self-Review notes

- **Spec coverage:** §2 nine BUs → Task 1 SEED_BUS. §2 channel→segment → Task 1 `channelToSegment` (+ enforced in `upsertBU`, Task 2). §2 function→reports → Task 3 `functionReportKeys`. §3 registry tables → Task 1; CRUD → Task 2. §4 section sources (SOPs/KPIs/cleanup/compliance/actions) → Task 3 `getBUReport`; the leads source gap is closed by `getSegmentLeadDuplicateCount` (Task 3 Step 4). §5 endpoints → Task 4. §6 UI (hub/BU/admin) → Tasks 5-6. §7 non-goals (no email) honored — `head_email` stored, never sent. §9 testing → pure tests Tasks 1-3. §10 deploy → Task 7.
- **Placeholder scan:** the only "read the sibling to confirm" notes are for genuinely existing mechanisms (page-serving in consultantRoutes, the route-array spread site, nav object shape) that the implementer must copy verbatim — each names the exact file/symbol to copy, not a vague TODO.
- **Type consistency:** `QualityReportBU`/`Channel`/`Segment` defined Task 1-2, consumed unchanged in Tasks 3-4. `getBUReport`/`functionReportKeys` (Task 3) consumed in Task 4. `getSegmentLeadDuplicateCount` defined Task 3 Step 4, called in Task 3 Step 3 aggregator (implement Step 4's helper before/with the aggregator so it compiles).
- **Decomposition note for the executor:** Tasks 1-2 (registry) and 3 (aggregator) are backend and independently testable; Tasks 4 (routes) depends on 2+3; Tasks 5-6 (UI) depend on 4; Task 7 is nav+ship. Sequence in order.
