# Expert Review — Phase 1 Call Evaluation Platform

**Reviewer:** Independent senior product + engineering architect
**Reviewing for:** user@example.invalid (Operations & Quality HOD)
**Date:** 2026-05-25
**Status:** Plan-only review. No code changes.

---

## Section 1 — Honest critique of the current plan

### 1.1 The 7-week timeline is optimistic by roughly 50%

The plan in `Business_Case_Call_Evaluation_2026_05_25.md` commits to ~7 weeks at "~1 FTE equivalent at recent session pace." That phrasing is the first red flag. "Recent session pace" is one-engineer Claude-assisted sprinting on a Sunday with no meetings, no review cycles, no CTO follow-up calls, no Sample User-availability gating, and no QA. None of those will hold for seven consecutive weeks.

Concrete slippage vectors:

| Vector | Where it bites | Probability |
|---|---|---|
| Speaker diarization spike (W5-6) — pyannote vs AssemblyAI vs Deepgram | The Business Case treats it as "Phase 1 deliverable" with a `$50-100/mo Whisper bump`. That number is wishful. Diarization is either (a) a vendor switch (re-instrumenting `/api/calls/upload-audio`, `/api/calls/bulk-upload`, transcript persistence, `call_transcripts` schema, plus rebackfilling 199 historical records) or (b) a pyannote in-process integration that will eat memory on HostingPlatform. Either is 2+ weeks alone. | HIGH |
| Cohen's κ measurement (W7) — requires inter-rater calibration data which doesn't exist yet | The plan assumes Sample User's manager-override stream is the second rater. It isn't — it's a single rater. κ measures agreement between two independent humans, or one human and the AI. To produce κ ≥ 0.6 you need ≥ 30 dual-coded calls. That dataset doesn't exist on 2026-05-25. | HIGH |
| Backfilling talk-time on 199 historical records | Talk-time without diarization is impossible; talk-time WITH diarization on the full back-catalog is a re-Whisper pass at non-trivial cost. The plan implicitly defers this but the Overview KPIs will be skewed for 4-6 weeks until enough new diarized calls exist. | MEDIUM |
| SDR script rollout dependency (W2-3 pilot, W4-5 full) | If pilot doesn't start until CTO approves, and approval is "pending" per business case, every script-dependent metric slips with it. | MEDIUM |
| HostingPlatform deployment loop | The `DMAIC_Post_Republish_Audit` doc shows that yesterday's republish broke 11 endpoints from one missing `ROUTE_PERMISSION_MAP` entry. The same class of bug will recur during 7 weeks of feature additions. Expect 1-2 days lost per phase to RBAC catch-up. | HIGH |

**Realistic timeline: 10-12 weeks calendar at 1 FTE.** The Revamp Plan's own internal estimate was "28 days of work over 6 calendar weeks" — and that explicitly excluded diarization, PII redaction, and the compliance engine. The Business Case re-added diarization but kept the same 7-week envelope. Math doesn't reconcile.

### 1.2 The PII/compliance deferrals are defensible *today*, but the audit story is thin

The amendment in `Decision_Record_Amend_Skip_P0_P15_2026_05_25.md` is honest about the trade-off. The "compensating control = manager spot check" framing is correct for a GRQ-internal-only tool with a single reviewer. But re-read what's actually shipping:

- Step 6 shows a leaderboard with personal data of every SDR — call counts, attribute fails, talk ratio, coaching plans
- Step 9 talks about a monthly "DMAIC Control metric" rollup
- The Closing section describes a workflow the SDR Manager runs every week

That is **not** an "internal GRQ tool." It's an operations system that processes hundreds of customer voice recordings, derives behavioral analytics about employees, and feeds a coaching loop that determines what training they get. PDPL Article 18 (data minimisation) and Article 26 (purpose limitation) apply regardless of which ChatProvider workspace the dashboard is in.

The amendment essentially says: "we'll accept the PDPL risk because nobody is auditing us right now." That is operationally true but strategically fragile. Sample User's Nov 26 email to Velents specifically cited "long-term governance direction" as the *reason* for going internal. Going internal *and* then dropping the governance controls is the opposite of that direction.

