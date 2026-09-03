/**
 * Coaching Plans — the P1 piece of the SDR coaching loop.
 *
 * Trigger: when an SDR fails the SAME scorecard attribute on 3+ calls
 * within a rolling 14-day window, auto-generate ONE coaching plan for
 * that agent × attribute. Granularity is intentionally per-attribute
 * (not per-agent) so the verification step is measurable: "did
 * Objection Handling pass on the agent's next evaluated call?"
 *
 * Lifecycle:
 *   pending_delivery
 *     ↓ (manager opens the plan, captures SDR commitment + due date)
 *   awaiting_verification
 *     ↓ (a later call's eval lands for the same agent)
 *   verified_passing | verified_failing_again
 *
 *   or — at any time — `dismissed` by the manager with a reason.
 *
 * The "open" states (pending_delivery, awaiting_verification) are
 * mutually exclusive per agent+attribute via the partial unique
 * index uq_coaching_plans_open. Resolved plans never block a new
 * plan from forming if the agent regresses on the same attribute
 * later.
 *
 * Detection runs after every SDR evaluation save (via the
 * sdrAutoEvaluator hook) — best-effort, throws are swallowed so a
 * coaching-plan failure never blocks the eval itself.
 */

import { logger as safeLogger } from "./logger";

// Local copy of the SDREvaluationResult shape used here. Kept narrow
// so we don't pull the full call-intelligence DB module just for a
// type — that module is heavy and loads LLMProvider clients at import.
interface AttributeEvaluation {
  attribute_id: string;
  attribute_name?: string;
  dimension?: string;
  status: "PASS" | "FAIL" | "NA" | string;
}

