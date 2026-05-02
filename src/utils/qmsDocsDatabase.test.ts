/**
 * Task #460 secret-leak gate for qmsDocsDatabase write functions.
 *
 * Run:    npx tsx src/utils/qmsDocsDatabase.test.ts
 * Wired:  scripts/post-merge.sh (auto-discovered by `npm test`)
 *
 * `createDocument` is the only public writer that accepts free-form,
 * user-controlled prose (`notes`) and a free-form string array
 * (`regulation_codes`). The pool is wrapped via createRedactedPool, so the
 * harness drives `createDocument` with a JSON-serialised payload in `notes`
 * carrying each deny-list key + the non-sensitive marker, and asserts the
 * raw secret never reaches the INSERT params vector while the REDACTED
 * sentinel + marker do.
 */
import { createHarness, exerciseAllKeys, NON_SENSITIVE_MARKER } from "./__redactionTestHarness";

const h = createHarness();
const mod = await import("./qmsDocsDatabase");

console.log("\n=== qmsDocsDatabase.createDocument ===\n");
await exerciseAllKeys(h, "createDocument", async (secret, key, payload) => {
  return mod.createDocument({
    category: "documents",
    title: `${NON_SENSITIVE_MARKER} title ${key}`,
    file_path: `/tmp/${key}.pdf`,
    file_name: `${key}.pdf`,
    file_size: 1024,
    mime_type: "application/pdf",
    notes: JSON.stringify({
      [key]: secret,
      marker: NON_SENSITIVE_MARKER,
      payload,
    }),
    regulation_codes: [`code:${NON_SENSITIVE_MARKER}`],
    uploaded_by: `uploader-${key}@example.com`,
  });
});

h.finish("qmsDocsDatabase");
