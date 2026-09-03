/**
 * Export size-estimate helpers.
 *
 * Streaming export endpoints (e.g. `/api/risks/export-xlsx`) cannot send a
 * `Content-Length` header because the body is generated on the fly. The
 * downstream `streaming-download.js` helper therefore has to assume "could
 * be large" and prompt the File System Access save-as picker for every call
 * in Chromium — friction users do not want for a few-KB CSV.
 *
 * To remove that friction, every streaming export route exposes a sibling
 * `…/estimate` GET endpoint that returns:
 *
 *   { rows: number, bytes: number, format: 'csv' | 'xlsx' }
 *
 * along with `X-Estimated-Rows` / `X-Estimated-Bytes` / `X-Export-Format`
 * response headers (so the client can use a HEAD-style check too).
 *
 * The client uses `bytes` to:
 *   - decide between the silent Blob path and the picker
 *     (see `shouldStreamToDisk` in dashboard/js/streaming-download.js), and
 *   - render an "≈ X MB" hint on export buttons before the user clicks.
 *
 * Estimates are intentionally cheap: a single `SELECT COUNT(*)` plus an
 * average-bytes-per-row heuristic keyed by format. Accuracy within ~30%
 * is sufficient — the only branch that matters is "above or below the
 * 10 MB picker threshold".
 */

export type ExportFormat = 'csv' | 'xlsx';

export interface ExportEstimate {
  rows: number;
  bytes: number;
  format: ExportFormat;
}

/**
 * Per-format average bytes/row when callers don't override.
 *
 *   CSV  — typical ExampleOrg row across audit/risk/vendor/log tables
 *          sits around 180-220 bytes when comma-joined and CRLF-terminated.
 *   XLSX — uncompressed sheet XML averages ~140 bytes/row; ZIP compression
 *          inside the .xlsx container drops that to ~80-100 bytes/row for
 *          our typical workloads, but we round up to stay conservative so
 *          the picker fires whenever the export might cross the threshold.
 */
const DEFAULT_BYTES_PER_ROW: Record<ExportFormat, number> = {
  csv: 200,
  xlsx: 120,
};

/** Per-export fixed overhead — header row, sheet preamble, ZIP central dir. */
const FIXED_OVERHEAD_BYTES: Record<ExportFormat, number> = {
  csv: 256,
  xlsx: 8 * 1024,
};

/**
 * Estimate total response bytes from a row count and an optional per-row
 * byte hint. The hint defaults to a sensible per-format average.
 */
export function estimateBytesFromRows(
  rows: number,
  format: ExportFormat,
  avgBytesPerRow?: number,
): number {
  if (!Number.isFinite(rows) || rows <= 0) return FIXED_OVERHEAD_BYTES[format];
  const perRow = typeof avgBytesPerRow === 'number' && avgBytesPerRow > 0
    ? avgBytesPerRow
    : DEFAULT_BYTES_PER_ROW[format];
  return Math.round(rows * perRow) + FIXED_OVERHEAD_BYTES[format];
}

/**
 * Build a Hono-compatible Response carrying the estimate as both a JSON
 * body and a set of `X-Estimated-*` headers. The headers are duplicated so
 * a HEAD-style probe (or a fetch that bails on the body) can still read the
 * numbers off the response without parsing JSON.
 *
 * Cached for at most a few minutes — row counts shift as users add data.
 */
export function estimateResponse(estimate: ExportEstimate): Response {
  const body = JSON.stringify({
    rows: Math.max(0, Math.floor(estimate.rows || 0)),
    bytes: Math.max(0, Math.floor(estimate.bytes || 0)),
    format: estimate.format,
  });
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, max-age=60',
      'X-Estimated-Rows': String(Math.max(0, Math.floor(estimate.rows || 0))),
      'X-Estimated-Bytes': String(Math.max(0, Math.floor(estimate.bytes || 0))),
      'X-Export-Format': estimate.format,
    },
  });
}

/**
 * Convenience: run a `SELECT COUNT(*) AS total` style query and turn the
 * result into a full ExportEstimate. Callers pass the already-built SQL +
 * params so this stays a thin wrapper around their own filter logic.
 *
 *   const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS total FROM …`, params);
 *   return estimateResponse(estimateFromCount(countRows[0]?.total, 'xlsx'));
 */
export function estimateFromCount(
  total: number | string | null | undefined,
  format: ExportFormat,
  avgBytesPerRow?: number,
): ExportEstimate {
  const rows = typeof total === 'string' ? parseInt(total, 10) : (total ?? 0);
  const safeRows = Number.isFinite(rows) && rows > 0 ? rows : 0;
  return {
    rows: safeRows,
    bytes: estimateBytesFromRows(safeRows, format, avgBytesPerRow),
    format,
  };
}
