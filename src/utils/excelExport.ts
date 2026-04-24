/**
 * Shared Excel/XLSX and CSV export utilities built on ExcelJS.
 *
 * Design goals:
 *  - Streaming-first: both helpers pipe directly to a Web-API ReadableStream
 *    so the Node.js process RSS never grows linearly with total row count.
 *  - Row sources are accepted as plain arrays OR AsyncIterables so callers
 *    can feed rows from a DB cursor without materialising the full result set.
 *  - Multi-sheet XLSX with a declarative SheetSpec API.
 *
 * Engineering SOP rules (§25):
 *   ALL new export endpoints MUST use `streamXlsx` or `streamCsv`.
 *   Never use `buildWorkbook` + `c.body(buf)` for new endpoints.
 *   For DB-backed exports, prefer `cursorQuery` (server-side cursor, O(n)) over
 *   the deprecated `pagedQuery` (LIMIT/OFFSET, O(n²)).
 */
import ExcelJS from "exceljs";
import { PassThrough } from "stream";

// ---------------------------------------------------------------------------
// Typed shim for ExcelJS streaming WorkbookWriter
// The streaming classes are not re-exported in the official @types/exceljs
// declarations, so we declare minimal local interfaces here to avoid `any`.
// ---------------------------------------------------------------------------

/** Subset of ExcelJS.Cell properties needed by the streaming header row. */
interface _StreamCell {
  font?: Partial<ExcelJS.Font>;
  fill?: Partial<ExcelJS.Fill>;
  alignment?: Partial<ExcelJS.Alignment>;
  border?: Partial<ExcelJS.Borders>;
}

interface _StreamRow {
  height: number;
  eachCell(cb: (cell: _StreamCell) => void): void;
  commit(): void;
}

interface _StreamWorksheet {
  columns: Array<{ header: string; key: string; width: number; style?: object }>;
  getRow(rowNumber: number): _StreamRow;
  addRow(values: Record<string, unknown>): { commit(): void };
  commit(): Promise<void>;
}

interface _StreamWorkbook {
  creator: string;
  title: string;
  addWorksheet(name: string, options?: object): _StreamWorksheet;
  commit(): Promise<void>;
}

interface _ExcelJSWithStream {
  stream: {
    xlsx: {
      WorkbookWriter: new (opts: {
        stream: PassThrough;
        useStyles?: boolean;
        useSharedStrings?: boolean;
      }) => _StreamWorkbook;
    };
  };
}

export interface ColumnSpec {
  header: string;
  key: string;
  width?: number;
}

/** A sheet in an XLSX export.  `rows` may be a plain array or an AsyncIterable. */
export interface SheetSpec {
  name: string;
  columns: ColumnSpec[];
  /** Plain array or AsyncIterable — the helper consumes with `for await`. */
  rows: Record<string, any>[] | AsyncIterable<Record<string, any>>;
  freezeHeader?: boolean;
}

const HEADER_STYLE: Partial<ExcelJS.Style> = {
  font: { bold: true, color: { argb: "FFFFFFFF" }, size: 11 },
  fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } },
  alignment: { vertical: "middle", horizontal: "left", wrapText: true },
  border: {
    top:    { style: "thin", color: { argb: "FFE5E7EB" } },
    bottom: { style: "thin", color: { argb: "FFE5E7EB" } },
    left:   { style: "thin", color: { argb: "FFE5E7EB" } },
    right:  { style: "thin", color: { argb: "FFE5E7EB" } },
  },
};

/** Sanitise a sheet name to meet Excel's 31-char / special-char limits. */
function uniquifyNames() {
  const usedNames = new Set<string>();
  return (raw: string): string => {
    const base = (raw || "Sheet").replace(/[\\/?*\[\]:]/g, "_").substring(0, 31) || "Sheet";
    if (!usedNames.has(base)) { usedNames.add(base); return base; }
    for (let i = 2; i < 1000; i++) {
      const suffix = `_${i}`;
      const candidate = base.substring(0, 31 - suffix.length) + suffix;
      if (!usedNames.has(candidate)) { usedNames.add(candidate); return candidate; }
    }
    const fallback = `Sheet_${usedNames.size + 1}`;
    usedNames.add(fallback);
    return fallback;
  };
}

