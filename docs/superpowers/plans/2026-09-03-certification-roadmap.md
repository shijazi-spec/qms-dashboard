# Certification Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the already-seeded Certification Milestone Plan from three disconnected lists into one presentable roadmap — the chain drawn, blockers attached to what they block, what each milestone unlocks, plus a print/PDF hand-over from the same live data.

**Architecture:** Three additive columns carry the relationships (`depends_on_key`, `unlocks_codes`, `gates_keys`), backfilled idempotently by the existing seeder. All chain/state/readiness math lives in **pure functions** so it is unit-testable without a database; the route stays a thin query, and the page renders from one payload. The export is a `@media print` layout over the same DOM — no PDF engine, no second data path.

**Tech Stack:** TypeScript · Hono (Mastra) · PostgreSQL (`pg`) · vanilla dashboard HTML/JS · vitest

**Spec:** `docs/superpowers/specs/2026-09-03-certification-roadmap-design.md`

## Global Constraints

These are not general advice — each one is a defect that actually shipped or was caught in the previous run on this exact feature. Violating any of them reproduces a real bug.

- **Never `SELECT` a bare `DATE` column.** `pg` parses Postgres `DATE` into a JS `Date`; `String()` on it yields `"Sat Oct 31"` and `JSON` serialisation shifts the day in Asia/Riyadh. **Always `TO_CHAR(col,'YYYY-MM-DD') AS col`.** This bug shipped twice.
- **A new `/api/*` route needs a `ROUTE_PERMISSION_MAP` entry** in `src/utils/rbacMiddleware.ts`. `enforceRoutePermission` **denies by default** and the admin bypass only applies inside a matched rule — without an entry, every caller including `admin` gets 403 while all unit tests still pass. (This task extends an existing route, so no new entry should be needed — but verify, do not assume.)
- **Schema parity is STRICT.** Every `ALTER TABLE … ADD COLUMN` must also appear in the canonical `CREATE TABLE`. `node scripts/check-schema-parity.mjs --strict` must pass.
- **i18n parity is enforced.** Every new string needs the same key in BOTH `dashboard/i18n/en.json` and `dashboard/i18n/ar.json`. `scripts/check-i18n.cjs` fails on divergence. Values that must match an existing dropdown/option list are **lowercase** — check the real list before choosing a literal.
- **In `dashboard/compliance.html` the escaping helper is `escAttr`, not `escapeHtml`.** It escapes `& " < >`. Use it on every DB-sourced value. Do not add a second helper.
- **No inline event handlers** — `data-on-click` / `data-on-change` only (`scripts/check-no-inline-handlers.sh`).
- **The seeder must stay idempotent.** Relationship columns are set by `UPDATE … WHERE <col> IS NULL`, never by re-inserting. `ON CONFLICT (milestone_key) WHERE milestone_key IS NOT NULL DO NOTHING` — the predicate must be repeated; Postgres cannot infer a partial unique index.
- **Do not change** `GRC-KPI-002`'s calculation, the `milestone_type = 'plan'` filter, the 16 seed rows' existing fields, or the RBAC role list.
- **`node.exe` may be unavailable locally** (quarantined by centrally-managed Kaspersky). If so, tests CANNOT run — write them, report `NOT RUN`, and never fabricate results. `grep -c "error TS"` is NOT a pass signal: it returns 0 when node fails to launch. `python3` (`py -3`) IS available for JSON checks.
- Commit after every task.

---

### Task 1: Relationship data in the seed (pure)

**Files:**
- Modify: `src/utils/seeds/certificationMilestonePlan.ts`
- Test: `tests/vitest/certificationMilestonePlan.vitest.test.ts` (extend)

**Interfaces:**
- Consumes: existing `PlanMilestoneSeed`, `CERTIFICATION_MILESTONE_PLAN` (16 rows).
- Produces: three new optional fields on `PlanMilestoneSeed` — `depends_on_key?: string | null`, `unlocks_codes?: string[]`, `gates_keys?: string[]` — populated per the spec's §4.1–4.3 tables.

- [ ] **Step 1: Write the failing test**

Append to `tests/vitest/certificationMilestonePlan.vitest.test.ts`:

