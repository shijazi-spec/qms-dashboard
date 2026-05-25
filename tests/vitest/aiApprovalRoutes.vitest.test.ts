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

// Per-test session-user override. The default rbac path inside the route file
// is the admin-key fallback (returns userId=0, role='admin') which keeps the
// existing happy-path tests working unchanged. Failure-path tests that need
// to assert segregation-of-duties / role-gate / requester-vs-approver
// behaviour install a non-admin user via setTestUser() before invoking the
// handler. A vi.hoisted shim is required because vi.mock factories are
// hoisted above local module-scope variables.
const { setTestUser, getTestUser } = vi.hoisted(() => {
  let user: any = null;
  return {
    setTestUser: (u: any) => {
      user = u;
    },
    getTestUser: () => user,
  };
});

vi.mock("../../src/utils/rbacMiddleware", () => {
  const adminFromKey = (c: any) => {
    const key = c?.req?.header?.("X-Admin-Key");
    if (key && key === process.env.ADMIN_API_KEY) {
      return { userId: 0, email: "admin-key@system", name: "Admin API", role: "admin" };
    }
    return null;
  };
  return {
    getSessionUser: (c: any) => getTestUser() ?? adminFromKey(c),
    requireRole: async (c: any, roles: string[]) => {
      const user = getTestUser() ?? adminFromKey(c);
      if (!user) return null;
      if (!roles.includes(user.role)) return null;
      return user;
    },
    requireAuthOrKey: (c: any) => getTestUser() ?? adminFromKey(c),
    unauthorizedResponse: (c: any) => c.json({ error: "Authentication required" }, 401),
    forbiddenResponse: (c: any, detail?: string) =>
      c.json({ error: detail || "Insufficient permissions" }, 403),
    // Pass-through outer gate; aiApprovalGate inside the route file already
    // enforces per-route role lists via the mocked requireRole above.
    gateApiRoute: <T,>(route: T): T => route,
    hasValidAdminApiKey: (c: any) => {
      const key = c?.req?.header?.("X-Admin-Key");
      return !!(key && key === process.env.ADMIN_API_KEY);
    },
  };
});

