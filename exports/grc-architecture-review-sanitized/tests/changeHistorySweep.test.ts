/**
 * Unit tests for Task #249 — historical nc_change_history / capa_change_history
 * secret-redaction sweep.
 *
 * Task #99 added redactSecretLikeStrings + change_reason redaction to the
 * write paths in src/utils/changeHistoryDatabase.ts going forward, but rows
 * written before that fix may still carry credential-shaped substrings in
 * old_value / new_value / change_reason. This task extended
 * redactChangeHistoryTable() in src/utils/redactHistoricalLogs.ts to backfill
 * those rows with the same two-defense pass the write path now uses:
 *
 *   1. KEY-BASED  — when field_changed is on the sensitive deny list,
 *                   old_value/new_value are wholesale-replaced with the
 *                   REDACTED_SENTINEL (mirrors the pre-existing behaviour).
 *
 *   2. REGEX-BASED — for non-sensitive rows, old_value / new_value strings
 *                    are scrubbed of credential-shaped substrings.
 *
 *   3. change_reason is always passed through redactSecretLikeStrings,
 *      regardless of whether field_changed is sensitive, because it is
 *      free-form prose on every row.
 *
 * The test asserts the new behaviour, that clean rows are NOT spuriously
 * UPDATEd, that a second pass is a no-op (idempotency), and that both
 * nc_change_history and capa_change_history are handled (the sweep is
 * table-name parameterised and exercised against both).
 *
 * Run:  npx tsx tests/changeHistorySweep.test.ts
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

interface RowState {
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

function makeStubClient(initialRows: RowState[], expectedTable: string): {
  client: { query: (sql: string, params?: ReadonlyArray<unknown>) => Promise<any> };
  updates: CapturedUpdate[];
  rows: RowState[];
} {
  const rows: RowState[] = initialRows.map(r => ({ ...r }));
  rows.sort((a, b) => a.id - b.id);
  const updates: CapturedUpdate[] = [];

  const tableRegex = new RegExp(`\\b${expectedTable}\\b`);

  const query = async (sql: string, params: ReadonlyArray<unknown> = []) => {
    if (/^\s*SELECT/i.test(sql)) {
      if (!tableRegex.test(sql)) {
        throw new Error(`SELECT issued against unexpected table:\n${sql}`);
      }
      // Honour the keyset-pagination contract so we can also test the
      // cursor-advance path implicitly (the sweep MUST move forward).
      const cursor = Number(params[0] ?? 0);
      const limit = Number(params[1] ?? rows.length);
      const page = rows
        .filter(r => r.id > cursor)
        .slice(0, limit)
        .map(r => ({ ...r }));
      return { rows: page, rowCount: page.length };
    }
    if (/^\s*UPDATE/i.test(sql)) {
      if (!tableRegex.test(sql)) {
        throw new Error(`UPDATE issued against unexpected table:\n${sql}`);
      }
      updates.push({ sql, params });
      const id = Number(params[3]);
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

  return { client: { query }, updates, rows };
}

const SK_KEY = '<REDACTED_SECRET>';
const GHP_TOKEN = '<REDACTED_SECRET>';
const JWT =
  '<REDACTED_TOKEN>';
const BCRYPT = '<REDACTED_PASSWORD_HASH>';

async function runSweepFor(tableName: 'nc_change_history' | 'capa_change_history'): Promise<void> {
  console.log(`\n[redactChangeHistoryTable] ${tableName} (Task #249)\n`);

  const initial: RowState[] = [
    // 1. Sensitive field with a raw secret in the old/new TEXT — the legacy
    //    behaviour already covered this path. Must STILL replace with sentinel.
    {
      id: 1,
      field_changed: 'api_key',
      old_value: SK_KEY,
      new_value: `rotated-${SK_KEY}`,
      change_reason: 'Quarterly key rotation',
    },
    // 2. Sensitive field that's already been sentinel-replaced — must not be
    //    spuriously re-UPDATEd, but a non-redacted change_reason should still
    //    trigger an update if it carries a credential substring (no credential
    //    here, so this row should be skipped entirely).
    {
      id: 2,
      field_changed: 'password_hash',
      old_value: REDACTED_SENTINEL,
      new_value: REDACTED_SENTINEL,
      change_reason: 'Password reset on request',
    },
    // 3. NON-sensitive field whose old_value/new_value contain interpolated
    //    credential-shaped substrings. The pre-Task-#249 sweep ignored these.
    //    Now they MUST be scrubbed in-place (preserving surrounding prose).
    {
      id: 3,
      field_changed: 'description',
      old_value: `Was using ${SK_KEY} for billing`,
      new_value: `Now using ${GHP_TOKEN} for billing`,
      change_reason: 'Migration from PaymentProvider to SourceControlProvider deploy keys',
    },
    // 4. NON-sensitive field, totally clean → no UPDATE.
    {
      id: 4,
      field_changed: 'status',
      old_value: 'open',
      new_value: 'closed',
      change_reason: null,
    },
    // 5. NON-sensitive field, but change_reason itself contains a JWT and a
    //    bcrypt hash. The sweep MUST scrub change_reason regardless of
    //    field_changed sensitivity.
    {
      id: 5,
      field_changed: 'priority',
      old_value: 'medium',
      new_value: 'high',
      change_reason: `Escalated by ${JWT}; admin pwd hash is ${BCRYPT}`,
    },
    // 6. Sensitive field whose change_reason ALSO embeds a credential — must
    //    blanket-redact old/new AND scrub change_reason in the SAME UPDATE.
    {
      id: 6,
      field_changed: 'access_token',
      old_value: 'old-token-was-here',
      new_value: 'new-token-was-here',
      change_reason: `Replaced via PAT ${GHP_TOKEN}`,
    },
    // 7. NULL old_value / new_value on a non-sensitive field with a clean
    //    change_reason → no UPDATE (defends against stray UPDATEs on
    //    not-yet-set fields).
    {
      id: 7,
      field_changed: 'note',
      old_value: null,
      new_value: 'first note',
      change_reason: 'Initial entry',
    },
  ];

  const stub1 = makeStubClient(initial, tableName);
  const result1 = await redactChangeHistoryTable(stub1.client as any, tableName);

  // Expected dirty rows: 1 (sensitive raw), 3 (regex prose), 5 (regex reason),
  // 6 (sensitive + reason). Rows 2, 4, 7 stay clean → 4 updates. Task #294
  // changed the return shape from `number` to `ChangeHistorySweepResult` so
  // the caller can surface the change_reason scrub count separately in the
  // audit-log entry; we now read `rowsUpdated` for the dirty-row total.
  assert(
    result1.rowsUpdated === 4,
    `${tableName}: 4 dirty rows updated (got ${result1.rowsUpdated})`,
  );
  assert(
    stub1.updates.length === 4,
    `${tableName}: 4 UPDATE statements issued (got ${stub1.updates.length})`,
  );
  // Rows 5 and 6 each scrubbed change_reason → 2 reported separately.
  assert(
    result1.changeReasonUpdated === 2,
    `${tableName}: 2 change_reason scrubs reported (got ${result1.changeReasonUpdated})`,
  );

  const row1 = stub1.rows.find(r => r.id === 1)!;
  assert(
    row1.old_value === REDACTED_SENTINEL && row1.new_value === REDACTED_SENTINEL,
    `${tableName} row 1: sensitive field old/new both replaced with sentinel`,
  );
  assert(
    row1.change_reason === 'Quarterly key rotation',
    `${tableName} row 1: clean change_reason preserved verbatim`,
  );

  const row2 = stub1.rows.find(r => r.id === 2)!;
  assert(
    row2.old_value === REDACTED_SENTINEL &&
      row2.new_value === REDACTED_SENTINEL &&
      row2.change_reason === 'Password reset on request',
    `${tableName} row 2: already-sentinel + clean reason → no spurious UPDATE`,
  );

  const row3 = stub1.rows.find(r => r.id === 3)!;
  assert(
    !row3.old_value!.includes(SK_KEY) && row3.old_value!.includes(REDACTED_SENTINEL),
    `${tableName} row 3: sk_ key removed from old_value, prose preserved`,
  );
  assert(
    row3.old_value!.startsWith('Was using '),
    `${tableName} row 3: surrounding prose preserved in old_value`,
  );
  assert(
    !row3.new_value!.includes(GHP_TOKEN) && row3.new_value!.includes(REDACTED_SENTINEL),
    `${tableName} row 3: ghp_ token removed from new_value, prose preserved`,
  );

  const row4 = stub1.rows.find(r => r.id === 4)!;
  assert(
    row4.old_value === 'open' &&
      row4.new_value === 'closed' &&
      row4.change_reason === null,
    `${tableName} row 4: clean non-sensitive row untouched`,
  );

  const row5 = stub1.rows.find(r => r.id === 5)!;
  assert(
    row5.old_value === 'medium' && row5.new_value === 'high',
    `${tableName} row 5: non-sensitive old/new preserved verbatim`,
  );
  assert(
    !row5.change_reason!.includes(JWT) && !row5.change_reason!.includes(BCRYPT),
    `${tableName} row 5: JWT and bcrypt removed from change_reason`,
  );
  assert(
    row5.change_reason!.includes(REDACTED_SENTINEL),
    `${tableName} row 5: sentinel present in change_reason`,
  );

  const row6 = stub1.rows.find(r => r.id === 6)!;
  assert(
    row6.old_value === REDACTED_SENTINEL && row6.new_value === REDACTED_SENTINEL,
    `${tableName} row 6: sensitive field old/new both blanket-redacted`,
  );
  assert(
    !row6.change_reason!.includes(GHP_TOKEN) &&
      row6.change_reason!.includes(REDACTED_SENTINEL),
    `${tableName} row 6: change_reason ALSO scrubbed in same UPDATE`,
  );

  const row7 = stub1.rows.find(r => r.id === 7)!;
  assert(
    row7.old_value === null &&
      row7.new_value === 'first note' &&
      row7.change_reason === 'Initial entry',
    `${tableName} row 7: NULL/clean row left alone`,
  );

  // ------ Idempotency ------
  console.log(`\n  --- Idempotency check on ${tableName} ---\n`);
  const stub2 = makeStubClient(stub1.rows, tableName);
  const result2 = await redactChangeHistoryTable(stub2.client as any, tableName);
  assert(
    result2.rowsUpdated === 0,
    `${tableName}: second pass updates 0 rows (got ${result2.rowsUpdated}) — idempotent`,
  );
  assert(
    result2.changeReasonUpdated === 0,
    `${tableName}: second pass reports 0 change_reason scrubs (got ${result2.changeReasonUpdated})`,
  );
  assert(
    stub2.updates.length === 0,
    `${tableName}: second pass issues no UPDATE statements`,
  );
}

async function runEmptyTableCheck(): Promise<void> {
  console.log('\n[redactChangeHistoryTable] empty table (Task #249)\n');

  const stub = makeStubClient([], 'nc_change_history');
  const result = await redactChangeHistoryTable(stub.client as any, 'nc_change_history');
  assert(result.rowsUpdated === 0, 'empty nc_change_history: 0 rows updated');
  assert(
    result.changeReasonUpdated === 0,
    'empty nc_change_history: 0 change_reason scrubs',
  );
  assert(stub.updates.length === 0, 'empty nc_change_history: no UPDATE issued');
}

async function runPaginationCheck(): Promise<void> {
  console.log('\n[redactChangeHistoryTable] keyset pagination (Task #249 / #289)\n');

  // 30 rows, batch size 8 → 4 pages (8/8/8/6). Every 5th row is dirty so
  // the cursor MUST advance through skipped rows or the sweep loops.
  const TOTAL = 30;
  const BATCH = 8;
  const rows: RowState[] = Array.from({ length: TOTAL }, (_, i) => ({
    id: i + 1,
    field_changed: 'description',
    old_value: i % 5 === 0 ? `Old key ${SK_KEY}` : 'clean prose',
    new_value: 'unchanged',
    change_reason: null,
  }));

  const stub = makeStubClient(rows, 'capa_change_history');
  const result = await redactChangeHistoryTable(
    stub.client as any,
    'capa_change_history',
    BATCH,
  );

  const expectedDirty = Math.ceil(TOTAL / 5);
  assert(
    result.rowsUpdated === expectedDirty,
    `paginated capa: ${expectedDirty} dirty rows updated (got ${result.rowsUpdated})`,
  );
  assert(
    stub.rows.every(r => !String(r.old_value).includes(SK_KEY)),
    'paginated capa: no row still contains the leaked sk-… key',
  );
}

async function run(): Promise<void> {
  await runSweepFor('nc_change_history');
  await runSweepFor('capa_change_history');
  await runEmptyTableCheck();
  await runPaginationCheck();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error(
      '\n❌ changeHistorySweep tests FAILED — historical secrets may still be present in nc/capa_change_history.',
    );
    process.exit(1);
  }
  console.log('\n✅ All changeHistorySweep tests passed');
}

run().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
