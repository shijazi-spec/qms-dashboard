/**
 * Operational metrics for the Call Evaluation pipeline.
 *
 * Backs GET /api/calls/health-metrics and dashboard/calls-health.html.
 * Per DMAIC Improve phase Solution #8 and Measure phase: 11 key metrics
 * have no dashboard today (process yield, ingest mix, CRM linkage rate,
 * manager-review rate, cost-per-call, etc.). This module computes them
 * all in one round-trip so the page can render in a single fetch.
 *
 * Pure aggregates over call_records / sdr_call_evaluations / sdr_review /
 * coaching_sessions plus the in-memory aiCostGuard snapshot.
 *
 * Scope: read-only. Counts only — no PII in the response.
 */

import { logger as safeLogger } from "./logger";
import { getSpendSnapshot } from "./aiCostGuard";

export interface PipelineYieldMetrics {
  total_calls: number;
  analyzed: number;
  pending: number;
  analysis_failed: number;
  yield_pct: number; // 0..100
}

export interface CrmLinkageMetrics {
  linked: number;
  unlinked: number;
  linkage_pct: number;
  by_linked_via: Record<string, number>;
}

export interface ManagerReviewMetrics {
  evaluations: number;
  reviewed: number;
  review_pct: number;
  by_status: Record<string, number>;
}

export interface IngestMixMetrics {
  window_days: number;
  by_source: Record<string, number>;
}

export interface RecentFailure {
  call_id: string | null;
  attempted_at: string;
  error_msg: string | null;
  error_code: string | null;
}

export interface CoachingFlowMetrics {
  delivered_30d: number;
  pending: number;
  total_30d: number;
}

export interface CallsHealthMetrics {
  generated_at: string;
  pipeline_yield: PipelineYieldMetrics;
  crm_linkage: CrmLinkageMetrics;
  manager_review: ManagerReviewMetrics;
  ingest_mix: IngestMixMetrics;
  coaching: CoachingFlowMetrics;
  cost: ReturnType<typeof getSpendSnapshot>;
  recent_failures: RecentFailure[];
}

type Pool = {
  query: (text: string, values?: any[]) => Promise<{ rows: any[] }>;
};

/**
 * Compute pipeline yield from call_records.status. Only counts rows
 * older than 5 minutes to avoid counting calls that are mid-pipeline.
 */
export async function fetchPipelineYield(pool: Pool): Promise<PipelineYieldMetrics> {
  // Phase 2 status-enum migration retired the 'analyzed' / 'pending' /
  // 'analysis_failed' string literals — the canonical post-evaluation
  // states are now 'evaluated' / 'qa_review_pending' / 'qa_reviewed',
  // the pre-pipeline state is 'uploaded', and terminal failures land
  // in 'failed'. Without this update the analyzed / pending / failed
  // KPIs all stuck at 0 because no row carries the old values.
  const result = await pool.query(`
    SELECT
      COUNT(*)::int AS total_calls,
      COUNT(*) FILTER (WHERE status IN ('evaluated','qa_review_pending','qa_reviewed'))::int AS analyzed,
      COUNT(*) FILTER (WHERE status = 'uploaded')::int AS pending,
      COUNT(*) FILTER (WHERE status = 'failed')::int AS analysis_failed
    FROM call_records
    WHERE created_at < NOW() - INTERVAL '5 minutes'
  `);
  const r = result.rows[0] || {};
  const total = r.total_calls || 0;
  const analyzed = r.analyzed || 0;
  const yieldPct = total > 0 ? Math.round((analyzed / total) * 10000) / 100 : 0;
  return {
    total_calls: total,
    analyzed,
    pending: r.pending || 0,
    analysis_failed: r.analysis_failed || 0,
    yield_pct: yieldPct,
  };
}

/**
 * Compute CRM linkage rate + breakdown by linked_via.
 */
