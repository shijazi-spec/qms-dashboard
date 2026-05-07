/**
 * Integration tests for src/mastra/routes/tablefRoutes.ts
 *
 * Coverage matrix (every endpoint registered on the Hono app):
 *   - structural               → createTableFRoutes() returns a Hono app.
 *   - 404                      → unknown path returns 404.
 *   - DB-failure / middleware  → initTableFTables throws → 500 with error body.
 *   - DB-failure / handlers    → every handler's try/catch returns 500 + JSON.
 *   - GET    /departments      → 200 with seeded departments array.
 *   - GET    /kpis             → 200 with kpis array (no filter).
 *   - GET    /kpis?dept        → 200 with kpis filtered by department_id.
 *   - POST   /kpis             → 200 inserts new KPI; round-trips via GET.
 *   - POST   /kpis (update)    → 200 updates existing KPI by kpi_id.
 *   - DELETE /kpis/:id         → 200 soft-deletes (enabled=false).
 *   - GET    /performance      → 200 array, with kpi/dept/period filters.
 *   - POST   /performance      → 200 with computed status/trend/variance.
 *   - GET    /snapshots        → 200 with snapshots array.
 *   - POST   /snapshots/calc.. → 200 success after seeded performance row.
 *   - GET    /users            → 200 with users array.
 *   - POST   /users            → 200 inserts; updates by user_id on second call.
 *   - GET    /insights         → 200 with insights array.
 *
 * Tests use Hono's `app.request()` with a real `Request` instance so the
 * routing/middleware stack (incl. the schema-init middleware) is exercised
 * end-to-end.
 *
 * Run:  npx tsx tests/tablefRoutes.test.ts
 */

import { createTableFRoutes, pool, resetInitState, forceInitReadyForTest } from "../src/mastra/routes/tablefRoutes";
import { TestSuite } from "./_helpers/runner";

const suite = new TestSuite("tablefRoutes");
const HAS_DB = !!process.env.DATABASE_URL;

console.log("\n=== tablefRoutes integration tests ===\n");

// One app instance per suite — middleware-driven schema init runs once.
const app = createTableFRoutes() as any;

// Unique IDs/names so repeated runs do not collide and can be cleaned up.
const RUN_ID = `T${Date.now().toString(36)}`;
const TEST_KPI_ID = `KPI-TEST-${RUN_ID}`;
const TEST_USER_ID = `USR-TEST-${RUN_ID}`;
const TEST_DEPT = "SDR"; // exists from seed
const TEST_PERIOD = `2099-${RUN_ID}`; // unique per run to avoid cross-run collisions

// ──────────────────────────────────────────────────────────────────────────────
// Structural
// ──────────────────────────────────────────────────────────────────────────────

await suite.test("createTableFRoutes() returns a Hono app", async () => {
  suite.expect(typeof app === "object" && app !== null, "app is an object");
  suite.expect(typeof app.request === "function", "app.request() is a function");
  suite.expect(typeof app.fetch === "function", "app.fetch() is a function");
});

await suite.test("GET /unknown — 404 from Hono", async () => {
  const res: Response = await app.request(
    new Request("http://localhost/some-unknown-path-xyz")
  );
  suite.expectEqual(res.status, 404, "status");
});

// ──────────────────────────────────────────────────────────────────────────────
// DB-failure paths — pool.query is stubbed; no real DB required.
// These run regardless of DATABASE_URL so the 500 branches are always covered.
// ──────────────────────────────────────────────────────────────────────────────

/** Helper: replace pool.query with a throwing stub and return a restore fn.
 *
 * Also patches `pg.Pool.prototype.query` so calls issued by *other* Pool
 * instances (notably the separate pool inside `src/utils/tablefDatabase.ts`,
 * which the route handlers delegate to for INSERT/UPDATE/DELETE) are
 * intercepted too. Without the prototype patch, the route's `pool` throws but
 * the database module's `pool` either silently succeeds or hits the real DB,
 * leaving the 500 branches uncovered for write paths (#753 follow-up). */
