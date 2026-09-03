# Deploy Note — Risk Register fixes + Adam UI consistency

**Date:** 2026-07-08 · **Scope:** Adam's risk tools were querying a non-existent table; plus risk-appetite feature and an icon consistency fix. **Backend + frontend, no data migration required** (schema auto-migrates on boot).

## Why this deploy matters
Adam's **"Review Risk Register"** (and Check Compliance / Suggest Improvements / background risk alerts) were completely broken — every risk query hit a phantom `risks` table that doesn't exist, so Adam got nothing and the chat spun until timeout. The real register is `enterprise_risks`. This deploy repoints all of it, adds risk-appetite/tolerance support end-to-end, and aligns the Quick Actions icon with Adam's branding.

## Files changed (9)

**Backend — risk data access**

| File | Change |
|------|--------|
| `src/utils/riskDatabase.ts` | Added `risk_appetite`, `risk_tolerance` (enterprise_risks) + `percent_complete` (risk_treatment_actions): CREATE + `ALTER…IF NOT EXISTS` + createRisk INSERT + updateRisk allowlist + interface |
| `src/mastra/tools/monitorRisksTool.ts` | All 4 checks → `enterprise_risks` w/ real columns; self-runs `initRiskTables()` |
| `src/mastra/tools/checkRegulationComplianceTool.ts` | ISO 27001 + NCA risk queries → `enterprise_risks` (`risk_level`, security category) |
| `src/mastra/tools/suggestImprovementsTool.ts` | Open-risk count → `enterprise_risks` |
| `src/utils/aiBackgroundScanner.ts` | 3 risk checks re-pointed + un-gated (risk alerts now actually run) |

**Frontend — appetite/tolerance UI + icon**

| File | Change |
|------|--------|
| `dashboard/risks.html` | Add-form appetite/tolerance inputs + submit wiring (blank→null); detail-modal "Appetite Alignment" panel w/ breach badge |
| `dashboard/consultant.html` | Quick Actions logo: flask SVG → 🤖 in indigo→purple gradient (matches Adam) |
| `dashboard/i18n/en.json` | `risks.f_risk_appetite/tolerance` + 7 `dyn.risks.appetite_*` keys |
| `dashboard/i18n/ar.json` | Same keys, Arabic |

## Root cause (reference)
The real risk register lives in `enterprise_risks` (owned by `src/utils/riskDatabase.ts`, read by `riskRoutes.ts`). Adam's tools queried a bare `risks` table that does not exist, with wrong column names too:

- `title` → `risk_title`
- `likelihood` / `impact` → `likelihood_score` / `impact_score` (score via generated `risk_score`)
- `severity` → `risk_level`; category value `'cybersecurity'` → `information_security`
- status vocab is `{open, in_treatment, monitoring, closed, escalated}` — there is **no `mitigated`** status
- `risk_appetite` / `risk_tolerance` did not exist in the schema at all (added here)

The AI background scanner was additionally gated on `schemaSupports("risks")` (always false), so it had been silently skipping every risk check since launch.

## Behavior changes to expect
- ✅ **"Review Risk Register" now works** — reads the real `enterprise_risks` register.
- ⚠️ **Background risk alerts turn ON** — the AI scanner was silently skipping all risk checks; after deploy it will start generating high-risk / overdue-treatment / low-progress alerts (deduped, so no flood).
- ✅ **Risk appetite/tolerance** settable in the add form and shown in the detail popup; until a value is set, Adam reports appetite as "not configured."

## Deploy steps
1. Sync all 9 files to Replit (standing rule: **commit + push to `origin/QMS` first**, then Republish — local-only edits rebuild stale code).
2. Republish.
3. **Schema auto-migrates** — `initRiskTables()` runs the `ALTER…IF NOT EXISTS` on the first risk-API hit (or first "Review Risk Register"). No manual SQL.
4. ⛔ **In the publish schema diff, do NOT approve any `DROP TABLE`** — approve code-only, as always.

## Post-deploy smoke test
1. Open Adam → **Review Risk Register** → confirm it returns real risks (not a spinner/error).
2. Risks screen → **Add Risk** with an Appetite value (e.g. 8) on a high-score risk → open its detail → confirm the **Appetite Alignment** badge shows (🔴/🟠/🟢).
3. Adam header → confirm **Quick Actions** logo is 🤖, matching the avatar.

## Pre-verified before handoff
- ✅ TypeScript: 0 errors
- ✅ schema-parity: pass (no drift)
- ✅ dashboard HTML/JS lint: pass (213 script blocks)
- ✅ i18n JSON valid, keys present EN + AR
- ✅ no phantom `risks` references remain

**Rollback:** revert the 9 files and republish; the added columns are nullable and harmless if left in place.
