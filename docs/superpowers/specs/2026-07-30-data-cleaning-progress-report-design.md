# Data Cleaning Progress Report — Design Spec

**Date:** 2026-07-30
**Author:** Sarah Hijazi (GRQ) + Claude
**Status:** Approved shape — pending spec review

## 1. Goal

Surface a trustworthy **Data Cleaning Progress** report *inside* the platform, showing
how much duplicate / messy data has actually been cleaned across the Duplicate Radar's
lifetime, broken down by **module (Deals & Accounts)** and **segment
(All / Marketplace / WalaPlus / WalaOne)**, in a form Sarah can share with leadership / CS.

This replaces the ad-hoc, internally-contradictory numbers Adam produced from
`getEnhancedSummary` (e.g. "11,108 total clusters" vs "108,270 active clusters").

### Success criteria
- Every number reconciles (no active > total, no cluster/record conflation).
- Headline = **verified** cleanup, not "tagged-for-delete".
- Segment chip behaves exactly like the other radar tabs.
- One backend function is the single source of truth for the tab, the export, and Adam.

## 2. Prerequisite bug fix (trust) — MUST land first

`getEnhancedSummary()` (`src/utils/duplicateRadarDatabase.ts` ~DRD:8039-8268) computes
`activeCount` / `resolvedCount` / `ignoredCount` (DRD:8107-8109) with **no duplicate
gate**, so they count ~100k+ singleton clusters (one lone record each). That is the
source of the "108,270 active clusters" figure.

**Fix:** add the same real-duplicate filter that `trueDuplicateClusters` uses
(DRD:8079) to all three counts:

```
FILTER (WHERE dc.status = '<state>' AND ra.cluster_id IS NULL
        AND GREATEST(dc.total_leads, dc.total_deals, dc.total_contacts, dc.total_accounts) > 1)
```

Mirror the existing `MULTI` gate in `getClusterSummary` (DRD:4243/4278). After the fix,
`resolutionRate` (denominator = trueDup + resolved + ignored, DRD:8230-8237) is coherent.

**Scope:** ~3 count expressions + verify the resolution-rate denominator. No schema
change. Corrects Adam's executive summary everywhere, not just this report.

## 3. Data sources (source-of-truth audit)

| Metric | Table / field | Segmentable? | Trust |
|---|---|---|---|
| Outstanding duplicates (now) | `duplicate_records` non-primary members of active dup clusters, per `record_type`, via `buildSegmentPredicate` | **Yes** (live) | High |
| Verified duplicate merges | `duplicate_resolution_ledger` WHERE `action_type='resolve'`, grouped by `module` | **Yes** via survivor-join (see §5) | High (durable across rebuilds) |
| Est. duplicate records removed | `SUM(jsonb_array_length(duplicate_zoho_ids))` on the same `resolve` rows | Yes via survivor-join | Medium — undercounts old backfill rows where `duplicate_zoho_ids = []` |
| Empty/messy records deleted | `empty_delete_ledger` WHERE `status='deleted'`, grouped by `module` | **No** (no layout stored; record gone from mirror) | High (only table that verifies real Zoho deletion, `emptyRecordsDatabase.ts`:824-851) |
| Burndown trend | `duplicate_progress_daily` per module | **Forward-only** (see §4) | Medium (`merged_count` inherits tagged-vs-deleted ambiguity) |

### Explicitly EXCLUDED (not cleanup / not verified)
- `action_type IN ('module_resolved','auto_merge_pending')`, `duplicate_resolution_feedback.event_type='applied'`,
  `merge_jobs.tagged` — these are **tagged-for-delete, not deleted** (guidance: `qmsConsultantAgent.ts`:86 "Tagged ≠ deleted"; DRD:2200-2214).
- `duplicate_separation_ledger` — records "these are NOT duplicates" splits (the inverse of cleanup). Never count.

## 4. Schema change (additive, safe) — `duplicate_progress_daily`

Current (DRD:1362-1372): `PRIMARY KEY (snapshot_date, module)`, columns
`open_count, solved_count, total_count, merged_count, created_at`. **No segment column.**
Historical rows are all-segments-combined and cannot be retroactively split.

**Decision (approved):** segment the trend *going forward*.

Migration (idempotent, run in the table-init path):
```sql
ALTER TABLE duplicate_progress_daily
  ADD COLUMN IF NOT EXISTS segment VARCHAR(16) NOT NULL DEFAULT 'all';
ALTER TABLE duplicate_progress_daily DROP CONSTRAINT IF EXISTS duplicate_progress_daily_pkey;
ALTER TABLE duplicate_progress_daily
  ADD PRIMARY KEY (snapshot_date, module, segment);
```
Existing rows default to `segment='all'` → no PK collision. **No DROP TABLE** (respects the
Replit publish schema-sync trap). **Schema-parity:** update the canonical `CREATE TABLE`
at DRD:1362-1372 to include `segment` + the 3-column PK so `check:schema-parity` stays green.

**Writer** — `captureDuplicateProgressSnapshot()` (DRD:2268-2330): after writing the
existing `segment='all'` row (unchanged behavior), loop the segments
`['marketplace','walaplus','walaone']` and UPSERT one row per (module, segment), applying
`buildSegmentPredicate(seg)` — which requires joining `duplicate_records r` for layout
(the current query is `FROM duplicate_clusters dc` only, DRD:2287; add the join for the
segmented passes). `merged_count` per segment = `resolve`/ledger rows attributed to that
segment via §5 survivor-join.

