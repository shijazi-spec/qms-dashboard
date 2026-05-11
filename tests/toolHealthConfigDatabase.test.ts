/**
 * Integration tests for src/utils/toolHealthConfigDatabase.ts —
 * specifically the concurrent-reap guard introduced for Task #216.
 *
 * The function `reapExpiredToolHealthOverrides` wraps its read, update, and
 * audit-insert inside a single transaction with a `SELECT … FOR UPDATE` row
 * lock. This means only one concurrent caller can observe the not-yet-reaped
 * row; the other will see the already-cleared row and return `{ reaped: false }`
 * without writing a second audit entry.
 *
 * This test exercises that concurrent path directly: it seeds an expired
 * override row, fires two `reapExpiredToolHealthOverrides()` calls in
 * parallel, and asserts that:
 *   • exactly one call returns `{ reaped: true }`
 *   • exactly one call returns `{ reaped: false }`
 *   • exactly one new audit row was created (no duplicate)
 *
 * The sentinel audit rows are counted before cleanup so the assertion is
 * `=== 1` (not `<= 1`) — this is the strict "exactly one insert" criterion
 * from the task spec. Cleanup happens afterwards and is best-effort.
 *
 * The test is DATABASE_URL-gated (HAS_DB) and cleans up the override row
 * and any audit rows it created so the live DB is left in a known-good state.
 *
 * Run:  npx tsx tests/toolHealthConfigDatabase.test.ts
 * Wired: discovered automatically by tests/runIntegrationTests.ts (npm test).
 */

import {
  reapExpiredToolHealthOverrides,
  initToolHealthConfigTables,
  __resetInitPromiseForTests,
  SYSTEM_REAPER_ATTRIBUTION,
} from "../src/utils/toolHealthConfigDatabase";
import { sharedPool as pool } from "../src/utils/sharedPool";
import { TestSuite } from "./_helpers/runner";

const suite = new TestSuite("toolHealthConfigDatabase");
const HAS_DB = !!process.env.DATABASE_URL;

console.log("\n=== toolHealthConfigDatabase integration tests ===\n");

