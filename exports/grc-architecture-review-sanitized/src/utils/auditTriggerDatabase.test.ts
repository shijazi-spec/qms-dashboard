import { createHarness, exerciseAllKeys, NON_SENSITIVE_MARKER } from "./__redactionTestHarness";

const h = createHarness();
const mod = await import("./auditTriggerDatabase");

console.log("\n=== auditTriggerDatabase.createAuditTrigger ===\n");
await exerciseAllKeys(h, "createAuditTrigger", async (secret, key, payload) => {
  return mod.createAuditTrigger({
    trigger_type: "AUDIT_COMPLETED",
    audit_id: 1,
    audit_date: new Date(),
    severity: "warning",
    title: `${NON_SENSITIVE_MARKER} trigger`,
    description: `${NON_SENSITIVE_MARKER} description`,
    action_required: `${NON_SENSITIVE_MARKER} action`,
    assigned_to: "Sample User",
    assigned_role: "quality_manager",
    status: "pending",
    metadata: payload,
  });
});

console.log("\n=== auditTriggerDatabase.createNotification ===\n");
await exerciseAllKeys(h, "createNotification", async (secret, key, payload) => {
  return mod.createNotification({
    trigger_id: 1,
    recipient_email: "<REDACTED_EMAIL>",
    recipient_role: "quality_manager",
    notification_type: "dashboard",
    subject: `${NON_SENSITIVE_MARKER} subject`,
    message: JSON.stringify({ [key]: secret, marker: NON_SENSITIVE_MARKER, payload }),
    is_read: false,
  });
});

h.finish("auditTriggerDatabase");
