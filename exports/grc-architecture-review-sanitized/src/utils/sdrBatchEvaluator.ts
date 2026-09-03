// =======================================================================
// Medium #9 — LLMProvider Batch API integration for SDR scorecard evaluation.
//
// Bulk path only. Interactive single-call evaluation still uses real-time
// `generateText` (managers expect instant results when they click "Run
// AI Evaluation" on one call). This module is for the "evaluate every
// pending call I uploaded last night" workflow, where we trade 24h
// latency for a 50% discount on the per-token cost.
//
// LLMProvider Batch API contract (raw fetch — no SDK dependency):
//   1. Upload a .jsonl file via POST /v1/files with purpose="batch".
//      Each line is one chat/completions request keyed by custom_id.
//   2. Create the batch with POST /v1/batches referencing the file id,
//      endpoint "/v1/chat/completions", completion_window "24h".
//   3. Poll GET /v1/batches/:id until status becomes "completed".
//   4. Download the output file via GET /v1/files/:id/content — each
//      output line has the custom_id and either response or error.
//   5. Parse each line, save successful evaluations through the
//      existing saveSDREvaluation() helper so Analytics and the SDR
//      Evaluation tab see them just like real-time evaluations.
//
// Idempotency: a call_id can be in at most one open batch at a time.
// The eligibility query excludes anything already queued.
// =======================================================================

import { createRedactedPool } from "./redactedPool";
import { logger } from "./logger";
import { getLLMProviderApiKey, getLLMProviderBaseUrl } from "./LLMProviderCredentials";
import { logEvent } from "./eventLogsDatabase";
import {
  getActiveSDRScorecard,
  buildSDREvaluationPrompt,
  saveSDREvaluation,
  updateCallStatus,
  type SDRCallEvaluation,
} from "./callIntelligenceDb";

const pool = createRedactedPool({
  connectionString: process.env.DATABASE_URL,
});

// LLMProvider Batch API states. completed/failed/cancelled/expired are
// terminal — the poller skips batches in any terminal state.
export type BatchStatus =
  | "validating"
  | "in_progress"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

const OPEN_BATCH_STATUSES: BatchStatus[] = [
  "validating",
  "in_progress",
  "finalizing",
];

export interface SDRBatchJob {
  id: number;
  LLMProvider_batch_id: string | null;
  LLMProvider_input_file_id: string | null;
  LLMProvider_output_file_id: string | null;
  status: BatchStatus | "submission_failed";
  call_count: number;
  processed_count: number;
  failed_count: number;
  scorecard_id: number | null;
  scorecard_name: string | null;
  submitted_by: string | null;
  submitted_at: Date;
  completed_at: Date | null;
  error_message: string | null;
  metadata: any;
}

