/**
 * Task #460 secret-leak gate for obligationDocumentsDatabase write functions.
 *
 * Run:    npx tsx src/utils/obligationDocumentsDatabase.test.ts
 * Wired:  scripts/post-merge.sh (auto-discovered by `npm test`)
 *
 * `linkDocumentToObligation` is the only public writer that persists
 * user-controlled data (the typed numeric ids cannot carry secrets, but the
 * `linked_by` actor string is free-form). The pool is wrapped via
 * createRedactedPool, so the harness drives the writer with a JSON-serialised
 * payload in `linked_by` carrying each deny-list key + the non-sensitive
 * marker, and asserts the raw secret never reaches the INSERT params vector
 * while the REDACTED sentinel + marker do.
 */
import { createHarness, exerciseAllKeys, NON_SENSITIVE_MARKER } from "./__redactionTestHarness";

const h = createHarness();
const mod = await import("./obligationDocumentsDatabase");

console.log("\n=== obligationDocumentsDatabase.linkDocumentToObligation ===\n");
await exerciseAllKeys(h, "linkDocumentToObligation", async (secret, key, payload) => {
  return mod.linkDocumentToObligation({
    obligation_id: 1,
    document_id: 1,
    linked_by: JSON.stringify({
      actor: `${NON_SENSITIVE_MARKER} ${key}`,
      [key]: secret,
      marker: NON_SENSITIVE_MARKER,
      payload,
    }),
  });
});

h.finish("obligationDocumentsDatabase");
