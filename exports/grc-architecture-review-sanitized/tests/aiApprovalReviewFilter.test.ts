/**
 * Task #298 — review-status filter SQL guard.
 *
 * Verifies that `listPendingActions()` in `src/utils/aiApprovalDatabase.ts`
 * builds the right NOT EXISTS sub-query against `event_logs` view-audit rows
 * when the caller passes `reviewFilter`. We stub the pg pool so the test
 * runs without a live database — we only care about the SQL/parameter
 * shape, not the rows returned.
 *
 * Run:  npx tsx tests/aiApprovalReviewFilter.test.ts
 */

import type { QueryResult, QueryResultRow } from "pg";
import {
  aiApprovalPool,
  listPendingActions,
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
  // The COUNT path returns one row with text 'total'; the SELECT * path
  // can return zero rows — listPendingActions only consumes res.rows.
  const isCount = /SELECT COUNT\(\*\)/i.test(sql);
  const rows = isCount
    ? ([{ total: "0" }] as unknown as R[])
    : ([] as R[]);
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
  // Case 1: no reviewFilter → no NOT EXISTS clause should appear.
  // -----------------------------------------------------------------
  captured.length = 0;
  await listPendingActions({ status: "pending" });
  const baseline = captured[1] ?? captured[0]; // SELECT *, after COUNT
  assert(
    !/NOT EXISTS/i.test(baseline.sql),
    "Baseline list query has no NOT EXISTS clause",
  );

  // -----------------------------------------------------------------
  // Case 2: reviewFilter='no_reviewers' → NOT EXISTS with no user_id.
  // -----------------------------------------------------------------
  captured.length = 0;
  await listPendingActions({
    status: "pending",
    reviewFilter: "no_reviewers",
  });
  const noReviewers = captured.find((q) => /SELECT \*/i.test(q.sql));
  assert(!!noReviewers, "no_reviewers branch issued a SELECT * query");
  if (noReviewers) {
    assert(
      /NOT EXISTS\s*\(/i.test(noReviewers.sql),
      "no_reviewers branch emits NOT EXISTS",
    );
    assert(
      /event_logs/i.test(noReviewers.sql),
      "no_reviewers branch references event_logs",
    );
    assert(
      /correlation_id\s*=\s*ai_pending_actions\.action_code/i.test(
        noReviewers.sql,
      ),
      "no_reviewers branch correlates on action_code",
    );
    assert(
      /action_type\s*=\s*'AI_ACTION'/i.test(noReviewers.sql),
      "no_reviewers branch filters action_type='AI_ACTION'",
    );
    assert(
      /description\s+ILIKE\s+'Viewed%'/i.test(noReviewers.sql),
      "no_reviewers branch filters description ILIKE 'Viewed%'",
    );
    assert(
      !/el\.user_id\s*=\s*\$/i.test(noReviewers.sql),
      "no_reviewers branch does NOT bind a viewer user_id",
    );
  }

  // -----------------------------------------------------------------
  // Case 3: reviewFilter='unreviewed_by_me' → NOT EXISTS bound to
  // the reviewer's user_id parameter.
  // -----------------------------------------------------------------
  captured.length = 0;
  await listPendingActions({
    status: "pending",
    reviewFilter: "unreviewed_by_me",
    reviewerUserId: 42,
  });
  const unreviewed = captured.find((q) => /SELECT \*/i.test(q.sql));
  assert(!!unreviewed, "unreviewed_by_me branch issued a SELECT * query");
  if (unreviewed) {
    assert(
      /NOT EXISTS\s*\(/i.test(unreviewed.sql),
      "unreviewed_by_me branch emits NOT EXISTS",
    );
    assert(
      /el\.user_id\s*=\s*\$\d+/i.test(unreviewed.sql),
      "unreviewed_by_me branch binds a positional user_id parameter",
    );
    assert(
      unreviewed.params.includes(42),
      "unreviewed_by_me branch passes reviewerUserId=42 as a query param",
    );
  }

  // -----------------------------------------------------------------
  // Case 4: 'unreviewed_by_me' without reviewerUserId throws — no
  // silent fallback to "no filter" which would mislead the operator.
  // -----------------------------------------------------------------
  let threw = false;
  try {
    await listPendingActions({
      status: "pending",
      reviewFilter: "unreviewed_by_me",
    });
  } catch (err) {
    threw = err instanceof Error && /reviewerUserId/.test(err.message);
  }
  assert(threw, "unreviewed_by_me without reviewerUserId throws a clear error");

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
