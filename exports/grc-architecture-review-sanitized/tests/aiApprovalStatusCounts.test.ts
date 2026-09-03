/**
 * Task #618 — status counts SQL guard.
 *
 * Verifies that `countByStatus()` in `src/utils/aiApprovalDatabase.ts`
 * builds a single COUNT query that
 *   - aggregates ALL FIVE operator-facing status buckets
 *     (pending / executed / rejected / failed / expired) in one
 *     round-trip via COUNT(*) FILTER (WHERE status = '...')
 *   - applies the supplied Risk / requester filters to the base WHERE
 *   - applies the Review filter ('unreviewed_by_me' / 'no_reviewers')
 *     to the base WHERE so the five numbers agree with the visible list
 *   - throws a clear error when reviewFilter='unreviewed_by_me' is set
 *     without a reviewerUserId (no silent drop of the predicate, which
 *     would mislead the operator about what each count means)
 *   - intentionally has NO `status` parameter on its filters object —
 *     the whole point of the helper is to surface every status bucket
 *     regardless of which one the operator has selected, so accepting a
 *     status filter would silently zero four of the five buckets and
 *     defeat the at-a-glance triage the dashboard depends on.
 *
 * We stub the pg pool so the test runs without a live database — we only
 * care about the SQL/parameter shape, not the rows returned.
 *
 * Run:  npx tsx tests/aiApprovalStatusCounts.test.ts
 */

