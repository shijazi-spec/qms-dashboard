/**
 * QM-KPI-008 must have exactly ONE computation, and it is the pilot checklist.
 *
 * For two days it had two. a16abe7e registered calcBuCoverageTracked under this
 * code, so runKPIAutoCalc wrote BU COVERAGE into /kpis, while the leadership
 * feed independently computed PILOT VALIDATION completion — under a comment
 * asserting the two were "the same value /kpis records". They were different
 * numbers for one north-star KPI and nothing compared them.
 *
 * Resolved 2026-09-11 in favour of the NAME: QM-KPI-008 has always been "BU
 * Pilot Validation Completion Rate", so the calculator was the wrong half. It
 * is out of PROCESS_CALCULATORS, and both surfaces read the 5-stage pilot plan
 * through actionPlanCompleteRate.
 *
 * Structural, because either path needs a live database — and the bug was never
 * in the arithmetic, it was in which function got called.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
/**
 * Comments removed. The files below quote the old wiring on purpose — that is
 * how the fix stays explained — so a guardrail reading raw text would fail on
 * its own explanation and push someone to delete it.
 */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const SEED = strip(read("src/utils/finalGrqKpiSeed.ts"));
const CALC = strip(read("src/utils/kpiProcessCalc.ts"));
const FEED = strip(read("src/utils/leadershipKpiFeed.ts"));
const CHECKLIST = strip(read("src/utils/kpiChecklistDatabase.ts"));

const NAME = "BU Pilot Validation Completion Rate";
const row = /code: "QM-KPI-008"[^\n]*/.exec(SEED)?.[0] ?? "";

describe("nothing overwrites QM-KPI-008", () => {
  it("is NOT registered in PROCESS_CALCULATORS", () => {
    // The whole defect in one line. runKPIAutoCalc records a calculator's
    // result by code whatever calc_mode says, so a registration here silently
    // replaces the checklist figure on every recalc.
    const block = /export const PROCESS_CALCULATORS[\s\S]*?\n\};/.exec(CALC);
    expect(block, "PROCESS_CALCULATORS block not found — did it move?").toBeTruthy();
    expect(block![0]).not.toContain('"QM-KPI-008"');
  });

  it("still scores through the binary action-plan branch", () => {
    // Without this it falls to raw item progress, which is a different number
    // from "BUs whose whole checklist is done ÷ the planned BUs".
    expect(CHECKLIST).toContain(
      'kpi.kpi_code === "QM-KPI-015" || kpi.kpi_code === "QM-KPI-008"',
    );
    expect(CHECKLIST).toContain('"QM-KPI-008": PILOT_PLAN');
  });
});

describe("both surfaces read the same source", () => {
  it("the leadership feed uses the pilot checklist", () => {
    const i = FEED.indexOf("async function calcBuCoverageRate");
    expect(i, "calcBuCoverageRate not found").toBeGreaterThan(-1);
    const body = FEED.slice(i, i + 1600);
    expect(body).toContain('actionPlanCompleteRate("QM-KPI-008")');
    // buGovernedRate is BU coverage — a different metric, and what used to be
    // sent outward under this code.
    expect(body).not.toContain("buGovernedRate");
  });
});

describe("the name matches the number, everywhere", () => {
  it("the seed row is Pilot Validation on the checklist editor", () => {
    // calc_mode "checklist" is also what puts "Manage Checklist" on the card;
    // "bu_coverage" would swap it for the BU Coverage tracker, which is not
    // where this value comes from.
    expect(row, "QM-KPI-008 seed row not found").toBeTruthy();
    expect(row).toContain(`name: "${NAME}"`);
    expect(row).toContain('calc_mode: "checklist"');
    expect(row).not.toContain("BU Coverage Rate");
  });

  it("the leadership payload carries the same name", () => {
    // This is the label leadership actually reads. It said "BU Coverage Rate"
    // while the live row said Pilot Validation, so the two disagreed on screen.
    const i = FEED.indexOf('code: "QM-KPI-008"');
    expect(i).toBeGreaterThan(-1);
    const entry = FEED.slice(i, i + 300);
    expect(entry).toContain(`name: "${NAME}"`);
    expect(entry).not.toContain("BU Coverage Rate");
  });
});