if (!HAS_DB) {
  console.log("[skip] DATABASE_URL not set — skipping all DB-backed tests.\n");
} else {
  await suite.test(
    "concurrent reap: exactly one call succeeds and exactly one audit row is inserted",
    async () => {
      __resetInitPromiseForTests();
      await initToolHealthConfigTables();

      // A distinctive sentinel value that lets us isolate audit rows written
      // by this specific test run from any unrelated reaper activity.
      const TEST_OVERRIDE_PCT = 77;

      // ── 0. Serialize against any other test that mutates the same
      //    singleton row (id=1) in `tool_health_config_overrides`. The
      //    table is a global singleton, and `tests/aiOpsRoutes.test.ts`
      //    has an end-to-end auto-revert test that PUTs/clears the same
      //    row and runs the real reaper. When both run in parallel under
      //    `tests/runIntegrationTests.ts` (default 4 workers) they
      //    clobber each other's seed and this test sees 0 reaped instead
      //    of exactly 1. A session-level pg advisory lock held on a
      //    dedicated client serializes the seed→race→assert window
      //    without forcing the whole suite to TEST_CONCURRENCY=1.
      //    Lock key chosen by hash of "tool_health_config_overrides:singleton".
      const SINGLETON_LOCK_KEY = 7321614321;
      const lockClient = await pool.connect();
      await lockClient.query("SELECT pg_advisory_lock($1)", [SINGLETON_LOCK_KEY]);

      try {
      // ── 1. Seed an expired override row (upsert into the singleton). ────────
      //    error_rate_high_pct is set to the sentinel so we can filter audit
      //    rows by `before_values->>'errorRateHighPct' = '77'`.
      //    expires_at is 10 seconds in the past so the reaper fires immediately.
      await pool.query(
        `INSERT INTO tool_health_config_overrides
           (id, error_rate_high_pct, expires_at, updated_by, updated_at)
         VALUES (1, $1, NOW() - INTERVAL '10 seconds', 'task-216-test-seed', NOW())
         ON CONFLICT (id) DO UPDATE
           SET error_rate_high_pct = EXCLUDED.error_rate_high_pct,
               expires_at          = EXCLUDED.expires_at,
               updated_by          = EXCLUDED.updated_by,
               updated_at          = EXCLUDED.updated_at`,
        [TEST_OVERRIDE_PCT],
      );

      let result1: Awaited<ReturnType<typeof reapExpiredToolHealthOverrides>>;
      let result2: Awaited<ReturnType<typeof reapExpiredToolHealthOverrides>>;

      try {
        // ── 2. Fire both reapers simultaneously. ─────────────────────────────
        [result1, result2] = await Promise.all([
          reapExpiredToolHealthOverrides(),
          reapExpiredToolHealthOverrides(),
        ]);

        // ── 3. Assertions on the return values. ──────────────────────────────
        const reaped = [result1, result2].filter((r) => r.reaped);
        const notReaped = [result1, result2].filter((r) => !r.reaped);

        suite.expectEqual(
          reaped.length,
          1,
          `exactly one reaper call should return { reaped: true } (got ${reaped.length})`,
        );
        suite.expectEqual(
          notReaped.length,
          1,
          `exactly one reaper call should return { reaped: false } (got ${notReaped.length})`,
        );

        // The winning call must expose the audit_id it created.
        if (reaped.length === 1) {
          suite.expect(
            typeof reaped[0].audit_id === "number" && reaped[0].audit_id > 0,
            `winning reaper should return a positive audit_id (got ${reaped[0].audit_id})`,
          );
        }

        // The losing call must NOT have created an audit row.
        if (notReaped.length === 1) {
          suite.expectEqual(
            notReaped[0].audit_id,
            null,
            "losing reaper must return null audit_id",
          );
        }

        // ── 4. Count sentinel audit rows BEFORE cleanup. ─────────────────────
        //    We filter on both `changed_by` AND the sentinel `errorRateHighPct`
        //    value inside before_values so unrelated background reaper activity
        //    (on different override values) cannot inflate the count.
        //    The assertion is strict "=== 1" — this is the task's "exactly one
        //    new audit row inserted" acceptance criterion.
        const sentinelAuditRes = await pool.query(
          `SELECT COUNT(*) AS cnt FROM tool_health_config_audit
            WHERE changed_by = $1
              AND note LIKE '%Auto-cleared%'
              AND (before_values->>'errorRateHighPct')::int = $2`,
          [SYSTEM_REAPER_ATTRIBUTION, TEST_OVERRIDE_PCT],
        );
        const sentinelCount = Number(sentinelAuditRes.rows[0].cnt);

        suite.expectEqual(
          sentinelCount,
          1,
          `exactly 1 sentinel audit row should exist after a concurrent reap ` +
            `(got ${sentinelCount}); a count of 2 means the FOR UPDATE lock ` +
            `failed to prevent a double-write`,
        );
      } finally {
        // ── 5. Cleanup (best-effort). ─────────────────────────────────────────
        //    Force-clear the override row so the live DB is left in a known-good
        //    state even if an assertion above failed mid-flight.
        try {
          const clearCols = [
            "window_minutes", "min_calls", "error_rate_pct",
            "error_rate_high_pct", "error_rate_critical_pct",
            "p95_latency_ms", "latency_high_ms", "latency_critical_ms",
          ].map((c) => `${c} = NULL`).join(", ");
          await pool.query(
            `UPDATE tool_health_config_overrides
                SET ${clearCols},
                    expires_at = NULL,
                    updated_by = 'task-216-cleanup',
                    updated_at = NOW()
              WHERE id = 1`,
          );
        } catch {
          /* best-effort */
        }

        // Delete only the audit rows that our test created (filtered by
        // sentinel payload) so CI databases don't accumulate noise over runs.
        try {
          await pool.query(
            `DELETE FROM tool_health_config_audit
              WHERE changed_by = $1
                AND note LIKE '%Auto-cleared%'
                AND (before_values->>'errorRateHighPct')::int = $2`,
            [SYSTEM_REAPER_ATTRIBUTION, TEST_OVERRIDE_PCT],
          );
        } catch {
          /* best-effort */
        }
      }
      } finally {
        // Release the singleton advisory lock + dedicated client even if
        // the inner block threw before reaching its own finally.
        try {
          await lockClient.query("SELECT pg_advisory_unlock($1)", [
            SINGLETON_LOCK_KEY,
          ]);
        } catch {
          /* best-effort */
        }
        lockClient.release();
      }
    },
  );
}

suite.finishOrExit();
