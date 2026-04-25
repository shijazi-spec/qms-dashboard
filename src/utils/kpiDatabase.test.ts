import { createHarness, exerciseAllKeys, NON_SENSITIVE_MARKER } from "./__redactionTestHarness";

const h = createHarness();
const mod = await import("./kpiDatabase");

console.log("\n=== kpiDatabase.createKPIDefinition ===\n");
await exerciseAllKeys(h, "createKPIDefinition", async (secret, key, payload) => {
  return mod.createKPIDefinition({
    kpi_name: `${NON_SENSITIVE_MARKER} kpi`,
    kpi_code: `K-${key}`,
    description: JSON.stringify({ [key]: secret, marker: NON_SENSITIVE_MARKER, payload }),
    owner_type: "quality_manager",
    owner_name: NON_SENSITIVE_MARKER,
    category: "quality",
    formula: NON_SENSITIVE_MARKER,
    data_source: NON_SENSITIVE_MARKER,
    unit: "%",
    frequency: "monthly",
    threshold_green: 90,
    threshold_amber: 70,
    threshold_red: 50,
    threshold_direction: "higher_is_better",
    target_value: 95,
    weight: 1.0,
    is_active: true,
  } as never);
});

console.log("\n=== kpiDatabase.recordKPIValue ===\n");
await exerciseAllKeys(h, "recordKPIValue", async (secret, key, payload) => {
  return mod.recordKPIValue({
    kpi_id: 1,
    period_start: new Date(),
    period_end: new Date(),
    actual_value: 80,
    target_value: 90,
    status: "amber",
    trend: "stable",
    calculated_by: "system",
    override_reason: NON_SENSITIVE_MARKER,
    ai_confidence: 0.9,
    ai_insights: { [key]: secret, marker: NON_SENSITIVE_MARKER, payload },
  } as never);
});

h.finish("kpiDatabase");
