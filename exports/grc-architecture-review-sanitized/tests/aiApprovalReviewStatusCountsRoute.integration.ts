/**
 * Task #537 — End-to-end integrity guard for the AI approval-queue
 * "Review" filter inline counts.
 *
 * Why this test exists
 * --------------------
 * Task #513 ships SQL-shape unit tests for `countByReviewStatus()` in
 * `src/utils/aiApprovalDatabase.ts`. Those tests prove the COUNT query
 * uses the right NOT EXISTS shape for both `unreviewed_by_me` and
 * `no_reviewers` buckets — but they can't prove that the count query
 * stays in lock-step with the *list* query in `listPendingActions()`.
 *
 * The two queries share the same NOT EXISTS shape but execute as
 * independent round-trips against `ai_pending_actions` × `event_logs`.
 * If a future refactor tweaked one shape and not the other (or applied
 * a visibility rule on one endpoint and not the other), the inline
 * counts on the "Review" filter dropdown would silently disagree with
 * the rows the queue actually displays — the most damaging failure
 * mode for an at-a-glance triage UI: an operator sees "12 unreviewed
 * by me" but only 9 rows when they click into it, and never knows
 * which 3 they're missing.
 *
 * What this test does
 * -------------------
 *   1. Seeds a handful of `ai_pending_actions` rows with mixed
 *      `risk_level` and `requested_by_user_id` (some owned by the
 *      synthetic privileged QM user, some by a synthetic non-privileged
 *      BU user). Also seeds two extra rows that are post-update flipped
 *      to non-pending statuses (`approved`, `rejected`) so the test
 *      can prove the `status=` query parameter is parsed and applied
 *      identically by BOTH endpoints — including the comma-separated
 *      multi-status form (e.g. `status=pending,approved`).
 *   2. Seeds a handful of view-audit `event_logs` rows
 *      (action_type='AI_ACTION', description ILIKE 'Viewed%') so the
 *      review-status NOT EXISTS sub-queries actually have something to
 *      filter against — covering rows viewed by the QM, rows viewed by
 *      a third-party reviewer, and rows viewed by nobody.
 *   3. Drives `GET /api/ai/approvals/review-status-counts` and
 *      `GET /api/ai/approvals?review_filter=...` over real HTTP with
 *      identical Status / Risk-level / mine query strings, then asserts
 *      that
 *        counts.unreviewed_by_me === list?(review_filter=unreviewed_by_me).total
 *        counts.no_reviewers     === list?(review_filter=no_reviewers).total
 *      for every scenario the dashboard exercises:
 *        - admin (sees all)             — visibility scope: undefined
 *        - non-privileged BU (own only) — visibility scope: BU.userId
 *        - QM with mine=true            — visibility scope: QM.userId
 *        - QM with risk_level=high      — Risk-level filter applied
 *        - BU with risk_level=high      — Risk-level filter + own-only
 *        - BU with status=approved      — non-pending status, isolates the
 *                                          approved seed row
 *        - BU with status=pending,approved
 *                                       — multi-status (comma-separated),
 *                                          proves both endpoints union the
 *                                          same set of statuses
 *
 * For the synthetic-owner scenarios (BU non-privileged, QM mine=true,
 * BU + risk=high) the test additionally asserts the *absolute* counts
 * match the seeded shape, so a refactor that broke the shared shape
 * would not be masked by happenstance equality.
 *
 * Run:  npx tsx tests/aiApprovalReviewStatusCountsRoute.integration.ts
 * Env:  DATABASE_URL   — Postgres connection string (required)
 *       SESSION_SECRET — HMAC key the dev server uses to sign session
 *                         cookies (required). MUST match the running
 *                         dev server's value or every request returns 401.
 *       BASE_URL       — defaults to <REDACTED_URL>
 *
 * Cleanup is in `finally`: every seeded `ai_pending_actions` row, every
 * view-audit `event_logs` row, and every `platform_users` row is
 * removed by stable marker (tool_id = SEED_TOOL_ID, action_code IN
 * (...captured...), email IN (TEST_QM_EMAIL, TEST_BU_EMAIL)).
 */

