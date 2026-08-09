# Deal-Compliance Full Breakdown in the Sales BU Report — Design Spec

**Date:** 2026-08-09
**Author:** Sarah Hijazi (GRQ) + Claude
**Status:** Approved shape — pending spec review
**Builds on:** Quality Reports Phase 2 (`getSegmentDealComplianceSummary`) + Phase 3 (BU report email).

## 1. Goal

Turn the Sales BU page's one-line deal-docs figure into a **full deal-compliance report** — compliant/missing, at-risk SAR, by-stage, by-owner (top 10), and the top missing document types — mirroring the Deal Compliance tab, inside the shareable Quality Reports BU page and its email-to-head. No new engine; expand the existing summary function + its rendering.

Only the **Sales (B2B)** and **Sales (B2C)** BUs carry `deal_compliance` (per `functionReportKeys`), so this breakdown appears only on those two pages, scoped to their segment (walaplus / walaone).

## 2. Data source

`deal_doc_compliance` (per-deal: `zoho_deal_id`, `stage`, `compliant`, `missing_docs` jsonb `[{key,label}]`, `checked_at`) joined to `duplicate_records` for segment/owner/amount:
```sql
SELECT d.stage AS stage,
       d.compliant AS compliant,
       COALESCE(r.deal_value, 0) AS amount,
       COALESCE(NULLIF(r.owner_name,''), NULLIF(r.owner_email,''), 'Unassigned') AS owner,
       d.missing_docs AS missing_docs
  FROM deal_doc_compliance d
  JOIN duplicate_records r ON r.zoho_record_id = d.zoho_deal_id
 WHERE r.record_type = 'deal'${segmentCond}   -- buildSegmentPredicate, corporate→walaplus
```
`deal_doc_compliance` holds only doc-checked deals (bounded, ~thousands max), so fetching the per-deal rows and aggregating in application code is cheap and keeps the aggregation logic pure + unit-testable.

## 3. Pure shaper

New `src/utils/dealComplianceReport.ts`:
```ts
export interface DealComplianceRow { stage: string; compliant: boolean; amount: number; owner: string; missing_docs: Array<{ key?: string; label?: string }> | null; }
export interface DealComplianceSummary {
  segment: string;
  checked: number;
  compliant: number;
  compliant_rate: number | null;              // null when checked === 0 (never 0%)
  at_risk_sar: number;                          // Σ amount of NON-compliant checked deals
  by_stage: Array<{ stage: string; checked: number; compliant: number; missing: number }>;
  by_owner: Array<{ owner: string; checked: number; compliant: number; missing: number }>; // top 10 by missing desc
  owner_overflow: number;                       // # owners beyond the top 10 (for "N more")
  top_missing_docs: Array<{ label: string; count: number }>; // desc by count, from missing_docs of non-compliant deals
}
export function shapeDealCompliance(segment: string, rows: DealComplianceRow[]): DealComplianceSummary;
```
Rules: `compliant_rate = checked ? round(100*compliant/checked) : null`. `at_risk_sar` sums `amount` where `!compliant`. `by_stage`/`by_owner` group + count (`missing = checked − compliant`). `by_owner` sorted by `missing` desc, sliced to 10, `owner_overflow` = remaining owner count. `top_missing_docs` counts each `missing_docs[].label` across non-compliant rows, sorted desc.

## 4. `getSegmentDealComplianceSummary` (expanded, backward-compatible)

In `duplicateRadarDatabase.ts`, change the function to run the §2 query and return `shapeDealCompliance(seg, rows)`. The return is a **superset** of the Phase-2 `{segment, checked, compliant, compliant_rate}`, so existing callers keep working; new fields are added. Corporate→walaplus normalize unchanged.

## 5. Aggregator — no change

`getBUReport`'s compliance section already does `out.dealCompliance = await DRD.getSegmentDealComplianceSummary(bu.segment)`. It now carries the fuller object automatically. No aggregator edit.

## 6. UI — Sales BU page (`dashboard/js/quality-reports.js`)

Expand `qrComplianceHtml`'s deal-compliance block from the single line to a full breakdown (class-only, CSP-safe, `escapeHtml` on all dynamic text; numbers via `textContent`-safe interpolation of numeric values):
- Headline: `Deal docs: X/Y compliant (Z%)` or `no deals checked yet`; **At-risk: SAR N** (compact format, reuse `formatCurrency`/compact helper if present on the page else plain `toLocaleString`).
- **By stage** mini-table: Stage · checked · compliant · missing.
- **By owner** table (top 10): Owner · checked · compliant · missing; append "and N more" when `owner_overflow > 0`.
- **Top missing documents**: list `label — count`, top ~6.
Keep the existing "not configured"/"no deals checked yet" states.

## 7. Email — condensed (`src/utils/qualityReportsEmail.ts`)

In `renderBUReportEmailHtml`'s compliance section, when `dealCompliance` is present, render a **condensed** block (email inline-styled): headline `X/Y compliant (Z%)` (or "no deals checked yet"), `At-risk: SAR N`, a small **by-stage** table, and **top-3 missing documents**. Do NOT include the full by-owner table in the email (page-only). All values `escHtml`-escaped.

## 8. Non-goals
- No new report surface, no scheduling, no CSV change (the tab's Export CSV already covers raw per-deal data).
- By-owner beyond top 10 is not listed in the report (page shows "N more"); the tab remains the drill-down.
- No change to the compliance rule itself (that's the separate 5-doc alignment already shipped).

## 9. Testing
- Pure `shapeDealCompliance` (CJS-emit + node; vitest can't run locally): compliant_rate null@0; at_risk_sar sums only non-compliant amounts; by_stage/by_owner counts; owner top-10 + overflow; top_missing_docs aggregation + ordering; "Unassigned" owner fallback.
- `getSegmentDealComplianceSummary` still returns the Phase-2 fields (superset) — a mocked-pool test asserting the query joins `deal_doc_compliance`→`duplicate_records` and the result carries `by_owner`/`by_stage`/`at_risk_sar`.
- `tsc --noEmit` + `tsc -p tsconfig.tests.json` + `check-dashboard-html-js.mjs` + `node --check` clean.
- Manual (post-republish): Sales BU page shows the breakdown; email-to-head preview shows the condensed version.

## 10. Deployment
Commit only touched files; push `origin/QMS`; bump `quality-reports.js?v=4`→`?v=5`; user Pulls → Republishes. No schema changes. (Existing `deal_doc_compliance` rows already store `stage`/`compliant`/`missing_docs`, so the breakdown works immediately on checked deals; re-checking under the new 5-doc rule refreshes verdicts.)
