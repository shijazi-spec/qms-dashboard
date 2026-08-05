# Quality Reports — Department Hub (Phase 1) — Design Spec

**Date:** 2026-08-05
**Author:** Sarah Hijazi (GRQ) + Claude
**Status:** Approved shape — pending spec review
**Phase:** 1 of 3 (this spec = the self-serve hub + BU pages; Phase 2 = deeper SOP/KPI mapping & more report lenses; Phase 3 = emailed reports to heads — both OUT OF SCOPE here)

## 1. Goal

A new **"Quality Reports"** area under **Quality**: a grid of **9 business-unit (BU) boxes**; opening a box shows a per-BU page that assembles, in one place, everything Quality reports on for that BU — **SOPs, KPIs, data-cleanup + compliance, and open actions/CAPAs** — each pulled live from the systems that already own that data, scoped to the BU.

Self-serve **view first** (each BU head can open their page). Emailing reports to heads is explicitly deferred to Phase 3.

### Success criteria
- One page per BU, four sections, each scoped correctly to that BU.
- Reuse existing report engines — do NOT duplicate report logic.
- Registry (BUs, heads, mappings) is **admin-editable in-app**, no redeploy to change.
- Sections with no mapping yet render a clean "not configured" state, not an error.

## 2. The 9 Business Units (canonical list)

Channel determines the CRM segment automatically (no manual segment mapping). Function determines which report(s) the cleanup/compliance section shows (this is how we distinguish the 3 BUs that share a segment).

| # | BU name | Channel | → Segment | Function | Cleanup/compliance reports on its page |
|---|---|---|---|---|---|
| 1 | SDR (B2B) | B2B | walaplus | sdr | Lead duplicates (segment) |
| 2 | Sales (B2B) | B2B | walaplus | sales | Deal cleanup + Deal compliance + Stage aging (segment) |
| 3 | Customer Success (B2B) | B2B | walaplus | cs | CS Lifecycle (segment) |
| 4 | SDR (B2C) | B2C | walaone | sdr | Lead duplicates (segment) |
| 5 | Sales (B2C) | B2C | walaone | sales | Deal cleanup + Deal compliance (segment) |
| 6 | Customer Success (B2C) | B2C | walaone | cs | CS Lifecycle (segment) |
| 7 | Partnership (MP) | MP | marketplace | partnership | Lead + Deal cleanup (segment) |
| 8 | Onboarding (MP) | MP | marketplace | onboarding | CS Lifecycle — Onboarding phase + Deals (segment) |
| 9 | PartnerSuccess (MP) | MP | marketplace | partnersuccess | CS Lifecycle — Adoption/Renewal (segment) |

Channel→segment rule (fixed): **B2B → walaplus · B2C → walaone · MP → marketplace** (the same `buildSegmentPredicate` values the radar uses, `duplicateRadarDatabase.ts:165`).

## 3. Registry data model (new, isolated)

A **dedicated** registry — NOT the leadership `business_units` table (`leadershipKpiFeed.ts:385`, 13 canonical names tied to the KPI feed) and NOT the checklist's commercial-8. Those stay untouched; this is a Quality-Reports-specific taxonomy. New tables:

```sql
CREATE TABLE IF NOT EXISTS quality_report_bus (
  id            SERIAL PRIMARY KEY,
  bu_key        VARCHAR(40) NOT NULL UNIQUE,     -- 'sales_b2b', 'partnership_mp', …
  bu_name       VARCHAR(80) NOT NULL,            -- 'Sales (B2B)'
  channel       VARCHAR(8)  NOT NULL,            -- 'B2B' | 'B2C' | 'MP'
  segment       VARCHAR(16) NOT NULL,            -- derived: 'walaplus'|'walaone'|'marketplace'
  fn            VARCHAR(24) NOT NULL,            -- 'sdr'|'sales'|'cs'|'partnership'|'onboarding'|'partnersuccess'
  head_email    VARCHAR(200),                    -- BU head / recipient (Phase 3 uses it)
  policy_department VARCHAR(100),                -- maps to policies.owner_department (SOPs); NULL = not configured
  kpi_bu_name   VARCHAR(80),                     -- maps to kpi_bu_schedule.bu_name (KPIs); NULL = not configured
  sort_order    INTEGER NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS quality_report_bu_owners (
  id         SERIAL PRIMARY KEY,
  bu_id      INTEGER NOT NULL REFERENCES quality_report_bus(id) ON DELETE CASCADE,
  owner_email VARCHAR(200) NOT NULL,             -- canonicalised via OWNER_EMAIL_ALIASES
  UNIQUE (bu_id, owner_email)
);
```