**The strongest version of the compensating-control argument** would be: ship the dashboard, ship a manual SAR-response runbook, and add PII redaction in Phase 2 (immediately after Phase 1) as a hard fast-follow. The current plan has no fast-follow commitment in writing.

### 1.3 The "Overview tab as everything" approach has a real failure mode

`Decision_Record_Amend_Skip_Digest_Merge_Agent_View_2026_05_25.md` folds standalone Agent View + Team View into one enriched Overview. The direction is right (one destination beats four), but the specific implementation as described has problems.

The Business Case Step 6 describes a screen with:

1. KPI strip (5 metrics)
2. Date filter
3. Critical Issues banner
4. Agent leaderboard with 9 columns
5. Click-row → inline expanded panel containing: trend chart, active coaching plans, performance vs team bars, talk-time stats, recent calls list, topic context, CSV export

At 500 calls it will paint. At 5,000 it won't.

More critically: the expand-row pattern works for "I want to drill in once" but breaks for "I want to compare Sample User side-by-side." If Sample User 1:1 prep, she needs both agents loaded at once. Inline expansion fails this workflow because expanding row 2 collapses row 1 (typical UX pattern), or expanding both means a 4-screen scroll.

The original 4-surface IA from the Revamp Plan — Team / Agents / Calls / Reports / Config — is honestly the more durable design. The mistake there was treating Agents as a *standalone page with no list view*. The right compromise is: Overview has the leaderboard + inline single-row drill (current plan), AND a dedicated `/agents/:email` deep-link surface for side-by-side comparison and 1:1 prep. Inline-only is one screen too few.

### 1.4 The case study workflow is plausible but contains 3 fictions

The Sample User is the spine of the document. But:

| Fiction | Why it matters |
|---|---|
| **Cohen's κ = 0.51 on Objection Handling "moderate, tune rubric"** | κ requires two independent coders. Sample User only reviewer. The κ shown is between AI and Sample User, which is a "model agreement with sole human grader" metric — useful, but not Cohen's κ in the inter-rater sense Velents proposed and not what the rubric tuning literature uses. |
| **"Calls flagged + plans pending + compliance breach summary" Critical Issues banner** | No code yet exists to populate "calls flagged." The `flagged` boolean is in the Revamp Plan Phase 2 deliverables but the Business Case treats it as Week 2-4. |
| **The 5-week trend "78% → 75% → 71% → 68% → 62%"** | A 3-month-tenure SDR with 10 calls/week × 5 weeks = 50 calls of history. Most historical SDRs have sparse `key_topics`, no diarization, and many lack `audio_blob`. The trend chart will be missing values for most existing SDRs on day-1. |

The case study should be re-cast as **a 4-week-out projection of how the workflow *will* look once 2 weeks of post-launch calls have accumulated** — not as a Day-1 view. That framing is honest about the cold-start problem.

### 1.5 The success metrics are partly vibes

| Metric | Defensibility |
|---|---|
| "≥70% reduction in manual QA effort" | **Vibes.** Self-reported, "pre-launch baseline." The baseline is "Sample User's vague recollection of how long she spent listening last quarter." |
| "Cohen's κ ≥ 0.6 by Week 7" | **Vibes.** κ requires two human coders. |
| "≥60% of coaching plans verified passing within 30 days" | **Measurable** — but baseline = 0. Comparing 60% to 0% is a "the system works" metric, not a "the dashboard works" metric. |
| "Every score, override, coaching event traceable" | **Measurable** but tautological — `event_logs` already exists. |
| "All Overview surfaces render < 3 seconds at 500-call dataset" | **Measurable.** Good metric. |
| "Reduce weekly review from ~10 hours → < 30 minutes" | **Vibes.** The 10-hour baseline is not sourced. If the real baseline is closer to 2-3 hours, the "70% reduction" rhetoric collapses. |

The success criteria need at least one baseline measurement *before* the work starts.

### Section 1 TL;DR

