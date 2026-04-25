/**
 * Unit tests for the prompt-version small-sample protection (Task #163).
 *
 * Coverage:
 *   1. getFeedbackRateByPromptVersion — four boundary rows:
 *        • 0-vote row           → meets_min_feedback = false
 *        • 1-vote row           → meets_min_feedback = false (default floor = 5)
 *        • exactly-N-vote row   → meets_min_feedback = true  (boundary inclusive)
 *        • N+1-vote row         → meets_min_feedback = true
 *      All rows also echo min_feedback = floor.
 *   2. Floor guard:
 *        • negative input       → falls back to DEFAULT_PROMPT_VERSION_MIN_FEEDBACK
 *        • NaN input            → falls back to DEFAULT_PROMPT_VERSION_MIN_FEEDBACK
 *        • zero input           → accepted as-is (disables protection)
 *        • fractional input     → truncated with Math.floor
 *   3. Route handler — GET /api/ai-ops/prompt-versions?minFeedback=10
 *        • response.min_feedback echoes the override (10)
 *        • response.min_feedback matches safeInt-clamped value for out-of-range params
 *
 * All tests run without a live database — a stub pool is injected via the
 * optional third parameter added to getFeedbackRateByPromptVersion.
 *
 * Run:  npx tsx tests/promptVersionSmallSample.test.ts
 */

import {
  getFeedbackRateByPromptVersion,
  DEFAULT_PROMPT_VERSION_MIN_FEEDBACK,
  type PromptVersionAggregate,
} from "../src/utils/aiTelemetry";
import { aiOpsRoutes } from "../src/mastra/routes/aiOpsRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("promptVersionSmallSample");
const ADMIN_KEY = "integration-test-prompt-version-2026";

console.log("\n=== prompt-version small-sample protection unit tests ===\n");

// ─────────────────────────────────────────────────────────────────────────────
// Stub pool factory
//
// Returns a fake pg Pool that:
//   • captures the [days, floor] params from the SELECT query ($1, $2)
//   • simulates what Postgres would compute for four boundary rows given that
//     floor — without touching a real database
// ─────────────────────────────────────────────────────────────────────────────

interface StubPoolResult {
  capturedFloor: number | null;
  pool: { query: (sql: string, params?: any[]) => Promise<{ rows: PromptVersionAggregate[] }> };
}

