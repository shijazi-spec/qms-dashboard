# Business Case — In-House Call Evaluation Platform (Phase 1: 8-Week Build)

**Prepared for:** Sample User (CTO), ExampleOrg
**Prepared by:** Sample User (Operations & Quality HOD)
**Date:** 2026-05-25
**Status:** Awaiting CTO approval to proceed
**Builds on:** CTO approval of the Five9 Scorecard initiative dated Aug 31, 2025 (per WalaaPlus<>Velents email thread)
**Supersedes vendor path:** Velents engagement paused Nov 26, 2025 in favour of an internally-owned solution

---

## Executive Summary

We are requesting approval to **build the next 8-week phase** of the in-house Call Evaluation platform that has been developed inside `<REDACTED_HOST>/calls` over the past months. This phase delivers the **manager-reportable layer** that has been the missing piece since the Aug 17, 2025 business case — converting an existing scoring engine into a tool that the SDR Manager and Quality Lead can actually use to run a weekly review cycle.

This is the **direct internal substitute** for the Velents AI-QA product you approved in Aug 2025 and that the Operations team paused in Nov 2025 in favour of an internally-owned solution. Sample User's Nov 26 closure email cited *"long-term governance direction"* — this business case operationalises that direction.

**Ask:** approval for ~8 weeks of focused engineering effort to deliver functional parity with ~68% of the Velents scope. No vendor licensing, no new infrastructure costs, no external data sharing.

---

## User Story

> **As the Head of Operations & Quality at ExampleOrg,**
>
> we want a fully-internal Call Evaluation platform that produces a **weekly manager-reportable digest**, a **per-agent performance dashboard**, **team-level coaching visibility**, and **conversation-intelligence signals** (talk-time, sentiment, topic clusters),
>
> **so that** the SDR Manager can run a structured weekly review of 50+ calls in under 30 minutes, identify the agents who need coaching, deliver that coaching with auto-generated plans, and verify behaviour change on the next call — all without leaving the platform, without manual side-by-side listening, and without sharing data with a third-party vendor.

---

## Business Case

### 1. Problems Identified

The existing QA workflow has six structural problems that the Aug 17 business case partially addressed and that the in-house build has resolved technically but not yet operationally:

| # | Problem | Today's pain | Impact |
|---|---|---|---|
| 1 | Manual QA via side-by-side listening | 1 reviewer × 199 calls = ~50 hours of listening per month at current volume | Time-consuming, error-prone, doesn't scale |
| 2 | No standardised per-call score | Reviewers grade against subjective memory of "what good looks like" | Bias, inconsistency, inter-rater disagreement |
| 3 | No manager-reportable artifact | The SDR Manager has no single document or dashboard to run a weekly review meeting from | Reviews are ad-hoc; coaching is reactive not proactive |
| 4 | No per-agent dashboard | To evaluate one SDR's recent week, manager must click through 4 different tabs | Discourages frequent review; weakens coaching cadence |
| 5 | Coaching loop isn't measurable | Plans get created, delivered, then forgotten — no verification on the next call | Coaching effort goes uncredited; agents don't see the system "working" |
| 6 | No conversation intelligence (talk-time, pace, interruptions) | The single most predictive SDR signal — agent talk ratio — is invisible | Decisions made on lagging indicators (score, outcome) instead of leading indicators (behaviour) |

### 2. Why Build Internally (Re-validating the Nov 26 Decision)

The Nov 26, 2025 decision to pause the Velents engagement was correct. Three reasons it still holds:

**a) Governance ownership.** PDPL compliance, COPC certification, and any future audit are easier to defend with a system whose source code, data model, and decision logic are inside our control. With Velents, every audit question would have required vendor cooperation; with the in-house build, every question is answerable from inside the company.

**b) Data residency.** Velents hosts on GCP Dammam (per their Aug 29 reply); ExampleOrg already has PDPL-aligned hosting via Replit Saudi region. Eliminates a cross-vendor data-movement question that auditors typically probe.

**c) Vendor risk.** Velents engagement showed scope-creep and timeline drag (Aug → Nov with no working environment delivered). An in-house team controls its own delivery cadence and feature scope. We have already proven this — the existing platform (`<REDACTED_HOST>/calls`) was built and is being used today, while the equivalent Velents environment never came online.

### 3. Proposed Solution — Phase 1, 8-Week Build

The platform today has the **scoring engine** (Whisper transcription, COPC v2 scorecard, automatic SDR evaluation, working coaching loop, CRM compliance auditing). This phase adds the **manager cockpit**: the surfaces and workflows that make the engine usable by a human running a Monday-morning review.

#### Week-by-week delivery

