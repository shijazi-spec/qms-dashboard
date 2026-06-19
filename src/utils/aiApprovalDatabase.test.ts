/**
 * Task #459 secret-leak gate for aiApprovalDatabase write functions.
 *
 * `enqueuePendingAction` already runs `redactSensitiveDeep` on the payload
 * (Task #102), so this gate proves both layers (writer-internal redaction
 * AND the shared redactedPool wrapper) keep the deny-list values out of
 * the final SQL params vector.
 */
import { Pool } from "pg";
import { createHarness, exerciseAllKeys, NON_SENSITIVE_MARKER } from "./__redactionTestHarness";

const h = createHarness();

// enqueuePendingAction() now runs a dedup probe
//   SELECT * FROM ai_pending_actions WHERE ... status = 'pending'
// BEFORE the INSERT and early-returns if a matching pending row exists. The
// shared harness mock returns a canned row for EVERY query, which would
// short-circuit the enqueue so no INSERT is ever captured ("no INSERT/UPDATE
// captured"). Intercept only the dedup SELECT and return an empty result so
// enqueue proceeds to the INSERT we assert the redaction invariants on. Every
// other query still delegates to the harness mock (which captures writes).
const harnessQuery = (Pool.prototype as any).query;
(Pool.prototype as any).query = function (this: unknown, sql: any) {
  const text = typeof sql === "string" ? sql : sql?.text ?? "";
  if (
    /SELECT \* FROM ai_pending_actions/i.test(text) &&
    /status\s*=\s*'pending'/i.test(text)
  ) {
    return Promise.resolve({ rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] });
  }
  // eslint-disable-next-line prefer-rest-params
  return harnessQuery.apply(this, arguments as any);
};

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
