import { createHarness, exerciseAllKeys, NON_SENSITIVE_MARKER } from "./__redactionTestHarness";

const h = createHarness();
const mod = await import("./managementReviewDatabase");

console.log("\n=== managementReviewDatabase.createReview ===\n");
await exerciseAllKeys(h, "createReview", async (secret, key, payload) => {
  // Embed deny-list keys as top-level properties of the JSONB-shaped fields
  // (agenda_items / decisions / input_summary). The redactedPool wrapper
  // auto-parses each JSON-stringified array/object param and walks the graph
  // structurally — keys that match the deny list (password_hash, mfa_secret,
  // access_token, refresh_token, api_key) are sentinel'd regardless of
  // whether the value is regex-detectable.
  return mod.createReview({
    review_number: `MR-${key}`,
    title: `${NON_SENSITIVE_MARKER} review`,
    review_date: "2026-04-25",
    chair: "Quality Manager",
    attendees: [`attendee:${NON_SENSITIVE_MARKER}`],
    status: "planned",
    agenda_items: [
      { topic: NON_SENSITIVE_MARKER, [key]: secret, marker: NON_SENSITIVE_MARKER, payload } as never,
    ],
    minutes: NON_SENSITIVE_MARKER,
    decisions: [
      { decision: NON_SENSITIVE_MARKER, decided_by: "chair", priority: "high", [key]: secret, marker: NON_SENSITIVE_MARKER, payload } as never,
    ],
    input_summary: { [key]: secret, marker: NON_SENSITIVE_MARKER, payload } as never,
    output_summary: NON_SENSITIVE_MARKER,
    created_by: "Sample User",
  } as never);
});

console.log("\n=== managementReviewDatabase.addReviewAction ===\n");
await exerciseAllKeys(h, "addReviewAction", async (secret, key, payload) => {
  return mod.addReviewAction(1, {
    action_number: 1,
    description: JSON.stringify({ [key]: secret, marker: NON_SENSITIVE_MARKER, payload }),
    assigned_to: "Sample User",
    due_date: "2026-05-25",
    status: "open",
    priority: "high",
  } as never);
});

h.finish("managementReviewDatabase");
