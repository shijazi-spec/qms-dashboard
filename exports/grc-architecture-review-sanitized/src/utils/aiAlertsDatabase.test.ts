/**
 * Task #459 secret-leak gate for aiAlertsDatabase write functions.
 *
 * `ai_alerts` is a flat schema (no JSONB column) so secrets that do not
 * match the regex/heuristic pass (mfa_secret, refresh_token in our fixture)
 * cannot be caught when written as plain prose. We embed each deny-list
 * payload as a JSON object inside the `description` text column — the
 * redactedPool wrapper auto-detects JSON-prefixed string params, walks the
 * parsed graph via `redactSensitiveDeep`, and replaces values under
 * sensitive key names with the REDACTED sentinel before re-stringifying.
 */
import { createHarness, exerciseAllKeys, NON_SENSITIVE_MARKER } from "./__redactionTestHarness";

const h = createHarness();
const mod = await import("./aiAlertsDatabase");

console.log("\n=== aiAlertsDatabase.createAIAlert ===\n");
await exerciseAllKeys(h, "createAIAlert", async (secret, key) => {
  const descriptionPayload = JSON.stringify({
    [key]: secret,
    metadata: { [key]: secret, marker: NON_SENSITIVE_MARKER },
    marker: NON_SENSITIVE_MARKER,
  });
  return mod.createAIAlert({
    alert_type: "compliance",
    severity: "high",
    title: `${NON_SENSITIVE_MARKER} alert`,
    description: descriptionPayload,
    suggestion: `${NON_SENSITIVE_MARKER} suggestion`,
    related_module: "qms",
    related_record_id: `rec-${key}`,
  } as never);
});

h.finish("aiAlertsDatabase");