function stubPoolQueryToThrow(): () => void {
  const original = (pool as any).query.bind(pool);
  const ProtoPool = (pool as any).constructor;
  const protoOriginal = ProtoPool?.prototype?.query;
  (pool as any).query = async () => { throw new Error("simulated DB failure"); };
  if (ProtoPool?.prototype) {
    ProtoPool.prototype.query = async () => { throw new Error("simulated DB failure"); };
  }
  return () => {
    (pool as any).query = original;
    if (ProtoPool?.prototype && protoOriginal) {
      ProtoPool.prototype.query = protoOriginal;
    }
  };
}

// ── initTableFTables middleware failure ───────────────────────────────────────

await suite.test("middleware — 500 when initTableFTables throws", async () => {
  resetInitState();
  const restore = stubPoolQueryToThrow();
  try {
    const errorApp = createTableFRoutes() as any;
    const res: Response = await errorApp.request(
      new Request("http://localhost/departments")
    );
    suite.expectEqual(res.status, 500, "status");
    const body = await res.json();
    suite.expectEqual(body.error, "TableF schema initialization failed", "error message");
  } finally {
    restore();
    resetInitState();
  }
});

// ── Handler failures (init cache pre-set so middleware passes) ────────────────

await suite.test("GET /departments — 500 on DB failure", async () => {
  forceInitReadyForTest();
  const restore = stubPoolQueryToThrow();
  try {
    const errorApp = createTableFRoutes() as any;
    const res: Response = await errorApp.request(
      new Request("http://localhost/departments")
    );
    suite.expectEqual(res.status, 500, "status");
    const body = await res.json();
    suite.expectEqual(body.error, "Failed to fetch departments", "error.error");
    suite.expect(Array.isArray(body.departments) && body.departments.length === 0, "empty departments");
  } finally {
    restore();
  }
});

await suite.test("GET /kpis — 500 on DB failure", async () => {
  forceInitReadyForTest();
  const restore = stubPoolQueryToThrow();
  try {
    const errorApp = createTableFRoutes() as any;
    const res: Response = await errorApp.request(
      new Request("http://localhost/kpis")
    );
    suite.expectEqual(res.status, 500, "status");
    const body = await res.json();
    suite.expectEqual(body.error, "Failed to fetch KPIs", "error.error");
    suite.expect(Array.isArray(body.kpis) && body.kpis.length === 0, "empty kpis");
  } finally {
    restore();
  }
});

await suite.test("POST /kpis — 500 on DB failure", async () => {
  forceInitReadyForTest();
  const restore = stubPoolQueryToThrow();
  try {
    const errorApp = createTableFRoutes() as any;
    const res: Response = await errorApp.request(
      new Request("http://localhost/kpis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ department_id: "SDR", name: "err-kpi" }),
      })
    );
    suite.expectEqual(res.status, 500, "status");
    const body = await res.json();
    suite.expectEqual(body.error, "Failed to save KPI", "error message");
  } finally {
    restore();
  }
});

await suite.test("DELETE /kpis/:kpiId — 500 on DB failure", async () => {
  forceInitReadyForTest();
  const restore = stubPoolQueryToThrow();
  try {
    const errorApp = createTableFRoutes() as any;
    const res: Response = await errorApp.request(
      new Request("http://localhost/kpis/nonexistent-id", { method: "DELETE" })
    );
    suite.expectEqual(res.status, 500, "status");
    const body = await res.json();
    suite.expectEqual(body.error, "Failed to archive KPI", "error message");
  } finally {
    restore();
  }
});

await suite.test("GET /performance — 500 on DB failure", async () => {
  forceInitReadyForTest();
  const restore = stubPoolQueryToThrow();
  try {
    const errorApp = createTableFRoutes() as any;
    const res: Response = await errorApp.request(
      new Request("http://localhost/performance")
    );
    suite.expectEqual(res.status, 500, "status");
    const body = await res.json();
    suite.expectEqual(body.error, "Failed to fetch performance", "error.error");
    suite.expect(Array.isArray(body.performance) && body.performance.length === 0, "empty performance");
  } finally {
    restore();
  }
});

