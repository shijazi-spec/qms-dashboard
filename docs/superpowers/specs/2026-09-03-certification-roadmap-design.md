# Certification Roadmap — Design Spec

**Date:** 2026-09-03
**Follows:** `2026-09-02-certification-milestone-plan-design.md` (shipped — data + KPI)
**Source document:** `GRQ-PLAN-2026-01_Certification_Milestone_Plan_3.0_24.08.2026.docx`
**Audience for the output:** Ahmed Amashah / Head of GRQ

---

## 1. Problem

The previous piece embedded the Certification Milestone Plan as **16 rows** and rewired
`GRC-KPI-002` to score them. That part works and is verified. But it rendered the plan as **three
disconnected lists** — timeline, compliant-from, dependencies — which severed every relationship the
source document actually asserts:

| The document connects | What shipped |
|---|---|
| §4's ordering: *"documents approved → staff trained → audit → management review"* | A flat list sorted by date |
| §2's *"What makes it true"* → the §4 milestones that deliver it | A separate box, no link |
| §5's Technology dependencies → the Oct-onward milestones they gate | A third box, no link |
| *"GRC produces documents. It does not produce evidence… the largest risk to the dates"* | Text in a `notes` column that is never rendered |

The document states the chain is load-bearing:

> *"The order matters. Documents must be approved before staff can be trained on them, staff must be
> trained before an audit is worth running, and the audit must happen before the management review.
> That chain cannot be shortened, which is why the training has to land in October."*

**Consequence:** there is nothing to present. A Head of GRQ cannot be walked through three plain
boxes and shown that the plan lives in the platform. The gap is in the prior spec, which designed
storage and a KPI but never designed *the plan as an artefact you present*.

## 2. Goal

One **Certification Roadmap** that (a) draws the chain, (b) shows where we are, (c) attaches blockers
to what they block, (d) shows what each milestone unlocks, and (e) prints to a hand-over PDF from the
same live data.

## 3. Decisions

| # | Decision | Chosen |
|---|---|---|
| 1 | Form | **Both** — in-app roadmap view AND a print/PDF export from the same data |
| 2 | Location | Replaces the three boxes as the headline of `/compliance` (the "Certification Milestone" page). Same URL, no new nav item |
| 3 | Leading element | The **timeline/chain**, with framework readiness beside it |
| 4 | Export mechanism | Print-optimised layout via `@media print` + a Print/PDF button — no server-side PDF engine |
| 5 | Unreachable frameworks | **Surfaced as amber gaps**, not hidden |

## 4. Data model

Three additive nullable columns on `certification_milestones`. Schema parity is STRICT: each must
appear in the canonical `CREATE TABLE` *and* as `ALTER TABLE … ADD COLUMN IF NOT EXISTS`.

| Column | Type | Carries |
|---|---|---|
| `depends_on_key` | `VARCHAR(100)` | The chain — this milestone's predecessor `milestone_key` |
| `unlocks_codes` | `TEXT[]` | §2's "what makes it true" — regulation codes this milestone delivers |
| `gates_keys` | `TEXT[]` | §5 — for a `dependency` row, the `milestone_key`s it blocks |

### 4.1 The chain (`depends_on_key`)

| Milestone | Depends on |
|---|---|
| `PLAN-2026-08-DOCS` | *(none — chain head)* |
| `PLAN-2026-09-APPROVE` | `PLAN-2026-08-DOCS` |
| `PLAN-2026-10-SAQA` | `PLAN-2026-09-APPROVE` |
| `PLAN-2026-11-AUDIT` | `PLAN-2026-10-SAQA` |
| `PLAN-2026-12-MGMTREV` | `PLAN-2026-11-AUDIT` |
| `PLAN-2027-01-PENTEST` | `PLAN-2026-12-MGMTREV` |
| `PLAN-2027-02-SURV` | `PLAN-2027-01-PENTEST` |

### 4.2 What each milestone unlocks (`unlocks_codes`)

Derived strictly from §2's "What makes it true" column — no invention.

| Milestone | Unlocks | Because §2 says |
|---|---|---|
| `PLAN-2026-09-APPROVE` | `SACS-002` | "Recertification completed" |
| `PLAN-2026-10-SAQA` | `PCI-DSS` | "SAQ A completed and signed, HyperPay attestation held, submitted to both acquirers" |
| `PLAN-2026-11-AUDIT` | `PDPL` | "internal audit done" |
| `PLAN-2026-12-MGMTREV` | `PDPL` | "findings closed" → PDPL defensible |
| `PLAN-2027-02-SURV` | `ISO-27001` | "Surveillance audit passed" |

`PLAN-2026-08-DOCS` and `PLAN-2027-01-PENTEST` unlock nothing directly (they are enablers). Empty array.

### 4.3 Blockers (`gates_keys`, on `dependency` rows)

| Dependency | Gates | Because |
|---|---|---|
| `DEP-TECH-ANSWERS` | `PLAN-2026-10-SAQA` | "These two answers set our PCI position" |
| `DEP-TECH-EVIDENCE` | `PLAN-2026-11-AUDIT` | The audit needs the evidence pack |

