/**
 * Tests for sensitive-field masking in the AI pending-actions payload store.
 *
 * Verifies that `enqueuePendingAction()` and `recordExecutionResult()` in
 * `src/utils/aiApprovalDatabase.ts` route their JSONB columns
 * (`payload` and `execution_result.data`) through `redactSensitiveFields()`
 * before INSERT/UPDATE so credential fields are never persisted in plaintext.
 *
 * Run:  npx tsx tests/aiApprovalRedaction.test.ts
 */

import type { QueryResult, QueryResultRow } from "pg";
import {
  aiApprovalPool,
  enqueuePendingAction,
  recordExecutionResult,
  type PendingAction,
} from "../src/utils/aiApprovalDatabase";
import { REDACTED_SENTINEL } from "../src/utils/eventLogsDatabase";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

interface CapturedQuery {
  sql: string;
  params: ReadonlyArray<unknown>;
}

const captured: CapturedQuery[] = [];

/**
 * Typed stub query function. Matches the overload used inside
 * aiApprovalDatabase.ts:  pool.query<Row>(sql, params).
 */
type StubQuery = <R extends QueryResultRow>(
  sql: string,
  params?: ReadonlyArray<unknown>,
) => Promise<QueryResult<R>>;

const stubQuery: StubQuery = async <R extends QueryResultRow>(
  sql: string,
  params: ReadonlyArray<unknown> = [],
): Promise<QueryResult<R>> => {
  captured.push({ sql, params });

  const empty: QueryResult<R> = {
    command: "",
    rowCount: 0,
    oid: 0,
    fields: [],
    rows: [],
  };

  if (/^\s*CREATE TABLE/i.test(sql) || /^\s*CREATE INDEX/i.test(sql)) {
    return empty;
  }

  if (/INSERT INTO ai_pending_actions/i.test(sql)) {
    const row: PendingAction = {
      id: 1,
      action_code: String(params[0]),
      tool_id: String(params[1]),
      tool_label: String(params[2]),
      payload: JSON.parse(String(params[3])),
      payload_preview: String(params[4]),
      payload_checksum: String(params[5]),
      risk_level: params[6] as PendingAction["risk_level"],
      compliance_refs: JSON.parse(String(params[7])),
      requested_by_user_id: params[8] as number | null,
      requested_by_email: params[9] as string | null,
      requested_by_name: params[10] as string | null,
      thread_id: params[11] as string | null,
      status: "pending",
      reviewed_by_user_id: null,
      reviewed_by_email: null,
      reviewed_by_name: null,
      reviewed_at: null,
      rejection_reason: null,
      executed_at: null,
      execution_result: null,
      result_entity_type: null,
      result_entity_id: null,
      created_at: new Date(),
      expires_at: new Date(Date.now() + 24 * 3600 * 1000),
    };
    return { ...empty, command: "INSERT", rowCount: 1, rows: [row as unknown as R] };
  }

  if (/UPDATE ai_pending_actions/i.test(sql)) {
    const success = params[1] === true;
    const row: Partial<PendingAction> = {
      id: 1,
      action_code: String(params[0]),
      execution_result: JSON.parse(String(params[2])),
      result_entity_type: params[3] as string | null,
      result_entity_id: params[4] as string | null,
      status: success ? "executed" : "failed",
    };
    return { ...empty, command: "UPDATE", rowCount: 1, rows: [row as unknown as R] };
  }

  return empty;
};

aiApprovalPool.query = stubQuery as typeof aiApprovalPool.query;

