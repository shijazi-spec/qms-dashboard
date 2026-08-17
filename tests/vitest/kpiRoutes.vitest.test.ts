/**
 * Vitest happy-path tests for src/mastra/routes/kpiRoutes.ts.
 *
 * Stubs the static ESM imports of `../../utils/kpiDatabase` and the
 * dynamic imports of `../../utils/rbacMiddleware` / `../../utils/eventLogsDatabase`
 * so we can exercise the real handler logic and assert on the JSON shape
 * each route returns. Tests are deterministic and need no live database.
 *
 * Run via:  npx vitest run tests/vitest/kpiRoutes.vitest.test.ts
 */

import { beforeEach, describe, expect, test, vi } from "vitest";

// Timeout headroom for this file now lives in vitest.config.ts — several
// route-module suites need it, so it is set once there rather than per file.

import type { FakeContext, CapturedResponse } from "../_helpers/fakeContext";
import { buildHandler, makeContext } from "../_helpers/fakeContext";
import {
  makeKPIDefinition,
  makeKPIValue,
  makeExecutiveReport,
} from "../_helpers/fixtures";

const FAKE_USER = { userId: 0, email: "api@system", name: "API Key", role: "admin" as const };

// GET /api/kpis filters out department-owned KPIs, so the handler now consults
// the BU registry on every request via a DYNAMIC import.
//
// Both mocks below are needed, and the second is the one that actually saves
// this file. `vi.mock` does not reliably intercept a module that a route pulls
// in with `await import(...)` — the mock applies to this file's own import
// while the route still receives the real module (the same behaviour bit
// kpiCatalogRoutes). When that happens the real qualityReportsDepartments
// builds a pg pool and attempts a connection per request: fast enough to pass
// when this file runs alone, slow enough under the full suite's parallel load
// to blow the 5s timeout — after which the leaked state failed the NEXT test
// with a 403, which is why the symptom looked like an auth problem.
//
// Stubbing redactedPool makes the real module harmless either way: every query
// resolves instantly, so no socket is ever opened. Returning [] means "no
// department owners" — exclude nothing — so the existing full-list assertions
// still hold.
vi.mock("../../src/utils/qualityReportsDepartments", () => ({
  getDepartmentKpiOwnerNames: vi.fn(async () => []),
  invalidateDepartmentKpiOwnerCache: vi.fn(),
}));
vi.mock("../../src/utils/redactedPool", () => ({
  createRedactedPool: () => ({
    query: async () => ({ rows: [] }),
    connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
    end: async () => undefined,
  }),
}));
vi.mock("../../src/utils/kpiDatabase", () => ({
  initKPITables: vi.fn(async () => undefined),
  getAllKPIDefinitions: vi.fn(),
  getKPIsByOwner: vi.fn(),
  getKPIById: vi.fn(),
  // Reached via initKPIChecklistTables -> migrateToCommercialBUs, which the
  // route module kicks off asynchronously at import time. Omitting it made the
  // suite flaky rather than failing outright: whether the rejection landed
  // mid-request depended on load, so this file passed alone and failed inside
  // the full run. Stubbed to keep that background init inert.
  getKPIByCode: vi.fn(async () => null),
  createKPIDefinition: vi.fn(),
  updateKPIDefinition: vi.fn(),
  recordKPIValue: vi.fn(),
  getLatestKPIValue: vi.fn(),
  getKPIHistory: vi.fn(),
  getKPIDashboardSummary: vi.fn(),
  createExecutiveReport: vi.fn(),
  getExecutiveReports: vi.fn(),
  getExecutiveReportById: vi.fn(),
  updateExecutiveReport: vi.fn(),
  generateMBRData: vi.fn(),
  seedMohammedKPIsManual: vi.fn(async () => undefined),
  seedSDRKPIsManual: vi.fn(async () => undefined),
  pool: { query: vi.fn(), end: vi.fn() },
}));

