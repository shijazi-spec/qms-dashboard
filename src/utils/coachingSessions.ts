// =======================================================================
// Coaching loop closure — track manager-delivered coaching sessions.
//
// Bridges AI-generated coaching suggestions (Medium #7) and downstream
// SDR performance: when a manager reviews an evaluation and decides to
// coach, they "Mark coaching delivered" on the Coaching Plan panel.
// This records who coached whom, on which attributes, with what assigned
// training, and the commitment the SDR made. Later, when a follow-up
// call lands for the same SDR, the manager can link it as the outcome
// call to measure score delta.
//
// Closes the loop: AI suggests → manager coaches → SDR commits →
// next call measured against the same scorecard → effectiveness tracked.
// =======================================================================

import { createRedactedPool } from "./redactedPool";
import { logger } from "./logger";

const pool = createRedactedPool({
  connectionString: process.env.DATABASE_URL,
});

export type CoachingSessionStatus =
  | "pending"
  | "in_progress"
  | "delivered"
  | "cancelled";

export interface CoachingSession {
  id?: number;
  call_record_id: number;
  evaluation_id: number | null;
  agent_email: string;
  agent_name: string | null;
  manager_email: string;
  manager_name: string | null;
  status: CoachingSessionStatus;
  scheduled_for: Date | null;
  delivered_at: Date | null;
  duration_minutes: number | null;
  assigned_course_ids: string[];
  attribute_focus_ids: string[];
  commitment_notes: string | null;
  followup_due_date: Date | null;
  next_review_call_id: number | null;
  outcome_score_delta: number | null;
  outcome_notes: string | null;
  cancelled_reason: string | null;
  created_at?: Date;
  updated_at?: Date;
}

let tableReady: Promise<void> | null = null;
export async function ensureCoachingSessionsTable(): Promise<void> {
  if (tableReady) return tableReady;
  tableReady = pool
    .query(`
      CREATE TABLE IF NOT EXISTS coaching_sessions (
        id SERIAL PRIMARY KEY,
        call_record_id INTEGER NOT NULL REFERENCES call_records(id) ON DELETE CASCADE,
        evaluation_id INTEGER REFERENCES sdr_call_evaluations(id) ON DELETE SET NULL,
        agent_email VARCHAR(255) NOT NULL,
        agent_name VARCHAR(255),
        manager_email VARCHAR(255) NOT NULL,
        manager_name VARCHAR(255),
        status VARCHAR(20) NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','in_progress','delivered','cancelled')),
        scheduled_for TIMESTAMPTZ,
        delivered_at TIMESTAMPTZ,
        duration_minutes INTEGER,
        assigned_course_ids TEXT[] NOT NULL DEFAULT '{}',
        attribute_focus_ids TEXT[] NOT NULL DEFAULT '{}',
        commitment_notes TEXT,
        followup_due_date DATE,
        next_review_call_id INTEGER REFERENCES call_records(id) ON DELETE SET NULL,
        outcome_score_delta DECIMAL(6,2),
        outcome_notes TEXT,
        cancelled_reason TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_coaching_sessions_call ON coaching_sessions(call_record_id);
      CREATE INDEX IF NOT EXISTS idx_coaching_sessions_agent ON coaching_sessions(agent_email);
      CREATE INDEX IF NOT EXISTS idx_coaching_sessions_manager ON coaching_sessions(manager_email);
      CREATE INDEX IF NOT EXISTS idx_coaching_sessions_status ON coaching_sessions(status);
      CREATE INDEX IF NOT EXISTS idx_coaching_sessions_followup ON coaching_sessions(followup_due_date)
        WHERE status IN ('pending','in_progress');
    `)
    .then(() => undefined);
  return tableReady;
}

