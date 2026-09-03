/**
 * Vitest happy-path tests for src/mastra/routes/callIntelligenceRoutes.ts.
 *
 * `requireAdminOrKey` and `requireRoleOrKey` both accept a valid admin API
 * key, so we set ADMIN_API_KEY in the environment and pass X-Admin-Key in
 * request headers — no rbacMiddleware mock is needed.
 *
 * The dynamic ESM import of `../../utils/callIntelligenceDb` is stubbed so
 * the tests are deterministic and need no live database or AI services.
 *
 * Routes that call the LLMProvider SDK (e.g. /api/calls/:callId/analyze) are
 * excluded from this suite; they are covered by a dedicated AI-integration
 * test when the model is available.
 *
 * Run via:  npx vitest run tests/vitest/callIntelligenceRoutes.vitest.test.ts
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { callIntelligenceRoutes } from "../../src/mastra/routes/callIntelligenceRoutes";
import { buildHandler, makeContext } from "../_helpers/fakeContext";
import {
  makeCallRecord,
  makeCallTranscript,
  makeCallAnalysis,
  makeCallQAScore,
  makeCallCompliance,
} from "../_helpers/fixtures";

vi.mock("../../src/utils/callIntelligenceDb", () => ({
  initCallIntelligenceTables: vi.fn(async () => undefined),
  createCallRecord: vi.fn(),
  getCallRecords: vi.fn(),
  getCallRecordById: vi.fn(),
  getCallWithFullAnalysis: vi.fn(),
  getCallAnalyticsSummary: vi.fn(),
  getComplianceRecords: vi.fn(),
  getTranscriptByCallId: vi.fn(),
  saveTranscript: vi.fn(),
  saveCallAnalysis: vi.fn(),
  saveQAScore: vi.fn(),
  getComplianceByCallId: vi.fn(),
  updateCallRecord: vi.fn(),
  saveMeetingMOM: vi.fn(),
  getMOMByEventId: vi.fn(),
  getActiveSDRScorecard: vi.fn(),
  getCallRecordByCallId: vi.fn(),
  createOrUpdateQAScore: vi.fn(),
}));

const ADMIN_KEY = "<REDACTED_SECRET>";
const AUTH_HEADERS = { "X-Admin-Key": ADMIN_KEY };

let callDb: typeof import("../../src/utils/callIntelligenceDb");

beforeEach(async () => {
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  callDb = await import("../../src/utils/callIntelligenceDb");
  vi.clearAllMocks();
  vi.mocked(callDb.initCallIntelligenceTables).mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env.ADMIN_API_KEY;
});

describe("POST /api/calls/ingest — real data path", () => {
  test("200 returns { success, call_record_id, call_id, message } from createCallRecord()", async () => {
    const record = makeCallRecord({ id: 42, call_id: "call-abc", source: "ContactCenterProvider" });
    vi.mocked(callDb.createCallRecord).mockResolvedValueOnce(record);

    const handler = await buildHandler(callIntelligenceRoutes, "/api/calls/ingest", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        headers: AUTH_HEADERS,
        body: {
          call_id: "call-abc",
          source: "ContactCenterProvider",
          lead_id: "lead-1",
          agent_email: "<REDACTED_EMAIL>",
          duration_seconds: 120,
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.call_record_id).toBe(42);
    expect(res.body.call_id).toBe("call-abc");
    expect(typeof res.body.message).toBe("string");
    expect(callDb.createCallRecord).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(callDb.createCallRecord).mock.calls[0][0];
    expect(arg.call_id).toBe("call-abc");
    expect(arg.source).toBe("ContactCenterProvider");
    expect(arg.status).toBe("uploaded");
  });

  test("500 with deterministic body when createCallRecord throws", async () => {
    vi.mocked(callDb.createCallRecord).mockRejectedValueOnce(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const handler = await buildHandler(callIntelligenceRoutes, "/api/calls/ingest", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        headers: AUTH_HEADERS,
        body: { source: "ContactCenterProvider", duration_seconds: 60 },
      }),
    );

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: "Failed to ingest call" });
    errSpy.mockRestore();
  });
});

describe("GET /api/calls — real data path", () => {
  test("200 returns getCallRecords() result with forwarded filters", async () => {
    const fixture: Awaited<ReturnType<typeof callDb.getCallRecords>> = {
      records: [makeCallRecord({ id: 1, call_id: "c-1" })],
      total: 1,
    };
    vi.mocked(callDb.getCallRecords).mockResolvedValueOnce(fixture);

    const handler = await buildHandler(callIntelligenceRoutes, "/api/calls", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        headers: AUTH_HEADERS,
        query: { limit: "20", offset: "5", source: "ContactCenterProvider", status: "completed" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(fixture);
    const args = vi.mocked(callDb.getCallRecords).mock.calls[0]?.[0]!;
    expect(args.limit).toBe(20);
    expect(args.offset).toBe(5);
    expect(args.source).toBe("ContactCenterProvider");
    expect(args.status).toBe("completed");
  });

  test("defaults to limit=50 / offset=0 when params absent", async () => {
    vi.mocked(callDb.getCallRecords).mockResolvedValueOnce({ records: [], total: 0 });

    const handler = await buildHandler(callIntelligenceRoutes, "/api/calls", "GET");
    await handler(makeContext({ method: "GET", headers: AUTH_HEADERS }));

    const args = vi.mocked(callDb.getCallRecords).mock.calls[0]?.[0]!;
    expect(args.limit).toBe(50);
    expect(args.offset).toBe(0);
  });
});

describe("GET /api/calls/analytics — real data path", () => {
  test("200 returns getCallAnalyticsSummary() result", async () => {
    const analytics: Awaited<ReturnType<typeof callDb.getCallAnalyticsSummary>> = {
      totalCalls: 100,
      analyzedCalls: 80,
      avgSentimentScore: 0.7,
      avgQAScore: 85,
      avgComplianceScore: 92,
      callsBySource: [],
      callsByAgent: [],
      complianceBreakdown: {},
      complianceCoverage: {
        total_analyzed: 0,
        total_linked_to_crm: 0,
        total_with_compliance_row: 0,
        total_with_real_check: 0,
        total_not_checked_sentinel: 0,
        total_unlinked: 0,
      },
      sentimentDistribution: [],
      qaScoreTrend: [],
    };
    vi.mocked(callDb.getCallAnalyticsSummary).mockResolvedValueOnce(analytics);

    const handler = await buildHandler(callIntelligenceRoutes, "/api/calls/analytics", "GET");
    const res = await handler(makeContext({ method: "GET", headers: AUTH_HEADERS }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual(analytics);
    expect(callDb.getCallAnalyticsSummary).toHaveBeenCalledTimes(1);
  });

  test("500 with deterministic body when getCallAnalyticsSummary throws", async () => {
    vi.mocked(callDb.getCallAnalyticsSummary).mockRejectedValueOnce(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const handler = await buildHandler(callIntelligenceRoutes, "/api/calls/analytics", "GET");
    const res = await handler(makeContext({ method: "GET", headers: AUTH_HEADERS }));

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to fetch call analytics" });
    errSpy.mockRestore();
  });
});

describe("GET /api/calls/compliance — real data path", () => {
  test("200 returns getComplianceRecords() result with forwarded filters", async () => {
    const fixture: Awaited<ReturnType<typeof callDb.getComplianceRecords>> = {
      records: [],
      total: 0,
    };
    vi.mocked(callDb.getComplianceRecords).mockResolvedValueOnce(fixture);

    const handler = await buildHandler(callIntelligenceRoutes, "/api/calls/compliance", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        headers: AUTH_HEADERS,
        query: { limit: "10", lead_id: "L-1", agent_email: "<REDACTED_EMAIL>" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual(fixture);
    const args = vi.mocked(callDb.getComplianceRecords).mock.calls[0]?.[0]!;
    expect(args.limit).toBe(10);
    expect(args.lead_id).toBe("L-1");
    expect(args.agent_email).toBe("<REDACTED_EMAIL>");
  });
});

describe("GET /api/calls/:callId — real data path", () => {
  test("200 returns full call analysis when found", async () => {
    const full: Awaited<ReturnType<typeof callDb.getCallWithFullAnalysis>> = {
      record: makeCallRecord({ id: 5, call_id: "c-5" }),
      transcript: makeCallTranscript({ id: 1, call_record_id: 5 }),
      analysis: makeCallAnalysis({ id: 1, call_record_id: 5 }),
      qaScore: makeCallQAScore({ id: 1, call_record_id: 5 }),
      compliance: makeCallCompliance({ id: 1, call_record_id: 5 }),
    };
    vi.mocked(callDb.getCallWithFullAnalysis).mockResolvedValueOnce(full);

    const handler = await buildHandler(callIntelligenceRoutes, "/api/calls/:callId", "GET");
    const res = await handler(
      makeContext({ method: "GET", headers: AUTH_HEADERS, params: { callId: "5" } }),
    );

    expect(res.status).toBe(200);
    expect(res.body.record.call_id).toBe("c-5");
    expect(callDb.getCallWithFullAnalysis).toHaveBeenCalledWith(5);
  });

  test("404 when call record not found", async () => {
    vi.mocked(callDb.getCallWithFullAnalysis).mockResolvedValueOnce({ record: null, transcript: null, analysis: null, qaScore: null, compliance: null });

    const handler = await buildHandler(callIntelligenceRoutes, "/api/calls/:callId", "GET");
    const res = await handler(
      makeContext({ method: "GET", headers: AUTH_HEADERS, params: { callId: "999" } }),
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Call record not found" });
  });
});
