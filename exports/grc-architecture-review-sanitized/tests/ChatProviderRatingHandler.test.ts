/**
 * Integration tests for src/triggers/ChatProviderRatingHandler.ts (Task #763).
 *
 * Verifies the ChatProvider/mobile/embedded helper:
 *   1. Looks up `metadata->>'prompt_version'` from `ai_call_metrics` for
 *      the rated callId so the rating is attributed to the right
 *      revision in the AI Ops per-version dashboard.
 *   2. Inserts the thumbs-up/down row through the same persistence path
 *      the web call-id endpoint uses.
 *   3. Backfills `metadata->>'client_surface'` onto the call row so the
 *      per-surface dashboard breakdown attributes the rating correctly.
 *   4. Honors the never-overwrite-server-truth contract for both fields.
 *
 * Run:  npx tsx tests/ChatProviderRatingHandler.test.ts
 */

import { TestSuite } from "./_helpers/runner";

const suite = new TestSuite("ChatProviderRatingHandler");
const HAS_DB = !!process.env.DATABASE_URL;

console.log("\n=== ChatProviderRatingHandler integration tests ===\n");

if (!HAS_DB) {
  console.log("SKIP: DATABASE_URL not set; skipping DB-bound tests.");
  process.exit(0);
}

const { recordConsultantRatingFromSurface } = await import(
  "../src/triggers/ChatProviderRatingHandler"
);
const { insertAiCallMetric, ensureAiMetricsTable } = await import(
  "../src/utils/aiTelemetry"
);
const pgMod = await import("pg");

const TEST_AGENT = `__test_ChatProvider_rating_${Date.now()}__`;
const SERVER_VERSION = "<REDACTED_EMAIL>";

await suite.test(
  "recordConsultantRatingFromSurface — looks up prompt_version, records rating, backfills client_surface",
  async () => {
    await ensureAiMetricsTable();
    const callId = await insertAiCallMetric({
      agent_name: TEST_AGENT,
      model: "gpt-4o",
      latency_ms: 600,
      success: true,
      metadata: { prompt_version: SERVER_VERSION },
    });
    suite.expect(callId != null, "seeded call row");
    const numericCallId = Number(callId);

    const result = await recordConsultantRatingFromSurface({
      callId: numericCallId,
      rating: "thumbs_up",
      surface: "ChatProvider",
      userHash: "U_ChatProvider_TEST_USER",
    });

    suite.expectEqual(result.success, true, "rating persisted");
    suite.expectEqual(
      result.promptVersion,
      SERVER_VERSION,
      "prompt_version returned matches server-side metadata",
    );

    const pool = new pgMod.default.Pool({
      connectionString: process.env.DATABASE_URL,
    });
    try {
      const meta = (
        await pool.query(
          `SELECT metadata FROM ai_call_metrics WHERE id = $1`,
          [callId],
        )
      ).rows[0]?.metadata;
      suite.expectEqual(
        meta?.client_surface,
        "ChatProvider",
        "client_surface backfilled onto the call row",
      );
      suite.expectEqual(
        meta?.prompt_version,
        SERVER_VERSION,
        "prompt_version preserved (was already set)",
      );

      const fb = await pool.query(
        `SELECT rating FROM ai_call_feedback WHERE call_id = $1`,
        [callId],
      );
      suite.expectEqual(fb.rows[0]?.rating, "thumbs_up", "feedback row written");
    } finally {
      await pool.end();
    }
  },
);

await suite.test(
  "recordConsultantRatingFromSurface — does NOT overwrite an existing client_surface",
  async () => {
    await ensureAiMetricsTable();
    const callId = await insertAiCallMetric({
      agent_name: TEST_AGENT,
      model: "gpt-4o",
      latency_ms: 600,
      success: true,
      metadata: { client_surface: "web", prompt_version: SERVER_VERSION },
    });
    suite.expect(callId != null, "seeded call row");

    const result = await recordConsultantRatingFromSurface({
      callId: Number(callId),
      rating: "thumbs_down",
      surface: "ChatProvider",
      userHash: "U_ChatProvider_OTHER_USER",
    });
    suite.expectEqual(result.success, true, "rating persisted");

    const pool = new pgMod.default.Pool({
      connectionString: process.env.DATABASE_URL,
    });
    try {
      const meta = (
        await pool.query(
          `SELECT metadata FROM ai_call_metrics WHERE id = $1`,
          [callId],
        )
      ).rows[0]?.metadata;
      suite.expectEqual(
        meta?.client_surface,
        "web",
        "existing server-side client_surface preserved",
      );
    } finally {
      await pool.end();
    }
  },
);

await suite.test(
  "recordConsultantRatingFromSurface — returns null promptVersion when call has none",
  async () => {
    await ensureAiMetricsTable();
    const callId = await insertAiCallMetric({
      agent_name: TEST_AGENT,
      model: "gpt-4o",
      latency_ms: 400,
      success: true,
    });
    const result = await recordConsultantRatingFromSurface({
      callId: Number(callId),
      rating: "thumbs_up",
      surface: "mobile",
      userHash: "U_MOBILE_TEST",
    });
    suite.expectEqual(result.success, true, "rating persisted");
    suite.expectEqual(
      result.promptVersion,
      null,
      "promptVersion is null when row has no metadata.prompt_version",
    );
  },
);

await suite.test(
  "recordConsultantRatingFromSurface — rejects invalid input without throwing",
  async () => {
    const bad = await recordConsultantRatingFromSurface({
      callId: 0,
      rating: "thumbs_up",
      surface: "ChatProvider",
    });
    suite.expectEqual(bad.success, false, "invalid callId returns success:false");
    suite.expectEqual(bad.promptVersion, null, "promptVersion null on invalid input");
  },
);

await suite.test("cleanup: remove seeded rows", async () => {
  const pool = new pgMod.default.Pool({
    connectionString: process.env.DATABASE_URL,
  });
  try {
    await pool.query(
      `DELETE FROM ai_call_feedback
        WHERE call_id IN (SELECT id FROM ai_call_metrics WHERE agent_name = $1)`,
      [TEST_AGENT],
    );
    await pool.query(`DELETE FROM ai_call_metrics WHERE agent_name = $1`, [TEST_AGENT]);
    suite.expect(true, "cleanup ok");
  } finally {
    await pool.end();
  }
});

suite.finishOrExit();
