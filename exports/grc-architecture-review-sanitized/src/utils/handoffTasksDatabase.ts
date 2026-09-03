/**
 * Quality ↔ GRC Handoff Tracker — the shared task surface between Quality
 * (Sample User) and GRC (Maram). Every task assigned here IS a handoff, which is what
 * makes GRQ-KPI-02 "Quality ↔ GRC Handoff Effectiveness" auto-calculable.
 *
 * NOT stored in `handoff_events` — that table is a rule-driven automation log
 * (rule_id, source/target module, error_message) with no title, assignee or due
 * date. Keeping human tasks separate keeps both tables single-purpose.
 *
 * Lifecycle: sent -> accepted -> done, with reject(reason) -> re-send bumping
 * rework_count. "Successful" for the KPI = done, on or before the due date, with
 * zero rework.
 */
import { pool } from "./kpiDatabase";
import { logger } from "./logger";

export type HandoffStatus = "sent" | "accepted" | "done" | "rejected";

export interface HandoffTask {
  id?: number;
  title: string;
  description?: string | null;
  created_by: string;
  assigned_to: string;
  due_date?: string | null;
  status?: HandoffStatus;
  accepted_at?: Date | null;
  completed_at?: Date | null;
  rejected_at?: Date | null;
  reject_reason?: string | null;
  rework_count?: number;
  created_at?: Date;
  updated_at?: Date;
}

