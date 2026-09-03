/**
 * A created KPI must be ACTIVE, not NULL.
 *
 * `kpi_definitions.is_active` is declared `BOOLEAN DEFAULT true`, but
 * `createKPIDefinition` names the column in its INSERT — and a column DEFAULT
 * only applies when the column is OMITTED. An undefined bound into a named
 * column becomes NULL, and NULL is not true, so every read path
 * (`WHERE is_active = true`) skips the row while `ON CONFLICT (kpi_code)`
 * still refuses to re-create it. The KPI exists, cannot be seen, and cannot be
 * re-added.
 *
 * That is what hid all 33 Customer Success KPIs for a week (2026-09-03). The
 * page said "No active KPIs found for CS Team", which read as "the seeder never
 * ran" — so three republishes were spent on that theory, and a CHECK-constraint
 * fix that turned out to be unnecessary. The rows were in the table the whole
 * time. It was proved by POSTing CS-KPI-02: it returned 500 on the unique
 * index while an identical payload under a fresh code returned 200.
 *
 * Anything added through the "+ Add KPI" button hit the same trap, for any
 * business unit — so this is a platform bug, not a CS one.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const SRC = readFileSync(
  join(__dirname, "../../src/utils/kpiDatabase.ts"),
  "utf8",
);

describe("createKPIDefinition defaults is_active to true", () => {
  it("never binds a bare kpi.is_active into the INSERT", () => {
    // The bug in one line. `kpi.is_active,` on its own became NULL.
    const bare = /^\s*kpi\.is_active,\s*$/m.test(SRC);
    expect(bare, "kpi.is_active is bound without a default — NULL hides the row").toBe(false);
  });

  it("coalesces the flag to true", () => {
    expect(/kpi\.is_active\s*\?\?\s*true/.test(SRC)).toBe(true);
  });

  it("still names is_active in the column list", () => {
    // Dropping the column instead would let the DEFAULT apply, but silently
    // changes behaviour for callers that pass is_active: false on purpose.
    expect(/INSERT INTO kpi_definitions \([^)]*is_active/.test(SRC)).toBe(true);
  });
});

describe("boot repairs rows already stranded", () => {
  it("reactivates only the NULLs", () => {
    const m = /UPDATE kpi_definitions SET is_active = true[\s\S]{0,160}?WHERE is_active IS NULL/.exec(SRC);
    expect(m, "no repair for rows written before the fix").toBeTruthy();
  });

  it("does not touch deliberately deactivated KPIs", () => {
    // `IS NULL`, never `IS NOT TRUE` — the latter would also sweep up
    // is_active = false and undo every deliberate retirement on the platform,
    // including deactivateStaleLegacyKPIs and the GRQ final-seed sweep.
    const repair = /UPDATE kpi_definitions SET is_active = true[\s\S]{0,200}/.exec(SRC)![0];
    expect(repair).toContain("IS NULL");
    expect(repair).not.toContain("IS NOT TRUE");
    expect(repair).not.toContain("is_active = false");
  });

  it("runs after the seeders, so newly seeded rows are covered too", () => {
    const seedAt = SRC.indexOf("await seedCSKPIs();");
    const repairAt = SRC.indexOf("WHERE is_active IS NULL");
    expect(seedAt).toBeGreaterThan(0);
    expect(repairAt).toBeGreaterThan(seedAt);
  });
});

describe("the read path that made this invisible", () => {
  it("filters on is_active = true, which excludes NULL", () => {
    // Documenting the other half of the bug: this filter is correct, and is
    // exactly why a NULL row vanishes rather than erroring.
    expect(SRC).toContain("WHERE owner_name = $1 AND is_active = true");
  });
});
