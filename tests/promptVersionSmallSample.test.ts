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
  getFeedbackRateByAgent,
  getRecentNegativeFeedback,
  DEFAULT_PROMPT_VERSION_MIN_FEEDBACK,
  type PromptVersionAggregate,
} from "../src/utils/aiTelemetry";
import { aiOpsRoutes } from "../src/mastra/routes/aiOpsRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext } from "./_helpers/fakeContext";
import { makeCookieForRole } from "./_helpers/sessionAuth";

const suite = new TestSuite("promptVersionSmallSample");
const ADMIN_KEY = "integration-test-prompt-version-2026";
// Signed walaplus_session cookie for an active admin platform user. The
// prompt-versions route uses requireRole(), which now always performs a live
// getPlatformUser() lookup — the shared helper also registers an active
// platform_users row for this session's email.
const ADMIN_COOKIE = makeCookieForRole("admin");

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
        last_seen_at: "2026-04-01T00:00:00Z",
        client_surfaces: {},
        rating_sources: {},
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
        headers: { Cookie: ADMIN_COOKIE },
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
        headers: { Cookie: ADMIN_COOKIE },
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
        headers: { Cookie: ADMIN_COOKIE },
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
        headers: { Cookie: ADMIN_COOKIE },
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
        headers: { Cookie: ADMIN_COOKIE },
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

// ─────────────────────────────────────────────────────────────────────────────
// 6. DB-gated integration — sibling reader getFeedbackRateByAgent (Task #506)
//
// `getFeedbackRateByAgent` lives next to `getFeedbackRateByPromptVersion` and
// uses the same JOIN-and-FILTER pattern (joins ai_call_feedback to
// ai_call_metrics, splits ratings via FILTER, divides by NULLIF(COUNT(...), 0)
// so a zero-feedback agent is null-not-NaN). It powers the dashboard's
// per-agent feedback-rate column. The stub-pool style we use elsewhere
// cannot catch a swapped FILTER clause, a typo'd JOIN key, a missing GROUP BY
// column, or a NULLIF regression in this query — only running it against a
// real Postgres can. This block seeds two synthetic agents under a unique
// agent_name prefix (so it cannot collide with live data), one with all
// thumbs_up and one with a known thumbs_up/thumbs_down mix that exercises
// 1-decimal rounding (2/3 → 66.7%), then asserts every column the dashboard
// reads. Cleanup deletes every seeded row in a `finally` so a crashed
// assertion still leaves the database clean.
// ─────────────────────────────────────────────────────────────────────────────

