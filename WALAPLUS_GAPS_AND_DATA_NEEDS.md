# WalaPlus — Gaps & Data Upload Needs
**As of:** 18 April 2026 · For: Manager review tomorrow · Owner: Platform team

---

## 1 · TL;DR (read this first)

The platform itself is **technically healthy** — 66/66 system tests passing, no errors in logs, all dashboards render. The "not working" feeling is **not a code problem**; it is a **data problem**. Several modules display empty tables / zero metrics because the underlying data has not been entered yet.

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

## 6 · Suggested data-upload sequence (for tomorrow's discussion)

If we can only do one batch a week, suggested order:

1. **Week 1** — Risks + Vendors (highest ISO impact, easiest to source from existing Excel files)
2. **Week 2** — Audit findings + evidence for the 5 existing audits (closes the loop on what's already in the system)
3. **Week 3** — Real NC + CAPA log replacing test data
4. **Week 4** — Compliance assessments + calendar (regulatory deadlines)
5. **Week 5** — Vendor risk + team performance metrics
6. **Ongoing** — Either connect call data feed (Zoho/3CX) or bulk-upload monthly

---

## 7 · Questions to confirm with the manager

1. Do we have an existing risk register Excel we can import directly?
2. Where is the master vendor list maintained today?
3. For calls — do we want the live integration (Zoho/3CX) or quarterly CSV uploads?
4. Are there real NCs/CAPAs from the past year, or is this a greenfield log?
5. Who is the owner for compliance assessments per regulation (PDPL, ISO 9001, etc.)?
6. Confirm: are there any data incidents to log, or is `data_incidents` legitimately zero?
7. **Do we have the 2026 certification audit calendar to seed `external_audits`?** (Need: scheduled certification / surveillance / customer audits with kind, body, standard, planned dates.)
8. **Who will be assigned the `head_of_operations_quality` role?** Annual Audit Programme sign-off cannot complete until at least one user holds this role.
9. **Backlog of off-platform audit reports for `/intake`?** GPT-4o extraction is ready — needs the first batch (HR supplier audits, KPMG assessments, vendor audit PDFs) to validate the workflow.

---

*Generated automatically from a deep platform inspection — counts verified against live database.*