The plan is internally consistent and aligned to a real user but its three biggest claims — 7 weeks, "PDPL risk is acceptable while internal-only," and the "70% QA reduction" — each have either no baseline, no measurement infrastructure, or no audit-defensible compensating control.

---

## Section 2 — Gaps the user has missed

### 2.1 No new-SDR onboarding flow

When a new SDR joins, what happens? The platform has no onboarding workflow. No "create SDR profile," no "calibration calls against tenured baseline," no "first 30 calls excluded from team-median," no agent metadata (tenure, manager, language, sector specialization).

`call_records` has `agent_email` and `agent_name` (free text). That's it. The peer-benchmark uses team median as comparator — so a new SDR's first 5 calls drag down everyone's median, and the new SDR's "Performance vs Team" is artificially terrible.

**Required:** an `agents` table with `tenure_start_date`, `manager_email`, `team`, `seniority_level`, `excluded_from_median_until`.

### 2.2 1-year retention with automatic deletion does not exist

Business Case says "1-year retention with automatic deletion mechanism — ⚠️ To be configured in Phase 1." There is no scheduled job that deletes `call_records` or `call_transcripts` or `audio_blob` based on age.

This was the Aug 28 CTO question Velents answered with "1-year retention." The internal answer is currently: **we retain forever.**

This must be a hard fast-follow within Phase 1. It's a 1-day job:
- New scheduled job (Inngest cron) running daily
- `DELETE FROM call_records WHERE created_at < NOW() - INTERVAL '365 days'` cascaded to transcripts, evaluations, compliance rows
- Configuration knob so retention is auditable
- Audit log row for every deletion batch

### 2.3 Multi-language UI — Arabic RTL on the new Overview is untested

None of the new Overview components have been mocked in RTL. Diverging bars (left-negative / right-positive) have a well-documented RTL trap. Sort indicator arrows on column headers reverse direction. Budget 2-3 days within the timeline for RTL audit + fixes.

### 2.4 Mobile responsiveness — barely any responsive CSS

Sample User reviewing from a desktop now, but the Coaching board, Critical Issues banner, and Inline drill-down patterns will be screenshot-shared in WhatsApp executive groups. A manager who can't pinch-zoom into a screenshot and read it loses the proactive sharing pattern.

This isn't a "mobile app" deliverable. It's "render legibly at 375px viewport for screenshot-friendliness." 1-2 days of CSS work, should be in scope.

### 2.5 No Whisper/LLMProvider outage path

What happens when LLMProvider returns 503 for an hour? The plan has no answer. No retry policy. No queued-vs-failed indicator. No circuit breaker. No backfill/replay if Whisper was down overnight.

### 2.6 Cost control — unbounded LLMProvider spend

A confused admin re-uploading the 199-call backlog = full re-Whisper pass at unbounded cost. Nothing stops it.

**Required:**
- Daily Whisper-spend cap (`LLMProvider_DAILY_BUDGET_USD` env var, checked before each call)
- Per-user upload rate limit (10 bulk uploads/hour)
- Idempotency on bulk-upload (hash the audio bytes; reject duplicate within last 30 days)

It's the difference between a $50/month bill and a $5,000/month bill.

### 2.7 5,000 and 50,000-call scale

The performance metric is "< 3 seconds at 500 calls." But:
- At 7-10 calls/agent/week × 8 agents × 52 weeks ≈ 3,000-4,000 calls/year
- At 12-month retention with full team adoption, the system is at 4,000-5,000 calls *one year after launch*
- The Overview's leaderboard fetches `limit=500` client-side. At 5,000 calls the leaderboard misses 90% of data.

Server-side aggregation for the leaderboard required from day 1, not "we'll fix it when we hit 500."

### 2.8 Inter-rater calibration BEFORE κ measurement

Before computing AI-vs-Sample User κ, you need to establish:
- Does Sample User's call the same way today as 3 weeks ago? (intra-rater reliability)
- Would Sample User second reviewer agree on whether Sample User Handling? (inter-rater reliability)

If Sample User's own scoring drifts, the κ between AI and Sample User Sample User's noise, not the rubric's quality.

