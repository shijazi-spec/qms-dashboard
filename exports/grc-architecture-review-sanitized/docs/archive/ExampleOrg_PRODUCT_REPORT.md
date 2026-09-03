# ExampleOrg Enterprise GRC & Quality Platform
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

The ExampleOrg platform is **operationally healthy and shipping at a steady weekly cadence.** All 33 dashboards are live, the AI Consultant + 23 tools are running with the human-in-the-loop approval gate enforced, and the weekly Quality Audit job is on its new Monday 09:00 Riyadh schedule.

**Three things to know this week:**

1. **The Infographic Generator is shipped end-to-end** — CCO/CEO can pick any of 6 sections, get a polished SVG/PNG of live platform data, and share to ChatProvider or Email in one click. PNG output is print-ready (1200×1500, ~700 KB–1 MB).

2. **A product-level audit identified a gap between what the platform *does* and what users *use*.** 33 dashboards exist; only ~5 modules show real data activity. The remediation plan is small, fast, and started this week (4 of 7 quick wins shipped — see §3).

3. **One small operational ask for the manager**: the ChatProvider bot needs the `files:write` permission added (5-minute admin task at <REDACTED_HOST>/apps). Until then, ChatProvider sharing falls back gracefully to a styled text message rather than a PNG attachment — no user-visible breakage. Details in §6.

---

## 2. What shipped this week

### 2.1 Infographic Generator (new feature, fully delivered)
- **6 shareable sections**: Platform Health, KPIs, Risks, Audits, Compliance, Quality Audits.
- **Two output formats**: SVG (10–13 KB, web-perfect) and PNG (1200×1500, presentation-perfect).
- **Two share channels**: ChatProvider (with graceful fallback when scopes are missing) and Email (EmailProvider with PNG attachment, up to 20 recipients).
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
| 4 | ChatProvider share now shows a friendly in-app banner explaining how to enable PNG attachments when the scope is missing | Removes a silent confusing failure mode |

---

## 3. State of the product — a candid read

### 3.1 What's working
- **Architecture is solid**: Mastra + Hono + PostgreSQL + Inngest, no error backlog, no deployment regressions.
- **Three modules are doing real work** at scale:
  - **Duplicate Radar** — 22,271 duplicate clusters detected across the CRM
  - **Quality Audits (AI)** — 26 weekly audits run on ~180,000 records
  - **AI Alerts** — 260 alerts surfaced across 14 monitoring checks
- **Policy library is well-populated**: 147 controlled documents under change control.
- **Security posture is strong**: HostingPlatform OIDC, signed sessions, RBAC with 11 roles, tiered rate limiting, CSP nonces, input sanitization.

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
| 1 | In-app ChatProvider-scope guidance banner | XS | ✅ Shipped |
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

### 6.1 ChatProvider `files:write` permission (5-minute admin task)
**What**: Add the `files:write` scope to our ChatProvider bot at <REDACTED_HOST>/apps → OAuth & Permissions → Reinstall.
**Why**: Today, sharing an infographic to ChatProvider works, but posts as a styled text message rather than a PNG attachment. The fallback is graceful and users see clear in-app guidance, but the full visual experience requires this scope.
**Risk**: None. Read-only on the ChatProvider side; only allows our bot to upload files to channels it has been added to.

### 6.2 30-minute review next week
Once 7 days of telemetry have accumulated, I would like 30 minutes to walk through **which dashboards are actually used vs. which are not**, and agree on whether to prune, merge, or invest in the long tail. This is the single highest-leverage product conversation we can have right now.

---

## 7. Risks & watch-items

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Empty Risk Register and 0 Audit Findings make compliance reporting incomplete | Medium | Medium | Empty-state coaching shipped; first-run wizard planned. Consider a brief team workshop to seed the register. |
| Long tail of unused dashboards inflates maintenance load | Medium | Low | Telemetry now collecting; pruning decision in 2 weeks |
| KPI engine running with mostly-empty inputs gives a false sense of measurement | Low | Medium | Input-binding UI in next sprint |
| ChatProvider scope dependency on external admin action | Low | Low | Graceful fallback in place; no user-visible breakage |

---

## 8. Changelog

