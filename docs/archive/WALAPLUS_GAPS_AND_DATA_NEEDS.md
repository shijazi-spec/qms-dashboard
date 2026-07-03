# WalaPlus — Gaps & Data Upload Needs
**As of:** 18 April 2026 · For: Manager review tomorrow · Owner: Platform team

---

## 1 · TL;DR (read this first)

The platform itself is **technically healthy** (now **v4.5**: +8 new tables → 113 total, +9 migration templates, 35 dashboards). 66/66 system tests passing, no errors in logs, all dashboards render. The "not working" feeling is **not a code problem**; it is a **data problem**. Several modules display empty tables / zero metrics because the underlying data has not been entered yet.

There are **3 buckets of work**:

| # | Bucket | Owner | Effort |
|---|---|---|---|
| 1 | **Operational data uploads** (the big one — 9 modules waiting) | Business / module owners | 1–3 weeks of data entry or a one-time bulk import |
| 2 | **One Slack admin scope** | IT admin | 5 minutes |
| 3 | **No code fixes outstanding** | — | — |

---

## 2 · Modules that show empty / zero today

Listed in **priority order** (highest business impact first).

### 🟥 P0 — Blocks core ISO 9001 / quality reporting

| # | Module | Table(s) | Rows | Why empty | What to upload |
|---|---|---|---|---|---|
| 1 | **Enterprise Risk Register** | `enterprise_risks` | 0 | No risks have been logged | The current risk register (Excel/Word). Per risk: title, owner, likelihood (1–5), impact (1–5), category, treatment plan, target date |
| 2 | **Audit Findings & Evidence** | `audit_findings`, `evidence_packs`, `evidence_records` | 0 / 0 / 0 | Audits exist (5) but findings + evidence not attached | For each of the 5 ISO audits: list of findings (severity, clause, description) + evidence files (PDF/screenshot) |
| 3 | **Nonconformance & CAPA records** | `nonconformance_records`, `capa_records` | 0 / 0 | Only 4 sample NCs and 4 sample CAPAs exist (test data) | Real NC log + CAPA log from the last 6–12 months. Per NC: source, severity, description, root cause, status. Per CAPA: linked NC, action, owner, due date, status |
| 4 | **Compliance Assessments** | `compliance_assessments` | 0 | 6 regulations + 18 obligations defined, but no assessment runs recorded | Latest gap-assessment results per regulation (PDPL, ISO 9001, etc.): obligation_id, status (compliant / partial / non-compliant), evidence link |

### 🟧 P1 — Operational visibility (sales / vendor / call quality)

| # | Module | Table(s) | Rows | Why empty | What to upload |
|---|---|---|---|---|---|
| 5 | **Vendor Risk Register** | `vendors` | 0 | No vendors entered | Vendor master list (Excel): name, category, criticality, contract date, last review, owner |
| 6 | **Call Records & QA** | `call_records`, `call_compliance` | 0 / 0 | No call data feed configured | Either (a) bulk upload of last 90 days of call logs (CSV from telephony), or (b) connect Zoho/3CX integration |
| 7 | **Team Performance Metrics** | `team_performance_metrics` | 0 | Not being collected | Monthly team KPIs (Excel): team, period, metric, value |
| 8 | **Compliance Calendar** | `compliance_calendar` | 0 | No regulatory deadlines scheduled | Upcoming deadlines per regulation: regulation, obligation, due date, owner |

### 🟨 P2 — Nice to have / context

| # | Module | Table(s) | Rows | Why empty | What to upload |
|---|---|---|---|---|---|
| 9 | **Data Incidents (PDPL log)** | `data_incidents` | 0 | No incidents logged (could genuinely be zero) | Confirm: are there any historical PDPL incidents to log? If yes — date, type, affected count, mitigation |

---

## 3 · Modules that are partially populated (need topping up)

| Module | Rows today | Gap |
|---|---|---|
| ISO Internal Audits | 5 audits | 4 of these look like test data (titles like "Test Audit 8u4GT9"). Replace with real audit plan + history |
| Nonconformances (parent table) | 4 | All 4 are test/sample. Replace with real NC log |
| CAPAs (parent table) | 4 | Same — test data. Replace |

### 3a · New v4.5 modules awaiting first-time data (P1)