**Required, 1 day in Week 1:** 10 calls × 3 reviewers, independently scored. Compute inter-rater κ. If < 0.6, the rubric ambiguity is the issue, not the AI; fix the rubric definitions first.

### 2.9 Coaching delivery accountability — what if Sample User a pending plan?

A plan can sit in `pending_delivery` for 6 weeks while the SDR keeps failing the same attribute on more calls, and nothing in the system raises this.

**Required:**
- An "Aged Pending Plans" widget on the Critical Issues banner
- A plan auto-aging rule: if `created_at < NOW() - INTERVAL '14 days'` AND `status = 'pending_delivery'`, surface to the manager's manager (CTO/COO)
- Telemetry on `coaching_plans.created_at → delivered_at` median per manager

Otherwise the system silently accepts manager neglect. This is the failure mode that kills coaching tools in real organizations.

### 2.10 SDAIA audit defence — 5 of 9 elements ready today

PDPL Article 22 requires controllers to "demonstrate compliance." For a single random call, can ExampleOrg produce:

1. Audio recording — ✓ (`audio_blob`)
2. Transcript — ✓ (`call_transcripts`)
3. Proof consent was captured — ⚠️ (advisory only, not enforced)
4. Retention countdown — ✗ (no retention mechanism)
5. SDR who handled it — ✓
6. Subsequent processing (eval, coaching) — ✓ (`event_logs`)
7. Subject access (find every call where customer phone X appears) — ✓
8. Subject erasure (if customer requests deletion) — ⚠️ (single-call delete exists; no orchestrated cross-table erasure)
9. Lawful basis documentation — ✗ (no formal mapping)

5 of 9 today. PDPL audit defence requires 9 of 9.

### Section 2 TL;DR

Ten concrete gaps that aren't in any of the 13 docs. Individually small (1-2 days each), uncontroversial. Collectively they add 2-3 weeks to the plan and nobody has accounted for them.

---

## Section 3 — Contradictions and assumptions

### 3.1 SDR team headcount is unstated

The case study assumes 6-8 SDRs but none of the 13 docs state the actual team size, manager-to-SDR ratio, or whether the team is stable or hiring. The dashboard's IA depends critically on this number.

### 3.2 1-FTE engineering assumption likely overstated

The Business Case commits 1 FTE for 7 weeks. The reality is the user is doing this alongside:
- Running the Operations & Quality function
- Pen-test remediation
- Duplicate Radar, CS Lifecycle, Fraud Module workstreams
- Company_Domain strategy
- SDR governance documents update

If "1 FTE" is actually "20-30% of an HOD's bandwidth," the 7-week calendar is closer to 4-5 months actual.

### 3.3 The "70% reduction" promise — what's the actual baseline?

Yesterday's DMAIC docs prove the platform is analyzing 199 backfilled records automatically. The "70% QA reduction" arguably *already happened*. Presenting it as a Week 7 target is misleading.

**Required:** measure Sample User's actual time-on-QA *next week* (timesheet for 5 days). Without that, the metric is unmeasurable.

### 3.4 Three managers blurred together

Sample User (Quality Manager), Sample User (HOD sponsor), Sample User (CTO approver) — somewhat interchangeably called "the manager" across the docs.

**Required:** explicit RACI:
- Who opens the dashboard daily? Sample User.
- Who delivers coaching plans? Sample User.
- Who approves deferred PII redaction risk? Sample User.
- Who audits the system quarterly? Quality team (does this exist?).

### 3.5 Same-day cascade of amendments from 10 → 8 → 7 weeks

| Doc | Total weeks | P0 PII | P1.5 Compliance | Diarization | PDF digest |
|---|---|---|---|---|---|
| Initial decision | 10 | ✓ | ✓ | ✓ | ✓ |
| Amendment 1 | 8 | ✗ | ✗ | ✓ | ✓ |
| Amendment 2 | 7 | ✗ | ✗ | ✓ | ✗ |
| Final Business Case | 7 | ✗ | ✗ | ✓ | ✗ |

When CTO Sample User three same-day decision records each cutting scope, the question he'll ask is "what's *next* to be cut?"

**Required:** consolidate the four documents into one canonical Phase 1 plan + a single "amendments log" appendix.

