# Deploy Note — Certification Milestone Plan embedded into GRC-KPI-002

**Date:** 2026-09-02 · **Scope:** GRC-KPI-002 repointed from document-mapping clause coverage to real Certification Milestone Plan delivery; new milestone-first section on `/compliance`; SACS-002 registered as a 9th framework. **Backend + frontend, no data migration required** (schema auto-migrates on boot).

## Why this deploy exists

GRC-KPI-002 was displaying document-mapping clause coverage (~19.9%) — a proxy metric nobody asked for. The Certification Milestone Plan (GRQ-PLAN-2026-01 v3.0) is the actual document leadership tracks, and the platform already had everything needed to measure it for real: a `certification_milestones` table, a delivery calculator (`calcCertMilestoneDelivery`), and a data-entry form on `/compliance`. None of it was fed — the table was empty and the entry form was orphaned from the nav, so the correct machinery sat unused while the KPI reported a different metric entirely.

This deploy seeds the 16-row plan, extends the schema to carry it, repoints GRC-KPI-002 at the real calculator, annotates the resulting baseline break so historical values aren't misread as a regression, surfaces the plan on a renamed `/compliance` page, and stages (but does not enable) a leadership feed count.

## Files changed, by area

| Area | File | Change |
|------|------|--------|
| Seed data (pure) | `src/utils/seeds/certificationMilestonePlan.ts` | New module: 16-row `CERTIFICATION_MILESTONE_PLAN` (7 plan / 7 framework_target / 2 dependency) mirroring GRQ-PLAN-2026-01 v3.0, plus pure `resolveMilestoneRegulationIds` resolver. No DB import — unit-testable standalone. |
| Schema | `src/utils/northStarSources.ts` | `certification_milestones` CREATE TABLE + matching `ALTER…IF NOT EXISTS` for `milestone_type`, `regulation_id`, `milestone_key`, `plan_version`, `source_doc`; partial unique index `uq_certification_milestones_key` (`WHERE milestone_key IS NOT NULL`, so pre-existing manually-entered rows are unaffected); insert-column whitelist extended. |
| Schema | `src/utils/complianceDatabase.ts` | `seedDefaultRegulations` gains a `SACS-002` (Saudi Aramco Cybersecurity Standard) entry — 9th framework, zero obligations by design. |
| Seed applier | `src/utils/northStarSources.ts` | `seedCertificationMilestonePlan()` — idempotent `INSERT … ON CONFLICT (milestone_key) WHERE milestone_key IS NOT NULL DO NOTHING`, so redeploys never duplicate rows or clobber operator edits (`delivered_date`, `status`) made through the UI. Guarded with `to_regclass` so a cold DB (where `regulations` doesn't exist yet) skips cleanly and retries next boot instead of silently seeding 0 rows. |
| KPI calculator | `src/utils/northStarSources.ts` | `summarizeMilestoneDelivery()` — pure, unit-tested on-time-delivery math (only `milestone_type='plan'` rows count; cancelled rows excluded from the denominator; dates formatted in SQL via `TO_CHAR(...,'YYYY-MM-DD')`, not JS `String(Date)`, to avoid timezone corruption). `calcCertMilestoneDelivery()` rewritten to select raw rows and delegate to it. |
| KPI wiring | `src/utils/kpiProcessCalc.ts` | `PROCESS_CALCULATORS["GRC-KPI-002"]` repointed to `calcCertMilestoneDelivery`. The old `calcCertificationMilestones` (clause coverage) is **kept, exported, just unregistered** — it has exactly one prior consumer (this registration) and remains available for a future KPI. |
| KPI definition | `src/utils/finalGrqKpiSeed.ts`, `src/utils/kpiDatabase.ts` | Reconciled four conflicting definitions of GRC-KPI-002 into one: `frequency: "quarterly"` (was `"Per Certificate"` — note: the KPI-detail UI's frequency list is lowercase-only and matches with `===`, so this had to be exactly `"quarterly"`, not `"Quarterly"`), `unit: "%"`, `target: 100`, `data_source: "Certification Milestone Plan (GRQ-PLAN-2026-01)"`. Legacy `GRQ_SCORECARD_KPIS` entry aligned to match. |
| Baseline-break annotation | `src/utils/kpiDatabase.ts`, `src/utils/finalGrqKpiSeed.ts` | New `kpi_definitions.methodology_changed_at` (DATE) / `methodology_note` (TEXT) columns, set once for GRC-KPI-002 (guarded `WHERE methodology_changed_at IS NULL` so it never overwrites an operator edit). History rows are untouched — nothing is deleted or backfilled. |
| Baseline-break UI | `dashboard/kpis.html`, `dashboard/i18n/{en,ar}.json` | Amber "Method changed" (`kpis.methodology_break`) badge rendered next to the KPI title whenever `methodology_changed_at` is set, with the note as its tooltip. |
| Leadership count emitter | `src/utils/northStarSources.ts`, `src/utils/leadershipKpiFeed.ts` | `onTimeCountFromSummary()` — leadership tracks certification as a raw **count** (target 2/quarter), the QMS shows a **percentage**; this is the one sanctioned conversion between them, returning `null` (not `0`) when there's no data so the feed omits the field rather than reporting a false zero. |
| Leadership push | `src/utils/leadershipPush.ts` | GRC-KPI-002 entry added **commented out** — see Known limitations below. |
| Sidebar rename | `dashboard/i18n/{en,ar}.json`, `dashboard/js/navigation.js` | `nav.items.compliance` value changed to "Certification Milestone" / "معالم الشهادات". `id`, `href` (`/compliance`), and the i18n **key** are untouched. A nav-search alias map keeps "compliance" resolving to the renamed row (muscle memory preserved) via a reused `data-item-id` attribute. |
| `/compliance` milestone section | `src/mastra/routes/certificationMilestoneRoutes.ts` (new), `src/mastra/index.ts`, `dashboard/compliance.html`, `dashboard/i18n/{en,ar}.json` | New `GET /api/certification-milestones` returning the plan grouped by section (`plan` / `framework_target` / `dependency`) plus provenance (`plan_version`, `source_doc`). New page section rendered above the existing framework/obligation area: Milestone Timeline, Compliant-From-by-Framework, Dependencies & Blockers. |
| RBAC registration | `src/mastra/index.ts` (`ROUTE_PERMISSION_MAP`) | `/api/certification-milestones` registered explicitly. **This was a blocking bug caught in review**: `enforceRoutePermission` denies by default, and admin bypass only applies inside a matched rule — an unregistered route 403s for everyone, including admins. Fixed before merge; the whole milestone section would otherwise have rendered empty in prod. |

## Behaviour changes operators will notice

- **GRC-KPI-002's displayed VALUE changes.** It now measures on-time delivery of Certification Milestone Plan milestones due in the current quarter, not document-mapping clause coverage. A **"Method changed"** amber badge appears next to the KPI title explaining the switch (with the reason in its tooltip); all history before 2 Sep 2026 is preserved as-is, not deleted or rewritten — the two halves of the series are simply not comparable.
- **Its frequency changes from "Per Certificate" to "quarterly"**, which changes how Maram's North Star composite is computed (this KPI now contributes on the same cadence as the other quarterly inputs, not per-certificate events).
- **The sidebar item "Compliance" is now "Certification Milestone."** Same URL (`/compliance`), same nav id, same route. Typing "compliance" into nav search still finds the row.
- **SACS-002 appears as a new 9th framework card with 0 clauses.** This is expected — its control catalogue is out of scope for this deploy. Coverage math is guarded against a zero denominator, so it cannot dilute or crash the compliance summary.
- **SOC 2's milestone row has no target date.** Plan v3.0 names SOC 2 in its introduction but never gives it a row in the plan table's date section — the seed reflects that faithfully rather than inventing a date.

## Deploy steps

1. **Commit + push to `origin/QMS` first** (standing rule — local-only edits deploy stale code), then Republish.
2. **Schema auto-migrates.** All new columns are added via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`; the 16 plan rows are seeded on boot via `seedCertificationMilestonePlan()` using `ON CONFLICT (milestone_key) WHERE milestone_key IS NOT NULL DO NOTHING`. No manual SQL required.
3. **⛔ Do NOT approve any `DROP TABLE` in the Replit publish schema diff.** Approve code-only changes, as always.

## Post-deploy smoke test

1. Open `/compliance` and confirm the page header now reads **"Certification Milestones"** and the three new blocks at the top (Milestone Timeline / Compliant From, by Framework / Dependencies & Blockers) are populated — not empty — from the 16 seeded rows.
2. In the sidebar, confirm the nav item reads **"Certification Milestone"** in English, and switch to Arabic and confirm it reads **"معالم الشهادات."**
3. Use nav search and type "compliance" — confirm the renamed row still appears in results.
4. Open the KPIs page and find **GRC-KPI-002** — confirm it now shows a milestone-delivery percentage (not the old clause-coverage number) and the amber **"Method changed"** badge is present next to its title; hover/inspect the badge to confirm the tooltip explains the change.
5. Open the Framework Compliance section further down `/compliance` and confirm **SACS-002** appears as a 9th framework card showing 0 clauses (expected, not a bug).
6. Restart the app (or trigger a redeploy) and re-check `certification_milestones` — row count with `milestone_key IS NOT NULL` should stay at **16**, confirming the seed is idempotent and did not duplicate.

## Known limitations / follow-ups

- **Leadership push for GRC-KPI-002 is committed commented out.** The production `strategyItemId` UUID in the codebase is truncated (`2f11d78d…`) and unverified — pushing an unconfirmed mapping is exactly what produced the historical "995%" leadership-feed bug on a different KPI. **What unblocks it:** confirm the full strategyItem UUID against the leadership platform, then uncomment the entry in `src/utils/leadershipPush.ts`. The count math itself (`onTimeCountFromSummary`) is already tested and correct — this is purely a data-verification gate, not a code gap.
- **`compliance_assessments` is empty**, which is why the compliance framework section below the new milestone blocks still shows 0% / 668 Not Assessed. This is a separate, pre-existing problem, out of scope for this deploy — do not treat it as something this change was meant to fix.
- **`kpi.description` in `dashboard/kpis.html` is still interpolated raw into innerHTML** — a pre-existing stored-XSS exposure found during this work's review. `kpi_name` was fixed (both the badge-adjacent renderer and a second pre-existing unescaped sink at the card renderer), but `description` was logged as out-of-scope for this task and was **not** fixed. Flagging here so it isn't lost.
- **SACS-002 has no obligations sourced yet**, so it will not appear in Document Mapping (clause-coverage view) until its control catalogue is sourced and loaded — it only appears as a framework card in Compliance and as a milestone target in the new plan section.

## Verification

Unit tests and guardrails were run on a separate Node-capable machine (this machine's `node.exe` is quarantined by centrally-managed Kaspersky) at two checkpoints during implementation, not after Task 10:

- **Checkpoint 1 (Tasks 1–3):** 9/9 vitest passing, `check-schema-parity.mjs --strict` reported no drift.
- **Checkpoint 2 (Tasks 4–7):** 20/20 vitest passing across 3 files (`certificationMilestonePlan` 10, `certMilestoneDelivery` 8, `grcKpi002Definition` 2), schema-parity clean (151 ALTERs / 208 tables, no drift), i18n guardrail passing (key-tree parity, 3423 keys).

**Not verified as part of writing this note:** the full guardrail suite specified in Task 10 Step 1 (TypeScript compile, schema-parity, i18n, dashboard-HTML-JS lint, and the full 4-file vitest run including `certificationMilestoneRoutes.vitest.test.ts` from Task 9) has not been re-run since Checkpoint 2 — Task 8 and Task 9 landed after that checkpoint and were reviewed but not yet re-verified by a test run. **This final full-suite run is the last gate before Republish** and must be executed on a Node-capable machine (Replit shell) before this deploy proceeds. Do not treat this note's existence as evidence that gate has passed.

## Rollback

Revert the commits listed in the file/area table above (`src/utils/northStarSources.ts`, `src/utils/complianceDatabase.ts`, `src/utils/kpiProcessCalc.ts`, `src/utils/finalGrqKpiSeed.ts`, `src/utils/kpiDatabase.ts`, `src/utils/leadershipKpiFeed.ts`, `src/utils/leadershipPush.ts`, `dashboard/kpis.html`, `dashboard/js/navigation.js`, `dashboard/compliance.html`, `dashboard/i18n/{en,ar}.json`, `src/mastra/index.ts`, `src/mastra/routes/certificationMilestoneRoutes.ts`) and republish. The added columns (`certification_milestones.milestone_type/regulation_id/milestone_key/plan_version/source_doc`, `kpi_definitions.methodology_changed_at/methodology_note`) are nullable/defaulted and harmless if left in place — no down-migration is required. The 16 seeded milestone rows and the SACS-002 regulation row can be left in the database; they are inert without the code that reads them.
