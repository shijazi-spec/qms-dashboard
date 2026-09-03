# Business Case — Call Evaluation Platform (Phase 1: 5-Week Build, AI-Only)

**Prepared for:** Sample User (CTO), ExampleOrg
**Prepared by:** Sample User (Operations & Quality HOD)
**Date:** 2026-05-25 (incorporates four same-day amendments)
**Status:** Awaiting CTO approval to proceed
**Lens applied:** Lean Six Sigma (DOWNTIME waste elimination)
**Initiative type:** Internal capability build — no external dependencies

---

## Executive Summary

The ExampleOrg QMS platform already contains the **scoring engine** for SDR call quality (transcription, COPC v2 scorecard, automatic evaluation, coaching loop, CRM compliance auditing). This Phase 1 build delivers the **manager cockpit** on top of that engine — converting an existing technical capability into a tool the Quality HOD uses to run a weekly review cycle, deliver structured coaching, and verify behaviour change.

The cockpit centres on a single **Weekly Report** — the home page of the platform — where every Monday-morning review begins. AI scores every call; the manager consumes the consolidated weekly view and intervenes only on coaching, not on per-call evaluation. No QA review queue, no override workflow, no human-in-loop on individual scores.

**Ask:** approval for ~5 weeks of focused engineering effort. No new vendors, no new infrastructure, no external data sharing.

---

## User Story

> **As Head of Operations & Quality initiatives at ExampleOrg,**
>
> I want an AI scorecard that evaluates every SDR call autonomously and a single Weekly Report that consolidates the team's performance,
>
> so that I can **minimise direct monitoring of the SDR team** and run a full weekly coaching review in under 10 minutes from one screen — without listening to calls side-by-side, without reviewing every AI evaluation, and without bouncing between tabs.

---

## Lean Six Sigma framing

The platform's design is guided by elimination of **DOWNTIME** wastes:

| Waste type | What we eliminated | How |
|---|---|---|
| **D**efects | Tracking of human override errors | No human overrides — AI is the evaluator |
| **O**ver-processing | Re-reviewing every AI-scored call | AI score is final; no QA gate |
| **W**aiting | Calls sitting in a QA review queue | Direct pipeline: Upload → Score → Done |
| **N**on-utilised talent | Manager hours on side-by-side listening | Manager time spent on coaching, not scoring |
| **T**ransportation | Calls routed through reviewer → final-marked | Single-step automation |
| **I**nventory | Backlog of pending reviews | No backlog exists |
| **M**otion | Multiple clicks across multiple pages | One Weekly Report, inline drill |
| **E**xtra features | QA Inbox, override workflow, audit-trail-of-overrides | Removed from scope (4th amendment) |

---

## Business Case

### Problems Identified

| # | Today's pain | Operational consequence |
|---|---|---|
| 1 | QA is fully manual — Manager listens to calls side-by-side to verify qualification criteria | Time-consuming; doesn't scale beyond a few dozen calls per week |
| 2 | No standardised per-call scoring | Feedback is ad-hoc and subjective; two reviewers give two different scores for the same call |
| 3 | Limited visibility for stakeholders | Recording access is restricted; only one team member can review at a time |
| 4 | No single dashboard the Manager can run a weekly review from | Coaching is reactive, not proactive; managers don't have time to navigate multiple tabs |
| 5 | Coaching loop is disconnected from data | Plans get delivered, then forgotten — no verification on the next call |
| 6 | No visibility into conversational quality | Talk ratio, silence, interruptions, pace — the leading indicators of SDR performance — are invisible today |

### Proposed Solution

A complete in-house Call Evaluation pipeline structured in five layers, each built on top of what already exists in `<REDACTED_HOST>/calls`:

#### Layer 1 — Ingestion & Storage

