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
}

suite.finishOrExit();