```ts
describe("plan relationships", () => {
  const byKey = (k: string) => PLAN.find((r) => r.milestone_key === k)!;

  it("chains the 7 plan milestones in document order", () => {
    expect(byKey("PLAN-2026-08-DOCS").depends_on_key).toBeNull();
    expect(byKey("PLAN-2026-09-APPROVE").depends_on_key).toBe("PLAN-2026-08-DOCS");
    expect(byKey("PLAN-2026-10-SAQA").depends_on_key).toBe("PLAN-2026-09-APPROVE");
    expect(byKey("PLAN-2026-11-AUDIT").depends_on_key).toBe("PLAN-2026-10-SAQA");
    expect(byKey("PLAN-2026-12-MGMTREV").depends_on_key).toBe("PLAN-2026-11-AUDIT");
    expect(byKey("PLAN-2027-01-PENTEST").depends_on_key).toBe("PLAN-2026-12-MGMTREV");
    expect(byKey("PLAN-2027-02-SURV").depends_on_key).toBe("PLAN-2027-01-PENTEST");
  });

  it("every chain link points at a real plan milestone", () => {
    const keys = new Set(PLAN.filter((r) => r.milestone_type === "plan").map((r) => r.milestone_key));
    for (const r of PLAN.filter((x) => x.milestone_type === "plan")) {
      if (r.depends_on_key !== null && r.depends_on_key !== undefined) {
        expect(keys.has(r.depends_on_key), r.milestone_key).toBe(true);
      }
    }
  });

  it("maps milestones to the frameworks they unlock", () => {
    expect(byKey("PLAN-2026-09-APPROVE").unlocks_codes).toEqual(["SACS-002"]);
    expect(byKey("PLAN-2026-10-SAQA").unlocks_codes).toEqual(["PCI-DSS"]);
    expect(byKey("PLAN-2026-11-AUDIT").unlocks_codes).toEqual(["PDPL"]);
    expect(byKey("PLAN-2026-12-MGMTREV").unlocks_codes).toEqual(["PDPL"]);
    expect(byKey("PLAN-2027-02-SURV").unlocks_codes).toEqual(["ISO-27001"]);
    expect(byKey("PLAN-2026-08-DOCS").unlocks_codes).toEqual([]);
    expect(byKey("PLAN-2027-01-PENTEST").unlocks_codes).toEqual([]);
  });

  it("attaches each Technology dependency to the milestone it blocks", () => {
    expect(byKey("DEP-TECH-ANSWERS").gates_keys).toEqual(["PLAN-2026-10-SAQA"]);
    expect(byKey("DEP-TECH-EVIDENCE").gates_keys).toEqual(["PLAN-2026-11-AUDIT"]);
  });

  it("leaves NCA and SOC 2 unreachable — no milestone unlocks them", () => {
    const unlocked = new Set(PLAN.flatMap((r) => r.unlocks_codes ?? []));
    expect(unlocked.has("NCA-ECC")).toBe(false);
    expect(unlocked.has("NCA-DCC")).toBe(false);
    expect(unlocked.has("SOC2")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/vitest/certificationMilestonePlan.vitest.test.ts`
Expected: FAIL — `depends_on_key` is undefined

- [ ] **Step 3: Extend the interface and populate the rows**

Add to `PlanMilestoneSeed`:

```ts
  /** Predecessor milestone_key — the chain the document says cannot be shortened. */
  depends_on_key?: string | null;
  /** regulations.regulation_code values this milestone makes compliant (§2 "what makes it true"). */
  unlocks_codes?: string[];
  /** For a dependency row: the milestone_keys it blocks (§5). */
  gates_keys?: string[];
```

Then set them on the existing 16 rows exactly per the spec's §4.1, §4.2 and §4.3 tables. Every `plan`
row gets an explicit `depends_on_key` (null for the head) and an explicit `unlocks_codes` (`[]` where
it unlocks nothing). Every `dependency` row gets `gates_keys`. `framework_target` rows get none of
the three. **Do not alter any existing field on any row.**

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/vitest/certificationMilestonePlan.vitest.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/seeds/certificationMilestonePlan.ts tests/vitest/certificationMilestonePlan.vitest.test.ts
git commit -m "feat(roadmap): chain, unlocks and gates relationships in the plan seed"
```

---

### Task 2: Schema columns + idempotent backfill

**Files:**
- Modify: `src/utils/northStarSources.ts` (CREATE TABLE, ALTERs, `seedCertificationMilestonePlan`)

**Interfaces:**
- Consumes: Task 1's three new seed fields.
- Produces: `depends_on_key`, `unlocks_codes`, `gates_keys` columns, populated for the 16 seeded rows.

- [ ] **Step 1: Add the columns to the canonical CREATE TABLE**

In the `CREATE TABLE IF NOT EXISTS certification_milestones (...)` block, after `source_doc VARCHAR(50),`:

```sql
      depends_on_key VARCHAR(100),
      unlocks_codes TEXT[],
      gates_keys TEXT[],