export async function initHandoffTaskTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS handoff_tasks (
      id SERIAL PRIMARY KEY,
      title VARCHAR(300) NOT NULL,
      description TEXT,
      created_by VARCHAR(200) NOT NULL,
      assigned_to VARCHAR(200) NOT NULL,
      due_date DATE,
      status VARCHAR(20) DEFAULT 'sent',
      accepted_at TIMESTAMP,
      completed_at TIMESTAMP,
      rejected_at TIMESTAMP,
      reject_reason TEXT,
      rework_count INTEGER DEFAULT 0,
      last_reminder_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(
    `ALTER TABLE handoff_tasks ADD COLUMN IF NOT EXISTS last_reminder_at TIMESTAMP`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_handoff_tasks_assigned ON handoff_tasks(assigned_to)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_handoff_tasks_due ON handoff_tasks(due_date)`,
  );
  logger.info("✅ [HandoffTasks] handoff_tasks table ready");
}

/** All tasks involving this user (sent by them or assigned to them), newest first. */
export async function listTasksForUser(email: string): Promise<HandoffTask[]> {
  const res = await pool.query(
    `SELECT * FROM handoff_tasks
      WHERE LOWER(assigned_to) = LOWER($1) OR LOWER(created_by) = LOWER($1)
      ORDER BY (status IN ('done','rejected')) ASC,
               due_date NULLS LAST, created_at DESC`,
    [email],
  );
  return res.rows;
}

export async function createTask(t: HandoffTask): Promise<HandoffTask> {
  const res = await pool.query(
    `INSERT INTO handoff_tasks (title, description, created_by, assigned_to, due_date, status)
     VALUES ($1,$2,$3,$4,$5,'sent') RETURNING *`,
    [
      (t.title || "").trim(),
      t.description?.trim() || null,
      t.created_by,
      t.assigned_to,
      t.due_date || null,
    ],
  );
  return res.rows[0];
}

export async function getTask(id: number): Promise<HandoffTask | null> {
  const res = await pool.query(`SELECT * FROM handoff_tasks WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

/**
 * Move a task through its lifecycle. Returns null if the transition isn't legal
 * from the task's current state, so the route can 409 instead of silently
 * corrupting the audit trail (e.g. completing a task that was never accepted).
 */
export async function transitionTask(
  id: number,
  action: "accept" | "reject" | "done" | "EmailProvider",
  opts: { reason?: string } = {},
): Promise<HandoffTask | null> {
  const cur = await getTask(id);
  if (!cur) return null;
  const st = cur.status;
  let sql: string | null = null;
  const vals: any[] = [id];

  if (action === "accept" && st === "sent") {
    sql = `UPDATE handoff_tasks SET status='accepted', accepted_at=NOW(), updated_at=NOW() WHERE id=$1 RETURNING *`;
  } else if (action === "reject" && (st === "sent" || st === "accepted")) {
    sql = `UPDATE handoff_tasks SET status='rejected', rejected_at=NOW(), reject_reason=$2, updated_at=NOW() WHERE id=$1 RETURNING *`;
    vals.push(opts.reason?.trim() || null);
  } else if (action === "done" && (st === "accepted" || st === "sent")) {
    sql = `UPDATE handoff_tasks SET status='done', completed_at=NOW(), updated_at=NOW() WHERE id=$1 RETURNING *`;
  } else if (action === "EmailProvider" && st === "rejected") {
    // Re-sending after a rejection is rework — that's exactly what the KPI penalises.
    sql = `UPDATE handoff_tasks
              SET status='sent', rework_count = COALESCE(rework_count,0) + 1,
                  rejected_at=NULL, reject_reason=NULL, accepted_at=NULL, updated_at=NOW()
            WHERE id=$1 RETURNING *`;
  }
  if (!sql) return null;
  const res = await pool.query(sql, vals);
  return res.rows[0] || null;
}

/**
 * GRQ-KPI-02 — Quality ↔ GRC Handoff Effectiveness.
 *
 * Denominator = tasks DUE in the window (due_date within period). Numerator =
 * those completed on or before the due date with zero rework. Scoping by due
 * date (not creation) means an overdue-but-still-open task counts against the
 * score instead of quietly sitting outside the measurement.
 *
 * Returns dataAvailable:false when nothing was due — never a fake 0.
 */
export async function calcHandoffEffectiveness(
  periodDays = 30,
): Promise<{ value: number; dataAvailable: boolean; details?: any; reason?: string }> {
  try {
    const r = await pool.query(
      `SELECT
         COUNT(*)::int AS due,
         COUNT(*) FILTER (WHERE status='done' AND completed_at::date <= due_date
                            AND COALESCE(rework_count,0) = 0)::int AS successful,
         COUNT(*) FILTER (WHERE status='done' AND completed_at::date > due_date)::int AS late,
         COUNT(*) FILTER (WHERE COALESCE(rework_count,0) > 0)::int AS with_rework,
         COUNT(*) FILTER (WHERE status IN ('sent','accepted'))::int AS still_open,
         COUNT(*) FILTER (WHERE status='rejected')::int AS rejected
       FROM handoff_tasks
       WHERE due_date IS NOT NULL
         AND due_date > (CURRENT_DATE - ($1::int || ' days')::interval)
         AND due_date <= CURRENT_DATE`,
      [periodDays],
    );
    const row = r.rows[0] ?? {};
    const due = Number(row.due ?? 0);
    if (due <= 0) return { value: 0, dataAvailable: false, reason: "no_handoffs_due_in_period" };
    const ok = Number(row.successful ?? 0);
    return {
      value: Math.round((ok / due) * 1000) / 10,
      dataAvailable: true,
      details: {
        handoffs_due: due,
        successful_on_time_no_rework: ok,
        completed_late: Number(row.late ?? 0),
        had_rework: Number(row.with_rework ?? 0),
        still_open_past_due: Number(row.still_open ?? 0),
        rejected: Number(row.rejected ?? 0),
        period_days: periodDays,
      },
    };
  } catch (err) {
    logger.error(`[HandoffTasks] effectiveness calc failed: ${(err as Error).message}`);
    return { value: 0, dataAvailable: false, reason: "handoff_tasks_unavailable" };
  }
}

/** Open tasks past their due date — drives the daily overdue email. */
export async function getOverdueTasks(): Promise<HandoffTask[]> {
  const res = await pool.query(
    `SELECT * FROM handoff_tasks
      WHERE status IN ('sent','accepted')
        AND due_date IS NOT NULL AND due_date < CURRENT_DATE
      ORDER BY due_date ASC`,
  );
  return res.rows;
}
