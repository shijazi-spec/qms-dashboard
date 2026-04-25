import { createHarness, exerciseAllKeys, NON_SENSITIVE_MARKER } from "./__redactionTestHarness";

const h = createHarness();
const mod = await import("./userAccessDatabase");

console.log("\n=== userAccessDatabase.createInvitation ===\n");
await exerciseAllKeys(h, "createInvitation", async (secret, key, payload) => {
  return mod.createInvitation({
    email: `invitee-${key}@example.com`,
    full_name: JSON.stringify({ [key]: secret, marker: NON_SENSITIVE_MARKER, payload }),
    team: "qa" as never,
    role: "bu_user" as never,
    token_expires_at: new Date(Date.now() + 86_400_000),
    require_mfa: true,
    invited_by: "ops@example.com",
    used: false,
  } as never);
});

console.log("\n=== userAccessDatabase.logAccessEvent ===\n");
await exerciseAllKeys(h, "logAccessEvent", async (secret, key, payload) => {
  return mod.logAccessEvent({
    event_type: "TEST_EVENT",
    user_email: "ops@example.com",
    target_email: "subject@example.com",
    action: `${NON_SENSITIVE_MARKER} action`,
    details: { [key]: secret, marker: NON_SENSITIVE_MARKER, payload },
    performed_by: "ops@example.com",
    ip_address: "127.0.0.1",
  });
});

h.finish("userAccessDatabase");
