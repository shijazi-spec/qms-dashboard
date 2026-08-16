# Department KPI Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove department KPIs (SDR Team, Sales Team) from the KPI Engine at `/kpis` so it shows only GRQ KPIs, and let them be opened and created from their Quality Reports BU page instead.

**Architecture:** A KPI is "departmental" iff its `owner_name` matches the `kpi_owner_name` of an **active** BU in `quality_report_bus`. One new helper derives that set; four presentation surfaces exclude it. Calculation paths are deliberately untouched. The BU page links rows to the existing `/kpi/:id` editor and gains a BU-scoped create endpoint that sets the owner server-side.

**Tech Stack:** TypeScript, Hono routes, node-postgres, Vitest (`tests/vitest/**`), vanilla JS dashboard pages.

**Spec:** `docs/superpowers/specs/2026-08-16-department-kpi-separation-design.md`

## Global Constraints

- **Exclude at the presentation layer ONLY.** Never filter inside `getAllKPIDefinitions()`. It also feeds `scheduledJobs.ts:81` and `inngest/index.ts:304`; filtering there stops auto KPIs recording values and silently freezes the BU page at `--`.
- **Empty set excludes nothing.** When no active BU has a `kpi_owner_name`, every surface must behave exactly as today. Never let an empty set hide everything.
- **`owner_name IS NULL` stays a GRQ KPI.** Every SQL exclusion needs the `IS NULL` arm; every JS filter needs the falsy-owner arm.
- **One classifier only.** Visibility is decided by the BU registry. Never consult `owner_type` for visibility.
- **`owner_type` CHECK is fixed.** Only `quality_manager | grc_manager | governance_officer | grq_specialist | legal_specialist | shared | sdr_team | sales_team` are legal (`kpiDatabase.ts:221-223`). Never insert a derived string.
- **Verification command:** `npm run check:all` must pass before every commit.
- **Vitest command:** `npx vitest run tests/vitest/<file>` (config `vitest.config.ts`, scoped to `tests/vitest/**`).
- **Deploy rule:** commit + push to `origin/QMS`, THEN the user republishes. Any change to a `dashboard/js/*.js` file requires bumping its `?v=` in the owning HTML.

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/utils/qualityReportsDepartments.ts` | **Modify.** Owns the departmental-owner set + its cache. Single source of truth for classification. | 1 |
| `tests/vitest/departmentKpiOwners.vitest.test.ts` | **Create.** Tests the helper + cache + invalidation. | 1 |
| `src/mastra/routes/kpiRoutes.ts` | **Modify** (`:136` area). Excludes departmental KPIs from `GET /api/kpis`. | 2 |
| `dashboard/kpis.html` | **Modify.** One-line note pointing to Quality Reports. | 2 |
| `tests/vitest/kpiRoutesDepartmentFilter.vitest.test.ts` | **Create.** | 2 |
| `src/utils/kpiDatabase.ts` | **Modify.** `getKPIDashboardSummary` (`:2047`) excludes; new `getOwnerTypeForOwnerName`. | 3, 6 |
| `tests/vitest/kpiSummaryDepartmentFilter.vitest.test.ts` | **Create.** | 3 |
| `src/mastra/routes/qmsEnhancedRoutes.ts` | **Modify** (`:805`, `:850`). Both exports exclude. | 4 |
| `tests/vitest/kpiExportDepartmentFilter.vitest.test.ts` | **Create.** | 4 |
| `dashboard/js/quality-reports.js` | **Modify.** Rows link to `/kpi/:id`; Add KPI modal. | 5, 6 |
| `dashboard/quality-reports.html` | **Modify.** `?v=` bump. | 5 |
| `src/mastra/routes/qualityReportsRoutes.ts` | **Modify.** BU-scoped create endpoint. | 6 |
| `tests/vitest/qualityReportsKpiCreate.vitest.test.ts` | **Create.** | 6 |

---

### Task 1: Departmental owner-name helper

**Files:**
- Modify: `src/utils/qualityReportsDepartments.ts` (append helper after `getBUByKey`, ~line 177; edit `upsertBU` and `deleteBU`)
- Test: `tests/vitest/departmentKpiOwners.vitest.test.ts`

**Interfaces:**
- Consumes: existing module-scope `pool`, `ensureQualityReportTables()`.
- Produces:
  - `getDepartmentKpiOwnerNames(): Promise<string[]>` — distinct `kpi_owner_name` of active BUs.
  - `invalidateDepartmentKpiOwnerCache(): void`

- [ ] **Step 1: Write the failing test**

Create `tests/vitest/departmentKpiOwners.vitest.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../src/utils/redactedPool", () => ({
  createRedactedPool: () => ({
    query: (...a: any[]) => query(...a),
    connect: async () => ({ query: (...a: any[]) => query(...a), release: () => {} }),
  }),
}));
vi.mock("../../src/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
import {
  getDepartmentKpiOwnerNames,
  invalidateDepartmentKpiOwnerCache,
} from "../../src/utils/qualityReportsDepartments";

beforeEach(() => {
  query.mockReset();
  invalidateDepartmentKpiOwnerCache();
});

describe("getDepartmentKpiOwnerNames", () => {
  it("returns the distinct kpi_owner_name of ACTIVE BUs only", async () => {
    query.mockResolvedValue({
      rows: [{ kpi_owner_name: "SDR Team" }, { kpi_owner_name: "Sales Team" }],
    });
    const names = await getDepartmentKpiOwnerNames();
    expect(names).toEqual(["SDR Team", "Sales Team"]);
    const sql = String(query.mock.calls.at(-1)?.[0]);
    expect(sql).toContain("quality_report_bus");
    expect(sql).toContain("is_active = true");
    expect(sql).toContain("kpi_owner_name IS NOT NULL");
  });

  it("returns [] when no BU maps a KPI owner (must exclude NOTHING downstream)", async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await getDepartmentKpiOwnerNames()).toEqual([]);
  });

  it("caches: a second call inside the TTL does not re-query", async () => {
    query.mockResolvedValue({ rows: [{ kpi_owner_name: "SDR Team" }] });
    await getDepartmentKpiOwnerNames();
    const callsAfterFirst = query.mock.calls.length;
    await getDepartmentKpiOwnerNames();
    expect(query.mock.calls.length).toBe(callsAfterFirst);
  });

  it("invalidate forces a re-query", async () => {
    query.mockResolvedValue({ rows: [{ kpi_owner_name: "SDR Team" }] });
    await getDepartmentKpiOwnerNames();
    const before = query.mock.calls.length;
    invalidateDepartmentKpiOwnerCache();
    await getDepartmentKpiOwnerNames();
    expect(query.mock.calls.length).toBeGreaterThan(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/vitest/departmentKpiOwners.vitest.test.ts`
Expected: FAIL — `getDepartmentKpiOwnerNames is not a function` / import error.

- [ ] **Step 3: Implement the helper**

In `src/utils/qualityReportsDepartments.ts`, insert immediately after `getBUByKey` (ends ~line 177):

```ts
// ---------------------------------------------------------------------------
// Department KPI classification
// ---------------------------------------------------------------------------
/**
 * The KPI-catalog owners that belong to a business unit we report on — today
 * "SDR Team" and "Sales Team". A KPI whose `owner_name` is in this set is a
 * DEPARTMENT KPI: it is hidden from the GRQ KPI Engine at /kpis and managed on
 * its Quality Reports BU page instead.
 *
 * Derived from the BU registry rather than stored on the KPI, so mapping a new
 * BU is the only action needed to separate its KPIs. Deliberately NOT keyed off
 * `kpi_definitions.owner_type` (which does carry 'sdr_team'/'sales_team'):
 * that would need a CHECK migration + backfill per new department, and could
 * drift from the registry, leaving two sources disagreeing about one row.
 *
 * ORPHANS ARE IMPOSSIBLE BY CONSTRUCTION: if no ACTIVE BU claims an owner, its
 * KPIs are not departmental and stay visible in /kpis. Deactivating a BU
 * returns its KPIs to the engine rather than hiding them everywhere. Do not
 * invert this.
 */
const DEPT_OWNER_TTL_MS = 60_000;
let deptOwnerCache: { at: number; names: string[] } | null = null;

/** Called by upsertBU/deleteBU so an admin mapping change lands without a restart. */
export function invalidateDepartmentKpiOwnerCache(): void {
  deptOwnerCache = null;
}

export async function getDepartmentKpiOwnerNames(): Promise<string[]> {
  if (deptOwnerCache && Date.now() - deptOwnerCache.at < DEPT_OWNER_TTL_MS) {
    return deptOwnerCache.names;
  }
  await ensureQualityReportTables();
  const r = await pool.query(
    `SELECT DISTINCT kpi_owner_name
       FROM quality_report_bus
      WHERE is_active = true
        AND kpi_owner_name IS NOT NULL
        AND kpi_owner_name <> ''`,
  );
  const names = r.rows.map((x: any) => String(x.kpi_owner_name));
  deptOwnerCache = { at: Date.now(), names };
  return names;
}
```

- [ ] **Step 4: Wire cache invalidation**

In the same file, add `invalidateDepartmentKpiOwnerCache();` as the last statement before `return` in `upsertBU` (after `const owners = await ownersFor(...)`), and as the last statement of `deleteBU`:

```ts
  // upsertBU — before the return
  const owners = await ownersFor([r.rows[0].id]);
  invalidateDepartmentKpiOwnerCache();
  return rowToBU(r.rows[0], owners.get(r.rows[0].id) || []);
```

```ts
export async function deleteBU(id: number): Promise<void> {
  await ensureQualityReportTables();
  await pool.query(`DELETE FROM quality_report_bus WHERE id = $1`, [id]);
  invalidateDepartmentKpiOwnerCache();
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/vitest/departmentKpiOwners.vitest.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Typecheck**

Run: `npm run check:all`
Expected: all four gates pass.

- [ ] **Step 7: Commit**

```bash
git add src/utils/qualityReportsDepartments.ts tests/vitest/departmentKpiOwners.vitest.test.ts
git commit -m "feat(kpis): derive the department KPI owner set from the BU registry"
```

---

### Task 2: Exclude department KPIs from `GET /api/kpis`

**Files:**
- Modify: `src/mastra/routes/kpiRoutes.ts` (the `GET /api/kpis` handler, `path: "/api/kpis"` at line 114; the `kpis = await ...` if/else at ~133-137)
- Modify: `dashboard/kpis.html` (header block, ~line 55)
- Test: `tests/vitest/kpiRoutesDepartmentFilter.vitest.test.ts`

**Interfaces:**
- Consumes: `getDepartmentKpiOwnerNames()` from Task 1.
- Produces: nothing for later tasks.

- [ ] **Step 1: Write the failing test**

Create `tests/vitest/kpiRoutesDepartmentFilter.vitest.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { getAllKPIDefinitions, getKPIsByOwner, getLatestKPIValue, deptOwners } =
  vi.hoisted(() => ({
    getAllKPIDefinitions: vi.fn(),
    getKPIsByOwner: vi.fn(),
    getLatestKPIValue: vi.fn(),
    deptOwners: vi.fn(),
  }));

vi.mock("../../src/utils/kpiDatabase", () => ({
  getAllKPIDefinitions,
  getKPIsByOwner,
  getLatestKPIValue,
  getLatestKPIValueForQuarter: vi.fn(),
  getKPIDashboardSummary: vi.fn(),
  createKPIDefinition: vi.fn(),
  updateKPIDefinition: vi.fn(),
  recordKPIValue: vi.fn(),
  getKPIHistory: vi.fn(),
}));
vi.mock("../../src/utils/qualityReportsDepartments", () => ({
  getDepartmentKpiOwnerNames: deptOwners,
}));
vi.mock("../../src/utils/rbacMiddleware", () => ({
  requireRole: vi.fn(async () => ({ email: "a@b.com", role: "admin" })),
  forbiddenResponse: (c: any) => c.json({ error: "forbidden" }, 403),
}));

import { kpiRoutes } from "../../src/mastra/routes/kpiRoutes";

function ctx(query: Record<string, string> = {}) {
  return {
    req: { query: (k: string) => query[k], param: () => undefined },
    json: (body: any, status?: number) => ({ body, status: status ?? 200 }),
  };
}

async function callGetKpis(c: any) {
  const route = kpiRoutes.find(
    (r: any) => r.path === "/api/kpis" && r.method === "GET",
  );
  const handler = await route.createHandler();
  return handler(c);
}

beforeEach(() => {
  getAllKPIDefinitions.mockReset();
  getKPIsByOwner.mockReset();
  getLatestKPIValue.mockReset().mockResolvedValue(null);
  deptOwners.mockReset();
});

describe("GET /api/kpis department filter", () => {
  it("drops KPIs owned by a department team", async () => {
    getAllKPIDefinitions.mockResolvedValue([
      { id: 1, kpi_code: "QM-KPI-001", owner_name: "Sarah" },
      { id: 2, kpi_code: "SDR-KPI-01", owner_name: "SDR Team" },
      { id: 3, kpi_code: "SALES-KPI-01", owner_name: "Sales Team" },
    ]);
    deptOwners.mockResolvedValue(["SDR Team", "Sales Team"]);
    const res: any = await callGetKpis(ctx());
    expect(res.body.map((k: any) => k.kpi_code)).toEqual(["QM-KPI-001"]);
  });

  it("keeps KPIs with a NULL owner_name", async () => {
    getAllKPIDefinitions.mockResolvedValue([
      { id: 1, kpi_code: "LEGACY-01", owner_name: null },
      { id: 2, kpi_code: "SDR-KPI-01", owner_name: "SDR Team" },
    ]);
    deptOwners.mockResolvedValue(["SDR Team"]);
    const res: any = await callGetKpis(ctx());
    expect(res.body.map((k: any) => k.kpi_code)).toEqual(["LEGACY-01"]);
  });

  it("excludes NOTHING when no BU maps a KPI owner", async () => {
    getAllKPIDefinitions.mockResolvedValue([
      { id: 1, kpi_code: "QM-KPI-001", owner_name: "Sarah" },
      { id: 2, kpi_code: "SDR-KPI-01", owner_name: "SDR Team" },
    ]);
    deptOwners.mockResolvedValue([]);
    const res: any = await callGetKpis(ctx());
    expect(res.body).toHaveLength(2);
  });

  it("applies to the ?owner= branch too", async () => {
    getKPIsByOwner.mockResolvedValue([
      { id: 2, kpi_code: "SDR-KPI-01", owner_name: "SDR Team" },
    ]);
    deptOwners.mockResolvedValue(["SDR Team"]);
    const res: any = await callGetKpis(ctx({ owner: "sdr_team" }));
    expect(res.body).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/vitest/kpiRoutesDepartmentFilter.vitest.test.ts`
Expected: FAIL — department KPIs still present (first test gets 3 codes, not 1).

- [ ] **Step 3: Implement the filter**

In `src/mastra/routes/kpiRoutes.ts`, directly after the `if (ownerType) { ... } else { ... }` block that assigns `kpis` (~line 133-137) and BEFORE the `kpis = await Promise.all(...)` value-attachment block, insert:

```ts
          // Department KPIs (SDR Team / Sales Team) are managed on their
          // Quality Reports BU page and must not appear in the GRQ engine.
          //
          // Filtered HERE, at the presentation layer. NEVER inside
          // getAllKPIDefinitions() -- that function also feeds
          // scheduledJobs.ts and the Inngest runner, and filtering there
          // would stop the auto KPIs recording values, silently freezing the
          // BU page at "--" with nothing appearing broken.
          //
          // Runs BEFORE the value-attachment Promise.all below so excluded
          // rows cost no per-KPI value lookups.
          const { getDepartmentKpiOwnerNames } = await import(
            "../../utils/qualityReportsDepartments"
          );
          const deptOwnerNames = await getDepartmentKpiOwnerNames();
          if (deptOwnerNames.length) {
            const deptSet = new Set(deptOwnerNames);
            kpis = (kpis as any[]).filter(
              (k) => !k.owner_name || !deptSet.has(String(k.owner_name)),
            );
          }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/vitest/kpiRoutesDepartmentFilter.vitest.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Add the KPI Engine note**

In `dashboard/kpis.html`, immediately after the subtitle paragraph at line 55 (`<p class="text-gray-600" data-i18n="kpis.subtitle">...</p>`), add:

```html
                <p class="text-xs text-gray-500 mt-1">Department KPIs (SDR, Sales) now live in <a href="/quality-reports" class="text-blue-600 hover:underline">Quality Reports</a>, under each business unit.</p>
```

Without this the drop in "Total KPIs" reads as data loss.

- [ ] **Step 6: Verify**

Run: `npm run check:all`
Expected: all gates pass (including `check:html-js`, which parses every dashboard script block).

- [ ] **Step 7: Commit**

```bash
git add src/mastra/routes/kpiRoutes.ts dashboard/kpis.html tests/vitest/kpiRoutesDepartmentFilter.vitest.test.ts
git commit -m "feat(kpis): exclude department KPIs from the KPI Engine list"
```

---

### Task 3: Exclude from the dashboard summary (cards + 3 charts)

**Files:**
- Modify: `src/utils/kpiDatabase.ts` — `getKPIDashboardSummary` at line 2047
- Test: `tests/vitest/kpiSummaryDepartmentFilter.vitest.test.ts`

**Interfaces:**
- Consumes: `getDepartmentKpiOwnerNames()` from Task 1.
- Produces: `summary.byOwner` no longer has `sdr_team` / `sales_team` keys.

- [ ] **Step 1: Write the failing test**

Create `tests/vitest/kpiSummaryDepartmentFilter.vitest.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
const { query, deptOwners } = vi.hoisted(() => ({
  query: vi.fn(),
  deptOwners: vi.fn(),
}));
vi.mock("../../src/utils/redactedPool", () => ({
  createRedactedPool: () => ({
    query: (...a: any[]) => query(...a),
    connect: async () => ({ query: (...a: any[]) => query(...a), release: () => {} }),
  }),
}));
vi.mock("../../src/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../src/utils/qualityReportsDepartments", () => ({
  getDepartmentKpiOwnerNames: deptOwners,
}));
import { getKPIDashboardSummary } from "../../src/utils/kpiDatabase";

beforeEach(() => {
  query.mockReset();
  deptOwners.mockReset();
});

describe("getKPIDashboardSummary department filter", () => {
  it("excludes department KPIs from total and byOwner", async () => {
    query.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM kpi_definitions")) {
        return {
          rows: [
            { id: 1, kpi_code: "QM-KPI-001", owner_name: "Sarah", owner_type: "quality_manager", category: "quality" },
            { id: 2, kpi_code: "SDR-KPI-01", owner_name: "SDR Team", owner_type: "sdr_team", category: "quality" },
          ],
        };
      }
      return { rows: [] };
    });
    deptOwners.mockResolvedValue(["SDR Team"]);
    const s = await getKPIDashboardSummary();
    expect(s.total).toBe(1);
    expect(s.byOwner.sdr_team).toBeUndefined();
    expect(s.byOwner.sales_team).toBeUndefined();
    expect(s.byOwner.quality_manager).toBe(1);
  });

  it("excludes nothing when the departmental set is empty", async () => {
    query.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM kpi_definitions")) {
        return {
          rows: [
            { id: 1, kpi_code: "QM-KPI-001", owner_name: "Sarah", owner_type: "quality_manager", category: "quality" },
            { id: 2, kpi_code: "SDR-KPI-01", owner_name: "SDR Team", owner_type: "sdr_team", category: "quality" },
          ],
        };
      }
      return { rows: [] };
    });
    deptOwners.mockResolvedValue([]);
    const s = await getKPIDashboardSummary();
    expect(s.total).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/vitest/kpiSummaryDepartmentFilter.vitest.test.ts`
Expected: FAIL — `total` is 2, and `byOwner.sdr_team` is `0` rather than `undefined`.

- [ ] **Step 3: Implement**

In `src/utils/kpiDatabase.ts`, replace the opening of `getKPIDashboardSummary` (line 2047-2053) so that it filters and drops the two byOwner keys:

```ts
export async function getKPIDashboardSummary(
  quarter?: { year: number; quarter: number },
): Promise<any> {
  const allKpis = await getAllKPIDefinitions();
  // Department KPIs live on their Quality Reports BU page, not in this engine.
  // Lazy import to keep the module graph acyclic (same pattern the Quality
  // Reports aggregator uses). Presentation-layer only -- see the note in
  // kpiRoutes.ts: filtering inside getAllKPIDefinitions() would break the
  // scheduled/Inngest value recording for these KPIs.
  const { getDepartmentKpiOwnerNames } = await import(
    "./qualityReportsDepartments"
  );
  const deptSet = new Set(await getDepartmentKpiOwnerNames());
  const kpis = deptSet.size
    ? allKpis.filter(
        (k: any) => !k.owner_name || !deptSet.has(String(k.owner_name)),
      )
    : allKpis;
  const summary: any = {
    total: kpis.length,
    // sdr_team / sales_team intentionally absent: those KPIs are excluded
    // above, so seeding the keys would leave two permanent zeros in the
    // owner donut's legend.
    byOwner: { quality_manager: 0, grc_manager: 0, grq_specialist: 0, legal_specialist: 0, shared: 0 },
```

Leave the rest of the function unchanged — it already iterates `kpis`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/vitest/kpiSummaryDepartmentFilter.vitest.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Verify**

Run: `npm run check:all`
Expected: all gates pass.

- [ ] **Step 6: Commit**

```bash
git add src/utils/kpiDatabase.ts tests/vitest/kpiSummaryDepartmentFilter.vitest.test.ts
git commit -m "feat(kpis): exclude department KPIs from the engine summary and charts"
```

---

### Task 4: Exclude from CSV and XLSX exports

**Files:**
- Modify: `src/mastra/routes/qmsEnhancedRoutes.ts` — `/api/kpis/export` (line 805), `/api/kpis/export-xlsx` (line 850)
- Test: `tests/vitest/kpiExportDepartmentFilter.vitest.test.ts`

**Interfaces:**
- Consumes: `getDepartmentKpiOwnerNames()` from Task 1.
- Produces: nothing for later tasks.

These endpoints do **not** use `getAllKPIDefinitions()` — they run their own raw SQL, so Tasks 2 and 3 do not cover them.

- [ ] **Step 1: Write the failing test**

Create `tests/vitest/kpiExportDepartmentFilter.vitest.test.ts`. It invokes the real handlers and captures every SQL statement + params they issue, so it tests behaviour rather than source text:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { poolQuery, cursorCalls, deptOwners } = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  cursorCalls: [] as Array<{ sql: string; params: any[] }>,
  deptOwners: vi.fn(),
}));

vi.mock("pg", () => ({
  default: { Pool: class { query = (...a: any[]) => poolQuery(...a); end = async () => {}; } },
}));
vi.mock("../../src/utils/excelExport", () => ({
  cursorQuery: (_pool: any, sql: string, params: any[] = []) => {
    cursorCalls.push({ sql, params });
    return (async function* () {})();
  },
  streamXlsx: vi.fn(async () => new Uint8Array()),
}));
vi.mock("../../src/utils/qualityReportsDepartments", () => ({
  getDepartmentKpiOwnerNames: deptOwners,
}));
vi.mock("../../src/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { qmsEnhancedRoutes } from "../../src/mastra/routes/qmsEnhancedRoutes";

function ctx() {
  return {
    req: { query: () => undefined, param: () => undefined, header: () => undefined },
    json: (b: any, s?: number) => ({ body: b, status: s ?? 200 }),
    body: (b: any, s?: number) => ({ body: b, status: s ?? 200 }),
    header: () => {},
  };
}

async function run(path: string) {
  const route = qmsEnhancedRoutes.find(
    (r: any) => r.path === path && r.method === "GET",
  );
  expect(route, `route ${path} not found`).toBeTruthy();
  const handler = await (route as any).createHandler();
  try { await handler(ctx()); } catch { /* streaming/response plumbing is not under test */ }
}

/** Every statement that reads kpi_definitions must carry the exclusion, or the
 *  export leaks department KPIs (or its totals disagree with its rows). */
function assertExcluded(sql: string, params: any[]) {
  expect(sql).toMatch(/owner_name IS NULL OR/i);
  expect(sql).toMatch(/owner_name <> ALL/i);
  expect(params.some((p) => Array.isArray(p))).toBe(true);
}

beforeEach(() => {
  poolQuery.mockReset().mockResolvedValue({ rows: [{ total: 0 }] });
  cursorCalls.length = 0;
  deptOwners.mockReset().mockResolvedValue(["SDR Team", "Sales Team"]);
});

describe("KPI export department exclusion", () => {
  it("CSV export excludes department KPIs and binds the owner array", async () => {
    await run("/api/kpis/export");
    const defReads = cursorCalls.filter((c) => /FROM\s+kpi_definitions/i.test(c.sql));
    expect(defReads.length).toBeGreaterThan(0);
    for (const c of defReads) assertExcluded(c.sql, c.params);
  });

  it("XLSX export excludes department KPIs in every kpi_definitions statement", async () => {
    await run("/api/kpis/export-xlsx");
    const direct = poolQuery.mock.calls
      .map((c) => ({ sql: String(c[0]), params: (c[1] ?? []) as any[] }))
      .filter((c) => /FROM\s+kpi_definitions/i.test(c.sql));
    const viaCursor = cursorCalls.filter((c) => /FROM\s+kpi_definitions/i.test(c.sql));
    expect(direct.length + viaCursor.length).toBeGreaterThan(0);
    for (const c of [...direct, ...viaCursor]) assertExcluded(c.sql, c.params);
  });

  it("XLSX value count joins kpi_definitions so it matches the row sheets", async () => {
    await run("/api/kpis/export-xlsx");
    const valueCount = poolQuery.mock.calls
      .map((c) => String(c[0]))
      .find((sql) => /COUNT\(\*\)/i.test(sql) && /FROM\s+kpi_values/i.test(sql));
    expect(valueCount).toBeTruthy();
    expect(valueCount).toMatch(/JOIN\s+kpi_definitions/i);
  });
});
```

If a handler's response plumbing proves impractical to drive under mocks, keep the assertions and adjust only the `run()` helper — do not weaken them into source-text matching.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/vitest/kpiExportDepartmentFilter.vitest.test.ts`
Expected: FAIL — no statement carries the exclusion.

- [ ] **Step 3: Implement the CSV export**

In `/api/kpis/export` (line 805), fetch the owner set and pass it as a bind param. `cursorQuery(pool, sql, params)` accepts params (`excelExport.ts:304`). Replace the `const source = cursorQuery(...)` call:

```ts
          const { getDepartmentKpiOwnerNames } = await import(
            "../../utils/qualityReportsDepartments"
          );
          const deptOwnerNames = await getDepartmentKpiOwnerNames();
          const source = cursorQuery(
            pool,
            `SELECT kd.kpi_name, kd.target_value, kv.actual_value, kv.period_start, kv.period_end, kv.calculated_by
               FROM kpi_definitions kd LEFT JOIN kpi_values kv ON kd.id = kv.kpi_id
              WHERE (kd.owner_name IS NULL OR kd.owner_name <> ALL($1::text[]))
              ORDER BY kd.kpi_name, kv.period_end DESC`,
            [deptOwnerNames],
          );
```

An empty array makes `x <> ALL('{}')` TRUE, so nothing is excluded — the required empty-set behaviour, no special case needed.

- [ ] **Step 4: Implement the XLSX export**

In `/api/kpis/export-xlsx` (line 850), add the owner fetch before the `Promise.all`, then apply the clause to all three `kpi_definitions` statements and join the `kpi_values` count so the summary sheet agrees with the row sheets:

```ts
          const { getDepartmentKpiOwnerNames } = await import(
            "../../utils/qualityReportsDepartments"
          );
          const deptOwnerNames = await getDepartmentKpiOwnerNames();
          const notDept = `(kd.owner_name IS NULL OR kd.owner_name <> ALL($1::text[]))`;

          const [kpiTotR, valTotR, catsR] = await Promise.all([
            pool.query(
              `SELECT COUNT(*)::int AS total FROM kpi_definitions kd WHERE kd.is_active = true AND ${notDept}`,
              [deptOwnerNames],
            ),
            pool.query(
              `SELECT COUNT(*)::int AS total FROM kpi_values kv
                 JOIN kpi_definitions kd ON kd.id = kv.kpi_id
                WHERE ${notDept}`,
              [deptOwnerNames],
            ),
            pool.query(
              `SELECT DISTINCT COALESCE(kd.category, 'Uncategorised') AS cat
                 FROM kpi_definitions kd WHERE kd.is_active = true AND ${notDept} ORDER BY cat`,
              [deptOwnerNames],
            ),
          ]);
```

Then the per-category sheet query. Change `catDefSql`'s WHERE line (line 905) from:

```ts
            WHERE kd.is_active = true AND COALESCE(kd.category, 'Uncategorised') = $1
```

to:

```ts
            WHERE kd.is_active = true AND COALESCE(kd.category, 'Uncategorised') = $1
              AND (kd.owner_name IS NULL OR kd.owner_name <> ALL($2::text[]))
```

and its call site at line 931 from:

```ts
            const catSource = cursorQuery(pool, catDefSql, [cat]);
```

to:

```ts
            const catSource = cursorQuery(pool, catDefSql, [cat, deptOwnerNames]);
```

`$1` stays the category so the existing parameter order is preserved.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/vitest/kpiExportDepartmentFilter.vitest.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Verify**

Run: `npm run check:all`
Expected: all gates pass.

- [ ] **Step 7: Commit**

```bash
git add src/mastra/routes/qmsEnhancedRoutes.ts tests/vitest/kpiExportDepartmentFilter.vitest.test.ts
git commit -m "feat(kpis): exclude department KPIs from CSV and XLSX exports"
```

---

### Task 5: Open a department KPI from the BU page

**Files:**
- Modify: `dashboard/js/quality-reports.js` — `qrKpisHtml` (~line 449)
- Modify: `dashboard/quality-reports.html` — `?v=` bump on the `quality-reports.js` script tag

**Interfaces:**
- Consumes: each row of `sections.kpis.list` already carries `id` (`CatalogKpiWithValue.id`, `kpiDatabase.ts:1686`) and the aggregator passes the list through untouched. No backend change needed.
- Produces: nothing for later tasks.

- [ ] **Step 1: Make each KPI row a link**

In `qrKpisHtml`, replace the `var rows = list.map(function (i) {` body's opening and closing so the row is an anchor when an id is present. Change the opening line:

```js
            var rows = list.map(function (i) {
                var rag = QR_RAG[i.rag] || QR_RAG.none;
                // Department KPIs are no longer in the KPI Engine, so this is
                // the only route to their detail/editor page. Rows without an
                // id render as plain divs rather than dead links.
                var open = i.id ? '<a href="/kpi/' + encodeURIComponent(i.id) + '" class="block hover:bg-gray-50 -mx-2 px-2 rounded">' : '';
                var close = i.id ? '</a>' : '';
                return open + '<div class="flex items-center gap-3 py-1.5 border-b border-gray-100 last:border-0">' +
```

and the final line of the same `map` callback, changing:

```js
                '</div>';
            });
```

to:

```js
                '</div>' + close;
            });
```

- [ ] **Step 2: Bump the script version**

In `dashboard/quality-reports.html`, change the `quality-reports.js` script tag's `?v=` to the next integer (it is currently `v=6` or higher — read the current value and increment it; do NOT hardcode a number that might go backwards).

- [ ] **Step 3: Verify the page still parses**

Run: `npm run check:all`
Expected: `check-dashboard-html-js` reports all script blocks parsed cleanly.

- [ ] **Step 4: Commit**

```bash
git add dashboard/js/quality-reports.js dashboard/quality-reports.html
git commit -m "feat(quality-reports): open a department KPI from its BU page"
```

---

### Task 6: Add a department KPI from the BU page

**Files:**
- Modify: `src/utils/kpiDatabase.ts` — new `getOwnerTypeForOwnerName`
- Modify: `src/mastra/routes/qualityReportsRoutes.ts` — new `POST /api/quality-reports/bus/:buKey/kpis`
- Modify: `dashboard/js/quality-reports.js` — Add KPI button + modal
- Modify: `dashboard/quality-reports.html` — `?v=` bump
- Test: `tests/vitest/qualityReportsKpiCreate.vitest.test.ts`

**Interfaces:**
- Consumes: `getBUByKey()`, `createKPIDefinition(kpi)` (`kpiDatabase.ts:1817`), `WRITE_ROLES` (already defined in `qualityReportsRoutes.ts:14`).
- Produces: `getOwnerTypeForOwnerName(ownerName: string): Promise<string>`.

**Why a BU-scoped endpoint rather than the existing `POST /api/kpis`:** that handler passes the raw request body straight into `createKPIDefinition` (`kpiRoutes.ts:263-264`), so a client could set any `owner_name` and place a KPI in any team — or in none, making it appear in the GRQ engine. This endpoint resolves the owner **server-side from the BU**, the same rule the Quality Reports email route uses for its recipient.

- [ ] **Step 1: Write the failing test**

Create `tests/vitest/qualityReportsKpiCreate.vitest.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { getBUByKey, createKPIDefinition, getOwnerTypeForOwnerName } = vi.hoisted(
  () => ({
    getBUByKey: vi.fn(),
    createKPIDefinition: vi.fn(),
    getOwnerTypeForOwnerName: vi.fn(),
  }),
);

vi.mock("../../src/utils/qualityReportsDepartments", () => ({
  getBUByKey,
  listBUs: vi.fn(),
  upsertBU: vi.fn(),
  deleteBU: vi.fn(),
  setBUOwners: vi.fn(),
  getDepartmentKpiOwnerNames: vi.fn(async () => []),
}));
vi.mock("../../src/utils/kpiDatabase", () => ({
  createKPIDefinition,
  getOwnerTypeForOwnerName,
}));
// qualityReportsRoutes statically imports the aggregator, which pulls in
// duplicateRadarDatabase and its pool. Stub it so this suite stays a unit test.
vi.mock("../../src/utils/qualityReportsAggregator", () => ({
  getBUReport: vi.fn(),
  getBUHeadline: vi.fn(),
}));
vi.mock("../../src/utils/rbacMiddleware", () => ({
  requireRole: vi.fn(async () => ({ email: "a@b.com", role: "admin" })),
  forbiddenResponse: (c: any) => c.json({ error: "forbidden" }, 403),
}));
vi.mock("../../src/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { qualityReportsRoutes } from "../../src/mastra/routes/qualityReportsRoutes";

function ctx(buKey: string, body: any) {
  return {
    req: { param: () => buKey, json: async () => body },
    json: (b: any, status?: number) => ({ body: b, status: status ?? 200 }),
  };
}

async function post(buKey: string, body: any) {
  const route = qualityReportsRoutes.find(
    (r: any) => r.path === "/api/quality-reports/bus/:buKey/kpis" && r.method === "POST",
  );
  const handler = await route.createHandler();
  return handler(ctx(buKey, body));
}

const VALID = {
  kpi_name: "Answer Rate",
  kpi_code: "SDR-KPI-12",
  category: "quality",
  unit: "%",
  target_value: 80,
  threshold_green: 80,
  threshold_amber: 60,
  threshold_red: 40,
  threshold_direction: "higher_is_better",
};

beforeEach(() => {
  getBUByKey.mockReset();
  createKPIDefinition.mockReset().mockResolvedValue({ id: 99, ...VALID });
  getOwnerTypeForOwnerName.mockReset().mockResolvedValue("sdr_team");
});

describe("POST /api/quality-reports/bus/:buKey/kpis", () => {
  it("sets owner_name from the BU, never from the body", async () => {
    getBUByKey.mockResolvedValue({ bu_key: "sdr_b2b", kpi_owner_name: "SDR Team" });
    await post("sdr_b2b", { ...VALID, owner_name: "Sarah", owner_type: "quality_manager" });
    const arg = createKPIDefinition.mock.calls[0][0];
    expect(arg.owner_name).toBe("SDR Team");
    expect(arg.owner_type).toBe("sdr_team");
  });

  it("404s for an unknown BU", async () => {
    getBUByKey.mockResolvedValue(null);
    const res: any = await post("nope", VALID);
    expect(res.status).toBe(404);
  });

  it("400s when the BU has no KPI owner mapped", async () => {
    getBUByKey.mockResolvedValue({ bu_key: "sdr_b2c", kpi_owner_name: null });
    const res: any = await post("sdr_b2c", VALID);
    expect(res.status).toBe(400);
    expect(createKPIDefinition).not.toHaveBeenCalled();
  });

  it("400s when a required field is missing", async () => {
    getBUByKey.mockResolvedValue({ bu_key: "sdr_b2b", kpi_owner_name: "SDR Team" });
    const res: any = await post("sdr_b2b", { ...VALID, kpi_code: "" });
    expect(res.status).toBe(400);
    expect(createKPIDefinition).not.toHaveBeenCalled();
  });

  it("409s on a duplicate kpi_code", async () => {
    getBUByKey.mockResolvedValue({ bu_key: "sdr_b2b", kpi_owner_name: "SDR Team" });
    createKPIDefinition.mockRejectedValue(
      Object.assign(new Error("dup"), { code: "23505" }),
    );
    const res: any = await post("sdr_b2b", VALID);
    expect(res.status).toBe(409);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/vitest/qualityReportsKpiCreate.vitest.test.ts`
Expected: FAIL — the route does not exist (`route` is undefined).

- [ ] **Step 3: Add `getOwnerTypeForOwnerName`**

In `src/utils/kpiDatabase.ts`, immediately after `getKPIsByOwnerName` (ends ~line 1720):

```ts
/**
 * The owner_type used by a team's existing KPIs, for creating a new one under
 * the same team. All of a team's rows share one value ('sdr_team' for
 * "SDR Team", 'sales_team' for "Sales Team").
 *
 * Falls back to 'shared' for a team with no KPIs yet: owner_type is
 * CHECK-constrained (kpiDatabase.ts:221-223) so a derived string like
 * "cs_team" would be rejected by Postgres. Harmless either way -- visibility
 * is decided by the BU registry, never by owner_type.
 */
export async function getOwnerTypeForOwnerName(
  ownerName: string,
): Promise<string> {
  const r = await pool.query(
    `SELECT owner_type FROM kpi_definitions
      WHERE owner_name = $1 AND is_active = true LIMIT 1`,
    [ownerName],
  );
  return r.rows[0]?.owner_type ?? "shared";
}
```

- [ ] **Step 4: Add the endpoint**

In `src/mastra/routes/qualityReportsRoutes.ts`, add to the `qualityReportsRoutes` array (after the email POST route):

```ts
  {
    // Create a KPI for this BU's team. The owner is resolved SERVER-SIDE from
    // the BU mapping and never read from the body -- otherwise a client could
    // file a KPI under any team, or under none (which would surface it in the
    // GRQ KPI Engine). Same rule as the email route's recipient.
    path: "/api/quality-reports/bus/:buKey/kpis",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, WRITE_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);
          const buKey = c.req.param("buKey");
          const bu = await getBUByKey(buKey);
          if (!bu) return c.json({ error: "Not found" }, 404);
          if (!bu.kpi_owner_name) {
            return c.json(
              { error: "This business unit has no KPI owner mapped." },
              400,
            );
          }
          const b = await c.req.json().catch(() => ({}));
          const str = (v: any) => (typeof v === "string" ? v.trim() : "");
          const kpi_name = str(b?.kpi_name);
          const kpi_code = str(b?.kpi_code);
          const category = str(b?.category);
          if (!kpi_name || !kpi_code || !category) {
            return c.json(
              { error: "kpi_name, kpi_code and category are required." },
              400,
            );
          }
          const num = (v: any, d: number | null) =>
            v === null || v === undefined || v === "" ? d : Number(v);
          const { createKPIDefinition, getOwnerTypeForOwnerName } =
            await import("../../utils/kpiDatabase");
          const kpi = await createKPIDefinition({
            kpi_name,
            kpi_code,
            description: str(b?.description) || null,
            owner_name: bu.kpi_owner_name,
            owner_type: await getOwnerTypeForOwnerName(bu.kpi_owner_name),
            category,
            formula: str(b?.formula) || null,
            data_source: null,
            unit: str(b?.unit) || "%",
            frequency: str(b?.frequency) || "monthly",
            threshold_green: num(b?.threshold_green, 0),
            threshold_amber: num(b?.threshold_amber, 0),
            threshold_red: num(b?.threshold_red, 0),
            threshold_direction: str(b?.threshold_direction) || "higher_is_better",
            target_value: num(b?.target_value, null),
            weight: 1.0,
            is_active: true,
            is_north_star: false,
            calc_mode: "manual",
          } as any);
          logger.info("[QualityReports] KPI created", {
            actor: user.email, buKey, kpi_code, owner: bu.kpi_owner_name,
          });
          return c.json({ success: true, kpi });
        } catch (e: any) {
          if (e?.code === "23505") {
            return c.json({ error: "That KPI code already exists." }, 409);
          }
          logger.error("[QualityReports] create kpi", e);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/vitest/qualityReportsKpiCreate.vitest.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Add the Add KPI button**

In `dashboard/js/quality-reports.js`, in `qrKpisHtml`, add the button to the header line. Insert directly before the `var rows = list.map(...)` assignment:

```js
        // Department KPIs live only here now, so this page must be able to
        // create them. Owner is set server-side from the BU mapping.
        if (k && k.owner) {
            out.push('<div class="mb-2"><button type="button" class="rr-btn rr-btn-ghost" data-on-click="qrAddKpi" data-args="' +
                escAttr(JSON.stringify([qrCurrentBUKey, k.owner])) + '">+ Add KPI</button></div>');
        }
```

- [ ] **Step 7: Track the open BU key**

`qrKpisHtml` has no access to the BU key. At the top of the IIFE, beside `var qrCurrentBUs = [];`, add:

```js
    // The BU currently open in the detail view — qrKpisHtml needs it to scope
    // the Add KPI action, and it is not part of the sections payload.
    var qrCurrentBUKey = null;
```

and set it as the first statement inside `window.qrOpenBU`:

```js
    window.qrOpenBU = async function (buKey) {
        qrCurrentBUKey = buKey;
```

- [ ] **Step 8: Add the modal and submit handler**

Append inside the IIFE, before the `DOMContentLoaded` listener:

```js
    window.qrAddKpi = function (buKey, ownerName) {
        var host = document.getElementById('qrKpiModal');
        if (!host) { host = document.createElement('div'); host.id = 'qrKpiModal'; document.body.appendChild(host); }
        var f = function (id, label, value, type) {
            return '<label class="text-xs text-gray-600 block mb-2">' + escapeHtml(label) +
                '<input id="' + escAttr(id) + '" type="' + (type || 'text') + '" value="' + escAttr(value || '') +
                '" class="mt-1 w-full border rounded px-2 py-1 text-sm"></label>';
        };
        host.innerHTML = '<div class="rr-modal-backdrop"><div class="rr-modal">' +
            '<div class="font-semibold mb-1">Add KPI</div>' +
            '<div class="text-xs text-gray-500 mb-3">Owner: ' + escapeHtml(ownerName) + ' (set automatically)</div>' +
            f('qrk-name', 'KPI name', '') +
            f('qrk-code', 'KPI code (e.g. SDR-KPI-12)', '') +
            f('qrk-cat', 'Category', 'quality') +
            f('qrk-unit', 'Unit', '%') +
            f('qrk-target', 'Target value', '', 'number') +
            f('qrk-green', 'Green threshold', '', 'number') +
            f('qrk-amber', 'Amber threshold', '', 'number') +
            f('qrk-red', 'Red threshold', '', 'number') +
            '<label class="text-xs text-gray-600 block mb-2">Direction' +
            '<select id="qrk-dir" class="mt-1 w-full border rounded px-2 py-1 text-sm">' +
            '<option value="higher_is_better">Higher is better</option>' +
            '<option value="lower_is_better">Lower is better</option></select></label>' +
            '<div id="qrk-err" class="text-xs text-red-600 mb-2"></div>' +
            '<div class="flex gap-2 mt-2">' +
            '<button type="button" class="rr-btn rr-btn-primary" data-on-click="qrAddKpiSave" data-args="' + escAttr(JSON.stringify([buKey])) + '">Create</button>' +
            '<button type="button" class="rr-btn rr-btn-ghost" data-on-click="qrAddKpiClose">Cancel</button>' +
            '</div></div></div>';
    };

    window.qrAddKpiClose = function () {
        var h = document.getElementById('qrKpiModal');
        if (h) h.innerHTML = '';
    };

    window.qrAddKpiSave = async function (buKey) {
        var err = document.getElementById('qrk-err');
        var payload = {
            kpi_name: qrVal('qrk-name'), kpi_code: qrVal('qrk-code'),
            category: qrVal('qrk-cat'), unit: qrVal('qrk-unit'),
            target_value: qrVal('qrk-target'), threshold_green: qrVal('qrk-green'),
            threshold_amber: qrVal('qrk-amber'), threshold_red: qrVal('qrk-red'),
            threshold_direction: qrVal('qrk-dir')
        };
        try {
            var res = await fetch('/api/quality-reports/bus/' + encodeURIComponent(buKey) + '/kpis', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
            });
            var d = await res.json().catch(function () { return {}; });
            if (!res.ok) { if (err) err.textContent = d.error || ('HTTP ' + res.status); return; }
            qrAddKpiClose();
            qrOpenBU(buKey);
        } catch (e) {
            if (err) err.textContent = String((e && e.message) || e);
        }
    };
```

`qrVal` already exists in this file and reads a trimmed input value; `qrk-dir` is a `<select>`, whose `.value` it reads the same way.

- [ ] **Step 9: Bump the script version**

In `dashboard/quality-reports.html`, increment the `quality-reports.js` `?v=` again (read the current value and add one).

- [ ] **Step 10: Verify**

Run: `npm run check:all`
Expected: all gates pass.

- [ ] **Step 11: Commit**

```bash
git add src/utils/kpiDatabase.ts src/mastra/routes/qualityReportsRoutes.ts dashboard/js/quality-reports.js dashboard/quality-reports.html tests/vitest/qualityReportsKpiCreate.vitest.test.ts
git commit -m "feat(quality-reports): create a department KPI from its BU page"
```

---

## Post-implementation verification (run against the deployed app)

These cannot be checked from a dev machine — they need the live database. Run after republishing.

- [ ] `/kpis` shows no `SDR-KPI-*` or `SALES-KPI-*`; the owner donut has no SDR Team / Sales Team slice.
- [ ] `/quality-reports?bu=sdr_b2b` still lists all 11 SDR KPIs; clicking one opens its `/kpi/:id` page.
- [ ] **The regression that matters:** click **Recalculate** on `/kpis`, then reload the SDR B2B page — the Auto KPIs (e.g. SDR-KPI-01 Calls Per Day) must still show values, not `--`. If they go blank, the filter was placed in the data layer instead of the presentation layer.
- [ ] The CSV and Excel exports contain no department KPIs, and the xlsx summary counts match its row sheets.
- [ ] Add a KPI from the SDR B2B page — it appears there and NOT in `/kpis`.

---

### Task 7: Remove the department teams from the KPI Engine's owner controls

**Added 2026-08-16 after the deployed `/kpis` page showed "SDR Team" / "Sales Team" still selectable.** Tasks 2-4 remove department KPIs from the engine's *data*; `dashboard/kpis.html` still hardcodes the teams in three owner controls. Two of them are traps rather than clutter: they let a user put a KPI into a state where it immediately disappears from the page they are looking at.

**Files:**
- Modify: `dashboard/kpis.html` — three locations (lines ~160-161, ~213-214, ~412-413)

**Interfaces:**
- Consumes: nothing. Pure markup/constant removal, no API change.
- Produces: nothing for later tasks.

- [ ] **Step 1: Remove the teams from the KPI Catalog owner filter**

At lines ~160-161, inside `<select id="ownerFilter">`, delete exactly these two lines:

```html
                        <option value="sdr_team">SDR Team</option>
                        <option value="sales_team">Sales Team</option>
```

Leave `All Owners`, the four GRQ owners, and `GRQ Team (Shared)` untouched. Selecting a department team here would now return an empty list, since Task 2 filters them out of `GET /api/kpis`.

- [ ] **Step 2: Remove the teams from the create/edit KPI form**

At lines ~213-214, inside `<select id="kpiOwnerType">`, delete exactly these two lines:

```html
                            <option value="sdr_team">SDR Team</option>
                            <option value="sales_team">Sales Team</option>
```

A KPI created here under a department team would be filtered straight back out of this page. Department KPIs are created on their Quality Reports BU page instead (Task 6).

- [ ] **Step 3: Remove the teams from the detail modal's "Reassign to…" options**

At lines ~412-413, in the `_KPI_OWNER_OPTIONS` array, delete exactly these two entries:

```js
            ['sdr_team', 'SDR Team'],
            ['sales_team', 'Sales Team'],
```

Reassigning a KPI to a department team from here would make it vanish from this page with no explanation.

**Do NOT touch** the `ownerTypeLabel`-style `switch` statements at lines ~387-389 and ~400-402 that map `sdr_team`/`sales_team` to display strings. Those are read paths: a department KPI still renders on its BU page and on `/kpi/:id`, and removing the mappings would show a raw enum value instead of a name.

- [ ] **Step 4: Verify no other hardcoded reference remains in the engine's controls**

Run:

```bash
grep -n "sdr_team\|sales_team" dashboard/kpis.html
```

Expected: ONLY the label-mapping `switch` cases (~387-389, ~400-402) remain. No `<option>` elements and no `_KPI_OWNER_OPTIONS` entries.

- [ ] **Step 5: Verify the page still parses**

Run: `npm run check:all`
Expected: all gates pass, including `check-dashboard-html-js`.

- [ ] **Step 6: Commit**

```bash
git add dashboard/kpis.html
git commit -m "feat(kpis): drop department teams from the KPI Engine owner controls"
```
