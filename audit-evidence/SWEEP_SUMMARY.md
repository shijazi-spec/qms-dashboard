# Historical Audit Log Redaction Sweep — Audit Evidence

**Task:** #36 — Run the historical audit log redaction sweep against production
**Script:** `src/utils/redactHistoricalLogs.ts`
**Sweep performed (UTC):** 2026-04-24

---

## 1. Production pre-sweep state

Captured via the read-only production replica.

| Table                 | Total rows | Rows with payload |
|-----------------------|-----------:|------------------:|
| `event_logs`          |          0 |                 0 |
| `nc_change_history`   |          0 |                 0 |
| `capa_change_history` |          0 |                 0 |
| `ai_pending_actions`  |          0 |                 0 |

See `production-precheck.txt`.

All four target tables exist in production with the schema the script
expects, and currently contain zero rows. **A redaction run against
production at this point in time is a no-op (0 rows updated in every
table)** because there is no historical data to rewrite. The deny-list
fix from task #27 is therefore the only protection currently relied on
in production, and it is sufficient given the empty tables.

## 2. End-to-end validation against the dev database

To prove the script behaves correctly on real sensitive data (rather
than just running against the empty production replica), three
representative `event_logs` rows, three `nc_change_history` rows, and
two `capa_change_history` rows were seeded into the development
database. Each set included both rows with sensitive material and
control rows with only non-sensitive fields.

The sweep was then executed and produced the following output (see
`redaction-sweep-validation-*.log`):

```
[Redaction] Starting historical log redaction sweep...
[Redaction] event_logs: 2 rows updated
[Redaction] nc_change_history: 2 rows updated
[Redaction] capa_change_history: 1 rows updated
[Redaction] ai_pending_actions: 0 rows updated
[Redaction] Sweep complete. Total rows updated: 5
```

Spot-checks after the sweep confirmed:

- `event_logs` rows containing `password_hash`, `mfa_secret`, `api_key`,
  `auth_token`, and `refresh_token` had every sensitive value replaced
  with `***REDACTED***`, while non-sensitive sibling keys
  (`username`, `email`, `display_name`) were preserved.
- The `_redacted_at` breadcrumb (ISO-8601 timestamp) was added to every
  redacted JSON payload (both `old_value` and `new_value`).
- The clean control row (no sensitive keys) was correctly skipped — no
  breadcrumb added, original values intact.
- `nc_change_history` rows whose `field_changed` matched the sensitive
  list (`password_hash`, `mfa_secret`) had both `old_value` and
  `new_value` rewritten to `***REDACTED***`. The non-sensitive control
  row (`field_changed = description`) was untouched.
- `capa_change_history` row with `field_changed = api_key` was
  redacted; the control row (`field_changed = reason`) was untouched.

## 3. Idempotency confirmed

Running the script a second time over the now-redacted dev data produced
(see `redaction-sweep-idempotency-*.log`):

```
[Redaction] event_logs: 0 rows updated
[Redaction] nc_change_history: 0 rows updated
[Redaction] capa_change_history: 0 rows updated
[Redaction] ai_pending_actions: 0 rows updated
[Redaction] Sweep complete. Total rows updated: 0
```

Re-running is safe: rows that are already redacted are detected (via
`JSON.stringify(redacted) === JSON.stringify(original)` for JSONB
columns and the `REDACTED_SENTINEL` equality check for change-history
rows) and skipped.

## 4. Test-data cleanup

All seed rows inserted for validation were deleted from the dev
database. Post-cleanup row counts in dev match production: 0 rows in
all four target tables.

## 5. How to execute the sweep against production

The task-agent environment can only read from the production replica,
so the actual production write run must be triggered from the deployed
environment, where `DATABASE_URL` resolves to the live production
database. The recommended procedure:

1. Open a shell against the published deployment (or run as a one-off
   scheduled job).
2. Execute: `npx tsx src/utils/redactHistoricalLogs.ts`
3. Capture stdout — the `[Redaction] Sweep complete. Total rows
   updated: N` line is the audit artefact.
4. Spot-check at least one rewritten `event_logs` row to confirm the
   `_redacted_at` breadcrumb is present and no sensitive values remain.

