# Deploy Note — Certification Action Plan (23 checkable actions)

**Date:** 2026-09-03 · **Scope:** `/compliance`'s Certification Milestone section rebuilt from a chain diagram into a 23-action checklist that proves itself from the platform's own data wherever it can. **Backend + frontend, no manual data migration required** (schema auto-migrates on boot).

## Why this deploy exists

The 2026-09-03 chain-diagram release drew the Certification Milestone Plan (GRQ-PLAN-2026-01 v3.0) as one dependency-ordered chain — a presentation fix, not the thing that was asked for. Sarah rejected it: "you didn't get the point… I need the milestone of plan as an action plan to be checked and followed… use the files that inside the platform, all documents, to check if the logic is working." A chain you look at is not a plan you can follow. This deploy turns the plan into 23 checkable actions (21 plan actions + 2 dependencies, across the 9 existing milestones) and, for every action where the platform holds the evidence, resolves and shows that evidence live instead of asking someone to eyeball it and tick a box.

## Files changed, by area

| Area | File | Change |
|------|------|--------|
| Schema | `src/utils/northStarSources.ts` | Eight policy approval/ownership columns (`compliance_approved`, `compliance_approved_by`, `compliance_approved_at`, `approval_blocked_reason`, and four owner columns) — previously declared **only** inside a runtime `ALTER TABLE` loop, invisible to the canonical `CREATE TABLE policies` and to `check-schema-parity.mjs` (which cannot see ALTERs built from a template literal in a loop) — are now also declared in the canonical `CREATE TABLE`. All 8 types verified character-for-character against the ALTER loop; the loop itself is unchanged (comment-only addition), so there is no duplicate-column risk on a fresh database. |
| Seed guard fix | `src/utils/northStarSources.ts` | The PDPL fill-seed guard previously counted **all** rows already seeded for the regulation (`18 >= 7`, so it never ran). It now counts only this seed's own obligation codes via `obligation_code = ANY($2)`. `ON CONFLICT (obligation_code) DO NOTHING` remains the backstop. Side-effect audit: only PDPL and SAMA-CSF have two writers touching this guard; SAMA's outcome is numerically unchanged (0<98 then 98>=98), every other framework is unaffected. |
| Seed data (pure) | `src/utils/seeds/certificationActions.ts` (new) | 23 rows (21 plan actions + 2 dependency actions) matching the plan spec verbatim, distributed 2/6/4/2/3/2/2 +1+1 across the 9 milestone_keys. 16 rows are `verification_mode='auto'` with a non-null `evidence_source`; 7 are `'manual'` with a null `evidence_source` — that invariant is test-pinned against the spec, not just against the seed (a mode inversion would otherwise pass silently). Module is import-free/pure. |
| Schema + seeder | `src/utils/northStarSources.ts` | New `certification_actions` table (canonical `CREATE TABLE` + matching `ALTER … ADD COLUMN IF NOT EXISTS`, parity-clean) plus its seeder, run after the milestone seeder. Non-partial unique index on `action_key`, so a bare `ON CONFLICT (action_key) DO NOTHING` is correct and idempotent — re-running inserts nothing once seeded. |
| Evidence resolver (pure) | `src/utils/certificationEvidence.ts` (new) | Resolves each action's live state from platform data with a fixed precedence: **unavailable > awaiting_data > satisfied > not_satisfied**. The first two branches return unconditionally, so a source table that cannot be read or is empty can never be misreported as satisfied *or* not_satisfied. A `need > 0` short-circuit stops a `0 >= 0` comparison from reading as satisfied when there's nothing to check. All numeric inputs are `Number.isFinite`-coerced so no `NaN` can leak into a verdict. Zero imports, no `new Date()` — fully unit-testable. `milestoneProgress` treats a milestone as complete only when every action in it is done (manual: `done_at` set; auto: resolver says `satisfied`) **and** the action list is non-empty — an empty list is deliberately never "complete," so a milestone that was never evaluated can't get `delivered_date` stamped. |
| API | `src/mastra/routes/certificationMilestoneRoutes.ts` | `GET /api/certification-milestones` extended to also return the 23 actions, each carrying its resolved evidence, grouped by milestone. Evidence comes from 12 grouped queries (not per-action) with per-source failure isolation — one source erroring never blanks another; a query error maps to `unavailable`, an empty result maps to `awaiting_data`. Framework/document evidence uses **confirmed AI links** (`awaiting_review IS NOT TRUE AND extraction_status='extracted'`), deliberately *not* `getFrameworkCoverage`, which counts unconfirmed links. Every date column is `TO_CHAR(col,'YYYY-MM-DD')`, never a bare `DATE` SELECT. New `POST /api/certification-actions/:action_key/toggle` records who/when a manual action is ticked; it refuses (409, before any write) an attempt to toggle an `auto` action. `delivered_date` on `certification_milestones` is now the **sole** derived write path — there was previously no write path to it at all. RBAC: the existing route path is unchanged for the GET; the new toggle path has its own `ROUTE_PERMISSION_MAP` entry (a route with no entry is denied by default, including for `admin`). |
| Action-plan view | `dashboard/compliance.html` | `/compliance` now leads with full-width framework cards, the plan's standing risk banner, and collapsible per-milestone action groups (`data-testid="cert-group-<milestone_key>"`), replacing the chain diagram entirely — the chain rendering code and all `ms_lbl_*`/`ms_planned` i18n keys are deleted. Auto actions render **no checkbox**, only read-only evidence; manual actions render a real checkbox wired to the toggle endpoint. Four states are always rendered distinctly: `satisfied`, `not_satisfied`, `awaiting_data` (names its source, never shown as 0% or "not done"), and `unavailable` (visually distinct from both). All DB-sourced values go through `escAttr` (not `escapeHtml`); bar widths use `data-style`, not inline `style=`; no inline `on*=` handlers. i18n: 18 dead chain-diagram keys removed, 14 action-plan keys added; EN/AR trees identical (205 `compliance.*` keys each side at this task, later 3459 keys total once print strings were added). |
| Print / PDF | `dashboard/compliance.html` | Print layout changed from the prior release's A4 **landscape** roadmap to A4 **portrait** for the action plan (the word "landscape" survives only in a code comment explaining its removal). Hiding rule is a single blanket `main > *:not([data-testid="section-cert-milestones"])` plus nav/`.modal`/widget rules — more robust than an enumerated per-section list. Collapsed groups are forced open in print via a rule scoped to the cert section only (`[data-testid="section-cert-milestones"] .hidden { display:block }`), verified not to leak into `#filterChips` or any other collapsible elsewhere on the page. `break-inside: avoid` on framework cards, action groups and the risk banner; print-color-adjust preserves state-badge backgrounds. Naming aligned across the h1, nav item and print header/subtitle so "GRC" reads consistently. |

