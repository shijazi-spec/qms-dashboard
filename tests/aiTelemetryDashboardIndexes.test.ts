/**
 * Regression tests for Task #519 — extends the EXPLAIN-based pattern from
 * `tests/aiTelemetryChildCallIndex.test.ts` to the four other indexes on
 * `ai_call_metrics` that the AI Operations dashboard relies on for fast
 * page loads:
 *
 *   • idx_ai_call_metrics_agent_started      — per-agent latency/cost charts
 *   • idx_ai_call_metrics_tool_started       — per-tool health & silent-tool sweep
 *   • idx_ai_call_metrics_started_at         — global "recent calls" scrubber
 *   • idx_ai_call_metrics_agent_prompt_version — Prompt Version comparison view
 *
 * Why this exists
 * ---------------
 * Task #235 only covered `idx_ai_call_metrics_parent_call_id`. A future
 * schema change could silently drop, rename, or invalidate any of the four
 * indexes above and the dashboard would slow to a crawl in production
 * without any test failure. Each test below EXPLAINs the EXACT SQL exported
 * from `src/utils/aiTelemetry.ts` (so the test cannot drift from the
 * production query), seeds enough rows for the planner to prefer an
 * Index/Bitmap Index Scan, then asserts the expected index name appears in
 * the plan and no Seq Scan on `ai_call_metrics` is present.
 *
 * The tests are DATABASE_URL-gated and clean up their seeded rows in a
 * `finally` block so the live DB is left in a known-good state regardless
 * of test outcome.
 *
 * Run:   npx tsx tests/aiTelemetryDashboardIndexes.test.ts
 * Wired: discovered automatically by tests/runIntegrationTests.ts (npm test).
 */

import {
  ensureAiMetricsTable,
  ensureFeedbackTable,
  buildTopToolsByCostSql,
  TOOLS_WITH_CALLS_IN_WINDOW_SQL,
  RECENT_SLOW_FAILED_CALLS_SQL,
  FEEDBACK_RATE_BY_PROMPT_VERSION_SQL,
} from "../src/utils/aiTelemetry";
import { sharedPool as pool } from "../src/utils/sharedPool";
import { TestSuite } from "./_helpers/runner";

const suite = new TestSuite("aiTelemetryDashboardIndexes");
const HAS_DB = !!process.env.DATABASE_URL;

// Sentinel agent_name used to isolate this test's seed rows from real
// telemetry so cleanup is exact and assertions cannot be polluted by
// background data. Every seed row inserted by this file uses this value
// (or one of its `__N` suffixed variants) so a single DELETE … WHERE
// agent_name LIKE sentinel || '%' clears the table no matter which test
// crashed mid-run.
const SENTINEL_AGENT_BASE = "__task_519_dashboard_index_test__";
const SENTINEL_TOOL_BASE = "__task_519_dashboard_index_tool__";

type PlanNode = {
  "Node Type": string;
  "Index Name"?: string;
  "Relation Name"?: string;
  Plans?: PlanNode[];
};
interface VisitedNode {
  nodeType: string;
  indexName?: string;
  relationName?: string;
}

function walkPlan(root: PlanNode | undefined): VisitedNode[] {
  const out: VisitedNode[] = [];
  const visit = (n: PlanNode): void => {
    out.push({
      nodeType: n["Node Type"],
      indexName: n["Index Name"],
      relationName: n["Relation Name"],
    });
    for (const c of n.Plans ?? []) visit(c);
  };
  if (root) visit(root);
  return out;
}

async function explainPlan(
  sql: string,
  params: unknown[],
): Promise<VisitedNode[]> {
  const res = await pool.query(`EXPLAIN (FORMAT JSON) ${sql}`, params);
  const raw = res.rows[0]?.["QUERY PLAN"];
  const json = typeof raw === "string" ? JSON.parse(raw) : raw;
  return walkPlan(json?.[0]?.Plan as PlanNode | undefined);
}

async function cleanupSentinel(): Promise<void> {
  // Sweep ALL rows seeded by this file by either the agent or tool prefix,
  // since each test seeds with its own variant suffix.
  await pool.query(
    `DELETE FROM ai_call_metrics
       WHERE agent_name LIKE $1 || '%'
          OR tool_name LIKE $2 || '%'`,
    [SENTINEL_AGENT_BASE, SENTINEL_TOOL_BASE],
  );
}

console.log("\n=== aiTelemetry dashboard-index regression tests ===\n");

