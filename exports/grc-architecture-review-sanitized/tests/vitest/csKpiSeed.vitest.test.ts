/**
 * The 33 Customer Success KPIs of WP-BU-CS-SOP-003 §8.
 *
 * SDR and Sales were seeded long ago; CS never was — so its Quality Reports
 * page read "No active KPIs found for CS Team" while three calculators built
 * for it ran against nothing (found 2026-09-03). Sample User: "I need to add the KPIs
 * from the process itself, like the Sales & SDR that we did before."
 *
 * These assertions are about FAITHFULNESS TO THE CONTROLLED DOCUMENT. The
 * targets are quoted in a certified QMS and reported to the Head of CS, so a
 * transcription slip here is a governance defect, not a typo. The seed itself
 * needs a database; what is checked here is the content of the definitions.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const SRC = readFileSync(join(process.cwd(), "src/utils/kpiDatabase.ts"), "utf8");
const BLOCK = (() => {
  const start = SRC.indexOf("async function seedCSKPIs");
  expect(start).toBeGreaterThan(-1);
  return SRC.slice(start, SRC.indexOf("\n}", SRC.indexOf("for (const k of csKPIs)")));
})();

/** Parse each seeded row into { code, name, target, mode }. */
const ROWS = [...BLOCK.matchAll(/kpi_code: "(CS-KPI-\d+)", kpi_name: "([^"]+)"/g)].map(
  (m) => {
    const line = BLOCK.slice(m.index!, BLOCK.indexOf("\n", m.index!));
    const mode = /calc_mode: "(auto|manual)"/.exec(line)?.[1];
    const pct = /\.\.\.pct(Lower)?\((\d+)/.exec(line);
    const bare = /target_value: (\d+)/.exec(line);
    return {
      code: m[1],
      name: m[2],
      mode,
      target: pct ? Number(pct[2]) : bare ? Number(bare[1]) : null,
      lower: !!pct?.[1] || /lower_is_better/.test(line),
      line,
    };
  },
);

describe("coverage of §8", () => {
  it("seeds all 33 KPIs", () => {
    expect(ROWS).toHaveLength(33);
  });

  it("numbers them CS-KPI-01 to CS-KPI-33 with no gaps or duplicates", () => {
    expect(ROWS.map((r) => r.code)).toEqual(
      Array.from({ length: 33 }, (_, i) => `CS-KPI-${String(i + 1).padStart(2, "0")}`),
    );
  });

  it("keeps the SOP's tier boundaries — 8 individual, 14 process, 11 governance", () => {
    // The tiers are contiguous in §8, so the boundaries are the codes at 08/09
    // and 22/23. Governance starts exactly where the computable ones live.
    expect(ROWS[7].code).toBe("CS-KPI-08");
    expect(ROWS[8].code).toBe("CS-KPI-09");
    expect(ROWS[21].code).toBe("CS-KPI-22");
    expect(ROWS[22].code).toBe("CS-KPI-23");
  });
});

describe("targets, exactly as §8 states them", () => {
  const expected: Record<string, number> = {
    "CS-KPI-01": 100, "CS-KPI-02": 95, "CS-KPI-03": 90, "CS-KPI-04": 90,
    "CS-KPI-05": 95, "CS-KPI-06": 85, "CS-KPI-07": 95, "CS-KPI-08": 95,
    "CS-KPI-09": 90, "CS-KPI-10": 95, "CS-KPI-11": 90, "CS-KPI-12": 70,
    "CS-KPI-13": 95, "CS-KPI-14": 80, "CS-KPI-15": 100, "CS-KPI-16": 95,
    "CS-KPI-17": 2, "CS-KPI-18": 100, "CS-KPI-19": 95, "CS-KPI-20": 80,
    "CS-KPI-21": 15, "CS-KPI-22": 10, "CS-KPI-23": 95, "CS-KPI-24": 95,
    "CS-KPI-25": 90, "CS-KPI-26": 85, "CS-KPI-27": 100, "CS-KPI-28": 100,
    "CS-KPI-29": 100, "CS-KPI-30": 95, "CS-KPI-31": 5, "CS-KPI-32": 95,
    "CS-KPI-33": 100,
  };

  it.each(Object.entries(expected))("%s targets %s", (code, target) => {
    expect(ROWS.find((r) => r.code === code)!.target).toBe(target);
  });
});

