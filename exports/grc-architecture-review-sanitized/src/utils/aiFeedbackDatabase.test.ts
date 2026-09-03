/**
 * Task #459 secret-leak gate for aiFeedbackDatabase write functions.
 * Reference pattern: src/utils/changeHistoryDatabase.test.ts.
 */
import { createHarness, exerciseAllKeys, NON_SENSITIVE_MARKER } from "./__redactionTestHarness";

const h = createHarness();
const mod = await import("./aiFeedbackDatabase");

console.log("\n=== aiFeedbackDatabase.saveFeedback ===\n");
await exerciseAllKeys(h, "saveFeedback", async (secret, key) => {
  return mod.saveFeedback({
    message_id: "msg-1",
    rating: "up",
    category: NON_SENSITIVE_MARKER,
    comment: `${NON_SENSITIVE_MARKER} (carrying ${key}=${secret})`,
    user_id: "u-1",
    user_email: "<REDACTED_EMAIL>",
    prompt_preview: `${NON_SENSITIVE_MARKER} prompt`,
    response_preview: `${NON_SENSITIVE_MARKER} response`,
    metadata: {
      [key]: secret,
      marker: NON_SENSITIVE_MARKER,
    } as never,
  });
});

h.finish("aiFeedbackDatabase");
