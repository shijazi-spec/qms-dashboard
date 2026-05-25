# Business Case — Call Evaluation Platform (Phase 1: 7-Week Build)

**Prepared for:** Ahmed Eldaly (CTO), WalaPlus
**Prepared by:** Ahmed Amashah (Operations & Quality HOD)
**Date:** 2026-05-25
**Status:** Awaiting CTO approval to proceed
**Initiative type:** Internal capability build — no external dependencies

---

## Executive Summary

The WalaPlus QMS platform already contains the **scoring engine** for SDR call quality (transcription, COPC v2 scorecard, automatic evaluation, coaching loop, CRM compliance auditing). This Phase 1 build delivers the **manager cockpit** on top of that engine — converting an existing technical capability into a tool the SDR Manager uses to run a weekly review cycle, deliver structured coaching, and verify behaviour change.

The cockpit centres on a single enriched **Overall Dashboard** (the existing Overview tab, expanded) where every weekly review begins. Per-agent insights, coaching plans, talk-time analytics, and critical-issue flags all live there — no separate pages, no email digests, no Slack routing.

**Ask:** approval for ~7 weeks of focused engineering effort. No new vendors, no new infrastructure, no external data sharing.

---

## User Story

> **As Head of Operations & Quality initiatives at WalaPlus,**
>
> we want an AI-powered scorecard backed by a single comprehensive dashboard,
>
> so that we can evaluate every SDR call against defined compliance and quality criteria, providing **standardized scoring, compliance assurance, and structured coaching insights** — and run a full weekly review of every agent in under 30 minutes from one screen, without manual side-by-side listening.

---

## Business Case

### Problems Identified

| # | Today's pain | Operational consequence |
|---|---|---|
| 1 | QA is fully manual — Quality Manager listens to calls side-by-side to verify qualification criteria | Time-consuming; doesn't scale beyond a few dozen calls per week |
| 2 | No standardized per-call scoring | Feedback is ad-hoc and subjective; two reviewers give two different scores for the same call |
| 3 | Limited visibility for stakeholders | Recording access is restricted; only one team member can review at a time |
| 4 | No single dashboard the SDR Manager can run a weekly review from | Coaching is reactive, not proactive; managers don't have time to navigate multiple tabs |
| 5 | Coaching loop is disconnected from data | Plans get delivered, then forgotten — no verification on the next call |
| 6 | No visibility into conversational quality | Talk ratio, silence, interruptions, pace — the leading indicators of SDR performance — are invisible today |

### Proposed Solution

A complete in-house Call Evaluation pipeline structured in six layers, each built on top of what already exists in `qms-dashboard.replit.app/calls`:

#### Layer 1 — Ingestion & Storage

| Capability | Status |
|---|---|
| Call recordings ingested from the SDR flow (filename-based upload today; live webhook in a later phase) | ✅ Shipped |
| Audio bytes persisted in Postgres so they survive container redeploys | ✅ Shipped |
| Metadata (agent, phone, date, time) parsed automatically from canonical filename format | ✅ Shipped |
| 1-year retention with automatic deletion mechanism | ⚠️ To be configured in Phase 1 |

#### Layer 2 — Transcription (ASR)

| Capability | Status |
|---|---|
| Whisper-1 transcription with Arabic + English language detection (handles code-switching natively) | ✅ Shipped |
| Speaker separation (Agent vs Customer) for talk-time analytics | 🟡 Phase 1 deliverable (Week 5-6) |

#### Layer 3 — Conversation Enrichment

| Capability | Status |
|---|---|
| Sentiment scoring per call (positive / neutral / negative + numeric) | ✅ Shipped |
| Key topic extraction (powers the Topic Clusters panel) | ✅ Shipped |
| Talk-time features: agent ratio, silence, interruptions, pace | 🟡 Phase 1 deliverable (Week 5-6) |

#### Layer 4 — Scorecard & Compliance Engine

| Capability | Status |
|---|---|
| LLM-based rubric scoring against the COPC v2 scorecard (Greeting / Discovery / Objection Handling / Closing / Compliance) | ✅ Shipped |
| Weighted total score with per-attribute rationales | ✅ Shipped |
| Timestamped evidence quotes per attribute | ⚠️ Partial — polished in Phase 1 (Week 7) |

#### Layer 5 — Quality Ops & Calibration

