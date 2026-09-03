# ExampleOrg Enterprise GRC & Quality Platform
## Feature Book & Test Specifications — v1.1
*Last updated: 18 April 2026 (v4.5 platform release)*

---

| | |
|---|---|
| **Audience** | Product manager, QA lead, engineering, executive sponsor |
| **Purpose** | Single source of truth for what the platform does, how to test it, and what "working" means for each feature |
| **Status** | Living document — updated each sprint |
| **Owner** | Product & Engineering |

---

## How to read this document

Every feature follows the same structure:

1. **Purpose** — one-line business value
2. **Primary user(s)** — who uses this and why
3. **Key surfaces** — dashboard URL + main API endpoints
4. **Data sources** — which DB tables / external systems power it
5. **Job stories** — what the user is trying to achieve (Intercom format)
6. **Acceptance criteria** — Gherkin (Given/When/Then) — directly executable as test cases
7. **Test cases** — concrete scenarios the test runner exercises

Coverage tiers:
- **Tier 1 (workhorse)** — real data flowing, tested in depth
- **Tier 2 (capability)** — feature complete, low usage, smoke-tested
- **Tier 3 (admin/utility)** — supporting features, smoke-tested

---

# Module 1 — Authentication & Access Control · *Tier 1*

**Purpose**: Prove who is using the platform, control what they can see, and audit every privileged action.

**Primary users**: All users (login flow), Admin (role assignment), Compliance Officer (audit trail review).

**Key surfaces**
- `/login` — email/IdentityProvider/SourceControlProvider/IdentityProvider login via HostingPlatform OIDC
- `/users` — Users & Access Control dashboard
- `/admin` — Admin Panel (requires `ADMIN_API_KEY` or admin role)
- `/api/auth/me`, `/api/auth/logout`
- `/api/admin/auth`, `/api/admin/auth/verify`

**Data sources**: `platform_users`, `role_permissions`, `screen_permissions`, `access_audit_log`, `pdpl_audit_log`

**Job stories**
- *When* I'm a new user invited by my manager, *I want* to accept the invite and land on the right dashboard for my role, *so I can* start work without IT help.
- *When* I'm a Compliance Officer, *I want* to see who accessed what data and when, *so I can* prove access control compliance for PDPL Article 26.

**Acceptance criteria**

```
Scenario: Unauthenticated user is redirected to login
  Given I have no ExampleOrg_session cookie
  When I visit /risks
  Then I am redirected to /login

Scenario: Executive role lands on /executive automatically
  Given I am logged in with role "ceo"
  When I visit /
  Then I am redirected to /executive

Scenario: Admin endpoint rejects requests without admin key
  Given I have no admin session and no X-Admin-Key header
  When I POST /api/admin/seed-defaults
  Then I receive HTTP 401

Scenario: Page views are logged for accountability
  Given any user (authenticated or anonymous) loads a dashboard
  When the page renders
  Then a row appears in access_audit_log with event_type='page_view'
```

**Test cases** (run by `scripts/run-platform-tests.sh`)
- T-AUTH-01 `GET /` without session → 302 to /login
- T-AUTH-02 `GET /api/health` → 200, `{ ok: true }`
- T-AUTH-03 `POST /api/admin/seed-defaults` without key → 401
- T-AUTH-04 `POST /api/telemetry/pageview` → 200, row inserted

---

# Module 2 — Internal Audits Suite · *Tier 1 — workhorse*

The Internal Audits Suite consolidates **everything that happens inside our four walls** — the dashboard, the annual programme, off-platform report intake, real-time triggers, and the AI Quality Audits engine. External-body audits (certification, surveillance, regulatory, customer) live in **Module 3**. All findings — regardless of origin — converge into `grc_audit_findings` for a single audit-trail spine.

**Sub-modules**
- **2.A** — Internal Audits Dashboard (`/audits`)
- **2.B** — Annual Audit Programme + HITL sign-off
- **2.C** — Manual Audit Intake (`/intake`)
- **2.D** — Triggers (HITL gate + Auto-Escalation cron)
- **2.E** — AI Quality Audits (`/qms` Quality Audits tab)

Test ID namespaces: `T-IA-*` (dashboard), `T-PROG-*` (programme), `T-INTK-*` (intake), `T-TRIG-*` (triggers), `T-QA-*` (AI quality audits), and `T-EXT-*` for Module 3 External Audits.

---

## 1.B — CRM Owner Data Quality Widget · *Tier 1 — daily-driver*

**Purpose**: The owner-leaderboard card on `/` that scores each CRMProvider CRM record owner on data hygiene, tagged with their Department and Activity (Active/Inactive). Until v4.5.1 the activity badge always displayed `Unknown` and the department fell back to a hard-coded default — both have been fixed by wiring a real owner roster.

