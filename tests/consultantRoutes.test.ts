/**
 * Integration tests for src/mastra/routes/consultantRoutes.ts
 *
 * Coverage matrix:
 *   - 403 forbidden   → API endpoints guarded by CONSULTANT_ROLES require an
 *                       authenticated admin/ai_specialist/grc_manager/HoOQ.
 *   - structural      → every route exposes path/method/createHandler.
 *   - happy path      → POST /api/consultant/feedback persists a real row in
 *                       `ai_response_feedback.metadata` carrying the
 *                       client-supplied prompt_version / rating_source /
 *                       client_surface (Task #590), and falls back to the
 *                       server-side QMS_CONSULTANT_PROMPT_VERSION constant
 *                       when the client omits the field — guarding against
 *                       a regression where a future refactor silently drops
 *                       the body destructuring or strips promptVersion from
 *                       the chat stream's `done` frame. DATABASE_URL gated.
 *
 * Run:  npx tsx tests/consultantRoutes.test.ts
 */

import pg from "pg";
import { consultantRoutes } from "../src/mastra/routes/consultantRoutes";
import { QMS_CONSULTANT_PROMPT_VERSION } from "../src/mastra/agents/qmsConsultantAgent";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext, type FakeContext } from "./_helpers/fakeContext";

const { Pool } = pg;
const HAS_DB = !!process.env.DATABASE_URL;
// Long-enough random key — getSessionUser/hasValidAdminApiKey only check
// equality with ADMIN_API_KEY, so any opaque value works for the test
// session. Mirrors the ADMIN_KEY used by tests/aiOpsRoutes.test.ts.
const ADMIN_KEY = "integration-test-consultant-feedback-2026";

const suite = new TestSuite("consultantRoutes");

console.log("\n=== consultantRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of consultantRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  suite.expect(consultantRoutes.length >= 3, "at least 3 routes registered");
});

const apiRoutes = consultantRoutes.filter((r) => r.path.startsWith("/api/"));
suite.expect(apiRoutes.length > 0, "filter yields at least one API route");

for (const route of apiRoutes) {
  const path = route.path;
  const method = route.method as string;
  await suite.test(`${method} ${path} — 403 without consultant role`, async () => {
    const handler = await buildHandler(consultantRoutes, path, method);
    const ctx = makeContext({
      method,
      params: { id: "1", alertId: "1" },
      body: ["POST", "PUT", "PATCH"].includes(method) ? {} : undefined,
    }) as FakeContext & { html?: any };
    ctx.html = (body: string, status?: number) => ({ status: status ?? 200, body, headers: {} });
    const res = await handler(ctx);
    suite.expectEqual(res.status, 403, "status");
    suite.expect(typeof res.body?.error === "string", "body.error is string");
  });
}

