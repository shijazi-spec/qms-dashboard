# Certification Action Plan — Design Spec

**Date:** 2026-09-03
**Supersedes the view built by:** `2026-09-03-certification-roadmap-design.md` (the chain diagram)
**Builds on:** `2026-09-02-certification-milestone-plan-design.md` (data + KPI — shipped, unchanged)
**Source document:** `GRQ-PLAN-2026-01_Certification_Milestone_Plan_3.0_24.08.2026.docx`
**Approved mockup:** https://claude.ai/code/artifact/d92e5961-0b45-4249-b61a-21e35e4765e2

---

## 1. Problem

Two releases stored Maram's plan and drew it. Neither made it **workable**. Sarah's words:

> *"I need to add the milestone of plan as an action plan to be checked and followed… use the files that inside the platform, all documents, I mean to check if the logic is working or what."*

Three faults:

1. **Granularity.** A milestone is not one item. September alone is five discrete deliverables. Seven nodes cannot be "checked and followed"; twenty actions can.
2. **No proof.** A checkbox anyone can tick is not evidence. The platform already holds the document register, approvals, audits, management reviews, risks and training records — the plan should *read them* and prove itself.
3. **Nothing can be ticked anyway.** `certification_milestones.delivered_date` has **no write path**: `insertSource()` is INSERT-only, and the 16 seeded rows are protected by a partial unique index, so a POST either errors or creates a duplicate ghost row that `calcCertMilestoneDelivery()` scores but `GET /api/certification-milestones` hides. KPI and page can silently disagree.

## 2. Decisions

| # | Decision | Chosen |
|---|---|---|
| 1 | Granularity | **20 actions** across the 7 milestones, plus 2 Technology dependencies |
| 2 | Proof | Each action declares an **evidence source**; the platform verifies what it can |
| 3 | Verification classes | `auto` · `auto (awaiting data)` · `manual` — always shown, never hidden |
| 4 | Milestone completion | **Derived** from its actions, not written by hand |
| 5 | `delivered_date` | Stamped by the recompute when a milestone's actions are all satisfied |
| 6 | Manual ticks | Recorded with **who and when**, plus an optional evidence document |
| 7 | Layout | The approved mockup: framework cards full-width on top, then the action list |
| 8 | PDPL | **Fixed in this release** (see §6) |

## 3. The evidence model

Three classes, and the page states which applies to every action. This is the core of the design: an action that cannot be proved says so, rather than resting on a tick.

- **`auto`** — the platform can prove it today from populated data. Computed live at read time, never stored, so it cannot drift.
- **`auto (awaiting data)`** — the query and table exist, but the table is empty today. Reads **0 honestly** and turns green the moment the owning module is used. This is a truthful "not yet", not a defect.
- **`manual`** — genuinely outside the platform (an external body attending, another department answering). Ticked by a named person, stamped with who and when, with an optional link to an uploaded evidence document.

### 3.1 Full action mapping

**Milestone 1 — By 30 Aug 2026 · Document Library · GRC**

| # | Action | Class | Evidence source |
|---|---|---|---|
| 1.1 | Remaining document batches released | `auto` | `policies` JOIN `policy_files` — documents with retrievable bytes ÷ register total. Never use `file_name IS NOT NULL` (metadata outlives the bytes, `policyDatabase.ts:472`) |
| 1.2 | Identified gaps closed | `auto` | `qms_uploaded_documents WHERE extraction_status='placeholder'` = 0 |

**Milestone 2 — September 2026 · Document Library / SACS-002 · GRC, Alhanouf**