export async function fetchCrmLinkage(pool: Pool): Promise<CrmLinkageMetrics> {
  const totalRes = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE lead_id IS NOT NULL OR deal_id IS NOT NULL)::int AS linked
    FROM call_records
  `);
  const t = totalRes.rows[0] || {};
  const total = t.total || 0;
  const linked = t.linked || 0;

  const breakdownRes = await pool.query(`
    SELECT COALESCE(linked_via, 'unknown') AS bucket, COUNT(*)::int AS n
    FROM call_records
    WHERE lead_id IS NOT NULL OR deal_id IS NOT NULL
    GROUP BY bucket
  `);
  const byVia: Record<string, number> = {};
  for (const row of breakdownRes.rows) {
    byVia[String(row.bucket)] = row.n || 0;
  }

  return {
    linked,
    unlinked: total - linked,
    linkage_pct: total > 0 ? Math.round((linked / total) * 10000) / 100 : 0,
    by_linked_via: byVia,
  };
}

/**
 * Manager-review rate against analyzed evaluations.
 * Returns zeros gracefully if sdr_review table doesn't exist yet.
 */
export async function fetchManagerReview(pool: Pool): Promise<ManagerReviewMetrics> {
  try {
    const evalsRes = await pool.query(`
      SELECT COUNT(*)::int AS evaluations FROM sdr_call_evaluations
    `);
    const evaluations = evalsRes.rows[0]?.evaluations || 0;

    const reviewsRes = await pool.query(`
      SELECT
        COUNT(DISTINCT evaluation_id)::int AS reviewed,
        COALESCE(review_status, 'unknown') AS status,
        COUNT(*)::int AS n
      FROM sdr_review
      GROUP BY status
    `);
    const byStatus: Record<string, number> = {};
    let reviewed = 0;
    for (const row of reviewsRes.rows) {
      byStatus[String(row.status)] = row.n || 0;
      reviewed = Math.max(reviewed, row.reviewed || 0);
    }
    return {
      evaluations,
      reviewed,
      review_pct: evaluations > 0
        ? Math.round((reviewed / evaluations) * 10000) / 100
        : 0,
      by_status: byStatus,
    };
  } catch (err: any) {
    // Table may not exist on first deploy; that's fine.
    safeLogger.warn("[callsHealthMetrics] manager_review query failed", {
      error: err?.message || String(err),
    });
    return { evaluations: 0, reviewed: 0, review_pct: 0, by_status: {} };
  }
}

/**
 * Ingest source mix over the last N days (default 7). Lets ops see the
 * ContactCenterProvider-vs-manual shift once ContactCenterProvider ingestion ships.
 */
export async function fetchIngestMix(
  pool: Pool,
  windowDays: number = 7,
): Promise<IngestMixMetrics> {
  const safeDays = Math.min(Math.max(1, Math.floor(windowDays)), 90);
  const result = await pool.query(
    `SELECT COALESCE(source, 'unknown') AS source, COUNT(*)::int AS n
       FROM call_records
      WHERE created_at >= NOW() - ($1 || ' days')::interval
      GROUP BY source`,
    [String(safeDays)],
  );
  const bySource: Record<string, number> = {};
  for (const row of result.rows) bySource[String(row.source)] = row.n || 0;
  return { window_days: safeDays, by_source: bySource };
}

/**
 * Coaching delivery stats — coaching loop closure measurement.
 */
export async function fetchCoachingFlow(pool: Pool): Promise<CoachingFlowMetrics> {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'delivered' AND delivered_at >= NOW() - INTERVAL '30 days')::int AS delivered_30d,
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS total_30d
      FROM coaching_sessions
    `);
    const r = result.rows[0] || {};
    return {
      delivered_30d: r.delivered_30d || 0,
      pending: r.pending || 0,
      total_30d: r.total_30d || 0,
    };
  } catch (err: any) {
    safeLogger.warn("[callsHealthMetrics] coaching query failed", {
      error: err?.message || String(err),
    });
    return { delivered_30d: 0, pending: 0, total_30d: 0 };
  }
}

/**
 * Most-recent analysis failures from the ai_insights JSON the analyze
 * handler writes when an LLMProvider call throws.
 */
export async function fetchRecentFailures(
  pool: Pool,
  limit: number = 10,
): Promise<RecentFailure[]> {
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 50);
  const result = await pool.query(`
    SELECT
      call_id,
      ai_insights::jsonb ->> 'last_analysis_error' AS error_msg,
      ai_insights::jsonb ->> 'last_analysis_error_code' AS error_code,
      ai_insights::jsonb ->> 'last_analysis_attempted_at' AS attempted_at
    FROM call_records
    WHERE status = 'pending'
      AND ai_insights IS NOT NULL
      AND ai_insights::jsonb ->> 'last_analysis_error' IS NOT NULL
    ORDER BY (ai_insights::jsonb ->> 'last_analysis_attempted_at') DESC NULLS LAST
    LIMIT ${safeLimit}
  `);
  return result.rows.map((r: any) => ({
    call_id: r.call_id || null,
    attempted_at: r.attempted_at || "",
    error_msg: r.error_msg || null,
    error_code: r.error_code || null,
  }));
}

/**
 * One-shot composition: all metrics in parallel, gracefully degrading
 * if any individual query throws so the page never goes completely dark.
 */
export async function fetchAllCallsHealthMetrics(
  pool: Pool,
): Promise<CallsHealthMetrics> {
  const [yieldM, linkageM, reviewM, mixM, coachingM, failures] = await Promise.all([
    fetchPipelineYield(pool).catch((err) => {
      safeLogger.warn("[callsHealthMetrics] yield failed", { error: err?.message });
      return { total_calls: 0, analyzed: 0, pending: 0, analysis_failed: 0, yield_pct: 0 };
    }),
    fetchCrmLinkage(pool).catch(() => ({ linked: 0, unlinked: 0, linkage_pct: 0, by_linked_via: {} })),
    fetchManagerReview(pool),
    fetchIngestMix(pool).catch(() => ({ window_days: 7, by_source: {} })),
    fetchCoachingFlow(pool),
    fetchRecentFailures(pool).catch(() => []),
  ]);

  return {
    generated_at: new Date().toISOString(),
    pipeline_yield: yieldM,
    crm_linkage: linkageM,
    manager_review: reviewM,
    ingest_mix: mixM,
    coaching: coachingM,
    cost: getSpendSnapshot(),
    recent_failures: failures,
  };
}