function rowToSession(row: any): CoachingSession {
  return {
    id: row.id,
    call_record_id: row.call_record_id,
    evaluation_id: row.evaluation_id,
    agent_email: row.agent_email,
    agent_name: row.agent_name,
    manager_email: row.manager_email,
    manager_name: row.manager_name,
    status: row.status,
    scheduled_for: row.scheduled_for,
    delivered_at: row.delivered_at,
    duration_minutes: row.duration_minutes,
    assigned_course_ids: row.assigned_course_ids || [],
    attribute_focus_ids: row.attribute_focus_ids || [],
    commitment_notes: row.commitment_notes,
    followup_due_date: row.followup_due_date,
    next_review_call_id: row.next_review_call_id,
    outcome_score_delta:
      row.outcome_score_delta != null ? parseFloat(row.outcome_score_delta) : null,
    outcome_notes: row.outcome_notes,
    cancelled_reason: row.cancelled_reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ============================== Writes ===========================

export async function createCoachingSession(payload: {
  call_record_id: number;
  evaluation_id?: number | null;
  agent_email: string;
  agent_name?: string | null;
  manager_email: string;
  manager_name?: string | null;
  status?: CoachingSessionStatus;
  scheduled_for?: Date | null;
  delivered_at?: Date | null;
  duration_minutes?: number | null;
  assigned_course_ids?: string[];
  attribute_focus_ids?: string[];
  commitment_notes?: string | null;
  followup_due_date?: Date | string | null;
}): Promise<CoachingSession> {
  await ensureCoachingSessionsTable();
  const result = await pool.query(
    `INSERT INTO coaching_sessions (
       call_record_id, evaluation_id, agent_email, agent_name,
       manager_email, manager_name, status, scheduled_for, delivered_at,
       duration_minutes, assigned_course_ids, attribute_focus_ids,
       commitment_notes, followup_due_date
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`,
    [
      payload.call_record_id,
      payload.evaluation_id ?? null,
      payload.agent_email,
      payload.agent_name ?? null,
      payload.manager_email,
      payload.manager_name ?? null,
      payload.status ?? "delivered",
      payload.scheduled_for ?? null,
      payload.delivered_at ?? (payload.status === "delivered" ? new Date() : null),
      payload.duration_minutes ?? null,
      payload.assigned_course_ids ?? [],
      payload.attribute_focus_ids ?? [],
      payload.commitment_notes ?? null,
      payload.followup_due_date ?? null,
    ],
  );
  logger.info("[CoachingSessions] created", {
    id: result.rows[0].id,
    call_record_id: payload.call_record_id,
    status: result.rows[0].status,
  });
  return rowToSession(result.rows[0]);
}

export interface CoachingSessionPatch {
  status?: CoachingSessionStatus;
  scheduled_for?: Date | null;
  delivered_at?: Date | null;
  duration_minutes?: number | null;
  assigned_course_ids?: string[];
  attribute_focus_ids?: string[];
  commitment_notes?: string | null;
  followup_due_date?: Date | string | null;
  next_review_call_id?: number | null;
  outcome_score_delta?: number | null;
  outcome_notes?: string | null;
  cancelled_reason?: string | null;
}

const PATCHABLE_FIELDS: Array<keyof CoachingSessionPatch> = [
  "status",
  "scheduled_for",
  "delivered_at",
  "duration_minutes",
  "assigned_course_ids",
  "attribute_focus_ids",
  "commitment_notes",
  "followup_due_date",
  "next_review_call_id",
  "outcome_score_delta",
  "outcome_notes",
  "cancelled_reason",
];

export async function updateCoachingSession(
  id: number,
  patch: CoachingSessionPatch,
): Promise<CoachingSession | null> {
  await ensureCoachingSessionsTable();
  const sets: string[] = [];
  const values: any[] = [];
  let idx = 1;
  for (const field of PATCHABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, field)) {
      sets.push(`${field} = $${idx}`);
      values.push((patch as any)[field]);
      idx += 1;
    }
  }
  if (sets.length === 0) return getCoachingSession(id);
  sets.push(`updated_at = NOW()`);
  values.push(id);
  const result = await pool.query(
    `UPDATE coaching_sessions SET ${sets.join(", ")}
     WHERE id = $${idx}
     RETURNING *`,
    values,
  );
  if (result.rows.length === 0) return null;
  return rowToSession(result.rows[0]);
}

// ============================== Reads ============================

export async function getCoachingSession(id: number): Promise<CoachingSession | null> {
  await ensureCoachingSessionsTable();
  const result = await pool.query(`SELECT * FROM coaching_sessions WHERE id = $1`, [id]);
  return result.rows.length === 0 ? null : rowToSession(result.rows[0]);
}

