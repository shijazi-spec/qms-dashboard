import { createHarness, exerciseAllKeys, NON_SENSITIVE_MARKER } from "./__redactionTestHarness";

const h = createHarness();
const mod = await import("./riskDatabase");

console.log("\n=== riskDatabase.createRisk ===\n");
await exerciseAllKeys(h, "createRisk", async (secret, key, payload) => {
  return mod.createRisk({
    risk_title: `${NON_SENSITIVE_MARKER} risk`,
    risk_description: JSON.stringify({ [key]: secret, marker: NON_SENSITIVE_MARKER, payload }),
    risk_category: "operational",
    risk_source: NON_SENSITIVE_MARKER,
    identified_by: "ops@example.com",
    risk_owner: "owner@example.com",
    owner_department: "qa",
    impact_score: 3,
    likelihood_score: 2,
    treatment_strategy: "mitigate",
    treatment_description: JSON.stringify({ [key]: secret, marker: NON_SENSITIVE_MARKER, payload }),
    treatment_owner: "owner@example.com",
    review_frequency: "quarterly",
    status: "open",
    ai_detected: false,
    ai_recommendations: { [key]: secret, marker: NON_SENSITIVE_MARKER, payload },
  } as never);
});

console.log("\n=== riskDatabase.createTreatmentAction ===\n");
await exerciseAllKeys(h, "createTreatmentAction", async (secret, key, payload) => {
  return mod.createTreatmentAction({
    risk_id: 1,
    action_title: `${NON_SENSITIVE_MARKER} action`,
    action_description: JSON.stringify({ [key]: secret, marker: NON_SENSITIVE_MARKER, payload }),
    action_type: "control_implementation",
    assigned_to: "ops@example.com",
    due_date: new Date(),
    status: "pending",
    milestones: { [key]: secret, marker: NON_SENSITIVE_MARKER, payload } as never,
  } as never);
});

h.finish("riskDatabase");
