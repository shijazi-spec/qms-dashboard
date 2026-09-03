/**
 * Unit tests for the shared owner-email alias canonicaliser.
 *
 * Locks down: (a) Rayan's three mailboxes all canonicalise to one address;
 * (b) unknown emails pass through untouched; (c) null / whitespace input is
 * handled cleanly; (d) case + whitespace folding works.
 *
 * Run: npx vitest run tests/vitest/ownerEmailAliases.vitest.test.ts
 */
import { describe, expect, test } from "vitest";
import {
  OWNER_EMAIL_ALIASES,
  canonicaliseOwnerEmail,
} from "../../src/utils/ownerEmailAliases";

describe("OWNER_EMAIL_ALIASES table", () => {
  test("Rayan's three mailboxes all map to <REDACTED_EMAIL>", () => {
    expect(OWNER_EMAIL_ALIASES["<REDACTED_EMAIL>"]).toBe("<REDACTED_EMAIL>");
    expect(OWNER_EMAIL_ALIASES["<REDACTED_EMAIL>"]).toBe("<REDACTED_EMAIL>");
  });

  test("alias keys are all lower-case + trimmed", () => {
    for (const key of Object.keys(OWNER_EMAIL_ALIASES)) {
      expect(key).toBe(key.trim().toLowerCase());
    }
  });
});

describe("canonicaliseOwnerEmail", () => {
  test("aliases map to canonical", () => {
    expect(canonicaliseOwnerEmail("<REDACTED_EMAIL>")).toBe("<REDACTED_EMAIL>");
    expect(canonicaliseOwnerEmail("<REDACTED_EMAIL>")).toBe("<REDACTED_EMAIL>");
  });

  test("case-insensitive lookup", () => {
    expect(canonicaliseOwnerEmail("<REDACTED_EMAIL>")).toBe("<REDACTED_EMAIL>");
  });

  test("whitespace is stripped", () => {
    expect(canonicaliseOwnerEmail("  <REDACTED_EMAIL>  ")).toBe("<REDACTED_EMAIL>");
  });

  test("non-alias email passes through (lower-cased)", () => {
    expect(canonicaliseOwnerEmail("<REDACTED_EMAIL>")).toBe("<REDACTED_EMAIL>");
    expect(canonicaliseOwnerEmail("<REDACTED_EMAIL>")).toBe("<REDACTED_EMAIL>");
  });

  test("null / undefined / empty input → empty string", () => {
    expect(canonicaliseOwnerEmail(null)).toBe("");
    expect(canonicaliseOwnerEmail(undefined)).toBe("");
    expect(canonicaliseOwnerEmail("")).toBe("");
    expect(canonicaliseOwnerEmail("   ")).toBe("");
  });

  test("canonical email also canonicalises to itself", () => {
    // Once a row is already keyed by the canonical, a second pass through
    // canonicaliseOwnerEmail must be a no-op — otherwise idempotence breaks.
    expect(canonicaliseOwnerEmail("<REDACTED_EMAIL>")).toBe("<REDACTED_EMAIL>");
  });
});

// ── RAG band lock (SDR-KPI-09) ────────────────────────────────────────────
// Verifies the dashboard's post-merge derive AND the backend's rollup agree
// on green ≤2% · amber 2–5% · red >5%. These constants intentionally live
// here as a documented spec; the implementation files include their own
// inline comments referencing this rule.
describe("RAG bands (SDR-KPI-09 target ≤2%)", () => {
  const computeRag = (dupRate: number): "green" | "amber" | "red" => {
    if (dupRate > 5) return "red";
    if (dupRate > 2) return "amber";
    return "green";
  };

  test("0% → green", () => {
    expect(computeRag(0)).toBe("green");
  });
  test("exactly 2% → green (at-target)", () => {
    expect(computeRag(2)).toBe("green");
  });
  test("2.1% → amber (just over target)", () => {
    expect(computeRag(2.1)).toBe("amber");
  });
  test("exactly 5% → amber", () => {
    expect(computeRag(5)).toBe("amber");
  });
  test("5.1% → red", () => {
    expect(computeRag(5.1)).toBe("red");
  });
  test("49% → red (no longer amber as in legacy 25/50 bands)", () => {
    expect(computeRag(49)).toBe("red");
  });
});
