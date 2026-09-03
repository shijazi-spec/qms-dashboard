/**
 * Vitest coverage for the heavier dashboard endpoints intentionally skipped by
 * `dashboardApiRoutes.vitest.test.ts`:
 *
 *   - GET  /api/dashboard/quality-trend           (3x pool.query)
 *   - GET  /api/dashboard/issues-category-trend   (1x pool.query)
 *   - GET  /api/agents/performance                (data/* aggregator + cache)
 *   - GET  /api/crm/data                          (utils/CRMProviderCRM)
 *   - POST /api/crm/enrich                        (utils/duplicateRadarDatabase)
 *   - POST /api/audit/trigger                     (inngest dispatch + 60s rate-limit)
 *
 * Mocks the underlying database pool, data layer, seed-users aliases, CRMProvider
 * CRM, duplicate-radar lookups, the direct-audit runner, and the Inngest
 * client so the suite is fully hermetic.
 *
 * Run via:  npx vitest run tests/vitest/dashboardApiRoutesExtras.vitest.test.ts
 */

const TEST_ADMIN_KEY = "vitest-dashboard-extras-admin-key-2026";
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
  redactSecretLikeStrings: <REDACTED_SECRET>
  getActionViewers: vi.fn(async () => []),
  getActionViewersBatch: vi.fn(async () => ({})),
}));

vi.mock("../../src/utils/CRMProviderCRM", () => ({
  fetchCRMProviderRecords: vi.fn(),
  getCRMProviderConnectionStatus: vi.fn(),
}));

vi.mock("../../src/utils/duplicateRadarDatabase", () => ({
  lookupRecordsByCRMProviderIds: vi.fn(),
  runLiveQualityCheck: vi.fn(),
}));

vi.mock("../../src/utils/directAuditRunner", () => ({
  runDirectAudit: vi.fn(async () => undefined),
}));

vi.mock("../../src/mastra/inngest", () => ({
  inngest: { send: vi.fn(async () => ({ ids: ["evt_1"] })) },
  inngestServe: () => async () => ({ status: 200, body: "" }),
}));

vi.mock("../../src/data", () => ({
  getLeads: vi.fn(),
  getDeals: vi.fn(),
  getUsers: vi.fn(),
  getDataMode: vi.fn(() => "MOCK"),
  getLeadsWithSeparateFilters: vi.fn(),
  getDealsWithSeparateFilters: vi.fn(),
}));

vi.mock("../../src/data/seedUsers", () => ({
  NAME_ALIASES: { rayan: "Rayan Saleh" },
}));

import { dashboardApiRoutes } from "../../src/mastra/routes/dashboardApiRoutes";
import { buildHandler, makeContext } from "../_helpers/fakeContext";

const ADMIN_HEADERS = { "X-Admin-Key": TEST_ADMIN_KEY };

let db: typeof import("../../src/utils/database");
let CRMProvider: typeof import("../../src/utils/CRMProviderCRM");
let radar: typeof import("../../src/utils/duplicateRadarDatabase");
let audit: typeof import("../../src/utils/directAuditRunner");
let inngestMod: typeof import("../../src/mastra/inngest");
let dataMod: typeof import("../../src/data");

beforeEach(async () => {
  process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
  db = await import("../../src/utils/database");
  CRMProvider = await import("../../src/utils/CRMProviderCRM");
  radar = await import("../../src/utils/duplicateRadarDatabase");
  audit = await import("../../src/utils/directAuditRunner");
  inngestMod = await import("../../src/mastra/inngest");
  dataMod = await import("../../src/data");
  vi.clearAllMocks();
});

