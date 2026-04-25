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

After creating the test file, add it to `scripts/post-merge.sh` immediately after the existing redaction gate block, following the same pattern:

```bash
echo ""
echo "▶ CI gate: yourNewDatabase write-path secret-leak tests"
npx tsx src/utils/yourNewDatabase.test.ts
```

All tests are plain TypeScript files runnable with `npx tsx` — no test framework needed.  They exit with code `1` on failure so the shell's `set -e` will abort the build.

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
