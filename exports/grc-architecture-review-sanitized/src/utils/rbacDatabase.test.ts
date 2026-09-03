import { createHarness, exerciseAllKeys, NON_SENSITIVE_MARKER } from "./__redactionTestHarness";

const h = createHarness();
const mod = await import("./rbacDatabase");

console.log("\n=== rbacDatabase.createSystemUser ===\n");
await exerciseAllKeys(h, "createSystemUser", async (secret, key, payload) => {
  return mod.createSystemUser({
    email: `user-${key}@<REDACTED_HOST>`,
    name: `${NON_SENSITIVE_MARKER} user`,
    role: "bu_user" as never,
    department: "qa",
    is_active: true,
    permissions: [{ [key]: secret, marker: NON_SENSITIVE_MARKER, payload }] as never,
  } as never);
});

console.log("\n=== rbacDatabase.createBuProcess ===\n");
await exerciseAllKeys(h, "createBuProcess", async (secret, key, payload) => {
  return mod.createBuProcess({
    process_code: `BP-${key}`,
    process_name: `${NON_SENSITIVE_MARKER} process`,
    department: "qa",
    owner_name: NON_SENSITIVE_MARKER,
    owner_email: "<REDACTED_EMAIL>",
    description: JSON.stringify({ [key]: secret, marker: NON_SENSITIVE_MARKER, payload }),
    is_active: true,
    linked_control_ids: [],
  });
});

h.finish("rbacDatabase");
