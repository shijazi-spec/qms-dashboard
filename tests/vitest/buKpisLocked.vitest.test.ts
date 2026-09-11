/**
 * QM-KPI-008 and QM-KPI-015 are LOCKED — name, calculation and checklist.
 *
 * Sarah, repeatedly and finally on 2026-09-12: "I need them as is by their
 * name & calculations and checklists."
 *
 * These two are her north-star governance KPIs, reported to leadership, and
 * they have been moved three times in a week by changes that each looked
 * reasonable in isolation:
 *
 *   · a16abe7e  attached a BU-coverage calculator to QM-KPI-008, so a coverage
 *               figure overwrote pilot validation on every recalc
 *   · fc72aaec  renamed QM-KPI-008 to "BU Coverage Rate" in the seed — which
 *               never reached the database (is_customized = true), leaving code
 *               and screen disagreeing
 *   · a8ef3146  moved the pilot checklist to a new code, QM-KPI-016, producing
 *               two KPIs with one name
 *
 * None of that was caught by a test, because each piece was individually
 * coherent. This file exists so the next such change fails loudly at commit
 * time instead of quietly on her dashboard.
 *
 * If you are here because this file is failing: the fix is almost certainly to
 * revert what you changed, not to update these expectations. Change them only
 * with Sarah's explicit agreement, and update the live rows too — a seed-only
 * rename does NOT reach QM-KPI-008, which carries is_customized = true.
 */
import { describe, it, expect } from "vitest";
import { FINAL_KPIS } from "../../src/utils/finalGrqKpiSeed";
import { READINESS_PLAN, PILOT_PLAN } from "../../src/utils/kpiChecklistDatabase";
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
/** Comments quote the banned wiring on purpose; scan code only. */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const CALC = strip(read("src/utils/kpiProcessCalc.ts"));
const FEED = strip(read("src/utils/leadershipKpiFeed.ts"));
const CHECKLIST = strip(read("src/utils/kpiChecklistDatabase.ts"));

const row = (code: string) => FINAL_KPIS.find((k: any) => k.code === code) as any;

// The agreed definitions. Every field here is what appears on /kpis today.
const LOCKED = {
  "QM-KPI-008": {
    name: "BU Pilot Validation Completion Rate",
    description:
      "Measures the percentage of planned pilot-ready business units that completed pilot validation, including pilot execution, reporting, and action planning",
    weight: 20,
  },
  "QM-KPI-015": {
    name: "BU Framework Readiness Rate",
    description:
      "Measures the percentage of planned business units that completed all pre-pilot framework preparation steps and achieved Ready-for-Pilot status",
    weight: 30,
  },
} as const;

describe.each(Object.entries(LOCKED))("%s is locked", (code, want) => {
  it("keeps its name and description", () => {
    const k = row(code);
    expect(k, `${code} is missing from FINAL_KPIS`).toBeTruthy();
    expect(k.name).toBe(want.name);
    expect(k.description).toBe(want.description);
  });

  it("keeps its target, weight and north-star standing", () => {
    const k = row(code);
    expect(k.target).toBe(100);
    expect(k.weight).toBe(want.weight);
    expect(k.north_star).toBe(true);
    expect(k.owner_name).toBe("Sarah Hijazi");
  });

  it("is CHECKLIST-driven", () => {
    // calc_mode also decides which editor kpis.html offers. "checklist" is what
    // puts "Manage Checklist" on the card; any other mode points the reader at
    // an editor that is not where the number comes from.
    expect(row(code).calc_mode).toBe("checklist");
  });

  it("has NO process calculator writing over it", () => {
    // runKPIAutoCalc records a calculator's result by code whatever calc_mode
    // says, so a registration here silently replaces the checklist figure. This
    // is exactly what happened to QM-KPI-008.
    const block = /export const PROCESS_CALCULATORS[\s\S]*?\n\};/.exec(CALC);
    expect(block, "PROCESS_CALCULATORS block not found — did it move?").toBeTruthy();
    expect(block![0]).not.toContain(`"${code}"`);
  });

  it("scores through the binary action-plan branch", () => {
    // Otherwise it falls to raw item progress — a different number from
    // "BUs whose whole checklist is done ÷ the planned BUs".
    expect(CHECKLIST).toContain(
      'kpi.kpi_code === "QM-KPI-015" || kpi.kpi_code === "QM-KPI-008"',
    );
  });

  it("the leadership payload carries the SAME name as the seed", () => {
    // The two surfaces disagreed on QM-KPI-008's name for two days. The payload
    // name is what leadership actually reads.
    const i = FEED.indexOf(`code: "${code}"`);
    expect(i, `${code} not in the leadership feed`).toBeGreaterThan(-1);
    expect(FEED.slice(i, i + 400)).toContain(`name: "${want.name}"`);
  });
});

describe("the checklists themselves are locked", () => {
  // The plans ARE the measurement: the value is BUs whose every sub-step is
  // ticked, so adding or removing one silently moves the number for every BU.
  const shape = (plan: typeof PILOT_PLAN) => ({
    stages: plan.length,
    steps: plan.reduce((n, [, steps]) => n + steps.length, 0),
    names: plan.map(([stage]) => stage),
  });

  it("BU Framework Readiness keeps its 7 stages and 19 sub-steps", () => {
    const s = shape(READINESS_PLAN);
    expect(s.stages).toBe(7);
    expect(s.steps).toBe(19);
    expect(s.names).toEqual([
      "Stakeholder alignment",
      "Process discovery and mapping",
      "Process profile drafting",
      "Cross-functional review and revision",
      "Forms / templates / system alignment",
      "Approval and release",
      "Training and pilot readiness",
    ]);
  });

  it("BU Pilot Validation keeps its 5 stages and 13 sub-steps", () => {
    const s = shape(PILOT_PLAN);
    expect(s.stages).toBe(5);
    expect(s.steps).toBe(13);
    expect(s.names).toEqual([
      "Pilot authorization",
      "Audit planning",
      "Pilot / audit execution",
      "Reporting",
      "Action planning",
    ]);
  });

  it("each plan stays wired to its own KPI code", () => {
    // a8ef3146 moved the pilot plan to QM-KPI-016 and produced two KPIs with
    // one name. The plan and the code travel together.
    expect(CHECKLIST).toContain('"QM-KPI-015": READINESS_PLAN');
    expect(CHECKLIST).toContain('"QM-KPI-008": PILOT_PLAN');
    expect(CHECKLIST).toContain('seedActionPlan("QM-KPI-015", READINESS_PLAN)');
    expect(CHECKLIST).toContain('seedActionPlan("QM-KPI-008", PILOT_PLAN)');
  });

  it("no third KPI code claims either plan", () => {
    const claims = [...CHECKLIST.matchAll(/"(QM-KPI-\d+)":\s*(READINESS_PLAN|PILOT_PLAN)/g)]
      .map((m) => m[1])
      .sort();
    expect(claims).toEqual(["QM-KPI-008", "QM-KPI-015"]);
  });
});
