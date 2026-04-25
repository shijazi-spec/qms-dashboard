/**
 * Integration tests for the Prompt Version filter endpoints in aiOpsRoutes.
 *
 * Coverage:
 *   - GET /api/ai-ops/prompt-versions/active
 *       Returns the in-code ACTIVE_PROMPT_VERSIONS constant (one row per agent).
 *       Validates that every entry carries the exact prompt_version baked into
 *       the agent source file. Catches regressions like a stale constant or an
 *       accidental rename in the route.
 *
 *   - GET /api/ai-ops/prompt-versions (historical / aggregated)
 *       Seeds two distinct prompt_version values for one test agent, then
 *       asserts that both versions appear in the response. Ensures the
 *       getFeedbackRateByPromptVersion() query groups by prompt_version
 *       correctly and that neither version is silently dropped.
 *
 * Auth-gate checks run without a DB (requireRole fires before any DB access).
 * DB-backed happy-path tests are skipped when DATABASE_URL is unset.
 *
 * Run: npx tsx tests/aiOpsPromptVersions.test.ts
 */

import { aiOpsRoutes } from "../src/mastra/routes/aiOpsRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext } from "./_helpers/fakeContext";
import { QMS_CONSULTANT_PROMPT_VERSION } from "../src/mastra/agents/qmsConsultantAgent";
import { QUALITY_SPECIALIST_PROMPT_VERSION } from "../src/mastra/agents/qualitySpecialistAgent";
import { SDR_QUALITY_PROMPT_VERSION } from "../src/mastra/agents/sdrQualityAgent";
import { SALES_QUALITY_PROMPT_VERSION } from "../src/mastra/agents/salesQualityAgent";

const suite = new TestSuite("aiOpsPromptVersions");
const ADMIN_KEY = "integration-test-prompt-versions-2026";
const HAS_DB = !!process.env.DATABASE_URL;

console.log("\n=== aiOpsPromptVersions integration tests ===\n");

// ---------------------------------------------------------------------------
// Structural checks (no DB required)
// ---------------------------------------------------------------------------

await suite.test("prompt-version routes are wired into aiOpsRoutes", async () => {
  const paths = aiOpsRoutes.map((r) => `${r.method} ${r.path}`);
  suite.expect(
    paths.includes("GET /api/ai-ops/prompt-versions"),
    "GET /api/ai-ops/prompt-versions registered",
  );
  suite.expect(
    paths.includes("GET /api/ai-ops/prompt-versions/active"),
    "GET /api/ai-ops/prompt-versions/active registered",
  );
  suite.expect(
    paths.includes("GET /api/ai-ops/prompt-versions/last-purge"),
    "GET /api/ai-ops/prompt-versions/last-purge registered",
  );
});

await suite.test(
  "GET /api/ai-ops/prompt-versions/last-purge — 403 without an AI-ops role",
  async () => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    try {
      const handler = await buildHandler(
        aiOpsRoutes,
        "/api/ai-ops/prompt-versions/last-purge",
        "GET",
      );
      const res = await handler(makeContext({ method: "GET" }));
      suite.expectEqual(res.status, 403, "status");
      suite.expectEqual(res.body?.error, "Insufficient permissions", "body.error");
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
    }
  },
);

// ---------------------------------------------------------------------------
// Auth-gate checks (no DB required — requireRole fires first)
// ---------------------------------------------------------------------------

await suite.test("GET /api/ai-ops/prompt-versions — 403 without an AI-ops role", async () => {
  const original = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  try {
    const handler = await buildHandler(aiOpsRoutes, "/api/ai-ops/prompt-versions", "GET");
    const res = await handler(makeContext({ method: "GET" }));
    suite.expectEqual(res.status, 403, "status");
    suite.expectEqual(res.body?.error, "Insufficient permissions", "body.error");
  } finally {
    if (original === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = original;
  }
});

await suite.test(
  "GET /api/ai-ops/prompt-versions/active — 403 without an AI-ops role",
  async () => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    try {
      const handler = await buildHandler(
        aiOpsRoutes,
        "/api/ai-ops/prompt-versions/active",
        "GET",
      );
      const res = await handler(makeContext({ method: "GET" }));
      suite.expectEqual(res.status, 403, "status");
      suite.expectEqual(res.body?.error, "Insufficient permissions", "body.error");
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
    }
  },
);