| Capability | Status |
|---|---|
| Manager-review workflow (approve / adjust / disagree with AI score) | ✅ Shipped |
| QA Inbox — sample N random calls per week for review | 🟡 Phase 1 deliverable (Week 6) |
| Cohen's κ tracking — measure AI vs human agreement so the rubric self-tunes | 🟡 Phase 1 deliverable (Week 7) |

#### Layer 6 — The Overall Dashboard (the manager cockpit)

| Capability | Status |
|---|---|
| KPI strip (Total / Analyzed / Avg Sentiment / Avg QA / Compliance Rate) | ✅ Shipped |
| Calls by Source + Calls by Agent charts | ✅ Shipped |
| CRM Compliance Breakdown with coverage diagnostics | ✅ Shipped |
| Topic Clusters panel | ✅ Shipped |
| **Date range filter** (7d / 30d / 90d / custom) | 🟡 Phase 1 deliverable (Week 2-4) |
| **Agent leaderboard** with gap-to-target sort + click-to-expand drill-down | 🟡 Phase 1 deliverable (Week 2-4) |
| **Inline per-agent panel** (trend chart, last 10 calls, active coaching plans, Performance vs Team bars, talk-time stats, topic context) | 🟡 Phase 1 deliverable (Week 2-4 + W5-6 for talk-time) |
| **Critical Issues banner** (calls flagged + plans pending + compliance breach summary) | 🟡 Phase 1 deliverable (Week 2-4) |
| Per-agent CSV export | 🟡 Phase 1 deliverable (Week 2-4) |

### Expected Benefits

| Benefit | Quantified target | Measurement method |
|---|---|---|
| **Efficiency** — manual QA reduction | ≥70% reduction in hours spent on side-by-side listening | Self-reported weekly, comparing pre-launch baseline to Week 7 |
| **Consistency** — eliminate evaluator bias | Same call gets the same score every time; Cohen's κ ≥ 0.6 (AI vs manager) by Week 7 | Auto-computed weekly |
| **Coaching** — actionable skill-gap identification | ≥60% of coaching plans reach "verified passing" or "dismissed with reason" within 30 days | Tracked in `coaching_plans` lifecycle |
| **Governance** — full auditability | Every score, override, coaching event traceable to user + timestamp via `event_logs` | Audit sample test — 10 random calls traced end-to-end |
| **Scalability** — handle hundreds of weekly calls | All Overview Dashboard surfaces render < 3 seconds at 500-call dataset | Stress test in Week 7 |
| **Manager review time** | Reduce weekly review from ~10 hours → < 30 minutes total per manager | Manager self-reports time on QA, weekly |
| **Per-agent review cadence** | Each agent reviewed weekly (currently: ad-hoc, often > 2 weeks between) | Tracked via Overview expanded-panel access logs |

---

## Case Study — End-to-End Workflow

Walks one anonymised call through the system to demonstrate the suggested workflow. The case study is the spine of the business case — it's the most concrete way to evaluate what Phase 1 delivers.

### Background

| Field | Value |
|---|---|
| Agent | Khalid (`k.smith@walaplus.com`) — SDR, 3 months tenure |
| Customer | New prospect at `aramco.com`, called from `+966 50 555 1234` |
| Date | Sunday 10 May, 11:53 AM Riyadh |
| Call duration | 7 min 12 sec |
| Call outcome | Customer raised pricing concern; Khalid offered a discount instead of probing the concern |
| SDR Manager | Sarah Hijazi |

### Step 1 — Call happens (Sunday 11:53 AM)

Khalid completes the call. Recording saved as
`+966505551234 by k.smith@walaplus.com on 5_10_2025 @ 11_53_28 AM.wav`
following WalaPlus's canonical filename convention.

### Step 2 — Upload + parse (Sunday afternoon)

Khalid (or an ops admin) uploads the recording to `/calls` → Data Sources.

The platform's strict filename parser extracts every field automatically:

| Field | Parsed value |
|---|---|
| Phone (raw) | `+966505551234` |
| Phone (last 9 digits, for CRM search) | `505551234` |
| Agent email | `k.smith@walaplus.com` |
| Agent name | `k.smith` |
| Call date | 10 May 2025 |
| Call time | 11:53:28 AM (Riyadh local) |

A red chip would appear if any field were missing — upload is blocked until rename or removal. This eliminates the "Sep 1, 2025 placeholder date" problem that affected historical bulk uploads.

### Step 3 — Auto-analysis pipeline (runs within ~2 minutes of upload)