| Module | Table(s) | Rows | Why empty | What to upload |
|---|---|---|---|---|
| **Annual Audit Programme** | `audit_programmes`, `audit_programme_audits` | 0 / 0 | Newly shipped in v4.5 — needs the 2026 programme drafted | One programme record for FY 2026: title, planned audits with scope/dates/auditors. Will then route through HITL sign-off (`head_of_operations_quality`). |
| **Manual Audit Intake** | `manual_audit_intake`, `manual_audit_findings` | 0 / 0 | Newly shipped — Quality Manager has not yet uploaded any off-platform reports | Backlog of recent off-platform reports (HR supplier audits, KPMG assessments, vendor audit PDFs) to upload via `/intake`. |
| **External Audits** | `external_audits`, `external_audit_certificates`, `external_audit_checklist` | 0 / 0 / 0 | Newly shipped — 2026 certification audit calendar not yet seeded | 2026 calendar: scheduled certification / surveillance / customer audits (kind, body, standard, planned dates) + active certificate inventory (issuing body, standard, valid_from, valid_to). |

---

## 4 · Modules that ARE working with real data (no action needed)

So the manager doesn't think nothing works — these are humming:

| Module | Status |
|---|---|
| Quality Audit AI | ✅ 26 audit runs, 180,945 records analyzed, 131,036 issues flagged |
| Duplicates Engine | ✅ 22,271 clusters, 4,327 true duplicates across 40,462 records |
| Policies / Controlled Documents | ✅ 147 policies versioned and tracked |
| KPI Library | ✅ 35 KPIs defined (ISO-aligned) |
| Compliance Framework | ✅ 6 regulations × 18 obligations mapped |
| Infographic Generator | ✅ All 6 sections rendering, Slack + Email sharing live |
| Authentication & 35 dashboards | ✅ All accessible, role-based landing working (35 = 33 + `/intake` + `/external-audits` shipped in v4.5) |
| Migration Templates | ✅ 9 templates total (CAPA, Nonconformity, Training, Audit Findings, Deal Evaluations + original 4: Risks, Vendors, Policies, Calls) — AI column-mapper + duplicate pre-check |
| Page-view telemetry | ✅ Recording (8 events captured this week) |

---

## 5 · Non-data asks (admin actions)

| # | Ask | Owner | Effort |
|---|---|---|---|
| A1 | Grant Slack `files:write` scope to the WalaPlus bot so infographic shares upload as PNG instead of falling back to a link message | Slack workspace admin | 5 min — toggle in Slack admin → reinstall app |

---

## 6 · Suggested data-upload sequence (for tomorrow's discussion) — *v4.5 reordered*

If we can only do one batch a week, suggested order. v4.5 priorities (Programme, External Audits, Manual Intake) are interleaved with the original gaps based on ISO impact.

