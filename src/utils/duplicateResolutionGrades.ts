/**
 * Autonomous Duplicate Resolution — COMPETENCE GRADES & LEARNING CURVE.
 *
 * Computes per-module competence metrics from the resolution feedback, bands
 * them into a grade (G1 Trainee → G4 Autonomous Specialist), and logs a
 * snapshot each run so the platform can chart the learning curve and mark
 * grade-promotion milestones. A promotion is a RECOMMENDATION only — flipping
 * the autonomy mode stays Sarah's decision (ISO segregation of duties; also
 * ISO 9001 §10.3 continual-improvement evidence).
 *
 * `computeGrade` is pure + unit-tested; the rest is best-effort DB.
 */

import { pool } from "./duplicateRadarDatabase";
import { logger } from "./logger";

export interface GradeMetrics {
  decisions: number;
  agreementRate: number; // 0..1 — agent recommendation == operator's final action
  overrideRate: number; // 0..1 — survivor/plan changed (lower better)
  autoShare: number; // 0..1 — auto-applied ÷ decided
  appliedCount: number;
}

export interface GradeBands {
  minDecisionsForG2: number;
  g2Agreement: number;
  g3Agreement: number;
  g3MaxOverride: number;
  g4Agreement: number;
  g4MaxOverride: number;
}

export const DEFAULT_GRADE_BANDS: GradeBands = {
  minDecisionsForG2: 20,
  g2Agreement: 0.85,
  g3Agreement: 0.92,
  g3MaxOverride: 0.1,
  g4Agreement: 0.96,
  g4MaxOverride: 0.05,
};

export const GRADE_LABELS: Record<number, string> = {
  1: "Trainee",
  2: "Assistant",
  3: "Trusted",
  4: "Autonomous Specialist",
};

/** Pure: band metrics into a grade (1..4) + label. */
export function computeGrade(
  m: GradeMetrics,
  bands: GradeBands = DEFAULT_GRADE_BANDS,
): { grade: number; label: string } {
  let grade = 1;
  if (m.decisions >= bands.minDecisionsForG2) {
    if (m.agreementRate >= bands.g4Agreement && m.overrideRate <= bands.g4MaxOverride) {
      grade = 4;
    } else if (
      m.agreementRate >= bands.g3Agreement &&
      m.overrideRate <= bands.g3MaxOverride
    ) {
      grade = 3;
    } else if (m.agreementRate >= bands.g2Agreement) {
      grade = 2;
    }
  }
  return { grade, label: GRADE_LABELS[grade] };
}

// ── DB layer (best-effort) ────────────────────────────────────────────────────

let _ready = false;
export async function ensureGradeLogTable(): Promise<void> {
  if (_ready) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS duplicate_resolution_grade_log (
      id SERIAL PRIMARY KEY,
      module VARCHAR(32) NOT NULL,
      grade INTEGER NOT NULL,
      grade_label VARCHAR(48),
      metrics_json JSONB,
      promoted BOOLEAN NOT NULL DEFAULT FALSE,
      note TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool
    .query(
      `CREATE INDEX IF NOT EXISTS idx_dup_res_grade_log_module_time ON duplicate_resolution_grade_log(module, created_at DESC);`,
    )
    .catch(() => {});
  _ready = true;
}

const RECORD_TYPE: Record<string, string> = {
  Accounts: "account",
  Leads: "lead",
  Deals: "deal",
  Contacts: "contact",
};

/**
 * Compute competence metrics for one module from REAL human-validated decisions.
 *
 * A "decision" only counts when a human actually ruled on it — otherwise the
 * agent would grade itself to G4 just by dry-running in shadow (nobody overrode
 * the dry-runs ⇒ 0% override ⇒ false 100% agreement). So unreviewed previews/
 * dry-runs are EXCLUDED; the grade is driven by:
 *   AGREE    = approvals-queue approved/executed  +  applied-and-not-undone
 *   DISAGREE = approvals-queue rejected           +  undos  +  survivor overrides
 * Validated decisions = AGREE + DISAGREE. Zero validated ⇒ empty ⇒ G1 Trainee
 * (honest: "you haven't validated anything yet"). Window in days.
 */
export async function computeModuleMetrics(
  module: string,
  windowDays = 30,
): Promise<GradeMetrics> {
  const empty: GradeMetrics = {
    decisions: 0,
    agreementRate: 0,
    overrideRate: 0,
    autoShare: 0,
    appliedCount: 0,
  };
  try {
    // 1) Explicit verdicts from the AI Approvals queue (the shadow/assisted
    //    review signal). Best-effort — table may be absent on a fresh deploy.
    let queueApproved = 0;
    let queueRejected = 0;
    try {
      const q = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status IN ('approved','executed'))::int AS approved,
           COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected
         FROM ai_pending_actions
         WHERE tool_id = 'duplicate-resolution'
           AND created_at > NOW() - ($2 || ' days')::interval
           AND payload->>'module' = $1`,
        [module, String(windowDays)],
      );
      queueApproved = Number(q.rows[0]?.approved || 0);
      queueRejected = Number(q.rows[0]?.rejected || 0);
    } catch {
      /* approvals table not present yet */
    }

    // 2) Real applies, undos, overrides from the resolution feedback log.
    const r = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE event_type = 'applied' AND COALESCE(performed_by,'') NOT ILIKE 'UNDO%')::int AS applied,
         COUNT(*) FILTER (WHERE COALESCE(performed_by,'') ILIKE 'UNDO%')::int AS undos,
         COUNT(*) FILTER (WHERE master_overridden)::int AS overrides,
         COUNT(*) FILTER (WHERE event_type = 'applied' AND COALESCE(performed_by,'') NOT ILIKE 'UNDO%'
                          AND (COALESCE(performed_by,'') ILIKE '%GRQ Assistant%' OR COALESCE(performed_by,'') ILIKE '%Autonomous Agent%'))::int AS auto_applied
       FROM duplicate_resolution_feedback
       WHERE created_at > NOW() - ($2 || ' days')::interval
         AND plan_json->>'module' = $1`,
      [module, String(windowDays)],
    );
    const row = r.rows[0] || {};
    const applied = Number(row.applied || 0);
    const undos = Number(row.undos || 0);
    const overrides = Number(row.overrides || 0);

    // Applied-and-not-undone = tacit agreement (only relevant once writes are on).
    const appliedKept = Math.max(0, applied - undos);
    const agree = queueApproved + appliedKept;
    const disagree = queueRejected + undos + overrides;
    const validated = agree + disagree;
    if (validated === 0) return empty; // nothing human-validated yet → G1 Trainee

    return {
      decisions: validated,
      agreementRate: agree / validated,
      overrideRate: disagree / validated,
      autoShare: applied > 0 ? Number(row.auto_applied || 0) / applied : 0,
      appliedCount: applied,
    };
  } catch (e) {
    logger.warn("[dup-resolution-grades] computeModuleMetrics failed (non-fatal)", {
      error: e instanceof Error ? e.message : String(e),
    });
    return empty;
  }
}

