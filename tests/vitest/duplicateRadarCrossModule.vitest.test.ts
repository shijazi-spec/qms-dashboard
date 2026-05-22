/**
 * Unit tests for the cross-module pairing classifier — R6.
 *
 * Run: npx vitest run tests/vitest/duplicateRadarCrossModule.vitest.test.ts
 *
 * Scope: pure logic in classifyCrossModulePairing. The DB-touching wrapper
 * `getCrossModuleOverlaps()` is exercised manually against a live deployment
 * per the existing convention for DB-backed helpers in this codebase.
 */
import { describe, expect, test } from "vitest";
import { classifyCrossModulePairing } from "../../src/utils/duplicateRadarDatabase";

describe("classifyCrossModulePairing", () => {
  test("returns null when only one record type is present", () => {
    expect(
      classifyCrossModulePairing({
        total_leads: 3,
        total_contacts: 0,
        total_accounts: 0,
        total_deals: 0,
      }),
    ).toBeNull();

    expect(
      classifyCrossModulePairing({
        total_leads: 0,
        total_contacts: 0,
        total_accounts: 1,
        total_deals: 0,
      }),
    ).toBeNull();
  });

  test("returns null when every count is zero", () => {
    expect(
      classifyCrossModulePairing({
        total_leads: 0,
        total_contacts: 0,
        total_accounts: 0,
        total_deals: 0,
      }),
    ).toBeNull();
  });

  test("Lead + Contact → lead_contact (Lead-first canonical order)", () => {
    expect(
      classifyCrossModulePairing({
        total_leads: 1,
        total_contacts: 2,
        total_accounts: 0,
        total_deals: 0,
      }),
    ).toBe("lead_contact");
  });

  test("Lead + Account → lead_account", () => {
    expect(
      classifyCrossModulePairing({
        total_leads: 1,
        total_contacts: 0,
        total_accounts: 1,
        total_deals: 0,
      }),
    ).toBe("lead_account");
  });

  test("Lead + Deal → lead_deal", () => {
    expect(
      classifyCrossModulePairing({
        total_leads: 1,
        total_contacts: 0,
        total_accounts: 0,
        total_deals: 1,
      }),
    ).toBe("lead_deal");
  });

  test("Contact + Account → contact_account", () => {
    expect(
      classifyCrossModulePairing({
        total_leads: 0,
        total_contacts: 1,
        total_accounts: 1,
        total_deals: 0,
      }),
    ).toBe("contact_account");
  });

  test("Contact + Deal → contact_deal", () => {
    expect(
      classifyCrossModulePairing({
        total_leads: 0,
        total_contacts: 1,
        total_accounts: 0,
        total_deals: 1,
      }),
    ).toBe("contact_deal");
  });

  test("Deal + Account → deal_account (canonical: deal before account)", () => {
    expect(
      classifyCrossModulePairing({
        total_leads: 0,
        total_contacts: 0,
        total_accounts: 1,
        total_deals: 1,
      }),
    ).toBe("deal_account");
  });

  test("three modules present → mixed", () => {
    expect(
      classifyCrossModulePairing({
        total_leads: 1,
        total_contacts: 1,
        total_accounts: 1,
        total_deals: 0,
      }),
    ).toBe("mixed");
  });

  test("all four modules present → mixed", () => {
    expect(
      classifyCrossModulePairing({
        total_leads: 1,
        total_contacts: 1,
        total_accounts: 1,
        total_deals: 1,
      }),
    ).toBe("mixed");
  });

  test("counts don't matter, only presence (1 vs 100 is the same pairing)", () => {
    const small = classifyCrossModulePairing({
      total_leads: 1,
      total_contacts: 1,
      total_accounts: 0,
      total_deals: 0,
    });
    const big = classifyCrossModulePairing({
      total_leads: 100,
      total_contacts: 73,
      total_accounts: 0,
      total_deals: 0,
    });
    expect(small).toBe(big);
    expect(small).toBe("lead_contact");
  });
});