The document's systemic warning — *"From October onward every remaining milestone depends on
material that other departments hold, and that is the largest risk to the dates in this plan"* —
renders as a standing risk banner on the October gate, not as a per-row link.

## 5. Derived state (computed, never stored)

| State | Rule |
|---|---|
| `delivered_on_time` | `delivered_date` set and `<= planned_date` |
| `delivered_late` | `delivered_date` set and `> planned_date` |
| `overdue` | no `delivered_date` and `planned_date < today` |
| `active` | the earliest non-delivered milestone by `planned_date` |
| `blocked` | some `dependency` row lists this milestone in `gates_keys` and that dependency is not delivered |
| `planned` | everything else |

**Framework readiness** = for each `framework_target` row, the set of `plan` milestones whose
`unlocks_codes` contains its regulation code; progress = delivered ÷ total of that set.

**Unreachable framework** (amber gap) = a `framework_target` whose code appears in **no** plan row's
`unlocks_codes`. On today's data that is exactly **NCA-ECC** and **NCA-DCC** (dated Apr 2027, no
milestone delivers them). **SOC 2** is a second, distinct gap: no `planned_date` at all in v3.0.
Both are surfaced deliberately — they are v4.0 input, and hiding them would repeat the original
mistake of storing the document without representing what it actually says.

## 6. The view

Headline of `/compliance`, replacing the three plain boxes:

```
CERTIFICATION MILESTONE PLAN        GRQ-PLAN-2026-01 v3.0 · Maram Alharbi
                                    ▼ today            [ Print / PDF ]

 Aug 30 ──▶ Sep 30 ──▶ Oct 31 ──▶ Nov 30 ──▶ Dec 31 ──▶ Jan 31 ──▶ Feb 28
  docs      approve     TRAIN      audit      mgmt      pentest    surveil
 ●OVERDUE   ◉ACTIVE       ○          ○          ○          ○          ○
            ▲                 ▲
            └ blocked: Tech answers    └ blocked: Tech evidence pack

 ── this chain cannot be shortened ─────────────────────────────────
    docs approved → staff trained → audit worth running → mgmt review

 UNLOCKS                      FRAMEWORK READINESS
 Sep → SACS-002               SACS-002  Sep 2026  ▓▓▓▓▓░░░░░
 Oct → PCI DSS                PCI DSS   Oct 2026  ▓▓▓░░░░░░░
 Nov → PDPL                   PDPL      Dec 2026  ▓▓░░░░░░░░
 Dec → PDPL (defensible)      ISO 27001 Feb 2027  ▓▓▓▓▓▓▓░░░
 Feb → ISO 27001              NCA-ECC   Apr 2027  ⚠ no milestone delivers this
                              NCA-DCC   Apr 2027  ⚠ no milestone delivers this
                              SOC 2     —         ⚠ no date set in v3.0
```

Each milestone node expands to show its owner, full description, what it unlocks, and any blocker.
The obligations tracker and frameworks grid remain below, unchanged.

## 7. Export

A **print-optimised layout** behind a Print/PDF button: `@media print` rules that hide the nav, the
filter bar, the obligations table and the page chrome, and lay the roadmap out for A4 landscape with
the document code, version, preparer and a generated-on date in a header. The user saves as PDF from
the browser dialog.

Chosen over a server-side PDF engine because it adds no dependency, cannot drift from the live data,
and needs no new route. The trade-off — pagination is the browser's, not ours — is acceptable for a
one-page roadmap.

## 8. Constraints

- **Schema parity is STRICT** — new columns in CREATE + ALTER.
- **i18n parity** — every new string in `en.json` AND `ar.json`, identical key trees.
- **No inline event handlers** — `data-on-click` only.
- **Escape all DB values** — use the page's existing `escAttr`; milestone text is operator-editable.
- The seeder stays idempotent; relationship columns are set by an `UPDATE`-on-null backfill so
  redeploys never clobber operator edits (same pattern as the SACS-002 FK backfill).
- Do not change: `GRC-KPI-002`'s calculation, the `milestone_type='plan'` filter, the 16 seed rows'
  existing fields, or the RBAC role list.

## 9. Verification

- `npx vitest run` — new pure-function tests for chain ordering, derived state, and readiness math
- `npm run check` (tsc) — after `node scripts/patch-mastra-provider-types.mjs`
- `check-schema-parity --strict`, `check-i18n`, `check-dashboard-html-js`, `check-no-inline-handlers`
- Visual: the roadmap renders the chain in order with today's marker between Aug and Sep; the two
  blockers attach to Oct and Nov; NCA ×2 and SOC 2 show amber gaps; Print preview shows the roadmap
  alone with the document header

## 10. Out of scope

- Editing the chain/relationships through the UI (they come from the approved document; v4.0 ships as
  a seed update)
- Server-side PDF generation
- Sourcing the SACS-002 control catalogue
- Populating `compliance_assessments`
- The two deferred leadership defects (count-vs-percentage prose; `componentFraction` folding a count
  as `count/100`) — tracked separately, due before 2027-01-01
