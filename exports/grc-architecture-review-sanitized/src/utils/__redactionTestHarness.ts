/**
 * Shared helpers for the *Database.test.ts secret-leak gates introduced in
 * Task #459. Each gate mocks `pg.Pool.prototype.query`, drives every public
 * write function with a payload containing the five required deny-list keys
 * (password_hash, mfa_secret, access_token, refresh_token, api_key), then
 * asserts the raw values never reach the SQL params vector and that the
 * `***REDACTED***` sentinel does. A non-sensitive marker round-trips so we
 * also prove the writer hasn't simply dropped the entire payload.
 *
 * Filename starts with "__" so the coverage gate
 * (scripts/check-db-test-coverage.sh) ignores it — it is not itself a writer.
 */

import { Pool, type QueryResult, type QueryResultRow } from "pg";

export const REDACTED_SENTINEL = "***REDACTED***";

export const REQUIRED_DENY_KEYS = [
  "password_hash",
  "mfa_secret",
  "access_token",
  "refresh_token",
  "api_key",
] as const;
export type DenyKey = (typeof REQUIRED_DENY_KEYS)[number];

export const SECRETS: Record<DenyKey, string> = {
  password_hash: "$2b$12$abcdefghij1234567890uvwxyz.ABCDEFGH_IJ",
  mfa_secret: "JBSWY3DPEHPK3PXP",
  access_token: "<REDACTED_SECRET>",
  refresh_token: "<REDACTED_SECRET>",
  api_key: "<REDACTED_SECRET>",
};

export const NON_SENSITIVE_MARKER = "non-secret marker NSF-XYZ";

export interface CapturedQuery {
  sql: string;
  params: unknown[];
}

export interface Harness {
  captured: CapturedQuery[];
  reset(): void;
  passed: () => number;
  failed: () => number;
  assert(cond: boolean, label: string): void;
  assertWriteRedacted(label: string, secret: string): void;
  finish(suiteName: string): void;
}

type QuerySource = string | { text: string; values?: unknown[] };
type MockedPoolQuery = (
  sql: QuerySource,
  params?: unknown[],
) => Promise<QueryResult<QueryResultRow>>;

let installed = false;
let captured: CapturedQuery[] = [];

function installMock(): void {
  if (installed) return;
  const mockQuery: MockedPoolQuery = (sql, params) => {
    const sqlStr = typeof sql === "string" ? sql : sql.text;
    const paramArr = Array.isArray(params)
      ? params
      : typeof sql !== "string" && Array.isArray(sql.values)
        ? sql.values
        : [];
    captured.push({ sql: sqlStr, params: paramArr });
    return Promise.resolve({
      rows: [
        {
          id: 1,
          public_id: "P-1",
          job_code: "JOB-1",
          name: "stub",
          token: "<REDACTED_SECRET>",
          permissions: [],
          expires_at: null,
        },
      ],
      rowCount: 1,
      command: "",
      oid: 0,
      fields: [],
    });
  };
  (Pool.prototype as unknown as { query: MockedPoolQuery }).query = mockQuery;

  // Some writers acquire a client via `pool.connect()` and run the writes
  // inside a transaction (`client.query("BEGIN"); ...`). The redaction
  // wrapper now follows that path too — so the harness must stand in a fake
  // client whose `query()` lands in the same `captured` buffer used above.
  // We install a stub on Pool.prototype.connect that returns a no-op client
  // delegating into the same mockQuery sink and a no-op release().
  const fakeClient = {
    query: mockQuery,
    release: () => undefined,
  };
  (
    Pool.prototype as unknown as { connect: () => Promise<typeof fakeClient> }
  ).connect = () => Promise.resolve(fakeClient);

  installed = true;
}

function isWriteHead(sql: string): boolean {
  const head = sql.replace(/\s+/g, " ").trim().toUpperCase();
  return (
    head.startsWith("INSERT") ||
    head.startsWith("UPDATE") ||
    head.startsWith("UPSERT") ||
    head.startsWith("WITH ") ||
    head.startsWith("MERGE")
  );
}