- Seeded idempotently with the 9 BUs from §2 (channel, segment, fn set; `policy_department`/`kpi_bu_name`/`head_email`/owners left NULL/empty for the admin to fill).
- Schema-parity: both CREATE TABLEs are canonical; any later column is added via ALTER too. No DROP.
- `segment` is stored (not computed) but MUST stay consistent with `channel` — the admin screen sets it from channel, never freely.

## 4. Section data sources (grounded — reuse, don't rebuild)

| Section | Existing source to call | Scope key | Status |
|---|---|---|---|
| **SOPs** | `getAllPolicies({ owner_department })` (`policyDatabase.ts:413`, already filters owner_department at `:454`) | `bu.policy_department` | wire now; "not configured" if NULL |
| **KPIs** | checklist per BU — `getFrameworkProgressByBU()` (`kpiChecklistDatabase.ts:704`) / `getChecklistItems` (`:464`) | `bu.kpi_bu_name` | wire now; "not configured" if NULL |
| **Cleanup — Deals/Accounts** | `getDataCleaningProgress(segment)` (`duplicateRadarDatabase.ts:2488`) | `bu.segment` | wire now (Sales/Partnership/Onboarding) |
| **Cleanup — Leads** | Lead-duplicate count from the radar Leads data (existing Lead Duplicates tab source) | `bu.segment` | wire now (SDR/Partnership) |
| **Compliance — CS** | `scanCsLifecycleViolations({ segment })` (`duplicateRadarDatabase.ts:11555`) | `bu.segment` | wire now (CS/Onboarding/PartnerSuccess) |
| **Compliance — Deals** | `scanDealStageAgingViolations({ segment })` (`duplicateRadarDatabase.ts:11745`) + deal compliance | `bu.segment` | wire now (Sales) |
| **Open actions / CAPAs** | `getCapaRecords({ assignedTo })` (`qmsDatabase.ts:577`) + `getOwnerAccountability()` (`duplicateRadarDatabase.ts:7448`) | `bu` owner list (`quality_report_bu_owners`), canonicalised via `OWNER_EMAIL_ALIASES` (`ownerEmailAliases.ts`) | wire when owners are mapped; else "not configured" |

**Function → which reports appear** (resolves the "3 BUs share one segment" problem — §2 last column):
- `sdr` → Leads cleanup
- `sales` → Deals cleanup + Deal compliance + Stage aging
- `cs` / `partnersuccess` → CS Lifecycle
- `partnership` → Leads + Deals cleanup
- `onboarding` → CS Lifecycle (Onboarding phase emphasis) + Deals cleanup

**No new report engines.** Every number is an existing function called with the BU's `segment` (and, for actions, the BU's owner set). The only new server code is (a) the registry + admin CRUD, (b) a per-BU aggregator that calls the above and stitches results, (c) the hub/BU pages.

## 5. Backend

New module `src/utils/qualityReportsDepartments.ts`:
- `listBUs()` / `getBU(buKey)` / `upsertBU(...)` / `deleteBU(id)` / `setBUOwners(buId, emails[])` — registry CRUD (+ seed).
- `getBUReport(buKey)` → `{ bu, sops, kpis, cleanup, compliance, actions, notConfigured: string[] }` — the aggregator. Each sub-section is best-effort: a failure or missing mapping yields that section's "not configured"/empty payload with a reason, never a 500 for the whole page.