```

- [ ] **Step 2: Add the matching migrations**

Beside the existing `ALTER TABLE certification_milestones ADD COLUMN IF NOT EXISTS …` statements:

```ts
  // Roadmap relationships: the chain the plan document says cannot be shortened,
  // which frameworks each milestone makes compliant, and which milestones a
  // cross-department dependency blocks.
  await pool.query(
    `ALTER TABLE certification_milestones ADD COLUMN IF NOT EXISTS depends_on_key VARCHAR(100)`,
  );
  await pool.query(
    `ALTER TABLE certification_milestones ADD COLUMN IF NOT EXISTS unlocks_codes TEXT[]`,
  );
  await pool.query(
    `ALTER TABLE certification_milestones ADD COLUMN IF NOT EXISTS gates_keys TEXT[]`,
  );
```

- [ ] **Step 3: Backfill them in the seeder**

Inside `seedCertificationMilestonePlan()`, after the existing insert loop and the regulation_id
backfill, add a relationship backfill. It must only fill nulls, so operator edits survive:

```ts
  // Relationship columns are backfilled rather than inserted, because
  // ON CONFLICT DO NOTHING means a row that already exists would never receive
  // them. Only NULLs are touched, so an operator edit is never overwritten.
  let linked = 0;
  for (const r of rows) {
    if (
      r.depends_on_key === undefined &&
      r.unlocks_codes === undefined &&
      r.gates_keys === undefined
    ) continue;
    const res = await pool.query(
      `UPDATE certification_milestones
          SET depends_on_key = COALESCE(depends_on_key, $2),
              unlocks_codes  = COALESCE(unlocks_codes,  $3),
              gates_keys     = COALESCE(gates_keys,     $4)
        WHERE milestone_key = $1
          AND (depends_on_key IS NULL OR unlocks_codes IS NULL OR gates_keys IS NULL)`,
      [
        r.milestone_key,
        r.depends_on_key ?? null,
        r.unlocks_codes ?? null,
        r.gates_keys ?? null,
      ],
    );
    linked += res.rowCount ?? 0;
  }
  if (linked > 0) {
    logger.info(`🔗 [NorthStar] Linked roadmap relationships on ${linked} milestone row(s)`);
  }
```

- [ ] **Step 4: Verify parity and types**

Run: `node scripts/check-schema-parity.mjs --strict`
Expected: `no drift.`

Run: `node scripts/patch-mastra-provider-types.mjs && npm run check`
Expected: patcher line, then `tsc` prints nothing.

*(If node is unavailable locally, report NOT RUN and hand-verify the CREATE/ALTER columns match.)*

- [ ] **Step 5: Commit**

```bash
git add src/utils/northStarSources.ts
git commit -m "feat(roadmap): relationship columns + idempotent backfill"
```

---

### Task 3: Derived-state pure functions

All roadmap logic, testable without a database.

**Files:**
- Create: `src/utils/certificationRoadmap.ts`
- Test: `tests/vitest/certificationRoadmap.vitest.test.ts`

**Interfaces:**
- Produces:
  - `interface RoadmapRow { milestone_key, milestone_type, certification, milestone_name, planned_date: string|null, delivered_date: string|null, status, owner, notes, regulation_code: string|null, depends_on_key: string|null, unlocks_codes: string[], gates_keys: string[] }`
  - `type MilestoneState = "delivered_on_time" | "delivered_late" | "overdue" | "active" | "blocked" | "planned"`
  - `orderChain(rows: RoadmapRow[]): RoadmapRow[]`
  - `milestoneState(row, all, today: string): MilestoneState`
  - `frameworkReadiness(rows: RoadmapRow[]): Array<{ code, planned_date, total, delivered, pct, unreachable: boolean }>`

- [ ] **Step 1: Write the failing test**

Create `tests/vitest/certificationRoadmap.vitest.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  orderChain, milestoneState, frameworkReadiness,
} from "../../src/utils/certificationRoadmap";

const row = (o: any) => ({
  milestone_key: "K", milestone_type: "plan", certification: "C", milestone_name: "M",
  planned_date: null, delivered_date: null, status: "planned", owner: "O", notes: "",
  regulation_code: null, depends_on_key: null, unlocks_codes: [], gates_keys: [], ...o,
});

