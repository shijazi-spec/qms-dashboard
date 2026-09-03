# Decision Record — Amendment: Skip P0 (PII Redaction) and P1.5 (Deterministic Compliance Engine)

**Date:** 2026-05-25 (same-day amendment)
**Decision-maker:** <REDACTED_EMAIL> (Operations & Quality HOD)
**Status:** Approved, amends prior decision
**Supersedes:** `docs/Decision_Record_Close_Example Organization_Gaps_2026_05_25.md` (P0 + P1.5 sections only)

---

## What changed

After reviewing the original Decision Record committed earlier today, the user dropped two of the three new phases from scope:

- ❌ **P0** — PII redaction in transcripts (was: 1 week, PDPL Article 18 defence)
- ❌ **P1.5** — Deterministic compliance engine (was: 3-5 days, enforces PDPL consent + 3-point verification scripts)

P2.5 (speaker diarization + talk-time analytics) remains in scope.

## Net roadmap change

Original (Decision Record v1): 10 weeks. New: **8 weeks**.

```
Original                                 Amended
────────                                 ────────
Week 1   Verify + Brief                   Week 1   Verify + Brief
Week 2-3 P0 (PII) + P1 (Reports)          Week 2-3 P1 (Reports) only
Week 4-5 SDR Pilot                        Week 4-5 SDR Pilot
Week 6   P1.5 (Compliance Engine)         (skipped)
Week 7-8 P2 + P2.5 (Agent + Diarization)  Week 5-6 P2 + P2.5
Week 9   P3 (Team + QA Inbox)             Week 7   P3
Week 10  P4 + P5                          Week 8   P4 + P5
```

## Trade-offs accepted (for the audit trail)

### Skipping P0 — PII redaction

| Aspect | Position |
|---|---|
| Risk skipped | PDPL Article 18 (data minimisation) — transcripts continue to store customer PII verbatim |
| Why it's defensible today | Platform is GRQ-team-internal only. No external stakeholders or auditors viewing transcripts. Audit exposure is regulatory potential, not immediate breach. |
| What re-opens this decision | (a) SDAIA audit notification, (b) opening dashboard access to non-GRQ stakeholders, (c) any export of raw transcripts externally, (d) breach incident, (e) PDPL Article 30 controller-obligation review |
| Estimated re-add cost if re-funded | ~1 week of engineering, plus a transcript rewrite pass over the historical 199 records (~30 min of compute) |

### Skipping P1.5 — Deterministic Compliance Engine

| Aspect | Position |
|---|---|
| What's not enforced | PDPL consent line, 3-point verification questions (name + work email + company), prohibited-words alerts, auto-fail rules for severe breaches |
| Compensating control | Managers spot-check during the existing manager-review workflow. SDR scripts (already drafted in `SDR_PDPL_Consent_Script_2026_05_25.md` + `SDR_Verification_Step_2026_05_25.md`) become advisory rather than auto-enforced. |
| Why it's defensible today | Team is small enough that manual review catches most issues. The COPC v2 scorecard's LLM rubric will still flag a missed consent line via natural-language scoring — just not deterministically. |
| What re-opens this decision | (a) Team growth beyond what managers can spot-check (~5+ SDRs making 50+ calls each per week), (b) inconsistent script adoption observed during the SDR pilot, (c) compliance audit asking *"show me your control for ensuring consent is captured"* |
| Estimated re-add cost if re-funded | ~3-5 days — same as original estimate; the engine is self-contained |

## What remains in scope (the 8-week roadmap)

| Phase | Week | Deliverable |
|---|---|---|
| Verify + Brief | 1 | Today's fixes verified live + SDR team briefed on consent + verification scripts |
| **P1** — Reports surface | 2-3 | Weekly PDF digest auto-emailed to SDR Manager. ChatProvider alerts on critical fails. CSV exports. |
| **SDR Pilot** | 4-5 | 1-2 agents adopt consent + verification opening |
| **P2** — Agent View | 5-6 | One-page-per-SDR dashboard. Replaces 4 tabs of clicking. |
| **P2.5** — Speaker diarization + talk-time analytics | 5-6 (parallel) | Agent vs customer talk ratio, silence, interruptions. The Gong/Chorus signal. |
| **P3** — Team View + QA Inbox | 7 | Manager's home page: leaderboard, weak areas, coaching backlog. Random sampling queue for reviews. |
| **P4** — IA cleanup | 8 | 7 tabs → 4 surfaces. ~600 lines of legacy code deleted. |
| **P5** — COPC v2 polish + Cohen's κ | 8 | Rubric self-tunes from manager override data. |

## Net delivery vs Example Organization's original scope

| Pillar (from Example Organization proposal) | After 8-week plan | Closes Example Organization gap? |
|---|---|---|
| 1 — Ingestion | 1.5 / 3 (no live ContactCenterProvider webhook still) | No change |
| 2 — ASR | 2 / 4 (diarization added in P2.5, PII redaction skipped) | Partial — diarization closes, PII stays open |
| 3 — Enrichment | 2.5 / 3 (talk-time added in P2.5) | Mostly — KB checks still deferred |
| 4 — Scorecard engine | 3 / 5 (rubric polish + κ added, deterministic checks skipped) | Partial |
| 5 — QA Calibration | 1.5 / 2 (QA Inbox added, κ added) | Mostly closed |
| 6 — Outputs | 5 / 6 (Reports surface, digest, alerts, exports — BI not added) | Mostly closed |
| **Total** | **~15.5 / 23 (~68%)** | Original 35% → 68%, gap narrows by half |

The amended plan delivers **~68% of Example Organization's original scope** vs **~75% with the full P0/P1.5/P2.5 plan**. The skipped 7 points are concentrated in the compliance-enforcement dimension.

## Communication note for CTO briefing

If/when this plan goes to the CTO (Sample User) for awareness, the framing should be:

> *"We're delivering operational and coaching capabilities through an 8-week roadmap that brings us to ~68% of the Example Organization scope you originally approved in Aug 2025. We deliberately deferred two PDPL/compliance-enforcement phases (PII redaction + deterministic compliance engine, ~10 days combined) because the platform is GRQ-internal today and manual manager review is sufficient at our current team size. We'll re-evaluate both if (a) audit notification arrives, (b) team scales past spot-check capacity, or (c) we open access beyond GRQ."*

That framing is honest, defensible, and matches the actual decision.

## Sign-off

- Sample User (Operations & Quality HOD) — approved 2026-05-25 (amendment to same-day Decision Record v1)