describe("GET /api/dashboard/quality-trend", () => {
  test("200 aggregates audits + duplicate scans + appends live snapshot", async () => {
    const auditDate = new Date("2026-04-22T00:00:00Z");
    const scanDate = new Date("2026-04-21T00:00:00Z");
    const liveDate = new Date("2026-04-23T00:00:00Z");
    vi.mocked(db.pool.query)
      .mockResolvedValueOnce({
        rows: [
          {
            audit_date: auditDate,
            compliance_pct: "92.5",
            records_with_issues: "5",
            total_records_audited: "100",
          },
        ],
      } as any)
      .mockResolvedValueOnce({
        rows: [
          {
            completed_at: scanDate,
            total_clusters_found: "12",
            estimated_pipeline_inflation: "2500.5",
          },
        ],
      } as any)
      .mockResolvedValueOnce({
        rows: [{ clusters: "3", pipeline: "777", last_seen: liveDate }],
      } as any);

    const handler = await buildHandler(
      dashboardApiRoutes,
      "/api/dashboard/quality-trend",
      "GET",
    );
    const res = await handler(
      makeContext({ method: "GET", headers: ADMIN_HEADERS, query: { limit: "30" } }),
    );

    expect(res.status).toBe(200);
    const body = res.body as {
      audits: Array<{ date: Date; compliance_pct: number; records_with_issues: number; total_records_audited: number }>;
      duplicates: Array<{ date: Date; clusters: number; pipeline_inflation_sar: number }>;
    };
    expect(body.audits).toEqual([
      {
        date: auditDate,
        compliance_pct: 92.5,
        records_with_issues: 5,
        total_records_audited: 100,
      },
    ]);
    expect(body.duplicates).toHaveLength(2);
    expect(body.duplicates[0]).toEqual({
      date: scanDate,
      clusters: 12,
      pipeline_inflation_sar: 2500.5,
    });
    expect(body.duplicates[1]).toEqual({
      date: liveDate,
      clusters: 3,
      pipeline_inflation_sar: 777,
    });
    // limit query param is clamped between 1 and 90 and forwarded to the
    // first two parameterised queries.
    expect(db.pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("FROM quality_audit_results"),
      [30],
    );
    expect(db.pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("FROM duplicate_detection_logs"),
      [30],
    );
  });

  test("200 still succeeds when duplicate-scan + live snapshot queries throw", async () => {
    vi.mocked(db.pool.query)
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockRejectedValueOnce(new Error("duplicate_detection_logs missing"))
      .mockRejectedValueOnce(new Error("duplicate_clusters missing"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const handler = await buildHandler(
      dashboardApiRoutes,
      "/api/dashboard/quality-trend",
      "GET",
    );
    const res = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ audits: [], duplicates: [] });
    warnSpy.mockRestore();
  });

  test("500 when the primary audits query fails", async () => {
    vi.mocked(db.pool.query).mockRejectedValueOnce(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const handler = await buildHandler(
      dashboardApiRoutes,
      "/api/dashboard/quality-trend",
      "GET",
    );
    const res = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to fetch quality trend" });
    errSpy.mockRestore();
  });
});

describe("GET /api/dashboard/issues-category-trend", () => {
  test("200 collapses issues_by_category arrays and objects into per-module series", async () => {
    vi.mocked(db.pool.query).mockResolvedValueOnce({
      rows: [
        {
          audit_date: "2026-04-20",
          issues_by_category: [
            { module: "Leads", count: 3 },
            { module: "Deals", count: 2 },
            { module: "Leads", count: 1 },
          ],
        },
        {
          audit_date: "2026-04-21",
          issues_by_category: { Contacts: 4, Accounts: "5" },
        },
        {
          audit_date: "2026-04-22",
          issues_by_category: '{"Leads": 7}',
        },
      ],
    } as any);

    const handler = await buildHandler(
      dashboardApiRoutes,
      "/api/dashboard/issues-category-trend",
      "GET",
    );
    const res = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      dates: ["2026-04-20", "2026-04-21", "2026-04-22"],
      series: {
        Deals: [2, 0, 0],
        Contacts: [0, 4, 0],
        Leads: [4, 0, 7],
        Accounts: [0, 5, 0],
      },
    });
  });

  test("500 when the underlying pool.query throws", async () => {
    vi.mocked(db.pool.query).mockRejectedValueOnce(new Error("boom"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const handler = await buildHandler(
      dashboardApiRoutes,
      "/api/dashboard/issues-category-trend",
      "GET",
    );
    const res = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to fetch category trend" });
    errSpy.mockRestore();
  });
});

describe("GET /api/agents/performance", () => {
  const baseLead = {
    id: "L1",
    Owner: "u1",
    Email: "<REDACTED_EMAIL>",
    Lead_Source: "Web",
    Lead_Status: "New",
  } as any;
  const issueLead = {
    id: "L2",
    Owner: "u1",
    Email: "",
    Lead_Source: "",
    Lead_Status: "",
    Created_Time: "2026-04-22",
  } as any;
  const baseDeal = {
    id: "D1",
    Owner: "u1",
    Deal_Name: "Big Deal",
    Stage: "Won",
    Amount: 1000,
  } as any;

  function setupHappyMocks() {
    vi.mocked(dataMod.getLeadsWithSeparateFilters).mockResolvedValue({
      leads: [baseLead, issueLead],
      coverage: {
        totalRecordsInCRM: 2,
        recordsInDateRange: 2,
        recordsAudited: 2,
        recordsExcluded: 0,
        exclusionReason: "No date filter applied",
        dateRangeApplied: null,
        separateFiltersApplied: {
          created: { start: null, end: null },
          modified: { start: null, end: null },
        },
      },
    } as any);
    vi.mocked(dataMod.getDealsWithSeparateFilters).mockResolvedValue({
      deals: [baseDeal],
      coverage: {
        totalRecordsInCRM: 1,
        recordsInDateRange: 1,
        recordsAudited: 1,
        recordsExcluded: 0,
        exclusionReason: "No date filter applied",
        dateRangeApplied: null,
        separateFiltersApplied: {
          created: { start: null, end: null },
          modified: { start: null, end: null },
        },
      },
    } as any);
    vi.mocked(dataMod.getUsers).mockResolvedValue([
      { id: "u1", name: "Alice", team: "SDR", role: "AE", status: "Active" },
    ] as any);
  }

  test("200 returns aggregated agents with score and caches the no-filter response", async () => {
    setupHappyMocks();

    const handler = await buildHandler(
      dashboardApiRoutes,
      "/api/agents/performance",
      "GET",
    );

    const first = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));
    expect(first.status).toBe(200);
    const body = first.body as {
      success: boolean;
      cached: boolean;
      agents: Array<{ id: string; name: string; recordsAudited: number; score: number; issues: any }>;
      ownerIssueDetails: Array<{ recordId: string; issue: string }>;
      totalLeads: number;
      totalDeals: number;
    };
    expect(body.success).toBe(true);
    expect(body.cached).toBe(false);
    expect(body.totalLeads).toBe(2);
    expect(body.totalDeals).toBe(1);
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]).toMatchObject({ id: "u1", name: "Alice", recordsAudited: 3 });
    expect(typeof body.agents[0].score).toBe("number");
    expect(body.ownerIssueDetails.map((r) => r.issue)).toEqual([
      "Missing Email",
      "Missing Lead Source",
      "Missing Lead Status",
    ]);

    // Reset upstream mocks; the cache should make the second call skip them.
    vi.mocked(dataMod.getLeadsWithSeparateFilters).mockClear();
    vi.mocked(dataMod.getDealsWithSeparateFilters).mockClear();
    vi.mocked(dataMod.getUsers).mockClear();

    const second = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));
    expect(second.status).toBe(200);
    expect((second.body as any).cached).toBe(true);
    expect(dataMod.getLeadsWithSeparateFilters).not.toHaveBeenCalled();
    expect(dataMod.getDealsWithSeparateFilters).not.toHaveBeenCalled();
  });

  test("400 rejects malformed createdStart query param", async () => {
    setupHappyMocks();
    const handler = await buildHandler(
      dashboardApiRoutes,
      "/api/agents/performance",
      "GET",
    );
    const res = await handler(
      makeContext({
        method: "GET",
        headers: ADMIN_HEADERS,
        query: { createdStart: "not-a-date" },
      }),
    );
    expect(res.status).toBe(400);
    expect((res.body as any).success).toBe(false);
    expect((res.body as any).error).toMatch(/Invalid date format/);
  });

  test("500 when upstream data fetch throws", async () => {
    vi.mocked(dataMod.getLeadsWithSeparateFilters).mockRejectedValueOnce(
      new Error("upstream fail"),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const handler = await buildHandler(
      dashboardApiRoutes,
      "/api/agents/performance",
      "GET",
    );
    const res = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      success: false,
      error: "Failed to fetch agent performance",
      agents: [],
    });
    errSpy.mockRestore();
  });
});

