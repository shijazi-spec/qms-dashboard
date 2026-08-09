# Deal-Compliance Full Breakdown — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the Sales BU report's deal-compliance figure into a full breakdown — at-risk SAR, by-stage, by-owner (top 10), and top missing document types — on the BU page and (condensed) in the email-to-head.

**Architecture:** A pure `shapeDealCompliance` aggregator over per-deal rows; `getSegmentDealComplianceSummary` fetches the rows and returns the fuller (superset) object; the BU page and email renderers expand to show the breakdown. No new engine, no schema change.

**Tech Stack:** TypeScript, Postgres via `pool` (pg), vanilla-JS dashboard, Vitest (type-checked locally; run in CI).

## Global Constraints

- Builds on Quality Reports Phase 2/3. Files: `src/utils/dealComplianceReport.ts` (new), `src/utils/duplicateRadarDatabase.ts` (DRD, `getSegmentDealComplianceSummary` at :2563), `dashboard/js/quality-reports.js` (`qrComplianceHtml` at :391), `src/utils/qualityReportsEmail.ts` (`renderBUReportEmailHtml` compliance section at :45), `dashboard/quality-reports.html` (`?v=` bump).
- Return of `getSegmentDealComplianceSummary` becomes a SUPERSET of the current `{segment, checked, compliant, compliant_rate}` — never remove those fields (the aggregator + Phase-2/3 renderers still read them).
- `compliant_rate` = `checked ? round(100*compliant/checked) : null` — **null, never 0**, when nothing checked.
- `at_risk_sar` = Σ deal amount of NON-compliant checked deals only.
- `by_owner` = top 10 by `missing` desc, with `owner_overflow` = remaining owner count ("N more"). Owner falls back to "Unassigned".
- **Email = condensed** (headline + at-risk + by-stage + top-3 missing docs); the full by-owner table is **page-only**.
- CSP: dashboard markup is class-only, no inline `style=""`; email HTML uses inline styles (email requirement — the email builder file only). Dynamic text via `escapeHtml` (page) / `escHtml` (email); numeric values interpolated directly are safe.
- **vitest CANNOT run locally** (no `vite`). WRITE the vitest files; verify pure logic via tsc-CJS-emit + node. Verify: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`; `node node_modules/typescript/bin/tsc -p tsconfig.tests.json`; `node scripts/check-dashboard-html-js.mjs`; `node --check <file.js>`. Global `tsc` is a wrong stub.
- **Commit ONLY your task's files** with explicit `git add <paths>` — NEVER `git add -A` (a parallel agent has unrelated uncommitted/untracked work). Do NOT push (controller pushes after final review).
- UI task bumps `dashboard/quality-reports.html`: `js/quality-reports.js?v=4` → `?v=5`.

---

### Task 1: Pure shaper `shapeDealCompliance`

**Files:**
- Create: `src/utils/dealComplianceReport.ts`
- Test: `tests/vitest/dealComplianceReport.vitest.test.ts`

**Interfaces:**
- Produces:
  - `interface DealComplianceRow { stage: string; compliant: boolean; amount: number; owner: string; missing_docs: Array<{ key?: string; label?: string }> | null }`
  - `interface DealComplianceSummary { segment: string; checked: number; compliant: number; compliant_rate: number | null; at_risk_sar: number; by_stage: Array<{stage:string;checked:number;compliant:number;missing:number}>; by_owner: Array<{owner:string;checked:number;compliant:number;missing:number}>; owner_overflow: number; top_missing_docs: Array<{label:string;count:number}> }`
  - `function shapeDealCompliance(segment: string, rows: DealComplianceRow[]): DealComplianceSummary`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { shapeDealCompliance } from "../../src/utils/dealComplianceReport";

const rows = [
  { stage: "Agreement Signed", compliant: false, amount: 100, owner: "Ali", missing_docs: [{ key: "vat", label: "VAT Certificate" }, { key: "cr", label: "Commercial Registration (CR)" }] },
  { stage: "Agreement Signed", compliant: true, amount: 50, owner: "Ali", missing_docs: [] },
  { stage: "Proposal", compliant: false, amount: 200, owner: "", missing_docs: [{ key: "financial_offer", label: "Financial offer / proposal" }] },
  { stage: "Agreement Signed", compliant: false, amount: 300, owner: "Sara", missing_docs: [{ key: "vat", label: "VAT Certificate" }] },
];

describe("shapeDealCompliance", () => {
  it("aggregates totals, at-risk, stage/owner, and top missing docs", () => {
    const out = shapeDealCompliance("walaplus", rows);
    expect(out.checked).toBe(4);
    expect(out.compliant).toBe(1);
    expect(out.compliant_rate).toBe(25);
    expect(out.at_risk_sar).toBe(600); // 100 + 200 + 300 (non-compliant only)
    // by_stage sorted by missing desc: Agreement Signed (2 missing) before Proposal (1)
    expect(out.by_stage[0].stage).toBe("Agreement Signed");
    expect(out.by_stage[0].missing).toBe(2);
    // owner "" falls back to Unassigned
    expect(out.by_owner.some((o) => o.owner === "Unassigned")).toBe(true);
    // top missing: VAT appears twice → first
    expect(out.top_missing_docs[0]).toEqual({ label: "VAT Certificate", count: 2 });
  });
  it("compliant_rate is null when nothing checked", () => {
    const out = shapeDealCompliance("walaone", []);
    expect(out.checked).toBe(0);
    expect(out.compliant_rate).toBeNull();
    expect(out.at_risk_sar).toBe(0);
  });
  it("caps by_owner at 10 and reports overflow", () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ stage: "Agreement Signed", compliant: false, amount: 10, owner: "owner" + i, missing_docs: [{ key: "vat", label: "VAT Certificate" }] }));
    const out = shapeDealCompliance("walaplus", many);
    expect(out.by_owner.length).toBe(10);
    expect(out.owner_overflow).toBe(3);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.tests.json`
