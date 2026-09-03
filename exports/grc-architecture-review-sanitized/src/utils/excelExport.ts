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
import { createHash, randomBytes } from "crypto";
import { promises as fsPromises, createReadStream } from "fs";
import * as path from "path";
import * as os from "os";

import { logger } from "./logger";
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
  columns: Array<{
    header: string;
    key: string;
    width: number;
    style?: object;
  }>;
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
  /**
   * If true, the worksheet renders right-to-left (Excel `rightToLeft` view
   * property). Use for Arabic / Hebrew / other RTL locales so the column
   * order and selection arrows mirror the document direction.
   */
  rightToLeft?: boolean;
}

const HEADER_STYLE: Partial<ExcelJS.Style> = {
  font: { bold: true, color: { argb: "FFFFFFFF" }, size: 11 },
  fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } },
  alignment: { vertical: "middle", horizontal: "left", wrapText: true },
  border: {
    top: { style: "thin", color: { argb: "FFE5E7EB" } },
    bottom: { style: "thin", color: { argb: "FFE5E7EB" } },
    left: { style: "thin", color: { argb: "FFE5E7EB" } },
    right: { style: "thin", color: { argb: "FFE5E7EB" } },
  },
};

/** Sanitise a sheet name to meet Excel's 31-char / special-char limits. */
function uniquifyNames() {
  const usedNames = new Set<string>();
  return (raw: string): string => {
    const base =
      (raw || "Sheet").replace(/[\\/?*\[\]:]/g, "_").substring(0, 31) ||
      "Sheet";
    if (!usedNames.has(base)) {
      usedNames.add(base);
      return base;
    }
    for (let i = 2; i < 1000; i++) {
      const suffix = `_${i}`;
      const candidate = base.substring(0, 31 - suffix.length) + suffix;
      if (!usedNames.has(candidate)) {
        usedNames.add(candidate);
        return candidate;
      }
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
  pageSize = 500,
): AsyncGenerator<T> {
  const maxPages = pagedQueryMaxPages();
  let offset = 0;
  let pagesFetched = 0;
  while (true) {
    if (pagesFetched >= maxPages) {
      throw new Error(
        `pagedQuery: refusing to stream more than ${maxPages} pages ` +
          `(${maxPages * pageSize} rows at pageSize=${pageSize}). ` +
          `If this is a legitimate large export, raise EXPORT_MAX_PAGES.`,
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
  query(
    stream: unknown,
  ): AsyncIterable<unknown> & { destroy?(err?: Error): void };
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
    opts?: { batchSize?: number },
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
  options: {
    batchSize?: number;
    maxRows?: number;
    _deps?: CursorQueryDeps;
  } = {},
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
    const mod = (await import("pg-query-stream")) as unknown as QueryStreamModule & {
      default?: QueryStreamCtorT;
    };
    QueryStreamCtor = mod.default ?? (mod as unknown as QueryStreamCtorT);
  }

  const client = await pool.connect();
  let rowsYielded = 0;
  let releaseErr: unknown;
  try {
    const stream = client.query(
      new QueryStreamCtor!(sql, params, { batchSize }),
    );
    try {
      for await (const row of stream as AsyncIterable<T>) {
        if (rowsYielded >= maxRows) {
          // Tear down the cursor immediately rather than draining it before
          // surfacing the cap error.
          if (
            typeof (stream as { destroy?: (err?: Error) => void }).destroy ===
            "function"
          ) {
            try {
              (stream as { destroy: (err?: Error) => void }).destroy();
            } catch {
              /* noop */
            }
          }
          throw new Error(
            `cursorQuery: refusing to stream more than ${maxRows} rows. ` +
              `If this is a legitimate large export, raise EXPORT_MAX_ROWS.`,
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
  sheets: Array<{
    name: string;
    columns: ColumnSpec[];
    rows: Record<string, any>[];
    freezeHeader?: boolean;
  }>,
  meta?: { creator?: string; title?: string },
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = meta?.creator || "ExampleOrg GRC Platform";
  wb.created = new Date();
  if (meta?.title) wb.title = meta.title;

  const uniquify = uniquifyNames();

  for (const sheet of sheets) {
    const safeName = uniquify(sheet.name);
    const ws = wb.addWorksheet(safeName, {
      views:
        sheet.freezeHeader === false ? [] : [{ state: "frozen", ySplit: 1 }],
    });
    ws.columns = sheet.columns.map((c) => ({
      header: c.header,
      key: c.key,
      width: c.width,
    }));

    const headerRow = ws.getRow(1);
    headerRow.eachCell((cell) => Object.assign(cell, HEADER_STYLE));
    headerRow.height = 22;

    if (sheet.rows.length) ws.addRows(sheet.rows);
    autoSize(ws, sheet.columns);
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}

export function xlsxResponseHeaders(filename: string): Record<string, string> {
  return {
    "Content-Type":
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${filename}"`,
  };
}

// ---------------------------------------------------------------------------
// Range-aware buffered response
// ---------------------------------------------------------------------------

/**
 * Build a weak ETag for a buffered export. We use a cheap fingerprint
 * (size + first/last 8 KB hashed via SHA-1) instead of hashing the whole
 * buffer so we don't pay an O(n) cost on every request just to validate
 * resumes. Weak validators are perfectly adequate here — `If-Range` only
 * needs to detect that the underlying export changed between the original
 * request and the resume.
 */
function weakBufferEtag(buffer: Buffer): string {
  const total = buffer.byteLength;
  const SAMPLE = 8 * 1024;
  const head = buffer.subarray(0, Math.min(SAMPLE, total));
  const tail =
    total > SAMPLE
      ? buffer.subarray(Math.max(0, total - SAMPLE), total)
      : Buffer.alloc(0);
  const h = createHash("sha1");
  h.update(head);
  if (tail.byteLength > 0) h.update(tail);
  return `W/"${total.toString(16)}-${h.digest("hex").substring(0, 16)}"`;
}

/** Minimal subset of the request-headers shape we accept. */
export type RangeRequestHeaders =
  | Headers
  | { get?: (name: string) => string | null | undefined; [k: string]: unknown };

function readReqHeader(
  headers: RangeRequestHeaders,
  name: string,
): string | null {
  if (headers && typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) || null;
  }
  const lower = name.toLowerCase();
  const obj = headers as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === lower) {
      const v = obj[k];
      if (typeof v === "string") return v;
      if (Array.isArray(v) && typeof v[0] === "string") return v[0] as string;
    }
  }
  return null;
}

interface ParsedRange {
  start: number;
  end: number;
}

/**
 * Parse a single-range `Range: bytes=` header against a known total length.
 * Returns null for malformed ranges (caller should ignore and serve full body)
 * and an object with start === -1 to signal "unsatisfiable" (caller should
 * return 416). We only support a single range — that's all the streaming-
 * download helper ever issues.
 */
function parseSingleRange(
  rangeHeader: string,
  total: number,
): ParsedRange | null | "unsatisfiable" {
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(rangeHeader);
  if (!m) return null;
  const startStr = m[1];
  const endStr = m[2];
  if (startStr === "" && endStr === "") return null;
  let start: number;
  let end: number;
  if (startStr === "") {
    // Suffix range: last N bytes.
    const suffixLen = parseInt(endStr, 10);
    if (!Number.isFinite(suffixLen) || suffixLen <= 0) return "unsatisfiable";
    if (total === 0) return "unsatisfiable";
    start = Math.max(0, total - suffixLen);
    end = total - 1;
  } else {
    start = parseInt(startStr, 10);
    if (!Number.isFinite(start) || start < 0) return null;
    if (start >= total) return "unsatisfiable";
    if (endStr === "") {
      end = total - 1;
    } else {
      end = parseInt(endStr, 10);
      if (!Number.isFinite(end) || end < start) return null;
      end = Math.min(end, total - 1);
    }
  }
  return { start, end };
}

export interface BufferedRangeOptions {
  /** Override the auto-computed weak ETag. Useful when a stable identifier
   *  is already available (e.g. a content hash or row count). */
  etag?: string;
  /** Extra response headers to merge (e.g. Cache-Control). */
  extraHeaders?: Record<string, string>;
}

/**
 * Build an HTTP `Response` that serves a Buffer with full HTTP Range support
 * (RFC 7233). Always advertises `Accept-Ranges: bytes` and an ETag so the
 * client-side streaming-download helper can issue `Range: bytes=N-` +
 * `If-Range: <etag>` to resume an interrupted download.
 *
 * Behaviour:
 *   - No Range header           → 200 with full body and `Content-Length`.
 *   - Valid `bytes=N-`/`N-M`/`-N` → 206 with `Content-Range` + sliced body.
 *   - Unsatisfiable range        → 416 with `Content-Range: bytes <empty>/<total>`.
 *   - `If-Range` validator mismatch → ignore Range and return 200 (full body).
 *   - Malformed Range header     → ignore Range and return 200 (per RFC 7233 §3.1).
 */
export function bufferResponseWithRange(
  buffer: Buffer,
  contentType: string,
  filename: string,
  reqHeaders: RangeRequestHeaders,
  options: BufferedRangeOptions = {},
): Response {
  const total = buffer.byteLength;
  const etag = options.etag || weakBufferEtag(buffer);

  const baseHeaders: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Accept-Ranges": "bytes",
    ETag: etag,
    ...(options.extraHeaders || {}),
  };

  const rangeHeader = readReqHeader(reqHeaders, "range");
  const ifRangeHeader = readReqHeader(reqHeaders, "if-range");

  if (!rangeHeader) {
    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: { ...baseHeaders, "Content-Length": String(total) },
    });
  }

  // If-Range: ignore Range when the validator no longer matches the resource.
  // Compare verbatim — both weak and strong validator forms must match exactly
  // for resume to be safe.
  if (ifRangeHeader && ifRangeHeader.trim() !== etag.trim()) {
    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: { ...baseHeaders, "Content-Length": String(total) },
    });
  }

  const parsed = parseSingleRange(rangeHeader, total);
  if (parsed === null) {
    // Malformed Range — RFC 7233 §3.1 says we MUST treat as if Range was absent.
    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: { ...baseHeaders, "Content-Length": String(total) },
    });
  }
  if (parsed === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...baseHeaders, "Content-Range": `bytes */${total}` },
    });
  }

  const { start, end } = parsed;
  const slice = buffer.subarray(start, end + 1);
  return new Response(new Uint8Array(slice), {
    status: 206,
    headers: {
      ...baseHeaders,
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Content-Length": String(slice.byteLength),
    },
  });
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
  meta?: { creator?: string; title?: string },
): Promise<Response> {
  const pass = new PassThrough();

  // The workbook writer below starts running BEFORE the ReadableStream that
  // owns the 'error' listener is constructed — everything up to the first
  // `await` (addWorksheet, the column spec, the header row) is synchronous.
  // If any of that throws, `pass.destroy(err)` emits 'error' on a PassThrough
  // with no listener, and Node treats an unhandled stream 'error' as fatal:
  // the whole process dies, not just the request. Hold the error here and let
  // the ReadableStream report it properly once it exists.
  let earlyError: Error | null = null;
  const captureEarlyError = (err: Error) => {
    earlyError = err;
  };
  pass.on("error", captureEarlyError);

  const { WorkbookWriter } = (ExcelJS as unknown as _ExcelJSWithStream).stream
    .xlsx;
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
  if (meta?.title) wb.title = meta.title;

  const uniquify = uniquifyNames();

  (async () => {
    try {
      for (const sheet of sheets) {
        const safeName = uniquify(sheet.name);
        const baseView: Record<string, unknown> =
          sheet.freezeHeader === false
            ? {}
            : { state: "frozen", ySplit: 1 };
        if (sheet.rightToLeft) baseView.rightToLeft = true;
        const ws = wb.addWorksheet(safeName, {
          views: Object.keys(baseView).length ? [baseView as any] : [],
        });

        ws.columns = sheet.columns.map((c) => ({
          header: c.header,
          key: c.key,
          width:
            c.width ?? Math.min(Math.max(String(c.header).length + 2, 10), 60),
          style: { alignment: { wrapText: false } },
        }));

        const headerRow = ws.getRow(1);
        headerRow.height = 22;
        headerRow.eachCell((cell: _StreamCell) => {
          cell.font = HEADER_STYLE.font;
          cell.fill = HEADER_STYLE.fill;
          cell.alignment = HEADER_STYLE.alignment;
          cell.border = HEADER_STYLE.border;
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
      pass.off("error", captureEarlyError);
      if (earlyError) {
        controller.error(earlyError);
        return;
      }
      pass.on("data", (chunk: Buffer) =>
        controller.enqueue(
          new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
        ),
      );
      pass.on("end", () => controller.close());
      pass.on("error", (err: Error) => controller.error(err));
    },
    cancel() {
      pass.destroy();
    },
  });

  return new Response(webStream, {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
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
  chunkSize = 1000,
): Response {
  const headerLine = headers.join(",") + "\n";
  const encoder = new TextEncoder();

  let stream: ReadableStream<Uint8Array>;

  if (Array.isArray(rows)) {
    // ── Synchronous array path: emit in chunks via pull() ──
    const arr = rows;
    let cursor = 0;
    stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(headerLine));
      },
      pull(controller) {
        const batch = arr.slice(cursor, cursor + chunkSize);
        cursor += chunkSize;
        if (batch.length > 0) {
          controller.enqueue(
            encoder.encode(batch.map((r) => r.join(",")).join("\n") + "\n"),
          );
        }
        if (cursor >= arr.length) {
          controller.close();
        }
      },
    });
  } else {
    // ── AsyncIterable path: consume from iterator in start() ──
    stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          controller.enqueue(encoder.encode(headerLine));
          let buf: string[] = [];
          for await (const row of rows) {
            buf.push(row.join(","));
            if (buf.length >= chunkSize) {
              controller.enqueue(encoder.encode(buf.join("\n") + "\n"));
              buf = [];
            }
          }
          if (buf.length > 0) {
            controller.enqueue(encoder.encode(buf.join("\n") + "\n"));
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

// ---------------------------------------------------------------------------
// Range-aware staging for streaming exports
// ---------------------------------------------------------------------------
//
// `bufferResponseWithRange` only works for already-built buffers. The big
// XLSX/CSV exports use ExcelJS' streaming WorkbookWriter / pg-cursor
// pipelines and have no `Content-Length` up front, so an interrupted
// multi-GB CSV download had to restart from byte 0.
//
// The helpers below stage a streaming Response to a per-job temp file, then
// serve the file with full Range/ETag support so the client-side
// streaming-download.js resume affordance works for streaming exports the
// same way it does for buffered ones. A periodic janitor unlinks staged
// files past their TTL (default 1 hour) so disk doesn't grow unbounded.

/**
 * Cache directory for staged streaming exports.  Override via
 * STREAMING_EXPORT_CACHE_DIR env (useful in tests, or to point at a
 * larger ephemeral volume than `/tmp`).
 */
const STAGED_EXPORT_DIR_DEFAULT = path.join(
  os.tmpdir(),
  "ExampleOrg-export-cache",
);

/** Default TTL — exports older than this are unlinked by the janitor. */
const STAGED_EXPORT_TTL_MS_DEFAULT = 60 * 60 * 1000; // 1 hour

/** How often the janitor scans for expired entries.  5 minutes is plenty
 *  given the default 1-hour TTL — the lazy-on-access GC catches the rest. */
const STAGED_EXPORT_JANITOR_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Hard upper bound on the number of simultaneously cached export files.
 * When the cache is full a new staging request returns 503 rather than
 * writing an unbounded number of files to the host's temp volume.
 * Override via STAGED_EXPORT_MAX_ENTRIES env.
 */
const STAGED_EXPORT_MAX_ENTRIES_DEFAULT = 200;

/**
 * Hard upper bound on the total bytes consumed by in-memory cache entries
 * (sum of staged file sizes).  Prevents a single authorised user from
 * filling the temp volume by requesting many large exports.
 * Override via STAGED_EXPORT_MAX_TOTAL_BYTES env (default 512 MB).
 */
const STAGED_EXPORT_MAX_TOTAL_BYTES_DEFAULT = 512 * 1024 * 1024; // 512 MB

/**
 * Per-user hard cap on simultaneously cached export entries.  Prevents a
 * single compromised or malicious account from monopolising the cache.
 * Override via STAGED_EXPORT_MAX_ENTRIES_PER_USER env (default 10).
 */
const STAGED_EXPORT_MAX_ENTRIES_PER_USER_DEFAULT = 10;

function stagedExportMaxEntries(): number {
  const raw = process.env.STAGED_EXPORT_MAX_ENTRIES;
  if (!raw) return STAGED_EXPORT_MAX_ENTRIES_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : STAGED_EXPORT_MAX_ENTRIES_DEFAULT;
}

function stagedExportMaxTotalBytes(): number {
  const raw = process.env.STAGED_EXPORT_MAX_TOTAL_BYTES;
  if (!raw) return STAGED_EXPORT_MAX_TOTAL_BYTES_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : STAGED_EXPORT_MAX_TOTAL_BYTES_DEFAULT;
}

function stagedExportMaxEntriesPerUser(): number {
  const raw = process.env.STAGED_EXPORT_MAX_ENTRIES_PER_USER;
  if (!raw) return STAGED_EXPORT_MAX_ENTRIES_PER_USER_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : STAGED_EXPORT_MAX_ENTRIES_PER_USER_DEFAULT;
}

interface StagedExportEntry {
  filePath: string;
  size: number;
  etag: string;
  contentType: string;
  contentDisposition: string;
  expiresAt: number;
  /** In-flight reads against this file.  Deferred-unlink waits on this. */
  refCount: number;
  /** Set by the janitor when refCount > 0 at TTL expiry — file is unlinked
   *  by the last reader's decRef rather than yanked out from under it. */
  pendingDelete: boolean;
  /** SHA-256 hash of the user identity string — used for per-user quota
   *  tracking.  Absent for entries staged before the quota feature was added
   *  or when no identity is available. */
  userIdentityHash?: string;
}

/**
 * Discriminated result of a staging attempt.  We need this so concurrent
 * waiters on the same in-flight staging promise all observe the same
 * outcome — either an entry to serve from disk, or a buffered non-200
 * response that we can re-materialize for each caller (Response bodies
 * are single-shot, so we cannot share the original Response object).
 */
type StagingResult =
  | { kind: "entry"; entry: StagedExportEntry }
  | {
      kind: "passthrough";
      status: number;
      statusText: string;
      headers: Array<[string, string]>;
      body: Uint8Array;
    };

const stagedExportCache = new Map<string, StagedExportEntry>();
const inFlightStaging = new Map<string, Promise<StagingResult>>();
let stagedExportJanitorTimer: NodeJS.Timeout | null = null;

/**
 * Per-user export entry tracking for quota enforcement.
 * Maps userIdentityHash → Set of active jobKeys owned by that user.
 * Kept in sync with stagedExportCache: entries are added on staging and
 * removed in reapStagedEntry so the quota check never counts stale entries.
 */
const userExportKeys = new Map<string, Set<string>>();

// ---------------------------------------------------------------------------
// Cache size limits (Task #811 — disk exhaustion guard)
// ---------------------------------------------------------------------------
//
// An authorized user can repeatedly request unique export URLs (e.g. by
// appending arbitrary query params) and create a distinct staged file for each
// one, filling the server's temp volume within the TTL window.  We bound both
// the entry count and the total on-disk bytes to limit how much a single
// process can accumulate.
//
// When either limit is reached, the oldest (LRU) non-in-flight entries are
// evicted before staging a new one.  If the cache is still over budget after
// eviction (e.g. all entries have active readers), the new export is served
// without being cached — the caller still gets their response, we just don't
// retain the file.
//
/**
 * Current total bytes tracked across all in-memory cache entries.
 * Maintained by a full map scan; called only during eviction so the cost is
 * acceptable.
 */
function stagedExportCurrentBytes(): number {
  let total = 0;
  for (const entry of stagedExportCache.values()) total += entry.size;
  return total;
}

/**
 * Evict the oldest non-actively-read entries until the cache fits within the
 * configured limits.  Returns true if the cache is now under budget (so the
 * caller may safely add a new entry), false if it is still over budget (all
 * remaining entries have active readers and cannot be evicted).
 */
async function evictStagedExportEntries(newEntrySize: number): Promise<boolean> {
  const maxEntries = stagedExportMaxEntries();
  const maxBytes = stagedExportMaxTotalBytes();

  // Collect eviction candidates: entries without active readers, sorted
  // oldest-expiry-first (i.e. the entries that have been in the cache longest).
  const candidates = [...stagedExportCache.entries()]
    .filter(([, e]) => e.refCount === 0 && !e.pendingDelete)
    .sort(([, a], [, b]) => a.expiresAt - b.expiresAt);

  for (const [key, entry] of candidates) {
    const currentEntries = stagedExportCache.size;
    const currentBytes = stagedExportCurrentBytes();
    // Stop evicting once both limits are satisfied including the new entry.
    if (
      currentEntries < maxEntries &&
      currentBytes + newEntrySize <= maxBytes
    ) break;
    await reapStagedEntry(key, entry);
  }

  // Report whether we have room now.
  return (
    stagedExportCache.size < stagedExportMaxEntries() &&
    stagedExportCurrentBytes() + newEntrySize <= stagedExportMaxTotalBytes()
  );
}

// ---------------------------------------------------------------------------
// Operator-visible counters (Task #755)
// ---------------------------------------------------------------------------
//
// These are intentionally process-local (no DB, no IPC) — the export cache
// itself is also process-local so a per-process count is the right granularity
// and avoids paying a network hop on the hot path. Counters reset on every
// restart, which is fine for a "is the cache doing work?" indicator.
let stagedExportHitCount = 0;
let stagedExportMissCount = 0;
let stagedExportJanitorLastRunAt: number | null = null;
let stagedExportJanitorLastReaped: number | null = null;

function stagedExportCacheDir(): string {
  return process.env.STREAMING_EXPORT_CACHE_DIR || STAGED_EXPORT_DIR_DEFAULT;
}

function stagedExportTtlMs(): number {
  const raw = process.env.STREAMING_EXPORT_TTL_MS;
  if (raw === undefined || raw === "") return STAGED_EXPORT_TTL_MS_DEFAULT;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return STAGED_EXPORT_TTL_MS_DEFAULT;
  return n;
}

async function ensureStagedExportDir(): Promise<string> {
  const dir = stagedExportCacheDir();
  // Create owner-only (0o700) so other OS users on the same host can't
  // list the cache directory and discover staged export filenames.
  // Staged files contain sensitive data (risk registers, audit findings,
  // vendor records, PDPL data) and live on disk for up to an hour.
  await fsPromises.mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir's `mode` is only applied when the directory is created — if it
  // pre-existed (e.g. created by an older build with default umask 0o755)
  // we still need to tighten it. chmod is best-effort: we swallow EPERM
  // so that pointing STREAMING_EXPORT_CACHE_DIR at a directory owned by
  // another user (rare ops scenario) doesn't break the export pipeline.
  try {
    await fsPromises.chmod(dir, 0o700);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "EPERM" && code !== "ENOENT") throw err;
    if (code === "EPERM") {
      logger.warn(
        "[stagedExport] could not chmod cache dir to 0o700 (not owner) — staged files are still 0o600",
        dir,
      );
    }
  }
  return dir;
}

/**
 * Eagerly create (or re-chmod) the streaming-export cache directory at
 * worker boot, *before* any export traffic is served.
 *
 * Why this exists separately from the lazy `ensureStagedExportDir` call
 * inside `stageAndServeStreamingExport`:
 *
 *   - On a freshly restarted worker that hasn't served an export yet, an
 *     inherited cache directory from a previous run could sit on disk
 *     with the wrong (looser) permissions for an arbitrary window —
 *     exactly the window during which other OS users on the same host
 *     could list staged-export filenames or read in-flight files.
 *   - Doing the chmod once at startup closes that window and surfaces
 *     permission/IO problems immediately at boot rather than on the
 *     first user export request.
 *
 * Logs a single startup line with the cache dir path and the resulting
 * mode (in octal) so operators can confirm the lockdown actually took
 * effect — useful when STREAMING_EXPORT_CACHE_DIR is pointed at an
 * unexpected mount or owned by a different user (chmod becomes a no-op
 * with an EPERM warning in that case, see `ensureStagedExportDir`).
 *
 * Failures are swallowed and logged at error level rather than thrown:
 * the lazy `ensureStagedExportDir` inside the request path remains as a
 * safety net, and we do not want a transient FS hiccup at boot to abort
 * the whole worker.
 */
export async function lockDownStagedExportCacheDirAtStartup(): Promise<void> {
  const dir = stagedExportCacheDir();
  try {
    await ensureStagedExportDir();
    let modeStr = "unknown";
    let actualMode: number | null = null;
    try {
      const st = await fsPromises.stat(dir);
      actualMode = st.mode & 0o777;
      modeStr = `0o${actualMode.toString(8).padStart(3, "0")}`;
    } catch {
      /* stat is best-effort for the log line */
    }
    if (actualMode !== null && actualMode !== 0o700) {
      // chmod was a no-op (e.g. EPERM because dir is owned by another
      // user) — staged files are still 0o600 but the dir itself is
      // looser than intended. Surface this loudly at startup so ops
      // can re-home STREAMING_EXPORT_CACHE_DIR rather than discover it
      // post-incident.
      logger.warn(
        `[stagedExport] cache directory checked at startup: ${dir} (mode ${modeStr}) — expected 0o700, dir is looser than intended`,
      );
    } else {
      logger.info(
        `[stagedExport] cache directory locked down at startup: ${dir} (mode ${modeStr})`,
      );
    }
  } catch (err) {
    logger.error(
      `[stagedExport] failed to lock down cache directory at startup: ${dir}`,
      err,
    );
  }
}


// ---------------------------------------------------------------------------
// Startup health check — warn when the cache dir lives on a shared volume
// ---------------------------------------------------------------------------
//
// Background (Task #770):
//   The staged export cache directory itself is created with mode 0o700, but
//   that only protects the *contents* of the directory — file names are still
//   exposed via parent-directory traversal. If an operator points
//   STREAMING_EXPORT_CACHE_DIR at e.g. `/srv/shared/exports` and the worker
//   creates the missing `shared/` segment via `mkdir -p` with the default
//   umask (0o022 → 0o755 mode), any user with execute on the chain can
//   `ls /srv/shared` and harvest the staged file names (which embed tenant
//   and report identifiers via the cache key) without ever reading a single
//   file. A startup health check catches the misconfiguration on day one
//   rather than during an audit.
//
// Scope of the walk (designed to avoid false positives on universal
// system-default permissions):
//
//   We walk *upward from the cache dir* and report ancestors that grant
//   group/other read or execute, but we deliberately stop:
//
//     1. At the first ancestor whose mode is tight (no g/o r+x). A tight
//        barrier blocks everyone outside the owner from reading or
//        traversing the chain above it — anything further up is protected
//        regardless of how loose those higher ancestors are. So if a
//        single 0o700 directory exists between the cache dir and root,
//        we stay silent.
//
//     2. At well-known system roots we cannot meaningfully advise the
//        operator to chmod: `/`, the resolved `os.tmpdir()`, and the
//        single-segment FHS roots (`/var`, `/srv`, `/opt`, `/usr`,
//        `/home`, `/mnt`, `/run`). These are universally g/o-traversable
//        on a stock POSIX install; reporting them produces non-actionable
//        noise on every boot. The operator-controlled portion of the
//        configured path is below this boundary and is what we actually
//        scan.
//
// Combined, these two rules mean a properly-configured custom path like
// `/var/lib/ExampleOrg/export-cache` (with `/var/lib/ExampleOrg` chmod 0o700
// and owned by the worker) produces zero findings, while the misconfig
// the task targets (`/srv/shared/exports` with `/srv/shared` left at the
// umask default 0o755) produces a single actionable finding for
// `/srv/shared`.
//
// Behaviour:
//   - No-op when STREAMING_EXPORT_CACHE_DIR is unset (default `/tmp`-based
//     path on a single-tenant box; `/tmp` is intentionally sticky-bit
//     world-traversable so warning on it would be noise on every boot).
//   - POSIX-only. Skipped on win32 where Node ignores fs modes.

export interface ExportCacheLocationFinding {
  /** Ancestor path that triggered the warning. */
  path: string;
  /** Mode bits as stat'd (full `st.mode & 0o777`). */
  mode: number;
  /** Subset of group/other read+execute bits set on the path. */
  permissiveBits: number;
}

export interface ExportCacheLocationCheckResult {
  /** Resolved cache directory path the worker would use. */
  cacheDir: string;
  /** Whether the check actually ran (false on win32 or when env unset). */
  checked: boolean;
  /** Ancestor permission findings. Empty when the chain is tight. */
  findings: ExportCacheLocationFinding[];
}

/**
 * System paths the walk treats as a boundary — present on every POSIX host,
 * universally g/o-traversable, and not something the operator can be
 * advised to chmod. We stop at (and do not report) any of these.
 */
function exportCacheScanStopBoundaries(): Set<string> {
  const stops = new Set<string>([
    "/",
    path.resolve(os.tmpdir()),
    // Standard FHS roots one segment below `/`. Anything *under* these
    // (e.g. `/var/lib/ExampleOrg`) is operator-controlled and still scanned;
    // the roots themselves are stock-installation defaults out of scope.
    "/var",
    "/srv",
    "/opt",
    "/usr",
    "/home",
    "/mnt",
    "/run",
  ]);
  return stops;
}

/**
 * Walk the parent chain of the configured staged-export cache directory and
 * report ancestors that grant group/other read or execute. Intended to be
 * called once at process boot so a permissive misconfiguration is logged
 * before any sensitive export is staged.
 *
 * See the block comment above for the scope of the walk.
 *
 * Silent (no log) when:
 *   - STREAMING_EXPORT_CACHE_DIR is not explicitly set,
 *   - process.platform === "win32", or
 *   - every operator-controlled ancestor between the cache dir and the
 *     first tight barrier (or the system boundary) is owner-only.
 */
export async function checkStagedExportCacheLocation(): Promise<ExportCacheLocationCheckResult> {
  const cacheDir = stagedExportCacheDir();

  if (process.platform === "win32" || !process.env.STREAMING_EXPORT_CACHE_DIR) {
    return { cacheDir, checked: false, findings: [] };
  }

  // Materialise the cache directory (and any missing parent segments) before
  // we scan. This is what makes the check actually catch the misconfiguration
  // the task targets: when an operator points STREAMING_EXPORT_CACHE_DIR at
  // e.g. `/srv/shared/exports` and `/srv/shared` does not yet exist, the
  // worker's `mkdir -p` here creates `/srv/shared` with the *current process
  // umask* (typically 0o022 → 0o755). Without this preflight call the
  // ancestor walk would just see ENOENT for `/srv/shared` and report
  // nothing — exactly the false-negative the task is designed to prevent.
  // ensureStagedExportDir is idempotent and also tightens the leaf to 0o700.
  try {
    await ensureStagedExportDir();
  } catch (err) {
    // If we can't even create the dir, the check is moot — the export
    // pipeline will fail loudly on the first request with the same error.
    // Surface the failure but don't throw out of the boot probe.
    logger.warn(
      "[stagedExport] healthcheck: could not ensure cache dir, skipping ancestor scan",
      { cacheDir, err: String(err) },
    );
    return { cacheDir, checked: true, findings: [] };
  }

  const resolved = path.resolve(cacheDir);
  const findings: ExportCacheLocationFinding[] = [];
  const stopBoundaries = exportCacheScanStopBoundaries();

  // Walk parents from the immediate parent upward. Skip the cache dir
  // itself — that's locked down to 0o700 by ensureStagedExportDir; the
  // threat model here is parent-directory traversal.
  let current = path.dirname(resolved);
  let previous = "";
  while (current && current !== previous) {
    if (stopBoundaries.has(current)) {
      // Reached a system boundary the operator can't reasonably alter.
      // Anything above is out of scope for this check.
      break;
    }

    let mode: number | null = null;
    try {
      const st = await fsPromises.stat(current);
      if (st.isDirectory()) {
        mode = st.mode & 0o777;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      // ENOENT/EACCES on an ancestor is not actionable here — surface
      // anything else at warn so we don't silently swallow real disk
      // errors during the boot probe.
      if (code !== "ENOENT" && code !== "EACCES") {
        logger.warn(
          "[stagedExport] healthcheck: stat failed on ancestor",
          { path: current, err: String(err) },
        );
      }
    }

    if (mode !== null) {
      const permissiveBits = mode & 0o055; // g+o read | g+o execute
      if (permissiveBits === 0) {
        // Tight barrier — anything above is unreachable to non-owners
        // regardless of those higher ancestors' modes. Stop and stay
        // silent for the rest of the chain.
        break;
      }
      findings.push({ path: current, mode, permissiveBits });
    }

    previous = current;
    current = path.dirname(current);
  }

  if (findings.length > 0) {
    logger.warn(
      "[stagedExport] cache directory has world-traversable ancestors — staged export filenames may leak via parent listing. See docs/Security_Operations_SOP.md §5.14.",
      {
        cacheDir: resolved,
        ancestors: findings.map((f) => ({
          path: f.path,
          mode: `0o${f.mode.toString(8).padStart(3, "0")}`,
          permissiveBits: `0o${f.permissiveBits.toString(8).padStart(3, "0")}`,
        })),
        recommendedFix:
          "chmod the offending ancestor(s) to remove group/other r+x " +
          "(e.g. `chmod o-rx,g-rx /srv/shared`), or re-point " +
          "STREAMING_EXPORT_CACHE_DIR at a path under a 0o700 parent " +
          "owned by the worker user.",
      },
    );
  }

  return { cacheDir: resolved, checked: true, findings };
}

async function unlinkStagedFile(filePath: string): Promise<void> {
  try {
    await fsPromises.unlink(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") {
      // Soft-fail — janitor will retry on the next scan.
      // eslint-disable-next-line no-console
      logger.warn("[stagedExport] failed to unlink", filePath, err);
    }
  }
}

function decRefStagedEntry(entry: StagedExportEntry): void {
  entry.refCount = Math.max(0, entry.refCount - 1);
  if (entry.refCount === 0 && entry.pendingDelete) {
    void unlinkStagedFile(entry.filePath);
  }
}

async function reapStagedEntry(
  key: string,
  entry: StagedExportEntry,
): Promise<void> {
  stagedExportCache.delete(key);
  // Clean up per-user quota tracking so the slot is reclaimed immediately
  // rather than waiting for the next quota check.
  if (entry.userIdentityHash) {
    const keys = userExportKeys.get(entry.userIdentityHash);
    if (keys) {
      keys.delete(key);
      if (keys.size === 0) userExportKeys.delete(entry.userIdentityHash);
    }
  }
  if (entry.refCount > 0) {
    // Defer unlink until the last reader drains.
    entry.pendingDelete = true;
    return;
  }
  await unlinkStagedFile(entry.filePath);
}

/**
 * Hash the job key into a fixed-length filename prefix. We hash rather than
 * encode so that auth cookies / session tokens that callers fold into the
 * job key never end up readable in the on-disk filename.
 *
 * The actual on-disk filename appends a per-staging generation suffix (see
 * `mintStagedFilePath`) so that re-staging the same `jobKey` after TTL
 * expiry — when a previous generation's file is still being read by a slow
 * downloader — writes to a fresh file and never truncates the older one
 * out from under the in-flight reader.
 */
function safeStagedFilename(jobKey: string): string {
  return createHash("sha256").update(jobKey).digest("hex");
}

/** Mint a generation-unique on-disk path for a fresh staging.  The
 *  hash-of-jobKey prefix lets ops humans recognise files belonging to the
 *  same logical export; the random suffix makes each generation unique. */
function mintStagedFilePath(dir: string, jobKey: string): string {
  const generation = randomBytes(8).toString("hex");
  return path.join(dir, `${safeStagedFilename(jobKey)}-${generation}.bin`);
}

/**
 * Compute the same weak ETag as `bufferResponseWithRange` does for a Buffer,
 * but reading the head/tail samples back from a freshly-written file. We
 * share the scheme so that — should an export become small enough to switch
 * back to the buffered path in future — clients that already cached the
 * etag can still resume across the migration boundary.
 */
async function computeStagedFileWeakEtag(
  filePath: string,
  size: number,
): Promise<string> {
  const SAMPLE = 8 * 1024;
  const headLen = Math.min(SAMPLE, size);
  const fh = await fsPromises.open(filePath, "r");
  try {
    const head = Buffer.alloc(headLen);
    if (headLen > 0) await fh.read(head, 0, headLen, 0);
    const h = createHash("sha1");
    h.update(head);
    if (size > headLen) {
      const tailStart = Math.max(0, size - SAMPLE);
      const tailLen = size - tailStart;
      const tail = Buffer.alloc(tailLen);
      await fh.read(tail, 0, tailLen, tailStart);
      h.update(tail);
    }
    return `W/"${size.toString(16)}-${h.digest("hex").substring(0, 16)}"`;
  } finally {
    await fh.close();
  }
}

/**
 * Drain a Response body to a file, aborting mid-stream if `maxBytes` is
 * exceeded.  Throws `ExportSizeExceededError` on overflow so the caller can
 * delete the partial file and return a 503.
 *
 * `maxBytes` should be set to the remaining capacity of the export cache
 * (total budget minus already-staged bytes) so that a single large export
 * cannot exceed the global disk quota even when the cache appears empty.
 */
class ExportSizeExceededError extends Error {
  constructor(maxBytes: number) {
    super(`Export exceeded maximum staging size of ${maxBytes} bytes`);
    this.name = "ExportSizeExceededError";
  }
}

async function drainResponseBodyToFile(
  response: Response,
  filePath: string,
  maxBytes?: number,
): Promise<number> {
  // mode 0o600 — owner-only read/write. Staged exports may contain sensitive
  // data (risk registers, audit findings, vendor records, PDPL data); on a
  // shared host the default umask (typically 0o022) would leave them
  // world-readable for up to a TTL window. The `mode` option on
  // open()/writeFile() is only honoured when the file is *created*, so
  // existing files keep their mode — but staged files are minted with a
  // fresh per-generation suffix in `mintStagedFilePath`, so every drain
  // path here creates a brand-new file.
  if (!response.body) {
    // Empty body — write a 0-byte file so `serveFromStagedEntry` can still
    // open it for a Range read without an ENOENT race. Mode 0o600 so the
    // staged file is readable only by the process owner.
    await fsPromises.writeFile(filePath, Buffer.alloc(0), { mode: 0o600 });
    return 0;
  }
  const reader = response.body.getReader();
  // Open with mode 0o600 (owner-read/write only). The third arg to
  // fsPromises.open is the creation mode — it's only honoured on create,
  // and `mintStagedFilePath` always returns a generation-unique path so
  // the file is guaranteed fresh.
  const fh = await fsPromises.open(filePath, "w", 0o600);
  let size = 0;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || !value.byteLength) continue;
      size += value.byteLength;
      // Enforce the per-export byte cap mid-stream so disk is never filled
      // by a single oversized export, regardless of cache-level pre-checks.
      if (maxBytes !== undefined && size > maxBytes) {
        void reader.cancel().catch(() => { });
        throw new ExportSizeExceededError(maxBytes);
      }
      const chunk = Buffer.from(
        value.buffer,
        value.byteOffset,
        value.byteLength,
      );
      await fh.write(chunk);
    }
  } finally {
    await fh.close();
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }
  return size;
}

/**
 * Run one pass of the janitor: drop and unlink any cache entry whose TTL
 * has expired. Exposed for tests; production callers should rely on the
 * 5-minute interval started lazily by `stageAndServeStreamingExport`.
 *
 * Returns the number of entries reaped.
 */
export async function runStagedExportJanitor(): Promise<number> {
  const now = Date.now();
  const expired: Array<[string, StagedExportEntry]> = [];
  for (const [key, entry] of stagedExportCache) {
    if (entry.expiresAt <= now) expired.push([key, entry]);
  }
  for (const [key, entry] of expired) {
    await reapStagedEntry(key, entry);
  }
  // Record janitor visibility for the admin stats panel (Task #755).
  // Stamp the timestamp regardless of how many entries were reaped — a "0
  // reaped" pass still proves the janitor is running on schedule.
  stagedExportJanitorLastRunAt = now;
  stagedExportJanitorLastReaped = expired.length;
  return expired.length;
}

function startStagedExportJanitorIfNeeded(): void {
  if (stagedExportJanitorTimer) return;
  if (process.env.STREAMING_EXPORT_DISABLE_JANITOR === "1") return;
  stagedExportJanitorTimer = setInterval(() => {
    void runStagedExportJanitor();
  }, STAGED_EXPORT_JANITOR_INTERVAL_MS);
  // Don't keep the event loop alive solely for cleanup.
  if (typeof stagedExportJanitorTimer.unref === "function") {
    stagedExportJanitorTimer.unref();
  }
}

/** Test-only — drop everything from the cache, unlink files, stop the
 *  janitor. Vitest tests should call this in afterEach to keep runs hermetic. */
export async function _resetStagedExportCacheForTests(): Promise<void> {
  if (stagedExportJanitorTimer) {
    clearInterval(stagedExportJanitorTimer);
    stagedExportJanitorTimer = null;
  }
  inFlightStaging.clear();
  const entries = [...stagedExportCache.entries()];
  stagedExportCache.clear();
  userExportKeys.clear();
  for (const [, entry] of entries) {
    await unlinkStagedFile(entry.filePath);
  }
  stagedExportHitCount = 0;
  stagedExportMissCount = 0;
  stagedExportJanitorLastRunAt = null;
  stagedExportJanitorLastReaped = null;
}

// ---------------------------------------------------------------------------
// Operator-visible cache stats (Task #755)
// ---------------------------------------------------------------------------

export interface StagedExportCacheStats {
  /** Number of in-memory cache entries (each backed by a temp file on disk). */
  entryCount: number;
  /** Sum of file sizes for live in-memory entries (bytes). */
  totalBytes: number;
  /** Cumulative cache-hit count since process start. */
  hitCount: number;
  /** Cumulative cache-miss count since process start. */
  missCount: number;
  /** Hit ratio (hits / (hits + misses)) in the [0, 1] range, or null when no
   *  requests have been served yet. */
  hitRate: number | null;
  /** Unix-ms timestamp of the most recent janitor pass, or null if it has not
   *  run yet (e.g. the process just started). */
  lastJanitorRunAt: number | null;
  /** Entries reaped in the most recent janitor pass, or null if not yet run. */
  lastJanitorReaped: number | null;
  /** Cache directory path the janitor scans — surfaced so operators can SSH
   *  in and confirm what they're looking at when disk usage looks wrong. */
  cacheDir: string;
  /** TTL applied to newly-staged entries (ms). */
  ttlMs: number;
  /** Number of entries currently being streamed by at least one HTTP client.
   *  These are the entries the janitor will defer-unlink rather than yank. */
  activeReadCount: number;
  /** Number of entries past their TTL but not yet reaped (waiting for the
   *  next janitor pass or a lazy-on-access GC). */
  expiredEntryCount: number;
  /** Disk-side scan: the actual files in the cache directory. May exceed
   *  `entryCount` when a generation roll-over left an older file pinned by
   *  a slow downloader, or when leftover files from a previous process are
   *  still on disk waiting for the janitor to notice. */
  onDiskFileCount: number;
  onDiskTotalBytes: number;
}

/**
 * Snapshot the export cache for the admin stats panel.
 *
 * Reads both the in-memory map and the on-disk directory because they can
 * legitimately diverge: a previous process's leftover files, or a still-
 * being-read older generation of a re-staged export, will show up on disk
 * but not in the live map. Operators care about both numbers when sizing
 * the ephemeral volume.
 */
export async function getStagedExportCacheStats(): Promise<StagedExportCacheStats> {
  const now = Date.now();
  let totalBytes = 0;
  let activeReadCount = 0;
  let expiredEntryCount = 0;
  for (const entry of stagedExportCache.values()) {
    totalBytes += entry.size;
    if (entry.refCount > 0) activeReadCount++;
    if (entry.expiresAt <= now) expiredEntryCount++;
  }

  // Best-effort disk scan. The directory may not exist yet (no export has
  // been served since boot) — treat that as "0 files / 0 bytes" rather
  // than an error so the panel renders cleanly on a quiet system.
  let onDiskFileCount = 0;
  let onDiskTotalBytes = 0;
  const dir = stagedExportCacheDir();
  try {
    const names = await fsPromises.readdir(dir);
    for (const name of names) {
      try {
        const st = await fsPromises.stat(path.join(dir, name));
        if (st.isFile()) {
          onDiskFileCount++;
          onDiskTotalBytes += st.size;
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        // ENOENT = file vanished between readdir and stat (the janitor or
        // a release race) — skip it silently. Anything else is logged.
        if (code !== "ENOENT") {
          logger.warn("[stagedExport] stat failed during stats scan", name, err);
        }
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") {
      logger.warn("[stagedExport] readdir failed during stats scan", dir, err);
    }
  }

  const totalRequests = stagedExportHitCount + stagedExportMissCount;
  const hitRate = totalRequests > 0 ? stagedExportHitCount / totalRequests : null;

  return {
    entryCount: stagedExportCache.size,
    totalBytes,
    hitCount: stagedExportHitCount,
    missCount: stagedExportMissCount,
    hitRate,
    lastJanitorRunAt: stagedExportJanitorLastRunAt,
    lastJanitorReaped: stagedExportJanitorLastReaped,
    cacheDir: dir,
    ttlMs: stagedExportTtlMs(),
    activeReadCount,
    expiredEntryCount,
    onDiskFileCount,
    onDiskTotalBytes,
  };
}

/**
 * Derive a cache key for a streaming export.
 *
 * The key SHOULD be:
 *   - Stable across resume attempts (same URL + filters + caller identity).
 *   - Per-user (so two users requesting the same export don't share files).
 *   - Insensitive to header noise that doesn't affect the body.
 *
 * We hash {url, identity, extra} into a single hex string.  Identity is
 * folded in BEFORE hashing — the caller can pass session id / admin key /
 * cookie as the identity without it leaking into logs or filenames.
 */
export function deriveStreamingExportJobKey(parts: {
  url: string;
  userIdentity?: string | null;
  extra?: string;
}): string {
  const h = createHash("sha256");
  h.update(parts.url || "");
  h.update("\0");
  h.update(parts.userIdentity || "anon");
  h.update("\0");
  h.update(parts.extra || "");
  return h.digest("hex");
}

export interface StreamingExportStagingOptions {
  /** TTL for the staged file (ms).  Defaults to env `STREAMING_EXPORT_TTL_MS`
   *  or 1 hour. */
  ttlMs?: number;
  /**
   * SHA-256 hash of the caller's identity string (cookie / admin key).
   * When provided, `stageAndServeStreamingExport` tracks how many cache
   * entries this user owns and enforces the per-user quota configured via
   * `STAGED_EXPORT_MAX_ENTRIES_PER_USER`.  Callers should hash the raw
   * credential before passing it here so the value is never stored
   * in memory in its original form.
   */
  userIdentityHash?: string;
}

// ---------------------------------------------------------------------------
// Streaming-export latency budget — applied to every streaming export
// ---------------------------------------------------------------------------
//
// The Playwright smoke test in tests/streamingDownload.spec.ts checks the
// browser-side download latency against an intercepted ~80-byte CSV. That
// validates the dashboard's service-worker / FSA pipeline but never touches
// the real backend route — a regression that buffers the full body before
// emitting the first byte (e.g. someone forgetting to use streamCsv /
// stageStreamingExportFromHono and going back to `c.body(buffer)`) would
// not be caught by that test.
//
// To plug that gap, every streaming export response built through
// `stageStreamingExportFromHono` is wrapped with `instrumentExportResponseTiming`
// which:
//
//   1. Stamps `X-Stream-TTFB-Ms` on the response — the wall-clock duration
//      between the wrapper being invoked and the response object being
//      handed back to the framework. For a staged-and-served response that
//      is essentially "build + drain to disk" time and is what the client
//      sees as time-to-first-byte.
//   2. Echoes the budget on `X-Stream-TTFB-Budget-Ms` and
//      `X-Stream-Total-Budget-Ms` so an integration test can assert against
//      the budget without hard-coding it.
//   3. Wraps the response body in a transparent passthrough that records
//      total transfer duration and bytes written, then logs a single line
//      to the server log when the stream finishes (or is cancelled).
//
// The integration test `tests/streamingExportLatency.integration.ts` hits
// every export endpoint against a freshly seeded dev server and asserts
// `X-Stream-TTFB-Ms <= EXPORT_TTFB_BUDGET_MS`. CI runs it via the existing
// `streaming-download-smoke` workflow.
//
// Re-baselining: if a legitimate change raises the expected latency (e.g.
// a new auth/audit middleware step), update the constants below AND the
// values referenced in the smoke workflow + integration test, and explain
// the new range in the commit message.
//
// Budget rationale (small dev-mode payload, ~hundreds of rows max):
//   * EXPORT_TTFB_BUDGET_MS = 5_000 ms — generous for a dev container
//     under cold-start load (DB pool init + ExcelJS workbook setup) but
//     well under a "user notices it stalled" threshold. A regression that
//     trips this almost always means we accidentally introduced full-body
//     buffering or stalled the promise chain.
//   * EXPORT_TOTAL_BUDGET_MS = 10_000 ms — wall-clock cap for total
//     transfer of a small payload to localhost. A staged-and-served file
//     whose body cannot be drained inside this window is broken in a way
//     the user will feel.
export const EXPORT_TTFB_BUDGET_MS = 5_000;
export const EXPORT_TOTAL_BUDGET_MS = 10_000;

/** Header names — exported so tests don't drift from the implementation. */
export const EXPORT_TIMING_HEADERS = {
  ttfb: "X-Stream-TTFB-Ms",
  ttfbBudget: "X-Stream-TTFB-Budget-Ms",
  totalBudget: "X-Stream-Total-Budget-Ms",
} as const;

/**
 * Wrap a Response so that:
 *   - `X-Stream-TTFB-Ms` records (now - startedAt) at the moment this
 *     wrapper is called (i.e. just before the framework hands the
 *     response back to the network layer). This is what the client
 *     actually sees as time-to-first-byte.
 *   - The response body is piped through a tee that counts bytes and
 *     records last-byte timing, logged once when the stream finishes.
 *
 * The wrapper is a no-op for headerless / bodyless edge cases (e.g.
 * `instrumentExportResponseTiming` invoked on a 304 with no body) — it
 * still stamps the TTFB header but skips the body wrapping.
 *
 * Designed to be cheap: no extra allocation per chunk beyond what the
 * existing ReadableStream pipeline already does, and no I/O on the hot
 * path (the single log line is written when the stream closes).
 */
export function instrumentExportResponseTiming(
  resp: Response,
  startedAt: number,
  routeLabel: string,
): Response {
  const ttfbMs = Math.max(0, Math.round(performance.now() - startedAt));
  const newHeaders = new Headers(resp.headers);
  newHeaders.set(EXPORT_TIMING_HEADERS.ttfb, String(ttfbMs));
  newHeaders.set(
    EXPORT_TIMING_HEADERS.ttfbBudget,
    String(EXPORT_TTFB_BUDGET_MS),
  );
  newHeaders.set(
    EXPORT_TIMING_HEADERS.totalBudget,
    String(EXPORT_TOTAL_BUDGET_MS),
  );

  // Surface a same-origin-readable subset so a fetch() integration test
  // can actually see the X-Stream-* headers (CORS-agnostic same-origin
  // reads include them already, but explicitly listing keeps them visible
  // even when the response is cross-origin via a future proxy).
  const existingExpose = newHeaders.get("Access-Control-Expose-Headers");
  const exposeList = [
    existingExpose,
    EXPORT_TIMING_HEADERS.ttfb,
    EXPORT_TIMING_HEADERS.ttfbBudget,
    EXPORT_TIMING_HEADERS.totalBudget,
  ]
    .filter((s): s is string => !!s && s.length > 0)
    .join(", ");
  newHeaders.set("Access-Control-Expose-Headers", exposeList);

  if (ttfbMs > EXPORT_TTFB_BUDGET_MS) {
    logger.warn(
      `[export-timing] TTFB OVER BUDGET on ${routeLabel}: ${ttfbMs}ms > ${EXPORT_TTFB_BUDGET_MS}ms ` +
        `— check for accidental full-body buffering before stageStreamingExportFromHono returned.`,
    );
  }

  const origBody = resp.body;
  if (!origBody) {
    logger.info(
      `[export-timing] ${routeLabel} ttfb=${ttfbMs}ms total=${ttfbMs}ms bytes=0 status=no-body`,
    );
    return new Response(null, {
      status: resp.status,
      statusText: resp.statusText,
      headers: newHeaders,
    });
  }

  // Backpressure-safe passthrough: we use a `pull`-based ReadableStream
  // (NOT `start`) so the upstream `origBody` is only consumed when the
  // downstream consumer asks for more. A `start`-driven `while(true)
  // reader.read()` loop would eagerly drain the entire upstream into the
  // wrapper's internal queue, which is exactly the full-body buffering
  // failure mode this whole task is trying to detect — defeating its own
  // purpose and inflating memory on large exports.
  //
  // Total duration is captured at three completion points so it always
  // reflects the real end-of-transfer wall clock:
  //   - close: upstream signalled `done` AND we just enqueued the close
  //     to the consumer (i.e. last byte is on its way to the network),
  //   - cancel: consumer (or a network disconnect) abandoned the read,
  //   - error: upstream threw mid-stream.
  // Each fires exactly once, guarded by `completed`.
  let bytesObserved = 0;
  let completed = false;
  const reader = origBody.getReader();

  const finish = (
    status: "ok" | "over-budget" | "cancelled" | "error",
    extra?: string,
  ): void => {
    if (completed) return;
    completed = true;
    const totalMs = Math.max(0, Math.round(performance.now() - startedAt));
    const effectiveStatus =
      status === "ok" && totalMs > EXPORT_TOTAL_BUDGET_MS
        ? "over-budget"
        : status;
    logger.info(
      `[export-timing] ${routeLabel} ttfb=${ttfbMs}ms total=${totalMs}ms ` +
        `bytes=${bytesObserved} budget_ttfb=${EXPORT_TTFB_BUDGET_MS}ms ` +
        `budget_total=${EXPORT_TOTAL_BUDGET_MS}ms status=${effectiveStatus}` +
        (extra ? ` ${extra}` : ""),
    );
    // Feed the in-memory rolling-window aggregator that the export-timing
    // p95 alert cron (Task #440) consumes. Lazy-import to break the import
    // cycle (exportTimingMetrics imports the budget constants from this
    // file). Wrapped in try/catch so a metrics bug can never break the
    // streaming response we just finished serving.
    void (async () => {
      try {
        const { recordExportTimingSample } = await import(
          "./exportTimingMetrics"
        );
        recordExportTimingSample({
          routeLabel,
          ttfbMs,
          totalMs,
          bytes: bytesObserved,
          status: effectiveStatus,
        });
      } catch {
        /* noop — metrics bookkeeping must never affect the response */
      }
    })();
    if (effectiveStatus === "over-budget") {
      logger.warn(
        `[export-timing] TOTAL OVER BUDGET on ${routeLabel}: ${totalMs}ms ` +
          `> ${EXPORT_TOTAL_BUDGET_MS}ms (${bytesObserved} bytes). A small ` +
          `payload that takes this long indicates a streaming pipeline ` +
          `regression — check stageAndServeStreamingExport / createReadStream.`,
      );
    }
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  };

  const wrapped = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
          finish("ok");
          return;
        }
        if (value) bytesObserved += value.byteLength;
        controller.enqueue(value);
      } catch (err) {
        try {
          controller.error(err);
        } catch {
          /* already errored */
        }
        finish("error", `err=${(err as Error)?.message ?? err}`);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch {
        /* noop */
      }
      finish("cancelled", `reason=${String(reason ?? "")}`);
    },
  });

  return new Response(wrapped, {
    status: resp.status,
    statusText: resp.statusText,
    headers: newHeaders,
  });
}