| Capability | Status |
|---|---|
| Call recordings ingested via Manual Upload (primary) + CSV Import (secondary) | ✅ Shipped |
| ContactCenterProvider ingestion — visible but suspended pending Tech Team integration | 🟡 Phase 1 (badge only) |
| Audio bytes persisted in Postgres so they survive container redeploys | ✅ Shipped |
| Metadata (agent, phone, date, time) parsed automatically from canonical filename format | ✅ Shipped |

#### Layer 2 — Transcription (ASR)

| Capability | Status |
|---|---|
| Whisper-1 transcription with Arabic + English language detection (handles code-switching natively) | ✅ Shipped |
| Speaker separation (Agent vs Customer) for talk-time analytics | 🟡 Phase 1 deliverable (Week 4–5) |

#### Layer 3 — Conversation Enrichment

| Capability | Status |
|---|---|
| Sentiment scoring per call (positive / neutral / negative + numeric) | ✅ Shipped |
| Key topic extraction (powers the Topic Clusters panel) | ✅ Shipped |
| Talk-time features: agent ratio, silence, interruptions, pace | 🟡 Phase 1 deliverable (Week 4–5) |

#### Layer 4 — Scorecard & Compliance Engine (the source of truth)

| Capability | Status |
|---|---|
| LLM-based rubric scoring against the COPC v2 scorecard (Greeting / Discovery / Objection Handling / Closing / Compliance) | ✅ Shipped |
| Weighted total score with per-attribute rationales | ✅ Shipped |
| Timestamped evidence quotes per attribute | ✅ Mostly shipped |
| Critical Fail flag (compliance breaches auto-mark the call) | ✅ Shipped |
| **AI score is final** — no human override workflow | ✅ By design |

#### Layer 5 — Coaching Operations (the action layer)

| Capability | Status |
|---|---|
| Auto-coaching trigger (3 attribute fails in 14 days → plan auto-generated) | ✅ Shipped |
| Coaching delivery modal (evidence calls pre-loaded, commitment + follow-up captured) | ✅ Shipped |
| Auto-verification on next eval (plan → `verified_passing` / `verified_failing_again`) | ✅ Shipped |
| Coaching plan lifecycle dashboard | ✅ Shipped |

#### Layer 6 — The Weekly Report (the manager cockpit)

| Capability | Status |
|---|---|
| KPI strip (5 cards: Total Calls · Avg Score · Avg Compliance · Critical Fails · Coaching Plans Pending) | ✅ Strip exists; reduced to 5 cards in Phase 1 |
| Calls by Source + Calls by Agent charts | ✅ Shipped |
| CRM Compliance Breakdown with coverage diagnostics | ✅ Shipped |
| Topic Clusters panel | ✅ Shipped |
| **Date range filter** (7d / 30d / 90d / custom) | 🟡 Phase 1 (Week 2–3) |
| **Agent rows sorted by gap-to-target** with click-to-expand inline drill | 🟡 Phase 1 (Week 2–3) |
| **Inline per-agent panel** (top failed attributes, last 5 calls, trend chart, active coaching plans, talk-time stats) | 🟡 Phase 1 (Week 2–3 + Week 4–5 talk-time) |
| **Critical Fails banner** + **Coaching Actions panel** with Deliver / Nudge buttons | 🟡 Phase 1 (Week 2–3) |
| Per-agent CSV export | 🟡 Phase 1 (Week 2–3) |

### Expected Benefits

| Benefit | Quantified target | Measurement method |
|---|---|---|
| **Efficiency** — manual QA reduction | ≥ 90% reduction in manager hours spent on call review | Manager self-reports time on QA, weekly — pre-launch baseline vs Week 5 |
| **Consistency** — eliminate evaluator bias | Same call gets the same score every time (LLM at temperature 0 + standardised COPC v2 rubric) | Inherent to the architecture |
| **Coaching closure rate** — actionable behaviour change | ≥ 60% of coaching plans reach `verified_passing` or `dismissed_with_reason` within 30 days | Tracked in `coaching_plans` lifecycle |
| **Governance** — full auditability of coaching events | Every plan, delivery, verification traceable to user + timestamp | Audit sample test — 10 random plans traced end-to-end |
| **Scalability** — handle hundreds of weekly calls | Weekly Report renders < 3 seconds at 500-call dataset | Stress test in Week 5 |
| **Manager review time** | Reduce weekly review from ~10 hours → < 10 minutes total | Manager self-reports time, weekly |
| **Per-agent review cadence** | Each agent reviewed weekly (currently: ad-hoc, often > 2 weeks between) | Tracked via Weekly Report access logs |