export interface CoachingPlanRow {
  id: number;
  agent_email: string;
  attribute_id: string;
  attribute_name: string | null;
  dimension: string | null;
  fail_count: number;
  failed_call_ids: number[];
  trigger_window_start: Date;
  trigger_window_end: Date;
  status:
    | "pending_delivery"
    | "awaiting_verification"
    | "verified_passing"
    | "verified_failing_again"
    | "dismissed";
  delivered_at: Date | null;
  delivered_by: string | null;
  sdr_commitment: string | null;
  follow_up_due_date: Date | null;
  coaching_notes: string | null;
  verification_call_id: number | null;
  verified_at: Date | null;
  verification_outcome: "passing" | "failing_again" | null;
  dismissed_at: Date | null;
  dismissed_by: string | null;
  dismissed_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

const TRIGGER_WINDOW_DAYS = 14;
const TRIGGER_FAIL_THRESHOLD = 3;

/**
 * Scan an agent's last-14-days evaluations and create/update coaching
 * plans for any attribute that failed 3+ times.
 *
 * Idempotent on re-run within the same window:
 *   - If an open plan exists for (agent, attribute), update its
 *     fail_count + failed_call_ids in case the call list grew.
 *   - If no open plan exists but the threshold is met, INSERT one.
 *   - If the threshold is no longer met (e.g. one of the failing
 *     calls was re-scored to PASS by a manager review), leave any
 *     pending_delivery plan in place — managers may still want to
 *     coach on the pattern even if it dipped below 3 — but DO drop
 *     it back from awaiting_verification to pending_delivery only
 *     if the delivery hasn't happened yet (it has, by definition).
 *
 * Called from sdrAutoEvaluator after a successful evaluation save.
 * Returns the list of (agent, attribute) keys for which a plan was
 * created or updated, for log/audit purposes.
 */
export async function scanCoachingTriggersForAgent(
  agentEmail: string,
  options: {
    windowDays?: number;
    failThreshold?: number;
    logger?: any;
  } = {},
): Promise<{
  inserted: Array<{ agent_email: string; attribute_id: string; fail_count: number }>;
  updated: Array<{ agent_email: string; attribute_id: string; fail_count: number }>;
}> {
  const log = options.logger || safeLogger;
  const windowDays = options.windowDays ?? TRIGGER_WINDOW_DAYS;
  const threshold = options.failThreshold ?? TRIGGER_FAIL_THRESHOLD;
  const result = {
    inserted: [] as Array<{ agent_email: string; attribute_id: string; fail_count: number }>,
    updated: [] as Array<{ agent_email: string; attribute_id: string; fail_count: number }>,
  };

  if (!agentEmail) return result;

  try {
    const { callIntelligencePool } = await import("./callIntelligenceDb");

    // Pull the agent's last-14d evaluations together with the linked
    // call_record so we can reach call_date for the window boundaries.
    // We use call_date (not evaluated_at) because the trigger is about
    // CALL behaviour, not when the manager happened to run the score.
    const evalsRes = await callIntelligencePool.query(
      `
      SELECT cr.id AS call_id,
             cr.call_date,
             se.attribute_evaluations
        FROM call_records cr
        JOIN sdr_call_evaluations se ON se.call_record_id = cr.id
       WHERE cr.agent_email = $1
         AND cr.call_date >= NOW() - ($2 || ' days')::INTERVAL
         AND se.attribute_evaluations IS NOT NULL
       ORDER BY cr.call_date ASC
      `,
      [agentEmail, String(windowDays)],
    );

    if (evalsRes.rows.length === 0) return result;

    // Bucket failing attributes across the window. Each bucket records
    // the call_ids that failed and the most recent call_date so we can
    // set trigger_window_end accurately.
    interface Bucket {
      attribute_name: string | null;
      dimension: string | null;
      failed_call_ids: number[];
      first_call_date: Date;
      last_call_date: Date;
    }
    const buckets = new Map<string, Bucket>();

    for (const row of evalsRes.rows) {
      const attrs: AttributeEvaluation[] = Array.isArray(row.attribute_evaluations)
        ? row.attribute_evaluations
        : [];
      const callDate = row.call_date ? new Date(row.call_date) : new Date();
      for (const attr of attrs) {
        if (!attr || typeof attr.attribute_id !== "string") continue;
        if (String(attr.status).toUpperCase() !== "FAIL") continue;
        const key = attr.attribute_id;
        const existing = buckets.get(key);
        if (existing) {
          existing.failed_call_ids.push(row.call_id);
          if (callDate < existing.first_call_date) existing.first_call_date = callDate;
          if (callDate > existing.last_call_date) existing.last_call_date = callDate;
        } else {
          buckets.set(key, {
            attribute_name: attr.attribute_name ?? null,
            dimension: attr.dimension ?? null,
            failed_call_ids: [row.call_id],
            first_call_date: callDate,
            last_call_date: callDate,
          });
        }
      }
    }

    for (const [attribute_id, bucket] of buckets.entries()) {
      if (bucket.failed_call_ids.length < threshold) continue;

      // Try insert with ON CONFLICT update — the partial unique index
      // uq_coaching_plans_open enforces "one open plan per agent+attr".
      // ON CONFLICT only fires when an open plan exists, in which case
      // we refresh fail_count + failed_call_ids + window_end.
      const upsertRes = await callIntelligencePool.query(
        `
        INSERT INTO coaching_plans (
          agent_email, attribute_id, attribute_name, dimension,
          fail_count, failed_call_ids,
          trigger_window_start, trigger_window_end,
          status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending_delivery')
        ON CONFLICT (agent_email, attribute_id)
          WHERE status IN ('pending_delivery', 'awaiting_verification')
        DO UPDATE SET
          fail_count = EXCLUDED.fail_count,
          failed_call_ids = EXCLUDED.failed_call_ids,
          trigger_window_end = EXCLUDED.trigger_window_end,
          attribute_name = COALESCE(coaching_plans.attribute_name, EXCLUDED.attribute_name),
          dimension = COALESCE(coaching_plans.dimension, EXCLUDED.dimension),
          updated_at = NOW()
        RETURNING (xmax = 0) AS inserted, id
        `,
        [
          agentEmail,
          attribute_id,
          bucket.attribute_name,
          bucket.dimension,
          bucket.failed_call_ids.length,
          bucket.failed_call_ids,
          bucket.first_call_date,
          bucket.last_call_date,
        ],
      );
      const row = upsertRes.rows[0];
      const summary = {
        agent_email: agentEmail,
        attribute_id,
        fail_count: bucket.failed_call_ids.length,
      };
      if (row?.inserted) result.inserted.push(summary);
      else result.updated.push(summary);
    }

    if (result.inserted.length || result.updated.length) {
      log?.info?.("📋 [Coaching] Trigger scan complete", {
        agent: agentEmail,
        inserted: result.inserted.length,
        updated: result.updated.length,
      });
    }
  } catch (err: any) {
    log?.warn?.("[Coaching] Trigger scan threw (continuing)", {
      agent: agentEmail,
      error: err?.message || String(err),
    });
  }

  return result;
}

/**
 * Run the trigger scan for every agent represented in the last-14d
 * evaluation set. Used by the manual POST /api/coaching-plans/scan
 * endpoint to populate plans retroactively from historical data.
 *
 * Serial: a slow agent doesn't block the others, but Postgres write
 * pressure is kept low (no concurrent UPSERTs against the same partial
 * unique index).
 */
export async function scanAllCoachingTriggers(options: {
  windowDays?: number;
  failThreshold?: number;
  logger?: any;
} = {}): Promise<{
  agentsScanned: number;
  totalInserted: number;
  totalUpdated: number;
  perAgent: Array<{ agent_email: string; inserted: number; updated: number }>;
}> {
  const { callIntelligencePool } = await import("./callIntelligenceDb");
  const windowDays = options.windowDays ?? TRIGGER_WINDOW_DAYS;
  const agentsRes = await callIntelligencePool.query(
    `
    SELECT DISTINCT cr.agent_email
      FROM call_records cr
      JOIN sdr_call_evaluations se ON se.call_record_id = cr.id
     WHERE cr.call_date >= NOW() - ($1 || ' days')::INTERVAL
       AND cr.agent_email IS NOT NULL
    `,
    [String(windowDays)],
  );

  const summary = {
    agentsScanned: 0,
    totalInserted: 0,
    totalUpdated: 0,
    perAgent: [] as Array<{ agent_email: string; inserted: number; updated: number }>,
  };

  for (const row of agentsRes.rows) {
    const agent = row.agent_email;
    if (!agent) continue;
    const r = await scanCoachingTriggersForAgent(agent, options);
    summary.agentsScanned++;
    summary.totalInserted += r.inserted.length;
    summary.totalUpdated += r.updated.length;
    summary.perAgent.push({
      agent_email: agent,
      inserted: r.inserted.length,
      updated: r.updated.length,
    });
  }

  return summary;
}

/**
 * Called from sdrAutoEvaluator AFTER an evaluation row has been saved.
 *
 * Two responsibilities:
 *   (a) Detection — refresh/create any coaching plans for the agent.
 *   (b) Verification — if the agent has plans in awaiting_verification
 *       for attributes that are now PASSing on the just-saved eval,
 *       close those plans as verified_passing. If they're still
 *       FAILing, close as verified_failing_again (and the detection
 *       step above will open a new plan).
 *
 * Best-effort: any throw is logged and swallowed.
 */
export async function onSdrEvaluationSaved(
  callRecordId: number,
  agentEmail: string | null | undefined,
  attributeEvaluations: AttributeEvaluation[] | undefined | null,
  options: { logger?: any } = {},
): Promise<void> {
  if (!agentEmail) return;
  const log = options.logger || safeLogger;
  try {
    // (b) Verification first — we want to close out resolved plans
    //     BEFORE the detection step runs, so a regression after
    //     coaching opens a brand-new plan rather than re-using the
    //     verified slot.
    await verifyAwaitingPlansForCall(callRecordId, agentEmail, attributeEvaluations || [], log);

    // (a) Detection — pick up any new patterns including this call.
    await scanCoachingTriggersForAgent(agentEmail, { logger: log });
  } catch (err: any) {
    log?.warn?.("[Coaching] onSdrEvaluationSaved threw (continuing)", {
      callRecordId,
      agent: agentEmail,
      error: err?.message || String(err),
    });
  }
}

/**
 * For each `awaiting_verification` plan for this agent, see whether
 * the attribute appears in the new evaluation and how it scored:
 *   - status = PASS → close plan as verified_passing
 *   - status = FAIL → close plan as verified_failing_again
 *   - status = NA or attribute absent → leave plan open, this call
 *     wasn't a fair verification (no signal)
 */
async function verifyAwaitingPlansForCall(
  callRecordId: number,
  agentEmail: string,
  attributeEvaluations: AttributeEvaluation[],
  log: any,
): Promise<void> {
  if (!Array.isArray(attributeEvaluations) || attributeEvaluations.length === 0) return;
  const { callIntelligencePool } = await import("./callIntelligenceDb");

  // Status lookup keyed by attribute_id — case-normalised so a row
  // saved as "Fail" doesn't slip past a "FAIL" check.
  const statusByAttr = new Map<string, string>();
  for (const a of attributeEvaluations) {
    if (a && typeof a.attribute_id === "string") {
      statusByAttr.set(a.attribute_id, String(a.status || "").toUpperCase());
    }
  }

  const plansRes = await callIntelligencePool.query(
    `
    SELECT id, attribute_id, attribute_name
      FROM coaching_plans
     WHERE agent_email = $1
       AND status = 'awaiting_verification'
    `,
    [agentEmail],
  );

  for (const plan of plansRes.rows) {
    const newStatus = statusByAttr.get(plan.attribute_id);
    if (!newStatus) continue;
    if (newStatus === "PASS") {
      await callIntelligencePool.query(
        `
        UPDATE coaching_plans
           SET status = 'verified_passing',
               verification_call_id = $1,
               verified_at = NOW(),
               verification_outcome = 'passing',
               updated_at = NOW()
         WHERE id = $2
        `,
        [callRecordId, plan.id],
      );
      log?.info?.("✅ [Coaching] Plan verified passing", {
        plan_id: plan.id,
        agent: agentEmail,
        attribute: plan.attribute_id,
        verification_call: callRecordId,
      });
    } else if (newStatus === "FAIL") {
      await callIntelligencePool.query(
        `
        UPDATE coaching_plans
           SET status = 'verified_failing_again',
               verification_call_id = $1,
               verified_at = NOW(),
               verification_outcome = 'failing_again',
               updated_at = NOW()
         WHERE id = $2
        `,
        [callRecordId, plan.id],
      );
      log?.info?.("⚠️ [Coaching] Plan verified failing again", {
        plan_id: plan.id,
        agent: agentEmail,
        attribute: plan.attribute_id,
        verification_call: callRecordId,
      });
    }
    // NA / absent → no-op
  }
}

// ---------------------------------------------------------------------
//   Read / mutation helpers used by the API layer
// ---------------------------------------------------------------------

export async function listCoachingPlans(filters: {
  agent_email?: string;
  status?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ records: CoachingPlanRow[]; total: number }> {
  const { callIntelligencePool } = await import("./callIntelligenceDb");
  const where: string[] = [];
  const params: any[] = [];
  let i = 1;
  if (filters.agent_email) {
    where.push(`agent_email = $${i++}`);
    params.push(filters.agent_email);
  }
  if (filters.status) {
    where.push(`status = $${i++}`);
    params.push(filters.status);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.min(Math.max(filters.limit || 100, 1), 500);
  const offset = Math.max(filters.offset || 0, 0);

  const countRes = await callIntelligencePool.query(
    `SELECT COUNT(*)::int AS n FROM coaching_plans ${whereSql}`,
    params,
  );
  const rowsRes = await callIntelligencePool.query(
    `
    SELECT *
      FROM coaching_plans
      ${whereSql}
     ORDER BY
       CASE status
         WHEN 'pending_delivery' THEN 1
         WHEN 'awaiting_verification' THEN 2
         WHEN 'verified_failing_again' THEN 3
         WHEN 'verified_passing' THEN 4
         WHEN 'dismissed' THEN 5
         ELSE 9
       END,
       trigger_window_end DESC
     LIMIT ${limit} OFFSET ${offset}
    `,
    params,
  );
  return {
    records: rowsRes.rows as CoachingPlanRow[],
    total: countRes.rows[0]?.n || 0,
  };
}

export async function getCoachingPlanById(
  id: number,
): Promise<CoachingPlanRow | null> {
  const { callIntelligencePool } = await import("./callIntelligenceDb");
  const res = await callIntelligencePool.query(
    `SELECT * FROM coaching_plans WHERE id = $1`,
    [id],
  );
  return (res.rows[0] as CoachingPlanRow) || null;
}

export async function deliverCoachingPlan(
  id: number,
  payload: {
    delivered_by: string;
    sdr_commitment?: string;
    follow_up_due_date?: string;
    coaching_notes?: string;
  },
): Promise<CoachingPlanRow | null> {
  const { callIntelligencePool } = await import("./callIntelligenceDb");
  const res = await callIntelligencePool.query(
    `
    UPDATE coaching_plans
       SET status = 'awaiting_verification',
           delivered_at = NOW(),
           delivered_by = $1,
           sdr_commitment = $2,
           follow_up_due_date = $3,
           coaching_notes = $4,
           updated_at = NOW()
     WHERE id = $5
       AND status = 'pending_delivery'
     RETURNING *
    `,
    [
      payload.delivered_by,
      payload.sdr_commitment || null,
      payload.follow_up_due_date || null,
      payload.coaching_notes || null,
      id,
    ],
  );
  return (res.rows[0] as CoachingPlanRow) || null;
}

export async function dismissCoachingPlan(
  id: number,
  payload: { dismissed_by: string; dismissed_reason: string },
): Promise<CoachingPlanRow | null> {
  const { callIntelligencePool } = await import("./callIntelligenceDb");
  const res = await callIntelligencePool.query(
    `
    UPDATE coaching_plans
       SET status = 'dismissed',
           dismissed_at = NOW(),
           dismissed_by = $1,
           dismissed_reason = $2,
           updated_at = NOW()
     WHERE id = $3
       AND status IN ('pending_delivery', 'awaiting_verification')
     RETURNING *
    `,
    [payload.dismissed_by, payload.dismissed_reason, id],
  );
  return (res.rows[0] as CoachingPlanRow) || null;
}