1. **Audio persisted** to Postgres `audio_blob`
2. **Whisper-1 transcription** — Arabic transcript returned with timestamps
3. **(Phase 1, Week 5-6) Speaker diarization** — identifies Khalid's voice vs customer's voice
4. **Sentiment scoring** — overall + per-segment
5. **Topic extraction** — pulls "pricing objection", "competitor mention" into `call_analysis.key_topics`
6. **COPC v2 scorecard evaluation** — LLM rates Khalid against each attribute:

| COPC v2 Attribute (Section 2 — Call Quality & Soft Skills) | Khalid's score | Why |
|---|---|---|
| Greeting & introduction compliance | PASS (10/10) | Said the WalaPlus opening + introduced himself |
| Active listening + rapport | PASS (8/10) | Asked clarifying questions twice |
| **Discovery — qualifying questions** | **FAIL** | Didn't ask about company size or budget |
| **Objection handling** | **FAIL** | When customer said "too expensive", Khalid offered a discount instead of probing the concern |
| Closing & follow-up | PASS (9/10) | Confirmed next step + got verbal commitment for follow-up |
| Compliance — consent disclosed | PASS (10/10) | Said the PDPL consent line |

Overall score: **62% (FAIL threshold)**

### Step 4 — Coaching loop triggers (Sunday evening, ~5 minutes later)

The `onSdrEvaluationSaved` hook fires (already shipped):

1. Verifies any awaiting-verification coaching plans for Khalid — none
2. Scans last 14 days of Khalid's calls for repeated attribute failures
3. Finds: Khalid has now failed "Objection handling" on 3 calls this fortnight
4. **Auto-generates a coaching plan:**

```
agent_email:           k.smith@walaplus.com
attribute_id:          objection_handling
fail_count:            3
failed_call_ids:       [142, 156, 171]
trigger_window_start:  Apr 27 2025
trigger_window_end:    May 10 2025
status:                pending_delivery
```

No email, no Slack alert — the plan just lands silently in the database, waiting for Sarah to see it on Monday morning when she opens the dashboard.

### Step 5 — Monday morning, Manager opens the dashboard (8:00 AM)

Sarah opens `qms-dashboard.replit.app/calls` directly.

### Step 6 — The Overall Dashboard (one screen, everything in scope)

Sarah lands on the Overview tab. The page is structured as a single comprehensive cockpit:

#### Section A — KPI Strip (top)

```
[ Total Calls 52 ]  [ Analyzed 52 ]  [ Avg Sentiment 71% ]
[ Avg QA Score 71% ]  [ Compliance 38% ]
```

#### Section B — Date Filter + Critical Issues Banner

```
📅 Date range: [Last 7 days ▼]    🚨 Critical Issues:
                                       • 3 new coaching plans pending
                                       • 1 call flagged: missing consent line
                                       • Compliance Rate dropped 8% week-over-week
```

#### Section C — Agent Leaderboard (sorted by gap to target)

| Agent | Calls | Avg QA | Sentiment | Talk Ratio | Coaching | Weak Attribute | |
|---|---|---|---|---|---|---|---|
| Layla M. | 12 | 91% 🟢 | 78% | 47% | 0 | — | ▼ |
| Mona K. | 8 | 78% | 72% | 51% | 1 awaiting | Discovery | ▼ |
| Ahmad B. | 11 | 73% | 70% | 49% | 1 pending | Closing | ▼ |
| **Khalid S.** | **10** | **62% 🔴** | **66%** | **64% ⚠️** | **3 pending** | **Objection Handling** | **▼** |
| ... | | | | | | | |

Sarah clicks the ▼ on Khalid's row.

#### Section D — Inline Expanded Panel (Khalid)

The row expands in place:

