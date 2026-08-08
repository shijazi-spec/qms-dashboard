# Quality Reports — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three deferred Quality Reports items: a segment-scoped deal-compliance rollup for Sales, `?bu=` deep-linking, and a lazy per-card hub status line.

**Architecture:** Two new cheap DB summary functions (deal-compliance rollup + segment deal-dup count) mirroring the existing `getSegmentLeadDuplicateCount`; a lightweight `getBUHeadline` aggregator + a `/summary` route; and UI changes (deal-compliance card, deep-link, lazy card status lines). No schema changes.

**Tech Stack:** TypeScript, Postgres via `pool` (pg), Hono routes, vanilla-JS dashboard, Vitest (type-checked locally; run in CI).

## Global Constraints

- Builds on Phase 1 (shipped `d8aae8f4`). Files: `src/utils/duplicateRadarDatabase.ts` (DRD), `src/utils/qualityReportsAggregator.ts`, `src/mastra/routes/qualityReportsRoutes.ts`, `src/utils/rbacMiddleware.ts`, `dashboard/quality-reports.html`, `dashboard/js/quality-reports.js`.
- Segment scoping: `buildSegmentPredicate` + normalize legacy `corporate→walaplus`, exactly as `getSegmentLeadDuplicateCount` (DRD:2544) does.
- `functionReportKeys("sales")` becomes `["deals", "deal_compliance", "stage_aging"]` again (was reduced to `["deals","stage_aging"]` in Phase 1); the compliance section's enabled-predicate must include `|| k === "deal_compliance"` again.
- Deal-compliance rollup counts ONLY doc-checked deals (rows in `deal_doc_compliance`); when `checked===0` the UI shows "No deals checked yet", never "0%".
- Hub status line is LAZY per-card and uses ONLY cheap counts — never the heavy violation scans (`scanCsLifecycleViolations`/`scanDealStageAgingViolations`/`getDataCleaningProgress`).
- Status-line metrics that come from an unmapped field render as **omitted** (null), not zero. `outstanding` is always available (segment-based).
- CSP: no inline `style=""` anywhere (incl. JS-built innerHTML); accents only from `rr-acc-{blue,amber,red,teal,indigo,yellow,purple,green,sky,rose}`. Dynamic text via `escapeHtml`, attributes via `escAttr`.
- **vitest CANNOT run locally** (no `vite`). WRITE the vitest files (CI + `tsc -p tsconfig.tests.json`), verify pure logic via tsc-CJS-emit + node. Verify commands: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`; `node node_modules/typescript/bin/tsc -p tsconfig.tests.json`; `node scripts/check-dashboard-html-js.mjs`; `node --check <file.js>`. The global `tsc` is a wrong stub.
- **Commit ONLY your task's files** with explicit `git add <paths>` — NEVER `git add -A` (a parallel agent has unrelated uncommitted/untracked work in this workspace; never stage it). Do NOT push (controller pushes after final review).
- Deploy note: `dashboard/quality-reports.html` loads `js/quality-reports.js?v=2` — bump to `?v=3` in the UI task.

---

### Task 1: DB summaries — deal-compliance rollup + segment deal-dup count

**Files:**
- Modify: `src/utils/duplicateRadarDatabase.ts` (add two exported functions near `getSegmentLeadDuplicateCount`, DRD:2544)
- Test: `tests/vitest/qualityReportsDealCompliance.vitest.test.ts`

**Interfaces:**
- Consumes: `buildSegmentPredicate`, `pool`, `DuplicateFilters` (all already in DRD).
- Produces:
  - `getSegmentDealComplianceSummary(segment): Promise<{ segment: string; checked: number; compliant: number; compliant_rate: number | null }>`
  - `getSegmentDealDuplicateCount(segment): Promise<{ segment: string; outstanding_deals: number }>`

- [ ] **Step 1: Write the failing test (mocked pool via redactedPool)**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../src/utils/redactedPool", () => ({
  createRedactedPool: () => ({ query: (...a: any[]) => query(...a), connect: async () => ({ query: (...a: any[]) => query(...a), release: () => {} }) }),
}));
vi.mock("../../src/utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import { getSegmentDealComplianceSummary, getSegmentDealDuplicateCount } from "../../src/utils/duplicateRadarDatabase";
beforeEach(() => query.mockReset());

describe("getSegmentDealComplianceSummary", () => {
  it("joins deal_doc_compliance to duplicate_records and computes rate", async () => {
    query.mockResolvedValue({ rows: [{ checked: 10, compliant: 7 }] });
    const out = await getSegmentDealComplianceSummary("walaplus");
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("deal_doc_compliance");
    expect(sql).toContain("duplicate_records");
    expect(sql).toContain("compliant");
    expect(out.checked).toBe(10);
    expect(out.compliant).toBe(7);
    expect(out.compliant_rate).toBe(70);
  });
  it("rate is null when nothing checked", async () => {
    query.mockResolvedValue({ rows: [{ checked: 0, compliant: 0 }] });
    const out = await getSegmentDealComplianceSummary("walaone");
    expect(out.checked).toBe(0);
    expect(out.compliant_rate).toBeNull();
  });
});
describe("getSegmentDealDuplicateCount", () => {
  it("counts non-primary deal members of active >1 clusters", async () => {
    query.mockResolvedValue({ rows: [{ n: "12" }] });
    const out = await getSegmentDealDuplicateCount("walaplus");
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("record_type = 'deal'");
    expect(sql).toContain("total_deals > 1");
    expect(out.outstanding_deals).toBe(12);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.tests.json`
