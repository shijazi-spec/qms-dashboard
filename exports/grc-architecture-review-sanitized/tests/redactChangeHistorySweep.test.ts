/**
 * Unit tests for Task #250 — post-restore sweep coverage of
 * nc_change_history and capa_change_history.
 *
 * Verifies that `redactChangeHistoryTable()` in
 * `src/utils/redactHistoricalLogs.ts`:
 *
 *   1. Replaces both `old_value` and `new_value` with REDACTED_SENTINEL
 *      whenever `field_changed` is on the deny list (Layer 1 — key-based).
 *   2. Applies `redactSecretLikeStrings` to `old_value` / `new_value` when
 *      `field_changed` is NOT on the deny list, catching credential-shaped
 *      substrings embedded in non-sensitive diffs (Layer 2 — regex scrubber).
 *   3. Always runs `redactSecretLikeStrings` over `change_reason`, the
 *      operator-supplied prose column, regardless of `field_changed`.
 *   4. Leaves clean rows untouched (no spurious UPDATEs).
 *   5. Is idempotent on a second pass over the now-clean table.
 *   6. Treats `nc_change_history` and `capa_change_history` identically — the
 *      table name is parameterised, so both are protected by a single sweep.
 *
 * This is the test/audit evidence required by Task #250's "Done looks like"
 * checklist.
 *
 * Run:  npx tsx tests/redactChangeHistorySweep.test.ts
 */

import { redactChangeHistoryTable } from '../src/utils/redactHistoricalLogs';
import { REDACTED_SENTINEL } from '../src/utils/eventLogsDatabase';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

interface ChangeHistoryRow {
  id: number;
  field_changed: string;
  old_value: string | null;
  new_value: string | null;
  change_reason: string | null;
}

interface CapturedUpdate {
  sql: string;
  params: ReadonlyArray<unknown>;
}

interface QueryResult {
  rows: unknown[];
  rowCount: number;
}

interface QueryableClient {
  query: (sql: string, params?: ReadonlyArray<unknown>) => Promise<QueryResult>;
}

