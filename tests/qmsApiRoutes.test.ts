/**
 * Integration tests for src/mastra/routes/qmsApiRoutes.ts
 *
 * Coverage matrix:
 *   - 200 happy path  → GET /api/qms/framework (returns default framework when
 *                       no DB row exists), GET /api/qms/dashboard (asserts
 *                       response shape). Both gated on DATABASE_URL.
 *   - 403 forbidden   → every QMS GET endpoint without auth, plus POST capa
 *                       and POST nc.
 *   - 500 bad input   → POST /api/qms/capa with auth but empty body — DB
 *                       constraint failure surfaces as deterministic 500.
 *   - structural      → every route exposes path/method/createHandler.
 *
 * Auth-boundary tests run without any DB (the auth check happens before the
 * dynamic DB import). Happy-path tests are skipped when DATABASE_URL is unset
 * so the suite remains green on a clean checkout.
 *
 * Run:  npx tsx tests/qmsApiRoutes.test.ts
 */

import { qmsApiRoutes } from "../src/mastra/routes/qmsApiRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("qmsApiRoutes");
const HAS_DB = !!process.env.DATABASE_URL;
const ADMIN_KEY = "integration-test-qms-2026";

console.log("\n=== qmsApiRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of qmsApiRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expectEqual(qmsApiRoutes.length >= 10, true, "at least 10 routes registered");
});

const QMS_GET_ROUTES = [
  "/api/qms/dashboard",
  "/api/qms/evaluations",
  "/api/qms/evaluations/stats",
  "/api/qms/capa",
  "/api/qms/nc",
  "/api/qms/training",
  "/api/qms/training/assignments",
  "/api/qms/framework",
];

for (const path of QMS_GET_ROUTES) {
  await suite.test(`GET ${path} — 403 without auth (deterministic body)`, async () => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    try {
      const handler = await buildHandler(qmsApiRoutes, path, "GET");
      const res = await handler(makeContext({ method: "GET" }));
      suite.expectEqual(res.status, 403, `status for GET ${path}`);
      suite.expectEqual(res.body?.error, "Insufficient permissions", "body.error");
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
    }
  });
}

await suite.test("GET /api/qms/capa/:id — 403 without auth", async () => {
  const original = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  try {
    const handler = await buildHandler(qmsApiRoutes, "/api/qms/capa/:id", "GET");
    const res = await handler(makeContext({ method: "GET", params: { id: "1" } }));
    suite.expectEqual(res.status, 403, "status");
    suite.expectEqual(res.body?.error, "Insufficient permissions", "body.error");
  } finally {
    if (original === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = original;
  }
});

await suite.test("POST /api/qms/capa — 403 without auth", async () => {
  const original = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  try {
    const handler = await buildHandler(qmsApiRoutes, "/api/qms/capa", "POST");
    const res = await handler(
      makeContext({ method: "POST", body: { title: "x", capaType: "corrective", severity: "minor" } }),
    );
    suite.expectEqual(res.status, 403, "status");
    suite.expectEqual(res.body?.error, "Insufficient permissions", "body.error");
  } finally {
    if (original === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = original;
  }
});

await suite.test("POST /api/qms/nc — 403 without auth", async () => {
  const original = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  try {
    const handler = await buildHandler(qmsApiRoutes, "/api/qms/nc", "POST");
    const res = await handler(makeContext({ method: "POST", body: { title: "x", severity: "minor" } }));
    suite.expectEqual(res.status, 403, "status");
    suite.expectEqual(res.body?.error, "Insufficient permissions", "body.error");
  } finally {
    if (original === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = original;
  }
});

if (HAS_DB) {
  await suite.test("GET /api/qms/framework — 200 returns framework with criteria (DB available)", async () => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    try {
      const handler = await buildHandler(qmsApiRoutes, "/api/qms/framework", "GET");
      const res = await handler(makeContext({ method: "GET", headers: { "X-Admin-Key": ADMIN_KEY } }));
      suite.expectEqual(res.status, 200, "status");
      suite.expect(res.body && typeof res.body === "object", "body is object");
      // The route falls back to getDefaultFramework() when no row exists, so a
      // valid framework object must always be returned with these fields.
      suite.expect(typeof res.body?.id === "string" || typeof res.body?.id === "number", "body.id present");
      suite.expect(typeof res.body?.name === "string", "body.name is string");
      suite.expect(Array.isArray(res.body?.dimensions), "body.dimensions is array");
      suite.expect((res.body?.dimensions?.length ?? 0) > 0, "body.dimensions has entries");
      const firstDim = res.body?.dimensions?.[0];
      suite.expect(firstDim && Array.isArray(firstDim.criteria), "body.dimensions[0].criteria is array");
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
    }
  });

  await suite.test("GET /api/qms/dashboard — 200 returns dashboard data (DB available)", async () => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    try {
      const handler = await buildHandler(qmsApiRoutes, "/api/qms/dashboard", "GET");
      const res = await handler(makeContext({ method: "GET", headers: { "X-Admin-Key": ADMIN_KEY } }));
      suite.expectEqual(res.status, 200, "status");
      suite.expect(res.body && typeof res.body === "object", "body is object");
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
    }
  });

  await suite.test("POST /api/qms/capa — 500 with deterministic error when required fields are missing", async () => {
    // Auth ok, but createCapaRecord throws on the NOT NULL title constraint.
    // Handler catches and always returns exactly 500 with this exact error.
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    try {
      const handler = await buildHandler(qmsApiRoutes, "/api/qms/capa", "POST");
      const res = await handler(
        makeContext({ method: "POST", headers: { "X-Admin-Key": ADMIN_KEY }, body: {} }),
      );
      suite.expectEqual(res.status, 500, "status");
      suite.expectEqual(res.body?.error, "Failed to create CAPA", "body.error");
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
    }
  });
} else {
  console.log("  (skipped) GET /api/qms/framework — DATABASE_URL not set");
  console.log("  (skipped) GET /api/qms/dashboard — DATABASE_URL not set");
  console.log("  (skipped) POST /api/qms/capa bad-input — DATABASE_URL not set");
}

suite.finishOrExit();
