/**
 * Pins the semantics of the nav bell's "Mark all read" for consultant alerts.
 *
 * The bell badge sums notifications with getUnreadAlertCount(), which counts
 * ai_alerts rows in status 'open'. Clearing the badge therefore has to write to
 * ai_alerts too — and the ONLY defensible write is an acknowledge.
 *
 * Bulk-resolving would stamp ~27k governance findings as dealt with when
 * nothing was actually done, which is exactly what these assertions exist to
 * prevent someone from doing later by "simplifying" the query.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const query = vi.fn();

vi.mock("../../src/utils/sharedPool", () => ({
  // `connect` has to exist: aiAlertsDatabase runs the pool through
  // wrapPoolForRedaction, which binds it at import time.
  sharedPool: {
    query: (...a: any[]) => query(...a),
    connect: async () => {
      throw new Error("unused in this test");
    },
  },
}));
vi.mock("../../src/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { acknowledgeAllOpenAlerts } from "../../src/utils/aiAlertsDatabase";

beforeEach(() => {
  query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
});

/** The UPDATE statement the call issues, whitespace-collapsed. */
async function capturedSql(by = "sarah@walaplus.com"): Promise<string> {
  await acknowledgeAllOpenAlerts(by);
  expect(query).toHaveBeenCalledTimes(1);
  return String(query.mock.calls[0][0]).replace(/\s+/g, " ").trim();
}

describe("acknowledgeAllOpenAlerts", () => {
  it("acknowledges — it never resolves or dismisses", async () => {
    const sql = await capturedSql();
    expect(sql).toMatch(/SET\s+status\s*=\s*'acknowledged'/i);
    expect(sql).not.toMatch(/status\s*=\s*'resolved'/i);
    expect(sql).not.toMatch(/status\s*=\s*'dismissed'/i);
    // Acknowledging must not backfill resolution fields either — an
    // acknowledged alert is still outstanding work in the feed.
    expect(sql).not.toMatch(/resolved_at/i);
    expect(sql).not.toMatch(/resolution_note/i);
  });

  it("only touches rows still open, so it is idempotent and preserves the original triager", async () => {
    const sql = await capturedSql();
    expect(sql).toMatch(/WHERE\s+status\s*=\s*'open'/i);
  });

  it("never issues an unguarded table-wide UPDATE", async () => {
    const sql = await capturedSql();
    expect(sql).toMatch(/\bWHERE\b/i);
    expect(sql).toMatch(/UPDATE\s+ai_alerts/i);
  });

  it("records who acknowledged, as a bound parameter", async () => {
    await acknowledgeAllOpenAlerts("sarah@walaplus.com");
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toMatch(/acknowledged_by\s*=\s*\$1/);
    expect(params).toEqual(["sarah@walaplus.com"]);
    // Interpolating the name into the SQL would be an injection vector.
    expect(String(sql)).not.toContain("sarah@walaplus.com");
  });

  it("reports how many rows changed, and copes with a null rowCount", async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 27366 });
    await expect(acknowledgeAllOpenAlerts("a@b.com")).resolves.toBe(27366);

    query.mockResolvedValueOnce({ rows: [], rowCount: null });
    await expect(acknowledgeAllOpenAlerts("a@b.com")).resolves.toBe(0);
  });
});
