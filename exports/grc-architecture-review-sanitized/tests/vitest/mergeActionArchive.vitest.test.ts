/**
 * The AI-Applied backlog must survive a rebuild.
 *
 * /api/duplicates/rebuild runs TRUNCATE duplicate_records, duplicate_clusters
 * RESTART IDENTITY CASCADE, and duplicate_merge_actions.cluster_id is
 * ON DELETE CASCADE — so every "AI-Applied · pending CRMProvider admin delete" marker
 * is destroyed. backfillResolutionLedger does NOT cover it: that records only
 * the cluster's master id as "resolved", losing both the pending-vs-verified
 * distinction and which duplicates were tagged.
 *
 * Live verification on 2026-08-19 found 44 such clusters across all four
 * modules with ZERO records actually deleted in CRMProvider, so this backlog is real
 * outstanding work, not history.
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
  archiveMergeActions,
  restoreMergeActions,
  truncateAllDuplicateData,
} from "../../src/utils/duplicateRadarDatabase";

const sqlOf = (re: RegExp) =>
  query.mock.calls.map((c) => String(c[0])).find((s) => re.test(s));

beforeEach(() => query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 }));

describe("archive", () => {
  it("keys on CRMProvider ids, never cluster ids", async () => {
    await archiveMergeActions();
    const sql = sqlOf(/INSERT INTO duplicate_merge_actions_archive/i)!;
    // The rebuild renumbers clusters (RESTART IDENTITY), so a cluster_id key
    // would point at an unrelated cluster afterwards.
    expect(sql).toMatch(/master_CRMProvider_id/);
    expect(sql).toMatch(/merged_CRMProvider_ids/);
  });

  it("keeps the tagged duplicates, not just the master", async () => {
    await archiveMergeActions();
    const sql = sqlOf(/INSERT INTO duplicate_merge_actions_archive/i)!;
    // Which records were tagged for deletion is the part the resolution ledger
    // throws away.
    expect(sql).toMatch(/jsonb_agg\(dr2\.CRMProvider_record_id\)/);
  });

  it("preserves the action type so pending is not laundered into resolved", async () => {
    await archiveMergeActions();
    const sql = sqlOf(/INSERT INTO duplicate_merge_actions_archive/i)!;
    expect(sql).toMatch(/ma\.action_type/);
  });

  it("reports how many rows it saved", async () => {
    query.mockResolvedValue({ rows: [], rowCount: 37 });
    expect(await archiveMergeActions()).toBe(37);
  });
});

describe("the truncate cannot run without a snapshot", () => {
  it("archives BEFORE the TRUNCATE", async () => {
    const order: string[] = [];
    query.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (/INSERT INTO duplicate_merge_actions_archive/i.test(s)) order.push("archive");
      if (/TRUNCATE duplicate_records/i.test(s)) order.push("truncate");
      return { rows: [], rowCount: 0 };
    });
    await truncateAllDuplicateData();
    expect(order).toEqual(["archive", "truncate"]);
  });

  it("aborts the truncate when the archive throws", async () => {
    query.mockImplementation(async (sql: string) => {
      if (/INSERT INTO duplicate_merge_actions_archive/i.test(String(sql))) {
        throw new Error("archive failed");
      }
      return { rows: [], rowCount: 0 };
    });
    await expect(truncateAllDuplicateData()).rejects.toThrow(/archive failed/);
    // Losing the backlog is not something to discover after the fact.
    expect(sqlOf(/TRUNCATE duplicate_records/i)).toBeUndefined();
  });
});

describe("restore", () => {
  it("re-attaches by master CRMProvider id and module", async () => {
    await restoreMergeActions();
    const sql = sqlOf(/INSERT INTO duplicate_merge_actions\s*\n?\s*\(cluster_id/i)!;
    expect(sql).toMatch(/dr\.CRMProvider_record_id = a\.master_CRMProvider_id/);
    expect(sql).toMatch(/= a\.module/);
  });

  it("does not duplicate a marker the rescan already recreated", async () => {
    await restoreMergeActions();
    const sql = sqlOf(/INSERT INTO duplicate_merge_actions\s*\n?\s*\(cluster_id/i)!;
    expect(sql).toMatch(/NOT EXISTS/i);
  });

  it("leaves genuinely deleted records unrestored", async () => {
    await restoreMergeActions();
    const sql = sqlOf(/INSERT INTO duplicate_merge_actions\s*\n?\s*\(cluster_id/i)!;
    // An inner JOIN on the record: if the admin really deleted it, there is no
    // row to match and the cluster correctly does not come back as pending.
    expect(sql).toMatch(/JOIN duplicate_records dr/i);
    expect(sql).not.toMatch(/LEFT JOIN duplicate_records dr/i);
  });
});
