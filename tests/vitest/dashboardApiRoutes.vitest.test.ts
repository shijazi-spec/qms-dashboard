/**
 * Vitest happy-path tests for src/mastra/routes/dashboardApiRoutes.ts.
 *
 * Stubs ../../utils/database (the data layer the routes lazily import) and
 * ../../utils/eventLogsDatabase (whose module-load IIFE would otherwise hit
 * the real pool transitively through the rbac/auth chain) so the suite is
 * fully hermetic. The pg-pool, Inngest dispatch, seed-users aggregator, and
 * Zoho/CRM endpoints are out of scope for this real-data happy-path suite.
 *
 * Run via:  npx vitest run tests/vitest/dashboardApiRoutes.vitest.test.ts
 */

const TEST_ADMIN_KEY = "vitest-dashboard-admin-key-2026";
process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;

import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../src/utils/database", () => ({
  getDashboardData: vi.fn(),
  getLatestAuditResult: vi.fn(),
  getAuditHistory: vi.fn(),
  getActiveScorecardsAll: vi.fn(),
  getActiveGovernanceDocument: vi.fn(),
  getActiveScorecard: vi.fn(),
  pool: { query: vi.fn() },
}));

vi.mock("../../src/utils/eventLogsDatabase", () => ({
  initializeEventLogsTable: vi.fn(async () => undefined),
  logEvent: vi.fn(async () => ({ id: 1 })),
  redactSensitiveDeep: vi.fn(<T,>(x: T) => x),
  redactSecretLikeStrings: vi.fn(<T,>(x: T) => x),
  getActionViewers: vi.fn(async () => []),
  getActionViewersBatch: vi.fn(async () => ({})),
}));

import { dashboardApiRoutes } from "../../src/mastra/routes/dashboardApiRoutes";
import type {
  GovernanceDocument,
  QualityAuditResult,
  QualityScorecard,
} from "../../src/utils/database";
import { buildHandler, makeContext } from "../_helpers/fakeContext";

const ADMIN_HEADERS = { "X-Admin-Key": TEST_ADMIN_KEY };

let db: typeof import("../../src/utils/database");

beforeEach(async () => {
  process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
  db = await import("../../src/utils/database");
  vi.clearAllMocks();
});

function makeAudit(overrides: Partial<QualityAuditResult> = {}): QualityAuditResult {
  return {
    id: 1,
    audit_date: new Date("2026-04-22"),
    total_records_audited: 100,
    total_issues_found: 5,
    people_score: 90,
    process_score: 92,
    governance_score: 95,
    overall_score: 92,
    ...overrides,
  };
}

function makeGovernance(overrides: Partial<GovernanceDocument> = {}): GovernanceDocument {
  return {
    id: 1,
    name: "QMS Manual",
    document_type: "policy",
    version: "v3",
    is_active: true,
    ...overrides,
  };
}

function makeScorecard(overrides: Partial<QualityScorecard> = {}): QualityScorecard {
  return {
    id: 1,
    name: "SDR Scorecard",
    dimensions: { people: [], process: [], governance: [] },
    is_active: true,
    ...overrides,
  };
}

type ErrorCase = {
  name: string;
  path: string;
  method: string;
  getMock: (db: typeof import("../../src/utils/database")) => ReturnType<typeof vi.fn>;
  errorBody: { error: string };
  body?: unknown;
  params?: Record<string, string>;
  query?: Record<string, string>;
};

