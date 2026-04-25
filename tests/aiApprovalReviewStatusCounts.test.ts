/**
 * Task #513 — review-status counts SQL guard.
 *
 * Verifies that `countByReviewStatus()` in `src/utils/aiApprovalDatabase.ts`
 * builds a single COUNT query that
 *   - aggregates BOTH `unreviewed_by_me` and `no_reviewers` in one round trip
 *   - applies the supplied Status / Risk / requester filters to the base WHERE
 *   - binds the reviewer's user_id only inside the `unreviewed_by_me` branch
 *   - throws a clear error when reviewerUserId is omitted (no silent fallback
 *     to "no filter" which would mislead the operator)
 *
 * We stub the pg pool so the test runs without a live database — we only
 * care about the SQL/parameter shape, not the rows returned.
 *
 * Run:  npx tsx tests/aiApprovalReviewStatusCounts.test.ts
 */

import type { QueryResult, QueryResultRow } from "pg";
import {
  aiApprovalPool,
  countByReviewStatus,
} from "../src/utils/aiApprovalDatabase";

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

type StubQuery = <R extends QueryResultRow>(
  sql: string,
  params?: ReadonlyArray<unknown>,
) => Promise<QueryResult<R>>;

const stubQuery: StubQuery = async <R extends QueryResultRow>(
  sql: string,
  params: ReadonlyArray<unknown> = [],
): Promise<QueryResult<R>> => {
  captured.push({ sql, params });
  // The aggregate query returns one row with both bucket counts as text.
  const rows = [
    { unreviewed_by_me: "0", no_reviewers: "0" },
  ] as unknown as R[];
  return {
    command: "",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
};

aiApprovalPool.query = stubQuery as unknown as typeof aiApprovalPool.query;

async function main(): Promise<void> {
  // -----------------------------------------------------------------
  // Case 1: reviewerUserId required.
  // -----------------------------------------------------------------
  let threw = false;
  try {
    // @ts-expect-error — intentionally omit required arg to assert guard.
    await countByReviewStatus({ status: "pending" });
  } catch (err) {
    threw = err instanceof Error && /reviewerUserId/.test(err.message);
  }
  assert(threw, "throws when reviewerUserId is missing");

  // -----------------------------------------------------------------
  // Case 2: single round-trip aggregating both buckets, with reviewer
  // user_id bound ONLY inside the unreviewed_by_me NOT EXISTS.
  // -----------------------------------------------------------------
  captured.length = 0;
  const result = await countByReviewStatus({
    status: "pending",
    reviewerUserId: 42,
  });
  assert(captured.length === 1, "issues exactly one SQL query (single round-trip)");
  const q = captured[0];
  assert(
    /COUNT\(\*\)\s+FILTER\s*\(\s*WHERE\s+NOT\s+EXISTS/i.test(q.sql),
    "uses COUNT(*) FILTER (WHERE NOT EXISTS ...) for both buckets",
  );
  assert(
    /AS\s+unreviewed_by_me/i.test(q.sql) && /AS\s+no_reviewers/i.test(q.sql),
    "selects both unreviewed_by_me and no_reviewers columns",
  );
  // Ensure both NOT EXISTS clauses target event_logs view-audit rows.
  const notExistsBlocks = q.sql.match(/NOT\s+EXISTS\s*\([\s\S]*?\)/gi) || [];
  assert(notExistsBlocks.length === 2, "emits two NOT EXISTS sub-queries");
  assert(
    notExistsBlocks.every((b) => /event_logs/i.test(b)),
    "both NOT EXISTS sub-queries reference event_logs",
  );
  assert(
    notExistsBlocks.every((b) =>
      /correlation_id\s*=\s*ai_pending_actions\.action_code/i.test(b),
    ),
    "both NOT EXISTS sub-queries correlate on action_code",
  );
  assert(
    notExistsBlocks.every((b) => /description\s+ILIKE\s+'Viewed%'/i.test(b)),
    "both NOT EXISTS sub-queries filter description ILIKE 'Viewed%'",
  );
  // Exactly one of the two NOT EXISTS blocks must bind the viewer user_id.
  const userIdBindBlocks = notExistsBlocks.filter((b) =>
    /el\.user_id\s*=\s*\$\d+/i.test(b),
  );
  assert(
    userIdBindBlocks.length === 1,
    "only the unreviewed_by_me branch binds a viewer user_id parameter",
  );
  assert(
    q.params.includes(42),
    "passes reviewerUserId=42 as a query parameter",
  );
  assert(
    typeof result.unreviewed_by_me === "number" &&
      typeof result.no_reviewers === "number",
    "returns numeric counts for both buckets",
  );

  // -----------------------------------------------------------------
  // Case 3: optional Status / Risk / requester filters are applied to
  // the base WHERE so the counts agree with the visible list.
  // -----------------------------------------------------------------
  captured.length = 0;
  await countByReviewStatus({
    status: "pending",
    riskLevel: "high",
    requestedByUserId: 7,
    reviewerUserId: 42,
  });
  const q3 = captured[0];
  assert(
    /\bstatus\s*=\s*ANY\(/i.test(q3.sql),
    "applies status filter to base WHERE",
  );
  assert(
    /\brequested_by_user_id\s*=\s*\$\d+/i.test(q3.sql),
    "applies requested_by_user_id filter (Only-my-proposals) to base WHERE",
  );
  assert(
    /\brisk_level\s*=\s*\$\d+/i.test(q3.sql),
    "applies risk_level filter to base WHERE",
  );
  assert(q3.params.includes(7), "binds requestedByUserId=7");
  assert(q3.params.includes("high"), "binds riskLevel='high'");
  assert(q3.params.includes(42), "still binds reviewerUserId=42");

  // -----------------------------------------------------------------
  // Case 4: no Status / Risk / requester filters -> no WHERE clause,
  // but the aggregate COUNT still runs (counts the whole table).
  // -----------------------------------------------------------------
  captured.length = 0;
  await countByReviewStatus({ reviewerUserId: 42 });
  const q4 = captured[0];
  assert(
    !/\bWHERE\b\s+(status|requested_by_user_id|risk_level)/i.test(q4.sql),
    "omits the base WHERE clause when no list filters supplied",
  );
  assert(
    /COUNT\(\*\)\s+FILTER/i.test(q4.sql),
    "still emits the aggregate COUNT (whole-table scope)",
  );

  // Cleanup: stubbed pool — the real .end() is a no-op for our stub but we
  // still call it to mirror the other ai-approval tests' shutdown pattern.
  void aiApprovalPool
    .end()
    .catch(() => {
      /* stubbed pool — ignore */
    });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