## What operators will see

- **`/compliance` now leads with full-width framework cards**, the standing risk banner, and collapsible per-milestone action groups. Same URL; nav item still reads "Certification Milestone."
- **Auto-verified actions have NO checkbox** — they show read-only evidence pulled live from the platform. Only genuinely-manual actions are tickable, and ticking one records who and when.
- **Three honest states, and they are not interchangeable:**
  - **`awaiting data`** — the source table exists but is empty because the owning module hasn't been used yet. Not zero, not failure.
  - **`could not read source`** — the evidence query itself errored.
  - **`not done`** — a real, checkable "no" (manual actions) or a genuine `not_satisfied` verdict (auto actions with data to check against).
  Do not read "awaiting data" as "not done," and do not read either as a bug.
- **NCA-ECC and NCA-DCC show an amber "no action in this plan delivers this," and SOC 2 shows "no target date set in v3.0." These are DELIBERATE** — real gaps in plan v3.0, surfaced as v4.0 input, carried over unchanged from the prior release's framework-readiness logic. Not defects; do not let anyone "fix" them by hiding them or inventing coverage to make the warnings disappear.
- **A Print / PDF button** produces an A4 **portrait** hand-over of the action plan alone, with every collapsed group forced expanded so nothing is missing from the printout.

## Two data corrections in this release

- **PDPL goes 18 → 25 clauses, and its coverage percentage WILL DROP.** The 7-clause fill seed could never run because its guard counted *all* rows already seeded for the regulation (`18 >= 7`, always true). The denominator was wrong before this fix — this is a correction, not a regression. **Confirmed at 25 on Replit** at Checkpoint A (Tasks 1–3).
- **Eight policy approval/ownership columns** (`compliance_approved`, `compliance_approved_by`, `compliance_approved_at`, `approval_blocked_reason`, and four owner columns) were declared only inside a runtime `ALTER` loop — invisible to the canonical `CREATE TABLE policies`, and invisible to `check-schema-parity.mjs` too, because that loop builds its SQL from a template literal the checker cannot statically see. These are the platform's **only** machine-readable record of policy approval, and were the columns most exposed to loss in a Replit publish schema-diff `DROP`. They are now declared canonically, closing that exposure.

## Deploy steps

1. **Commit + push to `origin/QMS` first** (local-only edits deploy stale code), then Republish.
2. **Schema auto-migrates.** All new/changed columns are additive and nullable, applied via `ALTER TABLE … ADD COLUMN IF NOT EXISTS`. No manual SQL required.
3. **⛔ Do NOT approve any `DROP TABLE` in the Replit publish schema diff.** Approve code-only changes, as always.
4. **On Replit, run `node scripts/patch-mastra-provider-types.mjs` before `npm run check`.** Skipping it makes `tsc` fail with ~117 parse errors inside `node_modules/@mastra/core/...provider-types.generated.d.ts` — a missing postinstall step, not a defect in this change.
5. **Run the full guardrail suite before Republish** — see Verification below for exactly what has and has not been run.