**Primary user**: CRM Admin, Sales Manager, Quality Manager.

**Key surfaces**
- `/` — "CRM Owner Data Quality" card (filter by team, status, modules; sort by score)
- `GET /api/agents/performance` — returns `{ id, name, team, role, status, score, recordsAudited, issues }` per owner

**Data sources**
- `src/data/seedUsers.ts` — **117-owner seed** loaded from `CRM_Users_Complete_117_Updated.xlsx` (snapshot 2026-04-18). Source of truth for `team`, `status`, `modules`.
- `fetchCRMProviderUsers()` in `src/utils/CRMProviderCRM.ts` — `GET /crm/v2/users?type=AllUsers` for the live CRMProvider User ID → display name bridge.
- Live CRMProvider `Leads` and `Deals` for the records being audited.

**Resolution rules**
1. Look up owner by CRMProvider User ID (from CRM record `Owner`).
2. Match CRMProvider user's `full_name` against the seed (case-insensitive, whitespace-collapsed).
3. Seed wins on `team`, `status`, `modules`. CRMProvider fills in any owner not yet on the seed (new hire path).
4. Owners with seed `team = ""` are surfaced as `Unassigned` — flagged in `ExampleOrg_GAPS_AND_DATA_NEEDS.md §7.A`.

**Roster snapshot (2026-04-18)**: 117 owners; 11 departments; 64 Active / 53 Inactive; 7 Unassigned (gap).

**Acceptance criteria**

```
Scenario: Each agent card shows real Department and Activity
  Given the 117-owner seed roster is loaded
  And the CRMProvider Users API is reachable
  When I GET /api/agents/performance
  Then every agent in the response has team ∈ {WP Sales, WO Sales, MP, SDR, CS, BD, MGMT, CRM Admin, Eitmad, WPE, Unassigned}
  And every agent has status ∈ {Active, Inactive, Unknown}
  And NO more than 7 agents have team='Unassigned'

Scenario: CRMProvider Users API outage falls back gracefully
  Given the CRMProvider Users API returns 401/500
  When I GET /api/agents/performance
  Then the response still succeeds and getUsers() returns the 117-row seed only
  And the API endpoint resolves owners via name-match against the seed (record.Owner.name → seed entry)
  And owners that match the seed by name receive the seed's stable id, team, role, and status
  And owners that do not match (e.g. former employees still on records) are returned with team='Unassigned' and status='Unknown'
  And a warning is logged: "[Users] CRMProvider Users API unavailable, falling back to seed only"

Scenario: New hire not on seed inherits CRMProvider profile
  Given a CRM record is owned by a CRMProvider user not in the seed
  When the dashboard renders that owner's card
  Then team falls back to the CRMProvider profile name (or 'Unassigned')
  And status falls back to the CRMProvider user's active flag
```

**Test cases**
- T-OWN-01 `GET /api/agents/performance` → 200, every `agent.status` ∈ {Active, Inactive, Unknown} (no `null`/missing)
- T-OWN-02 Open `/`, status filter dropdown → "Active" filters correctly to 64 owners max
- T-OWN-03 Team filter "Unassigned" → ≤7 cards
- T-OWN-04 Pull CRMProvider offline (kill creds) → endpoint still returns 200 with seed-only owners
- T-OWN-05 Roster refresh: re-import seed file → counts in `/` widget update on next page load

---

## 2.E — AI Quality Audits Surface · *Tier 1 — workhorse*

**Purpose**: Weekly automated quality scan across all CRM data — surfaces NCs, missing fields, stale records and policy violations without anyone needing to schedule it. Lives as the **Quality Audits (AI)** tab inside `/qms`. As of v4.5 the dashboard is no longer iframed into `/audits` — the AI surface and the Internal Audits Dashboard (Module 3) are now distinct first-class pages.

**Primary user**: Quality Manager, CCO.

**Key surfaces**
- `/qms` — Audit Reports dashboard, **Quality Audits (AI)** tab (badged "AI" in nav)
- `/api/audit/latest`, `/api/audit/history`, `/api/audit/recommendations`, `/api/audit/trigger`

**Data sources**: `quality_audit_results`, `quality_metrics`, `quality_trends`, source data from CRMProvider CRM via `crm_data` snapshot.

**Schedule**
- Mastra workflow: `0 8 * * 1` (Mon 09:00 Riyadh)
- Inngest cron (legacy fallback): `0 6 * * 1`
- Manual trigger: `POST /api/audit/trigger` (admin)

**Job stories**
- *When* it's Monday morning, *I want* a fresh quality audit waiting in my inbox, *so I can* triage NCs before standup.
- *When* I open the Audit Reports page, *I want* to see scores by dimension (people / process / governance) and drill into root causes, *so I can* assign CAPAs.

**Acceptance criteria**

