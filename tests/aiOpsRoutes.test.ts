/**
 * Integration tests for src/mastra/routes/aiOpsRoutes.ts.
 *
 * Coverage matrix:
 *   - structural        → every route exposes path/method/createHandler.
 *   - 403 forbidden     → every route rejects unauthenticated callers
 *                         (admin/ai_specialist/grc_manager/head_of_operations_quality).
 *                         Includes the dedicated tool-health endpoints from Task #110:
 *                           GET  /api/ai-ops/tool-health-alerts
 *                           POST /api/ai-ops/alerts/:id/acknowledge
 *                           POST /api/ai-ops/alerts/:id/resolve
 *   - 400 bad input     → POST /api/ai-ops/alerts/:id/acknowledge with bad id
 *                         POST /api/ai-ops/alerts/:id/resolve with bad id
 *   - 200 happy path    → seed alert via createAIAlert, then exercise list,
 *                         acknowledge and resolve end-to-end (DATABASE_URL gated).
 *
 * Auth-boundary tests run without any DB (the auth check happens before the
 * dynamic DB import).
 *
 * Run:  npx tsx tests/aiOpsRoutes.test.ts
 */

import { aiOpsRoutes } from "../src/mastra/routes/aiOpsRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext, type FakeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("aiOpsRoutes");
const ADMIN_KEY = "integration-test-ai-ops-2026";
const HAS_DB = !!process.env.DATABASE_URL;

console.log("\n=== aiOpsRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of aiOpsRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  // Sanity: confirm the new tool-health endpoints are wired in.
  const paths = aiOpsRoutes.map((r) => `${r.method} ${r.path}`);
  suite.expect(paths.includes("GET /api/ai-ops/tool-health-alerts"), "tool-health-alerts route registered");
  suite.expect(paths.includes("POST /api/ai-ops/alerts/:id/acknowledge"), "acknowledge route registered");
  suite.expect(paths.includes("POST /api/ai-ops/alerts/:id/resolve"), "resolve route registered");
  suite.expect(aiOpsRoutes.length >= 1, "at least 1 route registered");
});

// ---------------------------------------------------------------------------
// Generic 403 sweep — every non-html route refuses unauthenticated callers.
// ---------------------------------------------------------------------------
for (const route of aiOpsRoutes) {
  const path = route.path;
  const method = route.method as string;
  if (path === "/ai-ops") continue; // html handler — assert separately.
  await suite.test(`${method} ${path} — 403 without an AI-ops role`, async () => {
    const handler = await buildHandler(aiOpsRoutes, path, method);
    const ctx = makeContext({
      method,
      params: { id: "1", agentId: "1", callId: "1" },
      body: ["POST", "PUT", "PATCH"].includes(method) ? {} : undefined,
    });
    const res = await handler(ctx);
    suite.expectEqual(res.status, 403, "status");
    suite.expectEqual(res.body?.error, "Insufficient permissions", "body.error");
  });
}

await suite.test("GET /ai-ops — 403 without an AI-ops role (html route also gated)", async () => {
  const handler = await buildHandler(aiOpsRoutes, "/ai-ops", "GET");
  const ctx = makeContext({ method: "GET" }) as FakeContext & { html?: any };
  ctx.html = (body: string, status?: number) => ({ status: status ?? 200, body, headers: {} });
  const res = await handler(ctx);
  suite.expectEqual(res.status, 403, "status");
  suite.expectEqual(res.body?.error, "Insufficient permissions", "body.error");
});

// ---------------------------------------------------------------------------
// Bad-input tests for the Task #110 alert endpoints (with admin key).
// ---------------------------------------------------------------------------
await suite.test("POST /api/ai-ops/alerts/:id/acknowledge — 400 on non-numeric id (with admin key)", async () => {
  const original = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  try {
    const handler = await buildHandler(aiOpsRoutes, "/api/ai-ops/alerts/:id/acknowledge", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        headers: { "X-Admin-Key": ADMIN_KEY },
        params: { id: "not-a-number" },
      }),
    );
    suite.expectEqual(res.status, 400, "status");
    suite.expectEqual(res.body?.error, "Invalid alert id", "body.error");
  } finally {
    if (original === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = original;
  }
});

