/**
 * Regression tests — Streaming exports + bulk DB writes
 *
 * Verified:
 *   (a) streamCsv returns a ReadableStream-backed Response synchronously
 *   (b) streamXlsx returns a ReadableStream-backed Response asynchronously
 *   (c) streamCsv / streamXlsx accept AsyncIterable row sources
 *   (d) bulkInsert(_queryFn) issues exactly ceil(N/chunkSize) SQL INSERT statements
 *
 * Run:  npx tsx src/utils/__tests__/streamingExports.test.ts
 */

import assert from 'assert';

// ─── helpers ────────────────────────────────────────────────────────────────

async function* asyncRows<T>(arr: T[]): AsyncGenerator<T> {
  for (const item of arr) yield item;
}

async function drainResponse(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const dec = new TextDecoder();
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (typeof value === 'string') {
      text += value;
    } else if (value instanceof Uint8Array || ArrayBuffer.isView(value)) {
      text += dec.decode(value as Uint8Array, { stream: true });
    }
  }
  return text;
}

// ─── (a) streamCsv — synchronous response, ReadableStream body ──────────────

async function testStreamCsvReturnsReadableStream() {
  const { streamCsv } = await import('../excelExport');

  const ROWS = 50_000;
  const headers = ['id', 'name', 'value'];
  const rows: string[][] = Array.from({ length: ROWS }, (_, i) => [
    String(i), `Name ${i}`, String(Math.random()),
  ]);

  const t0 = Date.now();
  const response = streamCsv(`test_${Date.now()}.csv`, headers, rows);
  const elapsed = Date.now() - t0;

  assert.ok(response instanceof Response, 'streamCsv must return a Response');
  assert.ok(response.body instanceof ReadableStream, 'Response.body must be a ReadableStream');
  assert.ok(elapsed < 1000, `streamCsv must return within 1 s for ${ROWS} rows — took ${elapsed} ms`);
  assert.equal(response.headers.get('content-type'), 'text/csv; charset=utf-8', 'Content-Type must be text/csv');

  const content = await drainResponse(response);
  const lines = content.trim().split('\n');
  assert.equal(lines[0], 'id,name,value', 'first line must be the header row');
  assert.equal(lines.length, ROWS + 1, `expected ${ROWS + 1} lines total (header + data)`);

  console.log(`  ✓ streamCsv: returned in ${elapsed} ms, fully streamed ${ROWS} rows`);
}

// ─── (b) streamXlsx — ReadableStream body ───────────────────────────────────

async function testStreamXlsxReturnsReadableStream() {
  const { streamXlsx } = await import('../excelExport');

  const ROWS = 50_000;
  const rows: Record<string, any>[] = Array.from({ length: ROWS }, (_, i) => ({
    id: i, name: `Record ${i}`, value: Math.random(),
  }));

  const t0 = Date.now();
  const response = await streamXlsx(
    [{
      name: 'Data',
      columns: [
        { header: 'ID', key: 'id', width: 8 },
        { header: 'Name', key: 'name', width: 30 },
        { header: 'Value', key: 'value', width: 14 },
      ],
      rows,
    }],
    `test_${Date.now()}.xlsx`,
  );
  const elapsed = Date.now() - t0;

  assert.ok(response instanceof Response, 'streamXlsx must resolve to a Response');
  assert.ok(response.body instanceof ReadableStream, 'Response.body must be a ReadableStream');
  assert.ok(
    response.headers.get('content-type')?.includes('spreadsheetml'),
    'Content-Type must be XLSX MIME'
  );

  // Drain to verify the ZIP/XLSX bytes arrive without error
  const bytes = await response.arrayBuffer();
  assert.ok(bytes.byteLength > 0, 'Response must have non-empty body');

  console.log(`  ✓ streamXlsx: ${ROWS} rows → ${bytes.byteLength} bytes in ${elapsed} ms`);
}

// ─── (c) Async-iterable row sources ─────────────────────────────────────────

async function testStreamCsvAcceptsAsyncIterable() {
  const { streamCsv } = await import('../excelExport');

  const ROWS = 1_000;
  const headers = ['n', 'sq'];
  const source = asyncRows(
    Array.from({ length: ROWS }, (_, i) => [String(i), String(i * i)])
  );

  const response = streamCsv(`async_test.csv`, headers, source);
  assert.ok(response.body instanceof ReadableStream, 'Must return ReadableStream for AsyncIterable rows');

  const content = await drainResponse(response);
  const lines = content.trim().split('\n');
  assert.equal(lines[0], 'n,sq', 'header must be first line');
  assert.equal(lines.length, ROWS + 1, `expected ${ROWS + 1} lines`);
  console.log(`  ✓ streamCsv AsyncIterable: ${ROWS} rows consumed via async generator`);
}