import crypto from "crypto";
import {
  enqueuePendingAction,
  aiApprovalPool,
} from "../src/utils/aiApprovalDatabase";
import { logEvent } from "../src/utils/eventLogsDatabase";

/* ------------------------------------------------------------------ */
/* Constants                                                          */
/* ------------------------------------------------------------------ */

const BASE_URL = process.env.BASE_URL || "<REDACTED_URL>";
const SESSION_SECRET = process.env.SESSION_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

if (!SESSION_SECRET) {
  console.error("❌ SESSION_SECRET env var is required");
  process.exit(2);
}
if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL env var is required");
  process.exit(2);
}

// Synthetic IDs/emails — all distinct from anything a real user could
// hold so seeded rows are unambiguous and cleanup is safe.
const TEST_QM_EMAIL = "user@example.invalid";
const TEST_QM_NAME = "Review-Counts Integration QM";
const TEST_QM_USER_ID = 999_801;

const TEST_BU_EMAIL = "user@example.invalid";
const TEST_BU_NAME = "Review-Counts Integration BU";
const TEST_BU_USER_ID = 999_802;

// A third synthetic reviewer that "views" some actions but is not the
// caller — proves the `unreviewed_by_me` filter discriminates by
// reviewer user_id rather than treating any viewer as everyone's view.
const OTHER_REVIEWER_USER_ID = 999_500;

// Stable marker on every seeded ai_pending_actions row so cleanup is a
// single DELETE WHERE tool_id = $1. Picked to NOT start with
// `integration-test-` so the route's getExcludedToolIdPrefixes() filter
// (which would skip these rows on the LIST endpoint outside NODE_ENV=test)
// does not apply — we want the seeded rows to count on BOTH endpoints.
const SEED_TOOL_ID = "review-status-counts-int-test";
const SEED_TOOL_LABEL = "[Integration-Test] Review-Status Counts Route Guard";

/* ------------------------------------------------------------------ */
/* Session cookie                                                     */
/* ------------------------------------------------------------------ */

function signSession(payload: Record<string, unknown>): string {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", SESSION_SECRET!)
    .update(data)
    .digest("base64url");
  return `${data}.${sig}`;
}

function makeCookie(opts: {
  userId: number;
  email: string;
  name: string;
  role: string;
}): string {
  const token = signSession({
    userId: opts.userId,
    email: opts.email,
    name: opts.name,
    role: opts.role,
    exp: Date.now() + 3600_000,
  });
  return `ExampleOrg_session=${encodeURIComponent(token)}`;
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                       */
/* ------------------------------------------------------------------ */

interface ListResponse {
  success?: boolean;
  total?: number;
  rows?: Array<{ action_code: string; risk_level?: string }>;
}
interface CountsResponse {
  success?: boolean;
  unreviewed_by_me?: number;
  no_reviewers?: number;
}

async function httpGetJson<T>(
  path: string,
  cookie: string,
): Promise<{
  status: number;
  body: T;
  text: string;
}> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Cookie: cookie, Accept: "application/json" },
    redirect: "manual",
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body: body as T, text };
}

/* ------------------------------------------------------------------ */
/* Assertions                                                         */
/* ------------------------------------------------------------------ */

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

