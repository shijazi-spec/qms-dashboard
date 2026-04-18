# WalaPlus Enterprise GRC & Quality Platform
## Feature Book & Test Specifications — v1.0
*Last updated: 18 April 2026*

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
- `/login` — email/Google/GitHub/Apple login via Replit OIDC
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
  Given I have no walaplus_session cookie
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

# Module 2 — Quality Audits (AI) · *Tier 1 — workhorse*

**Purpose**: Weekly automated quality scan across all CRM data — surfaces NCs, missing fields, stale records and policy violations without anyone needing to schedule it.

**Primary user**: Quality Manager, CCO.

**Key surfaces**
- `/qms` — Audit Reports dashboard (badged "AI" in nav)
- `/api/audit/latest`, `/api/audit/history`, `/api/audit/recommendations`, `/api/audit/trigger`

**Data sources**: `quality_audit_results`, `quality_metrics`, `quality_trends`, source data from Zoho CRM via `crm_data` snapshot.

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

# Module 3 — ISO Internal Audits (manual) · *Tier 2*

**Purpose**: Track scheduled internal/external ISO 9001 audits, capture findings, drive CAPAs.

**Primary user**: QHSE Manager, Internal Auditor.

**Key surfaces**
- `/audits` — ISO Internal Audits dashboard
- `/api/audits`, `/api/audits/:id`, `/api/audits/findings`, `/api/audits/checklist/:id`
- `/api/audits/:id/export-pdf`, `/api/audits/:id/export-xlsx`, `/api/audits/evidence-packs`

**Data sources**: `audits`, `audit_findings`, `audit_checklists`, `evidence_packs`

**Job stories**
- *When* I'm planning the Q2 internal audit cycle, *I want* to schedule audits with auditors and scope, *so I can* coordinate without spreadsheets.
- *When* the auditor finishes, *I want* findings to flow into NC and CAPA modules automatically.

**Acceptance criteria**

```
Scenario: Latest audit card shows the most recent completed audit
  Given the audits table contains both completed and scheduled future audits
  When I GET /api/dashboard
  Then latestAudit shows the audit with the most recent completed_date or actual_end_date
  And no future-dated audit is shown as "latest"

Scenario: Evidence pack export
  Given an audit has 1+ findings with attached evidence
  When I GET /api/audits/:id/export-pdf
  Then I receive a PDF stream with HTTP 200
```

**Test cases**
- T-ISO-01 `GET /api/audits` → 200, array
- T-ISO-02 `GET /api/audits/summary` → 200
- T-ISO-03 `GET /api/audits/evidence-packs` → 200

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

# Module 6 — Policies & Integrated QMS · *Tier 1 — workhorse*

**Purpose**: Single library for Policies, Procedures, Work Instructions, SOPs, Forms, Templates with versioning, acknowledgments, review cycles, file upload.

**Primary user**: Document Controller, all employees (acknowledgment).

**Key surfaces**
- `/policies` — Integrated QMS dashboard
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
- T-POL-01 `GET /api/policies` → 200, ≥ 147 records
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

**Purpose**: Multi-signal duplicate detection across Leads/Contacts/Deals/Accounts in Zoho CRM with auto-resolve, RAG owner accountability, AI recommendations.

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

**Purpose**: Call recordings ingestion (Five9), transcription, AI evaluation against scorecards, agent compliance.

**Key surfaces**
- `/calls`, `/api/calls`, `/api/calls/:id`, `/api/calls/:id/evaluate`, `/api/calls/analytics`, `/api/calls/five9/configure`

**Data sources**: `call_records`, `call_transcripts`, `call_analysis`, `call_compliance`, `call_qa_scores`

**Test cases**
- T-CALL-01 `GET /api/calls` → 200
- T-CALL-02 `GET /api/calls/analytics` → 200

---

# Module 11 — AI Consultant + HITL Approvals · *Tier 1*

**Purpose**: Conversational AI with 23 tools (NC mgmt, CAPA, risk monitor, KPI monitor, alerts, knowledge search, etc.) plus a human-in-the-loop gate for any state-changing action.

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

**Purpose**: One-click visual reports of any of 6 platform sections, with PNG download + Slack/Email share.

**Primary user**: CCO, CEO, anyone preparing a board pack.

**Key surfaces**
- `/infographic` — Picker UI
- `/api/infographic/sections` — list
- `/api/infographic/:section?format=svg|png` — render
- `/api/infographic/:section/share/slack` — share to Slack (with graceful fallback)
- `/api/infographic/:section/share/email` — share via Resend

**Sections** (6 total): `platform-health`, `kpis`, `risks`, `audits`, `duplicates`, `consultant`

**Acceptance criteria**

```
Scenario: SVG renders for every section
  When I GET /api/infographic/{section} for each of the 6 sections
  Then I receive 200 with image/svg+xml and length 8-15 KB

Scenario: PNG output is print-quality
  When I GET /api/infographic/platform-health?format=png
  Then I receive 200 with image/png and dimensions 1200×1500 and size ≥ 500 KB

Scenario: Slack share gracefully falls back when files:write missing
  Given the Slack bot lacks files:write scope
  When I POST /api/infographic/risks/share/slack
  Then I receive 200 with mode: 'message' and a helpful note

Scenario: Email recipient cap enforced
  Given I provide 21 recipient emails
  When I POST /api/infographic/risks/share/email
  Then I receive 400 with "max 20 recipients"
```

**Test cases**
- T-INFO-platform-health, T-INFO-kpis, T-INFO-risks, T-INFO-audits, T-INFO-duplicates, T-INFO-consultant → 200, valid SVG
- T-INFO-07 `GET /api/infographic/risks?format=png` → 200, ≥ 500 KB
- T-INFO-08 Slack share returns `mode: 'message'` (current scope state)
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

# Test execution

Two test layers run as part of every release:

### Layer 1 — API/route smoke matrix (~2 min)
Script: `scripts/run-platform-tests.sh`
Output: `WALAPLUS_TEST_REPORT.md`

What it covers: every dashboard route returns the expected status, every key API returns the expected shape, all 6 infographic sections render, Slack/Email validation paths reject bad input.

### Layer 2 — Browser end-to-end (~5 min)
Tool: Playwright via the testing skill.
What it covers: visit the picker, render an infographic, validate the SVG appears in the DOM, open a Slack share dialog, verify the success banner.

### Pass/fail criteria
- **Pass**: 100% of Tier-1 tests green, ≥95% of Tier-2 green, ≥90% of Tier-3 green
- **Conditional pass**: any failure traceable to a documented known gap (e.g. KPI sparsity) and noted in the test report
- **Fail**: any Tier-1 test red without explanation

---

*This is a living document. Add new features as new modules; update Gherkin scenarios when behavior changes.*