function autoSize(ws: ExcelJS.Worksheet, columns: ColumnSpec[]) {
  columns.forEach((col, idx) => {
    if (col.width) {
      ws.getColumn(idx + 1).width = col.width;
      return;
    }
    let max = String(col.header).length;
    ws.getColumn(idx + 1).eachCell({ includeEmpty: false }, (cell, row) => {
      if (row === 1) return;
      const v = cell.value == null ? "" : String(cell.value);
      if (v.length > max) max = v.length;
    });
    ws.getColumn(idx + 1).width = Math.min(Math.max(max + 2, 10), 60);
  });
}

// ---------------------------------------------------------------------------
// Paged-query async generator — LIMIT/OFFSET fallback (deprecated for new code)
// ---------------------------------------------------------------------------

/**
 * Hard upper bound on the number of pages a single export may stream.
 * Defends against:
 *   - misbehaving queries that never stop returning full pages (e.g. an
 *     ORDER BY over a column with a duplicate-row infinite-scroll bug)
 *   - LIMIT/OFFSET drift if the underlying table mutates mid-export
 *
 * At pageSize = 500 this caps a single export at 500 × 50 000 = 25 000 000
 * rows, which is well above any realistic legitimate export size for the
 * tables we serve (event_logs, duplicate_records, enterprise_risks) and
 * comfortably below anything that could OOM a 512 MB worker.
 *
 * Override via env EXPORT_MAX_PAGES if a future bulk-archive use case
 * legitimately needs more.
 */
const PAGED_QUERY_MAX_PAGES_DEFAULT = 50_000;

function pagedQueryMaxPages(): number {
  // Read at call time (not module load) so tests / ops can override via env
  // without restarting the worker.
  const raw = process.env.EXPORT_MAX_PAGES;
  if (raw === undefined || raw === "") return PAGED_QUERY_MAX_PAGES_DEFAULT;
  const n = parseInt(raw, 10);
  // Reject NaN, negatives, and zero — any of these would silently disable
  // the cap (`pagesFetched >= NaN` is always false).
  if (!Number.isFinite(n) || n <= 0) return PAGED_QUERY_MAX_PAGES_DEFAULT;
  return n;
}

/**
 * @deprecated Prefer `cursorQuery` (server-side Postgres cursor). LIMIT/OFFSET
 * pagination is O(n²) total — page N forces Postgres to scan N×pageSize rows
 * before discarding the offset, so the last page of a 500 000-row export
 * re-scans the whole table. `cursorQuery` is O(n) total.
 *
 * Kept exported because it remains the simplest mockable streaming source for
 * unit tests that don't want to spin up a Postgres connection. Still safe for
 * small (< a few thousand rows) exports.
 */