### Section 3 TL;DR

Three foundational assumptions (SDR team size, 1-FTE engineering availability, 70% baseline reduction) are not pinned down in writing. Two distinct managers are blurred across the docs. Same-day scope cuts cascading from 10 → 7 weeks raise the question of whether the 7-week number is anchored to anything real.

---

## Section 4 — Industry-benchmark sanity check

### 4.1 How mature platforms actually work

The Business Case treats "AI rubric scoring on every call" as the central capability. That is *one* of three modes mature platforms (Gong, Chorus, ExecVision, CRMProvider Einstein) actually use:

| Mode | What it is | How mature platforms use it |
|---|---|---|
| 1. Full AI rubric, every call | Every call gets a complete COPC-style score | Gong does this on a *subset* (manager-selected or flagged) — not all calls. |
| 2. Flagged-call review | AI surfaces "this call is risky" — humans review only flagged ones | This is the *primary* mode. Sentiment outliers, missing-greeting, prohibited-words, "deal-risk language" trigger flags. |
| 3. Coaching insight aggregation | AI doesn't score individual calls — it clusters patterns across calls | Gong "Trackers" + Chorus "Themes" — the pattern-mining mode. |

**ExampleOrg is heavy on Mode 1 and light on Mode 2.** A manager scoring 50 calls with AI-rubric output still needs to *read* 50 rubrics to triage which are worth deep review. The flagged-call inbox (Mode 2) is the actual time-saver.

**Recommendation:** keep the universal AI rubric (COPC differentiation), but invest equally in the flagged-call surface.

### 4.2 Auto-generated coaching plans — Gong specifically does NOT do this

Gong's coaching workflow is **human-curated assignment** of a call to a coaching session, not auto-trigger. Reasoning: auto-generated plans without managerial buy-in get dismissed.

ExampleOrg's auto-trigger (3 fails in 14 days) is unusual. Real risks:

- **Manager fatigue:** if the algorithm spawns 5 plans in a week and the manager has time for 2, the other 3 rot.
- **SDR pattern-gaming:** once SDRs realize "3 fails in 14 days" is the trigger, they game the cadence.

**Recommendation:** treat auto-trigger as a *queue with prioritization*, not an inbox-of-equal-weight. The plan needs a "this week, the manager will action the top 3 plans" mechanism.

### 4.3 Saudi-Arabic SDR context

**Genuinely differentiated:**
- Arabic-first RTL UI
- COPC alignment
- PDPL-aware design

**Worth questioning:**
- Heavy Whisper-1 dependency without diarization fallback. Whisper-1 doesn't natively diarize. Plan needs to acknowledge: diarization = either AssemblyAI/Deepgram (vendor switch, ~$0.015/min instead of $0.006, doubling cost) or pyannote (heavy memory/CPU).

**Should NOT copy from mature platforms:**
- Forecast/pipeline integration — Gong's moat, but requires years of CRM training data
- Real-time on-call coaching — needs dialler integration; defer until ContactCenterProvider webhook works
- Cross-account "buyer pattern" analytics — needs scale ExampleOrg doesn't have yet

### Section 4 TL;DR

ExampleOrg is reinventing two patterns mature platforms tried and found weak (universal AI rubric, auto-generated coaching plans without curation), while underbuilding a pattern mature platforms made central (flagged-call inbox). The COPC + Arabic + PDPL angle is genuinely differentiated. Make flagged-call triage as prominent as the leaderboard.

---

## Section 5 — Recommended best approach

### 5.1 Proceed, but with three structural changes

**Change 1: Split Phase 1 into 1a (ship-this-month) and 1b (next quarter)**

| Block | Weeks | Scope |
|---|---|---|
| **1a — Minimum Viable Cockpit** | 3-4 weeks | Date filter + leaderboard + inline drill-down + Critical Issues banner. No diarization, no κ, no QA Inbox, no IA cleanup. Just the manager Monday-morning workflow on top of what already exists. |
| **1b — Coaching + Quality Loop** | 4-5 weeks, follow-on | Diarization + talk-time, QA Inbox, IA cleanup, κ measurement. Done in a second tranche once 1a has telemetry. |

