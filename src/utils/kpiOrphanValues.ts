/**
 * Orphan auto-values: numbers a calculator wrote, on a KPI no calculator
 * maintains any more.
 *
 * FOUND THE HARD WAY (2026-09-07). CS-KPI-21 "Client Churn Rate" showed a red
 * 61% on the Customer Success page. Nobody typed it. A churn calculator wired
 * on 2026-08-19 recorded 567/930 — every CS deal ever marked churned over the
 * whole historical book — and on 2026-09-02 that calculator was REMOVED,
 * because the SOP's denominator is the active client population, which lives
 * in Client-Hub and cannot be sourced from Zoho. Removing the calculator did
 * not remove what it had already written. The KPI went back to `calc_mode:
 * 'manual'`, nothing recomputed it, and the wrong figure sat frozen on a page
 * headed for the Head of CS, indistinguishable from a number a person had
 * entered on purpose.
 *
 * THE RULE: a value stamped `calculated_by = 'system_auto'` on a KPI whose
 * `calc_mode` is `'manual'` is an orphan. A machine wrote it; nothing is
 * responsible for it now.
 *
 * Deliberately NOT orphans:
 *   - `calc_mode = 'auto'`   — a live calculator owns it.
 *   - `calc_mode = 'checklist'` — kpiChecklistDatabase writes these as
 *     system_auto too, and they ARE maintained (the checklist recomputes them).
 *     This is why the predicate names 'manual' explicitly instead of asking
 *     "not auto".
 *   - anything written by a person (`calculated_by` 'manual' or 'system').
 *
 * TWO defences, because either alone is insufficient:
 *   SUPPRESSION (read time) — the value-reading queries skip orphan rows, so
 *   the KPI falls back to the last legitimate value, or reads "not started".
 *   This holds for orphans created in the future, without anyone noticing.
 *   PURGE (explicit, admin) — deletes the rows, so the paths this module does
 *   NOT own (the KPI export, anything added later) are correct too.
 *
 * Suppression alone would leave the wrong number in exports; purge alone would
 * need a human to spot the next one.
 */

/**
 * The predicate, once, as SQL. Every read path that skips orphans and the
 * purge that deletes them share this string — two hand-written copies would
 * drift, and a drifted copy is a KPI that displays a number the purge thinks
 * it already removed.
 *
 * Expects `kd` = kpi_definitions, `kv` = kpi_values.
 */
export const ORPHAN_VALUE_SQL = `(kd.calc_mode = 'manual' AND kv.calculated_by = 'system_auto')`;

/**
 * Same predicate for a query that has the definitions in hand already and does
 * not want the join — pass the ids of the KPIs whose calc_mode is 'manual'.
 * `$${n}` is the placeholder index for that id array.
 */
export function orphanValueSqlForManualIds(placeholder: number): string {
  return `(kv.calculated_by = 'system_auto' AND kv.kpi_id = ANY($${placeholder}::int[]))`;
}

export interface OrphanAutoValue {
  value_id: number;
  kpi_id: number;
  kpi_code: string;
  kpi_name: string;
  owner_name: string | null;
  actual_value: number | null;
  period_start: string | null;
  period_end: string | null;
  created_at: string | null;
  calc_details: unknown;
  /**
   * TRUE when a calculator is still registered under this KPI's code.
   *
   * The sweep of 2026-09-07 found two different faults wearing the same
   * symptom, and the remedies are opposites:
   *
   *   DEAD (false) — CS-KPI-21. The calculator was deleted; the value it wrote
   *   is inert. Purging it is the fix, and it stays gone.
   *
   *   LIVE COLLISION (true) — SPEC-KPI-02. A calculator IS registered under
   *   that code and writes to it every recalc, but the definition is seeded
   *   `manual`. Purging is pointless — the next recalc puts the row straight
   *   back — and worse, the sweep would read clean in between. The real fault
   *   is that the definition and the calculator disagree about what the KPI
   *   measures, and only a person can say which one is right.
   *
   * Deleting a row that a live calculator recreates is how a defect gets
   * marked resolved four times.
   */
  has_calculator: boolean;
}

/**
 * KPI codes with a registered process calculator. Empty on failure rather than
 * throwing: an unknown registry must not make the sweep claim every row is
 * dead and safe to delete.
 */
async function calculatorCodes(): Promise<Set<string>> {
  try {
    const { PROCESS_CALCULATORS } = await import("./kpiProcessCalc");
    return new Set(Object.keys(PROCESS_CALCULATORS));
  } catch {
    return new Set();
  }
}

