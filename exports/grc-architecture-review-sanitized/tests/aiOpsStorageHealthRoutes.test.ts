/**
 * Integration tests for the storage-health additions to
 * src/mastra/routes/aiOpsRoutes.ts (Task #578) plus the resolveAlert
 * status guard in src/utils/aiAlertsDatabase.ts.
 *
 * The generic 403 sweep in tests/aiOpsRoutes.test.ts already covers
 * unauthenticated calls against every route in aiOpsRoutes (including
 * the three new storage-health endpoints), so this sibling file focuses
 * on the behaviour that's specific to the new code paths:
 *
 *   - 403 (explicit, narrowly-scoped) on each new endpoint without an
 *     AI-ops role.
 *   - 400 on POST /api/ai-ops/alerts/:id/dismiss with a bad id.
 *   - Happy-path 200 on GET /api/ai-ops/storage-health-alerts and
 *     /api/ai-ops/storage-health-alerts/history (DATABASE_URL gated)
 *     verifying the response shape.
 *   - POST /api/ai-ops/alerts/:id/dismiss transitions a seeded
 *     storage_health row to status='dismissed'.
 *   - resolveAlert() called twice on the same seeded row: the second
 *     call must be a no-op (returns null) thanks to the
 *     `status IN ('open','acknowledged')` guard added in Task #578.
 *
 * Run:  npx tsx tests/aiOpsStorageHealthRoutes.test.ts
 */

import { aiOpsRoutes } from "../src/mastra/routes/aiOpsRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext } from "./_helpers/fakeContext";
import { makeCookieForRole } from "./_helpers/sessionAuth";

const suite = new TestSuite("aiOpsStorageHealthRoutes");
const ADMIN_KEY = "integration-test-storage-health-2026";
// Signed ExampleOrg_session cookie for an active admin platform user (requireRole()
// now always performs a live getPlatformUser() lookup — the shared helper also
// registers an active platform_users row for this session's email).
const ADMIN_COOKIE = makeCookieForRole("admin");
const HAS_DB = !!process.env.DATABASE_URL;

console.log("\n=== aiOpsRoutes storage-health tests ===\n");

// ---------------------------------------------------------------------------
// Structural / boundary tests (no DB required).
// ---------------------------------------------------------------------------

await suite.test("storage-health routes are wired into aiOpsRoutes", async () => {
  const paths = aiOpsRoutes.map((r) => `${r.method} ${r.path}`);
  suite.expect(
    paths.includes("GET /api/ai-ops/storage-health-alerts"),
    "GET /api/ai-ops/storage-health-alerts registered",
  );
  suite.expect(
    paths.includes("GET /api/ai-ops/storage-health-alerts/history"),
    "GET /api/ai-ops/storage-health-alerts/history registered",
  );
  suite.expect(
    paths.includes("POST /api/ai-ops/alerts/:id/dismiss"),
    "POST /api/ai-ops/alerts/:id/dismiss registered",
  );
});

await suite.test(
  "GET /api/ai-ops/storage-health-alerts — 403 without an AI-ops role",
  async () => {
    const handler = await buildHandler(
      aiOpsRoutes,
      "/api/ai-ops/storage-health-alerts",
      "GET",
    );
    const res = await handler(makeContext({ method: "GET" }));
    suite.expectEqual(res.status, 403, "status");
    suite.expectEqual(res.body?.error, "Insufficient permissions", "body.error");
  },
);

await suite.test(
  "GET /api/ai-ops/storage-health-alerts/history — 403 without an AI-ops role",
  async () => {
    const handler = await buildHandler(
      aiOpsRoutes,
      "/api/ai-ops/storage-health-alerts/history",
      "GET",
    );
    const res = await handler(makeContext({ method: "GET" }));
    suite.expectEqual(res.status, 403, "status");
    suite.expectEqual(res.body?.error, "Insufficient permissions", "body.error");
  },
);

