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
// Paged-query async generator — cursor-like streaming without pg-query-stream
// ---------------------------------------------------------------------------

/**
 * Yields rows from a paginated DB query without loading the full result set.
 *
 * Usage — feed directly into streamCsv or streamXlsx:
 *
 *   const source = pagedQuery(
 *     (limit, offset) => pool.query('SELECT ... LIMIT $1 OFFSET $2', [limit, offset]),
 *     500        // rows per page (default)
 *   );
 *   return streamCsv(filename, headers, mapToStringRows(source));
 *
 * The generator stops when the final page returns fewer rows than `pageSize`.
 */
export async function* pagedQuery<T = Record<string, unknown>>(
  queryFn: (limit: number, offset: number) => Promise<{ rows: T[] }>,
  pageSize = 500
): AsyncGenerator<T> {
  let offset = 0;
  while (true) {
    const { rows } = await queryFn(pageSize, offset);
    for (const row of rows) yield row;
    if (rows.length < pageSize) break;
    offset += pageSize;
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
