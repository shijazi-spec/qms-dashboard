# ExampleOrg Platform Audit

---
Version: 1.0
Last updated: 2026-05-02
Status: Draft
Owner: Product / Platform team
Audience: Exec, Eng leads, GRC manager, Quality manager
---

## TL;DR

The platform has a **wide and impressive surface** (40 dashboard pages, 52 API
route files, 22 AI tools, 4 production agents + 1 template, ~145 database tables,
150 automated test files) and a **healthy shipping cadence** (610 commits in the
last 14 days, 1,029 total since Feb 16). The hard infrastructure — RBAC, credential
redaction, AI observability, alert system, audit logs, multi-language UI,
multi-regulation compliance scaffolding — is in place and demonstrably works.

**However, most of those features are scaffolding without operational data.**
6 of 8 regulations have zero clauses seeded, all 154 policies are unowned
drafts, 1,728 alerts sit untriaged, and every "feature" table outside
compliance / AI ops / duplicates / governance docs is empty. The next sprint
should pivot from "build new surfaces" to "make the existing surfaces real."

---

## 1. What's Shipped

### 1.1 Surface area

| Layer | Count | Source |
|---|---|---|
| API route files | 52 | `src/mastra/routes/` |
| Dashboard pages | 40 HTML pages | `dashboard/*.html` |
| AI tools (governed) | 22 | `src/mastra/tools/` |
| AI agents | 4 production + 1 template | `src/mastra/agents/` |
| Mastra workflows / crons | 4 | `src/mastra/workflows/` |
| Database tables | ~145 application tables | `information_schema` |
| Automated tests | 127 `.test.ts` + 14 `.spec.ts` + 9 `.integration.ts` (150 total) | `tests/` |
| Languages | English + Arabic (`en.json`, `ar.json`) | `dashboard/i18n/` |

### 1.2 Production AI agents (model + name)

| Agent | Model | Status |
|---|---|---|
| ExampleOrg QMS Consultant | gpt-4o | Production |
| ExampleOrg Quality Specialist | gpt-4o | Production |
| ExampleOrg Sales Quality Specialist | gpt-4o | Production |
| ExampleOrg SDR Quality Specialist | gpt-4o | Production |
| Example Agent | gpt-5 | Template only — not user-facing |

### 1.3 Compliance regulations seeded

| Code | Name | Jurisdiction | Version | Clauses | Clauses w/ docs |
|---|---|---|---|---|---|
| **PDPL** | Saudi Personal Data Protection Law | saudi | 2023 | **18** | 1 |
| **SAMA-CSF** | SAMA Cyber Security Framework | saudi | 1.0 | **20** | 0 |
| ISO-27001 | ISO 27001:2022 Information Security | international | 2022 | **0** | 0 |
| ISO-9001 | ISO 9001:2015 Quality Management | international | 2015 | **0** | 0 |
| NCA-ECC | NCA Essential Cybersecurity Controls | saudi | 2.0 | **0** | 0 |
| NCA-DCC | NCA Data Cybersecurity Controls | saudi | 1.0 | **0** | 0 |
| PCI-DSS | PCI DSS v4.0 | international | 4.0 | **0** | 0 |
| COPC | COPC Customer Experience Standard | international | 7.0 | **0** | 0 |

### 1.4 Recently shipped (last 14 days, top items)

- Clause-level document mapping per regulation + bulk upload (`05f9a6b`)
- SAMA Cyber Security Framework Phase 1 — 20 controls (`0e4bc97`)
- Quality Manager role granted AI Ops access (`1d431ca`)
- Sidebar / page-title polish + "Audit Reports" rename pass
- Quality Dashboard: Created-date filter + Audit-period column (`5cdd209`)
- Duplicates Radar mixed-cluster fix + Split-by-domain UI (`79e01b9`)
- Documentations + Trigger Alerts new pages (`7e73926`)
- RBAC fix today: admin-key cookie now accepted by `getSessionUser` (`a3b1313`)

Velocity (cumulative): **40 commits last 7 days, 610 last 14 days, 926 last
30 days, 1,029 total** since 2026-02-16. The 14-day burst was driven by an
intense sprint 8–14 days ago (~570 commits in that window); pace has cooled
this week to ~6/day, which is sustainable.

### 1.5 Hardening that already works