---

## Case Study — End-to-End Workflow

Walks one anonymised call through the system to demonstrate the suggested workflow. The case study is the spine of the business case — the most concrete way to evaluate what Phase 1 delivers.

### Background

| Field | Value |
|---|---|
| Agent | Sample User (`user@example.invalid`) — SDR, 3 months tenure |
| Customer | New prospect at `<REDACTED_HOST>`, called from `<REDACTED_PHONE>` |
| Date | Sunday 10 May, 11:53 AM Riyadh |
| Call duration | 7 min 12 sec |
| Call outcome | Customer raised pricing concern; Sample User discount instead of probing the concern |
| Quality HOD | Sample User |

### Step 1 — Call happens (Sunday 11:53 AM)

Sample User call. Recording saved as
`<REDACTED_PHONE> by user@example.invalid on 5_10_2025 @ 11_53_28 AM.wav`
following ExampleOrg's canonical filename convention.

### Step 2 — Upload + parse (Sunday afternoon)

Sample User (or an ops admin) uploads the recording to `/calls` → Data Sources. The platform's strict filename parser extracts every field automatically:

| Field | Parsed value |
|---|---|
| Phone (raw) | `<REDACTED_PHONE>` |
| Phone (last 9 digits, for CRM search) | `<REDACTED_PHONE>` |
| Agent email | `user@example.invalid` |
| Call date | 10 May 2025 |
| Call time | <REDACTED_IP> AM (Riyadh local) |

A red chip appears if any field is missing — upload is blocked until rename or removal.

### Step 3 — Auto-analysis pipeline (runs within ~2 minutes of upload)

1. **Audio persisted** to Postgres `audio_blob`
2. **Whisper-1 transcription** — Arabic transcript returned with timestamps
3. **(Phase 1, Week 4–5) Speaker diarization** — identifies Sample User's voice vs customer's voice
4. **Sentiment scoring** — overall + per-segment
5. **Topic extraction** — pulls "pricing objection", "competitor mention" into `call_analysis.key_topics`
6. **COPC v2 scorecard evaluation** — LLM rates Sample User attribute:

| COPC v2 Attribute | Sample User's score | Why |
|---|---|---|
| Greeting & introduction | PASS (10/10) | Said the ExampleOrg opening + introduced himself |
| Active listening + rapport | PASS (8/10) | Asked clarifying questions twice |
| **Discovery — qualifying questions** | **FAIL** | Didn't ask about company size or budget |
| **Objection handling** | **FAIL** | Customer said "too expensive" → Sample User instead of probing |
| Closing & follow-up | PASS (9/10) | Confirmed next step + got verbal commitment |
| Compliance — consent disclosed | PASS (10/10) | Said the PDPL consent line |

**Overall: 62% (FAIL threshold).** No human reviews this. The AI score is final.

### Step 4 — Coaching loop triggers (Sunday evening, ~5 minutes later)

The `onSdrEvaluationSaved` hook fires (already shipped):

1. Verifies any awaiting-verification coaching plans for Sample User — none
2. Scans last 14 days of Sample User's calls for repeated attribute failures
3. Finds: Sample User failed "Objection Handling" on 3 calls this fortnight
4. **Auto-generates a coaching plan:**

```
agent_email:           user@example.invalid
attribute_id:          objection_handling
fail_count:            3
failed_call_ids:       [142, 156, 171]
trigger_window_start:  Apr 27 2025
trigger_window_end:    May 10 2025
status:                pending_delivery
```