describe("direction — a lower-is-better KPI graded upward inverts its own meaning", () => {
  it("grades churn, rework and fulfilment cycle DOWNWARD", () => {
    // ≤15% churn, ≤10% rework, ≤5% rework cycles, ≤2 days fulfilment.
    for (const code of ["CS-KPI-17", "CS-KPI-21", "CS-KPI-22", "CS-KPI-31"]) {
      expect(ROWS.find((r) => r.code === code)!.lower).toBe(true);
    }
  });

  it("grades every other KPI upward", () => {
    const lower = ROWS.filter((r) => r.lower).map((r) => r.code);
    expect(lower.sort()).toEqual(["CS-KPI-17", "CS-KPI-21", "CS-KPI-22", "CS-KPI-31"]);
  });
});

describe("which ones compute", () => {
  it("marks exactly the three with calculators as auto", () => {
    expect(ROWS.filter((r) => r.mode === "auto").map((r) => r.code)).toEqual([
      "CS-KPI-23",
      "CS-KPI-25",
      "CS-KPI-30",
    ]);
  });

  it("matches the calculator registry in kpiProcessCalc", () => {
    const calc = readFileSync(join(process.cwd(), "src/utils/kpiProcessCalc.ts"), "utf8");
    for (const code of ["CS-KPI-23", "CS-KPI-25", "CS-KPI-30"]) {
      expect(calc).toContain(`"${code}": calc`);
    }
    // The registry must NOT claim a CS KPI the seed marks manual — that pairing
    // is what makes a KPI look merely "not yet run" when it can never run.
    const manual = ROWS.filter((r) => r.mode === "manual").map((r) => r.code);
    for (const code of manual) expect(calc).not.toContain(`"${code}": calc`);
  });

  it("records WHY the three auto ones are proxies", () => {
    // §8 sources them from Client-Hub with QA sampling; QMS measures the Zoho
    // mirror. An auditor must see the substitution in the definition itself.
    for (const code of ["CS-KPI-23", "CS-KPI-25", "CS-KPI-30"]) {
      expect(ROWS.find((r) => r.code === code)!.line).toMatch(/proxy|Zoho mirror/);
    }
  });

  it("says why churn rate is not automated", () => {
    expect(ROWS.find((r) => r.code === "CS-KPI-21")!.line).toContain("NOT automated");
  });
});

describe("wiring", () => {
  it("runs at boot beside SDR and Sales", () => {
    expect(SRC).toMatch(/await seedSDRKPIs\(\);\s*\n\s*await seedSalesKPIs\(\);/);
    expect(SRC).toContain("await seedCSKPIs();");
  });

  it("is owned by CS Team, so the CS business unit page finds them", () => {
    // quality_report_bus maps cs_b2b → kpi_owner_name 'CS Team'; a different
    // owner string here means the page stays empty however well it is seeded.
    expect(BLOCK).toContain('const O = "CS Team"');
    expect(BLOCK).toContain('const T = "cs_team"');
  });

  it("does NOT get swept into the blanket auto update for SDR and Sales", () => {
    const sweep = /UPDATE kpi_definitions SET calc_mode = 'auto'\s*\n?\s*WHERE owner_type IN \(([^)]*)\)/.exec(SRC);
    expect(sweep).not.toBeNull();
    expect(sweep![1]).not.toContain("cs_team");
  });

  it("is idempotent, so it backfills onto an already-populated database", () => {
    expect(BLOCK).toContain("ON CONFLICT (kpi_code) DO NOTHING");
  });
});
