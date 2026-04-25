# src/utils — Database writer modules

## Rule: every DB writer that persists user-controlled data must have a secret-leak integration test

Any module in this directory that executes INSERT or UPDATE statements containing user-supplied or system-generated data **must** have a companion integration test that:

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

| Module | Test file |
|---|---|
| `eventLogsDatabase.ts` | `redactSensitiveFields.test.ts` |
| `changeHistoryDatabase.ts` | `changeHistoryDatabase.test.ts` |
| `yourNewDatabase.ts` | `yourNewDatabase.test.ts` |

### Wiring into CI

Companion tests placed under `src/utils/` are picked up automatically by `npm test` (which runs `tests/runIntegrationTests.ts` and recursively discovers every `src/**/*.test.ts` file), and `npm test` is invoked from `scripts/post-merge.sh`. No further wiring is required for that path.

If you want a test to run *before* the full `npm test` suite (for example because it should fail the build instantly on regression), also add an explicit invocation to `scripts/post-merge.sh` following the same pattern as the existing gates:

```bash
echo ""
echo "▶ CI gate: yourNewDatabase write-path secret-leak tests"
npx tsx src/utils/yourNewDatabase.test.ts
```

All tests are plain TypeScript files runnable with `npx tsx` — no test framework needed.  They exit with code `1` on failure so the shell's `set -e` will abort the build.

### Automated enforcement

`scripts/check-db-test-coverage.sh` is the CI gate that enforces this rule. It runs from `scripts/post-merge.sh` *before* `npm test` and:

1. Discovers every `src/utils/*Database.ts` file.
2. Verifies that a companion `*.test.ts` exists (default convention: `<name>Database.test.ts`; non-standard names like `eventLogsDatabase.ts` → `redactSensitiveFields.test.ts` are mapped explicitly inside the script).
3. Verifies the companion test is wired into `scripts/post-merge.sh` — either by an explicit `npx tsx <path>` line or by being auto-discovered through `npm test`.

Adding a new `*Database.ts` file without a companion test fails the gate immediately, with a diagnostic pointing back to this README. A baseline `GRANDFATHERED` allow-list inside the script captures the writers that already existed when the gate was introduced and still need a test backfilled — **do not add new entries to that list**; write the test instead.

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