```
Scenario: Latest audit is displayed with derived scores
  Given at least one quality audit has been completed
  When I GET /api/audit/latest
  Then I receive JSON with people_score, process_score, governance_score, overall_score
  And the scores are between 0 and 100

Scenario: Weekly cron runs at 09:00 Riyadh on Mondays
  Given the platform has been running for 7+ days
  When I check the workflow snapshot table
  Then quality-audit-workflow has fired exactly on Monday 09:00 each week

Scenario: Manual trigger bypasses schedule for ad-hoc audits
  Given I am an admin
  When I POST /api/audit/trigger
  Then a new quality_audit_results row is created within 60 seconds
```

**Test cases**
- T-QA-01 `GET /api/audit/latest` → 200, has score fields
- T-QA-02 `GET /api/audit/history?limit=5` → 200, array
- T-QA-03 `GET /api/audit/recommendations` → 200, array
- T-QA-04 26 lifetime audits exist in DB

---

## 2.A — Internal Audits Dashboard · *Tier 1*

**Purpose**: Single native page for the internal audit lifecycle — Annual Programme, finding traceability, evidence, checklist, plus quick-links to Manual Intake and External Audits. Replaces the v1.0 iframe-based two-tab design under `/audits`.

**Primary user**: QHSE Manager, Quality Manager, Internal Auditor.

**Key surfaces**
- `/audits` — Internal Audits Dashboard (native; no iframe)
- `/api/audits`, `/api/audits/:id`, `/api/audits/findings`, `/api/audits/checklist/:id`
- `/api/audits/:id/export-pdf`, `/api/audits/:id/export-xlsx`, `/api/audits/evidence-packs`

**Data sources**: `audits`, `grc_audit_findings`, `audit_checklists`, `evidence_packs`

**Job stories**
- *When* I open `/audits`, *I want* to see the current Annual Audit Programme status at the top, *so I can* decide whether to draft, submit, or chase sign-off.
- *When* the auditor finishes, *I want* findings to flow into NC and CAPA modules automatically.
- *When* a finding originated from an off-platform report or external audit, *I want* to see its provenance, *so I can* trust the audit trail.

**Acceptance criteria**

```
Scenario: Programme panel renders for current year
  Given an audit_programme exists for the current year
  When I GET /api/audit-programme?year=<current>
  Then the panel shows code, status, planned audit count, and sign-off state

Scenario: Latest audit card shows the most recent completed audit
  Given the audits table contains both completed and scheduled future audits
  When I GET /api/dashboard
  Then latestAudit shows the audit with the most recent completed_date or actual_end_date
  And no future-dated audit is shown as "latest"

Scenario: Finding provenance badges
  Given grc_audit_findings rows exist with intake_id, external_audit_id, or neither
  When the dashboard renders the findings grid
  Then each row shows a provenance badge (AI / Intake / External / Manual)
```

**Test cases**
- T-ISO-01 `GET /api/audits` → 200, array
- T-ISO-02 `GET /api/audits/summary` → 200
- T-ISO-03 `GET /api/audits/evidence-packs` → 200
- T-AUD-DASH-01 `GET /audits` returns native HTML (no iframe to `/qms`)

---

## 2.B — Annual Audit Programme (HITL sign-off) · *Tier 1 — new in v4.5*

**Purpose**: Govern the annual internal audit plan with a formal Head-of-Operations-&-Quality sign-off (ISO 19011 §5.2). One programme per calendar year, transitioning draft → pending_signoff → signed_off.

**Primary user**: Quality Manager (drafts), Head of Operations & Quality (approves).

**Key surfaces**
- `/audits` (top panel)
- `/ai-approvals` (HITL queue)
- `/api/audit-programme`, `/api/audit-programme/:id/submit`

**Data sources**: `audit_programmes`, `audit_programme_audits`, `ai_pending_actions` (action_code=`audit_programme_signoff`)

**Job stories**
- *When* a new fiscal year starts, *I want* to draft the year's audit plan, *so I can* lock the audit cycle before Q1.
- *When* the programme is submitted, *I want* only the Head of Operations & Quality to be able to sign it off, *so I can* satisfy ISO 19011 §5.2.

**Acceptance criteria**

```
Scenario: Only head_of_operations_quality can approve programme
  Given an ai_pending_actions row with action_code='audit_programme_signoff'
  When a user with role != 'head_of_operations_quality' attempts approval
  Then the API returns 403

Scenario: Programme transitions through correct states
  Given a draft programme
  When submitted
  Then status='pending_signoff' and HITL ticket created
  When approved by head_of_operations_quality
  Then status='signed_off' and signoff_user_id, signoff_at populated
```

