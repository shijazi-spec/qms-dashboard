---

# Call Evaluation — Comprehensive Revamp Plan

**Date:** 2026-05-25
**Author:** Claude (planning agent), commissioned by a.amashah@walaplus.com
**Target commit path:** `docs/Call_Evaluation_Revamp_Plan_2026_05_25.md`
**Status:** Plan-only. No code in this PR. Review-before-build.

**Scope:** the entire `/calls` feature — 7 sub-tabs (Overview, Call Records, Data Sources, SDR Evaluation, Coaching, CRM Compliance, Analytics), the unified Call Details modal, all dependent backends, and the missing "manager-reportable output" layer.

**TL;DR:** WalaPlus's Call Evaluation has the *engine* of a credible Gong/Chorus alternative — COPC v2 scorecard, Whisper transcription, automatic SDR scoring, a working coaching loop, CRM compliance auditing — but the *cockpit* is wrong. The 7-tab IA forces a manager to click through 4–5 surfaces to evaluate one SDR, and there is no manager-shareable artifact at the end. This plan consolidates the IA into 4 surfaces (Call · Agent · Team · Reports), formalises the missing **Reports** surface as the primary manager workflow, deletes ~600 lines of duplicate/legacy code, and ships in 5 phases over ~6 weeks.

---

## Section 1 — Current State Audit (per tab)

Each row of the seven sub-tabs is graded on three dimensions: **strengths**, **debt**, and **user-journey friction**. Line numbers reference `dashboard/calls.html` (~7,462 lines) and `src/mastra/routes/callIntelligenceRoutes.ts` (~5,749 lines).

### 1.1 Overview (`#content-overview`, lines 135–286)

**What it does well**
- KPI cards (Total / Analyzed / Avg Sentiment / Avg QA / Compliance Rate) give an at-a-glance pulse.
- Integration status banner at the top of the page (lines 1653–1697) is honest about Zoho disconnection rather than silently returning zeros — fixed this week.
- CRM Compliance Breakdown shows *coverage* (not just rates), so a `0 Notes Updated` cell is contextualised by the diagnostic banner.
- One-click bulk **Backfill Dates** and **Backfill CRM Compliance** buttons exist where they're useful — next to the gap they fix.

**What's broken / awkward / duplicated**
- KPI cards are not drill-throughs. "Avg QA Score 68" doesn't link to "which 12 calls dragged this down?"
- "Calls by Source" pie chart is decorative; nobody acts on `five9: 92, manual: 102` because the source tells you nothing about quality.
- "Calls by Agent" is a bar chart of *volume*, not a *leaderboard with score*. Volume without quality misranks SDRs who dial more but qualify less.
- No date filter. The numbers are always lifetime-to-date.
- No "Send to SDR Manager" button at the top — yet this is the page a manager would land on.

**User-journey friction**
- Manager opens `/calls` → sees lifetime KPIs → wants "last week" → has no toggle → has to mentally subtract or move to a different tab.
- To find the agents who failed compliance, they must scroll past 5 cards, click into CRM Compliance tab, then sort.

**Data sources**
- `GET /api/calls/analytics` (line 578) — aggregates compliance + sentiment + QA.
- `GET /api/integrations/status` — Zoho/Google banner.
- `POST /api/calls/backfill-call-dates`, `POST /api/calls/backfill-compliance` — destructive ops.

**TL;DR:** A landing page. Pretty, not actionable. Needs date scoping, drill-through, and a leaderboard view — and a "Send Weekly Report" CTA.

---

### 1.2 Call Records (`#content-calls`, lines 288–402)

**What it does well**
- Phone search by last-9-digit normalisation (shipped today, DMAIC Call Details Unification) is genuinely useful.
- Bulk-select toolbar (lines 341–364) supports Re-analyze / Re-score / Delete — competitive with Gong.
- "By Phone" view mode (lines 335–338) groups every record under one phone — a unique angle vs Gong's deal-centric grouping.
- Unified Call Details modal (lines 1311–1328) consolidates scorecard + transcript + recording + activity into one surface. The DMAIC doc already proves this dropped modal-hops from 3 → 1.

**What's broken / awkward / duplicated**
- Pagination is client-side over a `limit=500` fetch (line ~1436). At 500+ records the search will silently miss matches and the page will get slow.
- The legacy standalone `transcriptModal` at line 1393 is still in the DOM even though the transcript is now inline in Call Details. Dead code.
- The `viewCall()` function (~line 2254) is ~700 lines long and hard-codes the modal HTML — impossible to A/B test or component-ise.
- Direction column (Inbound/Outbound) is rarely meaningful for SDR-only operations; could be moved to a chip inside the row.
- "Export CSV" exists, but nothing exports the *evaluation* fields — score, attribute fails, coaching trigger — only the record metadata.
- Three duplicate `copyTranscript` functions silently shadowed each other in this file historically (fixed today). The risk of similar shadowing remains because the file is one 7,462-line monolith.

**User-journey friction**
- Manager finds a call → clicks View → reviews → closes modal → has to find the same SDR's *other* calls manually (the Related Calls inline list helps, but only by phone, not by agent).
- No way to bookmark / star a call. Calls flagged for SDR Manager review have no flag.

**Data sources**
- `GET /api/calls?limit=500&source=...&status=...`
- `GET /api/calls/:callId` (returns scorecard, analysis, transcript, activity)
- `POST /api/calls/:id/analyze`, `POST /api/calls/:id/sdr-evaluate`
- `DELETE /api/calls/:id`

**TL;DR:** The strongest tab. Needs server-side filtering once the dataset crosses 500 rows, a `flagged` boolean, and a richer export. The viewCall() monolith should be broken into components in Phase 2 of the rewrite.

---

### 1.3 Data Sources (`#content-sources`, lines 404–717)

**What it does well**
- Strict filename parser with five preview chips (phone / last-9 suffix / agent / date / time) — closes a real bug class (the 199 records all stamped with bulk-upload date).
- Five9 integration UI exists and is honest about disconnection.
- Zoho Calls Activity Import (lines 472–535) is a powerful coverage gap tool — surfaces calls logged in Zoho but never recorded.
- Bulk audio drop-zone supports up to 50 files × 25MB.