// fs is mocked so the GET /ai-approvals HTML route can be steered between
// the "file found -> 200 HTML" and "no candidate path exists -> 404" branches
// without depending on the on-disk dashboard file. The mock spreads the real
// module so other fs consumers (path resolution, test runner internals) keep
// working; only existsSync/readFileSync are replaced with vi.fn() shims that
// default to the real implementations.
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    default: actual,
    existsSync: vi.fn(actual.existsSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});

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
  // Drop any non-admin user installed by a prior failure-path test so the
  // happy-path tests fall back to the admin-key synth user via the rbac mock.
  setTestUser(null);
  vi.mocked(approvalDb.initAIApprovalTable).mockResolvedValue(undefined);
  // Cast: tests only care that logEvent returned something truthy; full EventLog shape irrelevant.
  vi.mocked(eventLogs.logEvent).mockResolvedValue({ id: 1 } as unknown as Awaited<ReturnType<typeof eventLogs.logEvent>>);
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
    const call = vi.mocked(approvalDb.listPendingActions).mock.calls[0]?.[0]!;
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
    const call = vi.mocked(approvalDb.listPendingActions).mock.calls[0]?.[0]!;
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
    const call = vi.mocked(approvalDb.countByReviewStatus).mock.calls[0]?.[0]!;
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
    // Cast: test only reads .url on the response; fixture includes extra fields
    // the handler is expected to surface (code/status/url) which aren't in the
    // production return type.
    vi.mocked(registry.resolveControlledDocuments).mockResolvedValueOnce({
      "WP-SOP-009": {
        code: "WP-SOP-009",
        title: "Nonconformity",
        status: "active",
        url: "/docs/WP-SOP-009",
        version: "v1",
      },
    } as unknown as Awaited<ReturnType<typeof registry.resolveControlledDocuments>>);
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

  test("403 segregation-of-duties: non-admin requester cannot approve their own action", async () => {
    // requested_by_user_id = 99 on the canned action; install a non-admin
    // session user with the same userId so the SoD branch (WP-DOC-005) fires.
    setTestUser({
      userId: 99,
      email: "qm@example.com",
      name: "QM User",
      role: "quality_manager",
    });
    const action = makeAction({ requested_by_user_id: 99 });
    vi.mocked(approvalDb.getPendingActionByCode).mockResolvedValueOnce(action);
    // Approver-role check passes so the handler reaches the SoD guard.
    vi.mocked(governance.isAllowedApprover).mockReturnValueOnce(true);

    const handler = await buildHandler(aiApprovalRoutes, "/api/ai/approvals/:code/approve", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        params: { code: "ACT-2026-0001" },
        body: {},
      }),
    );

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error:
        "Segregation of duties: you cannot approve your own AI proposal. See WP-DOC-005.",
    });
    // SoD short-circuits before any state mutation.
    expect(approvalDb.claimForApproval).not.toHaveBeenCalled();
    expect(approvalGate.executeApprovedAction).not.toHaveBeenCalled();
  });

  test("403 role gate: isAllowedApprover() false yields per-risk forbidden message", async () => {
    // quality_manager passes the outer aiApprovalGate role list, but we
    // force the per-risk approver check to fail so the in-handler role gate
    // is the branch under test.
    setTestUser({
      userId: 42,
      email: "qm@example.com",
      name: "QM User",
      role: "quality_manager",
    });
    const action = makeAction({ risk_level: "critical" });
    vi.mocked(approvalDb.getPendingActionByCode).mockResolvedValueOnce(action);
    vi.mocked(governance.isAllowedApprover).mockReturnValueOnce(false);
    vi.mocked(governance.getApproverRolesFor).mockReturnValueOnce(["admin"]);

    const handler = await buildHandler(aiApprovalRoutes, "/api/ai/approvals/:code/approve", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        params: { code: "ACT-2026-0001" },
        body: {},
      }),
    );

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error:
        'Role "quality_manager" is not permitted to approve critical-risk AI actions. Required roles: admin.',
    });
    expect(approvalDb.claimForApproval).not.toHaveBeenCalled();
  });

  test("409 when isToolGated() is false (defense-in-depth registry check)", async () => {
    const action = makeAction({ tool_id: "ghost_tool" });
    vi.mocked(approvalDb.getPendingActionByCode).mockResolvedValueOnce(action);
    vi.mocked(governance.isAllowedApprover).mockReturnValueOnce(true);
    vi.mocked(approvalGate.isToolGated).mockReturnValueOnce(false);

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
    expect(res.body).toEqual({
      error: 'Tool "ghost_tool" is no longer registered as gated. Approval blocked.',
    });
    expect(approvalDb.claimForApproval).not.toHaveBeenCalled();
  });

  test("409 when claimForApproval() returns null (race lost) and surfaces currentStatus", async () => {
    const action = makeAction();
    vi.mocked(approvalDb.getPendingActionByCode)
      .mockResolvedValueOnce(action)
      // Second lookup happens after the failed claim so the response can
      // report whatever state the row landed in.
      .mockResolvedValueOnce(makeAction({ status: "rejected" }));
    vi.mocked(governance.isAllowedApprover).mockReturnValueOnce(true);
    vi.mocked(approvalGate.isToolGated).mockReturnValueOnce(true);
    vi.mocked(approvalDb.claimForApproval).mockResolvedValueOnce(null);

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
    expect(res.body).toEqual({
      error:
        "Could not claim approval — it may have been handled by another reviewer or expired.",
      currentStatus: "rejected",
    });
    expect(approvalGate.executeApprovedAction).not.toHaveBeenCalled();
  });

  test("500 path runs error.message through redactSecretLikeStrings before echoing", async () => {
    const action = makeAction();
    vi.mocked(approvalDb.getPendingActionByCode).mockResolvedValueOnce(action);
    vi.mocked(governance.isAllowedApprover).mockReturnValueOnce(true);
    vi.mocked(approvalGate.isToolGated).mockReturnValueOnce(true);

    // Force a thrown error AFTER the static checks have passed so control
    // lands in the catch block. The message embeds a credential-shaped
    // substring so we can verify the redactor sees it before it ever leaves
    // the handler.
    const leakyMessage =
      "rotate failed: AKIAIOSFODNN7EXAMPLEKEYZZ leaked from upstream";
    vi.mocked(approvalDb.claimForApproval).mockRejectedValueOnce(
      new Error(leakyMessage),
    );
    vi.mocked(eventLogs.redactSecretLikeStrings).mockImplementationOnce(
      () => "rotate failed: [REDACTED] leaked from upstream",
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const handler = await buildHandler(aiApprovalRoutes, "/api/ai/approvals/:code/approve", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        headers: ADMIN_HEADERS,
        params: { code: "ACT-2026-0001" },
        body: {},
      }),
    );

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: "Failed to approve",
      details: "rotate failed: [REDACTED] leaked from upstream",
    });
    // The credential-bearing original message must have been the input to
    // the redactor — proving a thrown error never echoes a raw key.
    expect(eventLogs.redactSecretLikeStrings).toHaveBeenCalledWith(leakyMessage);
    errSpy.mockRestore();
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

  test("requester (not approver) may reject their own draft -> 200", async () => {
    // The auditor role passes the outer reject-roles gate; isAllowedApprover
    // is false, but isRequester is true (matching userId), so rejection
    // succeeds as a self-cancel.
    setTestUser({
      userId: 99,
      email: "auditor@example.com",
      name: "Self-Canceller",
      role: "auditor",
    });
    const action = makeAction({ requested_by_user_id: 99 });
    const rejected = makeAction({
      requested_by_user_id: 99,
      status: "rejected",
      rejection_reason: "Changed my mind",
    });
    vi.mocked(approvalDb.getPendingActionByCode).mockResolvedValueOnce(action);
    vi.mocked(governance.isAllowedApprover).mockReturnValueOnce(false);
    vi.mocked(approvalDb.rejectAction).mockResolvedValueOnce(rejected);

    const handler = await buildHandler(aiApprovalRoutes, "/api/ai/approvals/:code/reject", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        params: { code: "ACT-2026-0001" },
        body: { reason: "Changed my mind" },
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, action: rejected });
    expect(approvalDb.rejectAction).toHaveBeenCalledWith(
      "ACT-2026-0001",
      expect.objectContaining({ userId: 99, email: "auditor@example.com" }),
      "Changed my mind",
    );
  });

  test("403 when caller is neither requester nor approver", async () => {
    // Auditor role passes the outer reject-roles gate. They are not the
    // requester (different userId) and isAllowedApprover is mocked false,
    // so the in-handler authorization check is the branch under test.
    setTestUser({
      userId: 7,
      email: "auditor@example.com",
      name: "Random Auditor",
      role: "auditor",
    });
    const action = makeAction({ requested_by_user_id: 99 });
    vi.mocked(approvalDb.getPendingActionByCode).mockResolvedValueOnce(action);
    vi.mocked(governance.isAllowedApprover).mockReturnValueOnce(false);

    const handler = await buildHandler(aiApprovalRoutes, "/api/ai/approvals/:code/reject", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        params: { code: "ACT-2026-0001" },
        body: { reason: "Looks wrong" },
      }),
    );

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Not authorized to reject this approval." });
    expect(approvalDb.rejectAction).not.toHaveBeenCalled();
  });

  test("409 when rejectAction() returns null (state changed mid-request)", async () => {
    const action = makeAction();
    vi.mocked(approvalDb.getPendingActionByCode).mockResolvedValueOnce(action);
    vi.mocked(governance.isAllowedApprover).mockReturnValueOnce(true);
    vi.mocked(approvalDb.rejectAction).mockResolvedValueOnce(null);

    const handler = await buildHandler(aiApprovalRoutes, "/api/ai/approvals/:code/reject", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        headers: ADMIN_HEADERS,
        params: { code: "ACT-2026-0001" },
        body: { reason: "Not in policy" },
      }),
    );

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Could not reject — state may have changed." });
  });
});