const ERROR_CASES: ErrorCase[] = [
  {
    name: "GET /api/dashboard",
    path: "/api/dashboard",
    method: "GET",
    getMock: (db) => db.getDashboardData as unknown as ReturnType<typeof vi.fn>,
    errorBody: { error: "Failed to fetch dashboard data" },
  },
  {
    name: "GET /api/audit/latest",
    path: "/api/audit/latest",
    method: "GET",
    getMock: (db) => db.getLatestAuditResult as unknown as ReturnType<typeof vi.fn>,
    errorBody: { error: "Failed to fetch latest audit" },
  },
  {
    name: "GET /api/audit/history",
    path: "/api/audit/history",
    method: "GET",
    getMock: (db) => db.getAuditHistory as unknown as ReturnType<typeof vi.fn>,
    errorBody: { error: "Failed to fetch audit history" },
  },
  {
    name: "GET /api/dashboard/quality-trend",
    path: "/api/dashboard/quality-trend",
    method: "GET",
    getMock: (db) => db.pool.query as unknown as ReturnType<typeof vi.fn>,
    errorBody: { error: "Failed to fetch quality trend" },
  },
  {
    name: "GET /api/dashboard/issues-category-trend",
    path: "/api/dashboard/issues-category-trend",
    method: "GET",
    getMock: (db) => db.pool.query as unknown as ReturnType<typeof vi.fn>,
    errorBody: { error: "Failed to fetch category trend" },
  },
  {
    name: "GET /api/scorecards",
    path: "/api/scorecards",
    method: "GET",
    getMock: (db) => db.getActiveScorecardsAll as unknown as ReturnType<typeof vi.fn>,
    errorBody: { error: "Failed to fetch scorecards" },
  },
  {
    name: "GET /api/governance",
    path: "/api/governance",
    method: "GET",
    getMock: (db) => db.getActiveGovernanceDocument as unknown as ReturnType<typeof vi.fn>,
    errorBody: { error: "Failed to fetch governance document" },
  },
  {
    name: "GET /api/scorecard",
    path: "/api/scorecard",
    method: "GET",
    getMock: (db) => db.getActiveScorecard as unknown as ReturnType<typeof vi.fn>,
    errorBody: { error: "Failed to fetch scorecard" },
  },
  {
    name: "GET /api/audit/recommendations",
    path: "/api/audit/recommendations",
    method: "GET",
    getMock: (db) => db.getLatestAuditResult as unknown as ReturnType<typeof vi.fn>,
    errorBody: { error: "Failed to fetch recommendations" },
  },
];

describe("error-path coverage — every db-backed dashboard route returns deterministic 500 body", () => {
  test.each(ERROR_CASES)(
    "$name returns 500 with exact error body when its dependency rejects",
    async ({ path, method, getMock, errorBody, body, params, query }) => {
      const fn = getMock(db);
      fn.mockRejectedValueOnce(new Error("simulated db failure"));
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const handler = await buildHandler(dashboardApiRoutes, path, method);
      const res = await handler(
        makeContext({ method, headers: ADMIN_HEADERS, body, params, query }),
      );

      expect(res.status).toBe(500);
      expect(res.body).toEqual(errorBody);
      errSpy.mockRestore();
    },
  );
});

describe("GET /api/dashboard", () => {
  test("200 returns getDashboardData() result directly", async () => {
    // Partial fixture covering only the fields this assertion needs; cast to
    // the full return shape since this test asserts handler plumbing rather
    // than dashboard payload schema fidelity.
    const data = {
      latestAudit: makeAudit(),
      auditHistory: [makeAudit({ id: 2 })],
      governance: makeGovernance(),
      governanceDocs: [makeGovernance()],
      scorecard: makeScorecard(),
      trends: { overall: [], people: [], process: [], governance: [] },
    } as unknown as Awaited<ReturnType<typeof db.getDashboardData>>;
    vi.mocked(db.getDashboardData).mockResolvedValueOnce(data);

    const handler = await buildHandler(dashboardApiRoutes, "/api/dashboard", "GET");
    const res = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));

    expect(res.status).toBe(200);
    expect(res.body).toBe(data);
  });

  test("500 with deterministic body when getDashboardData throws", async () => {
    vi.mocked(db.getDashboardData).mockRejectedValueOnce(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const handler = await buildHandler(dashboardApiRoutes, "/api/dashboard", "GET");
    const res = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to fetch dashboard data" });
    errSpy.mockRestore();
  });
});

