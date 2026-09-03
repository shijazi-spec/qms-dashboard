# Decision Record — Amendment: AI-Only Evaluation, No QA Review, Weekly Report as Core

**Date:** 2026-05-25 (fourth amendment today)
**Decision-maker:** user@example.invalid (Operations & Quality HOD)
**Status:** Approved, amends prior decisions
**Lens applied:** Lean Six Sigma (DOWNTIME waste elimination)
**Supersedes:** `Decision_Record_Amend_Skip_Digest_Merge_Agent_View_2026_05_25.md` and the Phase 1 scope inside `Business_Case_Call_Evaluation_2026_05_25.md`

---

## What changed

The intent of the platform was clarified: **the AI scorecard is the source of truth, and the Quality Manager consumes the output — she does not double-check or override per-call evaluations.**

That single clarification collapses a large block of QA-workflow machinery that was either in the spec or planned for Weeks 6–7:

> **"All this approach to avoid double-check from my side as the Quality Manager. The scorecard is enough to evaluate the calls. I need the tool to minimise my monitoring directly with the SDR team and get a weekly report by their work."**

The product is now: **AI evaluates → Weekly Report consolidates → Manager intervenes only on coaching, not on per-call scoring.**

---

## Lean Six Sigma — DOWNTIME wastes eliminated

The previous QA-review-heavy approach contained seven of the eight TIMWOODS / DOWNTIME wastes. Each removal below is mapped to the waste it eliminates.

| Waste type | Where it appeared | Eliminated by |
|---|---|---|
| **D** — Defects (tracking) | Audit trail of QA overrides | No overrides exist → no audit trail needed |
| **O** — Over-processing | Every call gated through a QA reviewer | AI score is final |
| **W** — Waiting | "QA Review Pending" status holds calls in a queue | No queue exists |
| **N** — Non-utilised talent | Manager time on reviewing AI = inverse of goal | Manager only delivers coaching, not scores |
| **T** — Transportation | AI → queue → reviewer → final-marked | Direct: AI → Done |
| **I** — Inventory | Supervisor Action Queue with backlog | Section removed |
| **M** — Motion | 8-status processing pipeline | Collapsed to 3 |
| **E** — Extra-processing (features) | Confidence-flagging routes to non-existent queue | Visual cue only |

---

## What's REMOVED

### From the previously-proposed Call Evaluation spec

| # | Item | Why removed |
|---|---|---|
| 1 | 8-status processing pipeline (Uploaded / Transcribing / Transcribed / Evaluating / Evaluated / QA Review Pending / QA Reviewed / Failed) | Collapsed to 3: **Pending / Done / Failed**. The internal sub-steps are engineering states, not user-facing. |
| 2 | "QA Review Pending" + "QA Reviewed" statuses | No QA review step exists |
| 3 | "QA Reviewer" column in the evaluation table | No QA reviewer role |
| 4 | Entire QA Review Section (approve / override / coaching note from reviewer) | No human-in-loop |
| 5 | "Critical fail requires QA review before finalisation" gate | Critical fail just shows red and auto-triggers a coaching plan |
| 6 | Low-confidence → "Supervisor Action Queue" routing | Visual orange flag kept; queue removed |
| 7 | Filter: "Needs QA review" | No such status |
| 8 | KPI card: "QA review pending" | No such status |
| 9 | Supervisor Action Queue — entire section | Replaced by Weekly Report |
| 10 | `final_reviewer`, `evaluator_type` columns on scorecard storage | Always AI → constant, not a stored value |
| 11 | Audit Trail of QA overrides | No overrides exist |

### From the current 7-week plan (3rd amendment)

| # | Item | Why removed |
|---|---|---|
| 12 | **Week 6 — QA Inbox** (sampling / override / calibrate workflow) | The whole feature presumes a human reviewer. Inverse of the goal. |
| 13 | **Week 7 — Cohen's κ tracking** | κ measures human-vs-AI agreement. With no human evaluator, κ is undefined. |
| 14 | **Week 7 — "Rubric self-tunes from manager override data"** | No override data → nothing to self-tune from |

**Total: 14 removals.** Net plan duration drops from **7 weeks → ~5 weeks.**

---

## What's KEPT

The platform that remains is intentionally narrow and focused on the actual goal:

| # | Capability | Status |
|---|---|---|
| 1 | Intake — Manual Upload (primary) + CSV Import (secondary) + ContactCenterProvider visible-but-suspended | ✅ Built; ContactCenterProvider needs the suspended badge |
| 2 | Auto-pipeline: Upload → Transcribe → Score → Done (no human gate) | ✅ Built |
| 3 | Evaluation Table: Agent · Date · Duration · Source · Score% · Compliance% · Critical Fail Y/N · View | ✅ Mostly built; Critical Fail flag column = new |
| 4 | Evaluation Modal: Summary + Transcript + Scorecard + Compliance + Recording (no QA review section) | ✅ Built |
| 5 | Auto-coaching trigger (3 fails in 14 days → coaching plan created) | ✅ Built |
| 6 | Auto-verification on next eval (plan → verified_passing / verified_failing_again) | ✅ Built |
| 7 | Diarization + Talk-time analytics (Week 4–5) | 🟡 Phase 1 |
| 8 | Filters: Date · Agent · Campaign · Score < X · Compliance < X · Critical Fail only | 🟡 Phase 1 |
| 9 | KPI Cards (5): Total Calls · Avg Score · Avg Compliance · Critical Fails · Coaching Plans Pending Delivery | 🟡 Phase 1 |
| 10 | Empty / Error states | ✅ Built |
| 11 | **Weekly Report — the new core feature** (replaces leaderboard as the home page) | 🟡 Phase 1 |

