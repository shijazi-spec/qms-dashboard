# ExampleOrg Platform Roadmap

---
Version: 1.0
Last updated: 2026-05-02
Status: Draft
Owner: Product / Platform team
Source audit: `docs/PLATFORM_AUDIT.md`
---

## Strategic Theme — This Quarter

> **Make the existing surfaces real.**
> The next 6–8 weeks pivot from new-surface construction to closing the
> data and lifecycle gaps the audit surfaced. Every committed item below
> traces back to a P0 / P1 risk in `PLATFORM_AUDIT.md`.

### OKR alignment

- **O1**: Every regulation tab a customer clicks shows real clauses + the
  ability to attach evidence within 30 seconds.
- **O2**: Every dashboard page either shows real data or a credible
  starter-data import flow on first login.
- **O3**: Every alert and health signal in the platform is acted on within
  one business day or auto-closed.

---

## RICE Backlog — Top 16 Items (sorted by RICE score, descending)

Reach scaled to "% of platform users / customers affected per quarter".
Impact: 3 = massive · 2 = high · 1 = medium · 0.5 = low.
Confidence: 100 % = data-backed (evidence in audit) · 80 % = strong intuition.
Effort: person-weeks (PM + design + eng + QA combined).
Score = (R × I × C) / E. Higher = do first.

| Rank | # | Initiative | Reach | Impact | Conf. | Effort (pw) | RICE | Audit ref |
|---|---|---|---|---|---|---|---|---|
| 1 | 8  | Verify health-pulse cron + add "stale > 24 h" red banner on /health | 100 | 2 | 100 % | 0.5 | **400** | P1 §2.5 |
| 1 | 16 | Update `HostingPlatform.md` to reflect current state (8 regulations, 4 agents, mapping table, RBAC cookie fix) | 100 | 1 | 100 % | 0.25 | **400** | P2 §2.10 |
| 3 | 1  | Re-grant real roles to 35 SSO users (or ship users-admin UI) | 100 | 3 | 100 % | 1 | **300** | P0 §2.1 |
| 3 | 9  | Pre-install Playwright in workflow env so i18n + sweep gates run | 100 | 1.5 | 100 % | 0.5 | **300** | P2 §2.9 |
| 5 | 5  | Stale-alert sweep cron (auto-close low-sev `sla_breach` > 30 d) | 100 | 2 | 100 % | 1 | **200** | P1 §2.4 |
| 5 | 6  | Bulk-acknowledge UI for existing 1,728 open alerts | 100 | 2 | 100 % | 1 | **200** | P1 §2.4 |
| 7 | 10 | Production-agent telemetry verification (1 end-to-end trace) | 80 | 2.5 | 80 % | 1 | **160** | P1 §2.7 |
| 8 | 2  | Seed ISO-27001 obligations (Phase 1 — 30 highest-leverage controls) | 100 | 3 | 100 % | 2 | **150** | P0 §2.2 |
| 8 | 3  | Seed ISO-9001 obligations (Phase 1 — clauses 4–10) | 100 | 3 | 100 % | 2 | **150** | P0 §2.2 |
| 10 | 4  | Bulk-assign policy owners by department + Approve workflow | 100 | 2.5 | 100 % | 2 | **125** | P0 §2.3 |
| 11 | 7  | Seed NCA-ECC obligations (KSA mandate, Phase 1 — 20 controls) | 80 | 3 | 100 % | 2 | **120** | P0 §2.2 |
| 12 | 11 | Duplicates Radar: bulk-resolve 100 %-confidence clusters | 60 | 2 | 100 % | 2 | **60** | P2 §2.11 |
| 13 | 12 | CSV bootstrap importer for vendors + risks + KPIs | 80 | 2.5 | 80 % | 4 | **40** | P1 §2.6 |
| 13 | 14 | Seed NCA-DCC Phase 1 | 40 | 2.5 | 80 % | 2 | **40** | P0 §2.2 |
| 15 | 13 | Seed PCI-DSS Phase 1 (only if a customer needs it — gated) | 30 | 3 | 80 % | 2 | **36** | P0 §2.2 |
| 16 | 15 | COPC seed (Phase 1) | 30 | 2 | 60 % | 2 | **18** | P0 §2.2 |

> Items 8 + 16 (RICE 400) and 9 (RICE 300) are quick wins — ship them in a
> single sweep at sprint start before touching the larger items. Item # is
> a stable identifier referenced from the Now/Next/Later section below.

---

## Job Stories (the work expressed as outcomes)

Job stories follow the format **When _ , I want to _ , so I can _**.

> **JS-1 — GRC Manager seeds a regulation.**
> When I open the Compliance dashboard and click an empty regulation tab,
> I want to see real clauses with the ability to attach evidence in under 30
> seconds, so I can show an auditor real coverage instead of an empty page.
> *Maps to RICE #2, #3, #7, #13, #14, #15.*

