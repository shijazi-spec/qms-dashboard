/**
 * A KPI definition and the calculator registered under its code must agree.
 *
 * SPEC-KPI-02 went four months without them agreeing. The seed defined it as
 * "Documentation Lifecycle Compliance" (manual, Document Master List); the
 * registry had calcComplianceObligationTracking under the same code, writing
 * applicable-obligations-with-an-owner into it on every recalc. The page
 * showed a green 100% against a name that described something else, and fed
 * that into SPEC-KPI-01, the specialist's north-star composite.
 *
 * Nothing caught it. runKPIAutoCalc records a calculator's result by code
 * without ever consulting calc_mode, so "manual" is not a barrier — it is
 * just a lie the definition tells about where its number comes from.
 *
 * This test is the barrier. It is a STATIC check on two source files, so it
 * fails at commit time rather than four months later on someone's dashboard.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const SEED = readFileSync(
  join(__dirname, "../../src/utils/finalGrqKpiSeed.ts"),
  "utf8",
);
const CALC = readFileSync(
  join(__dirname, "../../src/utils/kpiProcessCalc.ts"),
  "utf8",
);

/** Codes with a registered process calculator. */
function calculatorCodes(): Set<string> {
  const block = /export const PROCESS_CALCULATORS[\s\S]*?\n\};/.exec(CALC);
  expect(block, "PROCESS_CALCULATORS block not found — did it move?").toBeTruthy();
  const codes = [...block![0].matchAll(/"([A-Z]+-KPI-\d+)"/g)].map((m) => m[1]);
  expect(codes.length).toBeGreaterThan(5);
  return new Set(codes);
}

/** Seeded GRQ rows as { code -> calc_mode }. */
function seededModes(): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of SEED.matchAll(
    /code: "([A-Z]+-KPI-\d+)"[^\n]*?calc_mode: "(\w+)"/g,
  )) {
    out.set(m[1], m[2]);
  }
  expect(out.size, "no seeded KPI rows parsed — did the row shape change?")
    .toBeGreaterThan(10);
  return out;
}

describe("seeded calc_mode agrees with the calculator registry", () => {
  it("every seeded KPI with a calculator is marked auto", () => {
    const live = calculatorCodes();
    const offenders = Array.from(seededModes().entries())
      .filter(([code, mode]) => live.has(code) && mode !== "auto")
      .map(([code, mode]) => `${code} seeded ${mode}`);

    // A calculator writes to this code on every recalc whatever calc_mode
    // says. Seeding it 'manual' does not stop the write — it only makes the
    // resulting value look hand-entered, and hides it from the orphan sweep's
    // "dead" bucket where a purge would be the wrong remedy anyway.
    expect(offenders).toEqual([]);
  });

  it("SPEC-KPI-02 is named for what its calculator computes", () => {
    // The specific case. calcComplianceObligationTracking reads the
    // obligations table; the definition must not promise document reviews.
    const row = /code: "SPEC-KPI-02"[^\n]*/.exec(SEED)![0];
    expect(row).toContain("Compliance Obligation Tracking");
    expect(row).toContain('calc_mode: "auto"');
    expect(row).not.toContain("Document Master List");
    expect(row).not.toContain("Documents Reviewed On Time");
  });

  it("Documentation Lifecycle Compliance still belongs to QM-KPI-010 alone", () => {
    // It was never AlHanouf's; duplicating the name across two owners is how
    // the confusion started.
    const grqRows = SEED.match(/name: "Documentation Lifecycle Compliance"/g) || [];
    expect(grqRows).toEqual([]);
  });

  it("the relabel is annotated as a rename, not a measurement change", () => {
    // Every stored value was already obligation tracking, so the history is
    // continuous. An annotation implying a break would invite an auditor to
    // throw away four months of good data.
    const note = /kpi_code = 'SPEC-KPI-02'[\s\S]{0,200}/.exec(SEED);
    expect(note, "no methodology annotation for the relabel").toBeTruthy();
    expect(SEED).toContain("remain comparable");
  });
});