Expected: compile error — functions not exported.

- [ ] **Step 3: Implement both functions** (insert right after `getSegmentLeadDuplicateCount` ends, ~DRD:2559)

```ts
/** Deal doc-compliance rolled up to a segment (join to duplicate_records layout).
 *  Counts ONLY deals that have been doc-checked (rows in deal_doc_compliance). */
export async function getSegmentDealComplianceSummary(
  segment: DuplicateFilters["segment"],
): Promise<{ segment: string; checked: number; compliant: number; compliant_rate: number | null }> {
  const seg = segment && segment !== "all" ? (segment === "corporate" ? "walaplus" : segment) : "all";
  const p = buildSegmentPredicate(seg, 1);
  const segCond = p.condition ? " AND " + p.condition : "";
  const res = await pool.query(
    `SELECT COUNT(*)::int AS checked,
            COUNT(*) FILTER (WHERE d.compliant)::int AS compliant
       FROM deal_doc_compliance d
       JOIN duplicate_records r ON r.zoho_record_id = d.zoho_deal_id
      WHERE r.record_type = 'deal'${segCond}`,
    [...p.params],
  );
  const checked = Number(res.rows[0]?.checked) || 0;
  const compliant = Number(res.rows[0]?.compliant) || 0;
  return { segment: seg, checked, compliant, compliant_rate: checked ? Math.round((100 * compliant) / checked) : null };
}

/** Outstanding duplicate DEALS in a segment — mirrors getSegmentLeadDuplicateCount. */
export async function getSegmentDealDuplicateCount(
  segment: DuplicateFilters["segment"],
): Promise<{ segment: string; outstanding_deals: number }> {
  const seg = segment && segment !== "all" ? (segment === "corporate" ? "walaplus" : segment) : "all";
  const p = buildSegmentPredicate(seg, 1);
  const segCond = p.condition ? " AND " + p.condition : "";
  const res = await pool.query(
    `SELECT COUNT(*)::text AS n
       FROM duplicate_records r
       JOIN duplicate_clusters dc ON dc.id = r.cluster_id
      WHERE r.record_type = 'deal' AND dc.status = 'active'
        AND dc.total_deals > 1 AND r.is_primary = false${segCond}`,
    [...p.params],
  );
  return { segment: seg, outstanding_deals: Number(res.rows[0]?.n) || 0 };
}
```

- [ ] **Step 4: Verify**

Run: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → exit 0.
Run: `node node_modules/typescript/bin/tsc -p tsconfig.tests.json` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/utils/duplicateRadarDatabase.ts tests/vitest/qualityReportsDealCompliance.vitest.test.ts
git commit -m "feat(quality-reports): segment deal-compliance rollup + deal-dup count"
```

---

### Task 2: Aggregator — wire deal_compliance back + `getBUHeadline`

**Files:**
- Modify: `src/utils/qualityReportsAggregator.ts`
- Test: `tests/vitest/qualityReportsAggregator.vitest.test.ts` (the existing pinned test — update the `sales` assertion)

**Interfaces:**
- Consumes: `getSegmentDealComplianceSummary`, `getSegmentDealDuplicateCount`, `getSegmentLeadDuplicateCount` (DRD); `getBUByKey`, `QualityReportBU` (qualityReportsDepartments); `getAllPolicies` (policyDatabase), `getFrameworkProgressByBU` (kpiChecklistDatabase), `getCapaRecords` (qmsDatabase).
- Produces:
  - `functionReportKeys("sales")` → `["deals","deal_compliance","stage_aging"]`
  - `interface BUHeadline { bu_key: string; sops: number | null; kpiPct: number | null; outstanding: number; openCapas: number | null }`
  - `getBUHeadline(buKey): Promise<BUHeadline | null>` (null when BU doesn't exist)

- [ ] **Step 1: Update the pinned `functionReportKeys` test** — in `tests/vitest/qualityReportsAggregator.vitest.test.ts`, change the `sales` assertion:
```ts
    expect(functionReportKeys("sales")).toEqual(["deals", "deal_compliance", "stage_aging"]);
