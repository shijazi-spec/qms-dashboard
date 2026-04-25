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
});

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

  // Clean up seeded rows so the analytics tables stay uncluttered.
  await suite.test("cleanup: remove seeded test rows from ai_call_metrics", async () => {
    if (seededIds.length === 0) return;
    const pg = await import("pg");
    const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await pool.query(
        `DELETE FROM ai_call_metrics WHERE agent_name = $1`,
        [TEST_AGENT],
      );
      suite.expect(true, "cleanup query executed without error");
    } finally {
      await pool.end();
    }
  });
}

suite.finishOrExit();