> **JS-2 — Quality Manager logs a nonconformity from SSO.**
> When I sign in via CRMProvider SSO and try to file a new NC from the Quality
> dashboard, I want the form to actually submit, so I don't have to ask the
> admin for the API key just to record routine quality issues.
> *Maps to RICE #1.*

> **JS-3 — AI Specialist reviews real spend.**
> When I open the AI Ops cost-trend page on a Monday morning, I want to see
> the past week's real production agent costs broken down by tool, so I can
> spot runaway prompts before finance flags them.
> *Maps to RICE #10.*

> **JS-4 — Compliance Officer triages alerts.**
> When I open the alerts panel and see thousands of open SLA-breach items,
> I want to bulk-acknowledge or auto-resolve the stale ones, so the inbox
> reflects only what actually needs my attention today.
> *Maps to RICE #5, #6.*

> **JS-5 — Customer's first-day admin imports their data.**
> When I sign up and find every operational table empty, I want a CSV
> importer for vendors / risks / KPIs, so my dashboards aren't all
> empty-state on day one and I see immediate value.
> *Maps to RICE #12.*

---

## Now / Next / Later

### Theme — *Make the existing surfaces real*
### Goal/OKR link — O1 + O2 + O3

### Now (committed, in flight) — numbered to match Acceptance Criteria below

| # | Initiative | Owner | Goal/OKR | Success metric | Status |
|---|---|---|---|---|---|
| 1 | Restore real roles to 35 platform users | GRC manager + Eng | O2 | 0 SSO users on `department_viewer` (excluding intentional viewers) | Ready to start |
| 2 | ISO-27001 Phase 1 seed (30 controls) | GRC manager + AI specialist | O1 | `obligations` count for ISO-27001 ≥ 30 | Ready to start |
| 3 | ISO-9001 Phase 1 seed (clauses 4–10) | Quality manager + AI specialist | O1 | `obligations` count for ISO-9001 ≥ 25 | Ready to start |
| 4 | Stale-alert auto-close cron | Eng | O3 | Open `sla_breach` alerts < 200 within 7 d | Ready to start |
| 5 | Bulk-acknowledge UI on /ai-ops | Eng | O3 | One-click clears N selected alerts | Ready to start |
| 6 | Health-pulse cron audit + stale banner | Eng | O3 | `health_pulse_runs` row in last 24 h on every prod boot | Ready to start |
| 7 | Playwright pre-install in workflows | Eng (infra) | — | i18n + sweep workflows finish in < 3 min | Quick win |
| 8 | Update `HostingPlatform.md` with current state | PM | — | HostingPlatform.md mentions 8 regs, 4 prod agents, mapping table | Quick win |

### Next (committed, not started — ordered)

| Initiative | Why now | Goal/OKR | Dependency |
|---|---|---|---|
| Bulk-assign policy owners + Approve workflow | Unlocks P0 §2.3 risk; auditor-facing | O2 | Item 1 (real roles) |
| NCA-ECC Phase 1 seed | Mandatory in KSA — every Saudi customer asks | O1 | Item 2 pattern reusable |
| Production-agent telemetry verification | Unblocks AI cost reporting | O3 | Item 1 (real users to trigger flows) |
| CSV bootstrap importer (vendors + risks + KPIs) | Empty tables → empty pages — give customers a first-day story | O2 | None |
| Duplicates Radar bulk-resolve UI | 21k clusters is unworkable manually | O2 | None |

### Later (directional, not committed — bullets only)

- NCA-DCC Phase 1 seed
- PCI-DSS Phase 1 seed (gated on real customer demand)
- COPC Phase 1 seed
- Management Review workflow activation (`management_reviews` table)
- Vendor risk module activation (`vendors`, `vendor_assessments`)
- Training course catalog + assignments (currently 0 / 0 / 0 rows)
- ROI dashboards real wiring (8 empty `roi_*` tables)
- Tablef KPI snapshots activation (5 empty `tablef_*` tables)
- External audits + certificates lifecycle (`external_audits`, `external_audit_certificates`)
- Evidence-pack export (PDF bundle of obligation + linked docs)
- Compliance calendar reminders (`compliance_calendar`, currently empty)
- Customer-facing "first day" guided onboarding tour (`onboarding_tour_steps` already has 6 rows — wire it up)

---

## Non-Goals (this quarter)

Explicit list — protects against scope creep:

- **No new dashboard pages.** 40 is enough; activate what's there first.
- **No new AI agents.** 4 production agents cover QMS, Quality, Sales, SDR.
- **No new regulation beyond the 8 already seeded** (PDPL, SAMA-CSF +
  6 currently empty). Unless a paying customer signs and requires it.
