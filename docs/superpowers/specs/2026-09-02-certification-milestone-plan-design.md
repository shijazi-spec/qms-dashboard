# Certification Milestone Plan — Design Spec

**Date:** 2026-09-02
**Source document:** `GRQ-PLAN-2026-01_Certification_Milestone_Plan_3.0_24.08.2026.docx` (v3.0, 24 Aug 2026, Restricted L2)
**Prepared by (doc):** Maram Alharbi / GRC Manager · **For:** Ahmed Amashah / Head of GRQ

---

## 1. Problem

`GRC-KPI-002 "Certification Milestones On Track"` displays **~19.9%**, but that number comes from
`calcCertificationMilestones` (`src/utils/kpiProcessCalc.ts:1203`), which measures **document-mapping
clause coverage** — a proxy explicitly labelled as such in the code. It has nothing to do with
milestone dates.

The correct machinery already exists and is unused:

- `certification_milestones` table — `src/utils/northStarSources.ts:31`
- correct calculator `calcCertMilestoneDelivery` — `src/utils/northStarSources.ts:256`
- a data-entry form at `/leadership-kpis/data` (`dashboard/northstar-data.html:63`)

`dashboard/js/navigation.js:239` records why it is empty: the form *"was previously orphaned (no nav
link), which is why the certification calendar for GRC-KPI-002 was never entered and that KPI stayed
empty."*

**The Certification Milestone Plan is the missing data.**

Secondary problems this fixes:

- Four conflicting definitions of one KPI code (`finalGrqKpiSeed.ts:72` target 100 / "Per Certificate";
  `kpiDatabase.ts:1236` target 90 / quarterly; `leadershipKpiFeed.ts:835` count / target 2;
  `okrDatabase.ts:101` "100% on-time").
- Leadership push disabled (`src/utils/leadershipPush.ts:38`) because QMS emitted a **percentage**
  into leadership's **count** field, producing `995%`.
- `SACS-002` is tracked in the plan but **does not exist anywhere in the platform** (0 grep hits).

## 2. Decisions

| # | Decision | Chosen |
|---|---|---|
| 1 | What the KPI measures | **Milestone on-time delivery** (not clause coverage) |
| 2 | Milestone scope | All three doc sections stored, **typed**; only `plan` rows score the KPI |
| 3 | Framework reconciliation | Register **SACS-002**; link milestones to `regulations` by FK; NCA → **ECC + DCC** |
| 4 | Data loading | **Versioned, idempotent seed file**, UI-editable afterwards |
| 5 | Page layout | **Milestone-first** at `/compliance`, existing obligations content below |
| 6 | Leadership push | **Re-enable as a count** |
| 7 | KPI history | **Annotate a baseline break** — never wipe historical values |
| 8 | SOC 2 | **Include** as a `framework_target` row, with no date (see §5) |

## 3. Data model

### 3.1 `certification_milestones` — five additive columns

All nullable or defaulted; no rewrite of existing rows.

| Column | Type | Purpose |
|---|---|---|
| `milestone_type` | `VARCHAR(20) DEFAULT 'plan'` | `plan` \| `framework_target` \| `dependency` |
| `regulation_id` | `INTEGER REFERENCES regulations(id)` | Ties a milestone to a real framework |
| `milestone_key` | `VARCHAR(100)` + UNIQUE index | Stable idempotency key for the seed |
| `plan_version` | `VARCHAR(20)` | `"3.0"` |
| `source_doc` | `VARCHAR(50)` | `"GRQ-PLAN-2026-01"` |

**Schema parity is STRICT in this repo** (`npm run check:schema-parity --strict`). Every column must
appear in BOTH the canonical `CREATE TABLE` and as `ALTER TABLE … ADD COLUMN IF NOT EXISTS`.

### 3.2 New framework record

Insert `SACS-002` into `regulations` (record only, **zero obligations** for now):
`regulation_code='SACS-002'`, name "SACS-002 Saudi Aramco Cybersecurity Standard",
`jurisdiction='saudi'`, `category='cybersecurity'`, `issuing_body='Saudi Aramco'`, `status='active'`.

**Verified safe with zero obligations:**

- `calculateCoveragePct` guards `if (total <= 0) return 0` (`obligationDocumentsDatabase.ts:279`).
- `getFrameworkCoverage` / `getAllFrameworkCoverage` both use `total > 0 ? … : 0` (lines 48, 89).
- Contributes 0 to numerator *and* denominator — cannot dilute or crash coverage.
- `removeRetiredFrameworks` only deletes `RETIRED_REGULATION_CODES = ["COPC"]` — SACS-002 is not
  auto-purged.

**Known limitation:** `getMappableFrameworks` requires ≥1 obligation, so SACS-002 will **not** appear
in Document Mapping, and its Compliance card will read 0 clauses, until its control catalogue is
sourced. This is honest and visible, not a defect.

## 4. Seed — 16 rows

