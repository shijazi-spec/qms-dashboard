# Department KPI Separation — Design Spec

**Date:** 2026-08-16
**Author:** Sarah Hijazi (GRQ) + Claude
**Status:** Approved shape — pending spec review
**Builds on:** Quality Reports Dept Hub P1–P3, plus the catalog-KPI feature shipped `39770296` / `c7889bee`.

## 1. Goal

Split **department KPIs** (SDR Team, Sales Team) from **GRQ's own KPIs**.

- The KPI Engine at `/kpis` shows ONLY GRQ KPIs — Sarah, Maram, AlHanouf, Ali Fahad, GRQ Team.
- Department KPIs (`SDR-KPI-01…11`, `SALES-KPI-01…09`) live solely on their Quality Reports BU page, where they can be opened and added.

Nothing about how KPIs are calculated changes. This is a visibility + management-surface change.

## 2. Current state (verified 2026-08-16)

- **One table.** `kpi_definitions` holds both sets, distinguished by `owner_name` (`"SDR Team"`, `"Sales Team"`) and `owner_type` (`"sdr_team"`, `"sales_team"`).
- **`owner_type` already carries a team value.** The CREATE TABLE CHECK lists only the four governance roles (`kpiDatabase.ts:114`), but a later migration (`kpiDatabase.ts:221-223`) drops and re-adds it widened to include `grq_specialist`, `legal_specialist`, `sdr_team` and `sales_team`. So a second plausible classifier exists in the data. §4 explains why it is deliberately NOT the one used.
- **`/api/kpis` is unfiltered.** `kpiRoutes.ts:136` calls `getAllKPIDefinitions()` (`WHERE is_active = true`, no owner filter) — which is why SDR Team and Sales Team appear in the engine's totals, RAG counts and owner donut.
- **The BU page already fetches the right set** via `bu.kpi_owner_name` → `getKPIsWithValuesByOwnerName()` (`kpiDatabase.ts:1727`), but renders rows **read-only** — no link to `/kpi/:id`, which already exists with an in-page editor and the HOD approve/lock flow.
- **Leadership is unaffected.** The leadership feed/push targets explicit `GRC-KPI-*` / `QM-KPI-*` codes; the "2 BU KPIs" in `c4096b23` are the QM-KPI-015 Framework/Pilot **checklist** KPIs, not SDR/Sales. No SDR-KPI/SALES-KPI code appears in any leadership module.

## 3. Binding constraint — exclude at the presentation layer ONLY

`getAllKPIDefinitions()` has four callers, and they are not all presentation:

| Caller | Purpose | Action |
| --- | --- | --- |
| `kpiRoutes.ts:136` → `GET /api/kpis` | engine list | **FILTER** |
| `kpiDatabase.ts:2050` → `getKPIDashboardSummary` | stat cards + 3 charts | **FILTER** |
| `scheduledJobs.ts:81` | scheduled value recording | **DO NOT FILTER** |
| `inngest/index.ts:304` | job-runner value recording | **DO NOT FILTER** |

Most SDR/Sales KPIs are `calc_mode = 'auto'` — `kpiProcessCalc.ts` derives them from CRM. **If the filter is placed inside `getAllKPIDefinitions()` itself, those jobs stop recording values and the BU page silently degrades to `--` forever.** The filter MUST be applied by each presentation caller, never in the shared data function.

The two exports do not use that function at all — `/api/kpis/export` (`qmsEnhancedRoutes.ts:805`) and `/api/kpis/export-xlsx` (`qmsEnhancedRoutes.ts:850`) run their own raw SQL against `kpi_definitions`, so they need the exclusion applied independently or the Excel/CSV output will still contain department KPIs.

## 4. Classification — derived from the BU registry

New helper in `src/utils/qualityReportsDepartments.ts`:

```ts
getDepartmentKpiOwnerNames(): Promise<string[]>
```

Returns the DISTINCT non-null, non-empty `kpi_owner_name` values from **active** rows of `quality_report_bus` (today: `SDR Team`, `Sales Team`). In-process cache with a short TTL (60s) plus an exported `invalidate` called by `upsertBU`, so an admin mapping change takes effect without a restart.