async function run(): Promise<void> {
  console.log("\n[aiApprovalDatabase] sensitive-field redaction");

  const SECRET_KEY = "sk-live-NEVER_PERSIST_ME_1234567890";
  const SECRET_TOKEN = "ghp_topsecretrefreshtokenabcdefghijklmnoXYZ";
  const SECRET_PASSWORD = "P@ssw0rd!_plaintext";
  const SECRET_BCRYPT = "$2b$12$abcdefghijklmnopqrstuv1234567890ABCDEFGHIJKLMNOPQRSTU";
  const SECRET_JWT =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  const SAFE_TOOL = "rotate_api_key";
  const SAFE_DESCRIPTION = "Rotate Zoho API key for the books integration";
  const PREVIEW_PROSE_PREFIX = "Rotate API key for zoho_books — new key=";

  const enqueued = await enqueuePendingAction({
    toolId: SAFE_TOOL,
    toolLabel: "Rotate API Key",
    payload: {
      target_integration: "zoho_books",
      api_key: SECRET_KEY,
      refresh_token: SECRET_TOKEN,
      nested: {
        password: SECRET_PASSWORD,
        username: "service-account@walaplus.com",
      },
      reason: SAFE_DESCRIPTION,
      // Innocuously-named fields that still contain credential-shaped values:
      // the key-based deny-list is blind to these; only deepRedactSecretLikeStrings
      // can catch them.
      note: `rotated to ${SECRET_KEY}`,
      message: `auth header: Bearer ${SECRET_TOKEN.slice(0, 30)}`,
      config_diff: `old=${SECRET_BCRYPT}`,
    },
    payloadPreview:
      `${PREVIEW_PROSE_PREFIX}${SECRET_KEY}, refresh=${SECRET_TOKEN}, ` +
      `legacy_hash=${SECRET_BCRYPT}, session=${SECRET_JWT}`,
    riskLevel: "high",
    complianceRefs: ["PCI-DSS-12.3.1"],
    requestedByUserId: 7,
    requestedByEmail: "ops@walaplus.com",
    requestedByName: "Ops Engineer",
    threadId: "thr_123",
  });

  const insertCall = captured.find(c =>
    /INSERT INTO ai_pending_actions/i.test(c.sql),
  );
  assert(!!insertCall, "INSERT INTO ai_pending_actions was issued");
  const insertedPayloadJson = String(insertCall!.params[3]);

  assert(
    !insertedPayloadJson.includes(SECRET_KEY),
    "INSERT payload column does not contain the api_key value",
  );
  assert(
    !insertedPayloadJson.includes(SECRET_TOKEN),
    "INSERT payload column does not contain the refresh_token value",
  );
  assert(
    !insertedPayloadJson.includes(SECRET_PASSWORD),
    "INSERT payload column does not contain the nested password value",
  );
  assert(
    insertedPayloadJson.includes(REDACTED_SENTINEL),
    "INSERT payload column contains the redaction sentinel",
  );
  assert(
    insertedPayloadJson.includes("zoho_books") &&
      insertedPayloadJson.includes(SAFE_DESCRIPTION),
    "INSERT payload column preserves non-sensitive fields",
  );

  // -----------------------------------------------------------------------
  // Innocuously-named fields: the key-based deny-list cannot catch these
  // because `note`, `message`, and `config_diff` are not sensitive key names.
  // deepRedactSecretLikeStrings must scrub the credential-shaped substrings
  // from the VALUES of these fields before the row is persisted.
  // -----------------------------------------------------------------------
  assert(
    !insertedPayloadJson.includes(SECRET_KEY),
    "INSERT payload.note does not contain the sk-… credential (value-level redaction)",
  );
  assert(
    !insertedPayloadJson.includes(SECRET_BCRYPT) && !insertedPayloadJson.includes("$2b$12$"),
    "INSERT payload.config_diff does not contain the bcrypt hash (value-level redaction)",
  );

  const returnedNote = (enqueued.payload as any).note as string;
  assert(
    typeof returnedNote === "string" && !returnedNote.includes(SECRET_KEY),
    "Returned PendingAction.payload.note does not expose the raw sk-… credential",
  );
  assert(
    typeof returnedNote === "string" && returnedNote.includes(REDACTED_SENTINEL),
    "Returned PendingAction.payload.note contains the redaction sentinel",
  );

  // -----------------------------------------------------------------------
  // payload_preview is the human-readable TEXT column built by each tool's
  // policy.buildPreview() callback. A careless tool author can interpolate a
  // credential into that string; verify the regex-based string redactor
  // strips secret-shaped substrings before they reach the database.
  // -----------------------------------------------------------------------
  const insertedPreview = String(insertCall!.params[4]);

  assert(
    !insertedPreview.includes(SECRET_KEY),
    "INSERT payload_preview does not contain the sk-… API key",
  );
  assert(
    !insertedPreview.includes(SECRET_TOKEN),
    "INSERT payload_preview does not contain the ghp_… GitHub token",
  );
  assert(
    !insertedPreview.includes(SECRET_BCRYPT) && !insertedPreview.includes("$2b$12$"),
    "INSERT payload_preview does not contain the bcrypt hash",
  );
  assert(
    !insertedPreview.includes(SECRET_JWT),
    "INSERT payload_preview does not contain the JWT",
  );
  assert(
    insertedPreview.includes(REDACTED_SENTINEL),
    "INSERT payload_preview contains the redaction sentinel",
  );
  assert(
    insertedPreview.includes(PREVIEW_PROSE_PREFIX.trim().split(" ")[0]) &&
      insertedPreview.includes("zoho_books"),
    "INSERT payload_preview preserves the surrounding human-readable prose",
  );

  assert(
    enqueued.payload_preview === insertedPreview,
    "Returned PendingAction.payload_preview matches what was persisted",
  );

  const returnedPayload = enqueued.payload as {
    api_key: string;
    refresh_token: string;
    target_integration: string;
    nested: { password: string; username: string };
  };
  assert(
    returnedPayload.api_key === REDACTED_SENTINEL &&
      returnedPayload.refresh_token === REDACTED_SENTINEL &&
      returnedPayload.nested.password === REDACTED_SENTINEL,
    "Returned PendingAction.payload exposes redacted secrets only",
  );
  assert(
    returnedPayload.target_integration === "zoho_books" &&
      returnedPayload.nested.username === "service-account@walaplus.com",
    "Returned PendingAction.payload preserves safe fields",
  );

  const recorded = await recordExecutionResult(enqueued.action_code, {
    success: true,
    entityType: "integration",
    entityId: "zoho_books",
    data: {
      rotated: true,
      new_api_key: "sk-live-FRESHLY_ROTATED_VALUE_98765",
      access_token: "eyJhbGci_freshtoken",
      audit_note: "Rotation completed successfully",
      // Innocuously-named field that still holds a credential value:
      // key-based deny-list is blind to `curl_example`; only value-level
      // regex redaction via deepRedactSecretLikeStrings catches it.
      curl_example: "curl -H 'Authorization: Bearer sk-live-FRESHLY_ROTATED_VALUE_98765' https://api.example.com",
    },
  });

  const updateCall = captured.find(c =>
    /UPDATE ai_pending_actions/i.test(c.sql),
  );
  assert(!!updateCall, "UPDATE ai_pending_actions was issued");
  const executionResultJson = String(updateCall!.params[2]);

  assert(
    !executionResultJson.includes("sk-live-FRESHLY_ROTATED_VALUE_98765"),
    "UPDATE execution_result does not contain the rotated api_key value",
  );
  assert(
    !executionResultJson.includes("eyJhbGci_freshtoken"),
    "UPDATE execution_result does not contain the access_token value",
  );
  assert(
    executionResultJson.includes(REDACTED_SENTINEL),
    "UPDATE execution_result contains the redaction sentinel",
  );
  assert(
    executionResultJson.includes("Rotation completed successfully"),
    "UPDATE execution_result preserves the safe audit_note field",
  );
  assert(
    !executionResultJson.includes("sk-live-FRESHLY_ROTATED_VALUE_98765"),
    "UPDATE execution_result does not contain the sk-… key inside curl_example (value-level redaction)",
  );

  const parsedExecResult = recorded?.execution_result as
    | { data?: { new_api_key?: string; access_token?: string } }
    | null
    | undefined;
  assert(
    parsedExecResult?.data?.new_api_key === REDACTED_SENTINEL &&
      parsedExecResult?.data?.access_token === REDACTED_SENTINEL,
    "Returned execution_result.data exposes redacted secrets only",
  );

  // -----------------------------------------------------------------------
  // Credential-shaped strings inside non-sensitive payload leaves
  //
  // This is the scenario fixed by swapping redactSensitiveFields() for
  // redactSensitiveDeep() in enqueuePendingAction():
  //   - The payload field name ("notes") is NOT on the key deny-list, so
  //     redactSensitiveFields() would have left its value untouched.
  //   - redactSensitiveDeep() applies the regex deny-list to every string
  //     leaf, catching credential-shaped substrings regardless of key name.
  // -----------------------------------------------------------------------
  console.log("\n[aiApprovalDatabase] credential-shaped strings in non-sensitive payload leaves");

  const capturedLengthBefore = captured.length;

  const INLINE_GHP = "ghp_InlineSecretInsideNoteField1234567890abc";
  const INLINE_SK  = "sk-live-InlineSecretInsideNoteField_9876543210";

  await enqueuePendingAction({
    toolId: "update_notes",
    toolLabel: "Update Notes",
    payload: {
      action: "update",
      notes: `Please rotate — old key was ${INLINE_GHP} and fallback was ${INLINE_SK}`,
      metadata: {
        author: "ops@walaplus.com",
        context: `bearer token: Bearer ${INLINE_GHP}`,
      },
    },
    payloadPreview: "Update notes for integration record",
    riskLevel: "low",
    complianceRefs: [],
    requestedByUserId: 1,
    requestedByEmail: "ops@walaplus.com",
    requestedByName: "Ops",
    threadId: null,
  });

  const inlineInsertCall = captured
    .slice(capturedLengthBefore)
    .find(c => /INSERT INTO ai_pending_actions/i.test(c.sql));
  assert(!!inlineInsertCall, "[inline] INSERT INTO ai_pending_actions was issued");

  const inlinePayloadJson = String(inlineInsertCall!.params[3]);

  assert(
    !inlinePayloadJson.includes(INLINE_GHP),
    "[inline] payload does not contain ghp_… token embedded in 'notes' field",
  );
  assert(
    !inlinePayloadJson.includes(INLINE_SK),
    "[inline] payload does not contain sk-… token embedded in 'notes' field",
  );
  assert(
    inlinePayloadJson.includes(REDACTED_SENTINEL),
    "[inline] payload contains the redaction sentinel for embedded credentials",
  );
  assert(
    inlinePayloadJson.includes("ops@walaplus.com") &&
      inlinePayloadJson.includes('"action":"update"'),
    "[inline] payload preserves safe non-credential fields",
  );

  // -----------------------------------------------------------------------
  // Heuristic detection: free-form passwords and high-entropy tokens hidden
  // in non-credential-named fields (Task #463).
  //
  // The key-name deny-list is blind to fields like `assignedTo`,
  // `description`, or `note`, and the regex deny-list is blind to values
  // that lack a vendor prefix (a free-form password reads like prose). The
  // heuristic layer added in this task catches:
  //
  //   - password-strength tokens   (12-80 chars, mix of upper/lower/digit
  //                                 + a "strong" special char)
  //   - high-entropy tokens        (24-80 chars, base64-ish alphabet,
  //                                 >= 3 char classes, Shannon H >= 4.0)
  //
  // before they reach the JSONB payload column or the payload_preview text.
  // -----------------------------------------------------------------------
  console.log("\n[aiApprovalDatabase] heuristic detection of free-form passwords / high-entropy tokens");

  captured.length = 0;
  const FREE_FORM_PASSWORD = "P@ssw0rd!_FreeFormInProse_X1";       // password-strength heuristic
  const ENTROPY_TOKEN      = "aB3xKp9zQrLm4vN2YwSdEfXyZTw";        // 28-char base64-ish
  const SLUG_SAFE          = "Test-Project-2026-Final-v3";          // must NOT be redacted
  const UUID_SAFE          = "123e4567-e89b-12d3-a456-426614174000"; // must NOT be redacted

  await enqueuePendingAction({
    toolId: "assign_task",
    toolLabel: "Assign Task",
    payload: {
      action: "assign",
      // Innocuous field names — neither key-deny-list nor vendor-regex
      // can catch the credential value buried inside.
      assignedTo: FREE_FORM_PASSWORD,
      description: `Initial credential is ${FREE_FORM_PASSWORD}, please rotate.`,
      note: `Old session token: ${ENTROPY_TOKEN}`,
      // Safe values that must survive to prove the heuristic is conservative.
      project_slug: SLUG_SAFE,
      correlation_id: UUID_SAFE,
      assignee_email: "alice@example.com",
    },
    payloadPreview:
      `Assign task to user — credential ${FREE_FORM_PASSWORD}, ` +
      `session ${ENTROPY_TOKEN} (project ${SLUG_SAFE}, ref ${UUID_SAFE})`,
    riskLevel: "medium",
    complianceRefs: [],
    requestedByUserId: 1,
    requestedByEmail: "ops@walaplus.com",
    requestedByName: "Ops",
    threadId: null,
  });

  const heuristicInsertCall = captured.find(c =>
    /INSERT INTO ai_pending_actions/i.test(c.sql),
  );
  assert(!!heuristicInsertCall, "[heuristic] INSERT INTO ai_pending_actions was issued");
  const heuristicPayloadJson = String(heuristicInsertCall!.params[3]);
  const heuristicPreview     = String(heuristicInsertCall!.params[4]);

  assert(
    !heuristicPayloadJson.includes(FREE_FORM_PASSWORD),
    "[heuristic] payload.assignedTo does NOT contain the free-form password",
  );
  assert(
    !heuristicPayloadJson.includes(ENTROPY_TOKEN),
    "[heuristic] payload.note does NOT contain the high-entropy session token",
  );
  assert(
    !heuristicPreview.includes(FREE_FORM_PASSWORD),
    "[heuristic] payload_preview does NOT contain the free-form password",
  );
  assert(
    !heuristicPreview.includes(ENTROPY_TOKEN),
    "[heuristic] payload_preview does NOT contain the high-entropy session token",
  );
  assert(
    heuristicPayloadJson.includes(REDACTED_SENTINEL),
    "[heuristic] payload contains the redaction sentinel",
  );
  assert(
    heuristicPreview.includes(REDACTED_SENTINEL),
    "[heuristic] payload_preview contains the redaction sentinel",
  );

  // Conservative: slug- and UUID-shaped IDs must NOT be redacted (no false
  // positive). These shapes intentionally fail the heuristic — slug has no
  // strong special char, UUID is hex-only (only 2 char classes).
  assert(
    heuristicPayloadJson.includes(SLUG_SAFE),
    "[heuristic] slug-style identifier is preserved (no false positive)",
  );
  assert(
    heuristicPayloadJson.includes(UUID_SAFE),
    "[heuristic] UUID is preserved (no false positive)",
  );
  assert(
    heuristicPayloadJson.includes("alice@example.com") &&
      heuristicPayloadJson.includes('"action":"assign"'),
    "[heuristic] safe non-credential fields are preserved",
  );

  // -----------------------------------------------------------------------
  // Heuristic regression — edge cases surfaced by the Task #478 report
  //
  // The credential-heuristic-report.ts script scans historical
  // ai_pending_actions / event_logs rows in REPORT-ONLY mode and
  // returns counts of would-have-redacted tokens grouped by field path.
  // Reviewing those buckets surfaces edge cases the original synthetic
  // fixture set (`Test-Project-2026-Final-v3`, `P@ssw0rd!_FreeForm…`,
  // `aB3xKp9zQrLm4vN2YwSdEfXyZTw`) did not cover. Pin them here so a
  // future threshold tweak (entropy floor, length window, strong-special
  // set) cannot silently regress these classifications.
  // -----------------------------------------------------------------------
  console.log("\n[aiApprovalDatabase] heuristic edge cases from credential-heuristic-report.ts");

  captured.length = 0;

  // MUST redact — AWS-secret-style 40-char base64 with `/` separators.
  // No vendor prefix, so the regex layer is blind. Heuristic: high entropy
  // + 3 character classes (U/L/D) → entropy bucket.
  const AWS_SECRET_SHAPE = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

  // MUST NOT redact — SHA-256 hex digest. 64 chars but only two character
  // classes (lowercase + digit), so isHighEntropyToken should reject it
  // (`classes < 3`). This guards the no-false-positive promise for
  // checksums and content hashes that legitimately appear in audit prose.
  const SHA256_HEX_DIGEST =
    "a3f5e9c1d2b4a6e8f0c2d4e6a8b0c2d4e6f8a0b2c4d6e8f0a2b4c6d8e0f2a4b6";

  // MUST NOT redact — ISO 8601 UTC timestamp. Falls inside the 24-80 char
  // entropy window after trim, but the small alphabet keeps Shannon
  // entropy well below the 4.5 bits/char floor.
  const ISO_TIMESTAMP = "2024-12-31T23:59:59.999Z";

  // MUST NOT redact — vendor-prefixed customer ID (e.g. Stripe-style
  // identifier). Only lowercase + digit (2 classes) → fails the
  // entropy heuristic's `classes >= 3` filter even though length is 28.
  const VENDOR_ID = "cust_abc123def456ghi789jkl012";

  // MUST NOT redact — long memorable passphrase. Mixed case + length 27
  // but no digit and no strong special char, so the password-strength
  // heuristic correctly rejects it. Models the "diceware" pattern that
  // a careful operator might paste into a `note` field as documentation.
  const PASSPHRASE_NO_DIGIT = "MyCorrectHorseBatteryStaple";

  await enqueuePendingAction({
    toolId: "rotate_aws_credentials",
    toolLabel: "Rotate AWS Credentials",
    payload: {
      action: "rotate",
      // Innocuously-named field carrying a high-entropy AWS secret value.
      // The regex layer is blind (no AKIA prefix); heuristic must catch it.
      replacement_value: AWS_SECRET_SHAPE,
      // Safe values that exercise the no-false-positive guarantees:
      content_checksum: SHA256_HEX_DIGEST,
      observed_at: ISO_TIMESTAMP,
      external_customer_id: VENDOR_ID,
      operator_note: `Documented procedure: pick a passphrase like ${PASSPHRASE_NO_DIGIT}`,
    },
    payloadPreview:
      `Rotate AWS creds — replacement=${AWS_SECRET_SHAPE}, ` +
      `checksum=${SHA256_HEX_DIGEST}, observed=${ISO_TIMESTAMP}, ` +
      `customer=${VENDOR_ID}, hint=${PASSPHRASE_NO_DIGIT}`,
    riskLevel: "high",
    complianceRefs: [],
    requestedByUserId: 1,
    requestedByEmail: "ops@walaplus.com",
    requestedByName: "Ops",
    threadId: null,
  });

  const edgeInsert = captured.find(c =>
    /INSERT INTO ai_pending_actions/i.test(c.sql),
  );
  assert(!!edgeInsert, "[edge] INSERT INTO ai_pending_actions was issued");

  const edgePayloadJson = String(edgeInsert!.params[3]);
  const edgePreview     = String(edgeInsert!.params[4]);

  // ── Must-redact assertions ────────────────────────────────────────────
  assert(
    !edgePayloadJson.includes(AWS_SECRET_SHAPE),
    "[edge] payload.replacement_value scrubs AWS-style 40-char base64 secret",
  );
  assert(
    !edgePreview.includes(AWS_SECRET_SHAPE),
    "[edge] payload_preview scrubs AWS-style 40-char base64 secret",
  );

  // ── Must-NOT-redact assertions (no-false-positive regressions) ────────
  assert(
    edgePayloadJson.includes(SHA256_HEX_DIGEST),
    "[edge] SHA-256 hex digest survives (no false positive on 64-char hex)",
  );
  assert(
    edgePreview.includes(SHA256_HEX_DIGEST),
    "[edge] SHA-256 hex digest survives in preview text",
  );
  assert(
    edgePayloadJson.includes(ISO_TIMESTAMP),
    "[edge] ISO 8601 timestamp survives (entropy below 4.5 bits/char)",
  );
  assert(
    edgePayloadJson.includes(VENDOR_ID),
    "[edge] Vendor-prefixed customer ID survives (only 2 character classes)",
  );
  assert(
    edgePayloadJson.includes(PASSPHRASE_NO_DIGIT),
    "[edge] Memorable passphrase without digit/special survives",
  );

  // -----------------------------------------------------------------------
  // Regression: result.error is a plain string that may contain credential-
  // shaped text (e.g. a runtime error message that echoes the rotated key).
  // redactSecretLikeStrings must scrub it before the row is persisted
  // (Task #102 — added after code-review identified the gap).
  // -----------------------------------------------------------------------
  console.log("\n[aiApprovalDatabase] credential-shaped strings inside execution_result.error");

  captured.length = 0; // reset captures for clean assertion
  const ERROR_SECRET = "sk-live-LEAKED_VIA_ERROR_STRING_12345678";
  const ERROR_JWT =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0NDQ0NDQifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  await recordExecutionResult(enqueued.action_code, {
    success: false,
    error: `Upstream API rejected the key ${ERROR_SECRET}; auth header was Bearer ${ERROR_JWT}`,
  });

  const errorUpdateCall = captured.find(c =>
    /UPDATE ai_pending_actions/i.test(c.sql),
  );
  assert(!!errorUpdateCall, "UPDATE ai_pending_actions issued for failed execution");
  const errorExecJson = String(errorUpdateCall!.params[2]);

  assert(
    !errorExecJson.includes(ERROR_SECRET),
    "execution_result.error does not contain the sk-… credential leaked via error string",
  );
  assert(
    !errorExecJson.includes(ERROR_JWT),
    "execution_result.error does not contain the JWT leaked via error string",
  );
  assert(
    errorExecJson.includes(REDACTED_SENTINEL),
    "execution_result.error contains the redaction sentinel",
  );

  const parsedErrorResult = JSON.parse(errorExecJson) as { error?: string };
  assert(
    typeof parsedErrorResult.error === "string" &&
      !parsedErrorResult.error.includes(ERROR_SECRET) &&
      parsedErrorResult.error.includes(REDACTED_SENTINEL),
    "Parsed execution_result.error field is scrubbed",
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

run()
  .catch(err => {
    console.error("Unexpected error:", err);
    process.exit(1);
  })
  .finally(() => {
    void aiApprovalPool.end().catch(() => {
      /* mocked pool — ignore */
    });
  });
