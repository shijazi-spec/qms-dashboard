/**
 * Unit tests for normalizePhoneDigits — the function that decides
 * whether two phone numbers represent the same subscriber when one
 * came from Five9/the dialer and the other came from Zoho.
 *
 * Run: npx vitest run tests/vitest/normalizePhoneDigits.vitest.test.ts
 *
 * The Saudi mobile subscriber portion is 9 digits starting with 5.
 * Examples from the field (all should normalize to "505522305"):
 *   "+966 50 552 2305"  E.164
 *   "966505522305"      E.164 digits only
 *   "0505522305"        Local with leading zero (Saudi convention)
 *   "505522305"         Already normalized (9 digits)
 *   "96050552305"       Salvage: 11-digit, "+966" with one missing
 *                       digit — real case from Screenshot 464.
 */
import { describe, expect, test } from "vitest";
import { normalizePhoneDigits } from "../../src/utils/callMcpReconciliation";

const CANONICAL = "505522305"; // What everything should reduce to

describe("normalizePhoneDigits — Saudi number variants", () => {
  test("E.164 with + and spaces → canonical 9-digit subscriber", () => {
    expect(normalizePhoneDigits("+966 50 552 2305")).toBe(CANONICAL);
  });
  test("E.164 digits only → canonical", () => {
    expect(normalizePhoneDigits("966505522305")).toBe(CANONICAL);
  });
  test("local with leading 0 → canonical", () => {
    expect(normalizePhoneDigits("0505522305")).toBe(CANONICAL);
  });
  test("already-canonical 9 digits → unchanged", () => {
    expect(normalizePhoneDigits("505522305")).toBe(CANONICAL);
  });
  test("Mohammed Alsulami's number (Screenshot 464) → canonical via salvage branch", () => {
    expect(normalizePhoneDigits("96050552305")).toBe(CANONICAL);
  });
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
    expect(normalizePhoneDigits("(966) 50.552-2305")).toBe(CANONICAL);
  });
  test("very short input → returned as-is (best effort, lets caller decide)", () => {
    expect(normalizePhoneDigits("12345")).toBe("12345");
  });
});

describe("normalizePhoneDigits — non-Saudi numbers (regression safety)", () => {
  test("US 10-digit → returned as-is (no Saudi assumptions applied)", () => {
    expect(normalizePhoneDigits("4155550123")).toBe("4155550123");
  });
  test("US E.164 with leading 1 → leading 0 strip does NOT apply", () => {
    // length=11, starts with "1", neither branch hits → unchanged
    expect(normalizePhoneDigits("14155550123")).toBe("14155550123");
  });
  test("11-digit not starting with 96 → not salvaged (avoids false matches)", () => {
    // Important: the 11-digit "96" branch must NOT fire on US/EU numbers
    expect(normalizePhoneDigits("12345678901")).toBe("12345678901");
    expect(normalizePhoneDigits("44123456789")).toBe("44123456789");
  });
});

describe("normalizePhoneDigits — multiple leading zeros", () => {
  test("strips all leading zeros, not just one", () => {
    expect(normalizePhoneDigits("00505522305")).toBe(CANONICAL);
  });
});
