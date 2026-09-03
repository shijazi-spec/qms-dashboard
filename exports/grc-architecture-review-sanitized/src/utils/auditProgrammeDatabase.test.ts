import { createHarness, exerciseAllKeys, NON_SENSITIVE_MARKER } from "./__redactionTestHarness";

const h = createHarness();
const mod = await import("./auditProgrammeDatabase");

console.log("\n=== auditProgrammeDatabase.createProgramme ===\n");
await exerciseAllKeys(h, "createProgramme", async (secret, key, payload) => {
  return mod.createProgramme({
    title: `${NON_SENSITIVE_MARKER} programme`,
    programme_year: 2026,
    scope_summary: `${NON_SENSITIVE_MARKER} scope`,
    objectives: `${NON_SENSITIVE_MARKER} obj`,
    risk_based_rationale: `${NON_SENSITIVE_MARKER} rationale`,
    planned_audits: [{ [key]: secret, marker: NON_SENSITIVE_MARKER, payload }],
    prepared_by_email: "user@example.invalid",
    prepared_by_name: "Ops",
  });
});

console.log("\n=== auditProgrammeDatabase.createIntake ===\n");
await exerciseAllKeys(h, "createIntake", async (secret, key) => {
  return mod.createIntake({
    title: JSON.stringify({ [key]: secret, marker: NON_SENSITIVE_MARKER }),
    audit_source_party: "internal" as never,
    department: "qa",
    auditor_name: "Auditor",
    audit_date: new Date(),
    file_name: `f-${key}.pdf`,
    file_path: null,
    file_mime: "application/pdf",
    file_sha256: null,
    uploaded_by_email: "user@example.invalid",
  });
});

h.finish("auditProgrammeDatabase");