Routes (new `src/mastra/routes/qualityReportsRoutes.ts`, registered like other route arrays; RBAC allowlist entries added):
- `GET  /api/quality-reports/bus` — grid data (list + high-level status per BU).
- `GET  /api/quality-reports/bus/:buKey` — one BU's full report (calls `getBUReport`).
- `POST /api/quality-reports/bus` · `PUT /api/quality-reports/bus/:id` · `DELETE …/:id` — admin CRUD (admin-gated).
- `PUT  /api/quality-reports/bus/:id/owners` — set owner list (admin-gated).
- **RBAC:** reads = the governance read roles (mirror the KPI read rule `rbacMiddleware.ts:1115`); writes = admin/quality-manager/grc_manager/head_of_operations_quality.

## 6. UI

- **Nav:** a "Quality Reports" item under the **Quality** section of the sidebar (alongside Dashboard / Internal Audits / Duplicates Radar / Audit Reports).
- **Hub page** `dashboard/quality-reports.html`: a responsive grid of 9 BU cards (name, channel badge, a one-line status e.g. "3 SOPs · KPIs 60% · 12 open dup deals · 2 CAPAs"), each linking to the BU page. Uses the shared `rr-kpi`/design tokens; theme-aware; CSP-safe (no inline styles).
- **BU page** (same file, `?bu=<key>`, or `quality-reports.html` rendering a selected BU): four labelled sections (SOPs / KPIs / Cleanup & Compliance / Open Actions), each rendering its payload or a "not configured yet — map this in settings" placeholder with a link to the admin screen. Reuse existing render patterns where possible (e.g. the cleanup cards from the Cleaning Progress tab).
- **Admin screen** (under Admin Settings or a gear on the hub): CRUD the 9 BUs, set `head_email`, `policy_department`, `kpi_bu_name`, and the owner list. Admin-gated.

## 7. Non-goals (this phase)
- **No emailing** reports to heads (Phase 3 — will reuse the digest/leadership-feed plumbing, with preview-before-send).
- **No new report engines** — only aggregation of existing ones.
- **Doc Tracker / GRC-upload docs** are not wired for SOPs (only Integrated QMS `policies`, which has `owner_department`); folder/category mapping is a later enhancement.
- **Non-CRM concerns** — every BU here is CRM-backed, so all have a segment.

## 8. Open items the admin fills post-ship (not blockers)
- `policy_department` per BU (which `policies.owner_department` value(s) belong to each) — SOPs show once set.
- `kpi_bu_name` per BU (which checklist BU maps) — KPIs show once set.
- Owner list per BU — Open actions show once populated.
- `head_email` per BU — unused until Phase 3.

## 9. Testing
- Unit: registry CRUD (seed idempotency; segment stays consistent with channel; owner canonicalisation), and `getBUReport`'s per-section best-effort fallback (a thrown sub-section → "not configured", never a whole-page failure). Pure aggregation/mapping logic split into testable functions (mirroring the cleanup-report `shapeCleaningProgress` pattern) and executed via `node --experimental-strip-types` / tsc-CJS-emit (vitest can't run locally — no `vite`).
- `tsc --noEmit` clean; `check:tests` clean; `check:html-js` clean; `check:schema-parity` green after the new CREATE TABLEs.
- Manual (post-republish): open the hub, open each BU, confirm each section scopes correctly (e.g. Sales (B2B) cleanup = Deals on WalaPlus; CS (B2B) = CS Lifecycle on WalaPlus; Partnership (MP) on Marketplace).

## 10. Deployment
- Commit only touched files. Push `origin/QMS`, bump any changed dashboard JS `?v=`, then user Pulls → Republishes. New tables created in the idempotent table-init path on boot (no manual migration, no DROP).