describe("GET /api/audit/latest", () => {
  test("200 returns the latest audit when present", async () => {
    const result = makeAudit({ id: 11, overall_score: 92 });
    vi.mocked(db.getLatestAuditResult).mockResolvedValueOnce(result);

    const handler = await buildHandler(dashboardApiRoutes, "/api/audit/latest", "GET");
    const res = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));

    expect(res.status).toBe(200);
    expect(res.body).toBe(result);
  });

  test("404 when no audit result is present", async () => {
    vi.mocked(db.getLatestAuditResult).mockResolvedValueOnce(null);

    const handler = await buildHandler(dashboardApiRoutes, "/api/audit/latest", "GET");
    const res = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: "No audit results found" });
  });
});

describe("GET /api/audit/history", () => {
  test("200 forwards the limit query param to getAuditHistory()", async () => {
    const history = [makeAudit({ id: 1 }), makeAudit({ id: 2 })];
    vi.mocked(db.getAuditHistory).mockResolvedValueOnce(history);

    const handler = await buildHandler(dashboardApiRoutes, "/api/audit/history", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        headers: ADMIN_HEADERS,
        query: { limit: "5" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toBe(history);
    // The route was extended to forward an optional date-range filter as a
    // second argument (`{ startDate, endDate }`); the assertion only cares
    // about the `limit` here, so we accept any second-arg shape.
    expect(db.getAuditHistory).toHaveBeenCalledWith(5, expect.anything());
  });

  test("200 defaults limit to 20 when query param absent", async () => {
    vi.mocked(db.getAuditHistory).mockResolvedValueOnce([]);

    const handler = await buildHandler(dashboardApiRoutes, "/api/audit/history", "GET");
    await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));

    // Same date-range second-arg as above — only the default limit is being
    // asserted here.
    expect(db.getAuditHistory).toHaveBeenCalledWith(20, expect.anything());
  });
});

describe("GET /api/scorecards", () => {
  test("200 returns { success, scorecards, count } from getActiveScorecardsAll()", async () => {
    const scorecards = [makeScorecard({ id: 1, name: "SDR" }), makeScorecard({ id: 2, name: "AE" })];
    vi.mocked(db.getActiveScorecardsAll).mockResolvedValueOnce(scorecards);

    const handler = await buildHandler(dashboardApiRoutes, "/api/scorecards", "GET");
    const res = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, scorecards, count: 2 });
  });
});

describe("GET /api/governance", () => {
  test("200 returns the active governance document when present", async () => {
    const doc = makeGovernance({ id: 1, version: "v3", name: "QMS Manual" });
    vi.mocked(db.getActiveGovernanceDocument).mockResolvedValueOnce(doc);

    const handler = await buildHandler(dashboardApiRoutes, "/api/governance", "GET");
    const res = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));

    expect(res.status).toBe(200);
    expect(res.body).toBe(doc);
  });

  test("404 when no governance document is configured", async () => {
    vi.mocked(db.getActiveGovernanceDocument).mockResolvedValueOnce(null);

    const handler = await buildHandler(dashboardApiRoutes, "/api/governance", "GET");
    const res = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: "No governance document found" });
  });
});

describe("GET /api/scorecard", () => {
  test("200 forwards crm_module / team_name query params to getActiveScorecard()", async () => {
    const scorecard = makeScorecard({ id: 7, crm_module: "Leads", team_name: "SDR" });
    vi.mocked(db.getActiveScorecard).mockResolvedValueOnce(scorecard);

    const handler = await buildHandler(dashboardApiRoutes, "/api/scorecard", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        headers: ADMIN_HEADERS,
        query: { crm_module: "Leads", team_name: "SDR" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toBe(scorecard);
    expect(db.getActiveScorecard).toHaveBeenCalledWith("Leads", "SDR");
  });

  test("404 when no scorecard matches", async () => {
    vi.mocked(db.getActiveScorecard).mockResolvedValueOnce(null);

    const handler = await buildHandler(dashboardApiRoutes, "/api/scorecard", "GET");
    const res = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: "No scorecard found" });
    expect(db.getActiveScorecard).toHaveBeenCalledWith(null, null);
  });
});

