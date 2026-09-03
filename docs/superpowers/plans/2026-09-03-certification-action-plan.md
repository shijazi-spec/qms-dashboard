# Certification Action Plan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the certification plan into a working action plan — 20 checkable actions that prove themselves from the platform's own data where they can, and say plainly when they can't. Plus two data-integrity fixes found on the way.

**Architecture:** A new `certification_actions` table holds the 20 actions. Each declares an `evidence_source`. A **pure** resolver decides `satisfied / not_satisfied / awaiting_data / unavailable` from query results, so all logic is unit-testable without a database. Manual ticks are the only thing ever written; milestone completion — and therefore `certification_milestones.delivered_date` — is **derived**. The view is the approved mockup.

**Tech Stack:** TypeScript · Hono (Mastra) · PostgreSQL (`pg`) · vanilla dashboard HTML/JS · vitest

**Spec:** `docs/superpowers/specs/2026-09-03-certification-action-plan-design.md`
**Approved mockup:** https://claude.ai/code/artifact/d92e5961-0b45-4249-b61a-21e35e4765e2

## Global Constraints

Every one of these is a defect that actually shipped or was caught on this feature. Violating any reproduces a real bug.

- **Never `SELECT` a bare `DATE` column.** `pg` parses it to a JS `Date`; JSON-serialising shifts the day in Asia/Riyadh. Always `TO_CHAR(col,'YYYY-MM-DD') AS col`. **This shipped twice.**
- **Every new `/api/*` route needs a `ROUTE_PERMISSION_MAP` entry** in `src/utils/rbacMiddleware.ts`. `enforceRoutePermission` **denies by default** and the admin bypass only applies inside a matched rule — without an entry every caller including `admin` gets 403 while all unit tests pass.
- **No inline `style="..."` in `dashboard/`.** CSP sets `style-src 'self' 'nonce-…'` with no `unsafe-inline`, and a nonce cannot attach to a style *attribute*, so the style is silently dropped. `scripts/check-no-inline-styles.sh` also fails `npm test`. Use `data-style="..."` — `/js/csp-styles.js` applies it safely.
- **i18n keys must appear as LITERAL strings** inside `_ct('compliance.foo', 'Foo')`. `check-i18n.cjs` scans statically; a lookup like `_ct(MAP[key])` is invisible and every such key is reported as an unused orphan, failing `npm test`.
- **In `dashboard/compliance.html` the escaping helper is `escAttr`**, not `escapeHtml`. Use it on every DB-sourced value. Do not add a second helper.
- **i18n parity:** every key in BOTH `en.json` and `ar.json`, identical trees.
- **No inline `on*=` handlers** — `data-on-click` only.
- **Schema parity is STRICT.** Every column in the canonical `CREATE TABLE` and as `ALTER … ADD COLUMN IF NOT EXISTS`. Note: `check-schema-parity.mjs` cannot see ALTERs built from template literals in a loop, so it will not catch that class of drift for you — check by hand.
- **`ON CONFLICT` on a partial unique index must repeat the predicate.** Postgres cannot infer it.
- **`node.exe` may be unavailable locally** (Kaspersky). If so, tests cannot run — write them, report `NOT RUN`, never fabricate. `grep -c "error TS"` is NOT a pass signal (returns 0 when node fails to launch). `python3` (`py -3`) IS available.
- On Replit, run `node scripts/patch-mastra-provider-types.mjs` before `npm run check`.
- Commit after every task. Never `git add -A` — unrelated untracked files exist.

---

### Task 1: Canonical-schema fix for the policy approval columns

Eight columns exist only in a runtime `ALTER` loop and are absent from the canonical `CREATE TABLE policies`. They hold the platform's **only** machine-readable approval record, and that absence is exactly the drift a Replit publish diff turns into a `DROP`.

**Files:** Modify `src/utils/policyDatabase.ts` (the `CREATE TABLE IF NOT EXISTS policies` block, ~:108-146)

- [ ] **Step 1: Add the eight columns to the canonical CREATE TABLE**

Read `src/utils/rbacDatabase.ts` `addPolicyDualOwnership()` (~:224-248) and copy the names and types **exactly**:

```sql
      operational_owner VARCHAR(255),
      operational_owner_email VARCHAR(255),
      compliance_owner VARCHAR(255),
      compliance_owner_email VARCHAR(255),
      compliance_approved BOOLEAN DEFAULT FALSE,
      compliance_approved_by VARCHAR(255),
      compliance_approved_at TIMESTAMP,
      approval_blocked_reason TEXT,
```

- [ ] **Step 2: Leave the ALTER loop exactly as it is**