await suite.test(
  "POST /api/ai-ops/alerts/:id/dismiss — 403 without an AI-ops role",
  async () => {
    const handler = await buildHandler(
      aiOpsRoutes,
      "/api/ai-ops/alerts/:id/dismiss",
      "POST",
    );
    const res = await handler(
      makeContext({ method: "POST", params: { id: "1" }, body: {} }),
    );
    suite.expectEqual(res.status, 403, "status");
    suite.expectEqual(res.body?.error, "Insufficient permissions", "body.error");
  },
);

await suite.test(
  "POST /api/ai-ops/alerts/:id/dismiss — 400 on non-numeric id (with admin key)",
  async () => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    try {
      const handler = await buildHandler(
        aiOpsRoutes,
        "/api/ai-ops/alerts/:id/dismiss",
        "POST",
      );
      const res = await handler(
        makeContext({
          method: "POST",
          headers: { Cookie: ADMIN_COOKIE },
          params: { id: "not-a-number" },
        }),
      );
      suite.expectEqual(res.status, 400, "status");
      suite.expectEqual(res.body?.error, "Invalid alert id", "body.error");
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
    }
  },
);

await suite.test(
  "POST /api/ai-ops/alerts/:id/dismiss — 400 on zero id (with admin key)",
  async () => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    try {
      const handler = await buildHandler(
        aiOpsRoutes,
        "/api/ai-ops/alerts/:id/dismiss",
        "POST",
      );
      const res = await handler(
        makeContext({
          method: "POST",
          headers: { Cookie: ADMIN_COOKIE },
          params: { id: "0" },
        }),
      );
      suite.expectEqual(res.status, 400, "status");
      suite.expectEqual(res.body?.error, "Invalid alert id", "body.error");
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
    }
  },
);

