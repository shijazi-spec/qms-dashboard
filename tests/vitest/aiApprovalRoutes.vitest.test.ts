/**
 * Vitest happy-path tests for src/mastra/routes/aiApprovalRoutes.ts.
 *
 * Stubs the data layer (aiApprovalDatabase, withApprovalGate,
 * aiToolGovernance, controlledDocumentRegistry, eventLogsDatabase) and
 * the bootstrap IIFE's lazy import (policyDatabase) so the suite is
 * fully hermetic. ADMIN_API_KEY + X-Admin-Key make the caller act as
 * the synthetic admin user, satisfying both gateApiRoute and the
 * per-route role gates.
 *
 * Run via:  npx vitest run tests/vitest/aiApprovalRoutes.vitest.test.ts
 */

const TEST_ADMIN_KEY = "vitest-ai-approval-admin-key-2026";
process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;

import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../src/utils/aiApprovalDatabase", () => ({
  initAIApprovalTable: vi.fn(async () => undefined),
  listPendingActions: vi.fn(),
  getPendingActionByCode: vi.fn(),
  claimForApproval: vi.fn(),
  rejectAction: vi.fn(),
  countPendingForUser: vi.fn(),
  countPendingWithCredentialWarnings: vi.fn(),
  countByReviewStatus: vi.fn(),
}));

vi.mock("../../src/utils/withApprovalGate", () => ({
  executeApprovedAction: vi.fn(),
  isToolGated: vi.fn(),
  withAgentUserContext: vi.fn(),
  getCurrentAgentContext: vi.fn(() => null),
  withApprovalGate: vi.fn(),
}));

vi.mock("../../src/utils/aiToolGovernance", () => ({
  isAllowedApprover: vi.fn(),
  getApproverRolesFor: vi.fn(() => ["admin", "quality_manager"]),
  getPolicy: vi.fn(),
  maskEmail: vi.fn((s: string) => s),
  maskPhone: vi.fn((s: string) => s),
  shouldAutoApprove: vi.fn(() => false),
  isGateEnabled: vi.fn(() => true),
  TOOL_GOVERNANCE_POLICIES: {},
  APPROVER_ROLES_BY_RISK: {
    critical: ["admin"],
    high: ["admin", "quality_manager"],
    medium: ["admin", "quality_manager"],
    low: ["admin", "quality_manager"],
  },
}));

vi.mock("../../src/utils/controlledDocumentRegistry", () => ({
  resolveControlledDocuments: vi.fn(async () => ({})),
  resolveControlledDocument: vi.fn(async () => null),
  seedControlledDocumentRegistry: vi.fn(async () => ({ inserted: 0, skipped: 0 })),
  SEED_DOCUMENTS: [],
}));

vi.mock("../../src/utils/eventLogsDatabase", () => ({
  initializeEventLogsTable: vi.fn(async () => undefined),
  logEvent: vi.fn(async () => ({ id: 1 })),
  redactSensitiveDeep: vi.fn(<T,>(x: T) => x),
  redactSecretLikeStrings: vi.fn(<T,>(x: T) => x),
  getActionViewers: vi.fn(async () => []),
  getActionViewersBatch: vi.fn(async () => ({})),
}));

vi.mock("../../src/utils/policyDatabase", () => ({
  initPolicyTables: vi.fn(async () => undefined),
}));

import { aiApprovalRoutes } from "../../src/mastra/routes/aiApprovalRoutes";
import type { PendingAction } from "../../src/utils/aiApprovalDatabase";
import { buildHandler, makeContext } from "../_helpers/fakeContext";

const ADMIN_HEADERS = { "X-Admin-Key": TEST_ADMIN_KEY };

let approvalDb: typeof import("../../src/utils/aiApprovalDatabase");
let approvalGate: typeof import("../../src/utils/withApprovalGate");
let governance: typeof import("../../src/utils/aiToolGovernance");
let registry: typeof import("../../src/utils/controlledDocumentRegistry");
let eventLogs: typeof import("../../src/utils/eventLogsDatabase");

