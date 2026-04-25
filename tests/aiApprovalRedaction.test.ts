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
