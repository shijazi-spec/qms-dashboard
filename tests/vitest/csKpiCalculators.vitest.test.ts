/**
 * Which CS KPIs the QMS computes, and which it deliberately does not.
 *
 * Of the 33 in §8 of WP-BU-CS-SOP-003, five are computable from the Zoho
 * mirror. The other 28 name Client-Hub, Jira, the Admin/BI Portal, QA sampling
 * or access records — feeds the platform does not have — and stay manual.
 *
 * Two rules this file exists to hold:
 *
 *   A KPI marked `calc_mode: "auto"` MUST have a calculator. An auto KPI with
 *   no calculator renders blank forever and reads as a data gap rather than a
 *   configuration mistake.
 *
 *   Editing the seed list is NOT enough. seedCSKPIs uses ON CONFLICT DO
 *   NOTHING, so a row already in the table keeps whatever calc_mode it was
 *   created with — the two KPIs that gained calculators on 2026-09-06 would
 *   have stayed manual, registered and never running.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const CALC = readFileSync(
  join(__dirname, "../../src/utils/kpiProcessCalc.ts"),
  "utf8",
);
const DB = readFileSync(
  join(__dirname, "../../src/utils/kpiDatabase.ts"),
  "utf8",
);

/** CS codes registered in the calculator map. */
function registeredCsCalculators(): string[] {
  return [...CALC.matchAll(/"(CS-KPI-\d+)":\s*calc/g)].map((m) => m[1]).sort();
}

/** CS codes the seeder marks as auto. */
function seededAutoCs(): string[] {
  const seed = /async function seedCSKPIs[\s\S]*?\n\}/.exec(DB)![0];
  return [...seed.matchAll(/kpi_code: "(CS-KPI-\d+)"[^\n]*calc_mode: "auto"/g)]
    .map((m) => m[1])
    .sort();
}

describe("auto and calculator agree", () => {
  it("computes exactly six of the 33", () => {
    // CS-KPI-14 joined on 2026-09-10, once the tenant's Health field was
    // checked rather than assumed: 939 of 939 populated values parse as
    // numbers in 0-100. It is the only one of the six that is NOT a proxy —
    // it is the SOP's own measure, read from the field the CS team scores.
    expect(registeredCsCalculators()).toEqual([
      "CS-KPI-11",
      "CS-KPI-14",
      "CS-KPI-19",
      "CS-KPI-23",
      "CS-KPI-25",
      "CS-KPI-30",
    ]);
  });

  it("marks auto exactly the ones with a calculator", () => {
    // Either direction is a bug: auto-without-calculator renders blank
    // forever; calculator-without-auto never runs.
    expect(seededAutoCs()).toEqual(registeredCsCalculators());
  });

  it("promotes existing rows too, since ON CONFLICT DO NOTHING skips them", () => {
    const promote = /UPDATE kpi_definitions SET calc_mode = 'auto'[\s\S]{0,400}/.exec(DB);
    expect(promote, "no promotion for rows seeded before the calculator existed").toBeTruthy();
    for (const code of registeredCsCalculators()) {
      expect(promote![0]).toContain(code);
    }
  });

  it("only ever promotes manual to auto, never the reverse", () => {
    const promote = /UPDATE kpi_definitions SET calc_mode = 'auto'[\s\S]{0,400}/.exec(DB)![0];
    expect(promote).toContain("calc_mode IS DISTINCT FROM 'auto'");
    expect(promote).not.toContain("calc_mode = 'manual'");
  });

  it("leaves CS-KPI-21 manual — churn rate cannot be sourced from Zoho", () => {
    // Its denominator is the active client population, which only Client-Hub
    // knows. A Zoho-derived churn rate would be confidently wrong.
    expect(registeredCsCalculators()).not.toContain("CS-KPI-21");
  });
});

describe("the two new proxies say they are proxies", () => {
  const body = (fn: string) =>
    new RegExp(`export async function ${fn}[\\s\\S]*?\\n\\}`).exec(CALC)![0];

  for (const [fn, code] of [
    ["calcCsOnboardingExitCriteria", "CS-KPI-11"],
    ["calcCsRenewalOutreachTimeliness", "CS-KPI-19"],
  ]) {
    it(`${code} labels its source as a PROXY`, () => {
      // Both measure lifecycle timeliness, not the SOP's stated criteria. An
      // auditor must see the substitution in the KPI itself, not discover it.
      expect(body(fn)).toContain("PROXY");
    });

    it(`${code} reports no data rather than 100% on an empty population`, () => {
      // A phase with no deals reporting perfect compliance is what makes a
      // governance dashboard worthless.
      expect(body(fn)).toContain("return EMPTY");
    });

    it(`${code} never lets the numerator exceed the denominator`, () => {
      expect(body(fn)).toContain("Math.max(0,");
    });
  }
});

describe("phase populations are matched loosely", () => {
  it("matches phase names by substring, not equality", () => {
    // Zoho spells these several ways ("Onboarding", "On-boarding",
    // "Renewal / Retention"). An exact match reports a denominator of zero,
    // which surfaces as "no data" rather than as an error.
    const agg = /const phaseTotal = [\s\S]*?\n    \};/.exec(CALC)![0];
    expect(agg).toContain("re.test(phase)");
    expect(CALC).toContain("/on-?board/i");
    expect(CALC).toContain("/renew/i");
  });

  it("draws numerator and denominator from the same scan", () => {
    // Counting overdue deals from one scan and the phase population from
    // another would let the rate exceed 100% when the two disagree.
    const agg = /const data: CsKpiAggregates = \{[\s\S]*?\n    \};/.exec(CALC)![0];
    expect(agg).toContain("phaseTotal(/on-?board/i)");
    expect(agg).toContain("byCode.onboarding_overdue");
  });
});