async function ensureSDRBatchJobsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sdr_batch_jobs (
      id SERIAL PRIMARY KEY,
      LLMProvider_batch_id VARCHAR(100) UNIQUE,
      LLMProvider_input_file_id VARCHAR(100),
      LLMProvider_output_file_id VARCHAR(100),
      status VARCHAR(32) NOT NULL DEFAULT 'validating',
      call_count INTEGER NOT NULL DEFAULT 0,
      processed_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      scorecard_id INTEGER,
      scorecard_name VARCHAR(255),
      submitted_by VARCHAR(255),
      submitted_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      error_message TEXT,
      metadata JSONB DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_sdr_batch_jobs_status ON sdr_batch_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_sdr_batch_jobs_submitted ON sdr_batch_jobs(submitted_at DESC);
  `);
}

// ============================== HTTP helpers ============================

function LLMProviderBatchBase(): string {
  // Always resolve at call-time — secrets may have been swapped (e.g. the
  // modelfarm proxy bug from the prior session). Falls back to the public
  // LLMProvider API so the batch path keeps working even if AI_INTEGRATIONS_*
  // is unset.
  return getLLMProviderBaseUrl() || "<REDACTED_URL>";
}

function authHeader(): Record<string, string> {
  const key = getLLMProviderApiKey();
  if (!key) {
    throw new Error("LLMProvider_API_KEY is not configured — cannot submit batch");
  }
  return { Authorization: `Bearer ${key}` };
}

async function LLMProviderFetch(
  path: string,
  init: RequestInit & { responseType?: "json" | "text" } = {},
): Promise<any> {
  const url = `${LLMProviderBatchBase()}${path}`;
  const headers: Record<string, string> = {
    ...authHeader(),
    ...((init.headers as Record<string, string>) || {}),
  };
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const errorBody = await res.text().catch(() => "");
    throw new Error(
      `LLMProvider ${path} returned ${res.status}: ${errorBody.slice(0, 500)}`,
    );
  }
  if (init.responseType === "text") return res.text();
  return res.json();
}

// =========================== Files API ============================

async function uploadBatchInputFile(jsonl: string): Promise<string> {
  const blob = new Blob([jsonl], { type: "application/jsonl" });
  const form = new FormData();
  form.append("purpose", "batch");
  form.append("file", blob, "sdr-batch-input.jsonl");

  const data = await LLMProviderFetch("/files", { method: "POST", body: form });
  if (!data?.id) {
    throw new Error("LLMProvider /files response missing id field");
  }
  return data.id as string;
}

async function downloadFileContent(fileId: string): Promise<string> {
  return LLMProviderFetch(`/files/${fileId}/content`, { responseType: "text" });
}

// =========================== Batches API ==========================

async function createBatch(
  inputFileId: string,
  metadata: Record<string, string>,
): Promise<{ id: string; status: BatchStatus }> {
  const body = JSON.stringify({
    input_file_id: inputFileId,
    endpoint: "/v1/chat/completions",
    completion_window: "24h",
    metadata,
  });
  const data = await LLMProviderFetch("/batches", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!data?.id) throw new Error("LLMProvider /batches response missing id");
  return { id: data.id, status: data.status as BatchStatus };
}

async function retrieveBatch(batchId: string): Promise<{
  id: string;
  status: BatchStatus;
  output_file_id: string | null;
  error_file_id: string | null;
  request_counts?: { total?: number; completed?: number; failed?: number };
  errors?: any;
}> {
  return LLMProviderFetch(`/batches/${batchId}`);
}

// =========================== JSONL builder ========================

interface EligibleCall {
  call_record_id: number;
  transcript_text: string;
}

export function buildBatchJsonl(
  calls: EligibleCall[],
  scorecard: any,
): string {
  const lines = calls.map((c) => {
    const prompt = buildSDREvaluationPrompt(c.transcript_text, scorecard);
    return JSON.stringify({
      custom_id: `sdr-eval-${c.call_record_id}`,
      method: "POST",
      url: "/v1/chat/completions",
      body: {
        // gpt-4o-mini matches the real-time path. Batch API discount
        // applies on top of the already-cheap mini pricing.
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 8000,
      },
    });
  });
  return lines.join("\n") + "\n";
}

// ============================ Eligibility =========================

export async function getEligibleCalls(limit = 200): Promise<EligibleCall[]> {
  // A call is eligible for batch evaluation when:
  //   1. It has a transcript (we can't evaluate audio in batch mode).
  //   2. No sdr_call_evaluations row exists yet.
  //   3. It is not already referenced in any open batch's metadata.call_ids.
  await ensureSDRBatchJobsTable();
  const result = await pool.query(
    `
    WITH open_batch_calls AS (
      SELECT DISTINCT jsonb_array_elements_text(metadata->'call_ids')::int AS call_id
      FROM sdr_batch_jobs
      WHERE status = ANY($1::text[])
    )
    SELECT cr.id AS call_record_id, ct.transcript_text
    FROM call_records cr
    JOIN call_transcripts ct ON ct.call_record_id = cr.id
    LEFT JOIN sdr_call_evaluations se ON se.call_record_id = cr.id
    WHERE se.id IS NULL
      AND cr.id NOT IN (SELECT call_id FROM open_batch_calls)
      AND ct.transcript_text IS NOT NULL
      AND length(ct.transcript_text) > 20
    ORDER BY cr.created_at ASC
    LIMIT $2
    `,
    [OPEN_BATCH_STATUSES, limit],
  );
  return result.rows.map((r) => ({
    call_record_id: r.call_record_id,
    transcript_text: r.transcript_text,
  }));
}

// ============================= Submission =========================

// Single shared advisory-lock key for the batch-submit critical section.
// 32-bit signed int chosen by hashing "sdr_batch_submit" — any constant
// works as long as it's unique to this code path within the database.
const SUBMIT_BATCH_ADVISORY_LOCK_KEY = 871_452_193;

export async function submitPendingForBatch(opts: {
  scorecardTeam?: string;
  submittedBy?: string;
  maxCalls?: number;
}): Promise<{
  batchJobId: number;
  LLMProviderBatchId: string;
  callCount: number;
}> {
  await ensureSDRBatchJobsTable();
  const scorecard = await getActiveSDRScorecard(opts.scorecardTeam || "SDR");
  if (!scorecard) {
    throw new Error("No active SDR scorecard configured");
  }

  // Run the eligibility check + job row insert under a transaction-scoped
  // advisory lock so two concurrent POSTs cannot pass the eligibility
  // gate in parallel and double-bill LLMProvider for the same call_ids. The
  // lock releases automatically when the transaction commits or rolls
  // back; we hold a single client through the critical section. The
  // outbound LLMProvider calls happen AFTER COMMIT so we don't hold the lock
  // across slow network IO.
  const client = await pool.connect();
  let batchJobId: number;
  let eligible: EligibleCall[];
  let jsonl: string;
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock($1)`, [
      SUBMIT_BATCH_ADVISORY_LOCK_KEY,
    ]);

    eligible = await getEligibleCalls(opts.maxCalls || 200);
    if (eligible.length === 0) {
      await client.query("ROLLBACK");
      throw new Error("No eligible calls — nothing to batch");
    }

    jsonl = buildBatchJsonl(eligible, scorecard);
    const callIds = eligible.map((c) => c.call_record_id);

    // Insert the job row up front in a placeholder state so we have a
    // durable record even if the LLMProvider submission fails midway. If
    // file upload or batch create errors, we mark it submission_failed;
    // the poller ignores it and the row stays as evidence in the UI.
    // Within the advisory lock so the next caller's eligibility check
    // sees these call_ids as already-queued.
    const insertRes = await client.query(
      `
      INSERT INTO sdr_batch_jobs (
        status, call_count, scorecard_id, scorecard_name,
        submitted_by, metadata
      ) VALUES ('validating', $1, $2, $3, $4, $5)
      RETURNING id
      `,
      [
        eligible.length,
        scorecard.id,
        scorecard.name,
        opts.submittedBy || null,
        JSON.stringify({ call_ids: callIds }),
      ],
    );
    batchJobId = insertRes.rows[0].id;
    await client.query("COMMIT");
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }

  try {
    logger.info(`[SDRBatch] Uploading input file for ${eligible.length} calls`);
    const inputFileId = await uploadBatchInputFile(jsonl);
    const created = await createBatch(inputFileId, {
      sdr_batch_job_id: String(batchJobId),
      scorecard_id: String(scorecard.id),
    });
    await pool.query(
      `UPDATE sdr_batch_jobs
       SET LLMProvider_input_file_id = $1, LLMProvider_batch_id = $2, status = $3
       WHERE id = $4`,
      [inputFileId, created.id, created.status, batchJobId],
    );

    try {
      await logEvent({
        actionType: "sdr_batch_submitted",
        entityType: "sdr_batch_job",
        entityId: String(batchJobId),
        module: "calls",
        severity: "INFO",
        aiInvolved: true,
        description: `SDR batch evaluation submitted — ${eligible.length} call(s), scorecard "${scorecard.name}", LLMProvider batch ${created.id}`,
        newValue: {
          batch_job_id: batchJobId,
          LLMProvider_batch_id: created.id,
          call_count: eligible.length,
          scorecard_id: scorecard.id,
        },
      });
    } catch (logErr: any) {
      logger.warn(`[SDRBatch] event_logs audit write failed: ${logErr?.message}`);
    }

    return {
      batchJobId,
      LLMProviderBatchId: created.id,
      callCount: eligible.length,
    };
  } catch (err: any) {
    await pool.query(
      `UPDATE sdr_batch_jobs
       SET status = 'submission_failed', error_message = $1, completed_at = NOW()
       WHERE id = $2`,
      [err?.message || String(err), batchJobId],
    );
    throw err;
  }
}

