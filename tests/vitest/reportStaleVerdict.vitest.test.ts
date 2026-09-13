/**
 * A compliance verdict is only shown for the stage it was computed for.
 *
 * 2026-09-12: the report was switched to read each deal's LIVE stage, because
 * it had been charging 152 deals to a Proposal line they had left. Correct —
 * but the verdict beside that live stage was still the one computed at check
 * time, against the requirements of the stage the deal was in THEN. So a deal
 * checked at Proposal (one document, present) and since moved to Agreement
 * Signed was shown as COMPLIANT at Signed: graded on one document where five
 * are required. Fixing the stage without this made that possible.
 *
 * The rule, in three places that must agree:
 *
 *   report rows    — a stale verdict is shown as neither pass nor fail
 *   coverage count — it counts as unchecked, so "X of Y checked" stays true
 *   sweep          — it is re-checked first after never-checked deals
 *
 * All three use VERDICT_CURRENT_SQL, so they cannot disagree about which deals
 * are stale.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  LIVE_DEAL_STAGE_SQL,
  VERDICT_CURRENT_SQL,
} from "../../src/utils/duplicateRadarDatabase";

const read = (p: string) => readFileSync(join(__dirname, "../../", p), "utf8");
/** Comment-stripped: presence checks must not be satisfied by prose. */
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const DB = code(read("src/utils/duplicateRadarDatabase.ts"));
const SWEEP = code(read("src/utils/dealDocComplianceSweep.ts"));
const ROUTES = code(read("src/mastra/routes/duplicateRadarRoutes.ts"));

describe("the predicate", () => {
  it("is parenthesised, so NOT negates all of it", () => {
    // Unparenthesised, `NOT a OR b` binds as `(NOT a) OR b` and silently
    // inverts the meaning rather than failing.
    expect(VERDICT_CURRENT_SQL.startsWith("(")).toBe(true);
    expect(VERDICT_CURRENT_SQL.endsWith(")")).toBe(true);
  });

  it("compares the stored stage with the live one", () => {
    expect(VERDICT_CURRENT_SQL).toContain("d.stage");
    expect(VERDICT_CURRENT_SQL).toContain(LIVE_DEAL_STAGE_SQL);
  });

  it("lets a mirror row with no stage pass, since it cannot be judged stale", () => {
    expect(VERDICT_CURRENT_SQL).toContain(`${LIVE_DEAL_STAGE_SQL} = ''`);
  });

  it("uses the same live-stage fallback as the rest of the radar", () => {
    expect(LIVE_DEAL_STAGE_SQL).toContain("r.stage");
    expect(LIVE_DEAL_STAGE_SQL).toContain("r.raw_data->>'Stage'");
  });
});

describe("the three places that must agree", () => {
  it("report rows exclude stale verdicts", () => {
    const fn = /export async function getDealComplianceReportRows[\s\S]*?\n\}/.exec(DB);
    expect(fn, "getDealComplianceReportRows not found").toBeTruthy();
    expect(fn![0]).toContain("${VERDICT_CURRENT_SQL}");
  });

  it("countNeverChecked counts stale verdicts as unchecked", () => {
    // Rows removed from the numerator must be added to the unchecked count,
    // or the coverage line overstates how much was checked.
    const fn = /export async function countNeverChecked[\s\S]*?\n\}/.exec(SWEEP);
    expect(fn, "countNeverChecked not found").toBeTruthy();
    expect(fn![0]).toContain("NOT ${VERDICT_CURRENT_SQL}");
  });

  it("the sweep imports the shared predicate rather than restating it", () => {
    expect(SWEEP).toContain("VERDICT_CURRENT_SQL");
    expect(SWEEP).toContain("LIVE_DEAL_STAGE_SQL");
  });
});

describe("coverage is counted in the rows' own segment", () => {
  it("no route calls countNeverChecked without a segment", () => {
    // Every route that computes coverage builds its rows for a segment. A
    // call with no segment pads a WalaPlus headline with every layout's
    // unchecked deals. a3ed0209 fixed two such callers and missed two.
    expect(ROUTES).not.toContain("countNeverChecked(REPORT_STAGES)");
    expect(ROUTES).not.toContain("countNeverChecked()");
  });
});
