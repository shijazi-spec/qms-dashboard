/**
 * Task #459 secret-leak gate for knowledgeDatabase write functions.
 *
 * `ingestDocument()` writes both a `knowledge_documents` row and one or more
 * `knowledge_chunks` rows via `pool.query` on the redacted pool wrapper. To
 * exercise the redaction-relevant path without relying on the secret value
 * itself looking credential-shaped (mfa_secret = "<REDACTED_MFA_SECRET>" and the
 * refresh_token fixture intentionally bypass the regex-only heuristics), we
 * embed each deny-list-keyed payload as a JSON object inside the `description`
 * column. The redactedPool wrapper auto-detects JSON-prefixed string params,
 * walks the parsed object via `redactSensitiveDeep`, and replaces values
 * under sensitive key names with the REDACTED sentinel before re-stringifying.
 */
import { createHarness, exerciseAllKeys, NON_SENSITIVE_MARKER } from "./__redactionTestHarness";

const h = createHarness();
const mod = await import("./knowledgeDatabase");

console.log("\n=== knowledgeDatabase.ingestDocument ===\n");
await exerciseAllKeys(h, "ingestDocument", async (secret, key) => {
  const descriptionPayload = JSON.stringify({
    [key]: secret,
    metadata: { [key]: secret, marker: NON_SENSITIVE_MARKER },
    marker: NON_SENSITIVE_MARKER,
  });
  return mod.ingestDocument(
    {
      title: `${NON_SENSITIVE_MARKER} doc`,
      description: descriptionPayload,
      document_type: "policy",
      file_type: "text/plain",
      uploaded_by: "tester",
      tags: [NON_SENSITIVE_MARKER],
    },
    `Section A\n${NON_SENSITIVE_MARKER}\nMore text.\n`,
  );
});

h.finish("knowledgeDatabase");