No email, no ChatProvider alert, no QA review queue — the plan lands silently in the database, waiting for Monday morning.

### Step 5 — Monday morning, Manager opens the dashboard (8:00 AM)

Sample User `<REDACTED_HOST>/calls` directly. Lands on the **Weekly Report**.

### Step 6 — The Weekly Report (one screen, everything in scope)

```
Week of May 4–10, 2026   |   52 calls scored   |   Team avg 71%   |   3 critical fails   |   2 coaching plans pending

[ 8-week team-avg trend line: 75% → 73% → 74% → 71% → 70% → 72% → 71% → 71% ]

🚨 Critical Issues:
   • 3 new coaching plans pending delivery
   • 1 call flagged: missing consent line (Mona, May 8)
   • Compliance Rate dropped 8% week-over-week

═══ Agents (sorted by gap-to-target 75%) ═══

Sample User    | 10 calls | 62% ↓ | 78% comp. | 0 critical | 1 plan pending
  ↳ Top failed attrs: Objection Handling (4×), Discovery (2×), Closing (1×)
  ↳ Talk-time: 64%  (team median 45%) — too dominant
  ↳ Last 5 scores: 58, 64, 60, 68, 62
  ↳ Trend: 78% → 75% → 71% → 68% → 62% (5-week decline)
  ↳ [Deliver Coaching Plan]

Sample User     | 11 calls | 73%   | 88% comp.  | 0 critical | 1 plan pending
  ↳ [Deliver Coaching Plan]

Mona      | 8 calls  | 78%   | 87% comp.  | 1 critical (consent line missed) | 1 plan pending
  ↳ [Deliver Coaching Plan]   [Review Critical Fail]

Sample User     | 12 calls | 91% ↑ | 100% comp. | 0 critical | 0 plans
  ↳ Top performer this week

═══ Coaching actions this week ═══

• Sample User — Objection Handling (4 failed-call evidence) → [Deliver]
• Sample User — Closing plan (3 failed-call evidence) — awaiting delivery for 5 days → [Nudge]
• Mona — Discovery plan (3 failed-call evidence) → [Deliver]

[ Export full report as CSV ]
```

Everything is on one screen. No QA review queue. No override buttons. No "approve AI score" gate.

### Step 7 — Coaching delivery (modal from the row)

Sample User **Deliver →** next to Sample User's plan. A modal opens:

| Field | Pre-populated |
|---|---|
| SDR | Sample User |
| Attribute | Objection Handling |
| Evidence (3 failing calls) | May 1, May 5, May 10 — each clickable to drill into the full Call Details modal |
| Talk-time context | Sample User 64% on avg; over-talking exacerbates the issue |

Sample User:
- **SDR's commitment:** "Sample User every objection with 'help me understand what's behind the concern' BEFORE offering any solution."
- **Follow-up due:** May 17
- **Coaching notes:** "Discussed the 3 calls in 1:1. Sample User pattern. Agreed to use the discovery template for next 5 calls."

Sample User **Mark Delivered**. The plan moves to `awaiting_verification`.

### Step 8 — Sample User's next call (Wednesday May 14)

Pipeline runs again — same auto-flow as Step 3. New transcript, new score.

`onSdrEvaluationSaved` fires. The system checks: did Sample User Handling on this new call?

**Yes — PASS (9/10).** Plan auto-updates:

```
status:                 verified_passing
verification_call_id:   189
verified_at:            May 14, 2025 14:23
verification_outcome:   passing
```

The next time Sample User Weekly Report, Sample User's row shows:
- Active plans: **0**
- Last 5 scores: 64, 60, 68, 62, **71** (recovering)
- Coaching closure indicator: **1 verified ✅**

The system recorded:
- 4 days from plan creation to verified passing
- One coaching session delivered
- One behaviour change confirmed in data

### Step 9 — End of month, monthly outcome view (same Weekly Report, filter = "Last 30 days")

