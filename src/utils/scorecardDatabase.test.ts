/**
 * Task #459 secret-leak gate for scorecardDatabase write functions.
 */
import { createHarness, exerciseAllKeys, NON_SENSITIVE_MARKER } from "./__redactionTestHarness";

const h = createHarness();
const mod = await import("./scorecardDatabase");

console.log("\n=== scorecardDatabase.saveScorecard ===\n");
await exerciseAllKeys(h, "saveScorecard", async (secret, key) => {
  return mod.saveScorecard({
    employee_name: `${NON_SENSITIVE_MARKER} (carrying ${key}=${secret})`,
    employee_role: "Quality Specialist",
    period_start: new Date("2026-01-01"),
    period_end: new Date("2026-03-31"),
    overall_score: 0.9,
    weighted_score: 0.85,
    kpi_details: [
      {
        kpi_id: `KPI-${key}`,
        kpi_name: `${NON_SENSITIVE_MARKER} kpi`,
        // The redactor walks every leaf, including this nested object — both
        // the deny-list key and credential-shaped string variants land here.
        [key]: secret,
        marker: NON_SENSITIVE_MARKER,
      } as never,
    ],
  });
});

h.finish("scorecardDatabase");
