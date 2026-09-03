/**
 * CRMProvider_sync_state — the incremental watermark.
 *
 * `last_sync_at` is what the next run sends as If-Modified-Since. It used to be
 * set to NOW() on EVERY upsert, including the "syncing" mark at the start of a
 * run and the "failed" mark at the end. A sync that died partway had therefore
 * already advanced the watermark to its own start time, so the next incremental
 * run asked CRMProvider for "changes since the moment the failed run began" and every
 * record modified before that point was never fetched. The same call zeroed
 * total_synced, which is why Accounts read "0 (syncing)" for hours on
 * 2026-08-19 while every other module completed.
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

import {
  upsertSyncState,
  isSyncStale,
  SYNC_STALE_AFTER_MS,
} from "../../src/utils/duplicateRadarDatabase";

const call = () =>
  query.mock.calls.find((c) => /INSERT INTO CRMProvider_sync_state/i.test(String(c[0])));

beforeEach(() => query.mockReset().mockResolvedValue({ rows: [] }));

describe("the watermark only moves on success", () => {
  it("passes completed=true for a completed sync", async () => {
    await upsertSyncState("Accounts", 12345, "completed");
    expect((call()![1] as any[])[3]).toBe(true);
  });

  for (const status of ["syncing", "failed", "idle"]) {
    it(`passes completed=false for "${status}"`, async () => {
      await upsertSyncState("Accounts", 0, status);
      // The SQL keys both last_sync_at and total_synced off this flag, so a
      // non-completing status must never advance either.
      expect((call()![1] as any[])[3]).toBe(false);
    });
  }

  it("guards last_sync_at and total_synced behind that flag", async () => {
    await upsertSyncState("Accounts", 0, "syncing");
    const sql = String(call()![0]);
    // Casts are optional in these patterns on purpose. Pinning the exact SQL
    // text made this suite pass while the statement was in fact rejected by
    // Postgres for "inconsistent types deduced for parameter $3" — a mocked
    // pool accepts any string. See upsertSyncState.vitest.test.ts, which
    // asserts the casts themselves.
    expect(sql).toMatch(
      /last_sync_at = CASE WHEN \$4(?:::\w+)? THEN NOW\(\) ELSE CRMProvider_sync_state\.last_sync_at END/,
    );
    // Preserving the count matters too: the old code wrote 0 at the START of
    // every run, so a crash left the badge reading zero records synced.
    expect(sql).toMatch(
      /total_synced = CASE WHEN \$4(?:::\w+)? THEN \$2(?:::\w+)? ELSE CRMProvider_sync_state\.total_synced END/,
    );
  });

  it("stamps sync_started_at only when a run begins", async () => {
    await upsertSyncState("Accounts", 0, "syncing");
    const sql = String(call()![0]);
    expect(sql).toMatch(/sync_started_at = CASE\s+WHEN \$3(?:::\w+)? = 'syncing' THEN NOW\(\)/);
  });
});

describe("staleness", () => {
  it("is false for a run that just started", () => {
    expect(isSyncStale({ sync_status: "syncing", sync_started_at: new Date() })).toBe(false);
  });

  it("is true once the run has outlived the threshold", () => {
    const old = new Date(Date.now() - SYNC_STALE_AFTER_MS - 1000);
    expect(isSyncStale({ sync_status: "syncing", sync_started_at: old })).toBe(true);
  });

  it("treats a syncing row with no start time as stale", () => {
    // Rows written before sync_started_at existed cannot be aged. Calling them
    // healthy is what let Accounts look like active work for hours.
    expect(isSyncStale({ sync_status: "syncing", sync_started_at: null })).toBe(true);
  });

  it("never flags a module that is not syncing", () => {
    const old = new Date(Date.now() - SYNC_STALE_AFTER_MS - 1000);
    for (const s of ["completed", "failed", "idle"]) {
      expect(isSyncStale({ sync_status: s, sync_started_at: old })).toBe(false);
    }
  });
});
