/**
 * Unit tests for the Coaching Effectiveness Index. Pure-function
 * scoring + aggregation, plus the SQL composition via a mock pool.
 *
 * Run: npx vitest run tests/vitest/coachingEffectivenessIndex.vitest.test.ts
 */
import { describe, expect, test } from "vitest";
import {
  MIN_CALLS_PER_WINDOW,
  WINDOW_DAYS,
  aggregateCEfx,
  computeSessionCEfx,
  fetchCoachingEffectiveness,
  type SessionCEfx,
} from "../../src/utils/coachingEffectivenessIndex";

describe("computeSessionCEfx", () => {
  test("computes delta when both windows have enough data", () => {
    const r = computeSessionCEfx({
      calls_before: 5,
      calls_after: 5,
      avg_score_before: 60,
      avg_score_after: 72,
    });
    expect(r.status).toBe("ok");
    expect(r.delta).toBe(12);
  });

  test("rounds delta to 2 decimal places", () => {
    const r = computeSessionCEfx({
      calls_before: 3,
      calls_after: 3,
      avg_score_before: 60.123456,
      avg_score_after: 65.987654,
    });
    expect(r.delta).toBe(5.86);
  });

  test('returns insufficient_data when "before" has too few calls', () => {
    const r = computeSessionCEfx({
      calls_before: MIN_CALLS_PER_WINDOW - 1,
      calls_after: 5,
      avg_score_before: 60,
      avg_score_after: 70,
    });
    expect(r.status).toBe("insufficient_data");
    expect(r.delta).toBeNull();
  });

  test('returns insufficient_data when "after" has too few calls', () => {
    const r = computeSessionCEfx({
      calls_before: 5,
      calls_after: MIN_CALLS_PER_WINDOW - 1,
      avg_score_before: 60,
      avg_score_after: 70,
    });
    expect(r.status).toBe("insufficient_data");
  });

  test("returns insufficient_data when either avg is null", () => {
    expect(
      computeSessionCEfx({
        calls_before: 5,
        calls_after: 5,
        avg_score_before: null,
        avg_score_after: 70,
      }).status,
    ).toBe("insufficient_data");
    expect(
      computeSessionCEfx({
        calls_before: 5,
        calls_after: 5,
        avg_score_before: 70,
        avg_score_after: null,
      }).status,
    ).toBe("insufficient_data");
  });

  test("negative delta is reported (coach made it worse)", () => {
    const r = computeSessionCEfx({
      calls_before: 5,
      calls_after: 5,
      avg_score_before: 75,
      avg_score_after: 60,
    });
    expect(r.delta).toBe(-15);
    expect(r.status).toBe("ok");
  });
});

function mkSession(p: Partial<SessionCEfx>): SessionCEfx {
  return {
    session_id: 0,
    agent_email: "<REDACTED_EMAIL>",
    agent_name: null,
    manager_email: "<REDACTED_EMAIL>",
    manager_name: null,
    delivered_at: "2026-01-01T00:00:00Z",
    calls_before: 5,
    calls_after: 5,
    avg_score_before: 60,
    avg_score_after: 70,
    delta: 10,
    status: "ok",
    ...p,
  };
}