`src/utils/seeds/certificationMilestonePlan.ts`, idempotent via
`ON CONFLICT (milestone_key) DO NOTHING` so redeploys never clobber operator edits — the same pattern
the 8 framework seeds already use.

**Date convention:** the plan uses month-only labels ("September 2026"); these become **end-of-month**
planned dates. The one explicit date in the document ("By 30 Aug 2026") is honoured as `2026-08-30`.

### 4.1 `plan` × 7 — §4 "The plan" (these and only these score the KPI)

| `milestone_key` | `planned_date` | Milestone | Owner |
|---|---|---|---|
| `PLAN-2026-08-DOCS` | 2026-08-30 | All documents complete; remaining batches released, gaps closed | GRC |
| `PLAN-2026-09-APPROVE` | 2026-09-30 | Library approved and signed; document codes updated; SACS-002 recertification progressed; surveillance audit date confirmed with Bureau Veritas; HyperPay attestation and responsibility matrix obtained | GRC, Alhanouf |
| `PLAN-2026-10-SAQA` | 2026-10-31 | SAQ A completed, signed and submitted to both acquirers; awareness training delivered and recorded; Technology assembles evidence pack | GRC, HR, Technology |
| `PLAN-2026-11-AUDIT` | 2026-11-30 | First internal audit against ISO 27001 and PDPL; findings raised and corrective actions opened | GRQ |
| `PLAN-2026-12-MGMTREV` | 2026-12-31 | Management review held and minuted; risk assessment refreshed and treatment plan approved | Head of GRQ |
| `PLAN-2027-01-PENTEST` | 2027-01-31 | Penetration test report filed; readiness check against clauses 9.2 and 9.3 | Technology, GRC |
| `PLAN-2027-02-SURV` | 2027-02-28 | Surveillance audit by Bureau Veritas; certification maintained | Bureau Veritas |

### 4.2 `framework_target` × 7 — §2 "When we can say we are compliant"

| `milestone_key` | Framework | `planned_date` | Status now | What makes it true |
|---|---|---|---|---|
| `FT-SACS002` | SACS-002 | 2026-09-30 | Certificate lapsed 5 Feb 2026 | Recertification completed |
| `FT-PCIDSS` | PCI-DSS | 2026-10-31 | In scope as a merchant. Never validated. | SAQ A completed and signed, HyperPay attestation held, submitted to both acquirers |
| `FT-PDPL` | PDPL | 2026-12-31 | Documents nearly complete | Library closed, staff trained, internal audit done, findings closed |
| `FT-ISO27001` | ISO-27001 | 2027-02-28 | Certified since Feb 2026 | Surveillance audit passed |
| `FT-NCA-ECC` | NCA-ECC | 2027-04-30 | Mapped, applicability unconfirmed | Applicable controls written into the documents and self-assessed |
| `FT-NCA-DCC` | NCA-DCC | 2027-04-30 | Mapped, applicability unconfirmed | Applicable controls written into the documents and self-assessed |
| `FT-SOC2` | SOC2 | **NULL** | Named in plan intro; no target date in v3.0 | *To be set in v4.0* |

### 4.3 `dependency` × 2 — §5 "What we need from other departments"

| `milestone_key` | `planned_date` | Need | Owner |
|---|---|---|---|
| `DEP-TECH-ANSWERS` | 2026-09-30 | Is the redirect to HyperPay complete without exception, and what identifier does the transaction export actually return? These two answers set the PCI position. | Technology |
| `DEP-TECH-EVIDENCE` | 2026-10-31 | Penetration test report, access reviews, log samples, configuration baselines, backup and restore test results, vulnerability scan output. A named person responsible for supplying it. | Technology |

## 5. KPI rewiring

### 5.1 New calculation

```
value = COUNT(delivered_date <= planned_date)  ÷  COUNT(due this quarter)  × 100
        WHERE milestone_type = 'plan' AND status <> 'cancelled' AND planned_date IS NOT NULL
```

Reuses `calcCertMilestoneDelivery` (`northStarSources.ts:256`), **adding a `milestone_type='plan'`
filter** so framework targets and dependencies never enter the denominator. `planned_date IS NOT NULL`
is already in that query, so the dateless SOC 2 row is inert by construction.

`PROCESS_CALCULATORS["GRC-KPI-002"]` (`kpiProcessCalc.ts:1463`) is repointed to it.
`calcCertificationMilestones` (coverage) is **kept but unregistered** — verified to have exactly one
consumer, so nothing else loses data. It remains available for a future coverage KPI.

### 5.2 One definition

Reconcile all four to: **unit `%` · target 100 · quarterly · higher_is_better · owner Maram AlHarbi ·
north_star true**. Note `finalGrqKpiSeed.ts` currently says frequency `"Per Certificate"` while the
calculator scores **per quarter** — quarterly wins. Seed updates respect the existing
`is_customized IS NOT TRUE` guard (`finalGrqKpiSeed.ts:131`).

Leadership keeps its **count** unit from the same source via `calcCertMilestoneCount`.

