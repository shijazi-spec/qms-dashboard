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
```

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
