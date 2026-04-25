import { createHarness, exerciseAllKeys, NON_SENSITIVE_MARKER } from "./__redactionTestHarness";

const h = createHarness();
const mod = await import("./vendorDatabase");

console.log("\n=== vendorDatabase.createVendor ===\n");
await exerciseAllKeys(h, "createVendor", async (secret, key, payload) => {
  return mod.createVendor({
    vendor_code: `V-${key}`,
    name: `${NON_SENSITIVE_MARKER} vendor`,
    description: JSON.stringify({ [key]: secret, marker: NON_SENSITIVE_MARKER, payload }),
    category: "technology",
    criticality: "medium",
    status: "pending_approval",
    contract_value: 100000,
    primary_contact_name: NON_SENSITIVE_MARKER,
    primary_contact_email: "contact@example.com",
    primary_contact_phone: "+1-555-0100",
    country: "SA",
    services_provided: JSON.stringify({ [key]: secret, marker: NON_SENSITIVE_MARKER, payload }),
    data_access_level: "limited",
    owner_name: NON_SENSITIVE_MARKER,
    owner_department: "procurement",
    created_by: "ops@example.com",
  } as never);
});

console.log("\n=== vendorDatabase.createAssessment ===\n");
await exerciseAllKeys(h, "createAssessment", async (secret, key, payload) => {
  return mod.createAssessment({
    vendor_id: 1,
    assessment_type: "initial",
    assessment_date: new Date(),
    assessed_by: "ops@example.com",
    status: "draft",
    security_score: 80,
    financial_score: 80,
    operational_score: 80,
    compliance_score: 80,
    security_findings: JSON.stringify({ [key]: secret, marker: NON_SENSITIVE_MARKER, payload }),
    financial_findings: NON_SENSITIVE_MARKER,
    operational_findings: NON_SENSITIVE_MARKER,
    compliance_findings: NON_SENSITIVE_MARKER,
    recommendations: NON_SENSITIVE_MARKER,
  } as never);
});

console.log("\n=== vendorDatabase.createRemediation ===\n");
await exerciseAllKeys(h, "createRemediation", async (secret, key, payload) => {
  return mod.createRemediation({
    vendor_id: 1,
    assessment_id: 1,
    title: `${NON_SENSITIVE_MARKER} remediation`,
    description: JSON.stringify({ [key]: secret, marker: NON_SENSITIVE_MARKER, payload }),
    priority: "medium",
    category: "security",
    status: "open",
    assigned_to: "ops@example.com",
    due_date: new Date(),
  } as never);
});

h.finish("vendorDatabase");
