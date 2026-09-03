# Velents Proposal vs Internal Build — Gap Analysis

**Date:** 2026-05-25
**Trigger:** User shared the `WalaaPlus<>Velents` email thread (Jul 31 – Nov 26, 2025)
**Purpose:** map the rejected vendor's proposed scope against (a) what's currently shipped on `<REDACTED_HOST>/calls` and (b) the Call Evaluation revamp plan I just drafted. Identify the capabilities Velents would have delivered that aren't yet in our plan, and recommend which to fold in.

---

## Historical context — what happened

| Date | Event |
|---|---|
| **Jul 31, 2025** | Velents (Mohamed Gaber) pitches an AI QA agent partnership |
| **Aug 17** | Sample User user story + business case for CTO sign-off (the canonical requirements doc) |
| **Aug 25** | Pitched formally to CTO Sample User |
| **Aug 28–31** | CTO asks data-governance questions (storage, retention, deletion). Velents answers GCP/Dammam, 1-year retention. CTO approves the initiative. |
| **Sep 1** | NDA + Third-Party Security Assessment sent for Velents to fill in |
| **Sep 15** | Sample User completed Security Assessment + dashboard access for validation. Velents goes quiet. |
| **Nov 26, 2025** | **Sample User engagement**. Reasoning verbatim from the email: *"timeline priorities," "scope and engagement process have extended beyond our initial expectations," "we plan on pursuing a solution that can be fully owned and managed internally to align with our long-term governance direction."* |

**Net:** the internal ExampleOrg build IS the chosen alternative to Velents. Everything Sample User's Aug 17 business case demanded should be measured against what we ship.

---

## Velents proposed solution — the 6 pillars

