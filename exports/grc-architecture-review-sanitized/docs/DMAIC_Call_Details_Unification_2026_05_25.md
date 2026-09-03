# DMAIC — Call Details Unification (Call Evaluation Tab)

**Date**: 2026-05-25
**Owner**: <REDACTED_EMAIL>
**Module touched**: `dashboard/calls.html`, `src/mastra/routes/callIntelligenceRoutes.ts`, `dashboard/i18n/{en,ar}.json`

---

## Define — what was the problem?

Managers reviewing SDR calls had to bounce between three places to evaluate a single record:

1. **Row "View"** → Call Details modal (scorecard + analysis, no transcript, no recording, no CRM link inside).
2. **Row "Activity"** → a *separate* SDR Activity Timeline modal.
3. **Row "CRM"** → out to CRMProvider in a new tab.

Two more friction points compounded the cost:

- **Duration column showed `--` for every one of the 199 analysed records.** Whisper-derived duration was only persisted when `/api/calls/upload-audio` was used with `autoAnalyze=true`; the older bulk_upload path and earlier analyse runs never captured it.
- **No way to find every call tied to a phone number.** Saudi numbers arrive as `+966XXXXXXXXX`, `0XXXXXXXXX`, or bare `XXXXXXXXX` across upload sources; only `source` and `status` dropdowns existed for filtering.

## Measure — baseline before the change

| Metric | Baseline |
|---|---|
| Records with `duration_seconds IS NULL` | **199 of 199** (100%) — Duration column entirely `--` |
| Modals to evaluate one call | **3** (Details + Activity + CRMProvider tab) |
| Phone-search support | **None** (only Source/Status dropdowns) |
| Transcript visibility inside Details | **None** — endpoint returned it but UI never rendered it |
| CRM link inside Details | **None** — only a small "CRM" pill on the row |

## Analyze — root causes

1. **Duration**: `/api/calls/bulk-upload` writes `duration_seconds: null` unconditionally ([routes:2625](../src/mastra/routes/callIntelligenceRoutes.ts:2625)). The `/api/calls/upload-audio` autoAnalyse path *does* extract it via `whisper-1` verbose_json, but legacy uploads pre-dated that code or used the cheaper `gpt-4o-mini-transcribe` model which returns no duration.
2. **Activity is buried**: `#activityTimelineModal` was a sibling modal opened by a 10-px row link ([calls.html:1085](../dashboard/calls.html:1085)). Managers did not associate it with the call they were reviewing.
3. **Transcript orphan**: `/api/calls/:id` already returned `transcript` in its payload ([routes:664](../src/mastra/routes/callIntelligenceRoutes.ts:664)) but `viewCall()` ignored it.
4. **No phone normalisation**: filter logic at [calls.html:1554](../dashboard/calls.html:1554) only matched exact `source`/`status`.

## Improve — what shipped

### Frontend ([dashboard/calls.html](../dashboard/calls.html))

- **Phone search box** in the filter bar — `normalizePhoneSuffix()` strips non-digits and matches on the rightmost 9 digits across `contact_phone`, `phone`, `contact_number`, `metadata.contact_phone`, `metadata.phone`, and `lead_id`.
- **Records cache bumped** from `limit=100` → `limit=500` so search and Related Calls see every record.
- **Call Details modal redesigned** as a 2/3 + 1/3 grid:
  - Left (2/3, scrollable): Stored SDR scorecard summary, Call Info (now includes Phone), Analysis, CRM Compliance, **inlined Activity Timeline**, legacy SDR-eval panel.
  - Right (1/3, sticky): `<audio>` recording player, RTL Transcript pane (speaker segments when available, Copy button), CRM quick-action buttons (Open Lead / Open Deal / Search by phone / Re-link), **Related Calls** (other records sharing the same 9-digit phone suffix; click to jump).
- **Self-healing duration**: the `<audio>` element's `loadedmetadata` event extracts duration, patches the modal's Duration cell and the in-memory cache, then POSTs to `/api/calls/:id/duration` so the value persists.
- **Standalone Activity Timeline modal removed** along with its row button and three orphan functions (~80 LOC of dead code).

### Backend ([src/mastra/routes/callIntelligenceRoutes.ts](../src/mastra/routes/callIntelligenceRoutes.ts))