Existing databases already have these columns; the loop is what put them there and must keep running for them. Do NOT delete it, and do NOT change its types.

- [ ] **Step 3: Add a comment recording why both exist**

Above the ALTER loop in `rbacDatabase.ts`, note that these columns are also declared in the canonical `CREATE TABLE` in `policyDatabase.ts`, that both must be kept in step, and that `check-schema-parity.mjs` cannot see this loop because the SQL is built from a template literal.

- [ ] **Step 4: Verify**

Run `node scripts/check-schema-parity.mjs --strict` → no drift.
By hand: list the eight names/types from both files side by side and confirm they match. Report the comparison.

- [ ] **Step 5: Commit**

```bash
git add src/utils/policyDatabase.ts src/utils/rbacDatabase.ts
git commit -m "fix(schema): declare policy approval columns in the canonical CREATE TABLE"
```

---

### Task 2: PDPL — repair the fill-seed guard

**Files:** Modify `src/utils/seeds/obligationSeedTypes.ts` (~:80-95) · Test `tests/vitest/pdplFillSeed.vitest.test.ts`

`runFrameworkSeed()` guards on `COUNT(*) WHERE regulation_id = $1 >= defs.length`. `seedPDPLObligations()` (18 rows) runs before `seedPdplFillObligations()` (7 rows), so `18 >= 7` returns early **every time** and `PDPL-19`…`PDPL-25` have never been inserted. Every PDPL coverage figure is computed against a denominator missing exactly those articles.

- [ ] **Step 1: Write the failing test**

Create `tests/vitest/pdplFillSeed.vitest.test.ts` testing the **pure** decision, not the DB. Extract the guard into a pure helper first (Step 3) and test:

```ts
import { describe, it, expect } from "vitest";
import { shouldSkipSeed } from "../../src/utils/seeds/obligationSeedTypes";

describe("shouldSkipSeed", () => {
  it("runs a fill seed even when the framework already has more rows than the fill", () => {
    // 18 PDPL rows already exist; the fill defines 7 NEW codes, none present.
    expect(shouldSkipSeed(0, 7)).toBe(false);
  });
  it("skips when every code in this seed already exists", () => {
    expect(shouldSkipSeed(7, 7)).toBe(true);
  });
  it("runs on a fresh database", () => {
    expect(shouldSkipSeed(0, 18)).toBe(false);
  });
  it("runs when a seed is only partially applied", () => {
    expect(shouldSkipSeed(12, 18)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

`npx vitest run tests/vitest/pdplFillSeed.vitest.test.ts` → FAIL, `shouldSkipSeed` not exported.

- [ ] **Step 3: Fix the guard**

Export the pure predicate and change the count query to consider **only the codes this seed defines**:

```ts
/** Skip only when every code THIS seed defines already exists. Counting all
 *  rows for the regulation breaks fill/extension seeds: PDPL's 7-code fill
 *  could never run because the base seed had already inserted 18. */
export function shouldSkipSeed(existingOfTheseCodes: number, defined: number): boolean {
  return defined > 0 && existingOfTheseCodes >= defined;
}
```

and in `runFrameworkSeed`:

```sql
SELECT COUNT(*) FROM obligations
 WHERE regulation_id = $1 AND obligation_code = ANY($2)
```

passing the array of codes from `defs`. Note the fill seed's entries use a `code` property — confirm the real property name in `seeds/pdplFillObligations.ts` and map accordingly.

- [ ] **Step 4: Run test to verify it passes** → PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/utils/seeds/obligationSeedTypes.ts tests/vitest/pdplFillSeed.vitest.test.ts
git commit -m "fix(compliance): fill seeds could never run; count only this seed's codes"
```

> **Deploy note must say:** PDPL goes 18 → 25 clauses and its coverage percentage **drops**. That is the correction — the denominator was wrong before.

---

### Task 3: `certification_actions` — schema + 20-action seed

**Files:** Create `src/utils/seeds/certificationActions.ts` · Modify `src/utils/northStarSources.ts` · Test `tests/vitest/certificationActions.vitest.test.ts`

**Produces:** `CERTIFICATION_ACTIONS: ActionSeed[]` (20 plan actions + 2 dependency actions) and `seedCertificationActions()`.

- [ ] **Step 1: Write the failing test** — assert 22 rows; every `milestone_key` matches a real milestone in `CERTIFICATION_MILESTONE_PLAN`; `action_key`s unique; every `verification_mode` is `auto` or `manual`; every `auto` row has a non-empty `evidence_source`; counts per milestone are 2/6/4/2/3/2/2 and 2 dependency actions.