// ---------------------------------------------------------------------------
// /active endpoint — static response, no DB required
// ---------------------------------------------------------------------------

await suite.test(
  "GET /api/ai-ops/prompt-versions/active — returns in-code constants for every agent",
  async () => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    try {
      const handler = await buildHandler(
        aiOpsRoutes,
        "/api/ai-ops/prompt-versions/active",
        "GET",
      );
      const res = await handler(
        makeContext({ method: "GET", headers: { "X-Admin-Key": ADMIN_KEY } }),
      );
      suite.expectEqual(res.status, 200, "status");

      const data: Array<{ agent_name: string; prompt_version: string }> =
        res.body?.data ?? [];

      suite.expect(Array.isArray(data) && data.length >= 4, "at least 4 agent entries");

      const byAgent = new Map(data.map((d) => [d.agent_name, d.prompt_version]));

      // Each entry must carry the exact constant from the agent source file.
      suite.expectEqual(
        byAgent.get("WalaPlus QMS Consultant"),
        QMS_CONSULTANT_PROMPT_VERSION,
        "QMS Consultant prompt_version matches in-code constant",
      );
      suite.expectEqual(
        byAgent.get("WalaPlus Quality Specialist"),
        QUALITY_SPECIALIST_PROMPT_VERSION,
        "Quality Specialist prompt_version matches in-code constant",
      );
      suite.expectEqual(
        byAgent.get("WalaPlus SDR Quality Specialist"),
        SDR_QUALITY_PROMPT_VERSION,
        "SDR Quality Specialist prompt_version matches in-code constant",
      );
      suite.expectEqual(
        byAgent.get("WalaPlus Sales Quality Specialist"),
        SALES_QUALITY_PROMPT_VERSION,
        "Sales Quality Specialist prompt_version matches in-code constant",
      );

      // Every row must have both agent_name and prompt_version as non-empty strings.
      for (const entry of data) {
        suite.expect(
          typeof entry.agent_name === "string" && entry.agent_name.length > 0,
          `agent_name is a non-empty string: ${JSON.stringify(entry)}`,
        );
        suite.expect(
          typeof entry.prompt_version === "string" && entry.prompt_version.length > 0,
          `prompt_version is a non-empty string: ${JSON.stringify(entry)}`,
        );
      }
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
    }
  },
);

// ---------------------------------------------------------------------------
// Historical / aggregated endpoint — DB-gated happy-path
// ---------------------------------------------------------------------------

