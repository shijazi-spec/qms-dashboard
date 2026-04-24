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
  sweep.
- `production-postcheck.txt` — production post-state verification and
  unredacted-leak scan.
- `redaction-sweep-dev-*.log` — first dry run against the empty dev
  database.
- `redaction-sweep-validation-*.log` — sweep output against the seeded
  dev data (5 rows updated across 3 tables).
- `redaction-sweep-idempotency-*.log` — re-run output proving the
  script is idempotent (0 rows updated).