| # | Action | Class | Evidence source |
|---|---|---|---|
| 2.1 | Library approved | `auto` | `policies WHERE compliance_approved IS TRUE` ÷ total |
| 2.2 | …and signed | `manual` | **No signature capability exists in the platform** (§8). Manual tick + evidence document |
| 2.3 | Document codes updated | `auto (awaiting data)` | `doc_tracker_documents.code_ok`; check `doc_tracker_collectors.health_state` first — stale collector ⇒ report "not collected", not 0 |
| 2.4 | SACS-002 recertification progressed | `manual` | External certification body |
| 2.5 | Surveillance audit date confirmed with Bureau Veritas | `auto` | `external_audits WHERE kind='surveillance' AND certification_body ILIKE '%bureau veritas%' AND planned_date IS NOT NULL` |
| 2.6 | HyperPay attestation + responsibility matrix obtained | `manual` | Third-party document; evidence link |

**Milestone 3 — October 2026 · PCI DSS · GRC, HR, Technology**

| # | Action | Class | Evidence source |
|---|---|---|---|
| 3.1 | SAQ A completed and signed | `manual` | Evidence document |
| 3.2 | SAQ A submitted to both acquirers | `manual` | Evidence document |
| 3.3 | Awareness training delivered and recorded | `auto (awaiting data)` | `training_records` (`qmsDatabase.ts`) — empty today |
| 3.4 | Evidence pack assembled | `auto (awaiting data)` | `evidence_records` (`evidenceDatabase.ts`) — empty today |

**Milestone 4 — November 2026 · ISO 27001 / PDPL · GRQ**

| # | Action | Class | Evidence source |
|---|---|---|---|
| 4.1 | Internal audit run against ISO 27001 and PDPL | `auto (awaiting data)` | `audit_runs` (`auditProgrammeDatabase.ts`) — empty today |
| 4.2 | Findings raised and corrective actions opened | `auto (awaiting data)` | `nonconformance_records` + `capa_records` (`qmsDatabase.ts`) |

**Milestone 5 — December 2026 · PDPL · Head of GRQ**

| # | Action | Class | Evidence source |
|---|---|---|---|
| 5.1 | Management review held and minuted | `auto (awaiting data)` | `management_reviews` (`managementReviewDatabase.ts:88`) |
| 5.2 | Risk assessment refreshed | `auto` | `enterprise_risks.last_review_date` within the quarter, or a `risk_assessment_history` row |
| 5.3 | Treatment plan approved | `auto` | `enterprise_risks WHERE treatment_strategy IS NOT NULL` ÷ open risks |

**Milestone 6 — January 2027 · ISO 27001 · Technology, GRC**

| # | Action | Class | Evidence source |
|---|---|---|---|
| 6.1 | Penetration test report filed | `auto (awaiting data)` | `evidence_records` of the pen-test type |
| 6.2 | Readiness check against clauses 9.2 and 9.3 | `auto` | `obligation_documents` coverage of the ISO-27001 obligations whose `obligation_code` matches 9.2 / 9.3 |

**Milestone 7 — February 2027 · ISO 27001 · Bureau Veritas**

| # | Action | Class | Evidence source |
|---|---|---|---|
| 7.1 | Surveillance audit conducted by Bureau Veritas | `auto` | `external_audits` row for that audit marked complete |
| 7.2 | Certification maintained | `auto` | `external_audit_certificates` with an unexpired `expiry_date` for ISO 27001 |

**Dependencies — Technology (both `manual`; they are answers owed by another department)**

| # | Action | Due |
|---|---|---|
| D.1 | Confirm the HyperPay redirect is complete without exception, and what identifier the transaction export returns | Sep 2026 |
| D.2 | Supply pen-test report, access reviews, log samples, configuration baselines, backup/restore results, vulnerability scan output, and name a responsible person | Oct 2026 |

### 3.2 Coverage queries must use confirmed evidence only

Wherever an action reads clause coverage, it uses the **confirmed-links** form — excluding `awaiting_review = TRUE` rows (unreviewed gpt-4o-mini guesses above a 70 confidence bar) and requiring `extraction_status='extracted'`. `getFrameworkCoverage()` counts unconfirmed links and is therefore **not** suitable for a certification claim.

## 4. Data model