describe("GET /ai-approvals (HTML dashboard route)", () => {
  test("200 returns the dashboard HTML when a candidate file exists", async () => {
    const fs = await import("fs");
    // existsSync defaults to the real implementation, which finds
    // dashboard/ai-approvals.html in this repo, but we steer the value
    // explicitly so the test does not depend on the on-disk layout: first
    // candidate hits, returns canned HTML.
    vi.mocked(fs.existsSync).mockReturnValueOnce(true);
    vi.mocked(fs.readFileSync).mockReturnValueOnce(
      "<html><body>AI Approvals</body></html>",
    );

    const handler = await buildHandler(aiApprovalRoutes, "/ai-approvals", "GET");
    const res = await handler(makeContext({ method: "GET" }));

    expect(res.status).toBe(200);
    expect(res.body).toBe("<html><body>AI Approvals</body></html>");
    expect(res.headers["Content-Type"]).toMatch(/text\/html/);
  });

  test("404 fallback when no candidate path exists", async () => {
    const fs = await import("fs");
    // The handler probes two candidate paths; force both to miss so the
    // fallback branch is the one under test.
    vi.mocked(fs.existsSync).mockReturnValueOnce(false).mockReturnValueOnce(false);

    const handler = await buildHandler(aiApprovalRoutes, "/ai-approvals", "GET");
    const res = await handler(makeContext({ method: "GET" }));

    expect(res.status).toBe(404);
    expect(res.body).toBe("AI Approvals dashboard not found");
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });
});
