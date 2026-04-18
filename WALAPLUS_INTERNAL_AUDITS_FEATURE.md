# Internal Audits — Unified Feature Specification
**Version:** 2.0 · **Effective:** 18 April 2026 · **Status:** Live · **Supersedes:** v1.0 (Apr 2026)

> **One end-to-end audit lifecycle at WalaPlus** — covering the Annual Audit Programme (HITL sign-off), Internal Audits Dashboard, AI Quality Audits, Manual Audit Intake (off-platform reports), and External Audits (certification/regulatory/customer), all wired into a single finding traceability spine.

---

## Document control

| Field | Value |
|---|---|
| Document ID | WP-FEAT-002 |
| Version | 2.0 |
| Predecessor | v1.0 — *iframe-based two-tab merge under `/audits`* (now superseded) |
| Authors | Product & Engineering |
| Approvers | Quality Management Representative, Head of Operations & Quality |
| Linked SOP sections | §4.26 Internal Audits Dashboard, §4.27 Manual Intake, §4.28 External Audits, §4.29 Admin & Tools |

### Why v2.0 supersedes v1.0
v1.0 documented an interim P0 design where `/audits` rendered an iframe of `/qms` as a "Quality Audits (AI)" sub-tab. That iframe was the explicit P0–P1 placeholder. **v4.5 retired that placeholder** and rebuilt `/audits` as a native Internal Audits Dashboard with four first-class surfaces (Programme, Findings, Manual Intake link, External Audits link). The AI Quality Audit module still lives inside `/qms` but is no longer iframed into `/audits`.

---

## 1 · Architecture overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                       INTERNAL AUDITS LIFECYCLE                      │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   ① ANNUAL PROGRAMME              ② DASHBOARD               ③ AI    │
│   /audits (top panel)             /audits                   /qms     │
│   audit_programmes                grc_audit_findings        Quality  │
│   ▶ HITL sign-off via             ▶ Programme panel          Audits  │
│     /ai-approvals                 ▶ Trigger HITL gate        tab     │
│   ▶ head_of_operations_           ▶ Finding traceability     ▶ AI-   │
│     quality role                  ▶ Auto-escalation cron       gen   │
│                                                                NCs   │
│                                                                      │
│   ④ MANUAL INTAKE                 ⑤ EXTERNAL AUDITS                 │
│   /intake                         /external-audits                   │
│   manual_audit_intake             external_audits                    │
│   manual_audit_findings           external_audit_certificates        │
│   ▶ GPT-4o extraction             external_audit_checklist           │
│   ▶ Per-finding accept/edit       ▶ Calendar/Audits tab             │
│   ▶ Finalize → grc_audit_         ▶ Certificate Register             │
│     findings (intake_id           ▶ Readiness Checklist              │
│     lineage)                      ▶ Hero card on /grc               │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                  All findings converge into
                  grc_audit_findings (single
                  spine), feeding NC/CAPA flow
