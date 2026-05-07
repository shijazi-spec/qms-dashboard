/**
 * Route-level integration tests for src/mastra/routes/zohoAgingRoutes.ts
 * (Task #825). The Zoho client is stubbed via the exported
 * `_setAgingFetchersForTests` hook so these tests exercise the full route
 * handler — RBAC, query parsing, pagination shape, sort order — without
 * touching the network.
 *
 * Run:  npx vitest run tests/vitest/zohoAgingRoutes.vitest.test.ts
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  zohoAgingRoutes,
  _setAgingFetchersForTests,
} from "../../src/mastra/routes/zohoAgingRoutes";
import {
  _clearAgingCaches,
  type AgingFetchers,
} from "../../src/utils/zohoAging";
import { buildHandler, makeContext } from "../_helpers/fakeContext";

// Allow the role check to pass: every test calls the handler with the
// admin API key header so `requireRoleOrKey` short-circuits to admit.
const ADMIN_HEADERS = { "x-admin-key": "test-key" };

// Stub admin-key check to admit our test header without requiring the real
// strength-checked secret.
vi.mock("../../src/utils/rbacMiddleware", async (orig) => {
  const real = await orig<typeof import("../../src/utils/rbacMiddleware")>();
  return {
    ...real,
    requireRoleOrKey: vi.fn(async (c: any) => {
      return c.req.header("x-admin-key") === "test-key" ? { role: "admin" } : null;
    }),
    hasValidAdminApiKey: vi.fn((c: any) => c.req.header("x-admin-key") === "test-key"),
    unauthorizedResponse: (c: any) => c.json({ error: "Unauthorized" }, 401),
  };
});

function makeFakeFetchers(): AgingFetchers {
  // 3 deals — one stale, one mid, one terminal.
  const dealsPage = [
    {
      id: "D1",
      module: "Deals",
      owner: "Alice",
      createdTime: "2026-01-01T00:00:00Z",
      modifiedTime: "2026-04-01T00:00:00Z",
      data: { Deal_Name: "Stalled Mega Deal", Stage: "Negotiation", Owner: { name: "Alice" } },
    },
    {
      id: "D2",
      module: "Deals",
      owner: "Bob",
      createdTime: "2026-04-15T00:00:00Z",
      modifiedTime: "2026-04-25T00:00:00Z",
      data: { Deal_Name: "Fresh Deal", Stage: "Qualification", Owner: { name: "Bob" } },
    },
    {
      id: "D3",
      module: "Deals",
      owner: "Carol",
      createdTime: "2026-01-01T00:00:00Z",
      modifiedTime: "2026-02-01T00:00:00Z",
      data: { Deal_Name: "Won Deal", Stage: "Closed Won", Owner: { name: "Carol" } },
    },
  ];

  const dealHistory: Record<string, { Stage: string; Modified_Time: string }[]> = {
    D1: [
      { Stage: "Qualification", Modified_Time: "2026-01-01T00:00:00Z" },
      { Stage: "Negotiation", Modified_Time: "2025-11-01T00:00:00Z" }, // very stale entry
    ],
    D2: [{ Stage: "Qualification", Modified_Time: "2026-04-25T00:00:00Z" }],
    D3: [{ Stage: "Closed Won", Modified_Time: "2026-02-01T00:00:00Z" }],
  };

  const leadsPage = [
    {
      id: "L1",
      module: "Leads",
      owner: "Dan",
      createdTime: "2026-01-01T00:00:00Z",
      modifiedTime: "2026-04-01T00:00:00Z",
      data: {
        Full_Name: "Acme Lead",
        Lead_Status: "Working",
        Owner: { name: "Dan" },
      },
    },
  ];

  const leadTimeline: Record<string, any[]> = {
    L1: [
      {
        audited_time: "2025-12-01T00:00:00Z",
        field: { api_name: "Lead_Status" },
        value: { current: "Working" },
      },
    ],
  };

  return {
    async listDealsPage(page: number) {
      return page === 1 ? (dealsPage as any) : [];
    },
    async listLeadsPage(page: number) {
      return page === 1 ? (leadsPage as any) : [];
    },
    async fetchDealStageHistoryById(dealId: string) {
      const rec = dealsPage.find((r) => r.id === dealId);
      return {
        history: dealHistory[dealId] || [],
        currentStage: rec?.data.Stage || "",
        createdTime: rec?.createdTime || null,
        dealName: rec?.data.Deal_Name || "",
        owner: rec?.owner || "",
      };
    },
    async fetchLeadStatusTimelineById(leadId: string) {
      const rec = leadsPage.find((r) => r.id === leadId);
      return {
        timeline: leadTimeline[leadId] || [],
        currentStatus: rec?.data.Lead_Status || "",
        createdTime: rec?.createdTime || null,
        leadName: rec?.data.Full_Name || "",
        owner: rec?.owner || "",
      };
    },
  };
}

beforeEach(() => {
  _clearAgingCaches();
  _setAgingFetchersForTests(makeFakeFetchers());
});

afterEach(() => {
  _setAgingFetchersForTests(null);
});

describe("/api/zoho/deals/aging — paginated list", () => {
  test("admin-key admits, items sorted by agingDays desc, terminal excluded", async () => {
    const handler = await buildHandler(
      zohoAgingRoutes,
      "/api/zoho/deals/aging",
      "GET",
    );
    const c = makeContext({
      url: "http://localhost:5000/api/zoho/deals/aging?limit=50",
      headers: ADMIN_HEADERS,
    });
    const res = await handler(c);
    expect(res.status).toBe(200);
    expect(res.body.scanned).toBe(3);
    // D1 (Negotiation) and D2 (Qualification) — both non-terminal.
    expect(res.body.items.length).toBe(2);
    // D1 entered Negotiation 2025-11-01 → much higher agingDays than D2.
    expect(res.body.items[0].dealId).toBe("D1");
    expect(res.body.items[1].dealId).toBe("D2");
    expect(res.body.items[0].agingDays).toBeGreaterThan(res.body.items[1].agingDays);
    // Domain-specific aliases (Task #825 contract).
    expect(res.body.items[0].stageAging).toBe(res.body.items[0].agingDays);
    expect(res.body.items[0].stageEnteredAt).toBe(res.body.items[0].enteredAt);
    // Terminal stage list is reported back to the dashboard.
    expect(res.body.terminalStages).toContain("Closed Won");
    // No more pages (page returned < limit).
    expect(res.body.nextCursor).toBeNull();
  });

  test("include_terminal=true keeps Closed Won deal (frozen, agingDays=0)", async () => {
    const handler = await buildHandler(
      zohoAgingRoutes,
      "/api/zoho/deals/aging",
      "GET",
    );
    const c = makeContext({
      url: "http://localhost:5000/api/zoho/deals/aging?include_terminal=true",
      headers: ADMIN_HEADERS,
    });
    const res = await handler(c);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(3);
    const won = res.body.items.find((r: any) => r.dealId === "D3");
    expect(won.isTerminal).toBe(true);
    expect(won.agingDays).toBe(0);
  });

  test("minDays filter drops fresh deal", async () => {
    const handler = await buildHandler(
      zohoAgingRoutes,
      "/api/zoho/deals/aging",
      "GET",
    );
    const c = makeContext({
      url: "http://localhost:5000/api/zoho/deals/aging?minDays=90",
      headers: ADMIN_HEADERS,
    });
    const res = await handler(c);
    expect(res.body.items.length).toBe(1);
    expect(res.body.items[0].dealId).toBe("D1");
  });

  test("missing admin key → 401", async () => {
    const handler = await buildHandler(
      zohoAgingRoutes,
      "/api/zoho/deals/aging",
      "GET",
    );
    const c = makeContext({ url: "http://localhost:5000/api/zoho/deals/aging" });
    const res = await handler(c);
    expect(res.status).toBe(401);
  });

  test("cursor paging: page 2 returns empty items + null nextCursor", async () => {
    const handler = await buildHandler(
      zohoAgingRoutes,
      "/api/zoho/deals/aging",
      "GET",
    );
    const c = makeContext({
      url: "http://localhost:5000/api/zoho/deals/aging?cursor=2",
      headers: ADMIN_HEADERS,
    });
    const res = await handler(c);
    expect(res.body.scanned).toBe(0);
    expect(res.body.items).toEqual([]);
    expect(res.body.nextCursor).toBeNull();
  });
});

describe("/api/zoho/leads/aging — paginated list", () => {
  test("returns lead with Owner + Name + status-aging", async () => {
    const handler = await buildHandler(
      zohoAgingRoutes,
      "/api/zoho/leads/aging",
      "GET",
    );
    const c = makeContext({
      url: "http://localhost:5000/api/zoho/leads/aging",
      headers: ADMIN_HEADERS,
    });
    const res = await handler(c);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(1);
    const row = res.body.items[0];
    expect(row.leadId).toBe("L1");
    expect(row.leadName).toBe("Acme Lead");
    expect(row.owner).toBe("Dan");
    expect(row.status).toBe("Working");
    expect(row.source).toBe("history");
    // Domain-specific aliases (Task #825 contract).
    expect(row.statusAging).toBe(row.agingDays);
    expect(row.statusEnteredAt).toBe(row.enteredAt);
    expect(res.body.terminalStatuses).toContain("Junk Lead");
  });
});

describe("/api/zoho/deals/:id/stage-aging — single record", () => {
  test("stale deal returns history-sourced enteredAt", async () => {
    const handler = await buildHandler(
      zohoAgingRoutes,
      "/api/zoho/deals/:id/stage-aging",
      "GET",
    );
    const c = makeContext({
      url: "http://localhost:5000/api/zoho/deals/D1/stage-aging",
      headers: ADMIN_HEADERS,
      params: { id: "D1" },
    });
    const res = await handler(c);
    expect(res.status).toBe(200);
    expect(res.body.dealId).toBe("D1");
    expect(res.body.stage).toBe("Negotiation");
    expect(res.body.source).toBe("history");
    expect(res.body.enteredAt).toBe("2025-11-01T00:00:00.000Z");
    expect(res.body.stageEnteredAt).toBe("2025-11-01T00:00:00.000Z");
    expect(res.body.stageAging).toBe(res.body.agingDays);
  });
});
