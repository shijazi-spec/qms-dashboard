import { createHarness, exerciseAllKeys, NON_SENSITIVE_MARKER } from "./__redactionTestHarness";

const h = createHarness();
const mod = await import("./policyDatabase");

console.log("\n=== policyDatabase.createPolicy ===\n");
await exerciseAllKeys(h, "createPolicy", async (secret, key, payload) => {
  return mod.createPolicy({
    policy_number: `P-${key}`,
    title: `${NON_SENSITIVE_MARKER} policy`,
    description: JSON.stringify({ [key]: secret, marker: NON_SENSITIVE_MARKER, payload }),
    category: "security",
    document_type: "policy",
    document_number: `D-${key}`,
    version: "1.0",
    status: "draft",
    owner_name: NON_SENSITIVE_MARKER,
    owner_department: "security",
    approver_name: NON_SENSITIVE_MARKER,
    content_text: JSON.stringify({ [key]: secret, marker: NON_SENSITIVE_MARKER, payload }),
    confidentiality: "internal",
    distribution_list: [`list:${NON_SENSITIVE_MARKER}`],
    tags: [`tag:${NON_SENSITIVE_MARKER}`],
    requires_acknowledgment: false,
    acknowledgment_frequency: "annual",
    change_summary: NON_SENSITIVE_MARKER,
    created_by: "Sample User",
  } as never);
});

h.finish("policyDatabase");