| Coaching loop metric | This month |
|---|---|
| Plans created | 18 |
| Verified passing | 11 (61%) |
| Verified failing again | 2 (plan re-opens for deeper coaching) |
| Dismissed with reason | 3 |
| Still awaiting verification | 2 |
| Average time create → verified | 8.4 days |
| Top coached attribute | Objection Handling (8 plans) |

This is the **DMAIC Control metric** that proves the platform is working. 61% loop closure means coaching delivers measurable behaviour change two out of three times.

---

## What this case study demonstrates

| Capability | Where in the workflow | Phase 1 status |
|---|---|---|
| Standardised per-call score (final, no human gate) | Step 3 | ✅ Already shipped |
| Coaching plan auto-generation | Step 4 | ✅ Already shipped |
| Coaching delivery workflow | Step 7 | ✅ Already shipped |
| Verification on next call | Step 8 | ✅ Already shipped |
| **Manager opens ONE Weekly Report for everything** | Step 6 | 🟡 Phase 1 Week 2–3 |
| **Date filter + agent rows + inline drill** | Step 6 | 🟡 Phase 1 Week 2–3 |
| **Coaching Actions panel (Deliver / Nudge)** | Step 6 | 🟡 Phase 1 Week 2–3 |
| **Talk-time analytics** | Step 6, expanded panel | 🟡 Phase 1 Week 4–5 |
| **Critical Fails banner** | Step 6 | 🟡 Phase 1 Week 2–3 |
| **ContactCenterProvider suspended badge** | Step 2 (Intake) | 🟡 Phase 1 Week 2 |

Today's platform delivers ~55% of this workflow end-to-end. Phase 1 closes the remaining ~45% — concentrated in the Weekly Report and talk-time analytics.

---

## Lean 5-week plan

```
Week 1   Verify + Brief
         ├─ Pull + Republish on HostingPlatform
         ├─ Confirm today's 5 fixes work
         └─ Brief SDR team on consent + verification scripts

Week 2-3 Weekly Report (= enriched Overview tab)
         ├─ Date range filter (7d / 30d / 90d / custom)
         ├─ Agent rows sorted by gap-to-target
         ├─ Inline drill: top failed attrs, last 5 calls, trend, active plans
         ├─ Coaching Actions panel (Deliver / Nudge buttons)
         ├─ Critical Fails banner
         ├─ ContactCenterProvider "Suspended" badge in Intake section
         └─ CSV export

Week 4-5 Diarization + Talk-time analytics
         ├─ Diarize Whisper transcripts (Agent vs Customer)
         ├─ Compute talk ratio, silence, interruptions, pace
         ├─ Surface in Weekly Report agent rows + Call Details modal
         └─ Acid-test on 10 mixed-language sample calls

DONE.
```

**Total: ~5 weeks of focused engineering.**

---

## Investment Required

| Resource | Estimate |
|---|---|
| Engineering | ~5 weeks (~1 FTE equivalent at recent session pace) |
| External licensing | Zero — no new vendors, no SaaS subscriptions |
| Infrastructure | Existing HostingPlatform deployment is sufficient |
| AI/API spend increase | ~$50–100/month additional Whisper spend for talk-time analytics pass |
| SDR team time | One 45-min briefing on consent + 3-point verification scripts; ~6 seconds added to every call's opening |
| Manager time | ~10 min/week on the Weekly Report |

---

## Success Metrics (DMAIC Control Phase)

