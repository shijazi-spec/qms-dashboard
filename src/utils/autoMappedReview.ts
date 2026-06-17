/**
 * autoMappedReview — AI-assisted triage of the "Auto-Mapped, Needs Review"
 * queue. The pilot maps aggressively (low threshold + best-effort), so the
 * queue fills with many speculative document↔clause links. Rather than
 * confirm/reject each by hand, this runs the existing evidence judge
 * (`judgeEvidence`) over the pending links, stores a verdict per link
 * (satisfied / partial / missing_topic / needs_review), and lets the operator
 * bulk-confirm the strong ones and bulk-reject the clearly-wrong ones.
 *
 * Batched (a chunk per call) so the request never times out on a long queue;
 * the UI loops until remaining === 0. Verdicts persist in
 * obligation_evidence_quality so a link is never re-judged.
 */

import { sharedPool as pool } from "./sharedPool";
import { logger } from "./logger";
import { judgeEvidence } from "./complianceJudge";

// Pending auto-mapped links that don't yet have an AI verdict.
const PENDING_NO_VERDICT_SQL = `
  FROM obligation_documents od
 WHERE od.awaiting_review = TRUE
   AND NOT EXISTS (
     SELECT 1 FROM obligation_evidence_quality q
      WHERE q.obligation_id = od.obligation_id AND q.document_id = od.document_id
   )`;

export async function countPendingReview(): Promise<number> {
  const r = await pool.query(`SELECT COUNT(*)::int AS n ${PENDING_NO_VERDICT_SQL}`);
  return r.rows[0]?.n || 0;
}

export interface ReviewBatchResult {
  processed: number;
  satisfied: number;
  partial: number;
  missing: number;
  needs_review: number;
  remaining: number;
}

/** Judge the next batch of un-verdicted pending links. Bounded-concurrent, best-effort. */
export async function reviewNextBatch(
  opts: { limit?: number; concurrency?: number; judgedBy?: string } = {},
): Promise<ReviewBatchResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? 8, 40));
  const rows = await pool.query(
    `SELECT od.obligation_id, od.document_id ${PENDING_NO_VERDICT_SQL} ORDER BY od.id LIMIT $1`,
    [limit],
  );
  const queue = rows.rows.slice();
  const result: ReviewBatchResult = {
    processed: 0,
    satisfied: 0,
    partial: 0,
    missing: 0,
    needs_review: 0,
    remaining: 0,
  };
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 3, 8));

  async function worker(): Promise<void> {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      result.processed++;
      try {
        // 3-vote consensus (self-consistency) for audit-grade reliability —
        // the benchmark flagged single-pass LLM judges as prompt-sensitive.
        const v = await judgeEvidence(
          Number(job.obligation_id),
          Number(job.document_id),
          opts.judgedBy || "ai-review",
          { votes: Number(process.env.DOCUMENT_MAPPING_JUDGE_VOTES) || 3 },
        );
        if (v.status === "satisfied") result.satisfied++;
        else if (v.status === "partial") result.partial++;
        else if (v.status === "missing_topic") result.missing++;
        else result.needs_review++;
      } catch (err) {
        logger.warn(
          `[autoMappedReview] judge failed ob=${job.obligation_id} doc=${job.document_id}: ${(err as Error).message}`,
        );
        result.needs_review++;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length || 1) }, () => worker()),
  );
  result.remaining = await countPendingReview();
  return result;
}

export type BulkReviewAction = "confirm-satisfied" | "reject-missing";

/**
 * Bulk-apply the AI verdicts to the pending queue:
 *   confirm-satisfied → confirm every pending link the judge rated 'satisfied'
 *   reject-missing    → delete every pending link the judge rated 'missing_topic'
 */
export async function bulkActionByVerdict(
  action: BulkReviewAction,
  by: string,
): Promise<{ affected: number }> {
  if (action === "confirm-satisfied") {
    const r = await pool.query(
      `UPDATE obligation_documents od
          SET awaiting_review = FALSE, link_method = 'ai_confirmed', linked_by = $1
        WHERE od.awaiting_review = TRUE
          AND EXISTS (
            SELECT 1 FROM obligation_evidence_quality q
             WHERE q.obligation_id = od.obligation_id AND q.document_id = od.document_id
               AND q.status = 'satisfied'
          )
        RETURNING od.id`,
      [by],
    );
    return { affected: r.rowCount || 0 };
  }
  const r = await pool.query(
    `DELETE FROM obligation_documents od
      WHERE od.awaiting_review = TRUE
        AND EXISTS (
          SELECT 1 FROM obligation_evidence_quality q
           WHERE q.obligation_id = od.obligation_id AND q.document_id = od.document_id
             AND q.status = 'missing_topic'
        )
      RETURNING od.id`,
  );
  return { affected: r.rowCount || 0 };
}
