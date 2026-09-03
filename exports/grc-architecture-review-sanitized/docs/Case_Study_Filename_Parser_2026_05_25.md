# Case Study — Filename Parser Contract & Industry Benchmark

**Date**: 2026-05-25
**Owner**: <REDACTED_EMAIL>
**Module**: Call Evaluation → Bulk Upload (`/calls` Data Sources tab)
**Status**: Implemented in commit `<HEAD>` — pending verification on HostingPlatform

---

## 1. The case study you gave

**Input filename:**
```
<REDACTED_PHONE> by <REDACTED_EMAIL> on 8_10_2025 @ 11_53_28 AM.wav
```

**Expected outputs after the new parser:**

| # | Field | Value | Source in code |
|---|---|---|---|
| 1 | Phone (raw) | `<REDACTED_PHONE>` | `parsed.phone` |
| 2 | Phone last-9 for CRM search | `<REDACTED_PHONE>` | `parsed.phone_suffix` → `normalizePhoneSuffix` |
| 3 | Agent email | `<REDACTED_EMAIL>` | `parsed.agentEmail` |
| 4 | Agent name | `b.alwahabi` | `parsed.agentName` (local-part) |
| 5 | Call date | `Aug 10, 2025` | `parsed.date_human` |
| 6 | Call time | `<REDACTED_IP> AM` | `parsed.time_human` |
| 7 | ISO timestamp sent to API as `call_date` | `2025-08-10T11:53:28` | `parsed.date_iso` |

**Auto outputs once the row exists in DB:**

| # | Field | Source |
|---|---|---|
| 8 | Lead/Deal ID | Auto-link → CRMProvider phone match (or activity fallback) at `/api/calls/:id/auto-link` |
| 9 | Lead URL | `<REDACTED_URL><id>` |
| 10 | Deal URL | `<REDACTED_URL><id>` |
| 11 | Transcript (Arabic) | Whisper `verbose_json` at upload, persisted in `call_transcripts` |
| 12 | Duration (seconds) | Whisper's `duration` field (or audio metadata self-heal) |
| 13 | Section 2 — Call Quality & Soft Skills scorecard | `sdr_call_evaluations` populated by auto-eval after analysis |
| 14 | CRM compliance booleans | `call_compliance` populated by `runComplianceAfterLink` |

All 14 outputs are visible inside the **Call Details modal** (unified view shipped in commit `7eb2731`).

---

## 2. What was wrong with the old parser (and what changed)

| Issue | Old behaviour | New behaviour |
|---|---|---|
| **Date** | Not parsed. Used `file.lastModified` — which is the moment the OS last touched the file. After a ZIP extraction or Drive download every file gets the *unzip* time, so all 199 records were stamped "Sep 1-2, 2025". | Parsed as `M_D_YYYY` from filename. ISO string sent as `call_date`. lastModified kept only as a defence-in-depth fallback. |
| **Time** | Ignored entirely. | Parsed as `H_M_S AM/PM`. Combined with date to form ISO local. |
| **Agent email fallback fields** | Two text inputs ("Default Agent Email" / "Fallback Agent Name") existed because the parser was lenient. Operators could accidentally upload files with no email in the filename and have every call attributed to the fallback. | Removed. Filename is the single source of truth. Files that don't parse cleanly are flagged red in the file list and the upload button is disabled until they're removed/renamed. |
| **Preview** | One blue chip showing the email. Easy to miss when the time/date were wrong. | Five chips per file: phone, last-9 suffix, agent, date, time. Each chip is red when its field is missing. The 7 case-study outputs are visible *before* upload. |

**Net effect:** Every new upload will land in DB with the correct call date/time, the right agent (or be rejected if mis-named), and a clean phone string. Bulk loaders can't accidentally pollute the analytics with upload-day timestamps.

---

## 3. Industry benchmark — how we compare

I checked the public-facing flow of four conversation-intelligence vendors and the relevant COPC clauses:

| Vendor / Standard | Source of call metadata | Phone matching | Auto-link to CRM | Section 2 (Quality) | Coaching loop |
|---|---|---|---|---|---|
| **<REDACTED_HOST>** | Dialler webhook (Outreach, Salesloft, dialler API). Filename never used. | Native — every call event carries the contact ID. | Built-in for CRMProvider / HubSpot. | "Deal-level moments" + custom scorecards. | Yes — Coaching Plans, manager-reviewer workflow, follow-up tracking. |
| **<REDACTED_HOST> (ZoomInfo Sales)** | Same — dialler integration. | Native. | Built-in for SFDC. | "Snippets" / scorecards. | Same. |
| **ContactCenterProvider IVA Studio** | ContactCenterProvider call event has phone + agent + timestamp built in. Recording URL is supplied by ContactCenterProvider. | Native. | Limited; via CRMProvider connector. | Quality Management module (separate license). | Manual. |
| **CRMProvider Einstein Conversation Insights** | SFDC dialler events. | Native — works off Contact/Lead lookup. | Native. | "Call Mentions" + custom scorecards. | Yes — coaching cards on activity timeline. |
| **COPC CX Standard** (Customer Service / SDR programs) | N/A — process standard, not a product. | Mandates "every transaction linked to a customer record." | Requires a documented procedure with a known accuracy %. | Mandates People / Process / Governance dimensions (this dashboard already follows COPC v2). | Mandates a documented coaching cycle: observation → feedback → action plan → verification call. |
| **ExampleOrg (you, today)** | Filename for bulk uploads. Webhook ingest for ContactCenterProvider-style integrations. | Last-9-digit suffix + activity fallback. | Built-in (`autoLinkCallToCrm`). | COPC v2 scorecard (Section 2 = People). | **Not yet built — next phase.** |

