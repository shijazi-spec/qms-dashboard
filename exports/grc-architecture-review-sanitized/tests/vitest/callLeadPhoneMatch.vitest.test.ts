/**
 * Unit tests for the CRMProvider Lead phone matcher.
 *
 * ROOT-CAUSE GUARD (2026-05-29): a junk CRMProvider Lead with Phone="11" was
 * auto-linking to every call whose number merely ended in "11"
 * (e.g. <REDACTED_PHONE>→ Lead "رايد الجحدلي" phone "11"). The matcher now
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
    expect(phonesShareSubscriberNumber("11", "<REDACTED_PHONE>")).toBe(false);
    expect(phonesShareSubscriberNumber("<REDACTED_PHONE>", "11")).toBe(false);
  });
  test("matches when the full 9-digit subscriber number agrees", () => {
    // +966 vs leading-0 country-code variation, same subscriber <REDACTED_PHONE> expect(phonesShareSubscriberNumber("<REDACTED_PHONE>", "<REDACTED_PHONE>")).toBe(
      true,
    );
  });
  test("exact normalized equality matches", () => {
    expect(phonesShareSubscriberNumber("<REDACTED_PHONE>", "<REDACTED_PHONE>")).toBe(true);
  });
  test("equal junk values shorter than the floor do NOT match", () => {
    // Regression for the 2026-05-29 root-cause fix on the equality branch.
    // Both sides normalise to the same short value (e.g. Lead Phone="11"
    // and a call whose metadata only carries "11") and the original
    // `if (x === y) return true` bypassed the 9-digit floor. The historic
    // false-positive ("<REDACTED_PHONE>" linked to a Junk Lead with Phone="11")
    // survives only because the bypass let exact-equality through. With
    // the floor now applied symmetrically, two-of-a-kind junk fails:
    expect(phonesShareSubscriberNumber("11", "11")).toBe(false);
    expect(phonesShareSubscriberNumber("123", "123")).toBe(false);
    expect(phonesShareSubscriberNumber("12345678", "12345678")).toBe(false); // 8 < 9
    // Exactly at the floor (9 digits) DOES still match — full subscriber.
    expect(phonesShareSubscriberNumber("<REDACTED_PHONE>", "<REDACTED_PHONE>")).toBe(true);
  });
  test("an 8-digit overlap is below the floor and does NOT match", () => {
    // Share only the last 8 digits (05896511) — one short of the floor.
    expect(phonesShareSubscriberNumber("<REDACTED_PHONE>", "<REDACTED_PHONE>")).toBe(
      false,
    );
  });
  test("empty / non-numeric inputs never match", () => {
    expect(phonesShareSubscriberNumber("", "<REDACTED_PHONE>")).toBe(false);
    expect(phonesShareSubscriberNumber("---", "<REDACTED_PHONE>")).toBe(false);
  });
});

describe("findLeadsByPhoneMatch — input guards (no CRMProvider needed)", () => {
  const saved = {
    token: process.env.CRMProvider_ACCESS_TOKEN,
    id: process.env.CRMProvider_CLIENT_ID,
    secret: process.env.CRMProvider_CLIENT_SECRET,
    refresh: process.env.CRMProvider_REFRESH_TOKEN,
  };
  afterEach(() => {
    if (saved.token === undefined) delete process.env.CRMProvider_ACCESS_TOKEN;
    else process.env.CRMProvider_ACCESS_TOKEN = saved.token;
    if (saved.id === undefined) delete process.env.CRMProvider_CLIENT_ID;
    else process.env.CRMProvider_CLIENT_ID = saved.id;
    if (saved.secret === undefined) delete process.env.CRMProvider_CLIENT_SECRET;
    else process.env.CRMProvider_CLIENT_SECRET = saved.secret;
    if (saved.refresh === undefined) delete process.env.CRMProvider_REFRESH_TOKEN;
    else process.env.CRMProvider_REFRESH_TOKEN = saved.refresh;
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

  test("CRMProvider-not-connected is surfaced distinctly from 'no matches'", async () => {
    delete process.env.CRMProvider_ACCESS_TOKEN;
    delete process.env.CRMProvider_CLIENT_ID;
    delete process.env.CRMProvider_CLIENT_SECRET;
    delete process.env.CRMProvider_REFRESH_TOKEN;
    const r = await findLeadsByPhoneMatch("<REDACTED_PHONE>");
    expect(r.matches).toEqual([]);
    expect(r.scanned).toBe(0);
    expect(r.CRMProvider_connected).toBe(false);
    expect(r.note).toContain("CRMProvider");
  });
});
