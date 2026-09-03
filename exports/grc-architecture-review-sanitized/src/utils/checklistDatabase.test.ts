import { createHarness, exerciseAllKeys, NON_SENSITIVE_MARKER } from "./__redactionTestHarness";

const h = createHarness();
const mod = await import("./checklistDatabase");

console.log("\n=== checklistDatabase.createChecklist ===\n");
await exerciseAllKeys(h, "createChecklist", async (secret, key, payload) => {
  return mod.createChecklist({
    name: `${NON_SENSITIVE_MARKER} checklist`,
    description: JSON.stringify({ [key]: secret, marker: NON_SENSITIVE_MARKER, payload }),
    standard: "ISO 27001",
    version: "1.0",
    category: "security",
    is_active: true,
    created_by: "Sample User",
  } as never);
});

console.log("\n=== checklistDatabase.addChecklistItems ===\n");
await exerciseAllKeys(h, "addChecklistItems", async (secret, key, payload) => {
  return mod.addChecklistItems(1, [
    {
      item_number: 1,
      clause_reference: "A.5.1",
      question: `${NON_SENSITIVE_MARKER} question`,
      expected_result: `${NON_SENSITIVE_MARKER} expected`,
      check_type: "manual" as never,
      module_to_query: "audit",
      query_config: { [key]: secret, marker: NON_SENSITIVE_MARKER, payload },
      weight: 1.0,
      is_critical: false,
    } as never,
  ]);
});

console.log("\n=== checklistDatabase.saveChecklistRun ===\n");
await exerciseAllKeys(h, "saveChecklistRun", async (secret, key, payload) => {
  return mod.saveChecklistRun({
    checklist_id: 1,
    overall_score: 85,
    total_items: 1,
    passed_items: 1,
    failed_items: 0,
    na_items: 0,
    item_results: [{ [key]: secret, marker: NON_SENSITIVE_MARKER, payload }] as never,
    run_by: "<REDACTED_EMAIL>",
    notes: NON_SENSITIVE_MARKER,
  } as never);
});

h.finish("checklistDatabase");