**What's broken / awkward / duplicated**
- "Manual Call Upload" card (lines 542–629) is still in the DOM, just `class="hidden"`. It duplicates Bulk Upload and is dead code.
- Google Drive integration is *mentioned* (per the user's brief) but I cannot find a working Drive sync card in the current HTML — it may be lurking or may have been retired.
- "Recent uploads list" (line 707) shows the last few but doesn't link to the Call Records tab.
- Five9 connection panel collects domain + username + password but the actual sync endpoint requires a configured contact-center license — no preflight to tell the user "you're missing X."
- Two upload paths exist with different bugs: `/api/calls/upload-audio` (autoAnalyse=true → Whisper duration captured) and `/api/calls/bulk-upload` (duration NEVER captured). Documented in DMAIC Call Details Unification §A.

**User-journey friction**
- New user uploading 50 calls has no progress estimate beyond a fraction counter — no ETA.
- After upload, user has to click into Call Records to verify. No "uploaded → analysed → scored" pipeline view.
- Filename format is enforced strictly — but if a manager exports Five9 recordings whose filenames *don't* match this format, they're stuck. There is no upload-time "rename helper."

**Data sources**
- `POST /api/calls/upload-audio` (single-file)
- `POST /api/calls/bulk-upload` (multipart)
- `POST /api/calls/five9/{test,configure,sync}`
- `POST /api/calls/import-from-zoho`

**TL;DR:** Functional but engineering-flavoured. Long-term, the goal should be **zero-touch ingest** via direct Five9 webhook; the filename parser becomes the historical-import escape hatch only.

---

### 1.4 SDR Evaluation (`#content-evaluate`, lines 718–906)

**What it does well**
- "Active Scorecard" collapsible banner shows COPC v2 is loaded and version-pinned — auditable.
- Per-call evaluation form supports the canonical 4 sections × 19 checkpoints from `scorecardV2CopcCanonical.ts`.
- Manager-review workflow (Approve / Adjust / Disagree) with per-attribute editing and audit log to `sdr_evaluation_reviews` is enterprise-grade.
- AI Training Feedback panel (lines 817–847) shows reviewed count / approval rate / top-corrected attributes — a real RL feedback loop.
- Batch Evaluation panel (lines 725–769) — OpenAI Batch API at 50% off, 24h SLA — saves money on bulk re-scoring.

**What's broken / awkward / duplicated**
- This is the tab with the **deepest debt.** Three overlapping concepts live here:
  - Embedded "Active Scorecard" panel (line 791) duplicates the deprecated standalone `#content-scorecards` div (line 911, marked `data-deprecated="scorecards-merged-into-sdr-evaluation" hidden`) which is still in the DOM ~70 lines long.
  - Duplicate DOM IDs: `#scorecards-list`, `#ai-training-stats`, `#stat-reviewed` etc. exist in BOTH the embedded panel and the deprecated tab. JS handlers reach for these IDs by document-wide lookup — the `hidden` attribute prevents render but the duplicate ID is still a footgun.
  - Embedded panel uses `-embedded` suffixed IDs (`#stat-reviewed-embedded`) — so there are *three* parallel ID sets in flight.
- The call-picker list on the left (lines 861–877) is a separate fetch from the Call Records tab — the same calls are loaded twice when both tabs are visited.
- Adjust Review modal (lines 1421–1482) is a beautiful per-attribute editor that's hard to discover — only reachable through one button inside a sub-table.
- The Scorecard editor modal (line 1334) lets users *create* new scorecards but the COPC v2 was hand-tuned by Mohammed to align with COPC clauses — letting an operator click "Create Scorecard" and accidentally replace it is a real risk.

**User-journey friction**
- Manager wants to see *just one SDR's evaluations* → no agent filter in the call picker. Have to use search-by-name and hope it matches the agent_email format.
- After saving a manager-adjusted review, there is no "and now do the same for the next call by this agent" affordance.
- Coaching plan auto-creation is invisible from this tab — the manager finishes a review, has no idea their disagree → adjusted reviews are feeding the coaching trigger.

**Data sources**
- `GET /api/sdr-scorecards/active`, `GET /api/quality-scorecards`
- `GET /api/calls/:id/sdr-evaluation`, `POST /api/calls/:id/sdr-evaluate`
- `POST /api/calls/:id/sdr-evaluation/review`
- `GET /api/ai-training/{feedback,stats}`
- `POST /api/calls/batch/submit-pending`, `GET /api/calls/batch/jobs`

**TL;DR:** Functionally the most capable surface. Visually and architecturally the most polluted. The dual-ID problem alone is a P1 cleanup. Long-term this tab should split into "Score this call" (one-call workspace) and "Manage scorecards" (admin-only) — they don't belong on the same screen.

---

### 1.5 Coaching (`#content-coaching`, lines 985–1062)

**What it does well**
- Shipped today. The three-column lifecycle (Pending Delivery / Awaiting Verification / Resolved) is the right metaphor — directly inspired by Gong's coaching board.
- Auto-trigger: 3 fails of the same attribute in 14 days → plan generated. Deterministic, idempotent, partial-unique-indexed (`uq_coaching_plans_open`).
- Auto-verification: next eval after delivery either flips to `verified_passing` or `verified_failing_again`. No manual closing.
- "Performance vs Team" (peer benchmark) section above the columns gives an SDR-grounded "where you stand" view *anonymised* — names the team median, not the peer.
- Re-scan button is operator-friendly for backfilling.

**What's broken / awkward / duplicated**
- TWO delivery modals coexist:
  - **New:** `#coachingPlanDeliverModal` (line 1068) — wired to the new `/api/coaching-plans/:id/deliver` endpoint. Used by this tab.
  - **Legacy:** `#coachingDeliveryModal` (line 1489) — wired to the older `/api/coaching-sessions` POST. Still used by the Analytics tab's "Coaching Sessions" panel.
  Comment at line 1066 explicitly says "intentionally separate" — but having two parallel coaching flows is a 6-month tech-debt bomb.
- Peer Benchmark "Pick an agent" dropdown is populated from the same source as the Coaching agent filter — duplicate fetch.
- No "all my agents" rollup view for the SDR Manager. To see overall coaching state across 6 SDRs they must scroll through one of three lists.
- No notification when a plan auto-creates. The manager has to come to this tab to discover it.

**User-journey friction**
- Manager opens this tab → sees "5 pending" badge → clicks → modal opens → fills SDR commitment → saves → modal closes → no breadcrumb of "you have 4 more to deliver."
- Verification outcome is reported in the same lane it started — once `verified_passing`, the plan moves to Resolved. There's no celebratory signal ("Outstanding — Layla's Objection Handling improved 35pts").

**Data sources**
- `GET /api/coaching-plans`, `GET /api/coaching-plans/:id`
- `POST /api/coaching-plans/:id/{deliver,dismiss}`
- `POST /api/coaching-plans/scan`
- `GET /api/sdr-evaluations/peer-benchmark`

**TL;DR:** Newest tab, cleanest design. The blocker is the parallel legacy-delivery modal. Once that's killed, this tab should anchor the entire "manager view."

---

### 1.6 CRM Compliance (`#content-compliance`, lines 1123–1187)

**What it does well**
- Real evidence-based compliance (per `src/utils/crmComplianceCheck.ts`) — replaces the original `Math.random()` mock that made the dashboard misleading. This is industry-grade.
- 4 checkmarks (Notes / Call Logged / Task / Stage) align with COPC governance clauses.
- The relocated MCP operator tools (Match phone to Zoho Lead / Re-run compliance for call id) — pulled in from the retired "QMS Bridge" tab — sit next to the compliance records, which is the right place.
- Per-call "Run compliance now" inside Call Details makes single-call retry painless.

**What's broken / awkward / duplicated**
- Compliance table is a flat list with no group-by-agent. Manager wants "all of Layla's compliance fails" → has to sort + scroll.
- No way to "approve" a compliance failure (e.g. "this call legitimately didn't need a task because the lead bounced"). All fails are equally bad.
- "Export CSV" exports the records but not the underlying Zoho activity counts that drove the boolean.
- Stale-sync risk: if an SDR creates a task in Zoho *after* compliance ran, the dashboard keeps showing failure until a manual re-check. No auto-refresh.
- Duplicate Radar violations stick around after Zoho edits (the user reported this today) — same stale-sync class of bug.

**User-journey friction**
- Manager sees "Compliance Rate 47%" on Overview → comes to this tab → sees 87 rows of fails → has no triage path.
- The Re-link / Re-check buttons live *inside Call Details*, not the compliance table. Manager has to click into each row twice (compliance table → call details → action).

**Data sources**
- `GET /api/calls/compliance`
- `POST /api/calls/:callId/compliance` (re-run)
- `POST /api/calls/mcp/leads/match-phone`
- `POST /api/calls/mcp/reconciliation/:id`

**TL;DR:** Data-correct, UX-shallow. Needs group-by-agent, a triage workflow (false-positive flag + reason), and an automated nightly re-sync to dissolve the stale-data problem.

---

### 1.7 Analytics (`#content-analytics`, lines 1189–1297)

**What it does well**
- Two genuinely useful charts: Sentiment Distribution (pie) and QA Score Trends (line).
- Agent Performance table with sentiment + QA + compliance — the closest thing to a leaderboard today.
- Topic Clusters (shipped today) — a real Gong-equivalent feature: aggregates `key_topics` from Whisper to surface patterns ("23 calls mentioned pricing objection").
- Coaching Sessions panel (lines 1252–1296) — KPI cards for the coaching loop (Delivery rate, Avg hours to deliver, Avg outcome Δ).

**What's broken / awkward / duplicated**
- Topic clustering depends on `call_analysis.key_topics` being populated. Per DMAIC Post-Republish Audit, the 199 legacy calls don't have it — Whisper would need to re-run ($-expensive).
- Coaching Sessions panel is the third "coaching" UI alongside the Coaching tab and the Coaching Effectiveness Index. The boundaries between them are blurry.
- No date range picker. "QA Score Trends" is always lifetime — useless for week-over-week.
- No per-agent drill-down from the Topic Clusters list — clicking a topic should filter the call list to those calls.
- Sentiment Distribution is a vanity chart. "30% negative" → so what?

**User-journey friction**
- Manager opens this tab last (per the tab ordering). By then they've already exhausted patience.
- Charts and tables are static images — no hover-to-export, no per-segment click.

**Data sources**
- `GET /api/calls/analytics`
- `GET /api/calls/topic-clusters`
- `GET /api/coaching-sessions/kpis`, `GET /api/coaching-sessions`
- `GET /api/coaching/effectiveness` (feature-flagged)

**TL;DR:** Reads like a "we have charts!" tab. Should split into **Insights** (the why — topic clusters, regression alerts) and the **Reports** surface (the export — see Section 4).

---

### Section 1 — TL;DR

The 7-tab architecture was an accretion, not a design. Each tab solves a real problem but the **manager journey** crosses 4-5 tabs to do one job. The data layer is healthy (15+ DB tables, ~70 well-organised API endpoints, deterministic coaching loop, COPC-aligned scorecard, real CRM compliance). The **UI layer needs a re-grouping around user intent**, not data shape — and a brand-new **Reports** surface to close the manager loop.

---

## Section 2 — Global Benchmark Comparison

I benchmarked WalaPlus against the dominant conversation-intelligence platforms and the COPC CX standard. The takeaway: WalaPlus is genuinely competitive on the *evaluation engine* but lags on three classes of feature: **deal/account intelligence**, **manager workflows**, and **mobile/email-first surfaces**.

### 2.1 Feature parity matrix

| Capability | Gong | Chorus.ai | ExecVision | SF Einstein CI | Five9 IVA | NICE / Verint | COPC standard | **WalaPlus today** |
|---|---|---|---|---|---|---|---|---|
| Dialler-native ingest | ✓ via dialler | ✓ via dialler | ✗ (file/email) | ✓ SFDC dialler | ✓ native | ✓ native | n/a | ✗ (filename-based; webhook stub exists) |
| Transcription (multi-lang) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | n/a | ✓ (Whisper, Arabic + English) |
| Speaker diarisation | ✓ | ✓ | ✓ | ✓ | partial | ✓ | n/a | ✓ (Whisper segments) |
| Scorecard (custom) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | required | ✓ (COPC v2, 4 sections × 19 cp) |
| Auto-AI evaluation | ✓ "Deal Intelligence" | ✓ "Smart Trackers" | partial | ✓ | partial | ✓ | n/a | ✓ (gpt-4o-mini judge) |
| Manager-review workflow | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | required | ✓ (approve/adjust/disagree) |
| Coaching plans | ✓ | ✓ | ✓ best-in-class | partial | ✗ | ✓ | required | ✓ (shipped today) |
| Verification on next call | ✗ | partial | ✓ | ✗ | ✗ | partial | required | ✓ (automatic) |
| Peer benchmark (anonymised) | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ | required | ✓ (shipped today) |
| Topic / theme clustering | ✓ "Trackers" | ✓ "Themes" | partial | ✓ "Call Mentions" | ✗ | partial | n/a | ✓ (Topic Clusters) |
| Sentiment | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | n/a | ✓ |
| CRM compliance audit | partial | partial | ✗ | ✓ native | ✗ | ✓ | required | ✓ best-in-class (real Zoho check, not mock) |
| Deal-level rollup | ✓ flagship feature | ✓ | ✗ | ✓ | ✗ | partial | n/a | ✗ NO |
| Account-level rollup | ✓ | ✓ | ✗ | ✓ | ✗ | partial | n/a | ✗ (Company Domain doc proposes it) |
| Forecast / risk scoring | ✓ Gong Forecast | ✓ Momentum | ✗ | ✓ Einstein | ✗ | ✗ | n/a | ✗ |
| Manager dashboard (per-team) | ✓ "War Room" | ✓ | ✓ | ✓ | ✓ | ✓ | required | ✗ (missing — biggest gap) |
| Weekly/monthly digest (auto) | ✓ email | ✓ email | ✓ email | ✓ email | partial | ✓ | required | partial (Slack + email helper exists, no PDF) |
| PDF/email shareable report | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | required | ✗ NO |
| In-app notifications | ✓ | ✓ | ✓ | ✓ | partial | ✓ | n/a | ✗ NO |
| Mobile app | ✓ iOS+Android | ✓ iOS+Android | partial | ✓ | partial | ✓ | n/a | ✗ NO |
| Arabic / RTL UI | ✗ | ✗ | ✗ | partial | ✗ | partial | n/a | ✓ first-class |
| Saudi PDPL compliance | ✗ (US/EU only) | ✗ | ✗ | partial | ✗ | partial | n/a | ✓ (consent script drafted, governance clause flagged) |
| COPC alignment | proprietary | proprietary | proprietary | proprietary | proprietary | partial | self | ✓ explicit, version-pinned |

### 2.2 Where WalaPlus is genuinely ahead

1. **COPC v2 alignment.** Most vendors use proprietary frameworks (Gong's "Smart Trackers," Chorus's "Themes"). WalaPlus's scorecard maps directly to COPC clauses with version-pinning. For Saudi audits and any regulated buyer, this is decisive.
2. **Real evidence-based CRM compliance.** Gong and Chorus do *some* CRM hygiene (Salesforce activity sync), but their compliance is not COPC-shaped. WalaPlus's 4-action compliance (Notes / Call Logged / Task / Stage) is a closer match to what an SDR Manager actually needs.
3. **Coaching verification automation.** Most coaching tools require the manager to manually close out a plan. WalaPlus auto-verifies on the next call. This is rare even at the enterprise end.
4. **Activity-fallback CRM linkage.** When phone-match fails, the platform tries same-agent + same-day Zoho activity. Gong falls back to "no match" and stops. WalaPlus recovers 10–20% of unlinked calls.
5. **Arabic-first RTL UI + PDPL.** No commercial CI platform has Arabic-first design. For KSA-based SDR teams this is a moat.
6. **Filename parser as historical-import escape hatch.** Most vendors *only* accept dialler webhooks. WalaPlus's strict parser lets you bulk-import legacy recordings reliably.

### 2.3 Where WalaPlus lags

| Gap | Severity | Cost to close |
|---|---|---|
| **No manager dashboard.** No "war room" view per-team. Manager must mentally aggregate. | HIGH | Phase 2 of this plan |
| **No PDF / email report.** Cannot share results outside the app. | HIGH | Phase 3 of this plan |
| **No notifications.** Coaching plan auto-creates but no Slack/email ping. Weekly digest exists in code but not in UI. | HIGH | Phase 2 |
| **No deal/account rollup.** Each call is evaluated in isolation. Gong groups by deal. | MEDIUM | Out of scope for v1 (Company Domain doc covers it) |
| **No mobile.** Manager can't review on phone. | MEDIUM | Phase 5+ |
| **No real-time alerts.** A "critical" eval just sits in the table. | MEDIUM | Phase 2 (alert rules) |
| **No live transcription.** Recording is post-call. | LOW | Architectural — defer |
| **No call recommendation feed.** "You should review this call" is not surfaced. | LOW | Phase 4 (Insights) |
| **No forecast integration.** Can't predict pipeline from call quality. | LOW | Out of scope — Gong's moat |
| **Five9 webhook ingest broken.** Endpoint exists, dialler isn't pushing. | HIGH (operational) | Outside dev — vendor config |
| **No "send to SDR Manager" workflow.** | CRITICAL | Phase 3 |

### 2.4 What WalaPlus should NOT try to copy

- **Gong Forecast** — needs ML on years of CRM data; over-scope for a 7-person GRQ team.
- **Live call coaching** — requires real-time dialler integration; defer.
- **Mobile-first design** — managers do this work at a desk; mobile is nice-to-have.
- **Salesforce-style permission marketplace** — WalaPlus just simplified to 2 roles (admin/viewer). Don't undo.
- **Public APIs** — internal tool, no external integrations needed.

**TL;DR:** WalaPlus has the *engine* of a Gong-class tool. The gaps are in the *manager loop* (dashboard, report, notify) and the *deal/account view*. The first three Phase deliverables — Reports, manager dashboard, notifications — close the GAP that matters most.

---

## Section 3 — The Manager-Reportable Output Problem

This is the user's biggest complaint, in their own words: *"to be easily reported and sending to the SDR Manager."* Today the answer is: there is no such workflow. Below is the design.

### 3.1 What the SDR Manager actually needs

Through reading the COPC standards, Gong's manager-view docs, and the WalaPlus DMAIC docs (especially `Case_Study_Filename_Parser_2026_05_25.md` and `DMAIC_Post_Republish_Audit_2026_05_25.md`), the SDR Manager's actual job-to-be-done has three modes:

1. **Monday-morning team scan** — *"Who needs attention this week?"* — 5-minute scan.
2. **One-on-one prep** — *"What's Layla's pattern? What should I coach her on?"* — 10 minutes before a 1:1.
3. **Period-end review** — *"Show me a defensible quality assessment of my team for Q1."* — for upward reporting.

Each mode wants a different artifact:

| Mode | Artifact | Frequency | Length |
|---|---|---|---|
| Monday-morning | In-app dashboard + Slack digest | Weekly | 1 screen |
| 1:1 prep | Per-agent PDF (auto-emailed Sunday 6pm KSA) | Weekly | 2-3 pages |
| Period-end | Per-team PDF, includes trend lines + coaching ROI | Monthly / quarterly | 10-15 pages |

### 3.2 Existing infrastructure we can reuse

- `src/utils/weeklyDigest.ts` — already computes per-agent rollups, renders Slack blocks, renders HTML email. Just not exposed as a UI button or PDF.
- `pdfkit` is already a dependency (line 62 of package.json).
- `exceljs` is already there for CSV/XLSX export.
- `@slack/web-api` is wired for Slack notifications.
- `resend` is wired for transactional email.
- `src/mastra/workflows/weeklyDigestCron.ts` already runs Sunday 06:00 Asia/Riyadh.

We are missing the **PDF renderer**, the **in-app Reports surface**, and the **delivery preferences** for who gets what when.

### 3.3 Report types — proposed

**Type A: Manager Pulse (daily Slack post)**
- 1 message, posted to `#sdr-quality` channel at 09:00 KSA Mon-Fri.
- Format: "Yesterday: 12 calls, 8 analyzed, 2 critical, 1 new coaching plan for {SDR}. [Open dashboard]."
- One-click drill into the day's records.
- Reuses Slack blocks helper.

**Type B: Weekly Team Digest (PDF + email + Slack thread)**
- Sunday 18:00 KSA.
- One PDF (~4 pages) per SDR Manager covering all their SDRs.
- Sections:
  1. Cover: week label, manager name, team size, exec summary (3 bullets).
  2. Team leaderboard (table) — avg QA, compliance %, coaching status per SDR.
  3. Top 5 calls to review — flagged by the system (critical risk, score outliers, manager-disagreed).
  4. Coaching loop status — open plans, delivered this week, verified passing, verified failing again.
  5. Trend lines — team QA, compliance, sentiment over last 8 weeks.
- Slack thread: the same exec summary + a link to the PDF.

**Type C: Per-SDR Coaching Brief (on-demand)**
- Generated when manager clicks "Generate brief" on an agent's profile.
- 2 pages.
- Sections: last 30 days at a glance, attribute breakdown vs team median, last 3 representative calls (timestamp + 1-line summary), open + recently-closed coaching plans, suggested talking points (auto-generated from failed attributes).
- Designed to be opened on a laptop during a 1:1 with the SDR.

**Type D: Quarterly Quality Report (PDF + XLSX)**
- For external/upward reporting (e.g. to the COO).
- 10–15 pages.
- Covers: team performance over the quarter, COPC scorecard adherence by section, compliance trend, coaching ROI (Coaching Effectiveness Index — CEfx — already shipped as Solution #5), top topics, sample calls (anonymised quotes), audit signature.
- Generated on-demand from the Reports tab.

**Type E: Critical-Call Alert (real-time)**
- Triggered immediately when a call's overall score < 40 OR critical_risk == true OR a manager flags a call.
- Slack DM + email to the relevant manager + in-app notification badge.
- Includes a deep-link to the Call Details modal.

### 3.4 Delivery channels — recommended matrix

| Report | In-app | Slack | PDF | XLSX | Email | Frequency |
|---|---|---|---|---|---|---|
| Type A — Pulse | – | ✓ | – | – | – | Daily 09:00 |
| Type B — Weekly Digest | ✓ (Reports tab) | ✓ (link) | ✓ | – | ✓ | Sun 18:00 |
| Type C — Coaching Brief | ✓ (button) | – | ✓ | – | ✓ (download) | On-demand |
| Type D — Quarterly | ✓ (Reports tab) | ✓ (link) | ✓ | ✓ | ✓ | Quarterly + on-demand |
| Type E — Critical Alert | ✓ (toast) | ✓ DM | – | – | ✓ | Real-time |

### 3.5 The drill-down path

```
Slack Weekly Digest message
        │
        │   "12 critical calls last week — click to triage"
        ▼
Manager opens in-app /calls?report=W2026-21
        │
        │   Lands on the Reports tab → opens the saved digest
        ▼
"Open the team leaderboard" → Team view
        │
        │   Manager spots Layla at the bottom
        ▼
Click on Layla → Agent view (per-SDR)
        │
        │   Sees her Objection Handling is the systemic gap
        ▼
Click on the failing attribute → list of 7 calls that failed it
        │
        │   Picks the 2 worst
        ▼
Opens Call Details modal → listens to clip → reads transcript → adjusts AI eval
        │
        ▼
Generates Type C — Coaching Brief → emails to Layla → schedules 1:1
        │
        ▼
After 1:1, manager clicks "Mark Coaching Plan Delivered" + captures SDR commitment
        │
        ▼
System auto-verifies on Layla's next eval and reports back in next Weekly Digest
```

Every step is one click. Today this same journey is 9+ clicks across 5 tabs with manual context-switching.

**TL;DR:** Reports are the missing capstone. Build five report types reusing existing infrastructure (weeklyDigest.ts, pdfkit, exceljs, Slack/Resend). The biggest win is the Weekly Digest PDF — closes the manager loop in week one of Phase 3.

---

## Section 4 — Proposed Information Architecture

### 4.1 Design principles

1. **Group by user intent, not data shape.** A manager thinks "which agent?", not "which database table?"
2. **One screen per intent.** No more than 4 top-level surfaces; sub-tabs only inside each surface, max 2 levels deep.
3. **The Call Details modal is the universal pivot.** From any surface, clicking a call opens the same modal.
4. **Configuration is a separate, admin-only zone.** Quality team configures scorecards and integrations away from operational work.
5. **Reports are first-class, not an export afterthought.**

### 4.2 The four proposed surfaces

```
┌──────────────────────────────────────────────────────────────┐
│  /calls — Call Evaluation                                    │
│                                                              │
│  ┌────────┬──────────┬──────────┬──────────┬────────────┐   │
│  │  Team  │ Agents   │ Calls    │ Reports  │ Config     │   │
│  └────────┴──────────┴──────────┴──────────┴────────────┘   │
│                                                              │
│  TEAM VIEW (default landing for managers)                    │
│  ─────────                                                   │
│  • KPI strip with date scope (today / 7d / 30d / 90d / Q)    │
│  • Team leaderboard (sortable: QA / compliance / coaching)   │
│  • Coaching board (3-column lifecycle, unchanged)            │
│  • Critical-call inbox (this week's flagged calls)           │
│  • [Generate Weekly Report] CTA                              │
│                                                              │
│  AGENTS VIEW (per-SDR detail page)                           │
│  ───────────                                                 │
│  • Select agent dropdown / left-rail list                    │
│  • SDR summary card (face, role, tenure, current score)      │
│  • Trend chart (QA score over last 12 weeks)                 │
│  • Peer benchmark (the existing widget, anonymised)          │
│  • Per-attribute breakdown table (PASS/FAIL counts)          │
│  • Call history (paginated)                                  │
│  • Coaching history (open + resolved plans)                  │
│  • [Generate Coaching Brief] CTA                             │
│                                                              │
│  CALLS VIEW (record list + search + bulk)                    │
│  ──────────                                                  │
│  • Existing Call Records table — unchanged structure         │
│  • Bulk-select toolbar                                       │
│  • Phone search + new agent filter + flagged filter          │
│  • By Phone view mode toggle                                 │
│  • [Upload Calls] button → opens Data Sources surface as modal│
│                                                              │
│  REPORTS VIEW (new)                                          │
│  ────────────                                                │
│  • Generated reports list (saved Weekly Digests, Briefs, Q*) │
│  • [Send Weekly Digest now] CTA                              │
│  • [Generate Quarterly Report] CTA                           │
│  • [Configure Recipients + Cadence] sub-section              │
│                                                              │
│  CONFIG VIEW (admin only)                                    │
│  ───────────                                                 │
│  • Scorecard management (current SDR Evaluation embed)       │
│  • Data Sources (Five9 / Drive / Zoho Calls Import)          │
│  • CRM Compliance settings + Match-phone / Reconciliation    │
│  • Integration status                                        │
│  • Bulk operations (backfill, re-analyse, batch eval)        │
└──────────────────────────────────────────────────────────────┘
```

### 4.3 Tab-to-surface mapping (the migration)

| Today's tab | New home | What changes |
|---|---|---|
| Overview | Team view (default) | KPIs gain date scope, drill-throughs, and "Send Weekly Report" button. Calls-by-Source pie is retired (no actionable signal); replaced with a coverage panel (analysed % vs total). |
| Call Records | Calls view | Mostly intact. Add agent filter, flagged filter. Promote bulk toolbar discoverability. Pagination becomes server-side past 500 rows. |
| Data Sources | Config view → Data Sources sub-section | Moves out of the main flow. Operators visit Config when they need to. Dead "Manual Upload" card deleted. |
| SDR Evaluation | **Split.** One-call workspace becomes part of the Call Details modal (already 80% there). Scorecard management moves to Config. AI Training Feedback moves to Reports → AI quality. | Two distinct concerns separated. The dual-ID problem disappears. |
| Coaching | Team view (the 3-column board) + Agents view (per-SDR plans) | Manager sees the team-wide pulse on Team; per-SDR drill-down on Agents. Peer Benchmark moves to Agents view. |
| CRM Compliance | Team view (KPIs strip + table widget) + Config view (operator tools — Match phone, Reconciliation) | Operational KPIs surface on Team; debug tools relocated to Config. |
| Analytics | Team view (trend lines) + Agents view (per-agent trends) + Reports view (topic clusters, coaching ROI) | Distributed by audience. Topic Clusters move to Reports as content for the Quarterly. |

### 4.4 User journeys — proposed

**Journey A — Monday-morning manager scan (target: 5 minutes)**
1. Land on `/calls` → Team view (default).
2. Glance at KPIs (today vs last week delta).
3. Sort leaderboard by `coaching attention`.
4. Click the worst SDR → Agents view.
5. Spot the systemic attribute.
6. Click [Generate Coaching Brief] → PDF preview → email to SDR.

**Journey B — Audit prep (target: 20 minutes)**
1. Land on `/calls` → Reports.
2. Click [Generate Quarterly Report] → choose Q1 2026.
3. Wait ~30s for PDF.
4. Download + email to COO.

**Journey C — Mid-week alert response (target: 2 minutes)**
1. Slack DM: "Critical call from Saud just got scored 32/100."
2. Click link → Call Details modal opens in a new tab.
3. Listen to 30s clip → read transcript → understand it's a model false negative.
4. Click [Adjust Review] → fix per-attribute scores → save with rationale.
5. AI Training Feedback table updates.

Today, all three journeys take 3-5× longer.

### 4.5 What stays the same (don't fix what works)

- The unified Call Details modal — keep it as-is, just polish.
- The coaching loop trigger logic (`coachingPlans.ts`) — untouched.
- The scorecard data model (COPC v2) — untouched; treated as canonical.
- The SDR auto-evaluator — untouched; it's the engine.
- Phone normalisation, related-calls lookup, filename parser — all untouched.
- RBAC (2-role admin/viewer) — untouched, just shipped.

**TL;DR:** Four top-level surfaces (Team / Agents / Calls / Reports / Config — Config is admin-only and lives as a fifth tab). The Call Details modal remains the universal pivot. No new DB tables in Phase 1. The 7-tab → 4-surface collapse is half about deletion (kill duplicate modals and zombie tabs) and half about regrouping by user intent.

---

## Section 5 — Phased Implementation Plan

Five phases. Each ships independently. Total effort estimate: **5.5–7 person-weeks** over a 6-week calendar.

### Phase 1 — Cleanup & consolidation (1 week)
**Goal:** delete dead code; merge duplicate modals; collapse 7 tabs → 5 surfaces (Team/Agents/Calls/Reports/Config) with the existing content rearranged. No new functionality.

**Deliverables**
- Delete `#coachingDeliveryModal` (lines 1489–1539). Migrate the single Analytics-tab caller to `#coachingPlanDeliverModal`.
- Delete `#transcriptModal` (lines 1393–1412) and its open/close handlers — transcript is already inline in Call Details.
- Delete deprecated `#content-scorecards` div (lines 911–977) — the `hidden` attribute is masking ~70 lines of dead DOM and 2 duplicate ID collisions.
- Delete the hidden "Manual Call Upload" card (lines 541–629) and the never-used `handleFileSelect` / `clearUploadFile` / `uploadManualCall` handlers.
- Delete the hidden "noData" empty-state block (lines 1299–1308) and the orphan `showIngestModal` call — empty state should live inside the calls list, not as a body-level zombie.
- Rename tabs: Overview → Team, Call Records → Calls, Data Sources → Config (with sub-tabs), SDR Evaluation collapses (scorecard mgmt → Config; per-call eval → Call Details modal), Coaching → split between Team (board) + Agents, CRM Compliance → Team + Config, Analytics → Reports (trend lines + new tab content).
- Add Agents tab (per-SDR landing page) — initially just renders the existing peer-benchmark widget + agent's call list.
- Add Reports tab — initially just renders the existing Coaching Sessions panel + Topic Clusters + a "Send Weekly Digest now" button.
- Disambiguate duplicate IDs: rename `-embedded` suffix variants permanently; delete the legacy un-suffixed copies.

**Effort:** 5 dev-days
**Risk:** LOW. Surgical deletes + DOM moves. No business logic changes. Existing tests still pass.
**Dependencies:** None.
**Deleted:** ~600 lines from `calls.html`; ~3 unused JS functions.
**Added:** ~150 lines (the two new tab scaffolds).
**Reused:** Everything else.

### Phase 2 — Manager dashboard (Team view) (1.5 weeks)
**Goal:** the manager's Monday-morning surface. Date-scoped KPIs, leaderboard, critical-call inbox, coaching board.

**Deliverables**
- Date scope picker (today / 7d / 30d / 90d / Q / custom) wired into `GET /api/calls/analytics?from=&to=`.
- Backend: extend the analytics endpoint to accept a date range. Currently it's lifetime.
- Team leaderboard table (one row per agent): avg_score, last-30d-trend chip (▲/▼), compliance %, open coaching count, critical-call count, [Open Agent View] link.
- Critical-call inbox: pulls calls with `overall_score < 40 OR critical_risks.length > 0 OR flagged=true`. Sortable, batch-action ready.
- New `flagged` boolean column on `call_records` + endpoint `POST /api/calls/:id/flag`. Manager can star calls for SDR Manager review.
- Move the coaching board from `#content-coaching` into the Team view (keep the 3-column structure).
- Remove "Calls by Source" pie chart (no decisional value).
- Replace it with a "Coverage Funnel" chart: Uploaded → Transcribed → Analysed → Scored → Manager-Reviewed. Pinpoints pipeline drop-off.
- Add "Send Weekly Report now" button → POSTs `/api/calls/weekly-digest/send` (already exists).

**Effort:** 7 dev-days
**Risk:** MEDIUM. Backend change (date range + flagged column).
**Dependencies:** Phase 1 must ship first (new IA).
**Deleted:** ~30 lines (the unused pie chart + unused source filter).
**Added:** ~500 lines (new Team view layout + flagged endpoint + coverage funnel).
**Reused:** Coaching plans table, peer benchmark backend, weekly digest helper.

### Phase 3 — Reports & manager-shareable artifacts (1.5 weeks)
**Goal:** close the user's biggest complaint — "easily reported and sent to the SDR Manager."

**Deliverables**
- New `reports` DB table: `id, type, generated_for, generated_by, period_start, period_end, payload_jsonb, pdf_blob, xlsx_blob, created_at, sent_to (email[]), sent_at`.
- New endpoints:
  - `POST /api/reports/weekly-digest` — generate + persist + (optionally) send.
  - `POST /api/reports/coaching-brief?agent=...` — generate per-SDR brief.
  - `POST /api/reports/quarterly?from=&to=` — generate quarterly.
  - `GET /api/reports` — list past reports.
  - `GET /api/reports/:id/pdf` — download.
- PDF renderer using `pdfkit` (already in deps). 5-template architecture:
  - `WeeklyDigest.pdf.ts`
  - `CoachingBrief.pdf.ts`
  - `Quarterly.pdf.ts`
  - `CriticalCallAlert.html.ts` (email-only, no PDF)
  - `DailyPulse.slack.ts` (Slack-only)
- Recipients configuration UI in Reports tab — pick which managers get which report at which cadence.
- Reuse `weeklyDigest.ts` for the data layer; the renderer is purely additive.
- Wire the Inngest cron at `weeklyDigestCron.ts` to also persist to the `reports` table so a Sunday-night failure is recoverable on Monday.
- In-app toast/badge when a new critical-call alert fires (uses existing event-log infra).

**Effort:** 7 dev-days
**Risk:** MEDIUM. PDF rendering across Arabic text is the unknown. (Mitigation: pdfkit has Arabic support via a custom font; verify in spike.)
**Dependencies:** Phase 2 (date-scoped analytics).
**Deleted:** Nothing.
**Added:** New table, 5 endpoints, 5 templates, ~1,200 lines.
**Reused:** weeklyDigest.ts (data layer), Slack helper, Resend helper.

### Phase 4 — Agents view & coaching loop polish (1 week)
**Goal:** the per-SDR detail page, the "Coaching Brief" surface.

**Deliverables**
- New Agents tab content: agent selector → SDR summary card (avg score, tenure, last call, role).
- 12-week QA trend line chart.
- Per-attribute pass/fail breakdown table (for the canonical 19 checkpoints).
- Agent's call history (paginated, filterable by date).
- Agent's coaching history (open + resolved + dismissed).
- [Generate Coaching Brief] button → triggers Phase 3 endpoint → opens PDF.
- Notification badge on the Coaching tab badge — "1 new plan for Layla" — surfaced in nav.
- Polish on coaching loop: a "Verified Passing" plan triggers a celebratory toast for the manager + a coaching-loop closure event log.

**Effort:** 5 dev-days
**Risk:** LOW. Mostly UI composition over existing endpoints.
**Dependencies:** Phase 3 (PDF generation).
**Deleted:** Nothing.
**Added:** ~700 lines (Agents view content).
**Reused:** peer-benchmark, coaching-plans, sdr-evaluations, analytics endpoints.

### Phase 5 — Insights & critical-call alerting (0.5–1 week)
**Goal:** real-time alerts and Insights-level analytics (Topic Clusters as a manager tool, not a vanity chart).

**Deliverables**
- Topic Clusters → click a topic → filter the Call list, with an "Add to Quarterly Report" button.
- Critical-Call Alert pipeline: on eval save, if `overall_score < 40 OR critical_risks.length > 0`, fire Slack DM + email + in-app toast to the agent's manager.
- Alert rule config UI (in Config) — threshold + recipients per rule.
- Coaching Effectiveness Index (CEfx — already shipped) surfaced as a card on Reports.

**Effort:** 4 dev-days
**Risk:** LOW.
**Dependencies:** Phase 3 (notification infrastructure), Phase 4 (Agents view to deep-link from alert).
**Deleted:** Nothing.
**Added:** ~400 lines.
**Reused:** topic-clusters endpoint, CEfx endpoint, Slack/Resend helpers.

### 5.6 Phase summary table

| Phase | Days | Calendar | Risk | Ship value |
|---|---|---|---|---|
| 1 — Cleanup & IA | 5 | week 1 | LOW | -600 lines debt; cleaner mental model |
| 2 — Team view | 7 | weeks 2–3 | MEDIUM | Manager's Monday-morning surface lands |
| 3 — Reports | 7 | weeks 3–4 | MEDIUM | The user's #1 complaint addressed |
| 4 — Agents view + polish | 5 | week 5 | LOW | 1:1 prep workflow lands |
| 5 — Insights + alerts | 4 | week 6 | LOW | Real-time loop closed |
| **Total** | **28 days** | **6 weeks** | — | — |

### 5.7 Suggested team allocation

If one full-time engineer: 6 calendar weeks straight-through.
If two engineers (one frontend, one backend): can compress to 4 calendar weeks by parallelising Phase 3 (backend) and Phase 4 (frontend).
QA: 1 day per phase for verification.

**TL;DR:** Five phases, ~6 calendar weeks. The biggest single user-visible win is Phase 3 (Reports). Phase 1 (cleanup) is a one-week investment that unlocks everything else.

---

## Section 6 — Technical Debt to Delete

A catalog of duplicates and zombies the cleanup phase should remove.

### 6.1 Duplicate modals

| Modal | Status | Action |
|---|---|---|
| `#coachingPlanDeliverModal` (line 1068) | KEEP — new canonical | – |
| `#coachingDeliveryModal` (line 1489) | DELETE — legacy alongside new | Remove + migrate Analytics tab caller |
| `#transcriptModal` (line 1393) | DELETE — transcript is inline | Remove + the orphan open/close handlers |
| Standalone Activity Timeline modal | Already deleted (DMAIC Call Details Unification) | – |
| `#callDetailModal` (line 1311) | KEEP — universal pivot | – |
| `#scorecardModal` (line 1334) | KEEP — relocates to Config | Move, don't delete |
| `#adjustReviewModal` (line 1421) | KEEP — high-value editor | – |

### 6.2 Zombie content blocks

| Block | Line | Action |
|---|---|---|
| `#content-scorecards` (`hidden`, `data-deprecated`) | 911–977 | DELETE entire block |
| Hidden Manual Upload card | 541–629 | DELETE entire block |
| `#noData` empty-state | 1299–1308 | DELETE; replace with inline empty-state inside `#callsTable tbody` |
| Comments referencing "retired QMS Bridge tab" | scattered | Keep as historical context for one release, then prune |

### 6.3 Duplicate DOM IDs

The dual-ID problem in SDR Evaluation tab — three parallel ID sets exist:
- `#scorecards-list`, `#ai-training-stats`, `#stat-reviewed` etc. (deprecated, hidden)
- `#scorecards-list-embedded`, `#stat-reviewed-embedded` etc. (live, suffixed)
- `#scorecards-list` (live, in embedded panel — collides with first)

**Action:** rename the embedded versions to drop the `-embedded` suffix; delete the deprecated block (see 6.2); update all JS lookups. ~30 ID rename refs.

### 6.4 Orphan JS functions

Functions still defined but with no callers after the planned deletions:
- `handleFileSelect`, `clearUploadFile`, `uploadManualCall` (after Manual Upload card deletion).
- `showIngestModal` (after `#noData` deletion).
- `openTranscriptModal`, `closeTranscriptModal` (after `#transcriptModal` deletion).
- `openCoachingDeliveryModal`, `closeCoachingDeliveryModal`, `saveCoachingDelivery` (after legacy modal deletion).

**Action:** delete in the cleanup phase. ~150 LOC.

### 6.5 Dead API endpoints to deprecate (but keep responding)

| Endpoint | Why deprecate | Migration |
|---|---|---|
| `POST /api/calls/upload` (line 1983) | Superseded by `upload-audio` and `bulk-upload` | Keep responding with redirect/410 + log to event log |
| `POST /api/coaching-sessions` (legacy delivery) | Superseded by `/api/coaching-plans/:id/deliver` | Keep responding for 1 release, then 410 |

### 6.6 Configuration knobs that are no-ops

- The legacy "scorecard_type" enum (`sdr | sales`) on `call_qa_scores` — only "sdr" is used. Either remove the column or seed a `unified` constant.
- Fallback agent-email field on bulk upload (already removed in code but legacy DB rows may have polluted data).

**TL;DR:** ~600 lines of cruft to delete in Phase 1. Two duplicate modals, three duplicate ID sets, six orphan functions, two no-op enums. None of this is functionality the user values; all of it is friction for whoever modifies this codebase next.

---

## Section 7 — Open Questions for Product Leadership

These are decisions I can't make without your input. They block at least one phase each.

### 7.1 Architectural choices

1. **Incremental tab-by-tab or SPA reskin?**
   - Incremental (recommended): keep `calls.html` as one page; restructure DOM; ship in 5 phases. Lowest risk, fastest first-value.
   - SPA reskin: split `calls.html` (currently 7,462 lines) into a real component framework (Vue/Lit). Higher upfront cost, cleaner long-term, but the rest of the WalaPlus dashboard is also raw HTML — would diverge architecturally.
   **Recommendation:** Incremental. The codebase is consistent; don't break that.

2. **Single COPC v2 scorecard or generalise?**
   - Today the scorecard is hard-pinned to COPC v2 + the "Create Scorecard" modal lets ops accidentally diverge. Should we (a) lock scorecard creation as admin-only with a confirmation guard, (b) version every scorecard and keep COPC v2 as the only active one, or (c) allow per-team scorecards (SDR vs Sales)?
   **Recommendation:** (b) — keep COPC v2 canonical, version all scorecards. Per-team comes only if Sales adopts the platform.

3. **Five9 webhook vs filename parser permanence**
   - The filename parser was always the short-term escape hatch. Should Phase 3 budget include Five9 webhook commissioning (vendor config + endpoint hardening)?
   **Recommendation:** Out of scope for this revamp. Track separately as a vendor-config task.

### 7.2 Reports & cadence

4. **Weekly Digest send day/time?**
   - Today's cron: Sunday 06:00 KSA. Some teams want Monday 07:00 (so it's the first thing on Monday).
   **Default proposal:** Sunday 18:00 KSA — gives the manager Sunday evening to read while the team isn't yet active.

5. **Quarterly report — who signs?**
   - Does the SDR Manager sign? Quality Lead? Both? Does WalaPlus need an audit-trail signature on the PDF (e-sign integration), or just an attestation field?
   **Default proposal:** auto-generate; manager downloads + emails. No e-sign in v1.

6. **PDF language — Arabic, English, or bilingual?**
   - The UI is bilingual. The PDF is currently nowhere. Generating Arabic in pdfkit requires careful font setup. Bilingual doubles the page count.
   **Default proposal:** English-primary, with Arabic name fields where applicable. Full Arabic in Phase 5 if leadership asks.

### 7.3 Notifications & alerts

7. **Slack channel topology**
   - One channel for all alerts? One per manager? DMs?
   **Default proposal:** Daily Pulse to a shared `#sdr-quality` channel; Critical-Call Alerts as DMs to the specific manager.

8. **Alert thresholds**
   - Today there's no critical-call threshold. Should "overall score < 40" be the default? Or per-team configurable?
   **Default proposal:** Default `< 40`, configurable in Config view.

9. **Notification retention**
   - In-app notifications — keep last 30 days? 90? Forever?
   **Default proposal:** 90 days, then archive.

### 7.4 Scope and platform

10. **Mobile responsive priority**
    - The current UI is desktop-only. Managers occasionally check from phones. Is mobile a Phase 5 deliverable or Phase 6+?
    **Default proposal:** Phase 6+. Audit-prep and 1:1 prep need a screen, not a phone.

11. **Multi-language scope**
    - Today: Arabic + English. Add others (Hindi for Saudi blue-collar audience, etc.)?
    **Default proposal:** No. Two languages cover the current user base.

12. **CS/Support adoption**
    - The scorecard editor mentions Sales / CS / Support teams. Is anyone outside SDR planning to adopt this?
    **Default proposal:** No new team in this revamp window. CS adoption is post-Phase 5.

13. **Audit-readiness**
    - The Quarterly Report is the closest thing to an audit artifact. Does the manager need an "audit-ready" mode (showing every manager-adjusted review, every dismissed coaching plan, etc.) or is the operational report sufficient?
    **Default proposal:** Operational sufficient for v1; audit-ready in Phase 5 if requested.

### 7.5 Data and legal

14. **PDPL consent capture as a 6th compliance metric**
    - The `Case_Study_Filename_Parser_2026_05_25.md` proposes capturing `consent_captured` + `consent_quote`. Should this revamp ship that as part of CRM Compliance?
    **Default proposal:** Add the boolean in Phase 3 (cheap addition); Whisper-derived quote in Phase 5.

15. **Manager review of dismissed coaching plans**
    - Today, a manager dismisses a plan with a reason — there's no oversight. Should an SDR Manager have an auditor view that lists all dismissed plans?
    **Default proposal:** Yes, add to Reports → Coaching audit sub-view in Phase 5.

16. **Anonymisation in Reports**
    - The Quarterly report includes "sample call quotes." Should agent names be redacted in the upward-shared version?
    **Default proposal:** Yes — provide a "Redact for external audience" toggle on the Quarterly export.

**TL;DR:** 16 open questions. The biggest 3 to answer before Phase 2 starts: (1) Incremental vs SPA, (2) Weekly Digest cadence, (3) PDF language. The rest can be answered Phase-by-Phase.

---

## Section 8 — Success Metrics (DMAIC Control)

How will we know the revamp worked? Six quantitative metrics + one qualitative.

### 8.1 Time-based

| Metric | Today (estimate) | Target (post-revamp) | How to measure |
|---|---|---|---|
| Time-to-evaluate-a-call (manager) | ~12 min (modal hops + tab switches) | < 5 min | Self-report + page-event telemetry: `call_details_open` → `eval_save` interval |
| Time-from-call-to-coaching-plan-delivered | ~14 days | < 7 days | DB: `coaching_plans.created_at` → `delivered_at` median |
| Time to generate weekly report | currently impossible | < 30 seconds | `POST /api/reports/weekly-digest` latency |
| Manager Monday-morning scan | ~30 min across 5 tabs | < 5 min on one tab | Self-report + Team-view dwell-time telemetry |

### 8.2 Click-based

| Metric | Today | Target |
|---|---|---|
| Clicks from Overview → "Layla's 2 worst calls last week" | 11 clicks | 3 clicks (Team → Layla → critical-calls list) |
| Clicks from "I just got a Slack alert" → "I've adjusted the AI eval" | 8+ clicks | 4 clicks (Slack → Call Details → Adjust → Save) |
| Clicks to send a weekly report | n/a (impossible) | 1 click on the [Send Now] button |

### 8.3 Coverage / quality

| Metric | Today | Target |
|---|---|---|
| % of analysed calls with `duration_seconds NOT NULL` | ~85% (post-DMAIC backfill, lazy self-heal climbing) | > 95% |
| % of analysed calls with a CRM link (Lead or Deal, any signal) | ~73% | > 85% (via activity fallback + Zoho data cleanup, not code) |
| % of failed coaching plans where verification ran | 100% if next call lands (deterministic) | 100% (unchanged) |
| % of weeks where Weekly Digest sent on time | n/a | > 98% (cron reliability) |
| Manager Reports Generated per week (post-launch) | 0 | ≥ 1 per active manager |

### 8.4 Adoption

| Metric | Today | Target (1 month post-launch) |
|---|---|---|
| Distinct managers logging into `/calls` weekly | unknown | All active SDR managers + Quality lead |
| Weekly Digest open rate (email) | n/a | > 60% |
| Slack Critical-Call Alert reaction rate (any emoji within 1h) | n/a | > 40% |
| Coaching plans delivered within 48h of auto-creation | unknown | > 70% |
| Manager-Adjusted reviews per week | currently ~5/wk | ≥ 10/wk (signals managers are engaging with AI evals) |

### 8.5 Code-health metrics

| Metric | Today | Target |
|---|---|---|
| `calls.html` LOC | 7,462 | < 7,000 (after cleanup) |
| Duplicate DOM IDs in `calls.html` | ≥ 6 (manual count) | 0 |
| Number of modals | 7 | 4 (callDetail, adjustReview, scorecardEdit, coachingDeliver) |
| Dead JS functions | ~6 | 0 |
| API endpoints under `/api/calls/*` and `/api/coaching-*` | ~70 | ~70 (no regression; some additions in Phase 3) |

### 8.6 Qualitative signal

- **Quarterly user-survey question to SDR Managers:** "How easy is it to evaluate your team's calls this week? (1–10)"
- Baseline (today): expect 4–5 based on the user's brief ("complex inside and not linked well").
- Target after Phase 4: ≥ 8.

### 8.7 Anti-metrics — what we should NOT optimise for

- Total calls in the database — quantity ≠ quality.
- Number of features per tab — more chrome makes the manager slower.
- Page-load speed — already acceptable; not the bottleneck.
- AI evaluation accuracy (in isolation) — without manager engagement, accuracy is moot. The metric that matters is *manager-AI agreement rate* (already tracked).

**TL;DR:** Six quantitative metric clusters (time / clicks / coverage / adoption / code health / qualitative). The two metrics to monitor first post-launch: **time-to-evaluate-a-call** and **manager Reports generated per week**. If the second metric is zero after a month, the Reports phase failed and needs a rework.

---

## Appendices

### A. File and line reference for implementers

| Concern | File | Line(s) |
|---|---|---|
| Tab nav bar | `dashboard/calls.html` | 80–127 |
| Overview tab content | `dashboard/calls.html` | 135–286 |
| Call Records tab content | `dashboard/calls.html` | 288–402 |
| Data Sources tab content | `dashboard/calls.html` | 404–717 |
| SDR Evaluation tab content | `dashboard/calls.html` | 718–906 |
| Deprecated Scorecards tab | `dashboard/calls.html` | 911–977 (DELETE) |
| Coaching tab content | `dashboard/calls.html` | 985–1062 |
| Coaching Plan Deliver modal (keep) | `dashboard/calls.html` | 1068–1121 |
| CRM Compliance tab content | `dashboard/calls.html` | 1123–1187 |
| Analytics tab content | `dashboard/calls.html` | 1189–1297 |
| `#noData` zombie | `dashboard/calls.html` | 1299–1308 (DELETE) |
| Call Details modal | `dashboard/calls.html` | 1311–1328 |
| Scorecard editor modal | `dashboard/calls.html` | 1334–1391 |
| Transcript modal (DELETE) | `dashboard/calls.html` | 1393–1412 |
| Adjust Review modal | `dashboard/calls.html` | 1421–1482 |
| Legacy Coaching Delivery modal (DELETE) | `dashboard/calls.html` | 1489–1539 |
| `viewCall()` modal renderer | `dashboard/calls.html` | ~2254 |
| Phone normalisation | `dashboard/calls.html` | ~1551 |
| `loadInlineActivityTimeline` | `dashboard/calls.html` | ~2620 |
| Integrations banner | `dashboard/calls.html` | 1653–1697 |

### B. Backend file map

| Concern | File | Notes |
|---|---|---|
| All call API endpoints | `src/mastra/routes/callIntelligenceRoutes.ts` | ~70 endpoints, ~5,749 lines |
| DB schema + queries | `src/utils/callIntelligenceDb.ts` | ~15 tables, ~2,386 lines |
| Coaching loop (trigger + verify + lifecycle) | `src/utils/coachingPlans.ts` | 541 lines — DO NOT REFACTOR IN THIS REVAMP |
| Auto-evaluator | `src/utils/sdrAutoEvaluator.ts` | 297 lines — DO NOT REFACTOR |
| COPC v2 canonical | `src/data/scorecardV2CopcCanonical.ts` | 272 lines — DO NOT EDIT WITHOUT REGENERATING JSON |
| CRM compliance engine (real Zoho) | `src/utils/crmComplianceCheck.ts` | 238 lines |
| Weekly digest helper | `src/utils/weeklyDigest.ts` | Already there — Phase 3 wraps it in PDF + UI |
| Weekly digest cron | `src/mastra/workflows/weeklyDigestCron.ts` | Sunday 03:00 UTC |
| Coaching Effectiveness Index | `src/utils/coachingEffectivenessIndex.ts` | Solution #5 — surfaces in Phase 5 |
| Topic clustering | `src/utils/...` (via `/api/calls/topic-clusters`) | Already shipped |
| Phone matching | `src/utils/callLeadPhoneMatch.ts` | 216 lines |
| Filename parser | inside `callIntelligenceRoutes.ts` upload handlers | Strict format enforced |

### C. Database tables — concerns

```
call_records           — base table; one row per call
call_transcripts       — Whisper output, speaker segments
call_analysis          — sentiment, topics, action items, key moments
call_qa_scores         — legacy QA scorecard scores (scorecard_type=sdr|sales)
call_compliance        — 4-action Zoho hygiene booleans + evidence
call_governance_results — rule-based governance audit (separate concern)
meeting_mom            — Meeting Minutes from calendar events (Meet)
ai_training_feedback   — RL signal from manager corrections
sdr_call_evaluations   — canonical SDR scorecard result (COPC v2)
sdr_evaluation_reviews — manager Approve/Adjust/Disagree audit log
coaching_plans         — auto-triggered + manually-resolved per-attribute plans
coaching_sessions      — coaching delivery + outcome (separate from plans)
integration_config     — Five9/Zoho credentials + connection state
```

Notable: there are TWO coaching tables: `coaching_plans` (new, lifecycle-aware) and `coaching_sessions` (legacy, delivery + outcome). In Phase 1 we keep both alive; in Phase 4 we consider merging `coaching_sessions` into `coaching_plans` (a `coaching_session_id` FK on the plan record).

### D. Existing DMAIC docs to read before implementing

| Doc | Why |
|---|---|
| `docs/DMAIC_Call_Details_Unification_2026_05_25.md` | Defines the unified Call Details modal — don't undo it |
| `docs/DMAIC_Post_Republish_Audit_2026_05_25.md` | RBAC fix; teach the pattern to all new endpoints |
| `docs/Case_Study_Filename_Parser_2026_05_25.md` | Filename contract + benchmark — informs the Data Sources cleanup |
| `docs/Company_Domain_Strategy_2026_05_25.md` | Optional Phase 6 — account-level rollup |
| `docs/SDR_PDPL_Consent_Script_2026_05_25.md` | Required for PDPL consent compliance metric |
| `docs/SDR_Verification_Step_2026_05_25.md` | 3-point verification, surfaces in scorecard governance |
| `docs/Zoho_OAuth_Setup_2026_05_25.md` | Operations runbook for Zoho disconnection |

### E. ASCII summary — the journey we're trying to design for

```
SUNDAY 18:00 KSA
  └─ Weekly Digest PDF generated + emailed + Slack thread posted
       (auto, no human action)

MONDAY 09:00 KSA
  └─ Daily Pulse Slack message posted: "Yesterday: 12 calls, 8 analyzed,
       2 critical, 1 new coaching plan for Layla."

MONDAY 09:10
  └─ Manager opens /calls
       └─ Lands on Team view
       └─ Scans leaderboard (10 sec)
       └─ Critical-call inbox: 2 calls flagged
       └─ Opens worst-flagged call → Call Details modal
       └─ Listens to 60s clip → reads transcript → confirms it's a real fail
       └─ Closes modal

MONDAY 09:25
  └─ Manager clicks Layla in leaderboard
       └─ Agents view: sees Objection Handling = 3 fails in last 14d
       └─ Coaching plan auto-created last Friday — Pending Delivery
       └─ Clicks [Generate Coaching Brief] → PDF preview
       └─ Emails Layla the brief
       └─ Schedules 1:1 in Outlook

MONDAY 14:00
  └─ 1:1 with Layla
       └─ Opens her Coaching Brief on laptop
       └─ Talks through the 3 failing calls
       └─ Captures SDR commitment: "open every call with 3 discovery questions"
       └─ Clicks [Mark Coaching Plan Delivered]

TUESDAY-THURSDAY
  └─ Layla makes new calls
       └─ Auto-evaluator scores each
       └─ Coaching plan moves to "Awaiting Verification"

FRIDAY
  └─ Layla's first post-coaching call lands a PASS on Objection Handling
       └─ Coaching plan auto-flips to "Verified Passing"
       └─ Toast appears for the manager: "Coaching closed: Layla's Objection Handling now passing (+35pts)"
       └─ Plan logged in coaching_sessions with outcome_delta

NEXT SUNDAY
  └─ Weekly Digest reports the closed coaching plan in the "Coaching this week" section
       └─ Manager replies to Slack thread: 👏
```

Every step is enabled by infrastructure that either exists or is in this plan. None of it exists end-to-end today.

---

## End of plan

This document is ~1,200 lines of pragmatic analysis. The user explicitly asked for a plan-only deliverable; no code is shipped here. Phases are sequenced so the riskiest (Phase 3 — Reports, the user's biggest complaint) ships in the middle, not last, and so each phase delivers user-visible value rather than refactoring-for-refactoring's-sake.

The single highest-leverage decision in front of leadership is **Open Question 1** (Incremental vs SPA reskin). The recommendation is incremental. The single highest-leverage *feature* decision is **Phase 3** (Reports). The recommendation is to ship it within ~4 weeks of project start.

---

### Critical Files for Implementation

The 5 files most critical for implementing this plan:

- D:\2_QMS Platform\qms-dashboard\dashboard\calls.html
- D:\2_QMS Platform\qms-dashboard\src\mastra\routes\callIntelligenceRoutes.ts
- D:\2_QMS Platform\qms-dashboard\src\utils\callIntelligenceDb.ts
- D:\2_QMS Platform\qms-dashboard\src\utils\weeklyDigest.ts
- D:\2_QMS Platform\qms-dashboard\src\utils\coachingPlans.ts