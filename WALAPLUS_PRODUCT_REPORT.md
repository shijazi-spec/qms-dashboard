# WalaPlus Enterprise GRC & Quality Platform
## Product Status Report — Week of 18 April 2026

---

| | |
|---|---|
| **Prepared for** | Manager — Direct Report |
| **Prepared by** | Product & Engineering |
| **Reporting period** | Week of 14–18 Apr 2026 |
| **Document version** | 1.0 |
| **Status** | For review |

---

## 1. Executive Summary

The WalaPlus platform is **operationally healthy and shipping at a steady weekly cadence.** All 33 dashboards are live, the AI Consultant + 23 tools are running with the human-in-the-loop approval gate enforced, and the weekly Quality Audit job is on its new Monday 09:00 Riyadh schedule.

**Three things to know this week:**

1. **The Infographic Generator is shipped end-to-end** — CCO/CEO can pick any of 6 sections, get a polished SVG/PNG of live platform data, and share to Slack or Email in one click. PNG output is print-ready (1200×1500, ~700 KB–1 MB).

2. **A product-level audit identified a gap between what the platform *does* and what users *use*.** 33 dashboards exist; only ~5 modules show real data activity. The remediation plan is small, fast, and started this week (4 of 7 quick wins shipped — see §3).

3. **One small operational ask for the manager**: the Slack bot needs the `files:write` permission added (5-minute admin task at api.slack.com/apps). Until then, Slack sharing falls back gracefully to a styled text message rather than a PNG attachment — no user-visible breakage. Details in §6.

---

## 2. What shipped this week

### 2.1 Infographic Generator (new feature, fully delivered)
- **6 shareable sections**: Platform Health, KPIs, Risks, Audits, Compliance, Quality Audits.
- **Two output formats**: SVG (10–13 KB, web-perfect) and PNG (1200×1500, presentation-perfect).
- **Two share channels**: Slack (with graceful fallback when scopes are missing) and Email (Resend with PNG attachment, up to 20 recipients).
- **Validation**: covers missing fields, invalid emails, unknown sections, and recipient cap. All tested.

### 2.2 Quality Audit moved to a weekly cadence
Previous schedule: every 6 hours (excessive, generated noise).
**New schedule: Monday 09:00 Riyadh time, weekly** — aligned with how the team actually consumes the report. Configurable via `QUALITY_AUDIT_CRON` env var.

### 2.3 Audits dashboard data fix
The "Latest Audit" card was querying a column that doesn't exist (`audit_date`), causing a misleading display. Now correctly resolves the most recent **completed** audit; fallback to the most recent past **scheduled** audit if none completed. Currently shows: *Production Floor Internal Audit (2026-01-29)* — correct.

### 2.4 Risk Management — actionable empty state
The Risk Register is currently empty (0 enterprise risks logged). Instead of showing misleading zeros that look like a healthy state, the platform now displays a clear "**No Risks Logged Yet**" hero, plus a panel of 8 capability cards confirming everything is *ready* (categories ✓, heat-map ✓, AI scanner ✓, treatment flow ✓, PDPL ✓, owner assignment ✓), and an explicit call-to-action: "Open /risks → Add Risk."

### 2.5 Four product quick-wins (shipped this session)
| # | Change | Why it matters |
|---|---|---|
| 1 | Renamed `Audit Reports` → **Quality Audits (AI)** with an "AI" badge, and renamed `Audits` → **ISO Internal Audits** | Eliminated the long-standing naming collision between two different audit modules |
| 2 | Executives (CEO, CCO, CFO, board, executive roles) now land directly on `/executive` instead of the generic dashboard | Cuts the time-to-first-insight for senior users from clicks-and-search to instant |
| 3 | **Page-view telemetry** wired into every dashboard load via `access_audit_log` | We will finally have data on which dashboards are actually used — basis for the next prioritization conversation |
| 4 | Slack share now shows a friendly in-app banner explaining how to enable PNG attachments when the scope is missing | Removes a silent confusing failure mode |

---

## 3. State of the product — a candid read

### 3.1 What's working
- **Architecture is solid**: Mastra + Hono + PostgreSQL + Inngest, no error backlog, no deployment regressions.
- **Three modules are doing real work** at scale:
  - **Duplicate Radar** — 22,271 duplicate clusters detected across the CRM
  - **Quality Audits (AI)** — 26 weekly audits run on ~180,000 records
  - **AI Alerts** — 260 alerts surfaced across 14 monitoring checks
- **Policy library is well-populated**: 147 controlled documents under change control.
- **Security posture is strong**: Replit OIDC, signed sessions, RBAC with 11 roles, tiered rate limiting, CSP nonces, input sanitization.

