/**
 * Call pipeline watchdog (Phase 3c).
 *
 * The /api/calls/upload + /api/calls/upload-audio handlers run the full
 * transcribe → analyze → SDR-evaluate pipeline inline so a clean upload
 * lands in `evaluated` (or `qa_review_pending`) before the response
 * returns. The downside of inline execution is that if the server is
 * killed mid-request — HostingPlatform redeploy, OOM, container restart — the
 * call row is stranded mid-pipeline at `transcribing` or `evaluating`
 * and never moves forward without manual intervention.
 *
 * This watchdog closes that gap. Every N minutes (driven by the
 * `call-pipeline-watchdog` Inngest cron) it scans call_records for
 * rows whose status is one of the in-flight states AND whose
 * updated_at is older than the configured stuck-threshold. For each:
 *
 *   - transcribing  → try to resume transcription if audio file/blob
 *                     is still recoverable, then re-fire auto-eval.
 *                     If transcription cannot be resumed (file gone,
 *                     audio_blob NULL), flip status to `failed` with
 *                     an explanatory note in metadata.last_pipeline_error.
 *
 *   - evaluating    → re-run triggerSDREvaluationForCall directly.
 *                     A transcript already exists by this point (status
 *                     was promoted past `transcribed` before stalling),
 *                     so the auto-evaluator's no_transcript guard won't
 *                     fire.
 *
 * Idempotent — re-scanning a row that's already past the stuck threshold
 * just retries the same operation. The mid-eval skip-reason path inside
 * sdrAutoEvaluator already handles "called again on the same call" by
 * inserting a new evaluation row, so a watchdog retry never invalidates
 * a previous attempt's audit trail.
 *
 * Threshold and limits are tunable via env so the watchdog can be
 * relaxed during a known-slow Whisper window or a backfill.
 */

import { logger } from "./logger";

export interface WatchdogResult {
  scanned: number;
  resumed_transcribe: number;
  resumed_evaluate: number;
  marked_failed: number;
  errors: number;
  error_samples: string[];
  duration_ms: number;
  threshold_minutes: number;
  batch_size: number;
}

const STUCK_THRESHOLD_MINUTES = (() => {
  const raw = process.env.CALL_PIPELINE_WATCHDOG_STUCK_MIN;
  const parsed = parseInt(raw ?? "10", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
})();

const BATCH_SIZE = (() => {
  const raw = process.env.CALL_PIPELINE_WATCHDOG_BATCH;
  const parsed = parseInt(raw ?? "25", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 25;
})();

/**
 * Run one watchdog pass. Returns a structured summary so the cron
 * step can log + audit-trail in a single place.
 */
export async function runCallPipelineWatchdog(): Promise<WatchdogResult> {
  const t0 = Date.now();
  const result: WatchdogResult = {
    scanned: 0,
    resumed_transcribe: 0,
    resumed_evaluate: 0,
    marked_failed: 0,
    errors: 0,
    error_samples: [],
    duration_ms: 0,
    threshold_minutes: STUCK_THRESHOLD_MINUTES,
    batch_size: BATCH_SIZE,
  };

  try {
    const { callIntelligencePool } = await import("./callIntelligenceDb");

    // Pull the stuck batch. We sort oldest-first so the worst-stuck
    // rows are picked up before fresher stalls — important when the
    // watchdog only sees a slice of the backlog each pass.
    const stuckRows = await callIntelligencePool.query<{
      id: number;
      status: string;
      audio_file_path: string | null;
      recording_url: string | null;
      updated_at: Date;
      agent_email: string | null;
    }>(
      `SELECT id, status, audio_file_path, recording_url, updated_at, agent_email
         FROM call_records
        WHERE status IN ('transcribing','evaluating')
          AND updated_at < NOW() - ($1::int * INTERVAL '1 minute')
        ORDER BY updated_at ASC
        LIMIT $2`,
      [STUCK_THRESHOLD_MINUTES, BATCH_SIZE],
    );

    result.scanned = stuckRows.rowCount ?? 0;
    if (result.scanned === 0) {
      result.duration_ms = Date.now() - t0;
      return result;
    }

    const {
      triggerSDREvaluationForCall,
    } = await import("./sdrAutoEvaluator");
    const { updateCallRecord } = await import("./callIntelligenceDb");

    for (const row of stuckRows.rows) {
      try {
        if (row.status === "evaluating") {
          // Easy path: transcript already exists. Re-fire the auto-eval
          // which will either succeed and flip status to evaluated /
          // qa_review_pending, or surface its own skip reason that the
          // operator can act on from the dashboard.
          const outcome = await triggerSDREvaluationForCall(row.id, "SDR");
          if (outcome.ran) {
            result.resumed_evaluate++;
            logger.info(
              `[CallWatchdog] Re-fired evaluation for call ${row.id} ` +
                `(was stuck ${Math.round(
                  (Date.now() - new Date(row.updated_at).getTime()) / 60000,
                )}m); ` +
                `routed to ${outcome.postEvalStatus} ` +
                `(score=${outcome.overallScore})`,
            );
          } else if (outcome.skipReason === "no_transcript") {
            // Transcript vanished — re-classify so we don't keep
            // re-trying the evaluator on a row that needs the
            // transcribe stage rerun first.
            await updateCallRecord(row.id, { status: "uploaded" });
            logger.warn(
              `[CallWatchdog] Call ${row.id} stuck at 'evaluating' but ` +
                `transcript is missing; demoted to 'uploaded' for a clean retry.`,
            );
          } else {
            // Any other skip reason (no scorecard, AI failure) is logged
            // and left in place — operator can re-run from the Call
            // Records tab. We do NOT auto-mark failed here because the
            // skip reason may be a transient external dependency.
            logger.info(
              `[CallWatchdog] Re-fired evaluation for call ${row.id} skipped: ${outcome.skipReason}`,
            );
          }
        } else {
          // transcribing — far less common (Whisper is fast), but
          // possible if the server died mid-transcription. We don't
          // re-attempt transcription inside the watchdog because the
          // LLMProvider call needs the original Audio buffer; the upload
          // endpoint already discarded the FormData. Mark as failed
          // so the operator can re-upload, with a clear reason in
          // metadata.
          await updateCallRecord(row.id, {
            status: "failed",
            ai_insights: JSON.stringify({
              last_pipeline_error:
                `Transcription stalled for >${STUCK_THRESHOLD_MINUTES} ` +
                `minutes; watchdog promoted to 'failed' for re-upload.`,
              last_pipeline_error_stage: "transcribing",
              watchdog_marked_at: new Date().toISOString(),
            }),
          });
          result.marked_failed++;
          logger.warn(
            `[CallWatchdog] Call ${row.id} stuck at 'transcribing' ` +
              `for >${STUCK_THRESHOLD_MINUTES}m; marked failed.`,
          );
        }
      } catch (rowErr: any) {
        result.errors++;
        if (result.error_samples.length < 5) {
          result.error_samples.push(
            `${row.id}: ${(rowErr?.message || String(rowErr)).slice(0, 200)}`,
          );
        }
        logger.warn(
          `[CallWatchdog] Row ${row.id} retry threw:`,
          rowErr?.message || rowErr,
        );
      }
    }
  } catch (err: any) {
    result.errors++;
    result.error_samples.push(
      `watchdog_top: ${(err?.message || String(err)).slice(0, 200)}`,
    );
    logger.error("[CallWatchdog] Top-level scan failed:", err);
  }

  result.duration_ms = Date.now() - t0;
  return result;
}
