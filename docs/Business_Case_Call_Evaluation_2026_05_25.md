# Business Case — Call Evaluation Platform (Phase 1: 8-Week Build)

**Prepared for:** Ahmed Eldaly (CTO), WalaPlus
**Prepared by:** Ahmed Amashah (Operations & Quality HOD)
**Date:** 2026-05-25
**Status:** Awaiting CTO approval to proceed
**Initiative type:** Internal capability build — no external dependencies

---

## Executive Summary

The WalaPlus QMS platform already contains the **scoring engine** for SDR call quality (transcription, COPC v2 scorecard, automatic evaluation, coaching loop, CRM compliance auditing). This Phase 1 build delivers the **manager cockpit** on top of that engine — converting an existing technical capability into a tool the SDR Manager and Quality Lead use to run a weekly review cycle, deliver structured coaching, and verify behaviour change.

**Ask:** approval for ~8 weeks of focused engineering effort. No new vendors, no new infrastructure, no external data sharing. All processing remains inside WalaPlus's existing Replit deployment on Saudi soil.

---

## User Story

> **As Head of Operations & Quality initiatives at WalaPlus,**
>
> we want an AI-powered scorecard integrated with our call recording flow,
>
> so that we can evaluate every SDR call against defined compliance and quality criteria, providing **standardized scoring, compliance assurance, and structured coaching insights** — without relying on manual or subjective side-by-side listening.

---

## Business Case

### Problems Identified

| # | Today's pain | Operational consequence |
|---|---|---|
| 1 | QA is fully manual — Quality Manager listens to calls side-by-side to verify qualification criteria | Time-consuming; doesn't scale beyond a few dozen calls per week |
| 2 | No standardized per-call scoring | Feedback is ad-hoc and subjective; two reviewers give two different scores for the same call |
| 3 | Limited visibility for stakeholders | Five9 recording access is restricted; only one team member can review at a time |
| 4 | No manager-reportable artifact | The SDR Manager has no weekly document or dashboard to run reviews from — coaching is reactive, not proactive |
| 5 | Coaching loop is disconnected from data | Plans get delivered, then forgotten — no verification on the next call |
| 6 | No visibility into conversational quality | Talk ratio, silence, interruptions, pace — the leading indicators of SDR performance — are invisible today |

### Proposed Solution

A complete in-house Call Evaluation pipeline structured in six layers, each built on top of what already exists in `qms-dashboard.replit.app/calls`:

#### Layer 1 — Ingestion & Storage

| Capability | Status |
|---|---|
| Call recordings ingested from the SDR flow (filename-based upload today; live webhook in Phase 2) | ✅ Shipped |
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
| Sentiment scoring per call (positive/neutral/negative + numeric score) | ✅ Shipped |
| Key topic extraction (already powering the Topic Clusters panel) | ✅ Shipped |
| Talk-time features: agent ratio, silence, interruptions, pace | 🟡 Phase 1 deliverable (Week 5-6) |

#### Layer 4 — Scorecard & Compliance Engine

| Capability | Status |
|---|---|
| LLM-based rubric scoring against the COPC v2 scorecard (Greeting / Discovery / Objection Handling / Closing / Compliance) | ✅ Shipped |
| Weighted total score with per-attribute rationales | ✅ Shipped |
| Timestamped evidence quotes per attribute | ⚠️ Partial — to be polished in Phase 1 (Week 8) |
| Auto-fail rules for major compliance breaches | 🔵 Phase 2 candidate (deferred with re-trigger conditions documented) |

#### Layer 5 — Quality Ops & Calibration

| Capability | Status |
|---|---|
| Manager-review workflow (approve / adjust / disagree with AI score) | ✅ Shipped |
| QA Inbox — sample N random calls per week for review | 🟡 Phase 1 deliverable (Week 7) |
| Cohen's κ tracking — measure AI vs human agreement so the rubric self-tunes | 🟡 Phase 1 deliverable (Week 8) |

#### Layer 6 — Outputs & Delivery

