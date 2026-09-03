/**
 * Structural tests for the Country Risk seed
 * (PRD-FRD-001 Feature 3).
 *
 * No DB required.
 *
 * Run:  npx tsx tests/fraudCountrySeed.test.ts
 */

import { COUNTRY_RISK_DEFINITIONS } from "../src/utils/fraudDatabase";
import { TestSuite } from "./_helpers/runner";

const suite = new TestSuite("fraudCountrySeed");

console.log("\n=== Country Risk seed — structural tests ===\n");

await suite.test("seed contains exactly 20 countries (Excel Tab 3 baseline)", async () => {
  suite.expectEqual(
    COUNTRY_RISK_DEFINITIONS.length,
    20,
    "expected 20 country rows",
  );
});

await suite.test("ISO codes are unique 2-letter uppercase", async () => {
  const codes = COUNTRY_RISK_DEFINITIONS.map((c) => c.iso_code);
  suite.expectEqual(new Set(codes).size, codes.length, "duplicate ISO code");
  for (const code of codes) {
    suite.expect(/^[A-Z]{2}$/.test(code), `bad ISO code: ${code}`);
  }
});

await suite.test("GCC countries (SA, AE, BH, KW, OM, QA) are present and low-risk", async () => {
  const gcc = ["SA", "AE", "BH", "KW", "OM", "QA"];
  for (const iso of gcc) {
    const row = COUNTRY_RISK_DEFINITIONS.find((c) => c.iso_code === iso);
    suite.expect(!!row, `missing GCC country ${iso}`);
    suite.expectEqual(row!.risk_rating, "low", `${iso} should be low risk`);
    suite.expectEqual(row!.fatf_status, "no_action", `${iso} should be no_action`);
  }
});

await suite.test("FATF black-list rows are critical and permanently_blocked", async () => {
  const blacks = COUNTRY_RISK_DEFINITIONS.filter((c) => c.fatf_status === "black_list");
  suite.expect(blacks.length >= 3, "expected at least 3 FATF black-list rows");
  for (const c of blacks) {
    suite.expectEqual(c.risk_rating, "critical", `${c.iso_code} risk_rating must be critical`);
    suite.expectEqual(c.bin_status, "permanently_blocked", `${c.iso_code} bin_status must be permanently_blocked`);
  }
});

await suite.test("Iran (IR), DPRK (KP), Myanmar (MM) are on the black-list", async () => {
  for (const iso of ["IR", "KP", "MM"]) {
    const row = COUNTRY_RISK_DEFINITIONS.find((c) => c.iso_code === iso);
    suite.expect(!!row, `${iso} missing from seed`);
    suite.expectEqual(row!.fatf_status, "black_list", `${iso} should be on black-list`);
  }
});

await suite.test("FATF enums are valid across the seed", async () => {
  const fatf = new Set([
    "no_action",
    "increased_monitoring",
    "high_risk_grey_list",
    "black_list",
  ]);
  const rating = new Set(["low", "medium", "high", "critical"]);
  const bin = new Set([
    "approved",
    "approved_with_edd",
    "not_approved",
    "permanently_blocked",
  ]);
  for (const c of COUNTRY_RISK_DEFINITIONS) {
    suite.expect(fatf.has(c.fatf_status), `bad fatf_status on ${c.iso_code}: ${c.fatf_status}`);
    suite.expect(rating.has(c.risk_rating), `bad risk_rating on ${c.iso_code}: ${c.risk_rating}`);
    suite.expect(bin.has(c.bin_status), `bad bin_status on ${c.iso_code}: ${c.bin_status}`);
  }
});

suite.finishOrExit();
