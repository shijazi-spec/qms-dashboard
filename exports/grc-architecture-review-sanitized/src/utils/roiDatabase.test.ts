import { createHarness, exerciseAllKeys, NON_SENSITIVE_MARKER } from "./__redactionTestHarness";

const h = createHarness();
const mod = await import("./roiDatabase");

console.log("\n=== roiDatabase.createROIInitiative ===\n");
await exerciseAllKeys(h, "createROIInitiative", async (secret, key, payload) => {
  return mod.createROIInitiative({
    project_name: `${NON_SENSITIVE_MARKER} initiative`,
    owner: "<REDACTED_EMAIL>",
    department: "qa",
    description: `${NON_SENSITIVE_MARKER} desc`,
    problem_statement: JSON.stringify({ [key]: secret, marker: NON_SENSITIVE_MARKER, payload }),
    baseline_cost: 10000,
    expected_savings_monthly: 1000,
    implementation_cost: 5000,
    project_duration_months: 12,
    discount_rate: 0.1,
    expected_revenue_increase: 0,
    avoided_cost: 0,
    status: "draft",
    priority: "medium",
    created_by: "Sample User",
    metadata: { [key]: secret, marker: NON_SENSITIVE_MARKER, payload },
  } as never);
});

h.finish("roiDatabase");