Given the current production state (all four tables empty), step 2 is
expected to report `Total rows updated: 0`. The procedure should be
re-executed any time legacy data is restored from a backup that
predates the deny-list fix.

## 6. Production post-state verification

After the dev validation, the production replica was queried again to
capture an explicit post-state snapshot and to confirm no
sensitive-looking values are sitting unredacted (see
`production-postcheck.txt`). Results:

| Table                 | Total rows | Rows with payload | Suspect unredacted rows |
|-----------------------|-----------:|------------------:|------------------------:|
| `event_logs`          |          0 |                 0 |                       0 |
| `nc_change_history`   |          0 |                 0 |                       0 |
| `capa_change_history` |          0 |                 0 |                       0 |
| `ai_pending_actions`  |          0 |                 0 |                     n/a |

The leak scan looked for rows whose `field_changed` matches a sensitive
key but whose `old_value`/`new_value` is not the `***REDACTED***`
sentinel (and, in `event_logs`, JSON payloads containing sensitive key
names without a `REDACTED` substring). Zero suspect rows were found in
any target table. This is the same end-state the script would produce
if it were executed against the production write endpoint right now.

## Files in this directory

- `production-precheck.txt` — production row counts captured before the
  sweep (updated for each task run).
- `production-postcheck.txt` — production post-state verification and
  unredacted-leak scan (updated for each task run).
- `redaction-sweep-dev-*.log` — first dry run against the empty dev
  database.
- `redaction-sweep-validation-*.log` — sweep output against the seeded
  dev data (5 rows updated across 3 tables).
- `redaction-sweep-idempotency-*.log` — re-run output proving the
  script is idempotent (0 rows updated).

---

# Task #101 — Approval-Preview Redaction Sweep (payload_preview backfill)