/**
 * Returns the concatenated params blob across EVERY captured write since the
 * last reset. A single public writer often emits more than one INSERT (e.g.
 * a parent row + N child rows, or a SELECT/UPDATE pair) and the secret may
 * land in any of them — the gate must hold uniformly across all writes, not
 * just the most recent.
 */
function allWriteParams(): unknown[][] {
  const out: unknown[][] = [];
  for (const c of captured) {
    if (isWriteHead(c.sql)) out.push(c.params);
  }
  return out;
}

function paramsBlob(p: unknown[]): string {
  return p
    .map((x) => (x === null || x === undefined ? "" : typeof x === "string" ? x : safeStringify(x)))
    .join("|");
}

function safeStringify(x: unknown): string {
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

export function createHarness(): Harness {
  installMock();
  let pass = 0;
  let fail = 0;
  return {
    captured,
    reset() {
      captured.length = 0;
    },
    passed: () => pass,
    failed: () => fail,
    assert(cond, label) {
      if (cond) {
        console.log(`  ✓ ${label}`);
        pass++;
      } else {
        console.error(`  ✗ ${label}`);
        fail++;
      }
    },
    assertWriteRedacted(label, secret) {
      const writes = allWriteParams();
      if (writes.length === 0) {
        console.error(`  ✗ ${label}: no INSERT/UPDATE captured`);
        fail++;
        return;
      }
      const blob = writes.map(paramsBlob).join("||");
      const rawAbsent = !blob.includes(secret);
      const sentinelPresent = blob.includes(REDACTED_SENTINEL);
      const markerPresent = blob.includes(NON_SENSITIVE_MARKER);
      if (rawAbsent) {
        console.log(`  ✓ ${label}: raw secret absent`);
        pass++;
      } else {
        console.error(`  ✗ ${label}: raw secret leaked`);
        fail++;
      }
      if (sentinelPresent) {
        console.log(`  ✓ ${label}: REDACTED sentinel present`);
        pass++;
      } else {
        console.error(`  ✗ ${label}: REDACTED sentinel missing`);
        fail++;
      }
      if (markerPresent) {
        console.log(`  ✓ ${label}: non-sensitive field passes through`);
        pass++;
      } else {
        console.error(`  ✗ ${label}: non-sensitive field dropped`);
        fail++;
      }
    },
    finish(suiteName) {
      console.log(
        `\n=== ${suiteName} secret-leak tests: ${pass} passed, ${fail} failed ===\n`,
      );
      if (fail > 0) process.exit(1);
    },
  };
}

/**
 * Build a payload object that stuffs the deny-list secret into every
 * sensitive-looking key plus into nested metadata, AND embeds the marker so
 * we can verify it round-trips.
 */
export function stuffedPayload(secret: string, key: DenyKey): Record<string, unknown> {
  return {
    [key]: secret,
    metadata: { [key]: secret, marker: NON_SENSITIVE_MARKER },
    config: { [key]: secret, marker: NON_SENSITIVE_MARKER },
    payload: { [key]: secret, marker: NON_SENSITIVE_MARKER },
    details: { [key]: secret, marker: NON_SENSITIVE_MARKER },
    description: `${NON_SENSITIVE_MARKER} (carrying ${key})`,
  };
}

/**
 * Run one round per deny-list key. `invoke(secret, key)` should drive a single
 * writer with a payload carrying `secret` under one of the redaction-relevant
 * keys. After the call returns we assert the redaction invariants.
 */
export async function exerciseAllKeys(
  h: Harness,
  label: string,
  invoke: (secret: string, key: DenyKey, payload: Record<string, unknown>) => Promise<unknown>,
): Promise<void> {
  for (const key of REQUIRED_DENY_KEYS) {
    h.reset();
    const secret = SECRETS[key];
    const payload = stuffedPayload(secret, key);
    try {
      await invoke(secret, key, payload);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`    (writer threw for ${key}: ${msg})`);
    }
    h.assertWriteRedacted(`${label}/${key}`, secret);
  }
}
