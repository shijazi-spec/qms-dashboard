/**
 * Task #514 — partial composite index `idx_event_logs_view_audit` on
 * `event_logs(correlation_id, user_id) WHERE action_type = 'AI_ACTION'
 * AND description ILIKE 'Viewed%'`.
 *
 * Why this test exists
 * --------------------
 * The unit test `aiApprovalReviewFilter.test.ts` proves the SQL shape is
 * right (NOT EXISTS, correct predicates, parameter bound). It cannot
 * prove that the planner picks the partial index over a sequential scan
 * once `event_logs` is large. This integration test seeds a representative
 * dataset (≥100k event_logs rows) against a real Postgres and asserts via
 * EXPLAIN ANALYZE that:
 *
 *   1. The new partial index `idx_event_logs_view_audit` is present.
 *   2. The NOT EXISTS sub-query for both review-filter modes
 *      ('unreviewed_by_me' and 'no_reviewers') uses that index — never
 *      falls back to a Seq Scan on event_logs.
 *
 * Without this guard a future schema change (rename, drop, predicate
 * tweak) could silently make the queue slow at scale and we'd only find
 * out from production telemetry.
 *
 * Why opt-in
 * ----------
 * Seeding 100k+ rows takes ~10s and writes to a real database, which is
 * heavier than what the default `npm test` should pull in. It runs in CI
 * via the dedicated workflow that boots a Postgres service container and
 * sets RUN_REVIEW_FILTER_INDEX_E2E=1. Locally:
 *
 *   RUN_REVIEW_FILTER_INDEX_E2E=1 DATABASE_URL=... \
 *     npx tsx tests/aiApprovalReviewFilterIndex.integration.ts
 *
 * Cleanup is in `finally`; if a run dies mid-seed the row prefix
 * (`view-audit-perf-test-`) makes orphans easy to find with:
 *   DELETE FROM event_logs    WHERE correlation_id LIKE 'view-audit-perf-test-%';
 *   DELETE FROM ai_pending_actions WHERE action_code LIKE 'view-audit-perf-test-%';
 */

import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL env var is required");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });

let passed = 0;
let failed = 0;
function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

// All seeded rows share this prefix so cleanup is a single LIKE scan and
// a half-finished run never leaks into another suite. Keep it long enough
// to never collide with real correlation_ids (which are uuid-shaped).
const ROW_PREFIX = "view-audit-perf-test-";

// Sized to satisfy the task's "≥100k event_logs rows" requirement.
// Each pending action gets exactly REVIEWS_PER_ACTION view-audit rows so
// the NOT EXISTS sub-query has realistic per-action selectivity.
const N_PENDING_ACTIONS = 200;          // 200 pending rows in the queue
const REVIEWS_PER_ACTION = 5;           // 5 distinct viewers per action
const N_VIEW_AUDIT_ROWS = N_PENDING_ACTIONS * REVIEWS_PER_ACTION; // 1,000
// Ballast: non-view-audit event_logs rows so the partial index's
// selectivity actually matters. With 100k+ ballast rows a sequential
// scan would be obviously expensive; if the planner still picked Seq
// Scan that's the regression we're hunting.
const N_BALLAST_ROWS = 100_000;
const TOTAL_EVENT_LOGS = N_VIEW_AUDIT_ROWS + N_BALLAST_ROWS;

// A reviewer id we'll bind into the 'unreviewed_by_me' EXPLAIN — chosen
// to NOT match any seeded view-audit user_id so the NOT EXISTS clause
// doesn't trivially exclude every action_code.
const NEW_REVIEWER_USER_ID = 9_999_777;