function makeStubClient(
  tableName: string,
  initialRows: ChangeHistoryRow[],
): {
  client: QueryableClient;
  updates: CapturedUpdate[];
  rows: ChangeHistoryRow[];
  selectCalls: number;
} {
  const rows: ChangeHistoryRow[] = initialRows.map(r => ({ ...r }));
  rows.sort((a, b) => a.id - b.id);
  const updates: CapturedUpdate[] = [];
  const state = { selectCalls: 0 };

  const selectPattern = new RegExp(
    `SELECT\\s+id,\\s*field_changed,\\s*old_value,\\s*new_value,\\s*change_reason[\\s\\S]*FROM\\s+${tableName}`,
    'i',
  );
  const updatePattern = new RegExp(`^\\s*UPDATE\\s+${tableName}`, 'i');

  const query = async (sql: string, params: ReadonlyArray<unknown> = []) => {
    if (selectPattern.test(sql)) {
      if (!/WHERE\s+id\s*>\s*\$1/i.test(sql) || !/LIMIT\s+\$2/i.test(sql)) {
        throw new Error(
          `Sweep issued a non-paginated SELECT — keyset cursor missing:\n${sql}`,
        );
      }
      state.selectCalls++;
      const cursor = Number(params[0]);
      const limit = Number(params[1]);
      const page = rows
        .filter(r => r.id > cursor)
        .slice(0, limit)
        .map(r => ({ ...r }));
      return { rows: page, rowCount: page.length };
    }

    if (updatePattern.test(sql)) {
      updates.push({ sql, params });
      const id = params[3] as number;
      const target = rows.find(r => r.id === id);
      if (target) {
        target.old_value = params[0] as string | null;
        target.new_value = params[1] as string | null;
        target.change_reason = params[2] as string | null;
      }
      return { rows: [], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  };

  return {
    client: { query },
    updates,
    rows,
    get selectCalls() {
      return state.selectCalls;
    },
  } as ReturnType<typeof makeStubClient>;
}

const SK_KEY = '<REDACTED_TOKEN>';
const GHP_TOKEN = '<REDACTED_TOKEN>';
const BCRYPT = '$2b$12$abcdefghijklmnopqrstuv1234567890ABCDEFGHIJKLMNOPQRSTU';
const PASSWORD_HASH_LITERAL = '$2b$12$RAW_LEAKED_PASSWORD_HASH_FROM_PRE_FIX_BACKUP';

async function runForTable(tableName: string): Promise<void> {
  console.log(`\n--- ${tableName} ---\n`);

  const initial: ChangeHistoryRow[] = [
    // Layer 1 — sensitive field name. Both values must be wiped wholesale,
    // even though the literal value happens to also match the bcrypt regex.
    {
      id: 1,
      field_changed: 'password_hash',
      old_value: PASSWORD_HASH_LITERAL,
      new_value: 'rotated-' + PASSWORD_HASH_LITERAL,
      change_reason: 'Periodic rotation',
    },
    // Layer 2 — non-sensitive field name carrying an sk-… token in old_value.
    {
      id: 2,
      field_changed: 'description',
      old_value: `Migrated from key ${SK_KEY} to new key`,
      new_value: 'Migrated from key (rotated) to new key',
      change_reason: null,
    },
    // Layer 2 — non-sensitive field name with ghp_ token leaking into new_value.
    {
      id: 3,
      field_changed: 'integration_notes',
      old_value: 'GitHub PAT pending issue',
      new_value: `GitHub PAT issued: ${GHP_TOKEN}`,
      change_reason: null,
    },
    // change_reason scrubbing — non-sensitive field, non-secret values, but the
    // operator-supplied reason carries a leaked token.
    {
      id: 4,
      field_changed: 'status',
      old_value: 'open',
      new_value: 'closed',
      change_reason: `Closed after rotating compromised key ${SK_KEY}`,
    },
    // Clean row — must not be touched.
    {
      id: 5,
      field_changed: 'priority',
      old_value: 'medium',
      new_value: 'high',
      change_reason: 'Customer escalation',
    },
    // Already-redacted sensitive row — second-write skip path.
    {
      id: 6,
      field_changed: 'api_key',
      old_value: REDACTED_SENTINEL,
      new_value: REDACTED_SENTINEL,
      change_reason: null,
    },
    // Layer 2 — bcrypt hash leaked into a non-sensitive field's old_value.
    {
      id: 7,
      field_changed: 'audit_note',
      old_value: `Found stale hash ${BCRYPT} in legacy export`,
      new_value: 'Hash rotated and removed from export',
      change_reason: null,
    },
  ];

  const stub = makeStubClient(tableName, initial);
  const updated = await redactChangeHistoryTable(stub.client, tableName);

  // Rows expected to be updated: 1 (deny list), 2, 3, 4 (regex), 7 (regex). Row 5 clean. Row 6 already redacted.
  // Task #294 changed the return shape from `number` to
  // `ChangeHistorySweepResult` (so callers can report `change_reason` scrubs
  // separately in audit-log entries). Read `rowsUpdated` for the dirty-row total.
  assert(
    updated.rowsUpdated === 5,
    `${tableName}: 5 dirty rows updated (got ${updated.rowsUpdated})`,
  );
  assert(
    stub.updates.length === 5,
    `${tableName}: 5 UPDATE statements issued (got ${stub.updates.length})`,
  );

  const r1 = stub.rows.find(r => r.id === 1)!;
  assert(
    r1.old_value === REDACTED_SENTINEL && r1.new_value === REDACTED_SENTINEL,
    `${tableName}: row 1 (password_hash) — both values replaced with sentinel (Layer 1)`,
  );
  assert(
    !String(r1.old_value).includes(PASSWORD_HASH_LITERAL) &&
      !String(r1.new_value).includes(PASSWORD_HASH_LITERAL),
    `${tableName}: row 1 — raw password hash literal absent from stored values`,
  );

  const r2 = stub.rows.find(r => r.id === 2)!;
  assert(
    !String(r2.old_value).includes(SK_KEY),
    `${tableName}: row 2 — sk-… key removed from old_value (Layer 2)`,
  );
  assert(
    String(r2.old_value).includes(REDACTED_SENTINEL),
    `${tableName}: row 2 — sentinel present in old_value`,
  );
  assert(
    String(r2.old_value).includes('Migrated from key'),
    `${tableName}: row 2 — surrounding prose preserved in old_value`,
  );

  const r3 = stub.rows.find(r => r.id === 3)!;
  assert(
    !String(r3.new_value).includes(GHP_TOKEN),
    `${tableName}: row 3 — ghp_ token removed from new_value (Layer 2)`,
  );
  assert(
    String(r3.new_value).includes(REDACTED_SENTINEL),
    `${tableName}: row 3 — sentinel present in new_value`,
  );

  const r4 = stub.rows.find(r => r.id === 4)!;
  assert(
    r4.old_value === 'open' && r4.new_value === 'closed',
    `${tableName}: row 4 — non-secret old/new_value preserved verbatim`,
  );
  assert(
    !String(r4.change_reason).includes(SK_KEY),
    `${tableName}: row 4 — sk-… key removed from change_reason (Layer 2 / write-path parity)`,
  );
  assert(
    String(r4.change_reason).includes(REDACTED_SENTINEL),
    `${tableName}: row 4 — sentinel present in change_reason`,
  );

  const r5 = stub.rows.find(r => r.id === 5)!;
  assert(
    r5.old_value === 'medium' &&
      r5.new_value === 'high' &&
      r5.change_reason === 'Customer escalation',
    `${tableName}: row 5 (clean) — untouched, no spurious UPDATE`,
  );

  const r6 = stub.rows.find(r => r.id === 6)!;
  assert(
    r6.old_value === REDACTED_SENTINEL && r6.new_value === REDACTED_SENTINEL,
    `${tableName}: row 6 (already redacted) — byte-identical, no spurious UPDATE`,
  );

  const r7 = stub.rows.find(r => r.id === 7)!;
  assert(
    !String(r7.old_value).includes(BCRYPT),
    `${tableName}: row 7 — bcrypt hash removed from old_value (Layer 2)`,
  );
  assert(
    String(r7.old_value).includes(REDACTED_SENTINEL),
    `${tableName}: row 7 — sentinel present in old_value`,
  );

  // Verify the only rows whose UPDATE was issued are 1, 2, 3, 4, 7.
  const updatedIds = stub.updates.map(u => u.params[3] as number).sort((a, b) => a - b);
  assert(
    JSON.stringify(updatedIds) === JSON.stringify([1, 2, 3, 4, 7]),
    `${tableName}: only rows 1,2,3,4,7 received UPDATEs (got ${JSON.stringify(updatedIds)})`,
  );

  // ----- Idempotency check: second sweep must perform 0 UPDATEs. -----
  const stub2 = makeStubClient(tableName, stub.rows);
  const updated2 = await redactChangeHistoryTable(stub2.client, tableName);

  assert(
    updated2.rowsUpdated === 0,
    `${tableName}: second pass updates 0 rows (got ${updated2.rowsUpdated}) — idempotent`,
  );
  assert(
    stub2.updates.length === 0,
    `${tableName}: second pass issues no UPDATE statements`,
  );
}

async function runEmptyTable(): Promise<void> {
  console.log('\n--- empty table edge case ---\n');
  const stub = makeStubClient('nc_change_history', []);
  const updated = await redactChangeHistoryTable(stub.client, 'nc_change_history');
  assert(updated.rowsUpdated === 0, 'empty nc_change_history: 0 rows updated');
  assert(stub.selectCalls === 1, 'empty nc_change_history: exactly 1 SELECT issued');
  assert(stub.updates.length === 0, 'empty nc_change_history: no UPDATE issued');
}

async function run(): Promise<void> {
  console.log('\n[redactChangeHistoryTable] post-restore sweep (Task #250)\n');

  await runForTable('nc_change_history');
  await runForTable('capa_change_history');
  await runEmptyTable();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error(
      '\n❌ redactChangeHistorySweep tests FAILED — post-restore sweep may miss leaked secrets in nc/capa_change_history.',
    );
    process.exit(1);
  }
  console.log('\n✅ All redactChangeHistorySweep tests passed');
}

run().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
