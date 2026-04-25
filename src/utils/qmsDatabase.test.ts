import { createHarness, exerciseAllKeys, NON_SENSITIVE_MARKER } from "./__redactionTestHarness";

const h = createHarness();
const mod = await import("./qmsDatabase");

console.log("\n=== qmsDatabase.saveDealEvaluation ===\n");
await exerciseAllKeys(h, "saveDealEvaluation", async (secret, key, payload) => {
  return mod.saveDealEvaluation({
    dealId: `D-${key}`,
    dealName: `${NON_SENSITIVE_MARKER} deal`,
    frameworkId: "fw-1",
    scores: {
      overall: 85,
      byDimension: { [key]: 1, marker: NON_SENSITIVE_MARKER } as never,
      byCriteria: { [key]: 1, marker: NON_SENSITIVE_MARKER } as never,
    },
    findings: [{ severity: "minor", description: JSON.stringify({ [key]: secret, marker: NON_SENSITIVE_MARKER, payload }) }] as never,
    recommendations: [{ [key]: secret, marker: NON_SENSITIVE_MARKER, payload }] as never,
    dealData: { [key]: secret, marker: NON_SENSITIVE_MARKER, payload } as never,
  } as never);
});

console.log("\n=== qmsDatabase.createCapaRecord ===\n");
await exerciseAllKeys(h, "createCapaRecord", async (secret, key, payload) => {
  return mod.createCapaRecord({
    title: `${NON_SENSITIVE_MARKER} capa`,
    description: JSON.stringify({ [key]: secret, marker: NON_SENSITIVE_MARKER, payload }),
    source_type: "audit" as never,
    source_id: 1,
    severity: "minor" as never,
    status: "open" as never,
    assigned_to: "ops@example.com",
  } as never);
});

console.log("\n=== qmsDatabase.createNonconformance ===\n");
await exerciseAllKeys(h, "createNonconformance", async (secret, key, payload) => {
  return mod.createNonconformance({
    title: `${NON_SENSITIVE_MARKER} nc`,
    description: `${NON_SENSITIVE_MARKER} desc`,
    nc_type: "process" as never,
    category: "quality" as never,
    source_type: "audit" as never,
    source_id: 1,
    source_reference: "ref",
    severity: "minor" as never,
    status: "open" as never,
    detected_by: "ops@example.com",
    criteria_violations: { [key]: secret, marker: NON_SENSITIVE_MARKER, payload } as never,
    attachments: [{ [key]: secret, marker: NON_SENSITIVE_MARKER, payload }] as never,
    metadata: { [key]: secret, marker: NON_SENSITIVE_MARKER, payload } as never,
  } as never);
});

h.finish("qmsDatabase");
