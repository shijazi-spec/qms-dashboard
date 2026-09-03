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

  it("never counts rows directly, which would have reported all clear", () => {
    expect(fn).not.toContain("SELECT COUNT");
    expect(fn).not.toContain("FROM kpi_definitions");
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
