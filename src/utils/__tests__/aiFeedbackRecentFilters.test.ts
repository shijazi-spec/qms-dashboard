/**
 * CI gate for `getRecentThumbsDown(limit, filters)` — Task #580.
 *
 * Locks down two contracts the AI Operations dashboard depends on:
 *   1. The optional `prompt_version` / `feature_flag` filters are sent to PG
 *      as bound parameters against the JSONB `metadata->>'…'` expressions —
 *      never interpolated into the SQL string. A regression here would let
 *      an admin paste a SQL fragment into the filter input and have it
 *      executed against the feedback table.
 *   2. The query SELECTs the `metadata` column (and now `agent`) so the
 *      dashboard's per-feedback metadata chips have a value to render.
 *      Dropping the column from the projection silently empties the chips.
 *
 * We monkey-patch `pg.Pool.prototype.query` so the test stays hermetic — no
 * DATABASE_URL required and no real PG round-trip — mirroring how the
 * sibling `aiFeedbackMetadata.test.ts` keeps its DB-touching surface mocked.
 *
 * Run:    npx tsx src/utils/__tests__/aiFeedbackRecentFilters.test.ts
 */

import { strict as assert } from "node:assert";
import pg from "pg";

let passed = 0;
let failed = 0;

function check(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

// Capture every (sql, params) pair the helper sends to PG so each case can
// inspect the LAST query (the SELECT — `initAIFeedbackTable()` runs CREATE /
// ALTER first, which we want to skip past).
const calls: { sql: string; params: unknown[] | undefined }[] = [];

const originalQuery = pg.Pool.prototype.query;
(
  pg.Pool.prototype as unknown as { query: (...args: unknown[]) => unknown }
).query = function patchedQuery(this: unknown, ...args: unknown[]) {
  const [sql, params] = args as [string, unknown[] | undefined];
  calls.push({ sql, params });
  // Return shape mimicking `pg`'s `Result<Row>` — the helper only reads
  // `.rows`, so an empty array is enough to walk every code path.
  return Promise.resolve({ rows: [] });
};

async function withCapturedCalls(
  fn: () => Promise<unknown>,
): Promise<{ sql: string; params: unknown[] | undefined }> {
  calls.length = 0;
  await fn();
  // The CREATE TABLE / ALTER TABLE bootstrapping fires once on first call,
  // so use the LAST captured query — the SELECT we actually care about.
  return calls[calls.length - 1];
}

// Import *after* the monkey-patch so the module-level `new Pool(...)` picks
// up the patched prototype.
const { getRecentThumbsDown } = await import("../aiFeedbackDatabase");

// (1) No filters → only the `LIMIT $1` parameter is bound, no extra clauses.
{
  const last = await withCapturedCalls(() => getRecentThumbsDown(20));
  check(
    /WHERE\s+rating\s*=\s*'down'\s+ORDER BY/i.test(last.sql),
    "(1) no filters → SELECT has no extra WHERE clauses",
  );
  check(
    Array.isArray(last.params) &&
      last.params.length === 1 &&
      last.params[0] === 20,
    "(1) no filters → only [limit] is bound",
  );
  check(
    /SELECT[\s\S]+\bmetadata\b/i.test(last.sql),
    "(1) projection includes the metadata column",
  );
  check(
    /SELECT[\s\S]+\bagent\b/i.test(last.sql),
    "(1) projection includes the agent column",
  );
}

// (2) prompt_version filter → JSONB extractor with a bound parameter.
{
  const last = await withCapturedCalls(() =>
    getRecentThumbsDown(20, { promptVersion: "qms@deadbeef" }),
  );
  check(
    /metadata->>'prompt_version'\s*=\s*\$2/i.test(last.sql),
    "(2) prompt_version filter binds metadata->>'prompt_version' to $2",
  );
  check(
    Array.isArray(last.params) &&
      last.params.length === 2 &&
      last.params[1] === "qms@deadbeef",
    "(2) prompt_version filter passes the trimmed value as $2",
  );
}

// (3) feature_flag filter → JSONB extractor against the right key.
{
  const last = await withCapturedCalls(() =>
    getRecentThumbsDown(20, { featureFlag: "new-prompt-A" }),
  );
  check(
    /metadata->>'feature_flag'\s*=\s*\$2/i.test(last.sql),
    "(3) feature_flag filter binds metadata->>'feature_flag' to $2",
  );
  check(
    Array.isArray(last.params) &&
      last.params.length === 2 &&
      last.params[1] === "new-prompt-A",
    "(3) feature_flag filter passes the trimmed value as $2",
  );
}

// (4) Both filters → both JSONB extractors AND-ed together with ascending
// $-numbered binds. Locks down the order so the dashboard doesn't quietly
// regress to "filters sometimes flip" if the helper is refactored.
{
  const last = await withCapturedCalls(() =>
    getRecentThumbsDown(50, {
      promptVersion: "qms@cafef00d",
      featureFlag: "treatment-1",
    }),
  );
  check(
    /metadata->>'prompt_version'\s*=\s*\$2[\s\S]+AND[\s\S]+metadata->>'feature_flag'\s*=\s*\$3/i.test(
      last.sql,
    ),
    "(4) both filters AND-ed together as $2 / $3",
  );
  check(
    Array.isArray(last.params) &&
      last.params.length === 3 &&
      last.params[0] === 50 &&
      last.params[1] === "qms@cafef00d" &&
      last.params[2] === "treatment-1",
    "(4) both filters bind [limit, promptVersion, featureFlag] in order",
  );
}

// (5) Whitespace-only / empty / null filter values are treated as "no filter"
// so the dashboard can blindly forward the input box value without trimming.
{
  const last = await withCapturedCalls(() =>
    getRecentThumbsDown(20, {
      promptVersion: "   ",
      featureFlag: "",
    }),
  );
  // The SELECT clause always projects `metadata->>'prompt_version'` /
  // `metadata->>'rating_source'` / `metadata->>'client_surface'` for the
  // Task #661 triage badges, so we can't assert "no `metadata->>` anywhere".
  // Instead, assert the WHERE clause doesn't have a `metadata->>… = $N`
  // filter expression (which is what the prompt_version / feature_flag
  // filters add when active).
  check(
    !/metadata->>'[^']+'\s*=\s*\$/i.test(last.sql),
    "(5) whitespace-only / empty filter strings drop out of the WHERE clause",
  );
  check(
    Array.isArray(last.params) && last.params.length === 1,
    "(5) whitespace-only / empty filter strings keep the bind list at [limit]",
  );
}

