# Leadership ↔ QMS KPI Feed — Period Basis & Calculation Parity Answer (2026-06-18)

Answer to `attached_assets/QMS_LEADERSHIP_KPI_ALIGNMENT_PROMPT_*.md` sections 5–6.
Source of truth: `src/utils/leadershipKpiFeed.ts`; feed route: `GET /api/kpis/leadership-feed`.

## What changed in the feed contract

Every `kpis[]` item now carries an **explicit period basis** alongside the legacy
`period` label:

- `period_type`: `"month" | "quarter" | "cumulative" | "ytd"`
- `period_start`: ISO date — first day the value covers (`null` for `cumulative`)
- `period_end`: ISO date — last day covered (= `as_of` for cumulative/QTD)

The same fields are documented per KPI in `definitions[]`, together with
`numerator`, `denominator`, `scope`, and `rounding`. A KPI's `period_type` is
fixed per `code` (`PERIOD_TYPE_BY_CODE`), so a KPI can never silently switch
basis between calls (Safety rule 4 / §2 rule 3).

## §6.1 — True period basis of the 4 mapped KPIs (and is it now explicit?)

| KPI | `period_type` | Why | Exposed now? |
|---|---|---|---|
| `QM-KPI-002` Audit Execution Rate | **quarter** (QTD) | Measured against the per-BU **quarterly** audit plan; progresses through the quarter. `period_start` = quarter start, `period_end` = `as_of`. | ✅ |
| `QM-KPI-008` BU Coverage Rate | **cumulative** | Running point-in-time coverage of the 13 BUs; only moves as records are added, not bounded to a period. `period_start` = `null`. | ✅ |
| `GRC-KPI-008` Compliance Coverage Index | **cumulative** | Running share of applicable obligations mapped to a control/policy; point-in-time snapshot. | ✅ |
| `QM-KPI-015` QMS Framework Completion | **cumulative** | Running share of policies published-and-in-review; point-in-time snapshot. | ✅ |

This matches the prompt's reading (Audit = quarter/QTD; other three = cumulative).

## §6.2 — Are GRC-KPI-008 and QM-KPI-015 truly 0, or not populated?

**Not populated → now moved to `unavailable[]` (no longer a fake `value: 0`).**

Both KPIs previously emitted `value: 0, data_available: true` whenever the
denominator was > 0 but the numerator was 0. That is indistinguishable from a
real zero and would let the connector overwrite Leadership's real number with a
fabricated 0. Fixed in `calcComplianceCoverage` and `calcProcessQualityFramework`:
when `denominator > 0 && numerator == 0`, the calc now returns
`dataAvailable: false` with an explicit reason:

- `GRC-KPI-008` → `reason: "no_obligations_mapped_yet"`
- `QM-KPI-015` → `reason: "no_published_in_review_policies_yet"`

Runtime check (2026-06-18) confirms both appear in `unavailable[]` with these
reasons rather than in `kpis[]`. (A genuine 0 — e.g. denominator itself 0, or
numerator 0 with a real mapped baseline — is still distinguishable; only the
"nothing entered yet" case is suppressed.)

This satisfies Safety rules §4.1–§4.3: no fabricated 0 is ever pushed over a real
value, and `data_available: true` always means a genuinely computed value.

## §6.3 — Does any KPI compute monthly?

No. None of the 4 mapped KPIs (nor the currently-live feed KPIs) compute on a
monthly basis, so no monthly→QTD roll-up is required. `period_type` is either
`quarter` (Audit Execution + the North Star composites, which reset each quarter)
or `cumulative` (everything else by default). The `"month"`/`"ytd"` enum values
are supported by the contract for future KPIs but are not currently emitted.

## §6.4 — Numerator / denominator / scope parity (do they match Leadership?)

Documented inline in `definitions[]` (`numerator`, `denominator`, `scope`,
`rounding`). Summary:

- **QM-KPI-002** — num: audits in completed statuses (+ completed standalone
  AI-audit runs); den: all audits in the register (+ same AI runs). Reconciles
  against `details.completed_audits / details.total_audits`.
- **QM-KPI-008** — value is the **mean of per-BU completion %** from
  `bu_coverage_tracker` when populated (partial credit), falling back to
  `COUNT(DISTINCT BUs with ≥1 published policy) ÷ 13` only when the tracker is
  empty. Den: the 13 canonical BUs.
- **GRC-KPI-008** — num: applicable obligations with a linked control or policy;
  den: obligations WHERE status='applicable'. Reconciles against
  `details.mapped_obligations / details.total_applicable`.
- **QM-KPI-015** — num: policies published AND within review date; den: all
  policies. Reconciles against `details.compliant_policies / details.total_policies`.

Rounding for all four: `round(numerator ÷ denominator × 100)` to 1 decimal,
round-half-up — reconcilable against the raw `details` counts.

### ⚠️ Two parity discrepancies to confirm with the Leadership side (math NOT changed)

These are reported, not silently "fixed", because changing the underlying math is
a major change requiring sign-off (per user prefs in `HostingPlatform.md`):

1. **QM-KPI-002 scope** — the implementation currently counts the **full audit
   register**, not strictly the current-quarter plan, even though it is reported
   as `period_type: "quarter"` (QTD intent). If Leadership defines the
   denominator strictly as the current quarterly plan, the count must be scoped
   to the quarter before strict QTD parity holds.
2. **QM-KPI-008 method** — when the BU coverage tracker has data, the value is a
   **mean of per-BU completion percentages**, not a simple `covered ÷ total`
   count. It will therefore not reconcile against a plain count; reconcile
   against the tracker instead.

Both are flagged in the KPI `scope` text so the connector/Leadership owner can
align definitions. No calculation was altered as part of this change.