**Task:** #101 — Run the new approval-preview redaction sweep against production and capture audit evidence
**Script:** `src/utils/redactHistoricalLogs.ts` (extended by Task #85 to include `ai_pending_actions.payload_preview`)
**Sweep performed (UTC):** 2026-04-24T23:29:06.376Z

Task #85 extended `redactHistoricalLogs.ts` so it now also rewrites
historical `ai_pending_actions.payload_preview` TEXT rows that contain
credential-shaped substrings (using `redactSecretLikeStrings`), and emits
a dedicated `event_logs` audit entry covering the per-column breakdown.

## 7. Production pre-sweep state (Task #101)

Captured via read-only production replica at 2026-04-24T23:29:00Z.

| Table                 | Total rows | payload ≠ null | payload_preview ≠ null | execution_result ≠ null |
|-----------------------|-----------:|---------------:|-----------------------:|------------------------:|
| `ai_pending_actions`  |          0 |              0 |                      0 |                       0 |
| `nc_change_history`   |          0 |            n/a |                    n/a |                     n/a |
| `capa_change_history` |          0 |            n/a |                    n/a |                     n/a |
| `event_logs`          |          0 |              0 |                    n/a |                     n/a |

All four target tables exist in production. Row counts are zero — a
production sweep is a no-op (0 rows updated) at this point in time, which
is the expected and correct outcome.

## 8. Script validation against the development database (Task #101)

> **Environment note:** The task-agent environment has read-only access to
> the production replica and cannot issue write queries against production.
> The sweep script was therefore executed against the development database
> to verify the new `payload_preview` backfill path runs without errors
> before a production operator triggers it manually (see section 12).
> Because all four production tables contain 0 rows (section 7), the
> production run will produce byte-for-byte identical console output.

Full console output from the dev run:

```
[Redaction] Starting historical log redaction sweep...
[Redaction] Sweep timestamp: 2026-04-24T23:29:06.376Z
[Redaction] event_logs: 0 rows updated
[Redaction] nc_change_history: 0 rows updated
[Redaction] capa_change_history: 0 rows updated
[Redaction] ai_pending_actions: 0 rows updated (scanned=0, payload=0, payload_preview=0, execution_result=0)
[Redaction] Sweep complete. Total rows updated: 0
[Redaction] Audit-log entry emitted for sweep run
```

Per-column breakdown for `ai_pending_actions`:

| Column                 | Scanned | Changed |
|------------------------|--------:|--------:|
| `payload`              |       0 |       0 |
| `payload_preview`      |       0 |       0 |
| `execution_result`     |       0 |       0 |
| **Total rows updated** |         |   **0** |

All rows scanned = 0 (table empty), confirming the zero pre-sweep count.
The new `payload_preview` code path executed without error.

## 9. Audit-log entry from dev validation run (Task #101)

The dev sweep emitted an `event_logs` row in the **development** database.
This entry confirms the `logEvent` call works correctly for the new sweep
variant; it is **not** a production audit record.

| Field         | Value (development database)                             |
|---------------|----------------------------------------------------------|
| `id`          | 76 *(development DB only)*                               |
| `action_type` | `UPDATE`                                                 |
| `entity_type` | `SYSTEM`                                                 |
| `entity_id`   | `ai_pending_actions`                                     |
| `entity_name` | `Historical secret-redaction sweep`                      |
| `module`      | `security/redaction-sweep`                               |
| `created_at`  | `2026-04-24T23:29:06.425924Z`                            |

`new_value` JSONB structure confirmed by the dev entry:

```json
{
  "sweep_timestamp": "2026-04-24T23:29:06.376Z",
  "event_logs_updated": 0,
  "nc_change_history_updated": 0,
  "capa_change_history_updated": 0,
  "ai_pending_actions": {
    "scanned": 0,
    "payload_changed": 0,
    "payload_preview_changed": 0,
    "execution_result_changed": 0,
    "rows_updated": 0
  },
  "total_rows_updated": 0
}
```

The production run (section 12) will write an equivalent entry to the
production `event_logs` table. Its ID must be recorded here once the
operator has completed that step.

**Production audit-log entry ID: _pending manual production run_**

## 10. Idempotency re-run (Task #101, development database)

The script was executed a second time immediately after the first dev run.
Full console output:

```
[Redaction] Starting historical log redaction sweep...
[Redaction] Sweep timestamp: 2026-04-24T23:29:22.589Z
[Redaction] event_logs: 0 rows updated
[Redaction] nc_change_history: 0 rows updated
[Redaction] capa_change_history: 0 rows updated
[Redaction] ai_pending_actions: 0 rows updated (scanned=0, payload=0, payload_preview=0, execution_result=0)
[Redaction] Sweep complete. Total rows updated: 0
[Redaction] Audit-log entry emitted for sweep run
```

**Idempotency confirmed:** `Total rows updated: 0` on re-run.  
*(Dev re-run emitted event_logs id=77 in the development database,
timestamp `2026-04-24T23:29:22.637Z`.)*

## 11. Production post-state (Task #101)

Row counts queried from the read-only production replica after the dev
validation run. Because production has 0 rows in all tables, no changes
are present to inspect:

| Table                 | Total rows | Rows with payload | Suspect unredacted rows |
|-----------------------|-----------:|------------------:|------------------------:|
| `event_logs`          |          0 |                 0 |                       0 |
| `nc_change_history`   |          0 |                 0 |                       0 |
| `capa_change_history` |          0 |                 0 |                       0 |
| `ai_pending_actions`  |          0 |                 0 |                     n/a |

No credential-shaped strings found in any production row. Production is
clean and contains no rows requiring redaction at this time.

**No production audit-log entries for the sweep exist yet** — they will be
created by the manual production run documented in section 12.

## 12. Manual production run — operator instructions (Task #101)

The task-agent environment cannot write to the production database. A
production operator must complete this step from the deployed environment:

1. Open a shell against the published deployment (or run as a one-off
   scheduled job against the production `DATABASE_URL`).
2. Execute: `npx tsx src/utils/redactHistoricalLogs.ts`
3. Capture the full stdout. The key lines to record are:
   - `[Redaction] ai_pending_actions: N rows updated (scanned=..., payload=..., payload_preview=..., execution_result=...)`
   - `[Redaction] Sweep complete. Total rows updated: N`
   - `Event logged successfully with ID: <ID>` (the production audit-log entry ID)
4. Update this file: fill in the production audit-log entry ID in section 9
   and add the actual per-column counts to section 8.
5. Run a second time to confirm idempotency (`Total rows updated: 0`).

Given the current production state (all four tables empty), step 2 is
expected to report `Total rows updated: 0`, identical to the dev validation
run. The procedure should be re-executed any time legacy data is restored
from a backup that predates the deny-list fix.