export async function* pagedQuery<T = Record<string, unknown>>(
  queryFn: (limit: number, offset: number) => Promise<{ rows: T[] }>,
  pageSize = 500
): AsyncGenerator<T> {
  const maxPages = pagedQueryMaxPages();
  let offset = 0;
  let pagesFetched = 0;
  while (true) {
    if (pagesFetched >= maxPages) {
      throw new Error(
        `pagedQuery: refusing to stream more than ${maxPages} pages ` +
        `(${maxPages * pageSize} rows at pageSize=${pageSize}). ` +
        `If this is a legitimate large export, raise EXPORT_MAX_PAGES.`
      );
    }
    const { rows } = await queryFn(pageSize, offset);
    pagesFetched++;
    for (const row of rows) yield row;
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
}

// ---------------------------------------------------------------------------
// Server-side cursor — true O(n) streaming via pg-query-stream
// ---------------------------------------------------------------------------

/**
 * Hard upper bound on rows a single cursor-based export may stream.
 *
 * Mirrors the equivalent guard rail from `pagedQuery` (50 000 pages × 500 rows
 * = 25 000 000 rows) — well above any realistic export size for the tables we
 * serve (event_logs, duplicate_records, enterprise_risks) and comfortably
 * below anything that could OOM a 512 MB worker.
 *
 * Cursors don't suffer from LIMIT/OFFSET drift, but the cap still defends
 * against accidentally streaming a huge join result through the worker.
 *
 * Override via env EXPORT_MAX_ROWS for legitimate bulk-archive use cases.
 */
const CURSOR_QUERY_MAX_ROWS_DEFAULT = 25_000_000;

function cursorQueryMaxRows(): number {
  // Read at call time (not module load) so tests / ops can override via env
  // without restarting the worker.
  const raw = process.env.EXPORT_MAX_ROWS;
  if (raw === undefined || raw === "") return CURSOR_QUERY_MAX_ROWS_DEFAULT;
  const n = parseInt(raw, 10);
  // Reject NaN, negatives, and zero — any of these would silently disable
  // the cap (`rowsYielded >= NaN` is always false).
  if (!Number.isFinite(n) || n <= 0) return CURSOR_QUERY_MAX_ROWS_DEFAULT;
  return n;
}

/** Minimal subset of `pg.PoolClient` used by `cursorQuery`. */
export interface CursorPoolClient {
  query(stream: unknown): AsyncIterable<unknown> & { destroy?(err?: Error): void };
  release(err?: unknown): void;
}

/** Minimal subset of `pg.Pool` used by `cursorQuery`. */
export interface CursorPool {
  connect(): Promise<CursorPoolClient>;
}

/** Test-only seam to inject a fake QueryStream constructor. */
export interface CursorQueryDeps {
  QueryStream?: new (
    sql: string,
    params: unknown[],
    opts?: { batchSize?: number }
  ) => unknown;
}

/**
 * Streams rows from a Postgres server-side cursor using `pg-query-stream`.
 *
 * Drop-in replacement for `pagedQuery`. The call shape changes from
 *
 *   pagedQuery((limit, offset) => pool.query(
 *     `SELECT ... ORDER BY id LIMIT $1 OFFSET $2`, [limit, offset]
 *   ))
 *
 * to
 *
 *   cursorQuery(pool, `SELECT ... ORDER BY id`, [])
 *
 * Why this matters:
 *   - LIMIT/OFFSET pagination is O(n²) total cost: page N forces Postgres to
 *     scan N×pageSize rows then discard the offset. A 500 000-row export at
 *     pageSize 500 makes the last page re-scan the entire table.
 *   - A server-side cursor (FETCH FORWARD batchSize FROM <cursor>) is O(n)
 *     total: every row is read exactly once. RSS stays O(batchSize) on both
 *     client and server because rows are produced as they're requested.
 *
 * The pool client is acquired lazily before the stream opens and released in
 * the generator's `finally` block, which fires on full consumption, early
 * `break` in the consumer, or thrown errors. If an error tore down the
 * stream, the client is released *with the error* so the pool destroys it
 * rather than returning a poisoned connection to the pool.
 *
 * @param pool       pg.Pool (or any object with `connect()`)
 * @param sql        SELECT statement WITHOUT trailing LIMIT/OFFSET
 * @param params     Parameters bound to $1, $2, ... in `sql`
 * @param options.batchSize  Rows fetched per FETCH from the cursor (default 500)
 * @param options.maxRows    Hard cap on rows yielded — defaults to env
 *                           EXPORT_MAX_ROWS or 25 000 000
 * @param options._deps      Test-only injection of pg-query-stream constructor
 */
export async function* cursorQuery<T = Record<string, unknown>>(
  pool: CursorPool,
  sql: string,
  params: unknown[] = [],
  options: { batchSize?: number; maxRows?: number; _deps?: CursorQueryDeps } = {}
): AsyncGenerator<T> {
  const batchSize = options.batchSize ?? 500;
  const maxRows = options.maxRows ?? cursorQueryMaxRows();

  let QueryStreamCtor = options._deps?.QueryStream;
  if (!QueryStreamCtor) {
    // pg-query-stream uses `export = QueryStream`; under Node's ESM interop the
    // dynamic-import namespace exposes the constructor at `.default` (with the
    // CJS module value as a fallback for bundler shapes that drop `.default`).
    type QueryStreamModule = typeof import("pg-query-stream");
    type QueryStreamCtorT = NonNullable<CursorQueryDeps["QueryStream"]>;
    const mod = (await import("pg-query-stream")) as QueryStreamModule & {
      default?: QueryStreamCtorT;
    };
    QueryStreamCtor = (mod.default ?? (mod as unknown as QueryStreamCtorT));
  }

  const client = await pool.connect();
  let rowsYielded = 0;
  let releaseErr: unknown;
  try {
    const stream = client.query(new QueryStreamCtor!(sql, params, { batchSize }));
    try {
      for await (const row of stream as AsyncIterable<T>) {
        if (rowsYielded >= maxRows) {
          // Tear down the cursor immediately rather than draining it before
          // surfacing the cap error.
          if (typeof (stream as { destroy?: (err?: Error) => void }).destroy === "function") {
            try { (stream as { destroy: (err?: Error) => void }).destroy(); } catch { /* noop */ }
          }
          throw new Error(
            `cursorQuery: refusing to stream more than ${maxRows} rows. ` +
            `If this is a legitimate large export, raise EXPORT_MAX_ROWS.`
          );
        }
        rowsYielded++;
        yield row;
      }
    } catch (err) {
      releaseErr = err;
      throw err;
    }
  } finally {
    // Pass any error to release() so pg destroys (rather than recycles) the
    // client. A cursor that errored mid-stream may leave the connection in a
    // state that's unsafe to reuse.
    client.release(releaseErr as Error | undefined);
  }
}

// ---------------------------------------------------------------------------
// Legacy buffer builder — kept only for small, bounded result sets (< 1 000 rows)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use `streamXlsx` for all new exports.
 */
export async function buildWorkbook(
  sheets: Array<{ name: string; columns: ColumnSpec[]; rows: Record<string, any>[]; freezeHeader?: boolean }>,
  meta?: { creator?: string; title?: string }
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = meta?.creator || "WalaPlus GRC Platform";
  wb.created = new Date();
  if (meta?.title) wb.title = meta.title;

  const uniquify = uniquifyNames();

  for (const sheet of sheets) {
    const safeName = uniquify(sheet.name);
    const ws = wb.addWorksheet(safeName, {
      views: sheet.freezeHeader === false ? [] : [{ state: "frozen", ySplit: 1 }],
    });
    ws.columns = sheet.columns.map(c => ({ header: c.header, key: c.key, width: c.width }));

    const headerRow = ws.getRow(1);
    headerRow.eachCell(cell => Object.assign(cell, HEADER_STYLE));
    headerRow.height = 22;

    if (sheet.rows.length) ws.addRows(sheet.rows);
    autoSize(ws, sheet.columns);
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}

export function xlsxResponseHeaders(filename: string): Record<string, string> {
  return {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${filename}"`,
  };
}

// ---------------------------------------------------------------------------
// Streaming helpers
// ---------------------------------------------------------------------------

/**
 * Stream an XLSX workbook directly to the HTTP response using ExcelJS streaming
 * WorkbookWriter.  Committed rows are flushed to the ZIP stream immediately and
 * never held in the Node.js heap a second time.
 *
 * The `rows` field of each SheetSpec may be:
 *   - A plain array (full result already in memory), or
 *   - An AsyncIterable (e.g. a pg QueryStream cursor) for O(1)-RSS streaming.
 *
 * Usage in a Hono route:
 *   return await streamXlsx(sheets, `export_${Date.now()}.xlsx`, { title: 'My Export' });
 */
export async function streamXlsx(
  sheets: SheetSpec[],
  filename: string,
  meta?: { creator?: string; title?: string }
): Promise<Response> {
  const pass = new PassThrough();

  const { WorkbookWriter } = (ExcelJS as unknown as _ExcelJSWithStream).stream.xlsx;
  const wb = new WorkbookWriter({
    stream: pass,
    useStyles: true,
    // useSharedStrings deliberately disabled: the shared-string table is
    // accumulated in memory for the full workbook lifetime, which grows
    // linearly with unique string count and defeats O(1)-RSS streaming
    // for high-cardinality exports (> 50 k rows).
    useSharedStrings: false,
  });

  if (meta?.creator) wb.creator = meta.creator;
  if (meta?.title)   wb.title   = meta.title;

  const uniquify = uniquifyNames();

  (async () => {
    try {
      for (const sheet of sheets) {
        const safeName = uniquify(sheet.name);
        const ws = wb.addWorksheet(safeName, {
          views: sheet.freezeHeader === false ? [] : [{ state: "frozen", ySplit: 1 }],
        });

        ws.columns = sheet.columns.map(c => ({
          header: c.header,
          key:    c.key,
          width:  c.width ?? Math.min(Math.max(String(c.header).length + 2, 10), 60),
          style:  { alignment: { wrapText: false } },
        }));

        const headerRow = ws.getRow(1);
        headerRow.height = 22;
        headerRow.eachCell((cell: _StreamCell) => {
          cell.font      = HEADER_STYLE.font;
          cell.fill      = HEADER_STYLE.fill;
          cell.alignment = HEADER_STYLE.alignment;
          cell.border    = HEADER_STYLE.border;
        });
        headerRow.commit();

        for await (const rowData of sheet.rows) {
          const r = ws.addRow(rowData);
          r.commit();
        }

        await ws.commit();
      }
      await wb.commit();
    } catch (err) {
      pass.destroy(err as Error);
    }
  })();

  const webStream = new ReadableStream({
    start(controller) {
      pass.on("data",  (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
      pass.on("end",   ()              => controller.close());
      pass.on("error", (err: Error)    => controller.error(err));
    },
    cancel() { pass.destroy(); },
  });

  return new Response(webStream, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

/**
 * Stream a CSV response directly to the HTTP client.
 *
 * The `rows` parameter may be:
 *   - `string[][]`  — plain array (already in memory), pulled in chunks, or
 *   - `AsyncIterable<string[]>` — e.g. from a DB cursor; rows are pushed into
 *     the stream controller as they arrive, keeping RSS flat.
 *
 * Usage in a Hono route:
 *   return streamCsv(`risks_${Date.now()}.csv`, ['ID','Title'], escapedRows);
 */
export function streamCsv(
  filename: string,
  headers: string[],
  rows: string[][] | AsyncIterable<string[]>,
  chunkSize = 1000
): Response {
  const headerLine = headers.join(",") + "\n";

  let stream: ReadableStream<string>;

  if (Array.isArray(rows)) {
    // ── Synchronous array path: emit in chunks via pull() ──
    const arr = rows;
    let cursor = 0;
    stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(headerLine);
      },
      pull(controller) {
        const batch = arr.slice(cursor, cursor + chunkSize);
        cursor += chunkSize;
        if (batch.length > 0) {
          controller.enqueue(batch.map(r => r.join(",")).join("\n") + "\n");
        }
        if (cursor >= arr.length) {
          controller.close();
        }
      },
    });
  } else {
    // ── AsyncIterable path: consume from iterator in start() ──
    stream = new ReadableStream<string>({
      async start(controller) {
        try {
          controller.enqueue(headerLine);
          let buf: string[] = [];
          for await (const row of rows) {
            buf.push(row.join(","));
            if (buf.length >= chunkSize) {
              controller.enqueue(buf.join("\n") + "\n");
              buf = [];
            }
          }
          if (buf.length > 0) {
            controller.enqueue(buf.join("\n") + "\n");
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
    });
  }

  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