**Reader** — `getDuplicateProgressSeries(days, segment='all')` (DRD:2347-2403): add a
`segment` param, filter `WHERE segment = $segment`. Default `'all'` preserves current
callers.

## 5. Segment attribution for removal counts (survivor-join)

The removal ledgers have no segment column. Attribute each `duplicate_resolution_ledger`
row to a segment via the **surviving** record's layout (the survivor is kept in Zoho and
in the mirror):

```sql
SELECT COUNT(*) AS verified_merges,
       COALESCE(SUM(jsonb_array_length(NULLIF(l.duplicate_zoho_ids,'[]'::jsonb))),0) AS est_records_removed
FROM duplicate_resolution_ledger l
LEFT JOIN duplicate_records r ON r.zoho_record_id = l.master_zoho_id
WHERE l.action_type = 'resolve'
  AND l.module = $module            -- 'Deals' | 'Accounts'
  AND (<buildSegmentPredicate(r, seg)>  OR $seg = 'all')
```
- For `segment='all'`: drop the predicate (count everything).
- Rows whose survivor is missing from `duplicate_records` (deleted / re-clustered) fall into
  an **"unknown segment"** bucket — reported separately, never silently dropped
  (per the no-silent-caps rule).

## 6. Backend endpoint

`GET /api/duplicates/cleaning-progress?segment=<all|marketplace|walaplus|walaone>`

- Handler in `src/mastra/routes/duplicateRadarRoutes.ts`, `requireDuplicateRadarAccess` gate,
  registered in the route array `{path, method:'GET', createHandler}`.
- **RBAC:** add an allowlist entry in `src/utils/rbacMiddleware.ts`
  `{pattern: /^\/api\/duplicates\/cleaning-progress$/, methods:['GET'], roles:[...radar roles]}`.
- Backing function `getDataCleaningProgress(segment)` in `duplicateRadarDatabase.ts` returns:

```ts
{
  segment,
  generated_at,
  last_sync_at,                       // from zoho_sync_state
  modules: {
    Deals:    { outstanding, verified_merges, est_records_removed, empty_deleted },
    Accounts: { outstanding, verified_merges, est_records_removed, empty_deleted },
  },
  unknown_segment: { verified_merges, est_records_removed }, // survivor missing
  empty_deleted_note: "all-segments (no layout on deletion record)",
  trend: { days, series:[{date, module, open, solved, total, merged}], first, latest },
}
```
- `empty_deleted` is **all-segments** regardless of the chip (data limit) — the field
  carries a note flag so the UI can label it. When `segment != 'all'`, the UI shows the
  all-segments empty-deleted figure with an explicit "all layouts" tag rather than pretending
  it is segmented.

## 7. UI — new "Cleaning Progress" tab

In `dashboard/duplicates.html` + `dashboard/js/duplicates-app.js`:
- New tab registered like the others (tab id `cleaning-progress`), shares the existing
  `#filterSegment` chip and per-tab persistence (`setSegment` clears cached tab data →
  refetch, matching the CS-Lifecycle pattern).
- **KPI cards** (`rr-kpi rr-kpi-rich`), two rows:
  - **Deals:** Outstanding · Verified merges · Est. records removed
  - **Accounts:** Outstanding · Verified merges · Est. records removed
- **Empty/messy deleted** card (Deals + Accounts) — labeled **"all layouts"** with a note.
- **Burndown trend** — small SVG/canvas line (open vs solved over time) + a "first snapshot
  → latest" delta line. All-segments history labeled; per-segment once the chip has forward
  data. If a chosen segment has no per-segment history yet, show "trend starts building today
  for this segment" rather than an empty chart.
- **Explanations panel** — one plain-language sentence per metric (what it counts, why it's
  trustworthy, the tagged-vs-deleted distinction, the undercount footnote on est-removed).
- **Print / Export** — a print-friendly view + CSV of the KPI table, so the report can be
  sent. Reuse `downloadCsvRows`.
- Bump `duplicates-app.js?v=` cache-buster.

## 8. Adam tool

`cleaningProgressTool` (`src/mastra/tools/radarTabTools.ts` or a new file) → calls
`getDataCleaningProgress(segment)`. Registered in `qmsConsultantAgent.ts`. So "give me the
data cleaning report for WalaPlus Deals & Accounts" returns these reconciled numbers.
Description: crisp, no "use when asked <phrasings>" bloat (per the trim rules). No new
business rules embedded in prose.

## 9. Non-goals / known limits (state them in the UI)
- Historical burndown **cannot** be split by segment before today.
- Empty/messy deletions are **all-segments** only.
- "Est. duplicate records removed" may **undercount** cleanup done before per-record ID
  tracking existed — footnoted, not hidden.
- No write actions on this tab — read-only report.

## 10. Testing
- Unit: segment-attribution SQL semantics (survivor present / missing / all), the singleton-gate
  fix (active ≤ total invariant), reader `segment` filter default.
- Vitest around `getDataCleaningProgress` with a seeded fixture: verified `resolve` rows across
  modules/segments, an `empty_delete_ledger` deleted row, a `module_resolved` row (must be
  excluded), a `separation_ledger` row (must be excluded).
- Invariant test: `active + resolved + ignored` counts never exceed `trueDuplicateClusters + resolved + ignored`.
- `tsc --noEmit` clean; `node --check` the JS; `check:schema-parity` green after the ALTER.

## 11. Deployment
- Commit only the touched files. Push to `origin/QMS`, bump `v=`, then Sarah **Pull → Republish**.
- The `ALTER TABLE` runs in the idempotent table-init path on boot (no manual migration,
  no DROP). Verify `check:schema-parity` before publish.