```
┌─ Khalid Smith (3-month tenure) ──────────────────────────────┐
│ Weekly trend:  78% → 75% → 71% → 68% → 62%  (5-week decline)│
│                                                              │
│ Active coaching plans:                                       │
│   • Objection Handling  •  3 failed calls  •  PENDING        │
│     [Deliver →]                                              │
│                                                              │
│ Performance vs Team:                                         │
│   Objection Handling   ──────●───────  -18 below median 🔴  │
│   Discovery            ─────●────────  -10 below median 🟠  │
│   Closing              ─────────●────  +5 above median 🟢   │
│                                                              │
│ Talk-time analytics:                                         │
│   Khalid 64% / Customer 36%   (team median: 45% / 55%) ⚠️   │
│   Avg interruptions: 4 per call (team: 1.2)                  │
│                                                              │
│ Recent calls (click to drill):                               │
│   May 10 11:53  ·  62%  ·  Objection FAIL  ·  [View →]       │
│   May 5  14:22  ·  60%  ·  Objection FAIL  ·  [View →]       │
│   May 1  10:15  ·  58%  ·  Objection FAIL  ·  [View →]       │
│   ... 7 more                                                 │
│                                                              │
│ Topic context: "Pricing objection" in 26% of Khalid's        │
│ calls vs team average 14%                                    │
│                                                              │
│ [Export Khalid's history as CSV]                             │
└──────────────────────────────────────────────────────────────┘
```

Everything Sarah needs about Khalid is now on screen. No separate page. No new URL.

### Step 7 — Coaching delivery (inline modal from the expanded panel)

Sarah clicks **Deliver →** next to the active plan. A modal opens:

| Field | Pre-populated |
|---|---|
| SDR | Khalid Smith |
| Attribute | Objection Handling |
| Evidence (3 failing calls) | May 1, May 5, May 10 — each clickable to drill into the full Call Details modal |
| Talk-time context | Khalid talks 64% on avg; over-talking exacerbates the issue |

Sarah types:
- **SDR's commitment:** "Khalid will open every objection with 'help me understand what's behind the concern' BEFORE offering any solution."
- **Follow-up due:** May 17
- **Coaching notes:** "Discussed the 3 calls in 1:1. Khalid recognised the pattern. Agreed to use the discovery template for next 5 calls."

Sarah clicks **Mark Delivered**. The plan moves to `awaiting_verification`.

### Step 8 — Khalid's next call (Wednesday May 14)

Pipeline runs again. Same flow as Step 3 but with a new transcript and new score.

`onSdrEvaluationSaved` fires. The system checks: did Khalid pass Objection Handling on this new call?

**Yes — PASS (9/10).** Plan auto-updates:

```
status:                 verified_passing
verification_call_id:   189
verified_at:            May 14, 2025 14:23
verification_outcome:   passing
```

Sarah opens the dashboard at any later point. Khalid's row now shows:

- Coaching: **1 verified ✅** (was 3 pending)
- Score trend: 62% → 71% (recovering)
- Active plans: 0

The system recorded:
- 4 days from plan creation to verified passing
- One coaching session delivered
- One behaviour change confirmed in data

### Step 9 — End of month, team-level view (same Overview tab, filtered to "Last 30 days")

Sarah scrolls to the bottom of the Overview tab:

| Coaching loop metric | This month |
|---|---|
| Plans created | 18 |
| Verified passing | 11 (61%) |
| Verified failing again | 2 (plan re-opens) |
| Dismissed with reason | 3 |
| Still awaiting verification | 2 |
| Average time create → verified | 8.4 days |
| Top coached attribute | Objection Handling (8 plans) |

This is the **DMAIC Control metric** that proves the platform is working. 61% loop closure means coaching delivers measurable behaviour change two out of three times.

### Step 10 — Cohen's κ tracking (running continuously, shown as small badges on each attribute)

Each scorecard attribute shows an inline κ badge:

| Attribute | κ (AI vs Sarah) |
|---|---|
| Greeting | 0.82 — strong agreement |
| Discovery | 0.74 |
| **Objection Handling** | **0.51 — moderate, tune rubric** ⚠️ |
| Closing | 0.78 |
| Compliance | 0.91 — near-perfect |

The platform flags Objection Handling rubric for next tuning pass. Sarah doesn't have to discover this; the system surfaces it.

---

## What this case study demonstrates

| Capability | Where in the workflow | Phase 1 status |
|---|---|---|
| Standardized per-call score | Step 3 | ✅ Already shipped |
| Coaching plan auto-generation | Step 4 | ✅ Already shipped |
| Coaching delivery workflow | Step 7 | ✅ Already shipped |
| Verification on next call | Step 8 | ✅ Already shipped |
| **Manager opens ONE dashboard for everything** | Step 6 | 🟡 Phase 1 Week 2-4 |
| **Date range filter + leaderboard + drill-down** | Step 6 | 🟡 Phase 1 Week 2-4 |
| **Talk-time analytics** | Step 6, expanded panel | 🟡 Phase 1 Week 5-6 |
| **QA Inbox sampling workflow** | (not in case study, but reviewer-facing) | 🟡 Phase 1 Week 6 |
| **Critical Issues banner + κ badges** | Steps 6 + 10 | 🟡 Phase 1 Week 7 |

