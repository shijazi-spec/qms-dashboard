/**
 * Unit tests for Task #294 — extend the historical NC/CAPA change-history sweep
 * to cover `change_reason` and free-form `old_value`/`new_value` columns where
 * `field_changed` is NOT on the key-based deny list.
 *
 * Verifies that `redactChangeHistoryTable()` in
 * `src/utils/redactHistoricalLogs.ts`:
 *   - Wipes both value columns to REDACTED_SENTINEL when `field_changed` is
 *     a sensitive key name (preserved behaviour from before #294).
 *   - Regex-scrubs `old_value` and `new_value` for rows whose `field_changed`
 *     is NOT on the deny list (e.g. description, notes), leaving non-secret
 *     prose byte-identical.
 *   - Regex-scrubs `change_reason` for every row regardless of field_changed.
 *   - Reports `changeReasonUpdated` separately from `rowsUpdated`.
 *   - Skips rows where the redacted text is byte-identical to the stored text.
 *   - Is idempotent on a second pass.
 *
 * Run:  npx tsx tests/changeHistorySweepBackfill.test.ts
 */

import {
  redactChangeHistoryTable,
  type ChangeHistorySweepResult,
} from "../src/utils/redactHistoricalLogs";
import { REDACTED_SENTINEL } from "../src/utils/eventLogsDatabase";

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

