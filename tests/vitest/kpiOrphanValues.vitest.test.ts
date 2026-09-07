/**
 * Orphan auto-values — a number a calculator wrote, on a KPI no calculator
 * maintains any more.
 *
 * The case this exists for: CS-KPI-21 Client Churn Rate displayed a red 61%
 * for three weeks. A calculator wrote it on 2026-08-19; the calculator was
 * removed on 2026-09-02 as unsourceable; the value stayed. On screen it was
 * indistinguishable from a figure a person had entered deliberately.
 *
 * What must stay true:
 *
 *   The predicate names 'manual' EXPLICITLY. Checklist KPIs are also written
 *   as system_auto and are maintained — "anything not auto" would blank them.
 *
 *   Every read path that returns a current value applies it. A path that
 *   forgets is a page still showing the wrong number.
 *
 *   The purge deletes BY ID, from a list it already surveyed and returned.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  isOrphanAutoValue,
  ORPHAN_VALUE_SQL,
  orphanValueSqlForManualIds,
} from "../../src/utils/kpiOrphanValues";

const SRC = readFileSync(
  join(__dirname, "../../src/utils/kpiOrphanValues.ts"),
  "utf8",
);
const DB = readFileSync(
  join(__dirname, "../../src/utils/kpiDatabase.ts"),
  "utf8",
);

/** Body of a named exported function in kpiDatabase.ts. */
const fn = (name: string) =>
  new RegExp(`export async function ${name}\\([\\s\\S]*?\\n\\}`).exec(DB)![0];

describe("what counts as an orphan", () => {
  it("is a machine-written value on a KPI that is now manual", () => {
    expect(
      isOrphanAutoValue({ calc_mode: "manual", calculated_by: "system_auto" }),
    ).toBe(true);
  });

  it("spares checklist KPIs, which are machine-written AND maintained", () => {
    // kpiChecklistDatabase writes these as system_auto. Treating "not auto" as
    // the test would blank every checklist KPI on the platform.
    expect(
      isOrphanAutoValue({
        calc_mode: "checklist",
        calculated_by: "system_auto",
      }),
    ).toBe(false);
  });

  it("spares a live auto KPI", () => {
    expect(
      isOrphanAutoValue({ calc_mode: "auto", calculated_by: "system_auto" }),
    ).toBe(false);
  });

  it("spares anything a person recorded", () => {
    for (const by of ["manual", "system"]) {
      expect(isOrphanAutoValue({ calc_mode: "manual", calculated_by: by })).toBe(
        false,
      );
    }
  });

  it("treats missing fields as not-an-orphan rather than throwing", () => {
    expect(isOrphanAutoValue({})).toBe(false);
    expect(isOrphanAutoValue({ calc_mode: null, calculated_by: null })).toBe(
      false,
    );
  });

  it("says the same thing in SQL as in TypeScript", () => {
    expect(ORPHAN_VALUE_SQL).toContain("kd.calc_mode = 'manual'");
    expect(ORPHAN_VALUE_SQL).toContain("kv.calculated_by = 'system_auto'");
    // Parenthesised: every caller writes `NOT ${ORPHAN_VALUE_SQL}`, and
    // unparenthesised the NOT would bind to the first term only — which would
    // silently invert the meaning rather than fail.
    expect(ORPHAN_VALUE_SQL.startsWith("(")).toBe(true);
    expect(ORPHAN_VALUE_SQL.endsWith(")")).toBe(true);
  });

  it("keeps the id-list form parenthesised and parameterised too", () => {
    const sql = orphanValueSqlForManualIds(4);
    expect(sql.startsWith("(")).toBe(true);
    expect(sql.endsWith(")")).toBe(true);
    expect(sql).toContain("$4::int[]");
    expect(sql).toContain("kv.calculated_by = 'system_auto'");
  });
});