vi.mock("../../src/utils/rbacMiddleware", () => ({
  requireRole: vi.fn(async () => FAKE_USER),
  forbiddenResponse: vi.fn((c: FakeContext, msg: string): CapturedResponse => c.json({ error: msg }, 403)),
  requireAdminOrKey: vi.fn(async () => FAKE_USER),
  requireRoleOrKey: vi.fn(async () => FAKE_USER),
  requireAuthOrKey: vi.fn((_c: FakeContext) => FAKE_USER),
  unauthorizedResponse: vi.fn((c: FakeContext): CapturedResponse => c.json({ error: "Unauthorized" }, 401)),
  gateApiRoute: <T>(r: T): T => r,
  hasAdminApiKeyConfigured: vi.fn(() => true),
}));

vi.mock("../../src/utils/eventLogsDatabase", () => ({
  logEvent: vi.fn(async () => undefined),
}));

let kpiDb: typeof import("../../src/utils/kpiDatabase");

beforeEach(async () => {
  kpiDb = await import("../../src/utils/kpiDatabase");
  vi.clearAllMocks();
  vi.mocked(kpiDb.initKPITables).mockResolvedValue(undefined);
});

async function getRoutes() {
  const { kpiRoutes } = await import("../../src/mastra/routes/kpiRoutes");
  return kpiRoutes;
}

