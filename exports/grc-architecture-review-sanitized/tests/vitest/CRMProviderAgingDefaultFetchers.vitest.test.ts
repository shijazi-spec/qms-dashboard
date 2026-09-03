/**
 * Live-path coverage for `defaultAgingFetchers` in src/utils/CRMProviderAging.ts.
 *
 * The route-level test in `CRMProviderAgingRoutes.vitest.test.ts` injects fake
 * fetchers and so does NOT exercise the production `defaultAgingFetchers`
 * path that the deployed app actually hits. This file covers that gap by
 * stubbing the underlying `fetchCRMProviderRecords`, `fetchDealStageHistory` and
 * `fetchLeadStatusChangelog` exports — the only dependencies the default
 * fetchers reach for — and asserting the full `listDealsAging`,
 * `listLeadsAging`, `getDealStageAging` and `getLeadStatusAging` shapes.
 *
 * In particular this protects against the regression where `fields` was
 * previously coerced to a comma-joined string, which would crash inside
 * `fetchCRMProviderRecords` (which expects `fields: string[]` and calls
 * `.join(',')` on it).
 *
 * Run:  npx vitest run tests/vitest/CRMProviderAgingDefaultFetchers.vitest.test.ts
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// IMPORTANT: mock CRMProviderCRM BEFORE importing CRMProviderAging so the dynamic
// `await import('./CRMProviderCRM')` inside defaultAgingFetchers picks up the
// mocked exports.
vi.mock("../../src/utils/CRMProviderCRM", () => ({
  fetchCRMProviderRecords: vi.fn(),
  fetchAllCRMProviderRecords: vi.fn(),
  fetchDealStageHistory: vi.fn(),
  fetchLeadStatusChangelog: vi.fn(),
}));

import * as CRMProviderCRM from "../../src/utils/CRMProviderCRM";
import {
  _clearAgingCaches,
  defaultAgingFetchers,
  getDealStageAging,
  getLeadStatusAging,
  listDealsAging,
  listLeadsAging,
} from "../../src/utils/CRMProviderAging";

const fetchCRMProviderRecordsMock = CRMProviderCRM.fetchCRMProviderRecords as unknown as ReturnType<typeof vi.fn>;
const fetchAllCRMProviderRecordsMock = CRMProviderCRM.fetchAllCRMProviderRecords as unknown as ReturnType<typeof vi.fn>;
const fetchDealStageHistoryMock = CRMProviderCRM.fetchDealStageHistory as unknown as ReturnType<typeof vi.fn>;
const fetchLeadStatusChangelogMock = CRMProviderCRM.fetchLeadStatusChangelog as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  _clearAgingCaches();
  fetchCRMProviderRecordsMock.mockReset();
  fetchAllCRMProviderRecordsMock.mockReset();
  fetchDealStageHistoryMock.mockReset();
  fetchLeadStatusChangelogMock.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("defaultAgingFetchers — listDealsPage", () => {
  test("passes `fields` as a string array (not a comma-joined string)", async () => {
    fetchCRMProviderRecordsMock.mockResolvedValueOnce([]);
    await defaultAgingFetchers.listDealsPage(1, 50);
    expect(fetchCRMProviderRecordsMock).toHaveBeenCalledTimes(1);
    const [module, params] = fetchCRMProviderRecordsMock.mock.calls[0];
    expect(module).toBe("Deals");
    expect(Array.isArray(params.fields)).toBe(true);
    expect(params.fields).toContain("Deal_Name");
    expect(params.fields).toContain("Stage");
    expect(params.fields).toContain("Owner");
    expect(params.page).toBe(1);
    expect(params.perPage).toBe(50);
    expect(params.sortBy).toBe("Modified_Time");
    expect(params.sortOrder).toBe("asc");
  });
});

describe("defaultAgingFetchers — listLeadsPage", () => {
  test("passes `fields` as a string array (not a comma-joined string)", async () => {
    fetchCRMProviderRecordsMock.mockResolvedValueOnce([]);
    await defaultAgingFetchers.listLeadsPage(2, 25);
    const [module, params] = fetchCRMProviderRecordsMock.mock.calls[0];
    expect(module).toBe("Leads");
    expect(Array.isArray(params.fields)).toBe(true);
    expect(params.fields).toContain("Lead_Status");
    expect(params.fields).toContain("Full_Name");
    expect(params.page).toBe(2);
    expect(params.perPage).toBe(25);
  });
});

describe("listDealsAging — end-to-end through defaultAgingFetchers", () => {
  test("returns Owner+Name from the page record and aging from Stage_History", async () => {
    fetchCRMProviderRecordsMock.mockResolvedValueOnce([
      {
        id: "D1",
        module: "Deals",
        owner: "Alice",
        createdTime: "2026-01-01T00:00:00Z",
        modifiedTime: "2026-04-01T00:00:00Z",
        <REDACTED_SCHEME> { Deal_Name: "Mega Deal", Stage: "Negotiation", Owner: { name: "Alice" } },
      },
    ]);
    // Per-record record fetch (defaultDealRecord) and the Stage_History fetch.
    fetchAllCRMProviderRecordsMock.mockResolvedValueOnce([
      { id: "D1", <REDACTED_SCHEME> { Deal_Name: "Mega Deal", Stage: "Negotiation", Owner: { name: "Alice" }, Created_Time: "2026-01-01T00:00:00Z" } },
    ]);
    fetchDealStageHistoryMock.mockResolvedValueOnce([
      { Stage: "Negotiation", Modified_Time: "2025-11-01T00:00:00Z" },
    ]);

    const res = await listDealsAging({ limit: 50 });
    expect(res.scanned).toBe(1);
    expect(res.items.length).toBe(1);
    expect(res.items[0].dealId).toBe("D1");
    expect(res.items[0].dealName).toBe("Mega Deal");
    expect(res.items[0].owner).toBe("Alice");
    expect(res.items[0].stage).toBe("Negotiation");
    expect(res.items[0].source).toBe("history");
    expect(res.items[0].enteredAt).toBe("2025-11-01T00:00:00.000Z");
    expect(res.items[0].agingDays).toBeGreaterThan(100);
    expect(res.nextCursor).toBeNull();
  });

  test("nextCursor advances when the page returns exactly `limit` records", async () => {
    const records = Array.from({ length: 2 }, (_, i) => ({
      id: `D${i}`,
      module: "Deals",
      owner: "X",
      createdTime: "2026-04-01T00:00:00Z",
      modifiedTime: "2026-04-01T00:00:00Z",
      <REDACTED_SCHEME> { Deal_Name: `D${i}`, Stage: "Qualification", Owner: { name: "X" } },
    }));
    fetchCRMProviderRecordsMock.mockResolvedValueOnce(records);
    fetchAllCRMProviderRecordsMock.mockResolvedValue([
      { id: "D0", <REDACTED_SCHEME> { Deal_Name: "D0", Stage: "Qualification", Owner: { name: "X" }, Created_Time: "2026-04-01T00:00:00Z" } },
    ]);
    fetchDealStageHistoryMock.mockResolvedValue([
      { Stage: "Qualification", Modified_Time: "2026-04-01T00:00:00Z" },
    ]);
    const res = await listDealsAging({ limit: 2 });
    expect(res.nextCursor).toBe("2");
  });
});

describe("listLeadsAging — end-to-end through defaultAgingFetchers", () => {
  test("falls back to Created_Time when timeline is empty", async () => {
    fetchCRMProviderRecordsMock.mockResolvedValueOnce([
      {
        id: "L1",
        module: "Leads",
        owner: "Dan",
        createdTime: "2026-04-23T00:00:00Z",
        modifiedTime: "2026-04-23T00:00:00Z",
        <REDACTED_SCHEME> { Full_Name: "Sample User", Lead_Status: "New", Owner: { name: "Dan" } },
      },
    ]);
    fetchAllCRMProviderRecordsMock.mockResolvedValueOnce([
      { id: "L1", <REDACTED_SCHEME> { Full_Name: "Sample User", Lead_Status: "New", Owner: { name: "Dan" }, Created_Time: "2026-04-23T00:00:00Z" } },
    ]);
    fetchLeadStatusChangelogMock.mockResolvedValueOnce([]); // never modified

    const res = await listLeadsAging({});
    expect(res.items.length).toBe(1);
    expect(res.items[0].source).toBe("created");
    expect(res.items[0].leadName).toBe("Example Organization");
    expect(res.items[0].owner).toBe("Dan");
  });
});

describe("getDealStageAging / getLeadStatusAging — single-record live path", () => {
  test("getDealStageAging surfaces history-sourced aging", async () => {
    fetchAllCRMProviderRecordsMock.mockResolvedValueOnce([
      { id: "D9", <REDACTED_SCHEME> { Deal_Name: "Stale", Stage: "Negotiation", Owner: { name: "Eve" }, Created_Time: "2025-01-01T00:00:00Z" } },
    ]);
    fetchDealStageHistoryMock.mockResolvedValueOnce([
      { Stage: "Negotiation", Modified_Time: "2025-12-01T00:00:00Z" },
    ]);
    const r = await getDealStageAging("D9");
    expect(r.dealId).toBe("D9");
    expect(r.dealName).toBe("Stale");
    expect(r.owner).toBe("Eve");
    expect(r.source).toBe("history");
    expect(r.enteredAt).toBe("2025-12-01T00:00:00.000Z");
  });

  test("getLeadStatusAging picks the latest matching Lead_Status entry", async () => {
    fetchAllCRMProviderRecordsMock.mockResolvedValueOnce([
      { id: "L7", <REDACTED_SCHEME> { Full_Name: "Sample User", Lead_Status: "Working", Owner: { name: "Sam" }, Created_Time: "2025-01-01T00:00:00Z" } },
    ]);
    fetchLeadStatusChangelogMock.mockResolvedValueOnce([
      { audited_time: "2026-01-01T00:00:00Z", field: { api_name: "Lead_Status" }, value: { current: "Working" } },
      { audited_time: "2026-04-01T00:00:00Z", field: { api_name: "Lead_Status" }, value: { current: "Working" } },
    ]);
    const r = await getLeadStatusAging("L7");
    expect(r.leadName).toBe("X Co");
    expect(r.enteredAt).toBe("2026-04-01T00:00:00.000Z");
  });
});
