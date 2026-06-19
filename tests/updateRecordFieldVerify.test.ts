import assert from "node:assert";
import {
  fieldValuesMatch,
  computeReadBackMismatches,
} from "../src/mastra/tools/updateRecordFieldTool";

/*
 * Read-back verification for update-record-field.
 *
 * Root-cause context: Zoho's v2 write API returns HTTP 200 + code:SUCCESS even
 * when a field is NOT actually persisted (field-level profile permission, a
 * validation rule that reverts the value, or a no-op). The tool now re-reads
 * the record and compares with fieldValuesMatch() before claiming success, so
 * an approval can no longer show "Executed" while Zoho is unchanged.
 *
 * These cases lock the comparison's leniency (so Zoho's own normalization does
 * NOT cause a false "did not change") AND its strictness (a genuinely unchanged
 * value is reported as a mismatch).
 */

// --- fieldValuesMatch ---

// Exact match.
assert.strictEqual(fieldValuesMatch("ralsannat@masdr.sa", "ralsannat@masdr.sa"), true);

// Trim differences are ignored.
assert.strictEqual(fieldValuesMatch("  ralsannat@masdr.sa ", "ralsannat@masdr.sa"), true);

// Case-insensitive (Zoho may normalize email/URL casing).
assert.strictEqual(fieldValuesMatch("RALSANNAT@MASDR.SA", "ralsannat@masdr.sa"), true);
assert.strictEqual(fieldValuesMatch("https://Example.com", "https://example.com"), true);

// Phone: Zoho may reformat — digit-only match counts as success, but ONLY when
// the field name is phone-like.
assert.strictEqual(fieldValuesMatch("+1 (555) 123-4567", "15551234567", "Phone"), true);
assert.strictEqual(fieldValuesMatch("555-1234", "5551234", "Mobile"), true);

// Digit-only equivalence must NOT apply to arbitrary (non-phone) fields — a
// reformatted-looking value on a custom/id field is a real mismatch.
assert.strictEqual(fieldValuesMatch("+1 (555) 123-4567", "15551234567"), false);
assert.strictEqual(fieldValuesMatch("1234", "1-2-3-4", "Account_Number"), false);

// THE BUG CASE: Zoho said SUCCESS but the stale value is still there.
assert.strictEqual(fieldValuesMatch("test@test.test.test", "ralsannat@masdr.sa"), false);

// A field that was never written (null/empty) is a mismatch, not a pass.
assert.strictEqual(fieldValuesMatch(null, "ralsannat@masdr.sa"), false);
assert.strictEqual(fieldValuesMatch(undefined, "ralsannat@masdr.sa"), false);
assert.strictEqual(fieldValuesMatch("", "ralsannat@masdr.sa"), false);

// Short numeric strings must NOT collapse via the digit-only path (the
// >= 4 digit guard prevents "12" matching "1 2" style false positives).
assert.strictEqual(fieldValuesMatch("12", "1-2", "Phone"), false);

// --- computeReadBackMismatches (tool-level outcome shape) ---

// All fields persisted -> no mismatches -> tool returns success.
assert.deepStrictEqual(
  computeReadBackMismatches(
    { Email: "ralsannat@masdr.sa", Phone: "15551234567" },
    { Email: "ralsannat@masdr.sa", Phone: "+1 (555) 123-4567" },
  ),
  [],
);

// THE BUG CASE end-to-end: Zoho SUCCESS but value unchanged -> mismatch listed
// with the actual stored value, which drives success:false on the tool.
{
  const m = computeReadBackMismatches(
    { Email: "ralsannat@masdr.sa" },
    { Email: "test@test.test.test" },
  );
  assert.strictEqual(m.length, 1);
  assert.match(m[0], /Email still shows "test@test\.test\.test"/);
  assert.match(m[0], /expected "ralsannat@masdr\.sa"/);
}

// Mixed multi-field: one persisted, one did not -> only the failing field is
// reported.
{
  const m = computeReadBackMismatches(
    { Email: "new@masdr.sa", Last_Name: "alSannat" },
    { Email: "old@test.test", Last_Name: "alSannat" },
  );
  assert.strictEqual(m.length, 1);
  assert.match(m[0], /Email still shows "old@test\.test"/);
}

// Record vanished / not returned on read-back -> treated as a mismatch.
assert.deepStrictEqual(computeReadBackMismatches({ Email: "x@y.z" }, null), [
  "record could not be found on read-back",
]);

// Empty stored value is surfaced as "(empty)" rather than the literal "".
{
  const m = computeReadBackMismatches({ Email: "x@y.z" }, { Email: "" });
  assert.match(m[0], /still shows "\(empty\)"/);
}

console.log("✅ updateRecordFieldVerify.test.ts — all assertions passed");