1. **Week 1** — **Annual Audit Programme 2026** (one record + planned audits) → unblocks the entire internal audit cycle and routes through HITL sign-off (`head_of_operations_quality`). Pair with **Risks** import.
2. **Week 2** — **Real audit findings + evidence** for the 5 existing audits (use the new "Audit Findings" migration template; closes the loop on what's already in the system).
3. **Week 3** — **Real NC + CAPA log** replacing test data (use the new "Nonconformity" + "CAPA" migration templates).
4. **Week 4** — **External Audits 2026 calendar + active certificates** (seed `external_audits` and `external_audit_certificates`; populates the GRC hero card).
5. **Week 5** — **Compliance assessments + calendar** (regulatory deadlines per regulation).
6. **Week 6** — **Vendor risk + team performance + Training Records** (use the new "Training Records" migration template).
7. **Ongoing** — Either connect call data feed (Zoho/3CX) or bulk-upload monthly. Funnel any off-platform audit reports through `/intake`.

---

## 7 · Migration templates available (9 in v4.5)

The Migration Engine (under **Admin & Tools** in v4.5) ships with the following templates. Each includes an AI column-mapper and duplicate pre-check.

| # | Template | Target table | Status | Notes |
|---|---|---|---|---|
| 1 | Risks | `enterprise_risks` | Original | Excel/CSV with title, owner, likelihood, impact, category, treatment |
| 2 | Vendors | `vendors` | Original | Vendor master list |
| 3 | Policies / Controlled Docs | `policies` | Original | Doc number, title, version, owner, content |
| 4 | Calls | `call_records` | Original | Bulk telephony export |
| 5 | **CAPA Register** | `capa_records` | **New v4.5** | Linked NC, action, owner, due date, status, root cause |
| 6 | **Nonconformity Log** | `nonconformance_records` | **New v4.5** | Source, severity, type, description, status |
| 7 | **Training Records** | `training_records` | **New v4.5** | Course, attendee, completion date, assessment score |
| 8 | **Audit Findings** | `grc_audit_findings` | **New v4.5** | Audit, severity, clause, finding, evidence link |
| 9 | **Deal Evaluations** | `deal_evaluations` | **New v4.5** | Deal ID, framework, dimension scores, overall |

---

## 7.A · CRM Owner Roster — what's wired, what's still a gap (v4.5.1)

The CRM Owner Data Quality widget on `/` finally renders real Department + Activity badges. Source of truth is `src/data/seedUsers.ts`, loaded from `CRM_Users_Complete_117_Updated.xlsx` (snapshot **2026-04-18**) — 117 owners across 11 departments.

**Resolved:**
- Activity badge no longer shows `Unknown` — now resolves to `Active` (64) or `Inactive` (53).
- Department badge no longer falls back to `SDR` or `Sales` — now reflects the real team (`WP Sales`, `MP`, `WO Sales`, `CS`, `SDR`, `MGMT`, `CRM Admin`, `BD`, `Eitmad`, `WPE`).
- Live Zoho Users API (`fetchZohoUsers`) bridges Zoho User IDs to seed names; new hires not yet on the seed still appear (with their Zoho profile as the team).

**Remaining gap — 7 unassigned owners** (no team in the CRM):

| # | Owner | Status | Records | Modules with records |
|---|---|---|---|---|
| 1 | Abdalrzaq Alshamari | Inactive | 30 | Contacts, Accounts |
| 2 | Ahmed Alhusaynan | Inactive | 2 | Contacts, Accounts |
| 3 | Faisal Alaskar | Inactive | 2 | Contacts, Accounts |
| 4 | Mansoor Kadir | Inactive | 14 | Contacts, Accounts |
| 5 | Mohammed Ridha | Inactive | 3 | Contacts, Accounts |
| 6 | Noura AlMuneef | Inactive | 15 | Accounts |
| 7 | عبدالمجيد الشبيلي | Inactive | 193 | Contacts, Accounts |

**Action required (CRM Admin, ≤5 working days):** assign a Department in Zoho for each, OR mark them as system/test accounts and exclude them from the seed re-import. The 193 records under `عبدالمجيد الشبيلي` are the most material.

**Refresh procedure:** when owners join/leave/move teams → re-export `CRM_Users_Complete_*.xlsx` from Zoho → drop into the importer → bump snapshot date in `docs/WalaPlus_Platform_SOP.md §11.1` and §25 changelog.

**Two operational asks discovered during the v4.5.1 smoke test (CRM Admin):**

1. **Add the `ZohoCRM.users.READ` scope to the platform OAuth app.** The first end-to-end run of `getUsers()` against live Zoho returned `401` on `GET /crm/v2/users` (after a successful access-token refresh and successful `/crm/v2/Deals` calls in the same request). This means the refresh token has CRUD scopes for record modules (Leads/Deals/Contacts/Accounts) but is missing the `ZohoCRM.users.READ` scope. Until that's granted, the platform falls back to seed-only mode (which works, but loses the new-hire safety net) and ~21 record owners that exist in CRM but aren't on the seed render with `Unknown` activity.

2. **~21 "ghost" owners on records but not on the seed.** During the smoke test the API returned 128 distinct owners; only 107 matched the seed by name. The other 21 (e.g. `Mohammed Alhumoudi`, `Khalid AlHumaidan`-style names) own real records but were not on the `CRM_Users_Complete_117_Updated.xlsx` export. CRM Admin should diff the next export against the live record-owner set and reconcile. Most of these are likely former employees whose records still carry their Zoho User ID; if so, the cleanest fix is a Zoho-side reassignment to a current team member or to a "Former Employee" service account that we then add to the seed.

---

## 8 · Questions to confirm with the manager

1. Do we have an existing risk register Excel we can import directly?
2. Where is the master vendor list maintained today?
3. For calls — do we want the live integration (Zoho/3CX) or quarterly CSV uploads?
4. Are there real NCs/CAPAs from the past year, or is this a greenfield log?
5. Who is the owner for compliance assessments per regulation (PDPL, ISO 9001, etc.)?
6. Confirm: are there any data incidents to log, or is `data_incidents` legitimately zero?
7. **Annual Audit Programme 2026 — who drafts and who signs off?** The platform expects a Quality Manager to draft and the **Head of Operations & Quality** to sign off (HITL). Need both names confirmed.
8. **Do we have the 2026 external audit calendar?** Scheduled certification / surveillance / regulatory / customer audits with body (BSI/DNV/SGS/TÜV), standard, planned date.
9. **Active certificate inventory** — issuing body, standard, valid_from, valid_to, renewal owner. Anything expiring in the next 90 days?
10. **Off-platform audit reports backlog** — HR supplier audits, KPMG assessments, vendor audit PDFs ready to upload via `/intake`? GPT-4o extraction is live and needs a first real batch to validate.

---

*Generated automatically from a deep platform inspection — counts verified against live database.*
