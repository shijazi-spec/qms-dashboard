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

suite.finishOrExit();