await suite.test("POST /performance — 500 on DB failure", async () => {
  forceInitReadyForTest();
  const restore = stubPoolQueryToThrow();
  try {
    const errorApp = createTableFRoutes() as any;
    const res: Response = await errorApp.request(
      new Request("http://localhost/performance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kpi_id: "KPI-ERR",
          department_id: "SDR",
          period_month: "2099-01",
          target: 10,
          achieved: 8,
        }),
      })
    );
    suite.expectEqual(res.status, 500, "status");
    const body = await res.json();
    suite.expectEqual(body.error, "Failed to save performance", "error message");
  } finally {
    restore();
  }
});

await suite.test("GET /snapshots — 500 on DB failure", async () => {
  forceInitReadyForTest();
  const restore = stubPoolQueryToThrow();
  try {
    const errorApp = createTableFRoutes() as any;
    const res: Response = await errorApp.request(
      new Request("http://localhost/snapshots")
    );
    suite.expectEqual(res.status, 500, "status");
    const body = await res.json();
    suite.expectEqual(body.error, "Failed to fetch snapshots", "error.error");
    suite.expect(Array.isArray(body.snapshots) && body.snapshots.length === 0, "empty snapshots");
  } finally {
    restore();
  }
});

await suite.test("POST /snapshots/calculate — 500 on DB failure", async () => {
  forceInitReadyForTest();
  const restore = stubPoolQueryToThrow();
  try {
    const errorApp = createTableFRoutes() as any;
    const res: Response = await errorApp.request(
      new Request("http://localhost/snapshots/calculate?period=2099-ERR", { method: "POST" })
    );
    suite.expectEqual(res.status, 500, "status");
    const body = await res.json();
    suite.expectEqual(body.error, "Failed to calculate snapshots", "error message");
  } finally {
    restore();
  }
});

await suite.test("GET /users — 500 on DB failure", async () => {
  forceInitReadyForTest();
  const restore = stubPoolQueryToThrow();
  try {
    const errorApp = createTableFRoutes() as any;
    const res: Response = await errorApp.request(
      new Request("http://localhost/users")
    );
    suite.expectEqual(res.status, 500, "status");
    const body = await res.json();
    suite.expectEqual(body.error, "Failed to fetch users", "error.error");
    suite.expect(Array.isArray(body.users) && body.users.length === 0, "empty users");
  } finally {
    restore();
  }
});

await suite.test("POST /users — 500 on DB failure", async () => {
  forceInitReadyForTest();
  const restore = stubPoolQueryToThrow();
  try {
    const errorApp = createTableFRoutes() as any;
    const res: Response = await errorApp.request(
      new Request("http://localhost/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Err User", email: "err@example.com", role: "ANALYST" }),
      })
    );
    suite.expectEqual(res.status, 500, "status");
    const body = await res.json();
    suite.expectEqual(body.error, "Failed to save user", "error message");
  } finally {
    restore();
  }
});

await suite.test("GET /insights — 500 on DB failure", async () => {
  forceInitReadyForTest();
  const restore = stubPoolQueryToThrow();
  try {
    const errorApp = createTableFRoutes() as any;
    const res: Response = await errorApp.request(
      new Request("http://localhost/insights")
    );
    suite.expectEqual(res.status, 500, "status");
    const body = await res.json();
    suite.expectEqual(body.error, "Failed to fetch insights", "error.error");
    suite.expect(Array.isArray(body.insights) && body.insights.length === 0, "empty insights");
  } finally {
    restore();
  }
});

if (!HAS_DB) {
  console.log("  (skipped) DB-backed tests — DATABASE_URL not set");
  suite.finishOrExit();
  process.exit(0);
}

// ──────────────────────────────────────────────────────────────────────────────
// /departments
// ──────────────────────────────────────────────────────────────────────────────

