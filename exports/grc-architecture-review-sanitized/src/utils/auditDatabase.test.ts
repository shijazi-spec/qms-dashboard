import { createHarness, exerciseAllKeys, NON_SENSITIVE_MARKER } from "./__redactionTestHarness";

const h = createHarness();
const mod = await import("./auditDatabase");

console.log("\n=== auditDatabase.createAudit ===\n");
await exerciseAllKeys(h, "createAudit", async (secret, key, payload) => {
  return mod.createAudit({
    audit_code: `AUD-${key}`,
    title: `${NON_SENSITIVE_MARKER} audit`,
    description: JSON.stringify({ [key]: secret, marker: NON_SENSITIVE_MARKER, payload }),
    audit_type: "internal",
    scope: NON_SENSITIVE_MARKER,
    audit_standard: "ISO 9001",
    lead_auditor: "user@example.invalid",
    auditee_department: "qa",
    status: "planned",
    created_by: "Sample User",
  } as never);
});

console.log("\n=== auditDatabase.createFinding ===\n");
await exerciseAllKeys(h, "createFinding", async (secret, key, payload) => {
  return mod.createFinding({
    audit_id: 1,
    finding_code: `F-${key}`,
    title: `${NON_SENSITIVE_MARKER} finding`,
    description: JSON.stringify({ [key]: secret, marker: NON_SENSITIVE_MARKER, payload }),
    category: "nonconformity",
    severity: "minor",
    status: "open",
  } as never);
});

console.log("\n=== auditDatabase.createEvidencePack ===\n");
await exerciseAllKeys(h, "createEvidencePack", async (secret, key, payload) => {
  return mod.createEvidencePack({
    pack_name: `${NON_SENSITIVE_MARKER} pack`,
    description: `${NON_SENSITIVE_MARKER} desc`,
    audit_id: 1,
    evidence_items: [{ [key]: secret, marker: NON_SENSITIVE_MARKER, payload }],
    generated_by: "user@example.invalid",
    status: "draft",
  } as never);
});

h.finish("auditDatabase");