---

## The new core feature: **Weekly Report**

This is what makes the AI-only model work. One screen, opened Monday morning, ~6 minutes to scan.

```
Week of May 18–24, 2026   |   52 calls scored   |   Team avg 71%   |   3 critical fails   |   2 coaching plans pending delivery

[ 8-week team-avg trend line ]

═══ Agents (sorted by gap-to-target 75%) ═══════════════════════════════════════

Sample User    | 12 calls | 62% ↓ | 78% comp. | 1 critical | 1 plan pending
  ↳ Top failed attrs: Objection Handling (4×), Closing (3×), Discovery (2×)
  ↳ Talk-time: 64%  (team median 45%) — too dominant
  ↳ Last 5 scores: 58, 64, 60, 68, 62
  ↳ [Deliver Coaching Plan]

Sample User     | 9 calls  | 91% ↑ | 100% comp. | 0 critical | 0 plans
  ↳ Top performer this week

Mona      | 8 calls  | 78%   | 92%  comp. | 0 critical | 1 plan pending (Discovery)
  ↳ [Deliver Coaching Plan]

═══ Coaching actions this week ═══════════════════════════════════════════════

• Sample User — Objection Handling (4 failed-call evidence) → [Deliver]
• Sample User — Discovery plan (3 failed-call evidence) — awaiting delivery for 5 days → [Nudge]

[ Export full report as CSV ]
```

That is the manager's Monday morning, end-to-end:

| Time | Action |
|---|---|
| 8:00 | Opens `<REDACTED_HOST>/calls` → Weekly Report |
| 8:01 | Scans header + 8-week trend |
| 8:02 | Scans agent rows, sorted by gap-to-target |
| 8:03 | Clicks **Deliver** on Sample User's plan → coaching modal opens with evidence pre-loaded |
| 8:05 | Captures Sample User's commitment + follow-up date → **Mark Delivered** |
| 8:06 | Clicks **Deliver** on Sample User's plan, same flow |
| 8:10 | Closes tab. Weekly review complete. |

**Total: ~10 minutes** for the entire team's weekly review.

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

**Total: ~5 weeks of focused engineering.** Down from 7.

---

## What's NOT in the plan after this amendment (full audit trail)

| Deferred | Why | Re-trigger |
|---|---|---|
| QA Inbox (sampling, manual review workflow) | AI is the evaluator; no manager-review step in the loop | If audit asks for an independent review control |
| Cohen's κ tracking | Measures human-AI agreement; with no human evaluator, undefined | If/when QA review is reintroduced |
| Rubric self-tuning from override data | No overrides exist → no data to tune from | Same as above |
| Manual QA override workflow | Inverse of the goal | If a critical scoring failure case emerges that needs manual correction |
| Audit Trail of overrides | No overrides → nothing to audit-trail | Same as above |
| 8-status processing pipeline | Engineering states, not user-facing | If support tickets begin asking "where is my call right now?" |
| Real-time ContactCenterProvider webhook + scheduled pulls | Vendor integration suspended (technical team) | When Tech Team unblocks ContactCenterProvider access |
| **PII redaction in transcripts** (from 2nd amendment) | PDPL Article 18 risk accepted while internal-only | Audit notice / wider access / external export |
| **Deterministic compliance engine** (from 2nd amendment) | Manager spot-check is sufficient at current scale | Team growth / inconsistent script adoption / audit ask |
| **Weekly PDF digest + ChatProvider alerts** (from 3rd amendment) | Manager opens dashboard directly Monday morning | If dashboard access cadence drops below 1× per week |
| **Standalone Agent View / Team View pages** (from 3rd amendment) | Folded into Weekly Report inline drill-down | If Weekly Report becomes too crowded (50+ agents) |

---

## Why this is the right call

| Argument | Detail |
|---|---|
| **Aligned with the actual job-to-be-done** | The HOD's job is to *reduce direct monitoring* of SDRs, not to *do more* of it. The QA-review workflow was the opposite of that goal. |
| **Lean Six Sigma** | Eliminates 7 of the 8 DOWNTIME waste types. The remaining waste (Defects) is mitigated by the AI being the consistent evaluator — same rubric every call. |
| **Cheaper to ship** | 5 weeks instead of 7. Two weeks of avoided engineering. |
| **Cheaper to operate** | Manager time drops from ~10 hours/week (manual side-by-side listening) to ~10 minutes/week (Weekly Report scan + 1–2 coaching deliveries). |
| **Reversible** | If the AI's scoring quality becomes a problem at scale, the QA-review workflow can be added later (it was already scoped). The reverse — building it now and then deleting it — is more expensive. |

---

## Trade-off accepted

**No human spot-check of AI scoring.** The system's outputs are not independently validated by a human reviewer. This is acceptable because:

1. The rubric is the COPC v2 scorecard, an industry-standard framework
2. The LLM evaluator uses temperature 0 (deterministic) on the same prompt
3. Sample auditing can be reintroduced if needed (see Re-trigger above)
4. The platform is GRQ-internal-only — no external party consumes the scores

The risk being accepted is: **AI gives a wrong score on an individual call, no one catches it, and a coaching plan is generated (or not) on bad data.** The mitigation is the auto-coaching trigger requires **3 fails in 14 days** before generating a plan — a single misscored call cannot trigger a coaching event on its own.

---

## Sign-off

a.amashah (Operations & Quality HOD) — approved 2026-05-25 (fourth same-day amendment, with Lean Six Sigma framing)

The business case will be rewritten in the same commit to reflect the lean 5-week scope.