```
(Leave sdr/cs/partnersuccess/partnership/onboarding/unknown assertions unchanged.)

- [ ] **Step 2: Re-add deal_compliance to `functionReportKeys` + the compliance predicate + section body**

In `src/utils/qualityReportsAggregator.ts`:
- `functionReportKeys`: `case "sales": return ["deals", "deal_compliance", "stage_aging"];` (remove the Phase-1 "deferred" comment).
- Compliance section enabled-predicate: restore `|| k === "deal_compliance"`:
```ts
  const compliance = await section("compliance", keys.some((k) => k.startsWith("cs_lifecycle") || k === "deal_compliance" || k === "stage_aging"), async () => {
    const out: any = {};
    if (keys.includes("cs_lifecycle") || keys.includes("cs_lifecycle_onboarding")) {
      out.cs = await DRD.scanCsLifecycleViolations({ segment: bu.segment });
      if (keys.includes("cs_lifecycle_onboarding")) out.phaseFocus = "Onboarding";
    }
    if (keys.includes("deal_compliance")) out.dealCompliance = await DRD.getSegmentDealComplianceSummary(bu.segment);
    if (keys.includes("stage_aging")) out.stageAging = await DRD.scanDealStageAgingViolations({ segment: bu.segment });
    return out;
  }, notConfigured);
```

- [ ] **Step 3: Add `getBUHeadline`** (append to `qualityReportsAggregator.ts`)

```ts
export interface BUHeadline {
  bu_key: string;
  sops: number | null;
  kpiPct: number | null;
  outstanding: number;
  openCapas: number | null;
}

