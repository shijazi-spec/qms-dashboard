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
    expect(isSyntheticDomain("alsahab.sa")).toBe(false);
    expect(isSyntheticDomain("example.com")).toBe(false);
    expect(isSyntheticDomain("anb.com.sa")).toBe(false);
    expect(isSyntheticDomain("alriyadh.gov.sa")).toBe(false);
  });

  test("case-insensitive", () => {
    expect(isSyntheticDomain("KFUPM.CLUSTER")).toBe(true);
    expect(isSyntheticDomain("Example.Com")).toBe(false);
  });
});

describe("normalizeProposed", () => {
  test("strips protocol and www", () => {
    expect(normalizeProposed("https://www.example.com")).toBe("example.com");
    expect(normalizeProposed("http://example.com")).toBe("example.com");
  });

  test("strips path", () => {
    expect(normalizeProposed("example.com/path/to")).toBe("example.com");
  });

  test("lowercases and trims", () => {
    expect(normalizeProposed("  Example.COM  ")).toBe("example.com");
  });

  test("returns null on empty input", () => {
    expect(normalizeProposed(null)).toBeNull();
    expect(normalizeProposed("")).toBeNull();
    expect(normalizeProposed("   ")).toBeNull();
  });

  test("preserves Saudi multi-level TLDs", () => {
    expect(normalizeProposed("https://anb.com.sa/")).toBe("anb.com.sa");
    expect(normalizeProposed("alriyadh.gov.sa")).toBe("alriyadh.gov.sa");
  });
});