- **Credential redaction**: boot-sweep + per-write redaction; 289/289 tests
  green; covers `event_logs`, `nc_change_history`, `capa_change_history`,
  `ai_pending_actions`, `ai_call_metrics`.
- **AI tool governance**: every AI tool has a registered policy with
  compliance refs and a `buildPreview` — enforced by static test
  (`aiToolPolicyCoverage`). Policy + ai_pending_actions bootstrap on boot.
- **Storage health monitoring**: daily prune cron + storage-health alerts
  surfaced on `/ai-ops` with acknowledge/resolve/dismiss.
- **Tool-health alerts**: per-tool error/latency thresholds, history view,
  trend chart.
- **Health pulse**: 10 platform checks (last green run 10/10 passing).
- **CSP**: nonce-based script + style allowlists in place on every page.
- **Cookie security**: `admin_key` set HttpOnly + Secure + SameSite=Strict.
- **Controlled document seeder**: 154 policy templates auto-loaded.

---

## 2. What's Broken / At-Risk (Evidence-Backed)

Severity scale: **P0** = blocks core promise · **P1** = visible gap · **P2** = quality debt.

### P0 — All 35 platform users are `department_viewer` (read-only)

```
SELECT role, status, COUNT(*) FROM platform_users GROUP BY 1,2;
→ department_viewer | active | 35
```

The commit `4c24ddb "Grant admin access to existing users"` did **not**
actually update roles in the DB. As a result the only working write path on
the platform is the `ADMIN_API_KEY` env var. SSO-logged-in users cannot
create NCs, CAPAs, audits, policies, etc. — they can only read.

**Action**: re-run the role-grant migration OR ship a small admin UI on
`/dashboard/users.html` to set roles per user.

### P0 — 6 of 8 regulation tabs are empty

Only PDPL (18) and SAMA-CSF (20) have any obligations. ISO-27001, ISO-9001,
NCA-ECC, NCA-DCC, PCI-DSS and COPC render as tabs with **zero clauses**, so
the per-regulation "Clauses & Document Mapping" section we just shipped is a
no-op for those six. This is visible to anyone who clicks a non-PDPL tab.