import type { QueryResult, QueryResultRow } from "pg";
import {
  aiApprovalPool,
  countByStatus,
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
  // The aggregate query returns one row with all five bucket counts as text.
  const rows = [
    {
      pending: "0",
      executed: "0",
      rejected: "0",
      failed: "0",
      expired: "0",
    },
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
  // Case 1: single round-trip aggregating all five buckets, no filters.
  // -----------------------------------------------------------------
  captured.length = 0;
  const result = await countByStatus({});
  assert(captured.length === 1, "issues exactly one SQL query (single round-trip)");
  const q = captured[0];
  assert(
    /COUNT\(\*\)\s+FILTER\s*\(\s*WHERE\s+status\s*=\s*'pending'\s*\)/i.test(q.sql),
    "emits COUNT(*) FILTER for status='pending'",
  );
  assert(
    /COUNT\(\*\)\s+FILTER\s*\(\s*WHERE\s+status\s*=\s*'executed'\s*\)/i.test(q.sql),
    "emits COUNT(*) FILTER for status='executed'",
  );
  assert(
    /COUNT\(\*\)\s+FILTER\s*\(\s*WHERE\s+status\s*=\s*'rejected'\s*\)/i.test(q.sql),
    "emits COUNT(*) FILTER for status='rejected'",
  );
  assert(
    /COUNT\(\*\)\s+FILTER\s*\(\s*WHERE\s+status\s*=\s*'failed'\s*\)/i.test(q.sql),
    "emits COUNT(*) FILTER for status='failed'",
  );
  assert(
    /COUNT\(\*\)\s+FILTER\s*\(\s*WHERE\s+status\s*=\s*'expired'\s*\)/i.test(q.sql),
    "emits COUNT(*) FILTER for status='expired'",
  );
  assert(
    /AS\s+pending/i.test(q.sql) &&
      /AS\s+executed/i.test(q.sql) &&
      /AS\s+rejected/i.test(q.sql) &&
      /AS\s+failed/i.test(q.sql) &&
      /AS\s+expired/i.test(q.sql),
    "selects all five bucket aliases",
  );
  assert(
    typeof result.pending === "number" &&
      typeof result.executed === "number" &&
      typeof result.rejected === "number" &&
      typeof result.failed === "number" &&
      typeof result.expired === "number",
    "returns numeric counts for all five buckets",
  );

  // -----------------------------------------------------------------
  // Case 2: optional Risk / requester filters are applied to the
  // base WHERE so the counts agree with the visible list.
  // -----------------------------------------------------------------
  captured.length = 0;
  await countByStatus({
    riskLevel: "high",
    requestedByUserId: 7,
  });
  const q2 = captured[0];
  assert(
    /\brisk_level\s*=\s*\$\d+/i.test(q2.sql),
    "applies risk_level filter to base WHERE",
  );
  assert(q2.params.includes("high"), "binds riskLevel='high'");
  assert(
    /\brequested_by_user_id\s*=\s*\$\d+/i.test(q2.sql),
    "applies requested_by_user_id filter (Only-my-proposals) to base WHERE",
  );
  assert(q2.params.includes(7), "binds requestedByUserId=7");
  // The status enum literals must be hard-coded (closed enum owned
  // by this module), never bound as parameters.
  assert(
    !q2.params.includes("pending") &&
      !q2.params.includes("executed") &&
      !q2.params.includes("rejected") &&
      !q2.params.includes("failed") &&
      !q2.params.includes("expired"),
    "does not bind status enum values as parameters",
  );

  // -----------------------------------------------------------------
  // Case 3: review_filter='no_reviewers' adds a NOT EXISTS against
  // event_logs without binding any reviewer user_id parameter.
  // -----------------------------------------------------------------
  captured.length = 0;
  await countByStatus({
    reviewFilter: "no_reviewers",
  });
  const q3 = captured[0];
  assert(
    /NOT\s+EXISTS\s*\(/i.test(q3.sql) && /event_logs/i.test(q3.sql),
    "no_reviewers branch emits NOT EXISTS against event_logs",
  );
  assert(
    /correlation_id\s*=\s*ai_pending_actions\.action_code/i.test(q3.sql),
    "no_reviewers NOT EXISTS correlates on action_code",
  );
  assert(
    /description\s+ILIKE\s+'Viewed%'/i.test(q3.sql),
    "no_reviewers NOT EXISTS filters description ILIKE 'Viewed%'",
  );
  assert(
    !/el\.user_id\s*=\s*\$\d+/i.test(q3.sql),
    "no_reviewers branch does NOT bind a viewer user_id (true blind spots)",
  );

  // -----------------------------------------------------------------
  // Case 4: review_filter='unreviewed_by_me' adds a NOT EXISTS that
  // binds the supplied reviewer user_id.
  // -----------------------------------------------------------------
  captured.length = 0;
  await countByStatus({
    reviewFilter: "unreviewed_by_me",
    reviewerUserId: 42,
  });
  const q4 = captured[0];
  assert(
    /NOT\s+EXISTS\s*\(/i.test(q4.sql) && /el\.user_id\s*=\s*\$\d+/i.test(q4.sql),
    "unreviewed_by_me branch binds the viewer user_id inside NOT EXISTS",
  );
  assert(q4.params.includes(42), "binds reviewerUserId=42 as a query parameter");

  // -----------------------------------------------------------------
  // Case 5: reviewFilter='unreviewed_by_me' without reviewerUserId is
  // a hard error — silently dropping the predicate would mislead the
  // operator about what each bucket count means.
  // -----------------------------------------------------------------
  let threw = false;
  try {
    await countByStatus({
      reviewFilter: "unreviewed_by_me",
    });
  } catch (err) {
    threw = err instanceof Error && /reviewerUserId/.test(err.message);
  }
  assert(
    threw,
    "throws when unreviewed_by_me is requested without a reviewerUserId",
  );

  // -----------------------------------------------------------------
  // Case 6: when no Review filter is supplied, the SQL must NOT emit
  // any NOT EXISTS / event_logs sub-query (avoid wasted seq scan).
  // -----------------------------------------------------------------
  captured.length = 0;
  await countByStatus({ riskLevel: "low" });
  const q6 = captured[0];
  assert(
    !/NOT\s+EXISTS/i.test(q6.sql),
    "omits NOT EXISTS when no review filter supplied",
  );
  assert(
    !/event_logs/i.test(q6.sql),
    "omits event_logs join when no review filter supplied",
  );

  // -----------------------------------------------------------------
  // Case 7: the helper has NO `status` parameter on its filters object.
  // The whole point of the endpoint is to surface every status bucket
  // regardless of which one the operator has selected on the dropdown.
  // We assert this at the type level (compile time) and at the SQL
  // level: there must be no `status = ANY(...)` predicate on the base
  // WHERE that would silently zero four of the five buckets.
  // -----------------------------------------------------------------
  captured.length = 0;
  await countByStatus({ riskLevel: "critical", requestedByUserId: 9 });
  const q7 = captured[0];
  assert(
    !/\bstatus\s*=\s*ANY\(/i.test(q7.sql),
    "does NOT apply a status=ANY(...) predicate (every bucket must be visible)",
  );
  assert(
    !q7.params.some(
      (p: unknown) =>
        Array.isArray(p) &&
        p.some(
          (s) =>
            s === "pending" ||
            s === "executed" ||
            s === "rejected" ||
            s === "failed" ||
            s === "expired",
        ),
    ),
    "does NOT bind any status enum array as a parameter",
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
