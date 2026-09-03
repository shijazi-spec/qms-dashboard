/**
 * Coaching Effectiveness Index (CEfx).
 *
 * Per DMAIC Improve phase Solution #5 and Control phase target:
 *   "After 'Mark coaching delivered' badge, measure the same agent's
 *    avg QA score 30d before vs 30d after. Surface delta on the
 *    coaching panel. ≥ +5 points avg per coach is the control band."
 *
 * Why: today the platform records that coaching was delivered but
 * cannot prove the coaching moved the agent's performance. Without
 * this number, coaching is a feel-good activity with no ROI. CEfx
 * is the leading indicator that distinguishes effective coaches from
 * ones whose sessions don't change behavior.
 *
 * Calculation per session:
 *   avg_after  = mean(sdr_call_evaluations.overall_score) for the
 *                same agent_email, where evaluated_at is in
 *                [delivered_at, delivered_at + 30 days)
 *   avg_before = mean(...) where evaluated_at is in
 *                [delivered_at - 30 days, delivered_at)
 *   delta      = avg_after - avg_before
 *
 * If either window has < MIN_CALLS_PER_WINDOW evaluations, the
 * session is marked "insufficient_data" and not counted in coach /
 * agent aggregates. This prevents a single noisy session (1 call
 * before, 1 call after) from skewing the coach's leaderboard.
 *
 * Scope: pure SQL aggregates + small dependency-injection-friendly
 * helpers. The endpoint at /api/coaching/effectiveness composes
 * fetchCoachingEffectiveness() and serializes the result.
 *
 * Feature-flagged on COACHING_EFFECTIVENESS_INDEX; the endpoint
 * returns 404 when off.
 */

import { logger as safeLogger } from "./logger";

export const WINDOW_DAYS = 30;
export const MIN_CALLS_PER_WINDOW = 2;

export interface SessionCEfx {
  session_id: number;
  agent_email: string;
  agent_name: string | null;
  manager_email: string;
  manager_name: string | null;
  delivered_at: string; // ISO
  calls_before: number;
  calls_after: number;
  avg_score_before: number | null;
  avg_score_after: number | null;
  delta: number | null;
  status: "ok" | "insufficient_data";
}

export interface CoachAggregate {
  manager_email: string;
  manager_name: string | null;
  sessions_counted: number;
  sessions_insufficient: number;
  avg_delta: number | null; // null if no countable sessions
}

export interface AgentAggregate {
  agent_email: string;
  agent_name: string | null;
  sessions_counted: number;
  avg_delta: number | null;
}

export interface CEfxReport {
  generated_at: string;
  window_days: number;
  min_calls_per_window: number;
  sessions: SessionCEfx[];
  by_coach: CoachAggregate[];
  by_agent: AgentAggregate[];
}

type Pool = {
  query: (text: string, values?: any[]) => Promise<{ rows: any[] }>;
};

/**
 * Pure: compute one session's CEfx from the surrounding call counts
 * and averages. Exported for unit testing without a DB.
 */
export function computeSessionCEfx(input: {
  calls_before: number;
  calls_after: number;
  avg_score_before: number | null;
  avg_score_after: number | null;
}): { delta: number | null; status: "ok" | "insufficient_data" } {
  const { calls_before, calls_after, avg_score_before, avg_score_after } = input;
  if (
    calls_before < MIN_CALLS_PER_WINDOW ||
    calls_after < MIN_CALLS_PER_WINDOW ||
    avg_score_before === null ||
    avg_score_after === null
  ) {
    return { delta: null, status: "insufficient_data" };
  }
  return {
    delta: Math.round((avg_score_after - avg_score_before) * 100) / 100,
    status: "ok",
  };
}

/**
 * Pure: aggregate per-session CEfx into per-coach + per-agent rollups.
 * Insufficient-data sessions count toward sessions_insufficient but
 * NOT toward the avg_delta computation.
 */
export function aggregateCEfx(sessions: SessionCEfx[]): {
  by_coach: CoachAggregate[];
  by_agent: AgentAggregate[];
} {
  const coaches: Record<string, CoachAggregate> = {};
  const agents: Record<string, AgentAggregate> = {};

  for (const s of sessions) {
    // Coach rollup
    if (!coaches[s.manager_email]) {
      coaches[s.manager_email] = {
        manager_email: s.manager_email,
        manager_name: s.manager_name,
        sessions_counted: 0,
        sessions_insufficient: 0,
        avg_delta: null,
      };
    }
    const c = coaches[s.manager_email];
    if (s.status === "ok" && s.delta !== null) {
      const prevTotal = (c.avg_delta ?? 0) * c.sessions_counted;
      c.sessions_counted += 1;
      c.avg_delta = (prevTotal + s.delta) / c.sessions_counted;
    } else {
      c.sessions_insufficient += 1;
    }

    // Agent rollup
    if (!agents[s.agent_email]) {
      agents[s.agent_email] = {
        agent_email: s.agent_email,
        agent_name: s.agent_name,
        sessions_counted: 0,
        avg_delta: null,
      };
    }
    const a = agents[s.agent_email];
    if (s.status === "ok" && s.delta !== null) {
      const prevTotal = (a.avg_delta ?? 0) * a.sessions_counted;
      a.sessions_counted += 1;
      a.avg_delta = (prevTotal + s.delta) / a.sessions_counted;
    }
  }

  // Round averages for display.
  const roundDelta = (n: number | null) =>
    n === null ? null : Math.round(n * 100) / 100;
  return {
    by_coach: Object.values(coaches)
      .map((c) => ({ ...c, avg_delta: roundDelta(c.avg_delta) }))
      .sort((a, b) => (b.avg_delta ?? -Infinity) - (a.avg_delta ?? -Infinity)),
    by_agent: Object.values(agents)
      .map((a) => ({ ...a, avg_delta: roundDelta(a.avg_delta) }))
      .sort((a, b) => (b.avg_delta ?? -Infinity) - (a.avg_delta ?? -Infinity)),
  };
}