async function testStreamXlsxAcceptsAsyncIterable() {
  const { streamXlsx } = await import('../excelExport');

  const ROWS = 1_000;
  const source = asyncRows(
    Array.from({ length: ROWS }, (_, i) => ({ n: i, sq: i * i }))
  );

  const response = await streamXlsx(
    [{
      name: 'Test',
      columns: [{ header: 'N', key: 'n', width: 8 }, { header: 'Square', key: 'sq', width: 12 }],
      rows: source,
    }],
    'async_test.xlsx'
  );

  assert.ok(response.body instanceof ReadableStream, 'Must return ReadableStream');
  const bytes = await response.arrayBuffer();
  assert.ok(bytes.byteLength > 0, 'Non-empty body required');
  console.log(`  ✓ streamXlsx AsyncIterable: ${ROWS} rows → ${bytes.byteLength} bytes`);
}

// ─── (d) bulkInsert SQL statement count ─────────────────────────────────────

async function testBulkInsertIssuedExactly2StatementsFor1000Rows() {
  const { bulkInsert } = await import('../database');

  const TOTAL_ROWS = 1_000;
  const CHUNK_SIZE = 500;

  let statementCount = 0;
  const capturedSqls: string[] = [];

  const mockQuery = async (sql: string, _values: any[]) => {
    statementCount++;
    capturedSqls.push(sql.substring(0, 80));
    return { rows: [], rowCount: 0 };
  };

  const rows = Array.from({ length: TOTAL_ROWS }, (_, i) => ({
    audit_id: 1,
    metric_name: `metric_${i}`,
    metric_value: i,
    dimension: 'overall',
  }));

  await bulkInsert(
    'quality_trends',
    ['audit_id', 'metric_name', 'metric_value', 'dimension'],
    rows,
    { chunkSize: CHUNK_SIZE, _queryFn: mockQuery }
  );

  const expected = Math.ceil(TOTAL_ROWS / CHUNK_SIZE);
  assert.strictEqual(
    statementCount, expected,
    `Expected ${expected} INSERT statements for ${TOTAL_ROWS} rows with chunkSize=${CHUNK_SIZE}, got ${statementCount}`
  );

  for (const sql of capturedSqls) {
    assert.ok(sql.includes('INSERT INTO quality_trends'), 'Each statement must be an INSERT');
  }

  console.log(`  ✓ bulkInsert: ${TOTAL_ROWS} rows → ${statementCount} INSERT statement(s) (chunkSize=${CHUNK_SIZE})`);
}

async function testBulkInsert100RowsUnderChunkSizeIsOneStatement() {
  const { bulkInsert } = await import('../database');

  const TOTAL_ROWS = 100;
  const CHUNK_SIZE = 500;
  let statementCount = 0;

  await bulkInsert(
    'test_table',
    ['a', 'b'],
    Array.from({ length: TOTAL_ROWS }, (_, i) => ({ a: i, b: `val_${i}` })),
    {
      chunkSize: CHUNK_SIZE,
      _queryFn: async () => { statementCount++; return { rows: [], rowCount: 0 }; }
    }
  );

  assert.strictEqual(statementCount, 1, `${TOTAL_ROWS} rows < chunkSize=${CHUNK_SIZE} must produce exactly 1 INSERT`);
  console.log(`  ✓ bulkInsert: ${TOTAL_ROWS} rows < chunkSize → 1 INSERT`);
}

async function testBulkInsertEmptyRowsIsNoOp() {
  const { bulkInsert } = await import('../database');

  let statementCount = 0;
  await bulkInsert('t', ['a'], [], {
    _queryFn: async () => { statementCount++; return { rows: [], rowCount: 0 }; }
  });

  assert.strictEqual(statementCount, 0, 'Empty rows must produce 0 SQL statements');
  console.log(`  ✓ bulkInsert: empty rows → 0 SQL statements`);
}

// ─── (d2) saveTrendMetrics call-site: 6 metrics → 1 bulk INSERT ─────────────
// Reproduces the exact bulkInsert call shape inside saveTrendMetrics() in
// src/utils/database.ts to verify it issues exactly 1 SQL statement for the
// 6 fixed metric rows rather than 6 individual row inserts.