await suite.test("GET /departments — 200 with seeded departments", async () => {
  const res: Response = await app.request(new Request("http://localhost/departments"));
  suite.expectEqual(res.status, 200, "status");
  const body = await res.json();
  suite.expect(Array.isArray(body.departments), "body.departments is array");
  suite.expect(body.departments.length > 0, "departments seeded");
  const sdr = body.departments.find((d: any) => d.department_id === TEST_DEPT);
  suite.expect(!!sdr, "SDR department present");
});

// ──────────────────────────────────────────────────────────────────────────────
// /kpis (insert path uses .kpi_id absence; we drive the explicit kpi_id branch
// by inserting directly so the GET filters can find a known row, then exercise
// both create and update branches via POST.)
// ──────────────────────────────────────────────────────────────────────────────

await suite.test("POST /kpis — 200 inserts new KPI", async () => {
  const res: Response = await app.request(
    new Request("http://localhost/kpis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        department_id: TEST_DEPT,
        name: `Test KPI ${RUN_ID}`,
        description: "integration test kpi",
        category: "Quality",
        unit: "%",
        target_annual: 100,
        target_monthly: 10,
        weight: 1,
        owner_email: "qa@example.com",
        data_source: "manual",
        calculation_definition: "n/a",
      }),
    })
  );
  suite.expectEqual(res.status, 200, "status");
  const body = await res.json();
  suite.expectEqual(body.success, true, "success");
  suite.expect(!!body.kpi && typeof body.kpi.kpi_id === "string", "returns kpi");
  // Re-key the test row to a deterministic id for downstream tests.
  await pool.query(
    "UPDATE tablef_kpis SET kpi_id = $1 WHERE kpi_id = $2",
    [TEST_KPI_ID, body.kpi.kpi_id]
  );
});

await suite.test("GET /kpis — 200 returns array including inserted KPI", async () => {
  const res: Response = await app.request(new Request("http://localhost/kpis"));
  suite.expectEqual(res.status, 200, "status");
  const body = await res.json();
  suite.expect(Array.isArray(body.kpis), "body.kpis is array");
  suite.expect(
    body.kpis.some((k: any) => k.kpi_id === TEST_KPI_ID),
    "test KPI present"
  );
});

await suite.test("GET /kpis?department_id=SDR — 200 filtered by department", async () => {
  const res: Response = await app.request(
    new Request(`http://localhost/kpis?department_id=${TEST_DEPT}`)
  );
  suite.expectEqual(res.status, 200, "status");
  const body = await res.json();
  suite.expect(Array.isArray(body.kpis), "body.kpis is array");
  suite.expect(
    body.kpis.every((k: any) => k.department_id === TEST_DEPT),
    "every kpi has the requested department_id"
  );
});

await suite.test("POST /kpis (with kpi_id) — 200 updates existing KPI", async () => {
  const res: Response = await app.request(
    new Request("http://localhost/kpis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kpi_id: TEST_KPI_ID,
        department_id: TEST_DEPT,
        name: `Test KPI ${RUN_ID} (updated)`,
        description: "updated",
        category: "Quality",
        unit: "%",
        target_annual: 200,
        target_monthly: 20,
        weight: 2,
        owner_email: "qa@example.com",
        data_source: "manual",
        calculation_definition: "n/a",
      }),
    })
  );
  suite.expectEqual(res.status, 200, "status");
  const body = await res.json();
  suite.expectEqual(body.success, true, "success");
  suite.expectEqual(body.kpi?.target_annual, "200.00", "target_annual updated");
  suite.expect(
    typeof body.kpi?.name === "string" && body.kpi.name.includes("(updated)"),
    "name updated"
  );
});

// ──────────────────────────────────────────────────────────────────────────────
// /performance — depends on TEST_KPI_ID
// ──────────────────────────────────────────────────────────────────────────────

await suite.test("POST /performance — 200 computes status/trend/variance", async () => {
  const res: Response = await app.request(
    new Request("http://localhost/performance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kpi_id: TEST_KPI_ID,
        department_id: TEST_DEPT,
        period_month: "2099-01",
        target: 10,
        achieved: 12,
        comment: "great month",
        evidence_link: "https://example.com",
      }),
    })
  );
  suite.expectEqual(res.status, 200, "status");
  const body = await res.json();
  suite.expectEqual(body.success, true, "success");
  suite.expectEqual(body.status, "MET", "status MET when achieved >= target");
  suite.expectEqual(body.variance, 2, "variance");
});