## Post-deploy smoke test

1. Open `/compliance` and confirm the **framework cards render at the top**, full width, each showing a labelled milestone count (not a bare fraction).
2. Confirm the **action groups list all 23 actions** across the 9 milestones, in milestone order, each group collapsible.
3. Pick an **auto action** (e.g. a document-approval or framework-coverage action) and confirm it shows **live evidence text and no checkbox**.
4. Pick a **manual action**, tick it, and confirm it **records who and when** (and that re-opening the group shows the tick persisted).
5. Confirm the **two amber gaps appear**: NCA-ECC and NCA-DCC show "no action in this plan delivers this," SOC 2 shows "no target date set in v3.0."
6. Press **Ctrl+P** and confirm print preview shows the **action plan alone**, in **portrait**, with **every group expanded** — no nav, top bar, score cards, or obligations table visible.

## Known limitations

- **All 154 controlled documents are still `draft`; none are approved.** The document-related actions read near-zero at launch. This is accurate — it reflects real platform state, not a broken query.
- **No signature capability exists anywhere in the platform.** Wherever the plan calls for "approved and signed," the action is split: the approval half auto-verifies from confirmed data, the signature half stays manual by necessity.
- **SACS-002 has no clause catalogue**, so nothing about it can auto-verify from coverage data — it is manual until a catalogue exists.
- **Six evidence sources read "awaiting data" until their owning module is used**: training records, evidence records, audit runs, CAPA/nonconformance records, management reviews, and doc-tracker codes. This is expected at launch, not a defect.
- **Evidence chips are not yet hyperlinked to their owning GRC modules** — an operator sees the evidence text but cannot click through to the source record. Carried to a follow-up; deliberately out of scope for this release.
- **~30 pre-existing orphan `compliance.*` i18n keys predate this work** and are unrelated to it.
- **Carried forward and still open:** the leadership feed's GRC-KPI-002 entry emits a raw **count** while its description prose says "percentage," and `componentFraction` folds that count as `count/100` in the North Star composite. Both are currently inert but become live once Q1 2027 weights apply — **must be reconciled before 2027-01-01.**

## Verification

- **Tasks 1–3 (schema columns, PDPL guard fix, the 23-action seed) were verified on Replit at Checkpoint A:** all vitest tests passing, `tsc` clean, `check-schema-parity.mjs --strict` reporting no drift, and PDPL confirmed returning **25** clauses (was 18) in the live database.
- **Tasks 4–7 (evidence resolver, API + toggle endpoint, action-plan view, print layout) have NOT been run through the guardrail suite anywhere.** This machine's `node.exe` is quarantined by centrally-managed Kaspersky, so none of the following have been executed while producing this note: `npm run check` (tsc), `npm test` (which carries the inline-style check, the inline-handler check, and the i18n-orphan check — all three have caught blockers on this feature before, twice), `node scripts/check-schema-parity.mjs --strict`, or the targeted vitest run:
  ```
  node scripts/patch-mastra-provider-types.mjs && npm run check && npm test \
    && node scripts/check-schema-parity.mjs --strict \
    && npx vitest run tests/vitest/certificationActions.vitest.test.ts tests/vitest/certificationEvidence.vitest.test.ts tests/vitest/pdplFillSeed.vitest.test.ts tests/vitest/certificationMilestoneRoutes.vitest.test.ts tests/vitest/certificationMilestonePlan.vitest.test.ts
  ```
- **The idempotency check has not been run either:** restart twice and confirm `SELECT count(*) FROM certification_actions;` stays at **23**, not 46.
- **This is the last gate before Republish.** Do not treat this note's existence, or the Checkpoint A verification for Tasks 1–3, as evidence that the gate has passed for Tasks 4–7 — it has not.

## Rollback

Revert the commits for this feature (`src/utils/seeds/certificationActions.ts` [new — delete], `src/utils/certificationEvidence.ts` [new — delete], `src/utils/northStarSources.ts`, `src/mastra/routes/certificationMilestoneRoutes.ts`, `dashboard/compliance.html`, `dashboard/i18n/{en,ar}.json`) and republish. The added/declared columns (`certification_actions` table; the 8 canonicalized policy-approval columns) are additive and nullable — no down-migration is required, and leaving them in place is harmless. The PDPL fill-seed correction is data, not code: rolling back the guard fix does **not** un-seed the 7 clauses already inserted, so PDPL stays at 25 even after a code rollback (`ON CONFLICT DO NOTHING` makes the seed idempotent either way) — if a true rollback to 18 is ever needed it requires a manual `DELETE`, which is intentionally not automated here. Rolling back the view restores the prior chain-diagram roadmap at `/compliance`; GRC-KPI-002's own calculation is untouched by this release either way.
