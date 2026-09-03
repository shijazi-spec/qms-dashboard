/**
 * Regression test for Task #235 — guarantees the per-parent child-tool-call
 * lookup query in src/utils/aiTelemetry.ts (`getChildToolCallsForParent`)
 * actually uses the partial index `idx_ai_call_metrics_parent_call_id`
 * created in `ensureAiMetricsTable()`, and not a sequential scan.
 *
 * Why this exists
 * ---------------
 * The partial index was added to `ai_call_metrics` to speed up the agent
 * timeline view (which fans out one query per parent call). A future schema
 * change could silently drop the index, rename the column, or rewrite the
 * query in a way the planner can no longer satisfy with the index — and
 * nothing else in the suite would notice until the agent timeline view
 * started timing out under load. This test EXPLAINs the actual SQL the
 * production function runs and asserts the plan tree references the
 * partial index and contains no Seq Scan on `ai_call_metrics`.
 *
 * Approach
 * --------
 *   1. Call `ensureAiMetricsTable()` to make sure the table & index exist.
 *   2. Verify the index is present in pg_indexes with the expected partial
 *      `WHERE parent_call_id IS NOT NULL` predicate.
 *   3. Seed ~10 rows with a sentinel parent_call_id and ~1000 sibling rows
 *      pointing at other parent_call_ids. The mixed distribution gives the
 *      planner enough selectivity (~1%) on the sentinel filter to prefer
 *      an Index/Bitmap Index Scan over a Seq Scan even on small CI DBs.
 *   4. ANALYZE so the planner sees fresh statistics.
 *   5. EXPLAIN (FORMAT JSON) the EXACT SQL exported as `CHILD_TOOL_CALLS_SQL`
 *      from aiTelemetry.ts (so the test cannot drift from production).
 *   6. Walk the plan tree and assert:
 *        • At least one node references `idx_ai_call_metrics_parent_call_id`.
 *        • No node is a `Seq Scan` on `ai_call_metrics`.
 *   7. Clean up the seeded rows in a `finally` block so the live DB is left
 *      in a known-good state regardless of test outcome.
 *
 * The test is DATABASE_URL-gated and follows the same pattern as
 * `tests/toolHealthConfigDatabase.test.ts`.
 *
 * Run:   npx tsx tests/aiTelemetryChildCallIndex.test.ts
 * Wired: discovered automatically by tests/runIntegrationTests.ts (npm test).
 */

import {
  ensureAiMetricsTable,
  CHILD_TOOL_CALLS_SQL,
} from "../src/utils/aiTelemetry";
import { sharedPool as pool } from "../src/utils/sharedPool";
import { TestSuite } from "./_helpers/runner";

const suite = new TestSuite("aiTelemetryChildCallIndex");
const HAS_DB = !!process.env.DATABASE_URL;

// Sentinel values used to isolate this test's seed rows from real telemetry
// so cleanup is exact and assertions cannot be polluted by background data.
//   - SENTINEL_AGENT names a deterministic agent_name for cleanup-by-filter.
//   - SENTINEL_PARENT_ID is a distinctive NEGATIVE value that cannot collide
//     with any real `ai_call_metrics.id` (BIGSERIAL is monotonically positive
//     starting at 1) and stays inside INTEGER range so pg's parameter-type
//     inference never trips an "out of range for type integer" error when
//     binding the value into the partial-index INSERT arithmetic.
const SENTINEL_AGENT = "__task_235_index_test_sentinel__";
const SENTINEL_PARENT_ID = -<REDACTED_PHONE>;

console.log("\n=== aiTelemetry child-call index regression test ===\n");