// ---------------------------------------------------------------------------
// Happy-path metadata persistence (Task #590).
//
// The helper-level test in src/utils/__tests__/aiFeedbackMetadata.test.ts
// already covers buildAiCallFeedbackMetadata in isolation, but it cannot
// detect a regression in the route handler itself — for example, if a
// future refactor drops the body destructuring of `promptVersion` /
// `ratingSource` / `clientSurface`, or stops echoing the prompt version on
// the chat stream's `done` frame. These tests exercise the real HTTP
// handler against a live `ai_response_feedback` row to lock in that the
// JSONB metadata column is actually populated end-to-end.
//
// Auth: we reuse the X-Admin-Key path the other tests use. Both
// getSessionUser() and hasValidAdminApiKey() are satisfied by setting
// ADMIN_API_KEY === the value sent in the X-Admin-Key header, which gives
// us a synthetic admin SessionUser without depending on platform_users
// rows being seeded in the test DB.
// ---------------------------------------------------------------------------
if (!HAS_DB) {
  console.log("\n(skipping happy-path feedback metadata tests — DATABASE_URL not set)\n");
} else {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const seededMessageIds: string[] = [];

  const fetchMetadata = async (messageId: string): Promise<Record<string, unknown> | null> => {
    const res = await pool.query(
      `SELECT metadata FROM ai_response_feedback WHERE message_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [messageId],
    );
    if (!res.rows[0]) return null;
    // pg returns JSONB as a parsed object already, but tolerate string too.
    const raw = res.rows[0].metadata;
    if (typeof raw === "string") return JSON.parse(raw) as Record<string, unknown>;
    return (raw ?? null) as Record<string, unknown> | null;
  };

  const postFeedback = async (body: Record<string, unknown>) => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    try {
      const handler = await buildHandler(
        consultantRoutes,
        "/api/consultant/feedback",
        "POST",
      );
      const ctx = makeContext({
        method: "POST",
        headers: { "X-Admin-Key": ADMIN_KEY },
        body,
      });
      return await handler(ctx);
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
    }
  };

  await suite.test(
    "POST /api/consultant/feedback — persists client-supplied promptVersion / ratingSource / clientSurface in metadata JSONB",
    async () => {
      const messageId = `consultant-md-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      seededMessageIds.push(messageId);
      const clientPromptVersion = "qms-consultant@feedbacktest";
      const clientRatingSource = "detail_modal";
      const clientSurface = "mobile";

      const res = await postFeedback({
        messageId,
        rating: "up",
        promptVersion: clientPromptVersion,
        ratingSource: clientRatingSource,
        clientSurface,
      });

      suite.expectEqual(res.status, 200, "status");
      suite.expectEqual(res.body?.success, true, "body.success");
      suite.expect(typeof res.body?.id === "number" && res.body.id > 0, "body.id is positive integer");

      const metadata = await fetchMetadata(messageId);
      suite.expect(metadata !== null, "row was inserted into ai_response_feedback");
      suite.expectEqual(
        metadata?.prompt_version as string | undefined,
        clientPromptVersion,
        "metadata.prompt_version reflects client-supplied value",
      );
      suite.expectEqual(
        metadata?.rating_source as string | undefined,
        clientRatingSource,
        "metadata.rating_source reflects client-supplied value",
      );
      suite.expectEqual(
        metadata?.client_surface as string | undefined,
        clientSurface,
        "metadata.client_surface reflects client-supplied value",
      );
    },
  );

  await suite.test(
    "POST /api/consultant/feedback — falls back to server-side QMS_CONSULTANT_PROMPT_VERSION when client omits the field (older clients keep working)",
    async () => {
      const messageId = `consultant-md-fallback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      seededMessageIds.push(messageId);

      // Intentionally omit promptVersion / ratingSource / clientSurface to
      // simulate an older client that hasn't been updated to echo back the
      // turn-specific prompt revision yet. The route should still write a
      // populated metadata row using the server-side defaults.
      const res = await postFeedback({
        messageId,
        rating: "down",
        category: "incorrect",
      });

      suite.expectEqual(res.status, 200, "status");
      suite.expectEqual(res.body?.success, true, "body.success");

      const metadata = await fetchMetadata(messageId);
      suite.expect(metadata !== null, "row was inserted into ai_response_feedback");
      suite.expectEqual(
        metadata?.prompt_version as string | undefined,
        QMS_CONSULTANT_PROMPT_VERSION,
        "metadata.prompt_version falls back to QMS_CONSULTANT_PROMPT_VERSION",
      );
      // Defaults defined in consultantRoutes.ts at the feedback handler.
      suite.expectEqual(
        metadata?.rating_source as string | undefined,
        "inline_thumbs",
        "metadata.rating_source falls back to 'inline_thumbs'",
      );
      suite.expectEqual(
        metadata?.client_surface as string | undefined,
        "web",
        "metadata.client_surface falls back to 'web'",
      );
    },
  );

  await suite.test(
    "POST /api/consultant/feedback — empty/whitespace-only client values still trigger the server-side fallback",
    async () => {
      const messageId = `consultant-md-empty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      seededMessageIds.push(messageId);

      // safeMetaString trims and drops empty strings so a buggy client
      // that sends "" / "   " can't blank out the analytics column. Lock
      // that in: the row should still carry the server-side defaults.
      const res = await postFeedback({
        messageId,
        rating: "up",
        promptVersion: "   ",
        ratingSource: "",
        clientSurface: "   ",
      });

      suite.expectEqual(res.status, 200, "status");
      const metadata = await fetchMetadata(messageId);
      suite.expect(metadata !== null, "row was inserted into ai_response_feedback");
      suite.expectEqual(
        metadata?.prompt_version as string | undefined,
        QMS_CONSULTANT_PROMPT_VERSION,
        "blank promptVersion falls back to QMS_CONSULTANT_PROMPT_VERSION",
      );
      suite.expectEqual(
        metadata?.rating_source as string | undefined,
        "inline_thumbs",
        "blank ratingSource falls back to 'inline_thumbs'",
      );
      suite.expectEqual(
        metadata?.client_surface as string | undefined,
        "web",
        "blank clientSurface falls back to 'web'",
      );
    },
  );

  // ---------------------------------------------------------------------
  // Task #661: feedback stats endpoint surfaces per-prompt-version
  // breakdown, and the recent-thumbs-down list hoists prompt_version /
  // rating_source / client_surface out of the metadata JSONB so the AI
  // Ops dashboard can render badges without re-implementing the JSONB
  // shape on the frontend.
  //
  // Locks in three regressions the typed FeedbackStats / RecentThumbsDown
  // shapes don't catch on their own:
  //   1. A future SQL refactor of getFeedbackStats might drop the
  //      `prompt_versions` aggregate, leaving the dashboard table empty
  //      with no test failure.
  //   2. A future SQL refactor of getRecentThumbsDown might stop
  //      projecting the metadata fields, silently breaking the badges.
  //   3. The JSONB->>'prompt_version' coalesce-to-'unknown' branch is
  //      easy to drop accidentally; without it, legacy rows where
  //      metadata is `{}` would silently disappear from the breakdown
  //      and the dashboard totals would no longer add up.
  // ---------------------------------------------------------------------
  await suite.test(
    "GET /api/consultant/feedback/stats — returns per-prompt-version breakdown including 'unknown' bucket for legacy rows",
    async () => {
      // Seed three rows: two on prompt revision A (one up, one down) and
      // one on prompt revision B (up). The 'down' on A should make A's
      // ratio 50%, while B should be 100%.
      //
      // Use plain alphabetic labels (no high-entropy hex tail) so the
      // wrapPoolForRedaction guard doesn't mistake the synthetic test
      // value for a credential and replace it with `***REDACTED***`
      // mid-write — that would silently break the per-version assertions
      // below. Mirrors the wording used by the upstream
      // `clientPromptVersion = "qms-consultant@feedbacktest"` happy-path
      // test that already exercises the same redaction path.
      const versionA = "qms-consultant@taskaprompt";
      const versionB = "qms-consultant@taskbprompt";
      const ids = [
        `consultant-stats-A-up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        `consultant-stats-A-down-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        `consultant-stats-B-up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        `consultant-stats-legacy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ];
      seededMessageIds.push(...ids);

      await postFeedback({ messageId: ids[0], rating: "up", promptVersion: versionA });
      await postFeedback({ messageId: ids[1], rating: "down", promptVersion: versionA });
      await postFeedback({ messageId: ids[2], rating: "up", promptVersion: versionB });
      // Legacy row: insert directly so metadata stays `{}`. The route
      // would normally fall back to the server-side prompt version (see
      // the "older clients keep working" test above), so we bypass it
      // here to simulate a row written before Task #590 was deployed.
      await pool.query(
        `INSERT INTO ai_response_feedback (message_id, agent, rating, metadata)
         VALUES ($1, 'qmsConsultantAgent', 'down', '{}'::jsonb)`,
        [ids[3]],
      );

      const original = process.env.ADMIN_API_KEY;
      process.env.ADMIN_API_KEY = ADMIN_KEY;
      let res;
      try {
        const handler = await buildHandler(
          consultantRoutes,
          "/api/consultant/feedback/stats",
          "GET",
        );
        const ctx = makeContext({
          method: "GET",
          headers: { "X-Admin-Key": ADMIN_KEY },
          query: { days: "30" },
        });
        res = await handler(ctx);
      } finally {
        if (original === undefined) delete process.env.ADMIN_API_KEY;
        else process.env.ADMIN_API_KEY = original;
      }

      suite.expectEqual(res.status, 200, "status");
      const versions = res.body?.stats?.prompt_versions;
      suite.expect(Array.isArray(versions), "stats.prompt_versions is an array");

      const findRow = (label: string) =>
        Array.isArray(versions)
          ? versions.find((v: any) => v.prompt_version === label)
          : undefined;
      const rowA = findRow(versionA);
      const rowB = findRow(versionB);
      const rowUnknown = findRow("unknown");

      suite.expect(!!rowA, `breakdown contains versionA (${versionA})`);
      suite.expect(!!rowB, `breakdown contains versionB (${versionB})`);
      suite.expect(!!rowUnknown, "breakdown contains the 'unknown' bucket for legacy rows");

      if (rowA) {
        suite.expectEqual(rowA.thumbs_up, 1, "versionA thumbs_up");
        suite.expectEqual(rowA.thumbs_down, 1, "versionA thumbs_down");
        suite.expectEqual(rowA.thumbs_up_ratio, 50, "versionA ratio rounds to 50%");
      }
      if (rowB) {
        suite.expectEqual(rowB.thumbs_up, 1, "versionB thumbs_up");
        suite.expectEqual(rowB.thumbs_up_ratio, 100, "versionB ratio is 100%");
      }
      if (rowUnknown) {
        suite.expect(
          (rowUnknown.thumbs_down ?? 0) >= 1,
          "'unknown' bucket counts the legacy row",
        );
      }
    },
  );

  await suite.test(
    "GET /api/consultant/feedback/stats — recent thumbs-down rows expose prompt_version / rating_source / client_surface for badges",
    async () => {
      // Seed a thumbs-down with a fully-populated metadata payload, plus
      // a legacy thumbs-down with empty metadata. Both must come back in
      // the `recent` array; only the first must carry the badge fields.
      // Plain alphabetic label so the secret-redaction wrapper doesn't
      // mistake it for a high-entropy credential — see the comment in
      // the per-prompt-version breakdown test above.
      const versionLabel = "qms-consultant@badgepromptlabel";
      const sourceLabel = "detail_modal";
      const surfaceLabel = "mobile";
      const messageIdRich = `consultant-recent-rich-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const messageIdLegacy = `consultant-recent-legacy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      seededMessageIds.push(messageIdRich, messageIdLegacy);

      await postFeedback({
        messageId: messageIdRich,
        rating: "down",
        category: "incorrect",
        promptVersion: versionLabel,
        ratingSource: sourceLabel,
        clientSurface: surfaceLabel,
      });
      await pool.query(
        `INSERT INTO ai_response_feedback (message_id, agent, rating, metadata)
         VALUES ($1, 'qmsConsultantAgent', 'down', '{}'::jsonb)`,
        [messageIdLegacy],
      );

      const original = process.env.ADMIN_API_KEY;
      process.env.ADMIN_API_KEY = ADMIN_KEY;
      let res;
      try {
        const handler = await buildHandler(
          consultantRoutes,
          "/api/consultant/feedback/stats",
          "GET",
        );
        const ctx = makeContext({
          method: "GET",
          headers: { "X-Admin-Key": ADMIN_KEY },
        });
        res = await handler(ctx);
      } finally {
        if (original === undefined) delete process.env.ADMIN_API_KEY;
        else process.env.ADMIN_API_KEY = original;
      }

      suite.expectEqual(res.status, 200, "status");
      const recent = res.body?.recent;
      suite.expect(Array.isArray(recent), "recent is an array");
      const rich = Array.isArray(recent)
        ? recent.find((r: any) => r.message_id === messageIdRich)
        : undefined;
      const legacy = Array.isArray(recent)
        ? recent.find((r: any) => r.message_id === messageIdLegacy)
        : undefined;

      suite.expect(!!rich, "recent contains the metadata-rich row");
      suite.expect(!!legacy, "recent still contains the legacy empty-metadata row");

      if (rich) {
        suite.expectEqual(rich.prompt_version, versionLabel, "rich.prompt_version");
        suite.expectEqual(rich.rating_source, sourceLabel, "rich.rating_source");
        suite.expectEqual(rich.client_surface, surfaceLabel, "rich.client_surface");
      }
      if (legacy) {
        // Empty `{}` metadata projects to JSON null; once the SQL TRIM/
        // NULLIF kicks in, we want it back as a real `null` so the
        // dashboard's `if (r.prompt_version)` guard hides the badge.
        suite.expectEqual(legacy.prompt_version, null, "legacy.prompt_version is null");
        suite.expectEqual(legacy.rating_source, null, "legacy.rating_source is null");
        suite.expectEqual(legacy.client_surface, null, "legacy.client_surface is null");
      }
    },
  );

  // Best-effort cleanup: remove the rows we seeded so the test doesn't
  // pollute the DB with synthetic feedback. Wrap in try/catch so a delete
  // failure doesn't mask the real test result.
  await suite.test("cleanup: delete seeded ai_response_feedback rows", async () => {
    try {
      if (seededMessageIds.length === 0) return;
      await pool.query(
        `DELETE FROM ai_response_feedback WHERE message_id = ANY($1::text[])`,
        [seededMessageIds],
      );
    } catch (err) {
      console.warn("[consultantRoutes test] cleanup failed:", err);
    } finally {
      // Release the pool so the test process can exit promptly without
      // waiting on idle pg workers (mirrors the pattern in
      // tests/_helpers/runner.ts's finishOrExit comments).
      await pool.end().catch(() => {});
    }
  });
}

suite.finishOrExit();
