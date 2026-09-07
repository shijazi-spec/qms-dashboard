/**
 * GRC-KPI-002 (Certification Milestones On Track) is a COUNT in the
 * leadership feed (unit: "count", target: 2 — see the FEED_KPIS entry in
 * src/utils/leadershipKpiFeed.ts), not a percentage. componentFraction()
 * used to fold every North Star component as value/100, which turned a
 * perfect quarter (e.g. 3 milestones on time) into ~1 point instead of the
 * full weight in Maram's North Star composite. This locks in the fix: the
 * count is scored against its own FEED_KPIS target instead.
 */
import { describe, it, expect } from "vitest";

import { componentFraction, countFraction } from "../../src/utils/leadershipKpiFeed";

describe("componentFraction — GRC-KPI-002 (count, target 2)", () => {
  it("returns 1 when the count exactly meets its target", () => {
    expect(componentFraction("GRC-KPI-002", 2)).toBe(1);
  });

  it("returns a proportional fraction below target", () => {
    expect(componentFraction("GRC-KPI-002", 1)).toBe(0.5);
  });

  it("caps at 1 and never exceeds it when the count beats target", () => {
    expect(componentFraction("GRC-KPI-002", 3)).toBe(1);
  });

  it("returns 0 when nothing was delivered on time", () => {
    expect(componentFraction("GRC-KPI-002", 0)).toBe(0);
  });
});

describe("componentFraction — percentage KPIs (default branch)", () => {
  it("still folds a plain percentage KPI as value/100", () => {
    expect(componentFraction("GRC-KPI-003", 82)).toBeCloseTo(0.82);
    expect(componentFraction("GRC-KPI-004", 100)).toBe(1);
    expect(componentFraction("GRC-KPI-004", 0)).toBe(0);
  });
});

describe("componentFraction — QM-KPI-006 (unchanged special case)", () => {
  it("folds handoff cycle time as min(1, 5/days)", () => {
    expect(componentFraction("QM-KPI-006", 5)).toBe(1);
    expect(componentFraction("QM-KPI-006", 10)).toBe(0.5);
    expect(componentFraction("QM-KPI-006", 2.5)).toBe(1); // capped, never >1
  });

  it("returns 0 for zero/negative days instead of dividing by zero", () => {
    expect(componentFraction("QM-KPI-006", 0)).toBe(0);
    expect(componentFraction("QM-KPI-006", -1)).toBe(0);
  });
});

describe("componentFraction — no NaN/Infinity from a missing or zero target", () => {
  it("never divides by zero or produces NaN/Infinity for a real code", () => {
    for (const code of ["GRC-KPI-002", "QM-KPI-006", "GRC-KPI-003"]) {
      for (const value of [0, -5, 1, 100]) {
        const r = componentFraction(code, value);
        expect(Number.isFinite(r)).toBe(true);
        expect(Number.isNaN(r)).toBe(false);
      }
    }
  });

  it("stays finite for an unknown code (falls through to the percentage default)", () => {
    const r = componentFraction("NOT-A-REAL-CODE", 0);
    expect(Number.isFinite(r)).toBe(true);
  });
});

describe("countFraction — the guard componentFraction('GRC-KPI-002', ...) relies on", () => {
  it("returns 0, not NaN/Infinity, when the target is zero", () => {
    const r = countFraction(2, 0);
    expect(r).toBe(0);
    expect(Number.isFinite(r)).toBe(true);
  });

  it("returns 0, not NaN/Infinity, when the target is missing (undefined)", () => {
    const r = countFraction(2, undefined);
    expect(r).toBe(0);
    expect(Number.isFinite(r)).toBe(true);
  });

  it("returns 0, not NaN/Infinity, when the target is negative", () => {
    const r = countFraction(2, -1);
    expect(r).toBe(0);
    expect(Number.isFinite(r)).toBe(true);
  });

  it("still computes a normal proportional fraction with a valid target", () => {
    expect(countFraction(1, 2)).toBe(0.5);
    expect(countFraction(2, 2)).toBe(1);
    expect(countFraction(5, 2)).toBe(1); // capped
  });
});