```

**Single source of truth:** Every finding — whether AI-detected, manually intaken from an off-platform report, raised in an internal audit, or recorded after a certification body audit — lands in `grc_audit_findings` with provenance columns (`intake_id`, `external_audit_id`, `escalation_finding_id`).

---

## 2 · Surfaces

### 2.1 Internal Audits Dashboard (`/audits`)
**Native page** (no iframe). Top-to-bottom:

1. **Annual Audit Programme panel** — current-year programme card showing code, status, planned audit count, sign-off state. Actions: *Draft programme*, *Submit for sign-off*, *View HITL queue*. ISO 19011 §5.2 reference inline.
2. **Manual Intake quick-link** — "+ New Manual Intake" jumps to `/intake`.
3. **External Audits quick-link** — opens `/external-audits` summary.
4. **Findings table** — full `grc_audit_findings` grid filtered by audit, with provenance badges (AI / Intake / External / Manual).
5. **Triggers HITL gate** *(shared with `/qms` Triggers tab)* — dismissing requires written reason ≥10 chars; "Propose via HITL" on Critical triggers.

### 2.2 AI Quality Audit tab (`/qms` → Quality Audits)
Unchanged from pre-v4.5: weekly cron, scoring across people / process / governance dimensions, recommendations engine. **No longer iframed under `/audits`** — direct access only via `/qms`.

### 2.3 Manual Audit Intake (`/intake`)
Central single-point intake for off-platform audit reports (HR's supplier audits, KPMG external assessments, vendor audits, etc.). Quality Manager owns the workspace.

- **Upload** — PDF/DOCX/TXT or paste-text fallback for un-parsed binaries.
- **GPT-4o extraction** — structured findings with `source_quote` traceability per finding.
- **Per-finding review** — Accept / Edit / Reject.
- **Finalize** — promotes accepted findings into `grc_audit_findings` with `intake_id` lineage.

### 2.4 External Audits (`/external-audits`)
Three tabs: **Calendar/Audits**, **Certificate Register**, **Readiness Checklist**.

- Audit kinds: certification, recertification, surveillance, regulatory, customer.
- Certificate body field (BSI, DNV, SGS, TÜV…).
- Hero summary card mirrored on `/grc`: Next Audit · Active Certs · Expiring ≤90d.

### 2.5 HITL Approvals queue (`/ai-approvals`)
Centralised queue for any audit-cycle action that requires human sign-off. v4.5 added two action codes:
- `audit_programme_signoff` — only `head_of_operations_quality` can approve (WP-CTL-007).
- `trigger_decision` — Critical-trigger HITL proposal.

---

## 3 · Data model (v4.5)

### New tables (8)
| Table | Purpose |
|---|---|
| `audit_programmes` | Annual programme header, status, sign-off metadata |
| `audit_programme_audits` | Planned audits within a programme |
| `manual_audit_intake` | Intake header (upload metadata, status, intake_code) |
| `manual_audit_findings` | Extracted findings with `source_quote`, accept/edit/reject state |
| `external_audits` | External audit register |
| `external_audit_certificates` | Certificate register with expiry tracking |
| `external_audit_checklist` | Pre-audit readiness checklist items |
| `audit_triggers_decisions` | HITL trigger decisions audit log |

### New columns on existing tables
- `grc_audit_findings.intake_id` (FK → `manual_audit_intake`)
- `grc_audit_findings.external_audit_id` (FK → `external_audits`)
- `grc_audit_findings.escalation_finding_id` (self-FK, links auto-escalated triggers)
- `qms_triggers.dismiss_reason` (text, NOT NULL when status=dismissed)
- `qms_triggers.re_evaluate_at` (timestamp)

---

## 4 · Backend changes (~2,500 LOC additions)

| Area | Files |
|---|---|
| Utils | `auditProgrammeDatabase.ts`, `manualAuditDatabase.ts`, `externalAuditDatabase.ts`, `rbacDatabase.ts`, `rbacMiddleware.ts`, `aiToolGovernance.ts` (new role registered), trigger auto-escalate helper |
| Routes | `auditProgrammeRoutes.ts`, `manualAuditRoutes.ts`, `externalAuditRoutes.ts`, `triggerRoutes.ts` |
| Cron | `trigger-auto-escalate` (Inngest, daily 03:00 UTC) — re-activates dismissed triggers when re-eval window elapses; auto-opens `grc_audit_findings` for stale Critical@7d / Minor@30d pending triggers |
| RBAC | New role `head_of_operations_quality` registered in `platform_users.role` enum, granted via `rbacDatabase.ts` |
| HITL registry | Two new action codes: `audit_programme_signoff`, `trigger_decision` |

**Net delta from v1.0:** ~2,500 LOC added across 8 tables, 3 route files, 1 cron, 1 RBAC role, 2 HITL action codes. (v1.0 claimed "0 backend changes" — no longer accurate.)

---

## 5 · Acceptance criteria (v4.5)

```gherkin
Scenario: Annual Programme requires Head of Operations & Quality sign-off
  Given a draft audit_programme exists for year 2026
  When the Quality Manager submits it for sign-off
  Then a row appears in ai_pending_actions with action_code='audit_programme_signoff'
  And only users with role 'head_of_operations_quality' can approve it
  And the programme.status transitions draft → pending_signoff → signed_off