### 3.2 Where the gap is
The platform exposes **33 dashboards across 6 navigation categories**, but the database tells us only ~5 are seeing real activity. The rest are *capability without consumption*. A few examples:

| Module | DB rows | Read |
|---|---|---|
| Enterprise Risks | 0 | Engine and UI ready, no risks logged yet |
| Audit Findings | 0 | No findings recorded against any audit |
| KPI Values | 6 (vs. 35 KPI definitions) | Calculator works; most KPIs lack input bindings |
| AI Pending Actions | 0 | The HITL approval gate has never been exercised on a real action |

This isn't a bug — it's a **product-adoption challenge**. We have built considerably more capability than the team is yet using.

### 3.3 The biggest unknown until this week
We had no idea which dashboards users actually opened. Starting this week we do (telemetry now flowing into `access_audit_log`). In two weeks I will be able to give you a real usage heatmap and recommend which dashboards to prune, merge, or invest in.

---

## 4. Prioritized backlog (next 4 weeks)

Scored using RICE (Reach × Impact × Confidence ÷ Effort). Top items are deliberately small.

| # | Initiative | Effort | Status |
|---|---|---|---|
| **In flight (this sprint)** | | | |
| 1 | In-app Slack-scope guidance banner | XS | ✅ Shipped |
| 2 | Disambiguate Quality Audits vs. ISO Internal Audits | XS | ✅ Shipped |
| 3 | Default `/executive` landing for CCO/CEO/CFO/board roles | XS | ✅ Shipped |
| 4 | Page-view telemetry wired to `access_audit_log` | S | ✅ Shipped |
| **Next 2 weeks** | | | |
| 5 | Empty-state coaching on Risks, Findings, KPI input pages (replicate the new Risk infographic pattern to the working pages) | S | Planned |
| 6 | First read-out of usage telemetry — which dashboards to keep, prune, or merge | S | Pending 14 days of data |
| 7 | KPI input-binding UI: per-KPI "where does this data come from?" form | M | Planned |
| **Later** | | | |
| 8 | First-run wizard ("Set up your QMS in 5 steps") | M | Directional |
| 9 | AI Consultant prominence on home page (3 suggested questions) | S | Directional |
| 10 | Public "What's new" changelog | S | Directional |

**Non-goals (explicitly *not* doing):** more new dashboards, mobile app, expansion beyond Saudi PDPL/ISO 9001 frameworks, more AI tools on the consultant. The platform's depth, not its breadth, is now the limiting factor.

---

## 5. Operational health metrics

| Metric | Value |
|---|---|
| Dashboards live | 33 |
| Database tables | 103+ |
| Quality Audits run (lifetime) | 26 |
| AI alerts surfaced | 260 |
| Policies under control | 147 |
| Duplicate clusters detected | 22,271 |
| AI Consultant tools available | 23 |
| Background scanner checks | 14 |
| Critical errors this week | 0 |
| Workflow restarts (planned) | 4 |
| Workflow restarts (unplanned) | 0 |

---

## 6. Asks of the manager

Two small items, neither blocking:

### 6.1 Slack `files:write` permission (5-minute admin task)
**What**: Add the `files:write` scope to our Slack bot at api.slack.com/apps → OAuth & Permissions → Reinstall.
**Why**: Today, sharing an infographic to Slack works, but posts as a styled text message rather than a PNG attachment. The fallback is graceful and users see clear in-app guidance, but the full visual experience requires this scope.
**Risk**: None. Read-only on the Slack side; only allows our bot to upload files to channels it has been added to.

### 6.2 30-minute review next week
Once 7 days of telemetry have accumulated, I would like 30 minutes to walk through **which dashboards are actually used vs. which are not**, and agree on whether to prune, merge, or invest in the long tail. This is the single highest-leverage product conversation we can have right now.

---

## 7. Risks & watch-items

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Empty Risk Register and 0 Audit Findings make compliance reporting incomplete | Medium | Medium | Empty-state coaching shipped; first-run wizard planned. Consider a brief team workshop to seed the register. |
| Long tail of unused dashboards inflates maintenance load | Medium | Low | Telemetry now collecting; pruning decision in 2 weeks |
| KPI engine running with mostly-empty inputs gives a false sense of measurement | Low | Medium | Input-binding UI in next sprint |
| Slack scope dependency on external admin action | Low | Low | Graceful fallback in place; no user-visible breakage |

---

## 8. Changelog

| Version | Date | Author | Change summary |
|---|---|---|---|
| 1.0 | 2026-04-18 | Product & Eng | Initial weekly report — covers Infographic Generator launch, Quality Audit cadence change, audits data fix, empty-state UX, and 4 product quick-wins |
| 1.1 | 2026-04-18 | Product & Eng | Appended §9 v4.5 update block (Internal Audits re-architecture, Manual Intake, External Audits, Admin & Tools, +8 DB tables, ~111+ total). |

