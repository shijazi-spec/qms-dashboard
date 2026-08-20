/**
 * The AI-status chip on the cluster grid.
 *
 * getFilteredClusters only ever filtered on `c.status`, so the chip did nothing
 * there. Verified live 2026-08-19: active / dismissed / resolved /
 * tagged_pending / all each returned a total of 88,525 and the same first
 * cluster, always status 'active'. The per-row badges are computed client-side,
 * so the page looked filtered while the query was not — which is why dismissing
 * a cluster appeared to have no effect and the Dismissed tab listed active
 * clusters.
 *
 * Two separate gaps had to close: the route never read ai_status into its
 * filters, and this function never implemented it.
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

import { getFilteredClusters } from "../../src/utils/duplicateRadarDatabase";

/** The clusters SELECT (not the COUNT). */
const whereSql = () =>
  query.mock.calls.map((c) => String(c[0])).join("\n---\n");

beforeEach(() =>
  query.mockReset().mockResolvedValue({ rows: [{ count: "0" }], rowCount: 0 }),
);

describe("each chip produces a DIFFERENT predicate", () => {
  it("dismissed selects ignored clusters with no AI action", async () => {
    await getFilteredClusters({ ai_status: "dismissed" } as any);
    const sql = whereSql();
    expect(sql).toMatch(/c\.status = 'ignored'/);
    // Without this, an AI-applied cluster that was later ignored would show up
    // under Dismissed as though a human had judged it a false positive.
    expect(sql).toMatch(/NOT EXISTS[\s\S]*action_type IN \('resolve','module_resolved'\)/);
  });

  it("resolved selects only confirmed-resolved clusters", async () => {
    await getFilteredClusters({ ai_status: "resolved" } as any);
    expect(whereSql()).toMatch(/c\.status = 'resolved'/);
  });

  it("tagged_pending is applied-but-not-yet-gone", async () => {
    await getFilteredClusters({ ai_status: "tagged_pending" } as any);
    const sql = whereSql();
    // Explicitly NOT status='resolved': "Apply was clicked" is not "the admin
    // deleted the records".
    expect(sql).toMatch(/c\.status NOT IN \('resolved','ignored'\)/);
    expect(sql).toMatch(/auto_merge_pending/);
  });

  it("active is untouched — no AI action at all", async () => {
    await getFilteredClusters({ ai_status: "active" } as any);
    const sql = whereSql();
    expect(sql).toMatch(/c\.status = 'active'/);
    expect(sql).toMatch(/NOT EXISTS/);
  });

  it("all applies no status constraint", async () => {
    await getFilteredClusters({ ai_status: "all" } as any);
    expect(whereSql()).not.toMatch(/c\.status = /);
  });
});

describe("no chip keeps the original behaviour", () => {
  it("falls back to the parameterised status filter", async () => {
    await getFilteredClusters({ status: "resolved" } as any);
    const sql = whereSql();
    expect(sql).toMatch(/c\.status = \$1/);
    const params = query.mock.calls[0][1] as any[];
    expect(params[0]).toBe("resolved");
  });

  it("defaults to active when nothing is supplied", async () => {
    await getFilteredClusters({} as any);
    expect((query.mock.calls[0][1] as any[])[0]).toBe("active");
  });

  it("does not shift the placeholder numbering when a chip is used", async () => {
    // The chip predicates are literals, so $1 must not be consumed by a status
    // param that is no longer being sent — otherwise every later filter binds
    // to the wrong placeholder.
    await getFilteredClusters({ ai_status: "dismissed", domain: "acme.com" } as any);
    const params = query.mock.calls[0][1] as any[];
    expect(params[0]).not.toBe("active");
  });
});
