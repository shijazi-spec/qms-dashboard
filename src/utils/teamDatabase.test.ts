import { createHarness, exerciseAllKeys, NON_SENSITIVE_MARKER } from "./__redactionTestHarness";

const h = createHarness();
const mod = await import("./teamDatabase");

console.log("\n=== teamDatabase.createTeamMember ===\n");
await exerciseAllKeys(h, "createTeamMember", async (secret, key, payload) => {
  return mod.createTeamMember({
    full_name: `${NON_SENSITIVE_MARKER} person`,
    email: `member-${key}@example.com`,
    role: "engineer",
    department: "qa",
    job_title: NON_SENSITIVE_MARKER,
    hire_date: new Date(),
    manager_id: "TM-1",
    phone: "+1-555-0100",
    skills: [`skill:${NON_SENSITIVE_MARKER}`],
    certifications: [`cert:${NON_SENSITIVE_MARKER}`],
    status: "active",
    performance_score: 85,
    training_compliance_rate: 100,
    projects_completed: 0,
    avatar_url: null as never,
    metadata: { [key]: secret, marker: NON_SENSITIVE_MARKER, payload },
  } as never);
});

h.finish("teamDatabase");
