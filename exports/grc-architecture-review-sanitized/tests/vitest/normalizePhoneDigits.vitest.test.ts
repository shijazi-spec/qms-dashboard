/**
 * Unit tests for normalizePhoneDigits — the function that decides
 * whether two phone numbers represent the same subscriber when one
 * came from Five9/the dialer and the other came from Zoho.
 *
 * Run: npx vitest run tests/vitest/normalizePhoneDigits.vitest.test.ts
 *
 * The Saudi mobile subscriber portion is 9 digits starting with 5.
 * Examples from the field (all should normalize to "<REDACTED_PHONE>"):
 *   "<REDACTED_PHONE>"  E.164
 *   "<REDACTED_PHONE>"      E.164 digits only
 *   "<REDACTED_PHONE>"        Local with leading zero (Saudi convention)
 *   "<REDACTED_PHONE>"         Already normalized (9 digits)
 *
 * Plus one *partial* salvage case:
 *   "<REDACTED_PHONE>"       11-digit, "+966" with one missing digit —
 *                       real case from Screenshot 464. The function
 *                       returns the last 9 digits as a best-effort
 *                       fingerprint, but it CANNOT recover the
 *                       missing digit (the input genuinely has
 *                       only one `2` where the canonical has two).
 *                       See the dedicated test below.
 */
import { describe, expect, test } from "vitest";
import { normalizePhoneDigits } from "../../src/utils/callMcpReconciliation";

const CANONICAL = "<REDACTED_PHONE>"; // What everything should reduce to

describe("normalizePhoneDigits — Saudi number variants", () => {
  test("E.164 with + and spaces → canonical 9-digit subscriber", () => {
    expect(normalizePhoneDigits("<REDACTED_PHONE>")).toBe(CANONICAL);
  });
  test("E.164 digits only → canonical", () => {
    expect(normalizePhoneDigits("<REDACTED_PHONE>")).toBe(CANONICAL);
  });
  test("local with leading 0 → canonical", () => {
    expect(normalizePhoneDigits("<REDACTED_PHONE>")).toBe(CANONICAL);
  });
  test("already-canonical 9 digits → unchanged", () => {
    expect(normalizePhoneDigits("<REDACTED_PHONE>")).toBe(CANONICAL);
  });
  test(
    "Sample User's number (Screenshot 464) → salvage returns last 9 digits " +
      "(cannot recover missing digit — by design)",
    () => {
      // Input: <REDACTED_PHONE> digits) — operator typed `96` (2 digits)
      // instead of `+966` (3 digits) AND dropped one `2` from `5522`.
      // The salvage branch in normalizePhoneDigits returns the LAST 9
      // digits as a best-effort fingerprint that downstream fuzzy
      // matching can compare against the canonical 9-digit subscriber.
      // It can't reconstruct the canonical because the missing `2` is
      // genuinely gone — no algorithm can invent a digit the input
      // never had. Verifying we get the deterministic last-9-digit
      // slice so a future refactor doesn't silently change the salvage
      // behaviour without an explicit decision.
      expect(normalizePhoneDigits("<REDACTED_PHONE>")).toBe("<REDACTED_PHONE>");
    },
  );
});

describe("normalizePhoneDigits — edge cases", () => {
  test("null / undefined / empty → empty string", () => {
    expect(normalizePhoneDigits(null)).toBe("");
    expect(normalizePhoneDigits(undefined)).toBe("");
    expect(normalizePhoneDigits("")).toBe("");
  });
  test("non-digit garbage → empty string", () => {
    expect(normalizePhoneDigits("abc-xyz")).toBe("");
    expect(normalizePhoneDigits("---")).toBe("");
  });
  test("strips formatting chars (spaces, parens, dashes, dots)", () => {
    expect(normalizePhoneDigits("(<REDACTED_PHONE>")).toBe(CANONICAL);
  });
  test("very short input → returned as-is (best effort, lets caller decide)", () => {
    expect(normalizePhoneDigits("12345")).toBe("12345");
  });
});

describe("normalizePhoneDigits — non-Saudi numbers (regression safety)", () => {
  test("US 10-digit → returned as-is (no Saudi assumptions applied)", () => {
    expect(normalizePhoneDigits("<REDACTED_PHONE>")).toBe("<REDACTED_PHONE>");
  });
  test("US E.164 with leading 1 → leading 0 strip does NOT apply", () => {
    // length=11, starts with "1", neither branch hits → unchanged
    expect(normalizePhoneDigits("<REDACTED_PHONE>")).toBe("<REDACTED_PHONE>");
  });
  test("11-digit not starting with 96 → not salvaged (avoids false matches)", () => {
    // Important: the 11-digit "96" branch must NOT fire on US/EU numbers
    expect(normalizePhoneDigits("<REDACTED_PHONE>")).toBe("<REDACTED_PHONE>");
    expect(normalizePhoneDigits("<REDACTED_PHONE>")).toBe("<REDACTED_PHONE>");
  });
});

describe("normalizePhoneDigits — multiple leading zeros", () => {
  test("strips all leading zeros, not just one", () => {
    expect(normalizePhoneDigits("<REDACTED_PHONE>")).toBe(CANONICAL);
  });
});
