import { describe, it, expect } from "vitest";
import { functionReportKeys } from "../../src/utils/qualityReportsAggregator";

describe("functionReportKeys", () => {
  it("maps each function to its report set", () => {
    expect(functionReportKeys("sdr")).toEqual(["leads"]);
    expect(functionReportKeys("sales")).toEqual(["deals", "deal_compliance", "stage_aging"]);
    expect(functionReportKeys("cs")).toEqual(["cs_lifecycle", "accounts"]);
    expect(functionReportKeys("partnersuccess")).toEqual(["cs_lifecycle", "accounts"]);
    expect(functionReportKeys("partnership")).toEqual(["leads", "deals"]);
    expect(functionReportKeys("onboarding")).toEqual(["cs_lifecycle_onboarding", "deals"]);
    expect(functionReportKeys("unknown")).toEqual([]);
  });
});

/**
 * The Data cleanup tile is gated on the function owning a cleanable record
 * type. cs_lifecycle is a lifecycle report and carries no cleanup figure, so CS
 * and PartnerSuccess rendered "— not mapped" while SDR (leads) and Sales
 * (deals) showed numbers. CS owns the customer ACCOUNT records.
 */
describe("every function that shows a Data cleanup tile owns a record type", () => {
  const CLEANABLE = ["deals", "leads", "accounts"];
  const hasCleanup = (fn: string) =>
    functionReportKeys(fn).some((k) => CLEANABLE.includes(k));

  it("maps cleanup for cs and partnersuccess", () => {
    expect(hasCleanup("cs")).toBe(true);
    expect(hasCleanup("partnersuccess")).toBe(true);
  });

  it("keeps the functions that already had it", () => {
    for (const fn of ["sdr", "sales", "partnership", "onboarding"]) {
      expect(hasCleanup(fn)).toBe(true);
    }
  });

  it("leaves an unknown function unmapped rather than inventing a tile", () => {
    expect(hasCleanup("unknown")).toBe(false);
  });

  it("does not give cs the deals key", () => {
    // The hub headline used "leads for sdr, deals otherwise", so Customer
    // Success (B2B) and Sales (B2B) both reported the SAME 2,043 outstanding —
    // CS was displaying Sales' deal duplicates as its own cleanup burden.
    // Granting cs the deals key here would reintroduce that through the
    // detail page instead.
    expect(functionReportKeys("cs")).not.toContain("deals");
    expect(functionReportKeys("partnersuccess")).not.toContain("deals");
  });
});
