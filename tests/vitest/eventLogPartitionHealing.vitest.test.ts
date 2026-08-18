/**
 * event_logs partition bounds + the self-healing insert.
 *
 * The audit trail stopped dead at 2026-07-31 and took nothing for eighteen
 * days, across every module (last24Hours = 0, verified live 2026-08-18).
 * `event_logs` is PARTITION BY RANGE (timestamp), so a month with no partition
 * cannot accept a single row — and createMonthlyPartition swallowed the error
 * that said so.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

// This module builds its own `new Pool()` straight from `pg` rather than going
// through redactedPool, so `pg` is what has to be stubbed — mocking
// redactedPool here silently does nothing and the test hits a real socket.
vi.mock("pg", () => ({
  Pool: class {
    query(...a: any[]) {
      return query(...a);
    }
    connect() {
      return Promise.resolve({ query: (...a: any[]) => query(...a), release: () => {} });
    }
    on() {}
    end() {
      return Promise.resolve();
    }
  },
}));
vi.mock("../../src/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  monthPartitionBounds,
  logEvent,
  getAuditWriteHealth,
} from "../../src/utils/eventLogsDatabase";

beforeEach(() => query.mockReset().mockResolvedValue({ rows: [] }));

describe("partition bounds are UTC", () => {
  it("starts on the first of the month and ends on the first of the next", () => {
    expect(monthPartitionBounds(2026, 8)).toEqual({
      name: "event_logs_y2026m08",
      start: "2026-08-01",
      end: "2026-09-01",
    });
  });

  it("rolls the year over in December", () => {
    expect(monthPartitionBounds(2026, 12)).toMatchObject({
      start: "2026-12-01",
      end: "2027-01-01",
    });
  });

  it("does not drift with the server timezone", () => {
    // The original code built LOCAL midnight and read it back as UTC. East of
    // UTC that yields '2026-07-31' for August — which overlaps a July
    // partition of [2026-07-01, 2026-08-01), so Postgres refuses to create it
    // and the month ends up with nowhere to write. Date.UTC removes the shift
    // regardless of the host's TZ.
    const naive = new Date(2026, 7, 1).toISOString().slice(0, 10);
    const bounds = monthPartitionBounds(2026, 8);
    expect(bounds.start).toBe("2026-08-01");
    if (new Date().getTimezoneOffset() < 0) {
      // Host is east of UTC: prove the naive form really was wrong here.
      expect(naive).not.toBe(bounds.start);
    }
  });

  it("leaves no gap between consecutive months", () => {
    // A gap is unroutable: a row landing in it fails the same way a missing
    // partition does.
    for (let m = 1; m <= 11; m++) {
      expect(monthPartitionBounds(2026, m).end).toBe(
        monthPartitionBounds(2026, m + 1).start,
      );
    }
  });
});

describe("logEvent self-heals a missing partition", () => {
  const EVENT = { actionType: "CREATE", entityType: "DOCUMENT", entityId: "1" } as any;
  const noPartition = () =>
    Object.assign(new Error('no partition of relation "event_logs" found for row'), {
      code: "23514",
    });

  /**
   * Route by SQL rather than by call order: importing the module kicks off
   * initializeEventLogsTable() as a side effect, and its queries land in the
   * same mock, so a strict mockResolvedValueOnce chain is not reproducible.
   */
  function route(onInsert: (n: number) => any) {
    let inserts = 0;
    query.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (/INSERT INTO event_logs/i.test(s)) return onInsert(++inserts);
      if (/pg_tables/i.test(s)) return { rows: [{ exists: false }] };
      return { rows: [] };
    });
  }

  const inserts = () =>
    query.mock.calls.filter((c) => /INSERT INTO event_logs/i.test(String(c[0]))).length;
  /** Monthly partitions only — the DEFAULT one is counted separately. */
  const partitionsCreated = () =>
    query.mock.calls.filter((c) => /PARTITION OF event_logs\s+FOR VALUES/i.test(String(c[0])))
      .length;

  it("creates the partition and retries the insert once", async () => {
    route((n) => {
      if (n === 1) throw noPartition();
      return { rows: [{ id: 99 }] };
    });
    const out = await logEvent(EVENT);
    expect(out).toMatchObject({ id: 99 });
    expect(inserts()).toBe(2);
    // This month AND next, so the month rollover does not cost another event.
    expect(partitionsCreated()).toBe(2);
  });

  it("also creates a DEFAULT partition, since the month's own can be refused", async () => {
    route((n) => {
      if (n === 1) throw noPartition();
      return { rows: [{ id: 1 }] };
    });
    await logEvent(EVENT);
    const dflt = query.mock.calls.filter((c) =>
      /PARTITION OF event_logs DEFAULT/i.test(String(c[0])),
    );
    // Confirmed live: the correct August range overlapped a legacy partition
    // built with the old shifted bounds, so CREATE was rejected and the retry
    // failed too. DEFAULT accepts the row whatever the legacy bounds are.
    expect(dflt).toHaveLength(1);
  });

  it("does not retry errors that are not about partitioning", async () => {
    route(() => {
      throw Object.assign(new Error("null value in column violates not-null"), {
        code: "23502",
      });
    });
    expect(await logEvent(EVENT)).toBeNull();
    // A blind retry on any failure would double-write whenever the first
    // insert actually succeeded but its response was lost.
    expect(inserts()).toBe(1);
    expect(partitionsCreated()).toBe(0);
  });

  it("gives up rather than looping when the retry also fails", async () => {
    route(() => {
      throw noPartition();
    });
    expect(await logEvent(EVENT)).toBeNull();
    expect(inserts()).toBe(2);
  });
});

