/**
 * Vitest happy-path tests for src/mastra/routes/qmsApiRoutes.ts.
 *
 * These complement the auth-boundary suite at tests/qmsApiRoutes.test.ts (run
 * via `npx tsx`) by exercising the *real database paths*: each route's
 * dynamic ESM import of `../../utils/qmsDatabase` is replaced with a vitest
 * mock so we can stub the data layer and assert on the JSON the handler
 * actually returns. This catches regressions in the response shape that the
 * tsx auth-gate suite is structurally unable to see.
 *
 * Run via:  npx vitest run tests/vitest/qmsApiRoutes.vitest.test.ts
 * Or as part of:  npm test  (see tests/runIntegrationTests.ts)
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { qmsApiRoutes } from "../../src/mastra/routes/qmsApiRoutes";
import { buildHandler, makeContext } from "../_helpers/fakeContext";
import {
  makeCapa,
  makeCapaActionItem,
  makeNonconformance,
  makeTrainingRecord,
  makeTrainingAssignment,
  makeDealEvaluation,
  makeFramework,
} from "../_helpers/fixtures";

vi.mock("../../src/utils/qmsDatabase", () => ({
  getQmsDashboardData: vi.fn(),
  getDealEvaluations: vi.fn(),
  getEvaluationStatistics: vi.fn(),
  getCapaRecords: vi.fn(),
  getCapaById: vi.fn(),
  getCapaActionItems: vi.fn(),
  createCapaRecord: vi.fn(),
  getNonconformances: vi.fn(),
  createNonconformance: vi.fn(),
  getTrainingRecords: vi.fn(),
  getTrainingAssignments: vi.fn(),
  getActiveFramework: vi.fn(),
}));

vi.mock("../../src/utils/eventLogsDatabase", () => ({
  logEvent: vi.fn(async () => undefined),
}));

const ADMIN_KEY = "vitest-qms-key-2026";
const AUTH_HEADERS = { "X-Admin-Key": ADMIN_KEY };

let qmsDb: typeof import("../../src/utils/qmsDatabase");

beforeEach(async () => {
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  qmsDb = await import("../../src/utils/qmsDatabase");
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.ADMIN_API_KEY;
});

type ErrorCase = {
  name: string;
  path: string;
  method: string;
  dbFn: keyof typeof import("../../src/utils/qmsDatabase");
  errorBody: { error: string };
  body?: unknown;
  params?: Record<string, string>;
  query?: Record<string, string>;
};

const ERROR_CASES: ErrorCase[] = [
  {
    name: "GET /api/qms/dashboard",
    path: "/api/qms/dashboard",
    method: "GET",
    dbFn: "getQmsDashboardData",
    errorBody: { error: "Failed to fetch QMS dashboard" },
  },
  {
    name: "GET /api/qms/evaluations",
    path: "/api/qms/evaluations",
    method: "GET",
    dbFn: "getDealEvaluations",
    errorBody: { error: "Failed to fetch evaluations" },
  },
  {
    name: "GET /api/qms/evaluations/stats",
    path: "/api/qms/evaluations/stats",
    method: "GET",
    dbFn: "getEvaluationStatistics",
    errorBody: { error: "Failed to fetch evaluation stats" },
  },
  {
    name: "GET /api/qms/capa",
    path: "/api/qms/capa",
    method: "GET",
    dbFn: "getCapaRecords",
    errorBody: { error: "Failed to fetch CAPA records" },
  },
  {
    name: "GET /api/qms/capa/:id",
    path: "/api/qms/capa/:id",
    method: "GET",
    dbFn: "getCapaById",
    errorBody: { error: "Failed to fetch CAPA details" },
    params: { id: "1" },
  },
  {
    name: "POST /api/qms/capa",
    path: "/api/qms/capa",
    method: "POST",
    dbFn: "createCapaRecord",
    errorBody: { error: "Failed to create CAPA" },
    body: { title: "X", severity: "minor", capaType: "corrective" },
  },
  {
    name: "GET /api/qms/nc",
    path: "/api/qms/nc",
    method: "GET",
    dbFn: "getNonconformances",
    errorBody: { error: "Failed to fetch NC records" },
  },
  {
    name: "POST /api/qms/nc",
    path: "/api/qms/nc",
    method: "POST",
    dbFn: "createNonconformance",
    errorBody: { error: "Failed to create NC" },
    body: { title: "X", severity: "minor", ncType: "process" },
  },
  {
    name: "GET /api/qms/training",
    path: "/api/qms/training",
    method: "GET",
    dbFn: "getTrainingRecords",
    errorBody: { error: "Failed to fetch training records" },
  },
  {
    name: "GET /api/qms/training/assignments",
    path: "/api/qms/training/assignments",
    method: "GET",
    dbFn: "getTrainingAssignments",
    errorBody: { error: "Failed to fetch training assignments" },
  },
  {
    name: "GET /api/qms/framework",
    path: "/api/qms/framework",
    method: "GET",
    dbFn: "getActiveFramework",
    errorBody: { error: "Failed to fetch evaluation framework" },
  },
];

describe("error-path coverage — every db-backed QMS route returns deterministic 500 body", () => {
  test.each(ERROR_CASES)(
    "$name returns 500 with exact error body when $dbFn rejects",
    async ({ path, method, dbFn, errorBody, body, params, query }) => {
      const fn = qmsDb[dbFn] as unknown as ReturnType<typeof vi.fn>;
      vi.mocked(fn).mockRejectedValueOnce(new Error("simulated db failure"));
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const handler = await buildHandler(qmsApiRoutes, path, method);
      const res = await handler(
        makeContext({ method, headers: AUTH_HEADERS, body, params, query }),
      );

      expect(res.status).toBe(500);
      expect(res.body).toEqual(errorBody);
      errSpy.mockRestore();
    },
  );
});

describe("GET /api/qms/dashboard — real data path", () => {
  test("200 returns the exact payload from getQmsDashboardData", async () => {
    const fixture: Awaited<ReturnType<typeof qmsDb.getQmsDashboardData>> = {
      evaluations: { total: 42, avgScore: 78.5, passRate: 88 },
      capa: { open: 3, inProgress: 2, closed: 7, overdue: 1 },
      nonconformances: { open: 4, critical: 1, closed: 9 },
      training: { assigned: 5, completed: 11, overdue: 0 },
      recentEvaluations: [makeDealEvaluation({ id: 1 })],
      recentCapas: [makeCapa({ id: 9, capa_number: "C-9" })],
    };
    vi.mocked(qmsDb.getQmsDashboardData).mockResolvedValueOnce(fixture);

    const handler = await buildHandler(qmsApiRoutes, "/api/qms/dashboard", "GET");
    const res = await handler(makeContext({ method: "GET", headers: AUTH_HEADERS }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual(fixture);
    expect(qmsDb.getQmsDashboardData).toHaveBeenCalledTimes(1);
  });

  test("500 with deterministic body when getQmsDashboardData throws", async () => {
    vi.mocked(qmsDb.getQmsDashboardData).mockRejectedValueOnce(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const handler = await buildHandler(qmsApiRoutes, "/api/qms/dashboard", "GET");
    const res = await handler(makeContext({ method: "GET", headers: AUTH_HEADERS }));

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to fetch QMS dashboard" });
    errSpy.mockRestore();
  });
});

describe("GET /api/qms/evaluations — real data path", () => {
  test("200 forwards query params to getDealEvaluations and returns its result", async () => {
    const fixture: Awaited<ReturnType<typeof qmsDb.getDealEvaluations>> = {
      records: [makeDealEvaluation({ id: 1 })],
      total: 1,
    };
    vi.mocked(qmsDb.getDealEvaluations).mockResolvedValueOnce(fixture);

    const handler = await buildHandler(qmsApiRoutes, "/api/qms/evaluations", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        headers: AUTH_HEADERS,
        query: { limit: "20", offset: "5", dealId: "d-7", minScore: "60", maxScore: "95" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(fixture);
    expect(qmsDb.getDealEvaluations).toHaveBeenCalledWith({
      limit: 20,
      offset: 5,
      dealId: "d-7",
      minScore: 60,
      maxScore: 95,
    });
  });

  test("query defaults: limit=50 / offset=0 / minScore=undefined / maxScore=undefined", async () => {
    vi.mocked(qmsDb.getDealEvaluations).mockResolvedValueOnce({ records: [], total: 0 });

    const handler = await buildHandler(qmsApiRoutes, "/api/qms/evaluations", "GET");
    await handler(makeContext({ method: "GET", headers: AUTH_HEADERS }));

    expect(qmsDb.getDealEvaluations).toHaveBeenCalledWith({
      limit: 50,
      offset: 0,
      dealId: undefined,
      minScore: undefined,
      maxScore: undefined,
    });
  });
});

describe("GET /api/qms/evaluations/stats — real data path", () => {
  test("200 returns getEvaluationStatistics() result", async () => {
    const stats: Awaited<ReturnType<typeof qmsDb.getEvaluationStatistics>> = {
      totalEvaluations: 100,
      averageScore: 81,
      passRate: 90,
      criticalFindings: 3,
      evaluationsByDimension: { people: 25, process: 50, governance: 25 },
    };
    vi.mocked(qmsDb.getEvaluationStatistics).mockResolvedValueOnce(stats);

    const handler = await buildHandler(qmsApiRoutes, "/api/qms/evaluations/stats", "GET");
    const res = await handler(makeContext({ method: "GET", headers: AUTH_HEADERS }));

    expect(res.status).toBe(200);
    expect(res.body).toBe(stats);
  });
});

describe("GET /api/qms/capa — real data path", () => {
  test("200 returns getCapaRecords() result with forwarded filters", async () => {
    const fixture: Awaited<ReturnType<typeof qmsDb.getCapaRecords>> = {
      records: [makeCapa({ id: 1, capa_number: "C-1" })],
      total: 1,
    };
    vi.mocked(qmsDb.getCapaRecords).mockResolvedValueOnce(fixture);

    const handler = await buildHandler(qmsApiRoutes, "/api/qms/capa", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        headers: AUTH_HEADERS,
        query: { status: "open", severity: "major", assignedTo: "alice", limit: "10", offset: "2" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(fixture);
    expect(qmsDb.getCapaRecords).toHaveBeenCalledWith({
      limit: 10,
      offset: 2,
      status: "open",
      severity: "major",
      assignedTo: "alice",
    });
  });
});

describe("GET /api/qms/capa/:id — real data path", () => {
  test("200 returns { capa, actionItems } when CAPA exists", async () => {
    const capa = makeCapa({ id: 7, capa_number: "C-7", title: "X" });
    const items = [makeCapaActionItem({ id: 1, capa_id: 7, action_number: 1 })];
    vi.mocked(qmsDb.getCapaById).mockResolvedValueOnce(capa);
    vi.mocked(qmsDb.getCapaActionItems).mockResolvedValueOnce(items);

    const handler = await buildHandler(qmsApiRoutes, "/api/qms/capa/:id{[0-9]+}", "GET");
    const res = await handler(
      makeContext({ method: "GET", headers: AUTH_HEADERS, params: { id: "7" } }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ capa, actionItems: items });
    expect(qmsDb.getCapaById).toHaveBeenCalledWith(7);
    expect(qmsDb.getCapaActionItems).toHaveBeenCalledWith(7);
  });

  test("404 when CAPA not found (and action items not fetched)", async () => {
    vi.mocked(qmsDb.getCapaById).mockResolvedValueOnce(null);

    const handler = await buildHandler(qmsApiRoutes, "/api/qms/capa/:id{[0-9]+}", "GET");
    const res = await handler(
      makeContext({ method: "GET", headers: AUTH_HEADERS, params: { id: "999" } }),
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "CAPA not found" });
    expect(qmsDb.getCapaActionItems).not.toHaveBeenCalled();
  });
});

describe("POST /api/qms/capa — real data path", () => {
  test("200 returns the created CAPA from createCapaRecord()", async () => {
    const created = makeCapa({ id: 11, capa_number: "C-11", title: "Fix" });
    vi.mocked(qmsDb.createCapaRecord).mockResolvedValueOnce(created);

    const handler = await buildHandler(qmsApiRoutes, "/api/qms/capa", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        headers: AUTH_HEADERS,
        body: {
          title: "Fix",
          description: "desc",
          capaType: "corrective",
          severity: "major",
          assignedTo: "alice",
          targetDate: "2026-12-31",
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toBe(created);
    const passed = vi.mocked(qmsDb.createCapaRecord).mock.calls[0][0];
    expect(passed.title).toBe("Fix");
    expect(passed.capa_type).toBe("corrective");
    expect(passed.severity).toBe("major");
    expect(passed.status).toBe("open");
    expect(passed.priority).toBe("medium");
    expect(passed.assigned_to).toBe("alice");
    expect(passed.target_date).toBeInstanceOf(Date);
  });
});

describe("GET /api/qms/nc — real data path", () => {
  test("200 returns getNonconformances() result", async () => {
    const fixture: Awaited<ReturnType<typeof qmsDb.getNonconformances>> = {
      records: [makeNonconformance({ id: 1, nc_number: "NC-1" })],
      total: 1,
    };
    vi.mocked(qmsDb.getNonconformances).mockResolvedValueOnce(fixture);

    const handler = await buildHandler(qmsApiRoutes, "/api/qms/nc", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        headers: AUTH_HEADERS,
        query: { status: "open", severity: "minor" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(fixture);
    expect(qmsDb.getNonconformances).toHaveBeenCalledWith({
      limit: 50,
      offset: 0,
      status: "open",
      severity: "minor",
    });
  });
});

describe("POST /api/qms/nc — real data path", () => {
  test("200 returns the created nonconformance from createNonconformance()", async () => {
    const created = makeNonconformance({ id: 5, nc_number: "NC-5", title: "Issue" });
    vi.mocked(qmsDb.createNonconformance).mockResolvedValueOnce(created);

    const handler = await buildHandler(qmsApiRoutes, "/api/qms/nc", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        headers: AUTH_HEADERS,
        body: { title: "Issue", severity: "minor", ncType: "process" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toBe(created);
    const passed = vi.mocked(qmsDb.createNonconformance).mock.calls[0][0];
    expect(passed.title).toBe("Issue");
    expect(passed.severity).toBe("minor");
    expect(passed.status).toBe("open");
    expect(passed.detected_by).toBe("Admin");
  });
});

describe("GET /api/qms/training — real data path", () => {
  test("200 returns getTrainingRecords() result with isActive=true coercion", async () => {
    const fixture: Awaited<ReturnType<typeof qmsDb.getTrainingRecords>> = {
      records: [makeTrainingRecord({ id: 1, title: "Onboarding" })],
      total: 1,
    };
    vi.mocked(qmsDb.getTrainingRecords).mockResolvedValueOnce(fixture);

    const handler = await buildHandler(qmsApiRoutes, "/api/qms/training", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        headers: AUTH_HEADERS,
        query: { trainingType: "onboarding", isActive: "true", limit: "10" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(fixture);
    expect(qmsDb.getTrainingRecords).toHaveBeenCalledWith({
      limit: 10,
      offset: 0,
      trainingType: "onboarding",
      isActive: true,
    });
  });
});

describe("GET /api/qms/training/assignments — real data path", () => {
  test("200 returns getTrainingAssignments() result", async () => {
    const fixture: Awaited<ReturnType<typeof qmsDb.getTrainingAssignments>> = {
      records: [makeTrainingAssignment({ id: 1, employee_id: "E-1" })],
      total: 1,
    };
    vi.mocked(qmsDb.getTrainingAssignments).mockResolvedValueOnce(fixture);

    const handler = await buildHandler(qmsApiRoutes, "/api/qms/training/assignments", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        headers: AUTH_HEADERS,
        query: { employeeId: "E-1", trainingId: "T-2", status: "assigned" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(fixture);
    expect(qmsDb.getTrainingAssignments).toHaveBeenCalledWith({
      limit: 50,
      offset: 0,
      employeeId: "E-1",
      trainingId: "T-2",
      status: "assigned",
    });
  });
});

describe("GET /api/qms/framework — real data path", () => {
  test("200 returns getActiveFramework() when one exists", async () => {
    const fw = makeFramework({ id: "fw-1", name: "Active Framework", version: "v1" });
    vi.mocked(qmsDb.getActiveFramework).mockResolvedValueOnce(fw);

    const handler = await buildHandler(qmsApiRoutes, "/api/qms/framework", "GET");
    const res = await handler(makeContext({ method: "GET", headers: AUTH_HEADERS }));

    expect(res.status).toBe(200);
    expect(res.body).toBe(fw);
  });

  test("200 falls back to getDefaultFramework() when no active row", async () => {
    vi.mocked(qmsDb.getActiveFramework).mockResolvedValueOnce(null);

    const handler = await buildHandler(qmsApiRoutes, "/api/qms/framework", "GET");
    const res = await handler(makeContext({ method: "GET", headers: AUTH_HEADERS }));

    expect(res.status).toBe(200);
    expect(res.body).toBeTruthy();
    expect(typeof res.body.name).toBe("string");
    expect(Array.isArray(res.body.dimensions)).toBe(true);
    expect(res.body.dimensions.length).toBeGreaterThan(0);
  });
});
