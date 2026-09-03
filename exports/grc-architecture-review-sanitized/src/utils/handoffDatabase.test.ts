import { createHarness, exerciseAllKeys, NON_SENSITIVE_MARKER } from "./__redactionTestHarness";

const h = createHarness();
const mod = await import("./handoffDatabase");

console.log("\n=== handoffDatabase.createHandoffRule ===\n");
await exerciseAllKeys(h, "createHandoffRule", async (secret, key, payload) => {
  return mod.createHandoffRule({
    rule_code: `R-${key}`,
    name: `${NON_SENSITIVE_MARKER} rule`,
    description: JSON.stringify({ [key]: secret, marker: NON_SENSITIVE_MARKER, payload }),
    source_module: "qms",
    target_module: "risks",
    trigger_type: "threshold",
    trigger_condition: NON_SENSITIVE_MARKER,
    action_type: "create_risk",
    action_config: JSON.stringify({ [key]: secret, marker: NON_SENSITIVE_MARKER, payload }),
    priority: "medium",
    is_active: true,
    created_by: "Sample User",
  });
});

console.log("\n=== handoffDatabase.createHandoffEvent ===\n");
await exerciseAllKeys(h, "createHandoffEvent", async (secret, key, payload) => {
  return mod.createHandoffEvent({
    rule_id: 1,
    source_record_id: `src-${key}`,
    source_module: "qms",
    target_module: "risks",
    action_type: "create_risk",
    status: "pending",
    details: { [key]: secret, marker: NON_SENSITIVE_MARKER, payload } as never,
  } as never);
});

h.finish("handoffDatabase");