- [ ] **Step 2: Run → FAIL** (module not found).

- [ ] **Step 3: Write the seed** using the spec's §3.1 table **verbatim** — action text, owner, class and evidence source. Do not paraphrase; these are transcribed from an approved compliance document.

- [ ] **Step 4: Add the table** to `northStarSources.ts` — canonical `CREATE TABLE IF NOT EXISTS certification_actions` **and** matching `ALTER … ADD COLUMN IF NOT EXISTS` for every column, per spec §4.1. Unique index on `action_key`. Seed with `ON CONFLICT (action_key) DO NOTHING`, called from the same init that seeds the milestones, **after** it.

- [ ] **Step 5: Run → PASS. Verify** `check-schema-parity --strict`.

- [ ] **Step 6: Commit** — `feat(cert): certification_actions table + 22-action seed`

---

### Task 4: The evidence resolver (pure)

**Files:** Create `src/utils/certificationEvidence.ts` · Test `tests/vitest/certificationEvidence.vitest.test.ts`

**Produces:**
- `type EvidenceState = "satisfied" | "not_satisfied" | "awaiting_data" | "unavailable"`
- `interface EvidenceReading { source: string; state: EvidenceState; have: number; need: number; detail?: string }`
- `resolveEvidence(source: string, counts: { have: number; total: number; sourceEmpty: boolean; sourceReadable: boolean }): EvidenceReading`
- `milestoneProgress(actions, readings): { done: number; total: number; complete: boolean }`

- [ ] **Step 1: Write the failing test**, covering at minimum:
  - `sourceReadable === false` → `unavailable` (never `not_satisfied`)
  - `sourceEmpty === true` → `awaiting_data` (never `0%`, never `satisfied`)
  - `have >= need && need > 0` → `satisfied`
  - `have < need` → `not_satisfied`
  - `need === 0` does not divide by zero and does not report `satisfied` by accident
  - `milestoneProgress` counts a manual action done only when `done_at` is set, and an auto action done only when its reading is `satisfied`
  - `complete` is true only when EVERY action is done — `awaiting_data` does not count as done

- [ ] **Step 2: Run → FAIL.** **Step 3: Implement**, pure — no imports, no DB, no `Date.now()`. **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** — `feat(cert): pure evidence resolver`

---

### Task 5: API — actions, evidence, and the toggle

**Files:** Modify `src/mastra/routes/certificationMilestoneRoutes.ts` · Modify `src/utils/rbacMiddleware.ts` · Test extend `tests/vitest/certificationMilestoneRoutes.vitest.test.ts`

- [ ] **Step 1: Extend `GET /api/certification-milestones`** to include `actions` — every row from `certification_actions`, each with its resolved `EvidenceReading` — and per-milestone progress. Run one query per distinct `evidence_source` (not per action), wrapped so a failing source yields `sourceReadable: false` rather than throwing the whole request. Keep `TO_CHAR` on every date. Keep the existing payload fields.

- [ ] **Step 2: Add `POST /api/certification-actions/:action_key/toggle`** — same five roles; **refuses with 409 if the action's `verification_mode` is `auto`** (those are computed, never asserted); writes `done_at`/`done_by` from the session user; writes an `event_logs` entry; returns the updated action.

- [ ] **Step 3: Register the new path in `ROUTE_PERMISSION_MAP`** in `src/utils/rbacMiddleware.ts`, matching the shape of the neighbouring entry for `/^\/api\/certification-milestones$/` and the same five roles. **Without this, every caller including admin gets 403 while all tests pass.** Report the entry you added.

- [ ] **Step 4: Recompute milestone delivery** — after a successful toggle, if every action for that `milestone_key` is done, stamp `certification_milestones.delivered_date` (only when currently NULL); if it is no longer complete, clear it. This is the derived write path; there is no endpoint that sets a delivery date by hand.

- [ ] **Step 5: Tests** — payload includes `actions` with readings; an `auto` action cannot be toggled; the RBAC entry exists.

- [ ] **Step 6: Verify + commit** — `feat(cert): serve actions with evidence, add the manual toggle`

---

### Task 6: The view — framework cards, then the action list

**Files:** Modify `dashboard/compliance.html`, `dashboard/i18n/en.json`, `dashboard/i18n/ar.json`

Build exactly the approved mockup.

- [ ] **Step 1: Framework cards, full width, above everything** — name bold, target date, the framework's real standing from the plan (so ISO 27001 reads "Certified since Feb 2026", not a bare 0%), and progress in actions. Keep the amber cards for NCA-ECC / NCA-DCC ("no action in this plan delivers this") and SOC 2 ("no target date set in v3.0").