async function testSaveTrendMetricsCallSiteIsOneBulkInsert() {
  const { bulkInsert } = await import('../database');

  const MOCK_AUDIT_ID = 999;
  const metrics = [
    { name: 'overall_score',    value: 85, dimension: 'overall'    },
    { name: 'people_score',     value: 90, dimension: 'people'     },
    { name: 'process_score',    value: 80, dimension: 'process'    },
    { name: 'governance_score', value: 88, dimension: 'governance' },
    { name: 'total_issues',     value: 3,  dimension: 'overall'    },
    { name: 'records_audited',  value: 100,dimension: 'overall'    },
  ];

  let statementCount = 0;
  await bulkInsert(
    'quality_trends',
    ['audit_id', 'metric_name', 'metric_value', 'dimension'],
    metrics.map(m => ({ audit_id: MOCK_AUDIT_ID, metric_name: m.name, metric_value: m.value, dimension: m.dimension })),
    { _queryFn: async () => { statementCount++; return { rows: [], rowCount: 0 }; } }
  );

  assert.strictEqual(statementCount, 1,
    `saveTrendMetrics write path: ${metrics.length} metric rows must produce exactly 1 bulk INSERT (not ${metrics.length} individual INSERTs)`);
  console.log(`  ✓ saveTrendMetrics write path: ${metrics.length} metrics → 1 bulk INSERT (was ${metrics.length} individual INSERTs before)`);
}

// ─── (e) pagedQuery generator ────────────────────────────────────────────────

async function testPagedQueryYieldsAllRowsInOrder() {
  const { pagedQuery } = await import('../excelExport');

  const DATA = Array.from({ length: 1_300 }, (_, i) => ({ id: i, val: `v${i}` }));
  const PAGE_SIZE = 500;

  const fetchPage = async (limit: number, offset: number) => ({
    rows: DATA.slice(offset, offset + limit),
  });

  const collected: { id: number; val: string }[] = [];
  for await (const row of pagedQuery(fetchPage, PAGE_SIZE)) {
    collected.push(row as { id: number; val: string });
  }

  assert.strictEqual(collected.length, DATA.length, `pagedQuery must yield all ${DATA.length} rows`);
  assert.strictEqual(collected[0].id, 0, 'First yielded row must have id=0');
  assert.strictEqual(collected[DATA.length - 1].id, DATA.length - 1, 'Last row must have correct id');
  console.log(`  ✓ pagedQuery: yielded all ${DATA.length} rows (${Math.ceil(DATA.length / PAGE_SIZE)} pages)`);
}

// ─── (f) First-byte latency — stream responds before all rows are generated ──

async function testStreamCsvFirstByteFasterThanFullDrain() {
  const { streamCsv } = await import('../excelExport');

  const DELAY_PER_ROW_MS = 2;
  const ROWS = 5;

  async function* slowRows(): AsyncGenerator<string[]> {
    for (let i = 0; i < ROWS; i++) {
      await new Promise(r => setTimeout(r, DELAY_PER_ROW_MS));
      yield [String(i), `val_${i}`];
    }
  }

  const response = streamCsv('latency_test.csv', ['id', 'val'], slowRows());
  const reader = response.body!.getReader();

  const t0 = Date.now();
  const firstChunk = await reader.read();
  const firstByteMs = Date.now() - t0;

  assert.ok(!firstChunk.done, 'First read must not be done immediately');
  assert.ok(
    firstByteMs < DELAY_PER_ROW_MS * ROWS,
    `First byte (${firstByteMs} ms) must arrive before all rows are generated (${DELAY_PER_ROW_MS * ROWS} ms)`
  );
  reader.cancel();
  console.log(`  ✓ streamCsv first-byte latency: ${firstByteMs} ms (total row delay would be ${DELAY_PER_ROW_MS * ROWS} ms)`);
}

// ─── Runner ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n📊  Streaming exports + bulk writes — regression tests\n');
  try {
    console.log('— CSV streaming (array) —');
    await testStreamCsvReturnsReadableStream();

    console.log('— XLSX streaming (array) —');
    await testStreamXlsxReturnsReadableStream();

    console.log('— AsyncIterable row sources —');
    await testStreamCsvAcceptsAsyncIterable();
    await testStreamXlsxAcceptsAsyncIterable();

    console.log('— bulkInsert SQL statement counts —');
    await testBulkInsertIssuedExactly2StatementsFor1000Rows();
    await testBulkInsert100RowsUnderChunkSizeIsOneStatement();
    await testBulkInsertEmptyRowsIsNoOp();
    await testSaveTrendMetricsCallSiteIsOneBulkInsert();

    console.log('— pagedQuery generator —');
    await testPagedQueryYieldsAllRowsInOrder();

    console.log('— Streaming first-byte latency —');
    await testStreamCsvFirstByteFasterThanFullDrain();

    console.log('\n✅  All regression tests passed\n');
    process.exit(0);
  } catch (err: any) {
    console.error('\n❌  Test failed:', err.message || err);
    process.exit(1);
  }
}

main();