interface Row {
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

function makeStubClient(initialRows: Row[]): {
  client: {
    query: (sql: string, params?: ReadonlyArray<unknown>) => Promise<any>;
  };
  updates: CapturedUpdate[];
  rows: Row[];
} {
  const rows: Row[] = initialRows.map((r) => ({ ...r }));
  rows.sort((a, b) => a.id - b.id);
  const updates: CapturedUpdate[] = [];

  const query = async (sql: string, params: ReadonlyArray<unknown> = []) => {
    if (/^\s*SELECT/i.test(sql)) {
      // Keyset pagination: WHERE id > $1 ORDER BY id ASC LIMIT $2
      const cursor = Number(params[0]);
      const limit = Number(params[1]);
      const page = rows
        .filter((r) => r.id > cursor)
        .slice(0, limit)
        .map((r) => ({ ...r }));
      return { rows: page, rowCount: page.length };
    }
    if (/^\s*UPDATE\s+/i.test(sql)) {
      updates.push({ sql, params });
      const id = params[3] as number;
      const target = rows.find((r) => r.id === id);
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

const SK_KEY = "sk-live-LEAKED_CHANGE_HISTORY_KEY_ABCDEFGHIJK";
const GHP_TOKEN = "ghp_leakedChangeHistoryToken1234567890abcdef";
const JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI1NTU1NTUifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const SAFE_PROSE = "Updated supplier corrective-action plan after audit";

async function run(): Promise<void> {
  console.log(
    "\n[redactChangeHistoryTable] change_reason + non-sensitive value sweep (Task #294)\n",
  );

  const initial: Row[] = [
    // 1. Sensitive field name → both value columns wiped to sentinel.
    {
      id: 1,
      field_changed: "api_key",
      old_value: "old-key-value",
      new_value: "new-key-value",
      change_reason: "Rotated quarterly",
    },
    // 2. Sensitive field, change_reason itself contains a leaked credential.
    {
      id: 2,
      field_changed: "password_hash",
      old_value: "hash-A",
      new_value: "hash-B",
      change_reason: `Operator pasted token=${GHP_TOKEN} into the note`,
    },
    // 3. Non-sensitive field name → regex-scrub free-form values.
    {
      id: 3,
      field_changed: "description",
      old_value: "no secret here",
      new_value: `Pasted Stripe key ${SK_KEY} for invoice #42`,
      change_reason: "Updated description",
    },
    // 4. Non-sensitive field, both value columns contain credentials.
    {
      id: 4,
      field_changed: "notes",
      old_value: `Old JWT: ${JWT}`,
      new_value: `Replacement key ${SK_KEY}`,
      change_reason: null,
    },
    // 5. Fully clean row → no UPDATE expected.
    {
      id: 5,
      field_changed: "status",
      old_value: "OPEN",
      new_value: "CLOSED",
      change_reason: SAFE_PROSE,
    },
    // 6. Clean values but change_reason leaks a token.
    {
      id: 6,
      field_changed: "priority",
      old_value: "P3",
      new_value: "P1",
      change_reason: `Bumped after seeing GHPAT ${GHP_TOKEN} in the alert`,
    },
    // 7. Already-redacted sensitive row → idempotent skip.
    {
      id: 7,
      field_changed: "secret_token",
      old_value: REDACTED_SENTINEL,
      new_value: REDACTED_SENTINEL,
      change_reason: "Previously scrubbed",
    },
    // 8. Null values + null change_reason → no UPDATE expected.
    {
      id: 8,
      field_changed: "description",
      old_value: null,
      new_value: null,
      change_reason: null,
    },
  ];

  const stub1 = makeStubClient(initial);
  const result1: ChangeHistorySweepResult = await redactChangeHistoryTable(
    stub1.client as any,
    "nc_change_history",
  );

  // ----- Counters -----
  // Dirty rows (got updated): 1, 2, 3, 4, 6.  Row 5 clean. Row 7 already
  // sentinel. Row 8 null/null/null.
  assert(
    result1.rowsUpdated === 5,
    `5 rows updated (got ${result1.rowsUpdated})`,
  );
  // change_reason scrubs: rows 2 and 6.
  assert(
    result1.changeReasonUpdated === 2,
    `2 change_reason scrubs (got ${result1.changeReasonUpdated})`,
  );
  assert(
    stub1.updates.length === 5,
    `5 UPDATE statements issued (got ${stub1.updates.length})`,
  );
  assert(
    stub1.updates.every((u) => /UPDATE\s+nc_change_history/i.test(u.sql)),
    "every UPDATE targets the nc_change_history table",
  );

  // ----- Row 1: sensitive field → both columns sentinel; clean reason kept -----
  const r1 = stub1.rows.find((r) => r.id === 1)!;
  assert(
    r1.old_value === REDACTED_SENTINEL,
    "row 1: old_value wiped to sentinel",
  );
  assert(
    r1.new_value === REDACTED_SENTINEL,
    "row 1: new_value wiped to sentinel",
  );
  assert(
    r1.change_reason === "Rotated quarterly",
    "row 1: clean change_reason preserved",
  );

  // ----- Row 2: sensitive field + leaked reason -----
  const r2 = stub1.rows.find((r) => r.id === 2)!;
  assert(
    r2.old_value === REDACTED_SENTINEL,
    "row 2: old_value wiped to sentinel",
  );
  assert(
    r2.new_value === REDACTED_SENTINEL,
    "row 2: new_value wiped to sentinel",
  );
  assert(
    r2.change_reason !== null && !r2.change_reason.includes(GHP_TOKEN),
    "row 2: ghp_ token removed from change_reason",
  );
  assert(
    r2.change_reason !== null && r2.change_reason.includes(REDACTED_SENTINEL),
    "row 2: sentinel present in scrubbed change_reason",
  );
  assert(
    r2.change_reason !== null &&
      r2.change_reason.startsWith("Operator pasted token="),
    "row 2: surrounding prose preserved in change_reason",
  );

  // ----- Row 3: non-sensitive field, only new_value dirty -----
  const r3 = stub1.rows.find((r) => r.id === 3)!;
  assert(r3.old_value === "no secret here", "row 3: clean old_value untouched");
  assert(
    r3.new_value !== null && !r3.new_value.includes(SK_KEY),
    "row 3: sk_ key removed from new_value",
  );
  assert(
    r3.new_value !== null && r3.new_value.includes(REDACTED_SENTINEL),
    "row 3: sentinel present in new_value",
  );
  assert(
    r3.new_value !== null && r3.new_value.startsWith("Pasted Stripe key"),
    "row 3: surrounding prose preserved in new_value",
  );
  assert(
    r3.change_reason === "Updated description",
    "row 3: clean change_reason preserved",
  );

  // ----- Row 4: non-sensitive field, both columns dirty, no reason -----
  const r4 = stub1.rows.find((r) => r.id === 4)!;
  assert(
    r4.old_value !== null && !r4.old_value.includes(JWT),
    "row 4: JWT removed from old_value",
  );
  assert(
    r4.new_value !== null && !r4.new_value.includes(SK_KEY),
    "row 4: sk_ key removed from new_value",
  );
  assert(
    r4.old_value !== null && r4.old_value.includes(REDACTED_SENTINEL),
    "row 4: sentinel present in scrubbed old_value",
  );
  assert(r4.change_reason === null, "row 4: null change_reason stays null");

  // ----- Row 5: fully clean → no UPDATE -----
  const r5 = stub1.rows.find((r) => r.id === 5)!;
  assert(r5.old_value === "OPEN", "row 5: clean old_value untouched");
  assert(r5.new_value === "CLOSED", "row 5: clean new_value untouched");
  assert(
    r5.change_reason === SAFE_PROSE,
    "row 5: clean change_reason untouched",
  );
  assert(
    !stub1.updates.some((u) => u.params[3] === 5),
    "row 5: no UPDATE statement issued (no spurious write)",
  );

  // ----- Row 6: clean values, dirty reason → only reason scrubbed -----
  const r6 = stub1.rows.find((r) => r.id === 6)!;
  assert(r6.old_value === "P3", "row 6: clean old_value preserved");
  assert(r6.new_value === "P1", "row 6: clean new_value preserved");
  assert(
    r6.change_reason !== null && !r6.change_reason.includes(GHP_TOKEN),
    "row 6: ghp_ token removed from change_reason",
  );
  assert(
    r6.change_reason !== null && r6.change_reason.includes(REDACTED_SENTINEL),
    "row 6: sentinel present in scrubbed change_reason",
  );

  // ----- Row 7: already redacted → no UPDATE -----
  const r7 = stub1.rows.find((r) => r.id === 7)!;
  assert(r7.old_value === REDACTED_SENTINEL, "row 7: old_value still sentinel");
  assert(r7.new_value === REDACTED_SENTINEL, "row 7: new_value still sentinel");
  assert(
    !stub1.updates.some((u) => u.params[3] === 7),
    "row 7: already-redacted sensitive row skipped (no UPDATE)",
  );

  // ----- Row 8: all-null row → no UPDATE -----
  assert(
    !stub1.updates.some((u) => u.params[3] === 8),
    "row 8: all-null row skipped (no UPDATE)",
  );

  // ----- Idempotency: rerun on now-clean snapshot must perform 0 updates -----
  console.log("\n--- Idempotency check ---\n");
  const stub2 = makeStubClient(stub1.rows);
  const result2 = await redactChangeHistoryTable(
    stub2.client as any,
    "nc_change_history",
  );
  assert(
    result2.rowsUpdated === 0,
    `second pass updates 0 rows (got ${result2.rowsUpdated}) — idempotent`,
  );
  assert(
    result2.changeReasonUpdated === 0,
    `second pass reports 0 change_reason scrubs (got ${result2.changeReasonUpdated})`,
  );
  assert(stub2.updates.length === 0, "second pass issues no UPDATE statements");

  // ----- Table-name parameter is honoured for capa_change_history too -----
  console.log("\n--- capa_change_history dispatch ---\n");
  const capaStub = makeStubClient([
    {
      id: 1,
      field_changed: "description",
      old_value: `leaked ${SK_KEY}`,
      new_value: "safe",
      change_reason: null,
    },
  ]);
  const capaResult = await redactChangeHistoryTable(
    capaStub.client as any,
    "capa_change_history",
  );
  assert(capaResult.rowsUpdated === 1, "capa: 1 row updated");
  assert(
    capaStub.updates.length === 1 &&
      /UPDATE\s+capa_change_history/i.test(capaStub.updates[0].sql),
    "capa: UPDATE targets capa_change_history table",
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error("\n❌ changeHistorySweepBackfill tests FAILED");
    process.exit(1);
  }
  console.log("\n✅ All changeHistorySweepBackfill tests passed");
}

run().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