describe("GET /api/kpis — real data path", () => {
  // GET /api/kpis now enriches each definition with latestValue/status/trend/
  // lastUpdated via getLatestKPIValue(). With no recorded value (mock → null)
  // the enrichment defaults are latestValue:null, status:"no_data",
  // trend:null, lastUpdated:null.
  const enrich = (k: any) => ({
    ...k,
    latestValue: null,
    status: "no_data",
    trend: null,
    lastUpdated: null,
  });

  test("200 returns getAllKPIDefinitions() when no owner query param", async () => {
    const kpis = [makeKPIDefinition({ id: 1, kpi_name: "Revenue", kpi_code: "REV-01" })];
    vi.mocked(kpiDb.getAllKPIDefinitions).mockResolvedValueOnce(kpis);
    vi.mocked(kpiDb.getLatestKPIValue).mockResolvedValue(null);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/kpis", "GET");
    const res = await handler(makeContext({ method: "GET" }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual(kpis.map(enrich));
    expect(kpiDb.getAllKPIDefinitions).toHaveBeenCalledTimes(1);
    expect(kpiDb.getKPIsByOwner).not.toHaveBeenCalled();
  });

  test("200 returns getKPIsByOwner() when owner query param is present", async () => {
    const kpis = [makeKPIDefinition({ id: 2, kpi_name: "Retention", kpi_code: "RET-01" })];
    vi.mocked(kpiDb.getKPIsByOwner).mockResolvedValueOnce(kpis);
    vi.mocked(kpiDb.getLatestKPIValue).mockResolvedValue(null);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/kpis", "GET");
    const res = await handler(makeContext({ method: "GET", query: { owner: "sales" } }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual(kpis.map(enrich));
    expect(kpiDb.getKPIsByOwner).toHaveBeenCalledWith("sales");
    expect(kpiDb.getAllKPIDefinitions).not.toHaveBeenCalled();
  });

  test("500 with deterministic body when getAllKPIDefinitions throws", async () => {
    vi.mocked(kpiDb.getAllKPIDefinitions).mockRejectedValueOnce(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/kpis", "GET");
    const res = await handler(makeContext({ method: "GET" }));

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to fetch KPIs" });
    errSpy.mockRestore();
  });
});

describe("GET /api/kpis/summary — real data path", () => {
  test("200 returns getKPIDashboardSummary() result", async () => {
    const summary = { total: 10, onTrack: 8, atRisk: 2 };
    vi.mocked(kpiDb.getKPIDashboardSummary).mockResolvedValueOnce(summary);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/kpis/summary", "GET");
    const res = await handler(makeContext({ method: "GET" }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual(summary);
    expect(kpiDb.getKPIDashboardSummary).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/kpis/:id — real data path", () => {
  test("200 returns { ...kpi, latestValue, history } when found", async () => {
    const kpi = makeKPIDefinition({ id: 5, kpi_name: "Revenue", kpi_code: "REV-05" });
    const latestValue = makeKPIValue({ id: 1, kpi_id: 5, actual_value: 99.5 });
    const history = [latestValue];
    vi.mocked(kpiDb.getKPIById).mockResolvedValueOnce(kpi);
    vi.mocked(kpiDb.getLatestKPIValue).mockResolvedValueOnce(latestValue);
    vi.mocked(kpiDb.getKPIHistory).mockResolvedValueOnce(history);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/kpis/:id{[0-9]+}", "GET");
    const res = await handler(makeContext({ method: "GET", params: { id: "5" } }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...kpi, latestValue, history });
    expect(kpiDb.getKPIById).toHaveBeenCalledWith(5);
    expect(kpiDb.getLatestKPIValue).toHaveBeenCalledWith(5);
    expect(kpiDb.getKPIHistory).toHaveBeenCalledWith(5, 12);
  });

  test("404 when KPI not found", async () => {
    vi.mocked(kpiDb.getKPIById).mockResolvedValueOnce(null);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/kpis/:id{[0-9]+}", "GET");
    const res = await handler(makeContext({ method: "GET", params: { id: "999" } }));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "KPI not found" });
    expect(kpiDb.getLatestKPIValue).not.toHaveBeenCalled();
  });

  test("400 when KPI id is not a number", async () => {
    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/kpis/:id{[0-9]+}", "GET");
    const res = await handler(makeContext({ method: "GET", params: { id: "abc" } }));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid KPI ID" });
  });
});

describe("POST /api/kpis — real data path", () => {
  test("200 returns { success: true, kpi } from createKPIDefinition()", async () => {
    const created = makeKPIDefinition({ id: 11, kpi_name: "New KPI", kpi_code: "NEW-01" });
    vi.mocked(kpiDb.createKPIDefinition).mockResolvedValueOnce(created);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/kpis", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        body: { kpi_name: "New KPI", kpi_code: "NEW-01", category: "quality" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, kpi: created });
    expect(kpiDb.createKPIDefinition).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/kpis/:id/history — real data path", () => {
  test("200 returns getKPIHistory() result with forwarded limit", async () => {
    const history = [makeKPIValue({ id: 1, kpi_id: 3, actual_value: 80 })];
    vi.mocked(kpiDb.getKPIHistory).mockResolvedValueOnce(history);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/kpis/:id/history", "GET");
    const res = await handler(
      makeContext({ method: "GET", params: { id: "3" }, query: { limit: "6" } }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(history);
    expect(kpiDb.getKPIHistory).toHaveBeenCalledWith(3, 6);
  });
});

describe("GET /api/executive/reports — real data path", () => {
  test("200 returns getExecutiveReports() result with forwarded type", async () => {
    const reports = [makeExecutiveReport({ id: 1, report_type: "mbr" })];
    vi.mocked(kpiDb.getExecutiveReports).mockResolvedValueOnce(reports);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/executive/reports", "GET");
    const res = await handler(
      makeContext({ method: "GET", query: { type: "mbr" } }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(reports);
    expect(kpiDb.getExecutiveReports).toHaveBeenCalledWith("mbr");
  });
});

describe("GET /api/executive/reports/:id — real data path", () => {
  test("200 returns the report when found", async () => {
    const report = makeExecutiveReport({ id: 7, report_type: "qbr" });
    vi.mocked(kpiDb.getExecutiveReportById).mockResolvedValueOnce(report);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/executive/reports/:id", "GET");
    const res = await handler(makeContext({ method: "GET", params: { id: "7" } }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual(report);
    expect(kpiDb.getExecutiveReportById).toHaveBeenCalledWith(7);
  });

  test("404 when report not found", async () => {
    vi.mocked(kpiDb.getExecutiveReportById).mockResolvedValueOnce(null);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/executive/reports/:id", "GET");
    const res = await handler(makeContext({ method: "GET", params: { id: "404" } }));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Report not found" });
  });
});

describe("GET /api/executive/mbr-data — real data path", () => {
  test("200 returns generateMBRData() result", async () => {
    const data = { period: "2026-Q2", metrics: [] };
    vi.mocked(kpiDb.generateMBRData).mockResolvedValueOnce(data);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/executive/mbr-data", "GET");
    const res = await handler(makeContext({ method: "GET" }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual(data);
    expect(kpiDb.generateMBRData).toHaveBeenCalledTimes(1);
  });
});
