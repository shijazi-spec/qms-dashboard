import { createHarness, exerciseAllKeys, NON_SENSITIVE_MARKER } from "./__redactionTestHarness";

const h = createHarness();
const mod = await import("./complianceDatabase");

console.log("\n=== complianceDatabase.createObligation ===\n");
await exerciseAllKeys(h, "createObligation", async (secret, key, payload) => {
  return mod.createObligation({
    obligation_code: `OBL-${key}`,
    regulation_id: 1,
    article_reference: "Art. 5",
    title: `${NON_SENSITIVE_MARKER} title`,
    description: JSON.stringify({ [key]: secret, marker: NON_SENSITIVE_MARKER, payload }),
    requirement_type: "mandatory",
    control_type: "preventive",
    compliance_frequency: "annual",
    evidence_requirements: `${NON_SENSITIVE_MARKER} req`,
    penalty_for_noncompliance: `${NON_SENSITIVE_MARKER} penalty`,
    responsible_department: "qa",
    responsible_role: "manager",
    status: "applicable",
    priority: "medium",
  } as never);
});

console.log("\n=== complianceDatabase.createAssessment ===\n");
await exerciseAllKeys(h, "createAssessment", async (secret, key, payload) => {
  return mod.createAssessment({
    obligation_id: 1,
    assessment_date: new Date(),
    assessed_by: "user@example.invalid",
    compliance_status: "compliant",
    score: 90,
    evidence_provided: `${NON_SENSITIVE_MARKER} evidence`,
    gaps_identified: `${NON_SENSITIVE_MARKER} gaps`,
    remediation_required: false,
    comments: JSON.stringify({ [key]: secret, marker: NON_SENSITIVE_MARKER, payload }),
  } as never);
});

console.log("\n=== complianceDatabase.createRegulation ===\n");
await exerciseAllKeys(h, "createRegulation", async (secret, key, payload) => {
  return mod.createRegulation({
    regulation_code: `REG-${key}`,
    name: `${NON_SENSITIVE_MARKER} reg`,
    description: JSON.stringify({ [key]: secret, marker: NON_SENSITIVE_MARKER, payload }),
    jurisdiction: "SA",
    category: "data_privacy" as never,
    issuing_body: "Authority",
    status: "active" as never,
    version: "1.0",
  } as never);
});

h.finish("complianceDatabase");