**No schema change.** The BU registry is the single source of truth for "which teams are departments we report on".

**Orphans are impossible by construction.** If no active BU claims an `owner_name`, its KPIs are NOT departmental and therefore remain visible in `/kpis`. Deactivating or unmapping a BU returns its KPIs to the engine rather than hiding them everywhere. This is the deliberate safe direction and must not be inverted.

Matching is exact string equality on `owner_name`, consistent with `getKPIsByOwnerName()` (`kpiDatabase.ts:1712`). No trimming/case-folding is introduced here — if a mismatch shows up in practice, fix the data, not the comparison, so the two lookups can never disagree about which set a KPI belongs to.

### Why not classify by `owner_type IN ('sdr_team','sales_team')`

It would work today and needs no join. It is rejected because it does not extend: every new department (CS, Partnership, Onboarding, PartnerSuccess) would need a CHECK-constraint migration plus a data backfill before its KPIs could be separated, whereas registry derivation makes mapping a BU the only required action. It can also drift — a KPI could carry `owner_type='sdr_team'` while no BU claims `SDR Team`, leaving two sources disagreeing about the same row.

**Exactly one classifier is used: the BU registry.** `owner_type` is never consulted for visibility decisions, so the two can never conflict.

### Empty set

When no active BU has a `kpi_owner_name` the helper returns `[]`, and every surface must then exclude nothing — `/kpis` shows all KPIs, exactly as it does today. This falls out naturally in both forms (a JS `.includes()` against an empty array is always false; SQL `x <> ALL('{}')` is TRUE), but it is stated here because the opposite failure — an empty set hiding everything — would empty the KPI Engine in production. The implementation must not "optimise" the empty case into a no-op that skips the WHERE clause in one surface but not another.

## 5. Changes by surface

### 5.1 `GET /api/kpis` (`kpiRoutes.ts`)

After building `kpis` (both the `getAllKPIDefinitions()` and `getKPIsByOwner(ownerType)` branches), drop any row whose `owner_name` is in the departmental set. Apply the filter BEFORE the per-KPI value-attachment `Promise.all` so excluded rows cost no value lookups.

### 5.2 `getKPIDashboardSummary` (`kpiDatabase.ts:2047`)

Filter the same way immediately after `getAllKPIDefinitions()`. This corrects `total`, `byStatus`, `byCategory` and `kpiDetails` together.

`byOwner` currently seeds hardcoded `sdr_team` and `sales_team` buckets — **remove those two keys** rather than leaving permanent zeros. Consumers read the object by key, so a missing key and a zero both render as "no KPIs"; dropping them keeps the donut legend honest.

Because this function is in `kpiDatabase.ts` and the helper is in `qualityReportsDepartments.ts`, import it lazily (`await import`) inside the function to avoid a load-time cycle — the same pattern the Quality Reports aggregator already uses.

### 5.3 Exports (`qmsEnhancedRoutes.ts:805` and `:850`)

Add to each statement's WHERE clause:

```sql
AND (kd.owner_name IS NULL OR kd.owner_name <> ALL($1::text[]))
```

passing the departmental owner-name array. The `IS NULL` arm matters — `owner_name` is nullable and a NULL owner must remain a GRQ KPI. The xlsx endpoint runs several statements (count, category list, rows); every statement that reads `kpi_definitions` needs the same clause or its sheet totals will disagree with its rows.

### 5.4 Untouched by design

`/kpi/:id`, `GET /api/kpis/:id`, `PUT /api/kpis/:id`, `/api/kpis/:id/lock`, `/api/kpis/:id/values`, `/api/kpis/:id/history`, `/api/kpis/:id/detail`, `/api/kpis/recalc`, `/api/kpis/seed-sdr`, `/api/kpis/seed-sales`, the scheduled jobs and the Inngest runner. Direct-by-id access MUST keep working for department KPIs — the BU page links straight there.

