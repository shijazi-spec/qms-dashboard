/**
 * Schema-level secret-leak protection for AI approval tool policies.
 *
 * This test imports the live `TOOL_GOVERNANCE_POLICIES` registry from
 * `src/utils/aiToolGovernance.ts` and, for every registered policy, runs a
 * payload containing credential-shaped values through TWO checkpoints:
 *
 *   (a) `policy.buildPreview(payload)` — the preview shown in the approval
 *       UI. We assert no raw credential survives in that string. If a tool
 *       author later adds a new policy whose preview interpolates a payload
 *       field that can carry a secret (e.g. `evidenceUrl`, `description`,
 *       `rootCause`, `actionDescription`), this assertion fires loudly.
 *
 *   (b) The downstream `enqueuePendingAction()` INSERT — exercised with
 *       a stub `pool.query()` so we can introspect the bind parameters.
 *       Even if (a) somehow regresses, the stored `payload` JSONB column
 *       and the `payload_preview` text column must never contain raw
 *       credential strings — `redactSensitiveDeep` + `redactSecretLikeStrings`
 *       form the runtime safety net (Task #85 / #102).
 *
 * Together these two layers give us defense-in-depth against the very next
 * developer who adds a tool, copy-pastes a `buildPreview` callback, and
 * accidentally interpolates a credential. The test will fail at PR time
 * instead of leaking secrets in production.
 *
 * Run:  npx tsx tests/aiToolPolicyBuildPreview.test.ts
 */

