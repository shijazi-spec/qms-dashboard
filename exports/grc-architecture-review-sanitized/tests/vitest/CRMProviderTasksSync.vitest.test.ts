/**
 * CRMProvider Tasks bulk sync — feeds SDR-KPI-11, SALES-KPI-07 and SALES-KPI-08.
 *
 * Two things this locks in, both learned the hard way elsewhere in this
 * codebase:
 *
 * 1. WINDOWING USES If-Modified-Since, NEVER `criteria`. CRMProvider honours criteria
 *    only on /search, which cannot sort and rejects greater_than on
 *    Created_Time ("400 - Invalid query formed"). The Calls import shipped that
 *    exact bug and its window was decorative for months.
 * 2. THE GUARD IS `configured`, NOT `connected`. `connected` only means a token
 *    is already warm in this process, so gating on it fails the first run after
 *    every restart — and a republish restarts the server.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { query, fetchAll, connStatus } = vi.hoisted(() => ({
  query: vi.fn(),
  fetchAll: vi.fn(),
  connStatus: vi.fn(),
}));

vi.mock("../../src/utils/redactedPool", () => ({
  createRedactedPool: () => ({
    query: (...a: any[]) => query(...a),
    connect: async () => ({ query: (...a: any[]) => query(...a), release: () => {} }),
  }),
}));
vi.mock("../../src/utils/CRMProviderCRM", () => ({
  fetchAllCRMProviderRecords: fetchAll,
  getCRMProviderConnectionStatus: connStatus,
}));
vi.mock("../../src/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runCRMProviderTasksSync } from "../../src/utils/CRMProviderTasksSync";

const CONFIGURED_COLD = {
  configured: true,
  connected: false, // token not warm — the post-restart state
  autoRefresh: true,
  tokenCached: <REDACTED_SECRET>
  tokenExpired: <REDACTED_SECRET>
  rateLimited: false,
  cooldownMsRemaining: 0,
  message: "",
};

const task = (over: any = {}) => ({
  id: over.id ?? "T1",
  <REDACTED_SCHEME> {
    Subject: "Follow up",
    Status: "Not Started",
    Due_Date: "2026-08-20",
    Owner: { name: "Rep", email: "<REDACTED_EMAIL>" },
    Who_Id: { id: "L1", name: "A Lead" },
    Created_Time: "2026-08-01T10:00:00+03:00",
    Modified_Time: "2026-08-02T10:00:00+03:00",
    ...over.data,
  },
});

beforeEach(() => {
  // INSERT ... RETURNING (xmax = 0) — true means a fresh insert.
  query.mockReset().mockResolvedValue({ rows: [{ inserted: true }] });
  fetchAll.mockReset().mockResolvedValue([]);
  connStatus.mockReset().mockReturnValue(CONFIGURED_COLD);
});

describe("runCRMProviderTasksSync — CRMProvider query shape", () => {
  it("windows by If-Modified-Since and NEVER sends criteria", async () => {
    await runCRMProviderTasksSync({ sinceIso: "2026-05-01T00:00:00Z" });
    expect(fetchAll).toHaveBeenCalledTimes(1);
    const [module, params] = fetchAll.mock.calls[0];
    expect(module).toBe("Tasks");
    expect(params.ifModifiedSince).toBe("2026-05-01T00:00:00Z");
    // The regression: a criteria filter would be silently dropped by the list
    // endpoint, or 400 on /search.
    expect(params.criteria).toBeUndefined();
    // Sorting only survives on the list endpoint, which is why we stay there.
    expect(params.sortBy).toBe("Modified_Time");
  });

  it("proceeds when configured but the token cache is cold", async () => {
    await runCRMProviderTasksSync({});
    expect(fetchAll).toHaveBeenCalledTimes(1);
  });

  it("bails when CRMProvider is not configured, without calling CRMProvider", async () => {
    connStatus.mockReturnValue({ ...CONFIGURED_COLD, configured: false });
    const r = await runCRMProviderTasksSync({});
    expect(fetchAll).not.toHaveBeenCalled();
    expect(r.errors).toBe(1);
    expect(r.error_samples[0]).toMatch(/not configured/i);
  });

  it("bails while rate-limited", async () => {
    connStatus.mockReturnValue({
      ...CONFIGURED_COLD,
      rateLimited: true,
      message: "CRMProvider OAuth is cooling down — ~30s remaining",
    });
    const r = await runCRMProviderTasksSync({});
    expect(fetchAll).not.toHaveBeenCalled();
    expect(r.error_samples[0]).toMatch(/cooling down/i);
  });
});

describe("runCRMProviderTasksSync — linkage census", () => {
  it("classifies Who / What / both / none", async () => {
    fetchAll.mockResolvedValue([
      task({ id: "T1" }), // Who only
      task({ id: "T2", <REDACTED_SCHEME> { Who_Id: null, What_Id: { id: "D1", name: "A Deal" } } }),
      task({ id: "T3", <REDACTED_SCHEME> { What_Id: { id: "D2", name: "Deal 2" } } }), // both
      task({ id: "T4", <REDACTED_SCHEME> { Who_Id: null, What_Id: null } }), // none
    ]);
    const r = await runCRMProviderTasksSync({});
    expect(r.scanned).toBe(4);
    expect(r.linkage).toEqual({ who: 1, what: 1, both: 1, none: 1 });
    // An unlinked task cannot be attributed to a lead or deal, so no follow-up
    // KPI can use it — surfaced, not silently dropped.
    expect(r.<REDACTED_TOKEN>).toBe(1);
  });

  it("counts inserts and updates separately via xmax", async () => {
    fetchAll.mockResolvedValue([task({ id: "T1" }), task({ id: "T2" })]);
    query.mockImplementation(async (sql: string) =>
      /INSERT INTO CRMProvider_tasks/i.test(String(sql))
        ? { rows: [{ inserted: query.mock.calls.filter((c) => /INSERT INTO CRMProvider_tasks/i.test(String(c[0]))).length === 1 }] }
        : { rows: [] },
    );
    const r = await runCRMProviderTasksSync({});
    expect(r.imported_new + r.updated_existing).toBe(2);
  });

  it("upserts on CRMProvider_task_id so re-running is safe", async () => {
    fetchAll.mockResolvedValue([task({ id: "T1" })]);
    await runCRMProviderTasksSync({});
    const insert = query.mock.calls
      .map((c) => String(c[0]))
      .find((s) => /INSERT INTO CRMProvider_tasks/i.test(s));
    expect(insert).toMatch(/ON CONFLICT \(CRMProvider_task_id\) DO UPDATE/i);
  });

  it("lowercases the owner email and keeps both lookup ids", async () => {
    fetchAll.mockResolvedValue([task({ id: "T1" })]);
    await runCRMProviderTasksSync({});
    const call = query.mock.calls.find((c) => /INSERT INTO CRMProvider_tasks/i.test(String(c[0])));
    const params = call?.[1] as any[];
    expect(params).toContain("<REDACTED_EMAIL>");
    expect(params).toContain("L1");
  });

  it("skips a task with no id rather than writing a null key", async () => {
    fetchAll.mockResolvedValue([{ id: "", <REDACTED_SCHEME> {} }]);
    const r = await runCRMProviderTasksSync({});
    expect(r.scanned).toBe(0);
    expect(query.mock.calls.some((c) => /INSERT INTO CRMProvider_tasks/i.test(String(c[0])))).toBe(false);
  });
});