// ---------------------------------------------------------------------------
// Happy-path data integration tests (require DATABASE_URL).
// ---------------------------------------------------------------------------
if (!HAS_DB) {
  console.log("\n(skipping happy-path DB tests — DATABASE_URL not set)\n");
} else {
  const { createAIAlert, resolveAlert, acknowledgeAlert, dismissAlert } =
    await import("../src/utils/aiAlertsDatabase");
  const { STORAGE_HEALTH_DEDUPE_KEY } = await import(
    "../src/utils/storageHealthAlerts"
  );

  const SUFFIX = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Seed a single open `storage_health` row up-front so the listing /
  // history / dismiss / resolve-idempotency tests all share the same
  // setup (and clean up after themselves).
  let listSeedId: number | null = null;
  let historySeedId: number | null = null;
  let dismissSeedId: number | null = null;
  let resolveSeedId: number | null = null;

  await suite.test(
    "happy: GET /api/ai-ops/storage-health-alerts returns the seeded open alert with the documented shape",
    async () => {
      const original = process.env.ADMIN_API_KEY;
      process.env.ADMIN_API_KEY = ADMIN_KEY;
      try {
        const created = await createAIAlert({
          alert_type: "storage_health",
          severity: "high",
          title: `Storage health LIST seed ${SUFFIX}`,
          description: `Test seed for storage-health-alerts route ${SUFFIX}`,
          suggestion: "Investigate prune cron",
          related_module: "ai_ops",
          related_record_id: STORAGE_HEALTH_DEDUPE_KEY,
        });
        listSeedId = created.id ?? null;
        suite.expect(listSeedId != null, "seed insert returned an id");

        const handler = await buildHandler(
          aiOpsRoutes,
          "/api/ai-ops/storage-health-alerts",
          "GET",
        );
        const res = await handler(
          makeContext({
            method: "GET",
            headers: { Cookie: ADMIN_COOKIE },
            query: { limit: "100" },
          }),
        );
        suite.expectEqual(res.status, 200, "status");
        suite.expect(typeof res.body?.total === "number", "total is a number");
        const list: any[] = res.body?.data ?? [];
        const found = list.find((a) => a.id === listSeedId);
        suite.expect(!!found, "seeded alert is in the response");
        if (found) {
          suite.expectEqual(found.severity, "high", "severity");
          suite.expectEqual(found.status, "open", "status");
          suite.expectEqual(
            found.related_record_id,
            STORAGE_HEALTH_DEDUPE_KEY,
            "related_record_id",
          );
          // Documented response shape — the dashboard banner reads each
          // of these fields directly, so any silent removal would break
          // the UI.
          for (const k of [
            "id",
            "severity",
            "title",
            "description",
            "suggestion",
            "status",
            "related_record_id",
            "created_at",
            "notified_at",
            "notified_channel",
          ]) {
            suite.expect(
              Object.prototype.hasOwnProperty.call(found, k),
              `response includes ${k} field`,
            );
          }
          suite.expectEqual(found.notified_at, null, "notified_at null until notifier records");
          suite.expectEqual(
            found.notified_channel,
            null,
            "notified_channel null until notifier records",
          );
        }
      } finally {
        if (original === undefined) delete process.env.ADMIN_API_KEY;
        else process.env.ADMIN_API_KEY = original;
        if (listSeedId != null) {
          try {
            await resolveAlert(listSeedId, "test cleanup", "storage-health-test");
          } catch {
            /* best-effort */
          }
        }
      }
    },
  );

  await suite.test(
    "happy: GET /api/ai-ops/storage-health-alerts/history returns acknowledged + resolved rows in the documented shape",
    async () => {
      const original = process.env.ADMIN_API_KEY;
      process.env.ADMIN_API_KEY = ADMIN_KEY;
      try {
        // Seed one row, immediately acknowledge it so it lands in the
        // "Recently triaged" history bucket the route returns.
        const created = await createAIAlert({
          alert_type: "storage_health",
          severity: "medium",
          title: `Storage health HISTORY seed ${SUFFIX}`,
          description: `Test seed for storage-health-alerts/history route ${SUFFIX}`,
          suggestion: "n/a",
          related_module: "ai_ops",
          related_record_id: STORAGE_HEALTH_DEDUPE_KEY,
        });
        historySeedId = created.id ?? null;
        suite.expect(historySeedId != null, "seed insert returned an id");
        if (historySeedId != null) {
          await acknowledgeAlert(historySeedId, "storage-health-test");
        }

        const handler = await buildHandler(
          aiOpsRoutes,
          "/api/ai-ops/storage-health-alerts/history",
          "GET",
        );
        const res = await handler(
          makeContext({
            method: "GET",
            headers: { Cookie: ADMIN_COOKIE },
            query: { days: "7", limit: "100" },
          }),
        );
        suite.expectEqual(res.status, 200, "status");
        suite.expectEqual(res.body?.days, 7, "days echoed");
        suite.expectEqual(res.body?.severity, null, "no-filter severity echoed as null");
        const list: any[] = res.body?.data ?? [];
        const found = list.find((a) => a.id === historySeedId);
        suite.expect(!!found, "acknowledged seed is in history response");
        if (found) {
          suite.expectEqual(found.status, "acknowledged", "status");
          suite.expectEqual(found.severity, "medium", "severity");
          suite.expectEqual(
            found.acknowledged_by,
            "storage-health-test",
            "acknowledged_by recorded",
          );
          for (const k of [
            "id",
            "severity",
            "title",
            "status",
            "acknowledged_by",
            "triaged_at",
            "created_at",
            "resolution_note",
          ]) {
            suite.expect(
              Object.prototype.hasOwnProperty.call(found, k),
              `history response includes ${k} field`,
            );
          }
          suite.expect(found.triaged_at != null, "triaged_at populated");
        }

        // Severity filter: requesting `severity=medium` must include the
        // seed; requesting `critical` must exclude it.
        const mediumOnly = await handler(
          makeContext({
            method: "GET",
            headers: { Cookie: ADMIN_COOKIE },
            query: { days: "7", limit: "100", severity: "medium" },
          }),
        );
        suite.expectEqual(mediumOnly.body?.severity, "medium", "severity echoed");
        const mediumIds = (mediumOnly.body?.data ?? []).map((a: any) => a.id);
        suite.expect(
          mediumIds.includes(historySeedId),
          "medium filter contains seed",
        );

        const criticalOnly = await handler(
          makeContext({
            method: "GET",
            headers: { Cookie: ADMIN_COOKIE },
            query: { days: "7", limit: "100", severity: "critical" },
          }),
        );
        const criticalIds = (criticalOnly.body?.data ?? []).map((a: any) => a.id);
        suite.expect(
          !criticalIds.includes(historySeedId),
          "critical filter excludes medium-severity seed",
        );
      } finally {
        if (original === undefined) delete process.env.ADMIN_API_KEY;
        else process.env.ADMIN_API_KEY = original;
        if (historySeedId != null) {
          try {
            await resolveAlert(
              historySeedId,
              "test cleanup",
              "storage-health-test",
            );
          } catch {
            /* best-effort */
          }
        }
      }
    },
  );

  await suite.test(
    "happy: POST /api/ai-ops/alerts/:id/dismiss transitions status to 'dismissed'",
    async () => {
      const original = process.env.ADMIN_API_KEY;
      process.env.ADMIN_API_KEY = ADMIN_KEY;
      try {
        const created = await createAIAlert({
          alert_type: "storage_health",
          severity: "low",
          title: `Storage health DISMISS seed ${SUFFIX}`,
          description: `Test seed for dismiss endpoint ${SUFFIX}`,
          related_module: "ai_ops",
          related_record_id: STORAGE_HEALTH_DEDUPE_KEY,
        });
        dismissSeedId = created.id ?? null;
        suite.expect(dismissSeedId != null, "seed insert returned an id");
        if (dismissSeedId == null) return;

        const handler = await buildHandler(
          aiOpsRoutes,
          "/api/ai-ops/alerts/:id/dismiss",
          "POST",
        );
        const res = await handler(
          makeContext({
            method: "POST",
            headers: { Cookie: ADMIN_COOKIE },
            params: { id: String(dismissSeedId) },
          }),
        );
        suite.expectEqual(res.status, 200, "status");
        suite.expect(res.body?.success === true, "success=true");
        suite.expectEqual(res.body?.alert?.id, dismissSeedId, "echoes alert id");
        suite.expectEqual(
          res.body?.alert?.status,
          "dismissed",
          "row transitioned to dismissed",
        );

        // Listing must no longer include the dismissed row (open-only filter).
        const listHandler = await buildHandler(
          aiOpsRoutes,
          "/api/ai-ops/storage-health-alerts",
          "GET",
        );
        const listRes = await listHandler(
          makeContext({
            method: "GET",
            headers: { Cookie: ADMIN_COOKIE },
            query: { limit: "100" },
          }),
        );
        const stillOpen = (listRes.body?.data ?? []).find(
          (a: any) => a.id === dismissSeedId,
        );
        suite.expect(
          !stillOpen,
          "dismissed alert no longer appears in storage-health-alerts list",
        );
      } finally {
        if (original === undefined) delete process.env.ADMIN_API_KEY;
        else process.env.ADMIN_API_KEY = original;
        // No cleanup needed beyond the dismiss above — the row carries a
        // unique SUFFIX in the title so it doesn't collide with other runs.
      }
    },
  );

  await suite.test(
    "happy: POST /api/ai-ops/alerts/:id/dismiss returns 404 when the row doesn't exist",
    async () => {
      const original = process.env.ADMIN_API_KEY;
      process.env.ADMIN_API_KEY = ADMIN_KEY;
      try {
        const handler = await buildHandler(
          aiOpsRoutes,
          "/api/ai-ops/alerts/:id/dismiss",
          "POST",
        );
        const res = await handler(
          makeContext({
            method: "POST",
            headers: { Cookie: ADMIN_COOKIE },
            // Pick an id that's almost certainly out of range.
            params: { id: "<REDACTED_PHONE>" },
          }),
        );
        suite.expectEqual(res.status, 404, "status");
        suite.expectEqual(res.body?.error, "Alert not found", "body.error");
      } finally {
        if (original === undefined) delete process.env.ADMIN_API_KEY;
        else process.env.ADMIN_API_KEY = original;
      }
    },
  );

  await suite.test(
    "resolveAlert is idempotent — second call on a resolved row is a no-op (Task #578 status guard)",
    async () => {
      const created = await createAIAlert({
        alert_type: "storage_health",
        severity: "high",
        title: `Storage health RESOLVE-GUARD seed ${SUFFIX}`,
        description: `Test seed for resolveAlert idempotency ${SUFFIX}`,
        related_module: "ai_ops",
        related_record_id: STORAGE_HEALTH_DEDUPE_KEY,
      });
      resolveSeedId = created.id ?? null;
      suite.expect(resolveSeedId != null, "seed insert returned an id");
      if (resolveSeedId == null) return;

      const first = await resolveAlert(
        resolveSeedId,
        "first resolve via UI",
        "operator-a",
      );
      suite.expect(first != null, "first resolve returned the updated row");
      suite.expectEqual(first?.status, "resolved", "first call flips status");
      suite.expectEqual(
        first?.resolution_note,
        "first resolve via UI",
        "first call stamps the resolution note",
      );
      suite.expectEqual(
        first?.acknowledged_by,
        "operator-a",
        "first call stamps acknowledged_by via COALESCE",
      );

      // Second call must be a no-op so the cron's auto-resolve sweep
      // can't overwrite the operator-supplied note/timestamp.
      const second = await resolveAlert(
        resolveSeedId,
        "auto-resolved by cron",
        "cron-sweep",
      );
      suite.expectEqual(
        second,
        null,
        "second call must return null (status guard rejected the UPDATE)",
      );

      // Cross-check: the row in the DB still carries the FIRST note and
      // resolver, not the second one. We verify by listing acknowledged
      // + resolved rows and looking for the seed.
      const { getAIAlerts } = await import("../src/utils/aiAlertsDatabase");
      const { alerts } = await getAIAlerts({
        alert_type: "storage_health",
        limit: 100,
      });
      const stored = alerts.find((a) => a.id === resolveSeedId);
      suite.expect(!!stored, "seed row still exists");
      if (stored) {
        suite.expectEqual(stored.status, "resolved", "still resolved");
        suite.expectEqual(
          stored.resolution_note,
          "first resolve via UI",
          "resolution_note NOT overwritten by the second call",
        );
        suite.expectEqual(
          stored.acknowledged_by,
          "operator-a",
          "acknowledged_by NOT overwritten by the second call",
        );
      }

      // Also lock in: resolve on a dismissed row is a no-op too.
      const dismissed = await createAIAlert({
        alert_type: "storage_health",
        severity: "low",
        title: `Storage health RESOLVE-GUARD-DISMISSED seed ${SUFFIX}`,
        description: `Test seed for resolveAlert vs dismissed ${SUFFIX}`,
        related_module: "ai_ops",
        related_record_id: STORAGE_HEALTH_DEDUPE_KEY,
      });
      const dismissedId = dismissed.id;
      if (dismissedId != null) {
        await dismissAlert(dismissedId);
        const resolveAfterDismiss = await resolveAlert(
          dismissedId,
          "should be ignored",
          "cron-sweep",
        );
        suite.expectEqual(
          resolveAfterDismiss,
          null,
          "resolve on a dismissed row must be a no-op",
        );
      }
    },
  );
}

suite.finishOrExit();