if (HAS_DB) {
  const pg = await import("pg");
  const { Pool } = pg.default;
  const { ensureAiMetricsTable } = await import("../src/utils/aiTelemetry");

  const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Two agents, both under a unique prefix so listing the prefix is enough
  // to find ours among whatever live agents the DB already contains.
  const AGENT_PREFIX = `db_agentfb_test_${RUN_ID}`;
  const AGENT_ALLUP = `${AGENT_PREFIX}_allup`;
  const AGENT_MIX = `${AGENT_PREFIX}_mix`;

  const seedPool = new Pool({ connectionString: process.env.DATABASE_URL });

  // Make sure both tables exist before INSERTing directly. The production
  // pool inside aiTelemetry does this lazily on the first read, but our
  // seed pool is a separate Pool instance and would race with that.
  await ensureAiMetricsTable();
  // ensureFeedbackTable() is private; the easiest way to force it is to
  // call the production reader once — also a no-op if the table exists.
  await getFeedbackRateByAgent();

  // Track every call_id we insert so cleanup is targeted even if something
  // else in the same DB happens to share our agent name (defence in depth —
  // the unique RUN_ID suffix already prevents that).
  const seededCallIds: number[] = [];

  async function seed(): Promise<void> {
    // Cohort plan:
    //   AGENT_ALLUP → 4 calls, all thumbs_up
    //                 expected: total=4, up=4, down=0, rate=100.0
    //   AGENT_MIX   → 3 calls, 2 thumbs_up + 1 thumbs_down
    //                 expected: total=3, up=2, down=1, rate=66.7
    //                 (2/3 * 100 = 66.666… → ROUND to 1 decimal = 66.7,
    //                  so this also locks the rounding behaviour)
    const cohorts: Array<{
      agent: string;
      calls: Array<{ rating: "thumbs_up" | "thumbs_down"; latencyMs: number }>;
    }> = [
      {
        agent: AGENT_ALLUP,
        calls: [
          { rating: "thumbs_up", latencyMs: 100 },
          { rating: "thumbs_up", latencyMs: 110 },
          { rating: "thumbs_up", latencyMs: 120 },
          { rating: "thumbs_up", latencyMs: 130 },
        ],
      },
      {
        agent: AGENT_MIX,
        calls: [
          { rating: "thumbs_up", latencyMs: 200 },
          { rating: "thumbs_up", latencyMs: 210 },
          { rating: "thumbs_down", latencyMs: 220 },
        ],
      },
    ];

    let userCounter = 0;
    for (const cohort of cohorts) {
      for (const call of cohort.calls) {
        const metricRes = await seedPool.query(
          `INSERT INTO ai_call_metrics
             (agent_name, tool_name, model, latency_ms, success, started_at)
           VALUES ($1, NULL, 'gpt-4o', $2, TRUE, NOW())
           RETURNING id`,
          [cohort.agent, call.latencyMs],
        );
        const callId = Number(metricRes.rows[0].id);
        seededCallIds.push(callId);

        // user_hash must be unique per (call_id, user_hash); a per-call
        // counter is enough since we only insert one feedback row per call.
        await seedPool.query(
          `INSERT INTO ai_call_feedback (call_id, rating, user_hash)
           VALUES ($1, $2, $3)`,
          [callId, call.rating, `db-agent-test-${RUN_ID}-${userCounter++}`],
        );
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
      // unique agent prefix (e.g. a partial seed from a crashed prior run).
      await seedPool.query(
        `DELETE FROM ai_call_metrics WHERE agent_name LIKE $1`,
        [`${AGENT_PREFIX}%`],
      );
    } finally {
      await seedPool.end().catch(() => {});
    }
  }

  // node-postgres returns COUNT() as a string (BIGINT). The dashboard parses
  // these client-side; we coerce here for straightforward equality.
  const num = (v: any): number => Number(v);

  try {
    await seed();

    await suite.test("DB: getFeedbackRateByAgent — all-thumbs-up agent reports 100.0%", async () => {
      const rows = await getFeedbackRateByAgent();
      const row = rows.find((r) => r.agent_name === AGENT_ALLUP);

      suite.expect(!!row, `${AGENT_ALLUP} cohort row present`);

      // total_feedback: COUNT(f.id) — verifies the JOIN counts feedback
      // rows, not metrics rows.
      suite.expectEqual(num(row?.total_feedback), 4, `${AGENT_ALLUP} total_feedback`);

      // FILTER clauses — must split cleanly when there are no thumbs_down.
      // A swapped FILTER clause would surface here (down would be 4).
      suite.expectEqual(num(row?.thumbs_up), 4, `${AGENT_ALLUP} thumbs_up`);
      suite.expectEqual(num(row?.thumbs_down), 0, `${AGENT_ALLUP} thumbs_down`);

      // 4/4 * 100 = 100, ROUND to 1 decimal = 100.0
      suite.expectEqual(num(row?.feedback_rate_pct), 100, `${AGENT_ALLUP} feedback_rate_pct`);
    });

    await suite.test("DB: getFeedbackRateByAgent — mixed agent reports 66.7% (rounding to 1 decimal)", async () => {
      const rows = await getFeedbackRateByAgent();
      const row = rows.find((r) => r.agent_name === AGENT_MIX);

      suite.expect(!!row, `${AGENT_MIX} cohort row present`);

      suite.expectEqual(num(row?.total_feedback), 3, `${AGENT_MIX} total_feedback`);

      // The headline FILTER assertion — if the up/down clauses are ever
      // swapped this flips and is caught immediately.
      suite.expectEqual(num(row?.thumbs_up), 2, `${AGENT_MIX} thumbs_up`);
      suite.expectEqual(num(row?.thumbs_down), 1, `${AGENT_MIX} thumbs_down`);

      // 2/3 * 100 = 66.666… ROUND to 1 decimal = 66.7. Locks both the
      // FLOAT division (NULLIF guard) and the ROUND(..., 1) precision the
      // dashboard depends on.
      suite.expectEqual(num(row?.feedback_rate_pct), 66.7, `${AGENT_MIX} feedback_rate_pct`);
    });
  } finally {
    await cleanup();
  }
} else {
  console.log("  (skipped) DB-gated getFeedbackRateByAgent verification — DATABASE_URL not set");
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. DB-gated integration — sibling reader getRecentNegativeFeedback (Task #567)
//
// `getRecentNegativeFeedback` lives just above `getFeedbackRateByAgent` and
// uses the same JOIN-and-FILTER pattern (joins ai_call_feedback to
// ai_call_metrics, filters by `rating = 'thumbs_down'` and a 30-day window,
// orders by created_at DESC, applies a LIMIT). It powers the dashboard's
// recent-negative-feedback panel. There is no JS stub mirror for this query,
// so without a live-DB block a swapped JOIN key, a typo'd WHERE clause, or
// an off-by-one in the LIMIT/ORDER BY would silently break the panel.
//
// This block seeds five synthetic feedback rows under a unique agent name
// (so they cannot collide with live data):
//   • 3 thumbs_down rows inside the 30-day window, with backdated created_at
//     spaced apart so the DESC ordering is unambiguous
//   • 1 thumbs_up row inside the window — must be excluded by the rating
//     filter
//   • 1 thumbs_down row 31 days old — must be excluded by the 30-day window
//
// Asserts that filtering to our prefix returns exactly the 3 in-window
// thumbs_down rows, in DESC order by created_at, with every column the
// dashboard reads round-tripped correctly. Also calls with a small `limit`
// (2) and asserts the result length equals 2 to lock the LIMIT clause —
// since we just inserted ≥3 in-window thumbs_down rows ourselves, any
// LIMIT 2 query against the global table is guaranteed to return 2.
// Cleanup deletes every seeded row in a `finally` so a crashed assertion
// still leaves the database clean.
// ─────────────────────────────────────────────────────────────────────────────

if (HAS_DB) {
  const pg = await import("pg");
  const { Pool } = pg.default;
  const { ensureAiMetricsTable } = await import("../src/utils/aiTelemetry");

  const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const AGENT_NAME = `db_recentneg_test_${RUN_ID}`;

  const seedPool = new Pool({ connectionString: process.env.DATABASE_URL });

  // Make sure both tables exist before INSERTing directly. The production
  // pool inside aiTelemetry does this lazily on the first read, but our
  // seed pool is a separate Pool instance and would race with that.
  await ensureAiMetricsTable();
  // ensureFeedbackTable() is private; the easiest way to force it is to
  // call the production reader once — also a no-op if the table exists.
  await getRecentNegativeFeedback(1);

  // Track every call_id we insert so cleanup is targeted even if something
  // else in the same DB happens to share our agent name (defence in depth —
  // the unique RUN_ID suffix already prevents that).
  const seededCallIds: number[] = [];

  // Cohort plan, designed to walk every clause in the SQL:
  //   TD1   → thumbs_down, NOW()                      (in window, newest)
  //   TD2   → thumbs_down, NOW() - INTERVAL '5 days'  (in window, middle)
  //   TD3   → thumbs_down, NOW() - INTERVAL '15 days' (in window, oldest)
  //   TU    → thumbs_up,   NOW() - INTERVAL '2 days'  (excluded by rating)
  //   TDold → thumbs_down, NOW() - INTERVAL '31 days' (excluded by window)
  //
  // Each metrics row carries distinct latency_ms / prompt_preview /
  // success / error_class values so a swapped JOIN key would surface as
  // mismatched columns instead of silently passing.
  type Cohort = {
    label: string;
    rating: "thumbs_up" | "thumbs_down";
    createdAtSql: string;
    latencyMs: number;
    promptPreview: string;
    success: boolean;
    errorClass: string | null;
    comment: string | null;
  };

  const cohorts: Cohort[] = [
    {
      label: "TD1",
      rating: "thumbs_down",
      createdAtSql: "NOW()",
      latencyMs: 111,
      promptPreview: "preview-TD1",
      success: true,
      errorClass: null,
      comment: "Bad answer",
    },
    {
      label: "TD2",
      rating: "thumbs_down",
      createdAtSql: "NOW() - INTERVAL '5 days'",
      latencyMs: 222,
      promptPreview: "preview-TD2",
      success: false,
      errorClass: "TimeoutError",
      comment: null,
    },
    {
      label: "TD3",
      rating: "thumbs_down",
      createdAtSql: "NOW() - INTERVAL '15 days'",
      latencyMs: 333,
      promptPreview: "preview-TD3",
      success: true,
      errorClass: null,
      comment: "Hallucinated",
    },
    {
      label: "TU",
      rating: "thumbs_up",
      createdAtSql: "NOW() - INTERVAL '2 days'",
      latencyMs: 444,
      promptPreview: "preview-TU",
      success: true,
      errorClass: null,
      comment: null,
    },
    {
      label: "TDold",
      rating: "thumbs_down",
      createdAtSql: "NOW() - INTERVAL '31 days'",
      latencyMs: 555,
      promptPreview: "preview-TDold",
      success: true,
      errorClass: null,
      comment: "Too old to surface",
    },
  ];

  // Map label → call_id so assertions can locate rows precisely.
  const callIdByLabel = new Map<string, string>();

  async function seed(): Promise<void> {
    let userCounter = 0;
    for (const c of cohorts) {
      const metricRes = await seedPool.query(
        `INSERT INTO ai_call_metrics
           (agent_name, tool_name, model, latency_ms, success, error_class,
            prompt_preview, started_at)
         VALUES ($1, NULL, 'gpt-4o', $2, $3, $4, $5, NOW())
         RETURNING id`,
        [AGENT_NAME, c.latencyMs, c.success, c.errorClass, c.promptPreview],
      );
      const callId = Number(metricRes.rows[0].id);
      seededCallIds.push(callId);
      callIdByLabel.set(c.label, String(callId));

      // Backdate created_at via the cohort's SQL fragment. The fragment is
      // a hard-coded literal from the cohort table above (NOT user input),
      // so direct interpolation is safe and side-steps parameter typing
      // for INTERVAL expressions.
      await seedPool.query(
        `INSERT INTO ai_call_feedback (call_id, rating, user_hash, comment, created_at)
         VALUES ($1, $2, $3, $4, ${c.createdAtSql})`,
        [callId, c.rating, `db-recentneg-${RUN_ID}-${userCounter++}`, c.comment],
      );
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

  try {
    await seed();

    // ─── 7a. Returns only in-window thumbs_down rows, in DESC order ─────────
    await suite.test("DB: getRecentNegativeFeedback — only in-window thumbs_down rows from our prefix appear, DESC by created_at", async () => {
      // Use a generous limit so all of our seeded rows are guaranteed to
      // come back even on a busy shared DB. The LIMIT clause is exercised
      // separately in 7b below.
      const rows = await getRecentNegativeFeedback(1000);
      const ours = rows.filter((r) => r.agent_name === AGENT_NAME);

      // Exactly the three in-window thumbs_down cohorts — TU (thumbs_up)
      // and TDold (older than 30 days) must be excluded.
      suite.expectEqual(ours.length, 3, "exactly 3 in-window thumbs_down rows from our prefix");

      // No thumbs_up row (TU) should leak through the rating filter.
      const tuCallId = callIdByLabel.get("TU");
      suite.expect(
        !ours.some((r) => r.call_id === tuCallId),
        "TU (thumbs_up) excluded by rating filter",
      );

      // No >30-day-old row (TDold) should leak through the window filter.
      const tdOldCallId = callIdByLabel.get("TDold");
      suite.expect(
        !ours.some((r) => r.call_id === tdOldCallId),
        "TDold (thumbs_down older than 30 days) excluded by window filter",
      );

      // ORDER BY f.created_at DESC — TD1 (NOW) > TD2 (5d ago) > TD3 (15d ago).
      // Comparing call_id rather than feedback_id keeps the assertion
      // independent of insertion order at the feedback-table level.
      suite.expectEqual(ours[0]?.call_id, callIdByLabel.get("TD1"), "row 0 = TD1 (newest)");
      suite.expectEqual(ours[1]?.call_id, callIdByLabel.get("TD2"), "row 1 = TD2 (middle)");
      suite.expectEqual(ours[2]?.call_id, callIdByLabel.get("TD3"), "row 2 = TD3 (oldest in window)");

      // Verify created_at is strictly decreasing — catches a regression
      // from DESC to ASC even if the cohort positions happen to align.
      const t0 = new Date(ours[0]!.created_at).getTime();
      const t1 = new Date(ours[1]!.created_at).getTime();
      const t2 = new Date(ours[2]!.created_at).getTime();
      suite.expect(t0 > t1, "created_at strictly DESC between row 0 and row 1");
      suite.expect(t1 > t2, "created_at strictly DESC between row 1 and row 2");

      // Column round-trip — verifies the JOIN actually pulls fields from
      // the metrics row matching f.call_id (not, say, f.id). Each cohort
      // has distinct values so a swapped JOIN key would surface here as
      // mismatched columns.
      const td1 = ours[0]!;
      suite.expectEqual(td1.model, "gpt-4o", "TD1 model");
      suite.expectEqual(Number(td1.latency_ms), 111, "TD1 latency_ms");
      suite.expectEqual(td1.success, true, "TD1 success");
      suite.expectEqual(td1.error_class, null, "TD1 error_class");
      suite.expectEqual(td1.prompt_preview, "preview-TD1", "TD1 prompt_preview");
      suite.expectEqual(td1.comment, "Bad answer", "TD1 comment round-trip");

      const td2 = ours[1]!;
      suite.expectEqual(Number(td2.latency_ms), 222, "TD2 latency_ms");
      suite.expectEqual(td2.success, false, "TD2 success (failure case)");
      suite.expectEqual(td2.error_class, "TimeoutError", "TD2 error_class");
      suite.expectEqual(td2.prompt_preview, "preview-TD2", "TD2 prompt_preview");
      suite.expectEqual(td2.comment, null, "TD2 comment is null when not set");
    });

    // ─── 7b. LIMIT clause is honoured ───────────────────────────────────────
    await suite.test("DB: getRecentNegativeFeedback — LIMIT is honoured (limit=2 returns 2 rows)", async () => {
      // We just seeded 3 in-window thumbs_down rows ourselves, so the
      // global table is guaranteed to contain ≥3 such rows. A LIMIT 2
      // query must therefore return exactly 2 rows. If the LIMIT clause
      // were dropped or off-by-one the assertion catches it immediately.
      const rows = await getRecentNegativeFeedback(2);
      suite.expectEqual(rows.length, 2, "limit=2 returns exactly 2 rows");
    });
  } finally {
    await cleanup();
  }
} else {
  console.log("  (skipped) DB-gated getRecentNegativeFeedback verification — DATABASE_URL not set");
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. DB-gated integration — Task #598 drill-down filters on
//    getRecentNegativeFeedback({ agentName, days }).
//
// Verifies the new options-bag overload added for the AI Ops dashboard:
//   * `agentName` narrows to a single agent (other agents must be excluded
//     even when they have in-window thumbs_down rows in the same DB).
//   * `days` is a real parameterized lookback that lets the 7/30/90 toggle
//     widen or narrow the window — exercised at the 7d / 30d / 90d
//     boundaries with rows seeded just inside and just outside each.
//
// Defence-in-depth: the legacy positional-limit form is also re-asserted
// here so the back-compat shim never silently regresses.
// ─────────────────────────────────────────────────────────────────────────────
if (HAS_DB) {
  const pg = await import("pg");
  const { Pool } = pg.default;
  const { ensureAiMetricsTable } = await import("../src/utils/aiTelemetry");

  const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Two distinct agent names sharing a common prefix so the test can
  // either narrow to one (via agentName) or grab both (via prefix scan).
  const AGENT_A = `db_recentneg598_a_${RUN_ID}`;
  const AGENT_B = `db_recentneg598_b_${RUN_ID}`;

  const seedPool = new Pool({ connectionString: process.env.DATABASE_URL });

  await ensureAiMetricsTable();
  // Force ensureFeedbackTable() (private) by hitting the production reader
  // once — same trick block 7 uses.
  await getRecentNegativeFeedback(1);

  const seededCallIds: number[] = [];

  // Boundary cohort plan. Each row is a thumbs_down so the rating filter
  // never excludes them — every exclusion is driven by the day window or
  // the agentName filter under test.
  //
  //   A_today    → AGENT_A, NOW()                       → in 7d, 30d, 90d
  //   A_5d       → AGENT_A, NOW() - INTERVAL '5 days'   → in 7d, 30d, 90d
  //   A_8d       → AGENT_A, NOW() - INTERVAL '8 days'   → out of 7d, in 30d, in 90d
  //   A_31d      → AGENT_A, NOW() - INTERVAL '31 days'  → out of 7d, out of 30d, in 90d
  //   A_91d      → AGENT_A, NOW() - INTERVAL '91 days'  → out of 7d, 30d, 90d
  //   B_today    → AGENT_B, NOW()                       → in every window, but
  //                                                       excluded by agentName=A
  type Cohort = {
    label: string;
    agent: string;
    createdAtSql: string;
    latencyMs: number;
  };

  const cohorts: Cohort[] = [
    { label: "A_today", agent: AGENT_A, createdAtSql: "NOW()",                          latencyMs: 101 },
    { label: "A_5d",    agent: AGENT_A, createdAtSql: "NOW() - INTERVAL '5 days'",     latencyMs: 105 },
    { label: "A_8d",    agent: AGENT_A, createdAtSql: "NOW() - INTERVAL '8 days'",     latencyMs: 108 },
    { label: "A_31d",   agent: AGENT_A, createdAtSql: "NOW() - INTERVAL '31 days'",    latencyMs: 131 },
    { label: "A_91d",   agent: AGENT_A, createdAtSql: "NOW() - INTERVAL '91 days'",    latencyMs: 191 },
    { label: "B_today", agent: AGENT_B, createdAtSql: "NOW()",                          latencyMs: 201 },
  ];

  const callIdByLabel = new Map<string, string>();

  async function seed598(): Promise<void> {
    let userCounter = 0;
    for (const c of cohorts) {
      const metricRes = await seedPool.query(
        `INSERT INTO ai_call_metrics
           (agent_name, tool_name, model, latency_ms, success, error_class,
            prompt_preview, started_at)
         VALUES ($1, NULL, 'gpt-4o', $2, true, NULL, $3, NOW())
         RETURNING id`,
        [c.agent, c.latencyMs, `preview-${c.label}`],
      );
      const callId = Number(metricRes.rows[0].id);
      seededCallIds.push(callId);
      callIdByLabel.set(c.label, String(callId));

      await seedPool.query(
        `INSERT INTO ai_call_feedback (call_id, rating, user_hash, comment, created_at)
         VALUES ($1, 'thumbs_down', $2, NULL, ${c.createdAtSql})`,
        [callId, `db-recentneg598-${RUN_ID}-${userCounter++}`],
      );
    }
  }

  async function cleanup598(): Promise<void> {
    try {
      if (seededCallIds.length > 0) {
        await seedPool.query(
          `DELETE FROM ai_call_metrics WHERE id = ANY($1::bigint[])`,
          [seededCallIds],
        );
        seededCallIds.length = 0;
      }
      await seedPool.query(
        `DELETE FROM ai_call_metrics WHERE agent_name IN ($1, $2)`,
        [AGENT_A, AGENT_B],
      );
    } finally {
      await seedPool.end().catch(() => {});
    }
  }

  try {
    await seed598();

    // ─── 8a. agentName filter narrows to one agent ────────────────────────
    await suite.test("DB: getRecentNegativeFeedback — agentName narrows to a single agent", async () => {
      // Use a 365d window so the agent filter is the only narrowing dimension.
      const rows = await getRecentNegativeFeedback({
        limit: 1000,
        days: 365,
        agentName: AGENT_A,
      });
      const seenAgents = new Set(rows.map((r) => r.agent_name));
      // No B rows — even though AGENT_B has a fresh in-window thumbs_down.
      suite.expect(
        !seenAgents.has(AGENT_B),
        `agentName=${AGENT_A} excludes rows from sibling agent ${AGENT_B}`,
      );
      // All 5 of agent A's seeded rows come back (every cohort fits within 365d).
      const oursA = rows.filter((r) => r.agent_name === AGENT_A);
      suite.expectEqual(oursA.length, 5, "all 5 AGENT_A rows visible at days=365");

      // Sanity: omitting agentName surfaces both agents from our prefix.
      const allRows = await getRecentNegativeFeedback({ limit: 1000, days: 365 });
      const ours = allRows.filter(
        (r) => r.agent_name === AGENT_A || r.agent_name === AGENT_B,
      );
      const aCount = ours.filter((r) => r.agent_name === AGENT_A).length;
      const bCount = ours.filter((r) => r.agent_name === AGENT_B).length;
      suite.expectEqual(aCount, 5, "no agentName: 5 AGENT_A rows visible");
      suite.expectEqual(bCount, 1, "no agentName: 1 AGENT_B row visible");
    });

    // ─── 8b. day-window boundaries: 7d / 30d / 90d ────────────────────────
    await suite.test("DB: getRecentNegativeFeedback — days window boundaries (7/30/90) include/exclude correctly", async () => {
      const labelsAtWindow = async (days: number): Promise<Set<string>> => {
        const rows = await getRecentNegativeFeedback({
          limit: 1000,
          days,
          agentName: AGENT_A, // narrow to A so other tenants don't pollute
        });
        const ids = new Set(rows.map((r) => r.call_id));
        const labels = new Set<string>();
        for (const [label, callId] of callIdByLabel.entries()) {
          if (label.startsWith("A_") && ids.has(callId)) labels.add(label);
        }
        return labels;
      };

      // 7-day window: A_today + A_5d in; A_8d / A_31d / A_91d out.
      const w7 = await labelsAtWindow(7);
      suite.expect(w7.has("A_today"), "days=7: A_today (NOW()) included");
      suite.expect(w7.has("A_5d"),    "days=7: A_5d (5 days ago) included");
      suite.expect(!w7.has("A_8d"),   "days=7: A_8d (8 days ago) excluded — just past boundary");
      suite.expect(!w7.has("A_31d"),  "days=7: A_31d excluded");
      suite.expect(!w7.has("A_91d"),  "days=7: A_91d excluded");

      // 30-day window: A_today / A_5d / A_8d in; A_31d / A_91d out.
      const w30 = await labelsAtWindow(30);
      suite.expect(w30.has("A_today"), "days=30: A_today included");
      suite.expect(w30.has("A_5d"),    "days=30: A_5d included");
      suite.expect(w30.has("A_8d"),    "days=30: A_8d (8 days ago) now included");
      suite.expect(!w30.has("A_31d"),  "days=30: A_31d (31 days ago) excluded — just past boundary");
      suite.expect(!w30.has("A_91d"),  "days=30: A_91d excluded");

      // 90-day window: everything except A_91d in.
      const w90 = await labelsAtWindow(90);
      suite.expect(w90.has("A_today"), "days=90: A_today included");
      suite.expect(w90.has("A_5d"),    "days=90: A_5d included");
      suite.expect(w90.has("A_8d"),    "days=90: A_8d included");
      suite.expect(w90.has("A_31d"),   "days=90: A_31d (31 days ago) now included");
      suite.expect(!w90.has("A_91d"),  "days=90: A_91d (91 days ago) excluded — just past boundary");

      // Strictly monotonic: each wider window is a superset of the narrower one.
      for (const lbl of w7)  suite.expect(w30.has(lbl), `30d window is a superset of 7d (missing ${lbl})`);
      for (const lbl of w30) suite.expect(w90.has(lbl), `90d window is a superset of 30d (missing ${lbl})`);
    });

    // ─── 8c. legacy positional-limit form still works ─────────────────────
    await suite.test("DB: getRecentNegativeFeedback — legacy positional-limit form preserved", async () => {
      // Numeric first arg should still be treated as `limit` (back-compat
      // for callers from before Task #598). We seeded 5 in-90d AGENT_A
      // thumbs_down rows; with the default 30-day window only 3 are in
      // scope (A_today, A_5d, A_8d). LIMIT 1 must therefore return ≤1 row.
      const rows = await getRecentNegativeFeedback(1);
      suite.expect(rows.length <= 1, "positional limit=1 honoured by back-compat shim");
    });
  } finally {
    await cleanup598();
  }
} else {
  console.log("  (skipped) DB-gated Task #598 drill-down filter verification — DATABASE_URL not set");
}

suite.finishOrExit();