function makeAction(overrides: Partial<PendingAction> = {}): PendingAction {
  return {
    id: 1,
    action_code: "ACT-2026-0001",
    tool_id: "rotate_api_key",
    tool_label: "Rotate API Key",
    payload: { foo: "bar" },
    payload_preview: "rotate api key for prod",
    payload_checksum: "abc123",
    risk_level: "high",
    compliance_refs: ["WP-SOP-009"],
    requested_by_user_id: 99,
    requested_by_email: "requester@example.com",
    requested_by_name: "Requester",
    thread_id: null,
    status: "pending",
    reviewed_by_user_id: null,
    reviewed_by_email: null,
    reviewed_by_name: null,
    reviewed_at: null,
    rejection_reason: null,
    executed_at: null,
    execution_result: null,
    result_entity_type: null,
    result_entity_id: null,
    created_at: new Date("2026-04-22T12:00:00Z"),
    expires_at: new Date("2026-04-23T12:00:00Z"),
    credential_warnings: [],
    ...overrides,
  };
}

beforeEach(async () => {
  process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
  approvalDb = await import("../../src/utils/aiApprovalDatabase");
  approvalGate = await import("../../src/utils/withApprovalGate");
  governance = await import("../../src/utils/aiToolGovernance");
  registry = await import("../../src/utils/controlledDocumentRegistry");
  eventLogs = await import("../../src/utils/eventLogsDatabase");
  vi.clearAllMocks();
  vi.mocked(approvalDb.initAIApprovalTable).mockResolvedValue(undefined);
  vi.mocked(eventLogs.logEvent).mockResolvedValue({ id: 1 });
  vi.mocked(eventLogs.getActionViewersBatch).mockResolvedValue({});
  vi.mocked(eventLogs.getActionViewers).mockResolvedValue([]);
  vi.mocked(eventLogs.redactSensitiveDeep).mockImplementation(<T,>(x: T) => x);
  vi.mocked(eventLogs.redactSecretLikeStrings).mockImplementation(<T,>(x: T) => x);
  vi.mocked(registry.resolveControlledDocuments).mockResolvedValue({});
  vi.mocked(governance.getApproverRolesFor).mockReturnValue(["admin", "quality_manager"]);
});

describe("GET /api/ai/approvals", () => {
  test("200 returns { success, total, rows } with prior_viewers attached", async () => {
    const rows = [makeAction(), makeAction({ id: 2, action_code: "ACT-2026-0002" })];
    vi.mocked(approvalDb.listPendingActions).mockResolvedValueOnce({ rows, total: 2 });
    vi.mocked(eventLogs.getActionViewersBatch).mockResolvedValueOnce({
      "ACT-2026-0001": [
        {
          user_id: 5,
          user_email: "v@x.com",
          user_name: "Viewer",
          user_role: "auditor",
          last_viewed_at: new Date("2026-04-22T13:00:00Z"),
          view_count: 1,
        },
      ],
      "ACT-2026-0002": [],
    });

    const handler = await buildHandler(aiApprovalRoutes, "/api/ai/approvals", "GET");
    const res = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));

    expect(res.status).toBe(200);
    const body = res.body as {
      success: boolean;
      total: number;
      rows: Array<PendingAction & { prior_viewers: unknown[] }>;
    };
    expect(body.success).toBe(true);
    expect(body.total).toBe(2);
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0].action_code).toBe("ACT-2026-0001");
    expect(body.rows[0].prior_viewers).toHaveLength(1);
    expect(body.rows[1].prior_viewers).toEqual([]);
    const call = vi.mocked(approvalDb.listPendingActions).mock.calls[0][0];
    expect(call.requestedByUserId).toBeUndefined();
    expect(call.status).toEqual(["pending"]);
    expect(call.limit).toBe(50);
    expect(call.offset).toBe(0);
  });

  test("200 splits comma-separated status, forwards risk_level/limit/offset, and scopes to self when mine=true", async () => {
    vi.mocked(approvalDb.listPendingActions).mockResolvedValueOnce({ rows: [], total: 0 });

    const handler = await buildHandler(aiApprovalRoutes, "/api/ai/approvals", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        headers: ADMIN_HEADERS,
        url: "http://localhost/api/ai/approvals?status=pending,approved&risk_level=high&mine=true&limit=10&offset=20",
      }),
    );

    expect(res.status).toBe(200);
    const call = vi.mocked(approvalDb.listPendingActions).mock.calls[0][0];
    expect(call.status).toEqual(["pending", "approved"]);
    expect(call.riskLevel).toBe("high");
    expect(call.requestedByUserId).toBe(0);
    expect(call.limit).toBe(10);
    expect(call.offset).toBe(20);
  });
});

describe("GET /api/ai/approvals/pending-count", () => {
  test("200 returns { success, count } from countPendingForUser()", async () => {
    vi.mocked(approvalDb.countPendingForUser).mockResolvedValueOnce(7);

    const handler = await buildHandler(aiApprovalRoutes, "/api/ai/approvals/pending-count", "GET");
    const res = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, count: 7 });
    expect(approvalDb.countPendingForUser).toHaveBeenCalledWith(0, expect.any(Array));
  });
});