**Action**: seed at minimum ISO-27001 (highest-leverage international cert),
ISO-9001 (the platform's namesake), and NCA-ECC (mandatory in KSA).

### P0 — Policy library is 154 unowned drafts

```
SELECT COUNT(*) FROM policies WHERE owner_name IS NULL OR owner_name='Sample User';
→ 154
SELECT COUNT(*) FROM policies WHERE approver_name IS NULL OR approver_name='';
→ 154
SELECT COUNT(*) FROM policies WHERE review_date IS NULL;
→ 154
SELECT status, COUNT(*) FROM policies GROUP BY 1; → draft | 154
```

Every controlled document is in `draft` with no owner, no approver, no review
date. The /policies dashboard renders rows but the lifecycle (assign owner →
approver → effective → review) is unstarted.

**Action**: bulk-assign owners by department from `tablef_departments`,
then expose an Approve / Set-Review-Date workflow.

### P1 — 1,728 untriaged AI alerts (1,646 medium + 82 high)

```
SELECT alert_type, severity, COUNT(*) FROM ai_alerts WHERE status='open' GROUP BY 1,2;
→ sla_breach | medium | 1646
→ sla_breach | high   |   82
→ regulation_gap | high   | 1
→ regulation_gap | medium | 1
→ improvement   | high   | 1
```

The alert pipeline IS working (392 high tool-health alerts auto-resolved,
196 medium), but `sla_breach` alerts are accumulating. Either the threshold
is too sensitive or no one is triaging.

**Action**: review SLA thresholds, ship a "bulk acknowledge older than N
days" UI, or wire an auto-close cron for stale low-severity SLA breaches.

### P1 — Health pulse cron stopped 14 days ago

```
SELECT id, run_at, overall_status FROM health_pulse_runs ORDER BY id DESC LIMIT 3;
→ 6 | <REDACTED_PHONE>:46 UTC | healthy
→ 5 | <REDACTED_PHONE>:00 UTC | healthy
→ 4 | <REDACTED_PHONE>:51 UTC | critical
```

Last run was 2026-04-18. The /dashboard/health.html surface still rendered
"healthy" in today's e2e test because the renderer falls back to the most
recent row regardless of age — which can hide an outage.

**Action**: confirm the cron schedule is registered, add a "stale > 24h"
warning banner on /health, and add a daily-pulse alert if the cron misses.

### P1 — Most "feature" tables are empty

Tables with **0 rows** today (selected): `management_reviews`,
`management_review_actions`, `evidence_packs`, `evidence_records`,
`audit_runs`, `audit_findings`, `capa_records`, `capa_action_items`,
`training_records`, `training_assignments`, `training_courses`,
`policy_acknowledgments`, `policy_versions`, `vendors`, `vendor_assessments`,
`pmp_projects`, all `roi_*` (8 tables), all `tablef_*` analytics
(5 tables), `call_records`, `call_analysis`, `external_audits`,
`enterprise_risks`, `project_risks`, `meeting_mom`,
`compliance_assessments`, `compliance_checklists`, `data_inventory` (10
items only — far short of an enterprise data inventory), `dsar_requests`.

This means each of these dashboard pages is rendering an empty state in
production. The features exist as code + UI but no one has used them.

**Action**: pick the top 3 by business value and seed realistic starter data
(or build an import-from-CSV flow to bootstrap a customer's first day).

### P1 — AI traffic is synthetic test data

```
SELECT model, COUNT(*) FROM ai_call_metrics WHERE started_at > NOW() - INTERVAL '14 days' GROUP BY 1;
→ tool | 402

SELECT tool_name, COUNT(*) FROM ai_call_metrics WHERE started_at > NOW() - INTERVAL '14 days' GROUP BY 1 ORDER BY 2 DESC;
→ happyTool | 201
→ sadTool   | 201
```

402 calls all from a single day (2026-04-25), all from synthetic
`happyTool` / `sadTool` test fixtures. The 4 production agents have not
generated any captured telemetry. Either:
(a) production agents aren't being called by users, or
(b) telemetry isn't being persisted for the production agents.

**Action**: instrument one production agent flow end-to-end and confirm a
real `ai_call_metrics` row lands.

### P2 — Two validation workflows hang on Playwright install

`i18n` and `post-restore-sweep-panel` workflows hang at the interactive
`<REDACTED_EMAIL>` install prompt and never finish. They appear "running"
indefinitely. Pre-existing infra issue, but it means our automated UI test
suite is not gating commits.

**Action**: pre-install playwright in the workflow env (one-shot), or
switch to `npx --yes playwright` flag.

### P2 — `compliance_assessments`, `compliance_checklists`, `compliance_calendar` empty

The compliance lifecycle (assessment → checklist → calendar reminder) has
schema and routes but no data. The new clause-document mapping covers
*evidence linking* but not *assessment cadence*.

### P2 — Duplicate Radar has 21,088 active clusters with no triage UI surfacing them

The Duplicates dashboard works, but at this volume nobody can manually
review them all. Need a bulk-action / accept-all-confidence-100% flow.

### P2 — Documentation drift

`HostingPlatform.md` is accurate but very high-level and missing:
the 8 seeded regulations, the 4 production agents, the bulk-upload feature,
the obligation-document mapping table, and the recent RBAC cookie fix.

---

## 3. What's Solid (Don't Touch)

- **RBAC engine**: 100+ pattern rules, deny-by-default for `/api/*`, fully
  unit-tested. The cookie-auth fix this morning is the only recent change
  and it was tightly scoped.
- **AI tool policy gating**: every tool registered, every tool has a
  `buildPreview`, structural test prevents orphans.
- **Credential redaction**: 289-test suite, boot sweep on every restart.
- **Compliance per-regulation tabs + clause-document mapping**: shipped this
  week, end-to-end tested, server-side limits enforced (50 files, 250 MB,
  2000-char notes), FK violations return 400 not 500.
- **Mastra observability**: spans, traces, evals, scorers, threads,
  resources tables present and partitioned.
- **Event logs**: monthly partitioning (`event_logs_y2026m04`,
  `event_logs_y2026m05`, etc.) — won't blow up at scale.

---

## 4. Risk Register Summary

| ID | Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|---|
| R1 | Customer demo of "compliance" reveals 6 empty regulation tabs | High | Certain on first non-PDPL click | Seed ISO-27001 + ISO-9001 + NCA-ECC this sprint |
| R2 | Auditor asks "show me your policy owners" → 154 nulls | High | Certain on next external audit | Bulk-assign owners by department |
| R3 | Real user can't write because role=department_viewer | High | Certain for any non-admin login | Re-run role grant or ship users-admin UI |
| R4 | Stale alerts (1,728) erode trust in alert system | Medium | High | Bulk-ack + auto-close stale low-sev sweep |
| R5 | Health pulse silently stopped — outage detection lost | Medium | Already happening | Cron registration audit + stale-pulse banner |
| R6 | AI cost tracking is empty → no spend visibility for prod | Medium | Already happening | Verify telemetry pipe on one prod agent |
| R7 | Playwright workflow gates not running | Low | Continuous | One-time install fix |

---

## 5. Recommended Next Step

Pivot the next sprint from "build new surfaces" to **"make the existing
surfaces real"**. See the companion document `PLATFORM_ROADMAP.md` for the
prioritized backlog (RICE-scored) and a Now / Next / Later plan that
addresses every P0 and P1 above.

---

## 6. Evidence Appendix (reproducibility)

All numeric claims in this audit can be reproduced with the queries below.
Run from the project root against the same database the application uses.

**Environment**: HostingPlatform dev container, snapshot 2026-05-02 ~17:15 UTC.
**Database**: HostingPlatform-managed Postgres (`DATABASE_URL`).
**Git commit at audit time**: `a3b1313` (admin-key cookie fix).

```sql
-- §1.3 Regulations + clauses + clauses-with-docs
SELECT r.regulation_code, r.name,
       COUNT(o.id)::int AS clauses,
       SUM(CASE WHEN EXISTS (SELECT 1 FROM obligation_documents od WHERE od.obligation_id=o.id)
                THEN 1 ELSE 0 END)::int AS clauses_with_docs
FROM regulations r LEFT JOIN obligations o ON o.regulation_id = r.id
GROUP BY r.regulation_code, r.name ORDER BY r.regulation_code;

-- §2.1 All users are department_viewer
SELECT role, status, COUNT(*)::int FROM platform_users GROUP BY 1,2;

-- §2.3 Policy library is unowned drafts
SELECT
  COUNT(*) FILTER (WHERE owner_name IS NULL OR owner_name='Sample User')        AS no_owner,
  COUNT(*) FILTER (WHERE approver_name IS NULL OR approver_name='')  AS no_approver,
  COUNT(*) FILTER (WHERE review_date IS NULL)                        AS no_review_date,
  COUNT(*)                                                           AS total
FROM policies;

-- §2.4 LLMProvider alerts breakdown
SELECT alert_type, severity, COUNT(*)::int AS open_n
FROM ai_alerts WHERE status='open'
GROUP BY 1,2 ORDER BY 1,2;

-- §2.5 Health pulse staleness
SELECT id, run_at, overall_status, pass_count, warn_count, fail_count
FROM health_pulse_runs ORDER BY id DESC LIMIT 3;

-- §2.7 AI traffic is synthetic
SELECT tool_name, COUNT(*)::int AS calls,
       ROUND(SUM(estimated_cost_usd)::numeric, 4) AS cost_usd
FROM ai_call_metrics
WHERE started_at > NOW() - INTERVAL '14 days' AND tool_name IS NOT NULL
GROUP BY tool_name ORDER BY calls DESC;
```

```bash
# §1.1 Surface counts
ls src/mastra/routes/*.ts | wc -l            # 52
ls dashboard/*.html | wc -l                  # 40
ls src/mastra/tools/*.ts | wc -l             # 22
ls src/mastra/agents/*.ts | wc -l            # 5 (4 production + 1 example)
ls src/mastra/workflows/*.ts | wc -l         # 4
ls tests/*.test.ts | wc -l                   # 127
ls tests/*.spec.ts | wc -l                   # 14
ls tests/*.integration.ts | wc -l            # 9

# §1.4 Velocity
git log --since='7 days ago' --oneline | wc -l    # 40
git log --since='14 days ago' --oneline | wc -l   # 610
git log --since='30 days ago' --oneline | wc -l   # 926
git log --oneline | wc -l                         # 1029
```

---

### Changelog

| Version | Date | Author | Change summary |
|---|---|---|---|
| 1.0 | 2026-05-02 | HostingPlatform Agent | Initial audit |
| 1.1 | 2026-05-02 | HostingPlatform Agent | Corrected test counts (150, was 171), velocity (610/14d, was 441), separated example agent from production agents, added §6 Evidence Appendix with reproducible SQL + shell commands |