| Week | Deliverable | Manager-visible outcome |
|---|---|---|
| **Week 1** | Verify existing fixes + brief SDR team on the consent + 3-point verification scripts (drafted but not yet rolled out) | Coaching tab works end-to-end; SDR team has the new opening procedure |
| **Weeks 2-3** | **Reports surface** — weekly PDF digest emailed every Monday, Slack alerts on critical fails, CSV export of any agent's history, drill-down from digest line → call → coaching plan | SDR Manager receives "this week's report" automatically every Monday morning |
| **Weeks 4-5** | SDR pilot (1-2 agents adopt the new opening; manager reviews 5 calls per agent weekly) | Real-world adoption data; refined script wording |
| **Weeks 5-6** | **Agent View + Speaker Diarization + Talk-Time Analytics** | One page per SDR with scorecard trend, all calls, coaching plans, peer benchmark, AND talk-time stats ("Sample User 65% of calls vs team median 45%"). The Gong/Chorus core insight finally available internally. |
| **Week 7** | **Team View + QA Inbox** | Manager's home page: agent leaderboard sorted by gap-to-target, weak attributes across the team, "10 calls to review this week" with random sampling |
| **Week 8** | **IA cleanup + COPC v2 polish + Cohen's κ tracking** | The 7-tab navigation collapses to 4 clean surfaces. ~600 lines of legacy code deleted. The AI rubric starts learning from manager overrides. |

#### Explicit scope decisions

In scope:
- All six week-by-week deliverables above
- Speaker diarization (agent vs customer audio separation)
- Talk-time analytics (silence, interruptions, pace, talk ratio)
- Manager-reportable PDF digest + Slack alerts + CSV exports
- Per-agent and team-level dashboards
- Cohen's κ AI-vs-manager agreement tracking for rubric tuning

Out of scope (deferred with documented re-trigger conditions):
- **PII redaction in transcripts** — defensible while platform is GRQ-internal only; re-evaluate if access widens to non-GRQ stakeholders or if audit notification arrives
- **Deterministic compliance engine** (auto-fail on missing consent line / prohibited words) — defensible at current team size where manager spot-check is sufficient; re-evaluate if team scales beyond ~5 SDRs × 50 calls/week
- **Five9 live webhook ingest** — Phase 2 candidate; current filename-parsed bulk upload is sufficient for historical and weekly batches
- **KB/FAQ knowledge checks** — requires a knowledge-base ingestion pipeline that doesn't exist yet
- **BI exports** (Snowflake/Power BI) — only relevant if ExampleOrg builds a corporate data warehouse

Net coverage: approximately **68% of the Velents proposed scope**, prioritising operational visibility over compliance enforcement. Full gap analysis in `docs/Velents_vs_Internal_Build_Gap_Analysis_2026_05_25.md`.

### 4. Expected Benefits

| Benefit | Quantified target | How measured |
|---|---|---|
| **Manager time saved** | Reduce weekly QA review from ~10 hours → <1 hour (one Monday digest read + a few drill-downs) | Self-reported, sampled weekly |
| **Manual listening eliminated** | ~70% reduction (matches the Aug 17 commitment to the CTO) | Hours-spent estimate before vs after rollout |
| **Coaching loop closure rate** | ≥60% of generated coaching plans reach "verified passing" or "dismissed with reason" within 30 days | Auto-tracked in `coaching_plans` lifecycle states |
| **Per-SDR review cadence** | Each agent reviewed at least once per week (currently: ad-hoc, often >2 weeks between reviews) | Auto-tracked via QA Inbox sampling |
| **Manager-visible compliance rate** | The Overview Compliance Rate KPI populates with a real number (today: "--") | Dashboard observation |
| **Inter-rater agreement (AI vs Manager)** | Cohen's κ ≥ 0.6 after 4 weeks of manager overrides feeding back into rubric | Auto-computed weekly |
| **Talk-time visibility** | Per-agent talk ratio visible on every call AND aggregated on Agent View | Dashboard observation |

### 5. Investment Required

| Resource | Estimate |
|---|---|
| **Engineering effort** | ~8 weeks of focused work at the pace of recent sessions (~1 FTE-equivalent) |
| **External licensing** | Zero. No vendor contracts, no SaaS subscriptions added. |
| **Infrastructure** | Existing Replit deployment is sufficient. No new compute or storage required. |
| **AI/API spend increase** | ~20% increase in monthly Whisper API spend due to talk-time analytics pass on every call. Estimated $50-100/month additional based on current call volume. |
| **Vendor decision** (Week 7) | Choose between in-house diarization (free, more setup) or AssemblyAI/Deepgram ($0.01-0.02 per minute, instant). One-hour decision, formal trade-off written before commitment. |
| **Team time** | SDR Manager attends one 45-min briefing on the consent + verification scripts. SDR agents adopt the new opening (~6 seconds added to every call). |

