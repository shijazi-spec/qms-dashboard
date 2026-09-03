/**
 * Vitest happy-path tests for src/mastra/routes/tablefApiRoutes.ts.
 *
 * These routes interact with the database via the `pg.Pool` class directly
 * (raw SQL), so we mock the `pg` module. A single shared pool instance is
 * returned by the Pool constructor mock so each test can configure the
 * `query` spy via mockResolvedValueOnce before invoking the handler.
 *
 * Run via:  npx vitest run tests/vitest/tablefApiRoutes.vitest.test.ts
 */

import crypto from "crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";

// Task #60 wraps every tablef route with `tablefGate(...)` → `requireRole(c,
// roles)`. That helper checks for BOTH a valid session cookie AND (when no
// admin API key is present) a row in the platform users table. To keep this
// suite self-contained — no DB, no real session-store — we forge a session
// cookie with role='admin' AND send the matching X-Admin-Key header. With
// the admin key present, requireRole() skips the platform-user lookup
// (rbacMiddleware.ts L107). Both env vars must be set BEFORE any module that
// reads them (rbacMiddleware, authRoutes) is imported.
const <REDACTED_SECRET> = "<REDACTED_SECRET>";
const <REDACTED_SECRET> = "<REDACTED_SECRET>";
process.env.ADMIN_API_KEY = <REDACTED_SECRET>;
process.env.SESSION_SECRET = <REDACTED_SECRET>;

import { tablefApiRoutes } from "../../src/mastra/routes/tablefApiRoutes";
import { buildHandler, makeContext } from "../_helpers/fakeContext";

// Replicate the private signSession() in authRoutes.ts so we can mint a
// cryptographically valid `ExampleOrg_session` cookie without exporting it.
function signSession(payload: Record<string, unknown>): string {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", <REDACTED_SECRET>)
    .update(data)
    .digest("base64url");
  return `${data}.${sig}`;
}

const ADMIN_SESSION_COOKIE =
  "ExampleOrg_session=" +
  encodeURIComponent(
    signSession({ userId: 1, email: "<REDACTED_EMAIL>", name: "Test", role: "admin" }),
  );

const ADMIN_HEADERS = {
  "X-Admin-Key": <REDACTED_SECRET>,
  Cookie: ADMIN_SESSION_COOKIE,
};

// `pg` is a CJS module that exports both a default object (`pg.Pool`,
// `pg.Client`, …) and named exports (`{ Pool, Client }`). When ESM consumers
// do `await import("pg")` (as the route handler does at runtime), Vitest's
// module mock must expose BOTH the named export and a `default` property so
// the synthetic-namespace contains `default.Pool` for any transitive dep that
// reaches `pg` via the default export. Omit `default` here and Vitest fails
// at module-graph load with: `No "default" export is defined on the "pg" mock`.
//
// Bonus subtlety: `vi.mock(...)` is hoisted to the top of the file by Vitest,
// so it runs BEFORE any `const`/`let` declarations in module body — meaning
// the factory cannot close over plain top-level constants without hitting a
// TDZ ReferenceError when transitive `import 'pg'` evaluation triggers
// `new Pool()` at module-graph load time. Use `vi.hoisted({...})` so the
// shared mock objects are themselves hoisted alongside the mock factory.
const { mockQuery, mockEnd, mockPool } = vi.hoisted(() => {
  const q = vi.fn();
  const e = vi.fn().mockResolvedValue(undefined);
  // `wrapPoolForRedaction` (src/utils/redactedPool.ts) binds `pool.connect`
  // and registers `pool.on('error', ...)` at module-graph load time, so the
  // hoisted mock must expose those surfaces even though no test in this file
  // actually checks out a transactional client.
  const pool: Record<string, unknown> = {
    query: q,
    end: e,
    on: () => pool,
    connect: async () => ({
      query: q,
      release: () => undefined,
    }),
  };
  return { mockQuery: q, mockEnd: e, mockPool: pool };
});

vi.mock("pg", () => {
  const PoolMock = vi.fn(function (this: any) { return mockPool; });
  return { Pool: PoolMock, default: { Pool: PoolMock } };
});

