/**
 * Integration tests for src/mastra/routes/dashboardRoutes.ts
 *
 * Coverage matrix:
 *   - structural          → createDashboardRoutes() exports a Hono app with the
 *                           expected dashboard endpoints registered.
 *   - 404                 → Hono app returns 404 for unknown paths.
 *   - GET /dashboard      → 200 with object payload (DB available).
 *   - GET /audit/latest   → 200 with audit object OR 404 message body.
 *   - GET /audit/history  → 200 with array payload, honors ?limit query.
 *   - GET /governance     → 200 with governance doc OR 404 message body.
 *   - GET /scorecard      → 200 with scorecard OR 404 message body.
 *   - POST /audit/trigger → exercises handler end-to-end with fetch stubbed,
 *                           covering both ok (200) and not-ok (500) branches.
 *
 * Note: This module exports a Hono app (not the path/method/createHandler
 * triples used by other routes), so we drive it through Hono's `request()`
 * with real Request instances so the routing/middleware stack is exercised
 * end-to-end.
 *
 * Run:  npx tsx tests/dashboardRoutes.test.ts
 */

import { createDashboardRoutes } from "../src/mastra/routes/dashboardRoutes";
import { TestSuite } from "./_helpers/runner";

const suite = new TestSuite("dashboardRoutes");
const HAS_DB = !!process.env.DATABASE_URL;

console.log("\n=== dashboardRoutes integration tests ===\n");

// ──────────────────────────────────────────────────────────────────────────────
// Structural
// ──────────────────────────────────────────────────────────────────────────────

await suite.test("createDashboardRoutes() returns a Hono app", async () => {
  const app = createDashboardRoutes() as any;
  suite.expect(typeof app === "object" && app !== null, "app is an object");
  suite.expect(typeof app.request === "function", "app.request() is a function");
  suite.expect(typeof app.fetch === "function", "app.fetch() is a function");
});

await suite.test("GET /unknown — 404 from Hono", async () => {
  const app = createDashboardRoutes() as any;
  const res: Response = await app.request(
    new Request("http://localhost/some-unknown-path-xyz")
  );
  suite.expectEqual(res.status, 404, "status");
});

// ──────────────────────────────────────────────────────────────────────────────
// DB-backed GETs
// ──────────────────────────────────────────────────────────────────────────────

if (HAS_DB) {
  await suite.test("GET /dashboard — 200 with object payload", async () => {
    const app = createDashboardRoutes() as any;
    const res: Response = await app.request(new Request("http://localhost/dashboard"));
    suite.expectEqual(res.status, 200, "status");
    const body = await res.json();
    suite.expect(body && typeof body === "object", "body is object");
  });

  await suite.test("GET /audit/latest — 200 with audit OR 404 with message", async () => {
    const app = createDashboardRoutes() as any;
    const res: Response = await app.request(new Request("http://localhost/audit/latest"));
    suite.expect(res.status === 200 || res.status === 404, `status=${res.status}`);
    const body = await res.json();
    suite.expect(body && typeof body === "object", "body is object");
    if (res.status === 404) {
      suite.expectEqual(body.message, "No audit results found", "404 message");
    }
  });

  await suite.test("GET /audit/history — 200 with array payload", async () => {
    const app = createDashboardRoutes() as any;
    const res: Response = await app.request(new Request("http://localhost/audit/history"));
    suite.expectEqual(res.status, 200, "status");
    const body = await res.json();
    suite.expect(Array.isArray(body), "body is array");
  });

  await suite.test("GET /audit/history?limit=5 — 200 honors limit query", async () => {
    const app = createDashboardRoutes() as any;
    const res: Response = await app.request(
      new Request("http://localhost/audit/history?limit=5")
    );
    suite.expectEqual(res.status, 200, "status");
    const body = await res.json();
    suite.expect(Array.isArray(body), "body is array");
    suite.expect(body.length <= 5, `length=${body.length} <= 5`);
  });

  await suite.test("GET /governance — 200 with doc OR 404 with message", async () => {
    const app = createDashboardRoutes() as any;
    const res: Response = await app.request(new Request("http://localhost/governance"));
    suite.expect(res.status === 200 || res.status === 404, `status=${res.status}`);
    const body = await res.json();
    suite.expect(body && typeof body === "object", "body is object");
    if (res.status === 404) {
      suite.expectEqual(body.message, "No governance document found", "404 message");
    }
  });

  await suite.test("GET /scorecard — 200 with scorecard OR 404 with message", async () => {
    const app = createDashboardRoutes() as any;
    const res: Response = await app.request(new Request("http://localhost/scorecard"));
    suite.expect(res.status === 200 || res.status === 404, `status=${res.status}`);
    const body = await res.json();
    suite.expect(body && typeof body === "object", "body is object");
    if (res.status === 404) {
      suite.expectEqual(body.message, "No scorecard found", "404 message");
    }
  });
} else {
  console.log("  (skipped) DB-backed GET tests — DATABASE_URL not set");
}

// ──────────────────────────────────────────────────────────────────────────────
// POST /audit/trigger — fetch-stubbed (does not require workflow server)
// ──────────────────────────────────────────────────────────────────────────────

await suite.test("POST /audit/trigger — 200 success when upstream ok", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ runId: "stubbed" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  try {
    const app = createDashboardRoutes() as any;
    const res: Response = await app.request(
      new Request("http://localhost/audit/trigger", { method: "POST" })
    );
    suite.expectEqual(res.status, 200, "status");
    const body = await res.json();
    suite.expectEqual(body.success, true, "success");
    suite.expectEqual(body.message, "Audit triggered successfully", "message");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await suite.test("POST /audit/trigger — 500 when upstream not ok", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("workflow unavailable", { status: 503 })) as typeof fetch;
  try {
    const app = createDashboardRoutes() as any;
    const res: Response = await app.request(
      new Request("http://localhost/audit/trigger", { method: "POST" })
    );
    suite.expectEqual(res.status, 500, "status");
    const body = await res.json();
    suite.expectEqual(body.success, false, "success=false");
    suite.expectEqual(body.message, "Failed to trigger audit", "message");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await suite.test("POST /audit/trigger — 500 when fetch throws", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  try {
    const app = createDashboardRoutes() as any;
    const res: Response = await app.request(
      new Request("http://localhost/audit/trigger", { method: "POST" })
    );
    suite.expectEqual(res.status, 500, "status");
    const body = await res.json();
    suite.expectEqual(body.error, "Failed to trigger audit", "error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

suite.finishOrExit();