- **No platform-wide UI redesign.** The recent sidebar / page-title pass
  was sufficient.
- **No mobile / native app.** Mobile-friendly responsive dashboard only.
- **No third-party integrations beyond the existing set** (CRMProvider CRM, Inngest,
  ChatProvider, email, HostingPlatform OIDC, LLMProvider). Don't add Jira / ServiceNow / etc.
- **No replacement of Postgres, Hono, Mastra, or the storage layer.**

---

## Open Questions (must resolve before "Now" items lock)

1. **Role grant**: re-run the historical migration that was supposed to fire
   in commit `4c24ddb`, or build a per-user role-edit UI on
   `/dashboard/users.html`? (Recommend: ship the UI; migrations are
   auditor-unfriendly.)
2. **ISO-27001 seed source**: do we have a licensed copy of the standard text
   we can paraphrase, or do we cite the public Annex A control titles only?
3. **Alert sensitivity**: is the 1,646 medium SLA-breach count a true positive
   (real SLA misses) or a threshold-too-tight false positive?
4. **Production agent traffic**: are the 4 production agents being invoked
   anywhere? If not, what's blocking their first real-customer use?
5. **Empty-tables UX**: when a customer logs in and a page is empty, do we
   show a "Get Started" import-from-CSV CTA, sample data, or a contact-us
   modal?

---

## Acceptance Criteria — every "Now" item

```gherkin
# Item 1 — Restore real roles to SSO users
Given a platform user logged in via HostingPlatform OIDC who is a known admin in our records
When that user navigates to /dashboard/audits.html and clicks "New Audit"
Then the form submits successfully
And no 401/403 appears in the browser console
And the platform_users row for that user shows role != 'department_viewer'

# Item 2 — ISO-27001 Phase 1 seed
Given a fresh /dashboard/compliance.html load
When the user clicks the ISO-27001 tab
Then the "Clauses & Document Mapping" section becomes visible
And at least 30 clause cards render
And each card has a working "Manage Docs" button
And the seed is idempotent (a second app boot does not duplicate rows)

# Item 3 — ISO-9001 Phase 1 seed (clauses 4–10)
Given a fresh /dashboard/compliance.html load
When the user clicks the ISO-9001 tab
Then at least 25 clause cards render covering clauses 4 through 10
And each card displays its clause number and title
And the seed is idempotent

# Item 4 — Stale-alert auto-close cron
Given an LLMProvider_alert with severity='medium' and created_at older than 30 days
When the daily auto-close cron runs
Then that alert moves to status='resolved'
And resolution_note starts with "auto-resolved (stale)"
And the action is recorded in audit_trail
And no high-severity alert is auto-closed

# Item 5 — Bulk-acknowledge UI on /ai-ops
Given the AI Ops alerts panel with one or more open alerts
When the user selects multiple rows and clicks "Acknowledge selected"
Then every selected alert moves to status='acknowledged'
And a single audit_trail row is written summarising the bulk action
And the panel re-renders without a full page reload

# Item 6 — Health-pulse cron + stale banner
Given the most recent health_pulse_runs row is older than 24 hours
When a user opens /dashboard/health.html
Then a red banner reads "Health pulse has not run in N hours — investigate"
And the rest of the page still renders
And on every prod boot a new health_pulse_runs row appears within 1 hour

# Item 7 — Playwright pre-install in workflows
Given a clean container start
When the i18n or post-restore-sweep-panel workflow runs
Then it completes in under 3 minutes
And it does not display the "Ok to proceed?" prompt
And the workflow exits 0 on a passing run

# Item 8 — HostingPlatform.md reflects current state
Given a reader of HostingPlatform.md who has never used the platform
When they finish reading the doc
Then they know: 8 regulations are seeded, 4 production agents exist,
     obligation_documents is the clause-evidence link table,
     and admin_key is accepted via header OR cookie
And the doc passes a manual cross-check against PLATFORM_AUDIT.md §1
```

---

## Effort Summary

If we commit to all eight "Now" items the rough total is ~10 person-weeks
of work (1 PM + 1 GRC manager + 1 quality manager + 2 eng for ~2 weeks each).
That assumes the existing seed pattern from PDPL / SAMA-CSF is reusable,
which a code scan of `src/utils/complianceDatabase.ts` confirms.

---

### Changelog

| Version | Date | Author | Change summary |
|---|---|---|---|
| 1.0 | 2026-05-02 | HostingPlatform Agent | Initial roadmap derived from `PLATFORM_AUDIT.md` v1.0 |
| 1.1 | 2026-05-02 | HostingPlatform Agent | Re-sorted RICE backlog by score (descending) and added explicit Rank column; added 5 job stories tied back to RICE items; expanded Acceptance Criteria from 5 to all 8 "Now" items; numbered "Now" rows to match acceptance criteria |
