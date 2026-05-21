# Duplicate Radar — CS Pipeline Overlap

A new dimension on the existing Duplicate Radar that flags **clusters where a
new lead/deal overlaps with an active Customer Success deal on the same domain**.
The radar already detects duplicates by domain / email / phone / company name;
this layer adds a verdict on top of those clusters based on the CS lifecycle
state of the most active record.

## Verdict ladder

| Customer Success Phase | Sector | Time since Churn | Verdict |
|---|---|---|---|
| Onboarding / Adoption / Renewal | any | — | 🛑 **BLOCK** |
| Termination | private | < 6 months | ⚠️ **REVIEW** |
| Termination | private | ≥ 6 months | ⚠️ **WARN** |
| Termination | government | < 12 months | ⚠️ **REVIEW** |
| Termination | government | ≥ 12 months | ⚠️ **WARN** |
| No CS overlap | — | — | (no verdict) |

- **BLOCK** — the cluster contains an active CS customer. Do not push as a
  fresh marketing lead. Loop in the CS owner first.
- **REVIEW** — recently churned. CS may be in recovery; coordinate before any
  sales outreach.
- **WARN** — past the sector cool-off. Sales may re-engage but notify CS.

## Sector detection

Order of evaluation:

1. `Gov Type` field on the Deal record (CRM-provided). Values configured by
   `DUPLICATE_RADAR_GOV_VALUES` count as government; anything else counts as
   private.
2. If the field is empty, domain TLD is inspected. Any pattern in
   `DUPLICATE_RADAR_GOV_DOMAIN_PATTERNS` (defaults to `.gov.sa`, `.gov`,
   `.mil.sa`) → government.
3. Default → private.

## Operator workflow

1. Open **Duplicates** dashboard
2. Switch to the **CS Pipeline Overlap** tab
3. Top widgets show: total ARR exposure, count of BLOCK / REVIEW / WARN
4. Filter by verdict using the chips (All / Block / Review / Warn)
5. Table lists every cluster with: domain, company, sector, CS phase,
   ARR exposure, record count, last updated

To refresh after a Zoho resync, click **Run scan** — this re-classifies every
cluster whose records include a Deal with a populated CS section.

## Automatic refresh (Phase 3)

The platform runs the scan automatically on a daily cron so verdicts stay
fresh as Zoho `Phase` values move (Onboarding → Adoption → Renewal →
Termination) without anyone clicking the button.

| Surface | Default | Override |
|---|---|---|
| Inngest cron `duplicate-radar-cs-overlap-scan` | `30 3 * * *` (03:30 UTC daily) | `DUPLICATE_RADAR_CS_OVERLAP_CRON` env var |
| In-process safety-net (catches missed cron fires) | re-scans when no cluster has been re-classified in 25h | Pass `maxAgeHours` to `runCsOverlapScanIfStale()` |
| Notification on BLOCK | created when nightly scan finds ≥1 BLOCK | severity `high` when count ≥10, otherwise `medium` |