describe("aggregateCEfx", () => {
  test("empty input → empty aggregates", () => {
    const r = aggregateCEfx([]);
    expect(r.by_coach).toEqual([]);
    expect(r.by_agent).toEqual([]);
  });

  test("averages deltas per coach", () => {
    const sessions: SessionCEfx[] = [
      mkSession({ session_id: 1, manager_email: "<REDACTED_EMAIL>", delta: 10 }),
      mkSession({ session_id: 2, manager_email: "<REDACTED_EMAIL>", delta: 20 }),
      mkSession({ session_id: 3, manager_email: "<REDACTED_EMAIL>", delta: 5 }),
    ];
    const r = aggregateCEfx(sessions);
    const alice = r.by_coach.find((c) => c.manager_email === "<REDACTED_EMAIL>");
    const bob = r.by_coach.find((c) => c.manager_email === "<REDACTED_EMAIL>");
    expect(alice?.avg_delta).toBe(15);
    expect(alice?.sessions_counted).toBe(2);
    expect(bob?.avg_delta).toBe(5);
    expect(bob?.sessions_counted).toBe(1);
  });

  test("insufficient_data sessions count separately and don't affect avg", () => {
    const sessions: SessionCEfx[] = [
      mkSession({ session_id: 1, manager_email: "<REDACTED_EMAIL>", delta: 10, status: "ok" }),
      mkSession({ session_id: 2, manager_email: "<REDACTED_EMAIL>", delta: null, status: "insufficient_data" }),
    ];
    const r = aggregateCEfx(sessions);
    const alice = r.by_coach[0];
    expect(alice.sessions_counted).toBe(1);
    expect(alice.sessions_insufficient).toBe(1);
    expect(alice.avg_delta).toBe(10);
  });

  test("agent rollup is independent of coach rollup", () => {
    const sessions: SessionCEfx[] = [
      mkSession({ session_id: 1, agent_email: "<REDACTED_EMAIL>", manager_email: "<REDACTED_EMAIL>", delta: 10 }),
      mkSession({ session_id: 2, agent_email: "<REDACTED_EMAIL>", manager_email: "<REDACTED_EMAIL>", delta: 6 }),
    ];
    const r = aggregateCEfx(sessions);
    expect(r.by_agent).toHaveLength(1);
    expect(r.by_agent[0].avg_delta).toBe(8);
  });

  test("sorts coach + agent leaderboards by avg_delta desc", () => {
    const sessions: SessionCEfx[] = [
      mkSession({ session_id: 1, manager_email: "<REDACTED_EMAIL>", delta: 1 }),
      mkSession({ session_id: 2, manager_email: "<REDACTED_EMAIL>", delta: 20 }),
      mkSession({ session_id: 3, manager_email: "<REDACTED_EMAIL>", delta: 10 }),
    ];
    const r = aggregateCEfx(sessions);
    expect(r.by_coach.map((c) => c.manager_email)).toEqual([
      "<REDACTED_EMAIL>",
      "<REDACTED_EMAIL>",
      "<REDACTED_EMAIL>",
    ]);
  });

  test("sessions with only insufficient_data → coach has null avg_delta", () => {
    const sessions: SessionCEfx[] = [
      mkSession({ manager_email: "<REDACTED_EMAIL>", status: "insufficient_data", delta: null }),
    ];
    const r = aggregateCEfx(sessions);
    expect(r.by_coach[0].avg_delta).toBeNull();
    expect(r.by_coach[0].sessions_insufficient).toBe(1);
  });
});

describe("fetchCoachingEffectiveness — query composition", () => {
  test("composes parameterized SQL with manager filter", async () => {
    let captured: { sql?: string; values?: any[] } = {};
    const pool = {
      query: async (sql: string, values: any[]) => {
        captured = { sql, values };
        return { rows: [] };
      },
    };
    await fetchCoachingEffectiveness(pool as unknown as import("pg").Pool, { managerEmail: "<REDACTED_EMAIL>", limit: 50 });
    expect(captured.values).toEqual(["<REDACTED_EMAIL>", 50]);
    expect(captured.sql).toContain("cs.manager_email = $1");
    expect(captured.sql).toContain("cs.status = 'delivered'");
    expect(captured.sql).toContain(`INTERVAL '${WINDOW_DAYS} days'`);
  });

  test("composes parameterized SQL with both manager + agent filters", async () => {
    let captured: { sql?: string; values?: any[] } = {};
    const pool = {
      query: async (sql: string, values: any[]) => {
        captured = { sql, values };
        return { rows: [] };
      },
    };
    await fetchCoachingEffectiveness(pool as unknown as import("pg").Pool, {
      managerEmail: "<REDACTED_EMAIL>",
      agentEmail: "<REDACTED_EMAIL>",
    });
    expect(captured.values?.[0]).toBe("<REDACTED_EMAIL>");
    expect(captured.values?.[1]).toBe("<REDACTED_EMAIL>");
    expect(captured.sql).toContain("cs.manager_email = $1");
    expect(captured.sql).toContain("cs.agent_email = $2");
  });

  test("hydrates the response from DB rows", async () => {
    const pool = {
      query: async () => ({
        rows: [
          {
            session_id: 1,
            agent_email: "<REDACTED_EMAIL>",
            agent_name: "SDR Name",
            manager_email: "<REDACTED_EMAIL>",
            manager_name: "Mgr Name",
            delivered_at: new Date("2026-01-15T00:00:00Z"),
            calls_before: 5,
            avg_score_before: 60,
            calls_after: 5,
            avg_score_after: 70,
          },
        ],
      }),
    };
    const r = await fetchCoachingEffectiveness(pool);
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0].delta).toBe(10);
    expect(r.sessions[0].status).toBe("ok");
    expect(r.by_coach).toHaveLength(1);
    expect(r.by_coach[0].avg_delta).toBe(10);
    expect(r.window_days).toBe(WINDOW_DAYS);
  });

  test("returns empty report when DB throws (logs warning)", async () => {
    const pool = {
      query: async () => {
        throw new Error("boom");
      },
    };
    const r = await fetchCoachingEffectiveness(pool);
    expect(r.sessions).toEqual([]);
    expect(r.by_coach).toEqual([]);
    expect(r.by_agent).toEqual([]);
  });

  test("clamps limit to 500", async () => {
    let captured: { sql?: string } = {};
    const pool = {
      query: async (sql: string) => {
        captured = { sql };
        return { rows: [] };
      },
    };
    await fetchCoachingEffectiveness(pool as unknown as import("pg").Pool, { limit: 99999 });
    expect(captured.sql).toContain("LIMIT $1");
  });
});
