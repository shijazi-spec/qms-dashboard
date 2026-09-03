# src/utils — Database writer modules

## Rule: every DB writer that persists user-controlled data must have a secret-leak integration test

Any TypeScript file under `src/` that executes INSERT or UPDATE statements containing user-supplied or system-generated data **must** have a companion integration test that:

> **Scope.** This rule originated for `src/utils/*Database.ts` but the CI gate now applies to **every** writer under `src/`, including:
> - `src/utils/*Database.ts` and `src/utils/*Db.ts` (e.g. `callIntelligenceDb.ts`)
> - Other utilities under `src/utils/` that issue their own writes (`database.ts`, `notificationHub.ts`, `aiTelemetry.ts`, etc.)
> - Express route handlers under `src/mastra/routes/*.ts` that run INSERT / UPDATE directly against the pool instead of going through a `*Database.ts` module
> - Anything added under `src/data/` or other future writer locations
>
> The gate (`scripts/check-db-test-coverage.sh`) discovers writers via an `rg` scan of `src/**/*.ts` for `INSERT INTO` / `UPDATE <table> SET`, plus an explicit include list for the `src/utils/*Database.ts` and `src/utils/*Db.ts` naming conventions.

1. **Mocks `pg.Pool.prototype.query`** before importing the module under test so no real database connection is required.
2. **Calls every public write function** (`logX`, `saveX`, `upsertX`, etc.) with payloads containing the five required deny-list keys:
   - `password_hash`
   - `mfa_secret`
   - `access_token`
   - `refresh_token`
   - `api_key`
3. **Asserts the raw secret values are absent** from the captured INSERT/UPDATE params.
4. **Asserts the `***REDACTED***` sentinel is present** in those params (anti-tautology).
5. **Asserts at least one non-sensitive field passes through unchanged** so the test would catch a broken redactor that replaces everything.

### Naming convention

The companion test must live in the **same directory** as the source file and follow the `<basename>.test.ts` convention. Non-standard names are mapped explicitly inside `scripts/check-db-test-coverage.sh` (`COMPANION_TESTS`).

| Module | Test file |
|---|---|
| `src/utils/eventLogsDatabase.ts` | `src/utils/redactSensitiveFields.test.ts` (mapped) |
| `src/utils/changeHistoryDatabase.ts` | `src/utils/changeHistoryDatabase.test.ts` |
| `src/utils/yourNewDatabase.ts` | `src/utils/yourNewDatabase.test.ts` |
| `src/utils/callIntelligenceDb.ts` | `src/utils/callIntelligenceDb.test.ts` |
| `src/mastra/routes/yourRoutes.ts` | `src/mastra/routes/yourRoutes.test.ts` |
| `src/data/yourSeed.ts` | `src/data/yourSeed.test.ts` |

### Wiring into CI

Companion tests placed anywhere under `src/` are picked up automatically by `npm test` (which runs `tests/runIntegrationTests.ts` and recursively discovers every `src/**/*.test.ts` file), and `npm test` is invoked from `scripts/post-merge.sh`. No further wiring is required for that path — this works for `src/utils/`, `src/mastra/routes/`, `src/data/`, and any other location.

If you want a test to run *before* the full `npm test` suite (for example because it should fail the build instantly on regression), also add an explicit invocation to `scripts/post-merge.sh` following the same pattern as the existing gates:

```bash
echo ""
echo "▶ CI gate: yourNewDatabase write-path secret-leak tests"
npx tsx src/utils/yourNewDatabase.test.ts
```

All tests are plain TypeScript files runnable with `npx tsx` — no test framework needed.  They exit with code `1` on failure so the shell's `set -e` will abort the build.

### Automated enforcement

`scripts/check-db-test-coverage.sh` is the CI gate that enforces this rule. It runs from `scripts/post-merge.sh` *before* `npm test` and:

1. Discovers every writer under `src/` by combining two strategies:
   - An explicit include glob for known writer naming conventions (`src/utils/*Database.ts` and `src/utils/*Db.ts`).
   - A repo-wide `rg` scan of every `src/**/*.ts` file (excluding `*.test.ts`) for `INSERT INTO` or `UPDATE <table> SET` patterns. This catches writers in any directory — `src/utils/` files that don't match the `*Database.ts` naming, route handlers under `src/mastra/routes/`, future writers under `src/data/`, and so on.
2. Verifies that a companion `<basename>.test.ts` exists in the same directory as the source file (non-standard names like `eventLogsDatabase.ts` → `redactSensitiveFields.test.ts` are mapped explicitly inside the script via `COMPANION_TESTS`).
3. Verifies the companion test is wired into `scripts/post-merge.sh` — either by an explicit `npx tsx <path>` line or by being auto-discovered through `npm test`.

Adding a new writer file without a companion test fails the gate immediately, with a diagnostic pointing back to this README. A baseline `GRANDFATHERED` allow-list inside the script captures the writers that already existed when the broader gate was introduced and still need a test backfilled — **do not add new entries to that list**; write the test instead.

Run it locally before opening a PR:

```bash
bash scripts/check-db-test-coverage.sh
```

### Redaction helper

The canonical helper is `redactSensitiveFields()` exported from `eventLogsDatabase.ts`.  Import it as:

```typescript
import { redactSensitiveFields } from './eventLogsDatabase';
```

Call it on every value before it reaches a parameterised query, passing the column/field name as the optional second argument for primitive values:

```typescript
const safeValue = redactSensitiveFields(rawValue, fieldName);
await pool.query('INSERT INTO ... VALUES ($1)', [safeValue]);
```

See `changeHistoryDatabase.ts` for a reference implementation.
