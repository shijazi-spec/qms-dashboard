/**
 * Server-side duration backfill (Phase 4b).
 *
 * Every call_record uploaded through /api/calls/upload-audio after the
 * Whisper verbose_json fix lands with a populated `duration_seconds`
 * column — the transcription response includes the audio duration and
 * the upload handler persists it inline. Records uploaded BEFORE that
 * fix landed in the table with `duration_seconds = NULL`, which is why
 * the Call Records table shows `--` for the legacy batch (208 historical
 * rows in production at the time of writing).
 *
 * There's already a client-side eager backfill in calls.html
 * (`eagerBackfillDurations`) that mounts a hidden <audio> tag per
 * visible row and POSTs the discovered duration. It works, but only
 * heals the rows the operator paginates through, and only one page at a
 * time. For a large legacy backlog that's slow and easy to miss.
 *
 * This server-side helper closes the gap. It selects every row with
 * `audio_blob` present AND `duration_seconds` missing, decodes the
 * audio metadata with `music-metadata`, and writes back the duration.
 * music-metadata is pure JS (no ffprobe/ffmpeg native deps), supports
 * WAV / MP3 / M4A / MP4 / OGG / WebM, and parses headers cheaply (no
 * full decode), so a batch of a few hundred files runs in seconds.
 *
 * Rows without `audio_blob` (the historical bulk-upload path didn't
 * persist bytes — see commit 759e1ae) are reported as "unrecoverable"
 * in the summary and left alone; their duration is permanently gone.
 *
 * Idempotent — re-running after a full backfill is a quiet no-op
 * because the WHERE clause excludes already-populated rows.
 */

import { logger } from "./logger";

export interface DurationBackfillResult {
  scanned: number;
  /** Rows with audio_blob present and duration_seconds set. */
  populated: number;
  /** Rows where music-metadata returned no duration (corrupt / unknown codec). */
  parsed_zero: number;
  /** Rows that errored during decode (kept null). */
  parse_failed: number;
  /** Rows with no audio_blob at all (legacy bulk uploads, audio long gone). */
  unrecoverable: number;
  errors: number;
  error_samples: string[];
  duration_ms: number;
  /** Max rows scanned in this pass, controls batch size. */
  batch_size: number;
}

const BATCH_SIZE = (() => {
  const raw = process.env.CALL_DURATION_BACKFILL_BATCH;
  const parsed = parseInt(raw ?? "500", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 500;
})();

/**
 * Run one duration-backfill pass. Returns a structured summary so the
 * caller (HTTP endpoint or cron) can render progress.
 */
export async function runCallDurationBackfill(
  options: { limit?: number } = {},
): Promise<DurationBackfillResult> {
  const t0 = Date.now();
  const limit = options.limit ?? BATCH_SIZE;
  const result: DurationBackfillResult = {
    scanned: 0,
    populated: 0,
    parsed_zero: 0,
    parse_failed: 0,
    unrecoverable: 0,
    errors: 0,
    error_samples: [],
    duration_ms: 0,
    batch_size: limit,
  };

  try {
    const { callIntelligencePool } = await import("./callIntelligenceDb");

    // First pass: count the truly-unrecoverable rows so the summary
    // is honest about the upper bound. Cheap — single indexed scan.
    const unrec = await callIntelligencePool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n
         FROM call_records
        WHERE (duration_seconds IS NULL OR duration_seconds <= 0)
          AND audio_blob IS NULL`,
    );
    result.unrecoverable = unrec.rows[0]?.n ?? 0;

    // Recoverable batch: rows with audio_blob present, duration missing.
    const recoverable = await callIntelligencePool.query<{
      id: number;
      audio_blob: Buffer;
      audio_blob_mime: string | null;
    }>(
      `SELECT id, audio_blob, audio_blob_mime
         FROM call_records
        WHERE (duration_seconds IS NULL OR duration_seconds <= 0)
          AND audio_blob IS NOT NULL
        ORDER BY id ASC
        LIMIT $1`,
      [limit],
    );

    result.scanned = recoverable.rowCount ?? 0;
    if (result.scanned === 0) {
      result.duration_ms = Date.now() - t0;
      return result;
    }

    // music-metadata is ESM-only in v11+. Dynamic import sidesteps the
    // CJS/ESM impedance the codebase resolves the same way elsewhere
    // (e.g. dynamic imports of `ai`, `@ai-sdk/openai`).
    const mm = await import("music-metadata");

    for (const row of recoverable.rows) {
      try {
        const buf = row.audio_blob;
        if (!buf || buf.length === 0) {
          result.parse_failed++;
          continue;
        }
        // parseBuffer accepts (buffer, options) in v11+. The mimeType
        // hint is optional — music-metadata sniffs the container from
        // magic bytes — but passing it speeds parsing on ambiguous
        // headers (small WAV files with a non-RIFF first chunk).
        const metadata = await mm.parseBuffer(buf, {
          mimeType: row.audio_blob_mime || undefined,
        });
        const dur =
          typeof metadata.format.duration === "number"
            ? metadata.format.duration
            : 0;
        if (!Number.isFinite(dur) || dur <= 0) {
          result.parsed_zero++;
          continue;
        }
        const durSec = Math.round(dur);
        await callIntelligencePool.query(
          `UPDATE call_records
              SET duration_seconds = $1,
                  updated_at       = NOW()
            WHERE id = $2
              AND (duration_seconds IS NULL OR duration_seconds <= 0)`,
          [durSec, row.id],
        );
        result.populated++;
      } catch (rowErr: any) {
        result.parse_failed++;
        result.errors++;
        if (result.error_samples.length < 5) {
          result.error_samples.push(
            `${row.id}: ${(rowErr?.message || String(rowErr)).slice(0, 200)}`,
          );
        }
        logger.warn("[DurationBackfill] row failed", {
          id: row.id,
          error: rowErr?.message || String(rowErr),
        });
      }
    }
  } catch (err: any) {
    result.errors++;
    result.error_samples.push(
      `top: ${(err?.message || String(err)).slice(0, 200)}`,
    );
    logger.error("[DurationBackfill] top-level scan failed:", err);
  }

  result.duration_ms = Date.now() - t0;
  return result;
}