// ============================== Poller ===========================

export async function pollAndProcessOpenBatches(): Promise<{
  inspected: number;
  completed: number;
  evaluations_saved: number;
  failed_lines: number;
}> {
  await ensureSDRBatchJobsTable();

  // Claim open jobs row-by-row with SELECT FOR UPDATE SKIP LOCKED so two
  // concurrent pollers (Inngest cron + manual sync, or two Inngest
  // workers) cannot process the same LLMProvider batch twice — duplicate
  // processing wastes a download, duplicates event_logs entries, and
  // double-logs the audit trail. Per-row transactions release locks
  // promptly even when the LLMProvider fetch hangs on one batch.
  const candidateIds = await pool.query(
    `SELECT id FROM sdr_batch_jobs
       WHERE status = ANY($1::text[]) AND LLMProvider_batch_id IS NOT NULL
       ORDER BY submitted_at ASC`,
    [OPEN_BATCH_STATUSES],
  );

  let inspected = 0;
  let completed = 0;
  let evaluationsSaved = 0;
  let failedLines = 0;

  for (const candidate of candidateIds.rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const claim = await client.query(
        `SELECT * FROM sdr_batch_jobs
           WHERE id = $1 AND status = ANY($2::text[]) AND LLMProvider_batch_id IS NOT NULL
           FOR UPDATE SKIP LOCKED`,
        [candidate.id, OPEN_BATCH_STATUSES],
      );
      if (claim.rows.length === 0) {
        // Another worker grabbed this row (or it transitioned to a
        // terminal state between candidate fetch and lock attempt).
        await client.query("COMMIT");
        continue;
      }
      const job = claim.rows[0];
      inspected += 1;

      try {
        const live = await retrieveBatch(job.LLMProvider_batch_id);
        // Always reflect the latest status — managers see in_progress
        // transition to finalizing in the UI between poll runs.
        if (live.status !== job.status) {
          await client.query(
            `UPDATE sdr_batch_jobs SET status = $1 WHERE id = $2`,
            [live.status, job.id],
          );
        }
        if (live.status !== "completed") {
          await client.query("COMMIT");
          continue;
        }

        // Completed — fetch the output file and process each line.
        if (!live.output_file_id) {
          await client.query(
            `UPDATE sdr_batch_jobs
               SET status = 'failed', error_message = $1, completed_at = NOW()
               WHERE id = $2`,
            ["Batch completed but no output_file_id", job.id],
          );
          await client.query("COMMIT");
          continue;
        }
        const outputJsonl = await downloadFileContent(live.output_file_id);
        const result = await processBatchOutput(
          job.id,
          outputJsonl,
          job.scorecard_id,
          job.scorecard_name,
        );
        evaluationsSaved += result.saved;
        failedLines += result.failed;

        await client.query(
          `UPDATE sdr_batch_jobs
             SET status = 'completed', completed_at = NOW(),
                 LLMProvider_output_file_id = $1,
                 processed_count = $2, failed_count = $3
             WHERE id = $4`,
          [live.output_file_id, result.saved, result.failed, job.id],
        );
        completed += 1;
        await client.query("COMMIT");

        try {
          await logEvent({
            actionType: "sdr_batch_completed",
            entityType: "sdr_batch_job",
            entityId: String(job.id),
            module: "calls",
            severity: result.failed > 0 ? "WARNING" : "INFO",
            aiInvolved: true,
            description: `SDR batch ${job.LLMProvider_batch_id} completed — ${result.saved} evaluation(s) saved, ${result.failed} failed`,
            newValue: {
              batch_job_id: job.id,
              LLMProvider_batch_id: job.LLMProvider_batch_id,
              saved: result.saved,
              failed: result.failed,
            },
          });
        } catch (logErr: any) {
          logger.warn(`[SDRBatch] event_logs audit write failed: ${logErr?.message}`);
        }
      } catch (err: any) {
        // Transient poll error — rollback the status change so the next
        // pass retries from the same starting state. Don't mark the job
        // failed: LLMProvider itself returns a terminal status when the batch
        // truly fails (handled in the live.status branch above).
        await client.query("ROLLBACK");
        logger.warn(
          `[SDRBatch] Poll for job ${job.id} (${job.LLMProvider_batch_id}) failed: ${err?.message}`,
        );
      }
    } catch (outerErr: any) {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
      logger.warn(
        `[SDRBatch] Lock/claim failed for job ${candidate.id}: ${outerErr?.message}`,
      );
    } finally {
      client.release();
    }
  }

  return {
    inspected,
    completed,
    evaluations_saved: evaluationsSaved,
    failed_lines: failedLines,
  };
}