Today's platform delivers ~55% of this workflow end-to-end. Phase 1 closes the remaining ~45% — concentrated in the enriched Overview tab.

---

## Investment Required

| Resource | Estimate |
|---|---|
| Engineering | ~7 weeks (~1 FTE equivalent at recent session pace) |
| External licensing | Zero — no new vendors, no SaaS subscriptions |
| Infrastructure | Existing Replit deployment is sufficient |
| AI/API spend increase | ~$50–100/month additional Whisper spend for talk-time analytics pass |
| SDR team time | One 45-min briefing on consent + 3-point verification scripts; ~6 seconds added to every call's opening |
| Manager time | ~30 min/week on the Overview dashboard |

---

## Success Metrics (DMAIC Control Phase)

| Metric | Baseline (today) | Target (Week 7) |
|---|---|---|
| Hours/week Manager spends on QA | ~10h (manual listening) | < 30 min (Overview dashboard review) |
| Calls reviewed per week | ~10 manual | ~50 automatic + 5-10 manager-sampled (via QA Inbox) |
| Coaching plans verified passing | 0 (no plans exist) | ≥ 60% within 30 days |
| Per-agent review cadence | Ad-hoc, often > 2 weeks between | Weekly via Overview expanded panel |
| Average AI/Manager Cohen's κ | Not measured | ≥ 0.6 across all rubric attributes |

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| SDR team adoption of consent + verification scripts lags | Medium | Phase 1 ships but the data is less meaningful | Pilot with 1-2 agents in Weeks 2-3; full rollout Weeks 4-5 |
| Speaker diarization quality is poor on Saudi-Arabic-with-code-switching | Medium | Talk-time analytics become unreliable | Pilot on 10 sample calls in Week 5; vendor fallback (AssemblyAI/Deepgram) ready |
| Engineering capacity drops below 1 FTE | Low-medium | Timeline extends 2-3x | Weekly status updates; defer non-critical items first |
| Manager doesn't check dashboard weekly | Low | Coaching plans pile up without delivery | Tracked via access logs; if cadence slips, revisit the digest decision |

---

## Next Steps for Validation

| Step | Owner | When |
|---|---|---|
| CTO approval to proceed with the 7-week plan | Ahmed Eldaly | This week |
| Verify today's existing fixes deployed | Operations team | This week |
| Brief SDR team on consent + 3-point verification scripts | SDR Manager (Sarah) | Week 1 |
| **Begin Phase 1 — Overall Dashboard build** | Engineering | Week 2 |
| Pilot the new opening scripts with 1-2 agents | SDR Manager + 1-2 SDRs | Weeks 2-3 |
| Monday status update (every week) | Engineering | Weekly through Week 7 |

---

## Approval

| Role | Name | Decision | Date |
|---|---|---|---|
| Operations & Quality HOD | Ahmed Amashah | Sponsor — proceed | 2026-05-25 |
| Quality Manager | Sarah Hijazi | Reviewing | |
| CTO | Ahmed Eldaly | Pending | |

Once CTO approval is received, the 7-week build begins in Week 2.

---

## Supporting Documentation

All committed to `qms-dashboard/docs/`:

- `Call_Evaluation_Revamp_Plan_2026_05_25.md` — full 1,029-line technical plan
- `SDR_PDPL_Consent_Script_2026_05_25.md` — consent line for SDR opening
- `SDR_Verification_Step_2026_05_25.md` — 3-point lead verification step
- `Company_Domain_Strategy_2026_05_25.md` — separate workstream on domain as a CS primitive
- `Decision_Record_*` — three scope-amendment records committed today, each documenting what was added/removed and why
- `DMAIC_Call_Details_Unification_2026_05_25.md` — yesterday's UI restructure (already shipped)
- `Zoho_OAuth_Setup_2026_05_25.md` — operational Zoho credentials playbook

---

## Closing

The platform already produces standardised AI scores for every call uploaded to it. What's missing is the **single dashboard** the SDR Manager can use to run a weekly review without bouncing between tabs. The case study above shows that workflow — from a Sunday morning call to a Wednesday verification — playing out in 10 concrete steps, on one screen, in under 10 minutes of manager time.

We are requesting 7 weeks of engineering effort to close that gap.