describe("orderChain", () => {
  it("orders by the dependency chain, not by array order", () => {
    const rows = [
      row({ milestone_key: "C", depends_on_key: "B" }),
      row({ milestone_key: "A", depends_on_key: null }),
      row({ milestone_key: "B", depends_on_key: "A" }),
    ];
    expect(orderChain(rows).map((r) => r.milestone_key)).toEqual(["A", "B", "C"]);
  });

  it("does not drop rows whose predecessor is missing", () => {
    const rows = [row({ milestone_key: "A", depends_on_key: null }),
                  row({ milestone_key: "X", depends_on_key: "GONE" })];
    expect(orderChain(rows)).toHaveLength(2);
  });

  it("terminates on a cyclic chain instead of looping forever", () => {
    const rows = [row({ milestone_key: "A", depends_on_key: "B" }),
                  row({ milestone_key: "B", depends_on_key: "A" })];
    expect(orderChain(rows)).toHaveLength(2);
  });
});

describe("milestoneState", () => {
  const today = "2026-09-03";

  it("is delivered_on_time when delivered on the planned date", () => {
    const r = row({ planned_date: "2026-08-30", delivered_date: "2026-08-30" });
    expect(milestoneState(r, [r], today)).toBe("delivered_on_time");
  });

  it("is delivered_late when delivered after the planned date", () => {
    const r = row({ planned_date: "2026-08-30", delivered_date: "2026-09-01" });
    expect(milestoneState(r, [r], today)).toBe("delivered_late");
  });

  it("is overdue when past its date and undelivered", () => {
    const r = row({ milestone_key: "A", planned_date: "2026-08-30" });
    expect(milestoneState(r, [r], today)).toBe("overdue");
  });

  it("is blocked when an undelivered dependency gates it", () => {
    const m = row({ milestone_key: "OCT", planned_date: "2026-10-31" });
    const dep = row({ milestone_key: "DEP", milestone_type: "dependency", gates_keys: ["OCT"] });
    expect(milestoneState(m, [m, dep], today)).toBe("blocked");
  });

  it("is not blocked once the gating dependency is delivered", () => {
    const m = row({ milestone_key: "OCT", planned_date: "2026-10-31" });
    const dep = row({ milestone_key: "DEP", milestone_type: "dependency",
                      gates_keys: ["OCT"], delivered_date: "2026-09-30" });
    expect(milestoneState(m, [m, dep], today)).not.toBe("blocked");
  });

  it("marks the earliest undelivered future milestone active", () => {
    const a = row({ milestone_key: "A", planned_date: "2026-09-30" });
    const b = row({ milestone_key: "B", planned_date: "2026-10-31" });
    expect(milestoneState(a, [a, b], today)).toBe("active");
    expect(milestoneState(b, [a, b], today)).toBe("planned");
  });
});

