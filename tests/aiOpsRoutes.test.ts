/**
 * Integration tests for src/mastra/routes/aiOpsRoutes.ts.
 *
 * Coverage matrix:
 *   - structural        → every route exposes path/method/createHandler.
 *   - 403 forbidden     → every route rejects unauthenticated callers
 *                         (admin/ai_specialist/grc_manager/head_of_operations_quality).
 *                         Includes the dedicated tool-health endpoints from Task #110:
 *                           GET  /api/ai-ops/tool-health-alerts
 *                           POST /api/ai-ops/alerts/:id/acknowledge
 *                           POST /api/ai-ops/alerts/:id/resolve
 *   - 400 bad input     → POST /api/ai-ops/alerts/:id/acknowledge with bad id
 *                         POST /api/ai-ops/alerts/:id/resolve with bad id
 *   - 200 happy path    → seed alert via createAIAlert, then exercise list,
 *                         acknowledge and resolve end-to-end (DATABASE_URL gated).
 *
 * Auth-boundary tests run without any DB (the auth check happens before the
 * dynamic DB import).
 *
 * Run:  npx tsx tests/aiOpsRoutes.test.ts
 */

import { aiOpsRoutes } from "../src/mastra/routes/aiOpsRoutes";
import { TestSuite } from "./_helpers/runner";
import { buildHandler, makeContext, type FakeContext } from "./_helpers/fakeContext";

const suite = new TestSuite("aiOpsRoutes");
const ADMIN_KEY = "integration-test-ai-ops-2026";
const HAS_DB = !!process.env.DATABASE_URL;

console.log("\n=== aiOpsRoutes integration tests ===\n");

await suite.test("every route exposes path, method and createHandler", async () => {
  for (const r of aiOpsRoutes) {
    suite.expect(typeof r.path === "string" && r.path.length > 0, `path missing: ${JSON.stringify(r)}`);
    suite.expect(typeof r.method === "string" && r.method.length > 0, `method missing on ${r.path}`);
    suite.expect(typeof r.createHandler === "function", `createHandler missing on ${r.method} ${r.path}`);
  }
  // Sanity: confirm the new tool-health endpoints are wired in.
  const paths = aiOpsRoutes.map((r) => `${r.method} ${r.path}`);
  suite.expect(paths.includes("GET /api/ai-ops/tool-health-alerts"), "tool-health-alerts route registered");
  suite.expect(paths.includes("GET /api/ai-ops/tool-health-alerts/trend"), "tool-health-alerts trend route registered");
  suite.expect(paths.includes("POST /api/ai-ops/alerts/:id/acknowledge"), "acknowledge route registered");
  suite.expect(paths.includes("POST /api/ai-ops/alerts/:id/resolve"), "resolve route registered");
  suite.expect(aiOpsRoutes.length >= 1, "at least 1 route registered");
});

// ---------------------------------------------------------------------------
// Generic 403 sweep — every non-html route refuses unauthenticated callers.
// ---------------------------------------------------------------------------
for (const route of aiOpsRoutes) {
  const path = route.path;
  const method = route.method as string;
  if (path === "/ai-ops") continue; // html handler — assert separately.
  await suite.test(`${method} ${path} — 403 without an AI-ops role`, async () => {
    const handler = await buildHandler(aiOpsRoutes, path, method);
    const ctx = makeContext({
      method,
      params: { id: "1", agentId: "1", callId: "1" },
      body: ["POST", "PUT", "PATCH"].includes(method) ? {} : undefined,
    });
    const res = await handler(ctx);
    suite.expectEqual(res.status, 403, "status");
    suite.expectEqual(res.body?.error, "Insufficient permissions", "body.error");
  });
}

await suite.test("GET /ai-ops — 403 without an AI-ops role (html route also gated)", async () => {
  const handler = await buildHandler(aiOpsRoutes, "/ai-ops", "GET");
  const ctx = makeContext({ method: "GET" }) as FakeContext & { html?: any };
  ctx.html = (body: string, status?: number) => ({ status: status ?? 200, body, headers: {} });
  const res = await handler(ctx);
  suite.expectEqual(res.status, 403, "status");
  suite.expectEqual(res.body?.error, "Insufficient permissions", "body.error");
});

// ---------------------------------------------------------------------------
// Bad-input tests for the Task #110 alert endpoints (with admin key).
// ---------------------------------------------------------------------------
await suite.test("POST /api/ai-ops/alerts/:id/acknowledge — 400 on non-numeric id (with admin key)", async () => {
  const original = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  try {
    const handler = await buildHandler(aiOpsRoutes, "/api/ai-ops/alerts/:id/acknowledge", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        headers: { "X-Admin-Key": ADMIN_KEY },
        params: { id: "not-a-number" },
      }),
    );
    suite.expectEqual(res.status, 400, "status");
    suite.expectEqual(res.body?.error, "Invalid alert id", "body.error");
  } finally {
    if (original === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = original;
  }
});