// =========================== Output parsing ========================

interface BatchOutputLine {
  custom_id: string;
  response?: { status_code: number; body: any };
  error?: any;
}

export function parseOutputJsonl(jsonl: string): BatchOutputLine[] {
  return jsonl
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as BatchOutputLine;
      } catch {
        return null;
      }
    })
    .filter((x): x is BatchOutputLine => x !== null);
}

async function processBatchOutput(
  batchJobId: number,
  outputJsonl: string,
  scorecardId: number | null,
  scorecardName: string | null,
): Promise<{ saved: number; failed: number }> {
  const lines = parseOutputJsonl(outputJsonl);
  let saved = 0;
  let failed = 0;

  for (const line of lines) {
    const callId = parseCallIdFromCustomId(line.custom_id);
    if (!callId) {
      failed += 1;
      continue;
    }
    if (line.error || !line.response || line.response.status_code !== 200) {
      logger.warn(
        `[SDRBatch] Line failed for call ${callId}: ${JSON.stringify(line.error || "non-200")}`,
      );
      failed += 1;
      continue;
    }
    try {
      const content =
        line.response.body?.choices?.[0]?.message?.content?.trim?.() || "";
      const cleaned = content.replace(/```json\n?|\n?```/g, "").trim();
      const evaluationData = JSON.parse(cleaned);
      const evaluation: SDRCallEvaluation = {
        call_record_id: callId,
        scorecard_id: scorecardId ?? 0,
        scorecard_name: scorecardName ?? "",
        overall_score: evaluationData.overall_summary?.overall_score || 0,
        dimension_scores: evaluationData.overall_summary?.dimension_scores || {
          people: 0,
          process: 0,
          governance: 0,
        },
        attribute_evaluations: evaluationData.attribute_evaluations || [],
        top_strengths: evaluationData.overall_summary?.top_strengths || [],
        top_gaps: evaluationData.overall_summary?.top_gaps || [],
        coaching_actions:
          evaluationData.overall_summary?.coaching_actions || [],
        critical_risks: evaluationData.overall_summary?.critical_risks || [],
        coaching_message_ar:
          evaluationData.coaching_recommendation?.message_ar || "",
        coaching_message_en:
          evaluationData.coaching_recommendation?.message_en || "",
        micro_training_topics:
          evaluationData.coaching_recommendation?.micro_training_topics || [],
        key_moments: evaluationData.transcript_analysis?.key_moments || {},
        evaluated_at: new Date(),
      };
      await saveSDREvaluation(evaluation);
      await updateCallStatus(callId, "evaluated");
      saved += 1;
    } catch (err: any) {
      logger.warn(
        `[SDRBatch] Parse/save failed for call ${callId} in batch ${batchJobId}: ${err?.message}`,
      );
      failed += 1;
    }
  }

  return { saved, failed };
}