Scenario: Trigger dismissal requires a written reason
  Given a qms_triggers row with status='active'
  When a user attempts to dismiss it without a reason ≥10 chars
  Then the API returns 400 with error 'dismiss_reason_required'

Scenario: Critical trigger HITL proposal
  Given a qms_triggers row with severity='critical' and status='active'
  When the user clicks 'Propose via HITL'
  Then a row appears in ai_pending_actions with action_code='trigger_decision'

Scenario: Auto-escalation of stale Critical trigger
  Given a qms_triggers row with severity='critical' and status='pending' for ≥7 days
  When the trigger-auto-escalate cron runs
  Then a grc_audit_findings row is auto-created
  And the trigger.escalation_finding_id is set bi-directionally

Scenario: Manual Intake upload extracts structured findings via GPT-4o
  Given a Quality Manager uploads an external audit report PDF to /intake
  When the upload completes
  Then a manual_audit_intake row is created with status='extracting'
  And manual_audit_findings rows are populated with source_quote per finding

Scenario: Finalising an intake promotes accepted findings to the spine
  Given a manual_audit_intake has 5 findings with state ∈ {accepted, edited}
  When the user clicks 'Finalize'
  Then 5 grc_audit_findings rows are inserted with intake_id set

Scenario: External Audit hero card reflects live state
  Given external_audit_certificates contains 3 active certs, 1 expiring in 60 days
  When I load /grc
  Then the External Audits hero card shows Active=3, Expiring=1
  And clicking the card navigates to /external-audits
```

---

## 6 · Test cases

| ID | Description |
|---|---|
| T-IAP-01 | `POST /api/audit-programme` (draft) → 200, returns programme_id |
| T-IAP-02 | `POST /api/audit-programme/:id/submit` → creates HITL ticket |
| T-IAP-03 | Approve as non-HOQ user → 403 |
| T-IAP-04 | Approve as `head_of_operations_quality` → status=signed_off |
| T-TRG-01 | Dismiss trigger without reason → 400 |
| T-TRG-02 | Dismiss with reason <10 chars → 400 |
| T-TRG-03 | Critical trigger HITL proposal → ai_pending_actions row |
| T-TRG-04 | Auto-escalate cron creates finding → bi-directional FK set |
| T-INT-01 | `POST /api/manual-audit-intake` upload → 200, intake_code |
| T-INT-02 | GPT-4o extraction populates manual_audit_findings |
| T-INT-03 | Finalize intake → grc_audit_findings rows with intake_id |
| T-EXT-01 | `GET /api/external-audits/summary` → 200 with next/active/expiring |
| T-EXT-02 | `GET /api/external-audits` filtered by kind → 200 |
| T-EXT-03 | `GET /api/external-audits/certificates` → 200 |
| T-GRC-EXT | `/grc` hero card matches `/external-audits/summary` |

---

## 7 · Migration notes from v1.0

| v1.0 claim | v2.0 reality |
|---|---|
| "Primary URL `/audits` with iframe to `/qms`" | `/audits` is now native; the `/qms` iframe was retired |
| "Two sub-tabs: ISO + Quality Audits (AI)" | `/audits` no longer has tabs; AI surface remains at `/qms` |
| "0 backend changes, ~85 LOC net additions" | ~2,500 LOC added (8 tables, 3 route files, cron, RBAC role) |
| "§8.7 Replace iframe with native merge — high effort" | Done in v4.5; this is the work this v2.0 doc describes |
| Acceptance criteria reference "two-tab iframe" | Replaced by Programme / Trigger HITL / Intake / External criteria above |

---

## 8 · Open items

- Seed the 2026 Annual Audit Programme (currently 0 rows).
- Seed initial `external_audits` rows from the certification calendar.
- Quality Manager training session on the `/intake` workflow.

---

*This document is a living specification. v3.0 will be cut when the next set of audit-cycle features lands (anticipated: deviation tracking, supplier-audit follow-up, ISO 19011 §6 conformance evidence pack auto-assembly).*