await suite.test("POST /api/ai-ops/alerts/:id/resolve — 400 on zero id (with admin key)", async () => {
  const original = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  try {
    const handler = await buildHandler(aiOpsRoutes, "/api/ai-ops/alerts/:id/resolve", "POST");
    const res = await handler(
      makeContext({
        method: "POST",
        headers: { "X-Admin-Key": ADMIN_KEY },
        params: { id: "0" },
      }),
    );
    suite.expectEqual(res.status, 400, "status");
    suite.expectEqual(res.body?.error, "Invalid alert id", "body.error");
  } finally {
    if (original === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = original;
  }
});

// ---------------------------------------------------------------------------
// Happy-path data integration tests (require DATABASE_URL).
// These insert a real alert via createAIAlert, exercise the route end-to-end
// against the running Postgres, and clean up by resolving the alert.
// ---------------------------------------------------------------------------
if (!HAS_DB) {
  console.log("\n(skipping happy-path DB tests — DATABASE_URL not set)\n");
} else {
  const { createAIAlert, resolveAlert, getAIAlerts } = await import(
    "../src/utils/aiAlertsDatabase"
  );

  const TOOL_NAME = `test_route_tool_${Date.now()}`;
  const REASON = "error_rate";
  const RELATED_ID = `${TOOL_NAME}:${REASON}`;
  let createdId: number | null = null;

  await suite.test("happy: GET /api/ai-ops/tool-health-alerts returns the seeded alert with parsed fields", async () => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    try {
      const created = await createAIAlert({
        alert_type: "tool_health",
        severity: "high",
        title: `Tool "${TOOL_NAME}" error rate above threshold over last 60 min`,
        description: "Test seed for happy-path route test",
        suggestion: "Investigate the tool",
        related_record_type: "tool_health",
        related_record_id: RELATED_ID,
        metadata: { tool_name: TOOL_NAME, reason: REASON },
      });
      createdId = created.id;

      const handler = await buildHandler(
        aiOpsRoutes,
        "/api/ai-ops/tool-health-alerts",
        "GET",
      );
      const res = await handler(
        makeContext({ method: "GET", headers: { "X-Admin-Key": ADMIN_KEY } }),
      );
      suite.expectEqual(res.status, 200, "status");
      const list: any[] = res.body?.data ?? [];
      const found = list.find((a) => a.id === createdId);
      suite.expect(!!found, "seeded alert is in response");
      suite.expectEqual(found.tool_name, TOOL_NAME, "parsed tool_name");
      suite.expectEqual(found.reason, REASON, "parsed reason");
      suite.expectEqual(found.status, "open", "status filter only returns open");
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
    }
  });

  await suite.test("happy: POST /api/ai-ops/alerts/:id/acknowledge transitions status to acknowledged", async () => {
    if (createdId == null) throw new Error("seed alert was not created");
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    try {
      const handler = await buildHandler(
        aiOpsRoutes,
        "/api/ai-ops/alerts/:id/acknowledge",
        "POST",
      );
      const res = await handler(
        makeContext({
          method: "POST",
          headers: { "X-Admin-Key": ADMIN_KEY },
          params: { id: String(createdId) },
        }),
      );
      suite.expectEqual(res.status, 200, "status");
      suite.expect(res.body?.success === true, "success=true");
      suite.expectEqual(res.body?.alert?.id, createdId, "echoes alert id");
      suite.expectEqual(res.body?.alert?.status, "acknowledged", "status flipped");

      // After ack, the alert should no longer appear in the open-only listing.
      const listed = await getAIAlerts({ alert_type: "tool_health", status: "open" });
      const stillThere = listed.alerts.find((a) => a.id === createdId);
      suite.expect(!stillThere, "acknowledged alert no longer in open list");
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
    }
  });

  await suite.test("happy: GET /api/ai-ops/tool-health-alerts/trend returns padded buckets and overall stats", async () => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    try {
      const handler = await buildHandler(
        aiOpsRoutes,
        "/api/ai-ops/tool-health-alerts/trend",
        "GET",
      );
      const res = await handler(
        makeContext({
          method: "GET",
          headers: { "X-Admin-Key": ADMIN_KEY },
          query: { days: "14" },
        }),
      );
      suite.expectEqual(res.status, 200, "status");
      const trend = res.body?.data;
      suite.expect(trend && typeof trend === "object", "data is an object");
      suite.expectEqual(trend.days, 14, "echoes days param");
      suite.expect(Array.isArray(trend.buckets), "buckets is an array");
      // generate_series(today-13, today, 1 day) → exactly 14 rows.
      suite.expectEqual(trend.buckets.length, 14, "buckets are fully padded");
      // Every bucket must expose all severity counters + total + ttr field.
      for (const b of trend.buckets) {
        suite.expect(typeof b.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.day), "bucket day is YYYY-MM-DD");
        for (const k of ["critical", "high", "medium", "low", "info", "total"]) {
          suite.expect(typeof b[k] === "number" && b[k] >= 0, `bucket.${k} is a non-negative number`);
        }
        suite.expect(
          b.median_ttr_seconds === null || (typeof b.median_ttr_seconds === "number" && b.median_ttr_seconds >= 0),
          "median_ttr_seconds is null or non-negative number",
        );
      }
      // Buckets must be in ascending date order so the chart x-axis renders correctly.
      for (let i = 1; i < trend.buckets.length; i++) {
        suite.expect(trend.buckets[i - 1].day <= trend.buckets[i].day, "buckets in ascending date order");
      }
      const overall = trend.overall;
      suite.expect(overall && typeof overall === "object", "overall is an object");
      for (const k of ["total_fired", "total_resolved"]) {
        suite.expect(typeof overall[k] === "number" && overall[k] >= 0, `overall.${k} non-negative number`);
      }
      // The seeded alert from the previous tests should be inside the
      // 14-day window, so total_fired must reflect at least one row.
      suite.expect(overall.total_fired >= 1, "overall.total_fired counts the seeded alert");
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
    }
  });

  await suite.test("happy: POST /api/ai-ops/alerts/:id/resolve transitions status to resolved", async () => {
    if (createdId == null) throw new Error("seed alert was not created");
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    try {
      const handler = await buildHandler(
        aiOpsRoutes,
        "/api/ai-ops/alerts/:id/resolve",
        "POST",
      );
      const res = await handler(
        makeContext({
          method: "POST",
          headers: { "X-Admin-Key": ADMIN_KEY },
          params: { id: String(createdId) },
        }),
      );
      suite.expectEqual(res.status, 200, "status");
      suite.expect(res.body?.success === true, "success=true");
      suite.expectEqual(res.body?.alert?.id, createdId, "echoes alert id");
      suite.expectEqual(res.body?.alert?.status, "resolved", "status flipped");
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
      // Ensure cleanup even if the assertion above failed.
      if (createdId != null) {
        try {
          await resolveAlert(createdId, "happy-path-test", "cleanup");
        } catch {
          /* best-effort */
        }
      }
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Tool-health alert history severity filter (Task #319)
  //
  // Seeds two acknowledged tool-health alerts of different severities
  // (high + medium), then verifies that:
  //   - omitting `severity` returns both rows
  //   - `severity=high` returns only the high one
  //   - `severity=medium` returns only the medium one
  //   - an unknown / "all" severity falls through to the unfiltered query
  //   - the response shape includes the resolved `severity` field
  // ─────────────────────────────────────────────────────────────────────────
  const HISTORY_SUFFIX = `${Date.now()}`;
  const HIGH_TOOL    = `test_history_high_${HISTORY_SUFFIX}`;
  const MEDIUM_TOOL  = `test_history_medium_${HISTORY_SUFFIX}`;
  let highId: number | null = null;
  let mediumId: number | null = null;

  await suite.test("happy: GET /api/ai-ops/tool-health-alerts/history filters by severity", async () => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    const { acknowledgeAlert } = await import("../src/utils/aiAlertsDatabase");
    try {
      // Seed two alerts with distinct severities, then acknowledge each so
      // they show up in the triage-history listing.
      const high = await createAIAlert({
        alert_type: "tool_health",
        severity: "high",
        title: `History test HIGH ${HIGH_TOOL}`,
        description: "Task #319 history-filter test seed",
        suggestion: "n/a",
        related_record_type: "tool_health",
        related_record_id: `${HIGH_TOOL}:error_rate`,
        metadata: { tool_name: HIGH_TOOL, reason: "error_rate" },
      });
      highId = high.id;
      await acknowledgeAlert(highId, "history-filter-test");

      const medium = await createAIAlert({
        alert_type: "tool_health",
        severity: "medium",
        title: `History test MEDIUM ${MEDIUM_TOOL}`,
        description: "Task #319 history-filter test seed",
        suggestion: "n/a",
        related_record_type: "tool_health",
        related_record_id: `${MEDIUM_TOOL}:p95_latency`,
        metadata: { tool_name: MEDIUM_TOOL, reason: "p95_latency" },
      });
      mediumId = medium.id;
      await acknowledgeAlert(mediumId, "history-filter-test");

      const handler = await buildHandler(
        aiOpsRoutes,
        "/api/ai-ops/tool-health-alerts/history",
        "GET",
      );

      // 1. No severity → both seeded alerts are returned.
      const noFilter = await handler(
        makeContext({
          method: "GET",
          headers: { "X-Admin-Key": ADMIN_KEY },
          query: { days: "1", limit: "100" },
        }),
      );
      suite.expectEqual(noFilter.status, 200, "no-filter status");
      suite.expectEqual(noFilter.body?.severity, null, "no-filter severity echoed as null");
      const noFilterIds = (noFilter.body?.data ?? []).map((a: any) => a.id);
      suite.expect(noFilterIds.includes(highId), "no-filter contains high seed");
      suite.expect(noFilterIds.includes(mediumId), "no-filter contains medium seed");

      // 2. severity=high → only the high seed comes back.
      const highOnly = await handler(
        makeContext({
          method: "GET",
          headers: { "X-Admin-Key": ADMIN_KEY },
          query: { days: "1", limit: "100", severity: "high" },
        }),
      );
      suite.expectEqual(highOnly.status, 200, "high-only status");
      suite.expectEqual(highOnly.body?.severity, "high", "high-only severity echoed");
      const highOnlyRows = (highOnly.body?.data ?? []) as any[];
      suite.expect(
        highOnlyRows.every((a) => a.severity === "high"),
        "high-only rows are all severity=high",
      );
      suite.expect(highOnlyRows.some((a) => a.id === highId), "high-only contains high seed");
      suite.expect(!highOnlyRows.some((a) => a.id === mediumId), "high-only excludes medium seed");

      // 3. severity=medium → only the medium seed comes back.
      const mediumOnly = await handler(
        makeContext({
          method: "GET",
          headers: { "X-Admin-Key": ADMIN_KEY },
          query: { days: "1", limit: "100", severity: "medium" },
        }),
      );
      suite.expectEqual(mediumOnly.status, 200, "medium-only status");
      const mediumOnlyRows = (mediumOnly.body?.data ?? []) as any[];
      suite.expect(
        mediumOnlyRows.every((a) => a.severity === "medium"),
        "medium-only rows are all severity=medium",
      );
      suite.expect(mediumOnlyRows.some((a) => a.id === mediumId), "medium-only contains medium seed");
      suite.expect(!mediumOnlyRows.some((a) => a.id === highId), "medium-only excludes high seed");

      // 4. Unknown severity ("all" / garbage) falls through to unfiltered.
      const allFallback = await handler(
        makeContext({
          method: "GET",
          headers: { "X-Admin-Key": ADMIN_KEY },
          query: { days: "1", limit: "100", severity: "all" },
        }),
      );
      suite.expectEqual(allFallback.status, 200, "fallback status");
      suite.expectEqual(allFallback.body?.severity, null, "unknown severity echoed as null");
      const fallbackIds = (allFallback.body?.data ?? []).map((a: any) => a.id);
      suite.expect(fallbackIds.includes(highId), "fallback contains high seed");
      suite.expect(fallbackIds.includes(mediumId), "fallback contains medium seed");
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
      // Clean up the two seeded alerts so the dev DB doesn't accumulate
      // test rows across reruns.
      for (const id of [highId, mediumId]) {
        if (id != null) {
          try { await resolveAlert(id, "history-filter-test", "cleanup"); }
          catch { /* best-effort */ }
        }
      }
    }
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Tool-health threshold tuning endpoints (Task #177)
//
// The structural / 403 / 400 boundary tests run without a live DB — those
// checks fire before the lazy `await import(toolHealthConfigDatabase)`. The
// happy-path PUT/GET tests are gated on HAS_DB so CI can still smoke them.
// ───────────────────────────────────────────────────────────────────────────

await suite.test("threshold routes are wired into aiOpsRoutes", async () => {
  const paths = aiOpsRoutes.map((r) => `${r.method} ${r.path}`);
  suite.expect(
    paths.includes("GET /api/ai-ops/tool-health-config"),
    "GET tool-health-config registered",
  );
  suite.expect(
    paths.includes("PUT /api/ai-ops/tool-health-config"),
    "PUT tool-health-config registered",
  );
  suite.expect(
    paths.includes("GET /api/ai-ops/tool-health-config/audit"),
    "GET tool-health-config/audit registered",
  );
});

await suite.test("GET /api/ai-ops/tool-health-config — 403 without auth", async () => {
  const original = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  try {
    const handler = await buildHandler(
      aiOpsRoutes,
      "/api/ai-ops/tool-health-config",
      "GET",
    );
    const res = await handler(makeContext({ method: "GET" }));
    suite.expectEqual(res.status, 403, "status");
    suite.expectEqual(res.body?.error, "Insufficient permissions", "body.error");
  } finally {
    if (original === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = original;
  }
});

await suite.test("PUT /api/ai-ops/tool-health-config — 403 without admin", async () => {
  const original = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  try {
    const handler = await buildHandler(
      aiOpsRoutes,
      "/api/ai-ops/tool-health-config",
      "PUT",
    );
    // Pass no key at all — the requireRole gate fires before we reach
    // the JSON body parser, so we never need a body to assert 403.
    const res = await handler(
      makeContext({ method: "PUT", body: { overrides: {} } }),
    );
    suite.expectEqual(res.status, 403, "status");
    suite.expectEqual(res.body?.error, "Insufficient permissions", "body.error");
  } finally {
    if (original === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = original;
  }
});

await suite.test("PUT /api/ai-ops/tool-health-config — 400 when body is not an object", async () => {
  const original = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  try {
    const handler = await buildHandler(
      aiOpsRoutes,
      "/api/ai-ops/tool-health-config",
      "PUT",
    );
    const res = await handler(
      makeContext({
        method: "PUT",
        headers: { "X-Admin-Key": ADMIN_KEY },
        body: "not-an-object",
      }),
    );
    suite.expectEqual(res.status, 400, "status");
    suite.expect(
      typeof res.body?.error === "string" && res.body.error.length > 0,
      "error message present",
    );
  } finally {
    if (original === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = original;
  }
});

await suite.test("PUT /api/ai-ops/tool-health-config — 400 when overrides missing", async () => {
  const original = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  try {
    const handler = await buildHandler(
      aiOpsRoutes,
      "/api/ai-ops/tool-health-config",
      "PUT",
    );
    const res = await handler(
      makeContext({
        method: "PUT",
        headers: { "X-Admin-Key": ADMIN_KEY },
        body: { note: "no overrides field at all" },
      }),
    );
    suite.expectEqual(res.status, 400, "status");
    suite.expectEqual(res.body?.error, "overrides must be an object", "error");
  } finally {
    if (original === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = original;
  }
});

// ── Task #191: time-boxed override validation ────────────────────────────────
// These hit the validation gate (no DB write), so they're safe to run with or
// without a live DB. They cover the "is the wire format right?" contract that
// the dashboard depends on.

await suite.test(
  "PUT /api/ai-ops/tool-health-config — 400 when expires_at is not parseable",
  async () => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    try {
      const handler = await buildHandler(
        aiOpsRoutes,
        "/api/ai-ops/tool-health-config",
        "PUT",
      );
      const res = await handler(
        makeContext({
          method: "PUT",
          headers: { "X-Admin-Key": ADMIN_KEY },
          body: { overrides: {}, expires_at: "not-a-date" },
        }),
      );
      suite.expectEqual(res.status, 400, "status");
      suite.expect(
        typeof res.body?.error === "string"
          && res.body.error.toLowerCase().includes("expires_at"),
        "error mentions expires_at",
      );
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
    }
  },
);

await suite.test(
  "PUT /api/ai-ops/tool-health-config — 400 when expires_at is in the past",
  async () => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    try {
      const handler = await buildHandler(
        aiOpsRoutes,
        "/api/ai-ops/tool-health-config",
        "PUT",
      );
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const res = await handler(
        makeContext({
          method: "PUT",
          headers: { "X-Admin-Key": ADMIN_KEY },
          body: { overrides: {}, expires_at: yesterday },
        }),
      );
      suite.expectEqual(res.status, 400, "status");
      suite.expect(
        typeof res.body?.error === "string"
          && res.body.error.toLowerCase().includes("future"),
        "error mentions future requirement",
      );
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
    }
  },
);

await suite.test(
  "PUT /api/ai-ops/tool-health-config — 400 when expires_at exceeds 30-day horizon",
  async () => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    try {
      const handler = await buildHandler(
        aiOpsRoutes,
        "/api/ai-ops/tool-health-config",
        "PUT",
      );
      // 60 days out → well past the 30-day cap.
      const tooFar = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
      const res = await handler(
        makeContext({
          method: "PUT",
          headers: { "X-Admin-Key": ADMIN_KEY },
          body: { overrides: {}, expires_at: tooFar },
        }),
      );
      suite.expectEqual(res.status, 400, "status");
      suite.expect(
        typeof res.body?.error === "string"
          && /at most.*days/i.test(res.body.error),
        "error mentions max horizon",
      );
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
    }
  },
);

await suite.test("GET /api/ai-ops/tool-health-config/audit — 403 without auth", async () => {
  const original = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  try {
    const handler = await buildHandler(
      aiOpsRoutes,
      "/api/ai-ops/tool-health-config/audit",
      "GET",
    );
    const res = await handler(makeContext({ method: "GET" }));
    suite.expectEqual(res.status, 403, "status");
    suite.expectEqual(res.body?.error, "Insufficient permissions", "body.error");
  } finally {
    if (original === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = original;
  }
});

if (HAS_DB) {
  // Happy-path coverage: a full read → write → read cycle that proves the
  // PUT actually persists, the GET reflects the merged result, and the
  // audit log captures the change. Cleans up after itself by clearing all
  // overrides at the end so the live DB row is left in a known-good state.
  await suite.test("happy: GET → PUT → GET round-trips an override and writes audit row", async () => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    try {
      const getHandler = await buildHandler(
        aiOpsRoutes,
        "/api/ai-ops/tool-health-config",
        "GET",
      );
      const putHandler = await buildHandler(
        aiOpsRoutes,
        "/api/ai-ops/tool-health-config",
        "PUT",
      );

      // Snapshot the env baseline so we can pick override values that are
      // (a) within bounds and (b) safely satisfy the cross-field invariants.
      const initial = await getHandler(
        makeContext({ method: "GET", headers: { "X-Admin-Key": ADMIN_KEY } }),
      );
      suite.expectEqual(initial.status, 200, "initial GET status");
      const baseline = initial.body?.data?.env_baseline;
      suite.expect(baseline && typeof baseline === "object", "env_baseline present");

      // Pick safe values that satisfy: floor <= high < critical for both bands.
      const patch = {
        windowMinutes: 15,
        minCalls: 10,
        errorRatePct: 5,
        errorRateHighPct: 20,
        errorRateCriticalPct: 80,
        p95LatencyMs: 500,
        latencyHighMs: 2000,
        latencyCriticalMs: 8000,
      };

      const putRes = await putHandler(
        makeContext({
          method: "PUT",
          headers: { "X-Admin-Key": ADMIN_KEY },
          body: { overrides: patch, note: "integration test #177" },
        }),
      );
      suite.expectEqual(putRes.status, 200, "PUT status");
      suite.expect(putRes.body?.success === true, "success flag");
      suite.expectEqual(
        putRes.body?.effective?.errorRateHighPct,
        20,
        "effective reflects new override",
      );
      suite.expect(
        typeof putRes.body?.audit_id === "number" && putRes.body.audit_id > 0,
        "audit_id returned",
      );

      // Re-GET and assert the override is now visible alongside the audit row.
      const reread = await getHandler(
        makeContext({ method: "GET", headers: { "X-Admin-Key": ADMIN_KEY } }),
      );
      suite.expectEqual(reread.status, 200, "re-read status");
      suite.expectEqual(
        reread.body?.data?.overrides?.errorRateHighPct,
        20,
        "override persisted",
      );
      suite.expect(
        Array.isArray(reread.body?.data?.audit) && reread.body.data.audit.length > 0,
        "audit log non-empty",
      );
      const last = reread.body.data.audit[0];
      suite.expectEqual(last?.note, "integration test #177", "note round-trips");
      suite.expectEqual(
        last?.after_values?.errorRateHighPct,
        20,
        "audit captured after-state",
      );
    } finally {
      // Cleanup: clear every override so the live DB returns to baseline.
      try {
        const putHandler = await buildHandler(
          aiOpsRoutes,
          "/api/ai-ops/tool-health-config",
          "PUT",
        );
        await putHandler(
          makeContext({
            method: "PUT",
            headers: { "X-Admin-Key": ADMIN_KEY },
            body: {
              overrides: {
                windowMinutes: null,
                minCalls: null,
                errorRatePct: null,
                errorRateHighPct: null,
                errorRateCriticalPct: null,
                p95LatencyMs: null,
                latencyHighMs: null,
                latencyCriticalMs: null,
              },
              note: "integration test #177 cleanup",
            },
          }),
        );
      } catch {
        /* best-effort cleanup */
      }
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
    }
  });

  await suite.test(
    "PUT /api/ai-ops/tool-health-config — TOOL_HEALTH_CONFIG_NOTIFY=1 still saves successfully when Slack send fails",
    // Regression guard for Task #190: the notifier hook is best-effort.
    // When the env gate is on but Slack is misconfigured (no bot token,
    // unreachable channel), the threshold save MUST still return 200 and
    // persist the override. We exercise the real notify path (no stub) so
    // the route's try/catch wrapper is what's under test.
    async () => {
      const originalKey = process.env.ADMIN_API_KEY;
      const originalNotify = process.env.TOOL_HEALTH_CONFIG_NOTIFY;
      const originalChannel = process.env.TOOL_HEALTH_SLACK_CHANNEL;
      const originalToken = process.env.SLACK_BOT_TOKEN;
      const originalApiToken = process.env.SLACK_API_TOKEN;
      process.env.ADMIN_API_KEY = ADMIN_KEY;
      process.env.TOOL_HEALTH_CONFIG_NOTIFY = "1";
      process.env.TOOL_HEALTH_SLACK_CHANNEL = "C-NONEXISTENT";
      // Force the underlying Slack client to bail (no token → returns false,
      // no throw); proves the route still returns 200 either way.
      delete process.env.SLACK_BOT_TOKEN;
      delete process.env.SLACK_API_TOKEN;

      // Silence the expected "no bot token" log so the test output stays clean.
      const origLog = console.log;
      console.log = () => {};
      try {
        const putHandler = await buildHandler(
          aiOpsRoutes,
          "/api/ai-ops/tool-health-config",
          "PUT",
        );
        const res = await putHandler(
          makeContext({
            method: "PUT",
            headers: { "X-Admin-Key": ADMIN_KEY },
            body: { overrides: { windowMinutes: 30 }, note: "task-190 regression" },
          }),
        );
        suite.expectEqual(res.status, 200, "PUT still 200 when Slack send is a no-op");
        suite.expect(res.body?.success === true, "success flag still true");
        suite.expect(
          typeof res.body?.audit_id === "number" && res.body.audit_id > 0,
          "audit row still written",
        );
      } finally {
        console.log = origLog;
        // Cleanup: clear the override and restore env.
        try {
          const putHandler = await buildHandler(
            aiOpsRoutes,
            "/api/ai-ops/tool-health-config",
            "PUT",
          );
          await putHandler(
            makeContext({
              method: "PUT",
              headers: { "X-Admin-Key": ADMIN_KEY },
              body: {
                overrides: { windowMinutes: null },
                note: "task-190 regression cleanup",
              },
            }),
          );
        } catch { /* best-effort cleanup */ }
        if (originalKey === undefined) delete process.env.ADMIN_API_KEY;
        else process.env.ADMIN_API_KEY = originalKey;
        if (originalNotify === undefined) delete process.env.TOOL_HEALTH_CONFIG_NOTIFY;
        else process.env.TOOL_HEALTH_CONFIG_NOTIFY = originalNotify;
        if (originalChannel === undefined) delete process.env.TOOL_HEALTH_SLACK_CHANNEL;
        else process.env.TOOL_HEALTH_SLACK_CHANNEL = originalChannel;
        if (originalToken !== undefined) process.env.SLACK_BOT_TOKEN = originalToken;
        if (originalApiToken !== undefined) process.env.SLACK_API_TOKEN = originalApiToken;
      }
    },
  );

  await suite.test("POST /api/ai-ops/tool-health-config/preview — happy path returns current vs proposed breach lists", async () => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    try {
      const previewHandler = await buildHandler(
        aiOpsRoutes,
        "/api/ai-ops/tool-health-config/preview",
        "POST",
      );
      // Pick safe values that satisfy floor <= high < critical for both bands.
      const res = await previewHandler(
        makeContext({
          method: "POST",
          headers: { "X-Admin-Key": ADMIN_KEY },
          body: {
            overrides: {
              windowMinutes: 30,
              minCalls: 1,
              errorRatePct: 5,
              errorRateHighPct: 20,
              errorRateCriticalPct: 80,
              p95LatencyMs: 500,
              latencyHighMs: 2000,
              latencyCriticalMs: 8000,
            },
          },
        }),
      );
      suite.expectEqual(res.status, 200, "status");
      const data = res.body?.data;
      suite.expect(data && typeof data === "object", "data envelope present");
      suite.expectEqual(
        data?.effective_proposed?.errorRatePct,
        5,
        "proposed effective reflects override",
      );
      suite.expect(
        data?.effective_current && typeof data.effective_current === "object",
        "current effective present",
      );
      suite.expect(
        Array.isArray(data?.current?.breaches),
        "current.breaches array",
      );
      suite.expect(
        Array.isArray(data?.proposed?.breaches),
        "proposed.breaches array",
      );
      suite.expect(
        data?.current?.summary && typeof data.current.summary.total === "number",
        "current summary present",
      );
      suite.expect(
        data?.diff && Array.isArray(data.diff.new_breaches)
          && Array.isArray(data.diff.resolved_breaches)
          && Array.isArray(data.diff.severity_changes),
        "diff envelope present",
      );
      suite.expect(
        typeof data?.current?.tools_evaluated === "number"
          && typeof data?.proposed?.tools_evaluated === "number",
        "per-cfg tools_evaluated present",
      );
      suite.expectEqual(
        data?.current?.window_minutes,
        data?.effective_current?.windowMinutes,
        "current.window_minutes echoes effective_current",
      );
      suite.expectEqual(
        data?.proposed?.window_minutes,
        data?.effective_proposed?.windowMinutes,
        "proposed.window_minutes echoes effective_proposed",
      );
      // Same window submitted ⇒ window_minutes_changed must be false.
      suite.expectEqual(
        data?.window_minutes_changed,
        data?.current?.window_minutes !== data?.proposed?.window_minutes,
        "window_minutes_changed flag matches actual window difference",
      );
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
    }
  });

  // Reviewer-flagged correctness case (Task #189 follow-up): when current
  // and proposed windowMinutes differ, the endpoint MUST evaluate each cfg
  // against aggregates over its OWN exact horizon. A 30-min aggregate
  // cannot be derived from a 60-min one (or vice versa) since
  // getToolWindowAggregates(N) returns metrics pre-aggregated over exactly
  // N minutes. This test asserts the response surfaces that distinction.
  await suite.test("POST /api/ai-ops/tool-health-config/preview — differing windowMinutes yields per-cfg horizon", async () => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    try {
      // Read the current effective windowMinutes so we can deliberately
      // pick a DIFFERENT proposed window and force the two-query path.
      const getHandler = await buildHandler(
        aiOpsRoutes,
        "/api/ai-ops/tool-health-config",
        "GET",
      );
      const getRes = await getHandler(
        makeContext({ method: "GET", headers: { "X-Admin-Key": ADMIN_KEY } }),
      );
      suite.expectEqual(getRes.status, 200, "GET status");
      const currentWindow = getRes.body?.data?.effective?.windowMinutes;
      suite.expect(
        typeof currentWindow === "number" && currentWindow >= 5,
        "current windowMinutes available",
      );
      // Pick a deliberately-different proposed window inside the validator
      // bounds (5..1440). Adding 15 min lands well inside bounds for any
      // sane current window (cron defaults to 30 min in env).
      const proposedWindow = currentWindow === 30 ? 60 : 30;

      const previewHandler = await buildHandler(
        aiOpsRoutes,
        "/api/ai-ops/tool-health-config/preview",
        "POST",
      );
      const res = await previewHandler(
        makeContext({
          method: "POST",
          headers: { "X-Admin-Key": ADMIN_KEY },
          body: { overrides: { windowMinutes: proposedWindow } },
        }),
      );
      suite.expectEqual(res.status, 200, "preview status");
      const data = res.body?.data;
      suite.expectEqual(
        data?.window_minutes_changed,
        true,
        "window_minutes_changed flagged true when windows differ",
      );
      suite.expectEqual(
        data?.current?.window_minutes,
        currentWindow,
        "current.window_minutes equals current effective",
      );
      suite.expectEqual(
        data?.proposed?.window_minutes,
        proposedWindow,
        "proposed.window_minutes equals override",
      );
      suite.expect(
        typeof data?.current?.tools_evaluated === "number"
          && typeof data?.proposed?.tools_evaluated === "number",
        "each cfg gets its own tools_evaluated count from its own SQL hit",
      );
      // Both breach lists must be present and independently evaluated.
      suite.expect(
        Array.isArray(data?.current?.breaches)
          && Array.isArray(data?.proposed?.breaches),
        "both breach arrays present",
      );
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
    }
  });

  await suite.test("POST /api/ai-ops/tool-health-config/preview — 400 on band ordering violation", async () => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    try {
      const previewHandler = await buildHandler(
        aiOpsRoutes,
        "/api/ai-ops/tool-health-config/preview",
        "POST",
      );
      const res = await previewHandler(
        makeContext({
          method: "POST",
          headers: { "X-Admin-Key": ADMIN_KEY },
          body: {
            overrides: { errorRateHighPct: 90, errorRateCriticalPct: 90 },
          },
        }),
      );
      suite.expectEqual(res.status, 400, "status");
      suite.expect(
        typeof res.body?.error === "string"
          && res.body.error.includes("errorRateHighPct"),
        "error mentions field",
      );
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
    }
  });

  await suite.test("POST /api/ai-ops/tool-health-config/preview — 400 when overrides missing", async () => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    try {
      const previewHandler = await buildHandler(
        aiOpsRoutes,
        "/api/ai-ops/tool-health-config/preview",
        "POST",
      );
      const res = await previewHandler(
        makeContext({
          method: "POST",
          headers: { "X-Admin-Key": ADMIN_KEY },
          body: { note: "no overrides" },
        }),
      );
      suite.expectEqual(res.status, 400, "status");
      suite.expectEqual(res.body?.error, "overrides must be an object", "error");
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
    }
  });

  await suite.test("PUT /api/ai-ops/tool-health-config — 400 on band ordering violation", async () => {
    const original = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    try {
      const putHandler = await buildHandler(
        aiOpsRoutes,
        "/api/ai-ops/tool-health-config",
        "PUT",
      );
      // High >= critical → must be rejected with a clear 400.
      const res = await putHandler(
        makeContext({
          method: "PUT",
          headers: { "X-Admin-Key": ADMIN_KEY },
          body: {
            overrides: { errorRateHighPct: 90, errorRateCriticalPct: 90 },
          },
        }),
      );
      suite.expectEqual(res.status, 400, "status");
      suite.expect(
        typeof res.body?.error === "string"
          && res.body.error.includes("errorRateHighPct"),
        "error mentions field",
      );
    } finally {
      if (original === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = original;
    }
  });

  // ── Task #214: end-to-end auto-revert against a live Postgres ─────────────
  //
  // This is the only test in CI that exercises the full time-boxed override
  // path against real SQL: PUT an override with a sub-second expiry, wait
  // for it to pass, drive `runToolHealthCheck` directly (which calls the
  // real `reapExpiredToolHealthOverrides`), then re-GET and assert that
  //   • the GET response no longer carries the override (or expires_at),
  //   • the audit log has a fresh "system: override expired" row, and
  //   • the merged effective config has reverted to the env baseline.
  //
  // Without this check, an off-by-one in the reaper's `WHERE expires_at <= NOW()`
  // clause or a missing `FOR UPDATE` lock would slip past the existing
  // route-validation tests (which never touch SQL) and the cron-wiring
  // tests (which stub the reaper).
  await suite.test(
    "happy: PUT(expires_at=NOW+1s) → wait → runToolHealthCheck → GET reflects auto-revert + audit",
    async () => {
      const original = process.env.ADMIN_API_KEY;
      process.env.ADMIN_API_KEY = ADMIN_KEY;
      // Type-only imports keep the stubs below strictly typed without
      // forcing the production modules to load until the test actually
      // runs (see the dynamic imports a few lines down).
      type AIAlertT = import("../src/utils/aiAlertsDatabase").AIAlert;
      type AlertTypeT = import("../src/utils/aiAlertsDatabase").AlertType;
      type ToolWindowAggregateT =
        import("../src/utils/aiTelemetry").ToolWindowAggregate;
      type NotifyToolHealthBreachResultT =
        import("../src/utils/toolHealthAlertNotifier").NotifyToolHealthBreachResult;
      // Narrow shape of the audit rows surfaced in the GET response —
      // mirrors ToolHealthConfigAuditEntry but loosened to allow the
      // synthetic `_expires_at` key the reaper writes into before_values.
      interface AuditRowShape {
        changed_by: string;
        note: string | null;
        before_values: Record<string, unknown>;
        after_values: Record<string, unknown>;
      }
      try {
        const { runToolHealthCheck } = await import(
          "../src/mastra/workflows/toolHealthAlertsCron"
        );
        const { SYSTEM_REAPER_ATTRIBUTION } = await import(
          "../src/utils/toolHealthConfigDatabase"
        );

        const getHandler = await buildHandler(
          aiOpsRoutes,
          "/api/ai-ops/tool-health-config",
          "GET",
        );
        const putHandler = await buildHandler(
          aiOpsRoutes,
          "/api/ai-ops/tool-health-config",
          "PUT",
        );

        // 1. Snapshot the env baseline so we can assert the post-revert
        //    effective config matches it field-for-field.
        const initial = await getHandler(
          makeContext({ method: "GET", headers: { "X-Admin-Key": ADMIN_KEY } }),
        );
        suite.expectEqual(initial.status, 200, "initial GET status");
        const envBaseline = initial.body?.data?.env_baseline;
        suite.expect(
          envBaseline && typeof envBaseline === "object",
          "env_baseline present",
        );

        // 2. PUT an override with a near-future expires_at. The validator
        //    rejects past timestamps, so we go ~1.2s out — comfortably
        //    above the wall-clock jitter and still short enough to keep
        //    CI fast.
        const expiresAtMs = Date.now() + 1_200;
        const expiresAtIso = new Date(expiresAtMs).toISOString();
        const putRes = await putHandler(
          makeContext({
            method: "PUT",
            headers: { "X-Admin-Key": ADMIN_KEY },
            body: {
              overrides: {
                errorRatePct: 7,
                errorRateHighPct: 21,
                errorRateCriticalPct: 77,
              },
              expires_at: expiresAtIso,
              note: "task #214 auto-revert e2e",
            },
          }),
        );
        suite.expectEqual(putRes.status, 200, "PUT status");
        suite.expectEqual(
          putRes.body?.effective?.errorRateHighPct,
          21,
          "effective reflects override pre-reap",
        );
        suite.expect(
          putRes.body?.after_expires_at != null,
          "after_expires_at set on the write response",
        );

        // 3. Confirm the GET picks up the override + expires_at while we
        //    are still inside the validity window. This catches a regression
        //    where the read path mis-treats a future expiry as already
        //    expired (defense-in-depth filter inverted).
        const midGet = await getHandler(
          makeContext({ method: "GET", headers: { "X-Admin-Key": ADMIN_KEY } }),
        );
        suite.expectEqual(midGet.status, 200, "mid GET status");
        suite.expectEqual(
          midGet.body?.data?.overrides?.errorRateHighPct,
          21,
          "override visible before expiry",
        );
        suite.expect(
          midGet.body?.data?.expires_at != null,
          "expires_at exposed before expiry",
        );

        // 4. Sleep just past the expiry. We add a generous buffer so the
        //    cron's `expires_at <= NOW()` check fires deterministically
        //    even on a slow CI box.
        const remaining = expiresAtMs - Date.now();
        const wait = Math.max(0, remaining) + 800;
        await new Promise((r) => setTimeout(r, wait));

        // 5. Drive a single cron pass with the REAL reaper but stubbed
        //    breach plumbing — we don't want this test to spawn alerts
        //    or pages just because the live DB happens to have noisy
        //    metrics rows. The reaper itself uses the default DB-backed
        //    implementation, so any SQL regression in
        //    `reapExpiredToolHealthOverrides` will surface here.
        const stubAggregates: (
          windowMinutes: number,
          minCalls: number,
        ) => Promise<ToolWindowAggregateT[]> = async () => [];
        const stubOpenAlertExists: (
          alertType: AlertTypeT,
          relatedRecordId: string,
        ) => Promise<boolean> = async () => false;
        // Aggregates is empty above, so the breach loop never runs and
        // these stubs never actually fire. We still give them strictly
        // typed signatures (no `as any`) so a future deps-shape change
        // is caught at compile time instead of in a flaky test pass.
        const stubCreateAlert = async (
          _alert: Omit<AIAlertT, "id" | "created_at" | "status">,
        ): Promise<AIAlertT> => {
          throw new Error(
            "stubCreateAlert: should not run — aggregates were empty",
          );
        };
        const stubGetOpenAlertsByKey: (
          alertType: AlertTypeT,
          relatedRecordId: string,
          options?: { olderThanMinutes?: number },
        ) => Promise<AIAlertT[]> = async () => [];
        const stubResolveAlert: (
          id: number,
          note?: string,
        ) => Promise<AIAlertT | null> = async () => null;
        const stubNotify: () => Promise<NotifyToolHealthBreachResultT> = async () => ({
          slackSent: false,
          emailSent: false,
          throttled: false,
          skipped: true,
        });
        const checkResult = await runToolHealthCheck({
          getToolWindowAggregates: stubAggregates,
          openAlertExistsByKey: stubOpenAlertExists,
          createAIAlert: stubCreateAlert,
          getOpenAlertsByKey: stubGetOpenAlertsByKey,
          resolveAlert: stubResolveAlert,
          notifyToolHealthBreach: stubNotify,
        });
        // Use `>= 1` instead of `=== 1` so a noisy shared CI DB that
        // happened to have another expired override at tick time can't
        // false-fail us — the targeted audit-row match below pins this
        // assertion to *our* seeded override either way.
        suite.expect(
          checkResult.expiredOverridesReaped >= 1,
          `cron pass reported at least one expired override reaped (got ${checkResult.expiredOverridesReaped})`,
        );

        // 6. Re-GET and assert the override + expires_at have been wiped
        //    and the effective config matches the env baseline exactly.
        const postGet = await getHandler(
          makeContext({ method: "GET", headers: { "X-Admin-Key": ADMIN_KEY } }),
        );
        suite.expectEqual(postGet.status, 200, "post GET status");
        const postOverrides = postGet.body?.data?.overrides ?? {};
        suite.expectEqual(
          Object.keys(postOverrides).length,
          0,
          "all override fields cleared after auto-revert",
        );
        suite.expect(
          postGet.body?.data?.expires_at == null,
          "expires_at cleared after auto-revert",
        );
        suite.expectEqual(
          postGet.body?.data?.expired,
          false,
          "derived expired flag false once row is reaped",
        );
        const postEffective = postGet.body?.data?.effective ?? {};
        for (const field of Object.keys(envBaseline)) {
          suite.expectEqual(
            postEffective[field],
            envBaseline[field],
            `effective.${field} reverted to env baseline`,
          );
        }
        suite.expectEqual(
          postGet.body?.data?.updated_by,
          SYSTEM_REAPER_ATTRIBUTION,
          "updated_by attributed to the system reaper",
        );

        // 7. Audit row: must be a fresh entry written by the reaper with
        //    the canonical attribution string and a note that flags the
        //    auto-clear. We look up by attribution + note instead of
        //    assuming index 0 so a noisier shared CI database (where
        //    parallel suites might write between our PUT and our GET)
        //    can't false-fail this assertion.
        const audit = postGet.body?.data?.audit;
        suite.expect(
          Array.isArray(audit) && audit.length > 0,
          "audit log non-empty after reap",
        );
        const auditRows: AuditRowShape[] = Array.isArray(audit) ? audit : [];
        const reapEntry = auditRows.find(
          (row) =>
            row?.changed_by === SYSTEM_REAPER_ATTRIBUTION
            && typeof row?.note === "string"
            && row.note.includes("Auto-cleared")
            && row.note.includes("expires_at")
            // Pin to OUR seeded override so we don't latch onto an
            // unrelated reaper row from earlier in the run.
            && row?.before_values?.errorRateHighPct === 21,
        );
        suite.expect(
          !!reapEntry,
          "found a reaper audit row matching our seeded override",
        );
        suite.expect(
          reapEntry?.before_values?._expires_at != null,
          "audit before_values records the expiry that triggered the reap",
        );
        suite.expect(
          reapEntry?.after_values
            && Object.keys(reapEntry.after_values).length === 0,
          "audit after_values is the empty post-clear snapshot",
        );
      } finally {
        // Defensive cleanup: if any assertion above failed mid-flight, the
        // override row could still be set. Force-clear every field so the
        // live DB is left exactly as we found it (matches the existing
        // happy-path test's cleanup contract).
        try {
          const cleanupHandler = await buildHandler(
            aiOpsRoutes,
            "/api/ai-ops/tool-health-config",
            "PUT",
          );
          await cleanupHandler(
            makeContext({
              method: "PUT",
              headers: { "X-Admin-Key": ADMIN_KEY },
              body: {
                overrides: {
                  windowMinutes: null,
                  minCalls: null,
                  errorRatePct: null,
                  errorRateHighPct: null,
                  errorRateCriticalPct: null,
                  p95LatencyMs: null,
                  latencyHighMs: null,
                  latencyCriticalMs: null,
                },
                expires_at: null,
                note: "task #214 auto-revert e2e cleanup",
              },
            }),
          );
        } catch {
          /* best-effort cleanup */
        }
        if (original === undefined) delete process.env.ADMIN_API_KEY;
        else process.env.ADMIN_API_KEY = original;
      }
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Task #215: verify recovery auto-resolve works end-to-end against real Postgres.
//
// Seeds a `tool_health` alert via `createAIAlert`, backdates `created_at`
// so it passes the `olderThanMinutes` cooldown filter inside
// `getOpenAlertsByKey`, then drives one `runToolHealthCheck` pass with REAL
// `getOpenAlertsByKey` and `resolveAlert` and a stubbed aggregator that
// reports the tool back under threshold. Asserts the alert row flips to
// `resolved` with the expected auto-resolve note.
//
// Without this check, an off-by-one in the cooldown SQL (e.g. `<` vs `<=`)
// or a `resolveAlert` that silently no-ops on acknowledged rows would slip
// past unit tests that stub all DB calls.
// ─────────────────────────────────────────────────────────────────────────────
if (HAS_DB) {
  await suite.test(
    "happy: recovery auto-resolve flips tool_health alert to resolved against real Postgres",
    async () => {
      type AIAlertT = import("../src/utils/aiAlertsDatabase").AIAlert;
      type AlertTypeT = import("../src/utils/aiAlertsDatabase").AlertType;
      type ToolWindowAggregateT =
        import("../src/utils/aiTelemetry").ToolWindowAggregate;
      type NotifyToolHealthBreachResultT =
        import("../src/utils/toolHealthAlertNotifier").NotifyToolHealthBreachResult;
      type NotifyToolHealthRecoveryResultT =
        import("../src/utils/toolHealthAlertNotifier").NotifyToolHealthRecoveryResult;
      type ToolHealthConfigOverridesT =
        import("../src/utils/toolHealthConfigDatabase").ToolHealthConfigOverrides;
      type ReapResultT =
        import("../src/utils/toolHealthConfigDatabase").ReapExpiredToolHealthOverridesResult;

      const RECOVERY_TOOL = `test_recovery_${Date.now()}`;
      const RECOVERY_REASON = "error_rate" as const;
      const RECOVERY_KEY = `${RECOVERY_TOOL}:${RECOVERY_REASON}`;
      let seededId: number | null = null;

      try {
        const {
          createAIAlert: realCreateAlert,
          resolveAlert: realResolveAlert,
          getOpenAlertsByKey: realGetOpenAlertsByKey,
        } = await import("../src/utils/aiAlertsDatabase");
        const { sharedPool } = await import("../src/utils/sharedPool");
        const { runToolHealthCheck, TOOL_HEALTH_ENV_BASELINE } = await import(
          "../src/mastra/workflows/toolHealthAlertsCron"
        );

        // 1. Seed an open tool_health alert for the test tool.
        const seeded = await realCreateAlert({
          alert_type: "tool_health",
          severity: "medium",
          title: `Tool "${RECOVERY_TOOL}" error rate above threshold over last 60 min`,
          description: "Seeded by Task #215 recovery e2e test",
          suggestion: "N/A — test alert",
          related_module: "ai_ops",
          related_record_id: RECOVERY_KEY,
        });
        seededId = seeded.id!;

        // 2. Backdate created_at to 2 hours ago so the olderThanMinutes=60
        //    cooldown filter (NOW() - MAKE_INTERVAL(mins => windowMinutes))
        //    is satisfied even on the default 60-minute window.
        await sharedPool.query(
          `UPDATE ai_alerts SET created_at = NOW() - INTERVAL '2 hours' WHERE id = $1`,
          [seededId],
        );

        // 3. Drive one cron pass with:
        //    • REAL getOpenAlertsByKey + resolveAlert (the SQL under test)
        //    • Stubbed aggregator returning the tool BELOW both thresholds
        //      so the run lands in the recovery sweep, not the breach path
        //    • Everything else no-op'd to prevent side effects
        const MIN_CALLS = TOOL_HEALTH_ENV_BASELINE.minCalls;

        const stubAggregates = async (
          _windowMinutes: number,
          _minCalls: number,
        ): Promise<ToolWindowAggregateT[]> => [
          {
            tool_name: RECOVERY_TOOL,
            agent_name: null,
            call_count: MIN_CALLS,
            error_count: 0,
            error_rate_pct: 0,
            p95_latency_ms: 100,
            avg_latency_ms: 80,
            max_latency_ms: 120,
          },
        ];

        const stubOpenAlertExists = async (
          _alertType: AlertTypeT,
          _relatedRecordId: string,
        ): Promise<boolean> => false;

        const stubCreateAlert = async (
          _alert: Omit<AIAlertT, "id" | "created_at" | "status">,
        ): Promise<AIAlertT> => {
          throw new Error(
            "stubCreateAlert should not run — tool metrics are under threshold",
          );
        };

        const stubNotifyBreach = async (): Promise<NotifyToolHealthBreachResultT> => ({
          slackSent: false,
          emailSent: false,
          throttled: false,
          skipped: true,
        });

        let recoveryNotifyCalled = false;
        const stubNotifyRecovery = async (
          _payload: Parameters<typeof import("../src/utils/toolHealthAlertNotifier").notifyToolHealthRecovery>[0],
        ): Promise<NotifyToolHealthRecoveryResultT> => {
          recoveryNotifyCalled = true;
          return { slackSent: false, emailSent: false, skipped: true };
        };

        const stubReapOverrides = async (): Promise<ReapResultT> => ({
          reaped: false,
          cleared_overrides: {} as ToolHealthConfigOverridesT,
          previous_updated_by: null,
          expired_at: null,
          audit_id: null,
        });

        const stubNotifyOverrideExpired = async (): Promise<void> => {};

        const checkResult = await runToolHealthCheck({
          getToolWindowAggregates: stubAggregates,
          openAlertExistsByKey: stubOpenAlertExists,
          createAIAlert: stubCreateAlert,
          getOpenAlertsByKey: realGetOpenAlertsByKey,
          resolveAlert: realResolveAlert,
          notifyToolHealthBreach: stubNotifyBreach,
          notifyToolHealthRecovery: stubNotifyRecovery,
          reapExpiredOverrides: stubReapOverrides,
          notifyOverrideExpired: stubNotifyOverrideExpired,
        });

        // 4. Assert the cron reported at least one auto-resolved alert.
        suite.expect(
          checkResult.alertsAutoResolved >= 1,
          `cron reported at least 1 auto-resolved (got ${checkResult.alertsAutoResolved})`,
        );

        // 5. Assert the recovery notifier was called.
        suite.expect(
          recoveryNotifyCalled,
          "recovery notifier was called after auto-resolve",
        );

        // 6. Read the row back directly from Postgres and verify the status
        //    and resolution_note — the primary assertions of this task.
        const row = await sharedPool.query<{
          id: number;
          status: string;
          resolution_note: string | null;
          resolved_at: Date | null;
        }>(
          `SELECT id, status, resolution_note, resolved_at FROM ai_alerts WHERE id = $1`,
          [seededId],
        );
        suite.expect(row.rows.length === 1, "alert row still present in DB");
        const alertRow = row.rows[0];
        suite.expectEqual(alertRow.status, "resolved", "status flipped to resolved");
        suite.expect(
          typeof alertRow.resolution_note === "string" &&
            alertRow.resolution_note.includes("auto-resolved"),
          `resolution_note contains 'auto-resolved' (got: ${alertRow.resolution_note})`,
        );
        suite.expect(
          alertRow.resolved_at != null,
          "resolved_at is stamped",
        );
      } finally {
        // Cleanup: remove the seeded row so no orphan alert remains.
        if (seededId != null) {
          try {
            const { sharedPool } = await import("../src/utils/sharedPool");
            await sharedPool.query(`DELETE FROM ai_alerts WHERE id = $1`, [seededId]);
          } catch {
            /* best-effort */
          }
        }
      }
    },
  );
}

suite.finishOrExit();
