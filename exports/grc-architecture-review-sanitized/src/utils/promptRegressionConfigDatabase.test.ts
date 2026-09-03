/**
 * Task #754 secret-leak gate for promptRegressionConfigDatabase write functions.
 *
 * Drives setPromptRegressionConfigOverrides() with payloads that carry every
 * deny-list key (password_hash, mfa_secret, access_token, refresh_token,
 * api_key) inside the free-text fields the writer accepts (changedBy, note),
 * and asserts the raw secret never reaches the INSERT/UPDATE params vector.
 * Redaction is provided by wrapPoolForRedaction(sharedPool) at the module level.
 */
import { createHarness, exerciseAllKeys, NON_SENSITIVE_MARKER } from "./__redactionTestHarness";

const h = createHarness();
const mod = await import("./promptRegressionConfigDatabase");

console.log("\n=== promptRegressionConfigDatabase.setPromptRegressionConfigOverrides ===\n");
await exerciseAllKeys(h, "setPromptRegressionConfigOverrides", async (secret, key) => {
  return mod.setPromptRegressionConfigOverrides({
    overrides: {
      dropPctPoints: 7,
      minFeedback: 25,
      windowDays: 14,
      notifyThrottleMin: 60,
    },
    changedBy: `${NON_SENSITIVE_MARKER} ${key}`,
    note: `${NON_SENSITIVE_MARKER} (carrying ${key}=${secret})`,
  });
});

h.finish("promptRegressionConfigDatabase");