Why: the inline-drill leaderboard *alone* delivers 60% of the case-study value with 30% of the engineering risk. Shipping 1a in 4 weeks gives Sample User while diarization spike runs in parallel.

**Change 2: Add the four hard fast-follows explicitly in the plan**

| Fast-follow | Effort | Owner | Trigger |
|---|---|---|---|
| 1-year retention auto-delete job | 1 day | Eng | Before any non-GRQ stakeholder is shown the dashboard |
| LLMProvider cost cap + bulk-upload rate limit | 1 day | Eng | Before ContactCenterProvider webhook ingest is enabled |
| Server-side leaderboard aggregation | 2 days | Eng | Before dataset crosses 500 calls |
| Inter-rater calibration session (3 reviewers × 10 calls) | 0.5 day | Quality | Before κ is reported anywhere |

**Change 3: Re-do the success metric baselines THIS WEEK**

Before Week 2 starts:
- Sample User 5-day timesheet of QA hours (baseline for "70% reduction")
- Three reviewers score the same 10 historical calls independently (baseline for κ)
- Manager dashboard access log checked weekly thereafter (baseline for review cadence)

Without these, the Week 7 Control phase has nothing to compare against.

### 5.2 The riskiest assumption to test first: "managers will open the dashboard daily"

Every value-claim in the Business Case rests on Sample User. The Decision Record amendment explicitly accepts "if manager doesn't check dashboard weekly" as a risk. But there is no week-1 test for this.

**2-week behavioral pilot (free, before any new code):**
- Sample User opening `/calls` daily for 10 working days
- Telemetry captures: time-in-app, tabs visited, calls reviewed, coaching plans actioned
- At end of pilot, ask Sample User: "If the Overview tab had X, Y, Z, would you have stayed longer / done more?"

If Sample User't sustain daily access in week 2, *no amount of dashboard polish in week 7 will change that*.

### 5.3 Simpler 3-week MVP that delivers 80% of value

Strip the Phase 1 plan to:
1. Date filter on existing Overview KPI strip (1 day)
2. Agent leaderboard with sort-by-gap-to-target (3 days)
3. Click-to-expand row: trend chart + last 10 calls + active coaching plans (5 days)
4. Critical Issues banner: pending plans + plans aged > 7 days + any call flagged below 40% (2 days)
5. CSV export per agent (1 day)
6. 1-year retention deletion job (1 day)
7. LLMProvider cost cap (0.5 day)

That's ~14 dev-days = 3 weeks at 1 FTE. Zero new infrastructure. No diarization, no κ, no compliance engine, no QA Inbox.

After 3 weeks, Sample User working cockpit. Phase 1b adds diarization + κ + IA cleanup as a second tranche.

### 5.4 First thing to ship Monday

Spend Monday on the inter-rater calibration session and the timesheet baseline, **not** on engineering. Production code starts Tuesday.

Then Tuesday-Friday Week 1:
- **Tue:** Date filter on Overview. Smallest possible PR.
- **Wed-Thu:** Leaderboard component. Read-only, no row-expand yet.
- **Fri:** Wire to telemetry. Log every leaderboard row click + dwell time.

End of Week 1: Sample User dashboard, sees the leaderboard, sorts it, clicks a row → today's modal opens. The baseline of "manager dashboard opens" metric starts populating.

### Section 5 TL;DR

Don't run the 7-week plan as written. Split into 1a (3-week MVP cockpit) + 1b (5-week enhancement). Add four hard fast-follows. Re-baseline the metrics this week before any code. Ship the date filter + leaderboard alone on Monday, then make every subsequent week's scope a function of the prior week's telemetry.

---

## Section 6 — Specific concrete actions for the user in the next 7 days

### 6.1 Five things to do this week