| Capability | Status |
|---|---|
| Per-agent dashboards with score trends, weak attributes, peer benchmark | ⚠️ Partial today — full Agent View page is Phase 1 (Week 5-6) |
| Team-level dashboards (leaderboard, weak areas, coaching backlog) | 🟡 Phase 1 deliverable (Week 7) |
| Weekly PDF digest auto-emailed to SDR Manager every Monday | 🟡 Phase 1 deliverable (Week 2-3) |
| Real-time Slack alerts on critical compliance fails | 🟡 Phase 1 deliverable (Week 2-3) |
| CSV exports for any agent's scorecard history | 🟡 Phase 1 deliverable (Week 2-3) |

### Expected Benefits

| Benefit | Quantified target | Measurement method |
|---|---|---|
| **Efficiency** — manual QA reduction | ≥70% reduction in hours spent on side-by-side listening | Self-reported weekly, comparing pre-launch baseline to Week 8 |
| **Consistency** — eliminate evaluator bias | Same call gets the same score every time; Cohen's κ ≥ 0.6 (AI vs manager) by Week 8 | Auto-computed weekly |
| **Coaching** — actionable skill-gap identification | ≥60% of generated coaching plans reach "verified passing" or "dismissed with reason" within 30 days | Tracked in `coaching_plans` lifecycle |
| **Governance** — full auditability | Every score, every coaching event, every override traceable to a user + timestamp via `event_logs` | Audit sample test — 10 random calls traced end-to-end |
| **Scalability** — handle hundreds of weekly calls | All surfaces render < 3 seconds at 500-call dataset | Stress test in Week 8 |
| **Manager review time** | Reduce weekly review from ~10 hours → < 1 hour per SDR Manager | Manager self-reports time on QA, weekly |

---

## Case Study — End-to-End Workflow

Walk through a single call to show what happens at every step. Names anonymised; structure is real.

### Background

| Field | Value |
|---|---|
| Agent | Khalid (`k.smith@walaplus.com`) — SDR, 3 months tenure |
| Customer | New prospect at `aramco.com`, called from `+966 50 555 1234` |
| Date | Sunday 10 May, 11:53 AM Riyadh |
| Call duration | 7 min 12 sec |
| Call result | Customer expressed pricing concern; Khalid said he'd follow up |
| SDR Manager | Sarah Hijazi |

### Step 1 — Call happens (Sunday 11:53 AM)

Khalid completes the call. Recording is saved as
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
| Direction | outbound (default for SDR) |

A red chip would appear if any field were missing — upload is blocked until rename or removal. This eliminates the "Sep 1, 2025 placeholder date" problem that affected the historical 199 records.

### Step 3 — Auto-analysis pipeline (runs within ~2 minutes of upload)

1. **Audio persisted** to Postgres `audio_blob` so it survives container redeploys
2. **Whisper-1 transcription** with `verbose_json` — Arabic transcript returned with timestamps; call duration extracted
3. **(Phase 1, Week 5-6) Speaker diarization** — identifies Khalid's voice vs customer's voice, segments the transcript by speaker
4. **Sentiment scoring** — overall + per-segment if sentiment shifts mid-call
5. **Topic extraction** — pulls "pricing objection", "competitor mention", etc. into `call_analysis.key_topics`
6. **COPC v2 scorecard evaluation** — LLM rates Khalid against each attribute:

| COPC v2 Attribute (Section 2 — Call Quality & Soft Skills) | Khalid's score | Why |
|---|---|---|
| Greeting & introduction compliance | PASS (10/10) | Said the WalaPlus opening + introduced himself |
| Active listening + rapport | PASS (8/10) | Asked clarifying questions twice |
| **Discovery — qualifying questions** | **FAIL** | Didn't ask about company size or budget |
| **Objection handling** | **FAIL** | When customer said "too expensive", Khalid offered a discount instead of probing the concern |
| Closing & follow-up | PASS (9/10) | Confirmed next step + got verbal commitment for a follow-up call |
| Compliance — consent disclosed | PASS (10/10) | Said the PDPL consent line |

