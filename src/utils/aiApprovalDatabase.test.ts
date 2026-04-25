/**
 * Task #459 secret-leak gate for aiApprovalDatabase write functions.
 *
 * `enqueuePendingAction` already runs `redactSensitiveDeep` on the payload
 * (Task #102), so this gate proves both layers (writer-internal redaction
 * AND the shared redactedPool wrapper) keep the deny-list values out of
 * the final SQL params vector.
 */
import { createHarness, exerciseAllKeys, NON_SENSITIVE_MARKER } from "./__redactionTestHarness";

const h = createHarness();
const mod = await import("./aiApprovalDatabase");

console.log("\n=== aiApprovalDatabase.enqueuePendingAction ===\n");
await exerciseAllKeys(h, "enqueuePendingAction", async (secret, key, payload) => {
  return mod.enqueuePendingAction({
    toolId: "tool-x",
    toolLabel: `${NON_SENSITIVE_MARKER} tool`,
    payload,
    payloadPreview: `${NON_SENSITIVE_MARKER} preview`,
    riskLevel: "medium",
    complianceRefs: [`ref:${NON_SENSITIVE_MARKER}`],
    requestedByUserId: 1,
    requestedByEmail: "user@example.com",
    requestedByName: "User",
    threadId: "th-1",
    ttlHours: 24,
  });
});

h.finish("aiApprovalDatabase");
