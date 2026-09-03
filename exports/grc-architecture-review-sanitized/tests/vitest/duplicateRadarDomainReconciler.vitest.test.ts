/**
 * Unit tests for the duplicate-radar domain reconciler's pure helpers.
 *
 * Run: npx vitest run tests/vitest/duplicateRadarDomainReconciler.vitest.test.ts
 *
 * Scope: deterministic helpers (isSyntheticDomain, normalizeProposed). The
 * full reconcileSyntheticClusterDomains pipeline touches the database and is
 * exercised manually against a live deployment.
 */
import { describe, expect, test } from "vitest";
import {
  isSyntheticDomain,
  normalizeProposed,
} from "../../src/utils/duplicateRadarDomainReconciler";

describe("isSyntheticDomain", () => {
  test("treats *.cluster as synthetic", () => {
    expect(isSyntheticDomain("kfupm.cluster")).toBe(true);
    expect(isSyntheticDomain("Saudi-Electric.cluster")).toBe(true);
  });

  test("treats anything without a dot as synthetic", () => {
    expect(isSyntheticDomain("kfupm")).toBe(true);
    expect(isSyntheticDomain("alsahab")).toBe(true);
  });

  test("treats null / empty / whitespace as synthetic", () => {
    expect(isSyntheticDomain(null)).toBe(true);
    expect(isSyntheticDomain(undefined)).toBe(true);
    expect(isSyntheticDomain("")).toBe(true);
    expect(isSyntheticDomain("   ")).toBe(true);
  });

  test("treats real domains as authoritative", () => {
    expect(isSyntheticDomain("<REDACTED_HOST>")).toBe(false);
    expect(isSyntheticDomain("<REDACTED_HOST>")).toBe(false);
    expect(isSyntheticDomain("<REDACTED_HOST>")).toBe(false);
    expect(isSyntheticDomain("<REDACTED_HOST>")).toBe(false);
  });

  test("case-insensitive", () => {
    expect(isSyntheticDomain("KFUPM.CLUSTER")).toBe(true);
    expect(isSyntheticDomain("<REDACTED_HOST>")).toBe(false);
  });
});

describe("normalizeProposed", () => {
  test("strips protocol and www", () => {
    expect(normalizeProposed("<REDACTED_URL>")).toBe("<REDACTED_HOST>");
    expect(normalizeProposed("<REDACTED_URL>")).toBe("<REDACTED_HOST>");
  });

  test("strips path", () => {
    expect(normalizeProposed("<REDACTED_HOST>/path/to")).toBe("<REDACTED_HOST>");
  });

  test("lowercases and trims", () => {
    expect(normalizeProposed("  <REDACTED_HOST>  ")).toBe("<REDACTED_HOST>");
  });

  test("returns null on empty input", () => {
    expect(normalizeProposed(null)).toBeNull();
    expect(normalizeProposed("")).toBeNull();
    expect(normalizeProposed("   ")).toBeNull();
  });

  test("preserves Saudi multi-level TLDs", () => {
    expect(normalizeProposed("<REDACTED_URL>")).toBe("<REDACTED_HOST>");
    expect(normalizeProposed("<REDACTED_HOST>")).toBe("<REDACTED_HOST>");
  });
});