if (!HAS_DB) {
  console.log("[skip] DATABASE_URL not set — skipping all DB-backed tests.\n");
} else {
  await suite.test(
    "idx_ai_call_metrics_parent_call_id exists with the expected partial predicate",
    async () => {
      await ensureAiMetricsTable();
      const res = await pool.query(
        `SELECT indexdef FROM pg_indexes
          WHERE schemaname = current_schema()
            AND tablename = 'ai_call_metrics'
            AND indexname = 'idx_ai_call_metrics_parent_call_id'`,
      );
      suite.expectEqual(
        res.rows.length,
        1,
        "expected exactly one matching index named idx_ai_call_metrics_parent_call_id",
      );
      if (res.rows.length === 1) {
        const def: string = res.rows[0].indexdef;
        suite.expect(
          /\bparent_call_id\b/.test(def),
          `index definition must reference parent_call_id (got: ${def})`,
        );
        suite.expect(
          /WHERE\s+\(?\s*parent_call_id\s+IS\s+NOT\s+NULL/i.test(def),
          `index must be partial (WHERE parent_call_id IS NOT NULL) (got: ${def})`,
        );
      }
    },
  );

  await suite.test(
    "EXPLAIN of CHILD_TOOL_CALLS_SQL uses the partial index, not a Seq Scan",
    async () => {
      await ensureAiMetricsTable();

      // Best-effort sweep of any sentinel rows left behind by a previous
      // crashed run before we re-seed.
      await pool.query(
        `DELETE FROM ai_call_metrics WHERE agent_name = $1`,
        [SENTINEL_AGENT],
      );

      try {
        // Seed ~10 rows that match the sentinel parent…
        await pool.query(
          `INSERT INTO ai_call_metrics
             (agent_name, tool_name, parent_call_id, model, latency_ms, success)
           SELECT $1, 'test_tool', $2, 'gpt-4o', 1, TRUE
             FROM generate_series(1, 10)`,
          [SENTINEL_AGENT, SENTINEL_PARENT_ID],
        );
        // …plus ~1000 sibling rows pointing at OTHER parent_call_id values
        // (500 distinct sibling parents — all distinct from the sentinel,
        // since sentinel is negative and these are positive) so the planner
        // sees the sentinel filter as ~1% selective and prefers an
        // Index/Bitmap Index Scan on the partial index.
        await pool.query(
          `INSERT INTO ai_call_metrics
             (agent_name, tool_name, parent_call_id, model, latency_ms, success)
           SELECT $1,
                  'test_tool',
                  (gs % 500) + 1,
                  'gpt-4o',
                  1,
                  TRUE
             FROM generate_series(1, 1000) AS gs`,
          [SENTINEL_AGENT],
        );

        // Refresh stats so the planner sees the seeded distribution.
        await pool.query(`ANALYZE ai_call_metrics`);

        // EXPLAIN the EXACT SQL exported from aiTelemetry — this guarantees
        // the test stays in lockstep with the production query.
        const explainRes = await pool.query(
          `EXPLAIN (FORMAT JSON) ${CHILD_TOOL_CALLS_SQL}`,
          [SENTINEL_PARENT_ID],
        );

        const rawPlan = explainRes.rows[0]?.["QUERY PLAN"];
        const planJson =
          typeof rawPlan === "string" ? JSON.parse(rawPlan) : rawPlan;
        suite.expect(
          Array.isArray(planJson) && planJson.length > 0,
          "EXPLAIN should return a non-empty JSON plan",
        );

        type PlanNode = {
          "Node Type": string;
          "Index Name"?: string;
          "Relation Name"?: string;
          Plans?: PlanNode[];
        };
        const visited: {
          nodeType: string;
          indexName?: string;
          relationName?: string;
        }[] = [];
        let usesTargetIndex = false;
        const walk = (node: PlanNode): void => {
          visited.push({
            nodeType: node["Node Type"],
            indexName: node["Index Name"],
            relationName: node["Relation Name"],
          });
          if (
            node["Index Name"] === "idx_ai_call_metrics_parent_call_id"
          ) {
            usesTargetIndex = true;
          }
          for (const child of node.Plans ?? []) walk(child);
        };
        const root = planJson?.[0]?.Plan as PlanNode | undefined;
        if (root) walk(root);

        const hasSeqScan = visited.some(
          (n) =>
            n.nodeType === "Seq Scan" &&
            n.relationName === "ai_call_metrics",
        );

        suite.expect(
          !hasSeqScan,
          `child-call query plan must not contain a Seq Scan on ai_call_metrics. ` +
            `Plan nodes: ${JSON.stringify(visited)}`,
        );
        suite.expect(
          usesTargetIndex,
          `child-call query plan must reference idx_ai_call_metrics_parent_call_id. ` +
            `Plan nodes: ${JSON.stringify(visited)}`,
        );
      } finally {
        try {
          await pool.query(
            `DELETE FROM ai_call_metrics WHERE agent_name = $1`,
            [SENTINEL_AGENT],
          );
        } catch {
          /* best-effort cleanup */
        }
      }
    },
  );
}

suite.finishOrExit();
