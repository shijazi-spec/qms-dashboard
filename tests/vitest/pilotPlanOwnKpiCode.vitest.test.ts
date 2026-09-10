/**
 * The 5-stage Pilot Validation plan belongs to QM-KPI-016, not QM-KPI-008.
 *
 * QM-KPI-008 became BU Coverage Rate on 2026-09-10, computed from the
 * QM-KPI-015 checklist. The pilot plan was left keyed to it, and because
 * calc_mode stopped being "checklist" kpis.html no longer rendered the "Manage
 * Checklist" button — real per-BU tick progress, still in the database, with no
 * way to reach it.
 *
 * These pin the split, because the two codes are one character apart and the
 * failure mode is silent: a plan attached to the wrong KPI still stores ticks,
 * it just scores nothing and shows nowhere.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
/** Comments below quote the old wiring on purpose; scan code only. */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const SEED = strip(read("src/utils/finalGrqKpiSeed.ts"));
const CHECKLIST = strip(read("src/utils/kpiChecklistDatabase.ts"));

const row = (code: string) =>
  new RegExp(`code: "${code}"[^\\n]*`).exec(SEED)?.[0] ?? "";

describe("QM-KPI-016 owns the Pilot Validation plan", () => {
  it("is seeded, and as a checklist KPI", () => {
    // calc_mode "checklist" is what makes kpis.html offer "Manage Checklist".
    // Without it the plan exists and is unreachable, which is the bug.
    const r = row("QM-KPI-016");
    expect(r, "QM-KPI-016 is not in FINAL_KPIS").toBeTruthy();
    expect(r).toContain('name: "BU Pilot Validation Completion Rate"');
    expect(r).toContain('calc_mode: "checklist"');
  });

  it("the plan map and the seeder point at 016, not 008", () => {
    expect(CHECKLIST).toContain('"QM-KPI-016": PILOT_PLAN');
    expect(CHECKLIST).toContain('seedActionPlan("QM-KPI-016", PILOT_PLAN)');
    expect(CHECKLIST).not.toContain('"QM-KPI-008": PILOT_PLAN');
    expect(CHECKLIST).not.toContain('seedActionPlan("QM-KPI-008", PILOT_PLAN)');
  });

  it("the binary action-plan branch covers 016", () => {
    // Both per-BU plans score as "BUs whose whole checklist is done ÷ 8". If
    // 016 were missing here it would fall through to raw item progress — a
    // plausible-looking number that is not the metric.
    expect(CHECKLIST).toContain(
      'kpi.kpi_code === "QM-KPI-015" || kpi.kpi_code === "QM-KPI-016"',
    );
  });

  it("the migration runs BEFORE the seeder", () => {
    // seedActionPlan is seed-once: if a fresh empty plan were written first,
    // the migration would find the target non-empty, skip, and the real ticks
    // would stay stranded on QM-KPI-008 forever.
    const mig = CHECKLIST.indexOf("migratePilotPlanToOwnKpi()");
    const seed = CHECKLIST.indexOf('seedActionPlan("QM-KPI-016"');
    expect(mig).toBeGreaterThan(-1);
    expect(seed).toBeGreaterThan(-1);
    expect(mig).toBeLessThan(seed);
  });

  it("the migration moves the schedule as well as the items", () => {
    // Per-BU start/deadline dates live in a second table. Leaving them behind
    // strands the half a manager plans against.
    const fn = CHECKLIST.slice(
      CHECKLIST.indexOf("async function migratePilotPlanToOwnKpi"),
      CHECKLIST.indexOf("export type ActionPlan"),
    );
    expect(fn).toContain("kpi_checklist_items SET kpi_id");
    expect(fn).toContain("kpi_bu_schedule SET kpi_id");
  });
});

describe("QM-KPI-008 keeps no checklist of its own", () => {
  it("is BU Coverage Rate on the bu_coverage editor", () => {
    const r = row("QM-KPI-008");
    expect(r).toContain('name: "BU Coverage Rate"');
    expect(r).toContain('calc_mode: "bu_coverage"');
  });

  it("its formula states the BINARY rule, not partial credit", () => {
    // buGovernedRate counts a BU only when BOTH "Process Releasing" and "Trial
    // Audit Report" are done. kpiBuCoverageDatabase's header describes an
    // average with partial credit — that is the kpi_bu_coverage tracker table,
    // NOT what buCoverageRateForFeed returns, and describing the KPI from it
    // put a partial-credit formula on a binary metric.
    const r = row("QM-KPI-008");
    expect(r).toContain("Process Releasing");
    expect(r).toContain("Trial Audit Report");
    expect(r).not.toContain("partial credit");
    expect(r).not.toContain("Average governance-checklist completion");
  });
});