await suite.test("POST /performance (existing) — 200 updates with computed trend", async () => {
  // Seed a prior period so trend is computable.
  const r1: Response = await app.request(
    new Request("http://localhost/performance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kpi_id: TEST_KPI_ID,
        department_id: TEST_DEPT,
        period_month: "2099-02",
        target: 10,
        achieved: 8,
        comment: "worse",
        evidence_link: null,
      }),
    })
  );
  suite.expectEqual(r1.status, 200, "seed status");
  const b1 = await r1.json();
  suite.expectEqual(b1.success, true, "seed success");
  // 8 < 12 (prev period 2099-01) → trend should be DOWN; status NOT_MET.
  suite.expectEqual(b1.trend, "DOWN", "trend DOWN");
  suite.expectEqual(b1.status, "NOT_MET", "status NOT_MET when achieved < 0.9*target");
});

await suite.test("GET /performance — 200 with kpi/dept/period filters", async () => {
  const res: Response = await app.request(
    new Request(
      `http://localhost/performance?kpi_id=${TEST_KPI_ID}&department_id=${TEST_DEPT}&period=2099`
    )
  );
  suite.expectEqual(res.status, 200, "status");
  const body = await res.json();
  suite.expect(Array.isArray(body.performance), "body.performance is array");
  suite.expect(
    body.performance.length >= 2,
    `expected ≥2 perf rows, got ${body.performance.length}`
  );
  suite.expect(
    body.performance.every((p: any) => p.kpi_id === TEST_KPI_ID),
    "all rows match kpi_id filter"
  );
});

// ──────────────────────────────────────────────────────────────────────────────
// /snapshots
// ──────────────────────────────────────────────────────────────────────────────

await suite.test("POST /snapshots/calculate — 200 success", async () => {
  const res: Response = await app.request(
    new Request(`http://localhost/snapshots/calculate?period=${TEST_PERIOD}`, {
      method: "POST",
    })
  );
  suite.expectEqual(res.status, 200, "status");
  const body = await res.json();
  suite.expectEqual(body.success, true, "success");
  suite.expectEqual(body.message, "Snapshots calculated successfully", "message");
});

await suite.test("GET /snapshots — 200 array, supports dept+period filters", async () => {
  const res: Response = await app.request(
    new Request(`http://localhost/snapshots?department_id=${TEST_DEPT}&period=${TEST_PERIOD}`)
  );
  suite.expectEqual(res.status, 200, "status");
  const body = await res.json();
  suite.expect(Array.isArray(body.snapshots), "body.snapshots is array");
  suite.expect(
    body.snapshots.some(
      (s: any) => s.department_id === TEST_DEPT && s.period === TEST_PERIOD
    ),
    "calculated snapshot present"
  );
});

// ──────────────────────────────────────────────────────────────────────────────
// /users — both insert (no user_id) and update (with user_id) branches
// ──────────────────────────────────────────────────────────────────────────────

await suite.test("POST /users — 200 inserts new user", async () => {
  const res: Response = await app.request(
    new Request("http://localhost/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `Test User ${RUN_ID}`,
        email: `test+${RUN_ID}@example.com`,
        role: "ANALYST",
        departments: [TEST_DEPT],
      }),
    })
  );
  suite.expectEqual(res.status, 200, "status");
  const body = await res.json();
  suite.expectEqual(body.success, true, "success");
  // Re-key for the update branch.
  await pool.query(
    "UPDATE tablef_users SET user_id = $1 WHERE name = $2",
    [TEST_USER_ID, `Test User ${RUN_ID}`]
  );
});

await suite.test("GET /users — 200 includes inserted user", async () => {
  const res: Response = await app.request(new Request("http://localhost/users"));
  suite.expectEqual(res.status, 200, "status");
  const body = await res.json();
  suite.expect(Array.isArray(body.users), "body.users is array");
  suite.expect(
    body.users.some((u: any) => u.user_id === TEST_USER_ID),
    "test user present"
  );
});

