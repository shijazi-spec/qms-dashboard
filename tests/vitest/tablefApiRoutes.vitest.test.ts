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

import { beforeEach, describe, expect, test, vi } from "vitest";
import { tablefApiRoutes } from "../../src/mastra/routes/tablefApiRoutes";
import { buildHandler, makeContext } from "../_helpers/fakeContext";

const mockQuery = vi.fn();
const mockEnd = vi.fn().mockResolvedValue(undefined);
const mockPool = { query: mockQuery, end: mockEnd };

vi.mock("pg", () => ({
  Pool: vi.fn(function (this: any) {
    return mockPool;
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockEnd.mockResolvedValue(undefined);
});

describe("GET /api/tablef/departments — real data path", () => {
  test("200 returns { departments: [...] } with active=true rows", async () => {
    const rows = [{ dept_id: "d-1", name: "Sales" }, { dept_id: "d-2", name: "Quality" }];
    mockQuery.mockResolvedValueOnce({ rows });

    const handler = await buildHandler(tablefApiRoutes, "/api/tablef/departments", "GET");
    const res = await handler(makeContext({ method: "GET" }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ departments: rows });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

  test("500 with deterministic body when pool.query throws", async () => {
    mockQuery.mockRejectedValueOnce(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const handler = await buildHandler(tablefApiRoutes, "/api/tablef/departments", "GET");
    const res = await handler(makeContext({ method: "GET" }));

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
    const res = await handler(makeContext({ method: "GET" }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kpis: rows });
    const [query, params] = mockQuery.mock.calls[0];
    expect(query).toMatch(/WHERE enabled/);
    expect(params).toEqual([]);
  });

  test("200 appends department_id filter when query param provided", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const handler = await buildHandler(tablefApiRoutes, "/api/tablef/kpis", "GET");
    await handler(makeContext({ method: "GET", query: { department_id: "d-1" } }));

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
    const res = await handler(makeContext({ method: "GET" }));

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
        body: { kpi_id: "KPI-3", department_id: "d-1", period_month: "2026-04", target: 100, achieved: 95 },
      }),
    );

    expect(res.body.trend).toBe("UP");
  });
});

describe("GET /api/tablef/users — real data path", () => {
  test("200 returns { users: [...] }", async () => {
    const rows = [{ user_id: "u-1", email: "alice@example.com" }];
    mockQuery.mockResolvedValueOnce({ rows });

    const handler = await buildHandler(tablefApiRoutes, "/api/tablef/users", "GET");
    const res = await handler(makeContext({ method: "GET" }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ users: rows });
  });
});