describe("GET /api/ai/approvals/credential-warning-count", () => {
  test("200 returns { success, count } from countPendingWithCredentialWarnings()", async () => {
    vi.mocked(approvalDb.countPendingWithCredentialWarnings).mockResolvedValueOnce(2);

    const handler = await buildHandler(aiApprovalRoutes, "/api/ai/approvals/credential-warning-count", "GET");
    const res = await handler(makeContext({ method: "GET", headers: ADMIN_HEADERS }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, count: 2 });
    expect(approvalDb.countPendingWithCredentialWarnings).toHaveBeenCalledWith(0, expect.any(Array));
  });
});

describe("GET /api/ai/approvals/review-status-counts", () => {
  test("200 forwards filters and returns countByReviewStatus() result spread into body", async () => {
    vi.mocked(approvalDb.countByReviewStatus).mockResolvedValueOnce({
      unreviewed_by_me: 3,
      no_reviewers: 1,
    });

    const handler = await buildHandler(aiApprovalRoutes, "/api/ai/approvals/review-status-counts", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        headers: ADMIN_HEADERS,
        url: "http://localhost/api/ai/approvals/review-status-counts?status=pending&risk_level=high",
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, unreviewed_by_me: 3, no_reviewers: 1 });
    const call = vi.mocked(approvalDb.countByReviewStatus).mock.calls[0][0];
    expect(call.status).toEqual(["pending"]);
    expect(call.riskLevel).toBe("high");
    expect(call.requestedByUserId).toBeUndefined();
    expect(call.reviewerUserId).toBe(0);
  });
});

describe("GET /api/ai/approvals/:code", () => {
  test("200 returns enriched action with compliance_doc_links and approver metadata", async () => {
    const action = makeAction();
    vi.mocked(approvalDb.getPendingActionByCode).mockResolvedValueOnce(action);
    vi.mocked(governance.isAllowedApprover).mockReturnValue(true);
    vi.mocked(registry.resolveControlledDocuments).mockResolvedValueOnce({
      "WP-SOP-009": {
        code: "WP-SOP-009",
        title: "Nonconformity",
        status: "active",
        url: "/docs/WP-SOP-009",
        version: "v1",
      },
    });
    vi.mocked(eventLogs.getActionViewers).mockResolvedValueOnce([
      {
        user_id: 7,
        user_email: "viewer@x.com",
        user_name: "Viewer",
        user_role: "auditor",
        last_viewed_at: new Date("2026-04-22T13:00:00Z"),
        view_count: 1,
      },
    ]);

    const handler = await buildHandler(aiApprovalRoutes, "/api/ai/approvals/:code", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        headers: ADMIN_HEADERS,
        params: { code: "ACT-2026-0001" },
      }),
    );

    expect(res.status).toBe(200);
    const body = res.body as {
      success: boolean;
      action: PendingAction;
      compliance_doc_links: Record<string, { url: string }>;
      can_approve: boolean;
      can_approve_blocker: string | null;
      approver_roles: string[];
      prior_viewers: unknown[];
    };
    expect(body.success).toBe(true);
    expect(body.action).toBe(action);
    expect(body.compliance_doc_links["WP-SOP-009"].url).toBe("/docs/WP-SOP-009");
    expect(body.can_approve).toBe(true);
    expect(body.can_approve_blocker).toBeNull();
    expect(body.approver_roles).toEqual(["admin", "quality_manager"]);
    expect(body.prior_viewers).toHaveLength(1);
    expect(approvalDb.getPendingActionByCode).toHaveBeenCalledWith("ACT-2026-0001");
    expect(eventLogs.logEvent).toHaveBeenCalledTimes(1);
  });

  test("404 when action does not exist", async () => {
    vi.mocked(approvalDb.getPendingActionByCode).mockResolvedValueOnce(null);

    const handler = await buildHandler(aiApprovalRoutes, "/api/ai/approvals/:code", "GET");
    const res = await handler(
      makeContext({
        method: "GET",
        headers: ADMIN_HEADERS,
        params: { code: "missing" },
      }),
    );

    expect(res.status).toBe(404);
    // Task #545 expanded the GET /:code 404 body with a stable
    // machine-readable `code` and the requested `action_code` so the
    // dashboard's deep-link handler can render a friendly panel without
    // string-matching the message.
    expect(res.body).toEqual({
      error: "Approval action not found",
      code: "NOT_FOUND",
      action_code: "missing",
    });
  });
});

