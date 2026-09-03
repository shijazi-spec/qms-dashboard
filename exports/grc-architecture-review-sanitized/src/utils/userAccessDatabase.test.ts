import { createHarness, exerciseAllKeys, NON_SENSITIVE_MARKER } from "./__redactionTestHarness";

const h = createHarness();
const mod = await import("./userAccessDatabase");

console.log("\n=== userAccessDatabase.createInvitation ===\n");
await exerciseAllKeys(h, "createInvitation", async (secret, key, payload) => {
  return mod.createInvitation({
    email: `invitee-${key}@<REDACTED_HOST>`,
    full_name: JSON.stringify({ [key]: secret, marker: NON_SENSITIVE_MARKER, payload }),
    team: "qa" as never,
    role: "bu_user" as never,
    token_expires_at: new Date(Date.now() + 86_400_000),
    require_mfa: true,
    invited_by: "user@example.invalid",
    used: false,
  } as never);
});

console.log("\n=== userAccessDatabase.logAccessEvent ===\n");
await exerciseAllKeys(h, "logAccessEvent", async (secret, key, payload) => {
  return mod.logAccessEvent({
    event_type: "TEST_EVENT",
    user_email: "user@example.invalid",
    target_email: "user@example.invalid",
    action: `${NON_SENSITIVE_MARKER} action`,
    details: { [key]: secret, marker: NON_SENSITIVE_MARKER, payload },
    performed_by: "user@example.invalid",
    ip_address: "<REDACTED_IP>",
  });
});

h.finish("userAccessDatabase");
