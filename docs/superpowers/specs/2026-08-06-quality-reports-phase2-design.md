# Quality Reports — Phase 2 — Design Spec

**Date:** 2026-08-06
**Author:** Sarah Hijazi (GRQ) + Claude
**Status:** Approved shape — pending spec review
**Builds on:** Phase 1 (`docs/superpowers/specs/2026-08-05-quality-reports-department-hub-design.md`, shipped `d8aae8f4`). Phase 3 (email-to-heads) remains OUT OF SCOPE.

## 1. Goal

Close the three deferred Phase-1 items on the Quality Reports hub:
1. **Deal-compliance rollup** for Sales BUs (the `deal_compliance` report key that was deferred).
2. **Deep-link** to a BU page via `?bu=<key>`.
3. **Hub-card live-status one-liner** (at-a-glance metrics per BU box), loaded **lazily per card**.

No new subsystems — all three extend existing Phase-1 code.

## 2. Item 1 — Deal-compliance rollup (Sales)

`deal_doc_compliance` (`duplicateRadarDatabase.ts:927`) stores per-deal doc-compliance results keyed by `zoho_deal_id` (`stage`, `compliant` BOOLEAN, present/missing docs, `checked_at`) — **populated by the existing "Check all documents" batch on the Deal Compliance tab**. It has NO segment column, so scope it the same way cleanup does: join `zoho_deal_id → duplicate_records.zoho_record_id → layout` via `buildSegmentPredicate`.

**New function** `getSegmentDealComplianceSummary(segment)` in `duplicateRadarDatabase.ts`:
```sql
SELECT COUNT(*)::int AS checked,
       COUNT(*) FILTER (WHERE d.compliant)::int AS compliant
  FROM deal_doc_compliance d
  JOIN duplicate_records r ON r.zoho_record_id = d.zoho_deal_id
 WHERE <buildSegmentPredicate(r, segNormalized)>   -- corporate→walaplus
```
returns `{ segment, checked, compliant, compliant_rate }` where `compliant_rate = checked ? round(100*compliant/checked) : null`.

**Wiring:**
- Re-add `"deal_compliance"` to `functionReportKeys("sales")` → `["deals", "deal_compliance", "stage_aging"]`.
- In the aggregator's `compliance` section, when `keys.includes("deal_compliance")`, set `out.dealCompliance = await DRD.getSegmentDealComplianceSummary(bu.segment)`.
- Restore the `|| k === "deal_compliance"` term in the compliance section's enabled-predicate.
- **UI caveat (must be shown):** the number reflects **only deals that have been doc-checked**. The BU page renders it as "Deal docs: X/Y compliant (Z%) — of checked deals", and when `checked === 0` shows "No deals checked yet" (not 0%).

## 3. Item 2 — Deep-link `?bu=<key>`

In `dashboard/js/quality-reports.js`, on load: read `?bu=` from the URL; if present and it matches a BU in the list, call `qrOpenBU(buKey)` directly instead of showing the hub. The existing "← All units" back button returns to the hub (and should `history.pushState`/clear the query so back-nav is sane). Opening a BU also updates the URL to `?bu=<key>` so the page is shareable/bookmarkable. No backend change.

## 4. Item 3 — Hub-card live-status one-liner (lazy per-card)

**New lightweight endpoint** `GET /api/quality-reports/bus/:buKey/summary` → `getBUHeadline(buKey)` (new, in `qualityReportsAggregator.ts`). It computes ONLY cheap headline counts — NOT the heavy violation scans — so 9 concurrent card fetches stay light:
```ts
interface BUHeadline {
  bu_key: string;
  sops: number | null;        // policies count for policy_department, or null if unmapped
  kpiPct: number | null;      // getFrameworkProgressByBU()[kpi_bu_name].pct, or null if unmapped
  outstanding: number;        // segment+function outstanding dup count (leads for sdr; deals otherwise)
  openCapas: number | null;   // open CAPAs assigned to this BU's owners, or null if no owners mapped
}
```
- `sops` = `getAllPolicies({ owner_department })`.length when mapped, else null.
- `kpiPct` = the BU's framework pct when `kpi_bu_name` mapped, else null.
- `outstanding` = `getSegmentLeadDuplicateCount(segment).outstanding_leads` for `fn==='sdr'`; otherwise the segment outstanding **deal** dup count (reuse the outstanding-deals count query already in `getDataCleaningProgress`'s outstanding block — extract a small `getSegmentDealDuplicateCount(segment)` helper mirroring `getSegmentLeadDuplicateCount`). No heavy scan.
- `openCapas` = count of open CAPAs whose `assigned_to` ∈ the BU's owner set, else null (reuse `getCapaRecords({status:'open', limit:5000})` filtered by owners — same as the full report's actions section).

**Client (`quality-reports.js`):** after `qrLoadHub` renders the grid, for each card fire `GET /bus/:buKey/summary` (fire-and-forget, independent) and fill a `<div class="rr-sub">` status line: e.g. `KPIs 60% · 12 outstanding · 2 open CAPAs` — omitting any metric whose value is null (unmapped) so the line only shows what's configured. On fetch error, leave the line blank (no error noise on the grid). CSP-safe (classes only), values via `escapeHtml`.

**RBAC:** add `{ pattern: /^\/api\/quality-reports\/bus\/[^/]+\/summary$/, methods: ["GET"], roles: <READ_ROLES> }`. Note the existing `/^\/api\/quality-reports\/bus\/[^/]+$/` GET/DELETE rule does NOT match the `…/summary` suffix, so a dedicated entry is required.

## 5. Non-goals
- Email-to-heads (Phase 3).
- No new heavy scans on the hub — the one-liner uses cheap counts only.
- `deal_doc_compliance` is not back-filled — the rollup covers whatever has been doc-checked; unchecked deals are out of scope by design (surfaced in the UI caveat).

## 6. Testing
- Unit (pure): `functionReportKeys("sales")` now returns `["deals","deal_compliance","stage_aging"]` (update the pinned test); `getBUHeadline` null-vs-number shaping for mapped/unmapped fields (split the shaping into a pure helper if practical, executed via tsc-CJS-emit — vitest can't run locally).
- DB functions (`getSegmentDealComplianceSummary`, `getSegmentDealDuplicateCount`, `getBUHeadline`) verified via `tsc --noEmit` + reading SQL (segment predicate, join, corporate normalize); mocked-pool vitest test asserting `getSegmentDealComplianceSummary` SQL joins `deal_doc_compliance` to `duplicate_records` and filters `compliant`.
- `tsc -p tsconfig.tests.json`, `check-dashboard-html-js.mjs`, `node --check` clean.
- Manual (post-republish): Sales BU shows a deal-docs compliance line; `?bu=sales_b2b` opens that BU directly; hub cards fill their status lines progressively.

## 7. Deployment
Commit only touched files; push `origin/QMS`; bump `dashboard/quality-reports.js` isn't versioned via `?v=` (the page is served fresh) — but if it references a `?v=`, bump it. User Pulls → Republishes. No schema changes (no new tables/columns); no DROP.