/**
 * Stage a streaming Response to a per-job temp file, then serve it with
 * full HTTP Range support so the client-side streaming-download helper can
 * resume an interrupted XLSX/CSV download the same way it can resume a
 * buffered PDF/XLSX.
 *
 * Behaviour:
 *   - On cache miss, `build()` is called exactly once.  Its Response body
 *     is drained into the temp file before any byte is sent to the client.
 *     A weak ETag, total size, content-type, and content-disposition are
 *     captured from the producer's Response and stored alongside the file.
 *   - On cache hit, `build()` is not called at all — the cached file is
 *     served directly, even if the new request has no `Range` header.
 *     Subsequent `Range:`+`If-Range:` requests stream the requested byte
 *     range straight off disk via `fs.createReadStream(start, end)`.
 *   - Concurrent requests for the same `jobKey` coalesce — the second
 *     request awaits the first staging promise instead of rebuilding.
 *   - Non-200 responses from `build()` (e.g. a 401 from middleware) are
 *     passed straight through and never cached.
 *
 * Garbage collection: a 5-minute interval scans the cache for entries past
 * `ttlMs` and unlinks their files.  Lazy-on-access GC catches stale
 * entries between janitor passes.  Files with active reads are deferred
 * to the last reader's decRef (so a slow downloader is never yanked).
 */