describe("POST /api/ai/approvals/:code/approve", () => {
  test("200 returns { success: true, actionCode, result } when execution succeeds", async () => {
    const action = makeAction();
    const claimed = makeAction({ status: "approved" });
    vi.mocked(approvalDb.getPendingActionByCode).mockResolvedValueOnce(action);
    vi.mocked(governance.isAllowedApprover).mockReturnValueOnce(true);
    vi.mocked(approvalGate.isToolGated).mockReturnValueOnce(true);
    vi.mocked(approvalDb.claimForApproval).mockResolvedValueOnce(claimed);
    vi.mocked(approvalGate.executeApprovedAction).mockResolvedValueOnce({
      ok: true,
      data: { rotated: true, fingerprint: "abc123" },
      entityType: "ApiKey",
      entityId: "key-1",
      error: null,
    });

    const handler = await buildHandler(aiApprovalRoutes, "/api/ai/approvals/:code/approve", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        headers: ADMIN_HEADERS,
        params: { code: "ACT-2026-0001" },
        body: {},
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      actionCode: "ACT-2026-0001",
      entityType: "ApiKey",
      entityId: "key-1",
      result: { rotated: true, fingerprint: "abc123" },
      error: null,
    });
    expect(approvalDb.claimForApproval).toHaveBeenCalledWith(
      "ACT-2026-0001",
      expect.objectContaining({ userId: 0, email: "admin-key@system" }),
    );
    expect(eventLogs.redactSensitiveDeep).toHaveBeenCalledWith({ rotated: true, fingerprint: "abc123" });
  });

  test("409 when action already in non-pending state", async () => {
    const action = makeAction({ status: "approved" });
    vi.mocked(approvalDb.getPendingActionByCode).mockResolvedValueOnce(action);

    const handler = await buildHandler(aiApprovalRoutes, "/api/ai/approvals/:code/approve", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        headers: ADMIN_HEADERS,
        params: { code: "ACT-2026-0001" },
        body: {},
      }),
    );

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Action is approved, cannot approve" });
  });

  test("404 when action not found", async () => {
    vi.mocked(approvalDb.getPendingActionByCode).mockResolvedValueOnce(null);

    const handler = await buildHandler(aiApprovalRoutes, "/api/ai/approvals/:code/approve", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        headers: ADMIN_HEADERS,
        params: { code: "missing" },
        body: {},
      }),
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Approval action not found" });
  });
});

describe("POST /api/ai/approvals/:code/reject", () => {
  test("200 returns { success, action } when reject succeeds", async () => {
    const action = makeAction();
    const rejected = makeAction({ status: "rejected", rejection_reason: "Not in policy" });
    vi.mocked(approvalDb.getPendingActionByCode).mockResolvedValueOnce(action);
    vi.mocked(governance.isAllowedApprover).mockReturnValueOnce(true);
    vi.mocked(approvalDb.rejectAction).mockResolvedValueOnce(rejected);

    const handler = await buildHandler(aiApprovalRoutes, "/api/ai/approvals/:code/reject", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        headers: ADMIN_HEADERS,
        params: { code: "ACT-2026-0001" },
        body: { reason: "Not in policy" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, action: rejected });
    expect(approvalDb.rejectAction).toHaveBeenCalledWith(
      "ACT-2026-0001",
      expect.objectContaining({ userId: 0, email: "admin-key@system" }),
      "Not in policy",
    );
  });

  test("400 when rejection reason is too short", async () => {
    const handler = await buildHandler(aiApprovalRoutes, "/api/ai/approvals/:code/reject", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        headers: ADMIN_HEADERS,
        params: { code: "ACT-2026-0001" },
        body: { reason: "" },
      }),
    );

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "A rejection reason (>=3 chars) is required for audit purposes.",
    });
    expect(approvalDb.getPendingActionByCode).not.toHaveBeenCalled();
    expect(approvalDb.rejectAction).not.toHaveBeenCalled();
  });

  test("404 when action does not exist", async () => {
    vi.mocked(approvalDb.getPendingActionByCode).mockResolvedValueOnce(null);

    const handler = await buildHandler(aiApprovalRoutes, "/api/ai/approvals/:code/reject", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        headers: ADMIN_HEADERS,
        params: { code: "missing" },
        body: { reason: "Anything reasonable" },
      }),
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Approval action not found" });
  });
});
