/**
 * The seeded KPIs must stay VISIBLE, not merely present in the table.
 *
 * Sarah, 2026-09-03: "it was already there, we built it before" — and she was
 * right. All 33 Customer Success KPIs had been inserted successfully and were
 * invisible for days because `is_active` was NULL. Every read path filters
 * `is_active = true`, `ON CONFLICT (kpi_code)` refused to re-create them, and
 * the page reported "No active KPIs found", which is indistinguishable from a
 * seeder that never ran. Four republishes went on that wrong theory.
 *
 * Nothing on the platform noticed. A `SELECT COUNT(*)` would have reported
 * every team healthy the entire time, because the rows were there.
 *
 * So the boot check goes through the SAME read path the page uses, and this
 * test pins the properties that make it a real alarm rather than decoration.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { SEEDED_KPI_EXPECTATIONS } from "../../src/utils/kpiDatabase";

const SRC = readFileSync(
  join(__dirname, "../../src/utils/kpiDatabase.ts"),
  "utf8",
);

/** How many rows each seeder actually writes, counted from the source. */
function seededRowCount(fnName: string): number {
  const body = new RegExp(`async function ${fnName}\\(\\)[\\s\\S]*?\\n\\}`).exec(SRC);
  expect(body, `${fnName} not found`).toBeTruthy();
  return (body![0].match(/kpi_code: "/g) || []).length;
}

describe("the expectations match what the seeders write", () => {
  // A stale expectation is itself a bug: too low and a team could lose KPIs
  // without tripping the alarm.
  const bySeeder: Array<[string, string]> = [
    ["SDR Team", "seedSDRKPIs"],
    ["Sales Team", "seedSalesKPIs"],
    ["CS Team", "seedCSKPIs"],
  ];

  it("covers every team that has a seeder", () => {
    expect(SEEDED_KPI_EXPECTATIONS.map((e) => e.ownerName).sort()).toEqual(
      bySeeder.map(([owner]) => owner).sort(),
    );
  });

  for (const [ownerName, fn] of bySeeder) {
    it(`${ownerName}: the minimum equals what ${fn} seeds`, () => {
      const expected = SEEDED_KPI_EXPECTATIONS.find((e) => e.ownerName === ownerName)!;
      expect(expected.minimum).toBe(seededRowCount(fn));
    });
  }

  it("expects all 33 CS KPIs, not just the three with calculators", () => {
    // The 30 manual ones are the documented data gap. If the check only
    // demanded the computable three, losing the other 30 would pass silently.
    expect(
      SEEDED_KPI_EXPECTATIONS.find((e) => e.ownerName === "CS Team")!.minimum,
    ).toBe(33);
  });
});

describe("the check tests visibility, not existence", () => {
  const fn = /export async function verifySeededKpiVisibility[\s\S]*?\n\}/.exec(SRC)![0];

  it("goes through the page's own read path", () => {
    // getKPIsByOwnerName applies `is_active = true`, so an unreadable row
    // counts as missing — which is the whole point.
    expect(fn).toContain("getKPIsByOwnerName");
  });

  it("decides visibility from the read path, never from a row count", () => {
    // The forensics below DO count rows — that is their job, and they run only
    // after the verdict. What must never happen is the verdict itself coming
    // from a COUNT, because a COUNT reported every team healthy throughout the
    // outage. So: the visible figure is assigned from getKPIsByOwnerName, and
    // no SQL appears before `ok` is decided.
    expect(fn).toMatch(/visible\s*=\s*\(await getKPIsByOwnerName\([^)]*\)\)\.length/);
    const beforeVerdict = fn.slice(0, fn.indexOf("const ok ="));
    expect(beforeVerdict).not.toContain("SELECT");
  });

  it("reports WHY when a team is short, not just that it is", () => {
    // Every cause presents identically on screen — is_active NULL, is_active
    // false, or an owner_name the page does not look up. Naming which one is
    // the difference between a one-line fix and days of guessing.
    expect(fn).toContain("is_active IS NULL");
    expect(fn).toContain("is_active IS FALSE");
    expect(fn).toContain("owner_name");
    expect(fn).toContain("forensics");
  });

  it("only runs the forensics for teams that are actually short", () => {
    // A healthy team must not pay for three extra queries on every boot.
    const healthyPath = fn.slice(fn.indexOf("if (ok) {"), fn.indexOf("let forensics"));
    expect(healthyPath).toContain("continue;");
  });

  it("logs at ERROR, so a team losing its KPIs is not a quiet warning", () => {
    expect(fn).toContain("logger.error");
  });

  it("names the two causes worth checking first", () => {
    expect(fn).toContain("is_active");
    expect(fn).toContain("owner_name");
  });

  it("does not throw — a failed self-check must not stop the platform booting", () => {
    expect(fn).toContain("catch");
    expect(/\bthrow\b/.test(fn)).toBe(false);
  });

  it("runs at boot, after the seeders and the NULL repair", () => {
    const seedAt = SRC.indexOf("await seedCSKPIs();");
    const repairAt = SRC.indexOf("WHERE is_active IS NULL");
    const verifyAt = SRC.indexOf("await verifySeededKpiVisibility();");
    expect(verifyAt).toBeGreaterThan(seedAt);
    expect(verifyAt).toBeGreaterThan(repairAt);
  });
});