## 6. BU page changes (`dashboard/js/quality-reports.js`)

### 6.1 Open a KPI

In `qrKpisHtml`, wrap each row in an anchor to `/kpi/<id>`. Requires `id` on each row — confirm `CatalogKpiWithValue` carries it (it is selected by `getKPIsByOwnerName`'s `SELECT *`) and add it to the mapped shape if the aggregator drops it. Rows without an `id` render as plain non-clickable rows rather than dead links.

Keep the existing row layout (RAG dot, name, code, Auto badge, value, target) — this adds navigation, not a redesign. Bump `quality-reports.js?v=` in `dashboard/quality-reports.html`.

### 6.2 Add a KPI

An **+ Add KPI** button in the KPIs section header, shown only when the BU has a `kpi_owner_name` and only for the roles that already gate KPI writes. It opens a small modal collecting the minimum `POST /api/kpis` requires — `kpi_name`, `kpi_code`, `category`, `target_value`, `unit`, thresholds — and sets `owner_name` from `bu.kpi_owner_name` server-side-visible but non-editable in the form, so a KPI created here always lands in this BU's set.

On success, re-fetch the BU report so the new row appears.

`POST /api/kpis` also requires `owner_type`, which the BU registry does not store. Resolve it deterministically server-side: take the `owner_type` of any existing active KPI with the same `owner_name` (all of a team's rows share one — `sdr_team` for SDR Team, `sales_team` for Sales Team), falling back to `'shared'` when the team has no KPIs yet. This keeps new rows consistent with the seeded ones without a schema change and without the client choosing a value. Note the widened CHECK (`kpiDatabase.ts:221-223`) permits only the eight listed values, so the fallback must be `'shared'` and never a derived string like `"cs_team"` — a new team's first KPI lands as `shared`, which is harmless because visibility is decided by the BU registry, not by `owner_type`.

### 6.3 KPI Engine note

A one-line note under the `/kpis` header: department KPIs now live in Quality Reports, with a link to `/quality-reports`. Without it, the drop in "Total KPIs" reads as data loss to anyone who does not know about this change.

## 7. Testing

- **Classification:** with `SDR Team` and `Sales Team` mapped, `getDepartmentKpiOwnerNames()` returns exactly those two; with the BU deactivated it returns neither and those KPIs reappear in `/api/kpis`.
- **Presentation exclusion:** `/api/kpis` and `/api/kpis/summary` contain no `SDR-KPI-*` / `SALES-KPI-*`; `summary.total` drops by exactly the count of active departmental KPIs; `byOwner` has no `sdr_team` / `sales_team` keys.
- **Exports:** CSV and xlsx contain no departmental rows, and the xlsx count sheet matches its row sheets.
- **Calculation intact (the regression that matters):** after a scheduled/recalc run, a departmental auto KPI still has a fresh `kpi_values` row. This is the check that catches the wrong-layer filter.
- **Direct access intact:** `/kpi/<departmental id>` and `GET /api/kpis/<id>` still return the KPI.
- **BU page:** rows link to the right id; Add KPI creates a KPI that appears on the BU page and NOT in `/kpis`.
- **Null owner:** a KPI with `owner_name IS NULL` stays in `/kpis` and both exports.

## 8. Out of scope

Inline editing on the BU page (rows link to the existing `/kpi/:id` editor instead); any change to KPI calculation, thresholds or seeds; any change to the leadership feed or push; B2C/Marketplace BUs, which have no `kpi_owner_name` mapped and are unaffected until one is added.

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| Filter placed in `getAllKPIDefinitions()` → auto KPIs stop recording, BU page goes stale silently | Section 3 is binding; the calculation-intact test in §7 is the gate |
| An export statement missed → Excel still leaks department KPIs | §5.3 requires every `kpi_definitions` statement in both endpoints to carry the clause |
| `owner_name` mismatch between BU mapping and KPI row → KPI appears in neither place | Impossible by §4: unclaimed ⇒ stays in `/kpis` |
| Users think KPIs were deleted when the total drops | §6.3 note on the KPI Engine header |
