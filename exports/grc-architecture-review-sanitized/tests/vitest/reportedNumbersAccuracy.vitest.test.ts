/**
 * Three numbers that were reported wrong, all found on 2026-08-20 by comparing
 * what the platform showed against what the ChatProvider digest and the tiles claimed.
 *
 * They are grouped in one file because they share a root cause: a figure was
 * computed with a different rule from the one its own label promised.
 */
import { describe, it, expect } from "vitest";
import { shapeCleaningProgress } from "../../src/utils/dataCleaningProgress";

describe("Empty/messy records deleted — 'all layouts' must mean all layouts", () => {
  const base = {
    segment: "all",
    generatedAt: "2026-08-20T00:00:00.000Z",
    lastSyncAt: null,
    resolveRows: [],
    outstanding: { Deals: 0, Accounts: 0 },
    trend: { days: 30, segment: "all", series: [], first: null, latest: null },
  };

  it("counts a Contacts-only cleanup", () => {
    // The live tenant: every confirmed deletion is Contacts. The old query
    // filtered module IN ('Deals','Accounts'), so the tile read 0 while the
    // tagged list next to it said 253 deleted.
    const out = shapeCleaningProgress({
      ...base,
      emptyDeleted: { Deals: 0, Accounts: 0, Contacts: 253 },
    } as any);
    expect(out.empty_deleted_total).toBe(253);
  });

  it("still counts Deals and Accounts", () => {
    const out = shapeCleaningProgress({
      ...base,
      emptyDeleted: { Deals: 5, Accounts: 7 },
    } as any);
    expect(out.empty_deleted_total).toBe(12);
  });

  it("sums every module together, including Leads", () => {
    const out = shapeCleaningProgress({
      ...base,
      emptyDeleted: { Deals: 1, Accounts: 2, Contacts: 3, Leads: 4 },
    } as any);
    expect(out.empty_deleted_total).toBe(10);
  });

  it("keeps the per-module cards on Deals and Accounts", () => {
    const out = shapeCleaningProgress({
      ...base,
      emptyDeleted: { Deals: 5, Accounts: 7, Contacts: 253 },
    } as any);
    // The two module cards are unchanged — only the "all layouts" headline
    // was ever meant to span every module.
    expect(out.modules.Deals.empty_deleted).toBe(5);
    expect(out.modules.Accounts.empty_deleted).toBe(7);
  });

  it("is 0, not NaN, when nothing has been deleted", () => {
    const out = shapeCleaningProgress({ ...base, emptyDeleted: {} } as any);
    expect(out.empty_deleted_total).toBe(0);
  });
});

/**
 * Duplicate Resolution Rate.
 *
 * true_dup_clusters counts every cluster with GREATEST(total_*) > 1 and applies
 * NO status filter, so it already contains the resolved and ignored ones.
 * Adding them to the denominator counted every closed cluster twice.
 *
 * Live 2026-08-20: active 7,934 + resolved 1,704 + ignored 689 = 10,327, which
 * is exactly true_dup_clusters — the proof they are already inside it.
 */
describe("Duplicate Resolution Rate denominator", () => {
  const rate = (trueDup: number, resolved: number, ignored: number) =>
    trueDup > 0 ? Math.round(((resolved + ignored) / trueDup) * 100) : 0;
  const oldRate = (trueDup: number, resolved: number, ignored: number) => {
    const d = trueDup + resolved + ignored;
    return d > 0 ? Math.round(((resolved + ignored) / d) * 100) : 0;
  };

  it("uses the true-duplicate universe as the denominator", () => {
    expect(rate(10327, 1704, 689)).toBe(23);
  });

  it("no longer double-counts closed clusters", () => {
    // What the tile actually displayed.
    expect(oldRate(10327, 1704, 689)).toBe(19);
    expect(rate(10327, 1704, 689)).toBeGreaterThan(oldRate(10327, 1704, 689));
  });

  it("reports 100% when every duplicate cluster is closed", () => {
    // The old formula could never reach 100: with 0 active it still returned
    // 50%, so a fully cleaned tenant looked half done.
    expect(rate(2393, 1704, 689)).toBe(100);
    expect(oldRate(2393, 1704, 689)).toBe(50);
  });

  it("reports 0% when nothing has been closed", () => {
    expect(rate(10327, 0, 0)).toBe(0);
  });

  it("does not divide by zero on an empty tenant", () => {
    expect(rate(0, 0, 0)).toBe(0);
  });
});