| Metric | Baseline (today) | Target (Week 5) |
|---|---|---|
| Hours/week Manager spends on QA | ~10h (manual side-by-side listening) | ~10 min (Weekly Report scan + 1–2 coaching deliveries) |
| Calls evaluated per week | ~10 manually | All uploaded calls evaluated automatically (~50+) |
| Coaching plans verified passing | 0 (no plans exist) | ≥ 60% within 30 days |
| Per-agent review cadence | Ad-hoc, often > 2 weeks between | Weekly via Weekly Report inline drill |
| Score consistency | Reviewer-dependent | Deterministic (LLM @ temp 0 + standardised rubric) |

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| SDR team adoption of consent + verification scripts lags | Medium | Phase 1 ships but the data is less meaningful | Pilot with 1–2 agents in Weeks 2–3; full rollout Weeks 4–5 |
| Speaker diarization quality is poor on Saudi-Arabic-with-code-switching | Medium | Talk-time analytics become unreliable | Pilot on 10 sample calls in Week 4; vendor fallback (AssemblyAI / Deepgram) ready |
| AI scores a call incorrectly, no human catches it | Medium | Individual call mis-scored; coaching plan triggered on bad data | Auto-coaching requires **3 fails in 14 days** — a single bad score cannot trigger a coaching event. If a systematic mis-scoring pattern emerges, sampling can be reintroduced as a follow-up amendment. |
| Engineering capacity drops below 1 FTE | Low–medium | Timeline extends 2–3x | Weekly status updates; defer non-critical items first |
| Manager doesn't check Weekly Report weekly | Low | Coaching plans pile up without delivery | Tracked via access logs; nudge mechanism for stale plans available as a follow-up |

---

## Next Steps for Validation

| Step | Owner | When |
|---|---|---|
| CTO approval to proceed with the 5-week plan | Sample User | This week |
| Verify today's existing fixes deployed | Operations team | This week |
| Brief SDR team on consent + 3-point verification scripts | SDR Manager | Week 1 |
| **Begin Phase 1 — Weekly Report build** | Engineering | Week 2 |
| Pilot the new opening scripts with 1–2 agents | SDR Manager + 1–2 SDRs | Weeks 2–3 |
| Monday status update (every week) | Engineering | Weekly through Week 5 |

---

## Approval

| Role | Name | Decision | Date |
|---|---|---|---|
| Operations & Quality HOD | Sample User | Sponsor — proceed | 2026-05-25 |
| CTO | Sample User | Pending | |

Once CTO approval is received, the 5-week build begins in Week 2.

---

## Supporting Documentation

All committed to `ExampleOrg/docs/`:

- `Call_Evaluation_Revamp_Plan_2026_05_25.md` — full technical plan (pre-lean version, for reference)
- `SDR_PDPL_Consent_Script_2026_05_25.md` — consent line for SDR opening
- `SDR_Verification_Step_2026_05_25.md` — 3-point lead verification step
- `Company_Domain_Strategy_2026_05_25.md` — separate workstream on domain as a CS primitive
- `Decision_Record_Close_Velents_Gaps_2026_05_25.md` — initial 10-week scoping
- `Decision_Record_Amend_Skip_P0_P15_2026_05_25.md` — 2nd amendment (skip PII redaction + deterministic compliance engine → 8 weeks)
- `Decision_Record_Amend_Skip_Digest_Merge_Agent_View_2026_05_25.md` — 3rd amendment (skip weekly digest + merge Agent View → 7 weeks)
- `Decision_Record_Amend_AI_Only_No_QA_Review_2026_05_25.md` — **4th amendment (AI-only, no QA review, Weekly Report core → 5 weeks)**
- `DMAIC_Call_Details_Unification_2026_05_25.md` — UI restructure (already shipped)
- `CRMProvider_OAuth_Setup_2026_05_25.md` — operational CRMProvider credentials playbook

---

## Closing

The platform already produces standardised AI scores for every call uploaded to it. What's missing is the **single Weekly Report** the Quality HOD can use to consume team performance, identify coaching gaps, and deliver structured interventions — without listening to calls, without reviewing AI scores, and without bouncing between tabs.

The case study above shows that workflow — from a Sunday morning call to a Wednesday verification — playing out in 9 concrete steps, on one screen, in under 10 minutes of manager time per week.

We are requesting **5 weeks** of engineering effort to close that gap. The Lean Six Sigma framing eliminates ~40% of the previously-scoped QA-workflow machinery; the remaining scope is the part that delivers actual operational value.