The Inngest function is primary; the in-process fallback (registered in
`src/mastra/index.ts`'s `startScheduledJobFallback` loop) re-runs the scan
if the Inngest cron is silent for >25h — mirrors the existing pattern used
by the Duplicate Radar full re-scan and the KPI auto-calc.

Both paths call the same idempotent `scanAllClustersForCsOverlap()`, so
double-firing is safe.

## API surface

- `GET  /api/duplicates/cs-overlap/clusters?verdict={block|review|warn}` —
  list clusters with a CS overlap verdict. Optional verdict filter; returns
  per-verdict counts + total ARR exposure in `summary`.
- `POST /api/duplicates/cs-overlap/scan` — manual re-scan of all clusters
  that include Deal records. Idempotent — safe to re-run.
- `POST /api/duplicates/preflight` — **pre-import duplicate check**. Body:
  `{ rows: [{ domain?, email?, company_name?, phone?, ref? }, ...], max_check? }`.
  Returns per-row verdict (block / review / warn / duplicate / pass) plus a
  summary tally + total ARR exposure of BLOCK rows. Use this from any source
  before pushing leads/deals into CRM — single SQL round trip even for
  thousands of rows.
- `POST /api/duplicates/cs-overlap/auto-capa` — **manually trigger CAPA
  creation** for BLOCK clusters above the ARR threshold. Body: `{ threshold_sar?, created_by? }`. Idempotent: existing open
  CAPAs for the same cluster are skipped. Same job also runs automatically
  inside the nightly `csOverlapAutoScan` cron.
- `GET /api/duplicates/auto-capa/kpis` — **KPI rollup over all auto-CAPAs**
  (both `cs_overlap_block` and `cs_lifecycle_violation`). Returns totals,
  per-source-type breakdown (open count, closed-30d, avg/median days to
  close, SLA hit rate, aging buckets), and a 30-day daily opened trend.
  Surfaced in the dashboard's "Auto-CAPA KPIs" tab.
- `POST /api/duplicates/reconcile-synthetic-domains` — **promote synthetic
  cluster domains to the CS-curated `Company_Domain`**. Scans every cluster
  whose `domain` looks synthetic (ends with `.cluster` or has no dot), looks
  at the Deal records inside, and renames the cluster to the authoritative
  domain when every Deal agrees. Skips clusters with conflicting domains
  and skips clusters that would collide with an already-real cluster
  (manual merge needed). Body: `{ dry_run?: boolean, limit?: number }`.
  Idempotent.

### `Company_Domain` field on the Deal Customer Success section

CS curates an authoritative `Company_Domain` at Onboarding handoff (the
real web domain like `alsahab.sa`). The radar reads it out of `raw_data`
during the CS overlap scan and uses it for two things:

1. **Domain reconciliation** — synthetic clusters (e.g. `kfupm.cluster`)
   get promoted to the real domain so Marketing's preflight checks can
   match on it directly.
2. **Lifecycle compliance** — see the new `missing_company_domain` rule
   in `duplicate-radar-cs-lifecycle.md`. Fires only for active CS phases
   (Onboarding / Adoption / Renewal); does NOT fire for pre-Onboarding
   leads or for Termination.

The field name is read with a fallback chain (`Company_Domain`,
`company_domain`, `CompanyDomain`, `Company Domain`, `Domain`, `domain`)
so it works regardless of the exact Zoho API key. Pin via env if needed:

```
DUPLICATE_RADAR_FIELD_COMPANY_DOMAIN=Company_Domain
```

All three endpoints respect the existing Duplicate Radar role gate (`admin`,
`grc_manager`, `quality_manager`, `head_of_operations_quality`,
`ai_specialist`, `bu_owner`, `executive`).

## Preflight workflow (Marketing pre-import)

1. Marketing prepares an incoming lead/deal list (any source).
2. Open Duplicates dashboard → **Preflight Check** tab.
3. Paste the list as CSV (must include a `domain` column; `company_name`,
   `email`, `phone`, `ref` are optional) or as a JSON array of row objects.
4. Click **Check**. Each row gets one of:
   - **BLOCK** — domain is an active CS customer (Onboarding/Adoption/Renewal). Do not push.
   - **REVIEW** — domain churned within sector cool-off (private < 6mo, gov < 12mo). Coordinate with CS.
   - **WARN** — domain churned past cool-off. Sales may re-engage; notify CS.
   - **DUPLICATE** — domain already has Leads/Deals in CRM with no active CS overlap. Resolve in radar first.
   - **PASS** — genuinely new. Safe to import.
5. Drop the BLOCK rows from the batch, route REVIEW rows to CS for triage,
   then import only the PASS + cleaned rows.

The same endpoint can be called programmatically — useful for scripted ETL
pipelines that push from external lead-gen tools.

## Configuration

All thresholds and field names are env-configurable so Quality can adjust
without redeploying:

```
# Customer Success section
DUPLICATE_RADAR_FIELD_PHASE=Phase
DUPLICATE_RADAR_CS_ACTIVE_PHASES=Onboarding,Adoption,Renewal
DUPLICATE_RADAR_CS_TERMINATION_PHASE=Termination

# Churn date field
DUPLICATE_RADAR_FIELD_CHURN_DATE=Churn_Date

# Sector
DUPLICATE_RADAR_FIELD_GOV_TYPE=Gov_Type
DUPLICATE_RADAR_GOV_VALUES=Government,Gov,Public Sector
DUPLICATE_RADAR_GOV_DOMAIN_PATTERNS=.gov.sa,.gov,.mil.sa

# Cool-off windows (days)
DUPLICATE_RADAR_CHURN_COOLOFF_PRIVATE_DAYS=180
DUPLICATE_RADAR_CHURN_COOLOFF_GOVERNMENT_DAYS=365

# ARR field (for exposure rollup)
DUPLICATE_RADAR_FIELD_ARR_VALUE=ARR_value

# Scoring profile
DUPLICATE_RADAR_SCORING_PROFILE=b2b   # default; legacy: email_first

# Nightly auto-scan (Phase 3)
DUPLICATE_RADAR_CS_OVERLAP_CRON=30 3 * * *   # daily 03:30 UTC

# Auto-CAPA on critical BLOCK clusters (Option B)
AUTO_CAPA_ON_BLOCK_ENABLED=true             # set false to disable
AUTO_CAPA_ARR_THRESHOLD_SAR=1000000         # min ARR exposure to open a CAPA
AUTO_CAPA_DEFAULT_ASSIGNEE=                 # optional user/email
AUTO_CAPA_TARGET_DAYS=7                     # target close window in days
```

## Auto-CAPA on critical BLOCK (Option B)

Inside the nightly cron, after the notification step, the radar now opens
a CAPA automatically for every BLOCK cluster whose `arr_exposure` is at or
above `AUTO_CAPA_ARR_THRESHOLD_SAR` (default SAR 1,000,000).

- **Idempotency** — every CAPA uses `source_type='cs_overlap_block'` and
  `source_id='cs_overlap_cluster:<cluster_id>'`. Before creating a new one
  the helper checks for any non-closed CAPA with the same source_id; if
  one exists, it skips. The cron is safe to re-run.
- **Severity** — `critical` when ARR ≥ 2× threshold, else `major`.
- **Priority** — `critical` when ARR ≥ 2× threshold, else `high`.
- **Target date** — `now + AUTO_CAPA_TARGET_DAYS` (default 7 days).
- **Title** — `CS Overlap BLOCK: <Company> pursued as new lead despite active Customer Success deal`.
- **Description** — pre-templated investigation + corrective + preventive
  action stub Quality can refine.

When at least one CAPA is created, a second notification fires with the
list of new CAPA numbers so Quality sees them in the inbox immediately.

## Tests

- `tests/vitest/duplicateRadarCsOverlap.vitest.test.ts` — unit tests for the
  classifier plus a real-data validation pass against `docs/Mawsool Deals -
  Final Report.xlsx` (102 historical CS-pipeline overlaps).

## Schema additions

`duplicate_clusters` gained four nullable columns (all backwards-compatible,
auto-applied on next boot via `initDuplicateRadarTables`):

- `cs_overlap_verdict` — block / review / warn / null
- `arr_exposure` — numeric, summed across overlapping deals
- `pipeline_lifecycle_state` — onboarding / adoption / renewal /
  termination_recent / termination_old / null
- `client_sector` — private / government / null

## Known issues / Phase 3 follow-ups (surfaced + closed 2026-05-21)

Phase 3 was verified operationally healthy on 2026-05-21 (260 BLOCK / 64 REVIEW
/ 190 WARN across 21,278 clusters; staleness 4h 20m; 1 auto-CAPA created from
this path plus 3 from CS-Lifecycle). Two gaps surfaced during that audit and
were closed in the same session.

### 1. Audit-trail write to `event_logs` — FIXED

**Symptom:** The nightly Inngest function (`src/mastra/inngest/index.ts:413-482`)
and the in-process fallback (`src/utils/scheduledJobs.ts:214-234`) both call
`scanAllClustersForCsOverlap()` and log via `logger.info(...)` — but neither
wrote a row to the `event_logs` table. For GRQ compliance-grade traceability
(ISO 9001 / ISO 27001 audit-trail requirements), each scan run must persist to
the immutable audit trail.

**Fix:** Added a `logEvent({ actionType: "scan", entityType: "duplicate_radar_cs_overlap", module: "duplicates", severity: "WARNING" if block_count > 0 else "INFO", newValue: r })` call inside the `scan-cs-overlaps` step after `scanAllClustersForCsOverlap()` returns. Same change made on the cs-lifecycle scan step (`entityType: "duplicate_radar_cs_lifecycle"`). Wrapped in try/catch so a logging failure never blocks the scan itself. The in-process fallback in `scheduledJobs.ts` calls the same scan function and inherits the audit trail through it.

### 2. `createNotification` calls misaligned with schema — FIXED

**Symptom — bigger than first documented:** The Inngest code passed four
non-existent / mismatched fields to `createNotification()`:
- `type: "alert"` — not in the `Notification` interface
- `link: "/duplicates"` — should be `action_url`
- `severity: "high" | "medium"` — should be `priority` (the column is named `priority`, not `severity`)
- **Missing required field `module`** — `NOT NULL` on the schema

Because `createNotification` is imported dynamically (`const { createNotification } = await import(...)`), TypeScript could not catch this at compile time. At runtime, every notification call hit the `module NOT NULL` constraint and threw. The errors were caught by the surrounding `try/catch` and reported via `logger.warn(...)`, so the failures were silent. **Effect: no BLOCK or auto-CAPA notification ever persisted** for either the CS-overlap or CS-lifecycle path — a real Phase 3 bug, not just a schema cosmetic issue.

**Fix:** Updated all four `createNotification` call sites in `src/mastra/inngest/index.ts` to use the correct field names and include the required fields:
```
module: "duplicates",
channel: "in_app",
title: ...,
message: ...,
action_url: "/duplicates",
priority: "high" | "medium",
```
(One pair each in the cs-overlap-scan and cs-lifecycle-scan functions: the BLOCK/critical notification + the auto-CAPA-created notification.) No schema migration needed — the existing `priority VARCHAR(20)` column already accepts `"critical" | "high" | "medium" | "low"`.

### Verification after deploy

Re-run query C from the Phase 3 verification recipe after the next nightly cron fires (or after a manual `POST /api/duplicates/cs-overlap/scan` that detects ≥1 BLOCK):

```sql
SELECT title, priority, module, created_at, action_url
FROM notifications
WHERE module = 'duplicates'
ORDER BY created_at DESC
LIMIT 10;
```

Healthy = at least one row from each scan path with priority and module populated. Likewise, audit-trail rows should appear:

```sql
SELECT timestamp, severity, action_type, entity_type, description
FROM event_logs
WHERE module = 'duplicates' AND action_type = 'scan'
ORDER BY timestamp DESC
LIMIT 10;
```
