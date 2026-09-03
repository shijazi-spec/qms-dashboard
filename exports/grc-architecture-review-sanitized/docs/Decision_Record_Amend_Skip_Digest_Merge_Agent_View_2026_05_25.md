# Decision Record — Amendment: Skip Weekly Digest, Merge Agent View into Overview

**Date:** 2026-05-25 (third amendment today)
**Decision-maker:** user@example.invalid (Operations & Quality HOD)
**Status:** Approved, amends prior decisions
**Supersedes:** `docs/Business_Case_Call_Evaluation_2026_05_25.md` (Phase 1 scope)

---

## What changed

Two further scope reductions to the 8-week plan, dropping it to **~7 weeks** with a simpler information architecture:

### 1. Skip the weekly PDF digest + Slack alerts

| Aspect | Position |
|---|---|
| What's dropped | Weekly PDF digest auto-emailed to SDR Manager every Monday. Slack alerts on critical compliance fails. |
| What stays | CSV export functionality (small piece) |
| Why it's defensible | Manager will open the dashboard directly on Monday morning. Adding PDF generation, email delivery, and Slack alert routing adds operational complexity (cron, email infrastructure, Slack token) without unique value over a fresh dashboard view. |
| When to revisit | If manager review cadence slips (e.g. dashboard not opened weekly) — the digest becomes the proactive push mechanism. Tracked via dashboard access logs. |

### 2. Merge Agent View into the Overview tab

| Aspect | Position |
|---|---|
| What's changed | The previously-planned standalone "Agent View" page (`/agent/<email>`) is folded into an **enriched Overview tab** with date filtering, agent leaderboard, and inline per-agent drill-down |
| Why it's better | One destination, not two. Managers don't learn a new URL. Comparing across agents is easier when they're all visible on the same page. The "expand to see details" pattern keeps the page scannable. |
| What the new Overview becomes | The manager's **home page** — every weekly review starts here. KPI strip + date filter + leaderboard with inline drill-down + critical-issues panel + topic clusters context. |

---

## Net 7-week plan

```
Week 1   Verify + Brief
         ├─ Pull + Republish on Replit
         ├─ Confirm today's 5 fixes work
         └─ Brief SDR team on consent + verification scripts

Week 2-4 Overall Dashboard (the enriched Overview)
         ├─ Date range filter (7d / 30d / 90d / custom)
         ├─ Per-agent leaderboard (sorted by gap-to-target)
         ├─ Click row → inline expanded panel:
         │    • Last 10 calls (click to drill into modal)
         │    • Active coaching plans
         │    • Per-attribute Performance vs Team bars
         │    • Talk-time stats (filled in by Week 5-6)
         │    • Topic context
         ├─ Critical Issues banner (calls flagged + plans pending)
         └─ CSV export per agent

Week 4-5 SDR Pilot (parallel to Week 2-4 engineering)
         └─ 1-2 agents adopt consent + verification opening

Week 5-6 Speaker Diarization + Talk-Time Analytics
         ├─ Diarize Whisper transcripts (Agent vs Customer)
         ├─ Compute talk ratio, silence, interruptions, pace
         ├─ Surface in Call Details modal + Overview agent rows
         └─ Per-call: "Sample User 64% / Customer 36% — interrupted 3x"

Week 6   QA Inbox (sampling workflow)
         ├─ "10 random calls to review this week"
         ├─ Reviewer can sample / override / calibrate
         └─ Feeds Cohen's κ tracking in Week 7

Week 7   IA Cleanup + COPC v2 Polish + Cohen's κ
         ├─ 7 tabs → ~4-5 cleaner surfaces (existing tabs evaluated)
         ├─ Delete ~600 lines of legacy/duplicate code
         ├─ Cohen's κ surfaces in Overview (small badge per attribute)
         └─ Rubric self-tunes from manager override data
```

**Total: ~7 weeks of focused engineering.**

---

## What the manager's Monday morning now looks like (revised)

| Time | What manager does |
|---|---|
| **8:00 AM** | Opens `<REDACTED_HOST>/calls` (no email/digest involved) |
| <REDACTED_IP> | Lands on the Overview tab with date filter set to "Last 7 days" |
| <REDACTED_IP> | Scans KPI strip: 52 calls analyzed, team avg 71%, 3 new coaching plans |
| 8:01 | Scans leaderboard: Sample User 91% (top), Sample User 62% (bottom, marked with "3 plans pending") |
| <REDACTED_IP> | Clicks Sample User's row → expands inline |
| 8:02 | Sees: trend chart (declining 78% → 62%), active "Objection Handling" coaching plan, last 10 calls, talk-time 64% vs team median 45% |
| 8:03 | Clicks coaching plan → delivery modal with 3 evidence calls pre-loaded |
| 8:05 | Captures Sample User's commitment + follow-up date → "Mark Delivered" |
| 8:06 | Done. Plan moves to "Awaiting Verification" automatically. |

**Total: ~6 minutes** for one agent's weekly review. Five other agents: another ~15 minutes total. Then close the tab.

---

## What's NOT in the plan after this amendment

To make the deferrals explicit (for audit trail):

| Deferred | Why | Re-trigger |
|---|---|---|
| Weekly PDF digest emailed Monday | Manager will open dashboard directly; PDF generation adds complexity without unique value | If dashboard access cadence drops below 1× per week per manager |
| Slack real-time alerts on critical fails | Same — proactive notifications can be added later if needed | If a critical breach goes unnoticed for >24h (e.g. SDR caught making non-compliant calls without flag) |
| Standalone Agent View page | Folded into Overview drill-down | If Overview becomes too cluttered (e.g. 50+ agents, page > 2 screen scrolls) |
| Standalone Team View page | Folded into Overview leaderboard | Same |
| **PII redaction in transcripts** (from prior amendment) | PDPL Article 18 risk accepted while internal-only | Audit notice / wider access / external export |
| **Deterministic compliance engine** (from prior amendment) | Manager spot-check is sufficient at current scale | Team grows / inconsistent script adoption / audit asks for the control |

---

## Sign-off

a.amashah (Operations & Quality HOD) — approved 2026-05-25 (third same-day amendment)

The business case doc will be rewritten in the same commit to reflect the simpler scope.