function parseCallIdFromCustomId(customId: string): number | null {
  const m = customId.match(/^sdr-eval-(\d+)$/);
  if (!m) return null;
  const id = parseInt(m[1], 10);
  return Number.isFinite(id) ? id : null;
}

// ============================== Queries ===========================

export async function listBatchJobs(limit = 50): Promise<SDRBatchJob[]> {
  await ensureSDRBatchJobsTable();
  const r = await pool.query(
    `SELECT * FROM sdr_batch_jobs ORDER BY submitted_at DESC LIMIT $1`,
    [limit],
  );
  return r.rows;
}

export async function getBatchJob(id: number): Promise<SDRBatchJob | null> {
  await ensureSDRBatchJobsTable();
  const r = await pool.query(`SELECT * FROM sdr_batch_jobs WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

export async function countEligibleCalls(): Promise<number> {
  await ensureSDRBatchJobsTable();
  const r = await pool.query(
    `
    WITH open_batch_calls AS (
      SELECT DISTINCT jsonb_array_elements_text(metadata->'call_ids')::int AS call_id
      FROM sdr_batch_jobs
      WHERE status = ANY($1::text[])
    )
    SELECT COUNT(*)::int AS n
    FROM call_records cr
    JOIN call_transcripts ct ON ct.call_record_id = cr.id
    LEFT JOIN sdr_call_evaluations se ON se.call_record_id = cr.id
    WHERE se.id IS NULL
      AND cr.id NOT IN (SELECT call_id FROM open_batch_calls)
      AND ct.transcript_text IS NOT NULL
      AND length(ct.transcript_text) > 20
    `,
    [OPEN_BATCH_STATUSES],
  );
  return r.rows[0]?.n || 0;
}