describe("GET /api/crm/data", () => {
  test("400 when CRMProvider is not configured", async () => {
    // rateLimited + cooldownMsRemaining were added to the
    // getCRMProviderConnectionStatus return type by the CRMProvider 429 reliability
    // work (commit 2adb025) — keep these mocks complete so the typecheck
    // workflow stays green.
    vi.mocked(CRMProvider.getCRMProviderConnectionStatus).mockReturnValue({
      configured: false,
      autoRefresh: false,
      tokenCached: <REDACTED_SECRET>
      tokenExpired: <REDACTED_SECRET>
      rateLimited: false,
      cooldownMsRemaining: 0,
      message: "CRM integration not configured.",
    });

    const handler = await buildHandler(dashboardApiRoutes, "/api/crm/data", "GET");
    const res = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: "CRMProvider CRM not configured",
      message: "CRM integration not configured.",
    });
    expect(CRMProvider.fetchCRMProviderRecords).not.toHaveBeenCalled();
  });

  test("200 returns flattened CRMProvider records when configured", async () => {
    vi.mocked(CRMProvider.getCRMProviderConnectionStatus).mockReturnValue({
      configured: true,
      autoRefresh: true,
      tokenCached: <REDACTED_SECRET>
      tokenExpired: <REDACTED_SECRET>
      rateLimited: false,
      cooldownMsRemaining: 0,
      message: "ok",
    });
    vi.mocked(CRMProvider.fetchCRMProviderRecords).mockResolvedValueOnce([
      {
        id: "z1",
        owner: "u1",
        createdTime: "2026-04-22",
        modifiedTime: "2026-04-22",
        <REDACTED_SCHEME> { Email: "<REDACTED_EMAIL>", Stage: "Won" },
      },
    ] as any);

    const handler = await buildHandler(dashboardApiRoutes, "/api/crm/data", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        headers: ADMIN_HEADERS,
        query: { module: "Deals", page: "2", per_page: "25" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      module: "Deals",
      page: 2,
      perPage: 25,
      count: 1,
      records: [
        {
          id: "z1",
          owner: "u1",
          createdTime: "2026-04-22",
          modifiedTime: "2026-04-22",
          Email: "<REDACTED_EMAIL>",
          Stage: "Won",
        },
      ],
    });
    expect(CRMProvider.fetchCRMProviderRecords).toHaveBeenCalledWith("Deals", { page: 2, perPage: 25 });
  });

  test("500 when fetchCRMProviderRecords throws", async () => {
    vi.mocked(CRMProvider.getCRMProviderConnectionStatus).mockReturnValue({
      configured: true,
      autoRefresh: true,
      tokenCached: <REDACTED_SECRET>
      tokenExpired: <REDACTED_SECRET>
      rateLimited: false,
      cooldownMsRemaining: 0,
      message: "ok",
    });
    vi.mocked(CRMProvider.fetchCRMProviderRecords).mockRejectedValueOnce(new Error("CRMProvider 500"));

    const handler = await buildHandler(dashboardApiRoutes, "/api/crm/data", "GET");
    const res = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: "Failed to fetch CRM data" });
  });
});

