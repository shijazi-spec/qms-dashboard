# Duplicate Radar — CS Lifecycle Compliance

A complementary module to the CS-Overlap detector. Where the overlap detector
asks *"is this customer active right now?"*, the lifecycle compliance module
asks *"is CS following its own SLA on this customer?"*.

## Detected violations

| Code | Severity | What it catches | GRQ source rule |
|---|---|---|---|
| `onboarding_overdue` | warning | Phase = Onboarding for more than `CS_LIFECYCLE_ONBOARDING_MAX_DAYS` (default 30 calendar days). | "Onboarding stage will be around 30 calendar days" |
| `phase_churn_desync` | **critical** | Churn Date is populated but Phase is anything other than Termination. | "When the churn date is added, the deal will move to Termination phase" |
| `termination_missing_churn_date` | warning | Phase = Termination but Churn Date is empty. | Data-integrity corollary of the rule above |
| `phase_transition_stalled` | info | Deal not modified in `CS_LIFECYCLE_STALLED_TRANSITION_DAYS` (default 7) and is not in a steady-state phase (Adoption / Renewal) and not Onboarding (covered above) and not Termination (terminal). | "One working day for movement from phase to phase" |
| `adoption_premature` | warning | Phase = Adoption while (a) `Customer_Since` is less than `CS_LIFECYCLE_ADOPTION_MIN_CUSTOMER_AGE_DAYS` (default 30) — suggesting the deal jumped Onboarding — OR (b) `Trial_End_Date` is still in the future — suggesting the deal moved to Adoption before the trial closed. | "Adoption phase for clients who completed Onboarding + trial period (if found)" |

Both signals (`Customer_Since`, `Trial_End_Date`) are env-configurable. When
neither field is present on a record the rule does **not** fire (no false
positives). Field-name mapping:

```
DUPLICATE_RADAR_FIELD_CUSTOMER_SINCE=Customer_Since
DUPLICATE_RADAR_FIELD_TRIAL_END=Trial_End_Date
```

Deferred for a follow-up phase (need Zoho Stage History API):
- Full stage-history audit (deal walked through every required prior phase)

## How it scans

The detector reads `duplicate_records` rows where `zoho_module = 'Deals'` (the
records the radar already syncs from Zoho), pulls the Customer Success section
out of `raw_data` via the same field-resolution as the CS-Overlap layer, and
applies the rules. Pure functions live in
[`src/utils/csLifecycleCompliance.ts`](../src/utils/csLifecycleCompliance.ts);
the DB layer is in
[`duplicateRadarDatabase.ts`](../src/utils/duplicateRadarDatabase.ts).

No new tables — violations are recomputed on demand. The data volume (deals,
not all CRM records) keeps each scan well under a second.

## Operator workflow

1. Open the Duplicates dashboard → **CS Lifecycle** tab (purple dot).
2. Five summary widgets at the top: Critical / Warning / Info counts, total
   CS deals scanned, total violations.
3. Filter chips: All / Critical / Warning / Info.
4. Table lists every violation with severity badge, account, domain, current
   phase, days since modified, the violation code, and the suggested action.
5. Click **Refresh** to re-run the scan against the latest synced data.

## API surface

- `GET /api/duplicates/cs-lifecycle/violations?severity={info|warning|critical}&code={onboarding_overdue|phase_churn_desync|termination_missing_churn_date|phase_transition_stalled}&limit=N`
  - Default limit 2000, hard cap 5000.
  - Returns `{ summary, violations, duration_ms }`.

Role gate matches the rest of the Duplicate Radar (admin, grc_manager,
quality_manager, head_of_operations_quality, ai_specialist, bu_owner,
executive).

## Automatic refresh

| Driver | Schedule | Notes |
|---|---|---|
| **Inngest cron** `duplicate-radar-cs-lifecycle-scan` | 03:45 UTC daily (env `CS_LIFECYCLE_SCAN_CRON`) | Runs 15 minutes after the CS-Overlap scan so phase data is fresh |
| **Notification on critical** | Posted when nightly scan finds ≥1 critical violation | Severity `high` if ≥5, otherwise `medium`, links to `/duplicates` |

The same cron-then-fallback pattern as the rest of the radar — both paths
call the same idempotent `scanCsLifecycleViolations()`.

## Tuning

```
# Phase 4 — CS Lifecycle Compliance
CS_LIFECYCLE_ONBOARDING_MAX_DAYS=30                    # rule #1 threshold
CS_LIFECYCLE_STALLED_TRANSITION_DAYS=7                 # rule #4 threshold
CS_LIFECYCLE_STEADY_STATE_PHASES=Adoption,Renewal      # phases exempt from stalled-transition
CS_LIFECYCLE_ADOPTION_MIN_CUSTOMER_AGE_DAYS=30         # rule #5 threshold (adoption_premature)
CS_LIFECYCLE_SCAN_CRON=45 3 * * *                      # nightly schedule

# Field mapping (shared with CS-Overlap module)
DUPLICATE_RADAR_FIELD_CUSTOMER_SINCE=Customer_Since
DUPLICATE_RADAR_FIELD_TRIAL_END=Trial_End_Date
```

Shared with the CS-Overlap module (so both stay aligned):

```
DUPLICATE_RADAR_CS_ACTIVE_PHASES=Onboarding,Adoption,Renewal
DUPLICATE_RADAR_CS_TERMINATION_PHASE=Termination
DUPLICATE_RADAR_FIELD_PHASE=Phase
DUPLICATE_RADAR_FIELD_CHURN_DATE=Churn_Date
DUPLICATE_RADAR_FIELD_GOV_TYPE=Gov_Type
```

## Tests

[`tests/vitest/csLifecycleCompliance.vitest.test.ts`](../tests/vitest/csLifecycleCompliance.vitest.test.ts)
— 14 cases covering all four violation rules, steady-state phase exemption,
env threshold overrides, and the summary rollup.
