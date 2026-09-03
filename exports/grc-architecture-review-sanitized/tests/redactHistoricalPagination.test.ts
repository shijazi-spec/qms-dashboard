/**
 * Memory-pressure regression test for Task #289.
 *
 * Verifies that all four sweep entry-points in
 * `src/utils/redactHistoricalLogs.ts` iterate the source table in
 * keyset-paginated batches rather than one bulk SELECT. The stub
 * client honours the `WHERE id > $1 ORDER BY id LIMIT $2` predicates
 * exactly as Postgres would, so a sweep that forgot to advance the
 * cursor (or that fetched everything in one shot) would either loop
 * forever or fail the page-count assertion.
 *
 * Run:  npx tsx tests/redactHistoricalPagination.test.ts
 */

import {
  redactEventLogs,
  redactAiPendingActions,
} from '../src/utils/redactHistoricalLogs';

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

interface KeysetStub<TRow> {
  query: (sql: string, params?: ReadonlyArray<unknown>) => Promise<any>;
  selectCalls: number;
  updateCalls: number;
  pageSizes: number[];
  rows: TRow[];
}

/**
 * Build a stub client that respects keyset pagination semantics:
 * `SELECT … WHERE id > $1 ORDER BY id ASC LIMIT $2` returns at most
 * $2 rows whose ids are strictly greater than $1, in ascending order.
 * Any sweep that issues a non-paginated SELECT (no WHERE / no LIMIT)
 * will trip the assertion below and fail the test loudly instead of
 * silently passing.
 */