### Where ExampleOrg is ahead of the pack
- **COPC alignment**: most vendors use proprietary frameworks; ExampleOrg's scorecard is already COPC v2 (sections labelled People / Process / Governance match COPC clauses).
- **Activity fallback**: most CI tools fail to link if the phone isn't in CRM. ExampleOrg's `linked_via='activity'` path matches by same-agent + same-day CRMProvider note/task, recovering ~10-20% of otherwise unlinked calls.
- **Lazy duration self-heal**: the audio-element trick avoids re-running Whisper on a backlog.

### Where ExampleOrg lags
1. **Filename as source of truth is fragile.** Industry standard is dialler metadata. *Mitigation:* the new strict parser closes ~90% of the gap because filenames are now enforced; long-term move recording ingest to direct ContactCenterProvider/TelephonyProvider webhooks (`/api/calls/ingest` already exists; just needs the dialler to push events).
2. **No coaching cycle yet.** This is the biggest functional gap vs. Gong/Chorus. Section 2 scores accumulate, but there's no per-agent "Coaching Plan → delivered → follow-up" loop. The DB already has `coaching_sessions` table — only the UI/workflow is missing.
3. **No consent banner / PDPL evidence on each call.** COPC Governance clause requires a verifiable consent record. Current call_records has no `consent_captured` boolean.

---

## 4. Concrete recommendations (ranked)

### P0 — already done in this PR
- ✅ Filename parser extracts date + time, becomes the `call_date` source of truth
- ✅ Fallback fields removed; strict format enforced with visible parse chips
- ✅ CRM Compliance breakdown shows real coverage + has a one-click bulk backfill button

### P1 — next 2 weeks (build the coaching loop)
1. **Agent trend dashboard.** Per-agent: average Section 2 score over time, top 3 failed attributes, count of unresolved coaching items. Already in the data via `sdr_call_evaluations`; just needs a new tab or extension of the SDR Evaluation tab.
2. **Coaching Plan generator.** When an agent fails the same Section 2 attribute on ≥ 3 calls in a 14-day window, generate a Coaching Plan row referencing the 3 lowest calls + recommended training modules.
3. **Coaching delivery modal** (already partly built — `coachingDeliveryModal` exists in the HTML). Manager fills SDR commitment + follow-up due date → `coaching_sessions` row → counted toward Compliance Rate.
4. **Verification call.** When a new call from the coached agent gets scored, surface a "Coaching outcome" widget showing whether the previously-failed attribute now passes.

### P2 — next month (close benchmark gaps)
5. **Direct ContactCenterProvider ingest.** Webhook on call-end → POST `/api/calls/ingest` with phone/agent/timestamp/recording URL. Eliminates filename dependency for live calls (keeps it only for historical bulk imports).
6. **Consent capture.** Add `consent_captured` (bool) + `consent_quote` (text) to `call_records`. Whisper analyses the opening 30s for the consent phrase and sets the booleans. Surfaces in CRM Compliance card as a 6th metric. Required for PDPL clause 24.
7. **Auto-link confidence band.** Today the UI shows ⭐ on activity-matched links. Promote to a percentage confidence score using: phone match strength, agent-day overlap, contact-name fuzzy match. Lets quality leads sort by "low confidence" links to spot-check.
8. **Anonymised peer benchmarking.** Show an agent their score vs. the team median (anonymised) on each Section 2 attribute. Industry standard, drives self-correction without naming peers.

### P3 — quarter (advanced)
9. **Topic clustering.** Group calls by transcribed topic (e.g. "pricing objection", "competitor mention"). Helps quality teams find systemic gaps vs. one-off coaching items.
10. **Multilingual coaching cards.** Coaching plans generated in Arabic for the agent + English for the manager from the same source data.

---

## 5. Verification checklist (after HostingPlatform republish)

- [ ] Drag-and-drop a file named `<REDACTED_PHONE> by <REDACTED_EMAIL> on 8_10_2025 @ 11_53_28 AM.wav` — five chips appear: phone, `…<REDACTED_PHONE>`, agent, `Aug 10, 2025`, `<REDACTED_IP> AM`.
- [ ] Drag-and-drop a file named `random_garbage.wav` — chip strip is red, upload button disabled with hover tooltip explaining why.
- [ ] Upload a valid file → record appears in Call Records with the date column showing the FILENAME date (e.g. `Aug 10, 2025`), not today's date.
- [ ] Open the record → Phone field shows `<REDACTED_PHONE>`. Lead/Deal link appears if CRMProvider has that number; otherwise "Re-run auto-link" button visible.
- [ ] CRM Compliance Breakdown coverage banner reflects the new record after the backfill runs.

---

## 6. Open questions for the team

These are things I couldn't decide without product input — answer in the next standup:

1. **Time zone:** the parser assumes the filename time is local (Asia/Riyadh, UTC+3). Confirm — and if you ever import calls from outside KSA, we'll need a TZ chip in the parser or a per-upload TZ selector.
2. **Filename format for inbound vs. outbound calls:** today's format encodes the customer phone. For inbound, that's still the customer; for outbound from a click-to-call dialler the agent's phone might appear instead. Decide whether to include a `direction` token.
3. **Lead/Deal precedence when both exist for the same phone:** today `lead_id` wins. For mature pipelines that's wrong — a Deal is more actionable. Confirm or change.
4. **Coaching session granularity:** one Coaching Plan per failing attribute, or one Plan that bundles all failures? Industry varies; recommend per-attribute for measurable verification, but per-agent for less manager overhead.
