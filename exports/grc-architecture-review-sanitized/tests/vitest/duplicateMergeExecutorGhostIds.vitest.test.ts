/**
 * Unit tests for the agentic-apply ghost-id soft-delete behaviour.
 *
 * Run: npx vitest run tests/vitest/duplicateMergeExecutorGhostIds.vitest.test.ts
 *
 * Background: when an operator triggers Agentic Resolution on an Accounts
 * cluster and one of the duplicate ids has already been deleted in CRMProvider,
 * the per-record operations (fetch related-list / stamp note / link lookup)
 * all 400 with "the related id given seems to be invalid". Pre-fix the
 * executor surfaced ~4 red errors PER ghost id; post-fix it detects the
 * pattern on the first failing op, tags the local row stale_pending, skips
 * the remaining ops for that id, and surfaces a single info-level warning.
 *
 * No real CRMProvider calls, no real DB writes — CRMProviderCRM and duplicateRadarDatabase
 * are mocked via vi.mock (hoisted) so the executor sees fakes that throw the
 * exact error string CRMProvider returns.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const GHOST_ERROR_MSG = "the related id given seems to be invalid";
const NON_GHOST_400_MSG = "400 — required field missing";

// vi.mock() is hoisted, so the factory must construct everything inline.
vi.mock("../../src/utils/CRMProviderCRM", () => ({
  updateCRMProviderRecord: vi.fn(async () => undefined),
  fetchCRMProviderRelatedRecords: vi.fn(async () => [] as Array<{ id: string; <REDACTED_SCHEME> any }>),
  addCRMProviderTags: vi.fn(async () => undefined),
  addCRMProviderNote: vi.fn(async () => undefined),
  CRMProviderWritesAllowedInEnv: vi.fn(() => true),
}));

vi.mock("../../src/utils/duplicateRadarDatabase", () => ({
  captureClusterSnapshot: vi.fn(async () => 1),
  resolveCluster: vi.fn(async () => undefined),
  markPrimaryRecord: vi.fn(async () => undefined),
  recordPartialMergeAction: vi.fn(async () => undefined),
  recordResolutionLedgerEntry: vi.fn(async () => undefined),
  markRecordStalePending: vi.fn(async () => true),
}));

import * as CRMProviderCRM from "../../src/utils/CRMProviderCRM";
import * as radarDb from "../../src/utils/duplicateRadarDatabase";
import {
  executeMergePlan,
  isGhostRecordError,
} from "../../src/utils/duplicateMergeExecutor";

// Typed mock handles
const updateCRMProviderRecord = vi.mocked(CRMProviderCRM.updateCRMProviderRecord);
const fetchCRMProviderRelatedRecords = vi.mocked(CRMProviderCRM.fetchCRMProviderRelatedRecords);
const addCRMProviderTags = vi.mocked(CRMProviderCRM.addCRMProviderTags);
const addCRMProviderNote = vi.mocked(CRMProviderCRM.addCRMProviderNote);
const CRMProviderWritesAllowedInEnv = vi.mocked(CRMProviderCRM.CRMProviderWritesAllowedInEnv);
const markRecordStalePending = vi.mocked(radarDb.markRecordStalePending);

function basePlan(overrides: Record<string, unknown> = {}) {
  return {
    clusterId: 42,
    module: "Accounts" as const,
    masterCRMProviderId: "<REDACTED_ID>",
    masterDbId: 100,
    masterName: "Survivor Co.",
    tagName: "Duplicate-Delete",
    duplicateCRMProviderIds: [] as string[],
    duplicateDbIds: [] as number[],
    cascadeOnlyCRMProviderIds: [] as string[],
    linkAccountCRMProviderId: null,
    fieldDecisions: [],
    warnings: [],
    generatedAt: "2026-06-15T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  updateCRMProviderRecord.mockReset().mockResolvedValue(undefined as any);
  fetchCRMProviderRelatedRecords.mockReset().mockResolvedValue([] as any);
  addCRMProviderTags.mockReset().mockResolvedValue(undefined as any);
  addCRMProviderNote.mockReset().mockResolvedValue(undefined as any);
  CRMProviderWritesAllowedInEnv.mockReset().mockReturnValue(true);
  markRecordStalePending.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("isGhostRecordError — pure pattern matcher", () => {
  test("matches the exact CRMProvider 400 wording (case-insensitive)", () => {
    expect(isGhostRecordError(new Error(GHOST_ERROR_MSG))).toBe(true);
    expect(
      isGhostRecordError(new Error("CRMProvider note error: 400 - " + GHOST_ERROR_MSG)),
    ).toBe(true);
    expect(
      isGhostRecordError(new Error("The Related ID Given Seems To Be Invalid")),
    ).toBe(true);
  });

  test("does NOT match unrelated 400 errors", () => {
    expect(isGhostRecordError(new Error(NON_GHOST_400_MSG))).toBe(false);
    expect(isGhostRecordError(new Error("rate limit exceeded"))).toBe(false);
    expect(isGhostRecordError(new Error("404 not found"))).toBe(false);
  });

  test("safe on null/undefined/empty", () => {
    expect(isGhostRecordError(null)).toBe(false);
    expect(isGhostRecordError(undefined)).toBe(false);
    expect(isGhostRecordError("")).toBe(false);
  });

  test("accepts string errors (not just Error instances)", () => {
    expect(isGhostRecordError("the related id given seems to be invalid")).toBe(
      true,
    );
  });
});

describe("executeMergePlan — ghost id routes to stale_pending instead of errors", () => {
  test("single ghost dup: zero errors, one staleDropped, one warning, markRecordStalePending called once", async () => {
    const ghostId = "<REDACTED_ID>";
    fetchCRMProviderRelatedRecords.mockRejectedValue(new Error(GHOST_ERROR_MSG));
    addCRMProviderNote.mockImplementation(async (_m, recordId) => {
      if (recordId === ghostId) throw new Error(GHOST_ERROR_MSG);
      return undefined as any;
    });

    const report = await executeMergePlan(
      basePlan({ duplicateCRMProviderIds: [ghostId] }) as any,
      { performedBy: "test", dryRun: false },
    );

    expect(report.errors).toEqual([]);
    expect(report.staleDropped).toEqual([ghostId]);
    expect(report.warnings.some((w) => w.includes("auto-cleaned"))).toBe(true);
    expect(report.warnings.some((w) => w.includes(ghostId))).toBe(true);
    expect(markRecordStalePending).toHaveBeenCalledTimes(1);
    expect(markRecordStalePending).toHaveBeenCalledWith("Accounts", ghostId);
  });

  test("first ghost-op skips remaining ops for the same id (no addCRMProviderNote call after the fetch failure)", async () => {
    const ghostId = "<REDACTED_ID>";
    fetchCRMProviderRelatedRecords.mockRejectedValue(new Error(GHOST_ERROR_MSG));

    await executeMergePlan(
      basePlan({ duplicateCRMProviderIds: [ghostId] }) as any,
      { performedBy: "test", dryRun: false },
    );

    const stampCallsForGhost = addCRMProviderNote.mock.calls.filter(
      (c) => c[1] === ghostId,
    );
    expect(stampCallsForGhost).toHaveLength(0);
  });

  test("dry-run: ghost detected, staleDropped populated, but markRecordStalePending NOT called", async () => {
    const ghostId = "<REDACTED_ID>";
    fetchCRMProviderRelatedRecords.mockRejectedValue(new Error(GHOST_ERROR_MSG));

    const report = await executeMergePlan(
      basePlan({ duplicateCRMProviderIds: [ghostId] }) as any,
      { performedBy: "test", dryRun: true },
    );

    expect(report.staleDropped).toEqual([ghostId]);
    expect(markRecordStalePending).not.toHaveBeenCalled();
  });

  test("real (non-ghost) 400 still surfaces as a red error", async () => {
    const liveDupId = "<REDACTED_ID>";
    fetchCRMProviderRelatedRecords.mockRejectedValue(new Error(NON_GHOST_400_MSG));

    const report = await executeMergePlan(
      basePlan({ duplicateCRMProviderIds: [liveDupId] }) as any,
      { performedBy: "test", dryRun: false },
    );

    expect(report.staleDropped).toEqual([]);
    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.errors[0].message).toContain(NON_GHOST_400_MSG);
    expect(report.warnings.some((w) => w.includes("auto-cleaned"))).toBe(false);
  });

  test("multiple ghost dups: each id appears once in staleDropped, one combined warning", async () => {
    const ghostIds = [
      "<REDACTED_ID>",
      "<REDACTED_ID>",
      "<REDACTED_ID>",
    ];
    fetchCRMProviderRelatedRecords.mockRejectedValue(new Error(GHOST_ERROR_MSG));
    addCRMProviderNote.mockImplementation(async (_m, recordId) => {
      if (ghostIds.includes(recordId)) throw new Error(GHOST_ERROR_MSG);
      return undefined as any;
    });

    const report = await executeMergePlan(
      basePlan({ duplicateCRMProviderIds: ghostIds }) as any,
      { performedBy: "test", dryRun: false },
    );

    expect([...report.staleDropped].sort()).toEqual([...ghostIds].sort());
    expect(report.staleDropped.length).toBe(ghostIds.length);
    expect(report.errors).toEqual([]);
    const cleanupWarnings = report.warnings.filter((w) =>
      w.includes("auto-cleaned"),
    );
    expect(cleanupWarnings).toHaveLength(1);
    expect(markRecordStalePending).toHaveBeenCalledTimes(ghostIds.length);
  });

  test("clean run with no ghosts: no auto-cleaned warning, staleDropped empty", async () => {
    const report = await executeMergePlan(
      basePlan({ duplicateCRMProviderIds: ["<REDACTED_ID>"] }) as any,
      { performedBy: "test", dryRun: false },
    );

    expect(report.staleDropped).toEqual([]);
    expect(report.warnings.some((w) => w.includes("auto-cleaned"))).toBe(false);
  });

  test("warning truncates to first 5 ids + count of the rest when >5 ghosts", async () => {
    const ghostIds = Array.from(
      { length: 7 },
      (_, i) => `<REDACTED_PHONE>${800000 + i}`,
    );
    fetchCRMProviderRelatedRecords.mockRejectedValue(new Error(GHOST_ERROR_MSG));
    addCRMProviderNote.mockImplementation(async (_m, recordId) => {
      if (ghostIds.includes(recordId)) throw new Error(GHOST_ERROR_MSG);
      return undefined as any;
    });

    const report = await executeMergePlan(
      basePlan({ duplicateCRMProviderIds: ghostIds }) as any,
      { performedBy: "test", dryRun: false },
    );

    expect(report.staleDropped).toHaveLength(7);
    const w = report.warnings.find((w) => w.includes("auto-cleaned"));
    expect(w).toBeDefined();
    expect(w!).toContain("+2 more");
    expect(w!).toContain(ghostIds[0]);
    expect(w!).toContain(ghostIds[4]);
    expect(w!).not.toContain(ghostIds[5]);
  });
});
