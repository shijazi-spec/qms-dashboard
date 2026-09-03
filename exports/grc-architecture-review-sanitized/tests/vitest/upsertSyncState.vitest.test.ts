/**
 * The sync watermark write.
 *
 * Shipped 2026-08-19 to stop `last_sync_at` advancing on a failed run. It used
 * $3 twice with two different inferred types — assigned to sync_status (varchar,
 * from the column) and compared to a literal (text, from the operator) — and
 * Postgres refused the whole statement:
 *
 *   inconsistent types deduced for parameter $3
 *
 * upsertSyncState(module, 0, "syncing") is the FIRST query a module sync runs,
 * so no sync could start: the Accounts scan died at 10% and Leads / Deals /
 * Contacts never began. A mocked pool cannot reproduce type deduction, so this
 * asserts the property that prevents it — every placeholder carries a cast.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../src/utils/redactedPool", () => ({
  createRedactedPool: () => ({
    query: (...a: any[]) => query(...a),
    connect: async () => ({ query: (...a: any[]) => query(...a), release: () => {} }),
  }),
}));
vi.mock("../../src/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { upsertSyncState } from "../../src/utils/duplicateRadarDatabase";

const sql = () => String(query.mock.calls[0][0]);
const params = () => query.mock.calls[0][1] as any[];

beforeEach(() => query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 }));

describe("parameter types are unambiguous", () => {
  it("casts EVERY occurrence of EVERY placeholder", async () => {
    await upsertSyncState("Accounts", 0, "syncing");
    // $3 followed by anything other than :: is the exact shape that broke it.
    const uncast = sql().match(/\$\d(?!::)/g) ?? [];
    expect(uncast).toEqual([]);
  });

  it("casts $3 to the same type in the assignment and the comparison", async () => {
    await upsertSyncState("Accounts", 0, "syncing");
    const casts = new Set(sql().match(/\$3::\w+/g) ?? []);
    // Two different casts would trade one deduction error for another.
    expect(casts.size).toBe(1);
    expect([...casts][0]).toBe("$3::text");
  });
});

describe("the watermark itself", () => {
  it("advances last_sync_at only on completed", async () => {
    await upsertSyncState("Accounts", 500, "completed");
    expect(params()[3]).toBe(true);
    expect(sql()).toMatch(/last_sync_at = CASE WHEN \$4::boolean THEN NOW\(\)/);
  });

  it("leaves the previous watermark alone when a run fails", async () => {
    await upsertSyncState("Accounts", 0, "error");
    expect(params()[3]).toBe(false);
    // The point of the original fix: a failed run must not look fresh.
    expect(sql()).toMatch(/ELSE zoho_sync_state\.last_sync_at END/);
  });

  it("does not zero total_synced on a failed run", async () => {
    await upsertSyncState("Accounts", 0, "error");
    expect(sql()).toMatch(/ELSE zoho_sync_state\.total_synced END/);
  });

  it("stamps sync_started_at when a run begins", async () => {
    await upsertSyncState("Accounts", 0, "syncing");
    expect(sql()).toMatch(/WHEN \$3::text = 'syncing' THEN NOW\(\)/);
  });
});