Expected: module/function not found.

- [ ] **Step 3: Implement**

```ts
export interface DealComplianceRow {
  stage: string;
  compliant: boolean;
  amount: number;
  owner: string;
  missing_docs: Array<{ key?: string; label?: string }> | null;
}
export interface DealComplianceSummary {
  segment: string;
  checked: number;
  compliant: number;
  compliant_rate: number | null;
  at_risk_sar: number;
  by_stage: Array<{ stage: string; checked: number; compliant: number; missing: number }>;
  by_owner: Array<{ owner: string; checked: number; compliant: number; missing: number }>;
  owner_overflow: number;
  top_missing_docs: Array<{ label: string; count: number }>;
}

/** PURE aggregation of per-deal doc-compliance rows into the BU report shape. */
export function shapeDealCompliance(segment: string, rows: DealComplianceRow[]): DealComplianceSummary {
  let checked = 0, compliant = 0, atRisk = 0;
  const byStage = new Map<string, { checked: number; compliant: number }>();
  const byOwner = new Map<string, { checked: number; compliant: number }>();
  const missing = new Map<string, number>();

  for (const r of rows || []) {
    checked++;
    const isC = r.compliant === true;
    if (isC) compliant++; else atRisk += Number(r.amount) || 0;

    const st = (r.stage && String(r.stage).trim()) || "Unknown";
    const s = byStage.get(st) || { checked: 0, compliant: 0 };
    s.checked++; if (isC) s.compliant++; byStage.set(st, s);

    const ow = (r.owner && String(r.owner).trim()) || "Unassigned";
    const o = byOwner.get(ow) || { checked: 0, compliant: 0 };
    o.checked++; if (isC) o.compliant++; byOwner.set(ow, o);

    if (!isC && Array.isArray(r.missing_docs)) {
      for (const m of r.missing_docs) {
        const lbl = (m && m.label && String(m.label).trim()) || (m && m.key ? String(m.key) : "Unknown");
        missing.set(lbl, (missing.get(lbl) || 0) + 1);
      }
    }
  }

  const by_stage = Array.from(byStage, ([stage, v]) => ({ stage, checked: v.checked, compliant: v.compliant, missing: v.checked - v.compliant }))
    .sort((a, b) => b.missing - a.missing);
  const allOwners = Array.from(byOwner, ([owner, v]) => ({ owner, checked: v.checked, compliant: v.compliant, missing: v.checked - v.compliant }))
    .sort((a, b) => b.missing - a.missing);
  const by_owner = allOwners.slice(0, 10);
  const owner_overflow = Math.max(0, allOwners.length - by_owner.length);
  const top_missing_docs = Array.from(missing, ([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);

  return {
    segment, checked, compliant,
    compliant_rate: checked ? Math.round((100 * compliant) / checked) : null,
    at_risk_sar: Math.round(atRisk),
    by_stage, by_owner, owner_overflow, top_missing_docs,
  };
}
```

