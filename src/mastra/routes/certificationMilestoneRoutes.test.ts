/**
 * Secret-leak integration coverage for the certification action toggle writer.
 *
 * Patches pg.Pool before importing the route, drives the real POST handler,
 * and verifies session-controlled `done_by` data is deeply redacted before it
 * reaches the certification_actions UPDATE params.
 */

import pg, { type PoolClient, type QueryResult, type QueryResultRow } from "pg";

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
  params: unknown[];
}

const captured: CapturedQuery[] = [];

function result(rows: QueryResultRow[] = []): QueryResult<QueryResultRow> {
  return {
    command: "",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}

const mockClientQuery = async (
  source: string | { text?: string },
  params: unknown[] = [],
): Promise<QueryResult<QueryResultRow>> => {
  const sql = String(typeof source === "string" ? source : source?.text ?? "");
  captured.push({ sql, params: Array.isArray(params) ? params : [] });
  const normalized = sql.replace(/\s+/g, " ").trim();

  if (/SELECT action_key, milestone_key, verification_mode, done_at/i.test(normalized)) {
    return result([
      {
        action_key: String(params[0]),
        milestone_key: "MS-SECRET-LEAK-TEST",
        verification_mode: "manual",
        done_at: null,
      },
    ]);
  }

  if (/UPDATE certification_actions/i.test(normalized)) {
    return result([
      {
        action_key: String(params[0]),
        milestone_key: "MS-SECRET-LEAK-TEST",
        sort_order: 1,
        action_text: "Review evidence",
        owner: "GRC",
        verification_mode: "manual",
        evidence_source: null,
        done_at: "2026-09-05T12:00:00",
        done_by: params[2],
        evidence_policy_id: null,
        note: null,
        plan_version: "test",
        source_doc: "test",
      },
    ]);
  }

  if (/FROM certification_actions WHERE milestone_key/i.test(normalized)) {
    return result([
      {
        action_key: "ACT-SECRET-LEAK-TEST",
        milestone_key: "MS-SECRET-LEAK-TEST",
        sort_order: 1,
        action_text: "Review evidence",
        owner: "GRC",
        verification_mode: "manual",
        evidence_source: null,
        done_at: "2026-09-05T12:00:00",
        done_by: params[0],
        evidence_policy_id: null,
        note: null,
        plan_version: "test",
        source_doc: "test",
      },
    ]);
  }

  return result();
};

const mockClient = {
  query: mockClientQuery,
  release: () => {},
} as unknown as PoolClient;

(pg.Pool.prototype as unknown as { query: typeof mockClientQuery }).query =
  mockClientQuery;
(pg.Pool.prototype as unknown as {
  connect: () => Promise<PoolClient>;
}).connect = async () => mockClient;

// Import after the pg prototype patch so sharedPool and RBAC use the mocks.
const { makeCookieForRole } = await import(
  "../../../tests/_helpers/sessionAuth"
);
const { buildHandler, makeContext } = await import(
  "../../../tests/_helpers/fakeContext"
);
const { certificationMilestoneRoutes } = await import(
  "./certificationMilestoneRoutes"
);

const handler = await buildHandler(
  certificationMilestoneRoutes,
  "/api/certification-actions/:action_key/toggle",
  "POST",
);

const REDACTED = "***REDACTED***";
const RAW_SECRETS = {
  password_hash: "$2b$12$secretHashValue",
  mfa_secret: "plain-mfa-value",
  access_token: "plain-access-value",
  refresh_token: "plain-refresh-value",
  api_key: "plain-api-key-value",
};

console.log(
  "\n=== certificationMilestoneRoutes toggle — secret-leak tests ===\n",
);

{
  captured.length = 0;
  const rawDoneBy = JSON.stringify(RAW_SECRETS);
  const response = await handler(
    makeContext({
      method: "POST",
      headers: { Cookie: makeCookieForRole("admin", rawDoneBy) },
      params: { action_key: "ACT-SECRET-LEAK-TEST" },
    }),
  );

  assert(response.status === 200, "secret payload: handler returns 200");
  const update = captured.find(({ sql }) =>
    /UPDATE certification_actions/i.test(sql),
  );
  assert(!!update, "secret payload: certification action UPDATE was issued");

  const paramsJson = JSON.stringify(update?.params ?? []);
  for (const [key, rawValue] of Object.entries(RAW_SECRETS)) {
    assert(
      !paramsJson.includes(rawValue),
      `${key}: raw value is absent from UPDATE params`,
    );
  }
  assert(
    paramsJson.includes(REDACTED),
    "secret payload: REDACTED sentinel is present in UPDATE params",
  );
}

{
  captured.length = 0;
  const cleanEmail = "certification-admin@example.invalid";
  const response = await handler(
    makeContext({
      method: "POST",
      headers: { Cookie: makeCookieForRole("admin", cleanEmail) },
      params: { action_key: "ACT-CLEAN-TEST" },
    }),
  );

  assert(response.status === 200, "clean payload: handler returns 200");
  const update = captured.find(({ sql }) =>
    /UPDATE certification_actions/i.test(sql),
  );
  assert(
    update?.params[2] === cleanEmail,
    "clean payload: ordinary done_by email is preserved",
  );
  assert(
    !JSON.stringify(update?.params ?? []).includes(REDACTED),
    "clean payload: redaction is targeted, not blanket",
  );
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);