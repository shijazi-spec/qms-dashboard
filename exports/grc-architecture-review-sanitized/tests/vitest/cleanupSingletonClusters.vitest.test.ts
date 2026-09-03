/**
 * Unit tests for cleanupSingletonClusters in duplicateRadarDatabase.ts.
 *
 * Run: npx vitest run tests/vitest/cleanupSingletonClusters.vitest.test.ts
 *
 * Mocks the pg pool factory so the tests never touch a real database.
 * Verifies:
 *   - audit + sample + pointed-records are returned BEFORE any delete
 *   - dryRun default — no writes
 *   - over-limit refusal
 *   - real run wraps in BEGIN/COMMIT, clears child cluster_id, deletes
 *   - rollback on mid-transaction failure
 *   - no-candidates short-circuits with a refusedReason
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// vi.mock() is hoisted above all top-level code, so the factory cannot
// reference test-file variables. Workaround: build the fake pool +
// mutable state INSIDE the factory and expose it on globalThis so the
// tests can poke a queryHandler and inspect flags.
vi.mock("../../src/utils/redactedPool", () => {
  const state = {
    queryHandler: null as
      | ((sql: string, params?: any[]) => Promise<any> | any)
      | null,
    queries: [] as Array<{ sql: string; params?: any[] }>,
    flags: { begin: false, commit: false, rollback: false, released: false },
    connectCalls: 0,
  };
  (globalThis as any).__cleanupMock = state;

  const handle = (sql: string, params?: any[]) => {
    state.queries.push({ sql, params });
    if (/^BEGIN/i.test(sql)) {
      state.flags.begin = true;
      return { rowCount: 0, rows: [] };
    }
    if (/^COMMIT/i.test(sql)) {
      state.flags.commit = true;
      return { rowCount: 0, rows: [] };
    }
    if (/^ROLLBACK/i.test(sql)) {
      state.flags.rollback = true;
      return { rowCount: 0, rows: [] };
    }
    if (state.queryHandler) return state.queryHandler(sql, params);
    return { rowCount: 0, rows: [] };
  };

  const fakeClient = {
    query: async (sql: string, params?: any[]) => handle(sql, params),
    release: () => {
      state.flags.released = true;
    },
  };
  const fakePool = {
    query: async (sql: string, params?: any[]) => handle(sql, params),
    connect: async () => {
      state.connectCalls++;
      return fakeClient;
    },
  };
  return {
    createRedactedPool: () => fakePool,
  };
});

vi.mock("../../src/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { cleanupSingletonClusters } from "../../src/utils/duplicateRadarDatabase";

function mock() {
  return (globalThis as any).__cleanupMock as {
    queryHandler:
      | ((sql: string, params?: any[]) => Promise<any> | any)
      | null;
    queries: Array<{ sql: string; params?: any[] }>;
    flags: { begin: boolean; commit: boolean; rollback: boolean; released: boolean };
    connectCalls: number;
  };
}

beforeEach(() => {
  const m = mock();
  m.queryHandler = null;
  m.queries.length = 0;
  m.flags.begin = false;
  m.flags.commit = false;
  m.flags.rollback = false;
  m.flags.released = false;
  m.connectCalls = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("cleanupSingletonClusters", () => {
  test("dryRun (default) returns audit + sample, performs no writes", async () => {
    mock().queryHandler = (sql) => {
      if (/COUNT\(\*\)::int AS n\s+FROM duplicate_clusters/i.test(sql)) {
        return { rows: [{ n: 78000 }] };
      }
      if (/SELECT id, domain, company_name/i.test(sql)) {
        return {
          rows: [
            {
              id: 1,
              domain: "<REDACTED_HOST>",
              company_name: "Example Organization",
              total_records: 1,
              created_at: "2026-06-15T00:00:00Z",
            },
            {
              id: 2,
              domain: null,
              company_name: "Example Organization",
              total_records: 0,
              created_at: "2026-06-14T00:00:00Z",
            },
          ],
        };
      }
      if (/FROM duplicate_records\s+WHERE cluster_id IN/i.test(sql)) {
        return { rows: [{ n: 65000 }] };
      }
      return { rows: [] };
    };

    const r = await cleanupSingletonClusters();

    expect(r.dryRun).toBe(true);
    expect(r.candidateCount).toBe(78000);
    expect(r.pointedAtByRecordsCount).toBe(65000);
    expect(r.sampleRows).toHaveLength(2);
    expect(r.sampleRows[0].domain).toBe("<REDACTED_HOST>");
    expect(r.deletedClusterCount).toBe(0);
    expect(r.cleanedRecordCount).toBe(0);
    expect(r.refusedReason).toBeNull();
    expect(mock().connectCalls).toBe(0);
    expect(mock().flags.begin).toBe(false);
    expect(mock().flags.commit).toBe(false);
  });

  test("no candidates: short-circuits with refusedReason='no-candidates'", async () => {
    mock().queryHandler = (sql) => {
      if (/COUNT\(\*\)::int AS n/i.test(sql)) return { rows: [{ n: 0 }] };
      return { rows: [] };
    };

    const r = await cleanupSingletonClusters({ dryRun: false });

    expect(r.candidateCount).toBe(0);
    expect(r.refusedReason).toBe("no-candidates");
    expect(r.deletedClusterCount).toBe(0);
    expect(mock().connectCalls).toBe(0);
  });

  test("over-limit: refuses to delete when candidates > maxDelete, even if dryRun=false", async () => {
    mock().queryHandler = (sql) => {
      if (/COUNT\(\*\)::int AS n\s+FROM duplicate_clusters/i.test(sql)) {
        return { rows: [{ n: 200000 }] };
      }
      if (/SELECT id, domain/i.test(sql)) {
        return { rows: [] };
      }
      if (/FROM duplicate_records\s+WHERE cluster_id IN/i.test(sql)) {
        return { rows: [{ n: 100 }] };
      }
      return { rows: [] };
    };

    const r = await cleanupSingletonClusters({
      dryRun: false,
      maxDelete: 100000,
    });

    expect(r.candidateCount).toBe(200000);
    expect(r.refusedReason).toBe("over-limit");
    expect(r.deletedClusterCount).toBe(0);
    expect(mock().connectCalls).toBe(0);
    expect(mock().flags.begin).toBe(false);
  });

  test("real run with dryRun=false: wraps in BEGIN/COMMIT, clears child cluster_id, deletes", async () => {
    mock().queryHandler = (sql) => {
      if (/COUNT\(\*\)::int AS n\s+FROM duplicate_clusters/i.test(sql)) {
        return { rows: [{ n: 50 }] };
      }
      if (/SELECT id, domain/i.test(sql)) {
        return {
          rows: [
            {
              id: 7,
              domain: "<REDACTED_HOST>",
              company_name: "Example Organization",
              total_records: 1,
              created_at: "2026-06-15T00:00:00Z",
            },
          ],
        };
      }
      if (/FROM duplicate_records\s+WHERE cluster_id IN/i.test(sql)) {
        return { rows: [{ n: 40 }] };
      }
      if (/^UPDATE duplicate_records\s+SET cluster_id = NULL/i.test(sql)) {
        return { rowCount: 40 };
      }
      if (/^DELETE FROM duplicate_clusters/i.test(sql)) {
        return { rowCount: 50 };
      }
      return { rows: [] };
    };

    const r = await cleanupSingletonClusters({ dryRun: false });

    expect(r.dryRun).toBe(false);
    expect(r.candidateCount).toBe(50);
    expect(r.cleanedRecordCount).toBe(40);
    expect(r.deletedClusterCount).toBe(50);
    expect(r.refusedReason).toBeNull();
    expect(mock().flags.begin).toBe(true);
    expect(mock().flags.commit).toBe(true);
    expect(mock().flags.rollback).toBe(false);
    expect(mock().flags.released).toBe(true);
  });

  test("mid-transaction failure: rolls back, releases client, re-throws", async () => {
    mock().queryHandler = (sql: string) => {
      if (/COUNT\(\*\)::int AS n\s+FROM duplicate_clusters/i.test(sql)) {
        return { rows: [{ n: 3 }] };
      }
      if (/SELECT id, domain/i.test(sql)) {
        return { rows: [] };
      }
      if (/FROM duplicate_records\s+WHERE cluster_id IN/i.test(sql)) {
        return { rows: [{ n: 0 }] };
      }
      if (/^UPDATE duplicate_records\s+SET cluster_id = NULL/i.test(sql)) {
        throw new Error("simulated DB blowup");
      }
      return { rows: [] };
    };

    await expect(
      cleanupSingletonClusters({ dryRun: false }),
    ).rejects.toThrow(/simulated DB blowup/);
    expect(mock().flags.begin).toBe(true);
    expect(mock().flags.commit).toBe(false);
    expect(mock().flags.rollback).toBe(true);
    expect(mock().flags.released).toBe(true);
  });

  test("dryRun + over-limit: still returns the candidate count, no write attempt", async () => {
    mock().queryHandler = (sql) => {
      if (/COUNT\(\*\)::int AS n\s+FROM duplicate_clusters/i.test(sql)) {
        return { rows: [{ n: 999999 }] };
      }
      if (/SELECT id, domain/i.test(sql)) {
        return { rows: [] };
      }
      if (/FROM duplicate_records\s+WHERE cluster_id IN/i.test(sql)) {
        return { rows: [{ n: 0 }] };
      }
      return { rows: [] };
    };

    const r = await cleanupSingletonClusters({
      dryRun: true,
      maxDelete: 100000,
    });

    expect(r.candidateCount).toBe(999999);
    expect(r.refusedReason).toBe("over-limit");
    expect(mock().connectCalls).toBe(0);
  });
});