describe("frameworkReadiness", () => {
  it("counts delivered unlocking milestones per framework", () => {
    const rows = [
      row({ milestone_key: "P1", unlocks_codes: ["PDPL"], delivered_date: "2026-11-30",
            planned_date: "2026-11-30" }),
      row({ milestone_key: "P2", unlocks_codes: ["PDPL"], planned_date: "2026-12-31" }),
      row({ milestone_key: "FT", milestone_type: "framework_target",
            regulation_code: "PDPL", planned_date: "2026-12-31" }),
    ];
    const pdpl = frameworkReadiness(rows).find((f) => f.code === "PDPL")!;
    expect(pdpl.total).toBe(2);
    expect(pdpl.delivered).toBe(1);
    expect(pdpl.pct).toBe(50);
    expect(pdpl.unreachable).toBe(false);
  });

  it("flags a framework no milestone unlocks as unreachable", () => {
    const rows = [row({ milestone_key: "FT", milestone_type: "framework_target",
                        regulation_code: "NCA-ECC", planned_date: "2027-04-30" })];
    const nca = frameworkReadiness(rows).find((f) => f.code === "NCA-ECC")!;
    expect(nca.unreachable).toBe(true);
    expect(nca.total).toBe(0);
    expect(nca.pct).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/vitest/certificationRoadmap.vitest.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

Create `src/utils/certificationRoadmap.ts` implementing the three functions per the interfaces above.
`orderChain` must be cycle-safe (track visited keys; append any unvisited remainder in `planned_date`
order). `milestoneState` precedence: delivered states first, then `blocked`, then `overdue`, then
`active`, then `planned`. `frameworkReadiness` returns one entry per `framework_target` row,
computing `total`/`delivered` from `plan` rows whose `unlocks_codes` contain that code, `pct = 0`
when `total === 0`, and `unreachable = total === 0`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/vitest/certificationRoadmap.vitest.test.ts`
Expected: PASS — 11 tests

- [ ] **Step 5: Commit**

```bash
git add src/utils/certificationRoadmap.ts tests/vitest/certificationRoadmap.vitest.test.ts
git commit -m "feat(roadmap): pure chain, state and readiness functions"
```

---

### Task 4: Extend the milestones API

**Files:**
- Modify: `src/mastra/routes/certificationMilestoneRoutes.ts`
- Test: `tests/vitest/certificationMilestoneRoutes.vitest.test.ts` (extend)

**Interfaces:**
- Consumes: Task 2's columns, Task 3's pure functions.
- Produces: the existing payload plus `chain: RoadmapRow[]` (chain-ordered plan rows with a `state`
  field) and `readiness: Array<{code, planned_date, total, delivered, pct, unreachable}>`.

- [ ] **Step 1: Extend the SELECT — dates via TO_CHAR**

Add `cm.depends_on_key`, `cm.unlocks_codes`, `cm.gates_keys` to the existing SELECT. The date columns
already use `TO_CHAR(...,'YYYY-MM-DD')` — **keep it that way**; adding a bare date column here
reintroduces the timezone bug.

- [ ] **Step 2: Build the derived payload**

Import `orderChain`, `milestoneState`, `frameworkReadiness` and add to the JSON response:

```ts
      const all = r.rows as RoadmapRow[];
      const today = new Date().toISOString().slice(0, 10);
      const chain = orderChain(all.filter((x) => x.milestone_type === "plan"))
        .map((m) => ({ ...m, state: milestoneState(m, all, today) }));
      const readiness = frameworkReadiness(all);
```

Return `{ ...groupMilestonesByType(all), chain, readiness, plan_version, source_doc }`. Keep the
existing three grouped arrays so nothing that consumes them breaks. Keep the existing try/catch and
the `unauthorizedResponse`/`forbiddenResponse` split.

- [ ] **Step 3: Confirm no RBAC change is needed**

This extends an existing route; the path is unchanged, so the existing `ROUTE_PERMISSION_MAP` entry
for `/^\/api\/certification-milestones$/` still matches. **Verify by reading it** — do not assume.
Report what you found.

- [ ] **Step 4: Add a route test**

Extend `tests/vitest/certificationMilestoneRoutes.vitest.test.ts` with a pure test asserting the
payload shape includes `chain` and `readiness` and that `groupMilestonesByType` still returns all
three keys.

- [ ] **Step 5: Verify + commit**

Run: `npx vitest run tests/vitest/certificationMilestoneRoutes.vitest.test.ts` → PASS

```bash
git add src/mastra/routes/certificationMilestoneRoutes.ts tests/vitest/certificationMilestoneRoutes.vitest.test.ts
git commit -m "feat(roadmap): serve chain + framework readiness from the milestones API"
```

---

### Task 5: The roadmap view

**Files:**
- Modify: `dashboard/compliance.html`
- Modify: `dashboard/i18n/en.json`, `dashboard/i18n/ar.json`

**Interfaces:**
- Consumes: Task 4's `chain` and `readiness`.

- [ ] **Step 1: Replace the three plain boxes**

Replace the current `section-cert-milestones` markup with the roadmap: a document header (title,
`source_doc`, `plan_version`, preparer, Print button), the horizontal chain, the "cannot be
shortened" rule line, and a two-column footer of **Unlocks** and **Framework readiness**. Keep
`data-testid="section-cert-milestones"` so existing checks still find it.

- [ ] **Step 2: Render the chain**

For each `chain` entry render a node showing the date, a short label, and a state badge, joined by
connectors. Attach a blocker marker beneath any node whose `state === "blocked"`, naming the gating
dependency. Insert a "today" marker between the last past and first future node. **Escape every
DB-sourced value with `escAttr`.**

- [ ] **Step 3: Render readiness**

One row per `readiness` entry: code, target date, a proportional bar from `pct`, and — when
`unreachable` — an amber warning instead of a bar. SOC 2 (null `planned_date`) shows the same warning
style with its own message.

- [ ] **Step 4: i18n both locales**

Every new string goes through the file's existing `_ct(key, fallback)` helper, with keys added to
BOTH `en.json` and `ar.json` under `compliance.*`. Include the state badges, the chain rule line, the
two column headings, the unreachable warnings, and the Print button.

- [ ] **Step 5: Verify**

Run: `node scripts/check-dashboard-html-js.mjs` → `parsed cleanly.`
Run: `node scripts/check-i18n.cjs` → PASS
Run: `bash scripts/check-no-inline-handlers.sh` → PASS

- [ ] **Step 6: Commit**

```bash
git add dashboard/compliance.html dashboard/i18n/en.json dashboard/i18n/ar.json
git commit -m "feat(roadmap): chain view with blockers, unlocks and framework readiness"
```

---

### Task 6: Print / PDF export

**Files:**
- Modify: `dashboard/compliance.html`
- Modify: `dashboard/i18n/en.json`, `dashboard/i18n/ar.json`

- [ ] **Step 1: Add the print button**

A `data-on-click="printRoadmap"` button in the roadmap header calling `window.print()`. **No inline
handler.**

- [ ] **Step 2: Add the print stylesheet**

In a `@media print` block: hide the nav rail, top bar, filter bar, score cards, frameworks grid,
obligations table, modals and the button itself; show only the roadmap section; force A4 landscape
via `@page { size: A4 landscape; margin: 12mm; }`; ensure the chain does not break across pages
(`break-inside: avoid`); print backgrounds for the state badges
(`-webkit-print-color-adjust: exact; print-color-adjust: exact;`).

- [ ] **Step 3: Add a print-only header**

A block hidden on screen (`.print-only { display: none }`) and shown in print, carrying the document
title, `source_doc`, `plan_version`, preparer, and a generated-on date, so the hand-over PDF is
self-identifying. i18n both locales.

- [ ] **Step 4: Verify**

Run: `node scripts/check-dashboard-html-js.mjs` → `parsed cleanly.`
Run: `node scripts/check-i18n.cjs` → PASS
Visual: browser Print preview shows the roadmap alone, landscape, with the header.

- [ ] **Step 5: Commit**

```bash
git add dashboard/compliance.html dashboard/i18n/en.json dashboard/i18n/ar.json
git commit -m "feat(roadmap): print/PDF hand-over layout from the same live data"
```

---

### Task 7: Verification and deploy note

**Files:**
- Create: `docs/deploy-notes/2026-09-03-certification-roadmap.md`

- [ ] **Step 1: Full guardrail suite**

```bash
node scripts/patch-mastra-provider-types.mjs
npm run check
node scripts/check-schema-parity.mjs --strict
node scripts/check-i18n.cjs
node scripts/check-dashboard-html-js.mjs
bash scripts/check-no-inline-handlers.sh
npx vitest run tests/vitest/certificationMilestonePlan.vitest.test.ts tests/vitest/certificationRoadmap.vitest.test.ts tests/vitest/certificationMilestoneRoutes.vitest.test.ts tests/vitest/certMilestoneDelivery.vitest.test.ts tests/vitest/grcKpi002Definition.vitest.test.ts
```

- [ ] **Step 2: Confirm the backfill is idempotent**

Restart twice; `SELECT count(*) FROM certification_milestones WHERE depends_on_key IS NOT NULL;`
must be 6 (the six chained rows below the head), not growing.

- [ ] **Step 3: Write the deploy note**

Follow `docs/deploy-notes/2026-09-02-certification-milestones.md`. Must state: additive columns only,
no `DROP TABLE`, the roadmap replaces the three boxes at the same URL, and that **NCA-ECC/NCA-DCC and
SOC 2 will display amber gaps by design** — they are v4.0 input, not defects.

- [ ] **Step 4: Commit**

```bash
git add docs/deploy-notes/2026-09-03-certification-roadmap.md
git commit -m "docs: deploy note for the certification roadmap"
```

---

## Notes for the implementer

- The chain is **the** feature. If the nodes render but the order, blockers or "today" marker are
  wrong, the task has failed even with green tests — this exists to be presented to a Head of GRQ.
- The two amber gaps (NCA ×2, SOC 2) are **intentional output**, not bugs. Do not suppress them.
- `escAttr`, not `escapeHtml`, in `compliance.html`.
- Never add a bare `DATE` column to a SELECT.