### 4.1 New table `certification_actions`

| Column | Type | Purpose |
|---|---|---|
| `id` | `SERIAL PK` | |
| `action_key` | `VARCHAR(100)` UNIQUE | Idempotency key, e.g. `ACT-2026-09-APPROVED` |
| `milestone_key` | `VARCHAR(100)` | The owning milestone in `certification_milestones` |
| `sort_order` | `INTEGER` | Order within the milestone |
| `action_text` | `TEXT` | Verbatim from the plan |
| `owner` | `VARCHAR(255)` | GRC · Alhanouf · HR · Technology · Head of GRQ · Bureau Veritas |
| `verification_mode` | `VARCHAR(20)` | `auto` \| `manual` |
| `evidence_source` | `VARCHAR(60)` | Identifier the resolver switches on, e.g. `policies.approved` |
| `done_at` / `done_by` | `TIMESTAMP` / `VARCHAR(255)` | **Manual ticks only** — auto actions are never stored |
| `evidence_policy_id` | `INTEGER` | Optional link to a `policies` row |
| `note` | `TEXT` | |
| `plan_version` / `source_doc` | `VARCHAR` | Provenance, as on `certification_milestones` |

Schema parity is STRICT — every column in the canonical `CREATE TABLE` **and** as `ALTER … ADD COLUMN IF NOT EXISTS`. Seeded idempotently with `ON CONFLICT (action_key) DO NOTHING`, plus a relationship backfill that only fills NULLs, following the pattern already proven on `certification_milestones`.

### 4.2 Evidence resolver — pure, then thin

`src/utils/certificationEvidence.ts` exposes one **pure** function per evidence source shape plus a dispatcher, so the arithmetic is unit-testable without a database. The route runs the queries; the pure layer decides satisfied / not / awaiting-data. No `new Date()` on stored values; all dates compared lexicographically as `'YYYY-MM-DD'` (this codebase has been bitten twice).

An auto action resolves to one of: `satisfied` · `not_satisfied` · `awaiting_data` (the source table is empty) · `unavailable` (the source cannot be read, e.g. a stale collector). **`awaiting_data` and `unavailable` are shown distinctly and never rendered as 0%.**

### 4.3 Milestone completion is derived, not written

A milestone is complete when every one of its actions is satisfied. The recompute stamps `certification_milestones.delivered_date` accordingly. This gives the missing write path **without** an endpoint that lets anyone set a delivery date by hand, and `GRC-KPI-002` keeps working off `delivered_date` exactly as it does today — unchanged.

### 4.4 Write path and audit trail

`POST /api/certification-actions/:action_key/toggle` — RBAC-gated to the same five roles as the page, refuses to toggle an `auto` action (those are computed, never asserted), writes `done_at`/`done_by`, and records an `event_logs` entry. Registered in `ROUTE_PERMISSION_MAP` in `src/utils/rbacMiddleware.ts` — the middleware **denies by default** and the admin bypass only applies inside a matched rule, so a missing entry means a blanket 403 while every unit test still passes.

## 5. The view

Exactly the approved mockup:

1. **Framework cards, full width, above everything** — name bold, target date, real standing from the plan's §2 (so ISO 27001 reads *"Certified since Feb 2026"*, not a bare 0%), progress in actions. NCA-ECC, NCA-DCC and SOC 2 keep their amber "no action delivers this / no date set" cards.
2. **The standing risk banner** — *"GRC produces documents. It does not produce evidence…"*
3. **The action plan** — one collapsible group per milestone: date, framework as a small label, the deliverable in bold, a state pill and `n / m` progress; inside, one row per action with its checkbox, owner, and an evidence chip stating how it is verified.

Auto actions render a read-only indicator with a link to the evidence, not a checkbox — a tickable box implies an assertion the platform is already making for you.

**Removed:** the horizontal chain diagram, and every `ms_lbl_*` / `ms_planned` slug.

