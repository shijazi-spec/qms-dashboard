# SDR Call Evaluation Pipeline — Session Handoff

**Session window:** 2026-05-21 morning → 2026-05-22 ~04:00 Saudi time (single ~16 hour debug-and-build marathon)
**Primary stakeholder:** Sample User (GRQ Quality & Operations)
**Account owner:** Sample User (LLMProvider billing + SourceControlProvider org)
**Deployed at:** `<REDACTED_HOST>`

---

## 1. Executive Summary

**What it became.** A working end-to-end SDR call evaluation pipeline: drop a `.wav` → transcribe (Arabic, Whisper) → analyze (sentiment + QA via gpt-4o-mini) → **auto-score against the 18-attribute ExampleOrg Sales Quality Scorecard v1.0** → display in SDR Evaluation tab → roll up per-agent in Analytics → manager Approves or Disagrees → exportable as multi-sheet Excel.

**What it was at session start.** A pipeline that silently failed at every stage. Every error was generic ("Failed to analyze call"), every diagnostic was wrong (HostingPlatform modelfarm proxy / dummy key), and no scorecard had ever been applied to any call.

---

## 2. PRs Shipped (15 total, all merged to main)

| PR | Branch | Commit | What |
|---|---|---|---|
| #20 | `docs/scope-and-manual-refresh-2026-05` | `072dd79`+ | SoW + Manual v2.2 refresh, GRQ scorecard architecture, Phase 3 docs + notification/event_logs code fix |
| #21 | `docs/sow-rbac-schema-sync` | `8c683d0` | SoW §5.6 RBAC schema sync to match `rbacDatabase.ts` |
| #22 | `fix/dashboard-<REDACTED_TOKEN>` | `6dc97cf` | Hide ghost audits + widen audit history table (v1) |
| #23 | `cleanup/remove-crm-hub-fix-sidebar-and-history` | `c7f314e` | Remove CRM Data Hub + sidebar overflow + tighter history layout |
| #24 | `fix/sdr-pipeline-rate-limit-and-error-visibility` | `5fa4dd8` | Rate-limit bypass on `/api/calls/upload*` + first analysis error surfacing |
| #25 | `fix/sdr-eval-bundle` | `80d5c3c` | Real errors from `/analyze` + `/sdr-evaluate` + Scorecards merged into SDR Eval + CRM link by phone |
| #26 | `feat/phase-b-auto-sdr-evaluation` | `8ba2977` | **Phase B** — auto SDR scorecard evaluation after analysis |
| (Phase C) | `feat/phase-c-analytics-per-agent-scores` | `d6ca04f` | Analytics tab per-agent metrics SQL + HTML rendering |
| (Deps) | `cost/swap-gpt-4o-to-mini-in-analysis-paths` | `adf345f` | gpt-4o → gpt-4o-mini in 3 analysis paths (75% cost reduction) |
| (Deps fix) | direct to main | `187887d` → `a131ee8` | `@ai-sdk/LLMProvider 1.3.24 → 3.0.65` + remove unused `LLMProvider` pkg |
| (Hotfix) | `fix/analytics-500-and-scorecard-loading` | `ebeda52` | `/api/calls/analytics` 500 → graceful fallback + Active Scorecard auto-loads |
| (QW) | `feat/sdr-eval-quick-wins` | `172ccb5` | 5 quick wins — Analyze All button + score in list + retry + audit-trail + hide unwired panel |
| (Med #6) | `feat/medium-6-manager-review-workflow` | `d027ff1` | Manager Review v1 — Approve / Disagree workflow + review history |
| (Med #10) | `feat/medium-10-evaluation-xlsx-export` | `2b1978b` | Multi-sheet Excel export of SDR evaluations |

**Plus:** 1 secret cleanup (deleted `AI_INTEGRATIONS_LLMProvider_*` env vars in HostingPlatform), 1 LLMProvider credit top-up (Sample User $10 prepaid).

---

## 3. The 5 Root-Cause Bugs (Russian Doll — each fix unlocked the next)

1. **Platform rate limit blocked batch uploads** — 17 of 26 .wav uploads returned `Too many requests`. Cause: middleware enforced `WRITE_LIMIT = 10/min` per IP for ALL `/api/*` writes. Fix: bypass on `/api/calls/upload*` paths for authenticated users (PR #24).
2. **Generic "Failed to..." errors hid the real cause** — Phase A error surfacing in `/analyze` + `/sdr-evaluate` endpoints now returns `data.error = "<code>: <message>"` from the underlying exception (PRs #24, #25).
3. **LLMProvider `insufficient_quota`** — pre-paid credit had run out 2026-05-18 (per "Last used" on <REDACTED_HOST>). Sample User $10. Auto-recharge **still off** — recommended to enable.
4. **AI SDK version mismatch** — `<REDACTED_EMAIL>` requires v2 model spec but `@ai-sdk/<REDACTED_EMAIL>` only provided v1. Every `gpt-4o` call died inside the JS layer with `"Unsupported model version v1 for provider LLMProvider.chat"` before ever reaching LLMProvider. Fix: upgrade `@ai-sdk/LLMProvider 1.3.24 → 3.0.65`.
5. **HostingPlatform modelfarm proxy hijacking traffic** — `AI_INTEGRATIONS_LLMProvider_BASE_URL=<REDACTED_URL>` + `AI_INTEGRATIONS_LLMProvider_API_KEY=_DUMMY_API_KEY_` routed every "LLMProvider" call through HostingPlatform's internal proxy with a literal dummy key. The proxy was the actual source of the v1/v2 error. Fix: delete both env vars in HostingPlatform Secrets so code falls back to real `LLMProvider_API_KEY` + `<REDACTED_HOST>/v1`.

---

## 4. Major Files Changed

### Backend
| File | What changed |
|---|---|
| `src/utils/database.ts` | `getLatestAuditResult` + `getAuditHistory` skip ghost audits (`total_records_audited > 0` filter, opt-in `includeEmpty`) |
| `src/utils/callIntelligenceDb.ts` | New `sdr_evaluation_reviews` table + `saveSDREvaluationReview` + `getSDRReviewsForCall`; Phase C SQL with defensive flat JOIN + try/catch fallback |
| `src/utils/sdrAutoEvaluator.ts` | **NEW.** `triggerSDREvaluationForCall()` helper with retry-with-backoff on 429/5xx + audit-trail via `logEvent` |
| `src/mastra/routes/callIntelligenceRoutes.ts` | Auto-eval hook in `/analyze` + `/upload-audio`; error-surfacing on `/analyze` + `/sdr-evaluate`; NEW endpoints: `POST/GET /api/calls/:id/sdr-evaluation/review[s]`, `GET /api/calls/:id/sdr-evaluation/export.xlsx`; model `gpt-4o → gpt-4o-mini` |
| `src/mastra/routes/dashboardApiRoutes.ts` | `issues-category-trend` filters ghost audits |
| `src/mastra/routes/staticPageRoutes.ts` | `/crm` route + role-gate entry removed |
| `src/mastra/middleware/index.ts` | Rate-limit bypass for `/api/calls/upload*` (authenticated) |
| `src/mastra/inngest/index.ts` | CS-overlap + CS-lifecycle scans: correct `createNotification` calls + `logEvent` audit-trail writes |

### Frontend (`dashboard/`)
| File | What changed |
|---|---|
| `dashboard/calls.html` | Scorecards tab removed; "Active Scorecard" collapsible panel inside SDR Evaluation; CRM link → CRMProvider phone search; Analyze All Pending button; score badges in eval list; Manager Review panel (Approve/Disagree + history); Excel export button; loadScorecards on tab open |
| `dashboard/index.html` | Audit History compact dates, table-layout fixed, 8-column responsive; ghost-audit filter |
| `dashboard/crm.html` | **DELETED** |
| `dashboard/js/navigation.js` | "CRM Data" nav entry removed |
| `dashboard/css/navigation.css` | Sidebar overflow-x hardening (no more horizontal scroll) |

### Dependencies (`package.json`)
| Package | Before | After |
|---|---|---|
| `@ai-sdk/LLMProvider` | `^1.3.24` | `^3.0.65` |
| `LLMProvider` | `^6.22.0` | **removed** (unused) |

### HostingPlatform Secrets
| Secret | Action |
|---|---|
| `AI_INTEGRATIONS_LLMProvider_BASE_URL` | **DELETED** (was pointing at modelfarm proxy) |
| `AI_INTEGRATIONS_LLMProvider_API_KEY` | **DELETED** (was a dummy key) |
| `LLMProvider_API_KEY` | Untouched — real `<REDACTED_TOKEN>` key, $10 credit loaded |

---

## 5. Current Implementation Status

### ✅ Live in production
- Quality Dashboard cleanup (no ghost audits, compact history, no sidebar overflow, no CRM link)
- SoW + User Manual v2.2
- Call upload pipeline (rate-limit safe, real errors surfaced)
- Transcription (Whisper via real LLMProvider, gpt-4o-mini-transcribe, Arabic)
- Analysis (gpt-4o-mini, sentiment + summary + insights)
- **Auto SDR scorecard evaluation (Phase B)** — every successful analysis fires it
- Analytics tab per-agent metrics (defensive SQL with graceful fallback)
- CS Pipeline Phases 3+4+5 (auto-refresh + auto-CAPA)
- 5 Quick Wins (Analyze All, score badges, retry, audit-trail, hidden unwired panel)
- Manager Review workflow v1 (Approve/Disagree + history)
- Excel export of evaluations (multi-sheet)

### ⏳ Roadmap queued
- **Medium #8** — Bulk operations (checkbox selection + bulk delete/re-analyze/re-score) — **in progress this session**
- **Medium #7** — Coaching loop integration (low-scoring attributes → suggest training courses from Team Tracker catalog)
- **Medium #9** — Switch nightly cron-fired analysis to LLMProvider Batch API (50% cost discount, 24h SLA)
- **Medium #6 v1.1** — Full "Adjust" mode in Manager Review (editable per-attribute scores) + canonical-score COALESCE in Analytics queries
- **#3 follow-on** — Wire the hidden AI Training Feedback panel after #6 v1.1 ships
- **Long-term** — Multi-scorecard rollout to Quality Manager / GRC Manager / GRQ Specialists
- **Long-term** — PDPL data retention policy for call transcripts
- **Deferred** — Phase 6 CS Lifecycle stage-history audit (needs CRMProvider Stage History API access)

---

## 6. Verification Recipes

```bash
# Pipeline health (in HostingPlatform shell)
psql "$DATABASE_URL" -c "SELECT id, scorecard_id, overall_score, evaluated_at FROM sdr_call_evaluations ORDER BY evaluated_at DESC LIMIT 5;"

# Manager Review history
psql "$DATABASE_URL" -c "SELECT review_status, reviewer_email, review_notes, reviewed_at FROM sdr_evaluation_reviews ORDER BY reviewed_at DESC LIMIT 10;"

# Audit-trail (Phase 3 + Quick Win #4)
psql "$DATABASE_URL" -c "SELECT timestamp, severity, action_type, description FROM event_logs WHERE action_type IN ('sdr_auto_evaluation','scan') AND module IN ('calls','duplicates') ORDER BY timestamp DESC LIMIT 10;"

# LLMProvider key reachability
curl -s <REDACTED_URL> \
  -H "Authorization: Bearer $LLMProvider_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"ping"}],"max_tokens":5}'

# AI SDK package versions
cd ~/workspace && npm ls @ai-sdk/LLMProvider && npm ls LLMProvider
```

---

## 7. Operational Action Items

- [ ] **Enable LLMProvider auto-recharge** at <REDACTED_URL> — prevents silent quota outages (single biggest risk)
- [ ] **Run "Analyze All Pending"** on the 26 uploaded calls to seed real data
- [ ] **Click "Export Excel"** on any evaluated call — verify the 4-sheet workbook format
- [ ] **Test Manager Review** — Approve one, Disagree another, verify both appear in history
- [ ] **`git push origin main`** from HostingPlatform shell if HostingPlatform Agent has unpushed local commits

### Cost profile
- Per call (transcribe + analyze + scorecard): ~$0.0025 with gpt-4o-mini
- $10 credit covers ~4,000 calls
- For nightly batch when #9 ships: drops to ~$0.00125/call via LLMProvider Batch API

---

## 8. Next Session Starting Point

1. Read this handoff doc first
2. Check memory under `.claude/projects/d--GRQ-vs--Cursor/memory/` for architectural decisions
3. Verify deployed state via §6 recipes
4. Pick next item: **Medium #7 (Coaching loop integration)** is next in the roadmap after #8 ships
