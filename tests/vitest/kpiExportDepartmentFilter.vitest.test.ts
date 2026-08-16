import { describe, it, expect, vi, beforeEach } from "vitest";

const { poolQuery, cursorCalls, deptOwners } = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  cursorCalls: [] as Array<{ sql: string; params: any[] }>,
  deptOwners: vi.fn(),
}));

vi.mock("pg", () => {
  class Pool {
    query = (...a: any[]) => poolQuery(...a);
    end = async () => {};
    connect = async () => ({
      query: (...a: any[]) => poolQuery(...a),
      release: () => {},
    });
  }
  return { default: { Pool }, Pool };
});
vi.mock("../../src/utils/excelExport", () => ({
  cursorQuery: (_pool: any, sql: string, params: any[] = []) => {
    cursorCalls.push({ sql, params });
    return (async function* () {})();
  },
  streamXlsx: vi.fn(async () => new Uint8Array()),
}));
vi.mock("../../src/utils/qualityReportsDepartments", () => ({
  getDepartmentKpiOwnerNames: deptOwners,
}));
vi.mock("../../src/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// The routes under test are wrapped by qmsGate + gateApiRoute, both of which
// require a live session (Cookie header -> DB role lookup) to reach the
// handler body. That auth plumbing is not what this test is exercising —
// only the SQL each handler issues — so it is bypassed here: gateApiRoute
// becomes a passthrough and requireRole always resolves to an admin user.
vi.mock("../../src/utils/rbacMiddleware", () => ({
  gateApiRoute: (route: any) => route,
  requireRole: vi.fn(async () => ({
    userId: 1,
    email: "test@example.com",
    name: "Test User",
    role: "admin",
  })),
  forbiddenResponse: (c: any) => c.json({ error: "forbidden" }, 403),
  QMS_ROLES: ["admin"],
}));

import { qmsEnhancedRoutes } from "../../src/mastra/routes/qmsEnhancedRoutes";

function ctx() {
  return {
    req: { query: () => undefined, param: () => undefined, header: () => undefined },
    json: (b: any, s?: number) => ({ body: b, status: s ?? 200 }),
    body: (b: any, s?: number) => ({ body: b, status: s ?? 200 }),
    header: () => {},
  };
}

async function run(path: string) {
  const route = qmsEnhancedRoutes.find(
    (r: any) => r.path === path && r.method === "GET",
  );
  expect(route, `route ${path} not found`).toBeTruthy();
  const handler = await (route as any).createHandler();
  try { await handler(ctx()); } catch { /* streaming/response plumbing is not under test */ }
}

/** Every statement that reads kpi_definitions must carry the exclusion, or the
 *  export leaks department KPIs (or its totals disagree with its rows). */
function assertExcluded(sql: string, params: any[]) {
  expect(sql).toMatch(/owner_name IS NULL OR/i);
  expect(sql).toMatch(/owner_name <> ALL/i);
  expect(params.some((p) => Array.isArray(p))).toBe(true);
}

beforeEach(() => {
  poolQuery.mockReset().mockResolvedValue({ rows: [{ total: 0 }] });
  cursorCalls.length = 0;
  deptOwners.mockReset().mockResolvedValue(["SDR Team", "Sales Team"]);
});

describe("KPI export department exclusion", () => {
  it("CSV export excludes department KPIs and binds the owner array", async () => {
    await run("/api/kpis/export");
    const defReads = cursorCalls.filter((c) => /FROM\s+kpi_definitions/i.test(c.sql));
    expect(defReads.length).toBeGreaterThan(0);
    for (const c of defReads) assertExcluded(c.sql, c.params);
  });

  it("XLSX export excludes department KPIs in every kpi_definitions statement", async () => {
    await run("/api/kpis/export-xlsx");
    const direct = poolQuery.mock.calls
      .map((c) => ({ sql: String(c[0]), params: (c[1] ?? []) as any[] }))
      .filter((c) => /FROM\s+kpi_definitions/i.test(c.sql));
    const viaCursor = cursorCalls.filter((c) => /FROM\s+kpi_definitions/i.test(c.sql));
    expect(direct.length + viaCursor.length).toBeGreaterThan(0);
    for (const c of [...direct, ...viaCursor]) assertExcluded(c.sql, c.params);
  });

  it("XLSX value count joins kpi_definitions so it matches the row sheets", async () => {
    await run("/api/kpis/export-xlsx");
    const valueCount = poolQuery.mock.calls
      .map((c) => String(c[0]))
      .find((sql) => /COUNT\(\*\)/i.test(sql) && /FROM\s+kpi_values/i.test(sql));
    expect(valueCount).toBeTruthy();
    expect(valueCount).toMatch(/JOIN\s+kpi_definitions/i);
  });
});