/** Most recent recorded grade for a module (for promotion detection). */
async function lastGrade(module: string): Promise<number> {
  try {
    const r = await pool.query(
      `SELECT grade FROM duplicate_resolution_grade_log WHERE module = $1 ORDER BY created_at DESC LIMIT 1`,
      [module],
    );
    return r.rows[0]?.grade ?? 1;
  } catch {
    return 1;
  }
}

/**
 * Compute + log a grade snapshot for every module. Marks `promoted` and writes
 * an event_logs row when a module's grade increases. Best-effort.
 */
export async function snapshotGrades(): Promise<
  Array<{ module: string; grade: number; label: string; promoted: boolean; metrics: GradeMetrics }>
> {
  const out: Array<{
    module: string;
    grade: number;
    label: string;
    promoted: boolean;
    metrics: GradeMetrics;
  }> = [];
  try {
    await ensureGradeLogTable();
    for (const module of Object.keys(RECORD_TYPE)) {
      const metrics = await computeModuleMetrics(module);
      const { grade, label } = computeGrade(metrics);
      const prev = await lastGrade(module);
      const promoted = grade > prev;
      const note = promoted
        ? `${module} ${GRADE_LABELS[prev]} (G${prev}) → ${label} (G${grade}) — agreement ${Math.round(metrics.agreementRate * 100)}% over ${metrics.decisions} decisions`
        : null;
      await pool.query(
        `INSERT INTO duplicate_resolution_grade_log
           (module, grade, grade_label, metrics_json, promoted, note)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6)`,
        [module, grade, label, JSON.stringify(metrics), promoted, note],
      );
      out.push({ module, grade, label, promoted, metrics });
    }
  } catch (e) {
    logger.warn("[dup-resolution-grades] snapshotGrades failed (non-fatal)", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return out;
}

/** Grade-log history for the learning-curve chart. */
export async function getGradeHistory(
  module?: string,
  limit = 200,
): Promise<
  Array<{ at: string | null; module: string; grade: number; label: string; metrics: any; promoted: boolean; note: string | null }>
> {
  try {
    await ensureGradeLogTable();
    const r = module
      ? await pool.query(
          `SELECT * FROM duplicate_resolution_grade_log WHERE module = $1 ORDER BY created_at DESC LIMIT $2`,
          [module, limit],
        )
      : await pool.query(
          `SELECT * FROM duplicate_resolution_grade_log ORDER BY created_at DESC LIMIT $1`,
          [limit],
        );
    return r.rows.map((row: any) => ({
      at: row.created_at ? new Date(row.created_at).toISOString() : null,
      module: row.module,
      grade: row.grade,
      label: row.grade_label,
      metrics: typeof row.metrics_json === "string" ? JSON.parse(row.metrics_json) : row.metrics_json,
      promoted: !!row.promoted,
      note: row.note,
    }));
  } catch {
    return [];
  }
}
