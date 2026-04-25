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

suite.finishOrExit();