- [ ] **Step 4: Verify + run the pure test via CJS-emit**

Run: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → exit 0.
Run: `node node_modules/typescript/bin/tsc -p tsconfig.tests.json` → exit 0.
Run:
```bash
node node_modules/typescript/bin/tsc src/utils/dealComplianceReport.ts --outDir _dcr --module commonjs --moduleResolution node --target es2022 --skipLibCheck --rootDir src/utils >/dev/null 2>&1; echo '{"type":"commonjs"}' > _dcr/package.json; node -e 'const {shapeDealCompliance:S}=require("./_dcr/dealComplianceReport.js"); const r=[{stage:"Agreement Signed",compliant:false,amount:100,owner:"Ali",missing_docs:[{label:"VAT Certificate"}]},{stage:"Proposal",compliant:false,amount:200,owner:"",missing_docs:[{label:"VAT Certificate"}]}]; const o=S("walaplus",r); console.log(o.checked===2 && o.at_risk_sar===300 && o.compliant_rate===0 && o.top_missing_docs[0].count===2 && o.by_owner.some(x=>x.owner==="Unassigned") ? "PASS":"FAIL")'; rm -rf _dcr
```
Expected: `PASS`.

- [ ] **Step 5: Commit**

```bash
git add src/utils/dealComplianceReport.ts tests/vitest/dealComplianceReport.vitest.test.ts
git commit -m "feat(deal-compliance): pure shapeDealCompliance aggregator (at-risk, by-stage/owner, top missing)"
```

---

### Task 2: Expand `getSegmentDealComplianceSummary`

**Files:**
- Modify: `src/utils/duplicateRadarDatabase.ts:2563-2580`
- Test: `tests/vitest/getSegmentDealComplianceSummary.vitest.test.ts`

**Interfaces:**
- Consumes: `shapeDealCompliance`, `DealComplianceSummary` (Task 1).
- Produces: `getSegmentDealComplianceSummary(segment): Promise<DealComplianceSummary>` (superset of the old return; existing callers unaffected).