/**
 * Run the per-session CEfx calculation against the database.
 *
 * Strategy: one SQL with two LEFT JOIN LATERAL subqueries (before
 * window + after window). Each subquery aggregates
 * sdr_call_evaluations joined to call_records.agent_email. The outer
 * SELECT pulls coaching_sessions where status='delivered' and
 * delivered_at is at least 30d in the past (so the after-window
 * actually has time to populate).
 */
export async function fetchCoachingEffectiveness(
  pool: Pool,
  options: { managerEmail?: string; agentEmail?: string; limit?: number } = {},
): Promise<CEfxReport> {
  const limit = Math.min(Math.max(1, Math.floor(options.limit || 200)), 500);
  const filters: string[] = [
    `cs.status = 'delivered'`,
    `cs.delivered_at IS NOT NULL`,
    // delivered_at + 30 days must be in the past so the after-window
    // has actually closed; otherwise we'd be measuring an open window.
    `cs.delivered_at < NOW() - INTERVAL '${WINDOW_DAYS} days'`,
  ];
  const values: any[] = [];
  if (options.managerEmail) {
    values.push(options.managerEmail);
    filters.push(`cs.manager_email = $${values.length}`);
  }
  if (options.agentEmail) {
    values.push(options.agentEmail);
    filters.push(`cs.agent_email = $${values.length}`);
  }
  values.push(limit);
  const limitParam = `$${values.length}`;

  const sql = `
    SELECT
      cs.id AS session_id,
      cs.agent_email,
      cs.agent_name,
      cs.manager_email,
      cs.manager_name,
      cs.delivered_at,
      before_win.calls_before,
      before_win.avg_score_before,
      after_win.calls_after,
      after_win.avg_score_after
    FROM coaching_sessions cs
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::int AS calls_before,
        AVG(sce.overall_score)::float AS avg_score_before
      FROM sdr_call_evaluations sce
      JOIN call_records cr ON cr.id = sce.call_record_id
      WHERE cr.agent_email = cs.agent_email
        AND sce.overall_score IS NOT NULL
        AND sce.evaluated_at >= cs.delivered_at - INTERVAL '${WINDOW_DAYS} days'
        AND sce.evaluated_at < cs.delivered_at
    ) before_win ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::int AS calls_after,
        AVG(sce.overall_score)::float AS avg_score_after
      FROM sdr_call_evaluations sce
      JOIN call_records cr ON cr.id = sce.call_record_id
      WHERE cr.agent_email = cs.agent_email
        AND sce.overall_score IS NOT NULL
        AND sce.evaluated_at >= cs.delivered_at
        AND sce.evaluated_at < cs.delivered_at + INTERVAL '${WINDOW_DAYS} days'
    ) after_win ON TRUE
    WHERE ${filters.join(" AND ")}
    ORDER BY cs.delivered_at DESC
    LIMIT ${limitParam}
  `;

  let rows: any[];
  try {
    const result = await pool.query(sql, values);
    rows = result.rows;
  } catch (err: any) {
    safeLogger.error("[CEfx] query failed", {
      error: err?.message || String(err),
    });
    rows = [];
  }

  const sessions: SessionCEfx[] = rows.map((r) => {
    const callsBefore = r.calls_before ?? 0;
    const callsAfter = r.calls_after ?? 0;
    const avgBefore = r.avg_score_before === null ? null : Number(r.avg_score_before);
    const avgAfter = r.avg_score_after === null ? null : Number(r.avg_score_after);
    const cef = computeSessionCEfx({
      calls_before: callsBefore,
      calls_after: callsAfter,
      avg_score_before: avgBefore,
      avg_score_after: avgAfter,
    });
    return {
      session_id: r.session_id,
      agent_email: r.agent_email,
      agent_name: r.agent_name,
      manager_email: r.manager_email,
      manager_name: r.manager_name,
      delivered_at:
        r.delivered_at instanceof Date
          ? r.delivered_at.toISOString()
          : String(r.delivered_at || ""),
      calls_before: callsBefore,
      calls_after: callsAfter,
      avg_score_before: avgBefore === null ? null : Math.round(avgBefore * 100) / 100,
      avg_score_after: avgAfter === null ? null : Math.round(avgAfter * 100) / 100,
      delta: cef.delta,
      status: cef.status,
    };
  });

  const agg = aggregateCEfx(sessions);
  return {
    generated_at: new Date().toISOString(),
    window_days: WINDOW_DAYS,
    min_calls_per_window: MIN_CALLS_PER_WINDOW,
    sessions,
    by_coach: agg.by_coach,
    by_agent: agg.by_agent,
  };
}