Overall score: **62% (FAIL threshold)**

### Step 4 — Coaching loop triggers (Sunday evening, ~5 minutes after analysis completes)

`onSdrEvaluationSaved` fires (already shipped). The system:

1. **Verifies any awaiting-verification coaching plans for Khalid** — none yet
2. **Scans last 14 days** of Khalid's calls for repeated attribute failures
3. **Finds:** Khalid has now failed "Objection handling" on 3 calls this fortnight
4. **Auto-generates a coaching plan**:

```
agent_email:           k.smith@walaplus.com
attribute_id:          objection_handling
fail_count:            3
failed_call_ids:       [142, 156, 171]
trigger_window_start:  Apr 27 2025
trigger_window_end:    May 10 2025
status:                pending_delivery
```

5. **(Phase 1, Week 2-3) Slack alert** fires to the SDR Manager channel:
> 🟠 Coaching Plan auto-generated — `k.smith` failing **Objection Handling** on 3 calls in last 14 days. Latest fail: call #171 (May 10, 11:53 AM). Review: [link]

### Step 5 — Monday morning, Manager receives weekly digest (8:00 AM)

Sarah opens her inbox. A WalaPlus-branded PDF is waiting:

> **WalaPlus SDR Weekly Quality Digest — Week of May 5-11, 2025**
>
> 📊 **Team summary**
>
> - 52 calls analyzed (38 last week, +37%)
> - Team average QA score: 71% (down from 74%)
> - **3 new coaching plans this week** (Khalid, Mona, Ahmad)
> - **1 critical compliance issue** flagged for review
>
> 🎯 **Top weakness this week**: Objection Handling (8 fails across 4 agents)
>
> 🏆 **Top performer**: Layla — 91% avg, 12 calls, 0 fails
>
> 🚨 **Agent needing immediate attention**: Khalid — 3 plans pending delivery
>
> [Open Khalid's Agent View →]
> [Open Team Leaderboard →]

Sarah clicks "Open Khalid's Agent View."

### Step 6 — Agent View page (one-page-per-SDR)

The page loads with everything Sarah needs about Khalid:

| Section | Content |
|---|---|
| Header | Khalid Smith · 3-month tenure · 47 calls evaluated · current avg 68% |
| Trend chart | Weekly QA score over last 8 weeks — declining from 78% to 62% |
| Active coaching plans | "Objection Handling" (NEW, pending delivery) — 3 failed calls listed |
| Recent calls | Last 10 calls with scores, click to drill into any |
| **Performance vs Team** | Per-attribute bars showing Khalid score vs anonymised team median: Objection Handling: -18 below median 🔴; Closing: +5 above median 🟢; etc. |
| **(Phase 1, Week 5-6) Talk-time stats** | Khalid talks 64% of the time on average. Team median is 45%. ⚠️ Over-talking flag. |
| Topic cluster context | "Pricing objection" came up in 12 of Khalid's 47 calls (26%) — vs team avg of 14% |

Sarah now has a complete picture in under 60 seconds. She clicks "Deliver Coaching Plan" on the active plan.

### Step 7 — Coaching delivery modal

The platform pre-fills the modal with everything from the auto-generated plan:

| Field | Value |
|---|---|
| SDR | Khalid Smith |
| Attribute | Objection Handling |
| Evidence (3 failing calls) | Call #142 (May 1) — "discount instead of probing"; Call #156 (May 5) — "moved to closing too early"; Call #171 (May 10) — same pattern again |
| Talk-time context | Khalid talks 64% on avg; over-talking exacerbates this |

Sarah fills in the manager bits:

- **SDR's commitment:** "Khalid will open every objection with 'help me understand what's behind the concern' BEFORE offering any solution."
- **Follow-up due:** May 17 (one week)
- **Coaching notes:** "Discussed the 3 calls in 1:1. Khalid recognised the pattern. Agreed to use the discovery template for next 5 calls."

Sarah clicks **Mark Delivered**. The plan moves to **Awaiting Verification**.

### Step 8 — Verification on next call (Wednesday May 14)

Khalid makes his next outbound call. Same pipeline runs:
- Recording uploaded
- Whisper transcript
- Scorecard evaluates the same 6 attributes
- **Objection Handling: PASS (9/10) — "probed the pricing concern with two follow-up questions before offering any solution"**

`onSdrEvaluationSaved` fires again. The coaching plan for Khalid + Objection Handling is in `awaiting_verification` state. The system checks: did Khalid pass the attribute on this new call?

**Yes.** Plan auto-updates:
```
status:                 verified_passing
verification_call_id:   189
verified_at:            May 14, 2025 14:23
verification_outcome:   passing
```

A Slack message fires to Sarah: *"✅ Khalid's coaching plan VERIFIED — Objection Handling passed on call #189 (May 14)."*

Sarah opens the Agent View page → the plan now shows in the **Resolved** column with a green badge. The system records:
- 7 days from plan creation to verified passing
- One coaching session delivered
- One behaviour change confirmed in data

### Step 9 — Monthly review cycle (end of May)

Sarah opens the **Team View** dashboard:

| Metric | This month |
|---|---|
| Coaching plans created | 18 |
| Verified passing | 11 (61%) |
| Verified failing again | 2 (the plan re-opens) |
| Dismissed with reason | 3 |
| Still awaiting verification | 2 |
| Average time from create → verified | 8.4 days |
| Top coached attribute | Objection Handling (8 plans) |

This is the **DMAIC Control metric** that proves the platform is working. 61% loop closure means coaching delivers measurable behaviour change two out of three times — meaningfully better than the ad-hoc-listening baseline where Sarah couldn't even tell if her coaching landed.

### Step 10 — Cohen's κ tracking (running continuously, surfaced in Phase 1 Week 8)

The system tracks, over the whole month: when Sarah used the Manager Review workflow to OVERRIDE the AI's score, did she usually disagree on the same attributes? Per attribute, Cohen's κ is computed:

| Attribute | κ (AI vs Sarah) |
|---|---|
| Greeting | 0.82 — strong agreement |
| Discovery | 0.74 |
| **Objection Handling** | **0.51 — moderate, room to tune rubric** |
| Closing | 0.78 |
| Compliance | 0.91 — near-perfect |

The platform flags "Objection Handling" rubric for next month's tuning pass. Sarah doesn't have to discover this; the system surfaces it.

---

## What this case study demonstrates

| Capability | Where in the workflow | When delivered |
|---|---|---|
| Standardized per-call score | Step 3 — automatic, same every time | Already shipped |
| Manager-reportable artifact | Step 5 — weekly PDF on Monday | Phase 1, Week 2-3 |
| Per-agent dashboard | Step 6 — Agent View | Phase 1, Week 5-6 |
| Talk-time visibility | Step 6 — talk ratio per call + per agent | Phase 1, Week 5-6 |
| Coaching plan auto-generation | Step 4 | Already shipped |
| Coaching delivery workflow | Step 7 — modal with pre-filled context | Already shipped |
| Verification on next call | Step 8 — automatic | Already shipped |
| Team-level visibility | Step 9 — Team View | Phase 1, Week 7 |
| Calibration tracking | Step 10 — Cohen's κ | Phase 1, Week 8 |

Today's platform delivers ~60% of this workflow end-to-end. Phase 1 closes the remaining 40% — specifically the manager-cockpit layer (digest, Agent View, Team View, talk-time, κ tracking).

---

## Investment Required

| Resource | Estimate |
|---|---|
| Engineering | ~8 weeks (~1 FTE equivalent at recent session pace) |
| External licensing | Zero — no new vendors, no SaaS subscriptions |
| Infrastructure | Existing Replit deployment is sufficient |
| AI/API spend increase | ~$50–100/month additional Whisper spend for talk-time analytics pass |
| SDR team time | One 45-min briefing for the team on the consent + 3-point verification scripts; ~6 seconds added to every call's opening |
| Manager time | 30 min/week to read the digest + drill into 2-3 calls |

---

## Success Metrics (DMAIC Control Phase)

| Metric | Baseline (today) | Target (Week 8) |
|---|---|---|
| Hours/week Manager spends on QA | ~10h (manual listening) | < 1h (digest review + targeted drill-down) |
| Calls reviewed per week | ~10 manual | ~50 automatic + 5-10 manager-sampled (via QA Inbox) |
| Coaching plans created vs verified | 0 (no plans exist) | ≥60% verified passing within 30 days |
| Per-agent review cadence | Ad-hoc, often > 2 weeks between | Weekly via Agent View |
| Average AI/Manager Cohen's κ | Not measured | ≥ 0.6 across all rubric attributes |
| Manager-reportable artifact frequency | None | Weekly PDF every Monday |

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| SDR team adoption of consent + verification scripts lags behind engineering | Medium | Week 1-2 deliverables ship but the data they produce is less meaningful | Pilot with 1-2 agents Week 2-3; full rollout Week 4-5 |
| Speaker diarization quality on Saudi-Arabic-with-code-switching is poor | Medium | Talk-time analytics become unreliable | Pilot on 10 sample calls in Week 6; vendor fallback (AssemblyAI/Deepgram) available |
| Engineering capacity drops below 1 FTE | Low-medium | Timeline extends 2-3x | Weekly status updates communicate cadence; defer non-critical items (κ surface) first |
| PDPL audit lands during the 8-week window | Low | Deferred items (PII redaction, deterministic compliance enforcement) become urgent | Documented re-trigger conditions; emergency 1-week sprint to add PII redaction if needed |

---

## Next Steps for Validation

| Step | Owner | When |
|---|---|---|
| CTO approval to proceed with the 8-week plan | Ahmed Eldaly | This week |
| Verify today's existing fixes deployed (RBAC, Coaching tab, Open/Closed Activities) | Operations team | This week |
| Brief SDR team on the consent + 3-point verification scripts | SDR Manager (Sarah) | Week 1 |
| Begin Phase 1.1 — Reports surface (digest + Slack alerts + CSV exports) | Engineering | Week 2 |
| Pilot the new opening scripts with 1-2 agents | SDR Manager + 1-2 SDRs | Weeks 2-3 |
| Monday status update (every week) | Engineering | Weekly through Week 10 |

---

## Approval

| Role | Name | Decision | Date |
|---|---|---|---|
| Operations & Quality HOD | Ahmed Amashah | Sponsor — proceed | 2026-05-25 |
| Quality Manager | Sarah Hijazi | Reviewing | |
| CTO | Ahmed Eldaly | Pending | |

Once CTO approval is received, the 8-week build begins in Week 2.

---

## Supporting Documentation

All committed to `qms-dashboard/docs/`:

- `Call_Evaluation_Revamp_Plan_2026_05_25.md` — full 1,029-line technical plan
- `SDR_PDPL_Consent_Script_2026_05_25.md` — consent line for SDR opening
- `SDR_Verification_Step_2026_05_25.md` — 3-point lead verification step
- `Company_Domain_Strategy_2026_05_25.md` — separate workstream on domain as a CS primitive
- `Decision_Record_Amend_Skip_P0_P15_2026_05_25.md` — scope amendment record
- `DMAIC_Call_Details_Unification_2026_05_25.md` — yesterday's UI restructure (already shipped)
- `Zoho_OAuth_Setup_2026_05_25.md` — operational Zoho credentials playbook

---

## Closing

The platform already produces standardised AI scores for every call uploaded to it. What's missing is the surface that makes those scores **actionable for the SDR Manager** — the weekly digest, the per-agent page, the team leaderboard, the talk-time analytics, the calibration tracking. The case study above walks through how a single coaching cycle plays out end-to-end once those surfaces exist.

We are requesting 8 weeks of engineering effort to close that gap. The engine is already running; this builds the cockpit on top.