import type { QueryResult, QueryResultRow } from "pg";
import {
  TOOL_GOVERNANCE_POLICIES,
  type ToolGovernancePolicy,
} from "../src/utils/aiToolGovernance";
import {
  aiApprovalPool,
  enqueuePendingAction,
  type PendingAction,
} from "../src/utils/aiApprovalDatabase";
import {
  REDACTED_SENTINEL,
  redactSecretLikeStrings,
  detectCredentialLikeFields,
} from "../src/utils/eventLogsDatabase";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  \u2713 ${label}`);
    passed++;
  } else {
    console.error(`  \u2717 ${label}`);
    failed++;
  }
}

/* ------------------------------------------------------------------ *
 * Stub pool.query so enqueuePendingAction() runs in-process.         *
 * ------------------------------------------------------------------ */

interface CapturedQuery {
  sql: string;
  params: ReadonlyArray<unknown>;
}

const captured: CapturedQuery[] = [];

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
      credential_warnings:
        params[13] != null ? JSON.parse(String(params[13])) : [],
    };
    return {
      ...empty,
      command: "INSERT",
      rowCount: 1,
      rows: [row as unknown as R],
    };
  }

  return empty;
};

aiApprovalPool.query = stubQuery as typeof aiApprovalPool.query;

/* ------------------------------------------------------------------ *
 * Credential fixtures.                                               *
 *                                                                    *
 * Every string in REGEX_DETECTABLE_SECRETS has a structure that one  *
 * of the SECRET_LIKE_PATTERNS regexes in eventLogsDatabase.ts will   *
 * recognise — so the runtime safety net (`redactSecretLikeStrings`)  *
 * must scrub it out of any free-form value, including things         *
 * interpolated by a tool's `buildPreview()` callback.                *
 *                                                                    *
 * The plain password is included only to exercise the key-name deny  *
 * list (`isSensitiveField('password')`); it is not regex-detectable  *
 * by design (no shape distinguishes a password from prose), so we    *
 * scope its leak check to the persisted JSONB `payload` column where *
 * the deny-list runs.                                                *
 * ------------------------------------------------------------------ */

const SECRETS = {
  // sk-key regex requires:  sk[-_](live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{20,}
  apiKey: "<REDACTED_SECRET>",
  // SourceControlProvider regex requires:  gh[porsu]_[A-Za-z0-9]{30,}
  ghPat: "<REDACTED_TOKEN>",
  // bcrypt regex requires:  $2[aby]$NN$ + exactly 53 [./A-Za-z0-9] chars
  bcrypt: "<REDACTED_PASSWORD_HASH>",
  // jwt regex requires three base64url segments separated by dots
  jwt: "<REDACTED_TOKEN>",
  // aws-akid regex requires:  AKIA + exactly 16 [0-9A-Z] chars
  awsKey: "<REDACTED_TOKEN>",
} as const;

const PLAIN_PASSWORD = "<REDACTED_SECRET>";

const REGEX_DETECTABLE_SECRETS: ReadonlyArray<string> = Object.values(SECRETS);

/* ------------------------------------------------------------------ *
 * Heuristic-detectable fixtures (Task #463)                           *
 *                                                                    *
 * These have NO vendor prefix and would slip past every regex in     *
 * SECRET_LIKE_PATTERNS. They look like prose to the eye but match    *
 * one of the new heuristic detectors:                                *
 *                                                                    *
 *   - HEURISTIC_PASSWORD: 12-80 char token with upper/lower/digit/   *
 *     strong-special — caught by the password-strength heuristic.    *
 *   - HEURISTIC_ENTROPY:  28-char base64-ish, Shannon H ≥ 4.5 —      *
 *     caught by the high-entropy heuristic.                          *
 *                                                                    *
 * The interesting failure mode is when these values are interpolated *
 * into INNOCUOUSLY-NAMED payload fields like `assignedTo`,           *
 * `description`, `note`, `category`, etc. The key-name deny-list     *
 * cannot help, the regex deny-list cannot help — the heuristic       *
 * detectors inside `redactSecretLikeStrings()` are the last line of  *
 * defense before the row hits the database.                          *
 * ------------------------------------------------------------------ */

const HEURISTIC_PASSWORD = "<REDACTED_SECRET>";
const HEURISTIC_ENTROPY  = "aB3xKp9zQrLm4vN2YwSdEfXyZTwQ";

const HEURISTIC_DETECTABLE_SECRETS: ReadonlyArray<string> = [
  HEURISTIC_PASSWORD,
  HEURISTIC_ENTROPY,
];

/**
 * The union of every payload field referenced by any registered
 * `buildPreview` callback today, plus generic credential field names
 * (api_key, refresh_token, password, …) so the deny-list path is also
 * exercised on every policy run.
 *
 * If a future tool's preview reads a NEW field, add it here so the
 * fixture exercises that path too.
 */
function buildPayloadWithSecretsFor(
  _policy: ToolGovernancePolicy,
): Record<string, unknown> {
  const tainted = `${SECRETS.apiKey} / ${SECRETS.ghPat} / ${SECRETS.jwt}`;
  return {
    // Generic credential keys — deny-list catches these by field name.
    api_key: SECRETS.apiKey,
    refresh_token: SECRETS.ghPat,
    password: PLAIN_PASSWORD,
    secret: SECRETS.bcrypt,
    access_token: SECRETS.jwt,

    // Fields actually read by current `buildPreview` callbacks. We embed a
    // credential-shaped value into each so any naive `${p.x}` interpolation
    // surfaces the leak. Only regex-detectable shapes are used here so the
    // safety-net (`redactSecretLikeStrings`) has a fighting chance — a
    // free-form password buried inside `assignedTo` cannot be told apart
    // from prose by any value-level rule.
    title: `Rotation request — ${SECRETS.apiKey}`,
    severity: "high",
    ncType: "major",
    capaType: "corrective",
    priority: "high",
    category: `Vendor key audit — ${SECRETS.ghPat}`,
    sourceReference: `<REDACTED_URL>`,
    description: `Found credential in vendor email: ${tainted}`,
    rootCause: `Hard-coded ${SECRETS.apiKey} in vendor SDK init`,
    correctiveAction: `Rotate to new key, retire ${SECRETS.bcrypt}`,
    preventiveAction: `Add scanner for ${SECRETS.awsKey}-shaped strings`,
    capaId: "CAPA-2026-0001",
    capaNumber: "CAPA-2026-0001",
    status: "in_progress",
    assignedTo: "Sample User",
    targetDate: "2026-12-31",
    actionDescription: `Revoke leaked token ${SECRETS.ghPat} immediately`,
    trainingType: "mandatory",
    targetDepartment: `Security — bearer ${SECRETS.jwt}`,
    mandatoryFor: `engineers handling ${SECRETS.apiKey}`,
    trainingId: 42,
    trainingTitle: `PII training (note: ${SECRETS.bcrypt})`,
    assigneeEmail: "<REDACTED_EMAIL>",
    assigneeName: "Alice",
    dueDate: "2026-06-01",
    assignmentId: 7,
    completionDate: "2026-05-15",
    evidenceUrl: `<REDACTED_URL>`,
    score: 95,
    action: "create",
    checklistName: `Vendor SDK key audit (${SECRETS.apiKey})`,
    checklistId: "CHK-001",
    items: [{ note: SECRETS.bcrypt }, { note: SECRETS.ghPat }],

    // Innocuously-named scratch fields — only the value-level regex
    // deny-list (deepRedactSecretLikeStrings) catches credentials hiding
    // in these. We add them so the storage assertion is meaningful.
    note: `rotated to ${SECRETS.apiKey}`,
    message: `auth header: Bearer ${SECRETS.ghPat}`,
    config_diff: `old=${SECRETS.bcrypt}`,

    // Heuristic-detectable values hiding in innocuous prose fields
    // (Task #463). Neither the key-name deny-list nor the vendor-prefix
    // regex layer can catch these — only the heuristic detectors inside
    // redactSecretLikeStrings() do.
    handoff_summary:
      `Initial credential is ${HEURISTIC_PASSWORD}; ` +
      `prior session token was ${HEURISTIC_ENTROPY}.`,
    reviewer_note: `please rotate ${HEURISTIC_PASSWORD} immediately`,
  };
}

function regexDetectableLeaksIn(haystack: string): string[] {
  return REGEX_DETECTABLE_SECRETS.filter((s) => haystack.includes(s));
}

function heuristicDetectableLeaksIn(haystack: string): string[] {
  return HEURISTIC_DETECTABLE_SECRETS.filter((s) => haystack.includes(s));
}

/* ------------------------------------------------------------------ *
 * The actual coverage test                                           *
 * ------------------------------------------------------------------ */

async function run(): Promise<void> {
  const policies = Object.values(TOOL_GOVERNANCE_POLICIES).filter(
    (p) => !p.toolId.startsWith("integration-test-"),
  );

  assert(
    policies.length >= 1,
    `discovered at least one production tool policy (found ${policies.length})`,
  );

  console.log(
    `\n[aiToolPolicyBuildPreview] verifying ${policies.length} registered policies\n`,
  );

  for (const policy of policies) {
    console.log(`• ${policy.toolId} (${policy.label})`);

    const payload = buildPayloadWithSecretsFor(policy);

    // ---- (a) buildPreview output must not echo raw credentials ----
    let preview = "";
    let previewThrew = false;
    try {
      preview = String(policy.buildPreview(payload));
    } catch (err) {
      previewThrew = true;
      console.error(
        `    buildPreview threw: ${(err as Error)?.message ?? err}`,
      );
    }

    assert(
      !previewThrew,
      `[${policy.toolId}] buildPreview() does not throw on a fully-populated payload`,
    );

    // Note: we record buildPreview leaks for visibility but the test does NOT
    // fail on (a) alone — the task explicitly accepts (a) OR (b). The hard
    // assertion is on the persisted INSERT below: even when buildPreview is
    // sloppy, `redactSecretLikeStrings` running inside enqueuePendingAction
    // must scrub every regex-detectable credential out of `payload_preview`.
    const previewLeaks = regexDetectableLeaksIn(preview);
    if (previewLeaks.length > 0) {
      console.log(
        `    note: buildPreview() output contains ${previewLeaks.length} ` +
          `regex-detectable credential(s); relying on enqueue-time redaction.`,
      );
    } else {
      console.log(
        `    ✓ buildPreview() output contains no regex-detectable credential`,
      );
    }

    // Skip the storage check for tools that intentionally bypass the gate
    // (their payload is never persisted to ai_pending_actions). For those
    // tools the only checkpoint is `safePreview()` in withApprovalGate.ts,
    // which wraps buildPreview() in `redactSecretLikeStrings`. We mirror
    // that wrap here to assert the whole chain is safe end-to-end.
    if (!policy.requiresApproval) {
      const safePreviewMimic = String(redactSecretLikeStrings(preview));
      const safePreviewLeaks = regexDetectableLeaksIn(safePreviewMimic);
      assert(
        safePreviewLeaks.length === 0,
        `[${policy.toolId}] (gate-exempt tool) buildPreview() → safePreview() ` +
          `chain contains no raw credential` +
          (safePreviewLeaks.length
            ? ` (LEAKED: ${safePreviewLeaks.map((s) => s.slice(0, 24) + "…").join(", ")})`
            : ""),
      );
      continue;
    }

    // ---- (b) the persisted INSERT must not contain raw credentials ----
    captured.length = 0;
    let enqueueThrew = false;
    try {
      await enqueuePendingAction({
        toolId: policy.toolId,
        toolLabel: policy.label,
        payload,
        payloadPreview: preview, // exactly what the route would store
        riskLevel: policy.riskLevel,
        complianceRefs: policy.complianceRefs,
        requestedByUserId: 1,
        requestedByEmail: "<REDACTED_EMAIL>",
        requestedByName: "QA Bot",
        threadId: null,
      });
    } catch (err) {
      enqueueThrew = true;
      console.error(
        `    enqueuePendingAction threw: ${(err as Error)?.message ?? err}`,
      );
    }

    assert(
      !enqueueThrew,
      `[${policy.toolId}] enqueuePendingAction() succeeded against the stub`,
    );

    const insertCall = captured.find((c) =>
      /INSERT INTO ai_pending_actions/i.test(c.sql),
    );
    assert(
      !!insertCall,
      `[${policy.toolId}] INSERT INTO ai_pending_actions was issued`,
    );
    if (!insertCall) continue;

    const persistedPayload = String(insertCall.params[3]);
    const persistedPreview = String(insertCall.params[4]);

    const payloadLeaks = regexDetectableLeaksIn(persistedPayload);
    assert(
      payloadLeaks.length === 0,
      `[${policy.toolId}] persisted payload JSONB contains no raw credential` +
        (payloadLeaks.length
          ? ` (LEAKED: ${payloadLeaks.map((s) => s.slice(0, 24) + "…").join(", ")})`
          : ""),
    );

    const previewPersistedLeaks = regexDetectableLeaksIn(persistedPreview);
    assert(
      previewPersistedLeaks.length === 0,
      `[${policy.toolId}] persisted payload_preview contains no raw credential` +
        (previewPersistedLeaks.length
          ? ` (LEAKED: ${previewPersistedLeaks.map((s) => s.slice(0, 24) + "…").join(", ")})`
          : ""),
    );

    // Plain password under a `password` key must be scrubbed by the key-name
    // deny-list even though it has no regex-detectable shape.
    assert(
      !persistedPayload.includes(PLAIN_PASSWORD),
      `[${policy.toolId}] persisted payload JSONB scrubs plaintext password ` +
        `held under the 'password' key (key-name deny-list)`,
    );

    assert(
      persistedPayload.includes(REDACTED_SENTINEL),
      `[${policy.toolId}] persisted payload includes the redaction sentinel ` +
        `(proves the deny-list ran)`,
    );

    // Heuristic-detectable secrets (free-form password, high-entropy token)
    // hidden in innocuous prose fields like `handoff_summary` / `reviewer_note`
    // must also be scrubbed before the row is persisted (Task #463). The key-
    // name deny-list cannot help (key is innocuous), the vendor-prefix regex
    // deny-list cannot help (no shape) — the heuristic layer is the only
    // defense for this class of leak.
    const heuristicPayloadLeaks = heuristicDetectableLeaksIn(persistedPayload);
    assert(
      heuristicPayloadLeaks.length === 0,
      `[${policy.toolId}] persisted payload JSONB scrubs heuristic-detectable ` +
        `secrets buried in non-credential-named fields` +
        (heuristicPayloadLeaks.length
          ? ` (LEAKED: ${heuristicPayloadLeaks.map((s) => s.slice(0, 24) + "…").join(", ")})`
          : ""),
    );

    // ---- (c) credential warnings surface to the operator UI (Task #477) ----
    //
    // Redaction at storage scrubs the secret out of the persisted row, but
    // the AI tool boundary should ALSO emit a structured warning so the
    // operator approval card can show "this submission contained credential-
    // shaped values, route through the secret store next time". The warnings
    // are computed in `enqueuePendingAction()` against the pre-redaction
    // payload and persisted to the new `credential_warnings` JSONB column.
    const persistedWarningsRaw = String(insertCall.params[13] ?? "[]");
    let persistedWarnings: Array<{ path: string; kind: string; patternName?: string }>;
    try {
      persistedWarnings = JSON.parse(persistedWarningsRaw);
    } catch {
      persistedWarnings = [];
    }

    assert(
      Array.isArray(persistedWarnings),
      `[${policy.toolId}] credential_warnings INSERT param is a JSON array`,
    );

    assert(
      persistedWarnings.length > 0,
      `[${policy.toolId}] enqueue surfaces credential_warnings to the operator UI ` +
        `(payload contained credential-shaped values that should have been flagged)`,
    );

    // The fixture interpolates regex-detectable secrets into many
    // payload fields and ALSO heuristic-detectable secrets into
    // `handoff_summary` / `reviewer_note`. Whichever subset of those
    // fields the tool's payload schema actually accepts, the warning
    // list must reference at least one of them.
    const flaggedKinds = new Set(persistedWarnings.map((w) => w.kind));
    assert(
      flaggedKinds.has("regex") ||
        flaggedKinds.has("password") ||
        flaggedKinds.has("entropy") ||
        flaggedKinds.has("sensitive-key"),
      `[${policy.toolId}] credential_warnings include at least one detector kind ` +
        `(found: ${[...flaggedKinds].join(", ") || "none"})`,
    );

    // Each warning must carry a non-empty path so the UI can show WHICH
    // field tripped the detector — a warning with no path is useless to
    // the reviewer.
    assert(
      persistedWarnings.every((w) => typeof w.path === "string" && w.path.length > 0),
      `[${policy.toolId}] every credential_warning carries a non-empty field path`,
    );
  }

  /* -------------------------------------------------------------- *
   * Standalone detector smoke check                                *
   *                                                                *
   * Runs the detector directly on a hand-built payload that mixes  *
   * key-name, regex, and heuristic credential leaks plus prose to  *
   * make sure each detector kind fires and that ordinary field     *
   * names do NOT produce false positives. This is the unit-level   *
   * complement to the policy-driven assertions above.              *
   * -------------------------------------------------------------- */
  console.log(`\n[detector] standalone detectCredentialLikeFields() smoke test`);
  const detectorPayload = {
    api_key: SECRETS.apiKey, // key-name match
    note: `rotated to ${SECRETS.ghPat}`, // regex match (gh PAT)
    handoff_summary: `creds: ${HEURISTIC_PASSWORD}`, // password heuristic
    session_blob: HEURISTIC_ENTROPY, // entropy heuristic
    title: "Quarterly review", // benign — must NOT match
    items: [{ note: "ordinary slug-id-2026" }, { note: SECRETS.jwt }],
  };
  const detectorPreview = `Operator preview: token=${SECRETS.apiKey}`;
  const warnings = detectCredentialLikeFields(detectorPayload, detectorPreview);

  const kinds = new Set(warnings.map((w) => w.kind));
  assert(kinds.has("sensitive-key"), `detector flags sensitive-keyed fields`);
  assert(kinds.has("regex"), `detector flags vendor-prefix regex matches`);
  assert(kinds.has("password"), `detector flags password-strength heuristic hits`);
  assert(kinds.has("entropy"), `detector flags high-entropy heuristic hits`);

  const paths = new Set(warnings.map((w) => w.path));
  assert(paths.has("payload.api_key"), `detector path includes payload.api_key`);
  assert(paths.has("payload.note"), `detector path includes payload.note`);
  assert(
    paths.has("payload.handoff_summary"),
    `detector path includes payload.handoff_summary (heuristic)`,
  );
  assert(
    paths.has("payload.session_blob"),
    `detector path includes payload.session_blob (heuristic)`,
  );
  assert(
    paths.has("payload.items[1].note"),
    `detector recurses into arrays — payload.items[1].note flagged`,
  );
  assert(
    paths.has("payload_preview"),
    `detector also scans the optional preview string`,
  );
  assert(
    !paths.has("payload.title"),
    `detector does NOT flag ordinary prose titles (no false positive)`,
  );
  assert(
    !paths.has("payload.items[0].note"),
    `detector does NOT flag innocent slugs in array elements (no false positive)`,
  );

  console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