### 6. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| SDR team doesn't adopt the consent + verification script by Week 5 | Medium | Delays nothing engineering-wise, but Phase 2 (compliance enforcement, deferred) would have to wait | Manager-led adoption monitoring; pilot in Weeks 2-3 with 1-2 agents before full rollout |
| Speaker diarization quality is poor on Saudi-Arabic-with-code-switching audio | Medium | Talk-time analytics become unreliable | Pilot diarization on 10 sample calls in Week 6; fallback to AssemblyAI/Deepgram if pyannote underperforms |
| Engineering capacity drops below 1 FTE | Low-medium | Timeline extends 2-3x | Communicate cadence weekly; defer P5 (κ tracking) first if needed |
| Zoho sync staleness (recently observed) persists | Low | Per-call data freshness is stale for users | Documented separately; will be addressed if it becomes recurring |
| PDPL audit lands during the 8-week window | Low | Deferred P0 (PII redaction) becomes urgent | Documented re-trigger conditions in the Decision Record; emergency 1-week sprint to add PII redaction |

### 7. Success Metrics (DMAIC Control Phase)

The Aug 17 business case promised five benefits. Here is how each will be measured after the 8-week build:

| Aug 17 commitment | How we'll know it worked |
|---|---|
| Efficiency: ≥70% reduction in manual QA effort | Manager logs self-reported time-on-QA, weekly. Compare Week 1 baseline vs Week 10. |
| Consistency: Eliminate evaluator bias | Cohen's κ (AI vs manager) tracked weekly. Target ≥0.6 by Week 8. |
| Coaching: Skill-gap identification | Coaching loop closure rate. Target ≥60% within 30 days. |
| Governance: CRM-tied auditability | Already shipped (auto-link + activity timeline + event_logs). Audit by sampling 10 random calls and tracing each one through the audit log end-to-end. |
| Scalability: Hundreds of weekly calls | Stress-test in Week 8 with synthetic 500-call upload. Pass if all surfaces render in <3 seconds. |

### 8. Comparison to Velents Proposal

| Dimension | Velents (Nov 2025 proposal) | This 8-week internal build | Difference |
|---|---|---|---|
| Coverage of Sample User's Aug 17 scope | ~95% | ~68% | -27 percentage points (concentrated in PDPL enforcement, deferred deliberately) |
| Time to operational | Unknown (no environment delivered in 4 months) | 8 weeks from approval | Internal delivers; vendor did not |
| Annual cost | TBD (no commercial offer received) | ~$600-1,200/year (Whisper API increase) | Significant savings |
| Vendor lock-in | High (proprietary platform) | Zero | Internal advantage |
| Data residency | GCP Dammam (Velents) | Replit Saudi (existing) | Equivalent |
| PDPL audit defence | Through vendor | Direct, no intermediary | Internal advantage |
| Customisability | Limited to vendor's roadmap | Unlimited, in our codebase | Internal advantage |

---

## Next Steps for Validation

1. **CTO approval to proceed** with the 8-week plan as scoped above (target: this week)
2. **Verify the existing fixes deployed today** (RBAC + Coaching tab + simplified roles) — 60-second check by the Operations team
3. **Brief the SDR team** on the consent + 3-point verification scripts (single 45-min meeting, Week 1)
4. **Start Phase 1.1: Reports surface** Week 2
5. **Monday status updates** every week, covering deliverables shipped, blockers, decisions needed

---

## Documents in this initiative

All committed to `ExampleOrg/docs/`:

- `Call_Evaluation_Revamp_Plan_2026_05_25.md` — the full 1,029-line technical revamp plan
- `Velents_vs_Internal_Build_Gap_Analysis_2026_05_25.md` — gap analysis vs the rejected vendor scope
- `Decision_Record_Close_Velents_Gaps_2026_05_25.md` — original phase-funding decision
- `Decision_Record_Amend_Skip_P0_P15_2026_05_25.md` — scope amendment skipping P0 (PII redaction) and P1.5 (deterministic compliance engine)
- `SDR_PDPL_Consent_Script_2026_05_25.md` — the consent line to add to the SDR opening
- `SDR_Verification_Step_2026_05_25.md` — the 3-point verification step (name + work email + company)
- `DMAIC_Call_Details_Unification_2026_05_25.md` — yesterday's UI restructure already shipped
- `Company_Domain_Strategy_2026_05_25.md` — separate workstream on using domain as a CS primitive
- `Zoho_OAuth_Setup_2026_05_25.md` — operational playbook for Zoho secrets

---

## Approval

| Role | Name | Decision | Date |
|---|---|---|---|
| Operations & Quality HOD | Sample User | Sponsor — proceed | 2026-05-25 |
| Quality Manager | Sample User | Pending (cc on this doc) | |
| CTO | Sample User | Pending | |

Once CTO approval is received, Phase 1.1 (Reports surface) begins Week 2.

---

## Closing Note

This is the operational follow-through on the Nov 26 commitment to *"pursue a solution that can be fully owned and managed internally to align with our long-term governance direction."* The engine already works. This 8-week phase builds the cockpit that makes it usable.

We are not asking for new budget, new vendors, new infrastructure, or external data sharing. We are asking for the time to finish what was started in August — and to deliver, internally, what Velents could not deliver in four months.