describe("POST /api/crm/enrich", () => {
  test("200 maps cluster + quality lookups onto the supplied record ids", async () => {
    vi.mocked(radar.lookupRecordsByCRMProviderIds).mockResolvedValueOnce({
      z1: { clusterId: 99, members: 3 },
    } as any);
    vi.mocked(radar.runLiveQualityCheck).mockResolvedValueOnce({
      z2: { issues: ["Missing Email"] },
    } as any);

    const handler = await buildHandler(dashboardApiRoutes, "/api/crm/enrich", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        headers: ADMIN_HEADERS,
        body: { records: [{ id: "z1" }, { id: "z2" }, { id: null }] },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      enrichment: {
        z1: { cluster: { clusterId: 99, members: 3 }, quality: null },
        z2: { cluster: null, quality: { issues: ["Missing Email"] } },
      },
    });
    expect(radar.lookupRecordsByCRMProviderIds).toHaveBeenCalledWith(["z1", "z2"]);
    expect(radar.runLiveQualityCheck).toHaveBeenCalledWith([
      { id: "z1" },
      { id: "z2" },
      { id: null },
    ]);
  });

  test("500 when downstream enrichment fails", async () => {
    vi.mocked(radar.lookupRecordsByCRMProviderIds).mockRejectedValueOnce(new Error("nope"));
    vi.mocked(radar.runLiveQualityCheck).mockResolvedValueOnce({} as any);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const handler = await buildHandler(dashboardApiRoutes, "/api/crm/enrich", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        headers: ADMIN_HEADERS,
        body: { records: [{ id: "z1" }] },
      }),
    );

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: "Failed to enrich records" });
    errSpy.mockRestore();
  });
});