// (6) Filter values are length-capped at 200 chars so a paste of a multi-MB
// string into the dashboard input cannot send a pathological parameter to
// PG. Mirrors the cap used elsewhere in this file (e.g. agent in
// `getFeedbackTrend`).
{
  const huge = "a".repeat(5000);
  const last = await withCapturedCalls(() =>
    getRecentThumbsDown(20, { promptVersion: huge }),
  );
  const bound = (last.params as unknown[])[1];
  check(
    typeof bound === "string" && bound.length === 200,
    "(6) filter values are length-capped at 200 chars",
  );
}

// (7) Filter values are quoted so a SQL fragment can never inject. We assert
// the literal string never appears verbatim in the SQL — only as a $-bind.
{
  const malicious = "x' OR 1=1 --";
  const last = await withCapturedCalls(() =>
    getRecentThumbsDown(20, { featureFlag: malicious }),
  );
  check(
    !last.sql.includes(malicious),
    "(7) filter values never get interpolated into the SQL string (SQLi-safe)",
  );
  check(
    Array.isArray(last.params) && last.params.includes(malicious),
    "(7) filter values are bound as parameters",
  );
}

// Restore so we don't poison other tests in the same process.
(pg.Pool.prototype as unknown as { query: typeof originalQuery }).query =
  originalQuery;

console.log(`\n  Passed: ${passed}   Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