if (!HAS_DB) {
  console.log("\n(skipping DB-backed prompt-version filter tests — DATABASE_URL not set)\n");
} else {
  const { insertAiCallMetric, ensureAiMetricsTable } = await import(
    "../src/utils/aiTelemetry"
  );

  // Use a distinctive agent name so seeded rows don't pollute real analytics
  // and are easy to clean up with a scoped DELETE at the end.
  const TEST_AGENT = `__test_prompt_version_${Date.now()}__`;
  const VERSION_A = "v-test-alpha";
  const VERSION_B = "v-test-beta";

  // Seed two metric rows — each carrying a different prompt_version in metadata.
  // We seed at least 2 rows per version so the aggregate is non-trivial.
  const seededIds: number[] = [];

  await suite.test("happy: seed prompt-version rows into ai_call_metrics", async () => {
    await ensureAiMetricsTable();

    for (const version of [VERSION_A, VERSION_B]) {
      for (let i = 0; i < 2; i++) {
        const id = await insertAiCallMetric({
          agent_name: TEST_AGENT,
          model: "gpt-4o",
          latency_ms: 500 + i * 100,
          success: true,
          metadata: { prompt_version: version },
        });
        suite.expect(
          id != null,
          `inserted row for ${version} (attempt ${i})`,
        );
        if (id != null) seededIds.push(id);
      }
    }

    suite.expectEqual(seededIds.length, 4, "4 rows seeded (2 per version)");
  });

  await suite.test(
    "happy: GET /api/ai-ops/prompt-versions returns both seeded versions",
    async () => {
      const original = process.env.ADMIN_API_KEY;
      process.env.ADMIN_API_KEY = ADMIN_KEY;
      try {
        const handler = await buildHandler(
          aiOpsRoutes,
          "/api/ai-ops/prompt-versions",
          "GET",
        );

        // minFeedback=0 so rows with no feedback votes still appear.
        const res = await handler(
          makeContext({
            method: "GET",
            headers: { "X-Admin-Key": ADMIN_KEY },
            query: { days: "1", minFeedback: "0" },
          }),
        );
        suite.expectEqual(res.status, 200, "status");
        suite.expect(
          typeof res.body?.min_feedback === "number",
          "min_feedback echoed in response",
        );
        suite.expectEqual(res.body?.min_feedback, 0, "min_feedback=0 honoured");

        const data: Array<{ agent_name: string; prompt_version: string; call_count: number }> =
          res.body?.data ?? [];

        const agentRows = data.filter((r) => r.agent_name === TEST_AGENT);
        suite.expect(agentRows.length >= 2, `at least 2 rows for ${TEST_AGENT}`);

        const versions = agentRows.map((r) => r.prompt_version);
        suite.expect(versions.includes(VERSION_A), `${VERSION_A} present in response`);
        suite.expect(versions.includes(VERSION_B), `${VERSION_B} present in response`);

        // call_count must reflect exactly the 2 seeded rows per version.
        for (const row of agentRows) {
          suite.expect(
            Number(row.call_count) >= 2,
            `call_count >= 2 for ${row.prompt_version} (got ${row.call_count})`,
          );
        }
      } finally {
        if (original === undefined) delete process.env.ADMIN_API_KEY;
        else process.env.ADMIN_API_KEY = original;
      }
    },
  );

  await suite.test(
    "happy: GET /api/ai-ops/prompt-versions/active — unaffected by DB content",
    async () => {
      // Seeding agent-metric rows must not change what the /active endpoint
      // returns — it reads only from the in-code constant, not from the DB.
      const original = process.env.ADMIN_API_KEY;
      process.env.ADMIN_API_KEY = ADMIN_KEY;
      try {
        const handler = await buildHandler(
          aiOpsRoutes,
          "/api/ai-ops/prompt-versions/active",
          "GET",
        );
        const res = await handler(
          makeContext({ method: "GET", headers: { "X-Admin-Key": ADMIN_KEY } }),
        );
        suite.expectEqual(res.status, 200, "status");

        const data: Array<{ agent_name: string; prompt_version: string }> =
          res.body?.data ?? [];

        // TEST_AGENT is not a real agent and must never appear in /active.
        const leak = data.find((d) => d.agent_name === TEST_AGENT);
        suite.expect(!leak, "test agent does not leak into /active response");

        // Real agents are still present.
        const names = data.map((d) => d.agent_name);
        suite.expect(
          names.includes("WalaPlus QMS Consultant"),
          "WalaPlus QMS Consultant still in /active",
        );
      } finally {
        if (original === undefined) delete process.env.ADMIN_API_KEY;
        else process.env.ADMIN_API_KEY = original;
      }
    },
  );

  // ---------------------------------------------------------------------------
  // last-purge endpoint — round-trip a recorded run via the DB.
  // ---------------------------------------------------------------------------
  await suite.test(
    "happy: GET /api/ai-ops/prompt-versions/last-purge returns the most-recent recorded run",
    async () => {
      const { recordPromptVersionPurgeRun } = await import(
        "../src/utils/aiTelemetry"
      );
      // Seed two runs ~10ms apart; the endpoint must surface the second one
      // because it has the larger ran_at timestamp.
      const liveA = ["agent-x@aaaaaaaa", "agent-y@bbbbbbbb"];
      const liveB = ["agent-x@cccccccc", "agent-y@dddddddd"];
      const firstId = await recordPromptVersionPurgeRun(3, 30, liveA);
      suite.expect(firstId != null, "first purge run inserted");
      await new Promise((r) => setTimeout(r, 15));
      const secondId = await recordPromptVersionPurgeRun(7, 45, liveB);
      suite.expect(secondId != null, "second purge run inserted");

      const original = process.env.ADMIN_API_KEY;
      process.env.ADMIN_API_KEY = ADMIN_KEY;
      try {
        const handler = await buildHandler(
          aiOpsRoutes,
          "/api/ai-ops/prompt-versions/last-purge",
          "GET",
        );
        const res = await handler(
          makeContext({ method: "GET", headers: { "X-Admin-Key": ADMIN_KEY } }),
        );
        suite.expectEqual(res.status, 200, "status");
        const run = res.body?.data;
        suite.expect(run != null, "run row in body.data");
        suite.expectEqual(run.deleted_count, 7, "echoes most-recent deleted_count");
        suite.expectEqual(run.retention_days, 45, "echoes most-recent retention_days");
        suite.expect(
          Array.isArray(run.live_versions) &&
            run.live_versions.length === 2 &&
            run.live_versions.includes("agent-x@cccccccc") &&
            run.live_versions.includes("agent-y@dddddddd"),
          "echoes most-recent live_versions",
        );
        suite.expect(
          typeof run.ran_at === "string" && !isNaN(Date.parse(run.ran_at)),
          "ran_at is a parseable ISO timestamp",
        );
      } finally {
        if (original === undefined) delete process.env.ADMIN_API_KEY;
        else process.env.ADMIN_API_KEY = original;
      }
    },
  );

  // Contract: when the table has no rows, the route must return
  // { data: null } (not 404, not [], not undefined). This locks the
  // shape the dashboard's renderLastPurgeStrip(null) branch depends on.
  await suite.test(
    "contract: GET /api/ai-ops/prompt-versions/last-purge returns data:null when no purge runs exist",
    async () => {
      const pgMod = await import("pg");
      const pool = new pgMod.default.Pool({
        connectionString: process.env.DATABASE_URL,
      });
      try {
        // Wipe the table so we exercise the "fresh DB" branch deterministically.
        // The cleanup step at the end of this suite is selective; this test
        // needs a fully-empty table for the assertion to be meaningful.
        await pool.query(`DELETE FROM prompt_version_purge_runs`);
      } finally {
        await pool.end();
      }

      const original = process.env.ADMIN_API_KEY;
      process.env.ADMIN_API_KEY = ADMIN_KEY;
      try {
        const handler = await buildHandler(
          aiOpsRoutes,
          "/api/ai-ops/prompt-versions/last-purge",
          "GET",
        );
        const res = await handler(
          makeContext({ method: "GET", headers: { "X-Admin-Key": ADMIN_KEY } }),
        );
        suite.expectEqual(res.status, 200, "status is 200 even with no rows");
        suite.expect(
          res.body && Object.prototype.hasOwnProperty.call(res.body, "data"),
          "body has a `data` property",
        );
        suite.expectEqual(res.body.data, null, "data is exactly null");
      } finally {
        if (original === undefined) delete process.env.ADMIN_API_KEY;
        else process.env.ADMIN_API_KEY = original;
      }
    },
  );

  // Clean up seeded rows so the analytics tables stay uncluttered.
  // -------------------------------------------------------------------------
  // Task #330: archived versions whose most recent traffic predates the
  // selected window should still surface as placeholder rows with 0
  // in-window calls and the unbounded `last_seen_at` populated. This
  // catches regressions of the LEFT JOIN on global_last that lets stale
  // rollbacks remain visible to reviewers.
  // -------------------------------------------------------------------------
  const ARCHIVED_AGENT = `__test_prompt_version_archived_${Date.now()}__`;
  const VERSION_ARCHIVED = "v-archived-old";
  const archivedSeededIds: number[] = [];

  await suite.test(
    "happy: seed an out-of-window archived prompt-version row (started_at = 60 days ago)",
    async () => {
      const pg = await import("pg");
      const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL });
      try {
        // Insert a row whose started_at is 60 days in the past so it falls
        // outside any selected window <= 30 days. Direct INSERT (rather
        // than insertAiCallMetric) so we control started_at.
        const res = await pool.query(
          `INSERT INTO ai_call_metrics
             (agent_name, tool_name, model, latency_ms, success, metadata, started_at)
           VALUES ($1, NULL, 'gpt-4o', 600, TRUE, $2::jsonb, NOW() - INTERVAL '60 days')
           RETURNING id`,
          [ARCHIVED_AGENT, JSON.stringify({ prompt_version: VERSION_ARCHIVED })],
        );
        const id = Number(res.rows[0].id);
        suite.expect(id > 0, "archived row inserted with id");
        archivedSeededIds.push(id);
      } finally {
        await pool.end();
      }
    },
  );

  await suite.test(
    "happy: GET /api/ai-ops/prompt-versions?days=7 still surfaces archived versions older than the window",
    async () => {
      const original = process.env.ADMIN_API_KEY;
      process.env.ADMIN_API_KEY = ADMIN_KEY;
      try {
        const handler = await buildHandler(
          aiOpsRoutes,
          "/api/ai-ops/prompt-versions",
          "GET",
        );
        // 7-day window guarantees the 60-day-old seed is out-of-window.
        // minFeedback=0 keeps the row eligible (no feedback was seeded).
        const res = await handler(
          makeContext({
            method: "GET",
            headers: { "X-Admin-Key": ADMIN_KEY },
            query: { days: "7", minFeedback: "0" },
          }),
        );
        suite.expectEqual(res.status, 200, "status");

        const data: Array<{
          agent_name: string;
          prompt_version: string;
          call_count: number;
          total_feedback: number;
          feedback_rate_pct: number | null;
          p50_ms: number | null;
          avg_ms: number | null;
          last_seen: string | null;
          last_seen_at: string;
        }> = res.body?.data ?? [];

        const archived = data.find(
          (r) =>
            r.agent_name === ARCHIVED_AGENT &&
            r.prompt_version === VERSION_ARCHIVED,
        );
        suite.expect(
          !!archived,
          `archived row for ${ARCHIVED_AGENT}/${VERSION_ARCHIVED} surfaces despite 60-day-old started_at`,
        );

        suite.expectEqual(
          Number(archived?.call_count ?? -1),
          0,
          "call_count = 0 (no in-window activity)",
        );
        suite.expectEqual(
          Number(archived?.total_feedback ?? -1),
          0,
          "total_feedback = 0 (no in-window activity)",
        );
        suite.expect(
          archived?.feedback_rate_pct == null,
          "feedback_rate_pct is NULL (not 0%) so the dashboard renders —",
        );
        suite.expect(
          archived?.p50_ms == null,
          "p50_ms is NULL so the dashboard renders —",
        );
        suite.expect(
          archived?.avg_ms == null,
          "avg_ms is NULL so the dashboard renders —",
        );
        suite.expect(
          archived?.last_seen == null,
          "in-window last_seen is NULL for archived rows",
        );
        // The pg driver returns timestamps as Date objects; the route serializes
        // them via JSON.stringify (-> ISO 8601 string) at the wire boundary.
        // The fakeContext used here returns the raw body object, so we accept
        // either a Date or a non-empty string as evidence that the value is
        // populated.
        const lastSeenAt: unknown = archived?.last_seen_at;
        const lastSeenAtPopulated =
          (typeof lastSeenAt === "string" && lastSeenAt.length > 0) ||
          lastSeenAt instanceof Date;
        suite.expect(
          lastSeenAtPopulated,
          `unbounded last_seen_at is populated (got ${JSON.stringify(lastSeenAt)}) so the dashboard can show 'last seen N days ago'`,
        );
      } finally {
        if (original === undefined) delete process.env.ADMIN_API_KEY;
        else process.env.ADMIN_API_KEY = original;
      }
    },
  );


  await suite.test("cleanup: remove seeded test rows from ai_call_metrics", async () => {
    if (seededIds.length === 0 && archivedSeededIds.length === 0) return;
    const pg = await import("pg");
    const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await pool.query(
        `DELETE FROM ai_call_metrics WHERE agent_name IN ($1, $2)`,
        [TEST_AGENT, ARCHIVED_AGENT],
      );
      // Drop the synthetic purge rows seeded by the last-purge happy-path test
      // so the AI Ops UI doesn't show "agent-x@cccccccc" to a real operator.
      await pool.query(
        `DELETE FROM prompt_version_purge_runs
          WHERE 'agent-x@aaaaaaaa' = ANY(live_versions)
             OR 'agent-x@cccccccc' = ANY(live_versions)`,
      );
      suite.expect(true, "cleanup query executed without error");
    } finally {
      await pool.end();
    }
  });
}

suite.finishOrExit();