describe("every read path that returns a current value suppresses them", () => {
  for (const name of ["getLatestKPIValue", "getLatestKPIValueForQuarter"]) {
    it(`${name} skips orphan rows`, () => {
      const body = fn(name);
      expect(body).toContain("NOT ${ORPHAN_VALUE_SQL}");
      // It must JOIN the definitions, or calc_mode is not in scope and the
      // predicate silently matches nothing.
      expect(body).toContain("JOIN kpi_definitions");
    });

    it(`${name} falls back rather than blanking`, () => {
      // Excluded in the WHERE, so ORDER BY ... LIMIT 1 lands on the previous
      // legitimate value. A caller that blanked the row afterwards would show
      // "no data" for a KPI that has perfectly good history.
      const body = fn(name);
      expect(body).toContain("ORDER BY");
      expect(body).not.toMatch(/actual_value\s*=\s*null/);
    });
  }

  it("the BU-page batch query applies the same predicate", () => {
    const body = fn("getKPIsWithValuesByOwnerName");
    expect(body).toContain("orphanValueSqlForManualIds");
    expect(body).toContain('=== "manual"');
  });

  it("the BU-page placeholder index matches the argument position", () => {
    // The quarter-scoped call passes 4 arguments and the plain call 2, so the
    // manual-id array is $4 or $2. An off-by-one here reads the ids as a date
    // and Postgres throws at runtime, on a page, in front of a BU head.
    const body = fn("getKPIsWithValuesByOwnerName");
    expect(body).toContain("const orphanIdx = qStart ? 4 : 2");
    expect(body).toContain("orphanValueSqlForManualIds(orphanIdx)");
  });
});

describe("the purge", () => {
  it("deletes by id, from the list it already surveyed", () => {
    // NOT `DELETE ... WHERE <predicate>`: the predicate would be evaluated a
    // second time, against a table that may have changed between the survey
    // and the delete.
    expect(SRC).toContain("DELETE FROM kpi_values WHERE id = ANY($1::int[])");
    expect(SRC).not.toMatch(/DELETE FROM kpi_values\s+WHERE\s+\$\{ORPHAN/);
  });

  it("has no unqualified delete anywhere in the module", () => {
    const deletes = SRC.match(/DELETE FROM \w+(?![\s\S]{0,40}WHERE)/g) || [];
    expect(deletes).toEqual([]);
  });

  it("returns what it removed, so the figure survives the row", () => {
    const body = /export async function purgeOrphanAutoValues[\s\S]*?\n\}/.exec(
      SRC,
    )![0];
    expect(body).toContain("rows");
    expect(body).toContain("logEvent");
  });

  it("never lets a failed audit write fail the purge", () => {
    // logEvent rethrows, and event_logs writes have failed in prod before.
    const body = /export async function purgeOrphanAutoValues[\s\S]*?\n\}/.exec(
      SRC,
    )![0];
    const auditIdx = body.indexOf("logEvent");
    expect(body.slice(0, auditIdx)).toContain("try {");
    expect(body.slice(auditIdx)).toContain("catch");
  });

  it("does nothing at all on a dry run", () => {
    const body = /export async function purgeOrphanAutoValues[\s\S]*?\n\}/.exec(
      SRC,
    )![0];
    const dryIdx = body.indexOf("if (dryRun");
    const delIdx = body.indexOf("DELETE FROM");
    expect(dryIdx).toBeGreaterThan(-1);
    expect(dryIdx).toBeLessThan(delIdx);
    expect(body).toContain("deleted: 0");
  });
});

describe("the sweep covers every team, not just the one that broke", () => {
  it("filters on calc_mode and calculated_by, never on an owner", () => {
    const body = /export async function findOrphanAutoValues[\s\S]*?\n\}/.exec(
      SRC,
    )![0];
    expect(body).toContain("${ORPHAN_VALUE_SQL}");
    expect(body).not.toContain("owner_name =");
    expect(body).not.toContain("kpi_code LIKE");
  });

  it("reaches the pool lazily, so the module graph stays acyclic", () => {
    // kpiDatabase imports ORPHAN_VALUE_SQL from this module; a top-level
    // import of kpiDatabase here would close the cycle.
    expect(SRC).not.toMatch(/^import .*from "\.\/kpiDatabase"/m);
    expect(SRC).toContain('await import("./kpiDatabase")');
  });
});
