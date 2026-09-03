/**
 * Task #459 secret-leak gate for onboardingDatabase.
 *
 * `createOrUpdateOnboardingStatus` reads via `getUserOnboardingStatus()`
 * before deciding INSERT vs UPDATE, and the harness's mock pool returns a
 * non-empty stub row for every query — which forces the writer down the
 * UPDATE branch. That branch only allows boolean/numeric onboarding fields
 * (video_watched, tour_completed, …), so there is no redaction-relevant
 * string column to drive secrets through. We therefore only exercise
 * `createDemoLink`, whose `description` text column does carry user-supplied
 * content and goes through the redacted pool wrapper directly. (The same
 * pool wrapper protects the unreachable INSERT branch by construction.)
 */
import { createHarness, exerciseAllKeys, NON_SENSITIVE_MARKER } from "./__redactionTestHarness";

const h = createHarness();
const mod = await import("./onboardingDatabase");

console.log("\n=== onboardingDatabase.createDemoLink ===\n");
await exerciseAllKeys(h, "createDemoLink", async (secret, key, payload) => {
  return mod.createDemoLink({
    created_by: "Sample User",
    created_by_email: "user@example.invalid",
    description: JSON.stringify({ [key]: secret, marker: NON_SENSITIVE_MARKER, payload }),
    expires_at: new Date(Date.now() + 86_400_000),
  });
});

h.finish("onboardingDatabase");