### 5.3 Baseline break (new mechanism)

No series-break facility exists — `_KPI_BASELINES` (`dashboard/kpis.html:532`) is a *baseline→target
pace* map, not a methodology annotation. So add two nullable columns to `kpi_definitions`:

| Column | Purpose |
|---|---|
| `methodology_changed_at DATE` | 2026-09-02 for GRC-KPI-002 |
| `methodology_note TEXT` | "Before this date the value measured document-mapping clause coverage; from this date it measures on-time delivery of Certification Milestone Plan v3.0 milestones. Values either side are not comparable." |

Historical `kpi_values` rows are **left untouched**. The trend renderer draws a divider at that date
and surfaces the note, so no one reads a 19.9%→X% move as progress or regression. Reusable for any
future methodology change.

### 5.4 Leadership push

Restore the `GRC-KPI-002` entry in `leadershipPush.ts` with the prod UUID `2f11d78d…` referenced in
the existing comment, emitting the **count** of on-time milestones for the quarter.

**Pre-flight:** confirm that UUID is still valid before enabling; the comment is historical. If it
cannot be confirmed, ship the count emitter and leave the push entry commented with a TODO — the
`995%` incident came from exactly this kind of unverified assumption.

## 6. UI

### 6.1 Sidebar rename → "Certification Milestone"

Two values plus one fallback. `id`, `href`, the i18n **key**, the `/compliance` route and every
back-link stay untouched — active state keys off `item.id`, not the label.

| File | Change |
|---|---|
| `dashboard/i18n/en.json` (`nav.items.compliance`) | `"Compliance"` → `"Certification Milestone"` |
| `dashboard/i18n/ar.json` (same key) | `"الامتثال"` → `"معالم الشهادات"` |
| `dashboard/js/navigation.js:189` | `label:` fallback, for i18n-load failure |

**Nav search alias.** `navigation.js:1554` matches on `data-label` only, so typing "compliance" would
stop finding the row. Add an alias so both "compliance" and "certification"/"milestone" match.

**Known cosmetic side effect:** `import-review.html:47` calls `WalaPlusNav.init('compliance')`, so
`/import-review` will highlight a row now reading "Certification Milestone". Pre-existing behaviour;
accepted.

### 6.2 `/compliance` page — milestone-first

```
Certification Milestones                    ← page h1
├─ Milestone timeline          plan × 7      → drives the KPI
├─ Compliant-from by framework framework × 7
└─ Dependencies / blockers     dependency × 2
──────────────────────────────────────────────
Framework Compliance & Obligations           ← existing content, unchanged
├─ score cards · 8(+1) frameworks · 668 obligations
└─ Open Document Mapping →
```

All new strings go through i18n in **both** en.json and ar.json — `scripts/check-i18n.cjs` enforces
identical key trees across locales.

## 7. Consistency findings in the source document

Surfaced for v4.0; the platform will render what is true rather than restate these.

1. The intro says **"seven frameworks"** but names six (PDPL, ISO 27001, NCA, PCI DSS, SOC 2,
   SACS-002); §2's table lists five.
2. **SOC 2** is named in the intro but absent from §2 — hence the dateless row in §4.2.
3. **NCA** is one line in the document but two frameworks in the platform (ECC and DCC), so it
   becomes two rows.
4. The platform tracks **SAMA-CSF** and **ISO-9001**, which the plan does not mention at all. Out of
   scope here; worth a decision in v4.0.

## 8. Verification

- `npm run check` — tsc, 0 errors
- `npm run check:schema-parity` — must pass (new columns in CREATE + ALTER)
- `npm run check:i18n` — en/ar key-tree parity
- `node scripts/check-dashboard-html-js.mjs` — dashboard script blocks parse
- Functional: seed runs idempotently twice with no duplicate rows; `GRC-KPI-002` returns a milestone
  percentage for Q3 2026 (2 `plan` rows due: 30 Aug, 30 Sep); SACS-002 card renders 0 clauses without
  error; nav reads "Certification Milestone" in EN and AR; `/compliance` still resolves.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Leadership UUID `2f11d78d…` stale → repeat of the `995%` incident | Verify before enabling; otherwise ship emitter with push commented |
| SACS-002 renders as an empty 0-clause card | Accepted and documented; sourcing its controls is separate work |
| KPI value drops from 19.9% to a milestone % and looks like regression | Baseline-break annotation (§5.3) |
| Month-only dates make "late" ambiguous | End-of-month convention, stated in §4 |
| Seed overwrites operator edits | `ON CONFLICT (milestone_key) DO NOTHING` + `is_customized` guard on KPI seed |

## 10. Out of scope

- Sourcing and seeding the SACS-002 control catalogue.
- Parsing the .docx automatically (v4.0 ships as a seed update).
- Populating `compliance_assessments` — the Compliance page reads 0% / 668 Not Assessed because that
  table is empty. Real, but a separate problem.
- Deciding SAMA-CSF / ISO-9001 milestone coverage.
