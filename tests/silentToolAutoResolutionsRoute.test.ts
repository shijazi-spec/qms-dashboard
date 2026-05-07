/**
 * Integration tests for the new silent-tool auto-resolutions tile route
 * (Task #346):
 *
 *   GET /api/ai-ops/silent-tool-auto-resolutions
 *
 * Coverage matrix:
 *   - structural        → route is registered with the right method/path.
 *   - 403 forbidden     → unauthenticated callers are rejected.
 *   - 200 happy path    → seed two ai_alerts rows whose resolution_note
 *                         matches the canonical silent-tool sweep prefix
 *                         (one < 24h ago, one in the 24h–7d window) plus a
 *                         decoy that should NOT be counted, then assert the
 *                         counter helper returns last24h=1, last7d=2.
 *
 * The DB-gated test runs only when DATABASE_URL is set; the auth-boundary
 * test runs unconditionally.
 *
 * Run:  npx tsx tests/silentToolAutoResolutionsRoute.test.ts
 */

import { aiOpsRoutes } from "../src/mastra/routes/aiOpsRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext } from "./_helpers/fakeContext";

const ROUTE_PATH = "/api/ai-ops/silent-tool-auto-resolutions";
const HAS_DB = !!process.env.DATABASE_URL;

const suite = new TestSuite("silentToolAutoResolutionsRoute");
console.log("\n=== silent-tool auto-resolutions route ===\n");

await suite.test("route is registered with GET method", async () => {
  const r = aiOpsRoutes.find((r: any) => r.path === ROUTE_PATH);
  suite.expect(!!r, `route ${ROUTE_PATH} is registered`);
  if (r) suite.expectEqual(r.method, "GET", "method is GET");
  if (r) suite.expect(typeof r.createHandler === "function", "createHandler is a function");
});

await suite.test("rejects unauthenticated callers with 403", async () => {
  const handler = await buildHandler(aiOpsRoutes as any, ROUTE_PATH, "GET");
  // No admin key, no session — requireRole() returns null which the
  // handler maps to 403.
  const ctx = makeContext({ headers: {}, query: {} });
  const res: any = await handler(ctx);
  suite.expectEqual(res?.status, 403, "unauthenticated → 403");
});

if (!HAS_DB) {
  console.log("  · skipping happy-path test (DATABASE_URL not set)\n");
} else {
  await suite.test(
    "happy path: returns last24h + last7d counts of silent-tool auto-resolutions",
    async () => {
      // We exercise the underlying counter helper directly so the test
      // doesn't have to construct a real authenticated request — the
      // route is a thin wrapper and its 403 path is already covered.
      const { getSilentToolAutoResolutionCounts } = await import(
        "../src/utils/aiAlertsDatabase"
      );
      const { sharedPool } = await import("../src/utils/sharedPool");

      const RUN = `t346_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const titles = [
        `${RUN}_silent_24h`,
        `${RUN}_silent_3d`,
        `${RUN}_decoy_recovery`,
        `${RUN}_decoy_open`,
      ];

      try {
        // Snapshot baseline counts so we can assert by delta — the test DB
        // may already have unrelated silent-tool resolutions in either
        // window from prior runs.
        const before = await getSilentToolAutoResolutionCounts();

        // Seed: two silent-tool auto-resolutions (one inside 24h, one inside
        // 7d), one decoy that is auto-resolved by the recovery sweep (NOT
        // the silent sweep — must not be counted), and one open alert
        // with a matching note (must not be counted because status≠resolved).
        const SILENT_NOTE =
          "auto-resolved: tool went silent — no calls recorded in the last 60 minutes (cooldown window)";
        const RECOVERY_NOTE =
          "auto-resolved: error rate back below threshold (1% < 5% over 30m, 100 calls)";

        await sharedPool.query(
          `INSERT INTO ai_alerts
             (alert_type, severity, title, description, related_module,
              status, resolved_at, resolution_note, created_at)
           VALUES
             ('tool_health','critical',$1,'seed','ai_ops','resolved',
              NOW() - INTERVAL '2 hours', $5, NOW() - INTERVAL '3 hours'),
             ('tool_health','critical',$2,'seed','ai_ops','resolved',
              NOW() - INTERVAL '3 days', $5, NOW() - INTERVAL '4 days'),
             ('tool_health','critical',$3,'seed','ai_ops','resolved',
              NOW() - INTERVAL '2 hours', $6, NOW() - INTERVAL '3 hours'),
             ('tool_health','critical',$4,'seed','ai_ops','open',
              NULL, $5, NOW())`,
          [titles[0], titles[1], titles[2], titles[3], SILENT_NOTE, RECOVERY_NOTE],
        );

        const after = await getSilentToolAutoResolutionCounts();
        const delta24 = after.last24h - before.last24h;
        const delta7 = after.last7d - before.last7d;

        // Expected: only the silent-tool resolved-2h-ago row counts in 24h.
        suite.expectEqual(delta24, 1, "24h window counts the < 24h silent row");
        // Both silent-tool rows fall inside 7d; recovery + open decoys do not.
        suite.expectEqual(delta7, 2, "7d window counts both silent rows");
      } finally {
        const { sharedPool } = await import("../src/utils/sharedPool");
        await sharedPool
          .query(`DELETE FROM ai_alerts WHERE title = ANY($1::text[])`, [titles])
          .catch(() => {});
      }
    },
  );
}

const summary = suite.summarize();
console.log(
  `\nResult: ${summary.passed}/${summary.total} passed${summary.failed ? `, ${summary.failed} failed` : ""}\n`,
);
process.exit(summary.failed === 0 ? 0 : 1);
