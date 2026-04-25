/**
 * Unit tests for Task #100 — historical event_logs description/entity_name sweep.
 *
 * Verifies that `redactEventLogs()` in `src/utils/redactHistoricalLogs.ts`:
 *   - Applies `redactSecretLikeStrings` to `description` and `entity_name` TEXT columns
 *   - Applies `deepRedactSecretLikeStrings` (on top of `redactSensitiveFields`) to JSONB columns
 *   - Leaves clean rows untouched (no spurious UPDATEs)
 *   - Is idempotent on a second pass
 *
 * Run:  npx tsx tests/eventLogDescriptionSweep.test.ts
 */

import { redactEventLogs } from '../src/utils/redactHistoricalLogs';
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
  description: string | null;
  entity_name: string | null;
  old_value: any | null;
  new_value: any | null;
}

interface CapturedUpdate {
  sql: string;
  params: ReadonlyArray<unknown>;
}

function makeStubClient(initialRows: RowState[]): {
  client: { query: (sql: string, params?: ReadonlyArray<unknown>) => Promise<any> };
  updates: CapturedUpdate[];
  rows: RowState[];
} {
  const rows: RowState[] = initialRows.map(r => ({
    ...r,
    old_value: r.old_value === null ? null : structuredClone(r.old_value),
    new_value: r.new_value === null ? null : structuredClone(r.new_value),
  }));
  const updates: CapturedUpdate[] = [];

  const query = async (sql: string, params: ReadonlyArray<unknown> = []) => {
    if (/^\s*SELECT/i.test(sql)) {
      return { rows: rows.map(r => ({ ...r })), rowCount: rows.length };
    }
    if (/^\s*UPDATE\s+event_logs/i.test(sql)) {
      updates.push({ sql, params });
      const id = params[4] as number;
      const target = rows.find(r => r.id === id);
      if (target) {
        target.description = params[0] as string | null;
        target.entity_name = params[1] as string | null;
        target.old_value = params[2] != null ? JSON.parse(String(params[2])) : null;
        target.new_value = params[3] != null ? JSON.parse(String(params[3])) : null;
      }
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };

  return { client: { query }, updates, rows };
}

const SK_KEY = 'sk-live-LEAKED_HISTORICAL_KEY_ABCDEFGHIJKLMNOP';
const GHP_TOKEN = 'ghp_leakedHistoricalToken1234567890abcdef';
const JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI5OTk5OTkifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const BCRYPT = '$2b$12$abcdefghijklmnopqrstuv1234567890ABCDEFGHIJKLMNOPQRSTU';
const SAFE_PROSE = 'User updated project settings for tenant acme-corp';

async function run(): Promise<void> {
  console.log('\n[redactEventLogs] description & entity_name sweep (Task #100)\n');

  const initial: RowState[] = [
    {
      id: 1,
      description: `Rotated Stripe key to ${SK_KEY} for finance team`,
      entity_name: `Stripe config (key=${SK_TOKEN_SHORT(SK_KEY)})`,
      old_value: null,
      new_value: null,
    },
    {
      id: 2,
      description: `GitHub PAT issued: ${GHP_TOKEN}`,
      entity_name: 'GitHub integration',
      old_value: null,
      new_value: null,
    },
    {
      id: 3,
      description: `JWT minted: ${JWT}; bcrypt hash: ${BCRYPT}`,
      entity_name: 'Auth service',
      old_value: null,
      new_value: null,
    },
    {
      id: 4,
      description: SAFE_PROSE,
      entity_name: 'Project acme-corp',
      old_value: null,
      new_value: null,
    },
    {
      id: 5,
      description: `Already clean — key=${REDACTED_SENTINEL}`,
      entity_name: 'Clean entity',
      old_value: null,
      new_value: null,
    },
    {
      id: 6,
      description: 'Integration sync run',
      entity_name: 'Sync service',
      old_value: { summary: `previous key was ${SK_KEY}`, count: 3 },
      new_value: { note: `token: ${GHP_TOKEN}`, status: 'ok' },
    },
    {
      id: 7,
      description: 'Key-deny-list match in JSONB',
      entity_name: 'Auth module',
      old_value: { api_key: SK_KEY, module: 'auth' },
      new_value: null,
    },
  ];

  const stub1 = makeStubClient(initial);
  const count1 = await redactEventLogs(stub1.client);

  assert(count1 === 5, `5 dirty rows updated (got ${count1})`);
  assert(stub1.updates.length === 5, `5 UPDATE statements issued (got ${stub1.updates.length})`);

  const row1 = stub1.rows.find(r => r.id === 1)!;
  assert(
    !row1.description!.includes(SK_KEY),
    'row 1: sk_ key removed from description',
  );
  assert(
    row1.description!.includes(REDACTED_SENTINEL),
    'row 1: sentinel present in description',
  );
  assert(
    row1.description!.includes('Rotated Stripe key'),
    'row 1: surrounding prose preserved in description',
  );

  const row2 = stub1.rows.find(r => r.id === 2)!;
  assert(
    !row2.description!.includes(GHP_TOKEN),
    'row 2: ghp_ token removed from description',
  );
  assert(
    row2.description!.includes(REDACTED_SENTINEL),
    'row 2: sentinel present in description',
  );
  assert(
    row2.entity_name === 'GitHub integration',
    'row 2: clean entity_name is untouched',
  );

  const row3 = stub1.rows.find(r => r.id === 3)!;
  assert(
    !row3.description!.includes(JWT) && !row3.description!.includes(BCRYPT),
    'row 3: JWT and bcrypt removed from description',
  );
  assert(
    row3.description!.includes(REDACTED_SENTINEL),
    'row 3: sentinel present in description',
  );

  const row4 = stub1.rows.find(r => r.id === 4)!;
  assert(
    row4.description === SAFE_PROSE,
    'row 4 (clean): description untouched — no spurious UPDATE',
  );

  const row5 = stub1.rows.find(r => r.id === 5)!;
  assert(
    row5.description === `Already clean — key=${REDACTED_SENTINEL}`,
    'row 5 (already-redacted): description byte-identical — no spurious UPDATE',
  );

  const row6 = stub1.rows.find(r => r.id === 6)!;
  assert(
    row6.old_value && !JSON.stringify(row6.old_value).includes(SK_KEY),
    'row 6: sk_ key removed from old_value JSON leaf (deepRedact)',
  );
  assert(
    row6.new_value && !JSON.stringify(row6.new_value).includes(GHP_TOKEN),
    'row 6: ghp_ token removed from new_value JSON leaf (deepRedact)',
  );
  assert(
    row6.old_value && row6.old_value.count === 3,
    'row 6: numeric leaf preserved in old_value',
  );
  assert(
    row6.new_value && row6.new_value.status === 'ok',
    'row 6: non-secret string leaf preserved in new_value',
  );

  const row7 = stub1.rows.find(r => r.id === 7)!;
  assert(
    row7.old_value && row7.old_value.api_key === REDACTED_SENTINEL,
    'row 7: key-deny-list (api_key) still redacted in old_value',
  );
  assert(
    row7.old_value && row7.old_value.module === 'auth',
    'row 7: non-sensitive key preserved in old_value',
  );

  console.log('\n--- Idempotency check ---\n');

  const stub2 = makeStubClient(stub1.rows);
  const count2 = await redactEventLogs(stub2.client);

  assert(count2 === 0, `second pass updates 0 rows (got ${count2}) — idempotent`);
  assert(stub2.updates.length === 0, 'second pass issues no UPDATE statements');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

function SK_TOKEN_SHORT(key: string): string {
  return key.slice(0, 12) + '…';
}

run().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