| # | Action | Time | Why |
|---|---|---|---|
| 1 | Run a 5-day timesheet of Sample User's actual QA hours | 5 days, ~5 min/day | The "70% reduction" metric needs a real baseline. |
| 2 | Schedule a 90-min inter-rater calibration session | 90 min one session | Establishes whether rubric ambiguity is the actual problem before measuring AI-vs-Sample User κ. |
| 3 | Ship the 1-year retention auto-delete cron job | 1 day | Closes SDAIA Article 18 hole today. |
| 4 | Ship LLMProvider daily spend cap + bulk-upload rate limit | 0.5 day | Closes unbounded-cost risk. |
| 5 | Consolidate the 4 plan docs into 1 canonical + amendments-log | 2 hours | Makes the CTO briefing reviewable in one read. |

### 6.2 Questions to ask Sample User Week 2

1. **What's the actual SDR team headcount, and is it stable?**
2. **How many other SDR Managers exist besides you?**
3. **Realistically, will you open this dashboard every workday, or once a week?**
4. **If you had to choose between speaker diarization and a flagged-call inbox in Phase 1, which?**
5. **What's your honest QA time today — 10 hrs/wk like the business case says, or closer to 2-3 hrs?**
6. **Has the SDR team adopted the consent script + verification step yet?**
7. **Can you commit to a 2-week behavioral pilot — daily dashboard open, telemetry on — before we start the build?**

### 6.3 Questions to ask CTO Sample User requesting approval

1. **What is the audit posture on PDPL Article 18 (data minimisation) for raw transcripts?** Is GRQ-internal-only defensible, or does he want PII redaction in Phase 1?
2. **What's the budget guardrail on LLMProvider spend?**
3. **What's the team's actual definition of "1 FTE"?** Is Sample User this 100%, 50%, or evenings/weekends?
4. **If Phase 1a (3-week MVP) ships, does Phase 1b get funded automatically, or is it a separate approval?**
5. **The Aug 2025 CTO sign-off was for the Velents-equivalent scope.** Is the 68% delivery against that scope acceptable, and is the explicit framing of "we deferred PII redaction and deterministic compliance because manual spot-check is sufficient" what he'd want in writing?

### 6.4 The single acid-test query to run on real data

Run this against the live production DB this week. The answer determines whether the case study is realistic.

```
For each SDR who has at least 10 analyzed calls in the last 30 days:
  - What's their avg overall_score?
  - What's their pass rate on Objection Handling specifically?
  - How many active coaching_plans do they have?
  - How many have status = pending_delivery older than 7 days?
  - What's the gap between their avg score and the team median?
  - Do they have populated key_topics? talk_ratio? duration_seconds?

Then ask:
  Can I sort this output to identify the "Sample User" — the SDR
  with declining trend + 3+ active plans + below-median on one attribute —
  in under 10 seconds of visual scan?
```

If yes (the data sustains the case study), the dashboard build is just packaging insight that already exists in DB → low risk. If no (data too sparse, trend can't be computed, topics empty), the dashboard build is doing data-engineering disguised as UI work → 2-3x effort hidden in the timeline.

### Section 6 TL;DR

Do five concrete things this week before any new feature code. Ask Sample User questions to anchor team-size, cadence, and prioritization. Ask the CTO five questions to align on PDPL posture, budget, FTE definition, and Phase 1b commitment. Run one acid-test SQL query on real data — that single query is more informative than another week of planning.

---

## Closing

The plan is the product of a serious, disciplined day of thinking. The user understands the problem domain better than most product managers I've reviewed. The amendments are evidence of pragmatic scope management, not indecision.

The core risk isn't *what's being built* — it's *what's not being measured*: baseline QA hours, inter-rater agreement, LLMProvider cost trajectory, dashboard access cadence, retention enforcement. Most of those gaps close in under a day of work each, all this week, before any feature engineering begins. Do those things and the 7-week plan becomes credible. Skip them and the 7-week plan ships a polished cockpit that nobody can prove improved anything.

The recommended best approach is: ship a 3-week MVP cockpit first (date filter + leaderboard + inline drill + critical-issues banner + retention job + cost cap), measure adoption for 2 weeks, then commit Phase 1b based on telemetry. That collapses the 7-week timeline into a 5-week one with checkpoints and converts the project from "build a thing and hope it gets used" to "build a thing, measure use, build more."
