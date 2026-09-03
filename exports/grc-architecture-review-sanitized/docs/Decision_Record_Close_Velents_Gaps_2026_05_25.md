# Decision Record — Close the Velents Gaps

**Date:** 2026-05-25
**Decision-makers:** user@example.invalid (Operations & Quality HOD)
**Status:** Approved, not yet implemented
**References:**
- `docs/Velents_vs_Internal_Build_Gap_Analysis_2026_05_25.md` (the gap analysis)
- `docs/Call_Evaluation_Revamp_Plan_2026_05_25.md` (the revamp plan being amended)
- WalaaPlus<>Velents email thread (Jul 31 – Nov 26, 2025) — the historical context

---

## The decision

Fund **three new phases** in the Call Evaluation revamp plan to close the gaps between ExampleOrg's in-house build and the Velents proposal Sample User with the CTO on Aug 17, 2025.

| New phase | What it adds | Tier | Effort |
|---|---|---|---|
| **P0** | **PII redaction in transcripts** — regex/NER pass over Whisper transcripts to mask Saudi national IDs, phone numbers, IBAN, email, customer names. Reversibility per policy (irreversible by default for PDPL safety). | 🔴 Compliance critical | ~1 week |
| **P1.5** | **Deterministic compliance engine** — phrase-matching against mandatory script lines (PDPL consent, 3-point verification) + prohibited words + auto-fail rules. Engine integrates with the existing COPC v2 scorecard so a missed consent line auto-fails the call regardless of LLM rubric score. | 🔴 Enforces existing scripts | ~3-5 days |
| **P2.5** | **Speaker diarization + talk-time analytics** — diarize Whisper output (likely via pyannote or vendor switch to AssemblyAI/Deepgram). Compute agent-vs-customer talk ratio, silence, interruptions, pace. Surface on Agent View + per-call modal. | 🟡 Coaching signal | ~1 week |

**Total scope added: ~3 weeks of focused work.**

---

## Updated revamp roadmap

```
P0   ▶ PII redaction in transcripts (NEW)                          ◀ PDPL Art 18 defence
P1   ▶ Reports surface + daily digest + real-time alerts
P1.5 ▶ Deterministic compliance engine (NEW)                       ◀ enforces consent + verification scripts
P2   ▶ Agent View + talk-time analytics inline
P2.5 ▶ Speaker diarization (NEW)                                   ◀ Gong/Chorus signal parity
P3   ▶ Team View + QA Inbox (sampling workflow)
P4   ▶ IA cleanup + tech-debt deletion
P5   ▶ COPC v2 polish + Cohen's κ for rubric tuning
```

End state: ExampleOrg's in-house build delivers functional parity with Velents's Aug 17 commitments, at zero vendor risk + zero data-residency exposure + full PDPL governance control.

---

## Why these three (and not the others)

The full Velents scope had ~15 gap-points. We're funding the **9 most QMS-relevant** ones. Deferring:

- ❌ **KB/FAQ knowledge checks** — useful but requires KB ingestion + semantic search; not core to compliance
- ❌ **BI exports** (Snowflake/Power BI) — only relevant if ExampleOrg connects to a corporate data warehouse, which doesn't exist yet
- ❌ **Reversible PII hashing** — irreversible is sufficient for PDPL; reversibility adds complexity without QMS value
- ❌ **Sentiment shifts** (chunked) — nice-to-have, not core
- ❌ **Cohen's κ real-time dashboard** — κ should INFORM rubric tuning (in P5), not be a manager-facing metric

These can be revisited in 2026 H2 if budget allows.

---

## Pre-conditions before starting P0

Two things must happen FIRST before any P0/P1.5/P2.5 work begins:

### Pre-condition 1 — Today's existing fixes verified live

Several commits from today's session (`e78bb5d`, `bf98a02`, `adc305f`, `7d738bf`, `f82defe`) are on `origin/QMS` but the user hasn't yet confirmed they're working in the deployed app. Specifically:

- [ ] Coaching tab loads without "Failed to load HTTP 401"
- [ ] Performance vs Team agent picker renders
- [ ] Backfill Dates + Backfill CRM Compliance buttons execute successfully
- [ ] Open/Closed Activities panel inside Call Details populates from CRMProvider
- [ ] "Run compliance now" no longer hits RBAC error

These need to be confirmed before adding more scope. If any are still broken, fix them before P0.

### Pre-condition 2 — PDPL consent + 3-point verification scripts rolled out to SDR team

The two SDR script docs (`SDR_PDPL_Consent_Script_2026_05_25.md` + `SDR_Verification_Step_2026_05_25.md`) are drafted but NOT yet briefed to the team.

P1.5 (deterministic compliance engine) ENFORCES these scripts. Building the engine before agents are even saying the lines = the engine flags every single call as a failure = unusable metric.

**Sequence:**
1. Brief the SDR team on both scripts (single 45-min meeting)
2. Pilot for 1-2 weeks with 1-2 agents
3. Full rollout
4. THEN build P1.5 — by which point the dataset has signal

This puts P1.5 ~3-4 weeks out from today, not "next week."

### Pre-condition 3 — ContactCenterProvider / CRMProvider data freshness loop verified

If sync lag remains the issue we saw today (Duplicate Radar showing 25-day-stale data), P2.5 talk-time analytics will compute against stale recordings. Worth verifying the sync cadence before adding compute-heavy diarization.

---

## Suggested sequencing

| Week | Work |
|---|---|
| **Week 1** | Verify today's fixes live + brief SDR team on consent + verification scripts |
| **Week 2** | **Start P0** — PII redaction pipeline. Independent of script rollout. Closes the PDPL audit risk fastest. |
| **Week 3** | Continue P0 + parallel start of **P1** (Reports surface) — also script-independent. |
| **Week 4-5** | SDR scripts piloted. Manager reviews live. |
| **Week 5-6** | Full rollout of SDR scripts. |
| **Week 6** | **Start P1.5** (deterministic compliance engine). Now the dataset has compliant calls to score against. |
| **Week 7-8** | **P2 + P2.5** (Agent View + diarization + talk-time). Heaviest piece. |
| **Week 9** | **P3** (Team View + QA Inbox). |
| **Week 10** | **P4** cleanup, **P5** polish. |

Total: ~10 weeks from today's date to full Velents-parity in-house build.

---

## Budget and resourcing

Open question for you to answer: **who's doing this work?**

The above timeline assumes ~1 full-time engineer (me, via this session's pace). If that's not realistic — engineering shared across other priorities — multiply the timeline by 2-3x.

Other resourcing considerations:
- **Whisper API costs** increase with P0 (PII redaction may require a second pass) and P2.5 (diarization, depending on whether we use pyannote in-house or AssemblyAI/Deepgram).
- **AssemblyAI/Deepgram vs Whisper** — switching the ASR provider for diarization is a decision in P2.5. Worth a separate spike before committing.
- **Compute** — current HostingPlatform deployment is probably sufficient. If Whisper batch jobs become heavy, may need a dedicated worker.

---

## Sign-off

- a.amashah (Operations & Quality HOD) — approved 2026-05-25 via chat
- CTO Sample User — not yet briefed. Recommend a 30-min walkthrough of this doc + the gap analysis before starting P0, since the CTO originally approved the Velents-equivalent scope in Aug 2025 and this is the implementation choice for delivering against that approval.

---

## What gets committed next

Nothing yet — this is a **plan-only** commit. The 3 phases (P0, P1.5, P2.5) will each become their own pull request when work begins. This decision record exists so the audit trail explains why those PRs exist.