| Version | Date | Author | Change summary |
|---|---|---|---|
| 1.0 | 2026-04-18 | Product & Eng | Initial weekly report — covers Infographic Generator launch, Quality Audit cadence change, audits data fix, empty-state UX, and 4 product quick-wins |
| 1.1 | 2026-04-18 | Product & Eng | Appended §9 v4.5 update block (Internal Audits re-architecture, Manual Intake, External Audits, Admin & Tools, +8 DB tables, ~111+ total). |
| 1.2 | 2026-04-18 | Product & Eng | Appended §10 v4.5.1 hotfix — CRM Owner Roster wired (117-owner seed + CRMProvider Users API merge); closes the long-standing "every owner shows Unknown / falls back to SDR or Sales" defect on the `/` dashboard. |

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
| **Navigation** | Quality narrowed to 5 items (Dashboard, CRM Data, Internal Audits, Calls, Duplicates Radar); GRC expanded to 8 items (Control Tower, Table F, Risk Mgmt, Integrated QMS, Compliance, External Audits, Vendors, Mgmt Review); "Analytics" renamed **Team Mgmt** (KPIs, Board Dashboard, Team Performance, Sample User's SOW). |

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

### 9.5 Backend / frontend LOC delta

| Layer | LOC added | Files added | Files modified |
|---|---|---|---|
| Backend (TS) | ~2,500 | 3 route files + 3 utility files + 1 cron + 1 RBAC role | `src/mastra/index.ts`, `aiToolGovernance.ts`, `qmsTriggerDatabase.ts`, `grcAuditDatabase.ts` |
| Frontend (HTML/JS/CSS) | ~1,400 | `intake.html`, `external-audits.html`, `audits.html` (rewrite), `dashboard/js/navigation.js` (rewrite) | `grc.html` (hero card), `qms.html` (Triggers tab HITL UI), `ai-approvals.html` (2 new action codes) |
| Database | +8 tables | `audit_programmes`, `audit_programme_audits`, `manual_audit_intake`, `manual_audit_findings`, `external_audits`, `external_audit_certificates`, `external_audit_checklist`, `audit_triggers_decisions` | +3 columns on `qms_triggers` (`dismiss_reason`, `re_evaluate_at`, `escalation_finding_id`); +3 FKs on `grc_audit_findings` (`intake_id`, `external_audit_id`, `escalation_finding_id`); +1 enum value on `platform_users.role` |

**Net database scale**: 105 → **113 tables**.

### 9.6 Deployment story
v4.5 deployment was clean except for one regression worth recording for posterity:
- **Mastra agent-count guard fix** — the new code path that registers HITL action codes briefly tripped Mastra's agent-count guard during boot. Resolved by registering the codes inside the existing `aiToolGovernance.ts` initializer rather than at module top-level.
- **Drop-in regression sweep** — when copying the new `src/mastra/index.ts` from the urgent-enhancements package, four public route handlers were silently dropped (`/dashboard/tailwind.css`, `/sop`, `/api/sop`, `/api/sop/download`). Restored in this session by diffing against the previous index. Pattern documented in scratchpad: always diff drop-in `index.ts` files against the prior version before deploying.
- **Tailwind MIME fix** — the restored `/dashboard/tailwind.css` handler had an incorrect `text/plain` content-type from the prior copy; corrected to `text/css`.

### 9.7 Decision log (for the record)

| # | Decision | Rationale |
|---|---|---|
| D-1 | Retire the iframe-based "two-tab `/audits`" design (v1.0 of ExampleOrg_INTERNAL_AUDITS_FEATURE.md) | Iframe was an explicit P0 placeholder; v4.5 was the planned native-rebuild milestone |
| D-2 | New role `head_of_operations_quality` (not "Quality Director") | Matches the org chart name; ISO 19011 §5.2 vests sign-off authority in this role specifically |
| D-3 | Trigger HITL via `ai_pending_actions` (reusing existing queue) instead of a new approval table | Reuses the proven `/ai-approvals` UI, audit log, and reviewer workflow |
| D-4 | `/intake` is its own dashboard, not a tab inside `/audits` | Keeps the intake workspace usable in parallel with reviewing the dashboard; intake is a multi-step workflow that needs full screen real estate |
| D-5 | `/external-audits` is its own dashboard, not a tab inside `/audits` | External audits have a fundamentally different lifecycle (certificate body, certificate registry, calendar) and audience (often viewed by execs without a need to see internal findings) |
| D-6 | Auto-escalation thresholds: Critical @ 7d, Minor @ 30d | Conservative; can be tuned via env after we observe real volumes. Defaults err toward "louder" rather than silent ignore |
| D-7 | "Admin" → **"Admin & Tools"** rename | The dropdown now contains operator tooling beyond just user/role management; the new name better describes what's inside |

### 9.8 P1 roadmap (week of 22 April 2026)

| # | Item | Owner | Effort |
|---|---|---|---|
| P1-1 | Seed Annual Audit Programme 2026 (draft + submit for HITL sign-off) | Quality Manager | 2 h |
| P1-2 | Seed 2026 external audit calendar + active certificate registry | GRC Manager | 4 h |
| P1-3 | Assign `head_of_operations_quality` role to at least one user | Admin | 5 min |
| P1-4 | First-run smoke of `/intake` with a real off-platform PDF | Quality Manager | 30 min |
| P1-5 | Wire trigger-auto-escalate threshold env vars (`TRIGGER_ESCALATE_CRITICAL_DAYS`, `TRIGGER_ESCALATE_MINOR_DAYS`) for tunability | Eng | 1 h |
| P1-6 | Telemetry read-out for the 5 new v4.5 dashboards (`/intake`, `/external-audits`, `/audits` rebuilt, `/qms` Triggers, `/ai-approvals`) | Product | 30 min |

---

## 10. Update — v4.5.1 hotfix (CRM Owner Roster wired)

### 10.1 What broke

The "CRM Owner Data Quality" widget on `/` (and any page calling `GET /api/agents/performance`) was showing every owner with the activity badge as **"Unknown"** and the department badge falling back to **"SDR" / "SDR Representative"** for lead-only owners or **"Sales" / "Account Executive"** for deal-only owners. Root cause: `getUsers()` in `src/data/index.ts` was a `return [];` stub — there was no roster behind the enrichment, so every CRM record's `Owner` ID hit the hard-coded fallback path in the API handler. We had been shipping the wrong department for ~117 active CRM users for an unknown number of weeks.

### 10.2 What shipped

| Stream | Headline |
|---|---|
| **117-owner seed roster** | New `src/data/seedUsers.ts` loaded from the official `CRM_Users_Complete_117_Updated.xlsx` snapshot (2026-04-18). Each entry carries `name`, `team`, `status` (Active/Inactive), `totalRecords`, `modules`. Source of truth for department + activity. |
| **Live CRMProvider Users API bridge** | New `fetchCRMProviderUsers()` in `src/utils/CRMProviderCRM.ts` (`GET /crm/v2/users?type=AllUsers`) — provides CRMProvider User ID ↔ display-name lookup so CRM record `Owner` IDs resolve correctly. |
| **Two-tier merge in `getUsers()`** | Seed wins on team/status/modules. CRMProvider fills in any owner not yet on the seed (covers brand-new hires). If CRMProvider is unreachable, seed is used standalone with synthetic IDs. |
| **API now returns `status`** | `/api/agents/performance` adds the `status` field to every agent so the dashboard activity badge shows "Active" / "Inactive" instead of "Unknown". |
| **Docs aligned** | New SOP §11.1 *Owner Roster*, Feature Book §1.B *CRM Owner Data Quality Widget*, Gaps §7.A *CRM Owner Roster status*. All three include the data-steward refresh procedure. |

### 10.3 Roster snapshot (2026-04-18)

| Department | Active | Inactive | Total |
|---|---|---|---|
| WP Sales | 15 | 22 | 37 |
| MP | 24 | 9 | 33 |
| WO Sales | 7 | 10 | 17 |
| CS | 5 | 2 | 7 |
| SDR | 4 | 3 | 7 |
| MGMT | 4 | 0 | 4 |
| CRM Admin | 2 | 0 | 2 |
| BD | 1 | 0 | 1 |
| Eitmad | 1 | 0 | 1 |
| WPE | 1 | 0 | 1 |
| **Unassigned** | 0 | **7** | **7** |
| **Total** | **64** | **53** | **117** |

### 10.4 Known gap

7 owners (193 records under one of them) have no team in the CRM. They are listed in `ExampleOrg_GAPS_AND_DATA_NEEDS.md §7.A` for CRM Admin to triage within 5 working days.

### 10.5 Code delta

- +118-line seed file (`src/data/seedUsers.ts`, generated)
- +47-line `fetchCRMProviderUsers()` in `src/utils/CRMProviderCRM.ts`
- ~+45 LOC rewrite of `getUsers()` in `src/data/index.ts`
- ~+10 LOC patch to `/api/agents/performance` handler (status propagation + name-fallback resolver)

### 10.6 Manager ask

Confirm by **2026-04-23** that the 7 unassigned owners have either been (a) assigned a team in CRMProvider or (b) flagged as system/test accounts to exclude from the next seed re-import.

---

*This is a living document. Next update: Friday 25 April 2026.*