describe("logEvent never throws at its callers", () => {
  const EVENT = { actionType: "UPDATE", entityType: "KPI", entityId: "7" } as any;

  it("returns null instead of rethrowing", async () => {
    query.mockImplementation(async (sql: string) => {
      if (/INSERT INTO event_logs/i.test(String(sql))) throw new Error("boom");
      return { rows: [] };
    });
    // 77 call sites awaited this unguarded AFTER their business write. A throw
    // there turns a committed change into a 500, the caller retries, and the
    // retry hits a UNIQUE constraint. Throwing cannot undo the committed write,
    // so it only makes the caller misreport what happened.
    await expect(logEvent(EVENT)).resolves.toBeNull();
  });

  it("still reports the failure through the health probe", async () => {
    query.mockImplementation(async (sql: string) => {
      if (/INSERT INTO event_logs/i.test(String(sql))) {
        throw Object.assign(new Error("boom"), { code: "42P01" });
      }
      return { rows: [] };
    });
    await logEvent(EVENT);
    // Failing open is only acceptable because the gap stays visible.
    expect(getAuditWriteHealth()).toMatchObject({
      healthy: false,
      lastFailure: { code: "42P01", message: "boom" },
    });
  });
});

describe("audit-write health is readable without the deployment log", () => {
  const EVENT = { actionType: "CREATE", entityType: "KPI", entityId: "1" } as any;

  it("captures the Postgres code and detail of the last failure", async () => {
    query.mockImplementation(async (sql: string) => {
      if (/INSERT INTO event_logs/i.test(String(sql))) {
        throw Object.assign(new Error("some constraint blew up"), {
          code: "23502",
          detail: "Failing row contains (...)",
        });
      }
      return { rows: [] };
    });
    expect(await logEvent(EVENT)).toBeNull();
    const h = getAuditWriteHealth();
    // Every caller either swallows this throw or turns it into a 500, so
    // without this the only evidence is a log line nobody is tailing — which
    // is exactly how the August 2026 outage ran for eighteen days.
    expect(h.healthy).toBe(false);
    expect(h.lastFailure).toMatchObject({
      code: "23502",
      message: "some constraint blew up",
      detail: "Failing row contains (...)",
    });
  });

  it("clears once a write succeeds", async () => {
    query.mockImplementation(async (sql: string) =>
      /INSERT INTO event_logs/i.test(String(sql)) ? { rows: [{ id: 5 }] } : { rows: [] },
    );
    await logEvent(EVENT);
    expect(getAuditWriteHealth()).toMatchObject({ healthy: true, lastFailure: null });
  });
});