export async function stageAndServeStreamingExport(
  reqHeaders: RangeRequestHeaders,
  jobKey: string,
  build: () => Promise<Response> | Response,
  options: StreamingExportStagingOptions = {},
): Promise<Response> {
  startStagedExportJanitorIfNeeded();
  const ttlMs = options.ttlMs ?? stagedExportTtlMs();

  // Lazy GC on access — drop expired entries before serving so a hit on a
  // long-stale entry can't beat the periodic janitor by milliseconds.
  const now0 = Date.now();
  const stale = stagedExportCache.get(jobKey);
  if (stale && stale.expiresAt <= now0) {
    await reapStagedEntry(jobKey, stale);
  }

  const userHash = options.userIdentityHash;

  let entry = stagedExportCache.get(jobKey);
  if (!entry) {
    // Cache miss — count it once per request, regardless of whether this
    // call owns the staging or piggy-backs on an in-flight one. Both
    // paths represent "the cache could not satisfy this request from a
    // ready entry" from an operator's perspective.
    stagedExportMissCount++;
    let staging = inFlightStaging.get(jobKey);
    let owns = false;
    if (!staging) {
      // ---------------------------------------------------------------
      // Resource-exhaustion guards — enforced only when we are about to
      // start a brand-new staging (not when piggybacking on an in-flight
      // one, since that staging already committed its resources).
      // ---------------------------------------------------------------

      // Per-user quota: reject early if this user already has too many
      // cached exports.  A nonce-variation attack (?nonce=1, ?nonce=2 …)
      // produces distinct jobKeys but the same userIdentityHash, so the
      // per-user cap bounds total disk consumption per account even when
      // the global entry cap has not been reached.
      if (userHash) {
        const userKeys = userExportKeys.get(userHash);
        if (userKeys && userKeys.size >= stagedExportMaxEntriesPerUser()) {
          return new Response(
            JSON.stringify({
              error:
                "Export quota exceeded: too many concurrent exports for this account. " +
                "Wait for an existing export to expire or download it before requesting a new one.",
            }),
            { status: 503, headers: { "Content-Type": "application/json" } },
          );
        }
      }

      // Global entry cap: prevents unbounded file accumulation.
      if (stagedExportCache.size >= stagedExportMaxEntries()) {
        return new Response(
          JSON.stringify({
            error:
              "Export service temporarily unavailable: cache capacity reached. " +
              "Please retry after a short wait.",
          }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        );
      }

      // Global byte cap: protects the temp volume even when individual
      // exports are small but there are many of them.
      let totalBytes = 0;
      for (const e of stagedExportCache.values()) totalBytes += e.size;
      const maxTotalBytes = stagedExportMaxTotalBytes();
      if (totalBytes >= maxTotalBytes) {
        return new Response(
          JSON.stringify({
            error:
              "Export service temporarily unavailable: disk quota exceeded. " +
              "Please retry after a short wait.",
          }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        );
      }
      // The remaining capacity is passed to drainResponseBodyToFile as a hard
      // per-export byte cap so a single large export cannot exceed the total
      // disk budget even when the cache is otherwise empty.
      const remainingCapacity = maxTotalBytes - totalBytes;

      owns = true;
      staging = (async (): Promise<StagingResult> => {
        const dir = await ensureStagedExportDir();
        // Generation-unique path: a re-stage of the same jobKey while a
        // previous generation's file is still being streamed by a slow
        // reader writes to a fresh file and never truncates the older one.
        const filePath = mintStagedFilePath(dir, jobKey);
        const built = await build();
        // Pass non-200 responses straight through. We buffer the body
        // here (typically a small JSON error) so concurrent waiters
        // attached to this staging promise can each materialize their own
        // fresh Response — Response bodies are single-shot.  We never
        // cache error bodies — that would pin a bad response across the
        // TTL window even after the underlying problem is fixed.
        if (built.status !== 200) {
          const headerPairs: Array<[string, string]> = [];
          built.headers.forEach((v, k) => headerPairs.push([k, v]));
          const body = new Uint8Array(await built.arrayBuffer());
          return {
            kind: "passthrough",
            status: built.status,
            statusText: built.statusText,
            headers: headerPairs,
            body,
          };
        }
        const contentType =
          built.headers.get("content-type") || "application/octet-stream";
        const contentDisposition =
          built.headers.get("content-disposition") ||
          'attachment; filename="export.bin"';
        let size: number;
        try {
          size = await drainResponseBodyToFile(built, filePath, remainingCapacity);
        } catch (err) {
          // Delete the partial file so disk space is immediately reclaimed.
          await unlinkStagedFile(filePath);
          if (err instanceof ExportSizeExceededError) {
            return {
              kind: "passthrough",
              status: 503,
              statusText: "Service Unavailable",
              headers: [["Content-Type", "application/json"]],
              body: new TextEncoder().encode(
                JSON.stringify({
                  error:
                    "Export too large: the generated file exceeds the server's disk quota. " +
                    "Narrow your filter criteria and retry.",
                }),
              ),
            };
          }
          throw err;
        }
        const etag = await computeStagedFileWeakEtag(filePath, size);
        const newEntry: StagedExportEntry = {
          filePath,
          size,
          etag,
          contentType,
          contentDisposition,
          expiresAt: Date.now() + ttlMs,
          refCount: 0,
          pendingDelete: false,
          userIdentityHash: userHash,
        };
        // Register in the per-user tracking map before inserting so that a
        // concurrent reap by the janitor sees a consistent view.
        if (userHash) {
          if (!userExportKeys.has(userHash)) {
            userExportKeys.set(userHash, new Set());
          }
          userExportKeys.get(userHash)!.add(jobKey);
        }
        // Enforce cache size limits before inserting.  Evict the oldest idle
        // entries first.  If the cache is still over budget (e.g. every entry
        // has an active reader that can't be evicted), skip storing — the
        // caller still gets their response, we just don't retain the file on
        // disk so a future request has to rebuild it.
        const hasRoom = await evictStagedExportEntries(size);
        if (hasRoom) {
          stagedExportCache.set(jobKey, newEntry);
        } else {
          // No room — clean up per-user tracking and schedule file deletion.
          if (userHash) {
            const keys = userExportKeys.get(userHash);
            if (keys) {
              keys.delete(jobKey);
              if (keys.size === 0) userExportKeys.delete(userHash);
            }
          }
          void unlinkStagedFile(filePath);
        }
        return { kind: "entry", entry: newEntry };
      })();
      inFlightStaging.set(jobKey, staging);
      // The promise is stored in a map as well as awaited below. If staging
      // rejects and the awaiting request has already gone away — a cancelled
      // download, a piggy-backing caller that timed out — the stored copy is
      // a rejected promise nobody handles, which Node treats as fatal: the
      // process exits and every other request on the instance 500s. This
      // no-op keeps it handled; the real error still reaches whoever awaits.
      staging.catch(() => {
        /* handled by the awaiting caller below */
      });
    }

    let result: StagingResult;
    try {
      result = await staging;
    } finally {
      // Only the owning caller clears the in-flight slot — followers
      // must not race ahead and remove a slot the owner is still
      // waiting on.  Failed stagings (the await throws) also clear
      // their slot so a subsequent caller can retry from scratch.
      if (owns) inFlightStaging.delete(jobKey);
    }

    if (result.kind === "passthrough") {
      return new Response(new Uint8Array(result.body), {
        status: result.status,
        statusText: result.statusText,
        headers: result.headers,
      });
    }
    entry = result.entry;
  } else {
    // Cache hit — entry was already in the map and still within TTL after
    // the lazy GC check above. We do not count a re-served range request
    // any differently from a fresh GET; from a "did we avoid rebuilding
    // the body?" perspective, both are wins.
    stagedExportHitCount++;
  }

  return serveFromStagedEntry(entry, reqHeaders);
}

function serveFromStagedEntry(
  entry: StagedExportEntry,
  reqHeaders: RangeRequestHeaders,
): Response {
  const total = entry.size;
  const baseHeaders: Record<string, string> = {
    "Content-Type": entry.contentType,
    "Content-Disposition": entry.contentDisposition,
    "Accept-Ranges": "bytes",
    ETag: entry.etag,
  };

  const rangeHeader = readReqHeader(reqHeaders, "range");
  const ifRangeHeader = readReqHeader(reqHeaders, "if-range");

  // If-Range: ignore Range when the validator no longer matches.  Same
  // semantics as bufferResponseWithRange (verbatim compare, weak or strong).
  const useRange =
    !!rangeHeader &&
    (!ifRangeHeader || ifRangeHeader.trim() === entry.etag.trim());

  let start = 0;
  let end = total > 0 ? total - 1 : 0;
  let status = 200;
  if (useRange) {
    const parsed = parseSingleRange(rangeHeader as string, total);
    if (parsed === "unsatisfiable") {
      return new Response(null, {
        status: 416,
        headers: { ...baseHeaders, "Content-Range": `bytes */${total}` },
      });
    }
    if (parsed) {
      start = parsed.start;
      end = parsed.end;
      status = 206;
    }
    // parsed === null → malformed; RFC 7233 §3.1 says serve full body.
  }

  if (total === 0) {
    return new Response(new Uint8Array(0), {
      status: 200,
      headers: { ...baseHeaders, "Content-Length": "0" },
    });
  }

  const length = end - start + 1;
  // refcount this read against deferred-unlink so the janitor can't yank
  // the file out from under a slow downloader mid-stream.
  entry.refCount++;

  const nodeStream = createReadStream(entry.filePath, { start, end });
  let settled = false;
  const release = () => {
    if (settled) return;
    settled = true;
    decRefStagedEntry(entry);
  };

  const webStream = new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on("data", (chunk: string | Buffer) => {
        const buf =
          typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
        controller.enqueue(
          new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
        );
      });
      nodeStream.on("end", () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        release();
      });
      nodeStream.on("error", (err: Error) => {
        try {
          controller.error(err);
        } catch {
          /* already errored */
        }
        release();
      });
    },
    cancel() {
      try {
        nodeStream.destroy();
      } catch {
        /* noop */
      }
      release();
    },
  });

  const headers: Record<string, string> = {
    ...baseHeaders,
    "Content-Length": String(length),
  };
  if (status === 206) {
    headers["Content-Range"] = `bytes ${start}-${end}/${total}`;
  }
  return new Response(webStream, { status, headers });
}

