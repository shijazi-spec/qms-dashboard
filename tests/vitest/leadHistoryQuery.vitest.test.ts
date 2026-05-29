/**
 * Unit tests for the lead-history query builder. Pure functions —
 * no DB. The fetchLeadHistory integration is exercised via a mock
 * pool so we cover the routing logic without a Postgres connection.
 *
 * Run: npx vitest run tests/vitest/leadHistoryQuery.vitest.test.ts
 */
import { describe, expect, test } from "vitest";
import {
  buildLookupSql,
  fetchLeadHistory,
  phoneToDigitSuffix,
  resolveLookupType,
  summarizeCalls,
} from "../../src/utils/leadHistoryQuery";

describe("phoneToDigitSuffix", () => {
  test("returns last 9 digits of a typical international number", () => {
    expect(phoneToDigitSuffix("+966 50 123 4567")).toBe("501234567");
  });
  test("returns last 9 digits of a local KSA number", () => {
    expect(phoneToDigitSuffix("0501234567")).toBe("501234567");
  });
  test("returns null for fewer than 9 digits", () => {
    expect(phoneToDigitSuffix("12345")).toBeNull();
    expect(phoneToDigitSuffix("1234567")).toBeNull();
    expect(phoneToDigitSuffix("")).toBeNull();
    expect(phoneToDigitSuffix("---")).toBeNull();
  });
  test("strips non-digit characters", () => {
    expect(phoneToDigitSuffix("(415) 555-012345")).toBe("555012345");
  });
});