await suite.test("POST /api/ai-ops/alerts/:id/resolve — 400 on zero id (with admin key)", async () => {
  const original = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  try {
    const handler = await buildHandler(aiOpsRoutes, "/api/ai-ops/alerts/:id/resolve", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        headers: { "X-Admin-Key": ADMIN_KEY },
        params: { id: "0" },
      }),
    );
    suite.expectEqual(res.status, 400, "status");
    suite.expectEqual(res.body?.error, "Invalid alert id", "body.error");
  } finally {
    if (original === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = original;
  }
});

// ---------------------------------------------------------------------------
// Happy-path data integration tests (require DATABASE_URL).
// These insert a real alert via createAIAlert, exercise the route end-to-end
// against the running Postgres, and clean up by resolving the alert.
// ---------------------------------------------------------------------------
if (!HAS_DB) {
  console.log("\n(skipping happy-path DB tests — DATABASE_URL not set)\n");
} else {
  const { createAIAlert, resolveAlert, getAIAlerts } = await import(
    "../src/utils/aiAlertsDatabase"
  );

  const TOOL_NAME = `test_route_tool_${Date.now()}`;
  const REASON = "error_rate";
  const RELATED_ID = `${TOOL_NAME}:${REASON}`;
  let createdId: number | null = null;

  await suite.test("happy: GET /api/ai-ops/tool-health-alerts returns the seeded alert with parsed fields", async () => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    try {
      const created = await createAIAlert({
        alert_type: "tool_health",
        severity: "high",
        title: `Tool "${TOOL_NAME}" error rate above threshold over last 60 min`,
        description: "Test seed for happy-path route test",
        suggestion: "Investigate the tool",
        related_record_type: "tool_health",
        related_record_id: RELATED_ID,
        metadata: { tool_name: TOOL_NAME, reason: REASON },
      });
      createdId = created.id;

      const handler = await buildHandler(
        aiOpsRoutes,
        "/api/ai-ops/tool-health-alerts",
        "GET",
      );
      const res = await handler(
        makeContext({ method: "GET", headers: { "X-Admin-Key": ADMIN_KEY } }),
      );
      suite.expectEqual(res.status, 200, "status");
      const list: any[] = res.body?.data ?? [];
      const found = list.find((a) => a.id === createdId);
      suite.expect(!!found, "seeded alert is in response");
      suite.expectEqual(found.tool_name, TOOL_NAME, "parsed tool_name");
      suite.expectEqual(found.reason, REASON, "parsed reason");
      suite.expectEqual(found.status, "open", "status filter only returns open");
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
    }
  });

  await suite.test("happy: POST /api/ai-ops/alerts/:id/acknowledge transitions status to acknowledged", async () => {
    if (createdId == null) throw new Error("seed alert was not created");
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    try {
      const handler = await buildHandler(
        aiOpsRoutes,
        "/api/ai-ops/alerts/:id/acknowledge",
        "POST",
      );
      const res = await handler(
        makeContext({
          method: "POST",
          headers: { "X-Admin-Key": ADMIN_KEY },
          params: { id: String(createdId) },
        }),
      );
      suite.expectEqual(res.status, 200, "status");
      suite.expect(res.body?.success === true, "success=true");
      suite.expectEqual(res.body?.alert?.id, createdId, "echoes alert id");
      suite.expectEqual(res.body?.alert?.status, "acknowledged", "status flipped");

      // After ack, the alert should no longer appear in the open-only listing.
      const listed = await getAIAlerts({ alert_type: "tool_health", status: "open" });
      const stillThere = listed.alerts.find((a) => a.id === createdId);
      suite.expect(!stillThere, "acknowledged alert no longer in open list");
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
    }
  });

  await suite.test("happy: POST /api/ai-ops/alerts/:id/resolve transitions status to resolved", async () => {
    if (createdId == null) throw new Error("seed alert was not created");
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    try {
      const handler = await buildHandler(
        aiOpsRoutes,
        "/api/ai-ops/alerts/:id/resolve",
        "POST",
      );
      const res = await handler(
        makeContext({
          method: "POST",
          headers: { "X-Admin-Key": ADMIN_KEY },
          params: { id: String(createdId) },
        }),
      );
      suite.expectEqual(res.status, 200, "status");
      suite.expect(res.body?.success === true, "success=true");
      suite.expectEqual(res.body?.alert?.id, createdId, "echoes alert id");
      suite.expectEqual(res.body?.alert?.status, "resolved", "status flipped");
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
      // Ensure cleanup even if the assertion above failed.
      if (createdId != null) {
        try {
          await resolveAlert(createdId, "happy-path-test", "cleanup");
        } catch {
          /* best-effort */
        }
      }
    }
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Tool-health threshold tuning endpoints (Task #177)
//
// The structural / 403 / 400 boundary tests run without a live DB — those
// checks fire before the lazy `await import(toolHealthConfigDatabase)`. The
// happy-path PUT/GET tests are gated on HAS_DB so CI can still smoke them.
// ───────────────────────────────────────────────────────────────────────────

await suite.test("threshold routes are wired into aiOpsRoutes", async () => {
  const paths = aiOpsRoutes.map((r) => `${r.method} ${r.path}`);
  suite.expect(
    paths.includes("GET /api/ai-ops/tool-health-config"),
    "GET tool-health-config registered",
  );
  suite.expect(
    paths.includes("PUT /api/ai-ops/tool-health-config"),
    "PUT tool-health-config registered",
  );
  suite.expect(
    paths.includes("GET /api/ai-ops/tool-health-config/audit"),
    "GET tool-health-config/audit registered",
  );
});

await suite.test("GET /api/ai-ops/tool-health-config — 403 without auth", async () => {
  const original = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  try {
    const handler = await buildHandler(
      aiOpsRoutes,
      "/api/ai-ops/tool-health-config",
      "GET",
    );
    const res = await handler(makeContext({ method: "GET" }));
    suite.expectEqual(res.status, 403, "status");
    suite.expectEqual(res.body?.error, "Insufficient permissions", "body.error");
  } finally {
    if (original === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = original;
  }
});

await suite.test("PUT /api/ai-ops/tool-health-config — 403 without admin", async () => {
  const original = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  try {
    const handler = await buildHandler(
      aiOpsRoutes,
      "/api/ai-ops/tool-health-config",
      "PUT",
    );
    // Pass no key at all — the requireRole gate fires before we reach
    // the JSON body parser, so we never need a body to assert 403.
    const res = await handler(
      makeContext({ method: "PUT", body: { overrides: {} } }),
    );
    suite.expectEqual(res.status, 403, "status");
    suite.expectEqual(res.body?.error, "Insufficient permissions", "body.error");
  } finally {
    if (original === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = original;
  }
});

await suite.test("PUT /api/ai-ops/tool-health-config — 400 when body is not an object", async () => {
  const original = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  try {
    const handler = await buildHandler(
      aiOpsRoutes,
      "/api/ai-ops/tool-health-config",
      "PUT",
    );
    const res = await handler(
      makeContext({
        method: "PUT",
        headers: { "X-Admin-Key": ADMIN_KEY },
        body: "not-an-object",
      }),
    );
    suite.expectEqual(res.status, 400, "status");
    suite.expect(
      typeof res.body?.error === "string" && res.body.error.length > 0,
      "error message present",
    );
  } finally {
    if (original === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = original;
  }
});

await suite.test("PUT /api/ai-ops/tool-health-config — 400 when overrides missing", async () => {
  const original = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  try {
    const handler = await buildHandler(
      aiOpsRoutes,
      "/api/ai-ops/tool-health-config",
      "PUT",
    );
    const res = await handler(
      makeContext({
        method: "PUT",
        headers: { "X-Admin-Key": ADMIN_KEY },
        body: { note: "no overrides field at all" },
      }),
    );
    suite.expectEqual(res.status, 400, "status");
    suite.expectEqual(res.body?.error, "overrides must be an object", "error");
  } finally {
    if (original === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = original;
  }
});

// ── Task #191: time-boxed override validation ────────────────────────────────
// These hit the validation gate (no DB write), so they're safe to run with or
// without a live DB. They cover the "is the wire format right?" contract that
// the dashboard depends on.

await suite.test(
  "PUT /api/ai-ops/tool-health-config — 400 when expires_at is not parseable",
  async () => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    try {
      const handler = await buildHandler(
        aiOpsRoutes,
        "/api/ai-ops/tool-health-config",
        "PUT",
      );
      const res = await handler(
        makeContext({
          method: "PUT",
          headers: { "X-Admin-Key": ADMIN_KEY },
          body: { overrides: {}, expires_at: "not-a-date" },
        }),
      );
      suite.expectEqual(res.status, 400, "status");
      suite.expect(
        typeof res.body?.error === "string"
          && res.body.error.toLowerCase().includes("expires_at"),
        "error mentions expires_at",
      );
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
    }
  },
);

await suite.test(
  "PUT /api/ai-ops/tool-health-config — 400 when expires_at is in the past",
  async () => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    try {
      const handler = await buildHandler(
        aiOpsRoutes,
        "/api/ai-ops/tool-health-config",
        "PUT",
      );
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const res = await handler(
        makeContext({
          method: "PUT",
          headers: { "X-Admin-Key": ADMIN_KEY },
          body: { overrides: {}, expires_at: yesterday },
        }),
      );
      suite.expectEqual(res.status, 400, "status");
      suite.expect(
        typeof res.body?.error === "string"
          && res.body.error.toLowerCase().includes("future"),
        "error mentions future requirement",
      );
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
    }
  },
);

await suite.test(
  "PUT /api/ai-ops/tool-health-config — 400 when expires_at exceeds 30-day horizon",
  async () => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    try {
      const handler = await buildHandler(
        aiOpsRoutes,
        "/api/ai-ops/tool-health-config",
        "PUT",
      );
      // 60 days out → well past the 30-day cap.
      const tooFar = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
      const res = await handler(
        makeContext({
          method: "PUT",
          headers: { "X-Admin-Key": ADMIN_KEY },
          body: { overrides: {}, expires_at: tooFar },
        }),
      );
      suite.expectEqual(res.status, 400, "status");
      suite.expect(
        typeof res.body?.error === "string"
          && /at most.*days/i.test(res.body.error),
        "error mentions max horizon",
      );
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
    }
  },
);

await suite.test("GET /api/ai-ops/tool-health-config/audit — 403 without auth", async () => {
  const original = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  try {
    const handler = await buildHandler(
      aiOpsRoutes,
      "/api/ai-ops/tool-health-config/audit",
      "GET",
    );
    const res = await handler(makeContext({ method: "GET" }));
    suite.expectEqual(res.status, 403, "status");
    suite.expectEqual(res.body?.error, "Insufficient permissions", "body.error");
  } finally {
    if (original === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = original;
  }
});

if (HAS_DB) {
  // Happy-path coverage: a full read → write → read cycle that proves the
  // PUT actually persists, the GET reflects the merged result, and the
  // audit log captures the change. Cleans up after itself by clearing all
  // overrides at the end so the live DB row is left in a known-good state.
  await suite.test("happy: GET → PUT → GET round-trips an override and writes audit row", async () => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    try {
      const getHandler = await buildHandler(
        aiOpsRoutes,
        "/api/ai-ops/tool-health-config",
        "GET",
      );
      const putHandler = await buildHandler(
        aiOpsRoutes,
        "/api/ai-ops/tool-health-config",
        "PUT",
      );

      // Snapshot the env baseline so we can pick override values that are
      // (a) within bounds and (b) safely satisfy the cross-field invariants.
      const initial = await getHandler(
        makeContext({ method: "GET", headers: { "X-Admin-Key": ADMIN_KEY } }),
      );
      suite.expectEqual(initial.status, 200, "initial GET status");
      const baseline = initial.body?.data?.env_baseline;
      suite.expect(baseline && typeof baseline === "object", "env_baseline present");

      // Pick safe values that satisfy: floor <= high < critical for both bands.
      const patch = {
        windowMinutes: 15,
        minCalls: 10,
        errorRatePct: 5,
        errorRateHighPct: 20,
        errorRateCriticalPct: 80,
        p95LatencyMs: 500,
        latencyHighMs: 2000,
        latencyCriticalMs: 8000,
      };

      const putRes = await putHandler(
        makeContext({
          method: "PUT",
          headers: { "X-Admin-Key": ADMIN_KEY },
          body: { overrides: patch, note: "integration test #177" },
        }),
      );
      suite.expectEqual(putRes.status, 200, "PUT status");
      suite.expect(putRes.body?.success === true, "success flag");
      suite.expectEqual(
        putRes.body?.effective?.errorRateHighPct,
        20,
        "effective reflects new override",
      );
      suite.expect(
        typeof putRes.body?.audit_id === "number" && putRes.body.audit_id > 0,
        "audit_id returned",
      );

      // Re-GET and assert the override is now visible alongside the audit row.
      const reread = await getHandler(
        makeContext({ method: "GET", headers: { "X-Admin-Key": ADMIN_KEY } }),
      );
      suite.expectEqual(reread.status, 200, "re-read status");
      suite.expectEqual(
        reread.body?.data?.overrides?.errorRateHighPct,
        20,
        "override persisted",
      );
      suite.expect(
        Array.isArray(reread.body?.data?.audit) && reread.body.data.audit.length > 0,
        "audit log non-empty",
      );
      const last = reread.body.data.audit[0];
      suite.expectEqual(last?.note, "integration test #177", "note round-trips");
      suite.expectEqual(
        last?.after_values?.errorRateHighPct,
        20,
        "audit captured after-state",
      );
    } finally {
      // Cleanup: clear every override so the live DB returns to baseline.
      try {
        const putHandler = await buildHandler(
          aiOpsRoutes,
          "/api/ai-ops/tool-health-config",
          "PUT",
        );
        await putHandler(
          makeContext({
            method: "PUT",
            headers: { "X-Admin-Key": ADMIN_KEY },
            body: {
              overrides: {
                windowMinutes: null,
                minCalls: null,
                errorRatePct: null,
                errorRateHighPct: null,
                errorRateCriticalPct: null,
                p95LatencyMs: null,
                latencyHighMs: null,
                latencyCriticalMs: null,
              },
              note: "integration test #177 cleanup",
            },
          }),
        );
      } catch {
        /* best-effort cleanup */
      }
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
    }
  });

  await suite.test(
    "PUT /api/ai-ops/tool-health-config — TOOL_HEALTH_CONFIG_NOTIFY=1 still saves successfully when Slack send fails",
    // Regression guard for Task #190: the notifier hook is best-effort.
    // When the env gate is on but Slack is misconfigured (no bot token,
    // unreachable channel), the threshold save MUST still return 200 and
    // persist the override. We exercise the real notify path (no stub) so
    // the route's try/catch wrapper is what's under test.
    async () => {
      const originalKey = process.env.ADMIN_API_KEY;
      const originalNotify = process.env.TOOL_HEALTH_CONFIG_NOTIFY;
      const originalChannel = process.env.TOOL_HEALTH_SLACK_CHANNEL;
      const originalToken = process.env.SLACK_BOT_TOKEN;
      const originalApiToken = process.env.SLACK_API_TOKEN;
      process.env.ADMIN_API_KEY = ADMIN_KEY;
      process.env.TOOL_HEALTH_CONFIG_NOTIFY = "1";
      process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-NONEXISTENT";
      // Force the underlying Slack client to bail (no token → returns false,
      // no throw); proves the route still returns 200 either way.
      delete process.env.SLACK_BOT_TOKEN;
      delete process.env.SLACK_API_TOKEN;

      // Silence the expected "no bot token" log so the test output stays clean.
      const origLog = console.log;
      console.log = () => {};
      try {
        const putHandler = await buildHandler(
          aiOpsRoutes,
          "/api/ai-ops/tool-health-config",
          "PUT",
        );
        const res = await putHandler(
          makeContext({
            method: "PUT",
            headers: { "X-Admin-Key": ADMIN_KEY },
            body: { overrides: { windowMinutes: 30 }, note: "task-190 regression" },
          }),
        );
        suite.expectEqual(res.status, 200, "PUT still 200 when Slack send is a no-op");
        suite.expect(res.body?.success === true, "success flag still true");
        suite.expect(
          typeof res.body?.audit_id === "number" && res.body.audit_id > 0,
          "audit row still written",
        );
      } finally {
        console.log = origLog;
        // Cleanup: clear the override and restore env.
        try {
          const putHandler = await buildHandler(
            aiOpsRoutes,
            "/api/ai-ops/tool-health-config",
            "PUT",
          );
          await putHandler(
            makeContext({
              method: "PUT",
              headers: { "X-Admin-Key": ADMIN_KEY },
              body: {
                overrides: { windowMinutes: null },
                note: "task-190 regression cleanup",
              },
            }),
          );
        } catch { /* best-effort cleanup */ }
        if (originalKey === undefined) delete process.env.ADMIN_API_KEY;
        else process.env.ADMIN_API_KEY = originalKey;
        if (originalNotify === undefined) delete process.env.TOOL_HEALTH_CONFIG_NOTIFY;
        else process.env.TOOL_HEALTH_CONFIG_NOTIFY = originalNotify;
        if (originalChannel === undefined) delete process.env.TOOL_HEALTH_SLACK_CHANNEL;
        else process.env.TOOL_HEALTH_SLACK_CHANNEL = originalChannel;
        if (originalToken !== undefined) process.env.SLACK_BOT_TOKEN = originalToken;
        if (originalApiToken !== undefined) process.env.SLACK_API_TOKEN = originalApiToken;
      }
    },
  );

  await suite.test("PUT /api/ai-ops/tool-health-config — 400 on band ordering violation", async () => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    try {
      const putHandler = await buildHandler(
        aiOpsRoutes,
        "/api/ai-ops/tool-health-config",
        "PUT",
      );
      // High >= critical → must be rejected with a clear 400.
      const res = await putHandler(
        makeContext({
          method: "PUT",
          headers: { "X-Admin-Key": ADMIN_KEY },
          body: {
            overrides: { errorRateHighPct: 90, errorRateCriticalPct: 90 },
          },
        }),
      );
      suite.expectEqual(res.status, 400, "status");
      suite.expect(
        typeof res.body?.error === "string"
          && res.body.error.includes("errorRateHighPct"),
        "error mentions field",
      );
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
    }
  });

  // ── Task #214: end-to-end auto-revert against a live Postgres ─────────────
  //
  // This is the only test in CI that exercises the full time-boxed override
  // path against real SQL: PUT an override with a sub-second expiry, wait
  // for it to pass, drive `runToolHealthCheck` directly (which calls the
  // real `reapExpiredToolHealthOverrides`), then re-GET and assert that
  //   • the GET response no longer carries the override (or expires_at),
  //   • the audit log has a fresh "system: override expired" row, and
  //   • the merged effective config has reverted to the env baseline.
  //
  // Without this check, an off-by-one in the reaper's `WHERE expires_at <= NOW()`
  // clause or a missing `FOR UPDATE` lock would slip past the existing
  // route-validation tests (which never touch SQL) and the cron-wiring
  // tests (which stub the reaper).
  await suite.test(
    "happy: PUT(expires_at=NOW+1s) → wait → runToolHealthCheck → GET reflects auto-revert + audit",
    async () => {
      const original = process.env.ADMIN_API_KEY;
      process.env.ADMIN_API_KEY = ADMIN_KEY;
      // Type-only imports keep the stubs below strictly typed without
      // forcing the production modules to load until the test actually
      // runs (see the dynamic imports a few lines down).
      type AIAlertT = import("../src/utils/aiAlertsDatabase").AIAlert;
      type AlertTypeT = import("../src/utils/aiAlertsDatabase").AlertType;
      type ToolWindowAggregateT =
        import("../src/utils/aiTelemetry").ToolWindowAggregate;
      type NotifyToolHealthBreachResultT =
        import("../src/utils/toolHealthAlertNotifier").NotifyToolHealthBreachResult;
      // Narrow shape of the audit rows surfaced in the GET response —
      // mirrors ToolHealthConfigAuditEntry but loosened to allow the
      // synthetic `_expires_at` key the reaper writes into before_values.
      interface AuditRowShape {
        changed_by: string;
        note: string | null;
        before_values: Record<string, unknown>;
        after_values: Record<string, unknown>;
      }
      try {
        const { runToolHealthCheck } = await import(
          "../src/mastra/workflows/toolHealthAlertsCron"
        );
        const { SYSTEM_REAPER_ATTRIBUTION } = await import(
          "../src/utils/toolHealthConfigDatabase"
        );

        const getHandler = await buildHandler(
          aiOpsRoutes,
          "/api/ai-ops/tool-health-config",
          "GET",
        );
        const putHandler = await buildHandler(
          aiOpsRoutes,
          "/api/ai-ops/tool-health-config",
          "PUT",
        );

        // 1. Snapshot the env baseline so we can assert the post-revert
        //    effective config matches it field-for-field.
        const initial = await getHandler(
          makeContext({ method: "GET", headers: { "X-Admin-Key": ADMIN_KEY } }),
        );
        suite.expectEqual(initial.status, 200, "initial GET status");
        const envBaseline = initial.body?.data?.env_baseline;
        suite.expect(
          envBaseline && typeof envBaseline === "object",
          "env_baseline present",
        );

        // 2. PUT an override with a near-future expires_at. The validator
        //    rejects past timestamps, so we go ~1.2s out — comfortably
        //    above the wall-clock jitter and still short enough to keep
        //    CI fast.
        const expiresAtMs = Date.now() + 1_200;
        const expiresAtIso = new Date(expiresAtMs).toISOString();
        const putRes = await putHandler(
          makeContext({
            method: "PUT",
            headers: { "X-Admin-Key": ADMIN_KEY },
            body: {
              overrides: {
                errorRatePct: 7,
                errorRateHighPct: 21,
                errorRateCriticalPct: 77,
              },
              expires_at: expiresAtIso,
              note: "task #214 auto-revert e2e",
            },
          }),
        );
        suite.expectEqual(putRes.status, 200, "PUT status");
        suite.expectEqual(
          putRes.body?.effective?.errorRateHighPct,
          21,
          "effective reflects override pre-reap",
        );
        suite.expect(
          putRes.body?.after_expires_at != null,
          "after_expires_at set on the write response",
        );

        // 3. Confirm the GET picks up the override + expires_at while we
        //    are still inside the validity window. This catches a regression
        //    where the read path mis-treats a future expiry as already
        //    expired (defense-in-depth filter inverted).
        const midGet = await getHandler(
          makeContext({ method: "GET", headers: { "X-Admin-Key": ADMIN_KEY } }),
        );
        suite.expectEqual(midGet.status, 200, "mid GET status");
        suite.expectEqual(
          midGet.body?.data?.overrides?.errorRateHighPct,
          21,
          "override visible before expiry",
        );
        suite.expect(
          midGet.body?.data?.expires_at != null,
          "expires_at exposed before expiry",
        );

        // 4. Sleep just past the expiry. We add a generous buffer so the
        //    cron's `expires_at <= NOW()` check fires deterministically
        //    even on a slow CI box.
        const remaining = expiresAtMs - Date.now();
        const wait = Math.max(0, remaining) + 800;
        await new Promise((r) => setTimeout(r, wait));

        // 5. Drive a single cron pass with the REAL reaper but stubbed
        //    breach plumbing — we don't want this test to spawn alerts
        //    or pages just because the live DB happens to have noisy
        //    metrics rows. The reaper itself uses the default DB-backed
        //    implementation, so any SQL regression in
        //    `reapExpiredToolHealthOverrides` will surface here.
        const stubAggregates: (
          windowMinutes: number,
          minCalls: number,
        ) => Promise<ToolWindowAggregateT[]> = async () => [];
        const stubOpenAlertExists: (
          alertType: AlertTypeT,
          relatedRecordId: string,
        ) => Promise<boolean> = async () => false;
        // Aggregates is empty above, so the breach loop never runs and
        // these stubs never actually fire. We still give them strictly
        // typed signatures (no `as any`) so a future deps-shape change
        // is caught at compile time instead of in a flaky test pass.
        const stubCreateAlert = async (
          _alert: Omit<AIAlertT, "id" | "created_at" | "status">,
        ): Promise<AIAlertT> => {
          throw new Error(
            "stubCreateAlert: should not run — aggregates were empty",
          );
        };
        const stubGetOpenAlertsByKey: (
          alertType: AlertTypeT,
          relatedRecordId: string,
          options?: { olderThanMinutes?: number },
        ) => Promise<AIAlertT[]> = async () => [];
        const stubResolveAlert: (
          id: number,
          note?: string,
        ) => Promise<AIAlertT | null> = async () => null;
        const stubNotify: () => Promise<NotifyToolHealthBreachResultT> = async () => ({
          slackSent: false,
          emailSent: false,
          throttled: false,
          skipped: true,
        });
        const checkResult = await runToolHealthCheck({
          getToolWindowAggregates: stubAggregates,
          openAlertExistsByKey: stubOpenAlertExists,
          createAIAlert: stubCreateAlert,
          getOpenAlertsByKey: stubGetOpenAlertsByKey,
          resolveAlert: stubResolveAlert,
          notifyToolHealthBreach: stubNotify,
        });
        // Use `>= 1` instead of `=== 1` so a noisy shared CI DB that
        // happened to have another expired override at tick time can't
        // false-fail us — the targeted audit-row match below pins this
        // assertion to *our* seeded override either way.
        suite.expect(
          checkResult.expiredOverridesReaped >= 1,
          `cron pass reported at least one expired override reaped (got ${checkResult.expiredOverridesReaped})`,
        );

        // 6. Re-GET and assert the override + expires_at have been wiped
        //    and the effective config matches the env baseline exactly.
        const postGet = await getHandler(
          makeContext({ method: "GET", headers: { "X-Admin-Key": ADMIN_KEY } }),
        );
        suite.expectEqual(postGet.status, 200, "post GET status");
        const postOverrides = postGet.body?.data?.overrides ?? {};
        suite.expectEqual(
          Object.keys(postOverrides).length,
          0,
          "all override fields cleared after auto-revert",
        );
        suite.expect(
          postGet.body?.data?.expires_at == null,
          "expires_at cleared after auto-revert",
        );
        suite.expectEqual(
          postGet.body?.data?.expired,
          false,
          "derived expired flag false once row is reaped",
        );
        const postEffective = postGet.body?.data?.effective ?? {};
        for (const field of Object.keys(envBaseline)) {
          suite.expectEqual(
            postEffective[field],
            envBaseline[field],
            `effective.${field} reverted to env baseline`,
          );
        }
        suite.expectEqual(
          postGet.body?.data?.updated_by,
          SYSTEM_REAPER_ATTRIBUTION,
          "updated_by attributed to the system reaper",
        );

        // 7. Audit row: must be a fresh entry written by the reaper with
        //    the canonical attribution string and a note that flags the
        //    auto-clear. We look up by attribution + note instead of
        //    assuming index 0 so a noisier shared CI database (where
        //    parallel suites might write between our PUT and our GET)
        //    can't false-fail this assertion.
        const audit = postGet.body?.data?.audit;
        suite.expect(
          Array.isArray(audit) && audit.length > 0,
          "audit log non-empty after reap",
        );
        const auditRows: AuditRowShape[] = Array.isArray(audit) ? audit : [];
        const reapEntry = auditRows.find(
          (row) =>
            row?.changed_by === SYSTEM_REAPER_ATTRIBUTION
            && typeof row?.note === "string"
            && row.note.includes("Auto-cleared")
            && row.note.includes("expires_at")
            // Pin to OUR seeded override so we don't latch onto an
            // unrelated reaper row from earlier in the run.
            && row?.before_values?.errorRateHighPct === 21,
        );
        suite.expect(
          !!reapEntry,
          "found a reaper audit row matching our seeded override",
        );
        suite.expect(
          reapEntry?.before_values?._expires_at != null,
          "audit before_values records the expiry that triggered the reap",
        );
        suite.expect(
          reapEntry?.after_values
            && Object.keys(reapEntry.after_values).length === 0,
          "audit after_values is the empty post-clear snapshot",
        );
      } finally {
        // Defensive cleanup: if any assertion above failed mid-flight, the
        // override row could still be set. Force-clear every field so the
        // live DB is left exactly as we found it (matches the existing
        // happy-path test's cleanup contract).
        try {
          const cleanupHandler = await buildHandler(
            aiOpsRoutes,
            "/api/ai-ops/tool-health-config",
            "PUT",
          );
          await cleanupHandler(
            makeContext({
              method: "PUT",
              headers: { "X-Admin-Key": ADMIN_KEY },
              body: {
                overrides: {
                  windowMinutes: null,
                  minCalls: null,
                  errorRatePct: null,
                  errorRateHighPct: null,
                  errorRateCriticalPct: null,
                  p95LatencyMs: null,
                  latencyHighMs: null,
                  latencyCriticalMs: null,
                },
                expires_at: null,
                note: "task #214 auto-revert e2e cleanup",
              },
            }),
          );
        } catch {
          /* best-effort cleanup */
        }
        if (original === undefined) delete process.env.ADMIN_API_KEY;
        else process.env.ADMIN_API_KEY = original;
      }
    },
  );
}

suite.finishOrExit();