export interface CoachingSessionListOpts {
  agent_email?: string;
  manager_email?: string;
  status?: CoachingSessionStatus | CoachingSessionStatus[];
  call_record_id?: number;
  limit?: number;
  offset?: number;
}

export async function listCoachingSessions(
  opts: CoachingSessionListOpts = {},
): Promise<{ sessions: CoachingSession[]; total: number }> {
  await ensureCoachingSessionsTable();
  const where: string[] = ["1=1"];
  const params: any[] = [];
  let idx = 1;
  if (opts.agent_email) {
    where.push(`agent_email = $${idx}`);
    params.push(opts.agent_email);
    idx += 1;
  }
  if (opts.manager_email) {
    where.push(`manager_email = $${idx}`);
    params.push(opts.manager_email);
    idx += 1;
  }
  if (opts.call_record_id) {
    where.push(`call_record_id = $${idx}`);
    params.push(opts.call_record_id);
    idx += 1;
  }
  if (opts.status) {
    const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
    where.push(`status = ANY($${idx}::text[])`);
    params.push(statuses);
    idx += 1;
  }
  const whereClause = `WHERE ${where.join(" AND ")}`;
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS n FROM coaching_sessions ${whereClause}`,
    params,
  );
  const result = await pool.query(
    `SELECT * FROM coaching_sessions ${whereClause}
     ORDER BY COALESCE(delivered_at, created_at) DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    [...params, limit, offset],
  );
  return {
    sessions: result.rows.map(rowToSession),
    total: countResult.rows[0]?.n ?? 0,
  };
}

// =============================== KPIs =============================

export interface CoachingKPIs {
  total_sessions: number;
  pending: number;
  delivered: number;
  cancelled: number;
  delivery_rate_pct: number;
  avg_hours_to_delivery: number | null;
  outcome_calls_linked: number;
  avg_outcome_score_delta: number | null;
  by_attribute: Array<{ attribute_id: string; coaching_count: number }>;
}

