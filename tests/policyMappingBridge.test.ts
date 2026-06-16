/**
 * Pure-function tests for the policy→Document-Mapping bridge text selector.
 *
 * No database / no file IO — exercises `chooseProjectionText`, the priority
 * logic (content_text → file → description → none) that decides what text a
 * projected Integrated QMS document hands to the clause auto-mapper.
 *
 * Run:  npx tsx tests/policyMappingBridge.test.ts
 */

import { TestSuite } from "./_helpers/runner";
import {
  chooseProjectionText,
  mappingFingerprint,
  MAX_PROJECTION_TEXT,
} from "../src/utils/policyMappingBridge";

const suite = new TestSuite("policyMappingBridge");

console.log("\n=== policy→mapping bridge — pure text-source selection ===\n");

await suite.test("content_text wins over file and description", async () => {
  const r = chooseProjectionText({
    content_text: "the policy body",
    fileText: "file text",
    description: "desc",
  });
  suite.expectEqual(r.source, "content_text", "source");
  suite.expectEqual(r.text, "the policy body", "text");
  suite.expectEqual(r.status, "extracted", "status");
});

await suite.test("falls back to file text when content_text is empty/whitespace", async () => {
  const r = chooseProjectionText({
    content_text: "   ",
    fileText: "extracted from PDF",
    description: "desc",
  });
  suite.expectEqual(r.source, "file", "source");
  suite.expectEqual(r.text, "extracted from PDF", "text");
});

await suite.test("falls back to description when neither content nor file present", async () => {
  const r = chooseProjectionText({
    content_text: "",
    fileText: null,
    description: "short description",
  });
  suite.expectEqual(r.source, "description", "source");
  suite.expectEqual(r.text, "short description", "text");
});

await suite.test("none + empty status when no text at all", async () => {
  const r = chooseProjectionText({
    content_text: null,
    fileText: "",
    description: "   ",
  });
  suite.expectEqual(r.source, "none", "source");
  suite.expectEqual(r.status, "empty", "status");
  suite.expectEqual(r.text, "", "text");
});

await suite.test("undefined fields are handled (no throw, none)", async () => {
  const r = chooseProjectionText({});
  suite.expectEqual(r.source, "none", "source");
  suite.expectEqual(r.status, "empty", "status");
});

await suite.test("text is truncated to MAX_PROJECTION_TEXT", async () => {
  const big = "x".repeat(MAX_PROJECTION_TEXT + 5000);
  const r = chooseProjectionText({ content_text: big });
  suite.expectEqual(r.text.length, MAX_PROJECTION_TEXT, "truncated length");
  suite.expectEqual(r.source, "content_text", "source");
});

console.log("\n=== mapping fingerprint — incremental-skip key ===\n");

await suite.test("same text + same tags → same fingerprint (skip on re-run)", async () => {
  const a = mappingFingerprint("policy body", ["ISO-27001"]);
  const b = mappingFingerprint("policy body", ["ISO-27001"]);
  suite.expectEqual(a, b, "stable");
});

await suite.test("tag order does not change the fingerprint", async () => {
  const a = mappingFingerprint("x", ["ISO-27001", "PDPL"]);
  const b = mappingFingerprint("x", ["PDPL", "ISO-27001"]);
  suite.expectEqual(a, b, "order-independent");
});

await suite.test("changed text → different fingerprint (re-map)", async () => {
  const a = mappingFingerprint("v1", ["ISO-27001"]);
  const b = mappingFingerprint("v2", ["ISO-27001"]);
  suite.expect(a !== b, "text change re-maps");
});

await suite.test("changed tags → different fingerprint (re-map)", async () => {
  const a = mappingFingerprint("x", ["ISO-27001"]);
  const b = mappingFingerprint("x", ["ISO-27001", "PDPL"]);
  suite.expect(a !== b, "tag change re-maps");
});

await suite.test("null vs empty tags are equivalent", async () => {
  suite.expectEqual(
    mappingFingerprint("x", null),
    mappingFingerprint("x", []),
    "null==empty",
  );
});

const { passed, failed } = suite.summarize();
console.log(`\n${suite.title}: ${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);