describe("resolveLookupType", () => {
  test("ok for lead_id only", () => {
    const r = resolveLookupType({ lead_id: "12345" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.type).toBe("lead_id");
      expect(r.identifier).toBe("12345");
    }
  });
  test("ok for deal_id only", () => {
    const r = resolveLookupType({ deal_id: "abc-deal" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.type).toBe("deal_id");
  });
  test("ok for phone only", () => {
    const r = resolveLookupType({ phone: "+966501234567" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.type).toBe("phone");
  });
  test("error when none provided", () => {
    const r = resolveLookupType({});
    expect(r.ok).toBe(false);
  });
  test("error when more than one provided", () => {
    const r = resolveLookupType({ lead_id: "a", phone: "b" });
    expect(r.ok).toBe(false);
  });
  test("treats whitespace as empty", () => {
    const r = resolveLookupType({ lead_id: "   ", phone: "+966" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.type).toBe("phone");
  });
});

describe("buildLookupSql", () => {
  test("lead_id query is exactly parameterized", () => {
    const r = buildLookupSql("lead_id", "ZOHO_LEAD_42", 100);
    expect(r.sql).toBeTruthy();
    if (r.sql !== null) {
      expect(r.sql).toContain("cr.lead_id = $1");
      expect(r.values).toEqual(["ZOHO_LEAD_42"]);
    }
  });
  test("deal_id query targets deal column", () => {
    const r = buildLookupSql("deal_id", "ZOHO_DEAL_7", 50);
    if (r.sql !== null) {
      expect(r.sql).toContain("cr.deal_id = $1");
      expect(r.values).toEqual(["ZOHO_DEAL_7"]);
    }
  });
  test("phone query strips digits and matches LIKE on metadata", () => {
    const r = buildLookupSql("phone", "+966 50 123 4567", 200);
    if (r.sql !== null) {
      expect(r.sql).toContain("metadata->>'from_number'");
      expect(r.sql).toContain("metadata->>'to_number'");
      expect(r.values).toEqual(["%501234567"]);
    }
  });
  test("phone with fewer than 9 digits returns error, no SQL", () => {
    const r = buildLookupSql("phone", "1234567", 200);
    expect(r.sql).toBe(null);
    if (r.sql === null) {
      expect(r.error).toContain("9 digits");
    }
  });
  test("limit is clamped 1..500 and integer-floored", () => {
    const r1 = buildLookupSql("lead_id", "x", 0); // → 1
    const r500 = buildLookupSql("lead_id", "x", 9999); // → 500
    const rDefault = buildLookupSql("lead_id", "x", 200); // → 200
    if (r1.sql !== null) expect(r1.sql).toContain("LIMIT 1");
    if (r500.sql !== null) expect(r500.sql).toContain("LIMIT 500");
    if (rDefault.sql !== null) expect(rDefault.sql).toContain("LIMIT 200");
  });
  test("base SELECT joins to sdr_call_evaluations laterally", () => {
    const r = buildLookupSql("lead_id", "x", 10);
    if (r.sql !== null) {
      expect(r.sql).toContain("LEFT JOIN LATERAL");
      expect(r.sql).toContain("sdr_call_evaluations");
      expect(r.sql).toContain("overall_score");
    }
  });
});

describe("summarizeCalls", () => {
  test("empty input → zeros and null dates", () => {
    expect(summarizeCalls([])).toEqual({
      call_count: 0,
      unique_agents: 0,
      date_range: { earliest: null, latest: null },
    });
  });
  test("counts unique agent emails (ignores nulls)", () => {
    const rows: any[] = [
      { agent_email: "a@x.com", call_date: new Date("2026-05-01") },
      { agent_email: "a@x.com", call_date: new Date("2026-05-02") },
      { agent_email: "b@x.com", call_date: new Date("2026-05-03") },
      { agent_email: null, call_date: new Date("2026-05-04") },
    ];
    const s = summarizeCalls(rows);
    expect(s.call_count).toBe(4);
    expect(s.unique_agents).toBe(2);
  });
  test("computes correct earliest / latest across mixed dates", () => {
    const rows: any[] = [
      { agent_email: "a", call_date: new Date("2026-03-15") },
      { agent_email: "a", call_date: new Date("2026-01-01") },
      { agent_email: "a", call_date: new Date("2026-05-20") },
    ];
    const s = summarizeCalls(rows);
    expect(s.date_range.earliest?.toISOString()).toContain("2026-01-01");
    expect(s.date_range.latest?.toISOString()).toContain("2026-05-20");
  });
  test("ignores null and invalid dates in earliest/latest", () => {
    const rows: any[] = [
      { agent_email: "a", call_date: null },
      { agent_email: "a", call_date: "not-a-date" },
    ];
    const s = summarizeCalls(rows);
    expect(s.date_range.earliest).toBeNull();
    expect(s.date_range.latest).toBeNull();
  });
});

describe("fetchLeadHistory (with mock pool)", () => {
  test("returns 400 when no identifier provided", async () => {
    const pool = { query: async () => ({ rows: [] }) };
    const r = await fetchLeadHistory(pool, {});
    expect("error" in r).toBe(true);
    if ("error" in r) {
      expect(r.status).toBe(400);
    }
  });
  test("returns 400 when phone has fewer than 9 digits", async () => {
    const pool = { query: async () => ({ rows: [] }) };
    const r = await fetchLeadHistory(pool, { phone: "1234567" });
    expect("error" in r).toBe(true);
    if ("error" in r) {
      expect(r.status).toBe(400);
      expect(r.error).toContain("9 digits");
    }
  });
  test("calls pool.query with parameterized SQL on lead_id lookup", async () => {
    let captured: { sql?: string; values?: any[] } = {};
    const pool = {
      query: async (sql: string, values: any[]) => {
        captured = { sql, values };
        return { rows: [] };
      },
    };
    const r = await fetchLeadHistory(pool, { lead_id: "LEAD-1" });
    expect(captured.values).toEqual(["LEAD-1"]);
    expect(captured.sql).toContain("cr.lead_id = $1");
    expect("error" in r).toBe(false);
  });
  test("returns aggregate summary on success", async () => {
    const pool = {
      query: async () => ({
        rows: [
          {
            id: 1,
            agent_email: "a@x.com",
            call_date: new Date("2026-05-01"),
            overall_score: 80,
          },
          {
            id: 2,
            agent_email: "b@x.com",
            call_date: new Date("2026-05-02"),
            overall_score: null,
          },
        ],
      }),
    };
    const r = await fetchLeadHistory(pool, { lead_id: "X" });
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.call_count).toBe(2);
      expect(r.unique_agents).toBe(2);
      expect(r.calls).toHaveLength(2);
    }
  });
  test("returns 500 when pool throws", async () => {
    const pool = {
      query: async () => {
        throw new Error("boom");
      },
    };
    const r = await fetchLeadHistory(pool, { lead_id: "X" });
    expect("error" in r).toBe(true);
    if ("error" in r) {
      expect(r.status).toBe(500);
    }
  });
});