export async function getCoachingKPIs(opts: {
  startDate?: Date;
  endDate?: Date;
  manager_email?: string;
  agent_email?: string;
} = {}): Promise<CoachingKPIs> {
  await ensureCoachingSessionsTable();
  const where: string[] = ["1=1"];
  const params: any[] = [];
  let idx = 1;
  if (opts.startDate) {
    where.push(`created_at >= $${idx}`);
    params.push(opts.startDate);
    idx += 1;
  }
  if (opts.endDate) {
    where.push(`created_at <= $${idx}`);
    params.push(opts.endDate);
    idx += 1;
  }
  if (opts.manager_email) {
    where.push(`manager_email = $${idx}`);
    params.push(opts.manager_email);
    idx += 1;
  }
  if (opts.agent_email) {
    where.push(`agent_email = $${idx}`);
    params.push(opts.agent_email);
    idx += 1;
  }
  const whereClause = `WHERE ${where.join(" AND ")}`;

  const summary = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       SUM(CASE WHEN status IN ('pending','in_progress') THEN 1 ELSE 0 END)::int AS pending,
       SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END)::int AS delivered,
       SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END)::int AS cancelled,
       AVG(
         CASE WHEN status = 'delivered' AND delivered_at IS NOT NULL
              THEN EXTRACT(EPOCH FROM (delivered_at - created_at)) / 3600
         END
       ) AS avg_hours_to_delivery,
       COUNT(*) FILTER (WHERE next_review_call_id IS NOT NULL)::int AS outcome_calls_linked,
       AVG(outcome_score_delta) AS avg_outcome_score_delta
     FROM coaching_sessions ${whereClause}`,
    params,
  );
  const s = summary.rows[0] || {};
  const total = s.total ?? 0;
  const delivered = s.delivered ?? 0;
  const deliveryRate = total > 0 ? Math.round((delivered / total) * 100) : 0;

  // Per-attribute coaching counts — which attributes drive the most
  // coaching sessions? Mirrors AI Training Feedback's top-corrected list
  // but from the operational side (coach actually happened, not just
  // manager flagged a correction).
  const byAttrResult = await pool.query(
    `SELECT attr_id AS attribute_id, COUNT(DISTINCT cs.id)::int AS coaching_count
       FROM coaching_sessions cs
       CROSS JOIN LATERAL UNNEST(cs.attribute_focus_ids) AS attr_id
       ${whereClause.replace(/\bstatus\b/g, "cs.status")
                    .replace(/\bcreated_at\b/g, "cs.created_at")
                    .replace(/\bmanager_email\b/g, "cs.manager_email")
                    .replace(/\bagent_email\b/g, "cs.agent_email")}
       GROUP BY attr_id
       ORDER BY coaching_count DESC, attr_id
       LIMIT 5`,
    params,
  );

  return {
    total_sessions: total,
    pending: s.pending ?? 0,
    delivered,
    cancelled: s.cancelled ?? 0,
    delivery_rate_pct: deliveryRate,
    avg_hours_to_delivery:
      s.avg_hours_to_delivery != null ? Math.round(parseFloat(s.avg_hours_to_delivery) * 10) / 10 : null,
    outcome_calls_linked: s.outcome_calls_linked ?? 0,
    avg_outcome_score_delta:
      s.avg_outcome_score_delta != null
        ? Math.round(parseFloat(s.avg_outcome_score_delta) * 10) / 10
        : null,
    by_attribute: byAttrResult.rows.map((r: any) => ({
      attribute_id: r.attribute_id,
      coaching_count: r.coaching_count,
    })),
  };
}

// ====================== Outcome auto-linking ======================
//
// When a new analysed call lands for an SDR who has an open
// (pending/in-progress) coaching session, expose the candidate so the
// manager can promote it to next_review_call_id. The score delta is
// computed at link-time from the SDR evaluation tables (works for both
// AI and adjusted canonical scores).

export async function findOpenCoachingForAgent(
  agentEmail: string,
): Promise<CoachingSession[]> {
  const { sessions } = await listCoachingSessions({
    agent_email: agentEmail,
    status: ["pending", "in_progress"],
    limit: 10,
  });
  return sessions;
}

export async function linkOutcomeCall(
  sessionId: number,
  outcomeCallId: number,
): Promise<CoachingSession | null> {
  await ensureCoachingSessionsTable();
  // Compute the delta between the outcome call's canonical score and
  // the triggering call's canonical score. Both pull from
  // sdr_call_evaluations + sdr_evaluation_reviews so manager adjustments
  // count where present.
  const deltaResult = await pool.query(
    `
    WITH session_call AS (
      SELECT cs.call_record_id AS prior_call_id, cs.call_record_id AS sid_call
        FROM coaching_sessions cs WHERE cs.id = $1
    )
    SELECT
      COALESCE(prior_rev.adjusted_overall_score, prior_eval.overall_score) AS prior_score,
      COALESCE(outcome_rev.adjusted_overall_score, outcome_eval.overall_score) AS outcome_score
    FROM session_call sc
    LEFT JOIN sdr_call_evaluations prior_eval ON prior_eval.call_record_id = sc.prior_call_id
    LEFT JOIN LATERAL (
      SELECT adjusted_overall_score FROM sdr_evaluation_reviews
       WHERE evaluation_id = prior_eval.id AND adjusted_overall_score IS NOT NULL
       ORDER BY reviewed_at DESC LIMIT 1
    ) prior_rev ON TRUE
    LEFT JOIN sdr_call_evaluations outcome_eval ON outcome_eval.call_record_id = $2
    LEFT JOIN LATERAL (
      SELECT adjusted_overall_score FROM sdr_evaluation_reviews
       WHERE evaluation_id = outcome_eval.id AND adjusted_overall_score IS NOT NULL
       ORDER BY reviewed_at DESC LIMIT 1
    ) outcome_rev ON TRUE
    `,
    [sessionId, outcomeCallId],
  );
  const r = deltaResult.rows[0] || {};
  const priorScore = r.prior_score != null ? parseFloat(r.prior_score) : null;
  const outcomeScore = r.outcome_score != null ? parseFloat(r.outcome_score) : null;
  const delta =
    priorScore != null && outcomeScore != null
      ? Math.round((outcomeScore - priorScore) * 100) / 100
      : null;

  return updateCoachingSession(sessionId, {
    next_review_call_id: outcomeCallId,
    outcome_score_delta: delta,
  });
}
