/**
 * Unit tests for the Zoho Lead phone matcher.
 *
 * ROOT-CAUSE GUARD (2026-05-29): a junk Zoho Lead with Phone="11" was
 * auto-linking to every call whose number merely ended in "11"
 * (e.g. +966505896511 → Lead "رايد الجحدلي" phone "11"). The matcher now
 * requires a full 9-digit subscriber-number overlap, and the input
 * validation across every phone-match entry point was raised to the same
 * MIN_PHONE_OVERLAP_DIGITS floor so a too-short query is reported clearly
 * instead of silently returning "No matches".
 *
 * Run: npx vitest run tests/vitest/callLeadPhoneMatch.vitest.test.ts
 */
import { afterEach, describe, expect, test } from "vitest";
import {
  MIN_PHONE_OVERLAP_DIGITS,
  phonesShareSubscriberNumber,
  findLeadsByPhoneMatch,
} from "../../src/utils/callLeadPhoneMatch";

describe("MIN_PHONE_OVERLAP_DIGITS", () => {
  test("is the 9-digit KSA/GCC subscriber-number floor", () => {
    expect(MIN_PHONE_OVERLAP_DIGITS).toBe(9);
  });
});

describe("phonesShareSubscriberNumber", () => {
  test("junk short phone (Phone=11) does NOT match a full number", () => {
    expect(phonesShareSubscriberNumber("11", "+966505896511")).toBe(false);
    expect(phonesShareSubscriberNumber("+966505896511", "11")).toBe(false);
  });
  test("matches when the full 9-digit subscriber number agrees", () => {
    // +966 vs leading-0 country-code variation, same subscriber 505896511.
    expect(phonesShareSubscriberNumber("+966505896511", "0505896511")).toBe(
      true,
    );
  });
  test("exact normalized equality matches", () => {
    expect(phonesShareSubscriberNumber("505896511", "505896511")).toBe(true);
  });
  test("equal junk values shorter than the floor do NOT match", () => {
    // Regression for the 2026-05-29 root-cause fix on the equality branch.
    // Both sides normalise to the same short value (e.g. Lead Phone="11"
    // and a call whose metadata only carries "11") and the original
    // `if (x === y) return true` bypassed the 9-digit floor. The historic
    // false-positive ("+966505896511" linked to a Junk Lead with Phone="11")
    // survives only because the bypass let exact-equality through. With
    // the floor now applied symmetrically, two-of-a-kind junk fails:
    expect(phonesShareSubscriberNumber("11", "11")).toBe(false);
    expect(phonesShareSubscriberNumber("123", "123")).toBe(false);
    expect(phonesShareSubscriberNumber("12345678", "12345678")).toBe(false); // 8 < 9
    // Exactly at the floor (9 digits) DOES still match — full subscriber.
    expect(phonesShareSubscriberNumber("505896511", "505896511")).toBe(true);
  });
  test("an 8-digit overlap is below the floor and does NOT match", () => {
    // Share only the last 8 digits (05896511) — one short of the floor.
    expect(phonesShareSubscriberNumber("966105896511", "966205896511")).toBe(
      false,
    );
  });
  test("empty / non-numeric inputs never match", () => {
    expect(phonesShareSubscriberNumber("", "505896511")).toBe(false);
    expect(phonesShareSubscriberNumber("---", "505896511")).toBe(false);
  });
});

describe("findLeadsByPhoneMatch — input guards (no Zoho needed)", () => {
  const saved = {
    token: process.env.ZOHO_ACCESS_TOKEN,
    id: process.env.ZOHO_CLIENT_ID,
    secret: process.env.ZOHO_CLIENT_SECRET,
    refresh: process.env.ZOHO_REFRESH_TOKEN,
  };
  afterEach(() => {
    if (saved.token === undefined) delete process.env.ZOHO_ACCESS_TOKEN;
    else process.env.ZOHO_ACCESS_TOKEN = saved.token;
    if (saved.id === undefined) delete process.env.ZOHO_CLIENT_ID;
    else process.env.ZOHO_CLIENT_ID = saved.id;
    if (saved.secret === undefined) delete process.env.ZOHO_CLIENT_SECRET;
    else process.env.ZOHO_CLIENT_SECRET = saved.secret;
    if (saved.refresh === undefined) delete process.env.ZOHO_REFRESH_TOKEN;
    else process.env.ZOHO_REFRESH_TOKEN = saved.refresh;
  });

  test("a sub-9-digit query returns a clear note, not silent empty", async () => {
    const r = await findLeadsByPhoneMatch("1234567");
    expect(r.matches).toEqual([]);
    expect(r.scanned).toBe(0);
    expect(r.note).toContain(`${MIN_PHONE_OVERLAP_DIGITS} digits`);
  });

  test("no digits at all returns a note", async () => {
    const r = await findLeadsByPhoneMatch("----");
    expect(r.matches).toEqual([]);
    expect(r.note).toBeTruthy();
  });

  test("Zoho-not-connected is surfaced distinctly from 'no matches'", async () => {
    delete process.env.ZOHO_ACCESS_TOKEN;
    delete process.env.ZOHO_CLIENT_ID;
    delete process.env.ZOHO_CLIENT_SECRET;
    delete process.env.ZOHO_REFRESH_TOKEN;
    const r = await findLeadsByPhoneMatch("+966505896511");
    expect(r.matches).toEqual([]);
    expect(r.scanned).toBe(0);
    expect(r.zoho_connected).toBe(false);
    expect(r.note).toContain("Zoho");
  });
});