async function ensureIndexExists(): Promise<void> {
  // The index is created by `initializeEventLogsTable()` in
  // src/utils/eventLogsDatabase.ts. In the CI environment that init has
  // already been called by the time we get here (the dev server or a
  // previous suite ran it). Defensive re-run so this test is also
  // useful against a fresh DB.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_event_logs_view_audit
      ON event_logs(correlation_id, user_id)
      WHERE action_type = 'AI_ACTION'
        AND description ILIKE 'Viewed%';
  `);
}

async function seedPendingActions(): Promise<void> {
  // ai_pending_actions has a UNIQUE(action_code) constraint so the
  // ON CONFLICT DO NOTHING guard makes this test idempotent.
  const values: string[] = [];
  const params: any[] = [];
  for (let i = 0; i < N_PENDING_ACTIONS; i++) {
    const code = `${ROW_PREFIX}action-${i.toString().padStart(6, "0")}`;
    const idx = i * 4;
    values.push(`($${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}::jsonb, '', '')`);
    params.push(code, "test.tool", "Test Tool", "{}");
  }
  // Note: payload_preview and payload_checksum are NOT NULL — a single
  // empty-string fill is fine, the planner doesn't care about contents.
  await pool.query(
    `INSERT INTO ai_pending_actions
       (action_code, tool_id, tool_label, payload, payload_preview, payload_checksum)
     VALUES ${values.join(", ")}
     ON CONFLICT (action_code) DO NOTHING`,
    params,
  );
}

async function seedEventLogs(): Promise<void> {
  // 1) View-audit rows — exactly the shape getActionViewers writes:
  //    action_type='AI_ACTION', description starts with 'Viewed'.
  //    REVIEWS_PER_ACTION distinct user_ids per action_code so neither
  //    review-filter mode is trivially satisfied for every action.
  console.log(`  • Seeding ${N_VIEW_AUDIT_ROWS} view-audit event_logs rows…`);
  for (let i = 0; i < N_PENDING_ACTIONS; i += 100) {
    const batch: string[] = [];
    const params: any[] = [];
    let pi = 0;
    for (let j = i; j < Math.min(i + 100, N_PENDING_ACTIONS); j++) {
      const code = `${ROW_PREFIX}action-${j.toString().padStart(6, "0")}`;
      for (let r = 0; r < REVIEWS_PER_ACTION; r++) {
        const userId = 1000 + r; // user_ids 1000..1004 — none == NEW_REVIEWER_USER_ID
        batch.push(`($${pi + 1}, $${pi + 2}, $${pi + 3}, $${pi + 4}, $${pi + 5})`);
        params.push("AI_ACTION", "SYSTEM", code, "Viewed pending AI action", userId);
        pi += 5;
      }
    }
    await pool.query(
      `INSERT INTO event_logs (action_type, entity_type, correlation_id, description, user_id)
       VALUES ${batch.join(", ")}`,
      params,
    );
  }

  // 2) Ballast rows — same correlation_ids but DIFFERENT action_type so
  //    they are excluded by the partial index's predicate. This is what
  //    makes the partial index small and a sequential scan expensive.
  //    We also spread user_id over a wide range on the ballast rows so
  //    the existing `idx_event_logs_user_id` cannot pretend to be tiny
  //    (it would be huge in production); without this, the planner picks
  //    the user_id index in the test purely because it happens to be
  //    small here, masking whether the partial index works at scale.
  console.log(`  • Seeding ${N_BALLAST_ROWS} ballast event_logs rows…`);
  const BATCH = 1000;
  for (let i = 0; i < N_BALLAST_ROWS; i += BATCH) {
    const size = Math.min(BATCH, N_BALLAST_ROWS - i);
    const batch: string[] = [];
    const params: any[] = [];
    let pi = 0;
    for (let j = 0; j < size; j++) {
      const code = `${ROW_PREFIX}action-${(j % N_PENDING_ACTIONS).toString().padStart(6, "0")}`;
      // 'CREATE' on entity_type='SYSTEM' is allowed by the schema and
      // explicitly NOT matched by the partial index predicate. user_id
      // is drawn from 1..50000 so user_id-only indexes are not trivially
      // cheap for any single value.
      const userId = ((i + j) % 50_000) + 1;
      batch.push(`($${pi + 1}, $${pi + 2}, $${pi + 3}, $${pi + 4}, $${pi + 5})`);
      params.push("CREATE", "SYSTEM", code, "synthetic ballast row", userId);
      pi += 5;
    }
    await pool.query(
      `INSERT INTO event_logs (action_type, entity_type, correlation_id, description, user_id)
       VALUES ${batch.join(", ")}`,
      params,
    );
  }
}

/**
 * Returns true if the EXPLAIN ANALYZE output references the partial
 * composite index `idx_event_logs_view_audit` — directly on the parent
 * or via any of its automatically-derived partition-local copies, which
 * Postgres names `<partition>_correlation_id_user_id_idx`. We scope on
 * the `event_logs(_yYYYYmMM)?_correlation_id_user_id_idx` shape because
 * (correlation_id, user_id) is unique to the partial-composite
 * definition — no other index in the schema has that column pair.
 */
function planReferencesViewAuditIndex(plan: string): boolean {
  if (plan.includes("idx_event_logs_view_audit")) return true;
  // Per-partition derived index names: event_logs_y2026m04_correlation_id_user_id_idx
  return /event_logs(?:_y\d{4}m\d{2})?_correlation_id_user_id_idx/.test(plan);
}

/**
 * Returns true if the EXPLAIN ANALYZE output contains a `Seq Scan on
 * event_logs(_yYYYYmMM)?` node whose actual `rows=N` count is > 0.
 *
 * Why this gymnastic is necessary: a partitioned event_logs scan
 * legitimately seq-scans EMPTY child partitions (any month with no rows
 * is `cost=0..0` `rows=0`); failing on those would make the test brittle
 * to seasonal partition layout. The regression we actually care about
 * is: "the planner gave up on the partial index and is now reading every
 * row of a populated partition". That has the shape `rows=N` where N>0
 * on the same line as the Seq Scan node.
 *
 * Plan format reference (PG 13+):
 *   ->  Seq Scan on event_logs_y2026m04 el_4  (cost=0..1234 rows=100000 width=…) (actual time=… rows=100000 loops=1)
 *
 * The regex captures the `actual time=… rows=N` tail and we parse N.
 */
function planHasSeqScanOnPopulatedEventLogsPartition(plan: string): boolean {
  const re = /Seq Scan on event_logs(?:_y\d{4}m\d{2})? [^\n]*actual[^\n]*rows=(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(plan)) !== null) {
    if (Number.parseInt(m[1], 10) > 0) return true;
  }
  return false;
}

async function explain(sql: string, params: any[] = []): Promise<string> {
  const res = await pool.query<{ "QUERY PLAN": string }>(
    `EXPLAIN (ANALYZE, BUFFERS) ${sql}`,
    params,
  );
  return res.rows.map((r) => r["QUERY PLAN"]).join("\n");
}

async function cleanup(): Promise<void> {
  // event_logs is partitioned — DELETE on the parent cascades correctly.
  await pool
    .query("DELETE FROM event_logs WHERE correlation_id LIKE $1", [`${ROW_PREFIX}%`])
    .catch(() => undefined);
  await pool
    .query("DELETE FROM ai_pending_actions WHERE action_code LIKE $1", [`${ROW_PREFIX}%`])
    .catch(() => undefined);
}

async function main(): Promise<void> {
  if (process.env.RUN_REVIEW_FILTER_INDEX_E2E !== "1") {
    console.log(
      "[skip] aiApprovalReviewFilterIndex.integration.ts — set " +
        "RUN_REVIEW_FILTER_INDEX_E2E=1 (with DATABASE_URL pointed at a real " +
        "Postgres) to enable this suite. The default `npm test` runner " +
        "skips it because it seeds 100k+ rows.",
    );
    return;
  }

  console.log("\n[review-filter-index] Verifying idx_event_logs_view_audit usage");
  console.log(
    `  • dataset: ${N_PENDING_ACTIONS} pending actions × ${REVIEWS_PER_ACTION} views ` +
      `= ${N_VIEW_AUDIT_ROWS} view-audit rows + ${N_BALLAST_ROWS} ballast = ` +
      `${TOTAL_EVENT_LOGS} total event_logs rows seeded`,
  );

  try {
    await ensureIndexExists();
    await seedPendingActions();
    await seedEventLogs();

    // ANALYZE so the planner has up-to-date statistics. Without this
    // the new ballast rows look identical to the parent's stale stats
    // and the planner may pick a different plan in the test than it
    // would in production.
    console.log("  • ANALYZE event_logs / ai_pending_actions");
    await pool.query("ANALYZE event_logs");
    await pool.query("ANALYZE ai_pending_actions");

    // 0) Sanity: the partial index is registered on the parent table.
    const idxRes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename  = 'event_logs'
          AND indexname  = 'idx_event_logs_view_audit'`,
    );
    assert(
      idxRes.rows.length === 1,
      "Partial index idx_event_logs_view_audit exists on event_logs",
    );

    // -----------------------------------------------------------------
    // 1) reviewFilter='unreviewed_by_me' EXPLAIN: must use the partial
    //    index and must NOT seq-scan event_logs.
    // -----------------------------------------------------------------
    const sqlUnreviewed = `
      SELECT COUNT(*)::text AS total FROM ai_pending_actions
       WHERE NOT EXISTS (
         SELECT 1 FROM event_logs el
          WHERE el.correlation_id = ai_pending_actions.action_code
            AND el.action_type    = 'AI_ACTION'
            AND el.description    ILIKE 'Viewed%'
            AND el.user_id        = $1
       )
       AND ai_pending_actions.action_code LIKE $2
    `;
    const planUnreviewed = await explain(sqlUnreviewed, [
      NEW_REVIEWER_USER_ID,
      `${ROW_PREFIX}%`,
    ]);
    console.log("\n----- EXPLAIN unreviewed_by_me -----\n" + planUnreviewed + "\n");

    assert(
      planReferencesViewAuditIndex(planUnreviewed),
      "unreviewed_by_me plan references idx_event_logs_view_audit (parent or partition-derived)",
    );
    // Empty partitions (rows=0) legitimately seq-scan because there is
    // nothing to look up. The regression we're guarding against is a
    // seq-scan over a *populated* event_logs partition. We extract every
    // "Seq Scan on event_logs_yYYYYmMM" node together with its
    // "actual ... rows=N" tail and only fail if any N > 0.
    assert(
      !planHasSeqScanOnPopulatedEventLogsPartition(planUnreviewed),
      "unreviewed_by_me plan does NOT seq-scan a populated event_logs partition",
    );

    // -----------------------------------------------------------------
    // 2) reviewFilter='no_reviewers' EXPLAIN: same expectations, no
    //    user_id binding.
    // -----------------------------------------------------------------
    const sqlNoReviewers = `
      SELECT COUNT(*)::text AS total FROM ai_pending_actions
       WHERE NOT EXISTS (
         SELECT 1 FROM event_logs el
          WHERE el.correlation_id = ai_pending_actions.action_code
            AND el.action_type    = 'AI_ACTION'
            AND el.description    ILIKE 'Viewed%'
       )
       AND ai_pending_actions.action_code LIKE $1
    `;
    const planNoReviewers = await explain(sqlNoReviewers, [`${ROW_PREFIX}%`]);
    console.log("\n----- EXPLAIN no_reviewers -----\n" + planNoReviewers + "\n");

    assert(
      planReferencesViewAuditIndex(planNoReviewers),
      "no_reviewers plan references idx_event_logs_view_audit (parent or partition-derived)",
    );
    assert(
      !planHasSeqScanOnPopulatedEventLogsPartition(planNoReviewers),
      "no_reviewers plan does NOT seq-scan a populated event_logs partition",
    );
  } finally {
    console.log("  • cleaning up seeded rows…");
    await cleanup();
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("aiApprovalReviewFilterIndex.integration crashed:", err);
  // Best-effort cleanup of seeded rows so the next run starts clean.
  cleanup()
    .catch(() => undefined)
    .finally(() => {
      void pool.end().catch(() => undefined);
      process.exit(1);
    });
});