- **New endpoint** `POST /api/calls/:callId/duration` ([routes:1103](../src/mastra/routes/callIntelligenceRoutes.ts:1103)): admin-gated, idempotent (only writes when `duration_seconds IS NULL` — preserves Whisper-derived values), validates `0 < seconds < 86400`.

### i18n ([dashboard/i18n/{en,ar}.json](../dashboard/i18n/))

- Added 17 keys under `calls.*` for the new UI strings (search placeholder, Recording, Transcript, CRM, Related Calls, etc.) with full English + Arabic translations.

## Control — how we keep it healthy

### Success metrics to watch

| Metric | Target (4 weeks post-deploy) | How to read it |
|---|---|---|
| `duration_seconds` coverage on analysed calls | **≥ 90%** of all `status='analyzed'` rows | SQL: `SELECT count(*) FILTER (WHERE duration_seconds IS NOT NULL)::float / count(*) FROM call_records WHERE status='analyzed';` — climbs organically as managers open records (lazy backfill via `POST /api/calls/:id/duration`). |
| Phone-search usage | Logged page-views to `/calls` with `?phone=` query param (≥ 1 per active manager / week) | Page-view telemetry. |
| Activity-timeline render rate | **100%** of Call Details opens trigger `GET /api/calls/:id/activity-timeline` | Confirms the inlined section actually loads. |
| Modal hops per evaluation | Drops from **3 → 1** | Qualitative: ask quality team in first standup after rollout. |

### Rollback

The change is additive (new endpoint, new i18n keys, restructured `viewCall()`) plus one deletion (standalone activity modal). To roll back:

1. `git revert <commit-sha>` — single commit reverts both files.
2. The `POST /api/calls/:id/duration` endpoint is safe to leave behind; nothing else calls it.

### Verification checklist (deploy day)

- [ ] `/calls` loads without console errors.
- [ ] Phone search: paste `<REDACTED_PHONE>` → only matching rows visible.
- [ ] Phone search: paste `<REDACTED_PHONE>` → same rows match (country-code agnostic).
- [ ] Click **View** on a record → modal opens with two columns; right column shows audio player, transcript, CRM buttons, related calls.
- [ ] Audio loads → Duration cell flips from `--` to `M:SS`; reload page → row Duration column also shows it.
- [ ] Activity Timeline section renders inside the modal (no separate popup).
- [ ] Switch language to Arabic → all new labels translate (search placeholder, Recording, Transcript, CRM, Related Calls).
- [ ] No reference to `showActivityTimeline` remains (grep clean).
- [ ] `POST /api/calls/:id/duration` returns `{success: true, updated: true}` once, then `{success: true, updated: false, reason: "already_set"}` on subsequent calls.

### Known limitations

- Calls with no `audio_blob` in DB (legacy uploads where bytes were never persisted) cannot self-heal their duration. The right-column note "If the recording is missing it was never persisted to DB" makes this visible.
- Two strings inside `loadInlineActivityTimeline` ("Activity on", "Failed to load activity") are carried over from the original helper untranslated — same as before this change.
- Backend `/api/calls` endpoint phone filter was *not* added — search is purely client-side against the cached 500-row list. If the dataset exceeds 500 records, the table will need server-side filtering.

---

## File map

| Concern | File | Line |
|---|---|---|
| Phone search input | `dashboard/calls.html` | ~250 |
| `normalizePhoneSuffix`, `collectCallPhoneSuffixes` | `dashboard/calls.html` | ~1551 |
| Cache fetch bumped to 500 | `dashboard/calls.html` | ~1436 |
| `renderCrmLinkCell` (Activity button removed) | `dashboard/calls.html` | ~1722 |
| `viewCall()` modal rewrite | `dashboard/calls.html` | ~2254 |
| `renderRelatedCallsList`, `loadInlineActivityTimeline`, `copyTranscript` | `dashboard/calls.html` | ~2620 |
| `POST /api/calls/:id/duration` | `src/mastra/routes/callIntelligenceRoutes.ts` | 1103 |
| i18n keys | `dashboard/i18n/en.json`, `dashboard/i18n/ar.json` | 2551 / 2551 |