---

## 9. Update — v4.5 (also shipped this week)

A second wave of work landed late in the same week, materially extending the Quality / GRC surface. Treat this as the **18 April 2026 v4.5 release**.

### 9.1 What shipped (v4.5)

| Stream | Headline |
|---|---|
| **Internal Audits re-architecture** | `/audits` rebuilt as a native **Internal Audits Dashboard** (no iframe). Top-of-page **Annual Audit Programme** panel with HITL sign-off routed through `/ai-approvals`, gated to a new `head_of_operations_quality` role. (Supersedes the v1.0 iframe design.) |
| **Trigger HITL gate** | `/qms` Triggers tab now requires a written ≥10-char dismiss reason; Critical triggers expose **"Propose via HITL"**. New `trigger-auto-escalate` Inngest cron (daily 03:00 UTC) re-activates dismissed triggers and auto-opens `grc_audit_findings` rows for stale Critical@7d / Minor@30d, with bi-directional `escalation_finding_id` linkage. |
| **Manual Audit Intake** | New `/intake` workspace owned by the Quality Manager. GPT-4o structured extraction with paste-fallback; per-finding accept/edit/reject; `Finalize` promotes findings to `grc_audit_findings` with `intake_id` lineage and `source_quote` traceability. |
| **External Audits** | New `/external-audits` page with Calendar/Audits + Certificate Register + Readiness Checklist tabs. Hero summary card on `/grc` (Next / Active Certs / Expiring ≤90d). 5 audit kinds: certification / recertification / surveillance / regulatory / customer. |
| **Admin & Tools dropdown** | Top-nav rename from "Admin" → **Admin & Tools**, consolidating Data Migration Engine (moved from GRC), User & Role Management, Users & Access, AI Approvals Queue, System Logs (moved from Analytics). Role-gated. |
| **Migration Engine** | +5 Quality templates: CAPA Register, Nonconformity Log, Training Records, Audit Findings, Deal Evaluations. AI column-mapper + duplicate pre-check inherited. |
| **Controlled documents** | +7 SOPs/forms seeded (WP-SOP-040 Audit Programme Governance, WP-SOP-041 Manual Intake Control, WP-SOP-042 External Audit Preparation, WP-FORM-055/056/…). |
| **Navigation** | Quality narrowed to 5 items (Dashboard, CRM Data, Internal Audits, Calls, Duplicates Radar); GRC expanded to 8 items (Control Tower, Table F, Risk Mgmt, Integrated QMS, Compliance, External Audits, Vendors, Mgmt Review); "Analytics" renamed **Team Mgmt** (KPIs, Board Dashboard, Team Performance, Mohammed's SOW). |

### 9.2 Backlog item §4 status correction
Backlog item 2 ("Disambiguate Quality Audits vs. ISO Internal Audits") was marked ✅ Shipped earlier this week; v4.5 has now **superseded** that fix with a fuller Internal Audits consolidation (Programme + Dashboard + Intake + External). The earlier rename ("Audits" → "ISO Internal Audits") in §2.5 row 1 is overtaken by the v4.5 rename to **"Internal Audits Dashboard"**.

### 9.3 Updated operational metrics

| Metric | v1.0 value | v4.5 value | Δ |
|---|---|---|---|
| Database tables | 103+ | **111+** | +8 (audit_programmes, audit_programme_audits, manual_audit_intake, manual_audit_findings, external_audits, external_audit_certificates, external_audit_checklist, audit_triggers_decisions) |
| Dashboards live | 33 | **35** | +2 (`/intake`, `/external-audits`) |
| AI Consultant tools | 23 | **23** | unchanged — programme sign-off and trigger decisions are HITL action codes, not consultant tools |
| HITL action codes | n/a | **2 new** | `audit_programme_signoff`, `trigger_decision` |
| Backend LOC delta | — | **~+2,500** | 8 tables, 3 route files, 1 cron, 1 RBAC role |
| RBAC roles | 11 | **12** | +1 (`head_of_operations_quality`) |

### 9.4 Risks & watch-items added by v4.5
- **Programme is empty.** `audit_programmes` has 0 rows. Q1 2026 should be drafted and signed off before the next Mgmt Review.
- **External audit calendar is empty.** `external_audits` has 0 rows. Need the 2026 certification audit calendar to seed.
- **HOQ role unassigned.** `head_of_operations_quality` exists in the role registry but no user is currently assigned. Programme sign-off cannot complete until at least one user holds this role.

---

*This is a living document. Next update: Friday 25 April 2026.*