## 6. PDPL fix — 7 clauses that could never be seeded

`runFrameworkSeed()` (`src/utils/seeds/obligationSeedTypes.ts:87-93`) guards:

```ts
SELECT COUNT(*) FROM obligations WHERE regulation_id = $1
if (existing >= defs.length) return;
```

`initComplianceTables()` calls `seedPDPLObligations()` (18 rows, `complianceDatabase.ts:350`) and *then* `seedPdplFillObligations()` (7 rows, `:365`). By then `18 >= 7` → **early return, always**. `PDPL-19`…`PDPL-25` (breach notification, DPIA triggers, cookies, direct marketing, DPO thresholds) have never existed, so every PDPL coverage figure is computed against a denominator missing exactly those articles.

**Fix — correct the guard, not the call order.** Count only the codes being seeded:

```sql
SELECT COUNT(*) FROM obligations
 WHERE regulation_id = $1 AND obligation_code = ANY($2)
```

compared against `defs.length`. First run: 0 < n, proceeds. Re-run: n = n, skips. Fill seed: counts only the fill codes. This repairs **every** fill/extension seed, not just PDPL — the existing comment ("counting by regulation_id is reliable across any obligation_code naming scheme") is precisely the wrong assumption.

Expected effect: PDPL goes 18 → 25 clauses, and its coverage percentage **drops**, because the denominator was wrong before. That is a correction, not a regression, and the deploy note must say so.

## 7. GRC section consistency

The page keeps its route `/compliance` and its nav item **Certification Milestone**. Consistency work, scoped to what this release touches:

- The page title, nav label and print header all read **Certification Milestone Plan** — no third name.
- The page subtitle still reads "PDPL, NCA/ECC, ISO standards tracking and obligation management" while the h1 says Certification Milestones. Align it.
- Evidence chips link to the owning GRC module (Risk Mgmt, Mgmt Review, External Audits, Document Mapping) so the plan is a way *into* the section, not a parallel island.
- Reuse the page's existing helpers — `escAttr` for escaping, `_ct(key, fallback)` for i18n with **literal** key strings (a lookup like `_ct(MAP[x])` is invisible to `check-i18n.cjs` and fails the build).

## 8. Known limits, stated not hidden

- **No signature capability exists** anywhere in the platform — no column, no table. "Approved **and signed**" can only be half-proved; 2.2 stays manual until a signature feature exists.
- **All 154 documents are currently `draft` and none are approved**, so 1.1, 1.2 and 2.1 will read near-zero at launch. Accurate, and worth telling Maram before she opens the page.
- **SACS-002 has no clause catalogue**, so nothing about it can auto-verify from coverage.
- **The approval columns** (`compliance_approved*`) exist only as runtime `ALTER TABLE` and are absent from the canonical `CREATE TABLE policies` — exactly the drift Replit's publish diff turns into a `DROP`. Out of scope here; **raise separately**, because it is the platform's only machine-readable approval record.

## 9. Verification

- Pure unit tests for every evidence resolver, including the `awaiting_data` and `unavailable` paths
- A test proving PDPL seeds 25 clauses and that re-running is a no-op
- A test proving an `auto` action cannot be toggled through the API
- `npm run check` (after `node scripts/patch-mastra-provider-types.mjs`), `npm test`, `check-schema-parity --strict`, `check-i18n`, `check-dashboard-html-js`, `check-no-inline-handlers`, `check-no-inline-styles`
- Visual: no slug renders anywhere; auto actions show evidence, not checkboxes; empty-source actions read "awaiting data", never 0

## 10. Out of scope

- Building a signature capability
- Sourcing the SACS-002 control catalogue
- Populating `compliance_assessments` (why the page still shows 0% / 668 Not Assessed)
- Moving the approval columns into the canonical schema (raise separately — real risk)
- The two leadership defects due before 2027-01-01 (count-vs-percentage prose; `componentFraction` folding a count as `count/100`)