**Test cases**
- T-IAP-01 `POST /api/audit-programme` (draft) → 200
- T-IAP-02 `POST /api/audit-programme/:id/submit` → HITL ticket created
- T-IAP-03 Non-HOQ approval → 403
- T-IAP-04 HOQ approval → status=signed_off

---

## 2.C — Manual Audit Intake · *Tier 1 — new in v4.5*

**Purpose**: Central single-point intake for off-platform audit reports (HR's supplier audits, KPMG external assessments, vendor audits). GPT-4o extracts structured findings with source-quote traceability; reviewer accepts/edits/rejects each before promotion to the finding spine.

**Primary user**: Quality Manager.

**Key surfaces**
- `/intake` — intake workspace
- `/api/manual-audit-intake`, `/api/manual-audit-intake/:id`, `/api/manual-audit-intake/:id/findings`, `/api/manual-audit-intake/:id/finalize`

**Data sources**: `manual_audit_intake`, `manual_audit_findings`, `grc_audit_findings` (`intake_id` FK)

**Job stories**
- *When* HR sends me a supplier audit PDF, *I want* to upload it once and have findings auto-extracted, *so I can* avoid manual rekeying.
- *When* a finding is wrong, *I want* to edit or reject it before it enters the official log, *so I can* preserve audit-trail integrity.

**Acceptance criteria**

```
Scenario: GPT-4o extraction
  Given a PDF/DOCX upload via POST /api/manual-audit-intake
  When extraction completes
  Then manual_audit_findings rows are populated with source_quote per finding
  And intake.status='ready_for_review'

Scenario: Finalize promotes accepted findings
  Given an intake with N findings in state ∈ {accepted, edited}
  When POST /api/manual-audit-intake/:id/finalize
  Then N rows appear in grc_audit_findings with intake_id set
```

**Test cases**
- T-INT-01 Upload → 200 with intake_code
- T-INT-02 Extraction populates findings with source_quote
- T-INT-03 Finalize → grc_audit_findings rows with intake_id

---

## 2.D — Triggers (HITL gate + Auto-Escalation) · *Tier 1 — new in v4.5*

**Purpose**: Real-time monitoring of QMS conditions (SLA breaches, missed thresholds, drift) that surfaces a finding the moment a rule fires; v4.5 adds an explicit human-in-the-loop gate on dismissals plus an auto-escalation safety net so nothing important falls through the cracks.

**Primary user**: Quality Manager (review/dismiss), Head of Operations & Quality (HITL adjudication on Critical proposals).

**Key surfaces**
- `/qms` Triggers tab
- `/ai-approvals` (HITL queue)
- `/api/qms/triggers`, `/api/qms/triggers/:id/dismiss`, `/api/qms/triggers/:id/propose-hitl`
- Inngest cron: `trigger-auto-escalate` (daily 03:00 UTC)

**Data sources**: `qms_triggers` (with new columns `dismiss_reason`, `re_evaluate_at`, `escalation_finding_id`), `audit_triggers_decisions`, `ai_pending_actions` (action_code=`trigger_decision`), `grc_audit_findings`

**Job stories**
- *When* I want to dismiss a noisy trigger, *I want* the system to require a written reason, *so I can* maintain audit-trail integrity for any "we looked but moved on" decisions.
- *When* a Critical trigger fires and I'm not sure what to do, *I want* to escalate to HITL, *so I can* get a second pair of eyes from the Head of Operations & Quality.
- *When* I forget about a stale Critical trigger for 7 days, *I want* the platform to auto-open a finding, *so I can* be sure nothing critical is silently ignored.

**Acceptance criteria**

```
Scenario: Dismiss requires a reason
  Given a qms_triggers row with status='active'
  When I POST /api/qms/triggers/:id/dismiss with reason length < 10
  Then the API returns 400 with error 'dismiss_reason_required'

Scenario: Dismissed triggers are auto-re-evaluated 24h later
  Given a trigger dismissed at T0
  When the trigger-auto-escalate cron runs after T0+24h
  Then the trigger.status returns to 'active'

Scenario: Critical-trigger HITL proposal
  Given a qms_triggers row with severity='critical'
  When the user clicks 'Propose via HITL'
  Then a row appears in ai_pending_actions with action_code='trigger_decision'

Scenario: Stale Critical trigger auto-opens a finding
  Given a critical trigger pending ≥7 days
  When the cron runs
  Then a grc_audit_findings row is created
  And the trigger.escalation_finding_id is set bi-directionally

Scenario: Stale Minor trigger auto-opens a finding (30d)
  Given a minor trigger pending ≥30 days
  When the cron runs
  Then a grc_audit_findings row is created
```

**Test cases**
- T-TRIG-01 Dismiss without reason → 400
- T-TRIG-02 Dismiss with reason ≥10 chars → 200, dismiss_reason persisted
- T-TRIG-03 24h re-evaluation reactivates trigger
- T-TRIG-04 Critical "Propose via HITL" creates ai_pending_actions row
- T-TRIG-05 Cron auto-opens finding for stale Critical@7d
- T-TRIG-06 Cron auto-opens finding for stale Minor@30d
- T-TRIG-07 Bi-directional `escalation_finding_id` linkage verified

---

# Module 3 — External Audits · *Tier 1 — new in v4.5*

**Purpose**: Track every external audit (certification, recertification, surveillance, regulatory, customer) with its certificate body, calendar, certificate register, and pre-audit readiness checklist.

**Primary user**: GRC Manager, Quality Manager.

**Key surfaces**
- `/external-audits` — three tabs: Calendar/Audits · Certificate Register · Readiness Checklist
- `/grc` — External Audits hero card (Next / Active Certs / Expiring ≤90d)
- `/api/external-audits`, `/api/external-audits/summary`, `/api/external-audits/certificates`, `/api/external-audits/checklist`

**Data sources**: `external_audits`, `external_audit_certificates`, `external_audit_checklist`

**Job stories**
- *When* a surveillance audit is due, *I want* to see how many days remain and the current certificate's expiry, *so I can* prepare on time.
- *When* the GRC dashboard loads, *I want* a one-glance view of certification status, *so I can* spot expiring certs.

**Acceptance criteria**

```
Scenario: Hero card matches summary endpoint
  Given external_audit_certificates with 3 active and 1 expiring ≤90d
  When I load /grc
  Then the External Audits card shows Active=3, Expiring=1

Scenario: Audit kind filter works
  Given external_audits rows of mixed kinds
  When I GET /api/external-audits?kind=certification
  Then only certification rows are returned
```

**Test cases**
- T-EXT-01 `/api/external-audits/summary` → 200
- T-EXT-02 `/api/external-audits?kind=certification` → 200
- T-EXT-03 `/api/external-audits/certificates` → 200
- T-GRC-EXT `/grc` hero matches summary

---

# Module 4 — Risk Management · *Tier 2*

**Purpose**: Enterprise risk register, heat-map, treatment actions, AI-detected risks.

**Primary user**: Risk Manager, CCO.

**Key surfaces**
- `/risks` — Risk Register dashboard
- `/api/risks`, `/api/risks/categories`, `/api/risks/treatments`, `/api/risks/heatmap`

**Data sources**: `enterprise_risks`, `risk_categories`, `risk_treatment_actions`, `risk_assessment_history`, `project_risks`

**Current state**: Register is empty (0 risks). Empty-state UX shipped (Risk Mgmt page + Risks infographic both show "No Risks Logged Yet" with capability cards and a clear CTA).

**Job stories**
- *When* I open Risks for the first time, *I want* to know exactly what to do next instead of staring at zeros.
- *When* the AI scanner finds a likely risk in the CRM, *I want* it to suggest adding it to the register, not silently log it.

**Acceptance criteria**

```
Scenario: Empty register shows actionable guidance
  Given enterprise_risks has 0 rows
  When I open /risks
  Then I see "No Risks Logged Yet" hero
  And I see the "Add Risk" call-to-action
  And capability cards confirm the engine is ready

Scenario: Risk infographic mirrors the empty state
  Given enterprise_risks has 0 rows
  When I GET /api/infographic/risks
  Then the SVG contains "NO RISKS LOGGED YET" and "ADD A RISK"
```

**Test cases**
- T-RISK-01 `GET /api/infographic/risks` → 200, contains empty-state copy
- T-RISK-02 `GET /risks` → 200 (or 302 if unauth)

---

# Module 5 — Compliance & PDPL · *Tier 1*

**Purpose**: Track regulatory obligations (PDPL 18 articles seeded + general compliance), assess gaps, manage deadlines.

**Primary user**: Compliance Officer, DPO.

**Key surfaces**
- `/compliance` — Compliance Tracking dashboard
- `/pdpl` — PDPL Privacy Compliance dashboard
- `/api/compliance/dashboard`, `/api/compliance/assessments`, `/api/compliance/calendar`, `/api/compliance/deadlines`

**Data sources**: `obligations`, `compliance_assessments`, `compliance_calendar`, `compliance_checklists`, `regulations`, `dsar_requests`, `data_inventory`, `data_incidents`, `pdpl_audit_log`, `retention_policies`

**Acceptance criteria**

```
Scenario: PDPL articles are seeded and visible
  Given a fresh database with seed run
  When I GET /api/compliance/dashboard
  Then I see at least 18 PDPL obligations
  And each has owner, status, due_date

Scenario: Deadline calendar shows next 30 days
  When I GET /api/compliance/calendar?days=30
  Then I receive items dated within today + 30 days
```

**Test cases**
- T-COMP-01 `GET /api/compliance/dashboard` → 200
- T-COMP-02 `GET /api/compliance/calendar` → 200
- T-COMP-03 `GET /api/compliance/deadlines` → 200

---

# Module 6 — Controlled Documents · *Tier 1 — workhorse*

> Renamed in v4.5 from "Policies & Integrated QMS". Baseline expanded from 147 → **154 controlled documents** (147 originals + 7 v4.5 additions: WP-SOP-040 Audit Programme Governance, WP-SOP-041 Manual Intake Control, WP-SOP-042 External Audit Preparation, plus WP-FORM-055/056/057/058).

**Purpose**: Single library for Policies, Procedures, Work Instructions, SOPs, Forms, Templates with versioning, acknowledgments, review cycles, file upload.

**Primary user**: Document Controller, all employees (acknowledgment).

**Key surfaces**
- `/policies` — Integrated ExampleOrg
- `/api/policies`, `/api/policies/:id`, `/api/policies/:id/upload`, `/api/policies/:id/acknowledge`

**Data sources**: `policies` (147 docs), `policy_versions`, `policy_acknowledgments`, `policy_review_cycles`, `documents`, `qms_documents`, `governance_documents`

**Acceptance criteria**

```
Scenario: Policy CSV export
  Given there are 147 controlled documents
  When I GET /api/policies/export.csv
  Then I receive a CSV with all policy fields and a Content-Type of text/csv

Scenario: File upload validation
  When I upload a 30 MB file
  Then I receive a 400 with message "max 25 MB"
  When I upload a .exe file
  Then I receive a 400 with message about allowed types (PDF, DOCX, XLSX, PPTX, PNG, JPG)
```

**Test cases**
- T-POL-01 `GET /api/policies` → 200, ≥ 154 records (147 + 7 v4.5)
- T-POL-02 `GET /api/policies?type=SOP` → 200
- T-POL-03 Policy ack endpoint exists

---

# Module 7 — KPIs & Executive Analytics · *Tier 1*

**Purpose**: Define quality/GRC KPIs with targets and RAG status; daily auto-calc; executive dashboards.

**Primary user**: Quality Manager, CEO/CCO/CFO.

**Key surfaces**
- `/kpis` — KPI Tracking dashboard
- `/executive` — Executive Dashboard (Quality Health Index across 5 dimensions)
- `/team` — Team Performance
- `/api/kpis`, `/api/kpis/:id`, `/api/kpis/calculate`, `/api/analytics/cycle-times`, `/api/analytics/trends`, `/api/analytics/executive-digest`

**Data sources**: `kpi_definitions` (35 defined), `kpi_values` (6 recorded), `quality_metrics`, `quality_trends`, `executive_reports`

**Known gap**: Most KPI definitions have no input bindings → engine runs but produces few values. Roadmap item.

**Acceptance criteria**

```
Scenario: KPI list returns definitions and most-recent value
  When I GET /api/kpis
  Then each KPI has id, name, target, current_value, status (green/amber/red)

Scenario: Executive digest is composable
  When I GET /api/analytics/executive-digest
  Then I receive a summary covering NC, CAPA, risk, audit, KPI, compliance
```

**Test cases**
- T-KPI-01 `GET /api/kpis` → 200
- T-KPI-02 `GET /api/analytics/executive-digest` → 200
- T-KPI-03 `GET /api/analytics/cycle-times` → 200

---

# Module 8 — Vendors · *Tier 2*

**Purpose**: Vendor risk management & supplier assessments.

**Key surfaces**: `/vendors`, `/api/vendors`

**Test cases**
- T-VEND-01 `GET /api/vendors` → 200
- T-VEND-02 `GET /vendors` → 200/302

---

# Module 9 — Duplicate Radar · *Tier 1 — workhorse*

**Purpose**: Multi-signal duplicate detection across Leads/Contacts/Deals/Accounts in CRMProvider CRM with auto-resolve, RAG owner accountability, AI recommendations.

**Primary user**: CRM Admin, Sales Ops.

**Key surfaces**
- `/duplicates` — Duplicate Radar dashboard
- `/api/duplicates/scan` (SSE), `/api/duplicates/clusters`, `/api/duplicates/records`, `/api/duplicates/auto-resolve`

**Data sources**: `duplicate_clusters` (22,271 detected), `duplicate_records`, `duplicate_merge_actions`, `duplicate_record_tasks`, `duplicate_detection_logs`, `duplicate_export_logs`

**Acceptance criteria**

```
Scenario: Cluster pagination
  When I GET /api/duplicates/clusters?page=1&pageSize=20
  Then I receive 20 clusters with pagination metadata (total, page, pageSize)

Scenario: Owner RAG breakdown
  When I GET /api/duplicates/owners
  Then each owner has duplicate_rate and a rag color (green ≤2% / amber 2-5% / red >5%)
```

**Test cases**
- T-DUP-01 `GET /api/duplicates/clusters?pageSize=5` → 200
- T-DUP-02 `GET /api/duplicates/summary` → 200
- T-DUP-03 22,271+ clusters in DB

---

# Module 10 — Call Intelligence · *Tier 2*

**Purpose**: Call recordings ingestion (ContactCenterProvider), transcription, AI evaluation against scorecards, agent compliance.

**Key surfaces**
- `/calls`, `/api/calls`, `/api/calls/:id`, `/api/calls/:id/evaluate`, `/api/calls/analytics`, `/api/calls/ContactCenterProvider/configure`

**Data sources**: `call_records`, `call_transcripts`, `call_analysis`, `call_compliance`, `call_qa_scores`

**Test cases**
- T-CALL-01 `GET /api/calls` → 200
- T-CALL-02 `GET /api/calls/analytics` → 200

---

# Module 11 — AI Consultant + HITL Approvals · *Tier 1*

**Purpose**: Conversational AI with 23 consultant tools (NC mgmt, CAPA, risk monitor, KPI monitor, alerts, knowledge search, etc.) plus a human-in-the-loop gate for any state-changing action. **v4.5 added two HITL action codes** (`audit_programme_signoff` for the Annual Programme — Head-of-Operations-&-Quality only — and `trigger_decision` for Critical-trigger proposals); these are HITL action codes, **not** consultant tools, so the consultant tool count remains 23.

**Primary user**: Quality Manager, CCO, ops staff.

**Key surfaces**
- `/consultant` — AI Consultant chat
- `/ai-approvals` — Pending Approvals queue
- `/api/consultant/chat`, `/api/consultant/stream` (SSE), `/api/consultant/alerts`, `/api/consultant/scan`
- `/api/ai/approvals`, `/api/ai/approvals/:code/approve`, `/api/ai/approvals/:code/reject`

**Data sources**: `ai_alerts` (260), `ai_pending_actions` (0 — never exercised), `ai_guardrails`, `ai_training_feedback`, `mastra_messages`, `mastra_traces`

**Acceptance criteria**

```
Scenario: Chat returns a streamed answer
  Given I send a question to /api/consultant/stream
  When the stream completes
  Then I receive a tool plan + a final answer

Scenario: Risky action requires approval
  Given the AI proposes to close a CAPA
  When the tool is invoked
  Then a row is inserted in ai_pending_actions
  And no DB write happens until /api/ai/approvals/:code/approve is called
```

**Test cases**
- T-AI-01 `GET /api/consultant/alerts/count` → 200, integer
- T-AI-02 `GET /api/ai/approvals/pending-count` → 200
- T-AI-03 `GET /api/ai/approvals` → 200, array

---

# Module 12 — Infographic Generator · *Tier 1 — newly shipped*

**Purpose**: One-click visual reports of any of 6 platform sections, with PNG download + ChatProvider/Email share.

**Primary user**: CCO, CEO, anyone preparing a board pack.

**Key surfaces**
- `/infographic` — Picker UI
- `/api/infographic/sections` — list
- `/api/infographic/:section?format=svg|png` — render
- `/api/infographic/:section/share/ChatProvider` — share to ChatProvider (with graceful fallback)
- `/api/infographic/:section/share/email` — share via EmailProvider

**Sections** (6 total): `platform-health`, `kpis`, `risks`, `audits`, `duplicates`, `consultant`

**Acceptance criteria**

```
Scenario: SVG renders for every section
  When I GET /api/infographic/{section} for each of the 6 sections
  Then I receive 200 with image/svg+xml and length 8-15 KB

Scenario: PNG output is print-quality
  When I GET /api/infographic/platform-health?format=png
  Then I receive 200 with image/png and dimensions 1200×1500 and size ≥ 500 KB

Scenario: ChatProvider share gracefully falls back when files:write missing
  Given the ChatProvider bot lacks files:write scope
  When I POST /api/infographic/risks/share/ChatProvider
  Then I receive 200 with mode: 'message' and a helpful note

Scenario: Email recipient cap enforced
  Given I provide 21 recipient emails
  When I POST /api/infographic/risks/share/email
  Then I receive 400 with "max 20 recipients"
```

**Test cases**
- T-INFO-platform-health, T-INFO-kpis, T-INFO-risks, T-INFO-audits, T-INFO-duplicates, T-INFO-consultant → 200, valid SVG
- T-INFO-07 `GET /api/infographic/risks?format=png` → 200, ≥ 500 KB
- T-INFO-08 ChatProvider share returns `mode: 'message'` (current scope state)
- T-INFO-09 Email with 21 recipients → 400
- T-INFO-10 Email with invalid address → 400
- T-INFO-11 Unknown section → 404

---

# Module 13 — Management Review · *Tier 2*

**Purpose**: ISO 9001 Clause 9.3 management review meetings, action items, auto-gather inputs.

**Key surfaces**: `/reviews`, `/api/management-reviews`, `/api/management-reviews/:id/gather-inputs`

**Data sources**: `management_reviews`, `management_review_actions`, `meeting_mom`

**Test cases**
- T-MR-01 `GET /api/management-reviews` → 200

---

# Module 14 — Supporting modules · *Tier 3*

| Module | URL | Test ID | Expectation |
|---|---|---|---|
| Main Dashboard | `/` | T-DASH-01 | 200 (or 302 if exec) |
| GRC Control Tower | `/grc` | T-GRC-01 | 200 |
| Table F | `/tablef` | T-TBLF-01 | 200 |
| CRM Data | `/crm` | T-CRM-01 | 200 |
| Manual Audit Intake | `/intake` | T-INT-DASH-01 | 200 |
| External Audits | `/external-audits` | T-EXT-DASH-01 | 200 |
| Migration | `/migration` | T-MIG-01 | 200 |
| ROI & NPV | `/roi` | T-ROI-01 | 200 |
| Projects (PMP) | `/projects` | T-PROJ-01 | 200 |
| Scorecard | `/scorecard` | T-SCOR-01 | 200 |
| System Logs | `/logs` | T-LOG-01 | 200 |
| User Guide | `/guide` | T-GUIDE-01 | 200 (public) |
| Platform SOP | `/sop` | T-SOP-01 | 200 (public) |
| Onboarding/Help | `/onboarding` | T-ONB-01 | 200 |
| Feedback | `/feedback` | T-FB-01 | 200 |
| Admin | `/admin` | T-ADM-01 | 200 with key, prompt without |
| Users & Access | `/users` | T-USERS-01 | 200 |

---

# Module 15 — Admin & Tools · *Tier 2 — new in v4.5*

**Purpose**: Top-nav dropdown consolidating platform-wide operator tooling that is not day-to-day for Quality/GRC users — data loading, RBAC, HITL queue, system health, logs. Role-gated at render time so the group only appears for operator roles.

**Primary user**: Admin, Head of Operations & Quality, GRC Manager, Quality Manager, AI Specialist.

**Key surfaces**
- Nav group **Admin & Tools** (label change from "Admin")
- `/migration` — Data Migration Engine (moved from GRC; v4.5 added 5 Quality templates: CAPA, NC, Training, Findings, Deal Evaluations)
- `/admin` — User & Role Management
- `/users` — Users & Access
- `/ai-approvals` — AI Approvals Queue
- `/logs` — System Logs (moved from Analytics)

**Data sources**: `platform_users`, `role_permissions`, `migration_jobs`, `migration_templates`, `ai_pending_actions`, `event_logs`

**Job stories**
- *When* I'm onboarding a new role, *I want* one place to manage users, roles, permissions, and HITL queue, *so I can* avoid hunting across menus.
- *When* importing legacy CAPA/NC data, *I want* a templated importer that pre-checks duplicates and maps columns with AI, *so I can* finish in minutes not days.

**Acceptance criteria**

```
Scenario: Group is hidden for users without operator role
  Given a user with role 'auditor' (read-only)
  When I render the navigation
  Then the 'Admin & Tools' group is not present in the DOM

Scenario: Group is visible for head_of_operations_quality
  Given a user with role 'head_of_operations_quality'
  When I render the navigation
  Then the 'Admin & Tools' dropdown is present with all 5 items
```

**Test cases**
- T-ADM-NAV-01 Nav renders for admin role
- T-ADM-NAV-02 Nav hidden for non-operator role
- T-MIG-TPL-01 5 new Quality templates present in template registry
- T-MIG-TPL-02 Template seed creates importer rows with column mapper

---

# Test execution

Two test layers run as part of every release:

### Layer 1 — API/route smoke matrix (~2 min)
Script: `scripts/run-platform-tests.sh`
Output: `ExampleOrg_TEST_REPORT.md`

What it covers: every dashboard route returns the expected status, every key API returns the expected shape, all 6 infographic sections render, ChatProvider/Email validation paths reject bad input.

### Layer 2 — Browser end-to-end (~5 min)
Tool: Playwright via the testing skill.
What it covers: visit the picker, render an infographic, validate the SVG appears in the DOM, open a ChatProvider share dialog, verify the success banner.

### Pass/fail criteria
- **Pass**: 100% of Tier-1 tests green, ≥95% of Tier-2 green, ≥90% of Tier-3 green
- **Conditional pass**: any failure traceable to a documented known gap (e.g. KPI sparsity) and noted in the test report
- **Fail**: any Tier-1 test red without explanation

---

*This is a living document. Add new features as new modules; update Gherkin scenarios when behavior changes.*
