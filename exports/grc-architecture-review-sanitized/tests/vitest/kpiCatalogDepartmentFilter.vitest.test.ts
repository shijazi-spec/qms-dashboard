/**
 * /api/kpi-catalog must not list DEPARTMENT KPIs (SDR / Sales) — they are
 * reported on their Quality Reports BU page, and listing them here contradicts
 * the note on /kpis that sends people there.
 *
 * The catalog's group keys are `owner_type` values while the BU registry stores
 * `owner_name`, so the route bridges the two. The case that matters most is the
 * third test: 'shared' is BOTH the GRQ Team's own owner_type and
 * getOwnerTypeForOwnerName's fallback for a team with no KPIs yet — so a naive
 * bridge would delete the GRQ Team's group from the page.
 *
 * These exercise the route's exported logic directly rather than driving the
 * handler: the handler dynamically imports kpiDatabase, which vitest's module
 * registry does not reliably intercept from within this suite.
 */
import { describe, it, expect } from "vitest";
import {
  departmentGroupKeys,
  withoutDepartmentGroups,
  withoutDepartmentKpis,
} from "../../src/mastra/routes/kpiCatalogRoutes";

/** Stands in for getOwnerTypeForOwnerName: real teams resolve to their own
 *  owner_type; anything unknown falls back to 'shared', as the real one does. */
const resolveType = async (name: string) =>
  name === "SDR Team" ? "sdr_team" : name === "Sales Team" ? "sales_team" : "shared";

const GROUPS = [
  { key: "<REDACTED_SECRET>" }, { key: "<REDACTED_SECRET>" }, { key: "<REDACTED_SECRET>" },
  { key: "<REDACTED_SECRET>" }, { key: "<REDACTED_SECRET>" }, { key: "<REDACTED_SECRET>" },
];

describe("departmentGroupKeys", () => {
  it("maps the mapped department owner names to their group keys", async () => {
    const keys = await departmentGroupKeys(["SDR Team", "Sales Team"], resolveType);
    expect([...keys].sort()).toEqual(["sales_team", "sdr_team"]);
  });

  it("returns an empty set when no BU maps a KPI owner", async () => {
    expect((await departmentGroupKeys([], resolveType)).size).toBe(0);
  });

  it("NEVER returns 'shared' — that is the GRQ Team's own group", async () => {
    // A newly-mapped department with no KPIs yet resolves to the 'shared'
    // fallback. Treating that as a department key would delete GRQ's section.
    const keys = await departmentGroupKeys(["CS Team"], resolveType);
    expect(keys.has("shared")).toBe(false);
    expect(keys.size).toBe(0);
  });
});

describe("withoutDepartmentGroups", () => {
  it("drops the SDR Team and Sales Team groups, keeps GRQ's", () => {
    const out = withoutDepartmentGroups(GROUPS, new Set(["sdr_team", "sales_team"]));
    const keys = out.map((g) => g.key);
    expect(keys).not.toContain("sdr_team");
    expect(keys).not.toContain("sales_team");
    expect(keys).toContain("shared");
    expect(keys).toContain("quality_manager");
    expect(keys).toContain("grc_manager");
  });

  it("changes nothing when the department key set is empty", () => {
    const out = withoutDepartmentGroups(GROUPS, new Set());
    expect(out.map((g) => g.key)).toEqual(GROUPS.map((g) => g.key));
  });
});

describe("withoutDepartmentKpis", () => {
  const rows = [
    { kpi_code: "SHR-KPI-01", owner_name: "Sample User" },
    { kpi_code: "CS-KPI-01", owner_name: "Sample User" },
    { kpi_code: "LEGACY-01", owner_name: null },
  ];

  it("removes a department KPI that landed in another group", () => {
    // A future department's first KPI falls back to owner_type 'shared', so it
    // would otherwise surface inside the GRQ Team group, which is never dropped.
    const out = withoutDepartmentKpis(rows, ["CS Team"]).map((r) => r.kpi_code);
    expect(out).toContain("SHR-KPI-01");
    expect(out).not.toContain("CS-KPI-01");
  });

  it("keeps a NULL-owner KPI — that is a GRQ KPI", () => {
    const out = withoutDepartmentKpis(rows, ["CS Team", "GRQ Team"]).map((r) => r.kpi_code);
    expect(out).toEqual(["LEGACY-01"]);
  });

  it("changes nothing when no owner names are departmental", () => {
    expect(withoutDepartmentKpis(rows, [])).toEqual(rows);
  });
});