/** Cheap per-BU headline for the hub cards — counts only, NO heavy violation scans. */
export async function getBUHeadline(buKey: string): Promise<BUHeadline | null> {
  const bu = await getBUByKey(buKey);
  if (!bu) return null;
  const DRD = await import("./duplicateRadarDatabase");
  const policyDb = await import("./policyDatabase");
  const kpiDb = await import("./kpiChecklistDatabase");
  const qmsDb = await import("./qmsDatabase");

  const safe = async <T>(run: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await run(); } catch { return fallback; }
  };

  // SOPs count (null if unmapped).
  const sops = bu.policy_department
    ? await safe(async () => (await policyDb.getAllPolicies({ owner_department: bu.policy_department as string } as any)).policies.length, null as number | null)
    : null;

  // KPI pct (null if unmapped).
  const kpiPct = bu.kpi_bu_name
    ? await safe(async () => {
        const all = await kpiDb.getFrameworkProgressByBU();
        const e = all[bu.kpi_bu_name as string];
        return e ? e.pct : null;
      }, null as number | null)
    : null;

  // Outstanding dup count — leads for sdr, deals otherwise. Always available.
  const outstanding = await safe(async () => {
    if (bu.fn === "sdr") return (await DRD.getSegmentLeadDuplicateCount(bu.segment)).outstanding_leads;
    return (await DRD.getSegmentDealDuplicateCount(bu.segment)).outstanding_deals;
  }, 0);

  // Open CAPAs for this BU's owners (null if no owners mapped).
  const openCapas = bu.owners.length
    ? await safe(async () => {
        const owners = new Set(bu.owners.map((o) => o.toLowerCase()));
        const res = await qmsDb.getCapaRecords({ status: "open", limit: 5000 });
        return (res.records || []).filter((r: any) => r.assigned_to && owners.has(String(r.assigned_to).toLowerCase())).length;
      }, null as number | null)
    : null;

  return { bu_key: bu.bu_key, sops, kpiPct, outstanding, openCapas };
}
```

- [ ] **Step 4: Verify + run the pinned pure test via CJS-emit**

Run: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → exit 0.
Run: `node node_modules/typescript/bin/tsc -p tsconfig.tests.json` → exit 0.
Run:
```bash
node node_modules/typescript/bin/tsc src/utils/qualityReportsAggregator.ts src/utils/qualityReportsDepartments.ts --outDir _qr --module commonjs --moduleResolution node --target es2022 --skipLibCheck --esModuleInterop --rootDir src/utils >/dev/null 2>&1; echo '{"type":"commonjs"}' > _qr/package.json; node -e 'const m=require("./_qr/qualityReportsAggregator.js"); const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b); console.log(eq(m.functionReportKeys("sales"),["deals","deal_compliance","stage_aging"]) ? "PASS":"FAIL")'; rm -rf _qr
```
Expected: `PASS`.

- [ ] **Step 5: Commit**

```bash
git add src/utils/qualityReportsAggregator.ts tests/vitest/qualityReportsAggregator.vitest.test.ts
git commit -m "feat(quality-reports): wire deal-compliance into aggregator + getBUHeadline"
```

---

### Task 3: `/summary` route + RBAC

**Files:**
- Modify: `src/mastra/routes/qualityReportsRoutes.ts` (add one route)
- Modify: `src/utils/rbacMiddleware.ts` (add one allowlist entry)

**Interfaces:**
- Consumes: `getBUHeadline` (Task 2).
- Produces: `GET /api/quality-reports/bus/:buKey/summary` → `{ success: true, ...BUHeadline }` (404 when null).

- [ ] **Step 1: Add the route** — in `qualityReportsRoutes.ts`, add after the existing `GET /api/quality-reports/bus/:buKey` route object (mirror its gate + error shape; note the handler imports `getBUHeadline`):
```ts
  {
    path: "/api/quality-reports/bus/:buKey/summary",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, READ_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);
          const { getBUHeadline } = await import("../../utils/qualityReportsAggregator");
          const h = await getBUHeadline(c.req.param("buKey"));
          if (!h) return c.json({ error: "Not found" }, 404);
          return c.json({ success: true, ...h });
        } catch (error: any) {
          logger.error("Error building BU headline:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
```
(Confirm `getBUHeadline` is exported from `qualityReportsAggregator` and that the file already imports `getBUReport` similarly — add `getBUHeadline` to that import or dynamic-import as shown. Match the existing route's `requireRole`/`READ_ROLES` usage exactly.)

- [ ] **Step 2: Add the RBAC entry** — in `rbacMiddleware.ts`, next to the other `/quality-reports` entries. The existing `/^\/api\/quality-reports\/bus\/[^/]+$/` rule does NOT match the `/summary` suffix, so this is required:
```ts
  {
    pattern: /^\/api\/quality-reports\/bus\/[^/]+\/summary$/,
    methods: ["GET"],
    roles: ["admin","ai_specialist","auditor","bu_owner","custom","department_viewer","executive","grc_manager","head_of_operations_quality","quality_manager","quality_specialist","team_lead","viewer"],
  },
```

- [ ] **Step 3: Verify**

Run: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/mastra/routes/qualityReportsRoutes.ts src/utils/rbacMiddleware.ts
git commit -m "feat(quality-reports): GET /bus/:buKey/summary + RBAC"
```

---

### Task 4: UI — deal-compliance card, deep-link, lazy hub status line

**Files:**
- Modify: `dashboard/js/quality-reports.js`
- Modify: `dashboard/quality-reports.html` (bump `?v=2` → `?v=3`)

**Interfaces:**
- Consumes: `GET /api/quality-reports/bus/:buKey/summary`; the compliance section now includes `sections.compliance.dealCompliance = { checked, compliant, compliant_rate }`.

- [ ] **Step 1: Render deal-compliance in the compliance section.** In `quality-reports.js`, in the function that builds the compliance HTML (the one reading `c.cs` / `c.stageAging`), add a deal-docs line:
```js
  if (c.dealCompliance) {
    var dc = c.dealCompliance;
    if (dc.checked > 0) {
      out.push('<div class="text-sm">Deal docs: ' + (dc.compliant || 0) + '/' + dc.checked + ' compliant (' + (dc.compliant_rate == null ? '—' : dc.compliant_rate + '%') + ') <span class="rr-sub">of checked deals</span></div>');
    } else {
      out.push('<div class="text-sm rr-sub">Deal docs: no deals checked yet</div>');
    }
  }
```
(Place it alongside the existing `c.cs` / `c.stageAging` lines; keep the same `out` array pattern. All values are numbers — no escaping needed, but if you interpolate any string use `escapeHtml`.)

- [ ] **Step 2: Deep-link `?bu=`.** At the end of `qrLoadHub` (after the grid renders and `qrCurrentBUs` is populated), open a BU if the URL requests one:
```js
  // Deep-link: ?bu=<key> opens that BU directly.
  var params = new URLSearchParams(window.location.search);
  var wantBU = params.get('bu');
  if (wantBU && qrCurrentBUs.some(function(b){ return b.bu_key === wantBU; })) {
    qrOpenBU(wantBU);
  }
```
In `qrOpenBU(buKey)`, after showing the BU view, reflect it in the URL (no reload):
```js
  try { history.replaceState(null, '', '?bu=' + encodeURIComponent(buKey)); } catch (e) {}
```
In `qrBackToHub`, clear the query:
```js
  try { history.replaceState(null, '', window.location.pathname); } catch (e) {}
```

- [ ] **Step 3: Lazy hub status line.** In `qrLoadHub`, give each hub card an empty status container with an id, then fetch each card's summary after render. Where the card HTML is built, add a status div: `'<div class="rr-sub" id="qr-hubline-' + escAttr(b.bu_key) + '"></div>'`. After setting the grid `innerHTML`, loop:
```js
  qrCurrentBUs.forEach(function(b){
    fetch('/api/quality-reports/bus/' + encodeURIComponent(b.bu_key) + '/summary', { credentials: 'same-origin' })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(h){
        if (!h) return;
        var el = document.getElementById('qr-hubline-' + b.bu_key);
        if (!el) return;
        var parts = [];
        if (h.kpiPct != null) parts.push('KPIs ' + h.kpiPct + '%');
        parts.push((h.outstanding || 0) + ' outstanding');
        if (h.openCapas != null) parts.push(h.openCapas + ' open CAPAs');
        el.textContent = parts.join(' · ');
      })
      .catch(function(){});
  });
```
(Use `textContent` — no HTML injection. `escAttr` on the id template only. The line omits KPIs/CAPAs when null, always shows outstanding.)

- [ ] **Step 4: Bump the cache-buster** — `dashboard/quality-reports.html`: `quality-reports.js?v=2` → `?v=3`.

- [ ] **Step 5: Verify**

Run: `node --check dashboard/js/quality-reports.js` → no error (add `&& echo JS-OK`).
Run: `node scripts/check-dashboard-html-js.mjs` → PASS.

- [ ] **Step 6: Commit**

```bash
git add dashboard/js/quality-reports.js dashboard/quality-reports.html
git commit -m "feat(quality-reports): deal-compliance card + deep-link + lazy hub status line"
```

---

### Task 5: Ship

- [ ] **Step 1:** `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (exit 0), `node node_modules/typescript/bin/tsc -p tsconfig.tests.json` (exit 0), `node scripts/check-dashboard-html-js.mjs` (PASS), `node --check dashboard/js/quality-reports.js`.
- [ ] **Step 2:** `git pull --rebase --autostash origin QMS` then `git push origin QMS`.
- [ ] **Step 3:** Tell the user: Pull → Republish; Sales BU pages show a deal-docs line; `?bu=<key>` opens a BU directly; hub cards fill their status lines.

## Self-Review notes

- **Spec coverage:** §2 deal-compliance rollup → Task 1 (`getSegmentDealComplianceSummary`) + Task 2 (functionReportKeys/compliance wiring) + Task 4 Step 1 (UI + checked===0 caveat). §3 deep-link → Task 4 Step 2. §4 hub status line (lazy, cheap, omit-null) → Task 1 (`getSegmentDealDuplicateCount`) + Task 2 (`getBUHeadline`) + Task 3 (`/summary` route + RBAC) + Task 4 Step 3. §6 testing → Tasks 1-2 vitest + CJS-emit. §7 deploy + `?v=` bump → Task 4 Step 4 + Task 5.
- **Placeholder scan:** none. The "confirm the import" notes name the exact symbol/file to check, not vague TODOs.
- **Type consistency:** `getSegmentDealComplianceSummary`/`getSegmentDealDuplicateCount` (Task 1) consumed in Task 2's `getBUHeadline` + compliance section. `BUHeadline`/`getBUHeadline` (Task 2) consumed in Task 3 route + Task 4 client. `sections.compliance.dealCompliance` shape (Task 2) matches Task 4 Step 1 render. `bu.fn`/`bu.segment`/`bu.owners`/`bu.policy_department`/`bu.kpi_bu_name` are real `QualityReportBU` fields (Phase-1 Task 2).