function makeStubPool(): StubPoolResult {
  let capturedFloor: number | null = null;

  const pool = {
    async query(
      _sql: string,
      params?: any[],
    ): Promise<{ rows: PromptVersionAggregate[] }> {
      // Params are [days, floor] as defined in the SELECT query.
      const floor: number = params?.[1] ?? DEFAULT_PROMPT_VERSION_MIN_FEEDBACK;
      capturedFloor = floor;

      // Build the four boundary rows, computing meets_min_feedback and
      // min_feedback exactly as the SQL expression would:
      //   (COUNT(f.id) >= $2)  AS meets_min_feedback
      //   $2::INTEGER          AS min_feedback
      const makeRow = (
        prompt_version: string,
        total_feedback: number,
      ): PromptVersionAggregate => ({
        agent_name: "TestAgent",
        prompt_version,
        call_count: 10,
        total_feedback,
        thumbs_up: total_feedback,
        thumbs_down: 0,
        feedback_rate_pct: total_feedback > 0 ? 100 : null,
        p50_ms: 200,
        avg_ms: 210,
        error_rate_pct: 0,
        first_seen: "2026-01-01T00:00:00Z",
        last_seen: "2026-04-01T00:00:00Z",
        min_feedback: floor,
        meets_min_feedback: total_feedback >= floor,
      });

      return {
        rows: [
          makeRow("v0-zero", 0),
          makeRow("v1-one", 1),
          makeRow("vN-exact", floor),
          makeRow("vN1-plus1", floor + 1),
        ],
      };
    },
  };

  return { get capturedFloor() { return capturedFloor; }, pool };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Boundary cases with the default floor (5)
// ─────────────────────────────────────────────────────────────────────────────

await suite.test("default floor: 0-vote row → meets_min_feedback = false", async () => {
  const { pool } = makeStubPool();
  const rows = await getFeedbackRateByPromptVersion(30, DEFAULT_PROMPT_VERSION_MIN_FEEDBACK, pool);
  const row = rows.find((r) => r.prompt_version === "v0-zero");
  suite.expect(!!row, "v0-zero row present");
  suite.expectEqual(row?.meets_min_feedback, false, "meets_min_feedback");
  suite.expectEqual(row?.min_feedback, DEFAULT_PROMPT_VERSION_MIN_FEEDBACK, "min_feedback echoed");
});

await suite.test("default floor: 1-vote row → meets_min_feedback = false", async () => {
  const { pool } = makeStubPool();
  const rows = await getFeedbackRateByPromptVersion(30, DEFAULT_PROMPT_VERSION_MIN_FEEDBACK, pool);
  const row = rows.find((r) => r.prompt_version === "v1-one");
  suite.expect(!!row, "v1-one row present");
  suite.expectEqual(row?.meets_min_feedback, false, "meets_min_feedback");
  suite.expectEqual(row?.min_feedback, DEFAULT_PROMPT_VERSION_MIN_FEEDBACK, "min_feedback echoed");
});

await suite.test("default floor: exactly-N-vote row → meets_min_feedback = true (boundary inclusive)", async () => {
  const { pool } = makeStubPool();
  const rows = await getFeedbackRateByPromptVersion(30, DEFAULT_PROMPT_VERSION_MIN_FEEDBACK, pool);
  const row = rows.find((r) => r.prompt_version === "vN-exact");
  suite.expect(!!row, "vN-exact row present");
  suite.expectEqual(row?.meets_min_feedback, true, "meets_min_feedback");
  suite.expectEqual(row?.total_feedback, DEFAULT_PROMPT_VERSION_MIN_FEEDBACK, "total_feedback matches floor");
  suite.expectEqual(row?.min_feedback, DEFAULT_PROMPT_VERSION_MIN_FEEDBACK, "min_feedback echoed");
});

await suite.test("default floor: N+1-vote row → meets_min_feedback = true", async () => {
  const { pool } = makeStubPool();
  const rows = await getFeedbackRateByPromptVersion(30, DEFAULT_PROMPT_VERSION_MIN_FEEDBACK, pool);
  const row = rows.find((r) => r.prompt_version === "vN1-plus1");
  suite.expect(!!row, "vN1-plus1 row present");
  suite.expectEqual(row?.meets_min_feedback, true, "meets_min_feedback");
  suite.expectEqual(row?.min_feedback, DEFAULT_PROMPT_VERSION_MIN_FEEDBACK, "min_feedback echoed");
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Floor guard — invalid / edge inputs
// ─────────────────────────────────────────────────────────────────────────────

await suite.test("negative minFeedback falls back to DEFAULT", async () => {
  const stub = makeStubPool();
  await getFeedbackRateByPromptVersion(30, -1, stub.pool);
  suite.expectEqual(
    stub.capturedFloor,
    DEFAULT_PROMPT_VERSION_MIN_FEEDBACK,
    "floor passed to query",
  );
});

await suite.test("NaN minFeedback falls back to DEFAULT", async () => {
  const stub = makeStubPool();
  await getFeedbackRateByPromptVersion(30, NaN, stub.pool);
  suite.expectEqual(
    stub.capturedFloor,
    DEFAULT_PROMPT_VERSION_MIN_FEEDBACK,
    "floor passed to query",
  );
});

await suite.test("zero minFeedback is accepted (disables protection)", async () => {
  const stub = makeStubPool();
  const rows = await getFeedbackRateByPromptVersion(30, 0, stub.pool);
  suite.expectEqual(stub.capturedFloor, 0, "floor passed to query");
  // With floor=0, every row should meet the minimum (0 >= 0 is true)
  const zeroRow = rows.find((r) => r.prompt_version === "v0-zero");
  suite.expect(!!zeroRow, "v0-zero row present");
  suite.expectEqual(zeroRow?.meets_min_feedback, true, "0-vote row meets floor=0");
  suite.expectEqual(zeroRow?.min_feedback, 0, "min_feedback echoed as 0");
});

await suite.test("fractional minFeedback is truncated with Math.floor", async () => {
  const stub = makeStubPool();
  await getFeedbackRateByPromptVersion(30, 3.7, stub.pool);
  suite.expectEqual(stub.capturedFloor, 3, "3.7 truncated to 3");
});

await suite.test("override minFeedback=10 passes correct floor and boundary rows flip", async () => {
  const stub = makeStubPool();
  const rows = await getFeedbackRateByPromptVersion(30, 10, stub.pool);
  suite.expectEqual(stub.capturedFloor, 10, "floor=10 passed to query");

  // With floor=10: 0-vote and 1-vote should not meet the threshold
  const zeroRow = rows.find((r) => r.prompt_version === "v0-zero");
  const oneRow = rows.find((r) => r.prompt_version === "v1-one");
  const exactRow = rows.find((r) => r.prompt_version === "vN-exact");
  const plusOneRow = rows.find((r) => r.prompt_version === "vN1-plus1");

  suite.expectEqual(zeroRow?.meets_min_feedback, false, "0-vote: false with floor=10");
  suite.expectEqual(zeroRow?.min_feedback, 10, "0-vote: min_feedback=10");
  suite.expectEqual(oneRow?.meets_min_feedback, false, "1-vote: false with floor=10");
  suite.expectEqual(exactRow?.total_feedback, 10, "exact row has total_feedback=10");
  suite.expectEqual(exactRow?.meets_min_feedback, true, "exact row meets floor=10");
  suite.expectEqual(exactRow?.min_feedback, 10, "exact row: min_feedback=10");
  suite.expectEqual(plusOneRow?.total_feedback, 11, "plus-one row has total_feedback=11");
  suite.expectEqual(plusOneRow?.meets_min_feedback, true, "plus-one meets floor=10");
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Route handler — GET /api/ai-ops/prompt-versions?minFeedback=<n>
//
// The route echoes the effective min_feedback in the JSON response body.
// We verify this without a live DB — if getFeedbackRateByPromptVersion
// fails to connect it catches internally and returns [], which is fine;
// the route still returns the correct min_feedback echo.
// ─────────────────────────────────────────────────────────────────────────────

await suite.test("route: ?minFeedback=10 is honoured — response.min_feedback = 10", async () => {
  const original = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  try {
    const handler = await buildHandler(aiOpsRoutes, "/api/ai-ops/prompt-versions", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        headers: { "X-Admin-Key": ADMIN_KEY },
        query: { minFeedback: "10" },
      }),
    );
    suite.expectEqual(res.status, 200, "status");
    suite.expectEqual(res.body?.min_feedback, 10, "min_feedback echoed as 10");
    suite.expect(Array.isArray(res.body?.data), "data is an array");
  } finally {
    if (original === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = original;
  }
});

await suite.test("route: ?minFeedback=0 is honoured — response.min_feedback = 0", async () => {
  const original = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  try {
    const handler = await buildHandler(aiOpsRoutes, "/api/ai-ops/prompt-versions", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        headers: { "X-Admin-Key": ADMIN_KEY },
        query: { minFeedback: "0" },
      }),
    );
    suite.expectEqual(res.status, 200, "status");
    suite.expectEqual(res.body?.min_feedback, 0, "min_feedback echoed as 0");
  } finally {
    if (original === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = original;
  }
});

await suite.test("route: no minFeedback param → response.min_feedback = DEFAULT", async () => {
  const original = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  try {
    const handler = await buildHandler(aiOpsRoutes, "/api/ai-ops/prompt-versions", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        headers: { "X-Admin-Key": ADMIN_KEY },
      }),
    );
    suite.expectEqual(res.status, 200, "status");
    suite.expectEqual(
      res.body?.min_feedback,
      DEFAULT_PROMPT_VERSION_MIN_FEEDBACK,
      "min_feedback defaults to constant",
    );
  } finally {
    if (original === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = original;
  }
});

await suite.test("route: ?minFeedback=1001 is clamped to 1000", async () => {
  const original = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  try {
    const handler = await buildHandler(aiOpsRoutes, "/api/ai-ops/prompt-versions", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        headers: { "X-Admin-Key": ADMIN_KEY },
        query: { minFeedback: "1001" },
      }),
    );
    suite.expectEqual(res.status, 200, "status");
    suite.expectEqual(res.body?.min_feedback, 1000, "1001 clamped to 1000");
  } finally {
    if (original === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = original;
  }
});

await suite.test("route: non-numeric minFeedback falls back to DEFAULT", async () => {
  const original = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  try {
    const handler = await buildHandler(aiOpsRoutes, "/api/ai-ops/prompt-versions", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        headers: { "X-Admin-Key": ADMIN_KEY },
        query: { minFeedback: "not-a-number" },
      }),
    );
    suite.expectEqual(res.status, 200, "status");
    suite.expectEqual(
      res.body?.min_feedback,
      DEFAULT_PROMPT_VERSION_MIN_FEEDBACK,
      "non-numeric falls back to default",
    );
  } finally {
    if (original === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = original;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Constant sanity-check — locks DEFAULT_PROMPT_VERSION_MIN_FEEDBACK so
//    a silent drift gets caught without a DB.
// ─────────────────────────────────────────────────────────────────────────────

await suite.test("DEFAULT_PROMPT_VERSION_MIN_FEEDBACK is 5", () => {
  suite.expectEqual(DEFAULT_PROMPT_VERSION_MIN_FEEDBACK, 5, "constant value");
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. DB-gated integration — runs the REAL SQL against a live Postgres
//
// The stub-pool tests above mirror the SQL expressions in JavaScript; they
// cannot catch bugs in the query itself — wrong JOIN conditions, wrong
// FILTER clauses, missing GROUP BY columns, or Postgres type-coercion
// quirks for `meets_min_feedback` (BOOLEAN) and `min_feedback`
// ($2::INTEGER). This block seeds four boundary cohorts under a unique
// agent_name (so it cannot collide with live data), runs the production
// query four times at different floors to walk every interesting boundary
// (default 5, 1, 0, 6), and asserts the SQL returns what the stub
// promised. Cleanup deletes every seeded row in a `finally` so a crashed
// assertion still leaves the database clean.
// ─────────────────────────────────────────────────────────────────────────────

const HAS_DB = !!process.env.DATABASE_URL;

if (HAS_DB) {
  // Imported lazily so the file still runs (with the DB block skipped) in
  // environments where `pg` cannot connect at module-load time.
  const pg = await import("pg");
  const { Pool } = pg.default;
  const { ensureAiMetricsTable } = await import("../src/utils/aiTelemetry");

  const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const AGENT_NAME = `db_promptver_test_${RUN_ID}`;
  const V0 = "v0_zero";
  const V1 = "v1_one";
  const VN = "vN_exact";
  const VN1 = "vN1_plus1";

  const seedPool = new Pool({ connectionString: process.env.DATABASE_URL });

  // Make sure both tables exist before we INSERT directly. The production
  // pool inside aiTelemetry does this lazily on the first read, but our
  // seed pool is a separate Pool instance and would race with that.
  await ensureAiMetricsTable();
  // ensureFeedbackTable() is private; the easiest way to force it is to
  // call the production reader once — which is also a no-op if the table
  // already exists.
  await getFeedbackRateByPromptVersion(1, DEFAULT_PROMPT_VERSION_MIN_FEEDBACK);

  // Track every (call_id, feedback row) we insert so cleanup is targeted
  // even if something else in the same DB happens to share our agent name
  // (defence in depth — the unique RUN_ID suffix already prevents that).
  const seededCallIds: number[] = [];

  async function seed(): Promise<void> {
    // Cohort plan, designed to walk every boundary that matters:
    //   V0  → 1 call,  0 feedback                        (total_feedback = 0)
    //   V1  → 1 call,  1 thumbs_up                        (total_feedback = 1)
    //   VN  → 5 calls, 5 thumbs_up (one per call)         (total_feedback = 5)
    //   VN1 → 6 calls, 5 thumbs_up + 1 thumbs_down        (total_feedback = 6)
    //
    // VN1 includes a thumbs_down so the FILTER (WHERE rating = 'thumbs_up')
    // / FILTER (WHERE rating = 'thumbs_down') clauses are exercised against
    // a real Postgres rather than a JS lookalike.
    const cohorts: Array<{
      version: string;
      calls: Array<{ rating: "thumbs_up" | "thumbs_down" | null; latencyMs: number }>;
    }> = [
      { version: V0, calls: [{ rating: null, latencyMs: 100 }] },
      { version: V1, calls: [{ rating: "thumbs_up", latencyMs: 200 }] },
      {
        version: VN,
        calls: [
          { rating: "thumbs_up", latencyMs: 300 },
          { rating: "thumbs_up", latencyMs: 310 },
          { rating: "thumbs_up", latencyMs: 320 },
          { rating: "thumbs_up", latencyMs: 330 },
          { rating: "thumbs_up", latencyMs: 340 },
        ],
      },
      {
        version: VN1,
        calls: [
          { rating: "thumbs_up", latencyMs: 400 },
          { rating: "thumbs_up", latencyMs: 410 },
          { rating: "thumbs_up", latencyMs: 420 },
          { rating: "thumbs_up", latencyMs: 430 },
          { rating: "thumbs_up", latencyMs: 440 },
          { rating: "thumbs_down", latencyMs: 450 },
        ],
      },
    ];

    let userCounter = 0;
    for (const cohort of cohorts) {
      for (const call of cohort.calls) {
        const metricRes = await seedPool.query(
          `INSERT INTO ai_call_metrics
             (agent_name, tool_name, model, latency_ms, success, metadata, started_at)
           VALUES ($1, NULL, 'gpt-4o', $2, TRUE, $3::jsonb, NOW())
           RETURNING id`,
          [AGENT_NAME, call.latencyMs, JSON.stringify({ prompt_version: cohort.version })],
        );
        const callId = Number(metricRes.rows[0].id);
        seededCallIds.push(callId);

        if (call.rating !== null) {
          // user_hash must be unique per (call_id, user_hash); a per-call
          // counter is enough since we only insert one feedback row per call.
          await seedPool.query(
            `INSERT INTO ai_call_feedback (call_id, rating, user_hash)
             VALUES ($1, $2, $3)`,
            [callId, call.rating, `db-test-${RUN_ID}-${userCounter++}`],
          );
        }
      }
    }
  }

  async function cleanup(): Promise<void> {
    try {
      if (seededCallIds.length > 0) {
        // ai_call_feedback CASCADEs on call_id, so deleting metrics is enough.
        await seedPool.query(
          `DELETE FROM ai_call_metrics WHERE id = ANY($1::bigint[])`,
          [seededCallIds],
        );
        seededCallIds.length = 0;
      }
      // Belt-and-braces — sweep anything that might have leaked under our
      // unique agent name (e.g. a partial seed from a crashed prior run).
      await seedPool.query(
        `DELETE FROM ai_call_metrics WHERE agent_name = $1`,
        [AGENT_NAME],
      );
    } finally {
      await seedPool.end().catch(() => {});
    }
  }

  type Aggregate = PromptVersionAggregate & { call_count: any; total_feedback: any };
  // Postgres returns COUNT() as a string (BIGINT) via node-postgres; the
  // dashboard parses these client-side. We coerce to Number here for
  // straightforward equality assertions.
  const num = (v: any): number => Number(v);

  function findRow(rows: PromptVersionAggregate[], version: string): Aggregate | undefined {
    return rows.find(
      (r) => r.agent_name === AGENT_NAME && r.prompt_version === version,
    ) as Aggregate | undefined;
  }

  try {
    await seed();

    // ─── 5a. Default floor (5) — the production default ─────────────────────
    await suite.test("DB: default floor (5) — meets_min_feedback flips at exactly 5 votes", async () => {
      const rows = await getFeedbackRateByPromptVersion(
        30,
        DEFAULT_PROMPT_VERSION_MIN_FEEDBACK,
      );
      const v0 = findRow(rows, V0);
      const v1 = findRow(rows, V1);
      const vn = findRow(rows, VN);
      const vn1 = findRow(rows, VN1);

      suite.expect(!!v0, `${V0} cohort row present`);
      suite.expect(!!v1, `${V1} cohort row present`);
      suite.expect(!!vn, `${VN} cohort row present`);
      suite.expect(!!vn1, `${VN1} cohort row present`);

      // call_count: COUNT(*) over each cohort
      suite.expectEqual(num(v0?.call_count), 1, `${V0} call_count`);
      suite.expectEqual(num(v1?.call_count), 1, `${V1} call_count`);
      suite.expectEqual(num(vn?.call_count), 5, `${VN} call_count`);
      suite.expectEqual(num(vn1?.call_count), 6, `${VN1} call_count`);

      // total_feedback: COUNT(f.id) — verifies the LEFT JOIN counts rows,
      // not calls
      suite.expectEqual(num(v0?.total_feedback), 0, `${V0} total_feedback`);
      suite.expectEqual(num(v1?.total_feedback), 1, `${V1} total_feedback`);
      suite.expectEqual(num(vn?.total_feedback), 5, `${VN} total_feedback`);
      suite.expectEqual(num(vn1?.total_feedback), 6, `${VN1} total_feedback`);

      // FILTER clauses — VN1 has a thumbs_down mixed in, so this is the
      // assertion that catches a swapped/typo'd FILTER
      suite.expectEqual(num(vn1?.thumbs_up), 5, `${VN1} thumbs_up`);
      suite.expectEqual(num(vn1?.thumbs_down), 1, `${VN1} thumbs_down`);

      // The headline assertion of the whole task: COUNT(f.id) >= $2 must
      // be TRUE iff total_feedback meets the floor inclusively.
      suite.expectEqual(v0?.meets_min_feedback, false, `${V0} meets_min_feedback`);
      suite.expectEqual(v1?.meets_min_feedback, false, `${V1} meets_min_feedback`);
      suite.expectEqual(vn?.meets_min_feedback, true, `${VN} meets_min_feedback (boundary inclusive)`);
      suite.expectEqual(vn1?.meets_min_feedback, true, `${VN1} meets_min_feedback`);

      // min_feedback: $2::INTEGER must round-trip as a JS number, not a
      // string. Catches a regression where the cast silently drops to
      // numeric/text and breaks JSON.stringify on the dashboard.
      suite.expectEqual(typeof v0?.min_feedback, "number", `${V0} min_feedback type`);
      suite.expectEqual(v0?.min_feedback, DEFAULT_PROMPT_VERSION_MIN_FEEDBACK, `${V0} min_feedback echo`);
      suite.expectEqual(v1?.min_feedback, DEFAULT_PROMPT_VERSION_MIN_FEEDBACK, `${V1} min_feedback echo`);
      suite.expectEqual(vn?.min_feedback, DEFAULT_PROMPT_VERSION_MIN_FEEDBACK, `${VN} min_feedback echo`);
      suite.expectEqual(vn1?.min_feedback, DEFAULT_PROMPT_VERSION_MIN_FEEDBACK, `${VN1} min_feedback echo`);

      // meets_min_feedback should land in JS as a real boolean (Postgres
      // BOOLEAN -> node-postgres bool). A drift to '"t"' / '"f"' would
      // silently make the dashboard's `?` operator wrong.
      suite.expectEqual(typeof vn?.meets_min_feedback, "boolean", `${VN} meets_min_feedback type`);
    });

    // ─── 5b. Floor = 1 — boundary at the very low end ───────────────────────
    await suite.test("DB: floor=1 — 0-vote false, 1-vote true (boundary inclusive at 1)", async () => {
      const rows = await getFeedbackRateByPromptVersion(30, 1);
      const v0 = findRow(rows, V0);
      const v1 = findRow(rows, V1);
      const vn = findRow(rows, VN);
      const vn1 = findRow(rows, VN1);

      suite.expectEqual(v0?.meets_min_feedback, false, `${V0} false at floor=1`);
      suite.expectEqual(v1?.meets_min_feedback, true, `${V1} true at floor=1`);
      suite.expectEqual(vn?.meets_min_feedback, true, `${VN} true at floor=1`);
      suite.expectEqual(vn1?.meets_min_feedback, true, `${VN1} true at floor=1`);

      // Echo
      suite.expectEqual(v0?.min_feedback, 1, `${V0} min_feedback=1`);
      suite.expectEqual(v1?.min_feedback, 1, `${V1} min_feedback=1`);
    });

    // ─── 5c. Floor = 0 — protection disabled ────────────────────────────────
    await suite.test("DB: floor=0 — every cohort meets_min_feedback (0 >= 0)", async () => {
      const rows = await getFeedbackRateByPromptVersion(30, 0);
      const v0 = findRow(rows, V0);
      const v1 = findRow(rows, V1);
      const vn = findRow(rows, VN);
      const vn1 = findRow(rows, VN1);

      suite.expectEqual(v0?.meets_min_feedback, true, `${V0} true at floor=0`);
      suite.expectEqual(v1?.meets_min_feedback, true, `${V1} true at floor=0`);
      suite.expectEqual(vn?.meets_min_feedback, true, `${VN} true at floor=0`);
      suite.expectEqual(vn1?.meets_min_feedback, true, `${VN1} true at floor=0`);

      // Echo — verifies $2::INTEGER returns 0 (not null) when floor is 0
      suite.expectEqual(v0?.min_feedback, 0, `${V0} min_feedback=0`);
      suite.expectEqual(vn1?.min_feedback, 0, `${VN1} min_feedback=0`);
    });

    // ─── 5d. Floor = 6 — flips the N-exact cohort to false ──────────────────
    await suite.test("DB: floor=6 — 5-vote cohort false, 6-vote cohort true (>= not >)", async () => {
      const rows = await getFeedbackRateByPromptVersion(30, 6);
      const vn = findRow(rows, VN);
      const vn1 = findRow(rows, VN1);

      // The expected discriminator: 5 < 6 → false, 6 >= 6 → true. If the
      // SQL ever drifts from `>=` to `>` this assertion catches it.
      suite.expectEqual(vn?.meets_min_feedback, false, `${VN} false at floor=6 (5 < 6)`);
      suite.expectEqual(vn1?.meets_min_feedback, true, `${VN1} true at floor=6 (boundary inclusive)`);
      suite.expectEqual(vn?.min_feedback, 6, `${VN} min_feedback=6`);
      suite.expectEqual(vn1?.min_feedback, 6, `${VN1} min_feedback=6`);
    });
  } finally {
    await cleanup();
  }
} else {
  console.log("  (skipped) DB-gated SQL verification — DATABASE_URL not set");
}

suite.finishOrExit();