function assertEqual<T>(actual: T, expected: T, label: string): void {
  assert(
    actual === expected,
    `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
  );
}

/* ------------------------------------------------------------------ */
/* Seed helpers                                                       */
/* ------------------------------------------------------------------ */

async function setupTestUsers(): Promise<void> {
  // Both users must exist with status='active' or `requireRole` (called by
  // aiApprovalGate) returns 403 because the platform_users lookup fails.
  // The cookie carries the role we want the inner handler to see; the
  // platform_users row only needs to be `active` and have a role that's
  // in AI_APPROVAL_READ_ROLES (both 'quality_manager' and 'bu_owner' are).
  await aiApprovalPool.query(
    `INSERT INTO platform_users (email, full_name, role, status, team)
     VALUES ($1, $2, 'quality_manager', 'active', 'Other')
     ON CONFLICT (email) DO UPDATE
       SET role   = 'quality_manager',
           status = 'active'`,
    [TEST_QM_EMAIL, TEST_QM_NAME],
  );
  await aiApprovalPool.query(
    `INSERT INTO platform_users (email, full_name, role, status, team)
     VALUES ($1, $2, 'bu_owner', 'active', 'Other')
     ON CONFLICT (email) DO UPDATE
       SET role   = 'bu_owner',
           status = 'active'`,
    [TEST_BU_EMAIL, TEST_BU_NAME],
  );
}

async function cleanupTestUsers(): Promise<void> {
  await aiApprovalPool.query(
    "DELETE FROM platform_users WHERE email = ANY($1)",
    [[TEST_QM_EMAIL, TEST_BU_EMAIL]],
  );
}

interface SeededRow {
  actionCode: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  ownerUserId: number;
  /** Reviewer user_ids we will write view-audit rows for (may be empty). */
  viewerUserIds: number[];
}

async function seedActions(
  shapes: Array<{
    riskLevel: SeededRow["riskLevel"];
    ownerUserId: number;
    viewerUserIds: number[];
  }>,
): Promise<SeededRow[]> {
  const seeded: SeededRow[] = [];
  for (const shape of shapes) {
    const row = await enqueuePendingAction({
      toolId: SEED_TOOL_ID,
      toolLabel: SEED_TOOL_LABEL,
      payload: { marker: "review-status-counts-int-test" },
      payloadPreview: "Review-status counts integration-test seed",
      riskLevel: shape.riskLevel,
      complianceRefs: ["REVIEW-COUNTS-INT-TEST"],
      requestedByUserId: shape.ownerUserId,
      requestedByEmail: `req-${shape.ownerUserId}@ExampleOrg-test.invalid`,
      requestedByName: `Synthetic Requester ${shape.ownerUserId}`,
      threadId: `thr_review_counts_int_${shape.ownerUserId}`,
    });
    seeded.push({
      actionCode: row.action_code,
      riskLevel: shape.riskLevel,
      ownerUserId: shape.ownerUserId,
      viewerUserIds: shape.viewerUserIds,
    });
  }

  // Now record view-audit rows. Mirrors the shape the GET /:code handler
  // writes via logEvent (action_type='AI_ACTION', description starts
  // with 'Viewed', correlation_id = action_code) — the same row shape
  // both NOT EXISTS sub-queries scan in the count and list paths.
  for (const row of seeded) {
    for (const viewerUserId of row.viewerUserIds) {
      await logEvent({
        userId: viewerUserId,
        userEmail: `viewer-${viewerUserId}@ExampleOrg-test.invalid`,
        userRole: "quality_manager",
        actionType: "AI_ACTION",
        entityType: "SYSTEM",
        entityId: row.actionCode,
        entityName: SEED_TOOL_LABEL,
        description: `Viewed pending AI action ${row.actionCode} (review-counts integration test)`,
        aiInvolved: true,
        severity: "INFO",
        module: "ai-governance",
        correlationId: row.actionCode,
      });
    }
  }

  return seeded;
}

/**
 * Flip a seeded row to a non-pending status. `enqueuePendingAction`
 * always inserts as 'pending', so the only way to land mixed-status
 * fixtures is to UPDATE after the fact. Defensive double-filter on
 * tool_id so a code-collision can't mutate someone else's row.
 */
async function setActionStatus(
  actionCode: string,
  status: "approved" | "rejected" | "executed" | "failed" | "expired",
): Promise<void> {
  await aiApprovalPool.query(
    "UPDATE ai_pending_actions SET status = $1 WHERE tool_id = $2 AND action_code = $3",
    [status, SEED_TOOL_ID, actionCode],
  );
}

async function cleanupSeededRows(actionCodes: string[]): Promise<void> {
  if (actionCodes.length === 0) return;
  // event_logs first (FK-style logical reference via correlation_id).
  await aiApprovalPool
    .query("DELETE FROM event_logs WHERE correlation_id = ANY($1)", [
      actionCodes,
    ])
    .catch(() => undefined);
  // Then ai_pending_actions. Defensive double-filter on tool_id so a
  // collision on a randomly-generated action_code (extremely unlikely
  // given APR-YYYYMMDD-XXXXXX shape) cannot delete somebody else's row.
  await aiApprovalPool
    .query(
      "DELETE FROM ai_pending_actions WHERE tool_id = $1 AND action_code = ANY($2)",
      [SEED_TOOL_ID, actionCodes],
    )
    .catch(() => undefined);
}

/* ------------------------------------------------------------------ */
/* Scenario runner                                                    */
/* ------------------------------------------------------------------ */

interface ScenarioOpts {
  label: string;
  cookie: string;
  /** Query string fragments shared by both endpoints (no leading `?`). */
  sharedQuery: string;
  /** Optional absolute-count expectations (used when scope is isolated). */
  expectedUnreviewedByMe?: number;
  expectedNoReviewers?: number;
  /** Optional minimum each count must reach (so equality on 0==0 fails). */
  minCount?: number;
}

async function runScenario(opts: ScenarioOpts): Promise<void> {
  console.log(`\n— Scenario: ${opts.label}`);

  // 1) Inline counts (one round-trip aggregating both buckets).
  const countsRes = await httpGetJson<CountsResponse>(
    `/api/ai/approvals/review-status-counts?${opts.sharedQuery}`,
    opts.cookie,
  );
  assertEqual(
    countsRes.status,
    200,
    `${opts.label}: GET /review-status-counts → 200`,
  );
  const counts = countsRes.body || {};
  assert(
    typeof counts.unreviewed_by_me === "number" &&
      typeof counts.no_reviewers === "number",
    `${opts.label}: counts response has numeric unreviewed_by_me + no_reviewers (got ${JSON.stringify(counts)})`,
  );

  // 2) List with review_filter=unreviewed_by_me — total must equal
  //    counts.unreviewed_by_me. limit is irrelevant (we only assert .total).
  const listUbm = await httpGetJson<ListResponse>(
    `/api/ai/approvals?${opts.sharedQuery}&review_filter=unreviewed_by_me&limit=1`,
    opts.cookie,
  );
  assertEqual(
    listUbm.status,
    200,
    `${opts.label}: GET /approvals?review_filter=unreviewed_by_me → 200`,
  );

  // 3) List with review_filter=no_reviewers — total must equal
  //    counts.no_reviewers.
  const listNr = await httpGetJson<ListResponse>(
    `/api/ai/approvals?${opts.sharedQuery}&review_filter=no_reviewers&limit=1`,
    opts.cookie,
  );
  assertEqual(
    listNr.status,
    200,
    `${opts.label}: GET /approvals?review_filter=no_reviewers → 200`,
  );

  // 4) Equality assertions — the failure mode the task is hunting.
  assertEqual(
    listUbm.body?.total ?? -1,
    counts.unreviewed_by_me ?? -2,
    `${opts.label}: list?(review_filter=unreviewed_by_me).total === counts.unreviewed_by_me`,
  );
  assertEqual(
    listNr.body?.total ?? -1,
    counts.no_reviewers ?? -2,
    `${opts.label}: list?(review_filter=no_reviewers).total === counts.no_reviewers`,
  );

  // 5) Optional absolute-count assertions (only when the scenario's
  //    visibility scope is isolated to seeded synthetic rows).
  if (opts.expectedUnreviewedByMe !== undefined) {
    assertEqual(
      counts.unreviewed_by_me,
      opts.expectedUnreviewedByMe,
      `${opts.label}: counts.unreviewed_by_me equals seeded expectation`,
    );
  }
  if (opts.expectedNoReviewers !== undefined) {
    assertEqual(
      counts.no_reviewers,
      opts.expectedNoReviewers,
      `${opts.label}: counts.no_reviewers equals seeded expectation`,
    );
  }
  if (opts.minCount !== undefined) {
    // Without this the equality check is trivially satisfied by 0==0
    // when the DB happens to be empty for the chosen scope. The seeded
    // rows we're about to compare against guarantee both buckets >= 1
    // for the global-scope scenario, so this catches a future seeding
    // regression that would otherwise let the assertion pass vacuously.
    assert(
      (counts.unreviewed_by_me ?? -1) >= opts.minCount,
      `${opts.label}: counts.unreviewed_by_me >= ${opts.minCount} (non-vacuous)`,
    );
    assert(
      (counts.no_reviewers ?? -1) >= opts.minCount,
      `${opts.label}: counts.no_reviewers >= ${opts.minCount} (non-vacuous)`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log(
    "\n=== AI approval-queue review-status counts — list-vs-count integrity ===\n",
  );
  console.log(`Target: ${BASE_URL}\n`);

  // Reachability probe.
  try {
    await fetch(`${BASE_URL}/`, { redirect: "manual" });
  } catch (err: any) {
    console.error(`❌ Cannot reach ${BASE_URL} — is the dev server running?`);
    console.error(`   ${err?.message ?? err}`);
    process.exit(2);
  }

  const seededCodes: string[] = [];

  await setupTestUsers();

  try {
    /* ---------- Seed shape ----------
     *
     * Owner BU (TEST_BU_USER_ID = 999_802):
     *   BU1: pending, high,   viewed_by={QM(999_801)}
     *        → reviewed by QM, has reviewers
     *   BU2: pending, high,   viewed_by={}
     *        → unreviewed by QM, no reviewers
     *   BU3: pending, medium, viewed_by={OTHER(999_500)}
     *        → unreviewed by QM, has reviewers
     *   BU4: pending, low,    viewed_by={QM(999_801), OTHER(999_500)}
     *        → reviewed by QM, has reviewers
     *
     * Owner QM (TEST_QM_USER_ID = 999_801):
     *   QM1: pending, high,   viewed_by={OTHER(999_500)}
     *        → unreviewed by QM (QM not in viewers), has reviewers
     *   QM2: pending, medium, viewed_by={}
     *        → unreviewed by QM, no reviewers
     *   QM3: pending, high,   viewed_by={QM(999_801)}
     *        → reviewed by QM, has reviewers
     *
     * Reviewer perspective:
     *   - BU as reviewer (cookie userId=999_802) — BU never views their
     *     own actions, so all 4 BU rows are "unreviewed by me=BU".
     *   - QM as reviewer (cookie userId=999_801).
     */
    const seeded = await seedActions([
      // BU-owned
      {
        riskLevel: "high",
        ownerUserId: TEST_BU_USER_ID,
        viewerUserIds: [TEST_QM_USER_ID],
      }, // BU1
      { riskLevel: "high", ownerUserId: TEST_BU_USER_ID, viewerUserIds: [] }, // BU2
      {
        riskLevel: "medium",
        ownerUserId: TEST_BU_USER_ID,
        viewerUserIds: [OTHER_REVIEWER_USER_ID],
      }, // BU3
      {
        riskLevel: "low",
        ownerUserId: TEST_BU_USER_ID,
        viewerUserIds: [TEST_QM_USER_ID, OTHER_REVIEWER_USER_ID],
      }, // BU4
      // QM-owned
      {
        riskLevel: "high",
        ownerUserId: TEST_QM_USER_ID,
        viewerUserIds: [OTHER_REVIEWER_USER_ID],
      }, // QM1
      { riskLevel: "medium", ownerUserId: TEST_QM_USER_ID, viewerUserIds: [] }, // QM2
      {
        riskLevel: "high",
        ownerUserId: TEST_QM_USER_ID,
        viewerUserIds: [TEST_QM_USER_ID],
      }, // QM3
    ]);
    for (const s of seeded) seededCodes.push(s.actionCode);

    /* ---------- Mixed-status seed ----------
     *
     * Two extra rows are created and then UPDATEd to non-pending
     * statuses so the test can prove the `status=` query parameter
     * is parsed and applied identically by BOTH endpoints. The route
     * only inserts as 'pending' via `enqueuePendingAction`, so the
     * status flip must happen post-insert.
     *
     *   BU5: low,    viewed_by={}             status='approved'
     *        → BU-owned, unreviewed by anyone, no reviewers
     *   QM4: high,   viewed_by={OTHER}        status='rejected'
     *        → QM-owned, viewed by OTHER, has reviewers
     *
     * These rows MUST NOT appear in any default (`status=pending`)
     * scenario — Scenario 1's absolute count of 4 is a regression
     * guard for that. They MUST appear in `status=approved` /
     * `status=rejected` scopes, and the `status=pending,approved`
     * multi-status scope must union them with the pending rows.
     */
    const mixedStatusSeed = await seedActions([
      { riskLevel: "low", ownerUserId: TEST_BU_USER_ID, viewerUserIds: [] },
      {
        riskLevel: "high",
        ownerUserId: TEST_QM_USER_ID,
        viewerUserIds: [OTHER_REVIEWER_USER_ID],
      },
    ]);
    const [BU5, QM4] = mixedStatusSeed;
    for (const s of mixedStatusSeed) seededCodes.push(s.actionCode);
    await setActionStatus(BU5.actionCode, "approved");
    await setActionStatus(QM4.actionCode, "rejected");

    console.log(
      `  • seeded ${seeded.length} pending + ${mixedStatusSeed.length} non-pending ai_pending_actions rows + view-audit event_logs rows\n`,
    );

    const qmCookie = makeCookie({
      userId: TEST_QM_USER_ID,
      email: TEST_QM_EMAIL,
      name: TEST_QM_NAME,
      role: "quality_manager",
    });
    const buCookie = makeCookie({
      userId: TEST_BU_USER_ID,
      email: TEST_BU_EMAIL,
      name: TEST_BU_NAME,
      role: "bu_owner",
    });

    /* ---------------------------------------------------------------
     * Scenario 1: Non-privileged BU, default Status (=pending), no
     * Risk filter, no mine. The list+count both auto-scope to
     * requested_by_user_id = BU.userId, so we own the entire visible
     * set and can assert absolute counts.
     *
     * Among 4 BU-owned pending rows:
     *   BU1: viewed by QM (not BU)        → unreviewed_by_me, has reviewers
     *   BU2: viewed by nobody             → unreviewed_by_me, no_reviewers
     *   BU3: viewed by OTHER (not BU)     → unreviewed_by_me, has reviewers
     *   BU4: viewed by QM+OTHER (not BU)  → unreviewed_by_me, has reviewers
     * → unreviewed_by_me=4, no_reviewers=1
     * --------------------------------------------------------------- */
    await runScenario({
      label: "BU non-privileged (own rows only)",
      cookie: buCookie,
      sharedQuery: "status=pending",
      expectedUnreviewedByMe: 4,
      expectedNoReviewers: 1,
    });

    /* ---------------------------------------------------------------
     * Scenario 2: Non-privileged BU + Risk-level=high. Visible set =
     * BU-owned high-risk pending rows = BU1, BU2.
     *   BU1: viewed by QM (not BU)        → unreviewed_by_me, has reviewers
     *   BU2: viewed by nobody             → unreviewed_by_me, no_reviewers
     * → unreviewed_by_me=2, no_reviewers=1
     * --------------------------------------------------------------- */
    await runScenario({
      label: "BU non-privileged + risk_level=high",
      cookie: buCookie,
      sharedQuery: "status=pending&risk_level=high",
      expectedUnreviewedByMe: 2,
      expectedNoReviewers: 1,
    });

    /* ---------------------------------------------------------------
     * Scenario 3: Privileged QM with mine=true. Visible set =
     * QM-owned pending rows = QM1, QM2, QM3. Reviewer = QM.
     *   QM1: viewed by OTHER (not QM)     → unreviewed_by_me, has reviewers
     *   QM2: viewed by nobody             → unreviewed_by_me, no_reviewers
     *   QM3: viewed by QM                 → reviewed by QM, has reviewers
     * → unreviewed_by_me=2, no_reviewers=1
     * --------------------------------------------------------------- */
    await runScenario({
      label: "QM with mine=true",
      cookie: qmCookie,
      sharedQuery: "status=pending&mine=true",
      expectedUnreviewedByMe: 2,
      expectedNoReviewers: 1,
    });

    /* ---------------------------------------------------------------
     * Scenario 4: Privileged QM, no mine, no Risk filter — the
     * "admin sees all" case. Absolute counts depend on whatever else
     * is in the DB (other tests, dev seeding), so we only assert
     * count == list.total — the actual drift the task is guarding
     * against. minCount=1 keeps the assertion non-vacuous: our seeded
     * rows guarantee unreviewed_by_me >= 4 (BU2/BU3 + QM1/QM2 are not
     * viewed by QM) and no_reviewers >= 2 (BU2 + QM2). minCount=1 is
     * the conservative floor that survives any future addition of
     * QM-viewed rows by other test suites.
     * --------------------------------------------------------------- */
    await runScenario({
      label: "QM admin-scope (sees all, no mine)",
      cookie: qmCookie,
      sharedQuery: "status=pending",
      minCount: 1,
    });

    /* ---------------------------------------------------------------
     * Scenario 5: Privileged QM + Risk-level=high, no mine. Same
     * "drift detection" assertion as Scenario 4 but with the Risk
     * filter applied to BOTH endpoints — proves the count endpoint
     * is wiring `risk_level` through to the same WHERE the list uses.
     * Our seeded rows guarantee at least BU1 (viewed by QM → "has
     * reviewers"), BU2 (no viewers), QM1 (viewed by OTHER not QM →
     * unreviewed by QM), QM3 (viewed by QM → reviewed by QM) are
     * visible, so unreviewed_by_me >= 2 and no_reviewers >= 1 within
     * the high-risk slice.
     * --------------------------------------------------------------- */
    await runScenario({
      label: "QM admin-scope + risk_level=high",
      cookie: qmCookie,
      sharedQuery: "status=pending&risk_level=high",
      minCount: 1,
    });

    /* ---------------------------------------------------------------
     * Scenario 6: Non-privileged BU + status=approved. Visible set =
     * BU-owned approved rows. After cleanup the only such row in this
     * test's scope is BU5 (low, viewed by nobody → unreviewed by me,
     * no reviewers). This proves the count endpoint accepts and
     * applies a non-default Status filter the same way the list does.
     * → unreviewed_by_me=1, no_reviewers=1
     * --------------------------------------------------------------- */
    await runScenario({
      label: "BU non-privileged + status=approved",
      cookie: buCookie,
      sharedQuery: "status=approved",
      expectedUnreviewedByMe: 1,
      expectedNoReviewers: 1,
    });

    /* ---------------------------------------------------------------
     * Scenario 7: Non-privileged BU + status=pending,approved (multi-
     * status, comma-separated). The route parses `status` as a
     * comma-separated list and emits `status = ANY($n)`; this proves
     * BOTH endpoints union the same set of statuses. Visible set =
     * BU-owned rows whose status is in {pending, approved}:
     *   BU1 (pending, viewed by QM not BU)        → unreviewed_by_me, has reviewers
     *   BU2 (pending, viewed by nobody)           → unreviewed_by_me, no_reviewers
     *   BU3 (pending, viewed by OTHER not BU)     → unreviewed_by_me, has reviewers
     *   BU4 (pending, viewed by QM+OTHER not BU)  → unreviewed_by_me, has reviewers
     *   BU5 (approved, viewed by nobody)          → unreviewed_by_me, no_reviewers
     * → unreviewed_by_me=5, no_reviewers=2
     * --------------------------------------------------------------- */
    await runScenario({
      label: "BU non-privileged + status=pending,approved (multi-status)",
      cookie: buCookie,
      sharedQuery: "status=pending,approved",
      expectedUnreviewedByMe: 5,
      expectedNoReviewers: 2,
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) {
      console.error(
        "\n❌ AI approval-queue review-status counts integration test FAILED",
      );
      process.exit(1);
    }
    console.log(
      "\n✅ Inline review-status counts agree with the visible row counts " +
        "across admin / non-privileged / mine=true / risk-level scopes",
    );
  } finally {
    await cleanupSeededRows(seededCodes);
    await cleanupTestUsers();
    void aiApprovalPool.end().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error("aiApprovalReviewStatusCountsRoute.integration crashed:", err);
  process.exit(1);
});
