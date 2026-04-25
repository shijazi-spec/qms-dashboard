/**
 * Vitest happy-path tests for src/mastra/routes/scorecardRoutes.ts.
 *
 * Stubs the static ESM imports of `../../utils/scorecardDatabase` and the
 * dynamic imports of `../../utils/rbacMiddleware` so we can exercise the
 * real handler logic and assert on the JSON shape. Tests are deterministic
 * and need no live database.
 *
 * Run via:  npx vitest run tests/vitest/scorecardRoutes.vitest.test.ts
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { FakeContext, CapturedResponse } from "../_helpers/fakeContext";
import { buildHandler, makeContext } from "../_helpers/fakeContext";

const FAKE_USER = { userId: 0, email: "api@system", name: "API Key", role: "admin" as const };

vi.mock("../../src/utils/scorecardDatabase", () => ({
  initScorecardTables: vi.fn(async () => undefined),
  getMohammedScorecard: vi.fn(),
  saveScorecard: vi.fn(),
  getScorecardHistory: vi.fn(),
  calculateKPI1_GovernanceDocLifecycle: vi.fn(),
  calculateKPI2_ComplianceObligationTracking: vi.fn(),
  calculateKPI3_AuditEvidencePackReadiness: vi.fn(),
  calculateKPI4_QualityGRCHandoff: vi.fn(),
  calculateKPI5_RiskRegisterHygiene: vi.fn(),
  calculateKPI6_ExecutiveReportingReadiness: vi.fn(),
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

let scorecardDb: typeof import("../../src/utils/scorecardDatabase");

beforeEach(async () => {
  scorecardDb = await import("../../src/utils/scorecardDatabase");
  vi.clearAllMocks();
  vi.mocked(scorecardDb.initScorecardTables).mockResolvedValue(undefined);
});

async function getRoutes() {
  const { scorecardRoutes } = await import("../../src/mastra/routes/scorecardRoutes");
  return scorecardRoutes;
}

describe("GET /api/scorecard/mohammed — real data path", () => {
  test("200 returns { success: true, data: scorecard } when found", async () => {
    const scorecard = {
      employee: { name: "Mohammed Al Muzaini", role: "Head of Operations" },
      overall_score: 87.5,
      weighted_score: 82.0,
      kpis: [] as unknown[],
    };
    vi.mocked(scorecardDb.getMohammedScorecard).mockResolvedValueOnce(scorecard);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/scorecard/mohammed", "GET");
    const res = await handler(makeContext({ method: "GET" }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: scorecard });
    expect(scorecardDb.getMohammedScorecard).toHaveBeenCalledTimes(1);
  });

  test("500 with deterministic body when getMohammedScorecard throws", async () => {
    vi.mocked(scorecardDb.getMohammedScorecard).mockRejectedValueOnce(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/scorecard/mohammed", "GET");
    const res = await handler(makeContext({ method: "GET" }));

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: "An internal error occurred" });
    errSpy.mockRestore();
  });
});

describe("GET /api/scorecard/kpi/:kpiNumber — real data path", () => {
  test("200 calls calculateKPI1_GovernanceDocLifecycle() for KPI 1", async () => {
    const result = { score: 10, label: "KPI 1" };
    vi.mocked(scorecardDb.calculateKPI1_GovernanceDocLifecycle).mockResolvedValueOnce(result);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/scorecard/kpi/:kpiNumber", "GET");
    const res = await handler(makeContext({ method: "GET", params: { kpiNumber: "1" } }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, kpi_number: 1, data: result });
    expect(scorecardDb.calculateKPI1_GovernanceDocLifecycle).toHaveBeenCalledTimes(1);
  });

  test("200 calls calculateKPI3_AuditEvidencePackReadiness() for KPI 3", async () => {
    const result = { score: 30, label: "KPI 3" };
    vi.mocked(scorecardDb.calculateKPI3_AuditEvidencePackReadiness).mockResolvedValueOnce(result);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/scorecard/kpi/:kpiNumber", "GET");
    const res = await handler(makeContext({ method: "GET", params: { kpiNumber: "3" } }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, kpi_number: 3, data: result });
    expect(scorecardDb.calculateKPI3_AuditEvidencePackReadiness).toHaveBeenCalledTimes(1);
  });

  test("200 calls calculateKPI6_ExecutiveReportingReadiness() for KPI 6", async () => {
    const result = { score: 60, label: "KPI 6" };
    vi.mocked(scorecardDb.calculateKPI6_ExecutiveReportingReadiness).mockResolvedValueOnce(result);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/scorecard/kpi/:kpiNumber", "GET");
    const res = await handler(makeContext({ method: "GET", params: { kpiNumber: "6" } }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, kpi_number: 6, data: result });
    expect(scorecardDb.calculateKPI6_ExecutiveReportingReadiness).toHaveBeenCalledTimes(1);
  });

  test("400 for invalid kpi number (e.g. 99)", async () => {
    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/scorecard/kpi/:kpiNumber", "GET");
    const res = await handler(makeContext({ method: "GET", params: { kpiNumber: "99" } }));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: "Invalid KPI number (1-6)" });
  });
});

describe("POST /api/scorecard/snapshot — real data path", () => {
  test("200 returns { success: true, message, data: saved } when snapshot is saved", async () => {
    const scorecard = {
      employee: { name: "Mohammed Al Muzaini", role: "Head of Operations" },
      overall_score: 91,
      weighted_score: 88,
      kpis: [] as unknown[],
    };
    const saved = { id: 1, overall_score: 91, period_start: new Date(), period_end: new Date() };
    vi.mocked(scorecardDb.getMohammedScorecard).mockResolvedValueOnce(scorecard);
    vi.mocked(scorecardDb.saveScorecard).mockResolvedValueOnce(saved);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/scorecard/snapshot", "POST");
    const res = await handler(makeContext({ method: "POST" }));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBe(saved);
    expect(scorecardDb.getMohammedScorecard).toHaveBeenCalledTimes(1);
    expect(scorecardDb.saveScorecard).toHaveBeenCalledTimes(1);
    const savedArgs = vi.mocked(scorecardDb.saveScorecard).mock.calls[0][0];
    expect(savedArgs.employee_name).toBe("Mohammed Al Muzaini");
    expect(savedArgs.overall_score).toBe(91);
  });
});

describe("GET /api/scorecard/history — real data path", () => {
  test("200 returns { success: true, data: history } with default name and limit", async () => {
    const history = [{ id: 1, overall_score: 85, period_start: new Date() }];
    vi.mocked(scorecardDb.getScorecardHistory).mockResolvedValueOnce(history);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/scorecard/history", "GET");
    const res = await handler(makeContext({ method: "GET" }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: history });
    expect(scorecardDb.getScorecardHistory).toHaveBeenCalledWith("Mohammed Al Muzaini", 12);
  });

  test("200 forwards custom name and limit", async () => {
    vi.mocked(scorecardDb.getScorecardHistory).mockResolvedValueOnce([]);

    const routes = await getRoutes();
    const handler = await buildHandler(routes, "/api/scorecard/history", "GET");
    await handler(
      makeContext({ method: "GET", query: { name: "Test User", limit: "6" } }),
    );

    expect(scorecardDb.getScorecardHistory).toHaveBeenCalledWith("Test User", 6);
  });
});