- [ ] **Step 1: Write the failing test (mocked pool)**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../src/utils/redactedPool", () => ({
  createRedactedPool: () => ({ query: (...a: any[]) => query(...a), connect: async () => ({ query: (...a: any[]) => query(...a), release: () => {} }) }),
}));
vi.mock("../../src/utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import { getSegmentDealComplianceSummary } from "../../src/utils/duplicateRadarDatabase";
beforeEach(() => query.mockReset());

describe("getSegmentDealComplianceSummary (expanded)", () => {
  it("fetches per-deal rows and returns the full breakdown", async () => {
    query.mockResolvedValue({ rows: [
      { stage: "Agreement Signed", compliant: false, amount: 100, owner: "Ali", missing_docs: [{ label: "VAT Certificate" }] },
      { stage: "Agreement Signed", compliant: true, amount: 50, owner: "Ali", missing_docs: [] },
    ] });
    const out = await getSegmentDealComplianceSummary("walaplus");
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("deal_doc_compliance");
    expect(sql).toContain("duplicate_records");
    expect(sql).toContain("missing_docs");
    expect(out.checked).toBe(2);
    expect(out.at_risk_sar).toBe(100);
    expect(out.compliant_rate).toBe(50);
    expect(Array.isArray(out.by_owner)).toBe(true);
    expect(Array.isArray(out.by_stage)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.tests.json` (the current fn returns the narrow type — `out.at_risk_sar` won't type-check).

- [ ] **Step 3: Implement — replace the function body (DRD:2563-2580)**

At the top of the file add the import (near other `./` imports):
```ts
import { shapeDealCompliance, type DealComplianceSummary } from "./dealComplianceReport";
```
Replace the function:
```ts
export async function getSegmentDealComplianceSummary(
  segment: DuplicateFilters["segment"],
): Promise<DealComplianceSummary> {
  const seg = segment && segment !== "all" ? (segment === "corporate" ? "walaplus" : segment) : "all";
  const p = buildSegmentPredicate(seg, 1);
  const segCond = p.condition ? " AND " + p.condition : "";
  const res = await pool.query(
    `SELECT d.stage AS stage,
            d.compliant AS compliant,
            COALESCE(r.deal_value, 0) AS amount,
            COALESCE(NULLIF(r.owner_name,''), NULLIF(r.owner_email,''), 'Unassigned') AS owner,
            d.missing_docs AS missing_docs
       FROM deal_doc_compliance d
       JOIN duplicate_records r ON r.zoho_record_id = d.zoho_deal_id
      WHERE r.record_type = 'deal'${segCond}`,
    [...p.params],
  );
  const rows = res.rows.map((x: any) => ({
    stage: x.stage || "Unknown",
    compliant: x.compliant === true,
    amount: Number(x.amount) || 0,
    owner: x.owner || "Unassigned",
    // pg parses jsonb into a JS array already; guard non-arrays to [].
    missing_docs: Array.isArray(x.missing_docs) ? x.missing_docs : [],
  }));
  return shapeDealCompliance(seg, rows);
}
```

- [ ] **Step 4: Verify**

Run: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → exit 0.
Run: `node node_modules/typescript/bin/tsc -p tsconfig.tests.json` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/utils/duplicateRadarDatabase.ts tests/vitest/getSegmentDealComplianceSummary.vitest.test.ts
git commit -m "feat(deal-compliance): getSegmentDealComplianceSummary returns full breakdown"
```

---

### Task 3: Render the breakdown — BU page (full) + email (condensed)

**Files:**
- Modify: `dashboard/js/quality-reports.js` (`qrComplianceHtml` at :391-403)
- Modify: `src/utils/qualityReportsEmail.ts` (compliance section at :45-51)
- Modify: `dashboard/quality-reports.html` (`?v=4` → `?v=5`)

**Interfaces:**
- Consumes: `sections.compliance.dealCompliance` = `DealComplianceSummary` (Task 1/2).

- [ ] **Step 1: Expand `qrComplianceHtml`'s deal-compliance block (page — FULL breakdown).** Replace the `if (c.dealCompliance) { ... }` block (lines 395-402) with:
```js
        if (c.dealCompliance) {
            var dc = c.dealCompliance;
            if (dc.checked > 0) {
                var fmtSar = function (n) { return 'SAR ' + (Number(n) || 0).toLocaleString(); };
                out.push('<div class="text-sm">Deal docs: ' + (dc.compliant || 0) + '/' + dc.checked + ' compliant (' + (dc.compliant_rate == null ? '—' : dc.compliant_rate + '%') + ') · At-risk: ' + fmtSar(dc.at_risk_sar) + '</div>');
                // By stage
                if (dc.by_stage && dc.by_stage.length) {
                    out.push('<div class="text-xs text-gray-500 mt-1">By stage</div>');
                    out.push('<table class="rr-table" style="width:auto"><thead><tr><th>Stage</th><th>Checked</th><th>Compliant</th><th>Missing</th></tr></thead><tbody>' +
                        dc.by_stage.map(function (s) { return '<tr><td>' + escapeHtml(s.stage) + '</td><td>' + s.checked + '</td><td>' + s.compliant + '</td><td>' + s.missing + '</td></tr>'; }).join('') +
                        '</tbody></table>');
                }
                // By owner (top 10)
                if (dc.by_owner && dc.by_owner.length) {
                    out.push('<div class="text-xs text-gray-500 mt-1">By owner (top 10)</div>');
                    out.push('<table class="rr-table" style="width:auto"><thead><tr><th>Owner</th><th>Checked</th><th>Compliant</th><th>Missing</th></tr></thead><tbody>' +
                        dc.by_owner.map(function (o) { return '<tr><td>' + escapeHtml(o.owner) + '</td><td>' + o.checked + '</td><td>' + o.compliant + '</td><td>' + o.missing + '</td></tr>'; }).join('') +
                        '</tbody></table>');
                    if (dc.owner_overflow > 0) out.push('<div class="text-xs text-gray-400">and ' + dc.owner_overflow + ' more owners</div>');
                }
                // Top missing docs
                if (dc.top_missing_docs && dc.top_missing_docs.length) {
                    out.push('<div class="text-xs text-gray-500 mt-1">Top missing documents</div><ul class="text-sm">' +
                        dc.top_missing_docs.slice(0, 6).map(function (m) { return '<li>' + escapeHtml(m.label) + ' — ' + m.count + '</li>'; }).join('') + '</ul>');
                }
            } else {
                out.push('<div class="text-sm rr-sub">Deal docs: no deals checked yet</div>');
            }
        }
```
NOTE on `style="width:auto"`: the page CSP strips inline styles — do NOT use it. Instead add a class `rr-table-auto { width:auto; }` to the page `<style>` block and use `class="rr-table rr-table-auto"`, OR omit the width entirely (let `rr-table` size it). Prefer omitting the inline style: use `class="rr-table"` with no width attribute. (The implementer MUST NOT leave any inline `style=""` on dashboard markup — replace the two `style="width:auto"` above with just `class="rr-table"`.)

- [ ] **Step 2: Expand the email compliance block (CONDENSED).** In `src/utils/qualityReportsEmail.ts`, replace the `if (s.compliance.dealCompliance) { ... }` block (lines 45-50) with:
```ts
    if (s.compliance.dealCompliance) {
      const dc = s.compliance.dealCompliance;
      if (dc.checked > 0) {
        const sar = `SAR ${(Number(dc.at_risk_sar) || 0).toLocaleString()}`;
        parts.push(`Deal docs: ${escHtml(dc.compliant || 0)}/${escHtml(dc.checked)} compliant (${dc.compliant_rate == null ? "&mdash;" : escHtml(dc.compliant_rate) + "%"}) · At-risk: ${escHtml(sar)}`);
        if (Array.isArray(dc.by_stage) && dc.by_stage.length) {
          const st = dc.by_stage.map((x: any) => `${escHtml(x.stage)}: ${escHtml(x.missing)} missing`).join(" · ");
          parts.push(`By stage — ${st}`);
        }
        if (Array.isArray(dc.top_missing_docs) && dc.top_missing_docs.length) {
          const md = dc.top_missing_docs.slice(0, 3).map((m: any) => `${escHtml(m.label)} (${escHtml(m.count)})`).join(", ");
          parts.push(`Top missing docs: ${md}`);
        }
      } else {
        parts.push(`Deal docs: no deals checked yet`);
      }
    }
```
(No full by-owner table in the email — page-only, per spec.)

- [ ] **Step 3: Bump the cache-buster** — `dashboard/quality-reports.html`: `quality-reports.js?v=4` → `?v=5`.

- [ ] **Step 4: Verify**

Run: `node --check dashboard/js/quality-reports.js` → no error (add `&& echo JS-OK`).
Run: `node scripts/check-dashboard-html-js.mjs` → PASS.
Run: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → exit 0.
Confirm (grep) NO inline `style="` was added to `dashboard/js/quality-reports.js` or `dashboard/quality-reports.html`.

- [ ] **Step 5: Commit**

```bash
git add dashboard/js/quality-reports.js src/utils/qualityReportsEmail.ts dashboard/quality-reports.html
git commit -m "feat(quality-reports): full deal-compliance breakdown on Sales BU page + condensed in email"
```

---

### Task 4: Ship

- [ ] **Step 1:** `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (exit 0), `node node_modules/typescript/bin/tsc -p tsconfig.tests.json` (exit 0), `node scripts/check-dashboard-html-js.mjs` (PASS), `node --check dashboard/js/quality-reports.js`.
- [ ] **Step 2:** `git pull --rebase --autostash origin QMS` then `git push origin QMS`.
- [ ] **Step 3:** Tell the user: Pull → Republish; open Sales (B2B) BU → the compliance section now shows at-risk SAR, by-stage, by-owner (top 10), and top missing docs; the email-to-head carries the condensed version.

## Self-Review notes

- **Spec coverage:** §2 query → Task 2. §3 shaper + types → Task 1. §4 expanded fn (superset) → Task 2. §5 aggregator no-change (confirmed — it passes `dealCompliance` through). §6 page full breakdown → Task 3 Step 1. §7 email condensed → Task 3 Step 2. §9 testing → Task 1/2 tests. §10 deploy + `?v=5` → Task 3 Step 3 + Task 4.
- **Placeholder scan:** none. The one caution — replacing `style="width:auto"` with `class="rr-table"` — is called out explicitly with the exact fix (no inline styles on dashboard markup).
- **Type consistency:** `DealComplianceSummary`/`DealComplianceRow`/`shapeDealCompliance` (Task 1) consumed by Task 2's `getSegmentDealComplianceSummary` and the Task 3 renderers (`by_stage`/`by_owner`/`owner_overflow`/`at_risk_sar`/`top_missing_docs` field names match across all three tasks and both renderers).