- [ ] **Step 2: Keep the standing risk banner.**

- [ ] **Step 3: The action list** — one collapsible group per milestone showing date, framework as a small grey label, the deliverable in **bold black**, a state pill and `n / m`. Inside, one row per action with owner and an evidence chip.
  - `manual` → a real checkbox wired to the toggle endpoint via `data-on-click`.
  - `auto` → **no checkbox**; a read-only evidence indicator (satisfied / not yet) with the count.
  - `awaiting_data` → "awaiting data" with the source named — never `0%`.
  - `unavailable` → "could not read source", visibly distinct from "not done".

- [ ] **Step 4: Remove** the horizontal chain diagram and every `ms_lbl_*` / `ms_planned` remnant.

- [ ] **Step 5: i18n** — every new string through `_ct('compliance.key', 'Fallback')` with **literal** keys, added to both locales.

- [ ] **Step 6: Verify** — `check-dashboard-html-js`, `check-i18n`, `check-no-inline-handlers`, `check-no-inline-styles` (use `data-style`, never `style=`).

- [ ] **Step 7: Commit** — `feat(cert): action-plan view with per-action evidence`

---

### Task 7: Print/export + GRC consistency

**Files:** Modify `dashboard/compliance.html`, both i18n files

- [ ] **Step 1: Update the print layout** for the new structure — the framework band and action list print; nav, filters, score cards, frameworks grid, obligations table and modals stay hidden. Keep every hiding rule **inside** `@media print` (a leak breaks the live page). A4 landscape, `break-inside: avoid` on each milestone group.
- [ ] **Step 2: Align the naming** — page `<h1>`, nav label and print header all read **Certification Milestone Plan**. Fix the stale subtitle ("PDPL, NCA/ECC, ISO standards tracking and obligation management") so it describes the page it is on.
- [ ] **Step 3: Link the evidence chips** to their owning GRC module (Risk Mgmt, Mgmt Review, External Audits, Document Mapping) so the plan is a way into the section.
- [ ] **Step 4: Verify + commit** — `feat(cert): print layout and GRC naming consistency`

---

### Task 8: Verification and deploy note

**Files:** Create `docs/deploy-notes/2026-09-03-certification-action-plan.md`

- [ ] **Step 1: Full gate** (Replit)

```bash
node scripts/patch-mastra-provider-types.mjs && npm run check && npm test \
  && node scripts/check-schema-parity.mjs --strict \
  && npx vitest run tests/vitest/certificationActions.vitest.test.ts tests/vitest/certificationEvidence.vitest.test.ts tests/vitest/pdplFillSeed.vitest.test.ts tests/vitest/certificationMilestoneRoutes.vitest.test.ts tests/vitest/certificationMilestonePlan.vitest.test.ts
```

- [ ] **Step 2: Confirm idempotency** — restart twice; `SELECT count(*) FROM certification_actions;` = 22, not 44.
- [ ] **Step 3: Confirm the PDPL correction** — `SELECT count(*) FROM obligations o JOIN regulations r ON r.id=o.regulation_id WHERE r.regulation_code='PDPL';` = **25**.
- [ ] **Step 4: Write the deploy note**, following `docs/deploy-notes/2026-09-03-certification-roadmap.md`. It must state plainly:
  - **PDPL coverage % will DROP** — 18 → 25 clauses; the denominator was wrong before. Correction, not regression.
  - Actions with empty source tables read **"awaiting data"**, not 0 — expected until those modules are used.
  - All 154 documents are still `draft`, so the document actions read near-zero at launch.
  - **No signature capability exists**, so "approved and signed" is half-manual by necessity.
  - NCA ×2 and SOC 2 keep their amber gap cards **by design** — v4.0 input, not defects.
  - ⛔ Do **not** approve any `DROP TABLE` in the Replit publish diff.
- [ ] **Step 5: Commit** — `docs: deploy note for the certification action plan`

---

## Notes for the implementer

- **The evidence model is the feature.** If an action shows a green tick without the platform actually proving it, the task has failed even with green tests.
- `awaiting_data` and `unavailable` must never collapse into `0%` or `not done`. They are different facts and the page says which.
- Auto actions get **no checkbox**. A tickable box implies an assertion the platform is already making.
- Coverage reads use **confirmed** links only — exclude `awaiting_review = TRUE` and require `extraction_status = 'extracted'`.
- `escAttr`, not `escapeHtml`. `data-style`, not `style=`. Literal i18n keys, not lookups.
