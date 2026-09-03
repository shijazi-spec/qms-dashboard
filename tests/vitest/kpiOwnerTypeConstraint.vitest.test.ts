/**
 * Every owner_type a seeder writes must be permitted by the table constraint.
 *
 * This exists because of a silent failure that cost a day (2026-09-03). The CS
 * KPI seeder inserted `owner_type: 'cs_team'`, but the CHECK constraint that
 * `initKPITables` re-applies at boot allowed only the owner types that existed
 * when SDR and Sales were added. Every CS insert violated it and threw —
 * and `initKPITables()` is invoked as fire-and-forget with a `.catch` that only
 * logs, so nothing surfaced. The Quality Reports page reported "No active KPIs
 * found for CS Team", which was true and gave no hint of the cause; the seeder
 * looked correct in review, its own unit tests passed, and three republishes
 * were spent believing the code simply had not deployed yet.
 *
 * The unit test for the seed data could not catch this: it asserts the shape of
 * the rows, not whether the database will accept them. This one reads the two
 * halves out of the source and checks they agree.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const SRC = readFileSync(
  join(__dirname, "../../src/utils/kpiDatabase.ts"),
  "utf8",
);

/** The allowlist from the ALTER … ADD CONSTRAINT that runs at boot. */
function allowedOwnerTypes(): string[] {
  // The ALTER is the one that matters: it is re-applied on every boot and so
  // governs the live table, whereas the CREATE TABLE only shapes a fresh one.
  const m = /ADD CONSTRAINT kpi_definitions_owner_type_check\s*\n?\s*CHECK \(owner_type IN \(([^)]*)\)\)/.exec(SRC);
  expect(m, "could not find the owner_type CHECK constraint").toBeTruthy();
  return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/**
 * Every owner_type the file writes into a seed row.
 *
 * Two forms, because the seeders are not written alike: the SDR and Sales seeds
 * put the literal on each row (`owner_type: "sales_team"`), while the CS seed
 * binds an alias declared once (`const T = "cs_team"`). Scanning only for the
 * literal form is what let the CS bug through this very test on its first
 * draft — it failed the CS-specific assertion below and passed the general one.
 *
 * The alias sweep deliberately over-captures any `const X = "…_team"` in the
 * file. A constant that ends in `_team` but is not an owner_type would force
 * someone to widen the allowlist or rename it — a loud, one-line annoyance,
 * against the alternative of a seeder that silently inserts nothing. Given how
 * this failure presents, over-capturing is the right direction to err in.
 */
function seededOwnerTypes(): string[] {
  const literals = [...SRC.matchAll(/owner_type:\s*"([^"]+)"/g)].map((x) => x[1]);
  const aliases = [...SRC.matchAll(/const\s+\w+\s*=\s*"([a-z][a-z_]*_team)"/g)].map((x) => x[1]);
  return [...literals, ...aliases];
}

describe("owner_type constraint agrees with the seeders", () => {
  it("finds both halves in the source", () => {
    expect(allowedOwnerTypes().length).toBeGreaterThan(3);
    expect(seededOwnerTypes().length).toBeGreaterThan(3);
  });

  it("permits every owner_type any seeder writes", () => {
    const allowed = new Set(allowedOwnerTypes());
    const offenders = [...new Set(seededOwnerTypes())].filter((t) => !allowed.has(t));
    // A failure here means those inserts will throw at boot and be swallowed —
    // the KPIs simply never appear, with no error anywhere the operator looks.
    expect(offenders, `owner_type(s) not in the CHECK constraint: ${offenders.join(", ")}`).toEqual([]);
  });

  it("still permits the team owner types already in production", () => {
    const allowed = allowedOwnerTypes();
    for (const t of ["quality_manager", "sdr_team", "sales_team", "shared"]) {
      expect(allowed).toContain(t);
    }
  });

  it("permits cs_team — the one this test was written for", () => {
    expect(allowedOwnerTypes()).toContain("cs_team");
  });

  it("keeps the CREATE TABLE and the ALTER from contradicting each other", () => {
    // The CREATE TABLE list may legitimately be narrower (it only ever shapes a
    // brand-new database, and the ALTER widens it straight afterwards), but it
    // must not permit something the ALTER would then reject.
    const create = /owner_type VARCHAR\(20\) NOT NULL CHECK \(owner_type IN \(([^)]*)\)\)/.exec(SRC);
    expect(create, "could not find the CREATE TABLE owner_type check").toBeTruthy();
    const createAllowed = [...create![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    const alterAllowed = new Set(allowedOwnerTypes());
    expect(createAllowed.filter((t) => !alterAllowed.has(t))).toEqual([]);
  });
});