describe("GET /api/audit/recommendations", () => {
  test("200 maps issues_by_category items into recommendation rows with priority", async () => {
    const result = makeAudit({
      audit_date: new Date("2026-04-22"),
      issues_by_category: [
        { module: "Leads", count: 7, issueType: "Missing Email" },
        { module: "Deals", count: 3, issueType: "Missing Stage" },
      ],
    });
    vi.mocked(db.getLatestAuditResult).mockResolvedValueOnce(result);

    const handler = await buildHandler(dashboardApiRoutes, "/api/audit/recommendations", "GET");
    const res = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));

    expect(res.status).toBe(200);
    const body = res.body as {
      generatedAt: string | Date;
      recommendations: Array<{ module: string; count: number; description: string; priority: string }>;
    };
    expect(body.generatedAt).toEqual(new Date("2026-04-22"));
    expect(body.recommendations).toEqual([
      { module: "Leads", count: 7, description: "Missing Email", priority: "high" },
      { module: "Deals", count: 3, description: "Missing Stage", priority: "medium" },
    ]);
  });

  test("200 returns { recommendations: [] } when no audit result is present", async () => {
    vi.mocked(db.getLatestAuditResult).mockResolvedValueOnce(null);

    const handler = await buildHandler(dashboardApiRoutes, "/api/audit/recommendations", "GET");
    const res = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ recommendations: [] });
  });
});

describe("GET /api/integrations/status", () => {
  const ENV_KEYS = [
    "ZOHO_CLIENT_ID",
    "ZOHO_CLIENT_SECRET",
    "ZOHO_REFRESH_TOKEN",
    "ZOHO_ACCESS_TOKEN",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_EMAIL",
  ] as const;

  function withEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>, fn: () => Promise<void>) {
    const original: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) original[k] = process.env[k];
    return (async () => {
      try {
        for (const [k, v] of Object.entries(values)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
        await fn();
      } finally {
        for (const k of ENV_KEYS) {
          if (original[k] === undefined) delete process.env[k];
          else process.env[k] = original[k];
        }
      }
    })();
  }

  test("200 reports zoho/googleCalendar/email connected when env vars are set", async () => {
    await withEnv(
      {
        ZOHO_CLIENT_ID: "cid",
        ZOHO_CLIENT_SECRET: "csec",
        ZOHO_REFRESH_TOKEN: "rtok",
        ZOHO_ACCESS_TOKEN: undefined,
        GOOGLE_CLIENT_ID: "google-cid",
        GOOGLE_CLIENT_EMAIL: undefined,
      },
      async () => {
        const handler = await buildHandler(dashboardApiRoutes, "/api/integrations/status", "GET");
        const res = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          zoho: { connected: true, message: "Connected" },
          googleCalendar: { connected: true, message: "Connected" },
          email: { connected: true, message: "Replit Mail configured" },
        });
      },
    );
  });

  test("200 reports zoho + google as disconnected when no env vars are set", async () => {
    await withEnv(
      {
        ZOHO_CLIENT_ID: undefined,
        ZOHO_CLIENT_SECRET: undefined,
        ZOHO_REFRESH_TOKEN: undefined,
        ZOHO_ACCESS_TOKEN: undefined,
        GOOGLE_CLIENT_ID: undefined,
        GOOGLE_CLIENT_EMAIL: undefined,
      },
      async () => {
        const handler = await buildHandler(dashboardApiRoutes, "/api/integrations/status", "GET");
        const res = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          zoho: { connected: false, message: "Not configured" },
          googleCalendar: { connected: false, message: "Not configured" },
          email: { connected: true, message: "Replit Mail configured" },
        });
      },
    );
  });
});
