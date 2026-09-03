/**
 * Pruning our mirror copy of records Zoho no longer has.
 *
 * Two bugs here produced "Already deleted in Zoho — removed. (Mirror prune did
 * not confirm; it may reappear until the next sweep.)" on records that really
 * had been deleted, observed live 2026-08-19:
 *
 *  - duplicate_merge_actions.primary_record_id REFERENCES duplicate_records(id)
 *    with no ON DELETE clause, so the delete raised a foreign-key violation,
 *    the caller logged it as non-fatal, and the record came back forever.
 *  - the empty_delete_ledger row was DELETED, erasing the audit trail that
 *    Data Cleaning Progress counts — which is why "Empty/messy records deleted"
 *    read 0 while the tagged list showed 253 deleted.
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

import { pruneGhostRecords } from "../../src/utils/emptyRecordsDatabase";

const sqls = () => query.mock.calls.map((c) => String(c[0]));
const find = (re: RegExp) => sqls().find((s) => re.test(s));

beforeEach(() => query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 }));

describe("the foreign key that blocked the delete", () => {
  it("detaches merge actions BEFORE deleting the mirror row", async () => {
    await pruneGhostRecords(["123"]);
    const order = sqls().map((s) =>
      /UPDATE duplicate_merge_actions/i.test(s) ? "detach"
        : /DELETE FROM duplicate_records/i.test(s) ? "delete" : "other",
    ).filter((x) => x !== "other");
    // Reverse this and Postgres refuses the delete, which is precisely how the
    // record survived and reappeared on every refresh.
    expect(order).toEqual(["detach", "delete"]);
  });

  it("keeps the merge action itself, only nulls the pointer", async () => {
    await pruneGhostRecords(["123"]);
    const sql = find(/UPDATE duplicate_merge_actions/i)!;
    expect(sql).toMatch(/SET primary_record_id = NULL/i);
    // The action is the evidence someone tagged the record; deleting it would
    // destroy the AI-Applied trail along with the ghost.
    expect(sqls().some((s) => /DELETE FROM duplicate_merge_actions/i.test(s))).toBe(false);
  });
});

describe("the audit trail", () => {
  it("MARKS the ledger row deleted instead of removing it", async () => {
    await pruneGhostRecords(["123"]);
    const sql = find(/empty_delete_ledger/i)!;
    expect(sql).toMatch(/UPDATE empty_delete_ledger/i);
    expect(sql).toMatch(/status = 'deleted'/);
    // Data Cleaning Progress counts status='deleted' from this table. Deleting
    // the row erased the proof that the record was ever cleaned.
    expect(sqls().some((s) => /DELETE FROM empty_delete_ledger/i.test(s))).toBe(false);
  });

  it("does not overwrite an existing deleted_at", async () => {
    await pruneGhostRecords(["123"]);
    expect(find(/empty_delete_ledger/i)!).toMatch(/COALESCE\(deleted_at, NOW\(\)\)/);
  });
});

describe("the cluster counters", () => {
  // duplicate_clusters.total_* are denormalised and set during clustering, but
  // every post-sync sweep prunes AFTER that. Leaving them alone meant the
  // 2026-08-20 full sync wrote 160,614 records while SUM(total_records) still
  // read 160,987. total_deals is the one that bites: `c.total_deals > 1` gates
  // the Amount-at-risk query.
  const withCluster = () =>
    query.mockReset().mockImplementation((sql: string) =>
      /SELECT DISTINCT cluster_id/i.test(String(sql))
        ? Promise.resolve({ rows: [{ cluster_id: 42 }], rowCount: 1 })
        : Promise.resolve({ rows: [], rowCount: 0 }),
    );

  it("collects the affected clusters BEFORE deleting the rows", async () => {
    withCluster();
    await pruneGhostRecords(["123"]);
    const order = sqls()
      .map((s) =>
        /SELECT DISTINCT cluster_id/i.test(s) ? "collect"
          : /DELETE FROM duplicate_records/i.test(s) ? "delete" : "other",
      )
      .filter((x) => x !== "other");
    // After the delete there is no row left to join back to, so a collect that
    // runs second always returns an empty set and silently fixes nothing.
    expect(order).toEqual(["collect", "delete"]);
  });

  it("recomputes every counter, not just total_records", async () => {
    withCluster();
    await pruneGhostRecords(["123"]);
    const sql = find(/UPDATE duplicate_clusters/i)!;
    for (const col of [
      "total_records",
      "total_leads",
      "total_deals",
      "total_contacts",
      "total_accounts",
    ]) {
      expect(sql).toMatch(new RegExp(`${col}\\s*=`));
    }
  });

  it("recomputes from surviving rows rather than decrementing", async () => {
    withCluster();
    await pruneGhostRecords(["123"]);
    const sql = find(/UPDATE duplicate_clusters/i)!;
    // A decrement only stops the gap growing; recomputing also heals the drift
    // that earlier prunes already left behind.
    expect(sql).toMatch(/COUNT\(\*\)/);
    expect(sql).not.toMatch(/total_records\s*=\s*total_records\s*-/);
  });

  it("zeroes a cluster whose every record was pruned", async () => {
    withCluster();
    await pruneGhostRecords(["123"]);
    const sql = find(/UPDATE duplicate_clusters/i)!;
    // An emptied cluster drops out of the GROUP BY entirely, so an inner join
    // would leave its counters frozen at the pre-prune value.
    expect(sql).toMatch(/LEFT JOIN/i);
    expect(sql).toMatch(/COALESCE\(s\.n, 0\)/);
  });

  it("runs the recompute AFTER the delete", async () => {
    withCluster();
    await pruneGhostRecords(["123"]);
    const order = sqls()
      .map((s) =>
        /DELETE FROM duplicate_records/i.test(s) ? "delete"
          : /UPDATE duplicate_clusters/i.test(s) ? "recount" : "other",
      )
      .filter((x) => x !== "other");
    expect(order).toEqual(["delete", "recount"]);
  });

  it("skips the recompute when no cluster is affected", async () => {
    // Orphan records (cluster_id NULL) must not trigger a pointless UPDATE
    // against an empty id array.
    query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    await pruneGhostRecords(["123"]);
    expect(sqls().some((s) => /UPDATE duplicate_clusters/i.test(s))).toBe(false);
  });
});

describe("input handling", () => {
  it("issues no query for an empty list", async () => {
    await pruneGhostRecords([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("drops blank ids rather than sending them", async () => {
    await pruneGhostRecords(["", "  ".trim(), "77"] as string[]);
    const params = query.mock.calls[0][1] as any[];
    expect(params[0]).toEqual(["77"]);
  });
});
