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
    invited_by: "<REDACTED_EMAIL>",
    used: false,
  } as never);
});

console.log("\n=== userAccessDatabase.logAccessEvent ===\n");
await exerciseAllKeys(h, "logAccessEvent", async (secret, key, payload) => {
  return mod.logAccessEvent({
    event_type: "TEST_EVENT",
    user_email: "<REDACTED_EMAIL>",
    target_email: "<REDACTED_EMAIL>",
    action: `${NON_SENSITIVE_MARKER} action`,
    details: { [key]: secret, marker: NON_SENSITIVE_MARKER, payload },
    performed_by: "<REDACTED_EMAIL>",
    ip_address: "<REDACTED_IP>",
  });
});

h.finish("userAccessDatabase");