describe("POST /api/audit/trigger", () => {
  test("200 dispatches inngest event + 429 on the immediate follow-up call (rate-limit)", async () => {
    const handler = await buildHandler(dashboardApiRoutes, "/api/audit/trigger", "POST");

    const first = await handler(
      makeContext({
        method: "POST",
        headers: ADMIN_HEADERS,
        body: {
          dateFilters: {
            created: { start: "2026-04-01", end: "2026-04-30" },
            modified: { start: null, end: null },
          },
        },
      }),
    );
    expect(first.status).toBe(200);
    expect((first.body as any).success).toBe(true);
    expect(inngestMod.inngest.send).toHaveBeenCalledTimes(1);
    const sendArg = vi.mocked(inngestMod.inngest.send).mock.calls[0][0] as any;
    expect(sendArg.name).toBe("HostingPlatform/cron.trigger");
    expect(sendArg.data.workflowId).toBe("quality-audit-workflow");
    expect(sendArg.data.manualTrigger).toBe(true);
    expect(sendArg.data.dateFilters.created).toEqual({
      start: "2026-04-01",
      end: "2026-04-30",
    });

    const second = await handler(
      makeContext({ method: "POST", headers: ADMIN_HEADERS, body: {} }),
    );
    expect(second.status).toBe(429);
    expect((second.body as any).success).toBe(false);
    expect((second.body as any).error).toMatch(/Please wait/);
  });

  test("200 still succeeds when inngest.send rejects (logged + direct execution continues)", async () => {
    vi.mocked(inngestMod.inngest.send).mockRejectedValueOnce(new Error("inngest down"));

    const handler = await buildHandler(dashboardApiRoutes, "/api/audit/trigger", "POST");
    const res = await handler(
      makeContext({ method: "POST", headers: ADMIN_HEADERS, body: {} }),
    );

    expect(res.status).toBe(200);
    expect((res.body as any).success).toBe(true);
    // The background runDirectAudit IIFE is fire-and-forget; await a microtask
    // tick so it has a chance to invoke the mocked runner.
    await new Promise((r) => setImmediate(r));
    expect(audit.runDirectAudit).toHaveBeenCalled();
  });
});