/**
 * Convenience wrapper for Hono route handlers.  Derives the job key from
 * `c.req.url` + the caller's session/admin-key, and forwards the standard
 * Range / If-Range headers into `stageAndServeStreamingExport`.
 *
 * Usage:
 *   return await stageStreamingExportFromHono(c, () =>
 *     streamXlsx(sheets, filename, meta));
 */
export async function stageStreamingExportFromHono(
  c: {
    req: {
      url: string;
      method?: string;
      header: (n: string) => string | null | undefined;
    };
  },
  build: () => Promise<Response> | Response,
  options: StreamingExportStagingOptions = {},
): Promise<Response> {
  // Capture wall-clock entry time so we can stamp the response with TTFB
  // and total transfer duration. See § "Streaming-export latency budget"
  // above for the rationale and budget values.
  const startedAt = performance.now();

  const reqHeaders: Record<string, string> = {};
  const range = c.req.header("Range") || c.req.header("range");
  if (range) reqHeaders["range"] = range;
  const ifRange = c.req.header("If-Range") || c.req.header("if-range");
  if (ifRange) reqHeaders["if-range"] = ifRange;

  const userIdentity =
    c.req.header("Cookie") ||
    c.req.header("cookie") ||
    c.req.header("X-Admin-Key") ||
    c.req.header("x-admin-key") ||
    c.req.header("Authorization") ||
    "";

  const method = (c.req.method || "GET").toUpperCase();

  // Normalize the URL before deriving the cache key to prevent cache-bypass
  // attacks where an attacker appends arbitrary nonce query params (e.g.
  // ?nonce=1, ?nonce=2) to create distinct cache keys for identical exports.
  // We canonicalise by sorting query params alphabetically so that
  // ?b=2&a=1 and ?a=1&b=2 map to the same key.  Unknown/nonce params are
  // still included in the sorted key — they appear in every key and therefore
  // don't help an attacker who uses the same session across requests — while
  // the global cache entry/size limits (Task #811) bound the total damage from
  // high-cardinality key flooding.
  let normalizedUrl: string;
  try {
    const parsedUrl = new URL(c.req.url, "<REDACTED_URL>");
    const sortedParams = [...parsedUrl.searchParams.entries()]
      .sort(([a], [b]) => a.localeCompare(b));
    const canonical = new URLSearchParams(sortedParams);
    parsedUrl.search = canonical.toString();
    normalizedUrl = `${parsedUrl.pathname}${parsedUrl.search}`;
  } catch {
    normalizedUrl = c.req.url;
  }

  const jobKey = deriveStreamingExportJobKey({
    url: `${method} ${normalizedUrl}`,
    userIdentity,
  });

  // Hash the raw identity string so the per-user quota tracking map never
  // holds cookie values or admin keys in memory.
  const userIdentityHash = createHash("sha256")
    .update(userIdentity || "anon")
    .digest("hex");

  // Build a stable, low-cardinality route label for log lines. Strip the
  // query string so log aggregation groups requests for the same export
  // endpoint together (different filters land on the same line) and
  // numeric path segments collapse so e.g. /api/audits/42/export-xlsx
  // and /api/audits/99/export-xlsx aggregate to the same label.
  let routeLabel: string;
  try {
    const u = new URL(c.req.url, "<REDACTED_URL>");
    routeLabel = `${method} ${u.pathname.replace(/\/\d+(?=\/|$)/g, "/:id")}`;
  } catch {
    routeLabel = `${method} ${c.req.url}`;
  }

  // Staging is an OPTIMISATION — it buys Range/resume support and lets repeat
  // downloads of the same export skip regeneration. It is not what the caller
  // asked for. When it fails, serve the export directly rather than failing
  // the download: on the HostingPlatform deployment every staged export was returning
  // 500 and taking the whole instance down with it (measured 2026-08-25 —
  // 28s of healthy checks, one export call, 12s of 500s on every route,
  // reproduced on the pre-existing /api/duplicates/export-xlsx as well).
  let resp: Response;
  try {
    resp = await stageAndServeStreamingExport(reqHeaders, jobKey, build, {
      ...options,
      userIdentityHash,
    });
  } catch (err) {
    logger.error(
      "[stagedExport] staging failed — serving the export unstaged instead",
      { route: routeLabel, error: err instanceof Error ? err.message : String(err) },
    );
    return await build();
  }

  // Only instrument 2xx/206 responses — passthrough errors (401/403/500)
  // are not export bodies and would skew the latency log.
  const isStreamingBody = resp.status === 200 || resp.status === 206;
  if (!isStreamingBody) return resp;

  return instrumentExportResponseTiming(resp, startedAt, routeLabel);
}
