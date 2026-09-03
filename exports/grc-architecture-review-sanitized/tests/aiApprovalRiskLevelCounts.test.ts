/**
 * Task #536 — risk-level counts SQL guard.
 *
 * Verifies that `countByRiskLevel()` in `src/utils/aiApprovalDatabase.ts`
 * builds a single COUNT query that
 *   - aggregates ALL FOUR risk buckets (critical / high / medium / low)
 *     in one round-trip via COUNT(*) FILTER (WHERE risk_level = '...')
 *   - applies the supplied Status / requester filters to the base WHERE
 *   - applies the Review filter ('unreviewed_by_me' / 'no_reviewers') to
 *     the base WHERE so the four numbers agree with the visible list
 *   - throws a clear error when reviewFilter='unreviewed_by_me' is set
 *     without a reviewerUserId (no silent drop of the predicate, which
 *     would mislead the operator about what each count means)
 *
 * We stub the pg pool so the test runs without a live database — we only
 * care about the SQL/parameter shape, not the rows returned.
 *
 * Run:  npx tsx tests/aiApprovalRiskLevelCounts.test.ts
 */

import type { QueryResult, QueryResultRow } from "pg";
import {
  aiApprovalPool,
  countByRiskLevel,
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
  // The aggregate query returns one row with all four bucket counts as text.
  const rows = [
    { critical: "0", high: "0", medium: "0", low: "0" },
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
  // Case 1: single round-trip aggregating all four buckets, no filters.
  // -----------------------------------------------------------------
  captured.length = 0;
  const result = await countByRiskLevel({});
  assert(captured.length === 1, "issues exactly one SQL query (single round-trip)");
  const q = captured[0];
  assert(
    /COUNT\(\*\)\s+FILTER\s*\(\s*WHERE\s+risk_level\s*=\s*'critical'\s*\)/i.test(q.sql),
    "emits COUNT(*) FILTER for risk_level='critical'",
  );
  assert(
    /COUNT\(\*\)\s+FILTER\s*\(\s*WHERE\s+risk_level\s*=\s*'high'\s*\)/i.test(q.sql),
    "emits COUNT(*) FILTER for risk_level='high'",
  );
  assert(
    /COUNT\(\*\)\s+FILTER\s*\(\s*WHERE\s+risk_level\s*=\s*'medium'\s*\)/i.test(q.sql),
    "emits COUNT(*) FILTER for risk_level='medium'",
  );
  assert(
    /COUNT\(\*\)\s+FILTER\s*\(\s*WHERE\s+risk_level\s*=\s*'low'\s*\)/i.test(q.sql),
    "emits COUNT(*) FILTER for risk_level='low'",
  );
  assert(
    /AS\s+critical/i.test(q.sql) &&
      /AS\s+high/i.test(q.sql) &&
      /AS\s+medium/i.test(q.sql) &&
      /AS\s+low/i.test(q.sql),
    "selects all four bucket aliases",
  );
  assert(
    typeof result.critical === "number" &&
      typeof result.high === "number" &&
      typeof result.medium === "number" &&
      typeof result.low === "number",
    "returns numeric counts for all four buckets",
  );

  // -----------------------------------------------------------------
  // Case 2: optional Status / requester filters are applied to the
  // base WHERE so the counts agree with the visible list.
  // -----------------------------------------------------------------
  captured.length = 0;
  await countByRiskLevel({
    status: "pending",
    requestedByUserId: 7,
  });
  const q2 = captured[0];
  assert(
    /\bstatus\s*=\s*ANY\(/i.test(q2.sql),
    "applies status filter to base WHERE",
  );
  assert(
    /\brequested_by_user_id\s*=\s*\$\d+/i.test(q2.sql),
    "applies requested_by_user_id filter (Only-my-proposals) to base WHERE",
  );
  assert(q2.params.includes(7), "binds requestedByUserId=7");
  // The risk_level enum literals must be hard-coded (closed enum owned
  // by this module), never bound as parameters.
  assert(
    !q2.params.includes("critical") &&
      !q2.params.includes("high") &&
      !q2.params.includes("medium") &&
      !q2.params.includes("low"),
    "does not bind risk_level enum values as parameters",
  );

  // -----------------------------------------------------------------
  // Case 3: review_filter='no_reviewers' adds a NOT EXISTS against
  // event_logs without binding any reviewer user_id parameter.
  // -----------------------------------------------------------------
  captured.length = 0;
  await countByRiskLevel({
    status: "pending",
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
  await countByRiskLevel({
    status: "pending",
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
    await countByRiskLevel({
      status: "pending",
      reviewFilter: "unreviewed_by_me",
    });
  } catch (err) {
    threw = err instanceof Error && /reviewerUserId/.test(err.message);
  }
  assert(threw, "throws when unreviewed_by_me is requested without a reviewerUserId");

  // -----------------------------------------------------------------
  // Case 6: when no Review filter is supplied, the SQL must NOT emit
  // any NOT EXISTS / event_logs sub-query (avoid wasted seq scan).
  // -----------------------------------------------------------------
  captured.length = 0;
  await countByRiskLevel({ status: "pending" });
  const q6 = captured[0];
  assert(
    !/NOT\s+EXISTS/i.test(q6.sql),
    "omits NOT EXISTS when no review filter supplied",
  );
  assert(
    !/event_logs/i.test(q6.sql),
    "omits event_logs join when no review filter supplied",
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