From the Aug 25 email to CTO (the most complete version of the vendor's scope):

| # | Pillar | Velents commitments |
|---|---|---|
| 1 | Ingestion & Storage | Webhook/scheduled pull from ContactCenterProvider on call completion; download audio + metadata (agent/campaign/disposition); secure storage |
| 2 | Transcription (ASR) | Auto-language detect Arabic/English including code-switching; speaker diarization; channel mapping (Agent vs Customer); PII redaction with reversible/irreversible hashing per policy |
| 3 | Conversation Enrichment | Talk-time features (silence/overlaps/interruptions/talk ratio/pace); semantic features (intents/issues/products/sentiment shifts); knowledge checks against ExampleOrg KB/FAQs |
| 4 | Scorecard & Compliance Engine | LLM rubric scoring (Greeting/Needs Discovery/Resolution/Closing); deterministic checks (mandatory phrases, compliance steps, prohibited words); weighted total scores with rationales + timestamped evidence; auto-fail rules for major breaches |
| 5 | Quality Ops & Calibration | QA Inbox for reviewers to sample/override/calibrate; rubric tuning with drift monitoring; Cohen's κ for inter-rater agreement |
| 6 | Outputs & Delivery | Dashboards (agent/team scores, trends, compliance breach logs); notifications (daily digests + real-time alerts for severe breaches); exports (CSV/S3/CRM/Snowflake/BigQuery/Power BI) |

Sample User's expected benefits:
- 70% reduction in manual QA effort
- Consistency (eliminate evaluator bias)
- Coaching insights
- Governance + auditability
- Scalability

---

## Current platform scoreboard — what's shipped today

Going through Velents's 6 pillars against `<REDACTED_HOST>/calls`:

### Pillar 1 — Ingestion & Storage

| Velents commitment | ExampleOrg internal status |
|---|---|
| Webhook from ContactCenterProvider on call completion | ❌ **Gap.** We ingest via filename-parsed bulk upload (199 historical) + `/api/calls/ingest` endpoint exists but no live ContactCenterProvider webhook is wired |
| Download audio + metadata (agent/campaign/disposition) | ⚠️ Partial. Audio yes (`audio_blob` column). Metadata: agent + call date yes; campaign + disposition no |
| Secure storage | ✅ Postgres `audio_blob` + Whisper-derived transcripts persisted |

**Verdict: 1.5 / 3.** Webhook is the biggest gap — without it, every new call requires a manual filename-formatted upload.

### Pillar 2 — Transcription (ASR)

| Velents commitment | ExampleOrg internal status |
|---|---|
| Auto language detect Arabic/English + code-switching | ✅ Whisper-1 with `verbose_json` handles this natively |
| Speaker diarization (Agent vs Customer) | ❌ **Gap.** Whisper-1 returns a single text stream, no speaker labels. This is a critical gap for SDR quality — we can't compute "agent talk-time %" without diarization |
| Channel mapping | ❌ Same — needs stereo recording with one channel per speaker; we get mono from filename uploads |
| PII redaction (reversible/irreversible per policy) | ❌ **Gap.** Transcripts are stored raw including customer names, phone numbers, IDs. This is a PDPL Article 18 risk (data minimisation) |

**Verdict: 1 / 4.** ASR works for Arabic, but the speaker/PII layer is missing.

### Pillar 3 — Conversation Enrichment

| Velents commitment | ExampleOrg internal status |
|---|---|
| Talk-time features: silence, overlaps, interruptions, talk ratio, pace | ❌ **Gap.** None of these are computed. Industry-standard signals for SDR quality |
| Semantic features: intents, issues, products, sentiment shifts | ⚠️ Partial. Sentiment yes (`call_analysis.sentiment_score`). Intents + issues + products + sentiment SHIFTS no |
| Knowledge checks (KB/FAQs validated) | ❌ **Gap.** No KB integration. Agent could quote wrong pricing/policy and we'd never know |

**Verdict: 0.5 / 3.** Sentiment is in, everything else is missing.

### Pillar 4 — Scorecard & Compliance Engine

| Velents commitment | ExampleOrg internal status |
|---|---|
| LLM rubric scoring (Greeting/Discovery/Resolution/Closing) | ✅ **COPC v2 scorecard** does exactly this; per-attribute scores + dimension rollups (People/Process/Governance) |
| Deterministic checks (mandatory phrases / prohibited words) | ❌ **Gap.** No keyword-based checks. The proposed PDPL consent line + 3-point verification (in `docs/SDR_*_2026_05_25.md`) WOULD be implemented as deterministic checks — but the engine doesn't exist yet |
| Weighted total scores with rationales | ✅ Scorecard has weights and comment fields |
| Timestamped evidence quotes | ⚠️ Partial. `evidence_quotes` field exists; `evidence_timestamps` field exists but inconsistently populated |
| Auto-fail rules for major breaches | ❌ **Gap.** No auto-fail logic. A call missing the PDPL consent could pass with an 80% score today |

**Verdict: 2 / 5.** The LLM rubric works; the deterministic engine + auto-fail layer is missing.

### Pillar 5 — Quality Ops & Calibration

| Velents commitment | ExampleOrg internal status |
|---|---|
| QA Inbox for reviewers to sample / override / calibrate | ⚠️ Partial. `sdr_evaluation_reviews` table + manager-review modal supports adjust/approve/disagree. No "sample for review" workflow — reviewers must hunt for calls |
| Rubric tuning + drift monitoring (Cohen's κ inter-rater agreement) | ❌ **Gap.** No κ computation. We can't measure how often the AI agrees with managers, so the rubric can't be tuned objectively |

**Verdict: 0.5 / 2.**

### Pillar 6 — Outputs & Delivery

| Velents commitment | ExampleOrg internal status |
|---|---|
| Agent/team dashboards | ✅ Overview tab + Coaching tab + Analytics tab cover this |
| Trends | ✅ QA Score Trends + Topic Clusters (shipped today) |
| Compliance breach logs | ⚠️ Partial. `call_compliance` table exists; no "breach log" view |
| Daily digests | ❌ **Gap.** No scheduled email/ChatProvider digest. This is THE missing manager-facing output Sample User for |
| Real-time alerts for severe issues | ❌ **Gap.** Coaching plans auto-generate but there's no proactive notification — manager has to log in and check |
| Exports (CSV / S3 / CRM / BI) | ⚠️ Partial. Some CSV exports exist; no S3/BI integration |

**Verdict: 2.5 / 6.**

---

## Net scoreboard

| Pillar | Velents would have delivered | We deliver today | Gap |
|---|---|---|---|
| 1 — Ingestion | 3 | 1.5 | -1.5 |
| 2 — ASR | 4 | 1 | -3 |
| 3 — Enrichment | 3 | 0.5 | -2.5 |
| 4 — Scorecard engine | 5 | 2 | -3 |
| 5 — QA & Calibration | 2 | 0.5 | -1.5 |
| 6 — Outputs | 6 | 2.5 | -3.5 |
| **Total** | **23** | **8** | **-15 (≈65% gap)** |

The current platform delivers roughly **35% of what Velents would have shipped**. My revamp plan closes some of the remaining 65%, but not all of it.

---

## Where my revamp plan aligns with Velents

My plan (in `docs/Call_Evaluation_Revamp_Plan_2026_05_25.md`) covers:

| Revamp plan section | Maps to which Velents pillar |
|---|---|
| **P1 — Reports surface** (manager-shareable PDF / ChatProvider / CSV) | Pillar 6 (daily digests + exports). Closes ~2 of the 3.5 missing points. |
| **P2 — Agent View** | Pillar 6 (agent dashboards) — already mostly shipped, P2 polishes |
| **P3 — Team View** (leaderboard, weak areas, coaching backlog) | Pillar 6 (team scores, trends, compliance breach logs) |
| **P4 — IA cleanup** | Not a Velents requirement; pure UX hygiene |
| **P5 — COPC v2 deep integration** | Pillar 4 (LLM rubric, weighted scores) — already 80% there |

**So my revamp plan addresses ~6 of the 15 missing points (~40% of the Velents gap).**

---

## Velents capabilities NOT in my revamp plan (the remaining 9 points)

These are the genuine gaps I should add to the revamp plan if you want the in-house build to be at functional parity with what Velents pitched:

### Tier 1 — Compliance + Governance critical

| Capability | Why it matters for ExampleOrg | Effort to add | Priority |
|---|---|---|---|
| **PII redaction in transcripts** | PDPL Article 18 (data minimisation) — storing customer PII verbatim in transcripts is a real risk. Auditor would flag this. | ~1 week. Either Whisper-side redaction or post-process via regex/NER for Saudi ID numbers, phone, IBAN, email | **🔴 Add to revamp plan as P0** |
| **Deterministic compliance checks** (mandatory phrases / prohibited words / auto-fail) | Without this, our PDPL consent line and 3-point verification (docs already drafted) cannot be ENFORCED — only suggested | ~3-5 days. Phrase-matching engine + auto-fail rule config + scorecard integration | **🔴 Add to revamp plan as P1.5** |
| **Real-time alerts on severe breaches** | "Agent X just had a call without consent line — alert manager NOW" — currently impossible | ~3 days. ChatProvider/email integration + alert routing config | **🟡 Add to revamp plan as P2.5** |

### Tier 2 — Coaching quality / signal quality

| Capability | Why it matters | Effort | Priority |
|---|---|---|---|
| **Speaker diarization** (Agent vs Customer talk-time split) | Talk-ratio is one of the most predictive SDR-quality signals industry-wide. Currently we can't compute it | ~1 week. Use Whisper's word-level timestamps + a diarization library (e.g. pyannote) OR switch to AssemblyAI/Deepgram which include diarization natively | **🟡 Strong recommend** |
| **Talk-time features** (silence, overlaps, pace) | Same as above. Gong/Chorus's flagship insight: "your top SDR talks 40% of the time, your bottom SDR talks 65%" | Depends on diarization. ~2-3 days additional once diarization exists | **🟡 Strong recommend** |
| **Cohen's κ inter-rater agreement** (AI vs human reviewer) | Without this you can't TUNE the AI rubric. Manager-review modal exists; computing κ on the override data is the next step | ~2 days | **🟡 Recommend** |

### Tier 3 — Nice-to-have / scope-dependent

| Capability | Why it matters | Effort | Priority |
|---|---|---|---|
| **Live ContactCenterProvider webhook ingest** | Replaces filename-parsed uploads for live calls. Filename parser stays for historical bulk imports | ~1 week. Need ContactCenterProvider admin access + their webhook config | **🟢 P2 of the revamp plan already** |
| **KB/FAQ knowledge checks** | "Agent said the discount is 30% but our KB says 25% — flag this" | ~1-2 weeks. Requires a KB ingestion pipeline + semantic search | **🟢 Future** |
| **BI exports** (Snowflake/BigQuery/Power BI) | Useful if you ever connect ExampleOrg data to a corporate data warehouse | ~3 days per target | **🟢 Future** |
| **QA Inbox** (sampling workflow for reviewers) | Manager-review workflow exists today; the "queue of N random calls to review this week" UI doesn't | ~3 days | **🟢 Recommend** |
| **Sentiment SHIFTS** (not just average sentiment) | "Customer was positive at minute 2, negative at minute 8 — what happened?" | ~3 days. Need to chunk transcript + run sentiment per chunk | **🟢 Nice-to-have** |

### Out of scope for ExampleOrg's current needs

| Velents capability | Why we likely don't need it |
|---|---|
| Reversible hashing for PII | Irreversible redaction is sufficient for PDPL; reversibility is rarely needed |
| Channel mapping (stereo recordings) | ContactCenterProvider typically gives mono. Diarization is the practical alternative |
| Cohen's κ as a UI surface | The metric should INFORM rubric tuning, not be a dashboard for managers |

---

## What I'd add to the Call Evaluation Revamp Plan

To bring the in-house build to functional parity with the Velents proposal Sample User with the CTO, my revamp plan needs three new phases added. Updated phase list:

| Phase | Original scope (from existing revamp plan) | NEW additions from Velents gap |
|---|---|---|
| **P0** | (none — was foundation review) | **PII redaction in transcripts.** PDPL-critical. Cannot defer. |
| **P1** | Reports surface | + **Daily digest + real-time alerts** (was just digests; add alert routing) |
| **P1.5 (NEW)** | — | **Deterministic compliance engine** — mandatory phrases, prohibited words, auto-fail rules. Pre-req for enforcing the PDPL consent + 3-point verification scripts |
| **P2** | Agent View | + **Talk-time analytics** (requires diarization) |
| **P2.5 (NEW)** | — | **Speaker diarization** (Whisper word-timestamps + library OR vendor switch to AssemblyAI/Deepgram) |
| **P3** | Team View | + **QA Inbox** (sampling workflow for reviewers) |
| **P4** | IA cleanup | (unchanged) |
| **P5** | COPC v2 polish | + **Cohen's κ inter-rater agreement** for rubric tuning |
| **P6 (NEW, future)** | — | **ContactCenterProvider live webhook ingest**, **KB knowledge checks**, **BI exports**, **sentiment shifts** |

**Net change:** 3 new phases (P0, P1.5, P2.5) + additions to existing phases. Total revamp scope grows by roughly +3-4 weeks of focused work.

---

## What this comparison means strategically

### Re-validation of the build-vs-buy decision

Sample User's Nov 26 email says the build-internal decision was driven by:
1. **Timeline priorities** — Velents was moving slowly (Aug → Nov with no working environment delivered)
2. **Scope creep** — engagement process extended beyond expectations
3. **Governance ownership** — "fully owned and managed internally"

The third reason is the strategic one. PDPL/COPC compliance is easier to defend with an in-house system you can audit line-by-line than with a vendor system whose internals you can't inspect. That's a real, lasting reason.

**But the trade-off was real:** Velents would have shipped pillar-3 (conversation enrichment with talk-time analytics) and pillar-5 (calibration with κ) much faster than we can build them. ExampleOrg accepted a slower delivery in exchange for ownership.

### What Sample User's Aug 17 business case demanded vs what's shipped

Going line-by-line through Sample User's Aug 17 user story and proposed solution:

| Sample User's Aug 17 requirement | Status today |
|---|---|
| Per-call AI scorecard outside ContactCenterProvider | ✅ Shipped (COPC v2 scorecard) |
| Integrated with ContactCenterProvider metadata | ⚠️ Partial (no live webhook yet) |
| Greeting & introduction compliance | ⚠️ Scored via LLM rubric, but NOT deterministically enforced |
| Mandatory qualification questions | ⚠️ Same — the 3-point verification doc exists but isn't yet enforced by the scorecard |
| Handling objections & clarifications | ✅ Scored |
| Accuracy of call outcome disposition | ❌ Not currently checked — would need disposition pulled from ContactCenterProvider |
| Closing & follow-up actions | ✅ Scored |
| Agent-level dashboards (repeated mistakes / coaching) | ✅ Shipped (Coaching tab + Performance vs Team) |
| Link scorecards to leads/deals in CRM | ✅ Shipped (auto-link + activity timeline) |
| 70% manual QA reduction | ⚠️ Believable for analyzed calls, but we still have manual filename uploads — not 70% reduction in the full pipeline |
| Consistency (no bias) | ✅ Same AI scores every call the same way |
| Coaching (skill gaps → training) | ✅ Coaching loop shipped this week |
| Governance (CRM auditability) | ✅ event_logs trail intact |
| Scalability (hundreds/week) | ⚠️ Yes for analyzed calls; bulk upload bottleneck |

**Sample User's August requirements are ~65% met today.** The biggest gaps are the same as the Velents-vs-internal gaps above: webhook ingest, deterministic compliance checks, talk-time analytics, daily digests, PII redaction.

---

## Recommendation

**Update the revamp plan to include the 3 new phases** (PII redaction, deterministic compliance, speaker diarization). The rest of Velents's scope (BI exports, KB checks, real-time κ dashboards) is genuinely future-state and can wait.

If you fund the 3 additions, your in-house build will deliver functional parity with what Velents proposed — minus the vendor lock-in, minus the data-residency risk, minus the timeline drag — by roughly **end of Q3 2026** at the current pace.

If you DON'T fund them, the in-house build remains a credible MVP but ships without 3 capabilities Sample User with the CTO. That gap will eventually be re-raised in an audit or QBR.

---

## One-line summary

> Velents was offering a Mercedes; we're building an internal Toyota Land Cruiser. The Land Cruiser will do 70% of what the Mercedes promised at 0% of the vendor risk — but Sample User's Aug 17 business case included some Mercedes-specific features (PII redaction, talk-time analytics, deterministic compliance enforcement, daily alerting) that aren't yet in the Land Cruiser's spec. Either we add them, or we explicitly downscope the Aug 17 commitments.