if (!HAS_DB) {
  console.log("[skip] DATABASE_URL not set — skipping all DB-backed tests.\n");
} else {
  await ensureAiMetricsTable();
  // The Prompt Version comparison query joins ai_call_feedback, so its
  // table must exist before EXPLAIN can plan the join. Bootstrap once
  // up-front (idempotent) so the standalone `npx tsx` invocation works
  // against a fresh database too.
  await ensureFeedbackTable();

  // ────────────────────────────────────────────────────────────────────
  // 1) idx_ai_call_metrics_agent_started
  //    Drives the agent-filtered variant of getTopToolsByCost(), which
  //    powers per-agent latency/cost trend charts on the dashboard.
  //    Seed strategy: one sentinel agent w/ ~10 rows + ~1000 sibling
  //    rows for OTHER agents — agent equality is ~1% selective, so the
  //    planner prefers the (agent_name, started_at) index.
  // ────────────────────────────────────────────────────────────────────
  await suite.test(
    "EXPLAIN of buildTopToolsByCostSql(true) uses idx_ai_call_metrics_agent_started",
    async () => {
      await cleanupSentinel();
      const targetAgent = `${SENTINEL_AGENT_BASE}_topcost_target`;
      const otherAgentPrefix = `${SENTINEL_AGENT_BASE}_topcost_other_`;
      try {
        // ~10 rows for the sentinel target agent
        await pool.query(
          `INSERT INTO ai_call_metrics
             (agent_name, tool_name, model, latency_ms, success, estimated_cost_usd)
           SELECT $1, 'sentinel_tool', 'gpt-4o', 100, TRUE, 0.0001
             FROM generate_series(1, 10)`,
          [targetAgent],
        );
        // ~1000 rows spread across 100 OTHER agents — high cardinality so
        // the planner sees agent equality as the most selective filter.
        await pool.query(
          `INSERT INTO ai_call_metrics
             (agent_name, tool_name, model, latency_ms, success, estimated_cost_usd)
           SELECT $1 || (gs % 100)::text,
                  'sentinel_tool',
                  'gpt-4o',
                  100,
                  TRUE,
                  0.0001
             FROM generate_series(1, 1000) AS gs`,
          [otherAgentPrefix],
        );
        await pool.query(`ANALYZE ai_call_metrics`);

        const sql = buildTopToolsByCostSql(true);
        const visited = await explainPlan(sql, [10, targetAgent]);

        const usesIndex = visited.some(
          (n) => n.indexName === "idx_ai_call_metrics_agent_started",
        );
        const hasSeqScan = visited.some(
          (n) =>
            n.nodeType === "Seq Scan" &&
            n.relationName === "ai_call_metrics",
        );
        suite.expect(
          !hasSeqScan,
          `getTopToolsByCost(agent) plan must not contain a Seq Scan on ai_call_metrics. ` +
            `Plan nodes: ${JSON.stringify(visited)}`,
        );
        suite.expect(
          usesIndex,
          `getTopToolsByCost(agent) plan must reference idx_ai_call_metrics_agent_started. ` +
            `Plan nodes: ${JSON.stringify(visited)}`,
        );
      } finally {
        try {
          await cleanupSentinel();
        } catch {
          /* best-effort */
        }
      }
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // 2) idx_ai_call_metrics_tool_started (partial: WHERE tool_name IS NOT NULL)
  //    Drives the silent-tool sweep's "any-activity-in-window" probe
  //    (TOOLS_WITH_CALLS_IN_WINDOW_SQL) and the per-tool health charts.
  //    Seed strategy: ~50 rows inside the window with tool_name set and
  //    ~1000 rows outside the window (NULL or stale) so the recent-window
  //    filter is highly selective and the partial index wins.
  // ────────────────────────────────────────────────────────────────────
  await suite.test(
    "idx_ai_call_metrics_tool_started exists with the expected partial predicate",
    async () => {
      const res = await pool.query(
        `SELECT indexdef FROM pg_indexes
          WHERE schemaname = current_schema()
            AND tablename = 'ai_call_metrics'
            AND indexname = 'idx_ai_call_metrics_tool_started'`,
      );
      suite.expectEqual(
        res.rows.length,
        1,
        "expected exactly one matching index named idx_ai_call_metrics_tool_started",
      );
      if (res.rows.length === 1) {
        const def: string = res.rows[0].indexdef;
        suite.expect(
          /\btool_name\b/.test(def) && /\bstarted_at\b/.test(def),
          `index must reference tool_name and started_at (got: ${def})`,
        );
        suite.expect(
          /WHERE\s+\(?\s*tool_name\s+IS\s+NOT\s+NULL/i.test(def),
          `index must be partial (WHERE tool_name IS NOT NULL) (got: ${def})`,
        );
      }
    },
  );

  await suite.test(
    "EXPLAIN of TOOLS_WITH_CALLS_IN_WINDOW_SQL uses idx_ai_call_metrics_tool_started",
    async () => {
      await cleanupSentinel();
      const agent = `${SENTINEL_AGENT_BASE}_tool_window`;
      const toolPrefix = `${SENTINEL_TOOL_BASE}_window_`;
      try {
        // ~50 in-window rows with tool_name set — these are the rows
        // the partial index will return.
        await pool.query(
          `INSERT INTO ai_call_metrics
             (agent_name, tool_name, model, latency_ms, success, started_at)
           SELECT $1, $2 || (gs % 25)::text, 'gpt-4o', 100, TRUE, NOW()
             FROM generate_series(1, 50) AS gs`,
          [agent, toolPrefix],
        );
        // ~5000 in-window rows with tool_name NULL — these inflate the
        // global idx_ai_call_metrics_started_at scan cost (it has no
        // tool_name predicate) without growing the partial
        // idx_ai_call_metrics_tool_started index, so the planner picks
        // the partial index. Without this, the planner happily uses the
        // global started_at index because it's cheap on its own.
        await pool.query(
          `INSERT INTO ai_call_metrics
             (agent_name, tool_name, model, latency_ms, success, started_at)
           SELECT $1, NULL, 'gpt-4o', 100, TRUE, NOW()
             FROM generate_series(1, 5000)`,
          [agent],
        );
        // ~1000 OUT-of-window rows w/ tool_name set — keeps the partial
        // index non-trivial in size while staying clear of the recent-
        // window filter so they don't show up in the result.
        await pool.query(
          `INSERT INTO ai_call_metrics
             (agent_name, tool_name, model, latency_ms, success, started_at)
           SELECT $1, $2 || (gs % 25)::text, 'gpt-4o', 100, TRUE,
                  NOW() - INTERVAL '60 days'
             FROM generate_series(1, 1000) AS gs`,
          [agent, toolPrefix],
        );
        await pool.query(`ANALYZE ai_call_metrics`);

        const visited = await explainPlan(TOOLS_WITH_CALLS_IN_WINDOW_SQL, [
          60, // last 60 minutes
        ]);

        const usesIndex = visited.some(
          (n) => n.indexName === "idx_ai_call_metrics_tool_started",
        );
        const hasSeqScan = visited.some(
          (n) =>
            n.nodeType === "Seq Scan" &&
            n.relationName === "ai_call_metrics",
        );
        suite.expect(
          !hasSeqScan,
          `silent-tool-sweep plan must not contain a Seq Scan on ai_call_metrics. ` +
            `Plan nodes: ${JSON.stringify(visited)}`,
        );
        suite.expect(
          usesIndex,
          `silent-tool-sweep plan must reference idx_ai_call_metrics_tool_started. ` +
            `Plan nodes: ${JSON.stringify(visited)}`,
        );
      } finally {
        try {
          await cleanupSentinel();
        } catch {
          /* best-effort */
        }
      }
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // 3) idx_ai_call_metrics_started_at
  //    Drives the global "recent slow/failed calls" time scrubber
  //    (RECENT_SLOW_FAILED_CALLS_SQL) — ORDER BY started_at DESC LIMIT N
  //    is a textbook backward-index-scan pattern.
  //    Seed strategy: ~50 in-window failing rows + ~2000 stale (older
  //    than 7 days) rows so the started_at range filter is highly
  //    selective.
  // ────────────────────────────────────────────────────────────────────
  await suite.test(
    "EXPLAIN of RECENT_SLOW_FAILED_CALLS_SQL uses idx_ai_call_metrics_started_at",
    async () => {
      await cleanupSentinel();
      const agent = `${SENTINEL_AGENT_BASE}_recent`;
      try {
        // ~50 in-window failing rows that match the (NOT success OR slow) filter
        await pool.query(
          `INSERT INTO ai_call_metrics
             (agent_name, model, latency_ms, success, started_at)
           SELECT $1, 'gpt-4o', 100, FALSE, NOW() - (gs || ' minutes')::interval
             FROM generate_series(1, 50) AS gs`,
          [agent],
        );
        // ~2000 OUT-of-window rows so the started_at >= NOW() - 7 days
        // predicate is ~2.5% selective — well under the threshold where
        // a backward index scan beats a Seq Scan.
        await pool.query(
          `INSERT INTO ai_call_metrics
             (agent_name, model, latency_ms, success, started_at)
           SELECT $1, 'gpt-4o', 100, FALSE, NOW() - INTERVAL '60 days'
             FROM generate_series(1, 2000)`,
          [agent],
        );
        await pool.query(`ANALYZE ai_call_metrics`);

        const visited = await explainPlan(RECENT_SLOW_FAILED_CALLS_SQL, [20]);

        const usesIndex = visited.some(
          (n) => n.indexName === "idx_ai_call_metrics_started_at",
        );
        const hasSeqScan = visited.some(
          (n) =>
            n.nodeType === "Seq Scan" &&
            n.relationName === "ai_call_metrics",
        );
        suite.expect(
          !hasSeqScan,
          `recent-slow/failed-calls plan must not contain a Seq Scan on ai_call_metrics. ` +
            `Plan nodes: ${JSON.stringify(visited)}`,
        );
        suite.expect(
          usesIndex,
          `recent-slow/failed-calls plan must reference idx_ai_call_metrics_started_at. ` +
            `Plan nodes: ${JSON.stringify(visited)}`,
        );
      } finally {
        try {
          await cleanupSentinel();
        } catch {
          /* best-effort */
        }
      }
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // 4) idx_ai_call_metrics_agent_prompt_version
  //    (agent_name, (metadata ->> 'prompt_version'), started_at DESC)
  //    WHERE tool_name IS NULL — drives the Prompt Version comparison
  //    view (FEEDBACK_RATE_BY_PROMPT_VERSION_SQL).
  //    Seed strategy: ~200 in-window rows with tool_name NULL + a
  //    handful of prompt versions per agent + ~2000 out-of-window rows
  //    with tool_name SET so the partial index is the cheapest scan.
  // ────────────────────────────────────────────────────────────────────
  await suite.test(
    "idx_ai_call_metrics_agent_prompt_version exists with the expected partial predicate",
    async () => {
      const res = await pool.query(
        `SELECT indexdef FROM pg_indexes
          WHERE schemaname = current_schema()
            AND tablename = 'ai_call_metrics'
            AND indexname = 'idx_ai_call_metrics_agent_prompt_version'`,
      );
      suite.expectEqual(
        res.rows.length,
        1,
        "expected exactly one matching index named idx_ai_call_metrics_agent_prompt_version",
      );
      if (res.rows.length === 1) {
        const def: string = res.rows[0].indexdef;
        suite.expect(
          /agent_name/.test(def) &&
            /prompt_version/.test(def) &&
            /started_at/.test(def),
          `index must reference agent_name, prompt_version, started_at (got: ${def})`,
        );
        suite.expect(
          /WHERE\s+\(?\s*tool_name\s+IS\s+NULL/i.test(def),
          `index must be partial (WHERE tool_name IS NULL) (got: ${def})`,
        );
      }
    },
  );

  await suite.test(
    "EXPLAIN of FEEDBACK_RATE_BY_PROMPT_VERSION_SQL uses idx_ai_call_metrics_agent_prompt_version",
    async () => {
      await cleanupSentinel();
      const agentPrefix = `${SENTINEL_AGENT_BASE}_promptver_`;
      try {
        // ~200 in-window prompt-version rows (tool_name IS NULL — matches
        // the partial-index predicate). Spread across 5 agents × multiple
        // prompt versions to give the GROUP BY non-trivial cardinality.
        await pool.query(
          `INSERT INTO ai_call_metrics
             (agent_name, tool_name, model, latency_ms, success, started_at, metadata)
           SELECT $1 || (gs % 5)::text,
                  NULL,
                  'gpt-4o',
                  100,
                  TRUE,
                  NOW() - ((gs % 7) || ' days')::interval,
                  jsonb_build_object('prompt_version', 'v' || (gs % 4)::text)
             FROM generate_series(1, 200) AS gs`,
          [agentPrefix],
        );
        // ~2000 out-of-partial-index rows (tool_name IS NOT NULL) so the
        // partial index is dramatically smaller than the full table.
        await pool.query(
          `INSERT INTO ai_call_metrics
             (agent_name, tool_name, model, latency_ms, success, started_at, metadata)
           SELECT $1 || (gs % 5)::text,
                  'sentinel_tool',
                  'gpt-4o',
                  100,
                  TRUE,
                  NOW() - INTERVAL '1 hour',
                  '{}'::jsonb
             FROM generate_series(1, 2000) AS gs`,
          [agentPrefix],
        );
        await pool.query(`ANALYZE ai_call_metrics`);

        const visited = await explainPlan(
          FEEDBACK_RATE_BY_PROMPT_VERSION_SQL,
          [30, 5],
        );

        const usesIndex = visited.some(
          (n) => n.indexName === "idx_ai_call_metrics_agent_prompt_version",
        );
        const hasSeqScan = visited.some(
          (n) =>
            n.nodeType === "Seq Scan" &&
            n.relationName === "ai_call_metrics",
        );
        suite.expect(
          !hasSeqScan,
          `prompt-version-comparison plan must not contain a Seq Scan on ai_call_metrics. ` +
            `Plan nodes: ${JSON.stringify(visited)}`,
        );
        suite.expect(
          usesIndex,
          `prompt-version-comparison plan must reference idx_ai_call_metrics_agent_prompt_version. ` +
            `Plan nodes: ${JSON.stringify(visited)}`,
        );
      } finally {
        try {
          await cleanupSentinel();
        } catch {
          /* best-effort */
        }
      }
    },
  );
}

suite.finishOrExit();