await suite.test("POST /users (with user_id) — 200 updates existing user", async () => {
  const res: Response = await app.request(
    new Request("http://localhost/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: TEST_USER_ID,
        name: `Test User ${RUN_ID} (updated)`,
        email: `test+${RUN_ID}@example.com`,
        role: "MANAGER",
        departments: [TEST_DEPT, "MGMT"],
        active: true,
      }),
    })
  );
  suite.expectEqual(res.status, 200, "status");
  const body = await res.json();
  suite.expectEqual(body.success, true, "success");
  // Verify update landed.
  const verify = await pool.query(
    "SELECT name, role FROM tablef_users WHERE user_id = $1",
    [TEST_USER_ID]
  );
  suite.expectEqual(verify.rows[0]?.role, "MANAGER", "role updated");
  suite.expect(
    typeof verify.rows[0]?.name === "string" && verify.rows[0].name.includes("(updated)"),
    "name updated"
  );
});

// ──────────────────────────────────────────────────────────────────────────────
// /insights
// ──────────────────────────────────────────────────────────────────────────────

await suite.test("GET /insights — 200 with insights array", async () => {
  // Seed an active insight so the route exercises the populated path.
  await pool.query(
    `INSERT INTO tablef_ai_insights
       (department_id, kpi_id, insight_type, title, body, severity, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE')`,
    [TEST_DEPT, TEST_KPI_ID, "TREND", `insight-${RUN_ID}`, "test body", "LOW"]
  );

  const res: Response = await app.request(new Request("http://localhost/insights"));
  suite.expectEqual(res.status, 200, "status");
  const body = await res.json();
  suite.expect(Array.isArray(body.insights), "body.insights is array");
  suite.expect(
    body.insights.some((i: any) => i.title === `insight-${RUN_ID}`),
    "seeded insight present"
  );
});

// ──────────────────────────────────────────────────────────────────────────────
// DELETE /kpis/:kpiId — soft delete, run last so it does not affect prior tests
// ──────────────────────────────────────────────────────────────────────────────

await suite.test("DELETE /kpis/:kpiId — 200 soft-deletes (enabled=false)", async () => {
  const res: Response = await app.request(
    new Request(`http://localhost/kpis/${TEST_KPI_ID}`, { method: "DELETE" })
  );
  suite.expectEqual(res.status, 200, "status");
  const body = await res.json();
  suite.expectEqual(body.success, true, "success");
  const verify = await pool.query(
    "SELECT enabled FROM tablef_kpis WHERE kpi_id = $1",
    [TEST_KPI_ID]
  );
  suite.expectEqual(verify.rows[0]?.enabled, false, "kpi disabled");
  // Confirm the GET /kpis (filters enabled=true) no longer returns it.
  const listRes: Response = await app.request(new Request("http://localhost/kpis"));
  const list = await listRes.json();
  suite.expect(
    !list.kpis.some((k: any) => k.kpi_id === TEST_KPI_ID),
    "soft-deleted kpi excluded from listing"
  );
});

// ──────────────────────────────────────────────────────────────────────────────
// Cleanup — best-effort; ignore errors so test results stand.
// ──────────────────────────────────────────────────────────────────────────────

try {
  await pool.query("DELETE FROM tablef_ai_insights WHERE title = $1", [`insight-${RUN_ID}`]);
  await pool.query("DELETE FROM tablef_performance WHERE kpi_id = $1", [TEST_KPI_ID]);
  await pool.query("DELETE FROM tablef_kpis WHERE kpi_id = $1", [TEST_KPI_ID]);
  await pool.query("DELETE FROM tablef_users WHERE user_id = $1", [TEST_USER_ID]);
  await pool.query("DELETE FROM tablef_snapshots WHERE period = $1", [TEST_PERIOD]);
} catch (err) {
  console.warn("[tablefRoutes.test] cleanup warning:", (err as Error).message);
}

suite.finishOrExit();