beforeEach(() => {
  vi.clearAllMocks();
  mockEnd.mockResolvedValue(undefined);
});

describe("GET /api/tablef/departments — real data path", () => {
  test("200 returns { departments: [...] } with active=true rows", async () => {
    const rows = [{ dept_id: "d-1", name: "Sales" }, { dept_id: "d-2", name: "Quality" }];
    mockQuery.mockResolvedValueOnce({ rows });

    const handler = await buildHandler(tablefApiRoutes, "/api/tablef/departments", "GET");
    const res = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ departments: rows });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

  test("500 with deterministic body when pool.query throws", async () => {
    mockQuery.mockRejectedValueOnce(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const handler = await buildHandler(tablefApiRoutes, "/api/tablef/departments", "GET");
    const res = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: "Failed to fetch departments", departments: [] });
    errSpy.mockRestore();
  });
});

describe("GET /api/tablef/kpis — real data path", () => {
  test("200 returns { kpis: [...] } without department filter", async () => {
    const rows = [{ kpi_id: "KPI-1", name: "Revenue" }];
    mockQuery.mockResolvedValueOnce({ rows });

    const handler = await buildHandler(tablefApiRoutes, "/api/tablef/kpis", "GET");
    const res = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kpis: rows });
    const [query, params] = mockQuery.mock.calls[0];
    expect(query).toMatch(/WHERE enabled/);
    expect(params).toEqual([]);
  });

  test("200 appends department_id filter when query param provided", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const handler = await buildHandler(tablefApiRoutes, "/api/tablef/kpis", "GET");
    await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS, query: { department_id: "d-1" } }));

    const [query, params] = mockQuery.mock.calls[0];
    expect(query).toContain("department_id = $1");
    expect(params).toEqual(["d-1"]);
  });
});

describe("GET /api/tablef/performance — real data path", () => {
  test("200 returns { performance: [...] }", async () => {
    const rows = [{ kpi_id: "KPI-1", period_month: "2026-03", achieved: 95 }];
    mockQuery.mockResolvedValueOnce({ rows });

    const handler = await buildHandler(tablefApiRoutes, "/api/tablef/performance", "GET");
    const res = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ performance: rows });
  });
});

describe("POST /api/tablef/performance — real data path", () => {
  test("200 returns { success, status, trend, variance, variancePercent } on insert", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const handler = await buildHandler(tablefApiRoutes, "/api/tablef/performance", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        headers: ADMIN_HEADERS,
        body: {
          kpi_id: "KPI-1",
          department_id: "d-1",
          period_month: "2026-04",
          target: 100,
          achieved: 110,
          comment: "Exceeded",
          evidence_link: "",
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe("MET");
    expect(res.body.trend).toBe("FLAT");
    expect(res.body.variance).toBe(10);
    expect(res.body.variancePercent).toBeCloseTo(10);
  });

  test("200 status is IMPROVING when achieved is between 90% and 100% of target", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const handler = await buildHandler(tablefApiRoutes, "/api/tablef/performance", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        headers: ADMIN_HEADERS,
        body: { kpi_id: "KPI-2", department_id: "d-1", period_month: "2026-04", target: 100, achieved: 93 },
      }),
    );

    expect(res.body.status).toBe("IMPROVING");
  });

  test("200 trend is UP when previous period value was lower", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ achieved: "80" }] })
      .mockResolvedValueOnce({ rows: [] });

    const handler = await buildHandler(tablefApiRoutes, "/api/tablef/performance", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        headers: ADMIN_HEADERS,
        body: { kpi_id: "KPI-3", department_id: "d-1", period_month: "2026-04", target: 100, achieved: 95 },
      }),
    );

    expect(res.body.trend).toBe("UP");
  });
});

describe("GET /api/tablef/users — real data path", () => {
  test("200 returns { users: [...] }", async () => {
    const rows = [{ user_id: "u-1", email: "<REDACTED_EMAIL>" }];
    mockQuery.mockResolvedValueOnce({ rows });

    const handler = await buildHandler(tablefApiRoutes, "/api/tablef/users", "GET");
    const res = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ users: rows });
  });
});