/**
 * The predicate in TypeScript, for callers holding rows rather than writing
 * SQL. Kept beside ORPHAN_VALUE_SQL so the two are read together.
 */
export function isOrphanAutoValue(row: {
  calc_mode?: string | null;
  calculated_by?: string | null;
}): boolean {
  return (
    String(row?.calc_mode ?? "") === "manual" &&
    String(row?.calculated_by ?? "") === "system_auto"
  );
}

/**
 * Every orphan on the platform, newest first. This is the sweep: it spans all
 * owners, so SDR and Sales are covered by the same call as CS.
 */
export async function findOrphanAutoValues(): Promise<OrphanAutoValue[]> {
  // Lazy import: kpiDatabase imports ORPHAN_VALUE_SQL from this module, so a
  // top-level import here would close the cycle. Same pattern the Quality
  // Reports aggregator uses.
  const { pool } = await import("./kpiDatabase");
  const res = await pool.query(
    `SELECT kv.id AS value_id, kv.kpi_id, kd.kpi_code, kd.kpi_name, kd.owner_name,
            kv.actual_value, kv.period_start, kv.period_end, kv.created_at,
            kv.calc_details
       FROM kpi_values kv
       JOIN kpi_definitions kd ON kd.id = kv.kpi_id
      WHERE ${ORPHAN_VALUE_SQL}
      ORDER BY kv.period_end DESC, kv.id DESC`,
  );
  const live = await calculatorCodes();
  return res.rows.map((r: any) => ({
    ...r,
    actual_value: r.actual_value === null ? null : Number(r.actual_value),
    has_calculator: live.has(String(r.kpi_code)),
  }));
}

export interface PurgeResult {
  dryRun: boolean;
  deleted: number;
  /** What was (or would be) deleted. */
  rows: OrphanAutoValue[];
  /** Left alone because a live calculator would recreate them. */
  skipped: OrphanAutoValue[];
}

/**
 * Delete the orphans. Surveys first and deletes BY ID, so the DELETE can only
 * ever touch rows this function has already listed and returned — a predicate
 * evaluated twice could widen between the two evaluations, and a
 * `DELETE ... WHERE <predicate>` on a value table is not a statement to leave
 * room for surprises in.
 *
 * `dryRun`      reports what would go without touching anything.
 * `code`        restricts to one kpi_code, for clearing a known bad figure
 *               without disturbing anything still under discussion.
 * `includeLive` also deletes rows whose code still has a calculator. OFF by
 *               default: those come straight back on the next recalc, so
 *               deleting them buys a clean sweep and nothing else. Only
 *               meaningful once the calculator itself is gone.
 */
export async function purgeOrphanAutoValues(
  opts: { dryRun?: boolean; code?: string; includeLive?: boolean } = {},
): Promise<PurgeResult> {
  const dryRun = opts.dryRun === true;
  const all = await findOrphanAutoValues();
  const inScope = opts.code
    ? all.filter((r) => String(r.kpi_code) === opts.code)
    : all;
  const skipped = opts.includeLive
    ? []
    : inScope.filter((r) => r.has_calculator);
  const rows = opts.includeLive
    ? inScope
    : inScope.filter((r) => !r.has_calculator);
  if (dryRun || rows.length === 0) {
    return { dryRun, deleted: 0, rows, skipped };
  }
  const { pool } = await import("./kpiDatabase");
  const ids = rows.map((r) => Number(r.value_id));
  const res = await pool.query(
    `DELETE FROM kpi_values WHERE id = ANY($1::int[])`,
    [ids],
  );

  // Audit each removal with the figure it carried, so the number that was on
  // screen stays recoverable after the row is gone. event_logs writes have
  // failed in prod before and logEvent rethrows, so this can never be allowed
  // to fail the purge it is describing.
  try {
    const { logEvent } = await import("./eventLogsDatabase");
    for (const r of rows) {
      await logEvent({
        actionType: "DELETE",
        entityType: "KPI",
        entityId: String(r.kpi_id),
        entityName: `${r.kpi_code} ${r.kpi_name}`,
        description:
          `Removed orphan auto-value ${r.actual_value} for period ending ` +
          `${String(r.period_end).slice(0, 10)}: written by a calculator that ` +
          `no longer exists, on a KPI now marked manual.`,
        oldValue: r,
        module: "kpis",
        severity: "WARNING",
      });
    }
  } catch {
    /* audit is best-effort; the purge itself already succeeded */
  }

  return { dryRun, deleted: res.rowCount ?? 0, rows, skipped };
}