function buildKeysetStub<TRow extends { id: number }>(
  initialRows: TRow[],
  selectColumnList: RegExp,
  updateTablePattern: RegExp,
  applyUpdate: (row: TRow, params: ReadonlyArray<unknown>) => void,
): KeysetStub<TRow> {
  const rows = initialRows.map(r => ({ ...r }));
  rows.sort((a, b) => a.id - b.id);

  const stub: KeysetStub<TRow> = {
    selectCalls: 0,
    updateCalls: 0,
    pageSizes: [],
    rows,
    async query(sql: string, params: ReadonlyArray<unknown> = []) {
      if (selectColumnList.test(sql)) {
        if (!/WHERE\s+id\s*>\s*\$1/i.test(sql) || !/LIMIT\s+\$2/i.test(sql)) {
          throw new Error(
            `Sweep issued a non-paginated SELECT — keyset cursor missing:\n${sql}`,
          );
        }
        const cursor = Number(params[0]);
        const limit = Number(params[1]);
        const page = rows
          .filter(r => r.id > cursor)
          .slice(0, limit)
          .map(r => ({ ...r }));
        stub.selectCalls++;
        stub.pageSizes.push(page.length);
        return { rows: page, rowCount: page.length };
      }

      if (updateTablePattern.test(sql)) {
        stub.updateCalls++;
        const id = Number(params[params.length - 1]);
        const target = rows.find(r => r.id === id);
        if (target) applyUpdate(target, params);
        return { rows: [], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    },
  };

  return stub;
}

async function run(): Promise<void> {
  console.log('\n[redactHistoricalLogs] keyset pagination (Task #289)\n');

  // ---------------------------------------------------------------------
  // 1. event_logs: 1 200 rows, batch size 250 → 5 pages, last page short.
  // ---------------------------------------------------------------------
  {
    const TOTAL = 1200;
    const BATCH = 250;
    const SK_KEY = '<REDACTED_TOKEN>';

    interface ELRow {
      id: number;
      description: string | null;
      entity_name: string | null;
      old_value: any;
      new_value: any;
    }

    const rows: ELRow[] = Array.from({ length: TOTAL }, (_, i) => ({
      id: i + 1,
      // Make every 3rd row dirty so we cover both the "update" and
      // "skip" branches under pagination.
      description: i % 3 === 0 ? `Rotated key ${SK_KEY}` : 'clean prose',
      entity_name: 'event source',
      old_value: null,
      new_value: null,
    }));

    const stub = buildKeysetStub<ELRow>(
      rows,
      /SELECT\s+id,\s*description,\s*entity_name/i,
      /^\s*UPDATE\s+event_logs/i,
      (row, params) => {
        row.description = params[0] as string | null;
        row.entity_name = params[1] as string | null;
      },
    );

    const updated = (await redactEventLogs(stub as any, BATCH)).rowsUpdated;

    const expectedDirty = Math.ceil(TOTAL / 3);
    const expectedFullPages = Math.floor(TOTAL / BATCH);
    const lastPageSize = TOTAL - expectedFullPages * BATCH;
    const expectedSelectCalls =
      expectedFullPages + (lastPageSize > 0 ? 1 : 0);

    assert(
      updated === expectedDirty,
      `event_logs: ${expectedDirty} dirty rows updated (got ${updated})`,
    );
    assert(
      stub.updateCalls === expectedDirty,
      `event_logs: ${expectedDirty} UPDATE statements issued (got ${stub.updateCalls})`,
    );
    assert(
      stub.selectCalls === expectedSelectCalls,
      `event_logs: ${expectedSelectCalls} paged SELECTs issued (got ${stub.selectCalls})`,
    );
    assert(
      stub.pageSizes.every(n => n <= BATCH),
      `event_logs: every page <= batch size ${BATCH}`,
    );
    assert(
      stub.pageSizes[stub.pageSizes.length - 1] === lastPageSize,
      `event_logs: final page contains ${lastPageSize} rows`,
    );
    assert(
      stub.rows.every(r => !String(r.description).includes(SK_KEY)),
      'event_logs: no row still contains the leaked sk-… key after sweep',
    );
  }

  // ---------------------------------------------------------------------
  // 2. ai_pending_actions: 50 rows, batch size 7 → 8 pages, last page = 1.
  //    Verifies cursor advances even when batch size doesn't divide total
  //    evenly, and that idempotent re-runs over the same paginated dataset
  //    perform 0 updates.
  // ---------------------------------------------------------------------
  {
    const TOTAL = 50;
    const BATCH = 7;
    const GHP = '<REDACTED_TOKEN>';

    interface AiRow {
      id: number;
      payload: any;
      payload_preview: string | null;
      execution_result: any;
    }

    const rows: AiRow[] = Array.from({ length: TOTAL }, (_, i) => ({
      id: i + 1,
      payload: null,
      payload_preview:
        i % 2 === 0 ? `GH deploy with token=${GHP}` : 'no secret here',
      execution_result: null,
    }));

    const stub = buildKeysetStub<AiRow>(
      rows,
      /SELECT\s+id,\s*payload,\s*payload_preview/i,
      /^\s*UPDATE\s+ai_pending_actions/i,
      (row, params) => {
        row.payload = params[0] != null ? JSON.parse(String(params[0])) : null;
        row.payload_preview = params[1] as string | null;
        row.execution_result =
          params[2] != null ? JSON.parse(String(params[2])) : null;
      },
    );

    const result = await redactAiPendingActions(stub as any, BATCH);

    const expectedDirty = Math.ceil(TOTAL / 2);
    const expectedSelectCalls = Math.ceil(TOTAL / BATCH);

    assert(
      result.scanned === TOTAL,
      `ai_pending_actions: scanned ${TOTAL} rows (got ${result.scanned})`,
    );
    assert(
      result.previewChanged === expectedDirty,
      `ai_pending_actions: ${expectedDirty} previews rewritten (got ${result.previewChanged})`,
    );
    assert(
      result.rowsUpdated === expectedDirty,
      `ai_pending_actions: ${expectedDirty} rows updated (got ${result.rowsUpdated})`,
    );
    assert(
      stub.selectCalls === expectedSelectCalls,
      `ai_pending_actions: ${expectedSelectCalls} paged SELECTs issued (got ${stub.selectCalls})`,
    );
    assert(
      stub.pageSizes.every(n => n <= BATCH),
      `ai_pending_actions: every page <= batch size ${BATCH}`,
    );
    assert(
      stub.rows.every(r => !String(r.payload_preview).includes(GHP)),
      'ai_pending_actions: no row still contains the leaked ghp_… token',
    );

    // Idempotency under pagination: a second pass over the now-clean
    // dataset must perform 0 updates and still issue the full set of
    // paginated SELECTs (the cursor still has to walk the table).
    const stub2 = buildKeysetStub<AiRow>(
      stub.rows,
      /SELECT\s+id,\s*payload,\s*payload_preview/i,
      /^\s*UPDATE\s+ai_pending_actions/i,
      () => {},
    );
    const result2 = await redactAiPendingActions(stub2 as any, BATCH);

    assert(
      result2.rowsUpdated === 0,
      `ai_pending_actions: idempotent second pass updates 0 rows (got ${result2.rowsUpdated})`,
    );
    assert(
      stub2.selectCalls === expectedSelectCalls,
      `ai_pending_actions: idempotent second pass still walks ${expectedSelectCalls} pages`,
    );
  }

  // ---------------------------------------------------------------------
  // 3. Empty table — single SELECT returns nothing, sweep exits cleanly.
  // ---------------------------------------------------------------------
  {
    const stub = buildKeysetStub<{ id: number }>(
      [],
      /SELECT\s+id,\s*description/i,
      /^\s*UPDATE\s+event_logs/i,
      () => {},
    );
    const updated = (await redactEventLogs(stub as any, 250)).rowsUpdated;
    assert(updated === 0, 'empty event_logs: 0 rows updated');
    assert(
      stub.selectCalls === 1,
      `empty event_logs: exactly 1 SELECT issued (got ${stub.selectCalls})`,
    );
    assert(stub.updateCalls === 0, 'empty event_logs: no UPDATE issued');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error(
      '\n❌ redactHistoricalPagination tests FAILED — keyset pagination may be broken.',
    );
    process.exit(1);
  }
  console.log('\n✅ All redactHistoricalPagination tests passed');
}

run().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
